/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/statusPanel.test.mjs: The parity suite for the live device-status panel. Each test maps to a behavior-contract ledger row (P1-P15) or
 * to the stale-push guard and reset semantics, driven against a Happy-DOM window, a real FeatureOptionsStore, and the evented fake homebridge bridge whose emitPush
 * delivers the host's exact MessageEvent-with-data push shape. The component is imported through its production `./statusPanel.mjs` specifier, which in turn imports
 * `../../webui-status.js`; the test loader redirects that to the TypeScript source, so an unredirected specifier would fail loudly here.
 */
"use strict";

import { STATUS_EVENT, STATUS_VIEW_ROUTE } from "../../webui-status.js";
import { createFakeHomebridge, createTestDom, installHomebridge } from "../../ui.helpers.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { mountStatusPanelView } from "./statusPanel.mjs";

// The permissive catalog every test mounts against - loading the store to "ready" so the panel's loading guard passes.
const CATALOG = {

  ...buildCatalogIndex([], {}),

  validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
};

// Two devices with distinct identities. Their serialNumbers are the panel's per-device guard keys.
const DEVICE_A = { firmwareRevision: "1.0.0", manufacturer: "Acme", model: "Model-A", name: "Device A", serialNumber: "AA" };
const DEVICE_B = { firmwareRevision: "2.0.0", manufacturer: "Beta", model: "Model-B", name: "Device B", serialNumber: "BB" };

// The encrypted "Connected" label: the U+1F512 lock plus U+FE0E text-presentation selector, then " Connected".
const LOCKED_CONNECTED = "\u{1F512}\u{FE0E} Connected";

// Placeholder row templates whose sizers differ from their live values, so a harvest assertion can tell a harvested value apart from a harvested phantom. The motion
// row carries a momentary-value latch.
const PLACEHOLDER_ROWS = [

  { id: "door", label: "Door", sizer: "Stopped (100%)" },
  { id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected" }
];

// Build a store advanced to ready with the given devices loaded. Scope stays global (the initial state), so a device selection is a later scope:changed dispatch.
const readyStore = (devices, { controllers = [], mode = "device-only" } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });

  store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers, mode, type: "model:loaded" });
  store.dispatch({ controllerId: null, type: "devices:requested" });
  store.dispatch({ controllerId: null, devices, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

  return store;
};

// Move the selection to a device or to global.
const selectDevice = (store, deviceId, controllerId = null) => store.dispatch({ scope: { controllerId, deviceId, kind: "device" }, type: "scope:changed" });
const selectGlobal = (store) => store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });

