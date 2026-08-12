/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-theming.test.mjs: Unit tests for the page theme effect - its lifecycle, the color-scheme application, the page base stylesheet, and the page kit.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "./ui.helpers.mjs";
import { registerThemeEffect } from "./webUi-theming.mjs";

// Build a fake host whose userCurrentLightingMode returns the supplied mode. Tests override per-call.
const fakeHost = (mode) => ({ userCurrentLightingMode: async () => mode });

// Adopt the base sheet and return its rules joined as text. The effect adopts synchronously before it awaits the lighting mode, so the sheet is present once this
// resolves; the probe is skipped with timeoutMs 0.
const baseCss = async () => {

  const controller = new AbortController();

  await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

  const stylesheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];

  return [...stylesheet.cssRules].map((rule) => rule.cssText).join("\n");
};

describe("registerThemeEffect - synchronous setup", () => {

  test("adopts a stylesheet onto document.adoptedStyleSheets", async () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before + 1, "stylesheet adopted");
  });

  test("applies color-scheme on :root from the host's reported lighting mode", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("dark"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "dark");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true);
  });

  test("light mode does not set the fo-dark class", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "light");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false);
  });

  test("an unrecognized lighting-mode value is a no-op (no class or property change)", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("auto"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "no color-scheme set");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false);
  });
});

describe("registerThemeEffect - lifecycle", () => {

  test("aborting the signal releases the stylesheet", async () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });
    assert.equal(document.adoptedStyleSheets.length, before + 1);

    controller.abort();
    assert.equal(document.adoptedStyleSheets.length, before, "stylesheet released");
  });

  test("aborting clears the color-scheme, fo-dark class, and accent overrides it set on :root", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    // Register in dark mode so applyColorScheme sets both color-scheme and the fo-dark class; stamp accent overrides directly (the probe is skipped via
    // timeoutMs: 0) so the teardown has every kind of :root mutation to undo.
    await registerThemeEffect({ host: fakeHost("dark"), probe: { timeoutMs: 0 }, signal: controller.signal });
    document.documentElement.style.setProperty("--fo-accent-bg", "rgb(1, 2, 3)");
    document.documentElement.style.setProperty("--fo-accent-fg", "rgb(4, 5, 6)");

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "dark", "precondition: dark applied");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "precondition: fo-dark set");

    controller.abort();

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "color-scheme cleared on teardown");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "fo-dark class removed on teardown");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), "", "accent-bg override cleared on teardown");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-fg"), "", "accent-fg override cleared on teardown");
  });

  test("a pre-aborted signal does not adopt anything", async () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    controller.abort();
    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before);
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "");
  });
});

describe("buildBaseCss - page rules", () => {

  test("the secret field seats its toggle beside the input, and the toggle wears no button chrome of its own", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    // The wrapper is a horizontal flex line inside the stacking content cell, which is what puts the reveal beside the field rather than beneath it.
    assert.match(text, /\.fo-secret-field\s*\{[^}]*display:\s*flex/);
    assert.match(text, /\.fo-secret-field\s*\{[^}]*align-items:\s*center/);

    // The toggle surrenders the native button background and border and inherits the row's text color, which is what the currentColor glyph inside it draws in.
    assert.match(text, /\.fo-secret-toggle\s*\{[^}]*background:\s*none/);
    assert.match(text, /\.fo-secret-toggle\s*\{[^}]*color:\s*inherit/);
    assert.match(text, /\.fo-secret-toggle\s*\{[^}]*cursor:\s*pointer/);

    // Surrendering the chrome surrenders the browser's disabled rendering too, so a locked row's toggle dims and drops the pointer rather than inviting a click it
    // will not answer. The dim reads the shared not-actionable token rather than carrying a value of its own.
    assert.match(text, /\.fo-secret-toggle:disabled\s*\{[^}]*cursor:\s*default/);
    assert.match(text, /\.fo-secret-toggle:disabled\s*\{[^}]*opacity:\s*var\(--fo-opacity-disabled\)/);
  });

  test("the dark corrections for Bootstrap's page-wide text utilities read the muted token and outrank Bootstrap's own weight", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    // Bootstrap pins its own grey on these utilities with `!important`, so the correction has to carry the same weight to reach them at all - and it reads the
    // muted token rather than a literal so the page has one definition of muted text in either mode.
    assert.match(text, /:root\.fo-dark \.text-body\s*\{[^}]*color:\s*var\(--fo-text-muted\)\s*!important/);
    assert.match(text, /:root\.fo-dark \.text-muted\s*\{[^}]*color:\s*var\(--fo-text-muted\)\s*!important/);
  });

  test("the forced canvas owns the background and the inherited text color together", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    // Forcing the surface without forcing the text is what lets the host's modal color land on our background, so the pair is asserted together rather than one
    // at a time - either half alone is the failure this rule exists to prevent.
    assert.match(text, /body\s*\{[^}]*background-color:\s*var\(--fo-surface-bg\)\s*!important/);
    assert.match(text, /body\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)\s*!important/);
  });
});

