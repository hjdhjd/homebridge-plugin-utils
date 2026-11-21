/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/streaming-process-double.test.ts: Unit tests for the StreamingProcess dependency-inversion boundary - the compile-time conformance of the production class
 * and factory, plus the shipped FFmpeg-free TestStreamingProcess / TestStreamingProcessFactory doubles (each lever, their refusals, the ready that stderr lines
 * resolve, the stdin record, the ending callbacks the double asks, its reading of the hardware decoder's refusal, and the factory's create-call recording over the
 * consumer's signal and callbacks). The real process and the double run the same lifecycle scenarios side by side in stream.test.ts.
 */
import type { Assert, Equal, Extends } from "../testing/index.ts";
import type { FfmpegEnding, FfmpegEndingVerdict } from "./process.ts";
import type { FfmpegStreamingInit, FfmpegStreamingProcess, StreamingProcess, StreamingProcessFactory } from "./stream.ts";
import { TestStreamingProcess, TestStreamingProcessFactory, assertNoUnhandledRejections, expectAt, hardwareDecoderRefusalLine, settle, silentLog }
  from "../testing/index.ts";
import { captureUncaughtExceptions, lifetimeState, settlement } from "./process-parity.helpers.ts";
import { describe, mock, test } from "node:test";
import { FfmpegOptions } from "./options.ts";
import { HbpuAbortError } from "../util.ts";
import type { Mock } from "node:test";
import assert from "node:assert/strict";
import { makeCodecs } from "./codecs.helpers.ts";
import { streamingProcessFactory } from "./stream.ts";

// A sentinel FfmpegOptions stand-in. The doubles read it only to mark a hardware decoder's refusal their stderr lines report, which no row over it sets, and the
// factory records it for assertions, so a confined cast over a plain object is honest: the rows assert the factory threaded THIS EXACT reference through to its
// create-call log, not that it has any real FFmpeg behavior.
const sentinelOptions = { hbupTestSentinel: "ffmpeg-options" } as unknown as FfmpegOptions;

// Arguments that ask for the decoded frames on the GPU.
const GPU_FRAMES_ARGS = [ "-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld" ];

// A real FfmpegOptions, so a row reads the refusal's mark through the getter a consumer reads.
function makeOptions(): FfmpegOptions {

  return new FfmpegOptions({

    codecSupport: makeCodecs({ ffmpegVersion: "test" }),
    debug: false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    log: silentLog(),
    name: (): string => "test"
  });
}

// An options stand-in whose mark counts its calls, cast at the one boundary the double reads it through.
function countingOptions(): { mark: Mock<() => void>; options: FfmpegOptions } {

  const mark = mock.fn((): void => undefined);

  return { mark, options: { markHardwareDecoderRefusal: mark } as unknown as FfmpegOptions };
}

describe("StreamingProcess boundary - compile-time conformance", () => {

  test("the production FfmpegStreamingProcess and streamingProcessFactory conform to the boundary types (no cast)", () => {

    // The no-drift proof is type-level: the compiler holds the production factory to the creational interface and the production class to the product interface. No
    // real FfmpegStreamingProcess is constructed here, because its constructor spawns a child synchronously; stream.test.ts runs the real class against this double.
    const factoryConforms = streamingProcessFactory satisfies StreamingProcessFactory;

    // A type-only assertion that an FfmpegStreamingProcess value is assignable to StreamingProcess. The cast never executes at a constructed instance; the binding's
    // sole purpose is to make `tsc` reject the file if the class ever stops satisfying the interface by inheritance.
    const classConforms: StreamingProcess = null as unknown as FfmpegStreamingProcess;

    // The reason the boundary is an interface: the class's private fields make its type one no structural object satisfies, the double included. The claim is
    // type-level, so `tsc` rejects this file if the double ever becomes assignable to the class.
    type _DoubleIsNotTheClass = Assert<Equal<Extends<TestStreamingProcess, FfmpegStreamingProcess>, false>>;

    assert.ok(factoryConforms, "the production streamingProcessFactory must satisfy StreamingProcessFactory");
    assert.equal(classConforms, null, "the type-level FfmpegStreamingProcess -> StreamingProcess assignment is the conformance proof");
  });
});

describe("TestStreamingProcess - levers", () => {

  test("resolveReady resolves ready and leaves the lifetime live", async () => {

    const proc = new TestStreamingProcess();

    proc.resolveReady();

    assert.equal(await settlement(proc.ready), "resolved");
    assert.equal(lifetimeState(proc.signal), "live");
  });

  test("stderr lines set while ready is pending resolve it, from a fresh child and after stdout bytes, so resolveReady after them is refused", async () => {

    const parent = new AbortController();
    const fresh = new TestStreamingProcess({ signal: parent.signal });
    const written = new TestStreamingProcess({ signal: parent.signal });

    fresh.stderrLog = ["An invented stderr line."];
    written.writeStdout(Buffer.from("bytes"));
    written.stderrLog = ["An invented stderr line."];

    for(const proc of [ fresh, written ]) {

      assert.throws(() => proc.resolveReady(), { message: "TestStreamingProcess: ready has already resolved, so it cannot resolve again." });
    }

    // The parent's abort after the lines leaves ready resolved, as an abort after a real child's first stderr output leaves the real process's.
    parent.abort(new HbpuAbortError("shutdown"));

    assert.deepEqual([ await settlement(fresh.ready), await settlement(written.ready) ], [ "resolved", "resolved" ]);
  });

  test("a clean exit resolves exited with its information and ends the lifetime closed before any continuation of exited runs", async () => {

    const proc = new TestStreamingProcess();
    const atExit = proc.exited.then((info) => ({ cause: (proc.signal.reason as HbpuAbortError).cause, info, lifetime: lifetimeState(proc.signal) }));

    proc.exit({ exitCode: 0, exitSignal: null });

    assert.deepEqual(await atExit, { cause: { exitCode: 0, exitSignal: null }, info: { exitCode: 0, exitSignal: null }, lifetime: "closed" });
  });

  test("an exit of another code, or by a signal, ends the lifetime failed with the exit information as its cause", async () => {

    const exits = [ { exitCode: 3, exitSignal: null }, { exitCode: null, exitSignal: "SIGTERM" } ] as const;
    const readings = exits.map((info) => {

      const proc = new TestStreamingProcess();
      const atExit = proc.exited.then(() => ({ cause: (proc.signal.reason as HbpuAbortError).cause, lifetime: lifetimeState(proc.signal) }));

      proc.exit(info);

      return atExit;
    });

    assert.deepEqual(await Promise.all(readings), exits.map((info) => ({ cause: info, lifetime: "failed" })));
  });

  test("an exit after the parent's abort resolves exited and leaves the abort's reason standing", async () => {

    const parent = new AbortController();
    const proc = new TestStreamingProcess({ signal: parent.signal });
    const reason = new HbpuAbortError("replaced");

    parent.abort(reason);
    proc.exit({ exitCode: null, exitSignal: "SIGKILL" });

    assert.deepEqual(await proc.exited, { exitCode: null, exitSignal: "SIGKILL" });
    assert.equal(proc.signal.reason, reason, "the abort's reason stands through the exit");
  });

  test("a pending ready rejects with the lifetime's reason on any end: the parent's abort, an exit and a spawn failure", async () => {

    const parent = new AbortController();
    const aborted = new TestStreamingProcess({ signal: parent.signal });
    const exited = new TestStreamingProcess();
    const failed = new TestStreamingProcess();

    parent.abort(new HbpuAbortError("replaced"));
    exited.exit({ exitCode: 0, exitSignal: null });
    failed.failSpawn(new Error("spawn ENOENT"));

    assert.deepEqual(await Promise.all([ settlement(aborted.ready), settlement(exited.ready), settlement(failed.ready) ]),
      [ "rejected replaced", "rejected closed", "rejected failed" ]);
  });

  test("a spawn failure rejects ready and exited with a failed reason carrying its cause, the lifetime ended before any continuation of exited runs", async () => {

    const proc = new TestStreamingProcess();
    const cause = new Error("spawn ENOENT");
    const atExit = proc.exited.then(() => "resolved", (error: unknown) => ({ cause: (error as HbpuAbortError).cause, lifetime: lifetimeState(proc.signal),
      reason: error === proc.signal.reason }));

    proc.failSpawn(cause);

    assert.deepEqual(await atExit, { cause, lifetime: "failed", reason: true });
    assert.equal(await settlement(proc.ready), "rejected failed");
  });

  test("a spawn failure after the parent's abort keeps the abort's reason and rejects exited with it", async () => {

    const parent = new AbortController();
    const proc = new TestStreamingProcess({ signal: parent.signal });
    const reason = new HbpuAbortError("replaced");

    parent.abort(reason);
    proc.failSpawn(new Error("spawn ENOENT"));

    await assert.rejects(proc.exited, (error: unknown) => error === reason);
    assert.equal(proc.signal.reason, reason);
  });

  test("writeStdout hands its bytes over on stdout in order, before ready and between an abort and the exit, and stdout ends at the exit", async () => {

    const parent = new AbortController();
    const proc = new TestStreamingProcess({ signal: parent.signal });

    proc.writeStdout(Buffer.from("before-ready "));
    proc.resolveReady();
    proc.writeStdout(Buffer.from("while-ready "));
    parent.abort(new HbpuAbortError("replaced"));
    proc.writeStdout(Buffer.from("after-abort"));
    proc.exit({ exitCode: null, exitSignal: "SIGKILL" });

    assert.equal(Buffer.concat(await proc.stdout.toArray() as Buffer[]).toString(), "before-ready while-ready after-abort");
  });

  test("stdin records each chunk written, stays writable after the parent's abort, and is destroyed as an exit settles exited", async () => {

    const parent = new AbortController();
    const proc = new TestStreamingProcess({ signal: parent.signal });

    proc.stdin.write(Buffer.from("first"));
    parent.abort(new HbpuAbortError("replaced"));

    assert.equal(proc.stdin.writable, true, "stdin stays writable while the killed child has yet to exit");

    proc.stdin.write(Buffer.from("second"));
    await settle();
    proc.exit({ exitCode: null, exitSignal: "SIGKILL" });

    assert.deepEqual(proc.stdinWrites.map((chunk) => chunk.toString()), [ "first", "second" ]);
    assert.deepEqual({ destroyed: proc.stdin.destroyed, writable: proc.stdin.writable }, { destroyed: true, writable: false });
  });

  test("stdin and stdout close as a spawn failure settles exited", async () => {

    const proc = new TestStreamingProcess();

    proc.failSpawn(new Error("spawn ENOENT"));

    assert.equal(proc.stdin.writable, false);
    assert.deepEqual(await proc.stdout.toArray(), [], "stdout ends with nothing written");
  });

  test("ready and exited raise no unhandled rejection when neither is read", async () => {

    await assertNoUnhandledRejections(async () => {

      const parent = new AbortController();

      new TestStreamingProcess({ signal: parent.signal }).exit({ exitCode: 3, exitSignal: null });
      new TestStreamingProcess().failSpawn(new Error("spawn ENOENT"));
      parent.abort(new HbpuAbortError("replaced"));

      await settle();
    });
  });
});

describe("TestStreamingProcess - the levers refuse what a real process cannot do", () => {

  test("resolveReady throws the lifetime's reason after any end, and an error once ready has resolved", () => {

    const parent = new AbortController();
    const aborted = new TestStreamingProcess({ signal: parent.signal });
    const exited = new TestStreamingProcess();
    const failed = new TestStreamingProcess();
    const ready = new TestStreamingProcess();

    parent.abort(new HbpuAbortError("replaced"));
    exited.exit({ exitCode: 0, exitSignal: null });
    failed.failSpawn(new Error("spawn ENOENT"));
    ready.resolveReady();

    assert.throws(() => aborted.resolveReady(), { constructor: HbpuAbortError, name: "replaced" });
    assert.throws(() => exited.resolveReady(), { constructor: HbpuAbortError, name: "closed" });
    assert.throws(() => failed.resolveReady(), { constructor: HbpuAbortError, name: "failed" });
    assert.throws(() => ready.resolveReady(), { message: "TestStreamingProcess: ready has already resolved, so it cannot resolve again." });
  });

  test("failSpawn throws once the child has shown it spawned, by ready or by stdout bytes, after an exit, and a second time", () => {

    const ready = new TestStreamingProcess();
    const written = new TestStreamingProcess();
    const exited = new TestStreamingProcess();
    const failed = new TestStreamingProcess();

    ready.resolveReady();
    written.writeStdout(Buffer.from("bytes"));
    exited.exit({ exitCode: 0, exitSignal: null });
    failed.failSpawn(new Error("spawn ENOENT"));

    for(const proc of [ ready, written ]) {

      assert.throws(() => proc.failSpawn(new Error("spawn ENOENT")),
        { message: "TestStreamingProcess: the child has already shown it spawned, so the spawn cannot fail." });
    }

    for(const proc of [ exited, failed ]) {

      assert.throws(() => proc.failSpawn(new Error("spawn ENOENT")), { message: "TestStreamingProcess: exited has already settled, so the spawn cannot fail." });
    }
  });

  test("failSpawn throws once stderr lines are set, because a child that wrote to stderr has spawned", () => {

    const proc = new TestStreamingProcess();

    proc.stderrLog = ["An invented stderr line."];

    assert.throws(() => proc.failSpawn(new Error("spawn ENOENT")),
      { message: "TestStreamingProcess: the child has already shown it spawned, so the spawn cannot fail." });
    assert.equal(lifetimeState(proc.signal), "live", "and the refused lever leaves the lifetime as it was");
  });

  test("exit throws a second time and after a spawn failure", () => {

    const exited = new TestStreamingProcess();
    const failed = new TestStreamingProcess();

    exited.exit({ exitCode: 0, exitSignal: null });
    failed.failSpawn(new Error("spawn ENOENT"));

    for(const proc of [ exited, failed ]) {

      assert.throws(() => proc.exit({ exitCode: 0, exitSignal: null }), { message: "TestStreamingProcess: exited has already settled, so the child cannot exit." });
    }
  });

  test("writeStdout throws after the exit and after a spawn failure", () => {

    const exited = new TestStreamingProcess();
    const failed = new TestStreamingProcess();

    exited.exit({ exitCode: 0, exitSignal: null });
    failed.failSpawn(new Error("spawn ENOENT"));

    for(const proc of [ exited, failed ]) {

      assert.throws(() => proc.writeStdout(Buffer.from("late")), { message: "TestStreamingProcess: exited has already settled, so stdout takes no more bytes." });
    }
  });
});

describe("TestStreamingProcess - ending callbacks", () => {

  // Each row reads the asking right after the lever or abort that ends the lifetime, with no turn between, because the double asks inside that abort as the real
  // process does.

  test("a failed exit asks onFailed once with its reason and the lines set after construction", () => {

    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const onTimeout = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const proc = new TestStreamingProcess({ onFailed, onTimeout });
    const lines = [ "An invented stderr line the stand-in child wrote.", "A second invented stderr line." ];

    proc.stderrLog = lines;
    proc.exit({ exitCode: 3, exitSignal: null });

    assert.deepEqual({ onFailed: onFailed.mock.callCount(), onTimeout: onTimeout.mock.callCount() }, { onFailed: 1, onTimeout: 0 }, "onFailed alone is asked, once");

    const { reason, stderrLog } = expectAt(onFailed.mock.calls, 0, "the asking").arguments[0];

    assert.deepEqual({ cause: reason.cause, name: reason.name, stderrLog }, { cause: { exitCode: 3, exitSignal: null }, name: "failed", stderrLog: lines },
      "about the failed exit, handed the lines the suite set after construction");
  });

  test("the parent's timeout abort asks onTimeout once with the parent's reason", () => {

    const parent = new AbortController();
    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const onTimeout = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const reason = new HbpuAbortError("timeout");

    new TestStreamingProcess({ onFailed, onTimeout, signal: parent.signal });
    parent.abort(reason);

    assert.deepEqual({ onFailed: onFailed.mock.callCount(), onTimeout: onTimeout.mock.callCount() }, { onFailed: 0, onTimeout: 1 }, "onTimeout alone is asked, once");
    assert.equal(expectAt(onTimeout.mock.calls, 0, "the asking").arguments[0].reason, reason, "about the parent's reason itself");
  });

  test("the parent's failed abort and a spawn failure each ask onFailed once with the failed reason", () => {

    const parent = new AbortController();
    const aborted = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const spawnFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const reason = new HbpuAbortError("failed");
    const cause = new Error("spawn ENOENT");

    new TestStreamingProcess({ onFailed: aborted, signal: parent.signal });
    parent.abort(reason);
    new TestStreamingProcess({ onFailed: spawnFailed }).failSpawn(cause);

    assert.deepEqual({ aborted: aborted.mock.callCount(), spawnFailed: spawnFailed.mock.callCount() }, { aborted: 1, spawnFailed: 1 }, "each is asked once");
    assert.equal(expectAt(aborted.mock.calls, 0, "the abort's asking").arguments[0].reason, reason, "the abort asks about the parent's reason itself");
    assert.equal(expectAt(spawnFailed.mock.calls, 0, "the spawn failure's asking").arguments[0].reason.cause, cause, "the spawn failure asks about the spawn's error");
  });

  test("a parent already aborted as failed has onFailed asked once inside the constructor, with no lines", () => {

    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");

    new TestStreamingProcess({ onFailed, signal: AbortSignal.abort(new HbpuAbortError("failed")) });

    assert.equal(onFailed.mock.callCount(), 1, "onFailed is asked before the constructor returns");
    assert.deepEqual(expectAt(onFailed.mock.calls, 0, "the asking").arguments[0].stderrLog, [], "with no lines, since no suite has set any yet");
  });

  test("a clean exit, a shutdown and a platform TimeoutError ask neither callback", () => {

    const endings: { end: (proc: TestStreamingProcess, parent: AbortController) => void; lifetime: string }[] = [

      { end: (proc): void => proc.exit({ exitCode: 0, exitSignal: null }), lifetime: "closed" },
      { end: (_proc, parent): void => parent.abort(new HbpuAbortError("shutdown")), lifetime: "shutdown" },
      { end: (_proc, parent): void => parent.abort(new DOMException("An invented deadline elapsed.", "TimeoutError")),
        lifetime: "a reason other than an HbpuAbortError" }
    ];

    const readings = endings.map(({ end }) => {

      const parent = new AbortController();
      const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
      const onTimeout = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
      const proc = new TestStreamingProcess({ onFailed, onTimeout, signal: parent.signal });

      end(proc, parent);

      return { asked: onFailed.mock.callCount() + onTimeout.mock.callCount(), lifetime: lifetimeState(proc.signal) };
    });

    assert.deepEqual(readings, endings.map(({ lifetime }) => ({ asked: 0, lifetime })), "each ending ends the lifetime and asks nothing");
  });

  test("a throwing callback reaches the uncaught-exception channel, and the exit still resolves exited and ends the lifetime", async () => {

    const thrown = new Error("An invented callback failure.");
    const reading = await captureUncaughtExceptions(async (captured) => {

      const proc = new TestStreamingProcess({

        onFailed: (): FfmpegEndingVerdict => {

          throw thrown;
        }
      });

      proc.exit({ exitCode: 3, exitSignal: null });

      // The throw reaches the channel on a later turn than the abort that raised it, so the row crosses one before it looks.
      await settle();

      return { captured: [...captured], exited: await settlement(proc.exited), lifetime: lifetimeState(proc.signal) };
    });

    assert.deepEqual(reading, { captured: [thrown], exited: "resolved", lifetime: "failed" }, "the double leaves the throw to surface as the bug it is");
  });

  test("a throwing callback under a parent already aborted leaves create(), because the double asks inside its constructor", () => {

    const thrown = new Error("An invented callback failure.");
    const onFailed = (): FfmpegEndingVerdict => {

      throw thrown;
    };

    assert.throws(() => new TestStreamingProcessFactory().create(sentinelOptions, { onFailed, signal: AbortSignal.abort(new HbpuAbortError("failed")) }),
      (error: unknown) => error === thrown);
  });
});

describe("TestStreamingProcess - the hardware decoder's refusal", () => {

  test("a refusal line marks the options create was handed the moment the lines are set, before any ending", () => {

    const factory = new TestStreamingProcessFactory();
    const options = makeOptions();

    factory.create(options, { args: GPU_FRAMES_ARGS });

    const proc = expectAt(factory.createCalls, 0, "the process the factory built").process;

    proc.stderrLog = [ "An invented stderr line.", hardwareDecoderRefusalLine ];

    assert.deepEqual({ lifetime: lifetimeState(proc.signal), marked: options.hardwareDecoderRefused }, { lifetime: "live", marked: true });
  });

  test("the options are marked once, however many lines and later sets carry the refusal", () => {

    const { mark, options } = countingOptions();
    const proc = new TestStreamingProcess({}, options);

    proc.stderrLog = [ hardwareDecoderRefusalLine, hardwareDecoderRefusalLine ];
    proc.stderrLog = [hardwareDecoderRefusalLine];

    assert.equal(mark.mock.callCount(), 1);
  });

  test("a set after the double has sighted the refusal reads nothing more, so options a consumer reset stay unmarked", () => {

    const options = makeOptions();
    const proc = new TestStreamingProcess({}, options);

    proc.stderrLog = [hardwareDecoderRefusalLine];
    options.resetHardwareDecoderRefusal();
    proc.stderrLog = [hardwareDecoderRefusalLine];

    assert.equal(options.hardwareDecoderRefused, false, "the double reads its lines until its own first sighting, as the real drain does");
  });

  test("a double built with args and no options marks nothing and still asks nothing about a refused GPU decode", () => {

    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const proc = new TestStreamingProcess({ args: GPU_FRAMES_ARGS, onFailed });

    proc.stderrLog = [hardwareDecoderRefusalLine];
    proc.exit({ exitCode: 3, exitSignal: null });

    assert.deepEqual({ lifetime: lifetimeState(proc.signal), onFailed: onFailed.mock.callCount() }, { lifetime: "failed", onFailed: 0 },
      "its own sighting decides the ending, with no options to mark");
  });

  test("a double built with args the consumer changes afterward reads the args it was built with", () => {

    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const args = [...GPU_FRAMES_ARGS];
    const proc = new TestStreamingProcess({ args, onFailed }, makeOptions());

    args.length = 0;
    proc.stderrLog = [hardwareDecoderRefusalLine];
    proc.exit({ exitCode: 3, exitSignal: null });

    assert.equal(onFailed.mock.callCount(), 0, "the copy taken at construction still asks for its frames on the GPU");
  });
});

describe("TestStreamingProcessFactory - create-call recording", () => {

  test("create records the options and the init with its args, and answers a fresh process on every call", () => {

    const factory = new TestStreamingProcessFactory();
    const init: FfmpegStreamingInit = { args: [ "-hide_banner", "-i", "pipe:0", "-f", "rtp", "srtp://127.0.0.1:50000" ] };

    const first = factory.create(sentinelOptions, init);
    const second = factory.create(sentinelOptions, init);
    const recorded = expectAt(factory.createCalls, 0, "the first create call");

    assert.equal(factory.createCalls.length, 2, "every create call must be recorded");
    assert.equal(recorded.options, sentinelOptions, "the recorded options must be the exact reference passed to create()");
    assert.equal(recorded.init, init, "the recorded init must be the exact reference passed to create()");
    assert.deepEqual(recorded.init.args, [ "-hide_banner", "-i", "pipe:0", "-f", "rtp", "srtp://127.0.0.1:50000" ], "the assembled command reads from the record");
    assert.equal(recorded.process, first, "the recorded process must be the one create() answered");
    assert.ok(first instanceof TestStreamingProcess, "create() must answer a TestStreamingProcess");
    assert.notEqual(second, first, "every create() must answer a fresh process");
  });

  test("a process the factory built ends when the signal passed to create aborts, and a process built over another signal goes on", () => {

    const factory = new TestStreamingProcessFactory();
    const ended = new AbortController();
    const reason = new HbpuAbortError("replaced");

    factory.create(sentinelOptions, { signal: ended.signal });
    factory.create(sentinelOptions, { signal: new AbortController().signal });

    ended.abort(reason);

    assert.equal(expectAt(factory.createCalls, 0, "the process built over the aborted signal").process.signal.reason, reason,
      "the consumer's signal must end the process the factory built with that signal's reason");
    assert.equal(expectAt(factory.createCalls, 1, "the process built over a live signal").process.signal.aborted, false,
      "a process built over another signal must not end with it");
  });

  test("a process the factory built asks the ending callbacks passed to create", () => {

    const factory = new TestStreamingProcessFactory();
    const parent = new AbortController();
    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const onTimeout = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");

    factory.create(sentinelOptions, { onFailed, onTimeout });
    factory.create(sentinelOptions, { onFailed, onTimeout, signal: parent.signal });

    expectAt(factory.createCalls, 0, "the process that fails").process.exit({ exitCode: 3, exitSignal: null });
    parent.abort(new HbpuAbortError("timeout"));

    assert.deepEqual({ onFailed: onFailed.mock.callCount(), onTimeout: onTimeout.mock.callCount() }, { onFailed: 1, onTimeout: 1 },
      "the failed exit asks the onFailed passed in, and the timeout abort the onTimeout");
  });
});
