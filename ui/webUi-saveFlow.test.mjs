/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-saveFlow.test.mjs: The specification suite for the shared save flow - the check under the card's newest-wins rule, the one write, the commit's result
 * passed through, the busy refusal, the Save control disabled for the span of a write, and the delivery decision. It runs with no DOM: the card is the real
 * action guard behind a starter whose presented() reads a flag the test holds, the commit is a double whose settlement the test controls, the toast records
 * what it was asked to raise, and the Save control is a double that records every write to its disabled flag.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createActionGuard } from "./webUi-liveness.mjs";
import { createSaveFlow } from "./webUi-saveFlow.mjs";
import { setImmediate as flushImmediate } from "node:timers/promises";

// The platform entry the commit double hands every composer, standing in for the page's live configuration.
const PLATFORM = Object.freeze({ controllers: [], platform: "TestPlugin" });

// Drain the microtask queue so a press's continuation has run before an assertion reads what it did.
const flush = async () => {

  for(let i = 0; i < 3; i++) {

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
};

/* The card a flow serves: the real action guard, behind a starter whose presented() reads only the `shown` flag the test holds and never the signal, so the
 * flow's own read of the signal is what a row measures. `actions` records every answer the starter gave, in order, which is how a row counts the starter's calls
 * and holds the flow to the very object the starter returned. `signal` is the guard's parent lifetime.
 */
const makeCard = ({ signal = undefined } = {}) => {

  const guard = createActionGuard({ signal });
  const card = {

    actions: [],
    guard,
    shown: true,
    start: () => {

      const action = { presented: () => card.shown, signal: guard.start() };

      card.actions.push(action);

      return action;
    }
  };

  return card;
};

/* The page's commit, as a double that records each call, runs the composer it is handed against PLATFORM, and settles when the test says so. An `answer`
 * settles every call with it at once; without one, each call is held until the row resolves or rejects it through the call's own record.
 */
const makeCommit = ({ answer = undefined } = {}) => {

  const calls = [];

  const commit = async (compose, options) => {

    const call = { options, ...Promise.withResolvers() };

    calls.push(call);
    call.patch = compose(PLATFORM);

    return answer ?? call.promise;
  };

  return { calls, commit };
};

// The host's toast, recording each call as the channel it reached and the text it carried.
const makeToast = () => {

  const raised = [];
  const record = (channel) => (text) => raised.push({ channel, text });

  return { raised, toast: { error: record("error"), info: record("info"), success: record("success"), warning: record("warning") } };
};

/* The card's Save control, as a double that records every value written to its `disabled` flag, in order. A row that sets `readFailure` or `writeFailure` makes
 * each read or each write of the flag throw that error until the row clears it, which is how a row holds the flow to a control that throws.
 */
const makeControl = ({ disabled = false } = {}) => {

  let state = disabled;

  const control = {

    get disabled() {

      if(control.readFailure) {

        throw control.readFailure;
      }

      return state;
    },
    set disabled(value) {

      if(control.writeFailure) {

        throw control.writeFailure;
      }

      control.writes.push(value);
      state = value;
    },
    readFailure: undefined,
    writeFailure: undefined,
    writes: []
  };

  return control;
};

// One card, its commit, its toast, and the flow over all of them. `hold` leaves every commit call open for the row to settle; otherwise each answers `answer`.
// `control` is the card's Save control, null unless the row hands the flow a double.
const makeRig = ({ answer = { kind: "committed" }, control = null, hold = false, signal = undefined } = {}) => {

  const card = makeCard({ signal });
  const commit = makeCommit({ answer: hold ? undefined : answer });
  const toast = makeToast();
  const flow = createSaveFlow({ commit: commit.commit, control, start: card.start, toast: toast.toast });

  return { card, commit, flow, toast };
};

// A composer that appends the checked value to the controllers it reads, which makes the patch a commit received name the press that composed it.
const compose = (platform, value) => ({ controllers: [ ...platform.controllers, value ] });

// A check that passes the given value at once.
const passing = (value) => async () => ({ kind: "passed", value });

// A check held open until the row settles it through `gate`, which is how every window "while the check runs" is opened. `contexts` records what each call received.
const heldCheck = () => {

  const contexts = [];
  const gate = Promise.withResolvers();

  return {

    check: async (context) => {

      contexts.push(context);

      return gate.promise;
    },
    contexts,
    gate
  };
};

describe("createSaveFlow - a press that writes", () => {

  test("a passed check writes once with the checked value handed to the composer beside the platform, and the result carries committed, the value, and the context",
    async () => {

      const { card, commit, flow } = makeRig();
      const composed = [];
      const value = { address: "10.0.0.9" };

      const result = await flow.save({

        check: passing(value),
        compose: (platform, checked) => {

          composed.push({ checked, platform });

          return compose(platform, checked);
        }
      });

      assert.equal(commit.calls.length, 1, "a passed check writes exactly once");
      assert.equal(composed.length, 1, "and the composer runs exactly once, inside that write");
      assert.equal(composed[0].platform, PLATFORM, "the composer reads the platform entry the commit hands it");
      assert.equal(composed[0].checked, value, "beside the value the check passed");
      assert.deepEqual(commit.calls[0].patch, { controllers: [value] }, "and what it composes is what the commit writes");
      assert.equal(result.kind, "committed");
      assert.equal(result.value, value, "the result carries the checked value");
      assert.equal(result.action, card.actions[0], "and the press's action");
      assert.equal(typeof result.deliver, "function", "and the press's delivery decision");
      assert.equal(result.presented(), true, "and its presented(), which still answers true for a press nothing retired");
    });

  test("each commit result passes through with its error where it has one: staged, failed, unchanged", async () => {

    const answers = [

      { error: new Error("The save failed."), kind: "staged" },
      { error: new Error("The host refused the write."), kind: "failed" },
      { kind: "unchanged" }
    ];
    const results = await Promise.all(answers.map((answer) => makeRig({ answer }).flow.save({ check: passing(7), compose })));

    for(const [ index, result ] of results.entries()) {

      const { action, deliver, presented, ...rest } = result;

      assert.deepEqual(rest, { ...answers[index], value: 7 }, "the commit's own result, with its error where it has one, and the checked value beside it");
      assert.equal(typeof action?.presented, "function", "carrying the press's action");
      assert.equal(typeof deliver, "function", "and its delivery decision");
      assert.equal(typeof presented, "function", "and its presented()");
    }
  });

  test("a result's action is the very object the starter returned, and the check receives the same object", async () => {

    const { card, flow } = makeRig();
    const held = heldCheck();
    const press = flow.save({ check: held.check, compose });

    held.gate.resolve({ kind: "passed", value: 1 });

    const result = await press;

    assert.equal(card.actions.length, 1, "the press began one action");
    assert.equal(held.contexts[0].action, card.actions[0], "the check receives the starter's answer itself");
    assert.equal(held.contexts[0].signal, card.actions[0].signal, "and the signal that answer carries");
    assert.equal(result.action, card.actions[0], "and the result hands back the same object, whatever else the card put on it");
  });

  test("rename reaches commit's options, and is undefined there when the press gives none", async () => {

    const { commit, flow } = makeRig();
    const rename = { from: "10.0.0.1", to: "10.0.0.2" };

    await flow.save({ check: passing(1), compose, rename });
    await flow.save({ check: passing(2), compose });

    assert.equal(commit.calls[0].options.rename, rename, "the rename travels to the commit exactly as the press gave it");
    assert.deepEqual(commit.calls[1].options, { rename: undefined }, "and a press without one hands the commit an absent rename");
  });
});

describe("createSaveFlow - a press that writes nothing", () => {

  test("a declined check writes nothing and carries its reason, action, deliver and presented", async () => {

    const { card, commit, flow } = makeRig();
    const reason = "The controller did not answer.";
    const result = await flow.save({ check: async () => ({ kind: "declined", reason }), compose });
    const { action, deliver, presented, ...rest } = result;

    assert.equal(commit.calls.length, 0, "a declined check writes nothing");
    assert.deepEqual(rest, { kind: "declined", reason }, "and answers its own reason");
    assert.equal(action, card.actions[0], "with the press's action");
    assert.equal(typeof deliver, "function", "and its delivery decision");
    assert.equal(presented(), true, "and its presented()");
  });

  test("a starter answer whose presented is not a function, and one whose signal is not an AbortSignal, each reject the press with the TypeError and run no check",
    async () => {

      const live = () => new AbortController().signal;
      const answers = [ { presented: true, signal: live() }, { presented: () => true, signal: { aborted: false } }, undefined ];

      for(const answer of answers) {

        const commit = makeCommit({ answer: { kind: "committed" } });
        const flow = createSaveFlow({ commit: commit.commit, control: null, start: () => answer, toast: makeToast().toast });
        let checked = 0;

        // The check settles at once and counts its calls, so a press that skipped the shape test fails on the count rather than waiting on a check.
        const check = async () => {

          checked += 1;

          return { kind: "passed", value: 1 };
        };

        // Each answer is its own press against its own flow, and each must settle before the next is read.
        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(flow.save({ check, compose }), (error) => (error instanceof TypeError) && error.message.includes("start must answer"),
          "a starter that answers the wrong shape is a bug in the card, refused before the check runs");

        assert.equal(checked, 0, "the check never ran");
        assert.equal(commit.calls.length, 0, "and nothing was written");
      }
    });

  test("a check answering null, and one answering a mistyped kind, reject the press with the TypeError and write nothing", async () => {

    for(const answer of [ null, { kind: "pass", value: 1 } ]) {

      const { commit, flow } = makeRig();

      // Each answer is its own press against its own flow, and each must settle before the next is read.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(flow.save({ check: async () => answer, compose }), (error) => (error instanceof TypeError) && error.message.includes("check must answer"),
        "only a passed check writes, and any other answer is a bug in the check");

      assert.equal(commit.calls.length, 0, "and nothing was written");
    }
  });

  test("a second press during the first's check retires the first: the first resolves superseded, commit runs once, and it runs for the second", async () => {

    const { commit, flow } = makeRig();
    const held = heldCheck();
    const first = flow.save({ check: held.check, compose });
    const second = flow.save({ check: passing("second"), compose });

    held.gate.resolve({ kind: "passed", value: "first" });

    assert.deepEqual(await first, { kind: "superseded" }, "the press the second one retired answers that it lost the card");
    assert.equal((await second).kind, "committed", "and the second press wrote");
    assert.equal(commit.calls.length, 1, "the commit ran once");
    assert.deepEqual(commit.calls[0].patch, { controllers: ["second"] }, "and it ran for the second press");
  });

  test("a cancel of the card's guard during the check resolves superseded and writes nothing", async () => {

    const { card, commit, flow } = makeRig();
    const held = heldCheck();
    const press = flow.save({ check: held.check, compose });

    card.guard.cancel();
    held.gate.resolve({ kind: "passed", value: 1 });

    assert.deepEqual(await press, { kind: "superseded" }, "a card that retired the press while it checked owns the card");
    assert.equal(commit.calls.length, 0, "and nothing was written");
  });

  test("a press retired during its check resolves superseded even when the check declines, so its refusal is never handed to the card", async () => {

    const { card, flow } = makeRig();
    const held = heldCheck();
    const press = flow.save({ check: held.check, compose });

    card.guard.cancel();
    held.gate.resolve({ kind: "declined", reason: "The address is not reachable." });

    assert.deepEqual(await press, { kind: "superseded" }, "the abort read comes before the declined branch, so a retired press carries no reason to deliver");
  });

  test("a check that rejects after its signal aborted resolves superseded; a check that rejects while current rejects the press", async () => {

    const retired = makeRig();
    const held = heldCheck();
    const press = retired.flow.save({ check: held.check, compose });

    retired.card.guard.cancel();
    held.gate.reject(new Error("The probe was abandoned."));

    assert.deepEqual(await press, { kind: "superseded" }, "a retired press's failure answers for input the user has moved past");

    const current = makeRig();
    const failure = new Error("The probe failed.");

    await assert.rejects(current.flow.save({ check: async () => { throw failure; }, compose }), (error) => error === failure,
      "a current press's failing check is a bug the caller hears about, carrying the check's own error");

    assert.equal(current.commit.calls.length, 0, "and nothing was written");
  });

  test("a starter whose signal is already aborted resolves superseded without calling the check", async () => {

    const { commit, flow } = makeRig({ signal: AbortSignal.abort() });
    let checked = 0;
    const result = await flow.save({

      check: async () => {

        checked += 1;

        return { kind: "passed", value: 1 };
      },
      compose
    });

    assert.deepEqual(result, { kind: "superseded" }, "a card whose lifetime has ended begins every action retired");
    assert.equal(checked, 0, "so the check never runs");
    assert.equal(commit.calls.length, 0, "and nothing is written");
  });

  test("a check that calls the card's starter itself resolves superseded, and commit is never called", async () => {

    const { card, commit, flow } = makeRig();
    const result = await flow.save({

      check: async () => {

        card.start();

        return { kind: "passed", value: 1 };
      },
      compose
    });

    assert.deepEqual(result, { kind: "superseded" }, "beginning another action on the card retires the press the check belongs to");
    assert.equal(commit.calls.length, 0, "so the commit is never called");
  });

  test("a non-function check or compose rejects with the TypeError and calls start not at all", async () => {

    for(const request of [ { check: undefined, compose }, { check: passing(1), compose: "compose" } ]) {

      const { card, flow } = makeRig();

      // Each request is its own press against its own flow, and each must settle before the next is read.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(flow.save(request), (error) => (error instanceof TypeError) && error.message.includes("requires a check function"),
        "a malformed call is refused before anything else");

      assert.equal(card.actions.length, 0, "and the starter was never called");
    }
  });
});

