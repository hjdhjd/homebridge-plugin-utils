/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/record.ts: FFmpeg process control for fMP4 recording and livestreaming, composing Mp4SegmentAssembler for the shared pipeline.
 */

/**
 * fMP4 FFmpeg processes for HomeKit Secure Video (HKSV) events and livestreaming.
 *
 * This module defines an abstract base {@link FfmpegFMp4Process} and its concrete fMP4-mode specializations,
 * {@link FfmpegRecordingProcess} for HKSV event recording (stdin pipe input, transcoded output) and
 * {@link FfmpegLivestreamProcess} for fMP4 livestreaming (RTSP input, codec copy). The base exists **solely to centralize
 * composition wiring** - it owns the internal {@link Mp4SegmentAssembler}, delegates `getInitSegment` / `segments` to it,
 * and propagates assembler teardown reasons up to the process. It contains no pipeline logic and no command-line assembly;
 * the byte-to-segment pipeline lives in the assembler so this base stays composition-only.
 *
 * Both concrete subclasses:
 *
 * - Spawn FFmpeg on construction and expose the inherited `signal`, `ready`, `exited`, `stdin`, `stderr`, `stderrLog`,
 *   `abort()`, and `[Symbol.asyncDispose]`.
 * - Narrow the inherited public `stdout` to `never`, because the assembler owns the stream and a concurrent external reader
 *   would race.
 * - Build their FFmpeg arg vector via the pure helper `buildFMp4CommandLine`, which takes fully-resolved options plus
 *   mode-specific hook values and returns the vector. Neither subclass calls `super()` until the arg vector is finalized,
 *   so the constructor-before-super contract is respected.
 *
 * The command-line hook values that differ per mode:
 *
 * | Hook                     | Recording                                  | Livestream                              |
 * |--------------------------|--------------------------------------------|-----------------------------------------|
 * | `inputArgs`              | `-i pipe:0` + probesize + `-ss`            | `-i <url>` + `-rtsp_transport tcp`      |
 * | `separateAudioInputArgs` | `[]`                                       | Separate audio URL when configured      |
 * | `audioInputIndex`        | `0`                                        | `0` or `1` (if separate audio)          |
 * | `audioTarget`            | `recordingConfig.audioCodec` (transcoding) | `init.audio` when provided              |
 * | `videoEncoderArgs`       | `options.recordEncoder(...)`               | `-codec:v copy`                         |
 * | `postFilterArgs`         | `[]`                                       | `-frag_duration <segmentLength * 1000>` |
 * | `metadataLabel`          | `"HKSV Event"`                             | `"Livestream Buffer"`                   |
 *
 * The shared pipeline primitive ({@link Mp4SegmentAssembler}) also means this module avoids template-method coupling between
 * the base and the concrete subclasses: no abstract hook methods, no mode-specific state on the base. The base is pure lifecycle
 * composition; the subclasses are pure args builders plus (for recording) a known-error message substitution.
 *
 * @module
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate } from "./hap-enums.ts";
import { HKSV_IDR_INTERVAL, HKSV_TIMEOUT } from "./settings.ts";
import type { HbpuAbortError, PartialWithId } from "../util.ts";
import { isHbpuAbortReason, onAbort } from "../util.ts";
import type { CameraRecordingConfiguration } from "homebridge";
import type { FfmpegOptions } from "./options.ts";
import { FfmpegProcess } from "./process.ts";
import type { FfmpegProcessInit } from "./process.ts";
import { Mp4SegmentAssembler } from "./mp4-assembler.ts";
import type { Writable } from "node:stream";

// Translation tables for the hap-nodejs enum values that shape the FFmpeg audio encoder args. `as const satisfies` pins the map shape to exhaustively cover every enum
// member at compile time - a new enum value added upstream would require updating the maps or the build breaks.
const translateAudioRecordingCodecType = {

  [ AudioRecordingCodecType.AAC_ELD ]:   "38",
  [ AudioRecordingCodecType.AAC_LC ]:    "1"
} as const satisfies Record<AudioRecordingCodecType, string>;

const translateAudioSampleRate = {

  [ AudioRecordingSamplerate.KHZ_8 ]:    "8",
  [ AudioRecordingSamplerate.KHZ_16 ]:   "16",
  [ AudioRecordingSamplerate.KHZ_24 ]:   "24",
  [ AudioRecordingSamplerate.KHZ_32 ]:   "32",
  [ AudioRecordingSamplerate.KHZ_44_1 ]: "44.1",
  [ AudioRecordingSamplerate.KHZ_48 ]:   "48"
} as const satisfies Record<AudioRecordingSamplerate, string>;

// Known HKSV-related errors due to occasional inconsistencies produced by the input stream and FFmpeg's own occasional quirkiness. Compiled once at module scope rather
// than on every teardown event.
const FFMPEG_KNOWN_HKSV_ERROR = new RegExp([

  "(Cannot determine format of input stream 0:0 after EOF)",
  "(Could not write header \\(incorrect codec parameters \\?\\): Broken pipe)",
  "(Could not write header for output file #0)",
  "(Error closing file: Broken pipe)",
  "(Error splitting the input into NAL units\\.)",
  "(Invalid data found when processing input)",
  "(moov atom not found)"
].join("|"));

// URL prefixes whose presence in a separate-audio-input URL means we should explicitly request TCP transport, matching the behavior of the primary video input for RTSP
// sources. Module-scope constant - shape never changes, allocated once.
const RTSP_TRANSPORT_PATTERNS = [ "rtsp://", "rtsps://" ];

/**
 * Base options shared by both fMP4 recording and livestream sessions.
 *
 * @property audioFilters        - Audio filters for FFmpeg to process. These are passed as an array of filters. Recording-only: the livestream builder ignores this
 *                                 field, driving its audio-filter decision from the `audio` target instead.
 * @property audioStream         - Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream).
 * @property codec               - The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc` (`h265` is accepted as an alias for `hevc`).
 *                                 Defaults to `h264`.
 * @property enableAudio         - Indicates whether to enable audio or not.
 * @property hardwareDecoding    - Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions` when FFmpeg is at least
 *                                 8.x; on an older FFmpeg the default is always `false` regardless of what `ffmpegOptions` specifies.
 * @property hardwareTranscoding - Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`.
 * @property transcodeAudio      - Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. Recording-only: the
 *                                 livestream builder ignores this field, driving its transcode decision from the `audio` target instead.
 * @property videoFilters        - Video filters for FFmpeg to process. These are passed as an array of filters.
 * @property videoStream         - Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream).
 *
 * @category FFmpeg
 */
