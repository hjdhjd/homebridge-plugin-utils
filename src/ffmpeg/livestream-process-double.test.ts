/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/livestream-process-double.test.ts: Unit tests for the LivestreamProcess dependency-inversion boundary - the compile-time conformance of the production class
 * and factory, plus the shipped FFmpeg-free TestLivestreamProcess / TestLivestreamProcessFactory doubles (the drivers with the dispose count, their refusals, and the
 * factory's create-call recording over the consumer's signal).
 */
import type { FfmpegLivestreamInit, FfmpegLivestreamProcess, LivestreamProcess, LivestreamProcessFactory } from "./record.ts";
import { TestLivestreamProcess, TestLivestreamProcessFactory, expectAt } from "../testing/index.ts";
import { describe, test } from "node:test";
import type { FfmpegOptions } from "./options.ts";
import { HbpuAbortError } from "../util.ts";
import assert from "node:assert/strict";
import { livestreamProcessFactory } from "./record.ts";

// A sentinel FfmpegOptions stand-in. The doubles never read it - the factory only records it for assertions - so a confined cast over a plain object is honest: the
// rows assert the factory threaded THIS EXACT reference through to its create-call log, not that it has any real FFmpeg behavior.
const sentinelOptions = { hbupTestSentinel: "ffmpeg-options" } as unknown as FfmpegOptions;

// The livestream init a consumer would pass, with the signal it ends the process through.
function livestreamInit(signal?: AbortSignal): FfmpegLivestreamInit {

  return { livestream: { url: "rtsp://test/stream" }, signal };
}

describe("LivestreamProcess boundary - compile-time conformance", () => {

  test("the production FfmpegLivestreamProcess and livestreamProcessFactory conform to the boundary types (no cast)", () => {

    // The no-drift proof is type-level: the compiler holds the production factory to the creational interface and the production class to the product interface. No
    // real FfmpegLivestreamProcess is constructed here, because its constructor spawns a child synchronously; record.test.ts runs the real class against this double.
    const factoryConforms = livestreamProcessFactory satisfies LivestreamProcessFactory;

    // A type-only assertion that an FfmpegLivestreamProcess value is assignable to LivestreamProcess. The cast never executes at a constructed instance; the binding's
    // sole purpose is to make `tsc` reject the file if the class ever stops satisfying the interface by inheritance.
    const classConforms: LivestreamProcess = null as unknown as FfmpegLivestreamProcess;

    assert.ok(factoryConforms, "the production livestreamProcessFactory must satisfy LivestreamProcessFactory");
    assert.equal(classConforms, null, "the type-level FfmpegLivestreamProcess -> LivestreamProcess assignment is the conformance proof");
  });
});

describe("TestLivestreamProcess - drivers", () => {

  test("resolveInit resolves the init wait with its bytes, and each getInitSegment call returns a promise of its own", async () => {

    const proc = new TestLivestreamProcess();
    const initSegment = Buffer.from("init-bytes");
    const initWait = proc.getInitSegment();

    proc.resolveInit(initSegment);

    assert.notEqual(proc.getInitSegment(), proc.getInitSegment(), "each call must hand back a new promise, as the real async method does");
    assert.equal(await initWait, initSegment, "the init wait must resolve with the exact bytes resolveInit was handed");
  });

  test("feed queues each media segment for the read, in the order fed", async () => {

    const proc = new TestLivestreamProcess();
    const segments = [ Buffer.from("seg-0"), Buffer.from("seg-1"), Buffer.from("seg-2") ];

    proc.resolveInit(Buffer.from("init"));

    for(const segment of segments) {

      proc.feed(segment);
    }

    proc.end();

    assert.deepEqual(await Array.fromAsync(proc.segments()), segments);
  });

  test("end closes the source with the closed reason, and a later abort leaves that reason standing", () => {

    const proc = new TestLivestreamProcess();

    proc.end();
    proc.abort(new HbpuAbortError("replaced"));

    assert.throws(() => proc.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "closed" });
  });

  test("end is a no-op once the lifetime has ended", () => {

    const proc = new TestLivestreamProcess();

    proc.abort(new HbpuAbortError("replaced"));
    proc.end();

    assert.throws(() => proc.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "replaced" });
  });

  test("abort with no reason ends the lifetime with a real HbpuAbortError('shutdown'), as the real abort does", () => {

    const proc = new TestLivestreamProcess();

    assert.equal(proc.signal.aborted, false, "a double built with no parent signal lives until its own lifetime ends");

    proc.abort();

    assert.throws(() => proc.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" });
  });

  test("abort passes an explicit reason through unchanged, and a second abort leaves the first reason standing", () => {

    const proc = new TestLivestreamProcess();
    const reason = new HbpuAbortError("replaced");

    proc.abort(reason);
    proc.abort(new HbpuAbortError("timeout"));

    assert.equal(proc.signal.reason, reason, "the first abort's reason must be the one the lifetime carries");
  });

  test("disposeCalls counts every dispose call, the repeat included", async () => {

    const proc = new TestLivestreamProcess();

    await proc[Symbol.asyncDispose]();
    await proc[Symbol.asyncDispose]();

    assert.equal(proc.disposeCalls, 2, "each dispose call must be counted, the repeat included");
  });
});

