/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock-double.ts: A reusable, controllable Clock test double - one virtual timeline a test advances explicitly, carrying awaited delays, callback timers, and
 * deadline signals alike.
 */

/**
 * A reusable, controllable {@link Clock} test double.
 *
 * The {@link Clock} contract in `clock.ts` exists so a consuming plugin's time-dependent code can be driven without real wall-clock waits. This module ships the fake
 * that cashes that in: a {@link TestClock} over one virtual timeline a test advances explicitly. `now()` returns the virtual time; `delay()` registers a pending wait
 * that resolves only when {@link TestClock.advance} crosses its deadline, or rejects when its signal aborts - matching `node:timers/promises` `setTimeout`'s
 * `AbortError` shape; `schedule()` registers a callback timer that runs inside `advance` when its deadline is crossed, once or on repeat; `timeout()` returns a
 * signal that aborts when `advance` crosses its deadline, with the same `TimeoutError` the platform's `AbortSignal.timeout` aborts with. No real timers and no
 * wall-clock are used, so a consumer's pacing, timeout, and heartbeat paths all run deterministically and instantly under test.
 *
 * Every shape shares ONE timeline, which is the point: a scenario spanning a backoff wait, a liveness deadline, and a bounded call's deadline signal is driven by a
 * single `advance` rather than by a clock for the waits and a mock-timer harness for the deadlines, and they interleave exactly as the platform would order them.
 *
 * Beside the timeline the double keeps the ledger a pacing assertion reads: `requested` is every `ms` a consumer asked for, in call order, and `advanceToNext()`
 * steps straight to the earliest pending deadline - so a suite drives a consumer's schedule by the numbers the consumer chose rather than by numbers it restates.
 *
 * The double builds on the library's own primitives rather than hand-rolling them: {@link onAbort} wires the abort listener and yields the `Disposable` that detaches
 * it, and `Promise.withResolvers` captures each pending wait's deferred. The abort listener is detached on EITHER resolution path (deadline-crossed or aborted), so no
 * listener leaks onto a long-lived signal across many short waits.
 *
 * @module
 */
import type { Clock } from "./clock.ts";
import type { Nullable } from "./util.ts";
import { onAbort } from "./util.ts";

/**
 * A single registered, not-yet-settled timeline entry, tagged by `kind` so {@link TestClock.advance} branches on the tag rather than on whichever optional fields
 * happen to be present. Every arm carries `deadline`, the virtual time at or after which the entry comes due, because one ordered list holds them all.
 *
 * A `"delay"` entry settles an awaited wait: `resolve` settles the caller's promise, and `dispose` detaches the abort listener (present only when a signal was
 * supplied, absent otherwise). The matching `reject` is held by the abort handler's closure rather than stored here, since only the abort path needs it. A `"once"`
 * entry runs its `callback` and leaves the list. A `"repeat"` entry runs its `callback` and re-arms itself `interval` milliseconds past its own deadline, staying in
 * the list until its handle is disposed.
 */
type ClockEntry = { deadline: number; dispose?: Disposable; kind: "delay"; resolve: () => void } |
  { callback: () => void; deadline: number; kind: "once" } |
  { callback: () => void; deadline: number; interval: number; kind: "repeat" };

/**
 * Construct the rejection a {@link TestClock} `delay` produces when its signal aborts, matching `node:timers/promises` `setTimeout` exactly: a plain `Error` whose `name`
 * is `"AbortError"` and whose `code` is the STRING `"ABORT_ERR"`. The real primitive's rejection is a dedicated internal class (not a `DOMException`, whose `code` is the
 * numeric `20`, and there is no constructable `AbortError` global), so the double cannot match the constructor or prototype identity - it matches the observable `name`
 * and `code` a consumer branches on, which is the contract that matters.
 *
 * @returns The `AbortError`-shaped rejection.
 */
function abortError(): Error {

  const error = new Error("The operation was aborted");

  error.name = "AbortError";

  // `code` is not a standard `Error` field, so assign it through an indexed widening rather than declaring a one-off subclass. The STRING value is what the real
  // `node:timers/promises` rejection carries and what a consumer's `error.code === "ABORT_ERR"` check reads.
  (error as Error & { code: string }).code = "ABORT_ERR";

  return error;
}

