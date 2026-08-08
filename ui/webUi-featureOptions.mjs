/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions.mjs: Lifecycle coordinator for the feature options webUI.
 */
"use strict";

import { DeadlineExpiredError, withDeadline } from "./webUi-liveness.mjs";
import { FeatureOptionsStore, effect } from "./webUi-featureOptions/store.mjs";
import { connectionFailureCopy, initialState, reducer } from "./webUi-featureOptions/state.mjs";
import { delay, errorMessage, swapMenuClasses, toastError } from "./webUi-featureOptions/utils.mjs";
import { buildCatalogIndex } from "./featureOptions.js";
import { modelLoaded } from "./webUi-featureOptions/selectors.mjs";
import { mountConnectionErrorView } from "./webUi-featureOptions/views/connectionError.mjs";
import { mountDeviceInfoView } from "./webUi-featureOptions/views/deviceInfo.mjs";
import { mountHeaderView } from "./webUi-featureOptions/views/header.mjs";
import { mountNavView } from "./webUi-featureOptions/views/nav.mjs";
import { mountOptionsView } from "./webUi-featureOptions/views/options.mjs";
import { mountSearchView } from "./webUi-featureOptions/views/search.mjs";
import { mountStatusPanelView } from "./webUi-featureOptions/views/statusPanel.mjs";
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
 * The deadline, in seconds, on every host await the page makes. The Homebridge UI bridge has no timeout of its own, so a relay that dies mid-flight leaves a call
 * pending forever and the page simply stops - a blank tab with no error, no console signal, and nothing to click. This bound is what makes that failure reachable.
 *
 * Thirty seconds is generous enough that a slow controller probe on a busy network never false-trips, and short enough that a dead bridge surfaces while the user is
 * still looking at the page. The asymmetry is what sets it: a false trip lands on the connection-error view's retry affordance and costs one click, while never
 * tripping costs the blank page. Deadlines clock per await site rather than against one shared boot budget, so a pathologically slow-but-alive boot can take several
 * consecutive windows - accepted, because each window ends in either progress or the retry view, and a shared budget would couple every await to every other one for a
 * case the retry view already bounds.
 */
export const BOOT_AWAIT_DEADLINE_SECONDS = 30;

// The page's content regions, in alphabetical id order. hide() sets each to display:none during teardown so the user never sees a half-built page; the coordinated
// end-of-load reveal restores them together. Both the teardown-hide loop and the reveal read this single list so the two can never drift.
const REGION_IDS = [ "deviceStatsContainer", "headerInfo", "optionsContainer", "search", "sidebar" ];

// The two regions global-only mode never reveals: the device sidebar and the precedence header bar. The reduced global-only reveal set is derived by filtering these
// out of REGION_IDS, so the reduced set can never name a region the full set does not.
const GLOBAL_ONLY_HIDDEN_REGION_IDS = [ "headerInfo", "sidebar" ];

