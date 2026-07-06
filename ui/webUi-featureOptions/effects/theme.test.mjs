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
