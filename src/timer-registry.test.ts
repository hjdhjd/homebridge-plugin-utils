/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timer-registry.test.ts: Unit tests for TimerRegistry - keyed one-shots and intervals, anonymous tracked one-shots, replace-on-register, delete-before-callback, the
 * anonymous handle's cancel, the inert handle a retired registry answers with, the lifetime-signal / dispose() drain that makes every later registration inert, and
 * the unref policy the registry forwards to its clock on every arm.
 */
import { describe, test } from "node:test";
import { NO_OP_DISPOSABLE } from "./util.ts";
import { TestClock } from "./clock-double.ts";
import { TimerRegistry } from "./timer-registry.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

/**
 * A {@link TestClock} that records the `init` of every `schedule` call before delegating to it, so a row reads back exactly what the registry stated to its clock on
 * each arm. Subclassing the shipped double rather than standing up a bare `Clock` literal is what keeps the recording faithful: the timers still land on the double's
 * own timeline, so the same row that reads the recorded inits can advance the clock and watch those timers come due.
 */
class RecordingClock extends TestClock {

  public readonly inits: ({ repeat?: boolean; unref?: boolean } | undefined)[] = [];

  public override schedule(callback: () => void, ms: number, init?: { repeat?: boolean; unref?: boolean }): Disposable {

    this.inits.push(init);

    return super.schedule(callback, ms, init);
  }
}

