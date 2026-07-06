/* Copyright(C) 2023-2026, HJD (https://github.com/hjdhjd). All rights reserved.
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
import { env, platform } from "node:process";
import type { ExecException } from "node:child_process";
import type { Logger } from "../util.ts";
import { composeSignals } from "../util.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

// Promisified execFile, created once at module level rather than per-invocation.
const execFileAsync = promisify(execFile);

// Default watchdog timeout, in milliseconds, applied to every probe invocation so a slow or hung FFmpeg binary cannot stall the host plugin indefinitely. Thirty
// seconds comfortably exceeds the realistic worst-case probe (the hardware-acceleration validation on slow Raspberry Pi hosts) while keeping a crashed binary from
// parking a plugin forever.
const PROBE_DEFAULT_TIMEOUT_MS = 30_000;

// Codec-line regexes for `parseFfmpegCodecs`. Compiled once at module scope to match the convention used for `VALID_HOMEKIT_NAME`, `NON_PRINTABLE_CHARS`, and the other
// hot-path patterns in this package - regex construction per call is wasted work, even on the cold probe path, when one regex serves every line of every probe.
const FFMPEG_CODECS_DECODERS_REGEX = /\S+\s+(\S+).+\(decoders: (.*?)\s*\)/;
const FFMPEG_CODECS_ENCODERS_REGEX = /\S+\s+(\S+).+\(encoders: (.*?)\s*\)/;

/**
 * Parse the stdout of `ffmpeg -version` and return the version string. Returns `"unknown"` when the expected `"ffmpeg version X Copyright..."` line is not found -
 * matching the behavior of the class-level probe, which records the literal `"unknown"` when it cannot identify the binary.
 *
 * Exposed as a module-scope helper (rather than remaining a closure inside the class) so the parse logic is unit-testable against fixture strings without spinning up
 * the probe plumbing.
 *
 * @param stdout - Captured stdout from `ffmpeg -hide_banner -version`.
 *
 * @returns The version string, or `"unknown"` if the version line is absent.
 *
 * @category FFmpeg
 */
export function parseFfmpegVersion(stdout: string): string {

  const versionRegex = /^ffmpeg version (.*) Copyright.*$/m;
  const versionMatch = versionRegex.exec(stdout);

  return versionMatch ? (versionMatch[1] ?? "unknown") : "unknown";
}

/**
 * A parsed FFmpeg version, split into its numeric triple. Produced by {@link parseFfmpegVersionParts}; consumed by {@link ffmpegVersionAtLeast}.
 *
 * @property major - The leading integer (e.g., 6, 7, 8, 10). 0 when the version string doesn't begin with a digit.
 * @property minor - The second numeric segment. 0 when absent or non-numeric.
 * @property patch - The third numeric segment. 0 when absent or non-numeric.
 *
 * @category FFmpeg
 */
