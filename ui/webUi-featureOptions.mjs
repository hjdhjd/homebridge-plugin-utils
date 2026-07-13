/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions.mjs: Lifecycle coordinator for the feature options webUI.
 */
"use strict";

import { delay, toastError } from "./webUi-featureOptions/utils.mjs";
import { initialState, reducer } from "./webUi-featureOptions/state.mjs";
import { FeatureOptionsStore } from "./webUi-featureOptions/store.mjs";
import { buildCatalogIndex } from "./featureOptions.js";
import { mountConnectionErrorView } from "./webUi-featureOptions/views/connectionError.mjs";
import { mountDeviceInfoView } from "./webUi-featureOptions/views/deviceInfo.mjs";
import { mountHeaderView } from "./webUi-featureOptions/views/header.mjs";
import { mountNavView } from "./webUi-featureOptions/views/nav.mjs";
import { mountOptionsView } from "./webUi-featureOptions/views/options.mjs";
import { mountSearchView } from "./webUi-featureOptions/views/search.mjs";
import { registerKeyboardEffect } from "./webUi-featureOptions/effects/keyboard.mjs";
import { registerPersistEffect } from "./webUi-featureOptions/effects/persist.mjs";
import { registerThemeEffect } from "./webUi-featureOptions/effects/theme.mjs";
import { registerTokensEffect } from "./webUi-featureOptions/effects/tokens.mjs";

/**
 * Upper bound on how long hide() will block waiting for the navigate-away flush to complete. This is a teardown safety cap, NOT a perf knob: the normal flush
 * completes in well under it, and the only thing it guards against is a host `updatePluginConfig` that never settles. `updatePluginConfig` accepts no `AbortSignal`
 * and is documented un-abortable, so without this cap a stalled write would leave flush() (and thus hide(), and the spinner-wrapped tab switch that awaits it) pending
 * indefinitely. On timeout the in-flight commit continues independently and still lands if the host recovers; we simply stop blocking the UI on it.
 */
const FLUSH_TEARDOWN_TIMEOUT_MS = 2000;

/**
 * @typedef {Object} Device
 * @property {string} firmwareRevision - The firmware version of the device.
 * @property {string} manufacturer - The manufacturer of the device.
 * @property {string} model - The model identifier of the device.
 * @property {string} name - The display name of the device.
 * @property {string} serialNumber - The unique serial number of the device.
 * @property {string} [sidebarGroup] - Optional grouping identifier for sidebar organization.
 */

/**
 * @typedef {Object} Controller
 * @property {string} address - The network address of the controller.
 * @property {string} name - The display name of the controller.
 * @property {string} serialNumber - The unique serial number of the controller.
 */

/**
 * The resolved shape of a `getDevices` hook: the single contract every device fetch crosses. It carries the device list and the connection outcome together, so a
 * failure travels back with the response it belongs to rather than through a separate side-channel a concurrent probe could rewrite.
 *
 * @typedef {Object} DeviceListResult
 * @property {Object[]} devices - The devices for the requested controller; empty when the probe failed or when the controller legitimately has none.
 * @property {string} error - The user-facing connection-failure message: empty when the fetch succeeded, the failure text when the fetch failed and `devices` is empty.
 */

/**
 * @typedef {Object} FeatureOptionsConfig
 * @property {Function} [getControllers] - Handler to retrieve available controllers.
 * @property {(controller: (Controller|null)) => Promise<DeviceListResult>} [getDevices] - Handler resolving a controller's {@link DeviceListResult}.
 * @property {Function} [infoPanel] - Handler to display device information.
 * @property {Object} [sidebar] - Sidebar configuration options.
 * @property {string} [sidebar.controllerLabel="Controllers"] - Label for the controllers section.
 * @property {string} [sidebar.deviceLabel="Devices"] - Label for the devices section.
 * @property {Object} [ui] - UI validation and display options.
 * @property {number} [ui.controllerRetryEnableDelayMs=5000] - Interval before enabling a retry button when connecting to a controller.
 * @property {Function} [ui.isController] - Validates if a device is a controller.
 * @property {Function} [ui.validOption] - Validates if an option should display for a device.
 * @property {Function} [ui.validOptionCategory] - Validates if a category should display for a device.
 */

