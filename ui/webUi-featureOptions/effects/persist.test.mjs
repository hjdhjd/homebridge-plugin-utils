/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/persist.test.mjs: Unit tests for the persistence effect.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import { PluginConfigSession } from "../../pluginConfigSession.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { registerPersistEffect } from "./persist.mjs";

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

// Helper: build a store seeded with the canonical "ready" state and register the persist effect against a config session backed by a fake host. The fake host's
// `updatePluginConfig` records every payload and lets each test choose to resolve immediately, defer, or reject; its `getPluginConfig` seeds the session with the
// canonical platform entry, so the session's commit rebuilds the same `[{ ...PLATFORM, options }]` payload from the options delta the persist effect hands it. Tests
// get an inspection surface for both the dispatched store events and the host calls. Async because opening the session reads the host config once.
const setup = async ({ behavior = "resolve", configuredOptions = [] } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });

  store.dispatch({

    catalog: CATALOG,
    configuredOptions,
    controllers: [],
    mode: "device-only",
    type: "model:loaded"
  });

  const updates = [];
  const events = [];
  const controller = new AbortController();
  let release;
  let reject;

  const host = {

    getPluginConfig: async () => [PLATFORM],
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
  for(const type of [ "persist:started", "persist:succeeded", "persist:failed" ]) {

    store.addEventListener(type, (event) => events.push({ detail: event.detail, type: event.type }));
  }

  const session = await PluginConfigSession.open({ host, name: PLATFORM.name });

  // Capture the effect's flush handle so the flush tests can drain the pending edit at the navigate-away edge.
  const { flush } = registerPersistEffect({ host, session, signal: controller.signal, store });

  return { abort: () => controller.abort(), defer: () => ({ reject: (err) => reject(err), resolve: () => release() }), events, flush, host, store, updates };
};

// Await 350ms of real time so the effect's real 300ms debounce window elapses and its drain settles before the assertions run. The persist effect runs
// `delay(300, signal)` inside its drain loop, so genuine waits must advance real time past that window rather than merely draining microtasks.
const flush = () => new Promise((resolve) => setTimeout(resolve, 350));

describe("registerPersistEffect - initial registration", () => {

  test("does not trigger a persist when configuredOptions matches the anchor (initial state)", async () => {

    const { events, updates } = await setup({ configuredOptions: [] });

    await flush();

    assert.equal(updates.length, 0, "no persist call");
    assert.equal(events.length, 0, "no persist events dispatched");
  });

  test("does not trigger a persist immediately after model:loaded (configuredOptions and anchor share the same reference)", async () => {

    const { events, updates } = await setup({ configuredOptions: ["Enable.Motion.Detect"] });

    await flush();

    assert.equal(updates.length, 0);
    assert.equal(events.length, 0);
  });
});

describe("registerPersistEffect - happy path", () => {

  test("a single mutation triggers a debounced persist with the new options", async () => {

    const { events, store, updates } = await setup();

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], [{ ...PLATFORM, options: ["Disable.Motion.Detect"] }]);
    assert.deepEqual(events.map((e) => e.type), [ "persist:started", "persist:succeeded" ]);
    assert.equal(store.state.persistedAnchor, store.state.configuredOptions, "anchor advances to the persisted snapshot - reference equality preserved");
    assert.equal(store.state.status.kind, "ready");
  });

  test("rapid mutations within the debounce window coalesce into a single persist of the latest state", async () => {

    const { store, updates } = await setup();

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1, "burst coalesces into one write");
    assert.deepEqual(updates[0][0].options, ["Disable.Motion.Detect"], "latest state wins");
  });

  test("subsequent persist of a no-op clearOption (same reference) does not trigger a new persist", async () => {

    const { events, store, updates } = await setup({ configuredOptions: ["Enable.Motion.Detect"] });

    // Clearing an option that does not exist: applyClearOption returns the input reference unchanged, so the reducer's spread preserves the configuredOptions
    // reference and the dirty check skips.
    store.dispatch({ args: { option: "Audio.Volume" }, type: "option:cleared" });

    await flush();

    assert.equal(updates.length, 0, "no-op clear did not trigger a persist");
    assert.equal(events.length, 0);
  });
});

describe("registerPersistEffect - concurrent mutations during in-flight persist", () => {

  test("mutations during a persist coalesce into a second persist after the first completes", async () => {

    let release;
    let callCount = 0;
    const events = [];
    const updates = [];
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
      updatePluginConfig: async (payload) => {

        callCount++;
        updates.push(payload);

        if(callCount === 1) {

          return new Promise((res) => { release = res; });
        }

        return undefined;
      }
    };

    for(const type of [ "persist:started", "persist:succeeded", "persist:failed" ]) {

      store.addEventListener(type, (event) => events.push({ detail: event.detail, type: event.type }));
    }

    const session = await PluginConfigSession.open({ host, name: PLATFORM.name });

    registerPersistEffect({ host, session, signal: controller.signal, store });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    // Wait past debounce so the first persist enters flight.
    await flush();

    assert.equal(updates.length, 1, "first persist is in flight");

    // Mutation during in-flight call. The effect sets pending=true but does NOT start a second drain.
    store.dispatch({ args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });

    // Release the first persist.
    release();

    // Two debounces back-to-back can take ~600ms total. Wait long enough.
    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(updates.length, 2, "second persist runs after the first completes");
    assert.deepEqual(updates[1][0].options, ["Enable.Motion.Detect"], "second persist sends the latest state (the second mutation re-enabled the option)");
    assert.deepEqual(events.map((e) => e.type), [ "persist:started", "persist:succeeded", "persist:started", "persist:succeeded" ]);
  });
});

