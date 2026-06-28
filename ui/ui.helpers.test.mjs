/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/ui.helpers.test.mjs: Unit tests for the webUI test helpers in ui.helpers.mjs - createTestDom, createSkeletonFeatureOptionsDom, createFakeHomebridge,
 * installHomebridge, waitFor. These primitives compose every UI test in the codebase, so a regression in their disposal semantics, inspection surface
 * (`observed.state` / `observed.toasts` / `observed.updatedConfigs`), or wait-loop control flow would silently break the entire UI suite. Coverage targets every
 * branch: snapshot/restore arithmetic in createTestDom, the skeleton element shape, every toast channel and every state mutation, the previous-value restoration
 * in installHomebridge, and waitFor's already-truthy fast path, polling-becomes-truthy path, timeout failure paths, and predicate-throw propagation.
 */
"use strict";

import { createFakeHomebridge, createSkeletonFeatureOptionsDom, createTestDom, installHomebridge, waitFor } from "./ui.helpers.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("createTestDom", () => {

  test("installs document, window, HTMLElement, Event, CSSStyleSheet, and getComputedStyle on globalThis", () => {

    using dom = createTestDom();

    // The contract: every entry in INSTALLED_DOM_GLOBALS is now reachable from bare references the UI source uses unqualified. Spot-check the most-loaded ones.
    assert.ok(globalThis.document, "document must be installed as a global");
    assert.ok(globalThis.window, "window must be installed as a global");
    assert.equal(typeof globalThis.HTMLElement, "function", "HTMLElement must be installed as a global");
    assert.equal(typeof globalThis.Event, "function", "Event must be installed");
    assert.equal(typeof globalThis.CSSStyleSheet, "function", "CSSStyleSheet must be installed (Constructable Stylesheet API)");
    assert.equal(typeof globalThis.getComputedStyle, "function", "getComputedStyle must be installed");
    assert.equal(globalThis.window, dom.window, "the installed window global must be the underlying Happy-DOM window the handle exposes");
  });

  test("Symbol.dispose restores the previous global state and closes the window", () => {

    // The disposal contract: after the handle's [Symbol.dispose] runs, globals are exactly what they were before createTestDom installed them. We snapshot before,
    // install, snapshot during, dispose, and verify the post-disposal table matches the pre-install table.
    const before = { document: globalThis.document, window: globalThis.window };

    {

      using _dom = createTestDom();

      void _dom;
      assert.notEqual(globalThis.document, before.document, "during the dom scope, document must be the Happy-DOM document (not the previous value)");
    }

    assert.equal(globalThis.document, before.document, "after dispose, document must be restored to the pre-install value");
    assert.equal(globalThis.window, before.window, "after dispose, window must be restored to the pre-install value");
  });

  test("nested createTestDom calls unwind in reverse order (LIFO disposal)", () => {

    using outer = createTestDom();
    const outerWindow = globalThis.window;

    {

      using _inner = createTestDom();

      void _inner;
      assert.notEqual(globalThis.window, outerWindow, "inner scope must install a different window than the outer one");
    }

    // After the inner disposes, the outer window must be back at the top of the stack.
    assert.equal(globalThis.window, outerWindow, "after inner dispose, the outer dom's window must be restored");
    assert.equal(globalThis.window, outer.window, "and that window must be the outer handle's window reference");
  });
});

describe("createSkeletonFeatureOptionsDom", () => {

  test("returns a record of named element references for every skeleton mount point", () => {

    using _dom = createTestDom();

    void _dom;

    const skeleton = createSkeletonFeatureOptionsDom();

    // Every element the orchestrator looks up by id must be reachable through the returned skeleton record. We pin the full surface so any silent removal of a key
    // breaks here rather than at the test bodies that consume them.
    const requiredKeys = [

      "configTable", "controllersContainer", "deviceStatsContainer", "devicesContainer", "firstRun", "headerInfo", "menuFeatureOptions", "menuHome", "menuSettings",
      "menuWrapper", "pageFeatureOptions", "pageFirstRun", "pageSupport", "search", "sidebar", "statusInfo"
    ];

    for(const key of requiredKeys) {

      assert.ok(skeleton[key], "skeleton record must include reference to " + key);
      assert.ok(skeleton[key] === document.getElementById(key), key + " skeleton reference must be the document's element by that id");
    }
  });

  test("seeds the document with the orchestrator's expected element tree (queryable by id)", () => {

    using _dom = createTestDom();

    void _dom;
    createSkeletonFeatureOptionsDom();

    // Spot-check: the configTable is a DIV (it holds category `<details>` elements as children - `<table>` would be invalid HTML for housing `<details>`),
    // the menu buttons are BUTTONS, and the page containers are DIVs. The orchestrator's getElementById calls would silently fail if these tags were swapped.
    assert.equal(document.getElementById("configTable")?.tagName, "DIV", "configTable must be a DIV element - it holds <details> children, not table rows");
    assert.equal(document.getElementById("menuFeatureOptions")?.tagName, "BUTTON", "menu buttons must be BUTTON elements");
    assert.equal(document.getElementById("pageFeatureOptions")?.tagName, "DIV", "pageFeatureOptions must be a DIV container");
  });
});

