/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-featureOptions.test.mjs: Integration-level tests for the webUiFeatureOptions orchestrator. These exercise high-value end-to-end flows (show / hide /
 * cleanup, global-options render, device navigation, config round-trip, category-state persistence) against a Happy-DOM window with the full skeleton template and
 * a fake homebridge bridge. Per-component guarantees live in the Tier 1-3 test files; this file pins the orchestration wiring.
 */
"use strict";

import { clickCategoryHeader, createFakeHomebridge, createSkeletonFeatureOptionsDom, createTestDom, installHomebridge, openTestSession, waitFor } from "./ui.helpers.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { webUiFeatureOptions } from "./webUi-featureOptions.mjs";

// The homebridge config-ui returns cached accessories with a flat `constructorName` string on each service and characteristic. Tests construct this shape directly
// rather than instantiating real HAP types - the orchestrator reads the string, which is exactly what the real config-ui surface provides.
function makeCachedAccessory({ displayName, firmwareRevision, manufacturer, model, serialNumber }) {

  return {

    displayName,
    services: [{

      characteristics: [

        { constructorName: "FirmwareRevision", value: firmwareRevision },
        { constructorName: "Manufacturer", value: manufacturer },
        { constructorName: "Model", value: model },
        { constructorName: "SerialNumber", value: serialNumber }
      ],

      constructorName: "AccessoryInformation"
    }]
  };
}

// Canonical categories / options used by every orchestrator test. The /getOptions backend response shape matches what the orchestrator requests at show() time.
const FEATURES = {

  categories: [

    { description: "Motion Options", name: "Motion" },
    { description: "Audio Options", name: "Audio" }
  ],

  options: {

    Audio: [

      { default: false, defaultValue: 50, description: "Audio volume level.", name: "Volume" }
    ],

    Motion: [

      { default: true, description: "Enable motion detection.", name: "Detect" }
    ]
  }
};

// Default plugin config shape the orchestrator reads: first entry is the plugin block with name, platform, and options array. Used as the starting point for every
// test; individual tests override as needed.
function makePluginConfig({ options = [], platform = "TestPlugin" } = {}) {

  return [{ name: "TestPlugin", options, platform }];
}

// Seed a CSS stylesheet matching Bootstrap's `.d-none { display: none }` so the theme component's #waitForBootstrap probe completes immediately rather than
// timing out after 2 seconds. Every show()-invoking test must call this after createTestDom so the theme's init() finishes promptly.
function seedBootstrapProbeShim() {

  const sheet = new CSSStyleSheet();

  sheet.replaceSync(".d-none { display: none; }");
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, sheet ];
}

