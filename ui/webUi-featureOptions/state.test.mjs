/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/state.test.mjs: Unit tests for the state shape, action vocabulary, and reducer.
 */
"use strict";

import { connectionFailureCopy, controllerNoticeCopy, initialState, reducer } from "./state.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../featureOptions.js";

// Shared catalog fixture - small enough to be readable, varied enough to exercise the reducer's interaction with the pure transforms (value options, grouped
// options, and a plain boolean across a small set of categories).
const CATEGORIES = [

  { description: "Motion Options", name: "Motion" },
  { description: "Audio Options", name: "Audio" }
];

const OPTIONS = {

  Audio: [
    { default: false, defaultValue: 50, description: "Audio volume level.", name: "Volume" }
  ],

  Motion: [

    { default: true, description: "Enable motion detection.", name: "Detect" },
    { default: false, description: "Motion sensitivity tuning.", group: "Detect", name: "Sensitivity" }
  ]
};

const CATALOG = {

  ...buildCatalogIndex(CATEGORIES, OPTIONS),

  validators: {

    isController: () => false,
    validOption: () => true,
    validOptionCategory: () => true
  }
};

const DEVICES = [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];

// A store that has loaded its model, built the way the page builds one: a model:loaded over a fresh initial state. It is the precondition for most of what the
// reducer does, so it lives here rather than being spelled out again in each block that needs one.
const loadedState = ({ configuredOptions = [], controllers = [], mode = "device-only" } = {}) => {

  return reducer(initialState(), { catalog: CATALOG, configuredOptions, controllers, mode, type: "model:loaded" });
};

// Pair a request with its answering outcome: mint the sequence, then apply the outcome stamped with it. The reducer applies a loaded only when its sequence still
// answers the pending request, so this pairing is how a fetch's outcome lands in state.
const requestThenLoad = (state, { controllerId = null, devices = [], emptyMessage, error = "" } = {}) => {

  const requested = reducer(state, { controllerId, type: "devices:requested" });

  return reducer(requested, { controllerId, devices, emptyMessage, error, seq: requested.devicesRequest.seq, type: "devices:loaded" });
};

describe("initialState", () => {

  test("returns a fresh state object with status = loading and every populated-at-runtime field empty", () => {

    const state = initialState();

    assert.equal(state.status.kind, "loading");
    assert.deepEqual(state.configuredOptions, []);
    assert.deepEqual(state.initialOptions, []);
    assert.deepEqual(state.persistedAnchor, []);
    assert.deepEqual(state.controllers, []);
    assert.deepEqual(state.devices, []);
    assert.deepEqual(state.scope, { kind: "global" });
    assert.deepEqual(state.filter, { mode: "all", query: "" });
    assert.equal(state.mode, "device-only");
    assert.ok(state.catalog, "placeholder catalog populated so selectors do not need null guards during loading");
    assert.deepEqual(state.catalog.choiceSources, {}, "no catalog means no picker can name a source, so the empty map is the whole truth rather than a stand-in");
    // A catalog registry carries no prototype, so it is never deep-equal to a plain literal; the spread copies its keys into one so the row compares contents.
    assert.deepEqual({ ...state.catalog.optionsByName }, {}, "and the placeholder's raw-entry lookup is empty for the same reason");
  });

  test("returns a fresh object on each call - state instances are not shared across stores", () => {

    const a = initialState();
    const b = initialState();

    assert.notEqual(a, b, "different top-level references");
    assert.notEqual(a.filter, b.filter, "nested objects are also fresh");
  });
});