// Re-fire devices:loaded for the same device set - the same-device re-invocation the effect responds to without a fresh view request.
const refireDevices = (store, devices) => {

  store.dispatch({ controllerId: null, type: "devices:requested" });
  store.dispatch({ controllerId: null, devices, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
};

// A fake bridge whose request captures every status view-route body, so tests can count and inspect the view requests the panel fires.
const fakeWithViewCapture = () => {

  const viewRequests = [];
  const fake = createFakeHomebridge();

  fake.request = async (path, body) => {

    if(path === STATUS_VIEW_ROUTE) {

      viewRequests.push(body);
    }

    return null;
  };

  return { fake, viewRequests };
};

// Mount the panel into a fresh root appended to the document body. The caller owns the DOM and homebridge disposables.
const mountPanel = (config, store) => {

  const root = document.createElement("div");

  document.body.appendChild(root);

  const controller = new AbortController();
  const handle = mountStatusPanelView({ config, root, signal: controller.signal, store });

  return { controller, handle, root };
};

// DOM readers keyed by a cell's label so tests never address cells by child position.
const itemFor = (root, label) => [...root.querySelectorAll(".stat-item")].find((el) => el.querySelector(".stat-label")?.textContent === label) ?? null;
const valueSpanFor = (root, label) => itemFor(root, label)?.querySelector(".stat-value:not(.fo-phantom)") ?? null;
const valueFor = (root, label) => valueSpanFor(root, label)?.textContent ?? null;
const phantomsFor = (root, label) => {

  const item = itemFor(root, label);

  return item ? [...item.querySelectorAll(".fo-phantom")] : [];
};
const labelsIn = (root) => [...root.querySelectorAll(".stat-item .stat-label")].map((el) => el.textContent);
const messageText = (root) => root.querySelector(".fo-status-message .stat-value")?.textContent ?? null;

// Payload builders for each status event kind.
const snapshotEvent = (serialNumber, session, rows, encrypted = false) => ({ encrypted, kind: "snapshot", online: true, rows, serialNumber, session });
const rowEvent = (serialNumber, session, id, value) => ({ kind: "row", row: { id, value }, serialNumber, session });
const availabilityEvent = (serialNumber, session, online, encrypted = false) => ({ encrypted, kind: "availability", online, serialNumber, session });
const errorEvent = (serialNumber, session, reason) => ({ kind: "error", reason, serialNumber, session });

describe("statusPanel - selection and the view request", () => {

  test("P1: a new selection renders the skeleton - identity cells, Status Connecting..., placeholder rows with sizers, values as the dash", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // The default identity quartet plus the component-owned Status cell close the top row.
    assert.deepEqual(labelsIn(root), [ "Firmware", "Serial Number", "Model", "Manufacturer", "Status", "Door", "Motion" ]);
    assert.equal(valueFor(root, "Status"), "Connecting...");
    assert.equal(valueFor(root, "Door"), "-", "the door placeholder renders the dash");
    assert.equal(valueFor(root, "Motion"), "-", "the motion placeholder renders the dash");

    // Each state row reserves its sizer as a phantom.
    assert.equal(phantomsFor(root, "Door").length, 1, "the door column reserves its single sizer");
    assert.equal(phantomsFor(root, "Door")[0].textContent, "Stopped (100%)");
  });

  test("P2: the view request fires exactly once per genuinely-new selection; a same-device re-fire sends nothing and rebuilds from harvested values", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Open"));

    selectDevice(store, "BB");

    assert.deepEqual(viewRequests, [ { serialNumber: "AA" }, { serialNumber: "BB" } ], "two requests total, in order - a first-selection-only bug fails on B");

    // Back to A, then a same-device re-fire: no new request, and the harvested door value survives the rebuild.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 2, "door", "Closed"));

    const requestsBeforeRefire = viewRequests.length;

    refireDevices(store, [ DEVICE_A, DEVICE_B ]);

    assert.equal(viewRequests.length, requestsBeforeRefire, "a same-device re-fire sends no view request");
    assert.equal(valueFor(root, "Door"), "Closed", "the same-device rebuild harvests the live door value");
  });

  test("P13: select A, switch to global, reselect A - the second selection is genuinely new (skeleton re-rendered, a second view request fired)", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Open"));
    selectGlobal(store);

    assert.equal(root.textContent, "", "global scope clears the panel");

    selectDevice(store, "AA");

    assert.deepEqual(viewRequests, [ { serialNumber: "AA" }, { serialNumber: "AA" } ], "the reselection is genuinely new - a second view request fires");
    assert.equal(valueFor(root, "Status"), "Connecting...", "the reselection re-renders the skeleton");
    assert.equal(valueFor(root, "Door"), "-", "the reselection resets the door to its placeholder");
  });

  test("P11: global and controller scope both clear the panel and send nothing; a device-scope selection under controller mode renders normally", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    // Controller-based mode with the controller surfaced as a device entry, so a device-scope selection under it renders like any device.
    const controller = { name: "Hub", serialNumber: "CTRL" };
    const controllerAsDevice = { firmwareRevision: "3.0", manufacturer: "Hubs", model: "H1", name: "Hub", serialNumber: "CTRL" };
    const store = readyStore([controllerAsDevice], { controllers: [controller], mode: "controller-based" });
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    // A controller-only scope (no deviceId) resolves selectedDevice to undefined, exactly like global.
    store.dispatch({ scope: { controllerId: "CTRL", kind: "controller" }, type: "scope:changed" });
    assert.equal(root.textContent, "", "a controller scope clears the panel");
    assert.equal(viewRequests.length, 0, "a controller scope sends no view request");

    selectGlobal(store);
    assert.equal(root.textContent, "", "a global scope clears the panel");
    assert.equal(viewRequests.length, 0, "a global scope sends no view request");

    // A device-scope selection under controller mode renders the skeleton and fires the request.
    selectDevice(store, "CTRL", "CTRL");
    assert.equal(valueFor(root, "Status"), "Connecting...", "a device-scope selection under controller mode renders");
    assert.deepEqual(viewRequests, [{ serialNumber: "CTRL" }], "a device-scope selection fires its view request");
  });
});