export interface FfmpegVersionParts {

  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse an FFmpeg version string into its numeric triple. Splits on `.` and `-` so real-world version strings parse correctly across release tarballs ("8.1.1"),
 * distributor suffixes ("8.1.1-tessus"), distro packages ("4.4.2-0ubuntu0.22.04.1"), and git snapshots ("N-123456-gabcdef"). Any non-numeric segment yields `0` via the
 * `|| 0` fallback, which gives a safe, conservative result: an unknown build parses as `{ major: 0, minor: 0, patch: 0 }` and fails every {@link ffmpegVersionAtLeast}
 * check where the requested major is >= 1.
 *
 * @param version - An FFmpeg version string as produced by {@link parseFfmpegVersion} or by `FfmpegCodecs.ffmpegVersion`.
 *
 * @returns The parsed numeric triple.
 *
 * @example
 *
 * ```ts
 * parseFfmpegVersionParts("8.1.1");            // { major: 8, minor: 1, patch: 1 }
 * parseFfmpegVersionParts("8.1.1-tessus");     // { major: 8, minor: 1, patch: 1 }
 * parseFfmpegVersionParts("N-123456-gabcdef"); // { major: 0, minor: 123456, patch: 0 }  - git snapshot, effectively "unknown"
 * parseFfmpegVersionParts("unknown");          // { major: 0, minor: 0, patch: 0 }
 * ```
 *
 * @category FFmpeg
 */
export function parseFfmpegVersionParts(version: string): FfmpegVersionParts {

  const parts = version.split(/[.-]/);

  return {

    major: Number.parseInt(parts[0] ?? "", 10) || 0,
    minor: Number.parseInt(parts[1] ?? "", 10) || 0,
    patch: Number.parseInt(parts[2] ?? "", 10) || 0
  };
}

/**
 * Return `true` when `parts` represents an FFmpeg version at least as new as the requested major/minor/patch. Compares major, then minor, then patch - the canonical
 * semver ordering. This is the single source of truth for version-gating comparisons across the library; both the `FfmpegCodecs.ffmpegAtLeast` instance method and the
 * test-side fixtures delegate here so the boundary logic lives in one implementation.
 *
 * @param parts - A parsed version triple as produced by {@link parseFfmpegVersionParts}.
 * @param major - The minimum major version to accept.
 * @param minor - The minimum minor version, when major is equal. Defaults to `0`.
 * @param patch - The minimum patch version, when major and minor are equal. Defaults to `0`.
 *
 * @returns `true` if `parts` is >= the requested version; `false` otherwise.
 *
 * @example
 *
 * ```ts
 * const parts = parseFfmpegVersionParts("8.1.2");
 *
 * ffmpegVersionAtLeast(parts, 8);        // true - 8.1.2 >= 8.0.0
 * ffmpegVersionAtLeast(parts, 8, 1, 3);  // false - 8.1.2 < 8.1.3
 * ffmpegVersionAtLeast(parts, 9);        // false - 8.1.2 < 9.0.0
 * ```
 *
 * @category FFmpeg
 */
export function ffmpegVersionAtLeast(parts: FfmpegVersionParts, major: number, minor = 0, patch = 0): boolean {

  if(parts.major !== major) {

    return parts.major > major;
  }

  if(parts.minor !== minor) {

    return parts.minor > minor;
  }

  return parts.patch >= patch;
}

/**
 * Parse the stdout of `ffmpeg -hwaccels` and return the list of hardware-acceleration method names in lowercase, in the order they appeared. Skips blank lines and
 * the leading `"Hardware acceleration methods:"` banner.
 *
 * @param stdout - Captured stdout from `ffmpeg -hide_banner -hwaccels`.
 *
 * @returns Lowercased acceleration method names, one per entry.
 *
 * @category FFmpeg
 */
export function parseFfmpegHwAccels(stdout: string): string[] {

  const result: string[] = [];

  for(const line of stdout.split(EOL)) {

    if(!line.length) {

      continue;
    }

    if(line === "Hardware acceleration methods:") {

      continue;
    }

    result.push(line.toLowerCase());
  }

  return result;
}

/**
 * Parse the stdout of `ffmpeg -codecs` into a format-keyed index of decoders and encoders. Both sets are lowercased for case-insensitive `hasDecoder` /
 * `hasEncoder` lookups. Formats with only decoders or only encoders still produce a full entry (the opposite set is simply empty).
 *
 * @param stdout - Captured stdout from `ffmpeg -hide_banner -codecs`.
 *
 * @returns A record keyed by codec format, each entry carrying the decoders and encoders reported for that format.
 *
 * @category FFmpeg
 */
export function parseFfmpegCodecs(stdout: string): Record<string, { decoders: Set<string>; encoders: Set<string> }> {

  const result: Record<string, { decoders: Set<string>; encoders: Set<string> }> = {};

  // Capture each codec's decoder and encoder lists separately because FFmpeg reports them in independent parenthesized segments on the same line. The regexes are
  // hoisted to module scope above so they are compiled once rather than once per call.
  for(const codecLine of stdout.split(EOL)) {

    const decodersMatch = FFMPEG_CODECS_DECODERS_REGEX.exec(codecLine);
    const encodersMatch = FFMPEG_CODECS_ENCODERS_REGEX.exec(codecLine);

    if(decodersMatch) {

      const [ , format, decoders ] = decodersMatch;

      if((format !== undefined) && (decoders !== undefined)) {

        const entry = (result[format] ??= { decoders: new Set(), encoders: new Set() });

        for(const decoder of decoders.split(" ")) {

          entry.decoders.add(decoder.toLowerCase());
        }
      }
    }

    if(encodersMatch) {

      const [ , format, encoders ] = encodersMatch;

      if((format !== undefined) && (encoders !== undefined)) {

        const entry = (result[format] ??= { decoders: new Set(), encoders: new Set() });

        for(const encoder of encoders.split(" ")) {

          entry.encoders.add(encoder.toLowerCase());
        }
      }
    }
  }

  return result;
}

/**
 * Parse the stdout of `vcgencmd get_mem gpu` into a megabyte value. Returns `0` when the expected `gpu=<N>M` shape is absent or the captured digits fail integer
 * parsing - matching the class-level fallback.
 *
 * @param stdout - Captured stdout from `vcgencmd get_mem gpu`.
 *
 * @returns The reported GPU memory size in megabytes, or `0` when the value could not be read.
 *
 * @category FFmpeg
 */
export function parseRpiGpuMem(stdout: string): number {

  const gpuRegex = /^gpu=(.*)M\n$/;
  const gpuMatch = gpuRegex.exec(stdout);

  return Number.parseInt(gpuMatch?.[1] ?? "", 10) || 0;
}

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
  log: Logger;