export interface FMp4BaseOptions {

  audioFilters: string[];
  audioStream: number;
  codec: string;
  enableAudio: boolean;
  hardwareDecoding: boolean;
  hardwareTranscoding: boolean;
  transcodeAudio: boolean;
  videoFilters: string[];
  videoStream: number;
}

/**
 * Configuration for a separate audio input source in an fMP4 livestream session. This interface describes the audio source when video and audio come from different
 * endpoints, such as cameras like DoorBird that expose audio through a separate HTTP API.
 *
 * When the audio source is a raw stream (not a self-describing container), specify `format`, `sampleRate`, and optionally `channels` so FFmpeg knows how to interpret
 * the input. For self-describing sources like RTSP or container-based HTTP streams, only `url` is required.
 *
 * @property channels    - Optional. Number of audio channels. Defaults to `1`.
 * @property format      - Optional. Raw audio format for the input stream. When set, FFmpeg is told to expect this format rather than probing the stream. Valid values
 *                         are `alaw` (G.711 A-law), `mulaw` (G.711 mu-law), and `s16le` (16-bit signed little-endian PCM). Omit for self-describing sources.
 * @property sampleRate  - Optional. Audio sample rate in Hz (e.g., `8000`). Used when `format` is set. Defaults to `8000`.
 * @property url         - The URL of the audio input source.
 *
 * @see FMp4LivestreamOptions
 *
 * @category FFmpeg
 */
export interface FMp4AudioInputConfig {

  channels?: number;
  format?: "alaw" | "mulaw" | "s16le";
  sampleRate?: number;
  url: string;
}

/**
 * The resolved audio-encode target for fMP4 production. Its presence on an fMP4 command line is the single signal to transcode the audio stream to this target; its
 * absence means the already-encoded audio is copied through untouched. Any audio filters are carried inside the target because filtering requires transcoding - a filter
 * without a transcode is unrepresentable by construction, so the filters-require-transcoding rule holds declaratively rather than through a runtime override.
 *
 * @property channels    - Optional. Number of output audio channels. Defaults to `1` when omitted.
 * @property codec       - The AAC codec variant to encode to (low-complexity or enhanced low-delay).
 * @property filters     - Optional. Audio filters applied ahead of the encoder. Supplying filters is what makes the transcode carry them; an empty or omitted list
 *                         transcodes without filtering.
 * @property samplerate  - The output audio sample rate.
 *
 * @category FFmpeg
 */
export interface FMp4AudioTarget {

  channels?: number;
  codec: AudioRecordingCodecType;
  filters?: string[];
  samplerate: AudioRecordingSamplerate;
}

/**
 * Options for configuring an fMP4 HKSV recording session.
 *
 * @property fps             - The video frames per second for the session. Defaults to 30.
 * @property probesize       - Number of bytes to analyze for stream information. Defaults to 5,000,000 bytes (mirrors FFmpeg's own default probesize).
 * @property timeshift       - Timeshift offset for event-based recording (in milliseconds). Defaults to 0.
 *
 * @category FFmpeg
 */
export interface FMp4RecordingOptions extends FMp4BaseOptions {

  fps: number;
  probesize: number;
  timeshift: number;
}

/**
 * Options for configuring an fMP4 livestream session.
 *
 * @property audioInput  - Optional. A separate audio input source. When provided, audio is read from this source instead of the primary `url`. Can be a URL string
 *                         for self-describing sources (e.g., RTSP), or an `FMp4AudioInputConfig` object for raw audio streams that require format metadata.
 * @property url         - Source URL for livestream (RTSP) remuxing to fMP4.
 *
 * @see FMp4AudioInputConfig
 *
 * @category FFmpeg
 */
export interface FMp4LivestreamOptions extends FMp4BaseOptions {

  audioInput?: FMp4AudioInputConfig | string;
  url: string;
}

