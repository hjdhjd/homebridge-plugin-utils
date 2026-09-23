/* Copyright(C) 2023-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/options.ts: FFmpeg decoder and encoder options with hardware-accelerated codec support where available.
 */

/**
 * Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.
 *
 * This module defines interfaces and classes for specifying, adapting, and generating FFmpeg command-line arguments tailored to the host system's capabilities. It
 * automates the selection of codecs, pixel formats, hardware encoders/decoders, and streaming profiles for maximum compatibility and performance.
 *
 * Key features:
 *
 * - Encapsulates all FFmpeg transcoding and streaming options (including bitrate, resolution, framerate, H.264 profiles/levels, and quality optimizations).
 * - Detects and configures hardware-accelerated encoding and decoding (macOS VideoToolbox, Intel Quick Sync Video, and Raspberry Pi 4), falling back to software
 *   processing when required.
 * - Dynamically generates the appropriate FFmpeg command-line arguments for livestreaming, HomeKit Secure Video (HKSV) event recording, and crop filters.
 * - Provides strong TypeScript types and interfaces for reliable integration and extensibility in Homebridge.
 *
 * This module is intended for plugin authors and advanced users who need precise, robust control over FFmpeg processing pipelines, with platform-aware optimizations and
 * safe fallbacks.
 *
 * @module
 */
import { AudioRecordingCodecType, H264Level, H264Profile } from "./hap-enums.ts";
import { HOMEKIT_STREAMING_HEADROOM, RPI4_GPU_MINIMUM, RPI4_HW_TRANSCODE_MAX_PIXELS } from "./settings.ts";
import type { Clock } from "../clock.ts";
import type { FfmpegCodecs } from "./codecs.ts";
import type { Logger } from "../util.ts";

// Translation tables for the H264 enum values that shape FFmpeg's `-level:v` and `-profile:v` arguments. `as const satisfies Record<...>` holds each map fixed to
// exhaustively cover every enum member at compile time - a new enum value added upstream forces the build to fail until the table is updated, so encoder-argument
// emission cannot silently default to a wrong value when consumers extend the upstream enum. The two-key payload (`numeric`/`string`) matches FFmpeg's two emission
// shapes per argument.
const H264_LEVEL_NAMES = {

  [ H264Level.LEVEL3_1 ]: { numeric: "31", string: "3.1" },
  [ H264Level.LEVEL3_2 ]: { numeric: "32", string: "3.2" },
  [ H264Level.LEVEL4_0 ]: { numeric: "40", string: "4.0" }
} as const satisfies Record<H264Level, { numeric: string; string: string }>;

const H264_PROFILE_NAMES = {

  [ H264Profile.BASELINE ]: { numeric: "66", string: "baseline" },
  [ H264Profile.HIGH ]:     { numeric: "100", string: "high" },
  [ H264Profile.MAIN ]:     { numeric: "77", string: "main" }
} as const satisfies Record<H264Profile, { numeric: string; string: string }>;

/**
 * Configuration options for `FfmpegOptions`, defining transcoding, decoding, logging, and hardware acceleration settings.
 *
 * @property clock                - Optional time source for the callback timers every process built from these options, and every resource those processes compose,
 *                                  arm: the streaming health watchdog and the segment assembler's inter-segment watchdog. Left undefined, each of those falls back to
 *                                  `systemClock` on its own, so the options object carries the choice unresolved exactly as any other composer does. The clock lives
 *                                  here, beside `log` and `debug`, because these options ARE the per-session substrate a consumer configures once and every process,
 *                                  recording, and livestream is then built from, where an init carries per-construction lifetimes instead. The startup timeout and
 *                                  the codec probe are deadline signals rather than callback timers, and they draw those signals from this same clock, so a
 *                                  consumer's virtual clock drives every shape of time the process family arms.
 * @property codecSupport         - FFmpeg codec capabilities and hardware support.
 * @property crop                 - Optional. Cropping rectangle for output video. Each of `width`, `height`, `x`, and `y` is a fraction of the source frame's
 *                                  corresponding dimension (0 to 1), not a pixel count or a percentage - `{ width: 1, height: 1, x: 0, y: 0 }` selects the full
 *                                  frame, `{ width: 0.5, height: 0.5, x: 0.25, y: 0.25 }` selects its centered quarter-area crop. Crop runs on the CPU, so with a crop
 *                                  configured a hardware decoder hands its frames over in system memory, and a hardware encode uploads the cropped frames.
 * @property debug                - Optional. Enable debug logging.
 * @property hardwareDecoding     - Enable hardware-accelerated video decoding if available.
 * @property hardwareTranscoding  - Enable hardware-accelerated video encoding if available.
 * @property log                  - Logging interface for output and errors.
 * @property name                 - Function returning the name or label for this options set.
 *
 * @remarks The `hardwareDecoding` and `hardwareTranscoding` flags are bidirectional. On input, they express the caller's desired hardware acceleration state. During
 * `FfmpegOptions` construction, the flags are resolved against the host's actual capabilities and the config object is mutated in place to reflect what is available.
 * After construction, these flags represent the resolved state...`hardwareDecoding` or `hardwareTranscoding` may be set to `false` if the required codecs or
 * accelerators are absent, or `hardwareDecoding` may be set to `true` if Intel Quick Sync Video is detected even when not explicitly requested.
 *
 * @example
 *
 * ```ts
 * const optionsConfig: FfmpegOptionsConfig = {
 *
 *   codecSupport: ffmpegCodecs,
 *   crop: { width: 1, height: 1, x: 0, y: 0 },
 *   debug: false,
 *   hardwareDecoding: true,
 *   hardwareTranscoding: true,
 *   log,
 *   name: () => "Camera"
 * };
 * ```
 *
 * @see FfmpegOptions
 *
 * @category FFmpeg
 */
export interface FfmpegOptionsConfig {

  clock?: Clock;
  codecSupport: FfmpegCodecs;
  crop?: { height: number; width: number; x: number; y: number };
  debug?: boolean;
  hardwareDecoding: boolean;
  hardwareTranscoding: boolean;
  log: Logger;
  name: () => string;
}

/**
 * Options used for configuring audio encoding in FFmpeg operations.
 *
 * The single field selects the AAC profile that drives encoder-specific arg emission in {@link FfmpegOptions.audioEncoder} - AAC-ELD (the HomeKit Secure Video event-
 * recording default, lower bitrate, low-latency) versus AAC-LC (higher-quality livestream variant). The chosen profile maps to `aac_at` mode switches on macOS and to
 * `libfdk_aac` flags elsewhere.
 *
 * @property codec               - Optional. AAC profile to encode (`AudioRecordingCodecType.AAC_ELD` or `AudioRecordingCodecType.AAC_LC`). Defaults to
 *                                 `AudioRecordingCodecType.AAC_ELD`.
 *
 * @example
 *
 * ```ts
 * const encoderOptions: AudioEncoderOptions = {
 *
 *   codec: AudioRecordingCodecType.AAC_ELD
 * };
 *
 * // Use with FfmpegOptions for transcoding.
 * const ffmpegOpts = new FfmpegOptions(optionsConfig);
 * const args = ffmpegOpts.audioEncoder(encoderOptions);
 * ```
 *
 * @see FfmpegOptions
 *
 * @category FFmpeg
 */
export interface AudioEncoderOptions {

  codec?: AudioRecordingCodecType;
}

