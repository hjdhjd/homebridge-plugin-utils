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
import type { H264Level as H264LevelEnum, H264Profile as H264ProfileEnum } from "homebridge";
import { HOMEKIT_STREAMING_HEADROOM, RPI4_GPU_MINIMUM, RPI4_HW_TRANSCODE_MAX_PIXELS } from "./settings.ts";
import { AudioRecordingCodecType } from "./hap-enums.ts";
import type { FfmpegCodecs } from "./codecs.ts";
import type { Logger } from "../util.ts";

// HAP protocol const enum values mirrored locally for the H264 enums that are unique to this module. `verbatimModuleSyntax` disallows value imports of ambient const
// enums, so we preserve the canonical names in code by mirroring the numeric contract from hap-nodejs. Values MUST stay in lockstep with the upstream definitions in
// `hap-nodejs/.../RTPStreamManagement.d.ts`. `AudioRecordingCodecType` is hoisted to `hap-enums.ts` so this module and `record.ts` share one mirror.
const H264Level: { readonly LEVEL3_1: H264LevelEnum.LEVEL3_1; readonly LEVEL3_2: H264LevelEnum.LEVEL3_2; readonly LEVEL4_0: H264LevelEnum.LEVEL4_0 } =
  { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 };
const H264Profile: { readonly BASELINE: H264ProfileEnum.BASELINE; readonly HIGH: H264ProfileEnum.HIGH; readonly MAIN: H264ProfileEnum.MAIN } =
  { BASELINE: 0, HIGH: 2, MAIN: 1 };

// Re-expose the H264 enum types under their canonical names so existing annotations (`level: H264Level`, `profile: H264Profile`) continue to resolve without churn.
type H264Level = H264LevelEnum;
type H264Profile = H264ProfileEnum;

// Translation tables for the H264 enum values that shape FFmpeg's `-level:v` and `-profile:v` arguments. `as const satisfies Record<...>` pins each map to exhaustively
// cover every enum member at compile time - a new enum value added upstream forces the build to fail until the table is updated, so encoder-argument emission cannot
// silently default to a wrong value when consumers extend the upstream enum. The two-key payload (`numeric`/`string`) matches FFmpeg's two emission shapes per argument.
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
 * @property codecSupport         - FFmpeg codec capabilities and hardware support.
 * @property crop                 - Optional. Cropping rectangle for output video.
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
 * @property hardwareDecoding    - Optional. If `true`, the emitted encoder args assume the input stream has already been hardware-decoded (the GPU holds the frames).
 *                                 Used by the transfer-filter logic to decide between `hwupload`, `hwdownload`, or neither. Defaults to the resolved
 *                                 `FfmpegOptionsConfig.hardwareDecoding` value on the owning `FfmpegOptions` instance.
 * @property hardwareTranscoding - Optional. If `true`, the emitted args select a hardware-accelerated encoder (`h264_videotoolbox` / `h264_qsv` / `h264_v4l2m2m`) and
 *                                 the matching filter pipeline. If `false`, the args fall back to the libx264 software encoder. Defaults to the resolved
 *                                 `FfmpegOptionsConfig.hardwareTranscoding` value on the owning `FfmpegOptions` instance.
 * @property height              - Output video height, in pixels.
 * @property idrInterval         - Interval (in seconds) between keyframes (IDR frames).
 * @property inputFps            - Input (source) frames per second.
 * @property level               - H.264 profile level for output.
 * @property profile             - H.264 profile for output.
 * @property smartQuality        - Optional. Enables variable-bitrate quality-constrained encoding on encoders that support it - libx264 (`-crf 20`), Apple Silicon
 *                                 VideoToolbox (`-q:v 90`), and Intel QSV (`-global_quality 20`). Intel VideoToolbox and v4l2m2m have no quality-constraint mode and
 *                                 always emit a fixed `-b:v` regardless. In all cases, `smartQuality` also adds `HOMEKIT_STREAMING_HEADROOM` to `-maxrate`, giving the
 *                                 encoder a narrow band of variation above the target bitrate. Defaults to `true`.
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
 *   inputFps: 30,
 *   level: H264Level.LEVEL4_0,
 *   profile: H264Profile.HIGH,
 *   smartQuality: true,
 *   width: 1920
 * };
 *
 * // Use with FfmpegOptions for transcoding or streaming.
 * const ffmpegOpts = new FfmpegOptions(optionsConfig);
 * const args = ffmpegOpts.streamEncoder(encoderOptions);
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
  inputFps: number;
  level: H264Level;
  profile: H264Profile;
  smartQuality?: boolean;
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
// fields are narrowed to `Required` so downstream handlers can read `resolved.hardwareDecoding` / `resolved.hardwareTranscoding` / `resolved.smartQuality` as definite
// booleans rather than `boolean | undefined`. The type exists purely to carry that guarantee through the dispatch chain - internal only, not part of the module's
// public export surface.
type ResolvedVideoEncoderOptions = VideoEncoderOptions & Required<Pick<VideoEncoderOptions, "hardwareDecoding" | "hardwareTranscoding" | "smartQuality">>;

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
// per-platform handlers use guard conditionals rather than exhaustive switches, so those consumers must be updated by inspection when the union grows.
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
const QSV_DECODER_BY_CODEC: Readonly<Record<SupportedDecodeCodec, string>> = Object.freeze({

  "av1": "av1_qsv",
  "h264": "h264_qsv",
  "hevc": "hevc_qsv"
});

