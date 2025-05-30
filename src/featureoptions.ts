/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureoptions.ts: Hierarchical feature option capabilities for use in plugins and applications.
 */

/**
 * A hierarchical feature option system for plugins and applications.
 *
 * @module
 */
import type { Nullable } from "./util.js";

/**
 * Entry describing a feature option.
 *
 * @property default         - Default enabled/disabled state for this feature option.
 * @property defaultValue    - Optional. Default value for value-based feature options.
 * @property description     - Description of the feature option for display or documentation.
 * @property group           - Optional. Grouping/category for the feature option.
 * @property name            - Name of the feature option (used in option strings).
 */
export interface FeatureOptionEntry {

  default: boolean,                // Default feature option state.
  defaultValue?: number | string,  // Default value for value-based feature options.
  description: string,             // Description of the feature option.
  group?: string,                  // Feature option grouping for related options.
  name: string                     // Name of the feature option.
}

/**
 * Entry describing a feature option category.
 *
 * @property description     - Description of the category.
 * @property name            - Name of the category.
 */
export interface FeatureCategoryEntry {

  description: string,
  name: string
}

/**
 * Describes all possible scope hierarchy locations for a feature option.
 */
export type OptionScope =  "controller" | "device" | "global" | "none";

/**
 * JSON definition describing a configured feature option and its current value and scope.
 *
 * @property scope           - The scope in which the option is configured.
 * @property value           - The value associated with the option at this scope.
 */
interface OptionInfoEntry {

  scope: OptionScope,
  value: boolean
}

/**
 * FeatureOptions provides a hierarchical feature option system for plugins and applications.
 *
 * Supports global, controller, and device-level configuration, value-centric feature options, grouping, and category management.
 *
 * @example
 *
 * ```ts
 * // Define categories and options.
 * const categories = [
 *
 *   { name: "motion", description: "Motion Options" },
 *   { name: "audio", description: "Audio Options" }
 * ];
 *
 * const options = {
 *
 *   motion: [
 *     { name: "detect", default: true, description: "Enable motion detection." }
 *   ],
 *
 *   audio: [
 *     { name: "volume", default: false, defaultValue: 50, description: "Audio volume." }
 *   ]
 * };
 *
 * // Instantiate FeatureOptions.
 * const featureOpts = new FeatureOptions(categories, options, ["Enable.motion.detect"]);
 *
 * // Check if a feature is enabled.
 * const motionEnabled = featureOpts.test("motion.detect");
 *
 * // Get a value-centric feature option.
 * const volume = featureOpts.value("audio.volume");
 * ```
 *
 * @see FeatureOptionEntry
 * @see FeatureCategoryEntry
 * @see OptionScope
 */
export class FeatureOptions {

  /**
   * Default return value for unknown options (defaults to false).
   */
  public defaultReturnValue: boolean;

  private _categories: FeatureCategoryEntry[];
  private _configuredOptions: string[];
  private _groups: { [index: string]: string[] };
  private _options: { [index: string]: FeatureOptionEntry[] };
  private defaults: { [index: string]: boolean };
  private valueOptions: { [index: string]: number | string | undefined };

  /**
   * Create a new FeatureOptions instance.
   *
   * @param categories        - Array of feature option categories.
   * @param options           - Dictionary mapping category names to arrays of feature options.
   * @param configuredOptions - Optional. Array of currently configured option strings.
   *
   * @example
   *
   * ```ts
   * const featureOpts = new FeatureOptions(categories, options, ["Enable.motion.detect"]);
   * ```
   */
  constructor(categories: FeatureCategoryEntry[], options: { [index: string]: FeatureOptionEntry[] }, configuredOptions = []) {

    // Initialize our defaults.
    this._categories = [];
    this._configuredOptions = [];
    this._groups = {};
    this._options = {};
    this.defaultReturnValue = false;
    this.defaults = {};
    this.valueOptions = {};

    this.categories = categories ?? [];
    this.configuredOptions = configuredOptions;
    this.options = options ?? {};
  }