describe("statusPanel - push handling by kind", () => {

  test("P14: a pushed connecting event for the viewed device sets the Status text through the handler", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 1, true, false));
    assert.equal(valueFor(root, "Status"), "Connected", "precondition: availability moved off the connecting label");

    fake.observed.emitPush(STATUS_EVENT, { kind: "connecting", serialNumber: "AA", session: 2 });
    assert.equal(valueFor(root, "Status"), "Connecting...", "a connecting push sets the Status text");
  });

  test("P3: a snapshot installs the authoritative row set, sets Connected (lock when encrypted), and clears a rendered message", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // Establish a rendered error message first, so the snapshot's message-clear is observable.
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 1, "unreachable"));
    assert.equal(messageText(root), "This device could not be reached.", "precondition: an error message is rendered");

    // The snapshot carries only a door row (the placeholder motion row must disappear) and an encrypted transport.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 2, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }], true));

    assert.equal(valueFor(root, "Status"), LOCKED_CONNECTED, "an encrypted snapshot sets the lock-prefixed Connected label");
    assert.equal(valueFor(root, "Door"), "Open", "the snapshot installs the door value");
    assert.equal(itemFor(root, "Motion"), null, "a row absent from the snapshot disappears");
    assert.equal(messageText(root), null, "the snapshot clears the error message");
  });

  test("P4: a row push updates exactly its own value span in place, preserving node identity", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    const doorSpanBefore = valueSpanFor(root, "Door");

    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 2, "door", "Closed"));

    assert.equal(valueSpanFor(root, "Door"), doorSpanBefore, "the same value-span node carries the new text - a full-panel rebuild would fail this");
    assert.equal(doorSpanBefore.textContent, "Closed");
  });

  test("P5: availability flips the Status cell, tracking each event's own encrypted flag rather than a remembered one", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 1, true, true));
    assert.equal(valueFor(root, "Status"), LOCKED_CONNECTED, "an encrypted online event shows the lock-prefixed label");

    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 2, false, false));
    assert.equal(valueFor(root, "Status"), "Disconnected", "an offline event shows Disconnected");

    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 3, true, false));
    assert.equal(valueFor(root, "Status"), "Connected", "an unencrypted online event shows the bare Connected label, not the remembered lock");

    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 4, true, true));
    assert.equal(valueFor(root, "Status"), LOCKED_CONNECTED, "the lock returns for the next encrypted online event");
  });

  test("P8: a same-device rebuild harvests the live rendered values, never a phantom sizer or a placeholder", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // The door's live value "Open" differs from its sizer "Stopped (100%)", so a harvested value cannot be confused with a harvested phantom.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    // An error rebuilds the panel; the harvest must carry the live door value forward, not reset it and not pick up the phantom.
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 2, "timeout"));

    assert.equal(valueFor(root, "Door"), "Open", "the rebuild harvested the live door value");
    assert.equal(messageText(root), "This device connected but did not push its state.", "the error message renders inside the box");
  });

  test("a push carrying no data and a push of an unrecognized kind are both ignored without mutating the panel", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 1, true, false));
    assert.equal(valueFor(root, "Status"), "Connected", "precondition: the panel renders the connected label");

    // A push with no payload is dropped at the guard; an unrecognized kind falls through the default with no mutation.
    fake.observed.emitPush(STATUS_EVENT, null);
    fake.observed.emitPush(STATUS_EVENT, { kind: "unknown-kind", serialNumber: "AA", session: 2 });

    assert.equal(valueFor(root, "Status"), "Connected", "neither a null payload nor an unknown kind changed the panel");
  });
});

