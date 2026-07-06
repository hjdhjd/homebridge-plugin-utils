/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/options.test.ts: Unit tests for the FfmpegOptions encoder / decoder arg builder. Pure-function coverage driven by an in-memory FfmpegCodecs stand-in so the
 * permutations of host system (macOS.Apple / macOS.Intel / raspbian / generic+QSV / plain generic), hardware decoding/transcoding flags, FFmpeg version (7.x vs 8.x
 * flows), and encoder options are exercised without spawning any processes.
 *
 * The class under test only consumes a narrow slice of `FfmpegCodecs` - three capability predicates (`hasDecoder`, `hasEncoder`, `hasHwAccel`), the `ffmpegAtLeast`
 * version-comparison method, and three readonly scalars (`cpuGeneration`, `gpuMem`, `hostSystem`). Those are what the fixture builder supplies; the real probe / spawn
 * infrastructure is out of scope for this file and covered separately by `codecs.test.ts` plus the integration suite at the bottom of this file, which auto-enables
 * when an FFmpeg binary is discoverable on PATH. See `integration.helpers.ts` for the full gate semantics.
 */
import type { FfmpegOptionsConfig, VideoEncoderOptions } from "./options.ts";
import type { H264Level as H264LevelEnum, H264Profile as H264ProfileEnum } from "homebridge";
import { before, describe, test } from "node:test";
import { AudioRecordingCodecType } from "./hap-enums.ts";
import type { CodecsInit } from "./codecs.helpers.ts";
import { FfmpegCodecs } from "./codecs.ts";
import { FfmpegOptions } from "./options.ts";
import { RPI4_HW_TRANSCODE_MAX_PIXELS } from "./settings.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { ffmpegIntegrationEnabled } from "./integration.helpers.ts";
import { makeCodecs } from "./codecs.helpers.ts";
import { promisify } from "node:util";
import { silentLog } from "../testing.helpers.ts";

const execFileAsync = promisify(execFile);

// Mirror the H264 const enum values locally. `verbatimModuleSyntax` disallows value imports of ambient const enums, and options.ts itself uses this same mirror pattern
// for `H264Level` / `H264Profile` (single-consumer mirrors stay co-located with their sole production consumer); we replicate the shape here so tests read in the
// canonical HAP-style names rather than bare numbers. `AudioRecordingCodecType` is hoisted to `hap-enums.ts` because it has multiple consumers, so we import that one
// directly from the shared SSOT module.
const H264Level = { LEVEL3_1: 0 as H264LevelEnum.LEVEL3_1, LEVEL3_2: 1 as H264LevelEnum.LEVEL3_2, LEVEL4_0: 2 as H264LevelEnum.LEVEL4_0 };
const H264Profile = { BASELINE: 0 as H264ProfileEnum.BASELINE, HIGH: 2 as H264ProfileEnum.HIGH, MAIN: 1 as H264ProfileEnum.MAIN };

// Shape of the hardware-mode argument to makeOptions. Kept as its own type so the named MODE presets below can be typed against it without importing from the
// function signature.
interface MakeOptionsFlags {

  crop?: FfmpegOptionsConfig["crop"];
  hardwareDecoding?: boolean;
  hardwareTranscoding?: boolean;
}

// Build a config + FfmpegOptions pair in one call. We intentionally pass the caller's hardware flags through so the test can observe the resolved state on the
// returned instance's `config` after construction - `configureHwAccel` is free to flip them.
function makeOptions(codecsInit: CodecsInit, flags: MakeOptionsFlags = {}):
{ config: FfmpegOptionsConfig; options: FfmpegOptions } {

  const config: FfmpegOptionsConfig = {

    codecSupport: makeCodecs(codecsInit),
    hardwareDecoding: flags.hardwareDecoding ?? false,
    hardwareTranscoding: flags.hardwareTranscoding ?? false,
    log: silentLog(),
    name: (): string => "test-camera",
    ...(flags.crop ? { crop: flags.crop } : {})
  };

  return { config, options: new FfmpegOptions(config) };
}

// Platform codec presets. Each captures the minimum codec / accelerator / host combination that makes the targeted FFmpeg hardware path live. Tests spread a preset and
// override only what varies per case (ffmpegVersion, cpuGeneration, host variant for Intel Mac, extra decoders for AV1), so the test body surfaces its *variation*
// rather than re-declaring the shared platform scaffold. Axes that shift between tests (cpuGeneration, ffmpegVersion) intentionally stay off the presets.

// Intel QSV hardware acceleration. H.264 encode + H.264/HEVC decode are the baseline that makes configureHwAccel autopromote hardware decoding on a generic host.
const QSV_CODECS: CodecsInit = {

  decoders: { h264: ["h264_qsv"], hevc: ["hevc_qsv"] },
  encoders: { h264: ["h264_qsv"] },
  hostSystem: "generic",
  hwAccels: ["qsv"]
};

// Apple VideoToolbox hardware acceleration. `hostSystem` defaults to macOS.Apple; Intel Mac tests override with `{ ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }`.
const VIDEOTOOLBOX_CODECS: CodecsInit = {

  encoders: { h264: ["h264_videotoolbox"] },
  hostSystem: "macOS.Apple",
  hwAccels: ["videotoolbox"]
};

// Raspberry Pi V4L2 hardware acceleration. `gpuMem: 256` sits comfortably above the RPI4_GPU_MINIMUM floor; tests that specifically exercise the under-floor fallback
// spread with `{ ...RASPBIAN_CODECS, gpuMem: 64 }`.
const RASPBIAN_CODECS: CodecsInit = {

  encoders: { h264: ["h264_v4l2m2m"] },
  gpuMem: 256,
  hostSystem: "raspbian"
};

// Hardware-mode presets. Named combinations of the two plugin-level flags (`hardwareDecoding`, `hardwareTranscoding`) that the tests discriminate on. Software-only
// mode is the default - `makeOptions(codecs)` with no second arg produces it - so it needs no preset. Per-test boolean sprawl migrates to these three names.
const HW_FULL:      MakeOptionsFlags = { hardwareDecoding: true,  hardwareTranscoding: true  };
const HW_TRANSCODE: MakeOptionsFlags = { hardwareDecoding: false, hardwareTranscoding: true  };
const HW_DECODE:    MakeOptionsFlags = { hardwareDecoding: true,  hardwareTranscoding: false };

// Canonical HomeKit-shaped encoder options used as the input to streamEncoder / recordEncoder / defaultVideoEncoderOptions. The fields that individual tests vary
// (hardwareDecoding, hardwareTranscoding, smartQuality, fps vs inputFps, etc.) are overridden via the spread in each call.
const BASE_ENCODER_OPTIONS: VideoEncoderOptions = {

  bitrate: 3000,
  fps: 30,
  height: 1080,
  idrInterval: 2,
  inputFps: 30,
  level: H264Level.LEVEL4_0,
  profile: H264Profile.HIGH,
  smartQuality: true,
  width: 1920
};

// Assert an ordered `-key value` pair is present in the args array. FFmpeg option parsing is strictly positional, so the key and value must appear adjacently.
function assertHasArg(args: readonly string[], key: string, value?: string): void {

  const index = args.indexOf(key);

  assert.notEqual(index, -1, "expected arg " + key + " in " + JSON.stringify(args));

  if(value !== undefined) {

    assert.equal(args[index + 1], value, "expected arg " + key + " to be followed by " + value);
  }
}

// Extract the value that follows `-filter:v` in an FFmpeg args array, asserting it is present. Returns the comma-separated filter chain string so callers can reason
// about filter ordering and substring presence with simple .includes / indexOf checks.
function filterChain(args: readonly string[]): string {

  const index = args.indexOf("-filter:v");

  assert.notEqual(index, -1, "expected a -filter:v arg in " + JSON.stringify(args));

  const chain = args[index + 1];

  assert.ok(chain, "expected -filter:v to be followed by a filter chain");

  return chain;
}

