/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/deviceInfo.test.mjs: Unit tests for the device-info view.
 */
"use strict";

import { defaultInfoPanel, mountDeviceInfoView } from "./deviceInfo.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { createTestDom } from "../../ui.helpers.mjs";

const CATALOG = {

  ...buildCatalogIndex([], {}),

  validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
};

const DEVICE = { firmwareRevision: "1.2.3", manufacturer: "Acme", model: "X100", name: "Device A", serialNumber: "dev-a" };

describe("defaultInfoPanel", () => {

  test("renders a four-column grid with firmware/serial/model/manufacturer for a populated device", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    defaultInfoPanel(root, DEVICE);

    const items = [...root.querySelectorAll(".stat-item")];

    assert.equal(items.length, 4);

    const labels = items.map((item) => item.querySelector(".stat-label")?.textContent);
    const values = items.map((item) => item.querySelector(".stat-value")?.textContent);

    assert.deepEqual(labels, [ "Firmware", "Serial Number", "Model", "Manufacturer" ]);
    assert.deepEqual(values, [ "1.2.3", "dev-a", "X100", "Acme" ]);
  });

  test("clears the container when no device is in scope", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    root.textContent = "stale";
    defaultInfoPanel(root, undefined);

    assert.equal(root.textContent, "");
  });

  test("renders N/A placeholders for missing fields", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    defaultInfoPanel(root, { name: "Bare", serialNumber: "bare-1" });

    const values = [...root.querySelectorAll(".stat-value")].map((s) => s.textContent);

    assert.deepEqual(values, [ "N/A", "bare-1", "N/A", "N/A" ]);
  });
});

describe("mountDeviceInfoView", () => {

  test("re-renders on scope:changed by calling the supplied infoPanel callback", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    document.body.appendChild(root);

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();
    const calls = [];

    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    store.dispatch({ devices: [DEVICE], type: "devices:loaded" });

    mountDeviceInfoView({

      infoPanel: (panel, device) => { calls.push(device?.serialNumber ?? null); panel.textContent = device?.name ?? ""; },
      root,
      signal: controller.signal,
      store
    });

    // The mount fired the initial render via the immediate-run pass.
    assert.deepEqual(calls, [null], "global scope at mount - no device");

    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.deepEqual(calls, [ null, "dev-a" ], "device scope after dispatch");
    assert.equal(root.textContent, "Device A");
  });

  test("falls back to defaultInfoPanel when no callback is supplied", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    document.body.appendChild(root);

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    store.dispatch({ devices: [DEVICE], type: "devices:loaded" });

    mountDeviceInfoView({ root, signal: controller.signal, store });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    const items = [...root.querySelectorAll(".stat-item")];

    assert.equal(items.length, 4, "default panel renders the four-cell grid");
  });

  test("does not reveal its own region - rendering the panel leaves the reveal to the orchestrator", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    document.body.appendChild(root);

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    // The orchestrator hides the device-stats region before populating it; the view must render into it without revealing the region itself. Region visibility is the
    // orchestrator's responsibility, so this asserts the view populates its region without flipping it visible.
    root.style.display = "none";
    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    store.dispatch({ devices: [DEVICE], type: "devices:loaded" });
    mountDeviceInfoView({ root, signal: controller.signal, store });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.ok(root.textContent.length > 0, "the view rendered the device stats");
    assert.equal(root.style.display, "none", "the view did not reveal its own region - reveal is the orchestrator's responsibility");

    controller.abort();
  });
});
