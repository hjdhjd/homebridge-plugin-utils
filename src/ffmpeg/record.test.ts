/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/record.test.ts: Unit tests for FfmpegRecordingProcess and FfmpegLivestreamProcess - composed Mp4SegmentAssembler, init / segment delegation, abort propagation
 * between the process and the assembler, known-HKSV-error friendly teardown message, and livestream segmentLength wiring.
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate } from "./hap-enums.ts";
import { FfmpegLivestreamProcess, FfmpegRecordingProcess } from "./record.ts";
import { HbpuAbortError, isHbpuAbortReason } from "../util.ts";
import { describe, test } from "node:test";
import type { CameraRecordingConfiguration } from "homebridge";
import type { CapturingLog } from "../testing.helpers.ts";
import type { FfmpegOptions } from "./options.ts";
import type { Readable } from "node:stream";
import assert from "node:assert/strict";
import { capturingLog } from "../testing.helpers.ts";
import { makeBox } from "./mp4.helpers.ts";
import { makeCodecs } from "./codecs.helpers.ts";

// Minimal FfmpegOptions stand-in. The record subclasses call `options.videoDecoder`, `options.recordEncoder`, and `options.audioEncoder` during command-line
// assembly, so the stub returns trivial placeholder args (empty for videoDecoder, a fixed two-token vector for the encoders) - the exact encoder args do not matter
// here since we never actually invoke a real ffmpeg binary.
function makeOptions(logger: CapturingLog = capturingLog()): FfmpegOptions {

  return {

    audioEncoder: (): string[] => [ "-codec:a", "aac" ],
    config: {

      codecSupport: makeCodecs({ ffmpegExec: process.execPath, ffmpegVersion: "7.0" }),
      hardwareDecoding: false,
      hardwareTranscoding: false
    },
    debug: false,
    log: logger,
    name: () => "test-camera",
    recordEncoder: (): string[] => [ "-codec:v", "libx264" ],
    videoDecoder: (): string[] => []
  } as unknown as FfmpegOptions;
}

// Minimal HKSV recording configuration. Populates at least the fields FfmpegRecordingProcess reads during command-line assembly: audioCodec.type / .samplerate /
// .audioChannels for audio args, and videoCodec.parameters / .resolution for video args. The remaining fields are inert padding carried for shape completeness.
function makeRecordingConfig(): CameraRecordingConfiguration {

  return {

    audioCodec: {

      audioChannels: 1,
      bitrate: 64,
      samplerate: AudioRecordingSamplerate.KHZ_32,
      type: AudioRecordingCodecType.AAC_ELD
    },
    mediaContainerConfiguration: {

      fragmentLength: 4000,
      type: 0
    },
    prebufferLength: 4000,
    videoCodec: {

      parameters: {

        bitRate: 2000,
        iFrameInterval: 4000,
        // Literal mirrors of hap-nodejs's H264Level.LEVEL3_1 and H264Profile.MAIN. `verbatimModuleSyntax` disallows value imports of ambient const enums, so the
        // numeric contract is preserved inline to match the subclass's handling of the same enums.
        level: 0,
        profile: 1
      },
      resolution: [ 1920, 1080, 30 ],
      type: 0
    }
  } as CameraRecordingConfiguration;
}

// String-to-box adapter over the shared `makeBox` fixture. The emission-script builders below construct their boxes from ASCII-string payloads (easier to read
// inline in test source) whereas `makeBox` takes a `Buffer`; this thin wrapper does the conversion so call sites stay readable as `box("ftyp", "isomavc1")` without
// inlining `Buffer.from(...)` at every site.
function box(type: string, payload = ""): Buffer {

  return makeBox(type, Buffer.from(payload));
}

// Serialize a sequence of boxes into a single base64 string that the stand-in script decodes at startup. Keeps the inline source compact and avoids escaping pitfalls
// that come with injecting raw bytes through `-e`.
function encodeBoxSequence(boxes: Buffer[]): string {

  return Buffer.concat(boxes).toString("base64");
}

