/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * disposable-stack.ts: An in-package stand-in for the platform `DisposableStack` global that the library's own port allocator relies on.
 */

/**
 * A drop-in implementation of the TC39 Explicit Resource Management `DisposableStack`.
 *
 * The platform ships `DisposableStack` as a runtime global starting in Node 24, but the package's `engines.node` floor is lower, so on that floor evaluating
 * `new DisposableStack()` against the global throws a `ReferenceError`. This module provides the identical contract as a normal import, so every call site reads
 * exactly as it would against the native class and the by-construction acquire-with-cleanup pairing is preserved. When the `engines.node` floor reaches Node 24 the
 * platform global takes over and this module and its imports are deleted... the runtime-floor conformance test in `runtime-floor.test.ts` enforces exactly that
 * deletion the moment the floor is bumped. The class is intentionally not re-exported from `src/index.ts`: the platform global is its eventual owner and no consumer
 * may couple to it.
 *
 * @module
 */
import type { Nullable } from "./util.ts";

// Build a `SuppressedError` that links a newer disposal failure to the error it supersedes, matching the spec's multi-failure aggregation shape. We read the platform
// `SuppressedError` global fresh on every call rather than caching a reference, because that constructor is itself part of the Node 24 explicit-resource-management
// surface and can be absent on the engines floor this module exists to serve. When it is missing we synthesize a structurally-identical stand-in - an `Error` whose
// name is "SuppressedError" carrying `error` and `suppressed` - so multi-failure aggregation is observably identical whether or not the global is present. The typed
// optional read tells the truth the platform lib cannot: on this engines floor the global may not exist.
function createSuppressedError(error: unknown, suppressed: unknown): unknown {

  const suppressedErrorConstructor = (globalThis as { SuppressedError?: typeof globalThis.SuppressedError }).SuppressedError;

  if(suppressedErrorConstructor !== undefined) {

    return new suppressedErrorConstructor(error, suppressed);
  }

  const synthesized = new Error() as Error & { error: unknown; suppressed: unknown };

  synthesized.error = error;
  synthesized.name = "SuppressedError";
  synthesized.suppressed = suppressed;

  return synthesized;
}

/**
 * A container that aggregates disposable resources and disposes them, in reverse (last-in-first-out) order, when the stack itself is disposed.
 *
 * The class satisfies the platform `DisposableStack` interface by construction - the `implements` clause below binds it to `globalThis.DisposableStack`, so the
 * compiler enforces that the name's promise (the platform contract) is kept at the definition site.
 *
 * @category Utilities
 */
export class DisposableStack implements InstanceType<typeof globalThis.DisposableStack> {

  // The pending disposers in registration order. A `null` array is the disposed state: pairing "disposed" with "no pending disposers" in a single field makes the
  // disposed-with-pending-work state unrepresentable, so every member checks this one field to decide whether it may still register or run work.
  #disposers: Nullable<(() => void)[]> = [];

  // The platform tag reported by `Object.prototype.toString`, matching the native class.
  readonly [Symbol.toStringTag] = "DisposableStack";

  /**
   * Whether this stack has been disposed.
   */
  get disposed(): boolean {

    return this.#disposers === null;
  }

  /**
   * Register a {@link Disposable} whose `[Symbol.dispose]()` runs when this stack is disposed, returning the value unchanged.
   *
   * `null` and `undefined` pass through without being registered. The dispose method is captured at registration time and invoked with the value as its receiver, so
   * a later mutation of `value[Symbol.dispose]` cannot change what runs.
   *
   * @param value - The resource to register, or `null`/`undefined` to skip registration.
   * @returns The provided `value`.
   */
  use<T extends Disposable | null | undefined>(value: T): T {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot use a resource on a disposed DisposableStack.");
    }

    // Skip registration for null and undefined, returning them unchanged. We test undefined with `typeof` so the generic parameter narrows cleanly to a Disposable for
    // the member access below.
    if((value === null) || (typeof value === "undefined")) {

      return value;
    }

    // Capture the dispose method now, at registration time, matching the spec's registration-time capture... a later mutation of `value[Symbol.dispose]` must not change
    // what runs. We read it through `unknown` because use() is a trust boundary: a value can satisfy the Disposable type nominally yet present a non-callable member at
    // runtime, which the spec requires we reject with a TypeError.
    const disposeMethod: unknown = value[Symbol.dispose];

    if(typeof disposeMethod !== "function") {

      throw new TypeError("The value passed to DisposableStack.use() is not disposable.");
    }

    const boundDispose = disposeMethod as () => void;

    this.#disposers.push(() => {

      boundDispose.call(value);
    });

    return value;
  }

  /**
   * Register a value together with an explicit disposal callback, returning the value unchanged. The callback is invoked with the value as its first argument when
   * this stack is disposed.
   *
   * @param value - The value to associate with the callback.
   * @param onDispose - The disposal callback, invoked with `value`.
   * @returns The provided `value`.
   */
  adopt<T>(value: T, onDispose: (value: T) => void): T {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot adopt a resource on a disposed DisposableStack.");
    }

    if(typeof onDispose !== "function") {

      throw new TypeError("The onDispose callback passed to DisposableStack.adopt() is not a function.");
    }

    this.#disposers.push(() => onDispose(value));

    return value;
  }

  /**
   * Register a callback to run when this stack is disposed.
   *
   * @param onDispose - The callback to run on disposal.
   */
  defer(onDispose: () => void): void {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot defer a callback on a disposed DisposableStack.");
    }

    if(typeof onDispose !== "function") {

      throw new TypeError("The onDispose callback passed to DisposableStack.defer() is not a function.");
    }

    this.#disposers.push(onDispose);
  }

  /**
   * Move every pending disposer out of this stack into a fresh {@link DisposableStack}, preserving registration order, and mark this stack disposed without running
   * anything. This is the "commit" primitive: after a successful acquire sequence, moving the disposers away disarms this stack's scope-bound cleanup while handing
   * responsibility for those resources to the returned stack.
   *
   * @returns A new stack owning the transferred disposers.
   */
  move(): DisposableStack {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot move a disposed DisposableStack.");
    }

    const moved = new DisposableStack();

    // Transfer the array by reference so order is preserved, then mark this stack disposed without running any disposer.
    moved.#disposers = this.#disposers;
    this.#disposers = null;

    return moved;
  }

  /**
   * Dispose every registered resource in reverse (last-in-first-out) order. A second call is a no-op. Every disposer runs even when an earlier one throws: a single
   * failure is rethrown after the sweep completes, and multiple failures chain through `SuppressedError` (the newest failure wrapping the accumulated one).
   */
  dispose(): void {

    if(this.#disposers === null) {

      return;
    }

    // Detach the array and mark disposed before running anything, so a disposer that re-enters this stack observes the disposed state and cannot double-run work.
    const disposers = this.#disposers;

    this.#disposers = null;

    let hasError = false;
    let heldError: unknown;

    // Reverse the detached array in place - we hold the only reference to it, so mutating it is safe - and run the disposers last-in-first-out.
    for(const disposer of disposers.reverse()) {

      try {

        disposer();
      } catch(error) {

        heldError = hasError ? createSuppressedError(error, heldError) : error;
        hasError = true;
      }
    }

    if(hasError) {

      throw heldError;
    }
  }

  /**
   * Dispose this stack. Enables `using` semantics by delegating to {@link dispose}.
   */
  [Symbol.dispose](): void {

    this.dispose();
  }
}
