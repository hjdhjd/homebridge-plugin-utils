/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/statusPanel.test.mjs: The parity suite for the live device-status panel. Each test's own title states the behavior it proves, driven
 * against a Happy-DOM window, a real FeatureOptionsStore, and the evented fake homebridge bridge whose emitPush delivers the host's exact MessageEvent-with-data push
 * shape. The component is imported through its production `./statusPanel.mjs` specifier, which in turn imports `../../webui-status.js`; the test loader redirects
 * that to the TypeScript source, so an unredirected specifier would fail loudly here.
 */
"use strict";

import { STATUS_EVENT, STATUS_VIEW_ROUTE } from "../../webui-status.js";
import { afterEach, describe, test } from "node:test";
import { createFakeHomebridge, createTestDom, installHomebridge } from "../../ui.helpers.mjs";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { createResumeDetector } from "../../webUi-liveness.mjs";
import { setImmediate as flushImmediate } from "node:timers/promises";
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

// The component's default link-lost copy, reload-action label, and default deadline, mirrored here so a test can assert the exact rendered strings and tick the real
// clock past the deadline. The reload button renders this label with the shared "↻ " glyph prepended, so a text assertion composes the two.
const LINK_LOST_LABEL = "Link lost";
const LINK_LOST_MESSAGE = "The connection to the Homebridge UI was lost.";
const LINK_LOST_RELOAD_TEXT = "Refresh Homebridge UI";
const LINK_LOST_DEADLINE_MS = 10000;

// The resume detector's check cadence and gap threshold in milliseconds, mirrored from the defaults createResumeDetector applies in webUi-liveness.mjs, so a resume
// test can advance the mock clock in cadence-sized steps and jump it clear past the threshold. The panel owns no cadence of its own - it subscribes to the page's
// detector and supplies only the policy of when a probe is worth firing.
const RESUME_CHECK_INTERVAL_MS = 15000;
const RESUME_GAP_THRESHOLD_MS = 90000;

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

// A fake bridge whose view-route request returns a caller-controlled deferred promise instead of resolving immediately, so a test can hold the panel's view request open
// past the watchdog deadline (a never-settling deferred) or settle it on demand to prove a settlement cancels detection. Each captured deferred exposes its own resolve /
// reject; the never-settling form is simply a deferred left unsettled. The existing fakeWithViewCapture resolves immediately and would cancel every watchdog before it
// could trip.
const fakeWithDeferredView = () => {

  const deferreds = [];
  const fake = createFakeHomebridge();

  fake.request = (path, body) => {

    if(path !== STATUS_VIEW_ROUTE) {

      return Promise.resolve(null);
    }

    let reject;
    let resolve;
    const promise = new Promise((res, rej) => {

      reject = rej;
      resolve = res;
    });

    deferreds.push({ body, promise, reject, resolve });

    return promise;
  };

  return { deferreds, fake };
};

// A promise that never settles, holding a watched request open so the watchdog can reach its deadline.
const hangingPromise = () => new Promise(() => {});

// A hand-rolled deferred for a request fed through the handle: the promise plus its own resolve / reject, so a test can settle it after arming the watchdog.
const deferred = () => {

  let reject;
  let resolve;
  const promise = new Promise((res, rej) => {

    reject = rej;
    resolve = res;
  });

  return { promise, reject, resolve };
};

// Every AbortController mountPanel mints is recorded here so a single afterEach can abort and drain them all at test exit. The panel's resume-probe detector arms a
// REAL Node interval - the harness deliberately installs no timer mock (see ui.helpers.mjs), so a mounted detector's setInterval is a live ref'd timer - and an
// unreclaimed interval keeps the node:test process alive indefinitely. Recording every mint here and draining in one hook reclaims all of them without a teardown edit
// at each mount call site.
const mountControllers = [];

// Mount the panel into a fresh root appended to the document body. The caller owns the DOM and homebridge disposables. The minted controller is recorded in
// `mountControllers` so the suite-wide afterEach reclaims this mount's resume subscription - and with it the detector's sampling interval - even when the test itself
// never aborts. A page-level detector is threaded by default so every test drives the production wiring; a test that needs the detector-less shape (a page that
// supplied none, which every plain mountStatusPanelView caller is) passes `resumeDetector: null`.
const mountPanel = (config, store, { resumeDetector = createResumeDetector() } = {}) => {

  const root = document.createElement("div");

  document.body.appendChild(root);

  const controller = new AbortController();

  mountControllers.push(controller);

  const handle = mountStatusPanelView({ config, resumeDetector: resumeDetector ?? undefined, root, signal: controller.signal, store });

  return { controller, handle, root };
};

// Reclaim every mount after each test: abort and drain the controllers mountPanel recorded, so no mounted detector's interval outlives the test that created it. A
// controller a test already aborted drains here too - a second abort is a no-op - so the explicit-abort tests need no special handling. The suite completing promptly
// is itself the proof: a single leaked ref'd interval would keep the process alive indefinitely.
afterEach(() => {

  for(const controller of mountControllers) {

    controller.abort();
  }

  mountControllers.length = 0;
});

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
const reloadLineIn = (root) => root.querySelector(".fo-status-reload");
const reloadAnchorIn = (root) => root.querySelector(".fo-status-reload button");

// Payload builders for each status event kind.
const connectingEvent = (serialNumber, session) => ({ kind: "connecting", serialNumber, session });
const snapshotEvent = (serialNumber, session, rows, encrypted = false) => ({ encrypted, kind: "snapshot", online: true, rows, serialNumber, session });
const rowEvent = (serialNumber, session, id, value) => ({ kind: "row", row: { id, value }, serialNumber, session });
const availabilityEvent = (serialNumber, session, online, encrypted = false) => ({ encrypted, kind: "availability", online, serialNumber, session });
const errorEvent = (serialNumber, session, reason) => ({ kind: "error", reason, serialNumber, session });

// The server-scoped hello payload: no serialNumber, no session - just the adapter process's generation.
const helloEvent = (generation) => ({ generation, kind: "hello" });

