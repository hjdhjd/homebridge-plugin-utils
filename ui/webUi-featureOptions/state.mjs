/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/state.mjs: State shape, action vocabulary, and reducer for the feature options webUI.
 */
"use strict";

import { applyClearOption, applySetOption, buildCatalogIndex } from "../featureOptions.js";

/**
 * State shape, action vocabulary, and reducer for the feature options webUI.
 *
 * This module is the SSOT for what state the UI carries and how that state transitions. Every dispatch lands here; every component reads from {@link FeatureOptionsState}
 * and derives its view via selectors. Discriminated unions encode the variant types the UI moves through, each listed below:
 *
 *   - {@link Scope} - `{kind: "global"}` | `{kind: "controller", controllerId}` | `{kind: "device", controllerId, deviceId}`. The selection pointer. Discriminated
 *     because each kind carries different data; merging them into a flat record would smear the guarantees across two fields and force consumers to recover the
 *     kind via predicates.
 *   - {@link LifecycleStatus} - `loading` | `ready` | `persisting` | `persist-error` | `connection-error`. The page-state pointer. Discriminated because the
 *     variants carry different per-state payloads (a snapshot when persisting, an error when failed, a message when the connection broke).
 *   - {@link Catalog} - `CatalogIndex` (from featureOptions.ts) extended with plugin-provided validator callbacks. Bundled as one value because both the index and
 *     the validators are plugin-provided immutable config moving together; splitting them would force every consumer that needs both to take two parameters.
 *
 * The action vocabulary names past-tense domain events. Each action below corresponds to a {@link reducer} case and to at least one effect or view subscriber.
 * Names use a `domain:event` shape so they group naturally and read as natural language at dispatch sites.
 *
 *   - `model:loaded` - first load: catalog, configuredOptions, controllers, mode are populated; status transitions to ready.
 *   - `controllers:loaded` - controllers-only refresh (reducer + nav subscriber wired) that no code currently dispatches; the retry path re-runs the full `model:loaded`.
 *   - `devices:requested` - a device fetch is beginning: mints the next fetch sequence into state and records it as the pending request, so the outcome that
 *     eventually answers it can be told apart from a superseded one.
 *   - `devices:loaded` - a device fetch's outcome - its device list and connection error - stamped with the sequence its request minted. Applies only when it answers
 *     the pending request; a superseded or seq-less outcome is dropped at this chokepoint. A non-empty error also transitions status to connection-error.
 *   - `scope:changed` - selection pointer moved (global / controller / device).
 *   - `option:set` - single option enabled/disabled (with optional value) at some scope.
 *   - `option:cleared` - single option removed at some scope.
 *   - `options:reset` - every configured option dropped (reset to defaults).
 *   - `model:reverted` - configuredOptions restored to the at-show() snapshot.
 *   - `filter:changed` - search query and/or filter mode updated.
 *   - `persist:started` - persist call entering flight; status becomes persisting.
 *   - `persist:succeeded` - persist call landed on disk; anchor updated, status returns to ready.
 *   - `persist:failed` - final-attempt failure (no superseding mutation); configuredOptions rolls back to anchor, status becomes persist-error.
 *   - `connection:error` - controller unreachable on the current view; status becomes connection-error with the user-facing message.
 *
 * The reducer is pure: `(state, action) => state`. Unchanged slices retain their reference across dispatches (structural sharing), so memoized selectors that
 * depend on a slice return cached results until that specific slice changes. Unknown action types throw - silently ignoring them would let typo bugs escape into
 * production where they manifest as missing UI updates.
 *
 * @module
 */

/**
 * @typedef {Object} Controller
 * @property {string} address - The network address of the controller.
 * @property {string} name - The display name of the controller.
 * @property {string} serialNumber - The unique serial number of the controller.
 */

/**
 * @typedef {Object} Device
 * @property {string} firmwareRevision - The firmware version of the device.
 * @property {string} manufacturer - The manufacturer of the device.
 * @property {string} model - The model identifier of the device.
 * @property {string} name - The display name of the device.
 * @property {string} serialNumber - The unique serial number of the device.
 * @property {string} [sidebarGroup] - Optional grouping identifier for sidebar organization.
 */

/**
 * @typedef {Object} Validators
 * @property {(device: Device) => boolean} isController - Predicate for "is this device a controller-as-device" (drives controller-vs-device scope distinction).
 * @property {(device: Device | undefined, option: Object) => boolean} validOption - Predicate for "should this option render for this device."
 * @property {(device: Device | undefined, category: Object) => boolean} validOptionCategory - Predicate for "should this category render for this device."
 */

