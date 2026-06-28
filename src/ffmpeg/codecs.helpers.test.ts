/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/codecs.helpers.test.ts: Unit tests for the makeCodecs factory in codecs.helpers.ts. The factory is the single chokepoint every test file uses to stub
 * `FfmpegCodecs`, so a regression here would silently corrupt the encoder-pipeline, options, record, stream, and exec test suites that consume it. Coverage targets
 * the convention's enumerated criteria: every default applied, every transformation (case-folding, decoders/encoders pivot), and the version-derivation surface.
 */
import { describe, test } from "node:test";
import type { CodecsInit } from "./codecs.helpers.ts";
import assert from "node:assert/strict";
import { makeCodecs } from "./codecs.helpers.ts";

describe("makeCodecs - defaults", () => {

  test("returns a fully-populated stand-in when called with no init at all", () => {

    const codecs = makeCodecs();

    // Every documented default per the JSDoc must be present and observable through the public surface.
    assert.equal(codecs.ffmpegVersion, "6.1.1", "default ffmpegVersion must be 6.1.1");
    assert.equal(codecs.ffmpegMajorVersion, 6, "default ffmpegMajorVersion must derive from the version string");
    assert.equal(codecs.ffmpegExec, "ffmpeg", "default ffmpegExec must be \"ffmpeg\"");
    assert.equal(codecs.cpuGeneration, 0, "default cpuGeneration must be 0 (unknown)");
    assert.equal(codecs.gpuMem, 0, "default gpuMem must be 0 (non-RPi)");
    assert.equal(codecs.hostSystem, "generic", "default hostSystem must be \"generic\"");
    assert.equal(codecs.verbose, false, "default verbose must be false");
  });

  test("default stand-in has no decoders, encoders, or hwAccels", () => {

    const codecs = makeCodecs();

    assert.equal(codecs.hasDecoder("h264", "h264"), false, "default stand-in must report no decoders");
    assert.equal(codecs.hasEncoder("h264", "libx264"), false, "default stand-in must report no encoders");
    assert.equal(codecs.hasHwAccel("videotoolbox"), false, "default stand-in must report no hardware accelerators");
  });
});

describe("makeCodecs - overrides", () => {

  test("ffmpegVersion override flows through to ffmpegMajorVersion and ffmpegAtLeast", () => {

    // The version-derived surface delegates to the same parseFfmpegVersionParts / ffmpegVersionAtLeast primitives the real class uses. A version override must
    // propagate to ffmpegMajorVersion (top-of-triple) and to ffmpegAtLeast comparisons - the masterclass contract is that test code never branches on version
    // semantics that the production code doesn't.
    const codecs = makeCodecs({ ffmpegVersion: "8.1.2" });

    assert.equal(codecs.ffmpegVersion, "8.1.2", "ffmpegVersion getter returns the override verbatim");
    assert.equal(codecs.ffmpegMajorVersion, 8, "ffmpegMajorVersion derives from the parsed version triple");
    assert.equal(codecs.ffmpegAtLeast(8), true, "8.1.2 must satisfy >= 8.0.0");
    assert.equal(codecs.ffmpegAtLeast(8, 1, 3), false, "8.1.2 must NOT satisfy >= 8.1.3");
    assert.equal(codecs.ffmpegAtLeast(9), false, "8.1.2 must NOT satisfy >= 9.0.0");
  });

  test("scalar overrides (cpuGeneration / gpuMem / hostSystem / verbose / ffmpegExec) flow through verbatim", () => {

    const codecs = makeCodecs({

      cpuGeneration: 12,
      ffmpegExec: "/usr/local/bin/ffmpeg",
      gpuMem: 256,
      hostSystem: "macOS.Apple",
      verbose: true
    });

    assert.equal(codecs.cpuGeneration, 12);
    assert.equal(codecs.ffmpegExec, "/usr/local/bin/ffmpeg");
    assert.equal(codecs.gpuMem, 256);
    assert.equal(codecs.hostSystem, "macOS.Apple");
    assert.equal(codecs.verbose, true, "verbose=true must flow through (default is false)");
  });
});

