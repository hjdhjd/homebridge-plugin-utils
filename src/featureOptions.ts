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
 *     {@link applyClearOption}, {@link normalizeConfiguredOptions}) compute new configured-options arrays without mutation; pure queries ({@link resolveScope},
 *     {@link getDefaultValue}, {@link isValueOption}, {@link hasValueContent}, {@link optionExists}, {@link isDependencyMet}, {@link expandOption},
 *     {@link enumerateConfiguredEntries}) answer scope-aware questions over those indices. This is the single source of truth for option-array semantics, consumed
 *     wherever immutable state is the discipline (reducer-driven UIs, server-side renderers, time-travel debuggers, future consumers we have not built yet).
 *
 *   - **Imperative class façade.** {@link FeatureOptions} bundles a {@link CatalogIndex}, a configured-options array, and a {@link ConfigIndex} into one object whose
 *     mutating methods (`setOption` / `clearOption` / the setters) delegate to the pure transforms internally. This is the legacy-friendly surface used by every
 *     plugin's Node-side code; the class's public API surface is identical to the pure-function core it delegates to.
 *
 * Two surfaces, one set of semantics. The class is a convenience over the pure functions, not a parallel implementation.
 *
 * ### The configured-options entry grammar
 *
 * A configured option is one string. `Enable.Motion.Detect` and `Disable.Motion.Detect.ABC123` address a boolean option globally and at a scope; the segment after
 * the option name, when present, is a device or controller id.
 *
 * A value-centric option carries its value behind a payload delimiter, which is the canonical form and the only form written by
 * {@link FeatureOptions.setOption | setOption}:
 *
 * ```
 * Enable.Audio.Volume=50                          a global value
 * Enable.Audio.Volume.Kitchen=St. Cecilia's Mix   a scoped value
 * ```
 *
 * Everything ahead of the first "=" is the address and everything behind it is the value, so a value is free-form: periods, interior spaces, and further "="
 * characters all pass through untouched, and only the first "=" splits. Giving the payload its own delimiter is what lets dots address and nothing else.
 *
 * Whitespace around the delimiter is tolerated - `Enable.Audio.Volume.Kitchen = 50` reads exactly as the tight form - because the address is right-trimmed and
 * the value trimmed. The one thing this puts out of reach is a value with leading or trailing spaces, which the writer already excludes by trimming what it
 * composes. The tolerance reaches only around "="; dots stay exact, so a space after a dot is part of the id.
 *
 * The delimiter claims an entry only when the canonical reading holds together end to end: the address ahead of the "=" must be the option name alone or the
 * option name plus a single dot-free id, and a scoped payload must carry content - at least one character that is not the delimiter itself (see
 * {@link hasValueContent}, which also explains why the value domain draws that line). An entry that fails either test reads under the legacy dot grammar
 * instead, with the "=" as ordinary value text: `Enable.Security.Key.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` ends in a bare delimiter that carries
 * nothing, so the whole tail stays a legacy global value, trailing "=" intact. One consequence is that a value-centric option storing a single value and enabled
 * at a device or controller scope always carries a value - the grammar has no scoped spelling for "enabled here, nothing given" - so
 * {@link FeatureOptions.setOption | setOption} reduces that request to clearing the scope.
 *
 * An option declaring {@link FeatureOptionEntry.multiple} is the exception, because for a list "on, with nothing selected" is a selection like any other and has
 * to be tellable from the bare enable that resolves the registered default. Its zero-length payload therefore reads canonically at either scope, so
 * `Enable.Motion.SmartDetect=` and `Enable.Motion.SmartDetect.ABC123=` each store the empty selection. The exception reaches the empty payload alone: an all-"="
 * payload is base64-padding-shaped and stays with the legacy reading for every option.
 *
 * The older form, where a value was simply the last dot-separated segment (`Enable.Audio.Volume.50`), still parses so hand-authored configurations keep working;
 * {@link normalizeConfiguredOptions} rewrites entries into the canonical form as configurations are saved.
 *
 * ### Declared scopes
 *
 * A catalog entry may name the levels it belongs to through {@link FeatureOptionEntry.scopes}, in the `controller | device | global` vocabulary this module
 * already speaks. The declaration is enforced at every framework-owned surface: {@link resolveScope} walks only the declared levels, the webUI renders an option's
 * row only on views the declaration admits, and the webUI's inheritance probe consults it too, so a click-time prediction and resolution always agree. An entry
 * that declares nothing is valid at every level, which is what lets a plugin narrow its catalog one entry at a time.
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
 * durations. Extend the union when a new format is genuinely shared across multiple plugins. Resist adding a formatter speculatively - the function escape
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
  kbps: (value: string): string => formatBps(Number.parseFloat(value) * 1000),

  // Duration stored as milliseconds. formatMs promotes through ms / s / min / hr / day based on magnitude.
  ms: (value: string): string => formatMs(Number.parseFloat(value)),

  // Percentage rendered through the shared formatPercent helper so the precision policy stays uniform across every formatter in the registry - whole numbers carry
  // no decimal, fractional values get one decimal place.
  percent: (value: string): string => formatPercent(Number.parseFloat(value)),

  // Duration stored as seconds. formatSeconds promotes through s / min / hr / day based on magnitude.
  seconds: (value: string): string => formatSeconds(Number.parseFloat(value))
};

// Resolve a built-in formatter by name. Accepts an arbitrary string (not just a `FeatureOptionFormatter` literal) so the lookup naturally returns `undefined` when a
// caller bypasses the type system - via JS, an `as` cast, or an out-of-date type definition - and passes an unrecognized name. Encapsulating the type-widening cast
// here keeps the call site clean and names the intent: "look up a registered formatter by name; the result may not exist." Without the widening at this single
// boundary, TypeScript narrows the literal-keyed indexing tightly enough that the runtime safety check at the call site looks dead, and the runtime guard would either be
// suppressed (silently weakening defense against JS callers) or removed (allowing the silent-fallback failure mode the design exists to prevent).
function resolveBuiltInFormatter(name: string): ((value: string) => string) | undefined {

  return (BUILT_IN_FORMATTERS as Readonly<Record<string, (value: string) => string>>)[name];
}

/**
 * The scope levels at which a feature option may be configured, and the vocabulary a catalog entry uses to declare where it belongs. These are the same levels
 * {@link resolveScope} walks: {@link OptionScope} is this union plus the `"none"` outcome resolution reports when nothing was configured anywhere, so the
 * declaration side and the resolution side read from one vocabulary and cannot drift apart.
 */
export type FeatureOptionScope = "controller" | "device" | "global";

/**
 * One selectable choice a value-centric option offers: what the editor shows, and what the configuration stores when the user picks it. A catalog declares its
 * choices inline on {@link FeatureOptionEntry.choices}, or names a source the plugin's webUI registers and that derives the list from the device in view.
 *
 * {@link isValidChoice} is what makes a choice legal, and it is the one rule both sides answer to: {@link buildCatalogIndex} applies it to every inline choice at
 * catalog-build time, and the webUI's projection applies it to whatever a source returns at resolve time.
 *
 * @property label - The text the editor shows for this choice.
 * @property value - The text the configuration stores when this choice is picked.
 *
 * @category Feature Options
 */
export interface FeatureOptionChoice {

  label: string;
  value: string;
}

/**
 * The one reserved spelling of a default meaning "every member of this option's domain", declared on a `multiple` option that also declares
 * {@link FeatureOptionEntry.choices}. A domain a source derives from a device record cannot be enumerated in the catalog, so a multi-select over one has no other
 * way to say that everything is selected to begin with, and an empty default faked into that role would leave the editor's boxes describing a selection the
 * resolution does not have.
 *
 * It is catalog data and nothing else. The editor never writes it into the configuration - a user's edit stores the explicit list, and a selection covering the
 * whole domain clears the entry so the option resumes tracking that domain - while a Node-side read expands it against a domain through {@link selectValues}. It
 * has no meaning on an option that is not `multiple` or declares no choices, and {@link buildCatalogIndex} rejects both declarations.
 *
 * @category Feature Options
 */
export const ALL_CHOICES = "*";

