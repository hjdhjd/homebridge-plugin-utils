/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-theming.mjs: Page theming for the plugin webUI - the themed canvas, dark-mode handling, the page-kit classes, and Bootstrap accent probing.
 */
"use strict";

import { delay } from "./webUi-featureOptions/utils.mjs";

/**
 * Register the page theme effect. Adopts the page base stylesheet, applies the color-scheme and dark-mode class from the Homebridge lighting-mode setting, follows
 * the host's own announcements of a theme change, and probes Bootstrap's `.btn-primary` to enhance the accent tokens.
 *
 * The normal entry point is `webUi.registerTheming`, which composes this effect with the design tokens its rules read and holds both for the life of the page. A
 * direct call is for bespoke composition, where the caller owns the ordering and the lifetime itself.
 *
 * Two routes carry a host theme change into this page and the effect follows both: the message Homebridge posts into a plugin frame, and a mutation of that
 * frame body's own theme classes. Each announces a mode the user picked and a system flip an auto-detecting install inherits alike, because the host resolves
 * either into the same retint. Both routes re-read the mode through the bridge, so the bridge stays the one authority on which mode is current.
 *
 * Cleanup is automatic via the AbortSignal: aborting releases the stylesheet from the document, clears the `color-scheme`, `.fo-dark` class, and accent-token
 * inline overrides the effect wrote on `:root` (so it leaves no trace on a shared document), removes the message listener (via `{signal}` on addEventListener),
 * disconnects the class observer, and short-circuits the in-progress Bootstrap probe at the next await checkpoint.
 *
 * The function returns once the initial lighting-mode read has been applied. Both follow routes are live before that read is even issued, so a page whose initial
 * read fails or never answers still follows every later host announcement. The Bootstrap accent probe runs in the background - the caller's pipeline is not blocked
 * on probe completion. Until the probe resolves, the tokens' declared `AccentColor` / `AccentColorText` defaults remain in effect, so the user sees a sensible
 * accent immediately rather than waiting up to `probe.timeoutMs` for Bootstrap to load.
 *
 * @param {Object} args
 * @param {{userCurrentLightingMode: () => Promise<string>}} args.host - The Homebridge bridge (or a test stub matching that surface). The lighting mode is normally
 *        "light" or "dark"; any unrecognized value is tolerated and treated as a no-op (no color scheme is applied).
 * @param {AbortSignal} args.signal - Lifecycle signal. Aborting tears down the listener, the class observer, and the background probe.
 * @param {Object} [args.probe] - Optional probe overrides.
 * @param {number} [args.probe.timeoutMs=2000] - Maximum time, in milliseconds, to poll for Bootstrap's stylesheet. Override to `0` in tests to skip the probe.
 * @param {number} [args.probe.intervalMs=20] - Poll interval, in milliseconds.
 * @returns {Promise<void>} Resolves once the initial mode read has been applied, and rejects when that read rejects - the sheet and both follow routes are live
 *                          either way. Does NOT wait for the Bootstrap probe to complete.
 */
