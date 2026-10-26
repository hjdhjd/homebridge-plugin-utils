[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / homekit-name

# homekit-name

**Why this file exists.** A plugin's settings page names accessories too, and a name it lets a user save has to pass the rule HomeKit holds the plugin to, so the
page needs `sanitizeName` and `validateName` at runtime. Pulling them from `util.ts` would drag in `util.ts`'s Node-only dependency graph, which the browser cannot
resolve, so the rule lives here as the one definition the server side and the browser read. It has zero runtime imports of any kind, so it ships into
`dist/ui/` through the browser-module list and loads in any runtime that can execute ES2024+ JavaScript.

**Consumers.** `util.ts` re-exports the validator and the sanitizer for the server-side surface and the package root, `service.ts` imports the sanitizer directly
from here, and a settings page imports `homebridge-plugin-utils/homekit-name.js`. Every consumer shares one implementation - the file is the join point.

## Utilities

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
