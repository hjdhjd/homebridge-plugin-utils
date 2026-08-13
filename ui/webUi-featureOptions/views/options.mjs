/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/options.mjs: The config table view - categories, lazy rows, tri-state clicks, scope-aware cache, category-state persistence.
 */
"use strict";

import { applyCategoryStates, captureCategoryStates } from "../utils.mjs";
import { applyRowState, categoryShell, optionRow, toggleSecretReveal, triStateTransition, valueCommitTransition } from "../rendering.mjs";
import { buildConfigIndex, hasValueContent } from "../../featureOptions.js";
import { projection, scopeCacheKey, scopingControllerId, selectedDeviceId } from "../selectors.mjs";
import { FeatureOptionsCategoryState } from "../categoryState.mjs";
import { effect } from "../store.mjs";

/**
 * Mount the config-table view.
 *
 * The view's responsibilities, in order of complexity:
 *
 *   1. **Initial build** on `model:loaded`: builds the empty config table (no categories yet - those come from the first scope-render).
 *   2. **Scope-aware render** on `scope:changed`: detaches the prior view's DOM into a per-device cache, restores or builds the new view's DOM, applies persisted
 *      category-expansion state from localStorage.
 *   3. **Lazy row materialization**: builds a category's row elements the first time that category needs them, which is either the user's own disclosure toggle or
 *      the first projection pass that finds the category open. A category nobody has opened carries no rows at all.
 *   4. **Per-row updates** on `option:set` / `option:cleared` / `options:reset` / `model:reverted` / `persist:failed`: walks the projection and re-derives each
 *      row's full state (tri-state, value-input, label color, visibility, dependency badge) in place through the shared `applyRowState` writer - attribute and class
 *      swaps on rows that already exist, run through the same writer construction uses so the two paths cannot diverge. The walk first builds whatever rows an open
 *      category is missing, so what it derives is always the whole of what that category should be showing.
 *   5. **Visibility updates** on `filter:changed`: the same projection walk, doing the same two jobs - materializing what an open category lacks, then re-deriving
 *      each row, which includes its visibility and the "requires parent" badge.
 *   6. **Busy rendering** while a controller's device list is in flight: the table goes inert - every input disabled, the rows dimmed through a marker class - so
 *      no gesture can land a write at the wrong scope during the window. Derived at every row-state application; see {@link applyBusyState}.
 *   7. **Click delegation** for: row clicks (forward to checkbox), checkbox changes (tri-state transition + action dispatch), text-input changes (value-commit
 *      transition + action dispatch). A gesture the model rejects restores the row through the shared applyRowState writer instead of dispatching.
 *   8. **Category state persistence**: captures the current view's expand/collapse state on every toggle and on scope-change, restores it when entering a view.
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

  // Filter updates. A filter change moves no option's value, so what the walk answers here is purely the derived presentation: which rows show, and which wear the
  // dependency badge.
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

  // Re-evaluate the busy state when a device fetch is recorded. The scope-render effect above cannot answer this on its own: a sidebar click dispatches its
  // optimistic scope:changed BEFORE the devices:requested that records the fetch, and dispatch is fully synchronous, so on a revisit to a controller whose list is
  // already on screen the render pass sees that list still naming this controller with no fetch outstanding and reads the table as settled. The fetch record is
  // what makes that window observable. One table-wide application is the whole response - no projection walk, no DOM round-trip, which is why this is its own
  // effect rather than another event on the scope-render's list.
  effect({

    events: ["devices:requested"],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      applyBusyState({ configTable, state: store.state });
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

      // Rows born from an expand never pass through the projection walk at birth, so the freshly materialized subtree takes the busy state here. It is derived
      // again rather than read off the table's marker class, so one derivation answers every application.
      applyBusyState({ configTable, root: details, state: store.state });
    }

    schedulePostToggleSync();
  }, { capture: true, signal });

  // Click delegation for rows. Forwards to the checkbox so a click in the row's whitespace toggles the option.
  configTable.addEventListener("click", (event) => {

    // A secret option's reveal toggle is answered here and goes no further. It is neither an input nor a label, so the row forward below would otherwise read a
    // click on it as a click on the row's whitespace and flip the option the user was only trying to read. The lookup starts from the event target rather than the
    // button because the glyph inside the button is what a pointer actually lands on.
    const secretToggle = event.target.closest(".fo-secret-toggle");

    if(secretToggle) {

      toggleSecretReveal(secretToggle);

      return;
    }

    const row = event.target.closest(".fo-option-row");

    if(!row || event.target.closest("input, label")) {

      return;
    }

    row.querySelector("input[type='checkbox']")?.click();
  }, { signal });

  // Change delegation for checkboxes and value inputs. Checkbox change runs the tri-state transition and dispatches the resulting action; value input change
  // re-fires as a checkbox change so the same path handles both.
  configTable.addEventListener("change", (event) => handleChange({ event, store }), { signal });

  // Stand an armed row down when focus leaves it without a value. The armed state exists to take the first value, so focus departing the row with the input
  // still empty is the abandonment gesture, and the row snaps back to unchecked-and-locked through the same writer every state change uses. Focus moving WITHIN
  // the row - onto its own checkbox above all, whose click gesture must adjudicate the uncheck itself - is deliberately not an abandonment; nor is a
  // commit-carrying blur, whose change event has already disarmed through the store by the time focusout fires (change precedes blur in the event order).
  configTable.addEventListener("focusout", (event) => handleFocusOut({ event, store }), { signal });

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

// Build the empty category shells for every active category in the projection. Rows materialize lazily via {@link ensureRowsRendered}, at whichever comes first of
// a user's expand and the projection pass that finds the category open.
const buildCategoryShells = ({ configTable, state }) => {

  const p = projection(state);
  const fragment = document.createDocumentFragment();
  const scopeKind = p.viewScope;

  for(const { category } of p.categories) {

    fragment.appendChild(categoryShell({ category, scopeKind }));
  }

  configTable.appendChild(fragment);
};

// Materialize the rows for a single category, serving the two occasions a category comes to need them: the user's own expand, where the rows appear while they
// watch, and the projection walk, which materializes any category it finds open. Guarded by dataset.rowsRendered, so a call for an already-built category does
// nothing at all.
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
  const scopeKind = p.viewScope;

  for(const entry of categoryProjection.entries) {

    fragment.appendChild(optionRow({ armed: state.armedOption === entry.expandedName, deviceId, entry, scopeKind }));
  }

  rowsContainer.appendChild(fragment);
  details.dataset.rowsRendered = "true";

  // optionRow applies each row's full state through applyRowState at construction, so a freshly-materialized category arrives correct from its first render - no
  // separate post-materialization apply pass is needed, and there is no window where a row exists without its derived state.
};

/* Walk the projection and bring the table's presentation into agreement with the state: every open category holds its rows, and every row holds its derived state.
 *
 * The walk sets each category's visibility, then re-derives each of its rows through the shared applyRowState writer - the same writer construction uses - so a
 * mutation re-checks, re-colors, re-values, and re-hides every affected row without a DOM rebuild.
 *
 * Rows materialize lazily, so a category no one has opened holds none and has nothing to re-derive...but an OPEN category holding no rows is the presentation
 * disagreeing with the state, a category the user is looking into and seeing nothing inside. The walk materializes that category here and then applies its row
 * state in the same pass, which is what lets the guarantee stand on its own: every render pass ends in this walk, so an open category takes its rows from the very
 * next pass whatever put it in that state and whether or not the `toggle` event that carries a user's own expand ever reached its listener.
 */
