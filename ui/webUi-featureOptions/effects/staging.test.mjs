/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/staging.test.mjs: Unit tests for the staging effect.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import { PluginConfigSession } from "../../pluginConfigSession.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { registerStagingEffect } from "./staging.mjs";

const CATEGORIES = [{ description: "Motion Options", name: "Motion" }];
const OPTIONS = { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] };
const CATALOG = {

  ...buildCatalogIndex(CATEGORIES, OPTIONS),

  validators: {

    isController: () => false,
    validOption: () => true,
    validOptionCategory: () => true
  }
};

const PLATFORM = { name: "MyPlugin Platform", platform: "MyPlugin" };

// Helper: build a store seeded with the canonical "ready" state and register the staging effect against a config session backed by a fake host. The fake host's
// `updatePluginConfig` records every payload and lets each test choose to resolve immediately, defer, or reject; its `getPluginConfig` seeds the session with the
// canonical platform entry, so the session's commit rebuilds the same `[{ ...PLATFORM, options }]` payload from the options delta the staging effect hands it; and its
// `toast.error` records every toast the drain raises. Tests get an inspection surface for the dispatched store events, the host calls, and those toasts. Async
// because opening the session reads the host config once. `loaded: false` withholds the model:loaded dispatch, leaving the store in the placeholder state a page
// holds when its model never arrives - the input the model-load boundary tests need, and the only thing that option changes about the rig.
//
// `configuredOptions` seeds the store's own starting state as well as the model:loaded dispatch, with the anchor seeded to match so the store starts clean. On
// the loaded path the dispatch installs the same array over both fields and the seeding is invisible; on the unloaded path it is the only way to give a
// placeholder store something configured to mutate away from, which a reset has to have before it is a change at all.
const setup = async ({ behavior = "resolve", configuredOptions = [], loaded = true } = {}) => {

  const store = new FeatureOptionsStore({

    initialState: { ...initialState(), configuredOptions, stagedAnchor: configuredOptions },
    reducer
  });

  if(loaded) {

    store.dispatch({

      catalog: CATALOG,
      configuredOptions,
      controllers: [],
      mode: "device-only",
      type: "model:loaded"
    });
  }

  const updates = [];
  const events = [];
  const toasts = [];
  const controller = new AbortController();
  let release;
  let reject;

  const host = {

    getPluginConfig: async () => [PLATFORM],
    toast: { error: (message, title) => toasts.push({ message, title }) },
    updatePluginConfig: async (payload) => {

      updates.push(payload);

      switch(behavior) {

        case "defer": {

          // Caller resolves explicitly via the returned `release()`.
          return new Promise((res, rej) => { release = res; reject = rej; });
        }

        case "reject":

          throw new Error("Disk write failed");

        default:

          return undefined;
      }
    }
  };

  // Record every event the store dispatches for inspection.
  for(const type of [ "staging:started", "staging:succeeded", "staging:failed" ]) {

    store.addEventListener(type, (event) => events.push({ detail: event.detail, type: event.type }));
  }

  const session = await PluginConfigSession.open({ host, name: PLATFORM.name });

  // Capture the effect's flush handle so the flush tests can drain the pending edit at the navigate-away edge.
  const { flush } = registerStagingEffect({ host, session, signal: controller.signal, store });

  return { abort: () => controller.abort(), defer: () => ({ reject: (err) => reject(err), resolve: () => release() }), events, flush, host, store, toasts, updates };
};

// Await 350ms of real time so the effect's real 300ms debounce window elapses and its drain settles before the assertions run. The staging effect runs
// `delay(300, signal)` inside its drain loop, so genuine waits must advance real time past that window rather than merely draining microtasks.
const flush = () => new Promise((resolve) => setTimeout(resolve, 350));

describe("registerStagingEffect - initial registration", () => {

  test("does not trigger a stage when configuredOptions matches the anchor (initial state)", async () => {

    const { events, updates } = await setup({ configuredOptions: [] });

    await flush();

    assert.equal(updates.length, 0, "no staging call");
    assert.equal(events.length, 0, "no staging events dispatched");
  });

  test("does not trigger a stage immediately after model:loaded (configuredOptions and anchor share the same reference)", async () => {

    const { events, updates } = await setup({ configuredOptions: ["Enable.Motion.Detect"] });

    await flush();

    assert.equal(updates.length, 0);
    assert.equal(events.length, 0);
  });
});

