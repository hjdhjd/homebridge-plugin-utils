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
    assert.ok(document.activeElement === input, "focus moves to the value input as the affordance for what comes next");
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

  test("focus landing on a control the armed row does not contain abandons the arming", () => {

    using dom = createTestDom();

    const { configTable, store } = setup({ scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });
    const audio = configTable.querySelector("details[data-category='Audio']");

    audio.open = true;
    audio.dispatchEvent(new Event("toggle", { bubbles: false }));

    const armedRow = audio.querySelector("[id='row-Audio.Volume']");
    const checkbox = armedRow.querySelector("input[type='checkbox']");
    const input = armedRow.querySelector("input.fo-option-value");
    const neighbor = audio.querySelector("[id='row-Audio.Password'] input[type='checkbox']");

    input.value = "";
    checkbox.click();

    assert.equal(store.state.armedOption, "Audio.Volume", "precondition: the row is armed and awaiting its first value");
    assert.ok(neighbor, "precondition: the neighbouring option's control rendered alongside the armed row");
    assert.ok(!armedRow.contains(neighbor), "precondition: that control genuinely sits outside the armed row");

    // A departure carrying a relatedTarget the armed row does not contain - the user tabbing on to the next option's control. This is the other side of the
    // containment guard from the reveal-toggle case: the guard spares only a departure that stays inside the row, so a populated target elsewhere on the page
    // reaches the same stand-down a relatedTarget-less departure takes.
    input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: neighbor }));

    assert.equal(store.state.armedOption, null, "the departure to a control outside the row disarms it");
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

describe("mountOptionsView - a controller's own options page", () => {

  // The page a controller click lands on for a plugin whose device list leads with the controller-as-device: one serial fills both scope slots, so everything
  // edited here is stored at the controller's serial and answers for every device beneath it. The catalog pairs an option declared at both levels with one that
  // declares nothing, which is what puts a set-here row and a genuinely inherited row side by side on the same page.
  const PAGE_CATEGORIES = [{ description: "Page Options", name: "Page" }];

  const PAGE_OPTIONS = {

    Page: [

      { default: false, description: "Controller-wide zone default.", name: "Zone", scopes: [ "controller", "device" ] },
      { default: false, description: "Option that declares nothing.", name: "Anywhere" }
    ]
  };

  const PAGE_CATALOG = {

    ...buildCatalogIndex(PAGE_CATEGORIES, PAGE_OPTIONS),

    validators: { isController: (device) => device?.serialNumber === "ctrl-a", validOption: () => true, validOptionCategory: () => true }
  };

  const CONTROLLER = { address: "10.0.0.1", name: "Controller A", serialNumber: "ctrl-a" };

  // The controller leads its own device list, which is the arrangement that puts a controller-as-device page on screen at all.
  const DEVICES = [

    { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Controller A", serialNumber: "ctrl-a" },
    { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }
  ];

  const CONTROLLER_PAGE = { controllerId: "ctrl-a", deviceId: "ctrl-a", kind: "device" };
  const DEVICE_PAGE = { controllerId: "ctrl-a", deviceId: "dev-a", kind: "device" };

  // Mount the view over the page catalog at the given scope with its one category expanded, so the assertions read a page that holds real rows. Mirrors setup()'s
  // sequence for a controller-based plugin: the model, the device list through the request/outcome pairing, and the scope all land before the mount.
  const mountPage = ({ configuredOptions = [], scope }) => {

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const configTable = document.createElement("div");
    const controller = new AbortController();

    configTable.id = "configTable";
    document.body.appendChild(configTable);

    store.dispatch({ catalog: PAGE_CATALOG, configuredOptions, controllers: [CONTROLLER], mode: "controller-based", type: "model:loaded" });
    store.dispatch({ controllerId: "ctrl-a", type: "devices:requested" });
    store.dispatch({ controllerId: "ctrl-a", devices: DEVICES, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    store.dispatch({ scope, type: "scope:changed" });

    mountOptionsView({ configTable, platform: () => "test-plugin", signal: controller.signal, store });

    const details = configTable.querySelector("details[data-category='Page']");

    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: false }));

    return { configTable, details, store };
  };

  test("the category header names the controller scope the page edits at", () => {

    using _dom = createTestDom();

    const { details } = mountPage({ scope: CONTROLLER_PAGE });

    assert.equal(details.querySelector(".fo-category-title").textContent, "Page Options (Controller-specific)");
  });

  test("a row set on this page reads as set here, while a globally-inherited row keeps the inherit treatment", () => {

    using _dom = createTestDom();

    const { details } = mountPage({ configuredOptions: [ "Enable.Page.Zone.ctrl-a", "Enable.Page.Anywhere" ], scope: CONTROLLER_PAGE });
    const zone = details.querySelector("[id='row-Page.Zone']");
    const anywhere = details.querySelector("[id='row-Page.Anywhere']");
    const zoneCheckbox = zone.querySelector("input[type='checkbox']");
    const anywhereCheckbox = anywhere.querySelector("input[type='checkbox']");

    // The entry the user wrote right here. It is stored at the controller's serial, so nothing about it is borrowed from above and the row takes gestures.
    assert.equal(zoneCheckbox.checked, true);
    assert.equal(zoneCheckbox.indeterminate, false, "an entry set on this page is not inherited");
    assert.equal(zoneCheckbox.readOnly, false, "and the row is not locked against the user who wrote it");
    assert.equal(zone.querySelector("label").classList.contains("text-info"), true, "it colors as a modified entry set at this scope");

    // The global entry genuinely is borrowed from above, and a controller page inherits from global exactly as any other page does.
    assert.equal(anywhereCheckbox.indeterminate, true, "a global entry is still an inherited one here");
    assert.equal(anywhereCheckbox.readOnly, true);
    assert.equal(anywhere.querySelector("label").classList.contains("text-warning"), true, "and keeps the global source color");
  });

  test("a real device page under the same controller is unchanged: device-specific header, controller entries inherited", () => {

    using _dom = createTestDom();

    const { details } = mountPage({ configuredOptions: ["Enable.Page.Zone.ctrl-a"], scope: DEVICE_PAGE });
    const zoneCheckbox = details.querySelector("[id='row-Page.Zone'] input[type='checkbox']");

    assert.equal(details.querySelector(".fo-category-title").textContent, "Page Options (Device-specific)");
    assert.equal(zoneCheckbox.indeterminate, true, "the controller's entry is upstream of a real device page");
    assert.equal(zoneCheckbox.readOnly, true);
    assert.equal(details.querySelector("[id='row-Page.Zone'] label").classList.contains("text-success"), true, "colored as sourced from the controller");
  });

  test("a toggle on the controller page still writes at the controller's serial", (t) => {

    using _dom = createTestDom();

    // The presented scope governs how the page reads and nothing about where it writes. The write path targets the selected device, which on this page IS the
    // controller, so the entry lands at the controller's serial...this row is what keeps the presented scope from ever reaching that decision.
    const { details, store } = mountPage({ scope: CONTROLLER_PAGE });
    const dispatch = t.mock.method(store, "dispatch");

    details.querySelector("#Page\\.Zone").click();

    const [action] = dispatch.mock.calls[0].arguments;

    assert.equal(action.type, "option:set");
    assert.equal(action.args.id, "ctrl-a", "the action keys from the selected device, which is the controller itself");
    assert.deepEqual(store.state.configuredOptions, ["Enable.Page.Zone.ctrl-a"], "and the entry persists at that serial");
  });
});

