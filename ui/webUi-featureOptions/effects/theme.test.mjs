/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/theme.test.mjs: Unit tests for the theme effect.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "../../ui.helpers.mjs";
import { registerThemeEffect } from "./theme.mjs";

// Build a fake host whose userCurrentLightingMode returns the supplied mode. Tests override per-call.
const fakeHost = (mode) => ({ userCurrentLightingMode: async () => mode });

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

describe("buildThemeCss - status panel variant rules", () => {

  // Adopt the theme sheet and return its rules joined as text. The effect adopts synchronously before it awaits the lighting mode, so the sheet is present once this
  // resolves; the probe is skipped with timeoutMs 0.
  const themeCss = async () => {

    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

    const stylesheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];

    return [...stylesheet.cssRules].map((rule) => rule.cssText).join("\n");
  };

  test("the status-grid variant sets wrap and a row gap", async () => {

    using _dom = createTestDom();

    assert.match(await themeCss(), /\.device-stats-grid\.fo-status-grid\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  test("the status-grid variant sizes cells to their own content", async () => {

    using _dom = createTestDom();

    // happy-dom expands the `flex: 0 1 auto` shorthand to longhand, so the content-sized signature is flex-grow 0 with a flex-basis of auto.
    assert.match(await themeCss(), /\.device-stats-grid\.fo-status-grid\s+\.stat-item\s*\{[^}]*flex-grow:\s*0[^}]*flex-basis:\s*auto/);
  });

  test("the variant cell rule follows the base grid rules so it wins on source order", async () => {

    using _dom = createTestDom();

    const text = await themeCss();
    const base = text.indexOf(".device-stats-grid .stat-item:first-child");
    const variant = text.indexOf(".device-stats-grid.fo-status-grid .stat-item");

    assert.ok(base >= 0, "the base first-child rule is present");
    assert.ok((variant >= 0) && (variant > base), "the variant cell rule appears after the base rules, so a specificity tie resolves in its favor");
  });

  test("the phantom rule hides its reservation from paint", async () => {

    using _dom = createTestDom();

    assert.match(await themeCss(), /\.fo-phantom\s*\{[^}]*visibility:\s*hidden/);
  });

  test("the row-break rule is a full-width zero-height spacer", async () => {

    using _dom = createTestDom();

    const text = await themeCss();

    assert.match(text, /\.fo-row-break\s*\{[^}]*flex-basis:\s*100%/);
    assert.match(text, /\.fo-row-break\s*\{[^}]*height:\s*0/);
  });

  test("the status message spans the full width and wraps", async () => {

    using _dom = createTestDom();

    const text = await themeCss();

    assert.match(text, /\.fo-status-message\s*\{[^}]*flex-basis:\s*100%/);
    assert.match(text, /\.fo-status-message\s+\.stat-value\s*\{[^}]*white-space:\s*normal/);
  });

  test("the link-lost message centers and colors, and the reload action is its own full-width centered line", async () => {

    using _dom = createTestDom();

    const text = await themeCss();

    // The message-line modifier centers the line and colors its value span with the attention token; the reload action is a full-width centered line whose anchor
    // carries the same attention color.
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s*\{[^}]*text-align:\s*center/);
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s+\.stat-value\s*\{[^}]*color:\s*var\(--fo-text-attention\)/);
    assert.match(text, /\.fo-status-reload\s*\{[^}]*flex-basis:\s*100%/);
    assert.match(text, /\.fo-status-reload\s*\{[^}]*text-align:\s*center/);
    assert.match(text, /\.fo-status-reload\s+a\s*\{[^}]*color:\s*var\(--fo-text-attention\)/);
  });

  test("each responsive hide rule exempts the status grid on the grid token", async () => {

    using _dom = createTestDom();

    const text = await themeCss();

    assert.match(text, /@container \(max-width: 700px\) \{\s*\.device-stats-grid:not\(\.fo-status-grid\) \.stat-item:nth-last-of-type\(1\)/);
    assert.match(text, /@container \(max-width: 500px\) \{\s*\.device-stats-grid:not\(\.fo-status-grid\) \.stat-item:nth-last-of-type\(2\)/);
    assert.match(text, /@container \(max-width: 300px\) \{\s*\.device-stats-grid:not\(\.fo-status-grid\) \.stat-item:nth-last-of-type\(3\)/);
  });
});
