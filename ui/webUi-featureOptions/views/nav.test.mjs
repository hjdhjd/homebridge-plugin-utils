/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/nav.test.mjs: Unit tests for the sidebar navigation view.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { createTestDom } from "../../ui.helpers.mjs";
import { mountNavView } from "./nav.mjs";

const CATALOG = (isController = () => false) => ({

  ...buildCatalogIndex([], {}),
  validators: { isController, validOption: () => true, validOptionCategory: () => true }
});

const CONTROLLERS = [

  { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" },
  { address: "10.0.0.2", name: "Controller B", serialNumber: "ctrl-b" }
];

const DEVICES = [

  { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" },
  { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device B", serialNumber: "dev-b" }
];

const setup = ({ controllers = CONTROLLERS, devices = [], getDevices, mode = "controller-based" } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const rootControllers = document.createElement("div");
  const rootDevices = document.createElement("div");
  const controller = new AbortController();

  document.body.append(rootControllers, rootDevices);
  store.dispatch({ catalog: CATALOG(), configuredOptions: [], controllers, mode, type: "model:loaded" });

  if(devices.length > 0) {

    store.dispatch({ devices, type: "devices:loaded" });
  }

  mountNavView({

    getDevices,
    labelControllers: "Controllers",
    labelDevices: "Devices",
    rootControllers,
    rootDevices,
    signal: controller.signal,
    store
  });

  return { abort: () => controller.abort(), rootControllers, rootDevices, store };
};

describe("mountNavView - controllers container", () => {

  test("renders Global Options link + controllers section in controller-based mode", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup();
    const links = [...rootControllers.querySelectorAll(".nav-link[data-navigation]")];

    assert.equal(links[0].getAttribute("data-navigation"), "global");
    assert.equal(links[1].getAttribute("data-navigation"), "controller");
    assert.equal(links[1].getAttribute("data-device-serial"), "ctrl-a");
    assert.equal(links[2].getAttribute("data-device-serial"), "ctrl-b");
  });

  test("renders only Global Options in device-only mode", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup({ mode: "device-only" });
    const links = [...rootControllers.querySelectorAll(".nav-link[data-navigation]")];

    assert.equal(links.length, 1);
    assert.equal(links[0].getAttribute("data-navigation"), "global");
  });

  test("highlights the Global Options link at initial render", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup();
    const globalLink = rootControllers.querySelector(".nav-link[data-navigation='global']");

    assert.equal(globalLink.classList.contains("active"), true);
  });
});

