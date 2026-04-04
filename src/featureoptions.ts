/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
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
 * @property inputSize       - Optional. Width of the input field for a value-based feature option. Defaults to 5 characters.
 * @property name            - Name of the feature option (used in option strings).
 */
export interface FeatureOptionEntry {

  default: boolean;                // Default feature option state.
  defaultValue?: number | string;  // Default value for value-based feature options.
  description: string;             // Description of the feature option.
  group?: string;                  // Feature option grouping for related options.
  inputSize?: number;              // Width of the input field for a value-based feature option.
  name: string;                    // Name of the feature option.
}

/**
 * Entry describing a feature option category.
 *
 * @property description     - Description of the category.
 * @property name            - Name of the category.
 */
export interface FeatureCategoryEntry {

  description: string;
  name: string;
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

  scope: OptionScope;
  value: boolean;
}

/**
 * Internal result of resolving a feature option through the scope hierarchy. Captures the scope where the option was found, whether it's enabled, and the raw string
 * value for value-centric options. This single traversal result serves both boolean queries (test/scope) and value queries, eliminating duplicate scope walks.
 */
interface ResolvedOptionEntry {

  enabled: boolean;
  optionValue?: string;
  scope: OptionScope;
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
  private _groups: Record<string, string[]>;
  private _options: Record<string, FeatureOptionEntry[]>;
  private configLookup: Map<string, { enabled: boolean; value?: string }>;
  private defaults: Record<string, boolean>;
  private valueOptions: Record<string, number | string | undefined>;

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
  constructor(categories: FeatureCategoryEntry[], options: Record<string, FeatureOptionEntry[]>, configuredOptions: string[] = []) {

    // Initialize our defaults.
    this._categories = [];
    this._configuredOptions = [];
    this._groups = {};
    this._options = {};
    this.configLookup = new Map();
    this.defaultReturnValue = false;
    this.defaults = {};
    this.valueOptions = {};

    this.categories = categories;
    this.configuredOptions = configuredOptions;
    this.options = options;
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

    return this.configLookup.has(option.toLowerCase() + (id ? "." + id.toLowerCase() : ""));
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

    if(!categoryName.length) {

      return "";
    }

    return (!optionName.length) ? categoryName : categoryName + "." + optionName;
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

    return this.exists(option, device);
  }

  /**
   * Return whether an option has been set in the global scope context.
   *
   * @param option        - Feature option to check.
   *
   * @returns Returns true if the option is set globally and false otherwise.
   */
  public isScopeGlobal(option: string): boolean {

    return this.exists(option);
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

    // Resolve the option through the scope hierarchy in a single traversal. This gives us the scope, enabled state, and raw value in one pass.
    const resolved = this.resolveScope(option, device, controller);

    // If the option has been explicitly disabled at any scope, or wasn't configured and its default is disabled, there's no value.
    if(!resolved.enabled) {

      return null;
    }

    // If we found an explicit value in the index, return it.
    if(resolved.optionValue) {

      return resolved.optionValue;
    }

    // The option is enabled but has no explicit value. If it wasn't configured at any scope (scope is "none"), fall back to the registered default value.
    if(resolved.scope === "none") {

      return this.valueOptions[option.toLowerCase()]?.toString() ?? null;
    }

    // The option is enabled at an explicit scope but no value was provided...return undefined to indicate "enabled, no value."
    return undefined;
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

    // Regenerate defaults and the lookup index.
    this.generateDefaults();
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

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this._configuredOptions = options ?? [];

    // Regenerate defaults and the lookup index.
    this.generateDefaults();
  }

  /**
   * Return the list of available feature option groups.
   *
   * @returns Returns the current list of available feature option groups.
   */
  public get groups(): Record<string, string[]> {

    return this._groups;
  }

  /**
   * Return the list of available feature options.
   *
   * @returns Returns the current list of available feature options.
   */
  public get options(): Record<string, FeatureOptionEntry[]> {

    return this._options;
  }

  /**
   * Set the list of available feature options.
   *
   * @param options       - Array of available feature options.
   */
  public set options(options: Record<string, FeatureOptionEntry[]>) {

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this._options = options ?? {};

    // Regenerate defaults and the lookup index.
    this.generateDefaults();
  }

