/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/codecs.test.ts: Unit tests for the codec-probe result parsers. Pure-function coverage against fixture strings; a real-binary integration test runs whenever an
 * FFmpeg binary is discoverable on PATH (or `FFMPEG_INTEGRATION=1` is set), and is skipped otherwise. See `integration.helpers.ts` for the full gate semantics.
 */
import { FfmpegCodecs, ffmpegVersionAtLeast, parseFfmpegCodecs, parseFfmpegHwAccels, parseFfmpegVersion, parseFfmpegVersionParts, parseRpiGpuMem } from "./codecs.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ffmpegIntegrationEnabled } from "./integration.helpers.ts";
import { makeCodecs } from "./codecs.helpers.ts";
import { silentLog } from "../testing.helpers.ts";

// Fixture strings built from real FFmpeg command output. EOL handling uses `\n` because `node:os.EOL` is `\n` on the test machine (macOS / Linux); the parsers split
// on the host's EOL, and the test file is host-local too, so there is no cross-platform ambiguity to resolve here.
const VERSION_STDOUT = [

  "ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers",
  "built with Apple clang version 15.0.0",
  "configuration: --prefix=/opt/homebrew --enable-shared"
].join("\n") + "\n";

const HWACCELS_STDOUT = [

  "Hardware acceleration methods:",
  "videotoolbox",
  "",
  "vulkan",
  "qsv"
].join("\n") + "\n";

const CODECS_STDOUT = [

  "Codecs:",
  " D..... = Decoding supported",
  " .E.... = Encoding supported",
  " ------",
  " DEV.L. h264                 H.264 / AVC / MPEG-4 AVC (decoders: h264 h264_qsv ) (encoders: libx264 h264_videotoolbox )",
  " DEV.L. hevc                 H.265 / HEVC (decoders: hevc hevc_qsv ) (encoders: libx265 hevc_videotoolbox )",
  " D.A.L. aac                  AAC (Advanced Audio Coding) (decoders: aac aac_fixed )"
].join("\n") + "\n";

const RPI_GPU_STDOUT = "gpu=128M\n";

describe("parseFfmpegVersion", () => {

  test("extracts the version from real `ffmpeg -version` output", () => {

    assert.equal(parseFfmpegVersion(VERSION_STDOUT), "6.1.1");
  });

  test("returns \"unknown\" when the version banner is missing", () => {

    assert.equal(parseFfmpegVersion("not ffmpeg output\n"), "unknown");
  });

  test("returns \"unknown\" for empty stdout", () => {

    assert.equal(parseFfmpegVersion(""), "unknown");
  });
});

describe("parseFfmpegHwAccels", () => {

  test("returns lowercased method names in the order they appear", () => {

    assert.deepEqual(parseFfmpegHwAccels(HWACCELS_STDOUT), [ "videotoolbox", "vulkan", "qsv" ]);
  });

  test("skips blank lines and the banner", () => {

    const stdout = "Hardware acceleration methods:\n\n\nvideotoolbox\n\n";

    assert.deepEqual(parseFfmpegHwAccels(stdout), ["videotoolbox"]);
  });

  test("returns an empty array for stdout with no methods", () => {

    assert.deepEqual(parseFfmpegHwAccels("Hardware acceleration methods:\n"), []);
  });

  test("lowercases each method", () => {

    const stdout = "Hardware acceleration methods:\nVIDEOTOOLBOX\nQuickSync\n";

    assert.deepEqual(parseFfmpegHwAccels(stdout), [ "videotoolbox", "quicksync" ]);
  });
});

