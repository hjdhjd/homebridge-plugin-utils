[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / featureOptions-docs

# featureOptions-docs

A shared documentation renderer for the [FeatureOptions](featureOptions.md#featureoptions) catalog.

Every plugin in the family used to ship a near-duplicate `*-gendocs.ts` script that walked its feature-options catalog and printed a markdown category index plus
per-category option tables, then pasted the result into its `docs/FeatureOptions.md` by hand. ~95% of each script was identical, and each hand-rolled the dotted-key
construction and the value-vs-toggle distinction that this library already owns as single-source-of-truth helpers. This module collapses all of that into one
elegant renderer so the documentation becomes a pure projection of the live catalog.

The module exports one pure string function:

  - [renderFeatureOptionsReference](#renderfeatureoptionsreference) - the projection itself. It derives every key via [expandOption](featureOptions.md#expandoption-1), decides value-ness via [isValueOption](featureOptions.md#isvalueoption), and
    builds the catalog index once via [buildCatalogIndex](featureOptions.md#buildcatalogindex); it never re-derives any of those. Plugin-private scope prose is supplied through two optional render
    hooks that mirror the webUI's field-blind `validOption` / `validOptionCategory` predicate boundary, lifted from *filter* (boolean) to *describe* (string). No
    plugin-specific field name appears anywhere in this file.

Putting the rendered fragment into a plugin's doc is [doc-markdown!spliceMarkedRegion](doc-markdown.md#splicemarkedregion), the in-place splice every generator's CLI verb uses, and the table
layout the projection prints its option rows through is [doc-markdown!renderMarkdownTable](doc-markdown.md#rendermarkdowntable).

It also ships two builders for those scope hooks, because writing them by hand is what every plugin was doing and the results converged on two shapes. Neither builder
is required - a plugin with prose of its own still writes the hooks directly - but between them they cover what the family actually says.
[buildFixedScopeDescribers](#buildfixedscopedescribers) produces the fixed pair of sentences a plugin with a flat global-or-per-device hierarchy wants;
[buildComposedScopeDescribers](#buildcomposedscopedescribers) composes a sentence from a plugin's own vocabulary for the levels it names, for a hierarchy the fixed sentences cannot describe.

The renderer is pure and isomorphic: no `node:` imports, no `fs`, no `process`. The only I/O - reading the doc and writing it back - is two lines of
`node:fs/promises` in each plugin's build-script shim, which is inherently a tooling concern. This module is therefore browser-safe and trivially testable, but it
is a tooling concern and is deliberately NOT mirrored into `dist/ui/` by the build pipeline.

## Feature Options

### ComposedScopeOptions

What [buildComposedScopeDescribers](#buildcomposedscopedescribers) composes a sentence from.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="leadingword"></a> `leadingWord?` | `readonly` | `string` | The word the sentence opens with, placed verbatim ahead of the list. Defaults to `"Configurable"`. Supply the capitalization you want: the frame positions this word but does not transform it, so an override reading `"Set"` renders as `"Set"`. |
| <a id="listtype"></a> `listType?` | `readonly` | `"conjunction"` \| `"disjunction"` | How the levels are joined when an option names more than one. `"disjunction"` renders "or" and is the default, matching what the fixed sentence's own "globally or on individual devices" says: the levels an option MAY be configured at are alternatives, not a set that must all be used. `"conjunction"` renders "and" for a hierarchy where naming them together reads better. |
| <a id="vocabulary"></a> `vocabulary` | `readonly` | `Readonly`\<`Record`\<[`FeatureOptionScope`](featureOptions.md#featureoptionscope), `string`\>\> | The plugin's own name for each scope level, as a COMPLETE phrase carrying its own preposition - `"on each zone"`, `"at the controller level"`, `"globally"`. The frame contributes the sentence mechanics around the list and nothing inside it, so a phrase reads correctly in any list position rather than only after whatever preposition a shared frame happened to pick. Every level needs an entry: the record is total over [FeatureOptionScope](featureOptions.md#featureoptionscope), so adding a level to the vocabulary is a compiler error until every plugin names it. |

***

### ScopeDescribers

The pair of scope hooks [renderFeatureOptionsReference](#renderfeatureoptionsreference) accepts, as one value. A builder returns both together so a plugin's catalog module can destructure
them into the two exports it publishes, rather than assembling the pair itself.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TOptionMeta` | `unknown` | The concrete type of an option entry's opaque `meta` annotation. |
| `TCategoryMeta` | `unknown` | The concrete type of a category entry's opaque `meta` annotation. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="describecategoryscope"></a> `describeCategoryScope` | `readonly` | (`category`) => `string` \| `undefined` | The category-scope hook. Both builders return the honest no-op here: [FeatureCategoryEntry](featureOptions.md#featurecategoryentry) declares no scopes at all, so there is nothing at the category level to describe, and inventing an aggregation over a category's options would either restate the per-option suffixes or contradict a category whose options sit at differing levels. |
| <a id="describeoptionscope"></a> `describeOptionScope` | `readonly` | (`option`, `category`) => `string` \| `undefined` | The option-scope hook: the suffix appended to an option's description cell, or `undefined` to append nothing. |

***

### FEATURE\_OPTIONS\_DOC\_BEGIN

```ts
const FEATURE_OPTIONS_DOC_BEGIN: "<!-- FEATURE OPTIONS:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->" = "<!-- FEATURE OPTIONS:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";
```

The opening marker of the auto-generated region in a plugin's `docs/FeatureOptions.md`. The documentation module's [doc-markdown!spliceMarkedRegion](doc-markdown.md#splicemarkedregion) replaces
everything strictly between this marker and [FEATURE\_OPTIONS\_DOC\_END](#feature_options_doc_end), preserving both markers and the hand-written prose around them. The text doubles as an
in-document warning to maintainers not to edit the region by hand.

***

### FEATURE\_OPTIONS\_DOC\_END

```ts
const FEATURE_OPTIONS_DOC_END: "<!-- FEATURE OPTIONS:END -->" = "<!-- FEATURE OPTIONS:END -->";
```

The closing marker of the auto-generated region. See [FEATURE\_OPTIONS\_DOC\_BEGIN](#feature_options_doc_begin).

***

### buildComposedScopeDescribers()

```ts
function buildComposedScopeDescribers<TOptionMeta, TCategoryMeta>(options): ScopeDescribers<TOptionMeta, TCategoryMeta>;
```

Build the scope hooks for a catalog whose hierarchy has more to say than "globally, or per device" - a controller tier, a domain name for the device tier, anything
the two fixed sentences cannot describe.

The division of labor is what makes this shareable. The plugin owns the vocabulary: what each level is CALLED in the hierarchy its users see, as a self-contained
phrase. This owns the sentence around it: the opening word, the list grammar, the closing period, and the italic markup the family renders scope prose in. A plugin
therefore supplies the part only it can know and inherits the part that is the same everywhere.

The list is rendered by `Intl.ListFormat` rather than by hand-joining, so two levels read "a or b" and three read "a, b, or c" without the caller owning that
grammar. The formatter is built once per builder call and reused across every option the render pass describes.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TOptionMeta` | `unknown` | The concrete type of an option entry's opaque `meta` annotation. |
| `TCategoryMeta` | `unknown` | The concrete type of a category entry's opaque `meta` annotation. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`ComposedScopeOptions`](#composedscopeoptions) | See [ComposedScopeOptions](#composedscopeoptions). |

#### Returns

[`ScopeDescribers`](#scopedescribers)\<`TOptionMeta`, `TCategoryMeta`\>

The hook pair, ready to hand to [renderFeatureOptionsReference](#renderfeatureoptionsreference) or to re-export from a catalog module.

#### Example

```ts
export const { describeCategoryScope, describeOptionScope } = buildComposedScopeDescribers<MyOptionMeta>({

  vocabulary: { controller: "at the controller level", device: "on each zone", global: "globally" }
});

// An option declaring [ "device", "global" ] renders: " <BR>*Configurable on each zone or globally.*"
```

***

### buildFixedScopeDescribers()

```ts
function buildFixedScopeDescribers<TOptionMeta, TCategoryMeta>(): ScopeDescribers<TOptionMeta, TCategoryMeta>;
```

Build the scope hooks for a catalog whose options are configurable globally, or globally and per-device.

These are the exact two sentences the family's flat-hierarchy plugins hand-wrote, and they are all this builder will say. An option declaring any other combination
of levels gets `undefined` rather than invented prose, because a sentence this builder does not have grounded copy for would be a sentence nobody wrote. A catalog
that lands there wants [buildComposedScopeDescribers](#buildcomposedscopedescribers) instead.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TOptionMeta` | `unknown` | The concrete type of an option entry's opaque `meta` annotation. |
| `TCategoryMeta` | `unknown` | The concrete type of a category entry's opaque `meta` annotation. |

#### Returns

[`ScopeDescribers`](#scopedescribers)\<`TOptionMeta`, `TCategoryMeta`\>

The hook pair, ready to hand to [renderFeatureOptionsReference](#renderfeatureoptionsreference) or to re-export from a catalog module.

#### Example

```ts
export const { describeCategoryScope, describeOptionScope } = buildFixedScopeDescribers<MyOptionMeta>();
```

## Other

### renderFeatureOptionsReference()

```ts
function renderFeatureOptionsReference<TOptionMeta, TCategoryMeta>(input): string;
```

Render a feature-options catalog into the markdown reference fragment a plugin embeds in its `docs/FeatureOptions.md`. The output is a category index (one bullet per
category, deep-linking to its detail section), an optional one-line legend explaining the `=<value>` notation, and then one detail section per category, each carrying
an optional device-scope line and a flat table of option rows. The legend is emitted only when the catalog has at least one value option, since a toggle-only catalog
never renders the `=<value>` placeholder the legend describes.

The renderer owns all base-shaped scaffolding - the index, headings, per-row deep-link anchors, the key cell with its value/toggle placeholder, the default cell, the
description cell, and the column math - purely from the base [FeatureOptionEntry](featureOptions.md#featureoptionentry) / [FeatureCategoryEntry](featureOptions.md#featurecategoryentry) fields. The two optional hooks own *only* the
plugin-private scope prose: `describeCategoryScope` contributes the device-scope sentence under a category heading, and `describeOptionScope` contributes a suffix
appended to an option's description cell. A hook returning `undefined` omits its contribution cleanly - never an "undefined" literal, never a stray blank line.

The catalog index is built once via [buildCatalogIndex](featureOptions.md#buildcatalogindex); value-ness is decided via [isValueOption](featureOptions.md#isvalueoption); the canonical dotted key is derived via
[expandOption](featureOptions.md#expandoption-1). None of those is re-derived here - the renderer is a projection of the same single source of truth the rest of the module owns.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TOptionMeta` | `unknown` | The concrete type of an option entry's opaque `meta` annotation, reconstituted at this boundary so `describeOptionScope` sees it typed. |
| `TCategoryMeta` | `unknown` | The concrete type of a category entry's opaque `meta` annotation, reconstituted so `describeCategoryScope` sees it typed. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `input` | \{ `categories`: readonly [`FeatureCategoryEntry`](featureOptions.md#featurecategoryentry)\<`TCategoryMeta`\>[]; `describeCategoryScope?`: (`category`) => `string` \| `undefined`; `describeOptionScope?`: (`option`, `category`) => `string` \| `undefined`; `options`: `Readonly`\<`Record`\<`string`, readonly [`FeatureOptionEntry`](featureOptions.md#featureoptionentry)\<`TOptionMeta`\>[]\>\>; \} | - |
| `input.categories` | readonly [`FeatureCategoryEntry`](featureOptions.md#featurecategoryentry)\<`TCategoryMeta`\>[] | The catalog's category list, in the order the index and detail sections should follow. |
| `input.describeCategoryScope?` | (`category`) => `string` \| `undefined` | Optional. Returns the device-scope sentence emitted under a category's heading, or `undefined` to omit it. The hook owns the full sentence including any leading or trailing text. |
| `input.describeOptionScope?` | (`option`, `category`) => `string` \| `undefined` | Optional. Returns a suffix appended to an option's description cell, or `undefined` to omit it. The hook owns its full text including any leading separator. |
| `input.options` | `Readonly`\<`Record`\<`string`, readonly [`FeatureOptionEntry`](featureOptions.md#featureoptionentry)\<`TOptionMeta`\>[]\>\> | The catalog's options map keyed by category name. |

#### Returns

`string`

The rendered markdown fragment.
