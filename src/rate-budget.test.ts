/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rate-budget.test.ts: Unit tests for the sliding-window rate budget - constructor validation, capacity-then-pace admission with no signals anywhere, the exact window
 * boundary, first-in-first-out service on distinct virtual ticks, capacity conservation under contention, and the per-call/lifetime cancellation surface (pre-turn and
 * mid-wait aborts consuming no slot, pre-aborted rejections, and lifetime precedence). Every scenario is driven by a TestClock, so nothing waits on real time.
 */
import { describe, test } from "node:test";
import type { Clock } from "./clock.ts";
import { RateBudget } from "./rate-budget.ts";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";

// Yield to the macrotask queue, which drains the entire microtask cascade first. A budget's queue is built from promise continuations - the turn chain, each turn's own
// awaits, and the continuations a `TestClock.advance` releases - so one macrotask boundary is enough to bring the whole cascade to rest, however deep it ran.
async function settle(): Promise<void> {

  await tick();
}

// Walk virtual time forward in `steps` increments of `ms`, letting the queue come to rest between each. Successive waiters register their own delays only after their
// predecessors wake, so a single large advance would move past deadlines that had not been registered yet; stepping releases one waiter's window at a time.
async function advanceAndSettle(clock: TestClock, ms: number, steps: number): Promise<void> {

  for(let step = 0; step < steps; step++) {

    clock.advance(ms);

    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
}

describe("RateBudget - construction and introspection", () => {

  test("reports the configured capacity, and a fresh budget has every slot available", () => {

    const budget = new RateBudget({ capacity: 4, clock: new TestClock(), window: 1000 });

    assert.equal(budget.capacity, 4);
    assert.equal(budget.available, 4);
  });

  test("throws a TypeError when capacity is not a positive integer", () => {

    assert.throws(() => new RateBudget({ capacity: 0, window: 1000 }), TypeError);
    assert.throws(() => new RateBudget({ capacity: -1, window: 1000 }), TypeError);
    assert.throws(() => new RateBudget({ capacity: 1.5, window: 1000 }), TypeError);
    assert.throws(() => new RateBudget({ capacity: Number.NaN, window: 1000 }), TypeError);
  });

  test("throws a TypeError when window is not a positive, finite number", () => {

    assert.throws(() => new RateBudget({ capacity: 1, window: 0 }), TypeError);
    assert.throws(() => new RateBudget({ capacity: 1, window: -5 }), TypeError);
    assert.throws(() => new RateBudget({ capacity: 1, window: Number.POSITIVE_INFINITY }), TypeError);
    assert.throws(() => new RateBudget({ capacity: 1, window: Number.NaN }), TypeError);
  });

  test("defaults to the system clock when none is injected", async () => {

    const budget = new RateBudget({ capacity: 1, window: 1000 });

    await budget.acquire();

    assert.equal(budget.available, 0, "the grant is recorded against real time when no clock is supplied");
  });
});

describe("RateBudget - admission and pacing", () => {

  test("grants up to capacity immediately, then paces the next caller to the oldest grant's exit, with no signals anywhere", async () => {

    // This is the no-signal configuration in full: no lifetime signal on the budget and no per-call signal on any acquire. Composing signals unconditionally would
    // throw here, so a budget that paces correctly in this shape is the proof that the composition is conditional.
    const clock = new TestClock();
    const budget = new RateBudget({ capacity: 2, clock, window: 1000 });

    await budget.acquire();
    await budget.acquire();

    assert.equal(budget.available, 0, "both slots are spent");

    let granted = false;

    const third = budget.acquire().then(() => {

      granted = true;
    });

    await settle();

    assert.equal(granted, false, "the third caller must wait rather than exceed the ceiling");
    assert.equal(clock.pending, 1, "the waiting caller registered exactly one delay");

    // One millisecond short of the window: the oldest grant still holds its slot, so nothing may be admitted yet.
    clock.advance(999);
    await settle();

    assert.equal(granted, false, "a grant does not leave the window early");

    clock.advance(1);
    await third;

    assert.equal(granted, true, "the caller is admitted once the oldest grant leaves the window");
    assert.equal(clock.now(), 1000, "the wait ran exactly until the oldest grant's window expired, not a fixed interval");
  });

  test("admits at the exact instant the oldest grant leaves the window, without a second wait", async () => {

    const clock = new TestClock();
    const budget = new RateBudget({ capacity: 1, clock, window: 500 });

    await budget.acquire();

    const second = budget.acquire();

    await settle();

    assert.equal(clock.pending, 1, "the second caller is waiting on the window");

    // Land virtual time exactly on `oldest + window`. A grant recorded at T leaves the window when `now >= T + window`, so this instant admits: an implementation
    // that pruned on a strict `<` would re-derive no room here and register a second delay.
    clock.advance(500);
    await second;

    assert.equal(clock.pending, 0, "admission at the boundary instant registers no further delay");
    assert.equal(budget.available, 0, "the boundary grant took the freed slot");
  });

  test("grants age out of the window, restoring available to capacity", async () => {

    const clock = new TestClock();
    const budget = new RateBudget({ capacity: 3, clock, window: 1000 });

    await budget.acquire();
    await budget.acquire();

    assert.equal(budget.available, 1);

    clock.advance(999);

    assert.equal(budget.available, 1, "a grant one millisecond short of the window still holds its slot");

    clock.advance(1);

    assert.equal(budget.available, 3, "every grant leaves the window exactly `window` milliseconds after it was recorded");
  });

  test("serves waiters first-in-first-out when each is issued on a distinct virtual tick", async () => {

    const clock = new TestClock();
    const budget = new RateBudget({ capacity: 1, clock, window: 1000 });
    const order: string[] = [];

    // Each caller arrives on its own virtual tick, so the clock's equal-deadline tie-breaking cannot be what produces the order below... only the queue can.
    const first = budget.acquire().then(() => order.push("first"));

    await settle();
    clock.advance(1);

    const second = budget.acquire().then(() => order.push("second"));

    await settle();
    clock.advance(1);

    const third = budget.acquire().then(() => order.push("third"));

    await settle();
    clock.advance(1);

    const fourth = budget.acquire().then(() => order.push("fourth"));

    await settle();
    await advanceAndSettle(clock, 1000, 4);
    await Promise.all([ first, second, third, fourth ]);

    assert.deepEqual(order, [ "first", "second", "third", "fourth" ], "waiters are served in arrival order");
  });

  test("never admits more than capacity grants inside any trailing window under contention", async () => {

    const clock = new TestClock();
    const capacity = 3;
    const budget = new RateBudget({ capacity, clock, window: 1000 });
    const waiters = Array.from({ length: 10 }, () => budget.acquire());
    const live: number[] = [];

    // Sample the live grant count at every virtual instant this scenario passes through. A double-admission race - two turns both reading room and both recording -
    // pushes the live count above the ceiling here even when the resolution ORDER stays perfectly correct, which is precisely what an order-only assertion misses.
    const sample = (): void => {

      live.push(capacity - budget.available);
    };

    await settle();
    sample();

    for(let step = 0; step < 5; step++) {

      clock.advance(1000);

      // eslint-disable-next-line no-await-in-loop
      await settle();
      sample();
    }

    await Promise.all(waiters);

    assert.ok(live.every((count) => count <= capacity), "the live grant count never exceeds capacity: " + JSON.stringify(live));
    assert.ok(live.includes(capacity), "the scenario actually saturated the budget: " + JSON.stringify(live));
  });
});

describe("RateBudget - cancellation", () => {

  test("a pre-aborted lifetime signal makes the budget born-rejecting", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const reason = new Error("aborted before construction");

    controller.abort(reason);

    const budget = new RateBudget({ capacity: 5, clock, signal: controller.signal, window: 1000 });

    await assert.rejects(() => budget.acquire(), (error: unknown) => error === reason);
    assert.equal(budget.available, 5, "a born-rejecting budget issues no grants");
  });

  test("a lifetime abort rejects every pending and every subsequent acquire with its reason", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const reason = new Error("the budget's owner shut down");
    const budget = new RateBudget({ capacity: 1, clock, signal: controller.signal, window: 1000 });

    await budget.acquire();

    const firstPending = budget.acquire();
    const secondPending = budget.acquire();

    await settle();

    controller.abort(reason);

    await assert.rejects(() => firstPending, (error: unknown) => error === reason);
    await assert.rejects(() => secondPending, (error: unknown) => error === reason);
    await assert.rejects(() => budget.acquire(), (error: unknown) => error === reason);
  });

  test("a per-call abort mid-wait rejects that caller alone, consumes no slot, and lets its successor acquire", async () => {

    const clock = new TestClock();
    const budget = new RateBudget({ capacity: 1, clock, window: 1000 });
    const controller = new AbortController();
    const reason = new Error("the caller gave up");

    await budget.acquire();

    const abandoned = budget.acquire({ signal: controller.signal });
    const successor = budget.acquire();

    await settle();

    assert.equal(clock.pending, 1, "the aborting caller is mid-wait on the window");

    controller.abort(reason);

    // The rejection is the caller's own reason, never the platform AbortError the clock's delay rejects with.
    await assert.rejects(() => abandoned, (error: unknown) => error === reason);
    await settle();

    // Only the original grant is live. A turn that recorded a grant for its aborted waiter would put the live count at two, which shows up here as a negative
    // `available` rather than zero.
    assert.equal(budget.available, 0, "the abandoned wait consumed no slot");

    clock.advance(1000);
    await successor;

    assert.equal(budget.available, 0, "the successor was not stalled or poisoned by its predecessor's rejection, and holds the freed slot");
  });

  test("a caller queued behind a waiting predecessor aborts promptly, and its skipped turn consumes no slot", async () => {

    const clock = new TestClock();
    const budget = new RateBudget({ capacity: 1, clock, window: 1000 });
    const controller = new AbortController();
    const reason = new Error("gave up before its turn began");

    await budget.acquire();

    const predecessor = budget.acquire();
    const queued = budget.acquire({ signal: controller.signal });
    const successor = budget.acquire();

    await settle();

    assert.equal(clock.pending, 1, "only the predecessor's turn is waiting on the window; the queued caller has not started one");

    controller.abort(reason);

    // The rejection arrives while virtual time is still at zero, even though the predecessor's wait does not end until 1000. A caller that only learned of its own
    // abort once its turn finally started would still be pending here.
    await assert.rejects(() => queued, (error: unknown) => error === reason);
    assert.equal(clock.now(), 0, "the abort was observed before any virtual time passed");

    clock.advance(1000);
    await predecessor;
    await settle();

    assert.equal(budget.available, 0, "the skipped turn recorded nothing, so only the predecessor's grant is live");

    clock.advance(1000);
    await successor;

    assert.equal(budget.available, 0, "the waiter behind the skipped turn still acquires");
  });

  test("a pre-aborted per-call signal rejects immediately against a busy queue", async () => {

    const clock = new TestClock();
    const budget = new RateBudget({ capacity: 1, clock, window: 1000 });
    const controller = new AbortController();
    const reason = new Error("already cancelled");

    controller.abort(reason);

    await budget.acquire();

    const waiting = budget.acquire();

    await settle();

    // The entry check runs before the caller takes a place in line, so the rejection does not wait out the queue ahead of it and registers no delay of its own.
    await assert.rejects(() => budget.acquire({ signal: controller.signal }), (error: unknown) => error === reason);
    assert.equal(clock.now(), 0, "the rejection did not wait on the busy queue");
    assert.equal(clock.pending, 1, "the rejected caller registered no wait of its own");

    clock.advance(1000);
    await waiting;
  });

  test("when both the lifetime and the per-call signal have aborted, the rejection carries the lifetime reason", async () => {

    const clock = new TestClock();
    const lifetime = new AbortController();
    const perCall = new AbortController();
    const lifetimeReason = new Error("the budget's owner shut down");
    const perCallReason = new Error("the caller gave up");

    lifetime.abort(lifetimeReason);
    perCall.abort(perCallReason);

    const budget = new RateBudget({ capacity: 1, clock, signal: lifetime.signal, window: 1000 });

    await assert.rejects(() => budget.acquire({ signal: perCall.signal }), (error: unknown) => error === lifetimeReason);
  });

  test("a wait that fails for a reason other than cancellation propagates unchanged", async () => {

    const clock = new TestClock();
    const failure = new Error("the clock broke");

    // A clock whose delay fails outright. The cancellation normalization consults the signals and finds neither aborted, so the underlying failure must reach the
    // caller untouched rather than being reported as a cancellation.
    const failingClock: Clock = {

      delay: (): Promise<void> => Promise.reject(failure),
      now: (): number => clock.now()
    };
    const budget = new RateBudget({ capacity: 1, clock: failingClock, window: 1000 });

    await budget.acquire();

    await assert.rejects(() => budget.acquire(), (error: unknown) => error === failure);
  });
});
