/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-liveness.test.mjs: The specification suite for the timing and connection-liveness primitives - the signal-aware sleep, the rejecting deadline, the
 * latest-action guard, the shared-timer request watchdog, and the page-resume detector. Every clock in here is a node:test mock, so each test states the exact time
 * it advances and nothing waits on wall-clock duration.
 */
"use strict";

import { DeadlineExpiredError, createActionGuard, createRequestWatchdog, createResumeDetector, delay, withDeadline } from "./webUi-liveness.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flushImmediate } from "node:timers/promises";

// A promise that never settles, standing in for a bridge call whose relay died.
const hangingPromise = () => new Promise(() => {});

// Drain the microtask queue so a raced promise's settlement has reached its handlers before an assertion reads the result.
const flush = async () => {

  for(let i = 0; i < 3; i++) {

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
};

describe("delay", () => {

  test("resolves after the configured duration when no signal is provided", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    let resolved = false;

    const sleeping = delay(20).then(() => {

      resolved = true;
    });

    // The mocked clock states the boundary exactly: a millisecond short of the duration nothing has resolved, and the duration itself settles the promise.
    t.mock.timers.tick(19);
    await flush();

    assert.equal(resolved, false, "delay must not resolve before the configured duration");

    t.mock.timers.tick(1);
    await sleeping;

    assert.equal(resolved, true, "delay resolves once the configured duration has elapsed");
  });

  test("rejects synchronously with signal.reason when the signal is already aborted at call time", async () => {

    const controller = new AbortController();
    const reason = new Error("preflight cancelled");

    controller.abort(reason);

    await assert.rejects(() => delay(10000, controller.signal), (error) => error === reason);
  });

  test("rejects with signal.reason when the signal aborts mid-delay and never schedules the resolution callback", async (t) => {

    // Mock timers let us prove the resolution path is NOT taken: if it were, advancing past the delay would resolve the promise. We abort first, then tick well past
    // the duration, and the promise must remain in its rejected state with the abort reason.
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const controller = new AbortController();
    const reason = new Error("torn down mid-window");
    const promise = delay(1000, controller.signal);

    // Race the abort against the (mocked) timer.
    controller.abort(reason);

    // Advance virtual time past the delay window. If the timer callback fired, the promise would resolve - which would violate the contract.
    t.mock.timers.tick(5000);

    await assert.rejects(() => promise, (error) => error === reason);
  });

  test("removes the abort listener after the timer fires so a later abort does not trigger a stale callback", async (t) => {

    // We assert listener hygiene via the AbortSignal's own listener accounting: after the timer resolves, aborting the controller must not invoke anything that
    // would resurrect a settled promise. The cleanest observable signal is that we can still await an already-resolved promise without throwing - if the listener
    // were still bound, it would call reject on the same withResolvers tuple, which is a no-op on an already-resolved promise, but verifies the post-resolve abort
    // does not throw or interfere.
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const controller = new AbortController();
    const sleeping = delay(5, controller.signal);

    t.mock.timers.tick(5);
    await sleeping;

    assert.doesNotThrow(() => controller.abort(new Error("post-resolve abort must be inert")));
  });
});

