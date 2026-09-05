[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / featureOptions

# featureOptions

A hierarchical feature option system for plugins and applications.

The module exports two complementary surfaces:

  - **Pure functional core.** Catalog and config indices ([CatalogIndex](#catalogindex), [ConfigIndex](#configindex)) carry every derived view of the catalog and configured options;
    pure builders ([buildCatalogIndex](#buildcatalogindex), [buildConfigIndex](#buildconfigindex)) construct them from raw inputs; pure transforms ([applySetOption](#applysetoption),
    [applyClearOption](#applyclearoption), [normalizeConfiguredOptions](#normalizeconfiguredoptions)) compute new configured-options arrays without mutation; pure queries ([resolveScope](#resolvescope),
    [getDefaultValue](#getdefaultvalue), [isValueOption](#isvalueoption), [hasValueContent](#hasvaluecontent), [optionExists](#optionexists), [isDependencyMet](#isdependencymet-1), [expandOption](#expandoption-1),
    [enumerateConfiguredEntries](#enumerateconfiguredentries)) answer scope-aware questions over those indices. This is the single source of truth for option-array semantics, consumed
    wherever immutable state is the discipline (reducer-driven UIs, server-side renderers, time-travel debuggers, future consumers we have not built yet).

  - **Imperative class façade.** [FeatureOptions](#featureoptions) bundles a [CatalogIndex](#catalogindex), a configured-options array, and a [ConfigIndex](#configindex) into one object whose
    mutating methods (`setOption` / `clearOption` / the setters) delegate to the pure transforms internally. This is the legacy-friendly surface used by every
    plugin's Node-side code; the class's public API surface is identical to the pure-function core it delegates to.

Two surfaces, one set of semantics. The class is a convenience over the pure functions, not a parallel implementation.

### The configured-options entry grammar

A configured option is one string. `Enable.Motion.Detect` and `Disable.Motion.Detect.ABC123` address a boolean option globally and at a scope; the segment after
the option name, when present, is a device or controller id.

A value-centric option carries its value behind a payload delimiter, which is the canonical form and the only form written by
[setOption](#setoption):

```
Enable.Audio.Volume=50                          a global value
Enable.Audio.Volume.Kitchen=St. Cecilia's Mix   a scoped value
```

Everything ahead of the first "=" is the address and everything behind it is the value, so a value is free-form: periods, interior spaces, and further "="
characters all pass through untouched, and only the first "=" splits. Giving the payload its own delimiter is what lets dots address and nothing else.

Whitespace around the delimiter is tolerated - `Enable.Audio.Volume.Kitchen = 50` reads exactly as the tight form - because the address is right-trimmed and
the value trimmed. The one thing this puts out of reach is a value with leading or trailing spaces, which the writer already excludes by trimming what it
composes. The tolerance reaches only around "="; dots stay exact, so a space after a dot is part of the id.

The delimiter claims an entry only when the canonical reading holds together end to end: the address ahead of the "=" must be the option name alone or the
option name plus a single dot-free id, and a scoped payload must carry content - at least one character that is not the delimiter itself (see
[hasValueContent](#hasvaluecontent), which also explains why the value domain draws that line). An entry that fails either test reads under the legacy dot grammar
instead, with the "=" as ordinary value text: `Enable.Security.Key.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` ends in a bare delimiter that carries
nothing, so the whole tail stays a legacy global value, trailing "=" intact. One consequence is that a value-centric option storing a single value and enabled
at a device or controller scope always carries a value - the grammar has no scoped spelling for "enabled here, nothing given" - so
[setOption](#setoption) reduces that request to clearing the scope.

An option declaring [FeatureOptionEntry.multiple](#multiple) is the exception, because for a list "on, with nothing selected" is a selection like any other and has
to be tellable from the bare enable that resolves the registered default. Its zero-length payload therefore reads canonically at either scope, so
`Enable.Motion.SmartDetect=` and `Enable.Motion.SmartDetect.ABC123=` each store the empty selection. The exception reaches the empty payload alone: an all-"="
payload is base64-padding-shaped and stays with the legacy reading for every option.

The older form, where a value was simply the last dot-separated segment (`Enable.Audio.Volume.50`), still parses so hand-authored configurations keep working;
[normalizeConfiguredOptions](#normalizeconfiguredoptions) rewrites entries into the canonical form as configurations are saved.

### Declared scopes

A catalog entry may name the levels it belongs to through [FeatureOptionEntry.scopes](#scopes-1), in the `controller | device | global` vocabulary this module
already speaks. The declaration is enforced at every framework-owned surface: [resolveScope](#resolvescope) walks only the declared levels, the webUI renders an option's
row only on views the declaration admits, and the webUI's inheritance probe consults it too, so a click-time prediction and resolution always agree. An entry
that declares nothing is valid at every level, which is what lets a plugin narrow its catalog one entry at a time.

## Feature Options

### ConfiguredOptionEntry

One configured entry's reading of a single feature option: where it sits, what it says, and the value it carries when it carries one. Yielded by
[enumerateConfiguredEntries](#enumerateconfiguredentries), one record per entry that addresses the option.

Distinct from [ResolvedOptionEntry](#resolvedoptionentry), which answers "what applies here" after walking the hierarchy. This answers "what did the user write", entry by
entry, with no precedence applied and no catalog default substituted.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="enabled"></a> `enabled` | `boolean` | True for an `Enable` entry, false for a `Disable` entry. |
| <a id="id-1"></a> `id` | `string` | The device or controller identifier the entry addresses, in the casing the entry carried. The empty string for a global entry. |
| <a id="value-1"></a> `value?` | `string` | The raw value the entry carries, in the casing the entry carried. Absent when the entry carries none - a boolean option, a `Disable`, or a bare enable of a value option. Present and empty for a canonical entry whose payload is empty, which is the same reading the lookup index registers for it. |

***

### ConsolidatedValueArgs

Arguments for [FeatureOptions.consolidatedValue](#consolidatedvalue). Carries the addressing intent - the option and the identities to resolve it at - plus the configuration
property the caller still offers as that option's transition fallback.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="controller"></a> `controller?` | `string` | Optional controller scope identifier. |
| <a id="device"></a> `device?` | `string` | Optional device scope identifier. |
| <a id="fallback"></a> `fallback?` | `string` | Optional. The configuration property the plugin still carries for this option, read exactly as it is supplied. An empty string answers as itself, because what counts as an empty property is the caller's rule rather than the engine's. |
| <a id="option-1"></a> `option` | `string` | Feature option to read (case-insensitive). |

***

### FeatureOptionChoice

One selectable choice a value-centric option offers: what the editor shows, and what the configuration stores when the user picks it. A catalog declares its
choices inline on [FeatureOptionEntry.choices](#choices), or names a source the plugin's webUI registers and that derives the list from the device in view.

[isValidChoice](#isvalidchoice) is what makes a choice legal, and it is the one rule both sides answer to: [buildCatalogIndex](#buildcatalogindex) applies it to every inline choice at
catalog-build time, and the webUI's projection applies it to whatever a source returns at resolve time.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="label"></a> `label` | `string` | The text the editor shows for this choice. |
| <a id="value-2"></a> `value` | `string` | The text the configuration stores when this choice is picked. |

***

### SelectValuesArgs

Arguments for [selectValues](#selectvalues). Carries the reading intent: the domain to read against, whether the option stores a list, and the stored text itself.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="domain"></a> `domain` | readonly `string`[] | The values available in this context. |
| <a id="multiple-1"></a> `multiple` | `boolean` | Whether the option stores a list rather than a single value. |
| <a id="value-3"></a> `value` | `string` \| `undefined` | The stored text, or undefined when nothing is stored. |

***

### ValueSelection

What a stored value selects out of a domain, as [selectValues](#selectvalues) reads it.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="selected"></a> `selected` | `readonly` | readonly `string`[] | The members of the domain the stored value selects, in domain order and de-duplicated, each spelled as the domain spells it. |
| <a id="unknown"></a> `unknown` | `readonly` | readonly `string`[] | The entries the stored value names that the domain does not carry, in the order it named them and de-duplicated, each spelled as it was stored. Preserved rather than discarded so a choice the device stopped offering stays visible to both the editor and the plugin. |

***

### FeatureOptionFormatter

```ts
type FeatureOptionFormatter = "bps" | "bytes" | "kbps" | "ms" | "percent" | "seconds";
```

Named built-in formatters available to [FeatureOptionEntry.render](#render). The string literals double as discoverable, autocomplete-friendly names and as the
lookup keys into the registry that resolves them at catalog-rebuild time. Storing the catalog's renderer declaration as a string (rather than a function reference)
preserves the catalog's data-only shape so it stays JSON-serializable when every option uses a named formatter; the function escape hatch on `render` remains
available for bespoke needs that the registry does not cover.

The set targets the unit categories that recur across plugin catalogs: bitrate (in either of the two common storage conventions), data size, percentages, and
durations. Extend the union when a new format is genuinely shared across multiple plugins. Resist adding a formatter speculatively - the function escape
hatch already covers one-off needs, and an unused formatter is dead surface that downstream plugins still see in their IDE autocomplete.

***

### ALL\_CHOICES

```ts
const ALL_CHOICES: "*" = "*";
```

The one reserved spelling of a default meaning "every member of this option's domain", declared on a `multiple` option that also declares
[FeatureOptionEntry.choices](#choices). A domain a source derives from a device record cannot be enumerated in the catalog, so a multi-select over one has no other
way to say that everything is selected to begin with, and an empty default faked into that role would leave the editor's boxes describing a selection the
resolution does not have.

It is catalog data and nothing else. The editor never writes it into the configuration - a user's edit stores the explicit list, and a selection covering the
whole domain clears the entry so the option resumes tracking that domain - while a Node-side read expands it against a domain through [selectValues](#selectvalues). It
has no meaning on an option that is not `multiple` or declares no choices, and [buildCatalogIndex](#buildcatalogindex) rejects both declarations.

***

### composeScopeId()

```ts
function composeScopeId(controller, device): string;
```

Compose the scope identifier addressing one device of one controller, joining the two parts with a dash.

A device identifier that is unique only within its controller cannot address a scope on its own: two controllers can each own a device numbered "27", and a bare
"27" would name both of them. Qualifying the device with its controller is the whole answer, and the join lives here so every plugin that needs one spells it the
same way rather than hand-rolling a separator alongside its own rules about what may sit either side of it.

What comes back is an opaque device identifier as far as the engine is concerned. Nothing decomposes it - resolution matches it whole and the entry grammar
carries it whole - so the dash is a convention for the reader's eyes rather than a delimiter anything parses. Both parts must satisfy the identifier rule the
address grammar imposes, and a part that does not throws rather than composing an address no reader could resolve. A caller holding parts it does not shape asks
[isValidScopeId](#isvalidscopeid) about each one first and decides there what an unusable part means, so this throw stays the signal of a programming error. Whether the
composed value is unique across the caller's whole identifier space is the caller's own domain knowledge...this guarantees the spelling, not the uniqueness.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `controller` | `string` | The controller's identifier. |
| `device` | `string` | The device's identifier, unique within that controller. |

#### Returns

`string`

The composed scope identifier, ready to serve as the `id` of any scoped read or write.

#### Throws

`Error` naming the offending part when either part is empty or carries a period or an equals sign.

#### Example

```ts
// Address one shade of one hub, on a system whose device numbering repeats from hub to hub.
featureOpts.setOption({ enabled: false, id: composeScopeId(hub.serialNumber, shade.id), option: "Shade.Calibrate" });
```

***

### enumerateConfiguredEntries()

```ts
function enumerateConfiguredEntries(args): Generator<ConfiguredOptionEntry, void, undefined>;
```

Enumerate every configured entry that addresses one feature option, decoding each through the engine's own grammar. This is the supported way to discover which
scopes a plugin's users have configured an option at, and with what - a plugin that scans the configured-options array itself is re-implementing the storage
format, and the two readings drift the moment the grammar grows.

Yields one [ConfiguredOptionEntry](#configuredoptionentry) per addressing entry, in the order the entries appear in the array, and nothing at all for an option nobody configured.
Matching folds case, because the storage format does; the yielded identifiers and values keep the casing the entry was written in, because that is the text the
user typed and a consumer displaying it should show it back unchanged.

Two things this deliberately does not do, both of which belong to [resolveScope](#resolvescope): it applies no precedence - a device entry and a global entry for the
same option are two records here, not one winner - and it substitutes no catalog default, so an option with no entries yields nothing rather than a record
carrying its default. Ask this what the user wrote; ask [resolveScope](#resolvescope) what applies. Duplicate entries addressing the same scope each yield a record, so
the first-write-wins rule the lookup index applies is visible here as two records rather than resolved away.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `catalog`: [`CatalogIndex`](#catalogindex); `category?`: `string` \| [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\>; `configuredOptions`: readonly `string`[]; `option`: `string` \| [`FeatureOptionEntry`](#featureoptionentry)\<`unknown`\>; \} | - |
| `args.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index, which defines what counts as a value-centric option and which names are options in their own right. |
| `args.category?` | `string` \| [`FeatureCategoryEntry`](#featurecategoryentry)\<`unknown`\> | Optional. The option's category, composed with `option` exactly as [expandOption](#expandoption-1) composes them. Omit it when `option` is already the expanded name. |
| `args.configuredOptions` | readonly `string`[] | The raw configured-options array. |
| `args.option` | `string` \| [`FeatureOptionEntry`](#featureoptionentry)\<`unknown`\> | The feature option to enumerate: an option entry or name to be composed with `category`, or the expanded name on its own. |

#### Returns

`Generator`\<[`ConfiguredOptionEntry`](#configuredoptionentry), `void`, `undefined`\>

A generator over the configured entries addressing the option.

#### Example

```ts
// Every device that has this option configured, and the value each one carries.
for(const entry of enumerateConfiguredEntries({ catalog, configuredOptions, option: "Audio.Volume" })) {

  log.info("Volume is configured.", { enabled: entry.enabled, scope: entry.id.length ? entry.id : "global", value: entry.value });
}
```

***

### formatValueList()

```ts
function formatValueList(values): string;
```

Compose the canonical stored form of a list-valued option from its entries: join them with the bare delimiter. The inverse of [parseValueList](#parsevaluelist) over every
list that function produces, and the one writer of the stored form, so a UI composing a list and a plugin reading it back cannot disagree about the spelling.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `values` | readonly `string`[] | The entries to store. |

#### Returns

`string`

The canonical delimiter-joined text.

***

### hasValueContent()

```ts
function hasValueContent(value): boolean;
```

Return whether a string survives as a canonical payload once trimmed: at least one character other than the payload delimiter itself must remain. This is the
single definition of "carries a value", shared by the entry writer and the entry parser, and it is exported so a UI composing mutations can predict whether a
given input will persist - a prediction that has to agree with [applySetOption](#applysetoption) exactly for every option storing a single value. An option declaring
[FeatureOptionEntry.multiple](#multiple) persists one payload this refuses, the empty selection, so a UI predicting for a list asks after the declaration too.

The characters this excludes are not arbitrary. A payload that is empty or all "=" is exactly the shape a base64 value's terminal padding takes when a legacy
dot-form entry is scanned for the delimiter, so ruling that shape out of the canonical value domain is what lets those entries keep their legacy reading. The
empty selection is spelled with the zero-length payload alone and never with the all-"=" one, which keeps that collision guard whole: a list option's stored
empty is a shape no legacy entry can produce, since a legacy tail scanned for the delimiter always leaves the padding behind it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` | The candidate value text. |

#### Returns

`boolean`

True when the trimmed text carries at least one non-delimiter character, false otherwise.

***

### isValidChoice()

```ts
function isValidChoice(choice): choice is FeatureOptionChoice;
```

Return whether a candidate is a legal [FeatureOptionChoice](#featureoptionchoice): an object carrying a non-empty `label` and a non-empty `value` that neither contains the list
delimiter nor spells [ALL\_CHOICES](#all_choices). This is the single definition of what a legal choice is - [buildCatalogIndex](#buildcatalogindex) applies it to every inline choice a
catalog declares, and the webUI's projection applies it to every choice a registered source returns.

The two exclusions on the value are what keep a choice addressable once a list stores it. A value carrying the delimiter would come back from
[parseValueList](#parsevaluelist) as two entries, neither of which names a choice; a value spelling the all-choices default would be indistinguishable from the wildcard
the read side expands against the whole domain.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `choice` | `unknown` | The candidate. |

#### Returns

`choice is FeatureOptionChoice`

True when the candidate is a legal choice, false otherwise.

***

### isValidScopeId()

```ts
function isValidScopeId(id): boolean;
```

Return whether a string may serve as a scope identifier: non-empty, and carrying neither a period nor an equals sign.

This is the single definition of what a scope identifier may spell. The address grammar spends both characters elsewhere - a dot separates address segments, and
the first "=" ends the address - so an identifier holding either names a scope the grammar has no spelling for. Every surface that composes, validates, or matches
a scoped address consults this one predicate, which is what keeps the writers and the readers agreeing about which addresses exist at all.

A plugin whose identifiers come from a source it does not shape - a cloud-issued home id, a serial a controller hands over - screens each part once, at the
boundary where it learns the identifier, and decides there what an unusable one means in its own terms: warn and keep serving without per-device options, fall
back to a coarser scope, or refuse the device outright. The parts it then hands [composeScopeId](#composescopeid) are parts it trusts, which leaves that composer's throw
what it is meant to be...the signal of a programming error, rather than a runtime posture a supervised loop has to catch. A plugin that repairs an unusable
identifier rather than refusing it reaches for [scopeSafeId](#scopesafeid), whose substitutions follow this same rule.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The candidate identifier. |

#### Returns

`boolean`

`true` when the string may serve as a scope identifier, `false` when it may not.

#### Example

```ts
// Screen the cloud-issued identifier where it is learned, once, and keep the composer for the parts that survive the screen.
if(!isValidScopeId(home.cloudId)) {

  log.warn("This home reports the identifier %s, which cannot address per-shade feature options.", home.cloudId);

  return;
}

featureOpts.setOption({ enabled: false, id: composeScopeId(home.cloudId, shade.id), option: "Shade.Calibrate" });
```

***

### parseValueList()

```ts
function parseValueList(value): readonly string[];
```

Split a list-valued option's stored string into the entries it names: split on the delimiter, trim each entry, and drop the empties. Paired with
[formatValueList](#formatvaluelist), which composes the canonical form, so a parse followed by a format is stable for every string this accepts - hand-authored spacing and
stray delimiters normalize the first time the value is written and never move again.

Duplicates pass through as written. Whether a repeated entry means anything is the consumer's question, and [selectValues](#selectvalues) is where a selection over a
domain de-duplicates.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` | The raw stored text. |

#### Returns

readonly `string`[]

The entries the text names, in the order it names them.

***

### scopeSafeId()

```ts
function scopeSafeId(id): string;
```

Repair a string into one that may serve as a scope identifier, replacing every character the address grammar reserves with the separator the composer joins with.

A plugin whose identifiers come from a source it does not shape - a cloud-issued home id, a serial a controller hands over - has two honest answers to an
identifier the rule turns away: refuse it, which [isValidScopeId](#isvalidscopeid) is the screen for, or repair it and keep serving. This is the repair, and what it answers
becomes that plugin's identity for the thing everywhere - its accessory UUIDs, its option addresses, the context they are read back through - rather than a
display alias sitting over a raw identifier the addressing still uses. Choosing one or the other is the plugin's call; spelling the repair is not, which is why it
lives beside the rule it repairs against rather than in each consumer.

An identifier the rule already accepts answers character-identical, so adopting this cannot move an address the field has already produced. An empty identifier
answers empty, because no substitution can invent one...[isValidScopeId](#isvalidscopeid) therefore remains the usability check after this, rather than being made redundant
by it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The candidate identifier, from a source the caller does not shape. |

#### Returns

`string`

The identifier with every reserved character replaced, ready for [isValidScopeId](#isvalidscopeid) to have the final word on.

#### Example

```ts
// Repair the cloud-issued identifier where it is learned, once, and address every per-device scope of that home by what comes back.
const homeId = scopeSafeId(home.cloudId);

featureOpts.setOption({ enabled: false, id: composeScopeId(homeId, shade.id), option: "Shade.Calibrate" });
```

***

### selectValues()

```ts
function selectValues(args): ValueSelection;
```

Read which members of a domain a stored value selects, and which entries it names that the domain does not carry. The single definition of what a stored value
SELECTS, shared by the Node-side read ([FeatureOptions.valueList](#valuelist)) and the webUI's projection, so a plugin acting on a selection and the editor showing
it can never disagree - including about the [ALL\_CHOICES](#all_choices) wildcard, which is expanded here and nowhere else.

Matching folds case, and a match answers in the domain's spelling: a stored "medium" selects a domain's "Medium" and reads back as "Medium", because the domain
is the authority on how the values it offers are spelled. The fold is matching-only - nothing stored is rewritten - and it lives at this chokepoint alone,
which is the honest scope to state: [FeatureOptions.value](#value) and the readers built on it are handed no domain, so they answer stored or declared text
verbatim.

An entry no member of the domain folds to is reported rather than discarded, in the text it was stored as, since the domain has no spelling to offer for a
value it does not carry. A device that stops offering a value the user chose earlier - a detection type a firmware update withdrew, a relay output a smaller
unit does not have - would otherwise have that choice silently dropped from the configuration the next time anything wrote it, so the editor keeps showing it
and the plugin can say what it is looking at.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`SelectValuesArgs`](#selectvaluesargs) | - |

#### Returns

[`ValueSelection`](#valueselection)

The selected members, spelled as the domain spells them and in domain order, and the named-but-absent entries, spelled as they were stored and in the
         order the stored value named them. Both are de-duplicated on the folded value.

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
   configuredOptions?
): FeatureOptions;
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
value-centric options it covers the bare scoped entry and any entry carrying a value, in either the canonical or the legacy form, so a subsequent
[setOption](#setoption) cleanly replaces whatever was there. No-op when no entry addresses the target scope, so callers can treat this as a repeatable reset.

A scoped clear whose id cannot address the option is refused rather than performed: an id carrying a period or an equals sign has no spelling in the address
grammar, and an id whose composed address is itself a catalog option would delete that option's own entry in the name of clearing a scope of a shorter one. A
global clear has no id to check, and a legal scoped clear is unaffected.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`ClearOptionArgs`](#clearoptionargs) | The addressing intent: option key and optional scope id. See [ClearOptionArgs](#clearoptionargs). |

###### Returns

`void`

###### Throws

`Error` naming the id and the option when a present id cannot address a scope of that option.

###### Example

```ts
// Remove any configured value for "Audio.Volume" on device ABC123 (drops both `Enable.Audio.Volume.ABC123` and `Enable.Audio.Volume.ABC123=50`).
featureOpts.clearOption({ option: "Audio.Volume", id: "ABC123" });
```

##### consolidatedValue()

```ts
consolidatedValue(args): Nullable<string | undefined>;
```

Return the effective value of a value-centric option for a plugin that still carries a configuration property as that option's transition fallback.

One rule decides it, and it is one rule because a setting a user can reach in two places needs a single statement of which one answers. A configured option
rules in every state it can be in - enabled with a value, disabled, or enabled with no value at all - because configuring an option is the user saying what
they want, so `fallback` never outranks an entry the user wrote. An option nobody has configured yields to the property. The catalog's registered default
closes the chain, so an unconfigured option with no property beside it answers exactly what [value](#value) answers.

Configured-ness here is the resolution's own scope rather than [exists](#exists). The walk honors the entry's declared scopes, so an entry
written where the option does not apply cannot make it configured for an identity it never reaches; `exists` reads the configured entries alone and is blind to
those declarations.

The answer vocabulary is `value`'s: `null` for a disabled option and for one that is not value-centric, `undefined` for one enabled at an explicit scope with
nothing stored, and the string otherwise. A caller that turns its feature off on `null` or `undefined` therefore needs no second read to tell those states
apart. `fallback` is read exactly as it is supplied, an empty string included, because what counts as an empty property is the caller's rule rather than the
engine's.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`ConsolidatedValueArgs`](#consolidatedvalueargs) | - |

###### Returns

[`Nullable`](util.md#nullable)\<`string` \| `undefined`\>

The configured entry's value, the fallback, or the registered default, in the vocabulary described above.

###### Example

```ts
// An API key the plugin still accepts as a configuration property while the option takes the setting over.
const apiKey = featureOpts.consolidatedValue({ fallback: config.apiKey, option: "Api.Key" });

// The same read for a catalog declaring the option at controller scope, resolved at one controller's identity.
const brokerUrl = featureOpts.consolidatedValue({ controller: mac, fallback: config.mqttUrl, option: "Mqtt.Url" });
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

This reads the configured entries alone and is blind to [FeatureOptionEntry.scopes](#scopes-1): it reports what the user configured, not what takes effect. Ask
[FeatureOptions.test](#test) when the question is whether the option applies at a given scope.

A scoped question is arbitrated against the catalog, so an id whose composed address belongs to another option reads false - see [optionExists](#optionexists), which
this delegates to.

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
   controller?
): Nullable<number | undefined>;
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
   controller?
): Nullable<number | undefined>;
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
   controller?
): boolean;
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
   controller?
): void;
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

An option declaring [FeatureOptionEntry.multiple](#multiple) that resolves to the empty selection keeps the same axis split and states the emptiness in words:
`<label> enabled with an empty selection.` where the boolean axis deviated, `<label> set to an empty selection.` where only the value axis did. Saying it
outright is what keeps the line a sentence, since interpolating the empty string into either shape above would emit "enabled at ." instead.

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
   controller?
): OptionScope;
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
format never leaks past this method. Values are emitted only when `enabled` is true and the option is value-centric; passing `value` for a non-value or
disabled option is silently dropped because the resulting entry would be meaningless under the resolution rules. A value is free-form at either scope - it is
written behind a payload delimiter and trimmed of surrounding whitespace - and persists only when content survives the trim (see [hasValueContent](#hasvaluecontent)).
At the global scope an enable without content composes the bare entry; at a device or controller scope it reduces to clearing the scope, because a scoped
entry storing a single value always carries one. An option declaring [FeatureOptionEntry.multiple](#multiple) persists a SUPPLIED empty value at either scope
instead, as the explicit empty selection; omitting the value keeps the behavior every other option gets.

Saving also modernizes: any surviving entry still in the legacy dot form is rewritten into the canonical form as part of the same mutation. See
[normalizeConfiguredOptions](#normalizeconfiguredoptions) for what that does and does not touch.

A scoped write whose id cannot address the option is refused rather than composed: an id carrying a period or an equals sign has no spelling in the address
grammar, and an id whose composed address is itself a catalog option would write that option's own entry under another option's name. A global write has no id
to check, and a legal scoped write is unaffected.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`SetOptionArgs`](#setoptionargs) | The mutation intent: option key, optional scope id, enabled state, and optional value. See [SetOptionArgs](#setoptionargs). |

###### Returns

`void`

###### Throws

`Error` naming the id and the option when a present id cannot address a scope of that option.

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
   controller?
): boolean;
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
   controller?
): Nullable<string | undefined>;
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
         `undefined` if it's not specified. An option declaring [FeatureOptionEntry.multiple](#multiple) answers the empty string where its stored selection is
         explicitly empty, which is a configured state rather than an unspecified one; for every option storing a single value an empty stored value reads
         as unspecified and resolves onward.

##### valueDefault()

```ts
valueDefault(option): string | undefined;
```

Return the value-centric default an option's catalog declaration registers, rendered as a string.

The value-axis companion to [defaultValue](#defaultvalue), which answers the boolean axis. This reports the declaration alone - no scope
resolution, no expansion - so an [ALL\_CHOICES](#all_choices) default comes back as the wildcard itself and reading it against a domain stays
[valueList](#valuelist)'s job. A declared-empty default answers the empty string, which is the declaration as written and a different
answer from the `undefined` that says there is no value-centric default here at all.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check (case-insensitive). |

###### Returns

`string` \| `undefined`

Returns the registered default rendered as a string, or `undefined` for an option that is not value-centric and for one the catalog does not carry.

##### valueList()

```ts
valueList(args): readonly string[];
```

Return what a picker option's stored value selects, resolved through the scope hierarchy. The list read that pairs with [value](#value),
which stays the single resolution: this method asks it what the option resolves to and then reads that text against a domain, rather than walking the
hierarchy a second time.

The domain decides how much reading happens. Supply one - the values the device actually reports - and the result is the members of that domain the stored
value selects, in domain order, with an [ALL\_CHOICES](#all_choices) default expanded and any value the device no longer offers dropped. Supply none and an option
whose catalog entry declares its choices inline reads against those, since the catalog already holds them. Supply none for a source-backed option and the
stored text answers for itself: a `multiple` option's entries as the user's order named them, a single-valued option's value as the one member.

An option that resolves to nothing reads as the empty list - disabled at some scope, enabled with no value, emptied on purpose, unknown to the catalog, or
not value-centric at all. There is no separate "nothing here" answer to check for, so a caller iterates the result and is done.

Asking for `defaultWhenUnset` changes exactly one of those readings: an option enabled at an explicit scope with nothing stored answers its registered
default, read against the same domain and expanded the same way a stored value would be. The others hold - an emptied selection is a choice the user made
and stays empty, and a disabled option has no value to substitute for.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`ValueListArgs`](#valuelistargs) | - |

###### Returns

readonly `string`[]

The selected values, or an empty list when the option resolves to none.

###### Example

```ts
// A domain the device reported: unknown members drop and an all-choices default expands to everything the camera offers.
const types = featureOpts.valueList({ device: camera.mac, domain: camera.featureFlags.smartDetectTypes, option: "Motion.SmartDetect" });

// No domain: an inline catalog list answers for itself, and a free-form list reads back exactly as the user entered it.
const plates = featureOpts.valueList({ device: camera.mac, option: "Motion.Plates" });
```

***

### CatalogIndex

Immutable derived index over the catalog inputs ([FeatureCategoryEntry](#featurecategoryentry)[] + the options map). Every field except `categories` / `options` is derived from
those two; the index bundles them with their derivations so a single value carries everything any caller needs to make catalog-level decisions in O(1).

The index is built once per catalog at [buildCatalogIndex](#buildcatalogindex); it is unchanged across configured-options mutations, so a consumer that holds a stable
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
| <a id="optionsbyname"></a> `optionsByName` | `readonly` | `Readonly`\<`Record`\<`string`, [`FeatureOptionEntry`](#featureoptionentry)\>\> | Lowercased-key map from canonical option name to the raw catalog entry, the general per-option lookup for any consumer that needs the entry itself rather than one of the derivations beside it. Keyed exactly as `valueOptions` is, so one key discipline serves every registry on the index. It is named for what it holds because `entries` already means a category's projected rows in the webUI's vocabulary. |
| <a id="renderers"></a> `renderers` | `readonly` | `Readonly`\<`Record`\<`string`, (`value`) => `string`\>\> | Lowercased-key map from canonical option name to its resolved value renderer (built-in or inline function). Built-in names that fail to resolve throw at index-build time rather than degrading silently at log time. |
| <a id="scopes"></a> `scopes` | `readonly` | `Readonly`\<`Record`\<`string`, readonly [`FeatureOptionScope`](#featureoptionscope)[]\>\> | Lowercased-key map from canonical option name to the scope levels its catalog entry declares. An option that declares nothing has no key here, which is how the absent-means-every-level default stays free: the lookup returns `undefined` and every consumer reads that as "no restriction." See [FeatureOptionEntry.scopes](#scopes-1). |
| <a id="sortedvalueoptionnames"></a> `sortedValueOptionNames` | `readonly` | readonly `string`[] | The keys of `valueOptions`, sorted longest-first, cached so the parser can do its greedy-prefix match without re-sorting on every Enable-entry parse. |
| <a id="valueoptions"></a> `valueOptions` | `readonly` | `Readonly`\<`Record`\<`string`, `number` \| `string` \| `undefined`\>\> | Lowercased-key map from canonical option name to its declared default value. The presence of a key in this map is the SSOT for "this option is value-centric." |

***

### ClearOptionArgs

Arguments for [applyClearOption](#applyclearoption) and [FeatureOptions.clearOption](#clearoption). Carries the addressing intent: the option key and optional scope id, with no
enabled state or value because the operation forgets every entry addressing the target regardless of what they encoded.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="id"></a> `id?` | `string` | Optional device or controller scope identifier. Omit to address the global scope. An identifier carrying a period or an equals sign, or one whose composed address names another catalog option, is refused rather than cleared - see [composeScopeId](#composescopeid), which composes a controller-qualified identifier under the same rule. |
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

#### Example

```ts
// An irrigation plugin whose controllers own zones. Exposing a zone is meaningful for the controller as a whole and for each zone beneath it; a per-zone runtime
// cap is a zone-level concern, so declaring it device-only keeps it off the account-wide page where one save would have applied it to every zone at once.
const options: Record<string, FeatureOptionEntry[]> = {

  Zone: [

    { default: true, description: "Expose this zone in HomeKit.", name: "Enable", scopes: [ "controller", "device" ] },
    { default: false, defaultValue: 300, description: "Maximum zone runtime, in seconds.", name: "Runtime", scopes: ["device"] }
  ]
};
```

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TMeta` | `unknown` | The concrete type of the opaque [FeatureOptionEntry.meta](#meta-1) annotation. Defaults to `unknown`, so a bare `FeatureOptionEntry` (the form every existing core consumer uses) resolves to `FeatureOptionEntry<unknown>` and stays assignable to the parameterized form, keeping the core non-generic. |

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="choices"></a> `choices?` | `string` \| readonly [`FeatureOptionChoice`](#featureoptionchoice)[] | Optional. The list of values this option offers, which makes its editor a picker rather than a free-text field. A string names a source the plugin's webUI registers in its `ui.choices` bag; an array is a fixed list declared inline. Either way the editor offers the list and the configuration stores the chosen value, or values for a `multiple` option. Editor-only, exactly as `secret` is: parsing, storage, scope resolution, and [FeatureOptions.value](#value) never consult it. A source resolver receives the controller, the device (undefined at global and controller scope), and the option, and returns the list for that context; it must be a pure, cheap function of those three, since it runs on every projection recompute - the same cadence as the webUI's `validOption`. A string naming a source no resolver answers to fails the webUI at catalog load. An inline list is validated here at catalog build, members and default alike; a source-backed default cannot be, because the domain it draws on exists only on the page that holds the device record. |
| <a id="default"></a> `default` | `boolean` | Default enabled/disabled state for this feature option. |
| <a id="defaultvalue-1"></a> `defaultValue?` | `string` \| `number` | Optional. Default value for value-based feature options. |
| <a id="description-1"></a> `description` | `string` | Description of the feature option for display or documentation. |
| <a id="group"></a> `group?` | `string` | Optional. Grouping/category for the feature option. |
| <a id="inputsize"></a> `inputSize?` | `number` | Optional. Width, in characters, of a field the user TYPES a value into. Defaults to 5. Every such field reads it - the free-text field, the masked field a `secret` declares, and the field a list editor takes its next entry in - while a control that OFFERS a list sizes itself to the members it holds and reads nothing here. |
| <a id="meta-1"></a> `meta?` | `TMeta` | Optional. An opaque, plugin-private annotation channel the core never interprets. HBPU's types deliberately cannot see inside `TMeta`; the value is carried verbatim through the catalog and forwarded to the documentation renderer's closures (the only surface that knows its concrete shape). This mirrors the OpenAPI `x-*` extension discipline, made type-safe: a plugin parameterizes the entry with its own annotation type, the core treats it as `unknown`, and the round-trip stays structurally unchanged rather than a naming convention. |
| <a id="multiple"></a> `multiple?` | `boolean` | Optional. True declares the option's value a LIST rather than a single value, stored in the shared list grammar as one comma-joined string ([parseValueList](#parsevaluelist) and [formatValueList](#formatvaluelist) are the pair that reads and writes it). With `choices` the editor is a checkbox group over the offered list; without them it is a free-form list the user builds entry by entry. With `choices` the default may be [ALL\_CHOICES](#all_choices), standing for every member of the option's domain. The engine sees one string throughout, which [FeatureOptions.valueList](#valuelist) is the read that splits, and the declaration reaches the grammar in one place: a list can be explicitly empty, so a zero-length payload stores that selection at either scope rather than reading as no value at all. |
| <a id="name-1"></a> `name` | `string` | Name of the feature option (used in option strings). |
| <a id="render"></a> `render?` | \| [`FeatureOptionFormatter`](#featureoptionformatter) \| ((`value`) => `string`) | Optional. Maps the raw stored value of a value-centric option to a display string. Either a [FeatureOptionFormatter](#featureoptionformatter) string naming a built-in formatter (preferred when the format already exists in the registry, since this keeps the enclosing catalog JSON-serializable and lets every plugin share one implementation) or an inline function for bespoke formatting the registry does not cover. Consulted by [FeatureOptions.logFeature](#logfeature) when emitting deviation lines so the catalog stays the single source of truth for how an option's value renders; ignored for plain boolean options. When absent, values render as the raw string returned by [FeatureOptions.value](#value). An unrecognized formatter name throws at catalog-rebuild time, surfacing the misconfiguration loudly rather than silently producing the raw-value fallback. |
| <a id="scopes-1"></a> `scopes?` | readonly \[[`FeatureOptionScope`](#featureoptionscope), [`FeatureOptionScope`](#featureoptionscope)\] | Optional. The scope levels this option may be configured at - one or more of them, named in the [FeatureOptionScope](#featureoptionscope) vocabulary. Absent means every level, which is what an entry that declares nothing gets. Declared, it is true at every surface the framework owns: the option renders only on views the declaration admits - a global view needs `"global"`, a controller view needs `"controller"`, and a device view needs either `"controller"` or `"device"` - it resolves only at the declared levels, and a row inherits from a higher scope only through them. What you cannot resolve, you are neither offered nor promised through inheritance. Which devices see a device-view row stays with the plugin's `validOption`, refining the rows the declaration already admits. Declare consistent levels across a group: a child's dependency check resolves the PARENT's option, so a parent declared narrower than its children ignores parent configuration at exactly the levels the children are still editable from. The tuple is non-empty by construction, since an option declaring no level at all would render nowhere and resolve nowhere. |
| <a id="secret"></a> `secret?` | `boolean` | Optional. True declares that the option's value is a secret the settings page must not display in clear text by default: the field renders masked, with a reveal the user operates when they want to read or check what they typed. Presentation only - parsing, storage, scope resolution, and the documentation renderer treat a secret option exactly like any other value option, and its value lands in `config.json` as plain text like every other value. What the masking buys is protection from someone reading the settings page over the user's shoulder; it is not secrecy at rest, and a plugin handling real credentials should say so in the option's description. |
| <a id="style"></a> `style?` | `"dropdown"` \| `"radio"` | Optional. How a single choice offers its list on the settings page - `"dropdown"` for a select, `"radio"` for a group of radio buttons - overriding the presentation the editor picks on its own: a short inline list reads as a radio group, while a longer one or a list a source derives per device reads as a dropdown. Presentation only, exactly as `secret` is: neither the declaration nor the automatic pick changes what is stored, the entry grammar, or anything the engine resolves. Declared without `choices`, or on a `multiple` option, it is a catalog error - the first has no list to present and the second has a presentation of its own. |

***

### ResolvedOptionEntry

Resolved view of a feature option through the scope hierarchy. Captures the scope where the option was found, whether it's enabled, and the raw string value for
value-centric options. This single traversal result serves both boolean queries and value queries, eliminating duplicate scope walks. Returned by
[resolveScope](#resolvescope).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="enabled-1"></a> `enabled` | `boolean` | The resolved enabled state at the highest-precedence scope where the option was found. |
| <a id="optionvalue"></a> `optionValue?` | `string` | The raw string value when a value-centric option was set with an explicit value at the resolved scope. Absent otherwise. |
| <a id="scope-1"></a> `scope` | [`OptionScope`](#optionscope) | The scope where the option resolved, or "none" when no explicit entry was found at any scope. |

***

### SetOptionArgs

Arguments for [applySetOption](#applysetoption) and [FeatureOptions.setOption](#setoption). Carries the full mutation intent: the option key, optional scope id, enabled state,
and optional value for value-centric options.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="enabled-2"></a> `enabled` | `boolean` | True to enable, false to disable. |
| <a id="id-2"></a> `id?` | `string` | Optional device or controller scope identifier. Omit to address the global scope. An identifier carrying a period or an equals sign, or one whose composed address names another catalog option, is refused rather than written - see [composeScopeId](#composescopeid), which composes a controller-qualified identifier under the same rule. |
| <a id="option-2"></a> `option` | `string` | Feature option to set (case-insensitive). |
| <a id="value-4"></a> `value?` | `string` \| `number` | Optional value for value-centric options. Honored only when `enabled` is true and the option is value-centric. Free-form at either scope: the composed entry carries it behind a payload delimiter, trimmed of surrounding whitespace, and it persists only when content survives the trim (see [hasValueContent](#hasvaluecontent)). At a device or controller scope an enable without value content reduces to clearing the scope, because a scoped entry storing a single value always carries one. Supplying the empty string for a [FeatureOptionEntry.multiple](#multiple) option is the one value without content that persists: it is the explicit empty selection, and it composes at either scope. Omitting `value` entirely says nothing about the selection and keeps the plain enable, for every option alike. |

***

### ValueListArgs

Arguments for [FeatureOptions.valueList](#valuelist). Carries the addressing intent - the option and the scope to resolve it at - plus the domain the caller wants the
stored value read against.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="controller-1"></a> `controller?` | `string` | Optional controller scope identifier. |
| <a id="defaultwhenunset"></a> `defaultWhenUnset?` | `boolean` | Optional. Read an option that is enabled at an explicit scope with nothing stored as its registered default rather than as the empty list. It reaches that one state and no other: a disabled option, an option the catalog does not carry, and one that is not value-centric all still read empty, and a `multiple` option whose selection the user emptied stays empty, since emptying it was a choice the user made rather than a value they omitted. |
| <a id="device-1"></a> `device?` | `string` | Optional device scope identifier. |
| <a id="domain-1"></a> `domain?` | readonly `string`[] | Optional. The values the option offers in this context, which a plugin derives from whatever the device reported. Supplying it is what lets the read drop a stored value the device no longer offers and expand an [ALL\_CHOICES](#all_choices) default. Omit it for an option whose catalog entry declares its choices inline, since the entry already holds them, and for a raw read of what the user stored. |
| <a id="option-3"></a> `option` | `string` | Feature option to read (case-insensitive). |

***

### ConfigIndex

```ts
type ConfigIndex = ReadonlyMap<string, Readonly<{
  enabled: boolean;
  value?: string;
}>>;
```

Immutable lookup index over the configured-options array. Each lookup key is either the raw lowercased tail of an Enable/Disable entry (always present) or a
derived value-key for value-centric Enable entries that carry a value. First-write-wins semantics on collision so the earliest entry in the
configured-options array takes precedence over later duplicates - a user hand-editing config and accidentally listing an option twice gets the natural
"first one is canonical" semantic.

Built by [buildConfigIndex](#buildconfigindex) from a `CatalogIndex` plus the configured-options array; consumed by [resolveScope](#resolvescope) and [optionExists](#optionexists) to answer
scope-aware questions in O(1).

***

### FeatureOptionScope

```ts
type FeatureOptionScope = "controller" | "device" | "global";
```

The scope levels at which a feature option may be configured, and the vocabulary a catalog entry uses to declare where it belongs. These are the same levels
[resolveScope](#resolvescope) walks: [OptionScope](#optionscope) is this union plus the `"none"` outcome resolution reports when nothing was configured anywhere, so the
declaration side and the resolution side read from one vocabulary and cannot drift apart.

***

### OptionScope

```ts
type OptionScope = FeatureOptionScope | "none";
```

Describes all possible scope hierarchy locations for a feature option. The configurable levels are [FeatureOptionScope](#featureoptionscope), shared with the catalog entry's
`scopes` declaration; `"none"` is the resolution-only outcome saying no configured entry matched at any level and the catalog default applied.

***

### applyClearOption()

```ts
function applyClearOption(options): readonly string[];
```

Compute the new configured-options array after clearing every entry addressing an option at a given scope. The match is value-aware: for value-centric options
it covers the bare scoped entry and any entry carrying a value, in either the canonical or the legacy form, so a subsequent [applySetOption](#applysetoption) cleanly
replaces whatever was there.

Pure: does not mutate the input array. When no entry matched the target and none needed modernizing, returns the input array reference unchanged so
reference-equality consumers can detect a no-op without a contents comparison. Surviving entries are normalized on the way through, so a clear carries the same
upgrade-on-save behavior a set does. See [normalizeConfiguredOptions](#normalizeconfiguredoptions).

A scoped clear whose id cannot address the option is refused on the same terms [applySetOption](#applysetoption) refuses a write, and for a sharper reason: an id whose
composed address is itself a catalog option would delete that option's own entry in the name of clearing a scope of a shorter one. A global clear has no id to
check, and a legal scoped clear is unaffected.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `args`: [`ClearOptionArgs`](#clearoptionargs); `catalog`: [`CatalogIndex`](#catalogindex); `configuredOptions`: readonly `string`[]; \} | - |
| `options.args` | [`ClearOptionArgs`](#clearoptionargs) | The addressing intent: option key, optional scope id. See [ClearOptionArgs](#clearoptionargs). |
| `options.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index that defines what counts as a value-centric option (which the matcher consults via the shared parser), and which settles whether a scoped target belongs to this option or to another one. |
| `options.configuredOptions` | readonly `string`[] | The current configured-options array. |

#### Returns

readonly `string`[]

The new configured-options array, or the input array reference itself when nothing matched and nothing needed rewriting.

#### Throws

`Error` naming the id and the option when a present id cannot address a scope of that option.

***

### applySetOption()

```ts
function applySetOption(options): readonly string[];
```

Compute the new configured-options array after setting an option's enabled state (and optionally its value) at a given scope. Drops any prior entry addressing
the same option-at-scope so the new entry is the sole survivor, then appends the freshly composed entry string. Pure: does not mutate the input array.

The composed entry's action segment is canonical "Enable" / "Disable"; the option and id segments preserve the caller's casing for readability since the
lookup-index keys are case-insensitive anyway. Values are emitted only when meaningful - disabled or non-value options never carry one - so a subsequent
[applyClearOption](#applyclearoption) or [applySetOption](#applysetoption) addressing the same scope cleanly replaces whatever was there, in either the canonical or the legacy form,
because the matcher decodes entries through the same parser.

A value always rides behind the payload delimiter, at either scope, which is what makes it free-form: periods, interior spaces, and even further "=" characters
need no escaping. Surrounding whitespace is trimmed first, and a value persists only when content survives the trim - see [hasValueContent](#hasvaluecontent). At the
global scope an enable without content composes the bare entry, which resolution reads as "enabled, no value given". At a device or controller scope there is
no such spelling for an option storing a single value - a scoped entry carries one - so an enable without content reduces to clearing the scope: any entry
addressing it is dropped and resolution falls back to inheritance. The surviving entries are normalized on the way through, so the save the caller asked for
also modernizes anything still in the legacy form.

An option declaring [FeatureOptionEntry.multiple](#multiple) reads a SUPPLIED empty value as content-bearing rather than as nothing given: the empty selection is a
state the list can be in, told apart from the bare enable that resolves the registered default, so it composes the bare-delimiter entry at either scope. This
turns on the caller supplying the value, not on what the value says: omit `value` and a list behaves like every other option, composing the bare entry
globally and reducing to a clear at a scope.

A scoped write whose id cannot address the option is refused outright rather than composed, because the entry it would produce is one the readers would
attribute elsewhere: an id carrying a period or an equals sign has no spelling in the address grammar, and an id whose composed address is itself a catalog
option would write that option's own entry under another option's name. A global write has no id to check, and a legal scoped write is unaffected.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `args`: [`SetOptionArgs`](#setoptionargs); `catalog`: [`CatalogIndex`](#catalogindex); `configuredOptions`: readonly `string`[]; \} | - |
| `options.args` | [`SetOptionArgs`](#setoptionargs) | The mutation intent: option key, optional scope id, enabled state, optional value. See [SetOptionArgs](#setoptionargs). |
| `options.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index that defines what counts as a value-centric option (which determines whether to emit a value at all), and which settles whether a scoped target belongs to this option or to another one. |
| `options.configuredOptions` | readonly `string`[] | The current configured-options array. |

#### Returns

readonly `string`[]

The new configured-options array - a fresh allocation whenever an entry was written or removed, or the input array reference itself when a scoped
         enable that reduced to a clear found nothing to drop, mirroring [applyClearOption](#applyclearoption)'s reference-stable no-op.

#### Throws

`Error` naming the id and the option when a present id cannot address a scope of that option.

***

### buildCatalogIndex()

```ts
function buildCatalogIndex(categories, options): CatalogIndex;
```

Build the catalog-derived index from raw categories + options. The result carries the raw inputs alongside every derivation needed for O(1) catalog queries -
defaults, value-options registry, groups (both directions), renderers, the raw-entry lookup, and the longest-first cache the entry parser consumes. Throws when a
built-in formatter name on a `render` declaration does not resolve, and on any picker declaration the engine cannot honor (see [FeatureOptionEntry.choices](#choices)
and [FeatureOptionEntry.multiple](#multiple)), and when two entries expand to the same lowercased name, surfacing the misconfiguration at load time rather than
degrading a display path in silence.

The index is the catalog-side input to every other pure helper in this module. Build it once per catalog; reuse it across every configured-options mutation
because the catalog is unchanged across those mutations. Categories without an entry in the options map are skipped silently (a plugin defines a category for
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
`parseEntry`: the raw tail and an extracted value key (for value-centric Enable entries). First-write-wins on collision so the earliest entry in
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

### normalizeConfiguredOptions()

```ts
function normalizeConfiguredOptions(catalog, configuredOptions): readonly string[];
```

Rewrite every entry that decodes as a value form of a catalog option into the canonical `Enable.Option[.id]=value` shape, leaving every other entry exactly as
it was found. Pure: does not mutate the input array, and returns the input reference itself when no entry needed rewriting, so reference-equality consumers can
detect a no-op without comparing contents.

Entries pass through byte-verbatim unless the parser accounts for them completely - boolean options, options absent from the catalog, and malformed strings are
never rewritten, because a configuration file is a user's own text and we only reshape the parts whose meaning we can state exactly. Re-composing an entry that
is already canonical yields the identical string, so running this repeatedly is stable.

The legacy single-trailing-segment form (`Enable.Audio.Volume.50`) is deliberately left alone for the same reason. That segment does double duty - the lookup
index registers it as the option's global value and, through the primary key, as an enable at a scope carrying that same name - and no single canonical entry
expresses both. Rewriting it would settle, on the user's behalf, an ambiguity only the user can settle, so it stays as written. A segment the option's declared
choices settle one way or the other stays as written too, since what settles it is a catalog declaration a plugin can revise rather than the grammar itself. A
segment containing "=" is the exception: the composer cannot address a scope whose id carries the delimiter, so only the global-value reading is live there,
and the entry modernizes like any other unambiguous legacy form.

[applySetOption](#applysetoption) and [applyClearOption](#applyclearoption) run their results through this, which is the whole of the upgrade path: a stored configuration modernizes as
part of a save the user already asked for, and never merely because something read it. One consequence is worth stating plainly, since it becomes visible in the
saved file: a legacy entry whose dotted tail the engine reads as an id plus a value is rewritten to say so outright, so `Enable.Audio.Volume.St. Andrews` (read
as the id "St" carrying the value " Andrews") normalizes to `Enable.Audio.Volume.St=Andrews`, the value trimmed to the canonical domain. Resolution is unchanged
either way - the reading a user may not have intended stops being latent and becomes something they can see and correct.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `catalog` | [`CatalogIndex`](#catalogindex) | The catalog index that defines which option names are value-centric. |
| `configuredOptions` | readonly `string`[] | The configured-options array to normalize. |

#### Returns

readonly `string`[]

The normalized array, or the input array reference itself when every entry was already canonical.

***

### optionExists()

```ts
function optionExists(args): boolean;
```

Return whether an option has been explicitly configured at the given scope. Distinct from [resolveScope](#resolvescope), which walks the hierarchy; this predicate
answers only "did the user set this entry at THIS scope?" without consulting any higher or lower scopes.

It reads the configured entries alone and so is blind to [FeatureOptionEntry.scopes](#scopes-1): "is this configured" and "does this apply" are different questions,
and an entry written at a level the option does not declare is still an entry the user typed. Ask [resolveScope](#resolvescope) when the question is whether the option
takes effect.

A scoped question goes through the same arbitration every other reader and every writer consults, so an address the catalog claims for another option reads
false here: an entry at `Motion.Detect.Sensitivity` is the `Motion.Detect.Sensitivity` option's own entry, not the `Motion.Detect` option configured at a scope
named "Sensitivity".

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `catalog`: [`CatalogIndex`](#catalogindex); `configIndex`: [`ConfigIndex`](#configindex); `id?`: `string`; `option`: `string`; \} | - |
| `args.catalog` | [`CatalogIndex`](#catalogindex) | The catalog index, which settles whether a scoped address belongs to this option or to another one. |
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

The walk visits only the levels the option's catalog entry declares through [FeatureOptionEntry.scopes](#scopes-1). An option that declares nothing is valid
everywhere and walks every level; one that names its levels resolves at those and skips a configured entry sitting at any other, so an entry written where the
option was never meant to apply cannot reach the accessories it was never meant to reach.

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
