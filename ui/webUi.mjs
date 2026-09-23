/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi.mjs: Plugin webUI.
 */
"use strict";

import { BOOT_AWAIT_DEADLINE_SECONDS, webUiFeatureOptions } from "./webUi-featureOptions.mjs";
import { DeadlineExpiredError, createResumeDetector, withDeadline } from "./webUi-liveness.mjs";
import { paintMenuTabs, registerThemeEffect } from "./webUi-theming.mjs";
import { PluginConfigSession } from "./pluginConfigSession.mjs";
import { markHandled } from "./mark-handled.js";
import { registerTokensEffect } from "./webUi-tokens.mjs";
import { toastError } from "./webUi-errors.mjs";

// The copy a launch that timed out surfaces. The session open is the page's first bridge call, before any store, view, or retry affordance exists, so the toast is the
// only surface available - and the recovery it names has to hold for every plugin whatever menu its markup carries, which reopening the panel does: opening the panel
// is what runs the launch.
const LAUNCH_TIMEOUT_MESSAGE = "The Homebridge server did not respond, so the plugin configuration could not be read. Reopen the settings panel to try again.";

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
 * Owns the page-level menu state, the first-run flow, page theming, and the {@link webUiFeatureOptions} instance that renders the feature options page. The
 * orchestrator is the single entry point Homebridge invokes to render the configuration UI. Theming is this object's own because its scope is the page - the
 * design tokens, the themed canvas, and the page-kit classes all land on `:root` and `body` - so it registers through {@link webUi.registerTheming} and lives for
 * the page; feature-option discovery, the options view and the skin that dresses it, sidebar navigation, and search all live in the composed
 * {@link webUiFeatureOptions} instance and its sub-components.
 *
 * The menu surfaces it drives are whichever ones the plugin's markup carries: `menuHome` enters the support view, `menuFeatureOptions` the feature-options view, and
 * `menuSettings` the host's schema form. Each is bound and painted when the page carries it and skipped when it does not, so a plugin declares its menu by markup
 * alone. Painting is shared rather than owned - the feature-options view paints its own active state through the same class-swap helper whenever it shows.
 */
export class webUi {

  /**
   * The composed feature-options orchestrator that renders the feature-options page.
   *
   * Constructed once in the constructor and never reassigned afterward; a plugin reaches through this field directly for the feature-options surface - discovery,
   * the options view and its skin, sidebar navigation, and search - as the class-level documentation above describes.
   *
   * @type {webUiFeatureOptions}
   */
  featureOptions;

  /**
   * The plugin-facing liveness surface.
   *
   * One method, deliberately: `onResume(callback, { shouldProbe, signal })` registers a subscriber the page notifies when it detects that the browser froze and woke
   * again - an OS app-switch, a laptop lid - which is the one liveness event a plugin cannot observe for itself, since WebKit does not reliably deliver
   * `visibilitychange` to this embedded frame. What the subscriber does about it is plugin policy: re-elicit a feed, refresh a poll, probe a connection.
   *
   * The deadline helpers are NOT re-exposed here. A plugin that wants to bound its own awaits imports `withDeadline` from the liveness module directly, so there is one
   * path to that function rather than a field that shadows it.
   *
   * A subscription lasts until the `signal` its caller supplies aborts, or for the life of the page when the caller supplies none.
   *
   * @example
   *
   * // Refresh a price poll when the page wakes, but only while this plugin's panel is the one on screen.
   * ui.liveness.onResume(() => refreshPrices(), { shouldProbe: () => panelVisible, signal });
   *
   * @type {{ onResume: (callback: () => void, options?: { shouldProbe?: () => boolean, signal?: AbortSignal }) => void }}
   */
  liveness;

  #chromeBound = false;
  #firstRun;
  #name;
  #resumeDetector;
  #session;
  #themingPromise;

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

    // One resume detector for the whole page. The thing it measures - a freeze in wall-clock time - is a property of the page, not of any view that happens to be
    // mounted, so it belongs to the object whose lifetime is the page's and is handed down to the feature-options instance as framework wiring rather than as plugin
    // configuration. Its sampling timer is demand-driven, so a page whose views never subscribe pays nothing for holding one.
    this.#resumeDetector = createResumeDetector();

    this.featureOptions = new webUiFeatureOptions(featureOptions, {

      registerTheming: (options) => this.registerTheming(options),
      resumeDetector: this.#resumeDetector
    });

    this.liveness = { onResume: (callback, options) => this.#resumeDetector.subscribe(callback, options) };
    this.#name = name;
  }