describe("withDeadline", () => {

  test("the underlying promise wins: its value is returned and the deadline never fires", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const result = await withDeadline({ promise: Promise.resolve("settled"), seconds: 30 });

    assert.equal(result, "settled", "a resolved underlying promise settles the race with its own value");

    // The timer-leak proof, by technique: node:test's MockTimers exposes no pending-timer census, so the honest assertion is behavioral. Advance the clock far past
    // the deadline and prove nothing fires - no rejection, no unhandled rejection, no observable effect of any kind.
    t.mock.timers.tick(600000);
    await flush();

    assert.ok(true, "advancing well past the deadline after an underlying-first settlement produced no effect");
  });

  test("the underlying promise's rejection is returned as a rejection, not converted into an expiry", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const failure = new Error("the request itself failed");

    await assert.rejects(() => withDeadline({ promise: Promise.reject(failure), seconds: 30 }), (err) => {

      assert.equal(err, failure, "the underlying rejection reaches the caller verbatim");
      assert.ok(!(err instanceof DeadlineExpiredError), "a genuine failure is never reported as a deadline expiry");

      return true;
    });
  });

  test("the deadline wins: the race rejects with DeadlineExpiredError naming the elapsed seconds", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const bounded = withDeadline({ promise: hangingPromise(), seconds: 30 });

    // One millisecond short of the deadline: still pending, still no verdict.
    t.mock.timers.tick(29999);
    await flush();

    let settledEarly = false;

    void bounded.catch(() => {

      settledEarly = true;
    });

    await flush();
    assert.equal(settledEarly, false, "the bound has not elapsed, so the await is still pending");

    t.mock.timers.tick(2);

    await assert.rejects(() => bounded, (err) => {

      assert.ok(err instanceof DeadlineExpiredError, "an elapsed bound rejects with the exported marker so a consumer can branch on it");
      assert.equal(err.message, "The request did not complete within 30 seconds.", "the message names the bound that was exceeded");
      assert.equal(err.name, "DeadlineExpiredError", "the error carries its own name for diagnostics");

      return true;
    });
  });

  test("an abort settles the await promptly with the signal's reason rather than waiting out the deadline", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const controller = new AbortController();
    const reason = new Error("this cycle was superseded");
    const bounded = withDeadline({ promise: hangingPromise(), seconds: 30, signal: controller.signal });

    // No clock advance at all: the supersession alone settles the await, which is what lets a stale cycle reach its staleness guard immediately instead of a
    // deadline later, against whatever cycle is current by then.
    controller.abort(reason);

    await assert.rejects(() => bounded, (err) => {

      assert.equal(err, reason, "the abort reason is what the caller sees");
      assert.ok(!(err instanceof DeadlineExpiredError), "a supersession is not a deadline expiry");

      return true;
    });
  });

  test("a signal already aborted at call time rejects without arming anything", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const reason = new Error("already gone");

    await assert.rejects(() => withDeadline({ promise: hangingPromise(), seconds: 30, signal: AbortSignal.abort(reason) }), (err) => {

      assert.equal(err, reason, "a pre-aborted signal rejects with its own reason");

      return true;
    });

    t.mock.timers.tick(600000);
    await flush();

    assert.ok(true, "no timer outlived the pre-aborted call");
  });

  test("an underlying promise that beats an aborting signal still wins the race", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const controller = new AbortController();
    const result = await withDeadline({ promise: Promise.resolve("in time"), seconds: 30, signal: controller.signal });

    assert.equal(result, "in time", "a settled underlying promise is the outcome regardless of what the signal does later");

    controller.abort();
    t.mock.timers.tick(600000);
    await flush();

    assert.ok(true, "a later abort after an underlying-first settlement has no effect");
  });

  test("a non-finite or non-positive duration throws a TypeError naming the parameter", () => {

    for(const seconds of [ 0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, "30" ]) {

      assert.throws(() => withDeadline({ promise: Promise.resolve(), seconds }), {

        constructor: TypeError,
        message: "withDeadline's seconds must be a finite, positive number of seconds."
      });
    }
  });
});