/**
 * Entry describing a feature option.
 *
 * @property choices         - Optional. The list of values this option offers, which makes its editor a picker rather than a free-text field. A string names a
 *                             source the plugin's webUI registers in its `ui.choices` bag; an array is a fixed list declared inline. Either way the editor offers
 *                             the list and the configuration stores the chosen value, or values for a `multiple` option. Editor-only, exactly as `secret` is:
 *                             parsing, storage, scope resolution, and {@link FeatureOptions.value} never consult it. A source resolver receives the controller,
 *                             the device (undefined at global and controller scope), and the option, and returns the list for that context; it must be a pure,
 *                             cheap function of those three, since it runs on every projection recompute - the same cadence as the webUI's `validOption`. A
 *                             string naming a source no resolver answers to fails the webUI at catalog load. An inline list is validated here at catalog build,
 *                             members and default alike; a source-backed default cannot be, because the domain it draws on exists only on the page that holds the
 *                             device record.
 * @property default         - Default enabled/disabled state for this feature option.
 * @property defaultValue    - Optional. Default value for value-based feature options.
 * @property description     - Description of the feature option for display or documentation.
 * @property group           - Optional. Grouping/category for the feature option.
 * @property inputSize       - Optional. Width of the input field for a value-based feature option. Defaults to 5 characters.
 * @property meta            - Optional. An opaque, plugin-private annotation channel the core never interprets. HBPU's types deliberately cannot see inside `TMeta`;
 *                             the value is carried verbatim through the catalog and forwarded to the documentation renderer's closures (the only surface that knows its
 *                             concrete shape). This mirrors the OpenAPI `x-*` extension discipline, made type-safe: a plugin parameterizes the entry with its own
 *                             annotation type, the core treats it as `unknown`, and the round-trip stays structurally unchanged rather than a naming convention.
 * @property multiple        - Optional. True declares the option's value a LIST rather than a single value, stored in the shared list grammar as one comma-joined
 *                             string ({@link parseValueList} and {@link formatValueList} are the pair that reads and writes it). With `choices` the editor is a
 *                             checkbox group over the offered list; without them it is a free-form list the user builds entry by entry. With `choices` the default
 *                             may be {@link ALL_CHOICES}, standing for every member of the option's domain. The engine sees one string throughout, which
 *                             {@link FeatureOptions.valueList} is the read that splits, and the declaration reaches the grammar in one place: a list can be
 *                             explicitly empty, so a zero-length payload stores that selection at either scope rather than reading as no value at all.
 * @property name            - Name of the feature option (used in option strings).
 * @property render          - Optional. Maps the raw stored value of a value-centric option to a display string. Either a {@link FeatureOptionFormatter} string naming
 *                             a built-in formatter (preferred when the format already exists in the registry, since this keeps the enclosing catalog JSON-serializable
 *                             and lets every plugin share one implementation) or an inline function for bespoke formatting the registry does not cover. Consulted by
 *                             {@link FeatureOptions.logFeature} when emitting deviation lines so the catalog stays the single source of truth for how an option's
 *                             value renders; ignored for plain boolean options. When absent, values render as the raw string returned by {@link FeatureOptions.value}.
 *                             An unrecognized formatter name throws at catalog-rebuild time, surfacing the misconfiguration loudly rather than silently producing the
 *                             raw-value fallback.
 * @property scopes          - Optional. The scope levels this option may be configured at - one or more of them, named in the {@link FeatureOptionScope} vocabulary.
 *                             Absent means every level, which is what an entry that declares nothing gets. Declared, it is true at every surface the framework
 *                             owns: the option renders only on views the declaration admits - a global view needs `"global"`, a controller view needs `"controller"`,
 *                             and a device view needs either `"controller"` or `"device"` - it resolves only at the declared levels, and a row inherits from a higher
 *                             scope only through them. What you cannot resolve, you are neither offered nor promised through inheritance. Which devices see a
 *                             device-view row stays with the plugin's `validOption`, refining the rows the declaration already admits. Declare consistent levels
 *                             across a group: a child's dependency check resolves the PARENT's option, so a parent declared narrower than its children ignores parent
 *                             configuration at exactly the levels the children are still editable from. The tuple is non-empty by construction, since an option
 *                             declaring no level at all would render nowhere and resolve nowhere.
 * @property secret          - Optional. True declares that the option's value is a secret the settings page must not display in clear text by default: the field
 *                             renders masked, with a reveal the user operates when they want to read or check what they typed. Presentation only - parsing, storage,
 *                             scope resolution, and the documentation renderer treat a secret option exactly like any other value option, and its value lands in
 *                             `config.json` as plain text like every other value. What the masking buys is protection from someone reading the settings page over
 *                             the user's shoulder; it is not secrecy at rest, and a plugin handling real credentials should say so in the option's description.
 *
 * @typeParam TMeta - The concrete type of the opaque {@link FeatureOptionEntry.meta} annotation. Defaults to `unknown`, so a bare `FeatureOptionEntry` (the form every
 *                    existing core consumer uses) resolves to `FeatureOptionEntry<unknown>` and stays assignable to the parameterized form, keeping the core non-generic.
 *
 * @example
 *
 * ```ts
 * // An irrigation plugin whose controllers own zones. Exposing a zone is meaningful for the controller as a whole and for each zone beneath it; a per-zone runtime
 * // cap is a zone-level concern, so declaring it device-only keeps it off the account-wide page where one save would have applied it to every zone at once.
 * const options: Record<string, FeatureOptionEntry[]> = {
 *
 *   Zone: [
 *
 *     { default: true, description: "Expose this zone in HomeKit.", name: "Enable", scopes: [ "controller", "device" ] },
 *     { default: false, defaultValue: 300, description: "Maximum zone runtime, in seconds.", name: "Runtime", scopes: ["device"] }
 *   ]
 * };
 * ```
 */
export interface FeatureOptionEntry<TMeta = unknown> {

  choices?: string | readonly FeatureOptionChoice[];
  default: boolean;
  defaultValue?: number | string;
  description: string;
  group?: string;
  inputSize?: number;
  meta?: TMeta;
  multiple?: boolean;
  name: string;
  render?: FeatureOptionFormatter | ((value: string) => string);
  scopes?: readonly [FeatureOptionScope, ...FeatureOptionScope[]];
  secret?: boolean;
}

/**
 * Entry describing a feature option category.
 *
 * @property description     - Description of the category.
 * @property meta            - Optional. An opaque, plugin-private annotation channel the core never interprets, mirroring {@link FeatureOptionEntry.meta} so the
 *                             category side carries the same typed extension path; the documentation renderer forwards it to the category-scope closure, and the
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
 * Describes all possible scope hierarchy locations for a feature option. The configurable levels are {@link FeatureOptionScope}, shared with the catalog entry's
 * `scopes` declaration; `"none"` is the resolution-only outcome saying no configured entry matched at any level and the catalog default applied.
 */
export type OptionScope = FeatureOptionScope | "none";

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
 * One configured entry's reading of a single feature option: where it sits, what it says, and the value it carries when it carries one. Yielded by
 * {@link enumerateConfiguredEntries}, one record per entry that addresses the option.
 *
 * Distinct from {@link ResolvedOptionEntry}, which answers "what applies here" after walking the hierarchy. This answers "what did the user write", entry by
 * entry, with no precedence applied and no catalog default substituted.
 *
 * @property enabled - True for an `Enable` entry, false for a `Disable` entry.
 * @property id      - The device or controller identifier the entry addresses, in the casing the entry carried. The empty string for a global entry.
 * @property value   - The raw value the entry carries, in the casing the entry carried. Absent when the entry carries none - a boolean option, a `Disable`, or a
 *                     bare enable of a value option. Present and empty for a canonical entry whose payload is empty, which is the same reading the lookup index
 *                     registers for it.
 *
 * @category Feature Options
 */
export interface ConfiguredOptionEntry {

  enabled: boolean;
  id: string;
  value?: string;
}

/**
 * Immutable derived index over the catalog inputs ({@link FeatureCategoryEntry}[] + the options map). Every field except `categories` / `options` is derived from
 * those two; the index bundles them with their derivations so a single value carries everything any caller needs to make catalog-level decisions in O(1).
 *
 * The index is built once per catalog at {@link buildCatalogIndex}; it is unchanged across configured-options mutations, so a consumer that holds a stable
 * reference can rely on its query results until the catalog itself changes. The {@link FeatureOptions} class holds one internally; consumers driving reducers
 * directly hold it as state and reuse it across every dispatch that does not touch the catalog.
 *
 * @property categories             - The raw category list, preserved for callers that need to iterate it (rendering, validation, log enumeration).
 * @property defaults               - Lowercased-key map from canonical option name (the form {@link expandOption} produces) to its catalog-declared default.
 * @property groupParents           - Reverse index from a child option's expanded name to its parent group's expanded name. Catalog case preserved on the keys.
 * @property groups                 - Forward index from a parent group's expanded name to its child options' expanded names.
 * @property options                - The raw options map, preserved alongside categories for the same reason.
 * @property optionsByName          - Lowercased-key map from canonical option name to the raw catalog entry, the general per-option lookup for any consumer that
 *                                    needs the entry itself rather than one of the derivations beside it. Keyed exactly as `valueOptions` is, so one key
 *                                    discipline serves every registry on the index. It is named for what it holds because `entries` already means a category's
 *                                    projected rows in the webUI's vocabulary.
 * @property renderers              - Lowercased-key map from canonical option name to its resolved value renderer (built-in or inline function). Built-in names
 *                                    that fail to resolve throw at index-build time rather than degrading silently at log time.
 * @property scopes                 - Lowercased-key map from canonical option name to the scope levels its catalog entry declares. An option that declares nothing
 *                                    has no key here, which is how the absent-means-every-level default stays free: the lookup returns `undefined` and every
 *                                    consumer reads that as "no restriction." See {@link FeatureOptionEntry.scopes}.
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
  readonly optionsByName: Readonly<Record<string, FeatureOptionEntry>>;
  readonly renderers: Readonly<Record<string, (value: string) => string>>;
  readonly scopes: Readonly<Record<string, readonly FeatureOptionScope[]>>;
  readonly sortedValueOptionNames: readonly string[];
  readonly valueOptions: Readonly<Record<string, number | string | undefined>>;
}

/**
 * Immutable lookup index over the configured-options array. Each lookup key is either the raw lowercased tail of an Enable/Disable entry (always present) or a
 * derived value-key for value-centric Enable entries that carry a value. First-write-wins semantics on collision so the earliest entry in the
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
 * @property id      - Optional device or controller scope identifier. Omit to address the global scope. An identifier carrying a period or an equals sign, or one
 *                     whose composed address names another catalog option, is refused rather than written - see {@link composeScopeId}, which composes a
 *                     controller-qualified identifier under the same rule.
 * @property option  - Feature option to set (case-insensitive).
 * @property value   - Optional value for value-centric options. Honored only when `enabled` is true and the option is value-centric. Free-form at either scope:
 *                     the composed entry carries it behind a payload delimiter, trimmed of surrounding whitespace, and it persists only when content survives the
 *                     trim (see {@link hasValueContent}). At a device or controller scope an enable without value content reduces to clearing the scope, because
 *                     a scoped entry storing a single value always carries one. Supplying the empty string for a {@link FeatureOptionEntry.multiple} option is
 *                     the one value without content that persists: it is the explicit empty selection, and it composes at either scope. Omitting `value`
 *                     entirely says nothing about the selection and keeps the plain enable, for every option alike.
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
 * @property id     - Optional device or controller scope identifier. Omit to address the global scope. An identifier carrying a period or an equals sign, or one
 *                    whose composed address names another catalog option, is refused rather than cleared - see {@link composeScopeId}, which composes a
 *                    controller-qualified identifier under the same rule.
 * @property option - Feature option to clear (case-insensitive).
 */
export interface ClearOptionArgs {

  id?: string;
  option: string;
}

