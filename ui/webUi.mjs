/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi.mjs: Plugin webUI.
 */
"use strict";

import { BOOT_AWAIT_DEADLINE_SECONDS, webUiFeatureOptions } from "./webUi-featureOptions.mjs";
import { DeadlineExpiredError, createResumeDetector, withDeadline } from "./webUi-liveness.mjs";
import { swapMenuClasses, toastError } from "./webUi-featureOptions/utils.mjs";
import { PluginConfigSession } from "./pluginConfigSession.mjs";
import { registerThemeEffect } from "./webUi-theming.mjs";
import { registerTokensEffect } from "./webUi-tokens.mjs";

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
 * The resume-subscription handle this instance hands down to the feature-options orchestrator and the views it mounts.
 *
 * The shape is the resume detector's own `subscribe` contract, documented on `createResumeDetector` in the liveness module; what this wrapper adds is the epoch
 * bound, so a subscription registered through it also ends when a successor supersedes this copy. Stated once here because the wrapper and the wiring both name it.
 *
 * @typedef {Object} EpochScopedResumeHandle
 * @property {(callback: () => void, options?: { shouldProbe?: () => boolean, signal?: AbortSignal }) => void} subscribe - Register a resume subscriber.
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
   * Every subscription is bounded by the page epoch as well as by whatever signal the caller supplies: it never outlives the newest `webUi` construction in this
   * window, so a plugin holding a subscription in a settings frame that gets reopened does not need to retire it itself.
   *
   * @example
   *
   * // Refresh a price poll when the page wakes, but only while this plugin's panel is the one on screen.
   * ui.liveness.onResume(() => refreshPrices(), { shouldProbe: () => panelVisible, signal });
   *
   * @type {{ onResume: (callback: () => void, options?: { shouldProbe?: () => boolean, signal?: AbortSignal }) => void }}
   */
  liveness;

  #epochSignal;
  #firstRun;
  #menuBound = false;
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
   * Construction is also the page's retirement chokepoint: it aborts the epoch of whichever copy held the window and claims the window for this one, which retires
   * the abandoned copy whole - its liveness subscriptions, its orchestrator cycle and every view effect and host listener that cycle scopes, its menu handlers, and
   * any late launch settlement that would otherwise repaint shared chrome.
   *
   * @param {WebUiConfig} [options] - Configuration options for the webUI. All fields are optional; firstRun's hooks fall back to no-op handlers, and
   * featureOptions/name simply default to undefined.
   */
  constructor({ featureOptions, firstRun = {}, name } = {}) {

    /* Retire the predecessor and claim the window. The settings frame is reused across panel opens and each open imports a fresh cache-busted module copy, so the
     * copy under construction here is the only party that knows the previous one is dead: no teardown event reaches an abandoned copy - the same silence that makes
     * the clock-gap resume detector necessary in the first place - so nothing else can tell it to stand down, and its timers, listeners, and handlers would go on
     * running in the reused window against DOM the successor now owns. Construction is the one moment a successor provably exists, which is what makes it the place
     * to do this.
     *
     * The boot monitor's `webUiBoot` global is the precedent for holding state across module copies in one window; its own semantics are first-wins, while the
     * newest-wins supersession here is this design's own. The duck-typed guard is the browser-boundary narrowing posture: a foreign value squatting on the property
     * degrades to replacement rather than a constructor throw, so a page that renders is never traded for a page that does not. A window's first construction finds
     * no predecessor and no-ops.
     */
    if(typeof globalThis.webUiPageEpoch?.abort === "function") {

      globalThis.webUiPageEpoch.abort();
    }

    globalThis.webUiPageEpoch = new AbortController();

    this.#epochSignal = globalThis.webUiPageEpoch.signal;

    // First-run handlers default to no-ops; caller-supplied entries override per-key. The single-statement spread lands `#firstRun` in its final shape on first
    // assignment, so there is no intermediate object that gets discarded a line later.
    this.#firstRun = { isRequired: () => false, onStart: () => true, onSubmit: () => true, ...firstRun };

    // One resume detector for the whole page. The thing it measures - a freeze in wall-clock time - is a property of the page, not of any view that happens to be
    // mounted, so it belongs to the object whose lifetime is the page's and is handed down to the feature-options instance as framework wiring rather than as plugin
    // configuration. Its sampling timer is demand-driven, so a page whose views never subscribe pays nothing for holding one.
    this.#resumeDetector = createResumeDetector();

    /** @type {EpochScopedResumeHandle} */
    const resumeDetector = { subscribe: (callback, options) => this.#resumeDetector.subscribe(callback, this.#scopedToEpoch(options)) };

    this.featureOptions = new webUiFeatureOptions(featureOptions, {

      epochSignal: this.#epochSignal,
      registerTheming: (options) => this.registerTheming(options),
      resumeDetector
    });

    this.liveness = { onResume: (callback, options) => this.#resumeDetector.subscribe(callback, this.#scopedToEpoch(options)) };
    this.#name = name;
  }

  /**
   * The lifetime of this module copy's claim on the window, as an `AbortSignal`. It aborts when a newer `webUi` construction in this window supersedes this copy,
   * and at no other time. The retirement itself belongs to {@link webUi.constructor}, which documents what a supersession reaches, so the mechanism stays described
   * in one place.
   *
   * Which signal a resource is scoped to is the question this surface exists to answer. A plugin holds resources with two different lifetimes and each has its own
   * signal. The mount signal a render hook receives - the infoPanel bag's `signal` - ends when the panel it drew into is torn down, by a navigation away or by a
   * re-show, and is the right scope for anything that serves the panel currently on screen. This signal ends only when a successor copy claims the window, and is
   * the right scope for anything belonging to the module copy itself and meant to outlive any one panel: a recurring poll whose cache survives a navigation, or a
   * listener registered on an object the frame keeps across copies.
   *
   * Published as a getter rather than a public field so the implementation is free to change without breaking callers; the observable shape is what plugins might
   * consume, and the field behind it stays the class's own. What a consumer receives is the signal and never the controller, so a plugin can observe the end of its
   * copy but can never declare it. It is deliberately not a teardown notification for the feature-options page either - that lifetime is the mount signal's.
   *
   * Adding an abort listener to a signal that has already aborted never fires it. A registration made synchronously in a render hook's own body cannot reach that
   * state - the mount signal aborts with the epoch, so no render runs after a supersession - which is why the example below needs no guard for it. The framework
   * calls a render hook un-awaited, so a hook that awaits and then registers from a deferred continuation can land on an already-aborted signal; that registration,
   * like any made outside a render hook, checks `aborted` first.
   *
   * @example
   *
   * // A poll that outlives any single panel: armed once for this module copy, and ended only when a newer copy claims the window. The teardown is registered before
   * // the resource it tears down, so a throw between the two statements can never leave an orphaned poll behind the re-entry guard.
   * if(refreshTimer === undefined) {
   *
   *   ui.epochSignal.addEventListener("abort", () => clearInterval(refreshTimer), { once: true });
   *
   *   refreshTimer = setInterval(() => void refreshPrices(), REFRESH_INTERVAL_MS);
   * }
   *
   * @returns {AbortSignal}
   */
  get epochSignal() {

    return this.#epochSignal;
  }

  /**
   * Register an event listener for the life of this module copy.
   *
   * A listener bound to a target that outlives a single module copy - the window, the document, the `homebridge` bridge - has to be retired when a successor claims
   * the window, and composing that lifetime by hand at every registration is where the composition gets forgotten. This method owns it, so a plugin writes the
   * registration it means and the epoch bound comes with it.
   *
   * Which of the page's two lifetimes a resource wants is the question {@link webUi.epochSignal} answers at length, and the answer decides between this method and
   * the mount signal: this scopes to the module copy, which suits a listener on an object the frame keeps across copies, while a listener serving the panel
   * currently on screen belongs on the mount signal a render hook receives, registered directly with that signal.
   *
   * A caller's own `signal` composes rather than replaces - whichever of the two aborts first removes the listener - so a consumer that already scopes a listener to
   * some narrower lifetime keeps that scope and gains the epoch bound on top of it. The `capture`-boolean spelling `addEventListener` accepts is normalized into the
   * options-object form before that composition, so both call shapes reach the platform meaning the same thing.
   *
   * Positional parameters are deliberate here, against the house preference for an options object: this wraps `addEventListener`, and mirroring the platform API's
   * universally-known shape is what makes a registration readable at a glance - a reader who knows `addEventListener` already knows this.
   *
   * The helper serves `addEventListener` targets, which is what accepting a `signal` at all means. A resource with no signal support of its own - a
   * `MutationObserver`, an interval, a subscription to a foreign API - takes the `epochSignal.addEventListener("abort", ...)` teardown idiom that getter documents.
   *
   * A nullish target registers nothing. An element the page's markup omits declares that surface absent rather than marking the page broken, which is the stance the
   * menu bindings take on their own buttons, so a plugin may register straight against `document.getElementById(...)` output without guarding each site. The cost
   * this accepts is that a mistyped element id reads as an omitted surface and registers in silence, so a listener that never fires is first checked against the id
   * it was registered on.
   *
   * @example
   *
   * // A host push this plugin consumes for as long as its copy holds the window, retired the moment a newer copy claims it.
   * ui.on(homebridge, "my-plugin-push", (event) => renderPush(event.data));
   *
   * @param {?EventTarget} target - The target to register on. Nullish registers nothing.
   * @param {string} event - The event type.
   * @param {Function} handler - The listener.
   * @param {(Object|boolean)} [options] - The platform's own listener options, or the `capture` boolean shorthand. A `signal` among them composes with the epoch.
   * @public
   */
  on(target, event, handler, options) {

    // An element the page's markup omits declares that surface absent - the menu binder's own posture - so a nullish target registers nothing rather than treating
    // the page as broken. The trade this accepts is documented on the method: a mistyped element id also lands here, silently.
    if(!target) {

      return;
    }

    const normalized = (typeof options === "boolean") ? { capture: options } : (options ?? {});

    target.addEventListener(event, handler, { ...normalized, signal: this.epochBounded(normalized.signal) });
  }

  /**
   * Register the framework's theming for the life of this page.
   *
   * One call is the whole contract: it adopts the design-token sheet, then the page theme - the themed canvas, dark-mode handling, the page-kit classes, and the
   * Bootstrap accent probe - and holds both for as long as this module copy owns the window. Theming is a page concern rather than a view one, since everything it
   * writes lands on `:root` and `body`, so a plugin's first-run page, support tab, and settings form all keep the theme rather than losing it on every navigation.
   * The feature-options view routes through this same registration rather than registering theming of its own.
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

      registerTokensEffect({ signal: this.#epochSignal });
      this.#themingPromise = registerThemeEffect({ host: homebridge, probe, signal: this.#epochSignal });

      // A caller that voids the returned promise attaches no rejection handler, and the void operator does not mark a rejection handled - so this branch owns the
      // diagnostic posture: it marks a failed initial mode read handled for the page (the failure is survivable by design - the sheets and the followed host
      // signals are live, and the next host announcement applies the mode), while a caller that awaits still observes the rejection through its own branch of the
      // same promise.
      this.#themingPromise.catch(() => {});
    }

    return this.#themingPromise;
  }

  /**
   * Bound a lifecycle signal by this module copy's own lifetime.
   *
   * The one home for the epoch-composition rule, and the surface a plugin reaches for when it holds a lifetime of its own that should also end when a successor
   * claims the window. The framework's own consumers run through it too - {@link webUi.on} composes every listener registration here, and the liveness
   * subscriptions compose their option bags here - so a plugin bounding a wiring envelope and the framework bounding a listener are applying one rule rather than
   * two that could drift apart.
   *
   * Called with no signal, it hands back the page epoch itself rather than a composition over one, so the common case allocates no `AbortSignal.any` at all. Called
   * with a signal, it hands back a composition that ends when either side does - the caller's own lifetime, or a supersession, whichever comes first. An
   * already-aborted input yields an already-aborted composition, by the platform's own `AbortSignal.any` semantics rather than by anything added here.
   *
   * Which of the page's two lifetimes a resource actually wants is the question {@link webUi.epochSignal} answers at length. This method is how that answer gets
   * applied once it is the epoch's.
   *
   * @example
   *
   * // A wiring envelope that ends on its own abort or on a supersession, whichever lands first, so every cancellation point downstream reads one signal.
   * const wiringSignal = ui.epochBounded(wiringController.signal);
   *
   * @param {AbortSignal} [signal] - The caller's own lifecycle signal, when it has one.
   * @returns {AbortSignal} The caller's signal bounded by the epoch, or the epoch itself.
   * @public
   */
  epochBounded(signal) {

    return signal ? AbortSignal.any([ signal, this.#epochSignal ]) : this.#epochSignal;
  }

  /**
   * Bound a liveness subscription's options by the page epoch.
   *
   * Applied at both points this instance hands a subscription out: the public `liveness.onResume` surface and the detector handle threaded down to the views. The
   * options default keeps the documented single-argument `onResume(callback)` call shape working, and the spread carries every sibling key through by construction
   * rather than by enumeration, so a key the detector grows later needs no edit here. The lifetime comes from {@link webUi.epochBounded}, so whichever of the
   * caller's own signal and the epoch aborts first removes the subscription - the same demand-driven disarm the detector already implements. The detector itself
   * stays page-ignorant either way, since deciding what supersedes a page is this object's job and not the primitive's.
   *
   * @param {{ shouldProbe?: () => boolean, signal?: AbortSignal }} [options] - The caller's own subscription options.
   * @returns {{ shouldProbe?: () => boolean, signal: AbortSignal }} The caller's options with the lifecycle signal bounded by the epoch.
   * @private
   */
  #scopedToEpoch(options = {}) {

    return { ...options, signal: this.epochBounded(options.signal) };
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

      // A superseded copy settles its launch late - the stalled session open it was holding expires or heals long after a reopen replaced it - and the toast and the
      // menu below are shared chrome the successor now owns. Bail before touching either: the failure belongs to a page nobody is looking at any more, so reporting
      // it would put a stale diagnostic over the successor's working page. This is the #unlessStale discipline the feature-options cycle already runs on, applied at
      // this layer against this layer's own lifetime.
      if(this.#epochSignal.aborted) {

        return;
      }

      // The outermost user-facing diagnostic in the webUI. Caller-supplied first-run handlers and other extension points can throw any shape, so the shared
      // toastError normalization extracts a useful message regardless of what bubbled out of `#launchWebUI`.
      this.#toastLaunchFailure(err);

      // A launch that never established a session has rendered nothing, so the menu is the only way forward the user has - and it starts hidden. Reveal it here, and
      // only here: the first-run route keeps it hidden on purpose until that flow completes, and a failure that happened after routing has already revealed it.
      if(!this.#session) {

        const menuWrapper = document.getElementById("menuWrapper");

        if(menuWrapper) {

          menuWrapper.style.display = "inline-flex";
        }
      }
    } finally {

      // The spinner and the boot monitor are the same shared chrome the catch above guards, so a superseded copy's settlement leaves both alone: hiding the spinner
      // would pull it out from under the successor's own in-flight launch, and standing the boot monitor down would retract a panel raised for a page this copy no
      // longer speaks for.
      if(!this.#epochSignal.aborted) {

        homebridge.hideSpinner();

        // Stand the boot monitor down. Once show() settles the app owns the surface either way - on success the UI rendered, on failure the toast above displayed the
        // diagnostic - so any earlier boot-phase error the monitor may have caught was non-fatal, and it should retract any panel it raised. The optional chain tolerates
        // a stamped region that carries no boot monitor.
        globalThis.webUiBoot?.ready?.();
      }
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
   * When no session exists, the click re-runs the launch instead. That is the recovery path for a launch whose config read never answered: the menu is bound and the
   * user is looking at a toast, so the one affordance they have must re-attempt the open rather than hand `show()` a session that was never established. The
   * menu-binding guard keeps the re-launch from stacking a second set of listeners.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showFeatureOptions() {

    try {

      if(!this.#session) {

        await this.#launchWebUI();

        return;
      }

      await this.featureOptions.show(this.#session);
    } catch(err) {

      this.#toastLaunchFailure(err);
    }
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

      swapMenuClasses("menuHome", "btn-elegant", "btn-primary");
      swapMenuClasses("menuFeatureOptions", "btn-elegant", "btn-primary");
      swapMenuClasses("menuSettings", "btn-primary", "btn-elegant");

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

      swapMenuClasses("menuHome", "btn-primary", "btn-elegant");
      swapMenuClasses("menuFeatureOptions", "btn-elegant", "btn-primary");
      swapMenuClasses("menuSettings", "btn-elegant", "btn-primary");

      document.getElementById("pageSupport").style.display = "block";
      document.getElementById("pageFeatureOptions").style.display = "none";

      homebridge.hideSpinner();
    }
  }

  /**
   * Launch the webUI.
   *
   * Wires the menu event listeners, opens the configuration session, and routes the user to either the feature-options view (when the caller's first-run gate says
   * no) or the first-run flow (when it says yes). The session loads the host config once and seeds the minimum shape, so routing and every downstream reader share
   * one config owner rather than fetching it independently. The menu is wired ahead of the session because it is the recovery affordance for an open that fails.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #launchWebUI() {

    // Bind the persistent menu listeners before any I/O. The buttons are page chrome rather than session state - each handler reads the current `this.#session` at
    // click time - so binding first is what leaves the user a working menu when the open below never answers. The binder is a no-op on any subsequent launch, so the
    // recovery path's re-launch never stacks a second handler on each button.
    this.#bindMenuListeners();

    // Open the configuration session: one host read, seeded to the minimum shape. Routing, the first-run flow, and the feature-options page all read their config
    // from this single owner rather than re-fetching it independently - so the routing decision lands before any UI work begins and against the same data every
    // later reader sees.
    //
    // This is the page's FIRST bridge call, and an unbounded one would be the worst place to hang: nothing has rendered, so the user sees a spinner over an empty
    // frame with no diagnostic and no way forward. The deadline takes no signal because none exists to take - the launch runs once per page load with no cycle that
    // could supersede it - and its failure surfaces through show()'s toast with the menu left usable for another attempt.
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

    // Await first-run setup so the spinner-bracketed window in `show()` only closes after the first-run page is fully wired up - the onStart handler has resolved,
    // the save button is disabled, the click listener is registered, and the page is visible. Returning before this would let `show()`'s `finally` hide the spinner
    // while initialization is still in flight, leaving the user looking at a half-rendered first-run UI.
    await this.#showFirstRun();
  }

  /**
   * Bind the top-level menu click listeners exactly once for the webUI's lifetime.
   *
   * The menu buttons are page chrome that persists across every show() cycle, so their listeners belong to the whole page rather than to any one show()'s teardown.
   * A one-shot guard keeps a repeated #launchWebUI from stacking a second handler on each button, which would fire every tab switch twice. Each arrow reads the
   * current this.#session through its #show* method, so a single persistent listener always acts on the latest session even after a re-launch replaces it.
   *
   * Which buttons exist is the plugin's declaration rather than this framework's: the markup carries whatever menu surfaces the plugin offers, and every one the page
   * carries is bound here. A button the markup omits offers no entry to its view, which is the whole of what its absence means, so each bind steps over an id the
   * page does not carry rather than treating it as a broken page.
   *
   * The epoch signal is what bounds them. The buttons themselves outlive any single module copy - they are elements of the reused frame, not of the copy that bound
   * them - so a copy that is superseded and whose handlers stayed attached would answer every click alongside the successor's, running each tab switch twice against
   * two different sessions. Binding on the epoch retires this copy's set at the moment the successor claims the window.
   *
   * Menu click listeners use a uniform shape: an arrow expression that calls a handler and returns its result. addEventListener discards the return value, so each
   * async handler's promise is dropped; the handlers own their error handling so the drop carries no unobserved rejection. #showFeatureOptions wraps
   * featureOptions.show() in a try/catch that toasts a failed re-entry - the show pipeline can reject (a plugin getDevices hook that resolves the wrong shape trips
   * the device-list contract guard, for one), and without the wrapper that rejection would surface nowhere. #showSettings and #showSupport each bracket their
   * navigate-away flush in a try/finally that reveals the next tab and drains the spinner on every path (the flush drain's own failure surfaces via persist:failed's
   * toast).
   *
   * @private
   */
  #bindMenuListeners() {

    if(this.#menuBound) {

      return;
    }

    this.#menuBound = true;

    const signal = this.#epochSignal;

    document.getElementById("menuHome")?.addEventListener("click", () => this.#showSupport(), { signal });
    document.getElementById("menuFeatureOptions")?.addEventListener("click", () => this.#showFeatureOptions(), { signal });
    document.getElementById("menuSettings")?.addEventListener("click", () => this.#showSettings(), { signal });
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
}
