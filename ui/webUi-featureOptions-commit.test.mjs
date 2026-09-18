/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-featureOptions-commit.test.mjs: Integration-level tests for commitConfig, the page's coordinated configuration write. Companion to
 * webUi-featureOptions.test.mjs - that file asserts the show / hide / render / nav lifecycle, this one asserts the write: what reaches the host and in what order,
 * what the page looks like afterwards, and what a plugin is told when the page cycle the call started against is gone by the time it finishes.
 */
"use strict";

import { createFakeHomebridge, createSkeletonFeatureOptionsDom, createTestDom, installHomebridge, openTestSession, seedBootstrapProbeShim,
  waitFor } from "./ui.helpers.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { webUiFeatureOptions } from "./webUi-featureOptions.mjs";

// The catalog every page in this file boots against: two categories, one option each, which is enough for a table edit to have somewhere to land.
const FEATURES = {

  categories: [

    { description: "Motion Options", name: "Motion" },
    { description: "Audio Options", name: "Audio" },
    { description: "Network Options", name: "Network" }
  ],

  options: {

    Audio: [{ default: false, description: "Enable audio capture.", name: "Capture" }],
    Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }],
    Network: [{ default: false, defaultValue: "1500", description: "MTU.", name: "Mtu" }]
  }
};

const CONTROLLER_A = { address: "10.0.0.1", name: "Hub A", serialNumber: "CTRL-A" };
const CONTROLLER_B = { address: "10.0.0.2", name: "Hub B", serialNumber: "CTRL-B" };

// A controller's device list, led by the controller's own row: that row is what `isController` names, so it is the controller's identity on the page and what a
// selection lands on. The camera beneath it is what a device selection points at.
const devicesOf = (controller) => [

  { firmwareRevision: "1.0", manufacturer: "Acme", model: "Hub", name: controller.name, serialNumber: controller.serialNumber },
  { firmwareRevision: "2.0", manufacturer: "Acme", model: "Cam", name: "Front Door", serialNumber: controller.serialNumber + "-CAM" }
];

// The plugin's configuration: the controllers a plugin keeps in its own config block, which is exactly what a composer in these tests rewrites.
const makePluginConfig = ({ controllers = [CONTROLLER_A], options = [] } = {}) => [{ controllers, name: "TestPlugin", options, platform: "TestPlugin" }];

/* Build a controller-based page and everything a test drives it with.
 *
 * The plugin's hooks are written the way a real one writes them: `getControllers` derives its list from the injected config rather than from a list the test holds,
 * so a composer that rewrites `controllers` changes what the next fetch answers, and `getDevices` answers from the list it is asked about. Both are routed through
 * `hooks`, whose counters and deferrals let a test hold one call open without touching the others.
 *
 * Returns the fake bridge, the orchestrator, the skeleton's elements, and the recording surfaces - `hooks.controllerCalls`, `hooks.deviceCalls`, `loaded` (the
 * onLoaded count), and `panels` (every bag the device-info hook was handed).
 */
const makePage = ({ config = makePluginConfig(), epochSignal = undefined } = {}) => {

  const skeleton = createSkeletonFeatureOptionsDom();
  const fake = createFakeHomebridge({ config, requestResponses: new Map([[ "/getOptions", FEATURES ]]) });
  const homebridgeGuard = installHomebridge(fake);

  seedBootstrapProbeShim();

  const hooks = { controllerCalls: 0, deviceCalls: [], onControllers: null, onDevices: null };
  const panels = [];
  const state = { loaded: 0 };

  const orchestrator = new webUiFeatureOptions({

    getControllers: ({ config: platform }) => {

      hooks.controllerCalls += 1;

      const answer = { controllers: platform.controllers ?? [], error: "" };

      return hooks.onControllers ? hooks.onControllers({ answer, call: hooks.controllerCalls }) : answer;
    },
    getDevices: (controller) => {

      hooks.deviceCalls.push(controller?.serialNumber ?? null);

      const answer = { devices: controller ? devicesOf(controller) : [], error: "" };

      return hooks.onDevices ? hooks.onDevices({ answer, call: hooks.deviceCalls.length, controller }) : answer;
    },
    infoPanel: (bag) => panels.push(bag),
    onLoaded: () => { state.loaded += 1; },
    ui: { isController: (device) => !device?.serialNumber?.endsWith("-CAM") }
  }, { epochSignal });

  return {

    fake,
    hooks,
    orchestrator,
    panels,
    skeleton,
    state,

    [Symbol.dispose]() {

      const errors = [];

      try { orchestrator.cleanup(); } catch(error) { errors.push(error); }
      try { homebridgeGuard[Symbol.dispose](); } catch(error) { errors.push(error); }

      if(errors.length === 1) {

        throw errors[0];
      }

      if(errors.length > 1) {

        throw new AggregateError(errors, "teardown failed");
      }
    }
  };
};