describe("FfmpegOptions - configureHwAccel", () => {

  test("disables hardware decoding when the requested hardware accelerator is missing on macOS", () => {

    // Request hardware decoding on macOS.Apple without advertising the `videotoolbox` accelerator. configureHwAccel's validator path must flip the decoding flag to
    // false and leave the user with software decoding; the side effect is the whole point of the bidirectional flag semantics.
    const { config } = makeOptions({ hostSystem: "macOS.Apple" }, HW_DECODE);

    assert.equal(config.hardwareDecoding, false);
  });

  test("disables both flags on Raspberry Pi when GPU memory is below the minimum threshold", () => {

    // RPI4_GPU_MINIMUM is 128 MB. At 64 MB we are below the floor; both flags fall back to software regardless of what the caller requested.
    const { config } = makeOptions({ ...RASPBIAN_CODECS, gpuMem: 64 }, HW_FULL);

    assert.equal(config.hardwareDecoding, false);
    assert.equal(config.hardwareTranscoding, false);
  });

  test("disables hardware decoding on Raspberry Pi even with enough GPU memory, per the current FFmpeg 7 workaround", () => {

    // The Raspberry Pi branch comments out the decoder validation and unconditionally disables hardware decoding (the h264_v4l2m2m decoder is flaky on FFmpeg 7+). The
    // encoder path stays available when the encoder codec is advertised.
    const { config } = makeOptions(RASPBIAN_CODECS, HW_FULL);

    assert.equal(config.hardwareDecoding, false, "RPi hardware decoding is disabled regardless of GPU memory");
    assert.equal(config.hardwareTranscoding, true, "RPi hardware encoding stays on when the encoder codec is advertised");
  });

  test("turns Intel Quick Sync on automatically when QSV codecs and hwaccel are all present", () => {

    // Generic host + full QSV codec set + qsv hwaccel = autopromote hardware decoding to true even when the caller only asked for hardware transcoding. Exercises the
    // "generic + qsv" autodetect branch.
    const { config } = makeOptions(QSV_CODECS, HW_TRANSCODE);

    assert.equal(config.hardwareDecoding, true, "QSV autopromotes hardware decoding to true");
    assert.equal(config.hardwareTranscoding, true);
  });

  test("falls back to software when the generic host has no QSV support", () => {

    // Both flags must be disabled when nothing QSV-adjacent is advertised. The default-case fallback in the generic branch covers this.
    const { config } = makeOptions({ hostSystem: "generic" }, HW_TRANSCODE);

    assert.equal(config.hardwareTranscoding, false);
    assert.equal(config.hardwareDecoding, false);
  });

  test("disables hardware transcoding on macOS when the h264_videotoolbox encoder is missing", () => {

    // configureHwAccel's transcoding block runs validateEncoder("h264_videotoolbox") on macOS. When the encoder is not advertised by the codec support, the validator
    // flips hardwareTranscoding to false. Decoding is independent - it runs its own validation against hwAccels and is orthogonal to the encoder check.
    const { config } = makeOptions({ hostSystem: "macOS.Apple", hwAccels: ["videotoolbox"] }, HW_FULL);

    assert.equal(config.hardwareTranscoding, false, "missing h264_videotoolbox encoder must disable hardware transcoding");
    assert.equal(config.hardwareDecoding, true, "hardware decoding validation is independent of the encoder check");
  });

  test("disables hardware transcoding on Raspberry Pi when the h264_v4l2m2m encoder is missing", () => {

    // On raspbian, validateEncoder("h264_v4l2m2m") gates hardwareTranscoding. Without the encoder the fallback is software transcoding. GPU memory is set above the
    // floor so configureHwAccel reaches the encoder validation step rather than short-circuiting on memory.
    const { config } = makeOptions({ gpuMem: 256, hostSystem: "raspbian" }, HW_FULL);

    assert.equal(config.hardwareTranscoding, false, "missing h264_v4l2m2m encoder must disable hardware transcoding");
    assert.equal(config.hardwareDecoding, false, "RPi hardware decoding is always disabled regardless of the encoder state");
  });

  test("macOS.Intel behaves identically to macOS.Apple (same switch case)", () => {

    // The configureHwAccel switch groups macOS.Apple and macOS.Intel under one case. A parallel test on the Intel variant locks in that grouping so a future refactor
    // that accidentally splits them (e.g., separate Intel-specific validation) surfaces as a test failure.
    const { config } = makeOptions({ ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }, HW_FULL);

    assert.equal(config.hardwareDecoding, true, "Intel Mac validates against videotoolbox the same way Apple Silicon does");
    assert.equal(config.hardwareTranscoding, true, "Intel Mac validates against h264_videotoolbox the same way Apple Silicon does");
  });
});

describe("FfmpegOptions - audioEncoder", () => {

  test("macOS prefers aac_at with AAC_ELD cbr by default", () => {

    const { options } = makeOptions({ encoders: { aac: ["aac_at"] }, hostSystem: "macOS.Apple" });
    const args = options.audioEncoder();

    assertHasArg(args, "-codec:a", "aac_at");
    assertHasArg(args, "-aac_at_mode", "cbr");
  });

  test("macOS aac_at AAC_LC uses vbr with -q:a 2", () => {

    const { options } = makeOptions({ encoders: { aac: ["aac_at"] }, hostSystem: "macOS.Apple" });
    const args = options.audioEncoder({ codec: AudioRecordingCodecType.AAC_LC });

    assertHasArg(args, "-codec:a", "aac_at");
    assertHasArg(args, "-aac_at_mode", "vbr");
    assertHasArg(args, "-q:a", "2");
  });

  test("macOS falls back to libfdk_aac when aac_at is unavailable", () => {

    // Even on macOS, a missing aac_at encoder forces the default path. We confirm the codec swap and the afterburner flag.
    const { options } = makeOptions({ encoders: { aac: ["libfdk_aac"] }, hostSystem: "macOS.Apple" });
    const args = options.audioEncoder();

    assertHasArg(args, "-codec:a", "libfdk_aac");
    assertHasArg(args, "-afterburner", "1");
  });

  test("non-macOS uses libfdk_aac; AAC_ELD has no vbr flag, AAC_LC adds -vbr 4", () => {

    const { options } = makeOptions({ encoders: { aac: ["libfdk_aac"] }, hostSystem: "generic" });
    const eldArgs = options.audioEncoder({ codec: AudioRecordingCodecType.AAC_ELD });

    assertHasArg(eldArgs, "-codec:a", "libfdk_aac");
    assert.equal(eldArgs.includes("-vbr"), false, "AAC_ELD must not carry -vbr");

    const lcArgs = options.audioEncoder({ codec: AudioRecordingCodecType.AAC_LC });

    assertHasArg(lcArgs, "-vbr", "4");
  });

  test("returns an empty array when no AAC encoder is advertised on a non-macOS host", () => {

    // The default path only emits arguments when libfdk_aac is present; without it, the caller gets an empty array. Tests the "essentially dead in the water" branch.
    const { options } = makeOptions({ hostSystem: "generic" });

    assert.deepEqual(options.audioEncoder(), []);
  });
});

describe("FfmpegOptions - audioDecoder", () => {

  test("is the fixed string \"libfdk_aac\"", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    assert.equal(options.audioDecoder, "libfdk_aac");
  });
});

describe("FfmpegOptions - videoDecoder", () => {

  test("returns empty args when hardware decoding is disabled", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    assert.deepEqual(options.videoDecoder("h264"), []);
  });

  test("returns empty args for an unknown codec regardless of hardware state", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    // Unknown codecs short-circuit before the hardware branch, so the return is empty even when the caller misuses the API by passing "vp9" or similar.
    assert.deepEqual(options.videoDecoder("vp9"), []);
  });

  test("macOS hardware decoder emits -hwaccel videotoolbox", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_DECODE);
    const args = options.videoDecoder("h264");

    assertHasArg(args, "-hwaccel", "videotoolbox");
  });

  test("macOS FFmpeg 8.x also emits -hwaccel_output_format videotoolbox_vld", () => {

    // The 8.x branch carries an extra pair of args for explicit output-format selection. This test freezes that version-gated behavior.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_DECODE);
    const args = options.videoDecoder("h264");

    assertHasArg(args, "-hwaccel_output_format", "videotoolbox_vld");
  });

  test("QSV h264 decoder emits -hwaccel qsv, output format qsv, and h264_qsv codec", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const args = options.videoDecoder("h264");

    assertHasArg(args, "-hwaccel", "qsv");
    assertHasArg(args, "-hwaccel_output_format", "qsv");
    assertHasArg(args, "-codec:v", "h264_qsv");
  });

  test("QSV AV1 decoding is disabled when the CPU generation is less than 11", () => {

    // AV1 decode on Intel QSV requires 11th-generation silicon or newer. When the probed CPU generation falls below that, the decoder arg list must be empty even
    // though the codec is advertised. This guards the "hardware advertises but silicon cannot" gap that the class narrows deliberately.
    const { options } = makeOptions({

      ...QSV_CODECS,
      cpuGeneration: 10,
      decoders: { ...QSV_CODECS.decoders, av1: ["av1_qsv"] }
    }, HW_TRANSCODE);

    assert.deepEqual(options.videoDecoder("av1"), []);
  });

  test("QSV AV1 decoding is enabled on CPU generation 11 or newer", () => {

    const { options } = makeOptions({

      ...QSV_CODECS,
      cpuGeneration: 12,
      decoders: { ...QSV_CODECS.decoders, av1: ["av1_qsv"] }
    }, HW_TRANSCODE);
    const args = options.videoDecoder("av1");

    assertHasArg(args, "-codec:v", "av1_qsv");
  });

  test("normalizes h265 input to hevc", () => {

    // The argument normalization happens before the QSV map lookup. Callers can pass "h265" and get HEVC-QSV args back.
    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const args = options.videoDecoder("h265");

    assertHasArg(args, "-codec:v", "hevc_qsv");
  });

  test("macOS emits identical h264/hevc videotoolbox args (codec-agnostic for supported codecs)", () => {

    // The macOS branch in videoDecoder is codec-agnostic for h264 and hevc - both receive the same -hwaccel videotoolbox args. AV1 is gated separately (see the gate
    // tests below), so it's deliberately NOT asserted equal here.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_DECODE);
    const h264Args = options.videoDecoder("h264");
    const hevcArgs = options.videoDecoder("hevc");

    assert.deepEqual(h264Args, hevcArgs, "macOS videoDecoder must emit identical args for h264 and hevc");
    assertHasArg(h264Args, "-hwaccel", "videotoolbox");
    assertHasArg(h264Args, "-hwaccel_output_format", "videotoolbox_vld");
  });

  test("macOS pre-8.x videoDecoder omits -hwaccel_output_format for h264/hevc", () => {

    // The `-hwaccel_output_format videotoolbox_vld` arg only appears on FFmpeg 8.x. Pre-8.x emits just `-hwaccel videotoolbox`. Exercised on h264 (AV1 on pre-8.x is
    // the gate-matrix concern, covered separately below).
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1" }, HW_DECODE);
    const args = options.videoDecoder("h264");

    assertHasArg(args, "-hwaccel", "videotoolbox");
    assert.equal(args.includes("-hwaccel_output_format"), false, "pre-8.x macOS must not emit -hwaccel_output_format");
  });

  test("macOS AV1 hardware decode is enabled on Apple Silicon M3+ + FFmpeg 8.x (all three conditions met)", () => {

    // AV1 hardware decode via VideoToolbox requires: (a) Apple Silicon M3+ (cpuGeneration >= 3), (b) FFmpeg 8.0 or newer, (c) hostSystem macOS.Apple. All three must
    // hold. cpuGeneration mirrors the M-series generation (M3 maps to 3, M4 maps to 4, ...).
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 3, ffmpegVersion: "8.0" }, HW_DECODE);
    const args = options.videoDecoder("av1");

    assertHasArg(args, "-hwaccel", "videotoolbox");
    assertHasArg(args, "-hwaccel_output_format", "videotoolbox_vld");
  });

  test("macOS AV1 hardware decode returns [] on pre-M3 Apple Silicon (cpuGeneration < 3)", () => {

    // M1 and M2 lack AV1 hardware decode. Emitting -hwaccel videotoolbox anyway would cause FFmpeg to either fall back to software or error. Returning [] makes the
    // fallback explicit and safe.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 2, ffmpegVersion: "8.0" }, HW_DECODE);

    assert.deepEqual(options.videoDecoder("av1"), [], "AV1 on pre-M3 Apple Silicon must return [] so FFmpeg falls back to software decode");
  });

  test("macOS AV1 hardware decode returns [] on M3+ Apple Silicon with FFmpeg 7.x (VT AV1 decoder absent pre-8.0)", () => {

    // FFmpeg 8.0 was the first release to ship the VideoToolbox AV1 decoder. Emitting -hwaccel videotoolbox on an older FFmpeg build would cause a runtime failure
    // even on otherwise-capable M3+ silicon. The gate must treat the FFmpeg version as a hard floor regardless of hardware generation.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 3, ffmpegVersion: "7.1" }, HW_DECODE);

    assert.deepEqual(options.videoDecoder("av1"), [], "AV1 on FFmpeg 7.x must return [] - VideoToolbox AV1 decoder requires FFmpeg 8.0+");
  });

  test("macOS.Intel AV1 hardware decode returns [] regardless of FFmpeg version (no Intel VT AV1 support ever)", () => {

    // Intel Macs never shipped AV1 hardware decode through VideoToolbox. The gate returns [] independent of ffmpegVersion - Intel Mac is a hard "no" for AV1.
    const eightX = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0", hostSystem: "macOS.Intel" }, HW_DECODE);

    assert.deepEqual(eightX.options.videoDecoder("av1"), [], "AV1 on Intel Mac (FFmpeg 8.x) must return []");

    const sevenX = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1", hostSystem: "macOS.Intel" }, HW_DECODE);

    assert.deepEqual(sevenX.options.videoDecoder("av1"), [], "AV1 on Intel Mac (FFmpeg 7.x) must return []");
  });

  test("macOS h264/hevc still emit args on pre-M3 Apple Silicon (the AV1 gate is AV1-specific)", () => {

    // Regression guard: the AV1 gate must not accidentally block h264 or hevc on older silicon. Without this test a future refactor could widen the gate and silently
    // break hardware decode for the common-case codecs on M1 / M2.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 2, ffmpegVersion: "8.0" }, HW_DECODE);

    assertHasArg(options.videoDecoder("h264"), "-hwaccel", "videotoolbox");
    assertHasArg(options.videoDecoder("hevc"), "-hwaccel", "videotoolbox");
  });

  test("macOS h264/hevc still emit args on FFmpeg 7.x (the AV1 gate's version check is AV1-specific)", () => {

    // Companion regression guard: the FFmpeg-version component of the AV1 gate must not accidentally block h264 or hevc on pre-8.0 builds. VT h264 and hevc decoders
    // have been available for many FFmpeg versions and must continue to emit args on 7.x.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 3, ffmpegVersion: "7.1" }, HW_DECODE);

    assertHasArg(options.videoDecoder("h264"), "-hwaccel", "videotoolbox");
    assertHasArg(options.videoDecoder("hevc"), "-hwaccel", "videotoolbox");
  });

  test("macOS.Intel h264/hevc still emit args (the AV1 gate is AV1-specific)", () => {

    // Same regression guard for Intel Mac: the AV1 gate must not accidentally block h264 or hevc.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0", hostSystem: "macOS.Intel" }, HW_DECODE);

    assertHasArg(options.videoDecoder("h264"), "-hwaccel", "videotoolbox");
    assertHasArg(options.videoDecoder("hevc"), "-hwaccel", "videotoolbox");
  });
});

