/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * delivery-supervisor.test.ts: Unit tests for DeliverySupervisor, covering the windows it stands over, the slots each window answers, the deadlines those windows
 * are armed with, and the lifetime that ends them all.
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
 * order, every error the supervisor reported, and the window it named alongside each of those errors. Each row builds its own, so nothing carries between them.
 */
interface Rig<T> {

  answers: Answer<T>[];
  clock: TestClock;
  controller: AbortController;
  errors: unknown[];
  faults: DeliveryWindow<T>[];
  onSettle: (slot: string, settlement: DeliverySettlement<T>) => void;
  supervisor: DeliverySupervisor<T>;
}

// Build a rig. The clock is virtual and the lifetime is real, which is the combination that lets a row drive a deadline and a teardown in the same scenario.
function rig<T>(): Rig<T> {

  const answers: Answer<T>[] = [];
  const clock = new TestClock();
  const controller = new AbortController();
  const errors: unknown[] = [];
  const faults: DeliveryWindow<T>[] = [];

  return {

    answers,
    clock,
    controller,
    errors,
    faults,

    onSettle: (slot: string, settlement: DeliverySettlement<T>): void => {

      answers.push({ settlement, slot });
    },

    supervisor: new DeliverySupervisor<T>({ clock, onError: (error: unknown, window: DeliveryWindow<T>): void => {

      errors.push(error);
      faults.push(window);
    }, signal: controller.signal })
  };
}

// Read a window's slot by name, asserting it is there, so a row works with the handle rather than with a possibly-undefined lookup at every use.
function expectSlot<T>(window: DeliveryWindow<T>, name: string): DeliverySlot<T> {

  const slot = window.slots.get(name);

  assert.ok(slot !== undefined, "the window must carry a slot named " + name);

  return slot;
}

/* Open two windows of two slots each, recording every settlement through `onSettle` and throwing `fault` from the first window's first settlement.
 *
 * Several of the close rows below read this same shape, because it is the arrangement a close has the most to lose in: when the throw lands, one slot of its own
 * window and both slots of a sibling window are still unanswered, so a close that stops where the throw lands strands three consumers rather than one.
 *
 * @returns The first window, which is the one whose callback throws and the one every fault from this shape is reported against.
 */
