/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/rendering.test.mjs: Unit tests for the pure-function rendering module.
 */
"use strict";

import { applyRowState, categoryShell, optionRow, triStateTransition } from "./rendering.mjs";
import { buildCatalogIndex, buildConfigIndex } from "../featureOptions.js";
import { describe, test } from "node:test";
import { initialState, reducer } from "./state.mjs";
import assert from "node:assert/strict";
import { createTestDom } from "../ui.helpers.mjs";
import { projection } from "./selectors.mjs";

// Catalog fixture: covers the row archetypes (boolean, grouped boolean, and value-centric options with and without an explicit inputSize) plus a controller-detectable
// device fixture for upstream tests. Post-unification inputSize feeds only the field width, not the layout, so both value options exercise the same stacked structure.
const CATEGORIES = [

  { description: "Motion Options", name: "Motion" },
  { description: "Audio Options", name: "Audio" }
];

const OPTIONS = {

  Audio: [

    { default: false, defaultValue: 50, description: "Audio volume level.", inputSize: 3, name: "Volume" },
    { default: false, defaultValue: 80, description: "Bandwidth ceiling.", name: "Bandwidth" }
  ],

  Motion: [

    { default: true, description: "Enable motion detection.", name: "Detect" },
    { default: false, description: "Motion sensitivity tuning.", group: "Detect", name: "Sensitivity" }
  ]
};

const buildCatalog = () => ({

  ...buildCatalogIndex(CATEGORIES, OPTIONS),

  validators: {

    isController: () => false,
    validOption: () => true,
    validOptionCategory: () => true
  }
});

// Build a "ready" state via the reducer so the projection produces real entries. Tests then read entries via the projection rather than constructing them by hand,
// matching how the view layer will consume rendering at runtime.
const loadedState = ({ configuredOptions = [], devices = [], scope } = {}) => {

  const catalog = buildCatalog();
  const base = reducer(initialState(), { catalog, configuredOptions, controllers: [], mode: "device-only", type: "model:loaded" });
  const withDevices = reducer(base, { devices, type: "devices:loaded" });

  return scope ? reducer(withDevices, { scope, type: "scope:changed" }) : withDevices;
};

const findEntry = (state, categoryName, optionName) => projection(state).categories.find((c) => c.name === categoryName).entries.find((e) => e.name === optionName);

describe("categoryShell", () => {

  test("builds a details/summary/rows-container with the category's data-category attribute", () => {

    using _dom = createTestDom();

    const details = categoryShell({ category: { description: "Motion Options", name: "Motion" }, scopeKind: "global" });

    assert.equal(details.tagName, "DETAILS");
    assert.equal(details.classList.contains("fo-category"), true);
    assert.equal(details.getAttribute("data-category"), "Motion");
    assert.equal(details.querySelector("summary")?.classList.contains("fo-category-header"), true);
    assert.equal(details.querySelector(".fo-category-rows")?.children.length, 0, "rows container is empty (lazy materialization)");
  });

  test("the summary header carries the catalog description suffixed by the scope label", () => {

    using _dom = createTestDom();

    const global = categoryShell({ category: { description: "Motion Options", name: "Motion" }, scopeKind: "global" });
    const controller = categoryShell({ category: { description: "Motion Options", name: "Motion" }, scopeKind: "controller" });
    const device = categoryShell({ category: { description: "Motion Options", name: "Motion" }, scopeKind: "device" });

    assert.equal(global.querySelector(".fo-category-title")?.textContent, "Motion Options (Global)");
    assert.equal(controller.querySelector(".fo-category-title")?.textContent, "Motion Options (Controller-specific)");
    assert.equal(device.querySelector(".fo-category-title")?.textContent, "Motion Options (Device-specific)");
  });
});

