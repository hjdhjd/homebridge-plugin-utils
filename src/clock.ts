/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.ts: An injectable wall-clock interface - the current time, an abortable delay, a callback timer, and a deadline signal - so time-dependent code can be driven
 * deterministically under test.
 */

/**
 * An injectable wall-clock interface.
 *
 * Time-dependent code reads the platform time primitives it needs: the current epoch time (`Date.now()`), a delay that can be cancelled (`node:timers/promises`
 * `setTimeout`), a callback timer (the global `setTimeout` / `setInterval`), and a deadline signal handed to an abortable call (`AbortSignal.timeout`). Calling those
 * directly bakes real wall-clock time into the code, so a test cannot exercise a pacing or timeout path without multi-second real waits. Holding a {@link Clock}
 * instead - the abstraction over those primitives - inverts the dependency: production wires {@link systemClock}, whose `now()` IS `Date.now()`, whose `delay()` IS
 * `node:timers/promises` `setTimeout`, whose `schedule()` IS the global callback timers, and whose `timeout()` IS `AbortSignal.timeout`, so routing through Clock is
 * behavior-neutral; a test wires a `TestClock` (see `clock-double.ts`) that advances virtual time explicitly, so the consumer's time-dependent path runs
 * deterministically and instantly.
 *
 * One contract covers every shape of time rather than one contract per shape, so a consumer that awaits a wait, a consumer that arms a callback deadline, and a
 * consumer that hands a deadline signal to an abortable call all share a single lever: a scenario spanning a backoff, a heartbeat, and a bounded request is driven
 * by one clock instead of by separate mechanisms stepped in concert.
 *
 * The one place the production clock is more than the primitive it wraps is the platform timer's ceiling. Node arms every timer on a 32-bit signed millisecond count,
 * and its timers documentation sets a delay past 2147483647 ms (a little under 25 days) to one millisecond, with a warning, rather than refusing it - so a token
 * refresh or an expiry armed against a distant boundary would fire at once. The production clock carries such a delay itself, arming at most the ceiling and re-arming
 * for the remainder until the requested moment, and the contract states it, so a consumer states the delay it means and never clamps for the platform.
 *
 * This module imports `node:timers/promises` and is therefore Node-only (not browser-safe), like `util.ts`. A browser-targeted consumer cannot resolve that import.
 *
 * @module
 */
import timersPromises from "node:timers/promises";

/**
 * The injectable wall-clock contract: the platform time primitives time-dependent code reads. A consumer holds a `Clock` rather than calling `Date.now()` /
 * `node:timers/promises` `setTimeout` / the global callback timers directly, so a test can substitute a controllable double (`TestClock`) and drive time
 * deterministically while production behavior stays unchanged through {@link systemClock}.
 *
 * `delay`, `schedule`, and `timeout` deliberately sit on different platform entry points: `delay` keeps the promise primitive from `node:timers/promises` and that
 * primitive's `AbortError` semantics, `schedule` reaches the global callback timers, and `timeout` reaches `AbortSignal.timeout` and the `TimeoutError` reason it
 * aborts with. A consumer's choice of shape - an awaited wait, an armed deadline, or a deadline handed to an abortable call - is what decides which primitive it
 * lands on, and the double drives them all from one virtual timeline. Each of the three carries a delay past the platform timer's ceiling in full, as the module's
 * opening note states, so a consumer never clamps a delay for the platform.
 *
 * @see systemClock
 *
 * @category Utilities
 */
export interface Clock {

