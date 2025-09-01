/* Copyright(C) 2023-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/codecs.ts: Probe FFmpeg capabilities and codecs.
 */

/**
 * Probe FFmpeg capabilities and codecs on the host system.
 *
 * Utilities for dynamically probing FFmpeg capabilities on the host system, including codec and hardware acceleration support.
 *
 * This module provides classes and interfaces to detect which FFmpeg encoders, decoders, and hardware acceleration methods are available, as well as host platform
 * detection (such as macOS or Raspberry Pi specifics) that directly impact transcoding or livestreaming use cases. It enables advanced plugin development by allowing
 * dynamic adaptation to the host's video processing features, helping ensure compatibility and optimal performance when working with camera-related Homebridge plugins
 * that leverage FFmpeg.
 *
 * Key features include:
 *
 * - Querying the FFmpeg version, available codecs, and hardware acceleration methods.
 * - Detecting host hardware platform details that are relevant to transcoding in FFmpeg.
 * - Checking for the presence of specific encoders/decoders and validating hardware acceleration support.
 *
 * This module is intended for use by plugin developers or advanced users who need to introspect and adapt to system-level FFmpeg capabilities programmatically.
 *
 * @module
 */
import { EOL, cpus } from "node:os";
import { type ExecFileException, execFile } from "node:child_process";
import { env, platform } from "node:process";
import type { HomebridgePluginLogging } from "../util.js";
import type { Logging } from "homebridge";
import { readFileSync } from "node:fs";
import util from "node:util";

/**
 * Options for configuring FFmpeg probing.
 *
 * @category FFmpeg
 */
export interface FOptions {

  /**
   * Optional. The path or command used to execute FFmpeg. Defaults to "ffmpeg".
   */
  ffmpegExec?: string;

  /**
   * Logging interface for output and errors.
   */
  log: HomebridgePluginLogging | Logging;

  /**
   * Optional. Enables or disables verbose logging output. Defaults to `false`.
   */
  verbose?: boolean;
}

/**
 * Probe FFmpeg capabilities and codecs on the host system.
 *
 * This class provides methods to check available FFmpeg decoders, encoders, and hardware acceleration methods, as well as to determine system-specific resources such as
 * GPU memory (on Raspberry Pi). Intended for plugin authors or advanced users needing to assess FFmpeg capabilities dynamically.
 *
 * @example
 *
 * ```ts
 * const codecs = new FfmpegCodecs({
 *
 *   ffmpegExec: "ffmpeg",
 *   log: console,
 *   verbose: true
 * });
 *
 * // Probe system and FFmpeg capabilities.
 * const ready = await codecs.probe();
 *
 * if(ready) {
 *
 *   console.log("Available FFmpeg version:", codecs.ffmpegVersion);
 *
 *   if(codecs.hasDecoder("h264", "h264_v4l2m2m")) {
 *
 *     console.log("Hardware H.264 decoder is available.");
 *   }
 * }
 * ```
 *
 * @category FFmpeg
 */
export class FfmpegCodecs {

  /**
   * The path or command name to invoke FFmpeg.
   */
  public readonly ffmpegExec: string;

  private _ffmpegVersion?: string;
  private _gpuMem?: number;
  private _hostSystem?: string;
  private _cpuGeneration?: number;
  private readonly log: HomebridgePluginLogging | Logging;
  private readonly ffmpegCodecs: { [index: string]: { decoders: string[]; encoders: string[] } };
  private readonly ffmpegHwAccels: { [index: string]: boolean };

  /**
   * Indicates whether verbose logging is enabled for FFmpeg probing.
   */
  public readonly verbose: boolean;

  /**
   * Creates an instance of `FfmpegCodecs`.
   *
   * @param options - Options used to configure FFmpeg probing.
   */
  constructor(options: FOptions) {

    this.ffmpegExec = options.ffmpegExec ?? "ffmpeg";
    this.ffmpegCodecs = {};
    this.ffmpegHwAccels = {};
    this.log = options.log;
    this.verbose = options.verbose ?? false;

    // Detect our host system type.
    this.probeHwOs();
  }