describe("reducer - model:loaded", () => {

  test("seeds catalog, configuredOptions, controllers, mode; sets initialOptions and persistedAnchor to the loaded options; transitions status to ready", () => {

    const configuredOptions = ["Enable.Motion.Detect"];
    const controllers = [{ address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" }];
    const next = reducer(initialState(), { catalog: CATALOG, configuredOptions, controllers, mode: "controller-based", type: "model:loaded" });

    assert.equal(next.catalog, CATALOG);
    assert.equal(next.configuredOptions, configuredOptions, "configuredOptions reference preserved from the action - structural sharing");
    assert.equal(next.initialOptions, configuredOptions, "initialOptions seeded with the same reference for revert");
    assert.equal(next.persistedAnchor, configuredOptions, "persistedAnchor seeded with the same reference for rollback");
    assert.equal(next.mode, "controller-based");
    assert.equal(next.controllers, controllers);
    assert.deepEqual(next.status, { kind: "ready" });
  });

  test("adopts each legal mode literal verbatim and throws on an illegal one", () => {

    for(const mode of [ "controller-based", "device-only", "global-only" ]) {

      const next = reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode, type: "model:loaded" });

      assert.equal(next.mode, mode, "the legal mode literal \"" + mode + "\" is adopted verbatim");
    }

    // A mode typo at the one dispatch site must not silently disarm the global-only scope guard, so an unrecognized literal throws at the reducer rather than being
    // adopted, matching the unknown-action policy.
    assert.throws(() => reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-onlyy", type: "model:loaded" }),
      /unknown mode/, "an illegal mode literal throws");
  });

  test("throws when the dispatch carries no catalog, naming the missing piece", () => {

    // Catalog identity is what tells a loaded store from a fresh one, so a dispatch that installed a missing catalog would corrupt that signal while the page
    // rendered as ready. A dispatch-site bug leaves the field absent or leaves it null, and each has to reach the same loud failure.
    for(const catalog of [ undefined, null ]) {

      assert.throws(() => reducer(initialState(), { catalog, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" }),
        /carried no catalog/, "a model:loaded without a catalog throws and names the problem");
    }
  });
});

describe("reducer - model:loaded establishes over a standing page", () => {

  test("declares the page ready only out of loading, leaving a standing connection error by reference", () => {

    const first = loadedState();

    assert.deepEqual(first.status, { kind: "ready" }, "a first load out of loading declares the page ready");

    const errored = requestThenLoad(first, { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.equal(errored.status.kind, "connection-error", "precondition: the page carries a connection error");

    // A connection error ends on a clean device outcome or a fresh page cycle and nothing else. An establishment that declared the page ready would take the
    // frame away from the connection-error view while a plugin's controller card is rendering into it.
    const reloaded = reducer(errored, { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });

    assert.equal(reloaded.status, errored.status, "the error keeps its reference, so the view that owns the frame keeps it");
  });

  test("returns the write lifecycle to idle, since the load installs a fresh anchor", () => {

    const base = loadedState();
    const held = reducer(base, { type: "commit:started" });
    const failed = reducer(base, { error: new Error("The host refused the write."), type: "persist:failed" });
    const reload = { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" };

    assert.deepEqual(reducer(held, reload).write, { kind: "idle" }, "a hold does not survive the load that ends it");
    assert.deepEqual(reducer(failed, reload).write, { kind: "idle" }, "and neither does a failed persist, whose anchor is gone");
  });
});

/* A load over a standing page can carry a controller list that no longer holds the controller the user is looking at. Every fact in state that names one is
 * checked against the arriving list by serial, independently, and answered on its own terms. These rows drive each fact in both directions - a list that dropped
 * the controller and a list that still holds it - because a reconciliation that fired on a held controller would be as wrong as one that missed a departed one.
 */
describe("reducer - model:loaded reconciles the facts that name a controller", () => {

  const CONTROLLER_A = { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" };

  const controllerBased = () => loadedState({ controllers: [CONTROLLER_A], mode: "controller-based" });

  const reload = (state, controllers) => reducer(state, {

    catalog: CATALOG, configuredOptions: [], controllers, mode: "controller-based", type: "model:loaded"
  });

  test("a selection naming a departed controller falls back to global, and a held one keeps its reference", () => {

    const controllerScope = reducer(controllerBased(), { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });
    const deviceScope = reducer(controllerBased(), { scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.deepEqual(reload(controllerScope, []).scope, { kind: "global" }, "a controller selection the list cannot place falls back to global");
    assert.deepEqual(reload(deviceScope, []).scope, { kind: "global" }, "and so does a device selection under that controller");
    assert.equal(reload(controllerScope, [CONTROLLER_A]).scope, controllerScope.scope, "a held controller keeps the selection by reference");
    assert.equal(reload(deviceScope, [CONTROLLER_A]).scope, deviceScope.scope, "and so does a device under a held one");
  });

  test("a device list whose controller is gone is emptied and disowned, and a held one keeps its references", () => {

    const withDevices = requestThenLoad(controllerBased(), { controllerId: "ctrl-a", devices: DEVICES });

    assert.equal(withDevices.devices, DEVICES, "precondition: controller A's devices are loaded");

    const dropped = reload(withDevices, []);

    assert.deepEqual(dropped.devices, [], "the device list is emptied");
    assert.notEqual(dropped.devices, withDevices.devices, "with a fresh array, not the departed controller's");
    assert.equal(dropped.devicesControllerId, null, "and nothing owns it any more");

    const kept = reload(withDevices, [CONTROLLER_A]);

    assert.equal(kept.devices, withDevices.devices, "a held controller keeps its device list by reference");
    assert.equal(kept.devicesControllerId, "ctrl-a", "and goes on owning it");
  });

  test("the nothing-to-list notice leaves with the controller it described", () => {

    const NOTICE = "This controller has no cameras adopted.";
    const withNotice = requestThenLoad(controllerBased(), { controllerId: "ctrl-a", emptyMessage: NOTICE });

    assert.equal(withNotice.devicesEmptyMessage, NOTICE, "precondition: the notice is recorded");
    assert.equal(reload(withNotice, []).devicesEmptyMessage, null, "a departed controller takes its notice with it");
    assert.equal(reload(withNotice, [CONTROLLER_A]).devicesEmptyMessage, NOTICE, "a held one keeps it");
  });

  test("a fetch pending against a departed controller is cleared, and its late outcome then drops", () => {

    const pending = reducer(controllerBased(), { controllerId: "ctrl-a", type: "devices:requested" });
    const seq = pending.devicesRequest.seq;
    const reloaded = reload(pending, []);

    assert.equal(reloaded.devicesRequest, null, "the pending fetch names a controller the list cannot place, so it is cleared");

    const late = reducer(reloaded, { controllerId: "ctrl-a", devices: DEVICES, error: "", seq, type: "devices:loaded" });

    assert.equal(late, reloaded, "its late outcome falls to the existing sequence rule and returns the state by reference");
    assert.equal(reload(pending, [CONTROLLER_A]).devicesRequest, pending.devicesRequest, "a held controller keeps the pending fetch by reference");
  });

  test("device-only state is untouched: a null id names no controller, so there is nothing to take away", () => {

    const deviceOnly = reducer(requestThenLoad(loadedState(), { controllerId: null, devices: DEVICES }),
      { scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.equal(deviceOnly.devicesControllerId, null, "precondition: device-only mode owns its list under no controller");

    const reloaded = reducer(deviceOnly, { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });

    assert.equal(reloaded.devices, deviceOnly.devices, "the device list survives an empty controller list");
    assert.equal(reloaded.devicesControllerId, null, "and so does its null owner");
    assert.equal(reloaded.scope, deviceOnly.scope, "the selection keeps its reference, null controllerId and all");
    assert.equal(reloaded.devicesRequest, deviceOnly.devicesRequest, "and so does the pending slot");
  });
});

describe("reducer - controllers:loaded", () => {

  test("replaces only the controllers field without re-loading the model", () => {

    const initial = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: [], controllers: [], mode: "controller-based", type: "model:loaded"
    });
    const refreshed = [{ address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" }];
    const next = reducer(initial, { controllers: refreshed, type: "controllers:loaded" });

    assert.equal(next.controllers, refreshed);
    assert.equal(next.catalog, initial.catalog, "catalog unchanged - reference preserved");
    assert.equal(next.configuredOptions, initial.configuredOptions, "configuredOptions unchanged");
  });
});

describe("reducer - devices:requested", () => {

  test("mints a monotonically increasing sequence and records the pending request", () => {

    const first = reducer(initialState(), { controllerId: "ctrl-a", type: "devices:requested" });

    assert.equal(first.devicesRequestSeq, 1, "the first request mints sequence 1");
    assert.deepEqual(first.devicesRequest, { controllerId: "ctrl-a", seq: 1 });

    const second = reducer(first, { controllerId: "ctrl-b", type: "devices:requested" });

    assert.equal(second.devicesRequestSeq, 2, "the counter advances monotonically");
    assert.deepEqual(second.devicesRequest, { controllerId: "ctrl-b", seq: 2 }, "the latest request owns the pending slot");
  });

  test("normalizes an absent controllerId to null (a device-only fetch)", () => {

    const next = reducer(initialState(), { type: "devices:requested" });

    assert.deepEqual(next.devicesRequest, { controllerId: null, seq: 1 });
  });
});

describe("reducer - devices:loaded", () => {

  test("an outcome that answers the pending request applies the devices and clears the pending slot", () => {

    const next = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: DEVICES });

    assert.equal(next.devices, DEVICES, "the device list is adopted");
    assert.equal(next.devicesControllerId, "ctrl-a", "the owning controller is recorded");
    assert.equal(next.devicesAppliedSeq, 1, "the applied sequence is recorded as the reducer's verdict fact");
    assert.equal(next.devicesRequest, null, "the pending slot is cleared once answered");
    assert.deepEqual(next.scope, { kind: "global" }, "scope not touched by devices:loaded - a dispatcher moves the selection separately");
  });

  test("an outcome whose sequence is superseded returns the identical state reference (dropped)", () => {

    // Two requests mint seq 1 then seq 2, so the pending slot holds seq 2. The seq-1 outcome arrives late and must drop, returning the SAME state reference so
    // subscribers reading reference equality see a no-op.
    const pending = reducer(reducer(initialState(), { controllerId: "ctrl-a", type: "devices:requested" }), { controllerId: "ctrl-a", type: "devices:requested" });
    const dropped = reducer(pending, { controllerId: "ctrl-a", devices: DEVICES, error: "", seq: 1, type: "devices:loaded" });

    assert.equal(dropped, pending, "the stale outcome returns the identical state reference");
  });

  test("same-controller race: the first fetch's outcome drops and the second's applies (the sequence, not the controllerId, is the identity)", () => {

    // Two fetches for the SAME controller. This is the row a controllerId-keyed implementation fails: swap the reducer's `action.seq !== state.devicesRequest.seq`
    // comparison for a controllerId comparison and the first outcome would wrongly apply here, since both fetches carry the same controllerId.
    const firstRequested = reducer(initialState(), { controllerId: "ctrl-a", type: "devices:requested" });
    const secondRequested = reducer(firstRequested, { controllerId: "ctrl-a", type: "devices:requested" });
    const firstSeq = firstRequested.devicesRequest.seq;
    const secondSeq = secondRequested.devicesRequest.seq;

    // The first fetch's outcome arrives first - superseded, so it drops.
    const afterFirst = reducer(secondRequested, { controllerId: "ctrl-a", devices: [], error: "", seq: firstSeq, type: "devices:loaded" });

    assert.equal(afterFirst, secondRequested, "the superseded first outcome drops");

    // The second fetch's outcome arrives - it answers the pending request and applies.
    const afterSecond = reducer(afterFirst, { controllerId: "ctrl-a", devices: DEVICES, error: "", seq: secondSeq, type: "devices:loaded" });

    assert.equal(afterSecond.devices, DEVICES, "the second (latest) outcome applies");
    assert.equal(afterSecond.devicesAppliedSeq, secondSeq);
  });

  test("same-controller race, reverse arrival: the second's outcome applies first and the first's drops after", () => {

    const firstRequested = reducer(initialState(), { controllerId: "ctrl-a", type: "devices:requested" });
    const secondRequested = reducer(firstRequested, { controllerId: "ctrl-a", type: "devices:requested" });

    // The second (latest) outcome arrives first and applies, clearing the pending slot.
    const afterSecond = reducer(secondRequested,
      { controllerId: "ctrl-a", devices: DEVICES, error: "", seq: secondRequested.devicesRequest.seq, type: "devices:loaded" });

    assert.equal(afterSecond.devices, DEVICES);
    assert.equal(afterSecond.devicesRequest, null, "the pending slot is cleared");

    // The first (superseded) outcome arrives after - no pending request remains, so it drops.
    const afterFirst = reducer(afterSecond, { controllerId: "ctrl-a", devices: [], error: "", seq: firstRequested.devicesRequest.seq, type: "devices:loaded" });

    assert.equal(afterFirst, afterSecond, "the late superseded outcome drops");
  });

  test("device-only round-trip: a null controllerId is normalized and applied", () => {

    const next = requestThenLoad(initialState(), { controllerId: null, devices: DEVICES });

    assert.equal(next.devices, DEVICES);
    assert.equal(next.devicesControllerId, null, "device-only mode records a null owning controller");
  });

  test("an outcome carrying a non-empty error applies the empty list AND transitions status to connection-error", () => {

    const next = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.deepEqual(next.devices, [], "a failed fetch applies its empty device list");
    assert.equal(next.devicesControllerId, "ctrl-a");
    assert.equal(next.status.kind, "connection-error", "a non-empty error moves the status to connection-error");
    assert.equal(next.status.message, "Controller unreachable.", "the controller-failure message is carried on the status");
  });

  test("an outcome against no pending request drops (the explicit null check, not an optional-chained comparison)", () => {

    // No devices:requested has run, so devicesRequest is null. A seq-carrying outcome must drop rather than apply - the explicit null check guards against an
    // optional-chained comparison reading undefined on both sides and wrongly applying.
    const base = initialState();
    const next = reducer(base, { controllerId: "ctrl-a", devices: DEVICES, error: "", seq: 1, type: "devices:loaded" });

    assert.equal(next, base, "the outcome drops against a null pending request, returning the identical state reference");
  });

  test("a seq-less outcome against no pending request drops - the case an optional-chained guard would wrongly apply", () => {

    // The discriminating case for the guard's explicit null check: with devicesRequest null AND no seq on the action, an optional-chained comparison reads undefined
    // on both sides and applies the outcome. This is the exact shape of an unpaired legacy dispatch, so its loud drop is what keeps such a fixture from passing
    // silently.
    const base = initialState();
    const next = reducer(base, { controllerId: "ctrl-a", devices: DEVICES, error: "", type: "devices:loaded" });

    assert.equal(next, base, "a seq-less outcome drops against a null pending request, returning the identical state reference");
  });

  test("an outcome carrying no copy overrides keeps the shared controller-failure wording - the sidebar click's path", () => {

    const next = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.equal(next.status.headline, "Unable to connect to the controller.", "an outcome with no headline keeps the shared controller-failure headline");
    assert.equal(next.status.guidance, "Verify the controller's connection details are correct, then retry.", "and the shared guidance with it");
  });

  test("an outcome carrying copy overrides renders them instead, so a bounded await's failure reads as itself", () => {

    // The show() path supplies its own per-site copy so a device fetch that never answered does not masquerade as a controller that answered with an error. The
    // reducer prefers what the dispatcher supplied and falls back to the shared constant only per-field.
    const requested = reducer(initialState(), { controllerId: "ctrl-a", type: "devices:requested" });
    const next = reducer(requested, {

      controllerId: "ctrl-a",
      devices: [],
      error: "The request did not complete within 30 seconds.",
      guidance: "Retry once the plugin is responding again.",
      headline: "The plugin stopped responding while retrieving the device list.",
      seq: requested.devicesRequest.seq,
      type: "devices:loaded"
    });

    assert.equal(next.status.kind, "connection-error", "the failure still transitions the status");
    assert.equal(next.status.headline, "The plugin stopped responding while retrieving the device list.", "the supplied headline is what renders");
    assert.equal(next.status.guidance, "Retry once the plugin is responding again.", "the supplied guidance is what renders");
    assert.equal(next.status.message, "The request did not complete within 30 seconds.", "the per-fetch message is still carried along as it always did");
  });

  test("copy overrides are preferred per-field, so a headline alone keeps the shared guidance", () => {

    const requested = reducer(initialState(), { controllerId: "ctrl-a", type: "devices:requested" });
    const next = reducer(requested, {

      controllerId: "ctrl-a",
      devices: [],
      error: "boom",
      headline: "Unable to retrieve the device list.",
      seq: requested.devicesRequest.seq,
      type: "devices:loaded"
    });

    assert.equal(next.status.headline, "Unable to retrieve the device list.", "the supplied headline applies");
    assert.equal(next.status.guidance, "Verify the controller's connection details are correct, then retry.", "the absent guidance falls back to the shared constant");
  });

  test("a successful outcome ignores copy overrides entirely - they only ever decorate a failure", () => {

    const requested = reducer(initialState(), { controllerId: "ctrl-a", type: "devices:requested" });
    const next = reducer(requested, {

      controllerId: "ctrl-a",
      devices: DEVICES,
      error: "",
      guidance: "never rendered",
      headline: "never rendered",
      seq: requested.devicesRequest.seq,
      type: "devices:loaded"
    });

    assert.equal(next.status.kind, "loading", "an empty error leaves the status untouched, copy fields or not");
    assert.equal(next.devices, DEVICES, "and the devices apply normally");
  });

  test("a clean outcome returns a standing connection-error status to ready", () => {

    // A device list that just arrived is the evidence that a controller can be reached, which is the one thing that ends the error the failed fetch raised. Without
    // it the retry view would hold over a healthy page for the rest of the session - nothing short of a full page re-entry sets ready otherwise.
    const failed = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.equal(failed.status.kind, "connection-error", "precondition: the failed fetch raised the error");

    const recovered = requestThenLoad(failed, { controllerId: "ctrl-b", devices: DEVICES });

    assert.equal(recovered.status.kind, "ready", "the clean outcome returns the status to ready");
    assert.equal(recovered.devices, DEVICES, "and applies its device list as any clean outcome does");
  });

  test("a clean EMPTY outcome recovers too - reachability, not device count, is what the error was about", () => {

    const failed = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });
    const recovered = requestThenLoad(failed, { controllerId: "ctrl-b", devices: [] });

    assert.equal(recovered.status.kind, "ready", "a controller that answered with no devices still answered");
  });

  test("recovery is confined to connection-error: the write lifecycle and loading are untouched by a clean outcome", () => {

    // What is happening to the configuration write is its own field - a write in flight, or a write that failed - and a device list says nothing about either.
    // Loading is left alone from the other end: model:loaded is what declares the page ready.
    const base = loadedState();
    const persisting = reducer(base, { snapshot: [], type: "persist:started" });
    const persistError = reducer(base, { error: new Error("disk full"), type: "persist:failed" });

    assert.equal(requestThenLoad(persisting, { devices: DEVICES }).write, persisting.write, "a persist in flight survives a clean outcome by reference");
    assert.equal(requestThenLoad(persistError, { devices: DEVICES }).write, persistError.write, "a failed persist survives a clean outcome by reference");
    assert.equal(requestThenLoad(initialState(), { devices: DEVICES }).status.kind, "loading", "a loading status is not promoted to ready by a device outcome");
  });

  test("a FAILED outcome arriving over a standing connection error re-raises rather than recovering", () => {

    // The recovery rule keys off the outcome's cleanliness, not off the status it is replacing, so a second failure still renders as a failure - with its own
    // message, since the second failure is the one the user is now looking at.
    const failed = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: [], error: "First failure." });
    const again = requestThenLoad(failed, { controllerId: "ctrl-a", devices: [], error: "Second failure." });

    assert.equal(again.status.kind, "connection-error", "the error stands");
    assert.equal(again.status.message, "Second failure.", "carrying the newer failure's message");
  });

  test("a dropped stale outcome cannot recover a standing connection error", () => {

    // Recovery lives past the sequence gate, so a superseded outcome returns the identical state and the error it would have cleared stands untouched.
    const failed = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });
    const pending = reducer(failed, { controllerId: "ctrl-b", type: "devices:requested" });
    const dropped = reducer(pending, { controllerId: "ctrl-b", devices: DEVICES, error: "", seq: pending.devicesRequest.seq - 1, type: "devices:loaded" });

    assert.equal(dropped, pending, "the stale outcome returns the identical state reference");
    assert.equal(dropped.status.kind, "connection-error", "and the standing error is untouched by it");
  });

  test("records the nothing-to-list message only for a clean, device-less outcome that named one", () => {

    const NOTICE = "This controller has no cameras adopted.";

    assert.equal(requestThenLoad(initialState(), { controllerId: "ctrl-a", emptyMessage: NOTICE }).devicesEmptyMessage, NOTICE,
      "clean + no devices + a message is the one shape that records");
    assert.equal(requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: DEVICES, emptyMessage: NOTICE }).devicesEmptyMessage, null,
      "an outcome that carried devices is not empty, whatever message came along");
    assert.equal(requestThenLoad(initialState(), { controllerId: "ctrl-a", emptyMessage: NOTICE, error: "Controller unreachable." }).devicesEmptyMessage, null,
      "a failure is never also an empty - the fold inherits the null through the applied spread");
    assert.equal(requestThenLoad(initialState(), { controllerId: "ctrl-a" }).devicesEmptyMessage, null,
      "an empty list with no message keeps the legacy reading, which is what the absent field has to mean");
    assert.equal(requestThenLoad(initialState(), { controllerId: "ctrl-a", emptyMessage: "" }).devicesEmptyMessage, null,
      "an empty-string message says nothing, so it records nothing rather than a blank notice");
  });

  test("a later outcome clears a recorded message, so it describes the list currently in state", () => {

    // The single-writer rule's whole point: a controller that gains a device stops being empty at the same moment its list stops being empty.
    const empty = requestThenLoad(initialState(), { controllerId: "ctrl-a", emptyMessage: "Nothing adopted yet." });

    assert.equal(empty.devicesEmptyMessage, "Nothing adopted yet.", "precondition: the message is recorded");
    assert.equal(requestThenLoad(empty, { controllerId: "ctrl-a", devices: DEVICES }).devicesEmptyMessage, null, "a refetch that returned devices clears it");
    assert.equal(requestThenLoad(empty, { controllerId: "ctrl-b" }).devicesEmptyMessage, null, "and so does an undecorated empty outcome from another controller");
  });

  test("initialState carries no nothing-to-list message", () => {

    assert.equal(initialState().devicesEmptyMessage, null);
  });
});