  /**
   * Resolve after `ms` milliseconds, or reject if `init.signal` aborts first. The production {@link systemClock} implements this as `node:timers/promises` `setTimeout`,
   * so an abort rejects with that primitive's `AbortError` (`name` `"AbortError"`, `code` `"ABORT_ERR"`) rather than the signal's reason. A delay past the platform
   * timer's ceiling is carried in full: the production clock awaits the primitive once per hop of at most the ceiling, each hop under the caller's signal.
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
   * implements this as the global `setTimeout` / `setInterval` read at call time, so any harness that replaces those globals observes the timer. A window past the
   * platform timer's ceiling is carried in full: the production clock arms at most the ceiling and re-arms for the remainder, for a one-shot and for each period of a
   * repeat alike, so the callback runs when asked.
   *
   * With `init.unref` set the timer never holds the process open, so a process whose only pending work is timers armed this way exits without waiting for them...the
   * shape for a consumer living inside a process that must exit on its own. Omitted, the platform's default holds: a referenced timer keeps the process alive until
   * it fires or is disposed. Either way the timer is armed and comes due exactly the same, so the flag decides only whether the process waits for it.
   *
   * @param callback - The function to run when the timer fires.
   * @param ms       - The timer's window, in milliseconds.
   * @param init     - Optional init options. `repeat` arms a repeating timer that fires every `ms` until it is disposed, rather than a one-shot; `unref` arms a timer
   *                   that does not hold the process open.
   *
   * @returns A handle whose `[Symbol.dispose]` cancels the timer. Disposing after a one-shot has already fired, and disposing a second time, do nothing.
   */
  schedule(callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable;

  /**
   * Return a signal that aborts after `ms` milliseconds with the platform's deadline reason: a `DOMException` whose `name` is `"TimeoutError"`, the reason the
   * library's own `isTimeoutReason` predicate already accepts. The production {@link systemClock} implements this as `AbortSignal.timeout`, whose timer is
   * unreferenced and therefore never holds the process open. A deadline past the platform timer's ceiling is carried in full, on a chain of the clock's own
   * unreferenced timers, and aborts with the same reason. Composing this deadline with a caller's own signal stays the job of `composeSignals` rather than of the
   * clock, so a consumer assembles the lifetime it wants from the primitive it already reaches for everywhere else.
   *
   * @param ms - The deadline, in milliseconds.
   *
   * @returns A signal that aborts with the platform's `TimeoutError` once the deadline elapses.
   */
  timeout(ms: number): AbortSignal;
}

/* The platform timer's ceiling in milliseconds. Node arms a callback timer, a promise delay, and a deadline signal alike on a 32-bit signed count, and a delay past
 * this value is set to one millisecond with a TimeoutOverflowWarning, while the ceiling itself arms silently. A delay past it is carried as a chain of arms of at most
 * this length, so the value is the hop size as well as the boundary.
 */
const TIMER_DELAY_MAX_MS = 2147483647;

/* Whether `ms` is a finite delay the platform cannot carry in one arm. Anything else - a delay within the ceiling, a non-positive one, `NaN`, or an infinite one - is
 * handed to the platform as it stands, so the platform's own rules for those values hold unchanged: a floor at one millisecond, and an infinite delay set to one
 * millisecond with the overflow warning rather than a chain that never ends and, referenced, never lets the process exit.
 */
function pastCeiling(ms: number): boolean {

  return Number.isFinite(ms) && (ms > TIMER_DELAY_MAX_MS);
}

/* Arm one platform timer - a one-shot or an interval - and apply the process-hold policy to it. Every timer the production clock arms goes through this one site, the
 * chain's hops included, so the policy a consumer stated reaches every hop. The bare `setTimeout` / `setInterval` identifiers resolve to the GLOBAL callback timers,
 * because the module's only `node:timers/promises` import is the module object, and reading them inside the function body rather than binding them at module scope
 * is what keeps them harness-visible: a harness that replaces the globals, `node:test` `mock.timers` among them, observes every timer the production clock arms, hops
 * included, so a consumer suite driving mock timers keeps working through this clock. An `unref` forwards to the handle's own `unref()`, the same platform mechanism
 * the deadline signal relies on, so the clock states the policy it was handed and adds none of its own.
 */
function armPlatformTimer(callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): NodeJS.Timeout {

  const handle = (init?.repeat ?? false) ? setInterval(callback, ms) : setTimeout(callback, ms);

  if(init?.unref ?? false) {

    handle.unref();
  }

  return handle;
}

/* Arm `callback` after a delay past the platform's ceiling, as a chain of one-shot arms of at most the ceiling each. Every hop but the last re-arms for what remains;
 * the last runs the callback - and for a repeat, starts the next period's chain BEFORE the callback runs, so a callback that disposes its own handle cancels the fire
 * after it, exactly as a platform interval's re-arm precedes its callback. The remainder counts down by the hop that was armed rather than by a wall-clock read, so
 * the chain means what the platform means by a delay - the callback runs after `ms` of timer time - and a wall-clock step never moves it. Each hop's handle replaces
 * the one before it and the disposer reads whichever hop is live, so a cancel mid-chain clears the hop that is actually armed.
 */
function armPastCeiling(callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable {

  let live: NodeJS.Timeout | undefined;

  const arm = (remaining: number): void => {

    const hop = Math.min(remaining, TIMER_DELAY_MAX_MS);

    live = armPlatformTimer((): void => {

      if(remaining > hop) {

        arm(remaining - hop);

        return;
      }

      if(init?.repeat ?? false) {

        arm(ms);
      }

      callback();
    }, hop, { unref: init?.unref });
  };

  arm(ms);

  return { [Symbol.dispose]: (): void => clearTimeout(live) };
}

/* Await a delay past the platform's ceiling as consecutive waits on the promise primitive, each at most the ceiling and each under the caller's signal, so the
 * primitive's own `AbortError` is what an abort rejects with whichever hop is waiting, and a pre-aborted signal rejects on the first.
 */
async function delayPastCeiling(ms: number, init?: { signal?: AbortSignal }): Promise<void> {

  for(let remaining = ms; remaining > 0; remaining -= TIMER_DELAY_MAX_MS) {

    // Each hop has to finish before the next is armed, which is the whole point of the loop.
    // eslint-disable-next-line no-await-in-loop
    await timersPromises.setTimeout(Math.min(remaining, TIMER_DELAY_MAX_MS), undefined, init);
  }
}

/**
 * The behavior-neutral production {@link Clock}: `now()` IS `Date.now()`, `delay()` IS `node:timers/promises` `setTimeout`, `schedule()` IS the global callback
 * timers, and `timeout()` IS `AbortSignal.timeout`. A consumer that routes its time reads through this clock instead of calling those primitives directly cannot
 * observe any behavior change - it is the same platform calls, one indirection removed - except past the platform timer's ceiling, where the platform would fire at
 * once and this clock fires when asked.
 *
 * @see Clock
 *
 * @category Utilities
 */
export const systemClock: Clock = {

  /* The promise primitive is read off the `node:timers/promises` module object at call time rather than bound by a named import, because the module object is what
   * `node:test`'s mock timers patch - a named import binds the original and a harness never sees the wait. `setTimeout(ms, value, options)`: pass `undefined` for the
   * resolution value and forward `init` as the options so the caller's signal cancels the wait; the call resolves to `Promise<undefined>`, assignable to the
   * `Promise<void>` the contract declares. A delay past the ceiling awaits the same primitive once per hop.
   */
  delay: (ms: number, init?: { signal?: AbortSignal }): Promise<void> => pastCeiling(ms) ? delayPastCeiling(ms, init) : timersPromises.setTimeout(ms, undefined, init),
  now: (): number => Date.now(),

  // A window the platform can carry is the platform's own timer, the same call one indirection removed; past the ceiling the clock carries it as a chain. Either way
  // one disposer serves, because `clearTimeout` cancels a one-shot and an interval alike - Node holds both in a single pool.
  schedule: (callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable => {

    if(pastCeiling(ms)) {

      return armPastCeiling(callback, ms, init);
    }

    const handle = armPlatformTimer(callback, ms, init);

    return { [Symbol.dispose]: (): void => clearTimeout(handle) };
  },

  /* Within the ceiling this member IS the platform's `AbortSignal.timeout`: the timer behind the returned signal is unreferenced, so a deadline still pending never
   * holds the process open, and the abort reason is the `DOMException` named `TimeoutError` that the library's own timeout predicate reads. Past the ceiling the
   * deadline is one of the clock's own chained one-shots, unreferenced like the platform's, aborting a controller with the reason the platform aborts with - the same
   * construction the test double uses, and the suite proves each against a live platform reason rather than against a restatement of it.
   */
  timeout: (ms: number): AbortSignal => {

    if(!pastCeiling(ms)) {

      return AbortSignal.timeout(ms);
    }

    const controller = new AbortController();

    armPastCeiling((): void => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms, { unref: true });

    return controller.signal;
  }
};