describe("createSaveFlow - a press during a write", () => {

  test("a press arriving at any microtask after a check passes starts no second write while the first write is held", async () => {

    /* The press that passed its check reaches its write with no await between the abort read and the commit call, so there is no turn in which a later press
     * finds neither a retired predecessor nor a write in flight. Each round lands the later press one microtask further past the check's settlement, which walks
     * it across the whole span where an await before the write would open that window.
     */
    for(let ticks = 0; ticks < 12; ticks++) {

      const { commit, flow } = makeRig({ hold: true });
      const held = heldCheck();
      const first = flow.save({ check: held.check, compose });

      held.gate.resolve({ kind: "passed", value: "first" });

      for(let tick = 0; tick < ticks; tick++) {

        // Each yield is one microtask, and the round's whole purpose is to place the later press after exactly this many.
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }

      const second = flow.save({ check: passing("second"), compose });

      // The round's presses must settle before the next round's flow is built.
      // eslint-disable-next-line no-await-in-loop
      await flush();

      assert.ok(commit.calls.length <= 1, "a later press never opens a second write while the first is held");

      for(const call of commit.calls) {

        call.resolve({ kind: "committed" });
      }

      // eslint-disable-next-line no-await-in-loop
      await Promise.all([ first, second ]);
    }
  });

  test("a press during a held write resolves busy, calls none of start, check and compose, and leaves the first press's signal unaborted", async () => {

    const { card, commit, flow } = makeRig({ hold: true });
    const first = flow.save({ check: passing(1), compose });

    await flush();

    assert.equal(commit.calls.length, 1, "precondition: the first press's write is in flight");

    const counts = { check: 0, compose: 0 };
    const counting = {

      check: async () => {

        counts.check += 1;

        return { kind: "passed", value: 2 };
      },
      compose: (platform, value) => {

        counts.compose += 1;

        return compose(platform, value);
      }
    };

    // Each busy press is read only after what it did is asserted, so a press that wrongly starts a second write fails its assertions instead of waiting on a
    // commit this row never settles.
    const busy = flow.save(counting);

    await flush();

    assert.equal(card.actions.length, 1, "a press during a write never calls the starter");
    assert.deepEqual(counts, { check: 0, compose: 0 }, "and neither its check nor its composer runs");
    assert.equal(card.actions[0].signal.aborted, false, "so the write in flight keeps its presentation");
    assert.deepEqual(await busy, { kind: "busy" }, "and the press is answered rather than queued");

    const further = flow.save(counting);

    await flush();

    assert.equal(commit.calls.length, 1, "a further press during the same write starts nothing as well, and the commit has still been called once");
    assert.deepEqual(await further, { kind: "busy" }, "so it is busy too");

    commit.calls[0].resolve({ kind: "committed" });

    assert.equal((await first).kind, "committed", "the write in flight answers its own result");
  });

  test("after the held write settles, a new press reaches commit", async () => {

    const { commit, flow } = makeRig({ hold: true });
    const first = flow.save({ check: passing(1), compose });

    await flush();

    commit.calls[0].resolve({ kind: "committed" });

    await first;

    const second = flow.save({ check: passing(2), compose });

    await flush();

    assert.equal(commit.calls.length, 2, "the settled write released the flow");

    commit.calls[1].resolve({ kind: "committed" });

    assert.equal((await second).kind, "committed");
  });

  test("a commit that rejects rejects the press with the same error, and the next press reaches commit", async () => {

    const { commit, flow } = makeRig({ hold: true });
    const failure = new TypeError("commitConfig requires a composer function.");
    const first = flow.save({ check: passing(1), compose });

    await flush();

    commit.calls[0].reject(failure);

    await assert.rejects(first, (error) => error === failure, "the commit's rejection is the caller's to hear");

    const second = flow.save({ check: passing(2), compose });

    await flush();

    assert.equal(commit.calls.length, 2, "and the in-flight flag was cleared on the way out");

    commit.calls[1].resolve({ kind: "committed" });

    assert.equal((await second).kind, "committed");
  });

  test("a composer that throws inside the commit rejects the press with what it threw, and the next press reaches commit", async () => {

    const { commit, flow } = makeRig();
    const bug = new TypeError("Cannot read properties of undefined.");

    await assert.rejects(flow.save({ check: passing(1), compose: () => { throw bug; } }), (error) => error === bug, "a bug in the card's composer travels to the card");

    const result = await flow.save({ check: passing(2), compose });

    assert.equal(commit.calls.length, 2, "the next press reached the commit");
    assert.equal(result.kind, "committed");
  });

  test("a cancel of the card's guard during a held write does not change the result's kind, and deliver then toasts", async () => {

    const { card, commit, flow, toast } = makeRig({ hold: true });
    const painted = [];
    const press = flow.save({ check: passing(1), compose });

    await flush();

    card.guard.cancel();
    commit.calls[0].resolve({ error: new Error("The host refused the write."), kind: "failed" });

    const result = await press;

    assert.equal(result.kind, "failed", "a press retired during its write answers the commit's own result, not superseded");

    result.deliver({ channel: "error", paint: () => painted.push(true), text: "The host refused the write." });

    assert.deepEqual(painted, [], "the retired press is not presented, so nothing paints");
    assert.deepEqual(toast.raised, [{ channel: "error", text: "The host refused the write." }], "and the outcome the user is owed arrives by toast");
  });

  test("flows do not share the in-flight phase: a write on one card's flow refuses no press on another card's", async () => {

    const commit = makeCommit();
    const { toast } = makeToast();
    const [ one, two ] = [ makeCard(), makeCard() ].map((card) => createSaveFlow({ commit: commit.commit, control: null, start: card.start, toast }));
    const first = one.save({ check: passing(1), compose });

    await flush();

    const second = two.save({ check: passing(2), compose });

    await flush();

    assert.equal(commit.calls.length, 2, "a write in flight on one card's flow refuses nothing on another card's");

    commit.calls[0].resolve({ kind: "committed" });
    commit.calls[1].resolve({ kind: "committed" });

    assert.equal((await first).kind, "committed");
    assert.equal((await second).kind, "committed");
  });
});

