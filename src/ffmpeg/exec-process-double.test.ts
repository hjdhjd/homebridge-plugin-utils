/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/exec-process-double.test.ts: Unit tests for the ExecProcess dependency-inversion boundary - the compile-time conformance of the production class and
 * factory, plus the shipped FFmpeg-free TestExecProcess / TestExecProcessFactory doubles (the canned and streamed stdin record, result() and what it carries, a
 * failed spawn nobody reads, its reading of the hardware decoder's refusal, and the factory's create-call recording). The real run and the double run the same
 * ending scenarios side by side in exec.test.ts.
 */
import type { Assert, Equal, Extends } from "../testing/index.ts";
import type { ExecProcess, ExecProcessFactory, FfmpegExec, FfmpegExecInit } from "./exec.ts";
import type { FfmpegEnding, FfmpegEndingVerdict, FfmpegProcessExitInfo } from "./process.ts";
import { TestExecProcess, TestExecProcessFactory, assertNoUnhandledRejections, expectAt, hardwareDecoderRefusalLine, settle, silentLog } from "../testing/index.ts";
import { describe, mock, test } from "node:test";
import { FfmpegOptions } from "./options.ts";
import { HbpuAbortError } from "../util.ts";
import type { Mock } from "node:test";
import assert from "node:assert/strict";
import { execProcessFactory } from "./exec.ts";
import { lifetimeState } from "./process-parity.helpers.ts";
import { makeCodecs } from "./codecs.helpers.ts";

// A sentinel FfmpegOptions stand-in. The double reads it only to mark a hardware decoder's refusal its stderr lines report, which no row over it sets, and the
// factory records it for assertions, so a confined cast over a plain object is honest: the rows assert the factory threaded this exact reference through to its
// create-call log, not that it has any real FFmpeg behavior.
const sentinelOptions = { hbpuTestSentinel: "ffmpeg-options" } as unknown as FfmpegOptions;

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

// The exit a child killed by its run's abort reports.
const KILLED: FfmpegProcessExitInfo = { exitCode: null, exitSignal: "SIGKILL" };

// What a row's child writes to stdout, and the stderr lines a row sets.
const STDOUT_BYTES = "invented-snapshot-bytes";
const STDERR_LINES = [ "An invented stderr line.", "A second invented stderr line." ];

describe("ExecProcess boundary - compile-time conformance", () => {

  test("the production FfmpegExec and execProcessFactory conform to the boundary types (no cast)", () => {

    // The no-drift proof is type-level: the compiler holds the production factory to the creational interface and the production class to the product interface. No
    // real FfmpegExec is constructed here, because its constructor spawns a child synchronously; exec.test.ts runs the real class against this double.
    const factoryConforms = execProcessFactory satisfies ExecProcessFactory;

    // A type-only assertion that an FfmpegExec value is assignable to ExecProcess. The cast never executes at a constructed instance; the binding's sole purpose is to
    // make `tsc` reject the file if the class ever stops satisfying the interface.
    const classConforms: ExecProcess = null as unknown as FfmpegExec;

    // The reason the boundary is an interface: the class's private fields make its type one no structural object satisfies, the double included. The claim is
    // type-level, so `tsc` rejects this file if the double ever becomes assignable to the class.
    type _DoubleIsNotTheClass = Assert<Equal<Extends<TestExecProcess, FfmpegExec>, false>>;

    assert.ok(factoryConforms, "the production execProcessFactory must satisfy ExecProcessFactory");
    assert.equal(classConforms, null, "the type-level FfmpegExec -> ExecProcess assignment is the conformance proof");
  });
});

describe("TestExecProcess - stdin", () => {

  test("a canned stdin buffer is written and stdin ended on the next microtask, not before", async () => {

    const canned = Buffer.from("invented canned input");
    const proc = new TestExecProcess({ stdin: canned });
    const atConstruction = proc.stdinWrites.length;

    await Promise.resolve();

    assert.deepEqual({ atConstruction, ended: proc.stdin.writableEnded, writes: proc.stdinWrites }, { atConstruction: 0, ended: true, writes: [canned] });
  });

  test("a canned stdin buffer is skipped when the lifetime ends before the next microtask", async () => {

    const controller = new AbortController();
    const proc = new TestExecProcess({ signal: controller.signal, stdin: Buffer.from("invented canned input") });

    controller.abort(new HbpuAbortError("shutdown"));
    await Promise.resolve();

    assert.deepEqual({ ended: proc.stdin.writableEnded, writes: proc.stdinWrites.length }, { ended: false, writes: 0 });
  });

  test("with no canned buffer, the chunks a consumer writes to stdin are recorded in order and the consumer ends the stream", () => {

    const proc = new TestExecProcess();

    proc.stdin.write(Buffer.from("alpha-"));
    proc.stdin.write(Buffer.from("beta"));
    proc.stdin.end();

    assert.deepEqual({ ended: proc.stdin.writableEnded, written: Buffer.concat(proc.stdinWrites).toString() }, { ended: true, written: "alpha-beta" });
  });
});