/**
 * Options used for configuring video encoding in FFmpeg operations.
 *
 * These options control output bitrate, framerate, resolution, H.264 profile and level, input framerate, and smart quality optimizations.
 *
 * @property bitrate             - Target video bitrate, in kilobits per second.
 * @property fps                 - Target output frames per second.
 * @property hardwareDecoding    - Optional. If `true`, the pipeline decodes on hardware wherever the host's hardware decoder can take `inputCodec`, and in software
 *                                 where it cannot. Together with `hardwareTranscoding` it decides where the decoded frames live: a hardware decode feeding a hardware
 *                                 encode keeps them on the GPU, and a hardware decode feeding a software encode hands them over in system memory. Defaults to the
 *                                 resolved `FfmpegOptionsConfig.hardwareDecoding` value on the owning `FfmpegOptions` instance.
 * @property hardwareTranscoding - Optional. If `true`, the emitted args select a hardware-accelerated encoder (`h264_videotoolbox` / `h264_qsv` / `h264_v4l2m2m`) and
 *                                 the matching filter pipeline. If `false`, the args fall back to the libx264 software encoder. Defaults to the resolved
 *                                 `FfmpegOptionsConfig.hardwareTranscoding` value on the owning `FfmpegOptions` instance.
 * @property height              - Output video height, in pixels.
 * @property idrInterval         - Interval (in seconds) between keyframes (IDR frames).
 * @property inputCodec          - Optional. Codec of the source stream the pipeline decodes: `"av1"`, `"h264"`, or `"hevc"` (`"h265"` is accepted as an alias for
 *                                 `"hevc"`, and matching is case-insensitive). The host's hardware decoder takes only some codecs - AV1 needs Apple Silicon M3 or newer
 *                                 with FFmpeg 8, or 11th-generation Intel silicon - and a source it cannot take, or a codec outside that list, decodes in software, so
 *                                 the encoder side needs the codec to know where the frames arrive. Defaults to `"h264"`.
 * @property inputFps            - Input (source) frames per second.
 * @property level               - H.264 profile level for output.
 * @property profile             - H.264 profile for output.
 * @property smartQuality        - Optional. Enables variable-bitrate quality-constrained encoding on encoders that support it - libx264 (`-crf 20`), Apple Silicon
 *                                 VideoToolbox (`-q:v 90`), and Intel QSV (`-global_quality 20`). Intel VideoToolbox and v4l2m2m have no quality-constraint mode and
 *                                 always emit a fixed `-b:v` regardless. In all cases, `smartQuality` also adds `HOMEKIT_STREAMING_HEADROOM` to `-maxrate`, giving the
 *                                 encoder a narrow band of variation above the target bitrate. Defaults to `true`.
 * @property videoFilters        - Optional. Caller-supplied CPU-side video filters, run in caller order after the encoder's own crop and scale filters. They always
 *                                 run in system memory - the encoder's chain brings frames there ahead of them and hands their output on to a hardware encoder - so
 *                                 callers never reason about GPU residency. On VideoToolbox they move the whole chain onto the CPU, down to where the decoder hands
 *                                 its frames over, so pass `videoDecoder` this same options object. Omitted or empty means the chain is exactly the encoder's own.
 * @property width               - Output video width, in pixels.
 *
 * @example
 *
 * ```ts
 * const encoderOptions: VideoEncoderOptions = {
 *
 *   bitrate: 3000,
 *   fps: 30,
 *   hardwareDecoding: true,
 *   hardwareTranscoding: true,
 *   height: 1080,
 *   idrInterval: 2,
 *   inputCodec: "hevc",
 *   inputFps: 30,
 *   level: H264Level.LEVEL4_0,
 *   profile: H264Profile.HIGH,
 *   smartQuality: true,
 *   width: 1920
 * };
 *
 * // Use with FfmpegOptions for transcoding or streaming. The decoder and the encoder read the same pipeline description.
 * const ffmpegOpts = new FfmpegOptions(optionsConfig);
 * const args = [ ...ffmpegOpts.videoDecoder(encoderOptions), ...ffmpegOpts.streamEncoder(encoderOptions) ];
 * ```
 *
 * @see FfmpegOptions
 * @see {@link https://ffmpeg.org/ffmpeg-codecs.html | FFmpeg Codecs Documentation}
 *
 * @category FFmpeg
 */
export interface VideoEncoderOptions {

  bitrate: number;
  fps: number;
  hardwareDecoding?: boolean;
  hardwareTranscoding?: boolean;
  height: number;
  idrInterval: number;
  inputCodec?: string;
  inputFps: number;
  level: H264Level;
  profile: H264Profile;
  smartQuality?: boolean;
  videoFilters?: readonly string[];
  width: number;
}

/**
 * Every hardware-transcode context this module distinguishes, each with a source-pixel ceiling that can differ on a given host. Live streaming and HKSV recording
 * both transcode, but a host may admit one context to its hardware encoder and not the other (today: Raspberry Pi runs live transcoding on h264_v4l2m2m but falls
 * HKSV recording back to libx264). Consumed by `maxSourcePixels` and the `recordEncoder` software-fallback so both derive the same per-context hardware-capability
 * answer from one predicate.
 *
 * @category FFmpeg
 */
export type EncoderContext = "record" | "stream";

// `VideoEncoderOptions` after `resolveEncoderOptions` has filled in defaults and clamped the hardware flags against the resolved class config. The resolver-guaranteed
// fields are narrowed to `Required` so downstream handlers read `resolved.hardwareDecoding` / `resolved.hardwareTranscoding` / `resolved.smartQuality` as definite
// booleans, `resolved.inputCodec` as a definite string, and `resolved.videoFilters` as a definite `readonly string[]`, never their optional forms. The type exists
// purely to carry that guarantee through the dispatch chain - internal only, not part of the module's public export surface.
type ResolvedVideoEncoderOptions =
  VideoEncoderOptions & Required<Pick<VideoEncoderOptions, "hardwareDecoding" | "hardwareTranscoding" | "inputCodec" | "smartQuality" | "videoFilters">>;

// Shared pre-computed state threaded from `streamEncoder`'s dispatcher into each per-platform handler. Private to the module because every field is an implementation
// detail of the hardware-stream emission pipeline; exposing it publicly would leak internal wiring without adding caller-facing value. All rate-control strings are
// pre-formatted so handlers can interpolate them directly into argv without re-deriving identical values per platform.
interface HardwareStreamContext {

  bufsize: string;
  filterChain: string;
  frameRateArg: readonly string[];
  gop: string;
  init: readonly string[];
  maxrate: string;
}

// Pure derivations that every encoder path - software livestream, software record, and each per-platform hardware handler - uses identically. Centralizing them in
// module-scope functions prevents bitrate / buffer / keyframe math from drifting across platforms and keeps each caller a one-line interpolation rather than an inline
// arithmetic expression.

// `-g:v` value. HomeKit's idrInterval is expressed in seconds, so the GOP length in frames is (fps * idrInterval).
function gopArg(options: VideoEncoderOptions): string {

  return (options.fps * options.idrInterval).toString();
}

// `-bufsize` value, in kbps. A rate-control buffer sized at twice the target bitrate is the convention we apply uniformly across encoders.
function bufsizeArg(options: VideoEncoderOptions): string {

  return (2 * options.bitrate).toString() + "k";
}

// `-maxrate` value, in kbps. Adds the streaming headroom only when smart-quality is enabled; otherwise caps strictly at the requested bitrate.
function maxrateArg(options: VideoEncoderOptions): string {

  return (options.bitrate + (options.smartQuality ? HOMEKIT_STREAMING_HEADROOM : 0)).toString() + "k";
}

// `-b:v` value, in kbps. Emitted on the libx264 / macOS.Intel / raspbian / pre-FFmpeg-8.x fallback paths and on the smartQuality-off branches of every encoder that
// has a quality-constrained mode. Extracted here so every `-b:v` emission across the class flows through a single formatter, matching the gop/bufsize/maxrate pattern.
function bitrateArg(options: VideoEncoderOptions): string {

  return options.bitrate.toString() + "k";
}

// The closed set of codecs this module's hardware decoder paths know how to emit args for. Carried as a discriminated string union so every handler downstream of
// `videoDecoder`'s normalization step is typed, not stringly-typed. `QSV_DECODER_BY_CODEC` is typed against this union and therefore exhaustive - adding a codec here
// forces a matching entry there at compile time. The `DECODE_CODEC_ALIASES` alias table is necessarily open-keyed (to admit `"h265"` as an alias for `"hevc"`) and the
// codec gate in `hardwareDecodes` uses guard conditionals rather than an exhaustive switch, so those consumers must be updated by inspection when the union grows.
type SupportedDecodeCodec = "av1" | "h264" | "hevc";

// Canonicalize a caller-supplied codec string into our `SupportedDecodeCodec` surface, or `undefined` when the codec is unsupported. A single frozen table encodes
// both the case-insensitive normalization (all keys are lowercase; `canonicalDecodeCodec` lowercases its input before lookup) and the `h265 -> hevc` alias, so callers
// never have to branch on either separately and the mapping documents the full accepted input surface in one place. Symmetric with `QSV_DECODER_BY_CODEC`: both are
// frozen Records, TypeScript-readonly at the type level and runtime-immutable via `Object.freeze`.
const DECODE_CODEC_ALIASES: Readonly<Record<string, SupportedDecodeCodec>> = Object.freeze({

  "av1": "av1",
  "h264": "h264",
  "h265": "hevc",
  "hevc": "hevc"
});

function canonicalDecodeCodec(codec: string): SupportedDecodeCodec | undefined {

  return DECODE_CODEC_ALIASES[codec.toLowerCase()];
}

// Intel QSV decoder naming: each canonical codec maps to its `<codec>_qsv` variant. Typed against `SupportedDecodeCodec` (not `string`) so the lookup is total at the
// type level and handlers don't need runtime fallbacks. Frozen so the mapping is effectively immutable at the module boundary.
const QSV_DECODER_BY_CODEC = Object.freeze({

  "av1": "av1_qsv",
  "h264": "h264_qsv",
  "hevc": "hevc_qsv"
} satisfies Record<SupportedDecodeCodec, string>);

// A pipeline's resolved state as far as where its frames live: whether it actually decodes on hardware (the source's codec included), whether it encodes on hardware,
// the source's codec, and the caller filters its chain carries, which on VideoToolbox decide whether that chain runs on the CPU. The decode-args builders, the
// residency predicate, and the hardware-transfer and device-init helpers all read it. `Required<Pick<...>>` so every field this view exposes is definite at the type
// level: every caller passes one the resolver produced, a `ResolvedVideoEncoderOptions` or the view `resolvePipelineState` returns, so the weaker optional view has no
// caller behavior to represent. Defined as a dedicated type so those helpers can be called with either shape without casts - the typed counterpart to "pass only
// what you read."
type PipelineStateView = Required<Pick<VideoEncoderOptions, "hardwareDecoding" | "hardwareTranscoding" | "inputCodec" | "videoFilters">>;

// The 8-bit pixel format this module fixes frames to wherever they cross between system memory and the GPU: the upload that creates a VideoToolbox frames context,
// the Quick Sync scaler's output, and the download that brings Quick Sync frames back to system memory for caller-supplied filters. hwdownload can only emit its
// frames context's own format, so the scaler and the download name this one constant and cannot drift apart. Every HomeKit stream is 8-bit H.264, so these are also
// the points where a 10-bit source becomes 8-bit - the upload converts on the CPU and the Quick Sync scaler on the GPU. nv12 is the native layout of both
// VideoToolbox and Quick Sync, so fixing it costs no extra conversion on 8-bit sources.
const GPU_TRANSFER_PIXEL_FORMAT = "nv12";

