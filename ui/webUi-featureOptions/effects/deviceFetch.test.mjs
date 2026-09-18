/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/deviceFetch.test.mjs: Unit tests for the shared controller device fetch.
 */
"use strict";

import { completeControllerSelection, fetchControllerDevices } from "./deviceFetch.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { DeadlineExpiredError } from "../../webUi-liveness.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { createTestDom } from "../../ui.helpers.mjs";
import { mountConnectionErrorView } from "../views/connectionError.mjs";

const CONTROLLERS = [

  { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" },
  { address: "10.0.0.2", name: "Controller B", serialNumber: "ctrl-b" }
];

// The controller's own row is what `isController` names, so a clean fetch that brings it gives the controller a scoping identity and a selection to continue onto.
const DEVICES = [

  { name: "Controller A", serialNumber: "ctrl-a" },
  { name: "Camera", serialNumber: "cam-1" }
];

// The catalog every seeding dispatch carries. These functions read the validators and nothing else out of it, so the index itself is empty and present only because
// model:loaded refuses a missing catalog.
const catalog = () => ({

  ...buildCatalogIndex([], {}),

  validators: {

    isController: (device) => device.serialNumber.startsWith("ctrl-"),
    validOption: () => true,
    validOptionCategory: () => true
  }
});

// A store seeded the way the page seeds one: a loaded model carrying the controller list, with the scope moved onto the controller the fetch is about - which is
// the state a sidebar click and a coordinated write's reconciliation both leave behind before the fetch runs.
const setup = ({ controllerId = "ctrl-a" } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });

  store.dispatch({ catalog: catalog(), configuredOptions: [], controllers: CONTROLLERS, mode: "controller-based", type: "model:loaded" });

  if(controllerId !== null) {

    store.dispatch({ scope: { controllerId, kind: "controller" }, type: "scope:changed" });
  }

  return store;
};

describe("fetchControllerDevices", () => {

  test("resolves true for its own applied outcome and lands the device list", async () => {

    const store = setup();
    const seen = [];
    const applied = await fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      getDevices: (controller) => {

        seen.push(controller);

        return Promise.resolve({ devices: DEVICES, error: "" });
      },
      signal: new AbortController().signal,
      store
    });

    assert.equal(applied, true, "a clean outcome that applied is the one verdict that continues a selection");
    assert.deepEqual(seen, [CONTROLLERS[0]], "the hook receives the controller entry the store holds for that id");
    assert.deepEqual(store.state.devices, DEVICES, "and the list it brought is what the store carries");
    assert.equal(store.state.devicesControllerId, "ctrl-a", "recorded against the controller it belongs to");
  });

  test("hands the hook a null controller when the store holds no entry for the id", async () => {

    const store = setup({ controllerId: null });
    const seen = [];

    await fetchControllerDevices({

      controllerId: null,
      deadlineSeconds: 30,
      getDevices: (controller) => {

        seen.push(controller);

        return Promise.resolve({ devices: [], error: "" });
      },
      signal: new AbortController().signal,
      store
    });

    assert.deepEqual(seen, [null], "the device-only page's single list is fetched with no controller at all");
  });

  test("resolves false when a later request supersedes it", async () => {

    const store = setup();
    let release;
    const pending = fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      getDevices: () => new Promise((resolve) => { release = resolve; }),
      signal: new AbortController().signal,
      store
    });

    // A second request mints a newer sequence, which takes the pending slot. The first fetch's outcome then answers a request the store has stopped waiting for.
    const superseding = fetchControllerDevices({

      controllerId: "ctrl-b",
      deadlineSeconds: 30,
      getDevices: () => Promise.resolve({ devices: [], error: "" }),
      signal: new AbortController().signal,
      store
    });

    assert.equal(await superseding, true, "precondition: the newer request applied");

    release({ devices: DEVICES, error: "" });

    assert.equal(await pending, false, "a superseded outcome is not a list to continue into");
    assert.equal(store.state.devicesControllerId, "ctrl-b", "and the store still carries what the newer request brought");
  });

  test("resolves false on a reported failure and folds it into the connection-error transition", async () => {

    const store = setup();
    const applied = await fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      failureGuidance: "Open the controller editor on this page.",
      getDevices: () => Promise.resolve({ devices: [], error: "Controller unreachable." }),
      signal: new AbortController().signal,
      store
    });

    assert.equal(applied, false, "a reported failure is not a clean outcome however cleanly it arrived");
    assert.equal(store.state.status.kind, "connection-error", "the reducer folds it into the failure transition");
    assert.equal(store.state.status.message, "Controller unreachable.", "carrying what the plugin reported");
  });

  test("resolves false on a rejection and renders it through the same outcome channel", async () => {

    const store = setup();
    const applied = await fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      getDevices: () => Promise.reject(new Error("The bridge went away.")),
      signal: new AbortController().signal,
      store
    });

    assert.equal(applied, false, "a rejection never resolves true");
    assert.equal(store.state.status.kind, "connection-error", "it travels as an outcome rather than out of the call");
    assert.equal(store.state.status.message, "The bridge went away.", "with the rejection's own message");
    assert.deepEqual(store.state.devices, [], "and the stale list is cleared by the empty-devices outcome");
  });

  test("dispatches nothing after an abort, on either the resolve or the reject path", async () => {

    for(const shape of [ "resolve", "reject" ]) {

      const store = setup();
      const controller = new AbortController();
      let settle;
      const pending = fetchControllerDevices({

        controllerId: "ctrl-a",
        deadlineSeconds: 30,
        getDevices: () => new Promise((resolve, reject) => {

          settle = () => {

            if(shape === "resolve") {

              resolve({ devices: DEVICES, error: "" });

              return;
            }

            reject(new Error("The bridge went away."));
          };
        }),
        signal: controller.signal,
        store
      });
      const before = store.state;

      controller.abort();
      settle();

      // eslint-disable-next-line no-await-in-loop
      assert.equal(await pending, false, "a torn-down page's fetch reports no list to continue into (" + shape + ")");
      assert.equal(store.state, before, "and the store is left exactly as it was, by reference (" + shape + ")");
    }
  });
});

