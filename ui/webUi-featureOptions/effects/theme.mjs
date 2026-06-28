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
 * Cleanup is automatic via the AbortSignal: aborting releases the stylesheet from the document, removes the matchMedia listener (via `{signal}` on addEventListener),
 * and short-circuits the in-progress Bootstrap probe at the next await checkpoint.
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

    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== stylesheet);
  }, { once: true });

  // Apply the color-scheme from the current Homebridge setting. The lightweight portion of "apply theme" - no Bootstrap probe required; just sets the color-scheme
  // property on :root and toggles the fo-dark class.
  applyColorScheme(await host.userCurrentLightingMode());

  if(signal.aborted) {

    return;
  }

  // Listen for system / browser changes to the current dark-mode setting. Re-applying the color-scheme is cheap (no probe); the deferred accent probe separately
  // refreshes the custom properties when Bootstrap is ready.
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

// The theme stylesheet. Layout, sidebar, category-frame, search bar, dark-mode utility-class overrides. Every rule references the `--fo-*` tokens declared by the
// tokens effect; consumers see one cohesive design language regardless of which mode is active.
const buildThemeCss = () => [

  // Base layout reset.
  "html, body { margin: 0; padding: 0; }",

  // Single source of truth for option-row visibility. Search, filter, and dependency logic all toggle this class.
  ".fo-hidden { display: none !important; }",

  // Page background.
  "body { background-color: var(--fo-surface-bg) !important; }",

  // Page layout.
  "#pageFeatureOptions { display: flex !important; flex-direction: column; width: 100%; }",
  ".feature-main-content { display: flex !important; flex-direction: row !important; width: 100%; }",

  // Sidebar.
  "#sidebar { display: block; width: 200px; min-width: 200px; max-width: 200px; position: relative; background-color: var(--fo-elevated-bg) !important; }",
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
  // stacks beneath the label - it sits beside the first line rather than floating against the vertical centre of a tall cell.
  ".fo-option-row { align-items: start; display: grid; gap: var(--fo-space-sm); grid-column: 1 / -1; " +
    "grid-template-columns: subgrid; padding: var(--fo-space-xs) var(--fo-space-md); " +
    "transition: background-color var(--fo-transition-fast); }",
  ".fo-option-row:hover { background-color: var(--fo-row-hover-bg); }",
  ".fo-option-row.fo-hidden { display: none !important; }",

  // The checkbox top-aligns with the row; this nudge re-centres it on the label's first line (half the line's leading), so a single-line row keeps the control optically
  // centred on its text exactly as before while a multi-line or stacked row aligns the control to the first line.
  ".fo-option-checkbox { margin-top: calc((1lh - 1em) / 2); }",

  // Content cell: the label and, for a value option, its field stack vertically. align-items: flex-start keeps the fixed-width field left-aligned at its declared width
  // rather than stretching, and min-width: 0 lets a long label wrap within the grid track instead of forcing the track wider.
  ".fo-option-content { align-items: flex-start; display: flex; flex-direction: column; gap: var(--fo-space-xs); min-width: 0; }",

  // Main options area.
  ".options-content { padding: 1rem; margin: 0; }",

  // Info header.
  "#headerInfo { flex-shrink: 0; padding: var(--fo-space-sm) !important; margin-bottom: var(--fo-space-sm) !important; }",

  // Device stats grid. The `#headerInfo` ancestor carries `container-type: inline-size` (below) so the grid's responsive hiding fires when its container narrows -
  // not when the viewport does. The Homebridge plugin UI panel can resize independently of the viewport (custom UI tab, embedded contexts), so container-relative
  // sizing is what users actually want.
  "#headerInfo { container-type: inline-size; }",
  ".device-stats-grid { display: flex; justify-content: space-between; gap: var(--fo-space-md); " +
    "margin-bottom: var(--fo-space-sm); padding: 0 var(--fo-space-md); flex-wrap: nowrap; overflow: hidden; }",
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
  ".nav-header { border-bottom: 1px solid var(--fo-border-subtle); margin-bottom: var(--fo-space-xxs); " +
    "padding: var(--fo-space-xs) var(--fo-space-md) !important; font-size: var(--fo-font-size-xs) !important; line-height: 1.2; }",
  "#devicesContainer .nav-header, #controllersContainer .nav-header { font-weight: 600; margin-top: 0 !important; padding-top: var(--fo-space-sm) !important; }",

  // Search bar.
  ".search-toolbar { border-radius: var(--fo-radius-md); padding: 0 0 var(--fo-space-sm) 0; }",
  ".search-input-wrapper { min-width: 0; }",
  ".filter-pills { display: flex; gap: var(--fo-space-sm); flex-wrap: wrap; }",

  // Grouped-option visual indicator.
  ".fo-option-row.grouped-option { background-color: var(--fo-accent-subtle); }",
  ".fo-option-row.grouped-option .fo-option-content { padding-left: 1.25rem; position: relative; }",
  ".fo-option-row.grouped-option .fo-option-content::before { content: \"\\21B3\"; position: absolute; left: var(--fo-space-xs); color: var(--fo-grouped-indicator); }",

  // Dark-mode-only overrides for Bootstrap utility classes that need treatment beyond what tokens express.
  ":root.fo-dark .text-body { color: var(--fo-text-muted) !important; }",
  ":root.fo-dark .text-muted { color: var(--fo-text-muted) !important; }",
  ":root.fo-dark .device-stats-grid { background-color: var(--fo-elevated-bg); border-color: var(--fo-border-strong); }",
  ":root.fo-dark #search .form-control { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-border); color: var(--fo-text-on-elevated); }",
  ":root.fo-dark #search .form-control:focus { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-focus-border); " +
    "color: var(--fo-text-on-elevated); box-shadow: 0 0 0 0.2rem color-mix(in srgb, var(--fo-accent-bg) 25%, transparent); }",
  ":root.fo-dark #search .form-control::placeholder { color: var(--fo-form-control-placeholder); }",
  ":root.fo-dark #statusInfo .text-muted { color: var(--fo-statusinfo-muted) !important; }",

  // Utility styles.
  ".btn-xs { font-size: var(--fo-font-size-xs) !important; padding: var(--fo-space-xxs) var(--fo-space-sm) !important; line-height: 1.5; touch-action: manipulation; }",
  ".cursor-pointer { cursor: pointer; }",
  ".user-select-none { user-select: none; -webkit-user-select: none; }",

  // Accessibility.
  "@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }"

].join("\n");