describe("FfmpegOptions - streamEncoder (software path)", () => {

  test("falls back to libx264 with smart-quality CRF when hardware transcoding is off", () => {

    const { options } = makeOptions({ hostSystem: "generic" });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: true });

    assertHasArg(args, "-codec:v", "libx264");
    assertHasArg(args, "-preset", "veryfast");
    assertHasArg(args, "-profile:v", "high");
    assertHasArg(args, "-level:v", "4.0");
    assertHasArg(args, "-bf", "0");
    assertHasArg(args, "-crf", "20");
    assertHasArg(args, "-maxrate", "3064k");
    assertHasArg(args, "-bufsize", "6000k");
  });

  test("libx264 without smart quality uses -b:v and omits -crf", () => {

    const { options } = makeOptions({ hostSystem: "generic" });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false });

    assertHasArg(args, "-b:v", "3000k");
    assertHasArg(args, "-maxrate", "3000k");
    assert.equal(args.includes("-crf"), false, "non-smart-quality path must not emit -crf");
  });

  test("libx264 filter chain frontloads fps filter when output fps is lower than input fps", () => {

    // When downsampling, the fps filter should come before the scale filter so the scaler does less work. We find the -filter:v arg and inspect its comma-separated
    // order.
    const { options } = makeOptions({ hostSystem: "generic" });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 15, inputFps: 30 });
    const filter = args[args.indexOf("-filter:v") + 1];

    assert.ok(filter, "expected a filter chain");
    const fpsIdx = filter.indexOf("fps=15");
    const scaleIdx = filter.indexOf("scale=");

    assert.ok((fpsIdx !== -1) && (scaleIdx !== -1), "filter chain must contain both fps and scale filters");
    assert.ok(fpsIdx < scaleIdx, "fps filter must come before scale filter when downsampling");
  });

  test("libx264 filter chain puts pixel filters before fps filter when upsampling", () => {

    // When upsampling (fps > inputFps), pixel operations should run on the smaller source frame set before the fps filter duplicates them. This is the mirror-image of
    // the downsampling branch: different ordering, same rationale (do pixel work on the minimal frame count).
    const { options } = makeOptions({ hostSystem: "generic" });
    const chain = filterChain(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 60, inputFps: 30 }));

    const fpsIdx = chain.indexOf("fps=60");
    const scaleIdx = chain.indexOf("scale=");

    assert.ok((fpsIdx !== -1) && (scaleIdx !== -1), "filter chain must contain both fps and scale filters when upsampling");
    assert.ok(scaleIdx < fpsIdx, "scale filter must come before fps filter when upsampling - got " + chain);
  });

  test("libx264 with hardware decode + software transcode emits hwdownload in the filter chain", () => {

    // HW-decode + SW-transcode is the needsDownload=true case on the libx264 path. getHardwareTransferFilters splices the platform-appropriate download filter into
    // pixelFilters before the scale. Exercised here on macOS 8.x where the download pair is `hwdownload, format=nv12`.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_DECODE);
    const args = options.streamEncoder(BASE_ENCODER_OPTIONS);
    const chain = filterChain(args);

    assertHasArg(args, "-codec:v", "libx264");
    assert.ok(chain.includes("hwdownload"), "libx264 path with HW decode must emit hwdownload - got " + chain);
    assert.ok(chain.includes("format=nv12"), "libx264 path with HW decode on macOS 8.x must emit format=nv12 - got " + chain);
    const downloadIdx = chain.indexOf("hwdownload");
    const scaleIdx = chain.indexOf("scale=");

    assert.ok(downloadIdx < scaleIdx, "hwdownload must precede scale on the libx264 HW-decode path - got " + chain);
  });

  test("libx264 filter chain omits fps filter when input and output fps match", () => {

    const { options } = makeOptions({ hostSystem: "generic" });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 30, inputFps: 30 });
    const filter = args[args.indexOf("-filter:v") + 1];

    assert.ok(filter, "the filter slot must be populated even when no fps filter is needed");
    assert.equal(filter.includes("fps="), false, "matching fps must not produce an fps filter");
  });
});