/* Hold the host's configuration write open. The fake's own recording is preserved - `observed.calls` and `observed.updatedConfigs` read exactly as they would -
 * and only the settlement becomes the test's to choose, which is how every "while the write is in flight" window in this file is opened.
 */
const holdWrites = (fake) => {

  const settlers = [];
  const original = fake.updatePluginConfig;

  fake.updatePluginConfig = async (next) => {

    await original(next);

    return new Promise((resolve, reject) => settlers.push({ reject, resolve }));
  };

  return {

    fail: (error) => settlers.shift().reject(error),
    get pending() {

      return settlers.length;
    },
    release: () => settlers.shift().resolve()
  };
};

// Hold the host's save open, on the same reasoning as holdWrites: the save is a separate act with its own failure, and a page must not wait on it.
const holdSaves = (fake) => {

  const settlers = [];
  const original = fake.savePluginConfig;

  fake.savePluginConfig = async () => {

    await original();

    return new Promise((resolve, reject) => settlers.push({ reject, resolve }));
  };

  return {

    fail: (error) => settlers.shift().reject(error),
    get pending() {

      return settlers.length;
    },
    release: () => settlers.shift().resolve()
  };
};

// Drain the async work a dispatch or a host answer schedules, without an arbitrary wall-clock wait. Four cycles covers the deepest chain the page produces: a
// dispatch runs its subscribers, whose renders schedule follow-up work of their own.
const flush = async () => {

  for(let i = 0; i < 4; i++) {

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
};

// The options array the host last had written to it - what a plugin's own Save would put on disk.
const lastWritten = (fake) => fake.observed.updatedConfigs.at(-1)?.[0]?.options;

// Expand a category so its rows materialize under the lazy-rendering contract, and hand back the option's own checkbox.
const optionRow = (skeleton, category, option) => {

  skeleton.configTable.querySelector("details[data-category='" + category + "'] summary").click();

  return skeleton.configTable.querySelector("[id='row-" + option + "'] input[type='checkbox']");
};

// Whether the option table is rendering inert, which is how the hold a coordinated write takes is visible to a user and to a test.
const tableHeld = (skeleton) => skeleton.configTable.classList.contains("fo-options-busy");

describe("webUiFeatureOptions.commitConfig - the write", () => {

  test("a write that rewrites the options leaves them on the host: the next table edit carries the post-write array", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ options: [ "Enable.Motion.Detect", "Disable.Audio.Capture" ] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    // The plugin sweeps one entry and keeps the other, the shape that leaves a second-session writer's page holding a stale array.
    const result = await page.orchestrator.commitConfig(() => ({ options: ["Enable.Motion.Detect"] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "the write reached the host and was saved");
    assert.deepEqual(lastWritten(page.fake), ["Enable.Motion.Detect"], "precondition: the swept array is what the host holds");

    // One table edit afterwards. Its commit carries the whole options array, so the array it starts from is the entire question this row exists for.
    optionRow(page.skeleton, "Audio", "Audio.Capture").click();

    await waitFor(() => lastWritten(page.fake).length > 1, { message: "the table edit must reach the host" });

    assert.ok(!lastWritten(page.fake).includes("Disable.Audio.Capture"), "the swept entry must not return: the edit composed against the written options");
    assert.ok(lastWritten(page.fake).includes("Enable.Motion.Detect"), "and the surviving entry is still there");
  });

  test("a pending edit is written first, and the composer sees it", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    // The edit is inside the persist debounce and has reached no host yet, which is the state the call has to resolve before it composes.
    assert.equal(page.fake.observed.updatedConfigs.length, 0, "precondition: nothing has been written yet");

    const composed = [];
    const result = await page.orchestrator.commitConfig((platform) => {

      composed.push([...platform.options]);

      return { controllers: [ CONTROLLER_A, CONTROLLER_B ] };
    });

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.equal(composed.length, 1, "the composer runs exactly once");
    assert.ok(composed[0].some((entry) => entry.includes("Motion.Detect")), "and it composes against the configuration the user's edit had already reached");
    assert.deepEqual(page.fake.observed.calls.filter((call) => call === "updatePluginConfig").length, 2, "the edit's write and the verb's write, in that order");
  });

  test("a drain whose write the host refuses fails the call before anything is composed", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const refusal = new Error("Disk write failed");
    let calls = 0;
    const original = page.fake.updatePluginConfig;

    page.fake.updatePluginConfig = async (next) => {

      calls += 1;

      await original(next);

      throw refusal;
    };

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    const composed = [];
    const result = await page.orchestrator.commitConfig(() => {

      composed.push(true);

      return { controllers: [] };
    });

    assert.equal(result.kind, "failed", "a write the page could not land is not a page the plugin may write over");
    assert.equal(result.error, refusal, "and the call carries the host's own refusal");
    assert.equal(composed.length, 0, "the composer never ran");
    assert.equal(calls, 1, "the only write attempted was the user's own edit");
  });

  test("a failure recorded before the call, with nothing pending, does not fail it", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    let refuse = true;
    const original = page.fake.updatePluginConfig;

    page.fake.updatePluginConfig = async (next) => {

      await original(next);

      if(refuse) {

        throw new Error("Disk write failed");
      }
    };

    // One edit the host refuses, and the rollback it produces. The store is clean afterwards and carries the failure as a record of something the user has been
    // shown - which is the distinguishing input against the row above, where the failure was this call's own drain.
    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    await waitFor(() => page.fake.observed.updatedConfigs.length === 1, { message: "the refused edit must reach the host" });
    await flush();

    refuse = false;

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "a failure the user has already been shown is not this call's to report");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2, "and the page is established on what was written");
  });

  test("the table is held from the composer's turn until the establishment, and a gesture inside that window writes nothing", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const detect = optionRow(page.skeleton, "Motion", "Motion.Detect");

    assert.equal(tableHeld(page.skeleton), false, "precondition: the table is live");

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the verb's write must reach the host" });

    assert.equal(tableHeld(page.skeleton), true, "the hold renders the table inert");

    detect.click();

    await flush();

    assert.equal(page.fake.observed.updatedConfigs.length, 1, "a gesture under the hold reaches no host");

    writes.release();

    assert.deepEqual(await pending, { kind: "committed" });

    await flush();

    assert.equal(tableHeld(page.skeleton), false, "the establishment lifts the hold");
    assert.equal(page.fake.observed.updatedConfigs.length, 1, "and the refused gesture stayed refused");
  });

  test("overlapping calls serialize, and the second composes against what the first wrote", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);
    const composed = [];
    const first = page.orchestrator.commitConfig((platform) => {

      composed.push(platform.controllers.map((entry) => entry.serialNumber));

      return { controllers: [ CONTROLLER_A, CONTROLLER_B ] };
    });
    const second = page.orchestrator.commitConfig((platform) => {

      composed.push(platform.controllers.map((entry) => entry.serialNumber));

      return { controllers: [CONTROLLER_B] };
    });

    await waitFor(() => writes.pending === 1, { message: "the first call's write must reach the host" });

    assert.deepEqual(composed, [["CTRL-A"]], "the second composer waits: only the first has run");

    writes.release();

    await waitFor(() => writes.pending === 1, { message: "the second call's write must follow the first" });

    assert.deepEqual(composed.at(-1), [ "CTRL-A", "CTRL-B" ], "the second composer sees what the first call wrote");

    writes.release();

    assert.deepEqual(await first, { kind: "committed" });
    assert.deepEqual(await second, { kind: "committed" });
  });

  test("a composer that throws rejects the call, releases the hold, and leaves the next call working", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const bug = new TypeError("Cannot read properties of undefined");

    await assert.rejects(() => page.orchestrator.commitConfig(() => { throw bug; }), (error) => error === bug,
      "a bug in the caller's own composer travels to the caller");

    await flush();

    assert.equal(tableHeld(page.skeleton), false, "the hold is released on the way out");
    assert.equal(page.fake.observed.updatedConfigs.length, 0, "and nothing was written");

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    assert.deepEqual(result, { kind: "committed" }, "the queue is not stranded behind the throw");
  });

  test("the host refusing the write answers failed and leaves the page exactly as it was", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ options: ["Enable.Motion.Detect"] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    const before = {

      controllers: page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length,
      options: [...page.orchestrator.editedConfig[0].options],
      selected: page.skeleton.sidebar.querySelector(".nav-link.active")?.getAttribute("data-device-serial")
    };
    const refusal = new Error("The host refused the write.");

    page.fake.updatePluginConfig = async () => { throw refusal; };

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.equal(result.kind, "failed");
    assert.equal(result.error, refusal, "the host's own error is what the plugin is told");
    assert.equal(tableHeld(page.skeleton), false, "the hold is released");
    assert.deepEqual(page.orchestrator.editedConfig[0].options, before.options, "the model is untouched");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, before.controllers, "the sidebar is untouched");
    assert.equal(page.skeleton.sidebar.querySelector(".nav-link.active")?.getAttribute("data-device-serial"), before.selected, "and so is the selection");
  });

  test("a save that fails answers staged, and the page is established exactly as for a committed write", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const refusal = new Error("The save failed.");

    page.fake.savePluginConfig = async () => { throw refusal; };

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.equal(result.kind, "staged", "the configuration changed, so the write is staged rather than failed");
    assert.equal(result.error, refusal, "carrying what the save refused with");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2,
      "and the page is reconciled to the new configuration exactly as a committed write reconciles it");
    assert.equal(page.fake.observed.calls.at(-1), "updatePluginConfig", "the host log ends on the stage, with no save behind it");
  });
});