describe("mountOptionsView - a controller whose scoping identity differs from its sidebar link", () => {

  // The two-identity shape: the sidebar link is named by the configured address, because the list has to render before any connection, while the entries the
  // connection reveals are keyed by the hardware serial the device list stamps on the controller's own row. Every assertion below is a presentation the framework
  // can only reach by deriving that second identity from the controller-as-device row.
  const NVR_ADDRESS = "192.0.2.1";
  const NVR_MAC = "AABBCCDDEE01";
  const CAMERA_MAC = "AABBCCDDEE02";

  const IDENTITY_CATEGORIES = [{ description: "Camera Options", name: "Camera" }];

  const IDENTITY_OPTIONS = {

    Camera: [

      { default: false, description: "Enable HKSV recording.", name: "Hksv", scopes: [ "controller", "device" ] }
    ]
  };

  const IDENTITY_CATALOG = {

    ...buildCatalogIndex(IDENTITY_CATEGORIES, IDENTITY_OPTIONS),

    validators: { isController: (device) => device?.modelKey === "nvr", validOption: () => true, validOptionCategory: () => true }
  };

  const CONTROLLERS = [{ address: NVR_ADDRESS, name: "Doorbell NVR", serialNumber: NVR_ADDRESS }];

  const DEVICES = [

    { firmwareRevision: "4.0", manufacturer: "Ubiquiti", model: "NVR", modelKey: "nvr", name: "Doorbell NVR", serialNumber: NVR_MAC },
    { firmwareRevision: "4.0", manufacturer: "Ubiquiti", model: "G4", modelKey: "camera", name: "Front Door", serialNumber: CAMERA_MAC }
  ];

  const CONTROLLER_PAGE = { controllerId: NVR_ADDRESS, deviceId: NVR_MAC, kind: "device" };
  const CHILD_PAGE = { controllerId: NVR_ADDRESS, deviceId: CAMERA_MAC, kind: "device" };

  // Mount the view over the two-identity catalog at the given scope with its category expanded. The device list lands stamped with the navigation identity, which
  // is what a real fetch carries, so the derivation has to bridge the two serials itself.
  const mountPage = ({ configuredOptions = [], scope }) => {

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const configTable = document.createElement("div");
    const controller = new AbortController();

    configTable.id = "configTable";
    document.body.appendChild(configTable);

    store.dispatch({ catalog: IDENTITY_CATALOG, configuredOptions, controllers: CONTROLLERS, mode: "controller-based", type: "model:loaded" });
    store.dispatch({ controllerId: NVR_ADDRESS, type: "devices:requested" });
    store.dispatch({ controllerId: NVR_ADDRESS, devices: DEVICES, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
    store.dispatch({ scope, type: "scope:changed" });

    mountOptionsView({ configTable, platform: () => "test-plugin", signal: controller.signal, store });

    const details = configTable.querySelector("details[data-category='Camera']");

    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: false }));

    return { configTable, details, store };
  };

  test("the controller's own page names controller scope and reads its entry as set here", () => {

    using _dom = createTestDom();

    const { details } = mountPage({ configuredOptions: ["Enable.Camera.Hksv." + NVR_MAC], scope: CONTROLLER_PAGE });
    const checkbox = details.querySelector("[id='row-Camera.Hksv'] input[type='checkbox']");

    assert.equal(details.querySelector(".fo-category-title").textContent, "Camera Options (Controller-specific)");
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.indeterminate, false, "the entry was written on this page, so nothing is borrowed from above");
    assert.equal(checkbox.readOnly, false);
    assert.equal(details.querySelector("[id='row-Camera.Hksv'] label").classList.contains("text-info"), true, "colored as a modified entry set at this scope");
  });

  test("a child device's page shows the controller's entry as inherited", () => {

    using _dom = createTestDom();

    const { details } = mountPage({ configuredOptions: ["Enable.Camera.Hksv." + NVR_MAC], scope: CHILD_PAGE });
    const checkbox = details.querySelector("[id='row-Camera.Hksv'] input[type='checkbox']");

    assert.equal(details.querySelector(".fo-category-title").textContent, "Camera Options (Device-specific)");
    assert.equal(checkbox.checked, true, "the controller's value reaches the device beneath it");
    assert.equal(checkbox.indeterminate, true, "and reads as borrowed rather than set here");
    assert.equal(checkbox.readOnly, true);
    assert.equal(details.querySelector("[id='row-Camera.Hksv'] label").classList.contains("text-success"), true, "colored as sourced from the controller");
  });

  test("unchecking an inherited row on a child device writes the explicit device-scope disable", (t) => {

    using _dom = createTestDom();

    // The upstream probe has to find the controller's entry to know that a clear would leave the option enabled by inheritance. Finding it takes the same derived
    // identity the row's own inherit treatment came from, so this is the gesture that proves the transitions are asking about the right serial.
    const { details, store } = mountPage({ configuredOptions: ["Enable.Camera.Hksv." + NVR_MAC], scope: CHILD_PAGE });
    const dispatch = t.mock.method(store, "dispatch");

    details.querySelector("[id='row-Camera.Hksv'] input[type='checkbox']").click();

    const [action] = dispatch.mock.calls[0].arguments;

    assert.equal(action.type, "option:set", "an explicit disable, not a clear that would fall back to the controller's enable");
    assert.equal(action.args.enabled, false);
    assert.equal(action.args.id, CAMERA_MAC, "written at the device the page is editing");
    assert.equal(store.state.configuredOptions.includes("Disable.Camera.Hksv." + CAMERA_MAC), true, "the device-scope disable persists beneath the controller entry");
    assert.equal(store.state.configuredOptions.includes("Enable.Camera.Hksv." + NVR_MAC), true, "and the controller's own entry is left alone");
  });

  test("a toggle on the controller's own page writes at the controller's scoping identity", (t) => {

    using _dom = createTestDom();

    const { details, store } = mountPage({ scope: CONTROLLER_PAGE });
    const dispatch = t.mock.method(store, "dispatch");

    details.querySelector("[id='row-Camera.Hksv'] input[type='checkbox']").click();

    const [action] = dispatch.mock.calls[0].arguments;

    assert.equal(action.args.id, NVR_MAC, "the write keys off the selected device, which on this page carries the controller's own serial");
    assert.deepEqual(store.state.configuredOptions, ["Enable.Camera.Hksv." + NVR_MAC]);
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

describe("mountOptionsView - controller-scope cache invalidation", () => {

  /* The single-identity controller shape: the controllers list and the controller's own device row carry the same serial. That is what a plugin whose device
   * list is already stamped with hardware serials presents, and it is the condition the prefix sweep turns on - a controller-page mutation names a serial the
   * controllers list recognizes, so the sweep can find every device view that inherits from it by the first segment of its cache key.
   */
  const CTRL_A = "AABBCCDDEE01";
  const CTRL_B = "AABBCCDDEE02";
  const CHILD_A = "AABBCCDDEE11";
  const CHILD_B = "AABBCCDDEE21";

  const CACHE_CATEGORIES = [{ description: "Camera Options", name: "Camera" }];

  /* The catalog reaches every scope, because so do the views this test caches. Hksv is the controller-scoped option the mutation lands on, while Enabled carries
   * no scopes declaration and so is valid everywhere - without it the category would be inactive at global scope and the global view would have no table to cache.
   */
  const CACHE_OPTIONS = {

    Camera: [

      { default: true, description: "Enable the camera.", name: "Enabled" },
      { default: false, description: "Enable HKSV recording.", name: "Hksv", scopes: [ "controller", "device" ] }
    ]
  };

  const CACHE_CATALOG = {

    ...buildCatalogIndex(CACHE_CATEGORIES, CACHE_OPTIONS),

    validators: { isController: (device) => device?.modelKey === "nvr", validOption: () => true, validOptionCategory: () => true }
  };

  const CACHE_CONTROLLERS = [

    { address: "192.0.2.1", name: "NVR A", serialNumber: CTRL_A },
    { address: "192.0.2.2", name: "NVR B", serialNumber: CTRL_B }
  ];

  // A controller's device list: its own row, which isController answers to, alongside the camera beneath it.
  const devicesUnder = (controllerSerial, childSerial) => [

    { firmwareRevision: "4.0", manufacturer: "Ubiquiti", model: "NVR", modelKey: "nvr", name: "NVR", serialNumber: controllerSerial },
    { firmwareRevision: "4.0", manufacturer: "Ubiquiti", model: "G4", modelKey: "camera", name: "Camera", serialNumber: childSerial }
  ];

  // Land a controller's device list the way a completed fetch does, so the scoping identity derives from a device list that actually names this controller.
  const loadDevices = (store, controllerSerial, childSerial) => {

    store.dispatch({ controllerId: controllerSerial, type: "devices:requested" });
    store.dispatch({ controllerId: controllerSerial, devices: devicesUnder(controllerSerial, childSerial), error: "",
      seq: store.state.devicesRequest.seq, type: "devices:loaded" });
  };

  // Navigate to a scope and expand its category, which is what materializes the view's rows. Hands back the category element, whose identity on a later visit is
  // how a cache restore is told from a fresh build.
  const visit = (configTable, store, scope) => {

    store.dispatch({ scope, type: "scope:changed" });

    const details = configTable.querySelector("details[data-category='Camera']");

    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: false }));

    return details;
  };

  test("a controller-scope mutation sweeps that controller's cached device views and leaves every unrelated entry standing", () => {

    using _dom = createTestDom();

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const configTable = document.createElement("div");
    const controller = new AbortController();

    configTable.id = "configTable";
    document.body.appendChild(configTable);

    store.dispatch({ catalog: CACHE_CATALOG, configuredOptions: [], controllers: CACHE_CONTROLLERS, mode: "controller-based", type: "model:loaded" });
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });

    mountOptionsView({ configTable, platform: () => "test-plugin", signal: controller.signal, store });

    // Populate the cache with the views that will still be in it when the mutation lands: the global view, a device under controller B, and a device under
    // controller A. Each is cached by the navigation that leaves it.
    const globalDetails = visit(configTable, store, { kind: "global" });

    loadDevices(store, CTRL_B, CHILD_B);

    const childBDetails = visit(configTable, store, { controllerId: CTRL_B, deviceId: CHILD_B, kind: "device" });

    loadDevices(store, CTRL_A, CHILD_A);

    const childADetails = visit(configTable, store, { controllerId: CTRL_A, deviceId: CHILD_A, kind: "device" });

    // Move onto controller A's own page and toggle its option there. The write names controller A's serial, which is the scope marker the sweep matches against
    // the controllers list.
    const controllerPage = visit(configTable, store, { controllerId: CTRL_A, deviceId: CTRL_A, kind: "device" });

    controllerPage.querySelector("[id='row-Camera.Hksv'] input[type='checkbox']").click();

    assert.deepEqual(store.state.configuredOptions, ["Enable.Camera.Hksv." + CTRL_A], "precondition: the mutation was written at controller A's own scope");

    // Controller A's cached device view inherited from the scope that just moved, so it must have been dropped: the return trip builds a new category element.
    const childAAfter = visit(configTable, store, { controllerId: CTRL_A, deviceId: CHILD_A, kind: "device" });

    assert.ok(childAAfter !== childADetails, "the device under the mutated controller was swept from the cache, so its view is rebuilt rather than restored");

    // Nothing else inherits from controller A, so the unrelated entries come back by identity - the very elements that were detached.
    const globalAfter = visit(configTable, store, { kind: "global" });

    assert.ok(globalAfter === globalDetails, "the global view was never touched by the sweep and is restored from cache");

    loadDevices(store, CTRL_B, CHILD_B);

    const childBAfter = visit(configTable, store, { controllerId: CTRL_B, deviceId: CHILD_B, kind: "device" });

    assert.ok(childBAfter === childBDetails, "the other controller's device view survives a sweep aimed at controller A");
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

describe("mountOptionsView - deference to a standing connection error", () => {

  const CONTROLLER_A = "ctrl-a";
  const CONTROLLER_B = "ctrl-b";
  const DEVICE_A = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };

  // Drive a controller click's full dispatch order - the optimistic scope, the fetch record, then the outcome - so the render passes land in the order production
  // produces them. The outcome's shape is what decides whether this reads as a failure or as a healthy list.
  const clickController = (store, { controllerId, devices = [], error = "" }) => {

    store.dispatch({ scope: { controllerId, kind: "controller" }, type: "scope:changed" });
    store.dispatch({ controllerId, type: "devices:requested" });
    store.dispatch({ controllerId, devices, error, seq: store.state.devicesRequest.seq, type: "devices:loaded" });
  };

  test("a controller click that fails leaves the config table empty rather than rendering the failed controller's options", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A, error: "Controller unreachable." });

    assert.equal(store.state.status.kind, "connection-error", "precondition: the failed outcome raised the error");
    assert.equal(configTable.children.length, 0, "the table renders nothing under the error frame");
    assert.ok(configTable.querySelector("details[data-category]") === null, "no category shell survives, so no option row can be reached");
  });

  test("a clean outcome after the failure restores the table", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A, error: "Controller unreachable." });
    clickController(store, { controllerId: CONTROLLER_B, devices: [DEVICE_A] });

    assert.equal(store.state.status.kind, "ready", "precondition: the clean outcome recovered the status");
    assert.notEqual(configTable.querySelectorAll("details[data-category]").length, 0, "the category shells are back");
  });

  test("the view left behind is cached and comes back through the recovery, rather than being rebuilt from scratch", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    // Land a device list and open a category so the global view holds materialized rows worth recognizing on return.
    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [DEVICE_A], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));

    // Fail into the error presentation, then recover straight back to the same view.
    clickController(store, { controllerId: CONTROLLER_A, error: "Controller unreachable." });
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });

    assert.equal(configTable.children.length, 0, "precondition: the error presentation is still standing over the global view");

    store.dispatch({ controllerId: null, type: "devices:requested" });
    store.dispatch({ controllerId: null, devices: [DEVICE_A], error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });

    const restoredMotion = configTable.querySelector("details[data-category='Motion']");

    assert.ok(restoredMotion === motion, "the very element detached before the failure is the one that comes back - the cache served it, not a rebuild");
  });

  test("the busy and projection passes are safe against the childless table the error presentation leaves", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A, error: "Controller unreachable." });

    // Both walks query the table for structure they will not find. They must read the absence as nothing to do rather than as something to fail on - a filter
    // change and a fresh fetch record can each land while the error stands.
    store.dispatch({ query: "motion", type: "filter:changed" });
    store.dispatch({ controllerId: CONTROLLER_A, type: "devices:requested" });

    assert.equal(configTable.children.length, 0, "the table is still empty and neither pass threw");
  });
});

