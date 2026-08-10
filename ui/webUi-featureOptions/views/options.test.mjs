/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/options.test.mjs: Unit tests for the config-table view.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";
import { createTestDom } from "../../ui.helpers.mjs";
import { mountOptionsView } from "./options.mjs";

const CATEGORIES = [

  { description: "Motion Options", name: "Motion" },
  { description: "Audio Options", name: "Audio" }
];

const OPTIONS = {

  Audio: [

    { default: false, defaultValue: 50, description: "Audio volume level.", name: "Volume" },
    { default: false, defaultValue: "", description: "Streaming account password.", inputSize: 20, name: "Password", secret: true }
  ],

  Motion: [

    { default: true, description: "Enable motion detection.", name: "Detect" },
    { default: false, description: "Motion sensitivity tuning.", group: "Detect", name: "Sensitivity" }
  ]
};

const CATALOG = {

  ...buildCatalogIndex(CATEGORIES, OPTIONS),

  validators: { isController: () => false, validOption: () => true, validOptionCategory: () => true }
};

const setup = ({ configuredOptions = [], scope } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const configTable = document.createElement("div");
  const controller = new AbortController();

  configTable.id = "configTable";
  document.body.appendChild(configTable);

  store.dispatch({ catalog: CATALOG, configuredOptions, controllers: [], mode: "device-only", type: "model:loaded" });

  if(scope) {

    store.dispatch({ scope, type: "scope:changed" });
  }

  mountOptionsView({ configTable, platform: () => "test-plugin", signal: controller.signal, store });

  // The mount registers the scope-render effect; trigger an initial scope render so the table has category shells.
  if(!scope) {

    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
  }

  return { abort: () => controller.abort(), configTable, store };
};

describe("mountOptionsView - initial render", () => {

  test("builds category shells for every active category", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const categories = [...configTable.querySelectorAll("details[data-category]")];

    assert.equal(categories.length, 2);
    assert.equal(categories[0].getAttribute("data-category"), "Motion");
    assert.equal(categories[1].getAttribute("data-category"), "Audio");
  });

  test("category shells start with an empty rows container (lazy materialization)", () => {

    using _dom = createTestDom();

    const { configTable } = setup();

    for(const details of configTable.querySelectorAll("details[data-category]")) {

      assert.equal(details.querySelector(".fo-category-rows").children.length, 0);
    }
  });
});

describe("mountOptionsView - lazy row materialization", () => {

  test("expanding a category for the first time materializes its rows", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    assert.equal(motion.querySelector(".fo-category-rows").children.length, 0);

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    assert.equal(motion.querySelector(".fo-category-rows").children.length, 2, "Motion has Detect + Sensitivity");
    assert.equal(motion.dataset.rowsRendered, "true");
  });

  test("collapsing a category preserves its materialized rows", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));
    motion.open = false;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    assert.equal(motion.querySelector(".fo-category-rows").children.length, 2, "rows preserved after collapse");
  });
});

