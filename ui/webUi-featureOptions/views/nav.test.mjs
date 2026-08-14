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
import { createElement } from "../utils.mjs";
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

// The deadline the view applies to a click's device fetch. The orchestrator owns the value in production; the suite supplies its own so a hang test can name a bound it
// can advance a mock clock past without the other tests waiting on a production-sized one.
const setup = ({ controllers = CONTROLLERS, deadlineSeconds = 30, deviceContent, devices = [], getDevices, globalGlyph, mode = "controller-based", onReenter,
  refresh } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const rootControllers = document.createElement("div");
  const rootDevices = document.createElement("div");
  const controller = new AbortController();

  document.body.append(rootControllers, rootDevices);
  store.dispatch({ catalog: CATALOG(), configuredOptions: [], controllers, mode, type: "model:loaded" });

  if(devices.length > 0) {

    // Land the devices through the request/outcome pairing the reducer guards: mint the fetch sequence, then apply the outcome stamped with it.
    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
  }

  mountNavView({

    deadlineSeconds,
    deviceContent,
    getDevices,
    globalGlyph,
    labelControllers: "Controllers",
    labelDevices: "Devices",
    onReenter,
    refresh,
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

  test("outlines the controller whose device list loaded, even when that list came back empty", () => {

    /* The in-scope outline marks which controller the loaded device list belongs to, so the user can still tell what the sidebar is showing while the selection sits
     * on Global. `devices:loaded` is the only transition that records that controller, and a fetch resolving no devices moves nothing else - the selection does not
     * move and the devices container rebuilds to nothing - so this is the case where the repaint has to come from the highlighting effect's own subscription.
     */
    using _dom = createTestDom();

    const { rootControllers, store } = setup();

    store.dispatch({ controllerId: "ctrl-a", type: "devices:requested" });
    store.dispatch({ controllerId: "ctrl-a", devices: [], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    const entryA = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']");
    const entryB = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-b']");

    assert.equal(entryA.classList.contains("context"), true, "the controller the empty device list belongs to carries the outline");
    assert.equal(entryA.classList.contains("active"), false, "and it is not the active selection - the scope is still Global");
    assert.equal(entryB.classList.contains("context"), false, "the other controller carries nothing");
    assert.equal(rootControllers.querySelector(".nav-link[data-navigation='global']").classList.contains("active"), true, "Global stays the active entry");
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

  test("renders a device link's content through the deviceContent hook, falling through to the name on null", () => {

    using _dom = createTestDom();

    // The hook adorns one device and declines the other, which is the contract's whole shape in one build: a returned node replaces the name as the link's
    // content, a null return leaves the default name rendering, and the link element itself - identity attributes and navigation - is untouched either way.
    const deviceContent = (device) => {

      if(device.serialNumber !== "dev-a") {

        return null;
      }

      const content = document.createElement("span");

      content.className = "adorned";
      content.textContent = "custom " + device.name;

      return content;
    };

    const { rootDevices } = setup({ deviceContent, devices: DEVICES });
    const links = [...rootDevices.querySelectorAll(".nav-link[data-navigation]")];

    assert.equal(links[0].querySelector(".adorned")?.textContent, "custom Device A", "the hook's node renders as the link's content");
    assert.equal(links[0].getAttribute("data-device-serial"), "dev-a", "the framework still owns the link's identity attributes");
    assert.equal(links[1].querySelector(".adorned"), null, "a declined device carries no adornment");
    assert.equal(links[1].textContent, "Device B", "a null return falls through to the default name rendering");
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

  test("clicking a controller whose getDevices throws a non-Error routes the stringified value to the connection-error message", async () => {

    using _dom = createTestDom();

    // A rejection that is not an Error instance (a thrown string) exercises the shared errorMessage fallback: with no `.message` on the thrown value, the user-facing
    // message is the string coercion of the value itself.
    const getDevices = async () => { throw "kaboom"; };
    const { rootControllers, store } = setup({ getDevices });
    const ctrlLink = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']");

    ctrlLink.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.state.status.kind, "connection-error");
    assert.equal(store.state.status.message, "kaboom");
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

    // Resolve the newest click (ctrl-b) first: it renders. Then resolve the superseded click (ctrl-a): the reducer drops it on the resolve path because its sequence
    // no longer answers the pending request.
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

    // The newest click (ctrl-b) renders; then the superseded click (ctrl-a) rejects. The reducer drops it on the reject path because its sequence no longer answers
    // the pending request, so no stale connection:error lands over the newest click's state.
    gates.get("ctrl-b").resolve({ devices: [DEVICES[1]], error: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gates.get("ctrl-a").reject(new Error("ctrl-a failed late"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.state.status.kind, "ready", "the stale reject must not transition the store to connection-error");
    assert.deepEqual(store.state.devices, [DEVICES[1]], "the newest click's devices must remain");
    assert.equal(store.state.scope.controllerId, "ctrl-b", "the newest click's scope must remain");
  });

  test("a same-controller re-click resolves last-request-wins - the newest click's outcome owns the store even for the same controller", async () => {

    using _dom = createTestDom();

    // Two clicks on the SAME controller, each handed a controllable deferred. The reducer's fetch sequence owns this race: the second click supersedes the first
    // even though both target ctrl-a, which a controllerId-keyed guard could not tell apart.
    const deferreds = [];
    const getDevices = () => {

      const deferred = Promise.withResolvers();

      deferreds.push(deferred);

      return deferred.promise;
    };
    const { rootControllers, store } = setup({ getDevices });
    const ctrlLink = rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']");

    ctrlLink.click();
    ctrlLink.click();

    // Resolve the FIRST click last so its outcome is the stale one. The second click's outcome applies; the first click's must drop at the reducer.
    deferreds[1].resolve({ devices: [DEVICES[1]], error: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deferreds[0].resolve({ devices: [DEVICES[0]], error: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(store.state.devices, [DEVICES[1]], "only the newest same-controller click's devices may land");
    assert.equal(store.state.scope.deviceId, "dev-b", "the newest click settled to its controller-as-device scope");
  });

  test("a failed controller click renders the error view AND clears the stale device list", async () => {

    using _dom = createTestDom();

    // The reject path routes through devices:loaded with an empty list, so the reducer clears the stale devices as it moves to connection-error, rather than leaving
    // them lingering under the error view. Seed a device list first so the clear is observable.
    const getDevices = async () => { throw new Error("Controller unreachable."); };
    const { rootControllers, store } = setup({ devices: DEVICES, getDevices });

    assert.deepEqual(store.state.devices, DEVICES, "pre-condition: the sidebar shows a device list");

    rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']").click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.state.status.kind, "connection-error", "the failed click renders the connection-error view");
    assert.equal(store.state.status.message, "Controller unreachable.", "the rejection message reaches the connection-error status");
    assert.deepEqual(store.state.devices, [], "the stale device list is cleared by the reject path's empty-devices outcome");
  });

  test("a controller click whose fetch never answers lands the connection-error view on its deadline, exactly as a rejection does", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    // The plugin's device hook rides the same bridge every other host call does, so a click against a dead relay would otherwise leave the sidebar highlighted on a
    // controller whose devices never arrive. The bound turns that silence into the same outcome the reject path already produces.
    const getDevices = () => new Promise(() => {});
    const { rootControllers, store } = setup({ deadlineSeconds: 30, devices: DEVICES, getDevices });

    assert.deepEqual(store.state.devices, DEVICES, "pre-condition: the sidebar shows a device list");

    rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']").click();

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.state.status.kind, "ready", "before the bound elapses the click is simply still in flight");

    t.mock.timers.tick(30001);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(store.state.status.kind, "connection-error", "the elapsed bound renders the connection-error view");
    assert.match(store.state.status.message, /did not complete within 30 seconds/, "the expiry's own message reaches the view");
    assert.deepEqual(store.state.devices, [], "the stale device list is cleared by the expiry's empty-devices outcome, exactly as the reject path clears it");
  });

  test("a controller click superseded before its deadline dispatches nothing - the torn-down page is never written to", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const getDevices = () => new Promise(() => {});
    const { abort, rootControllers, store } = setup({ deadlineSeconds: 30, devices: DEVICES, getDevices });

    rootControllers.querySelector(".nav-link[data-device-serial='ctrl-a']").click();
    await new Promise((resolve) => setImmediate(resolve));

    // The page tears down while the click's fetch is still in flight. Its bounded await settles at once on the abort, and the handler's teardown bail keeps that
    // settlement from reaching a store the page no longer owns.
    abort();

    t.mock.timers.tick(30001);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(store.state.status.kind, "ready", "a torn-down page must not be written to by its own in-flight click");
    assert.deepEqual(store.state.devices, DEVICES, "and the device list it was rendering is left exactly as it was");
  });

  test("a devices:loaded dispatched against a store with no pending request drops (the reducer's null-check guard)", async () => {

    using _dom = createTestDom();

    // The setup's fetch pairing already cleared the pending slot (devicesRequest is null). A stray seq-1 outcome must drop rather than overwrite the rendered
    // list - the reducer's explicit null check, not an optional-chained comparison, is what makes a seq-less-against-null outcome vanish here.
    const { store } = setup({ devices: DEVICES });
    const beforeDevices = store.state.devices;

    store.dispatch({ controllerId: "ctrl-a", devices: [], error: "", seq: 1, type: "devices:loaded" });

    assert.equal(store.state.devices, beforeDevices, "the outcome drops against a null pending request, leaving the device list untouched");
  });
});

describe("mountNavView - the heading refresh action", () => {

  // The action docks on the mode's primary list heading, so each mode's assertions read it off the container that heading belongs to.
  const actionIn = (root) => root.querySelector("h6.nav-header button.fo-action");

  test("docks on the controllers heading in controller-based mode, carrying the label as its accessible name", () => {

    using _dom = createTestDom();

    const { rootControllers, rootDevices } = setup({ devices: DEVICES, refresh: { label: "Refresh controllers", onRefresh: () => {} } });
    const button = actionIn(rootControllers);

    assert.ok(button, "the controllers heading carries the action");
    assert.equal(button.getAttribute("aria-label"), "Refresh controllers", "the plugin's label is what a screen reader announces");
    assert.equal(button.getAttribute("title"), "Refresh controllers", "and what a hover reveals");
    assert.equal(button.type, "button", "the control submits nothing");
    assert.equal(button.classList.contains("btn-xs"), true, "it takes its geometry from the shared extra-small button class");
    assert.equal(button.classList.contains("ms-auto"), true, "and pins to the heading's trailing edge, which is what makes wrapping impossible at any width");
    assert.equal(actionIn(rootDevices), null, "and the devices heading carries none, since it is not the primary list in this mode");
  });

  test("the glyph is drawn at text scale in the current color and hidden from the accessibility tree", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup({ refresh: { onRefresh: () => {} } });
    const svg = actionIn(rootControllers).querySelector("svg");

    assert.ok(svg, "the button carries a drawn glyph rather than a text character");
    assert.equal(svg.getAttribute("height"), "1em", "sized to the type around it");
    assert.equal(svg.getAttribute("stroke"), "currentColor", "and stroked in whatever color the heading is wearing");
    assert.equal(svg.getAttribute("aria-hidden"), "true", "the button's own label speaks for it, so the drawing stays out of the accessibility tree");
  });

  test("defaults its label when the plugin supplies only a handler", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup({ refresh: { onRefresh: () => {} } });

    assert.equal(actionIn(rootControllers).getAttribute("aria-label"), "Refresh", "the framework's own word for the action stands in");
  });

  test("docks on the devices heading in device-only mode", () => {

    using _dom = createTestDom();

    const { rootControllers, rootDevices } = setup({ devices: DEVICES, mode: "device-only", refresh: { onRefresh: () => {} } });

    assert.ok(actionIn(rootDevices), "the top-level devices heading is the primary list where there are no controllers");
    assert.equal(actionIn(rootControllers), null, "and the controllers container heads nothing in this mode");
  });

  test("a fully-grouped device-only list has no heading to dock on, so no action renders", () => {

    using _dom = createTestDom();

    // Every device carries a group, so appendSection suppresses the top-level heading - and the action goes with it rather than finding another home.
    const grouped = DEVICES.map((device) => ({ ...device, sidebarGroup: "Cameras" }));
    const { rootDevices } = setup({ devices: grouped, mode: "device-only", refresh: { onRefresh: () => {} } });

    assert.ok(rootDevices.querySelector("h6.nav-header"), "precondition: the group heading rendered");
    assert.equal(actionIn(rootDevices), null, "but no action docked, because the heading it docks on is the top-level one");
  });

  test("a docked heading is a flex row, so the action's placement is the layout's business rather than the label's length", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup({ devices: DEVICES, refresh: { onRefresh: () => {} } });
    const heading = rootControllers.querySelector("h6.nav-header");

    assert.equal(heading.classList.contains("d-flex"), true, "the docked heading lays its label and action out as a row");
    assert.equal(heading.classList.contains("align-items-center"), true, "with the two centered against each other");
    assert.equal(heading.firstElementChild.tagName, "SPAN", "the label leads");
    assert.equal(heading.lastElementChild, actionIn(rootControllers), "and the action trails it");
  });

  test("an unconfigured sidebar leaves the heading exactly as it was", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup({ devices: DEVICES });
    const heading = rootControllers.querySelector("h6.nav-header");

    assert.equal(heading.querySelector("button"), null, "no action renders");
    assert.equal(heading.innerHTML, "Controllers", "and the heading carries its label as bare text, with no wrapper introduced for an action that is not there");
  });

  test("a click invalidates through the plugin, then re-enters through the framework, in that order", async () => {

    using _dom = createTestDom();

    const gate = Promise.withResolvers();
    const order = [];
    const { rootControllers } = setup({

      onReenter: (...args) => {

        order.push({ args, step: "reenter" });
      },
      refresh: { onRefresh: () => {

        order.push({ step: "refresh" });

        return gate.promise;
      } }
    });

    const button = actionIn(rootControllers);

    button.click();

    assert.deepEqual(order.map((entry) => entry.step), ["refresh"], "the click reached the plugin's handler first");
    assert.equal(button.disabled, true, "and the control refuses a second request while the invalidation is in flight");

    gate.resolve();
    await gate.promise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(order.map((entry) => entry.step), [ "refresh", "reenter" ], "the framework's re-entry follows the plugin's invalidation, never precedes it");
    assert.deepEqual(order[1].args, [], "the re-entry is called with nothing - the view asks for a re-show, it does not describe one");
    assert.equal(button.disabled, true, "and the control stays disabled into the rebuild that replaces it");
  });

  test("a view standing alone with no re-entry composed returns its control rather than stranding it disabled", async () => {

    using _dom = createTestDom();

    const { rootControllers } = setup({ refresh: { onRefresh: () => {} } });
    const button = actionIn(rootControllers);

    button.click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(button.disabled, false, "with no rebuild coming, the button that survives has to be usable");
  });

  test("a rejected refresh surfaces through the error toast and re-enables the control", async () => {

    using _dom = createTestDom();

    const toasts = [];

    globalThis.homebridge = { toast: { error: (message, title) => toasts.push({ message, title }) } };

    try {

      let reenters = 0;
      const { rootControllers } = setup({

        onReenter: () => {

          reenters += 1;
        },
        refresh: { onRefresh: () => Promise.reject(new Error("the plugin could not reach its API")) }
      });

      const button = actionIn(rootControllers);

      button.click();
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(toasts, [{ message: "the plugin could not reach its API", title: "Error" }], "the failure reaches the user rather than the console alone");
      assert.equal(reenters, 0, "and the page does not re-enter: a failed invalidation must never present as refreshed");
      assert.equal(button.disabled, false, "the control comes back so the user can try again");
    } finally {

      delete globalThis.homebridge;
    }
  });

  test("a click on the action moves no scope - it is inert to the navigation delegation", () => {

    using _dom = createTestDom();

    const { rootControllers, store } = setup({ refresh: { onRefresh: () => {} } });
    const before = store.state.scope;

    actionIn(rootControllers).click();

    assert.equal(store.state.scope, before, "the button carries no navigation marker, so the delegated handler passes over it");
  });
});

describe("mountNavView - the Global Options row", () => {

  const globalIn = (root) => root.querySelector("[data-navigation='global']");

  test("renders as a navigable row rather than a heading, wearing no header costume", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup();
    const row = globalIn(rootControllers);

    assert.equal(row.classList.contains("nav-link"), true, "it carries the row anatomy every other entry carries");
    assert.equal(row.getAttribute("role"), "button", "and the same accessibility shape");

    for(const costume of [ "fw-bold", "nav-header", "text-uppercase" ]) {

      assert.equal(row.classList.contains(costume), false, "a row that reads as a title is the confusion this drops: " + costume);
    }

    assert.equal(row.hasAttribute("data-device-serial"), false, "a scope has no serial, so the attribute is absent rather than empty");
  });

  test("carries the framework's globe at text scale, drawn in the row's own color", () => {

    using _dom = createTestDom();

    const { rootControllers } = setup();
    const svg = globalIn(rootControllers).querySelector("svg");

    assert.ok(svg, "the row leads with a drawn kind glyph");
    assert.equal(svg.getAttribute("height"), "1em", "sized to the row's type");
    assert.equal(svg.getAttribute("stroke"), "currentColor", "and colored by the row, which is what carries it through hover and the selected state");
    assert.equal(svg.getAttribute("aria-hidden"), "true", "the row's label names the scope, so the glyph stays out of the accessibility tree");
    assert.match(globalIn(rootControllers).textContent, /Global Options/, "the label reads beside it");
  });

  test("a configured globalGlyph replaces the globe and is invoked once per sidebar build", () => {

    using _dom = createTestDom();

    let calls = 0;
    const globalGlyph = () => {

      calls += 1;

      // A fresh node per call is the contract: one stored node would be adopted into the page by the first build and missing from the second.
      return createElement("i", { classList: ["plugin-glyph"] });
    };

    const { rootControllers, store } = setup({ globalGlyph });

    assert.equal(calls, 1, "the hook ran for the first build");
    assert.ok(globalIn(rootControllers).querySelector("i.plugin-glyph"), "and its node is what the row leads with");
    assert.equal(globalIn(rootControllers).querySelector("svg"), null, "the framework's globe gives way to it entirely");

    // A controllers refresh rebuilds the container, which is the rebuild a stored node would not survive.
    store.dispatch({ controllers: CONTROLLERS, type: "controllers:loaded" });

    assert.equal(calls, 2, "the hook ran again for the rebuild rather than a node being reused");
    assert.ok(globalIn(rootControllers).querySelector("i.plugin-glyph"), "and the rebuilt row carries a glyph again");
  });

  test("the selected state still lands on the row at global scope", () => {

    using _dom = createTestDom();

    const { rootControllers, store } = setup();

    assert.equal(globalIn(rootControllers).classList.contains("active"), true, "global scope activates the row at first render");

    store.dispatch({ scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.equal(globalIn(rootControllers).classList.contains("active"), false, "and moving the scope off global deactivates it");
  });
});
