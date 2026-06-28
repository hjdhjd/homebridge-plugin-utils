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