// Build a stand-in script that reads stdin to completion (so the recording class's `-i pipe:0` contract is satisfied even though we never feed it), then emits a
// deterministic fMP4 byte sequence to stdout, then exits cleanly. The sequence is ftyp + moov (init) followed by N moof/mdat pairs (media segments).
function buildFMp4EmissionScript(segmentCount: number): string[] {

  const boxes: Buffer[] = [ box("ftyp", "isomavc1"), box("moov", "metadata") ];

  for(let i = 0; i < segmentCount; i++) {

    boxes.push(box("moof", "fragment" + i.toString()));
    boxes.push(box("mdat", "payload" + i.toString()));
  }

  // Inline the encoded byte sequence directly into the script body. We keep stdin connected (drain to `/dev/null` via no-op handlers) so the recording subclass's
  // `-i pipe:0` stdin write path does not surface EPIPE while the child lives, then exit cleanly after a short settle window.
  const script = "process.stderr.write(\"ready\\n\");" +
    "process.stdout.write(Buffer.from(" + JSON.stringify(encodeBoxSequence(boxes)) + ", \"base64\"));" +
    "process.stdin.on(\"data\", () => {}); process.stdin.on(\"end\", () => {});" +
    "setTimeout(() => process.exit(0), 100);";

  return [ "-e", script ];
}

// Stand-in script that emits ftyp + moov (the full init segment) plus a single moof/mdat pair, then idles forever. Used to exercise the assembler's post-init drain
// behavior without the process exiting out from under it: callers that await getInitSegment and then abort can rely on the child staying alive until they drive
// termination explicitly.
function buildInitOnlyIdleScript(): string[] {

  const boxes: Buffer[] = [

    box("ftyp", "isomavc1"),
    box("moov", "metadata"),
    box("moof", "first"),
    box("mdat", "payload")
  ];

  const script = "process.stderr.write(\"ready\\n\");" +
    "process.stdout.write(Buffer.from(" + JSON.stringify(encodeBoxSequence(boxes)) + ", \"base64\"));" +
    "process.stdin.on(\"data\", () => {}); process.stdin.on(\"end\", () => {});" +
    "setInterval(() => {}, 100000);";

  return [ "-e", script ];
}

// Stand-in script that emits a known-HKSV-error line to stderr, then exits with a non-zero code. Used to exercise the FfmpegRecordingProcess.logFailedTeardown override
// that substitutes the canonical stderr dump with a friendly user-facing line.
function buildKnownHksvErrorScript(): string[] {

  return [ "-e",
    "process.stderr.write(\"ready\\n\"); process.stderr.write(\"moov atom not found\\n\"); setTimeout(() => process.exit(2), 30);" ];
}

describe("FfmpegRecordingProcess - initialization segment and media segments", () => {

  test("getInitSegment resolves with the concatenated ftyp + moov bytes", async () => {

    await using proc = new FfmpegRecordingProcess(makeOptions(), {

      args: buildFMp4EmissionScript(1),
      recordingConfig: makeRecordingConfig()
    });

    const init = await proc.getInitSegment();

    // Init segment must start with the ftyp box header and contain the moov box that followed. The bytes are opaque to us beyond the first box's type code.
    assert.equal(init.readUInt32BE(4), 0x66747970, "init segment must start with the ftyp box");
    assert.ok(init.includes(Buffer.from("moov", "ascii")), "init segment must contain the moov box");
  });

  test("segments() yields each moof/mdat pair as a single Buffer in stream order", async () => {

    await using proc = new FfmpegRecordingProcess(makeOptions(), {

      args: buildFMp4EmissionScript(3),
      recordingConfig: makeRecordingConfig()
    });

    const collected: Buffer[] = [];

    for await (const segment of proc.segments()) {

      collected.push(segment);
    }

    assert.equal(collected.length, 3, "exactly three moof/mdat pairs should be yielded");

    for(const segment of collected) {

      // Each yielded segment begins with the moof box header followed by the mdat box within the same buffer.
      assert.equal(segment.readUInt32BE(4), 0x6D6F6F66, "each media segment must start with a moof box");
      assert.ok(segment.includes(Buffer.from("mdat", "ascii")), "each media segment must also carry an mdat box");
    }
  });

  test("aborting the process terminates segments() cleanly", async () => {

    await using proc = new FfmpegRecordingProcess(makeOptions(), {

      args: buildInitOnlyIdleScript(),
      recordingConfig: makeRecordingConfig()
    });

    // Wait for init so the assembler has resolved and the drain phase is active.
    await proc.getInitSegment();

    const iter = proc.segments()[Symbol.asyncIterator]();

    // Drain the single queued media segment that precedes the idle.
    const first = await iter.next();

    assert.equal(first.done, false);

    proc.abort(new HbpuAbortError("shutdown"));

    const next = await iter.next();

    assert.equal(next.done, true, "generator must terminate after abort rather than hanging on the parked waiter");
  });
});