export const registerThemeEffect = async ({ host, probe: { intervalMs = 20, timeoutMs = 2000 } = {}, signal }) => {

  if(signal.aborted) {

    return;
  }

  // Build & adopt the stylesheet immediately. The user perceives the layout the moment this resolves, with the fallback accent color in effect via the CSS
  // custom-property cascade. The stylesheet content is mode-independent (`:root.fo-dark` selectors resolve dynamically based on the class), so it does not need
  // re-emission when the theme mode changes.
  const stylesheet = new CSSStyleSheet();

  stylesheet.replaceSync(buildBaseCss());
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, stylesheet ];

  /* The one follower both host routes share. The mode is captured before the abort check so a teardown that lands while the read is in flight can never be
   * overwritten afterwards: a write that raced the teardown would put `color-scheme` and the dark class back on `:root` after the effect promised to leave no
   * trace on it.
   */
  const followHostTheme = async () => {

    /* The follow is opportunistic by contract: a read that fails says nothing the initial registration's own diagnostic has not already said, the next host
     * announcement retries by construction, and both routes below fire this and forget it - so the failure is absorbed here rather than left to surface as an
     * unhandled rejection on every later toggle against an unreachable host.
     */
    let mode;

    try {

      mode = await host.userCurrentLightingMode();
    } catch {

      return;
    }

    if(signal.aborted) {

      return;
    }

    applyColorScheme(mode);
    probeAndApplyAccent();
  };

  /* Follow the host's announcement of a theme change. Homebridge retints a plugin frame by swapping theme classes on its body and posting a message into it, and
   * both routes run on a mode the user picked and on a system flip an auto-detecting install inherits, because the host resolves either into the same retint.
   * Watching our own body settles the ordering - a class change IS the retint, and mutation records deliver after it lands - while the message reaches frames the
   * host cannot reach into directly. The system color-scheme query is deliberately not a route: it answers before the host has retinted anything, and on an
   * install pinned to one mode it fires when nothing about the page changed.
   *
   * A toggle that fires both routes costs two cheap bridge reads and two accent probes. That is the accepted price of covering both announcements with no dedup
   * state that could go stale, and the payload is read for nothing but its type, so traffic from anywhere else costs one string comparison.
   */
  window.addEventListener("message", (event) => {

    if(event.data?.type === "theme-update") {

      void followHostTheme();
    }
  }, { signal });

  /* The observer watches `document.body`'s class while applyColorScheme writes on `documentElement`, so the effect's own writes can never feed back into it, and a
   * host retint landing mid-registration is followed rather than missed. Constructed through `window` so a headless harness that installs its own globals supplies
   * this one too.
   */
  const themeClassObserver = new window.MutationObserver(() => void followHostTheme());

  themeClassObserver.observe(document.body, { attributeFilter: ["class"], attributes: true });

  signal.addEventListener("abort", () => {

    // Restore the document to its pre-effect state, symmetric with every mutation the effect made to it: drop the adopted stylesheet, then the `color-scheme` and
    // `.fo-dark` class that applyColorScheme set on `:root` and the accent-token inline overrides the Bootstrap probe wrote there. The `color-scheme` removal is the
    // one that matters - it is a native property, so a leftover `dark` value would tint default form-control and scrollbar rendering on whatever content occupies the
    // document after teardown (in a multi-page host, a sibling tab). The class and token overrides are inert once the stylesheet that reads them is gone, but are
    // cleared too so the effect leaves no trace on `:root`.
    //
    // The observer takes no signal of its own, so its disconnect is spelled out here; the message listener needs no line because the native `{ signal }` option
    // detaches it. This block registers after every resource it restores exists, so there is no window in which it could fire against a half-built effect.
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== stylesheet);
    document.documentElement.classList.remove("fo-dark");
    document.documentElement.style.removeProperty("color-scheme");
    document.documentElement.style.removeProperty("--fo-accent-bg");
    document.documentElement.style.removeProperty("--fo-accent-fg");
    themeClassObserver.disconnect();
  }, { once: true });

  // Apply the color-scheme from the current Homebridge setting. The lightweight portion of "apply theme" - no Bootstrap probe required; just sets the color-scheme
  // property on :root and toggles the fo-dark class. Captured before the abort check for the same reason the follower captures its own read.
  const mode = await host.userCurrentLightingMode();

  if(signal.aborted) {

    return;
  }

  applyColorScheme(mode);

  // Fire the Bootstrap probe in the background. Its job is to replace the fallback `AccentColor` keyword with Bootstrap's actual `.btn-primary` background color;
  // until it resolves, the user sees the system accent. Void-discarded because the caller cannot meaningfully wait on it.
  void runAccentProbe({ intervalMs, signal, timeoutMs });
};

// Set the color-scheme property on :root and toggle the fo-dark class. No accent probe - the accent custom properties are managed separately so the lightweight
// color-scheme update does not pay the probe cost.
const applyColorScheme = (mode) => {

  if((mode !== "dark") && (mode !== "light")) {

    return;
  }

  const current = document.documentElement.style.getPropertyValue("color-scheme");

  if(current === mode) {

    return;
  }

  document.documentElement.style.setProperty("color-scheme", mode);
  document.documentElement.classList.toggle("fo-dark", mode === "dark");
};

