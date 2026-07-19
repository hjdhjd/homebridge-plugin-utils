/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi.test.mjs: Unit tests for the webUi orchestrator - constructor wiring, show() lifecycle, the two routing branches (feature-options vs first-run), the
 * first-run click flow, menu listeners, the #processHandler function-vs-truthy normalization, and the #toggleClasses Bootstrap class swap. The orchestrator's
 * inner webUiFeatureOptions instance is constructed against the real implementation so the constructor's DOM-binding contract is exercised end-to-end, but the
 * inner instance's `show()` and `hide()` methods are stubbed per-test so the orchestrator's call ordering is verified without re-exercising the entire feature-
 * options rendering pipeline (which has its own dedicated suite in `webUi-featureOptions.test.mjs`).
 */
"use strict";

import { createFakeHomebridge, createSkeletonFeatureOptionsDom, createTestDom, installHomebridge, installWebUiBoot } from "./ui.helpers.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flushPending } from "node:timers/promises";
import { webUi } from "./webUi.mjs";

// Build a webUi instance against the skeleton DOM with featureOptions.show / featureOptions.hide stubbed to record calls. The harness bundles the two real
// disposables every test needs (the DOM globals and the homebridge install) alongside two plain data properties (the orchestrator instance and the inner
// stubs' call records) returned for assertions, all wrapped in a single object that tests bind with `using` so cleanup runs even on failure.
function makeWebUiHarness({ name = "TestPlatform", config = [], firstRun, requestResponses, featureOptions, accessories = [], unstubbed = false } = {}) {

  const dom = createTestDom();
  const skeleton = createSkeletonFeatureOptionsDom();
  const fake = createFakeHomebridge({ cachedAccessories: accessories, config, requestResponses });
  const homebridgeGuard = installHomebridge(fake);
  const ui = new webUi({ featureOptions, firstRun, name });

  const featureOptionsCalls = [];

  // Default: replace the inner orchestrator's show/hide with tracking stubs so we can assert call ordering without driving the full feature-options pipeline. The
  // original methods stay on the prototype - we only replace the per-instance bindings, so leaks across tests cannot occur. The `unstubbed` opt-out drives the REAL
  // feature-options pipeline (so a real sync()/persist drain runs): used by the reconciliation-ordering tests that must observe the actual sync-before-show and
  // flush-before-schemaform orderings rather than a stub's call record. In that mode we seed the Bootstrap probe shim so the theme effect's `.d-none` probe resolves
  // promptly rather than timing out.
  if(unstubbed) {

    const sheet = new CSSStyleSheet();

    sheet.replaceSync(".d-none { display: none; }");
    document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, sheet ];
  } else {

    ui.featureOptions.show = async () => { featureOptionsCalls.push("show"); };
    ui.featureOptions.hide = async () => { featureOptionsCalls.push("hide"); };
  }

  return {

    fake,
    featureOptionsCalls,
    skeleton,
    ui,

    [Symbol.dispose]() {

      homebridgeGuard[Symbol.dispose]();
      dom[Symbol.dispose]();
    }
  };
}

describe("webUi.constructor", () => {

  test("constructs an inner webUiFeatureOptions instance and exposes it as a public field", () => {

    using _dom = createTestDom();
    createSkeletonFeatureOptionsDom();

    const ui = new webUi({ name: "Plugin" });

    assert.ok(ui.featureOptions, "featureOptions must be a constructed instance");
    assert.equal(typeof ui.featureOptions.show, "function", "featureOptions.show must be present on the inner instance");
  });

  test("accepts the empty-options invocation - all defaults apply", () => {

    using _dom = createTestDom();
    createSkeletonFeatureOptionsDom();

    // The constructor must tolerate `new webUi()` without any options at all - the JSDoc declares every field optional, and Homebridge plugin authors using the
    // simplest possible call form must not crash on construction.
    const ui = new webUi();

    assert.ok(ui.featureOptions, "default-options construction must still build the inner instance");
  });

  test("forwards featureOptions options through to the inner webUiFeatureOptions constructor", () => {

    using _dom = createTestDom();
    createSkeletonFeatureOptionsDom();

    // The contract: any options bag passed under `featureOptions` is forwarded verbatim as the inner constructor's argument. We verify by constructing with a
    // sidebar override and confirming construction succeeds when a featureOptions bag is supplied.
    const ui = new webUi({ featureOptions: { sidebar: { hideUuid: true } } });

    // featureOptions is the inner instance; it must be defined and constructed (sidebar merging is tested in the inner suite, here we only verify forwarding).
    assert.ok(ui.featureOptions, "featureOptions must be constructed when the options bag is provided");
  });
});