describe("webUiFeatureOptions.commitConfig - the revert target", () => {

  test("a controllers-only write leaves the revert target where the page loaded it", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ options: ["Enable.Motion.Detect"] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    // An edit of the user's own, saved through the page's own drain. The revert target is the set the page loaded, and a save of theirs does not move it - which
    // is what makes the target and the configuration the write composes against two different things, and the row able to tell them apart.
    optionRow(page.skeleton, "Audio", "Audio.Capture").click();

    await waitFor(() => page.fake.observed.updatedConfigs.length === 1, { message: "the edit must reach the host" });
    await flush();

    await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));
    await flush();

    document.querySelector("button[data-action='reset-revert']").click();

    await flush();

    assert.deepEqual(page.orchestrator.editedConfig[0].options, ["Enable.Motion.Detect"],
      "the write changed no option, so revert still returns to what the page loaded rather than to what the user saved since");
  });

  test("a write that changes the options set moves the revert target onto what was written", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ options: ["Enable.Motion.Detect"] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    await page.orchestrator.commitConfig(() => ({ options: ["Disable.Audio.Capture"] }));
    await flush();

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    await waitFor(() => page.orchestrator.editedConfig[0].options.length > 1, { message: "the edit must reach the model" });

    document.querySelector("button[data-action='reset-revert']").click();

    await flush();

    assert.deepEqual(page.orchestrator.editedConfig[0].options, ["Disable.Audio.Capture"],
      "the written options are the saved state now, so they are what revert returns to");
  });
});

