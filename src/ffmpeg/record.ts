/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/record.ts: Provide FFmpeg process control to support livestreaming and HomeKit Secure Video.
 */

/**
 * FFmpeg process management for HomeKit Secure Video (HKSV) events and fMP4 livestreaming.
 *
 * This module defines classes for orchestrating FFmpeg processes that produce fMP4 segments suitable for HomeKit Secure Video and realtime livestreaming scenarios. It
 * handles process lifecycle, segment buffering, initialization segment detection, and streaming event generation, abstracting away the complexity of interacting directly
 * with FFmpeg for these workflows.
 *
 * Key features:
 *
 * - Automated setup and management of FFmpeg processes for HKSV event recording and livestreaming (with support for audio and video).
 * - Parsing and generation of fMP4 boxes/segments for HomeKit, including initialization and media segments.
 * - Async generator APIs for efficient, event-driven segment handling.
 * - Flexible error handling and timeouts for HomeKit's strict realtime requirements.
 * - Designed for Homebridge plugin authors or advanced users who need robust, platform-aware FFmpeg session control for HomeKit and related integrations.
 *
 * @module
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate, type CameraRecordingConfiguration } from "homebridge";
import { HKSV_IDR_INTERVAL, HKSV_TIMEOUT } from "./settings.js";
import { type Nullable, type PartialWithId, runWithTimeout } from "../util.js";
import { BOX_HEADER_SIZE } from "./fmp4.js";
import type { FfmpegOptions } from "./options.js";
import { FfmpegProcess } from "./process.js";
import { once } from "node:events";

/**
 * Base options shared by both fMP4 recording and livestream sessions.
 *
 * @property audioFilters        - Audio filters for FFmpeg to process. These are passed as an array of filters.
 * @property audioStream         - Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream).
 * @property codec               - The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`.
 * @property enableAudio         - Indicates whether to enable audio or not.
 * @property hardwareDecoding    - Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions`.
 * @property hardwareTranscoding - Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`.
 * @property transcodeAudio      - Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`.
 * @property videoFilters        - Video filters for FFmpeg to process. These are passed as an array of filters.
 * @property videoStream         - Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream).
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
 * @example
 *
 * ```ts
 * // Raw audio from a DoorBird audio.cgi endpoint.
 * const rawAudioInput: FMp4AudioInputConfig = {
 *
 *   format: "mulaw",
 *   sampleRate: 8000,
 *   url: "http://doorbird-ip/bha-api/audio.cgi"
 * };
 *
 * // Self-describing RTSP audio stream - only URL is needed.
 * const rtspAudioInput: FMp4AudioInputConfig = {
 *
 *   url: "rtsp://camera-ip/audio"
 * };
 * ```
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
 * Options for configuring an fMP4 HKSV recording session.
 *
 * @property fps             - The video frames per second for the session.
 * @property probesize       - Number of bytes to analyze for stream information.
 * @property timeshift       - Timeshift offset for event-based recording (in milliseconds).
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

// Utility to map HKSV audio recording codec types to their AAC Object Type identifiers. We also use satisfies here to ensure we account for any future changes that
// would require updating this mapping.
const translateAudioRecordingCodecType = {

  [ AudioRecordingCodecType.AAC_ELD ]:   "38",
  [ AudioRecordingCodecType.AAC_LC ]:    "1"
} as const satisfies Record<AudioRecordingCodecType, string>;

// Utility to map audio sample rates to strings. We also use satisfies here to ensure we account for any future changes that would require updating this mapping.
const translateAudioSampleRate = {

  [ AudioRecordingSamplerate.KHZ_8 ]:    "8",
  [ AudioRecordingSamplerate.KHZ_16 ]:   "16",
  [ AudioRecordingSamplerate.KHZ_24 ]:   "24",
  [ AudioRecordingSamplerate.KHZ_32 ]:   "32",
  [ AudioRecordingSamplerate.KHZ_44_1 ]: "44.1",
  [ AudioRecordingSamplerate.KHZ_48 ]:   "48"
} as const satisfies Record<AudioRecordingSamplerate, string>;

// ISO BMFF box type constants encoded as 32-bit integers for comparison without string allocation in the box-parsing hot path.
const BOX_TYPE_MDAT = 0x6D646174;
const BOX_TYPE_MOOF = 0x6D6F6F66;
const BOX_TYPE_MOOV = 0x6D6F6F76;

// Reusable empty buffer sentinel for the box-parsing loop. Avoids repeated zero-byte allocations on every box reset.
const EMPTY_BUFFER = Buffer.alloc(0);

// Known HKSV-related errors due to occasional inconsistencies produced by the input stream and FFmpeg's own occasional quirkiness. Compiled once at module scope
// rather than on every error event.
const FFMPEG_KNOWN_HKSV_ERROR = new RegExp([

  "(Cannot determine format of input stream 0:0 after EOF)",
  "(Could not write header \\(incorrect codec parameters \\?\\): Broken pipe)",
  "(Could not write header for output file #0)",
  "(Error closing file: Broken pipe)",
  "(Error splitting the input into NAL units\\.)",
  "(Invalid data found when processing input)",
  "(moov atom not found)"
].join("|"));

/**
 * Abstract base class for fMP4 FFmpeg processes. Owns the shared command line skeleton (preamble, video mapping, movflags, audio encoding, output format) and the fMP4
 * box-parsing loop. Subclasses provide mode-specific pieces (input args, encoder selection, box handling) via protected hook methods, following the template method
 * pattern.
 *
 * @see FfmpegRecordingProcess
 * @see FfmpegLivestreamProcess
 * @see FfmpegProcess
 * @see {@link https://ffmpeg.org/ffmpeg.html | FFmpeg Documentation}
 */