describe("parseFfmpegCodecs", () => {

  test("parses decoders and encoders for each listed codec", () => {

    const result = parseFfmpegCodecs(CODECS_STDOUT);

    assert.ok(result["h264"], "the parsed result must include an entry for the h264 codec");
    assert.deepEqual(Array.from(result["h264"].decoders).sort(), [ "h264", "h264_qsv" ]);
    assert.deepEqual(Array.from(result["h264"].encoders).sort(), [ "h264_videotoolbox", "libx264" ]);

    assert.ok(result["hevc"], "the parsed result must include an entry for the hevc codec");
    assert.deepEqual(Array.from(result["hevc"].decoders).sort(), [ "hevc", "hevc_qsv" ]);
    assert.deepEqual(Array.from(result["hevc"].encoders).sort(), [ "hevc_videotoolbox", "libx265" ]);
  });

  test("records a decoder-only codec with an empty encoders set", () => {

    const result = parseFfmpegCodecs(CODECS_STDOUT);

    assert.ok(result["aac"], "the parsed result must include an entry for the aac codec (decoder-only)");
    assert.deepEqual(Array.from(result["aac"].decoders).sort(), [ "aac", "aac_fixed" ]);
    assert.equal(result["aac"].encoders.size, 0);
  });

  test("returns an empty record for stdout with no codec lines", () => {

    assert.deepEqual(parseFfmpegCodecs("Codecs:\n"), {});
  });

  test("lowercases decoder and encoder names", () => {

    const stdout = " DEV.L. h264 H.264 (decoders: H264 H264_QSV ) (encoders: LIBX264 )\n";
    const result = parseFfmpegCodecs(stdout);

    assert.ok(result["h264"], "the parsed result must include the h264 entry even with uppercase input");
    assert.deepEqual(Array.from(result["h264"].decoders).sort(), [ "h264", "h264_qsv" ]);
    assert.deepEqual(Array.from(result["h264"].encoders), ["libx264"]);
  });
});

describe("parseRpiGpuMem", () => {

  test("extracts megabyte value from vcgencmd output", () => {

    assert.equal(parseRpiGpuMem(RPI_GPU_STDOUT), 128);
  });

  test("returns 0 when the expected shape is absent", () => {

    assert.equal(parseRpiGpuMem("garbage\n"), 0);
  });

  test("returns 0 for empty stdout", () => {

    assert.equal(parseRpiGpuMem(""), 0);
  });

  test("returns 0 when the captured value is not numeric", () => {

    assert.equal(parseRpiGpuMem("gpu=xxxM\n"), 0);
  });
});

describe("parseFfmpegVersionParts", () => {

  test("extracts major.minor.patch from common release strings", () => {

    assert.deepEqual(parseFfmpegVersionParts("8.1.1"), { major: 8, minor: 1, patch: 1 });
    assert.deepEqual(parseFfmpegVersionParts("7.0.2"), { major: 7, minor: 0, patch: 2 });
    assert.deepEqual(parseFfmpegVersionParts("10.0"), { major: 10, minor: 0, patch: 0 }, "double-digit majors must parse correctly (guard for future FFmpeg 10+)");
    assert.deepEqual(parseFfmpegVersionParts("6"), { major: 6, minor: 0, patch: 0 }, "lone-digit versions produce just the major");
  });

  test("tolerates distributor suffixes and distro package tags", () => {

    // Split on [.-] so distributor/distro suffixes don't contaminate the leading numeric triple.
    assert.deepEqual(parseFfmpegVersionParts("8.1.1-tessus"), { major: 8, minor: 1, patch: 1 });
    assert.deepEqual(parseFfmpegVersionParts("4.4.2-0ubuntu0.22.04.1"), { major: 4, minor: 4, patch: 2 }, "Ubuntu-packaged versions parse from the leading triple only");
  });

  test("returns zeros for unparseable inputs (conservative fallback for unknown builds)", () => {

    // An "unknown build" - probed but no version line, or never probed at all, or a git snapshot - parses as 0.0.0. Every ffmpegVersionAtLeast(X) call where X >= 1
    // returns false on such a triple, giving a safe conservative answer without special-casing anywhere in the caller.
    assert.deepEqual(parseFfmpegVersionParts(""), { major: 0, minor: 0, patch: 0 });
    assert.deepEqual(parseFfmpegVersionParts("unknown"), { major: 0, minor: 0, patch: 0 });
    assert.deepEqual(parseFfmpegVersionParts("N-123456-gabcdef"), { major: 0, minor: 123456, patch: 0 },
      "git snapshots lead with 'N' so major=0; the numeric tail leaks into minor but is irrelevant since major=0 fails every real comparison");
  });
});

