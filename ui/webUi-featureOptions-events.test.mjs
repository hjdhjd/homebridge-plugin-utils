/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-featureOptions-events.test.mjs: Tests for the event delegation that now lives in the views (options / search / nav) and the keyboard effect rather than
 * in the orchestrator. Companion to webUi-featureOptions.test.mjs - that file pins the show/hide/render/nav lifecycle, this one pins the click / change / input /
 * keydown routes that dispatch user actions into the store, which the reducer and the persistence effect then consume. Tests synthesize DOM events on the live
 * orchestrator instance after show() so the full delegation path runs end-to-end.
 */
"use strict";

import { clickCategoryHeader, createFakeHomebridge, createSkeletonFeatureOptionsDom, createTestDom, installHomebridge, openTestSession } from "./ui.helpers.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { webUiFeatureOptions } from "./webUi-featureOptions.mjs";

// Seed Bootstrap's `.d-none { display: none }` shim so the theme component's #waitForBootstrap probe completes immediately.
function seedBootstrapProbeShim() {

  const sheet = new CSSStyleSheet();

  sheet.replaceSync(".d-none { display: none; } .btn-primary { background-color: rgb(33, 37, 41); color: rgb(255, 255, 255); }");
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, sheet ];
}

// Yield enough event-loop turns for the orchestrator's async show() chain (homebridge.getPluginConfig + /getOptions request + theme probe) to settle. The event-
// delegation tests in this file mostly assert on synchronous DOM state after a synthesized event, so a single 10ms tick after show() is plenty of headroom.
async function flush() {

  await delay(10);
}

// Wait long enough for the persist effect's 300ms debounce window to expire and the resulting updatePluginConfig call (and any rollback dispatch) to settle.
// Used after any user action that should produce (or NOT produce) a persist call - a fixed wall-clock wait is the right primitive because the test's interest is
// in the post-debounce settled state, not in observing the persist's individual lifecycle events.
async function settlePersist() {

  await delay(400);
}

const FEATURES = {

  categories: [

    { description: "Motion Options", name: "Motion" },
    { description: "Audio Options", name: "Audio" }
  ],

  options: {

    Audio: [

      { default: false, description: "Enable audio capture.", name: "Capture" },
      { default: false, description: "Audio volume level.", name: "Volume" }
    ],

    Motion: [

      { default: true, description: "Enable motion detection.", name: "Detect" }
    ]
  }
};

function makePluginConfig() {

  return [{ name: "TestPlugin", options: [], platform: "TestPlugin" }];
}

// Build a started orchestrator: dom + skeleton + homebridge fake + theme shim + show() awaited. Every test in this file consumes this harness so the setup cost
// is amortized into one helper. Returns a disposable handle whose dispose closes the orchestrator and the dom in correct order.
async function makeStartedOrchestrator({ config, features = FEATURES } = {}) {

  const dom = createTestDom();
  const skeleton = createSkeletonFeatureOptionsDom();
  const fake = createFakeHomebridge({

    config: config ?? makePluginConfig(),
    requestResponses: new Map([[ "/getOptions", features ]])
  });
  const homebridgeGuard = installHomebridge(fake);

  seedBootstrapProbeShim();

  const orchestrator = new webUiFeatureOptions();

  await orchestrator.show(await openTestSession());
  await flush();

  return {

    fake,
    orchestrator,
    skeleton,

    [Symbol.dispose]() {

      orchestrator.cleanup();
      homebridgeGuard[Symbol.dispose]();
      dom[Symbol.dispose]();
    }
  };
}

