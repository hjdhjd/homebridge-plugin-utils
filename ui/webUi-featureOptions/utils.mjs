/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/utils.mjs: Shared DOM and presentation utilities for the feature-options components.
 */
"use strict";

/**
 * Create a DOM element with optional properties and children.
 *
 * This utility is shared across all feature options components. It reduces the verbosity of DOM manipulation by handling common patterns like setting classes,
 * styles, and adding children in a functional style.
 *
 * @param {string} tag - The HTML tag name to create.
 * @param {Object} [props={}] - Properties to set on the element.
 * @param {string|string[]|Array} [props.classList] - CSS classes to add.
 * @param {Object} [props.style] - Inline styles to apply.
 * @param {Array<string|Node>} [children=[]] - Child nodes or text content.
 * @returns {HTMLElement} The created DOM element.
 */
export function createElement(tag, props = {}, children = []) {

  const element = document.createElement(tag);

  // Destructure classList and style off the props object so the remaining `attrs` can be iterated as plain DOM property/attribute assignments. We destructure
  // (rather than mutate) so callers can safely reuse the same props record across multiple createElement invocations.
  const { classList, style, ...attrs } = props;

  if(classList) {

    const classes = Array.isArray(classList) ? classList : classList.split(" ");

    element.classList.add(...classes);
  }

  if(style) {

    Object.assign(element.style, style);
  }

  for(const [ key, value ] of Object.entries(attrs)) {

    // Use setAttribute for cases that don't reflect via property assignment:
    //   1. Dashed attributes (`data-*`, `aria-*`, etc.) - no corresponding JS property to set.
    //   2. JS reserved words mapped to non-obvious DOM property names. `for` is the canonical case: setting `label.for = id` creates a JS expando property
    //      with no effect on the HTML attribute (the reflective property is `htmlFor`, not `for`). Without this branch, `<label for="...">` ends up without
    //      its `for` attribute and native label-for click-to-toggle silently doesn't work. Other reserved-word collisions (`class` -> className) are handled
    //      via the `classList` destructuring above; `for` is the remaining case the renderer relies on.
    if(key.includes("-") || (key === "for")) {

      element.setAttribute(key, value);
    } else {

      element[key] = value;
    }
  }

  for(const child of children) {

    element.appendChild((typeof child === "string") ? document.createTextNode(child) : child);
  }

  return element;
}

/**
 * Build a recovery button in the webUI's shared family idiom: a small warning-variant Bootstrap button whose label is prefixed with the refresh glyph (U+21BB, the
 * clockwise open circle arrow) and a space. Both the connection-error view's retry action and the status panel's link-lost reload action construct their button here, so
 * what a recovery button looks like - the glyph, the variant, and the size - is defined in exactly one place. The consumer owns where the button sits (its layout
 * spacing) and what it does (its click wiring and its disabled state); this builder owns only what the button is.
 *
 * Where Bootstrap has not applied, the button degrades to an unstyled but fully functional native button - the family's accepted posture, since the recovery action
 * stays clickable regardless of whether the host stylesheet has painted it.
 *
 * @param {string} label - The button's action label. The refresh glyph is prepended here, so callers pass the bare label without it.
 * @returns {HTMLButtonElement} A `<button type="button">` wearing the small warning-variant recovery classes and carrying the glyph-prefixed label.
 */
export function buildRecoveryButton(label) {

  return createElement("button", { classList: [ "btn", "btn-warning", "btn-sm" ], textContent: "↻ " + label, type: "button" });
}

/**
 * Capture the current expansion state of every category in the supplied container as a plain `{ [categoryName]: isCollapsed }` map. Symmetric counterpart to
 * {@link applyCategoryStates}; both sit alongside {@link setCategoryExpanded} as the SSOT for category reads and writes, so the persistence layer can stay
 * DOM-agnostic.
 *
 * Reads `details.open` rather than any JS-mirrored expand state - the `<details>` element's own `open` attribute is the SSOT for "is this category currently
 * expanded?"
 *
 * @param {HTMLElement} configTable - Container holding category `<details>` elements (each `<details data-category="...">` whose `open` attribute marks it expanded).
 * @returns {Object<string, boolean>} Map of category name to collapsed boolean.
 */
export function captureCategoryStates(configTable) {

  const states = {};

  for(const details of configTable.querySelectorAll("details[data-category]")) {

    states[details.getAttribute("data-category")] = !details.open;
  }

  return states;
}

/**
 * Apply a previously-captured `{ [categoryName]: isCollapsed }` map onto the matching category `<details>` elements in the supplied container. Categories absent
 * from the map are left at their current state. Symmetric counterpart to {@link captureCategoryStates}; routes every write through {@link setCategoryExpanded},
 * which mutates `details.open` and leaves the browser to propagate the disclosure state and to fire `toggle` for whoever observes it - the options view's
 * user-gesture path, the search view's expand/collapse ratio.
 *
 * What a restored-open category has inside it is neither this write's business nor the event's: the options view's projection walk materializes the rows of any
 * category it finds open, and every render pass ends in that walk...so restoring state here is a state write and nothing more.
 *
 * @param {HTMLElement} configTable - Container holding category `<details>` elements to apply state to.
 * @param {Object<string, boolean>} states - Map of category name to collapsed boolean (the shape returned by captureCategoryStates).
 */
export function applyCategoryStates(configTable, states) {

  for(const details of configTable.querySelectorAll("details[data-category]")) {

    const categoryName = details.getAttribute("data-category");

    if(categoryName in states) {

      setCategoryExpanded(details, !states[categoryName]);
    }
  }
}

/**
 * Set the expansion state of a category. This is the single source of truth for programmatic category-state writes: it mutates `details.open`, which the browser
 * propagates to the visible disclosure state (header arrow rotation via CSS keyed on `[open]`, content visibility via the native disclosure widget) and fires
 * the `toggle` event the orchestrator's capture-phase delegated handler intercepts.
 *
 * Used by the search component for bulk expand/collapse and auto-expand during search, and by the orchestrator for restoring saved category states. User-driven
 * toggles via summary click happen natively in the browser - no code path here.
 *
 * @param {HTMLDetailsElement} details - The category `<details>` element.
 * @param {boolean} expanded - True to expand the category, false to collapse it.
 */
export function setCategoryExpanded(details, expanded) {

  details.open = expanded;
}
