/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi.test.mjs: Unit tests for the webUi orchestrator - constructor wiring, show() lifecycle across the feature-options and first-run routing branches, the
 * first-run click flow, chrome listeners over whichever buttons the page carries, the #processHandler function-vs-truthy normalization, the boot-monitor handshake,
 * the deadline-bounded launch race, the entry-point boundary that reports a failure and settles chrome, the liveness surface and its resume detector threaded end
 * to end through a mounted status panel, and the page-lifetime theming registration. The orchestrator's inner webUiFeatureOptions instance is constructed against
 * the real implementation so the constructor's DOM-binding contract is exercised end-to-end. By default the harness stubs the inner instance's `show()` and `hide()`
 * methods so the orchestrator's call ordering is verified without re-exercising the entire feature-options rendering pipeline (which has its own dedicated suite in
 * `webUi-featureOptions.test.mjs`); the tab-switch reconciliation ordering, the real menu-path re-entry walk, the deadline-bounded launch race, and the end-to-end
 * resume-detector suites instead opt into the harness's `unstubbed: true` mode to drive the real pipeline, since a stub's call record cannot express the orderings
 * those suites verify.
 */
"use strict";

import { BOOTSTRAP_PROBE_ACCENT, createFakeHomebridge, createSkeletonFeatureOptionsDom, createTestDom, installHomebridge, installWebUiBoot, seedBootstrapProbeShim,
  waitFor } from "./ui.helpers.mjs";
import { describe, test } from "node:test";
import { STATUS_VIEW_ROUTE } from "./webui-status.js";
import assert from "node:assert/strict";
import { setImmediate as flushPending } from "node:timers/promises";
import { webUi } from "./webUi.mjs";