describe("webUi.show - feature-options routing", () => {

  test("with non-empty config and no first-run requirement, shows the menu and delegates to featureOptions.show()", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    await harness.ui.show();

    // The orchestrator must reveal the menu wrapper (default display: none in the skeleton) and call into the inner feature-options view exactly once.
    assert.equal(harness.skeleton.menuWrapper.style.display, "inline-flex", "menu wrapper must be revealed when feature-options view is selected");
    assert.deepEqual(harness.featureOptionsCalls, ["show"], "featureOptions.show must be invoked exactly once on the feature-options route");
  });

  test("hides the spinner whether show() succeeds or fails", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    await harness.ui.show();

    // The finally clause in show() must drain the spinner so the page is interactive on every termination - success and failure alike. The fake's spinnerCount is
    // a net counter (showSpinner + 1, hideSpinner - 1, clamped at zero), so a balanced call sequence settles to zero.
    assert.equal(harness.fake.observed.state.spinnerCount, 0, "spinner stack depth must settle to zero after show() resolves");
  });

  test("on inner-instance failure, surfaces the error via toast.error and still hides the spinner", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    // Make the inner show() reject so the orchestrator's catch path runs. The error message is the channel the orchestrator surfaces; the toast must carry exactly
    // that text under the "Error" title so users see actionable diagnostics rather than a silent broken UI.
    harness.ui.featureOptions.show = async () => { throw new Error("boom from inner"); };

    await harness.ui.show();

    assert.equal(harness.fake.observed.toasts.length, 1, "exactly one toast must surface on inner failure");
    assert.deepEqual(harness.fake.observed.toasts[0], { message: "boom from inner", title: "Error", variant: "error" },
      "the toast must carry the error message and the \"Error\" title on the error channel");
    assert.equal(harness.fake.observed.state.spinnerCount, 0, "spinner must still drain in the finally clause on the error path");
  });
});