describe("optionRow - basic structure", () => {

  test("builds a row with a checkbox and a label for a boolean option", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });

    assert.equal(row.classList.contains("fo-option-row"), true);
    assert.equal(row.id, "row-Motion.Detect");

    const checkbox = row.querySelector("input[type='checkbox']");
    const label = row.querySelector("label");
    const valueInput = row.querySelector("input[type='text']");

    assert.equal(checkbox?.id, "Motion.Detect");
    assert.equal(label?.getAttribute("for"), "Motion.Detect");
    assert.equal(label?.textContent, "Enable motion detection.");
    assert.equal(valueInput, null, "boolean options have no value input");

    // A boolean row uses the same uniform shape as a value row: checkbox + content cell. The cell holds just the label.
    const content = row.querySelector(".fo-option-content");

    assert.ok(content?.contains(label), "the boolean label lives in the uniform content cell");
    assert.equal(row.children[0], checkbox, "checkbox is the first grid child");
    assert.equal(row.children[1], content, "the content cell is the second grid child");
  });

  test("adds the grouped-option class to grouped options", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const entry = findEntry(state, "Motion", "Sensitivity");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });

    assert.equal(row.classList.contains("grouped-option"), true);
  });

  test("a value-centric option stacks its value-input beneath the label inside the content cell", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const entry = findEntry(state, "Audio", "Bandwidth");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });

    // Uniform shape: checkbox in the first grid track, content cell in the second. The cell stacks the label then the value-input.
    assert.equal(row.children[0].tagName, "INPUT", "checkbox first");
    assert.equal(row.children[0].type, "checkbox");

    const cell = row.children[1];

    assert.equal(cell.classList.contains("fo-option-content"), true, "content cell second");
    assert.equal(cell.children[0].tagName, "LABEL", "label first in the cell");
    assert.equal(cell.children[1].tagName, "INPUT", "value-input stacked beneath the label");
    assert.equal(cell.children[1].type, "text");
  });

  test("inputSize sets only the field width - a value option with and without it render the same stacked structure", () => {

    using _dom = createTestDom();

    const state = loadedState();

    // Volume declares inputSize: 3; Bandwidth declares none. Pre-unification these took divergent layouts (inline flex vs three-column grid); now both stack identically
    // and inputSize feeds only the field width. The legacy inline classes must no longer appear on any row.
    const withSize = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Volume"), scopeKind: "global" });
    const withoutSize = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Bandwidth"), scopeKind: "global" });

    for(const row of [ withSize, withoutSize ]) {

      assert.equal(row.classList.contains("fo-option-row-inline"), false, "no inline row variant survives the unification");
      assert.equal(row.querySelector(".fo-option-label-cell"), null, "no flex label-cell survives the unification");

      const cell = row.querySelector(".fo-option-content");

      assert.ok(cell, "every value row carries the stacked content cell");
      assert.equal(cell.children[0].tagName, "LABEL", "label first");
      assert.equal(cell.children[1].tagName, "INPUT", "value-input beneath");
    }

    // inputSize is reflected purely as the field's ch width; its absence falls back to the 5 ch default.
    assert.equal(withSize.querySelector(".fo-option-value").style.width, "3ch", "an explicit inputSize sets the field width");
    assert.equal(withoutSize.querySelector(".fo-option-value").style.width, "5ch", "no inputSize falls back to the 5 ch default");
  });

  test("checkbox carries the data-device-serial attribute for device-scoped views", () => {

    using _dom = createTestDom();

    const state = loadedState({

      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: "dev-a", entry, scopeKind: "device" });
    const checkbox = row.querySelector("input[type='checkbox']");

    assert.equal(checkbox?.getAttribute("data-device-serial"), "dev-a");
  });
});

