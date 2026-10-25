/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.ts: An injectable wall-clock interface - the current time, an abortable delay, and a callback timer - and the cancellable deadline built on its timer, so
 * time-dependent code can be driven deterministically under test.
 */

/**
 * An injectable wall-clock interface, and the cancellable deadline built on it.
 *
 * Time-dependent code reads the platform time primitives it needs: the current epoch time (`Date.now()`), a delay that can be cancelled (`node:timers/promises`
 * `setTimeout`), and a callback timer (the global `setTimeout` / `setInterval`). Calling those directly bakes real wall-clock time into the code, so a test cannot
 * exercise a pacing or timeout path without multi-second real waits. Holding a {@link Clock} instead - the abstraction over those primitives - inverts the
 * dependency: production wires {@link systemClock}, whose `now()` IS `Date.now()`, whose `delay()` IS `node:timers/promises` `setTimeout`, and whose `schedule()` IS
 * the global callback timers, so routing through Clock is behavior-neutral; a test wires a `TestClock` (see `clock-double.ts`) that advances virtual time
 * explicitly, so the consumer's time-dependent path runs deterministically and instantly.
 *
 * A deadline handed to an abortable call is a function over the contract rather than a member of it: {@link armDeadline} arms one of a clock's own callback timers
 * to abort a signal, and answers a {@link Deadline} its holder disposes when the work it bounds settles. Every clock that implements `schedule` therefore answers a
 * deadline, on the same timeline as its waits and its timers, and one construction serves them all.
 *
 * One contract covers every shape of time rather than one contract per shape, so a consumer that awaits a wait, a consumer that arms a callback deadline, and a
 * consumer that hands a deadline's signal to an abortable call all share a single lever: a scenario spanning a backoff, a heartbeat, and a bounded request is driven
 * by one clock instead of by separate mechanisms stepped in concert.
 *
 * The production clock is more than the primitive it wraps only where the platform timer's range runs out. Node arms every timer on a 32-bit signed millisecond count.
 * Its callback and promise timers set a delay past 2147483647 ms (a little under 25 days) to one millisecond, with a warning, rather than refusing it - so a token
 * refresh or an expiry armed against a distant boundary would fire at once, and so would an infinite span, a wait meant never to end. The production clock carries
 * a finite delay past the ceiling itself, arming at most the ceiling and re-arming for the remainder until the requested moment. An infinite span never elapses on
 * the production clock and its double: nothing is armed for it, so an infinite callback timer never fires, an infinite delay settles only when its signal aborts,
 * rejecting on the production clock with the primitive's own `AbortError`, and nothing holds the process open on its account. The contract states each rule, so a
 * consumer states the delay it means and never clamps for the platform.
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
 * `delay` and `schedule` deliberately sit on different platform entry points: `delay` keeps the promise primitive from `node:timers/promises` and that primitive's
 * `AbortError` semantics, while `schedule` reaches the global callback timers. A consumer's choice of shape - an awaited wait or an armed callback - is what decides
 * which primitive it lands on, and the double drives them all from one virtual timeline. A deadline handed to an abortable call needs no member of its own, because
 * {@link armDeadline} arms it through `schedule`. Every member that arms time carries a finite delay past the platform timer's ceiling in full, and an infinite span
 * never elapses on the production clock and its double, as the module's opening note states, so a consumer never clamps a delay for the platform.
 *
 * @see systemClock
 *
 * @category Utilities
 */
export interface Clock {

