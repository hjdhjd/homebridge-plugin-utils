/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/rendering.test.mjs: Unit tests for the pure-function rendering module.
 */
"use strict";

import { ALL_CHOICES, buildCatalogIndex, buildConfigIndex } from "../featureOptions.js";
import { applyRowState, categoryShell, controlValueText, focusControl, optionRow, toggleSecretReveal, triStateTransition,
  valueCommitTransition } from "./rendering.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "./state.mjs";
import assert from "node:assert/strict";
import { createTestDom } from "../ui.helpers.mjs";
import { projection } from "./selectors.mjs";

// Catalog fixture: covers the row archetypes (boolean, grouped boolean, value-centric options with and without an explicit inputSize, a default-on value-centric
// option whose declared default is what an emptied field has to fall back to, and a secret value option) plus a controller-detectable device fixture for upstream
// tests. inputSize feeds only the field width, not the layout, so every value option exercises the same stacked structure regardless of whether inputSize is
// declared. The secret option ships an empty defaultValue, which is what a credential declares: value-centric, with nothing meaningful to default to.
const CATEGORIES = [

  { description: "Motion Options", name: "Motion" },
  { description: "Audio Options", name: "Audio" }
];

const OPTIONS = {

  Audio: [

    { default: false, defaultValue: 50, description: "Audio volume level.", inputSize: 3, name: "Volume" },
    { default: false, defaultValue: 80, description: "Bandwidth ceiling.", name: "Bandwidth" },
    { default: true, defaultValue: "stereo", description: "Default audio channel layout.", name: "Layout" },
    { default: false, defaultValue: "", description: "Streaming account password.", inputSize: 20, name: "Password", secret: true }
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

  // Land the devices through the request/outcome pairing the reducer guards: mint the fetch sequence, then apply the outcome stamped with it.
  const requested = reducer(base, { controllerId: null, type: "devices:requested" });
  const withDevices = reducer(requested, { controllerId: null, devices, error: "", seq: requested.devicesRequest.seq, type: "devices:loaded" });

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
    const valueInput = row.querySelector("input.fo-option-value");

    assert.equal(checkbox?.id, "Motion.Detect");
    assert.equal(label?.getAttribute("for"), "Motion.Detect");
    assert.equal(label?.textContent, "Enable motion detection.");
    assert.equal(valueInput, null, "boolean options have no value input");

    // A boolean row uses the same uniform shape as a value row: checkbox + content cell. The cell holds just the label.
    const content = row.querySelector(".fo-option-content");

    assert.ok(content?.contains(label), "the boolean label lives in the uniform content cell");
    assert.ok(row.children[0] === checkbox, "checkbox is the first grid child");
    assert.ok(row.children[1] === content, "the content cell is the second grid child");
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

    // Volume and Bandwidth (with and without an explicit inputSize) render through the identical stacked structure; no row carries an inline-flex or three-column class
    // regardless of whether inputSize is declared.
    const withSize = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Volume"), scopeKind: "global" });
    const withoutSize = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Bandwidth"), scopeKind: "global" });

    for(const row of [ withSize, withoutSize ]) {

      assert.equal(row.classList.contains("fo-option-row-inline"), false, "no inline row variant survives the unification");
      assert.ok(row.querySelector(".fo-option-label-cell") === null, "no flex label-cell survives the unification");

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

  test("checkbox carries no value attribute - the scope it belongs to is read from state, never from the element", () => {

    using _dom = createTestDom();

    const state = loadedState({

      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const entry = findEntry(state, "Motion", "Detect");
    const row = optionRow({ deviceId: "dev-a", entry, scopeKind: "device" });
    const checkbox = row.querySelector("input[type='checkbox']");

    assert.equal(checkbox?.getAttribute("value"), null, "a checkbox composes no address of its own - the engine owns every spelling of a scoped address");
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
    const valueInput = row.querySelector("input.fo-option-value");

    assert.equal(valueInput?.value, "75");
    assert.equal(valueInput?.disabled, false, "editable when enabled");
    assert.equal(valueInput?.getAttribute("aria-disabled"), null, "an editable input carries no aria-disabled");
  });

  test("falls back to the catalog default value when no entry is configured, and locks until the option is enabled", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const entry = findEntry(state, "Audio", "Volume");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const valueInput = row.querySelector("input.fo-option-value");

    assert.equal(valueInput?.value, "50", "catalog default");
    assert.equal(valueInput?.disabled, true, "a disabled or unset row locks its input - the checkbox is the affordance that enables or arms it");
    assert.equal(valueInput?.getAttribute("aria-disabled"), "true", "a locked input signals aria-disabled to assistive tech");
  });

  test("renders checked with a live input while armed, though nothing is configured", () => {

    using _dom = createTestDom();

    const state = loadedState({

      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const entry = findEntry(state, "Audio", "Volume");
    const row = optionRow({ armed: true, deviceId: "dev-a", entry, scopeKind: "device" });
    const checkbox = row.querySelector("input[type='checkbox']");
    const valueInput = row.querySelector("input.fo-option-value");

    assert.equal(checkbox?.checked, true, "an armed row reads checked - the arming gesture's own affordance");
    assert.equal(valueInput?.disabled, false, "an armed row's input is live, awaiting the first value that will actually enable the option");
    assert.equal(valueInput?.getAttribute("aria-disabled"), null, "an armed input carries no aria-disabled");
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
    const valueInput = row.querySelector("input.fo-option-value");

    assert.equal(valueInput?.disabled, true, "inheriting - input disabled");
    assert.equal(valueInput?.value, "99", "shows the inherited value");
    assert.equal(valueInput?.getAttribute("aria-disabled"), "true", "an inheriting input signals aria-disabled to assistive tech");
  });
});

describe("optionRow - secret options", () => {

  test("a secret option renders a masked field with its reveal toggle beside it", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const row = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Password"), scopeKind: "global" });
    const input = row.querySelector("input.fo-option-value");
    const toggle = row.querySelector(".fo-secret-toggle");

    assert.equal(input?.type, "password", "a secret option's value is masked");
    assert.equal(input?.getAttribute("autocomplete"), "new-password", "the masked field asks the browser's credential manager to leave it alone");
    assert.equal(input?.style.width, "20ch", "a secret option declares its width like any other value option");
    assert.equal(toggle?.tagName, "BUTTON");
    assert.equal(toggle?.type, "button", "a bare button, so it can never submit anything");
    assert.equal(toggle?.getAttribute("aria-label"), "Show the value.", "the label names what the next click does");
    assert.equal(toggle?.getAttribute("aria-pressed"), "false", "the field starts masked");
    assert.equal(toggle?.querySelector("svg")?.getAttribute("stroke"), "currentColor", "the glyph draws in whatever color surrounds it");
    assert.equal(toggle?.querySelector("svg")?.getAttribute("aria-hidden"), "true", "the glyph is decorative - the button's own label names the action");

    // The field and its toggle share a wrapper, which is what puts the control beside the field: the content cell stacks its children, so an unwrapped toggle
    // would land on its own line beneath the field.
    const wrapper = row.querySelector(".fo-secret-field");

    assert.ok(wrapper?.contains(input), "the masked field lives in the wrapper");
    assert.ok(wrapper?.contains(toggle), "and so does its toggle");
    assert.ok(row.querySelector(".fo-option-content").children[1] === wrapper, "the wrapper takes the field's place in the content cell");
  });

  test("an option that declares no secret renders an unmasked field with no toggle and no wrapper", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const row = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Volume"), scopeKind: "global" });
    const input = row.querySelector("input.fo-option-value");
    const cell = row.querySelector(".fo-option-content");

    assert.equal(input?.type, "text", "an unflagged option's field is a plain text input");
    assert.equal(input?.getAttribute("autocomplete"), null, "an unflagged field declares no autocomplete at all");
    assert.equal(input?.hasAttribute("autocomplete"), false, "not even an empty one");
    assert.ok(row.querySelector(".fo-secret-toggle") === null, "no toggle");
    assert.ok(row.querySelector(".fo-secret-field") === null, "no wrapper");
    assert.equal(cell.children.length, 2, "the content cell holds the label and the field, and nothing else");
    assert.ok(cell.children[1] === input, "the field sits directly in the cell");
  });

  test("the reveal flips the field and the toggle's labelling together, and flips both back", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Enable.Audio.Password=hunter2"] });
    const row = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Password"), scopeKind: "global" });
    const input = row.querySelector("input.fo-option-value");
    const toggle = row.querySelector(".fo-secret-toggle");

    toggleSecretReveal(toggle);

    assert.equal(input.type, "text", "revealed");
    assert.equal(toggle.getAttribute("aria-pressed"), "true", "the pressed state tracks the reveal");
    assert.equal(toggle.getAttribute("aria-label"), "Hide the value.", "and the label now names the way back");
    assert.equal(input.value, "hunter2", "revealing shows the value it already held - it does not rewrite it");

    toggleSecretReveal(toggle);

    assert.equal(input.type, "password", "masked again");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.getAttribute("aria-label"), "Show the value.");
    assert.equal(input.value, "hunter2", "and the value is still there behind the mask");
  });

  test("a revealed field stays revealed when the row is re-derived", () => {

    using _dom = createTestDom();

    // Whether a secret is on screen right now is a property of how the page is being read, not of the configuration, so an unrelated mutation's re-derivation walk
    // must not snap the field shut under the user who is reading it.
    const state = loadedState({ configuredOptions: ["Enable.Audio.Password=hunter2"] });
    const entry = findEntry(state, "Audio", "Password");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });
    const input = row.querySelector("input.fo-option-value");

    toggleSecretReveal(row.querySelector(".fo-secret-toggle"));
    applyRowState({ entry, row, scopeKind: "global" });

    assert.equal(input.type, "text", "the reveal survives the re-derive");
    assert.equal(input.value, "hunter2", "and the value re-derives from the projection as it always does");
  });

  test("the reveal toggle locks and unlocks with the field it belongs to", () => {

    using _dom = createTestDom();

    // Unset and disabled: the row locks its field, and a row that cannot be typed into must not be readable either.
    const state = loadedState();
    const row = optionRow({ deviceId: null, entry: findEntry(state, "Audio", "Password"), scopeKind: "global" });

    assert.equal(row.querySelector("input.fo-option-value").disabled, true, "precondition: an unset row locks its field");
    assert.equal(row.querySelector(".fo-secret-toggle").disabled, true, "the toggle locks with it");

    // Enabled at this scope: the same writer brings both back to life.
    const enabledState = loadedState({ configuredOptions: ["Enable.Audio.Password=hunter2"] });

    applyRowState({ entry: findEntry(enabledState, "Audio", "Password"), row, scopeKind: "global" });

    assert.equal(row.querySelector("input.fo-option-value").disabled, false, "an enabled row unlocks its field");
    assert.equal(row.querySelector(".fo-secret-toggle").disabled, false, "and its toggle with it");
  });

  test("a revealed row that locks is masked again, with its toggle disabled", () => {

    using _dom = createTestDom();

    // A value revealed while the row was live would otherwise sit on screen in clear text once the row locks, with the only control that could put it back behind
    // the mask disabled. Locking re-masks so the disabled toggle guards nothing the user can still see.
    const enabledState = loadedState({ configuredOptions: ["Enable.Audio.Password=hunter2"] });
    const row = optionRow({ deviceId: null, entry: findEntry(enabledState, "Audio", "Password"), scopeKind: "global" });
    const input = row.querySelector("input.fo-option-value");
    const toggle = row.querySelector(".fo-secret-toggle");

    toggleSecretReveal(toggle);

    assert.equal(input.type, "text", "precondition: the value is on screen");
    assert.equal(toggle.getAttribute("aria-pressed"), "true", "precondition: the toggle says so");

    // The option is cleared elsewhere and the row re-derives against an unset projection, which locks it.
    applyRowState({ entry: findEntry(loadedState(), "Audio", "Password"), row, scopeKind: "global" });

    assert.equal(input.disabled, true, "the row locked");
    assert.equal(input.type, "password", "and the value went back behind the mask");
    assert.equal(toggle.disabled, true, "the toggle is disabled");
    assert.equal(toggle.getAttribute("aria-pressed"), "false", "its pressed state follows the field");
    assert.equal(toggle.getAttribute("aria-label"), "Show the value.", "and so does its label");
  });

  test("a row held back by an unmet dependency dims through the same token the disabled toggle reads", () => {

    using _dom = createTestDom();

    // Motion.Sensitivity is grouped under Motion.Detect. With the parent disabled the child is normally hidden outright; a search that matches it keeps it on
    // screen instead, which is the case the badge exists for - visible, but not actionable.
    const state = reducer(loadedState({ configuredOptions: ["Disable.Motion.Detect"] }), { query: "sensitivity", type: "filter:changed" });
    const entry = findEntry(state, "Motion", "Sensitivity");
    const row = optionRow({ deviceId: null, entry, scopeKind: "global" });

    assert.equal(entry.requiresParentBadge, true, "precondition: the search keeps a dependency-blocked row visible, so it wears the badge");
    assert.equal(row.style.opacity, "var(--fo-opacity-disabled)", "the dim reads the shared token rather than carrying a value of its own");

    // With the parent enabled again the row is actionable, and the dim lifts entirely rather than resolving to some other number.
    const actionable = reducer(loadedState(), { query: "sensitivity", type: "filter:changed" });

    applyRowState({ entry: findEntry(actionable, "Motion", "Sensitivity"), row, scopeKind: "global" });

    assert.equal(row.style.opacity, "", "an actionable row carries no dim at all");
  });

  test("a toggle whose row carries no value field does nothing at all", () => {

    using _dom = createTestDom();

    // The view reaches the flip by matching a class on whatever was clicked, so the element arriving here comes from markup rather than from a checkable call
    // site. A toggle standing on its own does nothing, rather than throwing inside a delegated handler.
    const orphan = document.createElement("button");

    orphan.classList.add("fo-secret-toggle");
    orphan.setAttribute("aria-pressed", "false");

    assert.doesNotThrow(() => toggleSecretReveal(orphan));
    assert.equal(orphan.getAttribute("aria-pressed"), "false", "with no field to reveal, the toggle's own state does not move either");
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

    // A value-centric option that defaults to ENABLED. Configuring only its value (the enabled-state still matches the default-on) is a value-only deviation: the option
    // is modified, but on the value axis, not the boolean axis. The modification cue is boolean-deviation-only by design, so the label must stay text-body. The shared
    // fixture has no default-on value option, so we build a bespoke one-option catalog to isolate the case.
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

    // The readOnly and indeterminate flags are what the readOnly transition branch reads; checked is left at its default because that branch never consults it.
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.readOnly = true;
    checkbox.indeterminate = true;

    const result = triStateTransition({ catalog, checkbox, configIndex, control: null, controllerId: null, deviceId: "dev-a", entry });

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

    const result = triStateTransition({ catalog, checkbox, configIndex, control: null, controllerId: null, deviceId: null, entry });

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

    const result = triStateTransition({ catalog, checkbox, configIndex, control: null, controllerId: null, deviceId: "dev-a", entry });

    // Upstream exists (the global Enable), so unchecking falls back to inheritance via a clearOption. The resulting indeterminate + readOnly DOM state is re-derived by
    // applyRowState from the post-clear projection, not returned here.
    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.id, "dev-a");
  });

  test("a default-off value option with a committed value clears rather than writing a disable", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Enable.Audio.Volume.75"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = false;

    // The gesture hands over the row's input element as it stands at click time, still showing the committed value: the DOM is re-derived from the projection only
    // after the dispatch, so the field has not been emptied yet.
    const control = document.createElement("input");

    control.type = "text";
    control.value = "75";

    const result = triStateTransition({ catalog, checkbox, configIndex, control, controllerId: null, deviceId: null, entry });

    // Audio.Volume defaults off, the post-state is off, and nothing upstream needs overriding. A disable would persist no value at all, so the text still in the
    // field cannot justify one and the entry goes away entirely.
    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.id, undefined);
  });

  test("a default-off value option with a committed value clears at device scope rather than writing a disable", () => {

    using _dom = createTestDom();

    // The option is configured at one device and nowhere else, so unchecking it there returns the whole hierarchy to the catalog default.
    const state = loadedState({

      configuredOptions: ["Enable.Audio.Volume.dev-a=75"],
      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = false;

    const control = document.createElement("input");

    control.type = "text";
    control.value = "75";

    const result = triStateTransition({ catalog, checkbox, configIndex, control, controllerId: null, deviceId: "dev-a", entry });

    // Nothing sits above the device entry, so there is no upstream to override and the post-state matches the default. The clear addresses the device scope the
    // gesture was made at.
    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.id, "dev-a");
  });

  test("unchecking a default-on value option writes the explicit disable, which carries no value", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Enable.Audio.Layout.mono"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Layout");

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = false;

    const control = document.createElement("input");

    control.type = "text";
    control.value = "mono";

    const result = triStateTransition({ catalog, checkbox, configIndex, control, controllerId: null, deviceId: null, entry });

    // Audio.Layout defaults on, so turning it off deviates on the boolean axis and the explicit entry is the only way to record that. The entry addresses the option
    // and nothing else.
    assert.equal(result.action.type, "option:set");
    assert.equal(result.action.args.enabled, false);
    assert.equal(result.action.args.value, undefined);
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

    const control = document.createElement("input");

    control.type = "text";
    control.value = "60";

    const result = triStateTransition({ catalog, checkbox, configIndex, control, controllerId: null, deviceId: null, entry });

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

    const result = triStateTransition({ catalog, checkbox, configIndex, control: null, controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:cleared", "back to default with no upstream - clearOption keeps the array minimal");
  });
});