describe("ffmpegVersionAtLeast", () => {

  test("compares major then minor then patch (canonical semver order)", () => {

    const parts = parseFfmpegVersionParts("8.1.2");

    assert.equal(ffmpegVersionAtLeast(parts, 7), true, "8.1.2 >= 7.0.0");
    assert.equal(ffmpegVersionAtLeast(parts, 8), true, "8.1.2 >= 8.0.0");
    assert.equal(ffmpegVersionAtLeast(parts, 8, 1), true, "8.1.2 >= 8.1.0");
    assert.equal(ffmpegVersionAtLeast(parts, 8, 1, 2), true, "8.1.2 >= 8.1.2 (equality)");
    assert.equal(ffmpegVersionAtLeast(parts, 8, 1, 3), false, "8.1.2 is NOT >= 8.1.3");
    assert.equal(ffmpegVersionAtLeast(parts, 8, 2), false, "8.1.2 is NOT >= 8.2.0");
    assert.equal(ffmpegVersionAtLeast(parts, 9), false, "8.1.2 is NOT >= 9.0.0");
  });

  test("returns false for a 0.0.0 triple against any query where the requested major is >= 1", () => {

    // The "unknown build" conservative fallback - callers can compare blindly without guarding against unprobe'd state.
    const unknown = parseFfmpegVersionParts("");

    assert.equal(ffmpegVersionAtLeast(unknown, 1), false);
    assert.equal(ffmpegVersionAtLeast(unknown, 8), false);
    assert.equal(ffmpegVersionAtLeast(unknown, 8, 1, 2), false);
  });

  test("handles exact boundary cases correctly", () => {

    // Each version compared against itself at every level of precision.
    const eightZero = parseFfmpegVersionParts("8.0.0");

    assert.equal(ffmpegVersionAtLeast(eightZero, 8), true);
    assert.equal(ffmpegVersionAtLeast(eightZero, 8, 0), true);
    assert.equal(ffmpegVersionAtLeast(eightZero, 8, 0, 0), true);
    assert.equal(ffmpegVersionAtLeast(eightZero, 8, 0, 1), false, "8.0.0 is NOT >= 8.0.1");

    // Two-part version string: patch defaults to 0 on both sides.
    const eightOne = parseFfmpegVersionParts("8.1");

    assert.equal(ffmpegVersionAtLeast(eightOne, 8, 1), true);
    assert.equal(ffmpegVersionAtLeast(eightOne, 8, 1, 0), true, "8.1 parses as 8.1.0 and matches 8.1.0 exactly");
    assert.equal(ffmpegVersionAtLeast(eightOne, 8, 1, 1), false, "8.1 parses as 8.1.0 and does NOT match 8.1.1");
  });
});

describe("FfmpegCodecs - version-surface delegation", () => {

  // The class's version surface delegates to the pure functions above. One integration-style test per class method verifies the delegation path; the exhaustive
  // (version string, query) matrix lives in the pure-function describe blocks so the class tests can stay focused on "does the class wire up to the helpers
  // correctly." Delegating to `makeCodecs` keeps test construction on the public `FfmpegCodecs.fromState` factory - no private-field backdoor, no double cast.
  const withVersion = (ffmpegVersion: string): FfmpegCodecs => makeCodecs({ ffmpegVersion });

  test("ffmpegMajorVersion delegates to parseFfmpegVersionParts", () => {

    assert.equal(withVersion("8.1.1").ffmpegMajorVersion, 8);
    assert.equal(withVersion("").ffmpegMajorVersion, 0);
  });

  test("ffmpegAtLeast delegates to parseFfmpegVersionParts + ffmpegVersionAtLeast", () => {

    assert.equal(withVersion("8.1.2").ffmpegAtLeast(8), true);
    assert.equal(withVersion("8.1.2").ffmpegAtLeast(9), false);
    assert.equal(withVersion("").ffmpegAtLeast(1), false);
  });
});