describe("TimerRegistry", () => {

  test("a keyed one-shot fires exactly once, and the callback observes its own key already gone", () => {

    let fired = 0;
    let keyPresentDuringCallback = true;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("relock", (): void => {

      fired++;
      keyPresentDuringCallback = registry.has("relock");
    }, 30);

    assert.equal(registry.has("relock"), true, "the key must be armed before the due time");

    clock.advance(30);

    assert.equal(fired, 1, "the one-shot must fire exactly once");
    assert.equal(registry.has("relock"), false, "the key must be gone after firing");
    assert.equal(keyPresentDuringCallback, false, "the callback must observe its own key already removed");

    clock.advance(1000);

    assert.equal(fired, 1, "a one-shot must not fire again however far time advances");
  });

  test("registering under a key replaces whatever it held, across both timer kinds", () => {

    let firstFires = 0;
    let secondFires = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    // A second setTimeout under the key displaces the first: the first never fires, the second fires on its own schedule.
    registry.setTimeout("k", (): void => { firstFires++; }, 30);
    registry.setTimeout("k", (): void => { secondFires++; }, 50);

    clock.advance(60);

    assert.equal(firstFires, 0, "the displaced one-shot must never fire");
    assert.equal(secondFires, 1, "the replacing one-shot must fire on its own schedule");

    firstFires = 0;
    secondFires = 0;

    // A setInterval under a key holding a timeout displaces the timeout.
    registry.setTimeout("k", (): void => { firstFires++; }, 30);
    registry.setInterval("k", (): void => { secondFires++; }, 50);

    clock.advance(50);

    assert.equal(firstFires, 0, "the displaced timeout must never fire once an interval takes its key");
    assert.equal(secondFires, 1, "the replacing interval must fire on its own schedule");

    registry.clear("k");
    firstFires = 0;
    secondFires = 0;

    // A setTimeout under a key holding an interval displaces the interval.
    registry.setInterval("k", (): void => { firstFires++; }, 30);
    registry.setTimeout("k", (): void => { secondFires++; }, 50);

    clock.advance(120);

    assert.equal(firstFires, 0, "the displaced interval must never fire once a one-shot takes its key");
    assert.equal(secondFires, 1, "the replacing one-shot must fire exactly once");
  });

  test("a keyed interval fires repeatedly, stays armed across fires, and clear() stops it", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setInterval("beat", (): void => { fired++; }, 20);

    clock.advance(20);

    assert.equal(fired, 1, "the interval fires on its first period");
    assert.equal(registry.has("beat"), true, "the interval stays armed after firing");

    clock.advance(40);

    assert.equal(fired, 3, "the interval keeps firing every period");
    assert.equal(registry.has("beat"), true, "the interval remains armed across fires");

    registry.clear("beat");

    clock.advance(100);

    assert.equal(fired, 3, "clear() stops the interval");
    assert.equal(registry.has("beat"), false, "the cleared interval is no longer armed");
  });

  test("clear() on an absent key is a no-op and leaves a live entry under a different key intact", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("present", (): void => { fired++; }, 30);

    // Clearing a key that was never armed must neither throw nor disturb an unrelated live entry.
    registry.clear("absent");

    clock.advance(30);

    assert.equal(fired, 1, "the untouched key must still fire on schedule");
  });

  test("anonymous timers coexist without replacement, and scheduling from within a callback works", () => {

    let firstFires = 0;
    let secondFires = 0;
    let reentrantFires = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.schedule((): void => { firstFires++; }, 20);
    registry.schedule((): void => {

      secondFires++;

      // Reentrant scheduling: arming a fresh anonymous timer from inside a firing callback must work and must not disturb the timer currently firing.
      registry.schedule((): void => { reentrantFires++; }, 20);
    }, 40);

    clock.advance(40);

    assert.equal(firstFires, 1, "the shorter anonymous timer fires");
    assert.equal(secondFires, 1, "the longer anonymous timer also fires - neither displaced the other");

    clock.advance(20);

    assert.equal(reentrantFires, 1, "a timer scheduled from within a callback fires on its own schedule");
  });

  test("dispose() drains every pending timer so none of them fire", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("one-shot", (): void => { fired++; }, 30);
    registry.setInterval("interval", (): void => { fired++; }, 30);
    registry.schedule((): void => { fired++; }, 30);

    registry.dispose();

    clock.advance(1000);

    assert.equal(fired, 0, "a disposed registry must fire nothing that was pending");
  });

  test("clearAll() drains every pending timer so none of them fire", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("one-shot", (): void => { fired++; }, 30);
    registry.setInterval("interval", (): void => { fired++; }, 30);
    registry.schedule((): void => { fired++; }, 30);

    registry.clearAll();

    clock.advance(1000);

    assert.equal(fired, 0, "a drained registry must fire nothing that was pending");
    assert.equal(registry.has("one-shot"), false, "the drained keyed one-shot must be gone");
    assert.equal(registry.has("interval"), false, "the drained keyed interval must be gone");
  });

  test("clearAll() leaves the registry armed, so a registration after it fires - even under the key the drain just removed", () => {

    let drained = 0;
    let rearmed = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("k", (): void => { drained++; }, 30);

    registry.clearAll();

    // This is what separates the drain from disposal: the registry stays open, so re-arming the very key the drain removed takes and fires on its own schedule.
    registry.setTimeout("k", (): void => { rearmed++; }, 30);
    registry.schedule((): void => { rearmed++; }, 30);

    assert.equal(registry.has("k"), true, "the re-armed key must be armed after the drain");

    clock.advance(30);

    assert.equal(drained, 0, "the drained timer must never fire");
    assert.equal(rearmed, 2, "both registrations made after the drain must fire");
  });

  test("clearAll() on a disposed registry neither throws nor revives it", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.dispose();

    // Draining is meaningful whatever the registry's lifetime state, and it is not a route back from disposal.
    registry.clearAll();

    registry.setTimeout("k", (): void => { fired++; }, 30);

    clock.advance(1000);

    assert.equal(fired, 0, "a drain must not revive a disposed registry");
    assert.equal(registry.has("k"), false, "a registration after disposal stays inert whether or not a drain intervened");
  });

  test("dispose() after clearAll() still retires the registry", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("k", (): void => { fired++; }, 30);

    registry.clearAll();
    registry.dispose();

    registry.setTimeout("after", (): void => { fired++; }, 30);

    clock.advance(1000);

    assert.equal(fired, 0, "nothing must fire once a drained registry has also been disposed");
    assert.equal(registry.has("after"), false, "a registration after disposal must not arm");
  });

  test("an aborting lifetime signal drains armed timers and makes later registrations inert", () => {

    const controller = new AbortController();
    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock, signal: controller.signal });

    registry.setTimeout("one-shot", (): void => { fired++; }, 30);
    registry.setInterval("interval", (): void => { fired++; }, 30);
    registry.schedule((): void => { fired++; }, 30);

    controller.abort();

    // A registration attempted after the abort must not arm.
    registry.setTimeout("after", (): void => { fired++; }, 30);

    clock.advance(1000);

    assert.equal(fired, 0, "aborting the lifetime signal must drain armed timers and block new ones");
    assert.equal(registry.has("one-shot"), false, "the drained keyed entry must be gone");
    assert.equal(registry.has("after"), false, "a registration after abort must not arm");
  });

  test("a registry built on an already-aborted signal is born disposed", () => {

    const controller = new AbortController();

    controller.abort();

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock, signal: controller.signal });

    registry.setTimeout("k", (): void => { fired++; }, 30);

    clock.advance(1000);

    assert.equal(fired, 0, "a registry born on an aborted signal must arm nothing");
    assert.equal(registry.has("k"), false, "no entry must have been armed");
  });

  test("dispose() is a no-op on repeat, leaving the registry inert", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("k", (): void => { fired++; }, 30);

    registry.dispose();
    registry.dispose();

    registry.setTimeout("again", (): void => { fired++; }, 30);

    clock.advance(1000);

    assert.equal(fired, 0, "nothing must fire after disposal, and a second dispose must change nothing");
    assert.equal(registry.has("k"), false, "the drained key stays gone");
    assert.equal(registry.has("again"), false, "a registration after disposal stays inert");
  });

  test("registrations after dispose() are inert, keyed and anonymous alike", () => {

    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.dispose();

    registry.setTimeout("k", (): void => { fired++; }, 30);
    registry.setInterval("interval", (): void => { fired++; }, 30);
    registry.schedule((): void => { fired++; }, 30);

    clock.advance(1000);

    assert.equal(fired, 0, "neither a keyed nor an anonymous registration may arm after disposal");
    assert.equal(registry.has("k"), false, "the keyed one-shot registration must not have armed");
    assert.equal(registry.has("interval"), false, "the keyed interval registration must not have armed");
  });

  test("dispose() detaches the abort listener from a long-lived signal", () => {

    const clock = new TestClock();
    const controller = new AbortController();

    // Build and dispose several registries against one long-lived signal; each must remove its own abort listener, so none accumulate on the shared signal.
    for(let index = 0; index < 5; index++) {

      const registry = new TimerRegistry({ clock, signal: controller.signal });

      registry.dispose();
    }

    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "a disposed registry must leave no abort listener behind");
  });

  test("[Symbol.dispose] behaves as dispose() and composes with using, draining timers and blocking later registrations", () => {

    const clock = new TestClock();

    let fired = 0;
    let escaped: TimerRegistry;

    {

      using registry = new TimerRegistry({ clock });

      registry.setTimeout("k", (): void => { fired++; }, 30);

      escaped = registry;
    }

    // The using block has exited, so [Symbol.dispose] has run: a registration on the now-disposed registry must be inert and the drained key must be gone.
    escaped.setTimeout("after", (): void => { fired++; }, 30);

    clock.advance(1000);

    assert.equal(fired, 0, "a registry disposed by leaving its using block must drain its timer and arm nothing after");
    assert.equal(escaped.has("k"), false, "the drained key must be gone");
  });
  test("a registry built with no clock arms the global timers", (t) => {

    // The one row that does NOT inject a clock: it proves the default path is still the platform timer a consumer's own mock-timer harness can drive. The per-test
    // enable is auto-restored when the row ends, so no later row runs under a mock left standing.
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });

    let keyed = 0;
    let interval = 0;
    let anonymous = 0;
    const registry = new TimerRegistry();

    registry.setTimeout("k", (): void => { keyed++; }, 30);
    registry.setInterval("beat", (): void => { interval++; }, 30);
    registry.schedule((): void => { anonymous++; }, 30);

    t.mock.timers.tick(30);

    assert.equal(keyed, 1, "a keyed one-shot on the default clock is a global timer");
    assert.equal(interval, 1, "as is a keyed interval");
    assert.equal(anonymous, 1, "as is an anonymous one-shot");

    registry.dispose();
  });

  test("the handle schedule() answers cancels its timer before the fire and is inert after it", () => {

    let cancelled = 0;
    let fired = 0;
    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    const doomed = registry.schedule((): void => { cancelled++; }, 30);

    doomed[Symbol.dispose]();

    clock.advance(1000);

    assert.equal(cancelled, 0, "a handle disposed before its deadline cancels the timer outright");

    const survivor = registry.schedule((): void => { fired++; }, 30);

    clock.advance(30);

    assert.equal(fired, 1, "an untouched anonymous timer still fires");

    // The timer has already fired and removed itself, so its handle has nothing left to cancel and disposing it - twice - must be quiet.
    survivor[Symbol.dispose]();
    survivor[Symbol.dispose]();

    clock.advance(1000);

    assert.equal(fired, 1, "disposing after the fire, and disposing twice, change nothing");
  });

  test("schedule() on a retired registry answers the shared inert handle", () => {

    const clock = new TestClock();
    const aborted = new AbortController();
    const disposed = new TimerRegistry({ clock });

    disposed.dispose();

    const fromDisposed = disposed.schedule((): void => { /* Never armed, so never run. */ }, 30);

    aborted.abort();

    const fromAborted = new TimerRegistry({ clock, signal: aborted.signal }).schedule((): void => { /* Never armed, so never run. */ }, 30);

    // Strict identity, not merely a disposable-shaped object: an inert registration allocates nothing and hands back the one shared no-op every such API answers with.
    assert.equal(fromDisposed, NO_OP_DISPOSABLE, "a disposed registry answers the shared inert handle");
    assert.equal(fromAborted, NO_OP_DISPOSABLE, "and so does one whose lifetime signal has aborted");
    assert.equal(clock.pending, 0, "neither inert registration armed anything on the clock");

    fromDisposed[Symbol.dispose]();
    fromAborted[Symbol.dispose]();
  });

  // Every row below asserts over the key set alone and never over a callback's effects, so the timers they arm share one callback with nothing to do.
  const noOp = (): void => { /* Nothing to do. */ };

  test("keys() on a fresh registry answers nothing", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    assert.deepEqual([...registry.keys()], [], "a registry that has armed nothing lists no keys");
  });

  test("keys() lists both keyed timer kinds, in the order they were armed", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("once", noOp, 30);
    registry.setInterval("beat", noOp, 20);

    assert.deepEqual([...registry.keys()], [ "once", "beat" ], "a one-shot and an interval list together, the earlier arming first");
  });

  test("re-arming a key moves it to the end of keys(), because the registration clears the old entry first", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("first", noOp, 30);
    registry.setTimeout("second", noOp, 30);

    assert.deepEqual([...registry.keys()], [ "first", "second" ], "the initial order is the arming order");

    registry.setInterval("first", noOp, 20);

    assert.deepEqual([...registry.keys()], [ "second", "first" ], "the re-armed key moves to the end, whichever kind replaces it");
  });

  test("a fired one-shot leaves keys(), while an interval's key survives its fires", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("once", noOp, 30);
    registry.setInterval("beat", noOp, 20);

    assert.deepEqual([...registry.keys()], [ "once", "beat" ], "both keys are armed before either is due");

    clock.advance(20);

    assert.deepEqual([...registry.keys()], [ "once", "beat" ], "the interval's first fire leaves its key armed, and the one-shot is not yet due");

    clock.advance(20);

    assert.deepEqual([...registry.keys()], ["beat"], "the one-shot removed its own key when it fired, and the interval is still listed after a second fire");
  });

  test("clear() removes exactly its own key from keys()", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("a", noOp, 30);
    registry.setTimeout("b", noOp, 30);
    registry.setTimeout("c", noOp, 30);

    assert.deepEqual([...registry.keys()], [ "a", "b", "c" ], "all three keys are armed");

    registry.clear("b");

    assert.deepEqual([...registry.keys()], [ "a", "c" ], "clearing one key leaves the rest listed, in the order they were armed");
  });

  test("clearAll() empties keys(), and a registration after it lists again", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("a", noOp, 30);
    registry.setInterval("b", noOp, 30);

    assert.deepEqual([...registry.keys()], [ "a", "b" ], "both keys are armed before the drain");

    registry.clearAll();

    assert.deepEqual([...registry.keys()], [], "the drain empties the key set");

    registry.setTimeout("c", noOp, 30);

    assert.deepEqual([...registry.keys()], ["c"], "a registration after the drain lists, because clearAll() leaves the registry armed");
  });

  test("dispose() empties keys(), and a registration after it stays absent", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.setTimeout("a", noOp, 30);
    registry.setInterval("b", noOp, 30);

    assert.deepEqual([...registry.keys()], [ "a", "b" ], "both keys are armed before disposal");

    registry.dispose();

    assert.deepEqual([...registry.keys()], [], "disposal empties the key set");

    registry.setTimeout("c", noOp, 30);

    assert.deepEqual([...registry.keys()], [], "a registration on a retired registry is inert, so no key appears for it");
  });

  test("anonymous timers never appear in keys(), which lists keyed timers alone", () => {

    const clock = new TestClock();
    const registry = new TimerRegistry({ clock });

    registry.schedule(noOp, 30);
    registry.setTimeout("keyed", noOp, 30);
    registry.schedule(noOp, 30);

    assert.deepEqual([...registry.keys()], ["keyed"], "the anonymous timers carry no key, so the keyed timer is the only entry listed");
  });

  test("keys() walks the map itself, so a caller may clear as it goes and still meets a key armed mid-walk", () => {

    const armed = [ "a", "b", "c", "d" ];
    const clock = new TestClock();
    const kept = new Set([ "b", "c" ]);
    const registry = new TimerRegistry({ clock });
    const visited: string[] = [];

    for(const key of armed) {

      registry.setTimeout(key, noOp, 30);
    }

    /* The reconciliation this member exists for: walk the registry's own keys and clear the ones an external schedule does not name. Deleting the entry the
     * iterator is standing on is well-defined, and so is arming a key mid-walk - which is what the "e" registration reads. An array snapshot, however freshly
     * taken, is fixed before "e" is armed and would never reach it, so this step is what tells the map's own iterator apart from a copy.
     */
    for(const key of registry.keys()) {

      visited.push(key);

      if(key === "b") {

        registry.setTimeout("e", noOp, 30);
      }

      if(!kept.has(key)) {

        registry.clear(key);
      }
    }

    assert.deepEqual(visited, [ "a", "b", "c", "d", "e" ], "the walk runs to completion and visits the key armed while it was running");
    assert.deepEqual([...registry.keys()], [ "b", "c" ], "exactly the keys the walk kept remain armed");
    assert.deepEqual(armed.map((key) => registry.has(key)), [ false, true, true, false ], "has() agrees with the walk for every key the registry started with");
  });

  test("every arm states the registry's process-lifetime policy to its clock, in both directions and by default", () => {

    /* Each case builds its registry against its OWN recording clock, so a clock's ledger holds exactly the arms that registry made and one comparison reads them
     * all. Every arming verb the registry offers is exercised: a keyed one-shot, a keyed interval, and an anonymous one-shot. The case that omits the option still
     * expects the key present and `false`, because the init a registry hands its clock carries the policy in both directions rather than only where it is set - a
     * clock reading an absent key could not tell "hold the process" from "the owner said nothing".
     */
    const cases: { build: (clock: RecordingClock) => TimerRegistry; expected: boolean; label: string }[] = [
      { build: (clock): TimerRegistry => new TimerRegistry({ clock, unref: true }), expected: true, label: "a registry that asked to release its process" },
      { build: (clock): TimerRegistry => new TimerRegistry({ clock, unref: false }), expected: false, label: "a registry that asked to hold its process" },
      { build: (clock): TimerRegistry => new TimerRegistry({ clock }), expected: false, label: "a registry that asked for neither" }
    ];

    for(const { build, expected, label } of cases) {

      const clock = new RecordingClock();
      const fired: string[] = [];
      const registry = build(clock);

      registry.setTimeout("once", () => fired.push("once"), 30);
      registry.setInterval("beat", () => fired.push("beat"), 20);
      registry.schedule(() => fired.push("anonymous"), 10);

      assert.deepEqual(clock.inits, [ { unref: expected }, { repeat: true, unref: expected }, { unref: expected } ],
        label + " states it on the keyed one-shot, the keyed interval, and the anonymous one-shot alike");

      // The same row proves the forward changed nothing about the schedule: every timer still comes due on its own deadline, in deadline order.
      clock.advance(30);

      assert.deepEqual(fired, [ "anonymous", "beat", "once" ], label + " armed timers that fire exactly as they would have without it");

      registry.dispose();
    }
  });
});