describe("triStateTransition - the armed-row transitions", () => {

  // The scoped-view fixture every arming scenario works from: a device view over the value-centric Audio.Volume with nothing configured.
  const scopedFixture = () => {

    const state = loadedState({

      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });

    return { catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), entry: findEntry(state, "Audio", "Volume") };
  };

  test("checking a scoped value row with an empty input arms it rather than writing", () => {

    using _dom = createTestDom();

    const { catalog, configIndex, entry } = scopedFixture();
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = true;

    const control = document.createElement("input");

    control.type = "text";
    control.value = "";

    const result = triStateTransition({ catalog, checkbox, configIndex, control, controllerId: null, deviceId: "dev-a", entry });

    // A scoped value entry always carries a value, so there is nothing to persist yet - the row arms, unlocking the input for the value that will.
    assert.equal(result.action.type, "option:armed", "a scoped empty enable arms instead of writing");
    assert.equal(result.action.option, entry.expandedName, "the arm names the row it opened");
  });

  test("unchecking an armed row stands it down without writing", () => {

    using _dom = createTestDom();

    const { catalog, configIndex, entry } = scopedFixture();
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = false;

    const control = document.createElement("input");

    control.type = "text";
    control.value = "";

    const result = triStateTransition({ armed: true, catalog, checkbox, configIndex, control, controllerId: null, deviceId: "dev-a", entry });

    // Nothing was ever persisted while armed, so a write-shaped action would disable or clear state the arming gesture never touched.
    assert.equal(result.action.type, "option:disarmed", "an armed row unchecks into a disarm, never a disable");
  });

  test("checking a GLOBAL value row with an empty input still writes the bare enable", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = true;

    const control = document.createElement("input");

    control.type = "text";
    control.value = "";

    const result = triStateTransition({ catalog, checkbox, configIndex, control, controllerId: null, deviceId: null, entry });

    // A bare valueless enable is a legal global entry, so the global view never arms - the write persists and the enabled row's input unlocks normally.
    assert.equal(result.action.type, "option:set", "the global view writes the bare enable rather than arming");
    assert.equal(result.action.args.enabled, true, "the bare enable is an enable");
  });
});