describe("FfmpegCodecs - capability predicates", () => {

  test("hasDecoder returns true only for advertised codec/decoder pairs, case-insensitively", () => {

    // The state fixture lowercases codec / decoder names to match the production probe pipeline. The predicate also lowercases its inputs so call sites need not
    // normalize their own strings.
    const codecs = makeCodecs({ decoders: { h264: [ "h264", "h264_qsv" ], hevc: ["hevc"] } });

    // Positive lookups - both casings resolve to the same entry.
    assert.equal(codecs.hasDecoder("h264", "h264_qsv"), true);
    assert.equal(codecs.hasDecoder("H264", "H264_QSV"), true, "both codec and decoder arguments must be case-insensitive");
    assert.equal(codecs.hasDecoder("hevc", "hevc"), true);

    // Negative lookups - decoder not advertised for this codec, codec not in the index, unrelated decoder.
    assert.equal(codecs.hasDecoder("h264", "h264_videotoolbox"), false, "decoder not advertised for h264 must return false");
    assert.equal(codecs.hasDecoder("vp9", "vp9"), false, "codec not in the index must return false");
    assert.equal(codecs.hasDecoder("h264", ""), false, "empty decoder name must not match any entry");
  });

  test("hasEncoder returns true only for advertised codec/encoder pairs, case-insensitively", () => {

    // Parallel to hasDecoder: the entry's encoder set is the authoritative source. We verify the positive match, the cross-codec isolation (an encoder advertised
    // for one codec must not match another), and the case-insensitivity contract.
    const codecs = makeCodecs({ encoders: { h264: [ "libx264", "h264_videotoolbox" ], hevc: ["libx265"] } });

    assert.equal(codecs.hasEncoder("h264", "libx264"), true);
    assert.equal(codecs.hasEncoder("H264", "LIBX264"), true);
    assert.equal(codecs.hasEncoder("hevc", "libx265"), true);

    assert.equal(codecs.hasEncoder("h264", "libx265"), false, "encoder advertised for hevc must not match h264");
    assert.equal(codecs.hasEncoder("hevc", "h264_videotoolbox"), false, "encoder advertised for h264 must not match hevc");
    assert.equal(codecs.hasEncoder("av1", "libaom-av1"), false, "codec not in the index must return false");
  });

  test("hasHwAccel returns true only for advertised accelerators, case-insensitively", () => {

    // The hwaccel set is a flat Set<string> rather than a Record, so the predicate's lookup is a single has() call. We verify the case-insensitivity contract and
    // the unadvertised-accel negative path.
    const codecs = makeCodecs({ hwAccels: [ "videotoolbox", "qsv" ] });

    assert.equal(codecs.hasHwAccel("videotoolbox"), true);
    assert.equal(codecs.hasHwAccel("VideoToolbox"), true, "hwaccel lookup must be case-insensitive");
    assert.equal(codecs.hasHwAccel("qsv"), true);
    assert.equal(codecs.hasHwAccel("cuda"), false, "unadvertised accelerator must return false");
    assert.equal(codecs.hasHwAccel(""), false);
  });

  test("empty capability fixture produces false for every predicate", () => {

    // The all-default fixture has empty decoder / encoder / hwaccel sets. Every predicate query must return false without throwing - this is the "unknown build /
    // skipped probe" conservative fallback the version-delegation tests already rely on implicitly.
    const codecs = makeCodecs();

    assert.equal(codecs.hasDecoder("h264", "h264"), false);
    assert.equal(codecs.hasEncoder("h264", "libx264"), false);
    assert.equal(codecs.hasHwAccel("videotoolbox"), false);
  });
});