  /**
   * Return a Bootstrap-specific color reference depending on the scope of a given feature option.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns a Bootstrap color utility class associated with each scope level. `text-info` denotes an entry that's been modified at that scope level, while
   * `text-success` and `text-warning` denote options that were defined at higher levels in the scope hierarchy - controller and global, respectively.
   */
  public color(option: string, device?: string, controller?: string): string {

    switch(this.scope(option, device, controller)) {

      case "device":

        return "text-info";

      case "controller":

        return "text-success";

      case "global":

        return device ? "text-warning" : "text-info";

      default:

        return "";
    }
  }

  /**
   * Return the default value for an option.
   *
   * @param option        - Feature option to check.
   *
   * @returns Returns true or false, depending on the option default.
   */
  public defaultValue(option: string): boolean {

    // If it's unknown to us, return the default return value.
    return this.defaults[option.toLowerCase()] ?? this.defaultReturnValue;
  }

  /**
   * Return whether the option explicitly exists in the list of configured options.
   *
   * @param option        - Feature option to check.
   * @param id            - Optional device or controller scope identifier to check.
   *
   * @returns Returns true if the option has been explicitly configured, false otherwise.
   */
  public exists(option: string, id?: string): boolean {

    const regex = this.isValue(option) ? this.valueRegex(option, id) : this.optionRegex(option, id);

    return this.configuredOptions.some(x => regex.test(x));
  }

  /**
   * Return a fully formed feature option string.
   *
   * @param category      - Feature option category entry or category name string.
   * @param option        - Feature option entry of option name string.
   *
   * @returns Returns a fully formed feature option in the form of `category.option`.
   */
  public expandOption(category: FeatureCategoryEntry | string, option: FeatureOptionEntry | string): string {

    const categoryName = (typeof category === "string") ? category : category.name;
    const optionName = (typeof option === "string") ? option : option.name;

    if(!categoryName || !categoryName.length) {

      return "";
    }

    return (!optionName || !optionName.length) ? categoryName : categoryName + "." + optionName;
  }

  /**
   * Parse a floating point feature option value.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the value of a value-centric option as a floating point number, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.
   */
  public getFloat(option: string, device?: string, controller?: string): Nullable<number | undefined> {

    // Parse the number and return the value.
    return this.parseOptionNumeric(this.value(option, device, controller), parseFloat);
  }

  /**
   * Parse an integer feature option value.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the value of a value-centric option as an integer, `undefined` if it doesn't exist or couldn't be parsed, and `null` if disabled.
   */
  public getInteger(option: string, device?: string, controller?: string): Nullable<number | undefined> {

    // Parse the number and return the value.
    return this.parseOptionNumeric(this.value(option, device, controller), parseInt);
  }

  /**
   * Return whether an option has been set in either the device or controller scope context.
   *
   * @param option        - Feature option to check.
   *
   * @returns Returns true if the option is set at the device or controller level and false otherwise.
   */
  public isScopeDevice(option: string, device: string): boolean {

    const value = this.exists(option, device);

    // Return the value if it's set, or the default value for this option.
    return (value !== undefined) ? value : this.defaultValue(option);
  }

  /**
   * Return whether an option has been set in the global scope context.
   *
   * @param option        - Feature option to check.
   *
   * @returns Returns true if the option is set globally and false otherwise.
   */
  public isScopeGlobal(option: string): boolean {

    const value = this.exists(option);

    // Return the value if it's set, or the default value for this option.
    return (value !== undefined) ? value : this.defaultValue(option);
  }

  /**
   * Return whether an option is value-centric or not.
   *
   * @param option        - Feature option entry or string to check.
   *
   * @returns Returns true if it is a value-centric option and false otherwise.
   */
  public isValue(option: string): boolean {

    if(!option) {

      return false;
    }

    return option.toLowerCase() in this.valueOptions;
  }

  /**
   * Return the scope hierarchy location of an option.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns an object containing the location in the scope hierarchy of an `option` as well as the current value associated with the option.
   */
  public scope(option: string, device?: string, controller?: string): OptionScope {

    return this.optionInfo(option, device, controller).scope;
  }