describe("buildBaseCss - the page kit", () => {

  test("the card frame declares the accent border and the shared radius", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    /* The card is the framework's own container frame offered to a plugin's custom views, so its two declared values are the ones every framework container
     * already wears. Happy-DOM expands the `border` shorthand into longhands when its value carries a `var()`, so the color half is read off `border-color` here
     * rather than out of the shorthand; the source string's byte fidelity is the rule-parity rig's business, and this row's is the declared values.
     */
    assert.match(text, /\.fo-card\s*\{[^}]*1px solid/, "the frame is a hairline border");
    assert.match(text, /\.fo-card\s*\{[^}]*border-color:\s*var\(--fo-border-accent\)/, "and it takes its color from the shared container-frame token");
    assert.match(text, /\.fo-card\s*\{[^}]*border-radius:\s*var\(--fo-radius-md\)/, "with the shared radius, so a plugin card and a framework container match");
  });

  test("the monospace opt-in reads the shared font stack rather than restating one", async () => {

    using _dom = createTestDom();

    assert.match(await baseCss(), /\.fo-monospace\s*\{[^}]*font-family:\s*var\(--fo-font-monospace\)/);
  });

  test("the dark form-control corrections apply only inside a page-kit container, and every value reads its token", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    /* The surface, the border, and the text move together - a field that corrected only its background would render dark-on-dark - and the placeholder and the
     * focus state come with them so a field cannot flash a light background the moment it takes focus. Each declared value is pinned to its exact token: a
     * literal here would be a second definition of a color the tokens module already owns.
     */
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control\s*\{[^}]*border-color:\s*var\(--fo-form-control-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control::placeholder\s*\{[^}]*color:\s*var\(--fo-form-control-placeholder\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*border-color:\s*var\(--fo-form-control-focus-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*box-shadow:\s*var\(--fo-focus-ring\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);

    // The `.fo-page` marker is what makes the kit opt-in: every form-control correction is scoped through it, so a page that never carries the marker sees none
    // of them and an option row's own inputs - which carry no such ancestor - are untouched.
    const unscoped = text.match(/:root\.fo-dark (?!\.fo-page)[^{]*\.form-control/g);

    assert.equal(unscoped, null, "no dark form-control correction in the base sheet escapes the page-kit marker");
  });

  test("light mode is left to Bootstrap - the kit declares no light form-control rules of its own", async () => {

    using _dom = createTestDom();

    // The framework treats its own fields this way, and a light-mode override here would be the framework second-guessing Bootstrap on a surface Bootstrap already
    // renders correctly. Only the dark-qualified selectors may mention `.fo-page` form controls.
    const text = await baseCss();
    const pageFormRules = text.match(/^.*\.fo-page \.form-control.*$/gm) ?? [];

    assert.ok(pageFormRules.length > 0, "precondition: the kit does declare form-control rules");
    assert.ok(pageFormRules.every((rule) => rule.startsWith(":root.fo-dark ")), "and every one of them is dark-qualified");
  });
});
