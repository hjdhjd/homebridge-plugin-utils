/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/keyboard.mjs: Global keyboard shortcuts for the feature options webUI.
 */
"use strict";

/**
 * Register the global keyboard shortcuts for the feature options webUI.
 *
 * Two shortcuts:
 *
 *   - **Cmd/Ctrl + F** focuses the search input. Preempts the browser's native find behavior so users can search the feature options rather than the page's raw
 *     text. Only acts when the search panel is mounted and visible - otherwise falls through to the browser's default handling.
 *   - **Escape on the search input** clears the search query. Dispatches `filter:changed` with an empty query so subscribers (the search view, projection,
 *     status bar) re-derive from the unfiltered state.
 *
 * Both listeners are bound to the supplied AbortSignal; aborting cleanly removes them.
 *
 * @param {Object} args
 * @param {AbortSignal} args.signal - Lifecycle signal. Aborting removes the listeners.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store the Escape handler dispatches against.
 */
export const registerKeyboardEffect = ({ signal, store }) => {

  if(signal.aborted) {

    return;
  }

  document.addEventListener("keydown", (event) => {

    // Cmd/Ctrl + F: focus the search input when the search panel is visible. The visibility check uses the DOM directly because "is the search panel mounted and
    // visible right now?" is genuinely a DOM-state question - state.status doesn't carry it (the search view's visibility is a function of the view's mount
    // status, not the store's lifecycle).
    if((event.ctrlKey || event.metaKey) && (event.key === "f")) {

      const searchInput = document.getElementById("searchInput");
      const searchPanel = document.getElementById("search");

      if(!searchInput || !searchPanel || (searchPanel.style.display === "none")) {

        return;
      }

      event.preventDefault();
      searchInput.focus();
      searchInput.select();

      return;
    }

    // Escape on the search input: clear the query. Pre-condition: the focused element IS the search input (event.target's id), so the shortcut only fires when the
    // user is actively typing in search. The id check is sufficient: the document-level listener receives bubbled events from any element, but only the search
    // input has id="searchInput" in the page DOM.
    if((event.key === "Escape") && (event.target?.id === "searchInput")) {

      event.target.value = "";
      store.dispatch({ query: "", type: "filter:changed" });
    }
  }, { signal });
};