describe("webUiFeatureOptions.commitConfig - what the page looks like afterwards", () => {

  test("removing the last controller lands on the no-controllers message and still answers committed", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "the write landed, whatever the page has to say about the configuration it produced");
    assert.match(page.skeleton.headerInfo.textContent, /configure a controller/, "a plugin with nothing left configured gets the helper text, not an empty page");
  });

  test("removing the selected controller returns the selection to global and drops that controller's late device outcome", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    assert.equal(page.skeleton.sidebar.querySelector(".nav-link.active")?.getAttribute("data-device-serial"), "CTRL-A", "precondition: the first controller is selected");

    // Hold the click's device fetch open, so its outcome is still in flight when the write removes the controller it belongs to.
    let releaseDevices;

    page.hooks.onDevices = ({ answer }) => new Promise((resolve) => { releaseDevices = () => resolve(answer); });

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-A']").click();

    await flush();

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [CONTROLLER_B] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.equal(page.skeleton.controllersContainer.querySelector("[data-device-serial='CTRL-A']"), null, "the removed controller is gone from the sidebar");
    assert.equal(page.skeleton.devicesContainer.querySelectorAll(".nav-link").length, 0, "and its device list went with it");

    releaseDevices();

    await flush();

    assert.equal(page.skeleton.devicesContainer.querySelectorAll(".nav-link").length, 0, "a device outcome for a controller that is gone lands nowhere");
  });

  test("a hidden page's call still writes and saves, and the next show() carries what it wrote", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the edit's write must reach the host" });

    // The user leaves the page while the drain is still at the host. The write is what they asked for, so it happens whatever becomes of the page.
    const hidden = page.orchestrator.hide();

    writes.release();

    await waitFor(() => writes.pending === 1, { message: "the call's own write must follow the drain" });

    writes.release();

    assert.deepEqual(await pending, { kind: "committed" }, "a page that is gone does not cancel a write the user asked for");

    await hidden;
    await flush();

    await page.orchestrator.show(await openTestSession());
    await flush();

    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2, "the next page comes up on the written configuration");
  });

  test("a page torn down while the call's write is in flight still answers committed", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the call must be holding the store with its write at the host" });

    assert.equal(tableHeld(page.skeleton), true, "precondition: the call holds the cycle it is about to lose");

    // The page goes away under the call, which is a page fact rather than a write fact: only a newer copy of the whole page ends the write as superseded.
    page.orchestrator.cleanup();
    writes.release();

    assert.deepEqual(await pending, { kind: "committed" }, "the write landed and was saved, so that is what the plugin is told");

    await flush();

    assert.ok(page.fake.observed.calls.includes("savePluginConfig"), "and the save ran, because the page dying is not the epoch retiring");
  });

  test("a page re-shown during the drain is the page the call drains, holds, and establishes", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.state.loaded = 0;

    const writes = holdWrites(page.fake);

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the edit's write must reach the host" });

    const reshown = page.orchestrator.show(await openTestSession());

    // The teardown waits for that same drain, bounded, and the bound is what elapses here - so the successor boots while the held write is still at the host.
    t.mock.timers.tick(2001);

    await waitFor(() => page.state.loaded === 1, { message: "the successor's boot must complete" });
    await flush();

    writes.release();

    await waitFor(() => writes.pending === 1, { message: "the call's own write must follow the drain it was waiting on" });

    writes.release();

    assert.deepEqual(await pending, { kind: "committed" });

    await reshown;
    await flush();

    assert.equal(page.fake.observed.updatedConfigs.length, 2, "the drain's write landed once, and the call's own write followed it");
    assert.equal(page.state.loaded, 1, "the successor's own boot announced once, and the establishment over it announced not at all");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2,
      "the cycle the call drained and held is the one established on what it wrote");
  });

  test("a show() entered while the call's commit is in flight reads no configuration until that commit settles", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the call's write must reach the host" });

    const successor = await openTestSession();
    const marker = page.fake.observed.calls.length;
    const reshown = page.orchestrator.show(successor);

    await flush();

    assert.ok(!page.fake.observed.calls.slice(marker).includes("getPluginConfig"),
      "the successor reads no configuration while a write it must follow is still at the host");

    writes.release();

    assert.deepEqual(await pending, { kind: "committed" });

    await reshown;
    await flush();

    assert.ok(page.fake.observed.calls.slice(marker).includes("getPluginConfig"), "and it reads once that write has settled");
  });

  test("a show() entered while the call is parked on the teardown's own flush still follows the commit that flush releases", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the edit's write must reach the host" });

    // The call and the teardown are parked on the same drain. The call resumes first and issues its commit inside that window, which is a commit the teardown's
    // own read could never have seen - and the read after the teardown is what catches it.
    const successor = await openTestSession();
    const marker = page.fake.observed.calls.length;
    const reshown = page.orchestrator.show(successor);

    writes.release();

    await waitFor(() => writes.pending === 1, { message: "the call's commit must be issued while the teardown drains" });
    await flush();

    const readsBeforeRelease = page.fake.observed.calls.slice(marker).filter((call) => call === "getPluginConfig").length;

    writes.release();

    assert.deepEqual(await pending, { kind: "committed" });

    await reshown;
    await flush();

    assert.equal(readsBeforeRelease, 0, "no configuration is read while that commit is outstanding");
    assert.ok(page.fake.observed.calls.slice(marker).includes("getPluginConfig"), "and the successor's read lands once it settles");
  });

  test("a show() entered while the call's save is in flight does not wait for it", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const saves = holdSaves(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => saves.pending === 1, { message: "the call's save must reach the host" });

    const successor = await openTestSession();
    const marker = page.fake.observed.calls.length;
    const reshown = page.orchestrator.show(successor);

    await waitFor(() => page.fake.observed.calls.slice(marker).includes("getPluginConfig"),
      { message: "the successor must read the configuration without waiting for the save" });

    saves.release();

    assert.deepEqual(await pending, { kind: "committed" });

    await reshown;
    await flush();
  });

  test("the epoch aborting between the write and the save answers superseded and leaves the write staged", async () => {

    using dom = createTestDom();

    const epoch = new AbortController();

    using page = makePage({ epochSignal: epoch.signal });

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the call's write must reach the host" });

    epoch.abort();
    writes.release();

    assert.deepEqual(await pending, { kind: "superseded" }, "a retired copy renders nothing, so it answers with the one member that says so");

    await flush();

    assert.ok(page.fake.observed.calls.includes("updatePluginConfig"), "the write itself reached the host");
    assert.ok(!page.fake.observed.calls.includes("savePluginConfig"), "and it stays staged there for the user's own save");
  });

  test("a page hidden and re-shown during the post-write controller fetch answers committed and touches no successor", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.state.loaded = 0;

    // Hold the call's own controller refetch open. The successor's boot, which is a later call, answers normally.
    let releaseControllers;

    page.hooks.onControllers = ({ answer, call }) => {

      if(call !== 2) {

        return answer;
      }

      return new Promise((resolve) => { releaseControllers = () => resolve(answer); });
    };

    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => Boolean(releaseControllers), { message: "the call's controller refetch must be outstanding" });

    await page.orchestrator.hide();
    await page.orchestrator.show(await openTestSession());
    await flush();

    releaseControllers();

    assert.deepEqual(await pending, { kind: "committed" });

    await flush();

    assert.equal(page.state.loaded, 1, "only the successor's own boot announced");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2,
      "and the sidebar is the one the successor's boot built");
  });

  test("a call from the connection-error frame re-enters show() and answers committed", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.state.loaded = 0;

    // A sidebar click whose fetch fails is what puts a loaded page on the error frame.
    page.hooks.onDevices = () => Promise.reject(new Error("Controller unreachable."));

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await waitFor(() => page.skeleton.headerInfo.textContent.includes("Unable to connect"), { message: "the error frame must render" });

    page.hooks.onDevices = null;

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [CONTROLLER_A] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.ok(!page.skeleton.headerInfo.textContent.includes("Unable to connect"),
      "the write changed the configuration the error came from, so the frame is re-evaluated");
    assert.equal(page.state.loaded, 1, "through a fresh show cycle, which announces once");
  });

  test("a call from a page whose model never loaded writes, saves, and re-enters show()", async () => {

    using dom = createTestDom();
    using page = makePage();

    // The boot's own config re-sync fails, so the page never reaches a loaded model and stands on the error frame instead.
    let failSync = false;
    const original = page.fake.getPluginConfig;

    page.fake.getPluginConfig = async () => {

      if(failSync) {

        failSync = false;

        throw new Error("The Homebridge server is unreachable.");
      }

      return original();
    };

    const session = await openTestSession();

    failSync = true;

    await page.orchestrator.show(session);
    await flush();

    assert.equal(page.state.loaded, 0, "precondition: no model ever loaded");

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "the write is the user's intent and does not need a loaded page");
    assert.equal(page.state.loaded, 1, "and the fresh boot is the honest re-evaluation of the configuration it changed");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2, "which comes up on what was written");
  });

  test("a controller fetch that fails after the write re-enters show(), which carries the failure", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.hooks.onControllers = ({ call }) => (call === 1) ? { controllers: [CONTROLLER_A], error: "" } : Promise.reject(new Error("Controller unreachable."));

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "the write landed, and the fetch that followed it is a page problem rather than a write problem");
    assert.match(page.skeleton.headerInfo.textContent, /Unable to retrieve the controller list/, "the boot's own retry view carries the failure");
  });

  test("a wrong-shaped controller answer after the write re-enters show() without a TypeError leaving the call", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    // A plugin still on the bare-array contract, which is the shape the guard exists for.
    page.hooks.onControllers = ({ answer, call }) => (call === 1) ? answer : answer.controllers;

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "a hook that answered in the wrong shape does not turn a landed write into a failure");
    assert.match(page.skeleton.headerInfo.textContent, /getControllers must resolve/, "the boot routes the contract violation to the retry view");
  });
});

