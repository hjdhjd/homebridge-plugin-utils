/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions.ts: Hierarchical feature option capabilities for use in plugins and applications.
 */

/**
 * A hierarchical feature option system for plugins and applications.
 *
 * The module exports two complementary surfaces:
 *
 *   - **Pure functional core.** Catalog and config indices ({@link CatalogIndex}, {@link ConfigIndex}) carry every derived view of the catalog and configured options;
 *     pure builders ({@link buildCatalogIndex}, {@link buildConfigIndex}) construct them from raw inputs; pure transforms ({@link applySetOption},
 *     {@link applyClearOption}) compute new configured-options arrays without mutation; pure queries ({@link resolveScope}, {@link getDefaultValue},
 *     {@link isValueOption}, {@link optionExists}, {@link isDependencyMet}, {@link expandOption}) answer scope-aware questions over those indices. This is the
 *     single source of truth for option-array semantics, consumed wherever immutable state is the discipline (reducer-driven UIs, server-side renderers, time-travel
 *     debuggers, future consumers we have not built yet).
 *
 *   - **Imperative class façade.** {@link FeatureOptions} bundles a {@link CatalogIndex}, a configured-options array, and a {@link ConfigIndex} into one object whose
 *     mutating methods (`setOption` / `clearOption` / the setters) delegate to the pure transforms internally. This is the legacy-friendly surface used by every
 *     plugin's Node-side code; the public API is byte-for-byte stable across the pure-core extraction.
 *
 * Two surfaces, one set of semantics. The class is a convenience over the pure functions, not a parallel implementation.
 *
 * @module
 */
import type { HomebridgePluginLogging, Nullable } from "./util.ts";
import { formatBps, formatBytes, formatMs, formatPercent, formatSeconds } from "./formatters.ts";

/**
 * Named built-in formatters available to {@link FeatureOptionEntry.render}. The string literals double as discoverable, autocomplete-friendly names and as the
 * lookup keys into the registry that resolves them at catalog-rebuild time. Storing the catalog's renderer declaration as a string (rather than a function reference)
 * preserves the catalog's data-only shape so it stays JSON-serializable when every option uses a named formatter; the function escape hatch on `render` remains
 * available for bespoke needs that the registry does not cover.
 *
 * The set targets the unit categories that recur across plugin catalogs: bitrate (in either of the two common storage conventions), data size, percentages, and
 * durations. Extend the union when a new shared format becomes load-bearing across multiple plugins. Resist adding a formatter speculatively - the function escape
 * hatch already covers one-off needs, and an unused formatter is dead surface that downstream plugins still see in their IDE autocomplete.
 *
 * @category Feature Options
 */
export type FeatureOptionFormatter = "bps" | "bytes" | "kbps" | "ms" | "percent" | "seconds";

// The lookup table the catalog-index builder consults to resolve a string-named renderer to the function that implements it. Plugin-side formatting logic that
// would otherwise be duplicated across every plugin (each one reaching into util.ts to wrap formatBps for their bandwidth option, etc.) lives here once - any
// improvement to a built-in formatter's behavior propagates to every plugin that opts into the name. Adding a new formatter is a two-line change: extend the type
// union above and add a row here.
//
// The registry is module-scope and not exported. Per-plugin customization belongs in the function escape hatch on `render`; there is deliberately no API to mutate
// the shared registry, which would create initialization-order bugs and let test fixtures leak across files.
const BUILT_IN_FORMATTERS: Readonly<Record<FeatureOptionFormatter, (value: string) => string>> = {

  // Bitrate stored as bits per second. Delegates to formatBps which selects the right human-readable magnitude (bps / kbps / Mbps).
  bps: (value: string): string => formatBps(Number.parseFloat(value)),

  // Byte count rendered as bytes / KB / MB / GB via the 1024-based convention every operating system uses for file and buffer sizes.
  bytes: (value: string): string => formatBytes(Number.parseFloat(value)),

  // Bitrate stored as kilobits per second. We scale into bits and reuse formatBps so the magnitude selection stays identical to the bps formatter - the only
  // difference between bps and kbps is the storage convention the plugin chose, never the displayed form.
  kbps: (value: string): string => formatBps(Number.parseFloat(value) * 1_000),

  // Duration stored as milliseconds. formatMs promotes through ms / s / min / hr based on magnitude.
  ms: (value: string): string => formatMs(Number.parseFloat(value)),

  // Percentage rendered through the shared formatPercent helper so the precision policy stays uniform across every formatter in the registry - whole numbers carry
  // no decimal, fractional values get one decimal place.
  percent: (value: string): string => formatPercent(Number.parseFloat(value)),

  // Duration stored as seconds. formatSeconds promotes through s / min / hr based on magnitude.
  seconds: (value: string): string => formatSeconds(Number.parseFloat(value))
};

// Resolve a built-in formatter by name. Accepts an arbitrary string (not just a `FeatureOptionFormatter` literal) so the lookup naturally returns `undefined` when a
// caller bypasses the type system - via JS, an `as` cast, or an out-of-date type definition - and passes an unrecognized name. Encapsulating the type-widening cast
// here keeps the call site clean and names the intent: "look up a registered formatter by name; the result may not exist." Without the widening at this single seam,
// TypeScript narrows the literal-keyed indexing tightly enough that the runtime safety check at the call site looks dead, and the runtime guard would either be
// suppressed (silently weakening defense against JS callers) or removed (allowing the silent-fallback failure mode the design exists to prevent).
function resolveBuiltInFormatter(name: string): ((value: string) => string) | undefined {

  return (BUILT_IN_FORMATTERS as Readonly<Record<string, (value: string) => string>>)[name];
}

/**
 * Entry describing a feature option.
 *
 * @property default         - Default enabled/disabled state for this feature option.
 * @property defaultValue    - Optional. Default value for value-based feature options.
 * @property description     - Description of the feature option for display or documentation.
 * @property group           - Optional. Grouping/category for the feature option.
 * @property inputSize       - Optional. Width of the input field for a value-based feature option. Defaults to 5 characters.
 * @property meta            - Optional. An opaque, plugin-private annotation channel the core never interprets. HBPU's types deliberately cannot see inside `TMeta`;
 *                             the value is carried verbatim through the catalog and forwarded to the documentation renderer's closures (the only surface that knows its
 *                             concrete shape). This mirrors the OpenAPI `x-*` extension discipline, made type-safe: a plugin parameterizes the entry with its own
 *                             annotation type, the core treats it as `unknown`, and the round-trip stays structurally invariant rather than a naming convention.
 * @property name            - Name of the feature option (used in option strings).
 * @property render          - Optional. Maps the raw stored value of a value-centric option to a display string. Either a {@link FeatureOptionFormatter} string naming
 *                             a built-in formatter (preferred when the format already exists in the registry, since this keeps the enclosing catalog JSON-serializable
 *                             and lets every plugin share one implementation) or an inline function for bespoke formatting the registry does not cover. Consulted by
 *                             {@link FeatureOptions.logFeature} when emitting deviation lines so the catalog stays the single source of truth for how an option's
 *                             value renders; ignored for plain boolean options. When absent, values render as the raw string returned by {@link FeatureOptions.value}.
 *                             An unrecognized formatter name throws at catalog-rebuild time, surfacing the misconfiguration loudly rather than silently producing the
 *                             raw-value fallback.
 *
 * @typeParam TMeta - The concrete type of the opaque {@link FeatureOptionEntry.meta} annotation. Defaults to `unknown`, so a bare `FeatureOptionEntry` (the form every
 *                    existing core consumer uses) resolves to `FeatureOptionEntry<unknown>` and stays assignable to the parameterized form, keeping the core non-generic.
 */
