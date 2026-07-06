/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/categoryState.mjs: Per-context category expansion-state persistence for the feature options webUI.
 */
"use strict";

/**
 * FeatureOptionsCategoryState - Per-context UI-state store with a localStorage projection.
 *
 * A small store keyed by an arbitrary caller-supplied context string, backed by a single localStorage key namespaced under the plugin's platform identifier. The
 * store is intentionally DOM-agnostic: callers serialize their UI state into a plain object before calling {@link set}, and read it back through {@link get}. DOM
 * walking is the orchestrator's job (via `captureCategoryStates` / `applyCategoryStates` in `webUi-featureOptions/utils.mjs`), which keeps this component a pure
 * persistence concern - reusable for any per-context JSON-serializable state, not just category collapse.
 *
 * Persistence is best-effort: read failures (corrupt JSON, storage unavailable) fall back to an empty map; write failures are silently swallowed because the
 * canonical config lives in the Homebridge plugin config store. The category cache exists only to spare the user from re-expanding the same sections on every visit.
 * The constructor loads the persisted snapshot once at instantiation; {@link set} updates both the in-memory map and the disk projection in one step.
 *
 * The in-memory map is a null-prototype object ({@link Object.create}(`null`)) so property accesses (`get`, `set`, `delete`'s `in` check) only ever see own
 * properties. Prototype names like `"toString"`, `"hasOwnProperty"`, or `"__proto__"` cannot leak in via `Object.prototype`, regardless of what context keys the
 * caller chooses or what JSON happens to be in localStorage.
 */
export class FeatureOptionsCategoryState {

  // In-memory map of context-key -> arbitrary JSON-serializable state shape. Loaded from localStorage at construction; updated by set(); read by get().
  #map;

  // Computed once at construction so the storage-key shape is the SSOT for this instance. Includes the platform identifier so plugins coexisting in a single
  // Homebridge install don't trample one another's UI state.
  #storageKey;

  /**
   * @param {string|undefined} platform - The Homebridge plugin platform identifier. Falls back to a generic "plugin" suffix when omitted so plugin configs that
   *                                      pre-date platform-keyed storage still get a working (if non-isolated) cache.
   */
  constructor(platform) {

    this.#storageKey = "homebridge-" + (platform ?? "plugin") + "-category-states";
    this.#map = this.#load();
  }

  /**
   * Return any persisted state for the given context key, or undefined when none exists. Callers receive a reference into the in-memory map - treat it as
   * read-only; mutating it bypasses {@link set} and skips the localStorage write.
   *
   * @param {string} contextKey - The caller-supplied identifier for the current view.
   * @returns {Object|undefined} The persisted state for this context, or undefined.
   */
  get(contextKey) {

    return this.#map[contextKey];
  }

  /**
   * Persist the supplied state under the given context key. The store performs no shape validation - the caller is responsible for handing in something this
   * store should round-trip via JSON. Pairs with {@link get}.
   *
   * @param {string} contextKey - Identifier for the current view.
   * @param {Object} state - JSON-serializable state to persist.
   */
  set(contextKey, state) {

    this.#map[contextKey] = state;
    this.#persist();
  }

  /**
   * Drop the persisted state for the given context key. The disk projection is updated immediately; subsequent {@link get} calls for the same key return undefined.
   * No-op when the key is absent. Pairs with {@link set} to complete the symmetric read/write/remove triad.
   *
   * Lazy key-shape migrations rely on this: a caller that finds data under a legacy key writes it under the new key via {@link set} and removes the legacy entry
   * via {@link delete} in one read/write/remove sequence, leaving disk in the new shape after every migrated visit.
   *
   * @param {string} contextKey - Identifier to remove.
   */
  delete(contextKey) {

    if(contextKey in this.#map) {

      delete this.#map[contextKey];
      this.#persist();
    }
  }

  /**
   * Load the persisted snapshot from localStorage into a null-prototype map. Returns an empty map on absent, corrupt, or otherwise unreadable storage so callers
   * always operate against a usable object - persistence failure should never wedge the UI on a bad localStorage entry. The null prototype eliminates the
   * possibility of an own-vs-inherited mismatch on any access path: `get`, `set`, and the `in` check in `delete` see only own keys regardless of what context
   * strings or JSON-stored keys appear.
   *
   * @returns {Object} The loaded map (always a null-prototype object), or an empty null-prototype object on failure.
   * @private
   */
  #load() {

    try {

      const stored = window.localStorage.getItem(this.#storageKey);
      const parsed = stored ? JSON.parse(stored) : null;

      // Plain-object guard. `JSON.parse` happily returns `null`, arrays, and primitives. Null and non-object primitives would crash the first downstream
      // get/set on a non-indexable value, while an array is indexable but would round-trip incorrectly through JSON.stringify and lose its array semantics
      // on the next reconstruction. The shape check matches the catch-block's graceful-degrade contract: any deviation from "this is a plain object"
      // resets the cache to an empty map and lets the UI continue. The valid-shape branch copies the parsed entries into a null-prototype container so
      // prototype names cannot leak in via `JSON.parse`'s regular-Object output.
      if((parsed !== null) && (typeof parsed === "object") && !Array.isArray(parsed)) {

        return Object.assign(Object.create(null), parsed);
      }
    } catch {

      // Storage corrupted, unavailable, or contains malformed JSON. Fall through to the empty-map default below.
    }

    return Object.create(null);
  }

  /**
   * Persist the current in-memory map to localStorage. Failures are silently swallowed because localStorage may be unavailable in private browsing or sandboxed
   * contexts, or quota-exceeded under heavy use; the category-state cache is purely UI ergonomics - the canonical config remains intact in the Homebridge plugin
   * config store.
   *
   * @private
   */
  #persist() {

    try {

      window.localStorage.setItem(this.#storageKey, JSON.stringify(this.#map));
    } catch {

      // Persistence failure is non-fatal. See the docblock for the rationale.
    }
  }
}
