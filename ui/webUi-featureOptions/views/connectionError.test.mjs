/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/connectionError.test.mjs: Unit tests for the connection-error view.
 */
"use strict";

import { createTestDom, waitFor } from "../../ui.helpers.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { mountConnectionErrorView } from "./connectionError.mjs";

const CONTROLLERS = [

  { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" },
  { address: "10.0.0.2", name: "Controller B", serialNumber: "ctrl-b" }
];

// The catalog the seeding dispatches carry. This view renders from the status and resolves its controller from the scope, so it reads nothing out of the catalog - an
// empty index is here only because model:loaded refuses a missing one.
const CATALOG = () => buildCatalogIndex([], {});

// A plugin hook that records every bag it is handed and builds its content once per panel. That is the shape the contract documents: the panel is the same element on
// every error render of a mount, so a later render finds the content already in place rather than rebuilding it.
const recordingPanelHook = (bags) => (bag) => {

  bags.push(bag);

  if(!bag.panel.firstChild) {

    bag.panel.appendChild(document.createElement("form"));
  }
};

// Assembles one test's fixture: a fresh `FeatureOptionsStore`, a `root` element mounted in the document, and an `AbortController` whose signal drives
// `mountConnectionErrorView`'s lifecycle. `connectionErrorPanel`, `onRetry`, and `retryDelayMs` pass straight through to the mount, and supplying `controllers`
// seeds the store before mounting. Returns `{ abort, root, signal, store }` so a test can dispatch further actions, inspect the mounted DOM, and tie assertions to
// the same signal the view was mounted with.
const setup = ({ connectionErrorPanel, controllers, onRetry = () => {}, retryDelayMs = 50 } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const root = document.createElement("div");
  const controller = new AbortController();

  document.body.appendChild(root);

  // Seed the controller list ahead of the mount when a test needs one resolvable, the way the page does it: model:loaded carries the list the plugin's getControllers
  // hook produced, and a click moves the scope onto one of them separately.
  if(controllers) {

    store.dispatch({ catalog: CATALOG(), configuredOptions: [], controllers, mode: "controller-based", type: "model:loaded" });
  }

  mountConnectionErrorView({ connectionErrorPanel, onRetry, retryDelayMs, root, signal: controller.signal, store });

  return { abort: () => controller.abort(), root, signal: controller.signal, store };
};

describe("mountConnectionErrorView - inactive state", () => {

  test("does not render anything before a connection:error dispatch", () => {

    using _dom = createTestDom();

    const { root } = setup();

    assert.equal(root.textContent, "");
  });
});

describe("mountConnectionErrorView - error rendering", () => {

  test("renders the error block with the message from state.status.message", () => {

    using _dom = createTestDom();

    const { root, store } = setup();

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Controller unreachable.", type: "connection:error" });

    assert.match(root.textContent, /Unable to connect to the controller/);
    assert.match(root.textContent, /Controller unreachable\./);
    assert.ok(root.querySelector("button"), "retry button rendered");
    assert.equal(root.querySelector("button").disabled, true, "retry button starts disabled");
    assert.ok(root.querySelector(".progress-bar"), "progress bar rendered");
  });

  test("the retry button enables after the configured delay", async () => {

    using _dom = createTestDom();

    const { root, store } = setup({ retryDelayMs: 30 });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.", message: "down",
      type: "connection:error" });

    await waitFor(() => root.querySelector("button")?.disabled === false, { message: "retry button to enable", timeout: 500 });

    assert.equal(root.querySelector("button").disabled, false);
    assert.equal(root.querySelector(".progress"), null, "progress bar removed once retry is armed");
  });

  test("clicking the armed retry button invokes the onRetry callback", async () => {

    using _dom = createTestDom();

    let retryFired = false;
    const onRetry = async () => { retryFired = true; };
    const { root, store } = setup({ onRetry, retryDelayMs: 20 });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.", message: "down",
      type: "connection:error" });

    const retryBtn = await waitFor(() => {

      const btn = root.querySelector("button");

      return (btn && !btn.disabled) ? btn : null;
    }, { message: "armed retry button", timeout: 500 });

    retryBtn.click();

    assert.equal(retryFired, true);
    assert.match(retryBtn.textContent, /Retrying/);
  });
});