export interface FeatureOptionEntry<TMeta = unknown> {

  default: boolean;
  defaultValue?: number | string;
  description: string;
  group?: string;
  inputSize?: number;
  meta?: TMeta;
  name: string;
  render?: FeatureOptionFormatter | ((value: string) => string);
}

/**
 * Entry describing a feature option category.
 *
 * @property description     - Description of the category.
 * @property meta            - Optional. An opaque, plugin-private annotation channel the core never interprets, mirroring {@link FeatureOptionEntry.meta}. This is the
 *                             typed extension path the category side previously lacked; the documentation renderer forwards it to the category-scope closure, and the
 *                             core treats it as `unknown` throughout.
 * @property name            - Name of the category.
 *
 * @typeParam TMeta - The concrete type of the opaque {@link FeatureCategoryEntry.meta} annotation. Defaults to `unknown` for the same backward-compatibility reason as
 *                    {@link FeatureOptionEntry}: a bare `FeatureCategoryEntry` resolves to `FeatureCategoryEntry<unknown>` and stays assignable to the typed form.
 */
export interface FeatureCategoryEntry<TMeta = unknown> {

  description: string;
  meta?: TMeta;
  name: string;
}

/**
 * Describes all possible scope hierarchy locations for a feature option.
 */
export type OptionScope =  "controller" | "device" | "global" | "none";

/**
 * Resolved view of a feature option through the scope hierarchy. Captures the scope where the option was found, whether it's enabled, and the raw string value for
 * value-centric options. This single traversal result serves both boolean queries and value queries, eliminating duplicate scope walks. Returned by
 * {@link resolveScope}.
 *
 * @property enabled         - The resolved enabled state at the highest-precedence scope where the option was found.
 * @property optionValue     - The raw string value when a value-centric option was set with an explicit value at the resolved scope. Absent otherwise.
 * @property scope           - The scope where the option resolved, or "none" when no explicit entry was found at any scope.
 */
export interface ResolvedOptionEntry {

  enabled: boolean;
  optionValue?: string;
  scope: OptionScope;
}

/**
 * Immutable derived index over the catalog inputs ({@link FeatureCategoryEntry}[] + the options map). Every field except `categories` / `options` is derived from
 * those two; the index bundles them with their derivations so a single value carries everything any caller needs to make catalog-level decisions in O(1).
 *
 * The index is built once per catalog at {@link buildCatalogIndex}; it is invariant across configured-options mutations, so a consumer that holds a stable
 * reference can rely on its query results until the catalog itself changes. The {@link FeatureOptions} class holds one internally; consumers driving reducers
 * directly hold it as state and reuse it across every dispatch that does not touch the catalog.
 *
 * @property categories             - The raw category list, preserved for callers that need to iterate it (rendering, validation, log enumeration).
 * @property defaults               - Lowercased-key map from canonical option name (the form {@link expandOption} produces) to its catalog-declared default.
 * @property groupParents           - Reverse index from a child option's expanded name to its parent group's expanded name. Catalog case preserved on the keys.
 * @property groups                 - Forward index from a parent group's expanded name to its child options' expanded names.
 * @property options                - The raw options map, preserved alongside categories for the same reason.
 * @property renderers              - Lowercased-key map from canonical option name to its resolved value renderer (built-in or inline function). Built-in names
 *                                    that fail to resolve throw at index-build time rather than degrading silently at log time.
 * @property sortedValueOptionNames - The keys of `valueOptions`, sorted longest-first, cached so the parser can do its greedy-prefix match without re-sorting on
 *                                    every Enable-entry parse.
 * @property valueOptions           - Lowercased-key map from canonical option name to its declared default value. The presence of a key in this map is the SSOT
 *                                    for "this option is value-centric."
 */
export interface CatalogIndex {

  readonly categories: readonly FeatureCategoryEntry[];
  readonly defaults: Readonly<Record<string, boolean>>;
  readonly groupParents: Readonly<Record<string, string>>;
  readonly groups: Readonly<Record<string, readonly string[]>>;
  readonly options: Readonly<Record<string, readonly FeatureOptionEntry[]>>;
  readonly renderers: Readonly<Record<string, (value: string) => string>>;
  readonly sortedValueOptionNames: readonly string[];
  readonly valueOptions: Readonly<Record<string, number | string | undefined>>;
}

/**
 * Immutable lookup index over the configured-options array. Each lookup key is either the raw lowercased tail of an Enable/Disable entry (always present) or a
 * derived value-key for value-centric Enable entries that carry a trailing value segment. First-write-wins semantics on collision so the earliest entry in the
 * configured-options array takes precedence over later duplicates - a user hand-editing config and accidentally listing an option twice gets the natural
 * "first one is canonical" semantic.
 *
 * Built by {@link buildConfigIndex} from a `CatalogIndex` plus the configured-options array; consumed by {@link resolveScope} and {@link optionExists} to answer
 * scope-aware questions in O(1).
 */
export type ConfigIndex = ReadonlyMap<string, Readonly<{ enabled: boolean; value?: string }>>;

/**
 * Arguments for {@link applySetOption} and {@link FeatureOptions.setOption}. Carries the full mutation intent: the option key, optional scope id, enabled state,
 * and optional value for value-centric options.
 *
 * @property enabled - True to enable, false to disable.
 * @property id      - Optional device or controller scope identifier. Omit to address the global scope.
 * @property option  - Feature option to set (case-insensitive).
 * @property value   - Optional value for value-centric options. Honored only when `enabled` is true and the option is value-centric.
 */
export interface SetOptionArgs {

  enabled: boolean;
  id?: string;
  option: string;
  value?: number | string;
}

/**
 * Arguments for {@link applyClearOption} and {@link FeatureOptions.clearOption}. Carries the addressing intent: the option key and optional scope id, with no
 * enabled state or value because the operation forgets every entry addressing the target regardless of what they encoded.
 *
 * @property id     - Optional device or controller scope identifier. Omit to address the global scope.
 * @property option - Feature option to clear (case-insensitive).
 */
export interface ClearOptionArgs {

  id?: string;
  option: string;
}

