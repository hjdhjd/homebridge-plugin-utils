/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * util.ts: Useful utility functions when writing TypeScript.
 */

/**
 * TypeScript Utilities.
 *
 * @module
 */
import type { Logging } from "homebridge";
import { setTimeout as delay } from "node:timers/promises";

// Validates a name against HomeKit's naming conventions. Compiled once at module scope since this sits on the fast path of sanitizeName().
const VALID_HOMEKIT_NAME = /^(?!.*\p{Extended_Pictographic})(?!.* {2})(?=^[\p{L}\p{N}].*[\p{L}\p{N}.]$)[\p{L}\p{N}\-"'.,#& ]+$/u;

// A sentinel AbortSignal that never aborts. Helpers that accept an optional caller signal fall back to this so internal code can always address a non-nullable signal,
// without branching for the "no signal supplied" case on every operation. Shared module-scope constant rather than per-call allocation - the underlying platform
// AbortController that produced it is unreferenced after module init, leaving the signal in a permanent unaborted state for the module's lifetime.
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

// Shared no-op reaction used by {@link markHandled} to mark promises as observed. Module-scope constant keeps the identity stable across call sites so attaching the
// reaction is a single function-reference pass rather than a fresh closure allocation per call.
const MARK_HANDLED_NOOP = (): void => { /* Intentionally empty. */ };

// Shared no-op `Disposable` returned by {@link onAbort} on the pre-aborted branch (where no listener was registered and there is nothing to remove). Hoisted to
// module scope so every pre-aborted call reuses one instance instead of allocating a fresh object + arrow pair - matching the established pattern for other shared
// module-scope constants in this file (`NEVER_ABORTED_SIGNAL`, `MARK_HANDLED_NOOP`). Safe to share because the disposer is stateless, idempotent, and side-effect
// free: `[Symbol.dispose]()` can be invoked any number of times from any call site without interference.
const NO_OP_DISPOSABLE: Disposable = { [Symbol.dispose]: (): void => { /* No listener was registered on the pre-aborted path - nothing to remove. */ } };

/**
 * The canonical set of abort reasons used across `homebridge-plugin-utils`.
 *
 * Every long-lived resource class in the library exposes an {@link AbortSignal} whose abort reason is normally an {@link HbpuAbortError} carrying one of these names.
 * Consumers discriminate on the `.name` field. Platform errors produced by `AbortSignal.timeout()` and bare `controller.abort()` interoperate by matching names:
 * `TimeoutError` and `AbortError` from the platform both flow through the same discrimination paths unchanged.
 *
 * @remarks When to use each reason:
 *
 * - `"closed"` - resource ended naturally (process exited with code 0, socket closed by peer, MQTT disconnected cleanly).
 * - `"failed"` - resource ended because of an error (non-zero exit, spawn ENOENT, upstream error). Attach the underlying error via `cause`.
 * - `"replaced"` - a newer operation superseded this one (new stream request, livestream discontinuity, new MQTT subscription overwriting the old handler).
 * - `"shutdown"` - orderly teardown from parent lifecycle (plugin stop, controller close, session end). Default when `abort()` is called with no reason.
 * - `"timeout"` - resource was stuck and exceeded a watchdog window. `AbortSignal.timeout()`'s platform `TimeoutError` carries a matching `.name`.
 *
 * @category Utilities
 */
export type HbpuAbortReason = "closed" | "failed" | "replaced" | "shutdown" | "timeout";

/**
 * Options accepted by {@link HbpuAbortError}'s constructor.
 *
 * @category Utilities
 */
export interface HbpuAbortErrorOptions {

  /**
   * The underlying cause of the abort. For `"failed"` reasons this is typically the upstream error. For `"failed"` exits from child processes, this is idiomatically a
   * structured object carrying diagnostic context (e.g., `{ exitCode, exitSignal }`) - specialized subclasses may tighten this later.
   */
  cause?: unknown;

  /**
   * Optional human-readable message. When omitted, the error's `message` defaults to the reason name, which is sufficient for discrimination-based handling.
   */
  message?: string;
}

/**
 * The canonical abort error used across `homebridge-plugin-utils`.
 *
 * `HbpuAbortError` is a lightweight subclass of `Error` whose `name` field is one of the values in {@link HbpuAbortReason}. It is the value passed to
 * `AbortController.abort(reason)` by every HBPU-owned resource class and is surfaced back to callers as a signal's `reason` or as the rejection of any HBPU-awaited
 * promise that ends because of an abort.
 *
 * @remarks The base class is intentionally minimal. Domain-specific context (FFmpeg exit code, MQTT packet id, etc.) travels on `cause` as a structured object rather
 * than as additional fields on this class, so that every consumer that catches an `HbpuAbortError` reads the same shape. Specialized subclasses (e.g.,
 * `FfmpegAbortError` carrying typed exit context) may be introduced later when there is a concrete need - not preemptively.
 *
 * @example
 *
 * ```ts
 * import { HbpuAbortError, isHbpuAbortReason } from "homebridge-plugin-utils";
 *
 * try {
 *
 *   await recording.segments().next();
 * } catch(error: unknown) {
 *
 *   if(isHbpuAbortReason(error, "replaced")) {
 *
 *     // Stream was superseded; this is expected during a livestream discontinuity.
 *     return;
 *   }
 *
 *   throw error;
 * }
 * ```
 *
 * @category Utilities
 */
export class HbpuAbortError extends Error {

  /**
   * The discriminator. Matches one of {@link HbpuAbortReason}.
   */
  public override readonly name: HbpuAbortReason;

  /**
   * Construct a new `HbpuAbortError`.
   *
   * @param reason    - The abort reason (also assigned to `.name`).
   * @param options   - Optional `cause` for structured diagnostic context, and an optional human-readable `message`.
   */
  public constructor(reason: HbpuAbortReason, options: HbpuAbortErrorOptions = {}) {

    super(options.message ?? reason, { cause: options.cause });
    this.name = reason;
  }
}

/**
 * Type guard: returns `true` if `error` is an {@link HbpuAbortError}.
 *
 * Use this to discriminate HBPU's canonical abort errors from arbitrary thrown values, without nesting `instanceof` checks.
 *
 * @param error - The value to test.
 *
 * @returns `true` if `error` is an `HbpuAbortError` instance.
 *
 * @category Utilities
 */
export function isHbpuAbortError(error: unknown): error is HbpuAbortError {

  return error instanceof HbpuAbortError;
}

/**
 * Convenience type predicate: returns `true` if `error` is an {@link HbpuAbortError} whose `.name` matches `reason`, and narrows the type so callers can read
 * `error.cause` and related fields without further casts.
 *
 * Collapses the common "is this an HBPU abort, and was it this specific reason?" question into a single call, avoiding the `instanceof` + `.name` nesting that appears
 * throughout consuming code. The generic parameter `R` preserves the specific reason string in the narrowed type so callers that discriminate further by name get the
 * literal narrowed form automatically.
 *
 * @typeParam R - The specific reason being matched. Defaulted by inference from `reason`.
 * @param error   - The value to test.
 * @param reason  - The abort reason to match.
 *
 * @returns `true` if `error` is an `HbpuAbortError` with the given reason.
 *
 * @category Utilities
 */
export function isHbpuAbortReason<R extends HbpuAbortReason>(error: unknown, reason: R): error is HbpuAbortError & { name: R } {

  return isHbpuAbortError(error) && (error.name === reason);
}

/**
 * Test whether an abort reason indicates a timeout. Matches both the canonical {@link HbpuAbortError} with `"timeout"` name - produced by project watchdogs
 * ({@link Watchdog}, the inactivity monitors on `FfmpegProcess` / `RtpDemuxer` / `Mp4SegmentAssembler`) - and the platform {@link DOMException}/`Error` whose
 * `.name === "TimeoutError"` - produced by `AbortSignal.timeout()`. Consumers discriminate on a single predicate regardless of which code path originated the timeout.
 *
 * Exists because every long-lived resource class exposes an `isTimedOut` getter with identical branching logic; routing all of them through this single predicate
 * enforces one taxonomy and eliminates drift if the project ever needs to add, say, a third timeout shape (e.g., an upstream-framework cancellation).
 *
 * @param reason - Any value found on `AbortSignal.reason`. Plain objects, non-errors, and `undefined` all return `false`.
 *
 * @returns `true` when the reason is a timeout in either supported shape.
 *
 * @category Utilities
 */
export function isTimeoutReason(reason: unknown): boolean {

  if(isHbpuAbortReason(reason, "timeout")) {

    return true;
  }

  // Platform `TimeoutError` from `AbortSignal.timeout()` - a `DOMException` (extends `Error` in Node) whose `.name === "TimeoutError"`. The `instanceof Error` guard
  // excludes bare objects that happen to carry a coincidental `.name` field.
  return (reason instanceof Error) && (reason.name === "TimeoutError");
}

/**
 * Register a one-shot abort handler on `signal` and return a {@link Disposable} whose `[Symbol.dispose]` removes the listener. If `signal` is already aborted at
 * call time, `handler` runs inline and the returned handle is a no-op disposer.
 *
 * Closes the well-known pitfall in `AbortSignal.addEventListener("abort", ...)`: listeners attached to an already-aborted signal **do not fire**, so constructors
 * that take a parent signal and attach teardown logic via `addEventListener` silently skip that teardown when the parent is pre-aborted. This helper unifies the
 * register-or-dispatch-immediately shape so every caller handles both cases without re-implementing the check.
 *
 * Returning a `Disposable` serves two patterns through one primitive:
 *
 * - **Long-lived resource-class registrations** (the common case): every HBPU resource class registers its `#teardown` handler in its constructor, intending the
 *   listener to live until the composed signal aborts. These callers discard the return value; the `{ once: true }` listener auto-unregisters on fire.
 * - **Scope-bound transient registrations**: observers that only need the listener for a bounded scope (e.g., {@link waitWithSignal}) capture the handle with
 *   `using` so the listener is deterministically removed on scope exit even when the promise resolves before the signal aborts. This prevents listener accumulation
 *   on long-lived signals that see many short waits.
 *
 * The handler runs at most once: on normal abort, via the `{ once: true }` option on `addEventListener`; on pre-aborted signals, via a direct call here. The caller
 * still decides what to do with the rest of its setup - a constructor that wants to short-circuit further initialization after a pre-aborted signal typically pairs
 * this call with a subsequent `if(signal.aborted) return;` check.
 *
 * @param signal  - The abort signal to observe.
 * @param handler - The teardown or cleanup action to run once on abort. Invoked synchronously when `signal.aborted` is already `true` at call time; otherwise
 *                  attached as a one-shot `"abort"` listener.
 *
 * @returns A {@link Disposable} handle. `[Symbol.dispose]` removes the abort listener (no-op on the pre-aborted path and after the listener has already fired).
 *
 * @example
 *
 * ```ts
 * // Long-lived resource-class registration: discard the returned disposer. The listener lives until the composed signal aborts and `{ once: true }` cleans it up.
 * constructor(init: { signal?: AbortSignal }) {
 *
 *   this.signal = composeSignals(init.signal, this.#controller.signal);
 *
 *   onAbort(this.signal, () => this.#teardown());
 *
 *   if(this.signal.aborted) {
 *
 *     return;
 *   }
 *
 *   // ...proceed with setup that only makes sense on a live signal.
 * }
 * ```
 *
 * @example
 *
 * ```ts
 * // Scope-bound transient registration: capture the handle with `using` so the listener auto-removes when the scope exits, even if the signal never aborts.
 * async function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
 *
 *   using _registration = onAbort(signal, () => {
 *     // Abort-driven action goes here.
 *   });
 *
 *   // `return await promise` (not a bare `return promise`) is load-bearing inside an async function. `using` disposes when the enclosing function body finishes
 *   // executing, and without an `await` the body finishes synchronously at the `return` statement - even though the returned promise is still pending. The
 *   // listener would therefore be removed the instant the function returned, well before the promise settles. Adding `await` creates a suspension point that
 *   // keeps the `using` scope alive until the promise actually settles, which is what the "scope-bound registration" pattern relies on.
 *   return await promise;
 * }
 * ```
 *
 * @category Utilities
 */
export function onAbort(signal: AbortSignal, handler: () => void): Disposable {

  if(signal.aborted) {

    handler();

    // Pre-aborted path never registered a listener, so there is nothing to remove. Return the module-scope {@link NO_OP_DISPOSABLE} singleton so the caller's `using`
    // declaration compiles cleanly and explicit `[Symbol.dispose]()` invocations remain a safe no-op, without allocating a fresh object + arrow pair per call.
    return NO_OP_DISPOSABLE;
  }

  signal.addEventListener("abort", handler, { once: true });

  // The returned handle lets scope-bound observers remove themselves deterministically when the scope exits, preventing listener accumulation on long-lived signals
  // that serve many short-lived waits. `removeEventListener` is idempotent - calling it after the listener has already fired (and been auto-removed by `{ once: true }`)
  // is a safe no-op.
  return { [Symbol.dispose]: (): void => signal.removeEventListener("abort", handler) };
}

/**
 * Attach a shared no-op rejection handler to `promise` so that if it rejects and no other observer is attached, Node does not emit an `UnhandledPromiseRejection`
 * warning. Returns the original promise so callers can mark-and-assign in one expression.
 *
 * Use this on internal promise handles (`ready`, `exited`, init segments) that a class exposes for callers who may or may not choose to observe them. Callers who
 * `await` the promise or attach their own `.catch` still see the rejection through their own chain - this helper only marks the promise as observed for Node's
 * unhandled-rejection tracker.
 *
 * @typeParam T  - The resolved value type.
 * @param promise - The promise to mark handled.
 *
 * @returns The same promise, for chained assignment.
 *
 * @example
 *
 * ```ts
 * this.ready = markHandled(readyResolvers.promise);
 * ```
 *
 * @category Utilities
 */
// Identity-preserving helper: returns the caller's promise unchanged so mark-and-assign flows (`this.ready = markHandled(...)`) keep reference equality with the
// underlying resolver. Marking this `async` would wrap the return in a fresh promise chain and break that contract.
export function markHandled<T>(promise: Promise<T>): Promise<T> {

  promise.catch(MARK_HANDLED_NOOP);

  return promise;
}

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

  [P in keyof T]?: T[P] extends (infer I)[] ? DeepPartial<I>[] : DeepPartial<T[P]>
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
 *
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

  readonly [P in keyof T]: T[P] extends (infer I)[] ? DeepReadonly<I>[] : DeepReadonly<T[P]>
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
 * Makes all properties in `T` optional except for those specified by `K`, which remain required.
 *
 * @typeParam T - The base interface or type.
 * @typeParam K - The keys of `T` that should remain required.
 *
 * @example
 *
 * ```ts
 * interface Device {
 *
 *   id: string;
 *   name: string;
 *   mac: string;
 * }
 *
 * type DeviceUpdate = PartialWithId<Device, "id">;
 *
 * // Valid: Only 'id' is required, others are optional.
 * const update: DeviceUpdate = { id: "123" };
 *
 * // Valid: Extra properties can be provided.
 * const another: DeviceUpdate = { id: "456", name: "SomeDevice" };
 *
 * // Error: 'id' is missing.
 * const invalid: DeviceUpdate = { name: "SomeOtherDevice" }; // TypeScript error
 * ```
 *
 * @category Utilities
 */
export type PartialWithId<T, K extends keyof T> = Partial<T> & Pick<T, K>;

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
 * A shippable no-op {@link HomebridgePluginLogging}: every method accepts the logging signature and discards its arguments. A module-scope singleton - the methods are
 * stateless and side-effect-free, so one shared instance is safe to reuse everywhere - which keeps the omitted-logger path allocation-free. This is the SSOT no-op
 * logger: callers that need a CONCRETE logger but want no output default to it (e.g. a subsystem whose lower layer requires a non-optional logger), and the test-only
 * `silentLog` helper derives from it rather than re-declaring the empty sink.
 *
 * @category Utilities
 */
export const noOpLog: HomebridgePluginLogging = {

  debug: (): void => { /* Intentionally empty - the caller opted out of logging. */ },
  error: (): void => { /* Intentionally empty - the caller opted out of logging. */ },
  info: (): void => { /* Intentionally empty - the caller opted out of logging. */ },
  warn: (): void => { /* Intentionally empty - the caller opted out of logging. */ }
};

/**
 * Logger union accepted by FFmpeg subsystem APIs that interoperate with both Homebridge's built-in logger and the plugin-side {@link HomebridgePluginLogging} interface.
 * Provides one alias for sites that need this union, keeping the SSOT discipline applied elsewhere in the package consistent for the logger surface.
 *
 * @category Utilities
 */
export type Logger = HomebridgePluginLogging | Logging;

// Re-export the magnitude-and-percentage formatters from the browser-safe `formatters.ts` module. `featureOptions.ts` imports them directly from there (so it can
// ship into `dist/ui/` without dragging in any of util.ts's Node-only imports); util.ts surfaces them here so server-side consumers see the same public API they
// always did. The single SSOT is `formatters.ts`; this file is just a forwarding seam.
export { formatBps, formatBytes, formatMs, formatPercent, formatSeconds } from "./formatters.ts";

/**
 * Render an arbitrary thrown value as a clean log-suffix string. Real `Error` instances surface their `.message`; everything else is coerced through `String(...)`.
 * A trailing period is stripped in either case so the embedding log line (which itself ends in a period) does not produce ".." at the end of the rendered output.
 *
 * @param error - The thrown value, typically caught from a `try` block or rejected Promise.
 *
 * @returns The cleaned message ready to interpolate into a log format string.
 *
 * @example
 *
 * ```ts
 * try {
 *
 *   await someOperation();
 * } catch(error) {
 *
 *   log.error("Operation failed: %s.", formatErrorMessage(error));
 * }
 * ```
 *
 * @category Utilities
 */
export function formatErrorMessage(error: unknown): string {

  return ((error instanceof Error) ? error.message : String(error)).replace(/\.$/, "");
}

/**
 * The default backoff policy used by {@link retry}: exponential with a 30-second ceiling, starting at 1 second for the second attempt (`attempt = 2`).
 *
 * @param attempt - The attempt number about to be run (1-indexed; never called with `attempt === 1`, since the first attempt runs immediately).
 *
 * @returns The delay, in milliseconds, to wait before executing `attempt`.
 *
 * @category Utilities
 */
export function defaultRetryBackoff(attempt: number): number {

  return Math.min(30_000, 1_000 * (2 ** (attempt - 2)));
}

/**
 * Options accepted by {@link retry}.
 *
 * @category Utilities
 */
export interface RetryOptions {

  /**
   * Total number of attempts, including the first. Must be >= 1. Defaults to 3. Values less than 1 throw synchronously (rejected promise) at the top of `retry()`. Pass
   * `Infinity` for unbounded attempts - the loop then terminates only on success, an abort, or a `shouldRetry` veto, never on an exhausted budget.
   */
  attempts?: number;

  /**
   * Backoff policy, invoked with the attempt number (1-indexed) about to be run. The returned value is the delay in milliseconds before running that attempt. Called
   * only between attempts (i.e., never with `attempt === 1`). Defaults to {@link defaultRetryBackoff} (exponential with a 30-second ceiling).
   */
  backoff?: (attempt: number) => number;

  /**
   * Optional predicate consulted after an attempt throws and attempts remain. Receives the rejected error and the 1-indexed number of the attempt that just failed;
   * return `false` to stop immediately and rethrow that error (no backoff wait, no further attempts), or `true` to retry per the backoff policy. When omitted, every
   * error is retried until `attempts` is exhausted - the existing behavior, unchanged. This is the seam that lets a caller retry some failures and fail fast on others
   * (e.g. retry network faults but give up on an authentication error) without owning the attempt loop itself.
   */
  shouldRetry?: (error: unknown, attemptNumber: number) => boolean;

  /**
   * Optional abort signal. Aborting cancels any in-flight backoff wait and is forwarded verbatim to `operation` as its own signal argument, so well-behaved operations
   * cancel too. An abort at any point - mid-attempt, mid-backoff, or before the first attempt - rejects the outer promise with the signal's reason.
   */
  signal?: AbortSignal;
}

/**
 * Retry an async operation with configurable attempts and backoff, with first-class abort signal support.
 *
 * The operation receives the caller's {@link AbortSignal} directly (or a permanent never-aborted sentinel when no caller signal was provided). Well-behaved operations
 * forward this signal to any cancellation-aware API they call (`fetch`, `events.once`, etc.) so the in-flight attempt actually cancels. Between-attempt waits use
 * `node:timers/promises` `setTimeout` with the signal, so abort also interrupts the backoff.
 *
 * @typeParam T           - The successful resolution type of `operation`.
 * @param operation       - The async work to perform. Receives the composed abort signal; must resolve with a value on success, or throw/reject on failure.
 * @param options         - Retry options. See {@link RetryOptions}.
 *
 * @returns Resolves with the first successful operation result. Rejects with the operation's error once the attempt budget is exhausted or a `shouldRetry` predicate
 * vetoes a further attempt, or with the signal's reason if aborted mid-attempt or mid-backoff.
 *
 * @example
 *
 * ```ts
 * import { retry } from "homebridge-plugin-utils";
 *
 * const controller = new AbortController();
 *
 * const device = await retry(async (signal) => fetchDevice(id, { signal }), {
 *
 *   attempts: 5,
 *   backoff: (attempt) => 1_000 * attempt,
 *   signal: controller.signal
 * });
 * ```
 *
 * @category Utilities
 */
export async function retry<T>(operation: (signal: AbortSignal) => Promise<T>, options: RetryOptions = {}): Promise<T> {

  const { attempts = 3, backoff = defaultRetryBackoff, shouldRetry, signal } = options;

  // Reject nonsensical attempt counts at the library boundary so the "attempts >= 1" invariant the loop relies on is enforced rather than latent.
  if(attempts < 1) {

    throw new Error("retry: `attempts` must be >= 1.");
  }

  // Honor a pre-aborted caller signal immediately - avoids spawning the first attempt just to tear it down.
  signal?.throwIfAborted();

  // When the caller provides no signal, fall back to the module-scope never-aborted sentinel so `operation` always receives a non-nullable `AbortSignal`. Avoids
  // branching inside the hot path each attempt and a per-call controller allocation.
  const operationSignal = signal ?? NEVER_ABORTED_SIGNAL;

  // Run each attempt, yielding to the backoff policy between failures. The caller's signal is the single source of truth for cancellation: the outer catch below is the
  // single normalizer that translates any rejection that coincides with an aborted signal back into `signal.reason`. Each abortable await inside the loop - today the
  // operation and the backoff wait, tomorrow anything we add - inherits that normalization without owing its own check.
  try {

    for(let attempt = 1; attempt <= attempts; attempt++) {

      try {

        // eslint-disable-next-line no-await-in-loop
        return await operation(operationSignal);
      } catch(error: unknown) {

        // Stop and surface the operation's last error when the attempt budget is exhausted, or when `shouldRetry` vetoes another attempt for this error. The budget
        // check comes first so an exhausted budget always rethrows and the predicate is consulted only while attempts remain; a `false` verdict rethrows immediately
        // with no backoff wait. When `shouldRetry` is omitted the optional call yields `undefined` (not `false`), so every error retries until the budget runs out -
        // the existing behavior. If the caller also aborted here, the outer catch normalizes to the signal's reason.
        if((attempt === attempts) || (shouldRetry?.(error, attempt) === false)) {

          throw error;
        }

        // Wait the policy-dictated delay before the next attempt. If the caller aborts mid-wait, `node:timers/promises` `setTimeout` rejects with a platform
        // `AbortError` that does NOT carry `signal.reason`; the outer catch consults the signal itself and restores the caller's reason for us.
        // eslint-disable-next-line no-await-in-loop
        await delay(backoff(attempt + 1), undefined, { signal });
      }
    }

    // Unreachable when `attempts >= 1`: the loop either returns the operation result or rethrows the last attempt's error. TypeScript needs a terminal statement.
    throw new Error("retry: unreachable after attempt loop");
  } catch(error: unknown) {

    // Single source of truth for cancellation. Whatever rejection bubbled out of the loop - operation error, backoff-wait `AbortError`, or anything we add later - if
    // the caller's signal is aborted, the signal's reason is the canonical answer. `throwIfAborted()` is a no-op when the signal is not aborted, so genuine errors
    // propagate unchanged.
    signal?.throwIfAborted();

    throw error;
  }
}

/**
 * Wait for `promise` to settle, bailing out early if `signal` aborts before it does.
 *
 * The canonical primitive for "observe this promise but let a caller cancel the wait." Useful inside async flows that reference an external promise (e.g., a resource
 * class's internal state) and need to honor a per-call abort signal without modifying the underlying promise. Whichever settles first wins: `promise` resolves/rejects
 * normally, or the signal aborts and `waitWithSignal` rejects with `signal.reason` - including when the signal was already aborted at call time.
 *
 * The abort listener is attached with `{ once: true }` and explicitly removed when the helper settles, so there is no listener leak regardless of which side wins the
 * race. `promise` is ALWAYS observed via `.then(resolve, reject)` - including on the pre-aborted-signal path - which means attaching `waitWithSignal` to a promise
 * marks it as handled for Node's unhandled-rejection tracker. Callers do not need to wrap `promise` in {@link markHandled} separately.
 *
 * @typeParam T   - The resolved value type of `promise`.
 * @param promise - The promise to wait on.
 * @param signal  - The abort signal whose firing interrupts the wait.
 *
 * @returns The promise's resolved value.
 *
 * @throws `signal.reason` if the signal aborts before `promise` settles, or the original rejection if `promise` rejects first.
 *
 * @example
 *
 * ```ts
 * import { waitWithSignal } from "homebridge-plugin-utils";
 *
 * try {
 *
 *   const initSegment = await waitWithSignal(assembler.initSegment, callerSignal);
 * } catch {
 *
 *   // Caller aborted, or the assembler rejected init. Either way, unwind cleanly.
 *   return;
 * }
 * ```
 *
 * @category Utilities
 */
export async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {

  const { promise: result, resolve, reject }: PromiseWithResolvers<T> = Promise.withResolvers();

  // `onAbort` is the single source of truth for "register an abort-driven action, handle the pre-aborted-signal pitfall, and release the listener when done." The
  // pre-aborted path runs our handler inline (rejecting `result` immediately); the live path attaches the listener with `{ once: true }` and returns a disposer that
  // we hand off to `using` so the listener is deterministically removed when this function's scope exits. That matters for long-lived signals (e.g., a plugin's
  // lifetime controller) that see many short waits - without explicit removal, each call would leak a listener until the signal finally aborts.
  using _abortRegistration = onAbort(signal, () => reject(signal.reason));

  // `promise` is ALWAYS observed via `.then(resolve, reject)` - including on the pre-aborted path - so `waitWithSignal` marks it handled for Node's unhandled-rejection
  // tracker regardless of which side wins the race. The derived `.then` microtask becomes a no-op if it loses the race (reject was already called via the abort path,
  // or resolve is already settled). The derived promise itself always fulfills (our handlers return void), so discarding it with `void` is safe.
  void promise.then(resolve, reject);

  return await result;
}

/**
 * Drain an async iterable and retain only its last `n` values, returned in original (oldest-to-newest) order.
 *
 * The implementation is a true fixed-capacity ring buffer: it allocates a single backing array of length `n` once and overwrites slots modulo `n` as values arrive, so
 * memory stays bounded at `n` entries no matter how long the source runs. It deliberately does NOT accumulate every value and slice the tail at the end - that naive
 * shape would grow without bound on a long-running source (the canonical use here is "the last ~500 lines of a multi-MB log seed"), defeating the entire point of a
 * bounded retainer. When the source yields `n` or fewer values the result is simply those values in order; when it yields more, only the most recent `n` survive.
 *
 * Consumption is eager and complete: the source is iterated to exhaustion before returning, so callers must only pass iterables that terminate (a finite seed window,
 * not an unbounded live stream). A non-positive `n` retains nothing and returns an empty array without iterating the source at all.
 *
 * @typeParam T  - The element type of the source.
 * @param source - The async iterable to drain. Must terminate.
 * @param n      - The maximum number of trailing values to retain. Values `<= 0` retain nothing.
 *
 * @returns The last `n` values produced by `source`, in original order.
 *
 * @example
 *
 * ```ts
 * import { takeLast } from "homebridge-plugin-utils";
 *
 * // Retain only the most recent 500 seed lines from a bounded history window, regardless of how many the source emits.
 * const recent = await takeLast(seedLines, 500);
 * ```
 *
 * @category Utilities
 */
export async function takeLast<T>(source: AsyncIterable<T>, n: number): Promise<T[]> {

  // A non-positive capacity retains nothing. Returning before touching the source avoids both an empty-ring allocation and any iteration side effects the caller did not
  // ask to pay for.
  if(n <= 0) {

    return [];
  }

  // The single fixed-capacity backing store. We overwrite slots modulo `n` so the ring never grows beyond `n` entries even on an arbitrarily long source - the explicit
  // contrast to an accumulate-then-slice approach that would retain every value transiently.
  const ring: T[] = new Array<T>(n);

  // `count` is the total number of values seen; `write` is the next slot to overwrite. Tracking the raw count (rather than a saturating flag) lets us reconstruct the
  // correct oldest-to-newest order at the end whether the source under- or over-filled the ring.
  let count = 0;
  let write = 0;

  for await (const value of source) {

    ring[write] = value;
    write = (write + 1) % n;
    count++;
  }

  // Under-filled: fewer values than capacity arrived, so the ring's first `count` slots already hold them in order. Slice rather than return the oversized backing array.
  if(count < n) {

    return ring.slice(0, count);
  }

  // Filled or over-filled: the oldest retained value sits at `write` (the slot we were about to overwrite next), so we read forward from there, wrapping once, to
  // recover oldest-to-newest order. This single rotation is the only reordering cost, paid once at the end rather than per value.
  const result: T[] = new Array<T>(n);

  for(let index = 0; index < n; index++) {

    // The cast is sound here: when `count >= n` every ring slot has been written at least once, so no slot is the initial `undefined` hole `noUncheckedIndexedAccess`
    // guards against. We narrow the `T | undefined` index read back to `T` with one cast rather than re-checking a value we have already proven present.
    result[index] = ring[(write + index) % n] as T;
  }

  return result;
}

/**
 * Compose one or more optional {@link AbortSignal} sources into a single signal that aborts when any input aborts.
 *
 * Collapses the recurring `parent ? AbortSignal.any([ parent, internal ]) : internal` pattern that every resource class in this library used to hand-roll. Filters out
 * `undefined` inputs, returns the sole defined signal unchanged (no unnecessary `any()` wrapper), and composes two or more defined signals with `AbortSignal.any()`.
 * Throws a {@link TypeError} when every input is `undefined`, because a class whose lifetime is defined by a signal must always have at least one concrete signal to
 * compose against.
 *
 * @param signals - Ordered list of signal sources. `undefined` entries are filtered out; order is preserved among defined entries.
 *
 * @returns The single defined signal when only one was supplied; otherwise a new signal that aborts as soon as any input aborts, carrying the first aborting input's
 *          reason as its own `reason`.
 *
 * @throws `TypeError` if every input is `undefined` - the caller passed no concrete signal to compose.
 *
 * @example
 *
 * ```ts
 * // Class constructor composing an optional parent signal with the internal controller's signal.
 * this.signal = composeSignals(init.signal, this.#controller.signal);
 *
 * // Per-call composition of the class signal with a caller-supplied per-call signal.
 * const composed = composeSignals(this.signal, init.signal);
 *
 * // Compose an optional caller signal with a derived watchdog timeout.
 * const composed = composeSignals(init.signal, AbortSignal.timeout(PROBE_DEFAULT_TIMEOUT_MS));
 * ```
 *
 * @category Utilities
 */
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {

  const defined = signals.filter((signal) => signal !== undefined);
  const [ first, ...rest ] = defined;

  // At least one concrete signal is required. A class whose lifetime is expressed by a signal cannot exist without one; surfacing the misuse at the boundary catches
  // the mistake loudly rather than silently producing a signal that can never abort.
  if(first === undefined) {

    throw new TypeError("composeSignals: at least one signal must be provided.");
  }

  // Short-circuit when only one signal was defined. Wrapping a single signal in `AbortSignal.any([ ... ])` would allocate a derived signal with no behavioral benefit,
  // so we return the input unchanged. Preserves reference equality for callers who compare against the input.
  if(rest.length === 0) {

    return first;
  }

  return AbortSignal.any(defined);
}

/**
 * Supervise a detached, signal-bound async loop: run the loop, resolve quietly when it ends or its signal aborts, and route any genuine fault to a caller-supplied
 * handler exactly once.
 *
 * Resilient background loops - membership observers, reachability probes, telemetry firehoses - all share one subtle, correctness-critical invariant: a throw is a
 * *fault* only when we did not cause it. When the bound signal is aborted, a throw is the orderly unwinding of a loop the caller already tore down, so it is swallowed
 * silently. Any other throw is a genuine fault and is handed to `onError` exactly once. Hand-copying that swallow-on-abort-versus-surface-once discrimination across
 * call sites that share no ancestor is how it drifts apart; owning it in one generic primitive is how it stays consistent.
 *
 * The home is here, beside {@link composeSignals}, because the envelope is fully generic - it carries no logging policy, no message wording, and makes no detachment
 * decision of its own. When the loops to supervise live on objects with no common base class (so the shared logic cannot be a method), this free function is the only
 * shared home. The returned promise NEVER rejects as a consequence of the loop: it resolves when the loop returns (a finite source ending), when the signal aborts
 * (orderly teardown, swallowed), or once a genuine fault has been delivered to `onError`. The caller owns the rest - `void` the result to fire-and-forget a detached
 * loop, or `await` it for orderly shutdown and in tests.
 *
 * @param options          - Supervision inputs.
 * @param options.loop     - The loop to run, once. It receives the bound {@link AbortSignal} so it can wire cancellation into `observe()` / `fetch()` / stream reads.
 * @param options.onError  - Invoked at most once, with the thrown value unchanged, when the loop faults while the signal is NOT aborted. It carries the caller's entire
 *                           fault policy (logging, wording, recovery), which is why the primitive itself stays logging-free. A throw from `onError` is a defect in the
 *                           handler and propagates - the never-rejects guarantee covers the loop, not the handler.
 * @param options.signal   - The signal the loop is bound to. Its aborted state is the single source of truth for "did we cause this throw?": aborted means swallow,
 *                           not aborted means surface.
 *
 * @returns A promise that resolves when the loop ends, the signal aborts, or a fault has been delivered to `onError`. It does not reject for any of those outcomes.
 *
 * @example
 *
 * ```ts
 * import { superviseLoop } from "homebridge-plugin-utils";
 *
 * // Fire-and-forget a detached observer that survives transient faults until its controller is torn down. Aborting `this.signal` unwinds the loop silently; any other
 * // failure is surfaced once through the caller's own wording.
 * void superviseLoop({
 *
 *   loop: async (signal) => {
 *
 *     for await (const event of client.observe(selector, { signal })) {
 *
 *       this.handle(event);
 *     }
 *   },
 *   onError: (error) => this.log.error("The membership observer stopped unexpectedly and will not restart until the next reload: %s", formatErrorMessage(error)),
 *   signal: this.signal
 * });
 * ```
 *
 * @category Utilities
 */
export async function superviseLoop(options: { loop: (signal: AbortSignal) => Promise<void>; onError: (error: unknown) => void; signal: AbortSignal }): Promise<void> {

  const { loop, onError, signal } = options;

  // Run the loop bound to its signal. The loop forwards `signal` into whatever cancellable work it drives, so tearing the signal down unwinds the loop from the inside.
  try {

    await loop(signal);
  } catch(error: unknown) {

    // The one invariant this primitive centralizes: discriminate orderly teardown from a genuine fault. An aborted signal means this throw is the loop unwinding in
    // response to a teardown we initiated, so it is expected and is swallowed silently. Otherwise the loop faulted on its own, and we surface it through `onError`
    // exactly once. Either branch resolves the returned promise rather than rejecting it, so a detached caller never produces an unhandled rejection.
    if(signal.aborted) {

      return;
    }

    onError(error);
  }
}

/**
 * Build the standard {@link superviseLoop} `onError` handler: a reporter that logs a faulted supervised loop with one canonical message, rendering the thrown value
 * through {@link formatErrorMessage}.
 *
 * `superviseLoop` is deliberately logging-free - it owns the swallow-on-abort-versus-surface-once control flow and nothing else, so the wording of what to say when a
 * loop dies lives here, in an explicitly logging companion, never in the primitive itself. Plugins that supervise the same shape of loop - a client observe-loop bound
 * to a terminal shutdown signal with no auto-respawn - all owe the operator the same report: the fault is terminal until the next restart, so the message says exactly
 * that and hands over the one actionable hint. Single-sourcing the template and the formatting here keeps that report from being hand-copied (and quietly drifting)
 * across plugins that share no ancestor - the same "no shared home, so a free function is the home" situation {@link superviseLoop} itself answers.
 *
 * The wording is specific to that bound-to-shutdown, no-respawn lifecycle. A consumer whose loops recover on their own - reconnecting, re-arming, respawning - has
 * different news to deliver and should pass its own `onError` to {@link superviseLoop} rather than this reporter.
 *
 * @param log   - The plugin logger the report is written to; its `error` method receives the canonical format string and arguments.
 * @param label - The loop's name, interpolated as the `%s` in `"HomeKit updates for %s ..."` so anyone reading the log can tell which supervised loop died.
 *
 * @returns The `(error) => void` handler to hand to {@link superviseLoop}'s `onError`. It logs exactly once per fault and returns nothing.
 *
 * @example
 *
 * ```ts
 * import { loopFaultReporter, superviseLoop } from "homebridge-plugin-utils";
 *
 * // The standard supervised observer: swallow on shutdown, and on a genuine fault log the canonical "<label> loop died, restart to recover" report exactly once.
 * void superviseLoop({
 *
 *   loop: (signal) => this.observeMembership(signal),
 *   onError: loopFaultReporter(this.log, "membership"),
 *   signal: this.signal
 * });
 * ```
 *
 * @category Utilities
 */
export function loopFaultReporter(log: HomebridgePluginLogging, label: string): (error: unknown) => void {

  // Return the closure that *is* the `onError`: it logs the one canonical "supervised loop died" line, deferring error rendering to `formatErrorMessage` so the trailing
  // period is normalized to one and the wording matches every other error log in the package rather than being re-derived at this call site.
  return (error: unknown): void => log.error("HomeKit updates for %s stopped unexpectedly and will not resume until the Homebridge plugin restarts: %s.", label,
    formatErrorMessage(error));
}

/**
 * Options for {@link runWithAbort}. At least one of `signal` or `timeout` must be provided so there is always an abort mechanism. TypeScript enforces this at compile
 * time through a discriminated union - the "no abort mechanism" case is unrepresentable.
 *
 * @category Utilities
 */
export type RunWithAbortOptions = { signal: AbortSignal; timeout?: number } | { timeout: number };

/**
 * Run an abortable operation with signal-based cancellation.
 *
 * The caller provides a factory function that receives an {@link AbortSignal}. The signal fires when the timeout expires, when the caller's own signal aborts, or
 * whichever comes first when both are provided. The factory must forward this signal to any API that accepts one (`events.once`, `fetch`, Node stream methods, etc.) so
 * the underlying work is actually cancelled. When the signal fires and the factory rejects, the rejection is caught and `null` is returned. Genuine (non-abort) errors
 * from the factory propagate normally.
 *
 * @typeParam T           - The type of value the factory's promise resolves with.
 * @param fn              - A factory that receives the composed abort signal and returns the promise to await.
 * @param options         - Abort options. Provide `timeout` (milliseconds), an external `signal`, or both.
 *
 * @returns Resolves with the factory's result if it completes before abort, or `null` if the signal fires first.
 *
 * @example
 * ```ts
 * // Timeout only - cancel after 500ms.
 * const result = await runWithAbort((signal) => fetch(url, { signal }), { timeout: 500 });
 *
 * // External signal only - cancel on demand.
 * const controller = new AbortController();
 * const result2 = await runWithAbort((signal) => once(emitter, "data", { signal }), { signal: controller.signal });
 * controller.abort();
 *
 * // Both - cancel on demand or after 5 seconds, whichever comes first.
 * const result3 = await runWithAbort((signal) => once(emitter, "data", { signal }), { signal: controller.signal, timeout: 5000 });
 * ```
 *
 * @category Utilities
 */
export async function runWithAbort<T>(fn: (signal: AbortSignal) => Promise<T>, options: RunWithAbortOptions): Promise<Nullable<T>> {

  // Route through `composeSignals` so this helper uses the same signal-composition primitive every other HBPU resource class uses. The discriminated union
  // guarantees at least one of `signal` / `timeout` is defined, which means `composeSignals` always receives at least one concrete signal and never throws its
  // empty-input guard. When only a timeout is supplied, `composeSignals` returns that single timeout signal unwrapped (no needless `AbortSignal.any` allocation).
  const callerSignal = ("signal" in options) ? options.signal : undefined;
  const timeoutSignal = (options.timeout !== undefined) ? AbortSignal.timeout(options.timeout) : undefined;
  const signal = composeSignals(callerSignal, timeoutSignal);

  // If the signal is already aborted, return immediately without starting any work.
  if(signal.aborted) {

    return null;
  }

  // Run the factory and let the signal handle cancellation. We check `signal.aborted` rather than inspecting the error type because the signal is the source of truth
  // for cancellation state...the exception type varies by API and abort reason (AbortError from manual abort, TimeoutError from AbortSignal.timeout(), or any custom
  // reason). Genuine errors that occur before the signal fires propagate normally.
  try {

    return await fn(signal);
  } catch(error: unknown) {

    // The signal's aborted state changes asynchronously while the factory is running...the early-out check above doesn't constrain this.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(signal.aborted) {

      return null;
    }

    throw error;
  }
}

