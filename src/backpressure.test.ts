/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * backpressure.test.ts: Unit tests for the BackpressureWriter - AsyncDisposable lifetime, composed signal teardown, drain-respecting write queue,
 * highWaterMark overflow behavior, and null-provider drop semantics.
 *
 * The paced-write rows run on a TestClock, so every due time is crossed by an explicit advance. Each row that makes the writer late leaves at least one piece still
 * not due after its advance, so a writer that flushes everything the moment it is late cannot pass one. A stream in these rows is ended or destroyed, never made to
 * emit a bare error, because the writer listens to a stream only while it waits for a drain.
 */
import { BackpressureClosedStreamError, BackpressureOverflowError, BackpressureWriter } from "./backpressure.ts";
import { assertNoUnhandledRejections, settle } from "./testing/index.ts";
import { collect, wireOf } from "./backpressure.helpers.ts";
import { describe, test } from "node:test";
import type { Clock } from "./clock.ts";
import { HbpuAbortError } from "./util.ts";
import type { PacedChunk } from "./backpressure.ts";
import { PassThrough } from "node:stream";
import { TestClock } from "./clock-double.ts";
import type { Writable } from "node:stream";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// A PassThrough subclass that reports backpressure on every `write()` call by returning `false` and deferring the `drain` event until `releaseDrain()` is called. The
// simplest deterministic way to exercise BackpressureWriter's drain-wait path without depending on real kernel buffering. Writes still deliver through the readable
// side so tests can assert the bytes arrived in order.
class BlockingPassThrough extends PassThrough {

  #drainPending = false;

  public override write(chunk: unknown, encoding?: BufferEncoding | ((_error: Error | null | undefined) => void),
    callback?: (_error: Error | null | undefined) => void): boolean {

    // Forward to the real implementation so `.read()` on the readable side continues to observe the written bytes in order.
    super.write(chunk, encoding as BufferEncoding, callback);
    this.#drainPending = true;

    // Report backpressure. The caller must wait for `drain` before writing again; the test harness calls `releaseDrain` to fire it at a controlled point.
    return false;
  }

  public releaseDrain(): void {

    if(!this.#drainPending) {

      return;
    }

    this.#drainPending = false;
    this.emit("drain");
  }
}

describe("BackpressureWriter - construction", () => {

  test("is not aborted on construction with a fresh controller", async () => {

    await using writer = new BackpressureWriter(() => null);

    assert.equal(writer.aborted, false);
    assert.equal(writer.signal.aborted, false);
  });

  test("composes a parent signal into this.signal", async () => {

    const parent = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    await using writer = new BackpressureWriter(() => null, { signal: parent.signal });

    assert.equal(writer.aborted, false);

    parent.abort(reason);

    // Listeners on AbortSignal.any fire synchronously, so the composed signal flips in the same tick.
    assert.equal(writer.aborted, true);
    assert.equal(writer.signal.reason, reason);
  });

  test("reports pending depth as 0 when idle", async () => {

    await using writer = new BackpressureWriter(() => null);

    assert.equal(writer.pending, 0);
  });
});

describe("BackpressureWriter - write semantics", () => {

  test("writes the chunk to the underlying stream and resolves", async () => {

    const stream = new PassThrough();

    await using writer = new BackpressureWriter(() => stream);

    const payload = Buffer.from("hello");

    await writer.write(payload);

    assert.deepEqual(collect(stream), payload);
  });

  test("serializes concurrent writes in FIFO order", async () => {

    const stream = new PassThrough();

    await using writer = new BackpressureWriter(() => stream);

    // Issue three writes concurrently; BackpressureWriter's FIFO queue must preserve the order the promises were created in.
    await Promise.all([
      writer.write(Buffer.from("one")),
      writer.write(Buffer.from("two")),
      writer.write(Buffer.from("three"))
    ]);

    assert.deepEqual(collect(stream), Buffer.from("onetwothree"));
  });

  test("waits for drain before resolving when the stream signals backpressure", async () => {

    const stream = new BlockingPassThrough();

    await using writer = new BackpressureWriter(() => stream);

    const pending = writer.write(Buffer.from("first"));

    // Give the drain loop a turn to call `stream.write()` and observe the backpressure signal before we release the drain.
    await delay(5);

    let resolved = false;

    void pending.then(() => {

      resolved = true;
    });

    // The write must not have resolved yet - it is parked on the drain wait.
    await delay(5);
    assert.equal(resolved, false);

    stream.releaseDrain();

    await pending;
    assert.equal(resolved, true);
  });

  test("drops the chunk when the provider returns null", async () => {

    await using writer = new BackpressureWriter(() => null);

    // Null provider means "no live stream right now" - drop semantics; the write promise still resolves so the caller can progress without branching.
    await writer.write(Buffer.from("dropped"));
  });

  test("rejects with BackpressureClosedStreamError when the underlying stream is not writable", async () => {

    const stream = new PassThrough();

    stream.end();

    await using writer = new BackpressureWriter(() => stream);

    // Matching by type rather than by message text keeps the assertion stable across error-message phrasing changes and gives consumers a consistent `instanceof`
    // contract to rely on in their own recovery code.
    await assert.rejects(writer.write(Buffer.from("nope")), BackpressureClosedStreamError);
  });

  test("rejects with signal.reason when the writer is already aborted", async () => {

    const writer = new BackpressureWriter(() => null);
    const reason = new HbpuAbortError("shutdown");

    writer.abort(reason);

    await assert.rejects(writer.write(Buffer.from("late")), (error: unknown) => error === reason);
  });
});

describe("BackpressureWriter - highWaterMark", () => {

  test("rejects writes that would push the queue past the configured ceiling", async () => {

    // Use a BlockingPassThrough so the first write stays in flight (awaiting drain), letting us observe queue-depth overflow on subsequent writes.
    const stream = new BlockingPassThrough();
    const writer = new BackpressureWriter(() => stream, { highWaterMark: 2 });

    const first = writer.write(Buffer.from("a"));
    const second = writer.write(Buffer.from("b"));

    // Let the drain loop take the first entry into flight. Both entries now sit in the queue (one in-flight at queue[0], one queued at queue[1]), so the next write
    // must overflow the configured ceiling.
    await delay(5);

    await assert.rejects(writer.write(Buffer.from("c")), BackpressureOverflowError);

    // Abort-clean shutdown: the blocked drain wait rejects with `signal.reason`, both pending writes reject through the regular paths, and nothing leaks into the
    // next test. Verifying the reason (not just "rejected with something") keeps the test honest about which abort path actually fired.
    writer.abort();

    await assert.rejects(first, { constructor: HbpuAbortError, name: "shutdown" });
    await assert.rejects(second, { constructor: HbpuAbortError, name: "shutdown" });
  });
});

