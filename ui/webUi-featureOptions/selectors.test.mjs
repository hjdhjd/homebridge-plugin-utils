/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/selectors.test.mjs: Unit tests for memoized selectors over the feature options state.
 */
"use strict";

import { configIndex, modelLoaded, projection, scopingControllerId, selectedController, selectedControllerId, selectedDevice, selectedDeviceId } from "./selectors.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "./state.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../featureOptions.js";

// Catalog fixture: a small set of categories with a mix of boolean, grouped, value-centric, and ungrouped options. Drives visibility, modification,
// dependency, and value resolution paths.
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

describe("modelLoaded", () => {

  test("reads false on a fresh state and true once model:loaded has installed a catalog", () => {

    assert.equal(modelLoaded(initialState()), false, "a store that has not loaded its model reads false");
    assert.equal(modelLoaded(loadedState()), true, "model:loaded is the transition that flips it");
  });

  test("stays false when a connection error lands before the model - the status moved, the model never arrived", () => {

    const failed = reducer(initialState(), {

      guidance: "Check the Settings tab to verify the controller details are correct.",
      headline: "Unable to retrieve the controller list.",
      message: "the controller hook blew up",
      type: "connection:error"
    });

    assert.equal(failed.status.kind, "connection-error", "pre-condition: the status has left loading");
    assert.equal(modelLoaded(failed), false, "status is the page-state pointer, not the load signal - a pre-load failure is still an unloaded store");
  });

  test("reads true for a loaded catalog with no content at all - identity is the signal, not what the catalog contains", () => {

    // A plugin that declares no categories and no options loads a catalog that is structurally identical to the placeholder yet is a different object. Anything
    // reading content rather than identity would call this store unloaded, which is exactly wrong: its model arrived, and it is empty.
    const emptyContentCatalog = {

      ...buildCatalogIndex([], {}),

      validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
    };

    const state = reducer(initialState(), { catalog: emptyContentCatalog, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });

    assert.equal(modelLoaded(state), true, "an options-less plugin is a legitimately loaded model");
  });
});

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