// Drain pending async work without an arbitrary wall-clock wait. `setImmediate` from `node:timers/promises` queues a macrotask that runs after I/O callbacks and
// the microtask queue, so each await processes everything queued up to that point. We iterate a small fixed number of cycles to cover async chains where one
// settled task schedules more work (a store dispatch fires view subscribers that schedule follow-up renders, and show()'s devices fetch resolves into a further
// scope:changed dispatch). Quiescence is not directly observable from userland, so the iteration is bounded: a runaway scheduling loop fails fast in tests rather
// than hanging on a real-time timeout, while the fixed bound is comfortably larger than the deepest async chain the orchestrator produces in practice.
async function flush() {

  // Sequential awaits are intentional: each setImmediate cycle must complete before the next is scheduled, since they are draining a chained queue rather than
  // running independent work that could parallelize.
  for(let i = 0; i < 4; i++) {

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
}

// Wait long enough for the persist effect's 300ms debounce window to expire AND any subsequent persist call / rollback dispatch to settle. Used after any user
// action that should produce (or NOT produce) a persist call - a fixed wall-clock wait is the right primitive here because the test's interest is in the
// post-debounce settled state, not in observing the persist's individual lifecycle events. 400ms covers the debounce plus headroom for a synchronous persist
// resolve + reducer dispatch.
async function settlePersist() {

  await new Promise((resolve) => setTimeout(resolve, 400));
  await flush();
}

describe("webUiFeatureOptions.constructor", () => {

  test("caches the skeleton DOM mount points for later show() invocations", () => {

    using _dom = createTestDom();
    const skeleton = createSkeletonFeatureOptionsDom();

    // Install a minimal homebridge fake for the constructor to reference (it does not call anything on it, but downstream code might).
    using _homebridge = installHomebridge(createFakeHomebridge());

    const orchestrator = new webUiFeatureOptions();

    // The orchestrator exposes editedConfig (assignable) and keeps the cached elements internal. We verify indirectly: instantiation succeeds, editedConfig starts
    // empty, and the skeleton's mount points are the ones the orchestrator will later read from.
    assert.deepEqual(orchestrator.editedConfig, [], "fresh orchestrator starts with an empty editedConfig array");
    assert.ok(skeleton.configTable, "skeleton configTable was created by the fixture");
  });

  test("merges caller-supplied sidebar / ui options with the defaults", () => {

    // The constructor destructures the options and merges `sidebar` and `ui` over the defaults. We verify the merge behavior by passing a partial config and
    // asserting downstream consumers (the nav section header, the validator set) see the merged values.
    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    using _homebridge = installHomebridge(createFakeHomebridge());

    const isController = (device) => device.serialNumber?.startsWith("CTRL-") ?? false;

    const orchestrator = new webUiFeatureOptions({

      sidebar: { controllerLabel: "Network Controllers" },
      ui: { isController }
    });

    // Verify the orchestrator was constructed successfully. The merged values are stored privately; downstream tests (show + nav) verify the merge produced the
    // expected behavior.
    assert.ok(orchestrator, "constructor must produce an instance even when only sidebar / ui options are supplied");
    assert.deepEqual(orchestrator.editedConfig, []);
  });
});

describe("webUiFeatureOptions.show - global options render", () => {

  test("show() sets up the page, reads the config, and renders every category's options at global scope", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Post-show: the feature options page is visible, the support page is hidden.
    assert.equal(skeleton.pageFeatureOptions.style.display, "block", "feature options page must be visible after show()");
    assert.equal(skeleton.pageSupport.style.display, "none", "support page must be hidden");

    // The config table carries a `<details>` per category. Under the global view (no controllers configured), every category renders. Per the lazy-rendering
    // contract, only the headers + empty rows containers are present after show() - rows materialize on category expand or on bulk activation (search / filter
    // / toggle-all).
    const categoryDetails = skeleton.configTable.querySelectorAll("details[data-category]");

    assert.equal(categoryDetails.length, FEATURES.categories.length, "one details element per category when rendering global options");

    // Before any expand, the rows containers are empty - the row materialization is deferred.
    for(const details of categoryDetails) {

      assert.equal(details.querySelector(".fo-category-rows").children.length, 0, "lazy contract: rows are not materialized until a category is expanded");
    }

    // Every category disclosure must be visible. The search component's projection-driven visibility derives "is this category visible right now?" from the
    // model walk, not from the count of materialized rows. Asserting `display !== "none"` here pins that visibility is a projection of the model, robust to any
    // future change in the row-materialization timing: an empty rows container under lazy rendering must never cause a category to be hidden.
    for(const details of categoryDetails) {

      assert.notEqual(details.style.display, "none",
        "category must be visible under lazy rendering - visibility is a projection of the model, not a count of materialized rows");
    }

    // Expand each category to drive the lazy-materialization path. The native `<summary>` click triggers Happy-DOM's built-in details-toggle behavior, which
    // fires the `toggle` event the options view's capture-phase handler listens for; that handler materializes the expanded category's rows synchronously, so the
    // rows appear before the assertions below.
    for(const details of categoryDetails) {

      clickCategoryHeader(details);
    }

    assert.ok(skeleton.configTable.querySelector("[id='row-Motion.Detect']"), "Motion.Detect row must be rendered after expanding the Motion category");
    assert.ok(skeleton.configTable.querySelector("[id='row-Audio.Volume']"), "Audio.Volume row must be rendered after expanding the Audio category");

    orchestrator.cleanup();
  });

  test("show() reveals every region container as part of the coordinated end-of-load reveal", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // After a successful show(), revealRegions() is the sole gate that reveals every region container it lists - content is built and scoped first, then revealed
    // in one coordinated pass. This pins the orchestrator-owns-reveal contract end-to-end: dropping any region from revealRegions (or leaving one hidden) fails
    // here, and it complements the per-view "does not self-reveal" tests that guard the other direction (a view revealing prematurely).
    for(const id of [ "deviceStatsContainer", "headerInfo", "optionsContainer", "search", "sidebar" ]) {

      assert.equal(document.getElementById(id).style.display, "", id + " must be revealed after a successful show()");
    }

    orchestrator.cleanup();
  });

  test("show() requests the /getOptions endpoint from homebridge to discover the option catalog", async () => {

    // The orchestrator pulls the categories/options from homebridge.request("/getOptions"). We seed the response and verify the rendered DOM reflects it - the
    // request was consulted, not some other source.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const customFeatures = {

      categories: [{ description: "Solo", name: "Solo" }],
      options: { Solo: [{ default: true, description: "Solo option.", name: "Knob" }] }
    };

    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", customFeatures ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // The rendered UI reflects the custom features, not the default FEATURES fixture - proof the /getOptions response was honored.
    const tables = skeleton.configTable.querySelectorAll("details[data-category]");

    assert.equal(tables.length, 1, "exactly one category from the custom /getOptions response");
    assert.equal(tables[0].getAttribute("data-category"), "Solo");

    // Expand the category so the lazy row materialization runs and the option row appears in the DOM.
    clickCategoryHeader(tables[0]);

    assert.ok(skeleton.configTable.querySelector("[id='row-Solo.Knob']"));

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions.show - config re-sync on entry (Settings -> FO reconciliation)", () => {

  // show() is the single entry chokepoint, so it re-reads the host config through the session before rendering. These tests pin that "every show is fresh"
  // guarantee: an edit made in the Settings tab while the page was hidden is reflected on the next show() rather than rendering against a frozen open()-time snapshot.

  test("re-reads the host config on every show() so getControllers and the options render reflect an external edit made while hidden", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    // Start with a controller-mode plugin holding one option. getControllers captures the config it is handed on each show() so we can prove it saw the re-read
    // platform rather than the open()-time snapshot.
    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Enable.Audio.Volume.50"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const seenPlatforms = [];
    const orchestrator = new webUiFeatureOptions({

      getControllers: ({ config }) => {

        seenPlatforms.push(config);

        return [{ name: "Hub", serialNumber: "CTRL-1" }];
      }
    });

    const session = await openTestSession();

    await orchestrator.show(session);
    await flush();

    assert.deepEqual(seenPlatforms.at(-1).options, ["Enable.Audio.Volume.50"], "the first show() must hand getControllers the open()-time config");

    // Simulate a Settings-tab edit landing in the host's in-memory config while the page is hidden: reassign to a NEW array (an in-place mutation would be vacuous,
    // since session.platform aliases the previously-read reference). Then re-enter via show() against the SAME session - exactly the menu/retry re-entry path.
    fake.config = makePluginConfig({ options: ["Disable.Motion.Detect"] });

    await orchestrator.show(session);
    await flush();

    // The re-read landed before getControllers ran: the platform it saw on the second show() carries the externally edited options.
    assert.deepEqual(seenPlatforms.at(-1).options, ["Disable.Motion.Detect"], "the second show() must re-sync and hand getControllers the externally edited config");

    // And the ordering is observable on the host call log: each show() reads the config (getPluginConfig) before any render-side work. Two shows means at least two
    // reads (one at open(), one per show()), and the most recent read precedes the second render's getControllers capture.
    assert.ok(fake.observed.calls.filter((c) => c === "getPluginConfig").length >= 2, "each show() must re-read the host config via getPluginConfig");

    orchestrator.cleanup();
  });

  test("a getPluginConfig failure during the show() re-sync surfaces a toast and bails without rendering", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Enable.Audio.Volume.50"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();
    const session = await openTestSession();

    await orchestrator.show(session);
    await flush();

    // The next config read fails (the host dropped the connection between visits). Make the re-sync reject on the upcoming show().
    fake.getPluginConfig = async () => { throw new Error("host read failed"); };

    await orchestrator.show(session);
    await flush();

    // The failure surfaced as an error toast, and show() bailed before the page abort controller / render.
    const errorToasts = fake.observed.toasts.filter((t) => t.variant === "error");

    assert.ok(errorToasts.some((t) => t.message === "host read failed"), "a re-sync read failure must surface as an error toast");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions.show - a controller click racing the initial device fetch", () => {

  // The staleness contract end-to-end: the reducer's fetch sequence is the fetch identity, so a controller click made while show()'s own initial fetch is still in
  // flight owns the store, and show()'s superseded outcome neither reveals the page over the click's state nor overwrites its scope. The initial controller's fetch is
  // gated so it stays parked while the click's (ungated) fetch resolves and applies; releasing the initial fetch afterward exercises the reducer dropping the stale
  // outcome and show() gating its follow-ups on `devicesAppliedSeq`.
  test("a controller click during the initial fetch wins - show()'s superseded outcome neither reveals over it nor overwrites its scope", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    let releaseInitial;
    const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
    const deviceA = { firmwareRevision: "1.0", manufacturer: "Acme", model: "Hub", name: "Device A", serialNumber: "DEV-A" };
    const deviceB = { firmwareRevision: "1.0", manufacturer: "Acme", model: "Hub", name: "Device B", serialNumber: "DEV-B" };
    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [ { name: "Hub A", serialNumber: "CTRL-A" }, { name: "Hub B", serialNumber: "CTRL-B" } ],
      getDevices: async (controller) => {

        // CTRL-A is the initial controller: park its fetch on the gate so it is still in flight when the CTRL-B click lands. CTRL-B resolves immediately.
        if(controller?.serialNumber === "CTRL-A") {

          await initialGate;

          return { devices: [deviceA], error: "" };
        }

        return { devices: [deviceB], error: "" };
      }
    });

    // Start show() without awaiting it to completion: it mounts the nav (model:loaded + mountViews) and then parks awaiting the gated CTRL-A fetch. The nav renders the
    // controller links even while the regions stay hidden, so CTRL-B is clickable.
    const showPromise = orchestrator.show(await openTestSession());
    const ctrlBLink = await waitFor(() => skeleton.controllersContainer.querySelector("[data-navigation='controller'][data-device-serial='CTRL-B']"),
      { message: "the nav must mount the CTRL-B link while the initial fetch is gated" });

    ctrlBLink.click();
    await flush();

    // The click's outcome applied: the sidebar shows CTRL-B's device and highlights it.
    assert.ok(skeleton.devicesContainer.querySelector("[data-device-serial='DEV-B']"), "the click's device (DEV-B) must render in the sidebar");
    assert.equal(skeleton.devicesContainer.querySelector(".nav-link.active")?.getAttribute("data-device-serial"), "DEV-B",
      "the click's controller-as-device scope must be the active selection");

    // Release the initial CTRL-A fetch. Its outcome carries the superseded sequence, so the reducer drops it and show() returns on the `devicesAppliedSeq` gate.
    releaseInitial();
    await showPromise;
    await flush();

    // show()'s stale outcome never landed: DEV-A did not render, DEV-B still owns the sidebar and the selection, and the reveal bailed (the sidebar stays hidden
    // because show() returned before revealRegions - the click owns presentation, not the superseded initial flow).
    assert.equal(skeleton.devicesContainer.querySelector("[data-device-serial='DEV-A']"), null, "show()'s superseded outcome must not render its device (DEV-A)");
    assert.ok(skeleton.devicesContainer.querySelector("[data-device-serial='DEV-B']"), "the click's device must remain after the stale outcome dropped");
    assert.equal(skeleton.devicesContainer.querySelector(".nav-link.active")?.getAttribute("data-device-serial"), "DEV-B",
      "show()'s initial scope dispatch must not overwrite the click's selection");
    assert.equal(skeleton.sidebar.style.display, "none", "the reveal bail: show() returned before revealRegions on its superseded outcome");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions.show - progressive disclosure (no overlay spinner)", () => {

  // The orchestrator does not raise a global spinner overlay during show(). The synchronous page-shell transition (revealing `pageFeatureOptions`, hiding
  // `pageSupport`) is the user feedback for "your click was registered"; the async work that follows populates each region against the visible shell so the user
  // perceives the UI filling in progressively rather than "spinner, then everything at once." The spinner-count assertion is the operational pin for this contract.
  test("show() does not raise the global homebridge spinner overlay - each region populates against the visible page-shell", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    assert.equal(fake.observed.state.spinnerCount, 0,
      "show() must not raise or leave the spinner up - the page-shell transition is the user feedback, regions populate against the visible shell");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions.hide", () => {

  test("hide() removes the feature-options page from view without destroying the orchestrator state", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();

    using _homebridge = installHomebridge(createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    }));

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Sanity: we are on the feature-options page.
    assert.equal(skeleton.pageFeatureOptions.style.display, "block");

    // hide() is async (it flushes any pending edit before tearing down), so we await it - a fire-and-forget call would let its post-await continuation run after the
    // test ends and the Happy-DOM document is torn down.
    await orchestrator.hide();

    // hide() leaves the orchestrator instance itself intact - only the rendered view is torn down.
    assert.ok(orchestrator, "the orchestrator instance must survive a hide() call");
    assert.deepEqual(orchestrator.editedConfig, makePluginConfig(), "hide() does not clear the cached editedConfig");

    orchestrator.cleanup();
  });

  test("hide() resolves within the teardown cap even when the host write never settles (no-hang guarantee)", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();

    // The host's updatePluginConfig never settles - the exact stall the bounded flush guards against (updatePluginConfig takes no AbortSignal, so a hung write cannot
    // be cancelled). hide() must still resolve via the FLUSH_TEARDOWN_TIMEOUT_MS race rather than hanging on the stalled write forever.
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    fake.updatePluginConfig = () => new Promise(() => {});

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Stage a pending edit so hide()'s flush has something to drain (and thus something to block on if the cap did not exist). Expand Motion, toggle Detect off.
    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const checkbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    // hide() now flushes; the flush drain commits via the never-settling updatePluginConfig. Time the awaited hide(): it must resolve near the teardown cap (2000ms),
    // NOT hang indefinitely. We allow generous headroom over the 2000ms cap for the debounce + scheduling, while staying well under the 15s test timeout that a true
    // hang would hit.
    const startedAt = Date.now();

    await orchestrator.hide();

    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 5000, "hide() must resolve via the teardown cap rather than hanging on the stalled host write");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions.cleanup", () => {

  test("cleanup() is safe before show() is called (no prior render to tear down)", () => {

    // Defensive: orchestrator teardown may run before any render has happened, for example when the first-run flow aborts. cleanup must not throw.
    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    using _homebridge = installHomebridge(createFakeHomebridge());

    const orchestrator = new webUiFeatureOptions();

    assert.doesNotThrow(() => orchestrator.cleanup());
  });

  test("cleanup() is a no-op on repeat - repeated calls are safe", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    using _homebridge = installHomebridge(createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    }));

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    assert.doesNotThrow(() => orchestrator.cleanup());
    assert.doesNotThrow(() => orchestrator.cleanup(), "second cleanup must not throw on already-torn-down state");
  });
});

