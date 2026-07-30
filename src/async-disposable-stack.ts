/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * async-disposable-stack.ts: An in-package stand-in for the platform `AsyncDisposableStack` global, for consumers whose teardown is asynchronous.
 */

/**
 * A drop-in implementation of the TC39 Explicit Resource Management `AsyncDisposableStack`.
 *
 * The platform ships `AsyncDisposableStack` as a runtime global starting in Node 24, but the package's `engines.node` floor is lower, so on that floor evaluating
 * `new AsyncDisposableStack()` against the global throws a `ReferenceError`. This module provides the identical contract as a normal import, so every call site reads
 * exactly as it would against the native class and the by-construction acquire-with-cleanup pairing is preserved. When the `engines.node` floor reaches Node 24 the
 * platform global takes over and this module and its imports are deleted... the runtime-floor conformance test in `runtime-floor.test.ts` enforces exactly that
 * deletion the moment the floor is bumped. The class is intentionally not re-exported from `src/index.ts`: the platform global is its eventual owner and no consumer
 * may couple to it.
 *
 * A consumer reaches this class through the `homebridge-plugin-utils/polyfills` subpath, which installs it as the global at the consumer's entry point so construction
 * sites read against the platform name. Library code inside this package does the opposite and imports this module directly: a library has no entry point of its own,
 * so it can never assume a consumer's polyfill import ran before its own code did.
 *
 * There is deliberately no shared base class with the synchronous `disposable-stack.ts` shim. The two sunset independently as whole files, and a shared base would
 * couple those deletions to each other; the bounded duplication between them dies at the Node 24 floor along with both files.
 *
 * @module
 */
import type { Nullable } from "./util.ts";
import { createSuppressedError } from "./disposable-stack.ts";

/**
 * A container that aggregates async and sync disposable resources and disposes them, in reverse (last-in-first-out) order, when the stack itself is disposed.
 *
 * The class satisfies the platform `AsyncDisposableStack` interface by construction - the `implements` clause below binds it to `globalThis.AsyncDisposableStack`, so
 * the compiler enforces that the name's promise (the platform contract) is kept at the definition site.
 *
 * @example
 *
 * ```ts
 * await using stack = new AsyncDisposableStack();
 *
 * const client = stack.use(await connectClient());
 *
 * stack.defer(async () => flushTelemetry());
 * ```
 *
 * @category Utilities
 */
export class AsyncDisposableStack implements InstanceType<typeof globalThis.AsyncDisposableStack> {

  // The pending disposers in registration order. A `null` array is the disposed state: pairing "disposed" with "no pending disposers" in a single field makes the
  // disposed-with-pending-work state unrepresentable, so every member checks this one field to decide whether it may still register or run work.
  #disposers: Nullable<(() => Promise<void> | void)[]> = [];

  // The platform tag reported by `Object.prototype.toString`, matching the native class.
  readonly [Symbol.toStringTag] = "AsyncDisposableStack";

  /**
   * Whether this stack has been disposed.
   */
  get disposed(): boolean {

    return this.#disposers === null;
  }

  /**
   * Register an {@link AsyncDisposable} or {@link Disposable} whose disposal method runs when this stack is disposed, returning the value unchanged.
   *
   * `null` and `undefined` pass through without being registered. `[Symbol.asyncDispose]` is preferred when the value has one and `[Symbol.dispose]` is the fallback,
   * matching the platform's own preference. The chosen method is captured at registration time and invoked with the value as its receiver, so a later mutation of
   * either member cannot change what runs.
   *
   * @param value - The resource to register, or `null`/`undefined` to skip registration.
   * @returns The provided `value`.
   */
  use<T extends AsyncDisposable | Disposable | null | undefined>(value: T): T {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot use a resource on a disposed AsyncDisposableStack.");
    }

    // Skip registration for null and undefined, returning them unchanged. We test undefined with `typeof` so the generic parameter narrows cleanly to a disposable for
    // the member access below.
    if((value === null) || (typeof value === "undefined")) {

      return value;
    }