describe("FfmpegOptions - streamEncoder (hardware paths)", () => {

  test("macOS.Apple hardware path emits h264_videotoolbox with smart-quality q:v 90", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: true });

    assertHasArg(args, "-codec:v", "h264_videotoolbox");
    assertHasArg(args, "-allow_sw", "1");
    assertHasArg(args, "-realtime", "1");
    assertHasArg(args, "-level:v", "0");
    assertHasArg(args, "-q:v", "90");
  });

  test("macOS.Apple without smart quality uses -b:v instead of -q:v", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false });

    assertHasArg(args, "-b:v", "3000k");
    assert.equal(args.includes("-q:v"), false);
  });

  test("macOS.Intel hardware path always uses -b:v (no q:v option available)", () => {

    // On Intel-based Macs the hardware API cannot honor a quality constraint, so -b:v is unconditional regardless of smartQuality.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: true });

    assertHasArg(args, "-codec:v", "h264_videotoolbox");
    assertHasArg(args, "-b:v", "3000k");
    assert.equal(args.includes("-q:v"), false);
  });

  test("macOS FFmpeg 8.x + hardware encoding only (software decoding) emits -init_hw_device videotoolbox=hw", () => {

    // When hardware transcoding is on but hardware decoding is off, the class initializes the hardware device explicitly. On FFmpeg 8.x this is a VideoToolbox device;
    // pre-8.x macOS does not emit an init_hw_device arg at all.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false });

    assertHasArg(args, "-init_hw_device", "videotoolbox=hw");
    assertHasArg(args, "-filter_hw_device", "hw");
  });

  test("raspbian hardware path emits h264_v4l2m2m with numeric profile and reset_timestamps", () => {

    // The RPi encoder wants numeric profile values (not "high"/"main" strings) and always sets -reset_timestamps 1. This path also skips level overrides entirely - the
    // v4l2m2m encoder manages levels itself.
    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const args = options.streamEncoder(BASE_ENCODER_OPTIONS);

    assertHasArg(args, "-codec:v", "h264_v4l2m2m");
    assertHasArg(args, "-profile:v", "100");
    assertHasArg(args, "-reset_timestamps", "1");
    assertHasArg(args, "-b:v", "3000k");
  });

  test("generic QSV hardware path emits h264_qsv with smart-quality -global_quality 20", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: true });

    assertHasArg(args, "-codec:v", "h264_qsv");
    assertHasArg(args, "-level:v", "0");
    assertHasArg(args, "-global_quality", "20");
  });

  test("QSV hardware encoding without hardware decoding emits -init_hw_device qsv=hw", () => {

    // Force software decoding at the options level (the class-level config with QSV autopromotes hardwareDecoding to true) so we exercise the SW-decode + HW-transcode
    // init path.
    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false });

    assertHasArg(args, "-init_hw_device", "qsv=hw");
  });

  test("hardware-transcoding flag in encoder options is clamped by the class-level capability", () => {

    // Even if the caller passes `hardwareTranscoding: true` in the options, an FfmpegOptions instance constructed with software-only resolved config must fall back to
    // libx264. This is the "options.ts is the single source of truth for resolved capability" contract.
    const { options } = makeOptions({ hostSystem: "generic" });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareTranscoding: true });

    assertHasArg(args, "-codec:v", "libx264");
  });

  test("QSV without smart quality uses -b:v instead of -global_quality", () => {

    // Mirror of the macOS / Intel smart-quality-off paths: when the caller opts out of smart quality, QSV switches from intelligent-constant-quality to a fixed average
    // bitrate via -b:v.
    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false });

    assertHasArg(args, "-b:v", "3000k");
    assert.equal(args.includes("-global_quality"), false, "QSV with smartQuality=false must not emit -global_quality");
  });

  test("macOS.Intel hardware path has no smartQuality fork: always -b:v, smartQuality only affects -maxrate headroom", () => {

    // Invariance contract: macOS.Intel's hardware encoder lacks a quality-constraint mode, so -b:v is unconditional regardless of smartQuality. smartQuality still
    // affects -maxrate (adds HOMEKIT_STREAMING_HEADROOM when true), but no -q:v ever appears. This pins both the presence of -b:v and the absence of -q:v across both
    // smartQuality values.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }, HW_FULL);
    const smartTrue = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: true });
    const smartFalse = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false });

    assertHasArg(smartTrue, "-b:v", "3000k");
    assertHasArg(smartTrue, "-maxrate", "3064k");
    assert.equal(smartTrue.includes("-q:v"), false, "macOS.Intel must never emit -q:v regardless of smartQuality - got " + JSON.stringify(smartTrue));

    assertHasArg(smartFalse, "-b:v", "3000k");
    assertHasArg(smartFalse, "-maxrate", "3000k");
    assert.equal(smartFalse.includes("-q:v"), false, "macOS.Intel must never emit -q:v regardless of smartQuality - got " + JSON.stringify(smartFalse));
  });

  test("raspbian hardware path has no smartQuality fork: always -b:v, smartQuality only affects -maxrate headroom", () => {

    // Same invariance contract for raspbian's v4l2m2m encoder: always -b:v, no quality-constraint mode available. smartQuality only shifts -maxrate.
    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const smartTrue = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: true });
    const smartFalse = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false });

    assertHasArg(smartTrue, "-b:v", "3000k");
    assertHasArg(smartTrue, "-maxrate", "3064k");
    assert.equal(smartTrue.includes("-q:v"), false, "raspbian must never emit -q:v regardless of smartQuality - got " + JSON.stringify(smartTrue));
    assert.equal(smartTrue.includes("-global_quality"), false, "raspbian must never emit -global_quality regardless of smartQuality");

    assertHasArg(smartFalse, "-b:v", "3000k");
    assertHasArg(smartFalse, "-maxrate", "3000k");
    assert.equal(smartFalse.includes("-q:v"), false, "raspbian must never emit -q:v regardless of smartQuality - got " + JSON.stringify(smartFalse));
    assert.equal(smartFalse.includes("-global_quality"), false, "raspbian must never emit -global_quality regardless of smartQuality");
  });

  test("macOS FFmpeg 7.x software-decode + hardware-transcode omits -init_hw_device (pre-8.x break)", () => {

    // The pre-8.x macOS branch in getHardwareDeviceInit breaks without emitting init_hw_device. The hardware encoder still works (via the existing device context),
    // but no explicit device initialization is emitted. This test locks the version-gated behavior so a future drop of the pre-8.x branch would be a visible change.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1" }, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false });

    assert.equal(args.includes("-init_hw_device"), false, "pre-8.x macOS must not emit -init_hw_device");
    assertHasArg(args, "-codec:v", "h264_videotoolbox");
  });

  test("macOS hardware-decode + hardware-transcode omits -init_hw_device (decoder already set it up)", () => {

    // getHardwareDeviceInit only fires when software decode is followed by hardware encode. When both are hardware, the decoder already initialized the device context
    // and re-initializing would be redundant. This test locks that contract.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_FULL);
    const args = options.streamEncoder(BASE_ENCODER_OPTIONS);

    assert.equal(args.includes("-init_hw_device"), false, "HW-decode + HW-transcode must not re-init the hardware device");
  });

  test("raspbian software-decode + hardware-transcode omits -init_hw_device (v4l2m2m needs no init)", () => {

    // The raspbian branch in getHardwareDeviceInit is an explicit break - v4l2m2m does not require device initialization. RPi's configureHwAccel force-disables
    // hardwareDecoding, so SW-decode + HW-transcode is the only practical path; asserting no init stands as the contract even as the decoder path evolves.
    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const args = options.streamEncoder(BASE_ENCODER_OPTIONS);

    assert.equal(args.includes("-init_hw_device"), false, "raspbian v4l2m2m hardware path must not emit -init_hw_device");
  });

  test("macOS.Apple hardware path emits -r <fps> when fps differs from inputFps", () => {

    // All hardware paths set the output framerate via -r rather than via filter, to maximize hardware pipeline efficiency. The arg is emitted only when fps !== inputFps.
    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 15, inputFps: 30 });

    assertHasArg(args, "-r", "15");
  });

  test("macOS.Apple hardware path omits -r when fps equals inputFps", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 30, inputFps: 30 });

    assert.equal(args.includes("-r"), false, "matching fps must not emit -r on macOS hardware path");
  });

  test("macOS.Intel hardware path emits -r <fps> when fps differs from inputFps", () => {

    // macOS.Intel has its own copy of the `-r` conditional inside streamEncoder's switch case. An explicit emit test guards against a future refactor that accidentally
    // drops the conditional from just the Intel branch; every other hardware platform already has its emit case pinned.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 15, inputFps: 30 });

    assertHasArg(args, "-r", "15");
  });

  test("raspbian hardware path emits -r <fps> when fps differs from inputFps", () => {

    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 20, inputFps: 30 });

    assertHasArg(args, "-r", "20");
  });

  test("QSV hardware path emits -r <fps> when fps differs from inputFps", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, fps: 25, inputFps: 30 });

    assertHasArg(args, "-r", "25");
  });
});

describe("FfmpegOptions - recordEncoder", () => {

  test("defaults to software libx264 on raspbian regardless of hardware transcoding flag", () => {

    // RPi cannot do hardware HKSV recording at present, so recordEncoder intentionally routes to defaultVideoEncoderOptions. This is behavior HKSV relies on.
    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const args = options.recordEncoder(BASE_ENCODER_OPTIONS);

    assertHasArg(args, "-codec:v", "libx264");
  });

  test("uses streamEncoder on non-raspbian platforms (including hardware paths)", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);
    const args = options.recordEncoder(BASE_ENCODER_OPTIONS);

    assertHasArg(args, "-codec:v", "h264_videotoolbox");
  });

  test("always disables smart quality for record encoding", () => {

    // Recording mutates the caller's options - `smartQuality = false` - before delegating. Behavior assertion: the -crf flag that smart-quality libx264 emits must not
    // appear here.
    const { options } = makeOptions({ hostSystem: "generic" });
    const args = options.recordEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: true });

    assert.equal(args.includes("-crf"), false, "record encoding must force smartQuality off, which suppresses -crf");
    assertHasArg(args, "-b:v", "3000k");
  });

  test("delegates to streamEncoder on generic QSV hosts (hardware path reachable through recordEncoder)", () => {

    // recordEncoder's switch has a `default` branch that falls through to streamEncoder. The existing macOS test covers one instance of that delegation; this test
    // exercises the QSV path specifically so regressions that short-circuit the generic branch (e.g., "recordEncoder on generic always routes to libx264") would fail.
    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const args = options.recordEncoder(BASE_ENCODER_OPTIONS);

    // QSV recordEncoder must route through streamEncoder's QSV branch.
    assertHasArg(args, "-codec:v", "h264_qsv");
    assert.equal(args.includes("-global_quality"), false, "recordEncoder forces smartQuality=false, so QSV's -global_quality must not appear");

    // With smartQuality forced off, QSV emits the -b:v bitrate arg instead of -global_quality.
    assertHasArg(args, "-b:v", "3000k");
  });
});