describe("mountOptionsView - open-category row materialization", () => {

  // Leave a category in the state a lost toggle leaves behind: open, holding no rows, with nothing still owing it the event that would ordinarily build them.
  // Detaching before the open is what makes the construction faithful rather than contrived - a toggle fired on a detached element reaches that element's own
  // listeners and never the table's delegated one, which is exactly what a render pass does when it detaches a subtree between a programmatic open and the toggle
  // task the browser has queued behind it. Re-attaching fires nothing of its own, so the category comes back to the table open and empty.
  const poisonCategory = (configTable, name) => {

    const details = configTable.querySelector("details[data-category='" + name + "']");
    const nextSibling = details.nextSibling;

    configTable.removeChild(details);
    details.open = true;
    configTable.insertBefore(details, nextSibling);

    return details;
  };

  test("an open category with no rows takes them at the next projection pass, carrying that pass's row state", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ configuredOptions: ["Disable.Motion.Detect"] });
    const motion = poisonCategory(configTable, "Motion");

    assert.equal(motion.open, true, "precondition: the category is open");
    assert.equal(motion.dataset.rowsRendered, undefined, "precondition: the lost toggle built nothing");
    assert.equal(motion.querySelector(".fo-category-rows").children.length, 0, "precondition: the category is empty");

    store.dispatch({ mode: "modified", type: "filter:changed" });

    assert.equal(motion.dataset.rowsRendered, "true", "the walk materialized the category it found open");
    assert.equal(motion.querySelector(".fo-category-rows").children.length, 2, "Motion has Detect + Sensitivity");

    // The rows are not merely built - they leave the pass derived, which the modified filter reads off directly: the option carrying a configured entry shows, and
    // the one still sitting at its default hides.
    assert.equal(motion.querySelector("#row-Motion\\.Detect").classList.contains("fo-hidden"), false);
    assert.equal(motion.querySelector("#row-Motion\\.Sensitivity").classList.contains("fo-hidden"), true);
  });

  test("a closed category with no rows keeps them unbuilt through every pass that walks the projection", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();
    const audio = configTable.querySelector("details[data-category='Audio']");

    store.dispatch({ mode: "modified", type: "filter:changed" });
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ mode: "all", type: "filter:changed" });

    assert.equal(audio.open, false, "precondition: nothing opened the category");
    assert.equal(audio.dataset.rowsRendered, undefined, "no pass claimed to have built it");
    assert.equal(audio.querySelector(".fo-category-rows").children.length, 0, "lazy materialization intact - a closed category costs nothing");
  });

  test("an open category the walk fills during an in-flight fetch arrives inert", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    // The window a sidebar controller click opens, in the order the nav view dispatches it: the optimistic scope first, the fetch record second.
    store.dispatch({ scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });
    store.dispatch({ controllerId: "ctrl-a", type: "devices:requested" });

    const motion = poisonCategory(configTable, "Motion");
    const configuredBefore = store.state.configuredOptions;

    store.dispatch({ mode: "all", type: "filter:changed" });

    const inputs = [...motion.querySelectorAll("input")];

    assert.notEqual(inputs.length, 0, "precondition: the walk materialized the rows");
    assert.equal(inputs.every((input) => input.disabled), true, "rows the walk builds mid-window take the same pass's busy application");

    motion.querySelector("#Motion\\.Detect").click();

    assert.equal(store.state.configuredOptions, configuredBefore, "the same array reference - a click on a healed row writes nothing");
  });
});

