/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/options.test.mjs: Unit tests for the config-table view.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { createTestDom } from "../../ui.helpers.mjs";
import { mountOptionsView } from "./options.mjs";

const CATEGORIES = [

  { description: "Motion Options", name: "Motion" },
  { description: "Audio Options", name: "Audio" }
];

const OPTIONS = {

  Audio: [{ default: false, defaultValue: 50, description: "Audio volume level.", name: "Volume" }],

  Motion: [

    { default: true, description: "Enable motion detection.", name: "Detect" },
    { default: false, description: "Motion sensitivity tuning.", group: "Detect", name: "Sensitivity" }
  ]
};

const CATALOG = {

  ...buildCatalogIndex(CATEGORIES, OPTIONS),

  validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
};

const setup = ({ configuredOptions = [], scope } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const configTable = document.createElement("div");
  const controller = new AbortController();

  configTable.id = "configTable";
  document.body.appendChild(configTable);

  store.dispatch({ catalog: CATALOG, configuredOptions, controllers: [], mode: "device-only", type: "model:loaded" });

  if(scope) {

    store.dispatch({ scope, type: "scope:changed" });
  }

  mountOptionsView({ configTable, platform: () => "test-plugin", signal: controller.signal, store });

  // The mount registers the scope-render effect; trigger an initial scope render so the table has category shells.
  if(!scope) {

    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
  }

  return { abort: () => controller.abort(), configTable, store };
};

describe("mountOptionsView - initial render", () => {

  test("builds category shells for every active category", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const categories = [...configTable.querySelectorAll("details[data-category]")];

    assert.equal(categories.length, 2);
    assert.equal(categories[0].getAttribute("data-category"), "Motion");
    assert.equal(categories[1].getAttribute("data-category"), "Audio");
  });

  test("category shells start with an empty rows container (lazy materialization)", () => {

    using _dom = createTestDom();

    const { configTable } = setup();

    for(const details of configTable.querySelectorAll("details[data-category]")) {

      assert.equal(details.querySelector(".fo-category-rows").children.length, 0);
    }
  });
});

describe("mountOptionsView - lazy row materialization", () => {

  test("expanding a category for the first time materializes its rows", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    assert.equal(motion.querySelector(".fo-category-rows").children.length, 0);

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    assert.equal(motion.querySelector(".fo-category-rows").children.length, 2, "Motion has Detect + Sensitivity");
    assert.equal(motion.dataset.rowsRendered, "true");
  });

  test("collapsing a category preserves its materialized rows", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));
    motion.open = false;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    assert.equal(motion.querySelector(".fo-category-rows").children.length, 2, "rows preserved after collapse");
  });
});

describe("mountOptionsView - checkbox click dispatch", () => {

  test("clicking a checkbox dispatches the tri-state transition's action", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = motion.querySelector("#Motion\\.Detect");

    assert.equal(checkbox.checked, true, "Motion.Detect default true");

    // Simulate the click toggling the checkbox (Happy-DOM updates .checked on .click()).
    checkbox.click();

    // Action should have been dispatched. Motion.Detect default is true; post-click state is unchecked.
    assert.deepEqual(store.state.configuredOptions, ["Disable.Motion.Detect"]);
  });

  test("text-input change re-fires as a checkbox change", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = audio.querySelector("#Audio\\.Volume");

    // Check first so the input becomes editable.
    checkbox.click();

    const input = audio.querySelector("input[type='text']");

    input.value = "75";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // The change handler re-dispatches as a checkbox change. The state should now reflect a re-set with the new value.
    assert.equal(store.state.configuredOptions.some((entry) => entry.includes("75")), true);
  });
});

