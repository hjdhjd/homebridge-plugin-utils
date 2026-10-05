/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-liveness.mjs: Timing and connection-liveness primitives for plugin webUIs - a signal-aware sleep, request deadlines, an action guard, a trip-signal
 * watchdog, a per-request stall watch, and a page-resume detector.
 */

/**
 * The webUI's liveness layer: a small set of primitives that answer the questions a bare await cannot answer for itself - is the host bridge still there, and is
 * this answer still the one the user asked for?
 *
 * The Homebridge UI bridge is a postMessage round trip with no timeout and no cancellation on any of its methods, so a relay that dies mid-flight leaves every
 * outstanding call pending forever - no rejection, no console signal, nothing for a caller to route into a recovery surface. A page that awaits such a call simply
 * stops. These primitives supply the missing evidence, each for a different shape of await:
 *
 *   - {@link withDeadline} bounds an await that HAS failure plumbing. The caller already knows what to render when its fetch fails, so the deadline's job is only to
 *     make the failure happen: it turns "pending forever" into a rejection the caller's existing catch handles.
 *   - {@link createActionGuard} answers the other question, about a surface whose own actions supersede one another rather than about a bridge that went quiet. A
 *     settings card's probe, save, and close each retire whatever was in flight, so the guard hands every action a signal that aborts the moment that action stops
 *     being the one the user is waiting on.
 *   - {@link createRequestWatchdog} watches awaits that have NO failure plumbing - fire-and-forget probes whose results arrive over push events rather than the
 *     response. There is no caller to reject, so the evidence is a trip signal instead: one shared timer, armed by the first unanswered request and cancelled by any
 *     settlement, that fires a caller-supplied callback when nothing answers in time.
 *   - {@link createStallWatch} watches awaits that report their own failure and have NO bound - a configuration write, which a deadline would release while it
 *     still runs. Nothing is settled early, so the evidence is a change report instead: the consumer hears when any watched request has gone unanswered past a
 *     threshold, and again when the last such request settles.
 *   - {@link createResumeDetector} covers the case where no request is in flight at all: the page was frozen by an OS app-switch and has just woken, with no way to
 *     know whether the helper process behind the relay survived. Subscribers are notified so each can run its own probe.
 *
 * {@link delay} is the signal-aware sleep every lifecycle-bound pause in the webUI goes through, the deadline race above included. The module holds no DOM, no
 * store, and no plugin knowledge, and imports nothing, which is what lets the shell and the feature-options subsystem both build on it. Policy stays with the
 * consumer: which awaits are worth bounding, how long is too long, what a resume probe does, and what any of it renders.
 *
 * @example
 *
 * // Bound an await and tell a deadline expiry apart from a genuine failure.
 * try {
 *
 *   const devices = await withDeadline({ promise: homebridge.request("/getDevices"), seconds: 30, signal });
 * } catch(err) {
 *
 *   renderFailure((err instanceof DeadlineExpiredError) ? "The server did not respond." : errorMessage(err));
 * }
 *
 * @module
 */
"use strict";

// The resume detector's default tick cadence, in seconds. The interval notes the wall-clock time on each tick; a tick that observes far more elapsed time than this
// cadence is the signature of a frozen-then-resumed page. Fifteen seconds keeps the idle cost negligible while sampling often enough that a resume is noticed within
// one cadence of the page waking.
const DEFAULT_RESUME_INTERVAL_SECONDS = 15;

// The default elapsed-wall-clock gap, in seconds, above which a tick reads as a page resume rather than an ordinary tick. The threshold does two jobs at once: it
// stays a jank margin of several check intervals above the cadence, so scheduler jitter never crosses it, and it clears the roughly-once-a-minute cadence a throttled
// hidden desktop tab fires its background ticks at - each throttled tick stores its own timestamp, so its gap stays bounded near that cadence and well under the
// threshold, while any genuine OS suspension runs to minutes and clears it comfortably.
const DEFAULT_RESUME_THRESHOLD_SECONDS = 90;

/**
 * Sleep for the given duration and resolve, or reject early when the supplied signal aborts.
 *
 * This is the browser-side counterpart to the server-side `onAbort` disposable pattern: every lifecycle-bound async pause in the webUI funnels through one
 * helper, so listener cleanup, pre-aborted fast-path semantics, and rejection-reason propagation live in exactly one place. Callers express "wait, but only while
 * this view is alive" by composing a delay with their lifecycle signal - the rest is mechanical.
 *
 * @param {number} ms - Duration to sleep, in milliseconds.
 * @param {AbortSignal} [signal] - Optional lifecycle signal. When provided, an abort cancels the timer and rejects the promise with the signal's reason. A signal
 *                                 that is already aborted at call time rejects synchronously on the next microtask without scheduling a timer.
 * @returns {Promise<void>} Resolves after `ms` milliseconds, or rejects with `signal.reason` on abort.
 */