/**
 * Construction-time options for {@link FfmpegRecordingProcess}.
 *
 * @property recording          - Optional. fMP4 recording options. Every field defaults when omitted; the interface surface matches {@link FMp4RecordingOptions} but with
 *                                all fields optional.
 * @property recordingConfig    - The HomeKit recording configuration (resolution, codec profile, audio codec, sample rate, channels) produced by the HKSV delegate.
 * @property verbose            - Optional. When `true`, FFmpeg is invoked with verbose logging (`-loglevel level+verbose`) regardless of the global
 *                                `codecSupport.verbose` flag. Defaults to `false`.
 *
 * @remarks Supplying `args` (inherited from {@link FfmpegProcessInit}) is an advanced escape hatch that replaces the auto-built command line entirely. When `args` is
 * present, the mode-specific config fields (`recording`, `verbose`) do not participate in command-line assembly - they become no-ops. Typical callers omit `args` and
 * let the class build the command line from the recording configuration.
 *
 * @see FfmpegProcessInit
 * @see FMp4RecordingOptions
 *
 * @category FFmpeg
 */
export interface FfmpegRecordingInit extends FfmpegProcessInit {

  recording?: Partial<FMp4RecordingOptions>;
  recordingConfig: CameraRecordingConfiguration;
  verbose?: boolean;
}

/**
 * Construction-time options for {@link FfmpegLivestreamProcess}.
 *
 * @property audio              - Optional. The resolved audio-encode target. When provided, the audio stream is transcoded to it (with any filters it carries); when
 *                                omitted, the already-encoded audio is copied through untouched. This is the livestream path's sole audio-filter source.
 * @property livestream         - Livestream source configuration. `url` is required; other {@link FMp4BaseOptions} fields are optional and default when omitted.
 * @property segmentLength      - Optional. fMP4 fragment duration in milliseconds, applied to `-frag_duration` at construction time. Defaults to 1000 ms (1 second).
 * @property verbose            - Optional. When `true`, FFmpeg is invoked with verbose logging (`-loglevel level+verbose`) regardless of the global
 *                                `codecSupport.verbose` flag. Defaults to `false`.
 *
 * @remarks Supplying `args` (inherited from {@link FfmpegProcessInit}) is an advanced escape hatch that replaces the auto-built command line entirely. When `args` is
 * present, the mode-specific config fields (`audio`, `livestream`, `segmentLength`, `verbose`) do not participate in command-line assembly - they become no-ops. Typical
 * callers omit `args` and let the class build the command line from `livestream` + `audio`.
 *
 * @see FfmpegProcessInit
 * @see FMp4AudioTarget
 * @see FMp4LivestreamOptions
 *
 * @category FFmpeg
 */
export interface FfmpegLivestreamInit extends FfmpegProcessInit {

  audio?: FMp4AudioTarget;
  livestream: PartialWithId<FMp4LivestreamOptions, "url">;
  segmentLength?: number;
  verbose?: boolean;
}

// Resolved input for the shared command-line builder. Every field is final and fully defaulted before the builder is called, so the builder itself is a pure
// transformation from configuration to arg vector with no branching against "maybe this was provided" cases beyond what the caller already decided.
interface FMp4CommandLineInput {

  audioInputIndex: number;
  audioTarget?: FMp4AudioTarget;
  fMp4Options: Required<FMp4BaseOptions>;
  inputArgs: string[];
  metadataLabel: string;
  options: FfmpegOptions;
  postFilterArgs: string[];
  separateAudioInputArgs: string[];
  verbose: boolean;
  videoEncoderArgs: string[];
}

// Apply defaults to a partial base options object. Hardware decoding defaults vary with FFmpeg version (only the 8.x line supports it stably); hardware transcoding
// follows the caller's resolved config.
function resolveBaseOptions(options: FfmpegOptions, partial: Partial<FMp4BaseOptions>): Required<FMp4BaseOptions> {

  return {

    audioFilters: partial.audioFilters ?? [],
    audioStream: partial.audioStream ?? 0,
    codec: partial.codec ?? "h264",
    enableAudio: partial.enableAudio ?? true,
    hardwareDecoding: partial.hardwareDecoding ?? (options.config.codecSupport.ffmpegAtLeast(8) ? options.config.hardwareDecoding : false),
    hardwareTranscoding: partial.hardwareTranscoding ?? options.config.hardwareTranscoding,
    transcodeAudio: partial.transcodeAudio ?? true,
    videoFilters: partial.videoFilters ?? [],
    videoStream: partial.videoStream ?? 0
  };
}