describe("mountOptionsView - modified-option highlight", () => {

  test("toggling an option off its default re-colors the label text-info in place; reverting restores text-body", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    const detectLabel = motion.querySelector("#row-Motion\\.Detect label");
    const detectCheckbox = motion.querySelector("#Motion\\.Detect");

    // Motion.Detect is default-on and unconfigured: unmodified, so text-body.
    assert.equal(detectLabel.classList.contains("text-body"), true, "starts unmodified");
    assert.equal(detectLabel.classList.contains("text-info"), false);

    // Toggle off - deviates from the default-on, so the row is now modified and must highlight. The dispatch drives the projection walk, which re-derives the label.
    detectCheckbox.click();

    assert.equal(detectLabel.classList.contains("text-info"), true, "toggling off-default highlights the label in place");
    assert.equal(detectLabel.classList.contains("text-body"), false, "the prior color class is replaced, not accumulated");

    // Toggle back on - matches the default again, so the highlight must clear.
    detectCheckbox.click();

    assert.equal(detectLabel.classList.contains("text-body"), true, "reverting to the default removes the highlight");
    assert.equal(detectLabel.classList.contains("text-info"), false, "no stale highlight survives the revert");
  });
});

describe("mountOptionsView - filter visibility", () => {

  test("filter:changed with mode=modified hides unmodified rows", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ configuredOptions: ["Disable.Motion.Detect"] });
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    store.dispatch({ mode: "modified", type: "filter:changed" });

    const detectRow = motion.querySelector("#row-Motion\\.Detect");
    const sensitivityRow = motion.querySelector("#row-Motion\\.Sensitivity");

    assert.equal(detectRow.classList.contains("fo-hidden"), false);
    assert.equal(sensitivityRow.classList.contains("fo-hidden"), true);
  });
});

