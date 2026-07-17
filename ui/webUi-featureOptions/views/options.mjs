/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/options.mjs: The config table view - categories, lazy rows, tri-state clicks, scope-aware cache, category-state persistence.
 */
"use strict";

import { applyCategoryStates, captureCategoryStates } from "../utils.mjs";
import { applyRowState, categoryShell, optionRow, triStateTransition } from "../rendering.mjs";
import { projection, scopeCacheKey, selectedControllerId, selectedDeviceId } from "../selectors.mjs";
import { FeatureOptionsCategoryState } from "../categoryState.mjs";
import { buildConfigIndex } from "../../featureOptions.js";
import { effect } from "../store.mjs";

/**
 * Mount the config-table view.
 *
 * The view's responsibilities, in order of complexity:
 *
 *   1. **Initial build** on `model:loaded`: builds the empty config table (no categories yet - those come from the first scope-render).
 *   2. **Scope-aware render** on `scope:changed`: detaches the prior view's DOM into a per-device cache, restores or builds the new view's DOM, applies persisted
 *      category-expansion state from localStorage.
 *   3. **Lazy row materialization** on category-disclosure toggle: builds row elements only when the user expands a category for the first time.
 *   4. **Per-row updates** on `option:set` / `option:cleared` / `options:reset` / `model:reverted` / `persist:failed`: walks the projection and re-derives each
 *      materialized row's full state (tri-state, value-input, label color, visibility, dependency badge) in place through the shared `applyRowState` writer. No DOM
 *      rebuild - just attribute and class swaps on existing rows, run through the same writer construction uses so the two paths cannot diverge.
 *   5. **Visibility updates** on `filter:changed`: the same projection walk re-derives each row, which includes its visibility and the "requires parent" badge.
 *   6. **Click delegation** for: row clicks (forward to checkbox), checkbox changes (tri-state transition + action dispatch), text-input changes (forward to
 *      checkbox).
 *   7. **Category state persistence**: captures the current view's expand/collapse state on every toggle and on scope-change, restores it when entering a view.
 *
 * The per-device DOM cache lets navigating from device A to device B and back return to A's previously-rendered DOM without re-running the projection or
 * rebuilding the category shells. The cache map's lifetime is the view's lifetime; aborting the signal releases it.
 *
 * @param {Object} args
 * @param {HTMLElement} args.configTable - The `#configTable` element.
 * @param {() => (string | undefined)} args.platform - A thunk returning the Homebridge plugin platform identifier (for localStorage key namespacing). Deferred as a
 *        thunk because the views mount before the session re-syncs, so the identifier is read inside the model:loaded effect - post-sync - rather than at mount.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountOptionsView = ({ configTable, platform, signal, store }) => {

  // Per-view DOM cache, keyed by {@link scopeCacheKey}. Detached DOM lives here while another view is mounted; re-mounting restores from cache when possible.
  const cache = new Map();
  let mountedKey;

  // Per-view category expansion state, persisted via localStorage. The orchestrator writes the user's expand/collapse choices through this object so the disk
  // projection survives page reloads; on re-entry to a view we apply the persisted state so the user's collapse choices stay sticky across sessions. Its localStorage
  // namespace is the platform identifier, which is only correct once the session has re-synced, so it is constructed inside the model:loaded effect below (reading the
  // `platform` thunk post-sync) rather than at mount - the views mount before the sync resolves.
  let categoryState;

  // Rebuild on model:loaded - construct the category-state store from the freshly-synced platform, then clear any prior content and prepare for the first
  // scope-render. The actual category shells come from the scope-render path. This effect is registered before the scope-render effect below, so on a model:loaded
  // dispatch it runs first and `categoryState` is built before that effect reads it.
  effect({

    events: ["model:loaded"],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      categoryState = new FeatureOptionsCategoryState(platform());
      configTable.textContent = "";
      cache.clear();
      mountedKey = undefined;
    },
    signal,
    store
  });

  // Scope-aware render. Detach the prior view's DOM into the cache (keyed by the prior deviceId); restore the new view's DOM from cache or build fresh.
  effect({

    events: [ "model:loaded", "scope:changed", "devices:loaded" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      // {@link scopeCacheKey} is the single identifier for "which view is this." Used as both the DOM-cache map key and the category-state localStorage context
      // key so a navigation and a localStorage lookup observe the same notion of view.
      const newKey = scopeCacheKey(store.state.scope);

      // Capture the OUTGOING view's category state before detaching its DOM. The capture reads details[data-category] open-state from the live DOM.
      if(mountedKey !== undefined) {

        if(configTable.querySelector("details[data-category]")) {

          categoryState.set(mountedKey, captureCategoryStates(configTable));
        }

        // Detach the currently-mounted DOM into the cache.
        const detached = [...configTable.children];

        if(detached.length > 0) {

          cache.set(mountedKey, detached);
        }

        for(const child of detached) {

          configTable.removeChild(child);
        }
      }

      // Attach the cached DOM for the new view, if any. Otherwise build the category shells fresh from the projection.
      const cached = cache.get(newKey);

      if(cached) {

        for(const child of cached) {

          configTable.appendChild(child);
        }

        cache.delete(newKey);
      } else {

        buildCategoryShells({ configTable, state: store.state });
      }

      mountedKey = newKey;

      // Restore the incoming view's persisted category state, transparently migrating any data still stored under the legacy key shape (see
      // {@link legacyContextKey}) to the current {@link scopeCacheKey} shape on first read. After a view has been migrated once, its data lives entirely under
      // the current shape and no further legacy lookup is needed.
      const savedStates = restoreLegacyMigrated({ categoryState, newKey, scope: store.state.scope });

      if(savedStates) {

        applyCategoryStates(configTable, savedStates);
      }

      // Apply visibility and per-row state from the current projection.
      applyProjectionToDom({ configTable, state: store.state });
    },
    signal,
    store
  });

  // Per-option mutations: scope-aware cache invalidation. Only entries that inherit from the mutation's scope are dropped; unrelated cached views remain
  // identity-stable across the mutation. The handler reads the action's `args.id` field as the mutation's scope marker - undefined for a global mutation, otherwise a
  // controller or device serial. The immediate-run case (action === undefined) is the registration-time fire with no triggering action; the cache has nothing to
  // invalidate then and the projection has nothing new to apply, so we exit early.
  effect({

    events: [ "option:cleared", "option:set" ],
    fn: (action) => {

      if(!action || (store.state.status.kind === "loading")) {

        return;
      }

      invalidateCacheForMutation({ action, cache, controllers: store.state.controllers });
      applyProjectionToDom({ configTable, state: store.state });
    },
    signal,
    store
  });

  // Global-undo actions: wholesale state replacement. Every cached view's resolved values may have changed at any scope, so the only correct policy is to drop
  // every entry. The currently-mounted view re-renders in place via the projection walk; the cache rebuilds lazily on subsequent navigations.
  effect({

    events: [ "model:reverted", "options:reset", "persist:failed" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      cache.clear();
      applyProjectionToDom({ configTable, state: store.state });
    },
    signal,
    store
  });

  // Filter updates - cheap visibility refresh, no per-row state change.
  effect({

    events: ["filter:changed"],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      applyProjectionToDom({ configTable, state: store.state });
    },
    signal,
    store
  });

  // Category-disclosure toggle (capture-phase because `toggle` does not bubble). Materializes rows lazily on first expand; coalesces post-toggle persistence
  // into a microtask so bulk toggles (expand-all / collapse-all) produce one localStorage write.
  let pendingPostToggleSync = null;

  configTable.addEventListener("toggle", (event) => {

    const details = event.target;

    if(!(details.matches?.("details.fo-category"))) {

      return;
    }

    if(details.open) {

      ensureRowsRendered({ details, state: store.state });
    }

    schedulePostToggleSync();
  }, { capture: true, signal });

  // Click delegation for rows. Forwards to the checkbox so a click in the row's whitespace toggles the option.
  configTable.addEventListener("click", (event) => {

    const row = event.target.closest(".fo-option-row");

    if(!row || event.target.closest("input, label")) {

      return;
    }

    row.querySelector("input[type='checkbox']")?.click();
  }, { signal });

  // Change delegation for checkboxes and text inputs. Checkbox change runs the tri-state transition and dispatches the resulting action; text input change
  // re-fires as a checkbox change so the same path handles both.
  configTable.addEventListener("change", (event) => handleChange({ event, store }), { signal });

  // Coalesce post-toggle work into a single microtask. Multiple synchronous toggles (bulk expand-all, saved-state restore) all settle to one persistence write.
  function schedulePostToggleSync() {

    if(pendingPostToggleSync) {

      return;
    }

    pendingPostToggleSync = Promise.resolve().then(() => {

      pendingPostToggleSync = null;

      if(signal.aborted || (mountedKey === undefined)) {

        return;
      }

      if(configTable.querySelector("details[data-category]")) {

        categoryState.set(mountedKey, captureCategoryStates(configTable));
      }
    });
  }
};

// Scope-aware cache invalidation for a per-option mutation. The action's `args.id` field carries the mutation's scope marker (the persisted entry-string format
// encodes scope by serial), so we distinguish it by matching against the controllers list:
//
//   - `id` undefined - global-scope mutation. Every cached view inherits from global. Drop every entry.
//   - `id` matches a controller's serial - controller-scope mutation. Every cached device-view under this controller inherits from it. Drop entries whose key
//     has the `device:<id>/` prefix; preserve the global entry and other controllers' devices.
//   - `id` matches a device's serial (not a controller) - device-scope mutation. No cached view inherits from a leaf device; the mutated device itself is the
//     currently mounted view (not in the cache). No cache action required.
//
// The prefix match exploits the {@link scopeCacheKey} contract: device-view keys carry their controller's serial in their first path segment, so an O(N) walk
// over the cache invalidates exactly the device-under-controller subtree without a separate controller-to-devices lookup.
const invalidateCacheForMutation = ({ action, cache, controllers }) => {

  const id = action.args.id;

  if(id === undefined) {

    cache.clear();

    return;
  }

  if(controllers.some((c) => c.serialNumber === id)) {

    const prefix = "device:" + id + "/";

    for(const key of cache.keys()) {

      if(key.startsWith(prefix)) {

        cache.delete(key);
      }
    }

    return;
  }

  // Device-scope mutation: no cache action. The mounted device is not in the cache, and no other cached view inherits from a leaf device.
};

// The pre-reactive-store architecture wrote category-state entries under context keys of shape `"Global Options"` (for the global view) or the bare device serial
// (for any per-device view). The reactive-store refactor unified these under {@link scopeCacheKey}'s output ("global", "controller:X", "device:X/Y"). This helper
// maps a scope back to the legacy key shape it would have been written under so the restore path can do a one-time migration. Returns null when no legacy shape
// existed for the given scope kind - the prior architecture never persisted a controller-only view (the controller link click was transient, resolving immediately
// to a device-view), so controller-scope migrations have no source to read from.
const legacyContextKey = (scope) => {

  switch(scope.kind) {

    case "global":

      return "Global Options";

    case "device":

      return scope.deviceId;

    case "controller":

      return null;

    default:

      // Exhaustive switch over the Scope DU - a future variant addition surfaces here as a runtime throw rather than a silent fallthrough that would skip migration.
      throw new Error("legacyContextKey: unknown scope kind.");
  }
};

// Read persisted category state for the view identified by {@link newKey}, transparently migrating data found under the legacy key shape. The lookup tries the
// new key first (fast path for already-migrated data); on miss, it falls back to {@link legacyContextKey} and, if a legacy entry exists, atomically rewrites it
// under the new key and deletes the legacy entry. After every visited view has been migrated once, the legacy keys are gone from disk and no further fallback
// lookup yields a result.
const restoreLegacyMigrated = ({ categoryState, newKey, scope }) => {

  const direct = categoryState.get(newKey);

  if(direct) {

    return direct;
  }

  const legacyKey = legacyContextKey(scope);

  if(legacyKey === null) {

    return undefined;
  }

  const legacy = categoryState.get(legacyKey);

  if(!legacy) {

    return undefined;
  }

  // Migrate atomically: write under new key, drop legacy. The next visit to this view reads directly from the new key (the fast path above).
  categoryState.set(newKey, legacy);
  categoryState.delete(legacyKey);

  return legacy;
};

// Build the empty category shells for every active category in the projection. Rows materialize lazily on first expand via {@link ensureRowsRendered}.
const buildCategoryShells = ({ configTable, state }) => {

  const p = projection(state);
  const fragment = document.createDocumentFragment();
  const scopeKind = state.scope.kind;

  for(const { category } of p.categories) {

    fragment.appendChild(categoryShell({ category, scopeKind }));
  }

  configTable.appendChild(fragment);
};

// Materialize the rows for a single category. Guarded by dataset.rowsRendered - re-opening an already-built category is a no-op for materialization.
const ensureRowsRendered = ({ details, state }) => {

  if(details.dataset.rowsRendered === "true") {

    return;
  }

  const categoryName = details.getAttribute("data-category");
  const p = projection(state);
  const categoryProjection = p.categories.find((c) => c.name === categoryName);

  if(!categoryProjection) {

    return;
  }

  const rowsContainer = details.querySelector(".fo-category-rows");

  if(!rowsContainer) {

    return;
  }

  const fragment = document.createDocumentFragment();
  const deviceId = selectedDeviceId(state);
  const scopeKind = state.scope.kind;

  for(const entry of categoryProjection.entries) {

    fragment.appendChild(optionRow({ deviceId, entry, scopeKind }));
  }

  rowsContainer.appendChild(fragment);
  details.dataset.rowsRendered = "true";

  // optionRow applies each row's full state through applyRowState at construction, so a freshly-materialized category arrives correct from its first render - no
  // separate post-materialization apply pass is needed, and there is no window where a row exists without its derived state.
};

// Walk the projection and re-derive every materialized row's state in place. Categories with no materialized rows are skipped (rows materialize lazily on expand, so
// an unexpanded category has none to update). For each materialized category we set the category-level visibility, then re-derive each row through the shared
// applyRowState writer - the same writer construction uses - so a mutation re-checks, re-colors, re-values, and re-hides every affected row without a DOM rebuild.
const applyProjectionToDom = ({ configTable, state }) => {

  const p = projection(state);
  const scopeKind = state.scope.kind;

  for(const categoryProjection of p.categories) {

    const details = configTable.querySelector("details[data-category=\"" + categoryProjection.name + "\"]");

    if(!details) {

      continue;
    }

    // Category-level visibility: hide the entire category when the projection has no visible entries.
    details.classList.toggle("fo-hidden", !categoryProjection.hasVisible);

    if(details.dataset.rowsRendered !== "true") {

      continue;
    }

    const rowsContainer = details.querySelector(".fo-category-rows");

    if(!rowsContainer) {

      continue;
    }

    for(const entry of categoryProjection.entries) {

      const row = rowsContainer.querySelector("#row-" + cssEscape(entry.expandedName));

      if(row) {

        applyRowState({ entry, row, scopeKind });
      }
    }
  }
};

// Escape a string for use inside a CSS ID selector. We use querySelector against the rows container to find rows by their id (`row-<expandedName>`); option
// names like `Audio.Volume` contain dots that would be interpreted as class selectors without escaping. CSS.escape is the platform-native answer; it is
// unavailable in some DOM environments (including the test harness), so a manual regex fallback covers those cases.
const cssEscape = (value) => ((typeof CSS !== "undefined") && CSS.escape) ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");

// Handle a change event on the config table. Checkboxes get the tri-state transition; text inputs re-fire as a checkbox change so the same path handles both.
const handleChange = ({ event, store }) => {

  const target = event.target;

  if(target.matches("input[type='text']")) {

    target.closest(".fo-option-row")?.querySelector("input[type='checkbox']")?.dispatchEvent(new Event("change", { bubbles: true }));

    return;
  }

  if(!target.matches("input[type='checkbox']")) {

    return;
  }

  const row = target.closest(".fo-option-row");
  const categoryName = target.closest("details[data-category]")?.getAttribute("data-category");

  if(!row || !categoryName) {

    return;
  }

  const expandedName = target.id;
  const state = store.state;
  const p = projection(state);
  const categoryProjection = p.categories.find((c) => c.name === categoryName);
  const entry = categoryProjection?.entries.find((e) => e.expandedName === expandedName);

  if(!entry) {

    return;
  }

  // Run the pure transition to compute the action to dispatch. The DOM is not updated here: dispatching drives the reactive re-projection, which re-derives this row
  // (and any others the mutation affects) through applyRowState against the post-dispatch projection. One DOM-writing path - the same one construction uses - rather
  // than an imperative apply here plus a re-derive on update that could drift apart.
  const inputValue = row.querySelector("input[type='text']");
  const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);
  const { action } = triStateTransition({

    catalog: state.catalog,
    checkbox: target,
    configIndex,
    controllerId: selectedControllerId(state),
    deviceId: selectedDeviceId(state),
    entry,
    inputValue
  });

  store.dispatch(action);
};