abstract class FfmpegFMp4Process extends FfmpegProcess {

  private isLoggingErrors: boolean;

  // The HomeKit recording configuration and resolved base options are stored as protected fields so subclass hook methods can reference them without needing their own
  // copies of the shared state.
  protected readonly fMp4Options: Required<FMp4BaseOptions>;
  protected readonly recordingConfig: CameraRecordingConfiguration;

  /**
   * Constructs a new fMP4 FFmpeg process. Stores shared state and applies defaults to the base options. The command line is not assembled here...subclasses call
   * `buildCommandLine()` after their own initialization to trigger the template method assembly.
   *
   * @param ffmpegOptions     - FFmpeg configuration options.
   * @param recordingConfig   - HomeKit recording configuration for the session.
   * @param fMp4Options       - Partial base options with defaults applied for any unset fields.
   * @param isVerbose         - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(ffmpegOptions: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, fMp4Options: Partial<FMp4BaseOptions> = {}, isVerbose = false) {

    // Initialize our parent.
    super(ffmpegOptions);

    // We want to log errors when they occur.
    this.isLoggingErrors = true;

    // Store the recording configuration for use by subclass hook methods.
    this.recordingConfig = recordingConfig;

    // Apply defaults to the base options and store them. Subclasses store their own mode-specific options separately.
    this.fMp4Options = {

      audioFilters: fMp4Options.audioFilters ?? [],
      audioStream: fMp4Options.audioStream ?? 0,
      codec: fMp4Options.codec ?? "h264",
      enableAudio: fMp4Options.enableAudio ?? true,
      hardwareDecoding: fMp4Options.hardwareDecoding ?? (this.options.codecSupport.ffmpegVersion.startsWith("8.") ? this.options.config.hardwareDecoding : false),
      hardwareTranscoding: fMp4Options.hardwareTranscoding ?? this.options.config.hardwareTranscoding,
      transcodeAudio: fMp4Options.transcodeAudio ?? true,
      videoFilters: fMp4Options.videoFilters ?? [],
      videoStream: fMp4Options.videoStream ?? 0
    };

    // Store the verbose flag for use during command line assembly. We don't build the command line here...subclasses call buildCommandLine() after initializing their
    // own state, which avoids the virtual-call-from-constructor problem.
    this._isVerbose = isVerbose;
  }

  // Per-instance verbose flag, distinct from the inherited isVerbose which reflects the global codecSupport.verbose setting. We keep both so either a global debug
  // setting or a per-session opt-in can enable verbose FFmpeg logging...the check in buildCommandLine() ORs them together.
  private _isVerbose: boolean;

  // Assembles the FFmpeg command line by calling hook methods in the standard order. The shared skeleton lives here; mode-specific pieces come from subclass overrides.
  // Subclasses call this as the last step of their constructor, after their own state is fully initialized.
  protected buildCommandLine(): void {

    // Configure our video parameters for our input:
    //
    // -hide_banner                  Suppress printing the startup banner in FFmpeg.
    // -nostats                      Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags                 Set the format flags to discard any corrupt packets rather than exit.
    // -err_detect ignore_err        Ignore decoding errors and continue rather than exit.
    // -max_delay 500000             Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
    this.commandLineArgs = [

      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt",
      "-err_detect", "ignore_err",
      ...this.options.videoDecoder(this.fMp4Options.codec),
      "-max_delay", "500000",

      // Mode-specific input arguments (RTSP input for livestream, stdin pipe for recording).
      ...this.inputArgs(),

      // Mode-specific separate audio input arguments (livestream with a separate audio endpoint, empty for recording).
      ...this.separateAudioInputArgs()
    ];

    // Configure our recording options for the video stream:
    //
    // -map 0:v:X                    Selects the video track from the input.
    this.commandLineArgs.push(

      "-map", "0:v:" + this.fMp4Options.videoStream.toString(),

      // Mode-specific video encoder arguments (copy for livestream, recordEncoder for recording).
      ...this.videoEncoderArgs()
    );

    // Configure our video filters, if we have them.
    if(this.fMp4Options.videoFilters.length) {

      this.commandLineArgs.push("-filter:v", this.fMp4Options.videoFilters.join(", "));
    }

    // Mode-specific post-filter arguments (frag_duration for livestream, empty for recording).
    this.commandLineArgs.push(...this.postFilterArgs());

    // -movflags flags               In the generated fMP4 stream: set the default-base-is-moof flag in the header, write an initial empty MOOV box, start a new fragment
    //                               at each keyframe, skip creating a segment index (SIDX) box in fragments, and skip writing the final MOOV trailer since it's unneeded.
    // -flush_packets 1              Ensure we flush our write buffer after each muxed packet.
    // -reset_timestamps             Reset timestamps at the beginning of each segment.
    // -metadata                     Set the metadata to the name of the camera to distinguish between FFmpeg sessions.
    this.commandLineArgs.push(

      "-movflags", "default_base_moof+empty_moov+frag_keyframe+skip_sidx+skip_trailer",
      "-flush_packets", "1",
      "-reset_timestamps", "1",
      "-metadata", "comment=" + this.options.name() + " " + this.metadataLabel()
    );

    // Assemble the audio encoding block. This is shared between both modes...the only mode-specific piece is which FFmpeg input index carries the audio stream.
    let transcodeAudio = this.fMp4Options.transcodeAudio;

    if(this.fMp4Options.enableAudio) {

      // Configure the audio portion of the command line. Options we use are:
      //
      // -map N:a:X?                 Selects the audio stream from input N, if it exists. The input index is 0 when audio and video share the same input, or 1 when a
      //                             separate audio input has been configured.
      this.commandLineArgs.push("-map", this.audioInputIndex().toString() + ":a:" + this.fMp4Options.audioStream.toString() + "?");

      // Configure our audio filters, if we have them.
      if(this.fMp4Options.audioFilters.length) {

        this.commandLineArgs.push("-filter:a", this.fMp4Options.audioFilters.join(", "));

        // Audio filters require transcoding. If the user has decided to filter, we enforce this requirement even if they wanted to copy the audio stream.
        transcodeAudio = true;
      }

      if(transcodeAudio) {

        // Configure the audio portion of the command line. Options we use are:
        //
        // -codec:a                    Encode using the codecs available to us on given platforms.
        // -profile:a                  Specify either low-complexity AAC or enhanced low-delay AAC for HKSV events.
        // -ar samplerate              Sample rate to use for this audio. This is specified by HKSV.
        // -ac number                  Set the number of audio channels.
        this.commandLineArgs.push(

          ...this.options.audioEncoder({ codec: this.recordingConfig.audioCodec.type }),
          "-profile:a", translateAudioRecordingCodecType[this.recordingConfig.audioCodec.type],
          "-ar", translateAudioSampleRate[this.recordingConfig.audioCodec.samplerate as AudioRecordingSamplerate] + "k",
          "-ac", (this.recordingConfig.audioCodec.audioChannels ?? 1).toString()
        );
      } else {

        // Configure the audio portion of the command line. Options we use are:
        //
        // -codec:a copy               Copy the audio stream, since it's already in AAC.
        this.commandLineArgs.push("-codec:a", "copy");
      }
    }

    // Configure our video parameters for outputting our final stream:
    //
    // -f mp4                        Tell ffmpeg that it should create an MP4-encoded output stream.
    // pipe:1                        Output the stream to standard output.
    this.commandLineArgs.push(

      "-f", "mp4",
      "pipe:1");

    // Additional logging, but only if we're debugging.
    if(this._isVerbose || this.isVerbose) {

      this.commandLineArgs.unshift("-loglevel", "level+verbose");
    }
  }

  // Hook methods. Subclasses override these to provide their mode-specific FFmpeg command line pieces and box handling behavior.

  // Returns the mode-specific input arguments that follow the shared preamble.
  protected abstract inputArgs(): string[];

  // Returns any additional input arguments for a separate audio source (livestream only, empty for recording).
  protected abstract separateAudioInputArgs(): string[];

  // Returns the FFmpeg input index that contains the audio stream (0 for shared input, 1 when a separate audio input is configured).
  protected abstract audioInputIndex(): number;

  // Returns the mode-specific video encoder arguments.
  protected abstract videoEncoderArgs(): string[];

  // Returns any arguments that go between video filters and movflags (frag_duration for livestream, empty for recording).
  protected abstract postFilterArgs(): string[];

  // Returns the metadata label suffix for this mode.
  protected abstract metadataLabel(): string;

  // Called by the shared box-parsing loop in configureProcess() for each complete fMP4 box. Subclasses provide their own handling: livestream tracks init segments and
  // emits events, recording pushes to a buffer.
  protected abstract handleParsedBox(header: Buffer, data: Buffer, dataLength: number, type: number): void;

  /**
   * Prepares and configures the FFmpeg process for reading and parsing output fMP4 data. The box parsing loop is shared...each complete box is dispatched to the
   * subclass via handleParsedBox().
   */
  protected configureProcess(): void {

    let dataListener: (buffer: Buffer) => void;

    // Call our parent to get started.
    super.configureProcess();

    // Initialize our variables that we need to process incoming FFmpeg packets.
    let header: Buffer = EMPTY_BUFFER;
    let bufferRemaining: Buffer = EMPTY_BUFFER;
    let dataLength = 0;
    let type = 0;

    // Process FFmpeg output and parse out the fMP4 stream it's generating. Here, we take on the task of parsing the fMP4 stream that's being generated and split it up
    // into the MP4 boxes that HAP-NodeJS is ultimately expecting.
    this.process?.stdout.on("data", dataListener = (buffer: Buffer): void => {

      // If we have anything left from the last buffer we processed, prepend it to this buffer.
      if(bufferRemaining.length > 0) {

        buffer = Buffer.concat([ bufferRemaining, buffer ]);
        bufferRemaining = EMPTY_BUFFER;
      }

      let offset = 0;

      // The MP4 container format is well-documented and designed around the concept of boxes. A box (or atom as they used to be called) is at the center of an MP4
      // container. It's composed of an 8-byte header, followed by the data payload it carries.
      for(;;) {

        let data;

        // No existing header, let's start a new box.
        if(!header.length) {

          // If there aren't enough bytes for a complete box header, save them for the next chunk.
          if(buffer.length < BOX_HEADER_SIZE) {

            bufferRemaining = buffer;

            break;
          }

          // Grab the header. The first four bytes represents the length of the entire box. Second four bytes represent the box type.
          header = buffer.subarray(0, BOX_HEADER_SIZE);

          // Now we retrieve the length of the box.
          dataLength = header.readUInt32BE(0);

          // Read the box type as a 32-bit integer to avoid per-box string allocation. Box types are 4-byte ASCII codes ("moof", "mdat", etc.) - a legacy of Apple's
          // original QuickTime "atoms" from 1991, carried forward when MPEG-4 Part 12 standardized the container as ISO BMFF and renamed atoms to "boxes."
          type = header.readUInt32BE(4);

          // Finally, we get the data portion of the box.
          data = buffer.subarray(BOX_HEADER_SIZE, dataLength);

          // Mark our data offset so we account for the length of the data header and subtract it from the overall length to capture just the data portion.
          dataLength -= offset = BOX_HEADER_SIZE;
        } else {

          // Grab the data from our buffer.
          data = buffer.subarray(0, dataLength);
          offset = 0;
        }

        // If we don't have enough data in this buffer, save what we have for the next buffer we see and append it there.
        if(data.length < dataLength) {

          bufferRemaining = data;

          break;
        }

        // Dispatch the complete box to the subclass for mode-specific handling.
        this.handleParsedBox(header, data, dataLength, type);

        // Prepare to start a new box for the next buffer that we will be processing.
        header = EMPTY_BUFFER;
        type = 0;

        // We've parsed an entire box, and there's no more data in this buffer to parse.
        if(buffer.length === (offset + dataLength)) {

          dataLength = 0;

          break;
        }

        // If there's anything left in the buffer, move us to the new box and let's keep iterating.
        buffer = buffer.subarray(offset + dataLength);
        dataLength = 0;
      }
    });

    // Make sure we cleanup our listeners when we're done.
    this.process?.once("exit", () => {

      this.process?.stdout.off("data", dataListener);
    });
  }

