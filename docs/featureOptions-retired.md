[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / featureOptions-retired

# featureOptions-retired

Retired feature option families, declared as data and translated through the engine's own grammar.

A plugin whose retired grammar spelled a selection member by member - one boolean option per detection type, per button, per logging category - and whose
current grammar carries it in one value option has configurations to translate. The retired names are gone from its catalog, and several of their shapes are
worse than stale: read through the current catalog, a retired per-member entry can decompose into a value of the very option that superseded it, and a retired
master scoped to an identifier can read as that option's global value. A plugin states each family once, as a [RetiredFamily](#retiredfamily), and
[createRetiredOptions](#createretiredoptions) answers each act it needs:

  - [RetiredOptions.migrate](#migrate) - the durable rewrite a settings page commits, composed through the controller topology the page knows, so a device's
    selection is composed through its true controller and a scope the page cannot place yet waits for a pass that can.
  - [RetiredOptions.translate](#translate) - the in-memory view a plugin's Node side builds its engine on at boot, with [RetiredTranslation.selection](#selection), the
    runtime overlay that answers a family's exact historic selection for a reader holding its own device and controller.

The whole layer runs on the engine's primitives. The factory declares the retired names as an ordinary all-boolean catalog, so [buildConfigIndex](featureOptions.md#buildconfigindex) reads a
configuration exactly as production does and [resolveScope](featureOptions.md#resolvescope) answers any retired member's old effective state at any device and controller - the precedence
the engine has always owned stays owned by the engine, pointed at a catalog that describes the past. Every entry the layer writes is composed by
[composeEntry](featureOptions.md#composeentry), the one writer of the grammar, and every entry it does not account for passes through byte-verbatim, because a configuration is the user's
own text.

The module imports nothing but the feature-options core, so it is browser-safe: a settings page loads the compiled copy the build ships into `dist/ui/`, and a
plugin's Node side imports the same engine from the package root.

## Feature Options

### RetiredController

One controller and the devices beneath it, as the topology a durable rewrite composes through.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="devices"></a> `devices` | `readonly` | readonly `string`[] | The scope identifiers of the devices found on this controller. |
| <a id="id"></a> `id` | `readonly` | `string` | The controller's own scope identifier. |

***

### RetiredFamily

One retired grammar: the members a plugin's retired options spelled a selection through, and the value option that carries that selection in the current grammar.

Whether the surviving option holds one value or a list is read from its own catalog entry rather than declared here: an option declaring
[FeatureOptionEntry.multiple](featureOptions.md#multiple) composes every enabled member, and any other composes to the first enabled member in `members` order, which is how a family
whose members were ranked - stream tiers best first - keeps the rule its retired options resolved through.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="keptname"></a> `keptName?` | `readonly` | `boolean` | Optional. True when the surviving option kept the name a retired master carried, so the master's own entries spell the same as the surviving option's. Such a family speaks only where its master resolves enabled and states its selection outright there, the empty selection included; with no members it states [ALL\_CHOICES](featureOptions.md#all_choices), which is what switching the master on meant. Every option the plugin's catalog declares under the kept name is read as itself, never as the master scoped to an identifier spelling the rest. |
| <a id="members"></a> `members` | `readonly` | readonly [`RetiredMember`](#retiredmember)[] | The retired options, in the order a composition lists them. Empty for a kept-name family whose master was its whole grammar. |
| <a id="option"></a> `option` | `readonly` | `string` | The surviving option's expanded name. |
| <a id="overlayonly"></a> `overlayOnly?` | `readonly` | `boolean` | Optional. True leaves the family's retired entries in the boot view exactly as written, with the overlay alone giving them their meaning, for a family whose composition needs a domain a configuration string does not carry - a relay's outputs, say. The durable rewrite composes it like any other family. |

***

### RetiredMember

One retired option, paired with the value its family's surviving option stores for it.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="default"></a> `default` | `readonly` | `boolean` | The retired option's own catalog default, which is what its family's composition resolves against wherever a configuration says nothing. |
| <a id="option-1"></a> `option` | `readonly` | `string` | The retired option's expanded name, as the plugin's catalog once declared it. |
| <a id="value"></a> `value` | `readonly` | `string` | The value the surviving option stores when this member is selected. |

***

### RetiredMigration

What a durable rewrite answers.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="configuredoptions"></a> `configuredOptions` | `readonly` | readonly `string`[] | The configured options with every family this pass could compose exactly stated through its canonical entries in place of its retired ones, the compositions following the surviving entries in order. The input reference itself when it was a list of strings and nothing was consumed or composed. |
| <a id="remaining"></a> `remaining` | `readonly` | `boolean` | True when a family kept its retired entries because the topology this pass had could not place one of its scopes, which a caller reads as "probe wider and come back". A converged configuration answers false. |

***

### RetiredOptions

The acts one set of retired families answers, built once over a plugin's catalog by [createRetiredOptions](#createretiredoptions).

#### Methods

##### migrate()

```ts
migrate(args): RetiredMigration;
```

Rewrite a configuration's retired entries into the current grammar, permanently, as far as the supplied topology makes exact.

Each family is composed per scope it names. A scope's selection is compared against what it inherits - the global scope against the members' own defaults, a
named scope against the global composition, through its controller when the topology places it - and only a scope with something of its own to say is
written. Retirement is per family: one the topology cannot place keeps its entries exactly as written while its neighbors migrate.

`controllers` means one thing omitted and another supplied. Omitted, the plugin is flat: there is no controller above a device, so every
family composes through its scope and the global level, which is exact. Supplied, even as an empty list, the plugin has a hierarchy the list describes, and a
family naming a scope the list cannot place keeps its entries whole and sets `remaining` - unless the user's own entry already supersedes it, in which case its
retired entries simply leave. A controller answers for itself and a device for the controller it was found on, matched without regard to case.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `configuredOptions`: readonly `string`[]; `controllers?`: readonly [`RetiredController`](#retiredcontroller)[]; \} | - |
| `args.configuredOptions` | readonly `string`[] | The configured feature options to rewrite. |
| `args.controllers?` | readonly [`RetiredController`](#retiredcontroller)[] | Optional. The controllers that answered this pass, each with the devices beneath it. Omit it for a plugin with no controller level; supply it, empty included, for one whose devices sit beneath controllers. |

###### Returns

[`RetiredMigration`](#retiredmigration)

The rewritten options and whether any family still waits for a wider topology.

##### translate()

```ts
translate(configuredOptions): RetiredTranslation;
```

Read a configuration written in any era of the plugin's grammar and answer what the engine should be built on, with the overlay for whatever a composition
without topology can only approximate.

Every family composes without topology, a scope through itself and the global level, and the family joins the overlay so a reader holding its own device and
controller gets the exact historic answer. A family declaring `overlayOnly` is left as written and answered by the overlay alone.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `configuredOptions` | readonly `string`[] | The configured feature options, exactly as they appear in the configuration. |

###### Returns

[`RetiredTranslation`](#retiredtranslation)

The boot view, the overlay, and the entries the translation acted on.

***

### RetiredSelectionArgs

Arguments for [RetiredTranslation.selection](#selection): the reader's own position in the hierarchy, the option it reads, and the domain it reads against.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="controller"></a> `controller?` | `string` | Optional. The reader's controller scope identifier. |
| <a id="device"></a> `device?` | `string` | Optional. The reader's device scope identifier. |
| <a id="domain"></a> `domain` | readonly `string`[] | The values the option offers in this context, which the answer is expressed in. |
| <a id="option-2"></a> `option` | `string` | The surviving option being read, matched without regard to casing. |

***

### RetiredTranslation

The boot view of a configuration: the entries the engine is built on, the overlay a family still needs, and the entries the translation acted on.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="configuredoptions-1"></a> `configuredOptions` | `readonly` | readonly `string`[] | The configured options with every retired shape the engine would misread composed into the current grammar, surviving entries in order and the compositions after them. The input reference itself when it was a list of strings and nothing was consumed or composed. |
| <a id="translated"></a> `translated` | `readonly` | readonly `string`[] | The retired entries the translation consumed, superseded or left in place for the overlay, verbatim, for a plugin's startup narration. Empty when the configuration is already canonical. |

#### Methods

##### selection()

```ts
selection(args): readonly string[] | undefined;
```

Resolve a family's selection the way its retired options resolved it, for a reader that knows its own device and controller - or answer undefined when no
family still needs the overlay for this option, and the reader reads the engine as it always does.

The boot view composes each scope without topology, because a configuration string cannot say which identifiers name controllers. The reader supplies the real
device and controller here, so the engine's own walk over the retired catalog answers exactly what the retired reads answered. An option whose family is
converged, superseded by the user's own entry, or never configured answers undefined after one map lookup, which is what keeps the read free once a
configuration has converged.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | [`RetiredSelectionArgs`](#retiredselectionargs) | The reader's position, the option, and the domain. See [RetiredSelectionArgs](#retiredselectionargs). |

###### Returns

readonly `string`[] \| `undefined`

The selected values in the domain's own spelling and order, or undefined when the overlay has nothing to say about this option.

***

### createRetiredOptions()

```ts
function createRetiredOptions(args): RetiredOptions;
```

Build the translation of a plugin's retired feature option families over its catalog.

The factory reads the catalog once: it builds the served catalog's index, the retired catalog the families describe, and the configured-options index of an
empty configuration that a family's untouched defaults resolve through. Each act then runs one survey of the configuration it is handed. An entry the retired
catalog reads as a family's member, or as a kept-name master, belongs to that family; a family speaks at every scope a member entry names, and at a scope a
bare scoped enable of its master names. A master at the global scope spells the same thing in the retired grammar and the current one, so it stands as written
unless a member entry brings the global scope in.

The user's own entry for a family's surviving option outranks the family. For a kept-name family that is a value behind the payload delimiter at any scope,
since a bare master spells the same in the retired grammar and the current one; for any other family it is any entry for the option at any scope, bare or
valued, since the option did not exist in the retired grammar. A superseded family's retired entries leave, nothing is composed for it, and the overlay answers
nothing for it.

Families walk in the order they are declared and a family's scopes in the order they first appear, each identifier once whatever its casing and in the spelling
it first appeared in. Surviving entries stay byte-verbatim and in order, and the composed entries follow them. Each act answers the input array itself when it
consumed and composed nothing, so a caller tells a no-op by reference. A plugin's configuration arrives untyped, so each act first reads a setting that is not a
list of strings for the strings it holds, as `FeatureOptions` does: a list keeps them and drops anything else, and any other value holds no entries. Such a
setting is never answered by reference, so a caller writing the answer back writes the strings alone.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `args` | \{ `categories`: readonly [`FeatureCategoryEntry`](featureOptions.md#featurecategoryentry)\<`unknown`\>[]; `families`: readonly [`RetiredFamily`](#retiredfamily)[]; `options`: `Readonly`\<`Record`\<`string`, readonly [`FeatureOptionEntry`](featureOptions.md#featureoptionentry)[]\>\>; \} | - |
| `args.categories` | readonly [`FeatureCategoryEntry`](featureOptions.md#featurecategoryentry)\<`unknown`\>[] | The plugin's feature option categories, exactly as its catalog declares them. |
| `args.families` | readonly [`RetiredFamily`](#retiredfamily)[] | The retired families, in the order their compositions are emitted. |
| `args.options` | `Readonly`\<`Record`\<`string`, readonly [`FeatureOptionEntry`](featureOptions.md#featureoptionentry)[]\>\> | The plugin's feature options, exactly as its catalog declares them. |

#### Returns

[`RetiredOptions`](#retiredoptions)

The durable rewrite and the boot translation over those families.

#### Throws

`Error` naming the option when a family's surviving option is one the catalog does not declare, or a member's retired option is one it still declares.

#### Example

```ts
// A logging list whose retired grammar was one switch per category, each of which defaulted on.
const retired = createRetiredOptions({ categories: featureOptionCategories, families: [{ members: [

  { default: true, option: "Log.Doorbell", value: "Doorbell" },
  { default: true, option: "Log.Lock", value: "Lock" }
], option: "Log.Events" }], options: featureOptions });

// At boot, the engine is built on the boot view and a list read consults the overlay first.
const translation = retired.translate(config.options);
const engine = new FeatureOptions(featureOptionCategories, featureOptions, [...translation.configuredOptions]);
const events = translation.selection({ device: hub.mac, domain, option: "Log.Events" }) ??
  engine.valueList({ defaultWhenUnset: true, device: hub.mac, domain, option: "Log.Events" });
```
