/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/tokens.test.mjs: Unit tests for the design-tokens effect.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "../../ui.helpers.mjs";
import { registerTokensEffect } from "./tokens.mjs";

describe("registerTokensEffect", () => {

  test("adopts a constructable stylesheet onto document.adoptedStyleSheets", () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    registerTokensEffect({ signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before + 1, "one stylesheet adopted");
  });

  test("the adopted stylesheet declares core --fo-* tokens", () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    registerTokensEffect({ signal: controller.signal });

    const stylesheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];
    const text = [...stylesheet.cssRules].map((rule) => rule.cssText).join("\n");

    assert.match(text, /--fo-space-sm:\s*0\.5rem/);
    assert.match(text, /--fo-accent-bg:\s*AccentColor/);
    assert.match(text, /--fo-font-monospace:/);
  });

  test("aborting the signal releases the stylesheet from the document", () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    registerTokensEffect({ signal: controller.signal });
    assert.equal(document.adoptedStyleSheets.length, before + 1);

    controller.abort();
    assert.equal(document.adoptedStyleSheets.length, before, "stylesheet released on abort");
  });

  test("a pre-aborted signal does not adopt the stylesheet at all", () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    controller.abort();
    registerTokensEffect({ signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before, "no adoption against an aborted signal");
  });

  test("dark-mode token block redeclares colors under :root.fo-dark", () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    registerTokensEffect({ signal: controller.signal });

    const stylesheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];
    const text = [...stylesheet.cssRules].map((rule) => rule.cssText).join("\n");

    assert.match(text, /:root\.fo-dark/);
    assert.match(text, /--fo-surface-bg:\s*#242424/);
  });
});