// Enable the mock timers a resume test needs: setTimeout and setInterval for the watchdog and the detector, and Date so setTime can simulate a wall-clock jump. Enabling
// the Date mock resets the clock to zero, and the detector reads the clock at mount, so this MUST run before mountPanel - an enable-after-mount test would hold a
// real-epoch last-tick against a zeroed clock, read every gap as negative, and silently kill the probe.
const enableResumeTimers = (t) => t.mock.timers.enable({ apis: [ "Date", "setInterval", "setTimeout" ] });

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

  test("P2: the view request fires exactly once per genuinely-new selection; a same-device re-fire sends nothing and rebuilds from the device's own state", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Open"));

    selectDevice(store, "BB");

    assert.deepEqual(viewRequests, [ { serialNumber: "AA" }, { serialNumber: "BB" } ], "two requests total, in order - a first-selection-only bug fails on B");

    // Back to A, then a same-device re-fire: no new request, and the door value A's entry holds survives the rebuild.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 2, "door", "Closed"));

    const requestsBeforeRefire = viewRequests.length;

    refireDevices(store, [ DEVICE_A, DEVICE_B ]);

    assert.equal(viewRequests.length, requestsBeforeRefire, "a same-device re-fire sends no view request");
    assert.equal(valueFor(root, "Door"), "Closed", "the same-device rebuild renders the door value from A's entry");
  });

  test("P13: select A, switch to global, reselect A - the second selection is genuinely new (a second view request fired) and renders A's remembered state", () => {

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

    // The door renders the value A's entry has held since the first push rather than the placeholder dash: the view was cleared, A's state was not. The Status cell
    // still reads Connecting... because the only push A ever sent was a row update, which says nothing about the connection - so nothing ever told the entry more.
    assert.equal(valueFor(root, "Door"), "Open", "the reselection renders A's last-known door value");
    assert.equal(valueFor(root, "Status"), "Connecting...", "the Status cell stands at Connecting... - no push ever told A's entry anything about the connection");
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

  test("P8: a rebuild renders the device's own row values, never a phantom sizer or a placeholder", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // The door's live value "Open" differs from its sizer "Stopped (100%)", so the rendered value cannot be confused with the phantom the column reserves.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    // An error rebuilds the panel; the rebuild must carry the door value forward from A's entry, not reset it and not pick up the phantom.
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 2, "timeout"));

    assert.equal(valueFor(root, "Door"), "Open", "the rebuild rendered the door value from A's entry");
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

describe("statusPanel - per-device state memory", () => {

  test("a snapshot for an unviewed device drives no DOM, and selecting that device renders its connected label and row values at once", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "AOpen" }]));

    const requestsBeforeB = viewRequests.length;

    // B's snapshot lands while A is on screen: it must reduce into B's own state and leave the viewed panel exactly as it was.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "BOpen" }], true));
    assert.equal(valueFor(root, "Door"), "AOpen", "B's push left A's door value alone");
    assert.equal(valueFor(root, "Status"), "Connected", "B's push left A's Status alone");

    // Selecting B renders B's remembered state synchronously. No push follows this selection, so everything on screen came from the entry alone - the skeleton and
    // its "Connecting..." placeholder are what a build reading no state would show here.
    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Status"), LOCKED_CONNECTED, "B renders the encrypted connected label it last pushed");
    assert.equal(valueFor(root, "Door"), "BOpen", "B renders the door value it last pushed");

    // The authoritative re-read still goes out: the entry is memory, not a substitute for asking.
    assert.deepEqual(viewRequests.slice(requestsBeforeB), [{ serialNumber: "BB" }], "the selection still fires B's view request");
  });

  test("an error pushed for an unviewed device renders its label and message the moment that device is selected", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, errorEvent("BB", 1, "auth-invalid"));
    assert.equal(messageText(root), null, "the unviewed error rendered no message on A's panel");

    // The copy is resolved when the error is reduced, so the entry carries the finished label and message rather than a reason to re-resolve later.
    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Status"), "Auth failed", "B renders the error label from its entry");
    assert.equal(messageText(root), "This device rejected the configured credentials.", "and the error message with it");
  });

  test("an offline availability pushed for an unviewed device renders Disconnected the moment that device is selected", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("BB", 1, false, false));
    assert.equal(valueFor(root, "Status"), "Connecting...", "the unviewed availability left A's Status alone");

    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Status"), "Disconnected", "B renders the offline state it last pushed");
  });

  test("a momentary value latches on the unviewed device's own clock, so a later selection shows it only while it is still true", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    // B's momentary value arrives while A is on screen, arming B's five-second latch against B's own state.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("BB", 1, "motion", "Detected"));

    // Two seconds in the value is still true, so selecting B shows it.
    t.mock.timers.tick(2000);
    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Motion"), "Detected", "B renders the momentary value that is still within its latch");

    // Past the five-second deadline B's own push set, the value expires. The clock ran from that push and not from the selection: a latch that restarted when B came
    // on screen would still be three seconds from firing here.
    t.mock.timers.tick(3001);
    assert.equal(valueFor(root, "Motion"), "-", "the value cleared on the deadline B's own push set");
  });

  test("a trailing-session push for an unviewed device writes nothing to its state", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    // Two snapshots for the unviewed B, the second trailing the first's session. The floor runs before any state write, so the trailing one is dropped whole.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 5, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "B5" }]));
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 4, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "B4" }]));

    // Selecting B is what makes the drop visible: a state write that slipped above the floor guard would have left "B4" in B's entry to render here.
    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Door"), "B5", "B's state holds the higher session's value - the trailing push never reached it");
  });

  test("a push of an unrecognized kind creates no state for its device - it advances the floor and nothing else", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    // An unrecognized kind for the unviewed B. The floor advances to 5 as it does for any device event, but the reduction has no case for it.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, { kind: "unknown-kind", serialNumber: "BB", session: 5 });

    // A session-4 snapshot trails that floor and is dropped. That drop is the proof the floor did advance - had the unknown kind left the floor at zero, this
    // snapshot would apply and B would render "B4" below.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 4, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "B4" }]));

    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Status"), "Connecting...", "B renders the pristine skeleton - nothing wrote a status for it");
    assert.equal(valueFor(root, "Door"), "-", "and its placeholder rows carry no value");
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

    // Switch to B. That off-screen snapshot populated B's entry, so B renders its own last-known value the moment it is selected. Its guard floor is 5 from the same
    // snapshot: a session-4 snapshot is stale and dropped, but a session-6 snapshot applies - a single global floor of 100 (A's) would have dropped both, so applying
    // session 6 proves the guards are independent per device.
    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Door"), "B5", "B renders the last-known value from its own entry");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 4, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "B4" }]));
    assert.equal(valueFor(root, "Door"), "B5", "a session below B's advanced floor is dropped - an implementation that admitted it would render B4");
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

  test("P10: phantom spans render per sizer candidate, hidden from paint and the accessibility tree, in the value's own class; Status reserves every candidate", () => {

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

    // The component-owned Status cell reserves every one of its candidates - Disconnected, the encrypted Connected label, and the link-lost label.
    assert.deepEqual(phantomsFor(root, "Status").map((el) => el.textContent), [ "Disconnected", LOCKED_CONNECTED, "Link lost" ],
      "the Status cell reserves every candidate");
  });
});