// Internal parse result for a single configured-options entry. `primaryKey` is the raw lowercased tail (always registered on the index). `valueKey` and `value`
// appear only when the tail decomposes as a known value-centric option plus a value segment - they tell the index where to also register the extracted value for
// O(1) lookups. Shared between buildConfigIndex (writer) and entryAddressesScope (reader) so the two cannot disagree on what any given entry "means" under the
// storage format.
interface ParsedConfigEntry {

  enabled: boolean;
  primaryKey: string;
  value?: string;
  valueKey?: string;
}

/**
 * Compose a fully formed feature option string from a category and an option. Accepts either raw strings or the catalog entry objects, mirroring how the catalog
 * is iterated at build time. The result is the canonical key shape every other helper consumes - lowercase the result to derive lookup-index keys, preserve the
 * caller's casing to compose entry strings.
 *
 * @param category - Feature option category entry or category name string.
 * @param option   - Feature option entry or option name string.
 *
 * @returns The fully formed feature option in the form of `category.option`, or `category` alone when the option name is empty, or the empty string when the
 *          category name is empty.
 */
export function expandOption(category: FeatureCategoryEntry | string, option: FeatureOptionEntry | string): string {

  const categoryName = (typeof category === "string") ? category : category.name;
  const optionName = (typeof option === "string") ? option : option.name;

  if(!categoryName.length) {

    return "";
  }

  return (!optionName.length) ? categoryName : categoryName + "." + optionName;
}

// Compose the canonical lookup-index target key for a (option, id) pair. This is the form a setOption({ option, id, ... }) call would resolve to on the index, and
// is the comparison key the matcher and writers share.
function targetKey(option: string, id: string | undefined): string {

  return id?.length ? option.toLowerCase() + "." + id.toLowerCase() : option.toLowerCase();
}

// Parse a single configured-options entry into the lookup keys it would register on the index. Returns null for non-canonical entries (no action prefix, or an
// unknown action). Otherwise returns the primary (raw-tail) key, optionally accompanied by a derived value key with the extracted value for value-centric Enable
// entries. This is the SSOT for entry decoding - both buildConfigIndex (which uses it to populate the index) and entryAddressesScope (which uses it to decide
// whether a mutation should replace this entry) consume the same result, so the writer and the reader of the storage format cannot disagree about what any given
// entry "means."
//
// Greedy longest-prefix matching against the value-option registry handles the case where a shorter value-centric option name is a prefix of a longer option in
// the catalog - the longer match wins, so an entry like `Enable.Audio.Volume.50` (when both `Audio` and `Audio.Volume` are value-centric) is unambiguously parsed
// as `Audio.Volume` with value `50`, not `Audio` with value `Volume.50`.
function parseEntry(catalog: CatalogIndex, rawEntry: string): ParsedConfigEntry | null {

  const dotIndex = rawEntry.indexOf(".");

  if(dotIndex === -1) {

    return null;
  }

  const action = rawEntry.slice(0, dotIndex).toLowerCase();

  if((action !== "enable") && (action !== "disable")) {

    return null;
  }

  const enabled = action === "enable";
  const tailOriginal = rawEntry.slice(dotIndex + 1);
  const tail = tailOriginal.toLowerCase();
  const parsed: ParsedConfigEntry = { enabled, primaryKey: tail };

  // Value extraction is only meaningful for Enable entries - a disabled option carries no value regardless of trailing segments.
  if(!enabled) {

    return parsed;
  }

  // Iterate the precomputed longest-first value-option-names cache. Sorting here would re-allocate and re-traverse valueOptions on every Enable-entry parse; the
  // cache lives on catalog.sortedValueOptionNames and is rebuilt only when the catalog changes (see buildCatalogIndex).
  for(const optName of catalog.sortedValueOptionNames) {

    if(!tail.startsWith(optName)) {

      continue;
    }

    const remainder = tail.slice(optName.length);

    // Exact match on the option name with no trailing segments - there is no value to extract, just a bare Enable on the value option.
    if(!remainder.length) {

      break;
    }

    // The next character must be a dot separator. Otherwise this option name is merely a prefix of a longer unrelated token, and we should continue trying shorter
    // candidates.
    if(!remainder.startsWith(".")) {

      continue;
    }

    const extra = remainder.slice(1);
    const extraOriginal = tailOriginal.slice(optName.length + 1);
    const separatorIndex = extra.indexOf(".");

    if(separatorIndex === -1) {

      // Single trailing segment: global value form.
      parsed.valueKey = optName;
      parsed.value = extraOriginal;
    } else {

      const idLower = extra.slice(0, separatorIndex);
      const valueOriginal = extraOriginal.slice(separatorIndex + 1);

      // Only register if the value portion is a single segment (no additional dots) - otherwise the tail is unstructured and we leave it for the primary key.
      if(!valueOriginal.includes(".")) {

        parsed.valueKey = optName + "." + idLower;
        parsed.value = valueOriginal;
      }
    }

    break;
  }

  return parsed;
}

// Decide whether a configured-options entry addresses a target lookup key. Used by applySetOption/applyClearOption to find replaceable entries without exposing
// the entry format to callers. Goes through the shared parser so the matcher is consistent with the indexer by construction.
function entryAddressesScope({ catalog, rawEntry, target }: { catalog: CatalogIndex; rawEntry: string; target: string }): boolean {

  const parsed = parseEntry(catalog, rawEntry);

  if(!parsed) {

    return false;
  }

  return (parsed.primaryKey === target) || (parsed.valueKey === target);
}

/**
 * Build the catalog-derived index from raw categories + options. The result carries the raw inputs alongside every derivation needed for O(1) catalog queries -
 * defaults, value-options registry, groups (both directions), renderers, and the longest-first cache the entry parser consumes. Throws when a built-in formatter
 * name on a `render` declaration does not resolve, surfacing the misconfiguration at load time rather than silently degrading the log-emission path.
 *
 * The index is the catalog-side input to every other pure helper in this module. Build it once per catalog; reuse it across every configured-options mutation
 * because the catalog is invariant across those mutations. Categories without an entry in the options map are skipped silently (a plugin defines a category for
 * future expansion before any option has migrated into it).
 *
 * @param categories - The raw category list.
 * @param options    - The raw options map keyed by category name.
 *
 * @returns The immutable catalog index.
 */