// Build a webUi instance against the skeleton DOM with featureOptions.show / featureOptions.hide stubbed to record calls. The harness bundles the two real
// disposables every test needs (the DOM globals and the homebridge install) alongside two plain data properties (the orchestrator instance and the inner
// stubs' call records) returned for assertions, all wrapped in a single object that tests bind with `using` so cleanup runs even on failure.
function makeWebUiHarness({ name = "TestPlatform", config = [], firstRun, lightingMode, requestResponses, featureOptions, accessories = [], unstubbed = false } = {}) {

  const dom = createTestDom();
  const skeleton = createSkeletonFeatureOptionsDom();
  const fake = createFakeHomebridge({ cachedAccessories: accessories, config, lightingMode, requestResponses });
  const homebridgeGuard = installHomebridge(fake);
  const ui = new webUi({ featureOptions, firstRun, name });

  const featureOptionsCalls = [];

  // Default: replace the inner orchestrator's show/hide with tracking stubs so we can assert call ordering without driving the full feature-options pipeline. The
  // original methods stay on the prototype - we only replace the per-instance bindings, so leaks across tests cannot occur. The `unstubbed` opt-out drives the REAL
  // feature-options pipeline (so a real sync()/persist drain runs): used by the reconciliation-ordering tests that must observe the actual sync-before-show and
  // flush-before-schemaform orderings rather than a stub's call record. In that mode we seed the Bootstrap probe shim so the theme effect's `.d-none` probe resolves
  // promptly rather than timing out.
  if(unstubbed) {

    seedBootstrapProbeShim();
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

    using dom = createTestDom();
    createSkeletonFeatureOptionsDom();

    const ui = new webUi({ name: "Plugin" });

    assert.ok(ui.featureOptions, "featureOptions must be a constructed instance");
    assert.equal(typeof ui.featureOptions.show, "function", "featureOptions.show must be present on the inner instance");
  });

  test("accepts the empty-options invocation - all defaults apply", () => {

    using dom = createTestDom();
    createSkeletonFeatureOptionsDom();

    // The constructor must tolerate `new webUi()` without any options at all - the JSDoc declares every field optional, and Homebridge plugin authors using the
    // simplest possible call form must not crash on construction.
    const ui = new webUi();

    assert.ok(ui.featureOptions, "default-options construction must still build the inner instance");
  });

  test("forwards featureOptions options through to the inner webUiFeatureOptions constructor", () => {

    using dom = createTestDom();
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

    // #showSettings awaits featureOptions.hide() before revealing the schema form, so the class swap and showSchemaForm land in the handler's try/finally
    // after the awaited hide(). Flush past the handler's microtasks before asserting the post-reveal state.
    await flushPending();

    // The settings tab is the schema-form view: the orchestrator hides the inner feature-options instance, calls homebridge.showSchemaForm, and paints the menu with
    // menuSettings active. Both halves are checked - the active mark on one tab and its absence on the siblings - because a paint that marked every tab, or none,
    // would leave the user without the "you are here" reading the accent fill exists to give.
    assert.deepEqual(harness.featureOptionsCalls, ["hide"], "menuSettings click must hide the inner feature-options view");
    assert.equal(harness.fake.observed.state.schemaFormVisible, true, "menuSettings click must surface the schema form");
    assert.equal(harness.skeleton.menuSettings.classList.contains("fo-menu-active"), true, "the active settings tab must carry the accent-fill class");
    assert.equal(harness.skeleton.menuFeatureOptions.classList.contains("fo-menu-active"), false, "the inactive feature-options tab must not");
    assert.equal(harness.skeleton.menuHome.classList.contains("fo-menu-active"), false, "and neither must the inactive home tab");
  });

  test("clicking menuHome reveals the support page and hides the schema form", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    await harness.ui.show();

    harness.featureOptionsCalls.length = 0;
    harness.skeleton.menuHome.click();

    // #showSupport awaits featureOptions.hide() before revealing the support page, so flush past the handler's microtasks before asserting.
    await flushPending();

    assert.deepEqual(harness.featureOptionsCalls, ["hide"], "menuHome click must hide the inner feature-options view");
    assert.equal(harness.fake.observed.state.schemaFormVisible, false, "menuHome click must hide the schema form");
    assert.equal(harness.skeleton.pageSupport.style.display, "block", "menuHome click must reveal the support page");
    assert.equal(harness.skeleton.menuHome.classList.contains("fo-menu-active"), true, "the active home tab must carry the accent-fill class");
    assert.equal(harness.skeleton.menuFeatureOptions.classList.contains("fo-menu-active"), false, "the inactive feature-options tab must not");
    assert.equal(harness.skeleton.menuSettings.classList.contains("fo-menu-active"), false, "and neither must the inactive settings tab");
  });

  test("a page whose markup omits a menu button launches, switches its remaining views, and paints around the gap", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    /* The menu shape a fully-consolidated plugin ships: the schema-form button is simply not in the markup. Removing the ELEMENT (rather than the handle's key)
     * after the skeleton is built and before show() runs is what puts the launch in front of it, since the binds happen inside the launch rather than in the
     * constructor.
     *
     * The featureOptionsCalls and toasts assertions below are the ones that tell a page that tolerates the gap from a page that merely survives it. An
     * unconditional bind throws on the absent button BEFORE the launch routes to the initial view, and show()'s catch turns that throw into a toast rather than
     * a rethrow - so a launch that leaves the feature-options view unshown and an error toast behind is the failure this test guards against, and clicking
     * afterwards would not reveal it (the menu-button handler re-runs the launch on its own when no session was established).
     */
    harness.skeleton.menuSettings.remove();

    await harness.ui.show();

    assert.deepEqual(harness.featureOptionsCalls, ["show"], "the launch must route to the feature-options view even though a menu button is absent");
    assert.deepEqual(harness.fake.observed.toasts, [], "a launch against a page missing a menu button must surface no failure toast");

    harness.skeleton.menuHome.click();
    await flushPending();

    // The buttons the markup does carry still switch views, and the paint each switch performs steps over the absent button instead of dereferencing it.
    assert.equal(harness.skeleton.pageSupport.style.display, "block", "the support view must still open from the button the markup carries");
    assert.equal(harness.skeleton.menuHome.classList.contains("fo-menu-active"), true, "the active home tab must still be painted");

    harness.skeleton.menuFeatureOptions.click();
    await flushPending();

    assert.deepEqual(harness.featureOptionsCalls, [ "show", "hide", "show" ], "the feature-options button must still re-enter its view");
  });
});

describe("webUi.show - the feature-options view paints the menu whenever it shows", () => {

  test("a real feature-options show() leaves its own tab active and the sibling tabs inactive", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }],
      firstRun: { isRequired: () => false },
      requestResponses: new Map([[ "/getOptions", {

        categories: [{ description: "Motion Options", name: "Motion" }],
        options: { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] }
      } ]]),
      unstubbed: true
    });

    // The real pipeline, not the stub: the menu paint belongs to the feature-options view rather than to the orchestrator's tab-switch handlers, so it is only
    // observable when that view actually shows. The inactive halves are checked alongside the active one because "exactly one tab is marked" is the whole reading.
    await harness.ui.show();

    assert.equal(harness.skeleton.menuFeatureOptions.classList.contains("fo-menu-active"), true, "the feature-options tab is the active one while its view shows");
    assert.equal(harness.skeleton.menuHome.classList.contains("fo-menu-active"), false, "the home tab is inactive while the feature-options view shows");
    assert.equal(harness.skeleton.menuSettings.classList.contains("fo-menu-active"), false, "the settings tab is inactive while the feature-options view shows");
    assert.equal(harness.skeleton.menuFeatureOptions.classList.contains("btn-primary"), false, "and the markup's Bootstrap variant is normalized away by the paint");
  });
});

