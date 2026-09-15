/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/selectors.mjs: Memoized pure derivations over the feature options state.
 */
"use strict";

import { buildConfigIndex, expandOption, isDependencyMet, isValidChoice, isValueOption, resolveScope, selectValues } from "../featureOptions.js";
import { EMPTY_CATALOG } from "./state.mjs";
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
 * Report whether the store has loaded its model. Pure helper - one-line identity read, not memoized.
 *
 * The catalog leaves {@link EMPTY_CATALOG} in exactly one transition, `model:loaded`, so catalog identity answers the question for the store's whole life. Status
 * cannot answer it from either end: its `connection-error` variant occurs on both sides of a load, and a bail that resolves the page without dispatching anything
 * leaves it at `loading` for good. Consumers that need the page state - a loading placeholder, an error card - read `status`; consumers that need to know whether
 * the model's data has arrived read this.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {boolean} True once a model:loaded has installed a real catalog, false for the entire phase before it.
 */
export const modelLoaded = (state) => {

  return state.catalog !== EMPTY_CATALOG;
};

/**
 * Extract the controller serial from the scope tag, or null when no controller is in context. Pure helper - one-line tag read, not memoized.
 *
 * This is the controller's NAVIGATION identity: the serial the plugin's `getControllers` hook put on the sidebar link, which is what names, highlights, and
 * caches the controller as a place in the UI. A consumer that resolves configuration through the scope hierarchy wants {@link scopingControllerId} instead -
 * the serial controller-scope entries are keyed by, which a plugin may legitimately spell differently.
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
 * Extract the device serial from the scope tag, or null when the scope is global or controller-only. Pure helper - one-line tag read, not
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
 * entries by this, and the category-state localStorage projection uses the same key as its context identifier. Sharing one identifier across its consumers
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
 * `encodeURIComponent` at this point before composing the key.
 *
 * @param {import("./state.mjs").Scope} scope - The scope tag.
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
 * Resolve the serial that the in-scope controller's configuration entries are keyed by, or null when no controller is in scope. Memoized on `(catalog, devices,
 * devicesControllerId, scope)` - every input the derivation reads.
 *
 * A plugin may carry two distinct controller identities, and the framework holds both. The NAVIGATION identity is the serial its `getControllers` hook puts on
 * the sidebar link, which {@link selectedControllerId} reads off the scope tag; it has to exist before any connection succeeds, since a controller the page
 * cannot reach still has to appear in the list, so a plugin often names it by something configuration alone supplies, such as the address. The SCOPING identity
 * is the serial its controller-scope entries are keyed by, which the connection is what reveals - the same serial the plugin stamps on the controller's own row
 * in the device list.
 *
 * The framework recovers the second without asking the plugin for anything it does not already declare. The loaded device list carries the controller-as-device
 * row, and `ui.isController` is the plugin's own statement of which row that is, so that row's serialNumber IS the scoping identity. Everything that resolves
 * configuration reads it: the scope walk and the dependency probe in {@link projection}, the controller-page predicate, and the tri-state machine's
 * upstream-override probe. Everything that names or highlights the controller as a place reads the navigation identity, because those consumers are addressing
 * the sidebar rather than the configuration.
 *
 * The device-list guard is what keeps the derivation honest across a navigation: the list is consulted only while it belongs to the controller currently in
 * scope, which `devicesControllerId` answers. In the window where a click has moved the scope but the incoming list has not landed, the navigation identity
 * stands in...a momentarily coarser answer, and never some other controller's.
 *
 * The fallbacks are the compatibility contract. No controller in scope - the global view, device-only mode, global-only mode - is null, which is also why a
 * page with no controller machinery never reaches `isController` at all. No controller-as-device row - a plugin that supplies no validator, or a device list
 * that carries none - is the navigation identity, which is the serial a single-identity plugin resolves by anyway, so such a plugin cannot observe this
 * derivation. When more than one row answers to `isController`, the first in list order wins: one controller in scope, one page, one identity.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {string | null} The controller's scoping identity, or null when no controller is in scope.
 */
export const scopingControllerId = memoize({

  compute: (state) => {

    const navigationId = selectedControllerId(state);

    if(navigationId === null) {

      return null;
    }

    if(state.devicesControllerId !== navigationId) {

      return navigationId;
    }

    return state.devices.find((device) => state.catalog.validators.isController(device))?.serialNumber ?? navigationId;
  },
  slices: [ (s) => s.catalog, (s) => s.devices, (s) => s.devicesControllerId, (s) => s.scope ]
});