  /**
   * Optional. Enables or disables verbose logging output. Defaults to `false`.
   */
  verbose?: boolean;
}

/**
 * Immutable state shape that a populated `FfmpegCodecs` instance holds. Produced by {@link FfmpegCodecs.probe} from live probing, or by {@link FfmpegCodecs.fromState}
 * for callers that already have the capability data (tests, cached probe results, plugin-side injection of pre-computed capabilities). The state is the single source
 * of truth for every getter and predicate on the class - the instance is a thin accessor facade.
 *
 * @property codecs             - Format-keyed index of advertised decoders and encoders.
 * @property cpuGeneration      - Detected CPU generation for Intel Linux hosts and Apple Silicon macOS hosts; `0` when unknown.
 * @property ffmpegExec         - The path or command used to invoke FFmpeg.
 * @property ffmpegVersion      - FFmpeg version string as reported by `ffmpeg -version`; `"unknown"` when the version line was absent.
 * @property ffmpegVersionParts - Pre-parsed numeric triple derived from `ffmpegVersion`; produced by {@link parseFfmpegVersionParts}.
 * @property gpuMem             - Raspberry Pi GPU memory in megabytes (from `vcgencmd get_mem gpu`); `0` on non-RPi hosts.
 * @property hostSystem         - `"generic"`, `"macOS.Apple"`, `"macOS.Intel"`, or `"raspbian"`.
 * @property hwAccels           - Advertised and capability-validated hardware accelerator names in lowercase.
 * @property verbose            - Controls verbose logging behavior propagated to consumers.
 *
 * @category FFmpeg
 */
export interface FfmpegCodecsState {

  readonly codecs: Readonly<Record<string, { readonly decoders: ReadonlySet<string>; readonly encoders: ReadonlySet<string> }>>;
  readonly cpuGeneration: number;
  readonly ffmpegExec: string;
  readonly ffmpegVersion: string;
  readonly ffmpegVersionParts: FfmpegVersionParts;
  readonly gpuMem: number;
  readonly hostSystem: string;
  readonly hwAccels: ReadonlySet<string>;
  readonly verbose: boolean;
}

