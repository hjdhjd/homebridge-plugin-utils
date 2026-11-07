/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions-setting.ts: The rule for reading a plugin's feature options setting, shared by the feature-options engine, the retired-option translation and plugins.
 */

/**
 * **Why this file exists.** Homebridge hands a plugin its configuration as untyped JSON, so the `options` setting reaches every reader as whatever the user's file
 * holds. `FeatureOptions`, the retired-option translation and a plugin's own code that reads the setting outside the engine, a settings page's migration or
 * first-run write among them, must all read a setting that is not a list of option strings the same way rather than throw on it, so the rule lives here once and is
 * public through the package root. It imports nothing, so the browser loads it beside the modules that use it.
 *
 * @module
 */

/**
 * Read a plugin's feature options setting as the option entries it holds. A list whose entries are all strings is answered as that same array, so a well-formed
 * setting keeps its identity and a caller can still tell a no-op by reference. A list holding anything else keeps its strings in order and drops the rest, and a
 * setting that is not a list at all - missing, a lone string, an object - holds no entries.
 *
 * @param setting - The `options` setting exactly as the configuration holds it.
 *
 * @returns The setting's option entries.
 *
 * @example
 * ```ts
 * readOptionsSetting([ "Disable.Device", 42, "Enable.Log" ])
 * ```
 *
 * Returns: `[ "Disable.Device", "Enable.Log" ]`, the strings in order with the number dropped. A setting that is not a list, `"Disable.Device"` alone among them,
 * returns `[]`.
 *
 * @category Feature Options
 */
export function readOptionsSetting(setting: unknown): string[] {

  if(!Array.isArray(setting)) {

    return [];
  }

  // A well-formed setting is by far the common case, so it costs one pass and no allocation.
  if(setting.every((entry) => typeof entry === "string")) {

    return setting;
  }

  return setting.filter((entry): entry is string => typeof entry === "string");
}