describe("BackpressureWriter - abort and teardown", () => {

  test("rejects pending queued writes with signal.reason on abort", async () => {

    const stream = new BlockingPassThrough();
    const writer = new BackpressureWriter(() => stream);

    const first = writer.write(Buffer.from("first"));
    const second = writer.write(Buffer.from("second"));

    // Give the drain loop a turn so the first write is in flight (awaiting drain) and the second is queued.
    await delay(5);

    const reason = new HbpuAbortError("replaced");

    writer.abort(reason);

    // Both writes reject with the explicit reason via `#teardown`, which is registered in the constructor before the drain loop's own `events.once` listener
    // and so fires first, synchronously splicing the whole queue - including the still in-flight entry - and rejecting both resolvers directly. The drain
    // loop's later catch-branch reject on the in-flight entry is a harmless no-op second settle, the same tolerance already noted for the stream-error
    // escalation test below.
    await assert.rejects(first, (error: unknown) => error === reason);
    await assert.rejects(second, (error: unknown) => error === reason);
  });

  test("abort defaults to HbpuAbortError(\"shutdown\")", async () => {

    const writer = new BackpressureWriter(() => null);

    writer.abort();

    assert.equal(writer.aborted, true);
    assert.throws(() => writer.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" });
  });

  test("abort is safe to call more than once", async () => {

    const writer = new BackpressureWriter(() => null);
    const first = new HbpuAbortError("shutdown");

    writer.abort(first);
    writer.abort(new HbpuAbortError("failed"));

    // The first abort wins; subsequent calls are no-ops because the signal only aborts once.
    assert.equal(writer.signal.reason, first);
  });

  test("[Symbol.asyncDispose] aborts and awaits drain-loop completion", async () => {

    const stream = new PassThrough();
    const writer = new BackpressureWriter(() => stream);

    await writer.write(Buffer.from("one"));
    await writer[Symbol.asyncDispose]();

    assert.equal(writer.aborted, true);
  });

  test("pre-aborted parent signal rejects the first write immediately", async () => {

    const parent = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    parent.abort(reason);

    const writer = new BackpressureWriter(() => null, { signal: parent.signal });

    await assert.rejects(writer.write(Buffer.from("late")), (error: unknown) => error === reason);
  });

  test("stream errors during drain abort the writer with \"failed\"", async () => {

    // Build a writable that signals backpressure and then emits an error instead of emitting `drain`. The drain wait rejects with the stream's error, which flows
    // into the writer's catch branch and escalates to an `HbpuAbortError("failed")`. The caller-visible rejection for the in-flight write IS the stream's error
    // (matched by reference below), so the test is independent of any message wording.
    const streamError = new Error("stream exploded");
    const stream: Writable = new PassThrough();

    stream.write = (_chunk: unknown, _encoding?: unknown, callback?: (_error: Error | null | undefined) => void): boolean => {

      if(typeof callback === "function") {

        callback(null);
      }

      setImmediate(() => stream.emit("error", streamError));

      return false;
    };

    const writer = new BackpressureWriter(() => stream);

    await assert.rejects(writer.write(Buffer.from("x")), (error: unknown) => error === streamError);

    assert.equal(writer.aborted, true);
    assert.throws(() => writer.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "failed" });
  });

  test("stream-error escalation rejects every queued resolver, not just the in-flight one", async () => {

    // Asserts the rule that when a stream error escalates (drain catch shifts the in-flight entry, then calls `controller.abort()`), `#teardown` rejects all of the
    // remaining queued entries - not just entries past index 0. The drain loop and teardown can both try to reject the same in-flight resolver under overlapping
    // abort paths; promise resolvers are inert after first settlement, so the double-settle is intentional and harmless.
    const streamError = new Error("boom");
    let writeCount = 0;

    const stream: Writable = new PassThrough();

    stream.write = (_chunk: unknown, _encoding?: unknown, callback?: (_error: Error | null | undefined) => void): boolean => {

      writeCount++;

      if(typeof callback === "function") {

        callback(null);
      }

      // Only the first attempted write (the in-flight entry) triggers the error path. Subsequent queued entries never reach stream.write because the writer aborts
      // itself from the catch branch before processing them.
      if(writeCount === 1) {

        setImmediate(() => stream.emit("error", streamError));
      }

      return false;
    };

    const writer = new BackpressureWriter(() => stream);

    // Three concurrent writes: entry A is taken into flight, B and C queue behind it. The stream error escalates to an `HbpuAbortError("failed")` abort.
    const pA = writer.write(Buffer.from("A"));
    const pB = writer.write(Buffer.from("B"));
    const pC = writer.write(Buffer.from("C"));

    // A rejects with the underlying stream error (caller-visible because the drain catch surfaces it directly on the in-flight write).
    await assert.rejects(pA, (error: unknown) => error === streamError);

    // B and C reject with the signal's reason - the `HbpuAbortError("failed")` that escalated from the stream error. The `cause` chain preserves the original error.
    await assert.rejects(pB, (error: unknown) => {

      assert.ok(error instanceof HbpuAbortError, "B must reject with the library's abort error");
      assert.equal(error.name, "failed", "B must carry the failure reason the stream error escalated to");
      assert.equal(error.cause, streamError, "B's abort must carry the stream's own error as its cause");

      return true;
    });
    await assert.rejects(pC, (error: unknown) => {

      assert.ok(error instanceof HbpuAbortError, "C must reject with the library's abort error");
      assert.equal(error.name, "failed", "C must carry the failure reason the stream error escalated to");
      assert.equal(error.cause, streamError, "C's abort must carry the stream's own error as its cause");

      return true;
    });

    // Queue is fully drained; no resolvers are orphaned.
    assert.equal(writer.pending, 0);
    assert.equal(writer.aborted, true);
  });
});

// A PassThrough that reports backpressure only while it is gated, so a row blocks exactly the piece it means to and lets every later write through. `release`
// lifts the gate and fires the `drain` a gated write is waiting for.
class GatedPassThrough extends PassThrough {

  public gated = false;

  #drainPending = false;

  public override write(chunk: unknown, encoding?: BufferEncoding | ((_error: Error | null | undefined) => void),
    callback?: (_error: Error | null | undefined) => void): boolean {

    super.write(chunk, encoding as BufferEncoding, callback);

    if(!this.gated) {

      return true;
    }

    this.#drainPending = true;

    return false;
  }

  public release(): void {

    this.gated = false;

    if(!this.#drainPending) {

      return;
    }

    this.#drainPending = false;
    this.emit("drain");
  }
}

// Build a paced write's pieces from text and durations, so a row reads its schedule and the bytes it expects on the wire from one place.
function paced(spec: readonly (readonly [ string, number ])[]): PacedChunk[] {

  return spec.map(([ text, duration ]) => ({ bytes: Buffer.from(text), duration }));
}

// A clock whose every member throws, so a row proves a path never reads time at all.
function throwingClock(): Clock {

  const fail = (): never => {

    throw new Error("The clock was read.");
  };

  return { delay: fail, monotonic: fail, now: fail, schedule: fail };
}