describe("optionRow - initial tri-state", () => {

  test("checked = true when the option is enabled by default and not modified", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const checkbox = row.querySelector("input[type='checkbox']");

    assert.equal(checkbox?.checked, true);
    assert.equal(checkbox?.indeterminate, false);
    assert.equal(checkbox?.readOnly, false);
  });

  test("indeterminate + readOnly when the resolved scope is strictly higher than the view scope", () => {

    using _dom = createTestDom();

    // Disable globally; view as a device. The entry resolves at "global"; the device view sees it as inherited.
    const state = loadedState({

      configuredOptions: ["Disable.Motion.Detect"],
      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: "dev-a", entry, scopeKind: "device" });
    const checkbox = row.querySelector("input[type='checkbox']");

    assert.equal(checkbox?.indeterminate, true);
    assert.equal(checkbox?.readOnly, true);
  });

  test("checked = entry.enabled at the global view when no upstream is possible", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const checkbox = row.querySelector("input[type='checkbox']");

    assert.equal(checkbox?.checked, false, "globally disabled");
    assert.equal(checkbox?.indeterminate, false, "no inheritance at global view");
  });
});

describe("optionRow - value input initialization", () => {

  test("uses the projection entry's resolved value when the option is enabled at the current scope", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Enable.Audio.Volume.75"] });
    const entry = findEntry(state, "Audio", "Volume");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const valueInput = row.querySelector("input[type='text']");

    assert.equal(valueInput?.value, "75");
    assert.equal(valueInput?.disabled, false, "editable when enabled");
    assert.equal(valueInput?.getAttribute("aria-disabled"), null, "an editable input carries no aria-disabled");
  });

  test("falls back to the catalog default value when no entry is configured", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const entry = findEntry(state, "Audio", "Volume");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const valueInput = row.querySelector("input[type='text']");

    assert.equal(valueInput?.value, "50", "catalog default");
    assert.equal(valueInput?.disabled, true, "disabled when not enabled");
    assert.equal(valueInput?.getAttribute("aria-disabled"), "true", "a disabled input signals aria-disabled to assistive tech");
  });

  test("is disabled when inheriting from a higher scope", () => {

    using _dom = createTestDom();

    const state = loadedState({

      configuredOptions: ["Enable.Audio.Volume.99"],
      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const entry = findEntry(state, "Audio", "Volume");
    const row = optionRow({ deviceId: "dev-a", entry, scopeKind: "device" });
    const valueInput = row.querySelector("input[type='text']");

    assert.equal(valueInput?.disabled, true, "inheriting - input disabled");
    assert.equal(valueInput?.value, "99", "shows the inherited value");
    assert.equal(valueInput?.getAttribute("aria-disabled"), "true", "an inheriting input signals aria-disabled to assistive tech");
  });
});

describe("optionRow - label color", () => {

  test("text-info for a modified option that deviates from default", () => {

    using _dom = createTestDom();

    // Default-on motion turned off globally - deviates.
    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const label = row.querySelector("label");

    assert.equal(label?.classList.contains("text-info"), true);
  });

  test("text-body for an unmodified default-state option", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const label = row.querySelector("label");

    assert.equal(label?.classList.contains("text-body"), true);
  });

  test("a value-only deviation (enabled-state still matches the default) does NOT highlight - the cue is boolean-deviation-only", () => {

    using _dom = createTestDom();

    // A value-centric option that defaults to ENABLED. Configuring only its value (the enabled-state still matches the default-on) is a value-only deviation: the
    // option is modified, but on the value axis, not the boolean axis. Per the v1-parity rule the label must stay text-body. The shared fixture has no default-on value
    // option, so we build a bespoke one-option catalog to isolate the case.
    const categories = [{ description: "Audio Options", name: "Audio" }];
    const options = { Audio: [{ default: true, defaultValue: 50, description: "Audio volume level.", name: "Volume" }] };
    const catalog = { ...buildCatalogIndex(categories, options), validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true } };
    const state = reducer(initialState(), { catalog, configuredOptions: ["Enable.Audio.Volume.75"], controllers: [], mode: "device-only", type: "model:loaded" });
    const entry = projection(state).categories.find((category) => category.name === "Audio").entries.find((option) => option.name === "Volume");

    assert.equal(entry.isModified, true, "a configured entry exists - the option is modified");
    assert.equal(entry.enabled, options.Audio[0].default, "the enabled-state still matches the default - the deviation is value-only");

    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const label = row.querySelector("label");

    assert.equal(label?.classList.contains("text-body"), true, "a value-only deviation stays text-body");
    assert.equal(label?.classList.contains("text-info"), false, "a value-only deviation does NOT highlight - boolean-deviation-only by design");
  });
});

