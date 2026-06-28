/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-featureOptions-connection-error.test.mjs: Tests for the connection-error retry display. The path runs when getControllers is provided and
 * getDevices(controller) returns empty: the orchestrator dispatches connection:error and the connection-error view (webUi-featureOptions/views/connectionError.mjs)
 * renders a friendly error block with a retry button that becomes enabled after a configurable delay and, on click, calls show() to attempt a fresh connection. The
 * retry path performs no explicit cleanup(): show()'s internal `await this.hide()` flushes any pending edit and tears down the prior cycle before re-rendering.
 */
"use strict";

import { createFakeHomebridge, createSkeletonFeatureOptionsDom, createTestDom, installHomebridge, openTestSession } from "./ui.helpers.mjs";
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { webUiFeatureOptions } from "./webUi-featureOptions.mjs";

function seedBootstrapProbeShim() {

  const sheet = new CSSStyleSheet();

  sheet.replaceSync(".d-none { display: none; } .btn-warning { background-color: rgb(255, 193, 7); color: rgb(33, 37, 41); }");
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, sheet ];
}

async function flush() {

  await delay(10);
}

const FEATURES = {

  categories: [{ description: "Motion Options", name: "Motion" }],
  options: { Motion: [{ default: true, description: "Detect.", name: "Detect" }] }
};

function makePluginConfig() {

  return [{ name: "TestPlugin", options: [], platform: "TestPlugin" }];
}