/**
 * Provides Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.
 *
 * This class generates and adapts FFmpeg command-line arguments for livestreaming and event recording, optimizing for system hardware and codec availability.
 *
 * @example
 *
 * ```ts
 * const ffmpegOpts = new FfmpegOptions(optionsConfig);
 *
 * // Generate video encoder arguments for streaming.
 * const encoderOptions: VideoEncoderOptions = {
 *
 *   bitrate: 3000,
 *   fps: 30,
 *   hardwareDecoding: true,
 *   hardwareTranscoding: true,
 *   height: 1080,
 *   idrInterval: 2,
 *   inputFps: 30,
 *   level: H264Level.LEVEL4_0,
 *   profile: H264Profile.HIGH,
 *   smartQuality: true,
 *   width: 1920
 * };
 * const args = ffmpegOpts.streamEncoder(encoderOptions);
 *
 * // Generate crop filter string, if cropping is enabled.
 * const crop = ffmpegOpts.cropFilter;
 * ```
 *
 * @see AudioEncoderOptions
 * @see VideoEncoderOptions
 * @see FfmpegCodecs
 * @see {@link https://ffmpeg.org/ffmpeg.html | FFmpeg Documentation}
 *
 * @category FFmpeg
 */
export class FfmpegOptions {

  /**
   * The configuration options used to initialize this instance. This is the single stored state on `FfmpegOptions`: every other public field on this class is either
   * a getter that forwards to `this.config`, or a fixed constant independent of it (`audioDecoder`), so external callers have exactly one canonical path to each
   * config-backed value and internal code never has to keep a parallel field in sync with `config` at construction time.
   */
  public readonly config: FfmpegOptionsConfig;

  /**
   * Creates an instance of Homebridge FFmpeg encoding and decoding options.
   *
   * @param options          - FFmpeg options configuration.
   *
   * @example
   *
   * ```ts
   * const ffmpegOpts = new FfmpegOptions(optionsConfig);
   * ```
   */
  constructor(options: FfmpegOptionsConfig) {

    this.config = options;

    // Configure our hardware acceleration support.
    this.#configureHwAccel();
  }

  /**
   * The time source the callback timers of this session's processes are armed on, or `undefined` when the consumer configured none. Handed on unresolved, so each
   * primitive that arms a timer applies the `systemClock` default in the one place that default belongs.
   */
  public get clock(): Clock | undefined {

    return this.config.clock;
  }

  /**
   * Indicates if debug logging is enabled. Normalizes `undefined` to `false` so callers always see a definite boolean regardless of whether the config object set
   * the field explicitly.
   */
  public get debug(): boolean {

    return this.config.debug ?? false;
  }

  /**
   * Logging interface for output and errors.
   */
  public get log(): Logger {

    return this.config.log;
  }

  /**
   * Function returning the name for this options instance to be used for logging.
   */
  public get name(): () => string {

    return this.config.name;
  }

  // Internal alias for the config's codec capabilities, so class-internal code reads `this.#codecSupport.X` rather than the longer `this.config.codecSupport.X`. No
  // public exposure - external callers use `ffmpegOpts.config.codecSupport` as the single canonical path. The getter avoids duplicating state at construction: the
  // config object is the source of truth, and this accessor is a one-line forward.
  get #codecSupport(): FfmpegCodecs {

