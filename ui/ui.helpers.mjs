/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/ui.helpers.mjs: Shared test infrastructure for the webUI component test suite.
 */

/**
 * Shared test helpers for the webUI test suite.
 *
 * Three primitives:
 *
 *   - {@link createTestDom} - builds a Happy-DOM window, installs `document` / `window` / `HTMLElement` / `Event` / `CSSStyleSheet` / `getComputedStyle` as globals,
 *     and returns a `Disposable` handle whose `Symbol.dispose` restores the previous globals and closes the window. Matches the `using dom = createTestDom()`
 *     idiom from `src/` so UI test bodies read the same way their backend counterparts do.
 *   - {@link createSkeletonFeatureOptionsDom} - seeds the document with the exact element tree the `webUi` / `webUiFeatureOptions` orchestrators look up by id
 *     (`configTable`, `controllersContainer`, `devicesContainer`, `search`, page containers, menu buttons, etc.). A single source of truth so every test that
 *     needs the full skeleton gets the same shape without copy-pasting.
 *   - {@link createFakeHomebridge} - an object with every `homebridge.*` method the UI code calls. Default behaviors are quiet no-ops (spinners and save-button
 *     toggles) or minimal stubs (getPluginConfig returns the seeded config). Individual tests override the methods they care about on a per-test basis.
 *
 * Files under `ui/` are copied to `dist/ui/` during `npm run build-ui`; the step's shippable filter (see `build/fs-ops.mjs`) excludes every test-only file shape
 * so nothing from this module ships in the published package.
 *
 * @module
 */
"use strict";

import { PluginConfigSession } from "./pluginConfigSession.mjs";
import { Window } from "happy-dom";
import { setImmediate as flushImmediate } from "node:timers/promises";

// Module-level record of the globals we install so the disposer can restore exactly what was there before. Plain globals are used (rather than per-window scoping)
// because the UI source files reference bare `document` / `window` etc. unqualified - the same shape the browser runtime gives them. The record is re-used across
// invocations; each installation pushes one frame onto a stack so nested `createTestDom` calls (unusual but possible) restore in reverse order.
const globalStack = [];

// DOM globals we copy from the Happy-DOM window onto `globalThis` so the UI source code's unqualified references resolve at runtime. Keep this list in sync with
// the UI source - any new global reference requires a matching addition here. Timer APIs (setTimeout / clearTimeout / setInterval / clearInterval) are deliberately
// excluded: Happy-DOM's versions work, but Node's have better node:test integration (test-timeout unref'ing, etc.), so we leave them on Node's implementation.
const INSTALLED_DOM_GLOBALS = [ "CSSStyleSheet", "CustomEvent", "DocumentFragment", "Element", "Event", "HTMLElement", "HTMLButtonElement", "HTMLInputElement",
  "HTMLTableElement", "KeyboardEvent", "Node", "document", "getComputedStyle", "window" ];

/**
 * Construct a fresh Happy-DOM window and install its browser globals onto `globalThis`. Returns a `Disposable` handle whose `Symbol.dispose` restores the previous
 * globals and closes the window so the event loop can exit promptly at test teardown.
 *
 * Usage:
 *
 * ```js
 * import { createTestDom } from "./ui.helpers.mjs";
 *
 * test("renders the sidebar", () => {
 *
 *   using dom = createTestDom();
 *
 *   // `document` / `window` are now live; the UI source can be imported and exercised.
 * });
 * ```
 *
 * @returns {{ window: Window; [Symbol.dispose](): void }} A disposable handle. `window` is the underlying Happy-DOM Window for tests that need direct access.
 */
export function createTestDom() {

  const window = new Window({ url: "http://localhost/" });
  const frame = { previous: {}, window };

  // Snapshot the previous values, then install the window's versions. A fresh Happy-DOM Window provides every DOM global the UI code references; copying them onto
  // `globalThis` lets the unqualified references in the UI source resolve without module-level changes.
  for(const key of INSTALLED_DOM_GLOBALS) {

    frame.previous[key] = globalThis[key];

    if(window[key] !== undefined) {

      globalThis[key] = window[key];
    }
  }

  globalStack.push(frame);

  return {

    window,

    [Symbol.dispose]() {

      // Pop the most recent frame. Nested `createTestDom` calls unwind in reverse order so the global table always reflects the innermost live window.
      const index = globalStack.lastIndexOf(frame);

      if(index === -1) {

        return;
      }

      globalStack.splice(index, 1);

      // Restore the previous global for each installed key. A `undefined` previous value is deleted so the global table looks identical to pre-install.
      for(const key of INSTALLED_DOM_GLOBALS) {

        if(frame.previous[key] === undefined) {

          delete globalThis[key];
        } else {

          globalThis[key] = frame.previous[key];
        }
      }

      // Close the Happy-DOM window so its internal timers / listeners stop holding the event loop open.
      void window.happyDOM.close();
    }
  };
}