  /**
   * Register the framework's theming for the life of this page.
   *
   * One call is the whole contract: it adopts the design-token sheet, then the page theme - the themed canvas, dark-mode handling, the page-kit classes, and the
   * Bootstrap accent probe - and holds both for the life of the page. Theming is a page concern rather than a view one, since everything it writes lands on `:root`
   * and `body`, so a plugin's first-run page, support tab, and settings form all keep the theme rather than losing it on every navigation. The feature-options view
   * routes through this same registration rather than registering theming of its own.
   *
   * Safe to call more than once: the first call registers, and every later call returns the same promise without registering anything a second time. A `probe`
   * override is honored on the FIRST call only - a later call's override is ignored, because the probe it would configure has already run.
   *
   * Registration is complete even when the initial lighting-mode read rejects. The sheets are adopted and both host-signal routes are live before that read is
   * issued, so the next theme change the host announces applies the mode and the page heals itself. The returned promise still rejects, so a caller that awaits it
   * can say so in its own diagnostic; a caller that voids it per the house rule gets no unhandled-rejection noise, because this method owns that posture itself.
   *
   * The PAGE KIT is the class contract a plugin's own markup opts into, and it is in force wherever this registration is:
   *
   *   - `.fo-card` - the accent-derived frame every framework container wears, for grouping a plugin's own content into a card.
   *   - `.fo-monospace` - the monospace stack the framework gives value-bearing inputs, as a per-element opt-in.
   *   - `.fo-page` - the marker that scopes the dark-mode form-control corrections. Put it on a custom-page container and that container's plain form controls
   *     become dark-mode-correct: surface, border, text, placeholder, and focus state together. Nothing outside the marked container is touched, and light mode is
   *     left to Bootstrap, exactly as the framework treats its own fields.
   *
   * @example
   *
   * // A plugin's own first-run page, themed with one call at page load.
   * await ui.registerTheming();
   *
   * @param {Object} [options] - Registration options.
   * @param {{ intervalMs?: number, timeoutMs?: number }} [options.probe] - Bootstrap accent-probe overrides, honored on the first call only.
   * @returns {Promise<void>} The registration's own promise, the same identity on every call.
   * @public
   */
  registerTheming({ probe } = {}) {

    if(!this.#themingPromise) {

      registerTokensEffect();

      // A caller that voids the returned promise attaches no rejection handler, and the void operator does not mark a rejection handled - so this branch owns the
      // diagnostic posture: it marks a failed initial mode read handled for the page (the failure is survivable by design - the sheets and the followed host
      // signals are live, and the next host announcement applies the mode), while a caller that awaits still observes the rejection through its own branch of the
      // same promise. The mark is the library's own, and it answers the promise it was handed, so the memo every caller shares keeps one identity.
      this.#themingPromise = markHandled(registerThemeEffect({ host: homebridge, probe }));
    }

    return this.#themingPromise;
  }

  /**
   * Run an entry point's work, reporting its failure and settling its chrome.
   *
   * Every entry point in this shell repeats one skeleton: run some async work, report a failure to the user, settle the chrome the work brackets - the spinner, the
   * menu, the schema form, the boot monitor. Owning that skeleton once means every entry point reports and settles on every path its work can take, rather than each
   * one having to remember to.
   *
   * @param {Object} args
   * @param {(err: *) => void} [args.failed] - Reports a failure to the user. Defaults to the shared error-toast normalization.
   * @param {() => Promise<void>} args.run - The entry point's own async work.
   * @param {() => void} [args.settled] - The chrome work owed however that work settles. Defaults to nothing owed.
   * @returns {Promise<void>}
   * @private
   */
  async #runEntryPoint({ failed = toastError, run, settled = () => {} }) {