describe("mountOptionsView - checkbox click dispatch", () => {

  test("clicking a checkbox dispatches the tri-state transition's action", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = motion.querySelector("#Motion\\.Detect");

    assert.equal(checkbox.checked, true, "Motion.Detect default true");

    // Simulate the click toggling the checkbox (Happy-DOM updates .checked on .click()).
    checkbox.click();

    // Action should have been dispatched. Motion.Detect default is true; post-click state is unchecked.
    assert.deepEqual(store.state.configuredOptions, ["Disable.Motion.Detect"]);
  });

  test("a value commit on an enabled row replaces the value", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = audio.querySelector("#Audio\\.Volume");

    // Enable first - the input pre-fills with the catalog default, so the tick writes that value.
    checkbox.click();

    const input = audio.querySelector("input.fo-option-value");

    input.value = "75";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // The value-commit transition dispatches a set that replaces the prior entry rather than accumulating beside it.
    assert.deepEqual(store.state.configuredOptions, ["Enable.Audio.Volume=75"]);
  });

  test("a value commit on an unset row enables the option with that value", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const input = audio.querySelector("input.fo-option-value");

    // No checkbox interaction first: the input is live on an unset row, and committing a value is itself the enabling gesture.
    input.value = "75";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Audio.Volume=75"]);

    const checkbox = audio.querySelector("#Audio\\.Volume");

    assert.equal(checkbox.checked, true, "the checkbox follows the committed value through the re-projection");
  });

  test("ticking a value option at a device scope with an empty input arms the row: checked, live input, focused, nothing persisted", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = audio.querySelector("#Audio\\.Volume");
    const input = audio.querySelector("input.fo-option-value");

    // Empty the pre-filled input so the tick has no value to write. A scoped enable without value content has no persistable spelling, so the gesture arms the
    // row instead: it reads checked with a live, focused input, while the configuration stays untouched until a value commits.
    input.value = "";
    checkbox.click();

    assert.deepEqual(store.state.configuredOptions, [], "nothing persists for an enable with nothing to say");
    assert.equal(store.state.armedOption, "Audio.Volume", "the row is armed in the store");
    assert.equal(checkbox.checked, true, "an armed row reads checked");
    assert.equal(input.disabled, false, "an armed row's input is live");
    assert.equal(document.activeElement, input, "focus moves to the value input as the affordance for what comes next");
  });

  test("committing a value on an armed row enables the option and disarms it", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = audio.querySelector("#Audio\\.Volume");
    const input = audio.querySelector("input.fo-option-value");

    input.value = "";
    checkbox.click();

    // The arming gesture's whole purpose: the first committed value writes the scoped entry and the armed state stands down, leaving a genuinely enabled row.
    input.value = "75";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Audio.Volume.dev-a=75"], "the committed value persists as the scoped entry");
    assert.equal(store.state.armedOption, null, "the commit disarms the row");
    assert.equal(checkbox.checked, true, "the row is now genuinely enabled");
    assert.equal(input.disabled, false, "an enabled row's input stays live");
  });

  test("unchecking an armed row stands it down and relocks the input, writing nothing", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = audio.querySelector("#Audio\\.Volume");
    const input = audio.querySelector("input.fo-option-value");

    input.value = "";
    checkbox.click();
    checkbox.click();

    assert.deepEqual(store.state.configuredOptions, [], "no write in either direction - nothing was ever persisted");
    assert.equal(store.state.armedOption, null, "the row stood down");
    assert.equal(checkbox.checked, false, "the row reads unchecked again");
    assert.equal(input.disabled, true, "the input relocks");
  });

  test("focus leaving an armed row with an empty input abandons the arming", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = audio.querySelector("#Audio\\.Volume");
    const input = audio.querySelector("input.fo-option-value");

    input.value = "";
    checkbox.click();

    // Focus departs the row for somewhere else entirely - the abandonment gesture. A plain Event carries no relatedTarget, exactly the shape a departure to a
    // non-focusable target delivers, so the row stands down.
    input.dispatchEvent(new Event("focusout", { bubbles: true }));

    assert.equal(store.state.armedOption, null, "the abandonment disarms the row");
    assert.equal(checkbox.checked, false, "the row reads unchecked again");
    assert.equal(input.disabled, true, "the input relocks");
    assert.deepEqual(store.state.configuredOptions, [], "nothing was ever persisted");
  });

  test("a window-focus departure leaves an armed row armed and its input live", (t) => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const checkbox = audio.querySelector("#Audio\\.Volume");
    const input = audio.querySelector("input.fo-option-value");

    input.value = "";
    checkbox.click();

    assert.equal(store.state.armedOption, "Audio.Volume", "precondition: the row is armed and awaiting its first value");

    // A tab flip fires the same relatedTarget-less focusout an in-page departure to a non-focusable target does, and the only thing separating them is that the
    // document reads unfocused at dispatch time. Stubbing that read is how the flip is expressed here, since the test DOM carries no window-focus state of its
    // own...its hasFocus answers from the active element, which is the armed input.
    t.mock.method(document, "hasFocus", () => false);

    input.dispatchEvent(new Event("focusout", { bubbles: true }));

    assert.equal(store.state.armedOption, "Audio.Volume", "the arming survives the departure and is still there when the user returns");
    assert.equal(checkbox.checked, true, "the row still reads checked");
    assert.equal(input.disabled, false, "its field is still live for the value that will enable the option");
    assert.equal(input.value, "", "and nothing was typed into it");
    assert.deepEqual(store.state.configuredOptions, [], "nothing was persisted either way");
  });
});