describe("registerStagingEffect - happy path", () => {

  test("a single mutation triggers a debounced stage with the new options", async () => {

    const { events, store, updates } = await setup();

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], [{ ...PLATFORM, options: ["Disable.Motion.Detect"] }]);
    assert.deepEqual(events.map((e) => e.type), [ "staging:started", "staging:succeeded" ]);
    assert.equal(store.state.stagedAnchor, store.state.configuredOptions, "anchor advances to the staged snapshot - reference equality preserved");
    assert.equal(store.state.status.kind, "ready");
  });

  test("rapid mutations within the debounce window coalesce into a single stage of the latest state", async () => {

    const { store, updates } = await setup();

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1, "burst coalesces into one write");
    assert.deepEqual(updates[0][0].options, ["Disable.Motion.Detect"], "latest state wins");
  });

  test("subsequent stage of a no-op clearOption (same reference) does not trigger a new stage", async () => {

    const { events, store, updates } = await setup({ configuredOptions: ["Enable.Motion.Detect"] });

    // Clearing an option that does not exist: applyClearOption returns the input reference unchanged, so the reducer's spread preserves the configuredOptions
    // reference and the dirty check skips.
    store.dispatch({ args: { option: "Audio.Volume" }, type: "option:cleared" });

    await flush();

    assert.equal(updates.length, 0, "no-op clear did not trigger a stage");
    assert.equal(events.length, 0);
  });
});

describe("registerStagingEffect - concurrent mutations during an in-flight stage", () => {

  test("mutations during a stage coalesce into a second stage after the first completes", async () => {

    let release;
    let callCount = 0;
    const events = [];
    const updates = [];
    const toasts = [];
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    store.dispatch({

      catalog: CATALOG,
      configuredOptions: [],
      controllers: [],
      mode: "device-only",
      type: "model:loaded"
    });

    // Host's first call is deferred (test releases it); subsequent calls resolve immediately so the second iteration completes naturally.
    const host = {

      getPluginConfig: async () => [PLATFORM],
      toast: { error: (message, title) => toasts.push({ message, title }) },
      updatePluginConfig: async (payload) => {

        callCount++;
        updates.push(payload);

        if(callCount === 1) {

          return new Promise((res) => { release = res; });
        }

        return undefined;
      }
    };

    for(const type of [ "staging:started", "staging:succeeded", "staging:failed" ]) {

      store.addEventListener(type, (event) => events.push({ detail: event.detail, type: event.type }));
    }

    const session = await PluginConfigSession.open({ host, name: PLATFORM.name });

    registerStagingEffect({ host, session, signal: controller.signal, store });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    // Wait past debounce so the first stage enters flight.
    await flush();

    assert.equal(updates.length, 1, "first stage is in flight");

    // Mutation during in-flight call. The effect sets pending=true but does NOT start a second drain.
    store.dispatch({ args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });

    // Release the first stage.
    release();

    // Two debounces back-to-back can take ~600ms total. Wait long enough.
    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(updates.length, 2, "second stage runs after the first completes");
    assert.deepEqual(updates[1][0].options, ["Enable.Motion.Detect"], "second stage sends the latest state (the second mutation re-enabled the option)");
    assert.deepEqual(events.map((e) => e.type), [ "staging:started", "staging:succeeded", "staging:started", "staging:succeeded" ]);
  });
});

describe("registerStagingEffect - a coordinated configuration write", () => {

  test("an option mutation refused while the write holds the store starts no drain", async () => {

    const { events, store, updates } = await setup();

    store.dispatch({ type: "commit:started" });

    assert.equal(store.state.write.kind, "committing", "precondition: the hold is taken");

    // The reducer returns the state reference untouched, so this effect's dirty check finds configuredOptions still equal to the anchor and starts nothing. No
    // drain is the point: a commit begun here would either race the coordinated write or land after it and write the pre-write options back over what it staged.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 0, "nothing reached the host");
    assert.equal(events.length, 0, "and no staging event was dispatched");

    // The same gesture once the hold lifts, so the row cannot pass by the effect simply being dead.
    store.dispatch({ type: "commit:failed" });
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1, "the identical mutation drains once the hold lifts");
    assert.deepEqual(updates[0][0].options, ["Disable.Motion.Detect"], "carrying what the user asked for");
  });
});

