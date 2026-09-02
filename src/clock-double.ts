/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock-double.ts: A reusable, controllable Clock test double - virtual time a test advances explicitly - for the injectable Clock seam in clock.ts.
 */

/**
 * A reusable, controllable {@link Clock} test double.
 *
 * The {@link Clock} seam in `clock.ts` exists so a consuming plugin's time-dependent code can be driven without real wall-clock waits. This module ships the fake that
 * cashes that in: a {@link TestClock} over a virtual timeline a test advances explicitly. `now()` returns the virtual time; `delay()` registers a pending wait that
 * resolves only when {@link TestClock.advance} crosses its deadline, or rejects when its signal aborts - matching `node:timers/promises` `setTimeout`'s `AbortError`
 * shape. No real timers and no wall-clock are used, so a consumer's pacing/timeout/duration path runs deterministically and instantly under test.
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
 * A single registered, not-yet-settled delay. `deadline` is the virtual time at or after which the wait resolves; `resolve` settles the caller's promise when the
 * deadline is crossed; `dispose` detaches the abort listener (present only when a signal was supplied, absent otherwise). The matching `reject` is held by the abort
 * handler's closure rather than stored here, since only the abort path needs it.
 */
interface ClockEntry {

  deadline: number;
  dispose?: Disposable;
  resolve: () => void;
}

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
 * A controllable {@link Clock} double over virtual time. `now()` returns the current virtual time; `delay()` registers a pending wait that resolves only when
 * {@link TestClock.advance} crosses its deadline (in ascending-deadline order), or rejects with an `AbortError` (matching `node:timers/promises` `setTimeout` - `name`
 * `"AbortError"`, `code` `"ABORT_ERR"`, NOT the signal's reason) when its signal aborts. No real timers or wall-clock are used.
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
 *
 * // Nothing resolves until virtual time crosses the deadline.
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
   * Every `ms` a {@link TestClock.delay} call asked for, in call order. A request lands here before its wait is registered and whatever later becomes of that wait,
   * so a delay the clock crossed, one whose signal aborted mid-wait, and one whose signal was already aborted all appear. That is the ledger a suite does its
   * cadence arithmetic against - a history that dropped the waits which never came due would understate exactly the loops worth asserting on.
   */
  public readonly requested: number[] = [];

  // The current virtual time. Seeded by the constructor and moved only by `advance`.
  #now: number;

  // The registered, not-yet-settled delays. An entry leaves this list exactly once - either when `advance` crosses its deadline or when its signal aborts - via
  // `#remove`, which splices by identity so a mixed resolve-and-abort sequence never strands or mis-removes an entry.
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
   * Advance virtual time by `ms` and resolve every delay whose deadline the new time has reached. The delta is applied regardless of sign, so a negative `ms` moves time
   * backward; `advance(0)` moves time nowhere but STILL flushes any already-due entry (a `delay(0)` or a `delay` with a non-positive `ms`), so a zero or negative delay
   * is never a lost wakeup.
   *
   * Due entries resolve in ASCENDING deadline order; entries that share a deadline keep their FIFO registration order, because the snapshot is taken before any removal
   * and the numeric sort is stable - matching how `setTimeout` fires equal-deadline timers in scheduling order. Each due entry is removed by identity and has its abort
   * listener detached before it resolves, so the resolve path leaks no listener and the iteration is immune to the index shifts a forward in-place splice would cause.
   *
   * @param ms - The amount of virtual time to advance, in milliseconds. May be zero or negative.
   */
  public advance(ms: number): void {

    this.#now += ms;

    // Snapshot the due entries BEFORE mutating `#pending`, then sort them into deadline order. Filtering off a live array while removing from it would shift indices and
    // strand entries; the snapshot first decouples the iteration from the removal. The sort is a stable numeric comparator, so equal deadlines preserve FIFO order.
    const due = this.#pending.filter((entry) => entry.deadline <= this.#now).sort((a, b) => a.deadline - b.deadline);

    for(const entry of due) {

      // Remove by identity first so a re-entrant observer sees the correct `pending` count, then detach the abort listener (present only when this delay had a signal) so
      // the resolve path leaves no listener on a long-lived signal, then settle the caller's promise.
      this.#remove(entry);
      entry.dispose?.[Symbol.dispose]();
      entry.resolve();
    }
  }

  /**
   * Advance virtual time to the earliest pending deadline and settle everything due there - the step a consumer's next real timer firing would produce. A clock
   * with nothing pending answers `false` and moves no time.
   *
   * The step is `Math.max(0, deadline - now())`, so an entry that is already due - a `delay(0)`, or a `delay` with a negative `ms` - is flushed through
   * {@link TestClock.advance}'s zero path rather than reached backward for. Entries sharing the earliest deadline settle together within the one step, in
   * {@link TestClock.advance}'s own order, since `advance` stays the single place an entry settles. A whole schedule drains with
   * `while(clock.advanceToNext()) { ... }`: each pass settles one deadline's worth of waits, and the loop ends when nothing is left.
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
    const entry: ClockEntry = { deadline: this.#now + ms, resolve };

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
   * The earliest deadline among the registered delays that have neither resolved nor rejected, and `null` when nothing is pending. A test reads it to assert WHEN a
   * consumer's next wait comes due, where {@link TestClock.pending} answers how many of them are outstanding.
   *
   * @returns The earliest pending deadline, in virtual time, or `null` when no delay is pending.
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
   * The number of registered delays that have neither resolved nor rejected. A test reads this to assert a consumer registered its waits and later cleared them (no
   * leak).
   *
   * @returns The count of unsettled delays.
   */
  public get pending(): number {

    return this.#pending.length;
  }

  // Remove `entry` from `#pending` by identity. A guarded `indexOf` + `splice` makes a second removal (e.g. an abort that races a resolve) a safe no-op and
  // never removes the wrong entry, so `#pending` stays consistent across any resolve-and-abort interleaving.
  #remove(entry: ClockEntry): void {

    const index = this.#pending.indexOf(entry);

    if(index !== -1) {

      this.#pending.splice(index, 1);
    }
  }
}