  /**
   * Probes the host system and FFmpeg executable for capabilities, version, codecs, and hardware acceleration support.
   *
   * Returns `true` if probing succeeded, otherwise `false`.
   *
   * @returns A promise that resolves to `true` if probing is successful, or `false` on failure.
   *
   * @example
   *
   * ```ts
   *
   * const ready = await codecs.probe();
   *
   * if(!ready) {
   *
   *   console.log("FFmpeg probing failed.");
   * }
   * ```
   */
  public async probe(): Promise<boolean> {

    // Let's conduct our system-specific capability probes.
    switch(this.hostSystem) {

      case "raspbian":

        // If we're on a Raspberry Pi, let's verify that we have enough GPU memory for hardware-based decoding and encoding.
        await this.probeRpiGpuMem();

        break;

      default:

        break;
    }

    // Capture the version information of FFmpeg.
    if(!(await this.probeFfmpegVersion())) {

      return false;
    }

    // Ensure we've got a working video processor before we do anything else.
    if(!(await this.probeFfmpegCodecs()) || !(await this.probeFfmpegHwAccel())) {

      return false;
    }

    return true;
  }

  /**
   * Checks whether a specific decoder is available for a given codec.
   *
   * @param codec - The codec name, e.g., "h264".
   * @param decoder - The decoder name to check for, e.g., "h264_qsv".
   *
   * @returns `true` if the decoder is available for the codec, `false` otherwise.
   *
   * @example
   *
   * ```ts
   *
   * if(codecs.hasDecoder("h264", "h264_qsv")) {
   *
   *   // Use hardware decoding.
   * }
   * ```
   */
  public hasDecoder(codec: string, decoder: string): boolean {

    // Normalize our lookups.
    codec = codec.toLowerCase();
    decoder = decoder.toLowerCase();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return this.ffmpegCodecs[codec]?.decoders.some(x => x === decoder);
  }

  /**
   * Checks whether a specific encoder is available for a given codec.
   *
   * @param codec - The codec name, e.g., "h264".
   * @param encoder - The encoder name to check for, e.g., "h264_videotoolbox".
   *
   * @returns `true` if the encoder is available for the codec, `false` otherwise.
   *
   * @example
   *
   * ```ts
   *
   * if(codecs.hasEncoder("h264", "h264_videotoolbox")) {
   *
   *   // Use hardware encoding.
   * }
   * ```
   */
  public hasEncoder(codec: string, encoder: string): boolean {

    // Normalize our lookups.
    codec = codec.toLowerCase();
    encoder = encoder.toLowerCase();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return this.ffmpegCodecs[codec]?.encoders.some(x => x === encoder);
  }

  /**
   * Checks whether a given hardware acceleration method is available and validated on the host, as provided by the output of `ffmpeg -hwaccels`.
   *
   * @param accel - The hardware acceleration method name, e.g., "videotoolbox".
   *
   * @returns `true` if the hardware acceleration method is available, `false` otherwise.
   *
   * @example
   *
   * ```ts
   * if(codecs.hasHwAccel("videotoolbox")) {
   *
   *   // Hardware acceleration is supported.
   * }
   * ```
   */
  public hasHwAccel(accel: string): boolean {

    return this.ffmpegHwAccels[accel.toLowerCase()] ? true : false;
  }

  /**
   * Returns the amount of GPU memory available on the host system, in megabytes.
   *
   * @remarks Always returns `0` on non-Raspberry Pi systems.
   */
  public get gpuMem(): number {

    return this._gpuMem ?? 0;
  }

  /**
   * Returns the detected FFmpeg version string, or "unknown" if detection failed.
   */
  public get ffmpegVersion(): string {

    return this._ffmpegVersion ?? "";
  }

  /**
   * Returns the host system type we are running on as one of "generic", "macOS.Apple", "macOS.Intel", or "raspbian".
   *
   * @remarks We are only trying to detect host capabilities to the extent they impact which FFmpeg options we are going to use.
   */
  public get hostSystem(): string {

    return this._hostSystem ?? "generic";
  }

