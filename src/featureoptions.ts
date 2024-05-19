/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureoptions.ts: Hierarchical feature option capabilities for use in plugins and applications.
 */
export interface FeatureOptionEntry {

  default: boolean,           // Default feature option state.
  defaultValue?: number,      // Default value for value-based feature options.
  description: string,        // Description of the feature option.
  group?: string,             // Feature option grouping for related options.
  name: string                // Name of the feature option.
}

export interface FeatureCategoryEntry {

  description: string,
  name: string,
  validFor: string[]
}

// Define the scope hierarchy for HBUP options.
type OptionScope =  "controller" | "device" | "global" | "none";

// Option information JSON definition.
interface OptionInfo {

  scope: OptionScope,
  value: boolean
}

export class FeatureOptions {

  private _categories: FeatureCategoryEntry[];
  private _configuredOptions: string[];
  private _groups: { [index: string]: string[] };
  private _options: { [index: string]: FeatureOptionEntry[] };
  public defaultReturnValue: boolean;
  private defaults: { [index: string]: boolean };
  private valueOptions: { [index: string]: boolean };

  // Create a feature option instance.
  constructor(categories: FeatureCategoryEntry[], options: { [index: string]: FeatureOptionEntry[] }, configuredOptions: string[]) {

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

  public color(option: string, device?: string): string {

    switch(this.scope(option, device)) {

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

    // Value-centric feature options don't have default values.
    if(this.isValue(option)) {

      return this.defaultReturnValue;
    }

    const value = this.defaults[option.toLowerCase()];

    // If it's unknown to us, assume it's true.
    if(value === undefined) {

      return this.defaultReturnValue;
    }

    return value;
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
   * @param value        - Value to parse.
   *
   * @returns Returns a floating point number from a string, or `undefined` if it couldn't be parsed.
   */
  public getFloat(value: string | undefined): number | undefined {

    // We don't have the value configured -- we're done.
    if(value === undefined) {

      return undefined;
    }

    // Parse the number and return the value.
    return this.parseOptionNumeric(value, parseFloat);
  }

  /**
   * Parse an integer feature option value.
   *
   * @param value        - Value to parse.
   *
   * @returns Returns an integer from a string, or `undefined` if it couldn't be parsed.
   */
  public getInteger(value: string | undefined): number | undefined {

    // We don't have the value configured -- we're done.
    if(value === undefined) {

      return undefined;
    }

    // Parse the number and return the value.
    return this.parseOptionNumeric(value, parseInt);
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

    return this.valueOptions[option?.toLowerCase()] === true;
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

    return this.getOptionInfo(option, device, controller).scope;
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

    return this.getOptionInfo(option, device, controller).value;
  }

  /**
   * Return the value associated with a value-centric feature option, traversing the scope hierarchy.
   *
   * @param option        - Feature option to check.
   * @param device        - Optional device scope identifier.
   * @param controller    - Optional controller scope identifier.
   *
   * @returns Returns the current value associated with `option` or `undefined` if none.
   */
  public value(option: string, device?: string, controller?: string): string | undefined {

    const getValue = (checkOption: string, checkId?: string): string | undefined => {

      const regex = this.valueRegex(checkOption, checkId);

      // Get the option value, if we have one.
      for(const entry of this.configuredOptions) {

        const regexMatch = regex.exec(entry);

        if(regexMatch) {

          return regexMatch[1];
        }
      }

      return undefined;
    };

    // Check to see if we have a device-level value first.
    if(device) {

      const value = getValue(option, device);

      if(value) {

        return value;
      }
    }

    // Now check to see if we have an controller-level value.
    if(controller) {

      const value = getValue(option, controller);

      if(value) {

        return value;
      }
    }

    // Finally, we check for a global-level value.
    return getValue(option);
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
   * @param options       - Array of available feature options.
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

      // Now enumerate all the feature options for a given device and add then to the full list.
      for(const option of this.options[category.name]) {

        // Expand the entry.
        const entry = this.expandOption(category, option);

        // Index the default value.
        this.defaults[entry.toLowerCase()] = option.default;

        // Track value-centric options.
        this.valueOptions[entry.toLowerCase()] = "defaultValue" in option;

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
  private getOptionInfo(option: string, device?: string, controller?: string): OptionInfo {

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

    // Deal with value-centric options uniquely.
    if(this.isValue(option)) {

      return this.exists(option, id);
    }

    const regex = this.optionRegex(option, id);

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
  private parseOptionNumeric(option: string | undefined, convert: (value: string) => number): number | undefined {

    // We don't have the option configured -- we're done.
    if(option === undefined) {

      return undefined;
    }

    // Convert it to a number, if needed.
    const convertedValue = convert(option);

    // Let's validate to make sure it's really a number.
    if(isNaN(convertedValue) || (convertedValue < 0)) {

      return undefined;
    }

    // Return the value.
    return convertedValue;
  }

  // Regular expression test for value-centric feature options.
  private valueRegex(option: string, id?: string): RegExp {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option.
    return new RegExp("^Enable\\." + option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (!id ? "" : "\\." + id) + "\\.([^\\.]+)$", "gi");
  }
}