/**
 * Construction-time options for {@link Watchdog}.
 *
 * @property onFire    - Callback invoked when the watchdog window lapses without a re-arm. Typically aborts an owning controller (`() => this.#controller.abort(new
 *                       HbpuAbortError("timeout"))`) but the watchdog itself is agnostic about what the fire does. Runs only when the observed signal has not already
 *                       aborted; if the signal fires before the timer, `onFire` is skipped entirely.
 * @property signal    - The lifetime signal the watchdog observes. When the signal aborts for any reason the pending timer is cleared and no further arms take effect.
 *                       Typically the consumer's composed lifetime signal (`this.signal`) so both parent-initiated and internal aborts wind the watchdog down.
 * @property timeoutMs - Inactivity window in milliseconds. The first `arm()` schedules a fire at now + `timeoutMs`; each subsequent `arm()` restarts the clock.
 *
 * @category Utilities
 */
export interface WatchdogInit {

  onFire: () => void;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * Re-armable inactivity watchdog.
 *
 * The watchdog captures the shared "abort if no activity within window" pattern used by every long-lived resource class in this library that cares about liveness: an
 * FFmpeg stream's return-port UDP socket, the fMP4 segment assembler's inter-segment pacing, the RTP demuxer's inbound-packet cadence. Each of those used to carry its
 * own bespoke `setTimeout` / `clearTimeout` dance paired with an `aborted` guard. They now compose a single `Watchdog` instance instead.
 *
 * The semantics are minimal on purpose:
 *
 *   - `arm()` starts the window. If a previous arm is still pending, it is replaced; if the observed signal has already aborted or the watchdog has been disposed, the
 *     call is a no-op.
 *   - If nothing calls `arm()` again within `timeoutMs`, `onFire` runs - but only if the signal is still unaborted at that instant, so a last-moment concurrent abort
 *     wins the race and the callback is skipped.
 *   - When the observed signal aborts for any reason, the watchdog self-cleans its pending timer; the consumer never needs to unwire it at teardown.
 *   - `clear()` cancels any pending fire without aborting anything and leaves the watchdog re-armable.
 *   - `[Symbol.dispose]` clears the pending fire and marks the watchdog permanently dead: subsequent `arm()` calls are no-ops. This matches the scope-bound semantics
 *     callers expect from `using` - the resource is dead when the block exits, not merely quiescent.
 *
 * This is a `Disposable` (synchronous) rather than `AsyncDisposable` because cancelling a timer is synchronous; there is no background work to await.
 *
 * @example
 *
 * ```ts
 * using watchdog = new Watchdog({
 *
 *   onFire: () => this.#controller.abort(new HbpuAbortError("timeout")),
 *   signal: this.signal,
 *   timeoutMs: this.#inactivityWindowMs
 * });
 *
 * // Each time a packet / segment / message arrives, re-arm so the fire never fires.
 * this.#source.on("data", () => watchdog.arm());
 * watchdog.arm();
 * ```
 *
 * @category Utilities
 */
export class Watchdog implements Disposable {

