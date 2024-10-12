/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * util.ts: Useful utility functions when writing TypeScript.
 */

/**
 * @internal
 *
 * A utility type that recursively makes all properties of an object, including nested objects, optional. This should only be used on JSON objects only. Otherwise,
 * you're going to end up with class methods marked as optional as well. Credit for this belongs to: https://github.com/joonhocho/tsdef.
 *
 * @template T - The type to make recursively partial.
 */
export type DeepPartial<T> = {

  [P in keyof T]?: T[P] extends Array<infer I> ? Array<DeepPartial<I>> : DeepPartial<T[P]>
};

/**
 * @internal
 *
 * A utility type that recursively makes all properties of an object, including nested objects, optional. This should only be used on JSON objects only. Otherwise,
 * you're going to end up with class methods marked as optional as well. Credit for this belongs to: https://github.com/joonhocho/tsdef.
 *
 * @template T - The type to make recursively partial.
 */
export type DeepReadonly<T> = {

  readonly [P in keyof T]: T[P] extends Array<infer I> ? Array<DeepReadonly<I>> : DeepReadonly<T[P]>
};

/**
 * @internal
 *
 * A utility type that makes a given type assignable to it's type or null.
 */
export type Nullable<T> = T | null;

export interface HomebridgePluginLogging {

  debug: (message: string, ...parameters: unknown[]) => void,
  error: (message: string, ...parameters: unknown[]) => void,
  info: (message: string, ...parameters: unknown[]) => void,
  warn: (message: string, ...parameters: unknown[]) => void
}

// Retry an operation until we're successful.
export async function retry(operation: () => Promise<boolean>, retryInterval: number, totalRetries?: number): Promise<boolean> {

  if((totalRetries !== undefined) && (totalRetries < 0)) {

    return false;
  }

  // Try the operation that was requested.
  if(!(await operation())) {

    // If the operation wasn't successful, let's sleep for the requested interval and try again.
    await sleep(retryInterval);

    return retry(operation, retryInterval, (totalRetries === undefined) ? undefined : totalRetries--);
  }

  // We were successful - we're done.
  return true;
}

// Run a promise with a guaranteed timeout to complete.
export async function runWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<Nullable<T>> {

  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout));

  return Promise.race([promise, timeoutPromise]);
}

// Emulate a sleep function.
export async function sleep(sleepTimer: number): Promise<NodeJS.Timeout> {

  return new Promise(resolve => setTimeout(resolve, sleepTimer));
}

// Validate a name according to HomeKit naming conventions.
export function validateName(name: string): string {

  // Validate our names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names):
  //
  // - Use only alphanumeric, space, and apostrophe characters.
  // - Start and end with an alphabetic or numeric character.
  // - Don’t include emojis.
  //
  // Invalid characters will be replaced by a space, and multiple spaces will be squashed.
  return name.replace(/[^\p{L}\p{N} ']+/gu, " ").replace(/\s+/g, " ").trim();
}