describe("statusPanel - lifecycle", () => {

  test("P12/r8: a post-abort push produces no render; a pre-aborted mount arms no detector interval and renders nothing", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { controller, root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 1, true, false));
    assert.equal(valueFor(root, "Status"), "Connected", "precondition: the live panel renders pushes");

    controller.abort();
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 2, false, false));
    assert.equal(valueFor(root, "Status"), "Connected", "a push after abort produces no render");

    const requestsBeforePreAborted = viewRequests.length;

    // A pre-aborted mount short-circuits the effect and registers no push listener, so a selection and a push both render nothing. This suite installs no timer mock, so
    // the detector's setInterval is a REAL Node timer here - and the subscribe call's `if(signal?.aborted) return` guard is what keeps a pre-aborted mount from ever
    // calling arm. That guard is pinned at runtime: this mount's controller is never handed to mountPanel, so the suite-wide afterEach cannot reclaim it, and a leaked
    // real interval would keep the node:test process alive - the suite's prompt exit is the proof the guard held. A missing guard would also skip on this null-device
    // tick, so counting a probe cannot catch it; the leak is what does.
    const preAborted = new AbortController();

    preAborted.abort();

    const preRoot = document.createElement("div");

    document.body.appendChild(preRoot);
    mountStatusPanelView({ config: { placeholderRows: PLACEHOLDER_ROWS }, root: preRoot, signal: preAborted.signal, store });
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 3, true, false));
    assert.equal(preRoot.textContent, "", "a pre-aborted mount renders nothing");
    assert.equal(viewRequests.length, requestsBeforePreAborted, "a pre-aborted mount fires no view request - its effect never ran");
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

  test("P9: a latch runs across a selection change - it fires against its own device's state and never touches the newly-selected device's cell", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));

    // Switch to B, whose same row id shows a live value. The switch cancels nothing: how long A's momentary value stays true is A's business, not the viewer's.
    selectDevice(store, "BB");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 1, [{ id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: "Detected",
      value: "Idle" }]));
    assert.equal(valueFor(root, "Motion"), "Idle", "B's motion shows its live value");

    // Advance past A's deadline. The fire writes A's own entry and reaches the DOM only for the device on screen, so B's cell is untouched: an implementation keying
    // its timers by row id alone across devices, or one skipping the viewed-device check at fire time, would clear B's motion here.
    t.mock.timers.tick(6000);
    assert.equal(valueFor(root, "Motion"), "Idle", "B's cell is untouched by A's fire");

    // Reselecting A proves the fire landed where it belonged: A's own value cleared on schedule, so A renders the honest dash rather than a frozen "Detected".
    selectDevice(store, "AA");
    assert.equal(valueFor(root, "Motion"), "-", "A shows the dash - its latch fired on its own clock while off screen");
  });

  test("P9: a latch survives a clear to global scope, firing against its device's state so a later reselection is honest", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));

    // Clear to global. Nothing is on screen and nothing is cancelled, so A's latch runs out its five seconds against A's entry with no panel to write into.
    selectGlobal(store);
    t.mock.timers.tick(6000);

    // Re-selecting A renders whatever A's entry holds at this point. A cancelled timer would have frozen "Detected" there instead, and the momentary value would
    // outlive its own validity for as long as the user stayed away.
    selectDevice(store, "AA");
    assert.equal(valueFor(root, "Motion"), "-", "the latch fired while nothing was on screen, so the reselection shows the dash");
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

describe("statusPanel - the server-hello recovery", () => {

  test("H1: a fresh-generation hello clears every per-device floor panel-wide and invokes onServerHello once", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    let helloCount = 0;

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ onServerHello: () => { helloCount++; }, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Establish a high floor for the viewed device A and, from off-screen, for device B.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 500, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "AOpen" }]));
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 500, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "BOpen" }]));

    // Precondition: against A's high floor, a token-1 push is stale and dropped.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "AStaleDropped"));
    assert.equal(valueFor(root, "Door"), "AOpen", "precondition: a token-1 push is dropped against A's high floor");

    // The fresh server introduces itself: the callback fires exactly once.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(12345));
    assert.equal(helloCount, 1, "the fresh hello invoked the callback once");

    // A token-1 push for the viewed device now renders - its floor was cleared.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "AFresh"));
    assert.equal(valueFor(root, "Door"), "AFresh", "the cleared floor accepts A's token-1 push");

    // Switch to B and push a token-1 snapshot: it renders too, so the clearing was panel-wide rather than viewed-only.
    selectDevice(store, "BB");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("BB", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "BFresh" }]));
    assert.equal(valueFor(root, "Door"), "BFresh", "the clearing was panel-wide - B's floor was cleared too");
  });

  test("H2: a duplicate-generation hello is a no-op in both effects - no second callback and no floor clearing", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    let helloCount = 0;

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ onServerHello: () => { helloCount++; }, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // A first fresh hello adopts generation 7 and fires the callback.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(7));
    assert.equal(helloCount, 1, "the first hello fired the callback");

    // Re-establish a high floor after the recovery.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 500, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    // A duplicate-generation hello: neither re-fires the callback nor clears the floor. A build that clears on every hello fails the stale-drop below; a build that
    // never clears fails the H1 recovery case.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(7));
    assert.equal(helloCount, 1, "the duplicate hello did not re-fire the callback");

    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Dropped"));
    assert.equal(valueFor(root, "Door"), "Open", "the duplicate hello did not clear the floor - the stale push is still dropped");
  });

  test("H2: hellos with a non-finite generation (undefined, null, a string, NaN) are ignored entirely - no callback and no clearing", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    let helloCount = 0;

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ onServerHello: () => { helloCount++; }, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 500, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    // Each non-finite generation is ignored - an undefined generation must never collide with the null unseen sentinel.
    fake.observed.emitPush(STATUS_EVENT, { kind: "hello" });
    fake.observed.emitPush(STATUS_EVENT, { generation: null, kind: "hello" });
    fake.observed.emitPush(STATUS_EVENT, { generation: "12345", kind: "hello" });
    fake.observed.emitPush(STATUS_EVENT, { generation: NaN, kind: "hello" });

    assert.equal(helloCount, 0, "no invalid-generation hello fired the callback");

    // The floor was never cleared: a stale token-1 push is still dropped.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Dropped"));
    assert.equal(valueFor(root, "Door"), "Open", "no invalid hello cleared the floor - the stale push is still dropped");
  });

  test("first-contact: a pristine mount's first valid hello invokes the callback (the null unseen sentinel differs from any finite generation)", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    let helloCount = 0;

    const store = readyStore([DEVICE_A]);

    mountPanel({ onServerHello: () => { helloCount++; }, placeholderRows: PLACEHOLDER_ROWS }, store);

    // No device is viewed yet - the first hello still fires, since serverGeneration starts null and differs from any finite generation.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(1));
    assert.equal(helloCount, 1, "the first hello fired even before any device was viewed");
  });

  test("H3: a hello touches no DOM - the panel and a sampled value span keep node identity, and a latch armed before it still clears on schedule", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ onServerHello: () => {}, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));

    const panelBefore = root.querySelector(".device-stats-grid");
    const motionSpanBefore = valueSpanFor(root, "Motion");

    // The hello clears floors and notifies, but does no DOM work and touches no pending latch.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(99));

    assert.equal(root.querySelector(".device-stats-grid"), panelBefore, "the panel element is the same node across a hello");
    assert.equal(valueSpanFor(root, "Motion"), motionSpanBefore, "the motion value span is the same node across a hello");
    assert.equal(motionSpanBefore.textContent, "Detected", "the latched value is unchanged by the hello");

    // The latch armed before the hello still clears its row at its own deadline.
    t.mock.timers.tick(5001);
    assert.equal(valueFor(root, "Motion"), "-", "the latch armed before the hello still cleared on schedule");
  });

  test("the onServerHello callback is optional: a hello with none configured neither throws nor renders, yet still clears the floor", () => {

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 500, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    const panelBefore = root.querySelector(".device-stats-grid");

    // A hello with no configured callback: the optional call is a no-op, and nothing rebuilds the panel.
    assert.doesNotThrow(() => fake.observed.emitPush(STATUS_EVENT, helloEvent(42)));
    assert.equal(root.querySelector(".device-stats-grid"), panelBefore, "the hello did not rebuild the panel");

    // The floor still cleared even without a callback: a subsequent token-1 push renders.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "door", "Fresh"));
    assert.equal(valueFor(root, "Door"), "Fresh", "the floor still cleared even without a callback");
  });
});

