/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * util.ts: Useful utility functions when writing TypeScript.
 */

/**
 * TypeScript Utilities.
 *
 * @module
 */

/**
 * A utility type that recursively makes all properties of an object, including nested objects, optional.
 *
 * This should only be used on JSON objects. If used on classes, class methods will also be marked as optional.
 *
 * @remarks Credit for this type goes to: https://github.com/joonhocho/tsdef.
 *
 * @typeParam T - The type to make recursively partial.
 *
 * @example
 *
 * ```ts
 * type Original = {
 *
 *   id: string;
 *   nested: { value: number };
 * };
 *
 * // All properties, including nested ones, are optional.
 * type PartialObj = DeepPartial<Original>;
 *
 * const obj: PartialObj = { nested: {} };
 * ```
 *
 * @category Utilities
 */
export type DeepPartial<T> = {

  [P in keyof T]?: T[P] extends Array<infer I> ? Array<DeepPartial<I>> : DeepPartial<T[P]>
};

/**
 * A utility type that recursively makes all properties of an object, including nested objects, readonly.
 *
 * This should only be used on JSON objects. If used on classes, class methods will also be marked as readonly.
 *
 * @remarks Credit for this type goes to: https://github.com/joonhocho/tsdef.
 *
 * @typeParam T - The type to make recursively readonly.
 *
 * @example
 *
 * ```ts
 * type Original = {
 *   id: string;
 *   nested: { value: number };
 * };
 *
 * // All properties, including nested ones, are readonly.
 * type ReadonlyObj = DeepReadonly<Original>;
 *
 * const obj: ReadonlyObj = { id: "a", nested: { value: 1 } };
 * // obj.id = "b"; // Error: cannot assign to readonly property.
 * ```
 *
 * @category Utilities
 */
export type DeepReadonly<T> = {

  readonly [P in keyof T]: T[P] extends Array<infer I> ? Array<DeepReadonly<I>> : DeepReadonly<T[P]>
};

/**
 * Utility type that allows a value to be either the given type or `null`.
 *
 * This type is used to explicitly indicate that a variable, property, or return value may be either a specific type or `null`.
 *
 * @typeParam T - The type to make nullable.
 *
 * @example
 *
 * ```ts
 * let id: Nullable<string> = null;
 *
 * // Later...
 * id = "device-001";
 * ```
 *
 * @category Utilities
 */
export type Nullable<T> = T | null;

/**
 * Logging interface for Homebridge plugins.
 *
 * This interface defines the standard logging methods (`debug`, `info`, `warn`, `error`) that plugins should use to output log messages at different severity levels. It
 * is intended to be compatible with Homebridge's builtin logger and can be implemented by any custom logger used within Homebridge plugins.
 *
 * @example
 *
 * ```ts
 * function example(log: HomebridgePluginLogging) {
 *
 *   log.debug("Debug message: %s", "details");
 *   log.info("Informational message.");
 *   log.warn("Warning message!");
 *   log.error("Error message: %s", "problem");
 * }
 * ```
 *
 * @category Utilities
 */
export interface HomebridgePluginLogging {

  /**
   * Logs a debug-level message.
   *
   * @param message    - The message string, with optional format specifiers.
   * @param parameters - Optional parameters for message formatting.
   */
  debug: (message: string, ...parameters: unknown[]) => void;

  /**
   * Logs an error-level message.
   *
   * @param message    - The message string, with optional format specifiers.
   * @param parameters - Optional parameters for message formatting.
   */
  error: (message: string, ...parameters: unknown[]) => void;

  /**
   * Logs an info-level message.
   *
   * @param message    - The message string, with optional format specifiers.
   * @param parameters - Optional parameters for message formatting.
   */
  info: (message: string, ...parameters: unknown[]) => void;

  /**
   * Logs a warning-level message.
   *
   * @param message    - The message string, with optional format specifiers.
   * @param parameters - Optional parameters for message formatting.
   */
  warn: (message: string, ...parameters: unknown[]) => void;
}

/**
 * A utility method that formats a bitrate value into a human-readable form as kbps or Mbps.
 *
 * @param value           - The bitrate value to convert.
 *
 * @returns Returns the value as a human-readable string.
 * @example
 *
 * ```ts
 * formatBps(500);        // "500 bps".
 * formatBps(2000);       // "2.0 kbps".
 * formatBps(15000);      // "15.0 kbps".
 * formatBps(1000000);    // "1.0 Mbps".
 * formatBps(2560000);    // "2.6 Mbps".
 * ```
 */