describe("registerPersistEffect - failure path", () => {

  test("a final-attempt failure dispatches persist:failed and rolls configuredOptions back to the anchor", async () => {

    const { events, store, updates } = await setup({ behavior: "reject" });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1);
    assert.deepEqual(events.map((e) => e.type), [ "persist:started", "persist:failed" ]);
    assert.equal(store.state.status.kind, "persist-error");
    assert.equal(store.state.configuredOptions, store.state.persistedAnchor, "rollback: configuredOptions reverts to the anchor reference");
    assert.deepEqual(store.state.configuredOptions, []);
  });

  test("an intermediate failure rescued by a later mutation is swallowed - the second persist's outcome is what surfaces", async () => {

    let callCount = 0;
    const events = [];
    const updates = [];
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

    for(const type of [ "persist:started", "persist:succeeded", "persist:failed" ]) {

      store.addEventListener(type, (event) => events.push({ detail: event.detail, type: event.type }));
    }

    const session = await PluginConfigSession.open({ host, name: PLATFORM.name });

    registerPersistEffect({ host, session, signal: controller.signal, store });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await new Promise((res) => setTimeout(res, 350));

    assert.equal(callCount, 1, "first call in flight");

    // Mutation during the failing first call. The drain loop will see pending=true after the first call rejects and continue.
    store.dispatch({ args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });

    // Release the first call to fail.
    release();

    await new Promise((res) => setTimeout(res, 350));

    assert.deepEqual(events.map((e) => e.type), [ "persist:started", "persist:started", "persist:succeeded" ],
      "intermediate failure swallowed - only the second iteration's succeeded surfaces");
    assert.equal(store.state.status.kind, "ready");
  });
});

describe("registerPersistEffect - lifecycle", () => {

  test("aborting the signal stops the effect from triggering further persists", async () => {

    const { abort, store, updates } = await setup();

    abort();

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 0, "post-abort mutation does not trigger a persist");
  });

  test("aborting the signal mid-drain prevents post-call dispatches against the torn-down view", async () => {

    const { abort, defer, events, store } = await setup({ behavior: "defer" });

    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    // persist:started already dispatched. updatePluginConfig is hanging.
    assert.deepEqual(events.map((e) => e.type), ["persist:started"]);

    abort();
    defer().resolve();

    await flush();

    // No persist:succeeded - the post-await abort check bailed.
    assert.deepEqual(events.map((e) => e.type), ["persist:started"], "no further events dispatched after abort");
  });
});

describe("registerPersistEffect - flush (navigate-away drain)", () => {

  // flush() is the navigate-away drain: it drives any debounced-but-unwritten edit to disk NOW, skipping the debounce wait, while preserving single-writer
  // serialization and coalescing. These tests pin the single-writer mechanism (loop on pending || flushing, in-loop dirty check, flushing reset in every drain
  // finally) against the failure modes the pre-mortem enumerates.

  test("flush() within the debounce window persists the pending edit exactly once (no 300ms wait)", async () => {

    const { events, flush, store, updates } = await setup();

    // Toggle, then flush IMMEDIATELY - structurally within the debounce window: there is no settle/flush(350ms) wait between the dispatch and the flush. The drain is
    // mid-debounce (the effect-fn started it, it is parked on delay(300)); flush() aborts that debounce and drives the same drain straight to the write.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    await flush();

    assert.equal(updates.length, 1, "flush() must persist exactly once - the pending edit, not zero (dropped) and not twice (double-write)");
    assert.deepEqual(updates[0], [{ ...PLATFORM, options: ["Disable.Motion.Detect"] }], "the single write must carry the toggled options");
    assert.deepEqual(events.map((e) => e.type), [ "persist:started", "persist:succeeded" ], "exactly one persist lifecycle, completed");
    assert.equal(store.state.persistedAnchor, store.state.configuredOptions, "the anchor advanced to the flushed snapshot");
  });

  test("flush() on a clean store is a no-op and does not leak flushing=true into the next mutation's debounce", async () => {

    const { flush, store, updates } = await setup();

    // Clean store (no edits since model:loaded). flush() must start no drain and write nothing.
    await flush();

    assert.equal(updates.length, 0, "flush() on a clean store must not write");

    // The anti-leak assertion (pre-mortem 1): if flush() had left flushing=true, the next mutation's drain would skip the debounce and persist immediately. Toggle,
    // then check synchronously (no wait) that NO write has happened yet - proving the edit is still being debounced, i.e. flushing did not leak.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    assert.equal(updates.length, 0, "a post-flush toggle must still be DEBOUNCED (no immediate write) - flushing did not leak true");

    // And after the debounce, it does land normally.
    await flush();

    assert.equal(updates.length, 1, "the debounced toggle persists once after its window elapses");
    assert.deepEqual(updates[0][0].options, ["Disable.Motion.Detect"], "the post-flush toggle persisted the right options");
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

    assert.equal(updates.length, 1, "flush() persisted the edit once");

    // Abort after the flush already drained the edit. A subsequent flush() must not re-commit (the store is clean - the anchor advanced), and the aborted signal
    // stops any further drain regardless.
    abort();

    await flush();

    assert.equal(updates.length, 1, "flush() after abort must not re-commit an already-persisted, now-clean edit");
  });
});