/**
 * Arguments for {@link FeatureOptions.valueList}. Carries the addressing intent - the option and the scope to resolve it at - plus the domain the caller wants the
 * stored value read against.
 *
 * @property controller - Optional controller scope identifier.
 * @property device     - Optional device scope identifier.
 * @property domain     - Optional. The values the option offers in this context, which a plugin derives from whatever the device reported. Supplying it is what
 *                        lets the read drop a stored value the device no longer offers and expand an {@link ALL_CHOICES} default. Omit it for an option whose
 *                        catalog entry declares its choices inline, since the entry already holds them, and for a raw read of what the user stored.
 * @property option     - Feature option to read (case-insensitive).
 */
export interface ValueListArgs {

  controller?: string;
  device?: string;
  domain?: readonly string[];
  option: string;
}

// Internal parse result for a single configured-options entry. `primaryKey` is the raw lowercased tail (always registered on the index). `valueKey` and `value`
// appear only when the tail decomposes as a known value-centric option plus a value - they tell the index where to also register the extracted value for O(1)
// lookups, and `canonicalEntry` carries the same decoding re-composed in the canonical form. `tailOriginal` is that same tail with the casing the entry was
// written in, which is what lets a reader hand back an identifier as the user typed it: the lookup keys are lowercased slices of this string, so a key's length
// is an offset into it. Shared between buildConfigIndex (writer), entryAddressesScope (reader), enumerateConfiguredEntries (reader), and
// normalizeConfiguredOptions (rewriter) so none of them can disagree on what any given entry "means" under the storage format.
interface ParsedConfigEntry {