export function buildCatalogIndex(categories: readonly FeatureCategoryEntry[], options: Readonly<Record<string, readonly FeatureOptionEntry[]>>): CatalogIndex {

  const defaults: Record<string, boolean> = {};
  const groupParents: Record<string, string> = {};
  const groups: Record<string, string[]> = {};
  const renderers: Record<string, (value: string) => string> = {};
  const valueOptions: Record<string, number | string | undefined> = {};

  for(const category of categories) {

    const categoryOptions = options[category.name];

    if(!categoryOptions) {

      continue;
    }

    for(const option of categoryOptions) {

      const entry = expandOption(category, option);

      defaults[entry.toLowerCase()] = option.default;

      // Track value-centric options separately so the lookup index built later knows which entries can carry a trailing value segment.
      if("defaultValue" in option) {

        valueOptions[entry.toLowerCase()] = option.defaultValue;
      }

      // Register the catalog-declared renderer when present so logFeature can consult it in O(1) without walking the options map at log time. Boolean options may
      // declare a renderer too - it just goes unused by the logging path - so we register unconditionally rather than gating on isValue here. A string-typed
      // declaration names a built-in formatter from BUILT_IN_FORMATTERS; an unknown name is a misconfiguration, surfaced loudly at catalog-build time rather than
      // silently degraded to the raw-value fallback at log time.
      if(option.render !== undefined) {

        if(typeof option.render === "string") {

          const formatter = resolveBuiltInFormatter(option.render);

          if(formatter === undefined) {

            throw new Error("FeatureOptions: unknown built-in formatter \"" + option.render + "\" declared on option \"" + entry + "\".");
          }

          renderers[entry.toLowerCase()] = formatter;
        } else {

          renderers[entry.toLowerCase()] = option.render;
        }
      }

      if(option.group !== undefined) {

        const expandedGroup = category.name + (option.group.length ? ("." + option.group) : "");

        // Build both directions of the parent/child relation so callers can walk it either way in O(1) - forward for a parent's children, reverse for an option's
        // parent group.
        (groups[expandedGroup] ??= []).push(entry);
        groupParents[entry] = expandedGroup;
      }
    }
  }

  // Cache the value-option names sorted longest-first. parseEntry consumes this directly on every Enable-entry parse; precomputing here means the sort runs once
  // per catalog change rather than once per parse. The list mirrors valueOptions's key set, so any future mutation that touches valueOptions must rebuild through
  // this method to keep the two views consistent.
  const sortedValueOptionNames = Object.keys(valueOptions).sort((a, b) => b.length - a.length);

  return { categories, defaults, groupParents, groups, options, renderers, sortedValueOptionNames, valueOptions };
}

/**
 * Build the configured-options lookup index from a catalog index + the configured-options array. Each entry contributes one or two lookup keys via the shared
 * `parseEntry`: the raw tail (always) and an extracted value key (for value-centric Enable entries). First-write-wins on collision so the earliest entry in
 * the array takes precedence over later duplicates - users hand-editing config and accidentally listing an option twice get the natural "first one is canonical"
 * semantic.
 *
 * Rebuild whenever the configured-options array changes; reuse across reads.
 *
 * @param catalog           - The catalog index that defines what counts as a value-centric option.
 * @param configuredOptions - The array of configured option strings.
 *
 * @returns The immutable lookup index.
 */
export function buildConfigIndex(catalog: CatalogIndex, configuredOptions: readonly string[]): ConfigIndex {

  const lookup = new Map<string, Readonly<{ enabled: boolean; value?: string }>>();

  for(const rawEntry of configuredOptions) {

    const parsed = parseEntry(catalog, rawEntry);

    if(!parsed) {

      continue;
    }

    if(!lookup.has(parsed.primaryKey)) {

      lookup.set(parsed.primaryKey, { enabled: parsed.enabled });
    }

    if(parsed.valueKey && !lookup.has(parsed.valueKey)) {

      lookup.set(parsed.valueKey, { enabled: true, value: parsed.value });
    }
  }

  return lookup;
}

/**
 * Compute the new configured-options array after setting an option's enabled state (and optionally its value) at a given scope. Drops any prior entry addressing
 * the same option-at-scope so the new entry is the sole survivor, then appends the freshly composed entry string. Pure: does not mutate the input array; the
 * returned array is a fresh allocation.
 *
 * The composed entry's action segment is canonical "Enable" / "Disable"; the option and id segments preserve the caller's casing for readability since the
 * lookup-index keys are case-insensitive anyway. Value tails are emitted only when meaningful - disabled or non-value options never carry one - so a subsequent
 * {@link applyClearOption} or {@link applySetOption} addressing the same scope cleanly replaces whatever was there.
 *
 * @param options
 * @param options.args              - The mutation intent: option key, optional scope id, enabled state, optional value. See {@link SetOptionArgs}.
 * @param options.catalog           - The catalog index that defines what counts as a value-centric option (which determines whether to emit a value segment).
 * @param options.configuredOptions - The current configured-options array.
 *
 * @returns The new configured-options array. A fresh allocation, never a shared reference with the input.
 */
export function applySetOption({ args, catalog, configuredOptions }: { args: SetOptionArgs; catalog: CatalogIndex; configuredOptions: readonly string[] }): string[] {

  const target = targetKey(args.option, args.id);
  const filtered = configuredOptions.filter((entry) => !entryAddressesScope({ catalog, rawEntry: entry, target }));

  // Compose the new entry. The action segment is canonical "Enable"/"Disable"; the rest preserves the caller's casing for readability since the index is
  // case-insensitive anyway. Value tails are emitted only when meaningful - disabled or non-value options never carry one.
  const segments = [ args.enabled ? "Enable" : "Disable", args.option ];

  if(args.id?.length) {

    segments.push(args.id);
  }

  if(args.enabled && isValueOption(catalog, args.option) && (args.value !== undefined)) {

    segments.push(args.value.toString());
  }

  filtered.push(segments.join("."));

  return filtered;
}

/**
 * Compute the new configured-options array after clearing every entry addressing an option at a given scope. The match is value-aware: for value-centric options
 * it covers both the bare scoped entry and any entry carrying a single trailing value segment, so a subsequent {@link applySetOption} cleanly replaces whatever
 * was there.
 *
 * Pure: does not mutate the input array. When no entry matched the target, returns the input array reference unchanged so reference-equality consumers can detect
 * a no-op without a contents comparison.
 *
 * @param options
 * @param options.args              - The addressing intent: option key, optional scope id. See {@link ClearOptionArgs}.
 * @param options.catalog           - The catalog index that defines what counts as a value-centric option (which the matcher consults via the shared parser).
 * @param options.configuredOptions - The current configured-options array.
 *
 * @returns The new configured-options array, or the input array reference itself when nothing matched.
 */
export function applyClearOption(
  { args, catalog, configuredOptions }: { args: ClearOptionArgs; catalog: CatalogIndex; configuredOptions: readonly string[] }
): readonly string[] {

  const target = targetKey(args.option, args.id);
  const filtered = configuredOptions.filter((entry) => !entryAddressesScope({ catalog, rawEntry: entry, target }));

  // Reference-stable no-op: nothing matched, so callers comparing references see no change without inspecting contents.
  return (filtered.length === configuredOptions.length) ? configuredOptions : filtered;
}