describe("valueCommitTransition - the input-side gesture", () => {

  // A committed text input, built the same way the tri-state tests build their checkbox stubs.
  const textInput = (value) => {

    const input = document.createElement("input");

    input.type = "text";
    input.value = value;

    return input;
  };

  test("a commit carrying content sets the value at this scope, from an unset row", () => {

    using _dom = createTestDom();

    // No prior entries and no checkbox interaction: committing a value is itself the enabling gesture for a value option.
    const state = loadedState();
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, control: textInput("60"), controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:set");
    assert.equal(result.action.args.enabled, true);
    assert.equal(result.action.args.value, "60");
  });

  test("a commit carrying content sets the value from an explicitly disabled row", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Disable.Audio.Volume"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, control: textInput("60"), controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:set", "typing a value overrides the explicit disable at the same scope");
    assert.equal(result.action.args.enabled, true);
    assert.equal(result.action.args.value, "60");
  });

  test("a commit without content unsets a row explicitly enabled at this scope", () => {

    using _dom = createTestDom();

    const state = loadedState({ configuredOptions: ["Enable.Audio.Volume=75"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, control: textInput(""), controllerId: null, deviceId: null, entry });

    // Emptying the field drops the entry instead of writing an enable with nothing behind it, so resolution falls back to the hierarchy - here to the catalog
    // default, which leaves this default-off option unset.
    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.option, "Audio.Volume");
    assert.equal(result.action.args.id, undefined);
  });

  test("emptying a default-on value option's field clears the entry and hands resolution back to the catalog default", () => {

    using _dom = createTestDom();

    // The case the clear exists for. Audio.Layout is default-on with a declared default value, so an enable carrying no value would answer the option with
    // nothing at all, and the user who emptied a pre-filled field to get the default back would lose the value entirely.
    const state = loadedState({ configuredOptions: ["Enable.Audio.Layout=mono"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Layout");

    assert.equal(entry.value, "mono", "the row starts out showing its explicit value");

    const result = valueCommitTransition({ catalog, configIndex, control: textInput(""), controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.option, "Audio.Layout");
    assert.equal(result.action.args.id, undefined);

    // Resolution after the clear, driven through the same reducer the view dispatches into: no entry survives at any scope, so the catalog's own default answers.
    const cleared = reducer(state, result.action);
    const resolved = findEntry(cleared, "Audio", "Layout");

    assert.deepEqual(cleared.configuredOptions, [], "the explicit entry is gone");
    assert.equal(resolved.scope, "none", "resolution found no entry at any scope");
    assert.equal(resolved.enabled, true, "the option resolves enabled by its catalog default");
    assert.equal(resolved.value, "stereo", "the declared default value is what the row shows once the entry is gone");
  });

  test("a commit without content on a device-view row with a local value clears at that scope", () => {

    using _dom = createTestDom();

    const state = loadedState({

      configuredOptions: ["Enable.Audio.Volume.dev-a=75"],
      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, control: textInput(""), controllerId: null, deviceId: "dev-a", entry });

    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.id, "dev-a", "the clear addresses the device scope the gesture was made at");
  });

  test("a commit without content on an unset row yields no action", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, control: textInput("   "), controllerId: null, deviceId: null, entry });

    assert.equal(result.action, null, "nothing to say and nothing to remove - the caller restores the row instead of dispatching");
  });

  test("a commit without content on an explicitly disabled row yields no action", () => {

    using _dom = createTestDom();

    // The guard that keeps the gesture honest: an enable-shaped dispatch here would drop the user's explicit disable, state the emptied input never addressed.
    const state = loadedState({ configuredOptions: ["Disable.Audio.Volume"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, control: textInput(""), controllerId: null, deviceId: null, entry });

    assert.equal(result.action, null, "the explicit disable survives an empty commit untouched");
  });

  test("a commit without content on a row enabled only by inheritance yields no action", () => {

    using _dom = createTestDom();

    // The other polarity of the same guard: the row reads enabled, but the entry answering it lives upstream. A clear here would reach past the scope the user
    // is editing and take the global entry with it.
    const state = loadedState({

      configuredOptions: ["Enable.Audio.Volume=75"],
      devices: [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }],
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" }
    });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");

    assert.equal(entry.enabled, true, "the row reads enabled");
    assert.equal(entry.scope, "global", "but the entry answering it is upstream, not local");

    const result = valueCommitTransition({ catalog, configIndex, control: textInput(""), controllerId: null, deviceId: "dev-a", entry });

    assert.equal(result.action, null, "the upstream entry survives a gesture made at a lower scope");
  });

  test("an all-delimiter commit reads as no content", () => {

    using _dom = createTestDom();

    // The content predicate is shared with the entry writer, so a value the engine would refuse to persist never dispatches in the first place.
    const state = loadedState();
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, control: textInput(" == "), controllerId: null, deviceId: null, entry });

    assert.equal(result.action, null);
  });
});