describe("FfmpegRecordingProcess - abort propagation between assembler and process", () => {

  test("isTimedOut is surfaced through the process signal when the assembler's inter-segment watchdog fires", async () => {

    // The recording subclass wires the assembler with segmentTimeout = HKSV_TIMEOUT (4500 ms), which is too long for a test. Since HKSV_TIMEOUT is a module constant
    // we cannot override, we instead abort the process directly with a timeout reason to exercise the isTimedOut derivation path - the bridging contract is covered
    // by the "abort" test above, and this test covers only the derived-state semantics. An integration test against a real FFmpeg binary would exercise the watchdog
    // end-to-end with a genuinely stalled input.
    await using proc = new FfmpegRecordingProcess(makeOptions(), {

      args: buildInitOnlyIdleScript(),
      recordingConfig: makeRecordingConfig()
    });

    await proc.getInitSegment();

    proc.abort(new HbpuAbortError("timeout"));

    await proc.exited;

    assert.equal(proc.isTimedOut, true);
    assert.equal(isHbpuAbortReason(proc.signal.reason, "timeout"), true);
  });

  test("a recording timeout teardown logs the reap at debug, not warn", async () => {

    const logger = capturingLog();

    await using proc = new FfmpegRecordingProcess(makeOptions(logger), { args: buildInitOnlyIdleScript(), recordingConfig: makeRecordingConfig() });

    await proc.getInitSegment();
    proc.abort(new HbpuAbortError("timeout"));
    await proc.exited;

    assert.ok(logger.entries.some((entry) => (entry.level === "debug") && entry.message.includes("inter-segment watchdog window")),
      "the recording timeout teardown reports the reap at debug");
    assert.ok(!logger.entries.some((entry) => (entry.level === "warn") && entry.message.includes("stalled past its watchdog window")),
      "the recording timeout teardown does NOT warn - the base default is overridden");
  });
});

describe("FfmpegRecordingProcess - known HKSV error friendly message", () => {

  test("stderr matching the known-error regex produces the friendly message instead of the canonical dump", async () => {

    const logger = capturingLog();

    await using proc = new FfmpegRecordingProcess(makeOptions(logger), {

      args: buildKnownHksvErrorScript(),
      recordingConfig: makeRecordingConfig()
    });

    await proc.exited.catch(() => { /* Non-zero exit will surface here; the subclass override handles the logging. */ });

    // Friendly message must appear at ERROR level, and the canonical per-stderr-line dump must NOT be emitted for the matched pattern.
    const errorEntries = logger.entries.filter((e) => e.level === "error");

    const hasFriendly = errorEntries.some((entry) => entry.message.includes("issues processing the media stream"));

    assert.equal(hasFriendly, true, "the friendly user-facing message must be emitted at error level when a known HKSV error is present in stderr");

    const hasCanonicalDump = errorEntries.some((entry) => entry.message === "moov atom not found");

    assert.equal(hasCanonicalDump, false, "the canonical stderr dump must be suppressed when the known-error pattern matches");
  });
});