describe("webUiFeatureOptions.commitConfig - the selection after an establishment", () => {

  test("a device selection the refetched list still holds is left where it is, and no render hands the panel an undefined device", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.skeleton.devicesContainer.querySelector(".nav-link[data-device-serial='CTRL-A-CAM']").click();

    await waitFor(() => page.skeleton.devicesContainer.querySelector(".nav-link.active")?.getAttribute("data-device-serial") === "CTRL-A-CAM",
      { message: "the device must be selected before the write" });

    const fetchesBefore = page.hooks.deviceCalls.length;

    page.panels.length = 0;

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.equal(page.hooks.deviceCalls.length, fetchesBefore + 1, "the selected controller's devices are refetched, since a load reconciles controllers only");
    assert.equal(page.skeleton.devicesContainer.querySelector(".nav-link.active")?.getAttribute("data-device-serial"), "CTRL-A-CAM",
      "a device still on the list keeps the selection");
    assert.ok(page.panels.length > 0, "precondition: the plugin's panel rendered inside the window");
    assert.ok(page.panels.every((bag) => bag.device?.serialNumber === "CTRL-A-CAM"),
      "and every render inside the window carried the same device, so the card the plugin is rendering into is never torn down");
  });

  test("a device the refetched list no longer holds renders as gone once and moves the selection to the controller's own row", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.skeleton.devicesContainer.querySelector(".nav-link[data-device-serial='CTRL-A-CAM']").click();

    await waitFor(() => page.skeleton.devicesContainer.querySelector(".nav-link.active")?.getAttribute("data-device-serial") === "CTRL-A-CAM",
      { message: "the device must be selected before the write" });

    // The write takes the camera away, which only the refetch can discover: the model load that precedes it reconciles controllers and nothing else.
    page.hooks.onDevices = ({ answer }) => ({ ...answer, devices: answer.devices.filter((device) => !device.serialNumber.endsWith("-CAM")) });
    page.panels.length = 0;

    await page.orchestrator.commitConfig(() => ({ controllers: [CONTROLLER_A] }));
    await flush();

    assert.equal(page.panels.filter((bag) => bag.device === undefined).length, 1, "the departure renders exactly once, at the outcome");
    assert.equal(page.skeleton.devicesContainer.querySelector(".nav-link.active")?.getAttribute("data-device-serial"), "CTRL-A",
      "and the selection comes to rest on the controller's own row");
  });

  test("an establishment in place announces nothing, where a re-entering one announces once", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.state.loaded = 0;

    await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));
    await flush();

    assert.equal(page.state.loaded, 0, "the page a consumer is standing on is not a show cycle, so the hook that announces one stays quiet");

    // The same call from a page the boot has to own again - here because the fetch that follows the write fails, which only show() has a surface for. The boot it
    // re-enters answers normally and announces exactly as any other show cycle does.
    page.hooks.onControllers = ({ answer, call }) => (call === 3) ? Promise.reject(new Error("Controller unreachable.")) : answer;

    await page.orchestrator.commitConfig(() => ({ controllers: [CONTROLLER_A] }));
    await flush();

    assert.equal(page.state.loaded, 1, "a re-entry announces once, through show()");
  });
});