describe("statusPanel - the link-lost watchdog", () => {

  test("P16: a view request that never settles trips the link-lost state after the deadline, rendering the default copy", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { deferreds, fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    assert.equal(deferreds.length, 1, "the view request fired and is held open");

    // Just short of the deadline, the panel is still Connecting..., with no link-lost message.
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS - 1);
    assert.equal(valueFor(root, "Status"), "Connecting...", "before the deadline the panel is still Connecting...");
    assert.equal(messageText(root), null, "before the deadline there is no link-lost message");

    // Past the deadline the watchdog trips and renders the honest link-lost state with the default copy.
    t.mock.timers.tick(2);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the Status cell shows the link-lost label");
    assert.equal(messageText(root), LINK_LOST_MESSAGE, "the message line shows the default link-lost instruction");
  });

  test("P17: a label-only link-lost override applies its label and keeps the default message", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ linkLostMessage: { label: "No link" }, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);

    assert.equal(valueFor(root, "Status"), "No link", "the label override applies to the Status cell");
    assert.equal(messageText(root), LINK_LOST_MESSAGE, "the untouched message keeps the default");
  });

  test("P18: a view request that resolves before the deadline never trips", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { deferreds, fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // Resolving the view request before the deadline is liveness: it cancels the watchdog.
    deferreds[0].resolve(null);
    await flushImmediate();

    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    await flushImmediate();

    assert.equal(valueFor(root, "Status"), "Connecting...", "a resolved request left the panel Connecting... with no trip");
    assert.equal(messageText(root), null, "no link-lost message rendered");
  });

  test("P19: a view request that rejects before the deadline is liveness - no trip, and no unhandled rejection", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    // requestView logs a rejected view request through console.error; suppress it so the deliberate rejection here does not pollute the suite output.
    t.mock.method(console, "error", () => {});

    using _dom = createTestDom();

    const { deferreds, fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // Rejecting the view request before the deadline: the two-armed hook counts the rejection as liveness AND consumes it, so no trip and no unhandled rejection.
    deferreds[0].reject(new Error("dropped"));
    await flushImmediate();

    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    await flushImmediate();

    assert.equal(valueFor(root, "Status"), "Connecting...", "a rejected request cancelled detection - no trip");
    assert.equal(messageText(root), null, "no link-lost message rendered");
  });

  test("P20: a delivered status push is liveness - a full push and a payload-less push each cancel the pending watchdog", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // A full status push proves the relay live: the handler cancels the pending watchdog as its first act, so the deadline never trips.
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 1, true, false));
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    assert.equal(valueFor(root, "Status"), "Connected", "the availability push cancelled the watchdog and set the connected label");
    assert.equal(messageText(root), null, "no link-lost message rendered");

    // Re-arm through the handle, then deliver a PAYLOAD-LESS push: the first-statement cancel runs before the payload guard, so even an empty event cancels the watchdog.
    handle.watchRequest(hangingPromise());
    fake.observed.emitPush(STATUS_EVENT, null);
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    assert.equal(valueFor(root, "Status"), "Connected", "the payload-less push cancelled the re-armed watchdog - no trip");
    assert.equal(messageText(root), null, "still no link-lost message");
  });

  test("P21: a hanging promise fed through the handle trips the mounted panel on the configured deadline", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 4, placeholderRows: PLACEHOLDER_ROWS }, store);

    // View a device whose view request RESOLVES immediately (a healthy mount): its settlement cancels the initial watchdog.
    selectDevice(store, "AA");
    await flushImmediate();

    // Feed a hanging promise through the handle - the plugin's forced-re-warm path - which arms a fresh watchdog on the configured four-second deadline.
    handle.watchRequest(hangingPromise());

    // Just short of the configured deadline, no trip yet, proving the configured value governs rather than the default.
    t.mock.timers.tick(4000 - 1);
    assert.equal(valueFor(root, "Status"), "Connecting...", "before the configured deadline the panel has not tripped");

    t.mock.timers.tick(2);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the handle-fed hanging request tripped the link-lost state on the mounted panel");
    assert.equal(messageText(root), LINK_LOST_MESSAGE, "the link-lost message rendered on the mounted panel");
  });

  test("P22: a snapshot after a trip restores the connected state, and a latch armed before the trip still fires on its own schedule", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");

    // Arm the motion latch (five seconds) via a row push, which also cancels the initial watchdog since a push is liveness.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 1, "motion", "Detected"));
    assert.equal(valueFor(root, "Motion"), "Detected", "the row push armed the motion latch");

    // Re-arm the watchdog through the handle (two seconds), then trip it before the latch's five-second deadline.
    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the watchdog tripped the link-lost state");
    assert.equal(valueFor(root, "Motion"), "Detected", "the motion value carried through the trip's rebuild");
    assert.ok(reloadAnchorIn(root), "the reload action renders in the link-lost state");

    // The latch armed BEFORE the trip still fires at its own five-second deadline - the trip touched no latch.
    t.mock.timers.tick(3000);
    assert.equal(valueFor(root, "Motion"), "-", "the pre-trip latch cleared the motion value on its own schedule");
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the latch firing did not disturb the link-lost Status");

    // A snapshot push recovers: it clears the link-lost marker and message, restores the connected label, and rebuilds the rows.
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 2, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));
    assert.equal(valueFor(root, "Status"), "Connected", "the snapshot restored the connected label");
    assert.equal(messageText(root), null, "the snapshot cleared the link-lost message");
    assert.equal(reloadAnchorIn(root), null, "the reload action is gone after recovery");
    assert.equal(valueFor(root, "Door"), "Open", "the snapshot rebuilt the rows");
  });

  test("P23: detection survives its own trip - after a trip on device A, switching to device B re-arms and B trips on its own deadline", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "device A tripped the link-lost state");

    // Switching to device B cancels A's fired watchdog, resets to Connecting..., and B's own hanging view request re-arms a fresh full deadline.
    selectDevice(store, "BB");
    assert.equal(valueFor(root, "Status"), "Connecting...", "the new selection reset the panel off link-lost");
    assert.equal(messageText(root), null, "the new selection cleared the link-lost message");

    // B's view request also hangs, so the re-armed watchdog trips a SECOND time - proving detection did not die after A's fire.
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "device B tripped - a second trip after the first, so detection re-armed");
    assert.ok(reloadAnchorIn(root), "the second trip renders the reload action");
  });

  test("P24: a view change resets the deadline per view - the switch branch and the no-device branch both cancel a pending watchdog", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([ DEVICE_A, DEVICE_B ]);
    const { root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Arm on A, then switch to B just before A's deadline: A's watchdog is cancelled and must not trip the fresh B view.
    selectDevice(store, "AA");
    t.mock.timers.tick(1999);
    selectDevice(store, "BB");
    t.mock.timers.tick(2);
    assert.equal(valueFor(root, "Status"), "Connecting...", "A's cancelled deadline did not trip the fresh B view");

    // B trips on B's OWN full deadline, not A's remaining time.
    t.mock.timers.tick(2000);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "B tripped on its own clock");

    // The no-device branch: arm a fresh view, clear the selection to no device, and confirm the cancelled watchdog leaves no trip behind.
    selectDevice(store, "AA");
    assert.equal(valueFor(root, "Status"), "Connecting...", "re-selecting A re-armed a fresh view");
    selectGlobal(store);
    assert.equal(root.textContent, "", "the no-device selection cleared the panel");
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    assert.equal(root.textContent, "", "no trip rendered after the no-device clear - the watchdog was cancelled");
  });

  test("P25: the one watchdog serves every in-flight request - settling one probe cancels detection, and the next probe re-arms", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Heal the initial view request so the mount starts with no pending watchdog.
    selectDevice(store, "AA");
    await flushImmediate();

    // Two hanging probes under the one watchdog: the second shares the first's timer rather than arming a second.
    const probe1 = deferred();

    handle.watchRequest(probe1.promise);
    handle.watchRequest(hangingPromise());

    // Settling probe1 is liveness: it cancels the shared watchdog even though the second probe still hangs.
    probe1.resolve(null);
    await flushImmediate();

    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), "Connecting...", "settling one probe cancelled the shared watchdog - no trip");

    // Feeding a fresh probe re-arms detection, which now trips on its own full deadline.
    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the next request re-armed the watchdog and it tripped");
  });

  test("P26: after a trip, every non-snapshot render clears the marker and its lingering message, and an error render carries no reload action", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Trip the watchdog fresh on the mounted panel: feed a hanging probe, then tick past the two-second deadline.
    const tripFresh = () => {

      handle.watchRequest(hangingPromise());
      t.mock.timers.tick(2001);
    };

    selectDevice(store, "AA");

    // A "connecting" push clears the marker and its lingering message and returns the Status to Connecting...
    tripFresh();
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "precondition: the panel tripped to link-lost");
    fake.observed.emitPush(STATUS_EVENT, connectingEvent("AA", 1));
    assert.equal(valueFor(root, "Status"), "Connecting...", "a connecting push cleared the link-lost Status");
    assert.equal(messageText(root), null, "a connecting push cleared the lingering link-lost message");
    assert.equal(reloadAnchorIn(root), null, "no reload action after the connecting push");

    // An "availability" push clears the marker and message and sets its own connected label.
    tripFresh();
    fake.observed.emitPush(STATUS_EVENT, availabilityEvent("AA", 2, true, false));
    assert.equal(valueFor(root, "Status"), "Connected", "an availability push set the connected label");
    assert.equal(messageText(root), null, "an availability push cleared the lingering link-lost message");
    assert.equal(reloadAnchorIn(root), null, "no reload action after the availability push");

    // A "row" push - the least-touching handler - still clears the marker and the message; the Status is corrected by a later status-bearing push.
    tripFresh();
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 3, "door", "Open"));
    assert.equal(messageText(root), null, "a row push cleared the lingering link-lost message");
    assert.equal(reloadAnchorIn(root), null, "no reload action after the row push");
    assert.equal(valueFor(root, "Door"), "Open", "the row push applied its own value");

    // An "error" push renders the error copy but carries NO reload action - the marker gates the anchor, not the message string.
    tripFresh();
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 4, "unreachable"));
    assert.equal(valueFor(root, "Status"), "Unreachable", "the error push set the error label");
    assert.equal(messageText(root), "This device could not be reached.", "the error push set the error message");
    assert.equal(reloadAnchorIn(root), null, "the error render carries no reload action");
  });

  test("P26: a delivered push after a trip returns the device's whole presentation - its status and its message together", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Establish a classified error as A's real state, then trip the watchdog over the top of it.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 1, "unreachable"));

    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "precondition: the link-lost state covers the error state");
    assert.equal(messageText(root), LINK_LOST_MESSAGE, "precondition: and carries its own message");

    // A row push - the least status-bearing kind there is - retires the link-lost state. Underneath, A's error state stands exactly as it was: the label and the
    // message come back together, because both are read from A's own state rather than from whatever the DOM was last told.
    fake.observed.emitPush(STATUS_EVENT, rowEvent("AA", 2, "door", "Open"));

    assert.equal(valueFor(root, "Status"), "Unreachable", "the error label returns with the link-lost state retired");
    assert.equal(messageText(root), "This device could not be reached.", "and its message returns alongside it");
    assert.equal(reloadAnchorIn(root), null, "the reload action goes with the link-lost state");
    assert.equal(valueFor(root, "Door"), "Open", "and the row push's own value applies");
  });

  test("P27: teardown cancels the pending watchdog, and a post-abort settlement or a stale-handle feed is inert", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { deferreds, fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { controller, handle, root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    assert.equal(deferreds.length, 1, "precondition: a view request is pending with the watchdog armed");

    // Aborting runs the combined teardown hook, which cancels the pending watchdog, so the deadline never trips.
    controller.abort();
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    assert.equal(valueFor(root, "Status"), "Connecting...", "no trip rendered after abort - the watchdog was cancelled");

    // Settling the watched promise post-abort is inert: cancelWatchdog finds nothing pending and nothing throws or rejects.
    deferreds[0].resolve(null);
    await flushImmediate();

    // A watchRequest on the aborted mount reads its signal at call time and returns before arming, so a later tick trips nothing.
    assert.doesNotThrow(() => handle.watchRequest(hangingPromise()), "a stale-handle feed on an aborted mount does not throw");
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    assert.equal(valueFor(root, "Status"), "Connecting...", "the stale-handle feed armed no timer");
  });

  test("P28: a trip with no device viewed is inert, and viewing a device afterward renders Connecting... not link-lost", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // No device is viewed; feed a hanging promise through the handle and let it trip. The trip records its state but renders nothing, so the root stays empty.
    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);
    assert.equal(root.textContent, "", "the trip is inert with no panel mounted");

    // Viewing a device now resets and re-arms honestly: it renders Connecting..., not the stale link-lost state.
    selectDevice(store, "AA");
    assert.equal(valueFor(root, "Status"), "Connecting...", "the fresh view rendered Connecting..., not link-lost");
    assert.equal(messageText(root), null, "no link-lost message carried into the fresh view");
  });

  test("P29: the reload action is its own full-width line rendering the family recovery button, clicks without throwing, and is absent from an error render", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    t.mock.timers.tick(2001);

    const reloadLine = reloadLineIn(root);
    const button = reloadAnchorIn(root);

    assert.ok(reloadLine, "the reload action renders as its own line in the link-lost state");
    assert.ok(button, "the reload action's button renders");
    assert.equal(button.tagName, "BUTTON", "the reload action renders as the family recovery button element");
    assert.deepEqual([...button.classList], [ "btn", "btn-warning", "btn-sm" ], "the button wears the shared recovery classes");
    assert.equal(button.textContent, "↻ " + LINK_LOST_RELOAD_TEXT, "the button carries the glyph-prefixed recovery label");

    // The action line is its own full-width line below the message, not a control trailing inside the message line.
    assert.equal(button.parentElement, reloadLine, "the button is the reload line's own element");
    assert.equal(root.querySelector(".fo-status-message button"), null, "the reload button is not inside the message line");

    // Clicking the reload action does not throw. The reload targets the top frame; happy-dom's standalone window has window.top === window, so top-versus-self is
    // not structurally distinguishable in the harness.
    assert.doesNotThrow(() => button.click(), "clicking the reload action does not throw");

    // An error render after the trip carries NO reload action line: the marker gates the button, not the message string.
    fake.observed.emitPush(STATUS_EVENT, errorEvent("AA", 1, "unreachable"));
    assert.equal(valueFor(root, "Status"), "Unreachable", "the error push rendered the error copy");
    assert.equal(reloadAnchorIn(root), null, "the error render omits the reload action");
    assert.equal(reloadLineIn(root), null, "the error render omits the reload action line entirely");
  });

  test("P30: a zero or negative link-lost timeout falls back to the default deadline, not an instant trip", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    // A zero timeout falls back to the default: it must NOT trip instantly, and must trip on the default clock.
    const zeroStore = readyStore([DEVICE_A]);
    const { root: zeroRoot } = mountPanel({ linkLostTimeoutSeconds: 0, placeholderRows: PLACEHOLDER_ROWS }, zeroStore);

    selectDevice(zeroStore, "AA");
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS - 1);
    assert.equal(valueFor(zeroRoot, "Status"), "Connecting...", "a zero timeout did not trip instantly - it fell back to the default");

    t.mock.timers.tick(2);
    assert.equal(valueFor(zeroRoot, "Status"), LINK_LOST_LABEL, "a zero timeout tripped on the default deadline");

    // A negative timeout takes the same fallback branch.
    const negStore = readyStore([DEVICE_A]);
    const { root: negRoot } = mountPanel({ linkLostTimeoutSeconds: -5, placeholderRows: PLACEHOLDER_ROWS }, negStore);

    selectDevice(negStore, "AA");
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);
    assert.equal(valueFor(negRoot, "Status"), LINK_LOST_LABEL, "a negative timeout also fell back to the default and tripped");
  });
});