describe("createSaveFlow - the Save control", () => {

  test("a write disables the control before the commit is called and restores it after the commit settles, each exactly once and in that order", async () => {

    const control = makeControl();
    const { commit, flow } = makeRig({ control, hold: true });
    const atCommit = [];
    const press = flow.save({

      check: passing(1),
      compose: (platform, value) => {

        // The commit double runs the composer in the same turn it is called, so this read is the control as the commit found it.
        atCommit.push([...control.writes]);

        return compose(platform, value);
      }
    });

    await flush();

    assert.deepEqual(atCommit, [[true]], "the control was disabled, once, before the commit was called");
    assert.deepEqual(control.writes, [true], "and nothing restores it while the write is held");
    assert.equal(control.disabled, true, "so it stays disabled for the span of the write");

    commit.calls[0].resolve({ kind: "committed" });

    assert.equal((await press).kind, "committed");
    assert.deepEqual(control.writes, [ true, false ], "the settled write restored it once, after the disable, to the state the press found");
  });

  test("a commit that rejects still restores the control, and the press rejects with the same error", async () => {

    const control = makeControl();
    const { commit, flow } = makeRig({ control, hold: true });
    const failure = new TypeError("commitConfig requires a composer function.");
    const press = flow.save({ check: passing(1), compose });

    await flush();

    assert.equal(control.disabled, true, "precondition: the write is in flight with the control disabled");

    commit.calls[0].reject(failure);

    await assert.rejects(press, (error) => error === failure, "the commit's rejection is the caller's to hear");

    assert.deepEqual(control.writes, [ true, false ], "and the control was restored on the way out");
  });

  test("a control the card had disabled before the write is still disabled after it", async () => {

    const control = makeControl({ disabled: true });
    const { flow } = makeRig({ control });

    assert.equal((await flow.save({ check: passing(1), compose })).kind, "committed");
    assert.deepEqual(control.writes, [ true, true ], "the restore writes back the state the press found rather than enabling the control");
    assert.equal(control.disabled, true, "so the card's own reason for disabling it still holds");
  });

  test("a busy press, a superseded press and a declined check write the control not at all, and the control is not disabled while a check is held", async () => {

    const checking = makeControl();
    const checkingRig = makeRig({ control: checking });
    const held = heldCheck();
    const pending = checkingRig.flow.save({ check: held.check, compose });

    await flush();

    assert.equal(checking.disabled, false, "a press whose check is held leaves the control pressable, so a newer press can retire the check");
    assert.deepEqual(checking.writes, [], "and writes it not at all");

    checkingRig.card.guard.cancel();
    held.gate.resolve({ kind: "passed", value: 1 });

    assert.deepEqual(await pending, { kind: "superseded" }, "precondition: the press was retired during its check");
    assert.deepEqual(checking.writes, [], "a superseded press writes the control not at all");

    const declining = makeControl();
    const decliningRig = makeRig({ control: declining });
    const declined = await decliningRig.flow.save({ check: async () => ({ kind: "declined", reason: "The address is not reachable." }), compose });

    assert.equal(declined.kind, "declined", "precondition: the check refused");
    assert.deepEqual(declining.writes, [], "a declined check writes the control not at all");

    const busy = makeControl();
    const busyRig = makeRig({ control: busy, hold: true });
    const first = busyRig.flow.save({ check: passing(1), compose });

    await flush();

    assert.deepEqual(busy.writes, [true], "precondition: the first press's write disabled the control");
    assert.deepEqual(await busyRig.flow.save({ check: passing(2), compose }), { kind: "busy" }, "precondition: the second press arrived during the write");
    assert.deepEqual(busy.writes, [true], "a busy press writes the control not at all");

    busyRig.commit.calls[0].resolve({ kind: "committed" });

    await first;

    assert.deepEqual(busy.writes, [ true, false ], "and only the write that disabled the control restores it");
  });

  test("a control whose disabled setter throws rejects the press with that error, and the next press reaches the commit rather than answering busy", async () => {

    const control = makeControl();
    const { commit, flow } = makeRig({ control });
    const failure = new Error("The control refused the write.");

    control.writeFailure = failure;

    await assert.rejects(flow.save({ check: passing(1), compose }), (error) => error === failure, "the control's own error is the caller's to hear");

    assert.equal(commit.calls.length, 0, "and the press stopped before its commit");

    control.writeFailure = undefined;

    assert.equal((await flow.save({ check: passing(2), compose })).kind, "committed", "the next press reached the commit, so the in-flight flag was cleared");
    assert.equal(commit.calls.length, 1, "and the commit ran once, for that press");
    assert.deepEqual(control.writes, [ true, false ], "and that press disabled and restored the control");
  });

  test("a control whose disabled flag throws when read rejects the press with that error, restores nothing, and the next press reaches the commit", async () => {

    const control = makeControl();
    const { commit, flow } = makeRig({ control });
    const failure = new Error("The control could not be read.");

    control.readFailure = failure;

    await assert.rejects(flow.save({ check: passing(1), compose }), (error) => error === failure, "the control's own error is the caller's to hear");

    assert.equal(commit.calls.length, 0, "and the press stopped before its commit");
    assert.deepEqual(control.writes, [], "a press that never read the control's state writes nothing back to it");

    control.readFailure = undefined;

    assert.equal((await flow.save({ check: passing(2), compose })).kind, "committed", "the next press reached the commit, so the in-flight flag was cleared");
  });

  test("a flow built with no control, a non-object, or an object whose disabled is not a boolean throws the TypeError at construction; null and a control do not",
    () => {

      const { commit } = makeCommit();
      const { start } = makeCard();
      const { toast } = makeToast();

      for(const options of [ {}, { control: "save" }, { control: {} }, { control: { disabled: "true" } } ]) {

        assert.throws(() => createSaveFlow({ commit, start, toast, ...options }), (error) => (error instanceof TypeError) && error.message.includes("requires a control"),
          "a card names its Save control or states that it has none");
      }

      assert.equal(typeof createSaveFlow({ commit, control: null, start, toast }).save, "function", "null states that the card has no Save control");
      assert.equal(typeof createSaveFlow({ commit, control: makeControl(), start, toast }).save, "function", "and an object with a boolean disabled flag is a control");
    });
});