describe("webUi.show - first-run routing", () => {

  test("with empty config and a required first-run, shows the first-run page without eagerly persisting a seed", async () => {

    const onStart = () => true;
    const onSubmit = () => true;
    const isRequired = () => true;

    using harness = makeWebUiHarness({ firstRun: { isRequired, onStart, onSubmit }, name: "MyPlugin" });

    await harness.ui.show();

    // Empty config + a required first-run: the session seeds the platform name in memory so a later submit persists a well-formed block, but the orchestrator
    // does not eagerly persist that seed - nothing reaches the host until the user actually submits credentials. The first-run page is shown and the save button
    // is disabled until the flow completes.
    assert.equal(harness.fake.observed.updatedConfigs.length, 0, "the held seed must not be eagerly persisted before the user submits");
    assert.equal(harness.skeleton.pageFirstRun.style.display, "block", "the first-run page must be visible after the orchestrator routes to first-run");
    assert.equal(harness.fake.observed.state.saveButtonEnabled, false, "the save button must be disabled until the user completes the first-run flow");
  });

  test("when isRequired returns true, routes to first-run even with non-empty config", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => true, onStart: () => true, onSubmit: () => true },
      name: "TestPlatform"
    });

    await harness.ui.show();

    // The feature-options route is taken whenever isRequired returns false, regardless of config emptiness - a plugin's own isRequired implementation may choose
    // to inspect config, but the orchestrator itself imposes no such gate. With isRequired returning true here, the orchestrator must still flow to first-run;
    // the inner feature-options.show() must NOT be invoked from this route.
    assert.equal(harness.skeleton.pageFirstRun.style.display, "block", "first-run page must be shown when isRequired returns true");
    assert.deepEqual(harness.featureOptionsCalls, [], "featureOptions.show must NOT be invoked on the first-run route");
  });

  test("when onStart returns false, the first-run flow aborts before showing the page", async () => {

    const onStart = () => false;

    // isRequired must force the first-run route so onStart is actually consulted - with the default gate (false) an empty config routes straight to feature-options
    // and onStart would never run.
    using harness = makeWebUiHarness({ firstRun: { isRequired: () => true, onStart } });

    await harness.ui.show();

    // The contract: onStart's falsy return short-circuits the first-run setup. The page must not become visible, the save button must not be touched (state stays
    // at the bridge default of enabled), and no first-run click listener should be wired - asserting on the page display is the cheapest proxy for the latter.
    assert.equal(harness.skeleton.pageFirstRun.style.display, "none", "first-run page must remain hidden when onStart returns false");
  });

  test("on first-run submit: when onSubmit returns true, swaps to the menu and calls featureOptions.show()", async () => {

    const onSubmit = () => true;

    using harness = makeWebUiHarness({

      firstRun: { isRequired: () => true, onStart: () => true, onSubmit },
      name: "MyPlugin"
    });

    await harness.ui.show();

    // Drive the click-then-await cycle by invoking the firstRun button's click handler. The handler is registered via addEventListener as an async function and the
    // dispatcher does not await it, so the click body runs as an unsupervised promise chain. The handler awaits #processHandler, synchronously swaps the page
    // display, then awaits featureOptions.show; a single setImmediate flushes past every microtask the chain enqueues, which is the deterministic alternative to
    // counting awaits by hand.
    harness.skeleton.firstRun.click();
    await flushPending();

    assert.equal(harness.skeleton.pageFirstRun.style.display, "none", "first-run page must be hidden after a successful submit");
    assert.equal(harness.skeleton.menuWrapper.style.display, "inline-flex", "menu wrapper must be revealed after a successful first-run submit");
    assert.deepEqual(harness.featureOptionsCalls, ["show"], "featureOptions.show must run after a successful first-run submit");
    assert.equal(harness.fake.observed.state.saveButtonEnabled, true, "save button must be re-enabled after the first-run flow completes");
  });

  test("on first-run submit: when onSubmit returns false, does NOT swap pages and does NOT enable save", async () => {

    const onSubmit = () => false;

    using harness = makeWebUiHarness({

      firstRun: { isRequired: () => true, onStart: () => true, onSubmit },
      name: "MyPlugin"
    });

    await harness.ui.show();

    harness.skeleton.firstRun.click();
    await flushPending();

    // Negative-path verification: a falsy onSubmit return must NOT advance the user past first-run. The save button must remain disabled (set false during
    // setup), and the inner feature-options view must not have been invoked from the click handler.
    assert.equal(harness.fake.observed.state.saveButtonEnabled, false, "save button must remain disabled when onSubmit rejects the submission");
    assert.deepEqual(harness.featureOptionsCalls, [], "featureOptions.show must NOT be invoked when onSubmit returns false");
  });

  test("on first-run submit: when onSubmit rejects with an Error, surfaces one error toast and stays on the first-run page", async () => {

    const onSubmit = async () => { throw new Error("Login failed."); };

    using harness = makeWebUiHarness({

      firstRun: { isRequired: () => true, onStart: () => true, onSubmit },
      name: "MyPlugin"
    });

    await harness.ui.show();

    harness.skeleton.firstRun.click();
    await flushPending();

    // The click handler's catch normalizes the rejection into exactly one error toast; without the catch the rejection escapes as an unhandled rejection and no toast
    // is recorded. The submit threw before the page swap, so the menu stays hidden, the feature-options handoff never runs, and the save button stays disabled.
    assert.deepEqual(harness.fake.observed.toasts, [{ message: "Login failed.", title: "Error", variant: "error" }],
      "a rejected onSubmit must surface exactly one error toast carrying the error message under the \"Error\" title");
    assert.equal(harness.skeleton.menuWrapper.style.display, "none", "the menu must stay hidden when onSubmit rejects before the page swap");
    assert.deepEqual(harness.featureOptionsCalls, [], "featureOptions.show must NOT run when onSubmit rejects");
    assert.equal(harness.fake.observed.state.saveButtonEnabled, false, "the save button must stay disabled when onSubmit rejects");
    assert.equal(harness.fake.observed.state.spinnerCount, 0, "the spinner must drain in the finally clause after a rejected onSubmit");
  });

  test("on first-run submit: when onSubmit rejects with a non-Error value, the toast carries the String coercion", async () => {

    const onSubmit = async () => { throw "plain string failure"; };

    using harness = makeWebUiHarness({

      firstRun: { isRequired: () => true, onStart: () => true, onSubmit },
      name: "MyPlugin"
    });

    await harness.ui.show();

    harness.skeleton.firstRun.click();
    await flushPending();

    // A non-Error rejection carries no `message` field, so the shared toastError normalization falls back to a string coercion of the whole value.
    assert.deepEqual(harness.fake.observed.toasts, [{ message: "plain string failure", title: "Error", variant: "error" }],
      "a non-Error rejection must surface its String coercion as the toast message");
  });

  test("on first-run submit: when the feature-options handoff rejects after a successful submit, toasts and lands on the main shell", async () => {

    const onSubmit = () => true;

    using harness = makeWebUiHarness({

      firstRun: { isRequired: () => true, onStart: () => true, onSubmit },
      name: "MyPlugin"
    });

    await harness.ui.show();

    // The submit succeeds and swaps the page, then the feature-options handoff rejects. The catch surfaces the toast; because the throw lands after the swap but
    // before enableSaveButton(), the user sees the main shell with the menu available for recovery while the save button stays disabled.
    harness.ui.featureOptions.show = async () => { throw new Error("Feature options failed to load."); };

    harness.skeleton.firstRun.click();
    await flushPending();

    assert.deepEqual(harness.fake.observed.toasts, [{ message: "Feature options failed to load.", title: "Error", variant: "error" }],
      "a rejected feature-options handoff must surface exactly one error toast");
    assert.equal(harness.skeleton.pageFirstRun.style.display, "none", "the first-run page must be hidden after the successful submit swapped it away");
    assert.equal(harness.skeleton.menuWrapper.style.display, "inline-flex", "the menu must be revealed so the user can recover from the failed handoff");
    assert.equal(harness.fake.observed.state.saveButtonEnabled, false, "the save button must stay disabled when the handoff rejects before enableSaveButton runs");
    assert.equal(harness.fake.observed.state.spinnerCount, 0, "the spinner must drain in the finally clause after a failed handoff");
  });
});