describe("createFakeHomebridge - defaults", () => {

  test("returns a bridge with sensible default state when called with no init", () => {

    const fake = createFakeHomebridge();

    assert.equal(fake.observed.state.spinnerCount, 0, "spinner count must start at 0");
    assert.equal(fake.observed.state.saveButtonEnabled, true, "save button must default to enabled");
    assert.equal(fake.observed.state.schemaFormVisible, true, "schema form must default to visible");
    assert.deepEqual(fake.observed.toasts, [], "toasts list must start empty");
    assert.deepEqual(fake.observed.updatedConfigs, [], "updatedConfigs list must start empty");
  });

  test("getPluginConfig resolves to the seeded config (default empty array)", async () => {

    const fake = createFakeHomebridge();

    assert.deepEqual(await fake.getPluginConfig(), [], "default getPluginConfig must resolve to an empty array");

    const seeded = createFakeHomebridge({ config: [{ name: "X" }] });

    assert.deepEqual(await seeded.getPluginConfig(), [{ name: "X" }], "seeded getPluginConfig must resolve to the supplied array");
  });

  test("getCachedAccessories resolves to the seeded accessories", async () => {

    const fake = createFakeHomebridge({ cachedAccessories: [ { id: "a" }, { id: "b" } ] });

    assert.deepEqual(await fake.getCachedAccessories(), [ { id: "a" }, { id: "b" } ]);
  });

  test("userCurrentLightingMode resolves to the seeded mode (default \"light\")", async () => {

    assert.equal(await createFakeHomebridge().userCurrentLightingMode(), "light", "default lighting mode is \"light\"");
    assert.equal(await createFakeHomebridge({ lightingMode: "dark" }).userCurrentLightingMode(), "dark", "explicit \"dark\" mode flows through");
  });
});

describe("createFakeHomebridge - state mutations", () => {

  test("showSpinner / hideSpinner balance to net stack depth (clamped at zero)", () => {

    const fake = createFakeHomebridge();

    fake.showSpinner();
    fake.showSpinner();
    fake.showSpinner();
    assert.equal(fake.observed.state.spinnerCount, 3, "three pushes should leave the depth at 3");

    fake.hideSpinner();
    fake.hideSpinner();
    assert.equal(fake.observed.state.spinnerCount, 1, "two pops should leave the depth at 1");

    // Over-popping must clamp at zero rather than going negative - matches the production contract that hideSpinner is a no-op when the spinner is already hidden.
    fake.hideSpinner();
    fake.hideSpinner();
    fake.hideSpinner();
    assert.equal(fake.observed.state.spinnerCount, 0, "over-popping the spinner stack must clamp at zero");
  });

  test("disableSaveButton / enableSaveButton flip the saveButtonEnabled state", () => {

    const fake = createFakeHomebridge();

    fake.disableSaveButton();
    assert.equal(fake.observed.state.saveButtonEnabled, false);

    fake.enableSaveButton();
    assert.equal(fake.observed.state.saveButtonEnabled, true);
  });

  test("hideSchemaForm / showSchemaForm flip the schemaFormVisible state", () => {

    const fake = createFakeHomebridge();

    fake.hideSchemaForm();
    assert.equal(fake.observed.state.schemaFormVisible, false);

    fake.showSchemaForm();
    assert.equal(fake.observed.state.schemaFormVisible, true);
  });
});

