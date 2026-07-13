/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi.mjs: Plugin webUI.
 */
"use strict";

import { PluginConfigSession } from "./pluginConfigSession.mjs";
import { toastError } from "./webUi-featureOptions/utils.mjs";
import { webUiFeatureOptions } from "./webUi-featureOptions.mjs";

/**
 * @typedef {Object} FirstRunContext
 * @property {(patch: Object) => Promise<void>} [commit] - Persist a patch to the primary platform-config entry. Supplied only to `onSubmit` (the one write hook).
 * @property {Object} config - The primary platform-config entry, injected so the hook is a pure function of its input rather than reaching for the config itself.
 */

/**
 * @typedef {Object} FirstRunHandlers
 * @property {(context: FirstRunContext) => boolean | Promise<boolean>} [isRequired] - Returns truthy when the first-run flow must run before the main UI is shown.
 * @property {(context: FirstRunContext) => boolean | Promise<boolean>} [onStart] - Initialization for the first-run UI; populates forms and runs any startup tasks.
 * @property {(context: FirstRunContext) => boolean | Promise<boolean>} [onSubmit] - Executes the first-run workflow, typically a login or configuration validation.
 */

/**
 * @typedef {Object} WebUiConfig
 * @property {Object} [featureOptions] - Parameters forwarded to {@link webUiFeatureOptions}.
 * @property {FirstRunHandlers} [firstRun] - First-run lifecycle hooks.
 * @property {string} [name] - Plugin name used to seed a fresh configuration.
 */

/**
 * webUi - Top-level plugin webUI orchestrator.
 *
 * Owns the page-level menu state, the first-run flow, and the {@link webUiFeatureOptions} instance that renders the feature options page. The orchestrator is the
 * single entry point Homebridge invokes to render the configuration UI; everything else - feature option discovery, theming, sidebar navigation, search - lives in
 * the composed {@link webUiFeatureOptions} instance and its sub-components.
 */
export class webUi {

  featureOptions;

  #firstRun;
  #name;
  #session;

  /**
   * Initialize the plugin webUI orchestrator.
   *
   * Constructs the composed {@link webUiFeatureOptions} instance immediately so the feature-options page is ready to render the moment the user navigates to it.
   * Caller-supplied first-run hooks are merged in a single spread over the default no-op handlers, so partial overrides work naturally - a caller can supply only
   * `onSubmit` and the unspecified slots stay at the defaults that keep the flow driveable.
   *
   * @param {WebUiConfig} [options] - Configuration options for the webUI. All fields are optional; firstRun's hooks fall back to no-op handlers, and
   * featureOptions/name simply default to undefined.
   */
  constructor({ featureOptions, firstRun = {}, name } = {}) {

    // First-run handlers default to no-ops; caller-supplied entries override per-key. The single-statement spread lands `#firstRun` in its final shape on first
    // assignment, so there is no intermediate object that gets discarded a line later.
    this.#firstRun = { isRequired: () => false, onStart: () => true, onSubmit: () => true, ...firstRun };

    this.featureOptions = new webUiFeatureOptions(featureOptions);
    this.#name = name;
  }

  /**
   * Render the webUI.
   *
   * Public entry point Homebridge invokes when the configuration UI is opened. Delegates the actual rendering to {@link #launchWebUI}; this wrapper exists to
   * standardize error handling (a launch failure becomes a user-facing toast rather than a silent broken UI) and to guarantee the spinner is hidden no matter how
   * the launch settles. The `finally` runs after the awaited launch resolves or rejects, so the spinner stays visible for the full duration of the async setup
   * rather than disappearing the moment the synchronous portion of the call returns.
   *
   * @returns {Promise<void>}
   * @public
   */
  async show() {

    try {

      await this.#launchWebUI();
    } catch(err) {

      // Outermost user-facing diagnostic seam in the webUI. Caller-supplied first-run handlers and other extension points can throw any shape, so the shared
      // toastError normalization extracts a useful message regardless of what bubbled out of `#launchWebUI`.
      toastError(err);
    } finally {

      homebridge.hideSpinner();
    }
  }