  /**
   * Returns the CPU generation if we're on Linux and have an Intel processor or on macOS and have an Apple Silicon processor.
   *
   * @returns Returns the CPU generation or 0 if it can't be detected or an invalid platform.
   */
  public get cpuGeneration(): number {

    return this._cpuGeneration ?? 0;
  }

  // Probe our video processor's version.
  private async probeFfmpegVersion(): Promise<boolean> {

    return this.probeCmd(this.ffmpegExec, [ "-hide_banner", "-version" ], (stdout: string) => {

      // A regular expression to parse out the version.
      const versionRegex = /^ffmpeg version (.*) Copyright.*$/m;

      // Parse out the version string.
      const versionMatch = versionRegex.exec(stdout);

      // If we have a version string, let's save it. Otherwise, we're blind.
      this._ffmpegVersion = versionMatch ? versionMatch[1] : "unknown";

      this.log.info("Using FFmpeg version: %s.", this.ffmpegVersion);
    });
  }

  // Probe our video processor's hardware acceleration capabilities.
  private async probeFfmpegHwAccel(): Promise<boolean> {

    if(!(await this.probeCmd(this.ffmpegExec, [ "-hide_banner", "-hwaccels" ], (stdout: string) => {

      // Iterate through each line, and a build a list of encoders.
      for(const accel of stdout.split(EOL)) {

        // Skip blank lines.
        if(!accel.length) {

          continue;
        }

        // Skip the first line.
        if(accel === "Hardware acceleration methods:") {

          continue;
        }

        // We've found a hardware acceleration method, let's add it.
        this.ffmpegHwAccels[accel.toLowerCase()] = true;
      }
    }))) {

      return false;
    }

    // Let's test to ensure that just because we have a codec or capability available to us, it doesn't necessarily mean that the user has the hardware capabilities
    // needed to use it, resulting in an FFmpeg error. We catch that here and prevent those capabilities from being exposed unless both software and hardware capabilities
    // enable it. This simple test, generates a one-second video that is processed by the requested codec. If it fails, we discard the codec.
    for(const accel of Object.keys(this.ffmpegHwAccels)) {

      // eslint-disable-next-line no-await-in-loop
      if(!(await this.probeCmd(this.ffmpegExec, [

        "-hide_banner", "-hwaccel", accel, "-v", "quiet", "-t", "1", "-f", "lavfi", "-i", "color=black:1920x1080", "-c:v", "libx264", "-f", "null", "-"
      ], () => {}, true))) {

        delete this.ffmpegHwAccels[accel];

        if(this.verbose) {

          this.log.error("Hardware-accelerated decoding and encoding using %s will be unavailable: unable to successfully validate capabilities.", accel);
        }
      }
    }

    return true;
  }

  // Probe our video processor's encoding and decoding capabilities.
  private async probeFfmpegCodecs(): Promise<boolean> {

    return this.probeCmd(this.ffmpegExec, [ "-hide_banner", "-codecs" ], (stdout: string) => {

      // A regular expression to parse out the codec and it's supported decoders.
      const decodersRegex = /\S+\s+(\S+).+\(decoders: (.*?)\s*\)/;

      // A regular expression to parse out the codec and it's supported encoders.
      const encodersRegex = /\S+\s+(\S+).+\(encoders: (.*?)\s*\)/;

      // Iterate through each line, and a build a list of encoders.
      for(const codecLine of stdout.split(EOL)) {

        // Let's see if we have decoders.
        const decodersMatch = decodersRegex.exec(codecLine);

        // Let's see if we have encoders.
        const encodersMatch = encodersRegex.exec(codecLine);

        // If we found decoders, add them to our list of supported decoders for this format.
        if(decodersMatch) {

          this.ffmpegCodecs[decodersMatch[1]] = { decoders: [], encoders: [] };

          this.ffmpegCodecs[decodersMatch[1]].decoders = decodersMatch[2].split(" ").map(x => x.toLowerCase());
        }

        // If we found decoders, add them to our list of supported decoders for this format.
        if(encodersMatch) {

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          this.ffmpegCodecs[encodersMatch[1]] ||= { decoders: [], encoders: [] };
          this.ffmpegCodecs[encodersMatch[1]].encoders = encodersMatch[2].split(" ").map(x => x.toLowerCase());
        }
      }
    });
  }