/**
 * Seed the current `document` with the skeleton DOM layout the `webUi` and `webUiFeatureOptions` orchestrators expect. Call after `createTestDom` has installed the
 * globals.
 *
 * The skeleton mirrors the Homebridge config-ui template: page containers for the first-run, feature-options, support, and settings views; the menu wrapper with its
 * three tab buttons; the feature-options sub-layout (sidebar + main content + search panel + config table + info header + stats grid + status info).
 *
 * Returns the important element references as a record so tests that need to insert additional content (seeded options, category tables, etc.) have a typed grip on
 * the skeleton's mount points.
 *
 * @returns {Record<string, HTMLElement>} The mounted skeleton's top-level elements, keyed by their id for convenient reference.
 */
export function createSkeletonFeatureOptionsDom() {

  const html =

    "<div id=\"pageFirstRun\" style=\"display: none\"><button id=\"firstRun\">Start</button></div>" +
    "<div id=\"menuWrapper\" style=\"display: none\">" +
      "<button id=\"menuHome\">Home</button>" +
      "<button id=\"menuFeatureOptions\">Features</button>" +
      "<button id=\"menuSettings\">Settings</button>" +
    "</div>" +
    "<div id=\"pageSupport\" style=\"display: none\"></div>" +
    "<div id=\"pageFeatureOptions\" style=\"display: none\">" +
      "<div id=\"headerInfo\">" +
        "<div class=\"device-stats-grid\"><div id=\"statusInfo\"></div></div>" +
      "</div>" +
      "<div class=\"feature-main-content\">" +
        "<div id=\"sidebar\">" +
          "<div id=\"controllersContainer\"></div>" +
          "<div id=\"devicesContainer\"></div>" +
          "<div id=\"deviceStatsContainer\"></div>" +
        "</div>" +
        "<div class=\"feature-content\">" +
          "<div id=\"search\"></div>" +
          "<div id=\"optionsContainer\"><div id=\"configTable\"></div></div>" +
        "</div>" +
      "</div>" +
    "</div>";

  document.body.innerHTML = html;

  return {

    configTable: document.getElementById("configTable"),
    controllersContainer: document.getElementById("controllersContainer"),
    deviceStatsContainer: document.getElementById("deviceStatsContainer"),
    devicesContainer: document.getElementById("devicesContainer"),
    firstRun: document.getElementById("firstRun"),
    headerInfo: document.getElementById("headerInfo"),
    menuFeatureOptions: document.getElementById("menuFeatureOptions"),
    menuHome: document.getElementById("menuHome"),
    menuSettings: document.getElementById("menuSettings"),
    menuWrapper: document.getElementById("menuWrapper"),
    pageFeatureOptions: document.getElementById("pageFeatureOptions"),
    pageFirstRun: document.getElementById("pageFirstRun"),
    pageSupport: document.getElementById("pageSupport"),
    search: document.getElementById("search"),
    sidebar: document.getElementById("sidebar"),
    statusInfo: document.getElementById("statusInfo")
  };
}

/**
 * A single captured toast emission from the fake homebridge bridge's `.toast.error` / `.toast.success` hooks. Tests assert on the recorded tuples to verify error
 * messages surfaced through the right channel with the right content.
 *
 * @typedef {Object} ToastRecord
 * @property {string} message - The message argument passed to the toast call.
 * @property {string} [title] - The optional title argument.
 * @property {"error"|"success"|"info"|"warning"} variant - Which toast channel was invoked.
 */