function openTwoWindows(supervisor: DeliverySupervisor<string>, onSettle: (slot: string, settlement: DeliverySettlement<string>) => void,
  fault: Error): DeliveryWindow<string> {

  let calls = 0;
  const first = supervisor.open("first", {

    deadline: 100,
    onDeadline: (): void => undefined,

    onSettle: (slot: string, settlement: DeliverySettlement<string>): void => {

      onSettle(slot, settlement);

      calls++;

      if(calls === 1) {

        throw fault;
      }
    },

    slots: [ "alpha", "beta" ]
  });

  supervisor.open("second", { deadline: 100, onDeadline: (): void => undefined, onSettle, slots: [ "gamma", "delta" ] });

  return first;
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

  test("a supervisor built against an ended lifetime refuses to open, disposes twice without a throw, and leaves no listener on the signal", () => {

    /* The rig's lifetime is live at construction, so this row builds its own and ends it FIRST. A supervisor born on a dead signal takes the already-aborted
     * path through `onAbort`, which runs the sweep inline and hands back a registration with nothing to detach - the shape a consumer reaches when it constructs
     * one during its own teardown. Everything downstream of that path is asserted here: the refusal to open, a disposal that is quiet however many times it is
     * called, and a signal left carrying nothing of ours.
     */
    const clock = new TestClock();
    const controller = new AbortController();
    const reason = new Error("teardown");

    controller.abort(reason);

    const supervisor = new DeliverySupervisor<string>({ clock, onError: (): void => undefined, signal: controller.signal });

    assert.throws(() => {

      supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: (): void => undefined, slots: ["only"] });
    }, (error: unknown): boolean => error === reason, "the throw must be the signal's own reason, by identity");

    assert.doesNotThrow(() => supervisor[Symbol.dispose](), "disposing a supervisor that opened nothing answers nobody and throws nothing");
    assert.doesNotThrow(() => supervisor[Symbol.dispose](), "and a second disposal is quiet too");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "a supervisor built on a dead signal must leave no listener on it");
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
      assert.equal(scenario.faults.length, 1, "and is reported alongside exactly one window");
      assert.equal(expectAt(scenario.faults, 0, "a reported window"), window, "which is the window whose deadline callback threw, by identity");
      assert.equal(expectSlot(window, "alpha").settle("confirmed"), false, "a later settle answers that nothing happened");
      assert.equal(scenario.answers.length, 2, "and fires no second callback");
    });
  });

  test("a settle callback that throws on the last slot still disarms the deadline and retires the window", async () => {

    const scenario = rig<string>();
    const boom = new Error("the consumer's settlement handler failed");
    const rounds: number[] = [];
    let calls = 0;
    const window = scenario.supervisor.open("w", {

      deadline: 100,

      onDeadline: (): void => {

        rounds.push(1);
      },

      onSettle: (slot: string, settlement: DeliverySettlement<string>): void => {

        scenario.onSettle(slot, settlement);

        calls++;

        if(calls === 2) {

          throw boom;
        }
      },

      slots: [ "alpha", "beta" ]
    });

    assert.equal(expectSlot(window, "alpha").settle("confirmed"), true, "the first slot settles and its callback returns");

    assert.throws(() => expectSlot(window, "beta").settle("confirmed"), (error: unknown): boolean => error === boom,
      "the callback's own throw reaches the caller that settled the slot, by identity, rather than being swallowed here");

    // A throw is the path where the disarm and the retirement are easiest to lose, so both sides of the bookkeeping are read: nothing is armed, and nothing stands.
    assert.equal(scenario.clock.pending, 0, "the deadline is disarmed even though the callback threw on the way out");
    assert.deepEqual([...scenario.supervisor.windows()], [], "and the window no longer stands under its key");
    assert.equal(scenario.answers.length, 2, "both slots were answered");

    await advanceThroughSchedule(scenario.clock, [1000]);

    assert.deepEqual(rounds, [], "so no deadline ever comes due for a window that has nothing left to decide");
  });

  test("a settle callback that throws on a slot that is not the last leaves the window standing until its last slot settles", () => {

    const scenario = rig<string>();
    const boom = new Error("the consumer's settlement handler failed");
    let calls = 0;
    const window = scenario.supervisor.open("w", {

      deadline: 100,
      onDeadline: (): void => undefined,

      onSettle: (slot: string, settlement: DeliverySettlement<string>): void => {

        scenario.onSettle(slot, settlement);

        calls++;

        if(calls === 1) {

          throw boom;
        }
      },

      slots: [ "alpha", "beta" ]
    });

    assert.throws(() => expectSlot(window, "alpha").settle("confirmed"), (error: unknown): boolean => error === boom,
      "the throw reaches the caller that settled the slot");

    // The count is what decides when a window is finished, and a throw does not finish one: the second slot is still outstanding, so the deadline is still worth having.
    assert.equal(scenario.clock.pending, 1, "the deadline still stands while a slot is outstanding");
    assert.deepEqual([...scenario.supervisor.windows()].map((standing) => standing.key), ["w"], "and so does the window");

    assert.equal(expectSlot(window, "beta").settle("confirmed"), true, "the last slot settles and its callback returns");
    assert.equal(scenario.clock.pending, 0, "which clears the deadline");
    assert.deepEqual([...scenario.supervisor.windows()], [], "and retires the window");
  });

  test("a settle callback on the last slot still sees its own window standing and may open the next one under the same key", () => {

    const scenario = rig<string>();
    let reopened: DeliveryWindow<string> | undefined;
    const window = scenario.supervisor.open("w", {

      deadline: 100,
      onDeadline: (): void => undefined,

      onSettle: (slot: string, settlement: DeliverySettlement<string>): void => {

        scenario.onSettle(slot, settlement);

        /* The disarm and the retirement run after this callback, not before it, and the assertions here are what hold that ordering: a consumer settling its last
         * slot sees its own window exactly as it was, which is what makes opening the replacement below a well-defined act rather than a race with a deletion.
         */
        assert.deepEqual([...scenario.supervisor.windows()].map((standing) => standing.key), ["w"], "the window is still standing while its callback runs");
        assert.equal(scenario.clock.pending, 1, "and its deadline is still armed");

        reopened = scenario.supervisor.open("w", { deadline: 250, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: ["only"] });
      },

      slots: ["only"]
    });

    assert.equal(expectSlot(window, "only").settle("confirmed"), true, "the last slot settles");
    assert.equal(scenario.answers.length, 1, "the callback ran exactly once, so its assertions were reached");

    const standing = [...scenario.supervisor.windows()];

    assert.equal(standing.length, 1, "exactly one window stands under the key afterwards");
    assert.equal(expectAt(standing, 0, "the standing window"), reopened, "and it is the one the callback opened, by identity");
    assert.equal(scenario.clock.pending, 1, "the fresh window's deadline is the only one armed, so the retirement left the replacement alone");
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
      assert.deepEqual(scenario.faults, [], "and no window is named either");
      assert.equal(scenario.answers.length, 1, "and answers nothing a second time");
    });
  });

  test("a deadline fault answers every slot past a throwing settle callback and reports both faults with nothing left pending", async () => {

    await assertNoUnhandledRejections(async (): Promise<void> => {

      const answers: Answer<string>[] = [];
      const boom = new Error("the delivery check failed");
      const clock = new TestClock();
      const controller = new AbortController();
      const errors: unknown[] = [];
      const faulted: DeliverySettlement<string> = { kind: "yielded", reason: "faulted" };
      const faults: DeliveryWindow<string>[] = [];
      const pendingAtReport: number[] = [];
      const stumble = new Error("the consumer's settlement handler failed");
      let calls = 0;

      // The fault channel reads the window's own pending count as it is called, which is how this row tells a report issued after the close from one issued during it.
      const supervisor = new DeliverySupervisor<string>({ clock, onError: (error: unknown, window: DeliveryWindow<string>): void => {

        errors.push(error);
        faults.push(window);
        pendingAtReport.push(window.pending);
      }, signal: controller.signal });

      const window = supervisor.open("w", {

        deadline: 100,

        onDeadline: (): void => {

          throw boom;
        },

        onSettle: (slot: string, settlement: DeliverySettlement<string>): void => {

          answers.push({ settlement, slot });

          calls++;

          if(calls === 1) {

            throw stumble;
          }
        },

        slots: [ "alpha", "beta", "gamma" ]
      });

      await advanceThroughSchedule(clock, [100]);

      assert.deepEqual(answers.map((answer) => answer.slot), [ "alpha", "beta", "gamma" ], "the slots behind the throwing callback are answered rather than orphaned");
      assert.deepEqual(answers.map((answer) => answer.settlement), [ faulted, faulted, faulted ], "each of them with the reason this close carried");
      assert.deepEqual(errors, [ boom, stumble ], "the deadline's own fault is reported first and the settle callback's after it, each unchanged");
      assert.equal(faults.length, 2, "each fault is reported exactly once");
      assert.equal(expectAt(faults, 0, "the first reported window"), window, "the deadline's fault names the window whose callback threw, by identity");
      assert.equal(expectAt(faults, 1, "the second reported window"), window, "and the settle callback's fault names the same one");
      assert.deepEqual(pendingAtReport, [ 0, 0 ], "and neither report ran while a slot of that window was still waiting");
    });
  });

  test("an aborted lifetime answers every slot of every window past a throwing settle callback and reports the fault afterwards", () => {

    const scenario = rig<string>();
    const aborted: DeliverySettlement<string> = { kind: "yielded", reason: "aborted" };
    const stumble = new Error("the consumer's settlement handler failed");
    const first = openTwoWindows(scenario.supervisor, scenario.onSettle, stumble);

    scenario.controller.abort(new Error("teardown"));

    assert.deepEqual(scenario.answers.map((answer) => answer.settlement), [ aborted, aborted, aborted, aborted ],
      "the throw ends neither its own window's sweep nor the sibling window's");
    assert.deepEqual(scenario.errors, [stumble], "the settle callback's throw is reported once, unchanged");
    assert.equal(scenario.faults.length, 1, "against exactly one window");
    assert.equal(expectAt(scenario.faults, 0, "a reported window"), first, "which is the window whose callback threw, by identity");
  });

  test("invalidating answers every slot of every window past a throwing settle callback and reports the fault afterwards", () => {

    const scenario = rig<string>();
    const invalidated: DeliverySettlement<string> = { kind: "yielded", reason: "invalidated" };
    const stumble = new Error("the consumer's settlement handler failed");
    const first = openTwoWindows(scenario.supervisor, scenario.onSettle, stumble);

    scenario.supervisor.invalidate();

    assert.deepEqual(scenario.answers.map((answer) => answer.settlement), [ invalidated, invalidated, invalidated, invalidated ],
      "the throw ends neither its own window's sweep nor the sibling window's");
    assert.deepEqual(scenario.errors, [stumble], "the settle callback's throw is reported once, unchanged");
    assert.equal(scenario.faults.length, 1, "against exactly one window");
    assert.equal(expectAt(scenario.faults, 0, "a reported window"), first, "which is the window whose callback threw, by identity");
  });

  test("disposing answers every slot of every window past a throwing settle callback and reports the fault afterwards", () => {

    const scenario = rig<string>();
    const invalidated: DeliverySettlement<string> = { kind: "yielded", reason: "invalidated" };
    const stumble = new Error("the consumer's settlement handler failed");
    const first = openTwoWindows(scenario.supervisor, scenario.onSettle, stumble);

    scenario.supervisor[Symbol.dispose]();

    assert.deepEqual(scenario.answers.map((answer) => answer.settlement), [ invalidated, invalidated, invalidated, invalidated ],
      "the throw ends neither its own window's sweep nor the sibling window's");
    assert.equal(scenario.clock.pending, 0, "and no deadline outlives the disposal");
    assert.deepEqual(scenario.errors, [stumble], "the settle callback's throw is reported once, unchanged");
    assert.equal(scenario.faults.length, 1, "against exactly one window");
    assert.equal(expectAt(scenario.faults, 0, "a reported window"), first, "which is the window whose callback threw, by identity");
  });

  test("opening over a standing window answers its slots past a throwing settle callback and reports the fault against the older window", () => {

    const scenario = rig<string>();
    const stumble = new Error("the consumer's settlement handler failed");
    const superseded: DeliverySettlement<string> = { kind: "yielded", reason: "superseded" };
    let calls = 0;
    const first = scenario.supervisor.open("w", {

      deadline: 100,
      onDeadline: (): void => undefined,

      onSettle: (slot: string, settlement: DeliverySettlement<string>): void => {

        scenario.onSettle(slot, settlement);

        calls++;

        if(calls === 1) {

          throw stumble;
        }
      },

      slots: [ "alpha", "beta" ]
    });

    // The supersede runs inside this call, so a throw the close let through would land on the consumer opening the newer window and leave it holding nothing.
    const second = scenario.supervisor.open("w", { deadline: 100, onDeadline: (): void => undefined, onSettle: scenario.onSettle, slots: [ "gamma", "delta" ] });

    assert.deepEqual(scenario.answers.map((answer) => answer.settlement), [ superseded, superseded ], "both slots of the older window are answered");
    assert.equal(scenario.supervisor.get("w"), second, "the newer window is the one standing under the key");
    assert.equal(second.pending, 2, "with every slot of its own still pending");
    assert.deepEqual(scenario.errors, [stumble], "the older window's settle callback threw once, and that throw is reported once");
    assert.equal(scenario.faults.length, 1, "against exactly one window");
    assert.equal(expectAt(scenario.faults, 0, "a reported window"), first, "which is the older window, by identity, rather than the one just opened");
  });

  test("a fault channel that throws reaches the caller that closed, with every slot already answered", () => {

    const alarm = new Error("the consumer's fault channel failed");
    const answers: Answer<string>[] = [];
    const clock = new TestClock();
    const controller = new AbortController();
    const stumble = new Error("the consumer's settlement handler failed");

    /* This is the row that tells reporting after the sweep from reporting inside it. The fault channel throws on the first error it is handed, and the count below
     * reads how many slots had answered by then: a supervisor reporting mid-sweep would still have the second window's two slots waiting when this throw ended it.
     */
    const supervisor = new DeliverySupervisor<string>({ clock, onError: (): void => {

      throw alarm;
    }, signal: controller.signal });

    openTwoWindows(supervisor, (slot: string, settlement: DeliverySettlement<string>): void => {

      answers.push({ settlement, slot });
    }, stumble);

    assert.throws(() => supervisor.invalidate(), (error: unknown): boolean => error === alarm,
      "the fault channel's own throw is not caught, and reaches the caller that invalidated");
    assert.equal(answers.length, 4, "and every slot of both windows had already been answered when it did");
  });
});