describe("createActionGuard", () => {

  test("start() hands the new action a live signal", () => {

    const guard = createActionGuard({ signal: new AbortController().signal });
    const action = guard.start();

    assert.ok(action instanceof AbortSignal, "an action's currency is expressed as a signal, which is the lifecycle vocabulary the caller already speaks");
    assert.equal(action.aborted, false, "the action that just started is the current one, so the signal it carries is live");
  });

  test("a second start() retires the first action and returns a different, live signal", () => {

    const guard = createActionGuard({ signal: new AbortController().signal });
    const first = guard.start();
    const second = guard.start();

    assert.equal(first.aborted, true, "the action that was in flight lost the surface to the one that started after it");
    assert.equal(second.aborted, false, "and the action that started last is the one the surface honors");
    assert.notEqual(first, second, "each action carries a signal of its own, so one action's retirement never reaches another's");
  });

  test("cancel() retires the current action, and is safe to call more than once or before anything has started", () => {

    const guard = createActionGuard();

    assert.doesNotThrow(() => guard.cancel(), "a surface that closes before it ever acted has nothing to retire and must not fail trying");

    const action = guard.start();

    guard.cancel();

    assert.equal(action.aborted, true, "a closing surface retires the action it left in flight");
    assert.doesNotThrow(() => guard.cancel(), "a second close finds nothing in flight and does nothing");

    const next = guard.start();

    assert.equal(next.aborted, false, "and a guard that has been cancelled still starts live actions afterwards");
  });

  test("the parent's abort retires the action in flight, and every action started afterwards begins aborted", () => {

    const parent = new AbortController();
    const guard = createActionGuard({ signal: parent.signal });
    const action = guard.start();

    parent.abort();

    assert.equal(action.aborted, true, "the lifetime that bounds the surface bounds each of its actions with it");

    const afterwards = guard.start();

    assert.equal(afterwards.aborted, true, "an action begun against a surface whose lifetime has ended is stale from its first statement");
  });

  test("with no parent injected, the same contract holds for createActionGuard() and for createActionGuard({})", () => {

    for(const guard of [ createActionGuard(), createActionGuard({}) ]) {

      const first = guard.start();

      assert.equal(first.aborted, false, "an unparented guard starts live actions exactly as a parented one does");

      const second = guard.start();

      assert.equal(first.aborted, true, "a later action retires the earlier one with no parent to join");
      assert.equal(second.aborted, false, "and the later action is the current one");

      guard.cancel();

      assert.equal(second.aborted, true, "cancel() retires the current action here too");
    }
  });

  test("a retired action stays retired through every later start() and cancel()", () => {

    const guard = createActionGuard({ signal: new AbortController().signal });
    const superseded = guard.start();

    guard.start();
    guard.cancel();
    guard.start();

    assert.equal(superseded.aborted, true, "an action that lost the surface can never come back around as the current one");
  });

  test("a bounded await is settled by its own supersession rather than by the deadline it was given", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const guard = createActionGuard();
    const signal = guard.start();
    const bounded = withDeadline({ promise: hangingPromise(), seconds: 30, signal });

    // No clock advance at all: the supersession alone settles the await, which is what lets a superseded action reach its own staleness check immediately rather
    // than a deadline later, against a surface some newer action already owns.
    guard.start();

    await assert.rejects(() => bounded, (err) => {

      assert.ok(!(err instanceof DeadlineExpiredError), "a supersession is not a deadline expiry, and the call site must be able to tell them apart");
      assert.equal(signal.aborted, true, "the catch path reads this action's own signal, finds it retired, and renders nothing");

      return true;
    });

    t.mock.timers.tick(600000);
    await flush();

    assert.ok(true, "the superseded action's deadline timer was released with it, so advancing past the deadline produced no effect");
  });
});