/**
 * Build a fake `homebridge` bridge matching the subset of the real Homebridge config-ui global that the UI source touches. Every method is a no-op or stub by
 * default; tests assign their own implementations to methods they care about.
 *
 * State shape:
 *
 *   - `config` - the plugin configuration array the orchestrator reads via `getPluginConfig`. Tests seed it at construction; it is also exposed as a settable `config`
 *     accessor on the returned bridge so a test can reassign it to a NEW array to simulate an external Settings-tab edit landing between two reads (in-place mutation
 *     of the same array would be vacuous, since the session's `platform` getter aliases the previously-read reference).
 *   - `cachedAccessories` - what `getCachedAccessories` returns. Default `[]`.
 *   - `lightingMode` - what `userCurrentLightingMode` returns. Default `"light"`.
 *   - `errorMessage` - the string `request("/getErrorMessage")` resolves with. Default `""`.
 *   - `requestResponses` - a Map<path, response> consulted by `request(path)`. Defaults to empty; unknown paths resolve with `null`.
 *
 * Inspection surface - nested under `observed` on the returned bridge, reachable from tests as `fake.observed.*`:
 *
 *   - `observed.calls` - an ordered log of the host calls whose relative order is load-bearing for the reconciliation tests (`getPluginConfig`, `updatePluginConfig`,
 *     `showSchemaForm`), each appending its tag as it runs. Read this to assert sync-before-show and flush-before-schemaform orderings.
 *   - `observed.updatedConfigs` - every `updatePluginConfig` call's payload.
 *   - `observed.toasts` - every `.toast.*` call's record.
 *   - `observed.state.spinnerCount` - net spinner stack depth (`showSpinner` increments, `hideSpinner` decrements).
 *   - `observed.state.saveButtonEnabled` / `observed.state.schemaFormVisible` - the live flag values, toggled by the corresponding bridge methods.
 *
 * @param {Object} [init={}] - Initial state.
 * @returns {Object} The fake bridge, ready to assign to `globalThis.homebridge`.
 */
export function createFakeHomebridge(init = {}) {

  // The plugin-config backing is a `let` so a test can reassign `fake.config` to a NEW array between two reads - the way an external Settings-tab edit lands in the
  // host's in-memory model while the feature-options page is hidden. The session re-reads via getPluginConfig on every page entry, so a fresh array reference here is
  // what a sync()-driven re-read observes.
  let config = init.config ?? [];
  const cachedAccessories = init.cachedAccessories ?? [];
  const lightingMode = init.lightingMode ?? "light";
  const errorMessage = init.errorMessage ?? "";
  const requestResponses = init.requestResponses ?? new Map();

  const updatedConfigs = [];
  const toasts = [];
  const state = { saveButtonEnabled: true, schemaFormVisible: true, spinnerCount: 0 };

  // An ordered log of the host calls whose RELATIVE order is load-bearing for the reconciliation tests: each config read (getPluginConfig), each config write
  // (updatePluginConfig), and each schema-form reveal (showSchemaForm) appends its tag. Tests read `observed.calls` to assert orderings like "the page re-read the
  // config before rendering" (sync-before-show) and "the pending edit was written before the Settings form rendered" (flush-before-schemaform).
  const calls = [];

  const makeToast = (variant) => (message, title) => {

    toasts.push({ message, title, variant });
  };

  // Keys sorted alphabetically so the object satisfies the project's sort-keys rule. Grouping comments are inline per section to keep the rationale near the
  // methods without introducing ordering exceptions. The `observed` handle is the bridge's test-inspection surface - distinct from the production methods by both
  // name and shape - and carries live references to `state` (live UI counters / flags), `toasts` (captured emissions), and `updatedConfigs` (captured payloads). The
  // nested-object form keeps the inspection surface visibly separate from the production-shaped methods rather than interleaving them at top level.
  const bridge = {

    // The live plugin-config backing, exposed as an accessor so a test can reassign it (`fake.config = [...]`) to simulate an external Settings-tab edit landing
    // between two reads, while every read inside the bridge stays a single source of truth on the `config` closure variable.
    get config() {

      return config;
    },
    set config(next) {

      config = next;
    },

    disableSaveButton: () => { state.saveButtonEnabled = false; },
    enableSaveButton: () => { state.saveButtonEnabled = true; },

    // Homebridge introspection.
    getCachedAccessories: async () => cachedAccessories,

    // Plugin configuration reads. Records the read in the ordered call log so reconciliation tests can assert the re-read happened before the page rendered.
    getPluginConfig: async () => {

      calls.push("getPluginConfig");

      return config;
    },

    hideSchemaForm: () => { state.schemaFormVisible = false; },
    hideSpinner: () => { state.spinnerCount = Math.max(0, state.spinnerCount - 1); },

    observed: { calls, state, toasts, updatedConfigs },

    // The config-ui request router. Tests seed specific responses via the Map; unknown paths resolve with null so a missing entry is a quiet miss rather than a
    // throw.
    request: async (path) => {

      if(path === "/getErrorMessage") {

        return errorMessage;
      }

      return requestResponses.has(path) ? requestResponses.get(path) : null;
    },

    showSchemaForm: () => {

      calls.push("showSchemaForm");
      state.schemaFormVisible = true;
    },
    showSpinner: () => { state.spinnerCount += 1; },

    // Toast channels. The real homebridge global exposes these under `toast` as distinct methods; we preserve that shape so the UI source compiles against it.
    toast: {

      error: makeToast("error"),
      info: makeToast("info"),
      success: makeToast("success"),
      warning: makeToast("warning")
    },

    updatePluginConfig: async (next) => {

      calls.push("updatePluginConfig");
      updatedConfigs.push(structuredClone(next));
    },

    // Theme introspection.
    userCurrentLightingMode: async () => lightingMode
  };

  return bridge;
}

