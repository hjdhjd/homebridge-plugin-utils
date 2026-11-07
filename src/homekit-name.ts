/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homekit-name.ts: HomeKit's naming rule - the validator and the sanitizer built from one statement of it - and the custom-name rule built on the sanitizer, with the
 * family rule for who owns a name built on that, shared between the server-side `util.ts` surface and a plugin's settings page.
 */

/**
 * **Why this file exists.** A plugin's settings page names accessories too, and a name it lets a user save has to pass the rule HomeKit holds the plugin to, so the
 * page needs `sanitizeName` and `validateName` at runtime. Pulling them from `util.ts` would drag in `util.ts`'s Node-only dependency graph, which the browser cannot
 * resolve, so the rule lives here as the one definition the server side and the browser read. It has zero runtime imports of any kind, so it ships into
 * `dist/ui/` through the browser-module list and loads in any runtime that can execute ES2024+ JavaScript.
 *
 * **Consumers.** `util.ts` re-exports the module's functions for the server-side surface and the package root, `service.ts` imports the sanitizer directly from
 * here, and a settings page imports `homebridge-plugin-utils/homekit-name.js`. Every consumer shares one implementation - the file is the join point.
 *
 * @module
 */

/* HomeKit's naming rule, stated once as the character classes it is built from, so validateName() and sanitizeName() read one definition and cannot drift apart. A
 * name starts with a letter or number, ends with a letter, number, or period, and in between holds only letters, numbers, spaces, and HomeKit's permitted punctuation.
 * No character in a name may be pictographic, a letter Unicode also marks pictographic included. Each class is therefore letters and numbers with its own
 * punctuation, every pictograph subtracted from the whole class, and nameClass() composes that shape for each of them, so the validator and the sanitizer read the
 * exclusion from the same classes rather than from a check of their own. Each constant is a whole class in the v flag's set notation, which is what lets the
 * patterns below negate them. A one-character name is its own start and end, so a single letter or number is a complete name.
 *
 * The subtraction is outermost, applied once to the whole class, rather than to a letter-and-number class nested inside a union with the punctuation.
 * JavaScriptCore, Safari's engine, computes a subtracted class nested inside a union wrongly: the nested set loses every code point above U+FFFF and gains U+0000,
 * and a hyphen placed right after it is refused outright, which fails the whole module's load. With the subtraction outermost, JavaScriptCore and V8 compute the
 * same set.
 */
function nameClass(members: string): string {

  return "[[\\p{L}\\p{N}" + members + "]--\\p{Extended_Pictographic}]";
}

const NAME_START_CHARACTERS = nameClass("");
const NAME_END_CHARACTERS = nameClass("\\.");
const NAME_CHARACTERS = nameClass("\\-\"'.,#& ");

// Validates a name against HomeKit's naming conventions. Compiled once at module scope since this sits on the fast path of sanitizeName(). The end class is optional
// after the start class, which is what lets one character that may both start and end a name stand alone.
const VALID_HOMEKIT_NAME = new RegExp("^(?!.* {2})(?=^" + NAME_START_CHARACTERS + "(?:.*" + NAME_END_CHARACTERS + ")?$)" + NAME_CHARACTERS + "+$", "v");

// The sanitizer's passes, each the inverse of one part of the rule above: every character a name may not hold anywhere, the run of characters a name may not start
// with, and the run of characters a name may not end with. Stripping each whole run, rather than a single character, is what lets the result satisfy the validator.
const NAME_DISALLOWED = new RegExp("[^" + NAME_CHARACTERS + "]", "gv");
const NAME_INVALID_START = new RegExp("^[^" + NAME_START_CHARACTERS + "]+", "v");
const NAME_INVALID_END = new RegExp("[^" + NAME_END_CHARACTERS + "]+$", "v");

