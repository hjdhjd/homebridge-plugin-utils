/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.ts: An injectable wall-clock interface - the current time, an abortable delay, and a callback timer - so time-dependent code can be driven deterministically
 * under test.
 */

/**
 * An injectable wall-clock interface.
 *
 * Time-dependent code reads the platform time primitives it needs: the current epoch time (`Date.now()`), a delay that can be cancelled (`node:timers/promises`
 * `setTimeout`), and a callback timer (the global `setTimeout` / `setInterval`). Calling those directly bakes real wall-clock time into the code, so a test cannot
 * exercise a pacing or timeout path without multi-second real waits, and `node:test`'s mock timers do not patch the `node:timers/promises` primitives. Holding a
 * {@link Clock} instead - the abstraction over those primitives - inverts the dependency: production wires {@link systemClock}, whose `now()` IS `Date.now()`, whose
 * `delay()` IS `node:timers/promises` `setTimeout`, and whose `schedule()` IS the global callback timers, so routing through Clock is behavior-neutral; a test wires a
 * `TestClock` (see `clock-double.ts`) that advances virtual time explicitly, so the consumer's time-dependent path runs deterministically and instantly.
 *
 * One contract covers both time shapes rather than one per shape, so a consumer that awaits a wait and a consumer that arms a callback deadline share a single lever:
 * a scenario spanning a backoff and a heartbeat is driven by one clock instead of two mechanisms stepped in concert.
 *
 * This module imports `node:timers/promises` and is therefore Node-only (not browser-safe), like `util.ts`. A browser-targeted consumer cannot resolve that import.
 *
 * @module
 */
import { setTimeout as delay } from "node:timers/promises";

/**
 * The injectable wall-clock contract: the platform time primitives time-dependent code reads. A consumer holds a `Clock` rather than calling `Date.now()` /
 * `node:timers/promises` `setTimeout` / the global callback timers directly, so a test can substitute a controllable double (`TestClock`) and drive time
 * deterministically while production behavior stays unchanged through {@link systemClock}.
 *
 * `delay` and `schedule` deliberately sit on different platform entry points: `delay` keeps the promise primitive from `node:timers/promises` and that primitive's
 * `AbortError` semantics, while `schedule` reaches the global callback timers. A consumer's choice of shape - an awaited wait or an armed deadline - is what decides
 * which primitive it lands on, and the double drives both from one virtual timeline.
 *
 * @see systemClock
 *
 * @category Utilities
 */
export interface Clock {

  /**
   * Resolve after `ms` milliseconds, or reject if `init.signal` aborts first. The production {@link systemClock} implements this as `node:timers/promises` `setTimeout`,
   * so an abort rejects with that primitive's `AbortError` (`name` `"AbortError"`, `code` `"ABORT_ERR"`) rather than the signal's reason.
   *
   * @param ms   - The delay, in milliseconds.
   * @param init - Optional init options. `signal` cancels the delay - resolving the wait early with a rejection - when it aborts.
   *
   * @returns A promise that resolves after the delay, or rejects with an `AbortError` if the signal aborts first.
   */
  delay(ms: number, init?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Return the current time as epoch milliseconds. The production {@link systemClock} implements this as `Date.now()`.
   *
   * @returns The current time in epoch milliseconds.
   */
  now(): number;

  /**
   * Arm a callback timer: run `callback` once after `ms` milliseconds, or every `ms` milliseconds when `init.repeat` is `true`. The production {@link systemClock}
   * implements this as the global `setTimeout` / `setInterval` read at call time, so any harness that replaces those globals observes the timer.
   *
   * @param callback - The function to run when the timer fires.
   * @param ms       - The timer's window, in milliseconds.
   * @param init     - Optional init options. `repeat` arms a repeating timer that fires every `ms` until it is disposed, rather than a one-shot.
   *
   * @returns A handle whose `[Symbol.dispose]` cancels the timer. Disposing after a one-shot has already fired, and disposing a second time, do nothing.
   */
  schedule(callback: () => void, ms: number, init?: { repeat?: boolean }): Disposable;
}

/**
 * The behavior-neutral production {@link Clock}: `now()` IS `Date.now()`, `delay()` IS `node:timers/promises` `setTimeout`, and `schedule()` IS the global callback
 * timers. A consumer that routes its time reads through this clock instead of calling those primitives directly cannot observe any behavior change - it is the same
 * platform calls, one indirection removed at test time.
 *
 * @see Clock
 *
 * @category Utilities
 */
export const systemClock: Clock = {

  // `setTimeout(ms, value, options)` from `node:timers/promises`: pass `undefined` for the resolution value and forward `init` as the options so the caller's signal
  // cancels the wait. `setTimeout(ms, undefined, opts)` resolves to `Promise<undefined>`, which is assignable to the `Promise<void>` the contract declares.
  delay: (ms: number, init?: { signal?: AbortSignal }): Promise<void> => delay(ms, undefined, init),
  now: (): number => Date.now(),

  // The bare `setTimeout` / `setInterval` identifiers here resolve to the GLOBAL callback timers, because the module's only `node:timers/promises` import is aliased
  // to `delay`. Reading them inside the function body rather than binding them at module scope is what keeps them harness-visible: a harness that replaces the globals,
  // `node:test` `mock.timers` among them, observes every timer the production clock arms, so a consumer suite driving mock timers keeps working through this clock.
  // `clearTimeout` cancels either kind - Node holds one-shots and intervals in a single pool - so one disposer covers both arms.
  schedule: (callback: () => void, ms: number, init?: { repeat?: boolean }): Disposable => {

    const handle = (init?.repeat ?? false) ? setInterval(callback, ms) : setTimeout(callback, ms);

    return { [Symbol.dispose]: (): void => clearTimeout(handle) };
  }
};