/**
 * Open a {@link PluginConfigSession} against the installed fake homebridge bridge - the test-side equivalent of what the orchestrator's `#launchWebUI` does before
 * it hands the session to `featureOptions.show()`. Tests that drive `webUiFeatureOptions` directly call this to obtain the session their `show()` now requires; tests
 * that drive the full `webUi` orchestrator do not, since it opens the session itself.
 *
 * @param {string} [name="Plugin"] - The platform name used to seed an empty configuration.
 * @returns {Promise<PluginConfigSession>} The opened session, reading from and writing through `globalThis.homebridge`.
 */
export function openTestSession(name = "Plugin") {

  return PluginConfigSession.open({ host: globalThis.homebridge, name });
}

/**
 * Block until `predicate()` returns a truthy value, polling between event-loop yields. Returns the predicate's truthy result so callers that are waiting for "the
 * element to exist" can grab it in the same expression. Throws when the timeout elapses, with the optional `message` describing what was being waited on.
 *
 * The pattern this implements - the one Testing Library popularized as `waitFor` - has two virtues over a fixed-cycle drain. Tests express WHAT they wait for as
 * an invariant rather than HOW MUCH async work to drain, so a deeper async chain doesn't silently miss the window. And successful waits resolve as soon as the
 * predicate becomes true, with no fixed per-call overhead; only failures pay the wall-clock cost (capped by `timeout`).
 *
 * Use `waitFor` for "I clicked / dispatched X, now wait for the resulting UI state to materialize." Continue to use a bounded `flush()` (or equivalent) for "I
 * just need post-action async work to settle before tearing down, with no specific predicate to wait on" - the two patterns are complementary, not substitutes.
 *
 * @param {() => unknown} predicate - Invoked once per cycle. Treated as truthy/falsy; returning an element, a value, or just `true` all work. A synchronous
 *                                     throw from the predicate propagates verbatim - that's a real test-author error worth surfacing immediately, not a polling
 *                                     condition we should swallow and retry.
 * @param {Object} [options]
 * @param {number} [options.timeout=1000] - Wall-clock timeout in milliseconds. Failures throw after this elapses.
 * @param {string} [options.message] - Optional context for the failure message, describing what the test was waiting on.
 * @returns {Promise<unknown>} Resolves with the predicate's truthy return value.
 * @throws {Error} When the predicate has not become truthy within `timeout` milliseconds, or when the predicate itself throws (the predicate's error propagates).
 */
export async function waitFor(predicate, { timeout = 1000, message } = {}) {

  // Check once before any await so a predicate that is already true resolves on the same microtask the caller's await schedules - no event-loop hop, no
  // wall-clock overhead. The post-await re-check is the polling loop's natural body.
  let result = predicate();

  if(result) {

    return result;
  }

  const start = Date.now();

  while(!result) {

    if((Date.now() - start) > timeout) {

      throw new Error("waitFor: " + (message ?? "predicate did not become truthy") + " within " + timeout + "ms");
    }

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
    result = predicate();
  }

  return result;
}

/**
 * Install the supplied fake homebridge bridge as the `homebridge` global. Returns a disposable that restores the previous value on cleanup. Call after
 * `createTestDom` so `globalThis.homebridge` is set inside the scope the UI code reads.
 *
 * @param {Object} fake - The fake bridge, typically produced by {@link createFakeHomebridge}.
 * @returns {{ [Symbol.dispose](): void }} A disposable handle.
 */
export function installHomebridge(fake) {

  const previous = globalThis.homebridge;

  globalThis.homebridge = fake;

  return {

    [Symbol.dispose]() {

      if(previous === undefined) {

        delete globalThis.homebridge;

        return;
      }

      globalThis.homebridge = previous;
    }
  };
}

/**
 * Simulate a user clicking a category disclosure's header. Happy-DOM honors the native `<details>`/`<summary>` toggle behavior (verified against 20.x): clicking
 * the summary mutates `details.open` AND fires the `toggle` event the orchestrator's capture-phase delegated handler listens for. This helper is the single
 * idiom for "drive a category toggle from a test," shared across every webUI test file so the contract under exercise is uniform regardless of which suite the
 * test lives in.
 *
 * @param {HTMLDetailsElement} details - The category `<details>` element.
 */
export function clickCategoryHeader(details) {

  details.querySelector("summary").click();
}
