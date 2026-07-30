/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * polyfills.ts: The explicit-resource-management floor bridge - installs the ERM globals that a runtime below the platform floor does not ship.
 */

/**
 * The explicit-resource-management floor bridge: a side-effect module that installs `AsyncDisposableStack`, `DisposableStack`, and `SuppressedError` as globals on any
 * runtime that does not already ship them.
 *
 * The platform ships all three starting in Node 24, but the package's `engines.node` floor is lower, so on that floor a construction site that reads the platform name
 * throws a `ReferenceError`. Importing this subpath first at a consumer's entry point closes that gap for the whole process: after the import, every construction site
 * anywhere in the program reads `new AsyncDisposableStack()` (and the rest) against a global that is now guaranteed to exist, whether the platform supplied it or this
 * module did. That single import is the entire consumer gesture - no wiring, no injection, nothing to pass around.
 *
 * ```ts
 * // The first import in the plugin's entry point, before anything that constructs a disposable stack.
 * import "homebridge-plugin-utils/polyfills";
 * ```
 *
 * This module is temporary by design and its removal is a planned break, documented here at its birth: when `engines.node` reaches the release that ships the ERM
 * globals, this module, the shims it installs, and the `./polyfills` export subpath are all deleted, and every consumer deletes its import in the same breath. The
 * runtime-floor conformance test enforces the package half of that sunset the moment the floor is bumped.
 *
 * Installation is `??=`, so the first installer in a process wins and a global the platform already supplies is never overwritten. In a shared process - a Homebridge
 * instance running several plugins from this family - that means whichever plugin loads first supplies the constructors for all of them, which is benign: every
 * installer lands the same spec-shaped constructors from the same package, so there is nothing to detect and no conflict to report.
 *
 * @module
 */
import { AsyncDisposableStack } from "./async-disposable-stack.ts";
import { DisposableStack } from "./disposable-stack.ts";
import { SuppressedError } from "./suppressed-error.ts";

/**
 * The install target: the three explicit-resource-management globals, each optional.
 *
 * The optionality is the point. The platform's own lib declares all three as always-present `var`s, which is untrue on the runtime floor this module exists to serve, so
 * a plain read of `globalThis.DisposableStack` types as never-undefined and the `??=` below would read as a check that can never fail. Declaring the target through this
 * type restores the runtime truth at the one place it matters, which lets each install line typecheck as written, with no per-line casts, and makes a plain object a
 * legal argument for a test that needs to watch the installation happen.
 *
 * @category Utilities
 */
export type ErmInstallTarget = Partial<Pick<typeof globalThis, "AsyncDisposableStack" | "DisposableStack" | "SuppressedError">>;

/**
 * Install the explicit-resource-management constructors onto `target`, leaving any that are already present untouched.
 *
 * Importing this module runs the installation against `globalThis` on its own, so a consumer never needs to call this directly. It is exported for the conformance
 * tests, which run it against a plain object to observe exactly what a runtime missing the globals would receive.
 *
 * @param target - The object to install onto. Defaults to `globalThis`.
 *
 * @example
 *
 * ```ts
 * import { installErmPolyfills } from "homebridge-plugin-utils/polyfills";
 *
 * // Observe what a runtime without the globals receives.
 * const target = {};
 *
 * installErmPolyfills(target);
 * ```
 *
 * @category Utilities
 */
export function installErmPolyfills(target: ErmInstallTarget = globalThis): void {

  target.AsyncDisposableStack ??= AsyncDisposableStack;
  target.DisposableStack ??= DisposableStack;
  target.SuppressedError ??= SuppressedError;
}

// Importing this module IS the installation. Everything above is the mechanism; this line is why a consumer's single side-effect import is the whole gesture.
installErmPolyfills();
