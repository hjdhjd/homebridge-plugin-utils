/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/search.test.mjs: Unit tests for the search panel view.
 */
"use strict";

import { createTestDom, waitFor } from "../../ui.helpers.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { mountSearchView } from "./search.mjs";

const CATEGORIES = [{ description: "Motion Options", name: "Motion" }];
const OPTIONS = { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] };

const CATALOG = {

  ...buildCatalogIndex(CATEGORIES, OPTIONS),

  // The validator names the device these rows land as the controller's own row, which is what gives a controller view a scoping identity and therefore a table
  // for the panel to follow. A list without that row has nothing to edit at controller level, so the surface there is a notice and the panel has nothing to filter.
  validators: { isController: (device) => device?.serialNumber === "dev-a", validOption: () => true, validOptionCategory: () => true }
};

const setup = ({ configuredOptions = [] } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const root = document.createElement("div");
  const configTable = document.createElement("div");
  const controller = new AbortController();

  root.id = "search";
  configTable.id = "configTable";
  document.body.append(root, configTable);

  store.dispatch({ catalog: CATALOG, configuredOptions, controllers: [], mode: "device-only", type: "model:loaded" });
  mountSearchView({ configTable, root, signal: controller.signal, store });

  return { abort: () => controller.abort(), configTable, root, store };
};

describe("mountSearchView - panel build", () => {

  test("renders the search input, filter pills, toggle-all, status bar, and reset button group", () => {

    using dom = createTestDom();

    const { root } = setup();

    assert.ok(root.querySelector("#searchInput"), "search input present");
    assert.ok(root.querySelector("#filter-all"), "all filter pill present");
    assert.ok(root.querySelector("#filter-modified"), "modified filter pill present");
    assert.ok(root.querySelector("#toggleAllCategories"), "toggle-all button present");
    assert.ok(root.querySelector("#statusInfo"), "status bar present");
    assert.ok(root.querySelector("[data-action='reset-toggle']"), "reset toggle button present");
    assert.ok(root.querySelector("[data-action='reset-defaults']"), "reset defaults button present (initially hidden via d-none)");
    assert.ok(root.querySelector("[data-action='reset-revert']"), "reset revert button present (initially hidden via d-none)");
  });

  test("status bar carries role=status for screen readers", () => {

    using dom = createTestDom();

    const { root } = setup();

    assert.equal(root.querySelector("#statusInfo")?.getAttribute("role"), "status");
  });

  test("initial counts read 1 total / 0 modified / 0 grouped / 1 visible for the seed catalog", () => {

    using dom = createTestDom();

    const { root } = setup();
    const counts = [...root.querySelectorAll("strong")].map((s) => s.textContent);

    assert.deepEqual(counts, [ "1", "0", "0", "1" ]);
  });

  test("does not reveal its own region - building the panel leaves the reveal to the orchestrator", () => {

    using dom = createTestDom();

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const root = document.createElement("div");
    const configTable = document.createElement("div");
    const controller = new AbortController();

    root.id = "search";
    configTable.id = "configTable";
    document.body.append(root, configTable);

    // The orchestrator hides the search region before populating it; the view must build its panel without revealing the region itself. This test asserts
    // the rule that region visibility remains the orchestrator's responsibility, so the search box cannot flash in before the rest of the page is ready.
    root.style.display = "none";
    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    mountSearchView({ configTable, root, signal: controller.signal, store });

    assert.ok(root.querySelector("#searchInput"), "the view built the search panel on the model:loaded immediate-run");
    assert.equal(root.style.display, "none", "the view did not reveal its own region - reveal is the orchestrator's responsibility");

    controller.abort();
  });
});

describe("mountSearchView - filter pill click", () => {

  test("clicking 'Modified' dispatches filter:changed with mode=modified", () => {

    using dom = createTestDom();

    const { root, store } = setup();

    root.querySelector("#filter-modified").click();

    assert.equal(store.state.filter.mode, "modified");
  });

  test("clicking 'All' restores filter:changed with mode=all", () => {

    using dom = createTestDom();

    const { root, store } = setup();

    root.querySelector("#filter-modified").click();
    root.querySelector("#filter-all").click();

    assert.equal(store.state.filter.mode, "all");
  });

  test("filter pills' active-state classes update to reflect the current mode", () => {

    using dom = createTestDom();

    const { root } = setup();
    const allPill = root.querySelector("#filter-all");
    const modifiedPill = root.querySelector("#filter-modified");

    modifiedPill.click();

    assert.equal(allPill.classList.contains("btn-primary"), false);
    assert.equal(modifiedPill.classList.contains("btn-warning"), true);
  });
});