  /**
   * Resolve after `ms` milliseconds, or reject if `init.signal` aborts first. The production {@link systemClock} implements this as `node:timers/promises` `setTimeout`,
   * so an abort rejects with that primitive's `AbortError` (`name` `"AbortError"`, `code` `"ABORT_ERR"`) rather than the signal's reason. A finite delay past the
   * platform timer's ceiling is carried in full: the production clock awaits the primitive once per hop of at most the ceiling, each hop under the caller's signal. An
   * infinite delay never elapses: the production clock and its double arm nothing for it, so it settles only when `init.signal` aborts, rejecting with the same
   * `AbortError`, and without a signal it never settles. On the production clock an infinite delay holds no process open, so when its signal is one only an
   * unreferenced timer would abort, such as `AbortSignal.timeout`'s or an {@link armDeadline} deadline's, the process can exit before that signal aborts, leaving the
   * wait unsettled.
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
   * implements this as the global `setTimeout` / `setInterval` read at call time, so any harness that replaces those globals observes the timer. A finite window past
   * the platform timer's ceiling is carried in full: the production clock arms at most the ceiling and re-arms for the remainder, for a one-shot and for each period
   * of a repeat alike, so the callback runs when asked. An infinite window never comes due: the production clock and its double arm nothing for it, for a one-shot
   * and a repeat alike, so the callback never runs, disposing the handle does nothing, and nothing holds the process open whatever `init.unref` says.
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
}

/**
 * The platform timer's ceiling in milliseconds. Node arms a callback timer and a promise delay alike on a 32-bit signed count, while the ceiling itself arms
 * silently. A callback timer or a promise delay past this value is set to one millisecond with a TimeoutOverflowWarning. The production clock carries a finite delay
 * past the ceiling as a chain of arms of at most this length, so the value is the hop size as well as the boundary, and arms nothing for an infinite span, which
 * never elapses.
 *
 * A consumer reads it to state a delay relative to the ceiling rather than restating the platform's number - a test arming a window one past it, or advancing a
 * ceiling's worth of time and asserting nothing has fired yet. A consumer never clamps a delay to it, because a {@link Clock} carries a longer delay itself.
 *
 * @category Utilities
 */
export const TIMER_DELAY_MAX_MS = 2147483647;

/* Whether `ms` is a finite delay the platform cannot carry in one arm. An infinite span is not one, because it never elapses, which `neverElapses` states, and the
 * finiteness test keeps this predicate true to its name whichever branch a member checks first. Anything else - a delay within the ceiling, a non-positive one,
 * negative infinity among them, or `NaN` - is handed to the platform timer as it stands, under that timer's own rules. The callback and promise timers set a delay
 * below one millisecond or `NaN` to one millisecond, and truncate a fractional delay to whole milliseconds.
 */
function pastCeiling(ms: number): boolean {

  return Number.isFinite(ms) && (ms > TIMER_DELAY_MAX_MS);
}

/* Whether `ms` is an infinite span, which never elapses on the production clock or its double. Every member that arms time checks it and arms nothing for such a
 * span, because each alternative fires a wait meant never to end or keeps the process alive for it: the platform's own arm fires it after one millisecond, a chain
 * of ceiling-length hops never ends and, referenced, never lets the process exit, and a clamp to the ceiling fires it once the ceiling elapses. The test is an equality
 * rather than a finiteness check, because negative infinity is a negative span and `NaN` fires after one millisecond, each under the platform's own rules.
 */
function neverElapses(ms: number): boolean {

  return ms === Infinity;
}

/* Arm one platform timer - a one-shot or an interval - and apply the process-hold policy to it. Every timer the production clock arms goes through this one site, the
 * chain's hops included, so the policy a consumer stated reaches every hop. The bare `setTimeout` / `setInterval` identifiers resolve to the GLOBAL callback timers,
 * because the module's only `node:timers/promises` import is the module object, and reading them inside the function body rather than binding them at module scope
 * is what keeps them harness-visible: a harness that replaces the globals, `node:test` `mock.timers` among them, observes every timer the production clock arms, hops
 * included, so a consumer suite driving mock timers keeps working through this clock. An `unref` forwards to the handle's own `unref()`, the platform's own
 * mechanism, so the clock states the policy it was handed and adds none of its own.
 */
function armPlatformTimer(callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): NodeJS.Timeout {

  const handle = (init?.repeat ?? false) ? setInterval(callback, ms) : setTimeout(callback, ms);

  if(init?.unref ?? false) {

    handle.unref();
  }

  return handle;
}

/* Arm `callback` after a delay past the platform's ceiling, as a chain of one-shot arms of at most the ceiling each. Every hop but the last re-arms for what remains;
 * the last runs the callback - and for a repeat, starts the next period's chain BEFORE the callback runs, so a callback that disposes its own handle cancels the next
 * fire, just as `clearInterval` inside a platform interval's callback does. The remainder counts down by the hop that was armed rather than by a wall-clock read, so
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

/* Wait on an infinite span, which arms no timer because none could ever come due. With a signal the wait registers one abort listener, and when the signal aborts it
 * hands the aborted signal to the promise primitive, which rejects at once without arming anything, so an infinite wait rejects with exactly the `AbortError` a finite
 * one does; a signal already aborted goes straight to that call. The listener is `once`, so the abort that fires it also detaches it, and until then it lives
 * exactly as long as the wait it serves. Without a signal the wait never settles, and with nothing armed, nothing holds the process open on its account. The
 * listener is registered here rather than through `onAbort`, because `util.ts` imports this module and an import back would form a cycle.
 */
function delayUntilAbort({ signal }: { signal?: AbortSignal } = {}): Promise<void> {

  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();

  if(signal === undefined) {

    return promise;
  }

  if(signal.aborted) {

    return timersPromises.setTimeout(0, undefined, { signal });
  }

  signal.addEventListener("abort", (): void => resolve(timersPromises.setTimeout(0, undefined, { signal })), { once: true });

  return promise;
}

/**
 * The behavior-neutral production {@link Clock}: `now()` IS `Date.now()`, `delay()` IS `node:timers/promises` `setTimeout`, and `schedule()` IS the global callback
 * timers. A consumer that routes its time reads through this clock instead of calling those primitives directly cannot observe any behavior change - it is the same
 * platform calls, one indirection removed - except where the platform timer's range runs out: past the ceiling, where the platform would fire at once and this clock
 * fires when asked, and at an infinite span, which the platform would fire at once and this clock never fires.
 *
 * @see Clock
 *
 * @category Utilities
 */
export const systemClock: Clock = {

  /* The promise primitive is read off the `node:timers/promises` module object at call time rather than bound by a named import, because the module object is what
   * `node:test`'s mock timers patch - a named import binds the original and a harness never sees the wait. `setTimeout(ms, value, options)`: pass `undefined` for the
   * resolution value and forward `init` as the options so the caller's signal cancels the wait; the call resolves to `Promise<undefined>`, assignable to the
   * `Promise<void>` the contract declares. A delay past the ceiling awaits the same primitive once per hop, and an infinite one arms nothing and settles only
   * through its signal.
   */
  delay: (ms: number, init?: { signal?: AbortSignal }): Promise<void> => {

    if(neverElapses(ms)) {

      return delayUntilAbort(init);
    }

    return pastCeiling(ms) ? delayPastCeiling(ms, init) : timersPromises.setTimeout(ms, undefined, init);
  },
  now: (): number => Date.now(),

  /* An infinite window never comes due, so it arms nothing and answers a disposer with nothing to cancel. A window the platform can carry is the platform's own
   * timer, the same call one indirection removed, and one past the ceiling the clock carries as a chain. A single disposer serves every armed window, because
   * `clearTimeout` cancels a one-shot and an interval alike - Node holds every timer in a single pool.
   */
  schedule: (callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable => {

    if(neverElapses(ms)) {

      return { [Symbol.dispose]: (): void => undefined };
    }

    if(pastCeiling(ms)) {

      return armPastCeiling(callback, ms, init);
    }

    const handle = armPlatformTimer(callback, ms, init);

    return { [Symbol.dispose]: (): void => clearTimeout(handle) };
  }
};

/* Construct the reason a deadline aborts with: the `DOMException` named `TimeoutError`, carrying the message the platform's own `AbortSignal.timeout` aborts with, so
 * a consumer branching on the reason - through `isTimeoutReason`, a `name` comparison, or a log line - reads a deadline from this module exactly as it reads the
 * platform's. This is the one place the reason is built, and the suite holds it against a live platform reason rather than against a restatement of it.
 */
function timeoutReason(): DOMException {

  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * A deadline armed by {@link armDeadline}: the signal that aborts when the span elapses, and the disposer that releases the timer behind it. Its holder hands
 * `signal` to the work it bounds and disposes the deadline when that work settles, with `using` where the work is a scope.
 *
 * @category Utilities
 */
export interface Deadline extends Disposable {

  /**
   * Aborts with the platform's `TimeoutError` once the deadline elapses. A deadline disposed before then leaves its signal unaborted for good.
   */
  readonly signal: AbortSignal;
}

/**
 * Arm a deadline of `ms` milliseconds on a clock, answering a {@link Deadline} whose signal aborts when the span elapses and whose disposal releases the timer.
 *
 * The signal aborts with the platform's deadline reason: a `DOMException` whose `name` is `"TimeoutError"`, the reason `AbortSignal.timeout` aborts with and the
 * library's own `isTimeoutReason` predicate accepts. The abort is one of the clock's own callback timers, armed through `schedule` with `unref` set, so a pending
 * deadline never holds the process open. On {@link systemClock} that timer is the global `setTimeout` its `schedule` reads at call time, so a harness that replaces
 * the global, `node:test` mock timers among them, drives the deadline as it drives every other timer the clock arms; on a `TestClock` it is an ordinary one-shot that
 * `advance` crosses and `requested` records.
 *
 * Because the deadline is `schedule`'s timer, the span's domain is `schedule`'s as well: a span past the platform timer's ceiling is carried in full, an infinite
 * span never aborts the signal, and a negative, `NaN`, or fractional span takes whatever handling the clock's `schedule` gives it, as every other span the clock is
 * handed does.
 *
 * Its holder releases the deadline when the work it bounds settles - with `using` where that work is a scope - so no timer outlives the work and a virtual timeline
 * holds no entry for work already done. Disposing after the deadline fired, and disposing a second time, do nothing. Composing the deadline's signal with a caller's
 * own stays the job of `composeSignals` rather than of the deadline, so a consumer assembles the lifetime it wants from the primitive it already reaches for
 * everywhere else.
 *
 * @param ms            - The deadline, in milliseconds.
 * @param options       - Optional deadline options.
 * @param options.clock - The time source the deadline is armed on. Defaults to {@link systemClock}.
 *
 * @returns A {@link Deadline} carrying the signal, for its holder to dispose when the work it bounds settles.
 *
 * @example
 *
 * ```ts
 * async function readStatus(url: string, clock: Clock, signal?: AbortSignal): Promise<unknown> {
 *
 *   // The deadline bounds the request and the body read alike, and is released when the function finishes.
 *   using deadline = armDeadline(5000, { clock });
 *
 *   const response = await fetch(url, { signal: composeSignals(signal, deadline.signal) });
 *
 *   return await response.json();
 * }
 * ```
 *
 * @category Utilities
 */
export function armDeadline(ms: number, { clock = systemClock }: { clock?: Clock } = {}): Deadline {

  const controller = new AbortController();
  const timer = clock.schedule((): void => controller.abort(timeoutReason()), ms, { unref: true });

  return { [Symbol.dispose]: (): void => timer[Symbol.dispose](), signal: controller.signal };
}