/**
 * Catalog - The plugin-provided immutable configuration bundle. `CatalogIndex` from featureOptions.ts carries the catalog data and its derived indices; the
 * `validators` field adds the webUI-specific predicates plugins supply for device-aware visibility. Both halves are set once at {@link model:loaded} and never
 * change during a session; consumers can rely on reference stability for memoization.
 *
 * @typedef {Object} Catalog
 * @property {readonly import("../featureOptions.js").FeatureCategoryEntry[]} categories
 * @property {Readonly<Record<string, boolean>>} defaults
 * @property {Readonly<Record<string, string>>} groupParents
 * @property {Readonly<Record<string, readonly string[]>>} groups
 * @property {Readonly<Record<string, readonly import("../featureOptions.js").FeatureOptionEntry[]>>} options
 * @property {Readonly<Record<string, (value: string) => string>>} renderers
 * @property {readonly string[]} sortedValueOptionNames
 * @property {Validators} validators
 * @property {Readonly<Record<string, number | string | undefined>>} valueOptions
 */

/**
 * Scope - The selection pointer through the global / controller / device hierarchy. Discriminated by `kind` so each variant carries exactly its required data
 * and invalid combinations (a "device" view without a deviceId, a "controller" view without a controllerId) are unrepresentable.
 *
 * The `device` variant carries `controllerId: string | null` because two device-view shapes exist: a device under a controller (controllerId is the parent
 * controller's serial) and a device in device-only mode (controllerId is null because there is no controller). Splitting these into two further variants would
 * over-fragment the type for a distinction that no consumer cares about - both render the same view.
 *
 * @typedef {{kind: "global"} | {kind: "controller", controllerId: string} | {kind: "device", controllerId: string | null, deviceId: string}} Scope
 */

/**
 * LifecycleStatus - The page-state pointer. Discriminated because the variants carry different per-state payloads. Drop a status variant when it stops being a
 * named UI state; add one when a new named state surfaces.
 *
 * @typedef {{kind: "loading"} | {kind: "ready"} | {kind: "persisting", snapshot: readonly string[]} | {kind: "persist-error", error: Error}
 *           | {kind: "connection-error", message: string}} LifecycleStatus
 */

/**
 * FeatureOptionsState - The complete state shape. Every field has a defined purpose; every consumer reads from here. No view, effect, or component holds parallel
 * state that could drift from this.
 *
 * @typedef {Object} FeatureOptionsState
 * @property {Catalog} catalog - Plugin-provided immutable configuration: catalog index + validators.
 * @property {readonly string[]} configuredOptions - The canonical user-state array. Mutations replace it via the pure transforms from featureOptions.ts.
 * @property {readonly Controller[]} controllers - Controllers list (empty in device-only mode or before resolution).
 * @property {readonly Device[]} devices - Devices list for the active controller (or the cached-accessories list in device-only mode).
 * @property {number} devicesAppliedSeq - The sequence of the device-fetch outcome currently applied. The reducer's own verdict fact: a dispatcher reads it back to
 *   learn whether its outcome (the one carrying this sequence) is the one that landed, gating its follow-up work on one integer comparison rather than on the
 *   device array's reference, which the shared-empty-array idiom and a caching `getDevices` can alias across fetches.
 * @property {string | null} devicesControllerId - Serial of the controller whose `devices` are loaded, or null (device-only / none yet). Preserves the
 *   device-to-controller association that `scope` drops once the selection goes global, so a loaded device's parent controller stays resolvable after the
 *   selection leaves controller scope.
 * @property {{controllerId: string | null, seq: number} | null} devicesRequest - The pending device-fetch record, or null when no fetch is outstanding. A
 *   `devices:requested` records the latest fetch here; the `devices:loaded` that carries the same sequence clears it, and any other outcome is dropped.
 * @property {number} devicesRequestSeq - The persistent monotonic fetch counter. Never reset within a store's life, so every fetch across the session gets a unique,
 *   increasing sequence and last-request-wins holds even for two fetches against the same controller.
 * @property {{mode: "all" | "modified", query: string}} filter - Search and filter state. Two-field record because the dimensions are independent (every combination
 *                                                                is valid and meaningful).
 * @property {readonly string[]} initialOptions - The at-show() snapshot for "Revert to Saved." Stable across the session except when re-show() loads an option
 *                                                 set that is not set-equal to the prior snapshot, in which case the snapshot is replaced.
 * @property {"controller-based" | "device-only"} mode - Operating mode. Set once at model:loaded based on whether the plugin provided `getControllers`.
 * @property {readonly string[]} persistedAnchor - The last-known-on-disk state. Updated on every successful persist; restored to configuredOptions on a final
 *                                                  persist failure (memory then matches disk).
 * @property {Scope} scope - Selection pointer (DU).
 * @property {LifecycleStatus} status - Page-state pointer (DU).
 */