/**
 * Probe FFmpeg capabilities and codecs on the host system.
 *
 * Construct via the static factory {@link FfmpegCodecs.probe} to run the live probe pipeline, or via {@link FfmpegCodecs.fromState} to inject pre-assembled state
 * (tests, cached capability data). Instances are immutable value objects - every getter and predicate reads from a frozen {@link FfmpegCodecsState} snapshot
 * assembled at construction, so callers holding a reference know its state cannot shift underneath them.
 *
 * @example
 *
 * ```ts
 * const codecs = await FfmpegCodecs.probe({ ffmpegExec: "ffmpeg", log: console, verbose: true });
 *
 * if(codecs) {
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

  readonly #state: FfmpegCodecsState;

  // Private constructor - the only paths in are the static factories below. This makes "a live `FfmpegCodecs` has complete state" a type-level fact rather than a
  // convention callers must remember to honor by running a separate async init step after construction.
  private constructor(state: FfmpegCodecsState) {

    this.#state = state;
  }

  /**
   * Async factory. Runs the full probe pipeline (host-system detection, optional Raspberry Pi GPU memory, FFmpeg version + codec inventory + hardware-accel inventory
   * with per-accel capability validation) and returns a populated instance on success, or `null` when any required probe fails. Every inner probe runs under a
   * watchdog timeout so a slow or hung FFmpeg binary cannot stall the caller indefinitely; the optional `init.signal` composes with that timeout so callers can cancel
   * probing from outside (for example, during plugin shutdown).
   *
   * @param options - Options used to configure the probe (FFmpeg executable, logger, verbose flag).
   * @param init    - Optional probe options. `signal` cancels in-flight probes; the per-call watchdog still applies.
   *
   * @returns A promise that resolves to a populated `FfmpegCodecs` instance, or `null` if probing failed.
   *
   * @example
   *
   * ```ts
   * const codecs = await FfmpegCodecs.probe({ log: plugin.log }, { signal: shutdown.signal });
   *
   * if(!codecs) {
   *
   *   plugin.log.error("FFmpeg probing failed.");
   * }
   * ```
   */
  public static async probe(options: FOptions, init: { signal?: AbortSignal } = {}): Promise<FfmpegCodecs | null> {

    const state = await probeFfmpegCapabilities(options, init.signal);

    return state ? new FfmpegCodecs(state) : null;
  }

  /**
   * Sync factory. Wraps a pre-assembled {@link FfmpegCodecsState} in a `FfmpegCodecs` instance without running any probes. Intended for tests that build a stand-in
   * capability snapshot and for plugins that cache probe results across restarts and want to rehydrate the class without re-probing.
   *
   * @param state - Fully-assembled capability snapshot.
   *
   * @returns A populated `FfmpegCodecs` instance backed by the supplied state.
   *
   * @example
   *
   * ```ts
   * const codecs = FfmpegCodecs.fromState({
   *
   *   codecs: {},
   *   cpuGeneration: 0,
   *   ffmpegExec: "ffmpeg",
   *   ffmpegVersion: "8.0",
   *   ffmpegVersionParts: parseFfmpegVersionParts("8.0"),
   *   gpuMem: 0,
   *   hostSystem: "macOS.Apple",
   *   hwAccels: new Set([ "videotoolbox" ]),
   *   verbose: false
   * });
   * ```
   */
  public static fromState(state: FfmpegCodecsState): FfmpegCodecs {

    return new FfmpegCodecs(state);
  }

  /**
   * The path or command name used to invoke FFmpeg.
   */
  public get ffmpegExec(): string {

    return this.#state.ffmpegExec;
  }

  /**
   * Indicates whether verbose logging is enabled for FFmpeg probing and downstream consumers.
   */
  public get verbose(): boolean {

    return this.#state.verbose;
  }

  /**
   * Returns the amount of GPU memory available on the host system, in megabytes.
   *
   * @remarks Always returns `0` on non-Raspberry Pi systems.
   */
  public get gpuMem(): number {

    return this.#state.gpuMem;
  }

  /**
   * Returns the detected FFmpeg version string. `"unknown"` when the probe ran but the `ffmpeg version X Copyright...` line was not found in stdout. Any other value
   * is the literal version string reported by the binary and may carry suffixes (`"8.1.1-tessus"`, `"4.4.2-0ubuntu0.22.04.1"`, etc.). For version-comparison decisions,
   * prefer {@link ffmpegAtLeast} over parsing this string directly.
   */
  public get ffmpegVersion(): string {

    return this.#state.ffmpegVersion;
  }

  /**
   * Returns the detected FFmpeg major version as a number, or `0` when detection failed or the version string doesn't begin with an integer. Useful for display
   * ("Running FFmpeg 8") and for callers that need the raw major number. Use {@link ffmpegAtLeast} for version-gating comparisons so all version logic flows through
   * a single boundary-correct comparison primitive.
   *
   * @returns The major version number (e.g., `6`, `7`, `8`, `10`), or `0` if the version is unknown or non-numeric.
   */
  public get ffmpegMajorVersion(): number {

    return this.#state.ffmpegVersionParts.major;
  }

  /**
   * Return `true` when the detected FFmpeg build is at least the requested version. Compares major, then minor, then patch - the canonical semver ordering. This is
   * the single source of truth for version-gating decisions across the library; callers prefer this over hand-rolled comparisons so the boundary logic (major-equal
   * but minor-greater means "newer", etc.) lives in one place and stays consistent.
   *
   * @param major - The minimum major version to accept.
   * @param minor - The minimum minor version, when major is equal. Defaults to `0`.
   * @param patch - The minimum patch version, when major and minor are equal. Defaults to `0`.
   *
   * @returns `true` if the detected version is >= the requested version; `false` otherwise. Returns `false` for unknown or unparseable version strings (major = 0).
   *
   * @example
   *
   * ```ts
   * if(codecs.ffmpegAtLeast(8)) {
   *
   *   // FFmpeg 8.0.0 or later.
   * }
   *
   * if(codecs.ffmpegAtLeast(8, 1)) {
   *
   *   // FFmpeg 8.1.0 or later.
   * }
   * ```
   */
  public ffmpegAtLeast(major: number, minor = 0, patch = 0): boolean {

    return ffmpegVersionAtLeast(this.#state.ffmpegVersionParts, major, minor, patch);
  }

  /**
   * Returns the host system type we are running on as one of `"generic"`, `"macOS.Apple"`, `"macOS.Intel"`, or `"raspbian"`.
   *
   * @remarks We are only trying to detect host capabilities to the extent they impact which FFmpeg options we are going to use.
   */
  public get hostSystem(): string {

    return this.#state.hostSystem;
  }

  /**
   * Returns the CPU generation if we're on Linux and have an Intel processor or on macOS and have an Apple Silicon processor.
   *
   * @returns Returns the CPU generation or 0 if it can't be detected or an invalid platform.
   */
  public get cpuGeneration(): number {

    return this.#state.cpuGeneration;
  }

  /**
   * Checks whether a specific decoder is available for a given codec.
   *
   * @param codec   - The codec name, e.g., `"h264"`.
   * @param decoder - The decoder name to check for, e.g., `"h264_qsv"`.
   *
   * @returns `true` if the decoder is available for the codec, `false` otherwise.
   *
   * @example
   *
   * ```ts
   * if(codecs.hasDecoder("h264", "h264_qsv")) {
   *
   *   // Use hardware decoding.
   * }
   * ```
   */
  public hasDecoder(codec: string, decoder: string): boolean {

    return this.#state.codecs[codec.toLowerCase()]?.decoders.has(decoder.toLowerCase()) ?? false;
  }

  /**
   * Checks whether a specific encoder is available for a given codec.
   *
   * @param codec   - The codec name, e.g., `"h264"`.
   * @param encoder - The encoder name to check for, e.g., `"h264_videotoolbox"`.
   *
   * @returns `true` if the encoder is available for the codec, `false` otherwise.
   *
   * @example
   *
   * ```ts
   * if(codecs.hasEncoder("h264", "h264_videotoolbox")) {
   *
   *   // Use hardware encoding.
   * }
   * ```
   */
  public hasEncoder(codec: string, encoder: string): boolean {

    return this.#state.codecs[codec.toLowerCase()]?.encoders.has(encoder.toLowerCase()) ?? false;
  }

  /**
   * Checks whether a given hardware acceleration method is available and validated on the host, as provided by the output of `ffmpeg -hwaccels` and the per-accel
   * capability probe.
   *
   * @param accel - The hardware acceleration method name, e.g., `"videotoolbox"`.
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

    return this.#state.hwAccels.has(accel.toLowerCase());
  }
}

// Probe pipeline. Module-scope functions rather than class methods because the probe assembles state BEFORE a `FfmpegCodecs` instance exists - putting the
// orchestration inside the class would conflate "how do I populate state?" with "how do I hold and serve state?" The factory at `FfmpegCodecs.probe` glues the two
// together.

// Orchestrate the full probe pipeline. Returns a populated state snapshot on success, or `null` when any required probe fails.
async function probeFfmpegCapabilities(options: FOptions, signal?: AbortSignal): Promise<FfmpegCodecsState | null> {

  const ffmpegExec = options.ffmpegExec ?? "ffmpeg";
  const verbose = options.verbose ?? false;
  const { log } = options;

  // Sync host-system / CPU-generation detection.
  const { hostSystem, cpuGeneration } = probeHwOs();

  // Raspberry Pi: probe GPU memory via vcgencmd. Non-fatal if the command fails (0 propagates; the configureHwAccel gate treats 0 as insufficient anyway).
  let gpuMem = 0;

  if(hostSystem === "raspbian") {

    gpuMem = await probeRpiGpuMem(log, signal);
  }

  // FFmpeg version is the first required probe; failure here means the FFmpeg binary isn't usable.
  const ffmpegVersion = await probeFfmpegVersion(ffmpegExec, log, signal);

  if(ffmpegVersion === null) {

    return null;
  }

  log.info("Using FFmpeg version: %s.", ffmpegVersion);

  // FFmpeg codec inventory.
  const codecs = await probeFfmpegCodecs(ffmpegExec, log, signal);

  if(codecs === null) {

    return null;
  }

  // FFmpeg hwaccels inventory, with per-accel capability validation.
  const hwAccels = await probeFfmpegHwAccels(ffmpegExec, verbose, log, signal);

  if(hwAccels === null) {

    return null;
  }

  return {

    codecs,
    cpuGeneration,
    ffmpegExec,
    ffmpegVersion,
    ffmpegVersionParts: parseFfmpegVersionParts(ffmpegVersion),
    gpuMem,
    hostSystem,
    hwAccels,
    verbose
  };
}

// Detect hardware / OS characteristics synchronously from Node built-ins. No subprocesses; cheap and deterministic.
function probeHwOs(): { hostSystem: string; cpuGeneration: number } {

  // Retrieve the CPU model string once to avoid repeated allocations from cpus(). A machine always has at least one CPU entry in practice; the empty-string fallback
  // keeps the lookup total for `noUncheckedIndexedAccess` without changing behavior in any real environment.
  const cpuModelString = cpus()[0]?.model ?? "";

  let hostSystem = "generic";
  let cpuGeneration = 0;

  // Take a look at the platform we're on for an initial hint of what we are.
  switch(platform) {

    // The beloved macOS.
    case "darwin":

      hostSystem = "macOS." + (cpuModelString.includes("Apple") ? "Apple" : "Intel");

      // Identify what generation of Apple Silicon we have.
      if(cpuModelString.includes("Apple")) {

        // Extract the CPU model.
        const cpuModel = /Apple M(\d+) .*/i.exec(cpuModelString);

        if(cpuModel?.[1]) {

          cpuGeneration = Number(cpuModel[1]);
        }
      }

      break;

    // The indomitable Linux.
    case "linux":

      // Check /sys/firmware for the Raspberry Pi 4 device-tree model string. Failure is non-fatal: we fall through to the generic-Linux path with no Pi-specific
      // configuration.
      try {

        // As of the 4.9 kernel, Raspberry Pi prefers to be identified using this method and has deprecated cpuinfo.
        const systemId = readFileSync("/sys/firmware/devicetree/base/model", { encoding: "utf8" });

        // Is it a Pi 4?
        if(/Raspberry Pi (Compute Module )?4/.test(systemId)) {

          hostSystem = "raspbian";
        }
      } catch {

        // We aren't especially concerned with errors here, given we're just trying to ascertain the system information through hints.
      }

      // Identify what generation of Intel CPU we have if we're on Intel.
      if(cpuModelString.includes("Intel")) {

        // Extract the CPU model.
        const cpuModel = /Intel.*Core.*i\d+-(\d{3,5})/i.exec(cpuModelString);

        if(cpuModel?.[1]) {

          // Grab the individual SKU as both a number and string.
          const skuStr = cpuModel[1];
          const skuNum = Number(skuStr);

          // Now deduce the CPU generation.
          if(skuNum < 1000) {

            // First generation CPUs are three digit SKUs.
            cpuGeneration = 1;
          } else if(skuStr.length > 4) {

            // For five-digit SKUs, the generation are the leading digits before the last three.
            cpuGeneration = Number(skuStr.slice(0, skuStr.length - 3));
          } else {

            // Finally, for four-digit SKUs, the generation is the first digit.
            cpuGeneration = Number(skuStr.charAt(0));
          }
        }
      }

      break;

    default:

      // We aren't trying to solve for every system type.
      break;
  }

  return { cpuGeneration, hostSystem };
}

