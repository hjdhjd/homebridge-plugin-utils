/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/rendering.test.mjs: Unit tests for the pure-function rendering module.
 */
"use strict";

import { applyRowState, categoryShell, optionRow, toggleSecretReveal, triStateTransition, valueCommitTransition } from "./rendering.mjs";
import { buildCatalogIndex, buildConfigIndex } from "../featureOptions.js";
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

    // Volume and Bandwidth (with and without an explicit inputSize) render through the identical stacked structure; no row carries an inline-flex or three-column class
    // regardless of whether inputSize is declared.
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
    assert.equal(row.querySelector(".fo-option-content").children[1], wrapper, "the wrapper takes the field's place in the content cell");
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
    assert.equal(row.querySelector(".fo-secret-toggle"), null, "no toggle");
    assert.equal(row.querySelector(".fo-secret-field"), null, "no wrapper");
    assert.equal(cell.children.length, 2, "the content cell holds the label and the field, and nothing else");
    assert.equal(cell.children[1], input, "the field sits directly in the cell");
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
    const inputValue = document.createElement("input");

    inputValue.type = "text";
    inputValue.value = "75";

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: null, entry, inputValue });

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

    const inputValue = document.createElement("input");

    inputValue.type = "text";
    inputValue.value = "75";

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: "dev-a", entry, inputValue });

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

    const inputValue = document.createElement("input");

    inputValue.type = "text";
    inputValue.value = "mono";

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: null, entry, inputValue });

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

    const inputValue = document.createElement("input");

    inputValue.type = "text";
    inputValue.value = "";

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: "dev-a", entry, inputValue });

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

    const inputValue = document.createElement("input");

    inputValue.type = "text";
    inputValue.value = "";

    const result = triStateTransition({ armed: true, catalog, checkbox, configIndex, controllerId: null, deviceId: "dev-a", entry, inputValue });

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

    const inputValue = document.createElement("input");

    inputValue.type = "text";
    inputValue.value = "";

    const result = triStateTransition({ catalog, checkbox, configIndex, controllerId: null, deviceId: null, entry, inputValue });

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
    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: null, entry, inputValue: textInput("60") });

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
    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: null, entry, inputValue: textInput("60") });

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
    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: null, entry, inputValue: textInput("") });

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

    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: null, entry, inputValue: textInput("") });

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
    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: "dev-a", entry, inputValue: textInput("") });

    assert.equal(result.action.type, "option:cleared");
    assert.equal(result.action.args.id, "dev-a", "the clear addresses the device scope the gesture was made at");
  });

  test("a commit without content on an unset row yields no action", () => {

    using _dom = createTestDom();

    const state = loadedState();
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: null, entry, inputValue: textInput("   ") });

    assert.equal(result.action, null, "nothing to say and nothing to remove - the caller restores the row instead of dispatching");
  });

  test("a commit without content on an explicitly disabled row yields no action", () => {

    using _dom = createTestDom();

    // The guard that keeps the gesture honest: an enable-shaped dispatch here would drop the user's explicit disable, state the emptied input never addressed.
    const state = loadedState({ configuredOptions: ["Disable.Audio.Volume"] });
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: null, entry, inputValue: textInput("") });

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

    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: "dev-a", entry, inputValue: textInput("") });

    assert.equal(result.action, null, "the upstream entry survives a gesture made at a lower scope");
  });

  test("an all-delimiter commit reads as no content", () => {

    using _dom = createTestDom();

    // The content predicate is shared with the entry writer, so a value the engine would refuse to persist never dispatches in the first place.
    const state = loadedState();
    const catalog = state.catalog;
    const configIndex = buildConfigIndex(catalog, state.configuredOptions);
    const entry = findEntry(state, "Audio", "Volume");
    const result = valueCommitTransition({ catalog, configIndex, controllerId: null, deviceId: null, entry, inputValue: textInput(" == ") });

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
      controllerId: null,
      deviceId: "dev-a",
      entry: findEntry(state, "Probe", optionName),
      inputValue: null
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