describe("statusPanel - the page-resume detector", () => {

  test("P31/r1: a page resume fires exactly one view request for the viewed device", async (t) => {

    enableResumeTimers(t);

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);

    mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    // View the device: its healthy view request resolves, cancelling the initial watchdog, and the detector arms on the zeroed mock clock.
    selectDevice(store, "AA");
    await flushImmediate();
    assert.deepEqual(viewRequests, [{ serialNumber: "AA" }], "the selection fired the one initial view request");

    // Several normal-cadence ticks: the detector fires each time but every gap equals the cadence, under the threshold, so no probe.
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);
    assert.equal(viewRequests.length, 1, "normal cadence fired no probe");

    // Simulate a suspension: jump the wall clock far past the threshold WITHOUT running timers, then tick to drain the interval's backlog. The first drained fire sees
    // the full jumped gap and probes; every trailing fire sees a zero gap because the unconditional last-tick store absorbs the drain - so a resume yields exactly one
    // new view request, never one per drained fire.
    t.mock.timers.setTime(Date.now() + (6 * RESUME_GAP_THRESHOLD_MS));
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);

    assert.deepEqual(viewRequests, [ { serialNumber: "AA" }, { serialNumber: "AA" } ], "the resume fired exactly one new view request for the viewed device");
  });

  test("P32/r2: normal cadence never probes - the view-request count does not grow across many intervals", async (t) => {

    enableResumeTimers(t);

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);

    mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    await flushImmediate();
    assert.equal(viewRequests.length, 1, "only the initial view request fired");

    // Advance many normal-cadence intervals with no wall-clock jump: every gap equals the cadence, under the threshold, so the detector never probes.
    for(let i = 0; i < 20; i++) {

      t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);
    }

    assert.equal(viewRequests.length, 1, "twenty normal intervals fired no probe");
  });

  test("P33/r3: throttled hidden-tab ticks stay under the threshold, then a suspension probes once", async (t) => {

    enableResumeTimers(t);

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);

    mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    await flushImmediate();
    assert.equal(viewRequests.length, 1, "only the initial view request fired");

    // A throttled hidden desktop tab fires its background ticks at roughly one-minute spacing, comfortably under the resume threshold. Model each throttled tick
    // as a wall-clock jump one cadence forward drained by a minimal tick, so the detector's fire sees a ~sixty-second gap every time - larger than the normal cadence yet
    // well short of a real suspension. The detector reads no visibility state, so this case is told apart from a suspension by gap magnitude alone: a throttle-range gap
    // never probes.
    const throttledCadenceMs = 60000;

    for(let i = 0; i < 5; i++) {

      t.mock.timers.setTime(Date.now() + throttledCadenceMs);
      t.mock.timers.tick(1);
    }

    assert.equal(viewRequests.length, 1, "throttled hidden-tab ticks fired no probe - each gap stayed under the threshold");

    // Then a genuine OS suspension: one multi-minute jump. Its drained fire sees a gap far past the threshold, so exactly one probe fires for the viewed device.
    t.mock.timers.setTime(Date.now() + (6 * RESUME_GAP_THRESHOLD_MS));
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);

    assert.deepEqual(viewRequests, [ { serialNumber: "AA" }, { serialNumber: "AA" } ], "the multi-minute suspension fired exactly one probe for the viewed device");
  });

  test("P34/r4: an aborted mount's detector is cleared - a later jump and tick neither probes nor throws", async (t) => {

    enableResumeTimers(t);

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { controller } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    await flushImmediate();

    // Abort the mount: the combined teardown hook clears the detector interval. A jump and tick afterward find no live interval, so nothing probes and a tick reading a
    // torn-down document does not throw.
    controller.abort();

    t.mock.timers.setTime(Date.now() + (6 * RESUME_GAP_THRESHOLD_MS));
    assert.doesNotThrow(() => t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS), "a tick after teardown does not throw");
    assert.equal(viewRequests.length, 1, "the cleared detector fired no probe after abort");
  });

  test("P35/r5: a resume probe fires even when the link-lost marker is already set", (t) => {

    enableResumeTimers(t);

    using _dom = createTestDom();

    const { deferreds, fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // View a device whose view request hangs, then trip the link-lost state on its two-second deadline. Two seconds is under the fifteen-second cadence, so the detector
    // has not yet fired and its last-tick clock is still the mount time.
    selectDevice(store, "AA");
    assert.equal(deferreds.length, 1, "the initial view request is held open");
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the panel tripped to link-lost");

    // Jump past the threshold and drain one cadence: the probe fires a new view request for the viewed device even though the marker is set. Counting view requests, not
    // callback fires, keeps the backlog drain (many fires, one probe) from confusing the assertion.
    t.mock.timers.setTime(Date.now() + (6 * RESUME_GAP_THRESHOLD_MS));
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);

    assert.equal(deferreds.length, 2, "the resume fired one new view request even with the marker set");
    assert.equal(deferreds[1].body.serialNumber, "AA", "the probe targeted the viewed device");
  });

  test("P36/r6: with no device viewed, a jump and tick fires no probe", (t) => {

    enableResumeTimers(t);

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);

    mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    // No device is ever selected, so viewedDevice stays null. The detector's viewed-device check comes first, so a big-gap tick reads no device and skips before the
    // serialNumber dereference could run.
    t.mock.timers.setTime(Date.now() + (6 * RESUME_GAP_THRESHOLD_MS));
    assert.doesNotThrow(() => t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS), "a no-device tick does not throw");
    assert.equal(viewRequests.length, 0, "no probe fired without a viewed device");
  });

  test("P37/r7: after a trip, a hanging resume probe re-arms the watchdog and trips again on the fresh deadline", (t) => {

    enableResumeTimers(t);

    using _dom = createTestDom();

    const { fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ linkLostTimeoutSeconds: 30, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Trip once on the hanging initial request. A thirty-second deadline sits above the fifteen-second cadence, so the single drain tick that fires the resume probe
    // cannot also reach the fresh deadline the probe arms - the probe and the follow-on trip land in separate advances (the tick-sizing note).
    selectDevice(store, "AA");
    t.mock.timers.tick(30001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the initial hanging request tripped the link-lost state");

    // A connecting push clears the marker so the follow-on trip is observable as a fresh flip; the prior watchdog is already spent, so its cancel here is a no-op.
    fake.observed.emitPush(STATUS_EVENT, connectingEvent("AA", 1));
    assert.equal(valueFor(root, "Status"), "Connecting...", "the connecting push cleared the first trip's link-lost state");

    // A page resume: jump past the threshold and drain one cadence. The first drained fire probes with a hanging request and re-arms the watchdog; the drain reach stays
    // short of the thirty-second fresh deadline, so no trip yet.
    t.mock.timers.setTime(Date.now() + (6 * RESUME_GAP_THRESHOLD_MS));
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);
    assert.equal(valueFor(root, "Status"), "Connecting...", "the resume probe fired but its fresh deadline has not elapsed");

    // The fresh deadline elapses in a separate advance: the re-armed watchdog trips again, proving the detector composes with the shipped re-arm machinery.
    t.mock.timers.tick(30001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the re-armed watchdog tripped again on the resume probe's fresh deadline");
  });
});