/**
 * Sanitize an accessory name according to HomeKit naming conventions.
 *
 * @param name - The name to validate.
 *
 * @returns Returns the HomeKit-sanitized version of the name, replacing invalid characters with a space and squashing multiple spaces.
 *
 * @remarks This sanitizes names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
 * and HAP specification documentation:
 *
 * - Starts and ends with a letter or number. Exception: may end with a period.
 * - May have the following special characters: -"',.#&.
 * - Must not include emojis.
 *
 * @example
 * ```ts
 * sanitizeName("Test|Switch")
 * ```
 *
 * Returns: `Test Switch`, replacing the pipe (an invalid character in HomeKit's naming ruleset) with a space.
 *
 * @category Utilities
 */
export function sanitizeName(name: string): string {

  // Fast path: if the name already conforms to HomeKit's naming rules, skip the replacement chain entirely.
  if(validateName(name)) {

    return name;
  }

  // Here are the steps we're taking to sanitize names for HomeKit, each derived from the naming rule the validator enforces:
  //
  //   - Replace any disallowed char (including emojis) with a space.
  //   - Collapse multiple spaces to one.
  //   - Strip the run of characters a name may not start with, leading spaces included.
  //   - Strip the run of characters a name may not end with, trailing spaces included.
  //   - Collapse two or more trailing periods into one. This follows the end strip, so a period the strip uncovers is collapsed too.
  return name.replace(NAME_DISALLOWED, " ").replace(/\s+/g, " ").replace(NAME_INVALID_START, "").replace(NAME_INVALID_END, "").replace(/\.{2,}$/, ".");
}

/**
 * Validate an accessory name according to HomeKit naming conventions.
 *
 * @param name - The name to validate.
 *
 * @returns Returns `true` if the name passes HomeKit's naming rules, `false` otherwise.
 *
 * @remarks This validates names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
 * and HAP specification documentation:
 *
 * - Starts and ends with a letter or number. Exception: may end with a period.
 * - May not have multiple spaces adjacent to each other, nor begin nor end with a space.
 * - May have the following special characters: -"',.#&.
 * - Must not include emojis.
 *
 * @example
 * ```ts
 * validateName("Test|Switch")
 * ```
 *
 * Returns: `false`.
 *
 * @category Utilities
 */
export function validateName(name: string): boolean {

  return VALID_HOMEKIT_NAME.test(name);
}

/**
 * Resolve the raw value of a name option into the custom name HomeKit can carry for an accessory.
 *
 * @param text - The raw value of the name option, as the option engine answers it.
 *
 * @returns Returns the trimmed text when HomeKit's naming rule leaves something of it, and `null` otherwise.
 *
 * @remarks An override counts only when trimming leaves something behind and sanitizing what remains leaves something of it. HomeKit carries no name its naming
 * rule empties, an emoji or punctuation alone among them: an accessory minted under one is refused, and a refresh that applies one leaves the accessory's last name
 * standing. Such an override therefore counts as none, and the caller's fallback applies as if the user had named nothing. The trimmed text is answered rather
 * than its sanitized form, because each caller sanitizes the name it settles on where it applies it, as `setServiceName` does. The parameter takes the value
 * {@link featureOptions!FeatureOptions.value | FeatureOptions.value} answers for the name option, its answers for no value included.
 *
 * @example
 * ```ts
 * resolveNameOverride("  Reading Nook  ")
 * ```
 *
 * Returns: `Reading Nook`, trimmed and otherwise as the user typed it. An override HomeKit's naming rule leaves nothing of, an emoji alone among them, returns `null`.
 *
 * @category Utilities
 */
export function resolveNameOverride(text: string | null | undefined): string | null {

  const trimmed = text?.trim();

  return (trimmed?.length && sanitizeName(trimmed).length) ? trimmed : null;
}