describe("webUi.show - menu wiring", () => {

  test("clicking menuFeatureOptions invokes featureOptions.show()", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    await harness.ui.show();

    // Reset the call log to focus on the click-driven invocation alone (the initial show() route already pushed one entry).
    harness.featureOptionsCalls.length = 0;
    harness.skeleton.menuFeatureOptions.click();

    assert.deepEqual(harness.featureOptionsCalls, ["show"], "menuFeatureOptions click must invoke featureOptions.show()");
  });

  test("clicking menuFeatureOptions when featureOptions.show rejects surfaces an error toast", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    await harness.ui.show();

    // The re-entry path routes through #showFeatureOptions, whose try/catch surfaces a failed re-show as a toast rather than dropping the rejection. Swap in a
    // rejecting show and clear the toast log so the assertion isolates the click-driven toast.
    harness.ui.featureOptions.show = async () => { throw new Error("re-entry failed"); };
    harness.fake.observed.toasts.length = 0;

    harness.skeleton.menuFeatureOptions.click();
    await flushPending();

    assert.deepEqual(harness.fake.observed.toasts, [{ message: "re-entry failed", title: "Error", variant: "error" }],
      "a rejected feature-options re-entry must surface exactly one error toast");
  });

  test("clicking menuSettings reveals the schema form and hides the feature-options view", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    await harness.ui.show();

    harness.featureOptionsCalls.length = 0;
    harness.skeleton.menuSettings.click();

    // #showSettings is now async (it awaits featureOptions.hide() before revealing the schema form), so the class swap and showSchemaForm land in the handler's
    // try/finally after the awaited hide(). Flush past the handler's microtasks before asserting the post-reveal state.
    await flushPending();

    // The settings tab is the schema-form view: the orchestrator hides the inner feature-options instance, calls homebridge.showSchemaForm, and swaps Bootstrap
    // classes so menuSettings carries `btn-elegant` (active) while the two sibling buttons carry `btn-primary` (inactive). Active = elegant is the project's local
    // convention - the inverse of vanilla Bootstrap's `btn-primary`-as-active idiom - so the test pins both halves of the swap to catch a future revert.
    assert.deepEqual(harness.featureOptionsCalls, ["hide"], "menuSettings click must hide the inner feature-options view");
    assert.equal(harness.fake.observed.state.schemaFormVisible, true, "menuSettings click must surface the schema form");
    assert.equal(harness.skeleton.menuSettings.classList.contains("btn-elegant"), true, "active settings tab must carry btn-elegant");
    assert.equal(harness.skeleton.menuFeatureOptions.classList.contains("btn-primary"), true, "inactive feature-options tab must carry btn-primary");
    assert.equal(harness.skeleton.menuHome.classList.contains("btn-primary"), true, "inactive home tab must carry btn-primary");
  });

  test("clicking menuHome reveals the support page and hides the schema form", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    await harness.ui.show();

    harness.featureOptionsCalls.length = 0;
    harness.skeleton.menuHome.click();

    // #showSupport is now async (it awaits featureOptions.hide() before revealing the support page), so flush past the handler's microtasks before asserting.
    await flushPending();

    assert.deepEqual(harness.featureOptionsCalls, ["hide"], "menuHome click must hide the inner feature-options view");
    assert.equal(harness.fake.observed.state.schemaFormVisible, false, "menuHome click must hide the schema form");
    assert.equal(harness.skeleton.pageSupport.style.display, "block", "menuHome click must reveal the support page");
    assert.equal(harness.skeleton.menuHome.classList.contains("btn-elegant"), true, "active home tab must carry btn-elegant");
    assert.equal(harness.skeleton.menuFeatureOptions.classList.contains("btn-primary"), true, "inactive feature-options tab must carry btn-primary");
    assert.equal(harness.skeleton.menuSettings.classList.contains("btn-primary"), true, "inactive settings tab must carry btn-primary");
  });
});

