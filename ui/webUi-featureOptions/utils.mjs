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

    // Use setAttribute for two cases that don't reflect via property assignment:
    //   1. Dashed attributes (`data-*`, `aria-*`, etc.) - no corresponding JS property to set.
    //   2. JS reserved words mapped to non-obvious DOM property names. `for` is the canonical case: setting `label.for = id` creates a JS expando property
    //      with no effect on the HTML attribute (the reflective property is `htmlFor`, not `for`). Without this branch, `<label for="...">` ends up without
    //      its `for` attribute and native label-for click-to-toggle silently doesn't work. Other reserved-word collisions (`class` -> className) are handled
    //      via the `classList` destructuring above; `for` is the only remaining case the renderer relies on.
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
 * from the map are left at their current state. Symmetric counterpart to {@link captureCategoryStates}; routes every write through {@link setCategoryExpanded}
 * so each programmatic toggle fires the `toggle` event the orchestrator listens for (which materializes lazy rows on expand and coalesces post-toggle sync).
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
 * Surface an arbitrary thrown value as an error toast. The webUI's extension points - caller-supplied first-run hooks, plugin device fetchers, the connection-error
 * retry callback - can reject with any shape (an Error, a string, a plain object, a primitive), so the message is extracted defensively: `err?.message` when the
 * value carries one, a string coercion of the whole value otherwise. This is the single normalization every user-facing catch across the webUI routes through, so
 * the toast text stays useful regardless of what bubbled out.
 *
 * @param {*} err - The thrown value to surface.
 */
export function toastError(err) {

  homebridge.toast.error(err?.message ?? String(err), "Error");
}