// Probe the FFmpeg version string via `ffmpeg -hide_banner -version`. Returns the parsed version string, or `null` on probe failure.
async function probeFfmpegVersion(ffmpegExec: string, log: Logger, signal?: AbortSignal): Promise<string | null> {

  let version: string | null = null;

  const ok = await probeCmd(ffmpegExec, [ "-hide_banner", "-version" ], (stdout) => {

    version = parseFfmpegVersion(stdout);
  }, { log, signal });

  return ok ? version : null;
}

// Probe the FFmpeg codec inventory via `ffmpeg -hide_banner -codecs`. Returns a format-keyed index, or `null` on probe failure.
async function probeFfmpegCodecs(ffmpegExec: string, log: Logger, signal?: AbortSignal):
Promise<Record<string, { decoders: Set<string>; encoders: Set<string> }> | null> {

  let parsed: Record<string, { decoders: Set<string>; encoders: Set<string> }> | null = null;

  const ok = await probeCmd(ffmpegExec, [ "-hide_banner", "-codecs" ], (stdout) => {

    parsed = parseFfmpegCodecs(stdout);
  }, { log, signal });

  return ok ? parsed : null;
}

// Probe the FFmpeg hardware-accelerator inventory via `ffmpeg -hide_banner -hwaccels`, then validate each advertised accel by running a one-second synthetic transcode
// that initializes the hardware-acceleration context. The validation catches the case where a build advertises an accel the host hardware cannot actually use;
// discarding those accelerators here means callers don't have to re-validate downstream.
async function probeFfmpegHwAccels(ffmpegExec: string, verbose: boolean, log: Logger, signal?: AbortSignal): Promise<Set<string> | null> {

  const hwAccels = new Set<string>();

  const ok = await probeCmd(ffmpegExec, [ "-hide_banner", "-hwaccels" ], (stdout) => {

    for(const accel of parseFfmpegHwAccels(stdout)) {

      hwAccels.add(accel);
    }
  }, { log, signal });

  if(!ok) {

    return null;
  }

  // Capability validation per accel. Hardware / driver availability can diverge from FFmpeg's advertised build capabilities (e.g., `videotoolbox` is always present in
  // macOS builds but unusable on Intel Macs running a pre-VT OS). A quick synthetic transcode against each accel tells us which ones actually work on this host.
  for(const accel of hwAccels) {

    // Validate one accel at a time rather than in parallel: each synthetic transcode initializes the same underlying hardware-acceleration context (GPU or codec
    // engine), so concurrent probes would contend for that shared resource and risk a false negative - an accel reported as unusable because of contention with a
    // sibling probe rather than a genuine host incapability. This is a one-time startup probe, not a throughput-sensitive workload, so serializing it here costs nothing
    // that matters.
    // eslint-disable-next-line no-await-in-loop
    const accelOk = await probeCmd(ffmpegExec, [

      "-hide_banner", "-hwaccel", accel, "-v", "quiet", "-t", "1", "-f", "lavfi", "-i", "color=black:1920x1080", "-c:v", "libx264", "-f", "null", "-"
    ], () => { /* No-op. */ }, { log, quietRunErrors: true, signal });

    if(!accelOk) {

      hwAccels.delete(accel);

      if(verbose) {

        log.error("Hardware-accelerated decoding and encoding using %s will be unavailable: unable to successfully validate capabilities.", accel);
      }
    }
  }

  return hwAccels;
}