export function delay(ms, signal) {

  if(signal?.aborted) {

    return Promise.reject(signal.reason);
  }

  const { promise, resolve, reject } = Promise.withResolvers();

  // `onAbort` references `timer` lexically; the const is initialized before any addEventListener fires it, so the TDZ is never touched at call time. Both
  // closures only run later, after both consts are initialized, so `onAbort` is declared first purely for readability - either declaration order is safe.
  const onAbort = () => {

    clearTimeout(timer);
    reject(signal.reason);
  };

  const timer = setTimeout(() => {

    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);

  signal?.addEventListener("abort", onAbort, { once: true });

  return promise;
}

/**
 * The marker a bounded await rejects with when its deadline elapses. Exported so a consumer can tell a deadline expiry apart from a genuine failure with one
 * `instanceof` test rather than by matching message text - one predicate of truth for "did the host go quiet, or did the request itself fail?", which is what lets a
 * failure surface say the honest thing about each.
 */
export class DeadlineExpiredError extends Error {

  /**
   * @param {number} seconds - The deadline that elapsed, named in the message so a log or a rendered failure carries the bound that was exceeded.
   */
  constructor(seconds) {

    super("The request did not complete within " + String(seconds) + " seconds.");

    this.name = "DeadlineExpiredError";
  }
}

// Validate a caller-supplied duration. Every primitive that takes one routes through here, so "a duration is a finite positive number of seconds" is one rule with one
// implementation and one message shape. The label names the parameter at the caller's own boundary, so the throw reads as an error about the call rather than about
// this module's internals.
const requireDurationSeconds = ({ label, value }) => {

  if(!Number.isFinite(value) || (value <= 0)) {

    throw new TypeError(label + " must be a finite, positive number of seconds.");
  }
};

// The race itself, split out from the exported entry point below so that the duration check can throw SYNCHRONOUSLY at the call site. An async function converts every
// throw into a rejected promise, which would turn a programming error into a failure surfacing wherever that promise happened to be handled - or into an unhandled
// rejection when the caller's own guard rejected it before anyone awaited.
const raceDeadline = async ({ promise, seconds, signal }) => {

  // One controller retires the deadline timer on every settlement path. delay() clears its timer when the signal it was given aborts, so aborting this controller in
  // the finally below is what makes an underlying-first settlement leave no pending timer.
  const settled = new AbortController();
  const timerSignal = signal ? AbortSignal.any([ settled.signal, signal ]) : settled.signal;

  // The expiry branch. A clean elapse throws the marker; an abort - either the caller's supersession or this call's own settlement - rejects with that signal's
  // reason, which is what turns a superseded await into a prompt rejection carrying the caller's own abort reason. Promise.race subscribes to this branch, so its
  // rejection is always consumed even when the underlying promise won and the rejection is discarded.
  const expiry = delay(seconds * 1000, timerSignal).then(() => {

    throw new DeadlineExpiredError(seconds);
  });

  try {

    return await Promise.race([ promise, expiry ]);
  } finally {

    settled.abort();
  }
};

/**
 * Race an await against a deadline, so a host call that would otherwise pend forever settles either way.
 *
 * The race bounds the AWAIT, never the request: the bridge offers no cancellation, so an expired call is still in flight and may still land at the host. What changes
 * is that the caller stops waiting on it and can route the failure into whatever recovery surface it already owns. That is also why the optional signal matters - a
 * superseded cycle's await settles the moment it is superseded rather than ticking out its full deadline, so the stale continuation reaches its own staleness guard
 * immediately instead of arriving a deadline later against whatever cycle is current by then.
 *
 * The deadline timer is cleared on every settlement path, including the underlying-first one, so a bounded await that resolves promptly leaves nothing pending behind
 * it.
 *
 * @param {Object} options
 * @param {Promise<unknown>} options.promise - The await to bound. Settles the returned promise with its own outcome when it wins the race.
 * @param {number} options.seconds - The deadline, in seconds. A non-finite or non-positive value throws a TypeError at the call site.
 * @param {AbortSignal} [options.signal] - The caller's lifecycle signal. When it aborts first, the returned promise rejects promptly with the signal's reason instead
 *                                         of waiting out the deadline.
 * @returns {Promise<unknown>} The underlying promise's outcome, or a rejection carrying {@link DeadlineExpiredError} on expiry or the signal's reason on abort.
 * @throws {TypeError} When `seconds` is not a finite, positive number.
 */
export const withDeadline = ({ promise, seconds, signal = undefined }) => {

  requireDurationSeconds({ label: "withDeadline's seconds", value: seconds });

  return raceDeadline({ promise, seconds, signal });
};

/**
 * Create a latest-action-wins guard for a surface whose asynchronous actions supersede one another.
 *
 * A settings card is the shape this exists for: its probe, its save, and its close all reach the host, and only the most recent of them is the one the user is
 * waiting on. Every `start()` retires whatever was in flight and hands the new action a signal that is aborted exactly when that action stops being current - a
 * later `start()`, a `cancel()`, or the parent lifetime ending. A retired action can never come back as the current one, because its signal never returns to life.
 *
 * The answer is a signal rather than a token the caller compares, because a signal is the one value the whole action already needs: the staleness check after an
 * await reads `signal.aborted`, {@link withDeadline} takes it as its own `signal` and settles a superseded await at once instead of waiting out the deadline, and
 * any fetch or listener the action owns takes it too. A token would answer only the first of those, and would stand as a second staleness vocabulary beside the
 * signals this module and the page shell are already written in.
 *
 * One guard serves one surface, shared across that surface's action functions rather than minted per function: a save must retire a probe that is still in flight,
 * and that only happens when both actions start on the same guard. A surface that closes calls `cancel()`, which retires the action in flight without starting
 * another.
 *
 * What the losing call site sees: its bounded await rejects with the signal's own abort reason rather than with {@link DeadlineExpiredError}, so the catch path
 * checks `signal.aborted` before it renders anything. A superseded action has no failure to report, because the action that superseded it owns the surface.
 *
 * The parent is whatever bounds the surface's life - a takeover handle's `signal` for a card mounted in the page's content area - and it is injected rather than
 * reached for, so the guard composes with a lifetime it never has to know the shape of.
 *
 * @example
 *
 * const guard = createActionGuard({ signal: takeover.signal });
 *
 * const probe = async () => {
 *
 *   const signal = guard.start();
 *
 *   try {
 *
 *     const answer = await withDeadline({ promise: homebridge.request("/probe", payload), seconds: 10, signal });
 *
 *     if(signal.aborted) {
 *
 *       return;
 *     }
 *
 *     render(answer);
 *   } catch(error) {
 *
 *     if(signal.aborted) {
 *
 *       return;
 *     }
 *
 *     renderFailure(error);
 *   }
 * };
 *
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - The lifetime that bounds the surface: its abort retires the action in flight, and every action started afterwards begins
 *                                         already aborted.
 * @returns {{ cancel: () => void, start: () => AbortSignal }} The guard handle: `start` retires the previous action and returns the new one's signal, `cancel`
 *   retires the current action without starting another.
 */
export const createActionGuard = ({ signal = undefined } = {}) => {

  // The current action's controller, or null when nothing is in flight. This is the guard's whole state: currency is the controller's identity, so there is no
  // counter to keep and nothing for a stale action to compare itself against.
  let current = null;

  // Retire the current action, which is what makes its signal read as aborted everywhere that action carried it. A no-op when nothing is in flight, so a surface
  // can close, and close again, without guarding the call. The abort is bare: a superseded action reads its own signal rather than the reason behind it.
  const cancel = () => {

    if(current !== null) {

      current.abort();
      current = null;
    }
  };

  // Begin the next action. Retiring the previous one first is the ordering rule: the action that started last is the one the surface honors, and every earlier one
  // learns it lost through the signal it is already carrying. The parent joins through AbortSignal.any rather than through a listener of this module's own, so a
  // long-lived parent accumulates nothing per action, and a parent that has already aborted yields an aborted signal with no special case needed here.
  const start = () => {

    cancel();

    current = new AbortController();

    return signal ? AbortSignal.any([ current.signal, signal ]) : current.signal;
  };

  return { cancel, start };
};

/**
 * Create a shared-timer watchdog over requests that carry no failure plumbing of their own.
 *
 * One timer serves every in-flight request, because a relay is one connection with one liveness truth: a single answered probe proves it for all. The timer therefore
 * arms only when none is pending, and the next watched request re-arms once a settlement has cancelled it. Settlement is two-armed - a resolution AND a rejection both
 * report liveness and are both consumed here - so a rejecting probe counts as a live relay and never surfaces as an unhandled rejection.
 *
 * The signal's abort clears any armed timer, so no trip can fire after teardown. That is a contract rather than a convenience: a consumer wires its own teardown
 * against the same signal and does not need to cancel the watchdog itself.
 *
 * @param {Object} options
 * @param {() => void} options.onTrip - Invoked once when the deadline elapses with nothing having reported liveness. The pending record is cleared first, so detection
 *                                      re-arms for the next watched request rather than staying dead after one fire.
 * @param {AbortSignal} options.signal - Lifecycle signal. An abort clears any armed timer and makes every later `watch` call a no-op.
 * @param {number} options.timeoutSeconds - The deadline, in seconds. A non-finite or non-positive value throws a TypeError at the call site.
 * @returns {{ cancel: () => void, watch: (request: (Promise<unknown> | unknown)) => void }} The watchdog handle: `watch` observes a request, `cancel` disarms without
 *   firing.
 * @throws {TypeError} When `timeoutSeconds` is not a finite, positive number.
 */
export const createRequestWatchdog = ({ onTrip, signal, timeoutSeconds }) => {

  requireDurationSeconds({ label: "createRequestWatchdog's timeoutSeconds", value: timeoutSeconds });

  // The single pending timer, or null when disarmed. Distinct from any render state a consumer keeps: this is only the timer reference the arm and cancel paths touch.
  let pending = null;

  // Cancel the pending timer and null its handle - the one liveness action. Any settled watched request (either way), any evidence the consumer feeds in, and the
  // signal's abort all land here. A no-op when nothing is pending.
  const cancel = () => {

    if(pending !== null) {

      clearTimeout(pending);
      pending = null;
    }
  };

  // The deadline elapsed with no settlement. Null the pending handle FIRST so detection re-arms for the next watched request rather than staying dead after this one
  // fire, then hand off to the consumer's trip callback.
  const trip = () => {

    pending = null;

    onTrip();
  };

  // Watch one request for liveness. The first act reads `signal.aborted` DIRECTLY - never a mirrored local flag, which would reopen the window between abort and this
  // check - and returns before attaching anything, so a feed after teardown leaves no chain on a dead closure. The input is normalized through Promise.resolve() so a
  // non-promise or a thenable still tracks as a settled or pending promise, which is boundary hardening for the plugin-facing half of a consumer's handle.
  const watch = (request) => {

    if(signal.aborted) {

      return;
    }

    const promise = Promise.resolve(request);

    if(pending === null) {

      pending = setTimeout(trip, timeoutSeconds * 1000);
    }

    // Two-armed settlement hook: a resolution and a rejection both report liveness and are both consumed here, so a rejecting probe never surfaces as an unhandled
    // rejection. A one-armed `.then` or a `.finally` would leave the rejection unconsumed.
    promise.then(cancel, cancel);
  };

  // Teardown clears any armed timer, which is the guarantee that lets a consumer register nothing of its own for the watchdog: after abort no trip can fire, and every
  // later watch call returns before arming.
  signal.addEventListener("abort", cancel, { once: true });

  return { cancel, watch };
};

/**
 * Create a stall watch over requests that report their own failure but carry no bound, telling the consumer when any of them has gone unanswered past a threshold.
 *
 * A configuration write is the shape this exists for. Its caller already reports whatever the write answers, success or failure, and the write must not be
 * bounded, because a deadline would release a write that is still running as though it had finished. What the caller lacks is a word to the user while the answer
 * is late, and that is all the watch supplies: it never settles, bounds, or cancels what it watches, and `watch` hands back the request's own promise, so the
 * caller's await sees the request's own outcome and timing. Unlike {@link createRequestWatchdog}, which shares one timer because one answer proves the relay for
 * every request, each request here arms a timer of its own, because each write is its own question and one write's answer says nothing about another's.
 *
 * The consumer hears changes rather than requests: `onChange(true)` when the first watched request becomes overdue, and `onChange(false)` when the last overdue
 * request resolves or rejects, so one episode of stalled writes is one report each way however many writes it held. A request that settles inside the threshold
 * reports nothing. Settlement is two-armed, as the watchdog's is, so a rejecting request is consumed on the observing chain and never surfaces there as an
 * unhandled rejection, while the caller still sees the rejection on its own await. A throw from `onChange` is the consumer's own failure, contained the way the
 * resume detector contains a subscriber's, so it never rejects the observing chain or escapes a timer callback.
 *
 * The watch takes no signal: its lifetime is the page's, as the resume detector's is, and each timer is cleared by its own request's settlement.
 *
 * @example
 *
 * // Tell the user while a save has gone unanswered past the threshold, and stop telling them when it settles.
 * const stalls = createStallWatch({ onChange: (stalled) => renderNotice(stalled), thresholdSeconds: 10 });
 *
 * await stalls.watch(homebridge.savePluginConfig());
 *
 * @param {Object} options
 * @param {(stalled: boolean) => void} options.onChange - Invoked with true when the first watched request becomes overdue, and with false when the last overdue
 *                                                        request settles.
 * @param {number} options.thresholdSeconds - How long a request may go unanswered before it is overdue, in seconds. A non-finite or non-positive value throws a
 *                                            TypeError at the call site.
 * @returns {{ watch: (request: (Promise<unknown> | unknown)) => Promise<unknown> }} The watch handle: `watch` observes a request and returns its own promise.
 * @throws {TypeError} When `thresholdSeconds` is not a finite, positive number.
 */
export const createStallWatch = ({ onChange, thresholdSeconds }) => {

  requireDurationSeconds({ label: "createStallWatch's thresholdSeconds", value: thresholdSeconds });

  // How many watched requests are past the threshold and still unanswered. The consumer hears only its moves between zero and one, which is what makes a notice
  // shown for the first stalled write stay up until the last one settles.
  let overdue = 0;

  // Hand a change to the consumer, keeping its throw from reaching the timer callback or the settlement chain that called this. console is the browser page's
  // diagnostic transport, and a consumer's own failure is exactly that.
  const report = (stalled) => {

    try {

      onChange(stalled);
    } catch(err) {

      // eslint-disable-next-line no-console
      console.warn("A stall-watch observer failed.", err);
    }
  };

  // Watch one request. The input is normalized through Promise.resolve() so a non-promise or a thenable tracks as a settled or pending promise, and that
  // normalized promise is what the caller gets back: for a native promise it is the request itself, so the caller's await is unchanged in outcome and in timing.
  const watch = (request) => {

    const promise = Promise.resolve(request);

    // Whether this request's own timer fired before it settled, which is what tells its settlement whether it has an overdue count to give back.
    let late = false;

    const timer = setTimeout(() => {

      late = true;
      overdue += 1;

      if(overdue === 1) {

        report(true);
      }
    }, thresholdSeconds * 1000);

    // A resolution or a rejection clears the request's timer, and a request that was overdue gives its place in the count back. The hook is attached here, before the
    // caller can attach its own, so a notice is retracted in the same turn the request settles and ahead of whatever the caller does with the outcome.
    const settle = () => {

      clearTimeout(timer);

      if(!late) {

        return;
      }

      overdue -= 1;

      if(overdue === 0) {

        report(false);
      }
    };

    promise.then(settle, settle);

    return promise;
  };

  return { watch };
};

/**
 * Create a page-resume detector: a wall-clock sampler that notifies its subscribers when the page appears to have been frozen and resumed.
 *
 * WebKit does not reliably deliver `visibilitychange` to an embedded iframe's document on an app-switch resume, so a page inside the Homebridge settings frame cannot
 * trust that event to notice a wake - it reads its own clock instead. Each tick notes the wall-clock time and compares it against the previous tick: a gap far larger
 * than the check cadence is the signature of a page that was frozen while the OS suspended it and has just resumed. The new tick time is stored UNCONDITIONALLY before
 * any notification decision, so a tick that decides not to notify never inflates the next tick's measured gap.
 *
 * The gap is read from the wall clock via `Date.now` DELIBERATELY: the wall clock is what accrues while JS is frozen, whereas a monotonic `performance.now` is not
 * guaranteed to advance across an OS suspension - a clock that freezes with the page cannot measure the freeze. The detector consults no visibility state at all, since
 * the same plumbing that drops the change event also leaves the reported state stale, so gap magnitude alone separates the two cases: a throttled hidden tab's ticks
 * are cadence-bounded and stay under the threshold, while a genuine suspension runs to minutes and clears it. Two honest costs come with the threshold - a suspension
 * shorter than it that still killed the helper goes unseen until the next trigger, and a forward system-clock step larger than it fires one false notification (benign,
 * identical to a probe on a live bridge) while a backward step masks one real resume until the next tick.
 *
 * The sampling timer is demand-driven: it arms with the first live subscription and clears with the last, so a page that subscribes nothing runs no timer at all.
 * Arming seeds the last-tick clock, because a gap that accrued while nothing was sampling carries no resume evidence.
 *
 * @param {Object} [options]
 * @param {number} [options.intervalSeconds=15] - How often the wall clock is sampled.
 * @param {number} [options.thresholdSeconds=90] - The gap above which a tick reads as a resume.
 * @returns {{ subscribe: (callback: () => void, options?: { shouldProbe?: () => boolean, signal?: AbortSignal }) => void }} The detector handle.
 * @throws {TypeError} When either duration is not a finite, positive number.
 */
export const createResumeDetector = ({ intervalSeconds = DEFAULT_RESUME_INTERVAL_SECONDS, thresholdSeconds = DEFAULT_RESUME_THRESHOLD_SECONDS } = {}) => {

  requireDurationSeconds({ label: "createResumeDetector's intervalSeconds", value: intervalSeconds });
  requireDurationSeconds({ label: "createResumeDetector's thresholdSeconds", value: thresholdSeconds });

  // The live subscriptions, each a { callback, shouldProbe } record used by identity so a signal's abort can remove exactly its own.
  const subscriptions = new Set();

  // The sampling timer and the wall-clock time of its last tick, both null while nothing is subscribed.
  let lastTick = null;
  let ticker = null;

  // Sample the clock and, on a resume-sized gap, notify every live subscription. Each subscriber's gate is evaluated immediately before its own callback, so a
  // subscriber that becomes ineligible during delivery is never fired against a stale answer, and each pair runs inside its own try: a throwing subscriber is a
  // diagnostic, not a reason for its siblings to go unnotified. Delivery walks a snapshot and re-checks membership, so a callback that tears down another subscription
  // mid-delivery cannot fire the one it just removed.
  const tick = () => {

    const now = Date.now();
    const gap = now - lastTick;

    lastTick = now;

    if(gap <= (thresholdSeconds * 1000)) {

      return;
    }

    for(const subscription of [...subscriptions]) {

      if(!subscriptions.has(subscription)) {

        continue;
      }

      try {

        if(subscription.shouldProbe && !subscription.shouldProbe()) {

          continue;
        }

        subscription.callback();
      } catch(err) {

        // console is the browser page's diagnostic transport, and a subscriber's own failure is exactly that - the detector's contract is to keep sampling and to keep
        // every other subscriber whole.
        // eslint-disable-next-line no-console
        console.warn("A page-resume subscriber failed.", err);
      }
    }
  };

  // Arm the sampler for the first subscription, seeding the last-tick clock so the first measured gap spans a window the detector was actually sampling.
  const arm = () => {

    if(ticker !== null) {

      return;
    }

    lastTick = Date.now();
    ticker = setInterval(tick, intervalSeconds * 1000);
  };

  // Stop sampling once the last subscription is gone. A later subscribe re-arms and re-seeds, so the detector handle stays usable for the page's whole life.
  const disarm = () => {

    if((ticker === null) || subscriptions.size) {

      return;
    }

    clearInterval(ticker);

    lastTick = null;
    ticker = null;
  };

  return {

    /**
     * Register a resume subscriber. The single registration path: there is no construction-time callback, so every subscriber - the framework's and a plugin's alike -
     * arrives through one door with one lifetime story.
     *
     * @param {() => void} callback - Invoked on a detected resume, after this subscription's own gate has passed.
     * @param {Object} [options]
     * @param {() => boolean} [options.shouldProbe] - Per-subscriber gate, evaluated immediately before this subscriber's callback. A falsy answer skips this
     *                                                subscriber only.
     * @param {AbortSignal} [options.signal] - Lifecycle signal. An abort removes exactly this subscription; every sibling keeps receiving. A signal already aborted at
     *                                         call time registers nothing.
     * @returns {void}
     */
    subscribe: (callback, { shouldProbe = undefined, signal = undefined } = {}) => {

      if(signal?.aborted) {

        return;
      }

      const subscription = { callback, shouldProbe };

      subscriptions.add(subscription);
      arm();

      signal?.addEventListener("abort", () => {

        subscriptions.delete(subscription);
        disarm();
      }, { once: true });
    }
  };
};