// Background probe coordinator. Awaits Bootstrap readiness (or the timeout), then re-probes the accent color and writes the result into the :root custom properties.
// A teardown that fires mid-probe short-circuits the post-await mutation; the stylesheet stays adopted (the signal-keyed listener handles that) and the fallback
// accent remains in effect for the brief window before teardown completes.
const runAccentProbe = async ({ intervalMs, signal, timeoutMs }) => {

  await waitForBootstrap({ intervalMs, signal, timeoutMs });

  if(signal.aborted) {

    return;
  }

  probeAndApplyAccent();
};

// Probe the current Bootstrap `.btn-primary` accent color and write it into the `--fo-accent-*` tokens. The cascade propagates the change to every element
// referencing the accent tokens or their `color-mix()` derivatives.
//
// Probed values are validated before being written. An empty string or fully-transparent value (which happens when Bootstrap's stylesheet has not applied to the
// probe button yet) is rejected, leaving the tokens module's declared `AccentColor` default in effect. The opportunistic-override contract: the probe enhances
// when it can, never degrades when it can not.
const probeAndApplyAccent = () => {

  const colors = probeAccentColor();

  if(isValidAccentValue(colors.background)) {

    document.documentElement.style.setProperty("--fo-accent-bg", colors.background);
  }

  if(isValidAccentValue(colors.text)) {

    document.documentElement.style.setProperty("--fo-accent-fg", colors.text);
  }
};

// Probe the current primary background and foreground from Bootstrap's .btn-primary. Returns an object with the two resolved color values; caller decides whether
// to accept or reject each via {@link isValidAccentValue}.
const probeAccentColor = () => {

  const probeBtn = document.createElement("button");

  probeBtn.className = "btn btn-primary";

  // getComputedStyle resolves color and background-color independent of layout, so hiding the probe button via display: none does not affect the readout below.
  probeBtn.style.display = "none";
  document.body.appendChild(probeBtn);

  const background = getComputedStyle(probeBtn).backgroundColor;
  const text = getComputedStyle(probeBtn).color;

  document.body.removeChild(probeBtn);

  return { background, text };
};

// Whether a probed accent-color value is usable. Empty, fully transparent, or `unset`-equivalent values mean the probe ran before Bootstrap was ready; writing
// them would replace the sensible `AccentColor` default with a useless value.
const isValidAccentValue = (value) => {

  if(!value) {

    return false;
  }

  const normalized = value.replace(/\s+/g, "").toLowerCase();

  return (normalized !== "transparent") && (normalized !== "rgba(0,0,0,0)");
};

// Wait for Bootstrap to finish loading in the DOM, or until the timeout expires. The composed signal (deadline + caller) is the single source of truth for the
// loop and each per-iteration delay; one mechanism handles both timeout exhaustion and external cancellation. Emits a console.warn when the timeout expires
// without detecting Bootstrap - a timeout-with-no-result is actionable info for plugin developers configuring their UI; without the warning the silent fallback
// would leave them wondering why their accent color does not match Bootstrap.
const waitForBootstrap = async ({ intervalMs, signal, timeoutMs }) => {

  // Honor the documented `probe: { timeoutMs: 0 }` opt-out synchronously. A pre-aborted caller signal gets the same fast path.
  if((timeoutMs <= 0) || signal.aborted) {

    return false;
  }

  // .d-none is a Bootstrap-defined utility class, not a native CSS keyword; its display: none effect on this briefly-attached probe element only appears once
  // Bootstrap's stylesheet has actually applied, making it a reliable readiness signal.
  const isBootstrapApplied = () => {

    const testElem = document.createElement("div");

    testElem.className = "d-none";
    document.body.appendChild(testElem);

    const display = getComputedStyle(testElem).display;

    document.body.removeChild(testElem);

    return display === "none";
  };

  const deadline = AbortSignal.timeout(timeoutMs);
  const composed = AbortSignal.any([ signal, deadline ]);

  while(!composed.aborted) {

    if(isBootstrapApplied()) {

      return true;
    }

    try {

      // The poll interval is the loop's intentional throttle - one probe per interval, not in a tight loop. Same exception as the persist drain: the await is the
      // point of the iteration.
      // eslint-disable-next-line no-await-in-loop
      await delay(intervalMs, composed);
    } catch {

      // Composed signal aborted (deadline or caller). Exit the loop.
      break;
    }
  }

  // Only warn on the deadline path - a caller-driven abort (page teardown) is not actionable, just a lifecycle event. The accent color falls back to the system
  // AccentColor keyword; the UI continues to function.
  if(deadline.aborted && !signal.aborted) {

    // eslint-disable-next-line no-console
    console.warn("FeatureOptions: Bootstrap stylesheet did not load within " + timeoutMs + "ms - accent color falling back to the system AccentColor keyword.");
  }

  return false;
};

