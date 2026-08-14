/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/utils.mjs: Shared utilities for the plugin webUI - used by the feature-options components and the top-level orchestrator alike.
 */
"use strict";

/**
 * Sleep for the given duration and resolve, or reject early when the supplied signal aborts.
 *
 * This is the browser-side counterpart to the server-side `onAbort` disposable pattern: every lifecycle-bound async pause in the webUI funnels through one
 * helper, so listener cleanup, pre-aborted fast-path semantics, and rejection-reason propagation live in exactly one place. Callers express "wait, but only while
 * this view is alive" by composing a delay with their lifecycle signal - the rest is mechanical.
 *
 * @param {number} ms - Duration to sleep, in milliseconds.
 * @param {AbortSignal} [signal] - Optional lifecycle signal. When provided, an abort cancels the timer and rejects the promise with the signal's reason. A signal
 *                                 that is already aborted at call time rejects synchronously on the next microtask without scheduling a timer.
 * @returns {Promise<void>} Resolves after `ms` milliseconds, or rejects with `signal.reason` on abort.
 */
export function delay(ms, signal) {

  if(signal?.aborted) {

    return Promise.reject(signal.reason);
  }

  const { promise, resolve, reject } = Promise.withResolvers();

  // `onAbort` references `timer` lexically; the const is initialized before any addEventListener fires it, so the TDZ is never touched at call time. Both
  // closures only run later, after both consts are initialized, so `onAbort` is declared first purely for readability - either declaration order is safe.
  const onAbort = () => {

    clearTimeout(timer);
    reject(signal.reason);
  };

  const timer = setTimeout(() => {

    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);

  signal?.addEventListener("abort", onAbort, { once: true });

  return promise;
}

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

// The namespace every SVG element must be created in. `document.createElement("svg")` yields an inert HTML element that happens to share the tag name and renders
// nothing, so the namespaced constructor is the only way to build a graphic the browser will draw.
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Create one SVG element with its attributes applied. The counterpart to {@link createElement} for graphics, and separate from it for two reasons the DOM imposes:
 * SVG elements need the namespaced constructor, and SVG exposes presentation as attributes rather than as the properties `createElement` assigns.
 *
 * Shared by every graphic the webUI draws - the sparkline strip's marks and the feature-options reveal glyph alike - so how an SVG element comes into being is
 * defined once rather than per drawing.
 *
 * @param {Object} options - The element to build.
 * @param {Object<string, string>} [options.attributes={}] - The attributes to apply.
 * @param {string} options.tag - The SVG tag name.
 * @returns {SVGElement} The created element.
 */
export function createSvgElement({ attributes = {}, tag }) {

  const element = document.createElementNS(SVG_NAMESPACE, tag);

  for(const [ name, value ] of Object.entries(attributes)) {

    element.setAttribute(name, value);
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

/**
 * Move an element addressed by id from one class to another, tolerating an element the page does not carry.
 *
 * A generic two-state swap with no opinion about what the classes mean: a consumer's own page chrome uses it to move an element between mutually exclusive states
 * without writing the lookup and the null check at each site. What the framework's own menu tabs wear is {@link paintMenuTabs}' business, not this helper's.
 *
 * A plugin's markup declares which surfaces it offers, so a swap aimed at an element the markup omits is a deliberate no-op rather than a failure: the caller runs
 * the same code whether or not the page carries the element.
 *
 * @param {string} id          - The element ID to update.
 * @param {string} removeClass - The class to remove.
 * @param {string} addClass    - The class to add.
 */
export function swapMenuClasses(id, removeClass, addClass) {

  const element = document.getElementById(id);

  if(!element) {

    return;
  }

  element.classList.remove(removeClass);
  element.classList.add(addClass);
}

// The page's menu buttons, in the order the markup lays them out. This list is the single source of truth for which buttons a menu paint reaches: every paint site
// names only the tab it is activating, so a page that gains or loses a menu surface is one edit here rather than one at each site.
const MENU_IDS = [ "menuHome", "menuFeatureOptions", "menuSettings" ];

/**
 * Paint the menu tabs, marking exactly one of them active.
 *
 * One declarative call in place of per-button class juggling at each tab-switch site: the caller names the tab that is now active, and this owns everything else -
 * which buttons the page has, what the framework's menu vocabulary is, and normalizing away the Bootstrap variant a consumer's markup ships its buttons with. That
 * normalization runs on every paint, which is what makes the first paint the one that converts the markup's classes with no first-run special case anywhere.
 *
 * The `fo-` classes carry the whole visual state: `fo-menu` is the quiet ghost every tab wears and `fo-menu-active` adds the theme's accent fill over it, so the
 * eye-catching treatment marks the tab the user is on. Both are styled in the page-lifetime theme sheet, which is in force on every tab including Support.
 *
 * A button the page does not carry is a no-op, the same posture {@link swapMenuClasses} takes toward a missing element.
 *
 * @param {string} activeId - The element ID of the tab that is now active. An id no menu button carries leaves every tab inactive.
 */
export function paintMenuTabs(activeId) {

  for(const id of MENU_IDS) {

    const element = document.getElementById(id);

    if(!element) {

      continue;
    }

    // Both Bootstrap variants a menu button might arrive wearing come off, so the framework's own classes are the only thing describing the tab's state and no host
    // variant styling competes with the theme sheet for it. The `btn` class itself stays: it carries the button's geometry, which these classes do not restate.
    element.classList.remove("btn-elegant", "btn-primary");
    element.classList.add("fo-menu");
    element.classList.toggle("fo-menu-active", id === activeId);
  }
}

/**
 * Show a transient toast below the status bar (success styling by default; pass a variant for other alert types).
 *
 * The toast auto-dismisses after 3 seconds with a fade-out transition. Uses Bootstrap's alert component for consistent styling.
 *
 * @param {string} message - The bold message text to display.
 * @param {string} [variant="alert-success"] - The Bootstrap alert variant class.
 */
export function showToast(message, variant = "alert-success") {

  const statusBar = document.getElementById("featureStatusBar");

  if(!statusBar) {

    return;
  }

  // Construct the toast body as DOM nodes so the message string flows through textContent in <strong>, never as HTML. The dismiss button's static attributes are
  // declared on the createElement props, including the `aria-label` and `data-bs-dismiss` attributes the helper routes to setAttribute.
  const toast = createElement("div", { classList: "alert " + variant + " alert-dismissible fade show mt-2", role: "alert" }, [

    createElement("strong", {}, [message]),
    createElement("button", { "aria-label": "Close", classList: "btn-close", "data-bs-dismiss": "alert", type: "button" })
  ]);

  statusBar.insertAdjacentElement("afterend", toast);

  // Auto-dismiss after 3 seconds. This keeps the UI clean while still providing sufficient time to read the message.
  setTimeout(() => {

    toast.classList.remove("show");

    // Remove the node only after Bootstrap's `.fade` transition (150ms) has visually completed, so the toast fades out rather than vanishing abruptly.
    setTimeout(() => toast.remove(), 150);
  }, 3000);
}

/**
 * Extract a user-facing message from an arbitrary thrown value. The webUI's extension points - caller-supplied first-run hooks, plugin device fetchers, the
 * connection-error retry callback, the config re-sync - can reject with any shape (an Error, a string, a plain object, a primitive), so the message is extracted
 * defensively: `err?.message` when the value carries one, a string coercion of the whole value otherwise. This is the single error-to-text truth the webUI shares,
 * so a toast, a nav-view connection-error message, and the sync-failure copy all read the same thrown value the same way.
 *
 * @param {*} err - The thrown value to describe.
 * @returns {string} The extracted message.
 */
export function errorMessage(err) {

  return err?.message ?? String(err);
}

/**
 * Surface an arbitrary thrown value as an error toast. Routes the value through {@link errorMessage} so the toast text stays useful regardless of what bubbled out.
 *
 * @param {*} err - The thrown value to surface.
 */
export function toastError(err) {

  homebridge.toast.error(errorMessage(err), "Error");
}