describe("registerStagingEffect - failure path", () => {

  test("a final-attempt failure dispatches staging:failed and rolls configuredOptions back to the anchor", async () => {

    const { events, store, toasts, updates } = await setup({ behavior: "reject" });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1);
    assert.deepEqual(events.map((e) => e.type), [ "staging:started", "staging:failed" ]);
    assert.equal(store.state.write.kind, "staging-error");
    assert.equal(store.state.configuredOptions, store.state.stagedAnchor, "rollback: configuredOptions reverts to the anchor reference");
    assert.deepEqual(store.state.configuredOptions, []);
    assert.deepEqual(toasts, [{ message: "Disk write failed", title: "Error" }], "the drain's one final failure reaches the user through the shared error toast");
  });

  test("an intermediate failure rescued by a later mutation is swallowed - the second stage's outcome is what surfaces", async () => {

    let callCount = 0;
    const events = [];
    const updates = [];
    const toasts = [];
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();
    let release;

    store.dispatch({

      catalog: CATALOG,
      configuredOptions: [],
      controllers: [],
      mode: "device-only",
      type: "model:loaded"
    });

    const host = {

      getPluginConfig: async () => [PLATFORM],
      toast: { error: (message, title) => toasts.push({ message, title }) },
      updatePluginConfig: async (payload) => {

        callCount++;
        updates.push(payload);

        if(callCount === 1) {

          // First call hangs until the test resolves it - this is the call that will be "rescued" by a superseding mutation.
          await new Promise((res) => { release = res; });

          throw new Error("First call failed");
        }

        // Second call succeeds.
        return undefined;
      }
    };

    for(const type of [ "staging:started", "staging:succeeded", "staging:failed" ]) {

      store.addEventListener(type, (event) => events.push({ detail: event.detail, type: event.type }));
    }

    const session = await PluginConfigSession.open({ host, name: PLATFORM.name });

    registerStagingEffect({ host, session, signal: controller.signal, store });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await new Promise((res) => setTimeout(res, 350));

    assert.equal(callCount, 1, "first call in flight");

    // Mutation during the failing first call. The drain loop will see pending=true after the first call rejects and continue.
    store.dispatch({ args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });

    // Release the first call to fail.
    release();

    await new Promise((res) => setTimeout(res, 350));

    assert.deepEqual(events.map((e) => e.type), [ "staging:started", "staging:started", "staging:succeeded" ],
      "intermediate failure swallowed - only the second iteration's succeeded surfaces");
    assert.equal(store.state.status.kind, "ready");
    assert.deepEqual(toasts, [], "a failure a newer edit rescued never reaches the user");
  });

  test("a swallowed failure whose superseding edits end on the saved options leaves the write lifecycle idle", async () => {

    const events = [];
    const updates = [];
    const toasts = [];
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();
    let release;

    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });

    const host = {

      getPluginConfig: async () => [PLATFORM],
      toast: { error: (message, title) => toasts.push({ message, title }) },
      updatePluginConfig: async (payload) => {

        updates.push(payload);

        // The one write this drain makes hangs until the test releases it as a refusal, so both mutations below land while it is still in flight.
        await new Promise((resolve) => { release = resolve; });

        throw new Error("Disk write failed");
      }
    };

    for(const type of [ "staging:started", "staging:succeeded", "staging:failed" ]) {

      store.addEventListener(type, (event) => events.push({ detail: event.detail, type: event.type }));
    }

    const session = await PluginConfigSession.open({ host, name: PLATFORM.name });

    registerStagingEffect({ host, session, signal: controller.signal, store });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1, "precondition: the write the host will refuse is in flight");

    /* Two mutations during that write, which is what puts the store in the state this row exists for. The first is a genuine edit, so it marks the drain dirty and
     * the refusal below is swallowed rather than surfaced. The second returns the options to the array the anchor holds, so the iteration that follows the swallow
     * finds nothing left to write and never answers the swallowed write's staging:started on its own.
     */
    store.dispatch({ args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ type: "model:reverted" });

    assert.equal(store.state.configuredOptions, store.state.stagedAnchor, "precondition: the revert left the store clean by reference");
    assert.equal(store.state.write.kind, "staging", "precondition: the refused write is still open as far as the store knows");

    release();

    await flush();

    assert.equal(updates.length, 1, "the rescued refusal is never retried - there is nothing left to write");
    assert.deepEqual(events.map((e) => e.type), [ "staging:started", "staging:succeeded" ], "the swallowed write's started is answered rather than left open");
    assert.equal(store.state.write.kind, "idle", "so the lifecycle ends idle rather than at a staging nothing will ever answer");
    assert.equal(store.state.stagedAnchor, store.state.configuredOptions, "and the anchor still names what the host holds");
    assert.deepEqual(toasts, [], "a failure a newer edit rescued never reaches the user");
  });
});