describe("triStateTransition - was indeterminate (readOnly)", () => {

  test("transitions to unchecked with a clear or set action based on the write rule", () => {

    using _dom = createTestDom();

    const state = loadedState({

      configuredOptions: ["Disable.Motion.Detect"],
      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Motion", "Detect");

    // Simulate the click on an indeterminate checkbox.
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.readOnly = true;
    checkbox.indeterminate = true;

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: "dev-a", entry, inputValue: null });

    // Default is true, post-state is false: deviates. AND there is upstream (the global Disable). Write needed. The transition returns only the action - the resulting
    // DOM state is re-derived from the post-dispatch projection by applyRowState (covered by its own tests), not returned here.
    assert.equal(result.action.type, "option:set");
    assert.equal(result.action.args.enabled, false);
    assert.equal(result.action.args.option, "Motion.Detect");
    assert.equal(result.action.args.id, "dev-a");
  });
});

describe("triStateTransition - was checked, just unchecked", () => {

  test("with no upstream entry, stays unchecked with a clear-or-set action", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Enable.Audio.Volume"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");

    // Simulate click that toggled checked->unchecked.
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = false;

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: null, entry, inputValue: null });

    // Audio.Volume default is false; post-state is false; no value deviation; no upstream. ClearOption.
    assert.equal(result.action.type, "option:cleared");
  });

  test("with an upstream entry, transitions to indeterminate and dispatches clearOption", () => {

    using _dom = createTestDom();

    // Globally enabled. Device view picks up upstream.
    const state = loadedState({

      configuredOptions: [ "Enable.Motion.Detect", "Enable.Motion.Detect.dev-a" ],
      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Motion", "Detect");

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = false;

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: "dev-a", entry, inputValue: null });

    // Upstream exists (the global Enable), so unchecking falls back to inheritance via a clearOption. The resulting indeterminate + readOnly DOM state is re-derived by
    // applyRowState from the post-clear projection, not returned here.
    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.id, "dev-a");
  });
});

describe("triStateTransition - was unchecked, just checked", () => {

  test("transitions to checked; writes setOption when post-state deviates from default", () => {

    using _dom = createTestDom();

    // Audio.Volume default is false. Click enables it.
    const state = loadedState();
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = true;

    const inputValue = document.createElement("input");

    inputValue.type = "text";
    inputValue.value = "60";

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: null, entry, inputValue });

    assert.equal(result.action.type, "option:set");
    assert.equal(result.action.args.enabled, true);
    assert.equal(result.action.args.value, "60");
  });

  test("when post-state matches default with no upstream and no value deviation, dispatches clearOption", () => {

    using _dom = createTestDom();

    // Motion.Detect default is true; we previously disabled it; now we re-enable it (back to default).
    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Motion", "Detect");

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = true;

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: null, entry, inputValue: null });

    assert.equal(result.action.type, "option:cleared", "back to default with no upstream - clearOption keeps the array minimal");
  });
});