// The page base stylesheet: the rules that belong to a plugin's whole page rather than to any one view - the reset, the forced canvas pair, the dark corrections
// for Bootstrap's page-wide text utilities, the shared utility classes, and the page kit a custom view opts into. Color, radius, spacing, and opacity values
// reference the `--fo-*` tokens declared by the tokens effect; the reset uses raw values since it is not a design-token concern. Every rule here is safe on a page
// the framework does not otherwise render: each is either framework-named with no host counterpart, or matches the semantics a colliding host utility carries.
const buildBaseCss = () => [

  // Base layout reset.
  "html, body { margin: 0; padding: 0; }",

  // Single source of truth for option-row visibility. Search, filter, and dependency logic all toggle this class.
  ".fo-hidden { display: none !important; }",

  // Page background AND base text color - the two halves of the base contrast pair, owned together. HBPU forces the surface background, so it must also own the text
  // color: otherwise the body inherits config-ui-x's cascade, which - because the custom-UI iframe body carries Bootstrap's `.modal-content` class - resolves the
  // text from `--bs-modal-color` rather than the surface's body color, so an unrelated host value can land on the forced background and render inherited text
  // (category headers, device names) unreadable. `!important` beats `.modal-content`'s class-level color; elements carrying their own `.text-*` class still set
  // their own color, so only un-classed inherited text is affected.
  "body { background-color: var(--fo-surface-bg) !important; color: var(--fo-text-on-elevated) !important; }",

  // A secret option's masked field and its reveal toggle share a horizontal wrapper inside the stacking content cell, which is what seats the control beside the
  // field rather than beneath it. The toggle carries none of the native button chrome and inherits the surrounding text color, so the eye glyph inside it - drawn
  // in currentColor - takes whatever color the row's text carries in either mode, with no color rule of its own to keep in step.
  ".fo-secret-field { align-items: center; display: flex; gap: var(--fo-space-xs); max-width: 100%; }",
  ".fo-secret-toggle { align-items: center; background: none; border: 0; color: inherit; cursor: pointer; display: inline-flex; " +
    "line-height: 1; padding: 0; }",

  // A locked row's toggle is disabled, and surrendering the native button chrome means surrendering the browser's own disabled rendering with it - so the dim and
  // the default cursor are what keep a control the row will not answer from presenting itself as one that will. The dim comes from `--fo-opacity-disabled`, the
  // shared not-actionable value.
  ".fo-secret-toggle:disabled { cursor: default; opacity: var(--fo-opacity-disabled); }",

  // Dark-mode corrections for Bootstrap's page-wide text utilities. Bootstrap pins its own grey on the element with `!important`, so these escape the forced body
  // text color above, and a grey calibrated for a light canvas is unreadable on the dark surface.
  ":root.fo-dark .text-body { color: var(--fo-text-muted) !important; }",
  ":root.fo-dark .text-muted { color: var(--fo-text-muted) !important; }",

  /* The menu tabs and the plugin controls that share their ghost. Two vocabularies, one definition: `.fo-menu` is a tab and `.fo-action` is something a plugin's own
   * sidebar control offers, and they are grouped rather than duplicated so the quiet treatment cannot drift into two slightly different quiets. What separates them is
   * only what the accent means - a solid accent fill says "where you are", which is why it stays menu-only, and the ghost says "something you can do".
   *
   * The active tab takes that fill and everything else takes the ghost, which puts the eye-catching treatment on the tab the user is actually on. That reading holds
   * in both modes by construction: a saturated fill against a transparent ghost cannot invert the way two Bootstrap variants can, whichever canvas they land on. The
   * fill is the host-probed accent, so a host that re-themes carries the tabs with it and no value here needs revisiting.
   *
   * The ghost's text is the mode-aware muted neutral, whose dark override gives the quiet light-on-dark reading a dark canvas wants, and its border is the accent
   * frame every visible container on the page already wears, so a ghost control reads as part of the page's own chrome rather than as grey furniture beside it.
   * Both tab states declare the same hairline border so the geometry never shifts as the active tab moves, and the active one declares it transparent so the fill
   * alone describes the state. Everything else about size is the `btn` class the markup already carries, which these rules deliberately leave alone.
   *
   * The hover tint is an affordance for something the user can act on, so it is unconditional for an action and scoped away from the active tab: hovering the tab you
   * are already on offers nothing and must not lift the accent fill off it.
   *
   * Every state either vocabulary can be in is spelled out here rather than left to whatever the page around us says, because the host stylesheet carries its own
   * stateful `.btn` rules and a class-plus-pseudo-class selector outranks a bare class. A button wearing no Bootstrap variant resolves those rules' color variables to
   * nothing, so an unpinned state shows the canvas through it. Pinning is limited to background, text, and border color: box-shadow and outline stay the host's, which
   * is what keeps its focus ring intact.
   *
   * Where our own selectors tie on specificity - the ghost's states against the active tab's - source order decides, so the active rule is written last and the fill
   * holds on the tab the user is on.
   */
  ".fo-action, .fo-menu { background: transparent; border: 1px solid var(--fo-border-accent); color: var(--fo-text-muted); }",
  ".fo-action:hover, .fo-action:focus, .fo-action:active, .fo-menu:hover, .fo-menu:focus, .fo-menu:active { " +
    "border-color: var(--fo-border-accent); color: var(--fo-text-muted); }",
  ".fo-action:hover, .fo-menu:not(.fo-menu-active):hover { background: var(--fo-accent-hover); }",
  ".fo-menu-active, .fo-menu-active:hover, .fo-menu-active:focus, .fo-menu-active:active { background: var(--fo-accent-bg); " +
    "border: 1px solid transparent; color: var(--fo-accent-fg); }",

  // Utility styles.
  ".btn-xs { font-size: var(--fo-font-size-xs) !important; padding: var(--fo-space-xxs) var(--fo-space-sm) !important; line-height: 1.5; touch-action: manipulation; }",
  ".cursor-pointer { cursor: pointer; }",
  ".user-select-none { user-select: none; -webkit-user-select: none; }",

  // Accessibility.
  "@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }",

  /* The page kit: the classes a plugin puts on its own custom views so they wear the framework's look. `.fo-card` is the accent-derived frame every framework
   * container already wears, `.fo-monospace` is the per-field monospace opt-in, and `.fo-page` is the marker that scopes the dark form-control corrections - a
   * plugin puts it on a custom-page container and that container's plain form controls become dark-mode-correct, with nothing outside it touched. `.fo-action` is
   * the fourth, declared above beside the menu rules it shares its definition with: a plugin puts it on its own sidebar controls so they wear the framework's quiet
   * action treatment. That placement is deliberate, because the ghost is one definition serving both vocabularies and the source-order reasoning that keeps the
   * active tab's fill intact reads as one piece. The vocabulary rule a consumer needs is the whole of it: the solid accent means "where you are", so it belongs to
   * the page's own navigation, while the ghost means "something you can do". Those
   * corrections are needed because the host retints a plugin frame's theme classes but never restyles a plain form control, so an unthemed field stays light on a
   * dark page; light mode is deliberately left to Bootstrap, exactly as the framework treats its own fields.
   *
   * Every value reads a token with no literal fallback beside it. The registration surface that adopts this sheet adopts the token sheet first, so the tokens are
   * in force wherever these rules are, by that surface's own construction.
   */
  ".fo-card { border: 1px solid var(--fo-border-accent); border-radius: var(--fo-radius-md); }",
  ".fo-monospace { font-family: var(--fo-font-monospace); }",
  ":root.fo-dark .fo-page .form-control { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-border); " +
    "color: var(--fo-text-on-elevated); }",
  ":root.fo-dark .fo-page .form-control::placeholder { color: var(--fo-form-control-placeholder); }",
  ":root.fo-dark .fo-page .form-control:focus { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-focus-border); " +
    "box-shadow: var(--fo-focus-ring); color: var(--fo-text-on-elevated); }"

].join("\n");
