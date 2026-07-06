/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/search.mjs: The search panel - search input + filter pills + toggle-all + status counts + reset button group.
 */
"use strict";

import { createElement, setCategoryExpanded } from "../utils.mjs";
import { effect } from "../store.mjs";
import { projection } from "../selectors.mjs";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Mount the search panel view.
 *
 * The panel hosts the following interactive surfaces:
 *
 *   - **Search input** - debounced 300ms; dispatches `filter:changed` with the trimmed query.
 *   - **Filter pills** (All / Modified) - dispatch `filter:changed` with the mode.
 *   - **Toggle-all categories** - imperative DOM mutation; sets `<details open>` on every category in the config table.
 *   - **Status bar counters** (total / modified / grouped / visible) - read from the projection, updated on any state change that touches it.
 *   - **Reset button group** (Reset... -> Reset to Defaults / Revert to Saved) - dispatches `options:reset` or `model:reverted`.
 *
 * The panel re-builds on `model:loaded` (and only then). Subsequent dispatches update individual elements (counts, pill active-state, toggle-all label) without
 * rebuilding the DOM. The view's footprint is small because the heavy work - the projection walk - is shared with view-options through the memoized selector.
 *
 * @param {Object} args
 * @param {HTMLElement} args.configTable - The `#configTable` element. The toggle-all handler queries it directly to set the open-state on category disclosures.
 * @param {HTMLElement} args.root - The `#search` container.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountSearchView = ({ configTable, root, signal, store }) => {

  // Element refs filled in by buildPanel(); update functions read these to mutate text or active-state.
  const refs = {

    filterAll: null,
    filterModified: null,
    grouped: null,
    modified: null,
    resetDefaults: null,
    resetRevert: null,
    resetToggle: null,
    search: null,
    toggleAll: null,
    total: null,
    visible: null
  };

  let debounceTimer = null;

  signal.addEventListener("abort", () => {

    clearTimeout(debounceTimer);
  }, { once: true });

  // Build the panel once at model:loaded. Subsequent rebuilds would invalidate refs and re-bind handlers; for a single-instance panel, one-time build is correct.
  effect({

    events: ["model:loaded"],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      // Build the panel content. The view never reveals its own region; the orchestrator owns region visibility and reveals the search panel via revealRegions once the
      // populated UI is ready, so the search box and its metrics do not flash in before the rest of the page.
      buildPanel({ debounce: scheduleSearchDispatch, refs, root });
    },
    signal,
    store
  });

  // Counts and visible-toggle pill highlight update on any state change that touches the projection. Reading the projection here hits the memoized cache when
  // nothing relevant changed (e.g., a scope:changed that resolves to the same view returns the cached projection in O(1)).
  effect({

    events: [ "model:loaded", "option:set", "option:cleared", "options:reset", "model:reverted", "filter:changed", "scope:changed", "devices:loaded" ],
    fn: () => {

      if(!refs.total) {

        return;
      }

      const p = projection(store.state);

      refs.total.textContent = String(p.counts.total);
      refs.modified.textContent = String(p.counts.modified);
      refs.grouped.textContent = String(p.counts.grouped);
      refs.visible.textContent = String(p.counts.visible);

      updateToggleAllLabel({ configTable, toggleAll: refs.toggleAll });
      updateFilterPillState({ filterAll: refs.filterAll, filterModified: refs.filterModified, mode: store.state.filter.mode });
    },
    signal,
    store
  });

  // Wire the search input event listener. Reads the current value, dispatches debounced filter:changed.
  root.addEventListener("input", (event) => {

    if(event.target !== refs.search) {

      return;
    }

    scheduleSearchDispatch(event.target.value.trim());
  }, { signal });

  // Wire button click handlers via delegation on the panel root.
  root.addEventListener("click", (event) => handleClick({ configTable, event, refs, store }), { signal });

  // Keep the toggle-all control in sync with the live expand/collapse ratio. A category's open-state change is a DOM-only `details.open` mutation, not a store
  // dispatch, so it does not flow through the projection effect above - the control would otherwise only re-derive its label on option / filter / scope changes and go
  // stale the moment the user expanded or collapsed a single category. We observe the same capture-phase `toggle` the options view listens for (toggle does not bubble)
  // and re-derive the label, covering individual summary clicks, the bulk toggle-all, and saved-state restoration alike, in every engine.
  configTable.addEventListener("toggle", (event) => {

    if(event.target?.matches?.("details.fo-category")) {

      updateToggleAllLabel({ configTable, toggleAll: refs.toggleAll });
    }
  }, { capture: true, signal });

  // Debounce helper; closes over `debounceTimer` and `store`. setTimeout is intentional here over the abort-driven equivalent: clearTimeout is the simplest
  // expression of "cancel the previous timer," with no abort-controller allocation per keystroke.
  function scheduleSearchDispatch(query) {

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {

      store.dispatch({ query, type: "filter:changed" });
    }, SEARCH_DEBOUNCE_MS);
  }
};