    return this.config.codecSupport;
  }

  /**
   * Determines and configures hardware-accelerated video decoding and transcoding for the host system.
   *
   * This internal method checks for the availability of hardware codecs and accelerators based on the host platform and updates
   * FFmpeg options to use the best available hardware or falls back to software processing when necessary.
   * It logs warnings or errors if required codecs or hardware acceleration are unavailable.
   *
   * This method is called automatically by the `FfmpegOptions` constructor and is not intended to be called directly.
   *
   * @example
   *
   * ```ts
   * // This method is invoked by the FfmpegOptions constructor:
   * const ffmpegOpts = new FfmpegOptions(optionsConfig);
   *
   * // Hardware acceleration configuration occurs automatically.
   * // Developers typically do not need to call configureHwAccel() directly.
   * ```
   *
   * @see FfmpegCodecs
   * @see FfmpegOptions
   */
  #configureHwAccel(): void {

    // Dispatch to the per-platform handler. Each handler captures its platform's complete hardware-setup story - capability validation, force-disable overrides,
    // platform-specific autopromotion - in one contiguous block, so interdependencies (raspbian's GPU-mem gate affecting both capabilities, QSV's transcoding ->
    // decoding autopromote) read locally rather than scattered across shared decoding / transcoding switches. The returned platform label decorates the final
    // "enabled" log line so readers can distinguish the variant at a glance without re-deriving it from the host system.
    let platformLabel = "";

    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        platformLabel = this.#configureMacOSHwAccel();

        break;

      case "raspbian":

        platformLabel = this.#configureRaspbianHwAccel();

        break;

      default:

        platformLabel = this.#configureQsvHwAccel();

        break;
    }

    // Inform the user. Only emits when some hardware capability ended up enabled - if every capability validation disabled both flags, we stay silent rather than
    // logging "enabled: (nothing)."
    if(this.config.hardwareDecoding || this.config.hardwareTranscoding) {

      this.log.info("\u26A1\uFE0F Hardware-accelerated " + this.#accelCategoriesLabel() + " enabled" + (platformLabel.length ? ": " + platformLabel : "") + ".");
    }

  }

  /**
   * Configure hardware acceleration for macOS (Apple Silicon and Intel Mac).
   *
   * Validates the VideoToolbox hardware accelerator when decoding is requested and the `h264_videotoolbox` encoder when transcoding is requested; disables the
   * corresponding flag if the validation fails. Additionally, when transcoding is requested, checks for the native macOS `aac_at` AAC encoder and warns (non-fatal) if
   * it is missing, since `audioEncoder` will fall back to `libfdk_aac` in that case.
   *
   * @returns An empty string - macOS has no platform-specific label for the "enabled" log line.
   */
  #configureMacOSHwAccel(): string {

    if(this.config.hardwareDecoding) {

      this.#validateHwAccel("videotoolbox");
    }

    if(this.config.hardwareTranscoding) {

      this.#validateEncoder("h264_videotoolbox");

      if(!this.#codecSupport.hasEncoder("aac", "aac_at")) {

        this.log.error("Your video processor does not have support for the native macOS AAC encoder, aac_at. Will attempt to use libfdk_aac instead.");
      }
    }

    return "";
  }

  /**
   * Configure hardware acceleration for Raspberry Pi.
   *
   * GPU memory is the umbrella gate, but only when hardware decoding is requested: if the advertised GPU-memory allocation is below `RPI4_GPU_MINIMUM`, both decoding
   * and transcoding are disabled with an info-level diagnostic (the Pi's hardware codec driver won't perform reliably below that threshold). A transcoding-only
   * request bypasses this check by design and does not consult GPU memory at all. When memory is sufficient, hardware decoding is still force-disabled because of an
   * unresolved FFmpeg 7 regression in the `h264_v4l2m2m` decoder, which fails to initialize on Raspberry Pi with current FFmpeg builds. Hardware transcoding is
   * validated against the `h264_v4l2m2m` encoder.
   *
   * @returns A descriptive label for the "enabled" log line when hardware transcoding was requested, noting that HKSV recordings still use software transcoding even
   *          when livestream transcoding runs on the hardware encoder. Empty string otherwise.
   */
  #configureRaspbianHwAccel(): string {

    if(this.config.hardwareDecoding) {

      // GPU-mem gate: insufficient memory disables every hardware capability. We run this only inside the decoding branch to preserve the legacy behavior where a
      // transcoding-only request on raspbian skipped the GPU-mem check; moving the gate to always-fire would change observable behavior for that configuration.
      if(this.#codecSupport.gpuMem < RPI4_GPU_MINIMUM) {

        this.log.info("Disabling hardware-accelerated %s. Adjust the GPU memory configuration on your Raspberry Pi to at least %s MB to enable it.",
          this.#accelCategoriesLabel(), RPI4_GPU_MINIMUM);

        this.config.hardwareDecoding = false;
        this.config.hardwareTranscoding = false;

        return "";
      }

      // FFmpeg 7+ introduced a regression in h264_v4l2m2m decoding on Raspberry Pi, so we force software decoding here until upstream resolves it. When the
      // FFmpeg regression is fixed, re-enable by validating the decoder availability and clearing this override.
      this.config.hardwareDecoding = false;
    }

    if(this.config.hardwareTranscoding) {

      this.#validateEncoder("h264_v4l2m2m");

      return "Raspberry Pi hardware acceleration will be used for livestreaming. " +
        "HomeKit Secure Video recordings are not supported by the hardware encoder and will use software transcoding instead";
    }

    return "";
  }

  /**
   * Configure hardware acceleration for Intel QSV (Quick Sync Video) and other generic hosts.
   *
   * Hardware decoding is never enabled by default on generic hosts - only when the transcoding path below autopromotes it on detection of the full QSV capability set
   * (`qsv` hwaccel + `h264_qsv` encoder + `h264_qsv` decoder + `hevc_qsv` decoder). If transcoding is requested but QSV isn't available, both flags fall back to
   * software.
   *
   * @returns `"Intel Quick Sync Video"` when QSV was autopromoted, an empty string otherwise.
   */
  #configureQsvHwAccel(): string {

    // Generic hosts never decode-on-demand - decoding is only enabled as a side effect of transcoding autopromoting it below.
    this.config.hardwareDecoding = false;

    if(this.config.hardwareTranscoding) {

      const qsvReady = this.#codecSupport.hasHwAccel("qsv") &&
        this.#codecSupport.hasDecoder("h264", "h264_qsv") && this.#codecSupport.hasEncoder("h264", "h264_qsv") &&
        this.#codecSupport.hasDecoder("hevc", "hevc_qsv");

      if(qsvReady) {

        this.config.hardwareDecoding = true;

        return "Intel Quick Sync Video";
      }

      // QSV not advertised - fall back to software for both capabilities so the final log stays silent about this instance.
      this.config.hardwareTranscoding = false;
    }

    return "";
  }

  // Shared validator: the requested hardware accelerator is advertised by the probe. Used only when hardware decoding is requested. On failure, logs the miss at error
  // level and flips `hardwareDecoding` to false so downstream encoders transparently fall back to software.
  #validateHwAccel(accel: string): boolean {

    if(this.#codecSupport.hasHwAccel(accel)) {

      return true;
    }

    this.log.error("Unable to enable hardware-accelerated decoding. Your video processor does not have support for the " + accel + " hardware accelerator. " +
      "Using software decoding instead.");

    this.config.hardwareDecoding = false;

    return false;
  }

  // Shared validator: the requested H.264 encoder is advertised by the probe. Used when hardware transcoding is requested. On failure, logs the miss at error level
  // and flips `hardwareTranscoding` to false so streamEncoder and friends transparently fall back to libx264.
  #validateEncoder(codec: string): boolean {

    if(this.#codecSupport.hasEncoder("h264", codec)) {

      return true;
    }

    this.log.error("Unable to enable hardware-accelerated transcoding. Your video processor does not have support for the " + codec + " encoder. " +
      "Using software transcoding instead.");

    this.config.hardwareTranscoding = false;

    return false;
  }

  // Human-readable "X and Y" label for the capabilities currently enabled - used in the final "enabled" log line and the raspbian GPU-mem warning. Consults the live
  // `this.config.hardwareDecoding` / `hardwareTranscoding` values so callers can invoke it before, during, or after the per-platform configuration reshuffles them.
  #accelCategoriesLabel(): string {

    const categories: string[] = [];

    if(this.config.hardwareDecoding) {

      categories.push("decoding");
    }

    if(this.config.hardwareTranscoding) {

      categories.push("\u26ED\uFE0E transcoding");
    }

    return categories.join(" and ");
  }

  /**
   * Whether the host's hardware decoder can take a source of the given codec. The pipeline resolver folds this answer into the resolved `hardwareDecoding`, so a source
   * the hardware cannot take decodes in software on both sides of the pipeline at once: the decoder emits no hardware args, and the encoder's chain uploads the frames
   * it then receives in system memory.
   *
   * H.264 and HEVC decode on every supported hardware platform. AV1 needs one of:
   *
   *   1. **Apple Silicon M3 or newer** (`cpuGeneration >= 3`) with **FFmpeg 8.0 or newer**. M3 is the first Apple silicon generation to ship AV1 hardware decode, Intel
   *      Macs never had it, and FFmpeg added the VideoToolbox AV1 decoder in its 8.0 release. macOS Sonoma 14.4 or newer is also required at the OS level; it is not
   *      represented in our capability model and is assumed whenever the silicon and FFmpeg requirements hold.
   *   2. **Intel 11th-generation silicon or newer** (`cpuGeneration >= 11`) on Quick Sync.
   *
   * A codec outside the supported set never decodes on hardware.
   *
   * @param codec - The source's codec, as the caller spelled it.
   * @returns `true` when the host's hardware decoder can take the codec, `false` when the source decodes in software.
   */
  #hardwareDecodes(codec: string): boolean {

    const canonical = canonicalDecodeCodec(codec);

    if(!canonical) {

      return false;
    }

    if(canonical !== "av1") {

      return true;
    }

    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":

        return (this.#codecSupport.cpuGeneration >= 3) && this.#codecSupport.ffmpegAtLeast(8);

      case "macOS.Intel":
      case "raspbian":

        return false;

      default:

        return this.#codecSupport.cpuGeneration >= 11;
    }
  }

  /**
   * Whether a pipeline's decoded frames live on the GPU. They stay there exactly when a hardware decoder feeds a hardware encode whose chain runs on the GPU from its
   * first filter: no crop is configured and the chain scales on the GPU. The GPU is then the next consumer, so keeping the frames there spares a download and an upload
   * per frame. Everywhere else the decoder hands frames over in system memory in the stream's own format - 8-bit and 10-bit alike - because a CPU-side filter or a
   * software encoder is the next consumer and no download filter can name a format that fits every stream.
   *
   * Crop is that CPU-side filter whenever it is configured. On a GPU frame FFmpeg's crop only records the region in the frame's metadata, which neither scale_vt nor
   * vpp_qsv reads, so VideoToolbox would ignore the crop and Quick Sync would cut the cropped size from the frame's top-left corner rather than the configured offset.
   * With the frames in system memory crop cuts the region itself, and the chain uploads the cropped frames to the GPU scaler exactly as it does for a software decode.
   *
   * This one answer decides whether the decode args ask the decoder for GPU output (`-hwaccel_output_format`), whether the chain uploads, and whether the encode side
   * initializes a device for that upload, so the decode and encode sides of a pipeline cannot disagree about where its frames are.
   *
   * @param state - The pipeline's resolved state.
   * @returns `true` when the decoded frames stay on the GPU, `false` when they are handed over in system memory.
   */
  #decodedFramesOnGpu(state: PipelineStateView): boolean {

    return state.hardwareDecoding && state.hardwareTranscoding && !this.config.crop && this.#scalesOnGpu(state);
  }

  /**
   * Whether a hardware encode's chain scales on the GPU.
   *
   * Quick Sync's scaler always does: it takes an output format, so it hands its frames on in the transfer format, which both the encoder and a download ahead of caller
   * filters can take whatever the source's bit depth. VideoToolbox's scaler does on FFmpeg 8 and newer unless caller filters follow it. scale_vt takes no output-format
   * option, so its output keeps the format of the frames context it was handed, which is p010 for a 10-bit source decoded on the GPU. The VideoToolbox encoder takes
   * those frames and encodes them to 8-bit H.264 itself, but no download fixed to one format can bring them back to system memory. A chain with caller filters
   * therefore runs on the CPU instead, from the decoder's handover through the software scaler and the caller's filters to the upload that closes it, which serves
   * every bit depth. Before FFmpeg 8, VideoToolbox chains always scale in software, and Raspberry Pi has no GPU scaler.
   *
   * @param state - The pipeline's resolved state.
   * @returns `true` when the chain's scaler runs on the GPU, `false` when it runs on the CPU.
   */
  #scalesOnGpu(state: PipelineStateView): boolean {

    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        return this.#codecSupport.ffmpegAtLeast(8) && !state.videoFilters.length;

      case "raspbian":

        return false;

      default:

        return true;
    }
  }

  /**
   * Determines the hardware transfer filters a pipeline needs on the way to its encoder.
   *
   * Frames need to move only when the encoder runs on the GPU and the decoded frames do not live there - a software decode, or a hardware decode whose chain crops or
   * scales on the CPU - so the one transfer this ever emits is an upload. A hardware decode feeding a software encode needs none, because its decoder hands frames
   * over in system memory. Where the upload sits is the chain's call: ahead of a GPU scaler, or at the tail of a chain that runs on the CPU.
   *
   * @param options - The pipeline's resolved state. Callers pass either a full `ResolvedVideoEncoderOptions` (structurally assignable) or the view the resolver
   *                  returns - whichever is natural at the call site.
   * @returns Array of filter strings for the upload, or an empty array when frames are already where the encoder needs them.
   */
  #getHardwareTransferFilters(options: PipelineStateView): string[] {

    if(!options.hardwareTranscoding || this.#decodedFramesOnGpu(options)) {

      return [];
    }

    // We need to upload frames from system memory to the GPU for hardware encoding.
    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        // FFmpeg 8.x on macOS requires explicit upload when moving frames from system memory to VideoToolbox encoding. We convert to the transfer format before
        // uploading, so the frames context carries it rather than whatever format the frames arrived in - yuv420p from a software decoder, or a 10-bit format from a
        // 10-bit source, which becomes 8-bit here. nv12 is VideoToolbox's native layout, so the upload itself costs no extra conversion.
        return this.#codecSupport.ffmpegAtLeast(8) ? [ "format=" + GPU_TRANSFER_PIXEL_FORMAT, "hwupload" ] : [];

      case "raspbian":

        // The Raspberry Pi hardware encoder prefers being fed the ubiquitous yuv420p.
        return ["format=yuv420p"];

      default:

        return ["hwupload"];
    }
  }

  /**
   * Gets hardware device initialization options for encoders that need them.
   *
   * A chain that uploads needs a hardware device for its upload, so whenever frames reach a hardware encode from system memory we initialize the device context
   * explicitly and name it for the filter graph. This method provides the platform-specific initialization arguments required by FFmpeg.
   *
   * @param options - The pipeline's resolved state. The helper accepts either a full `ResolvedVideoEncoderOptions` or the view the resolver returns.
   * @returns Array of FFmpeg arguments for hardware device initialization.
   */
  #getHardwareDeviceInit(options: PipelineStateView): string[] {

    // Only initialize a hardware device when we encode on hardware from frames in system memory, which is exactly when the chain uploads. That includes a hardware
    // decode that hands its frames over in system memory: the upload cannot borrow the decoder's device, and without one of its own the filter graph fails to start.
    // When the decoded frames stay on the GPU, the decoder's own device context carries them through the chain to the encoder.
    if(options.hardwareTranscoding && !this.#decodedFramesOnGpu(options)) {

      switch(this.#codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // Unfortunately, versions of FFmpeg prior to 8.0 don't properly support VideoToolbox use cases like this.
          if(!this.#codecSupport.ffmpegAtLeast(8)) {

            break;
          }

          // Initialize VideoToolbox hardware context and assign it a name for use in filter chains.
          //
          // -init_hw_device               Initialize our hardware accelerator and assign it a name to be used in the FFmpeg command line.
          // -filter_hw_device             Specify the hardware accelerator to be used with our video filter pipeline.
          return [ "-init_hw_device", "videotoolbox=hw", "-filter_hw_device", "hw" ];

        case "raspbian":

          // We don't need to initialize anything on Raspbian.
          break;

        default:

          // Initialize Intel Quick Sync Video hardware context.
          //
          // -init_hw_device               Initialize our hardware accelerator and assign it a name to be used in the FFmpeg command line.
          // -filter_hw_device             Specify the hardware accelerator to be used with our video filter pipeline.
          return [ "-init_hw_device", "qsv=hw", "-filter_hw_device", "hw" ];
      }
    }

    return [];
  }

  /**
   * Returns the audio encoder arguments to use when transcoding.
   *
   * @param options  - Optional. The encoder options to use for generating FFmpeg arguments.
   * @returns Array of FFmpeg command-line arguments for audio encoding.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.audioEncoder();
   * ```
   */
  public audioEncoder(options: AudioEncoderOptions = {}): string[] {

    // Resolve the codec default here so every handler sees the same canonicalized shape. Matching the pattern used by `streamEncoder` and `videoDecoder`: the public
    // method is pure normalization plus dispatch; each per-platform handler owns its own arg-emission story.
    const resolved: AudioEncoderOptions = { codec: AudioRecordingCodecType.AAC_ELD, ...options };

    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        return this.#macOSAudioEncoderArgs(resolved);

      default:

        return this.#defaultAudioEncoderArgs(resolved);
    }
  }

  /**
   * Emit audio-encode args for macOS, preferring the AudioToolbox native encoder (`aac_at`) when advertised. Falls back to `defaultAudioEncoderArgs` when `aac_at` is
   * unavailable, which typically means using libfdk_aac. Matches the per-platform handler pattern used throughout the class.
   *
   * @param options - Resolved audio encoder options with the codec field defaulted.
   * @returns The macOS-appropriate audio-encoder args, or the default fallback when `aac_at` is missing.
   */
  #macOSAudioEncoderArgs(options: AudioEncoderOptions): string[] {

    if(!this.#codecSupport.hasEncoder("aac", "aac_at")) {

      return this.#defaultAudioEncoderArgs(options);
    }

    // aac_at is the macOS audio encoder API.
    //
    // -codec:a aac_at                  Use the aac_at encoder on macOS.
    // -aac_at_mode cbr                 Constant-bitrate mode for AAC_ELD - HomeKit event recording is strict about rate, so a steady bitrate is what it wants.
    // -aac_at_mode vbr + -q:a 2        Variable-bitrate mode for AAC_LC, letting the encoder optimize audio within the requested bitrate envelope.
    const args = [ "-codec:a", "aac_at" ];

    switch(options.codec) {

      case AudioRecordingCodecType.AAC_ELD:

        args.push("-aac_at_mode", "cbr");

        break;

      case AudioRecordingCodecType.AAC_LC:
      default:

        args.push("-aac_at_mode", "vbr", "-q:a", "2");

        break;
    }

    return args;
  }

  /**
   * Emit audio-encode args for the default (non-macOS) path using `libfdk_aac`. Returns `[]` when libfdk_aac is not advertised, which is effectively fatal for audio -
   * the caller will have no audio encoder to feed FFmpeg. This is the "essentially dead in the water" outcome we document at the call sites.
   *
   * @param options - Resolved audio encoder options with the codec field defaulted.
   * @returns The libfdk_aac-based audio-encoder args, or `[]` when libfdk_aac is unavailable.
   */
  #defaultAudioEncoderArgs(options: AudioEncoderOptions): string[] {

    if(!this.#codecSupport.hasEncoder("aac", "libfdk_aac")) {

      return [];
    }

    // FFmpeg doesn't natively support AAC-ELD, so libfdk_aac is our cross-platform choice.
    //
    // -codec:a libfdk_aac              Use the libfdk_aac encoder.
    // -afterburner 1                   Increases audio quality at the expense of a small CPU overhead in libfdk_aac.
    // -vbr 4                           Variable-bitrate mode 4, added only for AAC_LC. AAC_ELD stays at the library default (CBR).
    const args = [ "-codec:a", "libfdk_aac", "-afterburner", "1" ];

    if(options.codec !== AudioRecordingCodecType.AAC_ELD) {

      args.push("-vbr", "4");
    }

    return args;
  }

  /**
   * The fixed FFmpeg audio decoder used when decoding.
   */
  public readonly audioDecoder: string = "libfdk_aac";

  /**
   * Returns the video decoder arguments to use for decoding video.
   *
   * Whether the decoder runs on hardware and where it leaves its frames depend on the whole pipeline - the source's codec, the hardware flags, and what consumes the
   * frames next - so the decode args are built from the same pipeline description as the rest of the pipeline. The design rule is one object per pipeline, handed to
   * every builder: a caller passes `videoDecoder` the very options object it gives `streamEncoder` or `recordEncoder`, and the decode and encode sides then cannot
   * disagree about where the frames are. A pipeline that decodes on hardware and encodes on hardware keeps its frames on the GPU wherever its chain scales there. One
   * that decodes on hardware and encodes in software - a snapshot, say, which passes `{ hardwareTranscoding: false, inputCodec }` - receives them in system memory, in
   * the stream's own format, and so does a VideoToolbox pipeline whose caller-supplied filters run its chain on the CPU. A source the host's hardware decoder cannot
   * take decodes in software, and the encoder side of the same pipeline uploads the frames it receives.
   *
   * @param options - Optional. The pipeline's description - typically the `VideoEncoderOptions` the caller hands its encoder. Its source codec, its hardware flags, and
   *                  its caller-supplied filters decide whether the decoder runs on hardware and where it leaves its frames. Each flag resolves exactly as the encoders
   *                  resolve it: an omitted flag takes the class config's value, and a flag the class config has turned off stays off. Omitting the object entirely
   *                  describes an H.264 source in the pipeline the class config describes, with no caller filters.
   * @returns Array of FFmpeg command-line arguments for video decoding, or an empty array when the pipeline decodes in software.
   *
   * @example
   *
   * ```ts
   * // A livestream: the decoder and the encoder read one pipeline description, source codec included.
   * const args = [ ...ffmpegOpts.videoDecoder(encoderOptions), ...ffmpegOpts.streamEncoder(encoderOptions) ];
   *
   * // A snapshot, encoded in software: the decoder hands its frames over in system memory.
   * const snapshotArgs = ffmpegOpts.videoDecoder({ hardwareTranscoding: false, inputCodec: "hevc" });
   * ```
   */
  public videoDecoder(options: Pick<VideoEncoderOptions, "hardwareDecoding" | "hardwareTranscoding" | "inputCodec" | "videoFilters"> = {}): string[] {

    const state = this.#resolvePipelineState(options);
    const codec = canonicalDecodeCodec(state.inputCodec);

    // Hardware decoding is an all-or-nothing gate for the pipeline. The resolver has already turned it off when the caller opted out, when configureHwAccel disabled it
    // on this host, or when the host's hardware decoder cannot take the source's codec, and FFmpeg then falls through to software decoding transparently. A codec
    // outside the supported set resolves it off too; testing the canonical codec here is what hands the handlers the narrowed codec.
    if(!state.hardwareDecoding || !codec) {

      return [];
    }

    // Dispatch to the platform handler. Each handler owns its platform's arg shape and codec-specific mappings. The single switch here is the only place that knows
    // "which handler for which platform."
    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        return this.#macOSHardwareDecodeArgs(state);

      case "raspbian":

        return this.#raspbianHardwareDecodeArgs();

      default:

        return this.#qsvHardwareDecodeArgs(codec, state);
    }
  }

  /**
   * Emit hardware-decode args for the macOS VideoToolbox path. The codec gate has already run in the pipeline resolver (see `hardwareDecodes`), so a source that reaches
   * this handler is one VideoToolbox can decode.
   *
   * @param state - The pipeline's resolved state, which decides whether the decoder keeps its frames on the GPU.
   * @returns The VideoToolbox decoder args.
   */
  #macOSHardwareDecodeArgs(state: PipelineStateView): string[] {

    // -hwaccel videotoolbox           Select VideoToolbox for hardware-accelerated decoding on macOS.
    // -hwaccel_output_format ...      Keep the decoded frames on the GPU, emitted only when the pipeline's encoder runs there too, no crop is configured, and its chain
    //                                 scales on the GPU, which also confines it to FFmpeg 8.x. Without it, the decoder hands frames over in system memory in the stream's
    //                                 own format.
    return [

      "-hwaccel", "videotoolbox",
      ...(this.#decodedFramesOnGpu(state) ? [ "-hwaccel_output_format", "videotoolbox_vld" ] : [])
    ];
  }

  /**
   * Emit hardware-decode args for the Intel QSV path. The codec gate has already run in the pipeline resolver (see `hardwareDecodes`), so a source that reaches this
   * handler is one the silicon can decode.
   *
   * @param codec - The canonicalized codec, already narrowed by `videoDecoder` to one of the supported decode codecs.
   * @param state - The pipeline's resolved state, which decides whether the decoder keeps its frames on the GPU.
   * @returns The QSV decoder args.
   */
  #qsvHardwareDecodeArgs(codec: SupportedDecodeCodec, state: PipelineStateView): string[] {

    // -hwaccel qsv                    Select Quick Sync Video for hardware-accelerated decoding.
    // -hwaccel_output_format qsv      Keep frames on the GPU across the filter chain to avoid a needless download+upload round trip, emitted only when the pipeline's
    //                                 encoder runs on the GPU too and no crop is configured. Without it, the decoder hands frames over in system memory in the stream's
    //                                 own format.
    // -codec:v <codec>_qsv            Select the specific QSV decoder for the requested codec. The `SupportedDecodeCodec` narrowing makes this lookup total at the
    //                                 type level, so no runtime fallback is required.
    return [

      "-hwaccel", "qsv",
      ...(this.#decodedFramesOnGpu(state) ? [ "-hwaccel_output_format", "qsv" ] : []),
      "-codec:v", QSV_DECODER_BY_CODEC[codec]
    ];
  }

  /**
   * Emit hardware-decode args for the Raspberry Pi V4L2 path.
   *
   * Currently returns `[]` unconditionally. The h264_v4l2m2m decoder is broken on FFmpeg 7+ and remains disabled pending an upstream fix; FFmpeg then falls back to
   * software decode. When upstream resolves the decoder regression, this method is the single place to lift the block.
   *
   * @returns An empty array.
   */
  #raspbianHardwareDecodeArgs(): string[] {

    return [];
  }

  /**
   * Returns the FFmpeg crop filter string, or a default no-op filter if cropping is disabled.
   *
   * @returns The crop filter string for FFmpeg.
   */
  public get cropFilter(): string {

    // If we haven't enabled cropping, tell the crop filter to do nothing. FFmpeg's crop filter clamps a width or height expression that exceeds the input
    // frame's own dimension down to that dimension, so a width and height of a hundred times the frame - far beyond anything the input can be - clamps back
    // down to the frame's actual size and the filter passes every frame through untouched.
    if(!this.config.crop) {

      return "crop=w=iw*100:h=ih*100:x=iw*0:y=ih*0";
    }

    // Generate our crop filter based on what the user has configured.
    return "crop=" + [

      "w=iw*" + this.config.crop.width.toString(),
      "h=ih*" + this.config.crop.height.toString(),
      "x=iw*" + this.config.crop.x.toString(),
      "y=ih*" + this.config.crop.y.toString()
    ].join(":");
  }

  // Conditional splice of the crop filter into a larger filter chain: an array with the filter when cropping is enabled, an empty array otherwise. Both the software
  // (`defaultVideoEncoderOptions`) and hardware (`hardwareFilterChain`) paths inline this splice - centralizing it here keeps "do we emit a crop filter" a one-line
  // decision. Returning a readonly array so callers can only splice, not mutate.
  get #cropFilterSegment(): readonly string[] {

    return this.config.crop ? [this.cropFilter] : [];
  }

  /**
   * Compose the filter chain of a hardware encode, from the configured crop through the caller-supplied filters. Crop leads because it is a CPU-side filter and the
   * scaler must see the cropped region, and the caller's filters follow the scaler. Where the frames start is the residency predicate's answer (see
   * `decodedFramesOnGpu`), which keeps them in system memory whenever crop is configured, and where they cross between system memory and the GPU after that follows
   * from where the chain scales (see `scalesOnGpu`). A chain that scales on the GPU uploads ahead of its scaler when its frames reach it in system memory, and on Quick
   * Sync downloads after it when caller filters follow. A chain that scales on the CPU runs every filter in system memory, and the upload, where the platform has one,
   * closes it. The caller's filters therefore need no bridge of their own.
   *
   * Every HomeKit stream is 8-bit H.264, so each chain also decides where a 10-bit source becomes 8-bit. The Quick Sync scaler and the VideoToolbox upload fix the
   * transfer format, and Raspberry Pi's conversion fixes yuv420p. A chain that hands VideoToolbox its frames without fixing a format relies on the encoder, which
   * converts GPU frames of any depth itself and takes only 8-bit formats from system memory, so FFmpeg converts those on the way in.
   */
  #hardwareFilterChain(options: ResolvedVideoEncoderOptions): string[] {

    // Determine the target dimensions for our scale operation. We maintain aspect ratio while ensuring the output doesn't exceed the requested height.
    const targetHeight = options.height.toString();
    const upload = this.#getHardwareTransferFilters(options);

    // Our default software scaler.
    //
    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   divisible by two.
    // in_range/out_range=auto           Let FFmpeg infer the input and output color ranges rather than forcing a conversion.
    const swScale = "scale=-2:min(ih\\, " + targetHeight + "):in_range=auto:out_range=auto";

    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        if(this.#scalesOnGpu(options)) {

          // On macOS with FFmpeg 8.x, we can use the VideoToolbox scaler (scale_vt) which provides hardware-accelerated scaling. This is significantly more efficient
          // than software scaling and can handle higher throughput with lower CPU usage. Prior to FFmpeg 8.0, this would break under a variety of scenarios and was
          // unreliable. scale_vt runs on the GPU and hands its output straight to the encoder.
          return [ ...this.#cropFilterSegment, ...upload, "scale_vt=-2:min(ih\\, " + targetHeight + ")" ];
        }

        // The chain runs on the CPU. The decoder hands its frames over in system memory, we scale in software, the caller's filters follow, and on FFmpeg 8.x the
        // upload closes the chain.
        return [ ...this.#cropFilterSegment, swScale, ...options.videoFilters, ...upload ];

      case "raspbian":

        // Raspberry Pi uses the standard software scaler. Hardware scaling capabilities vary by model, so we use the reliable software path.
        return [ ...this.#cropFilterSegment, ...upload, swScale, ...options.videoFilters ];

      default:

        // When using Intel Quick Sync Video, we execute GPU-accelerated operations using the vpp_qsv post-processing filter. When caller filters follow, a download after
        // it brings its output back to system memory.
        //
        // format=nv12                   Hand the frames on in the transfer format, whatever the source's bit depth. The Quick Sync H.264 encoder takes only 8-bit
        //                               frames, and the download ahead of caller filters can only emit the format the scaler produced.
        // w=...:h...                    Scale the video to the size that's being requested while respecting aspect ratios.
        return [

          ...this.#cropFilterSegment,
          ...upload,
          "vpp_qsv=" + [ "format=" + GPU_TRANSFER_PIXEL_FORMAT, "w=min(iw\\, (iw / ih) * " + targetHeight + ")", "h=min(ih\\, " + targetHeight + ")" ].join(":"),
          ...(options.videoFilters.length ? [ "hwdownload", "format=" + GPU_TRANSFER_PIXEL_FORMAT ] : []),
          ...options.videoFilters
        ];
    }
  }

  // Generates the default set of FFmpeg video encoder arguments for software transcoding using libx264. Builds command-line options based on the provided encoder
  // options - bitrate, H.264 profile and level, pixel format, frame rate, buffer size, and optional smart quality settings. Used internally when hardware-accelerated
  // transcoding is not enabled or supported; reachable from outside only through the public `streamEncoder` / `recordEncoder` dispatchers.
  #defaultVideoEncoderOptions(options: ResolvedVideoEncoderOptions): string[] {

    const videoFilters = [];

    // fps=                              Use the fps filter to provide the frame rate requested by HomeKit. We only need to apply this filter if our input and output
    //                                   frame rates aren't already identical.
    const fpsFilter = ["fps=" + options.fps.toString()];

    // Build our pixel-level filter chain. The universal rule across every encoder path in this class is that `crop` is a CPU-side filter and must operate on
    // frames in system memory. A software encode never transfers: a hardware decoder feeding it hands its frames over in system memory, so the whole chain runs on
    // the CPU from its first filter.
    //
    // crop=...                          Applied when `config.crop` is set. Uses relative iw/ih multipliers so the crop rectangle scales with source resolution;
    //                                   sized against the source frame and feeds the cropped region into the scaler so aspect-ratio math reflects the crop.
    // scale=-2:min(ih\,height)          Scale to HomeKit's requested dimensions while respecting aspect ratios and ensuring final dimensions divisible by two.
    const pixelFilters: string[] = [

      ...this.#cropFilterSegment,
      "scale=-2:min(ih\\, " + options.height.toString() + "):in_range=auto:out_range=auto"
    ];

    // Let's assemble our filter collection. If we're reducing our framerate, we want to frontload the fps filter so the downstream filters need to do less work. If we're
    // increasing our framerate, we want to do pixel operations on the minimal set of source frames that we need, since we're just going to duplicate them.
    if(options.fps < options.inputFps) {

      videoFilters.push(...fpsFilter, ...pixelFilters);
    } else {

      videoFilters.push(...pixelFilters, ...(options.fps > options.inputFps ? fpsFilter : []));
    }

    // The caller's filters go at the tail. This libx264 chain is CPU-resident at its tail, so they need no download transfer bridged in ahead of them.
    videoFilters.push(...options.videoFilters);

    // Default to the tried-and-true libx264. We use the following options by default:
    //
    // -codec:v libx264                  Use the excellent libx264 H.264 encoder.
    // -preset veryfast                  Use the veryfast encoding preset in libx264, which provides a good balance of encoding speed and quality.
    // -profile:v                        Use the H.264 profile that HomeKit is requesting when encoding.
    // -level:v                          Use the H.264 profile level that HomeKit is requesting when encoding.
    // -pix_fmt yuv420p                  Encode 8-bit 4:2:0. libx264 also takes 10-bit input, and a 10-bit source it was handed as-is would need a bit depth no profile
    //                                   HomeKit requests can carry. FFmpeg folds the conversion into the chain's scaler, so an 8-bit yuv420p source pays nothing for it.
    // -noautoscale                      Don't attempt to scale the video stream automatically.
    // -bf 0                             Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
    // -filter:v                         Crop and scale the video to the size we want while respecting aspect ratios and ensuring our final dimensions are divisible
    //                                   by two.
    // -g:v                              Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
    //                                   livestreaming experience.
    // -bufsize size                     This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate                  The maximum bitrate tolerance, used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to
    //                                   allow encoders some variation in order to maximize quality while honoring bandwidth constraints.
    const encoderOptions = [

      "-codec:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", this.#getH264Profile(options.profile),
      "-level:v", this.#getH264Level(options.level),
      "-pix_fmt", "yuv420p",
      "-noautoscale",
      "-bf", "0",
      "-filter:v", videoFilters.join(", "),
      "-g:v", gopArg(options),
      "-bufsize", bufsizeArg(options),
      "-maxrate", maxrateArg(options)
    ];

    // Using libx264's constant rate factor mode produces generally better results across the board. We use a capped CRF approach, allowing libx264 to
    // make intelligent choices about how to adjust bitrate to achieve a certain quality level depending on the complexity of the scene being encoded, but
    // constraining it to a maximum bitrate to stay within the bandwidth constraints HomeKit is requesting.
    if(options.smartQuality) {

      // -crf 20                         Use a constant rate factor of 20, to allow libx264 the ability to vary bitrates to achieve the visual quality we
      //                                 want, constrained by our maximum bitrate.
      encoderOptions.push("-crf", "20");
    } else {

      // For recording HKSV, we really want to maintain a tight rein on bitrate and don't want to freelance with perceived quality for two reasons - HKSV
      // is very latency sensitive and it's also very particular about bitrates and the specific format of the stream it receives. The second reason is that
      // HKSV typically requests bitrates of around 2000kbps, which results in a reasonably high quality recording, as opposed to the typical 2-300kbps
      // that livestreaming from the Home app itself generates. Those lower bitrates in livestreaming really benefit from the magic that using a good CRF value
      // can produce in libx264.
      encoderOptions.push("-b:v", bitrateArg(options));
    }

    return encoderOptions;
  }

  /**
   * Returns the video encoder options to use for HomeKit Secure Video (HKSV) event recording.
   *
   * @param options          - Encoder options to use.
   * @returns Array of FFmpeg command-line arguments for video encoding.
   */
  public recordEncoder(options: VideoEncoderOptions): string[] {

    // HKSV is strict about bitrates and format, so smart quality is always disabled for recordings. Every other concern - default merging, clamping hardware flags
    // against the resolved class config, dispatch to the per-platform handler - is identical to the livestream path. The shape below reflects that: `recordEncoder`
    // overrides smartQuality, then flows through the same machinery as `streamEncoder`. Raspberry Pi is a platform-specific divergence - its hardware v4l2m2m
    // encoder is unreliable for HKSV event recording, so we fall back to libx264 regardless of the resolved `hardwareTranscoding` flag. On every other platform the
    // streaming dispatcher handles the rest.
    const recordingInput: VideoEncoderOptions = { ...options, smartQuality: false };

    // Recording falls back to software wherever it can't use the hardware encoder (Raspberry Pi today). This is the same predicate maxSourcePixels("record") consults, so
    // the encoder choice and the source ceiling are guaranteed consistent and evolve together when the upstream v4l2m2m regression is fixed.
    if(!this.hardwareEncodes("record")) {

      return this.#defaultVideoEncoderOptions(this.#resolveEncoderOptions(recordingInput));
    }

    return this.streamEncoder(recordingInput);
  }

  /**
   * Returns the video encoder options to use when transcoding for livestreaming.
   *
   * @param options          - Encoder options to use.
   * @returns Array of FFmpeg command-line arguments for video encoding.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.streamEncoder(encoderOptions);
   * ```
   */
  public streamEncoder(options: VideoEncoderOptions): string[] {

    const resolved = this.#resolveEncoderOptions(options);

    // Software-only path. libx264 has its own filter-chain story (crop, scale, and its 8-bit input format) and is self-contained in defaultVideoEncoderOptions.
    if(!resolved.hardwareTranscoding) {

      return this.#defaultVideoEncoderOptions(resolved);
    }

    // Hardware path. Pre-compute shared state once and dispatch to the per-platform handler. Each handler owns its platform's full encoder story: codec selection,
    // profile encoding (string vs. numeric), level override, bitrate / quality-mode fork (-q:v / -b:v / -global_quality), and any platform-specific flags like
    // -allow_sw / -realtime / -reset_timestamps. The dispatcher prepends the init-device args so that concern lives in one place.
    const context = this.#hardwareStreamContext(resolved);

    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":

        return [ ...context.init, ...this.#macOSAppleStreamEncoderArgs(resolved, context) ];

      case "macOS.Intel":

        return [ ...context.init, ...this.#macOSIntelStreamEncoderArgs(resolved, context) ];

      case "raspbian":

        return [ ...context.init, ...this.#raspbianStreamEncoderArgs(resolved, context) ];

      default:

        return [ ...context.init, ...this.#qsvStreamEncoderArgs(resolved, context) ];
    }
  }

  /**
   * Merge the caller's encoder options with our defaults and clamp the hardware flags against the resolved class config. This is the single source of truth for "what
   * hardware state does this call run in" - every public encoder method flows its input through here before dispatching, so no downstream handler ever sees unresolved
   * or unclamped values. The helper is stable under repeat application: a resolved options object passed back through this helper produces an identical result,
   * which makes safe the `recordEncoder` -> `streamEncoder` delegation chain.
   *
   * Each resolver-guaranteed field is computed with one formula:
   *
   *   `resolved = (caller ?? classDefault) && clamp`
   *
   * `??` coalesces undefined (whether from omission or explicit-undefined spread) to the class default; `&&` then clamps against the resolved class capability so a
   * caller can only ever downgrade a flag, never upgrade one, and hardware decoding is clamped by the codec gate as well. `smartQuality` has no class-level counterpart
   * and no clamp - it defaults to `true` when the caller omits it and passes through otherwise. `inputCodec` and `videoFilters` likewise have no clamp - the shared
   * pipeline resolver defaults the codec to H.264 and normalizes the filters to an empty array on omission, so downstream code always reads definite values and never
   * re-derives an undefined guard. The result satisfies `Required<Pick<...>>` at the type level *and* at runtime because the formula produces a concrete value on
   * every branch; there is no code path that can leave a resolver-guaranteed field undefined.
   *
   * @param options - The caller-supplied encoder options.
   * @returns A resolved options object with defaults filled in and hardware flags clamped against the resolved class config. The resolver-guaranteed fields
   *          (`hardwareDecoding`, `hardwareTranscoding`, `inputCodec`, `smartQuality`, `videoFilters`) are narrowed to `Required` in the return type so downstream
   *          handlers see definite booleans, a definite codec, and a definite `readonly string[]`.
   */
  #resolveEncoderOptions(options: VideoEncoderOptions): ResolvedVideoEncoderOptions {

    return {

      ...options,
      ...this.#resolvePipelineState(options),
      smartQuality: options.smartQuality ?? true
    };
  }

  /**
   * Resolve a pipeline's state against the class config. The one resolution every builder applies - the encoders through `resolveEncoderOptions` and the decoder
   * through `videoDecoder` - so the decode and encode sides of a pipeline handed the same object always read the same state. Each hardware flag takes one formula:
   *
   *   `resolved = (caller ?? classDefault) && clamp`
   *
   * and hardware decoding is further clamped by the codec gate (see `hardwareDecodes`), so the resolved flag says whether the decoder actually runs on hardware for this
   * source. The source's codec defaults to H.264, and the caller filters, which on VideoToolbox decide where the decoder hands its frames over, normalize to an empty
   * array on omission.
   *
   * @param options - The caller's hardware flags, source codec, and caller filters, any of which may be omitted.
   * @returns The resolved view: each flag a definite boolean a caller can only ever have downgraded from the class config, never upgraded, a definite source codec, and
   *          a definite filter list.
   */
  #resolvePipelineState(options: Pick<VideoEncoderOptions, "hardwareDecoding" | "hardwareTranscoding" | "inputCodec" | "videoFilters">): PipelineStateView {

    const inputCodec = options.inputCodec ?? "h264";

    return {

      hardwareDecoding: (options.hardwareDecoding ?? this.config.hardwareDecoding) && this.config.hardwareDecoding && this.#hardwareDecodes(inputCodec),
      hardwareTranscoding: (options.hardwareTranscoding ?? this.config.hardwareTranscoding) && this.config.hardwareTranscoding,
      inputCodec,
      videoFilters: options.videoFilters ?? []
    };
  }

  /**
   * Pre-compute the shared state every hardware-stream encoder path consumes. Having this in a dedicated helper keeps each per-platform handler a pure function of
   * `(options, context)`, with the shared computation centralized in exactly one place rather than duplicated inline at the start of every branch.
   *
   * - `bufsize`, `gop`, `maxrate` are the pre-formatted rate-control strings every hardware handler splices directly into its `-bufsize` / `-g:v` / `-maxrate` args.
   *   Sourced from the module-scope `bufsizeArg` / `gopArg` / `maxrateArg` helpers so the software and hardware paths share one derivation of each.
   * - `filterChain` is the comma-joined `-filter:v` value: crop first when configured (CPU-side filter), then the platform's scaler with whatever transfers put the
   *   frames where each step needs them, and the caller's `videoFilters` after the scaler; see `hardwareFilterChain`.
   * - `frameRateArg` materializes the `...(fps !== inputFps ? ["-r", fps] : [])` conditional once so every handler can splat it directly.
   * - `init` is the platform-specific hardware-device init args (`-init_hw_device` / `-filter_hw_device`, emitted whenever the chain uploads on FFmpeg 8.x macOS or on
   *   generic QSV hosts). Prepended by the dispatcher before the handler's output.
   */
  #hardwareStreamContext(options: ResolvedVideoEncoderOptions): HardwareStreamContext {

    return {

      bufsize: bufsizeArg(options),
      filterChain: this.#hardwareFilterChain(options).join(", "),
      frameRateArg: (options.fps !== options.inputFps) ? [ "-r", options.fps.toString() ] : [],
      gop: gopArg(options),
      init: this.#getHardwareDeviceInit(options),
      maxrate: maxrateArg(options)
    };
  }

  /**
   * Emit hardware-encode args for macOS Apple Silicon using `h264_videotoolbox`.
   *
   * Apple Silicon supports a quality-constraint mode via `-q:v`, which lets VideoToolbox vary bitrate to achieve a target visual quality bounded by `-maxrate`. When
   * smart quality is off, falls back to a fixed average bitrate via `-b:v`. `-level:v 0` lets the hardware encoder decide the level itself (the API is particular
   * about explicit level values).
   */
  #macOSAppleStreamEncoderArgs(options: ResolvedVideoEncoderOptions, context: HardwareStreamContext): string[] {

    const args = [

      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", this.#getH264Profile(options.profile),
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", context.filterChain,
      "-g:v", context.gop,
      "-bufsize", context.bufsize,
      "-maxrate", context.maxrate,
      ...context.frameRateArg
    ];

    if(options.smartQuality) {

      // -q:v 90 lets VideoToolbox vary bitrate to achieve target visual quality, capped by -maxrate. Apple Silicon-specific; pairs with the hardware encoder's ICQ mode.
      args.push("-q:v", "90");
    } else {

      args.push("-b:v", bitrateArg(options));
    }

    return args;
  }

  /**
   * Emit hardware-encode args for Intel-based Macs using `h264_videotoolbox`.
   *
   * The Intel VideoToolbox encoder lacks a quality-constraint mode - hardware and API limitations only support a fixed average bitrate via `-b:v`, regardless of the
   * caller's smart-quality preference. smartQuality still influences `-maxrate` via `context.maxrate` (headroom added on top), but no `-q:v` emission exists on this
   * path. The arg shape otherwise matches the Apple Silicon handler.
   */
  #macOSIntelStreamEncoderArgs(options: ResolvedVideoEncoderOptions, context: HardwareStreamContext): string[] {

    return [

      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", this.#getH264Profile(options.profile),
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", context.filterChain,
      "-b:v", bitrateArg(options),
      "-g:v", context.gop,
      "-bufsize", context.bufsize,
      "-maxrate", context.maxrate,
      ...context.frameRateArg
    ];
  }

  /**
   * Emit hardware-encode args for Raspberry Pi using `h264_v4l2m2m`.
   *
   * v4l2m2m wants the numeric H.264 profile encoding (66 / 77 / 100), not the canonical string form - see `getH264Profile`'s `numeric` argument. Like Intel Mac, the
   * v4l2m2m encoder has no quality-constraint mode; `-b:v` is always emitted. `-reset_timestamps 1` is required for the Pi encoder to produce usable output. No
   * `-level:v` is emitted - v4l2m2m manages levels internally.
   */
  #raspbianStreamEncoderArgs(options: ResolvedVideoEncoderOptions, context: HardwareStreamContext): string[] {

    return [

      "-codec:v", "h264_v4l2m2m",
      "-profile:v", this.#getH264Profile(options.profile, true),
      "-bf", "0",
      "-noautoscale",
      "-reset_timestamps", "1",
      "-filter:v", context.filterChain,
      "-b:v", bitrateArg(options),
      "-g:v", context.gop,
      "-bufsize", context.bufsize,
      "-maxrate", context.maxrate,
      ...context.frameRateArg
    ];
  }

  /**
   * Emit hardware-encode args for Intel QSV using `h264_qsv`.
   *
   * QSV supports its own quality-constraint mode via `-global_quality` (intelligent constant quality / ICQ), analogous to VideoToolbox's `-q:v` on Apple Silicon. When
   * smart quality is off, falls back to `-b:v`. `-level:v 0` lets the QSV encoder pick its own level - the hardware encoder handles this better than honoring an
   * explicit HomeKit-requested level.
   */
  #qsvStreamEncoderArgs(options: ResolvedVideoEncoderOptions, context: HardwareStreamContext): string[] {

    const args = [

      "-codec:v", "h264_qsv",
      "-profile:v", this.#getH264Profile(options.profile),
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", context.filterChain,
      "-g:v", context.gop,
      "-bufsize", context.bufsize,
      "-maxrate", context.maxrate,
      ...context.frameRateArg
    ];

    if(options.smartQuality) {

      // -global_quality 20 is QSV's intelligent-constant-quality mode, analogous to -q:v 90 on Apple VT but scaled differently.
      args.push("-global_quality", "20");
    } else {

      args.push("-b:v", bitrateArg(options));
    }

    return args;
  }

  /**
   * Reports whether the given transcode context runs on the host's hardware encoder in this instance's resolved configuration. Live streaming uses the hardware
   * encoder whenever transcoding is resolved on; HKSV recording additionally excludes Raspberry Pi, whose h264_v4l2m2m encoder is unreliable for event recording - a
   * matter separate from the FFmpeg-7+ h264_v4l2m2m decoder regression noted in #configureRaspbianHwAccel, which affects decoding only. The answer reads the resolved
   * class config set in the constructor by #configureHwAccel, before any encoder method is callable.
   *
   * The encoder choice, the source ceiling, and any consumer narration or policy all read this one predicate, so they can never disagree about a given context, and
   * relaxing the raspbian exclusion here flips every one of them together with no consumer change.
   *
   * @param context - The transcode context whose hardware-encoder use is queried.
   * @returns `true` when `context` runs on the host's hardware encoder in the resolved configuration, `false` when it software-encodes.
   */
  public hardwareEncodes(context: EncoderContext): boolean {

    if(!this.config.hardwareTranscoding) {

      return false;
    }

    return (context === "stream") || (this.#codecSupport.hostSystem !== "raspbian");
  }

  /**
   * Returns the maximum source pixel count the host's hardware transcode pipeline can ingest for the given encoding context, or `Infinity` when unconstrained.
   *
   * Only Raspberry Pi's GPU imposes a real limit; every other host is unconstrained. A context is capped only when it actually runs on that hardware path - so today live
   * streaming on a Pi returns the RPi ceiling while recording on a Pi returns `Infinity` (it software-encodes). Consumers apply this value blindly; the "why" lives here.
   *
   * @param context - The encoding context whose ceiling is requested.
   * @returns Maximum supported source pixel count for `context`.
   */
  public maxSourcePixels(context: EncoderContext): number {

    return (this.hardwareEncodes(context) && (this.#codecSupport.hostSystem === "raspbian")) ? RPI4_HW_TRANSCODE_MAX_PIXELS : Infinity;
  }

  // Translates HomeKit's `H264Level` enum into the string or numeric form FFmpeg's `-level:v` accepts. `numeric=true` returns the v4l2m2m form (e.g. "31"); the default
  // returns the canonical string form (e.g. "3.1"). Indexed lookup against `H264_LEVEL_NAMES`, declared `as const satisfies Record<H264Level, ...>` so a new enum member
  // upstream is a compile-time failure here.
  #getH264Level(level: H264Level, numeric = false): string {

    return H264_LEVEL_NAMES[level][numeric ? "numeric" : "string"];
  }

  // Translates HomeKit's `H264Profile` enum into the string or numeric form FFmpeg's `-profile:v` accepts. `numeric=true` returns the v4l2m2m form (e.g. "100"); the
  // default returns the canonical string form (e.g. "high"). Indexed lookup against `H264_PROFILE_NAMES`, declared `as const satisfies Record<H264Profile, ...>` so a
  // new enum member upstream is a compile-time failure here.
  #getH264Profile(profile: H264Profile, numeric = false): string {

    return H264_PROFILE_NAMES[profile][numeric ? "numeric" : "string"];
  }
}