describe("webUi.show - menu listener idempotence across repeated launches", () => {

  test("repeated show() cycles fire the menu handler exactly once per click", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { isRequired: () => false }
    });

    // Two full launch cycles against the same page. #launchWebUI binds the persistent chrome listeners once for the page lifetime; the one-shot #chromeBound guard
    // exists because a repeated launch must not stack a second handler on each button, which would fire every tab switch twice.
    await harness.ui.show();
    await harness.ui.show();

    // Isolate the click-driven invocation from the two routing shows above.
    harness.featureOptionsCalls.length = 0;

    harness.skeleton.menuFeatureOptions.click();
    await flushPending();

    assert.deepEqual(harness.featureOptionsCalls, ["show"],
      "a menu click must fire its handler exactly once even after repeated show() cycles");
  });
});

describe("webUi - tab-switch reconciliation ordering (real feature-options pipeline)", () => {

  // These tests drive the REAL inner feature-options pipeline (the harness `unstubbed` mode) so an actual sync()/persist drain runs. They lock in the orderings
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
    // default isRequired (returns false) and default onStart (returns true) - this test asserts that contract by supplying only onSubmit and observing the
    // feature-options route gets taken (i.e., default isRequired returned false).
    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", platform: "TestPlatform" }],
      firstRun: { onSubmit: () => true }
    });

    await harness.ui.show();

    assert.deepEqual(harness.featureOptionsCalls, ["show"], "default isRequired must return false and route to feature-options when caller omits the handler");
  });

  test("with only isRequired supplied, the default onStart / onSubmit drive a complete first-run cycle", async () => {

    // Exercise of the onStart / onSubmit no-op defaults in one cycle. The plugin supplies only `isRequired: () => true` to opt into the first-run route; onStart
    // and onSubmit stay at their `() => true` defaults. onStart's default lets the first-run page render; onSubmit's default lets the click handler swap to the
    // menu and enable save. This confirms that a plugin author who provides only the gate - the minimal first-run opt-in - drives a working end-to-end flow through
    // the unmodified defaults.
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

    using boot = installWebUiBoot(stub);

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

    using boot = installWebUiBoot(stub);

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

describe("webUi - real menu-path re-entry (the full pipeline through webUi's own listeners)", () => {

  // The catalog the real show() pulls. Two categories so a full render is unmistakable from a partial one.
  const RE_ENTRY_FEATURES = {

    categories: [ { description: "Motion Options", name: "Motion" }, { description: "Audio Options", name: "Audio" } ],
    options: {

      Audio: [{ default: false, description: "Audio volume.", name: "Volume" }],
      Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }]
    }
  };

  // True once the options page has rendered whole - one category disclosure per configured category.
  const isFullyRendered = (skeleton) => skeleton.configTable.querySelectorAll("details[data-category]").length === RE_ENTRY_FEATURES.categories.length;

  // Wait for the page to come up, so each leg of the walk asserts on a settled render rather than a fixed number of drained cycles.
  const waitForRender = async (skeleton, leg) => {

    for(let i = 0; i < 400; i++) {

      if(isFullyRendered(skeleton)) {

        return;
      }

      // eslint-disable-next-line no-await-in-loop
      await flushPending();
    }

    assert.fail("the page did not render on " + leg);
  };

  // Walk the real menu the way a user does, through webUi's own click listeners, asserting a full re-render on every return to Feature Options. The gap this
  // closes is that a stubbed inner instance can only prove the handler fired - it cannot prove the page came back.
  const walkTheMenu = async ({ featureOptions }) => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }],
      featureOptions,
      firstRun: { isRequired: () => false },
      requestResponses: new Map([[ "/getOptions", RE_ENTRY_FEATURES ]]),
      unstubbed: true
    });

    seedBootstrapProbeShim();

    await harness.ui.show();
    await waitForRender(harness.skeleton, "the initial launch");

    // Feature Options -> Support -> Feature Options.
    harness.skeleton.menuHome.click();
    await flushPending();

    harness.skeleton.menuFeatureOptions.click();
    await waitForRender(harness.skeleton, "the return from Support");

    // Feature Options -> Settings -> Feature Options.
    harness.skeleton.menuSettings.click();
    await flushPending();

    harness.skeleton.menuFeatureOptions.click();
    await waitForRender(harness.skeleton, "the return from Settings");

    assert.equal(harness.skeleton.pageFeatureOptions.style.display, "block", "the feature-options page is the visible one at the end of the walk");
  };

  test("device-only: every return to Feature Options renders the page whole", async () => {

    await walkTheMenu({ featureOptions: {} });
  });

  test("global-only: every return to Feature Options renders the page whole", async () => {

    await walkTheMenu({ featureOptions: { globalOnly: true } });
  });
});

