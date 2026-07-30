[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / suppressed-error

# suppressed-error

A drop-in implementation of the TC39 Explicit Resource Management `SuppressedError`.

`SuppressedError` is what a disposal sweep throws when more than one resource fails: the newest failure travels as `error` and the failure it supersedes as
`suppressed`, so a multi-failure teardown loses nothing. The platform ships it as a runtime global starting in Node 24, but the package's `engines.node` floor is
lower, so on that floor the global is absent and the aggregation has nothing to construct. This module is that constructor, single-sourced for both disposable-stack
shims and for the polyfill that installs it. When the `engines.node` floor reaches Node 24 the platform global takes over and this module is deleted... the
runtime-floor conformance test in `runtime-floor.test.ts` enforces exactly that deletion the moment the floor is bumped. It is intentionally not re-exported from
`src/index.ts`: the platform global is its eventual owner and no consumer may couple to it.

The shape is a function rather than a class, and the contract forces that rather than taste. The platform's `SuppressedErrorConstructor` declares BOTH a construct
signature and a bare call signature - `new SuppressedError(e, s)` and `SuppressedError(e, s)` must each produce an instance, exactly as `Error` does - and an ES class
throws when called without `new`, so a class cannot satisfy the contract it is named after. A function whose body returns a constructed object satisfies both call
forms at once: a `[[Construct]]` call substitutes the returned object for the freshly allocated `this`, and a plain call simply returns it.

## Utilities

### SuppressedError

```ts
const SuppressedError: SuppressedErrorConstructor;
```

The TC39 `SuppressedError` constructor: it links a newer failure to the one it supersedes, so a disposal sweep that fails more than once surfaces every failure in a
single chained error. Both call forms construct - `new SuppressedError(error, suppressed)` and `SuppressedError(error, suppressed)` - and instances are
`instanceof SuppressedError`, `instanceof Error`, and report a `name` of `"SuppressedError"`.

The exported binding carries a single type assertion to the platform's own `SuppressedErrorConstructor`, and that assertion is a deliberate trust boundary. TypeScript
attaches a construct signature only to a class, and a class cannot satisfy this contract's bare call signature, so no cast-free expression of a dual-callable
constructor compiles at all. The assertion is what gives every consumer the exact ambient type; the construct half of the behavior is proven by the runtime duality
tests - both call forms construct, and produce structurally identical instances - and by the differential oracle against the platform global wherever the runtime
ships one, never by the compiler.

#### Example

```ts
import { SuppressedError } from "./suppressed-error.ts";

// Chain a newer disposal failure to the one it supersedes. Both call forms construct.
const chained = new SuppressedError(newestFailure, accumulatedFailure);
const chainedWithMessage = SuppressedError(newestFailure, accumulatedFailure, "Two resources failed to dispose.");
```