/**
 * webUiFeatureOptions - Lifecycle coordinator for the feature options webUI.
 *
 * Boots the reactive state container, registers every effect (persist, theme, tokens, keyboard) and mounts every view (header, device info, nav, search, options,
 * connection error) once the page becomes active. Tears down the entire system in one operation on cleanup by aborting the page-level signal: every effect's
 * subscription and every view's listener was registered with `{signal}`, so abort cascades through them automatically.
 *
 * Public API: constructor takes the same options shape, `show()` reveals the UI, `hide()` is the navigate-away (it flushes any pending edit, then tears down),
 * `cleanup()` is immediate destructive teardown (may drop an unsaved debounced edit; for forced/synchronous disposal), `getHomebridgeDevices()` is the default
 * device source. The device-list contract is rich: a `getDevices` hook resolves a {@link DeviceListResult} carrying both the device array and the connection
 * outcome, and `getHomebridgeDevices` resolves the same shape.
 *
 * Internally, the store owns per-show state, effects own side effects, views own DOM, and the orchestrator is the lifecycle seam that boots and tears them down. The one
 * piece of state it keeps itself is #initialOptions - the revert-to-saved snapshot - which must outlive the store's per-show() reset; all else flows through the store.
 *
 * @example
 *
 * // The orchestrator opens the config session and hands it to show(); the plugin hooks receive their config injected (never reaching for it).
 * const session = await PluginConfigSession.open({ host: homebridge, name: "My Plugin" });
 * const featureOptionsUI = new webUiFeatureOptions({
 *   getControllers: ({ config }) => myPlugin.controllersFrom(config),
 *   getDevices: async (controller, { config }) => controller ? { devices: await myPlugin.getDevices(controller, config), error: "" } : { devices: [], error: "" },
 *   ui: {
 *     isController: (device) => device?.type === "controller",
 *     validOption: (device, option) => device?.type !== "controller" || !option.name.startsWith("Video.")
 *   }
 * });
 *
 * await featureOptionsUI.show(session);
 *
 * // Later, when navigating away (persists any pending edit, then tears down):
 * await featureOptionsUI.hide();
 */
export class webUiFeatureOptions {

  // Plugin-provided configuration captured at construction. Threaded through to effects and views at mount time via closures; never mutated after the constructor
  // returns.
  #config;

  // The persist effect's flush handle, captured when the effect is registered in show(). hide() awaits it (bounded) to drain any debounced-but-unwritten edit to disk
  // before tearing the page down; the visibilitychange handler fires it best-effort on browser background/close. Recreated on every show(); nulled out on cleanup().
  #flushPersist;

  // The page-level abort controller. Aborting it tears down every effect and every view in one operation. Recreated on every show(); nulled out on cleanup().
  #pageAbort;

  // The plugin-config session, supplied by the orchestrator on show(). The single owner of the persisted config: the page reads its base config and persists option
  // edits through it. Held (not nulled on cleanup) so the editedConfig getter stays queryable after hide() / cleanup(), and re-used across show() cycles.
  #session;

  // The reactive state container. Created in show() with empty placeholder state; the loaded catalog and configured options arrive via the model:loaded dispatch, and
  // a fresh instance replaces the prior one on every show() call. Held (not nulled on cleanup) so the editedConfig getter stays queryable after hide() / cleanup(). The
  // orchestrator never reaches into store state for state management - all reads/writes go through dispatched actions and subscribed events.
  #store;

  // The configuredOptions array captured at the FIRST show()'s `model:loaded`. Survives subsequent cleanup() / show() cycles so a re-show that loads a set-equal
  // (possibly reordered) options array preserves the original snapshot for revert-to-saved. The set-equality probe in show() is the seam where this is decided.
  // Set on first model:loaded; updated only when the loaded options are NOT set-equal to the stored snapshot.
  #initialOptions;

  /**
   * Initialize the feature options webUI with customizable configuration.
   *
   * @param {FeatureOptionsConfig} options - Configuration options for the webUI.
   */
  constructor(options = {}) {

    const {

      getControllers = undefined,
      getDevices = this.getHomebridgeDevices,
      infoPanel = undefined,
      sidebar = {},
      ui = {}
    } = options;

    this.#config = {

      controllerRetryEnableDelayMs: ui.controllerRetryEnableDelayMs ?? 5000,
      getControllers,
      getDevices,
      infoPanel,
      labelControllers: sidebar.controllerLabel ?? "Controllers",
      labelDevices: sidebar.deviceLabel ?? "Devices",
      validators: {

        isController: ui.isController ?? (() => false),
        validOption: ui.validOption ?? (() => true),
        validOptionCategory: ui.validOptionCategory ?? (() => true)
      }
    };