describe("FfmpegRecordingProcess - nested recording init shape", () => {

  test("init.recording fields propagate into the built command line when args override is absent", async () => {

    // Construct without `init.args` so the subclass takes the `buildRecordingCommandLine` path. The stand-in binary (Node via `process.execPath`) receives real FFmpeg
    // arguments, does not understand them, and exits quickly with a non-zero code. That is fine - we are inspecting the command-log output the base class emits at
    // construction, not the process's behavior.
    const logger = capturingLog();

    await using proc = new FfmpegRecordingProcess(makeOptions(logger), {

      recording: { probesize: 2_500_000, timeshift: 1500 },
      recordingConfig: makeRecordingConfig()
    });

    await proc.exited.catch(() => { /* Stand-in binary exits on seeing ffmpeg args - we are inspecting the logs, not the process. */ });

    // The base class logs the command line at construction with args.join(" ") as the final param. Concatenate every string param across the log entries and verify
    // the probesize / timeshift values the nested `recording` object supplied actually reached the final arg vector.
    const allParams = commandLineArgs(logger);

    assert.ok(allParams.includes("-probesize 2500000"), "init.recording.probesize must propagate to the -probesize arg in the built command line");
    assert.ok(allParams.includes("-ss 1500ms"), "init.recording.timeshift must propagate to the -ss arg in the built command line");
  });
});

describe("FfmpegLivestreamProcess - init segment and media segments", () => {

  test("getInitSegment and segments() delegate to the composed assembler", async () => {

    await using proc = new FfmpegLivestreamProcess(makeOptions(), {

      args: buildFMp4EmissionScript(2),
      livestream: { url: "rtsp://test/stream" },
      recordingConfig: makeRecordingConfig()
    });

    const init = await proc.getInitSegment();

    assert.equal(init.readUInt32BE(4), 0x66747970, "init segment must start with the ftyp box");

    const collected: Buffer[] = [];

    for await (const segment of proc.segments()) {

      collected.push(segment);
    }

    assert.equal(collected.length, 2, "livestream should yield the configured number of media segments");
  });

  test("segmentLength is applied at construction as -frag_duration in microseconds", async () => {

    // The `args` field we pass here replaces the default command line - the subclass still spawns with whatever `init.args` specifies. To verify segmentLength is
    // applied when args are NOT overridden, we construct with no args and observe the command-log output the base class emits, which includes the full arg vector.
    const logger = capturingLog();

    // Use a script that exits immediately so we do not leak a child across tests. The args the subclass builds include the real fMP4 pipeline command line; the
    // stand-in binary just exits on seeing any args.
    await using proc = new FfmpegLivestreamProcess(makeOptions(logger), {

      livestream: { url: "rtsp://test/stream" },
      recordingConfig: makeRecordingConfig(),
      segmentLength: 500
    });

    await proc.exited.catch(() => { /* The stand-in binary exits as soon as Node sees its synthetic args - we are inspecting the logs, not the process. */ });

    // The base class's construction-time command log carries the full arg vector as params[2]. Locate it and verify the -frag_duration value is present in
    // microseconds (500 ms * 1000 = 500000).
    const allParams = commandLineArgs(logger);

    assert.ok(allParams.includes("-frag_duration"), "-frag_duration must be part of the command line built for a livestream");
    assert.ok(allParams.includes("500000"), "segmentLength in ms must be translated to microseconds (500 * 1000 = 500000) in -frag_duration");
  });

  test("a livestream timeout teardown keeps the base warn - the override is on the recording leaf, not the shared fMP4 parent", async () => {

    const logger = capturingLog();

    await using proc = new FfmpegLivestreamProcess(makeOptions(logger), {

      args: buildInitOnlyIdleScript(),
      livestream: { url: "rtsp://test/stream" },
      recordingConfig: makeRecordingConfig()
    });

    await proc.getInitSegment();
    proc.abort(new HbpuAbortError("timeout"));
    await proc.exited;

    assert.ok(logger.entries.some((entry) => (entry.level === "warn") && entry.message.includes("stalled past its watchdog window")),
      "the livestream sibling keeps the base warn - the override is on the recording leaf, not the shared fMP4 parent");
    assert.ok(!logger.entries.some((entry) => entry.message.includes("inter-segment watchdog window")),
      "the livestream sibling does NOT get the recording debug override");
  });
});