  canonicalEntry?: string;
  enabled: boolean;
  primaryKey: string;
  tailOriginal: string;
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

// The identifier rule stated for a reader, shared by every message that reports a refusal so the wording a caller is shown cannot drift from what the predicate
// below enforces.
const SCOPE_ID_RULE = "a scope identifier must be a non-empty string carrying neither a period nor an equals sign";

// The single definition of what a scope identifier may spell. The address grammar spends both characters elsewhere - a dot separates address segments, and the
// first "=" ends the address - so an identifier holding either names a scope the grammar has no spelling for. Every surface that composes, validates, or matches a
// scoped address consults this one predicate, which is what keeps the writers and the readers agreeing about which addresses exist at all.
function isValidScopeId(id: string): boolean {

  return !!id.length && !id.includes(".") && !id.includes("=");
}

/**
 * Compose the scope identifier addressing one device of one controller, joining the two parts with a dash.
 *
 * A device identifier that is unique only within its controller cannot address a scope on its own: two controllers can each own a device numbered "27", and a bare
 * "27" would name both of them. Qualifying the device with its controller is the whole answer, and the join lives here so every plugin that needs one spells it the
 * same way rather than hand-rolling a separator alongside its own rules about what may sit either side of it.
 *
 * What comes back is an opaque device identifier as far as the engine is concerned. Nothing decomposes it - resolution matches it whole and the entry grammar
 * carries it whole - so the dash is a convention for the reader's eyes rather than a delimiter anything parses. Both parts must satisfy the identifier rule the
 * address grammar imposes, and a part that does not throws rather than composing an address no reader could resolve. Whether the composed value is unique across
 * the caller's whole identifier space is the caller's own domain knowledge...this guarantees the spelling, not the uniqueness.
 *
 * @param controller - The controller's identifier.
 * @param device     - The device's identifier, unique within that controller.
 *
 * @returns The composed scope identifier, ready to serve as the `id` of any scoped read or write.
 *
 * @throws `Error` naming the offending part when either part is empty or carries a period or an equals sign.
 *
 * @example
 *
 * ```ts
 * // Address one shade of one hub, on a system whose device numbering repeats from hub to hub.
 * featureOpts.setOption({ enabled: false, id: composeScopeId(hub.serialNumber, shade.id), option: "Shade.Calibrate" });
 * ```
 *
 * @category Feature Options
 */
export function composeScopeId(controller: string, device: string): string {

  // Each part is checked in the order it takes in the composed value, so a caller that handed over two unusable parts hears about the first one.
  for(const [ part, value ] of [ [ "controller", controller ], [ "device", device ] ] as const) {

    if(!isValidScopeId(value)) {

      throw new Error("FeatureOptions: the " + part + " part \"" + value + "\" cannot compose a scope identifier, because " + SCOPE_ID_RULE + ".");
    }
  }

  return controller + "-" + device;
}

// Compose the canonical lookup-index target key for a (option, id) pair. This is the form a setOption({ option, id, ... }) call would resolve to on the index, and
// is the comparison key the matcher and writers share.
function targetKey(option: string, id: string | undefined): string {

  return id?.length ? option.toLowerCase() + "." + id.toLowerCase() : option.toLowerCase();
}

// Refuse a mutation whose target the arbitration cannot assign to the option it names, which is what keeps the write path and every reader describing the same set
// of addresses. Two states fail: an identifier carrying a character the address grammar spends elsewhere, and an identifier whose composed key the catalog claims
// as an option in its own right - `Motion.Detect` at a scope named "Sensitivity" composes the `Motion.Detect.Sensitivity` option's global address, so a write
// there would displace that option's setting and a clear would delete it. A global write carries no identifier to check and passes straight through.
function validateWriteTarget({ catalog, id, option }: { catalog: CatalogIndex; id?: string; option: string }): void {

  if(!id?.length || keyAddressesOption({ catalog, key: targetKey(option, id), optionKey: option.toLowerCase() })) {

    return;
  }

  // Which of the two refusals this is follows from the same predicate the arbitration consulted: an identifier the rule turns away is the first, and an identifier
  // the rule accepts can only have failed because the catalog claims the address it composes.
  const reason = isValidScopeId(id) ? ("\"" + option + "." + id + "\" is a feature option in its own right") : SCOPE_ID_RULE;

  throw new Error("FeatureOptions: \"" + id + "\" cannot address a scope of \"" + option + "\", because " + reason + ".");
}

/**
 * Return whether a string survives as a canonical payload once trimmed: at least one character other than the payload delimiter itself must remain. This is the
 * single definition of "carries a value", shared by the entry writer and the entry parser, and it is exported so a UI composing mutations can predict whether a
 * given input will persist - a prediction that has to agree with {@link applySetOption} exactly for every option storing a single value. An option declaring
 * {@link FeatureOptionEntry.multiple} persists one payload this refuses, the empty selection, so a UI predicting for a list asks after the declaration too.
 *
 * The characters this excludes are not arbitrary. A payload that is empty or all "=" is exactly the shape a base64 value's terminal padding takes when a legacy
 * dot-form entry is scanned for the delimiter, so ruling that shape out of the canonical value domain is what lets those entries keep their legacy reading. The
 * empty selection is spelled with the zero-length payload alone and never with the all-"=" one, which keeps that collision guard whole: a list option's stored
 * empty is a shape no legacy entry can produce, since a legacy tail scanned for the delimiter always leaves the padding behind it.
 *
 * @param value - The candidate value text.
 *
 * @returns True when the trimmed text carries at least one non-delimiter character, false otherwise.
 *
 * @category Feature Options
 */
export function hasValueContent(value: string): boolean {

  return /[^=]/.test(value.trim());
}

// Whether a catalog entry declares its value a list. The one spelling of that question inside this module: the writer, the parser, and both reads ask here rather
// than reaching for the flag themselves, so the arms that treat a list differently from a single value cannot come to cover different options. An entry the
// catalog does not carry answers false, which is what lets a caller ask with whatever a name lookup handed back.
function isMultipleOption(entry: FeatureOptionEntry | undefined): boolean {

  return entry?.multiple === true;
}

// The single character separating one entry from the next inside a list-valued option's stored string. The grammar pair below is what reads and writes it, and
// {@link isValidChoice} is its only other consumer - a choice whose value carried the delimiter could not be told apart from two choices once a list stored it.
const VALUE_LIST_DELIMITER = ",";

/**
 * Split a list-valued option's stored string into the entries it names: split on the delimiter, trim each entry, and drop the empties. Paired with
 * {@link formatValueList}, which composes the canonical form, so a parse followed by a format is stable for every string this accepts - hand-authored spacing and
 * stray delimiters normalize the first time the value is written and never move again.
 *
 * Duplicates pass through as written. Whether a repeated entry means anything is the consumer's question, and {@link selectValues} is where a selection over a
 * domain de-duplicates.
 *
 * @param value - The raw stored text.
 *
 * @returns The entries the text names, in the order it names them.
 *
 * @category Feature Options
 */
export function parseValueList(value: string): readonly string[] {

  return value.split(VALUE_LIST_DELIMITER).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Compose the canonical stored form of a list-valued option from its entries: join them with the bare delimiter. The inverse of {@link parseValueList} over every
 * list that function produces, and the one writer of the stored form, so a UI composing a list and a plugin reading it back cannot disagree about the spelling.
 *
 * @param values - The entries to store.
 *
 * @returns The canonical delimiter-joined text.
 *
 * @category Feature Options
 */
export function formatValueList(values: readonly string[]): string {

  return values.join(VALUE_LIST_DELIMITER);
}

/**
 * Return whether a candidate is a legal {@link FeatureOptionChoice}: an object carrying a non-empty `label` and a non-empty `value` that neither contains the list
 * delimiter nor spells {@link ALL_CHOICES}. This is the single definition of what a legal choice is - {@link buildCatalogIndex} applies it to every inline choice a
 * catalog declares, and the webUI's projection applies it to every choice a registered source returns.
 *
 * The two exclusions on the value are what keep a choice addressable once a list stores it. A value carrying the delimiter would come back from
 * {@link parseValueList} as two entries, neither of which names a choice; a value spelling the all-choices default would be indistinguishable from the wildcard
 * the read side expands against the whole domain.
 *
 * @param choice - The candidate.
 *
 * @returns True when the candidate is a legal choice, false otherwise.
 *
 * @category Feature Options
 */
export function isValidChoice(choice: unknown): choice is FeatureOptionChoice {

  if((typeof choice !== "object") || (choice === null)) {

    return false;
  }

  const { label, value } = choice as Record<string, unknown>;

  return (typeof label === "string") && (label.length > 0) && (typeof value === "string") && (value.length > 0) &&
    !value.includes(VALUE_LIST_DELIMITER) && (value !== ALL_CHOICES);
}

/**
 * Arguments for {@link selectValues}. Carries the reading intent: the domain to read against, whether the option stores a list, and the stored text itself.
 *
 * @property domain   - The values available in this context.
 * @property multiple - Whether the option stores a list rather than a single value.
 * @property value    - The stored text, or undefined when nothing is stored.
 *
 * @category Feature Options
 */
export interface SelectValuesArgs {

  domain: readonly string[];
  multiple: boolean;
  value: string | undefined;
}

/**
 * What a stored value selects out of a domain, as {@link selectValues} reads it.
 *
 * @property selected - The members of the domain the stored value selects, in domain order and de-duplicated.
 * @property unknown  - The entries the stored value names that the domain does not carry, in the order it named them and de-duplicated. Preserved rather than
 *                      discarded so a choice the device stopped offering stays visible to both the editor and the plugin.
 *
 * @category Feature Options
 */
export interface ValueSelection {

  readonly selected: readonly string[];
  readonly unknown: readonly string[];
}

/**
 * Read which members of a domain a stored value selects, and which entries it names that the domain does not carry. The single definition of what a stored value
 * SELECTS, shared by the Node-side read ({@link FeatureOptions.valueList}) and the webUI's projection, so a plugin acting on a selection and the editor showing
 * it can never disagree - including about the {@link ALL_CHOICES} wildcard, which is expanded here and nowhere else.
 *
 * An entry the domain lacks is reported rather than discarded. A device that stops offering a value the user chose earlier - a detection type a firmware update
 * withdrew, a relay output a smaller unit does not have - would otherwise have that choice silently dropped from the configuration the next time anything wrote
 * it, so the editor keeps showing it and the plugin can say what it is looking at.
 *
 * @param args
 * @param args.domain   - The values available in this context, in the order they should read. A domain that repeats a value contributes it once.
 * @param args.multiple - Whether the option stores a list. A single-valued option's stored text is one candidate; a list's is parsed by {@link parseValueList}.
 * @param args.value    - The stored text, or undefined when nothing is stored. Undefined and empty alike name no entries.
 *
 * @returns The selected members, in domain order, and the named-but-absent entries, in the order the stored value named them. Both are de-duplicated.
 *
 * @category Feature Options
 */
export function selectValues({ domain, multiple, value }: SelectValuesArgs): ValueSelection {

  // A single-valued option selects at most one member. An empty value selects nothing and reports nothing unknown - the option simply carries no value here -
  // while a value the domain does not offer is the one unknown entry.
  if(!multiple) {

    if(!value?.length) {

      return { selected: [], unknown: [] };
    }

    return domain.includes(value) ? { selected: [value], unknown: [] } : { selected: [], unknown: [value] };
  }

  const entries = parseValueList(value ?? "");

  // The all-choices default stands for the whole domain, expanded here so that every reader downstream sees a concrete list. The wildcard lives in the catalog
  // and in this one branch...nothing else in the system has to know the spelling exists.
  if((entries.length === 1) && (entries[0] === ALL_CHOICES)) {

    return { selected: [...new Set(domain)], unknown: [] };
  }

  const stored = new Set(entries);

  // Selected members read in DOMAIN order - the order the editor lists them in and the order the plugin declared them in - while unknown entries read in the order
  // the stored value named them, since the domain has nothing to say about where a value it does not carry belongs.
  return { selected: [...new Set(domain)].filter((member) => stored.has(member)), unknown: [...stored].filter((entry) => !domain.includes(entry)) };
}

// Compose a configured-options entry from its parts, and the single place in this module that knows how to write one. Everything up to the payload delimiter is
// the address - the canonical action, the option name, and an optional scope id, joined by dots - and everything after it is the value. An absent value composes
// the bare address; a present value composes behind the delimiter, trimmed first, so the canonical value domain excludes edge whitespace and the tolerant parse
// of a hand-spaced entry lands on exactly this form. A present-but-empty value composes the bare delimiter, which the global form produces for any option and the
// scoped form only for a list option storing its empty selection - every other scoped caller guards on hasValueContent first, because a scoped entry without
// value content is a shape the parser hands to the legacy grammar. Pairing this with parseEntry as the single decoder keeps the reader and the writer of the
// storage format from drifting apart.
function composeEntry({ enabled, id, option, value }: { enabled: boolean; id?: string; option: string; value?: string }): string {

  const address = (enabled ? "Enable" : "Disable") + "." + option + (id?.length ? ("." + id) : "");
  const payload = value?.trim();

  return (payload === undefined) ? address : (address + "=" + payload);
}

// Parse a single configured-options entry into the lookup keys it would register on the index. Returns null for non-canonical entries (no action prefix, or an
// unknown action). Otherwise returns the primary (raw-tail) key, optionally accompanied by a derived value key with the extracted value for value-centric Enable
// entries. This is the SSOT for entry decoding - buildConfigIndex (which uses it to populate the index), entryAddressesScope (which uses it to decide whether a
// mutation should replace this entry), and normalizeConfiguredOptions (which uses it to rewrite an entry into canonical form) all consume the same result, so no
// reader or writer of the storage format can disagree about what any given entry "means."
//
// Two value forms decode here. The canonical one is `Enable.Option[.id]=value`, where the first "=" ends the address and everything behind it is the value: dots
// address and "=" carries the payload, each delimiter with a single job. The delimiter claims an entry only when that reading holds together end to end - the
// address must be the option name alone or the option name plus one dot-free id segment, and a scoped payload must carry content per hasValueContent - or be the
// empty payload on an option declaring a list, which is how the empty selection is spelled at a scope. Anything else containing "=" reads under the legacy dot
// grammar with the delimiter as ordinary value text,
// keeping such an entry on the reading it was authored under. The legacy form, accepted for configurations hand-authored before the payload delimiter existed,
// reads a single trailing segment as a global value and a multi-segment tail as an id followed by a value.
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
  const parsed: ParsedConfigEntry = { enabled, primaryKey: tail, tailOriginal };

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

    const optionOriginal = tailOriginal.slice(0, optName.length);
    const remainderOriginal = tailOriginal.slice(optName.length);
    const payloadIndex = remainder.indexOf("=");

    // The payload delimiter gives the value a separator of its own, so dots are left to do one job: addressing. Everything ahead of the first "=" addresses the
    // option, everything behind it is the value - periods, further "=" characters, and interior spaces all ride through verbatim, which is why this is the form
    // the composer writes and the form entries normalize into. The delimiter only claims the entry when the canonical reading holds, though: a shape it cannot
    // account for falls through to the legacy dot grammar below, so an entry authored before the delimiter existed keeps its original meaning even when its
    // value happens to contain "=".
    if(payloadIndex !== -1) {

      // Whitespace around the delimiter is tolerated: the address is right-trimmed and the value trimmed, so a hand-authored `Option.id = value` reads exactly as
      // the tight form the composer writes. The tolerance reaches only around "=" - dots stay exact, so a space after a dot belongs to the id. The one thing this
      // costs is a value with leading or trailing spaces, which the composer already rules out of the value domain by trimming what it writes.
      const address = remainder.slice(0, payloadIndex).trimEnd();
      const value = remainderOriginal.slice(payloadIndex + 1).trim();

      if(!address.length) {

        // Global form: the option name is the whole address. The payload may be empty here - `Enable.Option=` reads as "enabled globally, no value given" -
        // because no legacy value can sit against the option name without a dot ahead of it, so there is no competing reading to protect.
        parsed.canonicalEntry = composeEntry({ enabled, option: optionOriginal, value });
        parsed.valueKey = optName;
        parsed.value = value;

        break;
      }

      const idLower = address.startsWith(".") ? address.slice(1) : "";

      /* Scoped form: exactly one dot-free, non-empty segment sits between the option name and the delimiter, and the payload carries content or is a list
       * option's empty selection. The content requirement is what tells this apart from a legacy value ending in "=": such a tail puts the delimiter at the
       * very end, where this reading would otherwise see an id followed by an empty payload, so a contentless payload sends the entry to the legacy grammar
       * below instead. The lookup key lowercases the id while the re-composition keeps the casing the entry carried, matching what the composer writes - the
       * two have to agree, or normalizing a composed entry would rewrite it.
       *
       * A list option carves out the ZERO-LENGTH payload from that guard, because its empty selection has to be storable at a scope and this is the spelling
       * the composer writes for it. The carve-out reaches no further: an all-"=" payload keeps the legacy reading for every option, so the base64 collision
       * the guard exists for is untouched. What the carve-out does cost is one conversion constraint, stated where the reading lives - a plugin that turns an
       * existing value option into a list accepts the canonical reading on that option's scoped empty payloads, and a configuration saved under it that is
       * then read by an older library resolves those entries under the legacy grammar again.
       */
      if(idLower.length && !idLower.includes(".") && (hasValueContent(value) || (isMultipleOption(catalog.optionsByName[optName]) && !value.length))) {

        parsed.canonicalEntry = composeEntry({ enabled, id: remainderOriginal.slice(1, address.length), option: optionOriginal, value });
        parsed.valueKey = optName + "." + idLower;
        parsed.value = value;

        break;
      }

      // Every other "="-bearing shape - an address the composer never writes, or a contentless payload the carve-out above does not claim - reads under the
      // legacy dot grammar below. The guard beneath this block also preserves the greedy-prefix discipline: when the remainder opens with anything but a dot,
      // this option name was merely a prefix of a longer unrelated token and shorter candidates still get their turn.
    }

    // The next character must be a dot separator. Otherwise this option name is merely a prefix of a longer unrelated token, and we should continue trying shorter
    // candidates.
    if(!remainder.startsWith(".")) {

      continue;
    }

    const extra = remainder.slice(1);
    const extraOriginal = remainderOriginal.slice(1);
    const separatorIndex = extra.indexOf(".");

    // The legacy dot form, accepted for configurations hand-authored before the payload delimiter existed. A single trailing segment is the global value; a
    // multi-segment tail reads as an id followed by a free-form value. The legacy global form has to stay single-segment, because with no id to anchor on a
    // dotted tail cannot be told apart from an id-and-value pair - expressing that unambiguously is exactly what the "=" form is for.
    if(separatorIndex === -1) {

      // A single trailing segment usually does double duty: the index registers it as this option's global value AND, through the primary key, as an enable at a
      // scope named by that same segment. Both readings are live at once, no canonical entry can carry both, and rewriting would settle an ambiguity in the
      // user's file that only the user can settle - so the entry stays exactly as written. A segment containing "=" is the exception: the composer cannot
      // address a scope whose id carries the delimiter, so the scope reading is unwritable, the global-value reading is the only live one, and the entry can
      // modernize into the form that states it outright.
      if(extra.includes("=")) {

        parsed.canonicalEntry = composeEntry({ enabled, option: optionOriginal, value: extraOriginal });
      }

      parsed.valueKey = optName;
      parsed.value = extraOriginal;
    } else {

      const idLower = extra.slice(0, separatorIndex);
      const valueOriginal = extraOriginal.slice(separatorIndex + 1);

      // The id-and-value reading always registers on the index; it re-composes canonically only when the value carries content, because a rewrite has to
      // re-read as exactly what it replaced and the canonical scoped spelling for a contentless payload holds only where the option declares a list.
      if(hasValueContent(valueOriginal)) {

        parsed.canonicalEntry = composeEntry({ enabled, id: extraOriginal.slice(0, separatorIndex), option: optionOriginal, value: valueOriginal });
      }

      parsed.valueKey = optName + "." + idLower;
      parsed.value = valueOriginal;
    }

    break;
  }