describe("createSaveFlow - the delivery decision", () => {

  test("deliver paints and does not toast while the press is presented", async () => {

    const { flow, toast } = makeRig();
    const painted = [];
    const result = await flow.save({ check: passing(1), compose });

    result.deliver({ channel: "success", paint: () => painted.push("saved"), text: "The controller was saved." });

    assert.deepEqual(painted, ["saved"], "a presented press lands its outcome on the card");
    assert.deepEqual(toast.raised, [], "and raises no toast beside it");
  });

  test("a delivery made while the write is in flight toasts once the card retires the press, because the write has started", async () => {

    const { card, commit, flow, toast } = makeRig({ hold: true });
    const captured = [];
    const painted = [];
    const press = flow.save({

      check: async ({ deliver }) => {

        captured.push(deliver);

        return { kind: "passed", value: 1 };
      },
      compose
    });

    await flush();

    assert.equal(commit.calls.length, 1, "precondition: the write is in flight");

    card.guard.cancel();
    captured[0]({ channel: "error", paint: () => painted.push(true), text: "The host refused the write." });

    assert.deepEqual(painted, [], "the retired press is not presented, so nothing paints");
    assert.deepEqual(toast.raised, [{ channel: "error", text: "The host refused the write." }], "and the press reached its write, so the outcome is owed by toast");

    commit.calls[0].resolve({ kind: "committed" });

    await press;
  });

  test("deliver toasts on the named channel and does not paint when the card's presented answers false with the signal live, before the write and after it",
    async () => {

      const { card, flow, toast } = makeRig();
      const painted = [];
      const result = await flow.save({

        check: async ({ deliver }) => {

          card.shown = false;
          deliver({ channel: "warning", paint: () => painted.push("check"), text: "The address answered slowly." });

          return { kind: "passed", value: 1 };
        },
        compose
      });

      assert.equal(result.kind, "committed", "precondition: the press was never retired, only moved off the card");

      result.deliver({ channel: "info", paint: () => painted.push("result"), text: "This controller is already saved." });

      assert.deepEqual(painted, [], "a card that does not show the press paints nothing");
      assert.deepEqual(toast.raised, [ { channel: "warning", text: "The address answered slowly." }, { channel: "info", text: "This controller is already saved." } ],
        "and each outcome reaches the toast channel it named, from the check and from the result alike");
    });

  test("deliver reads presented at the call, not at the press", async () => {

    const { card, flow, toast } = makeRig();
    const painted = [];
    const result = await flow.save({ check: passing(1), compose });
    const delivery = { channel: "error", paint: () => painted.push(true), text: "The save failed." };

    card.shown = false;
    result.deliver(delivery);

    assert.deepEqual(painted, [], "the card moved on after the check, so the outcome does not paint");
    assert.deepEqual(toast.raised, [{ channel: "error", text: "The save failed." }], "and reaches the toast instead");

    card.shown = true;
    result.deliver(delivery);

    assert.deepEqual(painted, [true], "the card shows the press again, so the same outcome paints this time");
    assert.equal(toast.raised.length, 1, "and raises no second toast");
  });

  test("a declined result whose signal is aborted after the press resolved, then delivered, neither paints nor toasts", async () => {

    const { card, flow, toast } = makeRig();
    const painted = [];
    const result = await flow.save({ check: async () => ({ kind: "declined", reason: "The address is not reachable." }), compose });

    card.guard.cancel();
    result.deliver({ channel: "error", paint: () => painted.push(true), text: "The address is not reachable." });

    assert.deepEqual(painted, [], "a press retired before any write paints nothing");
    assert.deepEqual(toast.raised, [], "and owes the user no toast, because its refusal answers for input the card has moved past");
  });

  test("a retired check's deliver, called from inside the check after its signal aborted, neither paints nor toasts", async () => {

    const { card, flow, toast } = makeRig();
    const painted = [];
    const result = await flow.save({

      check: async ({ deliver }) => {

        card.guard.cancel();
        deliver({ channel: "error", paint: () => painted.push(true), text: "The address is not reachable." });

        return { kind: "passed", value: 1 };
      },
      compose
    });

    assert.deepEqual(result, { kind: "superseded" });
    assert.deepEqual(painted, [], "a retired check paints nothing");
    assert.deepEqual(toast.raised, [], "and raises nothing");
  });

  test("deliver is usable from inside the check through the context", async () => {

    const { flow, toast } = makeRig();
    const painted = [];
    const seen = [];
    const result = await flow.save({

      check: async ({ deliver, presented }) => {

        seen.push(presented());
        deliver({ channel: "error", paint: () => painted.push("refused"), text: "The credentials were refused." });

        return { kind: "declined", reason: "The credentials were refused." };
      },
      compose
    });

    assert.deepEqual(seen, [true], "the check reads its press as presented");
    assert.deepEqual(painted, ["refused"], "and its own delivery lands on the card");
    assert.deepEqual(toast.raised, [], "with no toast beside it");
    assert.equal(result.kind, "declined", "and the refusal it delivered is answered as declined, for the card not to deliver again");
  });
});
