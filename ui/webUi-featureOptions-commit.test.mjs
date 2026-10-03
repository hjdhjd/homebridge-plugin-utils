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
 * onLoaded count), and `panels` (every bag the device-info hook was handed). `plugin` adds options of the plugin's own on top of these, for a row that needs a
 * surface the default page leaves unconfigured.
 */
const makePage = ({ config = makePluginConfig(), plugin = {} } = {}) => {

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
    ui: { isController: (device) => !device?.serialNumber?.endsWith("-CAM") },
    ...plugin
  });

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
 *
 * `count` bounds how many writes are taken: each write past it settles on the host's own answer instead of waiting for the test. That is what lets a row hold one
 * write open, fail it, and still have the writes that follow reach the host under their own power - the shape a rescued failure takes.
 */
const holdWrites = (fake, { count = Infinity } = {}) => {

  const settlers = [];
  const original = fake.updatePluginConfig;
  let taken = 0;

  fake.updatePluginConfig = async (next) => {

    await original(next);

    if(taken >= count) {

      return;
    }

    taken += 1;

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

/** Expand a category so its rows materialize under the lazy-rendering contract, and hand back the option's own checkbox.
 *
 * @returns {Element | null} The option's checkbox once its category is expanded, or null when the option carries no row in the table.
 */
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

    // The edit is inside the staging debounce and has reached no host yet, which is the state the call has to resolve before it composes.
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

  test("a composer returning null answers unchanged, and the host records no configuration write and no save", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const callsBefore = page.fake.observed.calls.length;
    const result = await page.orchestrator.commitConfig(() => null);

    await flush();

    assert.deepEqual(result, { kind: "unchanged" }, "a composer that answers null is answered unchanged, not as a write");
    assert.equal(page.fake.observed.updatedConfigs.length, 0, "no configuration write reached the host");
    assert.deepEqual(page.fake.observed.calls.slice(callsBefore), [], "and neither did a save, nor the configuration read a re-entry would make");
  });

  test("an unchanged call leaves the page as it was: nothing is refetched, and an option edit afterwards is accepted and staged", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    optionRow(page.skeleton, "Motion", "Motion.Detect");

    const before = { controllerCalls: page.hooks.controllerCalls, deviceCalls: page.hooks.deviceCalls.length, loaded: page.state.loaded };

    assert.deepEqual(await page.orchestrator.commitConfig(() => null), { kind: "unchanged" });

    await flush();

    assert.equal(page.hooks.controllerCalls, before.controllerCalls, "the controller list is not refetched");
    assert.equal(page.hooks.deviceCalls.length, before.deviceCalls, "and neither are the devices");
    assert.equal(page.state.loaded, before.loaded, "and no fresh show cycle announced itself");
    assert.equal(tableHeld(page.skeleton), false, "the hold is released");

    page.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']").click();

    await waitFor(() => page.fake.observed.updatedConfigs.length === 1, { message: "the edit after an unchanged call must reach the host" });

    assert.ok(lastWritten(page.fake).some((entry) => entry.includes("Motion.Detect")), "the table accepted the edit and staged it");
  });

  test("a pending edit is drained before a composer that returns null, and stays written", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    assert.equal(page.fake.observed.updatedConfigs.length, 0, "precondition: the edit is still inside the staging debounce");

    const composed = [];
    const result = await page.orchestrator.commitConfig((platform) => {

      composed.push([...platform.options]);

      return null;
    });

    await flush();

    assert.deepEqual(result, { kind: "unchanged" });
    assert.ok(composed[0].some((entry) => entry.includes("Motion.Detect")), "the composer read the configuration the drained edit had already reached");
    assert.equal(page.fake.observed.updatedConfigs.length, 1, "the one write is the user's own edit, drained ahead of the composer");
    assert.ok(lastWritten(page.fake).some((entry) => entry.includes("Motion.Detect")), "and the host still holds that edit");
    assert.ok(page.orchestrator.editedConfig[0].options.some((entry) => entry.includes("Motion.Detect")), "as does the page");
  });

  test("the call after an unchanged one commits normally", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    assert.deepEqual(await page.orchestrator.commitConfig(() => null), { kind: "unchanged" });

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "neither the queue nor the hold is left behind");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll("[data-navigation='controller']").length, 2, "and the page is established on what was written");
  });

  test("a composer returning null on a page whose model never loaded answers unchanged with no write, no save, and no re-entry", async () => {

    using dom = createTestDom();
    using page = makePage();

    // The boot's own config re-sync fails, so the page never reaches a loaded model and the call takes no hold.
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

    const callsBefore = page.fake.observed.calls.length;
    const result = await page.orchestrator.commitConfig(() => null);

    await flush();

    assert.deepEqual(result, { kind: "unchanged" }, "the answer does not depend on a hold having been taken");
    assert.deepEqual(page.fake.observed.calls.slice(callsBefore), [], "no write, no save, and no re-entry's configuration read reached the host");
    assert.equal(page.state.loaded, 0, "and no fresh boot came up");
  });

  test("a composer returning null on the connection-error frame answers unchanged with no write, no save, and no re-entry", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.state.loaded = 0;

    // A sidebar click whose fetch fails is what puts a loaded page on the error frame.
    page.hooks.onDevices = () => Promise.reject(new Error("Controller unreachable."));

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await waitFor(() => page.skeleton.headerInfo.textContent.includes("Unable to retrieve the device list"), { message: "the error frame must render" });

    page.hooks.onDevices = null;

    const callsBefore = page.fake.observed.calls.length;
    const result = await page.orchestrator.commitConfig(() => null);

    await flush();

    assert.deepEqual(result, { kind: "unchanged" });
    assert.deepEqual(page.fake.observed.calls.slice(callsBefore), [], "no write, no save, and no re-entry's configuration read reached the host");
    assert.ok(page.skeleton.headerInfo.textContent.includes("Unable to retrieve the device list"),
      "the frame stands, since an unchanged call neither re-establishes nor re-enters the page");
    assert.equal(page.state.loaded, 0, "and no fresh show cycle announced itself");
  });

  test("a composer returning undefined still writes and answers committed", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const result = await page.orchestrator.commitConfig(() => undefined);

    await flush();

    assert.deepEqual(result, { kind: "committed" }, "only null answers unchanged");
    assert.equal(page.fake.observed.updatedConfigs.length, 1, "the write reached the host");
    assert.ok(page.fake.observed.calls.includes("savePluginConfig"), "and was saved");
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

  /* The page's side of the drain's rescued failure: a write the host refused, superseded by an edit before the refusal surfaced, ends with the store on its
   * anchor and the write lifecycle answered rather than parked at `staging` forever. The staging effect's own suite proves the drain swallows that failure;
   * this row proves what the page owes afterwards, because a coordinated write refuses to start against a claim it thinks is still in flight. The revert is what
   * takes the store back to the array it loaded, so it also shows the revert itself writing nothing: two writes reach the host, the refused edit and the
   * coordinated write, and never a third one for the revert.
   */
  test("a coordinated write takes the store a rescued drain left behind, and the revert that rescued it wrote nothing of its own", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ options: ["Enable.Motion.Detect"] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    // Only the first write is the test's to settle: the coordinated write below must reach the host under its own power.
    const writes = holdWrites(page.fake, { count: 1 });

    optionRow(page.skeleton, "Motion", "Motion.Detect").click();

    await waitFor(() => page.fake.observed.updatedConfigs.length === 1, { message: "the first edit's write must reach the host before it is held" });

    // A second edit while that write hangs marks the drain dirty, which is the condition under which it swallows the refusal rather than surfacing it. The revert
    // then returns the store to the options the page loaded - the same array its anchor holds - so the drain finds nothing left to write.
    optionRow(page.skeleton, "Motion", "Motion.Detect").click();
    document.querySelector("button[data-action='reset-revert']").click();

    writes.fail(new Error("The host refused the write."));

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await flush();

    const written = page.fake.observed.updatedConfigs.at(-1)[0];

    assert.deepEqual(result, { kind: "committed" }, "the write found no claim standing in its way and reached the host");
    assert.equal(page.fake.observed.updatedConfigs.length, 2, "the refused edit and the coordinated write are the only two writes: the revert wrote nothing");
    assert.deepEqual(written.options, ["Enable.Motion.Detect"], "the coordinated write carries the loaded options the revert returned the store to");
    assert.deepEqual(written.controllers, [ CONTROLLER_A, CONTROLLER_B ], "and the controllers the composer asked for");
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
    assert.ok(page.skeleton.controllersContainer.querySelector("[data-device-serial='CTRL-A']") === null, "the removed controller is gone from the sidebar");
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

    // The page goes away under the call, which is a page fact rather than a write fact, so the write still lands and saves.
    page.orchestrator.cleanup();
    writes.release();

    assert.deepEqual(await pending, { kind: "committed" }, "the write landed and was saved, so that is what the plugin is told");

    await flush();

    assert.ok(page.fake.observed.calls.includes("savePluginConfig"), "and the save ran, because the page going away does not end the write");
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

  test("a call from the connection-error frame re-enters the page and answers committed", async () => {

    using dom = createTestDom();
    using page = makePage({ config: makePluginConfig({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }) });

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.state.loaded = 0;

    // A sidebar click whose fetch fails is what puts a loaded page on the error frame.
    page.hooks.onDevices = () => Promise.reject(new Error("Controller unreachable."));

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await waitFor(() => page.skeleton.headerInfo.textContent.includes("Unable to retrieve the device list"), { message: "the error frame must render" });

    page.hooks.onDevices = null;

    const result = await page.orchestrator.commitConfig(() => ({ controllers: [CONTROLLER_A] }));

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.ok(!page.skeleton.headerInfo.textContent.includes("Unable to retrieve the device list"),
      "the write changed the configuration the error came from, so the frame is re-evaluated");
    assert.equal(page.state.loaded, 1, "through a fresh show cycle, which announces once");
  });

  test("a call from a page whose model never loaded writes, saves, and re-enters the page", async () => {

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

  test("a controller fetch that fails after the write re-enters the page, whose boot carries the failure", async () => {

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

  test("a wrong-shaped controller answer after the write re-enters the page without a TypeError leaving the call", async () => {

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

    // The same call from a page the boot has to own again - here because the fetch that follows the write fails, which only the boot has a surface for. The boot
    // it re-enters answers normally and announces exactly as any other show cycle does.
    page.hooks.onControllers = ({ answer, call }) => (call === 3) ? Promise.reject(new Error("Controller unreachable.")) : answer;

    await page.orchestrator.commitConfig(() => ({ controllers: [CONTROLLER_A] }));
    await flush();

    assert.equal(page.state.loaded, 1, "a re-entry announces once, through the boot");
  });
});

describe("webUiFeatureOptions.commitConfig - a write racing the boot's device fetch", () => {

  /* Start a boot whose device fetches are all held, and issue a write once its model has loaded, which is the window a plugin's onLoaded hook or a takeover card
   * writes from. The write establishes the page in place, and the establishment's selection refetch is a second device fetch for the boot's own controller that
   * supersedes the boot's. Both fetches stay held, so each row chooses which lands first and how it lands.
   */
  const raceBoot = async (page) => {

    const fetches = [];

    page.hooks.onDevices = ({ answer }) => {

      const { promise, reject, resolve } = Promise.withResolvers();

      fetches.push({ answer, reject, resolve });

      return promise;
    };

    const booted = page.orchestrator.show(await openTestSession());

    await waitFor(() => page.state.loaded === 1, { message: "the boot to load its model while its device fetch is held" });

    assert.deepEqual(await page.orchestrator.commitConfig(() => ({ controllers: [CONTROLLER_A] })), { kind: "committed" }, "precondition: the write landed");

    await waitFor(() => fetches.length === 2, { message: "the establishment's selection refetch to be outstanding beside the boot's own fetch" });

    return { boot: fetches[0], booted, refetch: fetches[1] };
  };

  // A device the boot's own answer carries and the refetch's does not, so the sidebar says whose list the store holds.
  const STALE = { firmwareRevision: "2.0", manufacturer: "Acme", model: "Cam", name: "Garage", serialNumber: "CTRL-A-GARAGE-CAM" };

  const activeDevice = (page) => page.skeleton.devicesContainer.querySelector(".nav-link.active")?.getAttribute("data-device-serial");

  test("the boot's superseded outcome reveals the page onto the refetch still in flight, and the refetch completes the selection when it lands", async () => {

    using dom = createTestDom();
    using page = makePage();

    const { boot, booted, refetch } = await raceBoot(page);

    boot.resolve({ ...boot.answer, devices: [ ...boot.answer.devices, STALE ] });
    await booted;
    await flush();

    assert.equal(page.skeleton.sidebar.style.display, "", "the boot reveals the page although the refetch that superseded it is still out");
    assert.equal(tableHeld(page.skeleton), true, "onto the busy table a sidebar click shows while its own fetch is out");

    refetch.resolve(refetch.answer);
    await flush();

    assert.equal(tableHeld(page.skeleton), false, "the refetch landing settles the table");
    assert.ok(page.skeleton.devicesContainer.querySelector("[data-device-serial='CTRL-A-CAM']"), "the sidebar carries the refetch's list");
    assert.ok(page.skeleton.devicesContainer.querySelector("[data-device-serial='CTRL-A-GARAGE-CAM']") === null, "and not the boot's superseded one");
    assert.equal(activeDevice(page), "CTRL-A", "the refetch carries the selection onto the controller's own row");
    assert.ok(page.skeleton.pageFeatureOptions.querySelector(".progress-bar-striped") === null, "no boot affordance remains on the page");

    const handle = page.orchestrator.takeover(document.createElement("section"));

    handle.release();

    assert.equal(page.skeleton.optionsContainer.style.display, "", "a released card's regions come straight back, because the boot recorded its reveal");
  });

  test("a refetch that fails after the boot's superseded reveal shows its error with the sidebar standing", async () => {

    using dom = createTestDom();
    using page = makePage();

    const { boot, booted, refetch } = await raceBoot(page);

    boot.resolve(boot.answer);
    await booted;
    await flush();

    refetch.reject(new Error("Controller unreachable."));
    await flush();

    assert.match(page.skeleton.headerInfo.textContent, /Unable to retrieve the device list\./, "the refetch's failure renders in the header");
    assert.equal(page.skeleton.sidebar.style.display, "", "beside the sidebar the boot revealed, as a sidebar click's failure after the boot renders");
  });

  test("a refetch that failed before the boot's superseded outcome lands leaves the boot on the connection-error frame", async () => {

    using dom = createTestDom();
    using page = makePage();

    const { boot, booted, refetch } = await raceBoot(page);

    refetch.reject(new Error("Controller unreachable."));
    await flush();

    boot.resolve(boot.answer);
    await booted;
    await flush();

    assert.match(page.skeleton.headerInfo.textContent, /Unable to retrieve the device list\./, "the store's standing failure is what the page shows");
    assert.equal(page.skeleton.sidebar.style.display, "none", "with the rest of the page hidden, as for a boot whose own fetch failed");
    assert.ok(page.skeleton.pageFeatureOptions.querySelector(".progress-bar-striped") === null, "and no boot affordance left over it");
  });

  test("a boot fetch that rejects after the refetch has landed still reveals the page the refetch filled", async () => {

    using dom = createTestDom();
    using page = makePage();

    const { boot, booted, refetch } = await raceBoot(page);

    refetch.resolve(refetch.answer);
    await flush();

    boot.reject(new Error("Controller unreachable."));
    await booted;
    await flush();

    assert.equal(page.skeleton.sidebar.style.display, "", "the boot's dropped failure reveals the page as a dropped success does");
    assert.doesNotMatch(page.skeleton.headerInfo.textContent, /Unable to/, "with no failure shown, because the store holds the refetch's clean outcome");
    assert.equal(activeDevice(page), "CTRL-A", "and the selection the refetch completed");
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

  test("hide() waits for a commit in flight before it hides the regions", async () => {

    using dom = createTestDom();
    using page = makePage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }));

    await waitFor(() => writes.pending === 1, { message: "the call's write must reach the host" });

    let hidden = false;
    const hiding = page.orchestrator.hide().then(() => { hidden = true; });

    await flush();

    assert.equal(hidden, false, "the teardown does not report itself finished while a write it issued is still at the host");

    writes.release();

    await hiding;

    assert.deepEqual(await pending, { kind: "committed" }, "the write the teardown waited for landed and was saved");
    assert.equal(page.skeleton.sidebar.style.display, "none", "and once it settled the teardown hid the regions");
    assert.equal(page.skeleton.optionsContainer.style.display, "none", "every one of them");
  });
});

/* A write that edits a controller's address replaces its sidebar key, because a plugin keys the sidebar by the address it configured. These rows drive the
 * declaration that carries the page across that replacement on each path a plugin's write reaches the page through: the coordinated write, and the refresh a
 * plugin that writes through its own path makes afterwards. The controller's hardware serials survive the address edit, which is what the device hook answers.
 */
describe("webUiFeatureOptions - a controller rename a write declares", () => {

  const MOVED_A = { address: "10.0.0.9", name: "Hub A", serialNumber: "CTRL-A9" };
  const RENAME = { from: "CTRL-A", to: "CTRL-A9" };

  // Re-address controller A in a controller list, leaving every other entry where it stands.
  const moveA = (controllers) => controllers.map((controller) => (controller.serialNumber === CONTROLLER_A.serialNumber) ? MOVED_A : controller);

  // Answer for the re-addressed controller with the devices it always had: an address edit changes how the page reaches a controller, not the hardware behind it.
  const stableSerials = ({ answer, controller }) => (controller?.serialNumber === MOVED_A.serialNumber) ? { ...answer, devices: devicesOf(CONTROLLER_A) } : answer;

  const activeIn = (container) => container.querySelector(".nav-link.active")?.getAttribute("data-device-serial") ?? null;

  const twoControllerPage = () => makePage({ config: makePluginConfig({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }) });

  test("commitConfig carries the selection and its highlight onto the new key and refetches the devices against it", async () => {

    using dom = createTestDom();
    using page = twoControllerPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A", "precondition: the boot selected controller A");
    assert.equal(activeIn(page.skeleton.devicesContainer), "CTRL-A", "precondition: and continued onto its own row");

    page.hooks.onDevices = stableSerials;

    const fetchesBefore = page.hooks.deviceCalls.length;
    const result = await page.orchestrator.commitConfig((platform) => ({ controllers: moveA(platform.controllers) }), { rename: RENAME });

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A9", "the selection and its highlight followed the controller onto its new key");
    assert.deepEqual(page.hooks.deviceCalls.slice(fetchesBefore), ["CTRL-A9"], "and the devices were refetched under the new key");
    assert.equal(activeIn(page.skeleton.devicesContainer), "CTRL-A", "the controller's own row is still the one selected");
  });

  test("commitConfig leaves a user who moved to another controller while the write was pending where they went", async () => {

    using dom = createTestDom();
    using page = twoControllerPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.hooks.onDevices = stableSerials;

    const writes = holdWrites(page.fake);
    const pending = page.orchestrator.commitConfig((platform) => ({ controllers: moveA(platform.controllers) }), { rename: RENAME });

    await waitFor(() => writes.pending === 1, { message: "the call's write must be at the host" });

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "precondition: the user moved while the write was pending");

    writes.release();

    assert.deepEqual(await pending, { kind: "committed" });

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "the user's own choice stands: the rename carries only what still named the old key");
    assert.ok(page.skeleton.controllersContainer.querySelector("[data-device-serial='CTRL-A9']"), "while the renamed controller is listed under its new key");
    assert.ok(!page.hooks.deviceCalls.includes("CTRL-A9"), "and nothing was fetched for a controller the user is not looking at");
  });

  test("refreshControllers carries the selection onto the new key in one notification, leaves a takeover standing, and refetches under the new key", async () => {

    using dom = createTestDom();
    using page = twoControllerPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const handle = page.orchestrator.takeover(document.createElement("div"));
    let releaseDevices;

    // Hold the refetch open, so the only renders counted below are the list arrival's own.
    page.hooks.onDevices = (args) => new Promise((resolve) => { releaseDevices = () => resolve(stableSerials(args)); });

    // The plugin wrote the address edit through its own path, so the host's configuration already names the controller by its new address.
    page.fake.config = makePluginConfig({ controllers: [ MOVED_A, CONTROLLER_B ] });
    page.panels.length = 0;

    const fetchesBefore = page.hooks.deviceCalls.length;

    assert.equal(await page.orchestrator.refreshControllers({ rename: RENAME }), true, "the refresh reports the transition");
    assert.equal(page.panels.length, 1, "the arrival rendered the plugin's panel once, so no second notification came with it");
    assert.equal(handle.signal.aborted, false, "and nothing it dispatched ended the plugin's takeover");
    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A9", "the selection and its highlight followed the controller onto its new key");
    assert.deepEqual(page.hooks.deviceCalls.slice(fetchesBefore), ["CTRL-A9"], "and the devices are refetched under the new key");

    releaseDevices();

    await flush();

    assert.equal(activeIn(page.skeleton.devicesContainer), "CTRL-A", "the controller's own row is still the one selected once they land");
  });

  test("refreshControllers leaves a selection on another controller where it is and fetches nothing", async () => {

    using dom = createTestDom();
    using page = twoControllerPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "precondition: the user is on controller B");

    const fetchesBefore = page.hooks.deviceCalls.length;

    page.fake.config = makePluginConfig({ controllers: [ MOVED_A, CONTROLLER_B ] });
    page.panels.length = 0;

    assert.equal(await page.orchestrator.refreshControllers({ rename: RENAME }), true, "the refresh reports the transition");

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "the user stays where they are");
    assert.ok(page.skeleton.controllersContainer.querySelector("[data-device-serial='CTRL-A9']"), "while the renamed controller is listed under its new key");
    assert.equal(page.hooks.deviceCalls.length, fetchesBefore, "a refresh that moved no selection fetches nothing");
    assert.equal(page.panels.length, 0, "and moved nothing the device information panel reads, so the panel did not render");

    // A refresh that answers with the very list the page holds, declaring nothing, changes nothing at all.
    assert.equal(await page.orchestrator.refreshControllers(), true, "the unchanged list still reports the transition");

    await flush();

    assert.equal(page.panels.length, 0, "and the device information panel stays exactly as it was");
    assert.equal(page.hooks.deviceCalls.length, fetchesBefore, "with nothing fetched");
  });

  test("a malformed rename rejects commitConfig with a TypeError ahead of the queue, writing nothing", async () => {

    using dom = createTestDom();
    using page = twoControllerPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    const writesBefore = page.fake.observed.updatedConfigs.length;

    for(const rename of [ null, "CTRL-A9", [], { from: "CTRL-A" }, { from: "CTRL-A", to: 9 } ]) {

      // A sequential await per shape keeps each rejection attributable to the shape that caused it.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => page.orchestrator.commitConfig((platform) => ({ controllers: moveA(platform.controllers) }), { rename }), TypeError,
        "a rename shaped " + JSON.stringify(rename) + " is a bug in the call itself");
    }

    assert.equal(page.fake.observed.updatedConfigs.length, writesBefore, "and nothing reached the host");
  });
});