/**
 * Resolve a feature option through the scope hierarchy in a single traversal. Returns the scope where the option was found, its enabled state, and the raw value
 * for value-centric options. This is the core resolution primitive that every higher-level query builds on - {@link FeatureOptions.test}, {@link FeatureOptions.scope},
 * {@link FeatureOptions.value}, and {@link FeatureOptions.logFeature} all consume the same `ResolvedOptionEntry` shape from one walk.
 *
 * Resolution precedence: device beats controller beats global beats default. An explicit entry at a higher-precedence scope short-circuits the lookup, so the
 * cost is O(1) in the configured-options array size.
 *
 * @param args
 * @param args.catalog            - The catalog index (consulted for the default when no scope matched).
 * @param args.configIndex        - The configured-options lookup index.
 * @param args.controller         - Optional controller scope identifier.
 * @param args.defaultReturnValue - Fallback for options that don't appear in the catalog's defaults. Defaults to false.
 * @param args.device             - Optional device scope identifier.
 * @param args.option             - The option key to resolve (case-insensitive).
 *
 * @returns The resolved view: scope, enabled state, optional raw value.
 */
export function resolveScope({ catalog, configIndex, controller, defaultReturnValue = false, device, option }: {

  catalog: CatalogIndex;
  configIndex: ConfigIndex;
  controller?: string;
  defaultReturnValue?: boolean;
  device?: string;
  option: string;
}): ResolvedOptionEntry {

  const normalizedOption = option.toLowerCase();

  // Check to see if we have a device-level option first.
  if(device) {

    const deviceEntry = configIndex.get(normalizedOption + "." + device.toLowerCase());

    if(deviceEntry) {

      return { enabled: deviceEntry.enabled, optionValue: deviceEntry.value, scope: "device" };
    }
  }

  // Now check to see if we have a controller-level option.
  if(controller) {

    const controllerEntry = configIndex.get(normalizedOption + "." + controller.toLowerCase());

    if(controllerEntry) {

      return { enabled: controllerEntry.enabled, optionValue: controllerEntry.value, scope: "controller" };
    }
  }

  // Finally, we check for a global-level value.
  const globalEntry = configIndex.get(normalizedOption);

  if(globalEntry) {

    return { enabled: globalEntry.enabled, optionValue: globalEntry.value, scope: "global" };
  }

  // The option hasn't been set at any scope, return the catalog default. The defaultReturnValue parameter covers the case where the option is not in the catalog
  // at all - typically a misspelling or a stale call site referring to an option that was removed from the catalog.
  return { enabled: getDefaultValue({ catalog, defaultReturnValue, option }), scope: "none" };
}

/**
 * Return the catalog-declared default for a feature option, falling back to a caller-supplied default for options that don't appear in the catalog at all.
 *
 * @param args
 * @param args.catalog            - The catalog index.
 * @param args.defaultReturnValue - Fallback when the option is not in the catalog's defaults map. Defaults to false.
 * @param args.option             - The option key (case-insensitive).
 *
 * @returns The default value: catalog declaration if present, fallback otherwise.
 */
export function getDefaultValue({ catalog, defaultReturnValue = false, option }: { catalog: CatalogIndex; defaultReturnValue?: boolean; option: string }): boolean {

  return catalog.defaults[option.toLowerCase()] ?? defaultReturnValue;
}

/**
 * Return whether a feature option is value-centric (carries a `defaultValue` in its catalog declaration). The presence of the option's lowercased key in the
 * catalog's `valueOptions` map is the SSOT for this predicate.
 *
 * @param catalog - The catalog index.
 * @param option  - The option key (case-insensitive). Empty string returns false.
 *
 * @returns True for value-centric options, false otherwise.
 */
export function isValueOption(catalog: CatalogIndex, option: string): boolean {

  if(!option) {

    return false;
  }

  return option.toLowerCase() in catalog.valueOptions;
}

/**
 * Return whether an option has been explicitly configured at the given scope. Distinct from {@link resolveScope}, which walks the hierarchy; this predicate
 * answers only "did the user set this entry at THIS scope?" without consulting any higher or lower scopes.
 *
 * @param args
 * @param args.configIndex - The configured-options lookup index.
 * @param args.id          - Optional scope identifier (device or controller). Omit to address the global scope.
 * @param args.option      - The option key (case-insensitive).
 *
 * @returns True when an explicit entry addresses this option-at-scope.
 */
export function optionExists({ configIndex, id, option }: { configIndex: ConfigIndex; id?: string; option: string }): boolean {

  return configIndex.has(option.toLowerCase() + (id ? "." + id.toLowerCase() : ""));
}

/**
 * Return whether a grouped option's parent is currently enabled at the given scope. For options that aren't grouped (no `group` property in the catalog entry),
 * always returns `true` - there is no dependency to fail. For grouped options, traverses the scope hierarchy via {@link resolveScope} to evaluate the parent's
 * effective state at the requested device + controller view.
 *
 * This is the SSOT for "is this option's row currently usable?" Every caller that wants to know whether to render a grouped option's row, count it as visible,
 * or honor its dependency-hidden state asks this function rather than reconstructing the parent path themselves. The reverse-lookup from option to parent uses
 * the pre-built `catalog.groupParents` index, so the predicate is O(1) regardless of option-key length.
 *
 * @param args
 * @param args.catalog            - The catalog index.
 * @param args.configIndex        - The configured-options lookup index.
 * @param args.controller         - Optional controller scope identifier.
 * @param args.defaultReturnValue - Fallback default for options not in the catalog. Defaults to false.
 * @param args.device             - Optional device scope identifier.
 * @param args.option             - Fully-qualified feature option string (e.g., `"Motion.Sensitivity"`). Case-insensitive.
 *
 * @returns `true` when the option has no dependency or its parent is currently enabled at the requested scope; `false` when the parent is currently disabled.
 */
export function isDependencyMet({ catalog, configIndex, controller, defaultReturnValue = false, device, option }: {

  catalog: CatalogIndex;
  configIndex: ConfigIndex;
  controller?: string;
  defaultReturnValue?: boolean;
  device?: string;
  option: string;
}): boolean {

  const parent = catalog.groupParents[option];

  if(!parent) {

    return true;
  }

  return resolveScope({ catalog, configIndex, controller, defaultReturnValue, device, option: parent }).enabled;
}

// Utility function to parse and return a numeric configuration parameter. Preserves the (null, undefined, parsed-number, undefined-on-NaN) discrimination so
// callers can distinguish "disabled" from "unset" from "set but unparseable" without a second probe of the model.
function parseOptionNumeric(option: Nullable<string | undefined>, convert: (value: string) => number): Nullable<number | undefined> {

  // If the option is disabled (null) or we don't have it configured (undefined), preserve that distinction in the return value so callers can tell the two apart.
  if(!option) {

    return (option === null) ? null : undefined;
  }

  // Convert it to a number, if needed.
  const convertedValue = convert(option);

  // Let's validate to make sure it's really a number.
  if(Number.isNaN(convertedValue)) {

    return undefined;
  }

  // Return the value.
  return convertedValue;
}