  /**
   * Return the current state of a feature option, traversing the scope hierarchy.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns true if the option is enabled, and false otherwise.
   */
  public test(option: string, device?: string, controller?: string): boolean {

    return this.optionInfo(option, device, controller).value;
  }

  /**
   * Return the value associated with a value-centric feature option, traversing the scope hierarchy.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the current value associated with `option` if the feature option is enabled, `null` if disabled (or not a value-centric feature option), or
   *          `undefined` if it's not specified.
   */
  public value(option: string, device?: string, controller?: string): Nullable<string | undefined> {

    // If this isn't a value-centric feature option, we're done.
    if(!this.isValue(option)) {

      return null;
    }

    // Normalize the option.
    option = option.toLowerCase();

    const getValue = (checkOption: string, checkId?: string): Nullable<string | undefined> => {

      const regex = this.valueRegex(checkOption, checkId);

      // Get the option value, if we have one.
      for(const entry of this.configuredOptions) {

        const regexMatch = regex.exec(entry);

        if(regexMatch) {

          // If the option is enabled, return the value. Otherwise, we have nothing.
          return (regexMatch[1].toLowerCase() === "enable") ? regexMatch[2] : null;
        }
      }

      return undefined;
    };

    // Check to see if we have a device-level value first.
    if(device) {

      const value = getValue(option, device);

      // The option's been explicitly disabled.
      if(value === null) {

        return null;
      }

      if(value) {

        return value;
      }
    }

    // Now check to see if we have an controller-level value.
    if(controller) {

      const value = getValue(option, controller);

      // The option's been explicitly disabled.
      if(value === null) {

        return null;
      }

      if(value) {

        return value;
      }
    }

    // Finally, we check for a global-level value.
    const value = getValue(option);

    if(value) {

      return value;
    }

    // The option's been explicitly disabled or is disabled by default.
    if((value === null) || !this.defaultValue(option)) {

      return null;
    }

    // Return the enabled value, or the default value if we've got nothing explicitly configured.
    return value ?? ((this.valueOptions[option] === undefined) ? undefined : this.valueOptions[option]?.toString());
  }

  /**
   * Return the list of available feature option categories.
   *
   * @returns Returns the current list of available feature option categories.
   */
  public get categories(): FeatureCategoryEntry[] {

    return this._categories;
  }

  /**
   * Set the list of available feature option categories.
   *
   * @param category      - Array of available categories.
   */
  public set categories(category: FeatureCategoryEntry[]) {

    this._categories = category;
  }

  /**
   * Return the list of currently configured feature options.
   *
   * @returns Returns the currently configured list of feature options.
   */
  public get configuredOptions(): string[] {

    return this._configuredOptions;
  }

  /**
   * Set the list of currently configured feature options.
   *
   * @param options       - Array of configured feature options.
   */
  public set configuredOptions(options: string[]) {

    this._configuredOptions = options ?? [];
  }

  /**
   * Return the list of available feature option groups.
   *
   * @returns Returns the current list of available feature option groups.
   */
  public get groups(): { [index: string]: string[] } {

    return this._groups;
  }

  /**
   * Return the list of available feature options.
   *
   * @returns Returns the current list of available feature options.
   */
  public get options(): { [index: string]: FeatureOptionEntry[] } {

    return this._options;
  }

  /**
   * Set the list of available feature options.
   *
   * @param options       - Array of available feature options.
   */
  public set options(options: { [index: string]: FeatureOptionEntry[] }) {

    this._options = options ?? {};

    // Regenerate our defaults.
    this.generateDefaults();
  }