describe("connectionFailureCopy", () => {

  test("every registered site yields distinct copy for a failure and for an expiry", () => {

    for(const site of [ "controllers", "devices", "features", "sync" ]) {

      const failed = connectionFailureCopy({ expired: false, site });
      const expired = connectionFailureCopy({ expired: true, site });

      assert.ok(failed.guidance.length && failed.headline.length, site + " must carry both copy slots for a genuine failure");
      assert.ok(expired.guidance.length && expired.headline.length, site + " must carry both copy slots for an expiry");
      assert.notEqual(failed.headline, expired.headline, site + " must read differently when the host went quiet than when it answered with an error");
    }
  });

  test("each site's failure headline is distinct from every other site's, so a failure cannot masquerade as a different one", () => {

    const sites = [ "controllers", "devices", "features", "sync" ];
    const headlines = sites.flatMap((site) => [ connectionFailureCopy({ expired: false, site }).headline, connectionFailureCopy({ expired: true, site }).headline ]);

    assert.equal(new Set(headlines).size, headlines.length, "no two sites, in either failure kind, may share a headline");
  });

  test("an unregistered site throws rather than rendering a banner with empty text slots", () => {

    assert.throws(() => connectionFailureCopy({ expired: false, site: "devcies" }), {

      message: "FeatureOptionsState.connectionFailureCopy: no failure copy is registered for the site \"devcies\".",
      name: "Error"
    }, "a copy key typo is a bug at the dispatch site and must surface loudly, the reducer's own unknown-action policy");
  });

  test("the controller-failure rows share one guidance, and it names no place the plugin may not have", () => {

    const controllers = connectionFailureCopy({ expired: false, site: "controllers" });
    const devices = connectionFailureCopy({ expired: false, site: "devices" });

    assert.equal(controllers.guidance, "Verify the controller's connection details are correct, then retry.", "the controller-list failure reads the shared guidance");
    assert.equal(devices.guidance, controllers.guidance, "and the device-list failure reads the same one, so the two cannot drift apart");
    assert.doesNotMatch(controllers.guidance, /Settings tab/,
      "the framework's own copy names no host tab, because a consumer may keep its controller settings elsewhere");
  });

  test("a plugin's guidance replaces the controller-failure rows and leaves every other row alone", () => {

    const plugin = "Open the controller editor below to correct its address or credentials.";

    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, expired: false, site: "controllers" }).guidance, plugin,
      "a controller-list failure takes the plugin's guidance");
    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, expired: false, site: "devices" }).guidance, plugin,
      "and so does a device-list failure, the other way a controller reports trouble");
    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, expired: true, site: "devices" }).guidance, "Retry once the plugin is responding again.",
      "an expiry keeps the plugin-stopped-responding guidance - a host that went quiet is not controller trouble");
    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, expired: false, site: "sync" }).guidance,
      "Retry once the Homebridge server is reachable again.", "and a config-read failure is untouched, since it says nothing about a controller");
  });

  test("the headline is never touched by the guidance override", () => {

    const overridden = connectionFailureCopy({ controllerFailureGuidance: "Repair it here.", expired: false, site: "devices" });

    assert.equal(overridden.headline, connectionFailureCopy({ expired: false, site: "devices" }).headline,
      "what failed is the framework's to say, whoever wrote the remedy");
  });
});

