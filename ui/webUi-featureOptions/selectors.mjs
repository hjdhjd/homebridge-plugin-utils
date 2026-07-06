/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/selectors.mjs: Memoized pure derivations over the feature options state.
 */
"use strict";

import { buildConfigIndex, expandOption, isDependencyMet, isValueOption, resolveScope } from "../featureOptions.js";
import { memoize } from "./store.mjs";

/**
 * Memoized pure derivations over the feature options state.
 *
 * Every selector here reads from {@link FeatureOptionsState} (the shape defined in `webUi-featureOptions/state.mjs`) and returns a derived value. Selectors are
 * the read side of the unidirectional data flow - views and effects consume them, dispatches do not. Each selector is memoized via {@link memoize} on its specific
 * dependency slices, so a state transition that does not touch a selector's inputs returns a cached result in O(1).
 *
 * Composition: selectors that build on other selectors call them through their memoized exports. {@link projection} calls {@link configIndex} and
 * {@link selectedDevice}; each of those is independently cached. A dispatch that only changes `state.filter` re-runs `projection` (cache miss) but the inner
 * `configIndex` and `selectedDevice` calls hit their caches and return without recomputation.
 *
 * Reference-equality everywhere: the reducer's structural-sharing contract guarantees that unchanged slices retain their reference across dispatches. Selectors
 * compare slice references via `===`, which is the right grain for typical state mutations - a `scope:changed` dispatch produces a new `state.scope` reference but
 * leaves `state.catalog` and `state.configuredOptions` unchanged, so any selector depending only on the latter pair hits its cache.
 *
 * @module
 */

/**
 * Extract the controller serial from the scope discriminator, or null when no controller is in context. Pure helper - one-line discriminant read, not memoized.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {string | null} The controller serial when the scope is controller-based, null otherwise.
 */
export const selectedControllerId = (state) => {

  switch(state.scope.kind) {

    case "controller":

      return state.scope.controllerId;

    case "device":

      return state.scope.controllerId;

    default:

      return null;
  }
};

/**
 * Extract the device serial from the scope discriminator, or null when the scope is global or controller-only. Pure helper - one-line discriminant read, not
 * memoized.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {string | null} The device serial when the scope is device-based, null otherwise.
 */
export const selectedDeviceId = (state) => {

  return (state.scope.kind === "device") ? state.scope.deviceId : null;
};

/**
 * Map a {@link Scope} to a string key that uniquely identifies the view. Pure derivation from the discriminated union - every Scope variant maps to a distinct
 * key and no two variants collide.
 *
 * Used as the SSOT identifier for "which view is this" wherever a view's identity matters across mutations or navigations: the in-memory DOM cache keys its
 * entries by this, and the category-state localStorage projection uses the same key as its context identifier. Sharing one identifier across the two consumers
 * means a navigation and a localStorage lookup observe the same notion of "view," and any future code that needs to address a view by id picks up the same
 * convention without inventing a parallel scheme.
 *
 * Format:
 *
 *   - `global` - the global-scope view, single canonical key.
 *   - `controller:<serial>` - a controller's transient between-click view. Distinct per controller; never collides with the global key.
 *   - `device:<controllerSerial>/<deviceSerial>` - a device view under a controller (or under no controller in device-only mode, where the slot is empty). The
 *     compound key encodes the full inheritance lineage so a controller-scope cache invalidation can match every device under that controller by string prefix
 *     in O(N) over the cache without consulting the controller/devices lists.
 *
 * Delimiter contract: the device-key format relies on serial values not containing the `"/"` character, which matches the MAC-derived hex format Homebridge uses
 * for device and controller serials. A serial containing `"/"` would let the prefix match in {@link mountOptionsView}'s scope-aware cache invalidation over-match
 * unrelated entries. If that assumption ever needs to weaken (e.g., a plugin starts surfacing user-chosen serials), encode the components with
 * `encodeURIComponent` at this seam before composing the key.
 *
 * @param {import("./state.mjs").Scope} scope - The scope discriminator.
 * @returns {string} A stable string key identifying the view.
 */
export const scopeCacheKey = (scope) => {

  switch(scope.kind) {

    case "global":

      return "global";

    case "controller":

      return "controller:" + scope.controllerId;

    case "device":

      return "device:" + (scope.controllerId ?? "") + "/" + scope.deviceId;

    default:

      // Exhaustive switch over the Scope DU - this branch is unreachable as long as the DU stays in sync with the cases above. A future variant addition surfaces
      // here as a runtime throw rather than a silent fallthrough that produces a colliding key.
      throw new Error("scopeCacheKey: unknown scope kind.");
  }
};