const applyProjectionToDom = ({ configTable, state }) => {

  const p = projection(state);
  const scopeKind = p.viewScope;

  for(const categoryProjection of p.categories) {

    const details = configTable.querySelector("details[data-category=\"" + categoryProjection.name + "\"]");

    if(!details) {

      continue;
    }

    // Category-level visibility: hide the entire category when the projection has no visible entries.
    details.classList.toggle("fo-hidden", !categoryProjection.hasVisible);

    // A category with no rows yet is a decision rather than an automatic skip. A closed one is the lazy case and stays empty until something opens it; an open one
    // is materialized right here and falls through to the row-state application below, so it leaves this pass as correct as any category that was already built. A
    // category the current projection does not carry materializes nothing and keeps its flag unset, so the pass that follows a projection catching up retries it.
    if(details.dataset.rowsRendered !== "true") {

      if(!details.open) {

        continue;
      }

      ensureRowsRendered({ details, state });
    }

    const rowsContainer = details.querySelector(".fo-category-rows");

    if(!rowsContainer) {

      continue;
    }

    for(const entry of categoryProjection.entries) {

      const row = rowsContainer.querySelector("#row-" + cssEscape(entry.expandedName));

      if(row) {

        applyRowState({ armed: state.armedOption === entry.expandedName, entry, row, scopeKind });
      }
    }
  }

  // Re-apply the busy state last. The walk above re-derived every materialized row from the projection alone, which knows nothing about a device fetch, so an open
  // window would otherwise hand every row it touched its interactivity back - typing in the search box mid-fetch is the concrete case. Every re-derivation effect
  // funnels through here, so this one application keeps all of them correct without any of them knowing the busy state exists.
  applyBusyState({ configTable, state });
};