// Extract the full FFmpeg arg vector out of a logger that captured the base-class construction-time command log. Returns the flat string of arg fragments joined with
// spaces - tests assert against `.includes(...)` to verify a specific flag / value pair reached the built command line without coupling to ordering decisions the
// command-line builder is free to revisit.
function commandLineArgs(logger: CapturingLog): string {

  const commandLogs = logger.entries.filter((entry) => entry.message.startsWith("FFmpeg command (version:"));

  return commandLogs.flatMap((entry) => entry.params).filter((param) => typeof param === "string").join(" ");
}

// Construct a livestream process with the supplied audioInput shape, await its exit, and return the captured arg vector string. Tests that exercise the
// `buildLivestreamAudioInputArgs` branches share this shape so the single variable across tests is the audioInput configuration itself.
async function livestreamArgsWithAudio(audioInput: unknown, overrides: { enableAudio?: boolean } = {}): Promise<string> {

  const logger = capturingLog();

  await using proc = new FfmpegLivestreamProcess(makeOptions(logger), {

    livestream: { audioInput: audioInput as never, enableAudio: overrides.enableAudio, url: "rtsp://primary/stream" },
    recordingConfig: makeRecordingConfig()
  });

  // The stand-in binary (Node) does not understand FFmpeg args and exits; we are inspecting the construction-time command log, not the process's behavior.
  await proc.exited.catch(() => { /* Exit outcome is not the subject; the arg vector captured at spawn time is. */ });

  return commandLineArgs(logger);
}

describe("FfmpegLivestreamProcess - separate audio input configurations", () => {

  test("raw mulaw audio input emits -f / -ar / -ac / -i args before the primary input's audio mapping", async () => {

    // DoorBird-style raw G.711 audio path: the audio source is a non-self-describing HTTP stream, so FFmpeg needs explicit format / sample-rate / channel metadata before
    // the -i. The builder writes them in the prescribed order (format, then sample rate, then channels, then URL), so we assert substring presence rather than exact
    // ordering to stay robust against parallel refinements.
    const args = await livestreamArgsWithAudio({ channels: 1, format: "mulaw", sampleRate: 8000, url: "http://camera/audio.raw" });

    assert.ok(args.includes("-f mulaw"), "raw format must be declared via -f");
    assert.ok(args.includes("-ar 8000"), "sample rate must be declared via -ar in Hz");
    assert.ok(args.includes("-ac 1"), "channel count must be declared via -ac");
    assert.ok(args.includes("-i http://camera/audio.raw"), "audio URL must be supplied via -i after the format block");
    assert.ok(args.includes("1:a:0"), "separate audio input pushes the audio mapping to FFmpeg input index 1");
  });

  test("raw alaw / s16le inputs default sampleRate to 8000 Hz and channels to 1 when omitted", async () => {

    // The builder's defaults (`sampleRate: 8000`, `channels: 1`) match G.711's historical wire format. Omitting both in the config exercises the fallback.
    const args = await livestreamArgsWithAudio({ format: "alaw", url: "http://camera/a.raw" });

    assert.ok(args.includes("-f alaw"));
    assert.ok(args.includes("-ar 8000"), "omitted sampleRate must default to 8000 Hz");
    assert.ok(args.includes("-ac 1"), "omitted channels must default to 1");
  });

  test("rtsp:// audio URL auto-injects -rtsp_transport tcp to mirror the primary input", async () => {

    // Both rtsp:// and rtsps:// are RTSP-family protocols; the builder's case-insensitive prefix check must catch both. The transport flag is injected before the -i so
    // FFmpeg's RTSP demuxer sees it when opening the connection.
    const rtspArgs = await livestreamArgsWithAudio({ url: "rtsp://camera/audio" });

    assert.ok(rtspArgs.includes("-rtsp_transport tcp"), "rtsp:// audio URL must inject -rtsp_transport tcp");
    assert.ok(rtspArgs.includes("-i rtsp://camera/audio"));

    const rtspsArgs = await livestreamArgsWithAudio({ url: "rtsps://camera/audio" });

    assert.ok(rtspsArgs.includes("-rtsp_transport tcp"), "rtsps:// audio URL must inject -rtsp_transport tcp");
  });

  test("non-RTSP audio URLs do not inject -rtsp_transport tcp", async () => {

    // Regression guard for the prefix matcher - only RTSP-family URLs get the TCP transport hint. An HTTP source must not be misidentified.
    const args = await livestreamArgsWithAudio({ url: "http://camera/audio.aac" });

    // `-rtsp_transport tcp` appears once in the args for the primary video input (rtsp://primary/stream). The audio input should not duplicate it. We check that it
    // appears exactly once by splitting on the sentinel and counting the resulting pieces.
    const occurrences = args.split("-rtsp_transport tcp").length - 1;

    assert.equal(occurrences, 1, "non-RTSP audio URL must not duplicate the -rtsp_transport tcp flag");
  });

  test("string-shorthand audio input is treated as a URL", async () => {

    // The builder normalizes a bare string into `{ url: string }`. The rest of the pipeline is identical to the object form.
    const args = await livestreamArgsWithAudio("http://camera/audio.aac");

    assert.ok(args.includes("-i http://camera/audio.aac"));
    assert.ok(args.includes("1:a:0"), "string-shorthand audio still routes the audio mapping to input index 1");
  });

  test("audio disabled via enableAudio: false suppresses the separate audio input entirely", async () => {

    // When audio is disabled, the separate-input helper short-circuits before emitting any audio args. The primary input's audio mapping also disappears because the
    // wrapping conditional in `buildFMp4CommandLine` gates on `fMp4Options.enableAudio`.
    const args = await livestreamArgsWithAudio({ url: "http://camera/audio" }, { enableAudio: false });

    assert.ok(!args.includes("-i http://camera/audio"), "separate audio URL must be omitted when audio is disabled");
    assert.ok(!args.includes(":a:"), "no audio mapping when audio is disabled");
  });

  test("omitting audioInput entirely routes audio mapping to the primary input (index 0)", async () => {

    // Baseline: no audioInput config means the audio stream is multiplexed inside the primary RTSP input. The mapping index stays at 0.
    const logger = capturingLog();

    await using proc = new FfmpegLivestreamProcess(makeOptions(logger), {

      livestream: { url: "rtsp://primary/stream" },
      recordingConfig: makeRecordingConfig()
    });

    await proc.exited.catch(() => { /* ignore. */ });

    const args = commandLineArgs(logger);

    assert.ok(args.includes("0:a:0"), "no separate audio input means the audio mapping stays on input index 0");
  });
});