describe("mountOptionsView - secret options", () => {

  // Open the Audio category and hand back the secret option's row, the shape every test in this block starts from.
  const openPasswordRow = (options) => {

    const { configTable, store } = setup(options);
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    return { row: audio.querySelector("[id='row-Audio.Password']"), store };
  };

  test("clicking the reveal toggle unmasks the field, and clicking it again re-masks it", () => {

    using _dom = createTestDom();

    const { row } = openPasswordRow({ configuredOptions: ["Enable.Audio.Password=hunter2"] });
    const input = row.querySelector("input.fo-option-value");
    const toggle = row.querySelector(".fo-secret-toggle");

    toggle.click();

    assert.equal(input.type, "text", "the delegated click reveals the value");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");

    // A pointer lands on the glyph inside the button rather than on the button itself, so the delegation has to resolve the click back to the toggle.
    toggle.querySelector("svg").dispatchEvent(new Event("click", { bubbles: true }));

    assert.equal(input.type, "password", "a click on the glyph masks it again");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
  });

  test("a reveal click writes nothing to the configuration and leaves the option itself alone", () => {

    using _dom = createTestDom();

    const { row, store } = openPasswordRow({ configuredOptions: ["Enable.Audio.Password=hunter2"] });
    const checkbox = row.querySelector("input[type='checkbox']");
    const configuredBefore = store.state.configuredOptions;

    row.querySelector(".fo-secret-toggle").click();

    assert.equal(store.state.configuredOptions, configuredBefore, "the same array reference - no mutation was dispatched at all");
    assert.equal(checkbox.checked, true, "the row-forward delegation does not read a toggle click as a click on the row's whitespace");
    assert.equal(row.querySelector("input.fo-option-value").type, "text", "the click did what it was for");
  });

  test("a secret option's value commits through exactly the path a plain option's does", () => {

    using _dom = createTestDom();

    const { row, store } = openPasswordRow();
    const input = row.querySelector("input.fo-option-value");

    // The commit machinery finds this field by its class, so masking it changes nothing about how its value is committed.
    input.value = "hunter2";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Audio.Password=hunter2"], "the masked value persists like any other value");
    assert.equal(row.querySelector("input[type='checkbox']").checked, true, "and the checkbox follows the committed value through the re-projection");
  });

  test("a revealed field's commit persists the same way, and the field stays revealed after it", () => {

    using _dom = createTestDom();

    const { row, store } = openPasswordRow({ configuredOptions: ["Enable.Audio.Password=hunter2"] });
    const input = row.querySelector("input.fo-option-value");

    row.querySelector(".fo-secret-toggle").click();
    input.value = "correct horse";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Audio.Password=correct horse"], "editing in the open commits like editing behind the mask");
    assert.equal(input.type, "text", "the re-derivation the commit triggers leaves the reveal where the user put it");
  });

  test("moving focus onto the reveal toggle does not stand an armed row down", () => {

    using dom = createTestDom();

    // The toggle is a focusable control sitting inside the row, so a click on it moves focus off the field. The abandonment path has to read that departure as
    // staying home - the user reaching for the reveal has not walked away from the value they were asked for.
    const { row, store } = openPasswordRow({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const input = row.querySelector("input.fo-option-value");

    input.value = "";
    row.querySelector("input[type='checkbox']").click();

    assert.equal(store.state.armedOption, "Audio.Password", "precondition: the row is armed and awaiting its first value");

    input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: row.querySelector(".fo-secret-toggle") }));

    assert.equal(store.state.armedOption, "Audio.Password", "focus landing on the row's own toggle leaves the arming intact");
    assert.equal(input.disabled, false, "and the field stays live for the value that will enable the option");
  });

  test("focus leaving an armed secret row with an empty field abandons the arming", () => {

    using _dom = createTestDom();

    // The abandonment path finds the field by its class as well, so a masked row stands down on the same gesture a plain one does.
    const { row, store } = openPasswordRow({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const input = row.querySelector("input.fo-option-value");

    input.value = "";
    row.querySelector("input[type='checkbox']").click();

    assert.equal(store.state.armedOption, "Audio.Password", "precondition: the row is armed");

    input.dispatchEvent(new Event("focusout", { bubbles: true }));

    assert.equal(store.state.armedOption, null, "the departure disarms the masked row");
    assert.equal(input.disabled, true, "and its field relocks");
    assert.deepEqual(store.state.configuredOptions, [], "nothing was ever persisted");
  });
});

describe("mountOptionsView - modified-option highlight", () => {

  test("toggling an option off its default re-colors the label text-info in place; reverting restores text-body", () => {

    using _dom = createTestDom();

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    const detectLabel = motion.querySelector("#row-Motion\\.Detect label");
    const detectCheckbox = motion.querySelector("#Motion\\.Detect");

    // Motion.Detect is default-on and unconfigured: unmodified, so text-body.
    assert.equal(detectLabel.classList.contains("text-body"), true, "starts unmodified");
    assert.equal(detectLabel.classList.contains("text-info"), false);

    // Toggle off - deviates from the default-on, so the row is now modified and must highlight. The dispatch drives the projection walk, which re-derives the label.
    detectCheckbox.click();

    assert.equal(detectLabel.classList.contains("text-info"), true, "toggling off-default highlights the label in place");
    assert.equal(detectLabel.classList.contains("text-body"), false, "the prior color class is replaced, not accumulated");

    // Toggle back on - matches the default again, so the highlight must clear.
    detectCheckbox.click();

    assert.equal(detectLabel.classList.contains("text-body"), true, "reverting to the default removes the highlight");
    assert.equal(detectLabel.classList.contains("text-info"), false, "no stale highlight survives the revert");
  });
});

describe("mountOptionsView - filter visibility", () => {

  test("filter:changed with mode=modified hides unmodified rows", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup({ configuredOptions: ["Disable.Motion.Detect"] });
    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    store.dispatch({ mode: "modified", type: "filter:changed" });

    const detectRow = motion.querySelector("#row-Motion\\.Detect");
    const sensitivityRow = motion.querySelector("#row-Motion\\.Sensitivity");

    assert.equal(detectRow.classList.contains("fo-hidden"), false);
    assert.equal(sensitivityRow.classList.contains("fo-hidden"), true);
  });
});