describe("webUi - the launch-time session open is deadline-bounded", () => {

  // The bound the launch carries, mirrored so a test can advance the mock clock exactly past it.
  const LAUNCH_DEADLINE_MS = 30000;

  test("a stalled config read at launch toasts the failure, drops the spinner, and leaves a menu that re-runs the launch once the host heals", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }],
      firstRun: { isRequired: () => false },
      requestResponses: new Map([[ "/getOptions", {

        categories: [{ description: "Motion Options", name: "Motion" }],
        options: { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] }
      } ]]),
      unstubbed: true
    });

    seedBootstrapProbeShim();

    const healthyRead = harness.fake.getPluginConfig;

    // The page's very first bridge call never answers - the frozen-first-load shape of the symptom class.
    harness.fake.getPluginConfig = () => new Promise(() => {});

    const showPromise = harness.ui.show();

    await flushPending();
    t.mock.timers.tick(LAUNCH_DEADLINE_MS + 1);
    await showPromise;
    await flushPending();

    assert.deepEqual(harness.fake.observed.toasts.at(-1), {

      message: "The Homebridge server did not respond, so the plugin configuration could not be read. Reopen the settings panel to try again.",
      title: "Error",
      variant: "error"
    }, "the launch expiry toasts copy that names the recovery rather than the raw deadline message");

    assert.equal(harness.fake.observed.state.spinnerCount, 0, "the spinner comes down however the launch settled");
    assert.equal(harness.skeleton.menuWrapper.style.display, "inline-flex", "the menu is revealed, since it is the only affordance a failed launch leaves");

    // Heal the host and take the one affordance the page offers. The click must re-run the LAUNCH - there is no session for a plain re-show to use.
    harness.fake.getPluginConfig = healthyRead;

    harness.skeleton.menuFeatureOptions.click();

    for(let i = 0; i < 400; i++) {

      if(harness.skeleton.configTable.querySelector("details[data-category]")) {

        break;
      }

      // eslint-disable-next-line no-await-in-loop
      await flushPending();
    }

    assert.ok(harness.skeleton.configTable.querySelector("details[data-category='Motion']"),
      "the Feature Options click after the heal re-ran the launch through to a full render");
  });
});

describe("webUi - the entry-point boundary reports a failure and settles its chrome", () => {

  const CONFIG = [{ name: "TestPlatform", platform: "TestPlatform" }];

  /* Drain the async work a settled await releases. A fixed walk of macrotask yields rather than a wait on a predicate, because a row here can assert that something
   * did NOT happen: the state such a row wants is the state it already had, so there is nothing to wait for and only a quiet queue to establish.
   */
  const drain = async (turns = 25) => {

    for(let i = 0; i < turns; i++) {

      // eslint-disable-next-line no-await-in-loop
      await flushPending();
    }
  };

  test("repeated launches leave exactly one first-run submit handler on the shared button", async () => {

    let submits = 0;

    const onSubmit = () => {

      submits++;

      return false;
    };

    using harness = makeWebUiHarness({ config: CONFIG, firstRun: { isRequired: () => true, onStart: () => true, onSubmit } });

    // Two full launch cycles against the same page. The submit button is bound once for the page lifetime beside the menu buttons, so a repeated launch cannot
    // stack a second handler on it - which would run the plugin's submit hook twice per click, against one session.
    await harness.ui.show();
    await harness.ui.show();

    harness.skeleton.firstRun.click();
    await drain();

    assert.equal(submits, 1, "one click runs the submit hook exactly once however many launches preceded it");
  });

  test("a flush that rejects toasts the failure, paints the tab, and drops the spinner", async () => {

    using harness = makeWebUiHarness({ config: CONFIG, firstRun: { isRequired: () => false } });

    await harness.ui.show();

    /* A failure is reported and its chrome settled. featureOptions.hide() is documented never to reject, so this row drives a failure that contract rules out - and
     * the reading is that it surfaces as the boundary's own toast with the tab painted regardless, rather than vanishing into the click listener's dropped promise.
     * That the row completes green is also the no-unhandled-rejection assertion, since node:test fails a test whose turn produced one.
     */
    harness.ui.featureOptions.hide = async () => { throw new Error("The pending edit could not be flushed."); };

    harness.fake.observed.toasts.length = 0;

    harness.skeleton.menuSettings.click();
    await drain();

    assert.deepEqual(harness.fake.observed.toasts, [{ message: "The pending edit could not be flushed.", title: "Error", variant: "error" }],
      "a failed flush surfaces exactly one error toast");
    assert.equal(harness.fake.observed.calls.includes("showSchemaForm"), true, "and the tab the user asked for is painted regardless");
    assert.equal(harness.fake.observed.state.spinnerCount, 0, "and the spinner comes down, so nothing strands the user on it");
  });
});