// A clock that arms each wait as the platform's timers do, truncated to whole milliseconds, on a TestClock whose readings it answers exactly. Its own `requested`
// records each wait as asked, so a hold that read the clock again after a truncated wait shows there as one more wait of under a millisecond, which a TestClock
// alone never shows, since it settles a wait only once its reading has reached the wait's end.
class TruncatingClock implements Clock {

  public readonly requested: number[] = [];

  readonly #clock = new TestClock();

  public advance(ms: number): void {

    this.#clock.advance(ms);
  }

  public async delay(ms: number, init?: { signal?: AbortSignal }): Promise<void> {

    this.requested.push(ms);

    return this.#clock.delay(Math.trunc(ms), init);
  }

  public monotonic(): number {

    return this.#clock.monotonic();
  }

  public now(): number {

    return this.#clock.now();
  }

  public schedule(callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable {

    this.requested.push(ms);

    return this.#clock.schedule(callback, Math.trunc(ms), init);
  }
}

describe("BackpressureWriter - paced write timing", () => {

  test("writes the first piece before any time passes and each later piece at its due time, not before", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 40 ], [ "b", 60 ], [ "c", 25 ] ]));

    // The first piece goes out inside the call, before any time passes.
    assert.equal(wire().toString(), "a");
    assert.equal(writer.pending, 1, "a paced write is one entry while it holds");

    await settle();
    clock.advance(39);
    await settle();
    assert.equal(wire().toString(), "a", "the second piece is not yet due");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "ab");

    clock.advance(59);
    await settle();
    assert.equal(wire().toString(), "ab", "the third piece is not yet due");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abc");

    await written;
    assert.equal(writer.pending, 0);
    assert.deepEqual(clock.requested, [ 40, 60 ], "the hold waits for exactly the time each piece has left, and the last duration is unused");
  });

  test("a leftover wake does not shorten a later hold", async () => {

    const clock = new TestClock();
    const stream = new GatedPassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    // The first piece blocks on its drain, and a write queued behind it wakes a hold that is not waiting, so the wake is remembered.
    stream.gated = true;

    const first = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]));
    const behind = writer.write(Buffer.from("x"));

    await settle();
    stream.release();
    await Promise.all([ first, behind ]);
    assert.equal(wire().toString(), "abx");

    // The remembered wake answers this hold's first wait at once. The hold goes round, finds nothing queued, and waits out the time it has left.
    const second = writer.writePaced(paced([ [ "c", 100 ], [ "d", 0 ] ]));

    await settle();
    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "abxc", "the remembered wake must not end the hold early");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abxcd");

    await second;
  });

  test("lateness does not accumulate: one advance past several due times writes them in order and a piece not yet due waits for its own time", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 100 ], [ "d", 100 ], [ "e", 0 ] ]));

    await settle();
    clock.advance(250);
    await settle();
    assert.equal(wire().toString(), "abc", "the pieces already due go out together, in order");

    clock.advance(49);
    await settle();
    assert.equal(wire().toString(), "abc", "the next piece keeps its own due time rather than one measured from the late writes");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abcd");

    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "abcd");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abcde");

    await written;
  });

  test("a blocked drain, once released, writes the pieces already due and holds one not yet due until its own due time", async () => {

    const clock = new TestClock();
    const stream = new GatedPassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    stream.gated = true;

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 100 ], [ "d", 0 ] ]));

    await settle();
    clock.advance(250);
    await settle();
    assert.equal(wire().toString(), "a", "nothing follows a piece still waiting for its drain");

    stream.release();
    await settle();
    assert.equal(wire().toString(), "abc", "the pieces that fell due during the drain go out at once");

    clock.advance(49);
    await settle();
    assert.equal(wire().toString(), "abc");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abcd");

    await written;
  });

  test("a single piece is written at once and holds nothing", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    await writer.writePaced(paced([[ "a", 100 ]]));

    assert.equal(wire().toString(), "a");
    assert.deepEqual(clock.requested, [], "a lone piece has nothing to hold for");
  });

  test("the wall clock stepping back during a hold leaves every later piece on its monotonic due time", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ]));

    await settle();

    // The test clock carries a pending wait along with a backward step, where a platform timer stays put when the wall clock is set back. The step therefore lands in
    // the same synchronous step as the advance that ends the first hold's wait, while the hold has yet to write its piece and no wait is on the clock.
    clock.advance(100);
    clock.advance(-1000);
    await settle();
    assert.equal(wire().toString(), "ab");

    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "ab", "the third piece is not yet due on the monotonic clock");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abc", "the third piece goes out at its monotonic due time, however far the wall clock stepped back");

    await written;
    assert.deepEqual(clock.requested, [ 100, 100 ], "each hold waits for the time its piece has left on the monotonic clock");
  });
});

describe("BackpressureWriter - paced write catch-up", () => {

  // A newer write of each kind, arriving at each point a paced write can be in, must flush the paced write's remaining pieces at once and in order ahead of the
  // newer bytes. No row advances the clock before its assertion, so a piece written there was written without waiting for its due time.
  for(const newer of [ "write", "writePaced" ] as const) {

    for(const moment of [ "during a hold", "during a piece's drain wait", "before the entry reaches the head" ] as const) {

      test("a newer " + newer + " arriving " + moment + " flushes the rest in order ahead of the newer bytes", async () => {

        const clock = new TestClock();
        const stream = new GatedPassThrough();
        const wire = wireOf(stream);

        await using writer = new BackpressureWriter(() => stream, { clock });

        // Ahead of the paced write sits a plain write held on its drain, or nothing, and the paced write's first piece is blocked on its drain, or is not.
        stream.gated = moment !== "during a hold";

        const ahead = (moment === "before the entry reaches the head") ? writer.write(Buffer.from("x")) : Promise.resolve();
        const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 100 ] ]));

        await settle();

        const after = (newer === "write") ? writer.write(Buffer.from("n")) : writer.writePaced(paced([ [ "n", 100 ], [ "o", 0 ] ]));

        stream.release();
        await settle();

        const expected = ((moment === "before the entry reaches the head") ? "x" : "") + "abcn";

        assert.equal(wire().toString(), expected, "the paced write's remaining pieces go out at once, in order, ahead of the newer bytes");
        assert.equal(clock.monotonic(), 0);

        await Promise.all([ ahead, written ]);

        // A newer paced write holds in its own right once nothing is queued behind it.
        if(newer === "writePaced") {

          clock.advance(99);
          await settle();
          assert.equal(wire().toString(), expected, "the newer paced write's own second piece is not yet due");

          clock.advance(1);
          await settle();
          assert.equal(wire().toString(), expected + "o");
        }

        await after;
      });
    }
  }
});