  // Rebuild the defaults, groups, value options, and lookup index from the current categories, options, and configured options. All three property setters call this so
  // that state is always consistent regardless of which setter is called or in what order.
  private generateDefaults(): void {

    this.defaults = {};
    this._groups = {};
    this.valueOptions = {};

    for(const category of this.categories) {

      // If the category doesn't exist, let's skip it.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

    // Rebuild the lookup index now that we know which options are value-centric.
    this.buildConfigIndex();
  }

  // Resolves a feature option through the scope hierarchy in a single traversal. Returns the scope where the option was found, whether it's enabled, and the raw string
  // value for value-centric options. This is the core resolution method that both test()/scope() and value() build on, eliminating the need for separate traversals.
  //
  // There are a couple of ways to enable and disable options. The rules of the road are:
  //
  // 1. Explicitly disabling or enabling an option on the controller propagates to all the devices that are managed by that controller.
  //
  // 2. Explicitly disabling or enabling an option on a device always overrides the above. This means that it's possible to disable an option for a controller, and all
  //    the devices that are managed by it, and then override that behavior on a single device that it's managing.
  private resolveScope(option: string, device?: string, controller?: string): ResolvedOptionEntry {

    const normalizedOption = option.toLowerCase();
    let entry;

    // Check to see if we have a device-level option first.
    if(device) {

      entry = this.configLookup.get(normalizedOption + "." + device.toLowerCase());

      if(entry) {

        return { enabled: entry.enabled, optionValue: entry.value, scope: "device" };
      }
    }

    // Now check to see if we have a controller-level option.
    if(controller) {

      entry = this.configLookup.get(normalizedOption + "." + controller.toLowerCase());

      if(entry) {

        return { enabled: entry.enabled, optionValue: entry.value, scope: "controller" };
      }
    }

    // Finally, we check for a global-level value.
    entry = this.configLookup.get(normalizedOption);

    if(entry) {

      return { enabled: entry.enabled, optionValue: entry.value, scope: "global" };
    }

    // The option hasn't been set at any scope, return our default value.
    return { enabled: this.defaultValue(option), scope: "none" };
  }

  // Thin wrapper over resolveScope() that returns the OptionInfoEntry shape expected by test() and scope().
  private optionInfo(option: string, device?: string, controller?: string): OptionInfoEntry {

    const resolved = this.resolveScope(option, device, controller);

    return { scope: resolved.scope, value: resolved.enabled };
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

  // Build a lookup index from the configured option strings. Each entry is keyed by its normalized lookup path (option name, or option name + scope id) and stores
  // whether the option is enabled along with the extracted value for value-centric options. The index is built once when configured options or option definitions change,
  // and all subsequent lookups are O(1).
  private buildConfigIndex(): void {

    this.configLookup = new Map();

    // Collect known value option names, sorted longest first for greedy prefix matching. This ensures that when option names overlap (e.g., a category "audio" and an
    // option "audio.volume"), the more specific name matches first.
    const valueOptionNames = Object.keys(this.valueOptions).sort((a, b) => b.length - a.length);

    for(const rawEntry of this._configuredOptions) {

      // Parse the action prefix (Enable or Disable).
      const dotIndex = rawEntry.indexOf(".");

      if(dotIndex === -1) {

        continue;
      }

      const action = rawEntry.slice(0, dotIndex).toLowerCase();

      if((action !== "enable") && (action !== "disable")) {

        continue;
      }

      const enabled = action === "enable";
      const tailOriginal = rawEntry.slice(dotIndex + 1);
      const tail = tailOriginal.toLowerCase();

      // Register the exact tail as a lookup key. First-write-wins...if the same option appears multiple times, the earliest entry in the array takes precedence.
      if(!this.configLookup.has(tail)) {

        this.configLookup.set(tail, { enabled });
      }

      // For Enable entries on value-centric options, extract the trailing value segment and register under the base key (option or option.id) so that value lookups
      // resolve in O(1) instead of requiring regex matching and array scanning.
      if(!enabled) {

        continue;
      }

      for(const optName of valueOptionNames) {

        if(!tail.startsWith(optName)) {

          continue;
        }

        const remainder = tail.slice(optName.length);

        // Exact match on the option name with no trailing segments...there's no value to extract.
        if(!remainder.length) {

          break;
        }

        // The next character must be a dot separator. If not, this option name is merely a prefix of a longer unrelated token.
        if(!remainder.startsWith(".")) {

          continue;
        }

        const extra = remainder.slice(1);
        const extraOriginal = tailOriginal.slice(optName.length + 1);
        const separatorIndex = extra.indexOf(".");

        if(separatorIndex === -1) {

          // Single trailing segment after the option name. At global scope this is the value; at scoped scope it's the id. Register under the option name as the
          // base key so that global value lookups find it.
          if(!this.configLookup.has(optName)) {

            this.configLookup.set(optName, { enabled: true, value: extraOriginal });
          }
        } else {

          // Two trailing segments: the first is the scope id and the second is the value.
          const idLower = extra.slice(0, separatorIndex);
          const valueOriginal = extraOriginal.slice(separatorIndex + 1);

          // Only register if the value portion is a single segment (no additional dots).
          if(!valueOriginal.includes(".")) {

            const baseKey = optName + "." + idLower;

            if(!this.configLookup.has(baseKey)) {

              this.configLookup.set(baseKey, { enabled: true, value: valueOriginal });
            }
          }
        }

        break;
      }
    }
  }
}
