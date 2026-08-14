/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/optionsSkin.mjs: The options-view skin - layout, sidebar, category frames, the search bar, and the status panel.
 */
"use strict";

/**
 * Register the options-view skin effect. Adopts a constructable stylesheet carrying every rule that belongs to the feature-options view itself: the page layout,
 * the sidebar and its navigation pills, the category frames and option rows, the search bar, the device-stats and status grids, and the dark-mode corrections for
 * the view's own controls. Cleanup is automatic via the supplied AbortSignal - aborting removes the stylesheet from `document.adoptedStyleSheets`.
 *
 * The skin's lifetime is the view's rather than the page's, which is what its rules require: several of them - the `.nav-link` set above all - restyle Bootstrap
 * classes a custom page may legitimately use for something else, so they must be gone the moment the user navigates away from this view. The page-level half of the
 * framework's look lives in the theming and tokens modules and stays adopted for the whole page.
 *
 * Adopted synchronously - the rules are static and have no I/O dependencies, so the stylesheet is ready by the time the call returns. Every color, spacing, radius,
 * and motion value references a `--fo-*` token declared by the tokens effect, so the page registers that effect first.
 *
 * @param {Object} args
 * @param {AbortSignal} args.signal - Lifecycle signal. Aborting releases the stylesheet from the document.
 */
export const registerOptionsSkinEffect = ({ signal }) => {

  if(signal.aborted) {

    return;
  }

  const stylesheet = new CSSStyleSheet();

  stylesheet.replaceSync(buildOptionsSkinCss());
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, stylesheet ];

  signal.addEventListener("abort", () => {

    // Release the stylesheet. Filter-rebuild rather than mutate to preserve the array's identity contract across consumers.
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== stylesheet);
  }, { once: true });
};