  /**
   * Stops the FFmpeg process and performs cleanup. Subclasses override this to emit mode-specific events before calling super, which handles the shared teardown and
   * emits the "close" event.
   */
  protected stopProcess(): void {

    // Call our parent to get started.
    super.stopProcess();

    // Signal that the process has ended.
    this._isEnded = true;
    this.emit("close");
  }

  /**
   * Stops the FFmpeg process and logs errors if specified.
   *
   * @param logErrors - If `true`, logs FFmpeg errors. Defaults to the internal process logging state.
   *
   * @example
   *
   * ```ts
   * process.stop();
   * ```
   */
  public stop(logErrors = this.isLoggingErrors): void {

    const savedLogErrors = this.isLoggingErrors;

    // Flag whether we should log abnormal exits (e.g. being killed) or not.
    this.isLoggingErrors = logErrors;

    // Call our parent to finish the job.
    super.stop();

    // Restore our previous logging state.
    this.isLoggingErrors = savedLogErrors;
  }

  /**
   * Logs errors from FFmpeg process execution, handling known benign HKSV stream errors gracefully.
   *
   * @param exitCode - The exit code from the FFmpeg process.
   * @param signal   - The signal (if any) used to terminate the process.
   */
  protected logFfmpegError(exitCode: Nullable<number>, signal: Nullable<NodeJS.Signals>): void {

    // If we're ignoring errors, we're done.
    if(!this.isLoggingErrors) {

      return;
    }

    // See if we know about this error.
    if(this.stderrLog.some(x => FFMPEG_KNOWN_HKSV_ERROR.test(x))) {

      this.log.error("FFmpeg ended unexpectedly due to issues processing the media stream. This error can be safely ignored - it will occur occasionally.");

      return;
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
  }
}

/**
 * Manages a HomeKit Secure Video recording FFmpeg process.
 *
 * @example
 *
 * ```ts
 * const process = new FfmpegRecordingProcess(ffmpegOptions, recordingConfig, 30, true, 5000000, 0);
 * process.start();
 * ```
 *
 * @see FfmpegFMp4Process
 *
 * @category FFmpeg
 */
export class FfmpegRecordingProcess extends FfmpegFMp4Process {