    try {

      await run();
    } catch(err) {

      failed(err);
    } finally {

      settled();
    }
  }

  /**
   * Render the webUI.
   *
   * Public entry point Homebridge invokes when the configuration UI is opened. Delegates the actual rendering to {@link #launchWebUI} and runs it through
   * {@link #runEntryPoint}, which is what turns a launch failure into a user-facing toast rather than a silent broken UI and guarantees the spinner is hidden no
   * matter how the launch settles. The boundary's settle work runs after the awaited launch resolves or rejects, so the spinner stays visible for the full duration
   * of the async setup rather than disappearing the moment the synchronous portion of the call returns.
   *
   * @returns {Promise<void>}
   * @public
   */
  async show() {

    return this.#runEntryPoint({

      failed: (err) => {

        // The outermost user-facing diagnostic in the webUI. Caller-supplied first-run handlers and other extension points can throw any shape, so the shared
        // toastError normalization extracts a useful message regardless of what bubbled out of `#launchWebUI`.
        this.#toastLaunchFailure(err);

        // A launch that never established a session has rendered nothing, so the menu is the only way forward the user has - and it starts hidden. Reveal it here,
        // and only here: the first-run route keeps it hidden on purpose until that flow completes, and a failure that happened after routing has already revealed
        // it.
        if(!this.#session) {

          const menuWrapper = document.getElementById("menuWrapper");

          if(menuWrapper) {

            menuWrapper.style.display = "inline-flex";
          }
        }
      },
      run: () => this.#launchWebUI(),
      settled: () => {

        homebridge.hideSpinner();

        // Stand the boot monitor down. Once show() settles the app owns the surface either way - on success the UI rendered, on failure the toast above displayed the
        // diagnostic - so any earlier boot-phase error the monitor may have caught was non-fatal, and it should retract any panel it raised. The optional chain tolerates
        // a stamped region that carries no boot monitor.
        globalThis.webUiBoot?.ready?.();
      }
    });
  }

  /**
   * Show the first-run user experience.
   *
   * Runs the caller-supplied start handler so the plugin can populate its form and take any startup step it needs, disables the save button so a
   * partially-configured plugin cannot be written back to disk before the user completes the flow, and reveals the first-run page. The submit button is wired for
   * the page's lifetime in {@link #bindChromeListeners} rather than here, so a repeated launch leaves exactly one handler on it.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showFirstRun() {

    // Inject the primary platform-config entry so the hook reads its config from its argument rather than reaching for the session or the host. onStart only reads
    // (it pre-populates the form), so it receives config without the writer.
    if(!(await this.#processHandler(this.#firstRun.onStart, { config: this.#session.platform }))) {

      return;
    }

    homebridge.disableSaveButton();

    document.getElementById("pageFirstRun").style.display = "block";
  }

  /**
   * Run the first-run submit: the caller's submit handler, the page swap, and the handoff to the feature-options view.
   *
   * Where a failure lands decides what the user is left looking at. A rejected onSubmit - a failed login, a configuration that did not validate - throws before the
   * page swap, so the first-run page stays fully visible for another attempt; a rejection from the feature-options handoff after a successful submit throws after
   * the swap, so the main shell is visible with the menu still usable for recovery. Either way {@link #runEntryPoint} is the diagnostic, through the shared
   * error-toast normalization its default carries.
   *
   * The spinner is raised here rather than inside the boundary's run, so the boundary's settle work is what brings it down: it then brackets the whole flow and
   * drains on every path, the early bail on a falsy submit answer included.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #submitFirstRun() {

    homebridge.showSpinner();

    return this.#runEntryPoint({

      run: async () => {

        // onSubmit is the one write hook: it validates credentials and persists them. It receives both the current config and a `commit` bound to the session's
        // single write path, so the hook owns the shape of the write (it knows credentials live under the controllers array) while the session owns persistence.
        if(!(await this.#processHandler(this.#firstRun.onSubmit, { commit: (patch) => this.#session.commit(patch), config: this.#session.platform }))) {

          return;
        }

        // Swap from the first-run page to the main configuration UI and hand off to the feature-options view. The feature-options surface manages its own
        // progressive disclosure - page-shell visible immediately, regions populating as their I/O resolves - so this flow's spinner is the only one that brackets
        // the transition.
        document.getElementById("pageFirstRun").style.display = "none";
        document.getElementById("menuWrapper").style.display = "inline-flex";

        await this.featureOptions.show(this.#session);

        homebridge.enableSaveButton();
      },
      settled: () => homebridge.hideSpinner()
    });
  }

  /**
   * Show the feature-options tab from the menu.
   *
   * The menuFeatureOptions button re-enters the feature-options view. `featureOptions.show()` can reject - a catalog fault such as a picker source with no resolver
   * throws straight through by design, since no retry could repair a catalog, and so does a caller-supplied loaded-model hook that throws - and the click listener
   * drops the returned promise, so this method runs the re-entry through {@link #runEntryPoint}, which surfaces a failed re-show as an error toast rather than an
   * unobserved rejection.
   *
   * When no session exists, the click re-runs the launch instead. That is the recovery path for a launch whose config read never answered: the menu is bound and the
   * user is looking at a toast, so the one affordance they have must re-attempt the open rather than hand `show()` a session that was never established. The
   * one-shot chrome binder keeps the re-launch from stacking a second set of listeners.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showFeatureOptions() {

    return this.#runEntryPoint({

      failed: (err) => this.#toastLaunchFailure(err),
      run: async () => {

        if(!this.#session) {

          await this.#launchWebUI();

          return;
        }

        await this.featureOptions.show(this.#session);
      }
    });
  }

  /**
   * Surface a launch or re-entry failure as a toast, saying the honest thing about a host that never answered.
   *
   * A deadline expiry and a genuine failure read differently to a user: one means the server went quiet and the retry is worth taking, the other carries a message
   * describing what actually went wrong. Only the session open can produce an expiry here - every feature-options await handles its own - so the substitution is
   * unambiguous, and everything else flows through the shared toastError normalization untouched.
   *
   * @param {*} err - The thrown value.
   * @private
   */
  #toastLaunchFailure(err) {

    toastError((err instanceof DeadlineExpiredError) ? LAUNCH_TIMEOUT_MESSAGE : err);
  }

  /**
   * Show the main plugin configuration tab.
   *
   * Hides the feature-options view, paints the menu with Settings as the active tab, and asks Homebridge to render its built-in schema-driven settings form. The
   * spinner brackets the paint so transient layout shifts are not visible to the user.
   *
   * Awaits `featureOptions.hide()` BEFORE revealing the schema form so any debounced-but-unwritten option edit is flushed into Homebridge's in-memory config model
   * first - the Settings form then renders against the flushed config rather than a stale snapshot. The reveal and the spinner are {@link #runEntryPoint}'s settle
   * work, so they land on every path and nothing strands the user on a spinner. The flush drain's own failure surfaces via `persist:failed`'s
   * toast rather than as a rejection here, and a rejection that contract rules out reaches the boundary's default toast with the tab painted regardless.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showSettings() {

    homebridge.showSpinner();

    return this.#runEntryPoint({

      run: () => this.featureOptions.hide(),
      settled: () => {

        paintMenuTabs("menuSettings");

        document.getElementById("pageSupport").style.display = "none";
        document.getElementById("pageFeatureOptions").style.display = "none";

        homebridge.showSchemaForm();

        homebridge.hideSpinner();
      }
    });
  }

  /**
   * Show the support tab.
   *
   * Hides the feature-options view and the schema form, paints the menu with Home as the active tab, and reveals the static support page. The spinner brackets the
   * paint to mask transient layout shifts.
   *
   * Awaits `featureOptions.hide()` BEFORE revealing the support page so any debounced-but-unwritten option edit is flushed first, matching the Settings path. The
   * reveal and the spinner are {@link #runEntryPoint}'s settle work, so they land on every path. The flush drain's own failure surfaces via
   * `persist:failed`'s toast rather than as a rejection here, and a rejection that contract rules out reaches the boundary's default toast with the tab painted
   * regardless.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showSupport() {

    homebridge.showSpinner();
    homebridge.hideSchemaForm();

    return this.#runEntryPoint({

      run: () => this.featureOptions.hide(),
      settled: () => {

        paintMenuTabs("menuHome");

        document.getElementById("pageSupport").style.display = "block";
        document.getElementById("pageFeatureOptions").style.display = "none";

        homebridge.hideSpinner();
      }
    });
  }

  /**
   * Launch the webUI.
   *
   * Wires the page's chrome listeners, opens the configuration session, and routes the user to either the feature-options view (when the caller's first-run gate
   * says no) or the first-run flow (when it says yes). The session loads the host config once and seeds the minimum shape, so routing and every downstream reader
   * share one config owner rather than fetching it independently. The menu is wired ahead of the session because it is the recovery affordance for an open that
   * fails.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #launchWebUI() {

    // Bind the persistent chrome listeners before any I/O. The buttons are page chrome rather than session state - each handler reads the current `this.#session` at
    // click time - so binding first is what leaves the user a working menu when the open below never answers. The binder is a no-op on any subsequent launch, so the
    // recovery path's re-launch never stacks a second handler on each button.
    this.#bindChromeListeners();

    // Open the configuration session: one host read, seeded to the minimum shape. Routing, the first-run flow, and the feature-options page all read their config
    // from this single owner rather than re-fetching it independently - so the routing decision lands before any UI work begins and against the same data every
    // later reader sees.
    //
    // This is the page's FIRST bridge call, and an unbounded one would be the worst place to hang: nothing has rendered, so the user sees a spinner over an empty
    // frame with no diagnostic and no way forward. An expiry surfaces through show()'s toast with the menu left usable for another attempt.
    this.#session = await withDeadline({ promise: PluginConfigSession.open({ host: homebridge, name: this.#name }), seconds: BOOT_AWAIT_DEADLINE_SECONDS });

    // The caller's first-run gate decides routing against the injected platform config. No separate "is there any config?" test is needed: a plugin with a first-run
    // flow returns true on a fresh config (no valid credentials yet), and a plugin without one keeps the default `() => false` gate and lands straight on feature
    // options - the right destination for a device-discovery plugin even on a brand-new install. The session has already seeded the minimum shape, so the first-run
    // flow can persist credentials on submit without a separate eager write here.
    if(!(await this.#processHandler(this.#firstRun.isRequired, { config: this.#session.platform }))) {

      document.getElementById("menuWrapper").style.display = "inline-flex";
      await this.featureOptions.show(this.#session);

      return;
    }

    // Await first-run setup so the spinner-bracketed window in `show()` only closes after the first-run page is fully prepared - the onStart handler has resolved,
    // the save button is disabled, and the page is visible. Returning before this would let `show()`'s settle work hide the spinner while initialization is still in
    // flight, leaving the user looking at a half-rendered first-run UI.
    await this.#showFirstRun();
  }

  /**
   * Bind the page's chrome click listeners exactly once for the webUI's lifetime.
   *
   * The menu buttons and the first-run submit button are page chrome that persists across every show() cycle, so their listeners belong to the whole page rather
   * than to any one show()'s teardown. A one-shot guard keeps a repeated #launchWebUI from stacking a second handler on each button, which would fire every tab
   * switch twice and run a submit twice per click. Each arrow reads the current this.#session through the method it calls, so a single persistent listener always
   * acts on the latest session even after a re-launch replaces it.
   *
   * Which buttons exist is the plugin's declaration rather than this framework's: the markup carries whatever surfaces the plugin offers, and every one the page
   * carries is bound here. A button the markup omits offers no entry to its view, which is the whole of what its absence means, so each bind steps over an id the
   * page does not carry rather than treating it as a broken page.
   *
   * Binding ahead of the flow a button serves offers the user nothing early, which is why the first-run submit is bound here beside the menu rather than inside the
   * first-run flow itself. What offers a button is the display of the page it sits on: the menu buttons are bound while menuWrapper is hidden and before any session
   * exists, and pageFirstRun is displayed only once the session is open and the caller's onStart hook has agreed. A synthetic click on a hidden button is outside
   * the page's contract and gets no defense of its own.
   *
   * Chrome click listeners use a uniform shape: an arrow expression that calls a handler and returns its result. addEventListener discards the return value, so each
   * async handler's promise is dropped; every handler runs its work through {@link #runEntryPoint}, which owns both the report and the settle, so the drop carries no
   * unobserved rejection. #showFeatureOptions serves both the first click before a session exists and every re-entry, and toasts a failure from either. The launch
   * path rejects by design when the session open expires or the host refuses it and when a caller-supplied first-run hook throws; featureOptions.show() routes the
   * failures a retry can repair (the config read, the controller and device lists, the feature catalog) into the connection-error view, and lets a catalog fault - a
   * picker source with no resolver - and a caller-supplied loaded-model hook that throws go straight through, because each is the plugin's own code and no retry
   * could repair it. Without the boundary each of those would vanish into the dropped promise. #showSettings and #showSupport hand the boundary their navigate-away
   * flush, and it reveals the next tab and drains the spinner on every path (the flush drain's own failure surfaces via persist:failed's toast).
   *
   * @private
   */
  #bindChromeListeners() {

    if(this.#chromeBound) {

      return;
    }

    this.#chromeBound = true;

    document.getElementById("menuHome")?.addEventListener("click", () => this.#showSupport());
    document.getElementById("menuFeatureOptions")?.addEventListener("click", () => this.#showFeatureOptions());
    document.getElementById("menuSettings")?.addEventListener("click", () => this.#showSettings());
    document.getElementById("firstRun")?.addEventListener("click", () => this.#submitFirstRun());
  }

  /**
   * Resolve a caller-supplied handler whose shape may be a function or a plain truthy/falsy value.
   *
   * The first-run hooks accept either a function (synchronous or asynchronous - both forms are awaited via the `await handler()` call below) or a literal truthy
   * value (e.g., a caller that always wants the flow to continue can pass `true`). This helper unifies both shapes into a single `Promise<boolean>` answer so the
   * call sites stay flat. The context object is forwarded to the function form so each hook is a pure function of its injected config (and, for `onSubmit`, the
   * commit callback) rather than reaching for the session or the host itself.
   *
   * @param {Function|*} handler - Caller-supplied handler. When a function, it is awaited; otherwise it is treated as a truthy/falsy continuation flag.
   * @param {FirstRunContext} [context] - The injected context forwarded to the function form of the handler.
   * @returns {Promise<boolean>} `true` when the workflow should continue, `false` when it should be aborted.
   * @private
   */
  async #processHandler(handler, context) {

    return Boolean((typeof handler === "function") ? await handler(context) : handler);
  }
}