describe("createFakeHomebridge - request router", () => {

  test("/getErrorMessage resolves to the seeded errorMessage (default empty string)", async () => {

    assert.equal(await createFakeHomebridge().request("/getErrorMessage"), "", "default errorMessage is empty string");
    assert.equal(await createFakeHomebridge({ errorMessage: "boom" }).request("/getErrorMessage"), "boom", "seeded errorMessage flows through");
  });

  test("seeded paths resolve to their map values; unknown paths resolve to null", async () => {

    const responses = new Map([ [ "/getOptions", { categories: [] } ], [ "/getDevices", [{ id: "x" }] ] ]);
    const fake = createFakeHomebridge({ requestResponses: responses });

    assert.deepEqual(await fake.request("/getOptions"), { categories: [] }, "seeded path must resolve to its map value");
    assert.deepEqual(await fake.request("/getDevices"), [{ id: "x" }]);
    assert.equal(await fake.request("/unknown"), null, "unknown path must resolve to null (quiet miss, not a throw)");
  });
});

describe("createFakeHomebridge - toasts", () => {

  test("each toast channel records its calls with variant, message, and title", () => {

    const fake = createFakeHomebridge();

    fake.toast.error("err msg", "Error Title");
    fake.toast.success("ok msg", "Success Title");
    fake.toast.info("info msg", "Info Title");
    fake.toast.warning("warn msg", "Warn Title");

    assert.deepEqual(fake.observed.toasts, [

      { message: "err msg", title: "Error Title", variant: "error" },
      { message: "ok msg", title: "Success Title", variant: "success" },
      { message: "info msg", title: "Info Title", variant: "info" },
      { message: "warn msg", title: "Warn Title", variant: "warning" }
    ], "every toast channel must record its calls with the channel-discriminator");
  });

  test("toasts called without a title argument record undefined for title", () => {

    const fake = createFakeHomebridge();

    fake.toast.error("just a message");

    assert.deepEqual(fake.observed.toasts, [{ message: "just a message", title: undefined, variant: "error" }],
      "missing title must record as undefined (not omitted) so destructuring on the record always sees the field");
  });
});

describe("createFakeHomebridge - updatePluginConfig", () => {

  test("records every call's payload as a structured clone (not a reference)", async () => {

    const fake = createFakeHomebridge();
    const config = [{ name: "PluginA" }];

    await fake.updatePluginConfig(config);

    assert.deepEqual(fake.observed.updatedConfigs, [[{ name: "PluginA" }]], "the recorded payload must equal the input");

    // Mutating the original after the call must NOT affect the recorded snapshot - structuredClone severs the shared reference.
    config[0].name = "MutatedAfter";
    assert.equal(fake.observed.updatedConfigs[0][0].name, "PluginA", "the recorded snapshot must be immune to post-call mutation of the source");
  });
});

describe("installHomebridge", () => {

  test("installs the bridge as globalThis.homebridge and the disposer restores the previous value", () => {

    using _dom = createTestDom();

    void _dom;

    const before = globalThis.homebridge;
    const fake = createFakeHomebridge();

    {

      using _guard = installHomebridge(fake);

      void _guard;
      assert.equal(globalThis.homebridge, fake, "during the guard's scope, homebridge must be the fake bridge");
    }

    assert.equal(globalThis.homebridge, before, "after dispose, homebridge must be restored to its previous value");
  });

  test("disposing when no previous value existed deletes the property entirely", () => {

    using _dom = createTestDom();

    void _dom;

    // Ensure no prior homebridge is installed (createTestDom does not install one).
    delete globalThis.homebridge;
    assert.equal(globalThis.homebridge, undefined, "precondition: homebridge starts undefined");

    const fake = createFakeHomebridge();

    {

      using _guard = installHomebridge(fake);

      void _guard;
      assert.equal(globalThis.homebridge, fake);
    }

    assert.equal("homebridge" in globalThis, false, "after dispose with no previous value, the property must be deleted entirely (not set to undefined)");
  });

  test("nested installs unwind to the outer install's bridge, then to the original (LIFO)", () => {

    using _dom = createTestDom();

    void _dom;

    delete globalThis.homebridge;

    const outerFake = createFakeHomebridge();
    const innerFake = createFakeHomebridge();

    {

      using _outer = installHomebridge(outerFake);

      void _outer;
      assert.equal(globalThis.homebridge, outerFake);

      {

        using _inner = installHomebridge(innerFake);

        void _inner;
        assert.equal(globalThis.homebridge, innerFake, "during inner scope, the inner fake must shadow the outer");
      }

      assert.equal(globalThis.homebridge, outerFake, "after inner dispose, the outer fake must be back at the top");
    }

    assert.equal("homebridge" in globalThis, false, "after both dispose, the property must be gone (no original to restore)");
  });
});