describe("registerStagingEffect - lifecycle", () => {

  test("aborting the signal stops the effect from triggering further stages", async () => {

    const { abort, store, updates } = await setup();

    abort();

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 0, "post-abort mutation does not trigger a stage");
  });

  test("aborting the signal mid-drain prevents post-call dispatches against the torn-down view", async () => {

    const { abort, defer, events, store } = await setup({ behavior: "defer" });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    // staging:started already dispatched. updatePluginConfig is hanging.
    assert.deepEqual(events.map((e) => e.type), ["staging:started"]);

    abort();
    defer().resolve();

    await flush();

    // No staging:succeeded - the post-await abort check bailed.
    assert.deepEqual(events.map((e) => e.type), ["staging:started"], "no further events dispatched after abort");
  });
});

describe("registerStagingEffect - flush (navigate-away drain)", () => {

  // flush() is the navigate-away drain: it drives any debounced-but-unwritten edit to the host NOW, skipping the debounce wait, while preserving single-writer
  // serialization and coalescing. These tests assert the single-writer mechanism (loop on pending || flushing, in-loop dirty check, flushing reset in every drain
  // finally) against the failure modes the pre-mortem enumerates.

  test("flush() within the debounce window stages the pending edit exactly once (no 300ms wait)", async () => {

    const { events, flush, store, updates } = await setup();

    // Toggle, then flush IMMEDIATELY - structurally within the debounce window: there is no settle/flush(350ms) wait between the dispatch and the flush. The drain is
    // mid-debounce (the effect-fn started it, it is parked on delay(300)); flush() aborts that debounce and drives the same drain straight to the write.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1, "flush() must stage exactly once - the pending edit, not zero (dropped) and not twice (double-write)");
    assert.deepEqual(updates[0], [{ ...PLATFORM, options: ["Disable.Motion.Detect"] }], "the single write must carry the toggled options");
    assert.deepEqual(events.map((e) => e.type), [ "staging:started", "staging:succeeded" ], "exactly one staging lifecycle, completed");
    assert.equal(store.state.stagedAnchor, store.state.configuredOptions, "the anchor advanced to the flushed snapshot");
  });

  test("flush() on a clean store is a no-op and does not leak flushing=true into the next mutation's debounce", async () => {

    const { flush, store, updates } = await setup();

    // Clean store (no edits since model:loaded). flush() must start no drain and write nothing.
    await flush();

    assert.equal(updates.length, 0, "flush() on a clean store must not write");

    // The anti-leak assertion (pre-mortem 1): if flush() had left flushing=true, the next mutation's drain would skip the debounce and stage immediately. Toggle,
    // then check synchronously (no wait) that NO write has happened yet - proving the edit is still being debounced, i.e. flushing did not leak.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    assert.equal(updates.length, 0, "a post-flush toggle must still be DEBOUNCED (no immediate write) - flushing did not leak true");

    // And after the debounce, it does land normally.
    await flush();

    assert.equal(updates.length, 1, "the debounced toggle stages once after its window elapses");
    assert.deepEqual(updates[0][0].options, ["Disable.Motion.Detect"], "the post-flush toggle staged the right options");
  });

  test("flush() while a commit is in flight awaits that commit and does not start a second write", async () => {

    const { defer, flush, store, updates } = await setup({ behavior: "defer" });

    // Drive an edit all the way into an in-flight (deferred) commit. The first flush() does NOT resolve here - its `await inFlight` is parked on the deferred commit -
    // so we capture it without awaiting and probe its resolution separately.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    let firstResolved = false;
    const firstFlush = flush().then(() => { firstResolved = true; });

    // Let the drain advance through its (flush-shortcut) debounce and into the deferred commit. A real-timer tick covers the AbortSignal.any rejection hop plus the
    // microtask chain that lands the drain on the deferred updatePluginConfig.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(updates.length, 1, "the edit's commit is in flight (deferred)");
    assert.equal(firstResolved, false, "flush() must not resolve while the in-flight commit is still deferred");

    // A SECOND flush() while that commit is in flight must NOT start a parallel commit - it nudges the same running drain and awaits the same inFlight. Capture it
    // too without awaiting (it is also parked on the deferred commit).
    let secondResolved = false;
    const secondFlush = flush().then(() => { secondResolved = true; });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(secondResolved, false, "the second flush() must not resolve while the commit is still deferred");
    assert.equal(updates.length, 1, "no second write was started against the in-flight commit (single-writer serialization holds)");

    // Release the deferred commit. Both flush() promises settle, and exactly one write was issued for the single edit.
    defer().resolve();

    await Promise.all([ firstFlush, secondFlush ]);

    assert.equal(firstResolved, true, "the first flush() resolves once the deferred commit completes");
    assert.equal(secondResolved, true, "the second flush() resolves once the deferred commit completes");
    assert.equal(updates.length, 1, "exactly one write for the single edit - no double-write");
  });

  test("flush() followed by abort() does not re-commit", async () => {

    const { abort, flush, store, updates } = await setup();

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1, "flush() staged the edit once");

    // Abort after the flush already drained the edit. A subsequent flush() must not re-commit (the store is clean - the anchor advanced), and the aborted signal
    // stops any further drain regardless.
    abort();

    await flush();

    assert.equal(updates.length, 1, "flush() after abort must not re-commit an already-staged, now-clean edit");
  });
});