describe("statusPanel - error copy", () => {

  test("P6: default copy per reason, the unknown-reason fallback, and per-field overrides that keep the untouched field's default", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);

    // A label-only override on timeout and a both-fields override on unreachable exercise the per-field merge.
    const overrides = { timeout: { label: "Custom timeout" }, unreachable: { label: "Custom label", message: "Custom message." } };
    const { root } = mountPanel({ errorMessages: overrides, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // A default reason renders the component's credential-neutral default copy.
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 1, "auth-invalid"));
    assert.equal(valueFor(root, "Status"), "Auth failed");
    assert.equal(messageText(root), "This device rejected the configured credentials.");

    // An unrecognized reason falls back to the Unavailable copy rather than empty cells.
    fake.observed.emitPush(STATUS_EVENT, { kind: "error", reason: "bogus-reason", serialNumber: "AA", session: 2 });
    assert.equal(valueFor(root, "Status"), "Unavailable");
    assert.equal(messageText(root), "This device is unavailable.");

    // A label-only override replaces the label and keeps the default message.
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 3, "timeout"));
    assert.equal(valueFor(root, "Status"), "Custom timeout", "the label override applies");
    assert.equal(messageText(root), "This device connected but did not push its state.", "the untouched message keeps the default");

    // A both-fields override replaces label and message together.
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 4, "unreachable"));
    assert.equal(valueFor(root, "Status"), "Custom label");
    assert.equal(messageText(root), "Custom message.");
  });
});

describe("statusPanel - the stale-push guard", () => {

  test("P7: per-serialNumber guards drop trailing sessions, apply equal-or-higher, and stay independent across devices", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    // Device A on screen with a high token magnitude.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 100, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));
    assert.equal(valueFor(root, "Door"), "Open");

    // A snapshot for the NOT-viewed device B advances B's guard to 5 but touches no DOM - A is still on screen.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 5, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "B5" }]));
    assert.equal(valueFor(root, "Door"), "Open", "a push for a non-viewed device drives no DOM");

    // On A, a trailing session is dropped; an equal session and a higher session both apply.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 50, "door", "Dropped"));
    assert.equal(valueFor(root, "Door"), "Open", "a session below the floor is dropped");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 100, "door", "Closed"));
    assert.equal(valueFor(root, "Door"), "Closed", "an equal session is applied");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 101, "door", "Reopened"));
    assert.equal(valueFor(root, "Door"), "Reopened", "a higher session is applied");

    // Switch to B. Its guard floor is 5 from the non-viewed snapshot: a session-4 snapshot is stale and dropped, but a session-6 snapshot applies - a single global
    // floor of 100 (A's) would have dropped both, so applying session 6 proves the guards are independent per device.
    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Door"), "-", "B renders its placeholder skeleton");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 4, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "B4" }]));
    assert.equal(valueFor(root, "Door"), "-", "a session below B's advanced floor is dropped");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 6, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "B6" }]));
    assert.equal(valueFor(root, "Door"), "B6", "session 6 applies against B's own floor, not A's");
  });

  test("resetStaleGuards clears the per-serialNumber floor so a fresh server's lower tokens are accepted again", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 100, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    // A lower token is dropped against the floor of 100.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Dropped"));
    assert.equal(valueFor(root, "Door"), "Open");

    // After a reset, the same low token is accepted.
    handle.resetStaleGuards();
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Accepted"));
    assert.equal(valueFor(root, "Door"), "Accepted", "the reset cleared the stale floor");
  });
});

describe("statusPanel - phantom reservations", () => {

  test("P10: phantom spans render per sizer candidate, hidden from paint and the accessibility tree, in the value's own class; Status reserves both candidates", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);

    // A tuple-sizer row reserves every candidate.
    const rows = [{ id: "obstruction", label: "Obstruction", sizer: [ "Obstructed", "Clear" ] }];
    const { root } = mountPanel({ placeholderRows: rows }, store);

    selectDevice(store, "AA");

    const obstructionPhantoms = phantomsFor(root, "Obstruction");

    assert.deepEqual(obstructionPhantoms.map((el) => el.textContent), [ "Obstructed", "Clear" ], "the tuple reserves every candidate");

    for(const phantom of obstructionPhantoms) {

      assert.ok(phantom.classList.contains("stat-value"), "the phantom carries the value's own class so it matches the font");
      assert.ok(phantom.classList.contains("fo-phantom"), "the phantom carries the fo-phantom class the theme hides it with");
      assert.equal(phantom.getAttribute("aria-hidden"), "true", "the phantom is out of the accessibility tree");
    }

    // The component-owned Status cell reserves both of its candidates.
    assert.deepEqual(phantomsFor(root, "Status").map((el) => el.textContent), [ "Disconnected", LOCKED_CONNECTED ], "the Status cell reserves both candidates");
  });
});