describe("waitFor", () => {

  // Coverage scope for the predicate-based wait primitive: every branch of its control flow. The helper is a load-bearing test infrastructure piece - it
  // replaces fixed-cycle drains in every controller-mode test - so a regression here would cascade into silent flake across the suite. Per the testing-conventions
  // helper coverage rule, every branch of this helper gets exercised: already-truthy fast path, eventual-success after polling, timeout with custom message,
  // timeout with default message, custom timeout respected, predicate-throw propagation.

  test("returns the predicate's truthy value immediately when the predicate is already true (no event-loop hop)", async () => {

    // The fast path: the predicate runs once before any await, so a synchronously-true condition resolves on the caller's microtask without yielding. We assert
    // this by counting predicate invocations - exactly one call when the value is true on first ask.
    let calls = 0;
    const sentinel = { name: "found" };

    const result = await waitFor(() => {

      calls++;

      return sentinel;
    });

    assert.equal(result, sentinel, "the helper resolves with the predicate's truthy return value, not a coerced boolean");
    assert.equal(calls, 1, "exactly one invocation - the already-truthy fast path must not enter the polling loop");
  });

  test("polls until the predicate becomes truthy, then resolves with the truthy value", async () => {

    // The eventual-success path: a predicate that returns falsy initially and flips truthy on a later call. The helper polls across setImmediate cycles until
    // the flip happens, then returns the truthy value. We use a counter that flips on the third call so the polling loop is genuinely exercised.
    let calls = 0;

    const result = await waitFor(() => {

      calls++;

      return (calls >= 3) ? "ready" : null;
    });

    assert.equal(result, "ready", "the helper must return the truthy value the predicate eventually produced");
    assert.equal(calls, 3, "the polling loop invokes the predicate per cycle - first call falsy, second call falsy, third call truthy");
  });

  test("throws with a default message when the predicate stays falsy past the timeout", async () => {

    // The failure path with no caller-supplied context. The default message must name the helper and the timeout value so an operator reading test output knows
    // both what timed out and how long it waited.
    await assert.rejects(

      waitFor(() => false, { timeout: 20 }),
      (error) => (error instanceof Error) && /waitFor:.*predicate did not become truthy.*within 20ms/.test(error.message)
    );
  });

  test("throws with the caller-supplied message when the predicate stays falsy past the timeout", async () => {

    // The failure path with caller context. The custom message replaces the default phrasing so the error describes what was being waited on, not just "predicate
    // did not become truthy" - the diagnostic difference between "test failed somewhere" and "the device row never rendered."
    await assert.rejects(

      waitFor(() => false, { message: "device row must render", timeout: 20 }),
      (error) => (error instanceof Error) && /waitFor:.*device row must render.*within 20ms/.test(error.message)
    );
  });

  test("respects a custom timeout value (shorter than default)", async () => {

    // Pins the contract that the timeout option actually drives the failure window. A 1ms timeout that takes longer than ~50ms would prove the timeout isn't
    // being read; we assert the timeout elapses faster than the default-1000ms would have allowed.
    const start = Date.now();

    await assert.rejects(waitFor(() => false, { timeout: 10 }));

    const elapsed = Date.now() - start;

    assert.ok(elapsed < 200, "10ms timeout must fail well within 200ms - we're proving the option is honored, not the default-1000ms");
  });

  test("propagates a synchronous throw from the predicate verbatim", async () => {

    // A predicate that throws is a test-author bug, not a polling condition. The helper must propagate the throw so the developer sees the real error
    // immediately rather than waiting for an opaque timeout. We verify the original error reaches the caller intact.
    const predicateError = new Error("predicate self-destructed");

    await assert.rejects(

      waitFor(() => { throw predicateError; }),
      (error) => error === predicateError
    );
  });
});