describe("webUi - tab-switch reconciliation ordering (real feature-options pipeline)", () => {

  // These tests drive the REAL inner feature-options pipeline (the harness `unstubbed` mode) so an actual sync()/persist drain runs. They pin the orderings
  // the reconciliation depends on, observed through the host call log: the page re-reads the config before rendering (sync-before-show), and a pending edit is
  // flushed to the host before the Settings schema form renders (flush-before-schemaform). A stub's call record cannot express these orderings, so the real
  // pipeline is required here.

  // The /getOptions catalog the real show() pulls. One toggleable Motion option is enough to stage a pending edit.
  const FEATURES = {

    categories: [{ description: "Motion Options", name: "Motion" }],
    options: { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] }
  };

  // Settle real time past the persist debounce (300ms) and let the drain + reducer dispatches resolve. Used after a toggle that should produce a persist, and after a
  // tab switch whose awaited flush should have drained.
  async function settle() {

    await new Promise((resolve) => setTimeout(resolve, 400));
    await flushPending();
  }

  test("clicking menuSettings flushes a pending option edit to the host BEFORE rendering the schema form", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }],
      firstRun: { isRequired: () => false },
      requestResponses: new Map([[ "/getOptions", FEATURES ]]),
      unstubbed: true
    });

    await harness.ui.show();
    await settle();

    // Stage a pending edit through the rendered DOM: expand the Motion category, toggle Detect off. This dispatches option:set, which the persist effect debounces.
    harness.skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();
    await flushPending();

    const checkbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    assert.ok(checkbox, "the Motion.Detect row checkbox must be rendered");

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    // Clear the call log captured up to here (the initial open()/show() reads) so the assertion focuses on the tab-switch ordering alone.
    harness.fake.observed.calls.length = 0;

    // Switch to Settings WITHIN the debounce window (no settle between the toggle and the click). The real #showSettings awaits the real hide(), which flushes the
    // pending edit before revealing the schema form.
    harness.skeleton.menuSettings.click();
    await settle();

    const writeIndex = harness.fake.observed.calls.indexOf("updatePluginConfig");
    const schemaIndex = harness.fake.observed.calls.indexOf("showSchemaForm");

    assert.ok(writeIndex >= 0, "the pending edit must have been flushed (updatePluginConfig) during the tab switch");
    assert.ok(schemaIndex >= 0, "the schema form must have been rendered");
    assert.ok(writeIndex < schemaIndex, "the flush (updatePluginConfig) must land BEFORE the schema form renders (showSchemaForm)");

    // And the flushed write carried the toggle.
    const lastWrite = harness.fake.observed.updatedConfigs.at(-1);

    assert.ok(lastWrite[0].options.includes("Disable.Motion.Detect"), "the flushed write must carry the toggled-off Motion.Detect option");
  });

  test("re-entering the feature-options tab re-reads the host config before rendering (getPluginConfig precedes the render)", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }],
      firstRun: { isRequired: () => false },
      requestResponses: new Map([[ "/getOptions", FEATURES ]]),
      unstubbed: true
    });

    await harness.ui.show();
    await settle();

    // Simulate a Settings-tab edit landing in the host's in-memory config while we are away from the feature-options tab: reassign to a NEW array. Then clear the call
    // log and re-enter the feature-options tab via the menu.
    harness.fake.config = [{ name: "TestPlatform", options: ["Enable.Audio.Volume.50"], platform: "TestPlatform" }];
    harness.fake.observed.calls.length = 0;

    harness.skeleton.menuFeatureOptions.click();
    await settle();

    // The re-entry re-read the host config (getPluginConfig) as its first host interaction, before any render-side work - the sync-before-show ordering.
    assert.equal(harness.fake.observed.calls[0], "getPluginConfig", "re-entering the feature-options tab must re-read the host config first");
  });
});