describe("webUiFeatureOptions.commitConfig - the caller's own bugs and the page's own edges", () => {

  test("a call before the first show() rejects, and one after cleanup() still writes and saves", async () => {

    using dom = createTestDom();
    using page = makePage();

    await assert.rejects(() => page.orchestrator.commitConfig(() => ({ controllers: [] })), /show\(\)/,
      "a page that has never been shown has no session to write through, and the message says so");

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.orchestrator.cleanup();

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    assert.deepEqual(result, { kind: "committed" }, "a torn-down page still owns the session, and the write is the user's intent rather than the page's");

    await page.orchestrator.show(await openTestSession());
    await flush();

    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2, "and the next page comes up on what it wrote");
  });

  test("a composer that is not a function rejects ahead of the queue", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the earlier call's write must be outstanding" });

    // The refusal settles while that write is still at the host, which is what "ahead of the queue" means: a caller bug waits for nothing.
    await assert.rejects(() => page.orchestrator.commitConfig({ controllers: [] }), TypeError, "a patch where a composer belongs is a bug in the call itself");

    assert.equal(writes.pending, 1, "and the earlier call is still exactly where it was");

    writes.release();

    assert.deepEqual(await pending, { kind: "committed" });
  });

  test("a focused value the user has typed but not committed is written ahead of the drain, and the composer sees it", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ options: ["Enable.Network.Mtu=1500"] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.skeleton.controllersContainer.querySelector("[data-navigation='global']").click();

    await flush();

    const valueInput = optionRow(page.skeleton, "Network", "Network.Mtu").closest("[id='row-Network.Mtu']").querySelector("input.fo-option-value");

    assert.ok(valueInput, "precondition: the value option renders its own input");

    // The user types and the plugin acts in the same moment: the input has fired no change, so only the page's own commit of the focused control can save it.
    valueInput.focus();
    valueInput.value = "9000";

    const composed = [];
    const result = await page.orchestrator.commitConfig((platform) => {

      composed.push([...platform.options]);

      return { controllers: [ CONTROLLER_A, CONTROLLER_B ] };
    });

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.ok(composed[0].includes("Enable.Network.Mtu=9000"), "the typed value was committed and written before the composer read the configuration");
    assert.ok(page.fake.observed.updatedConfigs[0][0].options.includes("Enable.Network.Mtu=9000"), "and it reached the host as its own write, ahead of the call's");
  });

  test("refreshControllers drops an outcome that answers for a configuration the page has moved off", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    // The refresh's own hook call is held open; the call's post-write refetch, which comes later, answers normally.
    let releaseRefresh;

    page.hooks.onControllers = ({ answer, call }) => {

      if(call !== 2) {

        return answer;
      }

      return new Promise((resolve) => { releaseRefresh = (controllers) => resolve({ controllers, error: "" }); });
    };

    const refreshing = page.orchestrator.refreshControllers();

    await waitFor(() => Boolean(releaseRefresh), { message: "the refresh's hook must be outstanding" });

    await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));
    await flush();

    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2, "precondition: the write established the new list");

    releaseRefresh([CONTROLLER_A]);

    assert.equal(await refreshing, false, "an outcome read from a configuration the write replaced reports no change");

    await flush();

    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2, "and the sidebar it would have repainted is untouched");
  });
});