/**
 * Answer the name a settings page shows for an accessory: the custom name where one resolves and the fallback otherwise, sanitized as the runtime sanitizes it.
 *
 * @param options          - The accessory's names.
 * @param options.fallback - The name to show when the user has set no custom name HomeKit can carry, such as the name the plugin composes for the accessory.
 * @param options.override - Optional. The raw value of the accessory's name option, resolved through {@link resolveNameOverride}.
 *
 * @returns Returns the custom name where one resolves and the fallback otherwise, sanitized by HomeKit's naming rule, or as it stands when the rule leaves nothing
 * of it.
 *
 * @remarks A settings page's sidebar names each device by this answer, over the device's own name as the fallback and the value of its name option as the override:
 * the custom name where HomeKit can carry it and the device's own name otherwise, the same name the plugin logs under. A row never shows a rename made in the Home
 * app, which stays in HomeKit. Where a plugin gets its device list, a live console or hub or the accessory cache, stays its own, and only the naming is shared: a
 * list built from the accessory cache follows the rule through `setAccessoryName`'s `owned` option, which keeps each accessory's display name equal to this answer
 * whoever owns its HomeKit names.
 *
 * The chosen name is sanitized as the runtime sanitizes a name before it applies one. The length HAP keeps is not applied here: the runtime cuts a name to it where
 * each name characteristic is written, as `setServiceName` does against that characteristic's maximum length, so a name past that length shows whole here. A name
 * the rule empties entirely is shown as it stands instead, because a blank row would name nothing at all. Only the fallback can be such a name, since
 * {@link resolveNameOverride} already refuses an override the rule empties.
 *
 * @example
 * ```ts
 * displayedName({ fallback: "Kitchen Shade", override: "Bedtime \u{1F319}" })
 * ```
 *
 * Returns: `Bedtime`, the custom name sanitized, its emoji dropped.
 *
 * @category Utilities
 */
export function displayedName({ fallback, override }: { fallback: string; override?: string | null }): string {

  const chosen = resolveNameOverride(override) ?? fallback;
  const sanitized = sanitizeName(chosen);

  return sanitized.length ? sanitized : chosen;
}

/**
 * Answer the name a plugin owns for an accessory's service under the family naming rule, or `null` when the user owns it.
 *
 * @param options          - The accessory's names and its Sync Name setting.
 * @param options.fallback - The device's name, which owns the HomeKit name when the user set no custom name HomeKit can carry and Sync Name is on.
 * @param options.override - Optional. The raw value of the accessory's name option, resolved through {@link resolveNameOverride}.
 * @param options.sync     - Optional. Whether Sync Name is on for the accessory, so the device's name owns the HomeKit name wherever no custom name does. Defaults to
 *                           `false`, the side that never overrides a rename in the Home app, so a plugin that offers no Sync Name option omits it.
 *
 * @returns Returns the custom name where one resolves, the fallback where none does and Sync Name is on, and `null` otherwise.
 *
 * @remarks The rule reads in order of precedence. A name the user typed in the plugin's settings owns the HomeKit name, whatever Sync Name says; otherwise, with
 * Sync Name on, the device's name owns it; otherwise the user owns it. An answer of `null` means the user owns the name and the plugin leaves it alone, so a rename
 * in the Home app stands and nothing the plugin does afterward touches it. A custom name the user clears with Sync Name off is left alone the same way: it stays
 * in HomeKit as theirs, to rename in the Home app or to replace by turning Sync Name on, while the accessory's display name, the plugin's own label, follows
 * {@link displayedName} through `setAccessoryName` with `owned` false. Owning a name is the user's explicit opt-in, through a custom name or Sync Name, which is
 * why an owned name overrides a rename in the Home app rather than yielding to it.
 *
 * The rule governs a service that is already named. A new service is named through {@link displayedName} whoever owns the name, because a service HomeKit has never
 * seen carries no name of the user's to leave alone. The answer is the trimmed custom name or the fallback as given, never sanitized, because each setter sanitizes
 * the name it applies, as `setServiceName` does.
 *
 * @example
 * ```ts
 * ownedName({ fallback: "Zone 1", override: "  Patio  " })
 * ```
 *
 * Returns: `Patio`, the custom name trimmed. With no custom name the same call returns `null`, Sync Name being off and the user owning the name, and with
 * `sync: true` as well it returns `Zone 1`.
 *
 * @category Utilities
 */
export function ownedName({ fallback, override, sync = false }: { fallback: string; override?: string | null; sync?: boolean }): string | null {

  return resolveNameOverride(override) ?? (sync ? fallback : null);
}