describe("webUi.liveness - the public plugin surface", () => {

  // The detector's default cadence and gap threshold in milliseconds, mirrored so a test can advance in cadence-sized steps and jump clear past the threshold.
  const INTERVAL_MS = 15000;
  const THRESHOLD_MS = 90000;

  test("onResume subscribes a plugin callback to page resumes, honors its gate, and dies with its signal", (t) => {

    // Enable the clocks before constructing webUi: the detector seeds its last-tick clock when it arms, and arming against a real-epoch seed under a zeroed mock clock
    // would read every gap as negative and silently kill the probe.
    t.mock.timers.enable({ apis: [ "Date", "setInterval" ] });

    using harness = makeWebUiHarness({ config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }] });

    // Exactly how a plugin uses it: a callback, an optional gate, an optional lifecycle signal.
    const controller = new AbortController();
    const fires = [];
    let gateOpen = true;

    harness.ui.liveness.onResume(() => fires.push(1), { shouldProbe: () => gateOpen, signal: controller.signal });

    const resume = () => {

      t.mock.timers.setTime(Date.now() + (6 * THRESHOLD_MS));
      t.mock.timers.tick(INTERVAL_MS);
    };

    resume();
    assert.equal(fires.length, 1, "a page resume reaches the plugin's callback");

    gateOpen = false;
    resume();
    assert.equal(fires.length, 1, "a shut gate skips the plugin's callback");

    gateOpen = true;
    controller.abort();
    resume();
    assert.equal(fires.length, 1, "an aborted subscription receives nothing further");
  });

  test("the surface is onResume alone - the deadline helpers are imported from the liveness module, not re-exposed here", () => {

    using harness = makeWebUiHarness({ config: [] });

    assert.deepEqual(Object.keys(harness.ui.liveness), ["onResume"], "a second path to withDeadline would be a second source of truth for it");
  });

  // Advance the wall clock clear past the gap threshold WITHOUT running timers, then drain one sampling cadence, which is what a detector reads as a resume.
  const resume = (t) => {

    t.mock.timers.setTime(Date.now() + (6 * THRESHOLD_MS));
    t.mock.timers.tick(INTERVAL_MS);
  };

  test("the documented call shapes hold - a bare callback subscribes for the life of the page, and a shouldProbe gate gates", (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setInterval" ] });

    using harness = makeWebUiHarness({ config: [] });

    const bare = [];
    const gated = [];
    let gateOpen = false;

    // The documented single-argument shape passes no options object at all, and with no signal to end it the subscription lives for the page.
    harness.ui.liveness.onResume(() => bare.push(1));
    harness.ui.liveness.onResume(() => gated.push(1), { shouldProbe: () => gateOpen });

    resume(t);

    assert.equal(bare.length, 1, "the single-argument call shape subscribes and fires");
    assert.equal(gated.length, 0, "a shut gate gates");

    gateOpen = true;
    resume(t);

    assert.equal(gated.length, 1, "and an open gate delivers");
  });
});

