[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / homekit-name

# homekit-name

**Why this file exists.** A plugin's settings page names accessories too, and a name it lets a user save has to pass the rule HomeKit holds the plugin to, so the
page needs `sanitizeName` and `validateName` at runtime. Pulling them from `util.ts` would drag in `util.ts`'s Node-only dependency graph, which the browser cannot
resolve, so the rule lives here as the one definition the server side and the browser read. It has zero runtime imports of any kind, so it ships into
`dist/ui/` through the browser-module list and loads in any runtime that can execute ES2024+ JavaScript.

**Consumers.** `util.ts` re-exports the module's functions for the server-side surface and the package root, `service.ts` imports the sanitizer directly from
here, and a settings page imports `homebridge-plugin-utils/homekit-name.js`. Every consumer shares one implementation - the file is the join point.

## Utilities

### displayedName()

```ts
function displayedName(options): string;
```

Answer the name a settings page shows for an accessory: the custom name where one resolves and the fallback otherwise, sanitized as the runtime sanitizes it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `fallback`: `string`; `override?`: `string` \| `null`; \} | The accessory's names. |
| `options.fallback` | `string` | The name to show when the user has set no custom name HomeKit can carry, such as the name the plugin composes for the accessory. |
| `options.override?` | `string` \| `null` | Optional. The raw value of the accessory's name option, resolved through [resolveNameOverride](#resolvenameoverride). |

#### Returns

`string`

Returns the custom name where one resolves and the fallback otherwise, sanitized by HomeKit's naming rule, or as it stands when the rule leaves nothing
of it.

#### Remarks

The chosen name is sanitized as the runtime sanitizes a name before it applies one. The length HAP keeps is not applied here: the runtime cuts a name
to it where each name characteristic is written, as `setServiceName` does against that characteristic's maximum length, so a name past that length shows whole
here. A name the rule empties entirely is shown as it stands instead, because a blank row would name nothing at all. Only the fallback can be such a name, since
[resolveNameOverride](#resolvenameoverride) already refuses an override the rule empties.

#### Example

```ts
displayedName({ fallback: "Kitchen Shade", override: "Bedtime \u{1F319}" })
```

Returns: `Bedtime`, the custom name sanitized, its emoji dropped.

***

### ownedName()

```ts
function ownedName(options): string | null;
```

Answer the name a plugin owns for an accessory's service under the family naming rule, or `null` when the user owns it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `fallback`: `string`; `override?`: `string` \| `null`; `sync?`: `boolean`; \} | The accessory's names and its Sync Name setting. |
| `options.fallback` | `string` | The device's name, which owns the HomeKit name when the user set no custom name HomeKit can carry and Sync Name is on. |
| `options.override?` | `string` \| `null` | Optional. The raw value of the accessory's name option, resolved through [resolveNameOverride](#resolvenameoverride). |
| `options.sync?` | `boolean` | Optional. Whether Sync Name is on for the accessory, so the device's name owns the HomeKit name wherever no custom name does. Defaults to `false`, the side that never overrides a rename in the Home app, so a plugin that offers no Sync Name option omits it. |

#### Returns

`string` \| `null`

Returns the custom name where one resolves, the fallback where none does and Sync Name is on, and `null` otherwise.

#### Remarks

The rule reads in order of precedence. A name the user typed in the plugin's settings owns the HomeKit name, whatever Sync Name says; otherwise, with
Sync Name on, the device's name owns it; otherwise the user owns it. An answer of `null` means the user owns the name and the plugin leaves it alone, so a rename
in the Home app stands and nothing the plugin does afterward touches it. Owning a name is the user's explicit opt-in, through a custom name or Sync Name, which
is why an owned name overrides a rename in the Home app rather than yielding to it.

The rule governs a service that is already named. A new service is named through [displayedName](#displayedname) whoever owns the name, because a service HomeKit has never
seen carries no name of the user's to leave alone. The answer is the trimmed custom name or the fallback as given, never sanitized, because each setter sanitizes
the name it applies, as `setServiceName` does.

#### Example

```ts
ownedName({ fallback: "Zone 1", override: "  Patio  " })
```

Returns: `Patio`, the custom name trimmed. With no custom name the same call returns `null`, Sync Name being off and the user owning the name, and with
`sync: true` as well it returns `Zone 1`.

***

### resolveNameOverride()

```ts
function resolveNameOverride(text): string | null;
```

Resolve the raw value of a name option into the custom name HomeKit can carry for an accessory.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `text` | `string` \| `null` \| `undefined` | The raw value of the name option, as the option engine answers it. |

#### Returns

`string` \| `null`

Returns the trimmed text when HomeKit's naming rule leaves something of it, and `null` otherwise.

#### Remarks

An override counts only when trimming leaves something behind and sanitizing what remains leaves something of it. HomeKit carries no name its naming
rule empties, an emoji or punctuation alone among them: an accessory minted under one is refused, and a refresh that applies one leaves the accessory's last name
standing. Such an override therefore counts as none, and the caller's fallback applies as if the user had named nothing. The trimmed text is answered rather
than its sanitized form, because each caller sanitizes the name it settles on where it applies it, as `setServiceName` does. The parameter takes the value
[FeatureOptions.value](featureOptions.md#value) answers for the name option, its answers for no value included.

#### Example

```ts
resolveNameOverride("  Reading Nook  ")
```

Returns: `Reading Nook`, trimmed and otherwise as the user typed it. An override HomeKit's naming rule leaves nothing of, an emoji alone among them, returns `null`.

***

### sanitizeName()

```ts
function sanitizeName(name): string;
```

Sanitize an accessory name according to HomeKit naming conventions.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The name to validate. |

#### Returns

`string`

Returns the HomeKit-sanitized version of the name, replacing invalid characters with a space and squashing multiple spaces.

#### Remarks

This sanitizes names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
and HAP specification documentation:

- Starts and ends with a letter or number. Exception: may end with a period.
- May have the following special characters: -"',.#&.
- Must not include emojis.

#### Example

```ts
sanitizeName("Test|Switch")
```

Returns: `Test Switch`, replacing the pipe (an invalid character in HomeKit's naming ruleset) with a space.

***

### validateName()

```ts
function validateName(name): boolean;
```

Validate an accessory name according to HomeKit naming conventions.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The name to validate. |

#### Returns

`boolean`

Returns `true` if the name passes HomeKit's naming rules, `false` otherwise.

#### Remarks

This validates names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
and HAP specification documentation:

- Starts and ends with a letter or number. Exception: may end with a period.
- May not have multiple spaces adjacent to each other, nor begin nor end with a space.
- May have the following special characters: -"',.#&.
- Must not include emojis.

#### Example

```ts
validateName("Test|Switch")
```

Returns: `false`.