describe("FfmpegRecordingProcess - resolveBaseOptions hardware-decoding gate", () => {

  // Build an FfmpegOptions stand-in whose FFmpeg version is configurable, plus a live capture of every `recordEncoder` invocation's arguments. `resolveBaseOptions`
  // uses `options.config.codecSupport.ffmpegAtLeast(8)` to gate the default hardware-decoding value, so this helper is the single point where FFmpeg version and
  // hardware flags flow into record.ts's defaulting logic. The capture is returned as a live Map the tests read after each process construction has completed - the
  // map itself is mutated in place by the spy, so callers always see the most recent invocation.
  interface SpyRecordEncoderOptions {

    hardwareDecoding?: boolean;
    hardwareTranscoding?: boolean;
  }

  function makeSpyingOptions(ffmpegVersion: string, hardwareDecoding: boolean): { captures: SpyRecordEncoderOptions[]; options: FfmpegOptions } {

    const captures: SpyRecordEncoderOptions[] = [];

    const options = {

      audioEncoder: (): string[] => [ "-codec:a", "aac" ],
      config: {

        codecSupport: makeCodecs({ ffmpegExec: process.execPath, ffmpegVersion }),
        hardwareDecoding,
        hardwareTranscoding: false
      },
      debug: false,
      log: capturingLog(),
      name: () => "test-camera",
      recordEncoder: (encoderOptions: SpyRecordEncoderOptions): string[] => {

        captures.push(encoderOptions);

        return [ "-codec:v", "libx264" ];
      },
      videoDecoder: (): string[] => []
    } as unknown as FfmpegOptions;

    return { captures, options };
  }

  // Return the first captured call's options. Every test in this block constructs exactly one recording process, so there is only ever one capture and the assertion
  // reads unambiguously.
  function firstCapture(captures: SpyRecordEncoderOptions[]): SpyRecordEncoderOptions {

    assert.equal(captures.length, 1, "exactly one recordEncoder invocation must have occurred");

    return captures[0] ?? {};
  }

  test("FFmpeg 7.x clamps a caller-requested hardwareDecoding=true back to false", async () => {

    // Regression guard for the 7.x hardware-decoding workaround. `resolveBaseOptions` returns `ffmpegAtLeast(8) ? hardwareDecoding : false` when the caller omits
    // `recording.hardwareDecoding`. A 7.x FFmpeg must resolve to false regardless of what the options config requested.
    const spy = makeSpyingOptions("7.0", true);

    await using proc = new FfmpegRecordingProcess(spy.options, { recordingConfig: makeRecordingConfig() });

    await proc.exited.catch(() => { /* Stand-in binary exits immediately. */ });

    assert.equal(firstCapture(spy.captures).hardwareDecoding, false,
      "FFmpeg 7.x must gate hardware decoding off even when the options config requested it");
  });

  test("FFmpeg 8.x passes a caller-requested hardwareDecoding=true through unchanged", async () => {

    const spy = makeSpyingOptions("8.0", true);

    await using proc = new FfmpegRecordingProcess(spy.options, { recordingConfig: makeRecordingConfig() });

    await proc.exited.catch(() => { /* ignore. */ });

    assert.equal(firstCapture(spy.captures).hardwareDecoding, true,
      "FFmpeg 8.x must honor the options config's hardwareDecoding request");
  });

  test("FFmpeg 8.x with hardwareDecoding=false still resolves to false", async () => {

    // Identity sanity check: the gate must not turn off-into-on. When the config opted out, the resolution stays off regardless of FFmpeg version.
    const spy = makeSpyingOptions("8.0", false);

    await using proc = new FfmpegRecordingProcess(spy.options, { recordingConfig: makeRecordingConfig() });

    await proc.exited.catch(() => { /* ignore. */ });

    assert.equal(firstCapture(spy.captures).hardwareDecoding, false);
  });

  test("explicit init.recording.hardwareDecoding overrides the version gate", async () => {

    // When the caller explicitly provides `recording.hardwareDecoding`, the defaulting logic is skipped entirely - the gate only sets the default. This test pins the
    // invariant that explicit caller input wins over version-based defaulting, so a plugin that knows better (e.g., has validated its own decoder availability) can
    // opt in on a 7.x host if it wants to.
    const spy = makeSpyingOptions("7.0", false);

    await using proc = new FfmpegRecordingProcess(spy.options, {

      recording: { hardwareDecoding: true },
      recordingConfig: makeRecordingConfig()
    });

    await proc.exited.catch(() => { /* ignore. */ });

    assert.equal(firstCapture(spy.captures).hardwareDecoding, true, "caller-supplied recording.hardwareDecoding must win over the FFmpeg 7.x default gate");
  });
});

