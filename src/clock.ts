/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.ts: An injectable wall-clock seam - the current time and an abortable delay - so time-dependent code can be driven deterministically under test.
 */

/**
 * An injectable wall-clock time seam.
 *
 * Time-dependent code reads the platform time primitives it needs: the current epoch time (`Date.now()`) and a delay that can be cancelled (`node:timers/promises`
 * `setTimeout`). Calling those directly bakes real wall-clock time into the code, so a test cannot exercise a pacing or timeout path without multi-second real waits, and
 * `node:test`'s mock timers do not patch the `node:timers/promises` primitives. Holding a {@link Clock} instead - the abstraction over those primitives - inverts the
 * dependency: production wires {@link systemClock}, whose `now()` IS `Date.now()` and whose `delay()` IS `node:timers/promises` `setTimeout`, so routing through the seam
 * is behavior-neutral; a test wires a `TestClock` (see `clock-double.ts`) that advances virtual time explicitly, so the consumer's time-dependent path runs
 * deterministically and instantly.
 *
 * This module imports `node:timers/promises` and is therefore Node-only (not browser-safe), like `util.ts`. A browser-targeted consumer cannot resolve that import.
 *
 * @module
 */
import { setTimeout as delay } from "node:timers/promises";

/**
 * The injectable wall-clock contract: the platform time primitives time-dependent code reads. A consumer holds a `Clock` rather than calling `Date.now()` /
 * `node:timers/promises` `setTimeout` directly, so a test can substitute a controllable double (`TestClock`) and drive time deterministically while production behavior
 * stays unchanged through {@link systemClock}.
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
}

/**
 * The behavior-neutral production {@link Clock}: `now()` IS `Date.now()` and `delay()` IS `node:timers/promises` `setTimeout`. A consumer that routes its time reads
 * through this clock instead of calling those primitives directly cannot observe any behavior change - it is the same two calls, one indirection removed at test time.
 *
 * @see Clock
 *
 * @category Utilities
 */
export const systemClock: Clock = {

  // `setTimeout(ms, value, options)` from `node:timers/promises`: pass `undefined` for the resolution value and forward `init` as the options so the caller's signal
  // cancels the wait. `setTimeout(ms, undefined, opts)` resolves to `Promise<undefined>`, which is assignable to the `Promise<void>` the contract declares.
  delay: (ms: number, init?: { signal?: AbortSignal }): Promise<void> => delay(ms, undefined, init),
  now: (): number => Date.now()
};