describe("FfmpegOptions - cropFilter", () => {

  test("returns a no-op filter when cropping is disabled", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    assert.equal(options.cropFilter, "crop=w=iw*100:h=ih*100:x=iw*0:y=ih*0");
  });

  test("builds a crop filter from the configured rectangle", () => {

    const { options } = makeOptions({ hostSystem: "generic" }, { crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 } });

    assert.equal(options.cropFilter, "crop=w=iw*0.5:h=ih*0.5:x=iw*0.25:y=ih*0.25");
  });

  test("hardware-path streamEncoder includes the crop filter when configured", () => {

    // Hardware path: crop is spliced into the filter chain ahead of the platform-specific scaler (see streamEncoder's videoFilters construction).
    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, { ...HW_FULL, crop: { height: 0.5, width: 0.5, x: 0.0, y: 0.0 } });
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("crop=w=iw*0.5"), "hardware-path filter chain must splice in the configured crop filter - got " + chain);
  });

  test("software-path streamEncoder includes the crop filter when configured", () => {

    // Software path: crop applies uniformly regardless of transcode backend. The libx264 pipeline splices crop between the hardware transfer step and the scale step so
    // the scaler's aspect ratio calculations operate on the cropped region, matching the placement on the hardware path and the snapshot path.
    const { options } = makeOptions({ hostSystem: "generic" }, { crop: { height: 0.5, width: 0.5, x: 0.0, y: 0.0 } });
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("crop=w=iw*0.5"), "software-path filter chain must splice in the configured crop filter - got " + chain);
  });

  test("raspbian hardware path includes the crop filter when configured", () => {

    // Per-platform crop coverage: ensure the hardware-path crop splice is present on raspbian, not just macOS. A refactor that moved the crop splice into a platform
    // handler and forgot to include it in raspbian's handler would go uncaught without this test.
    const { options } = makeOptions(RASPBIAN_CODECS, { ...HW_FULL, crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 } });
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("crop=w=iw*0.5"), "raspbian hardware-path filter chain must splice in the configured crop filter - got " + chain);
  });

  test("QSV hardware path includes the crop filter when configured", () => {

    // Per-platform crop coverage: same invariant for the generic QSV hardware path. FFmpeg's auto_scale handles the implicit hwdownload+hwupload bridge when no
    // explicit transfer appears between the crop and vpp_qsv.
    const { options } = makeOptions(QSV_CODECS, { ...HW_TRANSCODE, crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 } });
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("crop=w=iw*0.5"), "QSV hardware-path filter chain must splice in the configured crop filter - got " + chain);
  });

  // Crop ordering invariant: `crop` is a CPU-side filter and always sits on the CPU side of any transfer. Tests assert the exact ordering across the four crop
  // scenarios on a real transfer-direction matrix, so a future refactor cannot silently emit `[crop, hwdownload, scale]` (which would ask crop to operate on GPU
  // frames) or `[hwupload, crop, scale_vt]` (same problem after upload).

  test("crop ordering (software path, HW-decode + SW-encode): [hwdownload, crop, scale]", () => {

    // Transfer is a download (GPU->CPU). Crop sits AFTER download so it sees CPU frames. Exercised on macOS 8.x where the download pair is `hwdownload + format=nv12`.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" },
      { ...HW_DECODE, crop: { height: 0.75, width: 0.75, x: 0.0, y: 0.0 } });
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    const downloadIdx = chain.indexOf("hwdownload");
    const cropIdx = chain.indexOf("crop=w=iw*0.75");
    const scaleIdx = chain.indexOf("scale=-2:min(ih");

    assert.ok(downloadIdx >= 0, "expected hwdownload in chain - got " + chain);
    assert.ok(cropIdx > downloadIdx, "crop must follow hwdownload so it operates on CPU frames - got " + chain);
    assert.ok(scaleIdx > cropIdx, "scale must follow crop so aspect ratio calculations reflect the cropped region - got " + chain);
  });

  test("crop ordering (software path, SW-decode + SW-encode): [crop, scale] - no transfer, crop first", () => {

    // Fully software pipeline - no transfer emitted. Crop is still first so the scaler operates on the cropped region.
    const { options } = makeOptions({ hostSystem: "generic" }, { crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 } });
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    const cropIdx = chain.indexOf("crop=w=iw*0.5");
    const scaleIdx = chain.indexOf("scale=-2:min(ih");

    assert.ok(cropIdx >= 0, "expected crop in chain - got " + chain);
    assert.equal(chain.includes("hwdownload"), false, "no HW decode, so no download filter expected - got " + chain);
    assert.equal(chain.includes("hwupload"), false, "no HW encode, so no upload filter expected - got " + chain);
    assert.ok(scaleIdx > cropIdx, "scale must follow crop - got " + chain);
  });

  test("crop ordering (hardware path, SW-decode + HW-encode): [crop, hwupload, scaler]", () => {

    // Transfer is an upload (CPU->GPU). Crop sits BEFORE upload so it sees CPU frames before they move to the GPU. Exercised on macOS 8.x where the upload filter is
    // `hwupload` and the scaler is `scale_vt`.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" },
      { ...HW_FULL, crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 } });
    const chain = filterChain(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false }));

    const cropIdx = chain.indexOf("crop=w=iw*0.5");
    const uploadIdx = chain.indexOf("hwupload");
    const scalerIdx = chain.indexOf("scale_vt=");

    assert.ok(cropIdx >= 0, "expected crop in chain - got " + chain);
    assert.ok(uploadIdx > cropIdx, "hwupload must follow crop so frames transition GPU-ward AFTER the CPU-side crop - got " + chain);
    assert.ok(scalerIdx > uploadIdx, "scale_vt must follow hwupload so it operates on GPU frames - got " + chain);
  });

  test("crop ordering (hardware path, HW-decode + HW-encode): [crop, scaler] - no explicit transfer, FFmpeg auto_scale bridges", () => {

    // Both HW - no transfer emitted. The chain is just [crop, scale_vt]. FFmpeg's auto_scale auto-inserts an implicit download+crop+upload around the CPU-side crop
    // when the source is GPU-resident. This is the baseline behavior that has worked in production; documented here so any future change that accidentally inserts an
    // explicit transfer (or removes the crop) fails the test.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" },
      { ...HW_FULL, crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 } });
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    const cropIdx = chain.indexOf("crop=w=iw*0.5");
    const scalerIdx = chain.indexOf("scale_vt=");

    assert.ok(cropIdx >= 0, "expected crop in chain - got " + chain);
    assert.ok(scalerIdx > cropIdx, "scaler must follow crop - got " + chain);
    assert.equal(chain.includes("hwdownload"), false, "no explicit hwdownload - FFmpeg auto_scale bridges - got " + chain);
    assert.equal(chain.includes("hwupload"), false, "no explicit hwupload - FFmpeg auto_scale bridges - got " + chain);
  });
});

describe("FfmpegOptions - hardwareDownloadFilters", () => {

  test("returns an empty array when hardware decoding is off", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    assert.deepEqual(options.hardwareDownloadFilters, []);
  });

  test("macOS FFmpeg 8.x emits hwdownload + format=nv12 when moving from VideoToolbox to software", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.1" }, HW_DECODE);

    assert.deepEqual(options.hardwareDownloadFilters, [ "hwdownload", "format=nv12" ]);
  });

  test("macOS pre-8.x does not emit hwdownload filters", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1" }, HW_DECODE);

    assert.deepEqual(options.hardwareDownloadFilters, []);
  });

  test("generic (QSV-like) platforms emit a plain hwdownload", () => {

    // A generic host with hardware decoding on and transcoding off corresponds to "downloaded for software encode" - the base platform path emits the simple
    // hwdownload filter. QSV advertisement causes configureHwAccel to promote hardwareDecoding to true. The `hardwareDownloadFilters` getter then internally pins
    // `hardwareTranscoding: false` when delegating to `getHardwareTransferFilters`, which routes to the generic-host download branch and emits a plain `hwdownload`.
    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);

    assert.deepEqual(options.hardwareDownloadFilters, ["hwdownload"]);
  });

  test("macOS.Intel FFmpeg 8.x emits hwdownload + format=nv12, matching Apple Silicon", () => {

    // macOS.Intel and macOS.Apple share the same switch case in getHardwareTransferFilters. A parallel test locks the grouping so a future Intel-specific branch cannot
    // silently diverge without failing a test.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0", hostSystem: "macOS.Intel" }, HW_DECODE);

    assert.deepEqual(options.hardwareDownloadFilters, [ "hwdownload", "format=nv12" ]);
  });

  test("raspbian emits no download filters (path is unreachable under real config but pinned here)", () => {

    // On raspbian, configureHwAccel force-disables hardwareDecoding, so `hardwareDownloadFilters` (gated by `this.config.hardwareDecoding`) always returns [] in a
    // real config. The assertion is about the unreachable-by-config code path in `getHardwareTransferFilters`: the raspbian download branch is an explicit break (no
    // download needed on Raspberry Pi). Pinning the behavior keeps the branch honest if someone later lifts the RPi hardwareDecoding force-disable.
    const { options } = makeOptions({ gpuMem: 256, hostSystem: "raspbian" });

    assert.deepEqual(options.hardwareDownloadFilters, []);
  });
});

describe("FfmpegOptions - hardware transfer filter matrix (upload paths)", () => {

  // The upload branches of getHardwareTransferFilters fire when software decode + hardware transcode is requested. Observed by passing `hardwareDecoding: false` in the
  // encoder options to an instance whose class-level hardwareTranscoding is true. The filter appears inside the streamEncoder's `-filter:v` chain via getScaleFilter.

  test("macOS FFmpeg 8.x emits hwupload for software-decode + hardware-transcode", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_FULL);
    const chain = filterChain(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false }));

    assert.ok(chain.includes("hwupload"), "macOS 8.x hardware-transcode-from-software-decode must splice in hwupload - got " + chain);
  });

  test("macOS pre-8.x emits no upload filter for software-decode + hardware-transcode", () => {

    // The macOS switch case on FFmpeg 7.x takes the `if` branch only on 8.x; otherwise it breaks without pushing. The filter chain still has the swScale, just no
    // upload step.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1" }, HW_FULL);
    const chain = filterChain(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false }));

    assert.equal(chain.includes("hwupload"), false, "pre-8.x macOS must not emit hwupload - got " + chain);
  });

  test("raspbian emits format=yuv420p for software-decode + hardware-transcode", () => {

    // RPi's upload branch pushes `format=yuv420p` to prime the v4l2m2m encoder's expected input layout. Note that in a real RPi config, hardwareDecoding is always off
    // (configureHwAccel force-disables it), so every RPi hardware-transcode path IS a software-decode-plus-hardware-transcode path - this assertion is load-bearing
    // for the common-case RPi filter chain, not a corner case.
    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("format=yuv420p"), "RPi hardware-transcode must splice in format=yuv420p - got " + chain);
  });

  test("generic QSV host emits hwupload for software-decode + hardware-transcode", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const chain = filterChain(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false }));

    assert.ok(chain.includes("hwupload"), "generic QSV hardware-transcode-from-software-decode must splice in hwupload - got " + chain);
  });
});