// Probe Raspberry Pi GPU memory via `vcgencmd get_mem gpu`. Returns the megabyte value, or `0` on probe failure (the caller's configureHwAccel gate treats `0` as
// insufficient anyway, so the return-value distinction is cosmetic but keeps the null handling consistent with the other probes).
async function probeRpiGpuMem(log: Logger, signal?: AbortSignal): Promise<number> {

  let gpuMem = 0;

  await probeCmd("vcgencmd", [ "get_mem", "gpu" ], (stdout) => {

    gpuMem = parseRpiGpuMem(stdout);
  }, { log, signal });

  return gpuMem;
}

// Utility to run a probe subcommand under a composed signal (caller's signal + a per-probe watchdog timeout). The caller's processOutput handler receives the stdout on
// success; a returned `true` indicates the command completed and the output was handed off. An ENOENT failure (the binary could not be found) always logs regardless of
// `quietRunErrors`, since a missing binary is worth surfacing no matter the caller's intent; other failures log unless `quietRunErrors` is set - that flag exists for
// the per-accel validation loop where failures are expected and logged at a higher level by the caller.
async function probeCmd(command: string, commandLineArgs: string[], processOutput: (output: string) => void,
  options: { log: Logger; quietRunErrors?: boolean; signal?: AbortSignal }): Promise<boolean> {

  const { log, quietRunErrors = false, signal: callerSignal } = options;

  // Always compose with a per-probe watchdog timeout so the worst-case outcome is bounded. When the caller also supplies a signal, `composeSignals` falls through to
  // `AbortSignal.any()`; when no caller signal is supplied, the timeout alone governs (composeSignals returns it unwrapped).
  const composed = composeSignals(callerSignal, AbortSignal.timeout(PROBE_DEFAULT_TIMEOUT_MS));

  try {

    const { stdout } = await execFileAsync(command, commandLineArgs, { signal: composed });

    processOutput(stdout);

    return true;
  } catch(error) {

    const execError = error as ExecException;

    if(execError.code === "ENOENT") {

      log.error("Unable to find '%s' in path: '%s'.", command, env["PATH"]);

      return false;
    } else if(quietRunErrors) {

      return false;
    } else {

      log.error("Error running %s: %s.", command, execError.message.replace(/\.$/, ""));
    }

    log.error("Unable to probe the capabilities of your Homebridge host without access to '%s'. Ensure that it is available in your path and correctly working.",
      command);

    return false;
  }
}