describe("BackpressureWriter - paced write teardown", () => {

  test("an abort during a hold rejects the write and writes nothing more", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);
      const writer = new BackpressureWriter(() => stream, { clock });
      const reason = new HbpuAbortError("shutdown");
      const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ])), (error: unknown) => error === reason);

      await settle();
      writer.abort(reason);
      await rejected;
      await settle();
      assert.equal(clock.pending, 0, "the hold's wait left the clock when the writer aborted");

      clock.advance(1000);
      await settle();
      assert.equal(wire().toString(), "a");
    });
  });

  test("an abort in the same synchronous step as an advance to a due time writes no further bytes", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);
      const writer = new BackpressureWriter(() => stream, { clock });
      const reason = new HbpuAbortError("shutdown");
      const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ])), (error: unknown) => error === reason);

      await settle();

      // The advance resolves the hold's wait as elapsed before the abort lands, so the hold answers elapsed to a writer that has already been torn down.
      clock.advance(100);
      writer.abort(reason);

      await rejected;
      await settle();
      clock.advance(1000);
      await settle();
      assert.equal(wire().toString(), "a", "no piece follows the settlement of its write");
    });
  });

  test("an abort during a piece's drain wait rejects the write and writes nothing more", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new GatedPassThrough();
      const wire = wireOf(stream);
      const writer = new BackpressureWriter(() => stream, { clock });
      const reason = new HbpuAbortError("shutdown");

      stream.gated = true;

      const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ])), (error: unknown) => error === reason);

      await settle();
      writer.abort(reason);
      await rejected;

      // The drain loop has ended before the drain ever comes, because the piece's drain wait ends with the writer's lifetime.
      await writer[Symbol.asyncDispose]();

      stream.release();
      await settle();
      assert.equal(wire().toString(), "a");
    });
  });

  test("await using exits during a hold without the clock advancing", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);
      let outcome: Promise<unknown> = Promise.resolve();

      {

        await using writer = new BackpressureWriter(() => stream, { clock });

        outcome = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ])).then(() => "resolved", (error: unknown) => error);

        await settle();
      }

      // The scope's exit awaited the drain, so the hold had already ended by the time it returned, though the clock never moved.
      assert.equal(clock.monotonic(), 0);
      assert.equal(clock.pending, 0);
      assert.equal(wire().toString(), "a");

      const error = await outcome;

      assert.ok(error instanceof HbpuAbortError, "the write rejects with the writer's abort reason");
      assert.equal(error.name, "shutdown");
    });
  });
});

describe("BackpressureWriter - paced write and the stream", () => {

  test("the stream ending during a hold rejects the write as closed, writes nothing more and leaves the writer alive", async () => {

    const clock = new TestClock();
    let stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ])), BackpressureClosedStreamError);

    await settle();
    stream.end();
    clock.advance(100);
    await rejected;

    assert.equal(wire().toString(), "a");
    assert.equal(writer.aborted, false);
    assert.equal(writer.pending, 0);

    // The provider's new stream takes the next write.
    stream = new PassThrough();
    await writer.write(Buffer.from("z"));
    assert.equal(collect(stream).toString(), "z");
  });

  test("a drain that arrives once the stream is not writable rejects the write as closed, writes nothing more and leaves the writer alive", async () => {

    const clock = new TestClock();
    let stream = new GatedPassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    stream.gated = true;

    const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ], [ "c", 0 ] ])), BackpressureClosedStreamError);

    await settle();
    stream.end();
    stream.release();
    await rejected;

    assert.equal(wire().toString(), "a");
    assert.equal(writer.aborted, false);

    stream = new GatedPassThrough();
    await writer.write(Buffer.from("z"));
    assert.equal(collect(stream).toString(), "z");
  });

  test("a stream error on a paced piece's drain rejects that write with the stream's error and the write behind it with the writer's \"failed\" reason",
    async () => {

      const clock = new TestClock();
      const stream = new GatedPassThrough();
      const streamError = new Error("stream exploded");
      const writer = new BackpressureWriter(() => stream, { clock });

      stream.gated = true;

      const first = assert.rejects(writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ])), (error: unknown) => error === streamError);
      const second = assert.rejects(writer.write(Buffer.from("x")), (error: unknown) => {

        assert.ok(error instanceof HbpuAbortError, "the write behind must reject with the library's abort error");
        assert.equal(error.name, "failed");
        assert.equal(error.cause, streamError);

        return true;
      });

      await settle();
      stream.destroy(streamError);
      await Promise.all([ first, second ]);

      assert.equal(collect(stream).toString(), "a");
      assert.equal(writer.aborted, true);
    });

  test("a paced write that meets the ended stream rejects as closed, and the new stream the provider answers next receives nothing of it", async () => {

    const clock = new TestClock();
    const ended = new PassThrough();
    const replacement = new PassThrough();
    const wire = wireOf(ended);

    // The provider answers the replacement the moment the first stream has ended, so the drain loop finds a writable stream the next time it consults the provider.
    await using writer = new BackpressureWriter(() => (ended.writable ? ended : replacement), { clock });

    const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ])), BackpressureClosedStreamError);

    await settle();
    ended.end();
    clock.advance(100);
    await rejected;
    await settle();

    assert.equal(wire().toString(), "a");
    assert.equal(collect(replacement).toString(), "", "no piece of the rejected write reaches the new stream");
    assert.equal(writer.pending, 0);
    assert.equal(writer.aborted, false);

    await writer.write(Buffer.from("z"));
    assert.equal(collect(replacement).toString(), "z");
  });
});

describe("BackpressureWriter - paced write admission", () => {

  test("a null provider drops the whole write after one consultation", async () => {

    const clock = new TestClock();
    let consulted = 0;

    await using writer = new BackpressureWriter(() => {

      consulted++;

      return null;
    }, { clock });

    await writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ]));

    assert.equal(consulted, 1, "the provider is consulted once for the whole entry");
    assert.equal(writer.pending, 0);
    assert.deepEqual(clock.requested, []);
  });

  test("overflow counts a paced write once however many pieces it holds", async () => {

    const clock = new TestClock();
    const stream = new GatedPassThrough();
    const writer = new BackpressureWriter(() => stream, { clock, highWaterMark: 2 });
    const reason = new HbpuAbortError("shutdown");

    stream.gated = true;

    const pacedWrite = assert.rejects(writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ], [ "c", 0 ] ])), (error: unknown) => error === reason);

    assert.equal(writer.pending, 1, "a paced write is one entry however many pieces it holds");

    const plain = assert.rejects(writer.write(Buffer.from("x")), (error: unknown) => error === reason);

    assert.equal(writer.pending, 2);
    await assert.rejects(writer.writePaced(paced([[ "y", 0 ]])), BackpressureOverflowError);
    await assert.rejects(writer.write(Buffer.from("z")), BackpressureOverflowError);

    writer.abort(reason);
    await Promise.all([ pacedWrite, plain ]);
  });

  test("refuses an aborted writer before a full queue, and a full queue before an empty list", async () => {

    // A ceiling of zero holds the queue full from the start, so each refusal can be read against the ones after it.
    const reason = new HbpuAbortError("shutdown");
    const aborted = new BackpressureWriter(() => null, { clock: new TestClock(), highWaterMark: 0 });

    aborted.abort(reason);
    await assert.rejects(aborted.writePaced([]), (error: unknown) => error === reason);

    await using full = new BackpressureWriter(() => null, { clock: new TestClock(), highWaterMark: 0 });

    await assert.rejects(full.writePaced([]), BackpressureOverflowError);
  });

  test("an empty list resolves without queuing or waking a hold", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]));

    await settle();
    await writer.writePaced([]);
    await settle();

    // A wake would have sent the hold round for a second wait, and a queued entry would have ended it, so each would show here.
    assert.equal(writer.pending, 1);
    assert.deepEqual(clock.requested, [100]);
    assert.equal(wire().toString(), "a");

    clock.advance(100);
    await written;
    assert.equal(wire().toString(), "ab");
  });
});