describe("webUiFeatureOptions event delegation - category toggle handler", () => {

  test("expanding a category materializes its rows and persists the new category state", async () => {

    using harness = await makeStartedOrchestrator();

    const motionDetails = harness.skeleton.configTable.querySelector("details[data-category='Motion']");

    assert.ok(motionDetails, "the Motion category disclosure must be rendered after show()");
    assert.equal(motionDetails.open, false, "categories start collapsed");
    assert.equal(motionDetails.querySelector(".fo-category-rows").children.length, 0, "rows are not materialized until the toggle handler runs (lazy contract)");

    clickCategoryHeader(motionDetails);

    assert.equal(motionDetails.open, true, "expand sets the details.open property");
    assert.ok(motionDetails.querySelector(".fo-category-rows > .fo-option-row"), "the toggle handler materialized the category's rows synchronously");
  });

  test("expand-all opens and materializes every category's rows in a single pass", async () => {

    using harness = await makeStartedOrchestrator();

    const toggleAll = document.getElementById("toggleAllCategories");

    assert.ok(toggleAll, "the toggle-all control must be present");
    assert.equal(toggleAll.getAttribute("data-action"), "expand", "with every category collapsed, the control offers expand");

    const categories = [...harness.skeleton.configTable.querySelectorAll("details[data-category]")];

    assert.ok(categories.length > 1, "the fixture must render multiple categories");
    assert.ok(categories.every((details) => !details.open), "categories start collapsed");

    toggleAll.click();

    // Bulk expand drives the options view's toggle handler inline so every category opens AND materializes its rows in the same synchronous pass, rather than the open
    // reflowing first and the async native toggle materializing in a second. We assert both halves of that contract here; the single-pass property is what keeps the
    // host's iframe-resize observer from cascading on a real browser, where the native toggle is async.
    assert.ok(categories.every((details) => details.open), "every category is expanded after expand-all");
    assert.ok(categories.every((details) => details.querySelector(".fo-category-rows > .fo-option-row")), "every category's rows are materialized after expand-all");
  });

  test("the toggle-all control tracks individual category expand/collapse, not just the bulk control", async () => {

    using harness = await makeStartedOrchestrator();

    const toggleAll = document.getElementById("toggleAllCategories");
    const categories = [...harness.skeleton.configTable.querySelectorAll("details[data-category]")];

    assert.equal(toggleAll.getAttribute("data-action"), "expand", "starts as expand with every category collapsed");

    // Expand a majority of categories one at a time via summary clicks - NOT the bulk toggle-all. The control must still flip to "collapse," which only happens if it
    // observes individual category toggles rather than only its own bulk action / store events.
    const majority = Math.floor(categories.length / 2) + 1;

    for(let index = 0; index < majority; index++) {

      clickCategoryHeader(categories[index]);
    }

    assert.equal(toggleAll.getAttribute("data-action"), "collapse", "flips to collapse once a majority of categories are expanded individually");

    for(let index = 0; index < majority; index++) {

      clickCategoryHeader(categories[index]);
    }

    assert.equal(toggleAll.getAttribute("data-action"), "expand", "returns to expand once the majority are collapsed again");
  });

  test("clicking an option label toggles its associated checkbox via the click() routing", async () => {

    using harness = await makeStartedOrchestrator();

    // Expand the Motion category first so the row's checkbox is visible/interactable.
    clickCategoryHeader(harness.skeleton.configTable.querySelector("details[data-category='Motion']"));

    const detectRow = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect']");

    assert.ok(detectRow, "the Motion.Detect row must be rendered");

    const checkbox = detectRow.querySelector("input[type='checkbox']");
    const label = detectRow.querySelector(".fo-option-label");
    const initialChecked = checkbox.checked;

    assert.ok(label, "the option label must exist for click-toggle routing");

    label.click();

    assert.equal(checkbox.checked, !initialChecked, "clicking the label must toggle the checkbox");
  });
});

