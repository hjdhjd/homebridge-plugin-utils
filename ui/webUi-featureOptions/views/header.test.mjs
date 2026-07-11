/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/header.test.mjs: Unit tests for the priority-chain header view.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { createTestDom } from "../../ui.helpers.mjs";
import { mountHeaderView } from "./header.mjs";

const CATALOG = {

  ...buildCatalogIndex([], {}),

  validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
};

const setup = ({ mode = "device-only" } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const root = document.createElement("div");
  const controller = new AbortController();

  document.body.appendChild(root);
  store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode, type: "model:loaded" });
  mountHeaderView({ root, signal: controller.signal, store });

  return { abort: () => controller.abort(), root, store };
};

describe("mountHeaderView", () => {

  test("renders the precedence chain with the controller hop in controller-based mode", () => {

    using _dom = createTestDom();

    const { root } = setup({ mode: "controller-based" });

    assert.match(root.textContent, /Global options/);
    assert.match(root.textContent, /Controller options/);
    assert.match(root.textContent, /Device options/);
  });

  test("omits the controller hop in device-only mode", () => {

    using _dom = createTestDom();

    const { root } = setup({ mode: "device-only" });

    assert.match(root.textContent, /Global options/);
    assert.doesNotMatch(root.textContent, /Controller options/);
    assert.match(root.textContent, /Device options/);
  });

  test("yields the header when a connection:error transitions the status", () => {

    using _dom = createTestDom();

    const { root, store } = setup({ mode: "controller-based" });

    // Initial state shows the precedence chain.
    assert.match(root.textContent, /Global options/);

    store.dispatch({ message: "down", type: "connection:error" });

    // The header view does NOT clear the root on connection:error (the connection-error view owns the root in that state). The header content stays until the
    // connection-error view replaces it. Verify the header view at least does not re-render on the connection:error dispatch.
    assert.match(root.textContent, /Global options/, "header content not re-rendered on connection:error");
  });

  test("does not reveal its own region - it builds content but leaves the reveal to the orchestrator", () => {

    using _dom = createTestDom();

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const root = document.createElement("div");
    const controller = new AbortController();

    document.body.appendChild(root);

    // A view must never reveal its own region on mount; the orchestrator alone reveals regions, together, at the end of show(). Re-adding
    // `root.style.display = ""` here would violate that rule and fail this assertion.
    root.style.display = "none";
    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "controller-based", type: "model:loaded" });
    mountHeaderView({ root, signal: controller.signal, store });

    assert.match(root.textContent, /Global options/, "the view rendered its content on the model:loaded immediate-run");
    assert.equal(root.style.display, "none", "the view did not reveal its own region - reveal is the orchestrator's responsibility");

    controller.abort();
  });
});