// Assemble the FFmpeg command line for any fMP4 subclass. The builder consumes pre-resolved hook values supplied by the caller; subclass constructors resolve their
// hooks inline against their own init and FfmpegOptions, then invoke this function once to produce the final arg vector.
function buildFMp4CommandLine(input: FMp4CommandLineInput): string[] {

  const { audioInputIndex, audioTarget, fMp4Options, inputArgs, metadataLabel, options, postFilterArgs, separateAudioInputArgs, verbose, videoEncoderArgs } = input;

  // Configure our video parameters for our input:
  //
  // -hide_banner                  Suppress printing the startup banner in FFmpeg.
  // -nostats                      Suppress printing progress reports while encoding in FFmpeg.
  // -fflags flags                 Set the format flags to discard any corrupt packets rather than exit.
  // -err_detect ignore_err        Ignore decoding errors and continue rather than exit.
  // -max_delay 500000             Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
  const args: string[] = [

    "-hide_banner",
    "-nostats",
    "-fflags", "+discardcorrupt",
    "-err_detect", "ignore_err",
    ...options.videoDecoder(fMp4Options.codec),
    "-max_delay", "500000",

    // Mode-specific input arguments (RTSP input for livestream, stdin pipe for recording).
    ...inputArgs,

    // Mode-specific separate audio input arguments (livestream with a separate audio endpoint, empty for recording).
    ...separateAudioInputArgs,

    // Select the video track and apply mode-specific encoder arguments.
    "-map", "0:v:" + fMp4Options.videoStream.toString(),
    ...videoEncoderArgs
  ];

  // Configure our video filters, if we have them.
  if(fMp4Options.videoFilters.length) {

    args.push("-filter:v", fMp4Options.videoFilters.join(", "));
  }

  // Mode-specific post-filter arguments (frag_duration for livestream, empty for recording).
  args.push(...postFilterArgs);

  // -movflags flags               In the generated fMP4 stream: set the default-base-is-moof flag in the header, write an initial empty MOOV box, start a new fragment
  //                               at each keyframe, skip creating a segment index (SIDX) box in fragments, and skip writing the final MOOV trailer since it is unneeded.
  // -flush_packets 1              Ensure we flush our write buffer after each muxed packet.
  // -reset_timestamps             Reset timestamps at the beginning of each segment.
  // -metadata                     Set the metadata to the name of the camera to distinguish between FFmpeg sessions.
  args.push(

    "-movflags", "default_base_moof+empty_moov+frag_keyframe+skip_sidx+skip_trailer",
    "-flush_packets", "1",
    "-reset_timestamps", "1",
    "-metadata", "comment=" + options.name() + " " + metadataLabel
  );

  // Assemble the audio encoding block. This is shared between both modes - the only mode-specific piece is which FFmpeg input index carries the audio stream.
  if(fMp4Options.enableAudio) {

    // Configure the audio portion of the command line:
    //
    // -map N:a:X?                 Selects the audio stream from input N, if it exists. The input index is 0 when audio and video share the same input, or 1 when a
    //                             separate audio input has been configured.
    args.push("-map", audioInputIndex.toString() + ":a:" + fMp4Options.audioStream.toString() + "?");

    // A resolved audio target is the single signal to transcode: its presence means we encode to it, its absence means we copy the already-encoded audio through
    // untouched. The target carries its own filters, so filtering-without-transcoding is unrepresentable here by construction rather than enforced by a runtime override.
    if(audioTarget) {

      // Audio filters ride inside the transcode request. When the target supplies them, we apply them ahead of the encoder.
      if(audioTarget.filters?.length) {

        args.push("-filter:a", audioTarget.filters.join(", "));
      }

      // Configure the audio portion of the command line:
      //
      // -codec:a                    Encode using the codecs available to us on given platforms.
      // -profile:a                  Specify either low-complexity AAC or enhanced low-delay AAC per the resolved audio target's codec.
      // -ar samplerate              Sample rate to use for this audio, per the resolved audio target.
      // -ac number                  Set the number of audio channels.
      args.push(

        ...options.audioEncoder({ codec: audioTarget.codec }),
        "-profile:a", translateAudioRecordingCodecType[audioTarget.codec],
        "-ar", translateAudioSampleRate[audioTarget.samplerate] + "k",
        "-ac", (audioTarget.channels ?? 1).toString()
      );
    } else {

      // -codec:a copy               Copy the audio stream through untouched when no transcode target is supplied.
      args.push("-codec:a", "copy");
    }
  }

  // Configure our video parameters for outputting our final stream:
  //
  // -f mp4                        Tell ffmpeg that it should create an MP4-encoded output stream.
  // pipe:1                        Output the stream to standard output.
  args.push(

    "-f", "mp4",
    "pipe:1"
  );

  // Additional logging, but only if we're debugging.
  if(verbose || options.config.codecSupport.verbose) {

    args.unshift("-loglevel", "level+verbose");
  }

  return args;
}

// Build the separate-audio-input arg segment for livestream sessions and report whether a separate input was actually configured. Returns both results together as a
// named pair because the input index in the subsequent audio mapping step depends on whether a separate input exists - the two results must stay consistent.
function buildLivestreamAudioInputArgs(livestream: PartialWithId<FMp4LivestreamOptions, "url">, enableAudio: boolean): { args: string[]; hasSeparateInput: boolean } {

  if(!enableAudio || !livestream.audioInput) {

    return { args: [], hasSeparateInput: false };
  }

  const args: string[] = [];

  // Normalize the audio input configuration. A plain string is treated as a URL shorthand.
  const audioInput: FMp4AudioInputConfig = (typeof livestream.audioInput === "string") ? { url: livestream.audioInput } : livestream.audioInput;

  // When a raw audio format is specified, we need to explicitly tell FFmpeg how to interpret the incoming stream since it cannot probe raw audio sources.
  //
  // -f format                       Specify the raw audio format (e.g., mulaw, alaw, s16le).
  // -ar sampleRate                  Specify the audio sample rate in Hz.
  // -ac channels                    Specify the number of audio channels.
  if(audioInput.format) {

    args.push(

      "-f", audioInput.format,
      "-ar", (audioInput.sampleRate ?? 8000).toString(),
      "-ac", (audioInput.channels ?? 1).toString()
    );
  }

  // For RTSP and RTSPS audio sources, we explicitly request TCP transport to match the behavior we use for the primary video input.
  if(RTSP_TRANSPORT_PATTERNS.some((protocol) => audioInput.url.toLowerCase().startsWith(protocol))) {

    args.push("-rtsp_transport", "tcp");
  }

  // -i url                          Audio input URL.
  args.push("-i", audioInput.url);

  return { args, hasSeparateInput: true };
}