describe("FfmpegOptions - scale filter per platform", () => {

  // `getScaleFilter` is called from `streamEncoder`'s hardware branch only. Each platform has its own scaler - macOS 8.x uses the hardware VideoToolbox scaler
  // (scale_vt), pre-8.x falls back to software, raspbian always uses software scaling, generic with QSV uses the QSV post-processor (vpp_qsv). We observe the chosen
  // scaler by inspecting the streamEncoder filter chain on each platform.

  test("macOS.Apple FFmpeg 8.x hardware-transcode uses scale_vt", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_FULL);
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("scale_vt=-2:min(ih"), "macOS 8.x hardware path must use scale_vt - got " + chain);
  });

  test("macOS.Apple pre-8.x hardware-transcode falls back to software scale", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1" }, HW_FULL);
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.equal(chain.includes("scale_vt="), false, "pre-8.x macOS must not use scale_vt - got " + chain);
    assert.ok(chain.includes("scale=-2:min(ih"), "pre-8.x macOS must fall back to software scale - got " + chain);
  });

  test("macOS.Intel FFmpeg 8.x hardware-transcode uses scale_vt (same branch as Apple)", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0", hostSystem: "macOS.Intel" }, HW_FULL);
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("scale_vt=-2:min(ih"), "Intel Mac 8.x must share the scale_vt branch with Apple Silicon - got " + chain);
  });

  test("raspbian hardware-transcode uses software scale (v4l2m2m does not have a hardware scaler)", () => {

    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.equal(chain.includes("scale_vt="), false);
    assert.equal(chain.includes("vpp_qsv="), false);
    assert.ok(chain.includes("scale=-2:min(ih"), "RPi hardware path must use the software scale filter - got " + chain);
  });

  test("generic QSV hardware-transcode uses vpp_qsv with format=same", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);
    const chain = filterChain(options.streamEncoder(BASE_ENCODER_OPTIONS));

    assert.ok(chain.includes("vpp_qsv=format=same"), "generic QSV hardware path must use vpp_qsv - got " + chain);
    assert.ok(chain.includes("w=min(iw"), "vpp_qsv must carry the width scale expression");
    assert.ok(chain.includes("h=min(ih"), "vpp_qsv must carry the height scale expression");
  });
});

describe("FfmpegOptions - maxSourcePixels", () => {

  test("caps the stream context at 1080p on raspbian when hardware transcoding is enabled", () => {

    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);

    assert.equal(options.maxSourcePixels("stream"), RPI4_HW_TRANSCODE_MAX_PIXELS);
  });

  test("returns Infinity for the stream context when no hardware transcoding is active", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    assert.equal(options.maxSourcePixels("stream"), Infinity);
  });

  test("returns Infinity for the stream context on non-raspbian hosts even with hardware transcoding enabled", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);

    assert.equal(options.maxSourcePixels("stream"), Infinity);
  });

  test("returns Infinity for the stream context on macOS.Intel with hardware transcoding enabled (only raspbian is capped)", () => {

    // The raspbian-specific cap is the only special case in maxSourcePixels. Explicitly pin Intel Mac (distinct from the Apple Silicon case covered above) so the
    // absence of a per-Intel cap is frozen behavior.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }, HW_FULL);

    assert.equal(options.maxSourcePixels("stream"), Infinity);
  });

  test("returns Infinity for the stream context on generic QSV hosts with hardware transcoding enabled", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);

    assert.equal(options.maxSourcePixels("stream"), Infinity);
  });

  // Record-context coverage. The headline new fact: HKSV recording is uncapped on every host today, including a fully-hardware Raspberry Pi, because recording
  // software-encodes on the Pi and therefore never touches the GPU pixel ceiling that constrains the live stream.
  test("returns Infinity for the record context on raspbian with full hardware transcoding (recording software-encodes, so it is uncapped)", () => {

    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);

    assert.equal(options.maxSourcePixels("record"), Infinity);
  });

  test("returns Infinity for the record context on raspbian with transcode-only hardware (recording software-encodes, so it is uncapped)", () => {

    const { options } = makeOptions(RASPBIAN_CODECS, HW_TRANSCODE);

    assert.equal(options.maxSourcePixels("record"), Infinity);
  });

  test("returns Infinity for the record context on a non-raspbian hardware transcode host", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);

    assert.equal(options.maxSourcePixels("record"), Infinity);
  });

  // Agreement invariant. The ceiling and the encoder choice both derive from #hardwareEncodes, so on a fully-hardware Pi the record context must report both an uncapped
  // source (Infinity) AND a software encoder (libx264, never h264_v4l2m2m). Pinning the pair co-located freezes the shared-predicate wiring: a future change that flips
  // one without the other would fail here. This deliberately restates the libx264 fact from the recordEncoder block, kept to the single assertion pair the invariant
  // needs.
  test("agreement invariant on raspbian: the record context is uncapped AND recordEncoder emits the software encoder", () => {

    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);
    const args = options.recordEncoder(BASE_ENCODER_OPTIONS);

    assert.equal(options.maxSourcePixels("record"), Infinity);
    assertHasArg(args, "-codec:v", "libx264");
  });

  // Per-call-downgrade regression test, protecting the per-call downgrade path that production code exercises (record.ts passes a per-call hardwareTranscoding flag into
  // recordEncoder). On a non-raspbian hardware-capable host, recordEncoder consults the CLASS predicate (hardware) and delegates to streamEncoder, which then re-resolves
  // the per-call flag to software. Pinning that the per-call downgrade still wins protects the invariant the whole behavior-neutrality proof rests on: the predicate
  // only gates the short-circuit, never the final encoder choice.
  test("honors a per-call hardwareTranscoding:false downgrade on a non-raspbian hardware host (emits the software encoder)", () => {

    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);
    const args = options.recordEncoder({ ...BASE_ENCODER_OPTIONS, hardwareTranscoding: false });

    assertHasArg(args, "-codec:v", "libx264");
  });
});

describe("FfmpegOptions - H.264 profile / level encoding", () => {

  test("BASELINE / MAIN / HIGH profiles map to their canonical string values", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    const baseline = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.BASELINE });

    assertHasArg(baseline, "-profile:v", "baseline");

    const main = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.MAIN });

    assertHasArg(main, "-profile:v", "main");

    const high = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.HIGH });

    assertHasArg(high, "-profile:v", "high");
  });

  test("LEVEL3_1 / LEVEL3_2 / LEVEL4_0 map to their canonical level values on the libx264 path", () => {

    // The libx264 path honors the caller's requested level; only the macOS hardware path overrides to 0.
    const { options } = makeOptions({ hostSystem: "generic" });

    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, level: H264Level.LEVEL3_1 }), "-level:v", "3.1");
    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, level: H264Level.LEVEL3_2 }), "-level:v", "3.2");
    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, level: H264Level.LEVEL4_0 }), "-level:v", "4.0");
  });

  test("raspbian hardware path emits numeric profile values (BASELINE=66, MAIN=77, HIGH=100)", () => {

    // The v4l2m2m encoder wants the numeric H.264 profile encoding (66 / 77 / 100), not the "baseline" / "main" / "high" strings. getH264Profile's `numeric=true`
    // branch drives this. Cover all three profile values explicitly.
    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);

    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.BASELINE }), "-profile:v", "66");
    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.MAIN }), "-profile:v", "77");
    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.HIGH }), "-profile:v", "100");
  });

  test("macOS hardware path emits string profile values (BASELINE / MAIN / HIGH)", () => {

    // Unlike raspbian, macOS hardware encoders want the string encoding. Cover BASELINE and MAIN explicitly to complement the existing HIGH-only hardware test.
    const { options } = makeOptions(VIDEOTOOLBOX_CODECS, HW_FULL);

    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.BASELINE }), "-profile:v", "baseline");
    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.MAIN }), "-profile:v", "main");
  });

  test("QSV hardware path emits string profile values (BASELINE / MAIN)", () => {

    // QSV uses the same string profile encoding as macOS. Cover BASELINE and MAIN to complement the existing HIGH-only QSV test.
    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);

    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.BASELINE }), "-profile:v", "baseline");
    assertHasArg(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, profile: H264Profile.MAIN }), "-profile:v", "main");
  });
});

