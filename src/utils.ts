/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * utils.ts: Useful utility functions when writing TypeScript.
 */

export interface HomebridgePluginLogging {

  debug: (message: string, ...parameters: unknown[]) => void,
  error: (message: string, ...parameters: unknown[]) => void,
  info: (message: string, ...parameters: unknown[]) => void,
  warn: (message: string, ...parameters: unknown[]) => void
}

// Emulate a sleep function.
export function sleep(sleepTimer: number): Promise<NodeJS.Timeout> {

  return new Promise(resolve => setTimeout(resolve, sleepTimer));
}

// Retry an operation until we're successful.
export async function retry(operation: () => Promise<boolean>, retryInterval: number): Promise<boolean> {

  // Try the operation that was requested.
  if(!(await operation())) {

    // If the operation wasn't successful, let's sleep for the requested interval and try again.
    await sleep(retryInterval);
    return retry(operation, retryInterval);
  }

  // We were successful - we're done.
  return true;
}