describe("BackpressureWriter - paced write start delay", () => {

  test("holds the first piece until its start, and reads the schedule as the first piece goes out", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 40 ], [ "b", 60 ], [ "c", 0 ] ]), { startDelay: 30 });

    assert.equal(wire().toString(), "", "the first piece waits for its start");
    assert.equal(writer.pending, 1);

    await settle();
    clock.advance(29);
    await settle();
    assert.equal(wire().toString(), "", "the first piece is not yet due");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "a");

    clock.advance(39);
    await settle();
    assert.equal(wire().toString(), "a", "the second piece is due its duration after the first went out");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "ab");

    clock.advance(59);
    await settle();
    assert.equal(wire().toString(), "ab", "the third piece is not yet due");

    clock.advance(1);
    await written;
    assert.equal(wire().toString(), "abc");
    assert.deepEqual(clock.requested, [ 30, 40, 60 ]);
  });

  test("counts a start delay from the call, so time spent queued behind another write counts toward it", async () => {

    const clock = new TestClock();
    const stream = new GatedPassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    stream.gated = true;

    const ahead = writer.write(Buffer.from("x"));
    const written = writer.writePaced(paced([ [ "a", 40 ], [ "b", 0 ] ]), { startDelay: 50 });

    await settle();
    clock.advance(30);
    stream.release();
    await ahead;
    await settle();
    assert.equal(wire().toString(), "x", "the first piece is not yet due");

    clock.advance(19);
    await settle();
    assert.equal(wire().toString(), "x");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "xa");

    clock.advance(39);
    await settle();
    assert.equal(wire().toString(), "xa");

    clock.advance(1);
    await written;
    assert.equal(wire().toString(), "xab");
    assert.deepEqual(clock.requested, [ 20, 40 ], "the first piece waits for what is left of its delay");
  });

  // Each kind of write queued behind a first piece's hold leaves that hold standing until its start. The write lands directly behind the head, so it wakes the
  // hold, which goes round for the time its start has left. The paced kinds hold a second piece of their own, so a row that sent everything at once would show it
  // early.
  for(const [ kind, waits ] of [ [ "a plain write", [ 1000, 990 ] ], [ "a paced write stating no delay", [ 1000, 990, 100 ] ],
    [ "a paced write stating a delay", [ 1000, 990, 10, 100 ] ] ] as const) {

    test(kind + " queued behind a first piece's hold leaves the hold standing until its start", async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);

      await using writer = new BackpressureWriter(() => stream, { clock });

      const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]), { startDelay: 1000 });

      await settle();
      clock.advance(10);
      await settle();

      const after = (kind === "a plain write") ? writer.write(Buffer.from("n")) :
        writer.writePaced(paced([ [ "n", 100 ], [ "o", 0 ] ]), (kind === "a paced write stating a delay") ? { startDelay: 1000 } : {});

      await settle();
      clock.advance(989);
      await settle();
      assert.equal(wire().toString(), "", "the first piece is held for its whole start");

      clock.advance(1);
      await settle();

      if(kind === "a paced write stating a delay") {

        // The write behind falls due at its own start, 10 ms after this one's, which is nearer than the second piece's own time, so the second piece waits for it.
        assert.equal(wire().toString(), "a", "the first piece goes out at its start");

        clock.advance(9);
        await settle();
        assert.equal(wire().toString(), "a", "the write behind is not yet due");

        clock.advance(1);
        await settle();
      }

      assert.equal(wire().toString(), "abn", "the held write's pieces went out, then the first bytes of the write behind");

      if(kind !== "a plain write") {

        clock.advance(99);
        await settle();
        assert.equal(wire().toString(), "abn", "the write behind holds its own second piece");

        clock.advance(1);
        await settle();
        assert.equal(wire().toString(), "abno");
      }

      await Promise.all([ written, after ]);
      assert.deepEqual(clock.requested, waits, "the write behind sent the hold round once, for the time its start had left");
    });
  }

  // A later piece behind a paced write stating a delay holds until the nearer of its own time and that write's start, whichever order they fall in.
  for(const [ order, startDelay, waits ] of [ [ "the start of the write behind is nearer", 50, [ 100, 50, 100 ] ],
    [ "the piece's own time is nearer", 150, [ 100, 100, 50, 100 ] ] ] as const) {

    test("behind a paced write stating a delay, a later piece holds until the nearer moment: " + order, async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);

      await using writer = new BackpressureWriter(() => stream, { clock });

      const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ]));
      const behind = writer.writePaced(paced([ [ "x", 100 ], [ "y", 0 ] ]), { startDelay });

      await settle();

      if(startDelay === 50) {

        clock.advance(49);
        await settle();
        assert.equal(wire().toString(), "a", "neither the second piece nor the write behind is due");

        // The write behind falls due first, so every piece the head has left goes out at once, and the write behind starts at its own start.
        clock.advance(1);
        await settle();
      } else {

        clock.advance(99);
        await settle();
        assert.equal(wire().toString(), "a", "the second piece is not yet due");

        clock.advance(1);
        await settle();
        assert.equal(wire().toString(), "ab", "the second piece goes out at its own time, before the write behind is due");

        clock.advance(49);
        await settle();
        assert.equal(wire().toString(), "ab", "the third piece waits for the write behind to fall due");

        clock.advance(1);
        await settle();
      }

      assert.equal(wire().toString(), "abcx");

      clock.advance(99);
      await settle();
      assert.equal(wire().toString(), "abcx", "the write behind holds its own second piece");

      clock.advance(1);
      await Promise.all([ written, behind ]);
      assert.equal(wire().toString(), "abcxy");
      assert.deepEqual(clock.requested, waits);
    });
  }

  test("a third write leaves the paced write stating a delay ahead of it due at its own start, so the pieces held ahead of that one wait for it", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ]));
    const behind = writer.writePaced(paced([ [ "x", 100 ], [ "y", 0 ] ]), { startDelay: 150 });

    await settle();
    clock.advance(30);
    await settle();
    assert.equal(wire().toString(), "a");

    const third = writer.writePaced(paced([ [ "z", 100 ], [ "w", 0 ] ]));

    await settle();
    assert.equal(wire().toString(), "a", "the third write makes nothing ahead of it due");

    clock.advance(70);
    await settle();
    assert.equal(wire().toString(), "ab", "the second piece goes out at its own time, before the write behind is due");

    clock.advance(49);
    await settle();
    assert.equal(wire().toString(), "ab", "the third piece waits for the write behind to fall due");

    // The write behind falls due at its start, so the third piece goes out, and the write behind starts with the third write queued behind it, due at once.
    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abcxyz");

    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "abcxyz", "the third write holds its own second piece");

    clock.advance(1);
    await Promise.all([ written, behind, third ]);
    assert.equal(wire().toString(), "abcxyzw");
    assert.deepEqual(clock.requested, [ 100, 100, 50, 100 ], "the write behind woke the hold as it landed, and the third write, landing deeper, woke nothing");
  });

  test("a write stating a delay holds for its start when a write is already queued behind it as it reaches the head, on a writer that has held nothing yet",
    async () => {

      const clock = new TestClock();
      const stream = new GatedPassThrough();
      const wire = wireOf(stream);

      await using writer = new BackpressureWriter(() => stream, { clock });

      // Every write is queued before any paced write reaches the drain, so no hold exists to remember a wake, and the write behind is already queued as the write
      // stating a delay reaches the head.
      stream.gated = true;

      const ahead = writer.write(Buffer.from("x"));
      const delayed = writer.writePaced(paced([ [ "n", 100 ], [ "o", 0 ] ]), { startDelay: 100 });
      const third = writer.writePaced(paced([ [ "z", 100 ], [ "w", 0 ] ]));

      await settle();
      stream.release();
      await settle();
      assert.equal(wire().toString(), "x", "the first piece waits for its start with a write queued behind it");

      clock.advance(99);
      await settle();
      assert.equal(wire().toString(), "x", "the first piece is not yet due");

      // At its start the first piece goes out, and the write behind, due at once, takes the second piece with it.
      clock.advance(1);
      await settle();
      assert.equal(wire().toString(), "xnoz");

      clock.advance(99);
      await settle();
      assert.equal(wire().toString(), "xnoz", "the last write holds its own second piece");

      clock.advance(1);
      await Promise.all([ ahead, delayed, third ]);
      assert.equal(wire().toString(), "xnozw");
      assert.deepEqual(clock.requested, [ 100, 100 ]);
    });

  test("three writes a fragment apart, each stating a start more than a fragment after its call, send each first piece at its start and each later piece at its own time",
    async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);

      await using writer = new BackpressureWriter(() => stream, { clock });

      // Each write is two 50 ms pieces, issued 100 ms after the one before it with a start 150 ms after its call, so each start falls after the next write is
      // queued behind it.
      const writes = [writer.writePaced(paced([ [ "a", 50 ], [ "b", 50 ] ]), { startDelay: 150 })];

      await settle();
      clock.advance(100);
      writes.push(writer.writePaced(paced([ [ "c", 50 ], [ "d", 50 ] ]), { startDelay: 150 }));

      // Each piece goes out at its own moment and not a millisecond before, the third write being issued as the first write's second piece falls due.
      for(const [ at, sent ] of [ [ 150, "a" ], [ 200, "ab" ], [ 250, "abc" ], [ 300, "abcd" ], [ 350, "abcde" ], [ 400, "abcdef" ] ] as const) {

        // eslint-disable-next-line no-await-in-loop
        await settle();
        clock.advance(at - 1 - clock.monotonic());
        // eslint-disable-next-line no-await-in-loop
        await settle();
        assert.equal(wire().toString(), sent.slice(0, -1), "nothing more is due a millisecond before " + at.toString() + " ms");

        clock.advance(1);
        // eslint-disable-next-line no-await-in-loop
        await settle();
        assert.equal(wire().toString(), sent, "the piece due at " + at.toString() + " ms goes out then");

        if(at === 200) {

          writes.push(writer.writePaced(paced([ [ "e", 50 ], [ "f", 50 ] ]), { startDelay: 150 }));
        }
      }

      await Promise.all(writes);
    });

  test("a first piece whose start falls after the start of the write behind it still waits for that start, and the pieces it has left then go out at once",
    async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);

      await using writer = new BackpressureWriter(() => stream, { clock });

      // The head's start is 100 ms out, and the write behind, issued 10 ms in, states a start 30 ms in, so the write behind falls due 70 ms before the head may start.
      const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ]), { startDelay: 100 });

      await settle();
      clock.advance(10);

      const behind = writer.writePaced(paced([ [ "x", 100 ], [ "y", 0 ] ]), { startDelay: 20 });

      await settle();
      clock.advance(20);
      await settle();
      assert.equal(wire().toString(), "", "the write behind falling due ends no wait for a start");

      clock.advance(69);
      await settle();
      assert.equal(wire().toString(), "", "the first piece is not yet due");

      // At its start the first piece goes out, and with the write behind already due, every piece the head has left goes with it, ahead of the write behind.
      clock.advance(1);
      await settle();
      assert.equal(wire().toString(), "abcx");

      clock.advance(99);
      await settle();
      assert.equal(wire().toString(), "abcx", "the write behind holds its own second piece");

      clock.advance(1);
      await Promise.all([ written, behind ]);
      assert.equal(wire().toString(), "abcxy");
      assert.deepEqual(clock.requested, [ 100, 90, 100 ]);
    });

  test("a third write landing while the head holds for its start wakes nothing, so the hold asks the clock for no further wait", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]), { startDelay: 100 });

    await settle();
    clock.advance(10);

    const behind = writer.write(Buffer.from("x"));

    await settle();
    clock.advance(10);

    const third = writer.write(Buffer.from("y"));

    await settle();
    assert.deepEqual(clock.requested, [ 100, 90 ], "the write directly behind the head sent the hold round once, and the third write sent it round no more");

    clock.advance(80);
    await Promise.all([ written, behind, third ]);
    assert.equal(wire().toString(), "abxy");
    assert.deepEqual(clock.requested, [ 100, 90 ]);
  });

  test("a write behind that falls due during a piece's drain wait sends every piece left at once", async () => {

    const clock = new TestClock();
    const stream = new GatedPassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    stream.gated = true;

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 100 ], [ "c", 0 ] ]));
    const behind = writer.writePaced(paced([ [ "x", 100 ], [ "y", 0 ] ]), { startDelay: 50 });

    // The write behind falls due while the first piece waits for its drain, and the second piece is not yet due when the drain comes.
    await settle();
    clock.advance(60);
    stream.release();
    await settle();
    assert.equal(wire().toString(), "abcx");

    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "abcx", "the write behind holds its own second piece");

    clock.advance(1);
    await Promise.all([ written, behind ]);
    assert.equal(wire().toString(), "abcxy");
  });

  test("under a highWaterMark of two, a third write is refused while a paced write stating a delay waits behind the one holding, and ends no hold", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock, highWaterMark: 2 });

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]));
    const behind = writer.writePaced(paced([[ "n", 0 ]]), { startDelay: 150 });

    assert.equal(writer.pending, 2);
    await assert.rejects(writer.write(Buffer.from("z")), BackpressureOverflowError);
    await assert.rejects(writer.writePaced(paced([[ "z", 0 ]])), BackpressureOverflowError);

    await settle();
    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "a", "a refused write ends no hold");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "ab");

    clock.advance(49);
    await settle();
    assert.equal(wire().toString(), "ab", "the write behind is not yet due");

    clock.advance(1);
    await Promise.all([ written, behind ]);
    assert.equal(wire().toString(), "abn");
  });

  for(const startDelay of [ 0, -50 ]) {

    test("a delay of " + startDelay.toString() + " holds nothing and reads no clock", async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);

      await using writer = new BackpressureWriter(() => stream, { clock });

      const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]), { startDelay });

      assert.equal(wire().toString(), "a", "the first piece goes out inside the call");

      await settle();
      assert.deepEqual(clock.requested, [100], "nothing waited for a start");

      clock.advance(100);
      await written;
      assert.equal(wire().toString(), "ab");

      // Queued behind a plain write held on its drain, the paced write does not reach the drain inside the call, so any reading the call takes is its admission's.
      const gated = new GatedPassThrough();
      const reason = new HbpuAbortError("shutdown");
      const unclocked = new BackpressureWriter(() => gated, { clock: throwingClock() });

      gated.gated = true;

      const ahead = assert.rejects(unclocked.write(Buffer.from("x")), (error: unknown) => error === reason);
      const queued = assert.rejects(unclocked.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]), { startDelay }), (error: unknown) => error === reason,
        "the write was admitted without reading the clock");

      unclocked.abort(reason);
      await Promise.all([ ahead, queued ]);
    });
  }

  test("a delay of half a millisecond holds the first piece for its start", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ]), { startDelay: 0.5 });

    await settle();
    assert.equal(wire().toString(), "", "the first piece waits for its start");
    assert.deepEqual(clock.requested, [0.5], "for the delay itself");

    clock.advance(0.5);
    await written;
    assert.equal(wire().toString(), "ab");
  });

  test("an empty list with a delay resolves on a clock that throws", async () => {

    await using writer = new BackpressureWriter(() => new PassThrough(), { clock: throwingClock() });

    await writer.writePaced([], { startDelay: 100 });
    assert.equal(writer.pending, 0);
  });

  test("a null provider drops a write stating a delay at once, without holding for its start", async () => {

    const clock = new TestClock();
    let consulted = 0;
    let resolved = false;

    await using writer = new BackpressureWriter(() => {

      consulted++;

      return null;
    }, { clock });

    const written = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]), { startDelay: 100 }).then(() => {

      resolved = true;
    });

    await settle();
    assert.equal(resolved, true, "the write resolved without the clock moving");
    assert.equal(consulted, 1);
    assert.deepEqual(clock.requested, []);

    await written;
  });
});