/**
 * Build the O(1) lookup index from the configured-options array. Memoized on `(catalog, configuredOptions)` so any dispatch that does not touch the configured
 * options returns the cached index without rebuilding.
 *
 * Consumed by every other selector that needs to resolve options through the scope hierarchy (projection, rendering factories, effects) - sharing one cached index
 * across them means the parse-and-build work happens at most once per configured-options mutation.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {import("../featureOptions.js").ConfigIndex} The lookup index.
 */
export const configIndex = memoize({

  compute: (state) => buildConfigIndex(state.catalog, state.configuredOptions),
  slices: [ (s) => s.catalog, (s) => s.configuredOptions ]
});

/**
 * Resolve the currently-selected device by walking the devices list for the scope's deviceId. Memoized on `(scope, devices)` so any dispatch that does not touch
 * the selection or the devices list returns the cached result.
 *
 * Returns `undefined` for the global view (no device in scope) and for a scope.kind of "controller" (the controller-level view has no concrete device until the
 * user drills in). Consumers that need the device for validator calls pass `undefined` through directly - the validator signatures expect a possibly-undefined
 * device for exactly this case.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {import("./state.mjs").Device | undefined} The selected device, or undefined.
 */
export const selectedDevice = memoize({

  compute: (state) => {

    if(state.scope.kind !== "device") {

      return undefined;
    }

    return state.devices.find((d) => d.serialNumber === state.scope.deviceId);
  },
  slices: [ (s) => s.scope, (s) => s.devices ]
});

/**
 * Resolve the currently-selected controller by walking the controllers list for the scope's controllerId. Memoized on `(scope, controllers)`.
 *
 * Returns `null` for the global view (no controller in scope), the device-only-mode device view (controllerId is null), or when the controller is not found.
 * Consumers display the controller's name in headers / breadcrumbs and skip the display entirely on null.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {import("./state.mjs").Controller | null} The selected controller, or null.
 */
export const selectedController = memoize({

  compute: (state) => {

    const controllerId = selectedControllerId(state);

    if(controllerId === null) {

      return null;
    }

    return state.controllers.find((c) => c.serialNumber === controllerId) ?? null;
  },
  slices: [ (s) => s.scope, (s) => s.controllers ]
});

/**
 * @typedef {Object} ProjectionEntry
 * @property {string} description - The option's display description.
 * @property {boolean} enabled - The resolved enabled state at the highest-precedence scope where the option was found (or the catalog default at scope "none").
 * @property {string} expandedName - The canonical `category.option` identifier.
 * @property {boolean} isGrouped - The option declares a `group` in the catalog (subordinate to a parent option).
 * @property {boolean} isModified - The option has a configured entry at any scope (not just the default).
 * @property {string} name - The option's catalog name (without the category prefix).
 * @property {import("../featureOptions.js").FeatureOptionEntry} option - The raw catalog entry for the option.
 * @property {boolean} requiresParentBadge - The "requires parent" badge applies: option is visible, grouped, and its parent is currently disabled.
 * @property {import("../featureOptions.js").OptionScope} scope - The scope at which the option resolved ("device" / "controller" / "global" / "none").
 * @property {string | undefined} value - The resolved value for value-centric options when enabled; undefined for booleans and disabled options.
 * @property {boolean} visible - The option's row should be displayed under the current search query, filter mode, and dependency state.
 */

/**
 * @typedef {Object} ProjectionCategory
 * @property {import("../featureOptions.js").FeatureCategoryEntry} category - The raw catalog entry for the category.
 * @property {string} description - The category's display description.
 * @property {readonly ProjectionEntry[]} entries - The active options for this category, in catalog order.
 * @property {boolean} hasVisible - At least one entry has `visible === true`.
 * @property {string} name - The category's name.
 */

/**
 * @typedef {Object} ProjectionCounts
 * @property {number} grouped - Active options that declare a `group` (subordinate to a parent).
 * @property {number} modified - Active options with an explicit configured entry at any scope.
 * @property {number} total - Active options across every active (validator-passed) category, regardless of per-entry visibility.
 * @property {number} visible - Active options currently visible under the search query, filter mode, and dependency state.
 */

/**
 * @typedef {Object} Projection
 * @property {readonly ProjectionCategory[]} categories - Active categories in catalog order. Categories with zero active options are omitted.
 * @property {ProjectionCounts} counts - Aggregate counts across the active option set.
 */