/**
 * TablePresentation - What the config-table surface shows. Tagged by `kind` because the variants are mutually exclusive answers to one question and each
 * carries exactly what rendering it needs: the empty variant carries the plugin's notice text, and the other two carry nothing because the DOM they imply is the
 * framework's own.
 *
 * @typedef {{kind: "empty", message: string} | {kind: "error"} | {kind: "options"}} TablePresentation
 */

/**
 * Decide what the config-table surface presents. Memoized on the state fields the decision reads, so a dispatch that moves none of them returns the cached answer.
 *
 * This is the single answer to "what is on the config-table surface right now", and both consumers read it rather than each recovering it from raw state: the
 * options view, which owns the table's DOM, and the search view, whose panel filters that table and therefore has nothing to offer when the table is not what is
 * showing. Deriving it once is what keeps the two from drifting - a surface the options view suppressed while the search panel still advertised counts over it
 * would be the page contradicting itself, and no amount of care at two call sites prevents that as reliably as having one answer.
 *
 * Precedence is the whole of the rule, evaluated top to bottom. A standing `connection-error` wins over everything: that view has taken the frame and owns the message,
 * and the table beneath it would be offering the options of a controller that never confirmed it could be reached. Next comes the nothing-to-list notice, which is a
 * per-controller-view presentation rather than a page state, which is why it is derived from the device facts here rather than carried as a status variant an unrelated
 * persist would destroy. Everything else is the ordinary table.
 *
 * The empty variant's gates each rule out a way the message could be shown where it does not belong. The controller-scope gate is what confines it to the
 * view it describes, and it is also why the variant is unreachable in device-only and global-only modes, whose scope is never a controller kind. The
 * `devicesControllerId` match is what keeps it honest across a navigation: a click away from a notice view moves the optimistic scope first, so for the busy window
 * before the new list lands the match fails and the presentation is the ordinary table, exactly as it is today for a click away from any other view. The message's
 * own non-null-ness is the plugin's declaration that this outcome was the empty one at all.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {TablePresentation} What the config-table surface presents.
 */
export const tablePresentation = memoize({

  compute: (state) => {

    if(state.status.kind === "connection-error") {

      return { kind: "error" };
    }

    if((state.scope.kind === "controller") && (state.devicesEmptyMessage !== null) && (state.devicesControllerId === state.scope.controllerId)) {

      return { kind: "empty", message: state.devicesEmptyMessage };
    }

    return { kind: "options" };
  },
  slices: [ (s) => s.devicesControllerId, (s) => s.devicesEmptyMessage, (s) => s.scope, (s) => s.status ]
});

/**
 * @typedef {Object} ProjectionChoice
 * @property {string} label - The text the editor shows for this choice. An unknown member has no label of its own and shows its stored value.
 * @property {boolean} selected - Whether the row's shown value selects this member.
 * @property {boolean} unknown - Whether this member is a stored value the option's current list does not offer, kept so a choice a device stopped reporting stays
 *           visible and editable rather than disappearing on the next write.
 * @property {string} value - The text the configuration stores for this choice.
 */

/**
 * @typedef {Object} ProjectionEntry
 * @property {readonly ProjectionChoice[] | undefined} choices - The option's resolved list with the row's selection marked, or undefined for an option that
 *           declares none - the same absence spelling `value` uses. An inline catalog list resolves to itself; a named source is called for the current controller
 *           and device. The offered members come first in declaration order, then any stored value the list does not carry.
 * @property {string} description - The option's display description.
 * @property {boolean} enabled - The resolved enabled state at the highest-precedence scope where the option was found (or the catalog default at scope "none").
 * @property {string} expandedName - The canonical `category.option` identifier.
 * @property {boolean} isGrouped - The option declares a `group` in the catalog (subordinate to a parent option).
 * @property {boolean} isModified - The option has a configured entry at any scope (not just the default).
 * @property {boolean} multiple - The option stores a list rather than a single value.
 * @property {string} name - The option's catalog name (without the category prefix).
 * @property {import("../featureOptions.js").FeatureOptionEntry} option - The raw catalog entry for the option.
 * @property {boolean} requiresParentBadge - The "requires parent" badge applies: option is visible, grouped, and its parent is currently disabled.
 * @property {import("../featureOptions.js").OptionScope} scope - The scope at which the option resolved ("device" / "controller" / "global" / "none"). On a
 *           controller's own options page - where the selected device IS the in-scope controller - an entry stored at that serial reports "controller" whichever
 *           step resolution reached it at, because the serial is the controller's and the entry governs every device beneath it.
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
 * @property {number} total - Active options across every active category: those whose declared scopes admit the current view and whose plugin validator passes,
 *                            regardless of per-entry visibility.
 * @property {number} visible - Active options currently visible under the search query, filter mode, and dependency state.
 */