describe("TestLivestreamProcess - the drivers refuse what a real process cannot do", () => {

  test("resolveInit and feed throw the lifetime's reason once the lifetime has ended", () => {

    const proc = new TestLivestreamProcess();

    proc.resolveInit(Buffer.from("init"));
    proc.abort(new HbpuAbortError("replaced"));

    assert.throws(() => proc.resolveInit(Buffer.from("init")), { constructor: HbpuAbortError, name: "replaced" });
    assert.throws(() => proc.feed(Buffer.from("seg")), { constructor: HbpuAbortError, name: "replaced" });
  });

  test("feed before resolveInit throws, because a real process produces no media ahead of its init segment", () => {

    const proc = new TestLivestreamProcess();

    assert.throws(() => proc.feed(Buffer.from("seg")),
      { message: "TestLivestreamProcess: the init segment has not resolved, so a media segment cannot be fed ahead of it." });
  });

  test("a second resolveInit throws, because a real process resolves its init segment once", () => {

    const proc = new TestLivestreamProcess();

    proc.resolveInit(Buffer.from("init"));

    assert.throws(() => proc.resolveInit(Buffer.from("again")),
      { message: "TestLivestreamProcess: the init segment has already resolved, so it cannot resolve again." });
  });
});

describe("TestLivestreamProcessFactory - create-call recording", () => {

  test("create records the options and init and answers a fresh process on every call", () => {

    const factory = new TestLivestreamProcessFactory();
    const init = livestreamInit();

    const first = factory.create(sentinelOptions, init);
    const second = factory.create(sentinelOptions, init);
    const recorded = expectAt(factory.createCalls, 0, "the first create call");

    assert.equal(factory.createCalls.length, 2, "every create call must be recorded");
    assert.equal(recorded.options, sentinelOptions, "the recorded options must be the exact reference passed to create()");
    assert.equal(recorded.init, init, "the recorded init must be the exact reference passed to create()");
    assert.equal(recorded.process, first, "the recorded process must be the one create() answered");
    assert.ok(first instanceof TestLivestreamProcess, "create() must answer a TestLivestreamProcess");
    assert.notEqual(second, first, "every create() must answer a fresh process");
  });

  test("a process the factory built ends when the signal passed to create aborts, and a process built over another signal goes on", () => {

    const factory = new TestLivestreamProcessFactory();
    const ended = new AbortController();
    const reason = new HbpuAbortError("replaced");

    factory.create(sentinelOptions, livestreamInit(ended.signal));
    factory.create(sentinelOptions, livestreamInit(new AbortController().signal));

    ended.abort(reason);

    assert.equal(expectAt(factory.createCalls, 0, "the process built over the aborted signal").process.signal.reason, reason,
      "the consumer's signal must end the process the factory built with that signal's reason");
    assert.equal(expectAt(factory.createCalls, 1, "the process built over a live signal").process.signal.aborted, false,
      "a process built over another signal must not end with it");
  });
});
