/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * delivery-supervisor.test.ts: Unit tests for DeliverySupervisor - one answer per slot however many paths reach it, the deadline that runs only for a window still
 * waiting and is cleared the moment the last slot answers, the extra round `rearm` buys, same-key supersession, named and wholesale invalidation, the abort sweep and
 * the throw on an ended lifetime, the faulted callback that answers rather than orphans, and the throw after teardown that is swallowed.
 *
 * Counting is the whole subject: almost every row asserts how MANY times a consumer was answered rather than merely that it was, because an implementation that
 * answered twice passes every presence check and fails every one of these.
 */
import type { DeliverySettlement, DeliverySlot, DeliveryWindow } from "./delivery-supervisor.ts";
import { advanceThroughSchedule, assertNoUnhandledRejections, expectAt, settle } from "./testing/index.ts";
import { describe, test } from "node:test";
import { DeliverySupervisor } from "./delivery-supervisor.ts";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

// One settlement as a row reads it: which slot was answered, and what it was answered with. Recorded in the order the supervisor delivered them.
interface Answer<T> {

  settlement: DeliverySettlement<T>;
  slot: string;
}

/* One supervisor with the clock its deadlines are armed on, the lifetime it is bound to, and the ledgers every row asserts against: each settlement in delivery
 * order, and every error the supervisor reported. Each row builds its own, so nothing carries between them.
 */
interface Rig<T> {

  answers: Answer<T>[];
  clock: TestClock;
  controller: AbortController;
  errors: unknown[];
  onSettle: (slot: string, settlement: DeliverySettlement<T>) => void;
  supervisor: DeliverySupervisor<T>;
}

// Build a rig. The clock is virtual and the lifetime is real, which is the combination that lets a row drive a deadline and a teardown in the same scenario.
function rig<T>(): Rig<T> {

  const answers: Answer<T>[] = [];
  const clock = new TestClock();
  const controller = new AbortController();
  const errors: unknown[] = [];

  return {

    answers,
    clock,
    controller,
    errors,

    onSettle: (slot: string, settlement: DeliverySettlement<T>): void => {

      answers.push({ settlement, slot });
    },

    supervisor: new DeliverySupervisor<T>({ clock, onError: (error: unknown): void => {

      errors.push(error);
    }, signal: controller.signal })
  };
}

// Read a window's slot by name, asserting it is there, so a row works with the handle rather than with a possibly-undefined lookup at every use.
function expectSlot<T>(window: DeliveryWindow<T>, name: string): DeliverySlot<T> {

  const slot = window.slots.get(name);

  assert.ok(slot !== undefined, "the window must carry a slot named " + name);

  return slot;
}