describe("webUiFeatureOptions - the teardown's own edges", () => {

  test("hide() waits for a commit in flight, and hides nothing when the epoch aborts while it waits", async () => {

    using dom = createTestDom();

    const epoch = new AbortController();

    using page = makePage({ epochSignal: epoch.signal });

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the call's write must reach the host" });

    let hidden = false;
    const hiding = page.orchestrator.hide().then(() => { hidden = true; });

    await flush();

    assert.equal(hidden, false, "the teardown does not report itself finished while a write it issued is still at the host");

    // A newer page copy claims the window while the teardown waits, so the teardown must leave the regions that copy has rendered into alone.
    epoch.abort();
    writes.release();

    await hiding;

    assert.deepEqual(await pending, { kind: "superseded" });
    assert.equal(page.skeleton.sidebar.style.display, "", "a retired copy's teardown blanks nothing");
    assert.equal(page.skeleton.optionsContainer.style.display, "", "not one of the regions the live copy is showing");
  });

  test("show() mints no cycle when the epoch aborts during the teardown, and the prior store still answers editedConfig", async () => {

    using dom = createTestDom();

    const epoch = new AbortController();

    using page = makePage({ epochSignal: epoch.signal });

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);

    // An edit of the user's own, still at the host: the store carries it, which is what makes a store swap visible from outside.
    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    await waitFor(() => writes.pending === 1, { message: "the edit's write must reach the host" });

    const edited = [...page.orchestrator.editedConfig[0].options];

    assert.ok(edited.some((entry) => entry.startsWith("Disable.Motion.Detect")), "precondition: the store carries the edit");

    const reshown = page.orchestrator.show(await openTestSession());

    epoch.abort();
    writes.release();

    await reshown;
    await flush();

    assert.equal(page.skeleton.pageFeatureOptions.querySelector(".progress"), null, "no boot affordance: no cycle was minted");
    assert.equal(page.skeleton.sidebar.style.display, "", "and the teardown that ran inside it hid no region of the copy that took the window");
    assert.deepEqual(page.orchestrator.editedConfig[0].options, edited, "and the prior store still answers, where a fresh one would report the saved options");
  });
});
