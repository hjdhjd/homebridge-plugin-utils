/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homekit-name.ts: HomeKit's naming rule - the validator and the sanitizer built from one statement of it - and the custom-name rule built on the sanitizer, shared
 * between the server-side `util.ts` surface and a plugin's settings page.
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
 * No character in a name may be pictographic, a letter Unicode also marks pictographic included, so the letter-and-number class subtracts every pictograph and every
 * class below is built on it: the validator and the sanitizer read the exclusion from the same classes rather than from a check of their own. Each constant is a
 * whole class in the v flag's set notation, which is what lets the patterns below nest, subtract, and negate them. A one-character name is its own start and end, so
 * a single letter or number is a complete name.
 */
const NAME_START_CHARACTERS = "[[\\p{L}\\p{N}]--\\p{Extended_Pictographic}]";
const NAME_END_CHARACTERS = "[" + NAME_START_CHARACTERS + "\\.]";
const NAME_CHARACTERS = "[" + NAME_START_CHARACTERS + "\\-\"'.,#& ]";

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
 * @remarks The chosen name is sanitized as the runtime sanitizes a name before it applies one. The length HAP keeps is not applied here: the runtime cuts a name
 * to it where each name characteristic is written, as `setServiceName` does against that characteristic's maximum length, so a name past that length shows whole
 * here. A name the rule empties entirely is shown as it stands instead, because a blank row would name nothing at all. Only the fallback can be such a name, since
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