describe("statusPanel - the shared liveness delegation", () => {

  test("the resume probe is registered through the injected detector by reference, gated on a viewed device and scoped to the mount signal", () => {

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    // A stand-in for the page's detector that records exactly what the panel registered. This is the delegation's own boundary: the panel holds no cadence, no clock,
    // and no interval of its own, so whatever arrives here IS the whole of its resume mechanism.
    const registrations = [];
    const spyDetector = { subscribe: (callback, options) => registrations.push({ callback, options }) };

    const store = readyStore([DEVICE_A]);
    const { controller } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store, { resumeDetector: spyDetector });

    assert.equal(registrations.length, 1, "the panel registers exactly one resume subscriber");

    const { callback, options } = registrations[0];

    assert.equal(options.signal, controller.signal, "the subscription is scoped to the mount signal, so teardown ends it without the panel unsubscribing");
    assert.equal(options.shouldProbe(), false, "with no device viewed the panel's gate is shut");

    selectDevice(store, "AA");

    const requestsAfterSelection = viewRequests.length;

    assert.equal(options.shouldProbe(), true, "with a device viewed the gate opens");

    // Firing the registered callback is what the page's detector does on a resume, so driving it directly proves the panel's end of the contract without a clock.
    callback();

    assert.equal(viewRequests.length, requestsAfterSelection + 1, "the registered callback fires the panel's own view request");
    assert.equal(viewRequests.at(-1).serialNumber, "AA", "the probe targets the viewed device");
  });

  test("a page that supplies no detector registers nothing and still behaves normally between resumes", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setInterval", "setTimeout" ] });

    using _dom = createTestDom();

    const { fake, viewRequests } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store, { resumeDetector: null });

    // Heal the selection's own view request so the mount carries no pending deadline into the clock advance below.
    selectDevice(store, "AA");
    await flushImmediate();
    assert.equal(viewRequests.length, 1, "the selection still fires its own view request");

    // A resume-sized wall-clock jump reaches nothing: with no detector there is no subscription and no sampler to notice it.
    t.mock.timers.setTime(Date.now() + (6 * RESUME_GAP_THRESHOLD_MS));
    t.mock.timers.tick(RESUME_CHECK_INTERVAL_MS);

    assert.equal(viewRequests.length, 1, "no resume probe fires without a detector");
    assert.equal(valueFor(root, "Status"), "Connecting...", "and the panel is otherwise entirely normal");
  });

  test("the delegated watchdog keeps the shared-timer schedule: a second watched request does NOT push the first's deadline out", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 10, placeholderRows: PLACEHOLDER_ROWS }, store);

    // This test body runs synchronously with no flush, so the initial view request's watchdog timer armed by selectDevice is still pending when the first
    // handle.watchRequest call below runs - that call rides the same still-armed deadline rather than starting from a healed state. The shared-timer assertion below
    // holds either way, since the pending timer is never cleared in between.
    selectDevice(store, "AA");

    handle.watchRequest(hangingPromise());

    // Advance most of the way to the first arm's deadline, THEN feed a second request. A hand-rolled implementation that re-armed on every feed would push the trip out
    // to eight seconds from here; the shared timer must still fire on the FIRST arm's schedule, two seconds from here. This is the semantic that tells the delegation
    // apart from a re-implementation that merely looks the same in the simple cases.
    t.mock.timers.tick(8000);
    handle.watchRequest(hangingPromise());

    t.mock.timers.tick(1999);
    assert.equal(valueFor(root, "Status"), "Connecting...", "the shared deadline has not elapsed yet");

    t.mock.timers.tick(2);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the trip landed on the FIRST arm's schedule - one shared timer, not one per request");
  });

  test("teardown retires the pending deadline through the primitive's own abort contract - the component registers no cancel of its own", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { deferreds, fake } = fakeWithDeferredView();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { controller, root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    assert.equal(deferreds.length, 1, "precondition: a view request is pending with the deadline armed");

    // The component's own teardown hook clears latch timers and nothing else, so if the watchdog were still component-owned this deadline would survive the abort and
    // trip against a torn-down mount. It does not, because the primitive retires it on the same signal.
    controller.abort();
    t.mock.timers.tick(LINK_LOST_DEADLINE_MS + 1);

    assert.equal(valueFor(root, "Status"), "Connecting...", "no trip fired after teardown");
  });

  test("a watched request that resolves cancels detection but does NOT clear an already-tripped render", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    await flushImmediate();

    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "precondition: the panel tripped to link-lost");

    // A settling probe is liveness for DETECTION, not evidence for the RENDER: only a real push - or a fresh server hello - retires the honest lost-link state, because
    // only those prove the feed behind the relay is alive again.
    const probe = deferred();

    handle.watchRequest(probe.promise);
    probe.resolve(null);
    await flushImmediate();

    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "the tripped Status stands");
    assert.equal(messageText(root), LINK_LOST_MESSAGE, "and so does its message");
    assert.ok(reloadAnchorIn(root), "and its reload action");
  });
});