describe("FfmpegOptions - command-line snapshots (golden)", () => {

  // Full-arg-list snapshots for canonical platform x mode x codec scenarios. Each asserts the complete, ordered emission via `deepEqual`. These tests complement the
  // per-arg tests elsewhere in the file: per-arg tests verify individual behaviors in isolation and survive emit drift around them, whereas these snapshots catch
  // arg-list drift - a silently-added arg, a reordering, or a derivation change that slipped through - by failing loudly. When the emission shape legitimately
  // changes, updating the affected snapshots is the point: the diff forces the author to confront exactly what shifted.

  test("libx264 software encoder with HomeKit defaults (no crop, no HW)", () => {

    const { options } = makeOptions({ hostSystem: "generic" });

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "high",
      "-level:v", "4.0",
      "-noautoscale",
      "-bf", "0",
      "-filter:v", "scale=-2:min(ih\\, 1080):in_range=auto:out_range=auto",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-crf", "20"
    ]);
  });

  test("libx264 software encoder with crop configured", () => {

    // Software-path filter-chain invariant: on the libx264 path, `crop=...` sits on the CPU side of the filter chain - between the hardware-transfer step (empty here,
    // since this is SW-decode + SW-encode) and the scale filter. Crop always operates on system-memory frames, and the scaler must see the cropped region so aspect
    // ratio math reflects the crop.
    const { options } = makeOptions({ hostSystem: "generic" }, { crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 } });

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "high",
      "-level:v", "4.0",
      "-noautoscale",
      "-bf", "0",
      "-filter:v", "crop=w=iw*0.5:h=ih*0.5:x=iw*0.25:y=ih*0.25, scale=-2:min(ih\\, 1080):in_range=auto:out_range=auto",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-crf", "20"
    ]);
  });

  test("libx264 software encoder with HW decode + SW transcode (hwdownload + format=nv12 on macOS 8.x)", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_DECODE);

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "high",
      "-level:v", "4.0",
      "-noautoscale",
      "-bf", "0",
      "-filter:v", "hwdownload, format=nv12, scale=-2:min(ih\\, 1080):in_range=auto:out_range=auto",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-crf", "20"
    ]);
  });

  test("macOS.Apple VideoToolbox 8.x full HW with HomeKit defaults", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_FULL);

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "scale_vt=-2:min(ih\\, 1080)",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-q:v", "90"
    ]);
  });

  test("macOS.Apple VideoToolbox 8.x SW decode + HW transcode (init_hw_device + hwupload)", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, HW_FULL);

    assert.deepEqual(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false }), [

      "-init_hw_device", "videotoolbox=hw",
      "-filter_hw_device", "hw",
      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "hwupload, scale_vt=-2:min(ih\\, 1080)",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-q:v", "90"
    ]);
  });

  test("macOS.Apple VideoToolbox 7.x full HW (swScale fallback, no init)", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1" }, HW_FULL);

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "scale=-2:min(ih\\, 1080):in_range=auto:out_range=auto",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-q:v", "90"
    ]);
  });

  test("macOS.Apple VideoToolbox 7.x SW decode + HW transcode (no init, no hwupload, swScale)", () => {

    // Pre-8.x macOS emits no `-init_hw_device` (the break in getHardwareDeviceInit) and no `hwupload` in the filter chain (the break in getHardwareTransferFilters).
    // The scaler falls back to swScale on pre-8.x. This snapshot pins the complete shape so a refactor that accidentally merges the 8.x and 7.x branches fails visibly.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "7.1" }, HW_FULL);

    assert.deepEqual(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false }), [

      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "scale=-2:min(ih\\, 1080):in_range=auto:out_range=auto",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-q:v", "90"
    ]);
  });

  test("macOS.Intel VideoToolbox 8.x SW decode + HW transcode (init_hw_device + hwupload, Intel case)", () => {

    // macOS.Intel shares getHardwareDeviceInit and getScaleFilter branches with macOS.Apple on FFmpeg 8.x. This snapshot locks the grouping so a future refactor that
    // accidentally splits the Intel case from Apple (e.g., separate Intel-specific init args) fails. Intel uses -b:v always, no -q:v.
    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0", hostSystem: "macOS.Intel" }, HW_FULL);

    assert.deepEqual(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false }), [

      "-init_hw_device", "videotoolbox=hw",
      "-filter_hw_device", "hw",
      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "hwupload, scale_vt=-2:min(ih\\, 1080)",
      "-b:v", "3000k",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k"
    ]);
  });

  test("macOS.Intel VideoToolbox 8.x full HW (b:v not q:v)", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0", hostSystem: "macOS.Intel" }, HW_FULL);

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "h264_videotoolbox",
      "-allow_sw", "1",
      "-realtime", "1",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "scale_vt=-2:min(ih\\, 1080)",
      "-b:v", "3000k",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k"
    ]);
  });

  test("raspbian v4l2m2m full HW (numeric profile, reset_timestamps, format=yuv420p upload)", () => {

    const { options } = makeOptions(RASPBIAN_CODECS, HW_FULL);

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "h264_v4l2m2m",
      "-profile:v", "100",
      "-bf", "0",
      "-noautoscale",
      "-reset_timestamps", "1",
      "-filter:v", "format=yuv420p, scale=-2:min(ih\\, 1080):in_range=auto:out_range=auto",
      "-b:v", "3000k",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k"
    ]);
  });

  test("generic QSV full HW with smart quality (global_quality + vpp_qsv)", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);

    assert.deepEqual(options.streamEncoder(BASE_ENCODER_OPTIONS), [

      "-codec:v", "h264_qsv",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "vpp_qsv=format=same:w=min(iw\\, (iw / ih) * 1080):h=min(ih\\, 1080)",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3064k",
      "-global_quality", "20"
    ]);
  });

  test("generic QSV full HW without smart quality (b:v replaces global_quality, no headroom on maxrate)", () => {

    const { options } = makeOptions(QSV_CODECS, HW_TRANSCODE);

    assert.deepEqual(options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false }), [

      "-codec:v", "h264_qsv",
      "-profile:v", "high",
      "-level:v", "0",
      "-bf", "0",
      "-noautoscale",
      "-filter:v", "vpp_qsv=format=same:w=min(iw\\, (iw / ih) * 1080):h=min(ih\\, 1080)",
      "-g:v", "60",
      "-bufsize", "6000k",
      "-maxrate", "3000k",
      "-b:v", "3000k"
    ]);
  });

  test("videoDecoder: AV1 on M3+ Apple Silicon FFmpeg 8.x emits VideoToolbox args", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 3, ffmpegVersion: "8.0" }, HW_DECODE);

    assert.deepEqual(options.videoDecoder("av1"), [

      "-hwaccel", "videotoolbox",
      "-hwaccel_output_format", "videotoolbox_vld"
    ]);
  });

  test("videoDecoder: AV1 on pre-M3 Apple Silicon returns []", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 2, ffmpegVersion: "8.0" }, HW_DECODE);

    assert.deepEqual(options.videoDecoder("av1"), []);
  });

  test("videoDecoder: AV1 on M3+ Apple Silicon FFmpeg 7.x returns [] (VT AV1 decoder requires FFmpeg 8.0+)", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, cpuGeneration: 3, ffmpegVersion: "7.1" }, HW_DECODE);

    assert.deepEqual(options.videoDecoder("av1"), []);
  });

  test("videoDecoder: AV1 on Intel Mac returns [] (no VideoToolbox AV1 support ever)", () => {

    const { options } = makeOptions({ ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0", hostSystem: "macOS.Intel" }, HW_DECODE);

    assert.deepEqual(options.videoDecoder("av1"), []);
  });

  test("videoDecoder: AV1 on Intel QSV gen 12 emits QSV args", () => {

    const { options } = makeOptions({

      ...QSV_CODECS,
      cpuGeneration: 12,
      decoders: { ...QSV_CODECS.decoders, av1: ["av1_qsv"] }
    }, HW_TRANSCODE);

    assert.deepEqual(options.videoDecoder("av1"), [

      "-hwaccel", "qsv",
      "-hwaccel_output_format", "qsv",
      "-codec:v", "av1_qsv"
    ]);
  });

  test("videoDecoder: AV1 on Intel QSV gen 10 returns []", () => {

    const { options } = makeOptions({

      ...QSV_CODECS,
      cpuGeneration: 10,
      decoders: { ...QSV_CODECS.decoders, av1: ["av1_qsv"] }
    }, HW_TRANSCODE);

    assert.deepEqual(options.videoDecoder("av1"), []);
  });
});

describe("FfmpegOptions - recordEncoder equivalence with streamEncoder", () => {

  // Contract: on non-raspbian platforms, recordEncoder is pure delegation to streamEncoder with smartQuality forced off. Any drift between the two entry points would
  // surface as a difference in the emitted arg lists. Parametric across each non-raspbian platform preset so the delegation chain stays observable as the code evolves.

  const equivalenceCases: { codecs: CodecsInit; flags: MakeOptionsFlags; name: string }[] = [

    { codecs: { hostSystem: "generic" }, flags: HW_FULL, name: "software libx264 (no HW)" },
    { codecs: { ...VIDEOTOOLBOX_CODECS, ffmpegVersion: "8.0" }, flags: HW_FULL, name: "macOS.Apple VideoToolbox full HW" },
    { codecs: { ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }, flags: HW_FULL, name: "macOS.Intel VideoToolbox full HW" },
    { codecs: QSV_CODECS, flags: HW_TRANSCODE, name: "generic QSV full HW" }
  ];

  for(const { codecs, flags, name } of equivalenceCases) {

    test("recordEncoder on " + name + " matches streamEncoder({ ...options, smartQuality: false })", () => {

      const { options } = makeOptions(codecs, flags);
      const recordArgs = options.recordEncoder(BASE_ENCODER_OPTIONS);
      const streamArgs = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false });

      assert.deepEqual(recordArgs, streamArgs, "recordEncoder and streamEncoder(smartQuality: false) must emit identical arg lists on non-raspbian platforms");
    });
  }

  test("recordEncoder does not mutate the caller's options (safe to pass shared fixtures)", () => {

    // Read-only input contract: recordEncoder must treat the caller's options as immutable so shared fixtures can pass safely across multiple encoder invocations
    // without surprise cross-test pollution. Internally, recordEncoder clones with `{ ...options, smartQuality: false }` rather than mutating; this test pins the
    // contract so any future shortcut that writes back to the input surfaces as a visible failure.
    const { options } = makeOptions({ hostSystem: "generic" });
    const caller: VideoEncoderOptions = { ...BASE_ENCODER_OPTIONS, smartQuality: true };

    options.recordEncoder(caller);

    assert.equal(caller.smartQuality, true, "recordEncoder must not mutate its input's smartQuality");
  });
});

describe("FfmpegOptions - post-construction config observability sweep", () => {

  // configureHwAccel mutates `config.hardwareDecoding` and `config.hardwareTranscoding` during construction based on the (platform, advertised codecs, flags) triple.
  // This parametric sweep pins the resolved state across the canonical (platform preset x mode preset) matrix so any future change to configureHwAccel's resolution
  // rules surfaces as an explicit test-expectation update rather than silently shifting observable behavior.

  interface ResolutionCase {

    codecs: CodecsInit;
    expected: { hardwareDecoding: boolean; hardwareTranscoding: boolean };
    flags: MakeOptionsFlags | undefined;
    name: string;
  }

  const sweepCases: ResolutionCase[] = [

    // Software-only cases: everything falls back to false regardless of what the caller requested.
    { codecs: { hostSystem: "generic" }, expected: { hardwareDecoding: false, hardwareTranscoding: false }, flags: undefined, name: "plain generic + no HW requested" },
    { codecs: { hostSystem: "generic" }, expected: { hardwareDecoding: false, hardwareTranscoding: false }, flags: HW_FULL,
      name: "plain generic + HW_FULL (no QSV advertised)" },
    { codecs: { hostSystem: "generic" }, expected: { hardwareDecoding: false, hardwareTranscoding: false }, flags: HW_TRANSCODE,
      name: "plain generic + HW_TRANSCODE (no QSV advertised)" },

    // macOS VideoToolbox: encoder + hwaccel advertised, so hardware is fully honored.
    { codecs: VIDEOTOOLBOX_CODECS, expected: { hardwareDecoding: true, hardwareTranscoding: true }, flags: HW_FULL, name: "VIDEOTOOLBOX_CODECS + HW_FULL" },
    { codecs: VIDEOTOOLBOX_CODECS, expected: { hardwareDecoding: true, hardwareTranscoding: false }, flags: HW_DECODE, name: "VIDEOTOOLBOX_CODECS + HW_DECODE" },
    { codecs: { ...VIDEOTOOLBOX_CODECS, hostSystem: "macOS.Intel" }, expected: { hardwareDecoding: true, hardwareTranscoding: true }, flags: HW_FULL,
      name: "VIDEOTOOLBOX_CODECS macOS.Intel + HW_FULL" },

    // Raspberry Pi: configureHwAccel force-disables hwDecoding on raspbian even with sufficient GPU memory, per the FFmpeg 7 decoder workaround.
    { codecs: RASPBIAN_CODECS, expected: { hardwareDecoding: false, hardwareTranscoding: true }, flags: HW_FULL,
      name: "RASPBIAN_CODECS + HW_FULL (sufficient GPU memory)" },
    { codecs: { ...RASPBIAN_CODECS, gpuMem: 64 }, expected: { hardwareDecoding: false, hardwareTranscoding: false }, flags: HW_FULL,
      name: "RASPBIAN_CODECS gpuMem: 64 + HW_FULL (below floor)" },

    // Intel QSV: advertising the full QSV codec set autopromotes hardwareDecoding to true even when the caller only asked for transcoding.
    { codecs: QSV_CODECS, expected: { hardwareDecoding: true, hardwareTranscoding: true }, flags: HW_TRANSCODE, name: "QSV_CODECS + HW_TRANSCODE (autopromote)" },
    { codecs: QSV_CODECS, expected: { hardwareDecoding: true, hardwareTranscoding: true }, flags: HW_FULL, name: "QSV_CODECS + HW_FULL" }
  ];

  for(const { codecs, expected, flags, name } of sweepCases) {

    test("configureHwAccel resolves " + name + " to " + JSON.stringify(expected), () => {

      const { config } = makeOptions(codecs, flags);

      assert.equal(config.hardwareDecoding, expected.hardwareDecoding, "hardwareDecoding mismatch for: " + name);
      assert.equal(config.hardwareTranscoding, expected.hardwareTranscoding, "hardwareTranscoding mismatch for: " + name);
    });
  }
});

