/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/theme.mjs: Theme detection, stylesheet adoption, dark-mode toggling, and Bootstrap accent probing for the feature options webUI.
 */
"use strict";

import { delay } from "../utils.mjs";

/**
 * Register the theme effect. Adopts the layout/behavior stylesheet, applies color-scheme + dark-mode class from the Homebridge lighting-mode setting, listens for
 * `prefers-color-scheme` changes, and probes Bootstrap's `.btn-primary` to enhance the accent tokens.
 *
 * Cleanup is automatic via the AbortSignal: aborting releases the stylesheet from the document, clears the `color-scheme`, `.fo-dark` class, and accent-token inline
 * overrides the effect wrote on `:root` (so it leaves no trace on a shared document), removes the matchMedia listener (via `{signal}` on addEventListener), and
 * short-circuits the in-progress Bootstrap probe at the next await checkpoint.
 *
 * The function returns once the synchronous portion completes (stylesheet adopted, color-scheme applied, matchMedia listener registered). The Bootstrap accent
 * probe runs in the background - the caller's `show()` pipeline is not blocked on probe completion. Until the probe resolves, the tokens' declared `AccentColor` /
 * `AccentColorText` defaults remain in effect, so the user sees a sensible accent immediately rather than waiting up to `probe.timeoutMs` for Bootstrap to load.
 *
 * @param {Object} args
 * @param {{userCurrentLightingMode: () => Promise<string>}} args.host - The Homebridge bridge (or a test stub matching that surface). The lighting mode is normally
 *        "light" or "dark"; any unrecognized value is tolerated and treated as a no-op (no color scheme is applied).
 * @param {AbortSignal} args.signal - Lifecycle signal. Aborting tears down every listener and the background probe.
 * @param {Object} [args.probe] - Optional probe overrides.
 * @param {number} [args.probe.timeoutMs=2000] - Maximum time, in milliseconds, to poll for Bootstrap's stylesheet. Override to `0` in tests to skip the probe.
 * @param {number} [args.probe.intervalMs=20] - Poll interval, in milliseconds.
 * @returns {Promise<void>} Resolves when the synchronous setup is complete (after color-scheme is applied and the matchMedia listener is registered). Does NOT wait
 *                          for the Bootstrap probe to complete.
 */
export const registerThemeEffect = async ({ host, probe: { intervalMs = 20, timeoutMs = 2000 } = {}, signal }) => {

  if(signal.aborted) {

    return;
  }

  // Build & adopt the stylesheet immediately. The user perceives the layout the moment this resolves, with the fallback accent color in effect via the CSS
  // custom-property cascade. The stylesheet content is mode-independent (`:root.fo-dark` selectors resolve dynamically based on the class), so it does not need
  // re-emission when the theme mode changes.
  const stylesheet = new CSSStyleSheet();

  stylesheet.replaceSync(buildThemeCss());
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, stylesheet ];

  signal.addEventListener("abort", () => {

    // Restore the document to its pre-effect state, symmetric with every mutation the effect made to it: drop the adopted stylesheet, then the `color-scheme` and
    // `.fo-dark` class that applyColorScheme set on `:root` and the accent-token inline overrides the Bootstrap probe wrote there. The `color-scheme` removal is the
    // one that matters - it is a native property, so a leftover `dark` value would tint default form-control and scrollbar rendering on whatever content occupies the
    // document after teardown (in a multi-page host, a sibling tab). The class and token overrides are inert once the stylesheet that reads them is gone, but are
    // cleared too so the effect leaves no trace on `:root`.
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== stylesheet);
    document.documentElement.classList.remove("fo-dark");
    document.documentElement.style.removeProperty("color-scheme");
    document.documentElement.style.removeProperty("--fo-accent-bg");
    document.documentElement.style.removeProperty("--fo-accent-fg");
  }, { once: true });

  // Apply the color-scheme from the current Homebridge setting. The lightweight portion of "apply theme" - no Bootstrap probe required; just sets the color-scheme
  // property on :root and toggles the fo-dark class.
  applyColorScheme(await host.userCurrentLightingMode());

  if(signal.aborted) {

    return;
  }

  // Listen for system / browser changes to the current dark-mode setting. Re-applying the color-scheme is cheap (no probe); the accent is then re-probed directly
  // and immediately below - not through the deferred wait-for-Bootstrap path used at initial registration - since Bootstrap is assumed to already be loaded by
  // the time a preference change can fire.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {

    applyColorScheme(await host.userCurrentLightingMode());

    if(signal.aborted) {

      return;
    }

    probeAndApplyAccent();
  }, { signal });

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