describe("mountSearchView - reset button group", () => {

  test("clicking Reset... reveals the destructive action buttons", () => {

    using dom = createTestDom();

    const { root } = setup();
    const toggleBtn = root.querySelector("[data-action='reset-toggle']");
    const defaultsBtn = root.querySelector("[data-action='reset-defaults']");
    const revertBtn = root.querySelector("[data-action='reset-revert']");

    assert.equal(defaultsBtn.classList.contains("d-none"), true);
    toggleBtn.click();
    assert.equal(defaultsBtn.classList.contains("d-none"), false);
    assert.equal(revertBtn.classList.contains("d-none"), false);
  });

  test("clicking Reset to Defaults dispatches options:reset and collapses the action group", () => {

    using dom = createTestDom();

    const { root, store } = setup({ configuredOptions: ["Disable.Motion.Detect"] });

    root.querySelector("[data-action='reset-toggle']").click();
    root.querySelector("[data-action='reset-defaults']").click();

    assert.deepEqual(store.state.configuredOptions, []);
    assert.equal(root.querySelector("[data-action='reset-defaults']").classList.contains("d-none"), true);
  });

  test("clicking Revert to Saved dispatches model:reverted and collapses the action group", () => {

    using dom = createTestDom();

    const { root, store } = setup({ configuredOptions: ["Enable.Motion.Detect"] });

    // Mutate first so we have something to revert.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });

    root.querySelector("[data-action='reset-toggle']").click();
    root.querySelector("[data-action='reset-revert']").click();

    assert.equal(store.state.configuredOptions, store.state.initialOptions, "configuredOptions reverted to the initial snapshot");
  });
});

describe("mountSearchView - search input debounce", () => {

  test("typing in the search input dispatches filter:changed after 300ms debounce", async () => {

    using dom = createTestDom();

    const { root, store } = setup();
    const input = root.querySelector("#searchInput");

    input.value = "motion";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    assert.equal(store.state.filter.query, "", "no immediate dispatch - debouncing");

    await waitFor(() => store.state.filter.query === "motion", { timeout: 1000 });

    assert.equal(store.state.filter.query, "motion");
  });
});

describe("mountSearchView - following the table's presentation", () => {

  // The panel filters the option table, so it follows the table's presentation rather than deciding its own. These drive the store through the transitions that move
  // that presentation and assert the two bars track it.
  const barsHidden = (root) => [...root.children].every((child) => child.classList.contains("d-none"));

  const clickController = (store, { controllerId = "ctrl-a", devices = [], error = "" } = {}) => {

    store.dispatch({ scope: { controllerId, kind: "controller" }, type: "scope:changed" });
    store.dispatch({ controllerId, type: "devices:requested" });
    store.dispatch({ controllerId, devices, error, seq: store.state.devicesRequest.seq, type: "devices:loaded" });
  };

  test("both panel bars are shown on a healthy page", () => {

    using dom = createTestDom();

    const { root } = setup();

    assert.equal(root.children.length, 2, "precondition: the panel has exactly its two top-level bars");
    assert.equal(barsHidden(root), false, "neither bar is hidden while the option table is what the surface shows");
  });

  test("both panel bars hide while a connection error stands", () => {

    using dom = createTestDom();

    const { root, store } = setup();

    clickController(store, { error: "Controller unreachable." });

    assert.equal(barsHidden(root), true, "a search box over no table, and counts describing rows nobody can see, are both withdrawn");
  });

  test("both panel bars return when a clean outcome recovers the page", () => {

    using dom = createTestDom();

    const { root, store } = setup();
    const before = [...root.children];

    clickController(store, { error: "Controller unreachable." });
    clickController(store, { controllerId: "ctrl-b", devices: [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "D", serialNumber: "dev-a" }] });

    const after = [...root.children];

    assert.equal(barsHidden(root), false, "the bars are shown again");
    assert.equal(after.length, before.length, "the same number of bars comes back");
    assert.ok(after.every((child, index) => child === before[index]), "and they are the same elements - hidden, never rebuilt, so the search box keeps its identity");
  });

  test("both panel bars hide over a nothing-to-list notice, and return when the controller reports devices", () => {

    using dom = createTestDom();

    const { root, store } = setup();

    store.dispatch({ scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });
    store.dispatch({ controllerId: "ctrl-a", type: "devices:requested" });
    store.dispatch({

      controllerId: "ctrl-a",
      devices: [],
      emptyMessage: "This controller has no cameras adopted.",
      error: "",
      seq: store.state.devicesRequest.seq,
      type: "devices:loaded"
    });

    assert.equal(barsHidden(root), true, "there is no table to search, so the panel withdraws");

    clickController(store, { devices: [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "D", serialNumber: "dev-a" }] });

    assert.equal(barsHidden(root), false, "and returns with the table");
  });

  test("an empty outcome with no message withdraws the panel too, since the framework's own notice holds the surface", () => {

    using dom = createTestDom();

    const { root, store } = setup();

    clickController(store);

    assert.equal(barsHidden(root), true, "the panel follows the presentation, and a notice is a notice whoever supplied its words");
  });
});
