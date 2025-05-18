/* Copyright(C) 2023-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/options.ts: FFmpeg decoder and encoder options with hardware-accelerated codec support where available.
 */

/**
 * Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.
 *
 * This module defines interfaces and classes for specifying, adapting, and generating FFmpeg command-line arguments tailored to the host system’s capabilities. It
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
import { H264Level, H264Profile, type Logging } from "homebridge";
import { HOMEKIT_STREAMING_HEADROOM, RPI_GPU_MINIMUM } from "./settings.js";
import type { FfmpegCodecs } from "./codecs.js";
import type { HomebridgePluginLogging } from "../util.js";

/**
 * Configuration options for `FfmpegOptions`, defining transcoding, decoding, logging, and hardware acceleration settings.
 *
 * @property codecSupport         - FFmpeg codec capabilities and hardware support.
 * @property crop                 - Optional. Cropping rectangle for output video.
 * @property debug                - Enable debug logging.
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
  crop?: { height: number, width: number, x: number, y: number };
  debug: boolean;
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
 * @property bitrate         - Target video bitrate, in kilobits per second.
 * @property fps             - Target output frames per second.
 * @property height          - Output video height, in pixels.
 * @property idrInterval     - Interval (in seconds) between keyframes (IDR frames).
 * @property inputFps        - Input (source) frames per second.
 * @property level           - H.264 profile level for output.
 * @property profile         - H.264 profile for output.
 * @property useSmartQuality - Optional. If `true`, enables smart quality and variable bitrate optimizations. Defaults to `true`.
 * @property width           - Output video width, in pixels.
 *
 * @example
 *
 * ```ts
 * const encoderOptions: EncoderOptions = {
 *
 *   bitrate: 3000,
 *   fps: 30,
 *   height: 1080,
 *   idrInterval: 2,
 *   inputFps: 30,
 *   level: H264Level.LEVEL4_0,
 *   profile: H264Profile.HIGH,
 *   useSmartQuality: true,
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
export interface EncoderOptions {

  bitrate: number,
  fps: number,
  height: number,
  idrInterval: number,
  inputFps: number,
  level: H264Level,
  profile: H264Profile,
  useSmartQuality?: boolean,
  width: number
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
 * const encoderOptions: EncoderOptions = {
 *
 *   bitrate: 3000,
 *   fps: 30,
 *   height: 1080,
 *   idrInterval: 2,
 *   inputFps: 30,
 *   level: H264Level.LEVEL4_0,
 *   profile: H264Profile.HIGH,
 *   useSmartQuality: true,
 *   width: 1920
 * };
 * const args = ffmpegOpts.streamEncoder(encoderOptions);
 *
 * // Generate crop filter string, if cropping is enabled.
 * const crop = ffmpegOpts.cropFilter;
 * ```
 *
 * @see EncoderOptions
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
   * The original options used to initialize this instance.
   */
  public readonly options: FfmpegOptionsConfig;

  private readonly hwPixelFormat: string[];

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
    this.debug = options.debug ?? false;

    this.hwPixelFormat = [];
    this.log = options.log;
    this.name = options.name;
    this.options = options;

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

      if(this.options.hardwareDecoding) {

        categories.push("decoding");
      }

      if(this.options.hardwareTranscoding) {

        categories.push("transcoding");
      }

      return categories.join(" and ");
    };

    // Hardware-accelerated decoding is enabled by default, where supported. Let's select the decoder options accordingly where supported.
    if(this.options.hardwareDecoding) {

      // Utility function to check that we have a specific decoder codec available to us.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const validateDecoder = (codec: string, pixelFormat: string[]): boolean => {

        if(!this.options.codecSupport.hasDecoder("h264", codec)) {

          this.log.error("Unable to enable hardware-accelerated decoding. Your video processor does not have support for the " + codec + " decoder. " +
            "Using software decoding instead.");

          this.options.hardwareDecoding = false;

          return false;
        }

        this.hwPixelFormat.push(...pixelFormat);

        return true;
      };

      // Utility function to check that we have a specific decoder codec available to us.
      const validateHwAccel = (accel: string, pixelFormat: string[]): boolean => {

        if(!this.options.codecSupport.hasHwAccel(accel)) {

          this.log.error("Unable to enable hardware-accelerated decoding. Your video processor does not have support for the " + accel + " hardware accelerator. " +
            "Using software decoding instead.");

          this.options.hardwareDecoding = false;

          return false;
        }

        this.hwPixelFormat.push(...pixelFormat);

        return true;
      };

      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // Verify that we have hardware-accelerated decoding available to us.
          validateHwAccel("videotoolbox", ["videotoolbox_vld", "nv12", "yuv420p"]);

          break;

        case "raspbian":

          // If it's less than the minimum hardware GPU memory we need on an Raspberry Pi, we revert back to our default decoder.
          if(this.options.codecSupport.gpuMem < RPI_GPU_MINIMUM) {

            this.log.info("Disabling hardware-accelerated %s. Adjust the GPU memory configuration on your Raspberry Pi to at least %s MB to enable it.",
              accelCategories(), RPI_GPU_MINIMUM);

            this.options.hardwareDecoding = false;
            this.options.hardwareTranscoding = false;

            return false;
          }

          // Verify that we have the hardware decoder available to us. Unfortunately, at the moment, it seems that hardware decoding is flaky, at best, on Raspberry Pi.
          // validateDecoder("h264_mmal", [ "mmal", "yuv420p" ]);
          // validateDecoder("h264_v4l2m2ml", [ "yuv420p" ]);
          this.options.hardwareDecoding = false;

          break;

        default:

          // Back to software decoding unless we're on a known system that always supports hardware decoding.
          this.options.hardwareDecoding = false;

          break;
      }
    }

    // If we've enabled hardware-accelerated transcoding, let's select the encoder options accordingly where supported.
    if(this.options.hardwareTranscoding) {

      // Utility function to check that we have a specific encoder codec available to us.
      const validateEncoder = (codec: string): boolean => {

        if(!this.options.codecSupport.hasEncoder("h264", codec)) {

          this.log.error("Unable to enable hardware-accelerated transcoding. Your video processor does not have support for the " + codec + " encoder. " +
            "Using software transcoding instead.");

          this.options.hardwareTranscoding = false;

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
          if(!this.options.codecSupport.hasEncoder("aac", "aac_at")) {

            this.log.error("Your video processor does not have support for the native macOS AAC encoder, aac_at. Will attempt to use libfdk_aac instead.");
          }

          break;

        case "raspbian":

          // Verify that we have the hardware encoder available to us.
          validateEncoder("h264_v4l2m2m");

          logMessage = "Raspberry Pi hardware acceleration will be used for livestreaming. " +
            "HomeKit Secure Video recordings are not supported by the hardware encoder and will use software transcoding instead";

          // Ensure we have the pixel format the Raspberry Pi GPU is expecting available to us, if it isn't already.
          if(!this.hwPixelFormat.includes("yuv420p")) {

            this.hwPixelFormat.push("yuv420p");
          }

          break;

        default:

          // Let's see if we have Intel QuickSync hardware decoding available to us.
          if(this.options.codecSupport.hasHwAccel("qsv") &&
            this.options.codecSupport.hasDecoder("h264", "h264_qsv") && this.options.codecSupport.hasEncoder("h264", "h264_qsv") &&
            this.options.codecSupport.hasDecoder("hevc", "hevc_qsv") && this.options.codecSupport.hasEncoder("hevc", "hevc_qsv")) {

            this.options.hardwareDecoding = true;
            this.hwPixelFormat.push("qsv", "yuv420p");
            logMessage = "Intel Quick Sync Video";
          } else {

            // Back to software encoding.
            this.options.hardwareDecoding = false;
            this.options.hardwareTranscoding = false;
          }

          break;
      }
    }

    // Inform the user.
    if(this.options.hardwareDecoding || this.options.hardwareTranscoding) {

      this.log.info("Hardware-accelerated " + accelCategories() + " enabled" + (logMessage.length ? ": " + logMessage : "") + ".");
    }

    return this.options.hardwareTranscoding;
  }

  /**
   * Returns the audio encoder arguments to use when transcoding.
   *
   * @returns Array of FFmpeg command-line arguments for audio encoding.
   */
  public get audioEncoder(): string[] {

    // If we don't have libfdk_aac available to us, we're essentially dead in the water.
    let encoderOptions: string[] = [];

    // Utility function to return a default audio encoder codec.
    const defaultAudioEncoderOptions = (): string[] => {

      const audioOptions = [];

      if(this.options.codecSupport.hasEncoder("aac", "libfdk_aac")) {

        // Default to libfdk_aac since FFmpeg doesn't natively support AAC-ELD. We use the following options by default:
        //
        // -acodec libfdk_aac            Use the libfdk_aac encoder.
        // -afterburner 1                Increases audio quality at the expense of needing a little bit more computational power in libfdk_aac.
        // -eld_v2 1                     Use the enhanced low delay v2 standard for better audio characteristics.
        audioOptions.push(

          "-acodec", "libfdk_aac",
          "-afterburner", "1",
          "-eld_v2", "1"
        );

        // If we're using Jellyfin's FFmpeg, it's libfdk_aac is broken and crashes when using spectral band replication.
        if(!/-Jellyfin$/i.test(this.options.codecSupport.ffmpegVersion)) {

          // -eld_sbr 1                  Use spectral band replication to further enhance audio.
          audioOptions.push("-eld_sbr", "1");
        }
      }

      return audioOptions;
    };

    switch(this.codecSupport.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        // If we don't have audiotoolbox available, let's default back to libfdk_aac.
        if(!this.options.codecSupport.hasEncoder("aac", "aac_at")) {

          encoderOptions = defaultAudioEncoderOptions();

          break;
        }

        // aac_at is the macOS audio encoder API. We use the following options:
        //
        // -acodec aac_at                Use the aac_at encoder on macOS.
        // -aac_at_mode cvbr             Use the constrained variable bitrate setting to allow the encoder to optimize audio within the requested bitrates.
        encoderOptions = [

          "-acodec", "aac_at",
          "-aac_at_mode", "cvbr"
        ];

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
   * @param codec            - Optional. Codec to decode ("h264" or "hevc").
   * @returns Array of FFmpeg command-line arguments for video decoding.
   *
   * @example
   *
   * ```ts
   * const args = ffmpegOpts.videoDecoder("h264");
   * ```
   */
  public videoDecoder(codec = "h264"): string[] {

    codec = codec.toLowerCase();

    switch(codec) {

      case "h265":
      case "hevc":

        codec = "hevc";

        break;

      default:

        codec = "h264";

        break;
    }

    // Default to no special decoder options for inbound streams.
    let decoderOptions: string[] = [];

    // If we've enabled hardware-accelerated transcoding, let's select decoder options accordingly where supported.
    if(this.options.hardwareDecoding) {

      switch(this.codecSupport.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // h264_videotoolbox is the macOS hardware decoder and encoder API. We use the following options for decoding video:
          //
          // -hwaccel videotoolbox       Select Video Toolbox for hardware-accelerated H.264 decoding.
          decoderOptions = [

            "-hwaccel", "videotoolbox"
          ];

          break;

        case "raspbian":

          // h264_mmal is the preferred Raspberry Pi hardware decoder codec. We use the following options for decoding video:
          //
          // -c:v h264_mmal              Select the Multimedia Abstraction Layer codec for hardware-accelerated H.264 processing.
          decoderOptions = [

            // "-c:v", "h264_mmal"
          ];

          break;

        default:

          // h264_qsv is the Intel Quick Sync Video hardware encoder and decoder.
          //
          // -hwaccel qsv                Select Quick Sync Video to enable hardware-accelerated H.264 decoding.
          // -c:v h264_qsv or hevc_qsv   Select the Quick Sync Video codec for hardware-accelerated H.264 or HEVC processing.
          decoderOptions = [

            "-hwaccel", "qsv",
            "-hwaccel_output_format", "qsv",
            "-c:v", (codec === "hevc") ? "hevc_qsv" : "h264_qsv"
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
    if(!this.options.crop) {

      return "crop=w=iw*100:h=ih*100:x=iw*0:y=ih*0";
    }

    // Generate our crop filter based on what the user has configured.
    return "crop=" + [

      "w=iw*" + this.options.crop.width.toString(),
      "h=ih*" + this.options.crop.height.toString(),
      "x=iw*" + this.options.crop.x.toString(),
      "y=ih*" + this.options.crop.y.toString()
    ].join(":");
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
   * const encoderOptions: EncoderOptions = {
   *
   *   bitrate: 2000,
   *   fps: 30,
   *   height: 720,
   *   idrInterval: 2,
   *   inputFps: 30,
   *   level: H264Level.LEVEL3_1,
   *   profile: H264Profile.MAIN,
   *   useSmartQuality: true,
   *   width: 1280
   * };
   *
   * const args = ffmpegOpts['defaultVideoEncoderOptions'](encoderOptions);
   * ```
   *
   * @see EncoderOptions
   */
  private defaultVideoEncoderOptions(options: EncoderOptions): string[] {

    const videoFilters = [];

    // Default smart quality to true unless specified.
    options = Object.assign({}, { useSmartQuality: true }, options);

    // Set our FFmpeg video filter options:
    //
    // format=                           Set the pixel formats we want to target for output.
    videoFilters.push("format=" + [ ...new Set([ ...this.hwPixelFormat, "yuvj420p" ]) ].join("|"));

    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   a power of two.
    videoFilters.push("scale=-2:min(ih\\," + options.height.toString() + ")");

    // fps=fps=                          Use the fps filter to provide the frame rate requested by HomeKit. This has better performance characteristics rather than using
    //                                   "-r". We only need to apply this filter if our input and output frame rates aren't already identical.
    if(options.fps !== options.inputFps) {

      videoFilters.push("fps=fps=" + options.fps.toString());
    }

    // Default to the tried-and-true libx264. We use the following options by default:
    //
    // -c:v libx264                      Use the excellent libx264 H.264 encoder.
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

      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", this.getH264Profile(options.profile),
      "-level:v", this.getH264Level(options.level),
      "-noautoscale",
      "-bf", "0",
      "-filter:v", videoFilters.join(", "),
      "-g:v", (options.fps * options.idrInterval).toString(),
      "-bufsize", (2 * options.bitrate).toString() + "k",
      "-maxrate", (options.bitrate + (options.useSmartQuality ? HOMEKIT_STREAMING_HEADROOM : 0)).toString() + "k"
    ];

    // Using libx264's constant rate factor mode produces generally better results across the board. We use a capped CRF approach, allowing libx264 to
    // make intelligent choices about how to adjust bitrate to achieve a certain quality level depending on the complexity of the scene being encoded, but
    // constraining it to a maximum bitrate to stay within the bandwidth constraints HomeKit is requesting.
    if(options.useSmartQuality) {

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
  public recordEncoder(options: EncoderOptions): string[] {

    // We always disable smart quality when recording due to HomeKit's strict requirements here.
    options.useSmartQuality = false;

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
  public streamEncoder(options: EncoderOptions): string[] {

    // Default smart quality to true.
    if(options.useSmartQuality === undefined) {

      options.useSmartQuality = true;
    }

    // In case we don't have a defined pixel format.
    if(!this.hwPixelFormat.length) {

      this.hwPixelFormat.push("yuvj420p");
    }

    // If we aren't hardware-accelerated, we default to libx264.
    if(!this.options.hardwareTranscoding) {

      return this.defaultVideoEncoderOptions(options);
    }

    // If we've enabled hardware-accelerated transcoding, let's select encoder options accordingly.
    //
    // We begin by adjusting the maximum bitrate tolerance used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to allow encoders some
    // variation in order to maximize quality while honoring bandwidth constraints.
    const adjustedMaxBitrate = options.bitrate + (options.useSmartQuality ? HOMEKIT_STREAMING_HEADROOM : 0);

    // Check the input and output frame rates to see if we need to change it.
    const useFpsFilter = options.fps !== options.inputFps;

    // Initialize our options.
    const encoderOptions = [];
    let videoFilters = [];

    // Set our FFmpeg video filter options:
    //
    // format=                           Set the pixel formats we want to target for output.
    videoFilters.push("format=" + this.hwPixelFormat.join("|"));

    // scale=-2:min(ih\,height)          Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                                   a power of two.
    videoFilters.push("scale=-2:min(ih\\," + options.height.toString() + ")");

    // Crop the stream, if the user has requested it.
    if(this.options.crop) {

      videoFilters.push(this.cropFilter);
    }

    // fps=fps=                          Use the fps filter to provide the frame rate requested by HomeKit. This has better performance characteristics rather than using
    //                                   "-r". We only need to apply this filter if our input and output frame rates aren't already identical.
    if(useFpsFilter) {

      videoFilters.push("fps=fps=" + options.fps.toString());
    }

    switch(this.codecSupport.hostSystem) {

      case "macOS.Apple":

        // h264_videotoolbox is the macOS hardware encoder API. We use the following options on Apple Silicon:
        //
        // -c:v                          Specify the macOS hardware encoder, h264_videotoolbox.
        // -allow_sw 1                   Allow the use of the software encoder if the hardware encoder is occupied or unavailable.
        //                               This allows us to scale when we get multiple streaming requests simultaneously and consume all the available encode engines.
        // -realtime 1                   We prefer speed over quality - if the encoder has to make a choice, sacrifice one for the other.
        // -coder cabac                  Use the cabac encoder for better video quality with the encoding profiles we use for HomeKit.
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
        encoderOptions.push(

          "-c:v", "h264_videotoolbox",
          "-allow_sw", "1",
          "-realtime", "1",
          "-coder", "cabac",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-filter:v", videoFilters.join(", "),
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        );

        if(options.useSmartQuality) {

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
        // -c:v                          Specify the macOS hardware encoder, h264_videotoolbox.
        // -allow_sw 1                   Allow the use of the software encoder if the hardware encoder is occupied or unavailable.
        //                               This allows us to scale when we get multiple streaming requests simultaneously that can consume all the available encode engines.
        // -realtime 1                   We prefer speed over quality - if the encoder has to make a choice, sacrifice one for the other.
        // -coder cabac                  Use the cabac encoder for better video quality with the encoding profiles we use for HomeKit.
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
        return [

          "-c:v", "h264_videotoolbox",
          "-allow_sw", "1",
          "-realtime", "1",
          "-coder", "cabac",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-filter:v", videoFilters.join(", "),
          "-b:v", options.bitrate.toString() + "k",
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        ];

      case "raspbian":

        // h264_v4l2m2m is the preferred interface to the Raspberry Pi hardware encoder API. We use the following options:
        //
        // -c:v                          Specify the Raspberry Pi hardware encoder, h264_v4l2m2m.
        // -noautoscale                  Don't attempt to scale the video stream automatically.
        // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                               ensuring our final dimensions are a power of two.
        // -b:v                          Average bitrate that's being requested by HomeKit. We can't use a quality constraint and allow for more optimization of the
        //                               bitrate due to v4l2m2m limitations.
        // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                               livestreamng exerience.
        // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        return [

          "-c:v", "h264_v4l2m2m",
          "-profile:v", this.getH264Profile(options.profile, true),
          "-bf", "0",
          "-noautoscale",
          "-reset_timestamps", "1",
          "-filter:v", videoFilters.join(", "),
          "-b:v", options.bitrate.toString() + "k",
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        ];

      default:

        // Clear out any prior video filters.
        videoFilters = [];

        // We execute the following GPU-accelerated operations using the Quick Sync Video post-processing filter:
        //
        // format=same                   Set the output pixel format to the same as the input, since it's already in the GPU.
        // w=...:h...                    Scale the video to the size that's being requested while respecting aspect ratios.
        videoFilters.push("vpp_qsv=" + [

          "format=same",
          "w=min(iw\\, (iw / ih) * " + options.height.toString() + ")",
          "h=min(ih\\, " + options.height.toString() + ")"
        ].join(":"));

        // fps=fps=                      Use the fps filter to provide the frame rate requested by HomeKit. This has better performance characteristics rather than using
        //                               "-r". We only need to apply this filter if our input and output frame rates aren't already identical.
        if(useFpsFilter) {

          videoFilters.push("fps=fps=" + options.fps.toString());
        }

        // h264_qsv is the Intel Quick Sync Video hardware encoder API. We use the following options:
        //
        // -c:v                          Specify the Intel Quick Sync Video hardware encoder, h264_qsv.
        // -profile:v                    Use the H.264 profile that HomeKit is requesting when encoding.
        // -level:v 0                    We override what HomeKit requests for the H.264 profile level when we're using hardware-accelerated transcoding because
        //                               the hardware encoder will determine which levels to use. Setting it to 0 allows the encoder to decide for itself.
        // -bf 0                         Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
        // -noautoscale                  Don't attempt to scale the video stream automatically.
        // -init_hw_device               Initialize our hardware accelerator and assign it a name to be used in the FFmpeg command line.
        // -filter_hw_device             Specify the hardware accelerator to be used with our video filter pipeline.
        // -filter:v                     Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                               ensuring our final dimensions are a power of two.
        // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                               livestreamng exerience.
        // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate              The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        encoderOptions.push(

          "-c:v", "h264_qsv",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-init_hw_device", "qsv=hw",
          "-filter_hw_device", "hw",
          "-filter:v", videoFilters.join(", "),
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        );

        if(options.useSmartQuality) {

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

    if(this.options.hardwareTranscoding) {

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
   * This helper is used to translate between HomeKit’s `H264Level` enum and the string or numeric format expected by FFmpeg’s `-level:v` argument.
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
   * This helper is used to translate between HomeKit’s `H264Profile` enum and the string or numeric format expected by FFmpeg’s `-profile:v` argument.
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