// Compose the command line for a recording session. Extracted so the subclass constructor can compute its full arg vector ahead of the super() call.
function buildRecordingCommandLine(options: FfmpegOptions, init: FfmpegRecordingInit): string[] {

  const recording = init.recording ?? {};
  const fMp4Options = resolveBaseOptions(options, recording);
  const { recordingConfig } = init;
  const fps = recording.fps ?? 30;

  // Recording transcodes audio to the HKSV-selected codec whenever transcoding is requested or an audio filter forces it; otherwise the already-encoded audio is copied
  // through untouched. The filters ride inside the target, so the filters-require-transcoding rule is expressed by the target's presence rather than a runtime override.
  const audioTarget: FMp4AudioTarget | undefined = (fMp4Options.transcodeAudio || (fMp4Options.audioFilters.length > 0)) ? {

    channels: recordingConfig.audioCodec.audioChannels,
    codec: recordingConfig.audioCodec.type,
    filters: fMp4Options.audioFilters,
    // homebridge types `audioCodec.samplerate` more loosely than our local enum, but HKSV only ever supplies a valid `AudioRecordingSamplerate` member, so the `as`
    // narrows a known-good value into the exhaustive translation table.
    samplerate: recordingConfig.audioCodec.samplerate as AudioRecordingSamplerate
  } : undefined;

  // The default mirrors FFmpeg's own default probesize and is sufficient to discover the fMP4 stream's parameters before decoding begins.
  const probesize = recording.probesize ?? 5_000_000;
  const timeshift = recording.timeshift ?? 0;

  // Recording input: read fMP4 data from standard input with low-delay optimizations and an optional timeshift for HKSV event alignment.
  //
  // -flags low_delay              Tell FFmpeg to optimize for low delay / realtime decoding.
  // -probesize number             How many bytes should be analyzed for stream information.
  // -f mp4                        Tell FFmpeg that it should expect an MP4-encoded input stream.
  // -i pipe:0                     Use standard input to get video data.
  // -ss                           Fast-forward to where HKSV is expecting us to be for a recording event.
  const inputArgs: string[] = [

    "-flags", "low_delay",
    "-probesize", probesize.toString(),
    "-f", "mp4",
    "-i", "pipe:0",
    "-ss", timeshift.toString() + "ms"
  ];

  // Recordings transcode video using the platform-appropriate encoder for HKSV.
  const videoEncoderArgs = options.recordEncoder({

    bitrate: recordingConfig.videoCodec.parameters.bitRate,
    fps: recordingConfig.videoCodec.resolution[2],
    hardwareDecoding: fMp4Options.hardwareDecoding,
    hardwareTranscoding: fMp4Options.hardwareTranscoding,
    height: recordingConfig.videoCodec.resolution[1],
    idrInterval: HKSV_IDR_INTERVAL,
    inputFps: fps,
    level: recordingConfig.videoCodec.parameters.level,
    profile: recordingConfig.videoCodec.parameters.profile,
    width: recordingConfig.videoCodec.resolution[0]
  });

  return buildFMp4CommandLine({

    audioInputIndex: 0,
    audioTarget,
    fMp4Options,
    inputArgs,
    metadataLabel: "HKSV Event",
    options,
    postFilterArgs: [],
    separateAudioInputArgs: [],
    verbose: init.verbose ?? false,
    videoEncoderArgs
  });
}

// Compose the command line for a livestream session. Extracted so the subclass constructor can compute its full arg vector ahead of the super() call.
function buildLivestreamCommandLine(options: FfmpegOptions, init: FfmpegLivestreamInit): string[] {

  const fMp4Options = resolveBaseOptions(options, init.livestream);
  const { audio, livestream } = init;

  // Livestream input: connect to an RTSP source with direct I/O and TCP transport.
  //
  // -avioflags direct           Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
  // -rtsp_transport tcp         Tell the RTSP stream handler that we're looking for a TCP connection.
  // -i url                      RTSPS URL to get our input stream from.
  const inputArgs: string[] = [

    "-avioflags", "direct",
    "-rtsp_transport", "tcp",
    "-i", livestream.url
  ];

  // If a separate audio input has been configured, build the FFmpeg input arguments for it. The returned `hasSeparateInput` flag drives the subsequent audio-mapping
  // step so the primary/secondary input index selection stays consistent with the configured inputs.
  const separateAudio = buildLivestreamAudioInputArgs(livestream, fMp4Options.enableAudio);

  // Livestreams remux the video stream directly without transcoding.
  const videoEncoderArgs = [ "-codec:v", "copy" ];

  // Livestreams emit fMP4 fragments at the configured cadence. `segmentLength` is expressed in milliseconds; FFmpeg wants microseconds. Default to one second when the
  // caller does not specify an override, since one-second fragments match HomeKit's expected fMP4 fragment cadence for livestreaming consumers.
  const segmentLengthMs = init.segmentLength ?? 1000;
  const postFilterArgs = [ "-frag_duration", (segmentLengthMs * 1000).toString() ];

  return buildFMp4CommandLine({

    audioInputIndex: separateAudio.hasSeparateInput ? 1 : 0,
    audioTarget: audio,
    fMp4Options,
    inputArgs,
    metadataLabel: "Livestream Buffer",
    options,
    postFilterArgs,
    separateAudioInputArgs: separateAudio.args,
    verbose: init.verbose ?? false,
    videoEncoderArgs
  });
}