// The placeholder catalog used during the "loading" status, before {@link model:loaded} has fired with the real one. Built from empty inputs so every selector
// works against it without null guards; selectors that iterate categories or options produce empty results, which matches the "nothing to render yet" semantics.
// validOption and validOptionCategory default to permissive (return true) so any speculative iteration during loading does not accidentally hide a category
// or option; isController defaults to false since it plays no role in visibility.
const EMPTY_CATALOG = {

  ...buildCatalogIndex([], {}),

  validators: {

    isController: () => false,
    validOption: () => true,
    validOptionCategory: () => true
  }
};

/**
 * Build the initial state. Status is `loading`; every populated-at-runtime field is set to an empty array or default value. The first {@link model:loaded}
 * dispatch transitions every field to its loaded value in one atomic update.
 *
 * No constructor parameters because the variant data (mode, validators, configuredOptions) is not yet available at store-construction time - it arrives over the
 * wire from Homebridge's `getPluginConfig` + `request("/getOptions")` plus the plugin's optional `getControllers`. The orchestrator dispatches `model:loaded` once
 * those resolve.
 *
 * @returns {FeatureOptionsState} A fresh initial-state object.
 */
export const initialState = () => {

  // Share a single empty-array reference across every array-typed option field so the persist effect's "are we dirty?" check (configuredOptions === persistedAnchor)
  // returns true at registration time and does not trigger a spurious initial persist. After model:loaded, each field is set to the loaded array's reference; the
  // guarantee is preserved.
  const empty = [];

  return {

    catalog: EMPTY_CATALOG,
    configuredOptions: empty,
    controllers: [],
    devices: [],
    devicesAppliedSeq: 0,
    devicesControllerId: null,
    devicesRequest: null,
    devicesRequestSeq: 0,
    filter: { mode: "all", query: "" },
    initialOptions: empty,
    mode: "device-only",
    persistedAnchor: empty,
    scope: { kind: "global" },
    status: { kind: "loading" }
  };
};

/**
 * The pure reducer. Applies an action to the current state and returns the new state. Structural sharing: unchanged slices retain their reference across the
 * transition, so memoized selectors that depend on those slices return cached results.
 *
 * Unknown action types throw - silently ignoring them would let typo bugs escape into production where they manifest as missing UI updates. Every legitimate
 * action lives below; an unknown type is a bug at the dispatch site, surfaced loudly.
 *
 * @param {FeatureOptionsState} state - The current state.
 * @param {{type: string}} action - The action to apply. Discriminated by `type`; the switch below enumerates every legitimate value.
 * @returns {FeatureOptionsState} The new state.
 */