describe("applyRowState - re-derivation on the update path", () => {

  test("a row whose option becomes modified re-colors its label to text-info in place, and reverting restores text-body", () => {

    using _dom = createTestDom();

    // Start from the default (unmodified) state: Motion.Detect is default-on and unconfigured, so the label is text-body.
    const defaultState = loadedState();
    const row = optionRow({ deviceId: null, entry: findEntry(defaultState, "Motion", "Detect"), scopeKind: "global" });
    const label = row.querySelector("label");
    const checkbox = row.querySelector("input[type='checkbox']");

    assert.equal(label.classList.contains("text-body"), true, "an unmodified row starts text-body");
    assert.equal(label.classList.contains("text-info"), false);
    assert.equal(checkbox.checked, true, "default-on");

    // Re-derive against a modified projection (globally disabled deviates from the default-on). This is exactly what the view's per-mutation walk does after a toggle.
    const modifiedState = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });

    applyRowState({ entry: findEntry(modifiedState, "Motion", "Detect"), row, scopeKind: "global" });

    assert.equal(label.classList.contains("text-info"), true, "the modified row re-colors to text-info in place");
    assert.equal(label.classList.contains("text-body"), false, "the prior color class is removed, not accumulated");
    assert.equal(checkbox.checked, false, "the checkbox re-derives to the new resolved state");

    // Revert: re-derive against the default projection again. The highlight must clear.
    applyRowState({ entry: findEntry(defaultState, "Motion", "Detect"), row, scopeKind: "global" });

    assert.equal(label.classList.contains("text-body"), true, "reverting to default re-colors back to text-body");
    assert.equal(label.classList.contains("text-info"), false, "no stale modification highlight survives the revert");
    assert.equal(checkbox.checked, true, "the checkbox re-derives back to the default-on state");
  });

  test("repeated re-derivation never accumulates more than one color class", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Disable.Motion.Detect"] });
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const label = row.querySelector("label");

    applyRowState({ entry, row, scopeKind: "global" });
    applyRowState({ entry, row, scopeKind: "global" });

    const colorClasses = [ "text-body", "text-info", "text-success", "text-warning" ].filter((klass) => label.classList.contains(klass));

    assert.deepEqual(colorClasses, ["text-info"], "exactly one color class is present after repeated re-derivation - the four are mutually exclusive");
  });

  test("does not clobber the value a user is actively editing, but re-derives once focus leaves", () => {

    using _dom = createTestDom();

    // The row must be ATTACHED to the document for document.activeElement to track its input - the focus guard is meaningless on a detached node, so this test must
    // append the row to exercise the guard's protective branch (the one reason the guard exists).
    const state = loadedState({ configuredOptions: ["Enable.Audio.Volume.75"] });
    const entry = findEntry(state, "Audio", "Volume");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });

    document.body.appendChild(row);

    const input = row.querySelector("input[type='text']");

    assert.equal(input.value, "75", "the input starts at the configured value");

    // Simulate an in-progress edit: focus the input and type without committing.
    input.focus();
    assert.equal(document.activeElement, input, "precondition: the input holds focus");
    input.value = "30";

    // A background re-projection (e.g. a sibling mutation) must NOT overwrite the focused, uncommitted edit.
    applyRowState({ entry, row, scopeKind: "global" });

    assert.equal(input.value, "30", "the focused, uncommitted edit survives the re-derive");

    // Once focus leaves, the projection's resolved value is authoritative again.
    input.blur();
    applyRowState({ entry, row, scopeKind: "global" });

    assert.equal(input.value, "75", "after blur the re-derive restores the projection's resolved value");
  });

  test("re-derives a row from explicit to inheriting (indeterminate + readOnly) when the projection resolves upstream", () => {

    using _dom = createTestDom();

    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];

    // Explicit at the device scope: the checkbox reflects the resolved enabled state directly, not inheriting.
    const explicitState = loadedState({ configuredOptions: ["Disable.Motion.Detect.dev-a"], devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const row = optionRow({ deviceId: "dev-a", entry: findEntry(explicitState, "Motion", "Detect"), scopeKind: "device" });
    const checkbox = row.querySelector("input[type='checkbox']");

    assert.equal(checkbox.indeterminate, false, "explicit at the device scope - not inheriting");

    // Now the option is set only globally; the device view inherits it. Re-derive the existing row in place - the update path must flip it to indeterminate + readOnly.
    const inheritingState = loadedState({ configuredOptions: ["Disable.Motion.Detect"], devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });

    applyRowState({ entry: findEntry(inheritingState, "Motion", "Detect"), row, scopeKind: "device" });

    assert.equal(checkbox.indeterminate, true, "re-derives to indeterminate when the resolved scope is upstream");
    assert.equal(checkbox.readOnly, true, "inheriting from upstream - readOnly");
  });
});
