/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/state.test.mjs: Unit tests for the state shape, action vocabulary, and reducer.
 */
"use strict";

import { CONTROLLERS_EMPTY_NOTICE, connectionFailureCopy, connectionFailureKind, controllerNoticeCopy, initialState, reconciledControllerId, reducer,
  renameHonored, settledFactsMoved } from "./state.mjs";
import { describe, test } from "node:test";
import { DeadlineExpiredError } from "../webUi-liveness.mjs";
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
    assert.deepEqual(state.stagedAnchor, []);
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

  test("the placeholder catalog's validators are permissive except isController, which excludes every device", () => {

    const { validators } = initialState().catalog;

    assert.equal(validators.isController({}), false, "nothing is a controller before a model names one");
    assert.equal(validators.validOption(undefined, {}), true, "every option is admitted while the real catalog is still absent");
    assert.equal(validators.validOptionCategory(undefined, {}), true, "and so is every category, so a speculative read hides nothing");
  });
});

describe("reducer - model:loaded", () => {

  test("seeds catalog, configuredOptions, controllers, mode; sets initialOptions and stagedAnchor to the loaded options; transitions status to ready", () => {

    const configuredOptions = ["Enable.Motion.Detect"];
    const controllers = [{ address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" }];
    const next = reducer(initialState(), { catalog: CATALOG, configuredOptions, controllers, mode: "controller-based", type: "model:loaded" });

    assert.equal(next.catalog, CATALOG);
    assert.equal(next.configuredOptions, configuredOptions, "configuredOptions reference preserved from the action - structural sharing");
    assert.equal(next.initialOptions, configuredOptions, "initialOptions seeded with the same reference for revert");
    assert.equal(next.stagedAnchor, configuredOptions, "stagedAnchor seeded with the same reference for rollback");
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
      /unknown mode/);
  });

  test("throws when the dispatch carries no catalog, naming the missing piece", () => {

    // Catalog identity is what tells a loaded store from a fresh one, so a dispatch that installed a missing catalog would corrupt that signal while the page
    // rendered as ready. A dispatch-site bug leaves the field absent or leaves it null, and each has to reach the same loud failure.
    for(const catalog of [ undefined, null ]) {

      assert.throws(() => reducer(initialState(), { catalog, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" }), /carried no catalog/);
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
    const failed = reducer(base, { error: new Error("The host refused the write."), type: "staging:failed" });
    const reload = { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" };

    assert.deepEqual(reducer(held, reload).write, { kind: "idle" }, "a hold does not survive the load that ends it");
    assert.deepEqual(reducer(failed, reload).write, { kind: "idle" }, "and neither does a failed stage, whose anchor is gone");
  });
});

/* A list arrival over a standing page can carry a controller list that no longer holds, or renames, the controller the user is looking at. Every action that
 * installs a list runs the one reconciliation, so every row below runs against each of them from this one table: a row that held for one arrival and failed for
 * another would be the arms drifting apart. Every fact in state that names a controller is checked against the arriving list by serial, independently, and
 * answered on its own terms, so these rows drive each fact in both directions - a list that dropped the controller and a list that still holds it - because a
 * reconciliation that fired on a held controller would be as wrong as one that missed a departed one.
 */
const CONTROLLER_A = { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" };
const CONTROLLER_B = { address: "10.0.0.2", name: "Controller B", serialNumber: "ctrl-b" };

// Controller A after a write edited its address: the plugin keys the sidebar by address, so the same controller arrives under a new key.
const RENAMED_A = { address: "10.0.0.9", name: "Controller A", serialNumber: "ctrl-a2" };
const RENAME_A = { from: "ctrl-a", to: "ctrl-a2" };

const LIST_ARRIVALS = [

  {

    arrive: ({ controllers, rename = undefined, state }) => reducer(state, {

      catalog: CATALOG, configuredOptions: [], controllers, mode: state.mode, rename, type: "model:loaded"
    }),
    type: "model:loaded"
  },
  {

    arrive: ({ controllers, rename = undefined, state }) => reducer(state, { controllers, rename, type: "controllers:loaded" }),
    type: "controllers:loaded"
  }
];

for(const { arrive, type } of LIST_ARRIVALS) {

  describe("reducer - " + type + " reconciles the facts that name a controller", () => {

    const controllerBased = (controllers = [CONTROLLER_A]) => loadedState({ controllers, mode: "controller-based" });

    const reload = (state, controllers, rename = undefined) => arrive({ controllers, rename, state });

    const select = (state, scope) => reducer(state, { origin: "user", scope, type: "scope:changed" });

    test("a selection naming a departed controller falls back to global, and a held one keeps its reference", () => {

      const controllerScope = select(controllerBased(), { controllerId: "ctrl-a", kind: "controller" });
      const deviceScope = select(controllerBased(), { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" });

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

      const deviceOnly = select(requestThenLoad(loadedState(), { controllerId: null, devices: DEVICES }), { controllerId: null, deviceId: "dev-a", kind: "device" });

      assert.equal(deviceOnly.devicesControllerId, null, "precondition: device-only mode owns its list under no controller");

      const reloaded = reload(deviceOnly, []);

      assert.equal(reloaded.devices, deviceOnly.devices, "the device list survives an empty controller list");
      assert.equal(reloaded.devicesControllerId, null, "and so does its null owner");
      assert.equal(reloaded.scope, deviceOnly.scope, "the selection keeps its reference, null controllerId and all");
      assert.equal(reloaded.devicesRequest, deviceOnly.devicesRequest, "and so does the pending slot");
    });

    test("a proven rename carries a controller selection to the new key, and a device selection with its device intact", () => {

      const controllerScope = select(controllerBased(), { controllerId: "ctrl-a", kind: "controller" });
      const deviceScope = select(controllerBased(), { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" });

      // The same two lists without the declaration read as a removal plus an addition, which is the case the declaration exists to tell apart.
      assert.deepEqual(reload(controllerScope, [RENAMED_A]).scope, { kind: "global" }, "precondition: undeclared, the lists drop the selection to global");

      assert.deepEqual(reload(controllerScope, [RENAMED_A], RENAME_A).scope, { controllerId: "ctrl-a2", kind: "controller" },
        "a controller selection follows its controller onto the new key");
      assert.deepEqual(reload(deviceScope, [RENAMED_A], RENAME_A).scope, { controllerId: "ctrl-a2", deviceId: "dev-a", kind: "device" },
        "and a device selection keeps its kind and its device while its controller moves");
    });

    test("a proven rename hands the old key's device list to the new key, list and notice by reference", () => {

      const NOTICE = "This controller has no cameras adopted.";
      const withDevices = requestThenLoad(controllerBased(), { controllerId: "ctrl-a", devices: DEVICES });
      const withNotice = requestThenLoad(controllerBased(), { controllerId: "ctrl-a", emptyMessage: NOTICE });
      const renamed = reload(withDevices, [RENAMED_A], RENAME_A);

      assert.equal(renamed.devicesControllerId, "ctrl-a2", "the new key owns the loaded list");
      assert.equal(renamed.devices, withDevices.devices, "and it is the very list the old key owned");
      assert.equal(reload(withNotice, [RENAMED_A], RENAME_A).devicesEmptyMessage, NOTICE, "a notice the list carried goes with it");
    });

    test("a proven rename leaves a selection naming another controller, or global, by reference", () => {

      const standing = [ CONTROLLER_A, CONTROLLER_B ];
      const arriving = [ RENAMED_A, CONTROLLER_B ];
      const onB = select(controllerBased(standing), { controllerId: "ctrl-b", kind: "controller" });
      const onGlobal = controllerBased(standing);

      assert.equal(renameHonored({ arriving, rename: RENAME_A, standing }), true, "precondition: the lists prove the rename");
      assert.equal(reload(onB, arriving, RENAME_A).scope, onB.scope, "a user on another controller stays exactly where they are");
      assert.equal(reload(onGlobal, arriving, RENAME_A).scope, onGlobal.scope, "and so does one on global");
    });

    test("a proven rename clears a fetch pending against the old key, and its late outcome then drops", () => {

      const pending = reducer(select(controllerBased(), { controllerId: "ctrl-a", kind: "controller" }), { controllerId: "ctrl-a", type: "devices:requested" });
      const seq = pending.devicesRequest.seq;
      const renamed = reload(pending, [RENAMED_A], RENAME_A);

      assert.deepEqual(renamed.scope, { controllerId: "ctrl-a2", kind: "controller" }, "precondition: the selection moved with the rename");
      assert.equal(renamed.devicesRequest, null, "the fetch was asked of the old identity, so it is cleared rather than carried");

      const late = reducer(renamed, { controllerId: "ctrl-a", devices: DEVICES, error: "", seq, type: "devices:loaded" });

      assert.equal(late, renamed, "its late outcome drops, so nothing fetched from the old address lands under the new key");
    });

    test("an unproven rename is ignored, and the arrival reconciles exactly as though none were declared", () => {

      const SLICES = [ "devices", "devicesControllerId", "devicesEmptyMessage", "devicesRequest", "scope" ];

      // Each case is a standing state, the arriving list, and the declaration the lists fail to prove. The selection and the device list each name the old key,
      // so a rename honored by mistake would show in one of them.
      const onA = (controllers) => requestThenLoad(select(controllerBased(controllers), { controllerId: "ctrl-a", kind: "controller" }),
        { controllerId: "ctrl-a", devices: DEVICES });
      const cases = [

        { arriving: [CONTROLLER_B], label: "the new key absent from the arriving list", rename: RENAME_A, state: onA([CONTROLLER_A]) },
        { arriving: [ CONTROLLER_A, RENAMED_A ], label: "the old key still present in it", rename: RENAME_A, state: onA([CONTROLLER_A]) },
        { arriving: [CONTROLLER_A], label: "the old key equal to the new one", rename: { from: "ctrl-a", to: "ctrl-a" }, state: onA([CONTROLLER_A]) },
        { arriving: [RENAMED_A], label: "the new key already in the standing list", rename: RENAME_A, state: onA([ CONTROLLER_A, RENAMED_A ]) },
        { arriving: [ RENAMED_A, CONTROLLER_B ], label: "the old key absent from the standing list", rename: RENAME_A, state: onA([CONTROLLER_B]) }
      ];

      for(const { arriving, label, rename, state } of cases) {

        const declared = reload(state, arriving, rename);
        const undeclared = reload(state, arriving);

        assert.equal(renameHonored({ arriving, rename, standing: state.controllers }), false, label + ": the exported test refuses it");

        for(const slice of SLICES) {

          assert.deepEqual(declared[slice], undeclared[slice], label + ": " + slice + " reconciles as though nothing were declared");
        }

        assert.notEqual(declared.devicesControllerId, "ctrl-a2", label + ": and nothing was carried to the new key");
      }
    });

    test("a proven rename leaves state whose controller ids are null untouched", () => {

      const standing = [CONTROLLER_A];
      const nullOwned = select(requestThenLoad(controllerBased(standing), { controllerId: null, devices: DEVICES }),
        { controllerId: null, deviceId: "dev-a", kind: "device" });
      const renamed = reload(nullOwned, [RENAMED_A], RENAME_A);

      assert.equal(renameHonored({ arriving: [RENAMED_A], rename: RENAME_A, standing }), true, "precondition: the lists prove the rename");
      assert.equal(renamed.scope, nullOwned.scope, "a selection under no controller keeps its reference");
      assert.equal(renamed.devices, nullOwned.devices, "and so does the list no controller owns");
      assert.equal(renamed.devicesControllerId, null, "whose owner is still nobody");
    });
  });
}

describe("reducer - controllers:loaded", () => {

  test("installs the arriving list and, while it holds every controller a fact names, returns every other slice by reference", () => {

    const standing = requestThenLoad(reducer(loadedState({ controllers: [CONTROLLER_A], mode: "controller-based" }),
      { origin: "user", scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" }), { controllerId: "ctrl-a", devices: DEVICES });

    // The same controller under the same key with a different display name - the refresh a plugin makes after editing nothing that keys the sidebar.
    const refreshed = [{ ...CONTROLLER_A, name: "Controller A, renamed in the plugin" }];
    const next = reducer(standing, { controllers: refreshed, type: "controllers:loaded" });

    assert.equal(next.controllers, refreshed, "the arriving list is installed by reference");

    // Walking every key is what makes this a contract rather than a claim about the fields this row happened to think of: the model is not loaded again, and a
    // reconciliation that finds every named controller held moves nothing.
    for(const field of Object.keys(standing)) {

      if(field === "controllers") {

        continue;
      }

      assert.equal(next[field], standing[field], field + " comes back by reference");
    }
  });
});

describe("reducer - the empty-list sentence", () => {

  const SENTENCE = "Your gateways appear here once discovery finishes.";

  // A controller-based model load carrying the list and the sentence its controllers result supplied, the shape the page's own establishment dispatches.
  const loadList = (state, { controllers = [], controllersEmptyMessage = undefined } = {}) => reducer(state, {

    catalog: CATALOG, configuredOptions: [], controllers, controllersEmptyMessage, mode: "controller-based", type: "model:loaded"
  });

  test("a model:loaded records the sentence only for an empty list that came with one", () => {

    assert.equal(loadList(initialState(), { controllersEmptyMessage: SENTENCE }).controllersEmptyMessage, SENTENCE,
      "an empty list beside a sentence is the one shape that records");
    assert.equal(loadList(initialState(), { controllers: [CONTROLLER_A], controllersEmptyMessage: SENTENCE }).controllersEmptyMessage, null,
      "a list with a controller in it is not empty, whatever sentence came along");
    assert.equal(loadList(initialState()).controllersEmptyMessage, null, "an empty list with no sentence leaves the sidebar to the page's own");
    assert.equal(loadList(initialState(), { controllersEmptyMessage: "" }).controllersEmptyMessage, null,
      "an empty-string sentence says nothing, so it records nothing rather than a blank notice");
  });

  test("a later load and a list arrival each clear it, so it describes the list currently in state", () => {

    const empty = loadList(initialState(), { controllersEmptyMessage: SENTENCE });

    assert.equal(empty.controllersEmptyMessage, SENTENCE, "precondition: the sentence is recorded");
    assert.equal(loadList(empty).controllersEmptyMessage, null, "a reload whose result carried no sentence clears it, so an earlier answer never lingers");
    assert.equal(loadList(empty, { controllers: [CONTROLLER_A] }).controllersEmptyMessage, null, "and so does one that installs a controller");
    assert.equal(reducer(empty, { controllers: [CONTROLLER_A], type: "controllers:loaded" }).controllersEmptyMessage, null,
      "a list arriving without a model clears it along with the empty list it replaces");
  });

  test("a fresh store starts without one, and a re-entry inherits none from the page it replaces", () => {

    assert.equal(initialState().controllersEmptyMessage, null, "a fresh store carries no sentence");
    assert.equal(initialState(loadList(initialState(), { controllersEmptyMessage: SENTENCE })).controllersEmptyMessage, null,
      "a re-entered page reads its own boot's answer rather than the one the replaced page held");
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

  test("a failed outcome that names no copy carries none, because the reducer holds no prose of its own", () => {

    const next = requestThenLoad(initialState(), { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.equal(next.status.kind, "connection-error", "the failure still transitions the status");
    assert.equal(next.status.headline, undefined, "the headline is the dispatcher's to resolve, and this one named none");
    assert.equal(next.status.guidance, undefined, "and so is the guidance");
  });

  test("a failed outcome carries exactly the copy its dispatcher resolved, so a bounded await's failure reads as itself", () => {

    // The shared device fetch resolves the copy for the failure it met, so a device fetch that never answered does not masquerade as a controller that answered
    // with an error. The reducer takes that copy as it is given.
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
    const staging = reducer(base, { snapshot: [], type: "staging:started" });
    const stagingError = reducer(base, { error: new Error("disk full"), type: "staging:failed" });

    assert.equal(requestThenLoad(staging, { devices: DEVICES }).write, staging.write, "a stage in flight survives a clean outcome by reference");
    assert.equal(requestThenLoad(stagingError, { devices: DEVICES }).write, stagingError.write, "a failed stage survives a clean outcome by reference");
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

  const CONTROLLER_GUIDANCE = "Verify the controller's connection details are correct, then retry.";
  const PLUGIN_FAILURE_GUIDANCE = "Retry, and if it keeps failing, restart Homebridge and check its log for the reason.";

  // Every (site, kind) pair the table registers, with the words a user reads for it. The words are what the user acts on, so each pair is held to its exact text.
  const REGISTERED = [

    { guidance: "Retry once the plugin is responding again.", headline: "The plugin stopped responding while retrieving the controller list.", kind: "expired",
      site: "controllers" },
    { guidance: PLUGIN_FAILURE_GUIDANCE, headline: "The plugin failed while retrieving the controller list.", kind: "rejected", site: "controllers" },
    { guidance: CONTROLLER_GUIDANCE, headline: "Unable to retrieve the controller list.", kind: "reported", site: "controllers" },
    { guidance: "Retry once the plugin is responding again.", headline: "The plugin stopped responding while retrieving the device list.", kind: "expired",
      site: "devices" },
    { guidance: PLUGIN_FAILURE_GUIDANCE, headline: "The plugin failed while retrieving the device list.", kind: "rejected", site: "devices" },
    { guidance: CONTROLLER_GUIDANCE, headline: "Unable to retrieve the device list.", kind: "reported", site: "devices" },
    { guidance: "Retry once the plugin is responding again.", headline: "The plugin stopped responding while loading the feature options.", kind: "expired",
      site: "features" },
    { guidance: "Retry once the plugin is responding again.", headline: "Unable to load the feature options.", kind: "rejected", site: "features" },
    { guidance: "Retry once the Homebridge server is reachable again.", headline: "The Homebridge server stopped responding.", kind: "expired", site: "sync" },
    { guidance: "Retry once the Homebridge server is reachable again.", headline: "Unable to read the plugin configuration.", kind: "rejected", site: "sync" }
  ];

  for(const { guidance, headline, kind, site } of REGISTERED) {

    test("the " + site + " site's " + kind + " row reads its own headline and guidance", () => {

      assert.deepEqual(connectionFailureCopy({ kind, site }), { guidance, headline });
    });
  }

  test("every registered site yields distinct copy for each way its failures arrive", () => {

    for(const site of [ "controllers", "devices", "features", "sync" ]) {

      const rows = REGISTERED.filter((row) => row.site === site).map(({ kind }) => connectionFailureCopy({ kind, site }));

      assert.ok(rows.every((row) => row.guidance.length && row.headline.length), site + " must carry a headline and guidance for every kind it registers");
      assert.equal(new Set(rows.map((row) => row.headline)).size, rows.length, site + " must read differently for each way a failure arrives");
    }
  });

  test("every headline in the table is distinct from every other, so a failure cannot masquerade as a different one", () => {

    const headlines = REGISTERED.map(({ kind, site }) => connectionFailureCopy({ kind, site }).headline);

    assert.equal(new Set(headlines).size, headlines.length, "no two registered rows, at any site or of any kind, may share a headline");
  });

  test("an unregistered site throws rather than rendering a banner with empty text slots", () => {

    assert.throws(() => connectionFailureCopy({ kind: "rejected", site: "devcies" }), {

      constructor: Error,
      message: "FeatureOptionsState.connectionFailureCopy: no failure copy is registered for the site \"devcies\"."
    });
  });

  test("a kind its site does not register throws rather than rendering a banner with empty text slots", () => {

    // The features and sync sites have no hook result to report a failure on, so neither registers a reported row, and a kind no site registers is refused too.
    for(const { kind, site } of [ { kind: "reported", site: "features" }, { kind: "reported", site: "sync" }, { kind: "failed", site: "devices" } ]) {

      assert.throws(() => connectionFailureCopy({ kind, site }), {

        constructor: Error,
        message: "FeatureOptionsState.connectionFailureCopy: no failure copy is registered for the kind \"" + kind + "\" at the site \"" + site + "\"."
      });
    }
  });

  test("the controller-failure rows share one guidance, and it names no place the plugin may not have", () => {

    const controllers = connectionFailureCopy({ kind: "reported", site: "controllers" });
    const devices = connectionFailureCopy({ kind: "reported", site: "devices" });

    assert.equal(controllers.guidance, "Verify the controller's connection details are correct, then retry.", "the controller-list failure reads the shared guidance");
    assert.equal(devices.guidance, controllers.guidance, "and the device-list failure reads the same one, so the two cannot drift apart");
    assert.doesNotMatch(controllers.guidance, /Settings tab/,
      "the framework's own copy names no host tab, because a consumer may keep its controller settings elsewhere");
  });

  test("a plugin's guidance replaces the controller-failure rows and leaves every other row alone", () => {

    const plugin = "Open the controller editor below to correct its address or credentials.";

    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, kind: "reported", site: "controllers" }).guidance, plugin,
      "a controller-list failure takes the plugin's guidance");
    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, kind: "reported", site: "devices" }).guidance, plugin,
      "and so does a device-list failure, the other way a controller reports trouble");
    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, kind: "expired", site: "devices" }).guidance, "Retry once the plugin is responding again.",
      "an expiry keeps the plugin-stopped-responding guidance - a host that went quiet is not controller trouble");
    assert.equal(connectionFailureCopy({ controllerFailureGuidance: plugin, kind: "rejected", site: "sync" }).guidance,
      "Retry once the Homebridge server is reachable again.", "and a config-read failure is untouched, since it says nothing about a controller");
  });

  test("a plugin's guidance leaves every rejected row alone, since a plugin that failed on its own is not controller trouble", () => {

    const plugin = "Open the controller editor below to correct its address or credentials.";

    for(const site of [ "controllers", "devices", "features", "sync" ]) {

      assert.deepEqual(connectionFailureCopy({ controllerFailureGuidance: plugin, kind: "rejected", site }), connectionFailureCopy({ kind: "rejected", site }));
    }
  });

  test("the headline is never touched by the guidance override", () => {

    const overridden = connectionFailureCopy({ controllerFailureGuidance: "Repair it here.", kind: "reported", site: "devices" });

    assert.equal(overridden.headline, connectionFailureCopy({ kind: "reported", site: "devices" }).headline,
      "what failed is the framework's to say, whoever wrote the remedy");
  });
});

describe("connectionFailureKind", () => {

  test("a deadline expiry reads as expired", () => {

    assert.equal(connectionFailureKind(new DeadlineExpiredError(30)), "expired");
  });

  test("every other thrown value reads as rejected, the contract guard's TypeError among them", () => {

    // A wrong-shaped answer throws a TypeError, a hook with a bug of its own can throw one too, and each is the plugin's failure, so a thrown value's class says
    // nothing of its kind.
    const thrown = [ new Error("The bridge went away."), new TypeError("getDevices must resolve to { devices, error }."), { message: "Timed out." }, "kaboom" ];

    assert.deepEqual(thrown.map((err) => connectionFailureKind(err)), [ "rejected", "rejected", "rejected", "rejected" ]);
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

describe("CONTROLLERS_EMPTY_NOTICE", () => {

  // The one place the page's own empty-list sentence is written out, on the discipline the row above keeps: every other suite reads it through the constant, so a
  // reworded sentence changes this row and leaves no stale copy of itself in any other assertion.
  test("says what is missing and where it is added, on a page whose global options stay editable", () => {

    assert.equal(CONTROLLERS_EMPTY_NOTICE, "No controllers are configured yet. Add one in the main settings tab.");
  });
});

describe("reducer - scope:changed", () => {

  test("replaces the scope tag atomically", () => {

    const next = reducer(initialState(), { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.deepEqual(next.scope, { controllerId: "ctrl-a", kind: "controller" });
  });

  test("works for every scope kind", () => {

    const base = initialState();
    const global = reducer(base, { origin: "user", scope: { kind: "global" }, type: "scope:changed" });
    const controller = reducer(base, { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });
    const device = reducer(base, { origin: "user", scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" });
    const deviceOnly = reducer(base, { origin: "user", scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

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
    const controllerScope = { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" };
    const deviceScope = { origin: "user", scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" };

    // Global-only mode holds the scope fixed at global: a controller-kind or device-kind dispatch is a bug at the dispatch site and throws.
    assert.throws(() => reducer(globalOnly, controllerScope), /not permitted in global-only mode/);
    assert.throws(() => reducer(globalOnly, deviceScope), /not permitted in global-only mode/);

    // A global scope stays permitted, including in global-only mode.
    assert.equal(reducer(globalOnly, { origin: "user", scope: { kind: "global" }, type: "scope:changed" }).scope.kind, "global",
      "a global scope is permitted in global-only mode");

    // The same non-global dispatches pass unchanged in the device-bearing modes - the guard is scoped to global-only.
    assert.equal(reducer(deviceOnly, controllerScope).scope.kind, "controller", "a controller scope is permitted in device-only mode");
    assert.equal(reducer(controllerBased, deviceScope).scope.kind, "device", "a device scope is permitted in controller-based mode");
  });

  test("throws when the move carries no origin, naming the missing piece", () => {

    // Only a user's move ends a takeover, so a dispatch site that forgot its tag would otherwise read as the framework's own move and leave a plugin's card standing
    // with no error anywhere. The absent field has to reach the same loud failure an illegal one does.
    const held = reducer(loadedState(), { type: "takeover:started" });

    assert.throws(() => reducer(held, { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" }), /unknown origin "undefined"/);
  });

  test("throws on an origin outside the vocabulary", () => {

    const held = reducer(loadedState(), { type: "takeover:started" });

    assert.throws(() => reducer(held, { origin: "User", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" }), /unknown origin "User"/);
  });
});

describe("reducer - takeover", () => {

  test("a fresh state holds no takeover", () => {

    assert.equal(initialState().takeover, false, "a page begins with its own content area");
  });

  test("takeover:started records the hold, and a second one answers with the same state", () => {

    const base = loadedState();
    const held = reducer(base, { type: "takeover:started" });

    assert.equal(held.takeover, true, "the hold is recorded");
    assert.notEqual(held, base, "and recording it produced a new state for subscribers to see");
    assert.equal(reducer(held, { type: "takeover:started" }), held,
      "a second start over a standing hold answers by reference, so nothing comparing references wakes for it");
  });

  test("takeover:released gives the area back, and a second one answers with the same state", () => {

    const held = reducer(loadedState(), { type: "takeover:started" });
    const released = reducer(held, { type: "takeover:released" });

    assert.equal(released.takeover, false, "the area comes back to the page");
    assert.notEqual(released, held, "and giving it back produced a new state");
    assert.equal(reducer(released, { type: "takeover:released" }), released, "a release with nothing held answers by reference");
  });

  test("a selection change releases the hold while it disarms the armed row and moves the scope", () => {

    const held = reducer(loadedState(), { type: "takeover:started" });
    const armed = reducer(held, { option: "Audio.Volume", type: "option:armed" });

    assert.equal(armed.takeover, true, "precondition: the area is held and a row is armed");

    const next = reducer(armed, { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.equal(next.takeover, false, "the area belongs to the selection, so moving the selection gives it back");
    assert.equal(next.armedOption, null, "the armed row still stands down");
    assert.deepEqual(next.scope, { controllerId: "ctrl-a", kind: "controller" }, "and the selection still moves");
  });

  test("the boot's own selection and a continuation onto a controller's row leave the hold standing", () => {

    // Neither is the user going anywhere: the boot selects for the page, and a continuation carries a selected controller onto the row that stands for it. The
    // selection still moves and an armed row still stands down, because those belong to the view rather than to who moved.
    const cases = [

      [ "the boot's selection", { origin: "boot", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" } ],
      [ "a continuation", { origin: "continuation", scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" } ]
    ];

    for(const [ label, action ] of cases) {

      const armed = reducer(reducer(loadedState(), { type: "takeover:started" }), { option: "Audio.Volume", type: "option:armed" });
      const next = reducer(armed, action);

      assert.equal(next.takeover, true, label + " leaves the plugin holding the area");
      assert.equal(next.armedOption, null, label + " still disarms the armed row");
      assert.deepEqual(next.scope, action.scope, label + " still moves the selection");
    }
  });

  test("a model arriving over a standing takeover leaves it standing", () => {

    const held = reducer(loadedState(), { type: "takeover:started" });
    const reloaded = reducer(held, { catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });

    assert.equal(reloaded.takeover, true, "an in-place re-establish replaces the model without disturbing who holds the content area");
  });

  test("the takeover actions are not option mutations, so a coordinated write does not hold them", () => {

    const held = reducer(loadedState(), { type: "commit:started" });

    assert.equal(held.write.kind, "committing", "precondition: the coordinated write holds the store");

    const taken = reducer(held, { type: "takeover:started" });

    assert.equal(taken.takeover, true, "taking the content area is not an option edit, so the hold does not refuse it");
    assert.equal(reducer(taken, { type: "takeover:released" }).takeover, false, "and neither is giving it back");
  });

  test("neither takeover action moves a configuration or presentation slice", () => {

    const base = reducer(loadedState({ configuredOptions: ["Enable.Motion.Detect"] }), { mode: "modified", query: "motion", type: "filter:changed" });
    const held = reducer(base, { type: "takeover:started" });
    const released = reducer(held, { type: "takeover:released" });

    // Every slice a stage, a selector cache, or the search view keys on. A takeover that moved any of them would start a drain, invalidate a cache, or repaint a
    // panel that nothing about the content area should reach.
    for(const field of [ "catalog", "configuredOptions", "filter", "scope", "stagedAnchor" ]) {

      assert.equal(held[field], base[field], field + " comes through a start by reference");
      assert.equal(released[field], base[field], field + " comes through a release by reference");
    }
  });
});

describe("reducer - page:revealed", () => {

  test("a fresh state is unrevealed, the reveal records itself once, and a second answers with the same state", () => {

    assert.equal(initialState().revealed, false, "every page cycle begins inside its boot window");

    const revealed = reducer(loadedState(), { type: "page:revealed" });

    assert.equal(revealed.revealed, true, "the reveal is recorded");
    assert.equal(reducer(revealed, { type: "page:revealed" }), revealed, "a second reveal answers by reference");
  });

  test("a takeover standing at the reveal keeps standing", () => {

    const held = reducer(loadedState(), { type: "takeover:started" });

    assert.equal(reducer(held, { type: "page:revealed" }).takeover, true, "recording the reveal says nothing about who holds the content area");
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
    assert.equal(reducer(armed, { error: new Error("boom"), type: "staging:failed" }).armedOption, null, "a staging rollback disarms");
    assert.equal(reducer(armed, { origin: "user", scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" }).armedOption, null,
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

  test("replaces configuredOptions with an empty array; initialOptions and stagedAnchor unchanged", () => {

    const loaded = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: ["Enable.Motion.Detect"], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const next = reducer(loaded, { type: "options:reset" });

    assert.deepEqual(next.configuredOptions, []);
    assert.equal(next.initialOptions, loaded.initialOptions, "initialOptions reference preserved - revert can still restore it");
    assert.equal(next.stagedAnchor, loaded.stagedAnchor, "stagedAnchor reference preserved - rollback target unchanged");
  });

  test("a reset with nothing configured keeps the configuredOptions reference; a reset with something configured replaces it", () => {

    const empty = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const configured = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: ["Enable.Motion.Detect"], controllers: [], mode: "device-only", type: "model:loaded"
    });
    const armed = reducer(empty, { option: "Motion.Detect", type: "option:armed" });

    assert.equal(armed.armedOption, "Motion.Detect", "precondition: a row is armed on the store with nothing configured");

    const resetEmpty = reducer(armed, { type: "options:reset" });
    const resetConfigured = reducer(configured, { type: "options:reset" });

    assert.equal(resetEmpty.configuredOptions, empty.configuredOptions,
      "a reset with nothing to wipe reports no change, so a subscriber reading reference equality sees the no-op it is");
    assert.equal(resetEmpty.armedOption, null, "and it still disarms, which is the arm's other job and independent of whether the wipe found anything");
    assert.notEqual(resetConfigured.configuredOptions, configured.configuredOptions,
      "a reset that wipes something reports the change with a fresh array");
    assert.deepEqual(resetConfigured.configuredOptions, [], "which carries nothing");
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

describe("reducer - staging lifecycle", () => {

  test("staging:started moves the write lifecycle to staging and carries the snapshot", () => {

    const snapshot = ["Enable.Motion.Detect"];
    const base = initialState();

    assert.deepEqual(base.write, { kind: "idle" }, "precondition: a fresh store has nothing in flight");

    const next = reducer(base, { snapshot, type: "staging:started" });

    assert.equal(next.write.kind, "staging");
    assert.equal(next.write.snapshot, snapshot);
    assert.equal(next.status, base.status, "reachability is a separate fact and keeps its reference");
  });

  test("staging:succeeded promotes the snapshot to the anchor and returns the write lifecycle to idle", () => {

    const staging = reducer(initialState(), { snapshot: ["Enable.Motion.Detect"], type: "staging:started" });
    const next = reducer(staging, { snapshot: ["Enable.Motion.Detect"], type: "staging:succeeded" });

    assert.equal(next.write.kind, "idle");
    assert.deepEqual(next.stagedAnchor, ["Enable.Motion.Detect"]);
    assert.equal(next.status, staging.status, "reachability keeps its reference");
  });

  test("staging:failed rolls configuredOptions back to the anchor and moves the write lifecycle to staging-error", () => {

    const initial = ["Enable.Motion.Detect"];
    const loaded = loadedState({ configuredOptions: initial });

    // Simulate the optimistic-apply: mutate the model in memory, then staging failure rolls back.
    const mutated = reducer(loaded, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const error = new Error("Disk write failed");
    const failed = reducer(mutated, { error, type: "staging:failed" });

    assert.equal(failed.configuredOptions, loaded.stagedAnchor, "configuredOptions reverts to the anchor reference");
    assert.equal(failed.write.kind, "staging-error");
    assert.equal(failed.write.error, error);
    assert.equal(failed.status, mutated.status, "reachability keeps its reference");
  });
});

/* The lifecycles the state holds apart. Reachability answers whether the page can be reached; the write lifecycle answers what is happening to the configuration
 * write. They co-occur - a write can be in flight, or can have failed, while a controller cannot be reached - so these rows drive one while the other stands and
 * assert that neither transition reaches across.
 */
describe("reducer - page reachability and the write lifecycle are independent", () => {

  test("a staging action leaves a standing connection error in place by reference, while still promoting the anchor and rolling back", () => {

    const base = loadedState({ configuredOptions: ["Enable.Motion.Detect"] });
    const errored = requestThenLoad(base, { controllerId: "ctrl-a", devices: [], error: "Controller unreachable." });

    assert.equal(errored.status.kind, "connection-error", "precondition: the failed fetch raised the error");

    const snapshot = ["Enable.Audio.Volume.50"];
    const started = reducer(errored, { snapshot, type: "staging:started" });

    assert.equal(started.status, errored.status, "staging:started leaves the error in place by reference");
    assert.equal(started.write.snapshot, snapshot, "and carries the snapshot on the write lifecycle");

    const succeeded = reducer(started, { snapshot, type: "staging:succeeded" });

    assert.equal(succeeded.status, errored.status, "staging:succeeded leaves it in place by reference");
    assert.equal(succeeded.stagedAnchor, snapshot, "and still promotes the snapshot to the anchor");

    const error = new Error("The host refused the write.");
    const mutated = reducer(errored, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const failed = reducer(mutated, { error, type: "staging:failed" });

    assert.equal(failed.status, errored.status, "staging:failed leaves it in place by reference");
    assert.equal(failed.configuredOptions, errored.stagedAnchor, "and still rolls configuredOptions back to the anchor");
    assert.equal(failed.write.error, error, "carrying the error on the write lifecycle");
  });

  test("a device outcome leaves the write lifecycle by reference whatever it holds, clean or failed", () => {

    const base = loadedState();
    const writeStates = {

      committing: reducer(base, { type: "commit:started" }),
      staging: reducer(base, { snapshot: [], type: "staging:started" }),
      "staging-error": reducer(base, { error: new Error("The host refused the write."), type: "staging:failed" })
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
    const staging = reducer(base, { snapshot: [], type: "staging:started" });
    const stagingError = reducer(base, { error: new Error("The host refused the write."), type: "staging:failed" });
    const dirty = reducer(base, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const held = reducer(base, { type: "commit:started" });

    assert.notEqual(dirty.configuredOptions, dirty.stagedAnchor, "precondition: the dirty store has an edit the page has not written yet");

    assert.equal(reducer(unloaded, { type: "commit:started" }), unloaded, "a placeholder store has no configuration worth bracketing");
    assert.equal(reducer(staging, { type: "commit:started" }), staging, "a stage already in flight has its own claim");
    assert.deepEqual(reducer(stagingError, { type: "commit:started" }).write, { kind: "committing" },
      "while a stage that failed is a record rather than a claim, so the hold is taken over it");
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
    const held = reducer(loadedState({ controllers: [CONTROLLER_A] }), { type: "commit:started" });
    const permitted = [

      { type: "option:disarmed" },
      { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" },
      { query: "motion", type: "filter:changed" },
      { controllerId: "ctrl-a", type: "devices:requested" },
      { controllers: [], type: "controllers:loaded" },
      { controllers: [ CONTROLLER_A, CONTROLLER_B ], type: "controllers:loaded" },
      { controllers: [RENAMED_A], rename: RENAME_A, type: "controllers:loaded" }
    ];

    for(const action of permitted) {

      const next = reducer(held, action);

      assert.notEqual(next, held, action.type + " is not held: it reaches its arm and returns a new state");
      assert.equal(next.write, held.write, action.type + " leaves the hold standing, so the write that took it still ends it");
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
    const staging = reducer(base, { snapshot: [], type: "staging:started" });

    assert.equal(reducer(base, { type: "commit:failed" }), base, "an idle store is not a hold this action ends");
    assert.equal(reducer(staging, { type: "commit:failed" }), staging, "and neither is a stage in flight");
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
    const next = reducer(loaded, { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

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

/* A page that re-enters starts its fresh store from the store it replaces: the controller list and the selection, and nothing else. These rows hold that
 * hand-over to its terms, and hold the boot's question about an inherited selection to the answer the reconciliation itself gives.
 */
describe("initialState - a re-entry's starting values", () => {

  // A loaded page on controller A's own device row, with its device list, a pending fetch, a filter and an edit - everything a re-entry must leave behind.
  const standingPage = () => {

    const onA = reducer(loadedState({ configuredOptions: ["Enable.Motion.Detect"], controllers: [ CONTROLLER_A, CONTROLLER_B ], mode: "controller-based" }),
      { origin: "user", scope: { controllerId: "ctrl-a", deviceId: "ctrl-a", kind: "device" }, type: "scope:changed" });
    const listed = requestThenLoad(onA, { controllerId: "ctrl-a", devices: DEVICES });

    return reducer(reducer(listed, { query: "motion", type: "filter:changed" }), { controllerId: "ctrl-b", type: "devices:requested" });
  };

  test("inherits the controller list and the selection, a device selection as its controller's, and nothing else", () => {

    const replaced = standingPage();
    const fresh = initialState(replaced);
    const blank = initialState();

    assert.equal(fresh.controllers, replaced.controllers, "the list is handed over by reference");
    assert.deepEqual(fresh.scope, { controllerId: "ctrl-a", kind: "controller" }, "a device selection becomes its controller's, since the device list is not inherited");

    for(const field of Object.keys(blank)) {

      if([ "controllers", "scope" ].includes(field)) {

        continue;
      }

      assert.deepEqual(fresh[field], blank[field], field + " starts where any fresh store starts");
    }
  });

  test("inherits a controller selection by reference, and a selection naming no controller as global", () => {

    const onB = reducer(loadedState({ controllers: [ CONTROLLER_A, CONTROLLER_B ], mode: "controller-based" }),
      { origin: "user", scope: { controllerId: "ctrl-b", kind: "controller" }, type: "scope:changed" });
    const deviceOnly = reducer(loadedState(), { origin: "user", scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.equal(initialState(onB).scope, onB.scope, "a controller selection is handed over as it stood");
    assert.deepEqual(initialState(deviceOnly).scope, { kind: "global" }, "device-only mode's device selection names no controller");
    assert.deepEqual(initialState(loadedState()).scope, { kind: "global" }, "and global stays global");
  });

  test("a store started from inherited values hands over the same values again, before any model has loaded", () => {

    const inherited = initialState(standingPage());
    const again = initialState(inherited);

    assert.equal(again.controllers, inherited.controllers, "a re-entry that failed before its model loaded passes the same list to its retry");
    assert.deepEqual(again.scope, inherited.scope, "and the same selection");
  });
});

describe("reconciledControllerId - the boot's question about an inherited selection", () => {

  const inheritedOn = (controllerId) => initialState(reducer(loadedState({ controllers: [ CONTROLLER_A, CONTROLLER_B ], mode: "controller-based" }),
    { origin: "user", scope: { controllerId, kind: "controller" }, type: "scope:changed" }));

  test("answers where the model load is about to leave the selection, for every way a list can arrive", () => {

    const onB = inheritedOn("ctrl-b");
    const renamedB = { address: "10.0.0.8", name: "Controller B", serialNumber: "ctrl-b2" };
    const cases = [

      { arriving: [ CONTROLLER_A, CONTROLLER_B ], rename: undefined, state: onB, why: "a list that still holds the selection keeps it" },
      { arriving: [ CONTROLLER_A, renamedB ], rename: { from: "ctrl-b", to: "ctrl-b2" }, state: onB, why: "a proven rename carries it" },
      { arriving: [ CONTROLLER_A, renamedB ], rename: undefined, state: onB, why: "a departure without a rename drops it" },
      { arriving: [ CONTROLLER_A, CONTROLLER_B, renamedB ], rename: { from: "ctrl-b", to: "ctrl-b2" }, state: onB, why: "an unproven rename is ignored" },
      { arriving: [ CONTROLLER_A, CONTROLLER_B ], rename: undefined, state: initialState(), why: "a fresh store has no selection to keep" }
    ];

    for(const { arriving, rename, state, why } of cases) {

      const loaded = reducer(state, { catalog: CATALOG, configuredOptions: [], controllers: arriving, mode: "controller-based", rename, type: "model:loaded" });
      const landed = (loaded.scope.kind === "global") ? null : loaded.scope.controllerId;

      assert.equal(reconciledControllerId({ arriving, rename, state }), landed, why + ", exactly as the load leaves it");
    }

    assert.equal(reconciledControllerId({ arriving: [ CONTROLLER_A, renamedB ], rename: { from: "ctrl-b", to: "ctrl-b2" }, state: onB }), "ctrl-b2",
      "and a proven rename lands on the new key");
  });
});

describe("settledFactsMoved", () => {

  test("reads false across a list arrival that moved nothing and true across one that moved a settled fact", () => {

    const onA = requestThenLoad(reducer(loadedState({ controllers: [ CONTROLLER_A, CONTROLLER_B ], mode: "controller-based" }),
      { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" }), { controllerId: "ctrl-a", devices: DEVICES });
    const unmoved = reducer(onA, { controllers: [ CONTROLLER_A, CONTROLLER_B ], type: "controllers:loaded" });
    const departed = reducer(onA, { controllers: [CONTROLLER_B], type: "controllers:loaded" });
    const pendingOnly = reducer(reducer(onA, { controllerId: "ctrl-b", type: "devices:requested" }), { controllers: [CONTROLLER_A], type: "controllers:loaded" });

    assert.equal(settledFactsMoved(onA, unmoved), false, "an arrival that kept every settled fact moved none");
    assert.equal(settledFactsMoved(onA, departed), true, "an arrival that dropped the selected controller moved the selection and its list");
    assert.equal(pendingOnly.devicesRequest, null, "precondition: the arrival cleared only a fetch pending against a departed controller");
    assert.equal(settledFactsMoved(reducer(onA, { controllerId: "ctrl-b", type: "devices:requested" }), pendingOnly), false,
      "and a pending fetch is a request rather than a settled fact");

    // The selection alone can move: a user who clicked controller B while A's list was still the loaded one, and a refresh that then drops B.
    const onB = reducer(onA, { origin: "user", scope: { controllerId: "ctrl-b", kind: "controller" }, type: "scope:changed" });
    const droppedB = reducer(onB, { controllers: [CONTROLLER_A], type: "controllers:loaded" });

    assert.ok((droppedB.devices === onB.devices) && (droppedB.devicesControllerId === onB.devicesControllerId), "precondition: A's list stayed where it was");
    assert.equal(settledFactsMoved(onB, droppedB), true, "so an arrival that moved only the selection still reads as moved");
  });

  test("an arrival that moves nothing allocates no slice: every slice but the list keeps its reference", () => {

    const onA = requestThenLoad(reducer(loadedState({ controllers: [ CONTROLLER_A, CONTROLLER_B ], mode: "controller-based" }),
      { origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" }), { controllerId: "ctrl-a", devices: DEVICES });

    for(const rename of [ undefined, { from: "ctrl-z", to: "ctrl-y" } ]) {

      const next = reducer(onA, { controllers: [ CONTROLLER_B, CONTROLLER_A ], rename, type: "controllers:loaded" });

      for(const field of Object.keys(onA)) {

        if(field !== "controllers") {

          assert.equal(next[field], onA[field], field + " keeps its reference with " + ((rename === undefined) ? "no rename" : "an unproven rename"));
        }
      }
    }
  });
});
