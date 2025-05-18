[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / featureoptions

# featureoptions

A hierarchical feature option system for plugins and applications.

## Classes

### FeatureOptions

FeatureOptions provides a hierarchical feature option system for plugins and applications.

Supports global, controller, and device-level configuration, value-centric feature options, grouping, and category management.

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
   configuredOptions): FeatureOptions;
```

Create a new FeatureOptions instance.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `categories` | [`FeatureCategoryEntry`](#featurecategoryentry)[] | `undefined` | Array of feature option categories. |
| `options` | \{ [`index`: `string`]: [`FeatureOptionEntry`](#featureoptionentry)[]; \} | `undefined` | Dictionary mapping category names to arrays of feature options. |
| `configuredOptions` | `never`[] | `[]` | Optional. Array of currently configured option strings. |

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
get categories(): FeatureCategoryEntry[];
```

Return the list of available feature option categories.

###### Returns

[`FeatureCategoryEntry`](#featurecategoryentry)[]

Returns the current list of available feature option categories.

###### Set Signature

```ts
set categories(category): void;
```

Set the list of available feature option categories.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `category` | [`FeatureCategoryEntry`](#featurecategoryentry)[] | Array of available categories. |

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
| `options` | `string`[] | Array of configured feature options. |

###### Returns

`void`

##### groups

###### Get Signature

```ts
get groups(): {
[index: string]: string[];
};
```

Return the list of available feature option groups.

###### Returns

```ts
{
[index: string]: string[];
}
```

Returns the current list of available feature option groups.

##### options

###### Get Signature

```ts
get options(): {
[index: string]: FeatureOptionEntry[];
};
```

Return the list of available feature options.

###### Returns

```ts
{
[index: string]: FeatureOptionEntry[];
}
```

Returns the current list of available feature options.

###### Set Signature

```ts
set options(options): void;
```

Set the list of available feature options.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ [`index`: `string`]: [`FeatureOptionEntry`](#featureoptionentry)[]; \} | Array of available feature options. |

###### Returns

`void`

#### Methods

##### color()

```ts
color(
   option, 
   device?, 
   controller?): string;
```

Return a Bootstrap-specific color reference depending on the scope of a given feature option.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

`string`

Returns a Bootstrap color utility class associated with each scope level. `text-info` denotes an entry that's been modified at that scope level, while
`text-success` and `text-warning` denote options that were defined at higher levels in the scope hierarchy - controller and global, respectively.

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
| `category` | `string` \| [`FeatureCategoryEntry`](#featurecategoryentry) | Feature option category entry or category name string. |
| `option` | `string` \| [`FeatureOptionEntry`](#featureoptionentry) | Feature option entry of option name string. |

###### Returns

`string`

Returns a fully formed feature option in the form of `category.option`.

##### getFloat()

```ts
getFloat(
   option, 
   device?, 
controller?): Nullable<undefined | number>;
```

Parse a floating point feature option value.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

[`Nullable`](util.md#nullable)\<`undefined` \| `number`\>

Returns the value of a value-centric option as a floating point number, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.

##### getInteger()

```ts
getInteger(
   option, 
   device?, 
controller?): Nullable<undefined | number>;
```

Parse an integer feature option value.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

[`Nullable`](util.md#nullable)\<`undefined` \| `number`\>

Returns the value of a value-centric option as an integer, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.

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

Returns an object containing the location in the scope hierarchy of an `option` as well as the current value associated with the option.

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
controller?): Nullable<undefined | string>;
```

Return the value associated with a value-centric feature option, traversing the scope hierarchy.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `option` | `string` | Feature option to check. |
| `device?` | `string` | Optional device scope identifier. |
| `controller?` | `string` | Optional controller scope identifier. |

###### Returns

[`Nullable`](util.md#nullable)\<`undefined` \| `string`\>

Returns the current value associated with `option` if the feature option is enabled, `null` if disabled (or not a value-centric feature option), or
         `undefined` if it's not specified.

## Interfaces

### FeatureCategoryEntry

Entry describing a feature option category.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="description"></a> `description` | `string` | Description of the category. |
| <a id="name"></a> `name` | `string` | Name of the category. |

***

### FeatureOptionEntry

Entry describing a feature option.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="default"></a> `default` | `boolean` | Default enabled/disabled state for this feature option. |
| <a id="defaultvalue-2"></a> `defaultValue?` | `string` \| `number` | Optional. Default value for value-based feature options. |
| <a id="description-1"></a> `description` | `string` | Description of the feature option for display or documentation. |
| <a id="group"></a> `group?` | `string` | Optional. Grouping/category for the feature option. |
| <a id="name-1"></a> `name` | `string` | Name of the feature option (used in option strings). |

## Type Aliases

### OptionScope

```ts
type OptionScope = "controller" | "device" | "global" | "none";
```

Describes all possible scope hierarchy locations for a feature option.