describe("FfmpegFMp4Process - assembler-to-process bridge", () => {

  // Build a stand-in script whose stdout emits a well-formed init + single media segment, then ENDS stdout (closing the pipe from the child's end), then exits with
  // the supplied code after a short delay. This sequencing is load-bearing for the "closed" deferral test: the assembler sees source-end FIRST (its internal
  // controller aborts with "closed"), then the child exits with the specified code - which the process's own `#onExit` handler translates into either "closed"
  // (exitCode 0) or "failed" (nonzero).
  function buildStdoutEndThenExitScript(exitCode: number): string[] {

    const boxes: Buffer[] = [

      box("ftyp", "isomavc1"),
      box("moov", "metadata"),
      box("moof", "first"),
      box("mdat", "payload")
    ];

    const script = "process.stderr.write(\"ready\\n\");" +
      "process.stdout.write(Buffer.from(" + JSON.stringify(encodeBoxSequence(boxes)) + ", \"base64\"), () => {" +
      "  process.stdout.end(() => {" +
      "    setTimeout(() => process.exit(" + exitCode.toString() + "), 50);" +
      "  });" +
      "});" +
      "process.stdin.on(\"data\", () => {}); process.stdin.on(\"end\", () => {});";

    return [ "-e", script ];
  }

  test("assembler \"closed\" does NOT pre-empt the process's own exit reason (nonzero exit stays \"failed\")", async () => {

    // The bridge's load-bearing invariant: when the assembler's source ends naturally, the assembler aborts its signal with `HbpuAbortError("closed")`. If the bridge
    // forwarded that reason to the process, a subsequent nonzero child exit would be silently reclassified as "closed" - hiding real errors. The bridge defers on
    // "closed" so the process's own `#onExit` handler is the authoritative source for the exit reason. We force a nonzero exit here to expose any regression in that
    // deferral: if the bridge propagated "closed" prematurely, the process's reason would be "closed"; with deferral, the process exits with code 2 and the reason is
    // "failed".
    await using proc = new FfmpegRecordingProcess(makeOptions(), {

      args: buildStdoutEndThenExitScript(2),
      recordingConfig: makeRecordingConfig()
    });

    await proc.exited.catch(() => { /* Nonzero exit resolves with the exit info; catch in case of spawn error. */ });

    assert.equal(isHbpuAbortReason(proc.signal.reason, "failed"), true,
      "process's own nonzero-exit reason must survive the assembler's \"closed\" abort - bridge must defer on \"closed\"");
    assert.equal(proc.hasError, true);
  });

  test("source-stream error on stdout propagates through the assembler's \"failed\" wrap to the process signal", async () => {

    // The complement of the deferral: when the assembler aborts for any reason OTHER than "closed" - here a source-stream error - the bridge must propagate that
    // reason onto the process's signal so the FFmpeg child is actively torn down rather than left to stall. We trigger the path deterministically by destroying the
    // base class's stdout Readable with a synthetic error after the assembler has started draining. The drain loop observes the error, wraps it in
    // `HbpuAbortError("failed", { cause: syntheticError })` at the single classification point in `mp4-assembler.ts`, and the bridge's listener forwards that reason
    // to `process.abort(reason)`. Reaching past the public surface to `_stdout` is unusual but intentional: the internal stream error is the only trigger for the
    // bridge's propagation branch, and the structural cast makes the test-time coupling explicit rather than hiding it behind a production seam.
    await using proc = new FfmpegRecordingProcess(makeOptions(), {

      args: buildInitOnlyIdleScript(),
      recordingConfig: makeRecordingConfig()
    });

    // Wait for init so the assembler has started draining and is parked on the next-chunk read. Without this the drain loop might not yet be observing the stream,
    // and the destroy would race against the assembler's startup rather than its steady-state drain.
    await proc.getInitSegment();

    const sourceError = new Error("synthetic stdout error");
    const readable = (proc as unknown as { _stdout: Readable })._stdout;

    readable.destroy(sourceError);

    await proc.exited.catch(() => { /* The process exits as a consequence of the bridge-driven abort; exit outcome is not the subject. */ });

    assert.equal(isHbpuAbortReason(proc.signal.reason, "failed"), true,
      "the bridge must forward the assembler's \"failed\" reason onto the process signal when the stdout source errors");

    const reason = proc.signal.reason as { cause?: unknown };

    assert.equal(reason.cause, sourceError,
      "the synthetic source error must survive as the abort reason's `cause` - the classification wrap must not drop the chain");
  });

  test("external abort wins over the assembler's subsequent signal propagation (double-abort guard)", async () => {

    // Complementary guard on the same bridge: when the process is aborted externally first, the assembler's signal aborts as a consequence (through AbortSignal.any
    // composition), and the bridge fires - but finds `process.aborted === true` and short-circuits. The externally-supplied reason survives unchanged. This pins the
    // ordering contract: external abort is authoritative; the bridge never overwrites an already-set reason.
    await using proc = new FfmpegRecordingProcess(makeOptions(), {

      args: buildInitOnlyIdleScript(),
      recordingConfig: makeRecordingConfig()
    });

    await proc.getInitSegment();

    proc.abort(new HbpuAbortError("replaced"));

    await proc.exited;

    assert.equal(isHbpuAbortReason(proc.signal.reason, "replaced"), true,
      "an externally-supplied abort reason must survive the assembler's consequent signal abort - the bridge must not overwrite it");
  });
});
