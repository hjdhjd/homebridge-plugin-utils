/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * wakeable-wait.test.ts: Unit tests for WakeableWait - a window that elapses on the clock and asks for exactly the window it was given, a wake that ends a wait in
 * flight with its reason and leaves the clock nothing pending, a wake with no wait in progress remembered until a wait consumes it without ever registering a delay,
 * the first wake winning over every later one until that consumption, a wake after a wait has already ended kept for the next wait rather than applied to the one that
 * is over, the lifetime signal winning over a wake that landed in the same tick and rejecting a later wait before it reaches the clock, a second concurrent wait
 * refused with the first left intact, a clock rejection with neither side aborted rethrown as it came, and nothing at all attached to the lifetime signal along the way.
 *
 * The tag is the whole subject of the answer, which is why the rows read the outcome through it rather than through whether a reason happens to be present: an
 * implementation that resolved every wait the same way, or that dropped a wake it had nowhere to deliver, passes a single-wait test and fails most of these. Every row
 * but the last drives a TestClock, so a suite covering a sixty-second pause costs nothing in real time; the last drives the default system clock, so the wake is proven
 * once against the platform's own timers rather than only against virtual ones.
 */
import { assertNoUnhandledRejections, settle } from "./testing/index.ts";
import { describe, test } from "node:test";
import type { Clock } from "./clock.ts";
import { HbpuAbortError } from "./util.ts";
import { TestClock } from "./clock-double.ts";
import { WakeableWait } from "./wakeable-wait.ts";
import type { WakeableWaitOutcome } from "./wakeable-wait.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

/* Read the reason an outcome carries, branching on the tag alone. This is the compile-time half of the contract: the switch has no default arm and the function
 * satisfies its return type only because the cases cover the union exhaustively, so an outcome that grew another shape would fail to compile here, and `reason` is
 * reachable only inside the arm that declares one - reading it on the elapsed arm is not an assertion that fails, it is a program that does not build.
 */
function reasonOf(outcome: WakeableWaitOutcome<string>): string | undefined {

  switch(outcome.kind) {

    case "elapsed": {

      return undefined;
    }

    case "woken": {

      return outcome.reason;
    }
  }
}

describe("WakeableWait - waiting and waking", () => {

  test("a wait nothing wakes elapses when the clock crosses its window, having asked for exactly that window", async () => {

    const clock = new TestClock();
    const pause = new WakeableWait({ clock });
    const waited = pause.wait(60000);

    let settled: WakeableWaitOutcome<string> | undefined;

    void waited.then((outcome) => {

      settled = outcome;
    });

    clock.advance(59999);
    await settle();

    assert.equal(settled, undefined, "a wait one millisecond short of its window has not ended");
    assert.deepEqual(clock.requested, [60000], "the wait asks the clock for the window it was handed, unaltered");

    clock.advance(1);

    assert.deepEqual(await waited, { kind: "elapsed" });
  });

  test("a wake during a wait ends it at once with that reason, leaving the clock nothing pending", async () => {

    const clock = new TestClock();
    const pause = new WakeableWait({ clock });
    const waited = pause.wait(60000);

    // Wake on the next microtask, so the wait is demonstrably in flight rather than merely constructed.
    await Promise.resolve();

    pause.wake("changed");

    const outcome = await waited;

    assert.deepEqual(outcome, { kind: "woken", reason: "changed" });
    assert.equal(reasonOf(outcome), "changed", "the reason is reachable through the tag");
    assert.equal(clock.advanceToNext(), false, "the woken wait leaves no delay entry on the timeline");
    assert.equal(clock.now(), 0, "the wake ends the wait without any of its window passing");
  });

  test("a wait with no lifetime signal elapses and wakes exactly as one with a lifetime does", async () => {

    const clock = new TestClock();
    const pause = new WakeableWait({ clock });
    const elapsed = pause.wait(60000);

    clock.advance(60000);

    assert.deepEqual(await elapsed, { kind: "elapsed" });

    const woken = pause.wait(60000);

    await Promise.resolve();

    pause.wake("changed");

    assert.deepEqual(await woken, { kind: "woken", reason: "changed" });
    assert.deepEqual(clock.requested, [ 60000, 60000 ], "both waits reached the clock, since neither had a wake waiting for it");
  });

  test("on the default system clock a wake ends a long wait immediately and a short wait elapses on its own", async () => {

    const pause = new WakeableWait();
    const startedAt = Date.now();
    const waited = pause.wait(60000);

    setImmediate(() => pause.wake("changed"));

    assert.deepEqual(await waited, { kind: "woken", reason: "changed" });
    assert.ok((Date.now() - startedAt) < 1000, "the wake ends the wait rather than letting its window run out");
    assert.deepEqual(await pause.wait(1), { kind: "elapsed" });
  });
});

