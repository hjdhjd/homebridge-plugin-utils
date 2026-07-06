[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / featureOptions

# featureOptions

A hierarchical feature option system for plugins and applications.

The module exports two complementary surfaces:

  - **Pure functional core.** Catalog and config indices ([CatalogIndex](#catalogindex), [ConfigIndex](#configindex)) carry every derived view of the catalog and configured options;
    pure builders ([buildCatalogIndex](#buildcatalogindex), [buildConfigIndex](#buildconfigindex)) construct them from raw inputs; pure transforms ([applySetOption](#applysetoption),
    [applyClearOption](#applyclearoption)) compute new configured-options arrays without mutation; pure queries ([resolveScope](#resolvescope), [getDefaultValue](#getdefaultvalue),
    [isValueOption](#isvalueoption), [optionExists](#optionexists), [isDependencyMet](#isdependencymet-1), [expandOption](#expandoption-1)) answer scope-aware questions over those indices. This is the
    single source of truth for option-array semantics, consumed wherever immutable state is the discipline (reducer-driven UIs, server-side renderers, time-travel
    debuggers, future consumers we have not built yet).

  - **Imperative class façade.** [FeatureOptions](#featureoptions) bundles a [CatalogIndex](#catalogindex), a configured-options array, and a [ConfigIndex](#configindex) into one object whose
    mutating methods (`setOption` / `clearOption` / the setters) delegate to the pure transforms internally. This is the legacy-friendly surface used by every
    plugin's Node-side code; the class's public API surface is identical to the pure-function core it delegates to.

Two surfaces, one set of semantics. The class is a convenience over the pure functions, not a parallel implementation.

## Feature Options

### FeatureOptionFormatter

```ts
type FeatureOptionFormatter = "bps" | "bytes" | "kbps" | "ms" | "percent" | "seconds";
```

Named built-in formatters available to [FeatureOptionEntry.render](#render). The string literals double as discoverable, autocomplete-friendly names and as the
lookup keys into the registry that resolves them at catalog-rebuild time. Storing the catalog's renderer declaration as a string (rather than a function reference)
preserves the catalog's data-only shape so it stays JSON-serializable when every option uses a named formatter; the function escape hatch on `render` remains
available for bespoke needs that the registry does not cover.

The set targets the unit categories that recur across plugin catalogs: bitrate (in either of the two common storage conventions), data size, percentages, and
durations. Extend the union when a new shared format becomes load-bearing across multiple plugins. Resist adding a formatter speculatively - the function escape
hatch already covers one-off needs, and an unused formatter is dead surface that downstream plugins still see in their IDE autocomplete.

## Other

### FeatureOptions

FeatureOptions provides a hierarchical feature option system for plugins and applications.

Supports global, controller, and device-level configuration, value-centric feature options, grouping, and category management.

This class is the imperative façade over the pure functional core exposed by this module ([buildCatalogIndex](#buildcatalogindex), [applySetOption](#applysetoption),
[applyClearOption](#applyclearoption), [resolveScope](#resolvescope), etc.). Reducer-driven consumers that want immutable state should call the pure functions directly; imperative
Node-side plugin code uses this class for the same semantics with mutation-friendly ergonomics.

#### Example

```ts
// Define categories and options.
const categories = [

  { name: "motion", description: "Motion Options" },
  { name: "audio", description: "Audio Options" }
];

const options = {

  motion: [
    { name: "detect", default: true, description: "Enable motion detection." }
  ],

  audio: [
    { name: "volume", default: false, defaultValue: 50, description: "Audio volume." }
  ]
};

// Instantiate FeatureOptions.
const featureOpts = new FeatureOptions(categories, options, ["Enable.motion.detect"]);

// Check if a feature is enabled.
const motionEnabled = featureOpts.test("motion.detect");

// Get a value-centric feature option.
const volume = featureOpts.value("audio.volume");
```

#### See

 - FeatureOptionEntry
 - FeatureCategoryEntry
 - OptionScope

#### Constructors

##### Constructor

```ts
new FeatureOptions(
   categories, 
   options, 
   configuredOptions?): FeatureOptions;
```

Create a new FeatureOptions instance.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `categories` | [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\>[] | `undefined` | Array of feature option categories. |
| `options` | `Record`\<`string`, [`FeatureOptionEntry`](#featureoptionentry)[]\> | `undefined` | Dictionary mapping category names to arrays of feature options. |
| `configuredOptions` | `string`[] | `[]` | Optional. Array of currently configured option strings. |

###### Returns

[`FeatureOptions`](#featureoptions)

###### Example

```ts
const featureOpts = new FeatureOptions(categories, options, ["Enable.motion.detect"]);
```

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="defaultreturnvalue"></a> `defaultReturnValue` | `public` | `boolean` | Default return value for unknown options (defaults to false). |

#### Accessors

##### categories

###### Get Signature

```ts
get categories(): FeatureCategoryEntry<unknown>[];
```

Return the list of available feature option categories.

###### Returns

[`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\>[]

Returns the current list of available feature option categories.

###### Set Signature

```ts
set categories(category): void;
```

Set the list of available feature option categories.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `category` | [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\>[] | Array of available categories. |

###### Returns

`void`

##### configuredOptions

###### Get Signature

```ts
get configuredOptions(): string[];
```

Return the list of currently configured feature options.

###### Returns

`string`[]

Returns the currently configured list of feature options.

###### Set Signature

```ts
set configuredOptions(options): void;
```

Set the list of currently configured feature options.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | `string`[] \| `null` \| `undefined` | Array of configured feature options. |

###### Returns

`void`

##### groupParents

###### Get Signature

```ts
get groupParents(): Record<string, string>;
```

Return a reverse index mapping each child option to its parent group. This provides O(1) child-to-parent lookups, complementing the forward `groups` map that maps
parents to their children.

###### Returns

`Record`\<`string`, `string`\>

Returns a record mapping child option names to their parent group names.

##### groups

###### Get Signature

```ts
get groups(): Record<string, string[]>;
```

Return the list of available feature option groups.

###### Returns

`Record`\<`string`, `string`[]\>

Returns the current list of available feature option groups.

##### options

###### Get Signature

```ts
get options(): Record<string, FeatureOptionEntry[]>;
```

Return the list of available feature options.

###### Returns

`Record`\<`string`, [`FeatureOptionEntry`](#featureoptionentry)[]\>

Returns the current list of available feature options.

###### Set Signature

```ts
set options(options): void;
```

Set the list of available feature options.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \| `Record`\<`string`, [`FeatureOptionEntry`](#featureoptionentry)\<`unknown`\>[]\> \| `null` \| `undefined` | Array of available feature options. |

###### Returns

`void`

#### Methods

##### clearOption()

```ts
clearOption(args): void;
```

Remove every configured-options entry addressing the given option at the given scope.

Callers express intent ("forget any configuration for option X at scope Y") and the model owns the entry-format end-to-end. The match is value-aware: for
value-centric options it covers both the bare scoped entry and any entry carrying a single trailing value segment, so a subsequent [setOption](#setoption) cleanly
replaces whatever was there. No-op when no entry addresses the target scope, so callers can treat this as an idempotent reset.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`ClearOptionArgs`](#clearoptionargs) | The addressing intent: option key and optional scope id. See [ClearOptionArgs](#clearoptionargs). |

###### Returns

`void`

###### Example

```ts
// Remove any configured value for "Audio.Volume" on device ABC123 (drops both `Enable.Audio.Volume.ABC123` and `Enable.Audio.Volume.ABC123.50`).
featureOpts.clearOption({ option: "Audio.Volume", id: "ABC123" });
```

##### defaultValue()

```ts
defaultValue(option): boolean;
```

Return the default value for an option.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |

###### Returns

`boolean`

Returns true or false, depending on the option default.

##### exists()

```ts
exists(option, id?): boolean;
```

Return whether the option explicitly exists in the list of configured options.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `id?` | `string` | Optional device or controller scope identifier to check. |

###### Returns

`boolean`

Returns true if the option has been explicitly configured, false otherwise.

##### expandOption()

```ts
expandOption(category, option): string;
```

Return a fully formed feature option string.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `category` | `string` \| [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\> | Feature option category entry or category name string. |
| `option` | `string` \| [`FeatureOptionEntry`](#featureoptionentry)\<`unknown`\> | Feature option entry of option name string. |

###### Returns

`string`

Returns a fully formed feature option in the form of `category.option`.

##### getFloat()

```ts
getFloat(
   option, 
   device?, 
controller?): Nullable<number | undefined>;
```

Parse a floating point feature option value.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

[`Nullable`](util.md#nullable)\<`number` \| `undefined`\>

Returns the value of a value-centric option as a floating point number, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.

##### getInteger()

```ts
getInteger(
   option, 
   device?, 
controller?): Nullable<number | undefined>;
```

Parse an integer feature option value.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

[`Nullable`](util.md#nullable)\<`number` \| `undefined`\>

Returns the value of a value-centric option as an integer, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.

##### isDependencyMet()

```ts
isDependencyMet(
   option, 
   device?, 
   controller?): boolean;
```

Return whether a grouped option's parent is currently enabled at the given scope. For options that aren't grouped (no `group` property in the catalog entry),
always returns `true` - there is no dependency to fail. For grouped options, traverses the scope hierarchy via [resolveScope](#resolvescope) to evaluate the parent's
effective state at the requested device + controller view.

This is the SSOT for "is this option's row currently usable?" Every caller that wants to know whether to render a grouped option's row, count it as visible,
or honor its dependency-hidden state asks the model rather than reconstructing the parent path themselves. The reverse-lookup from option to parent uses the
pre-built [CatalogIndex.groupParents](#groupparents-1) index, so the predicate is O(1) regardless of option-key length.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Fully-qualified feature option string (e.g., `"Motion.Sensitivity"`). Case-insensitive. |
| `device?` | `string` | Optional device scope identifier, forwarded to [resolveScope](#resolvescope). |
| `controller?` | `string` | Optional controller scope identifier, forwarded to [resolveScope](#resolvescope). |

###### Returns

`boolean`

`true` when the option has no dependency or its parent is currently enabled at the requested scope; `false` when the parent is currently disabled.

##### isScopeDevice()

```ts
isScopeDevice(option, device): boolean;
```

Return whether an option has been set in either the device or controller scope context.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device` | `string` | - |

###### Returns

`boolean`

Returns true if the option is set at the device or controller level and false otherwise.

##### isScopeGlobal()

```ts
isScopeGlobal(option): boolean;
```

Return whether an option has been set in the global scope context.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |

###### Returns

`boolean`

Returns true if the option is set globally and false otherwise.

##### isValue()

```ts
isValue(option): boolean;
```

Return whether an option is value-centric or not.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option entry or string to check. |

###### Returns

`boolean`

Returns true if it is a value-centric option and false otherwise.

##### logFeature()

```ts
logFeature(
   option, 
   label, 
   log, 
   device?, 
   controller?): void;
```

Emit an INFO-level log line for a feature option, but only when the user's effective configuration deviates from the declared default.

This is the executable form of the project-wide startup-log convention: restating a default is log noise, and deviations should be reported in both directions - a
default-off feature the user turned on, a default-on feature the user turned off, and a value the user customized away from the registered default. Callers pass
the option key and a human-readable label; this method handles the direction detection and the message synthesis so every plugin emits the same shape from one
place. If the convention ever evolves, every call site picks up the change without any source modification.

Polymorphic over option type, mirroring how [FeatureOptions.test](#test) and [FeatureOptions.value](#value) already dispatch on whether the option is value-centric.
The distinct emitted-line shapes, across these state combinations:

| Option type      | User state vs. default                                  | Emitted line                       |
|------------------|---------------------------------------------------------|------------------------------------|
| Boolean          | matches default                                         | (silent)                           |
| Boolean          | default off, enabled                                    | `<label> enabled.`                 |
| Boolean          | default on, disabled                                    | `<label> disabled.`                |
| Value-centric    | both axes match                                         | (silent)                           |
| Value-centric    | default on, disabled                                    | `<label> disabled.`                |
| Value-centric    | default off, enabled (value matches or differs)         | `<label> enabled at <value>.`      |
| Value-centric    | default on, enabled, value differs from declared default | `<label> set to <value>.`          |

A value-centric option enabled with no resolvable value anywhere - no catalog-declared default and no explicit value at any scope - collapses to the plain
`<label> enabled.` line above rather than the `enabled at <value>` form, since there is nothing meaningful to render after "at" (see the defensive fallback in
the implementation below).

Value rendering consults the catalog-declared [FeatureOptionEntry.render](#render) when present; otherwise the raw string returned by [FeatureOptions.value](#value)
is used. The renderer may be either a [FeatureOptionFormatter](#featureoptionformatter) string naming a built-in formatter from the shared registry (preferred when the format exists
there, since this keeps the catalog JSON-serializable and lets every plugin share one implementation) or an inline function for bespoke cases. Declaring the
renderer at the option's catalog entry keeps display formatting a single source of truth shared by `logFeature` and any future surface that displays the value.

Scope precedence matches [FeatureOptions.test](#test): device wins over controller wins over global wins over default. Pass the scope arguments that describe the
vantage point you want to log from - typically a device identifier for accessory-level configuration, optionally with a controller identifier when the plugin's
controller scope is meaningful (e.g., UniFi Protect controllers).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check (same key shape as [FeatureOptions.test](#test); case-insensitive). |
| `label` | `string` | Human-readable label that prefixes the emitted message. Used verbatim as the first `%s` argument; should be a noun phrase like "Motion sensor" or "Read-only mode" so the rendered line reads naturally ("Motion sensor enabled." / "Read-only mode disabled."). |
| `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | The plugin's logger. The emitted message is INFO-level; debug-level enumeration of the full feature surface is a separate concern handled by the caller. |
| `device?` | `string` | Optional device scope identifier, forwarded to [FeatureOptions.test](#test). |
| `controller?` | `string` | Optional controller scope identifier, forwarded to [FeatureOptions.test](#test). |

###### Returns

`void`

###### Example

```ts
// Boolean option, inside a plugin's `configureMotion()` for a specific device:
featureOptions.logFeature("Motion", "Motion sensor", log, device.mac);

// Value-centric option - the message shape adapts to which axis (boolean, value, or both) deviated:
featureOptions.logFeature("Stream.Bandwidth", "Bandwidth", log, device.mac);

// With a controller scope:
featureOptions.logFeature("HKSV.Record", "HKSV recording", log, device.mac, controller.id);
```

##### scope()

```ts
scope(
   option, 
   device?, 
   controller?): OptionScope;
```

Return the scope hierarchy location of an option.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

[`OptionScope`](#optionscope)

Returns the location in the scope hierarchy of `option`.

##### setOption()

```ts
setOption(args): void;
```

Set the enabled state (and optionally the value) for an option at a given scope, replacing any prior entry for the same option-at-scope.

This is the single mutation primitive for individual feature options. Callers express intent ("enable option X at scope Y, with value Z") and the model owns
both the encoding and the prior-entry replacement - the configured-options array is canonical, the lookup index is rebuilt automatically, and the entry-string
format never leaks past this method. Value segments are emitted only when `enabled` is true and the option is value-centric; passing `value` for a non-value or
disabled option is silently dropped because the resulting entry would be meaningless under the resolution rules.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`SetOptionArgs`](#setoptionargs) | The mutation intent: option key, optional scope id, enabled state, and optional value. See [SetOptionArgs](#setoptionargs). |

###### Returns

`void`

###### Example

```ts
// Disable "Motion.Detect" globally.
featureOpts.setOption({ enabled: false, option: "Motion.Detect" });

// Enable "Audio.Volume" on device ABC123 with value 50, replacing any prior device-scoped entry for the same option.
featureOpts.setOption({ enabled: true, id: "ABC123", option: "Audio.Volume", value: 50 });
```

##### test()

```ts
test(
   option, 
   device?, 
   controller?): boolean;
```

Return the current state of a feature option, traversing the scope hierarchy.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

`boolean`

Returns true if the option is enabled, and false otherwise.

##### value()

```ts
value(
   option, 
   device?, 
controller?): Nullable<string | undefined>;
```

Return the value associated with a value-centric feature option, traversing the scope hierarchy.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

[`Nullable`](util.md#nullable)\<`string` \| `undefined`\>

Returns the current value associated with `option` if the feature option is enabled, `null` if disabled (or not a value-centric feature option), or
         `undefined` if it's not specified.

***

### CatalogIndex

Immutable derived index over the catalog inputs ([FeatureCategoryEntry](#featurecategoryentry)[] + the options map). Every field except `categories` / `options` is derived from
those two; the index bundles them with their derivations so a single value carries everything any caller needs to make catalog-level decisions in O(1).

The index is built once per catalog at [buildCatalogIndex](#buildcatalogindex); it is invariant across configured-options mutations, so a consumer that holds a stable
reference can rely on its query results until the catalog itself changes. The [FeatureOptions](#featureoptions) class holds one internally; consumers driving reducers
directly hold it as state and reuse it across every dispatch that does not touch the catalog.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="categories-1"></a> `categories` | `readonly` | readonly [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\>[] | The raw category list, preserved for callers that need to iterate it (rendering, validation, log enumeration). |
| <a id="defaults"></a> `defaults` | `readonly` | `Readonly`\<`Record`\<`string`, `boolean`\>\> | Lowercased-key map from canonical option name (the form [expandOption](#expandoption-1) produces) to its catalog-declared default. |
| <a id="groupparents-1"></a> `groupParents` | `readonly` | `Readonly`\<`Record`\<`string`, `string`\>\> | Reverse index from a child option's expanded name to its parent group's expanded name. Catalog case preserved on the keys. |
| <a id="groups-1"></a> `groups` | `readonly` | `Readonly`\<`Record`\<`string`, readonly `string`[]\>\> | Forward index from a parent group's expanded name to its child options' expanded names. |
| <a id="options-1"></a> `options` | `readonly` | `Readonly`\<`Record`\<`string`, readonly [`FeatureOptionEntry`](#featureoptionentry)[]\>\> | The raw options map, preserved alongside categories for the same reason. |
| <a id="renderers"></a> `renderers` | `readonly` | `Readonly`\<`Record`\<`string`, (`value`) => `string`\>\> | Lowercased-key map from canonical option name to its resolved value renderer (built-in or inline function). Built-in names that fail to resolve throw at index-build time rather than degrading silently at log time. |
| <a id="sortedvalueoptionnames"></a> `sortedValueOptionNames` | `readonly` | readonly `string`[] | The keys of `valueOptions`, sorted longest-first, cached so the parser can do its greedy-prefix match without re-sorting on every Enable-entry parse. |
| <a id="valueoptions"></a> `valueOptions` | `readonly` | `Readonly`\<`Record`\<`string`, `number` \| `string` \| `undefined`\>\> | Lowercased-key map from canonical option name to its declared default value. The presence of a key in this map is the SSOT for "this option is value-centric." |

***

### ClearOptionArgs

Arguments for [applyClearOption](#applyclearoption) and [FeatureOptions.clearOption](#clearoption). Carries the addressing intent: the option key and optional scope id, with no
enabled state or value because the operation forgets every entry addressing the target regardless of what they encoded.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="id"></a> `id?` | `string` | Optional device or controller scope identifier. Omit to address the global scope. |
| <a id="option"></a> `option` | `string` | Feature option to clear (case-insensitive). |

***

### FeatureCategoryEntry

Entry describing a feature option category.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TMeta` | `unknown` | The concrete type of the opaque [FeatureCategoryEntry.meta](#meta) annotation. Defaults to `unknown` for the same backward-compatibility reason as [FeatureOptionEntry](#featureoptionentry): a bare `FeatureCategoryEntry` resolves to `FeatureCategoryEntry<unknown>` and stays assignable to the typed form. |

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="description"></a> `description` | `string` | Description of the category. |
| <a id="meta"></a> `meta?` | `TMeta` | Optional. An opaque, plugin-private annotation channel the core never interprets, mirroring [FeatureOptionEntry.meta](#meta-1) so the category side carries the same typed extension path; the documentation renderer forwards it to the category-scope closure, and the core treats it as `unknown` throughout. |
| <a id="name"></a> `name` | `string` | Name of the category. |

***

### FeatureOptionEntry

Entry describing a feature option.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TMeta` | `unknown` | The concrete type of the opaque [FeatureOptionEntry.meta](#meta-1) annotation. Defaults to `unknown`, so a bare `FeatureOptionEntry` (the form every existing core consumer uses) resolves to `FeatureOptionEntry<unknown>` and stays assignable to the parameterized form, keeping the core non-generic. |

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="default"></a> `default` | `boolean` | Default enabled/disabled state for this feature option. |
| <a id="defaultvalue-1"></a> `defaultValue?` | `string` \| `number` | Optional. Default value for value-based feature options. |
| <a id="description-1"></a> `description` | `string` | Description of the feature option for display or documentation. |
| <a id="group"></a> `group?` | `string` | Optional. Grouping/category for the feature option. |
| <a id="inputsize"></a> `inputSize?` | `number` | Optional. Width of the input field for a value-based feature option. Defaults to 5 characters. |
| <a id="meta-1"></a> `meta?` | `TMeta` | Optional. An opaque, plugin-private annotation channel the core never interprets. HBPU's types deliberately cannot see inside `TMeta`; the value is carried verbatim through the catalog and forwarded to the documentation renderer's closures (the only surface that knows its concrete shape). This mirrors the OpenAPI `x-*` extension discipline, made type-safe: a plugin parameterizes the entry with its own annotation type, the core treats it as `unknown`, and the round-trip stays structurally invariant rather than a naming convention. |
| <a id="name-1"></a> `name` | `string` | Name of the feature option (used in option strings). |
| <a id="render"></a> `render?` | \| [`FeatureOptionFormatter`](#featureoptionformatter) \| ((`value`) => `string`) | Optional. Maps the raw stored value of a value-centric option to a display string. Either a [FeatureOptionFormatter](#featureoptionformatter) string naming a built-in formatter (preferred when the format already exists in the registry, since this keeps the enclosing catalog JSON-serializable and lets every plugin share one implementation) or an inline function for bespoke formatting the registry does not cover. Consulted by [FeatureOptions.logFeature](#logfeature) when emitting deviation lines so the catalog stays the single source of truth for how an option's value renders; ignored for plain boolean options. When absent, values render as the raw string returned by [FeatureOptions.value](#value). An unrecognized formatter name throws at catalog-rebuild time, surfacing the misconfiguration loudly rather than silently producing the raw-value fallback. |

***

### ResolvedOptionEntry

Resolved view of a feature option through the scope hierarchy. Captures the scope where the option was found, whether it's enabled, and the raw string value for
value-centric options. This single traversal result serves both boolean queries and value queries, eliminating duplicate scope walks. Returned by
[resolveScope](#resolvescope).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="enabled"></a> `enabled` | `boolean` | The resolved enabled state at the highest-precedence scope where the option was found. |
| <a id="optionvalue"></a> `optionValue?` | `string` | The raw string value when a value-centric option was set with an explicit value at the resolved scope. Absent otherwise. |
| <a id="scope-1"></a> `scope` | [`OptionScope`](#optionscope) | The scope where the option resolved, or "none" when no explicit entry was found at any scope. |

***

### SetOptionArgs

Arguments for [applySetOption](#applysetoption) and [FeatureOptions.setOption](#setoption). Carries the full mutation intent: the option key, optional scope id, enabled state,
and optional value for value-centric options.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="enabled-1"></a> `enabled` | `boolean` | True to enable, false to disable. |
| <a id="id-1"></a> `id?` | `string` | Optional device or controller scope identifier. Omit to address the global scope. |
| <a id="option-1"></a> `option` | `string` | Feature option to set (case-insensitive). |
| <a id="value-1"></a> `value?` | `string` \| `number` | Optional value for value-centric options. Honored only when `enabled` is true and the option is value-centric. |

***

### ConfigIndex

```ts
type ConfigIndex = ReadonlyMap<string, Readonly<{
  enabled: boolean;
  value?: string;
}>>;
```

Immutable lookup index over the configured-options array. Each lookup key is either the raw lowercased tail of an Enable/Disable entry (always present) or a
derived value-key for value-centric Enable entries that carry a trailing value segment. First-write-wins semantics on collision so the earliest entry in the
configured-options array takes precedence over later duplicates - a user hand-editing config and accidentally listing an option twice gets the natural
"first one is canonical" semantic.

Built by [buildConfigIndex](#buildconfigindex) from a `CatalogIndex` plus the configured-options array; consumed by [resolveScope](#resolvescope) and [optionExists](#optionexists) to answer
scope-aware questions in O(1).

***

### OptionScope

```ts
type OptionScope = "controller" | "device" | "global" | "none";
```

Describes all possible scope hierarchy locations for a feature option.

***

### applyClearOption()

```ts
function applyClearOption(options): readonly string[];
```

Compute the new configured-options array after clearing every entry addressing an option at a given scope. The match is value-aware: for value-centric options
it covers both the bare scoped entry and any entry carrying a single trailing value segment, so a subsequent [applySetOption](#applysetoption) cleanly replaces whatever
was there.

Pure: does not mutate the input array. When no entry matched the target, returns the input array reference unchanged so reference-equality consumers can detect
a no-op without a contents comparison.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `args`: [`ClearOptionArgs`](#clearoptionargs); `catalog`: [`CatalogIndex`](#catalogindex); `configuredOptions`: readonly `string`[]; \} | - |
| `options.args` | [`ClearOptionArgs`](#clearoptionargs) | The addressing intent: option key, optional scope id. See [ClearOptionArgs](#clearoptionargs). |
| `options.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index that defines what counts as a value-centric option (which the matcher consults via the shared parser). |
| `options.configuredOptions` | readonly `string`[] | The current configured-options array. |

#### Returns

readonly `string`[]

The new configured-options array, or the input array reference itself when nothing matched.

***

### applySetOption()

```ts
function applySetOption(options): string[];
```

Compute the new configured-options array after setting an option's enabled state (and optionally its value) at a given scope. Drops any prior entry addressing
the same option-at-scope so the new entry is the sole survivor, then appends the freshly composed entry string. Pure: does not mutate the input array; the
returned array is a fresh allocation.

The composed entry's action segment is canonical "Enable" / "Disable"; the option and id segments preserve the caller's casing for readability since the
lookup-index keys are case-insensitive anyway. Value tails are emitted only when meaningful - disabled or non-value options never carry one - so a subsequent
[applyClearOption](#applyclearoption) or [applySetOption](#applysetoption) addressing the same scope cleanly replaces whatever was there.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `args`: [`SetOptionArgs`](#setoptionargs); `catalog`: [`CatalogIndex`](#catalogindex); `configuredOptions`: readonly `string`[]; \} | - |
| `options.args` | [`SetOptionArgs`](#setoptionargs) | The mutation intent: option key, optional scope id, enabled state, optional value. See [SetOptionArgs](#setoptionargs). |
| `options.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index that defines what counts as a value-centric option (which determines whether to emit a value segment). |
| `options.configuredOptions` | readonly `string`[] | The current configured-options array. |

#### Returns

`string`[]

The new configured-options array. A fresh allocation, never a shared reference with the input.

***

### buildCatalogIndex()

```ts
function buildCatalogIndex(categories, options): CatalogIndex;
```

Build the catalog-derived index from raw categories + options. The result carries the raw inputs alongside every derivation needed for O(1) catalog queries -
defaults, value-options registry, groups (both directions), renderers, and the longest-first cache the entry parser consumes. Throws when a built-in formatter
name on a `render` declaration does not resolve, surfacing the misconfiguration at load time rather than silently degrading the log-emission path.

The index is the catalog-side input to every other pure helper in this module. Build it once per catalog; reuse it across every configured-options mutation
because the catalog is invariant across those mutations. Categories without an entry in the options map are skipped silently (a plugin defines a category for
future expansion before any option has migrated into it).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `categories` | readonly [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\>[] | The raw category list. |
| `options` | `Readonly`\<`Record`\<`string`, readonly [`FeatureOptionEntry`](#featureoptionentry)[]\>\> | The raw options map keyed by category name. |

#### Returns

[`CatalogIndex`](#catalogindex)

The immutable catalog index.

***

### buildConfigIndex()

```ts
function buildConfigIndex(catalog, configuredOptions): ConfigIndex;
```

Build the configured-options lookup index from a catalog index + the configured-options array. Each entry contributes one or two lookup keys via the shared
`parseEntry`: the raw tail (always) and an extracted value key (for value-centric Enable entries). First-write-wins on collision so the earliest entry in
the array takes precedence over later duplicates - users hand-editing config and accidentally listing an option twice get the natural "first one is canonical"
semantic.

Rebuild whenever the configured-options array changes; reuse across reads.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `catalog` | [`CatalogIndex`](#catalogindex) | The catalog index that defines what counts as a value-centric option. |
| `configuredOptions` | readonly `string`[] | The array of configured option strings. |

#### Returns

[`ConfigIndex`](#configindex)

The immutable lookup index.

***

### expandOption()

```ts
function expandOption(category, option): string;
```

Compose a fully formed feature option string from a category and an option. Accepts either raw strings or the catalog entry objects, mirroring how the catalog
is iterated at build time. The result is the canonical key shape every other helper consumes - lowercase the result to derive lookup-index keys, preserve the
caller's casing to compose entry strings.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `category` | `string` \| [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\> | Feature option category entry or category name string. |
| `option` | `string` \| [`FeatureOptionEntry`](#featureoptionentry)\<`unknown`\> | Feature option entry or option name string. |

#### Returns

`string`

The fully formed feature option in the form of `category.option`, or `category` alone when the option name is empty, or the empty string when the
         category name is empty.

***

### getDefaultValue()

```ts
function getDefaultValue(args): boolean;
```

Return the catalog-declared default for a feature option, falling back to a caller-supplied default for options that don't appear in the catalog at all.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `catalog`: [`CatalogIndex`](#catalogindex); `defaultReturnValue?`: `boolean`; `option`: `string`; \} | - |
| `args.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index. |
| `args.defaultReturnValue?` | `boolean` | Fallback when the option is not in the catalog's defaults map. Defaults to false. |
| `args.option` | `string` | The option key (case-insensitive). |

#### Returns

`boolean`

The default value: catalog declaration if present, fallback otherwise.

***

### isDependencyMet()

```ts
function isDependencyMet(args): boolean;
```

Return whether a grouped option's parent is currently enabled at the given scope. For options that aren't grouped (no `group` property in the catalog entry),
always returns `true` - there is no dependency to fail. For grouped options, traverses the scope hierarchy via [resolveScope](#resolvescope) to evaluate the parent's
effective state at the requested device + controller view.

This is the SSOT for "is this option's row currently usable?" Every caller that wants to know whether to render a grouped option's row, count it as visible,
or honor its dependency-hidden state asks this function rather than reconstructing the parent path themselves. The reverse-lookup from option to parent uses
the pre-built `catalog.groupParents` index, so the predicate is O(1) regardless of option-key length.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `catalog`: [`CatalogIndex`](#catalogindex); `configIndex`: [`ConfigIndex`](#configindex); `controller?`: `string`; `defaultReturnValue?`: `boolean`; `device?`: `string`; `option`: `string`; \} | - |
| `args.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index. |
| `args.configIndex` | [`ConfigIndex`](#configindex) | The configured-options lookup index. |
| `args.controller?` | `string` | Optional controller scope identifier. |
| `args.defaultReturnValue?` | `boolean` | Fallback default for options not in the catalog. Defaults to false. |
| `args.device?` | `string` | Optional device scope identifier. |
| `args.option` | `string` | Fully-qualified feature option string (e.g., `"Motion.Sensitivity"`). Case-insensitive. |

#### Returns

`boolean`

`true` when the option has no dependency or its parent is currently enabled at the requested scope; `false` when the parent is currently disabled.

***

### isValueOption()

```ts
function isValueOption(catalog, option): boolean;
```

Return whether a feature option is value-centric (carries a `defaultValue` in its catalog declaration). The presence of the option's lowercased key in the
catalog's `valueOptions` map is the SSOT for this predicate.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `catalog` | [`CatalogIndex`](#catalogindex) | The catalog index. |
| `option` | `string` | The option key (case-insensitive). Empty string returns false. |

#### Returns

`boolean`

True for value-centric options, false otherwise.

***

### optionExists()

```ts
function optionExists(args): boolean;
```

Return whether an option has been explicitly configured at the given scope. Distinct from [resolveScope](#resolvescope), which walks the hierarchy; this predicate
answers only "did the user set this entry at THIS scope?" without consulting any higher or lower scopes.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `configIndex`: [`ConfigIndex`](#configindex); `id?`: `string`; `option`: `string`; \} | - |
| `args.configIndex` | [`ConfigIndex`](#configindex) | The configured-options lookup index. |
| `args.id?` | `string` | Optional scope identifier (device or controller). Omit to address the global scope. |
| `args.option` | `string` | The option key (case-insensitive). |

#### Returns

`boolean`

True when an explicit entry addresses this option-at-scope.

***

### resolveScope()

```ts
function resolveScope(args): ResolvedOptionEntry;
```

Resolve a feature option through the scope hierarchy in a single traversal. Returns the scope where the option was found, its enabled state, and the raw value
for value-centric options. This is the core resolution primitive that every higher-level query builds on - [FeatureOptions.test](#test), [FeatureOptions.scope](#scope),
[FeatureOptions.value](#value), and [FeatureOptions.logFeature](#logfeature) all consume the same `ResolvedOptionEntry` shape from one walk.

Resolution precedence: device beats controller beats global beats default. An explicit entry at a higher-precedence scope short-circuits the lookup, so the
cost is O(1) in the configured-options array size.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `catalog`: [`CatalogIndex`](#catalogindex); `configIndex`: [`ConfigIndex`](#configindex); `controller?`: `string`; `defaultReturnValue?`: `boolean`; `device?`: `string`; `option`: `string`; \} | - |
| `args.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index (consulted for the default when no scope matched). |
| `args.configIndex` | [`ConfigIndex`](#configindex) | The configured-options lookup index. |
| `args.controller?` | `string` | Optional controller scope identifier. |
| `args.defaultReturnValue?` | `boolean` | Fallback for options that don't appear in the catalog's defaults. Defaults to false. |
| `args.device?` | `string` | Optional device scope identifier. |
| `args.option` | `string` | The option key to resolve (case-insensitive). |

#### Returns

[`ResolvedOptionEntry`](#resolvedoptionentry)

The resolved view: scope, enabled state, optional raw value.
