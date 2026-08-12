/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/optionsSkin.test.mjs: Unit tests for the options-view skin effect - its lifecycle and the view rules it adopts.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "../../ui.helpers.mjs";
import { registerOptionsSkinEffect } from "./optionsSkin.mjs";

// Adopt the skin sheet and return its rules joined as text. Adoption is synchronous, so the sheet is the document's newest the moment this returns.
const skinCss = () => {

  const controller = new AbortController();

  registerOptionsSkinEffect({ signal: controller.signal });

  const stylesheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];

  return [...stylesheet.cssRules].map((rule) => rule.cssText).join("\n");
};

describe("registerOptionsSkinEffect", () => {

  test("adopts a constructable stylesheet onto document.adoptedStyleSheets", () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    registerOptionsSkinEffect({ signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before + 1, "one stylesheet adopted");
  });

  test("aborting the signal releases the stylesheet from the document", () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    registerOptionsSkinEffect({ signal: controller.signal });
    assert.equal(document.adoptedStyleSheets.length, before + 1);

    controller.abort();
    assert.equal(document.adoptedStyleSheets.length, before, "stylesheet released on abort");
  });

  test("a pre-aborted signal does not adopt the stylesheet at all", () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    controller.abort();
    registerOptionsSkinEffect({ signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before, "no adoption against an aborted signal");
  });

  test("the view rules the skin owns stay out of the page base sheet - the nav pills above all", () => {

    using _dom = createTestDom();

    // The `.nav-link` set is why the skin is a separate sheet with a separate lifetime: it restyles a Bootstrap class any custom page may legitimately use for
    // something else, so it must live and die with this view rather than with the page.
    const text = skinCss();

    assert.match(text, /\.nav-link\s*\{/, "the nav pill rules ride the skin");
    assert.match(text, /\.nav-link\.active\s*\{[^}]*background-color:\s*var\(--fo-accent-bg\)/, "including the active pill's accent fill");
  });
});