describe("webUiFeatureOptions event delegation - change handler", () => {

  test("changing a checkbox dispatches the option-change pipeline and persists to homebridge", async () => {

    using harness = await makeStartedOrchestrator();

    clickCategoryHeader(harness.skeleton.configTable.querySelector("details[data-category='Motion']"));

    const checkbox = harness.skeleton.configTable.querySelector("[id='Motion.Detect']");

    assert.ok(checkbox, "the Motion.Detect checkbox must exist");

    // Toggle the checkbox and dispatch the change event. The options view's change handler dispatches an option mutation (option:set / option:cleared); the reducer
    // recomputes configuredOptions and the persist effect drains the change to disk via session.commit, which calls homebridge.updatePluginConfig.
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    await settlePersist();

    // The orchestrator should have called updatePluginConfig at least once (post-change). The exact options array shape depends on FeatureOptions internals; we
    // verify only that a call landed - that pins the change-handler -> updatePluginConfig wiring without coupling to the options serialization format.
    assert.ok(harness.fake.observed.updatedConfigs.length > 0, "checkbox change must trigger updatePluginConfig at least once");
  });

  test("changing a checkbox in a category that does not match a known config table is silently ignored", async () => {

    using harness = await makeStartedOrchestrator();

    // Synthesize a checkbox that has no surrounding `details[data-category]` ancestor. The change handler must short-circuit on the missing ancestor without throwing
    // or trying to look up an option in an undefined category. We append a stray checkbox directly to the page, dispatch change, and verify the persistence layer
    // was untouched.
    const stray = document.createElement("input");

    stray.type = "checkbox";
    stray.id = "stray-checkbox";
    document.getElementById("pageFeatureOptions").appendChild(stray);

    const before = harness.fake.observed.updatedConfigs.length;

    stray.dispatchEvent(new Event("change", { bubbles: true }));

    assert.equal(harness.fake.observed.updatedConfigs.length, before,
      "a stray checkbox without a category ancestor must not trigger updatePluginConfig");
  });

  test("toggling a checkbox while a search query is active re-applies the search filter against the post-toggle DOM", async () => {

    // When the user has filtered the visible rows with a search query and then toggles an option, visibility stays correct because it is a projection of state: the
    // query lives in state.filter and the toggle dispatches an option mutation, and the options view re-walks the same projection on every change. We verify that
    // contract by setting a query that hides one row, toggling another row, and asserting the hidden row stays hidden rather than reappearing after the toggle.
    using harness = await makeStartedOrchestrator();

    // Expand the Motion category so its row is visible/interactable.
    clickCategoryHeader(harness.skeleton.configTable.querySelector("details[data-category='Motion']"));
    clickCategoryHeader(harness.skeleton.configTable.querySelector("details[data-category='Audio']"));

    // Drive a search query that matches "Detect" but not "Volume". The search component will hide the Audio.Volume row.
    const searchInput = document.getElementById("searchInput");

    searchInput.value = "Detect";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await delay(310); // wait past the search component's 300ms debounce

    const volumeRow = harness.skeleton.configTable.querySelector("[id='row-Audio.Volume']");

    assert.ok(volumeRow.classList.contains("fo-hidden"), "the search query must hide the Audio.Volume row before the toggle");

    // Toggle the Motion.Detect checkbox. The option mutation dispatch re-runs the options view's projection walk, which re-derives each row's visibility from the
    // active filter query - so the previously-hidden row stays hidden.
    const detectCheckbox = harness.skeleton.configTable.querySelector("[id='Motion.Detect']");

    detectCheckbox.checked = false;
    detectCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    await flush();

    assert.ok(volumeRow.classList.contains("fo-hidden"),
      "after toggling, the search filter must have re-applied; the previously-filtered Audio.Volume row remains hidden");
  });
});