describe("TestExecProcess - result()", () => {

  test("result() read twice answers the same bytes, every byte the child wrote to stdout", async () => {

    const proc = new TestExecProcess();

    proc.writeStdout(Buffer.from("invented-"));
    proc.writeStdout(Buffer.from("output"));
    proc.exit({ exitCode: 0, exitSignal: null });

    const first = await proc.result();
    const second = await proc.result();

    assert.deepEqual({ first: first.stdout.toString(), second: second.stdout.toString() }, { first: "invented-output", second: "invented-output" });
  });

  test("result() stays pending after an abort until the exit lever, then resolves with the killed exit", async () => {

    const controller = new AbortController();
    const proc = new TestExecProcess({ signal: controller.signal });
    let settled = false;
    const result = proc.result().then((value) => {

      settled = true;

      return value;
    });

    controller.abort(new HbpuAbortError("shutdown"));
    await settle();

    const beforeExit = settled;

    proc.exit(KILLED);

    const { exitCode, exitSignal } = await result;

    assert.deepEqual({ beforeExit, exit: { exitCode, exitSignal }, lifetime: lifetimeState(proc.signal) }, { beforeExit: false, exit: KILLED, lifetime: "shutdown" });
  });

  test("result() carries the stderr lines the suite set, once the child has exited", async () => {

    const proc = new TestExecProcess();

    proc.stderrLog = STDERR_LINES;
    proc.writeStdout(Buffer.from(STDOUT_BYTES));
    proc.exit({ exitCode: 0, exitSignal: null });

    const { stderrLog, stdout } = await proc.result();

    assert.deepEqual({ stderrLog, stdout: stdout.toString() }, { stderrLog: STDERR_LINES, stdout: STDOUT_BYTES });
  });

  test("a failed spawn whose result() nobody reads raises no unhandled rejection", async () => {

    await assertNoUnhandledRejections(async () => {

      new TestExecProcess().failSpawn(Object.assign(new Error("An invented spawn failure."), { code: "ENOENT" }));
      new TestExecProcess({ signal: AbortSignal.abort(new HbpuAbortError("timeout")) }).failSpawn(new Error("An invented spawn failure."));

      await settle();
    });
  });
});

describe("TestExecProcess - the hardware decoder's refusal", () => {

  test("a refusal line marks the options create was handed the moment the lines are set, before any ending", () => {

    const factory = new TestExecProcessFactory();
    const options = makeOptions();

    factory.create(options, { args: GPU_FRAMES_ARGS });

    const proc = expectAt(factory.createCalls, 0, "the run the factory built").process;

    proc.stderrLog = [ "An invented stderr line.", hardwareDecoderRefusalLine ];

    assert.deepEqual({ lifetime: lifetimeState(proc.signal), marked: options.hardwareDecoderRefused }, { lifetime: "live", marked: true });
  });

  test("the options are marked once, however many lines and later sets carry the refusal", () => {

    const { mark, options } = countingOptions();
    const proc = new TestExecProcess({}, options);

    proc.stderrLog = [ hardwareDecoderRefusalLine, hardwareDecoderRefusalLine ];
    proc.stderrLog = [hardwareDecoderRefusalLine];

    assert.equal(mark.mock.callCount(), 1);
  });

  test("a set after the double has sighted the refusal reads nothing more, so options a consumer reset stay unmarked", () => {

    const options = makeOptions();
    const proc = new TestExecProcess({}, options);

    proc.stderrLog = [hardwareDecoderRefusalLine];
    options.resetHardwareDecoderRefusal();
    proc.stderrLog = [hardwareDecoderRefusalLine];

    assert.equal(options.hardwareDecoderRefused, false, "the double reads its lines until its own first sighting, as the real drain does");
  });

  test("a double built with args and no options marks nothing and still asks nothing about a refused GPU decode", async () => {

    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");
    const proc = new TestExecProcess({ args: GPU_FRAMES_ARGS, onFailed });

    proc.stderrLog = [hardwareDecoderRefusalLine];
    proc.exit({ exitCode: 3, exitSignal: null });

    const { exitCode } = await proc.result();

    assert.deepEqual({ exitCode, lifetime: lifetimeState(proc.signal), onFailed: onFailed.mock.callCount() }, { exitCode: 3, lifetime: "failed", onFailed: 0 },
      "its child's own sighting decides the ending, with no options to mark");
  });

  test("failSpawn throws once stderr lines are set, because a child that wrote to stderr has spawned", () => {

    const proc = new TestExecProcess();

    proc.stderrLog = ["An invented stderr line."];

    assert.throws(() => proc.failSpawn(new Error("spawn ENOENT")),
      { message: "TestStreamingProcess: the child has already shown it spawned, so the spawn cannot fail." });
    assert.equal(lifetimeState(proc.signal), "live", "and the refused lever leaves the lifetime as it was");
  });
});

describe("TestExecProcessFactory - create-call recording", () => {

  test("create records the options, the init and the run it answered, in order, and an omitted init as an empty one", () => {

    const factory = new TestExecProcessFactory();
    const init: FfmpegExecInit = { args: [ "-i", "pipe:0" ], stdin: Buffer.from("invented canned input") };
    const withInit = factory.create(sentinelOptions, init);
    const withoutInit = factory.create(sentinelOptions);
    const first = expectAt(factory.createCalls, 0, "the create call with an init");
    const second = expectAt(factory.createCalls, 1, "the create call without an init");

    assert.equal(factory.createCalls.length, 2, "every create call must be recorded");
    assert.equal(first.options, sentinelOptions, "the recorded options must be the exact reference passed to create()");
    assert.equal(first.init, init, "the recorded init must be the exact reference passed to create()");
    assert.equal(first.process, withInit, "the recorded run must be the one create() answered");
    assert.deepEqual(second.init, {}, "an omitted init must be recorded as an empty one");
    assert.equal(second.process, withoutInit, "the recorded runs must be in call order");
    assert.ok(withInit instanceof TestExecProcess, "create() must answer a TestExecProcess");
    assert.notEqual(withoutInit, withInit, "every create() must answer a fresh run");
  });
});
