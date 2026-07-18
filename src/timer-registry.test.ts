/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timer-registry.test.ts: Unit tests for TimerRegistry - keyed one-shots and intervals, anonymous tracked one-shots, replace-on-register, delete-before-callback, and the
 * lifetime-signal / dispose() drain that makes every later registration inert.
 */
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { TimerRegistry } from "./timer-registry.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

describe("TimerRegistry", () => {

  // The registry arms its timers through the global setTimeout / setInterval, so mocking those primitives lets the tests advance virtual time deterministically via
  // mock.timers.tick rather than waiting on the real clock. Enabling both primitives also mocks their clear counterparts, which the registry uses to drain.
  beforeEach(() => mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] }));
  afterEach(() => mock.timers.reset());

  test("a keyed one-shot fires exactly once, and the callback observes its own key already gone", () => {

    let fired = 0;
    let keyPresentDuringCallback = true;
    const registry = new TimerRegistry();

    registry.setTimeout("relock", (): void => {

      fired++;
      keyPresentDuringCallback = registry.has("relock");
    }, 30);

    assert.equal(registry.has("relock"), true, "the key must be armed before the due time");

    mock.timers.tick(30);

    assert.equal(fired, 1, "the one-shot must fire exactly once");
    assert.equal(registry.has("relock"), false, "the key must be gone after firing");
    assert.equal(keyPresentDuringCallback, false, "the callback must observe its own key already removed");

    mock.timers.tick(1000);

    assert.equal(fired, 1, "a one-shot must not fire again however far time advances");
  });

  test("registering under a key replaces whatever it held, across both timer kinds", () => {

    let firstFires = 0;
    let secondFires = 0;
    const registry = new TimerRegistry();

    // A second setTimeout under the key displaces the first: the first never fires, the second fires on its own schedule.
    registry.setTimeout("k", (): void => { firstFires++; }, 30);
    registry.setTimeout("k", (): void => { secondFires++; }, 50);

    mock.timers.tick(60);

    assert.equal(firstFires, 0, "the displaced one-shot must never fire");
    assert.equal(secondFires, 1, "the replacing one-shot must fire on its own schedule");

    firstFires = 0;
    secondFires = 0;

    // A setInterval under a key holding a timeout displaces the timeout.
    registry.setTimeout("k", (): void => { firstFires++; }, 30);
    registry.setInterval("k", (): void => { secondFires++; }, 50);

    mock.timers.tick(50);

    assert.equal(firstFires, 0, "the displaced timeout must never fire once an interval takes its key");
    assert.equal(secondFires, 1, "the replacing interval must fire on its own schedule");

    registry.clear("k");
    firstFires = 0;
    secondFires = 0;

    // A setTimeout under a key holding an interval displaces the interval.
    registry.setInterval("k", (): void => { firstFires++; }, 30);
    registry.setTimeout("k", (): void => { secondFires++; }, 50);

    mock.timers.tick(120);

    assert.equal(firstFires, 0, "the displaced interval must never fire once a one-shot takes its key");
    assert.equal(secondFires, 1, "the replacing one-shot must fire exactly once");
  });

  test("a keyed interval fires repeatedly, stays armed across fires, and clear() stops it", () => {

    let fired = 0;
    const registry = new TimerRegistry();

    registry.setInterval("beat", (): void => { fired++; }, 20);

    mock.timers.tick(20);

    assert.equal(fired, 1, "the interval fires on its first period");
    assert.equal(registry.has("beat"), true, "the interval stays armed after firing");

    mock.timers.tick(40);

    assert.equal(fired, 3, "the interval keeps firing every period");
    assert.equal(registry.has("beat"), true, "the interval remains armed across fires");

    registry.clear("beat");

    mock.timers.tick(100);

    assert.equal(fired, 3, "clear() stops the interval");
    assert.equal(registry.has("beat"), false, "the cleared interval is no longer armed");
  });

  test("clear() on an absent key is a no-op and leaves a live entry under a different key intact", () => {

    let fired = 0;
    const registry = new TimerRegistry();

    registry.setTimeout("present", (): void => { fired++; }, 30);

    // Clearing a key that was never armed must neither throw nor disturb an unrelated live entry.
    registry.clear("absent");

    mock.timers.tick(30);

    assert.equal(fired, 1, "the untouched key must still fire on schedule");
  });

  test("anonymous timers coexist without replacement, and scheduling from within a callback works", () => {

    let firstFires = 0;
    let secondFires = 0;
    let reentrantFires = 0;
    const registry = new TimerRegistry();

    registry.schedule((): void => { firstFires++; }, 20);
    registry.schedule((): void => {

      secondFires++;

      // Reentrant scheduling: arming a fresh anonymous timer from inside a firing callback must work and must not disturb the timer currently firing.
      registry.schedule((): void => { reentrantFires++; }, 20);
    }, 40);

    mock.timers.tick(40);

    assert.equal(firstFires, 1, "the shorter anonymous timer fires");
    assert.equal(secondFires, 1, "the longer anonymous timer also fires - neither displaced the other");

    mock.timers.tick(20);

    assert.equal(reentrantFires, 1, "a timer scheduled from within a callback fires on its own schedule");
  });

  test("dispose() drains every pending timer so none of them fire", () => {

    let fired = 0;
    const registry = new TimerRegistry();

    registry.setTimeout("one-shot", (): void => { fired++; }, 30);
    registry.setInterval("interval", (): void => { fired++; }, 30);
    registry.schedule((): void => { fired++; }, 30);

    registry.dispose();

    mock.timers.tick(1000);

    assert.equal(fired, 0, "a disposed registry must fire nothing that was pending");
  });

  test("an aborting lifetime signal drains armed timers and makes later registrations inert", () => {

    const controller = new AbortController();
    let fired = 0;
    const registry = new TimerRegistry({ signal: controller.signal });

    registry.setTimeout("one-shot", (): void => { fired++; }, 30);
    registry.setInterval("interval", (): void => { fired++; }, 30);
    registry.schedule((): void => { fired++; }, 30);

    controller.abort();

    // A registration attempted after the abort must not arm.
    registry.setTimeout("after", (): void => { fired++; }, 30);

    mock.timers.tick(1000);

    assert.equal(fired, 0, "aborting the lifetime signal must drain armed timers and block new ones");
    assert.equal(registry.has("one-shot"), false, "the drained keyed entry must be gone");
    assert.equal(registry.has("after"), false, "a registration after abort must not arm");
  });

  test("a registry built on an already-aborted signal is born disposed", () => {

    const controller = new AbortController();

    controller.abort();

    let fired = 0;
    const registry = new TimerRegistry({ signal: controller.signal });

    registry.setTimeout("k", (): void => { fired++; }, 30);

    mock.timers.tick(1000);

    assert.equal(fired, 0, "a registry born on an aborted signal must arm nothing");
    assert.equal(registry.has("k"), false, "no entry must have been armed");
  });

  test("dispose() is a no-op on repeat, leaving the registry inert", () => {

    let fired = 0;
    const registry = new TimerRegistry();

    registry.setTimeout("k", (): void => { fired++; }, 30);

    registry.dispose();
    registry.dispose();

    registry.setTimeout("again", (): void => { fired++; }, 30);

    mock.timers.tick(1000);

    assert.equal(fired, 0, "nothing must fire after disposal, and a second dispose must change nothing");
    assert.equal(registry.has("k"), false, "the drained key stays gone");
    assert.equal(registry.has("again"), false, "a registration after disposal stays inert");
  });

  test("registrations after dispose() are inert, keyed and anonymous alike", () => {

    let fired = 0;
    const registry = new TimerRegistry();

    registry.dispose();

    registry.setTimeout("k", (): void => { fired++; }, 30);
    registry.setInterval("interval", (): void => { fired++; }, 30);
    registry.schedule((): void => { fired++; }, 30);

    mock.timers.tick(1000);

    assert.equal(fired, 0, "neither a keyed nor an anonymous registration may arm after disposal");
    assert.equal(registry.has("k"), false, "the keyed one-shot registration must not have armed");
    assert.equal(registry.has("interval"), false, "the keyed interval registration must not have armed");
  });

  test("dispose() detaches the abort listener from a long-lived signal", () => {

    const controller = new AbortController();

    // Build and dispose several registries against one long-lived signal; each must remove its own abort listener, so none accumulate on the shared signal.
    for(let index = 0; index < 5; index++) {

      const registry = new TimerRegistry({ signal: controller.signal });

      registry.dispose();
    }

    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "a disposed registry must leave no abort listener behind");
  });

  test("[Symbol.dispose] behaves as dispose() and composes with using, draining timers and blocking later registrations", () => {

    let fired = 0;
    let escaped: TimerRegistry;

    {

      using registry = new TimerRegistry();

      registry.setTimeout("k", (): void => { fired++; }, 30);

      escaped = registry;
    }

    // The using block has exited, so [Symbol.dispose] has run: a registration on the now-disposed registry must be inert and the drained key must be gone.
    escaped.setTimeout("after", (): void => { fired++; }, 30);

    mock.timers.tick(1000);

    assert.equal(fired, 0, "a registry disposed by leaving its using block must drain its timer and arm nothing after");
    assert.equal(escaped.has("k"), false, "the drained key must be gone");
  });
});