// Propagate assembler aborts up to the process when the assembler ends its life for a reason the process's own exit handler cannot recover. The assembler dispatches
// on a two-way branch: the named reason `"closed"` (source ended naturally) defers to the process's own exit path, while every other reason - `"timeout"`
// (inter-segment watchdog), `"failed"` (source stream error), or any reason supplied to an external `abort()` call - propagates so the FFmpeg child is actively torn
// down via the process's kill path. `"closed"` must NOT propagate because the child's own `"exit"` event follows shortly and the base class computes the correct
// reason from the actual exit code - propagating `"closed"` here would race with and pre-empt that, converting a nonzero-exit `"failed"` into a `"closed"` and losing
// the error signal. `onAbort` provides one-shot semantics AND covers the pre-aborted-signal edge case where a parent-aborted assembler would otherwise miss the bridge
// entirely.
function bridgeAssemblerToProcess(process: FfmpegProcess, assembler: Mp4SegmentAssembler): void {

  onAbort(assembler.signal, () => {

    if(process.aborted) {

      return;
    }

    const reason: unknown = assembler.signal.reason;

    // Natural source-end defers to the process's own exit path.
    if(isHbpuAbortReason(reason, "closed")) {

      return;
    }

    process.abort(reason);
  });
}

/**
 * Abstract base for FFmpeg processes that produce fragmented MP4 segments on their stdout. Owns the composition wiring between the process's stdout and an internal
 * {@link Mp4SegmentAssembler}, plus the bridge that propagates assembler teardown to the process when the assembler aborts for reasons the process's own exit handler
 * cannot discover on its own (watchdog timeout, source stream error).
 *
 * This base deliberately contains **no pipeline logic** and **no command-line assembly**. The byte-to-segment pipeline lives in {@link Mp4SegmentAssembler}, and each
 * concrete subclass builds its own FFmpeg arg vector. The base exists solely to consolidate the composition shape - internal assembler field, the delegating public
 * methods, and the bridge registration - that would otherwise duplicate across every fMP4 subclass. The constructor takes only `segmentTimeout` as a mode-specific knob
 * and holds no mode-specific state, so the base avoids template-method coupling with its subclasses.
 *
 * Subclasses must call `super(options, init, segmentTimeout?)` from their constructor, having already folded their subclass-specific init into a base-compatible
 * {@link FfmpegProcessInit} (typically by spreading their own init and setting `args` to their built command line).
 *
 * @see Mp4SegmentAssembler
 * @see FfmpegProcess
 *
 * @category FFmpeg
 */
export abstract class FfmpegFMp4Process extends FfmpegProcess {

  /**
   * stdout is consumed internally by the assembler. The public type is narrowed to `never` so TypeScript callers cannot accidentally attach a concurrent reader.
   */
  public declare readonly stdout: never;

  readonly #assembler: Mp4SegmentAssembler;