/**
 * FeatureOptions provides a hierarchical feature option system for plugins and applications.
 *
 * Supports global, controller, and device-level configuration, value-centric feature options, grouping, and category management.
 *
 * This class is the imperative façade over the pure functional core exposed by this module ({@link buildCatalogIndex}, {@link applySetOption},
 * {@link applyClearOption}, {@link resolveScope}, etc.). Reducer-driven consumers that want immutable state should call the pure functions directly; imperative
 * Node-side plugin code uses this class for the same semantics with mutation-friendly ergonomics.
 *
 * @example
 *
 * ```ts
 * // Define categories and options.
 * const categories = [
 *
 *   { name: "motion", description: "Motion Options" },
 *   { name: "audio", description: "Audio Options" }
 * ];
 *
 * const options = {
 *
 *   motion: [
 *     { name: "detect", default: true, description: "Enable motion detection." }
 *   ],
 *
 *   audio: [
 *     { name: "volume", default: false, defaultValue: 50, description: "Audio volume." }
 *   ]
 * };
 *
 * // Instantiate FeatureOptions.
 * const featureOpts = new FeatureOptions(categories, options, ["Enable.motion.detect"]);
 *
 * // Check if a feature is enabled.
 * const motionEnabled = featureOpts.test("motion.detect");
 *
 * // Get a value-centric feature option.
 * const volume = featureOpts.value("audio.volume");
 * ```
 *
 * @see FeatureOptionEntry
 * @see FeatureCategoryEntry
 * @see OptionScope
 */
export class FeatureOptions {

  /**
   * Default return value for unknown options (defaults to false).
   */
  public defaultReturnValue: boolean;

  #catalog: CatalogIndex;
  #configIndex: ConfigIndex;
  #configuredOptions: string[];

  /**
   * Create a new FeatureOptions instance.
   *
   * @param categories        - Array of feature option categories.
   * @param options           - Dictionary mapping category names to arrays of feature options.
   * @param configuredOptions - Optional. Array of currently configured option strings.
   *
   * @example
   *
   * ```ts
   * const featureOpts = new FeatureOptions(categories, options, ["Enable.motion.detect"]);
   * ```
   */
  constructor(categories: FeatureCategoryEntry[], options: Record<string, FeatureOptionEntry[]>, configuredOptions: string[] = []) {

    this.#catalog = buildCatalogIndex(categories, options);
    this.#configuredOptions = configuredOptions;
    this.#configIndex = buildConfigIndex(this.#catalog, configuredOptions);
    this.defaultReturnValue = false;
  }