describe("BackpressureWriter - paced write start and teardown", () => {

  test("an abort during a first piece's hold rejects the write and writes nothing", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);
      const writer = new BackpressureWriter(() => stream, { clock });
      const reason = new HbpuAbortError("shutdown");
      const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ]), { startDelay: 100 }), (error: unknown) => error === reason);

      await settle();
      writer.abort(reason);
      await rejected;
      await settle();
      assert.equal(clock.pending, 0, "the hold's wait left the clock when the writer aborted");

      clock.advance(1000);
      await settle();
      assert.equal(wire().toString(), "");
    });
  });

  test("an abort in the same synchronous step as the advance to a first piece's start writes nothing", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);
      const writer = new BackpressureWriter(() => stream, { clock });
      const reason = new HbpuAbortError("shutdown");
      const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ]), { startDelay: 100 }), (error: unknown) => error === reason);

      await settle();

      // The advance resolves the hold's wait as elapsed before the abort lands, so the hold answers elapsed to a writer that has already been torn down.
      clock.advance(100);
      writer.abort(reason);

      await rejected;
      await settle();
      assert.equal(wire().toString(), "", "no piece follows the settlement of its write");
    });
  });

  test("await using exits during a first piece's hold without the clock advancing", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);
      let outcome: Promise<unknown> = Promise.resolve();

      {

        await using writer = new BackpressureWriter(() => stream, { clock });

        outcome = writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ]), { startDelay: 100 }).then(() => "resolved", (error: unknown) => error);

        await settle();
      }

      assert.equal(clock.monotonic(), 0);
      assert.equal(clock.pending, 0);
      assert.equal(wire().toString(), "");

      const error = await outcome;

      assert.ok(error instanceof HbpuAbortError, "the write rejects with the writer's abort reason");
      assert.equal(error.name, "shutdown");
    });
  });

  test("the stream ending during a first piece's hold rejects the write as closed, writes nothing and leaves the writer alive", async () => {

    const clock = new TestClock();
    let stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const rejected = assert.rejects(writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ]), { startDelay: 100 }), BackpressureClosedStreamError);

    await settle();
    stream.end();
    clock.advance(100);
    await rejected;

    assert.equal(wire().toString(), "");
    assert.equal(writer.aborted, false);
    assert.equal(writer.pending, 0);

    stream = new PassThrough();
    await writer.write(Buffer.from("z"));
    assert.equal(collect(stream).toString(), "z");
  });

  test("an abort with several writes held behind a first piece's hold rejects each of them and writes nothing", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);
      const writer = new BackpressureWriter(() => stream, { clock });
      const reason = new HbpuAbortError("shutdown");
      const rejections = [ writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ]), { startDelay: 100 }),
        writer.writePaced(paced([ [ "c", 0 ], [ "d", 0 ] ]), { startDelay: 100 }), writer.write(Buffer.from("x")) ]
        .map(async (written) => assert.rejects(written, (error: unknown) => error === reason));

      await settle();
      clock.advance(50);
      await settle();
      writer.abort(reason);
      await Promise.all(rejections);
      await settle();
      assert.equal(clock.pending, 0, "the hold's wait left the clock when the writer aborted");
      assert.equal(writer.pending, 0);

      clock.advance(1000);
      await settle();
      assert.equal(wire().toString(), "");
    });
  });

  test("a stream that ends with several writes held behind a first piece's hold rejects each of them as closed once the head's start has passed", async () => {

    const clock = new TestClock();
    let stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const outcomes: string[] = [];
    const writes = [ writer.writePaced(paced([ [ "a", 0 ], [ "b", 0 ] ]), { startDelay: 100 }), writer.writePaced(paced([ [ "c", 0 ], [ "d", 0 ] ]), { startDelay: 100 }),
      writer.write(Buffer.from("x")) ].map(async (written) => written.then(() => void outcomes.push("resolved"),
      (error: unknown) => void outcomes.push((error instanceof BackpressureClosedStreamError) ? "closed" : "other")));

    await settle();
    stream.end();
    clock.advance(99);
    await settle();
    assert.deepEqual(outcomes, [], "nothing settles before the head's start");

    clock.advance(1);
    await Promise.all(writes);
    assert.deepEqual(outcomes, [ "closed", "closed", "closed" ]);
    assert.equal(wire().toString(), "");
    assert.equal(writer.aborted, false);
    assert.equal(writer.pending, 0);

    // The provider's new stream takes the next write.
    stream = new PassThrough();
    await writer.write(Buffer.from("z"));
    assert.equal(collect(stream).toString(), "z");
  });

  test("a leftover wake does not shorten a first piece's hold", async () => {

    const clock = new TestClock();
    const stream = new GatedPassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    // The first piece blocks on its drain, and a write queued behind it wakes a hold that is not waiting, so the wake is remembered.
    stream.gated = true;

    const first = writer.writePaced(paced([ [ "a", 100 ], [ "b", 0 ] ]));
    const behind = writer.write(Buffer.from("x"));

    await settle();
    stream.release();
    await Promise.all([ first, behind ]);
    assert.equal(wire().toString(), "abx");

    // The remembered wake answers the start's first wait at once. The hold goes round and waits out the time it has left.
    const second = writer.writePaced(paced([ [ "c", 100 ], [ "d", 0 ] ]), { startDelay: 100 });

    await settle();
    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "abx", "the remembered wake must not end the hold early");

    clock.advance(1);
    await settle();
    assert.equal(wire().toString(), "abxc");

    clock.advance(99);
    await settle();
    assert.equal(wire().toString(), "abxc");

    clock.advance(1);
    await second;
    assert.equal(wire().toString(), "abxcd");
    assert.deepEqual(clock.requested, [ 100, 100 ]);
  });
});

