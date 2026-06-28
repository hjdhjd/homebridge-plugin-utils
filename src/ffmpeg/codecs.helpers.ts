/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/codecs.helpers.ts: Shared FfmpegCodecs stand-in factory for the HBPU test suite.
 */

/**
 * Shared `FfmpegCodecs` stand-in factory for the HBPU test suite. Consumers pass the partial {@link CodecsInit} view of whatever capabilities their test needs; the
 * factory fills in sensible defaults for everything else and wires the version-derived surface (`ffmpegAtLeast`, `ffmpegMajorVersion`) through the same pure
 * primitives the real class uses. That shared derivation is the point of the factory: every test file that stubs `FfmpegCodecs` goes through this helper, so the
 * class-internal contract for "how does the class read its version state" has exactly one expression in test code.
 *
 * The real probe / spawn infrastructure lives in `codecs.ts` and is covered by `codecs.test.ts` against fixture strings (hermetic) and by an auto-enabled integration
 * suite that runs whenever an FFmpeg binary is discoverable on PATH (see `integration.helpers.ts` for the gate semantics). Tests that consume this stand-in are
 * deliberately decoupled from that machinery - they care about the class surface, not the probe plumbing.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see
 * `typedoc.json`) so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import { FfmpegCodecs, parseFfmpegVersionParts } from "./codecs.ts";

/**
 * Shape of the stand-in's init object. Every field is optional so callers override only what varies in their test; defaults cover the rest. Keeping this as its own
 * exported type lets test helpers thread partial configurations without leaking the full `FfmpegCodecs` surface into intermediate signatures.
 */
export interface CodecsInit {

  cpuGeneration?: number;
  decoders?: Record<string, string[]>;
  encoders?: Record<string, string[]>;
  ffmpegExec?: string;
  ffmpegVersion?: string;
  gpuMem?: number;
  hostSystem?: string;
  hwAccels?: string[];
  verbose?: boolean;
}

/**
 * Build a minimal `FfmpegCodecs` stand-in that satisfies the narrow surface the FFmpeg modules actually consume. Hands off to the public `FfmpegCodecs.fromState`
 * factory rather than casting a plain object: if the state shape grows a field, this factory fails to compile and points at the missing data, rather than silently
 * returning a partially-populated stand-in.
 *
 * The version-derived surface (`ffmpegMajorVersion`, `ffmpegAtLeast`) delegates to the same pure-function primitives the real `FfmpegCodecs` class uses, so tests that
 * set `ffmpegVersion: "8.1"` automatically see `major=8, minor=1, patch=0` with identical comparison semantics to a real probe. There is no helper-local parse or
 * compare logic that could drift from production.
 *
 * @param init - Optional overrides for individual fields. Defaults: empty decoder / encoder sets, no hardware accelerators, `hostSystem: "generic"`, FFmpeg version
 *               `"6.1.1"`, CPU generation / GPU memory zero, `ffmpegExec: "ffmpeg"`, `verbose: false`.
 *
 * @returns An `FfmpegCodecs`-typed stand-in safe to pass to any module that accepts one.
 *
 * @example
 *
 * ```ts
 * import { makeCodecs } from "./codecs.helpers.ts";
 *
 * const codecs = makeCodecs({
 *
 *   ffmpegVersion: "8.0",
 *   hostSystem: "macOS.Apple",
 *   hwAccels: [ "videotoolbox" ],
 *   encoders: { h264: [ "h264_videotoolbox" ] }
 * });
 * ```
 */
export function makeCodecs(init: CodecsInit = {}): FfmpegCodecs {

  // Build the codec index matching the production shape: format-keyed Record with per-format decoder / encoder Sets. The init shape is `{ codec: [decoders/encoders] }`
  // for test ergonomics, so we pivot it into the production shape here, lowercasing keys / values since both probe and lookup paths treat codec / decoder / encoder
  // names as case-insensitive.
  const codecs: Record<string, { decoders: Set<string>; encoders: Set<string> }> = {};

  const entryFor = (codec: string): { decoders: Set<string>; encoders: Set<string> } => (codecs[codec.toLowerCase()] ??= { decoders: new Set(), encoders: new Set() });

  for(const [ codec, decoders ] of Object.entries(init.decoders ?? {})) {

    entryFor(codec).decoders = new Set(decoders.map((d) => d.toLowerCase()));
  }

  for(const [ codec, encoders ] of Object.entries(init.encoders ?? {})) {

    entryFor(codec).encoders = new Set(encoders.map((e) => e.toLowerCase()));
  }

  const ffmpegVersion = init.ffmpegVersion ?? "6.1.1";

  return FfmpegCodecs.fromState({

    codecs,
    cpuGeneration: init.cpuGeneration ?? 0,
    ffmpegExec: init.ffmpegExec ?? "ffmpeg",
    ffmpegVersion,
    ffmpegVersionParts: parseFfmpegVersionParts(ffmpegVersion),
    gpuMem: init.gpuMem ?? 0,
    hostSystem: init.hostSystem ?? "generic",
    hwAccels: new Set((init.hwAccels ?? []).map((a) => a.toLowerCase())),
    verbose: init.verbose ?? false
  });
}