export const reducer = (state, action) => {

  switch(action.type) {

    case "model:loaded": {

      // First load: catalog, configuredOptions, mode, controllers populated. The persistence anchor seeds from the just-loaded options (pre-mutation the loaded array
      // IS the disk state). The initial snapshot - the revert target - takes `action.initialOptions` if the dispatcher supplied it (orchestrator re-shows that
      // detected set-equal options carry the original snapshot forward), otherwise falls back to the loaded options. Status transitions to ready.
      return {

        ...state,
        catalog: action.catalog,
        configuredOptions: action.configuredOptions,
        controllers: action.controllers,
        initialOptions: action.initialOptions ?? action.configuredOptions,
        mode: action.mode,
        persistedAnchor: action.configuredOptions,
        status: { kind: "ready" }
      };
    }

    case "controllers:loaded": {

      // Controllers list refreshed without re-loading the model - a controllers-only refresh hook that no code currently dispatches (nav rebuilds the sidebar on it).
      return { ...state, controllers: action.controllers };
    }

    case "devices:requested": {

      // Mint the next monotonic fetch sequence and record it as the pending request. The sequence - not the controllerId - is the fetch identity, so two in-flight
      // fetches for the same controller (a re-click, or a click racing the initial fetch) still resolve last-request-wins. The latest request owns the pending slot;
      // an earlier in-flight fetch's outcome finds its sequence superseded when it lands.
      const seq = state.devicesRequestSeq + 1;

      return { ...state, devicesRequest: { controllerId: action.controllerId ?? null, seq }, devicesRequestSeq: seq };
    }

    case "devices:loaded": {

      // A device fetch's outcome, stamped with the sequence its `devices:requested` minted. Apply it only when it answers the pending request; a superseded or
      // seq-less outcome vanishes here so a stale continuation cannot clobber the current view, and tests can assert reference equality on the dropped path. The null
      // check is explicit: an optional-chained comparison would read undefined on both sides for a seq-less action against no pending request and wrongly apply it,
      // silently green-lighting an unpaired legacy fixture.
      if((state.devicesRequest === null) || (action.seq !== state.devicesRequest.seq)) {

        return state;
      }

      // The pending request is answered. Record the applied sequence as the reducer's own verdict fact (dispatchers read it back to gate their follow-ups), clear the
      // pending slot, and adopt the device list with its owning controller (null in device-only mode) so the association survives a later move to global scope.
      const applied = {

        ...state,
        devices: action.devices,
        devicesAppliedSeq: action.seq,
        devicesControllerId: action.controllerId ?? null,
        devicesRequest: null
      };

      // A non-empty error is the connection-failure signal: the outcome carried an empty device list and the controller-failure message alongside it, so the status
      // moves to connection-error at this, the reducer's one fetch-failure transition. Scope is not touched here - a dispatcher moves the selection separately.
      return action.error.length ? { ...applied, status: { kind: "connection-error", message: action.error } } : applied;
    }

    case "scope:changed": {

      // Replace the selection pointer wholesale. The DU is atomic - controllerId, deviceId, and kind all move together so subscribers never observe a partial
      // selection state.
      return { ...state, scope: action.scope };
    }

    case "option:set": {

      // Compute the new configuredOptions via the pure transform. The transform returns a fresh array so reference equality on configuredOptions detects the
      // change; the catalog reference is unchanged so selectors that depend only on the catalog continue to hit their caches.
      return {

        ...state,
        configuredOptions: applySetOption({ args: action.args, catalog: state.catalog, configuredOptions: state.configuredOptions })
      };
    }

    case "option:cleared": {

      // The pure transform returns the input reference unchanged when nothing matched, so the reducer's `...state, configuredOptions: ...` spread also yields a
      // state value whose configuredOptions reference equals the prior one. Subscribers reading reference equality see a no-op and skip recomputation.
      return {

        ...state,
        configuredOptions: applyClearOption({ args: action.args, catalog: state.catalog, configuredOptions: state.configuredOptions })
      };
    }

    case "options:reset": {

      // Wipe every configured option. Fresh empty array so reference equality reflects the change. The initial snapshot and the anchor are untouched - revert
      // and persist failure still have their respective rollback targets.
      return { ...state, configuredOptions: [] };
    }

    case "model:reverted": {

      // Restore configuredOptions to the at-show() snapshot. The snapshot reference is reused as-is - subsequent option:set / option:cleared mutations will fork
      // it via the pure transforms, so the snapshot stays stable for the next revert.
      return { ...state, configuredOptions: state.initialOptions };
    }

    case "filter:changed": {

      // Partial update: action fields override; absent fields preserve. The action shape carries optional `query` and `mode` so callers can update one axis without
      // touching the other. A new filter object is allocated so reference equality reflects the change.
      return {

        ...state,
        filter: {

          mode: action.mode ?? state.filter.mode,
          query: action.query ?? state.filter.query
        }
      };
    }

    case "persist:started": {

      // Status transitions to persisting, carrying the snapshot that's now in flight. Subscribers (status bar) can show a "saving" affordance and read the snapshot
      // when they need to know what's pending.
      return { ...state, status: { kind: "persisting", snapshot: action.snapshot } };
    }

    case "persist:succeeded": {

      // The in-flight snapshot landed on disk. Promote it to the anchor so any subsequent rollback (after a future failure) restores to this state, and return
      // status to ready.
      return { ...state, persistedAnchor: action.snapshot, status: { kind: "ready" } };
    }

    case "persist:failed": {

      // Final-attempt failure with no superseding mutation. Roll configuredOptions back to the last-known disk state so memory matches disk, and transition status
      // to persist-error so subscribers (status bar / toast emitter) can surface the failure.
      return { ...state, configuredOptions: state.persistedAnchor, status: { error: action.error, kind: "persist-error" } };
    }

    case "connection:error": {

      // Controller unreachable on the current view. The orchestrator's connection-error flow dispatches this with the user-facing message that arrived alongside the
      // device-list response; subscribers (status bar / sidebar) consume the message.
      return { ...state, status: { kind: "connection-error", message: action.message } };
    }

    default: {

      // Unknown action: bug at the dispatch site. Surface loudly rather than silently ignore - the user's reported "UI didn't update" stack trace is more useful
      // than a months-later realization that a typo was eating dispatches.
      throw new Error("FeatureOptionsState.reducer: unknown action type \"" + action.type + "\".");
    }
  }
};
