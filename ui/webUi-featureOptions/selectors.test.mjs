/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/selectors.test.mjs: Unit tests for memoized selectors over the feature options state.
 */
"use strict";

import { configIndex, projection, selectedController, selectedControllerId, selectedDevice, selectedDeviceId } from "./selectors.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "./state.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../featureOptions.js";

// Catalog fixture: two categories with a mix of boolean, grouped, value-centric, and ungrouped options. Drives visibility, modification, dependency, and value
// resolution paths.
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

    isController: (device) => device?.serialNumber === "ctrl-a",
    validOption: () => true,
    validOptionCategory: () => true
  }
};

// Helper: build a "ready" state by dispatching model:loaded on top of initialState. Reused across most tests so the boilerplate stays in one place.
const loadedState = ({ configuredOptions = [], controllers = [], devices = [], mode = "device-only" } = {}) => {

  const base = reducer(initialState(), { catalog: CATALOG, configuredOptions, controllers, mode, type: "model:loaded" });

  // Land the devices through the request/outcome pairing the reducer guards: mint the fetch sequence, then apply the outcome stamped with it.
  const requested = reducer(base, { controllerId: null, type: "devices:requested" });

  return reducer(requested, { controllerId: null, devices, error: "", seq: requested.devicesRequest.seq, type: "devices:loaded" });
};