describe("DeliverySupervisor", () => {

  test("a slot settles exactly once, whether or not the consumer carries an outcome", () => {

    const bare: Rig<void> = rig();
    const bareWindow = bare.supervisor.open("bare", { deadline: 100, onDeadline: (): void => undefined, onSettle: bare.onSettle, slots: ["only"] });
    const bareSlot = expectSlot(bareWindow, "only");

    // The default outcome type is `void`, so a consumer with nothing to say settles with a bare call and no argument at all.
    assert.equal(bareSlot.settle(), true, "the first settle must take the slot");
    assert.equal(bareSlot.settle(), false, "a second settle must report that nothing happened");
    assert.equal(bareSlot.settled, true, "the slot must read as settled afterwards");
    assert.deepEqual(bare.answers, [{ settlement: { kind: "settled", outcome: undefined }, slot: "only" }], "exactly one answer, carrying no outcome");

    const typed = rig<string>();
    const typedWindow = typed.supervisor.open("typed", { deadline: 100, onDeadline: (): void => undefined, onSettle: typed.onSettle, slots: ["only"] });
    const typedSlot = expectSlot(typedWindow, "only");

    assert.equal(typedSlot.settle("confirmed"), true, "the first settle must take the slot");
    assert.equal(typedSlot.settle("unconfirmed"), false, "a second settle must not overwrite the answer already given");
    assert.deepEqual(typed.answers, [{ settlement: { kind: "settled", outcome: "confirmed" }, slot: "only" }], "exactly one answer, carrying the first outcome");
  });

  test("the deadline callback runs once when the window lapses with slots pending", async () => {

    const scenario = rig<string>();
    const rounds: number[] = [];

    scenario.supervisor.open("w", {

      deadline: 100,

      onDeadline: (window: DeliveryWindow<string>): void => {

        rounds.push(window.pending);
      },

      onSettle: scenario.onSettle,
      slots: ["only"]
    });

    await advanceThroughSchedule(scenario.clock, [100]);

    assert.deepEqual(rounds, [1], "the callback must run once, seeing the one slot still pending");

    await advanceThroughSchedule(scenario.clock, [1000]);

    assert.deepEqual(rounds, [1], "a one-shot deadline must not run a second time however far time advances");
  });

  test("a window whose slots have all settled never reaches its deadline callback", async () => {

    const scenario = rig<string>();
    const rounds: number[] = [];
    const window = scenario.supervisor.open("w", {

      deadline: 100,

      onDeadline: (): void => {

        rounds.push(1);
      },

      onSettle: scenario.onSettle,
      slots: ["only"]
    });

    expectSlot(window, "only").settle("confirmed");

    await advanceThroughSchedule(scenario.clock, [500]);

    assert.deepEqual(rounds, [], "the deadline must not speak for a window that is already answered");
  });

  test("the deadline is cleared the moment the last slot settles", async () => {

    const scenario = rig<string>();
    const rounds: number[] = [];
    const window = scenario.supervisor.open("w", {

      deadline: 100,

      onDeadline: (): void => {

        rounds.push(1);
      },

      onSettle: scenario.onSettle,
      slots: [ "alpha", "beta" ]
    });

    assert.equal(scenario.clock.pending, 1, "one deadline is armed for the window");

    expectSlot(window, "alpha").settle("confirmed");

    assert.equal(scenario.clock.pending, 1, "the deadline stands while a slot is still outstanding");
    assert.equal(window.pending, 1, "one slot remains");

    expectSlot(window, "beta").settle("confirmed");

    assert.equal(scenario.clock.pending, 0, "the last settlement clears the deadline rather than leaving it to fire as a no-op");
    assert.equal(window.settled, true, "the window reads as settled");

    await advanceThroughSchedule(scenario.clock, [1000]);

    assert.deepEqual(rounds, [], "a later advance runs nothing at all");
  });

  test("rearm buys a pending window one more round and does nothing for a settled one", async () => {

    const scenario = rig<string>();
    const rounds: number[] = [];
    const window = scenario.supervisor.open("w", {

      deadline: 100,

      onDeadline: (open: DeliveryWindow<string>): void => {

        rounds.push(open.pending);

        if(rounds.length === 1) {

          open.rearm(100);
        }
      },

      onSettle: scenario.onSettle,
      slots: ["only"]
    });

    await advanceThroughSchedule(scenario.clock, [100]);

    assert.deepEqual(rounds, [1], "the first round ran");
    assert.equal(scenario.clock.pending, 1, "the re-arm leaves exactly one deadline standing, not two");

    await advanceThroughSchedule(scenario.clock, [100]);

    assert.deepEqual(rounds, [ 1, 1 ], "the re-armed window ran a second round");
    assert.equal(scenario.clock.pending, 0, "the second round armed nothing further");

    expectSlot(window, "only").settle("unconfirmed");
    window.rearm(100);

    assert.equal(scenario.clock.pending, 0, "rearm on a settled window arms nothing");

    await advanceThroughSchedule(scenario.clock, [1000]);

    assert.deepEqual(rounds, [ 1, 1 ], "and nothing runs afterwards");
  });

  test("opening under a standing key yields the older window and leaves its handles inert", () => {

    const scenario = rig<string>();
    const first = scenario.supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["alpha"] });
    const firstSlot = expectSlot(first, "alpha");
    const second = scenario.supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["beta"] });

    assert.deepEqual(scenario.answers, [{ settlement: { kind: "yielded", reason: "superseded" }, slot: "alpha" }], "the older window's slot is yielded once");
    assert.equal(firstSlot.settle("confirmed"), false, "the superseded handle answers that nothing happened");
    assert.equal(scenario.answers.length, 1, "and fires no second callback");
    assert.equal(first.settled, true, "the older window is finished");
    assert.equal(second.settled, false, "the newer window is not");
    assert.equal(scenario.supervisor.get("w"), second, "the newer window is the one standing under the key");
    assert.equal(scenario.clock.pending, 1, "exactly one deadline stands, the newer window's");
  });

  test("an aborted lifetime answers every pending slot before the deadline callback resumes", async () => {

    const scenario = rig<string>();
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const window = scenario.supervisor.open("w", {

      deadline: 100,

      onDeadline: async (): Promise<void> => {

        await gate.promise;
      },

      onSettle: scenario.onSettle,
      slots: ["only"]
    });

    await advanceThroughSchedule(scenario.clock, [100]);

    assert.deepEqual(scenario.answers, [], "the callback is parked and has answered nothing");

    scenario.controller.abort(new Error("teardown"));

    assert.deepEqual(scenario.answers, [{ settlement: { kind: "yielded", reason: "aborted" }, slot: "only" }], "the sweep answered the slot at once");
    assert.equal(scenario.clock.pending, 0, "and the registry drained behind it");

    gate.resolve();

    await settle();

    assert.equal(expectSlot(window, "only").settle("confirmed"), false, "the resumed callback finds the slot already answered");
    assert.equal(scenario.answers.length, 1, "and fires no second callback");
    assert.deepEqual(scenario.errors, [], "an orderly teardown is not a fault");
  });

  test("opening a window on an ended lifetime throws the signal's reason", () => {

    const scenario = rig<string>();
    const reason = new Error("teardown");

    scenario.controller.abort(reason);

    assert.throws(() => {

      scenario.supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["only"] });
    }, (error: unknown): boolean => error === reason, "the throw must be the signal's own reason, by identity");

    assert.deepEqual([...scenario.supervisor.windows()], [], "and nothing was filed");
  });

  test("invalidate answers the named windows, then every window, and each slot only once", () => {

    const scenario = rig<string>();
    const first = scenario.supervisor.open("a", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["one"] });

    scenario.supervisor.open("b", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["two"] });
    scenario.supervisor.open("c", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["three"] });

    scenario.supervisor.invalidate(["a"]);

    assert.deepEqual(scenario.answers, [{ settlement: { kind: "yielded", reason: "invalidated" }, slot: "one" }], "only the named window was answered");
    assert.equal(expectSlot(first, "one").settle("confirmed"), false, "a later settle on an invalidated slot answers that nothing happened");
    assert.equal(scenario.answers.length, 1, "and fires no second callback");

    scenario.supervisor.invalidate();

    assert.deepEqual(scenario.answers.map((answer) => answer.slot), [ "one", "two", "three" ], "the wholesale sweep answered what was left");
    assert.deepEqual([...scenario.supervisor.windows()], [], "no window stands afterwards");
    assert.equal(scenario.clock.pending, 0, "and no deadline does either");
  });

  test("a throwing deadline callback answers every pending slot and reports the fault once", async () => {

    await assertNoUnhandledRejections(async (): Promise<void> => {

      const scenario = rig<string>();
      const boom = new Error("the delivery check failed");
      const window = scenario.supervisor.open("w", {

        deadline: 100,

        onDeadline: (): void => {

          throw boom;
        },

        onSettle: scenario.onSettle,
        slots: [ "alpha", "beta" ]
      });

      await advanceThroughSchedule(scenario.clock, [100]);

      assert.deepEqual(scenario.answers.map((answer) => answer.settlement), [ { kind: "yielded", reason: "faulted" }, { kind: "yielded", reason: "faulted" } ],
        "every pending slot is answered rather than orphaned");
      assert.deepEqual(scenario.errors, [boom], "the thrown value reaches onError once, unchanged");
      assert.equal(expectSlot(window, "alpha").settle("confirmed"), false, "a later settle answers that nothing happened");
      assert.equal(scenario.answers.length, 2, "and fires no second callback");
    });
  });

  test("windows enumerates the standing windows and drops each one as it settles", () => {

    const scenario = rig<string>();
    const first = scenario.supervisor.open("a", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: [ "alpha", "beta" ] });

    scenario.supervisor.open("b", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["only"] });

    assert.deepEqual([...scenario.supervisor.windows()].map((window) => window.key), [ "a", "b" ], "both windows stand");

    expectSlot(first, "alpha").settle("confirmed");

    assert.deepEqual([...scenario.supervisor.windows()].map((window) => window.key), [ "a", "b" ], "a partly-answered window still stands");

    expectSlot(first, "beta").settle("confirmed");

    assert.deepEqual([...scenario.supervisor.windows()].map((window) => window.key), ["b"], "a settled window is no longer standing");
    assert.equal(scenario.supervisor.has("a"), false, "and does not answer to has()");
    assert.equal(scenario.supervisor.get("a"), undefined, "nor to get()");
    assert.equal(scenario.supervisor.has("b"), true, "while the window still open does");
  });

  test("every deadline is armed on the injected clock and none on the platform timers", async () => {

    await assertNoUnhandledRejections(async (): Promise<void> => {

      const scenario = rig<string>();
      const timersBefore = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

      scenario.supervisor.open("w", { deadline: 250, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["only"] });

      const timersAfter = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

      assert.deepEqual(scenario.clock.requested, [250], "the window's deadline was asked of the injected clock");
      assert.equal(scenario.clock.pending, 1, "and stands on it");
      assert.equal(timersAfter, timersBefore, "no platform timer was armed alongside it");

      await advanceThroughSchedule(scenario.clock, [250]);
    });
  });

  test("a slot list that is empty, or that names a slot twice, is refused as a caller defect", () => {

    const scenario = rig<string>();

    assert.throws(() => {

      scenario.supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: [] });
    }, (error: unknown): boolean => (error instanceof TypeError) && error.message.includes("at least one slot"), "an empty slot list names its own defect");

    assert.throws(() => {

      scenario.supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: [ "alpha", "alpha" ] });
    }, (error: unknown): boolean => (error instanceof TypeError) && error.message.includes("unique"), "a duplicate slot name names its own defect");

    assert.deepEqual([...scenario.supervisor.windows()], [], "neither refusal filed a window");
    assert.equal(scenario.clock.pending, 0, "nor armed a deadline");
  });

  test("disposing answers every pending slot, retires the deadlines, and does nothing on repeat", () => {

    const scenario = rig<string>();

    scenario.supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: [ "alpha", "beta" ] });
    scenario.supervisor[Symbol.dispose]();

    assert.deepEqual(scenario.answers.map((answer) => answer.settlement), [ { kind: "yielded", reason: "invalidated" }, { kind: "yielded", reason: "invalidated" } ],
      "every pending slot is answered");
    assert.equal(scenario.clock.pending, 0, "and no deadline outlives the disposal");
    assert.deepEqual([...scenario.supervisor.windows()], [], "no window stands afterwards");

    scenario.supervisor[Symbol.dispose]();

    assert.equal(scenario.answers.length, 2, "a second disposal answers nothing further");
    assert.equal(scenario.clock.pending, 0, "and arms nothing");
  });

  test("disposing detaches the abort listener from a long-lived signal", () => {

    const clock = new TestClock();
    const controller = new AbortController();

    // Build and dispose several supervisors against one long-lived signal; each must remove its own abort listener, so none accumulate on the shared signal.
    for(let index = 0; index < 5; index++) {

      const supervisor = new DeliverySupervisor<string>({ clock, onError: (): void => undefined, signal: controller.signal });

      supervisor[Symbol.dispose]();
    }

    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "a disposed supervisor must leave no abort listener behind");
  });

  test("a deadline callback that throws after the lifetime ended is swallowed rather than reported", async () => {

    await assertNoUnhandledRejections(async (): Promise<void> => {

      const scenario = rig<string>();
      const gate: PromiseWithResolvers<void> = Promise.withResolvers();

      scenario.supervisor.open("w", {

        deadline: 100,

        onDeadline: async (): Promise<void> => {

          await gate.promise;

          throw new Error("the client unwound through teardown");
        },

        onSettle: scenario.onSettle,
        slots: ["only"]
      });

      await advanceThroughSchedule(scenario.clock, [100]);

      scenario.controller.abort(new Error("teardown"));

      assert.deepEqual(expectAt(scenario.answers, 0).settlement, { kind: "yielded", reason: "aborted" }, "the sweep already answered the slot");

      gate.resolve();

      await settle();

      assert.deepEqual(scenario.errors, [], "the throw is the callback unwinding through a teardown we initiated, so it is not reported");
      assert.equal(scenario.answers.length, 1, "and answers nothing a second time");
    });
  });
});