describe("mountConnectionErrorView - plugin slot", () => {

  test("an error render with no hook configured builds no slot at all", () => {

    using _dom = createTestDom();

    const { root, store } = setup();

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Controller unreachable.", type: "connection:error" });

    assert.equal(root.children.length, 1, "the root carries the framework's error block and nothing else");
  });

  test("the hook receives an attached, empty panel docked after the error block, carrying the mount's own signal", () => {

    using _dom = createTestDom();

    const bags = [];

    // Where the panel sits is read inside the hook rather than after the dispatch, because the contract is about the state the hook is handed: docking the panel
    // after the call would leave every post-dispatch assertion true and the promise of an attached panel untested.
    const placementAtCall = [];
    const connectionErrorPanel = (bag) => {

      bags.push(bag);
      placementAtCall.push({ connected: bag.panel.isConnected, previousSibling: bag.panel.previousElementSibling });
    };

    const { root, signal, store } = setup({ connectionErrorPanel });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Controller unreachable.", type: "connection:error" });

    assert.equal(bags.length, 1, "the error render invoked the hook");

    const [bag] = bags;

    assert.deepEqual(Object.keys(bag).toSorted(), [ "controller", "panel", "signal" ], "the bag carries exactly controller, panel, and signal");
    assert.equal(placementAtCall[0].connected, true, "the panel is already attached when the hook is called");
    assert.ok(placementAtCall[0].previousSibling === root.firstElementChild, "and already sits after the framework's error block");
    assert.equal(root.children.length, 2, "the root carries the error block and the slot");
    assert.ok(bag.panel === root.lastElementChild, "the slot is docked after the framework's error block");
    assert.equal(bag.panel.childNodes.length, 0, "the framework writes nothing into the panel - the plugin owns its content entirely");
    assert.ok(bag.signal === signal, "the bag's signal is the mount's lifecycle signal");
    assert.equal(bag.controller, null, "a config-sync failure has no controller in scope, so the bag's controller is null");
  });

  test("the bag carries the selected controller entry when a controller fetch fails", () => {

    using _dom = createTestDom();

    const bags = [];
    const { store } = setup({ connectionErrorPanel: (bag) => bags.push(bag), controllers: CONTROLLERS });

    // The page's own sequence for a sidebar controller click whose fetch fails: the scope moves onto the clicked controller first, then the outcome lands through
    // the request/outcome pairing the reducer gates, and its non-empty error is what the reducer folds into connection-error status.
    store.dispatch({ scope: { controllerId: "ctrl-b", kind: "controller" }, type: "scope:changed" });
    store.dispatch({ controllerId: "ctrl-b", type: "devices:requested" });
    store.dispatch({ controllerId: "ctrl-b", devices: [], error: "Controller unreachable.", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    assert.equal(bags.length, 1, "the folded fetch failure rendered the error and invoked the hook");
    assert.ok(bags[0].controller === CONTROLLERS[1], "the bag carries the entry the plugin's getControllers hook produced");
  });

  test("a second error render in one mount reuses the same panel and signal, keeping the plugin's content", () => {

    using _dom = createTestDom();

    const bags = [];
    const { root, store } = setup({ connectionErrorPanel: recordingPanelHook(bags) });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Controller unreachable.", type: "connection:error" });
    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Still unreachable.", type: "connection:error" });

    assert.equal(bags.length, 2, "each genuine status transition is an error render, and each render invokes the hook");
    assert.ok(bags[1].panel === bags[0].panel, "the panel is one identity for the mount's life");
    assert.ok(bags[1].signal === bags[0].signal, "and so is the signal a hook keys its once-ness on");
    assert.ok(bags[1].panel.querySelector("form"), "the plugin's content survived the error re-render");
    assert.ok(root.lastElementChild === bags[0].panel, "the rebuilt error block leaves the slot docked after it");
    assert.match(root.textContent, /Still unreachable\./, "the second render replaced the framework's error copy");
  });

  test("an error render after a yield re-docks the same panel with its content intact", () => {

    using _dom = createTestDom();

    const bags = [];
    const { root, store } = setup({ connectionErrorPanel: recordingPanelHook(bags) });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Controller unreachable.", type: "connection:error" });

    const [firstBag] = bags;

    // The status leaves connection-error and this view yields. In the page the header view reclaims the shared container with its own replaceChildren, which is what
    // detaches the slot; this suite mounts the error view alone, so the reclaim is reproduced directly.
    store.dispatch({ catalog: CATALOG(), configuredOptions: [], controllers: [], mode: "controller-based", type: "model:loaded" });
    root.replaceChildren();

    assert.equal(bags.length, 1, "a yield is not an error render, so the hook does not fire");
    assert.equal(firstBag.panel.isConnected, false, "the reclaimed container leaves the slot detached");

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Unreachable again.", type: "connection:error" });

    assert.equal(bags.length, 2, "the later failure renders the error again and re-invokes the hook");
    assert.ok(bags[1].panel === firstBag.panel, "the mount reattaches its own panel rather than minting a new one");
    assert.ok(bags[1].panel.querySelector("form"), "the plugin's content survived the detach");
    assert.ok(root.lastElementChild === firstBag.panel, "and the reattached slot sits after the fresh error block");
  });
});

describe("mountConnectionErrorView - lifecycle", () => {

  test("aborting the page signal mid-arm cancels the retry window", async () => {

    using _dom = createTestDom();

    const { abort, root, store } = setup({ retryDelayMs: 500 });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.", message: "down",
      type: "connection:error" });

    abort();

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(root.querySelector("button")?.disabled, true, "retry button never armed because the parent signal aborted");
  });
});