describe("webUiFeatureOptions disposal (Symbol.dispose / Symbol.asyncDispose)", () => {

  test("[Symbol.asyncDispose] flushes a debounced-but-unwritten edit before tearing down", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Stage a pending edit: expand Motion, toggle Detect off. The edit enters the persist effect's 300ms debounce and is NOT yet committed. We deliberately do NOT
    // settle the debounce, so the only path by which the edit can reach the host is the async disposer's flush.
    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const checkbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    // The async disposer (the `await using` scope-exit path) must drain the pending edit to the host before aborting the page signal.
    await orchestrator[Symbol.asyncDispose]();

    const lastUpdate = fake.observed.updatedConfigs.at(-1);

    assert.ok(lastUpdate, "[Symbol.asyncDispose] must flush the pending edit to homebridge.updatePluginConfig");
    assert.ok(lastUpdate[0]?.options?.includes("Disable.Motion.Detect"),
      "the flushed config must carry the Disable.Motion.Detect entry the pending edit produced");
  });

  test("[Symbol.dispose] forfeits the flush - a debounced-but-unwritten edit is dropped (forced-teardown trade)", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Same pending edit as above, still inside the debounce window.
    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const checkbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    const committedBefore = fake.observed.updatedConfigs.length;

    // Synchronous disposal aborts the page signal WITHOUT flushing. The persist debounce is bound to that signal, so the abort cancels it and the drain bails before
    // committing. This is the documented forced-teardown trade the async disposer above exists to avoid.
    orchestrator[Symbol.dispose]();

    // Give any (incorrectly) surviving debounce a full window to fire; the edit must NOT reach the host.
    await settlePersist();

    assert.equal(fake.observed.updatedConfigs.length, committedBefore,
      "[Symbol.dispose] must not flush - the debounced edit is dropped when the page signal aborts");
  });
});

describe("webUiFeatureOptions.getHomebridgeDevices", () => {

  test("reads the cached accessories from homebridge and normalizes each into the device shape", async () => {

    // The default device source is `homebridge.getCachedAccessories()`. This test seeds the fake with a representative accessory shape and verifies the orchestrator's
    // default reader normalizes it into the { firmwareRevision, manufacturer, model, name, serialNumber } shape the sidebar consumes.
    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const cachedAccessory = makeCachedAccessory({

      displayName: "Kitchen Cam",
      firmwareRevision: "1.2.3",
      manufacturer: "Acme Corp",
      model: "K100",
      serialNumber: "SN-001"
    });

    using _homebridge = installHomebridge(createFakeHomebridge({ cachedAccessories: [cachedAccessory] }));

    const orchestrator = new webUiFeatureOptions();
    const { devices, error } = await orchestrator.getHomebridgeDevices();

    assert.equal(error, "", "the device-only default resolves a rich shape carrying an empty error");
    assert.equal(devices.length, 1, "one accessory must produce one device");
    assert.equal(devices[0].name, "Kitchen Cam", "displayName maps to the device name");
    assert.equal(devices[0].serialNumber, "SN-001", "the serial-number characteristic value propagates to the device");
    assert.equal(devices[0].manufacturer, "Acme Corp");
    assert.equal(devices[0].model, "K100");
    assert.equal(devices[0].firmwareRevision, "1.2.3");
  });

  test("sorts accessories alphabetically by display name (case-insensitive)", async () => {

    // The orchestrator applies a case-insensitive localeCompare sort before returning the device list. This provides a consistent sidebar ordering even when the
    // cache returns accessories in insertion or discovery order.
    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const accessories = [

      makeCachedAccessory({ displayName: "zebra", serialNumber: "SN-Z" }),
      makeCachedAccessory({ displayName: "Apple", serialNumber: "SN-A" }),
      makeCachedAccessory({ displayName: "banana", serialNumber: "SN-B" })
    ];

    using _homebridge = installHomebridge(createFakeHomebridge({ cachedAccessories: accessories }));

    const orchestrator = new webUiFeatureOptions();
    const { devices } = await orchestrator.getHomebridgeDevices();

    assert.deepEqual(devices.map((d) => d.name), [ "Apple", "banana", "zebra" ],
      "devices must be sorted case-insensitively by display name");
  });

  test("returns an empty array when no accessories are cached", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    using _homebridge = installHomebridge(createFakeHomebridge({ cachedAccessories: [] }));

    const orchestrator = new webUiFeatureOptions();
    const { devices, error } = await orchestrator.getHomebridgeDevices();

    assert.deepEqual(devices, [], "empty cache produces an empty device list");
    assert.equal(error, "", "the device-only default resolves a rich shape carrying an empty error");
  });
});

