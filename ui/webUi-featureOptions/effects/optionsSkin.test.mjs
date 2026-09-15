/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/optionsSkin.test.mjs: Unit tests for the options-view skin effect - its lifecycle and the view rules it adopts.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "../../ui.helpers.mjs";
import { registerOptionsSkinEffect } from "./optionsSkin.mjs";

// Adopt the skin sheet and return the stylesheet itself. Adoption is synchronous, so the sheet is the document's newest the moment this returns. A row that reads a
// declared value back off one rule takes the sheet from here; a row that matches the sheet's text takes it through skinCss below, so both share one adoption.
const skinSheet = () => {

  const controller = new AbortController();

  registerOptionsSkinEffect({ signal: controller.signal });

  return document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];
};

// Adopt the skin sheet and return its rules joined as text.
const skinCss = () => [...skinSheet().cssRules].map((rule) => rule.cssText).join("\n");

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

    assert.match(text, /\.nav-link\s*\{/, "the nav pill rules live in the skin");
    assert.match(text, /\.nav-link\.active\s*\{[^}]*background-color:\s*var\(--fo-accent-bg\)/, "including the active pill's accent fill");
  });
});

describe("buildOptionsSkinCss - layout rules", () => {

  test("the sidebar takes all three of its widths from the sidebar-width token", () => {

    using _dom = createTestDom();

    // The token is the single place the sidebar's width is stated, so a plugin widening it overrides one custom property rather than three declarations. All three
    // properties must reference it: leaving min-width or max-width on a literal would hold the sidebar fixed at 200px no matter what the token says.
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

  test("the checkbox seat re-centers the control on the label's first line", () => {

    using _dom = createTestDom();

    const rule = [...skinSheet().cssRules].find((candidate) => candidate.selectorText === ".fo-option-checkbox");

    assert.ok(rule, "the sheet carries the checkbox rule");

    // The nudge is half the leading of the label's first line, which is what keeps a single-line row's control optically centered on its text while a stacked or
    // wrapped row keeps the control on the first line. It is read as a declared value rather than matched as text because the arithmetic is the whole of the rule:
    // a slip in either term would still satisfy a looser pattern.
    assert.equal(rule.style.getPropertyValue("margin-top"), "calc((1lh - 1em) / 2)", "the seat is half the difference between the line box and the text box");
  });
});

describe("buildOptionsSkinCss - status panel variant rules", () => {

  test("the status-grid variant is one column grid whose track count comes from the panel's own custom property", () => {

    using _dom = createTestDom();

    const text = skinCss();

    // The column template is where the shared tracks are declared, and the track count reaches it as a custom property because only the panel knows how many
    // identity fields a plugin declared. The fallback of one keeps a grid that somehow renders before the property is set to a single sane column.
    assert.match(text, /\.device-stats-grid\.fo-status-grid\s*\{[^}]*display:\s*grid/);
    assert.match(text, /\.device-stats-grid\.fo-status-grid\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--fo-status-tracks, 1\), minmax\(0, auto\)\)/);
    assert.match(text, /\.device-stats-grid\.fo-status-grid\s*\{[^}]*gap:\s*var\(--fo-space-xs\)\s+var\(--fo-space-md\)/);
    assert.doesNotMatch(text, /\.device-stats-grid\.fo-status-grid\s*\{[^}]*flex/, "a grid container carries no flex declarations for the stylesheet to leave dead");
  });

  test("the status-grid variant lets every cell shrink inside its track", () => {

    using _dom = createTestDom();

    const text = skinCss();

    // The base rules hand the first cell a proportional width and grant the shrink only to the cells after it, so the variant's own rule is what reaches every
    // cell with the `min-width: 0` each value's ellipsis needs inside its track.
    assert.match(text, /\.device-stats-grid\.fo-status-grid\s+\.stat-item\s*\{[^}]*min-width:\s*0/);
    assert.doesNotMatch(text, /\.device-stats-grid\.fo-status-grid\s+\.stat-item\s*\{[^}]*flex/, "and it declares no flex sizing a grid item would ignore");
  });

  test("the variant cell rule follows the base grid rules so it wins on source order", () => {

    using _dom = createTestDom();

    const text = skinCss();
    const base = text.indexOf(".device-stats-grid .stat-item:first-child");
    const variant = text.indexOf(".device-stats-grid.fo-status-grid .stat-item");

    assert.ok(base >= 0, "the base first-child rule is present");
    assert.ok((variant >= 0) && (variant > base), "the variant cell rule appears after the base rules, so a specificity tie resolves in its favor");
  });

  test("the phantom rule charges nothing: hidden from paint, zero height, no margin", () => {

    using _dom = createTestDom();

    const text = skinCss();

    /* A phantom reserves the width of the widest text its cell will ever show and nothing else, and the declarations asserted below are what hold it to that. The
     * hidden visibility keeps the reservation off the paint, the zero height keeps it out of the cell's vertical flow and is read with a lookahead that holds it
     * to zero itself rather than to any length that merely begins with a zero digit, and the absent margin is what the spacing design counts on: the label
     * carries the label-to-value join precisely so a phantom contributes no spacing of its own, and a rule handing `.fo-phantom` a margin would put the dead band
     * back between the identity row and the state rows beneath it. The margin assertion bounds the class name so a sibling class that merely starts with it
     * cannot lend a margin here, reaches across a comma-joined selector list, and reads `margin` alone since the shorthand and every longhand begin with it.
     */
    assert.match(text, /\.fo-phantom\s*\{[^}]*visibility:\s*hidden/, "the reservation is hidden from paint");
    assert.match(text, /\.fo-phantom\s*\{[^}]*height:\s*0(?![.\d])/, "and it takes no height of its own");
    assert.doesNotMatch(text, /\.fo-phantom(?![\w-])[^{]*\{[^}]*margin/, "and no rule reaching a phantom gives it a margin the cell would charge as height");
  });

  test("a stat cell prices its label-to-value spacing on the label, so a phantom charges no height", () => {

    using _dom = createTestDom();

    const text = skinCss();

    /* A phantom is an in-flow flex child of the cell, so a gap across the cell would charge its token once per phantom as height nobody can see. The absence of that
     * gap is the mechanism, which is why it is asserted beside the margin that carries the spacing in its place - and the assertion reads `gap:`, which covers the
     * row and column longhands too since both end in it. The margin is held to the token: a literal here would be a second definition of a length the tokens module
     * owns.
     */
    assert.doesNotMatch(text, /\.stat-item\s*\{[^}]*gap:/, "no stat cell rule declares a gap between its children, the status-grid variant included");
    assert.match(text, /\.stat-label\s*\{[^}]*margin-bottom:\s*var\(--fo-space-xxs\)/, "the label carries the label-to-value spacing, read from the xxs token");
    assert.doesNotMatch(text, /\.stat-label\s*\{[^}]*margin-bottom:\s*[0-9.]/, "no literal length survives where the token should be read");
  });

  test("the identity cells wear no wrapper rule of their own - they are cells on the shared tracks like every other", () => {

    using _dom = createTestDom();

    // A rule for an identity wrapper would mean a second geometry beside the shared tracks, which is the arrangement the one grid exists to replace, so its
    // absence is what the panel's alignment rests on rather than an omission.
    assert.doesNotMatch(skinCss(), /fo-status-identity/, "no rule reaches an identity wrapper");
  });

  test("the status message spans every track and wraps", () => {

    using _dom = createTestDom();

    const text = skinCss();

    assert.match(text, /\.fo-status-message\s*\{[^}]*grid-column:\s*1 \/ -1/);
    assert.match(text, /\.fo-status-message\s+\.stat-value\s*\{[^}]*white-space:\s*normal/);
  });

  test("the link-lost message centers and renders semibold in the attention token, and the reload action is its own full-width centered line", () => {

    using _dom = createTestDom();

    const text = skinCss();

    // The message-line modifier centers the line and renders its value span semibold in the attention token; the reload action is a centered line spanning every
    // track, and the recovery button on it wears its own Bootstrap styling rather than a theme color rule.
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s*\{[^}]*text-align:\s*center/);
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s+\.stat-value\s*\{[^}]*color:\s*var\(--fo-text-attention\)/);
    assert.match(text, /\.fo-status-message\.fo-status-linklost\s+\.stat-value\s*\{[^}]*font-weight:\s*600/);
    assert.match(text, /\.fo-status-reload\s*\{[^}]*grid-column:\s*1 \/ -1/);
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
     * focus state come with them so a field cannot flash a light background the moment it takes focus. Each declared value is tied to its exact token: a
     * literal here would be a second definition of a color the tokens module already owns.
     */
    assert.match(text, /:root\.fo-dark \.fo-field\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-field\s*\{[^}]*border-color:\s*var\(--fo-form-control-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-field\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);
    assert.match(text, /:root\.fo-dark \.fo-field::placeholder\s*\{[^}]*color:\s*var\(--fo-form-control-placeholder\)/);
    assert.match(text, /:root\.fo-dark \.fo-field:focus\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-field:focus\s*\{[^}]*border-color:\s*var\(--fo-form-control-focus-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-field:focus\s*\{[^}]*box-shadow:\s*var\(--fo-focus-ring\)/);
    assert.match(text, /:root\.fo-dark \.fo-field:focus\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);
  });

  test("a dropdown takes its width from its own widest member rather than from the container", () => {

    using _dom = createTestDom();

    // Bootstrap's `.form-control` stretches a control to the full width of what holds it, which on a dropdown offering two short labels reads as a mistake.
    // Handing the width back to the browser's intrinsic sizing is what makes the control as wide as its widest member, and the cap beside it is what keeps a
    // long member from pushing the control past the content cell on a narrow panel.
    const text = skinCss();

    assert.match(text, /select\.fo-field\s*\{[^}]*width:\s*auto/);
    assert.match(text, /select\.fo-field\s*\{[^}]*max-width:\s*100%/);
  });

  test("the value-field THEME treatment is dark-only - light mode is left to Bootstrap", () => {

    using _dom = createTestDom();

    /* The scope is a ruling rather than an oversight, so it is asserted rather than left to the comment beside the rules: every rule that DRESSES a value field is
     * dark-qualified, which is also what keeps the search field's light accent styling from spreading here by a later well-meant edit.
     *
     * The dropdown's sizing rule is the stated exception, and it is stated rather than dodged: a control has one width in both themes, so qualifying that rule
     * per theme to satisfy the sweep would have said the width was a dark-mode opinion. What the population asserts is therefore theme treatment, not every line
     * that happens to name the class.
     *
     * The second half holds the division the marker exists for: the class the view finds a control by carries no skin rule whatsoever, so a control that is not a
     * field - a picker group, a list editor's wrapper - cannot take a field's surface merely by being findable.
     */
    const fieldRules = skinCss().match(/^.*\.fo-field.*$/gm) ?? [];
    const hookRules = skinCss().match(/^.*\.fo-option-value.*$/gm) ?? [];
    const isSizingRule = (rule) => rule.startsWith("select.fo-field");

    assert.ok(fieldRules.length > 0, "precondition: the skin does declare value-field rules");
    assert.equal(fieldRules.filter(isSizingRule).length, 1, "precondition: the sizing rule is among them, exactly once");
    assert.ok(fieldRules.every((rule) => rule.startsWith(":root.fo-dark ") || isSizingRule(rule)), "and every rule that dresses one is dark-qualified");
    assert.deepEqual(hookRules, [], "the class the view finds a control by carries no skin rule at all");
  });
});

describe("buildOptionsSkinCss - the status panel's choices row", () => {

  test("the row takes a full-span line as a plain column, and its inner list flows the choices left, wrapping only when the width runs out", () => {

    using _dom = createTestDom();

    const text = skinCss();

    /* One full-span cell on the panel grid, shaped as the plain column a stat cell is. The absence of a gap on it is the mechanism rather than an omission: with no
     * gap, the label's own margin is the whole label-to-content distance here exactly as it is in every identity cell, so the two joins cannot drift apart. The
     * assertion reads `gap:`, which covers the row and column longhands too since both end in it.
     */
    assert.match(text, /\.fo-status-choices\s*\{[^}]*display:\s*flex/);
    assert.match(text, /\.fo-status-choices\s*\{[^}]*flex-direction:\s*column/);
    assert.match(text, /\.fo-status-choices\s*\{[^}]*grid-column:\s*1 \/ -1/);
    assert.doesNotMatch(text, /\.fo-status-choices\s*\{[^}]*gap:/,
      "the choices row declares no gap between its children, so the join comes from the label's own margin as in every stat cell");

    // The wrapping is the inner list's, and its spacing is the panel's spacing, read from the same token pair the panel grid's own gap declares rather than from a
    // second vocabulary. Happy-dom serializes the two-value shorthand as written, so the row gap and the column gap are both readable off the adopted sheet.
    assert.match(text, /\.fo-status-choice-list\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(text, /\.fo-status-choice-list\s*\{[^}]*gap:\s*var\(--fo-space-xs\) var\(--fo-space-md\)/);

    // The row declares no tracks of its own and takes none from the panel, so a choice never joins the parent's track sizing and a wide choice name cannot widen
    // an identity column beneath it.
    assert.doesNotMatch(text, /\.fo-status-choices\s*\{[^}]*grid-template-columns:/, "the list never lays itself onto the tracks the identity cells size");
  });

  test("a choice reads as muted secondary text in a fixed glyph box, and offers no affordance of a control", () => {

    using _dom = createTestDom();

    const text = skinCss();

    assert.match(text, /\.fo-status-choice\s*\{[^}]*color:\s*var\(--fo-text-muted\)/);
    assert.match(text, /\.fo-status-choice\s*\{[^}]*display:\s*flex/);
    assert.match(text, /\.fo-status-choice\s*\{[^}]*gap:\s*var\(--fo-space-xs\)/);
    assert.doesNotMatch(text, /\.fo-status-choice\s*\{[^}]*color:\s+(?!var\()/, "the reduced emphasis is read from the token, so neither mode can drift from the other");

    // happy-dom expands the `flex: none` shorthand to longhand, so the fixed box reads as a no-grow, no-shrink item at its declared width - which is what keeps a
    // flipped glyph from shifting the name beside it. The name carries the same trim discipline every value span wears.
    assert.match(text, /\.fo-status-choice-glyph\s*\{[^}]*width:\s*1\.25em/);
    assert.match(text, /\.fo-status-choice-glyph\s*\{[^}]*flex-grow:\s*0/);
    assert.match(text, /\.fo-status-choice-glyph\s*\{[^}]*flex-shrink:\s*0/);
    assert.match(text, /\.fo-status-choice-label\s*\{[^}]*text-overflow:\s*ellipsis/);

    /* Status, never a control. The absence of every interaction affordance is the design rather than an omission, so the whole population of choice rules is swept
     * for one: a hover treatment, a cursor, or a focus ring on any of them would tell the user this list answers something, and it answers nothing.
     */
    const choiceRules = text.match(/^.*\.fo-status-choice.*$/gm) ?? [];

    assert.ok(choiceRules.length > 0, "precondition: the skin does declare choice rules");
    assert.ok(choiceRules.every((rule) => !/hover|cursor|:focus/.test(rule)), "no choice rule offers a hover, a cursor, or a focus affordance");
  });
});

describe("buildOptionsSkinCss - the heading action's glyph", () => {

  test("seats the glyph on the button's line box rather than on a font metric", () => {

    using _dom = createTestDom();

    /* The guard and the rule are asserted as one nested match because the guard is what makes the declarations land together or not at all: the glyph's box grows
     * to the line box and then sits flush at its top, and a browser resolving only the alignment would seat the glyph worse than a browser resolving neither.
     *
     * Happy-DOM's CSS parser keeps an `lh` unit inside a `calc()` value and drops a bare one, so the checkbox seat's own `calc((1lh - 1em) / 2)` reads back off the
     * adopted sheet while this rule's `height: 1lh` does not survive parsing at all. A regex for that height would match the guard's own condition text and pass
     * whether or not the declaration landed, so the height is absent from these assertions rather than checked by something that cannot fail. The guard condition
     * and `vertical-align: top` are what the sheet does expose of this rule.
     */
    assert.match(skinCss(), /@supports \(height: 1lh\) \{\s*\.nav-header \.fo-action svg \{[^}]*vertical-align:\s*top/,
      "the glyph rule sits inside the feature guard, seating its box flush in the button's line box");
  });

  test("reaches the glyph from inside the guard only, so the seat cannot land half-applied", () => {

    using _dom = createTestDom();

    // An unguarded copy of the rule is precisely the failure the guard exists to prevent, and the nested match above would still pass with one present - so the
    // count is what locks it in. One occurrence, placed inside the guard by the assertion above, is the whole contract.
    const occurrences = skinCss().match(/\.nav-header \.fo-action svg/g) ?? [];

    assert.equal(occurrences.length, 1, "exactly one rule reaches the heading action's glyph");
  });
});

describe("buildOptionsSkinCss - the Global Options row", () => {

  // One rule owns the row's whole presentation, so the row is asserted as one thing: the type that keys it with the page's control vocabulary, the flex centering
  // that seats its glyph, and the spacing that keeps the heading below it labelling only the list beneath.
  const globalRule = () => skinCss().match(/^.*\[data-navigation="global"\].*$/m)?.[0] ?? "";

  test("wears the heading family's case, scale, and weight, so a control-shaped row reads as one", () => {

    using _dom = createTestDom();

    const rule = globalRule();

    assert.match(rule, /text-transform:\s*uppercase/, "the page's control vocabulary is uppercase, and the row keys with it");
    assert.match(rule, /font-size:\s*var\(--fo-font-size-xs\)/, "at the heading family's own scale, read from the token the headings resolve to rather than restated");
    assert.match(rule, /font-weight:\s*600/, "and its weight");
  });

  test("centers its glyph structurally rather than nudging it off the baseline", () => {

    using _dom = createTestDom();

    const rule = globalRule();

    // An inline SVG sits on the text baseline and hangs below the label's optical middle. Centering is the fix that holds at any type scale; a constant offset
    // would drift the moment the scale moved, which is why its absence is asserted alongside the centering itself.
    assert.match(rule, /display:\s*flex/, "the row lays its glyph and label out as a row");
    assert.match(rule, /align-items:\s*center/, "centered against each other");
    assert.doesNotMatch(rule, /vertical-align|position:\s*relative|top:/, "with no baseline nudge standing in for the centering");
  });

  test("owns the space between glyph and label, and the space beneath the row", () => {

    using _dom = createTestDom();

    const rule = globalRule();

    assert.match(rule, /gap:\s*var\(--fo-space-sm\)/, "the gap is the rule's, so the markup carries no spacing class of its own");
    assert.match(rule, /margin-bottom:\s*var\(--fo-space-sm\)/, "and the margin below keeps the controllers heading labelling the list rather than this row");
  });

  test("wears the interactive family's outline at rest, which the selected fill then subsumes", () => {

    using _dom = createTestDom();

    const text = skinCss();
    const activeRule = text.match(/^.*\[data-navigation="global"\]\.active.*$/m)?.[0] ?? "";

    assert.match(globalRule(), /border-color:\s*var\(--fo-border-accent\)/, "the row is outlined in the token every framed element on the page shares");
    assert.match(globalRule(), /color:\s*var\(--fo-text-muted\)/, "and rests in the muted text the ghost family rests in, which the headings beside it also resolve to");
    assert.match(activeRule, /border-color:\s*transparent/, "and the selected state hides that edge so the accent fill alone describes being here");
    assert.doesNotMatch(activeRule, /border-width|border-style/, "the border stays declared and only its color goes, so the row is the same size in both states");
  });

  test("declares no background of its own, which is what leaves the shared hover tint and selected fill reachable", () => {

    using _dom = createTestDom();

    /* The row's selector carries an id, so any background it declared would outrank `.nav-link:hover` and `.nav-link.active` - both plain class selectors - and take
     * the tint and the fill with it. A resting nav row is painted by nothing, so the outline needs no background beside it to read as transparent. This absence is
     * therefore the mechanism rather than an omission, which is why the test asserts it directly.
     */
    assert.doesNotMatch(globalRule(), /background/, "no background declaration sits in the row's own rule");
    assert.match(skinCss(), /\.nav-link:hover\s*\{[^}]*background-color:\s*var\(--fo-accent-hover\)/, "so the shared hover tint still paints inside the outline");
    assert.match(skinCss(), /\.nav-link\.active\s*\{[^}]*background-color:\s*var\(--fo-accent-bg\)/, "and the shared accent fill still lands when the row is current");
  });

  test("paints no state colors of its own - the shared row rules reach it", () => {

    using _dom = createTestDom();

    /* The row's affordances are what separate it from a title, and their colors come from `.nav-link:hover` and `.nav-link.active`. A colored state rule of its own
     * would be a second definition of the same thing, so its absence is the assertion. The one state rule the row does carry hides its own border under the selected fill
     * and paints nothing, which is why the hover selector is the one this asserts against.
     */
    const rule = globalRule();

    assert.doesNotMatch(rule, /:hover/, "the row's own rule declares no hover treatment");
    assert.match(skinCss(), /\.nav-link:hover\s*\{[^}]*background-color:\s*var\(--fo-accent-hover\)/, "the shared hover tint is what reaches it");
    assert.match(skinCss(), /\.nav-link\.active\s*\{[^}]*background-color:\s*var\(--fo-accent-bg\)/, "and the shared accent fill when it is the selection");
  });
});

describe("buildOptionsSkinCss - the choice group", () => {

  test("lays the group's members out as a wrapping row on the shared spacing tokens", () => {

    using _dom = createTestDom();

    const text = skinCss();

    // A long list has to read across the content cell rather than down it, and the fieldset's own default chrome - the margin and padding a bordered fieldset
    // wants - reads as stray indentation on one carrying no border.
    assert.match(text, /\.fo-choice-group\s*\{[^}]*display:\s*flex/);
    assert.match(text, /\.fo-choice-group\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(text, /\.fo-choice-group\s*\{[^}]*gap:\s*var\(--fo-space-xs\)\s+var\(--fo-space-md\)/);
    assert.match(text, /\.fo-choice-group\s*\{[^}]*border:\s*0/);
    assert.match(text, /\.fo-choice\s*\{[^}]*display:\s*inline-flex/);
    assert.match(text, /\.fo-choice\s*\{[^}]*gap:\s*var\(--fo-space-xs\)/);
  });

  test("reads a member the device no longer offers in the attention color, in both lighting modes", () => {

    using _dom = createTestDom();

    const text = skinCss();

    // The token itself carries the per-mode value, so one unqualified rule is correct in both modes - and tying it to the token is what keeps a literal color
    // from becoming a second definition of something the tokens module owns.
    assert.match(text, /\.fo-choice-unknown\s*\{[^}]*color:\s*var\(--fo-text-attention\)/);

    const unknownRules = text.match(/^.*\.fo-choice-unknown.*$/gm) ?? [];

    assert.equal(unknownRules.length, 1, "one rule states it, so neither mode can drift from the other");
    assert.equal(unknownRules[0].startsWith(":root.fo-dark"), false, "and it is deliberately not mode-qualified");
  });

  test("the group declares no surface of its own, since what a member looks like is the member's own business", () => {

    using _dom = createTestDom();

    // A fieldset is what makes the members one control rather than a field in its own right: the members are native inputs that follow `color-scheme` in both
    // modes, and the group sits on the row's surface. A fill declared here would paint a rectangle behind them and be a second place to keep in step besides.
    const groupRules = skinCss().match(/^.*\.fo-choice-group.*$/gm) ?? [];

    assert.ok(groupRules.length > 0, "precondition: the skin does declare group rules");
    assert.equal(groupRules.every((rule) => !rule.includes("background-color")), true, "the group declares no surface of its own");
  });
});

describe("buildOptionsSkinCss - the list editor", () => {

  test("lays the entries out as wrapping inline boxes on the accent tokens", () => {

    using _dom = createTestDom();

    const text = skinCss();

    assert.match(text, /\.fo-list-editor\s*\{[^}]*display:\s*flex/);
    assert.match(text, /\.fo-list-editor\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(text, /\.fo-list-item\s*\{[^}]*background-color:\s*var\(--fo-accent-bg\)/);
    assert.match(text, /\.fo-list-item\s*\{[^}]*color:\s*var\(--fo-accent-fg\)/);
    assert.match(text, /\.fo-list-item\s*\{[^}]*border-radius:\s*var\(--fo-radius-sm\)/);

    // The remove control surrenders its chrome the way the reveal toggle does, so what reads is the glyph rather than a button.
    assert.match(text, /\.fo-list-remove\s*\{[^}]*border:\s*0/);
    assert.match(text, /\.fo-list-remove\s*\{[^}]*color:\s*inherit/);
  });

  test("the editor's own rules touch no surface the field treatment owns, so the two do not fight", () => {

    using _dom = createTestDom();

    // The entry field wears the skin's field marker and takes its whole dark treatment from that one trio, which is dark-only. What the editor declares for
    // itself is how the entries lay out, in both modes and with no surface among it, so nothing here can disagree with the trio about what a field looks like.
    const editorRules = skinCss().match(/^.*\.fo-list-editor.*$/gm) ?? [];

    assert.ok(editorRules.length > 0, "precondition: the skin does declare editor rules");
    assert.ok(editorRules.every((rule) => !rule.includes("background-color") && !rule.includes("border-color")), "the wrapper declares no field surface");
  });
});