// Minimal view of the encoder options that the hardware-transfer and hardware-device-init helpers actually need. `Required<Pick<...>>` so every flag this view exposes
// is a definite boolean at the type level: every caller either passes a `ResolvedVideoEncoderOptions` (where the resolver guarantees the fields) or an inline object
// literal with concrete booleans, so the weaker `boolean | undefined` optional view has no caller behavior to represent. Defined as a dedicated type so those helpers
// can be called with either shape without casts - the typed counterpart to "pass only what you read."
type HardwareStateView = Required<Pick<VideoEncoderOptions, "hardwareDecoding" | "hardwareTranscoding">>;

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
   * Determines the required hardware transfer filters based on the decoding and encoding configuration.
   *
   * This method manages the transition between software and hardware processing contexts. When video data needs to move between the CPU and GPU for processing, we
   * provide the appropriate FFmpeg filters to handle that transfer efficiently.
   *
   * @param options - The hardware-state view with the decoding and transcoding flags. Callers pass either a full `VideoEncoderOptions` (structurally assignable) or a
   *                  purpose-built object exposing the same flags - whichever is natural at the call site.
   * @returns Array of filter strings for hardware upload or download operations.
   */
  #getHardwareTransferFilters(options: HardwareStateView): string[] {

    const filters: string[] = [];

    // We need to handle four possible state transitions between decoding and encoding.
    //
    // 1. Software decode -> Software encode: No transfer needed, stay in software.
    // 2. Software decode -> Hardware encode: Need hwupload to move data to GPU.
    // 3. Hardware decode -> Software encode: Need hwdownload to move data to CPU.
    // 4. Hardware decode -> Hardware encode: No transfer needed, stay in hardware.
    const needsUpload = !options.hardwareDecoding && options.hardwareTranscoding;
    const needsDownload = options.hardwareDecoding && !options.hardwareTranscoding;

    if(needsUpload) {

      // We need to upload frames from system memory to the GPU for hardware encoding.
      switch(this.#codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // FFmpeg 8.x on macOS requires explicit upload when moving from software decoding to VideoToolbox encoding.
          if(this.#codecSupport.ffmpegAtLeast(8)) {

            filters.push("hwupload");
          }

          break;

        case "raspbian":

          // The Raspberry Pi hardware encoder prefers being fed the ubiquitous yuv420p.
          filters.push("format=yuv420p");

          break;

        default:

          // We need to upload frames from system memory to the GPU for hardware encoding.
          filters.push("hwupload");

          break;
      }

      return filters;
    }

    if(needsDownload) {

      // We need to download frames from the GPU to system memory for software encoding.
      switch(this.#codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // FFmpeg 8.x on macOS requires explicit download and format conversion when moving from VideoToolbox to software.
          if(this.#codecSupport.ffmpegAtLeast(8)) {

            filters.push("hwdownload", "format=nv12");
          }

          break;

        case "raspbian":

          // We don't need to download anything on Raspbian.
          break;

        default:

          // Other platforms typically just need a simple download operation.
          filters.push("hwdownload");

          break;
      }

      return filters;
    }

    return filters;
  }

  /**
   * Gets hardware device initialization options for encoders that need them.
   *
   * When we're using hardware encoding without hardware decoding, we need to initialize the hardware device context explicitly. This method provides the
   * platform-specific initialization arguments required by FFmpeg.
   *
   * @param options - The hardware-state view with the decoding and transcoding flags. Only those flags are read, so the helper accepts either a full
   *                  `VideoEncoderOptions` or a purpose-built object exposing the same flags.
   * @returns Array of FFmpeg arguments for hardware device initialization.
   */
  #getHardwareDeviceInit(options: HardwareStateView): string[] {

    // Only initialize hardware device if we're encoding with hardware but not decoding with it. When decoding with hardware, the device context is already initialized
    // by the decoder.
    if(!options.hardwareDecoding && options.hardwareTranscoding) {

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
   * Returns the audio decoder to use when decoding.
   *
   * @returns The FFmpeg audio decoder string.
   */
  public readonly audioDecoder: string = "libfdk_aac";

  /**
   * Returns the video decoder arguments to use for decoding video.
   *
   * @param codec            - Optional. Codec to decode (`"av1"`, `"h264"` (default), or `"hevc"`; `"h265"` is accepted as an
   *                           alias for `"hevc"`, and codec matching is case-insensitive).
   * @returns Array of FFmpeg command-line arguments for video decoding or an empty array if the codec isn't supported.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.videoDecoder("h264");
   * ```
   */
  public videoDecoder(codec = "h264"): string[] {

    // Normalize the caller-supplied codec into our `SupportedDecodeCodec` surface via a single table-driven lookup. `canonicalDecodeCodec` handles both case folding
    // and the `h265 -> hevc` alias; bogus codecs fall out as `undefined` and short-circuit before any hardware dispatch so typos can never leak into argv.
    const normalized = canonicalDecodeCodec(codec);

    if(!normalized) {

      return [];
    }

    // Hardware decoding is an all-or-nothing gate at the plugin level. When the caller has opted out (or configureHwAccel disabled it on this host) we emit no decoder
    // args and FFmpeg falls through to software decoding transparently.
    if(!this.config.hardwareDecoding) {

      return [];
    }

    // Dispatch to the platform handler. Each handler owns its platform's full hardware-decode story: capability gates (AV1 silicon-generation caveats), arg shape, and
    // codec-specific mappings. The single switch here is the only place that knows "which handler for which platform."
    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        return this.#macOSHardwareDecodeArgs(normalized);

      case "raspbian":

        return this.#raspbianHardwareDecodeArgs();

      default:

        return this.#qsvHardwareDecodeArgs(normalized);
    }
  }

  /**
   * Emit hardware-decode args for the macOS VideoToolbox path, applying the AV1 capability gate.
   *
   * AV1 hardware decode via VideoToolbox requires all three of:
   *
   *   1. **Apple Silicon M3 or newer** (`cpuGeneration >= 3`) - the first Apple silicon generation to ship AV1 hardware decode. Intel Macs never supported it.
   *   2. **FFmpeg 8.0 or newer** - FFmpeg added the VideoToolbox AV1 decoder in the 8.0 release; earlier FFmpeg builds lack the decoder entirely.
   *   3. macOS Sonoma 14.4 or newer at the OS level (not represented in our capability model; assumed when the above two hold and the user is running current software).
   *
   * When any of the three is missing, we return `[]` and FFmpeg falls back to software AV1 decode transparently. H.264 and HEVC paths are unaffected - they work on
   * every supported macOS configuration.
   *
   * @param codec - The canonicalized codec, already narrowed by `videoDecoder` to one of the supported decode codecs.
   * @returns The VideoToolbox decoder args, or `[]` when the host cannot hardware-decode the requested codec.
   */
  #macOSHardwareDecodeArgs(codec: SupportedDecodeCodec): string[] {

    if((codec === "av1") && ((this.#codecSupport.hostSystem === "macOS.Intel") || (this.#codecSupport.cpuGeneration < 3) ||
      (!this.#codecSupport.ffmpegAtLeast(8)))) {

      return [];
    }

    // -hwaccel videotoolbox           Select VideoToolbox for hardware-accelerated decoding on macOS.
    // -hwaccel_output_format ...      Explicit output format on FFmpeg 8.x; pre-8.x lets FFmpeg choose and the flag is omitted.
    return [

      "-hwaccel", "videotoolbox",
      ...(this.#codecSupport.ffmpegAtLeast(8) ? [ "-hwaccel_output_format", "videotoolbox_vld" ] : [])
    ];
  }

  /**
   * Emit hardware-decode args for the Intel QSV path, applying the silicon-generation gate for AV1.
   *
   * AV1 hardware decode via Intel QSV requires 11th-generation silicon or newer (cpuGeneration >= 11). Older chips return `[]` and FFmpeg handles software decode
   * transparently. H.264 and HEVC paths always emit QSV decoder args on any advertised generation.
   *
   * @param codec - The canonicalized codec, already narrowed by `videoDecoder` to one of the supported decode codecs.
   * @returns The QSV decoder args, or `[]` when the silicon cannot hardware-decode the requested codec.
   */
  #qsvHardwareDecodeArgs(codec: SupportedDecodeCodec): string[] {

    if((codec === "av1") && (this.#codecSupport.cpuGeneration < 11)) {

      return [];
    }

    // -hwaccel qsv                    Select Quick Sync Video for hardware-accelerated decoding.
    // -hwaccel_output_format qsv      Keep frames on the GPU across the filter chain to avoid a needless download+upload round trip.
    // -codec:v <codec>_qsv            Select the specific QSV decoder for the requested codec. The `SupportedDecodeCodec` narrowing makes this lookup total at the
    //                                 type level, so no runtime fallback is required.
    return [

      "-hwaccel", "qsv",
      "-hwaccel_output_format", "qsv",
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
   * Returns the platform-appropriate FFmpeg video filters needed to transfer hardware-decoded frames to system memory. When hardware decoding is active, decoded frames
   * may reside on the GPU and require explicit download before CPU-based filters (crop, scale, format conversion) can operate on them. Returns an empty array when
   * hardware decoding is disabled or when the platform handles the transfer implicitly (e.g. Raspberry Pi).
   *
   * @returns An array of FFmpeg filter strings to prepend to a video filter chain, or an empty array if no transfer is needed.
   */
  public get hardwareDownloadFilters(): string[] {

    return this.#getHardwareTransferFilters({ hardwareDecoding: this.config.hardwareDecoding, hardwareTranscoding: false });
  }

  /**
   * Returns the FFmpeg crop filter string, or a default no-op filter if cropping is disabled.
   *
   * @returns The crop filter string for FFmpeg.
   */
  public get cropFilter(): string {

    // If we haven't enabled cropping, tell the crop filter to do nothing.
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
  // (`defaultVideoEncoderOptions`) and hardware (`hardwareStreamContext`) paths inline this splice - centralizing it here keeps "do we emit a crop filter" a one-line
  // decision. Returning a readonly array so callers can only splice, not mutate.
  get #cropFilterSegment(): readonly string[] {

    return this.config.crop ? [this.cropFilter] : [];
  }

  /**
   * Generate the appropriate scale filter for the current platform. This method returns platform-specific scale filters to leverage hardware acceleration capabilities
   * where available.
   */
  #getScaleFilter(options: ResolvedVideoEncoderOptions): string[] {

    // Determine the target dimensions for our scale operation. We maintain aspect ratio while ensuring the output doesn't exceed the requested height.
    const targetHeight = options.height.toString();
    const filters: string[] = [];

    // Our default software scaler.
    const swScale = "scale=-2:min(ih\\, " + targetHeight + ")" + ":in_range=auto:out_range=auto";

    // Add any required hardware transfer filters first. This ensures we're in the correct memory context before scaling.
    filters.push(...this.#getHardwareTransferFilters(options));

    // Set our FFmpeg scale filter based on the platform and available hardware acceleration.
    //
    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   divisible by two. For macOS, we use the accelerated version, scale_vt. For Intel QSV, we use vpp_qsv.
    // in_range/out_range=auto           On the software path, let FFmpeg infer the input and output color ranges rather than forcing a conversion. The QSV path
    //                                   instead carries a format=same sub-parameter inside vpp_qsv to keep frames in their existing GPU pixel format.
    switch(this.#codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        if(this.#codecSupport.ffmpegAtLeast(8) && options.hardwareTranscoding) {

          // On macOS with FFmpeg 8.x, we can use the VideoToolbox scaler (scale_vt) which provides hardware-accelerated scaling. This is significantly more efficient
          // than software scaling and can handle higher throughput with lower CPU usage. Prior to FFmpeg 8.0, this would break under a variety of scenarios and was
          // unreliable.
          filters.push("scale_vt=-2:min(ih\\, " + targetHeight + ")");
        } else {

          // Fall back to software scaling with explicit pixel format conversion.
          filters.push(swScale);
        }

        break;

      case "raspbian":

        // Raspberry Pi uses the standard software scaler. Hardware scaling capabilities vary by model, so we use the reliable software path.
        filters.push(swScale);

        break;

      default:

        if(options.hardwareTranscoding) {

          // When using Intel Quick Sync Video, we execute GPU-accelerated operations using the vpp_qsv post-processing filter.
          //
          // format=same                   Set the output pixel format to the same as the input, since it's already in the GPU.
          // w=...:h...                    Scale the video to the size that's being requested while respecting aspect ratios.
          filters.push(

            "vpp_qsv=" + [

              "format=same",
              "w=min(iw\\, (iw / ih) * " + options.height.toString() + ")",
              "h=min(ih\\, " + options.height.toString() + ")"
            ].join(":")
          );
        } else {

          filters.push(swScale);
        }

        break;
    }

    return filters;
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
    // frames in system memory. On this software-encode path the only transfer that ever appears is a download (GPU->CPU, when hardware decoding is paired with
    // software encoding), so crop sits *after* the transfer - immediately on the CPU side of the GPU boundary. The hardware-encode path in `streamEncoder` expresses
    // the same rule with the opposite ordering, since its transfer is always an upload (CPU->GPU) and crop must precede it.
    //
    // hwdownload / format=nv12         Optional hardware transfer (emitted only when hardware decoding is paired with software encoding on FFmpeg 8.x macOS, or
    //                                   when downloading from a GPU accelerator on a generic QSV-like host). Brings GPU-resident frames into system memory so the
    //                                   downstream crop / scale filters can operate on them.
    // crop=...                          Applied when `config.crop` is set. Uses relative iw/ih multipliers so the crop rectangle scales with source resolution;
    //                                   sized against the source frame and feeds the cropped region into the scaler so aspect-ratio math reflects the crop.
    // scale=-2:min(ih\,height)          Scale to HomeKit's requested dimensions while respecting aspect ratios and ensuring final dimensions divisible by two.
    const pixelFilters: string[] = [

      ...this.#getHardwareTransferFilters(options),
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

    // Default to the tried-and-true libx264. We use the following options by default:
    //
    // -codec:v libx264                  Use the excellent libx264 H.264 encoder.
    // -preset veryfast                  Use the veryfast encoding preset in libx264, which provides a good balance of encoding speed and quality.
    // -profile:v                        Use the H.264 profile that HomeKit is requesting when encoding.
    // -level:v                          Use the H.264 profile level that HomeKit is requesting when encoding.
    // -noautoscale                      Don't attempt to scale the video stream automatically.
    // -bf 0                             Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
    // -filter:v                         Set the pixel format and scale the video to the size we want while respecting aspect ratios and ensuring our final
    //                                   dimensions are divisible by two.
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
    // overrides smartQuality, then flows through the same machinery as `streamEncoder`. Raspberry Pi is the one platform-specific divergence - its hardware v4l2m2m
    // encoder is unreliable for HKSV event recording, so we fall back to libx264 regardless of the resolved `hardwareTranscoding` flag. On every other platform the
    // streaming dispatcher handles the rest.
    const recordingInput: VideoEncoderOptions = { ...options, smartQuality: false };

    // Recording falls back to software wherever it can't use the hardware encoder (Raspberry Pi today). This is the same predicate maxSourcePixels("record") consults, so
    // the encoder choice and the source ceiling are guaranteed consistent and evolve together when the upstream v4l2m2m regression is fixed.
    if(!this.#hardwareEncodes("record")) {

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

    // Software-only path. libx264 has its own filter-chain story (downloads-if-any, crop, scale) and is self-contained in defaultVideoEncoderOptions.
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
   * caller can only ever downgrade a flag, never upgrade one. `smartQuality` has no class-level counterpart and no clamp - it defaults to `true` when the caller omits
   * it and passes through otherwise. The result satisfies `Required<Pick<...>>` at the type level *and* at runtime because the formula produces a concrete boolean on
   * every branch; there is no code path that can leave a resolver-guaranteed field undefined.
   *
   * @param options - The caller-supplied encoder options.
   * @returns A resolved options object with defaults filled in and hardware flags clamped against the resolved class config. The three resolver-guaranteed fields
   *          (`hardwareDecoding`, `hardwareTranscoding`, `smartQuality`) are narrowed to `Required` in the return type so downstream handlers see definite booleans.
   */
  #resolveEncoderOptions(options: VideoEncoderOptions): ResolvedVideoEncoderOptions {

    return {

      ...options,
      hardwareDecoding: (options.hardwareDecoding ?? this.config.hardwareDecoding) && this.config.hardwareDecoding,
      hardwareTranscoding: (options.hardwareTranscoding ?? this.config.hardwareTranscoding) && this.config.hardwareTranscoding,
      smartQuality: options.smartQuality ?? true
    };
  }

  /**
   * Pre-compute the shared state every hardware-stream encoder path consumes. Having this in a dedicated helper keeps each per-platform handler a pure function of
   * `(options, context)`, with the shared computation centralized in exactly one place rather than duplicated inline at the start of every branch.
   *
   * - `bufsize`, `gop`, `maxrate` are the pre-formatted rate-control strings every hardware handler splices directly into its `-bufsize` / `-g:v` / `-maxrate` args.
   *   Sourced from the module-scope `bufsizeArg` / `gopArg` / `maxrateArg` helpers so the software and hardware paths share one derivation of each.
   * - `filterChain` is the comma-joined `-filter:v` value. Crop sits first when configured (CPU-side filter), then the platform-specific scaler (which may prepend its
   *   own transfer filters; see `getScaleFilter`).
   * - `frameRateArg` materializes the `...(fps !== inputFps ? ["-r", fps] : [])` conditional once so every handler can splat it directly.
   * - `init` is the platform-specific hardware-device init args (`-init_hw_device` / `-filter_hw_device`, emitted only for SW-decode + HW-encode on FFmpeg 8.x macOS
   *   and on generic QSV hosts). Prepended by the dispatcher before the handler's output.
   */
  #hardwareStreamContext(options: ResolvedVideoEncoderOptions): HardwareStreamContext {

    const videoFilters = [

      ...this.#cropFilterSegment,
      ...this.#getScaleFilter(options)
    ];

    return {

      bufsize: bufsizeArg(options),
      filterChain: videoFilters.join(", "),
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

  // The single source of truth for "does this transcode context run on the hardware encoder on THIS host, in the resolved class config?". Live streaming uses the
  // hardware encoder whenever transcoding is enabled; HKSV recording additionally excludes Raspberry Pi, whose h264_v4l2m2m encoder is unreliable for event recording
  // for reasons separate from the FFmpeg-7+ h264_v4l2m2m decoder regression noted in #configureRaspbianHwAccel, which affects decoding only. Both recordEncoder and
  // maxSourcePixels consult this, so the encoder choice and the source ceiling can never disagree - if the encoder is ever validated as reliable for event recording,
  // relaxing the raspbian exclusion here flips both together with no consumer change. Reads the resolved class config (set in the constructor by #configureHwAccel,
  // before any encoder method is callable), matching the class-level decision recordEncoder has always made.
  #hardwareEncodes(context: EncoderContext): boolean {

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

    return (this.#hardwareEncodes(context) && (this.#codecSupport.hostSystem === "raspbian")) ? RPI4_HW_TRANSCODE_MAX_PIXELS : Infinity;
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