describe("mountOptionsView - the nothing-to-list notice", () => {

  const CONTROLLER_A = "ctrl-a";
  const CONTROLLER_B = "ctrl-b";
  const DEVICE_A = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };
  const NOTICE = "This controller has no cameras adopted.";

  // A sidebar controller click's full dispatch order: the optimistic scope, the fetch record, then the outcome. An `emptyMessage` on a clean device-less outcome is
  // what turns the resting controller view into a notice.
  const clickController = (store, { controllerId, devices = [], emptyMessage, error = "" }) => {

    store.dispatch({ scope: { controllerId, kind: "controller" }, type: "scope:changed" });
    store.dispatch({ controllerId, type: "devices:requested" });
    store.dispatch({ controllerId, devices, emptyMessage, error, seq: store.state.devicesRequest.seq, type: "devices:loaded" });
  };

  const notice = (configTable) => configTable.querySelector(".fo-devices-notice");

  test("renders the plugin's message in place of the option table", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A, emptyMessage: NOTICE });

    assert.ok(notice(configTable), "the notice is mounted");
    assert.equal(notice(configTable).textContent, NOTICE, "carrying the plugin's copy verbatim");
    assert.ok(configTable.querySelector("details[data-category]") === null, "and no option row is offered beside it");
  });

  test("renders the message as text, never as markup", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A, emptyMessage: "<b>bold</b> & <script>x</script>" });

    assert.equal(notice(configTable).children.length, 0, "the message produced no elements - it is a text node");
    assert.equal(notice(configTable).textContent, "<b>bold</b> & <script>x</script>", "and reads back verbatim");
  });

  test("an empty outcome with no message keeps today's behavior - the full table at controller scope", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A });

    assert.equal(notice(configTable), null, "no notice");
    assert.notEqual(configTable.querySelectorAll("details[data-category]").length, 0, "the table renders as it always did");
  });

  test("the notice never enters the DOM cache, so leaving and returning rebuilds it rather than restoring it", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A, emptyMessage: NOTICE });

    const first = notice(configTable);

    // Leave for the global view and come back. A cached notice would return by identity; a rebuilt one is a different element carrying the same copy.
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
    store.dispatch({ scope: { controllerId: CONTROLLER_A, kind: "controller" }, type: "scope:changed" });

    const second = notice(configTable);

    assert.ok(second, "a notice is mounted again");
    assert.ok(second !== first, "and it is a fresh element - notice DOM is view-mortal, rebuilt from the outcome on every entry");
  });

  test("a cached table under the notice's own key survives the notice and returns when devices come back", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    // Visit the controller with devices so its table is built and expanded, then leave, so its DOM is cached under the controller key.
    clickController(store, { controllerId: CONTROLLER_A, devices: [DEVICE_A] });

    const motion = configTable.querySelector("details[data-category='Motion']");

    motion.open = true;
    motion.dispatchEvent(new Event("toggle", { bubbles: false }));
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });

    // Return to the same controller, which now reports itself empty. The notice renders; the cached table must still be waiting behind it.
    clickController(store, { controllerId: CONTROLLER_A, emptyMessage: NOTICE });

    assert.ok(notice(configTable), "the notice took the surface");
    assert.ok(configTable.querySelector("details[data-category]") === null, "the just-cached table was not restored under it");

    // The controller reports devices again. The cached table is what comes back.
    clickController(store, { controllerId: CONTROLLER_A, devices: [DEVICE_A] });

    assert.equal(notice(configTable), null, "the notice is gone");
    assert.ok(configTable.querySelector("details[data-category='Motion']") === motion, "the very element cached before the notice is the one that returns");
  });

  test("leaving a notice view caches nothing for its key, so a table built there later is the one that caches", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    // Enter a notice view whose key has never held a table, then leave it and come back with devices. What renders must be a freshly-built table, not notice DOM.
    clickController(store, { controllerId: CONTROLLER_B, emptyMessage: NOTICE });
    store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
    clickController(store, { controllerId: CONTROLLER_B, devices: [DEVICE_A] });

    assert.equal(notice(configTable), null, "no notice DOM came back out of the cache");
    assert.notEqual(configTable.querySelectorAll("details[data-category]").length, 0, "a real table is what the view holds");
  });

  test("the busy and projection passes are safe against the notice-only table", () => {

    using _dom = createTestDom();

    const { configTable, store } = setup();

    clickController(store, { controllerId: CONTROLLER_A, emptyMessage: NOTICE });

    // Both walks query the table for category structure that is not there. A filter change and a fresh fetch record can each land while the notice is mounted.
    store.dispatch({ query: "motion", type: "filter:changed" });
    store.dispatch({ controllerId: CONTROLLER_A, type: "devices:requested" });

    assert.ok(notice(configTable), "the notice still stands and neither pass threw");
  });
});