// Whether the option table must render inert: the scope names a controller whose settled device list is not what the table is showing. Two facts the store
// already carries answer that together - the loaded list belongs to a different controller, which is a first visit, or a fetch naming this controller is still
// outstanding, which is a revisit, where the sidebar click refetches while the list already on screen still names the same controller. Every other scope kind
// reads false: a global or device scope keys its writes from the selection itself and has no in-flight window to protect.
const isTableBusy = (state) => {

  if(state.scope.kind !== "controller") {

    return false;
  }

  const controllerId = state.scope.controllerId;

  return (state.devicesControllerId !== controllerId) || (state.devicesRequest?.controllerId === controllerId);
};

/* Apply the table's busy state over a subtree, deriving it fresh from the store on every call.
 *
 * An option row keys its write off the selected device, and a controller scope has none...so a gesture taken while that controller's device list is still in
 * flight would record the user's choice at global scope while the sidebar reads as the controller. Rendering the table inert for the window is what puts that
 * write out of reach, and the marker class carries the dim that tells the user why nothing answers.
 *
 * Only the disabling half is written here. Handing a row its interactivity back belongs to {@link applyRowState}, whose derivation from the projection already
 * answers which controls a settled row locks - an inheriting row's field, a parent-disabled checkbox - so an unconditional re-enable here would unlock exactly
 * the rows that rule keeps shut. Deriving at every application rather than recording busy-ness on the nodes is also what keeps the DOM cache honest: a view
 * detached mid-window comes back inert while the window is still open and comes back live once it has closed, with nothing stale baked into the cached nodes.
 *
 * The two gesture handlers need no busy awareness of their own. A disabled input originates neither a change nor a focusout, and the one event that can still
 * arrive - the focusout a browser fires when focus sits on an input at the instant it is disabled - carries no write with it: the same gesture's scope:changed
 * pass nulls armedOption in the reducer before any subscriber re-derives a row, so {@link handleFocusOut} finds no armed row and returns on its first guard. No
 * resulting write is possible, which is a stronger claim than no event firing and the one this rests on.
 */
const applyBusyState = ({ configTable, root = configTable, state }) => {

  const busy = isTableBusy(state);

  configTable.classList.toggle("fo-options-busy", busy);

  if(!busy) {

    return;
  }

  for(const input of root.querySelectorAll("input")) {

    input.disabled = true;
  }
};

// Escape a string for use inside a CSS ID selector. We use querySelector against the rows container to find rows by their id (`row-<expandedName>`); option
// names like `Audio.Volume` contain dots that would be interpreted as class selectors without escaping. CSS.escape is the platform-native answer; it is
// unavailable in some DOM environments (including the test harness), so a manual regex fallback covers those cases.
const cssEscape = (value) => ((typeof CSS !== "undefined") && CSS.escape) ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");

// Resolve the row element and its projection entry for any input element inside an option row. Shared by the two gesture handlers in handleChange so the checkbox
// and the value input work from the same projection state. The checkbox's id carries the option's expanded name for both, since the value input has no identity of
// its own. Returns null when the element sits outside a materialized row or the projection no longer carries the option.
//
// The presented view scope rides back alongside the entry, read off the same projection the entry came from, so a handler re-deriving a single row describes the
// page at exactly the scope the render pass gave every other row.
const rowContext = ({ state, target }) => {

  const row = target.closest(".fo-option-row");
  const categoryName = target.closest("details[data-category]")?.getAttribute("data-category");
  const expandedName = row?.querySelector("input[type='checkbox']")?.id;

  if(!row || !categoryName || !expandedName) {

    return null;
  }

  const p = projection(state);
  const categoryProjection = p.categories.find((c) => c.name === categoryName);
  const entry = categoryProjection?.entries.find((e) => e.expandedName === expandedName);

  return entry ? { entry, row, viewScope: p.viewScope } : null;
};