describe("webUiFeatureOptions - no-controllers short circuit", () => {

  test("when getControllers is provided and returns empty, show() displays the no-controllers message and hides the spinner", async () => {

    // Controller-mode plugins cannot display any options without at least one controller - the error path must surface a message, hide the spinner, and NOT try to
    // render a sidebar. We verify the orchestrator routes to that path when getControllers returns []. The sidebar region will contain a message element rather than
    // controller / device links.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();

    using _homebridge = installHomebridge(createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    }));

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions({

      getControllers: async () => []
    });

    await orchestrator.show(await openTestSession());
    await flush();

    // No config table rows and no sidebar nav links - the error path short-circuited before any rendering.
    assert.equal(skeleton.configTable.querySelectorAll("details[data-category]").length, 0,
      "the no-controllers path must not render any category tables");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - config persistence", () => {

  test("changing an option value and persisting the config reflects the new option entry in the homebridge updatePluginConfig record", async () => {

    // End-to-end: user toggles an option, the options view dispatches an option mutation (option:set / option:cleared); the reducer recomputes configuredOptions and
    // the persist effect drains it to homebridge.updatePluginConfig. We seed a clean config, render, simulate a checkbox toggle + change event, and assert the
    // captured update contains the new option.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Expand the Motion category to materialize its rows under the lazy-rendering contract, then simulate the user toggling Motion.Detect to unchecked at global
    // scope. First verify the row exists, then fire the change event the orchestrator's delegation is listening for.
    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const motionCheckbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    assert.ok(motionCheckbox, "Motion.Detect checkbox must be rendered");
    assert.equal(motionCheckbox.checked, true, "default-on checkbox starts checked");

    motionCheckbox.checked = false;
    motionCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    await settlePersist();

    // The orchestrator should have persisted the change. `observed.updatedConfigs` collects every updatePluginConfig call on the fake bridge.
    assert.ok(fake.observed.updatedConfigs.length > 0, "toggling a checkbox must produce at least one updatePluginConfig call");

    const lastUpdate = fake.observed.updatedConfigs.at(-1);

    assert.ok(Array.isArray(lastUpdate));
    assert.ok(lastUpdate[0]?.options?.includes("Disable.Motion.Detect"),
      "disabling the default-on Motion.Detect must emit a Disable.Motion.Detect entry in the persisted options");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - reset and revert flows", () => {

  // Two destructive user actions live on the status bar: "Reset to Defaults" wipes every configured option, returning the model to its declared defaults; "Revert
  // to Saved" rolls back any in-session edits to the configuredOptions snapshot taken at show() time. Both run as event-delegated clicks on the reset button group
  // and must persist via homebridge.updatePluginConfig, refresh the rendered view, and surface a toast acknowledging the action.

  test("clicking the reset-defaults button wipes every configured option and persists the empty list", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: [ "Disable.Motion.Detect", "Enable.Audio.Volume.75" ] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // The reset button group lives in the search status bar. The primary "Reset..." button is data-action="reset-toggle" and reveals "Reset to Defaults" / "Revert
    // to Saved" when clicked. We invoke the user flow as the orchestrator's event delegation sees it.
    const resetToggle = document.querySelector("button[data-action='reset-toggle']");

    assert.ok(resetToggle, "the reset-toggle button must be rendered into the status bar");

    resetToggle.click();
    await flush();

    const resetDefaults = document.querySelector("button[data-action='reset-defaults']");

    assert.ok(resetDefaults, "the reset-defaults button must reveal after the toggle click");

    resetDefaults.click();
    await settlePersist();

    // The flow mutates the model, re-renders, and schedules a persist of the empty options array via the drain. Reset/revert emit no separate success toast: a
    // toast could claim "done" before the persist confirms under coalescing, so the visible UI change (configTable cleared) is the user's sole confirmation.
    // Failure surfaces via the drain's runDetached toast.
    const lastUpdate = fake.observed.updatedConfigs.at(-1);

    assert.ok(lastUpdate, "reset-defaults must produce at least one updatePluginConfig call");
    assert.deepEqual(lastUpdate[0].options, [], "reset-defaults must persist an empty options array");

    orchestrator.cleanup();
  });

  test("clicking the reset-revert button restores the at-show() snapshot, discarding in-session edits", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Enable.Audio.Volume.50"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Expand the Motion category to materialize its rows under the lazy-rendering contract, then perform the in-session edit: toggle Motion.Detect off, which adds
    // Disable.Motion.Detect to the persisted options.
    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const motionCheckbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    motionCheckbox.checked = false;
    motionCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settlePersist();

    // Sanity check: the edit landed in a persisted update.
    assert.ok(fake.observed.updatedConfigs.some((cfg) => cfg[0].options.includes("Disable.Motion.Detect")),
      "the in-session toggle must have produced an intermediate persisted update");

    // Open the reset group, then click "Revert to Saved".
    document.querySelector("button[data-action='reset-toggle']").click();
    await flush();

    document.querySelector("button[data-action='reset-revert']").click();
    await settlePersist();

    const lastUpdate = fake.observed.updatedConfigs.at(-1);

    assert.deepEqual(lastUpdate[0].options, ["Enable.Audio.Volume.50"],
      "revert must restore the configuredOptions snapshot captured at the initial show()");

    // No success toast on revert (or reset) - the visible UI change (Motion.Detect's row snapping back to its default-checked state) IS the user's confirmation,
    // and removing the toast eliminates the "toast claims done before persist confirms" honesty hole that an awaited-gating approach would re-introduce.

    orchestrator.cleanup();
  });

  test("reset-toggle alone (without choosing a destructive action) does not persist any change", async () => {

    // The reveal-and-cancel ergonomic. Clicking the toggle, then clicking it again (collapsing back), should leave the persisted config untouched. We use the
    // observed.updatedConfigs count as the witness.
    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Enable.Audio.Volume.50"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    const updatesBefore = fake.observed.updatedConfigs.length;
    const resetToggle = document.querySelector("button[data-action='reset-toggle']");

    resetToggle.click();
    await flush();

    // Click the same toggle again to collapse the reveal.
    resetToggle.click();
    await flush();

    assert.equal(fake.observed.updatedConfigs.length, updatesBefore,
      "no destructive action chosen; the persisted config must be untouched");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - device info panel", () => {

  test("the default device-info renderer populates the panel for a specific device view", async () => {

    // The default info-panel handler reads firmware/manufacturer/model/serial off the device and renders a stats grid. We exercise it by setting up a controller-mode
    // orchestrator (where device views are first-class), navigating into the controller view, then asserting the panel is populated.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [{ name: "Hub", serialNumber: "CTRL-1" }],
      getDevices: () => ({ devices: [{ firmwareRevision: "1.2.3", manufacturer: "Acme", model: "C100", name: "Hub", serialNumber: "CTRL-1" }], error: "" })
    });

    await orchestrator.show(await openTestSession());
    await flush();

    // The orchestrator landed on the controller's device view by default - the panel should carry the device's metadata.
    const panelText = skeleton.deviceStatsContainer.textContent;

    assert.match(panelText, /1\.2\.3/, "panel must include the firmware revision");
    assert.match(panelText, /Acme/, "panel must include the manufacturer");
    assert.match(panelText, /C100/, "panel must include the model");
    assert.match(panelText, /CTRL-1/, "panel must include the serial number");

    orchestrator.cleanup();
  });

  test("the default device-info renderer clears the panel when navigated to Global Options", async () => {

    // After populating the panel with a device, navigating to Global Options must clear it. Clicking the Global link dispatches scope:changed with kind "global" - the
    // typed sentinel for "no device, global scope" - and the device-info view's scope subscription re-renders with selectedDevice undefined (no device matches a
    // global scope), driving the clear-panel branch of the default handler.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [{ name: "Hub", serialNumber: "CTRL-1" }],
      getDevices: () => ({ devices: [{ firmwareRevision: "1.0", manufacturer: "Acme", model: "C100", name: "Hub", serialNumber: "CTRL-1" }], error: "" })
    });

    await orchestrator.show(await openTestSession());
    await flush();

    assert.ok(skeleton.deviceStatsContainer.textContent.length > 0, "panel starts populated for the controller view");

    skeleton.controllersContainer.querySelector("[data-navigation='global']").click();
    await flush();

    assert.equal(skeleton.deviceStatsContainer.textContent, "", "global-options view must clear the device-stats panel");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - detached-operation error contract", () => {

  // Option persistence is fire-and-forget: a checkbox change dispatches an option mutation that the persist effect's coalescing drain writes to disk via
  // session.commit (homebridge.updatePluginConfig). A final failure with no superseding mutation dispatches persist:failed - the reducer rolls configuredOptions
  // back to the persisted anchor - and the effect surfaces the error through the host's single "config-persist" toast channel. When the page signal has aborted
  // (lifecycle teardown), the drain bails before dispatching or toasting, so a teardown-shaped failure stays silent. These tests pin both branches by rejecting
  // the fake's updatePluginConfig.

  test("a regular Error rejected by updatePluginConfig surfaces as a user-facing toast labelled with the operation", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });
    const failure = new Error("simulated plugin-config-store fault");

    fake.updatePluginConfig = async () => {

      throw failure;
    };

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Snapshot the toast log AFTER show() so the assertion only sees the rejection we induce, not anything the boot path may have toasted.
    const toastsBefore = fake.observed.toasts.length;

    // Expand the Motion category, then toggle the Motion.Detect checkbox to dispatch an option mutation, which the persist effect's drain writes via updatePluginConfig.
    document.querySelector("details[data-category='Motion'] summary").click();

    const motionCheckbox = document.querySelector("[id='Motion.Detect']");

    motionCheckbox.checked = false;
    motionCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    await settlePersist();

    const induced = fake.observed.toasts.slice(toastsBefore);

    assert.equal(induced.length, 1, "exactly one toast must surface the rejection");
    assert.equal(induced[0].variant, "error", "the toast must be an error variant - users distinguish error toasts from informational ones");
    assert.equal(induced[0].message, failure.message, "the toast message must carry the original error.message for the user");
    assert.equal(induced[0].title, "config-persist", "the toast title must name the failing operation so the user sees which action did not complete");

    orchestrator.cleanup();
  });

  test("an AbortError rejected by updatePluginConfig is absorbed silently (lifecycle teardown is expected)", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    fake.updatePluginConfig = async () => {

      // DOMException with name "AbortError" is the canonical shape thrown by signal-aware browser primitives. The helper's name check matches on this.
      throw new DOMException("operation aborted", "AbortError");
    };

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    const toastsBefore = fake.observed.toasts.length;

    document.querySelector("details[data-category='Motion'] summary").click();

    const motionCheckbox = document.querySelector("[id='Motion.Detect']");

    motionCheckbox.checked = false;
    motionCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    await flush();

    assert.equal(fake.observed.toasts.length, toastsBefore, "an AbortError rejection must be absorbed silently - no toast emitted");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - optimistic-apply + rollback-on-failure for persistence", () => {

  // Every mutation path (checkbox toggle, reset-to-defaults, revert-to-saved) applies optimistically by dispatching an option mutation, and the persist effect awaits
  // the host write through the session's commit seam. On a final-attempt failure the effect dispatches persist:failed, which the reducer rolls back by restoring
  // configuredOptions to the last-persisted anchor; the editedConfig view (derived from the session) follows it, and the failure surfaces via the host's toast channel.

  test("a failed checkbox-change persist rolls back the model to the pre-mutation snapshot", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Enable.Audio.Volume"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    fake.updatePluginConfig = async () => {

      throw new Error("simulated persistence failure");
    };

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Pre-condition: the at-show() configuredOptions snapshot. We toggle a checkbox; the persistence will fail; the rollback should restore this exact array.
    const preMutationOptions = [...orchestrator.editedConfig[0].options];

    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const motionCheckbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    motionCheckbox.checked = false;
    motionCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    await settlePersist();

    assert.deepEqual(orchestrator.editedConfig[0].options, preMutationOptions,
      "rollback must restore editedConfig.options to the pre-mutation snapshot after persistence fails");

    orchestrator.cleanup();
  });

  test("a failed reset-to-defaults persist rolls back the model to the pre-reset snapshot", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: [ "Disable.Motion.Detect", "Enable.Audio.Volume.75" ] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    const preMutationOptions = [...orchestrator.editedConfig[0].options];

    // Now make persistence fail. The next reset will hit the rollback path.
    fake.updatePluginConfig = async () => {

      throw new Error("simulated persistence failure during reset");
    };

    document.querySelector("button[data-action='reset-toggle']").click();
    await flush();

    document.querySelector("button[data-action='reset-defaults']").click();
    await settlePersist();

    assert.deepEqual(orchestrator.editedConfig[0].options, preMutationOptions,
      "rollback must restore the pre-reset configuredOptions after persistence fails - the destructive action is fully reversed");

    orchestrator.cleanup();
  });

  test("a failed revert-to-saved persist rolls back the model to the in-session edited state", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Enable.Audio.Volume.50"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // In-session edit: toggle Motion.Detect off via the orchestrator's event delegation so the persist completes and the in-session state is committed in memory.
    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const motionCheckbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    motionCheckbox.checked = false;
    motionCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settlePersist();

    const inSessionOptions = [...orchestrator.editedConfig[0].options];

    assert.ok(inSessionOptions.includes("Disable.Motion.Detect"),
      "pre-condition: the in-session edit was persisted to editedConfig before the revert attempt");

    // Make the revert's persist fail. The rollback should restore inSessionOptions (the user's mid-session state).
    fake.updatePluginConfig = async () => {

      throw new Error("simulated persistence failure during revert");
    };

    document.querySelector("button[data-action='reset-toggle']").click();
    await flush();

    document.querySelector("button[data-action='reset-revert']").click();
    await settlePersist();

    assert.deepEqual(orchestrator.editedConfig[0].options, inSessionOptions,
      "rollback must restore the in-session edits when revert-to-saved fails - the user's pre-revert state is preserved");

    orchestrator.cleanup();
  });

  // Pinning the masterclass property of the drain: concurrent mutations cannot cause memory/disk divergence. The drain serializes persists and coalesces in-flight
  // dirty state, so if an earlier persist fails but a subsequent one succeeds, the user's intent reaches disk and no rollback fires - the drain swallows the
  // intermediate failure because a superseding iteration is pending. This is the property the per-mutation rollback pattern could NOT provide.
  test("concurrent mutations preserve both intents on disk when the earlier persist fails but the later succeeds", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();
    skeleton.configTable.querySelector("details[data-category='Audio'] summary").click();

    // Install a controllable persistence: the first call awaits a gate (so we can interleave a second mutation), then fails. The second call resolves normally.
    // Each call records its payload to `observed.updatedConfigs` BEFORE the await so the test can assert what each iteration tried to persist.
    let resolveFirst;
    const firstPersist = new Promise((resolve) => { resolveFirst = resolve; });
    let callCount = 0;

    fake.updatePluginConfig = async (next) => {

      callCount += 1;
      fake.observed.updatedConfigs.push(structuredClone(next));

      if(callCount === 1) {

        await firstPersist;

        throw new Error("simulated transient persistence failure");
      }
    };

    // Mutation A: toggle Motion.Detect off. This fires the drain; the first persist call hangs on `firstPersist` (we wait past the debounce window so the call
    // actually fires, then proceed with the second mutation).
    const motionCheckbox = skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    motionCheckbox.checked = false;
    motionCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait past the debounce so the first updatePluginConfig call actually fires (and hangs on firstPersist).
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Mutation B: while the first persist is still hanging, toggle Audio.Volume on. The drain's dirty flag is now set; the in-flight iteration will fail, but
    // the drain will iterate again with the combined state instead of rolling back.
    const audioCheckbox = skeleton.configTable.querySelector("[id='row-Audio.Volume'] input[type='checkbox']");

    audioCheckbox.checked = true;
    audioCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    // Toast surface BEFORE we release the failing persist - we want to confirm at the end that NO toast fired despite the intermediate failure.
    const toastsBeforeRelease = fake.observed.toasts.length;

    // Release the first persist (which fails). The drain catches, sees dirty=true, swallows the error, and iterates again with the combined state. The second
    // iteration debounces again before issuing its persist, so we wait past that window plus the resolve.
    resolveFirst();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Assert: both mutations reached disk, no rollback, no toast. The drain's superseding iteration carried Audio.Volume forward. The Audio.Volume entry carries
    // its defaultValue suffix ("Enable.Audio.Volume.50") so the assertion uses a prefix match.
    const lastPersisted = fake.observed.updatedConfigs.at(-1)?.[0]?.options ?? [];

    assert.ok(lastPersisted.includes("Disable.Motion.Detect"),
      "the final persist must include the Motion.Detect toggle - the drain carried it forward through the failed first iteration");
    assert.ok(lastPersisted.some((entry) => entry.startsWith("Enable.Audio.Volume")),
      "the final persist must include the Audio.Volume toggle - the drain coalesced both mutations into the superseding iteration");

    assert.deepEqual(orchestrator.editedConfig[0].options, lastPersisted,
      "memory must match disk - the drain's anchor update on success keeps memory and disk in lockstep");

    assert.equal(fake.observed.toasts.length, toastsBeforeRelease,
      "no toast must fire for the intermediate failure - a later successful persist supersedes it and the user's intent was preserved");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - signal-aware fire-and-forget tails", () => {

  // Fire-and-forget persistence runs through the persist effect's coalescing drain, which holds the page-level abort signal (#pageAbort.signal) and re-checks it after
  // each await. A cleanup() that races with the async drain aborts that signal, so the post-await work bails rather than dispatching against a torn-down view. These
  // tests pin that contract by interleaving cleanup() between a destructive action and the underlying I/O's resolution.

  test("cleanup() during a reset whose persist fails suppresses the rollback's re-render", async () => {

    // The signal-aware guard lives in the drain's failure path: when a persist fails AND no superseding mutation is pending, the drain re-checks the page signal
    // before dispatching persist:failed (the action the reducer turns into a rollback of configuredOptions to persistedAnchor, which the options view re-renders). A
    // cleanup() during the in-flight persist marks the page aborted, so the drain returns without dispatching - the orchestrator does not touch a torn-down DOM. This
    // test pins that contract by pausing the persist, cleanup()ing while it's in flight, then releasing it as a rejection. The observable: no re-render happens after
    // cleanup, so configTable stays cleared.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Disable.Motion.Detect"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    // Pause-then-fail updatePluginConfig. The pause lets us interleave cleanup() between the persist starting and its failure.
    let releaseUpdate;
    const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });

    fake.updatePluginConfig = async () => {

      await updateGate;

      throw new Error("simulated persistence failure mid-cleanup");
    };

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // Open the reset group, then click reset-defaults. The drain starts, the persist hangs on the gate.
    document.querySelector("button[data-action='reset-toggle']").click();
    await flush();
    document.querySelector("button[data-action='reset-defaults']").click();
    await flush();

    // Cleanup mid-flight. The page signal aborts. The drain's persist is still hanging.
    orchestrator.cleanup();

    // Capture the configTable state right after cleanup. cleanup() routes through hide() which leaves the configTable empty.
    const childCountAfterCleanup = skeleton.configTable.children.length;

    // Release the paused persist as a failure. The drain catches, sees no superseding mutation, then re-checks the aborted page signal and returns before dispatching
    // persist:failed - so no rollback re-render fires. The configTable must stay exactly as cleanup() left it.
    releaseUpdate();
    await flush();

    assert.equal(skeleton.configTable.children.length, childCountAfterCleanup,
      "rollback's signal-aborted guard must prevent re-rendering after cleanup - the configTable stays exactly as cleanup left it");
  });

  test("cleanup() mid-controller-nav prevents devices:loaded from landing after the page tears down", async () => {

    // The nav-click path optimistically dispatches scope:changed before calling getDevices, then dispatches devices:loaded once the fetch resolves. The async tail
    // (devices:loaded) must NOT fire after cleanup: that would mutate state on a torn-down store and could re-trigger view subscriptions against detached DOM.
    // Pause getDevices via the fake, run cleanup, release the fetch, verify no devices landed.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    let pauseNextDevicesFetch = false;
    let releaseDevices;
    const devicesGate = new Promise((resolve) => {

      releaseDevices = resolve;
    });
    const controllers = [ { name: "Hub A", serialNumber: "CTRL-A" }, { name: "Hub B", serialNumber: "CTRL-B" } ];
    const orchestrator = new webUiFeatureOptions({

      getControllers: async () => controllers,
      getDevices: async (controller) => {

        if(pauseNextDevicesFetch) {

          await devicesGate;
        }

        return {

          devices: [{

            firmwareRevision: "1.0",
            manufacturer: "X",
            model: "Y",
            name: controller?.name ?? "Device",
            serialNumber: controller?.serialNumber ?? ""
          }],
          error: ""
        };
      }
    });

    await orchestrator.show(await openTestSession());
    await flush();

    // Arm the pause AFTER show() has fully resolved so only the click-triggered fetch is gated.
    pauseNextDevicesFetch = true;

    const ctrlBLink = skeleton.controllersContainer.querySelector("[data-navigation='controller'][data-device-serial='CTRL-B']");

    ctrlBLink.click();
    await flush();

    // Cleanup mid-flight. The page signal aborts; the in-flight getDevices fetch's post-await signal-check will bail.
    orchestrator.cleanup();

    // Snapshot devicesContainer's child count before releasing. Any post-cleanup devices:loaded would dispatch through the (now torn-down) store's listeners and
    // could attempt to update the devices container.
    const devicesChildCountBeforeRelease = skeleton.devicesContainer.children.length;

    releaseDevices();
    await flush();

    assert.equal(skeleton.devicesContainer.children.length, devicesChildCountBeforeRelease,
      "post-cleanup devices fetch must not mutate the devices container - the signal-aborted check stopped devices:loaded from dispatching");
  });

  test("cleanup() during a revert whose persist fails suppresses the rollback's re-render", async () => {

    // Same shape as the cleanup-during-reset test - revert routes through the same drain + rollback path, so the same signal-aware guard applies.
    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig({ options: ["Enable.Audio.Volume.50"] }),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    let releaseUpdate;
    const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });

    fake.updatePluginConfig = async () => {

      await updateGate;

      throw new Error("simulated persistence failure mid-cleanup");
    };

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    document.querySelector("button[data-action='reset-toggle']").click();
    await flush();
    document.querySelector("button[data-action='reset-revert']").click();
    await flush();

    orchestrator.cleanup();

    const childCountAfterCleanup = skeleton.configTable.children.length;

    releaseUpdate();
    await flush();

    assert.equal(skeleton.configTable.children.length, childCountAfterCleanup,
      "rollback's signal-aborted guard must prevent re-rendering after cleanup - the configTable stays exactly as cleanup left it");
  });
});