// The theme stylesheet. Layout, sidebar, category-frame, search bar, dark-mode utility-class overrides. Color, spacing, radius, and motion values reference the
// `--fo-*` tokens declared by the tokens effect; structural layout rules (resets, flex containers, container queries) intentionally use raw values since they are
// not design-token concerns. Consumers see one cohesive design language regardless of which mode is active.
const buildThemeCss = () => [

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

  // Page layout.
  "#pageFeatureOptions { display: flex !important; flex-direction: column; width: 100%; }",
  ".feature-main-content { display: flex !important; flex-direction: row !important; width: 100%; }",

  // Sidebar. Background matches the main surface rather than an elevated fill; an accent-derived border delineates it, consistent with the other container frames.
  "#sidebar { display: block; width: 200px; min-width: 200px; max-width: 200px; position: relative; " +
    "background-color: var(--fo-surface-bg) !important; border: 1px solid var(--fo-border-accent); border-radius: var(--fo-radius-md); }",
  "#sidebar .sidebar-content { padding: 0rem; overflow: unset; }",
  "#controllersContainer { padding: 0; margin-bottom: 0; }",
  "#devicesContainer { padding: 0; margin-top: 0; padding-top: 0 !important; }",

  // Feature content (right-hand pane).
  ".feature-content { display: flex !important; flex-direction: column !important; flex: 1 1 auto; min-width: 0; }",

  // Category disclosure header.
  ".fo-category-header { align-items: center; cursor: pointer; display: flex; font-weight: bold; gap: var(--fo-space-sm); " +
    "list-style: none; padding: var(--fo-space-sm) var(--fo-space-md); user-select: none; -webkit-user-select: none; }",
  ".fo-category-header::-webkit-details-marker { display: none; }",
  ".fo-category-header:hover { color: var(--fo-accent-bg); }",

  // Arrow glyph.
  ".fo-category-arrow { display: inline-block; font-family: var(--fo-font-monospace); line-height: 1; " +
    "transition: transform var(--fo-transition-base); }",
  "details[open] > .fo-category-header .fo-category-arrow { transform: rotate(90deg); }",

  // Rows container: bordered accent frame + soft outer ring + two subgrid column tracks - the checkbox gutter and the content column. A value option's field stacks
  // beneath its label inside the content column rather than occupying a third track, so there is no shared input column whose width a wide field could distort.
  ".fo-category-rows { border: 1px solid var(--fo-accent-bg); border-radius: var(--fo-radius-md); " +
    "box-shadow: 0 0 0 1px var(--fo-accent-hover); overflow: hidden; display: grid; grid-template-columns: auto 1fr; }",

  // Off-screen rendering optimization, scoped to OPEN categories only. `content-visibility: auto` lets the browser skip layout and paint for off-screen rows;
  // `contain-intrinsic-size` provides a placeholder height (heuristic 200px average) so scroll position stays stable as open categories enter and leave the viewport.
  // It MUST stay scoped to `details[open]`: a collapsed category's rows container is empty (rows materialize lazily on first expand), and leaving content-visibility on
  // it makes the browser hold the `contain-intrinsic-size` placeholder height instead of letting the closed disclosure collapse the container to zero. This is the
  // defined behavior of content-visibility, not an engine quirk - it was observed identically in Chromium and WebKit, and was the source of the large empty gaps
  // between collapsed categories. Scoping to open categories keeps the optimization where rows actually exist and lets collapsed categories collapse to zero.
  "details[open] > .fo-category-rows { content-visibility: auto; contain-intrinsic-size: 0 200px; }",

  // Per-row subgrid inheriting the parent's column tracks. The checkbox top-aligns (align-items: start) so that on a multi-line label - or a value option whose field
  // stacks beneath the label - it sits beside the first line rather than floating against the vertical center of a tall cell.
  ".fo-option-row { align-items: start; display: grid; gap: var(--fo-space-sm); grid-column: 1 / -1; " +
    "grid-template-columns: subgrid; padding: var(--fo-space-xs) var(--fo-space-md); " +
    "transition: background-color var(--fo-transition-fast); }",
  ".fo-option-row:hover { background-color: var(--fo-row-hover-bg); }",
  ".fo-option-row.fo-hidden { display: none !important; }",

  // The checkbox top-aligns with the row; this nudge re-centers it on the label's first line (half the line's leading), so a single-line row keeps the control optically
  // centered on its text while a multi-line or stacked row aligns the control to the first line.
  ".fo-option-checkbox { margin-top: calc((1lh - 1em) / 2); }",

  // Content cell: the label and, for a value option, its field stack vertically. align-items: flex-start keeps the fixed-width field left-aligned at its declared width
  // rather than stretching, and min-width: 0 lets a long label wrap within the grid track instead of forcing the track wider.
  ".fo-option-content { align-items: flex-start; display: flex; flex-direction: column; gap: var(--fo-space-xs); min-width: 0; }",

  // Main options area. Owns its outline with a theme-aware border rather than config-ui-x's box-shadow "border", which exists only in the host's dark theme (so it
  // is absent in light) and bleeds outside the box (so it clips at the flush iframe edge). Every outer container frame shares --fo-border-accent (the probed theme
  // accent, subtled), a step lighter than the full-accent per-category frame nested inside so the two read as one family at different weights; the border sits
  // inside the box, so no edge gutter, and box-shadow: none drops the leftover host shadow.
  "#optionsContainer { border: 1px solid var(--fo-border-accent); box-shadow: none; margin: 0; padding: 1rem; }",

  // Info header. Owns its outline via --fo-border-accent (see #optionsContainer) so it reads in both themes; the inside-the-box border needs no edge gutter.
  "#headerInfo { border: 1px solid var(--fo-border-accent); box-shadow: none; flex-shrink: 0; " +
    "margin-bottom: var(--fo-space-sm) !important; padding: var(--fo-space-sm) !important; }",

  // Device stats grid. The `#headerInfo` ancestor carries `container-type: inline-size` (below) so the grid's responsive hiding fires when its container narrows -
  // not when the viewport does. The Homebridge plugin UI panel can resize independently of the viewport (custom UI tab, embedded contexts), so container-relative
  // sizing is what users actually want.
  "#headerInfo { container-type: inline-size; }",
  ".device-stats-grid { border: 1px solid var(--fo-border-accent); border-radius: var(--fo-radius-md); display: flex; " +
    "justify-content: space-between; gap: var(--fo-space-md); margin-bottom: var(--fo-space-sm); padding: 0 var(--fo-space-md); flex-wrap: nowrap; overflow: hidden; }",
  ".device-stats-grid .stat-item:first-child { flex: 0 0 25%; }",
  ".device-stats-grid .stat-item:not(:first-child) { flex-grow: 1; min-width: 0; }",
  ".stat-item { display: flex; flex-direction: column; gap: var(--fo-space-xxs); }",
  ".stat-label { font-weight: 600; color: var(--fo-text-muted); font-size: var(--fo-font-size-xs); " +
    "text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
  ".stat-value { font-size: 0.875rem; color: var(--fo-text-on-elevated); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",

  // Responsive hiding for device stats grid. `@container` (not `@media`) so the breakpoints fire on the panel's actual width, not the viewport. Progressive
  // degradation: as the container narrows, the last stat hides first, then the second-to-last, etc., so the most-important left-most stat (Firmware) stays visible
  // longest.
  "@container (max-width: 700px) { .device-stats-grid .stat-item:nth-last-of-type(1) { display: none !important; } }",
  "@container (max-width: 500px) { .device-stats-grid .stat-item:nth-last-of-type(2) { display: none !important; } }",
  "@container (max-width: 300px) { .device-stats-grid .stat-item:nth-last-of-type(3) { display: none !important; } }",
  "@container (max-width: 400px) { #statusInfo { display: none !important; } }",

  // Navigation styles.
  ".nav-link { border-radius: var(--fo-radius-sm); transition: all var(--fo-transition-base); position: relative; " +
    "padding: var(--fo-space-xs) var(--fo-space-md) !important; line-height: 1.2; font-size: var(--fo-font-size-sm); }",
  ".nav-link:hover { background-color: var(--fo-accent-hover); color: var(--fo-accent-bg) !important; }",
  ".nav-link.active { background-color: var(--fo-accent-bg); color: var(--fo-accent-fg) !important; }",
  // In-scope controller affordance: a 1px accent ring (inset box-shadow so it follows the radius and adds no layout shift) marking the controller whose devices are
  // currently listed. `:not(.active)` suppresses it when that controller is the active selection - so it shows only in the Global-selected state, one tier below the
  // filled active pill.
  ".nav-link.context:not(.active) { box-shadow: inset 0 0 0 1px var(--fo-border-accent); }",
  ".nav-header { border-bottom: 1px solid var(--fo-border-subtle); margin-bottom: var(--fo-space-xxs); " +
    "padding: var(--fo-space-xs) var(--fo-space-md) !important; font-size: var(--fo-font-size-xs) !important; line-height: 1.2; }",
  "#devicesContainer .nav-header, #controllersContainer .nav-header { font-weight: 600; margin-top: 0 !important; padding-top: var(--fo-space-sm) !important; }",
  // The Global Options link shares `.nav-header` for its bold-uppercase look but is a selectable, highlighted pill, not a section separator - so it keeps symmetric
  // vertical padding rather than inheriting the section-header top spacing above (which otherwise pushes its text below the pill's center).
  "#controllersContainer .nav-link[data-navigation=\"global\"] { padding-top: var(--fo-space-xs) !important; }",

  // Search bar.
  ".search-toolbar { border-radius: var(--fo-radius-md); padding: 0 0 var(--fo-space-sm) 0; }",
  ".search-input-wrapper { min-width: 0; }",
  ".filter-pills { display: flex; gap: var(--fo-space-sm); flex-wrap: wrap; }",

  // Search input resting border. Matches the container frames via --fo-border-accent for a consistent outline; scoped :not(:focus) so it never touches the focus
  // state - the accent glow (box-shadow) and focus border that appear when the field is selected are left entirely to the focus rules below.
  "#search .form-control:not(:focus) { border-color: var(--fo-border-accent); }",

  // Search input focus state (governs light mode). Sets the accent border and glow so the selected field matches the theme instead of Bootstrap's blue; the
  // dark-mode override further below wins in dark and carries the same glow via the shared --fo-focus-ring token.
  "#search .form-control:focus { border-color: var(--fo-border-accent); box-shadow: var(--fo-focus-ring); }",

  // Status bar. Owns its outline via --fo-border-accent (see #optionsContainer) for a consistent border in both themes.
  "#featureStatusBar { border: 1px solid var(--fo-border-accent); box-shadow: none; }",

  // Grouped-option visual indicator.
  ".fo-option-row.grouped-option { background-color: var(--fo-accent-subtle); }",
  ".fo-option-row.grouped-option .fo-option-content { padding-left: 1.25rem; position: relative; }",
  ".fo-option-row.grouped-option .fo-option-content::before { content: \"\\21B3\"; position: absolute; left: var(--fo-space-xs); color: var(--fo-grouped-indicator); }",

  // Dark-mode-only overrides for Bootstrap utility classes that need treatment beyond what tokens express.
  ":root.fo-dark .text-body { color: var(--fo-text-muted) !important; }",
  ":root.fo-dark .text-muted { color: var(--fo-text-muted) !important; }",
  ":root.fo-dark #search .form-control { background-color: var(--fo-form-control-bg); border-color: var(--fo-border-accent); color: var(--fo-text-on-elevated); }",
  ":root.fo-dark #search .form-control:focus { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-focus-border); " +
    "color: var(--fo-text-on-elevated); box-shadow: var(--fo-focus-ring); }",
  ":root.fo-dark #search .form-control::placeholder { color: var(--fo-form-control-placeholder); }",
  ":root.fo-dark #statusInfo .text-muted { color: var(--fo-statusinfo-muted) !important; }",

  // Utility styles.
  ".btn-xs { font-size: var(--fo-font-size-xs) !important; padding: var(--fo-space-xxs) var(--fo-space-sm) !important; line-height: 1.5; touch-action: manipulation; }",
  ".cursor-pointer { cursor: pointer; }",
  ".user-select-none { user-select: none; -webkit-user-select: none; }",

  // Accessibility.
  "@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }"

].join("\n");