describe("FfmpegCodecs - scalar getter surface", () => {

  test("hostSystem, cpuGeneration, gpuMem, ffmpegExec, verbose, ffmpegVersion reflect the state snapshot", () => {

    // Each getter is a one-line forward through `this.state.X`. The fixture builder wires every field through `FfmpegCodecs.fromState`, so this test also verifies the
    // public factory round-trips the input state without mutation.
    const codecs = makeCodecs({

      cpuGeneration: 11,
      ffmpegExec: "/usr/local/bin/ffmpeg",
      ffmpegVersion: "8.1.2",
      gpuMem: 256,
      hostSystem: "macOS.Apple",
      verbose: true
    });

    assert.equal(codecs.hostSystem, "macOS.Apple");
    assert.equal(codecs.cpuGeneration, 11);
    assert.equal(codecs.gpuMem, 256);
    assert.equal(codecs.ffmpegExec, "/usr/local/bin/ffmpeg");
    assert.equal(codecs.verbose, true);
    assert.equal(codecs.ffmpegVersion, "8.1.2");
  });

  test("getters return the documented defaults when the fixture builder fills in absent fields", () => {

    // Coverage for the fixture's default branch: when callers pass an empty init, every scalar resolves to the documented default. The defaults are part of the
    // fixture's contract (see `makeCodecs`), so this pins them to the documented values.
    const codecs = makeCodecs();

    assert.equal(codecs.hostSystem, "generic");
    assert.equal(codecs.cpuGeneration, 0);
    assert.equal(codecs.gpuMem, 0);
    assert.equal(codecs.ffmpegExec, "ffmpeg");
    assert.equal(codecs.verbose, false);
    assert.equal(codecs.ffmpegVersion, "6.1.1");
  });

  test("fromState directly constructs a class instance that carries the input snapshot", () => {

    // Bypass the fixture helper to exercise the public `FfmpegCodecs.fromState` factory head-on. This catches the case where the fixture builder might drift from the
    // factory's contract - both paths must produce equivalent instances.
    const codecs = FfmpegCodecs.fromState({

      codecs: {},
      cpuGeneration: 12,
      ffmpegExec: "ffmpeg-custom",
      ffmpegVersion: "7.0.1",
      ffmpegVersionParts: parseFfmpegVersionParts("7.0.1"),
      gpuMem: 0,
      hostSystem: "generic",
      hwAccels: new Set(),
      verbose: false
    });

    assert.equal(codecs.ffmpegExec, "ffmpeg-custom");
    assert.equal(codecs.cpuGeneration, 12);
    assert.equal(codecs.ffmpegMajorVersion, 7, "fromState-constructed instances still derive major version through the pure primitive");
    assert.equal(codecs.ffmpegAtLeast(7), true);
    assert.equal(codecs.ffmpegAtLeast(8), false);
  });
});

describe("FfmpegCodecs integration (real ffmpeg binary)", { skip: !ffmpegIntegrationEnabled }, () => {

  test("probe() against a real ffmpeg binary populates the codec index", async () => {

    const codecs = await FfmpegCodecs.probe({ log: silentLog() });

    assert.notEqual(codecs, null);
    assert.notEqual(codecs?.ffmpegVersion, "");
  });

  test("probe() honors a caller-supplied abort signal", async () => {

    const controller = new AbortController();

    controller.abort(new Error("cancelled"));

    // A pre-aborted signal causes every inner probe's execFile to reject with the abort reason. The factory returns `null` to signal that no usable state was
    // assembled; no partial / backdoor-seeded instance exists to leak incomplete state downstream.
    const codecs = await FfmpegCodecs.probe({ log: silentLog() }, { signal: controller.signal });

    assert.equal(codecs, null);
  });
});