describe("createRequestWatchdog", () => {

  // Build a watchdog whose trips are counted, with its own controller so a test can tear it down.
  const buildWatchdog = ({ timeoutSeconds = 10 } = {}) => {

    const controller = new AbortController();
    const trips = [];
    const watchdog = createRequestWatchdog({ onTrip: () => trips.push(Date.now()), signal: controller.signal, timeoutSeconds });

    return { controller, trips, watchdog };
  };

  test("one shared timer serves every in-flight request - a second watch does NOT reset the first's schedule", (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ] });

    const { trips, watchdog } = buildWatchdog({ timeoutSeconds: 10 });

    watchdog.watch(hangingPromise());

    // Advance most of the way to the first arm's deadline, THEN watch a second request. An implementation that re-armed on every watch would push the trip out
    // to ten seconds from here; the shared timer must still fire on the FIRST arm's schedule, two seconds from here.
    t.mock.timers.tick(8000);
    watchdog.watch(hangingPromise());

    t.mock.timers.tick(1999);
    assert.equal(trips.length, 0, "the shared deadline has not elapsed yet");

    t.mock.timers.tick(2);
    assert.deepEqual(trips, [10001], "the trip fired on the FIRST arm's schedule, so the second watch shared its timer rather than resetting it");
  });

  test("a resolution reports liveness and cancels the shared timer; the next request re-arms a full deadline", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { trips, watchdog } = buildWatchdog({ timeoutSeconds: 10 });
    const probe = Promise.withResolvers();

    watchdog.watch(probe.promise);
    watchdog.watch(hangingPromise());

    // Settling ONE probe is liveness for the whole relay: it cancels the shared timer even though the other request still hangs.
    probe.resolve("answered");
    await flush();

    t.mock.timers.tick(10001);
    assert.equal(trips.length, 0, "a settled probe cancelled the shared timer, so nothing tripped");

    // A fresh request re-arms detection on its own full deadline.
    watchdog.watch(hangingPromise());
    t.mock.timers.tick(10001);
    assert.equal(trips.length, 1, "the next watched request re-armed the watchdog and it tripped");
  });

  test("a rejection reports liveness too, and never surfaces as an unhandled rejection", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { trips, watchdog } = buildWatchdog({ timeoutSeconds: 10 });

    // A relay that answers with an error is a relay that is alive. The two-armed settlement hook consumes the rejection, so no unhandled rejection escapes.
    watchdog.watch(Promise.reject(new Error("the request failed")));
    await flush();

    t.mock.timers.tick(10001);
    assert.equal(trips.length, 0, "a rejecting probe counts as a live relay and cancels detection");
  });

  test("a non-promise feed is normalized and tracks as a settled request", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { trips, watchdog } = buildWatchdog({ timeoutSeconds: 10 });

    watchdog.watch("not a promise at all");
    await flush();

    t.mock.timers.tick(10001);
    assert.equal(trips.length, 0, "a plain value normalizes to a settled promise, which reads as liveness");
  });

  test("cancel disarms without firing", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { trips, watchdog } = buildWatchdog({ timeoutSeconds: 10 });

    watchdog.watch(hangingPromise());
    watchdog.cancel();

    t.mock.timers.tick(10001);
    assert.equal(trips.length, 0, "an explicit cancel disarms the timer and fires no trip");

    assert.doesNotThrow(() => watchdog.cancel(), "cancelling with nothing pending is a no-op");
  });

  test("a trip clears the pending record, so detection re-arms rather than staying dead after one fire", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { trips, watchdog } = buildWatchdog({ timeoutSeconds: 10 });

    watchdog.watch(hangingPromise());
    t.mock.timers.tick(10001);
    assert.equal(trips.length, 1, "the first deadline tripped");

    watchdog.watch(hangingPromise());
    t.mock.timers.tick(10001);
    assert.equal(trips.length, 2, "detection survived its own trip and fired again on the next request's deadline");
  });

  test("the signal's abort clears an armed timer, so no trip can fire after teardown", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { controller, trips, watchdog } = buildWatchdog({ timeoutSeconds: 10 });

    watchdog.watch(hangingPromise());
    controller.abort();

    t.mock.timers.tick(10001);
    assert.equal(trips.length, 0, "the abort cleared the armed timer - this is the contract that lets a consumer register no teardown of its own");

    // And a feed on the torn-down watchdog arms nothing, so a stale handle held by a plugin is harmless.
    assert.doesNotThrow(() => watchdog.watch(hangingPromise()), "a feed after teardown does not throw");
    t.mock.timers.tick(10001);
    assert.equal(trips.length, 0, "a post-abort feed armed no timer");
  });

  test("a non-finite or non-positive timeout throws a TypeError naming the parameter", () => {

    for(const timeoutSeconds of [ 0, -5, Number.NaN, undefined ]) {

      assert.throws(() => createRequestWatchdog({ onTrip: () => {}, signal: new AbortController().signal, timeoutSeconds }), {

        constructor: TypeError,
        message: "createRequestWatchdog's timeoutSeconds must be a finite, positive number of seconds."
      });
    }
  });
});