// Handle a change event on the config table. Checkboxes run the tri-state transition; value inputs run the value-commit transition. Either way the pure state
// machine computes the action, the dispatch drives the reactive re-projection, and applyRowState re-derives the affected rows - one DOM-writing path, the same
// one construction uses, rather than an imperative apply here plus a re-derive on update that could drift apart.
//
// A value input is recognized by its class rather than by its type attribute. The class is what marks the element as an option's value field; the type is
// presentation, and a masked field wears "password" there, so a type-keyed match would quietly drop every secret option out of the commit path.
//
// A gesture that leaves the configured options untouched - an arm or disarm, whose action moves only the store's armedOption, or a gesture that resolves to
// nothing at all - triggers no re-projection walk, so the affected row is re-derived here through the same single writer, against the post-dispatch armed state.
// Reference equality on configuredOptions is the store's documented no-op signal, so this one restore covers every such gesture.
const handleChange = ({ event, store }) => {

  const target = event.target;
  const isValueCommit = target.matches("input.fo-option-value");

  if(!isValueCommit && !target.matches("input[type='checkbox']")) {

    return;
  }

  const state = store.state;
  const context = rowContext({ state, target });

  if(!context) {

    return;
  }

  const { entry, row, viewScope } = context;
  const inputValue = row.querySelector("input.fo-option-value");
  const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);
  const transitionArgs = {

    catalog: state.catalog,
    configIndex,
    controllerId: scopingControllerId(state),
    deviceId: selectedDeviceId(state),
    entry,
    inputValue
  };
  const { action } = isValueCommit ? valueCommitTransition(transitionArgs) :
    triStateTransition({ ...transitionArgs, armed: state.armedOption === entry.expandedName, checkbox: target });

  if(action) {

    store.dispatch(action);
  }

  if(store.state.configuredOptions === state.configuredOptions) {

    const armed = store.state.armedOption === entry.expandedName;

    applyRowState({ armed, entry, row, scopeKind: viewScope });

    // An arming gesture opened the input for the value that will actually enable the option - hand it focus as the affordance for what comes next. Every other
    // no-op keeps focus where it is: a rejected input commit means the user just moved on, and a disarm leaves a locked input nothing should focus.
    if(!isValueCommit && armed) {

      inputValue?.focus();
    }
  }
};

// Handle a focusout event on the config table: the armed-row abandonment path. An armed row exists to take its first value, so focus leaving the row while the
// input is still empty stands it down. The event fires for two different departures: focus moving on within the page, and the WINDOW itself losing focus to a
// tab flip, an app switch, or a click on the host's chrome. Only the in-page move is an abandonment, and the document's focus state at dispatch time is what
// tells the two apart...a focusout arriving while the document still holds focus is a move within the page, while one arriving after that focus is gone belongs
// to the departing window, so an armed row survives that trip and is still armed when the user returns. Two in-page departures are deliberately NOT
// abandonments either: focus settling elsewhere within the same row (the checkbox's own click gesture adjudicates the uncheck itself), and a commit-carrying
// blur (its change event already committed and disarmed through the store before focusout fired).
const handleFocusOut = ({ event, store }) => {

  const state = store.state;
  const target = event.target;

  if((state.armedOption === null) || !target.matches?.("input.fo-option-value")) {

    return;
  }

  const context = rowContext({ state, target });

  if(!context || (context.entry.expandedName !== state.armedOption)) {

    return;
  }

  if(event.relatedTarget && context.row.contains(event.relatedTarget)) {

    return;
  }

  if(!document.hasFocus()) {

    return;
  }

  if(hasValueContent(target.value)) {

    return;
  }

  store.dispatch({ type: "option:disarmed" });
  applyRowState({ entry: context.entry, row: context.row, scopeKind: context.viewScope });
};

