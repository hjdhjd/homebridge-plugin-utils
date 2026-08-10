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
const DEVICE_B = { firmwareRevision: "4.5.6", manufacturer: "Acme", model: "X200", name: "Device B", serialNumber: "dev-b" };

describe("defaultInfoPanel", () => {

  test("renders a four-column grid with firmware/serial/model/manufacturer for a populated device", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    defaultInfoPanel({ device: DEVICE, panel: root });

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
    defaultInfoPanel({ device: undefined, panel: root });

    assert.equal(root.textContent, "");
  });

  test("renders N/A placeholders for missing fields", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    defaultInfoPanel({ device: { name: "Bare", serialNumber: "bare-1" }, panel: root });

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
    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [DEVICE], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    mountDeviceInfoView({

      infoPanel: ({ device, panel }) => { calls.push(device?.serialNumber ?? null); panel.textContent = device?.name ?? ""; },
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
    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [DEVICE], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

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
    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [DEVICE], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    mountDeviceInfoView({ root, signal: controller.signal, store });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    assert.ok(root.textContent.length > 0, "the view rendered the device stats");
    assert.equal(root.style.display, "none", "the view did not reveal its own region - reveal is the orchestrator's responsibility");

    controller.abort();
  });

  test("hands every render of one mount the identical signal object while the per-render device tracks the selection", () => {

    using _dom = createTestDom();

    const root = document.createElement("div");

    document.body.appendChild(root);

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();
    const captured = [];

    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [ DEVICE, DEVICE_B ], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    // Capture each invocation's whole options bag rather than a projection of it, so both axes the bag splits are asserted against one record: `device` is per-render
    // data that moves with the selection, while `signal` is the mount's own identity and is the object a hook keys its once-ness on.
    mountDeviceInfoView({ infoPanel: (args) => { captured.push(args); }, root, signal: controller.signal, store });

    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-b", kind: "device" }, type: "scope:changed" });

    const serials = captured.map((call) => call.device?.serialNumber ?? null);

    assert.ok(captured.length >= 2, "the hook ran for the mount pass and for each scope change");
    assert.deepEqual(serials, [ null, "dev-a", "dev-b" ], "the per-render device moved with the selection across renders");

    const [ first, ...rest ] = captured;

    assert.ok(first.signal instanceof AbortSignal, "the mount hands the hook a signal");

    // Reference identity, not equivalence: a render path that minted a fresh signal per render (wrapping it in AbortSignal.any, say) would still deliver a signal
    // that aborts at the right moment, and would still break every hook that registers once by keying on this object.
    for(const call of rest) {

      assert.strictEqual(call.signal, first.signal, "every render of one mount receives the identical signal object");
    }

    controller.abort();
  });
});
