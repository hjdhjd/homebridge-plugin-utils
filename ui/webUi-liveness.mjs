/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-liveness.mjs: Connection-liveness primitives for plugin webUIs - request deadlines, a trip-signal watchdog, and a page-resume detector.
 */

/**
 * The webUI's liveness layer: three primitives that answer one question - is the host bridge still there?
 *
 * The Homebridge UI bridge is a postMessage round trip with no timeout and no cancellation on any of its methods, so a relay that dies mid-flight leaves every
 * outstanding call pending forever - no rejection, no console signal, nothing for a caller to route into a recovery surface. A page that awaits such a call simply
 * stops. These primitives supply the missing evidence, each for a different shape of await:
 *
 *   - {@link withDeadline} bounds an await that HAS failure plumbing. The caller already knows what to render when its fetch fails, so the deadline's job is only to
 *     make the failure happen: it turns "pending forever" into a rejection the caller's existing catch handles.
 *   - {@link createRequestWatchdog} watches awaits that have NO failure plumbing - fire-and-forget probes whose results arrive over push events rather than the
 *     response. There is no caller to reject, so the evidence is a trip signal instead: one shared timer, armed by the first unanswered request and cancelled by any
 *     settlement, that fires a caller-supplied callback when nothing answers in time.
 *   - {@link createResumeDetector} covers the case where no request is in flight at all: the page was frozen by an OS app-switch and has just woken, with no way to
 *     know whether the helper process behind the relay survived. Subscribers are notified so each can run its own probe.
 *
 * The module holds no DOM, no store, and no plugin knowledge; it composes only with the shared {@link module:webUi-featureOptions/utils delay} helper. Policy stays
 * with the consumer: which awaits are worth bounding, how long is too long, what a resume probe does, and what any of it renders.
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

import { delay } from "./webUi-featureOptions/utils.mjs";

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

// Validate a caller-supplied duration. Both primitives that take one route through here, so "a duration is a finite positive number of seconds" is one rule with one
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
 * are cadence-bounded and stay under the threshold, while a genuine suspension runs to minutes and clears it. Two honest costs ride the threshold - a suspension
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
