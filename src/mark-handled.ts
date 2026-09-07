/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mark-handled.ts: The identity-preserving handled mark for a promise a caller may never observe.
 */

/**
 * **Why this file exists.** The webUI ships into `dist/ui/` for the browser to load (via the browser-module copy step), and the promises it memoizes for the life of
 * a page - the theming registration, the catalog read - need the same handled mark the library's own promise handles use. Pulling that mark from `util.ts` would
 * drag in `util.ts`'s Node-only dependency graph, which the browser cannot resolve. This module is the SSOT for the mark. It has zero runtime imports of any kind,
 * so shipping it alongside the browser's other modules is safe in any runtime that can execute ES2024+ JavaScript.
 *
 * **Consumers.** `util.ts` re-exports {@link markHandled} for the server-side surface, so a Node consumer reaches it through the same public API as the rest of the
 * utilities; the webUI imports directly from here to keep its browser-runnable dependency graph free of `util.ts`. Both consumers share one implementation - the
 * file is the join point.
 *
 * @module
 */

// Shared no-op reaction used by {@link markHandled} to mark promises as observed. Module-scope constant keeps the identity stable across call sites so attaching the
// reaction is a single function-reference pass rather than a fresh closure allocation per call.
const MARK_HANDLED_NOOP = (): void => { /* Intentionally empty. */ };

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