    // Capture the disposal method now, at registration time, matching the spec's registration-time capture... a later mutation of the value's disposal members must not
    // change what runs. We read both through `unknown` because use() is a trust boundary: a value can satisfy the type nominally yet present a non-callable member at
    // runtime, which the spec requires we reject with a TypeError. The async member wins when both are present, which is the platform's own preference.
    const asyncDisposeMethod: unknown = (value as Partial<AsyncDisposable>)[Symbol.asyncDispose];
    const syncDisposeMethod: unknown = (value as Partial<Disposable>)[Symbol.dispose];
    const disposeMethod = (typeof asyncDisposeMethod === "function") ? asyncDisposeMethod : syncDisposeMethod;

    if(typeof disposeMethod !== "function") {

      throw new TypeError("The value passed to AsyncDisposableStack.use() is not disposable.");
    }

    const boundDispose = disposeMethod as () => Promise<void> | void;

    this.#disposers.push(() => boundDispose.call(value));

    return value;
  }

  /**
   * Register a value together with an explicit disposal callback, returning the value unchanged. The callback is invoked with the value as its first argument when
   * this stack is disposed, and is awaited if it returns a promise.
   *
   * @param value          - The value to associate with the callback.
   * @param onDisposeAsync - The disposal callback, invoked with `value`.
   * @returns The provided `value`.
   */
  adopt<T>(value: T, onDisposeAsync: (value: T) => PromiseLike<void> | void): T {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot adopt a resource on a disposed AsyncDisposableStack.");
    }

    if(typeof onDisposeAsync !== "function") {

      throw new TypeError("The onDisposeAsync callback passed to AsyncDisposableStack.adopt() is not a function.");
    }

    this.#disposers.push(async () => onDisposeAsync(value));

    return value;
  }

  /**
   * Register a callback to run when this stack is disposed. It is awaited if it returns a promise.
   *
   * @param onDisposeAsync - The callback to run on disposal.
   */
  defer(onDisposeAsync: () => PromiseLike<void> | void): void {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot defer a callback on a disposed AsyncDisposableStack.");
    }

    if(typeof onDisposeAsync !== "function") {

      throw new TypeError("The onDisposeAsync callback passed to AsyncDisposableStack.defer() is not a function.");
    }

    this.#disposers.push(async () => onDisposeAsync());
  }

  /**
   * Move every pending disposer out of this stack into a fresh {@link AsyncDisposableStack}, preserving registration order, and mark this stack disposed without
   * running anything. This is the "commit" primitive: after a successful acquire sequence, moving the disposers away disarms this stack's scope-bound cleanup while
   * handing responsibility for those resources to the returned stack.
   *
   * @returns A new stack owning the transferred disposers.
   */
  move(): AsyncDisposableStack {

    if(this.#disposers === null) {

      throw new ReferenceError("Cannot move a disposed AsyncDisposableStack.");
    }

    const moved = new AsyncDisposableStack();

    // Transfer the array by reference so order is preserved, then mark this stack disposed without running any disposer.
    moved.#disposers = this.#disposers;
    this.#disposers = null;

    return moved;
  }

  /**
   * Dispose every registered resource in reverse (last-in-first-out) order, awaiting each one before starting the next. A second call is a no-op. Every disposer runs
   * even when an earlier one rejects: a single failure is rethrown after the sweep completes, and multiple failures chain through `SuppressedError` (the newest failure
   * wrapping the accumulated one).
   */
  async disposeAsync(): Promise<void> {

    if(this.#disposers === null) {

      return;
    }

    // Detach the array and mark disposed before running anything, so a disposer that re-enters this stack observes the disposed state and cannot double-run work. The
    // detachment happens here, synchronously, rather than after the sweep: a caller that registers against this stack while a slow disposer is still in flight must be
    // rejected, not silently queued behind work that will never run it.
    const disposers = this.#disposers;

    this.#disposers = null;

    let hasError = false;
    let heldError: unknown;

    // Reverse the detached array in place - we hold the only reference to it, so mutating it is safe - and run the disposers last-in-first-out. Each disposer is
    // AWAITED before the next begins, which is the whole point of an async stack: resources released in dependency order, never concurrently.
    for(const disposer of disposers.reverse()) {

      try {

        // eslint-disable-next-line no-await-in-loop
        await disposer();
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
   * Dispose this stack. Enables `await using` semantics by delegating to {@link disposeAsync}.
   */
  async [Symbol.asyncDispose](): Promise<void> {

    await this.disposeAsync();
  }
}