describe("makeCodecs - decoders and encoders pivot", () => {

  test("decoders pivot from { codec: [decoders] } shape into the production format-keyed Set index", () => {

    const codecs = makeCodecs({

      decoders: {

        aac: ["aac"],
        h264: [ "h264", "h264_v4l2m2m" ]
      }
    });

    assert.equal(codecs.hasDecoder("h264", "h264"), true, "h264 decoder must be present after pivot");
    assert.equal(codecs.hasDecoder("h264", "h264_v4l2m2m"), true, "second h264 decoder must also be present");
    assert.equal(codecs.hasDecoder("aac", "aac"), true, "aac decoder must be present");
    assert.equal(codecs.hasDecoder("h264", "h264_videotoolbox"), false, "absent decoder must report false");
    assert.equal(codecs.hasDecoder("hevc", "hevc"), false, "absent codec format must report false");
  });

  test("encoders pivot the same way as decoders, on a separate channel", () => {

    const codecs = makeCodecs({

      encoders: {

        h264: [ "libx264", "h264_videotoolbox" ]
      }
    });

    assert.equal(codecs.hasEncoder("h264", "libx264"), true);
    assert.equal(codecs.hasEncoder("h264", "h264_videotoolbox"), true);

    // Decoders channel must remain empty - encoder-only init must not pollute decoder lookups.
    assert.equal(codecs.hasDecoder("h264", "libx264"), false, "encoder-only init must NOT register decoders");
  });

  test("decoders and encoders for the same codec both populate the same entry", () => {

    // When the same codec appears in both decoders and encoders, the pivot must merge into one format entry rather than overwriting. The production shape carries
    // both sets per format; the helper's `entryFor` cache enforces this.
    const codecs = makeCodecs({ decoders: { h264: ["h264"] }, encoders: { h264: ["libx264"] } });

    assert.equal(codecs.hasDecoder("h264", "h264"), true, "decoder must survive when encoder for the same codec is also present");
    assert.equal(codecs.hasEncoder("h264", "libx264"), true, "encoder must survive when decoder for the same codec is also present");
  });

  test("codec, decoder, and encoder names are case-folded on input (case-insensitive lookups)", () => {

    // The probe and lookup paths in production treat names as case-insensitive. The helper lowercases on insert so test code can pass mixed-case literals (matching
    // upstream FFmpeg output) without later case-mismatch surprises.
    const codecs = makeCodecs({ decoders: { H264: ["H264_V4L2M2M"] }, encoders: { HEVC: ["LIBX265"] }, hwAccels: ["VAAPI"] });

    assert.equal(codecs.hasDecoder("h264", "h264_v4l2m2m"), true, "lowercased lookup must hit case-folded decoder");
    assert.equal(codecs.hasDecoder("H264", "H264_v4l2m2m"), true, "mixed-case lookup must also hit (lookup itself folds)");
    assert.equal(codecs.hasEncoder("hevc", "libx265"), true, "lowercased encoder lookup must hit");
    assert.equal(codecs.hasHwAccel("vaapi"), true, "lowercased hwAccel lookup must hit");
  });
});

describe("makeCodecs - hardware accelerators", () => {

  test("hwAccels override populates the accelerator set and lookups are case-insensitive", () => {

    const codecs = makeCodecs({ hwAccels: [ "videotoolbox", "VAAPI", "qsv" ] });

    assert.equal(codecs.hasHwAccel("videotoolbox"), true);
    assert.equal(codecs.hasHwAccel("vaapi"), true, "uppercase input must lower-fold for lookup");
    assert.equal(codecs.hasHwAccel("qsv"), true);
    assert.equal(codecs.hasHwAccel("nvenc"), false, "absent accelerator must report false");
  });
});

describe("makeCodecs - type contract", () => {

  test("CodecsInit accepts a partial bag - missing fields fall to defaults", () => {

    // Type-level confirmation: passing `{}` is a valid CodecsInit. The factory returns a working stand-in. This pins the partial contract that tests rely on.
    const init: CodecsInit = {};
    const codecs = makeCodecs(init);

    assert.equal(codecs.hostSystem, "generic", "empty init must fall to default hostSystem");
  });

  test("CodecsInit rejects unknown fields at the type level", () => {

    // @ts-expect-error - "unknownField" is not in CodecsInit; future widening would silence this directive and surface the loosened contract during typecheck.
    const init: CodecsInit = { unknownField: 42 };

    void init;
  });
});