/* A write that lands on a frame the boot owns re-enters the page, and so do the connection-error retry and the sidebar refresh. Each re-entry hands the fresh
 * cycle the controller list and selection of the page it replaces, and the boot lands where its own list leaves that selection - on the same controller, on the
 * renamed one when the commit declared and the lists prove a rename, and on the first controller when the list cannot place it. A plugin's own show() inherits
 * nothing, and nothing answers a controller record from inherited values before the fresh cycle's model loads.
 */
describe("webUiFeatureOptions - a re-entered page keeps the controller it was on", () => {

  const MOVED_B = { address: "10.0.0.8", name: "Hub B", serialNumber: "CTRL-B8" };
  const RENAME_B = { from: "CTRL-B", to: "CTRL-B8" };
  const STORAGE_KEY = "homebridge-TestPlugin-category-states";

  // Re-address controller B in a controller list, leaving every other entry where it stands.
  const moveB = (controllers) => controllers.map((controller) => (controller.serialNumber === CONTROLLER_B.serialNumber) ? MOVED_B : controller);

  // Answer for the re-addressed controller with the devices it always had: an address edit changes how the page reaches a controller, not the hardware behind it.
  const stableSerials = ({ answer, controller }) => (controller?.serialNumber === MOVED_B.serialNumber) ? { ...answer, devices: devicesOf(CONTROLLER_B) } : answer;

  const activeIn = (container) => container.querySelector(".nav-link.active")?.getAttribute("data-device-serial") ?? null;

  // A two-controller page whose connection-error panel records the controller it is handed, whose sidebar heading carries a refresh action, and whose retry arms
  // at once.
  const reentryPage = () => {

    const errorPanels = [];
    const page = makePage({

      config: makePluginConfig({ controllers: [ CONTROLLER_A, CONTROLLER_B ] }),
      plugin: {

        connectionErrorPanel: ({ controller }) => errorPanels.push(controller),
        sidebar: { refresh: { onRefresh: async () => {} } },
        ui: { controllerRetryEnableDelayMs: 0, isController: (device) => !device?.serialNumber?.endsWith("-CAM") }
      }
    });

    page.errorPanels = errorPanels;

    return page;
  };

  // Put the loaded page on controller B's error frame, the way a sidebar click whose fetch fails does, then let B answer again.
  const errorFrameOnB = async (page) => {

    page.hooks.onDevices = () => Promise.reject(new Error("Controller unreachable."));
    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await waitFor(() => page.skeleton.headerInfo.textContent.includes("Unable to retrieve the device list"), { message: "the error frame must render" });

    page.hooks.onDevices = null;
  };

  // Press the connection-error view's retry once it has armed.
  const pressRetry = async (page) => {

    await waitFor(() => page.skeleton.headerInfo.querySelector("button.btn-warning:not([disabled])"), { message: "the retry must arm" });

    page.skeleton.headerInfo.querySelector("button.btn-warning").click();
  };

  // Fail the next controller-list fetch, and only that one.
  const failNextControllerFetch = (page) => {

    const failAt = page.hooks.controllerCalls + 1;

    page.hooks.onControllers = ({ answer, call }) => (call === failAt) ? Promise.reject(new Error("Controller list unreachable.")) : answer;
  };

  /* Leave a page whose catalog never loaded on its error frame, controller B selected and the two-controller list installed beneath the frame, and hand back the
   * fake's own request router so the caller decides what the next catalog read meets. The catalog is read once per page and kept once it succeeds, so only a
   * page that never loaded it has a boot that can fail or wait there. The first boot is answered with controller B alone, so the selection it leaves is not the
   * first controller of the list the refresh installs, and a landing on it cannot pass for the first-controller fallback.
   */
  const catalogErrorFrameOnB = async (page) => {

    const route = page.fake.request;

    page.fake.request = (path) => (path === "/getOptions") ? Promise.reject(new Error("the options route failed")) : route(path);
    page.hooks.onControllers = ({ answer }) => ({ ...answer, controllers: [CONTROLLER_B] });

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.hooks.onControllers = null;

    assert.match(page.skeleton.headerInfo.textContent, /Unable to load the feature options/, "precondition: the first boot failed at its catalog");
    assert.equal(await page.orchestrator.refreshControllers(), true, "precondition: a refresh installs the list beneath the error frame");

    return route;
  };

  test("a commit with a rename from the error frame of a non-first controller re-enters onto the renamed controller, its expansion under the new key", async () => {

    using dom = createTestDom();

    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "device:CTRL-B/CTRL-B": { Audio: false, Motion: true, Network: true } }));

    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();
    await errorFrameOnB(page);

    page.hooks.onDevices = stableSerials;
    page.state.loaded = 0;

    const result = await page.orchestrator.commitConfig((platform) => ({ controllers: moveB(platform.controllers) }), { rename: RENAME_B });

    await flush();

    assert.deepEqual(result, { kind: "committed" });
    assert.equal(page.state.loaded, 1, "the write re-entered the page through a fresh boot");
    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B8", "which came back on the renamed controller rather than the first one");
    assert.equal(activeIn(page.skeleton.devicesContainer), "CTRL-B", "and continued onto its own row");
    assert.equal(page.skeleton.configTable.querySelector("details[data-category='Audio']")?.open, true, "the expansion the user left is restored");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok("device:CTRL-B8/CTRL-B" in persisted, "because it was carried to the controller's new key");
    assert.ok(!("device:CTRL-B/CTRL-B" in persisted), "and left nothing behind under the old one");
  });

  test("a commit with no rename from the error frame of a non-first controller re-enters onto that controller", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();
    await errorFrameOnB(page);

    page.state.loaded = 0;

    assert.deepEqual(await page.orchestrator.commitConfig((platform) => ({ controllers: platform.controllers })), { kind: "committed" });

    await flush();

    assert.equal(page.state.loaded, 1, "the write re-entered the page");
    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "onto the controller the user was on");
    assert.equal(activeIn(page.skeleton.devicesContainer), "CTRL-B", "and onto its own row");
  });

  test("a commit whose in-place controller fetch fails re-enters and still honors its rename", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "precondition: a ready page on controller B");

    page.hooks.onDevices = stableSerials;
    failNextControllerFetch(page);

    assert.deepEqual(await page.orchestrator.commitConfig((platform) => ({ controllers: moveB(platform.controllers) }), { rename: RENAME_B }),
      { kind: "committed" });

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B8", "the re-entry the failed fetch took still carried the selection to the new key");
  });

  test("a re-entry whose inherited selection the new list cannot place, and one that inherits a global selection, select the first controller", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();
    await errorFrameOnB(page);

    await page.orchestrator.commitConfig(() => ({ controllers: [ CONTROLLER_A, { address: "10.0.0.3", name: "Hub C", serialNumber: "CTRL-C" } ] }));
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A", "a selection whose controller the write removed lands on the first controller");

    page.skeleton.controllersContainer.querySelector(".nav-link[data-navigation='global']").click();

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), null, "precondition: the user is on the global view");

    page.state.loaded = 0;
    page.skeleton.controllersContainer.querySelector("button.fo-action").click();

    await waitFor(() => page.state.loaded === 1, { message: "the sidebar refresh must re-enter the page" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A", "and an inherited global selection lands on the first controller too");
  });

  test("the connection-error retry re-enters onto the controller that was selected", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();
    await errorFrameOnB(page);

    page.state.loaded = 0;

    await pressRetry(page);
    await waitFor(() => page.state.loaded === 1, { message: "the retry must re-enter the page" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "the retry came back on the controller that failed");
    assert.ok(!page.skeleton.headerInfo.textContent.includes("Unable to retrieve the device list"), "which now answers, so the frame has cleared");
  });

  test("the sidebar refresh re-enters onto the controller that was selected", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await flush();

    page.state.loaded = 0;
    page.skeleton.controllersContainer.querySelector("button.fo-action").click();

    await waitFor(() => page.state.loaded === 1, { message: "the sidebar refresh must re-enter the page" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "the refresh came back on the controller the user was on");
  });

  test("a plugin's own show() over a standing page selects the first controller", async () => {

    using dom = createTestDom();
    using page = reentryPage();
    const session = await openTestSession();

    await page.orchestrator.show(session);
    await flush();

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "precondition: the user is on controller B");

    await page.orchestrator.show(session);
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A", "a show() is not a re-entry, so it inherits nothing and boots onto the first controller");
  });

  test("a plugin's own show() after a re-entry still selects the first controller", async () => {

    using dom = createTestDom();
    using page = reentryPage();
    const session = await openTestSession();

    await page.orchestrator.show(session);
    await flush();

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await flush();

    page.state.loaded = 0;
    page.skeleton.controllersContainer.querySelector("button.fo-action").click();

    await waitFor(() => page.state.loaded === 1, { message: "the sidebar refresh must re-enter the page" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "precondition: the re-entry came back on controller B");

    await page.orchestrator.show(session);
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A",
      "the re-entry left nothing for a later show() to inherit, so it boots onto the first controller");
  });

  test("a re-entered boot that fails before its model loads hands the connection-error panel no controller, at each point it can fail", async () => {

    for(const site of [ "sync", "controllers" ]) {

      using dom = createTestDom();
      using page = reentryPage();

      // Each site gets a page of its own, so the awaits below run one site at a time.
      // eslint-disable-next-line no-await-in-loop
      await page.orchestrator.show(await openTestSession());
      // eslint-disable-next-line no-await-in-loop
      await flush();
      // eslint-disable-next-line no-await-in-loop
      await errorFrameOnB(page);

      assert.deepEqual(page.errorPanels.at(-1), CONTROLLER_B, "precondition: the loaded page's own error frame hands the panel the controller that failed");

      if(site === "sync") {

        const original = page.fake.getPluginConfig;
        let failed = false;

        page.fake.getPluginConfig = async () => {

          if(!failed) {

            failed = true;

            throw new Error("The Homebridge server is unreachable.");
          }

          return original();
        };
      } else {

        failNextControllerFetch(page);
      }

      const rendersBefore = page.errorPanels.length;

      // eslint-disable-next-line no-await-in-loop
      await page.orchestrator.commitConfig((platform) => ({ controllers: moveB(platform.controllers) }), { rename: RENAME_B });
      // eslint-disable-next-line no-await-in-loop
      await flush();

      assert.ok(page.errorPanels.length > rendersBefore, "the re-entered boot failed at its " + site + " and rendered the error frame");
      assert.equal(page.errorPanels.at(-1), null, "and handed the panel no controller rather than the record it inherited, at the " + site);
    }
  });

  test("a re-entered boot that fails at its catalog hands the connection-error panel no controller, over a list it inherited", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    // The catalog is read once per page and kept once it succeeds, so the one boot that can fail there is one whose page never loaded it: the first boot fails at
    // the catalog, a refresh installs a list under that error frame, and the retry inherits that list and fails at the catalog again.
    page.fake.request = (path) => (path === "/getOptions") ? Promise.reject(new Error("the options route failed")) : Promise.resolve(null);

    await page.orchestrator.show(await openTestSession());
    await flush();

    assert.equal(await page.orchestrator.refreshControllers(), true, "precondition: a list stands under the error frame");

    const rendersBefore = page.errorPanels.length;

    await pressRetry(page);
    await waitFor(() => page.errorPanels.length > rendersBefore, { message: "the retry's boot must fail at its catalog" });

    assert.match(page.skeleton.headerInfo.textContent, /Unable to load the feature options/, "the retry failed at the catalog");
    assert.equal(page.errorPanels.at(-1), null, "and handed the panel no controller, though the list it inherited holds the selected one");
  });

  test("a re-entry that fails before its model loads, then a retry that succeeds, lands on the controller that was selected", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();
    await errorFrameOnB(page);

    failNextControllerFetch(page);
    page.state.loaded = 0;

    await page.orchestrator.commitConfig((platform) => ({ controllers: platform.controllers }));
    await flush();

    assert.match(page.skeleton.headerInfo.textContent, /Unable to retrieve the controller list/, "precondition: the re-entered boot failed before its model loaded");
    assert.equal(page.state.loaded, 0, "so no model arrived");

    await pressRetry(page);
    await waitFor(() => page.state.loaded === 1, { message: "the retry must re-enter the page" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "the failed re-entry handed its retry the selection it had inherited");
  });

  test("a renaming commit whose re-entry fails before its controller list arrives hands its retry no rename, and the retry lands on the first controller", async () => {

    using dom = createTestDom();

    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "device:CTRL-B/CTRL-B": { Audio: false, Motion: true, Network: true } }));

    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();
    await errorFrameOnB(page);

    page.hooks.onDevices = stableSerials;
    failNextControllerFetch(page);
    page.state.loaded = 0;

    assert.deepEqual(await page.orchestrator.commitConfig((platform) => ({ controllers: moveB(platform.controllers) }), { rename: RENAME_B }),
      { kind: "committed" });

    await flush();

    assert.match(page.skeleton.headerInfo.textContent, /Unable to retrieve the controller list/, "precondition: the re-entry failed before its list arrived");
    assert.equal(page.state.loaded, 0, "so no model arrived");

    await pressRetry(page);
    await waitFor(() => page.state.loaded === 1, { message: "the retry must re-enter the page" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-A",
      "the retry carried no rename, so the selection it inherited still names the old key and lands on the first controller");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok("device:CTRL-B/CTRL-B" in persisted, "the expansion stays under the old key");
    assert.ok(!("device:CTRL-B8/CTRL-B" in persisted), "because nothing carried it to the new one");
  });

  test("a renaming commit whose re-entry fails at its catalog hands its retry no rename, and the retry lands on the renamed controller it selected", async () => {

    using dom = createTestDom();

    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "device:CTRL-B/CTRL-B": { Audio: false, Motion: true, Network: true } }));

    using page = reentryPage();
    const route = await catalogErrorFrameOnB(page);

    page.hooks.onDevices = stableSerials;

    assert.deepEqual(await page.orchestrator.commitConfig((platform) => ({ controllers: moveB(platform.controllers) }), { rename: RENAME_B }),
      { kind: "committed" });

    await flush();

    assert.match(page.skeleton.headerInfo.textContent, /Unable to load the feature options/, "precondition: the re-entry failed at its catalog");
    assert.equal(page.hooks.deviceCalls.at(-1), "CTRL-B8", "after its list arrived and it had selected the renamed controller");

    page.fake.request = route;

    await pressRetry(page);
    await waitFor(() => page.state.loaded === 1, { message: "the retry must re-enter the page" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B8",
      "the retry inherited the selection the failed boot made, so it lands on the renamed controller");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok("device:CTRL-B/CTRL-B" in persisted, "the expansion stays under the old key");
    assert.ok(!("device:CTRL-B8/CTRL-B" in persisted), "because the retry carried no rename to move it");
  });

  test("a refresh with a rename over a page whose model never loaded starts no device fetch and leaves the error frame standing", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    // The catalog read fails, so the boot selects controller A and then stands on the error frame with no model.
    page.fake.request = (path) => (path === "/getOptions") ? Promise.reject(new Error("the options route failed")) : Promise.resolve(null);

    await page.orchestrator.show(await openTestSession());
    await flush();

    assert.match(page.skeleton.headerInfo.textContent, /Unable to load the feature options/, "precondition: the page has no model");
    assert.equal(await page.orchestrator.refreshControllers(), true, "a refresh installs the list under the error frame");

    page.fake.config = makePluginConfig({ controllers: [ { address: "10.0.0.9", name: "Hub A", serialNumber: "CTRL-A9" }, CONTROLLER_B ] });

    const fetchesBefore = page.hooks.deviceCalls.length;

    assert.equal(await page.orchestrator.refreshControllers({ rename: { from: "CTRL-A", to: "CTRL-A9" } }), true, "and a renaming one reconciles against it");

    await flush();

    assert.equal(page.hooks.deviceCalls.length, fetchesBefore, "the carried selection is not refetched on a page with no model");
    assert.match(page.skeleton.headerInfo.textContent, /Unable to load the feature options/, "so nothing lifts the error frame over a page with nothing loaded");
  });

  test("no view paints the inherited list or selection before the re-entered boot's model loads", async () => {

    using dom = createTestDom();
    using page = reentryPage();

    await page.orchestrator.show(await openTestSession());
    await flush();

    page.skeleton.controllersContainer.querySelector(".nav-link[data-device-serial='CTRL-B']").click();

    await flush();

    // Hold the re-entered boot at its controller fetch, the window in which the fresh store holds nothing but what it inherited.
    let release = null;

    page.hooks.onControllers = ({ answer }) => new Promise((resolve) => { release = () => resolve(answer); });
    page.panels.length = 0;
    page.skeleton.controllersContainer.querySelector("button.fo-action").click();

    await waitFor(() => release !== null, { message: "the re-entered boot must reach its controller fetch" });

    assert.equal(page.skeleton.controllersContainer.querySelectorAll(".nav-link").length, 0, "the sidebar lists no controller");
    assert.equal(page.skeleton.devicesContainer.querySelectorAll(".nav-link").length, 0, "and no device");
    assert.equal(page.skeleton.configTable.children.length, 0, "the options table is empty");
    assert.equal(page.panels.length, 0, "and the device information panel did not render");

    release();

    await waitFor(() => page.state.loaded === 2, { message: "the re-entered boot must finish" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "once the model loads, the page comes up on the controller it was on");
  });

  test("no view paints the inherited list or the boot's own selection while the re-entered boot waits on its catalog", async () => {

    using dom = createTestDom();
    using page = reentryPage();
    const route = await catalogErrorFrameOnB(page);

    // Hold the retry's boot at its catalog read. By the time it waits there it has fetched its list, selected the controller it inherited, and fired that
    // controller's device fetch, so the fresh store holds the inherited list beside a selection the boot dispatched itself, and still no model.
    let release = null;

    page.fake.request = (path) => (path === "/getOptions") ? new Promise((resolve) => { release = () => resolve(route(path)); }) : route(path);
    page.panels.length = 0;

    const fetchesBefore = page.hooks.deviceCalls.length;

    await pressRetry(page);
    await waitFor(() => page.hooks.deviceCalls.length > fetchesBefore, { message: "the retry's boot must select its controller and fire its device fetch" });

    assert.equal(page.hooks.deviceCalls.at(-1), "CTRL-B", "precondition: the boot selected the controller it inherited");
    assert.notEqual(release, null, "and waits on its catalog read");
    assert.equal(page.skeleton.controllersContainer.querySelectorAll(".nav-link").length, 0, "the sidebar lists no controller");
    assert.equal(page.skeleton.devicesContainer.querySelectorAll(".nav-link").length, 0, "and no device");
    assert.equal(page.skeleton.configTable.children.length, 0, "the options table is empty");
    assert.equal(page.panels.length, 0, "and the device information panel did not render");

    release();

    await waitFor(() => page.state.loaded === 1, { message: "the re-entered boot must finish" });
    await flush();

    assert.equal(activeIn(page.skeleton.controllersContainer), "CTRL-B", "once the model loads, the page comes up on the controller it was on");
  });
});