describe("controllerNoticeCopy", () => {

  /* The one place the two sentences are written out. Every other suite reads them through this function so a reworded sentence cannot leave a stale copy of itself
   * behind in an assertion...which means this row is the only thing standing between a swapped pair and a page that tells a user with devices in the sidebar that
   * the controller has none. The words are what the user reads, so the contract is the words and which situation each one answers.
   */
  test("each situation gets the sentence that describes it", () => {

    assert.equal(controllerNoticeCopy({ devicesListed: false }), "This controller has no devices to configure.",
      "a controller that listed nothing has nothing to configure at any level");
    assert.equal(controllerNoticeCopy({ devicesListed: true }), "Select a device to configure its options.",
      "a controller that listed devices needs one of them picked, and saying it has none would be false");
  });
});

describe("reducer - scope:changed", () => {

  test("replaces the scope tag atomically", () => {

    const next = reducer(initialState(), { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.deepEqual(next.scope, { controllerId: "ctrl-a", kind: "controller" });
  });

  test("works for every scope kind", () => {

    const base = initialState();
    const global = reducer(base, { scope: { kind: "global" }, type: "scope:changed" });
    const controller = reducer(base, { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });
    const device = reducer(base, { scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" });
    const deviceOnly = reducer(base, { scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.equal(global.scope.kind, "global");
    assert.equal(controller.scope.kind, "controller");
    assert.equal(device.scope.kind, "device");
    assert.equal(deviceOnly.scope.controllerId, null, "device-only mode device scope carries controllerId: null");
  });

  test("rejects a non-global scope in global-only mode but allows it in the device-bearing modes", () => {

    // A store in each mode, built through model:loaded so state.mode is set exactly as production sets it.
    const globalOnly = reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "global-only", type: "model:loaded" });
    const deviceOnly = reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    const controllerBased = reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "controller-based", type: "model:loaded" });
    const controllerScope = { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" };
    const deviceScope = { scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" };

    // Global-only mode holds the scope fixed at global: a controller-kind or device-kind dispatch is a bug at the dispatch site and throws.
    assert.throws(() => reducer(globalOnly, controllerScope), /not permitted in global-only mode/, "a controller scope throws in global-only mode");
    assert.throws(() => reducer(globalOnly, deviceScope), /not permitted in global-only mode/, "a device scope throws in global-only mode");

    // A global scope stays permitted, including in global-only mode.
    assert.equal(reducer(globalOnly, { scope: { kind: "global" }, type: "scope:changed" }).scope.kind, "global", "a global scope is permitted in global-only mode");

    // The same non-global dispatches pass unchanged in the device-bearing modes - the guard is scoped to global-only.
    assert.equal(reducer(deviceOnly, controllerScope).scope.kind, "controller", "a controller scope is permitted in device-only mode");
    assert.equal(reducer(controllerBased, deviceScope).scope.kind, "device", "a device scope is permitted in controller-based mode");
  });
});

describe("reducer - option:set", () => {

  test("applies the pure transform - configuredOptions reference changes, catalog reference does not", () => {

    const loaded = reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    const next = reducer(loaded, { args: { enabled: true, option: "Motion.Detect" }, type: "option:set" });

    assert.notEqual(next.configuredOptions, loaded.configuredOptions, "configuredOptions is a fresh array");
    assert.equal(next.catalog, loaded.catalog, "catalog reference preserved - reference equality holds for slices the action does not touch");
    assert.deepEqual(next.configuredOptions, ["Enable.Motion.Detect"]);
  });

  test("scope-specific writes preserve the catalog's case in the emitted entry", () => {

    const loaded = reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    const next = reducer(loaded, { args: { enabled: true, id: "ABC123", option: "Audio.Volume", value: 75 }, type: "option:set" });

    assert.deepEqual(next.configuredOptions, ["Enable.Audio.Volume.ABC123=75"]);
  });
});

describe("reducer - option:armed / option:disarmed", () => {

  const loaded = () => reducer(initialState(), { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });

  test("arming records the row and disarming clears it, with configuredOptions untouched by both", () => {

    const base = loaded();
    const armed = reducer(base, { option: "Audio.Volume", type: "option:armed" });

    assert.equal(armed.armedOption, "Audio.Volume", "the armed row is recorded");
    assert.equal(armed.configuredOptions, base.configuredOptions, "arming persists nothing - the reference is untouched");

    const disarmed = reducer(armed, { type: "option:disarmed" });

    assert.equal(disarmed.armedOption, null, "disarming stands the row down");
    assert.equal(disarmed.configuredOptions, base.configuredOptions, "disarming persists nothing either");
  });

  test("every configuration mutation and navigation disarms an armed row", () => {

    const armed = reducer(loaded(), { option: "Audio.Volume", type: "option:armed" });

    // The whole invalidation surface: a commit anywhere, a clear, a reset, a revert, a rollback, a selection move, and a reload each stand the armed row down.
    assert.equal(reducer(armed, { args: { enabled: true, option: "Motion.Detect" }, type: "option:set" }).armedOption, null, "a commit disarms");
    assert.equal(reducer(armed, { args: { option: "Motion.Detect" }, type: "option:cleared" }).armedOption, null, "a clear disarms");
    assert.equal(reducer(armed, { type: "options:reset" }).armedOption, null, "a reset disarms");
    assert.equal(reducer(armed, { type: "model:reverted" }).armedOption, null, "a revert disarms");
    assert.equal(reducer(armed, { error: new Error("boom"), type: "persist:failed" }).armedOption, null, "a persist rollback disarms");
    assert.equal(reducer(armed, { scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" }).armedOption, null,
      "a selection move disarms");
    assert.equal(reducer(armed, { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" }).armedOption, null,
      "a model reload disarms");
  });
});

describe("reducer - option:cleared", () => {

  test("removes matching entries and produces a fresh array reference", () => {

    const loaded = reducer(initialState(), {

      catalog: CATALOG,
      configuredOptions: [ "Enable.Motion.Detect", "Enable.Audio.Volume.50" ],
      controllers: [],
      mode: "device-only",
      type: "model:loaded"
    });
    const next = reducer(loaded, { args: { option: "Audio.Volume" }, type: "option:cleared" });

    assert.deepEqual(next.configuredOptions, ["Enable.Motion.Detect"]);
    assert.notEqual(next.configuredOptions, loaded.configuredOptions, "fresh reference because contents changed");
  });

  test("preserves the configuredOptions reference when nothing matches - no-op cascades through the reducer", () => {

    const loaded = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: ["Enable.Motion.Detect"], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const next = reducer(loaded, { args: { option: "Audio.Volume" }, type: "option:cleared" });

    assert.equal(next.configuredOptions, loaded.configuredOptions, "reference-stable on no-op so memoized selectors hit their caches");
  });
});

describe("reducer - options:reset", () => {

  test("replaces configuredOptions with an empty array; initialOptions and persistedAnchor unchanged", () => {

    const loaded = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: ["Enable.Motion.Detect"], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const next = reducer(loaded, { type: "options:reset" });

    assert.deepEqual(next.configuredOptions, []);
    assert.equal(next.initialOptions, loaded.initialOptions, "initialOptions reference preserved - revert can still restore it");
    assert.equal(next.persistedAnchor, loaded.persistedAnchor, "persistedAnchor reference preserved - rollback target unchanged");
  });
});

describe("reducer - model:reverted", () => {

  test("restores configuredOptions to the initialOptions snapshot", () => {

    const initial = ["Enable.Motion.Detect"];
    const loaded = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: initial, controllers: [], mode: "device-only", type: "model:loaded"
    });
    const mutated = reducer(loaded, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const reverted = reducer(mutated, { type: "model:reverted" });

    assert.equal(reverted.configuredOptions, initial, "configuredOptions reference IS the initialOptions reference after revert");
    assert.deepEqual(reverted.configuredOptions, ["Enable.Motion.Detect"]);
  });
});

describe("reducer - filter:changed", () => {

  test("updates query while preserving mode when only query is supplied", () => {

    const next = reducer(initialState(), { query: "motion", type: "filter:changed" });

    assert.equal(next.filter.query, "motion");
    assert.equal(next.filter.mode, "all", "mode preserved");
  });

  test("updates mode while preserving query when only mode is supplied", () => {

    const withQuery = reducer(initialState(), { query: "audio", type: "filter:changed" });
    const next = reducer(withQuery, { mode: "modified", type: "filter:changed" });

    assert.equal(next.filter.query, "audio", "query preserved");
    assert.equal(next.filter.mode, "modified");
  });

  test("allocates a fresh filter object so reference equality detects the change", () => {

    const base = initialState();
    const next = reducer(base, { query: "x", type: "filter:changed" });

    assert.notEqual(next.filter, base.filter);
  });
});

describe("reducer - persist lifecycle", () => {

  test("persist:started moves the write lifecycle to persisting and carries the snapshot", () => {

    const snapshot = ["Enable.Motion.Detect"];
    const base = initialState();

    assert.deepEqual(base.write, { kind: "idle" }, "precondition: a fresh store has nothing in flight");

    const next = reducer(base, { snapshot, type: "persist:started" });

    assert.equal(next.write.kind, "persisting");
    assert.equal(next.write.snapshot, snapshot);
    assert.equal(next.status, base.status, "reachability is a separate fact and keeps its reference");
  });

  test("persist:succeeded promotes the snapshot to the anchor and returns the write lifecycle to idle", () => {

    const persisting = reducer(initialState(), { snapshot: ["Enable.Motion.Detect"], type: "persist:started" });
    const next = reducer(persisting, { snapshot: ["Enable.Motion.Detect"], type: "persist:succeeded" });

    assert.equal(next.write.kind, "idle");
    assert.deepEqual(next.persistedAnchor, ["Enable.Motion.Detect"]);
    assert.equal(next.status, persisting.status, "reachability keeps its reference");
  });

  test("persist:failed rolls configuredOptions back to the anchor and moves the write lifecycle to persist-error", () => {

    const initial = ["Enable.Motion.Detect"];
    const loaded = loadedState({ configuredOptions: initial });

    // Simulate the optimistic-apply: mutate the model in memory, then persist failure rolls back.
    const mutated = reducer(loaded, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const error = new Error("Disk write failed");
    const failed = reducer(mutated, { error, type: "persist:failed" });

    assert.equal(failed.configuredOptions, loaded.persistedAnchor, "configuredOptions reverts to the anchor reference");
    assert.equal(failed.write.kind, "persist-error");
    assert.equal(failed.write.error, error);
    assert.equal(failed.status, mutated.status, "reachability keeps its reference");
  });
});

/* The lifecycles the state holds apart. Reachability answers whether the page can be reached; the write lifecycle answers what is happening to the configuration
 * write. They co-occur - a save can be in flight, or can have failed, while a controller cannot be reached - so these rows drive one while the other stands and
 * assert that neither transition reaches across.
 */
describe("reducer - page reachability and the write lifecycle are independent", () => {

  test("a persist action leaves a standing connection error in place by reference, while still promoting the anchor and rolling back", () => {

    const base = loadedState({ configuredOptions: ["Enable.Motion.Detect"] });
    const errored = requestThenLoad(base, { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.equal(errored.status.kind, "connection-error", "precondition: the failed fetch raised the error");

    const snapshot = ["Enable.Audio.Volume.50"];
    const started = reducer(errored, { snapshot, type: "persist:started" });

    assert.equal(started.status, errored.status, "persist:started leaves the error in place by reference");
    assert.equal(started.write.snapshot, snapshot, "and carries the snapshot on the write lifecycle");

    const succeeded = reducer(started, { snapshot, type: "persist:succeeded" });

    assert.equal(succeeded.status, errored.status, "persist:succeeded leaves it in place by reference");
    assert.equal(succeeded.persistedAnchor, snapshot, "and still promotes the snapshot to the anchor");

    const error = new Error("The host refused the write.");
    const mutated = reducer(errored, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const failed = reducer(mutated, { error, type: "persist:failed" });

    assert.equal(failed.status, errored.status, "persist:failed leaves it in place by reference");
    assert.equal(failed.configuredOptions, errored.persistedAnchor, "and still rolls configuredOptions back to the anchor");
    assert.equal(failed.write.error, error, "carrying the error on the write lifecycle");
  });

  test("a device outcome leaves the write lifecycle by reference whatever it holds, clean or failed", () => {

    const base = loadedState();
    const writeStates = {

      committing: reducer(base, { type: "commit:started" }),
      "persist-error": reducer(base, { error: new Error("The host refused the write."), type: "persist:failed" }),
      persisting: reducer(base, { snapshot: [], type: "persist:started" })
    };

    for(const [ kind, state ] of Object.entries(writeStates)) {

      assert.equal(state.write.kind, kind, "precondition: the write lifecycle holds " + kind);
      assert.equal(requestThenLoad(state, { controllerId: "ctrl-a", devices: DEVICES }).write, state.write,
        "a clean outcome leaves " + kind + " by reference");
      assert.equal(requestThenLoad(state, { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." }).write, state.write,
        "and a failed outcome leaves " + kind + " by reference too");
    }
  });

  test("reachability walks to connection-error and back under a coordinated write, and the hold stands throughout", () => {

    // The hole a single slot would leave open. With one field carrying them, the failed fetch would overwrite the hold and the clean one would then declare the
    // page ready, unlocking the table in the middle of a write nobody told the store had ended.
    const held = reducer(loadedState(), { type: "commit:started" });

    assert.equal(held.write.kind, "committing", "precondition: the hold is taken");

    const errored = requestThenLoad(held, { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.equal(errored.status.kind, "connection-error", "a failed fetch moves reachability");
    assert.equal(errored.write, held.write, "and leaves the hold by reference");

    const recovered = requestThenLoad(errored, { controllerId: "ctrl-a", devices: DEVICES });

    assert.equal(recovered.status.kind, "ready", "a clean fetch walks reachability back");
    assert.equal(recovered.write, held.write, "and the hold is still the very same object, twice untouched");
    assert.equal(reducer(recovered, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" }), recovered,
      "so an option mutation is still refused by reference");
  });
});

describe("reducer - commit:started", () => {

  test("takes the hold from a loaded, idle, clean store and stands an armed row down", () => {

    const armed = reducer(loadedState(), { option: "Audio.Volume", type: "option:armed" });

    assert.equal(armed.armedOption, "Audio.Volume", "precondition: a row is armed");

    const held = reducer(armed, { type: "commit:started" });

    assert.deepEqual(held.write, { kind: "committing" });
    assert.equal(held.armedOption, null, "an armed row is an edit in progress, and the hold ends it");
    assert.equal(held.configuredOptions, armed.configuredOptions, "the configuration itself is untouched");
    assert.equal(held.status, armed.status, "and so is reachability");
  });

  test("refuses by reference from every state that has its own claim on the store", () => {

    const base = loadedState();
    const unloaded = initialState();
    const persisting = reducer(base, { snapshot: [], type: "persist:started" });
    const persistError = reducer(base, { error: new Error("The host refused the write."), type: "persist:failed" });
    const dirty = reducer(base, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const held = reducer(base, { type: "commit:started" });

    assert.notEqual(dirty.configuredOptions, dirty.persistedAnchor, "precondition: the dirty store has an edit the page has not written yet");

    assert.equal(reducer(unloaded, { type: "commit:started" }), unloaded, "a placeholder store has no configuration worth bracketing");
    assert.equal(reducer(persisting, { type: "commit:started" }), persisting, "a persist already in flight has its own claim");
    assert.deepEqual(reducer(persistError, { type: "commit:started" }).write, { kind: "committing" },
      "while a persist that failed is a record rather than a claim, so the hold is taken over it");
    assert.equal(reducer(dirty, { type: "commit:started" }), dirty, "a dirty store would strand the edit it is holding");
    assert.equal(reducer(held, { type: "commit:started" }), held, "and a hold already taken is not taken a second time");
  });

  test("every option-mutating action is refused by reference while the hold stands", () => {

    /* Each action is paired with the field it moves, so the precondition asserts a real change on an idle store rather than the fresh top-level object every arm
     * produces - without that pairing the row would pass against a reducer that refuses nothing.
     *
     * The base state carries an initial snapshot that differs from its configured options, which is what gives model:reverted something to restore, while
     * configuredOptions still equals the anchor so commit:started can take the hold at all.
     */
    const base = reducer(initialState(), {

      catalog: CATALOG,
      configuredOptions: ["Enable.Motion.Detect"],
      controllers: [],
      initialOptions: [],
      mode: "device-only",
      type: "model:loaded"
    });
    const held = reducer(base, { type: "commit:started" });
    const mutations = [

      { action: { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" }, field: "configuredOptions" },
      { action: { args: { option: "Motion.Detect" }, type: "option:cleared" }, field: "configuredOptions" },
      { action: { option: "Audio.Volume", type: "option:armed" }, field: "armedOption" },
      { action: { type: "options:reset" }, field: "configuredOptions" },
      { action: { type: "model:reverted" }, field: "configuredOptions" }
    ];

    assert.equal(held.write.kind, "committing", "precondition: the hold is taken");

    for(const { action, field } of mutations) {

      assert.notEqual(reducer(base, action)[field], base[field], "precondition: " + action.type + " moves " + field + " on an idle store");
      assert.equal(reducer(held, action), held, action.type + " is refused by reference while the hold stands");
    }
  });

  test("an action outside the refused set still applies while the hold stands", () => {

    // Standing a row down ends a gesture rather than beginning one, navigation and filtering write nothing, and a fetch or a controller refresh is not an edit at
    // all...so each of these reaches its arm and returns a new state rather than the held reference.
    const held = reducer(loadedState({ controllers: [{ address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" }] }), { type: "commit:started" });
    const permitted = [

      { type: "option:disarmed" },
      { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" },
      { query: "motion", type: "filter:changed" },
      { controllerId: "ctrl-a", type: "devices:requested" },
      { controllers: [], type: "controllers:loaded" }
    ];

    for(const action of permitted) {

      assert.notEqual(reducer(held, action), held, action.type + " is not held: it reaches its arm and returns a new state");
    }
  });
});

describe("reducer - commit:failed", () => {

  test("lifts the hold and touches nothing else", () => {

    const base = loadedState({ configuredOptions: ["Enable.Motion.Detect"] });
    const held = reducer(base, { type: "commit:started" });
    const lifted = reducer(held, { type: "commit:failed" });

    assert.deepEqual(lifted.write, { kind: "idle" });

    // The hold changed nothing but the write lifecycle, so there is nothing else to put back. Walking every key is what makes that a contract rather than a claim
    // about the fields this row happened to think of.
    for(const field of Object.keys(held)) {

      if(field === "write") {

        continue;
      }

      assert.equal(lifted[field], held[field], field + " comes back by reference");
    }
  });

  test("returns the state by reference from any other write state", () => {

    const base = loadedState();
    const persisting = reducer(base, { snapshot: [], type: "persist:started" });

    assert.equal(reducer(base, { type: "commit:failed" }), base, "an idle store is not a hold this action ends");
    assert.equal(reducer(persisting, { type: "commit:failed" }), persisting, "and neither is a persist in flight");
  });
});

describe("reducer - connection:error", () => {

  test("transitions status to connection-error with the user-facing message", () => {

    const next = reducer(initialState(), { message: "Controller unreachable.", type: "connection:error" });

    assert.equal(next.status.kind, "connection-error");
    assert.equal(next.status.message, "Controller unreachable.");
  });
});

describe("reducer - structural sharing", () => {

  test("a dispatch that touches one slice leaves every other slice's reference unchanged", () => {

    const loaded = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: ["Enable.Motion.Detect"], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const next = reducer(loaded, { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.notEqual(next, loaded, "top-level reference changes");
    assert.notEqual(next.scope, loaded.scope, "the touched slice gets a new reference");
    assert.equal(next.catalog, loaded.catalog, "untouched slice reference preserved");
    assert.equal(next.configuredOptions, loaded.configuredOptions, "untouched slice reference preserved");
    assert.equal(next.filter, loaded.filter, "untouched slice reference preserved");
    assert.equal(next.controllers, loaded.controllers, "untouched slice reference preserved");
    assert.equal(next.status, loaded.status, "untouched slice reference preserved");
  });
});

describe("reducer - error handling", () => {

  test("throws on an unknown action type so the typo is surfaced at the dispatch site", () => {

    assert.throws(() => reducer(initialState(), { type: "bogus:action" }), /unknown action type "bogus:action"/);
  });
});

/* The engine refuses an address it cannot assign to the option asked for, and the page's device identifiers come from the plugin rather than from anything the
 * user typed. Both arms therefore have to survive a plugin that hands over an unusable one: the gesture writes nothing, the state reference comes back untouched
 * so every subscriber reads a no-op, and the page stays under the user's hands. Each row drives one of the refusals the engine tells apart.
 */
describe("reducer - a write the engine refuses", () => {

  // The catalog whose shorter option name prefixes a longer one, which is what lets an ordinary-looking device identifier compose another option's own address.
  const COLLIDING_CATALOG = {

    ...buildCatalogIndex([{ description: "Motion Options", name: "Motion" }], {

      Motion: [

        { default: true, description: "Enable motion detection.", name: "Detect" },
        { default: false, description: "Detection sensitivity.", name: "Detect.Sensitivity" }
      ]
    }),

    validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
  };

  test("option:set with a reserved-character id writes nothing and reports the refusal", (t) => {

    // The observation mechanism is a mock over console.error: it captures the report and keeps the deliberate refusal out of the suite's own output.
    const reported = t.mock.method(console, "error", () => {});
    const loaded = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: ["Enable.Motion.Detect"], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const next = reducer(loaded, { args: { enabled: true, id: "a=b", option: "Motion.Detect" }, type: "option:set" });

    assert.equal(next, loaded, "the state object itself comes back, so the dispatch reads as a no-op everywhere downstream");
    assert.equal(reported.mock.callCount(), 1, "the refusal is reported once");
  });

  test("option:cleared with an id naming another catalog option deletes nothing and reports the refusal", (t) => {

    const reported = t.mock.method(console, "error", () => {});
    const loaded = reducer(initialState(), {

      catalog: COLLIDING_CATALOG, configuredOptions: ["Enable.Motion.Detect.Sensitivity"], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const next = reducer(loaded, { args: { id: "Sensitivity", option: "Motion.Detect" }, type: "option:cleared" });

    assert.equal(next, loaded, "the clear is a no-op rather than a state transition");
    assert.deepEqual(next.configuredOptions, ["Enable.Motion.Detect.Sensitivity"], "the entry the clear would have deleted is still there");
    assert.equal(reported.mock.callCount(), 1, "the refusal is reported once");
  });
});