describe("mountNavView - devices container", () => {

  test("renders devices in order", () => {

    using _dom = createTestDom();

    const { rootDevices } = setup({ devices: DEVICES });
    const links = [...rootDevices.querySelectorAll(".nav-link[data-navigation]")];

    assert.equal(links.length, 2);
    assert.equal(links[0].getAttribute("data-device-serial"), "dev-a");
    assert.equal(links[1].getAttribute("data-device-serial"), "dev-b");
  });

  test("renders the device-label header when at least one device is ungrouped", () => {

    using _dom = createTestDom();

    // The fixture devices carry no sidebarGroup, so they form the ungrouped top-level section that the device label heads.
    const { rootDevices } = setup({ devices: DEVICES });
    const headers = [...rootDevices.querySelectorAll("h6")].map((header) => header.textContent);

    assert.deepEqual(headers, ["Devices"], "the top-level device label heads the ungrouped devices");
  });

  test("a fully-grouped device set emits no orphan top-level device header - only the group headers show", () => {

    using _dom = createTestDom();

    // Every device carries a sidebarGroup, so the ungrouped section is empty; the device-label header must be suppressed since a label is only ever emitted when it
    // heads a non-empty section.
    const grouped = [

      { ...DEVICES[0], sidebarGroup: "Cameras" },
      { ...DEVICES[1], sidebarGroup: "Cameras" }
    ];

    const { rootDevices } = setup({ devices: grouped });
    const headers = [...rootDevices.querySelectorAll("h6")].map((header) => header.textContent);

    assert.deepEqual(headers, ["Cameras"], "only the group header renders; the top-level device label is suppressed when no device is ungrouped");
    assert.equal(rootDevices.querySelectorAll(".nav-link[data-navigation='device']").length, 2, "both devices still render under their group");
  });

  test("groups devices by sidebarGroup; ungrouped first, then groups alphabetical", () => {

    using _dom = createTestDom();

    const grouped = [

      { ...DEVICES[0], sidebarGroup: undefined },
      { ...DEVICES[1], sidebarGroup: "Cameras" },
      { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device C", serialNumber: "dev-c", sidebarGroup: "Bridges" }
    ];

    const { rootDevices } = setup({ devices: grouped });
    const order = [...rootDevices.children].map((el) => el.textContent);

    // Expected: device label, dev-a (ungrouped), "Bridges" header, dev-c, "Cameras" header, dev-b.
    assert.equal(order.indexOf("Bridges") > order.indexOf("Device A"), true, "ungrouped before groups");
    assert.equal(order.indexOf("Bridges") < order.indexOf("Cameras"), true, "groups alphabetical");
  });

  test("excludes devices in the reserved 'hidden' group from grouped sections", () => {

    using _dom = createTestDom();

    const devices = [ ...DEVICES, { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Hidden", serialNumber: "hidden-1", sidebarGroup: "hidden" } ];
    const { rootDevices } = setup({ devices });

    assert.doesNotMatch(rootDevices.textContent, /Hidden/);
  });
});

describe("mountNavView - click dispatch", () => {

  test("clicking the Global Options link dispatches scope:changed with kind: global", () => {

    using _dom = createTestDom();

    const { rootControllers, store } = setup();
    const globalLink = rootControllers.querySelector(".nav-link[data-navigation='global']");

    // Move scope away from global so we can detect the dispatch.
    store.dispatch({ scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });
    assert.equal(store.state.scope.kind, "controller");

    globalLink.click();
    assert.equal(store.state.scope.kind, "global");
  });

  test("clicking a device link dispatches scope:changed with kind: device", () => {

    using _dom = createTestDom();

    const { rootDevices, store } = setup({ devices: DEVICES });
    const link = rootDevices.querySelector(".nav-link[data-device-serial='dev-b']");

    link.click();

    assert.deepEqual(store.state.scope, { controllerId: null, deviceId: "dev-b", kind: "device" });
  });

  test("clicking a controller link dispatches scope:changed and then fires getDevices", async () => {

    using _dom = createTestDom();

    const fetchedDevices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Ctrl-A Device 1", serialNumber: "ctrl-a-d1" }];
    let fetched;
    const getDevices = async (controller) => {

      fetched = controller;

      return { devices: fetchedDevices, error: "" };
    };
    const { rootControllers, store } = setup({ getDevices });
    const ctrlLink = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']");

    ctrlLink.click();

    // After the synchronous click, scope is controller-kind. The getDevices fetch is async; we wait for the next tick.
    assert.equal(store.state.scope.kind, "controller");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(fetched.serialNumber, "ctrl-a");
    assert.deepEqual(store.state.devices, fetchedDevices);
    assert.equal(store.state.scope.kind, "device", "scope moves to the controller-as-device entry");
  });

  test("clicking a controller whose getDevices carries an error dispatches connection:error with that message", async () => {

    using _dom = createTestDom();

    // The failure message travels back on the DeviceListResult, so the connection-error message is the carried error verbatim - no separate request is made.
    const getDevices = async () => ({ devices: [], error: "Controller unreachable." });
    const { rootControllers, store } = setup({ getDevices });
    const ctrlLink = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']");

    ctrlLink.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.state.status.kind, "connection-error");
    assert.equal(store.state.status.message, "Controller unreachable.");
  });

  test("clicking a controller whose getDevices throws a non-Error dispatches the generic connection:error message", async () => {

    using _dom = createTestDom();

    // A rejection that is not an Error instance (a thrown string) exercises the catch's fallback branch: the user-facing message is the generic sentence rather than
    // the raw thrown value.
    const getDevices = async () => { throw "kaboom"; };
    const { rootControllers, store } = setup({ getDevices });
    const ctrlLink = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']");

    ctrlLink.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.state.status.kind, "connection-error");
    assert.equal(store.state.status.message, "Failed to fetch devices.");
  });

  test("a superseded controller click's late resolve is discarded - the newest click owns the store", async () => {

    using _dom = createTestDom();

    // Two controller clicks whose fetches settle out of order. Each getDevices call hands back a controllable deferred keyed by the controller serial, so the test can
    // resolve the second (newest) click first and the first (superseded) click afterward.
    const gates = new Map();
    const getDevices = (controller) => {

      const deferred = Promise.withResolvers();

      gates.set(controller.serialNumber, deferred);

      return deferred.promise;
    };
    const { rootControllers, store } = setup({ getDevices });

    rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']").click();
    rootControllers.querySelector(".nav-link[data-device-serial='ctrl-b']").click();

    // Resolve the newest click (ctrl-b) first: it renders. Then resolve the superseded click (ctrl-a): the generation guard must discard it on the resolve path.
    gates.get("ctrl-b").resolve({ devices: [DEVICES[1]], error: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gates.get("ctrl-a").resolve({ devices: [DEVICES[0]], error: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(store.state.devices, [DEVICES[1]], "only the newest click's devices may land");
    assert.equal(store.state.devicesControllerId, "ctrl-b", "the devices belong to the newest click's controller");
    assert.equal(store.state.scope.kind, "device", "the newest click settled to its controller-as-device scope");
    assert.equal(store.state.scope.controllerId, "ctrl-b", "the settled scope belongs to the newest click");
  });

  test("a superseded controller click's late reject does not overwrite the newest click's rendered state", async () => {

    using _dom = createTestDom();

    const gates = new Map();
    const getDevices = (controller) => {

      const deferred = Promise.withResolvers();

      gates.set(controller.serialNumber, deferred);

      return deferred.promise;
    };
    const { rootControllers, store } = setup({ getDevices });

    rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']").click();
    rootControllers.querySelector(".nav-link[data-device-serial='ctrl-b']").click();

    // The newest click (ctrl-b) renders; then the superseded click (ctrl-a) rejects. The generation guard on the reject path must discard it so no stale
    // connection:error lands over the newest click's state.
    gates.get("ctrl-b").resolve({ devices: [DEVICES[1]], error: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gates.get("ctrl-a").reject(new Error("ctrl-a failed late"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.state.status.kind, "ready", "the stale reject must not transition the store to connection-error");
    assert.deepEqual(store.state.devices, [DEVICES[1]], "the newest click's devices must remain");
    assert.equal(store.state.scope.controllerId, "ctrl-b", "the newest click's scope must remain");
  });
});