export function formatBps(value: number): string {

  // Return the bitrate as-is.
  if(value < 1000) {

    return value.toString() + " bps";
  }

  // Return the bitrate in kilobits.
  if(value < 1000000) {

    const kbps = value / 1000;

    return ((kbps % 1) === 0 ? kbps.toFixed(0) : kbps.toFixed(1)) + " kbps";
  }

  // Return the bitrate in megabits.
  const mbps = value / 1000000;

  return ((mbps % 1) === 0 ? mbps.toFixed(0) : mbps.toFixed(1)) + " Mbps";
}

/**
 * A utility method that retries an operation at a specific interval for up to an absolute total number of retries.
 *
 * @param operation       - The operation callback to try until successful.
 * @param retryInterval   - Interval to retry, in milliseconds.
 * @param totalRetries    - Optionally, specify the total number of retries.
 *
 * @returns Returns `true` when the operation is successful, `false` otherwise or if the total number of retries has been exceeded.
 *
 * @remarks `operation` must be an asynchronous function that returns `true` when successful, and `false` otherwise.
 *
 * @example
 * ```ts
 * // Example: Retry an async operation up to 5 times, waiting 1 second between each try.
 * let attempt = 0;
 * const result = await retry(async () => {
 *
 *   attempt++;
 *
 *   // Simulate a 50% chance of success
 *   return Math.random() > 0.5 || attempt === 5;
 * }, 1000, 5);
 *
 * console.log(result); // true if operation succeeded within 5 tries, otherwise false.
 * ```
 *
 * @category Utilities
 */
export async function retry(operation: () => Promise<boolean>, retryInterval: number, totalRetries?: number): Promise<boolean> {

  if((totalRetries !== undefined) && (totalRetries <= 0)) {

    return false;
  }

  // Try the operation that was requested.
  if(!(await operation())) {

    // If the operation wasn't successful, let's sleep for the requested interval and try again.
    await sleep(retryInterval);

    return retry(operation, retryInterval, (totalRetries === undefined) ? undefined : --totalRetries);
  }

  // We were successful - we're done.
  return true;
}

/**
 * Run a promise with a guaranteed timeout to complete.
 *
 * @typeParam T           - The type of value the promise resolves with.
 * @param promise         - The promise you want to run.
 * @param timeout         - The amount of time, in milliseconds, to wait for the promise to resolve.
 *
 * @returns Returns the result of resolving the promise it's been passed if it completes before timeout, or null if the timeout expires.
 *
 * @example
 * ```ts
 * // Resolves in 100ms, timeout is 500ms, so it resolves to 42.
 * const result = await runWithTimeout(Promise.resolve(42), 500);
 * console.log(result); // 42
 *
 * // Resolves in 1000ms, timeout is 500ms, so it resolves to null.
 * const slowPromise = new Promise<number>(resolve => setTimeout(() => resolve(42), 1000));
 * const result2 = await runWithTimeout(slowPromise, 500);
 * console.log(result2); // null
 * ```
 *
 * @category Utilities
 */
export async function runWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<Nullable<T>> {

  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout));

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Emulate a sleep function.
 *
 * @param sleepTimer      - The amount of time to sleep, in milliseconds.
 *
 * @returns Returns a promise that resolves after the specified time elapses.
 *
 * @example
 * To sleep for 3 seconds before continuing execute:
 *
 * ```ts
 * await sleep(3000)
 * ```
 *
 * @category Utilities
 */
export async function sleep(sleepTimer: number): Promise<NodeJS.Timeout> {

  return new Promise(resolve => setTimeout(resolve, sleepTimer));
}

/**
 * Camel case a string.
 *
 * @param input           - The string to camel case.
 *
 * @returns Returns the camel cased string.
 *
 * @example
 * ```ts
 * toCamelCase(This is a test)
 * ```
 *
 * Returns: `This Is A Test`, capitalizing the first letter of each word.
 * @category Utilities
 */
export function toCamelCase(input: string): string {

  return input.replace(/(^\w|\s+\w)/g, match => match.toUpperCase());
}

/**
 * Validate an accessory name according to HomeKit naming conventions.
 *
 * @param name            - The name to validate.
 *
 * @returns Returns the HomeKit-validated version of the name, replacing invalid characters with a space and squashing multiple spaces.
 *
 * @remarks This validates names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names):
 *
 * - Use only alphanumeric, space, and apostrophe characters.
 * - Start and end with an alphabetic or numeric character.
 * - Don’t include emojis.
 *
 * @example
 * ```ts
 * validateName("Test.Switch")
 * ```ts
 *
 * Returns: `Test Switch`, replacing the period (an invalid character in HomeKit's naming ruleset) with a space.
 *
 * @category Utilities
 */
export function validateName(name: string): string {

  return name.replace(/[^\p{L}\p{N} ']+/gu, " ").replace(/\s+/g, " ").trim();
}