  // Identify what hardware and operating system environment we're actually running on.
  private probeHwOs(): void {

    // Take a look at the platform we're on for an initial hint of what we are.
    switch(platform) {

      // The beloved macOS.
      case "darwin":

        this._hostSystem = "macOS." + (cpus()[0].model.includes("Apple") ? "Apple" : "Intel");

        // Identify what generation of Apple Silicon we have.
        if(cpus()[0].model.includes("Apple")) {

          // Extract the CPU model.
          const cpuModel = cpus()[0].model.match(/Apple M(\d+) .*/i);

          this._cpuGeneration = 0;

          if(cpuModel && cpuModel[1]) {

            this._cpuGeneration = Number(cpuModel[1]);
          }
        }

        break;

      // The indomitable Linux.
      case "linux":

        // Let's further see if we're a small, but scrappy, Raspberry Pi.
        try {

          // As of the 4.9 kernel, Raspberry Pi prefers to be identified using this method and has deprecated cpuinfo.
          const systemId = readFileSync("/sys/firmware/devicetree/base/model", { encoding: "utf8" });

          // Is it a Pi 4?
          if(/Raspberry Pi (Compute Module )?4/.test(systemId)) {

            this._hostSystem = "raspbian";
          }
        } catch(error) {

          // We aren't especially concerned with errors here, given we're just trying to ascertain the system information through hints.
        }

        // Identify what generation of Intel CPU we have if we're on Intel.
        if(cpus()[0].model.includes("Intel")) {

          // Extract the CPU model.
          const cpuModel = cpus()[0].model.match(/Intel.*Core.*i\d+-(\d{3,5})/i);

          this._cpuGeneration = 0;

          if(cpuModel && cpuModel[1]) {

            // Grab the individual SKU as both a number and string.
            const skuStr = cpuModel[1];
            const skuNum = Number(skuStr);

            // Now deduce the CPU generation.
            if(skuNum < 1000) {

              // First generation CPUs are three digit SKUs.
              this._cpuGeneration = 1;
            } else if(skuStr.length > 4) {

              // For five-digit SKUs, the generation are the leading digits before the last three.
              this._cpuGeneration = Number(skuStr.slice(0, skuStr.length - 3));
            } else {

              // Finally, for four-digit SKUs, the generation is the first digit.
              this._cpuGeneration = Number(skuStr.charAt(0));
            }
          }
        }

        break;

      default:

        // We aren't trying to solve for every system type.
        break;
    }
  }

  // Probe Raspberry Pi GPU capabilities.
  private async probeRpiGpuMem(): Promise<boolean> {

    return this.probeCmd("vcgencmd", [ "get_mem", "gpu" ], (stdout: string) => {

      // A regular expression to parse out the configured GPU memory on the Raspberry Pi.
      const gpuRegex = /^gpu=(.*)M\n$/;

      // Let's see what we've got.
      const gpuMatch = gpuRegex.exec(stdout);

      // Parse the result and retrieve our allocated GPU memory.
      this._gpuMem = Number.parseInt(gpuMatch?.[1] ?? "", 10) || 0;
    });
  }

  // Utility to probe the capabilities of FFmpeg and the host platform.
  private async probeCmd(command: string, commandLineArgs: string[], processOutput: (output: string) => void, quietRunErrors = false): Promise<boolean> {

    try {

      // Promisify exec to allow us to wait for it asynchronously.
      const execAsync = util.promisify(execFile);

      // Check for the codecs in our video processor.
      const { stdout } = await execAsync(command, commandLineArgs);

      processOutput(stdout);

      return true;
    } catch(error) {

      const execError = error as ExecFileException;

      if(execError.code === "ENOENT") {

        this.log.error("Unable to find '%s' in path: '%s'.", command, env.PATH);
      } else if(quietRunErrors) {

        return false;
      } else {

        this.log.error("Error running %s: %s", command, execError.message);
      }

      this.log.error("Unable to probe the capabilities of your Homebridge host without access to '%s'. Ensure that it is available in your path and correctly working.",
        command);

      return false;
    }
  }
}