/**
 * The view projection. One pass over the active option set produces every downstream display decision: status-bar counts, per-category visibility, per-row
 * visibility, per-row dependency-badge state, and per-row resolved value for value-centric options. Memoized on `(catalog, configuredOptions, scope, filter,
 * devices)` so any dispatch that does not touch those slices returns the cached projection.
 *
 * Visibility rules (the three-way cascade below is authoritative for what a row shows):
 *
 *   - The `modified` filter excludes unmodified options unconditionally.
 *   - A non-empty search query excludes options whose description does not contain the query (case-insensitive).
 *   - When either search or modified filter is active, dependency-hiding is SUPPRESSED - grouped options with disabled parents stay visible (with a "requires
 *     parent" badge) instead of disappearing. The rationale: a user who searched explicitly wants to see matches; hiding a match because its parent is off would
 *     be more confusing than the badge.
 *   - When neither search nor filter is active, grouped options with disabled parents are HIDDEN entirely. The dependency-hide is the natural state.
 *
 * `requiresParentBadge` collapses the combined predicate `visible && isGrouped && !dependencyMet` into one boolean so rendering code does not have to reconstruct
 * the rule from the raw fields.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {Projection} The computed projection.
 */
export const projection = memoize({

  compute: (state) => computeProjection(state),
  slices: [ (s) => s.catalog, (s) => s.configuredOptions, (s) => s.scope, (s) => s.filter, (s) => s.devices ]
});

// The projection's compute path. Walks the catalog once, applies validators, resolves each option through the scope hierarchy, computes per-entry flags and the
// overall counts. Pulled out of the memoize call site for readability - the function body is too long to inline in a property value.
const computeProjection = (state) => {

  const { catalog, filter } = state;
  const idx = configIndex(state);
  const device = selectedDevice(state);
  const controllerId = selectedControllerId(state) ?? undefined;
  const deviceId = selectedDeviceId(state) ?? undefined;
  const query = filter.query.toLowerCase();
  const filterActive = (query.length > 0) || (filter.mode === "modified");

  const categories = [];
  const counts = { grouped: 0, modified: 0, total: 0, visible: 0 };

  for(const category of catalog.categories) {

    if(!catalog.validators.validOptionCategory(device, category)) {

      continue;
    }

    const entries = [];
    let categoryHasVisible = false;

    for(const option of (catalog.options[category.name] ?? [])) {

      if(!catalog.validators.validOption(device, option)) {

        continue;
      }

      const expandedName = expandOption(category, option);
      const resolved = resolveScope({ catalog, configIndex: idx, controller: controllerId, device: deviceId, option: expandedName });
      const optionIsGrouped = option.group !== undefined;
      const optionIsModified = resolved.scope !== "none";
      const optionDependencyMet = isDependencyMet({ catalog, configIndex: idx, controller: controllerId, device: deviceId, option: expandedName });

      // Visibility cascade: modified filter, search query, then dependency-hide (only when neither filter nor search is active).
      let visible = true;

      if((filter.mode === "modified") && !optionIsModified) {

        visible = false;
      } else if((query.length > 0) && !option.description.toLowerCase().includes(query)) {

        visible = false;
      } else if(!filterActive) {

        visible = optionDependencyMet;
      }

      // Resolve the displayable value for value-centric options. Mirrors the FeatureOptions.value() semantics: explicit configured value wins, otherwise the
      // catalog-declared default when the option is enabled at no explicit scope ("none"), otherwise undefined (enabled at scope but no value provided).
      let value;

      if(isValueOption(catalog, expandedName) && resolved.enabled) {

        if(resolved.optionValue !== undefined) {

          value = resolved.optionValue;
        } else if(resolved.scope === "none") {

          value = catalog.valueOptions[expandedName.toLowerCase()]?.toString();
        }
      }

      counts.total++;

      if(optionIsGrouped) {

        counts.grouped++;
      }

      if(optionIsModified) {

        counts.modified++;
      }

      if(visible) {

        counts.visible++;
        categoryHasVisible = true;
      }

      entries.push({

        description: option.description,
        enabled: resolved.enabled,
        expandedName,
        isGrouped: optionIsGrouped,
        isModified: optionIsModified,
        name: option.name,
        option,
        requiresParentBadge: visible && optionIsGrouped && !optionDependencyMet,
        scope: resolved.scope,
        value,
        visible
      });
    }

    if(entries.length === 0) {

      continue;
    }

    categories.push({

      category,
      description: category.description,
      entries,
      hasVisible: categoryHasVisible,
      name: category.name
    });
  }

  return { categories, counts };
};