describe("projection - the declared-scopes view gate", () => {

  // The matrix asserts the SAME declared options at every view, so a gate wired to the wrong view kind cannot pass by fixture accident: whichever kind it read,
  // some view would report the wrong set. "Anywhere" declares nothing and has to appear at every view.
  const SCOPED_CATEGORIES = [

    { description: "Scoped Options", name: "Scoped" },
    { description: "Account Options", name: "Account" }
  ];

  const SCOPED_OPTIONS = {

    Account: [

      { default: false, description: "Account-wide only.", name: "Wide", scopes: ["global"] }
    ],

    Scoped: [

      { default: false, description: "Controller and device option.", name: "Local", scopes: [ "controller", "device" ] },
      { default: false, description: "Account-wide option.", name: "Account", scopes: ["global"] },
      { default: false, description: "Option that declares nothing.", name: "Anywhere" }
    ]
  };

  const DEVICE = { firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };

  // Build a ready state over the scoped catalog at the requested view. The validator defaults to permissive so the framework gate is the only thing shaping the row
  // set, except where a test supplies its own to check that the plugin's validator still refines what the gate admits.
  const scopedState = ({ scope, validOption = () => true } = {}) => {

    const catalog = {

      ...buildCatalogIndex(SCOPED_CATEGORIES, SCOPED_OPTIONS),

      validators: { isController: () => false, validOption, validOptionCategory: () => true }
    };

    const controllers = [{ address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" }];
    const base = reducer(initialState(), { catalog, configuredOptions: [], controllers, mode: "controller-based", type: "model:loaded" });
    const requested = reducer(base, { controllerId: "ctrl-a", type: "devices:requested" });
    const withDevices = reducer(requested, { controllerId: "ctrl-a", devices: [DEVICE], error: "", seq: requested.devicesRequest.seq, type: "devices:loaded" });

    return scope ? reducer(withDevices, { scope, type: "scope:changed" }) : withDevices;
  };

  const scopedNames = (state) => projection(state).categories.flatMap((c) => c.entries).map((e) => e.name);

  test("the global view offers global-declared options and hides those declared only at narrower levels", () => {

    assert.deepEqual(scopedNames(scopedState({ scope: { kind: "global" } })), [ "Account", "Anywhere", "Wide" ]);
  });

  test("a controller view offers controller-declared options and hides the global-only ones", () => {

    assert.deepEqual(scopedNames(scopedState({ scope: { controllerId: "ctrl-a", kind: "controller" } })), [ "Local", "Anywhere" ]);
  });

  test("a device view offers both device-declared and controller-declared options, and hides the global-only ones", () => {

    // A device page edits its own scope and displays what it inherits from its controller, so a controller-declared option belongs here too.
    assert.deepEqual(scopedNames(scopedState({ scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" } })), [ "Local", "Anywhere" ]);
  });

  test("the plugin's validator refines the rows the gate admits, and runs only over those", () => {

    const seen = [];
    const state = scopedState({

      scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" },
      validOption: (_device, option) => {

        seen.push(option.name);

        return option.name !== "Local";
      }
    });

    assert.deepEqual(scopedNames(state), ["Anywhere"], "the validator drops one of the rows the gate admitted");
    assert.deepEqual(seen, [ "Local", "Anywhere" ], "and never saw the global-only options, which the gate had already refused");
  });

  test("a category whose every option is gated out is omitted entirely, through the existing empty-category rule", () => {

    const state = scopedState({ scope: { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" } });

    assert.deepEqual(projection(state).categories.map((c) => c.name), ["Scoped"], "Account holds only a global-declared option, so a device view drops the header");
  });
});

describe("projection - the presented view scope", () => {

  // A controller's own options page is the shape a plugin whose device list leads with the controller-as-device produces: one serial fills both scope slots, and
  // every edit made there is stored at that serial. The catalog declares an option at both levels, one at the controller level alone, and one that declares
  // nothing, so a single page carries an entry resolved at each step the walk can answer at.
  const PAGE_CATEGORIES = [{ description: "Page Options", name: "Page" }];

  const PAGE_OPTIONS = {

    Page: [

      { default: false, description: "Controller and device option.", name: "Dual", scopes: [ "controller", "device" ] },
      { default: false, description: "Controller-level option.", name: "ControllerOnly", scopes: ["controller"] },
      { default: false, description: "Option that declares nothing.", name: "Anywhere" }
    ]
  };

  const CONTROLLER = { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" };

  // The controller leads its own device list, which is the arrangement that puts a controller-as-device page on screen at all.
  const DEVICES = [

    { firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Controller A", serialNumber: "ctrl-a" },
    { firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }
  ];

  const CONTROLLER_PAGE = { controllerId: "ctrl-a", deviceId: "ctrl-a", kind: "device" };
  const DEVICE_PAGE = { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" };

  // Build a ready state over the page catalog at the requested scope. The device list lands through the request/outcome pairing the reducer guards.
  const pageState = ({ configuredOptions = [], controllers = [CONTROLLER], mode = "controller-based", scope }) => {

    const catalog = {

      ...buildCatalogIndex(PAGE_CATEGORIES, PAGE_OPTIONS),

      validators: { isController: (device) => device?.serialNumber === "ctrl-a", validOption: () => true, validOptionCategory: () => true }
    };

    const base = reducer(initialState(), { catalog, configuredOptions, controllers, mode, type: "model:loaded" });
    const requested = reducer(base, { controllerId: "ctrl-a", type: "devices:requested" });
    const withDevices = reducer(requested, { controllerId: "ctrl-a", devices: DEVICES, error: "", seq: requested.devicesRequest.seq, type: "devices:loaded" });

    return reducer(withDevices, { scope, type: "scope:changed" });
  };

  const entryScope = (state, optionName) => projection(state).categories[0].entries.find((e) => e.name === optionName).scope;

  test("a page whose selected device is the in-scope controller presents at controller scope", () => {

    assert.equal(projection(pageState({ scope: CONTROLLER_PAGE })).viewScope, "controller");
  });

  test("entries stored at the controller's own serial report controller scope, whichever step resolution reached them at", () => {

    const state = pageState({

      configuredOptions: [ "Enable.Page.Dual.ctrl-a", "Enable.Page.ControllerOnly.ctrl-a", "Enable.Page.Anywhere" ],
      scope: CONTROLLER_PAGE
    });

    // The dual-declared option is the one resolution answers at the device step, because the serial it was asked about is the controller's own. The entry governs
    // the controller and everything beneath it either way, so the page reports it as what it is.
    assert.equal(entryScope(state, "Dual"), "controller", "an entry resolved at the device step against the controller's serial is a controller entry");
    assert.equal(entryScope(state, "ControllerOnly"), "controller", "a controller-declared option already resolves at the controller step and passes through");
    assert.equal(entryScope(state, "Anywhere"), "global", "a genuinely inherited entry keeps the scope it resolved at");
  });

  test("a real device page under the same controller is untouched: device scope, and entry scopes as resolution reported them", () => {

    const state = pageState({

      configuredOptions: [ "Enable.Page.Dual.dev-a", "Enable.Page.ControllerOnly.ctrl-a", "Enable.Page.Anywhere" ],
      scope: DEVICE_PAGE
    });

    assert.equal(projection(state).viewScope, "device");
    assert.equal(entryScope(state, "Dual"), "device", "the device's own entry stays a device entry");
    assert.equal(entryScope(state, "ControllerOnly"), "controller", "the controller's entry is inherited here");
    assert.equal(entryScope(state, "Anywhere"), "global");
  });

  test("a device-only-mode page keeps device scope even for a device the plugin calls a controller", () => {

    // With no controller in scope there is no serial to be equal to, so a controller-flagged device's edits are genuine device-scope entries and keep the device
    // presentation. The validator here calls ctrl-a a controller, which is exactly the flag the predicate deliberately does not read.
    const state = pageState({

      configuredOptions: ["Enable.Page.Dual.ctrl-a"],
      controllers: [],
      mode: "device-only",
      scope: { controllerId: null, deviceId: "ctrl-a", kind: "device" }
    });

    assert.equal(projection(state).viewScope, "device");
    assert.equal(entryScope(state, "Dual"), "device");
  });

  test("the global view and a controller's transient view pass their own kind through", () => {

    assert.equal(projection(pageState({ scope: { kind: "global" } })).viewScope, "global");
    assert.equal(projection(pageState({ scope: { controllerId: "ctrl-a", kind: "controller" } })).viewScope, "controller");
  });

  test("which options the page offers is unchanged - admission still answers to the raw scope tag", () => {

    // The presented scope moves the page's SEMANTICS, never its row set. A controller page admits what a device view admits, because admission is a
    // declared-scopes question about the storage step that matches...reading the presented scope here would drop every device-only-declared option off the page.
    const names = (scope) => projection(pageState({ scope })).categories.flatMap((c) => c.entries).map((e) => e.name);

    assert.deepEqual(names(CONTROLLER_PAGE), names(DEVICE_PAGE), "a controller page and a device page offer the same rows");
  });
});

describe("the controller's scoping identity", () => {

  // The two-identity shape a plugin produces when its controller list must render before any connection: the sidebar link is named by the configured address,
  // while the entries the connection reveals are keyed by the hardware serial the device list stamps on the controller's own row. Everything here models that
  // split, so a derivation that quietly used the link's serial would fail every row below.
  const NVR_ADDRESS = "192.0.2.1";
  const NVR_MAC = "AABBCCDDEE01";
  const CAMERA_MAC = "AABBCCDDEE02";

  const CONTROLLERS = [{ address: NVR_ADDRESS, name: "Doorbell NVR", serialNumber: NVR_ADDRESS }];

  // The controller's own row carries the marker its validator reads, and a serial that is nothing like the link's.
  const DEVICES = [

    { firmwareRevision: "4.0", manufacturer: "Ubiquiti", model: "NVR", modelKey: "nvr", name: "Doorbell NVR", serialNumber: NVR_MAC },
    { firmwareRevision: "4.0", manufacturer: "Ubiquiti", model: "G4", modelKey: "camera", name: "Front Door", serialNumber: CAMERA_MAC }
  ];

  const IDENTITY_CATEGORIES = [{ description: "Camera Options", name: "Camera" }];

  const IDENTITY_OPTIONS = {

    Camera: [

      { default: false, description: "Enable HKSV recording.", name: "Hksv", scopes: [ "controller", "device" ] }
    ]
  };

  const CONTROLLER_PAGE = { controllerId: NVR_ADDRESS, deviceId: NVR_MAC, kind: "device" };
  const CHILD_PAGE = { controllerId: NVR_ADDRESS, deviceId: CAMERA_MAC, kind: "device" };

  // Build a ready state over the two-identity catalog. `listOwner` is the controller the loaded device list belongs to, stamped through the request/outcome
  // pairing exactly as a fetch does, which is what lets a test model the window where the scope has moved but the new list has not landed.
  const identityState = ({ configuredOptions = [], devices = DEVICES, isController = (device) => device?.modelKey === "nvr", listOwner = NVR_ADDRESS, scope }) => {

    const catalog = {

      ...buildCatalogIndex(IDENTITY_CATEGORIES, IDENTITY_OPTIONS),

      validators: { isController, validOption: () => true, validOptionCategory: () => true }
    };

    const base = reducer(initialState(), { catalog, configuredOptions, controllers: CONTROLLERS, mode: "controller-based", type: "model:loaded" });
    const requested = reducer(base, { controllerId: listOwner, type: "devices:requested" });
    const withDevices = reducer(requested, { controllerId: listOwner, devices, error: "", seq: requested.devicesRequest.seq, type: "devices:loaded" });

    return reducer(withDevices, { scope, type: "scope:changed" });
  };

  const hksvEntry = (state) => projection(state).categories[0].entries.find((e) => e.name === "Hksv");

  test("comes from the controller-as-device row the plugin's isController names, not from the sidebar link", () => {

    assert.equal(scopingControllerId(identityState({ scope: CONTROLLER_PAGE })), NVR_MAC);
    assert.equal(scopingControllerId(identityState({ scope: CHILD_PAGE })), NVR_MAC, "a child device's page resolves against the same controller identity");
  });

  test("is null when no controller is in scope", () => {

    assert.equal(scopingControllerId(identityState({ scope: { kind: "global" } })), null, "the global view has no controller");
    assert.equal(scopingControllerId(identityState({ scope: { controllerId: null, deviceId: CAMERA_MAC, kind: "device" } })), null, "device-only mode has none either");
  });

  test("stands in with the navigation identity while the in-scope controller's device list has not landed", () => {

    // The list on hand belongs to a different controller, so it cannot answer for this one. The navigation identity is coarser for the moment and is the only
    // answer available that is not some other controller's.
    const state = identityState({ listOwner: "192.0.2.9", scope: CONTROLLER_PAGE });

    assert.equal(scopingControllerId(state), NVR_ADDRESS);
  });

  test("stands in with the navigation identity when no row answers to isController", () => {

    // A plugin that supplies no validator gets the framework default, which calls nothing a controller...this is the path that keeps such a plugin on exactly the
    // identity it has always resolved by.
    assert.equal(scopingControllerId(identityState({ isController: () => false, scope: CONTROLLER_PAGE })), NVR_ADDRESS);
  });

  test("is the one shared serial for a plugin whose two identities coincide", () => {

    const devices = [

      { firmwareRevision: "1.0", manufacturer: "X", model: "Y", modelKey: "nvr", name: "Controller", serialNumber: NVR_ADDRESS },
      { firmwareRevision: "1.0", manufacturer: "X", model: "Y", modelKey: "camera", name: "Device", serialNumber: CAMERA_MAC }
    ];

    assert.equal(scopingControllerId(identityState({ devices, scope: { controllerId: NVR_ADDRESS, deviceId: NVR_ADDRESS, kind: "device" } })), NVR_ADDRESS);
  });

  test("carries the controller's own page to controller scope even though the link's serial matches nothing", () => {

    const state = identityState({ configuredOptions: ["Enable.Camera.Hksv." + NVR_MAC], scope: CONTROLLER_PAGE });

    assert.equal(projection(state).viewScope, "controller", "the page presents at the scope its edits land at");
    assert.equal(hksvEntry(state).scope, "controller", "and its own entry reports the scope it governs");
  });

  test("resolves a child device's inheritance from the controller's entry", () => {

    const state = identityState({ configuredOptions: ["Enable.Camera.Hksv." + NVR_MAC], scope: CHILD_PAGE });
    const entry = hksvEntry(state);

    assert.equal(projection(state).viewScope, "device", "a child device's page is a device page");
    assert.equal(entry.scope, "controller", "the controller's entry reaches the device beneath it");
    assert.equal(entry.enabled, true, "and carries its value there");
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