describe("BackpressureWriter - paced write on a truncating clock", () => {

  test("an elapsed wait is never read again within a write, for the start or for a piece", async () => {

    const clock = new TruncatingClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 10.5 ], [ "b", 10.5 ], [ "c", 0 ] ]), { startDelay: 5.5 });

    // The start's wait of 5.5 ms is armed as 5, and its elapsing sends the first piece, though the clock reads half a millisecond short of the start.
    await settle();
    clock.advance(5);
    await settle();
    assert.equal(wire().toString(), "a");

    // The second piece is due 10.5 ms after the first went out, armed as 10.
    clock.advance(10);
    await settle();
    assert.equal(wire().toString(), "ab");

    clock.advance(10);
    await settle();
    assert.equal(wire().toString(), "ab", "the third piece is not yet due");

    clock.advance(1);
    await written;
    assert.equal(wire().toString(), "abc");
    assert.deepEqual(clock.requested, [ 5.5, 10.5, 11 ], "no elapsed wait was followed by a second one for the same moment");
  });

  test("a piece's time and the start of the write behind that fall at one reading send every piece left at once", async () => {

    const clock = new TruncatingClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 10.5 ], [ "b", 10.5 ], [ "c", 0 ] ]));
    const behind = writer.writePaced(paced([ [ "n", 5 ], [ "o", 0 ] ]), { startDelay: 10.5 });

    // The second piece and the write behind fall due together 10.5 ms out, so one wait, armed as 10, ends the hold for each, and the third piece goes out with
    // the second.
    await settle();
    clock.advance(10);
    await settle();
    assert.equal(wire().toString(), "abc");

    // The write behind reads the clock afresh at the head and takes one further wait for the half millisecond its start is still away.
    clock.advance(0);
    await settle();
    assert.equal(wire().toString(), "abcn");

    clock.advance(4);
    await settle();
    assert.equal(wire().toString(), "abcn", "the write behind holds its own second piece");

    clock.advance(1);
    await Promise.all([ written, behind ]);
    assert.equal(wire().toString(), "abcno");
    assert.deepEqual(clock.requested, [ 10.5, 10.5, 0.5, 5 ]);
  });

  test("the write behind, reaching the head, takes at most one further wait for its start, of under a millisecond", async () => {

    const clock = new TruncatingClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const written = writer.writePaced(paced([ [ "a", 20 ], [ "b", 20 ], [ "c", 0 ] ]));
    const behind = writer.writePaced(paced([ [ "n", 10 ], [ "o", 0 ] ]), { startDelay: 7.5 });

    // The write behind falls due first, 7.5 ms out, armed as 7, so the head sends every piece it has left, and the write behind finds its start half a millisecond
    // away when it reaches the head.
    await settle();
    clock.advance(7);
    await settle();
    assert.equal(wire().toString(), "abc");

    clock.advance(0);
    await settle();
    assert.equal(wire().toString(), "abcn", "the one further wait ends the start's hold");

    clock.advance(9);
    await settle();
    assert.equal(wire().toString(), "abcn", "the write behind holds its own second piece");

    clock.advance(1);
    await Promise.all([ written, behind ]);
    assert.equal(wire().toString(), "abcno");
    assert.deepEqual(clock.requested, [ 20, 7.5, 0.5, 10 ], "the write behind took one further wait for its start");
  });
});