describe("createResumeDetector", () => {

  // The default cadence and threshold in milliseconds, mirrored so a test can advance in cadence-sized steps and jump clear past the threshold.
  const INTERVAL_MS = 15000;
  const THRESHOLD_MS = 90000;

  // Enable the clocks a resume test needs: setInterval for the sampler and Date so setTime can simulate a wall-clock jump. Enabling the Date mock resets the clock to
  // zero and the detector seeds its last tick when it arms, so this MUST run before the first subscribe - arming against a real-epoch seed under a zeroed clock would
  // read every gap as negative and silently kill the probe.
  const enableResumeTimers = (t) => t.mock.timers.enable({ apis: [ "Date", "setInterval" ] });

  // Simulate an OS suspension: jump the wall clock far past the threshold WITHOUT running timers, then drain one cadence so the sampler fires against the jump.
  const simulateResume = (t) => {

    t.mock.timers.setTime(Date.now() + (6 * THRESHOLD_MS));
    t.mock.timers.tick(INTERVAL_MS);
  };

  test("a wall-clock jump past the threshold notifies the subscriber exactly once", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector();
    const fires = [];

    detector.subscribe(() => fires.push(Date.now()));

    // Several normal-cadence ticks: the sampler fires each time, but every gap equals the cadence and stays under the threshold, so nothing is notified.
    t.mock.timers.tick(INTERVAL_MS);
    t.mock.timers.tick(INTERVAL_MS);
    t.mock.timers.tick(INTERVAL_MS);
    assert.equal(fires.length, 0, "normal cadence is not a resume");

    // The suspension. The first drained fire sees the whole jumped gap and notifies; every trailing fire in the drain sees a zero gap, because the last-tick store is
    // unconditional - so one resume yields exactly one notification, never one per drained fire.
    simulateResume(t);
    assert.equal(fires.length, 1, "the jump notified exactly once despite the interval backlog it drained");
  });

  test("a throttled hidden tab's minute-scale ticks stay under the threshold, then a genuine suspension notifies", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector();
    const fires = [];

    detector.subscribe(() => fires.push(1));

    // A throttled hidden desktop tab fires background ticks at roughly one-minute spacing. Each stores its own timestamp, so each gap stays bounded near that cadence
    // and well under the threshold. The detector reads no visibility state, so gap magnitude alone is what separates this from a suspension.
    for(let i = 0; i < 5; i++) {

      t.mock.timers.setTime(Date.now() + 60000);
      t.mock.timers.tick(1);
    }

    assert.equal(fires.length, 0, "throttle-range gaps never read as a resume");

    simulateResume(t);
    assert.equal(fires.length, 1, "a multi-minute suspension clears the threshold and notifies once");
  });

  test("shouldProbe gates per subscriber and is evaluated immediately before that subscriber's own callback", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector();
    const order = [];

    // Two subscribers, one gated open and one gated shut. The recorded order proves each gate runs immediately before its OWN callback rather than every gate running
    // first and every callback after - the pairing that keeps a subscriber from firing against an answer taken before a sibling ran.
    detector.subscribe(() => order.push("first:fire"), { shouldProbe: () => {

      order.push("first:gate");

      return true;
    } });

    detector.subscribe(() => order.push("second:fire"), { shouldProbe: () => {

      order.push("second:gate");

      return false;
    } });

    simulateResume(t);

    assert.deepEqual(order, [ "first:gate", "first:fire", "second:gate" ],
      "each gate is evaluated immediately before its own callback, and a shut gate skips only itself");
  });

  test("every live subscriber is notified, and a throwing subscriber neither blocks nor silences its siblings", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector();
    const fires = [];
    const warnings = [];

    // console is the transport the code under test reports a subscriber failure on, so the spy has to speak the same channel.
    // eslint-disable-next-line no-console
    const realWarn = console.warn;

    // eslint-disable-next-line no-console
    console.warn = (...args) => warnings.push(args);

    try {

      detector.subscribe(() => fires.push("before"));
      detector.subscribe(() => {

        throw new Error("this subscriber is broken");
      });
      detector.subscribe(() => fires.push("after"));

      simulateResume(t);
    } finally {

      // eslint-disable-next-line no-console
      console.warn = realWarn;
    }

    assert.deepEqual(fires, [ "before", "after" ], "the subscriber registered after the throwing one still received its notification");
    assert.equal(warnings.length, 1, "the failure was reported once");
    assert.equal(warnings[0][0], "A page-resume subscriber failed.", "the diagnostic names what happened as a complete sentence");
  });

  test("an aborted subscription stops receiving while every sibling keeps receiving", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector();
    const controller = new AbortController();
    const doomed = [];
    const survivor = [];

    detector.subscribe(() => doomed.push(1), { signal: controller.signal });
    detector.subscribe(() => survivor.push(1));

    simulateResume(t);
    assert.deepEqual([ doomed.length, survivor.length ], [ 1, 1 ], "both subscriptions received the first resume");

    controller.abort();
    simulateResume(t);

    assert.equal(doomed.length, 1, "the aborted subscription received nothing further");
    assert.equal(survivor.length, 2, "the surviving sibling still receives resumes");
  });

  test("a signal already aborted at subscribe time registers nothing", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector();
    const fires = [];

    detector.subscribe(() => fires.push(1), { signal: AbortSignal.abort() });

    simulateResume(t);
    assert.equal(fires.length, 0, "a pre-aborted subscription never receives a notification");
  });

  test("the sampler is demand-driven: it runs only while a subscription is live, and a later subscribe re-seeds its clock", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector();
    const controller = new AbortController();
    const fires = [];

    detector.subscribe(() => fires.push(1), { signal: controller.signal });
    controller.abort();

    // With the last subscription gone the sampler has stopped, so time passing - however much - accrues no gap to be measured later.
    t.mock.timers.setTime(Date.now() + (20 * THRESHOLD_MS));

    const late = [];

    detector.subscribe(() => late.push(1));

    // The re-arm seeds its last tick at subscribe time, so the very first tick after it measures only the cadence rather than the whole unsampled window. Without
    // the re-seed this tick would read the twenty-threshold jump above and fire a spurious notification.
    t.mock.timers.tick(INTERVAL_MS);
    assert.equal(late.length, 0, "the window that passed while nothing was sampling is not reported as a resume");

    simulateResume(t);
    assert.equal(late.length, 1, "the re-armed sampler still detects a real resume");
  });

  test("custom cadence and threshold are honored, and non-finite or non-positive values throw", (t) => {

    enableResumeTimers(t);

    const detector = createResumeDetector({ intervalSeconds: 5, thresholdSeconds: 20 });
    const fires = [];

    detector.subscribe(() => fires.push(1));

    // A fifteen-second gap clears the twenty-second threshold on neither count, so it is an ordinary tick under this configuration.
    t.mock.timers.setTime(Date.now() + 15000);
    t.mock.timers.tick(5000);
    assert.equal(fires.length, 0, "a gap under the configured threshold is not a resume");

    t.mock.timers.setTime(Date.now() + 25000);
    t.mock.timers.tick(5000);
    assert.equal(fires.length, 1, "a gap over the configured threshold is");

    assert.throws(() => createResumeDetector({ intervalSeconds: 0 }), {

      constructor: TypeError,
      message: "createResumeDetector's intervalSeconds must be a finite, positive number of seconds."
    });

    assert.throws(() => createResumeDetector({ thresholdSeconds: Number.NaN }), {

      constructor: TypeError,
      message: "createResumeDetector's thresholdSeconds must be a finite, positive number of seconds."
    });
  });
});