// The regions global-only mode reveals: the full set minus the sidebar and header. Derived rather than hand-listed so a content region added to REGION_IDS extends the
// global-only reveal automatically.
const GLOBAL_ONLY_REGION_IDS = REGION_IDS.filter((id) => !GLOBAL_ONLY_HIDDEN_REGION_IDS.includes(id));

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
 * @property {boolean} [globalOnly=false] - Run the page as a single global-scope surface: no sidebar, no precedence header, and no device machinery. Scope is pinned to
 *   global for the page's life (the reducer refuses any other scope in this mode), and the {@link FeatureOptionsConfig.infoPanel} callback always receives an undefined
 *   device. Mutually exclusive with `getControllers`, an explicitly supplied `getDevices`, and `statusPanel` - each throws a TypeError at construction. The `sidebar`
 *   labels and `ui.isController` are inert here (isController's only consumer is the nav view's grouping filter, which never mounts), while `ui.validOption` and
 *   `ui.validOptionCategory` stay active and receive an undefined device. This is a UI declaration a plugin adopts only when its runtime evaluates options at global
 *   scope exclusively; any device- or controller-scoped entries already in the config remain there untouched and are not editable through this page. The page markup
 *   must keep the revealed content regions (`deviceStatsContainer`, `optionsContainer`, `search`) OUTSIDE the `#sidebar` and `#headerInfo` subtrees (the standard
 *   template's sibling layout): a region nested under a permanently-hidden ancestor cannot become visible, and the reveal path warns by name when it detects that shape.
 * @property {(args: { device: (Device|undefined), panel: HTMLElement, signal: AbortSignal }) => void} [infoPanel] - Renders the device-stats region for the current
 *   selection. It receives ONE options bag: `device` is the selection (undefined at global scope, and always undefined under
 *   {@link FeatureOptionsConfig.globalOnly}), `panel` is the `#deviceStatsContainer` element to render into, and `signal` is the mount's lifecycle signal. A hook
 *   written against two positional parameters `(device, panel)` is NOT compatible with this contract - it receives the bag as its first argument and reads undefined
 *   for both names, so it renders nothing rather than failing loudly; this is a documented breaking change to the published hook contract. The hook is re-invoked on
 *   every render of a mount while the bag's `signal` stays one identity for that mount's life, so a hook that registers listeners or subscriptions registers them
 *   once against that signal and they die with the mount.
 *   That signal is the mount's lifetime, so a resource belonging to the module copy rather than to this panel is scoped to {@link webUi.epochSignal} instead when
 *   the page is driven by a `webUi` instance - a standalone instance of this class has no page epoch and therefore no copy lifetime to scope to. The rule for
 *   choosing between the two lives on that getter.
 * @property {() => void} [onOptionsEdited] - Invoked after the store state has transitioned for any option mutation (an option set or cleared, the options reset,
 *   or the model reverted), so a consumer reading editedConfig from inside the callback sees the post-edit state. Invoked once per mutation with no arguments and no
 *   debounce; a consumer that needs coalescing applies its own.
 * @property {Object} [sidebar] - Sidebar configuration options.
 * @property {string} [sidebar.controllerLabel="Controllers"] - Label for the controllers section.
 * @property {Function} [sidebar.deviceContent] - Synchronous hook supplying a device link's rendered content: `(device) => Node | string | null`. Invoked once per
 *   device per sidebar build with the same device object the plugin's own `getDevices` produced, so any field that hook attached is available here. A returned Node
 *   or string renders as the link's content in place of the device name; null or undefined falls through to the default name rendering, so a plugin may adorn some
 *   devices and leave the rest alone. The framework keeps the link element itself - its identity attributes, classes, click handling, and highlight - so the
 *   content must be presentational: interactive elements inside it would fight the link's own delegated click. Controller links are outside this hook's reach; they
 *   render their names plainly.
 * @property {string} [sidebar.deviceLabel="Devices"] - Label for the devices section.
 * @property {Object} [statusPanel] - Live device-status panel for the device-stats region. Mutually exclusive with {@link FeatureOptionsConfig.infoPanel} (both own
 *   that region, so supplying both throws a TypeError at construction). The plugin supplies a server-side status adapter that speaks the `webui-status` protocol plus
 *   the parts below, and inherits the entire rendered panel.
 * @property {Object} [statusPanel.errorMessages] - Per-reason error-copy overrides, merged field-by-field over the component's credential-neutral defaults so a plugin
 *   may replace a label, a message, or both.
 * @property {Function} [statusPanel.identity] - Maps a device to its identity fields (`{ label, mono?, value }[]`). Defaults to firmware / serial number / model /
 *   manufacturer; a `mono` field renders its value in the monospace token.
 * @property {Object} [statusPanel.linkLostMessage] - Override copy for the browser-detected link-lost state (`{ label?, message? }`), merged field-by-field over the
 *   component default so a plugin may replace the label, the message, or both. One state, one object - not a reason-keyed table like errorMessages. A plugin overriding
 *   the label owns its width consequence: the Status sizer reserves the default label.
 * @property {number} [statusPanel.linkLostTimeoutSeconds] - Deadline in seconds before a watched bridge request with no liveness evidence reads as a lost link. A
 *   missing, zero, negative, or non-finite value falls back to the component default of 10 seconds.
 * @property {Function} [statusPanel.onServerHello] - Invoked when a fresh adapter process introduces itself (its hello generation differs from the last seen), after
 *   the panel clears its stale-push floors. The plugin re-elicits its feed here; the callback fires once per fresh generation, must be cheap, and must tolerate firing
 *   before any device is viewed or concurrently with the plugin's own elicitation.
 * @property {Object[]} [statusPanel.placeholderRows] - Row templates (id / label / sizer / optional latch, no value) the skeleton renders before the first snapshot.
 *   Defaults to `[]`, so an unconfigured skeleton shows the identity and Status cells only and the state rows arrive with the first snapshot.
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
 * Public API: constructor takes the same options shape, `show()` reveals the UI, `refreshControllers()` repaints the controller sidebar after an explicit user
 * action without re-entering the whole show() cycle, `hide()` is the navigate-away (it flushes any pending edit, then tears down), `cleanup()` is immediate
 * destructive teardown (may drop an unsaved debounced edit; for forced/synchronous disposal), `getHomebridgeDevices()` is the default device source. The device-list
 * contract is rich: a `getDevices` hook resolves a {@link DeviceListResult} carrying both the device array and the connection outcome, and `getHomebridgeDevices`
 * resolves the same shape.
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

  /**
   * The live status-panel handle from the most recent show() cycle, or null before the first show() and whenever no statusPanel is configured. Reassigned to a fresh
   * handle on every show() cycle and deliberately NOT nulled on cleanup() (the store / session precedent): callers re-read `featureOptions.statusPanel` at each use
   * rather than capturing it, and a stale handle stays harmless by construction - its `resetStaleGuards` clears a dead closure's map, and its `watchRequest` reads the
   * dead mount's already-aborted signal at call time and returns before arming any timer.
   *
   * @type {{ resetStaleGuards: () => void, watchRequest: (request: (Promise<unknown> | unknown)) => void } | null}
   */
  statusPanel = null;

  // Plugin-provided configuration captured at construction. Threaded through to effects and views at mount time via closures; never mutated after the constructor
  // returns.
  #config;

  // The page epoch, supplied by the orchestrator that owns the page lifetime. It aborts when a newer page copy claims the window, which is the one supersession this
  // instance cannot observe for itself. Every cycle show() mints composes itself into it; a directly-constructed instance holds undefined and the composition no-ops.
  #epochSignal;

  // The persist effect's flush handle, captured when the effect is registered in show(). hide() awaits it (bounded) to drain any debounced-but-unwritten edit to disk
  // before tearing the page down; the visibilitychange handler fires it best-effort on browser background/close. Recreated on every show(); nulled out on cleanup().
  #flushPersist;

  // The page-level abort controller. Aborting it tears down every effect and every view in one operation. Recreated on every show(); nulled out on cleanup().
  #pageAbort;

  // The page's resume detector, supplied by the orchestrator that owns the page lifetime. Threaded to the views that probe on a resume and otherwise untouched; when
  // it is absent - a directly-constructed instance, as every test call site is - no view subscribes and no resume timer ever runs.
  #resumeDetector;

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
   * Framework wiring arrives through the SECOND parameter rather than the plugin's options bag, because the two are different kinds of thing: the first parameter is
   * what a plugin author writes, the second is what the page orchestrator hands down. Keeping them apart means a plugin's option surface never grows a slot only the
   * framework can fill, and the wiring stays optional - an instance constructed without it simply subscribes to nothing.
   *
   * @param {FeatureOptionsConfig} options - Configuration options for the webUI.
   * @param {Object} [wiring] - Framework wiring supplied by the page orchestrator.
   * @param {AbortSignal} [wiring.epochSignal] - The page epoch, aborted when a newer page copy claims the window. Every show() cycle composes itself into it, so a
   *                                             superseded copy tears down whole. Absent means no cycle is epoch-bounded.
   * @param {{ subscribe: Function }} [wiring.resumeDetector] - The page's resume detector, threaded to the views that probe on a resume. Absent means no view
   *                                                            subscribes to resumes.
   */
  constructor(options = {}, { epochSignal = undefined, resumeDetector = undefined } = {}) {

    const {

      getControllers = undefined,
      getDevices = undefined,
      globalOnly = false,
      infoPanel = undefined,
      onOptionsEdited = undefined,
      sidebar = {},
      statusPanel = undefined,
      ui = {}
    } = options;

    // The page's construction contracts, each a configuration that cannot be honored. Evaluated in order; the first violated row throws a TypeError naming the problem
    // at the plugin-author boundary rather than surfacing as a silent mis-mount or a dead device view, and the throw lands through the page's boot monitor. Global-only
    // mode runs the page at global scope with no device machinery, so every device- or controller-facing hook contradicts it (getDevices is destructured without a
    // default, so the un-defaulted binding being defined is the exact "explicitly supplied" test); the device-stats region has a single owner, so infoPanel and
    // statusPanel cannot both claim it; and framework wiring parked in the plugin bag would be silently ignored, so the misplacement is named instead.
    const contradictions = [

      {

        message: "globalOnly and getControllers are mutually exclusive - global-only mode mounts no controller navigation.",
        violated: globalOnly && (getControllers !== undefined)
      },
      {

        message: "globalOnly and getDevices are mutually exclusive - global-only mode fetches no devices.",
        violated: globalOnly && (getDevices !== undefined)
      },
      {

        message: "globalOnly and statusPanel are mutually exclusive - global-only mode mounts no device-stats panel.",
        violated: globalOnly && (statusPanel !== undefined)
      },
      {

        message: "infoPanel and statusPanel are mutually exclusive - the device-stats region has a single owner.",
        violated: Boolean(infoPanel) && Boolean(statusPanel)
      },
      {

        message: "epochSignal is framework wiring, not a plugin option - pass it in the constructor's second parameter.",
        violated: "epochSignal" in options
      },
      {

        message: "resumeDetector is framework wiring, not a plugin option - pass it in the constructor's second parameter.",
        violated: "resumeDetector" in options
      }
    ];

    for(const { message, violated } of contradictions) {

      if(violated) {

        throw new TypeError(message);
      }
    }

    this.#config = {

      controllerRetryEnableDelayMs: ui.controllerRetryEnableDelayMs ?? 5000,
      getControllers,

      // The device-only default applies here rather than at the destructure so the guard table above can tell an explicitly-supplied getDevices (which contradicts
      // globalOnly) from the unset default. An explicit undefined takes the default; an explicit null is preserved and keeps its current fail-at-call-site behavior
      // (the #devicesFor contract guard trips on it), which is why this is an explicit undefined test and deliberately not `??`.
      getDevices: (getDevices === undefined) ? this.getHomebridgeDevices : getDevices,
      globalOnly,
      infoPanel,
      labelControllers: sidebar.controllerLabel ?? "Controllers",
      labelDevices: sidebar.deviceLabel ?? "Devices",
      onOptionsEdited,
      renderDeviceContent: sidebar.deviceContent,
      statusPanel,
      validators: {

        isController: ui.isController ?? (() => false),
        validOption: ui.validOption ?? (() => true),
        validOptionCategory: ui.validOptionCategory ?? (() => true)
      }
    };

    this.#epochSignal = epochSignal;
    this.#flushPersist = null;
    this.#pageAbort = null;
    this.#resumeDetector = resumeDetector;
    this.#session = null;
    this.#store = null;
    this.#initialOptions = null;
  }

  /**
   * The editing buffer: the persisted configuration with the primary platform entry's options replaced by the live, unsaved edits. This is deliberately NOT "the
   * config" - the persisted config is owned by the session; this view overlays the in-flight `configuredOptions` for any consumer that wants to see config-as-edited.
   * Returns an empty array before show() has supplied the session. Built fresh on each read - external consumers should not rely on reference equality across calls.
   *
   * The primary entry's options track the lifecycle. While a session is held whose store has not loaded its model - the whole span between show()'s session
   * assignment and its `model:loaded` dispatch, every bail that resolves the page short of that dispatch included - they are the session's saved options: there are
   * no edits to overlay yet, and the saved set is what the persisted config holds. Once the model is loaded they are the store's live `configuredOptions`.
   *
   * Preserved as a getter (not a public field) so the implementation is free to change without breaking callers; the observable shape is what plugins might consume.
   *
   * @returns {readonly Object[]} The edited plugin-config array.
   */
  get editedConfig() {

    if(!this.#session) {

      return [];
    }

    // The store's options are the overlay only once it has loaded its model. Ahead of that it carries the placeholder state, whose empty options array describes
    // nothing the user configured and would misreport a configured plugin as an unconfigured one; the session's own saved options are what the config actually
    // holds through that whole phase, and they are also what the pre-store read returns, so one expression serves both.
    const options = (this.#store && modelLoaded(this.#store.state)) ? this.#store.state.configuredOptions : (this.#session.platform.options ?? []);

    return [ { ...this.#session.platform, options }, ...this.#session.entries.slice(1) ];
  }

  /**
   * Render the feature options webUI. The main entry point.
   *
   * Boot sequence:
   *
   *   1. Synchronous page-shell setup: hide schema form, update menu state, reveal the feature-options page. The user sees the layout immediately; the async I/O
   *      below populates each region against the visible shell.
   *   2. Tear down any prior show() cycle via hide() (it flushes any pending edit before tearing down).
   *   3. Create the page abort controller, clear stale containers, create the store, and mount every view. The views mount here - before any data loads, against the
   *      loading placeholder - so the connection-error view already exists to render a config-sync failure into the visible shell.
   *   4. Re-sync the session against the host config. A read failure routes into the connection-error view (with the config-read copy) and bails, so a failed sync
   *      shows the retry affordance rather than stranding a blank frame; the sync also lands before getControllers and the options read below, so both see fresh config.
   *   5. Fire the plugin I/O requests in parallel: controllers (if configured) and the feature catalog. The plugin config is already held by the session, so there
   *      is no config fetch to overlap here - the base options come from the session's primary entry.
   *   6. Adopt the design tokens (synchronous), then fire the theme, persist, and keyboard effects. The theme effect's I/O (Bootstrap probe) runs in the background.
   *   7. Once controllers resolves: if controller-based mode with empty controllers, show the no-controllers message and return.
   *   8. In the device-bearing modes, record and pre-fire the initial controller's devices fetch (a `devices:requested` mints its sequence) so it overlaps with the
   *      feature catalog. Global-only mode skips this step - it fetches no devices.
   *   9. Once the feature catalog resolves: build the catalog and dispatch model:loaded - the mounted views transition off their loading placeholder and render.
   *  10. Global-only mode ends here: after the theme settles it clears #headerInfo (the header view that reclaims it in the other modes never mounts) and reveals the
   *      reduced region set - everything but the sidebar and header - then returns. The device-bearing modes continue: once devices resolve, dispatch devices:loaded
   *      carrying the outcome and its sequence. The reducer applies it only when it still answers the pending request and folds a fetch failure into the
   *      connection-error transition; the orchestrator gates its follow-ups on that verdict - a superseded outcome or a connection-error status returns without
   *      revealing, otherwise it sets the initial scope.
   *  11. Reveal the full region set the views render into.
   *
   * @param {import("./pluginConfigSession.mjs").PluginConfigSession} session - The config session supplied by the orchestrator; the page's single source of
   *        persisted config and the seam through which option edits are persisted.
   * @returns {Promise<void>}
   * @public
   */
  async show(session) {

    // A superseded copy can still reach this method: its launch was stalled on a session open when the reopen replaced it, and the open settles - healed or expired -
    // long afterwards and calls through. Every statement below is a side effect on shared page DOM the successor has already rendered into, clearContainers() above
    // all, so the bail is the first thing here rather than a check further down: a zombie cycle must do nothing at all, not do less.
    if(this.#epochSignal?.aborted) {

      return;
    }

    this.#session = session;

    homebridge.hideSchemaForm();
    updateMenuState();

    document.getElementById("pageSupport").style.display = "none";
    document.getElementById("pageFeatureOptions").style.display = "block";

    // Tear down any prior show() cycle first. hide() is now async (it flushes any pending edit from the prior cycle before aborting), so we await it: a re-show via
    // the menu or the connection-error retry must drain the previous cycle's debounced edit before this cycle's store replaces it.
    await this.hide();

    // Fresh page-level abort controller for this show() cycle.
    this.#pageAbort = new AbortController();

    /* Compose this cycle into the page epoch, so a supersession tears the whole cycle down through the machinery every effect and view already rides rather than
     * through any new signal plumbing. What that reaches matters most for the listeners registered on objects that OUTLIVE a module copy - statusPanel's
     * STATUS_EVENT subscription on the `homebridge` host object above all - because an un-retired cycle keeps rendering pushes into detached DOM and arming latch
     * timers for as long as the frame lives.
     *
     * The forwarding is minted per cycle rather than once at construction because #pageAbort is a per-cycle resource: it is null until the first show(), and an
     * AbortController dispatches abort exactly once, so a construction-time listener would spend itself against null whenever supersession landed in the pre-launch
     * window - which is precisely the window a stalled session open holds open. Registering it on the cycle's own signal is what keeps each listener to the one
     * generation it guards: it dies with that generation, and the next show() mints a fresh one.
     */
    this.#epochSignal?.addEventListener("abort", () => this.#pageAbort?.abort(), { once: true, signal: this.#pageAbort.signal });

    const signal = this.#pageAbort.signal;

    // Clear stale DOM from any prior cycle before the views start populating regions.
    clearContainers();

    // Initialize the store with empty state. The reducer transitions through loading -> ready once model:loaded dispatches.
    this.#store = new FeatureOptionsStore({ initialState: initialState(), reducer });

    // Mount every view before any data loads. Each view registers its effects against the loading placeholder and yields until model:loaded fires, so mounting
    // here renders nothing yet - but the connection-error view exists from this point on, so a config-sync failure below renders its retry affordance instead of
    // stranding a blank frame. Each mount is a no-op if its required page element is missing, so the orchestrator does not need to validate the page skeleton up front.
    this.#mountViews(signal);

    // Re-read the host config into the session before the page renders against it. show() is the single entry chokepoint (launch, first-run, the menu, and the
    // connection-error retry), so re-syncing here makes "every show is fresh" an unconditional guarantee: an edit made in the Settings tab while this page was hidden
    // is reflected on return rather than rendering against a frozen snapshot. The sync lands before getControllers reads session.platform and before the options read
    // below, so both derive from the re-read config. A read failure routes into the already-mounted connection-error view rather than a bare toast: the store and
    // views exist by now, so the page shows the retry affordance instead of stranding a blank frame.
    try {

      await withDeadline({ promise: this.#session.sync(), seconds: BOOT_AWAIT_DEADLINE_SECONDS, signal });
    } catch(err) {

      this.#failConnection({ err, signal, site: "sync" });

      return;
    }

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

    // Notify the plugin's optional edit hook after any option mutation has transitioned the store, so a consumer reading editedConfig from inside the callback sees
    // the post-edit state. We subscribe to exactly the four mutation events the persist effect writes to disk (see effects/persist.mjs); the two subscriptions must
    // stay in lockstep, since every mutation the persist effect commits is one the consumer should hear about. The effect() immediate-run pass hands the body
    // `undefined`, so we notify only on a real dispatch, never at registration before model:loaded. Registered on the page signal so teardown detaches it.
    effect({

      events: [ "option:set", "option:cleared", "options:reset", "model:reverted" ],
      fn: (action) => {

        if(action) {

          this.#config.onOptionsEdited?.();
        }
      },
      signal,
      store: this.#store
    });

    // Best-effort browser-exit flush. When the tab is backgrounded or closing while the page is still alive, drain any pending edit so it reaches the host's config
    // model. This is fire-and-forget (the page is hidden/closing with no user present to see it, so an error toast the persist drain may raise on a failed final
    // write lands unseen) and page-signal-keyed so it tears down with the cycle. The instant-hard-close residual (an async write cannot be guaranteed to complete
    // during an immediate unload) is documented and accepted.
    document.addEventListener("visibilitychange", () => {

      if(document.visibilityState === "hidden") {

        void this.#flushPersist?.();
      }
    }, { signal });

    /* Commit-and-flush when keyboard focus leaves the page. The page lives in the host's custom-UI iframe, and every host-side control - the Save button above all,
     * but Close and the restart affordance too - sits in the parent document, so acting on any of them begins by moving focus out of this window. Two edits are in
     * flight at exactly that moment and neither would otherwise reach the host in time: a text input still holding focus has never fired `change`, because moving
     * focus to the parent document does not reliably blur the iframe's own active element, and an already-committed edit inside the persist debounce window has not
     * been written. Either one makes the host's Save write a config that silently omits the user's last edit.
     *
     * The window `blur` event is the signal this window receives for that boundary, and it fires on the focus shift - ahead of the click that completes on the
     * parent's button - so both halves land before the host acts: the focused value input is committed through the same change delegation every commit routes
     * through, and the persist drain is then driven immediately, skipping its debounce. Element-level blurs never reach this listener (they do not bubble to the
     * window), so it fires only when focus genuinely leaves the page; a blur with nothing pending costs one no-op flush. The commit targets only a value input
     * inside the options table - the search field stages nothing and is deliberately outside this rule.
     */
    window.addEventListener("blur", () => {

      const active = document.activeElement;

      if(active?.matches?.("input[type='text']") && active.closest("#configTable")) {

        active.dispatchEvent(new Event("change", { bubbles: true }));
      }

      void this.#flushPersist?.();
    }, { signal });

    // Wait for controllers (if configured), bounded so a plugin hook riding a dead bridge cannot strand the page. Empty result in controller-based mode means "no
    // controllers configured" - we show the helper text and bail.
    let controllers;

    try {

      controllers = await withDeadline({ promise: controllersPromise, seconds: BOOT_AWAIT_DEADLINE_SECONDS, signal });
    } catch(err) {

      this.#failConnection({ err, signal, site: "controllers" });

      return;
    }

    if(signal.aborted) {

      return;
    }

    if(this.#config.getControllers && (!controllers || (controllers.length === 0))) {

      showNoControllersMessage();

      return;
    }

    const initialController = controllers?.[0] ?? null;

    // The device machinery is inert in global-only mode: with scope pinned to global there is no controller device to fetch or select, so the pre-fire here and the
    // matching devices await, applied-sequence gate, and scope decision further down all sit on the device-bearing path. The global-only branch after the theme await
    // returns before reaching them, so these bindings are read only when they were assigned.
    let devicesSeq;
    let devicesPromise;

    // In the device-bearing modes, record this fetch at the store's chokepoint before firing it, then read back the minted sequence - the store's ticket for this
    // fetch. The sequence, not the controller, is the fetch identity, so a controller click racing this initial fetch resolves last-request-wins at the reducer.
    if(!this.#config.globalOnly) {

      this.#store.dispatch({ controllerId: initialController?.serialNumber ?? null, type: "devices:requested" });
      devicesSeq = this.#store.state.devicesRequest.seq;
      devicesPromise = this.#devicesFor(initialController);
    }

    // Wait for the feature catalog, bounded like every other host await. Build the catalog (catalog index + validators) and dispatch model:loaded so the store
    // transitions to "ready" and views can mount against a populated state. The configured options come from the session's primary entry - the persisted config the
    // orchestrator already loaded.
    let features;

    try {

      features = await withDeadline({ promise: featuresPromise, seconds: BOOT_AWAIT_DEADLINE_SECONDS, signal });
    } catch(err) {

      this.#failConnection({ err, signal, site: "features" });

      return;
    }

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
      mode: this.#config.globalOnly ? "global-only" : (this.#config.getControllers ? "controller-based" : "device-only"),
      type: "model:loaded"
    });

    // Wait for the theme's matchMedia listener registration before any user interaction can trigger a theme change. By this point, themeInitPromise has almost
    // always already resolved - it ran in parallel with every other fetch above.
    //
    // This await is the one whose failure is NOT fatal. The theme's host read is cosmetic: a page that cannot learn the host's lighting mode renders on the theme's
    // own defaults and is entirely usable, so a probe that hangs or fails costs a warning and nothing else. Every other await lands the user on the retry view;
    // making this one do the same would let a cosmetic detail take down a working page.
    try {

      await withDeadline({ promise: themeInitPromise, seconds: BOOT_AWAIT_DEADLINE_SECONDS, signal });
    } catch(err) {

      this.#unlessStale({ run: () => {

        // console is the browser page's diagnostic transport, and a theme probe that did not answer is exactly a diagnostic - the boot continues on the defaults.
        // eslint-disable-next-line no-console
        console.warn("The theme could not read the Homebridge lighting mode, so the page is rendering on its default theme.", err);
      }, signal });
    }

    if(signal.aborted) {

      return;
    }

    // Global-only mode ends the boot here, before the device machinery below ever runs. First reclaim #headerInfo: in the other modes the header view mounts and
    // reclaims the container on model:loaded, but global-only never mounts that view, so nothing else would reconcile a connection-error block a failed cycle left
    // behind (clearContainers deliberately excludes #headerInfo). A live connection error is unreachable at this point in this mode - a sync failure returns from
    // show() before model:loaded, and no devices:loaded ever dispatches here - so this clear only ever discards a prior cycle's stale block, never a current error.
    // Then reveal the reduced region set (the sidebar and header stay hidden) with the misnesting diagnostic, and return.
    if(this.#config.globalOnly) {

      const headerInfo = document.getElementById("headerInfo");

      if(headerInfo) {

        headerInfo.textContent = "";
      }

      revealRegions(GLOBAL_ONLY_REGION_IDS, { warnOnNesting: true });

      return;
    }

    // Wait for devices, bounded like every other host await. The fetch overlapped with config + features; typically already resolved by now. A failure folds into the
    // devices:loaded outcome channel the nav view's click path already uses, carrying this site's own copy: the reducer drops it if a newer fetch superseded it, and
    // otherwise renders the retry view saying what actually failed rather than the generic controller wording.
    let outcome;

    try {

      outcome = await withDeadline({ promise: devicesPromise, seconds: BOOT_AWAIT_DEADLINE_SECONDS, signal });
    } catch(err) {

      const { guidance, headline } = connectionFailureCopy({ expired: err instanceof DeadlineExpiredError, site: "devices" });

      this.#unlessStale({ run: () => this.#store.dispatch({

        controllerId: initialController?.serialNumber ?? null,
        devices: [],
        error: errorMessage(err),
        guidance,
        headline,
        seq: devicesSeq,
        type: "devices:loaded"
      }), signal });

      return;
    }

    if(signal.aborted) {

      return;
    }

    const { devices, error } = outcome;

    this.#store.dispatch({ controllerId: initialController?.serialNumber ?? null, devices, error, seq: devicesSeq, type: "devices:loaded" });

    // Gate every follow-up on the reducer's own verdict: my outcome applied only when the sequence I carried is the one the reducer recorded. A controller click that
    // raced this initial fetch would have superseded it - its outcome owns the store, and this stale continuation must neither reveal the page over it nor overwrite
    // its scope.
    if(this.#store.state.devicesAppliedSeq !== devicesSeq) {

      return;
    }

    // My outcome applied and it turned the store to connection-error: a selected controller whose probe reported a failure. The failure message travelled back on the
    // DeviceListResult rather than through a separate request, and the reducer folded it into the connection-error transition. The connection-error view reveals
    // #headerInfo itself when it renders the error block (it is the sole owner of the error display, content and reveal together), so the orchestrator only returns
    // here. The sidebar, search panel, and config table stay hidden - hide() set them so at show() start and the success-path revealRegions() never runs on this
    // branch - because the user has no devices to navigate to.
    if(this.#store.state.status.kind === "connection-error") {

      return;
    }

    // Set the initial scope. My outcome applied, so the local `devices` is the applied list. Controller-based mode lands on the first controller's controller-as-device
    // entry (devices[0]). Device-only mode lands on global so the user sees the global options first.
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

    // Reveal the full region set the views render into.
    revealRegions(REGION_IDS);
  }

  /**
   * Refresh the controller sidebar in response to an explicit user action, without re-entering the full show() cycle.
   *
   * A consumer calls this after a user action that could have changed the controller set - a controller added or removed through the plugin's own affordance - to
   * repaint the sidebar's controller list against the current configuration. It re-syncs the session against the host config the way show() does before it reads
   * controllers, so a refresh after a Settings-tab edit acts on the current config rather than a stale key, then re-invokes the configured getControllers hook. The
   * freshness of the returned list is the consumer hook's concern: this method repaints whatever the hook resolves.
   *
   * Contract:
   *
   *   - A call before the first show() has established the session and store resolves false without dispatching - there is no sidebar to refresh yet. The same holds
   *     for a call after teardown, or one whose cycle is superseded mid-flight: the refresh belongs to the cycle it started in, so its outcome is dropped rather than
   *     dispatched into whatever cycle replaced it.
   *   - A config re-sync failure resolves false and leaves the rendered view exactly as it was. This is a deliberate divergence from show(), which routes a sync
   *     failure into the connection-error view: an explicit refresh must never tear down a working sidebar over a failed config read. A controller hook that fails or
   *     never answers resolves false on the same reasoning - both awaits are bounded, so neither can leave the caller waiting on a dead bridge.
   *   - A null, absent, or empty resolved controller list resolves false and leaves the store untouched - the consumer owns the messaging for the no-controllers
   *     case, exactly as show()-time handles it through a direct message that bypasses the store.
   *   - A non-empty list dispatches controllers:loaded and resolves true once the sidebar has transitioned to the new list.
   *
   * A false return, in every case, means the view was left as it was; the caller relies on that to decide whether to surface its own no-controllers messaging.
   *
   * @returns {Promise<boolean>} True when a non-empty controller list was loaded and the sidebar transitioned; false when the refresh left the view unchanged.
   * @public
   */
  async refreshControllers() {

    // The pre-store window: a refresh dispatched before the first show() established the session and store has no sidebar to act on. Resolve false without touching
    // anything, so a consumer that wires its affordance before the first render simply gets a no-op.
    if(!this.#session || !this.#store) {

      return false;
    }

    // Capture the live cycle's signal at entry - the one this refresh belongs to. cleanup() nulls the abort controller while leaving the store queryable, so an absent
    // controller means there is no rendered cycle to refresh into, and an already-aborted one means this refresh's cycle is gone. Capturing rather than re-reading also
    // means a supersession that lands mid-refresh aborts the signal this method is holding, so its awaits settle at once and its outcome is dropped instead of
    // dispatched into the newer cycle's store.
    const signal = this.#pageAbort?.signal;

    if(!signal || signal.aborted) {

      return false;
    }

    // Re-read the host config into the session before we read controllers, exactly as show() does at its entry, so a refresh after a Settings-tab edit acts on the
    // current config rather than a frozen snapshot. Unlike show(), a read failure here does NOT route into the connection-error view: an explicit refresh must never
    // replace a working sidebar with the error frame over a failed config read, so we leave the store untouched and report that the refresh made no change.
    try {

      await withDeadline({ promise: this.#session.sync(), seconds: BOOT_AWAIT_DEADLINE_SECONDS, signal });
    } catch {

      return false;
    }

    // Re-invoke the configured getControllers hook with the same injected-config shape show() uses, bounded on the same reasoning as the sync above. A device-only
    // plugin has no hook and thus no controllers to refresh, so its null result falls through to the no-change return below; a hook that fails or never answers
    // reports no change too, since leaving the working sidebar alone is the honest outcome either way.
    let controllers = null;

    try {

      if(this.#config.getControllers) {

        controllers = await withDeadline({ promise: this.#config.getControllers({ config: this.#session.platform }), seconds: BOOT_AWAIT_DEADLINE_SECONDS, signal });
      }
    } catch {

      return false;
    }

    // A null, absent, or empty list leaves the store untouched: the consumer owns the no-controllers messaging, so a refresh that finds none reports no change rather
    // than dispatching an empty sidebar or a connection-error frame. Only a non-empty list transitions the view.
    if(!controllers || (controllers.length === 0)) {

      return false;
    }

    // A non-empty list: dispatch the controllers-only refresh the nav view subscribes to. The reducer replaces state.controllers and the nav rebuilds the controllers
    // container against it; the dispatch runs its subscribers synchronously, so the sidebar has transitioned by the time we report success. The staleness guard owns
    // the verdict: a refresh whose cycle was superseded while it waited dispatches nothing and reports no change.
    return this.#unlessStale({ run: () => this.#store.dispatch({ controllers, type: "controllers:loaded" }), signal });
  }

  /**
   * The staleness chokepoint: run an action only while the cycle it belongs to is still the live one.
   *
   * Every bounded await now settles - that is the whole point of the deadline - which is exactly what makes this necessary. A cycle that was superseded while it waited
   * still reaches its own catch, and the store it would reach for is the field the NEXT show() reassigned. Routing every late outcome through one guard, closured over
   * its own cycle's signal, is what keeps a dead cycle's failure from painting an error over a page that has already rendered.
   *
   * It is a method rather than a discipline for the same reason: an inline `if(signal.aborted)` at each catch is a rule that has to be remembered at every future
   * failure path, while a single chokepoint is a rule the code enforces.
   *
   * @param {Object} args
   * @param {() => void} args.run - The action to take when the cycle is still live: a store dispatch, or the theme's warning.
   * @param {AbortSignal} args.signal - The signal of the cycle the action belongs to.
   * @returns {boolean} True when the action ran, false when the cycle had been superseded.
   * @private
   */
  #unlessStale({ run, signal }) {

    if(signal.aborted) {

      return false;
    }

    run();

    return true;
  }

  /**
   * Route a failed page await into the connection-error view.
   *
   * The site names which await failed so the copy table can say the honest thing about it, and the {@link DeadlineExpiredError} test is what separates a host that went
   * quiet from one that answered with an error - two failures a user responds to differently. The dispatch rides the staleness guard, so a superseded cycle's late
   * failure never lands on the cycle that replaced it.
   *
   * @param {Object} args
   * @param {*} args.err - The thrown value, tested for a deadline expiry and rendered as the failure's message.
   * @param {AbortSignal} args.signal - The signal of the cycle the failure belongs to.
   * @param {string} args.site - The await that failed, as named in the copy table.
   * @private
   */
  #failConnection({ err, signal, site }) {

    const { guidance, headline } = connectionFailureCopy({ expired: err instanceof DeadlineExpiredError, site });

    this.#unlessStale({ run: () => this.#store.dispatch({ guidance, headline, message: errorMessage(err), type: "connection:error" }), signal });
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

    for(const id of REGION_IDS) {

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

      // The precedence header does not mount in global-only mode - there is no device or controller hierarchy for it to head. The connection-error view mounts in every
      // mode: it is the surface a config-sync failure renders into regardless of mode, so it is never gated.
      if(!this.#config.globalOnly) {

        mountHeaderView({ root: headerInfo, signal, store });
      }

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

      const { infoPanel, statusPanel } = this.#config;

      // One region, one owner. The constructor already rejected supplying both, so a configured statusPanel mounts the live status view and stores its handle on the
      // public field; otherwise the static device-info view mounts and the plugin's hook travels straight through to it, because both sides name the bag's keys and
      // named keys cannot disagree about argument order the way two positional signatures can.
      if(statusPanel) {

        this.statusPanel = mountStatusPanelView({ config: statusPanel, resumeDetector: this.#resumeDetector, root: deviceStatsContainer, signal, store });
      } else {

        mountDeviceInfoView({ infoPanel, root: deviceStatsContainer, signal, store });
      }
    }

    if(searchPanel && configTable) {

      mountSearchView({ configTable, root: searchPanel, signal, store });
    }

    if(configTable) {

      // The localStorage namespace key is the Homebridge platform identifier - the primary entry's `platform` field. Passed as a thunk, not a frozen string: the
      // views mount before the session re-syncs, so the options view reads the identifier through the thunk inside its model:loaded effect (post-sync) rather
      // than capturing a possibly pre-sync value here.
      mountOptionsView({ configTable, platform: () => this.#session?.platform?.platform, signal, store });
    }

    // The nav view does not mount in global-only mode: with scope pinned to global there is no controller or device list to navigate, and its grouping filter (the sole
    // consumer of ui.isController) is inert here.
    if(controllersContainer && devicesContainer && !this.#config.globalOnly) {

      mountNavView({

        deadlineSeconds: BOOT_AWAIT_DEADLINE_SECONDS,
        deviceContent: this.#config.renderDeviceContent,
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

    swapMenuClasses(id, primary ? "btn-elegant" : "btn-primary", primary ? "btn-primary" : "btn-elegant");
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

// Reveal a set of page regions by clearing their inline display, which the hide() path set to none so the user did not see a half-built UI during teardown / rebuild.
// The success path passes REGION_IDS in the device-bearing modes and the reduced GLOBAL_ONLY_REGION_IDS in global-only mode. When warnOnNesting is set (global-only),
// each revealed region is checked for a hidden ancestor: a content region nested under the permanently-hidden sidebar or header cannot become visible however its own
// display is set, so the misnesting is surfaced as a named console warning rather than a silently-invisible panel.
const revealRegions = (ids, { warnOnNesting = false } = {}) => {

  for(const id of ids) {

    const element = document.getElementById(id);

    if(!element) {

      continue;
    }

    element.style.display = "";

    if(warnOnNesting) {

      warnIfRegionNestedUnderHidden(id, element);
    }
  }
};

// Walk a revealed region's ancestors up to the #pageFeatureOptions boundary; a hidden ancestor means the region is nested under markup global-only mode keeps hidden
// (the sidebar or the header bar) and so cannot become visible however its own display is set. Global-only mode requires the content regions to sit outside those
// subtrees, so a hidden ancestor is a misconfigured consumer shell - surface it as a named diagnostic rather than letting the panel stay silently invisible.
const warnIfRegionNestedUnderHidden = (id, element) => {

  const boundary = document.getElementById("pageFeatureOptions");

  for(let ancestor = element.parentElement; ancestor && (ancestor !== boundary); ancestor = ancestor.parentElement) {

    if(ancestor.style.display === "none") {

      // eslint-disable-next-line no-console
      console.warn("Global-only mode requires the content region \"" + id +
        "\" to sit outside the sidebar and header markup, but it is nested under a hidden ancestor and cannot become visible.");

      return;
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
// header content in place; the orchestrator returns from show() without dispatching model:loaded, so the already-mounted views stay on their loading placeholder and
// never render over this message.
const showNoControllersMessage = () => {

  const headerInfo = document.getElementById("headerInfo");

  if(headerInfo) {

    headerInfo.textContent = "Please configure a controller to access in the main settings tab before configuring feature options.";
    headerInfo.style.display = "";
  }
};