  return parsed;
}

// Re-compose a single entry into the canonical form when it decodes as a value form of a catalog option, and hand back the original string when it does not.
// Entries the parser cannot fully account for - boolean options, options absent from the catalog, malformed strings - come through byte-verbatim, because
// rewriting what we do not fully understand is how a configuration file loses information a user put there deliberately.
function normalizeEntry(catalog: CatalogIndex, rawEntry: string): string {

  return parseEntry(catalog, rawEntry)?.canonicalEntry ?? rawEntry;
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

// Compose the one error shape this module raises when a catalog entry declares something the engine cannot honor. Every such throw names its own detail and the
// entry it was declared on and restates neither the module frame nor the punctuation, so the messages read as one family and a new check contributes a phrase
// rather than a sentence.
function catalogError(detail: string, entry: string): Error {

  return new Error("FeatureOptions: " + detail + " declared on option \"" + entry + "\".");
}

// Validate a catalog entry's picker declarations, throwing on any combination the engine cannot honor. `choices` is editor vocabulary the engine reads straight
// past, and `multiple` reaches the engine at one point only - the empty selection the grammar spells and value() answers - so what the two declarations mostly
// need is catalog integrity, which has one home: they are checked here beside the renderer declaration, and a plugin learns about a malformed catalog when it
// builds one rather than when a user opens the settings page.
//
// A source-backed list is the one declaration this cannot fully check. The domain a source derives exists only on the page holding the device record, so neither
// its members nor whether the default names one of them is knowable here; the webUI checks what it can see in turn, rejecting a source name no resolver answers to.
function validateChoiceDeclaration(option: FeatureOptionEntry, entry: string): void {

  const choices = option.choices;
  const isMultiple = isMultipleOption(option);

  // The all-choices default has one meaning and one home. Rejecting the spelling everywhere else is what lets the read side expand it without first asking
  // whether this particular option meant the character literally.
  if((option.defaultValue === ALL_CHOICES) && (!isMultiple || (choices === undefined))) {

    throw catalogError("an all-choices default outside a multiple choice", entry);
  }

  if((choices === undefined) && !isMultiple) {

    return;
  }

  // A picker edits a value, so the option has to be value-centric - the presence of a default is what makes it so - and the default is also what a row resolving
  // to nothing previews. A number cannot serve, since the grammar the list and the choice values live in is textual throughout.
  if(option.defaultValue === undefined) {

    throw catalogError("a choice or list without a default value", entry);
  }

  if(typeof option.defaultValue !== "string") {

    throw catalogError("a non-string default on a choice or list", entry);
  }

  if(choices === undefined) {

    return;
  }

  // Masking and picking are contradictory affordances: a list the editor spells out on screen cannot also be a value kept off it.
  if(option.secret) {

    throw catalogError("a secret choice", entry);
  }

  // One test covers both spellings of "nothing declared" - an empty array and an empty source name - because a picker with nothing to offer is the same mistake
  // whichever way it was written.
  if(choices.length === 0) {

    throw catalogError("an empty choices declaration", entry);
  }

  if(typeof choices === "string") {

    return;
  }

  for(const choice of choices) {

    if(!isValidChoice(choice)) {

      throw catalogError("an invalid choice", entry);
    }
  }

  if(option.defaultValue === ALL_CHOICES) {

    return;
  }

  // Every value the default names has to be one the list offers. A list option reads its default through the same grammar that will parse it at runtime, and a
  // single choice reads as the one value it is...an empty default names nothing either way, which is how a picker declares that it starts with no value at all.
  const offered = choices.map((choice) => choice.value);
  const declared = isMultiple ? parseValueList(option.defaultValue) : (option.defaultValue.length ? [option.defaultValue] : []);

  if(declared.some((value) => !offered.includes(value))) {

    throw catalogError("a default outside the declared choices", entry);
  }
}

/**
 * Build the catalog-derived index from raw categories + options. The result carries the raw inputs alongside every derivation needed for O(1) catalog queries -
 * defaults, value-options registry, groups (both directions), renderers, the raw-entry lookup, and the longest-first cache the entry parser consumes. Throws when a
 * built-in formatter name on a `render` declaration does not resolve, and on any picker declaration the engine cannot honor (see {@link FeatureOptionEntry.choices}
 * and {@link FeatureOptionEntry.multiple}), surfacing the misconfiguration at load time rather than degrading a display path in silence.
 *
 * The index is the catalog-side input to every other pure helper in this module. Build it once per catalog; reuse it across every configured-options mutation
 * because the catalog is unchanged across those mutations. Categories without an entry in the options map are skipped silently (a plugin defines a category for
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
  const optionsByName: Record<string, FeatureOptionEntry> = {};
  const renderers: Record<string, (value: string) => string> = {};
  const scopes: Record<string, readonly FeatureOptionScope[]> = {};
  const valueOptions: Record<string, number | string | undefined> = {};

  for(const category of categories) {

    const categoryOptions = options[category.name];

    if(!categoryOptions) {

      continue;
    }

    for(const option of categoryOptions) {

      const entry = expandOption(category, option);

      defaults[entry.toLowerCase()] = option.default;

      // The general raw-entry lookup, keyed exactly as every other registry here is. A consumer that needs the entry itself - the picker read, a plugin walking
      // one option - reads it in O(1) rather than re-walking the categories and options maps to find what the builder already had in hand.
      optionsByName[entry.toLowerCase()] = option;

      // Track value-centric options separately so the lookup index built later knows which entries can carry a value.
      if("defaultValue" in option) {

        valueOptions[entry.toLowerCase()] = option.defaultValue;
      }

      validateChoiceDeclaration(option, entry);

      // Register the catalog-declared renderer when present so logFeature can consult it in O(1) without walking the options map at log time. Boolean options may
      // declare a renderer too - it just goes unused by the logging path - so we register unconditionally rather than gating on isValue here. A string-typed
      // declaration names a built-in formatter from BUILT_IN_FORMATTERS; an unknown name is a misconfiguration, surfaced loudly at catalog-build time rather than
      // silently degraded to the raw-value fallback at log time.
      if(option.render !== undefined) {

        if(typeof option.render === "string") {

          const formatter = resolveBuiltInFormatter(option.render);

          if(formatter === undefined) {

            throw catalogError("unknown built-in formatter \"" + option.render + "\"", entry);
          }

          renderers[entry.toLowerCase()] = formatter;
        } else {

          renderers[entry.toLowerCase()] = option.render;
        }
      }

      // Register the declared scope levels so resolution and the webUI can consult them in O(1) without reaching back into the raw options map. Only a declaring
      // entry gets a key: an option that says nothing about its scopes leaves the lookup empty, which every consumer reads as "valid at every level."
      if(option.scopes) {

        scopes[entry.toLowerCase()] = option.scopes;
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

  return { categories, defaults, groupParents, groups, options, optionsByName, renderers, scopes, sortedValueOptionNames, valueOptions };
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

// Decide whether a lookup key addresses a given option. A key does so when it is the option itself - the global scope - or the option followed by a single
// identifier segment carrying neither a dot nor the payload delimiter, which is the only scoped address the grammar can write: the composer joins an id onto the
// option name with a dot and ends the address at the first "=", so an id holding either character names a scope nothing can write and nothing can resolve. A key
// that is itself a catalog option name is that option rather than a scope of a shorter one: `Enable.Motion.Detect` is the `Motion.Detect` option, never `Motion`
// at a scope named "Detect", and the catalog is what settles it.
//
// Every surface that addresses a scope arbitrates here - the enumerator reading entries back, the resolution walk, the existence probe, and the writers before
// they compose anything - so no two of them can disagree about which option a key belongs to.
function keyAddressesOption({ catalog, key, optionKey }: { catalog: CatalogIndex; key: string; optionKey: string }): boolean {

  if(key === optionKey) {

    return true;
  }

  if(!key.startsWith(optionKey + ".") || (key in catalog.defaults)) {

    return false;
  }

  return isValidScopeId(key.slice(optionKey.length + 1));
}

// Recover a scope identifier in the casing the entry carried. The lookup keys are lowercased slices of the same tail, so the matched key's length is where the
// identifier ends and the option name's length is where it begins. A key equal in length to the option name is the global address, which has no identifier.
function originalId({ key, optionKey, tailOriginal }: { key: string; optionKey: string; tailOriginal: string }): string {

  return (key.length > optionKey.length) ? tailOriginal.slice(optionKey.length + 1, key.length) : "";
}

/**
 * Enumerate every configured entry that addresses one feature option, decoding each through the engine's own grammar. This is the supported way to discover which
 * scopes a plugin's users have configured an option at, and with what - a plugin that scans the configured-options array itself is re-implementing the storage
 * format, and the two readings drift the moment the grammar grows.
 *
 * Yields one {@link ConfiguredOptionEntry} per addressing entry, in the order the entries appear in the array, and nothing at all for an option nobody configured.
 * Matching folds case, because the storage format does; the yielded identifiers and values keep the casing the entry was written in, because that is the text the
 * user typed and a consumer displaying it should show it back unchanged.
 *
 * Two things this deliberately does not do, both of which belong to {@link resolveScope}: it applies no precedence - a device entry and a global entry for the
 * same option are two records here, not one winner - and it substitutes no catalog default, so an option with no entries yields nothing rather than a record
 * carrying its default. Ask this what the user wrote; ask {@link resolveScope} what applies. Duplicate entries addressing the same scope each yield a record, so
 * the first-write-wins rule the lookup index applies is visible here as two records rather than resolved away.
 *
 * @param args
 * @param args.catalog           - The catalog index, which defines what counts as a value-centric option and which names are options in their own right.
 * @param args.category          - Optional. The option's category, composed with `option` exactly as {@link expandOption} composes them. Omit it when `option` is
 *                                 already the expanded name.
 * @param args.configuredOptions - The raw configured-options array.
 * @param args.option            - The feature option to enumerate: an option entry or name to be composed with `category`, or the expanded name on its own.
 *
 * @returns A generator over the configured entries addressing the option.
 *
 * @example
 *
 * ```ts
 * // Every device that has this option configured, and the value each one carries.
 * for(const entry of enumerateConfiguredEntries({ catalog, configuredOptions, option: "Audio.Volume" })) {
 *
 *   log.info("Volume is configured.", { enabled: entry.enabled, scope: entry.id.length ? entry.id : "global", value: entry.value });
 * }
 * ```
 *
 * @category Feature Options
 */
export function *enumerateConfiguredEntries({ catalog, category, configuredOptions, option }: {

  catalog: CatalogIndex;
  category?: FeatureCategoryEntry | string;
  configuredOptions: readonly string[];
  option: FeatureOptionEntry | string;
}): Generator<ConfiguredOptionEntry, void, undefined> {

  // An absent category means the caller already holds the expanded name; supplying one composes through the same helper every other call site composes with.
  const expanded = (category === undefined) ? ((typeof option === "string") ? option : option.name) : expandOption(category, option);
  const optionKey = expanded.toLowerCase();

  if(!optionKey.length) {

    return;
  }

  for(const rawEntry of configuredOptions) {

    const parsed = parseEntry(catalog, rawEntry);

    if(!parsed) {

      continue;
    }

    const { primaryKey, tailOriginal, valueKey } = parsed;

    /* One entry can decode two ways - the raw tail, and for a value-centric Enable the extracted value key - and the value reading is the entry's meaning whenever
     * it addresses this option. `Enable.Audio.Volume.50` is the Audio.Volume option carrying 50, so that is the record it yields; the lookup index also registers
     * its raw tail (an enable at a scope named "50"), a second live reading the index keeps because no canonical entry can express both, but it is not what the
     * entry says about this option.
     */
    if((valueKey !== undefined) && keyAddressesOption({ catalog, key: valueKey, optionKey })) {

      yield { enabled: parsed.enabled, id: originalId({ key: valueKey, optionKey, tailOriginal }), value: parsed.value };

      continue;
    }

    if(!keyAddressesOption({ catalog, key: primaryKey, optionKey })) {

      continue;
    }

    yield { enabled: parsed.enabled, id: originalId({ key: primaryKey, optionKey, tailOriginal }) };
  }
}

/**
 * Rewrite every entry that decodes as a value form of a catalog option into the canonical `Enable.Option[.id]=value` shape, leaving every other entry exactly as
 * it was found. Pure: does not mutate the input array, and returns the input reference itself when no entry needed rewriting, so reference-equality consumers can
 * detect a no-op without comparing contents.
 *
 * Entries pass through byte-verbatim unless the parser accounts for them completely - boolean options, options absent from the catalog, and malformed strings are
 * never rewritten, because a configuration file is a user's own text and we only reshape the parts whose meaning we can state exactly. Re-composing an entry that
 * is already canonical yields the identical string, so running this repeatedly is stable.
 *
 * The legacy single-trailing-segment form (`Enable.Audio.Volume.50`) is deliberately left alone for the same reason. That segment does double duty - the lookup
 * index registers it as the option's global value and, through the primary key, as an enable at a scope carrying that same name - and no single canonical entry
 * expresses both. Rewriting it would settle, on the user's behalf, an ambiguity only the user can settle, so it stays as written. A segment containing "=" is the
 * exception: the composer cannot address a scope whose id carries the delimiter, so only the global-value reading is live there, and the entry modernizes like
 * any other unambiguous legacy form.
 *
 * {@link applySetOption} and {@link applyClearOption} run their results through this, which is the whole of the upgrade path: a stored configuration modernizes as
 * part of a save the user already asked for, and never merely because something read it. One consequence is worth stating plainly, since it becomes visible in the
 * saved file: a legacy entry whose dotted tail the engine reads as an id plus a value is rewritten to say so outright, so `Enable.Audio.Volume.St. Andrews` (read
 * as the id "St" carrying the value " Andrews") normalizes to `Enable.Audio.Volume.St=Andrews`, the value trimmed to the canonical domain. Resolution is unchanged
 * either way - the reading a user may not have intended stops being latent and becomes something they can see and correct.
 *
 * @param catalog           - The catalog index that defines which option names are value-centric.
 * @param configuredOptions - The configured-options array to normalize.
 *
 * @returns The normalized array, or the input array reference itself when every entry was already canonical.
 */
export function normalizeConfiguredOptions(catalog: CatalogIndex, configuredOptions: readonly string[]): readonly string[] {

  let normalized: string[] | undefined;

  for(const [ index, entry ] of configuredOptions.entries()) {

    const canonical = normalizeEntry(catalog, entry);

    if(canonical === entry) {

      continue;
    }

    // Copy on the first entry that actually changes. An array that is already canonical - the common case by far, since the composer only ever writes canonical
    // entries - costs a parse per entry and no allocation at all.
    normalized ??= [...configuredOptions];
    normalized[index] = canonical;
  }

  return normalized ?? configuredOptions;
}

/**
 * Compute the new configured-options array after setting an option's enabled state (and optionally its value) at a given scope. Drops any prior entry addressing
 * the same option-at-scope so the new entry is the sole survivor, then appends the freshly composed entry string. Pure: does not mutate the input array.
 *
 * The composed entry's action segment is canonical "Enable" / "Disable"; the option and id segments preserve the caller's casing for readability since the
 * lookup-index keys are case-insensitive anyway. Values are emitted only when meaningful - disabled or non-value options never carry one - so a subsequent
 * {@link applyClearOption} or {@link applySetOption} addressing the same scope cleanly replaces whatever was there, in either the canonical or the legacy form,
 * because the matcher decodes entries through the same parser.
 *
 * A value always rides behind the payload delimiter, at either scope, which is what makes it free-form: periods, interior spaces, and even further "=" characters
 * need no escaping. Surrounding whitespace is trimmed first, and a value persists only when content survives the trim - see {@link hasValueContent}. At the
 * global scope an enable without content composes the bare entry, which resolution reads as "enabled, no value given". At a device or controller scope there is
 * no such spelling for an option storing a single value - a scoped entry carries one - so an enable without content reduces to clearing the scope: any entry
 * addressing it is dropped and resolution falls back to inheritance. The surviving entries are normalized on the way through, so the save the caller asked for
 * also modernizes anything still in the legacy form.
 *
 * An option declaring {@link FeatureOptionEntry.multiple} reads a SUPPLIED empty value as content-bearing rather than as nothing given: the empty selection is a
 * state the list can be in, told apart from the bare enable that resolves the registered default, so it composes the bare-delimiter entry at either scope. This
 * turns on the caller supplying the value, not on what the value says: omit `value` and a list behaves like every other option, composing the bare entry
 * globally and reducing to a clear at a scope.
 *
 * A scoped write whose id cannot address the option is refused outright rather than composed, because the entry it would produce is one the readers would
 * attribute elsewhere: an id carrying a period or an equals sign has no spelling in the address grammar, and an id whose composed address is itself a catalog
 * option would write that option's own entry under another option's name. A global write has no id to check, and a legal scoped write is unaffected.
 *
 * @param options
 * @param options.args              - The mutation intent: option key, optional scope id, enabled state, optional value. See {@link SetOptionArgs}.
 * @param options.catalog           - The catalog index that defines what counts as a value-centric option (which determines whether to emit a value at all), and
 *                                    which settles whether a scoped target belongs to this option or to another one.
 * @param options.configuredOptions - The current configured-options array.
 *
 * @returns The new configured-options array - a fresh allocation whenever an entry was written or removed, or the input array reference itself when a scoped
 *          enable that reduced to a clear found nothing to drop, mirroring {@link applyClearOption}'s reference-stable no-op.
 *
 * @throws `Error` naming the id and the option when a present id cannot address a scope of that option.
 */
export function applySetOption(
  { args, catalog, configuredOptions }: { args: SetOptionArgs; catalog: CatalogIndex; configuredOptions: readonly string[] }
): readonly string[] {

  validateWriteTarget({ catalog, id: args.id, option: args.option });

  // A value is meaningful only on an Enable of a value-centric option, and only when it carries content; everything else composes the bare address.
  const valued = args.enabled && isValueOption(catalog, args.option);
  const trimmed = (valued && (args.value !== undefined)) ? args.value.toString().trim() : "";

  // The one value without content that persists: an empty selection the caller supplied for a list option. "On, with nothing selected" is a state that list can
  // be in and has to be tellable from the bare enable, so it composes the bare-delimiter entry the parser reads back as exactly that. The caller's supplying the
  // value is what makes it a selection - an omitted value says nothing about the list and keeps the plain enable.
  const emptySelection = valued && (args.value !== undefined) && !trimmed.length && isMultipleOption(catalog.optionsByName[args.option.toLowerCase()]);
  const value = (valued && (hasValueContent(trimmed) || emptySelection)) ? trimmed : undefined;

  // A value-centric option enabled at a scope persists only with a value, the empty selection above included. The grammar has no scoped spelling for "enabled
  // here, nothing given" - the bare form would put the id where the legacy grammar reads a global value - so the request reduces to its observable meaning: any
  // entry addressing the scope is dropped and resolution falls back to inheritance. Delegating states that reduction literally, and carries applyClearOption's
  // reference-stable no-op with it.
  if(valued && (value === undefined) && args.id?.length) {

    return applyClearOption({ args: { id: args.id, option: args.option }, catalog, configuredOptions });
  }

  const target = targetKey(args.option, args.id);

  // The entries that survive the replacement modernize as part of the save the caller already asked for. The entry composed below is canonical by construction, so
  // it needs no pass of its own.
  const surviving = normalizeConfiguredOptions(catalog, configuredOptions.filter((entry) => !entryAddressesScope({ catalog, rawEntry: entry, target })));

  return [ ...surviving, composeEntry({ enabled: args.enabled, id: args.id, option: args.option, value }) ];
}

/**
 * Compute the new configured-options array after clearing every entry addressing an option at a given scope. The match is value-aware: for value-centric options
 * it covers the bare scoped entry and any entry carrying a value, in either the canonical or the legacy form, so a subsequent {@link applySetOption} cleanly
 * replaces whatever was there.
 *
 * Pure: does not mutate the input array. When no entry matched the target and none needed modernizing, returns the input array reference unchanged so
 * reference-equality consumers can detect a no-op without a contents comparison. Surviving entries are normalized on the way through, so a clear carries the same
 * upgrade-on-save behavior a set does. See {@link normalizeConfiguredOptions}.
 *
 * A scoped clear whose id cannot address the option is refused on the same terms {@link applySetOption} refuses a write, and for a sharper reason: an id whose
 * composed address is itself a catalog option would delete that option's own entry in the name of clearing a scope of a shorter one. A global clear has no id to
 * check, and a legal scoped clear is unaffected.
 *
 * @param options
 * @param options.args              - The addressing intent: option key, optional scope id. See {@link ClearOptionArgs}.
 * @param options.catalog           - The catalog index that defines what counts as a value-centric option (which the matcher consults via the shared parser), and
 *                                    which settles whether a scoped target belongs to this option or to another one.
 * @param options.configuredOptions - The current configured-options array.
 *
 * @returns The new configured-options array, or the input array reference itself when nothing matched and nothing needed rewriting.
 *
 * @throws `Error` naming the id and the option when a present id cannot address a scope of that option.
 */
export function applyClearOption(
  { args, catalog, configuredOptions }: { args: ClearOptionArgs; catalog: CatalogIndex; configuredOptions: readonly string[] }
): readonly string[] {

  validateWriteTarget({ catalog, id: args.id, option: args.option });

  const target = targetKey(args.option, args.id);
  const filtered = configuredOptions.filter((entry) => !entryAddressesScope({ catalog, rawEntry: entry, target }));
  const normalized = normalizeConfiguredOptions(catalog, filtered);

  // Reference-stable no-op: nothing matched the target and no survivor needed rewriting, so callers comparing references see no change without inspecting contents.
  return ((normalized === filtered) && (filtered.length === configuredOptions.length)) ? configuredOptions : normalized;
}

// Read one scoped entry from the lookup index, and only when the arbitration assigns the composed key to the option being asked about. A key the catalog claims as
// an option in its own right carries that option's own global entry, never a scope of a shorter name, so a scoped read passes over it and the caller's walk
// continues to the next level: a read answers a question rather than enforcing a write, so an address that cannot mean what was asked simply does not match. An
// option the catalog does not declare claims no key at all, which is what lets an entry left behind by a removed option go on resolving as it always has.
function scopedEntry(
  { catalog, configIndex, id, optionKey }: { catalog: CatalogIndex; configIndex: ConfigIndex; id: string; optionKey: string }
): ReturnType<ConfigIndex["get"]> {

  const key = optionKey + "." + id.toLowerCase();

  return keyAddressesOption({ catalog, key, optionKey }) ? configIndex.get(key) : undefined;
}

/**
 * Resolve a feature option through the scope hierarchy in a single traversal. Returns the scope where the option was found, its enabled state, and the raw value
 * for value-centric options. This is the core resolution primitive that every higher-level query builds on - {@link FeatureOptions.test}, {@link FeatureOptions.scope},
 * {@link FeatureOptions.value}, and {@link FeatureOptions.logFeature} all consume the same `ResolvedOptionEntry` shape from one walk.
 *
 * Resolution precedence: device beats controller beats global beats default. An explicit entry at a higher-precedence scope short-circuits the lookup, so the
 * cost is O(1) in the configured-options array size.
 *
 * The walk visits only the levels the option's catalog entry declares through {@link FeatureOptionEntry.scopes}. An option that declares nothing is valid
 * everywhere and walks every level; one that names its levels resolves at those and skips a configured entry sitting at any other, so an entry written where the
 * option was never meant to apply cannot reach the accessories it was never meant to reach.
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

  // The option's declared levels, looked up once and consulted by each of the level checks below. Undefined means the entry declared nothing, in which case every
  // level is walked. A configured entry at a level the option does not declare is skipped and the walk continues downward, exactly as though the user had never
  // written it - which is what makes the declaration true for every query built on this one traversal.
  const declaredScopes = catalog.scopes[normalizedOption];

  // Check to see if we have a device-level option first.
  if(device && (!declaredScopes || declaredScopes.includes("device"))) {

    const deviceEntry = scopedEntry({ catalog, configIndex, id: device, optionKey: normalizedOption });

    if(deviceEntry) {

      return { enabled: deviceEntry.enabled, optionValue: deviceEntry.value, scope: "device" };
    }
  }

  // Now check to see if we have a controller-level option.
  if(controller && (!declaredScopes || declaredScopes.includes("controller"))) {

    const controllerEntry = scopedEntry({ catalog, configIndex, id: controller, optionKey: normalizedOption });

    if(controllerEntry) {

      return { enabled: controllerEntry.enabled, optionValue: controllerEntry.value, scope: "controller" };
    }
  }

  // Finally, we check for a global-level value. The key at this level is the option's own name, which the arbitration assigns to that option by rule, so there is
  // nothing here for a scoped read's guard to decide.
  if(!declaredScopes || declaredScopes.includes("global")) {

    const globalEntry = configIndex.get(normalizedOption);

    if(globalEntry) {

      return { enabled: globalEntry.enabled, optionValue: globalEntry.value, scope: "global" };
    }
  }

  // The option hasn't been set at any scope it is valid at, so return the catalog default. A default belongs to the option itself rather than to any level, so it
  // applies whatever the declaration says - an option whose only configured entry sits at an undeclared level lands here. The defaultReturnValue parameter covers
  // the case where the option is not in the catalog at all - typically a misspelling or a stale call site referring to an option that was removed from the catalog.
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
 * It reads the configured entries alone and so is blind to {@link FeatureOptionEntry.scopes}: "is this configured" and "does this apply" are different questions,
 * and an entry written at a level the option does not declare is still an entry the user typed. Ask {@link resolveScope} when the question is whether the option
 * takes effect.
 *
 * A scoped question goes through the same arbitration every other reader and every writer consults, so an address the catalog claims for another option reads
 * false here: an entry at `Motion.Detect.Sensitivity` is the `Motion.Detect.Sensitivity` option's own entry, not the `Motion.Detect` option configured at a scope
 * named "Sensitivity".
 *
 * @param args
 * @param args.catalog     - The catalog index, which settles whether a scoped address belongs to this option or to another one.
 * @param args.configIndex - The configured-options lookup index.
 * @param args.id          - Optional scope identifier (device or controller). Omit to address the global scope.
 * @param args.option      - The option key (case-insensitive).
 *
 * @returns True when an explicit entry addresses this option-at-scope.
 */
export function optionExists({ catalog, configIndex, id, option }: { catalog: CatalogIndex; configIndex: ConfigIndex; id?: string; option: string }): boolean {

  const optionKey = option.toLowerCase();

  return id?.length ? (scopedEntry({ catalog, configIndex, id, optionKey }) !== undefined) : configIndex.has(optionKey);
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

// Utility function to parse and return a numeric configuration parameter. Distinguishes exactly two outcomes: null when the option is explicitly disabled, and
// undefined-or-a-parsed-number for everything else - unset, set but unparseable, or successfully parsed - matching the public getInteger/getFloat contract, which
// likewise groups "doesn't exist" and "couldn't be parsed" under a single undefined outcome.
function parseOptionNumeric(option: Nullable<string | undefined>, convert: (value: string) => number): Nullable<number | undefined> {

  // If the option is disabled (null) or we don't have it configured (undefined), preserve that distinction in the return value so callers can tell the two apart.
  if(!option) {

    return (option === null) ? null : undefined;
  }

  const convertedValue = convert(option);

  if(Number.isNaN(convertedValue)) {

    return undefined;
  }

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
   * This reads the configured entries alone and is blind to {@link FeatureOptionEntry.scopes}: it reports what the user configured, not what takes effect. Ask
   * {@link FeatureOptions.test} when the question is whether the option applies at a given scope.
   *
   * A scoped question is arbitrated against the catalog, so an id whose composed address belongs to another option reads false - see {@link optionExists}, which
   * this delegates to.
   *
   * @param option        - Feature option to check.
   * @param id            - Optional device or controller scope identifier to check.
   *
   * @returns Returns true if the option has been explicitly configured, false otherwise.
   */
  public exists(option: string, id?: string): boolean {

    return optionExists({ catalog: this.#catalog, configIndex: this.#configIndex, id, option });
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
   * The distinct emitted-line shapes, across these state combinations:
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
   * A value-centric option enabled with no resolvable value anywhere - no catalog-declared default and no explicit value at any scope - collapses to the plain
   * `<label> enabled.` line above rather than the `enabled at <value>` form, since there is nothing meaningful to render after "at" (see the defensive fallback in
   * the implementation below).
   *
   * An option declaring {@link FeatureOptionEntry.multiple} that resolves to the empty selection keeps the same axis split and states the emptiness in words:
   * `<label> enabled with an empty selection.` where the boolean axis deviated, `<label> set to an empty selection.` where only the value axis did. Saying it
   * outright is what keeps the line a sentence, since interpolating the empty string into either shape above would emit "enabled at ." instead.
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

    // A list resolving to the empty selection is stated in words rather than rendered, because there is nothing to put after "at" or "to" and a catalog-declared
    // renderer is written for the values the option offers, not for their absence. This resolves ahead of the renderer so no plugin's formatter is handed the
    // empty string; every option storing a single value keeps the reading below, empty answers included.
    if(!effectiveValue.length && isMultipleOption(this.#catalog.optionsByName[option.toLowerCase()])) {

      log.info(booleanDeviates ? "%s enabled with an empty selection." : "%s set to an empty selection.", label);

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
   * value-centric options it covers the bare scoped entry and any entry carrying a value, in either the canonical or the legacy form, so a subsequent
   * {@link setOption} cleanly replaces whatever was there. No-op when no entry addresses the target scope, so callers can treat this as a repeatable reset.
   *
   * A scoped clear whose id cannot address the option is refused rather than performed: an id carrying a period or an equals sign has no spelling in the address
   * grammar, and an id whose composed address is itself a catalog option would delete that option's own entry in the name of clearing a scope of a shorter one. A
   * global clear has no id to check, and a legal scoped clear is unaffected.
   *
   * @param args - The addressing intent: option key and optional scope id. See {@link ClearOptionArgs}.
   *
   * @throws `Error` naming the id and the option when a present id cannot address a scope of that option.
   *
   * @example
   *
   * ```ts
   * // Remove any configured value for "Audio.Volume" on device ABC123 (drops both `Enable.Audio.Volume.ABC123` and `Enable.Audio.Volume.ABC123=50`).
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

    // Same readonly-to-mutable cast rationale as the categories getter below: the pure functional core returns a readonly array for purity, while this private
    // field keeps the historically mutable type its consumers depend on. See setOption below for the same cast at the other mutation site.
    this.#configuredOptions = next as string[];

    // Only the index depends on the configured-options array; the catalog-derived state is unchanged across config mutations and need not be touched here.
    this.#configIndex = buildConfigIndex(this.#catalog, this.#configuredOptions);
  }

  /**
   * Set the enabled state (and optionally the value) for an option at a given scope, replacing any prior entry for the same option-at-scope.
   *
   * This is the single mutation primitive for individual feature options. Callers express intent ("enable option X at scope Y, with value Z") and the model owns
   * both the encoding and the prior-entry replacement - the configured-options array is canonical, the lookup index is rebuilt automatically, and the entry-string
   * format never leaks past this method. Values are emitted only when `enabled` is true and the option is value-centric; passing `value` for a non-value or
   * disabled option is silently dropped because the resulting entry would be meaningless under the resolution rules. A value is free-form at either scope - it is
   * written behind a payload delimiter and trimmed of surrounding whitespace - and persists only when content survives the trim (see {@link hasValueContent}).
   * At the global scope an enable without content composes the bare entry; at a device or controller scope it reduces to clearing the scope, because a scoped
   * entry storing a single value always carries one. An option declaring {@link FeatureOptionEntry.multiple} persists a SUPPLIED empty value at either scope
   * instead, as the explicit empty selection; omitting the value keeps the behavior every other option gets.
   *
   * Saving also modernizes: any surviving entry still in the legacy dot form is rewritten into the canonical form as part of the same mutation. See
   * {@link normalizeConfiguredOptions} for what that does and does not touch.
   *
   * A scoped write whose id cannot address the option is refused rather than composed: an id carrying a period or an equals sign has no spelling in the address
   * grammar, and an id whose composed address is itself a catalog option would write that option's own entry under another option's name. A global write has no id
   * to check, and a legal scoped write is unaffected.
   *
   * @param args - The mutation intent: option key, optional scope id, enabled state, and optional value. See {@link SetOptionArgs}.
   *
   * @throws `Error` naming the id and the option when a present id cannot address a scope of that option.
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

    const next = applySetOption({ args, catalog: this.#catalog, configuredOptions: this.#configuredOptions });

    // Reference-stable no-op: a scoped enable that reduced to a clear and found nothing to drop leaves the array and the index already coherent. Skip the
    // rebuild and preserve the array reference so callers holding a snapshot see a stable identity for unchanged state.
    if(next === this.#configuredOptions) {

      return;
    }

    // Same readonly-to-mutable cast rationale as clearOption above.
    this.#configuredOptions = next as string[];

    // Only the index depends on the configured-options array; the catalog-derived state is unchanged across config mutations and need not be touched here.
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
   *          `undefined` if it's not specified. An option declaring {@link FeatureOptionEntry.multiple} answers the empty string where its stored selection is
   *          explicitly empty, which is a configured state rather than an unspecified one; for every option storing a single value an empty stored value reads
   *          as unspecified and resolves onward.
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

    // If we found a non-empty explicit value in the index, return it. An empty string is deliberately treated as unspecified for an option storing a single value -
    // from the user's perspective an empty value is the same as not setting one - so it falls through to the default or "enabled, no value" resolution below rather
    // than being returned verbatim.
    if(resolved.optionValue) {

      return resolved.optionValue;
    }

    // A list reads its stored empty the other way: the user unchecked everything, which is a selection they made and not a value they omitted, so it comes back
    // verbatim. Only the stored empty reaches here - a non-empty value returned above - so the catalog lookup runs on the one state that needs it.
    if((resolved.optionValue === "") && isMultipleOption(this.#catalog.optionsByName[option.toLowerCase()])) {

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
   * Return what a picker option's stored value selects, resolved through the scope hierarchy. The list read that pairs with {@link FeatureOptions.value | value},
   * which stays the single resolution: this method asks it what the option resolves to and then reads that text against a domain, rather than walking the
   * hierarchy a second time.
   *
   * The domain decides how much reading happens. Supply one - the values the device actually reports - and the result is the members of that domain the stored
   * value selects, in domain order, with an {@link ALL_CHOICES} default expanded and any value the device no longer offers dropped. Supply none and an option
   * whose catalog entry declares its choices inline reads against those, since the catalog already holds them. Supply none for a source-backed option and the
   * stored text answers for itself: a `multiple` option's entries as the user's order named them, a single-valued option's value as the one member.
   *
   * An option that resolves to nothing reads as the empty list - disabled at some scope, enabled with no value, emptied on purpose, unknown to the catalog, or
   * not value-centric at all. There is no separate "nothing here" answer to check for, so a caller iterates the result and is done.
   *
   * @param args
   * @param args.controller - Optional controller scope identifier.
   * @param args.device     - Optional device scope identifier.
   * @param args.domain     - Optional values available in this context.
   * @param args.option     - Feature option to read.
   *
   * @returns The selected values, or an empty list when the option resolves to none.
   *
   * @example
   *
   * ```ts
   * // A domain the device reported: unknown members drop and an all-choices default expands to everything the camera offers.
   * const types = featureOpts.valueList({ device: camera.mac, domain: camera.featureFlags.smartDetectTypes, option: "Motion.SmartDetect" });
   *
   * // No domain: an inline catalog list answers for itself, and a free-form list reads back exactly as the user entered it.
   * const plates = featureOpts.valueList({ device: camera.mac, option: "Motion.Plates" });
   * ```
   */
  public valueList({ controller, device, domain, option }: ValueListArgs): readonly string[] {

    const entry = this.#catalog.optionsByName[option.toLowerCase()];

    if(!entry || !this.isValue(option)) {

      return [];
    }

    const value = this.value(option, device, controller);

    if((value === null) || (value === undefined)) {

      return [];
    }

    // The caller's domain wins, then the inline list the catalog already holds - restating a static list at the call site would give the same option two
    // declarations of what it offers. A source-backed option has neither, since the domain it draws on lives on the page.
    //
    // The inline list is recognized by what it is not, because `Array.isArray` widens a readonly array to `any[]` and would take the choices out of the type
    // system at exactly the point they are being read. A declaration is one of three things - absent, a source name, or the list itself - and only the list is an
    // object.
    const resolvedDomain = domain ?? ((typeof entry.choices === "object") ? entry.choices.map((choice) => choice.value) : undefined);

    if(resolvedDomain) {

      return selectValues({ domain: resolvedDomain, multiple: isMultipleOption(entry), value }).selected;
    }

    return isMultipleOption(entry) ? parseValueList(value) : [value];
  }

  /**
   * Return the list of available feature option categories.
   *
   * @returns Returns the current list of available feature option categories.
   */
  public get categories(): FeatureCategoryEntry[] {

    // The catalog stores the categories as readonly to encode the immutability guarantee the pure functional core relies on. The public getter returns the
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

    // The catalog-derived state is unchanged across config mutations; only the lookup index needs rebuilding.
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

    // Same readonly-to-mutable cast rationale as the categories getter above: this is the same object identity held internally, so a caller mutating it would be
    // mutating the catalog regardless of the return type. The readonly annotation is the discipline, not a runtime enforcement.
    return this.#catalog.groups as Record<string, string[]>;
  }

  /**
   * Return the list of available feature options.
   *
   * @returns Returns the current list of available feature options.
   */
  public get options(): Record<string, FeatureOptionEntry[]> {

    // Same readonly-to-mutable cast rationale as the categories getter above: this is the same object identity held internally, so a caller mutating it would be
    // mutating the catalog regardless of the return type. The readonly annotation is the discipline, not a runtime enforcement.
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
