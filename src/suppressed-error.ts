/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * suppressed-error.ts: An in-package stand-in for the platform `SuppressedError` global that the explicit-resource-management shims aggregate disposal failures through.
 */

/**
 * A drop-in implementation of the TC39 Explicit Resource Management `SuppressedError`.
 *
 * `SuppressedError` is what a disposal sweep throws when more than one resource fails: the newest failure travels as `error` and the failure it supersedes as
 * `suppressed`, so a multi-failure teardown loses nothing. The platform ships it as a runtime global starting in Node 24, but the package's `engines.node` floor is
 * lower, so on that floor the global is absent and the aggregation has nothing to construct. This module is that constructor, single-sourced for both disposable-stack
 * shims and for the polyfill that installs it. When the `engines.node` floor reaches Node 24 the platform global takes over and this module is deleted... the
 * runtime-floor conformance test in `runtime-floor.test.ts` enforces exactly that deletion the moment the floor is bumped. It is intentionally not re-exported from
 * `src/index.ts`: the platform global is its eventual owner and no consumer may couple to it.
 *
 * The shape is a function rather than a class, and the contract forces that rather than taste. The platform's `SuppressedErrorConstructor` declares BOTH a construct
 * signature and a bare call signature - `new SuppressedError(e, s)` and `SuppressedError(e, s)` must each produce an instance, exactly as `Error` does - and an ES class
 * throws when called without `new`, so a class cannot satisfy the contract it is named after. A function whose body returns a constructed object satisfies both call
 * forms at once: a `[[Construct]]` call substitutes the returned object for the freshly allocated `this`, and a plain call simply returns it.
 *
 * @module
 */

// The prototype every instance shares. Its own prototype is `Error.prototype`, so an instance satisfies `instanceof Error` and inherits the standard error behavior,
// and it carries the spec's `name` here rather than as a per-instance own property, exactly as the platform constructor does. `name` is defined with the attribute
// flags a class-style prototype member has - non-enumerable, writable, configurable - rather than assigned, which would make it enumerable.
const suppressedErrorPrototype = Object.create(Error.prototype, {

  name: { configurable: true, enumerable: false, value: "SuppressedError", writable: true }
}) as Error;

// Build an instance. Starting from a real `Error` gives it a stack trace captured at the construction site, which an `Object.create` alone would not produce;
// re-pointing the prototype afterwards is what makes the result a `SuppressedError` rather than a plain `Error`. `message` is forwarded untouched, so omitting it
// leaves the inherited empty-string message the spec calls for instead of the string "undefined".
function constructSuppressedError(error: unknown, suppressed: unknown, message?: string): SuppressedError {

  const instance = new Error(message) as SuppressedError;

  Object.setPrototypeOf(instance, suppressedErrorPrototype);

  // The spec creates `error` and `suppressed` as NON-ENUMERABLE own data properties, matching how `Error` itself carries `message`, so neither payload spills into a
  // structural walk of the caught failure. A plain assignment would make them enumerable and observably unlike the platform constructor - which is precisely the
  // difference the differential oracle checks.
  Object.defineProperties(instance, {

    error: { configurable: true, enumerable: false, value: error, writable: true },
    suppressed: { configurable: true, enumerable: false, value: suppressed, writable: true }
  });

  return instance;
}

// Complete the two-way link between the constructor and its prototype: `prototype` is what `instanceof` consults, and `constructor` is what an instance reports. Both
// go through `defineProperty` rather than assignment so they keep the platform's own shape - a read-only `prototype` and a non-enumerable `constructor` - instead of
// becoming enumerable own properties that a structural comparison would pick up.
Object.defineProperty(constructSuppressedError, "prototype", { value: suppressedErrorPrototype, writable: false });
Object.defineProperty(suppressedErrorPrototype, "constructor", { configurable: true, value: constructSuppressedError, writable: true });

/**
 * The TC39 `SuppressedError` constructor: it links a newer failure to the one it supersedes, so a disposal sweep that fails more than once surfaces every failure in a
 * single chained error. Both call forms construct - `new SuppressedError(error, suppressed)` and `SuppressedError(error, suppressed)` - and instances are
 * `instanceof SuppressedError`, `instanceof Error`, and report a `name` of `"SuppressedError"`.
 *
 * The exported binding carries a single type assertion to the platform's own `SuppressedErrorConstructor`, and that assertion is a deliberate trust boundary. TypeScript
 * attaches a construct signature only to a class, and a class cannot satisfy this contract's bare call signature, so no cast-free expression of a dual-callable
 * constructor compiles at all. The assertion is what gives every consumer the exact ambient type; the construct half of the behavior is proven by the runtime duality
 * tests - both call forms construct, and produce structurally identical instances - and by the differential oracle against the platform global wherever the runtime
 * ships one, never by the compiler.
 *
 * @example
 *
 * ```ts
 * import { SuppressedError } from "./suppressed-error.ts";
 *
 * // Chain a newer disposal failure to the one it supersedes. Both call forms construct.
 * const chained = new SuppressedError(newestFailure, accumulatedFailure);
 * const chainedWithMessage = SuppressedError(newestFailure, accumulatedFailure, "Two resources failed to dispose.");
 * ```
 *
 * @category Utilities
 */
export const SuppressedError = constructSuppressedError as SuppressedErrorConstructor;