describe("webUiFeatureOptions - connection-error view", () => {

  test("renders the error block with the remote error message and a disabled retry button", async () => {

    using _dom = createTestDom();
    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      errorMessage: "Connection refused: 192.0.2.1:1883",
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    // Build an orchestrator with getControllers returning one controller and getDevices returning empty for that controller. This is the exact precondition for the
    // connection-error path: a controller is configured but the orchestrator cannot reach any devices behind it.
    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [{ name: "Network Hub", serialNumber: "CTRL-001" }],
      getDevices: () => []
    });

    await orchestrator.show(await openTestSession());
    await flush();

    // The error block lives in the headerInfo container; the retry button must be disabled initially while the progress bar fills.
    const retryButton = skeleton.headerInfo.querySelector("button.btn-warning");

    assert.ok(retryButton, "the retry button must be rendered");
    assert.equal(retryButton.disabled, true, "retry button starts disabled while the progress bar fills");
    assert.match(retryButton.textContent, /Retry/, "retry button text must include the word \"Retry\"");

    // The remote-supplied error text must surface inside a <code> element. The exact content escapes through textContent so any markup-shaped fragments stay literal.
    const codeElement = skeleton.headerInfo.querySelector("code");

    assert.ok(codeElement, "remote error text must be wrapped in a <code> element");
    assert.equal(codeElement.textContent, "Connection refused: 192.0.2.1:1883",
      "the remote /getErrorMessage response must surface verbatim in the error display");

    // The connection-error view owns the header reveal: it reveals #headerInfo itself when it renders the error block, so the error is visible without the orchestrator
    // running its success-path revealRegions(). Every other region stays hidden - the user has no devices to navigate to, and the views no longer self-reveal on mount.
    assert.equal(skeleton.headerInfo.style.display, "", "the connection-error view must reveal the header so the error display is visible");
    assert.equal(skeleton.sidebar.style.display, "none", "sidebar must be hidden during connection-error display");
    assert.equal(skeleton.search.style.display, "none", "the search panel must stay hidden during connection-error display - the view no longer self-reveals");

    orchestrator.cleanup();
  });

  test("retry button becomes enabled after controllerRetryEnableDelayMs and the progress bar is removed", async () => {

    using _dom = createTestDom();
    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      errorMessage: "down",
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    // We open the session before enabling fake timers because the session's open() awaits the fake getPluginConfig microtask, which must not be intercepted by mock
    // timers. With the session in hand, we can safely switch the clock to virtual time for the rest of the test.
    const session = await openTestSession();

    // We mock setTimeout so we can advance virtual time deterministically past the retry-enable delay without burning the suite's wall-clock budget. The orchestrator
    // sets controllerRetryEnableDelayMs to 5000 by default; running real-time through that would dominate the test runtime and reintroduce the flake-prone real-time
    // waits that virtual timers exist to avoid.
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const orchestrator = new webUiFeatureOptions({

        getControllers: () => [{ name: "Hub", serialNumber: "CTRL-001" }],
        getDevices: () => [],
        ui: { controllerRetryEnableDelayMs: 100 }
      });

      // show() awaits a chain that includes its own internal setTimeout calls (theme probe, etc.). With mock.timers active those are also intercepted; we drive
      // them forward enough to let show() complete by ticking generously.
      const showPromise = orchestrator.show(session);

      mock.timers.tick(5000);
      await showPromise;
      await new Promise((resolve) => setImmediate(resolve));

      const retryButton = skeleton.headerInfo.querySelector("button.btn-warning");

      assert.ok(retryButton, "the retry button must exist before we advance virtual time");

      // The post-show setTimeout for the retry-enable delay is the one we need to fire. After ticking 100ms, the callback should have run.
      mock.timers.tick(150);
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(retryButton.disabled, false, "retry button must be enabled after the configured retry delay elapses");

      // The progress bar wrapper must be detached from the DOM after the delay completes.
      const progressBars = skeleton.headerInfo.querySelectorAll(".progress");

      assert.equal(progressBars.length, 0, "the progress-bar wrapper must be removed once the retry button is ready");

      orchestrator.cleanup();
    } finally {

      mock.timers.reset();
    }
  });

  test("clicking the enabled retry button runs cleanup() and re-fetches controllers via show()", async () => {

    // The full retry flow ends in cleanup() + show(). We verify the loop by counting getControllers calls: show() invokes the callback during its initial render
    // pass, the click triggers a fresh show() which invokes it again. A second-pass invocation proves the click landed.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    let getControllersCalls = 0;
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      errorMessage: "transient",
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    // We open the session before enabling fake timers because the session's open() awaits the fake getPluginConfig microtask, which must not be intercepted by mock
    // timers. With the session in hand, we can safely switch the clock to virtual time for the rest of the test.
    const session = await openTestSession();

    // mock setTimeout so the retry-enable delay advances under deterministic control. The theme probe is also intercepted; we tick once aggressively to let show()
    // complete past every internal timer.
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const orchestrator = new webUiFeatureOptions({

        getControllers: () => {

          getControllersCalls++;

          return [{ name: "Hub", serialNumber: "CTRL-1" }];
        },
        getDevices: () => [],
        ui: { controllerRetryEnableDelayMs: 100 }
      });

      const showPromise = orchestrator.show(session);

      mock.timers.tick(5000);
      await showPromise;
      await new Promise((resolve) => setImmediate(resolve));

      // The retry button is now rendered but disabled. Advance past the enable delay so the click handler attaches.
      mock.timers.tick(150);
      await new Promise((resolve) => setImmediate(resolve));

      const retryButton = skeleton.headerInfo.querySelector("button.btn-warning");

      assert.equal(retryButton.disabled, false, "retry button must be enabled before the click");

      const callsBefore = getControllersCalls;

      // The click handler calls cleanup() then await show(). We use real timers for show()'s internal awaits since mock.timers would still intercept them; the
      // simplest path is to disable mock timers right before the click so show()'s setTimeout calls run on real time. We then advance the test-level flush.
      mock.timers.reset();
      retryButton.click();

      // Yield to let the click handler's await this.show() pipeline run.
      await delay(50);

      assert.ok(getControllersCalls > callsBefore,
        "clicking the enabled retry button must trigger a fresh show() that re-invokes getControllers");

      orchestrator.cleanup();
    } finally {

      mock.timers.reset();
    }
  });
});