/**
 * @typedef {Object} Projection
 * @property {readonly ProjectionCategory[]} categories - Active categories in catalog order. Categories with zero active options are omitted.
 * @property {ProjectionCounts} counts - Aggregate counts across the active option set.
 * @property {"controller" | "device" | "global"} viewScope - The scope the page presents at, which is the scope an edit made here lands at. It is the scope tag's
 *           own kind everywhere except a controller's options page, where the selected device is the in-scope controller and the view presents as "controller".
 */

/**
 * The view projection. One pass over the active option set produces every downstream display decision: status-bar counts, per-category visibility, per-row
 * visibility, per-row dependency-badge state, per-row resolved value for value-centric options, and the resolved list a picker offers with its selection already
 * marked. Memoized on `(catalog, configuredOptions, scope, filter, devices, controllers)` so any dispatch that does not touch those slices returns the cached
 * projection. `controllers` is among them because a choice source is handed the selected controller, which a controllers-only refresh replaces.
 *
 * The active option set is what the gates admit, in order: an option's declared scopes must admit the current view kind, and then the plugin's `validOption` must
 * accept it for the selected device. Everything downstream - the counts, the rows, the DOM - reads from this one set, so an option the current view has no
 * business offering is absent from every surface rather than hidden on each of them.
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
 * The projection also settles what scope the page presents at ({@link Projection.viewScope}) and reports each entry's scope in those terms, so the header suffix,
 * the inherit treatment, and the row colors all describe the scope an edit here actually lands at rather than the tag the navigation happened to produce.
 *
 * @param {import("./state.mjs").FeatureOptionsState} state - The current state.
 * @returns {Projection} The computed projection.
 */
export const projection = memoize({

  compute: (state) => computeProjection(state),
  slices: [ (s) => s.catalog, (s) => s.configuredOptions, (s) => s.scope, (s) => s.filter, (s) => s.devices, (s) => s.controllers ]
});

// Decide whether an option's declared scopes admit it on the current view. The framework gates on the one thing it natively knows - which view the page is showing -
// so a global view offers only options declared global, a controller view only those declared controller, and a device view those declared at either the device or
// the controller level, since a device page edits its own scope and displays what it inherits from its controller. An option that declares no scopes is admitted
// everywhere. Which KIND of device sees a given row is knowledge the framework cannot have, and stays with the plugin's validOption.
const viewAdmitsOption = (scopes, viewKind) => {

  if(!scopes) {

    return true;
  }

  switch(viewKind) {

    case "controller":

      return scopes.includes("controller");

    case "device":

      return scopes.includes("controller") || scopes.includes("device");

    case "global":

      return scopes.includes("global");

    default:

      // The Scope DU admits no other kind, so this is unreachable while the switch and the DU stay in sync. Rendering the row is the safe reading of an
      // unrecognized view: the declaration narrows what a known view offers and should never blank a view the framework failed to recognize.
      return true;
  }
};

/* Resolve the list an option offers in the current context, and read its selection against the row's shown value.
 *
 * An inline catalog list is its own answer and is used verbatim; a named source is the plugin's own function, called with the controller, the device, and the raw
 * entry. What comes back is never mutated - the resolved members are copied into fresh records here - so a plugin may hand back a cached array as readily as a
 * fresh one.
 *
 * A resolver answering in the wrong shape is a plugin bug and surfaces as a throw, which is the stance the validators already take: a picker rendering an empty or
 * malformed list would leave the user looking at a control that cannot express anything, with nothing on screen saying why.
 *
 * The offered members come first, each marked with whether the shown value selects it, and every stored value the list does not carry follows, marked unknown and
 * selected. That is what keeps a choice the device stopped reporting on screen instead of silently dropping out of the configuration the next time the row is
 * written.
 */
const resolveChoices = ({ catalog, controller, device, option, shown }) => {

  let declared = option.choices;

  if(typeof declared === "string") {

    const source = declared;

    declared = catalog.choiceSources[source]({ controller, device, option });

    if(!Array.isArray(declared)) {

      throw new TypeError("The choice source \"" + source + "\" did not return a list.");
    }

    for(const choice of declared) {

      if(!isValidChoice(choice)) {

        throw new TypeError("The choice source \"" + source + "\" returned an invalid choice.");
      }
    }
  }

  const selection = selectValues({ domain: declared.map((choice) => choice.value), multiple: option.multiple === true, value: shown });
  const choices = declared.map((choice) => ({ label: choice.label, selected: selection.selected.includes(choice.value), unknown: false, value: choice.value }));

  for(const entry of selection.unknown) {

    choices.push({ label: entry, selected: true, unknown: true, value: entry });
  }

  return choices;
};