  readonly #onFire: () => void;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  #timer: NodeJS.Timeout | undefined;

  // Set to `true` exactly once when `[Symbol.dispose]` runs. Tracks "caller is done with this watchdog" as a distinct concept from "the observed signal aborted" - the
  // latter can happen without disposal (normal lifetime end), and disposal can happen without signal abort (scope-bound `using` inside a longer-lived context). Both
  // paths converge on the same observable behavior: `arm()` becomes a no-op.
  #disposed = false;

  /**
   * Construct a new watchdog. The watchdog is dormant until the first `arm()` call, so construction itself schedules no timers.
   *
   * A cleanup handler is registered on `init.signal` through {@link onAbort} so the watchdog auto-cleans when the lifetime signal aborts - consumers do not need to
   * wire teardown manually. On a pre-aborted signal `onAbort` runs the cleanup inline; `clear()` is a no-op on a freshly-constructed watchdog (no timer has been
   * armed yet), so the pre-aborted path unwinds harmlessly. A later `arm()` short-circuits on the same aborted check, so no timer is ever scheduled either way.
   *
   * @param init - Required init options. See {@link WatchdogInit}.
   */
  public constructor(init: WatchdogInit) {

    this.#onFire = init.onFire;
    this.#signal = init.signal;
    this.#timeoutMs = init.timeoutMs;

    // Self-cleaning via the unified `onAbort` primitive: a pending timer after signal abort would only fire, see the aborted guard, and no-op. Clearing proactively
    // keeps active-timer counts accurate across short-lived watchdogs and lets the event loop exit promptly in tests that hold no other references. This is a long-
    // lived registration - the returned disposer is discarded because the listener is intended to live until the signal fires, and `onAbort`'s `{ once: true }` auto-
    // removes it on fire.
    onAbort(this.#signal, () => this.clear());
  }

  /**
   * Start or restart the inactivity window. The pending timer (if any) is cancelled and a fresh one is scheduled for `timeoutMs` in the future. A no-op when the
   * observed signal has already aborted or the watchdog has been disposed - in either state there is nothing live to protect, and scheduling a timer would violate the
   * `using` contract callers rely on.
   */
  public arm(): void {

    if(this.#disposed || this.#signal.aborted) {

      return;
    }

    if(this.#timer !== undefined) {

      clearTimeout(this.#timer);
    }

    this.#timer = setTimeout(() => {

      // Null the handle first so a re-entrant `clear()` inside `onFire` is a cheap no-op and so observers inspecting `#timer` post-fire see the correct state.
      this.#timer = undefined;

      // Lose a tight race against a concurrent abort cleanly: if the signal fired between timer scheduling and the callback running, the aborted state already
      // expresses the outcome and `onFire` is redundant at best, double-teardown at worst. Disposal sets the same invariant through a different gate.
      if(this.#disposed || this.#signal.aborted) {

        return;
      }

      this.#onFire();
    }, this.#timeoutMs);
  }

  /**
   * Cancel any pending fire without aborting anything and without marking the watchdog as permanently dead. Subsequent `arm()` calls continue to work. Safe to call
   * when no arm is pending - the method is idempotent.
   */
  public clear(): void {

    if(this.#timer !== undefined) {

      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * `Disposable` implementation. Clears any pending fire AND permanently disables the watchdog: after this runs, `arm()` is a no-op and no further `onFire` calls can
   * occur. This is the contract `using watchdog = new Watchdog(...)` relies on - the resource is dead when the block exits, not merely quiescent. Idempotent; repeated
   * disposal is a no-op. Because the class does not own an abort controller, disposal does not signal anything to the rest of the system.
   */
  public [Symbol.dispose](): void {

    this.#disposed = true;
    this.clear();
  }
}

/**
 * Start case a string, capitalizing the first letter of each word unconditionally.
 *
 * @param input - The string to start case.
 *
 * @returns Returns the start cased string.
 *
 * @example
 *
 * ```ts
 * toStartCase("this is a test");
 * ```
 *
 * Returns: `This Is A Test`.
 *
 * @category Utilities
 */
export function toStartCase(input: string): string {

  return input.replace(/(^\w|\s+\w)/g, match => match.toUpperCase());
}

/**
 * Sanitize an accessory name according to HomeKit naming conventions.
 *
 * @param name - The name to validate.
 *
 * @returns Returns the HomeKit-sanitized version of the name, replacing invalid characters with a space and squashing multiple spaces.
 *
 * @remarks This sanitizes names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
 * and HAP specification documentation:
 *
 * - Starts and ends with a letter or number. Exception: may end with a period.
 * - May have the following special characters: -"',.#&.
 * - Must not include emojis.
 *
 * @example
 * ```ts
 * sanitizeName("Test|Switch")
 * ```
 *
 * Returns: `Test Switch`, replacing the pipe (an invalid character in HomeKit's naming ruleset) with a space.
 *
 * @category Utilities
 */
export function sanitizeName(name: string): string {

  // Fast path: if the name already conforms to HomeKit's naming rules, skip the replacement chain entirely.
  if(validateName(name)) {

    return name;
  }

  // Here are the steps we're taking to sanitize names for HomeKit:
  //
  //   - Replace any disallowed char (including emojis) with a space.
  //   - Collapse multiple spaces to one.
  //   - Trim spaces at the beginning and end of the string.
  //   - Strip any leading non-letter/number.
  //   - Collapse two or more trailing periods into one.
  //   - Remove any other trailing char that's not letter/number/period.
  return name.replace(/[^\p{L}\p{N}\-"'.,#&\s]/gu, " ").replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}]+/u, "").replace(/\.{2,}$/g, ".").
    replace(/[^\p{L}\p{N}.]$/u, "");
}

/**
 * Validate an accessory name according to HomeKit naming conventions.
 *
 * @param name - The name to validate.
 *
 * @returns Returns `true` if the name passes HomeKit's naming rules, `false` otherwise.
 *
 * @remarks This validates names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
 * and HAP specification documentation:
 *
 * - Starts and ends with a letter or number. Exception: may end with a period.
 * - May not have multiple spaces adjacent to each other, nor begin nor end with a space.
 * - May have the following special characters: -"',.#&.
 * - Must not include emojis.
 *
 * @example
 * ```ts
 * validateName("Test|Switch")
 * ```
 *
 * Returns: `false`.
 *
 * @category Utilities
 */
export function validateName(name: string): boolean {

  return VALID_HOMEKIT_NAME.test(name);
}
