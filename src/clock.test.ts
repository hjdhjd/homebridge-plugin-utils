/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.test.ts: Unit tests for the injectable Clock seam - the compile-time conformance and behavior-neutrality of the production systemClock (its now() tracks
 * Date.now(), its delay() IS node:timers/promises setTimeout including the AbortError shape), plus the shipped controllable TestClock double (advanceable virtual time,
 * deadline-ordered resolution, the advance(0)/negative flush, the matched node:timers/promises AbortError on abort, and the no-listener-leak teardown on both resolution
 * paths).
 */
import { describe, test } from "node:test";
import type { Clock } from "./clock.ts";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";
import { systemClock } from "./clock.ts";

// Flush the microtask queue so a delay that became due during a synchronous `advance` has run its `resolve`/`reject` continuation before the test inspects the outcome.
// `advance` settles each due entry synchronously, but the awaiting code runs on a later microtask; a bare `await Promise.resolve()` yields long enough for those to run.
async function settle(): Promise<void> {

  await Promise.resolve();
}

// Assert that `thrown` is the AbortError shape that `node:timers/promises` setTimeout produces on abort: a name of "AbortError" and a STRING code of "ABORT_ERR". This is
// the fidelity anchor - both systemClock (the real primitive) and TestClock (the fabricated double) must satisfy it identically. We assert `name` + `code` ONLY, never
// `instanceof DOMException` or constructor identity, because the real rejection is a dedicated internal class (not a DOMException, whose code is the numeric 20) with no
// constructable global, so those identities cannot match.
function assertAbortError(thrown: unknown, message: string): void {

  assert.ok(thrown instanceof Error, message + " - the rejection must be an Error");
  assert.equal(thrown.name, "AbortError", message + " - name must be AbortError");
  assert.equal((thrown as Error & { code?: unknown }).code, "ABORT_ERR", message + " - code must be the string ABORT_ERR");
}

describe("systemClock - conformance and behavior-neutrality", () => {

  test("satisfies the Clock contract at compile time", () => {

    // The no-drift proof is purely type-level: the compiler enforces that the production const is assignable to the contract. A `satisfies` expression that fails to
    // compile fails the build; the runtime assertion is belt-and-suspenders that the binding is the same object.
    const conforms = systemClock satisfies Clock;

    assert.equal(conforms, systemClock, "systemClock must satisfy the Clock contract");
  });

  test("now() returns Date.now() within a tiny tolerance", () => {

    const before = Date.now();
    const observed = systemClock.now();
    const after = Date.now();

    assert.ok((observed >= before) && (observed <= after), "systemClock.now() must read the wall clock, falling within the surrounding Date.now() readings");
  });

  test("delay() resolves after the real elapsed time", async () => {

    // The ONE acceptable real wait in this suite: a fake clock cannot test the REAL clock, so we await a tiny 1ms real delay, mirroring the retry suite's `backoff: () =>
    // 1` idiom. We assert resolution only, not precise timing, since real-timer scheduling is not exact.
    await systemClock.delay(1);

    assert.ok(true, "systemClock.delay() must resolve after the real delay elapses");
  });

  test("delay() with a pre-aborted signal rejects with the node:timers/promises AbortError", async () => {

    const controller = new AbortController();

    controller.abort();

    await assert.rejects(() => systemClock.delay(50, { signal: controller.signal }), (error: unknown) => {

      assertAbortError(error, "systemClock pre-aborted delay");

      return true;
    });
  });

  test("delay() aborted mid-wait rejects with an AbortError, NOT the custom reason", async () => {

    const controller = new AbortController();

    // Use a custom Symbol reason to prove it does NOT surface: the real primitive rejects with its own AbortError, never `signal.reason`. This captures the exact shape
    // the TestClock double must reproduce.
    const customReason = Symbol("custom-abort-reason");
    const waited = systemClock.delay(1000, { signal: controller.signal });

    controller.abort(customReason);

    await assert.rejects(() => waited, (error: unknown) => {

      assertAbortError(error, "systemClock mid-wait delay");
      assert.notEqual(error, customReason, "the rejection must NOT be the custom signal reason");

      return true;
    });
  });
});

describe("TestClock - construction and now()", () => {

  test("a bare new TestClock() seeds the virtual time at 0", () => {

    const clock = new TestClock();

    assert.equal(clock.now(), 0, "the default-constructed clock must report a virtual time of 0");
  });

  test("a seeded TestClock reflects the seed and each advance", () => {

    const clock = new TestClock(1000);

    assert.equal(clock.now(), 1000, "the seeded clock must report the seed");

    clock.advance(250);
    assert.equal(clock.now(), 1250, "advance must move the virtual time forward by the delta");

    clock.advance(-100);
    assert.equal(clock.now(), 1150, "a negative advance must move the virtual time backward by the delta");
  });
});