describe("statusPanel - lifecycle", () => {

  test("P12: a post-abort push produces no render, and a pre-aborted mount registers and renders nothing", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { controller, root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 1, true, false));
    assert.equal(valueFor(root, "Status"), "Connected", "precondition: the live panel renders pushes");

    controller.abort();
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 2, false, false));
    assert.equal(valueFor(root, "Status"), "Connected", "a push after abort produces no render");

    // A pre-aborted mount short-circuits the effect and registers no push listener, so a selection and a push both render nothing.
    const preAborted = new AbortController();

    preAborted.abort();

    const preRoot = document.createElement("div");

    document.body.appendChild(preRoot);
    mountStatusPanelView({ config: { placeholderRows: PLACEHOLDER_ROWS }, root: preRoot, signal: preAborted.signal, store });
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 3, true, false));
    assert.equal(preRoot.textContent, "", "a pre-aborted mount renders nothing");
  });

  test("the loading guard skips the immediate-run pass, so mounting before model:loaded renders nothing", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    // A fresh store sits in the loading state until model:loaded fires.
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    assert.equal(root.textContent, "", "the immediate-run pass rendered nothing during loading");
    assert.equal(viewRequests.length, 0, "no view request fired during loading");

    // Once loaded and a device is selected, the panel renders normally.
    store.dispatch({ catalog: CATALOG, configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });
    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [DEVICE_A], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    selectDevice(store, "AA");

    assert.equal(valueFor(root, "Status"), "Connecting...", "the panel renders once loading completes and a device is selected");
  });
});

