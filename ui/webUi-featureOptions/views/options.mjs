/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/options.mjs: The config table view - categories, lazy rows, tri-state clicks, scope-aware cache, category-state persistence.
 */
"use strict";

import { applyCategoryStates, captureCategoryStates, createElement } from "../utils.mjs";
import { applyRowState, categoryShell, controlValueText, focusControl, optionRow, toggleSecretReveal, triStateTransition,
  valueCommitTransition } from "../rendering.mjs";
import { buildConfigIndex, hasValueContent } from "../../featureOptions.js";
import { projection, scopeCacheKey, scopingControllerId, selectedDeviceId, tablePresentation } from "../selectors.mjs";
import { FeatureOptionsCategoryState } from "../categoryState.mjs";
import { effect } from "../store.mjs";

// The marker class on the nothing-to-list notice. It is what the outgoing capture below recognizes to keep notice DOM out of the DOM cache, so the class is
// structural rather than decorative, and every site that depends on agreeing about it reads one constant.
const DEVICES_NOTICE_CLASS = "fo-devices-notice";

/**
 * Mount the config-table view.
 *
 * The view's responsibilities, in order of complexity:
 *
 *   1. **Initial build** on `model:loaded`: builds the empty config table (no categories yet - those come from the first scope-render).
 *   2. **Scope-aware render** on `scope:changed` (and `model:loaded` / `devices:loaded`, which route through the same pass): detaches the prior view's DOM into
 *      a per-device cache, then puts back whatever the shared {@link tablePresentation} derivation says this surface shows - the view's restored or freshly-built
 *      option table with its persisted category-expansion state, a plugin's nothing-to-list notice, or nothing at all while a connection error owns the frame.
 *   3. **Lazy row materialization**: builds a category's row elements the first time that category needs them, which is either the user's own disclosure toggle or
 *      the first projection pass that finds the category open. A category nobody has opened carries no rows at all.
 *   4. **Per-row updates** on `option:set` / `option:cleared` / `options:reset` / `model:reverted` / `persist:failed`: walks the projection and re-derives each
 *      row's full state (tri-state, value-input, label color, visibility, dependency badge) in place through the shared `applyRowState` writer - attribute and class
 *      swaps on rows that already exist, run through the same writer construction uses, so no path can diverge from it. The walk first builds whatever rows an open
 *      category is missing, so what it derives is always the whole of what that category should be showing.
 *   5. **Visibility updates** on `filter:changed`: the same projection walk, doing the same two jobs - materializing what an open category lacks, then re-deriving
 *      each row, which includes its visibility and the "requires parent" badge.
 *   6. **Controller refresh** on `controllers:loaded`: the same lightweight walk, for the one thing a controllers-only refresh can move - the list a plugin's
 *      choice source derives from the selected controller.
 *   7. **Busy rendering** while a controller's device list is in flight: the table goes inert - every write-capable control disabled, the rows dimmed through a
 *      marker class - so no gesture can land a write at the wrong scope during the window. Derived at every row-state application; see {@link applyBusyState}.
 *   8. **Click delegation** for: row clicks (forward to checkbox), checkbox changes (tri-state transition + action dispatch), value-control changes (value-commit
 *      transition + action dispatch). A gesture that leaves `configuredOptions` unchanged - a rejection, or an arm/disarm - restores the row through the shared
 *      applyRowState writer instead of relying on the projection walk.
 *   9. **Category state persistence**: captures the current view's expand/collapse state on every toggle and on scope-change, restores it when entering a view.
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

      // What this surface presents is a shared derivation rather than a judgment this view makes for itself, so the table and the search panel that filters it
      // cannot disagree about whether there is a table at all. The outgoing capture below is unconditional either way: whatever is leaving is captured on its own
      // terms, and only what arrives depends on the presentation.
      const presentation = tablePresentation(store.state);

      // Capture the OUTGOING view's category state before detaching its DOM. The capture reads details[data-category] open-state from the live DOM.
      if(mountedKey !== undefined) {

        if(configTable.querySelector("details[data-category]")) {

          categoryState.set(mountedKey, captureCategoryStates(configTable));
        }

        // Detach the currently-mounted DOM into the cache. A notice is the one thing that never enters the cache: it is view-mortal, rebuilt from the outcome on
        // every entry, and caching it would let it come back over a key whose real content is a table - the same-key pass that folds an empty outcome caches the
        // optimistic bare-controller table under exactly that key, so the notice must not be allowed to displace it on the way out.
        const detached = [...configTable.children];

        if((detached.length > 0) && !detached[0].matches?.("." + DEVICES_NOTICE_CLASS)) {

          cache.set(mountedKey, detached);
        }

        for(const child of detached) {

          configTable.removeChild(child);
        }
      }

      // Every presentation claims the incoming view as the mounted one, whichever DOM it ends up putting there, so the next pass's outgoing capture keys off the
      // right view either way. Set once here rather than repeated in each branch below.
      mountedKey = newKey;

      switch(presentation.kind) {

        case "empty": {

          /* The controller is reachable and has nothing to list, so its notice takes the place of the option table. The notice is built fresh on every entry rather
           * than cached, because the outcome that justifies it is exactly what a refetch can change: a controller that gains a device stops being empty, and a
           * rebuilt-per-entry notice cannot outlive that. Table DOM cached under this key stays where it is for the same reason, waiting for the day a refetch
           * returns devices.
           *
           * The message is appended as a string child, which the element helper turns into a text node - plugin copy is text the page displays, never markup it
           * executes.
           */
          configTable.appendChild(createElement("div", { classList: [ DEVICES_NOTICE_CLASS, "text-center", "text-muted", "my-4" ] }, [presentation.message]));

          return;
        }

        case "error": {

          /* The connection-error view has taken the frame and owns the message, so the table stays empty beneath it - the outgoing detach above already emptied
           * it, and this branch simply declines to put anything back. Rendering the just-selected controller's full table under an error would offer the options
           * of a controller that never confirmed it could be reached, inviting writes against a scope the page has no settled device list for.
           *
           * Nothing is lost by declining. The outgoing pass cached the view being left, and the recovery transition a clean outcome triggers runs this effect
           * again with an `options` presentation, which restores that cached DOM exactly as any other navigation would.
           */
          return;
        }

        case "options": {

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

          // Restore the incoming view's persisted category state, transparently migrating any data still stored under the legacy key shape (see
          // {@link legacyContextKey}) to the current {@link scopeCacheKey} shape on first read. After a view has been migrated once, its data lives entirely under
          // the current shape and no further legacy lookup is needed.
          const savedStates = restoreLegacyMigrated({ categoryState, newKey, scope: store.state.scope });

          if(savedStates) {

            applyCategoryStates(configTable, savedStates);
          }

          // Apply visibility and per-row state from the current projection.
          applyProjectionToDom({ configTable, state: store.state });

          return;
        }

        default: {

          // Exhaustive switch over the TablePresentation DU - unreachable while the switch and the DU stay in sync. A future variant surfaces here as a runtime
          // throw rather than as a silently blank config table nobody can explain.
          throw new Error("mountOptionsView: unknown table presentation.");
        }
      }
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

  // Controller refresh. A controllers-only refresh moves no option's value and changes no row's identity, so what the walk answers here is one thing: a choice
  // source is handed the selected controller, and a refreshed controller may give it a different list to offer. The lightweight shape is deliberate - the
  // scope-aware render above would detach and reattach every row, blurring whatever control the user has focused and standing down an armed row, for a refresh
  // that asked for none of that.
  effect({

    events: ["controllers:loaded"],
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

    /* Anything that answers a click on its own account is left to answer it: an input, a label, and a dropdown whose click opens its list. A press on one of those
     * would otherwise read as a click on the row's whitespace and flip the very option the user was operating.
     *
     * The `button` token does not carry the list editor's remove control, which never reaches this test at all: the editor answers that press on its own element,
     * deeper in the tree, and removing the item detaches the pressed button along with it - so the row lookup above already reads null by the time the event
     * arrives here, and the guard returns on `!row`. The token stays for the general case it names, which is any button a control puts inside a row and answers
     * without detaching itself.
     */
    if(!row || event.target.closest("input, label, select, button")) {

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

      // Bail if the page has torn down or nothing is currently mounted - a model:loaded reset can set mountedKey back to undefined while this microtask is
      // still pending.
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

// Category-state entries may still be stored on disk under an older key shape: `"Global Options"` for the global view, or the bare device serial for a
// per-device view. This helper maps a scope to that older shape so the restore path can migrate it once. Returns null when no older shape exists for the
// given scope kind - a controller-only view is never persisted under its own key, since the controller link click is transient and resolves immediately
// to a device view, so controller-scope migrations have nothing to read from.
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

// Materialize the rows for a single category, serving every occasion a category comes to need them: the user's own expand, where the rows appear while they
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

// Whether the option table must render inert: the scope names a controller whose settled device list is not what the table is showing. Facts the store
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

  // Every control a gesture could write through goes inert: a row's checkbox and field, a picker's dropdown and member boxes, and the buttons a control builds to
  // edit itself. The secret reveal is pointedly not among them - it reads a value rather than writing one, and it keeps its own lock in applyRowState, which ties
  // it to the field it belongs to rather than to the table's busy window.
  for(const control of root.querySelectorAll("input, select, .fo-list-remove")) {

    control.disabled = true;
  }
};

// Escape a string for use inside a CSS ID selector. We use querySelector against the rows container to find rows by their id (`row-<expandedName>`); option
// names like `Audio.Volume` contain dots that would be interpreted as class selectors without escaping. CSS.escape is the platform-native answer; it is
// unavailable in some DOM environments (including the test harness), so a manual regex fallback covers those cases.
const cssEscape = (value) => ((typeof CSS !== "undefined") && CSS.escape) ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");

// Resolve the row element and its projection entry for any element inside an option row. Shared by handleChange and handleFocusOut (and within handleChange, by
// both its checkbox and value-control branches), so every caller works from the same projection state. The row checkbox's id carries the option's expanded name
// for both, since a value control has no identity of its own; it is addressed by its own class rather than as "the first checkbox in the row", because a checkbox
// group's members are checkboxes too and one of them sits ahead of it in document order for no reason but layout. Returns null when the element sits outside a
// materialized row or the projection no longer carries the option.
//
// The presented view scope is carried back alongside the entry, read off the same projection the entry came from, so a handler re-deriving a single row describes the
// page at exactly the scope the render pass gave every other row.
const rowContext = ({ state, target }) => {

  const row = target.closest(".fo-option-row");
  const categoryName = target.closest("details[data-category]")?.getAttribute("data-category");
  const expandedName = row?.querySelector(".fo-option-checkbox")?.id;

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
// A value commit is recognized by the control's class rather than by an element type. The class is what marks an element as an option's value control; the type is
// presentation, and a masked field wears "password" there, so a type-keyed match would quietly drop every secret option out of the commit path. The match reaches
// through `closest` because a change can originate inside a composite control - one of a checkbox group's boxes - and what commits is the control as a whole.
//
// The tri-state, by contrast, answers only to the row's own checkbox by its class. A group's boxes are checkboxes inside the same row, and routing one of them to
// the tri-state machine would have a member selection flip the option's enabled state.
//
// A gesture that leaves the configured options untouched - an arm or disarm, whose action moves only the store's armedOption, or a gesture that resolves to
// nothing at all - triggers no re-projection walk, so the affected row is re-derived here through the same single writer, against the post-dispatch armed state.
// Reference equality on configuredOptions is the store's documented no-op signal, so this one restore covers every such gesture.
const handleChange = ({ event, store }) => {

  const target = event.target;
  const isValueCommit = target.closest(".fo-option-value") !== null;

  if(!isValueCommit && !target.matches(".fo-option-checkbox")) {

    return;
  }

  const state = store.state;
  const context = rowContext({ state, target });

  if(!context) {

    return;
  }

  const { entry, row, viewScope } = context;
  const control = row.querySelector(".fo-option-value");
  const configIndex = buildConfigIndex(state.catalog, state.configuredOptions);
  const transitionArgs = {

    catalog: state.catalog,
    configIndex,
    control,
    controllerId: scopingControllerId(state),
    deviceId: selectedDeviceId(state),
    entry
  };
  const { action } = isValueCommit ? valueCommitTransition(transitionArgs) :
    triStateTransition({ ...transitionArgs, armed: state.armedOption === entry.expandedName, checkbox: target });

  if(action) {

    store.dispatch(action);
  }

  if(store.state.configuredOptions === state.configuredOptions) {

    const armed = store.state.armedOption === entry.expandedName;

    applyRowState({ armed, entry, row, scopeKind: viewScope });

    // An arming gesture opened the control for the value that will actually enable the option - hand it focus as the affordance for what comes next. Every other
    // no-op keeps focus where it is: a rejected commit means the user just moved on, and a disarm leaves a locked control nothing should focus.
    if(!isValueCommit && armed) {

      focusControl(control);
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

  // The departing element either IS the row's value control or sits inside one, which is how a composite control's own parts - a group's boxes, a list editor's
  // entry field - reach the abandonment rule that a plain field reaches directly.
  const control = target.closest?.(".fo-option-value") ?? null;

  if((state.armedOption === null) || !control) {

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

  if(hasValueContent(controlValueText(control))) {

    return;
  }

  store.dispatch({ type: "option:disarmed" });
  applyRowState({ entry: context.entry, row: context.row, scopeKind: context.viewScope });
};