describe("webUi - first-run handler normalization", () => {

  test("a first-run handler supplied as a literal truthy value behaves as if it were a () => true function", async () => {

    // The #processHandler contract: function-or-value. Test the value branch by passing literal `true` for isRequired - the orchestrator must coerce it to a
    // boolean continuation flag. Combined with non-empty config, isRequired=true must route to first-run.
    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: true, onStart: true, onSubmit: () => true },
      name: "TestPlatform"
    });

    await harness.ui.show();

    assert.equal(harness.skeleton.pageFirstRun.style.display, "block", "isRequired=true must route to first-run regardless of config presence");
  });

  test("a first-run handler supplied as a literal falsy value behaves as if it were a () => false function", async () => {

    // The reverse of the above: isRequired=false (literal) means feature-options route is taken. Asserts the function-vs-value normalization both directions.
    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: false }
    });

    await harness.ui.show();

    assert.deepEqual(harness.featureOptionsCalls, ["show"], "isRequired=false must route directly to feature-options");
  });

  test("partial firstRun overrides leave the unspecified handlers at their defaults", async () => {

    // The constructor merges caller-supplied firstRun keys over the no-op defaults via a single spread. A caller providing only onSubmit must still get the
    // default isRequired (returns false) and default onStart (returns true) - this test pins that contract by supplying only onSubmit and observing the
    // feature-options route gets taken (i.e., default isRequired returned false).
    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { onSubmit: () => true }
    });

    await harness.ui.show();

    assert.deepEqual(harness.featureOptionsCalls, ["show"], "default isRequired must return false and route to feature-options when caller omits the handler");
  });

  test("with only isRequired supplied, the default onStart / onSubmit drive a complete first-run cycle", async () => {

    // Exercise of the two no-op default handlers in one cycle. The plugin supplies only `isRequired: () => true` to opt into the first-run route; onStart and onSubmit
    // stay at their `() => true` defaults. onStart's default lets the first-run page render; onSubmit's default lets the click handler swap to the menu and enable
    // save. This pins that a plugin author who provides only the gate - the minimal first-run opt-in - drives a working end-to-end flow through the unmodified defaults.
    using harness = makeWebUiHarness({ firstRun: { isRequired: () => true }, name: "MyPlugin" });

    await harness.ui.show();

    assert.equal(harness.skeleton.pageFirstRun.style.display, "block", "default onStart must let the first-run page render");
    assert.equal(harness.fake.observed.state.saveButtonEnabled, false, "save button must be disabled while first-run is in progress");

    harness.skeleton.firstRun.click();
    await flushPending();

    // Default onSubmit returns true, so the click handler must complete the full cycle: swap to the menu, call featureOptions.show(), enable the save button.
    assert.equal(harness.skeleton.menuWrapper.style.display, "inline-flex", "default onSubmit must allow the menu to be revealed");
    assert.deepEqual(harness.featureOptionsCalls, ["show"], "default onSubmit must let featureOptions.show() run");
    assert.equal(harness.fake.observed.state.saveButtonEnabled, true, "default onSubmit must let the save button be re-enabled");
  });

  test("with no firstRun options and an empty config, the default gate routes straight to feature-options", async () => {

    // A plugin that supplies no firstRun flow keeps the default `isRequired = () => false` gate. On a brand-new (empty) install there is nothing to set up, so the
    // orchestrator routes straight to the feature-options view rather than a vestigial first-run page - the right destination for a device-discovery plugin. The held
    // seed is not eagerly persisted; the first real save writes a well-formed block.
    using harness = makeWebUiHarness({ name: "MyPlugin" });

    await harness.ui.show();

    assert.deepEqual(harness.featureOptionsCalls, ["show"], "the default gate must route an empty-config plugin to feature-options");
    assert.equal(harness.skeleton.menuWrapper.style.display, "inline-flex", "the menu wrapper must be revealed on the feature-options route");
    assert.equal(harness.skeleton.pageFirstRun.style.display, "none", "no first-run page on the default route");
    assert.equal(harness.fake.observed.updatedConfigs.length, 0, "no eager seed write on the feature-options route");
  });
});