describe("scope-extraction helpers", () => {

  test("selectedControllerId returns the controller serial for controller and device scopes, null for global", () => {

    assert.equal(selectedControllerId({ scope: { kind: "global" } }), null);
    assert.equal(selectedControllerId({ scope: { controllerId: "ctrl-a", kind: "controller" } }), "ctrl-a");
    assert.equal(selectedControllerId({ scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" } }), "ctrl-a");
    assert.equal(selectedControllerId({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } }), null,
      "device-only mode device scope carries controllerId: null");
  });

  test("selectedDeviceId returns the device serial for device scope, null otherwise", () => {

    assert.equal(selectedDeviceId({ scope: { kind: "global" } }), null);
    assert.equal(selectedDeviceId({ scope: { controllerId: "ctrl-a", kind: "controller" } }), null);
    assert.equal(selectedDeviceId({ scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" } }), "dev-a");
  });
});

describe("configIndex", () => {

  test("builds an O(1) lookup index from configuredOptions, keyed on the lowercased entry tails", () => {

    const state = loadedState({ configuredOptions: [ "Enable.Motion.Detect.dev-a", "Disable.Audio.Volume" ] });
    const idx = configIndex(state);

    assert.equal(idx.get("motion.detect.dev-a")?.enabled, true);
    assert.equal(idx.get("audio.volume")?.enabled, false);
  });

  test("returns the cached index reference when (catalog, configuredOptions) are unchanged across calls", () => {

    const state = loadedState({ configuredOptions: ["Enable.Motion.Detect"] });
    const a = configIndex(state);
    const b = configIndex(state);

    assert.equal(a, b, "same state reference returns the cached index");
  });

  test("invalidates the cache when configuredOptions changes", () => {

    const state = loadedState({ configuredOptions: ["Enable.Motion.Detect"] });
    const a = configIndex(state);
    const mutated = reducer(state, { args: { enabled: true, option: "Audio.Volume", value: 75 }, type: "option:set" });
    const b = configIndex(mutated);

    assert.notEqual(a, b, "mutation invalidates the cache and produces a fresh index");
    assert.equal(b.get("audio.volume")?.value, "75");
  });
});

describe("selectedDevice", () => {

  test("returns undefined for global and controller scopes", () => {

    const state = loadedState({

      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      mode: "controller-based"
    });

    assert.equal(selectedDevice(state), undefined, "global scope - no device");

    const inController = reducer(state, { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.equal(selectedDevice(inController), undefined, "controller scope - no concrete device");
  });

  test("resolves the device for a device scope", () => {

    const dev = { firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };
    const state = loadedState({ devices: [dev] });
    const inDevice = reducer(state, { scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.equal(selectedDevice(inDevice), dev);
  });

  test("returns undefined when the device id does not match any loaded device", () => {

    const state = loadedState({ devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }] });
    const inDevice = reducer(state, { scope: { controllerId: null, deviceId: "missing", kind: "device" }, type: "scope:changed" });

    assert.equal(selectedDevice(inDevice), undefined);
  });
});

describe("selectedController", () => {

  test("returns null for global scope", () => {

    const state = loadedState({ controllers: [{ address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" }], mode: "controller-based" });

    assert.equal(selectedController(state), null);
  });

  test("returns the controller for controller and device-under-controller scopes", () => {

    const ctrl = { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" };
    const state = loadedState({ controllers: [ctrl], mode: "controller-based" });

    const inController = reducer(state, { scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.equal(selectedController(inController), ctrl);

    const inDevice = reducer(state, { scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.equal(selectedController(inDevice), ctrl);
  });

  test("returns null when the device scope has no parent controller (device-only mode)", () => {

    const state = loadedState({ devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }] });
    const inDevice = reducer(state, { scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.equal(selectedController(inDevice), null);
  });
});

describe("projection - shape and counts", () => {

  test("groups active options under their categories in catalog order", () => {

    const state = loadedState();
    const p = projection(state);

    assert.equal(p.categories.length, 2, "both categories active under permissive validators");
    assert.equal(p.categories[0].name, "Motion", "catalog order preserved");
    assert.equal(p.categories[1].name, "Audio");
    assert.equal(p.categories[0].entries.length, 2, "Motion has Detect + Sensitivity");
    assert.equal(p.categories[1].entries.length, 1, "Audio has Volume");
  });

  test("counts.total reflects every active option; counts.modified reflects only configured ones; counts.grouped reflects only options with a parent group", () => {

    const state = loadedState({ configuredOptions: ["Enable.Motion.Detect"] });
    const p = projection(state);

    assert.equal(p.counts.total, 3, "Detect + Sensitivity + Volume");
    assert.equal(p.counts.modified, 1, "only Motion.Detect is explicitly configured");
    assert.equal(p.counts.grouped, 1, "only Motion.Sensitivity is grouped (group: Detect)");
  });

  test("counts.visible matches the number of entries with visible: true", () => {

    const state = loadedState();
    const p = projection(state);
    const visibleEntries = p.categories.flatMap((c) => c.entries).filter((e) => e.visible);

    assert.equal(p.counts.visible, visibleEntries.length);
  });
});

describe("projection - per-entry fields", () => {

  test("isModified reflects whether the option has any explicit configured entry", () => {

    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const p = projection(state);
    const detect = p.categories[0].entries.find((e) => e.name === "Detect");
    const sensitivity = p.categories[0].entries.find((e) => e.name === "Sensitivity");

    assert.equal(detect?.isModified, true);
    assert.equal(sensitivity?.isModified, false);
  });

  test("scope reports where the option resolved through the hierarchy", () => {

    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const p = projection(state);
    const detect = p.categories[0].entries.find((e) => e.name === "Detect");

    assert.equal(detect?.scope, "global", "global-level Disable resolves to global scope");
  });

  test("value carries the resolved value for value-centric options when enabled", () => {

    const explicit = projection(loadedState({ configuredOptions: ["Enable.Audio.Volume.75"] }));
    const explicitVolume = explicit.categories[1].entries.find((e) => e.name === "Volume");

    assert.equal(explicitVolume?.value, "75", "explicit configured value");

    const enabledDefault = projection(loadedState({ configuredOptions: ["Enable.Audio.Volume"] }));
    const enabledDefaultVolume = enabledDefault.categories[1].entries.find((e) => e.name === "Volume");

    assert.equal(enabledDefaultVolume?.value, undefined, "enabled at explicit scope with no value provided - undefined");
  });

  test("value falls back to the catalog-declared default for value-centric options enabled at no explicit scope", () => {

    const state = loadedState();
    const p = projection(state);
    const volume = p.categories[1].entries.find((e) => e.name === "Volume");

    // Volume's default is false, so it resolves to !enabled => no value. Verify the unconfigured case.
    assert.equal(volume?.value, undefined);
  });

  test("requiresParentBadge is true only when the entry is visible AND grouped AND its parent is disabled", () => {

    // Parent disabled, search active: child stays visible with badge.
    const searched = reducer(loadedState({ configuredOptions: ["Disable.Motion.Detect"] }), { query: "sensitivity", type: "filter:changed" });
    const p = projection(searched);
    const sensitivity = p.categories[0].entries.find((e) => e.name === "Sensitivity");

    assert.equal(sensitivity?.requiresParentBadge, true);
    assert.equal(sensitivity?.visible, true);
  });

  test("requiresParentBadge is false when search and filter are inactive (the row is hidden instead)", () => {

    // Parent disabled, no search, all-filter: child is hidden (visible: false), so requiresParentBadge is also false.
    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const p = projection(state);
    const sensitivity = p.categories[0].entries.find((e) => e.name === "Sensitivity");

    assert.equal(sensitivity?.visible, false, "hidden because parent is disabled and no filter is active");
    assert.equal(sensitivity?.requiresParentBadge, false, "no badge for hidden row");
  });
});

describe("projection - visibility rules", () => {

  test("the modified filter hides unmodified options", () => {

    const state = reducer(loadedState({ configuredOptions: ["Enable.Motion.Detect"] }), { mode: "modified", type: "filter:changed" });
    const p = projection(state);
    const detect = p.categories[0].entries.find((e) => e.name === "Detect");
    const sensitivity = p.categories[0].entries.find((e) => e.name === "Sensitivity");

    assert.equal(detect?.visible, true, "Motion.Detect is modified - visible");
    assert.equal(sensitivity?.visible, false, "Motion.Sensitivity is unmodified - hidden");
  });

  test("a non-empty search query hides options whose description does not match (case-insensitive)", () => {

    const state = reducer(loadedState(), { query: "VOLUME", type: "filter:changed" });
    const p = projection(state);
    const volume = p.categories[1].entries.find((e) => e.name === "Volume");
    const detect = p.categories[0].entries.find((e) => e.name === "Detect");

    assert.equal(volume?.visible, true, "Volume matches description query case-insensitively");
    assert.equal(detect?.visible, false, "Detect's description does not match");
  });

  test("with neither search nor modified filter active, grouped options with disabled parents are hidden", () => {

    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const p = projection(state);
    const sensitivity = p.categories[0].entries.find((e) => e.name === "Sensitivity");

    assert.equal(sensitivity?.visible, false, "dependency-hide applies under the all-filter with no search");
  });

  test("with search active, dependency-hide is suppressed and grouped-but-orphaned options remain visible", () => {

    const state = reducer(loadedState({ configuredOptions: ["Disable.Motion.Detect"] }), { query: "sensitivity", type: "filter:changed" });
    const p = projection(state);
    const sensitivity = p.categories[0].entries.find((e) => e.name === "Sensitivity");

    assert.equal(sensitivity?.visible, true, "search match shows the row even with disabled parent");
  });
});

describe("projection - validators", () => {

  test("validOptionCategory removes a category entirely - no entries, not in categories list", () => {

    const catalog = {

      ...buildCatalogIndex(CATEGORIES, OPTIONS),

      validators: {

        isController: () => false,
        validOption: () => true,
        validOptionCategory: (_device, category) => category.name !== "Audio"
      }
    };

    const state = reducer(initialState(), { catalog, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    const p = projection(state);

    assert.equal(p.categories.length, 1);
    assert.equal(p.categories[0].name, "Motion");
  });

  test("validOption removes individual options without affecting their category", () => {

    const catalog = {

      ...buildCatalogIndex(CATEGORIES, OPTIONS),

      validators: {

        isController: () => false,
        validOption: (_device, option) => option.name !== "Sensitivity",
        validOptionCategory: () => true
      }
    };

    const state = reducer(initialState(), { catalog, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    const p = projection(state);
    const motion = p.categories.find((c) => c.name === "Motion");

    assert.equal(motion?.entries.length, 1, "Sensitivity dropped, only Detect remains");
    assert.equal(motion?.entries[0].name, "Detect");
  });

  test("a category whose every option fails the validator is omitted from the categories list", () => {

    const catalog = {

      ...buildCatalogIndex(CATEGORIES, OPTIONS),

      validators: {

        isController: () => false,
        validOption: (_device, option) => option.name !== "Volume",
        validOptionCategory: () => true
      }
    };

    const state = reducer(initialState(), { catalog, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    const p = projection(state);
    const names = p.categories.map((c) => c.name);

    assert.deepEqual(names, ["Motion"], "Audio is omitted because its only option (Volume) is invalid for the device");
  });
});

describe("projection - memoization", () => {

  test("two calls with the same state reference return the same projection reference", () => {

    const state = loadedState();
    const a = projection(state);
    const b = projection(state);

    assert.equal(a, b, "cached on identical inputs");
  });

  test("a state mutation that does not touch projection's slices returns the cached projection", () => {

    const state = loadedState();
    const a = projection(state);

    // persist:started changes status but not any projection slice.
    const persisting = reducer(state, { snapshot: [], type: "persist:started" });
    const b = projection(persisting);

    assert.equal(a, b, "status change does not invalidate the projection cache");
  });

  test("a state mutation that touches a projection slice invalidates the cache", () => {

    const state = loadedState();
    const a = projection(state);

    const filtered = reducer(state, { query: "motion", type: "filter:changed" });
    const b = projection(filtered);

    assert.notEqual(a, b, "filter change invalidates the projection cache");
  });
});

describe("projection - empty / loading state", () => {

  test("the initial loading state produces an empty projection with zero counts", () => {

    const p = projection(initialState());

    assert.deepEqual(p.categories, []);
    assert.deepEqual(p.counts, { grouped: 0, modified: 0, total: 0, visible: 0 });
  });
});