  /**
   * Return the default value for an option.
   *
   * @param option        - Feature option to check.
   *
   * @returns Returns true or false, depending on the option default.
   */
  public defaultValue(option: string): boolean {

    return getDefaultValue({ catalog: this.#catalog, defaultReturnValue: this.defaultReturnValue, option });
  }

  /**
   * Return whether the option explicitly exists in the list of configured options.
   *
   * @param option        - Feature option to check.
   * @param id            - Optional device or controller scope identifier to check.
   *
   * @returns Returns true if the option has been explicitly configured, false otherwise.
   */
  public exists(option: string, id?: string): boolean {

    return optionExists({ configIndex: this.#configIndex, id, option });
  }

  /**
   * Return whether a grouped option's parent is currently enabled at the given scope. For options that aren't grouped (no `group` property in the catalog entry),
   * always returns `true` - there is no dependency to fail. For grouped options, traverses the scope hierarchy via {@link resolveScope} to evaluate the parent's
   * effective state at the requested device + controller view.
   *
   * This is the SSOT for "is this option's row currently usable?" Every caller that wants to know whether to render a grouped option's row, count it as visible,
   * or honor its dependency-hidden state asks the model rather than reconstructing the parent path themselves. The reverse-lookup from option to parent uses the
   * pre-built {@link CatalogIndex.groupParents} index, so the predicate is O(1) regardless of option-key length.
   *
   * @param option        - Fully-qualified feature option string (e.g., `"Motion.Sensitivity"`). Case-insensitive.
   * @param device        - Optional device scope identifier, forwarded to {@link resolveScope}.
   * @param controller    - Optional controller scope identifier, forwarded to {@link resolveScope}.
   *
   * @returns `true` when the option has no dependency or its parent is currently enabled at the requested scope; `false` when the parent is currently disabled.
   */
  public isDependencyMet(option: string, device?: string, controller?: string): boolean {

    return isDependencyMet({ catalog: this.#catalog, configIndex: this.#configIndex, controller, defaultReturnValue: this.defaultReturnValue, device, option });
  }

  /**
   * Return a fully formed feature option string.
   *
   * @param category      - Feature option category entry or category name string.
   * @param option        - Feature option entry of option name string.
   *
   * @returns Returns a fully formed feature option in the form of `category.option`.
   */
  public expandOption(category: FeatureCategoryEntry | string, option: FeatureOptionEntry | string): string {

    return expandOption(category, option);
  }

  /**
   * Parse a floating point feature option value.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the value of a value-centric option as a floating point number, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.
   */
  public getFloat(option: string, device?: string, controller?: string): Nullable<number | undefined> {

    return parseOptionNumeric(this.value(option, device, controller), Number.parseFloat);
  }

  /**
   * Parse an integer feature option value.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the value of a value-centric option as an integer, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.
   */
  public getInteger(option: string, device?: string, controller?: string): Nullable<number | undefined> {

    return parseOptionNumeric(this.value(option, device, controller), Number.parseInt);
  }

  /**
   * Return whether an option has been set in either the device or controller scope context.
   *
   * @param option        - Feature option to check.
   *
   * @returns Returns true if the option is set at the device or controller level and false otherwise.
   */
  public isScopeDevice(option: string, device: string): boolean {

    return this.exists(option, device);
  }

  /**
   * Return whether an option has been set in the global scope context.
   *
   * @param option        - Feature option to check.
   *
   * @returns Returns true if the option is set globally and false otherwise.
   */
  public isScopeGlobal(option: string): boolean {

    return this.exists(option);
  }

  /**
   * Return whether an option is value-centric or not.
   *
   * @param option        - Feature option entry or string to check.
   *
   * @returns Returns true if it is a value-centric option and false otherwise.
   */
  public isValue(option: string): boolean {

    return isValueOption(this.#catalog, option);
  }

  /**
   * Emit an INFO-level log line for a feature option, but only when the user's effective configuration deviates from the declared default.
   *
   * This is the executable form of the project-wide startup-log convention: restating a default is log noise, and deviations should be reported in both directions - a
   * default-off feature the user turned on, a default-on feature the user turned off, and a value the user customized away from the registered default. Callers pass
   * the option key and a human-readable label; this method handles the direction detection and the message synthesis so every plugin emits the same shape from one
   * place. If the convention ever evolves, every call site picks up the change without any source modification.
   *
   * Polymorphic over option type, mirroring how {@link FeatureOptions.test} and {@link FeatureOptions.value} already dispatch on whether the option is value-centric.
   * The five distinct emitted-line shapes, across these state combinations:
   *
   * | Option type      | User state vs. default                                  | Emitted line                       |
   * |------------------|---------------------------------------------------------|------------------------------------|
   * | Boolean          | matches default                                         | (silent)                           |
   * | Boolean          | default off, enabled                                    | `<label> enabled.`                 |
   * | Boolean          | default on, disabled                                    | `<label> disabled.`                |
   * | Value-centric    | both axes match                                         | (silent)                           |
   * | Value-centric    | default on, disabled                                    | `<label> disabled.`                |
   * | Value-centric    | default off, enabled (value matches or differs)         | `<label> enabled at <value>.`      |
   * | Value-centric    | default on, enabled, value differs from declared default | `<label> set to <value>.`          |
   *
   * Value rendering consults the catalog-declared {@link FeatureOptionEntry.render} when present; otherwise the raw string returned by {@link FeatureOptions.value}
   * is used. The renderer may be either a {@link FeatureOptionFormatter} string naming a built-in formatter from the shared registry (preferred when the format exists
   * there, since this keeps the catalog JSON-serializable and lets every plugin share one implementation) or an inline function for bespoke cases. Declaring the
   * renderer at the option's catalog entry keeps display formatting a single source of truth shared by `logFeature` and any future surface that displays the value.
   *
   * Scope precedence matches {@link FeatureOptions.test}: device wins over controller wins over global wins over default. Pass the scope arguments that describe the
   * vantage point you want to log from - typically a device identifier for accessory-level configuration, optionally with a controller identifier when the plugin's
   * controller scope is meaningful (e.g., UniFi Protect controllers).
   *
   * @param option        - Feature option to check (same key shape as {@link FeatureOptions.test}; case-insensitive).
   * @param label         - Human-readable label that prefixes the emitted message. Used verbatim as the first `%s` argument; should be a noun phrase like "Motion sensor"
   *                        or "Read-only mode" so the rendered line reads naturally ("Motion sensor enabled." / "Read-only mode disabled.").
   * @param log           - The plugin's logger. The emitted message is INFO-level; debug-level enumeration of the full feature surface is a separate concern handled by
   *                        the caller.
   * @param device        - Optional device scope identifier, forwarded to {@link FeatureOptions.test}.
   * @param controller    - Optional controller scope identifier, forwarded to {@link FeatureOptions.test}.
   *
   * @example
   *
   * ```ts
   * // Boolean option, inside a plugin's `configureMotion()` for a specific device:
   * featureOptions.logFeature("Motion", "Motion sensor", log, device.mac);
   *
   * // Value-centric option - the message shape adapts to which axis (boolean, value, or both) deviated:
   * featureOptions.logFeature("Stream.Bandwidth", "Bandwidth", log, device.mac);
   *
   * // With a controller scope:
   * featureOptions.logFeature("HKSV.Record", "HKSV recording", log, device.mac, controller.id);
   * ```
   */
  public logFeature(option: string, label: string, log: HomebridgePluginLogging, device?: string, controller?: string): void {

    const effective = this.test(option, device, controller);
    const defaultEnabled = this.defaultValue(option);
    const booleanDeviates = effective !== defaultEnabled;

    // Disabled: emit only when the user turned off something whose default is on. Value-centric options collapse to the same shape here - the value is irrelevant
    // when the option is off, and the operator only needs to know it was disabled.
    if(!effective) {

      if(booleanDeviates) {

        log.info("%s disabled.", label);
      }

      return;
    }

    // Enabled. For plain boolean options that is the whole story.
    if(!this.isValue(option)) {

      if(booleanDeviates) {

        log.info("%s enabled.", label);
      }

      return;
    }

    // Enabled, value-centric option. Resolve the effective value (an explicit user value when set, otherwise the registered catalog default) and compare against the
    // declared default to detect value-axis deviation. We compare normalized strings because the registry stores stringified user input while the catalog's defaultValue
    // is typed as `number | string`; coercing both to string is the one normalization that makes the comparison total.
    const declaredDefault = this.#catalog.valueOptions[option.toLowerCase()]?.toString();
    const effectiveValue = this.value(option, device, controller) ?? declaredDefault;
    const valueDeviates = (effectiveValue !== undefined) && (effectiveValue !== declaredDefault);

    if(!booleanDeviates && !valueDeviates) {

      return;
    }

    // Defensive fallback for the degenerate case of a value-centric catalog entry with no concrete value anywhere - no registered default and no explicit value at any
    // scope. The option is enabled per the user's choice but there is nothing meaningful to render after "at"; emitting "<label> enabled at ." would mislead a reader,
    // so we collapse to the boolean-axis message shape and let the catalog declaration's malformed-ness surface elsewhere.
    if(effectiveValue === undefined) {

      log.info("%s enabled.", label);

      return;
    }

    const renderedValue = this.#catalog.renderers[option.toLowerCase()]?.(effectiveValue) ?? effectiveValue;

    // Message shape splits on which axis deviated: "enabled at" when the user turned the feature on (boolean axis crossed), "set to" when only the value moved away
    // from the registered default. Both forms always carry the effective value, since for value-centric options the value is what the operator most needs to see.
    if(booleanDeviates) {

      log.info("%s enabled at %s.", label, renderedValue);

      return;
    }

    log.info("%s set to %s.", label, renderedValue);
  }

  /**
   * Remove every configured-options entry addressing the given option at the given scope.
   *
   * Callers express intent ("forget any configuration for option X at scope Y") and the model owns the entry-format end-to-end. The match is value-aware: for
   * value-centric options it covers both the bare scoped entry and any entry carrying a single trailing value segment, so a subsequent {@link setOption} cleanly
   * replaces whatever was there. No-op when no entry addresses the target scope, so callers can treat this as an idempotent reset.
   *
   * @param args - The addressing intent: option key and optional scope id. See {@link ClearOptionArgs}.
   *
   * @example
   *
   * ```ts
   * // Remove any configured value for "Audio.Volume" on device ABC123 (drops both `Enable.Audio.Volume.ABC123` and `Enable.Audio.Volume.ABC123.50`).
   * featureOpts.clearOption({ option: "Audio.Volume", id: "ABC123" });
   * ```
   */
  public clearOption(args: ClearOptionArgs): void {

    const next = applyClearOption({ args, catalog: this.#catalog, configuredOptions: this.#configuredOptions });

    // Reference-stable no-op: nothing matched, so the array and the index are already coherent. Skip the rebuild and preserve the array reference so callers
    // holding a snapshot see a stable identity for unchanged state.
    if(next === this.#configuredOptions) {

      return;
    }

    this.#configuredOptions = next as string[];

    // Only the index depends on the configured-options array; the catalog-derived state is invariant across config mutations and need not be touched here.
    this.#configIndex = buildConfigIndex(this.#catalog, this.#configuredOptions);
  }

  /**
   * Set the enabled state (and optionally the value) for an option at a given scope, replacing any prior entry for the same option-at-scope.
   *
   * This is the single mutation primitive for individual feature options. Callers express intent ("enable option X at scope Y, with value Z") and the model owns
   * both the encoding and the prior-entry replacement - the configured-options array is canonical, the lookup index is rebuilt automatically, and the entry-string
   * format never leaks past this method. Value segments are emitted only when `enabled` is true and the option is value-centric; passing `value` for a non-value or
   * disabled option is silently dropped because the resulting entry would be meaningless under the resolution rules.
   *
   * @param args - The mutation intent: option key, optional scope id, enabled state, and optional value. See {@link SetOptionArgs}.
   *
   * @example
   *
   * ```ts
   * // Disable "Motion.Detect" globally.
   * featureOpts.setOption({ enabled: false, option: "Motion.Detect" });
   *
   * // Enable "Audio.Volume" on device ABC123 with value 50, replacing any prior device-scoped entry for the same option.
   * featureOpts.setOption({ enabled: true, id: "ABC123", option: "Audio.Volume", value: 50 });
   * ```
   */
  public setOption(args: SetOptionArgs): void {

    this.#configuredOptions = applySetOption({ args, catalog: this.#catalog, configuredOptions: this.#configuredOptions });

    // Only the index depends on the configured-options array; the catalog-derived state is invariant across config mutations and need not be touched here.
    this.#configIndex = buildConfigIndex(this.#catalog, this.#configuredOptions);
  }

  /**
   * Return the scope hierarchy location of an option.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the location in the scope hierarchy of `option`.
   */
  public scope(option: string, device?: string, controller?: string): OptionScope {

    return resolveScope({ catalog: this.#catalog, configIndex: this.#configIndex, controller, defaultReturnValue: this.defaultReturnValue, device, option }).scope;
  }

  /**
   * Return the current state of a feature option, traversing the scope hierarchy.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns true if the option is enabled, and false otherwise.
   */
  public test(option: string, device?: string, controller?: string): boolean {

    return resolveScope({ catalog: this.#catalog, configIndex: this.#configIndex, controller, defaultReturnValue: this.defaultReturnValue, device, option }).enabled;
  }

  /**
   * Return the value associated with a value-centric feature option, traversing the scope hierarchy.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the current value associated with `option` if the feature option is enabled, `null` if disabled (or not a value-centric feature option), or
   *          `undefined` if it's not specified.
   */
  public value(option: string, device?: string, controller?: string): Nullable<string | undefined> {

    // If this isn't a value-centric feature option, we're done.
    if(!this.isValue(option)) {

      return null;
    }

    // Resolve the option through the scope hierarchy in a single traversal. This gives us the scope, enabled state, and raw value in one pass.
    const resolved = resolveScope({ catalog: this.#catalog, configIndex: this.#configIndex, controller, defaultReturnValue: this.defaultReturnValue, device, option });

    // If the option has been explicitly disabled at any scope, or wasn't configured and its default is disabled, there's no value.
    if(!resolved.enabled) {

      return null;
    }

    // If we found an explicit value in the index, return it.
    if(resolved.optionValue) {

      return resolved.optionValue;
    }

    // The option is enabled but has no explicit value. If it wasn't configured at any scope (scope is "none"), fall back to the registered default value.
    if(resolved.scope === "none") {

      return this.#catalog.valueOptions[option.toLowerCase()]?.toString() ?? null;
    }

    // The option is enabled at an explicit scope but no value was provided...return undefined to indicate "enabled, no value."
    return undefined;
  }

  /**
   * Return the list of available feature option categories.
   *
   * @returns Returns the current list of available feature option categories.
   */
  public get categories(): FeatureCategoryEntry[] {

    // The catalog stores the categories as readonly to encode the immutability invariant the pure functional core relies on. The public getter returns the
    // historical mutable type for backward compatibility - the array is the same identity the caller passed at construction (or via the setter), so consumers
    // mutating it would be mutating the catalog regardless of the return type. The readonly annotation is the discipline, not a runtime enforcement.
    return this.#catalog.categories as FeatureCategoryEntry[];
  }

  /**
   * Set the list of available feature option categories.
   *
   * @param category      - Array of available categories.
   */
  public set categories(category: FeatureCategoryEntry[]) {

    // The catalog derivation depends on categories, and the value-options registry (rebuilt by the catalog pass) feeds the index parser, so both stages must run
    // in order. The class assembles a new catalog from the new categories + current options, then a new config index from the new catalog + current configured
    // options.
    this.#catalog = buildCatalogIndex(category, this.#catalog.options);
    this.#configIndex = buildConfigIndex(this.#catalog, this.#configuredOptions);
  }

  /**
   * Return the list of currently configured feature options.
   *
   * @returns Returns the currently configured list of feature options.
   */
  public get configuredOptions(): string[] {

    return this.#configuredOptions;
  }

  /**
   * Set the list of currently configured feature options.
   *
   * @param options       - Array of configured feature options.
   */
  public set configuredOptions(options: string[] | null | undefined) {

    this.#configuredOptions = options ?? [];

    // The catalog-derived state is invariant across config mutations; only the lookup index needs rebuilding.
    this.#configIndex = buildConfigIndex(this.#catalog, this.#configuredOptions);
  }

  /**
   * Return a reverse index mapping each child option to its parent group. This provides O(1) child-to-parent lookups, complementing the forward `groups` map that maps
   * parents to their children.
   *
   * @returns Returns a record mapping child option names to their parent group names.
   */
  public get groupParents(): Record<string, string> {

    return this.#catalog.groupParents;
  }

  /**
   * Return the list of available feature option groups.
   *
   * @returns Returns the current list of available feature option groups.
   */
  public get groups(): Record<string, string[]> {

    return this.#catalog.groups as Record<string, string[]>;
  }

  /**
   * Return the list of available feature options.
   *
   * @returns Returns the current list of available feature options.
   */
  public get options(): Record<string, FeatureOptionEntry[]> {

    return this.#catalog.options as Record<string, FeatureOptionEntry[]>;
  }

  /**
   * Set the list of available feature options.
   *
   * @param options       - Array of available feature options.
   */
  public set options(options: Record<string, FeatureOptionEntry[]> | null | undefined) {

    // The catalog derivation depends on the option definitions, and the index parser consults the resulting value-options registry, so both stages must run in
    // order. The class assembles a new catalog from the current categories + new options, then a new config index from the new catalog + current configured options.
    this.#catalog = buildCatalogIndex(this.#catalog.categories, options ?? {});
    this.#configIndex = buildConfigIndex(this.#catalog, this.#configuredOptions);
  }
}