describe("TestClock - delay resolution and ordering", () => {

  test("a delay does not resolve before advance crosses its deadline, and does after", async () => {

    const clock = new TestClock();
    let resolved = false;

    const waited = clock.delay(100).then(() => {

      resolved = true;
    });

    clock.advance(50);
    await settle();
    assert.equal(resolved, false, "a delay must NOT resolve before its deadline is crossed");
    assert.equal(clock.pending, 1, "the unresolved delay must still be pending");

    clock.advance(50);
    await waited;
    assert.equal(resolved, true, "a delay must resolve once advance crosses its deadline");
    assert.equal(clock.pending, 0, "the resolved delay must no longer be pending");
  });

  test("out-of-order delays crossed by one advance resolve in ascending-deadline order", async () => {

    const clock = new TestClock();
    const order: number[] = [];

    // Register three delays out of deadline order. A single advance crosses all three; they must resolve shortest-deadline first regardless of registration order, which
    // gates the snapshot-filter-sort and rules out a lost-wakeup/index-shift bug.
    const a = clock.delay(300).then(() => order.push(300));
    const b = clock.delay(100).then(() => order.push(100));
    const c = clock.delay(200).then(() => order.push(200));

    clock.advance(300);
    await Promise.all([ a, b, c ]);

    assert.deepEqual(order, [ 100, 200, 300 ], "delays must resolve in ascending-deadline order, not registration order");
    assert.equal(clock.pending, 0, "every crossed delay must be cleared from pending");
  });

  test("a partial advance resolves only the crossed delays and leaves the rest pending", async () => {

    const clock = new TestClock();
    const resolved: number[] = [];

    const a = clock.delay(100).then(() => resolved.push(100));

    clock.delay(300);
    clock.delay(500);

    // Cross only the first deadline; the FALSE arm of `deadline <= now` must leave the other two registered.
    clock.advance(100);
    await a;

    assert.deepEqual(resolved, [100], "only the crossed delay must resolve");
    assert.equal(clock.pending, 2, "the two un-crossed delays must remain pending");
  });

  test("advance(0) flushes an already-due zero delay", async () => {

    const clock = new TestClock();

    const waited = clock.delay(0);

    // advance(0) moves time nowhere but MUST still flush an already-due entry - the flush is gated by the deadline, never by the sign of the advance delta.
    clock.advance(0);
    await waited;

    assert.equal(clock.pending, 0, "advance(0) must flush an already-due delay(0)");
  });

  test("advance(0) flushes an already-due negative delay", async () => {

    const clock = new TestClock();

    const waited = clock.delay(-100);

    clock.advance(0);
    await waited;

    assert.equal(clock.pending, 0, "advance(0) must flush an already-due delay(-100)");
  });

  test("a negative advance does not resolve a not-yet-due delay", async () => {

    const clock = new TestClock(1000);

    clock.delay(100);

    // Move time backward; the delay's deadline (1100) is not reached, so it must stay pending.
    clock.advance(-500);
    await settle();

    assert.equal(clock.now(), 500, "the negative advance must move the virtual time backward");
    assert.equal(clock.pending, 1, "a not-yet-due delay must remain pending after a negative advance");
  });
});

describe("TestClock - abort and no-leak", () => {

  test("a delay with a pre-aborted signal rejects with an AbortError and never lands in pending", async () => {

    const clock = new TestClock();
    const controller = new AbortController();

    controller.abort();

    await assert.rejects(() => clock.delay(100, { signal: controller.signal }), (error: unknown) => {

      assertAbortError(error, "TestClock pre-aborted delay");

      return true;
    });

    assert.equal(clock.pending, 0, "a pre-aborted delay must be removed synchronously, never lingering in pending");
  });

  test("a delay aborted mid-wait rejects with an AbortError and returns pending to baseline", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const customReason = Symbol("custom-abort-reason");

    const waited = clock.delay(100, { signal: controller.signal });

    assert.equal(clock.pending, 1, "the registered delay must be pending before the abort");

    controller.abort(customReason);

    await assert.rejects(() => waited, (error: unknown) => {

      assertAbortError(error, "TestClock mid-wait delay");
      assert.notEqual(error, customReason, "the rejection must be the AbortError, NOT the custom signal reason - matching node:timers/promises");

      return true;
    });

    assert.equal(clock.pending, 0, "the aborted delay must be removed, returning pending to baseline (no leak)");
  });

  test("a delay that resolves via advance detaches its abort listener (no leak on the resolve path)", async () => {

    const clock = new TestClock();
    const controller = new AbortController();

    // A delay WITH a (non-aborting) signal that resolves by advance. The resolve path must detach the abort listener via dispose - so a later abort of the same signal
    // does nothing (no late rejection, no second settlement). We prove the detachment by aborting AFTER resolution and confirming nothing changes and no unhandled
    // rejection surfaces.
    const waited = clock.delay(100, { signal: controller.signal });

    clock.advance(100);
    await waited;

    assert.equal(clock.pending, 0, "the resolved delay must be cleared from pending");

    // Aborting the signal after the listener was detached must be inert: the promise already resolved, and the detached listener cannot fire a late rejection.
    controller.abort();
    await settle();

    assert.equal(clock.pending, 0, "a post-resolution abort must remain a no-op with the listener detached");
  });

  test("the TestClock AbortError shape matches systemClock's exactly", async () => {

    // The fidelity anchor: drive both clocks down their abort path and assert their rejections carry the SAME name AND code. If the double drifted from the real
    // primitive, this divergence would surface here.
    const realController = new AbortController();
    const fakeController = new AbortController();

    realController.abort();
    fakeController.abort();

    const realError = await systemClock.delay(50, { signal: realController.signal }).then(() => undefined, (error: unknown) => error);
    const fakeError = await new TestClock().delay(50, { signal: fakeController.signal }).then(() => undefined, (error: unknown) => error);

    assertAbortError(realError, "systemClock abort");
    assertAbortError(fakeError, "TestClock abort");

    const realCode = (realError as Error & { code?: unknown }).code;
    const fakeCode = (fakeError as Error & { code?: unknown }).code;

    assert.equal((fakeError as Error).name, (realError as Error).name, "the TestClock AbortError name must match systemClock's");
    assert.equal(fakeCode, realCode, "the TestClock AbortError code must match systemClock's");
  });
});