describe("webUi.registerTheming - the page-lifetime theming surface", () => {

  // Drain queued async work. A registration is a bridge read plus its continuation, so a handful of macrotask cycles covers it with no wall-clock wait.
  const flush = async () => {

    for(let i = 0; i < 12; i++) {

      // Sequential awaits are intentional: each cycle must complete before the next is scheduled, since they drain a chained queue rather than parallel work.
      // eslint-disable-next-line no-await-in-loop
      await flushPending();
    }
  };

  // Stand up the DOM, the fake bridge, and a webUi instance, plus Bootstrap's readiness shim and a `.btn-primary` the accent probe can read - so a probe that runs
  // writes an observable value onto `:root`. The bridge is installed before the construction because registerTheming reads the page's global host.
  const arrange = ({ lightingMode = "light" } = {}) => {

    const dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({ lightingMode });
    const homebridgeGuard = installHomebridge(fake);

    seedBootstrapProbeShim();

    return {

      fake,
      sheetsBefore: document.adoptedStyleSheets.length,
      ui: new webUi({ name: "Plugin" }),

      [Symbol.dispose]() {

        homebridgeGuard[Symbol.dispose]();
        dom[Symbol.dispose]();
      }
    };
  };

  // Dispatch the host's own theme announcement into this window, in the shape Homebridge posts it.
  const postThemeUpdate = () => window.dispatchEvent(new window.MessageEvent("message", { data: { isDark: true, theme: "dark", type: "theme-update" } }));

  // The adopted sheets this registration added, as text, in adoption order.
  const registeredSheetText = (harness) => document.adoptedStyleSheets.slice(harness.sheetsBefore).map((sheet) => [...sheet.cssRules].map((r) => r.cssText).join("\n"));

  /* Take ownership of the unhandled-rejection channel for the duration of `body`, handing it back afterwards. The test runner keeps its own listener on that
   * channel and turns anything it sees into a test failure, so a row that needs to ASSERT on the channel - including one that deliberately raises a positive
   * control to prove its instrument works - has to hold the channel itself while it looks.
   */
  const captureUnhandledRejections = async (body) => {

    const captured = [];
    const runnerListeners = process.listeners("unhandledRejection");
    const onUnhandled = (reason) => captured.push(reason);

    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", onUnhandled);

    try {

      return await body(captured);
    } finally {

      process.off("unhandledRejection", onUnhandled);

      for(const listener of runnerListeners) {

        process.on("unhandledRejection", listener);
      }
    }
  };

  test("registers once for the page: two calls adopt two sheets, tokens before the theme, and hand back one promise", async () => {

    using harness = arrange({ lightingMode: "dark" });

    const first = harness.ui.registerTheming();
    const second = harness.ui.registerTheming();

    await Promise.all([ first, second ]);
    await flush();

    const adopted = registeredSheetText(harness);

    assert.equal(adopted.length, 2, "exactly two sheets - the second call registered nothing of its own");
    assert.equal(first, second, "and both calls handed back the same promise identity");

    // Order is the contract, not an accident: every rule in the theme sheet reads a token the first sheet declares.
    assert.match(adopted[0], /--fo-surface-bg/, "the token sheet is adopted first");
    assert.match(adopted[1], /\.fo-card/, "and the page theme after it");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "and the registration applied the host's mode");
  });

  test("a probe override is honored on the first call and ignored on every later one", async () => {

    using harness = arrange();

    const warnings = [];

    // eslint-disable-next-line no-console
    const realWarn = console.warn;

    // eslint-disable-next-line no-console
    console.warn = (...args) => warnings.push(args);

    try {

      /* The Bootstrap wait is where a probe override becomes observable: with no readiness shim on this DOM, a short timeout elapses and the wait says so, naming
       * the exact millisecond value it was given. The arrange helper's shim is deliberately unused here - it seeds `.btn-primary` for the accent, and the
       * readiness probe keys on `.d-none`, which this row removes below so the wait actually elapses.
       */
      document.adoptedStyleSheets = document.adoptedStyleSheets.slice(0, harness.sheetsBefore - 1);

      const first = harness.ui.registerTheming({ probe: { intervalMs: 1, timeoutMs: 5 } });
      const second = harness.ui.registerTheming({ probe: { intervalMs: 1, timeoutMs: 9999 } });

      assert.equal(first, second, "the second call returned the same promise rather than registering again");

      await first;
      await waitFor(() => warnings.length > 0, { message: "the Bootstrap wait never reported its elapse" });
      await flush();

      const probeWarnings = warnings.filter(([message]) => (typeof message === "string") && message.includes("Bootstrap stylesheet did not load"));

      assert.equal(probeWarnings.length, 1, "the wait elapsed exactly once - the second call started no second probe");
      assert.match(probeWarnings[0][0], /within 5ms/, "and it ran on the FIRST call's override, not the second's");
    } finally {

      // eslint-disable-next-line no-console
      console.warn = realWarn;
    }
  });

  test("a rejected first mode read still leaves theming registered, and the host's next message applies the mode", async () => {

    using harness = arrange();

    harness.fake.userCurrentLightingMode = async () => {

      throw new Error("the bridge refused the read");
    };

    const registration = harness.ui.registerTheming();

    await assert.rejects(registration, /the bridge refused the read/, "a caller that awaits still observes the failure");
    await flush();

    assert.equal(registeredSheetText(harness).length, 2, "both sheets are live despite the failed read");
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "precondition: no mode was applied, so the heal below is attributable");

    // Heal the bridge. Nothing re-registers - the follow routes went live before the failed read, so the host's own next announcement is what applies the mode.
    harness.fake.userCurrentLightingMode = async () => "dark";
    postThemeUpdate();
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "the message route applied the mode the failed read never delivered");
    assert.equal(harness.ui.registerTheming(), registration, "and a later call returns the same settled promise");
    assert.equal(registeredSheetText(harness).length, 2, "without adopting a single sheet twice");
  });

  test("a rejected first mode read heals through the body-class route too", async () => {

    using harness = arrange();

    harness.fake.userCurrentLightingMode = async () => {

      throw new Error("the bridge refused the read");
    };

    await assert.rejects(harness.ui.registerTheming(), /the bridge refused the read/);
    await flush();

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "precondition: no mode was applied");

    harness.fake.userCurrentLightingMode = async () => "dark";
    document.body.classList.add("dark-mode");
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "the host's retint of our own body applied the mode");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), BOOTSTRAP_PROBE_ACCENT, "and drove the accent probe with it");
  });

  test("a voided registration whose read rejects raises no unhandled rejection, while an awaited one still observes it", async () => {

    using harness = arrange();

    await captureUnhandledRejections(async (captured) => {

      // The positive control, first: an absence assertion is worth nothing until the instrument is proven able to see the event it will claim is absent.
      Promise.reject(new Error("the positive control"));
      await flush();

      assert.equal(captured.length, 1, "precondition: the capture observes a genuinely unhandled rejection");

      harness.fake.userCurrentLightingMode = async () => {

        throw new Error("the bridge refused the read");
      };

      // The house rule for a promise a caller does not want is to void it, and voiding attaches no rejection handler - so the surface has to own the posture.
      void harness.ui.registerTheming();
      await flush();

      assert.equal(captured.length, 1, "voiding the registration raised nothing further");

      // The other half of the posture: the same promise still rejects for a caller that takes its own branch on it.
      await assert.rejects(harness.ui.registerTheming(), /the bridge refused the read/, "an awaiting caller still observes the failure");
      await flush();

      assert.equal(captured.length, 1, "and observing it that way raised nothing either");
    });
  });

  test("a read that rejects on a later host announcement is absorbed, and the announcement after it still applies the mode", async () => {

    using harness = arrange();

    await captureUnhandledRejections(async (captured) => {

      Promise.reject(new Error("the positive control"));
      await flush();

      assert.equal(captured.length, 1, "precondition: the capture is live");
      await harness.ui.registerTheming();
      await flush();

      // The follow path fires and forgets, so a read that fails there has no caller to reject to - it must be absorbed at the follower rather than escaping.
      harness.fake.userCurrentLightingMode = async () => {

        throw new Error("the bridge went away mid-session");
      };

      postThemeUpdate();
      await flush();

      assert.equal(captured.length, 1, "the failed follow raised no unhandled rejection");
      assert.equal(document.documentElement.classList.contains("fo-dark"), false, "and changed nothing on the page");

      harness.fake.userCurrentLightingMode = async () => "dark";
      postThemeUpdate();
      await flush();

      assert.equal(document.documentElement.classList.contains("fo-dark"), true, "the next announcement applied the mode - the route survived the failed read");
    });
  });

  test("theming outlives a feature-options navigate-away, while the options skin dies with the view", async () => {

    using harness = makeWebUiHarness({

      config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }],
      featureOptions: { globalOnly: true },
      firstRun: { isRequired: () => false },
      lightingMode: "dark",
      requestResponses: new Map([[ "/getOptions", {

        categories: [{ description: "Motion Options", name: "Motion" }],
        options: { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] }
      } ]]),
      unstubbed: true
    });

    await harness.ui.show();
    await flush();

    // The sheets the page carries while the options view is on screen, told apart by a rule only each one declares.
    const sheetTexts = () => document.adoptedStyleSheets.map((sheet) => [...sheet.cssRules].map((r) => r.cssText).join("\n"));
    const carries = (needle) => sheetTexts().some((text) => text.includes(needle));

    assert.ok(carries("--fo-surface-bg"), "precondition: the token sheet is adopted");
    assert.ok(carries(".fo-card"), "precondition: the page theme is adopted");
    assert.ok(carries(".nav-link"), "precondition: the options skin is adopted");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "precondition: the host's dark mode is applied to :root");

    await harness.ui.featureOptions.hide();
    await flush();

    // Navigating to Settings or Support tears the view down. Theming is a page concern, so it must survive that - which is the whole point of registering it for
    // the page rather than on the cycle.
    assert.ok(carries("--fo-surface-bg"), "the token sheet survives the navigate-away");
    assert.ok(carries(".fo-card"), "so does the page theme, kit classes and all");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "and the themed canvas stays dark rather than reverting under the user");
    assert.equal(carries(".nav-link"), false, "while the options skin is released with the view whose Bootstrap classes it restyles");
  });
});