describe("statusPanel - the latch lifecycle", () => {

  test("P9: the latch extends on re-arrival and clears at the extended deadline (two-checkpoint clock)", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // Arm at t0, re-arrive at t0 + 2000. The correct extend re-bases the 5000ms deadline to t0 + 7000.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));
    t.mock.timers.tick(2000);
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 2, "motion", "Detected"));

    // Just past the original t0 + 5000 deadline: still latched, because the re-arrival extended it (a restart-instead-of-extend or a no-extension port clears here).
    t.mock.timers.tick(3001);
    assert.equal(valueFor(root, "Motion"), "Detected", "the latch is still armed past the original deadline - the re-arrival extended it");

    // Past the extended t0 + 7000 deadline: cleared to the dash.
    t.mock.timers.tick(2000);
    assert.equal(valueFor(root, "Motion"), "-", "the latch clears at the extended deadline");
  });

  test("P9: snapshot-installed values arm the latch exactly as row pushes do", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected",
      value: "Detected" }]));

    assert.equal(valueFor(root, "Motion"), "Detected", "the snapshot installs the momentary value");

    t.mock.timers.tick(5001);
    assert.equal(valueFor(root, "Motion"), "-", "the snapshot-installed value latched and cleared on its own schedule");
  });

  test("P9: two rows latched concurrently clear independently on their own schedules", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const rows = [

      { id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected" },
      { id: "chime", label: "Chime", latch: { seconds: 3, value: "Ding" }, sizer: "Ding" }
    ];
    const { root } = mountPanel({ placeholderRows: rows }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 2, "chime", "Ding"));

    // Past the chime's 3s deadline but before the motion's 5s: chime cleared, motion still latched.
    t.mock.timers.tick(3001);
    assert.equal(valueFor(root, "Chime"), "-", "the chime cleared on its own 3s schedule");
    assert.equal(valueFor(root, "Motion"), "Detected", "the motion is still latched on its 5s schedule");

    // Past the motion's deadline too.
    t.mock.timers.tick(2000);
    assert.equal(valueFor(root, "Motion"), "-", "the motion cleared independently at its own deadline");
  });

  test("P9: a row push whose value differs from the latch value cancels the pending timer, and the newer value survives", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const rows = [{ id: "obstruction", label: "Obstruction", latch: { seconds: 5, value: "Obstructed" }, sizer: [ "Obstructed", "Clear" ] }];
    const { root } = mountPanel({ placeholderRows: rows }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "obstruction", "Obstructed"));
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 2, "obstruction", "Clear"));

    // Advance past the deadline: the differing value cancelled the timer, so the newer "Clear" value is not clobbered back to the dash.
    t.mock.timers.tick(6000);
    assert.equal(valueFor(root, "Obstruction"), "Clear", "the differing-value push cancelled the latch, so the newer value survives");
  });

  test("P9: a rebuild between arm and fire retargets the current cell by node identity", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected",
      value: "Detected" }]));

    // An error rebuilds the panel between arm and fire, producing a fresh motion span.
    t.mock.timers.tick(1000);
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 2, "timeout"));

    const motionSpanAfterRebuild = valueSpanFor(root, "Motion");

    assert.equal(motionSpanAfterRebuild.textContent, "Detected", "the rebuild harvested the live momentary value");

    // Fire the latch: the read-at-fire lookup clears the CURRENT (rebuilt) span, not the one captured at arm time.
    t.mock.timers.tick(5000);
    assert.equal(motionSpanAfterRebuild.textContent, "-", "the latch cleared the post-rebuild cell by resolving its target at fire time");
  });

  test("P9: a selection change cancels the armed latch so a later fire cannot touch the newly-selected device", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));

    // Switch to B, whose same row id shows a live value. A's latch must have been cancelled on the selection change.
    selectDevice(store, "BB");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 1, [{ id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected",
      value: "Idle" }]));
    assert.equal(valueFor(root, "Motion"), "Idle", "B's motion shows its live value");

    // Advance past A's deadline: a leaked A timer with a read-at-fire lookup would clear B's motion cell.
    t.mock.timers.tick(6000);
    assert.equal(valueFor(root, "Motion"), "Idle", "B's cell is untouched - A's latch was cancelled on the selection change");
  });

  test("P9: a global clear cancels the armed latch", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));

    // Clear to global, then re-select A with a fresh live motion value. A leaked timer with read-at-fire would clear the re-selected cell at A's original deadline.
    selectGlobal(store);
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 2, [{ id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected",
      value: "Idle" }]));

    t.mock.timers.tick(6000);
    assert.equal(valueFor(root, "Motion"), "Idle", "the re-selected cell is untouched - the global clear cancelled the prior latch");
  });

  test("P9: a signal abort cancels every armed latch so no later fire mutates the DOM", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { controller, root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));

    const motionSpan = valueSpanFor(root, "Motion");

    controller.abort();

    // Every deadline passes after abort: the latch was cancelled, so the cell keeps its momentary value rather than clearing to the dash.
    t.mock.timers.tick(6000);
    assert.equal(motionSpan.textContent, "Detected", "no armed timer fired after abort");
  });
});

describe("statusPanel - the configuration surface", () => {

  test("P15: a custom identity renders its cells with the mono flag, custom placeholderRows honor the latch, and the default renders identity-plus-Status only", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);

    // A custom identity function with a monospace field, and a custom placeholder row carrying a latch.
    const identity = (device) => [ { label: "MAC", mono: true, value: device.serialNumber }, { label: "Firmware", value: device.firmwareRevision } ];
    const placeholderRows = [{ id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected" }];
    const { root } = mountPanel({ identity, placeholderRows }, store);

    selectDevice(store, "AA");

    assert.deepEqual(labelsIn(root), [ "MAC", "Firmware", "Status", "Motion" ], "the custom identity renders its own cells");

    const macSpan = valueSpanFor(root, "MAC");

    assert.equal(macSpan.textContent, "AA");
    assert.equal(macSpan.style.fontFamily, "var(--fo-font-monospace)", "the mono flag applies the monospace token");

    // The custom placeholder row honors its latch on a subsequent matching row push.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));
    assert.equal(valueFor(root, "Motion"), "Detected");
    t.mock.timers.tick(5001);
    assert.equal(valueFor(root, "Motion"), "-", "the custom placeholder row's latch cleared the value");
  });

  test("P15: the placeholderRows default renders the identity and Status cells only", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({}, store);

    selectDevice(store, "AA");

    assert.deepEqual(labelsIn(root), [ "Firmware", "Serial Number", "Model", "Manufacturer", "Status" ], "an unconfigured skeleton shows identity and Status only");
  });
});
