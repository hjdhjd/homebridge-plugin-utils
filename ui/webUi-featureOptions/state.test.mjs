/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/state.test.mjs: Unit tests for the state shape, action vocabulary, and reducer.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "./state.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../featureOptions.js";

// Shared catalog fixture - small enough to be readable, varied enough to exercise the reducer's interaction with the pure transforms (value options, grouped
// options, and a plain boolean across two categories).
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

describe("reducer - devices:loaded", () => {

  test("replaces only the devices field", () => {

    const devices = [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const next = reducer(initialState(), { devices, type: "devices:loaded" });

    assert.equal(next.devices, devices);
    assert.deepEqual(next.scope, { kind: "global" }, "scope not touched by devices:loaded - caller dispatches scope:changed separately");
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

    assert.deepEqual(next.configuredOptions, ["Enable.Audio.Volume.ABC123.75"]);
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

  test("persist:started transitions status to persisting and carries the snapshot", () => {

    const snapshot = ["Enable.Motion.Detect"];
    const next = reducer(initialState(), { snapshot, type: "persist:started" });

    assert.equal(next.status.kind, "persisting");
    assert.equal(next.status.snapshot, snapshot);
  });

  test("persist:succeeded promotes the snapshot to the anchor and returns status to ready", () => {

    const persisting = reducer(initialState(), { snapshot: ["Enable.Motion.Detect"], type: "persist:started" });
    const next = reducer(persisting, { snapshot: ["Enable.Motion.Detect"], type: "persist:succeeded" });

    assert.equal(next.status.kind, "ready");
    assert.deepEqual(next.persistedAnchor, ["Enable.Motion.Detect"]);
  });

  test("persist:failed rolls configuredOptions back to the anchor and transitions status to persist-error", () => {

    const initial = ["Enable.Motion.Detect"];
    const loaded = reducer(initialState(), {

      catalog: CATALOG, configuredOptions: initial, controllers: [], mode: "device-only", type: "model:loaded"
    });

    // Simulate the optimistic-apply: mutate the model in memory, then persist failure rolls back.
    const mutated = reducer(loaded, { args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    const error = new Error("Disk write failed");
    const failed = reducer(mutated, { error, type: "persist:failed" });

    assert.equal(failed.configuredOptions, loaded.persistedAnchor, "configuredOptions reverts to the anchor reference");
    assert.equal(failed.status.kind, "persist-error");
    assert.equal(failed.status.error, error);
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