// The options-view skin. Layout, sidebar, category frames, option rows, the search bar, the device-stats and status grids, and the dark-mode corrections for this
// view's own controls. Color, spacing, radius, and motion values reference the `--fo-*` tokens declared by the tokens effect; structural layout rules (flex
// containers, container queries, subgrid tracks) intentionally use raw values since they are not design-token concerns. Consumers see one cohesive design language
// regardless of which mode is active.
const buildOptionsSkinCss = () => [

  // Page layout.
  "#pageFeatureOptions { display: flex !important; flex-direction: column; width: 100%; }",
  ".feature-main-content { display: flex !important; flex-direction: row !important; width: 100%; }",

  // Sidebar. Background matches the main surface rather than an elevated fill; an accent-derived border delineates it, consistent with the other container frames.
  "#sidebar { display: block; width: var(--fo-sidebar-width); min-width: var(--fo-sidebar-width); max-width: var(--fo-sidebar-width); position: relative; " +
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
  // defined behavior of content-visibility, not an engine quirk, confirmed identically in Chromium and WebKit. Scoping to open categories keeps the optimization where
  // rows actually exist and lets collapsed categories collapse to zero.
  "details[open] > .fo-category-rows { content-visibility: auto; contain-intrinsic-size: 0 200px; }",

  // Per-row subgrid inheriting the parent's column tracks. The checkbox top-aligns (align-items: start) so that on a multi-line label - or a value option whose field
  // stacks beneath the label - it sits beside the first line rather than floating against the vertical center of a tall cell.
  ".fo-option-row { align-items: start; display: grid; gap: var(--fo-space-sm); grid-column: 1 / -1; " +
    "grid-template-columns: subgrid; padding: var(--fo-space-xs) var(--fo-space-md); " +
    "transition: background-color var(--fo-transition-fast); }",
  ".fo-option-row:hover { background-color: var(--fo-row-hover-bg); }",
  ".fo-option-row.fo-hidden { display: none !important; }",

  // While the table is busy - a controller's device list in flight - every row's inputs are disabled, and the rows dim to say so. The dim comes from
  // `--fo-opacity-disabled`, the shared not-actionable value the locked secret toggle already wears, and the default cursor keeps a row that answers nothing from
  // presenting itself as one that does. The category headers stay undimmed and live: expanding one during the window is how its rows materialize, and a projection
  // pass that finds a category already open materializes them the same way...either route delivers them inert.
  ".fo-options-busy .fo-option-row { cursor: default; opacity: var(--fo-opacity-disabled); }",

  // The option's text wears the `cursor-pointer` utility, and that rule matches the label element itself while the row rule above matches only its ancestor...so the
  // row rule alone leaves a pointer hovering over the text of a row that answers nothing. Reaching the label through its row and the busy marker outranks the utility
  // on specificity and carries the default cursor across the whole row. The dim belongs to the row alone: the label already inherits it, and a second opacity here
  // would compound the two.
  ".fo-options-busy .fo-option-row .fo-option-label { cursor: default; }",

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

  // Live-status panel variant. The status grid wraps its cells into two rows - the identity cells with the Status cell closing the top row, then the state rows -
  // inside one bordered box, so it overrides the base grid's nowrap and proportional split: cells size to their own content (a phantom span per column reserves the
  // column's maximum-ever width) and a full-width zero-height break forces the row split between the identity cells and the state rows. A classified error renders as
  // a full-width wrapping message line. These rules sit AFTER the base `.device-stats-grid` rules so the `.fo-status-grid` qualifier ties the base specificity and
  // wins on source order, which is what lets it override the base `:first-child` proportional split too.
  ".device-stats-grid.fo-status-grid { flex-wrap: wrap; row-gap: var(--fo-space-xs); }",
  ".device-stats-grid.fo-status-grid .stat-item { flex: 0 1 auto; min-width: 0; }",
  ".fo-phantom { display: block; height: 0; overflow: hidden; visibility: hidden; }",
  ".fo-row-break { flex-basis: 100%; height: 0; }",
  ".fo-status-message { flex-basis: 100%; }",
  ".fo-status-message .stat-value { white-space: normal; }",

  // Link-lost prominence. The message line's modifier centers it and renders its value span semibold in the attention token, so the lost-connection state reads at a
  // glance and stands apart from the neutral error message that shares the base line above. The reload action is its own full-width centered line below the message; it
  // is the shared recovery button, which carries its own Bootstrap warning styling, so the line rule supplies only the full width and centering. The base
  // `.fo-status-message` rules still supply the message line's width and wrapping; the modifier adds only the centering, weight, and color.
  ".fo-status-message.fo-status-linklost { text-align: center; }",
  ".fo-status-message.fo-status-linklost .stat-value { color: var(--fo-text-attention); font-weight: 600; }",
  ".fo-status-reload { flex-basis: 100%; text-align: center; }",

  // Connection-error failure text. The connection-error view renders its failure message in a `code` element; this rule takes that element's color from the shared
  // attention token rather than Bootstrap's `text-danger`, so the failure emphasis has one definition and dark-mode controller errors carry the softer attention tone the
  // link-lost message already uses. The class selector outweighs the `code` element's own default color.
  ".fo-failure-text { color: var(--fo-text-attention); }",

  // Responsive hiding for device stats grid. `@container` (not `@media`) so the breakpoints fire on the panel's actual width, not the viewport. Progressive degradation:
  // as the container narrows, the last stat hides first, then the second-to-last, etc., so the most-important left-most stat (Firmware) stays visible longest. Each rule
  // qualifies the grid with `:not(.fo-status-grid)` so the status panel is exempt: the status grid reserves every column at its maximum width and never hides a cell, and
  // the exemption keyed on the grid token encodes that no-hide policy explicitly, so a page that later nests the container under a container ancestor cannot silently
  // reintroduce cell-hiding for it. The final rule, hiding `#statusInfo` at 400px, targets a different element entirely, the search view's own status bar rather than a
  // `.device-stats-grid` stat item, so its threshold sits on an independent scale instead of continuing the stat items' descending sequence.
  "@container (max-width: 700px) { .device-stats-grid:not(.fo-status-grid) .stat-item:nth-last-of-type(1) { display: none !important; } }",
  "@container (max-width: 500px) { .device-stats-grid:not(.fo-status-grid) .stat-item:nth-last-of-type(2) { display: none !important; } }",
  "@container (max-width: 300px) { .device-stats-grid:not(.fo-status-grid) .stat-item:nth-last-of-type(3) { display: none !important; } }",
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
  /* Global Options: a row that keys with the page's control vocabulary. Everything control-shaped reads uppercase - the host's own stylesheet uppercases every button
   * it renders, and the section headings are uppercase from the `text-uppercase` utility class the nav view stamps in markup - so a row in sentence case is the one thing
   * on the page that looks like neither, anchored to no section and matching no control. Wearing the heading family's case, scale, and weight settles it into that
   * vocabulary, while what separates it from an actual heading stays what it was: the row container it is built as, the hover tint, the accent fill when selected,
   * and the kind glyph. The affordances carry "clickable", never the case.
   *
   * The type comes from the heading family and reads its token rather than restating a value: `--fo-font-size-xs` is the size the section headings resolve to, and 600
   * is their weight, so the row and the headings track one scale and a change to it moves both. The token is what "the heading scale" means here, since a heading
   * reaches that size through the rule above outranking the `small` class it carries. Flex centering is what seats the glyph against the label: an inline SVG sits on
   * the text baseline and hangs below the label's optical middle, and
   * centering is the structural answer to that rather than a nudge constant that would drift with the type. The gap owns the space between them, so the markup
   * carries no spacing class of its own, and the margin below is what keeps the controllers heading reading as the label of the list beneath it rather than of this
   * row too.
   *
   * The outline is the interactive family's, shared with the page's action controls at rest, and that symmetry is the point: what separates a destination from an
   * action is not its resting frame but its type, its position, and what happens when you arrive. This row rides the tabs' lifecycle rather than a button's - an
   * outline while you are elsewhere, a solid accent fill that stays for as long as you are here - because it is a place with a current state, which an action never
   * has.
   *
   * The frame is a border and nothing else. A background declared here would outrank the shared hover and selected rules, whose selectors carry no id, and take the
   * tint and the fill down with it; the row is transparent at rest already, since nothing paints a resting nav row. The radius is the shared nav token, inherited
   * rather than restated, so the family reads as one at every corner.
   *
   * The resting text is the ghost family's own: the `.fo-action` and `.fo-menu` rest state declares exactly this token, and a row riding that family's grammar
   * while you are elsewhere rests in the same muted tone rather than in whatever an ordinary nav row inherits. Agreeing with the headings beside it follows from
   * both reading one token and is a consequence rather than the reason. The tie is semantic and not mechanical: the family's rule and this one reach for the token
   * independently, so a redesign of what the family's rest looks like carries both without either rule reaching into the other. The color is safe to declare where
   * a background was not, because the shared hover and selected rules mark their own text `!important` and this plain declaration cannot outrank that.
   */
  "#controllersContainer .nav-link[data-navigation=\"global\"] { align-items: center; border: 1px solid var(--fo-border-accent); " +
    "color: var(--fo-text-muted); display: flex; font-size: var(--fo-font-size-xs); font-weight: 600; gap: var(--fo-space-sm); " +
    "margin-bottom: var(--fo-space-sm); text-transform: uppercase; }",

  // The selected state subsumes the frame: an accent edge over an accent fill reads as a line through the fill rather than as an outline, so the fill alone
  // describes being here. The border stays declared and only its color goes, which keeps the row exactly the same size in both states.
  "#controllersContainer .nav-link[data-navigation=\"global\"].active { border-color: transparent; }",

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

  // Dark-mode corrections for this view's own controls: the search field's surface, border, placeholder, and focus state, and the status bar's muted text. Each
  // needs treatment beyond what the tokens express on their own.
  ":root.fo-dark #search .form-control { background-color: var(--fo-form-control-bg); border-color: var(--fo-border-accent); color: var(--fo-text-on-elevated); }",
  ":root.fo-dark #search .form-control:focus { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-focus-border); " +
    "color: var(--fo-text-on-elevated); box-shadow: var(--fo-focus-ring); }",
  ":root.fo-dark #search .form-control::placeholder { color: var(--fo-form-control-placeholder); }",
  ":root.fo-dark #statusInfo .text-muted { color: var(--fo-statusinfo-muted) !important; }",

  /* A value option's field, dressed from the same tokens the search field reads and keyed on the class the renderer stamps on every value input. A masked secret
   * field is that same construction with its type swapped, so this reaches it through the same hook rather than through a rule of its own. The correction is
   * needed because Bootstrap pins an explicit white background on a form control, which outranks the native `color-scheme` rendering - so a field left alone
   * renders white on the dark surface while the search field beside it renders dark.
   *
   * Light mode is deliberately Bootstrap's own, the same stance the page kit takes on its own fields, and the search field's light-mode accent styling is
   * pointedly not extended here: these fields sit inside the bordered category frame that already carries the accent, so the asymmetry with the trio above is a
   * choice about where accent belongs rather than an omission.
   */
  ":root.fo-dark .fo-option-value { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-border); color: var(--fo-text-on-elevated); }",
  ":root.fo-dark .fo-option-value::placeholder { color: var(--fo-form-control-placeholder); }",
  ":root.fo-dark .fo-option-value:focus { background-color: var(--fo-form-control-bg); border-color: var(--fo-form-control-focus-border); " +
    "box-shadow: var(--fo-focus-ring); color: var(--fo-text-on-elevated); }"

].join("\n");