  /**
   * Indicates whether the recording has timed out waiting for FFmpeg output.
   */
  public isTimedOut: boolean;

  private readonly fps: number;
  private readonly probesize: number;
  private recordingBuffer: { data: Buffer; header: Buffer; length: number; type: number }[];
  private readonly timeshift: number;

  /**
   * Constructs a new FFmpeg recording process for HKSV events.
   *
   * @param options          - FFmpeg configuration options.
   * @param recordingConfig  - HomeKit recording configuration for the session.
   * @param fMp4Options      - fMP4 recording options.
   * @param isVerbose        - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(options: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, fMp4Options: Partial<FMp4RecordingOptions> = {}, isVerbose = false) {

    super(options, recordingConfig, fMp4Options, isVerbose);

    // Store recording-specific options.
    this.fps = fMp4Options.fps ?? 30;
    this.isTimedOut = false;
    this.probesize = fMp4Options.probesize ?? 5000000;
    this.recordingBuffer = [];
    this.timeshift = fMp4Options.timeshift ?? 0;

    // Assemble the FFmpeg command line now that all state is initialized.
    this.buildCommandLine();
  }

  // Recording input: read fMP4 data from standard input with low-delay optimizations and an optional timeshift for HKSV event alignment.
  //
  // -flags low_delay              Tell FFmpeg to optimize for low delay / realtime decoding.
  // -probesize number             How many bytes should be analyzed for stream information.
  // -f mp4                        Tell FFmpeg that it should expect an MP4-encoded input stream.
  // -i pipe:0                     Use standard input to get video data.
  // -ss                           Fast forward to where HKSV is expecting us to be for a recording event.
  protected inputArgs(): string[] {

    return [

      "-flags", "low_delay",
      "-probesize", this.probesize.toString(),
      "-f", "mp4",
      "-i", "pipe:0",
      "-ss", this.timeshift.toString() + "ms"
    ];
  }

  // Recordings always read audio from the primary input...no separate audio source.
  protected separateAudioInputArgs(): string[] {

    return [];
  }

  // Audio is always on the primary input (index 0) for recordings.
  protected audioInputIndex(): number {

    return 0;
  }

  // Recordings transcode video using the platform-appropriate encoder for HKSV.
  protected videoEncoderArgs(): string[] {

    return this.options.recordEncoder({

      bitrate: this.recordingConfig.videoCodec.parameters.bitRate,
      fps: this.recordingConfig.videoCodec.resolution[2],
      hardwareDecoding: this.fMp4Options.hardwareDecoding,
      hardwareTranscoding: this.fMp4Options.hardwareTranscoding,
      height: this.recordingConfig.videoCodec.resolution[1],
      idrInterval: HKSV_IDR_INTERVAL,
      inputFps: this.fps,
      level: this.recordingConfig.videoCodec.parameters.level,
      profile: this.recordingConfig.videoCodec.parameters.profile,
      width: this.recordingConfig.videoCodec.resolution[0]
    });
  }

  // Recordings have no post-filter arguments.
  protected postFilterArgs(): string[] {

    return [];
  }

  // Metadata label identifying this as an HKSV event recording.
  protected metadataLabel(): string {

    return "HKSV Event";
  }

  // Each parsed box is queued in the recording buffer for consumption by segmentGenerator().
  protected handleParsedBox(header: Buffer, data: Buffer, dataLength: number, type: number): void {

    this.recordingBuffer.push({ data, header, length: dataLength, type });
    this.emit("mp4box");
  }

  /**
   * Stops the FFmpeg process and performs cleanup, ensuring the segment generator can exit.
   */
  protected stopProcess(): void {

    // Emit mp4box to unblock segmentGenerator() if it's waiting, then let the base class handle the rest.
    this._isEnded = true;
    this.emit("mp4box");

    super.stopProcess();
  }

