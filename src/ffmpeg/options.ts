/* Copyright(C) 2023-2025, HJD (https://github.com/hjdhjd). All rights reserved.
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
import { AudioRecordingCodecType, H264Level, H264Profile, type Logging } from "homebridge";
import { HOMEKIT_STREAMING_HEADROOM, RPI_GPU_MINIMUM } from "./settings.js";
import type { FfmpegCodecs } from "./codecs.js";
import type { HomebridgePluginLogging } from "../util.js";

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
  log: HomebridgePluginLogging | Logging;
  name: () => string;
}

/**
 * Options used for configuring video encoding in FFmpeg operations.
 *
 * These options control output bitrate, framerate, resolution, H.264 profile and level, input framerate, and smart quality optimizations.
 *
 * @property codec               - Optional. Audio codec to encode (`AudioRecordingCodecType.AAC_ELD` or `AudioRecordingCodecType.AAC_LC`). Defaults to
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
 * @property hardwareDecoding    - Optional. If `true`, encoder options will account for hardware decoding (primarily for Intel QSV scenarios). Defaults to `true`.
 * @property height              - Output video height, in pixels.
 * @property idrInterval         - Interval (in seconds) between keyframes (IDR frames).
 * @property inputFps            - Input (source) frames per second.
 * @property level               - H.264 profile level for output.
 * @property profile             - H.264 profile for output.
 * @property smartQuality        - Optional and applicable only when not using hardware acceleration. If `true`, enables smart quality and variable bitrate optimizations.
 *                                 Defaults to `true`.
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
   * FFmpeg codec and hardware capabilities for the current host.
   *
   */
  public codecSupport: FfmpegCodecs;

  /**
   * The configuration options used to initialize this instance.
   */
  public readonly config: FfmpegOptionsConfig;

  /**
   * Indicates if debug logging is enabled.
   */
  public readonly debug: boolean;

  /**
   * Logging interface for output and errors.
   */
  public readonly log: HomebridgePluginLogging | Logging;

  /**
   * Function returning the name for this options instance to be used for logging.
   */
  public readonly name: () => string;

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

    this.codecSupport = options.codecSupport;
    this.config = options;
    this.debug = options.debug ?? false;

    this.log = options.log;
    this.name = options.name;

    // Configure our hardware acceleration support.
    this.configureHwAccel();
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
   * @returns `true` if hardware-accelerated transcoding is enabled after configuration, otherwise `false`.
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
  private configureHwAccel(): boolean {

    let logMessage = "";

    // Utility to return which hardware acceleration features are currently available to us.
    const accelCategories = (): string => {

      const categories = [];

      if(this.config.hardwareDecoding) {

        categories.push("decoding");
      }

      if(this.config.hardwareTranscoding) {

        categories.push("\u26ED\uFE0E transcoding");
      }

      return categories.join(" and ");
    };

    // Hardware-accelerated decoding is enabled by default, where supported. Let's select the decoder options accordingly where supported.
    if(this.config.hardwareDecoding) {

      // Utility function to check that we have a specific decoder codec available to us.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const validateDecoder = (codec: string, pixelFormat: string[]): boolean => {

        if(!this.config.codecSupport.hasDecoder("h264", codec)) {

          this.log.error("Unable to enable hardware-accelerated decoding. Your video processor does not have support for the " + codec + " decoder. " +
            "Using software decoding instead.");

          this.config.hardwareDecoding = false;

          return false;
        }

        return true;
      };

      // Utility function to check that we have a specific decoder codec available to us.
      const validateHwAccel = (accel: string): boolean => {

        if(!this.config.codecSupport.hasHwAccel(accel)) {

          this.log.error("Unable to enable hardware-accelerated decoding. Your video processor does not have support for the " + accel + " hardware accelerator. " +
            "Using software decoding instead.");

          this.config.hardwareDecoding = false;

          return false;
        }

        return true;
      };

      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // Verify that we have hardware-accelerated decoding available to us.
          validateHwAccel("videotoolbox");

          break;

        case "raspbian":

          // If it's less than the minimum hardware GPU memory we need on an Raspberry Pi, we revert back to our default decoder.
          if(this.config.codecSupport.gpuMem < RPI_GPU_MINIMUM) {

            this.log.info("Disabling hardware-accelerated %s. Adjust the GPU memory configuration on your Raspberry Pi to at least %s MB to enable it.",
              accelCategories(), RPI_GPU_MINIMUM);

            this.config.hardwareDecoding = false;
            this.config.hardwareTranscoding = false;

            return false;
          }

          // Verify that we have the hardware decoder available to us. Unfortunately, as of FFmpeg 7, it seems that hardware decoding is flaky, at best, on Raspberry Pi.
          // validateDecoder("h264_v4l2m2ml", [ "yuv420p" ]);
          this.config.hardwareDecoding = false;

          break;

        default:

          // Back to software decoding unless we're on a known system that always supports hardware decoding.
          this.config.hardwareDecoding = false;

          break;
      }
    }

    // If we've enabled hardware-accelerated transcoding, let's select the encoder options accordingly where supported.
    if(this.config.hardwareTranscoding) {

      // Utility function to check that we have a specific encoder codec available to us.
      const validateEncoder = (codec: string): boolean => {

        if(!this.config.codecSupport.hasEncoder("h264", codec)) {

          this.log.error("Unable to enable hardware-accelerated transcoding. Your video processor does not have support for the " + codec + " encoder. " +
            "Using software transcoding instead.");

          this.config.hardwareTranscoding = false;

          return false;
        }

        return true;
      };

      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // Verify that we have the hardware encoder available to us.
          validateEncoder("h264_videotoolbox");

          // Validate that we have access to the AudioToolbox AAC encoder.
          if(!this.config.codecSupport.hasEncoder("aac", "aac_at")) {

            this.log.error("Your video processor does not have support for the native macOS AAC encoder, aac_at. Will attempt to use libfdk_aac instead.");
          }

          break;

        case "raspbian":

          // Verify that we have the hardware encoder available to us.
          validateEncoder("h264_v4l2m2m");

          logMessage = "Raspberry Pi hardware acceleration will be used for livestreaming. " +
            "HomeKit Secure Video recordings are not supported by the hardware encoder and will use software transcoding instead";

          break;

        default:

          // Let's see if we have Intel QuickSync hardware decoding available to us.
          if(this.config.codecSupport.hasHwAccel("qsv") &&
            this.config.codecSupport.hasDecoder("h264", "h264_qsv") && this.config.codecSupport.hasEncoder("h264", "h264_qsv") &&
            this.config.codecSupport.hasDecoder("hevc", "hevc_qsv")) {

            this.config.hardwareDecoding = true;
            logMessage = "Intel Quick Sync Video";
          } else {

            // Back to software encoding.
            this.config.hardwareDecoding = false;
            this.config.hardwareTranscoding = false;
          }

          break;
      }
    }

    // Inform the user.
    if(this.config.hardwareDecoding || this.config.hardwareTranscoding) {

      this.log.info("\u26A1\uFE0F Hardware-accelerated " + accelCategories() + " enabled" + (logMessage.length ? ": " + logMessage : "") + ".");
    }

    return this.config.hardwareTranscoding;
  }

  /**
   * Determines the required hardware transfer filters based on the decoding and encoding configuration.
   *
   * This method manages the transition between software and hardware processing contexts. When video data needs to move between the CPU and GPU for processing, we
   * provide the appropriate FFmpeg filters to handle that transfer efficiently.
   *
   * @param options - Video encoder options including hardware decoding and transcoding state.
   * @returns Array of filter strings for hardware upload or download operations.
   */
  private getHardwareTransferFilters(options: VideoEncoderOptions): string[] {

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

      // We need to download frames from the GPU to system memory for software encoding.
      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // FFmpeg 8.x on macOS requires explicit upload when moving from VideoToolbox to software.
          // We need to upload frames from system memory to the GPU for hardware encoding.
          if(this.config.codecSupport.ffmpegVersion.startsWith("8.")) {

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
      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // FFmpeg 8.x on macOS requires explicit download and format conversion when moving from VideoToolbox to software.
          if(this.config.codecSupport.ffmpegVersion.startsWith("8.")) {

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
   * @param options - Video encoder options.
   * @returns Array of FFmpeg arguments for hardware device initialization.
   */
  private getHardwareDeviceInit(options: VideoEncoderOptions): string[] {

    // Only initialize hardware device if we're encoding with hardware but not decoding with it. When decoding with hardware, the device context is already initialized
    // by the decoder.
    if(!options.hardwareDecoding && options.hardwareTranscoding) {

      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // Unfortunately, versions of FFmpeg prior to 8.0 don't properly support VideoToolbox use cases like this.
          if(!this.config.codecSupport.ffmpegVersion.startsWith("8.")) {

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

    // Default our codec to AAC_ELD unless specified.
    options = Object.assign({}, { codec: AudioRecordingCodecType.AAC_ELD }, options);

    // If we don't have libfdk_aac available to us, we're essentially dead in the water.
    let encoderOptions: string[] = [];

    // Utility function to return a default audio encoder codec.
    const defaultAudioEncoderOptions = (): string[] => {

      const audioOptions = [];

      if(this.config.codecSupport.hasEncoder("aac", "libfdk_aac")) {

        // Default to libfdk_aac since FFmpeg doesn't natively support AAC-ELD. We use the following options by default:
        //
        // -codec:a libfdk_aac           Use the libfdk_aac encoder.
        // -afterburner 1                Increases audio quality at the expense of needing a little bit more computational power in libfdk_aac.
        audioOptions.push(

          "-codec:a", "libfdk_aac",
          "-afterburner", "1"
        );

        switch(options.codec) {

          case AudioRecordingCodecType.AAC_ELD:

            break;

          case AudioRecordingCodecType.AAC_LC:
          default:

            audioOptions.push("-vbr", "4");

            break;
        }
      }

      return audioOptions;
    };

    switch(this.codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        // If we don't have audiotoolbox available, let's default back to libfdk_aac.
        if(!this.config.codecSupport.hasEncoder("aac", "aac_at")) {

          encoderOptions = defaultAudioEncoderOptions();

          break;
        }

        // aac_at is the macOS audio encoder API. We use the following options:
        //
        // -codec:a aac_at               Use the aac_at encoder on macOS.
        // -aac_at_mode cvbr             Use the constrained variable bitrate setting to allow the encoder to optimize audio within the requested bitrates.
        encoderOptions = [

          "-codec:a", "aac_at"
        ];

        switch(options.codec) {

          case AudioRecordingCodecType.AAC_ELD:

            encoderOptions.push("-aac_at_mode", "cbr");

            break;

          case AudioRecordingCodecType.AAC_LC:
          default:

            encoderOptions.push("-aac_at_mode", "vbr");
            encoderOptions.push("-q:a", "2");

            break;
        }

        break;

      default:

        encoderOptions = defaultAudioEncoderOptions();

        break;
    }

    return encoderOptions;
  }

  /**
   * Returns the audio decoder to use when decoding.
   *
   * @returns The FFmpeg audio decoder string.
   */
  public get audioDecoder(): string {

    return "libfdk_aac";
  }

  /**
   * Returns the video decoder arguments to use for decoding video.
   *
   * @param codec            - Optional. Codec to decode (`"av1"`, `"h264"` (default), or `"hevc"`).
   * @returns Array of FFmpeg command-line arguments for video decoding or an empty array if the codec isn't supported.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.videoDecoder("h264");
   * ```
   */
  public videoDecoder(codec = "h264"): string[] {

    switch(codec.toLowerCase()) {

      case "av1":

        codec = "av1";

        break;

      case "h264":

        codec = "h264";

        break;

      case "h265":
      case "hevc":

        codec = "hevc";

        break;

      default:

        // If it's unknown to us, we bail out.
        return [];
    }

    // Intel QSV decoder to codec mapping.
    const qsvDecoder: { [index: string]: string } = {

      "av1": "av1_qsv",
      "h264": "h264_qsv",
      "hevc": "hevc_qsv"
    };

    // Default to no special decoder options for inbound streams.
    let decoderOptions: string[] = [];

    // If we've enabled hardware-accelerated transcoding, let's select decoder options accordingly where supported.
    if(this.config.hardwareDecoding) {

      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // h264_videotoolbox is the macOS hardware decoder and encoder API. We use the following options for decoding video:
          //
          // -hwaccel videotoolbox           Select Video Toolbox for hardware-accelerated H.264 decoding.
          decoderOptions = [

            "-hwaccel", "videotoolbox",
            ...(this.config.codecSupport.ffmpegVersion.startsWith("8.") ? [ "-hwaccel_output_format", "videotoolbox_vld" ] : [])
          ];

          break;

        case "raspbian":

          // h264_v4l2m2m is the preferred Raspberry Pi hardware decoder codec. We use the following options for decoding video:
          //
          // -codec:v h264_v4l2m2m           Select the h264_v4l2m2m codec for hardware-accelerated H.264 processing.
          decoderOptions = [

            // The decoder is broken in FFmpeg 7, unfortunately.
            // "-codec:v", "h264_v4l2m2m"
          ];

          break;

        default:

          // h264_qsv is the Intel Quick Sync Video hardware encoder and decoder.
          //
          // -hwaccel qsv                    Select Quick Sync Video to enable hardware-accelerated H.264 decoding.
          // -codec:v X_qsv                  Select the Quick Sync Video codec for hardware-accelerated AV1, H.264, or HEVC processing. AV1 decoding isn't available
          //                                 before 11th generation Intel CPUs.
          decoderOptions = ((codec === "av1") && (this.codecSupport.cpuGeneration < 11)) ? [] : [

            "-hwaccel", "qsv",
            "-hwaccel_output_format", "qsv",
            "-codec:v", qsvDecoder[codec]
          ];

          break;
      }
    }

    return decoderOptions;
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

  /**
   * Generate the appropriate scale filter for the current platform. This method returns platform-specific scale filters to leverage hardware acceleration capabilities
   * where available.
   */
  private getScaleFilter(options: VideoEncoderOptions): string[] {

    // Determine the target dimensions for our scale operation. We maintain aspect ratio while ensuring the output doesn't exceed the requested height.
    const targetHeight = options.height.toString();
    const filters: string[] = [];

    // Our default software scaler.
    const swScale = "scale=-2:min(ih\\, " + targetHeight + ")" + ":in_range=auto:out_range=auto";

    // Add any required hardware transfer filters first. This ensures we're in the correct memory context before scaling.
    filters.push(...this.getHardwareTransferFilters(options));

    // Set our FFmpeg scale filter based on the platform and available hardware acceleration.
    //
    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   a power of two. For macOS, we use the accelerated version, scale_vt. For Intel QSV, we use vpp_qsv.
    // format=                           Set the pixel formats we want to target for output, when needed.
    switch(this.codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        if(this.config.codecSupport.ffmpegVersion.startsWith("8.") && options.hardwareTranscoding) {

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

  /**
   * Generates the default set of FFmpeg video encoder arguments for software transcoding using libx264.
   *
   * This method builds command-line options for the FFmpeg libx264 encoder based on the provided encoder options, including bitrate, H.264 profile and level, pixel
   * format, frame rate, buffer size, and optional smart quality settings. It is used internally when hardware-accelerated transcoding is not enabled or supported.
   *
   * @param options            - The encoder options to use for generating FFmpeg arguments.
   *
   * @returns An array of FFmpeg command-line arguments for software video encoding.
   *
   * @example
   *
   * ```ts
   * const encoderOptions: VideoEncoderOptions = {
   *
   *   bitrate: 2000,
   *   fps: 30,
   *   height: 720,
   *   idrInterval: 2,
   *   inputFps: 30,
   *   level: H264Level.LEVEL3_1,
   *   profile: H264Profile.MAIN,
   *   smartQuality: true,
   *   width: 1280
   * };
   *
   * const args = ffmpegOpts['defaultVideoEncoderOptions'](encoderOptions);
   * ```
   *
   * @see VideoEncoderOptions
   */
  private defaultVideoEncoderOptions(options: VideoEncoderOptions): string[] {

    const videoFilters = [];

    // fps=                              Use the fps filter to provide the frame rate requested by HomeKit. We only need to apply this filter if our input and output
    //                                   frame rates aren't already identical.
    const fpsFilter = ["fps=" + options.fps.toString()];

    // Build our pixel-level filters. We need to handle potential hardware downloads and format conversions.
    const pixelFilters: string[] = [];

    // Add any required hardware transfer filters. This handles downloading from GPU if we were hardware decoding.
    pixelFilters.push(...this.getHardwareTransferFilters(options));

    // Set our FFmpeg pixel-level filters:
    //
    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   a power of two.
    pixelFilters.push(

      "scale=-2:min(ih\\, " + options.height.toString() + "):in_range=auto:out_range=auto"
    );

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
    //                                   dimensions are a power of two.
    // -g:v                              Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
    //                                   livestreamng exerience.
    // -bufsize size                     This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate                  The maximum bitrate tolerance, used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to
    //                                   allow encoders some variation in order to maximize quality while honoring bandwidth constraints.
    const encoderOptions = [

      "-codec:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", this.getH264Profile(options.profile),
      "-level:v", this.getH264Level(options.level),
      "-noautoscale",
      "-bf", "0",
      "-filter:v", videoFilters.join(", "),
      "-g:v", (options.fps * options.idrInterval).toString(),
      "-bufsize", (2 * options.bitrate).toString() + "k",
      "-maxrate", (options.bitrate + (options.smartQuality ? HOMEKIT_STREAMING_HEADROOM : 0)).toString() + "k"
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
      encoderOptions.push("-b:v", options.bitrate.toString() + "k");
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

    // We always disable smart quality when recording due to HomeKit's strict requirements here.
    options.smartQuality = false;

    // Generaly, we default to using the same encoding options we use to transcode livestreams, unless we have platform-specific quirks we need to address,
    // such as where we can have hardware-accelerated transcoded livestreaming, but not hardware-accelerated HKSV event recording. The other noteworthy
    // aspect here is that HKSV is quite specific in what it wants, and isn't vary tolerant of creative license in how you may choose to alter bitrate to
    // address quality. When we call our encoders, we also let them know we don't want any additional quality optimizations when transcoding HKSV events.
    switch(this.codecSupport.hostSystem) {

      case "raspbian":

        // Raspberry Pi struggles with hardware-accelerated HKSV event recording due to issues in the FFmpeg codec driver, currently. We hope this improves
        // over time and can offer it to Pi users, or develop a workaround. For now, we default to libx264.
        return this.defaultVideoEncoderOptions(options);

      default:

        // By default, we use the same options for HKSV and streaming.
        return this.streamEncoder(options);
    }
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

    // Default hardware decoding and smart quality to true unless specified.
    options = Object.assign({}, { hardwareDecoding: true, hardwareTranscoding: this.config.hardwareTranscoding, smartQuality: true }, options);

    // Disable hardware acceleration if we haven't detected it.
    if(!this.config.hardwareDecoding) {

      options.hardwareDecoding = false;
    }

    if(!this.config.hardwareTranscoding) {

      options.hardwareTranscoding = false;
    }

    // If we aren't hardware-accelerated, we default to libx264.
    if(!options.hardwareTranscoding) {

      return this.defaultVideoEncoderOptions(options);
    }

    // If we've enabled hardware-accelerated transcoding, let's select encoder options accordingly.
    //
    // We begin by adjusting the maximum bitrate tolerance used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to allow encoders some
    // variation in order to maximize quality while honoring bandwidth constraints.
    const adjustedMaxBitrate = options.bitrate + (options.smartQuality ? HOMEKIT_STREAMING_HEADROOM : 0);

    // Initialize our options. We'll add hardware device initialization first if needed.
    const encoderOptions = [...this.getHardwareDeviceInit(options)];

    const videoFilters = [];

    // Build our pixel filter chain. We conditionally include the crop filter if configured, then apply platform-specific scaling which handles any necessary hardware
    // transfers internally.
    //
    // crop                              Crop filter options, if requested.
    // scale=...                         Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   a power of two. This also handles hardware transfers as needed.
    videoFilters.push(

      ...(this.config.crop ? [this.cropFilter] : []),
      ...this.getScaleFilter(options)
    );

    switch(this.codecSupport.hostSystem) {

      case "macOS.Apple":

        // h264_videotoolbox is the macOS hardware encoder API. We use the following options on Apple Silicon:
        //
        // -codec:v                      Specify the macOS hardware encoder, h264_videotoolbox.
        // -allow_sw 1                   Allow the use of the software encoder if the hardware encoder is occupied or unavailable.
        //                               This allows us to scale when we get multiple streaming requests simultaneously and consume all the available encode engines.
        // -realtime 1                   We prefer speed over quality - if the encoder has to make a choice, sacrifice one for the other.
        // -profile:v                    Use the H.264 profile that HomeKit is requesting when encoding.
        // -level:v 0                    We override what HomeKit requests for the H.264 profile level on macOS when we're using hardware-accelerated transcoding because
        //                               the hardware encoder is particular about how to use levels. Setting it to 0 allows the encoder to decide for itself.
        // -bf 0                         Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
        // -noautoscale                  Don't attempt to scale the video stream automatically.
        // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                               ensuring our final dimensions are a power of two.
        // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                               livestreamng exerience.
        // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        // -r framerate                  Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware pipeline.
        encoderOptions.push(

          "-codec:v", "h264_videotoolbox",
          "-allow_sw", "1",
          "-realtime", "1",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-filter:v", videoFilters.join(", "),
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k",
          ...((options.fps !== options.inputFps) ? [ "-r", options.fps.toString() ] : [])
        );

        if(options.smartQuality) {

          // -q:v 90                     Use a fixed quality scale of 90, to allow videotoolbox the ability to vary bitrates to achieve the visual quality we want,
          //                             constrained by our maximum bitrate. This is an Apple Silicon-specific feature.
          encoderOptions.push("-q:v", "90");
        } else {

          // -b:v                  Average bitrate that's being requested by HomeKit.
          encoderOptions.push("-b:v", options.bitrate.toString() + "k");
        }

        return encoderOptions;

      case "macOS.Intel":

        // h264_videotoolbox is the macOS hardware encoder API. We use the following options on Intel-based Macs:
        //
        // -codec:v                      Specify the macOS hardware encoder, h264_videotoolbox.
        // -allow_sw 1                   Allow the use of the software encoder if the hardware encoder is occupied or unavailable.
        //                               This allows us to scale when we get multiple streaming requests simultaneously that can consume all the available encode engines.
        // -realtime 1                   We prefer speed over quality - if the encoder has to make a choice, sacrifice one for the other.
        // -profile:v                    Use the H.264 profile that HomeKit is requesting when encoding.
        // -level:v 0                    We override what HomeKit requests for the H.264 profile level on macOS when we're using hardware-accelerated transcoding because
        //                               the hardware encoder is particular about how to use levels. Setting it to 0 allows the encoder to decide for itself.
        // -bf 0                         Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
        // -noautoscale                  Don't attempt to scale the video stream automatically.
        // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                               ensuring our final dimensions are a power of two.
        // -b:v                          Average bitrate that's being requested by HomeKit. We can't use a quality constraint and allow for more optimization of the
        //                               bitrate on Intel-based Macs due to hardware / API limitations.
        // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                               livestreaming exerience.
        // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        // -r framerate                  Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware pipeline.
        encoderOptions.push(

          "-codec:v", "h264_videotoolbox",
          "-allow_sw", "1",
          "-realtime", "1",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-filter:v", videoFilters.join(", "),
          "-b:v", options.bitrate.toString() + "k",
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k",
          ...((options.fps !== options.inputFps) ? [ "-r", options.fps.toString() ] : [])
        );

        return encoderOptions;

      case "raspbian":

        // h264_v4l2m2m is the preferred interface to the Raspberry Pi hardware encoder API. We use the following options:
        //
        // -codec:v                      Specify the Raspberry Pi hardware encoder, h264_v4l2m2m.
        // -noautoscale                  Don't attempt to scale the video stream automatically.
        // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                               ensuring our final dimensions are a power of two.
        // -b:v                          Average bitrate that's being requested by HomeKit. We can't use a quality constraint and allow for more optimization of the
        //                               bitrate due to v4l2m2m limitations.
        // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                               livestreamng exerience.
        // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        // -r framerate                  Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware pipeline.
        encoderOptions.push(

          "-codec:v", "h264_v4l2m2m",
          "-profile:v", this.getH264Profile(options.profile, true),
          "-bf", "0",
          "-noautoscale",
          "-reset_timestamps", "1",
          "-filter:v", videoFilters.join(", "),
          "-b:v", options.bitrate.toString() + "k",
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k",
          ...((options.fps !== options.inputFps) ? [ "-r", options.fps.toString() ] : [])
        );

        return encoderOptions;

      default:

        // h264_qsv is the Intel Quick Sync Video hardware encoder API. We use the following options:
        //
        // -codec:v                      Specify the Intel Quick Sync Video hardware encoder, h264_qsv.
        // -profile:v                    Use the H.264 profile that HomeKit is requesting when encoding.
        // -level:v 0                    We override what HomeKit requests for the H.264 profile level when we're using hardware-accelerated transcoding because
        //                               the hardware encoder will determine which levels to use. Setting it to 0 allows the encoder to decide for itself.
        // -bf 0                         Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
        // -noautoscale                  Don't attempt to scale the video stream automatically.
        // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                               ensuring our final dimensions are a power of two.
        // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                               livestreamng exerience.
        // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        // -r framerate                  Set the output framerate. We use this to bypass doing this in filters so we can maximize the use of our hardware pipeline.
        encoderOptions.push(

          "-codec:v", "h264_qsv",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-filter:v", videoFilters.join(", "),
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k",
          ...((options.fps !== options.inputFps) ? [ "-r", options.fps.toString() ] : [])
        );

        if(options.smartQuality) {

          // -global_quality 20          Use a global quality setting of 20, to allow QSV the ability to vary bitrates to achieve the visual quality we want,
          //                             constrained by our maximum bitrate. This leverages a QSV-specific feature known as intelligent constant quality.
          encoderOptions.push("-global_quality", "20");
        } else {

          // -b:v                        Average bitrate that's being requested by HomeKit.
          encoderOptions.push("-b:v", options.bitrate.toString() + "k");
        }

        return encoderOptions;
    }
  }

  /**
   * Returns the maximum pixel count supported by a specific hardware encoder on the host system, or `Infinity` if not limited.
   *
   * @returns Maximum supported pixel count.
   */
  public get hostSystemMaxPixels(): number {

    if(this.config.hardwareTranscoding) {

      switch(this.codecSupport.hostSystem) {

        case "raspbian":

          // For constrained environments like Raspberry Pi, when hardware transcoding has been selected for a camera, we limit the available source streams to no more
          // than 1080p. In practice, that means that devices like the G4 Pro can't use their highest quality stream for transcoding due to the limitations of the
          // Raspberry Pi GPU that cannot support higher pixel counts.
          return 1920 * 1080;

        default:

          break;
      }
    }

    return Infinity;
  }

  /**
   * Converts a HomeKit H.264 level enum value to the corresponding FFmpeg string or numeric representation.
   *
   * This helper is used to translate between HomeKit's `H264Level` enum and the string or numeric format expected by FFmpeg's `-level:v` argument.
   *
   * @param level        - The H.264 level to translate.
   * @param numeric      - Optional. If `true`, returns the numeric representation (e.g., "31"). If `false` or omitted, returns the standard string format (e.g., "3.1").
   *
   * @returns The FFmpeg-compatible H.264 level string or numeric value.
   *
   * @example
   *
   * ```ts
   * ffmpegOpts['getH264Level'](H264Level.LEVEL3_1);      // "3.1"
   *
   * ffmpegOpts['getH264Level'](H264Level.LEVEL4_0, true); // "40"
   * ```
   *
   * @see H264Level
   */
  private getH264Level(level: H264Level, numeric = false): string {

    switch(level) {

      case H264Level.LEVEL3_1:

        return numeric ? "31" : "3.1";

      case H264Level.LEVEL3_2:

        return numeric ? "32" : "3.2";

      case H264Level.LEVEL4_0:

        return numeric ? "40" : "4.0";

      default:

        return numeric ? "31" : "3.1";
    }
  }

  /**
   * Converts a HomeKit H.264 profile enum value to the corresponding FFmpeg string or numeric representation.
   *
   * This helper is used to translate between HomeKit's `H264Profile` enum and the string or numeric format expected by FFmpeg's `-profile:v` argument.
   *
   * @param profile - The H.264 profile to translate.
   * @param numeric - Optional. If `true`, returns the numeric representation (e.g., "100"). If `false` or omitted, returns the standard string format (e.g., "high").
   *
   * @returns The FFmpeg-compatible H.264 profile string or numeric value.
   *
   * @example
   *
   * ```ts
   * ffmpegOpts['getH264Profile'](H264Profile.HIGH);      // "high"
   *
   * ffmpegOpts['getH264Profile'](H264Profile.BASELINE, true); // "66"
   * ```
   *
   * @see H264Profile
   */
  private getH264Profile(profile: H264Profile, numeric = false): string {

    switch(profile) {

      case H264Profile.BASELINE:

        return numeric ? "66" : "baseline";

      case H264Profile.HIGH:

        return numeric ? "100" : "high";

      case H264Profile.MAIN:

        return numeric ? "77" : "main";

      default:

        return numeric ? "77" : "main";
    }
  }
}