describe("registerStagingEffect - model-load boundary", () => {

  // The write path's floor: a store whose model never loaded holds placeholder state, and the options it would write describe nothing the user configured. These
  // lock in the refusal at the drain - the one point both start-sites pass through - across the page states an unloaded store can be sitting in when a write is
  // asked for.

  test("a store that never loaded its model writes nothing, even with a mutation dispatched and flushed", async () => {

    const { flush, store, updates } = await setup({ configuredOptions: ["Enable.Motion.Detect"], loaded: false });

    // A mutation against the placeholder state forks configuredOptions off the anchor, so the effect sees a dirty store and starts the drain. What that drain
    // would commit is the placeholder's own emptiness, landing on the host as an erasure of whatever the user had saved. The seeded configuration is what makes the
    // reset a real change: a reset of nothing keeps its reference and never reaches the drain at all, which would leave this refusal unexercised.
    store.dispatch({ type: "options:reset" });

    await flush();

    assert.equal(updates.length, 0, "an unloaded store must not reach the host");
  });

  test("the refusal holds once the status has left loading - a connection error before the model does not license a write", async () => {

    const { flush, store, updates } = await setup({ configuredOptions: ["Enable.Motion.Detect"], loaded: false });

    store.dispatch({

      guidance: "Check the Settings tab to verify the controller details are correct.",
      headline: "Unable to retrieve the controller list.",
      message: "the controller hook blew up",
      type: "connection:error"
    });

    store.dispatch({ type: "options:reset" });

    await flush();

    assert.equal(store.state.status.kind, "connection-error", "pre-condition: the status has left loading with no model ever having arrived");
    assert.equal(updates.length, 0, "the refusal keys on the model, not on the status");
  });

  test("flush() on a store the refusal left dirty starts its own drain and refuses identically", async () => {

    const { flush, store, updates } = await setup({ configuredOptions: ["Enable.Motion.Detect"], loaded: false });

    store.dispatch({ type: "options:reset" });

    // Yield a macrotask so the drain the dispatch started reaches its `finally` and clears `inFlight` before flush() runs as a separate statement. That is
    // the one state in which flush() finds a dirty store with nothing in flight and starts a drain of its own, which the refusal then turns away again.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(updates.length, 0, "precondition: the refusal wrote nothing and left the store dirty");

    await flush();

    assert.equal(updates.length, 0, "flush()'s own drain refuses identically, so still nothing reaches the host");
  });
});

describe("registerStagingEffect - a reset with nothing configured", () => {

  // The reducer's reset arm hands back the configured options it was given when there is nothing to wipe, so the effect's own dirty check finds the store clean
  // and no drain starts. The write this row proves absent would have carried the same empty configuration the host already holds.

  test("a reset of an already-empty configuration reaches the host with nothing", async () => {

    const { flush, store, updates } = await setup();

    assert.equal(store.state.configuredOptions, store.state.stagedAnchor, "pre-condition: a loaded store with nothing configured is clean");

    store.dispatch({ type: "options:reset" });

    await flush();

    assert.equal(store.state.configuredOptions, store.state.stagedAnchor, "the reset left the configuration exactly where it was");
    assert.equal(updates.length, 0, "so nothing reached the host");
  });
});