describe("buildOptionsSkinCss - layout rules", () => {

  test("the sidebar takes all three of its widths from the sidebar-width token", () => {

    using _dom = createTestDom();

    // The token is the single place the sidebar's width is stated, so a plugin widening it overrides one custom property rather than three declarations. All three
    // properties must reference it: leaving min-width or max-width on a literal would pin the sidebar at 200px no matter what the token says.
    const text = skinCss();

    assert.match(text, /#sidebar\s*\{[^}]*[^-]width:\s*var\(--fo-sidebar-width\)/, "width reads the token");
    assert.match(text, /#sidebar\s*\{[^}]*min-width:\s*var\(--fo-sidebar-width\)/, "min-width reads the token");
    assert.match(text, /#sidebar\s*\{[^}]*max-width:\s*var\(--fo-sidebar-width\)/, "max-width reads the token");
    assert.doesNotMatch(text, /#sidebar\s*\{[^}]*200px/, "no literal width survives in the rule");
  });

  test("the busy-table rule dims its rows through the shared disabled token and drops the pointer", () => {

    using _dom = createTestDom();

    // The busy table's rows are disabled at the element level; this rule is what says so on screen. It reads the same not-actionable token the locked secret
    // toggle wears, so the two dimmed states cannot drift apart, and a literal here would be exactly that drift.
    const text = skinCss();

    assert.match(text, /\.fo-options-busy \.fo-option-row\s*\{[^}]*cursor:\s*default/, "a busy row drops the pointer");
    assert.match(text, /\.fo-options-busy \.fo-option-row\s*\{[^}]*opacity:\s*var\(--fo-opacity-disabled\)/, "the dim reads the shared token");
    assert.doesNotMatch(text, /\.fo-options-busy \.fo-option-row\s*\{[^}]*opacity:\s*[0-9.]/, "no literal opacity survives in the rule");
  });

  test("the busy-table treatment drops the pointer on the option label without dimming it a second time", () => {

    using _dom = createTestDom();

    // The label carries the cursor-pointer utility, so the row-level cursor cannot reach it and the label needs a rule of its own. The dim must stay off that rule:
    // the label already inherits the row's opacity, and a second declaration would stack one dim on top of another.
    const text = skinCss();

    assert.match(text, /\.fo-options-busy \.fo-option-row \.fo-option-label\s*\{[^}]*cursor:\s*default/, "a busy row's label drops the pointer");
    assert.doesNotMatch(text, /\.fo-options-busy \.fo-option-row \.fo-option-label\s*\{[^}]*opacity/, "the label rule declares no opacity of its own");
  });
});

describe("buildOptionsSkinCss - status panel variant rules", () => {

  test("the status-grid variant sets wrap and a row gap", () => {

    using _dom = createTestDom();

    assert.match(skinCss(), /\.device-stats-grid\.fo-status-grid\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  test("the status-grid variant sizes cells to their own content", () => {

    using _dom = createTestDom();

    // happy-dom expands the `flex: 0 1 auto` shorthand to longhand, so the content-sized signature is flex-grow 0 with a flex-basis of auto.
    assert.match(skinCss(), /\.device-stats-grid\.fo-status-grid\s+\.stat-item\s*\{[^}]*flex-grow:\s*0[^}]*flex-basis:\s*auto/);
  });

  test("the variant cell rule follows the base grid rules so it wins on source order", () => {

    using _dom = createTestDom();

    const text = skinCss();
    const base = text.indexOf(".device-stats-grid .stat-item:first-child");
    const variant = text.indexOf(".device-stats-grid.fo-status-grid .stat-item");

    assert.ok(base >= 0, "the base first-child rule is present");
    assert.ok((variant >= 0) && (variant > base), "the variant cell rule appears after the base rules, so a specificity tie resolves in its favor");
  });

  test("the phantom rule hides its reservation from paint", () => {

    using _dom = createTestDom();

    assert.match(skinCss(), /\.fo-phantom\s*\{[^}]*visibility:\s*hidden/);
  });

  test("the row-break rule is a full-width zero-height spacer", () => {

    using _dom = createTestDom();

    const text = skinCss();

    assert.match(text, /\.fo-row-break\s*\{[^}]*flex-basis:\s*100%/);
    assert.match(text, /\.fo-row-break\s*\{[^}]*height:\s*0/);
  });

  test("the status message spans the full width and wraps", () => {

    using _dom = createTestDom();

    const text = skinCss();

    assert.match(text, /\.fo-status-message\s*\{[^}]*flex-basis:\s*100%/);
    assert.match(text, /\.fo-status-message\s+\.stat-value\s*\{[^}]*white-space:\s*normal/);
  });

  test("the link-lost message centers and renders semibold in the attention token, and the reload action is its own full-width centered line", () => {

    using _dom = createTestDom();

    const text = skinCss();

    // The message-line modifier centers the line and renders its value span semibold in the attention token; the reload action is a full-width centered line, and the
    // recovery button on it wears its own Bootstrap styling rather than a theme color rule.
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s*\{[^}]*text-align:\s*center/);
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s+\.stat-value\s*\{[^}]*color:\s*var\(--fo-text-attention\)/);
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s+\.stat-value\s*\{[^}]*font-weight:\s*600/);
    assert.match(text, /\.fo-status-reload\s*\{[^}]*flex-basis:\s*100%/);
    assert.match(text, /\.fo-status-reload\s*\{[^}]*text-align:\s*center/);
  });

  test("the connection-error failure text takes the shared attention token", () => {

    using _dom = createTestDom();

    // The failure-text class colors the connection-error view's `code` element from the attention token rather than Bootstrap's text-danger, so failure emphasis has
    // one source.
    assert.match(skinCss(), /\.fo-failure-text\s*\{[^}]*color:\s*var\(--fo-text-attention\)/);
  });

  test("each responsive hide rule exempts the status grid on the grid token", () => {

    using _dom = createTestDom();

    const text = skinCss();

    assert.match(text, /@container \(max-width: 700px\) \{\s*\.device-stats-grid:not\(\.fo-status-grid\) \.stat-item:nth-last-of-type\(1\)/);
    assert.match(text, /@container \(max-width: 500px\) \{\s*\.device-stats-grid:not\(\.fo-status-grid\) \.stat-item:nth-last-of-type\(2\)/);
    assert.match(text, /@container \(max-width: 300px\) \{\s*\.device-stats-grid:not\(\.fo-status-grid\) \.stat-item:nth-last-of-type\(3\)/);
  });

  test("the dark corrections for this view's own controls read their tokens", () => {

    using _dom = createTestDom();

    const text = skinCss();

    // The search field's surface, border, placeholder, and focus state, plus the status bar's muted text: the view-scoped half of the dark treatment, whose
    // page-wide half lives in the base sheet.
    assert.match(text, /:root\.fo-dark #search \.form-control\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark #search \.form-control::placeholder\s*\{[^}]*color:\s*var\(--fo-form-control-placeholder\)/);
    assert.match(text, /:root\.fo-dark #search \.form-control:focus\s*\{[^}]*box-shadow:\s*var\(--fo-focus-ring\)/);
    assert.match(text, /:root\.fo-dark #statusInfo \.text-muted\s*\{[^}]*color:\s*var\(--fo-statusinfo-muted\)\s*!important/);
  });

  test("a value option's field wears the dark form-control treatment, every value read from its token", () => {

    using _dom = createTestDom();

    const text = skinCss();

    /* The surface, the border, and the text move together - a field that corrected only its background would render dark-on-dark - and the placeholder and the
     * focus state come with them so a field cannot flash a light background the moment it takes focus. Each declared value is pinned to its exact token: a
     * literal here would be a second definition of a color the tokens module already owns.
     */
    assert.match(text, /:root\.fo-dark \.fo-option-value\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-option-value\s*\{[^}]*border-color:\s*var\(--fo-form-control-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-option-value\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);
    assert.match(text, /:root\.fo-dark \.fo-option-value::placeholder\s*\{[^}]*color:\s*var\(--fo-form-control-placeholder\)/);
    assert.match(text, /:root\.fo-dark \.fo-option-value:focus\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-option-value:focus\s*\{[^}]*border-color:\s*var\(--fo-form-control-focus-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-option-value:focus\s*\{[^}]*box-shadow:\s*var\(--fo-focus-ring\)/);
    assert.match(text, /:root\.fo-dark \.fo-option-value:focus\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);
  });

  test("the value-field treatment is dark-only - light mode is left to Bootstrap", () => {

    using _dom = createTestDom();

    // The scope is a ruling rather than an oversight, so it is pinned rather than left to the comment beside the rules: every rule reaching a value field is
    // dark-qualified, which is also what keeps the search field's light accent styling from spreading here by a later well-meant edit.
    const valueRules = skinCss().match(/^.*\.fo-option-value.*$/gm) ?? [];

    assert.ok(valueRules.length > 0, "precondition: the skin does declare value-field rules");
    assert.ok(valueRules.every((rule) => rule.startsWith(":root.fo-dark ")), "and every one of them is dark-qualified");
  });
});