describe("BackpressureWriter - plain writes and the clock", () => {

  test("plain writes on a writer whose clock throws from every member settle without reading the clock", async () => {

    const clock = throwingClock();
    const stream = new BlockingPassThrough();
    const reason = new HbpuAbortError("shutdown");

    // Concurrent writes, each through a drain wait, in order.
    const writer = new BackpressureWriter(() => stream, { clock });
    const writes = Promise.all([ writer.write(Buffer.from("one")), writer.write(Buffer.from("two")) ]);

    for(let release = 0; release < 2; release++) {

      // eslint-disable-next-line no-await-in-loop
      await settle();
      stream.releaseDrain();
    }

    await writes;
    assert.equal(collect(stream).toString(), "onetwo");

    // A drop, a closed stream and an abort, each answered as on any other writer.
    await using dropping = new BackpressureWriter(() => null, { clock });

    await dropping.write(Buffer.from("dropped"));

    const closed = new PassThrough();

    closed.end();

    await using closing = new BackpressureWriter(() => closed, { clock });

    await assert.rejects(closing.write(Buffer.from("nope")), BackpressureClosedStreamError);

    const held = writer.write(Buffer.from("three"));

    writer.abort(reason);
    await assert.rejects(held, (error: unknown) => error === reason);
  });
});