describe("triStateTransition - the upstream probe honors declared scopes", () => {

  // A declared option and an undeclared one, differing in nothing else, so any difference in the probe's verdict is attributable to the declaration alone. Both default
  // on, and each test configures a single GLOBAL entry - the level the declared option does not admit - on a device view, the shape that would wrongly resolve as
  // inheritance if declared scopes were ignored.
  const PROBE_CATEGORIES = [{ description: "Probe Options", name: "Probe" }];

  const PROBE_OPTIONS = {

    Probe: [

      { default: true, description: "Zone runtime enable.", name: "Declared", scopes: ["device"] },
      { default: true, description: "Zone runtime enable.", name: "Undeclared" }
    ]
  };

  const probeState = (optionName) => {

    const catalog = {

      ...buildCatalogIndex(PROBE_CATEGORIES, PROBE_OPTIONS),

      validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
    };

    const devices = [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const base = reducer(initialState(), { catalog, configuredOptions: ["Enable.Probe." + optionName], controllers: [], mode: "device-only", type: "model:loaded" });
    const requested = reducer(base, { controllerId: null, type: "devices:requested" });
    const withDevices = reducer(requested, { controllerId: null, devices, error: "", seq: requested.devicesRequest.seq, type: "devices:loaded" });

    return reducer(withDevices, { scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });
  };

  // Simulate the click that takes a checked box to unchecked, and hand back the action the machine chose.
  const uncheck = (state, optionName) => {

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.checked = false;

    return triStateTransition({

      catalog: state.catalog,
      checkbox,
      configIndex: buildConfigIndex(state.catalog, state.configuredOptions),
      control: null,
      controllerId: null,
      deviceId: "dev-a",
      entry: findEntry(state, "Probe", optionName)
    });
  };

  test("a declared option treats a disallowed higher-scope entry as no inheritance and writes the disable at this scope", () => {

    using _dom = createTestDom();

    const state = probeState("Declared");
    const entry = findEntry(state, "Probe", "Declared");

    // The row reads as checked by the catalog default rather than as an inherited value: resolution skipped the global entry, because the option declares only the
    // device level.
    assert.equal(entry.scope, "none");
    assert.equal(entry.enabled, true);

    const result = uncheck(state, "Declared");

    // A clear would be a no-op here - there is no device entry to remove - so resolution would land back on the default-on state and the checkbox would spring back
    // against the click. The write is what makes the user's intent stick.
    assert.equal(result.action.type, "option:set");
    assert.equal(result.action.args.enabled, false);
    assert.equal(result.action.args.id, "dev-a");
  });

  test("an undeclared option treats the same entry as inheritance and clears, falling back to the higher scope", () => {

    using _dom = createTestDom();

    const state = probeState("Undeclared");
    const entry = findEntry(state, "Probe", "Undeclared");

    // With nothing declared the global entry is live at this view, so the row is showing an inherited value.
    assert.equal(entry.scope, "global");

    const result = uncheck(state, "Undeclared");

    assert.equal(result.action.type, "option:cleared", "the clear returns the row to the inheritance the entry genuinely provides");
    assert.equal(result.action.args.id, "dev-a");
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

    const input = row.querySelector("input.fo-option-value");

    assert.equal(input.value, "75", "the input starts at the configured value");

    // Simulate an in-progress edit: focus the input and type without committing.
    input.focus();
    assert.ok(document.activeElement === input, "precondition: the input holds focus");
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

/* The picker controls. A choice option's row is the same row every other option gets - one checkbox, one stacked content cell - with a control that offers a list
 * instead of a field that takes text. What these tests hold to is that the list on screen is the projection's, that operating the control commits what it means,
 * and that a re-derivation which changes nothing leaves the DOM the user is working in exactly where it was.
 *
 * A single choice offers itself two ways, and which one it takes is settled by the declaration alone. The fixtures below therefore come in pairs where the pair
 * is the point: two lists differing only in length, a short list declared into a dropdown against a source-backed list declared into a radio group, and a radio
 * list whose default is not its first member.
 */
const PICKER_CATEGORIES = [{ description: "Picker Options", name: "Pick" }];

const TIER_CHOICES = [ { label: "High", value: "high" }, { label: "Low", value: "low" } ];

// A list whose declared default is its LAST member. The position matters: a row that previewed the first member instead of the declared one would
// be indistinguishable from a correct preview on a list defaulting to its head, so the fixture puts the two answers in different places.
const QUALITY_CHOICES = [ { label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" } ];

// Inline lists built to a named size, for the rows that sit either side of the presentation threshold. Six members is the largest list still offered as a radio
// group and seven is the first offered as a dropdown, so the two fixtures differ in nothing but their length.
const memberList = (count) => Array.from({ length: count }, (_, index) => ({ label: "Member " + (index + 1), value: "m" + (index + 1) }));

const PICKER_OPTIONS = {

  Pick: [

    { choices: TIER_CHOICES, default: true, defaultValue: "high", description: "Stream tier.", inputSize: 12, name: "Tier", style: "dropdown" },
    { choices: TIER_CHOICES, default: true, defaultValue: "", description: "Stream tier, no default.", name: "TierUnset", style: "dropdown" },
    { choices: QUALITY_CHOICES, default: true, defaultValue: "high", description: "Capture quality.", name: "Quality" },
    { choices: QUALITY_CHOICES, default: true, defaultValue: "", description: "Capture quality, no default.", name: "QualityUnset" },
    { choices: memberList(6), default: true, defaultValue: "m1", description: "Six choices, the largest list a radio group takes.", name: "Six" },
    { choices: memberList(7), default: true, defaultValue: "m1", description: "Seven choices, one member past that.", name: "Seven" },
    { choices: "types", default: true, defaultValue: "", description: "A single choice the source derives.", name: "Sourced" },
    { choices: "types", default: true, defaultValue: "", description: "A single choice the source derives, held to a radio group.", name: "SourcedRadio",
      style: "radio" },
    { choices: "types", default: true, defaultValue: ALL_CHOICES, description: "Detected types.", multiple: true, name: "Types" },
    { choices: "types", default: true, defaultValue: "", description: "Detected types, no default.", multiple: true, name: "TypesUnset" },
    { default: true, defaultValue: "a,b", description: "Licence plates.", multiple: true, name: "Plates" },
    { choices: "types", default: false, defaultValue: "", description: "Detected types, off by default.", multiple: true, name: "TypesOff" },
    { default: true, defaultValue: "plain", description: "An ordinary value beside them.", name: "Plain" }
  ]
};

// The default source: three members, freshly allocated on every call, which is exactly the shape that would rebuild the DOM on every recompute if the renderer
// compared by reference.
const abcSource = () => [ { label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" } ];

// The device and the scope the scoped rows below are exercised at. A scoped row is where arming, the per-scope write, and the fall-back to inheritance all live,
// so the rows that walk those gestures need a page with a device selected on it.
const PICKER_DEVICES = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
const DEVICE_SCOPE = { controllerId: null, deviceId: "dev-a", kind: "device" };

const pickerState = ({ configuredOptions = [], devices = [], scope, types = abcSource } = {}) => {

  const catalog = {

    ...buildCatalogIndex(PICKER_CATEGORIES, PICKER_OPTIONS),

    choiceSources: { types },

    validators: {

      isController: () => false,
      validOption: () => true,
      validOptionCategory: () => true
    }
  };

  const base = reducer(initialState(), { catalog, configuredOptions, controllers: [], mode: "device-only", type: "model:loaded" });
  const requested = reducer(base, { controllerId: null, type: "devices:requested" });
  const withDevices = reducer(requested, { controllerId: null, devices, error: "", seq: requested.devicesRequest.seq, type: "devices:loaded" });

  return scope ? reducer(withDevices, { scope, type: "scope:changed" }) : withDevices;
};

const pickerEntry = (state, optionName) => findEntry(state, "Pick", optionName);

const pickerRow = (state, optionName, { armed = false, deviceId = null, scopeKind = "global" } = {}) => optionRow({ armed, deviceId,
  entry: pickerEntry(state, optionName), scopeKind });

const checkboxStub = (checked, { readOnly = false } = {}) => {

  const checkbox = document.createElement("input");

  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.readOnly = readOnly;

  return checkbox;
};

// Run the tri-state machine against a scoped picker row the way the view runs it: the row's own control, the config index built from the state in hand, and the
// device currently in view. One caller for the gesture rows keeps them about the answer the machine gives rather than about the plumbing that reaches it.
const scopedTriState = ({ armed = false, checked, optionName, state }) => {

  const control = pickerRow(state, optionName, { armed, deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");

  return triStateTransition({ armed, catalog: state.catalog, checkbox: checkboxStub(checked), configIndex: buildConfigIndex(state.catalog,
    state.configuredOptions), control, controllerId: null, deviceId: "dev-a", entry: pickerEntry(state, optionName) });
};

describe("the choice controls - construction", () => {

  test("a single-choice option builds a select carrying the shared value class, declaring no width of its own, in the body font", () => {

    using _dom = createTestDom();

    // The fixture declares an inputSize, which a select does not read: sizing belongs to the skin, where `width: auto` takes the control's width from its own
    // widest member. An inline width here would outrank that rule and lock every dropdown to the same arbitrary ch count whatever it holds.
    const control = pickerRow(pickerState(), "Tier").querySelector(".fo-option-value");

    assert.equal(control.tagName, "SELECT", "one choice is a dropdown");
    assert.equal(control.classList.contains("fo-option-value"), true, "the class the view finds the control by, whatever control the row is edited through");
    assert.equal(control.classList.contains("form-control"), true, "dressed as a form control like the text field beside it");
    assert.equal(control.style.width, "", "no inline width, whatever inputSize the option happens to declare");
    assert.equal(control.style.maxWidth, "", "and no inline cap, since the skin's rule carries the narrow-panel guard with it");
    assert.equal(control.style.boxSizing, "", "nor the box-sizing that a ch-width declaration needed to measure from");
    assert.equal(control.style.fontFamily, "", "a label is prose and reads in the inherited body font - monospace belongs to raw-value fields");
  });

  test("a select's first option is a placeholder the user can never choose, which is how the row expresses no value at all", () => {

    using _dom = createTestDom();

    const row = pickerRow(pickerState(), "TierUnset");
    const control = row.querySelector(".fo-option-value");

    assert.equal(control.options[0].value, "", "the leading option stores nothing");
    assert.equal(control.options[0].textContent, "", "and shows nothing");
    assert.equal(control.options[0].disabled, true, "it is a rest state the row lands on, never an offer - so it cannot be picked");
    assert.equal(control.options[0].hidden, true, "and it is kept out of the list the user reads at all");

    // The rebuild is where a placeholder recreated bare would slip past a construction-only check: a stored value the list does not offer arrives, every member
    // node is replaced, and what has to come through intact is the placeholder's unpickability rather than merely its presence.
    applyRowState({ entry: pickerEntry(pickerState({ configuredOptions: ["Enable.Pick.TierUnset=gone"] }), "TierUnset"), row, scopeKind: "global" });

    assert.deepEqual([...control.options].map((option) => option.value), [ "", "high", "low", "gone" ], "precondition: the member list genuinely rebuilt");
    assert.equal(control.options[0].value, "", "the placeholder is still index 0 afterwards");
    assert.equal(control.options[0].disabled, true, "still unpickable");
    assert.equal(control.options[0].hidden, true, "and still hidden");
  });

  test("a multiple-choice option builds a checkbox group carrying the shared value class, in the body font", () => {

    using _dom = createTestDom();

    const control = pickerRow(pickerState(), "Types").querySelector(".fo-option-value");

    assert.equal(control.tagName, "FIELDSET", "several choices are a group");
    assert.equal(control.classList.contains("fo-option-value"), true, "the group is the control, so the class sits on it");
    assert.equal(control.classList.contains("fo-choice-group"), true);
    assert.equal(control.style.fontFamily, "", "member labels read in the inherited body font");
  });

  test("the skin's field marker sits on the typed fields alone, never on a group or a wrapper", () => {

    using _dom = createTestDom();

    /* The two classes answer different questions. `fo-option-value` is how the view finds whatever control a row is edited through, and `fo-field` is how the
     * skin finds a field to dress. A picker's fieldset and a list editor's wrapper are controls without being fields - each is a box around native inputs of its
     * own - so a field's surface keyed to either of them would paint a hard-edged rectangle behind the members it holds.
     */
    const state = pickerState();
    const field = pickerRow(state, "Plain").querySelector(".fo-option-value");
    const select = pickerRow(state, "Tier").querySelector(".fo-option-value");
    const group = pickerRow(state, "Types").querySelector(".fo-option-value");
    const editor = pickerRow(state, "Plates").querySelector(".fo-option-value");

    assert.equal(field.classList.contains("fo-field"), true, "a free-text field is a field");
    assert.equal(select.classList.contains("fo-field"), true, "and so is a dropdown, which reads one value out of its list");
    assert.equal(editor.querySelector(".fo-list-entry").classList.contains("fo-field"), true, "and so is the entry the next item is typed into");

    assert.equal(group.classList.contains("fo-field"), false, "a picker group is a control without being a field");
    assert.equal(editor.classList.contains("fo-field"), false, "and so is the editor holding the entries, whose own field carries the marker instead");
  });
});

/* Which face a single choice wears. The rule reads the catalog declaration and nothing else: a declared style wins, a source-backed list is always a dropdown,
 * and an inline list is measured by its own length. The rows below assert each of those answers, and the boundary is asserted from both sides rather than from
 * the radio side alone, since a threshold is only held by the pair of rows that straddle it.
 */
describe("the choice presentation - what a declaration renders as", () => {

  test("an inline list of six offers a radio group, and one of seven a dropdown", () => {

    using _dom = createTestDom();

    const state = pickerState();
    const six = pickerRow(state, "Six").querySelector(".fo-option-value");
    const seven = pickerRow(state, "Seven").querySelector(".fo-option-value");
    const sixMembers = [...six.querySelectorAll(".fo-choice-checkbox")];

    assert.equal(six.tagName, "FIELDSET", "six members still read at once, which is what a radio group is for");
    assert.equal(sixMembers.length, 6, "and all six are there");
    assert.ok(sixMembers.every((input) => input.type === "radio"), "as radios, since one of them is all the row can hold");
    assert.equal(seven.tagName, "SELECT", "the seventh member is where the dropdown's one-line face wins");
  });

  test("a declared style overrides the automatic answer in both directions", () => {

    using _dom = createTestDom();

    // A short inline list would read as a radio group on its own, and a source-backed list would never read as one. Each fixture declares the opposite of what it
    // would otherwise get, so a rule that quietly ignored the declaration would fail on one side or the other whichever way it leaned.
    const state = pickerState();

    assert.equal(pickerRow(state, "Tier").querySelector(".fo-option-value").tagName, "SELECT", "a short list declared a dropdown stays a dropdown");
    assert.equal(pickerRow(state, "SourcedRadio").querySelector(".fo-option-value").tagName, "FIELDSET",
      "and a source-backed list declared a radio group becomes one");
  });

  test("a source-backed single choice is a dropdown however short the device's own list turns out to be", () => {

    using _dom = createTestDom();

    // The source resolves three members here, comfortably inside the length an inline list would be measured by. Reading the RESOLVED list rather than the
    // declaration would make this row a radio group on this device and a dropdown on the next, moving the control family under the user between pages.
    const state = pickerState();

    assert.equal(pickerEntry(state, "Sourced").choices.length, 3, "precondition: the resolved list is short enough to tempt a radio group");
    assert.equal(pickerRow(state, "Sourced").querySelector(".fo-option-value").tagName, "SELECT", "the declaration decides, and a source-backed one says dropdown");
  });
});

/* The radio group. It is the checkbox group's own fieldset family wearing a different input, which is what lets the value read, the lock, the focus hand-off,
 * and the theme reach it without knowing which flavor they have. What these rows hold to is that the members carry the row's identity, that the row rests where
 * the projection says, and that a multiple choice beside it is untouched by any of it.
 */
describe("the radio group - construction and rest state", () => {

  test("builds the projection's members as radios sharing the row's name, resting on the declared default", () => {

    using _dom = createTestDom();

    const control = pickerRow(pickerState(), "Quality").querySelector(".fo-option-value");
    const inputs = [...control.querySelectorAll(".fo-choice-checkbox")];

    assert.equal(control.tagName, "FIELDSET", "the same control a multiple choice builds");
    assert.equal(control.classList.contains("fo-choice-group"), true, "in the same family, so the lock and the theme reach it unchanged");
    assert.deepEqual(inputs.map((input) => input.value), [ "low", "medium", "high" ], "the declared list, in the order it was declared");
    assert.deepEqual(inputs.map((input) => input.type), [ "radio", "radio", "radio" ]);
    assert.deepEqual(inputs.map((input) => input.name), [ "Pick.Quality", "Pick.Quality", "Pick.Quality" ], "one name per row is what makes exclusivity bind");
    assert.deepEqual(inputs.map((input) => input.checked), [ false, false, true ], "and the row previews its declared default, which is not the first member");
  });

  test("a multiple choice beside it still builds unnamed checkboxes", () => {

    using _dom = createTestDom();

    // The negative control for the flavor threading: one builder serves both, so a change that named every member or made every member a radio would show up
    // here rather than only in production.
    const inputs = [...pickerRow(pickerState(), "Types").querySelectorAll(".fo-choice-checkbox")];

    assert.deepEqual(inputs.map((input) => input.type), [ "checkbox", "checkbox", "checkbox" ], "several choices are still checkboxes");
    assert.deepEqual(inputs.map((input) => input.name), [ "", "", "" ], "and carry no group name, since a checkbox expresses no exclusivity to bind");
  });

  test("shows the stored selection over the default, and marks a value the list no longer offers", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: ["Enable.Pick.Quality=gone"] });
    const control = pickerRow(state, "Quality").querySelector(".fo-option-value");
    const inputs = [...control.querySelectorAll(".fo-choice-checkbox")];
    const labels = [...control.querySelectorAll(".fo-choice")];

    assert.deepEqual(inputs.map((input) => input.value), [ "low", "medium", "high", "gone" ], "the stored value is appended rather than dropped");
    assert.deepEqual(inputs.map((input) => input.checked), [ false, false, false, true ], "and stays picked, since the user chose it");
    assert.equal(labels[3].classList.contains("fo-choice-unknown"), true, "marked as something this device does not offer, exactly as a dropdown marks it");
    assert.equal(labels[3].title, "Not offered for this device.", "and says so on hover");
    assert.equal(labels[0].classList.contains("fo-choice-unknown"), false, "an offered member carries no mark");
  });

  test("an armed radio group picks nothing at all", () => {

    using _dom = createTestDom();

    const state = pickerState({ devices: PICKER_DEVICES, scope: DEVICE_SCOPE });
    const control = pickerRow(state, "Quality", { armed: true, deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");

    assert.deepEqual([...control.querySelectorAll(".fo-choice-checkbox")].map((input) => input.checked), [ false, false, false ],
      "arming asks for the option's first value, so the declared default is not previewed as a pick");
  });

  test("a locked row disables every member of a radio group", () => {

    using _dom = createTestDom();

    const control = pickerRow(pickerState({ configuredOptions: ["Disable.Pick.Quality"] }), "Quality").querySelector(".fo-option-value");

    assert.deepEqual([...control.querySelectorAll(".fo-choice-checkbox")].map((input) => input.disabled), [ true, true, true ],
      "each member is what a user would click, so each one locks");
    assert.equal(control.getAttribute("aria-disabled"), "true", "and the group as a whole says it is unavailable");
  });

  test("a row enabled here with no value of its own still previews its default", () => {

    using _dom = createTestDom();

    // A bare enable carries no value, so resolution answers with an explicit scope and no value rather than with "none" - a different input reaching the same
    // substitution the unset row reaches. What the user sees is the same either way: the option's declared default, shown by the control they would change.
    const state = pickerState({ configuredOptions: ["Enable.Pick.Quality"] });
    const control = pickerRow(state, "Quality").querySelector(".fo-option-value");

    assert.equal(pickerEntry(state, "Quality").scope, "global", "precondition: the row resolves at an explicit scope rather than at none");
    assert.deepEqual([...control.querySelectorAll(".fo-choice-checkbox")].map((input) => input.checked), [ false, false, true ],
      "and the declared default is what the group previews");
  });
});

/* The radio group's gestures, driven by real clicks rather than by a synthesized event, because exclusivity is the platform's own behavior and a test that set
 * `.checked` by hand would prove nothing about it. The per-row name is what binds it, so the independence of two rows on one page is asserted beside it.
 */
describe("the radio group - clicking a member", () => {

  test("picking a member releases the one picked before it, announcing each pick to the row", () => {

    using _dom = createTestDom();

    const state = pickerState();
    const row = pickerRow(state, "Quality");

    document.body.appendChild(row);

    const control = row.querySelector(".fo-option-value");
    const inputs = [...control.querySelectorAll(".fo-choice-checkbox")];
    const announced = [];

    control.addEventListener("change", () => announced.push(controlValueText(control)));

    inputs[0].click();

    assert.deepEqual(inputs.map((input) => input.checked), [ true, false, false ], "the member clicked is the member picked");

    inputs[1].click();

    assert.deepEqual(inputs.map((input) => input.checked), [ false, true, false ], "and picking a sibling releases it - exactly one member is ever picked");
    assert.deepEqual(announced, [ "low", "medium" ], "each click announces the pick the way a dropdown announces a selection");

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry: pickerEntry(state, "Quality") });

    assert.equal(result.action.type, "option:set", "and what the last click left on screen is what a commit stores");
    assert.equal(result.action.args.value, "medium");
  });

  test("two radio rows on one page pick independently, since each row's members carry its own name", () => {

    using _dom = createTestDom();

    const state = pickerState();
    const table = document.createElement("div");
    const qualityRow = pickerRow(state, "Quality");
    const sixRow = pickerRow(state, "Six");

    table.append(qualityRow, sixRow);
    document.body.appendChild(table);

    const quality = [...qualityRow.querySelectorAll(".fo-choice-checkbox")];
    const six = [...sixRow.querySelectorAll(".fo-choice-checkbox")];

    assert.notEqual(quality[0].name, six[0].name, "precondition: the two rows name their groups differently");

    quality[0].click();
    six[1].click();

    assert.deepEqual(quality.map((input) => input.checked), [ true, false, false ], "a pick in the row below leaves the row above exactly as it was");
    assert.deepEqual(six.map((input) => input.checked), [ false, true, false, false, false, false ], "and the second row picked on its own account");
  });
});

describe("the choice controls - applyRowState", () => {

  test("a select shows the projection's members and picks the resolved one", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: ["Enable.Pick.Tier=low"] });
    const control = pickerRow(state, "Tier").querySelector(".fo-option-value");

    assert.deepEqual([...control.options].map((o) => o.value), [ "", "high", "low" ], "the empty option, then the declared list in order");
    assert.deepEqual([...control.options].map((o) => o.textContent), [ "", "High", "Low" ], "each member shows its own label");
    assert.equal(control.value, "low", "the stored value is what the dropdown rests on");
  });

  test("a group checks exactly the members the stored value selects", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=c,a"] });
    const control = pickerRow(state, "TypesUnset").querySelector(".fo-option-value");
    const boxes = [...control.querySelectorAll(".fo-choice-checkbox")];

    assert.deepEqual(boxes.map((b) => b.value), [ "a", "b", "c" ], "members read in the source's own order, not the stored order");
    assert.deepEqual(boxes.map((b) => b.checked), [ true, false, true ], "the stored value decides which boxes are checked");
  });

  test("an all-choices default renders every box checked", () => {

    using _dom = createTestDom();

    const control = pickerRow(pickerState(), "Types").querySelector(".fo-option-value");

    assert.deepEqual([...control.querySelectorAll(".fo-choice-checkbox")].map((b) => b.checked), [ true, true, true ],
      "the wildcard default stands for the whole domain, and the boxes say so honestly");
  });

  test("a stored value the list no longer offers is preserved, marked, and still selected", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=a,zzz"] });
    const control = pickerRow(state, "TypesUnset").querySelector(".fo-option-value");
    const boxes = [...control.querySelectorAll(".fo-choice-checkbox")];
    const labels = [...control.querySelectorAll(".fo-choice")];

    assert.deepEqual(boxes.map((b) => b.value), [ "a", "b", "c", "zzz" ], "the absent value is appended rather than dropped");
    assert.deepEqual(boxes.map((b) => b.checked), [ true, false, false, true ], "and stays selected, since the user chose it");
    assert.equal(labels[3].classList.contains("fo-choice-unknown"), true, "marked as something this device does not offer");
    assert.equal(labels[3].title, "Not offered for this device.", "and says so on hover");
    assert.equal(labels[0].classList.contains("fo-choice-unknown"), false, "an offered member carries no mark");
  });

  test("a select marks an unknown stored value the same way", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: ["Enable.Pick.Tier=gone"] });
    const control = pickerRow(state, "Tier").querySelector(".fo-option-value");

    assert.deepEqual([...control.options].map((o) => o.value), [ "", "high", "low", "gone" ], "the stored value is offered so the user can see what is set");
    assert.equal(control.value, "gone", "and the dropdown rests on it");
    assert.equal(control.options[3].classList.contains("fo-choice-unknown"), true);
    assert.equal(control.options[3].title, "Not offered for this device.");
  });

  test("a re-derive against a fresh-but-equal list leaves the option and label NODES in place", () => {

    using _dom = createTestDom();

    // The source allocates a new array every call, so identity comparison would rebuild here and drop the nodes out from under an open dropdown or a focused box.
    const state = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=a"] });
    const groupRow = pickerRow(state, "TypesUnset");
    const group = groupRow.querySelector(".fo-option-value");
    const groupNodes = [...group.querySelectorAll(".fo-choice")];

    const selectRow = pickerRow(state, "Tier");
    const select = selectRow.querySelector(".fo-option-value");
    const selectNodes = [...select.options];

    const again = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=a"] });

    applyRowState({ entry: pickerEntry(again, "TypesUnset"), row: groupRow, scopeKind: "global" });
    applyRowState({ entry: pickerEntry(again, "Tier"), row: selectRow, scopeKind: "global" });

    // DOM identity is compared through assert.ok rather than assert.equal: a failing assert.equal would try to render two Happy-DOM elements into its message and
    // never come back, so a real regression here has to be able to report itself.
    assert.ok([...group.querySelectorAll(".fo-choice")].every((node, index) => node === groupNodes[index]), "every group label is the same node it was");
    assert.ok([...select.options].every((node, index) => node === selectNodes[index]), "every option is the same node it was");
  });

  test("a re-derive against a CHANGED list replaces the nodes, for a group and for a select alike", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=a"] });
    const row = pickerRow(state, "TypesUnset");
    const group = row.querySelector(".fo-option-value");
    const before = [...group.querySelectorAll(".fo-choice")];

    const changed = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=a"], types: () => [ { label: "A", value: "a" }, { label: "D", value: "d" } ] });

    applyRowState({ entry: pickerEntry(changed, "TypesUnset"), row, scopeKind: "global" });

    const after = [...group.querySelectorAll(".fo-choice")];

    assert.deepEqual(after.map((node) => node.querySelector(".fo-choice-checkbox").value), [ "a", "d" ], "the group shows the list it was handed");
    assert.equal(after.some((node) => before.includes(node)), false, "and none of the prior nodes survived a list that genuinely moved");

    // The same rule on a dropdown, whose members change when a stored value the list does not carry arrives or departs.
    const selectRow = pickerRow(state, "Tier");
    const select = selectRow.querySelector(".fo-option-value");
    const selectBefore = [...select.options].slice(1);

    applyRowState({ entry: pickerEntry(pickerState({ configuredOptions: ["Enable.Pick.Tier=gone"] }), "Tier"), row: selectRow, scopeKind: "global" });

    const selectAfter = [...select.options].slice(1);

    assert.deepEqual(selectAfter.map((node) => node.value), [ "high", "low", "gone" ], "the dropdown gains the value the list does not offer");
    assert.equal(selectAfter.some((node) => selectBefore.includes(node)), false, "and its option nodes were rebuilt, since the list genuinely moved");
    assert.equal(select.options[0].value, "", "the leading empty option survives every rebuild - it is structure, not a member");
  });

  test("a locked row disables the select, and an unlocked one does not", () => {

    using _dom = createTestDom();

    const locked = pickerState({ configuredOptions: ["Disable.Pick.Tier"] });
    const lockedControl = pickerRow(locked, "Tier").querySelector(".fo-option-value");

    assert.equal(lockedControl.disabled, true, "a disabled row cannot be picked from");
    assert.equal(lockedControl.getAttribute("aria-disabled"), "true");

    const liveControl = pickerRow(pickerState(), "Tier").querySelector(".fo-option-value");

    assert.equal(liveControl.disabled, false);
    assert.equal(liveControl.getAttribute("aria-disabled"), null);
  });

  test("a locked row disables every box of a group and marks the fieldset, and an unlocked one releases both", () => {

    using _dom = createTestDom();

    const locked = pickerState({ configuredOptions: ["Disable.Pick.Types"] });
    const lockedControl = pickerRow(locked, "Types").querySelector(".fo-option-value");

    assert.deepEqual([...lockedControl.querySelectorAll(".fo-choice-checkbox")].map((b) => b.disabled), [ true, true, true ], "each box is what a user would click");
    assert.equal(lockedControl.getAttribute("aria-disabled"), "true", "and the group as a whole says it is unavailable");

    const liveControl = pickerRow(pickerState(), "Types").querySelector(".fo-option-value");

    assert.deepEqual([...liveControl.querySelectorAll(".fo-choice-checkbox")].map((b) => b.disabled), [ false, false, false ]);
    assert.equal(liveControl.getAttribute("aria-disabled"), null);
  });

  test("an armed row presents an empty selection whatever the projection resolved", () => {

    using _dom = createTestDom();

    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const state = pickerState({ devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const selectControl = pickerRow(state, "Tier", { armed: true, deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");
    const groupControl = pickerRow(state, "Types", { armed: true, deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");

    assert.equal(selectControl.value, "", "arming asks for the first value, so the dropdown rests on the empty option");
    assert.deepEqual([...groupControl.querySelectorAll(".fo-choice-checkbox")].map((b) => b.checked), [ false, false, false ],
      "and no box is checked, even under an all-choices default");
  });

  test("a select is re-derived even while it holds focus, since a pick commits the moment it happens", () => {

    using _dom = createTestDom();

    const row = pickerRow(pickerState(), "TierUnset");
    const control = row.querySelector(".fo-option-value");

    document.body.appendChild(row);
    control.focus();

    assert.ok(document.activeElement === control, "the dropdown holds focus");

    applyRowState({ entry: pickerEntry(pickerState({ configuredOptions: ["Enable.Pick.TierUnset=low"] }), "TierUnset"), row, scopeKind: "global" });

    assert.equal(control.value, "low", "a dropdown holds nothing uncommitted, so the projection is always authoritative");
  });

  test("a focused text field is still left alone, which is the guard the pickers do not need", () => {

    using _dom = createTestDom();

    const row = pickerRow(pickerState(), "Plain");
    const control = row.querySelector(".fo-option-value");

    document.body.appendChild(row);
    control.focus();
    control.value = "typing-in-progress";

    applyRowState({ entry: pickerEntry(pickerState({ configuredOptions: ["Enable.Pick.Plain=other"] }), "Plain"), row, scopeKind: "global" });

    assert.equal(control.value, "typing-in-progress", "an uncommitted edit survives a re-derive");
  });
});

describe("focusControl", () => {

  test("hands focus to the control itself, to a group's first box, and does nothing at all for a boolean row", () => {

    using _dom = createTestDom();

    const state = pickerState();
    const selectRow = pickerRow(state, "Tier");
    const groupRow = pickerRow(state, "Types");
    const textRow = pickerRow(state, "Plain");
    const editorRow = pickerRow(state, "Plates");

    document.body.append(selectRow, groupRow, textRow, editorRow);

    focusControl(selectRow.querySelector(".fo-option-value"));
    assert.ok(document.activeElement === selectRow.querySelector(".fo-option-value"), "a dropdown takes focus itself");

    focusControl(groupRow.querySelector(".fo-option-value"));
    assert.ok(document.activeElement === groupRow.querySelector(".fo-choice-checkbox"), "a fieldset is not focusable, so its first box takes it");

    focusControl(textRow.querySelector(".fo-option-value"));
    assert.ok(document.activeElement === textRow.querySelector(".fo-option-value"), "a text field takes focus itself");

    focusControl(editorRow.querySelector(".fo-option-value"));
    assert.ok(document.activeElement === editorRow.querySelector(".fo-list-entry"), "a list editor hands focus to the field the next entry is typed into");

    assert.doesNotThrow(() => focusControl(null), "a boolean row carries no control and is a quiet no-op");
  });

  test("a group whose source offered nothing has no box to focus, and asks for none", () => {

    using _dom = createTestDom();

    // A device that reports none of what the option is about resolves to an empty list. The group is still the row's control - it is what the lock and the theme
    // address - but there is nothing inside it to hand focus to.
    const row = pickerRow(pickerState({ types: () => [] }), "TypesUnset");
    const control = row.querySelector(".fo-option-value");

    document.body.appendChild(row);

    assert.equal(control.querySelectorAll(".fo-choice").length, 0, "precondition: the source offered nothing");
    assert.doesNotThrow(() => focusControl(control), "an empty group is a quiet no-op rather than a throw inside an arming gesture");
  });
});

describe("controlValueText", () => {

  test("reads each control kind in the grammar a commit would store", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: [ "Enable.Pick.Tier=low", "Enable.Pick.TypesUnset=c,a" ] });

    assert.equal(controlValueText(pickerRow(state, "Tier").querySelector(".fo-option-value")), "low", "a dropdown reads as its picked value");
    assert.equal(controlValueText(pickerRow(state, "TypesUnset").querySelector(".fo-option-value")), "a,c",
      "a group composes the canonical list of its checked boxes, in the order they are offered");
    assert.equal(controlValueText(pickerRow(pickerState(), "Plain").querySelector(".fo-option-value")), "plain",
      "a plain text field - no choices, no list - reads as the text it holds");
    assert.equal(controlValueText(pickerRow(pickerState(), "Plates").querySelector(".fo-option-value")), "a,b",
      "a list editor composes its entries, which is the same grammar its text spelled before it had entries");
    assert.equal(controlValueText(null), "", "a boolean row reads as nothing at all");
  });
});

describe("the picker transitions", () => {

  test("a scoped picker with no selection arms rather than writing, for both control kinds", () => {

    using _dom = createTestDom();

    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const state = pickerState({ devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);

    for(const optionName of [ "TierUnset", "TypesUnset" ]) {

      const entry = pickerEntry(state, optionName);
      const control = pickerRow(state, optionName, { armed: true, deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");
      const result = triStateTransition({ catalog: state.catalog, checkbox: checkboxStub(true), configIndex, control, controllerId: null, deviceId: "dev-a", entry });

      assert.equal(result.action.type, "option:armed", optionName + " has no value to persist yet, so the row arms");
    }
  });

  test("a scoped picker that already previews a selection writes rather than arming", () => {

    using _dom = createTestDom();

    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const state = pickerState({ devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);

    for(const optionName of [ "Tier", "Types" ]) {

      const entry = pickerEntry(state, optionName);
      const control = pickerRow(state, optionName, { deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");
      const result = triStateTransition({ catalog: state.catalog, checkbox: checkboxStub(true), configIndex, control, controllerId: null, deviceId: "dev-a", entry });

      // A row already showing its default has something to persist, so it takes the write rule rather than arming. That rule then finds this state is exactly what
      // the entry-less resolution already yields - default-on, default value - and clears, which is the same answer a text row with its default showing gives.
      assert.notEqual(result.action.type, "option:armed", optionName + " has a selection on screen, so there is nothing to arm for");
      assert.equal(result.action.type, "option:cleared", optionName + " matches its own default on both axes, so no entry is needed to say so");
    }
  });

  test("a scoped picker whose shown selection deviates writes that selection at this scope", () => {

    using _dom = createTestDom();

    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const state = pickerState({ configuredOptions: [ "Enable.Pick.Tier=low", "Enable.Pick.Types=a" ], devices,
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);

    for(const [ optionName, expected ] of [ [ "Tier", "low" ], [ "Types", "a" ] ]) {

      const entry = pickerEntry(state, optionName);
      const control = pickerRow(state, optionName, { deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");
      const result = triStateTransition({ catalog: state.catalog, checkbox: checkboxStub(true), configIndex, control, controllerId: null, deviceId: "dev-a", entry });

      assert.equal(result.action.type, "option:set", optionName + " inherits a selection that differs from its default, so the device scope records it");
      assert.equal(result.action.args.value, expected, optionName + " writes exactly what the control shows");
    }
  });

  test("unchecking one member of an all-choices group commits the explicit list", () => {

    using _dom = createTestDom();

    const state = pickerState();
    const entry = pickerEntry(state, "Types");
    const control = pickerRow(state, "Types").querySelector(".fo-option-value");

    // The user unchecks "b" out of a group every box of which was checked by the all-choices default.
    control.querySelectorAll(".fo-choice-checkbox")[1].checked = false;

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:set", "a selection short of the whole domain is a real choice and is stored");
    assert.equal(result.action.args.value, "a,c", "stored as the explicit list, never as the wildcard");
  });

  test("re-checking every member of an all-choices group clears the entry, so the option tracks the domain again", () => {

    using _dom = createTestDom();

    const state = pickerState({ configuredOptions: ["Enable.Pick.Types=a,c"] });
    const entry = pickerEntry(state, "Types");
    const control = pickerRow(state, "Types").querySelector(".fo-option-value");

    control.querySelectorAll(".fo-choice-checkbox")[1].checked = true;

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry });

    // Freezing "a,b,c" into the configuration would silently stop tracking a domain the plugin derives - a type added by a firmware update would arrive unselected.
    assert.equal(result.action.type, "option:cleared", "a fully checked group says exactly what the all-choices default says, so the entry goes");
  });

  test("a free-form list judges deviation on the normalized list, not on how it was entered", () => {

    using _dom = createTestDom();

    const state = pickerState();
    const entry = pickerEntry(state, "Plates");
    const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);
    const control = pickerRow(state, "Plates").querySelector(".fo-option-value");

    // The declared default is "a,b", so the editor opens holding exactly those two entries. Committing them as they stand says what the default says.
    const same = valueCommitTransition({ catalog: state.catalog, configIndex, control, controllerId: null, deviceId: null, entry });

    assert.equal(same.action.type, "option:cleared", "re-committing the default list is not a change");

    // Order, on the other hand, IS part of a free-form list: the sequence is something the user chose.
    typeEntry(control, "b");
    typeEntry(control, "a");

    for(const item of [...control.querySelectorAll(".fo-list-item")].slice(0, 2)) {

      item.remove();
    }

    const reordered = valueCommitTransition({ catalog: state.catalog, configIndex, control, controllerId: null, deviceId: null, entry });

    assert.equal(reordered.action.type, "option:set", "a reordered list is a different list");
    assert.equal(reordered.action.args.value, "b,a");
  });

  test("a free-form list commit is normalized through the grammar before it is stored", () => {

    using _dom = createTestDom();

    const state = pickerState();
    const entry = pickerEntry(state, "Plates");
    const control = pickerRow(state, "Plates").querySelector(".fo-option-value");

    for(const item of [...control.querySelectorAll(".fo-list-item")]) {

      item.remove();
    }

    // Entries arrive already trimmed by the gesture that made them, and the field's pending text is trimmed as it is read, so what a commit composes is canonical
    // whichever way the user got there.
    typeEntry(control, " a ");
    typeEntry(control, "b");
    control.querySelector(".fo-list-entry").value = " c ";

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:set");
    assert.equal(result.action.args.value, "a,b,c", "stray spacing settles into the canonical form the read side parses");
  });

  test("emptying a group whose default is not empty stores the empty selection instead of clearing back to that default", () => {

    using _dom = createTestDom();

    // The state the entry grammar spells and this gesture asks for: on, with nothing selected. Clearing here would hand the row back to the all-choices default,
    // which is the opposite of what unchecking every box says.
    const state = pickerState();
    const entry = pickerEntry(state, "Types");
    const control = pickerRow(state, "Types").querySelector(".fo-option-value");

    for(const box of control.querySelectorAll(".fo-choice-checkbox")) {

      box.checked = false;
    }

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:set", "an empty selection differing from the default is a choice, so it is written");
    assert.equal(result.action.args.value, "", "written as the empty selection itself");

    // Driven through the reducer, the same way the view dispatches: the entry lands in the grammar's own spelling and the row comes back showing no members.
    const stored = reducer(state, result.action);
    const resolved = pickerEntry(stored, "Types");

    assert.deepEqual(stored.configuredOptions, ["Enable.Pick.Types="], "the empty selection persists as the bare-delimiter entry");
    assert.deepEqual(resolved.choices.filter((choice) => choice.selected).map((choice) => choice.value), [], "and the row shows nothing selected");
  });

  test("emptying a scoped group stores the empty selection at that scope", () => {

    using _dom = createTestDom();

    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const state = pickerState({ configuredOptions: ["Enable.Pick.Types.dev-a=a"], devices,
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const entry = pickerEntry(state, "Types");
    const control = pickerRow(state, "Types", { deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");

    for(const box of control.querySelectorAll(".fo-choice-checkbox")) {

      box.checked = false;
    }

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: "dev-a", entry });

    assert.equal(result.action.type, "option:set", "the scope records its own empty selection");
    assert.equal(result.action.args.id, "dev-a", "at the scope the gesture was made from");
    assert.equal(result.action.args.value, "");

    const stored = reducer(state, result.action);

    assert.deepEqual(stored.configuredOptions, ["Enable.Pick.Types.dev-a="], "the scoped empty selection has a spelling of its own");
  });

  test("emptying a free-form list stores the empty selection the same way a checkbox group does", () => {

    using _dom = createTestDom();

    // A list without choices edits through the list editor rather than a checkbox group, and the two controls answer to one rule: removing the last entry says
    // the same thing unchecking the last box says. The commit settles through the grammar on its way out, so what an emptied editor stores is the empty
    // selection rather than an empty entry.
    const state = pickerState();
    const entry = pickerEntry(state, "Plates");
    const control = pickerRow(state, "Plates").querySelector(".fo-option-value");

    for(const item of [...control.querySelectorAll(".fo-list-item")]) {

      item.remove();
    }

    assert.equal(controlValueText(control), "", "the editor holds no entries and nothing pending in its field");

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:set", "an emptied list differs from the declared default, so it is written");
    assert.equal(result.action.args.value, "", "as the empty selection, not as the default it was emptied of");

    const stored = reducer(state, result.action);

    assert.deepEqual(stored.configuredOptions, ["Enable.Pick.Plates="], "stored in the same spelling the checkbox group's empty selection takes");
  });

  test("emptying a group whose default is also empty clears, keeping the configuration minimal", () => {

    using _dom = createTestDom();

    // The boundary the selection compare draws. Storing an empty selection over a default that is already empty would say nothing the entry-less resolution does
    // not already say, so the entry goes instead.
    const state = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=a"] });
    const entry = pickerEntry(state, "TypesUnset");
    const control = pickerRow(state, "TypesUnset").querySelector(".fo-option-value");

    for(const box of control.querySelectorAll(".fo-choice-checkbox")) {

      box.checked = false;
    }

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:cleared", "an empty selection matching an empty default needs no entry to say so");

    const cleared = reducer(state, result.action);

    assert.deepEqual(cleared.configuredOptions, [], "and nothing is left behind");
  });

  test("emptying a scoped group over an upstream entry writes the local empty selection that masks it", () => {

    using _dom = createTestDom();

    // Neither axis deviates from the catalog here - the default is empty and so is the commit - so the write happens for the upstream reason alone, and what it
    // has to carry is the explicit none. A clear would hand the row straight back to the entry it was meant to override.
    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const state = pickerState({ configuredOptions: ["Enable.Pick.TypesUnset=a"], devices,
      scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const entry = pickerEntry(state, "TypesUnset");
    const control = pickerRow(state, "TypesUnset", { deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");

    assert.deepEqual(entry.choices.filter((choice) => choice.selected).map((choice) => choice.value), ["a"], "the device row starts out inheriting the global pick");

    for(const box of control.querySelectorAll(".fo-choice-checkbox")) {

      box.checked = false;
    }

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: "dev-a", entry });

    assert.equal(result.action.type, "option:set", "the upstream entry is what the local row has to override");
    assert.equal(result.action.args.value, "", "and the explicit none is what overrides it");

    const stored = reducer(state, result.action);

    assert.deepEqual(stored.configuredOptions, [ "Enable.Pick.TypesUnset=a", "Enable.Pick.TypesUnset.dev-a=" ], "the global pick stands, masked at the device");
  });

  test("emptying an ordinary value field still clears, on the same row family the pickers live in", () => {

    using _dom = createTestDom();

    // The policy boundary from the other side: the empty selection belongs to lists alone, and every other control keeps the clear that makes emptying a field
    // restore the default.
    const state = pickerState({ configuredOptions: ["Enable.Pick.Plain=custom"] });
    const entry = pickerEntry(state, "Plain");
    const control = pickerRow(state, "Plain").querySelector(".fo-option-value");

    control.value = "";

    const result = valueCommitTransition({ catalog: state.catalog, configIndex: buildConfigIndex(state.catalog, state.configuredOptions), control,
      controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:cleared", "an emptied text field drops its entry and resolution falls back to the default");

    const cleared = reducer(state, result.action);

    assert.deepEqual(cleared.configuredOptions, [], "nothing is stored in its place");
  });

  test("checking a GLOBAL list row with an untouched picker still writes the bare valueless enable", () => {

    using _dom = createTestDom();

    // The checkbox gesture is not a claim about the selection: it says the option applies, and the picker was never operated. The write has to compose the bare
    // enable, exactly as it does for any other value option checked at the global scope, which is why the writer takes the empty selection from the caller's
    // gesture rather than from the row being a list.
    const state = pickerState();
    const entry = pickerEntry(state, "TypesOff");
    const control = pickerRow(state, "TypesOff").querySelector(".fo-option-value");

    assert.equal(controlValueText(control), "", "the untouched picker of a default-off list holds nothing");

    const result = triStateTransition({ catalog: state.catalog, checkbox: checkboxStub(true), configIndex: buildConfigIndex(state.catalog,
      state.configuredOptions), control, controllerId: null, deviceId: null, entry });

    assert.equal(result.action.type, "option:set", "turning on a default-off option is a deviation worth recording");
    assert.equal(result.action.args.enabled, true);
    assert.equal(result.action.args.value, undefined, "and it carries no value at all, rather than an empty selection nobody chose");

    const stored = reducer(state, result.action);

    assert.deepEqual(stored.configuredOptions, ["Enable.Pick.TypesOff"], "the bare enable, with no payload delimiter in sight");
  });

  test("a scoped radio row walks the same tri-state gestures every other value row walks", () => {

    using _dom = createTestDom();

    /* The answers the machine gives a scoped row, asked of a radio group: an empty picker arms rather than writing, the armed row stands back down when it
     * is unchecked, a row with an entry above it clears back to inheritance, and a row with nothing above it records the explicit disable. None of these answers
     * is radio-specific, which is exactly why they are asked here - a family split anywhere in the machine would show up as a different one.
     */
    const empty = pickerState({ devices: PICKER_DEVICES, scope: DEVICE_SCOPE });

    assert.equal(scopedTriState({ checked: true, optionName: "QualityUnset", state: empty }).action.type, "option:armed",
      "nothing is picked yet, so checking the box opens the control rather than writing through it");
    assert.equal(scopedTriState({ armed: true, checked: false, optionName: "QualityUnset", state: empty }).action.type, "option:disarmed",
      "and unchecking the armed row stands it down, since nothing was ever persisted to undo");

    const upstream = pickerState({ configuredOptions: ["Enable.Pick.Quality=low"], devices: PICKER_DEVICES, scope: DEVICE_SCOPE });

    assert.equal(scopedTriState({ checked: false, optionName: "Quality", state: upstream }).action.type, "option:cleared",
      "with an entry above it, unchecking hands the row back to inheritance");

    const disable = scopedTriState({ checked: false, optionName: "Quality", state: empty }).action;

    assert.equal(disable.type, "option:set", "with nothing above it, the explicit disable is what the row has to record");
    assert.equal(disable.args.enabled, false);
    assert.equal(disable.args.id, "dev-a", "at the scope the gesture was made from");
  });

  test("committing the declared default through a picker clears the entry, in both styles", () => {

    using _dom = createTestDom();

    /* The gesture no picker row has driven before: a row carrying a value that deviates, brought back through its own control to what the catalog already says.
     * The write rule normalizes that to a clear, since the entry-less resolution yields exactly what the user just asked for - the same answer the checkbox
     * gesture gets on a default-matching row, reached here from the value side and through both control families.
     */
    const state = pickerState({ configuredOptions: [ "Enable.Pick.Tier=low", "Enable.Pick.Quality=low" ] });
    const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);
    const select = pickerRow(state, "Tier").querySelector(".fo-option-value");

    assert.equal(select.value, "low", "precondition: the dropdown rests on the stored deviation");

    select.value = "high";

    const dropdown = valueCommitTransition({ catalog: state.catalog, configIndex, control: select, controllerId: null, deviceId: null,
      entry: pickerEntry(state, "Tier") });

    assert.equal(dropdown.action.type, "option:cleared", "picking the declared default needs no entry to say what the default already says");

    const row = pickerRow(state, "Quality");

    document.body.appendChild(row);

    const group = row.querySelector(".fo-option-value");
    const inputs = [...group.querySelectorAll(".fo-choice-checkbox")];

    assert.deepEqual(inputs.map((input) => input.checked), [ true, false, false ], "precondition: the radio group rests on the stored deviation");

    inputs[2].click();

    const radio = valueCommitTransition({ catalog: state.catalog, configIndex, control: group, controllerId: null, deviceId: null,
      entry: pickerEntry(state, "Quality") });

    assert.equal(radio.action.type, "option:cleared", "and the radio group reaches the same rule through the same writer");
  });
});

/* The list editor. A free-form list is a set of values the user builds up one at a time, and editing it as one comma-joined string in a text field asks them to do
 * the grammar's bookkeeping by hand. What these tests hold to is that each gesture does exactly what it says and nothing more - each with its own negative control,
 * because a remove that fires one keystroke early costs the user an entry they did not ask to lose - and that the whole thing still reports itself to the view the
 * way a text field does.
 */
const editorRowFor = (state, optionName = "Plates") => {

  const row = pickerRow(state, optionName);

  document.body.appendChild(row);

  return row;
};

const editorItems = (control) => [...control.querySelectorAll(".fo-list-item")].map((item) => item.dataset.value);

// Type text into the entry field and finish it with Enter, which is the gesture that turns pending text into an entry.
const typeEntry = (control, text, key = "Enter") => {

  const field = control.querySelector(".fo-list-entry");

  field.value = text;
  field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
};

describe("the list editor - construction", () => {

  test("builds the option's entries, each with its own remove control, followed by the field the next one is typed into", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");

    assert.equal(control.tagName, "DIV");
    assert.equal(control.classList.contains("fo-option-value"), true, "the editor is the control, so it carries the shared class");
    assert.equal(control.classList.contains("fo-list-editor"), true);
    assert.deepEqual(editorItems(control), [ "a", "b" ], "the declared default's entries, parsed through the shared grammar");
    assert.equal(control.querySelectorAll(".fo-list-remove").length, 2, "each entry carries its own remove control");
    assert.equal(control.querySelector(".fo-list-item .fo-list-remove").getAttribute("aria-label"), "Remove a.", "which names the entry it removes");
    assert.equal(control.querySelector(".fo-list-entry").style.fontFamily, "", "the field reads in the inherited body font");
    assert.ok(control.lastElementChild.matches(".fo-list-entry"), "the field sits after the entries, where the next one is typed");
  });
});

describe("the list editor - gestures", () => {

  test("Enter turns the pending text into an entry, and adds nothing when there is no text to turn", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");

    typeEntry(control, "zed");

    assert.deepEqual(editorItems(control), [ "a", "b", "zed" ], "the typed text became an entry");
    assert.equal(control.querySelector(".fo-list-entry").value, "", "and the field is clear for the next one");

    typeEntry(control, "");
    typeEntry(control, "   ");

    assert.deepEqual(editorItems(control), [ "a", "b", "zed" ], "an empty field and a whitespace-only field both add nothing at all");
  });

  test("a typed comma finishes an entry the way Enter does, and never reaches the field as a character", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");

    typeEntry(control, "zed", ",");

    assert.deepEqual(editorItems(control), [ "a", "b", "zed" ], "the comma is the separator gesture, not a character");
    assert.equal(control.querySelector(".fo-list-entry").value, "", "the field is clear, with no delimiter left sitting in it");

    typeEntry(control, "  ", ",");

    assert.deepEqual(editorItems(control), [ "a", "b", "zed" ], "a comma over whitespace alone adds nothing");
  });

  test("Backspace on an empty field removes the last entry, and removes nothing while there is text to erase", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");
    const field = control.querySelector(".fo-list-entry");

    // The negative controls first: a field the user is typing in must never erase their neighbour's entry out from under them.
    field.value = "still typing";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" }));

    assert.deepEqual(editorItems(control), [ "a", "b" ], "text in the field means Backspace belongs to the text");

    field.value = " ";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" }));

    assert.deepEqual(editorItems(control), [ "a", "b" ], "a field holding a space is still a field being typed in");

    field.value = "";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" }));

    assert.deepEqual(editorItems(control), ["a"], "an empty field is what makes Backspace reach the list");
  });

  test("the remove control removes its own entry, and a click anywhere else in the editor removes none", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");

    // The negative control first: the editor answers clicks on its own account, so a click that is not on a remove control has to fall through silently rather
    // than removing whatever happens to be nearest.
    control.click();
    control.querySelector(".fo-list-item").click();

    assert.deepEqual(editorItems(control), [ "a", "b" ], "clicking the editor or an entry's own text removes nothing");

    control.querySelectorAll(".fo-list-remove")[0].click();

    assert.deepEqual(editorItems(control), ["b"], "the entry whose control was pressed is the one that went");
  });

  test("blurring the field with text in it keeps that text as an entry rather than discarding it", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");
    const field = control.querySelector(".fo-list-entry");

    field.value = "zed";
    field.dispatchEvent(new Event("blur"));

    assert.deepEqual(editorItems(control), [ "a", "b", "zed" ], "text the user typed and moved away from is text they meant");
  });

  test("every gesture that moves the list announces one change event on the editor itself", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");
    let changes = 0;

    control.addEventListener("change", (event) => {

      assert.ok(event.bubbles, "the event bubbles, which is how the view's delegation reaches it");
      changes++;
    });

    typeEntry(control, "zed");
    control.querySelectorAll(".fo-list-remove")[0].click();

    const field = control.querySelector(".fo-list-entry");

    field.value = "";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" }));

    assert.equal(changes, 3, "an add, a remove, and a Backspace erase - one event each");

    typeEntry(control, "  ");

    assert.equal(changes, 3, "a gesture that moved nothing announces nothing");
  });
});

describe("the list editor - reading and writing its value", () => {

  test("reads as its entries followed by whatever is still pending in the field", () => {

    using _dom = createTestDom();

    const control = editorRowFor(pickerState()).querySelector(".fo-option-value");

    assert.equal(controlValueText(control), "a,b", "the entries alone when the field is empty");

    control.querySelector(".fo-list-entry").value = "  zed  ";

    assert.equal(controlValueText(control), "a,b,zed", "text the user has not finished still counts - a commit can arrive before any blur does");

    control.querySelector(".fo-list-entry").value = "   ";

    assert.equal(controlValueText(control), "a,b", "whitespace alone is not a pending entry");
  });

  test("a re-derive rebuilds the entries from the projection and clears the field", () => {

    using _dom = createTestDom();

    const row = editorRowFor(pickerState());
    const control = row.querySelector(".fo-option-value");

    control.querySelector(".fo-list-entry").value = "abandoned";

    applyRowState({ entry: pickerEntry(pickerState({ configuredOptions: ["Enable.Pick.Plates=x,y,z"] }), "Plates"), row, scopeKind: "global" });

    assert.deepEqual(editorItems(control), [ "x", "y", "z" ], "the projection's list is what the editor shows");
    assert.equal(control.querySelector(".fo-list-entry").value, "", "and the field starts clean beneath it");
  });

  test("a re-derive against an unchanged list leaves the entry NODES in place", () => {

    using _dom = createTestDom();

    const row = editorRowFor(pickerState());
    const control = row.querySelector(".fo-option-value");
    const before = [...control.querySelectorAll(".fo-list-item")];

    applyRowState({ entry: pickerEntry(pickerState(), "Plates"), row, scopeKind: "global" });

    assert.ok([...control.querySelectorAll(".fo-list-item")].every((node, index) => node === before[index]), "an unchanged list is not rebuilt");
  });

  test("a re-derive yields to an edit in progress inside the editor", () => {

    using _dom = createTestDom();

    const row = editorRowFor(pickerState());
    const control = row.querySelector(".fo-option-value");
    const field = control.querySelector(".fo-list-entry");

    field.focus();
    field.value = "typing-in-progress";

    applyRowState({ entry: pickerEntry(pickerState({ configuredOptions: ["Enable.Pick.Plates=x,y"] }), "Plates"), row, scopeKind: "global" });

    assert.equal(field.value, "typing-in-progress", "the uncommitted entry survives, exactly as a text field's uncommitted text does");
    assert.deepEqual(editorItems(control), [ "a", "b" ], "and the entries beside it are left alone with it");
  });

  test("an armed row opens the editor empty rather than previewing a default list", () => {

    using _dom = createTestDom();

    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const state = pickerState({ devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const control = pickerRow(state, "Plates", { armed: true, deviceId: "dev-a", scopeKind: "device" }).querySelector(".fo-option-value");

    assert.deepEqual(editorItems(control), [], "arming asks for the first entry, so there is nothing to remove first");
  });

  test("a locked row disables the field and every remove control, and marks the editor", () => {

    using _dom = createTestDom();

    const locked = pickerState({ configuredOptions: ["Disable.Pick.Plates"] });
    const control = editorRowFor(locked).querySelector(".fo-option-value");

    assert.equal(control.querySelector(".fo-list-entry").disabled, true, "nothing can be typed into a locked row");
    assert.deepEqual([...control.querySelectorAll(".fo-list-remove")].map((b) => b.disabled), [ true, true ], "and nothing can be removed from it");
    assert.equal(control.getAttribute("aria-disabled"), "true");

    const live = editorRowFor(pickerState()).querySelector(".fo-option-value");

    assert.equal(live.querySelector(".fo-list-entry").disabled, false);
    assert.deepEqual([...live.querySelectorAll(".fo-list-remove")].map((b) => b.disabled), [ false, false ]);
    assert.equal(live.getAttribute("aria-disabled"), null);
  });
});