describe("webUiFeatureOptions - revert snapshot survives a re-show with set-equal options", () => {

  // The orchestrator's module-level sameOptionsSet helper compares the current snapshot against the freshly-loaded options at show() time. When the two arrays carry
  // the same set of entries (even reordered), the snapshot is preserved - reordering doesn't represent a "save," so a subsequent revert should still restore the
  // original shape. The observable: after a re-show with re-ordered options, a revert writes the SNAPSHOT order (from the first show), not the loaded order (from the
  // second show).

  test("re-show with set-equal-but-reordered options keeps the original snapshot for revert", async () => {

    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    // Initial config: two configured options in a specific order. Keep a reference to the wrapping array so the test can mutate options between shows - the fake
    // stores it as a closure variable and returns it by reference from getPluginConfig().
    const initialOrder = [ "Enable.Audio.Volume.50", "Disable.Motion.Detect" ];
    const configArray = [{ name: "TestPlugin", options: [...initialOrder], platform: "TestPlugin" }];
    const fake = createFakeHomebridge({

      config: configArray,
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await orchestrator.show(await openTestSession());
    await flush();

    // First show captures the snapshot in initialOrder. Cleanup, then re-show with the SAME set but reversed order.
    orchestrator.cleanup();

    configArray[0].options = [ "Disable.Motion.Detect", "Enable.Audio.Volume.50" ];

    await orchestrator.show(await openTestSession());
    await flush();

    // Trigger a revert. The persisted options after revert reveal which snapshot the orchestrator carried into the second show: initial order (snapshot preserved)
    // or reversed order (snapshot was overwritten).
    const toggleBtn = document.querySelector("button[data-action='reset-toggle']");

    assert.ok(toggleBtn, "reset-toggle button must be present after the second show");

    toggleBtn.click();
    await flush();

    const revertBtn = document.querySelector("button[data-action='reset-revert']");

    assert.ok(revertBtn, "reset-revert button must be visible after the toggle click");

    revertBtn.click();
    await settlePersist();

    assert.ok(fake.observed.updatedConfigs.length > 0,
      "revert must have invoked updatePluginConfig at least once - if this fails the chain broke before the model write");

    const persisted = fake.observed.updatedConfigs.at(-1)[0].options;

    assert.deepEqual(persisted, initialOrder,
      "re-show with set-equal-but-reordered options must preserve the original snapshot - revert restores the first show's order, not the reload's");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - boundary coercion of malformed config", () => {

  test("show() coerces a non-array options field to an empty list without crashing the model", async () => {

    // The Homebridge plugin config store is user-editable JSON. A malformed options field (any non-array value) is treated as "no options configured" at the
    // orchestrator boundary, so every downstream consumer (the snapshot, the model, the revert path) can trust the shape.
    using _dom = createTestDom();

    createSkeletonFeatureOptionsDom();

    const fake = createFakeHomebridge({

      config: [{ name: "TestPlugin", options: { not: "an array" }, platform: "TestPlugin" }],
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions();

    await assert.doesNotReject(async () => orchestrator.show(await openTestSession()),
      "show() must tolerate a non-array options field rather than handing it through to the model unchecked");

    orchestrator.cleanup();
  });
});

describe("webUiFeatureOptions - controller-mode multi-tier inheritance (end-to-end)", () => {

  // End-to-end tests proving the global -> controller -> device inheritance contract holds across the orchestrator's full navigation surface. Each test seeds
  // a multi-tier configuration, walks real user actions (clicks on nav links and checkboxes), and asserts both the rendered DOM and the persisted-config state
  // at each step. These are the integration-level pin for the contract; the unit-level versions live in `webUi-featureOptions/rendering.test.mjs`, which exercises
  // the pure rendering factories (initial render and tri-state transitions) in isolation.

  // Fixture serials. The harness builds its controller and device objects from these constants, tests construct configuredOptions strings that reference them,
  // and assertions read them back when checking the persisted state. Hoisting to describe scope makes them the single source of truth for the fixture's
  // identity - changing a serial here propagates everywhere consistently, so a future refactor cannot leave half the suite pointing at the old value.
  const CONTROLLER_SERIAL = "CTRL-001";
  const DEVICE_A_SERIAL = "DEV-001";
  const DEVICE_B_SERIAL = "DEV-002";

  // Build a controller-mode harness around the orchestrator. Implements the documented convention that `getDevices(controller)` returns `[controllerAsDevice,
  // ...managedDevices]` with the controller as index 0 (so controller-scope options can be edited from the controller's row), and that `isController` is the
  // tag the nav uses to label controllers vs. devices. The harness owns the homebridge install and the orchestrator's cleanup, exposing them via the
  // Disposable interface so tests bind it with `using` for automatic teardown at scope exit.
  function makeControllerHarness({ options = [] } = {}) {

    const controllerEntry = { address: "10.0.0.1", name: "Main Controller", serialNumber: CONTROLLER_SERIAL };
    const controllerAsDevice = { firmwareRevision: "1.0", manufacturer: "Acme", model: "Hub", name: "Main Controller", serialNumber: CONTROLLER_SERIAL };
    const deviceA = { firmwareRevision: "2.0", manufacturer: "Acme", model: "Cam", name: "Front Door", serialNumber: DEVICE_A_SERIAL };
    const deviceB = { firmwareRevision: "2.0", manufacturer: "Acme", model: "Cam", name: "Side Door", serialNumber: DEVICE_B_SERIAL };

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: [{ name: "TestPlugin", options, platform: "TestPlugin" }],
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });
    const homebridgeGuard = installHomebridge(fake);

    seedBootstrapProbeShim();

    const orchestrator = new webUiFeatureOptions({

      // Predicates reference the fixture's own controllerEntry rather than re-stating the serial literal - the controller object is the SSOT for "what is this
      // fixture's controller," so any change to its identity propagates everywhere consistently.
      getControllers: async () => [controllerEntry],
      getDevices: async (controller) => (controller?.serialNumber === controllerEntry.serialNumber) ?
        { devices: [ controllerAsDevice, deviceA, deviceB ], error: "" } :
        { devices: [], error: "" },
      ui: { isController: (device) => device?.serialNumber === controllerEntry.serialNumber }
    });

    return {

      controllerEntry,
      deviceA,
      deviceB,
      fake,
      orchestrator,
      skeleton,

      // Canonical disposal protocol per test-conventions.md §5: LIFO drain with smart-throw - zero errors silent, one error thrown directly so the runner's
      // output points at the actual cause, multiple errors wrapped in AggregateError so no failure is silently lost. The LIFO order is orchestrator-first
      // (it may interact with homebridge during cleanup), then homebridge-uninstall (releases the global). Without this accumulation, a throw in
      // orchestrator.cleanup() would leave the homebridge global installed and pollute subsequent tests.
      [Symbol.dispose]() {

        const errors = [];

        try { orchestrator.cleanup(); } catch(error) { errors.push(error); }
        try { homebridgeGuard[Symbol.dispose](); } catch(error) { errors.push(error); }

        if(errors.length === 1) {

          throw errors[0];
        }

        if(errors.length > 1) {

          throw new AggregateError(errors, "controller-mode harness disposal failed");
        }
      }
    };
  }

  // Click a sidebar nav link by CSS selector. The nav module uses `data-device-serial` as the SSOT identifier for both controller and device links, and
  // `data-navigation` to distinguish link kind, so attribute selectors like `.nav-link[data-device-serial='CTRL-001']` or `.nav-link[data-navigation='global']`
  // identify the target precisely. The click itself is synchronous; callers follow with `waitFor` on the specific post-navigation UI state they care about - the
  // predicate captures the test's intent ("wait until the device row renders") rather than coupling to the orchestrator's internal async-chain depth, and a
  // hung navigation surfaces as a clearly-named timeout failure instead of an inscrutable assertion mismatch on stale DOM.
  function clickNav(selector) {

    const link = document.querySelector(selector);

    assert.ok(link, "expected to find a nav link matching selector: " + selector);

    link.click();
  }

  // Read the latest options array persisted via homebridge.updatePluginConfig. Returns null when nothing has been persisted yet, which is itself a useful
  // assertion target for "the operation should not have triggered a persistence call."
  function latestPersistedOptions(fake) {

    return fake.observed.updatedConfigs.at(-1)?.[0]?.options ?? null;
  }

  test("show() defaults to the controller view; a global entry surfaces there as indeterminate (inherits from global)", async () => {

    // The most basic multi-tier contract: an option set globally must appear as inherited when viewed from any sub-scope, including the controller. This is
    // the canary case for the orchestrator's controller-mode initialization: the controller is set, the devices are loaded, and the renderer is wired with the
    // right controller context before the initial render.
    using _dom = createTestDom();
    using harness = makeControllerHarness({ options: ["Disable.Motion.Detect"] });

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Expand the Motion category to materialize its rows under the lazy-rendering contract.
    harness.skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const checkbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    assert.ok(checkbox, "Motion.Detect row must render in the controller view");
    assert.equal(checkbox.indeterminate, true, "the controller view must surface the global Disable as inherited");
    assert.equal(checkbox.readOnly, true, "inherited rows are readOnly to mark the indeterminate state");
  });

  test("from the controller view, clicking an indeterminate checkbox persists a controller-scope override and preserves the global entry", async () => {

    // The override-at-controller path. The user is looking at the controller, sees the inherited global state, and clicks to override at the controller scope.
    // The model must write the controller-scoped Disable AND preserve `Enable.Motion.Detect` (the global) untouched - only the controller scope is being
    // mutated. This pins both the transition logic and the scope-targeted model write.
    using _dom = createTestDom();
    using harness = makeControllerHarness({ options: ["Enable.Motion.Detect"] });

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Expand the Motion category to materialize its rows under the lazy-rendering contract.
    harness.skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    const checkbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    assert.equal(checkbox.indeterminate, true, "starting state: inherited from global Enable");

    // Mimic the browser's response to a click on an indeterminate checkbox: toggle checked to true, clear indeterminate, leave readOnly alone. Our handler
    // then routes through transition 1 (indeterminate -> explicit unchecked at the current scope).
    checkbox.checked = true;
    checkbox.indeterminate = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait until the persistence pipeline has flushed the controller-scope Disable into the homebridge config. The persist effect's coalescing drain writes
    // fire-and-forget, so waiting on the specific entry's presence is what the test actually cares about and surfaces a clearly-named failure if the persistence
    // never lands.
    const expectedEntry = "Disable.Motion.Detect." + CONTROLLER_SERIAL;

    await waitFor(() => latestPersistedOptions(harness.fake)?.includes(expectedEntry),
      { message: "controller-scope override must reach the persisted config" });

    const persisted = latestPersistedOptions(harness.fake);

    assert.ok(persisted.includes(expectedEntry),
      "the controller-scope override must be persisted - the click at the controller view writes to that scope");
    assert.ok(persisted.includes("Enable.Motion.Detect"),
      "the original global entry must survive - only the controller scope was the target of the mutation");
  });

  test("controller-scope override navigates correctly to a device under that controller: device row inherits from controller (indeterminate)", async () => {

    // The mid-tier inheritance case end-to-end. A controller-scope entry exists; we navigate from the controller view to a device under that controller; the
    // device row must surface as indeterminate, identifying the controller as the inheritance source. The label coloring further pins which scope is the
    // delivery point - text-success means "inherited from controller" (vs. text-warning for "inherited from global").
    using _dom = createTestDom();
    using harness = makeControllerHarness({ options: ["Disable.Motion.Detect." + CONTROLLER_SERIAL] });

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Expand the Motion category to materialize its rows under the lazy-rendering contract.
    harness.skeleton.configTable.querySelector("details[data-category='Motion'] summary").click();

    // Sanity-check the initial state: at the controller view, the controller-scope entry is the EXPLICIT state (not indeterminate) because the controller IS
    // the current scope. Asserting this here catches a regression where the renderer would conflate "set at this scope" with "inherited from this scope."
    const controllerViewCheckbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    assert.equal(controllerViewCheckbox.indeterminate, false, "controller view of a controller-scope entry: explicit, not indeterminate");
    assert.equal(controllerViewCheckbox.checked, false, "explicit Disable renders as unchecked at the controller's own scope");

    // Navigate to a device under the controller via the sidebar's device link, identified by its `data-device-serial` (the SSOT identifier the nav module
    // exposes for both controller and device links). The click is synchronous; the resulting render lands on the next event-loop turn, so we wait for the
    // Motion category table to appear, then expand it to materialize rows under the lazy-rendering contract. The post-expand assertion waits for the
    // controller-inheritance marker (`label.text-success`) to appear on the row - the predicate captures the destination state explicitly.
    clickNav(".nav-link[data-device-serial='" + DEVICE_A_SERIAL + "']");

    const motionTable = await waitFor(
      () => harness.skeleton.configTable.querySelector("details[data-category='Motion']"),
      { message: "device view's Motion category table must render" }
    );

    clickCategoryHeader(motionTable);

    const deviceViewLabel = await waitFor(
      () => harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] label.text-success"),
      { message: "device view's row must render with controller-inheritance coloring" }
    );

    const deviceViewRow = deviceViewLabel.closest("[id='row-Motion.Detect']");
    const deviceViewCheckbox = deviceViewRow.querySelector("input[type='checkbox']");

    assert.equal(deviceViewCheckbox.indeterminate, true, "device view of a controller-scope entry: inherited, indeterminate");
    assert.equal(deviceViewCheckbox.readOnly, true);
    assert.ok(deviceViewLabel.classList.contains("text-success"),
      "label coloring must identify the controller as the inheritance source (text-success), not global (text-warning)");
  });

  test("device-level override survives a Device -> Global -> Controller -> Device navigation round-trip", async () => {

    // The state-preservation contract. Setting an override at the device scope is a write to the model; subsequent navigation must read fresh from the model
    // rather than carrying stale UI state. A regression where the orchestrator caches per-view state without re-reading the model would silently lose
    // overrides on navigation. The round-trip walks Device -> Global -> Controller -> Device (the controller hop is required because navigating to Global
    // intentionally clears the device list - the user must re-enter a controller's scope to see devices again, matching the production UX).
    using _dom = createTestDom();
    using harness = makeControllerHarness();

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Step 1: navigate to the device, then expand the Motion category to materialize its rows under the lazy-rendering contract. The orchestrator's saved
    // category-state persistence will remember the expand for this device's context, so step 5's revisit auto-restores it.
    clickNav(".nav-link[data-device-serial='" + DEVICE_A_SERIAL + "']");

    const step1MotionTable = await waitFor(
      () => harness.skeleton.configTable.querySelector("details[data-category='Motion']"),
      { message: "device view must render the Motion category" }
    );

    clickCategoryHeader(step1MotionTable);

    await waitFor(() => harness.skeleton.configTable.querySelector("[id='row-Motion.Detect']"),
      { message: "device view must render the Motion.Detect row after expanding the Motion category" });

    let checkbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    assert.equal(checkbox.checked, true, "starting state at the device: catalog default is true");

    // Step 2: override Motion.Detect to disabled at the device scope. Browser toggle: checked=false, indeterminate=false. Wait until the persistence pipeline
    // has flushed the device-scope Disable into the homebridge config - the persistence runs fire-and-forget via the persist effect's coalescing drain.
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    const expectedDeviceEntry = "Disable.Motion.Detect." + DEVICE_A_SERIAL;

    await waitFor(() => latestPersistedOptions(harness.fake)?.includes(expectedDeviceEntry),
      { message: "device-scope Disable must reach the persisted config" });

    // Step 3: navigate to Global Options. The orchestrator re-renders the global view AND clears the devices sidebar (matching the production UX where global
    // is a top-of-hierarchy view with no device context). The device-scope entry stays in the model regardless. We expand the Motion category to materialize
    // its rows in the global context (lazy-rendering contract - the global context is a separate saved-state key, so it doesn't inherit step 1's expand). Then
    // we wait until the global render has settled by observing the unique post-render state - the row's checkbox is in its catalog default with no inherited markers.
    clickNav(".nav-link[data-navigation='global']");

    const step3MotionTable = await waitFor(
      () => harness.skeleton.configTable.querySelector("details[data-category='Motion']"),
      { message: "global view must render the Motion category" }
    );

    clickCategoryHeader(step3MotionTable);

    await waitFor(
      () => {

        const cb = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

        return cb && cb.checked && !cb.indeterminate;
      },
      { message: "global view must render Motion.Detect as the catalog default (checked, not indeterminate)" }
    );

    // Step 4: navigate back via the controller link to re-populate the device list. Both controller and device links share `data-device-serial` (the controller
    // is rendered as a device too, per the index-0 convention), so the selector pairs serial with `data-navigation='controller'` to pin the controller-kind link
    // unambiguously. The wait predicate is the device link reappearing in the sidebar - that's the precondition step 5 needs to click against.
    clickNav(".nav-link[data-navigation='controller'][data-device-serial='" + CONTROLLER_SERIAL + "']");
    await waitFor(() => document.querySelector(".nav-link[data-navigation='device'][data-device-serial='" + DEVICE_A_SERIAL + "']"),
      { message: "device list must repopulate after navigating back through the controller" });
    await flush();

    // Step 5: navigate back to the device and verify the device-level Disable is still reflected. This is the assertion that matters: the model write from
    // step 2 must survive all the navigations, and the renderer must read it fresh on re-render rather than carry any stale DOM state from the original render.
    clickNav(".nav-link[data-device-serial='" + DEVICE_A_SERIAL + "']");
    await waitFor(
      () => {

        const cb = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

        return cb && (cb.checked === false) && (cb.indeterminate === false);
      },
      { message: "device view after round-trip must render the persisted device-scope Disable (unchecked, not indeterminate)" }
    );

    checkbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    assert.equal(checkbox.checked, false, "device view after round-trip: the device-scope Disable from step 2 still drives the rendered state");
    assert.equal(checkbox.indeterminate, false, "the entry is explicit at this scope, not inherited");

    // Step 6: belt-and-suspenders. The persisted options must still carry the device-scope entry; no navigation-side cleanup should have silently dropped it.
    const persisted = latestPersistedOptions(harness.fake);

    assert.ok(persisted.includes(expectedDeviceEntry),
      "the device-scope entry must remain in the persisted options array across navigations");
  });

  // Scope-aware cache invalidation: the orchestrator drops cache entries only for views whose inherited state could have changed. A device-scope mutation only
  // touches the current view; other devices' detached DOM remains identity-stable across the mutation. A controller-scope mutation invalidates all devices under
  // that controller. A global mutation invalidates everything. This scoping preserves device-to-device navigation warmth when the user is editing at the device
  // scope.
  test("a device-scope mutation preserves other devices' cached DOM (cache stays identity-stable across the mutation)", async () => {

    using _dom = createTestDom();
    using harness = makeControllerHarness();

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Step 1: visit device A, expand Motion, and snapshot its category-table DOM node. The orchestrator's renderer caches this DOM on the next navigation.
    clickNav(".nav-link[data-device-serial='" + DEVICE_A_SERIAL + "']");

    const aMotionTable = await waitFor(
      () => harness.skeleton.configTable.querySelector("details[data-category='Motion']"),
      { message: "device A's Motion category must render" }
    );

    clickCategoryHeader(aMotionTable);

    const aMotionTableSnapshot = aMotionTable;

    // Step 2: navigate to device B. Device A's DOM detaches into the cache, keyed by DEVICE_A_SERIAL. Expand Motion on B so the row exists for the mutation.
    clickNav(".nav-link[data-device-serial='" + DEVICE_B_SERIAL + "']");

    const bMotionTable = await waitFor(
      () => harness.skeleton.configTable.querySelector("details[data-category='Motion']"),
      { message: "device B's Motion category must render" }
    );

    assert.ok(bMotionTable !== aMotionTableSnapshot, "pre-condition: device B's table is a distinct DOM node from device A's (they are different views)");

    clickCategoryHeader(bMotionTable);

    // Step 3: toggle Motion.Detect at device B (a device-scope mutation). Under the new policy, this preserves DEV-A's cache entry because nothing about A's
    // inherited state changed.
    const bCheckbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    bCheckbox.checked = false;
    bCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    // Step 4: navigate back to device A. The cached DOM must re-attach (identity-stable) - if the renderer had auto-invalidated, we'd get a freshly-built table
    // here instead of the snapshot from step 1.
    clickNav(".nav-link[data-device-serial='" + DEVICE_A_SERIAL + "']");
    await flush();

    const aMotionTableRevisit = harness.skeleton.configTable.querySelector("details[data-category='Motion']");

    assert.ok(aMotionTableRevisit === aMotionTableSnapshot,
      "scope-aware invalidation: a device-scope mutation on device B preserves device A's cache entry - revisiting A re-attaches the same DOM node");
  });

  test("a controller-scope mutation invalidates devices' cached DOM under that controller (their inherited state could have changed)", async () => {

    using _dom = createTestDom();
    using harness = makeControllerHarness();

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Step 1: visit device A, expand Motion, capture the table DOM node.
    clickNav(".nav-link[data-device-serial='" + DEVICE_A_SERIAL + "']");

    const aMotionTable = await waitFor(
      () => harness.skeleton.configTable.querySelector("details[data-category='Motion']"),
      { message: "device A's Motion category must render" }
    );

    clickCategoryHeader(aMotionTable);

    const aMotionTableSnapshot = aMotionTable;

    // Step 2: navigate to the controller view (controller-as-device, index 0 by convention). The controller-navigation flow is async - the view-nav handler
    // dispatches a transient `scope:changed -> kind: "controller"` immediately, then `await`s the plugin's `getDevices`, then dispatches `devices:loaded`
    // followed by the final `scope:changed -> kind: "device", deviceId: controllerSerial` (the controller-as-device view).
    //
    // We must wait for the FINAL settlement, not the transient state. The right signal is the device list repopulating: that proves `devices:loaded` has
    // dispatched, which is in the same continuation as the final `scope:changed`, so by the time the device link appears the configTable holds the
    // controller-as-device view. Waiting on "Motion table changed" would land us in the transient `kind: "controller"` state with a DOM reference that goes
    // stale the moment the next microtask fires.
    clickNav(".nav-link[data-navigation='controller'][data-device-serial='" + CONTROLLER_SERIAL + "']");
    await waitFor(() => document.querySelector(".nav-link[data-navigation='device'][data-device-serial='" + DEVICE_A_SERIAL + "']"),
      { message: "controller-link click must repopulate the device list (signals navigation settled)" });

    const ctrlMotionTable = harness.skeleton.configTable.querySelector("details[data-category='Motion']");

    clickCategoryHeader(ctrlMotionTable);

    // Step 3: toggle Motion.Detect at the controller view. The orchestrator recognizes this as a controller-scope mutation (the current view's device passes the
    // `isController` predicate) and drops the cache entries for every non-controller device under this controller - device A's entry is among them.
    const ctrlCheckbox = harness.skeleton.configTable.querySelector("[id='row-Motion.Detect'] input[type='checkbox']");

    ctrlCheckbox.checked = false;
    ctrlCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    // Step 4: navigate back to device A. The cache entry must be gone - a fresh build is required because the inheritance state changed.
    clickNav(".nav-link[data-device-serial='" + DEVICE_A_SERIAL + "']");
    await flush();

    const aMotionTableRevisit = harness.skeleton.configTable.querySelector("details[data-category='Motion']");

    assert.ok(aMotionTableRevisit !== aMotionTableSnapshot,
      "scope-aware invalidation: a controller-scope mutation drops cache entries for devices under that controller - revisiting A gets a fresh DOM");
  });
});

describe("webUiFeatureOptions - the getDevices contract guard", () => {

  // Build a controller-mode orchestrator whose device fetch result is a mutable closure variable. The initial show resolves a valid rich shape so the sidebar
  // renders a clickable controller link; a test then swaps in an invalid shape and clicks the controller so the fetch routes through the real #devicesFor seam, where
  // the contract guard runs. The guard's TypeError surfaces through the nav handler's catch as the connection-error message, so the rendered <code> element is the
  // observable proof that the named guard tripped.
  function makeGuardHarness() {

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });
    const homebridgeGuard = installHomebridge(fake);

    seedBootstrapProbeShim();

    const state = { devicesResult: { devices: [{ firmwareRevision: "1.0", manufacturer: "Acme", model: "Hub", name: "Hub", serialNumber: "CTRL-1" }], error: "" } };
    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [{ name: "Hub", serialNumber: "CTRL-1" }],
      getDevices: () => state.devicesResult
    });

    return {

      orchestrator,
      skeleton,
      state,

      [Symbol.dispose]() {

        orchestrator.cleanup();
        homebridgeGuard[Symbol.dispose]();
      }
    };
  }

  test("trips the named TypeError when the resolved value has no devices array (error-only object and the legacy bare array)", async () => {

    using _dom = createTestDom();
    using harness = makeGuardHarness();

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Two devices-half-invalid shapes: an object carrying only the error, and the bare-array payload the rich contract rejects.
    for(const invalid of [ { error: "boom" }, [{ serialNumber: "CTRL-1" }] ]) {

      harness.state.devicesResult = invalid;
      harness.skeleton.controllersContainer.querySelector("[data-navigation='controller'][data-device-serial='CTRL-1']").click();

      // eslint-disable-next-line no-await-in-loop
      await flush();

      const codeElement = harness.skeleton.headerInfo.querySelector("code");

      assert.equal(codeElement?.textContent, "getDevices must resolve to { devices, error }.",
        "a resolved value without a devices array must trip the named contract TypeError, surfaced as the connection-error message");
    }
  });

  test("trips the named TypeError when the resolved error is missing or not a string", async () => {

    using _dom = createTestDom();
    using harness = makeGuardHarness();

    await harness.orchestrator.show(await openTestSession());
    await flush();

    // Two error-half-invalid shapes: the error property missing entirely, and a non-string error.
    for(const invalid of [ { devices: [] }, { devices: [], error: 123 } ]) {

      harness.state.devicesResult = invalid;
      harness.skeleton.controllersContainer.querySelector("[data-navigation='controller'][data-device-serial='CTRL-1']").click();

      // eslint-disable-next-line no-await-in-loop
      await flush();

      const codeElement = harness.skeleton.headerInfo.querySelector("code");

      assert.equal(codeElement?.textContent, "getDevices must resolve to { devices, error }.",
        "a resolved value whose error is missing or non-string must trip the named contract TypeError, surfaced as the connection-error message");
    }
  });
});