/* The picker rows at the view layer. What the delegation has to get right is which gesture means what: a member checkbox is a value commit and never a tri-state
 * click, a dropdown click belongs to the dropdown and never to the row, and a control the user abandons stands its row down the way a text field does.
 */
const PICKER_CATEGORIES = [{ description: "Picker Options", name: "Pick" }];

const PICKER_OPTIONS = {

  Pick: [

    { choices: [ { label: "High", value: "high" }, { label: "Low", value: "low" } ], default: true, defaultValue: "high", description: "Stream tier.",
      name: "Tier", style: "dropdown" },
    { choices: [ { label: "High", value: "high" }, { label: "Low", value: "low" } ], default: false, defaultValue: "", description: "Stream tier, no default.",
      name: "TierUnset", style: "dropdown" },

    // The radio pair declares no style, so what settles them as radios is the autoselection reading a short inline list. Their default is deliberately not the
    // first member, which is what lets a group resting on the declared default be told apart from one that fell back to whichever member comes first.
    { choices: [ { label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" } ], default: true,
      defaultValue: "medium", description: "Capture quality.", name: "Quality" },
    { choices: [ { label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" } ], default: false, defaultValue: "",
      description: "Capture quality, no default.", name: "QualityUnset" },

    { choices: "types", default: true, defaultValue: "a,b", description: "Detected types.", multiple: true, name: "Types" },
    { choices: "types", default: false, defaultValue: "", description: "Detected types, no default.", multiple: true, name: "TypesUnset" },
    { choices: "types", default: true, defaultValue: "", description: "A single choice drawn from the same source.", name: "Named" },
    { default: true, defaultValue: "a,b", description: "Licence plates.", multiple: true, name: "Plates" },
    { default: false, defaultValue: "", description: "Licence plates, no default.", multiple: true, name: "PlatesUnset" },
    { default: true, defaultValue: "", description: "Streaming account password.", name: "Password", secret: true }
  ]
};

const pickerSetup = ({ configuredOptions = [], controllers = [], devices = [], mode = "device-only", scope, types } = {}) => {

  const catalog = {

    ...buildCatalogIndex(PICKER_CATEGORIES, PICKER_OPTIONS),

    choiceSources: { types: types ?? (() => [ { label: "A", value: "a" }, { label: "B", value: "b" } ]) },

    validators: { isController: (device) => device?.serialNumber?.startsWith("ctrl") === true, validOption: () => true, validOptionCategory: () => true }
  };

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const configTable = document.createElement("div");
  const controller = new AbortController();

  configTable.id = "configTable";
  document.body.appendChild(configTable);

  store.dispatch({ catalog, configuredOptions, controllers, mode, type: "model:loaded" });

  mountOptionsView({ configTable, platform: () => "test-plugin", signal: controller.signal, store });

  store.dispatch({ controllerId: scope?.controllerId ?? null, type: "devices:requested" });
  store.dispatch({ controllerId: scope?.controllerId ?? null, devices, error: "", seq: store.state.devicesRequest.seq, type: "devices:loaded" });
  store.dispatch({ scope: scope ?? { kind: "global" }, type: "scope:changed" });

  const details = configTable.querySelector("details[data-category='Pick']");

  details.open = true;
  details.dispatchEvent(new Event("toggle", { bubbles: false }));

  return { abort: () => controller.abort(), configTable, store };
};

const pickerControl = (configTable, optionName) => configTable.querySelector("[id='row-Pick." + optionName + "'] .fo-option-value");

describe("mountOptionsView - picker delegation", () => {

  test("a member checkbox commits the list and never touches the option's enabled state", () => {

    using _dom = createTestDom();

    const { configTable, store } = pickerSetup();
    const group = pickerControl(configTable, "Types");
    const rowCheckbox = configTable.querySelector("[id='row-Pick.Types'] .fo-option-checkbox");

    assert.equal(rowCheckbox.checked, true, "precondition: the row is enabled by its catalog default");

    // Uncheck "b" out of the default "a,b" selection. A group's boxes are checkboxes inside the same row as the tri-state, so routing one to the tri-state machine
    // would have a member selection flip the option itself.
    const boxes = [...group.querySelectorAll(".fo-choice-checkbox")];

    boxes[1].checked = false;
    boxes[1].dispatchEvent(new Event("change", { bubbles: true }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Types=a"], "the member change committed the list");
    assert.equal(configTable.querySelector("[id='row-Pick.Types'] .fo-option-checkbox").checked, true, "and left the option enabled");
  });

  test("a radio member click commits the picked value and never touches the option's enabled state", () => {

    using _dom = createTestDom();

    const { configTable, store } = pickerSetup();
    const rowCheckbox = configTable.querySelector("[id='row-Pick.Quality'] .fo-option-checkbox");

    assert.equal(rowCheckbox.checked, true, "precondition: the row is enabled by its catalog default");

    // A radio member is an input inside the row exactly as a group's checkbox is, so it asks the delegation the same question: the gesture is the option's value,
    // and routing it to the tri-state machine would have a pick answer for the option itself.
    pickerControl(configTable, "Quality").querySelector(".fo-choice-checkbox[value='high']").click();

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Quality=high"], "the pick committed as the option's value");
    assert.equal(configTable.querySelector("[id='row-Pick.Quality'] .fo-option-checkbox").checked, true, "and left the option enabled, with no tri-state gesture taken");
  });

  test("a default-matching radio pick clears the option, and the re-derived group rests on the default", () => {

    using _dom = createTestDom();

    const { configTable, store } = pickerSetup({ configuredOptions: ["Enable.Pick.Quality=high"] });

    // Picking the member the catalog already defaults to says nothing the default does not, so the commit normalizes to a clear rather than storing what
    // resolution would answer anyway. The declared default is not the first member, so where the group rests afterwards names the value the projection resolved.
    pickerControl(configTable, "Quality").querySelector(".fo-choice-checkbox[value='medium']").click();

    assert.deepEqual(store.state.configuredOptions, [], "the default-matching pick cleared the stored deviation");
    assert.deepEqual([...pickerControl(configTable, "Quality").querySelectorAll(".fo-choice-checkbox")].map((b) => b.checked), [ false, true, false ],
      "and the group rests on the declared default");
  });

  test("a dropdown change commits the picked value", () => {

    using _dom = createTestDom();

    const { configTable, store } = pickerSetup();
    const select = pickerControl(configTable, "Tier");

    select.value = "low";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Tier=low"]);
  });

  test("clicking a dropdown never reaches the row checkbox, and clicking a member label answers as that member", () => {

    using _dom = createTestDom();

    const { configTable, store } = pickerSetup();
    const configuredBefore = store.state.configuredOptions;

    // A click on the dropdown opens it and says nothing about the option. Neither click is a click on the row's whitespace, which is the only thing the row
    // forward exists for, so neither may flip the option's own checkbox.
    pickerControl(configTable, "Tier").click();

    assert.equal(store.state.configuredOptions, configuredBefore, "the same array reference - a dropdown click dispatches nothing at all");

    // A member label wraps its own box, so clicking it toggles that member natively and commits the list. What it must not do is toggle the row.
    pickerControl(configTable, "Types").querySelector(".fo-choice").click();

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Types=b"], "the label click answered as its own member and committed the remaining list");
    assert.equal(configTable.querySelector("[id='row-Pick.Types'] .fo-option-checkbox").checked, true, "and the option itself stayed enabled");
  });

  test("the busy lock reaches a dropdown and a group's boxes, and leaves the secret reveal alone", () => {

    using _dom = createTestDom();

    // A controller scope whose device list has not landed is the window the lock exists for.
    const { configTable, store } = pickerSetup({ controllers: [{ name: "Hub", serialNumber: "ctrl-a" }], mode: "controller-based",
      scope: { controllerId: "ctrl-a", kind: "controller" } });

    store.dispatch({ controllerId: "ctrl-a", type: "devices:requested" });

    assert.equal(configTable.classList.contains("fo-options-busy"), true, "precondition: the window is open");
    assert.equal(pickerControl(configTable, "Tier").disabled, true, "a dropdown is write-capable and goes inert");
    assert.deepEqual([...pickerControl(configTable, "Types").querySelectorAll(".fo-choice-checkbox")].map((b) => b.disabled), [ true, true ],
      "every member box goes inert");
    assert.equal(configTable.querySelector("[id='row-Pick.Password'] .fo-secret-toggle").disabled, false,
      "the reveal reads a value rather than writing one, and keeps its own lock in applyRowState");
  });

  test("a locked row previews its default selection, as a text row previews its default text", () => {

    using _dom = createTestDom();

    // Nothing configured at any scope, and the option disabled, so the row is locked and shows what resolution would yield if it were not.
    const { configTable } = pickerSetup({ configuredOptions: [ "Disable.Pick.Tier", "Disable.Pick.Types" ] });

    assert.equal(pickerControl(configTable, "Tier").value, "high", "the dropdown rests on the declared default");
    assert.deepEqual([...pickerControl(configTable, "Types").querySelectorAll(".fo-choice-checkbox")].map((b) => b.checked), [ true, true ],
      "and the group shows the default list's selection");
  });
});

describe("mountOptionsView - picker arming and abandonment", () => {

  const DEVICE = { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" };

  const scopedPickerSetup = (extra = {}) => pickerSetup({ devices: [DEVICE], scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, ...extra });

  test("arming a group row hands focus to its first member box", () => {

    using _dom = createTestDom();

    const { configTable, store } = scopedPickerSetup();
    const rowCheckbox = configTable.querySelector("[id='row-Pick.TypesUnset'] .fo-option-checkbox");

    rowCheckbox.checked = true;
    rowCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    assert.equal(store.state.armedOption, "Pick.TypesUnset", "an empty scoped picker arms rather than writing");
    assert.ok(document.activeElement === pickerControl(configTable, "TypesUnset").querySelector(".fo-choice-checkbox"),
      "a fieldset is not focusable, so the affordance is its first box");
  });

  test("arming a dropdown row hands focus to the dropdown", () => {

    using _dom = createTestDom();

    const { configTable, store } = scopedPickerSetup();
    const rowCheckbox = configTable.querySelector("[id='row-Pick.TierUnset'] .fo-option-checkbox");

    rowCheckbox.checked = true;
    rowCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    assert.equal(store.state.armedOption, "Pick.TierUnset");
    assert.ok(document.activeElement === pickerControl(configTable, "TierUnset"), "a dropdown takes focus itself");
  });

  test("abandoning an armed picker row stands it down, for both control kinds", () => {

    using _dom = createTestDom();

    for(const optionName of [ "TierUnset", "TypesUnset" ]) {

      const { configTable, store } = scopedPickerSetup();
      const rowCheckbox = configTable.querySelector("[id='row-Pick." + optionName + "'] .fo-option-checkbox");

      rowCheckbox.checked = true;
      rowCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

      assert.equal(store.state.armedOption, "Pick." + optionName, "precondition: the row is armed");

      // Focus leaves the row without a value ever being chosen, which is the abandonment gesture. The departing element may be the control itself or a part inside
      // it, and both have to reach the same rule.
      const departing = document.activeElement;

      departing.dispatchEvent(new Event("focusout", { bubbles: true }));

      assert.equal(store.state.armedOption, null, optionName + " stands down when focus leaves with nothing chosen");
      assert.equal(configTable.querySelector("[id='row-Pick." + optionName + "'] .fo-option-checkbox").checked, false, optionName + " unchecks with it");
    }
  });

  test("abandoning an armed radio row stands it down", () => {

    using _dom = createTestDom();

    const { configTable, store } = scopedPickerSetup();
    const rowCheckbox = configTable.querySelector("[id='row-Pick.QualityUnset'] .fo-option-checkbox");

    rowCheckbox.checked = true;
    rowCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    assert.equal(store.state.armedOption, "Pick.QualityUnset", "precondition: the row armed rather than writing");

    // An untouched radio group holds nothing, since focus alone selects no member, so the departure carries no value and is the abandonment gesture. What leaves
    // is the member box the arming handed focus to, which reaches the rule through the group it sits in.
    document.activeElement.dispatchEvent(new Event("focusout", { bubbles: true }));

    assert.equal(store.state.armedOption, null, "the row stands down when focus leaves with no member picked");
    assert.deepEqual(store.state.configuredOptions, [], "and nothing was written on the way out");
    assert.equal(configTable.querySelector("[id='row-Pick.QualityUnset'] .fo-option-checkbox").checked, false, "the row unchecks with it");
  });

  test("an armed picker row that HAS a selection survives the focus departure", () => {

    using _dom = createTestDom();

    const { configTable, store } = scopedPickerSetup();
    const rowCheckbox = configTable.querySelector("[id='row-Pick.TypesUnset'] .fo-option-checkbox");

    rowCheckbox.checked = true;
    rowCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    const box = pickerControl(configTable, "TypesUnset").querySelector(".fo-choice-checkbox");

    box.checked = true;

    box.dispatchEvent(new Event("focusout", { bubbles: true }));

    assert.equal(store.state.armedOption, "Pick.TypesUnset", "a row carrying a selection has something to commit and is not an abandonment");
  });
});

describe("mountOptionsView - a controller refresh and a device switch re-derive a resolved list", () => {

  test("a controllers-only refresh re-renders the row in place, with focus and node identity intact", () => {

    using _dom = createTestDom();

    const byController = ({ controller }) => [{ label: "Named", value: controller?.name ?? "none" }];
    const { configTable, store } = pickerSetup({ controllers: [{ name: "old", serialNumber: "ctrl-a" }], mode: "controller-based",
      scope: { controllerId: "ctrl-a", kind: "controller" }, types: byController });

    const group = pickerControl(configTable, "TypesUnset");
    const select = pickerControl(configTable, "Named");

    assert.deepEqual([...group.querySelectorAll(".fo-choice-checkbox")].map((b) => b.value), ["old"], "the source read the controller in scope");
    assert.deepEqual([...select.options].map((o) => o.value), [ "", "old" ], "and the dropdown drawn from the same source reads it too");

    /* The FOCUSED control here is the source-backed dropdown itself, which is the whole point of the case: a dropdown holds nothing uncommitted, so it is written
     * from the projection whether or not it has focus. Gating that write behind an activeElement check - the guard the text field needs - would strand a focused
     * dropdown showing the departed controller's list, and this is the assertion that would catch it.
     */
    select.focus();

    const focusedBefore = document.activeElement;
    const rowBefore = configTable.querySelector("[id='row-Pick.TypesUnset']");

    store.dispatch({ controllers: [{ name: "new", serialNumber: "ctrl-a" }], type: "controllers:loaded" });

    assert.deepEqual([...pickerControl(configTable, "TypesUnset").querySelectorAll(".fo-choice-checkbox")].map((b) => b.value), ["new"],
      "the refreshed controller gives the source a different list to offer");
    assert.deepEqual([...pickerControl(configTable, "Named").options].map((o) => o.value), [ "", "new" ],
      "and the focused dropdown is re-derived along with it rather than being left behind");
    assert.ok(configTable.querySelector("[id='row-Pick.TypesUnset']") === rowBefore, "the row itself was re-derived in place, never detached and rebuilt");
    assert.ok(document.activeElement === focusedBefore, "and whatever the user had focused still has focus");
  });

  test("switching devices rebuilds a resolved list rather than serving the prior device's from the DOM cache", () => {

    using _dom = createTestDom();

    // Two devices whose source answers differently. The per-device DOM cache is what makes this worth asserting: device A's row DOM is what device B would be
    // shown if the cache were served without a re-derive.
    const devices = [ { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "A", serialNumber: "dev-a" },
      { firmwareRevision: "1", manufacturer: "X", model: "Y", name: "B", serialNumber: "dev-b" } ];

    const perDevice = ({ device }) => (device?.serialNumber === "dev-b") ?
      [ { label: "Y", value: "y" }, { label: "Z", value: "z" } ] :
      [ { label: "X", value: "x" }, { label: "Y", value: "y" } ];

    const { configTable, store } = pickerSetup({ devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" }, types: perDevice });

    assert.deepEqual([...pickerControl(configTable, "TypesUnset").querySelectorAll(".fo-choice-checkbox")].map((b) => b.value), [ "x", "y" ],
      "device A's own list");
    assert.deepEqual([...pickerControl(configTable, "Named").options].map((o) => o.value), [ "", "x", "y" ], "and the dropdown drawn from the same source");

    store.dispatch({ scope: { controllerId: null, deviceId: "dev-b", kind: "device" }, type: "scope:changed" });

    const details = configTable.querySelector("details[data-category='Pick']");

    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: false }));

    assert.deepEqual([...pickerControl(configTable, "TypesUnset").querySelectorAll(".fo-choice-checkbox")].map((b) => b.value), [ "y", "z" ],
      "device B is shown its own list, not the one built for device A");
    assert.deepEqual([...pickerControl(configTable, "Named").options].map((o) => o.value), [ "", "y", "z" ],
      "and the dropdown too, with its leading empty option intact through the rebuild");
  });
});

/* The list editor at the view layer. The editor edits itself through its own gestures, so what the view has to prove is that the result reaches the store by the
 * same route a text field's commit takes, and that the row's own machinery - the click forward, the busy lock, the abandonment rule - treats it as one control.
 */
describe("mountOptionsView - the list editor", () => {

  const editorControl = (configTable) => configTable.querySelector("[id='row-Pick.Plates'] .fo-option-value");

  const typeInto = (control, text, key = "Enter") => {

    const field = control.querySelector(".fo-list-entry");

    field.value = text;
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
  };

  test("each gesture commits through the same path a text field's commit takes", () => {

    using _dom = createTestDom();

    const { configTable, store } = pickerSetup();
    const control = editorControl(configTable);

    typeInto(control, "zed");

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Plates=a,b,zed"], "an added entry reaches the store");

    control.querySelectorAll(".fo-list-remove")[0].click();

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Plates=b,zed"], "a removed entry does too");

    const field = control.querySelector(".fo-list-entry");

    field.value = "";
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Plates=b"], "and so does a Backspace erase");
  });

  test("pressing a remove control removes its entry and leaves the option's own checkbox untouched", () => {

    using _dom = createTestDom();

    /* What this proves is the OUTCOME, not the route. The row-level click forward is not what spares the checkbox here: the editor answers the press on its own
     * element, deeper in the tree, and detaching the item takes the pressed button out of the document with it - so the row lookup in the delegation already reads
     * null when the event arrives, and the exclusion list is never consulted for this gesture.
     */
    const { configTable, store } = pickerSetup();
    const rowCheckbox = configTable.querySelector("[id='row-Pick.Plates'] .fo-option-checkbox");

    assert.equal(rowCheckbox.checked, true, "precondition: the row is enabled by its catalog default");

    editorControl(configTable).querySelectorAll(".fo-list-remove")[0].click();

    assert.equal(configTable.querySelector("[id='row-Pick.Plates'] .fo-option-checkbox").checked, true,
      "the press removed an entry and said nothing about the option itself");
    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Plates=b"], "the only thing it moved is the list");
  });

  test("the busy lock reaches the editor's field and its remove controls", () => {

    using _dom = createTestDom();

    const { configTable, store } = pickerSetup({ controllers: [{ name: "Hub", serialNumber: "ctrl-a" }], mode: "controller-based",
      scope: { controllerId: "ctrl-a", kind: "controller" } });

    store.dispatch({ controllerId: "ctrl-a", type: "devices:requested" });

    const control = editorControl(configTable);

    assert.equal(configTable.classList.contains("fo-options-busy"), true, "precondition: the window is open");
    assert.equal(control.querySelector(".fo-list-entry").disabled, true, "the entry field is write-capable and goes inert");
    assert.deepEqual([...control.querySelectorAll(".fo-list-remove")].map((b) => b.disabled), [ true, true ], "and so does every remove control");
  });

  test("abandoning an armed editor row stands it down", () => {

    using _dom = createTestDom();

    // The option that declares no default is the one that can arm at all: a row previewing a default already has something to persist, so checking it writes.
    const devices = [{ firmwareRevision: "1", manufacturer: "X", model: "Y", name: "Device A", serialNumber: "dev-a" }];
    const { configTable, store } = pickerSetup({ devices, scope: { controllerId: null, deviceId: "dev-a", kind: "device" } });

    const rowCheckbox = configTable.querySelector("[id='row-Pick.PlatesUnset'] .fo-option-checkbox");

    rowCheckbox.checked = true;
    rowCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    assert.equal(store.state.armedOption, "Pick.PlatesUnset", "an empty scoped editor arms rather than writing");
    assert.ok(document.activeElement === configTable.querySelector("[id='row-Pick.PlatesUnset'] .fo-list-entry"),
      "and focus lands where the first entry is typed");

    // Focus leaves the row with nothing ever entered, which is the abandonment gesture. The departing element is INSIDE the control rather than being it.
    document.activeElement.dispatchEvent(new Event("focusout", { bubbles: true }));

    assert.equal(store.state.armedOption, null, "the row stands down");
    assert.equal(configTable.querySelector("[id='row-Pick.PlatesUnset'] .fo-option-checkbox").checked, false, "and unchecks with it");
  });

  test("a change on the editor commits its entries together with whatever is still pending in the field", () => {

    using _dom = createTestDom();

    /* The control-level half of the pending-text rule: whatever raises a change on the editor, the value that reaches the store carries the field's unfinished
     * text along with the entries. The other half - that the pre-Save window blur is what raises it while the field still holds focus and has never blurred -
     * is exercised against the real window listener in webUi-featureOptions.test.mjs, since that listener belongs to the orchestrator rather than to this view.
     */
    const { configTable, store } = pickerSetup();
    const control = editorControl(configTable);
    const field = control.querySelector(".fo-list-entry");

    field.focus();
    field.value = "typed-not-entered";

    control.dispatchEvent(new Event("change", { bubbles: true }));

    assert.deepEqual(store.state.configuredOptions, ["Enable.Pick.Plates=a,b,typed-not-entered"],
      "the pending text came along with the entries rather than being dropped");
  });
});