  /**
   * Show the first-run user experience.
   *
   * Wires the submit button to run the caller-supplied submit handler, swap the page from first-run to feature-options, and hand off to the feature-options view.
   * The save button stays disabled until the user completes the first-run flow so a partially-configured plugin cannot be written back to disk. A submit failure
   * surfaces as an error toast, and where the failure landed decides what the user is left looking at: a rejected submit throws before the page swap and leaves the
   * first-run page fully visible for another attempt, while a failure during the feature-options handoff after a successful submit leaves the main shell visible with
   * the menu still usable for recovery.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showFirstRun() {

    const buttonFirstRun = document.getElementById("firstRun");

    // Inject the primary platform-config entry so the hook reads its config from its argument rather than reaching for the session or the host. onStart only reads
    // (it pre-populates the form), so it receives config without the writer.
    if(!(await this.#processHandler(this.#firstRun.onStart, { config: this.#session.platform }))) {

      return;
    }

    homebridge.disableSaveButton();

    buttonFirstRun.addEventListener("click", async () => {

      homebridge.showSpinner();

      try {

        // onSubmit is the one write hook: it validates credentials and persists them. It receives both the current config and a `commit` bound to the session's
        // single write seam, so the hook owns the shape of the write (it knows credentials live under the controllers array) while the session owns persistence.
        if(!(await this.#processHandler(this.#firstRun.onSubmit, { commit: (patch) => this.#session.commit(patch), config: this.#session.platform }))) {

          return;
        }

        // Swap from the first-run page to the main configuration UI and hand off to the feature-options view. The feature-options surface manages its own
        // progressive disclosure - page-shell visible immediately, regions populating as their I/O resolves - so the click handler's spinner is the only one that
        // brackets this transition. The `try/finally` ensures it comes down on every exit path, including the early bail above.
        document.getElementById("pageFirstRun").style.display = "none";
        document.getElementById("menuWrapper").style.display = "inline-flex";

        await this.featureOptions.show(this.#session);

        homebridge.enableSaveButton();
      } catch(err) {

        // A first-run submit can throw from two places, and where it threw decides what the user is left looking at. A rejected onSubmit (a failed login or
        // configuration validation) throws before the page swap, so the first-run page stays fully visible for another attempt. A rejection from
        // featureOptions.show() after a successful submit throws after the swap, so the main shell is visible with the menu still usable for recovery. In both cases
        // the toast is the diagnostic, and the finally below brings the spinner down.
        toastError(err);
      } finally {

        homebridge.hideSpinner();
      }
    });

    document.getElementById("pageFirstRun").style.display = "block";
  }

  /**
   * Show the feature-options tab from the menu.
   *
   * The menuFeatureOptions button re-enters the feature-options view. `featureOptions.show()` can reject - a plugin `getDevices` hook that resolves the wrong shape
   * trips the device-list contract guard, for one - and the click listener drops the returned promise, so this method brackets the re-entry in a try/catch that
   * surfaces a failed re-show as an error toast rather than an unobserved rejection.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showFeatureOptions() {

    try {

      await this.featureOptions.show(this.#session);
    } catch(err) {

      toastError(err);
    }
  }

  /**
   * Show the main plugin configuration tab.
   *
   * Hides the feature-options view, swaps the menu button states (home and feature-options become primary; settings becomes elegant to indicate the active tab),
   * and asks Homebridge to render its built-in schema-driven settings form. The spinner brackets the swap so transient layout shifts are not visible to the user.
   *
   * Awaits `featureOptions.hide()` BEFORE revealing the schema form so any debounced-but-unwritten option edit is flushed into Homebridge's in-memory config model
   * first - the Settings form then renders against the flushed config rather than a stale snapshot. The try/finally guarantees the spinner comes down and the tab
   * reveals even if the drain rejects (the drain's own failure path already toasts via `persist:failed`), so a persistence error never strands the user on a spinner.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showSettings() {

    homebridge.showSpinner();

    try {

      await this.featureOptions.hide();
    } finally {

      this.#toggleClasses("menuHome", "btn-elegant", "btn-primary");
      this.#toggleClasses("menuFeatureOptions", "btn-elegant", "btn-primary");
      this.#toggleClasses("menuSettings", "btn-primary", "btn-elegant");

      document.getElementById("pageSupport").style.display = "none";
      document.getElementById("pageFeatureOptions").style.display = "none";

      homebridge.showSchemaForm();

      homebridge.hideSpinner();
    }
  }

  /**
   * Show the support tab.
   *
   * Hides the feature-options view and the schema form, swaps the menu button states (home becomes elegant as the active tab; feature-options and settings revert
   * to primary), and reveals the static support page. Spinner brackets the swap to mask transient layout shifts.
   *
   * Awaits `featureOptions.hide()` BEFORE revealing the support page so any debounced-but-unwritten option edit is flushed first, matching the Settings path. The
   * try/finally guarantees the spinner comes down and the tab reveals even if the drain rejects (the drain's own failure path already toasts via `persist:failed`).
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showSupport() {

    homebridge.showSpinner();
    homebridge.hideSchemaForm();

    try {

      await this.featureOptions.hide();
    } finally {

      this.#toggleClasses("menuHome", "btn-primary", "btn-elegant");
      this.#toggleClasses("menuFeatureOptions", "btn-elegant", "btn-primary");
      this.#toggleClasses("menuSettings", "btn-elegant", "btn-primary");

      document.getElementById("pageSupport").style.display = "block";
      document.getElementById("pageFeatureOptions").style.display = "none";

      homebridge.hideSpinner();
    }
  }

  /**
   * Launch the webUI.
   *
   * Opens the configuration session, wires the menu event listeners, and routes the user to either the feature-options view (when the caller's first-run gate says
   * no) or the first-run flow (when it says yes). The session loads the host config once and seeds the minimum shape, so routing and every downstream reader share
   * one config owner rather than fetching it independently.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #launchWebUI() {

    // Open the configuration session: one host read, seeded to the minimum shape. Routing, the first-run flow, and the feature-options page all read their config
    // from this single owner rather than re-fetching it independently - so the routing decision lands before any UI work begins and against the same data every
    // later reader sees.
    this.#session = await PluginConfigSession.open({ host: homebridge, name: this.#name });

    // Menu click listeners use a uniform shape: an arrow expression that calls a handler and returns its result. addEventListener discards the return value, so each
    // async handler's promise is dropped; the handlers own their error handling so the drop carries no unobserved rejection. #showFeatureOptions wraps
    // featureOptions.show() in a try/catch that toasts a failed re-entry - the show pipeline can reject (a plugin getDevices hook that resolves the wrong shape trips
    // the device-list contract guard, for one), and without the wrapper that rejection would surface nowhere. #showSettings and #showSupport each bracket their
    // navigate-away flush in a try/finally that reveals the next tab and drains the spinner on every path (the flush drain's own failure surfaces via persist:failed's
    // toast).
    document.getElementById("menuHome").addEventListener("click", () => this.#showSupport());
    document.getElementById("menuFeatureOptions").addEventListener("click", () => this.#showFeatureOptions());
    document.getElementById("menuSettings").addEventListener("click", () => this.#showSettings());

    // The caller's first-run gate decides routing against the injected platform config. No separate "is there any config?" test is needed: a plugin with a first-run
    // flow returns true on a fresh config (no valid credentials yet), and a plugin without one keeps the default `() => false` gate and lands straight on feature
    // options - the right destination for a device-discovery plugin even on a brand-new install. The session has already seeded the minimum shape, so the first-run
    // flow can persist credentials on submit without a separate eager write here.
    if(!(await this.#processHandler(this.#firstRun.isRequired, { config: this.#session.platform }))) {

      document.getElementById("menuWrapper").style.display = "inline-flex";
      await this.featureOptions.show(this.#session);

      return;
    }

    // Await first-run setup so the spinner-bracketed window in `show()` only closes after the first-run page is fully wired up - the onStart handler has resolved,
    // the save button is disabled, the click listener is registered, and the page is visible. Returning before this would let `show()`'s `finally` hide the spinner
    // while initialization is still in flight, leaving the user looking at a half-rendered first-run UI.
    await this.#showFirstRun();
  }

  /**
   * Resolve a caller-supplied handler whose shape may be a function or a plain truthy/falsy value.
   *
   * The first-run hooks accept either a function (synchronous or asynchronous - both forms are awaited via the `await handler()` call below) or a literal truthy
   * value (e.g., a caller that always wants the flow to continue can pass `true`). This helper unifies both shapes into a single `Promise<boolean>` answer so the
   * call sites stay flat. The context object is forwarded to the function form so each hook is a pure function of its injected config (and, for `onSubmit`, the
   * write seam) rather than reaching for the session or the host itself.
   *
   * @param {Function|*} handler - Caller-supplied handler. When a function, it is awaited; otherwise it is treated as a truthy/falsy continuation flag.
   * @param {FirstRunContext} [context] - The injected context forwarded to the function form of the handler.
   * @returns {Promise<boolean>} `true` when the workflow should continue, `false` when it should be aborted.
   * @private
   */
  async #processHandler(handler, context) {

    return Boolean((typeof handler === "function") ? await handler(context) : handler);
  }

  /**
   * Swap one Bootstrap button class for another on a DOM element.
   *
   * The menu uses the Bootstrap (Material Design for Bootstrap) `btn-primary` / `btn-elegant` pair to encode active vs inactive tabs. Tab-switch handlers call this
   * helper once per menu button, so the exact class swap each tab needs lives at the call site rather than embedded in this helper.
   *
   * @param {string} id          - The element ID to update.
   * @param {string} removeClass - The class to remove.
   * @param {string} addClass    - The class to add.
   * @private
   */
  #toggleClasses(id, removeClass, addClass) {

    const element = document.getElementById(id);

    element.classList.remove(removeClass);
    element.classList.add(addClass);
  }
}