describe("FfmpegOptions integration (real ffmpeg binary)", { skip: !ffmpegIntegrationEnabled }, () => {

  // End-to-end integration tests that take arg lists emitted by streamEncoder and spawn the host's real FFmpeg binary to validate them. Unit-level snapshots elsewhere
  // in the file verify the exact arg-list contents; these tests verify the arg lists are semantically correct - FFmpeg parses them without error. The suite runs
  // whenever an FFmpeg binary is discoverable on PATH, and can be forced on or off via FFMPEG_INTEGRATION=1 / FFMPEG_INTEGRATION=0.
  //
  // Each test probes the host's real capabilities first, then skips cases the host cannot exercise (e.g., VideoToolbox on Linux, QSV on macOS). This keeps the test
  // meaningful-or-skipped rather than uniformly-broken on heterogeneous CI.

  // Synthesized silent-black input source. Produces a deterministic 1-second, 1920x1080, 30fps yuv420p stream that FFmpeg can feed into any encoder under test without
  // depending on an external test asset.
  const INPUT_ARGS = [ "-hide_banner", "-nostats", "-f", "lavfi", "-i", "color=black:s=1920x1080:r=30", "-t", "1" ];

  // Output to /dev/null (via the null muxer) so no file is written. Pair with encoder args - the arg list under test goes between INPUT_ARGS and OUTPUT_ARGS.
  const OUTPUT_ARGS = [ "-f", "null", "-" ];

  let realCodecs: FfmpegCodecs;

  before(async () => {

    // Probe factory returns either a populated instance or `null` on failure. If probing fails here the integration suite has no useful work to do, so we assert the
    // non-null before threading `realCodecs` into the per-test config below.
    const probed = await FfmpegCodecs.probe({ log: silentLog() });

    assert.ok(probed, "FfmpegCodecs.probe() must succeed for the integration suite to run");

    realCodecs = probed;
  });

  // Construct FfmpegOptions against the real FfmpegCodecs probe so the encoder path selection reflects the actual host's capabilities, ffmpegVersion, and cpuGeneration.
  // The hardware flags are the caller's intent - `configureHwAccel` runs in the constructor and resolves them against real capabilities just as it would in production.
  const buildOptions = (flags: { hardwareDecoding: boolean; hardwareTranscoding: boolean }): FfmpegOptions => {

    const config: FfmpegOptionsConfig = {

      codecSupport: realCodecs,
      hardwareDecoding: flags.hardwareDecoding,
      hardwareTranscoding: flags.hardwareTranscoding,
      log: silentLog(),
      name: (): string => "integration-test"
    };

    return new FfmpegOptions(config);
  };

  // Run the host's FFmpeg with the composed arg list and return the exit code + stderr. Uses execFile so no shell interpolation is possible. A non-zero exit is not a
  // test failure here - callers inspect stderr and the exit code themselves so tests can verify both "FFmpeg accepted the args" and "FFmpeg rejected them with the
  // expected diagnostic."
  const runFfmpeg = async (encoderArgs: readonly string[]): Promise<{ exitCode: number; stderr: string }> => {

    try {

      const { stderr } = await execFileAsync(realCodecs.ffmpegExec, [ ...INPUT_ARGS, ...encoderArgs, ...OUTPUT_ARGS ]);

      return { exitCode: 0, stderr };
    } catch(error) {

      // Node's execFile rejection is an ExecException-shaped error carrying stdout/stderr/code beyond the generic Error type that util.promisify exposes; the cast
      // makes that additional shape explicit for the fields this helper actually reads.
      const execError = error as { code?: number; stderr?: string };

      return { exitCode: execError.code ?? -1, stderr: execError.stderr ?? "" };
    }
  };

  test("libx264 software encoder args run cleanly against real FFmpeg", async () => {

    // Software-only path is universally available and has no platform gate. We explicitly request no HW to force the libx264 fallback regardless of what the host
    // actually supports.
    const options = buildOptions({ hardwareDecoding: false, hardwareTranscoding: false });
    const args = options.streamEncoder(BASE_ENCODER_OPTIONS);
    const result = await runFfmpeg(args);

    assert.equal(result.exitCode, 0, "libx264 encoder args must be accepted by FFmpeg; stderr: " + result.stderr);
  });

  test("libx264 software encoder with smartQuality=false runs cleanly", async () => {

    const options = buildOptions({ hardwareDecoding: false, hardwareTranscoding: false });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, smartQuality: false });
    const result = await runFfmpeg(args);

    assert.equal(result.exitCode, 0, "libx264 no-smartQuality args must be accepted; stderr: " + result.stderr);
  });

  // Hardware-encode-with-CPU-input scenarios. The synthetic `-f lavfi color=...` input produces CPU-resident frames, so we exercise the "SW decode + HW transcode"
  // path at the encoder-options level (hardwareDecoding: false) which causes streamEncoder to emit `hwupload` / `format=yuv420p` / etc into the filter chain. This is a
  // real production scenario (camera providing an H.264 stream that the plugin software-decodes, then hardware-encodes to HomeKit), and it is the integration scenario
  // that is representable against a CPU input. The "HW decode + HW transcode" path requires a pre-decoded GPU-resident source, which needs a real encoded input asset -
  // out of scope for synthetic integration.

  test("h264_videotoolbox hardware encoder args run cleanly (SW decode + HW transcode; skipped when VideoToolbox is unavailable)", async (t) => {

    if(!realCodecs.hasEncoder("h264", "h264_videotoolbox") || !realCodecs.hasHwAccel("videotoolbox")) {

      t.skip("host does not advertise h264_videotoolbox / videotoolbox");

      return;
    }

    const options = buildOptions({ hardwareDecoding: true, hardwareTranscoding: true });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false });
    const result = await runFfmpeg(args);

    assert.equal(result.exitCode, 0, "h264_videotoolbox (SW decode + HW transcode) args must be accepted; stderr: " + result.stderr);
  });

  test("h264_qsv hardware encoder args run cleanly (SW decode + HW transcode; skipped when QSV is unavailable)", async (t) => {

    if(!realCodecs.hasEncoder("h264", "h264_qsv") || !realCodecs.hasHwAccel("qsv")) {

      t.skip("host does not advertise h264_qsv / qsv");

      return;
    }

    const options = buildOptions({ hardwareDecoding: true, hardwareTranscoding: true });
    const args = options.streamEncoder({ ...BASE_ENCODER_OPTIONS, hardwareDecoding: false });
    const result = await runFfmpeg(args);

    assert.equal(result.exitCode, 0, "h264_qsv (SW decode + HW transcode) args must be accepted; stderr: " + result.stderr);
  });

  test("h264_v4l2m2m hardware encoder args run cleanly (skipped when v4l2m2m is unavailable)", async (t) => {

    if(!realCodecs.hasEncoder("h264", "h264_v4l2m2m")) {

      t.skip("host does not advertise h264_v4l2m2m");

      return;
    }

    // RPi's configureHwAccel force-disables hardwareDecoding, so the emitted chain already includes `format=yuv420p` upload. No further encoder-options override needed.
    const options = buildOptions({ hardwareDecoding: true, hardwareTranscoding: true });
    const args = options.streamEncoder(BASE_ENCODER_OPTIONS);
    const result = await runFfmpeg(args);

    assert.equal(result.exitCode, 0, "h264_v4l2m2m encoder args must be accepted; stderr: " + result.stderr);
  });

  test("recordEncoder args (smartQuality forced off) run cleanly", async () => {

    // recordEncoder's delegation to streamEncoder with smartQuality=false is the production HKSV path. Validates the full HKSV-shaped arg list parses.
    const options = buildOptions({ hardwareDecoding: false, hardwareTranscoding: false });
    const args = options.recordEncoder(BASE_ENCODER_OPTIONS);
    const result = await runFfmpeg(args);

    assert.equal(result.exitCode, 0, "recordEncoder args must be accepted by FFmpeg; stderr: " + result.stderr);
  });

  test("streamEncoder args with crop filter run cleanly", async () => {

    // Regression guard for the crop fix: the software path must produce a filter chain FFmpeg actually parses.
    const config: FfmpegOptionsConfig = {

      codecSupport: realCodecs,
      crop: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 },
      hardwareDecoding: false,
      hardwareTranscoding: false,
      log: silentLog(),
      name: (): string => "integration-test"
    };
    const options = new FfmpegOptions(config);
    const args = options.streamEncoder(BASE_ENCODER_OPTIONS);
    const result = await runFfmpeg(args);

    assert.equal(result.exitCode, 0, "streamEncoder + crop args must be accepted by FFmpeg; stderr: " + result.stderr);
  });
});