describe("mountOptionsView - per-device cache", () => {

  test("navigating away and back to the same scope restores the prior view's DOM from cache", () => {

    using _dom = createTestDom();

    const dev = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };
    const { configTable, store } = setup();

    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [dev], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    // Move to a device scope to populate per-device cache.
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    const materializedFingerprint = motion.querySelector(".fo-category-rows").children.length;

    // Navigate away and back.
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    const restoredMotion = configTable.querySelector("details[data-category='Motion']");

    assert.equal(restoredMotion.querySelector(".fo-category-rows").children.length, materializedFingerprint, "materialized rows survive the round-trip");
  });

  test("a mutation that lands while another device's view is cached invalidates that cache so the rebuilt view reflects the mutation", () => {

    using _dom = createTestDom();

    const devs = [

      { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" },
      { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device B", serialNumber: "dev-b" }
    ];
    const { configTable, store } = setup();

    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: devs, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    const motionA = configTable.querySelector("details[data-category='Motion']");

    motionA.open = true;
    motionA.dispatchEvent(new Event("toggle", { bubbles: false }));
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-b", kind: "device" }, type: "scope:changed" });

    // Mutate Motion.Detect globally while viewing dev-b. dev-a's cached DOM showed the old (default-true) state; after the rebuild it must reflect the new state.
    store.dispatch({ args: { enabled: false, option: "Motion.Detect" }, type: "option:set" });
    store.dispatch({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, type: "scope:changed" });

    // The category state for dev-a (Motion expanded) is restored, so rows materialize. They must reflect the post-mutation state - the cache was invalidated.
    const restoredMotion = configTable.querySelector("details[data-category='Motion']");
    const detectCheckbox = restoredMotion?.querySelector("#Motion\\.Detect");

    // The post-mutation dev-a view is rebuilt from current state. The global Disable propagates into the device view as inheritance: indeterminate + readOnly.
    assert.equal(detectCheckbox?.indeterminate, true, "device view inherits from global - checkbox is indeterminate");
    assert.equal(detectCheckbox?.readOnly, true, "inheriting from upstream - read-only");
  });
});

describe("mountOptionsView - in-flight device fetch", () => {

  const CONTROLLER_A = "ctrl-a";
  const DEVICE_A = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };

  // Move the store into the window a sidebar controller click opens: the scope already names the controller, its device list has not arrived, and every write the
  // table could take would key from a selected device the controller scope does not have. The dispatch order mirrors the nav view's exactly - the optimistic scope
  // first, the fetch record second - because that order is what makes the window observable at all.
  const openWindow = ({ configuredOptions } = {}) => {

    const harness = setup({ configuredOptions });

    harness.store.dispatch({ scope: { controllerId: CONTROLLER_A, kind: "controller" }, type: "scope:changed" });
    harness.store.dispatch({ controllerId: CONTROLLER_A, type: "devices:requested" });

    return harness;
  };

  // Expand a category and hand back its element. Categories render collapsed, so this is how a row comes to exist at all on a first visit to a view.
  const expandCategory = (configTable, name) => {

    const details = configTable.querySelector("details[data-category='" + name + "']");

    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: false }));

    return details;
  };

  // Whether every input in the table is disabled - the table-wide reading of "no gesture can land here."
  const allInputsDisabled = (configTable) => [...configTable.querySelectorAll("input")].every((input) => input.disabled);

  test("a first visit to a controller renders the table inert while its device list is in flight", () => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();
    const motion = expandCategory(configTable, "Motion");
    const inputs = [...configTable.querySelectorAll("input")];
    const configuredBefore = store.state.configuredOptions;

    assert.equal(configTable.classList.contains("fo-options-busy"), true, "the table carries the busy marker");
    assert.notEqual(inputs.length, 0, "precondition: the expand materialized rows to assert over");
    assert.equal(inputs.every((input) => input.disabled), true, "every input in the table is disabled");

    // The gesture the whole thing exists for. A toggle here keys its write from the selected device, and a controller scope has none, so the entry would land at
    // global scope while the sidebar reads as the controller. A disabled checkbox never reaches the change handler at all.
    motion.querySelector("#Motion\\.Detect").click();

    assert.equal(store.state.configuredOptions, configuredBefore, "the same array reference - no write was dispatched");
  });

  test("a category expanded during the window materializes its rows inert", () => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();

    expandCategory(configTable, "Motion");

    // Audio expands strictly after the window is established, so its rows are born inside it. Rows born from an expand never pass through the projection walk at
    // birth, which is why the materialization path applies the busy state itself.
    const audio = expandCategory(configTable, "Audio");
    const audioInputs = [...audio.querySelectorAll("input")];
    const configuredBefore = store.state.configuredOptions;

    assert.notEqual(audioInputs.length, 0, "precondition: Audio materialized its rows");
    assert.equal(audioInputs.every((input) => input.disabled), true, "the freshly materialized rows arrive disabled");

    audio.querySelector("#Audio\\.Volume").click();

    assert.equal(store.state.configuredOptions, configuredBefore, "and a click on one writes nothing");
  });

  test("revisiting a loaded controller is inert again while the refetch is in flight, and lifts when it lands", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    // Settle controller A's list, then sit in its view: the loaded list names this controller and no fetch is outstanding, so the table is live.
    store.dispatch({ controllerId: CONTROLLER_A, type: "devices:requested" });
    store.dispatch({ controllerId: CONTROLLER_A, devices: [DEVICE_A], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    store.dispatch({ scope: { controllerId: CONTROLLER_A, kind: "controller" }, type: "scope:changed" });

    expandCategory(configTable, "Motion");

    assert.equal(configTable.classList.contains("fo-options-busy"), false, "precondition: a settled controller view is live");

    // Leave and come back, which is what a sidebar click does. The optimistic scope lands first and finds the loaded list still naming this controller, so the
    // scope alone says nothing is wrong - only the fetch record that follows can tell the view that what it is showing is about to be replaced.
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
    store.dispatch({ scope: { controllerId: CONTROLLER_A, kind: "controller" }, type: "scope:changed" });

    assert.equal(configTable.classList.contains("fo-options-busy"), false, "the optimistic scope alone does not open the window");

    store.dispatch({ controllerId: CONTROLLER_A, type: "devices:requested" });

    const configuredBefore = store.state.configuredOptions;

    assert.equal(configTable.classList.contains("fo-options-busy"), true, "the fetch record is what opens the revisit window");
    assert.equal(allInputsDisabled(configTable), true, "every restored row is inert");

    configTable.querySelector("details[data-category='Motion'] #Motion\\.Detect").click();

    assert.equal(store.state.configuredOptions, configuredBefore, "no write lands in the revisit window");

    store.dispatch({ controllerId: CONTROLLER_A, devices: [DEVICE_A], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    assert.equal(configTable.classList.contains("fo-options-busy"), false, "the fresh list lifts the window");
    assert.equal(configTable.querySelector("details[data-category='Motion'] #Motion\\.Detect").disabled, false, "and the rows take gestures again");
  });

  test("a re-derivation during the window leaves every row inert", () => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();
    const motion = expandCategory(configTable, "Motion");
    const configuredBefore = store.state.configuredOptions;

    // Typing in the search box re-derives every materialized row from the projection, which knows nothing about a device fetch. This is the gesture that would
    // otherwise hand the window's rows back their interactivity without the user touching a single one of them.
    store.dispatch({ query: "motion", type: "filter:changed" });

    assert.equal(configTable.classList.contains("fo-options-busy"), true, "the marker survives the walk");
    assert.equal(allInputsDisabled(configTable), true, "every re-derived row is still disabled");

    motion.querySelector("#Motion\\.Detect").click();

    assert.equal(store.state.configuredOptions, configuredBefore, "and still no write is possible");
  });

  test("a focusout arriving from the disabling instant is absorbed with no dispatch at all", (t) => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();
    const audio = expandCategory(configTable, "Audio");
    const input = audio.querySelector("input.fo-option-value");

    assert.equal(input.disabled, true, "precondition: the field is inert");

    // A browser fires focusout from an input that held focus at the instant it was disabled. The test DOM's disabled setter is a plain attribute toggle and models
    // no such fixup, so the event is synthesized here. Nothing follows from it: the scope:changed that opened this window nulled the armed row in the reducer
    // before any subscriber re-derived anything, so the abandonment path finds no armed row and returns on its first guard. This row is what keeps a future
    // reordering of those guards from quietly reopening the path.
    const stateBefore = store.state;
    const dispatch = t.mock.method(store, "dispatch");

    input.dispatchEvent(new Event("focusout", { bubbles: true }));

    assert.equal(dispatch.mock.callCount(), 0, "the handler dispatched nothing");
    assert.equal(store.state, stateBefore, "and the state is the same object it was");
  });

  test("the device list landing lifts the window on the same dispatch", () => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();
    const motion = expandCategory(configTable, "Motion");

    assert.equal(motion.querySelector("#Motion\\.Detect").disabled, true, "precondition: the window is open");

    store.dispatch({ controllerId: CONTROLLER_A, devices: [DEVICE_A], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    const detect = configTable.querySelector("details[data-category='Motion'] #Motion\\.Detect");

    assert.equal(configTable.classList.contains("fo-options-busy"), false, "the marker is gone");
    assert.equal(detect.disabled, false, "the row takes gestures again");

    detect.click();

    // A settled controller view carries no device in its scope, so its entry keys to global. That is the view's own semantic and no concern of this row, which
    // asserts only that the table takes a gesture at all once the fetch has been answered.
    assert.deepEqual(store.state.configuredOptions, ["Disable.Motion.Detect"], "the toggle writes once the list has landed");
  });

  test("a controller that answers with no devices lifts the window too", () => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();

    expandCategory(configTable, "Motion");
    store.dispatch({ controllerId: CONTROLLER_A, devices: [], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    // An answered fetch settles the view whatever it carried: the list on screen belongs to this controller and nothing is outstanding, which is the whole of what
    // the window was waiting on.
    assert.equal(configTable.classList.contains("fo-options-busy"), false, "an empty list is still an answer");
    assert.equal(configTable.querySelector("#Motion\\.Detect").disabled, false, "the rows take gestures again");
  });

  test("a view detached mid-window comes back inert while its fetch is still outstanding", () => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();

    expandCategory(configTable, "Motion");

    // Away and back with the fetch still in flight. The restored DOM is re-derived from the projection on arrival, which on its own would hand every row back its
    // interactivity...the busy state is derived again at that same moment, so it does not.
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });

    assert.equal(configTable.classList.contains("fo-options-busy"), false, "the global view is never busy - its writes key from the selection itself");

    store.dispatch({ scope: { controllerId: CONTROLLER_A, kind: "controller" }, type: "scope:changed" });

    assert.equal(configTable.classList.contains("fo-options-busy"), true, "the restored view is busy again");
    assert.equal(allInputsDisabled(configTable), true, "every restored row is inert");
  });

  test("a view that was busy comes back live once its fetch has landed", () => {

    using _dom = createTestDom();

    const { configTable, store } = openWindow();

    expandCategory(configTable, "Motion");
    store.dispatch({ controllerId: CONTROLLER_A, devices: [DEVICE_A], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    // The same round-trip against a view that has settled. Nothing about the window was recorded on the cached nodes, so what comes back is whatever the
    // projection says it should be.
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
    store.dispatch({ scope: { controllerId: CONTROLLER_A, kind: "controller" }, type: "scope:changed" });

    const detect = configTable.querySelector("details[data-category='Motion'] #Motion\\.Detect");

    assert.equal(configTable.classList.contains("fo-options-busy"), false, "no stale busy state survives in the cache");
    assert.equal(detect.disabled, false, "the restored rows are live");

    detect.click();

    assert.deepEqual(store.state.configuredOptions, ["Disable.Motion.Detect"], "and they write");
  });
});