  /**
   * Asynchronously generates complete segments from FFmpeg output, formatted for HomeKit Secure Video.
   *
   * This async generator yields fMP4 segments as Buffers, or ends on process termination or timeout.
   *
   * @yields A Buffer containing a complete MP4 segment suitable for HomeKit.
   *
   * @example
   *
   * ```ts
   * for await(const segment of process.segmentGenerator()) {
   *
   *   // Process each segment for HomeKit.
   * }
   * ```
   */
  public async *segmentGenerator(): AsyncGenerator<Buffer> {

    let segment: Buffer[] = [];

    // Loop forever, generating either FTYP/MOOV box pairs or MOOF/MDAT box pairs for HomeKit Secure Video.
    for(;;) {

      // FFmpeg has finished its output - we're done.
      if(this._isEnded) {

        return;
      }

      // If the buffer is empty, wait for our FFmpeg process to produce more boxes.
      if(!this.recordingBuffer.length) {

        // Segments are output by FFmpeg according to our specified IDR interval. If we don't see a segment within the timeframe we need for HKSV's timing requirements,
        // we flag it accordingly and return null back to the generator that's calling us.
        // eslint-disable-next-line no-await-in-loop
        await runWithTimeout(once(this, "mp4box"), HKSV_TIMEOUT);
      }

      // Grab the next fMP4 box from our buffer.
      const box = this.recordingBuffer.shift();

      // FFmpeg hasn't produced any output. Given the time-sensitive nature of HKSV that constrains us to no more than 5 seconds to provide the next segment, we're done.
      if(!box) {

        this.isTimedOut = true;

        return;
      }

      // Queue up this fMP4 box to send back to HomeKit.
      segment.push(box.header, box.data);

      // What we want to send are two types of complete segments, made up of multiple MP4 boxes:
      //
      // - a complete MOOV box, usually with an accompanying FTYP box, that's sent at the very beginning of any valid fMP4 stream. HomeKit Secure Video looks for this
      //   before anything else.
      //
      // - a complete MOOF/MDAT pair. MOOF describes the sample locations and their sizes and MDAT contains the actual audio and video data related to that segment. Think
      //   of MOOF as the audio/video data "header", and MDAT as the "payload".
      //
      // Once we see these, we combine all the segments in our queue to send back to HomeKit.
      if((box.type === BOX_TYPE_MOOV) || (box.type === BOX_TYPE_MDAT)) {

        yield Buffer.concat(segment);
        segment = [];
      }
    }
  }
}

/**
 * Manages a HomeKit livestream FFmpeg process for generating fMP4 segments.
 *
 * @example
 *
 * ```ts
 * const process = new FfmpegLivestreamProcess(ffmpegOptions, recordingConfig, url, 30, true);
 * process.start();
 *
 * const initSegment = await process.getInitSegment();
 * ```
 *
 * @see FfmpegFMp4Process
 *
 * @category FFmpeg
 */
export class FfmpegLivestreamProcess extends FfmpegFMp4Process {