// Build the panel DOM and fill the `refs` record with element pointers that update functions consult later. One-time call; idempotent only insofar as it reassigns
// `refs` fields (the panel itself is rebuilt fresh, replacing any prior content).
const buildPanel = ({ refs, root }) => {

  root.textContent = "";
  root.className = "";

  refs.total = createElement("strong", {}, ["0"]);
  refs.modified = createElement("strong", { classList: ["text-warning"] }, ["0"]);
  refs.grouped = createElement("strong", { classList: ["text-info"] }, ["0"]);
  refs.visible = createElement("strong", { classList: ["text-success"] }, ["0"]);

  const statusInfo = createElement("div", {

    id: "statusInfo",
    role: "status",
    style: { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
  }, [
    createElement("span", { classList: ["text-muted"] }, [

      refs.total, " total options · ",
      refs.modified, " modified · ",
      refs.grouped, " grouped · ",
      refs.visible, " visible"
    ])
  ]);

  refs.resetToggle = createElement("button", {

    classList: [ "btn", "btn-xs", "btn-outline-danger", "cursor-pointer", "text-truncate", "user-select-none" ],
    "data-action": "reset-toggle",
    style: { fontSize: "var(--fo-font-size-xs)", marginLeft: "auto", padding: "var(--fo-space-xs) var(--fo-space-sm)" },
    textContent: "Reset...",
    title: "Configuration reset options.",
    type: "button"
  });

  refs.resetDefaults = createElement("button", {

    classList: [ "btn", "btn-xs", "btn-outline-danger", "cursor-pointer", "d-none", "text-truncate", "user-select-none" ],
    "data-action": "reset-defaults",
    style: { fontSize: "var(--fo-font-size-xs)", marginLeft: "auto", padding: "var(--fo-space-xs) var(--fo-space-sm)" },
    textContent: "Reset to Defaults",
    title: "Reset all options to default values.",
    type: "button"
  });

  refs.resetRevert = createElement("button", {

    classList: [ "btn", "btn-xs", "btn-outline-danger", "cursor-pointer", "d-none", "text-truncate", "user-select-none" ],
    "data-action": "reset-revert",
    style: { fontSize: "var(--fo-font-size-xs)", marginLeft: "auto", padding: "var(--fo-space-xs) var(--fo-space-sm)" },
    textContent: "Revert to Saved",
    title: "Revert options to the last saved configuration.",
    type: "button"
  });

  const resetGroup = createElement("div", {

    classList: [ "d-flex", "align-items-center", "gap-1" ],
    role: "group"
  }, [ refs.resetToggle, refs.resetDefaults, refs.resetRevert ]);

  const statusBar = createElement("div", {

    classList: [ "d-flex", "justify-content-between", "align-items-center", "px-2", "py-1", "mb-1", "alert-info", "rounded" ],
    id: "featureStatusBar",
    style: { alignItems: "center", display: "flex", fontSize: "var(--fo-font-size-sm)", gap: "var(--fo-space-sm)" }
  }, [ statusInfo, resetGroup ]);

  // Search input.
  refs.search = createElement("input", {

    autocomplete: "off",
    classList: ["form-control"],
    id: "searchInput",
    placeholder: "Search options...",
    type: "search"
  });

  const searchWrapper = createElement("div", {

    classList: [ "search-input-wrapper", "flex-grow-1" ],
    style: { maxWidth: "400px" }
  }, [createElement("div", { classList: ["input-group"] }, [refs.search])]);

  // Filter pills.
  refs.filterAll = createElement("button", {

    classList: [ "btn", "btn-xs", "btn-primary", "cursor-pointer", "user-select-none" ],
    "data-filter": "all",
    id: "filter-all",
    style: { fontSize: "var(--fo-font-size-xs)", padding: "var(--fo-space-xxs) var(--fo-space-sm)" },
    textContent: "All",
    title: "Show all options.",
    type: "button"
  });

  refs.filterModified = createElement("button", {

    classList: [ "btn", "btn-xs", "btn-outline-secondary", "cursor-pointer", "user-select-none" ],
    "data-filter": "modified",
    id: "filter-modified",
    style: { fontSize: "var(--fo-font-size-xs)", padding: "var(--fo-space-xxs) var(--fo-space-sm)" },
    textContent: "Modified",
    title: "Show only modified options.",
    type: "button"
  });

  const pills = createElement("div", { classList: [ "filter-pills", "d-flex", "gap-1" ] }, [ refs.filterAll, refs.filterModified ]);

  // Expand-all toggle.
  refs.toggleAll = createElement("button", {

    classList: [ "btn", "btn-xs", "btn-outline-secondary" ],
    id: "toggleAllCategories",
    style: {

      display: "inline-block",
      fontFamily: "var(--fo-font-monospace)",
      fontSize: "var(--fo-font-size-xs)",
      padding: "var(--fo-space-xxs) var(--fo-space-sm)",
      textAlign: "center"
    },
    type: "button"
  });

  const controlBar = createElement("div", { classList: ["search-toolbar"] }, [

    createElement("div", { classList: [ "d-flex", "flex-wrap", "gap-2", "align-items-center" ] }, [

      searchWrapper,
      pills,
      createElement("div", { classList: [ "ms-auto", "d-flex", "gap-2" ] }, [refs.toggleAll])
    ])
  ]);

  root.appendChild(statusBar);
  root.appendChild(controlBar);
};

// Update the toggle-all button's glyph, title, and data-action attribute based on the current expand/collapse ratio. When more than half the categories are
// expanded, the button's data-action and title switch to collapse (and its glyph flips); otherwise they switch to expand. Single read pass over the config table;
// no state stored.
const updateToggleAllLabel = ({ configTable, toggleAll }) => {

  if(!toggleAll) {

    return;
  }

  const categories = configTable.querySelectorAll("details[data-category]");
  const expandedCount = [...categories].filter((details) => details.open).length;
  const shouldShowCollapse = expandedCount > (categories.length / 2);

  toggleAll.textContent = shouldShowCollapse ? "▶" : "▼";
  toggleAll.title = shouldShowCollapse ? "Collapse all categories" : "Expand all categories";
  toggleAll.setAttribute("data-action", shouldShowCollapse ? "collapse" : "expand");
};

// Apply the active-state class swap to the filter pills based on the current filter mode. The active pill carries its semantic color class; the inactive pill
// falls back to the outline style. The single source of truth is `state.filter.mode`; the DOM follows.
const updateFilterPillState = ({ filterAll, filterModified, mode }) => {

  if(!filterAll || !filterModified) {

    return;
  }

  const allClasses = (mode === "all") ? [ "btn-primary", "cursor-pointer", "user-select-none" ] : [ "btn-outline-secondary", "cursor-pointer", "user-select-none" ];
  const modClasses = (mode === "modified") ?
    [ "btn-warning", "text-dark", "cursor-pointer", "user-select-none" ] :
    [ "btn-outline-secondary", "cursor-pointer", "user-select-none" ];

  filterAll.className = "";
  filterAll.classList.add("btn", "btn-xs", ...allClasses);

  filterModified.className = "";
  filterModified.classList.add("btn", "btn-xs", ...modClasses);
};

// Handle a click on the search panel. Dispatches by comparing the click target's identity against the ref-held elements. Reset and revert buttons collapse the
// action set back to "Reset..." after dispatching; the reset-toggle button reveals the action set without dispatching.
const handleClick = ({ configTable, event, refs, store }) => {

  const target = event.target;

  if(target === refs.filterAll) {

    store.dispatch({ mode: "all", type: "filter:changed" });

    return;
  }

  if(target === refs.filterModified) {

    store.dispatch({ mode: "modified", type: "filter:changed" });

    return;
  }

  if(target === refs.toggleAll) {

    const shouldExpand = refs.toggleAll.getAttribute("data-action") === "expand";

    for(const details of configTable.querySelectorAll("details[data-category]")) {

      setCategoryExpanded(details, shouldExpand);

      // On bulk expand, synchronously drive the options view's capture-phase `toggle` handler so each category's rows materialize in the SAME layout pass as the open,
      // rather than the open reflowing first and the async native `toggle` task materializing in a second pass. Collapsing the opens and materializations into one
      // settled height change keeps the host's iframe-resize ResizeObserver from cascading ("ResizeObserver loop completed with undelivered notifications"). Row
      // materialization is idempotent, so the native async toggle that follows is a no-op. Collapse needs no synthetic toggle - hiding rows is already one reflow.
      if(shouldExpand) {

        details.dispatchEvent(new Event("toggle"));
      }
    }

    updateToggleAllLabel({ configTable, toggleAll: refs.toggleAll });

    return;
  }

  if(target === refs.resetToggle) {

    refs.resetDefaults.classList.toggle("d-none");
    refs.resetRevert.classList.toggle("d-none");
    refs.resetToggle.textContent = refs.resetDefaults.classList.contains("d-none") ? "Reset..." : "▶";

    return;
  }

  if(target === refs.resetDefaults) {

    store.dispatch({ type: "options:reset" });
    collapseResetGroup(refs);

    return;
  }

  if(target === refs.resetRevert) {

    store.dispatch({ type: "model:reverted" });
    collapseResetGroup(refs);
  }
};

// Collapse the reset button group back to the "Reset..." affordance after a destructive action fires.
const collapseResetGroup = (refs) => {

  refs.resetDefaults.classList.add("d-none");
  refs.resetRevert.classList.add("d-none");
  refs.resetToggle.textContent = "Reset...";
};