// The projection's compute path. Walks the catalog once, applies validators, resolves each option through the scope hierarchy, computes per-entry flags and the
// overall counts. Pulled out of the memoize call site for readability - the function body is too long to inline in a property value.
const computeProjection = (state) => {

  const { catalog, filter } = state;
  const idx = configIndex(state);
  const controller = selectedController(state);
  const device = selectedDevice(state);
  const controllerId = scopingControllerId(state) ?? undefined;
  const deviceId = selectedDeviceId(state) ?? undefined;
  const query = filter.query.toLowerCase();
  const filterActive = (query.length > 0) || (filter.mode === "modified");
  const viewKind = state.scope.kind;

  // The page is the controller's own options page exactly when the selected device carries the controller's scoping identity, which {@link scopingControllerId}
  // derives from the controller-as-device row the plugin's isController declares. That equality is the definition of "edits here land at controller scope" rather
  // than a test for it: a write keys off the selected device's serial, so the edit lands on the very key controller-scope entries use precisely when the two
  // agree, and resolution answers that key at the controller step for every device beneath it. Every other controller read in this function - the scope walk, the
  // dependency probe - asks the same resolution question, which is why one identity serves all three.
  const controllerPage = (deviceId !== undefined) && (deviceId === controllerId);

  // The presented scope and the raw tag answer different questions, so both live on this path. What the page PRESENTS is what the header suffix, the inherit
  // treatment, and the row colors read, and that is the scope an edit lands at. Which options the page OFFERS stays keyed to the raw tag below, because admission
  // is a declared-scopes question about the storage step that matches, refined by the plugin's own validator - folding the controller identity into it would add
  // and remove rows rather than describe the rows already there.
  const viewScope = controllerPage ? "controller" : viewKind;

  const categories = [];
  const counts = { grouped: 0, modified: 0, total: 0, visible: 0 };

  for(const category of catalog.categories) {

    if(!catalog.validators.validOptionCategory(device, category)) {

      continue;
    }

    const entries = [];
    let categoryHasVisible = false;

    for(const option of (catalog.options[category.name] ?? [])) {

      // The framework's own gate runs first: an option is offered here only at a view its declared scopes admit, so a row the engine would refuse to resolve at
      // this level is never composed. The plugin's validator then refines what survives, which is why it runs second - it answers a device-kind question about
      // rows the framework has already accepted, and never has to re-derive the scope rule to do it.
      if(!viewAdmitsOption(option.scopes, viewKind)) {

        continue;
      }

      if(!catalog.validators.validOption(device, option)) {

        continue;
      }

      const expandedName = expandOption(category, option);
      const resolved = resolveScope({ catalog, configIndex: idx, controller: controllerId, device: deviceId, option: expandedName });
      const optionIsGrouped = option.group !== undefined;
      const optionIsModified = resolved.scope !== "none";
      const optionDependencyMet = isDependencyMet({ catalog, configIndex: idx, controller: controllerId, device: deviceId, option: expandedName });

      // The entry's scope as this page means it. On a controller's own page an entry the walk answered at the device step is stored at the controller's serial:
      // "device" is resolution's view-relative answer to being asked about that serial first, while the entry itself governs the controller and everything under
      // it. The projection is where the page's semantics are assembled, so the row reports the scope its entry actually holds...an entry resolved at the
      // controller, at global, or nowhere at all already says what it means and passes through.
      const entryScope = (controllerPage && (resolved.scope === "device")) ? "controller" : resolved.scope;

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

      /* Resolve the option's list, if it declares one, against the value the row SHOWS - the resolved value where there is one, and otherwise the catalog default
       * text, which is the same formula the renderer applies to a row that resolves to nothing. A locked or unset picker therefore previews its default selection
       * exactly as a text row previews its default text.
       *
       * The selection is settled here, once, so the renderer and the deviation rule read one answer rather than each deriving their own. The one selection this
       * does NOT describe is an armed row's, which is empty by the arming gesture's own rule and is written from the armed flag at render time.
       */
      let choices;

      if(option.choices !== undefined) {

        choices = resolveChoices({ catalog, controller, device, option, shown: value ?? String(option.defaultValue ?? "") });
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

        choices,
        description: option.description,
        enabled: resolved.enabled,
        expandedName,
        isGrouped: optionIsGrouped,
        isModified: optionIsModified,
        multiple: option.multiple === true,
        name: option.name,
        option,
        requiresParentBadge: visible && optionIsGrouped && !optionDependencyMet,
        scope: entryScope,
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

  return { categories, counts, viewScope };
};