describe("fetchControllerDevices - failure copy", () => {

  // The view is mounted so each row asserts the words a user actually reads, which is where the expiry's copy differs from every other failure's.
  const mountError = (store) => {

    const root = document.createElement("div");

    document.body.appendChild(root);
    mountConnectionErrorView({ onRetry: () => {}, retryDelayMs: 50, root, signal: new AbortController().signal, store });

    return root;
  };

  test("an expiry renders the plugin-stopped-responding copy rather than the controller's", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using dom = createTestDom();

    const store = setup();
    const root = mountError(store);
    const pending = fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      failureGuidance: "Open the controller editor on this page.",
      getDevices: () => new Promise(() => {}),
      signal: new AbortController().signal,
      store
    });

    t.mock.timers.tick(30001);

    assert.equal(await pending, false, "an expiry is a failure like any other as far as the verdict goes");
    assert.match(store.state.status.message, /did not complete within 30 seconds/, "the expiry's own message reaches the view");
    assert.match(root.textContent, /The plugin stopped responding while retrieving the device list/,
      "a bound that elapsed says the plugin stopped answering, not that the controller is unreachable");
    assert.match(root.textContent, /Retry once the plugin is responding again/, "and sends the user after the plugin rather than after controller details");
    assert.equal(store.state.status.headline, "The plugin stopped responding while retrieving the device list.");
    assert.equal(store.state.status.guidance, "Retry once the plugin is responding again.", "the configured controller guidance is deliberately not used here");
  });

  test("a rejection renders the shared controller headline and the configured guidance", async () => {

    using dom = createTestDom();

    const store = setup();
    const root = mountError(store);

    await fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      failureGuidance: "Open the controller editor on this page.",
      getDevices: () => Promise.reject(new Error("Controller unreachable.")),
      signal: new AbortController().signal,
      store
    });

    assert.match(root.textContent, /Unable to connect to the controller/, "an ordinary rejection keeps the framework's shared controller headline");
    assert.match(root.textContent, /Open the controller editor on this page/, "with the plugin's own controller guidance beneath it");
    assert.equal(store.state.status.headline, "Unable to connect to the controller.");
  });

  test("a deadline error thrown by the hook itself reads as an expiry, since that is what it says", async () => {

    using dom = createTestDom();

    const store = setup();
    const root = mountError(store);

    await fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      failureGuidance: "Open the controller editor on this page.",
      getDevices: () => Promise.reject(new DeadlineExpiredError(5)),
      signal: new AbortController().signal,
      store
    });

    assert.match(root.textContent, /The plugin stopped responding while retrieving the device list/, "the copy follows the failure's kind, not where it was raised");
  });
});

describe("completeControllerSelection", () => {

  test("continues onto the controller-as-device row the loaded list carries", async () => {

    const store = setup();

    await fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      getDevices: () => Promise.resolve({ devices: DEVICES, error: "" }),
      signal: new AbortController().signal,
      store
    });

    completeControllerSelection({ controllerId: "ctrl-a", store });

    assert.deepEqual(store.state.scope, { controllerId: "ctrl-a", deviceId: "ctrl-a", kind: "device" }, "the controller's own row becomes the selection");
  });

  test("leaves the selection where it rests when the list carries no such row", async () => {

    const store = setup();

    await fetchControllerDevices({

      controllerId: "ctrl-a",
      deadlineSeconds: 30,
      getDevices: () => Promise.resolve({ devices: [{ name: "Camera", serialNumber: "cam-1" }], error: "" }),
      signal: new AbortController().signal,
      store
    });

    const before = store.state.scope;

    completeControllerSelection({ controllerId: "ctrl-a", store });

    assert.equal(store.state.scope, before, "a controller with no row of its own has no identity to select, so nothing moves");
  });
});