  /**
   * Construct and spawn a new fMP4 segment-producing process.
   *
   * @param options         - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init            - Base-class init (FfmpegProcessInit) plus the finalized `args` built by the subclass.
   * @param segmentTimeout  - Optional inter-segment watchdog in milliseconds. When set, the assembler aborts with
   *                          `HbpuAbortError("timeout")` if no media segment arrives within the window, and the bridge
   *                          propagates the timeout up to the process. Omit for subclasses that tolerate quiet periods
   *                          (e.g., livestreams).
   */
  protected constructor(options: FfmpegOptions, init: FfmpegProcessInit, segmentTimeout?: number) {

    super(options, init);

    this.#assembler = new Mp4SegmentAssembler(this._stdout, { segmentTimeout, signal: this.signal });

    bridgeAssemblerToProcess(this, this.#assembler);
  }

  /**
   * Resolve with the fMP4 initialization segment (typically `ftyp` + `moov`) once it appears on stdout. Rejects with `this.signal.reason` if the process aborts before
   * the initialization segment completes.
   *
   * @returns A promise resolving to the initialization segment bytes.
   */
  public async getInitSegment(): Promise<Buffer> {

    return this.#assembler.initSegment;
  }

  /**
   * Async generator yielding each completed media segment (concatenated `moof` + `mdat` pair) as a single Buffer. Terminates cleanly when the process or the caller's
   * signal aborts, or when the underlying stdout ends.
   *
   * @param init - Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process.
   *
   * @returns An async generator yielding media segment buffers in stream order.
   */
  public segments(init: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {

    return this.#assembler.segments(init);
  }

  /**
   * The number of assembled media segments buffered in the internal assembler but not yet pulled through {@link FfmpegFMp4Process.segments} - the consumer's catch-up
   * reserve when the FFmpeg source stalls. Delegates to {@link Mp4SegmentAssembler.bufferedSegments}.
   *
   * @returns The buffered-segment depth.
   */
  public get bufferedSegments(): number {

    return this.#assembler.bufferedSegments;
  }
}

/**
 * The minimal surface a recording consumer reads off a recording process. This is the product half of the recording dependency-inversion seam: an HKSV recording
 * delegate depends on this narrow interface rather than the concrete {@link FfmpegRecordingProcess}, so a test (or any alternative segment source) can substitute a
 * fake without dragging FFmpeg into the consumer's dependency graph. The interface is type-only, so importing it costs a consumer nothing at runtime.
 *
 * Every member here is defined on {@link FfmpegFMp4Process} (`getInitSegment`, `segments`, `bufferedSegments`) or inherited from {@link FfmpegProcess}
 * (`abort`, `isTimedOut`, `signal`, `stderrLog`, `stdin`), so the real {@link FfmpegRecordingProcess} satisfies it by inheritance and carries only an `implements`
 * annotation - zero runtime behavior change. This is deliberately the consumer's minimal surface, not the class's full surface: `ready`, `exited`, `stdout`,
 * `aborted`, `hasError`, and `[Symbol.asyncDispose]` are NOT here because the recording consumer does not read them.
 *
 * @see FfmpegRecordingProcess
 * @see RecordingProcessFactory
 *
 * @category FFmpeg
 */
export interface RecordingProcess {

  /**
   * Abort the recording process and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}.
   */
  abort(reason?: unknown): void;

  /**
   * The number of assembled media segments buffered but not yet pulled through {@link RecordingProcess.segments} - the consumer's catch-up reserve when the source
   * stalls.
   */
  readonly bufferedSegments: number;

  /**
   * Resolve with the fMP4 initialization segment (typically `ftyp` + `moov`). Rejects with `signal.reason` if the process aborts before the initialization segment
   * completes.
   *
   * @returns A promise resolving to the initialization segment bytes.
   */
  getInitSegment(): Promise<Buffer>;

  /**
   * `true` when the abort reason indicates a timeout (the inter-segment watchdog fired or the platform `TimeoutError` was raised).
   */
  readonly isTimedOut: boolean;

  /**
   * Async generator yielding each completed media segment (a concatenated `moof` + `mdat` pair) as a single Buffer, in stream order. Terminates cleanly when the process
   * or the caller's signal aborts, or when the underlying source ends.
   *
   * @param init - Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process.
   *
   * @returns An async generator yielding media segment buffers in stream order.
   */
  segments(init?: { signal?: AbortSignal }): AsyncGenerator<Buffer>;

  /**
   * The composed abort signal representing the recording process's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause.
   */
  readonly signal: AbortSignal;

  /**
   * The accumulated stderr lines the process produced, preserved across teardown for post-mortem inspection. A readonly view: callers read, they do not mutate.
   */
  readonly stderrLog: readonly string[];

  /**
   * Writable standard input stream the recording bytes are fed into.
   */
  readonly stdin: Writable;
}

/**
 * The creational half of the recording dependency-inversion seam: build a {@link RecordingProcess} from the shared options and the recording init. A consumer holds
 * this factory typed as the abstraction and constructs through it, so a test can substitute a factory that returns a fake recording process. The production factory is
 * {@link recordingProcessFactory}, whose `create` is exactly the {@link FfmpegRecordingProcess} constructor call - so routing construction through this seam is
 * behavior-neutral, mirroring HBUP's `streamingDelegateFactory` precedent.
 *
 * @see recordingProcessFactory
 * @see RecordingProcess
 *
 * @category FFmpeg
 */
export interface RecordingProcessFactory {

  /**
   * Construct a recording process for the supplied options and recording init.
   *
   * @param options - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init    - Recording init options. See {@link FfmpegRecordingInit}.
   *
   * @returns A new {@link RecordingProcess}.
   */
  create(options: FfmpegOptions, init: FfmpegRecordingInit): RecordingProcess;
}

/**
 * FFmpeg process specialization for HomeKit Secure Video (HKSV) event recording. Builds its command line from the provided HKSV recording configuration and delegates
 * segment production to {@link FfmpegFMp4Process}. Overrides `FfmpegProcess.logFailedTeardown` to substitute a friendly user-facing message when the stderr log
 * matches one of the tolerated HKSV error patterns, suppressing the canonical ERROR dump for those known benign cases. Also overrides
 * `FfmpegProcess.logTimeoutTeardown` to demote the benign inter-segment watchdog reap to debug - a recording ends exactly this way when its segment source quiets,
 * so the base's WARN would be alarming.
 *
 * @example
 *
 * ```ts
 * await using proc = new FfmpegRecordingProcess(ffmpegOptions, {
 *
 *   recording: { fps: 30, probesize: 5_000_000, timeshift: 0 },
 *   recordingConfig,
 *   signal: delegate.abortController.signal
 * });
 *
 * const init = await proc.getInitSegment();
 *
 * for await (const segment of proc.segments()) {
 *
 *   // Forward each media segment to HomeKit.
 * }
 * ```
 *
 * @see FfmpegFMp4Process
 * @see FfmpegProcess
 *
 * @category FFmpeg
 */
export class FfmpegRecordingProcess extends FfmpegFMp4Process implements RecordingProcess {

  /**
   * Construct and spawn a new HKSV recording process.
   *
   * @param options - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init    - Init options. See {@link FfmpegRecordingInit}.
   */
  public constructor(options: FfmpegOptions, init: FfmpegRecordingInit) {

    super(options, { ...init, args: init.args ?? buildRecordingCommandLine(options, init) }, HKSV_TIMEOUT);
  }

  // Known-HKSV-error friendly message. When the abort reason is `"failed"`, inspect the accumulated stderr for any of the tolerated HKSV error patterns and substitute
  // a single user-facing log line for the canonical ERROR dump. Non-matching failures fall through to the base's canonical ERROR dump via `super.logFailedTeardown`.
  // Policy is driven entirely by `signal.reason` and the observed stderr, with no class state of our own.
  protected override logFailedTeardown(reason: HbpuAbortError): void {

    if(this.stderrLog.some((line) => FFMPEG_KNOWN_HKSV_ERROR.test(line))) {

      this.log.error("%s: FFmpeg ended unexpectedly due to issues processing the media stream. This error can be safely ignored - it will occur occasionally.",
        this.options.name());

      return;
    }

    super.logFailedTeardown(reason);
  }

  // FfmpegRecordingProcess is the only fMP4 process that arms an inter-segment watchdog - it alone passes HKSV_TIMEOUT to super, while the sibling
  // FfmpegLivestreamProcess passes no segmentTimeout, so that watchdog never fires there. The watchdog firing is benign by default - it is simply how an HKSV recording
  // ends when its segment source quiets. The watchdog is output-only (it re-arms on completed output segments and never sees stdin), so the library cannot tell a starved
  // source (a benign wire stall) from a fed-but-stuck FFmpeg (a real local hang); it reports the reap quietly at debug and leaves the severity verdict to the consumer,
  // which alone holds the input-feed and reachability context. The base class warns here because a stall on a general (streaming) process genuinely is a problem.
  protected override logTimeoutTeardown(_reason: HbpuAbortError): void {

    this.log.debug("%s: the recording's inter-segment watchdog window elapsed with no new segment.", this.options.name());
  }
}

/**
 * The production {@link RecordingProcessFactory}: builds the concrete FFmpeg-backed recording process. A consumer holds this typed as the abstraction; a test substitutes
 * a fake factory. `create` is exactly the {@link FfmpegRecordingProcess} constructor call, so wiring construction through this seam is behavior-neutral.
 *
 * @see RecordingProcessFactory
 *
 * @category FFmpeg
 */
export const recordingProcessFactory: RecordingProcessFactory = {

  create: (options: FfmpegOptions, init: FfmpegRecordingInit): RecordingProcess => new FfmpegRecordingProcess(options, init)
};

/**
 * FFmpeg process specialization for fMP4 livestreaming from an RTSP source. Builds its command line from the provided livestream source and delegates segment production
 * to {@link FfmpegFMp4Process}.
 *
 * Used by HBUP as an alternative HKSV segment source when pulling directly from an RTSP URL (bypasses the Protect livestream API for debug and diagnostic scenarios).
 * Matches the polymorphic `{ getInitSegment(): Promise<Buffer>; segments(): AsyncGenerator<Buffer> }` interface HBUP uses across the native Protect livestream and this
 * class. Unlike recording, livestream does not enforce an inter-segment watchdog timeout: a live camera feed legitimately quiets down during low-motion periods and does
 * not carry HKSV's 5-second hard timing contract. Callers that need a liveness cap can compose their own timeout via the process's `signal`.
 *
 * @example
 *
 * ```ts
 * await using proc = new FfmpegLivestreamProcess(ffmpegOptions, {
 *
 *   audio: { codec: AudioRecordingCodecType.AAC_LC, samplerate: AudioRecordingSamplerate.KHZ_16 },
 *   livestream: { url: "rtsp://camera/stream" },
 *   segmentLength: 1000,
 *   signal: session.controller.signal
 * });
 *
 * const init = await proc.getInitSegment();
 *
 * for await (const segment of proc.segments()) {
 *
 *   // Forward each media segment to the downstream consumer.
 * }
 * ```
 *
 * @see FfmpegFMp4Process
 * @see FfmpegProcess
 *
 * @category FFmpeg
 */
export class FfmpegLivestreamProcess extends FfmpegFMp4Process {

  /**
   * Construct and spawn a new fMP4 livestream process.
   *
   * @param options - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init    - Init options. See {@link FfmpegLivestreamInit}.
   */
  public constructor(options: FfmpegOptions, init: FfmpegLivestreamInit) {

    super(options, { ...init, args: init.args ?? buildLivestreamCommandLine(options, init) });
  }
}
