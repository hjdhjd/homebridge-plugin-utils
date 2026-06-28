/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/tokens.mjs: Design-token stylesheet adoption for the feature options webUI.
 */
"use strict";

/**
 * Register the design-tokens effect. Adopts a constructable stylesheet declaring every `--fo-*` CSS custom property the rest of the webUI references (font family,
 * font scale, spacing scale, radii, motion, accent colors, surfaces, borders, text, form controls, interactive states, grouped-option indicator). Cleanup is
 * automatic via the supplied AbortSignal - aborting removes the stylesheet from `document.adoptedStyleSheets`.
 *
 * Two stylistic invariants the tokens encode:
 *
 *   1. **Tokens declare, theme overrides.** Accent tokens default to the CSS-standard `AccentColor` / `AccentColorText` keywords; the theme effect overrides them at
 *      runtime via `documentElement.style.setProperty` after probing Bootstrap's `.btn-primary`. The declared defaults remain in effect until (and if) the probe
 *      succeeds, so the user sees a sensible accent before Bootstrap's stylesheet is necessarily ready.
 *   2. **Dark mode is token redefinition, not light-dark() at the consumer.** Every light/dark color pair is expressed as two declarations of the same token - one
 *      at `:root` for the light default, one at `:root.fo-dark` for the dark override. Consumers reference the token by name (`var(--fo-surface-bg)`) and get the
 *      right value automatically. A future third theme (high-contrast, brand variant) joins by adding a third selector block; no consumer rules change.
 *
 * Adopted synchronously - token declarations are static and have no I/O dependencies, so the stylesheet is ready by the time the call returns. Must run before any
 * consumer (the theme effect or any inline style using `var(--fo-*)`) references a token, which the orchestrator's boot sequence guarantees by registering this
 * effect first.
 *
 * @param {Object} args
 * @param {AbortSignal} args.signal - Lifecycle signal. Aborting releases the stylesheet from the document.
 */
export const registerTokensEffect = ({ signal }) => {

  if(signal.aborted) {

    return;
  }

  const stylesheet = new CSSStyleSheet();

  stylesheet.replaceSync(buildTokenCss());
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, stylesheet ];

  signal.addEventListener("abort", () => {

    // Release the stylesheet. Filter-rebuild rather than mutate to preserve the array's identity contract across consumers.
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== stylesheet);
  }, { once: true });
};

// Assemble the full token CSS. Grouped by category with a section comment per group so the file reads as the design vocabulary it represents. Order within a group
// is alphabetical by token name; order across groups follows the conceptual hierarchy (font system, spacing scale, radii, motion, accent, surfaces, borders, text,
// form controls, interactive states, specific colors).
const buildTokenCss = () => [

  ":root {",

  // Font family. Provides explicit fallbacks beyond the `ui-monospace` keyword because Chrome's form-control font-resolution path can land on serif when only the
  // keyword is specified. The stack walks the platform's canonical monospace files explicitly, terminating in the `monospace` generic.
  "  --fo-font-monospace: ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", \"Courier New\", monospace;",

  // Font scale.
  "  --fo-font-size-xs: 0.75rem;",
  "  --fo-font-size-sm: 0.8125rem;",

  // Spacing scale. T-shirt sized, rem-based, distinct from Bootstrap's numbered `--bs-spacer * N` to avoid the half-aligned trap.
  "  --fo-space-xxs: 0.125rem;",
  "  --fo-space-xs: 0.25rem;",
  "  --fo-space-sm: 0.5rem;",
  "  --fo-space-md: 0.75rem;",
  "  --fo-space-lg: 1rem;",

  // Border-radius scale.
  "  --fo-radius-sm: 0.375rem;",
  "  --fo-radius-md: 0.5rem;",

  // Motion.
  "  --fo-transition-fast: 0.15s;",
  "  --fo-transition-base: 0.2s;",

  // Accent colors. CSS-standard `AccentColor` / `AccentColorText` keywords as the declared defaults; the theme effect overrides at runtime via setProperty after
  // probing Bootstrap's `.btn-primary`. The derivative tokens (-hover, -subtle) compose via `color-mix()` against whatever value the accent currently holds, so the
  // derivatives stay in lockstep with both the default and the probed override without separate machinery.
  "  --fo-accent-bg: AccentColor;",
  "  --fo-accent-fg: AccentColorText;",
  "  --fo-accent-hover: color-mix(in srgb, var(--fo-accent-bg) 10%, transparent);",
  "  --fo-accent-subtle: color-mix(in srgb, var(--fo-accent-bg) 8%, transparent);",

  // Surfaces. Light defaults; `:root.fo-dark` redeclares for dark mode. Tokens that defer to Bootstrap variables carry an explicit fallback inside the `var()` so
  // the token resolves cleanly even when Bootstrap has not loaded yet (the orchestrator initializes tokens before Bootstrap's stylesheet is necessarily ready).
  "  --fo-surface-bg: #ffffff;",
  "  --fo-elevated-bg: var(--bs-gray-100, #f8f9fa);",

  // Borders.
  "  --fo-border-strong: var(--bs-border-color, #dee2e6);",
  "  --fo-border-subtle: rgba(0, 0, 0, 0.1);",

  // Text.
  "  --fo-text-muted: var(--bs-gray-600, #6c757d);",
  "  --fo-text-on-elevated: var(--bs-body-color, #212529);",

  // Form controls (light = Bootstrap defaults; dark overrides at `:root.fo-dark`).
  "  --fo-form-control-bg: var(--bs-body-bg, #ffffff);",
  "  --fo-form-control-border: var(--bs-border-color, #dee2e6);",
  "  --fo-form-control-focus-border: var(--fo-accent-bg);",
  "  --fo-form-control-placeholder: var(--bs-secondary-color, rgba(33, 37, 41, 0.75));",

  // Interactive-state colors.
  "  --fo-row-hover-bg: rgba(0, 0, 0, 0.03);",

  // Specific colors. The grouped-option indicator (the Unicode `\\21B3` arrow) and the statusInfo's muted text want a distinct value from `--fo-text-muted` for
  // visual hierarchy; they get their own tokens to express that.
  "  --fo-grouped-indicator: #666;",
  "  --fo-statusinfo-muted: var(--bs-secondary-color, rgba(33, 37, 41, 0.75));",

  "}",

  // Dark-mode redeclarations. Same tokens, dark values. The cascade applies these when `.fo-dark` is on `:root`, which the theme effect toggles based on the user's
  // Homebridge lighting-mode preference.
  ":root.fo-dark {",
  "  --fo-surface-bg: #242424;",
  "  --fo-elevated-bg: #1A1A1A;",
  "  --fo-border-strong: #444;",
  "  --fo-border-subtle: rgba(255, 255, 255, 0.1);",
  "  --fo-text-muted: #999;",
  "  --fo-text-on-elevated: #F8F9FA;",
  "  --fo-form-control-bg: #1A1A1A;",
  "  --fo-form-control-border: #444;",
  "  --fo-form-control-focus-border: #666;",
  "  --fo-form-control-placeholder: #999;",
  "  --fo-row-hover-bg: rgba(255, 255, 255, 0.20);",
  "  --fo-grouped-indicator: #999;",
  "  --fo-statusinfo-muted: #B8B8B8;",
  "}"

].join("\n");
