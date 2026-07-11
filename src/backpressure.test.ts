/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * backpressure.test.ts: Unit tests for the BackpressureWriter - AsyncDisposable lifetime, composed signal teardown, drain-respecting write queue,
 * highWaterMark overflow behavior, and null-provider drop semantics.
 */
import { BackpressureClosedStreamError, BackpressureOverflowError, BackpressureWriter } from "./backpressure.ts";
import { HbpuAbortError, isHbpuAbortReason } from "./util.ts";
import { describe, test } from "node:test";
import type { Nullable } from "./util.ts";
import { PassThrough } from "node:stream";
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

// Collect all buffers written to a PassThrough into a single Buffer. Used after writes complete to assert wire-order preservation across concurrent enqueues.
function collect(stream: PassThrough): Buffer {

  const chunks: Buffer[] = [];

  for(;;) {

    const chunk: Nullable<Buffer> = stream.read() as Nullable<Buffer>;

    if(chunk === null) {

      break;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
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
    await assert.rejects(writer.write(Buffer.from("nope")), (error: unknown) => error instanceof BackpressureClosedStreamError);
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

    await assert.rejects(writer.write(Buffer.from("c")), (error: unknown) => error instanceof BackpressureOverflowError);

    // Abort-clean shutdown: the blocked drain wait rejects with `signal.reason`, both pending writes reject through the regular paths, and nothing leaks into the
    // next test. Verifying the reason (not just "rejected with something") keeps the test honest about which abort path actually fired.
    writer.abort();

    await assert.rejects(first, (error: unknown) => isHbpuAbortReason(error, "shutdown"));
    await assert.rejects(second, (error: unknown) => isHbpuAbortReason(error, "shutdown"));
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

    // Both writes must reject with the explicit reason - the queued entry via the teardown path, the in-flight entry via the drain-abort path.
    await assert.rejects(first, (error: unknown) => error === reason);
    await assert.rejects(second, (error: unknown) => error === reason);
  });

  test("abort defaults to HbpuAbortError(\"shutdown\")", async () => {

    const writer = new BackpressureWriter(() => null);

    writer.abort();

    assert.equal(writer.aborted, true);
    assert.equal(isHbpuAbortReason(writer.signal.reason, "shutdown"), true);
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
    assert.equal(isHbpuAbortReason(writer.signal.reason, "failed"), true);
  });

  test("stream-error escalation rejects every queued resolver, not just the in-flight one", async () => {

    // Pins the rule that when a stream error escalates (drain catch shifts the in-flight entry, then calls `controller.abort()`), `#teardown` rejects all of the
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
    await assert.rejects(pB, (error: unknown) => isHbpuAbortReason(error, "failed") && (error.cause === streamError));
    await assert.rejects(pC, (error: unknown) => isHbpuAbortReason(error, "failed") && (error.cause === streamError));

    // Queue is fully drained; no resolvers are orphaned.
    assert.equal(writer.pending, 0);
    assert.equal(writer.aborted, true);
  });
});
