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

const setup = ({ controllers = CONTROLLERS, devices = [], host = { request: async () => "" }, getDevices, mode = "controller-based" } = {}) => {

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
    host,
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

      return fetchedDevices;
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

  test("clicking a controller whose getDevices returns empty dispatches connection:error", async () => {

    using _dom = createTestDom();

    const getDevices = async () => [];
    const host = { request: async () => "Controller unreachable." };
    const { rootControllers, store } = setup({ getDevices, host });
    const ctrlLink = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']");

    ctrlLink.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.state.status.kind, "connection-error");
    assert.equal(store.state.status.message, "Controller unreachable.");
  });
});
