/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homekit-name.ts: HomeKit's naming rule - the validator and the sanitizer built from one statement of it - shared between the server-side `util.ts` surface and
 * a plugin's settings page.
 */

/**
 * **Why this file exists.** A plugin's settings page names accessories too, and a name it lets a user save has to pass the rule HomeKit holds the plugin to, so the
 * page needs `sanitizeName` and `validateName` at runtime. Pulling them from `util.ts` would drag in `util.ts`'s Node-only dependency graph, which the browser cannot
 * resolve, so the rule lives here as the one definition the server side and the browser read. It has zero runtime imports of any kind, so it ships into
 * `dist/ui/` through the browser-module list and loads in any runtime that can execute ES2024+ JavaScript.
 *
 * **Consumers.** `util.ts` re-exports the validator and the sanitizer for the server-side surface and the package root, `service.ts` imports the sanitizer directly
 * from here, and a settings page imports `homebridge-plugin-utils/homekit-name.js`. Every consumer shares one implementation - the file is the join point.
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