/**
 * A controllable {@link Clock} double over virtual time, carrying awaited delays and callback timers on one timeline. `now()` returns the current virtual time;
 * `delay()` registers a pending wait that resolves only when {@link TestClock.advance} crosses its deadline (in ascending-deadline order), or rejects with an
 * `AbortError` (matching `node:timers/promises` `setTimeout` - `name` `"AbortError"`, `code` `"ABORT_ERR"`, NOT the signal's reason) when its signal aborts;
 * `schedule()` registers a callback timer that `advance` runs when it crosses that deadline, once or on repeat. No real timers or wall-clock are used.
 *
 * A callback and an awaited delay settle at different moments, which a test that observes both has to account for: a callback runs SYNCHRONOUSLY inside `advance`,
 * while an awaited delay's continuation runs on a later microtask, so a callback firing at the same deadline as a delay observes the state `advance` has reached
 * rather than the state the awaiting code will later see.
 *
 * The virtual time is a RELATIVE timeline seeded at `start` (default `0`), NOT real epoch milliseconds. A consumer that compares `now()` against an absolute real-epoch
 * constant would diverge; consumers must only compare `now()` values to each other (deriving elapsed intervals from differences), which is the only use a
 * `Date.now()`-style read serves in the consuming pacing path - all its time reads come from the one injected clock.
 *
 * @example
 *
 * ```ts
 * import { TestClock } from "homebridge-plugin-utils/testing";
 *
 * const clock = new TestClock();
 *
 * const waited = clock.delay(100);
 * using heartbeat = clock.schedule(() => beat(), 25, { repeat: true });
 *
 * // Nothing resolves and nothing fires until virtual time crosses each deadline.
 * clock.advance(100);
 *
 * await waited;
 * ```
 *
 * @see Clock
 *
 * @category Testing
 */
export class TestClock implements Clock {

  /**
   * Every `ms` a {@link TestClock.delay}, {@link TestClock.schedule}, or {@link TestClock.timeout} call asked for, in call order. A request lands here before its entry
   * is registered and whatever later becomes of that entry, so a delay the clock crossed, one whose signal aborted mid-wait, one whose signal was already aborted, and
   * a cancelled callback timer all appear. That is the ledger a suite does its cadence arithmetic against - a history that dropped the entries which never came due
   * would understate exactly the loops worth asserting on. Delays, callback timers, and deadline signals share it, so a clock driving several timers at once is read
   * BY VALUE (`requested.includes(...)`, a count of a given window) rather than at a fixed index, since the interleaving depends on what the consumer armed when.
   */
  public readonly requested: number[] = [];

  // The current virtual time. Seeded by the constructor and moved only by `advance`.
  #now: number;

  // The registered, not-yet-settled entries: delays and callback timers on one list. A delay or a one-shot leaves this list exactly once - when `advance` crosses its
  // deadline, when its signal aborts, or when its handle is disposed - via `#remove`, which splices by identity so a mixed settle-and-cancel sequence never strands or
  // mis-removes an entry. A repeat stays until its handle is disposed.
  readonly #pending: ClockEntry[] = [];

  /**
   * Construct a clock seeded at `start` (default `0`). The seed is the initial value `now()` returns; `advance` moves it forward (or back, for a negative delta).
   *
   * @param start - The initial virtual time, in the consumer's relative timeline. Defaults to `0`.
   */
  public constructor(start = 0) {

    this.#now = start;
  }