  /**
   * Optional override for the fMP4 fragment duration, in milliseconds. When set, the `-frag_duration` argument is updated before starting the FFmpeg process.
   */
  public segmentLength?: number;

  // Set to true during separateAudioInputArgs() when a separate audio input is configured, so that audioInputIndex() returns the correct FFmpeg input index.
  private _hasAudioInput: boolean;
  private _initSegment: Buffer;
  private _initSegmentParts: Buffer[];
  private hasInitSegment: boolean;
  private readonly livestreamOptions: PartialWithId<FMp4LivestreamOptions, "url">;

  /**
   * Constructs a new FFmpeg livestream process.
   *
   * @param options            - FFmpeg configuration options.
   * @param recordingConfig    - HomeKit recording configuration for the session.
   * @param livestreamOptions  - livestream segmenting options.
   * @param isVerbose          - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(options: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, livestreamOptions: PartialWithId<FMp4LivestreamOptions, "url">, isVerbose = false) {

    super(options, recordingConfig, livestreamOptions, isVerbose);

    // Store livestream-specific options.
    this._hasAudioInput = false;
    this._initSegment = Buffer.alloc(0);
    this._initSegmentParts = [];
    this.hasInitSegment = false;
    this.livestreamOptions = livestreamOptions;

    // Assemble the FFmpeg command line now that all state is initialized.
    this.buildCommandLine();
  }

  // Livestream input: connect to an RTSP source with direct I/O and TCP transport.
  //
  // -avioflags direct           Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
  // -rtsp_transport tcp         Tell the RTSP stream handler that we're looking for a TCP connection.
  // -i url                      RTSPS URL to get our input stream from.
  protected inputArgs(): string[] {

    return [

      "-avioflags", "direct",
      "-rtsp_transport", "tcp",
      "-i", this.livestreamOptions.url
    ];
  }

  // If a separate audio input has been configured, build the FFmpeg input arguments for it. This enables support for devices like DoorBird where video and audio are
  // served from different endpoints.
  protected separateAudioInputArgs(): string[] {

    if(!this.fMp4Options.enableAudio || !this.livestreamOptions.audioInput) {

      return [];
    }

    const args: string[] = [];

    // Normalize the audio input configuration. A plain string is treated as a URL shorthand.
    const audioInput: FMp4AudioInputConfig = (typeof this.livestreamOptions.audioInput === "string") ?
      { url: this.livestreamOptions.audioInput } :
      this.livestreamOptions.audioInput;

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
    if([ "rtsp://", "rtsps://" ].some((protocol) => audioInput.url.toLowerCase().startsWith(protocol))) {

      args.push("-rtsp_transport", "tcp");
    }

    // -i url                          Audio input URL.
    args.push("-i", audioInput.url);

    // Track that we have a separate audio input so audioInputIndex() returns the correct value.
    this._hasAudioInput = true;

    return args;
  }

  // When a separate audio input is configured, audio is on the second FFmpeg input (index 1). Otherwise it shares the primary input (index 0).
  protected audioInputIndex(): number {

    return this._hasAudioInput ? 1 : 0;
  }

  // Livestreams remux the video stream directly without transcoding.
  protected videoEncoderArgs(): string[] {

    return [ "-codec:v", "copy" ];
  }

  // Livestreams emit fMP4 fragments at one-second intervals by default.
  //
  // -frag_duration number       Length of each fMP4 fragment, in microseconds.
  protected postFilterArgs(): string[] {

    return [ "-frag_duration", "1000000" ];
  }

  // Metadata label identifying this as a livestream buffer.
  protected metadataLabel(): string {

    return "Livestream Buffer";
  }

  // Livestream box handling: accumulate the initialization segment (everything before the first moof box), then emit each subsequent box as a segment event.
  protected handleParsedBox(header: Buffer, data: Buffer, _dataLength: number, type: number): void {

    // If this is part of the initialization segment, store it for future use.
    if(!this.hasInitSegment) {

      // The initialization segment is everything before the first moof box. Once we've seen a moof box, we know we've captured it in full. We collect the parts into an
      // array and concatenate once at the end to avoid creating intermediate buffers on every pre-moof box.
      if(type === BOX_TYPE_MOOF) {

        this._initSegment = Buffer.concat(this._initSegmentParts);
        this._initSegmentParts = [];
        this.hasInitSegment = true;
        this.emit("initsegment");
      } else {

        this._initSegmentParts.push(header, data);
      }
    }

    if(this.hasInitSegment) {

      // We only emit segments once we have the initialization segment.
      this.emit("segment", Buffer.concat([ header, data ]));
    }
  }

  /**
   * Starts the FFmpeg process, adjusting the fragment duration if segmentLength has been set.
   *
   * @example
   *
   * ```ts
   * process.start();
   * ```
   */
  public start(): void {

    if(this.segmentLength !== undefined) {

      const fragIndex = this.commandLineArgs.indexOf("-frag_duration");

      if(fragIndex !== -1) {

        this.commandLineArgs[fragIndex + 1] = (this.segmentLength * 1000).toString();
      }
    }

    // Start the FFmpeg session.
    super.start();
  }

  /**
   * Gets the fMP4 initialization segment generated by FFmpeg for the livestream.
   *
   * @returns A promise resolving to the initialization segment as a Buffer.
   *
   * @example
   *
   * ```ts
   * const initSegment = await process.getInitSegment();
   * ```
   */
  public async getInitSegment(): Promise<Buffer> {

    // If we have the initialization segment, return it.
    if(this.hasInitSegment) {

      return this._initSegment;
    }

    // Wait until the initialization segment is available.
    await once(this, "initsegment");

    return this._initSegment;
  }

  /**
   * Returns the initialization segment as a Buffer, or null if not yet available.
   *
   * @returns The initialization segment Buffer, or `null` if not yet generated.
   *
   * @example
   *
   * ```ts
   * const init = process.initSegment;
   * if(init) {
   *
   *   // Use the initialization segment.
   * }
   * ```
   */
  public get initSegment(): Nullable<Buffer> {

    if(!this.hasInitSegment) {

      return null;
    }

    return this._initSegment;
  }
}