describe("webUi - the resume detector threads end to end", () => {

  // The detector's default cadence and gap threshold in milliseconds, mirrored so a test can jump the clock clear past the threshold.
  const INTERVAL_MS = 15000;
  const THRESHOLD_MS = 90000;

  // Drain queued async work until the predicate answers, so each step waits on the state it needs rather than on a fixed number of cycles.
  const drainUntil = async (predicate) => {

    for(let i = 0; i < 400; i++) {

      const found = predicate();

      if(found) {

        return found;
      }

      // eslint-disable-next-line no-await-in-loop
      await flushPending();
    }

    return null;
  };

  test("a resume reaches the status panel's probe through all three hops: webUi, the feature-options orchestrator, and the mounted panel", async (t) => {

    // Enable the clocks before constructing webUi: the detector seeds its last-tick clock when it arms, and arming against a real-epoch seed under a zeroed mock clock
    // would read every gap as negative and silently kill the probe.
    t.mock.timers.enable({ apis: [ "Date", "setInterval", "setTimeout" ] });

    // A device in the accessory cache so the panel has something to view, and a status route whose requests are captured so a probe is countable.
    const accessories = [{

      displayName: "Device A",
      services: [{

        characteristics: [

          { constructorName: "FirmwareRevision", value: "1.0.0" },
          { constructorName: "Manufacturer", value: "Acme" },
          { constructorName: "Model", value: "Model-A" },
          { constructorName: "SerialNumber", value: "AA" }
        ],
        constructorName: "AccessoryInformation"
      }]
    }];

    using harness = makeWebUiHarness({

      accessories,
      config: [{ name: "TestPlatform", options: [], platform: "TestPlatform" }],

      // A statusPanel-configured page is what mounts the panel that subscribes; the detector reaches it only if every hop of the wiring is connected.
      featureOptions: { statusPanel: { placeholderRows: [] } },
      firstRun: { isRequired: () => false },
      requestResponses: new Map([[ "/getOptions", {

        categories: [{ description: "Motion Options", name: "Motion" }],
        options: { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] }
      } ]]),
      unstubbed: true
    });

    const viewRequests = [];

    harness.fake.request = async (path, body) => {

      if(path === "/getOptions") {

        return {

          categories: [{ description: "Motion Options", name: "Motion" }],
          options: { Motion: [{ default: true, description: "Enable motion detection.", name: "Detect" }] }
        };
      }

      if(path === STATUS_VIEW_ROUTE) {

        viewRequests.push(body);
      }

      return null;
    };

    await harness.ui.show();

    // Drain until the sidebar has rendered the cached device, then select it the way a user does. The panel mounts against a viewed device, and device-only mode opens
    // on global scope, so the click is what puts a device on screen for the probe to target.
    const deviceLink = await drainUntil(() => document.getElementById("devicesContainer").querySelector(".nav-link[data-device-serial='AA']"));

    assert.ok(deviceLink, "precondition: the sidebar rendered the cached device");

    deviceLink.click();

    assert.ok(await drainUntil(() => document.getElementById("deviceStatsContainer").querySelector(".stat-item")),
      "precondition: the status panel mounted against the viewed device");

    const probesBefore = viewRequests.length;

    assert.ok(probesBefore > 0, "precondition: the selection fired the panel's own view request");

    // Simulate an OS suspension: jump the wall clock far past the threshold WITHOUT running timers, then drain one cadence. The detector webUi constructed must notice
    // it, walk its subscription, and land on the probe the panel registered - proving the whole chain is connected rather than merely present at each end.
    t.mock.timers.setTime(Date.now() + (6 * THRESHOLD_MS));
    t.mock.timers.tick(INTERVAL_MS);

    assert.equal(viewRequests.length, probesBefore + 1, "the page-level resume reached the mounted panel's probe");
    assert.equal(viewRequests.at(-1).serialNumber, "AA", "and the probe targeted the device on screen");
  });
});