  /**
   * Advance virtual time by `ms`, resolving every delay and running every callback timer whose deadline the new time has reached. The delta is applied regardless of
   * sign, so a negative `ms` moves time backward; `advance(0)` moves time nowhere but STILL flushes any already-due entry (a `delay(0)`, a zero-delay callback timer, or
   * an entry with a non-positive `ms`), so a zero or negative window is never a lost wakeup.
   *
   * Due entries settle in ASCENDING deadline order; entries that share a deadline keep their FIFO registration order, because each pass snapshots before any removal and
   * the numeric sort is stable - matching how the platform fires equal-deadline timers in scheduling order. A delay is removed by identity and has its abort listener
   * detached before it resolves, so the resolve path leaks no listener; a one-shot is removed before its callback runs; a repeat re-arms from its own deadline and stays.
   *
   * A callback runs synchronously inside this call, so it observes the clock mid-pass and may register or cancel entries. Anything it arms that is ALREADY due
   * fires within this same `advance`, which also means a callback that re-arms a zero-delay one-shot on every fire spins here just as it would on the platform -
   * neither ever terminates. The mechanism differs, though: the platform defers each re-armed timer to a later event-loop turn, yielding control between fires,
   * while this loop re-snapshots and fires already-due entries synchronously within the same call, with no yield point until the chain is exhausted.
   *
   * @param ms - The amount of virtual time to advance, in milliseconds. May be zero or negative.
   */
  public advance(ms: number): void {

    this.#now += ms;

    // Settle in passes rather than in one sweep, because a callback can arm an already-due entry from inside its own fire (a watchdog re-arm at an elapsed window, a
    // zero-delay one-shot). Each pass re-snapshots, so those entries settle in this same advance; the loop ends the first time a pass finds nothing due.
    for(;;) {

      // Snapshot the due entries BEFORE mutating `#pending`, then sort them into deadline order. Filtering off a live array while removing from it would shift indices
      // and strand entries; the snapshot first decouples the iteration from the removal. The sort is a stable numeric comparator, so equal deadlines preserve FIFO order.
      const due = this.#pending.filter((entry) => entry.deadline <= this.#now).sort((a, b) => a.deadline - b.deadline);

      if(due.length === 0) {

        return;
      }

      for(const entry of due) {

        /* Re-check each entry at fire time rather than trusting the snapshot, because the snapshot is a plan a callback earlier in the same pass can invalidate. Two
         * things can have changed. A sibling callback may have disposed this entry, so the membership test keeps a cancelled timer from firing anyway. And a callback
         * that ran a nested `advance` may already have settled this entry and pushed a repeat's deadline past the outer pass's time, so the due test keeps that repeat
         * from firing a second time for one window.
         */
        if(!this.#pending.includes(entry) || (entry.deadline > this.#now)) {

          continue;
        }

        switch(entry.kind) {

          case "delay": {

            // Remove by identity first so a re-entrant observer sees the correct `pending` count, then detach the abort listener (present only when this delay had a
            // signal) so the resolve path leaves no listener on a long-lived signal, then settle the caller's promise.
            this.#remove(entry);
            entry.dispose?.[Symbol.dispose]();
            entry.resolve();

            break;
          }

          case "once": {

            // A one-shot leaves the list before it runs, so its callback and anything that callback triggers read `pending` without it, and disposing the handle
            // afterwards finds nothing left to remove.
            this.#remove(entry);
            entry.callback();

            break;
          }

          case "repeat": {

            // Re-arm from the entry's OWN deadline rather than from the current time, so a long advance fires a repeat once per elapsed interval instead of once per
            // advance and the cadence never drifts. The re-arm lands BEFORE the callback runs, so a callback that disposes its own handle cancels the next fire.
            entry.deadline += entry.interval;
            entry.callback();

            break;
          }
        }
      }
    }
  }

