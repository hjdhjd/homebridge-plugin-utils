/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/recording-process.test.ts: Unit tests for the RecordingProcess dependency-inversion seam - the compile-time conformance of the production class and factory,
 * plus the shipped FFmpeg-free TestRecordingProcess / TestRecordingProcessFactory doubles (init / segment yielding, abort with a real reason, the pre-init init reject,
 * dual-signal segment termination, the recording stdin sink, and the factory's create-call recording).
 */
import type { FfmpegRecordingInit, FfmpegRecordingProcess, RecordingProcess, RecordingProcessFactory } from "./record.ts";
import { HbpuAbortError, isHbpuAbortReason } from "../util.ts";
import { TestRecordingProcess, TestRecordingProcessFactory } from "./recording-process-double.ts";
import { describe, test } from "node:test";
import type { FfmpegOptions } from "./options.ts";
import assert from "node:assert/strict";
import { recordingProcessFactory } from "./record.ts";

// Sentinel FfmpegOptions / FfmpegRecordingInit stand-ins. The doubles never read these - they only record them for assertions - so a confined cast over a plain object
// is honest: the test asserts the factory threaded THESE EXACT references through to its create-call log, not that they have any real FFmpeg behavior.
const sentinelOptions = { hbupTestSentinel: "ffmpeg-options" } as unknown as FfmpegOptions;
const sentinelInit = { hbupTestSentinel: "recording-init" } as unknown as FfmpegRecordingInit;

describe("RecordingProcess seam - compile-time conformance", () => {

  test("the production FfmpegRecordingProcess and recordingProcessFactory conform to the seam types (no cast)", () => {

    // The no-drift proof is purely type-level: the compiler enforces that the production class is assignable to the product interface and the production factory is
    // assignable to the creational interface. We do NOT construct a real FfmpegRecordingProcess here - its constructor spawns a child synchronously, and a bare
    // abort() without `await using` can leak an unawaited child. The `implements RecordingProcess` clause on the class already proves the class conforms; the runtime
    // behavior of the real class is covered by record.test.ts. These bindings are belt-and-suspenders for the factory return type and the class assignability.
    const factoryConforms = recordingProcessFactory satisfies RecordingProcessFactory;

    // A type-only assertion that an FfmpegRecordingProcess value is assignable to RecordingProcess. The cast never executes at a constructed instance; the binding's
    // sole purpose is to make `tsc` reject the file if the class ever stops satisfying the interface by inheritance.
    const classConforms: RecordingProcess = null as unknown as FfmpegRecordingProcess;

    assert.ok(factoryConforms, "the production recordingProcessFactory must satisfy RecordingProcessFactory");
    assert.equal(classConforms, null, "the type-level FfmpegRecordingProcess -> RecordingProcess assignment is the conformance proof");
  });
});

describe("TestRecordingProcess - configured init and media segments", () => {

  test("getInitSegment resolves with the configured init buffer", async () => {

    const initSegment = Buffer.from("init-bytes");
    const proc = new TestRecordingProcess({ initSegment });

    const resolved = await proc.getInitSegment();

    assert.equal(resolved, initSegment, "getInitSegment must resolve with the exact configured init buffer");
  });

  test("segments() yields the configured media buffers in order", async () => {

    const segments = [ Buffer.from("seg-0"), Buffer.from("seg-1"), Buffer.from("seg-2") ];
    const proc = new TestRecordingProcess({ segments });

    const collected: Buffer[] = [];

    for await (const segment of proc.segments()) {

      collected.push(segment);
    }

    assert.deepEqual(collected, segments, "segments() must yield exactly the configured buffers, in order");
  });

  test("bufferedSegments, isTimedOut, and stderrLog report the configured values", () => {

    const stderrLog = [ "line one", "line two" ];
    const proc = new TestRecordingProcess({ bufferedSegments: 7, isTimedOut: true, stderrLog });

    assert.equal(proc.bufferedSegments, 7, "bufferedSegments must report the configured depth");
    assert.equal(proc.isTimedOut, true, "isTimedOut must report the configured flag");
    assert.deepEqual(proc.stderrLog, stderrLog, "stderrLog must report the configured lines");
  });

  test("the default-configured process reports the documented defaults", async () => {

    // A bare construction exercises every `??` default branch: empty init, empty segments, zero buffered, not timed out, empty stderr.
    const proc = new TestRecordingProcess();

    const init = await proc.getInitSegment();

    assert.equal(init.length, 0, "the default init segment is an empty buffer");
    assert.equal(proc.bufferedSegments, 0, "the default buffered-segment depth is zero");
    assert.equal(proc.isTimedOut, false, "the default timed-out flag is false");
    assert.deepEqual(proc.stderrLog, [], "the default stderr log is empty");

    const collected: Buffer[] = [];

    for await (const segment of proc.segments()) {

      collected.push(segment);
    }

    assert.equal(collected.length, 0, "the default media-segment sequence is empty");
  });
});

describe("TestRecordingProcess - stdin recording sink", () => {

  test("stdin records each written chunk and stays writable across abort", async () => {

    const proc = new TestRecordingProcess();

    const writeChunk = (chunk: Buffer): Promise<void> => new Promise((resolve, reject) => {

      proc.stdin.write(chunk, (error) => error ? reject(error) : resolve());
    });

    await writeChunk(Buffer.from("chunk-before"));

    // Abort must NOT end or destroy the recording sink: a consumer flushing an in-flight segment feed must still land its writes.
    proc.abort();

    assert.equal(proc.stdin.writable, true, "stdin must stay writable across abort so a racing recorded write still lands");

    await writeChunk(Buffer.from("chunk-after"));

    assert.deepEqual(proc.stdinWrites, [ Buffer.from("chunk-before"), Buffer.from("chunk-after") ], "stdin must record every written chunk, including post-abort writes");
  });
});

describe("TestRecordingProcess - abort and the pre-init init reject", () => {

  test("abort() with no reason aborts signal with a real HbpuAbortError('shutdown') default and records the call", () => {

    const proc = new TestRecordingProcess();

    proc.abort();

    assert.equal(proc.signal.aborted, true, "abort() must abort the process signal");
    assert.equal(isHbpuAbortReason(proc.signal.reason, "shutdown"), true, "the default abort reason must be a real HbpuAbortError('shutdown')");
    assert.equal(proc.abortCalls.length, 1, "abort() must record exactly one call");
    assert.equal(proc.abortCalls[0], proc.signal.reason, "the recorded reason must be the same reason the signal carries");
  });

  test("abort(reason) passes an explicit reason through unchanged and records it", () => {

    const proc = new TestRecordingProcess();
    const reason = new HbpuAbortError("timeout");

    proc.abort(reason);

    assert.equal(proc.signal.reason, reason, "an explicit abort reason must pass through to signal.reason unchanged");
    assert.equal(proc.abortCalls[0], reason, "the explicit reason must be recorded");
  });

  test("getInitSegment() rejects with signal.reason after a pre-init abort()", async () => {

    const proc = new TestRecordingProcess({ initSegment: Buffer.from("never-seen") });

    proc.abort(new HbpuAbortError("failed"));

    await assert.rejects(() => proc.getInitSegment(), (error: unknown) => isHbpuAbortReason(error, "failed"),
      "getInitSegment() must reject with the abort signal's reason when abort fired before init");
  });
});

describe("TestRecordingProcess - segments() terminates on either signal", () => {

  test("segments() returns early when the double's own abort() fires mid-iteration", async () => {

    const segments = [ Buffer.from("seg-0"), Buffer.from("seg-1"), Buffer.from("seg-2") ];
    const proc = new TestRecordingProcess({ segments });

    const collected: Buffer[] = [];

    for await (const segment of proc.segments()) {

      collected.push(segment);

      // Abort the process's own signal after the first segment; the generator must terminate before yielding the rest.
      proc.abort();
    }

    assert.deepEqual(collected, [Buffer.from("seg-0")], "the generator must terminate after the double's own abort, yielding nothing further");
  });

  test("segments() returns early when the passed init.signal aborts mid-iteration", async () => {

    const segments = [ Buffer.from("seg-0"), Buffer.from("seg-1"), Buffer.from("seg-2") ];
    const proc = new TestRecordingProcess({ segments });

    const controller = new AbortController();
    const collected: Buffer[] = [];

    for await (const segment of proc.segments({ signal: controller.signal })) {

      collected.push(segment);

      // Abort the per-call signal after the first segment; the generator must compose it and terminate without yielding the rest, leaving the process signal untouched.
      controller.abort();
    }

    assert.deepEqual(collected, [Buffer.from("seg-0")], "the generator must terminate after the passed signal aborts, yielding nothing further");
    assert.equal(proc.signal.aborted, false, "aborting the per-call signal must NOT abort the process's own signal");
  });
});

describe("TestRecordingProcessFactory - create-call recording", () => {

  test("create() records the options and init and returns a fresh default process when none was supplied", () => {

    const factory = new TestRecordingProcessFactory();

    const returned = factory.create(sentinelOptions, sentinelInit);

    assert.equal(factory.createCalls.length, 1, "create() must record exactly one call");

    const recorded = factory.createCalls[0];

    assert.ok(recorded, "create() must record the call");
    assert.equal(recorded.options, sentinelOptions, "the recorded options must be the exact reference passed to create()");
    assert.equal(recorded.init, sentinelInit, "the recorded init must be the exact reference passed to create()");
    assert.ok(returned instanceof TestRecordingProcess, "create() must return a TestRecordingProcess");
    assert.equal(recorded.process, returned, "the recorded process must be the one create() returned");
  });

  test("create() returns the constructor-supplied process from every call", () => {

    const process = new TestRecordingProcess({ initSegment: Buffer.from("preconfigured") });
    const factory = new TestRecordingProcessFactory(process);

    const first = factory.create(sentinelOptions, sentinelInit);
    const second = factory.create(sentinelOptions, sentinelInit);

    assert.equal(first, process, "the first create() must return the supplied process");
    assert.equal(second, process, "the second create() must return the same supplied process");
    assert.equal(factory.createCalls.length, 2, "both create calls must be recorded");
  });
});