describe("mountOptionsView - per-device cache", () => {

  test("navigating away and back to the same scope restores the prior view's DOM from cache", () => {

    using _dom = createTestDom();

    const dev = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };
    const { configTable, store } = setup();

    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [dev], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    // Move to a device scope to populate per-device cache.
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    const materializedFingerprint = motion.querySelector(".fo-category-rows").children.length;

    // Navigate away and back.
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    const restoredMotion = configTable.querySelector("details[data-category='Motion']");

    assert.equal(restoredMotion.querySelector(".fo-category-rows").children.length, materializedFingerprint, "materialized rows survive the round-trip");
  });

  test("a mutation that lands while another device's view is cached invalidates that cache so the rebuilt view reflects the mutation", () => {

    using _dom = createTestDom();

    const devs = [

      { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" },
      { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device B", serialNumber: "dev-b" }
    ];
    const { configTable, store } = setup();

    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: devs, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    const motionA = configTable.querySelector("details[data-category='Motion']");

    motionA.open = true;
    motionA.dispatchEvent(new Event("toggle", { bubbles: false }));
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-b", kind: "device" }, type: "scope:changed" });

    // Mutate Motion.Detect globally while viewing dev-b. dev-a's cached DOM showed the old (default-true) state; after the rebuild it must reflect the new state.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    // The category state for dev-a (Motion expanded) is restored, so rows materialize. They must reflect the post-mutation state - the cache was invalidated.
    const restoredMotion = configTable.querySelector("details[data-category='Motion']");
    const detectCheckbox = restoredMotion?.querySelector("#Motion\\.Detect");

    // The post-mutation dev-a view is rebuilt from current state. The global Disable propagates into the device view as inheritance: indeterminate + readOnly.
    assert.equal(detectCheckbox?.indeterminate, true, "device view inherits from global - checkbox is indeterminate");
    assert.equal(detectCheckbox?.readOnly, true, "inheriting from upstream - read-only");
  });
});

describe("mountOptionsView - legacy category-state key migration", () => {

  // The pre-reactive-store architecture wrote category-state entries under context keys of shape `"Global Options"` (for the global view) or the bare device serial
  // (for any device view). The reactive-store refactor unified these under {@link scopeCacheKey}'s output. On first visit to a view after the upgrade, we expect the
  // restore path to find data under the legacy key, write it under the new key, and delete the legacy entry - leaving disk in the new shape for every subsequent
  // visit.

  // The localStorage storage key is plugin-namespaced. setup()'s platform thunk returns "test-plugin", so all writes land under this key.
  const STORAGE_KEY = "homebridge-test-plugin-category-states";

  test("a global view restores category state from the legacy \"Global Options\" key and migrates it under the new \"global\" key", () => {

    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "Global Options": { Audio: false, Motion: true } }));

    // First mount triggers an initial scope:changed -> global, which fires the scope-render effect and runs the legacy lookup.
    const { configTable } = setup();

    // The Motion category was persisted as collapsed (open: false in our captureCategoryStates contract is the inverse of the boolean we recorded - it stores
    // collapsed-state). Re-reading the live DOM tells us the saved state was actually applied: the open attribute on the Motion details element reflects what we
    // seeded under the legacy key.
    const motion = configTable.querySelector("details[data-category='Motion']");
    const audio = configTable.querySelector("details[data-category='Audio']");

    // Seeded state: Motion: true (collapsed), Audio: false (expanded). Verify applyCategoryStates honored both.
    assert.equal(motion.open, false, "Motion was seeded as collapsed in the legacy entry - the restore must have applied it");
    assert.equal(audio.open, true, "Audio was seeded as expanded in the legacy entry - the restore must have applied it");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok(!("Global Options" in persisted), "the legacy key must be removed from disk after migration");
    assert.deepEqual(persisted.global, { Audio: false, Motion: true }, "the migrated data must appear under the new \"global\" key");
  });

  test("a device view restores category state from the legacy bare-device-serial key and migrates it under the new \"device:/<serial>\" key", () => {

    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "DEV-A": { Audio: true, Motion: false } }));

    const { configTable, store } = setup();
    const dev = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "DEV-A" };

    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [dev], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    store.dispatch({ scope: { controllerId: null, deviceId: "DEV-A", kind: "device" }, type: "scope:changed" });

    const motion = configTable.querySelector("details[data-category='Motion']");
    const audio = configTable.querySelector("details[data-category='Audio']");

    assert.equal(motion.open, true, "Motion was seeded as expanded under the legacy device-serial key - the restore must have applied it");
    assert.equal(audio.open, false, "Audio was seeded as collapsed under the legacy device-serial key - the restore must have applied it");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok(!("DEV-A" in persisted), "the legacy device-serial key must be removed from disk after migration");
    assert.deepEqual(persisted["device:/DEV-A"], { Audio: true, Motion: false },
      "the migrated data must appear under the new device-key shape (controllerId slot empty in device-only mode)");
  });

  test("a view with no legacy entry produces no spurious lookup or migration; new-shape data round-trips unchanged", () => {

    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ global: { Audio: false, Motion: true } }));

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    assert.equal(motion.open, false, "the new-shape data was applied directly - no migration was needed");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok(!("Global Options" in persisted), "no spurious writes to the legacy key from the migration path - it was never consulted");
    assert.deepEqual(persisted.global, { Audio: false, Motion: true }, "the new-shape data is round-tripped intact (caller round-trip captures both categories' state)");
  });

  test("a second visit to a migrated view reads directly from the new key (the legacy lookup is not consulted again)", () => {

    // After the first visit migrates, the legacy entry is gone. Subsequent visits must find data under the new key alone - this proves the migration was
    // structural, not just a one-time copy, and that the new key is now the canonical storage location.
    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "Global Options": { Motion: true } }));

    // First mount triggers the migration.
    const first = setup();

    first.abort();

    // Re-seed the legacy key with DIFFERENT data to prove the second visit does NOT re-read it - if it did, the assertion below would see the new (re-seeded)
    // value, not the originally-migrated one.
    const persistedAfterFirst = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    persistedAfterFirst["Global Options"] = { Motion: false };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedAfterFirst));

    const second = setup();
    const motion = second.configTable.querySelector("details[data-category='Motion']");

    assert.equal(motion.open, false, "the second visit reads from the new \"global\" key (Motion: true -> collapsed), not the re-seeded legacy key");
  });
});