  /**
   * Advance virtual time to the earliest pending deadline and settle everything due there - the step a consumer's next real timer firing would produce. Delays and
   * callback timers are equal candidates for that deadline. A clock with nothing pending answers `false` and moves no time.
   *
   * The step is `Math.max(0, deadline - now())`, so an entry that is already due - a `delay(0)`, or an entry with a negative `ms` - is flushed through
   * {@link TestClock.advance}'s zero path rather than reached backward for. Entries sharing the earliest deadline settle together within the one step, in
   * {@link TestClock.advance}'s own order, since `advance` stays the single place an entry settles. A whole schedule drains with
   * `while(clock.advanceToNext()) { ... }`: each pass settles one deadline's worth of entries, and the loop ends when nothing is left - though a repeating timer never
   * empties the list, so a drain loop over one of those needs its own bound.
   *
   * @returns `true` when a deadline was stepped to, `false` when nothing was pending.
   */
  public advanceToNext(): boolean {

    const deadline = this.nextDeadline;

    if(deadline === null) {

      return false;
    }

    // Clamp the step at zero. An already-due entry needs `advance(0)`, which flushes it without moving time at all; stepping by the raw difference would drag the
    // virtual time backward to a deadline the clock has already passed, corrupting the timeline every other pending entry and every `now()` read is measured on.
    this.advance(Math.max(0, deadline - this.#now));

    return true;
  }

  /**
   * Register a delay that resolves when virtual time reaches `this.now() + ms`, or rejects with an `AbortError` (matching `node:timers/promises`) if `init.signal` aborts
   * first. A non-positive `ms` yields a deadline at or before the current time, which the very next {@link TestClock.advance} (including `advance(0)`) flushes.
   *
   * A pre-aborted signal rejects on the executor's microtask exactly as `systemClock` does (NOT a synchronous throw): {@link onAbort} fires the handler inline, which
   * removes the just-registered entry and rejects, so the entry never lingers in `pending`. Either way the call's `ms` is recorded in {@link TestClock.requested}.
   *
   * @param ms   - The delay, in milliseconds. May be zero or negative (flushed by the next `advance`).
   * @param init - Optional init options. A supplied `signal` rejects the wait with an `AbortError` when it aborts.
   *
   * @returns A promise that resolves when the deadline is crossed, or rejects with an `AbortError` if the signal aborts first.
   */
  public delay(ms: number, init?: { signal?: AbortSignal }): Promise<void> {

    const { promise, reject, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    const entry: ClockEntry = { deadline: this.#now + ms, kind: "delay", resolve };

    // Record the request before the entry is registered, so the history covers every call rather than only the calls that survive registration: a pre-aborted
    // signal removes its entry within this very call, and a wait a consumer asked for belongs to its cadence whether or not the wait ever came due.
    this.requested.push(ms);

    // Register the entry FIRST so a pre-aborted signal's inline `onAbort` handler (below) can find and remove it. `onAbort` runs the handler synchronously when the
    // signal is already aborted, so for a pre-aborted signal the entry is pushed and then immediately removed-and-rejected within this call - settling on the executor's
    // microtask, identical to `systemClock`. When no signal is supplied, `dispose` stays undefined and the entry only ever leaves via `advance`.
    this.#pending.push(entry);

    if(init?.signal !== undefined) {

      entry.dispose = onAbort(init.signal, () => {

        this.#remove(entry);
        reject(abortError());
      });
    }

    return promise;
  }

  /**
   * Return the current virtual time. Compare these values to each other to derive elapsed intervals - they are a relative timeline, not real epoch milliseconds.
   *
   * @returns The current virtual time.
   */
  public now(): number {

    return this.#now;
  }

  /**
   * Register a callback timer that {@link TestClock.advance} runs when virtual time reaches its deadline: once at `this.now() + ms`, or every `ms` from that point when
   * `init.repeat` is set. The callback runs synchronously inside `advance`, not on a microtask, so a test reads its effects immediately after the advance returns.
   *
   * A repeat floors BOTH its first deadline and its period at one millisecond, because the platform's `setInterval` floors a zero or negative period the same way - a
   * repeat seeded from a raw zero would otherwise fire once per pass rather than once per elapsed millisecond. A one-shot's deadline is uncoerced, matching `delay`, so
   * a non-positive `ms` comes due at or before the current time and the very next `advance` (including `advance(0)`) flushes it. The call's `ms` is recorded in
   * {@link TestClock.requested} as asked, before either coercion.
   *
   * A virtual timeline has no ceiling: a window past the platform timer's is registered as asked and comes due when `advance` reaches it, which is what the production
   * clock's chained arms deliver past the same boundary, so a consumer scheduling against a distant boundary runs one code path under either clock.
   *
   * `init.unref` is accepted and ignored. A virtual timeline has no process to hold open, and the platform's unref decides only whether a pending timer keeps the
   * process alive rather than anything about when the timer fires, so a timer armed with the flag comes due on `advance` exactly as one armed without it. Accepting
   * it is what lets a consumer that sets the policy in production run its rows against this double without a second code path.
   *
   * @param callback - The function to run when the timer fires.
   * @param ms       - The timer's window, in milliseconds.
   * @param init     - Optional init options. `repeat` arms a repeating timer rather than a one-shot; `unref` is accepted and ignored.
   *
   * @returns A handle whose `[Symbol.dispose]` cancels the timer by removing its entry from the timeline. Disposing after a one-shot has fired, and disposing a second
   * time, find nothing to remove and do nothing.
   */
  public schedule(callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable {

    const interval = Math.max(1, ms);

    // Record the request as asked, before the repeat floor, so the ledger reads back the window the consumer chose rather than the one the platform would enforce.
    this.requested.push(ms);

    const entry: ClockEntry = (init?.repeat ?? false) ? { callback, deadline: this.#now + interval, interval, kind: "repeat" } :
      { callback, deadline: this.#now + ms, kind: "once" };

    this.#pending.push(entry);

    return { [Symbol.dispose]: (): void => this.#remove(entry) };
  }

  /**
   * Return a signal that aborts when virtual time reaches `this.now() + ms`, with the platform's own deadline reason: a `DOMException` named `"TimeoutError"` carrying
   * the message `AbortSignal.timeout` aborts with, so a consumer that branches on the reason - through `isTimeoutReason`, a `name` comparison, or a log line - cannot
   * tell this clock's deadline from the production clock's.
   *
   * The abort is one of this clock's own one-shot callback timers, which is why a deadline signal needs no arm of its own on the timeline: {@link TestClock.advance},
   * {@link TestClock.advanceToNext}, {@link TestClock.nextDeadline}, {@link TestClock.pending}, and {@link TestClock.requested} all see it exactly as they see any
   * other one-shot, and the `ms` reaches the ledger through the {@link TestClock.schedule} call underneath.
   *
   * The handle that `schedule` answers is deliberately dropped, because the platform offers no cancel for a deadline signal either: the entry stays on the timeline
   * until an advance crosses its deadline. A deadline whose bounded operation completed early therefore still counts in {@link TestClock.pending} and is still what
   * `advanceToNext` steps to next, exactly as the platform's timer stays armed (only unreferenced) past the settlement of the work it bounded, so a suite drains it
   * rather than reading it as a leak.
   *
   * @param ms - The deadline, in milliseconds.
   *
   * @returns A signal that aborts with a `TimeoutError` once virtual time crosses the deadline.
   */
  public timeout(ms: number): AbortSignal {

    const controller = new AbortController();

    this.schedule(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);

    return controller.signal;
  }

  /**
   * The earliest deadline among the registered entries that have not yet settled - delays and callback timers alike - and `null` when nothing is pending. A test reads
   * it to assert WHEN a consumer's next wait or next timer comes due, where {@link TestClock.pending} answers how many of them are outstanding.
   *
   * @returns The earliest pending deadline, in virtual time, or `null` when nothing is pending.
   */
  public get nextDeadline(): Nullable<number> {

    // One pass, seeded from the list itself rather than from a sentinel bound, so the empty case falls out as null instead of as an infinity every caller would
    // have to recognize and translate.
    let earliest: Nullable<number> = null;

    for(const entry of this.#pending) {

      if((earliest === null) || (entry.deadline < earliest)) {

        earliest = entry.deadline;
      }
    }

    return earliest;
  }

  /**
   * The number of registered entries that have not yet settled, counting pending delays and armed callback timers together. A test reads this to assert a consumer
   * registered its waits and timers and later cleared them (no leak). A repeating timer counts once and keeps counting until its handle is disposed. A deadline signal
   * from {@link TestClock.timeout} counts here until its deadline is crossed, even after the operation it bounded has settled, so a suite drains it rather than
   * reading it as a leak.
   *
   * @returns The count of outstanding entries.
   */
  public get pending(): number {

    return this.#pending.length;
  }

  // Remove `entry` from `#pending` by identity. A guarded `indexOf` + `splice` makes a second removal (an abort that races a resolve, a handle disposed after its
  // one-shot fired) a safe no-op and never removes the wrong entry, so `#pending` stays consistent across any settle-and-cancel interleaving.
  #remove(entry: ClockEntry): void {

    const index = this.#pending.indexOf(entry);

    if(index !== -1) {

      this.#pending.splice(index, 1);
    }
  }
}