  // Build our list of default values for our feature options.
  private generateDefaults(): void {

    this.defaults = {};
    this._groups = {};
    this.valueOptions = {};

    for(const category of this.categories) {

      // If the category doesn't exist, let's skip it.
      if(!this.options[category.name]) {

        continue;
      }

      // Now enumerate all the feature options for a given device and add then to the full list.
      for(const option of this.options[category.name]) {

        // Expand the entry.
        const entry = this.expandOption(category, option);

        // Index the default value.
        this.defaults[entry.toLowerCase()] = option.default;

        // Track value-centric options.
        if("defaultValue" in option) {

          this.valueOptions[entry.toLowerCase()] = option.defaultValue;
        }

        // Cross reference the feature option group it belongs to, if any.
        if(option.group !== undefined) {

          const expandedGroup = category.name + (option.group.length ? ("." + option.group) : "");

          // Initialize the group entry if needed and add the entry.
          (this._groups[expandedGroup] ??= []).push(entry);
        }
      }
    }
  }

  // Utility function to return the setting of a particular option and it's position in the scoping hierarchy.
  private optionInfo(option: string, device?: string, controller?: string): OptionInfoEntry {

    // There are a couple of ways to enable and disable options. The rules of the road are:
    //
    // 1. Explicitly disabling, or enabling an option on the controller propogates to all the devices that are managed by that controller. Why might you want to do this?
    //    Because...
    //
    // 2. Explicitly disabling, or enabling an option on a device always override the above. This means that it's possible to disable an option for a controller, and all
    //    the devices that are managed by it, and then override that behavior on a single device that it's managing.

    // Check to see if we have a device-level option first.
    if(device && this.exists(option, device)) {

      const value = this.isOptionEnabled(option, device);

      if(value !== undefined) {

        return { scope: "device", value: value };
      }
    }

    // Now check to see if we have an controller-level option.
    if(controller && this.exists(option, controller)) {

      const value = this.isOptionEnabled(option, controller);

      if(value !== undefined) {

        return { scope: "controller", value: value };
      }
    }

    // Finally, we check for a global-level value.
    if(this.exists(option)) {

      const value = this.isOptionEnabled(option);

      if(value !== undefined) {

        return { scope: "global", value: value };
      }
    }

    // The option hasn't been set at any scope, return our default value.
    return { scope: "none", value: this.defaultValue(option) };
  }

  // Utility to test whether an option is set in a given scope.
  // We return true if an option is enabled, false for disabled, undefined otherwise. For value-centric options, we return true if a value exists.
  private isOptionEnabled(option: string, id?: string): boolean | undefined {

    const regex = this.isValue(option) ? this.valueRegex(option, id) : this.optionRegex(option, id);

    // Get the option value, if we have one.
    for(const entry of this.configuredOptions) {

      const regexMatch = regex.exec(entry);

      if(regexMatch) {

        return regexMatch[1].toLowerCase() === "enable";
      }
    }

    return undefined;
  }

  // Regular expression test for feature options.
  private optionRegex(option: string, id?: string): RegExp {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option. We
    // also need to escape out our option to ensure we have no inadvertent issues in matching the regular expression.
    return new RegExp("^(Enable|Disable)\\." + option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (!id ? "" : "\\." + id) + "$", "gi");
  }

  // Utility function to parse and return a numeric configuration parameter.
  private parseOptionNumeric(option: Nullable<string | undefined>, convert: (value: string) => number): Nullable<number | undefined> {

    // If the option is disabled or we don't have it configured -- we're done.
    if(!option) {

      return (option === null) ? null : undefined;
    }

    // Convert it to a number, if needed.
    const convertedValue = convert(option);

    // Let's validate to make sure it's really a number.
    if(isNaN(convertedValue)) {

      return undefined;
    }

    // Return the value.
    return convertedValue;
  }

  // Regular expression test for value-centric feature options.
  private valueRegex(option: string, id?: string): RegExp {

    // Escape out our option to ensure we have no inadvertent issues in matching the regular expression.
    option = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option when
    // the option is enabled, and that we ignore the values at the end when the option is disabled in order to correctly traverse the hierarchy.
    return new RegExp("^(Disable|Enable)\\." + option + (!id ? "" : "\\." + id) + "(?:(?<=^Enable\\." + option + (!id ? "" : "\\." + id) + ")\\.([^\\.]*))?$", "gi");
  }
}