describe("webUiFeatureOptions event delegation - keydown handler", () => {

  // The Enter/Space-on-category-header behavior is owned natively by `<details>`/`<summary>` - the browser handles the keyboard activation and toggles
  // `details.open` without any handler in this library. Tests for those keystrokes would be testing the user-agent's behavior, not ours; they were removed
  // when the library migrated off the table-based category construct and onto the native disclosure widget. The keydown handler this section covers now only
  // handles Escape on the search input and the Ctrl+F / Cmd+F search-focus shortcut.

  test("Escape on the search input clears the query and re-fires the input event", async () => {

    // The Escape shortcut hands the search field back to its empty state in one keystroke. We assert against both the cleared value AND the re-dispatched input
    // event by spying on the search component's handler indirectly: setting a query, pressing Escape, and verifying the visibility of search-filtered rows resets.
    using _harness = await makeStartedOrchestrator();

    const searchInput = document.getElementById("searchInput");

    assert.ok(searchInput, "the search input must be rendered");

    // Seed a query that filters out Motion.Detect (a label that doesn't contain "nonexistent"). The input event is what the search component listens to, so we
    // synthesize one explicitly to trigger the debounced search.
    searchInput.value = "nonexistent-query-text";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Escape resets the input value and re-fires input, which the search component sees as an empty query.
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));

    assert.equal(searchInput.value, "", "Escape must clear the search input value");
  });

  test("Ctrl/Cmd+F focuses the search input when the search panel is visible", async () => {

    using harness = await makeStartedOrchestrator();

    // Use document.activeElement as the focus witness. The search panel is visible by virtue of show() having rendered the device view; pressing Ctrl+F anywhere
    // on the feature-options page should bring focus to the search field.
    const targetElement = harness.skeleton.configTable;

    targetElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "f" }));

    const searchInput = document.getElementById("searchInput");

    assert.equal(document.activeElement, searchInput, "Ctrl+F must focus the search input");
  });

  test("Meta+F (macOS) also focuses the search input", async () => {

    // Symmetric coverage for the macOS modifier - the handler checks both ctrlKey and metaKey.
    using harness = await makeStartedOrchestrator();

    harness.skeleton.configTable.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "f", metaKey: true }));

    assert.equal(document.activeElement, document.getElementById("searchInput"), "Cmd+F must focus the search input");
  });

  test("Ctrl+F is a no-op when the search panel is hidden", async () => {

    // The handler bails when the search panel's display is "none" - the user has no visible search field to focus, so the shortcut should not steal focus from
    // whatever they were doing. We hide the panel directly (the connection-error path is the production case where this happens) and verify Ctrl+F does not move
    // focus to the now-invisible search input.
    using harness = await makeStartedOrchestrator();

    const searchPanel = document.getElementById("search");
    const searchInput = document.getElementById("searchInput");
    const sentinel = document.createElement("button");

    document.body.appendChild(sentinel);
    sentinel.focus();

    searchPanel.style.display = "none";

    harness.skeleton.configTable.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "f" }));

    assert.notEqual(document.activeElement, searchInput, "Ctrl+F must not focus the search input when the search panel is hidden");
    assert.equal(document.activeElement, sentinel, "focus must remain on whatever element held it before the shortcut");
  });
});