describe("mountOptionsView - legacy category-state key migration", () => {

  // The pre-reactive-store architecture wrote category-state entries under context keys of shape `"Global Options"` (for the global view) or the bare device serial
  // (for any device view). The reactive-store refactor unified these under {@link scopeCacheKey}'s output. On first visit to a view after the upgrade, we expect the
  // restore path to find data under the legacy key, write it under the new key, and delete the legacy entry - leaving disk in the new shape for every subsequent
  // visit.

  // The localStorage storage key is plugin-namespaced. setup()'s platform thunk returns "test-plugin", so all writes land under this key.
  const STORAGE_KEY = "homebridge-test-plugin-category-states";

  test("a global view restores category state from the legacy \"Global Options\" key and migrates it under the new \"global\" key", () => {

    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "Global Options": { Audio: false, Motion: true } }));

    // First mount triggers an initial scope:changed -> global, which fires the scope-render effect and runs the legacy lookup.
    const { configTable } = setup();

    // The Motion category was persisted as collapsed (open: false in our captureCategoryStates contract is the inverse of the boolean we recorded - it stores
    // collapsed-state). Re-reading the live DOM tells us the saved state was actually applied: the open attribute on the Motion details element reflects what we
    // seeded under the legacy key.
    const motion = configTable.querySelector("details[data-category='Motion']");
    const audio = configTable.querySelector("details[data-category='Audio']");

    // Seeded state: Motion: true (collapsed), Audio: false (expanded). Verify applyCategoryStates honored both.
    assert.equal(motion.open, false, "Motion was seeded as collapsed in the legacy entry - the restore must have applied it");
    assert.equal(audio.open, true, "Audio was seeded as expanded in the legacy entry - the restore must have applied it");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok(!("Global Options" in persisted), "the legacy key must be removed from disk after migration");
    assert.deepEqual(persisted.global, { Audio: false, Motion: true }, "the migrated data must appear under the new \"global\" key");
  });

  test("a device view restores category state from the legacy bare-device-serial key and migrates it under the new \"device:/<serial>\" key", () => {

    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "DEV-A": { Audio: true, Motion: false } }));

    const { configTable, store } = setup();
    const dev = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "DEV-A" };

    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [dev], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    store.dispatch({ scope: { controllerId: null, deviceId: "DEV-A", kind: "device" }, type: "scope:changed" });

    const motion = configTable.querySelector("details[data-category='Motion']");
    const audio = configTable.querySelector("details[data-category='Audio']");

    assert.equal(motion.open, true, "Motion was seeded as expanded under the legacy device-serial key - the restore must have applied it");
    assert.equal(audio.open, false, "Audio was seeded as collapsed under the legacy device-serial key - the restore must have applied it");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok(!("DEV-A" in persisted), "the legacy device-serial key must be removed from disk after migration");
    assert.deepEqual(persisted["device:/DEV-A"], { Audio: true, Motion: false },
      "the migrated data must appear under the new device-key shape (controllerId slot empty in device-only mode)");
  });

  test("a view with no legacy entry produces no spurious lookup or migration; new-shape data round-trips unchanged", () => {

    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ global: { Audio: false, Motion: true } }));

    const { configTable } = setup();
    const motion = configTable.querySelector("details[data-category='Motion']");

    assert.equal(motion.open, false, "the new-shape data was applied directly - no migration was needed");

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    assert.ok(!("Global Options" in persisted), "no spurious writes to the legacy key from the migration path - it was never consulted");
    assert.deepEqual(persisted.global, { Audio: false, Motion: true }, "the new-shape data is round-tripped intact (caller round-trip captures both categories' state)");
  });

  test("a second visit to a migrated view reads directly from the new key (the legacy lookup is not consulted again)", () => {

    // After the first visit migrates, the legacy entry is gone. Subsequent visits must find data under the new key alone - this proves the migration was
    // structural, not just a one-time copy, and that the new key is now the canonical storage location.
    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "Global Options": { Motion: true } }));

    // First mount triggers the migration.
    const first = setup();

    first.abort();

    // Re-seed the legacy key with DIFFERENT data to prove the second visit does NOT re-read it - if it did, the assertion below would see the new (re-seeded)
    // value, not the originally-migrated one.
    const persistedAfterFirst = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

    persistedAfterFirst["Global Options"] = { Motion: false };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedAfterFirst));

    const second = setup();
    const motion = second.configTable.querySelector("details[data-category='Motion']");

    assert.equal(motion.open, false, "the second visit reads from the new \"global\" key (Motion: true -> collapsed), not the re-seeded legacy key");
  });
});