describe("WakeableWait - the remembered wake", () => {

  test("a wake with no wait in progress is remembered, and the next wait answers it without asking the clock at all", async () => {

    const clock = new TestClock();
    const pause = new WakeableWait({ clock });

    pause.wake("changed");

    assert.deepEqual(await pause.wait(60000), { kind: "woken", reason: "changed" });
    assert.deepEqual(clock.requested, [], "a wait that consumed a remembered wake registered no delay");
  });

  test("the first wake wins: a second before consumption is a no-op, and a wake after the outcome arms the next wait", async () => {

    const clock = new TestClock();
    const pause = new WakeableWait({ clock });
    const waited = pause.wait(60000);

    await Promise.resolve();

    pause.wake("first");
    pause.wake("second");

    assert.deepEqual(await waited, { kind: "woken", reason: "first" }, "the reason a wait reads is the first one offered, not the last");

    pause.wake("third");

    assert.deepEqual(await pause.wait(60000), { kind: "woken", reason: "third" });
    assert.deepEqual(clock.requested, [60000], "only the wait that had no wake waiting for it ever reached the clock");
  });

  test("a wake after a wait has elapsed is kept for the next wait rather than applied to the one that ended", async () => {

    const clock = new TestClock();
    const pause = new WakeableWait({ clock });
    const waited = pause.wait(60000);

    clock.advance(60000);

    assert.deepEqual(await waited, { kind: "elapsed" }, "the wait that ran its window out ended as elapsed");

    pause.wake("late");

    assert.deepEqual(await pause.wait(60000), { kind: "woken", reason: "late" });
    assert.deepEqual(clock.requested, [60000], "the wait that consumed the late wake registered no delay of its own");
  });
});

describe("WakeableWait - the lifetime", () => {

  test("the lifetime aborting during a wait rejects with its own reason, and a wake in the same tick does not change that", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const controller = new AbortController();
      const pause = new WakeableWait({ clock, signal: controller.signal });
      const reason = new HbpuAbortError("shutdown");
      const waited = pause.wait(60000);

      await Promise.resolve();

      /* Both sides fire in one synchronous run, which is the tick the read order has to survive. The wake aborts the wait's own controller and the clock is already
       * rejecting on it when the lifetime aborts behind it, so the two arrive at the catch as one platform AbortError and only the order the signals are read in
       * decides which answer the caller gets.
       */
      pause.wake("changed");
      controller.abort(reason);

      await assert.rejects(() => waited, (error: unknown) => error === reason);
    });
  });

  test("a lifetime already aborted rejects the wait with its reason without a delay, even with a wake remembered", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const controller = new AbortController();
      const pause = new WakeableWait({ clock, signal: controller.signal });
      const reason = new HbpuAbortError("shutdown");

      controller.abort(reason);
      pause.wake("changed");

      await assert.rejects(() => pause.wait(60000), (error: unknown) => error === reason);
      assert.deepEqual(clock.requested, [], "a wait under a lifetime that is over never reaches the clock");
    });
  });

  test("no abort listener accumulates on the lifetime signal across many waits ended by elapse and by wake", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const pause = new WakeableWait({ clock, signal: controller.signal });

    // Fifty waits, alternating the way they end, against one lifetime signal that outlives them all - the shape a connect loop pausing every minute for weeks takes,
    // compressed. Each composite the wait builds carries the clock's listener, and the lifetime itself must carry none at any point.
    for(let index = 0; index < 50; index++) {

      const waited = pause.wait(60000);

      assert.equal(getEventListeners(controller.signal, "abort").length, 0, "a wait in flight attaches nothing to the lifetime signal");

      if((index % 2) === 0) {

        clock.advance(60000);
      } else {

        pause.wake("changed");
      }

      // eslint-disable-next-line no-await-in-loop
      await waited;
    }

    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "fifty ended waits leave the lifetime signal exactly as they found it");
  });
});

describe("WakeableWait - misuse and a clock that faults", () => {

  test("a second concurrent wait is refused by name and leaves the first wait intact", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const pause = new WakeableWait({ clock });
      const first = pause.wait(60000);

      await assert.rejects(() => pause.wait(1), (error: unknown) => (error instanceof Error) && (error.message === "WakeableWait: a wait is already in progress."));

      clock.advance(60000);

      assert.deepEqual(await first, { kind: "elapsed" }, "the wait already in flight is untouched by the refusal");
      assert.deepEqual(clock.requested, [60000], "the refused wait registered no delay of its own");
    });
  });

  test("a clock rejection with neither side aborted is rethrown exactly as it came", async () => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const fault = new Error("clock fault");

      /* A clock that rejects a delay without ever aborting the signal it was handed. That breaks what the Clock contract promises, which is the point: it is the one
       * shape a wait must rethrow rather than read as a wake, since a wake is exactly what a rejection under an aborted signal would mean. Everything else delegates
       * to the double, so only the delay diverges.
       */
      const faulty: Clock = {

        delay: (): Promise<void> => Promise.reject(fault),
        now: (): number => clock.now(),
        schedule: (callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable => clock.schedule(callback, ms, init),
        timeout: (ms: number): AbortSignal => clock.timeout(ms)
      };

      const pause = new WakeableWait({ clock: faulty });

      await assert.rejects(() => pause.wait(60000), (error: unknown) => error === fault);
    });
  });
});