    this.#flushPersist = null;
    this.#pageAbort = null;
    this.#session = null;
    this.#store = null;
    this.#initialOptions = null;
  }

  /**
   * The editing buffer: the persisted configuration with the primary platform entry's options replaced by the live, unsaved edits. This is deliberately NOT "the
   * config" - the persisted config is owned by the session; this view overlays the in-flight `configuredOptions` for any consumer that wants to see config-as-edited.
   * Returns an empty array before show() has supplied the session. Built fresh on each read - external consumers should not rely on reference equality across calls.
   *
   * Preserved as a getter (not a public field) so the implementation is free to change without breaking callers; the observable shape is what plugins might consume.
   *
   * @returns {readonly Object[]} The edited plugin-config array.
   */
  get editedConfig() {

    if(!this.#session) {

      return [];
    }

    // Before the store boots (or after a re-show that has not yet dispatched model:loaded) there are no live edits, so the buffer is just the persisted config with
    // the primary entry's own saved options. Once the store is live, the in-flight configuredOptions override them.
    const options = this.#store ? this.#store.state.configuredOptions : (this.#session.platform.options ?? []);

    return [ { ...this.#session.platform, options }, ...this.#session.entries.slice(1) ];
  }

  /**
   * Render the feature options webUI. The main entry point.
   *
   * Boot sequence:
   *
   *   1. Synchronous page-shell setup: hide schema form, update menu state, reveal the feature-options page. The user sees the layout immediately; the async I/O
   *      below populates each region against the visible shell.
   *   2. Tear down any prior show() cycle via hide() (it flushes any pending edit before tearing down), then re-sync the session against the host config; a sync
   *      failure toasts the error message and bails.
   *   3. Create the page abort controller. Every effect and view registers listeners with this signal so cleanup() tears them all down in one operation.
   *   4. Fire the plugin I/O requests in parallel: controllers (if configured) and the feature catalog. The plugin config is already held by the session, so there
   *      is no config fetch to overlap here - the base options come from the session's primary entry.
   *   5. Adopt the design tokens. Synchronous - tokens are static declarations with no I/O dependencies.
   *   6. Fire the theme effect, persist effect, keyboard effect in parallel. The theme effect's I/O (Bootstrap probe) runs in the background.
   *   7. Once controllers resolves: if controller-based mode with empty controllers, show the no-controllers message and return.
   *   8. Pre-fire the devices fetch for the initial controller so it overlaps with the feature catalog.
   *   9. Once the feature catalog resolves: build the catalog, dispatch model:loaded, mount all views.
   *  10. Once devices resolve: dispatch devices:loaded. If a controller is selected and the result carried a connection-failure error, dispatch connection:error
   *      with that message and return; otherwise set the initial scope.
   *  11. Reveal regions that views render into.
   *
   * @param {import("./pluginConfigSession.mjs").PluginConfigSession} session - The config session supplied by the orchestrator; the page's single source of
   *        persisted config and the seam through which option edits are persisted.
   * @returns {Promise<void>}
   * @public
   */
  async show(session) {

    this.#session = session;

    homebridge.hideSchemaForm();
    updateMenuState();

    document.getElementById("pageSupport").style.display = "none";
    document.getElementById("pageFeatureOptions").style.display = "block";

    // Tear down any prior show() cycle first. hide() is now async (it flushes any pending edit from the prior cycle before aborting), so we await it: a re-show via
    // the menu or the connection-error retry must drain the previous cycle's debounced edit before this cycle's store replaces it.
    await this.hide();

    // Re-read the host config into the session before the page renders against it. show() is the single entry chokepoint (launch, first-run, the menu, and the
    // connection-error retry), so re-syncing here makes "every show is fresh" an unconditional guarantee: an edit made in the Settings tab while this page was hidden
    // is reflected on return rather than rendering against a frozen snapshot. The sync lands before getControllers reads session.platform and before the options read
    // below, so both derive from the re-read config. A read failure surfaces as a toast and bails rather than rejecting into a dropped-promise menu handler.
    try {

      await this.#session.sync();
    } catch(err) {

      homebridge.toast.error(err?.message ?? String(err), "Error");

      return;
    }

    // Fresh page-level abort controller for this show() cycle.
    this.#pageAbort = new AbortController();

    const signal = this.#pageAbort.signal;

    // Clear stale DOM from any prior cycle before the views start populating regions.
    clearContainers();

    // Initialize the store with empty state. The reducer transitions through loading -> ready once model:loaded dispatches.
    this.#store = new FeatureOptionsStore({ initialState: initialState(), reducer });

    // Fire every independent I/O in parallel. The independent sources: controllers (optional), the /getOptions catalog, and the Homebridge lighting mode (via the
    // theme effect's host). The plugin config is not fetched here - the session already holds it - so getControllers receives the injected platform config rather
    // than reaching for it. None depend on each other; firing them concurrently means total wall-clock time is bounded by the slowest.
    const featuresPromise = homebridge.request("/getOptions").then((response) => response ?? []);
    const controllersPromise = this.#config.getControllers ? this.#config.getControllers({ config: session.platform }) : Promise.resolve(null);

    // Adopt design tokens. Synchronous; must run before any consumer references `var(--fo-*)`.
    registerTokensEffect({ signal });

    // Theme effect (async background work for Bootstrap probe; sync stylesheet adoption). Held as a promise so we can await it before the matchMedia listener is
    // registered against any user interaction, but the bulk of init's work overlaps the data fetches below.
    const themeInitPromise = registerThemeEffect({ host: homebridge, signal });

    // Persist + keyboard effects: register early so they catch any dispatch from the moment model:loaded fires. The persist effect's reference-equality dirty
    // check skips the immediate-run pass since configuredOptions and persistedAnchor share the same empty-array reference in the initial state. We capture the
    // persist effect's flush handle so hide() (and the visibilitychange handler below) can drain a debounced-but-unwritten edit before the page tears down.
    this.#flushPersist = registerPersistEffect({ host: homebridge, session, signal, store: this.#store })?.flush ?? null;
    registerKeyboardEffect({ signal, store: this.#store });

    // Best-effort browser-exit flush. When the tab is backgrounded or closing while the page is still alive, drain any pending edit so it reaches the host's config
    // model. This is fire-and-forget (the page is hidden/closing with no user present to see it, so an error toast the persist drain may raise on a failed final
    // write lands unseen) and page-signal-keyed so it tears down with the cycle. The instant-hard-close residual (an async write cannot be guaranteed to complete
    // during an immediate unload) is documented and accepted.
    document.addEventListener("visibilitychange", () => {

      if(document.visibilityState === "hidden") {

        void this.#flushPersist?.();
      }
    }, { signal });

    // Wait for controllers (if configured). Empty result in controller-based mode means "no controllers configured" - we show the helper text and bail.
    const controllers = await controllersPromise;

    if(signal.aborted) {

      return;
    }

    if(this.#config.getControllers && (!controllers || (controllers.length === 0))) {

      showNoControllersMessage();

      return;
    }

    const initialController = controllers?.[0] ?? null;
    const devicesPromise = this.#devicesFor(initialController);

    // Wait for the feature catalog. Build the catalog (catalog index + validators) and dispatch model:loaded so the store transitions to "ready" and views can mount
    // against a populated state. The configured options come from the session's primary entry - the persisted config the orchestrator already loaded.
    const features = await featuresPromise;

    if(signal.aborted) {

      return;
    }

    const loadedOptions = Array.isArray(session.platform?.options) ? session.platform.options : [];
    const catalog = {

      ...buildCatalogIndex(features.categories ?? [], features.options ?? {}),

      validators: this.#config.validators
    };

    // Snapshot for revert-to-saved. Preserved across show() / cleanup() cycles when the re-loaded options are set-equal to the prior snapshot (the user reordered
    // entries but did not save) - this means a revert after re-show restores the original order rather than the reloaded order. First show() sets the snapshot
    // to the just-loaded array; subsequent shows preserve it only when set-equal.
    if(!this.#initialOptions || !sameOptionsSet(this.#initialOptions, loadedOptions)) {

      this.#initialOptions = [...loadedOptions];
    }

    this.#store.dispatch({

      catalog,
      configuredOptions: loadedOptions,
      controllers: controllers ?? [],
      initialOptions: this.#initialOptions,
      mode: this.#config.getControllers ? "controller-based" : "device-only",
      type: "model:loaded"
    });

    // Mount every view. Each mount is a no-op if its required page element is missing, so the orchestrator does not need to validate the page skeleton up front.
    this.#mountViews(signal);

    // Wait for the theme's matchMedia listener registration before any user interaction can trigger a theme change. By this point, themeInitPromise has almost
    // always already resolved - it ran in parallel with every other fetch above.
    await themeInitPromise;

    if(signal.aborted) {

      return;
    }

    // Wait for devices. The fetch overlapped with config + features; typically already resolved by now.
    const { devices, error } = await devicesPromise;

    if(signal.aborted) {

      return;
    }

    this.#store.dispatch({ controllerId: initialController?.serialNumber ?? null, devices, type: "devices:loaded" });

    // Connection-error short-circuit: a selected controller whose probe reported a failure. The failure message arrives with the device-list response - it travels
    // back on the DeviceListResult rather than through a separate request - so a non-empty error is the failure signal and dispatching connection:error hands the
    // header to the connection-error view. A zero-device result with an empty error is a legitimately empty controller and falls through to the scope logic below,
    // never the connection-error view. Do not transition the scope to a device-view here (there are no devices); leave it at global so any subsequent retry re-shows
    // from a known scope.
    if((initialController !== null) && error.length) {

      this.#store.dispatch({ message: error, type: "connection:error" });

      // The connection-error view reveals #headerInfo itself when it renders the error block (it is the sole owner of the error display, content and reveal together),
      // so the orchestrator only transitions state here and returns. The sidebar, search panel, and config table stay hidden - hide() set them so at show() start and
      // the success-path revealRegions() never runs on this branch - because the user has no devices to navigate to.
      return;
    }

    // Set the initial scope. Controller-based mode lands on the first controller's controller-as-device entry (devices[0]). Device-only mode lands on global so
    // the user sees the global options first.
    if((initialController !== null) && (devices.length > 0)) {

      this.#store.dispatch({

        scope: { controllerId: initialController.serialNumber, deviceId: devices[0].serialNumber, kind: "device" },
        type: "scope:changed"
      });
    } else {

      // Re-dispatch the global scope to fire the view-options scope-render. The initial state.scope is already global, but views subscribe to scope:changed; without
      // an explicit dispatch, view-options would not run its render path.
      this.#store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });
    }

    // Reveal regions that views render into.
    revealRegions();
  }

  /**
   * Drain any debounced-but-unwritten edit to disk, bounded so a stalled host write cannot hang teardown. Shared by every flushed-teardown path - currently
   * `hide()` (navigate-away) and `[Symbol.asyncDispose]` (scope-exit) - because each must flush BEFORE the page signal is aborted: the persist drain guards on it, so
   * aborting first (as the synchronous `cleanup()` does) would re-introduce the very edit-drop this exists to prevent. Races the flush against a non-rejecting
   * {@link FLUSH_TEARDOWN_TIMEOUT_MS} timeout - delay(ms) with no signal simply resolves after ms, so the race settles on whichever finishes first without ever
   * rejecting. On timeout the in-flight commit continues independently and still lands if the host recovers; under that host-stall trade the no-hang guarantee
   * supersedes same-switch Settings-freshness.
   *
   * @returns {Promise<void>}
   */
  async #flushPending() {

    await Promise.race([ this.#flushPersist?.() ?? Promise.resolve(), delay(FLUSH_TEARDOWN_TIMEOUT_MS) ]);
  }

  /**
   * Hide the feature options webUI - the navigate-away chokepoint. Flushes any pending edit to disk (see `#flushPending`), then visually hides the regions, then tears
   * down. The flush precedes the teardown so a debounced-but-unwritten edit reaches the host before the page signal aborts.
   *
   * @returns {Promise<void>}
   * @public
   */
  async hide() {

    await this.#flushPending();

    for(const id of [ "deviceStatsContainer", "headerInfo", "optionsContainer", "search", "sidebar" ]) {

      const element = document.getElementById(id);

      if(element) {

        element.style.display = "none";
      }
    }

    this.cleanup();
  }

  /**
   * Clean up all resources when the instance is no longer needed - immediate, destructive teardown. May drop a debounced-but-unwritten edit: it aborts the page
   * signal without flushing, so any pending drain that guards on the signal bails. Use {@link hide} for the navigate-away path (it flushes first); cleanup() is for
   * forced/synchronous disposal.
   *
   * Aborts the page-level signal (cascading through every effect and view's signal-keyed listeners), nulls the abort controller and the flush handle so the next
   * show() builds fresh ones. Neither the store nor the session is nulled: the `editedConfig` getter remains queryable after hide() / cleanup() so external readers
   * see the last-loaded state rather than an empty array. The next show() replaces the store with a fresh one before any new mutations.
   *
   * @public
   */
  cleanup() {

    this.#pageAbort?.abort();
    this.#pageAbort = null;
    this.#flushPersist = null;

    const searchInput = document.getElementById("searchInput");

    if(searchInput) {

      searchInput.value = "";
    }
  }

  /**
   * Explicit-disposable hook. Lets callers use `using orchestrator = new webUiFeatureOptions(...)` to guarantee teardown at scope exit - the runtime calls this
   * automatically when the binding goes out of scope. Equivalent to invoking {@link cleanup} directly.
   *
   * This is the SYNCHRONOUS disposal path: a `using` scope-exit cannot await, so it forfeits the flush and may drop a debounced-but-unwritten edit. That is acceptable
   * for forced teardown, but it is not a navigate-away path - the menu/tab handlers use {@link hide}. When the edit MUST survive scope-exit, prefer `await using` so the
   * runtime selects `[Symbol.asyncDispose]`, which flushes first.
   */
  [Symbol.dispose]() {

    this.cleanup();
  }

  /**
   * Async-disposable hook. Lets callers use `await using orchestrator = new webUiFeatureOptions(...)` to guarantee a FLUSHED teardown at scope exit - the runtime awaits
   * this when the binding goes out of scope. The async counterpart of the synchronous `[Symbol.dispose]`: it drains any pending edit via `#flushPending` before tearing
   * down, where the synchronous path cannot await and forfeits the flush. It mirrors `hide()`'s flush-then-teardown ordering minus the region-hiding, which is a
   * navigate-away concern rather than a disposal one.
   *
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {

    await this.#flushPending();
    this.cleanup();
  }

  /**
   * Default method for retrieving the device list from the Homebridge accessory cache. Plugins override via the constructor's `getDevices` option.
   *
   * Used as the default `getDevices`, it is extracted unbound and later invoked with `#config` as the receiver, so its body must never reference `this` - it reads only
   * the global `homebridge` object. A future edit that needs instance state must bind it explicitly (or stop using it as the bare default).
   *
   * The device-only default always succeeds against the local accessory cache, so the {@link DeviceListResult} it resolves carries an empty error.
   *
   * @returns {Promise<DeviceListResult>} The device list sorted alphabetically by name, paired with an empty error.
   * @public
   */
  async getHomebridgeDevices() {

    const cachedAccessories = await homebridge.getCachedAccessories();
    const devices = [];

    for(const device of cachedAccessories) {

      const info = device.services.find((s) => s.constructorName === "AccessoryInformation");
      const getCharValue = (name) => info?.characteristics.find((c) => c.constructorName === name)?.value ?? "";

      devices.push({

        firmwareRevision: getCharValue("FirmwareRevision"),
        manufacturer: getCharValue("Manufacturer"),
        model: getCharValue("Model"),
        name: device.displayName,
        serialNumber: getCharValue("SerialNumber")
      });
    }

    return { devices: devices.toSorted((a, b) => (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase())), error: "" };
  }

  // Mount every view against the active store and page DOM. Each view registers its own listeners with the page signal; nothing here references the views after
  // they are mounted (the store + signal drive their lifecycle).
  #mountViews(signal) {

    const store = this.#store;
    const headerInfo = document.getElementById("headerInfo");
    const deviceStatsContainer = document.getElementById("deviceStatsContainer");
    const searchPanel = document.getElementById("search");
    const configTable = document.getElementById("configTable");
    const controllersContainer = document.getElementById("controllersContainer");
    const devicesContainer = document.getElementById("devicesContainer");

    if(headerInfo) {

      mountHeaderView({ root: headerInfo, signal, store });

      mountConnectionErrorView({

        // Retry routes through show(), which owns teardown: its internal `await this.hide()` flushes any debounced edit before aborting the page signal, so a retry
        // cannot drop a pending write. We deliberately do not call cleanup() here - cleanup() aborts the signal without flushing, which is exactly the drop we avoid.
        // The retry button fires this as `void onRetry()`, so a rejection is otherwise unobserved; the try/catch surfaces a failed re-show as an error toast instead.
        onRetry: async () => {

          try {

            await this.show(this.#session);
          } catch(err) {

            toastError(err);
          }
        },
        retryDelayMs: this.#config.controllerRetryEnableDelayMs,
        root: headerInfo,
        signal,
        store
      });
    }

    if(deviceStatsContainer) {

      const infoPanel = this.#config.infoPanel;

      mountDeviceInfoView({

        infoPanel: infoPanel ? (panel, device) => infoPanel.call(this, device, panel) : undefined,
        root: deviceStatsContainer,
        signal,
        store
      });
    }

    if(searchPanel && configTable) {

      mountSearchView({ configTable, root: searchPanel, signal, store });
    }

    if(configTable) {

      // The localStorage namespace key is the Homebridge platform identifier - the primary entry's `platform` field, read from the session.
      mountOptionsView({ configTable, platform: this.#session?.platform?.platform, signal, store });
    }

    if(controllersContainer && devicesContainer) {

      mountNavView({

        getDevices: (controller) => this.#devicesFor(controller),
        labelControllers: this.#config.labelControllers,
        labelDevices: this.#config.labelDevices,
        rootControllers: controllersContainer,
        rootDevices: devicesContainer,
        signal,
        store
      });
    }
  }

  // Resolve a controller's DeviceListResult, injecting the live platform config the plugin's getDevices needs to recover the controller's credentials. This is the
  // single seam every device fetch crosses - the initial fetch in show() and the on-click fetch in the nav view both route through it - and the config is read fresh
  // from the session on every call, never captured, so a credential change is always reflected. The default device-only getDevices ignores the injected config.
  //
  // The full rich contract is enforced here with a fail-fast guard: the hook must resolve an object carrying a `devices` array and a string `error`. The error half
  // is what guarantees every downstream reader (the connection-error view's DOM construction, whose createElement child loop passes a non-string message straight to
  // appendChild) receives a string. A resolved value that does not match trips a TypeError naming the contract, so a shape mistake surfaces loudly at the seam rather
  // than as a corrupted render deeper in.
  async #devicesFor(controller) {

    const result = await this.#config.getDevices(controller, { config: this.#session?.platform });

    if(!result || !Array.isArray(result.devices) || (typeof result.error !== "string")) {

      throw new TypeError("getDevices must resolve to { devices, error }.");
    }

    return result;
  }
}

// Update the menu button states to reflect the current page. Swap between the elegant and primary button styles to show active/inactive.
const updateMenuState = () => {

  const menuStates = [

    { id: "menuHome", primary: true },
    { id: "menuFeatureOptions", primary: false },
    { id: "menuSettings", primary: true }
  ];

  for(const { id, primary } of menuStates) {

    const element = document.getElementById(id);

    if(!element) {

      continue;
    }

    element.classList.remove(primary ? "btn-elegant" : "btn-primary");
    element.classList.add(primary ? "btn-primary" : "btn-elegant");
  }
};

// Clear stale DOM from any prior cycle. Each region's view repopulates it.
const clearContainers = () => {

  for(const id of [ "controllersContainer", "devicesContainer", "configTable" ]) {

    const container = document.getElementById(id);

    if(container) {

      container.textContent = "";
    }
  }
};

// Reveal the regions every view renders into. The hide() path set these to display: none so the user did not see a half-built UI during teardown / rebuild.
const revealRegions = () => {

  for(const id of [ "sidebar", "deviceStatsContainer", "headerInfo", "optionsContainer", "search" ]) {

    const element = document.getElementById(id);

    if(element) {

      element.style.display = "";
    }
  }
};

// Set-wise equality on two string arrays. Used to decide whether a re-loaded options array represents a genuine save (different set) or a no-op reorder (same set).
// O(n) via Set.symmetricDifference; duplicate-insensitive matches buildConfigIndex's first-write-wins semantics for the configured-options array it operates over.
const sameOptionsSet = (a, b) => {

  if(a === b) {

    return true;
  }

  if(a.length !== b.length) {

    return false;
  }

  return new Set(a).symmetricDifference(new Set(b)).size === 0;
};

// Show the "no controllers configured" helper text when the plugin operates in controller-based mode but getControllers returns an empty result. Replaces the
// header content in place; the orchestrator returns from show() without dispatching model:loaded so views never mount.
const showNoControllersMessage = () => {

  const headerInfo = document.getElementById("headerInfo");

  if(headerInfo) {

    headerInfo.textContent = "Please configure a controller to access in the main settings tab before configuring feature options.";
    headerInfo.style.display = "";
  }
};