describe("statusPanel - a fresh server hello retires a lost-link presentation", () => {

  // Trip the panel to link-lost on a hanging probe, so each test below starts from a fully rendered lost-link presentation.
  const tripped = (t, { onServerHello } = {}) => {

    const { fake } = fakeWithViewCapture();
    const hb = installHomebridge(fake);
    const store = readyStore([DEVICE_A]);
    const mounted = mountPanel({ linkLostTimeoutSeconds: 2, onServerHello, placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    mounted.handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);

    return { fake, hb, ...mounted };
  };

  test("B-HELLO: a fresh-generation hello clears the message AND restores the Status cell, then notifies the plugin", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    // Record the Status text as the callback sees it: the local restore must be complete before the plugin is notified, so a callback that immediately re-elicits
    // pushes races nothing.
    const seenByCallback = [];
    const { fake, hb, root } = tripped(t, { onServerHello: () => seenByCallback.push(valueFor(root, "Status")) });

    using _hb = hb;

    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "precondition: the Status cell carries the link-lost label");
    assert.equal(messageText(root), LINK_LOST_MESSAGE, "precondition: the link-lost message is rendered");
    assert.ok(reloadAnchorIn(root), "precondition: the reload action is rendered");

    fake.observed.emitPush(STATUS_EVENT, helloEvent(7));

    // A hello proves the relay and the adapter alive, so the whole lost-link presentation goes - both halves of it. The Status cell returns to the connecting
    // placeholder rather than to a connected label: the relay is proven, the device's own state is not, and the re-elicited pushes are what will say more.
    assert.equal(messageText(root), null, "the lost-link message is cleared");
    assert.equal(reloadAnchorIn(root), null, "and its reload action with it");
    assert.equal(valueFor(root, "Status"), "Connecting...", "the Status cell returns to the connecting placeholder rather than staying stuck on the link-lost label");

    assert.deepEqual(seenByCallback, ["Connecting..."], "onServerHello fired exactly once, AFTER the local restore had completed");
  });

  test("B-HELLO: a fresh hello returns the viewed device's own state to Connecting..., so its pre-trip status does not come back unproven", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Give A a real connected state with a row value, then trip the watchdog over it.
    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }]));

    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "precondition: the panel is tripped");

    // The hello proves the relay, not the device. A push would bring A's connected label back because the device itself said so; a hello carries no such news, so A's
    // state records the honest verdict and the panel waits for the re-elicited pushes to say more.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(3));

    assert.equal(valueFor(root, "Status"), "Connecting...", "the viewed device's status went back to the connecting placeholder");
    assert.equal(messageText(root), null, "with no message left behind");
    assert.equal(valueFor(root, "Door"), "Open", "the row values stand - the hello says nothing about them");

    // The reset landed in A's own state rather than only on screen: leaving and coming back still shows Connecting..., never the pre-trip connected label.
    selectGlobal(store);
    selectDevice(store, "AA");
    assert.equal(valueFor(root, "Status"), "Connecting...", "the reset was written to A's state, so a reselection renders it too");
  });

  test("B-HELLO: a same-generation hello leaves a tripped presentation exactly as it was", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    let callbacks = 0;
    const { fake, handle, hb, root } = tripped(t, { onServerHello: () => callbacks++ });

    using _hb = hb;

    // Adopt generation 7, which retires the first trip, then trip again and re-send the SAME generation. A duplicate hello is not evidence of anything new, so it
    // must not touch the presentation the second trip rendered.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(7));
    assert.equal(callbacks, 1, "the first hello was a fresh generation");

    fake.observed.emitPush(STATUS_EVENT, connectingEvent("AA", 1));

    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);
    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "precondition: the panel is tripped again");

    fake.observed.emitPush(STATUS_EVENT, helloEvent(7));

    assert.equal(valueFor(root, "Status"), LINK_LOST_LABEL, "a duplicate generation leaves the Status cell tripped");
    assert.equal(messageText(root), LINK_LOST_MESSAGE, "and leaves its message rendered");
    assert.ok(reloadAnchorIn(root), "and leaves its reload action rendered");
    assert.equal(callbacks, 1, "and notifies the plugin no second time");
  });

  test("B-HELLO: a hello after a trip with no device viewed restores the no-device state, so a later selection still renders Connecting...", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { handle, root } = mountPanel({ linkLostTimeoutSeconds: 2, placeholderRows: PLACEHOLDER_ROWS }, store);

    // Trip with nothing on screen: the marker and the Status text are set, but no panel is mounted for them to render into.
    handle.watchRequest(hangingPromise());
    t.mock.timers.tick(2001);

    // The hello retires that inert trip. With no device viewed there is no connecting state to return to, so the Status text goes back to the empty no-device state
    // rather than to a placeholder describing a device that is not being viewed.
    fake.observed.emitPush(STATUS_EVENT, helloEvent(4));

    selectDevice(store, "AA");

    assert.equal(valueFor(root, "Status"), "Connecting...", "the later selection renders its own connecting placeholder, not a stale link-lost label");
    assert.equal(messageText(root), null, "and carries no lingering lost-link message");
    assert.equal(reloadAnchorIn(root), null, "and no lingering reload action");
  });

  test("B-HELLO: a hello with nothing tripped is inert - it touches neither the Status cell nor the panel", (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using _dom = createTestDom();

    const { fake } = fakeWithViewCapture();

    using _hb = installHomebridge(fake);

    const store = readyStore([DEVICE_A]);
    const { root } = mountPanel({ placeholderRows: PLACEHOLDER_ROWS }, store);

    selectDevice(store, "AA");
    fake.observed.emitPush(STATUS_EVENT, snapshotEvent("AA", 1, [{ id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" }], true));
    assert.equal(valueFor(root, "Status"), LOCKED_CONNECTED, "precondition: the panel is connected, not tripped");

    const panelBefore = root.firstChild;

    fake.observed.emitPush(STATUS_EVENT, helloEvent(9));

    assert.equal(valueFor(root, "Status"), LOCKED_CONNECTED, "a hello against an untripped panel leaves the Status cell alone");
    assert.equal(root.firstChild, panelBefore, "and rebuilds nothing - the restore is a no-op when nothing is tripped");
    assert.equal(valueFor(root, "Door"), "Open", "the live row value stands");
  });
});