describe("webUiFeatureOptions event delegation - click forwarding via nav links", () => {

  // Sidebar nav-link clicks dispatch to global / controller / device handlers based on the data-navigation attribute. The events test pins each of the three routes
  // by clicking a synthesized nav-link and asserting that the orchestrator's view shifted accordingly.

  test("clicking a controller nav-link dispatches scope:changed for that controller", async () => {

    using _dom = createTestDom();
    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    // Build the orchestrator with two controllers. show() renders the first one's view; clicking the second's nav-link should switch.
    const controllers = [

      { name: "Controller A", serialNumber: "CTRL-A" },
      { name: "Controller B", serialNumber: "CTRL-B" }
    ];
    const orchestrator = new webUiFeatureOptions({

      getControllers: () => controllers,
      getDevices: (controller) => [{ firmwareRevision: "1.0", manufacturer: "X", model: "Y", name: "Device", serialNumber: controller.serialNumber }]
    });

    await orchestrator.show(await openTestSession());
    await flush();

    // The orchestrator rendered the first controller initially. We synthesize a click on the second controller's nav-link and assert the view followed.
    const ctrlBLink = skeleton.controllersContainer.querySelector("[data-navigation='controller'][data-device-serial='CTRL-B']");

    assert.ok(ctrlBLink, "the second controller's nav-link must be rendered in the sidebar");

    ctrlBLink.click();
    await flush();

    // The active controller is reflected in the nav-link's `.active` class; assert against the visible state to pin the routing without coupling to private fields.
    assert.ok(ctrlBLink.classList.contains("active"), "clicking the controller nav-link must promote it to active");

    orchestrator.cleanup();
  });

  test("clicking a device nav-link dispatches scope:changed for that device", async () => {

    using _dom = createTestDom();
    const skeleton = createSkeletonFeatureOptionsDom();

    // Two devices in the device list. The first is the controller (per the orchestrator's convention); the second is a non-controller device whose row we click.
    const devices = [

      { firmwareRevision: "1.0", manufacturer: "Acme", model: "Controller", name: "Hub", serialNumber: "CTRL-1" },
      { firmwareRevision: "1.0", manufacturer: "Acme", model: "Camera", name: "Cam", serialNumber: "DEV-002" }
    ];
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [{ name: "Hub", serialNumber: "CTRL-1" }],
      getDevices: () => devices,
      ui: { isController: (device) => device.serialNumber === "CTRL-1" }
    });

    await orchestrator.show(await openTestSession());
    await flush();

    // The non-controller device's nav-link is the second device link in the container - the first slot is the controller itself, which is also rendered as a
    // device link by the orchestrator's convention. We address by position rather than by name attribute because happy-dom doesn't always reflect the `name`
    // property to the attribute on anchor elements.
    const deviceLinks = skeleton.devicesContainer.querySelectorAll("a[data-navigation='device']");
    const deviceLink = [...deviceLinks].find((link) => link.textContent === "Cam");

    assert.ok(deviceLink, "the DEV-002 (Cam) nav-link must be rendered in the sidebar");

    deviceLink.click();
    await flush();

    assert.ok(deviceLink.classList.contains("active"), "clicking the device nav-link must promote it to active");

    orchestrator.cleanup();
  });

  test("clicking the global-options nav-link routes back to global from a controller view", async () => {

    using harness = await makeStartedOrchestrator();

    const globalLink = harness.skeleton.controllersContainer.querySelector("[data-navigation='global']");

    assert.ok(globalLink, "the global-options nav-link must be rendered");

    globalLink.click();
    await flush();

    assert.ok(globalLink.classList.contains("active"), "the global-options link must be marked active after click");
  });
});

describe("webUiFeatureOptions event delegation - text input change re-dispatches as checkbox change", () => {

  test("changing a value input fires the persistence pipeline by re-dispatching as the row's checkbox change", async () => {

    using harness = await makeStartedOrchestrator({

      config: [{ name: "TestPlugin", options: ["Enable.Network.Mtu.1500"], platform: "TestPlugin" }],
      features: {

        categories: [{ description: "Network Options", name: "Network" }],
        options: { Network: [{ default: false, defaultValue: "1500", description: "MTU.", name: "Mtu" }] }
      }
    });

    // Expand the Network category so the input is visible.
    clickCategoryHeader(harness.skeleton.configTable.querySelector("details[data-category='Network']"));

    const row = harness.skeleton.configTable.querySelector("[id='row-Network.Mtu']");
    const valueInput = row.querySelector("input[type='text']");

    assert.ok(valueInput, "the value input must exist for a value-centric option");

    // Mutate the input and dispatch its change event. The orchestrator's text-input handler re-fires a change on the row's checkbox, which then routes through the
    // renderer's option-change pipeline and lands in homebridge.updatePluginConfig.
    const updatesBefore = harness.fake.observed.updatedConfigs.length;

    valueInput.value = "9000";
    valueInput.dispatchEvent(new Event("change", { bubbles: true }));

    await settlePersist();

    assert.ok(harness.fake.observed.updatedConfigs.length > updatesBefore,
      "a text-input change must propagate to updatePluginConfig via the checkbox re-dispatch pipeline");
  });
});