describe("webUiFeatureOptions - empty-success semantics", () => {

  test("empty-success on the initial show renders the normal empty UI and never shows connection-error", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    // A selected controller that legitimately has no devices resolves an empty-success result (empty error). The orchestrator must fall through to the global scope
    // and reveal the regions, never the connection-error short-circuit that a non-empty error would trigger.
    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [{ name: "Hub", serialNumber: "CTRL-1" }],
      getDevices: () => ({ devices: [], error: "" })
    });

    await orchestrator.show(await openTestSession());
    await flush();

    assert.equal(skeleton.headerInfo.querySelector("button.btn-warning"), null, "an empty-success result must never render the connection-error view");
    assert.equal(skeleton.sidebar.style.display, "", "the success path must reveal the regions rather than returning early on the connection-error branch");

    orchestrator.cleanup();
  });

  test("empty-success on a nav controller-click stands the optimistic controller scope and never shows connection-error", async () => {

    using _dom = createTestDom();

    const skeleton = createSkeletonFeatureOptionsDom();
    const fake = createFakeHomebridge({

      config: makePluginConfig(),
      requestResponses: new Map([[ "/getOptions", FEATURES ]])
    });

    using _homebridge = installHomebridge(fake);

    seedBootstrapProbeShim();

    // Controller A carries a device so the initial show lands on it; controller B legitimately has none - an empty-success result whose empty error must render the
    // normal empty UI, leaving the optimistic controller scope in place, rather than the connection-error view.
    const orchestrator = new webUiFeatureOptions({

      getControllers: () => [ { name: "Hub A", serialNumber: "CTRL-A" }, { name: "Hub B", serialNumber: "CTRL-B" } ],
      getDevices: (controller) => (controller?.serialNumber === "CTRL-A") ?
        { devices: [{ firmwareRevision: "1.0", manufacturer: "Acme", model: "Hub", name: "Hub A", serialNumber: "CTRL-A" }], error: "" } :
        { devices: [], error: "" }
    });

    await orchestrator.show(await openTestSession());
    await flush();

    const ctrlBLink = skeleton.controllersContainer.querySelector("[data-navigation='controller'][data-device-serial='CTRL-B']");

    ctrlBLink.click();
    await flush();

    assert.equal(ctrlBLink.classList.contains("active"), true, "the optimistic controller scope must stand over an empty-success result");
    assert.equal(skeleton.headerInfo.querySelector("button.btn-warning"), null, "an empty-success result must never render the connection-error view");

    orchestrator.cleanup();
  });
});