describe("webUi.show - boot monitor handshake", () => {

  // A minimal boot-monitor stub whose ready() is a call counter. The real monitor is the classic inline script the stamped index.html defines as window.webUiBoot; the
  // handshake only reaches it through globalThis.webUiBoot?.ready?.(), so a two-method stub is enough to observe the stand-down.
  function bootStub() {

    const calls = { ready: 0 };
    const stub = { fail: () => {}, ready: () => { calls.ready += 1; } };

    return { calls, stub };
  }

  test("show() stands the boot monitor down via ready() once the UI has rendered", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    const { calls, stub } = bootStub();

    using _boot = installWebUiBoot(stub);

    await harness.ui.show();

    // The success path renders the UI, and the finally hands off to ready() so the monitor retracts any panel it raised during boot.
    assert.deepEqual(harness.featureOptionsCalls, ["show"], "the success path renders the feature-options view");
    assert.equal(calls.ready, 1, "the finally stands the boot monitor down exactly once on success");
  });

  test("show() stands the boot monitor down via ready() even when the launch fails and toasts", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    // Make the launch reject so the outer catch toasts; the finally must still hand off to ready(), since the app owns the surface through the toast it displayed.
    harness.ui.featureOptions.show = async () => { throw new Error("boom from inner"); };

    const { calls, stub } = bootStub();

    using _boot = installWebUiBoot(stub);

    await harness.ui.show();

    assert.equal(harness.fake.observed.toasts.length, 1, "the launch failure still surfaces a toast");
    assert.equal(calls.ready, 1, "the finally stands the boot monitor down exactly once on the failure path");
  });

  test("show() tolerates the absence of the boot monitor global without throwing", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    // No installWebUiBoot here, so globalThis.webUiBoot is undefined. The optional chain in show()'s finally must make the handshake a silent no-op - the shape a
    // stamped region that carries no boot monitor produces.
    await assert.doesNotReject(async () => harness.ui.show(), "a region without a boot monitor must not break show()");
  });
});
