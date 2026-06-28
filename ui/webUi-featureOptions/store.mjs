/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/store.mjs: Reactive state primitive for the feature options webUI.
 */
"use strict";

// Capture the platform's CustomEvent constructor at module load. `extends EventTarget` below resolves at the same moment - both come from the same DOM
// implementation, so the dispatched event matches the EventTarget's expected event family. Without this capture, a test environment that swaps `globalThis.CustomEvent`
// to a different implementation after module load would dispatch events that the originally-resolved EventTarget rejects (silently or throwing); pinning both at
// the same load timestamp keeps the implementation family coherent.
const ModuleCustomEvent = CustomEvent;

/**
 * FeatureOptionsStore - The event-emitting state container at the heart of the feature options webUI.
 *
 * Architectural contract:
 *
 *   - **One source of truth.** A single state object replaces ad-hoc cross-component synchronization. Components do not hold parallel state; they subscribe to the
 *     store and re-derive their view from {@link state} on dispatch.
 *   - **Unidirectional flow.** Mutations enter through {@link dispatch}, which feeds the action to the pure reducer and atomically replaces the state. The store
 *     then fires a {@link CustomEvent} naming the action's type, with the full action as `event.detail` so subscribers receive the payload without reaching back
 *     into the store for "what changed."
 *   - **Platform-native subscription.** The class extends {@link EventTarget} so subscribers register via the standard `addEventListener({ signal })` idiom -
 *     cleanup follows the caller's {@link AbortSignal} automatically, no `destroy()` ceremony required. The signal-keyed lifecycle is the same primitive every
 *     other part of the webUI already uses for its DOM listeners, so the store's subscription model integrates without a new lifecycle concept.
 *   - **Read-then-dispatch ordering.** The reducer applies before the event fires, so a subscriber reading `store.state` from inside its handler always sees the
 *     post-dispatch state. The ordering is load-bearing: views that re-derive their DOM in response to an event must see the new state, not the pre-mutation
 *     state that triggered the dispatch.
 *
 * The store carries no domain logic itself - the reducer (passed at construction) and the action vocabulary (consumed by subscribers) are the application-specific
 * surface. The store is the platform-shaped wire between them.
 */
export class FeatureOptionsStore extends EventTarget {

  #reducer;
  #state;

  /**
   * Create a new store seeded with initial state and a reducer.
   *
   * @param {Object} args
   * @param {Object} args.initialState - The starting state. Treated as the first value of the immutable state sequence; subsequent values come from the reducer.
   * @param {(state: Object, action: { type: string }) => Object} args.reducer - Pure (state, action) => state function. Should be an exhaustive switch on
   *                                                                              `action.type` so adding a new action type forces a corresponding reducer case.
   */
  constructor({ initialState, reducer }) {

    super();
    this.#reducer = reducer;
    this.#state = initialState;
  }

  /**
   * Read the current state. Returned by reference - callers MUST treat the result as readonly. The reducer's structural-sharing contract guarantees that unchanged
   * slices retain their reference across dispatches, so subscribers can use reference equality (`===`) to detect what changed without a deep comparison.
   *
   * @returns {Object} The current state.
   */
  get state() {

    return this.#state;
  }

  /**
   * Apply an action through the reducer and notify subscribers.
   *
   * Sequence:
   *
   *   1. The reducer is invoked with the current state and the action; its return value becomes the new state.
   *   2. A {@link CustomEvent} named after `action.type` is dispatched on the store, with the full action as `event.detail`.
   *
   * The state replacement happens BEFORE the event dispatches, so subscribers reading `store.state` from inside their handler see the post-dispatch state. Reversing
   * this order would force subscribers to either read from `event.detail` only (losing access to other state slices the dispatch did not touch) or to compute their
   * view from stale state (a correctness hazard). The current order is the only one that satisfies "subscribers see consistent state every time they read."
   *
   * @param {{ type: string }} action - The action to dispatch. Must carry a string `type` field naming a past-tense domain event. Additional payload fields are
   *                                    forwarded verbatim as `event.detail` to subscribers.
   */
  dispatch(action) {

    this.#state = this.#reducer(this.#state, action);
    this.dispatchEvent(new ModuleCustomEvent(action.type, { detail: action }));
  }
}

/**
 * Subscribe a function to a set of action types on a store, with automatic teardown.
 *
 * Two phases:
 *
 *   1. **Immediate run.** The function is invoked once synchronously at registration so the caller's initial view derives from the current state without waiting
 *      for a dispatch. This eliminates the "render on mount AND on every event" boilerplate every subscriber would otherwise repeat. {@link fn} receives
 *      `undefined` for the action argument at the immediate run - the marker for "no triggering action."
 *   2. **Subscription.** The function is registered as a listener for every event type in `events`. Every subsequent {@link FeatureOptionsStore.dispatch} of a
 *      listed type fires the function with the action as its argument (extracted from the {@link CustomEvent}'s `detail`). Cleanup is automatic: when the
 *      supplied {@link AbortSignal} aborts, every registered listener is removed in one operation.
 *
 * A pre-aborted signal short-circuits the entire effect: neither the immediate run nor the subscription registration takes effect. This protects views that
 * subscribed during a mount sequence from running against a torn-down DOM when an abort races the mount.
 *
 * The handler receives the action as its argument so subscribers that care about the dispatched payload can read it directly; subscribers that only need the
 * post-mutation state ignore the argument and read `store.state` as usual. JavaScript's parameter semantics mean a handler declared as `() => void` silently
 * ignores the action, so consumers pay no cost for the extra capability. Action-aware consumers declare `(action) => void` (or `(action) => { if(action) ... }`
 * to gate on subscription-only logic) without needing a parallel API.
 *
 * @param {Object} args
 * @param {readonly string[]} args.events - The action types this effect subscribes to.
 * @param {(action?: { type: string }) => void} args.fn - The effect body. Runs once immediately with `action === undefined`, then on every dispatch of a listed
 *                                                        action type with the dispatched action as its argument.
 * @param {AbortSignal} args.signal - The lifecycle signal. Every listener registered by this effect is bound to this signal and cleaned up on abort.
 * @param {FeatureOptionsStore} args.store - The store to subscribe against.
 */
export const effect = ({ events, fn, signal, store }) => {

  // Respect a pre-aborted signal. Without this short-circuit, a mount sequence that races against an abort can land the immediate-run pass on a torn-down DOM.
  // The subscription registrations after this point would be no-ops anyway (addEventListener with an aborted signal silently skips), but the immediate-run pass
  // can have side effects that need to be skipped.
  if(signal.aborted) {

    return;
  }

  fn(undefined);

  // One wrapper closure shared across every listener registration extracts the action from the event's detail and hands it to the handler. Centralizing the
  // extraction here means each handler sees the same "action or undefined" contract regardless of which event type triggered it, and the addEventListener
  // registrations themselves stay symmetric.
  const dispatch = (event) => fn(event.detail);

  for(const type of events) {

    store.addEventListener(type, dispatch, { signal });
  }
};

/**
 * Memoize a pure selector over a set of state slices.
 *
 * Pattern: the caller provides `compute(state)` (the derivation) and an array of `slices` (functions that pull cache-key inputs from state). On each call, the
 * memoized selector re-runs the slice accessors and compares their results to the previous call's; if every slice returns the same reference (or primitive value)
 * as before, the cached result is returned. Otherwise `compute` runs against the current state, and the new result is cached for next time.
 *
 * Reference equality is the cache key, which matches the structural-sharing contract the reducer follows: unchanged slices retain their reference across
 * dispatches, so selectors that depend on them return cached results without recomputation. A selector that reads `state.scope` and `state.filter` is
 * automatically cached across any dispatch that does not modify those slices, regardless of whether the dispatch touched some other unrelated slice.
 *
 * Single shared helper for every memoized selector. The alternative - hand-rolling closure-cached selectors at each site - duplicates the memoization shape and
 * makes the cache key less discoverable. Using this helper means every memoized selector reads as "what does it compute" + "what does it depend on," with the
 * machinery factored out.
 *
 * @param {Object} args
 * @param {(state: Object) => unknown} args.compute - The pure derivation. Invoked when any slice's reference changes; the result is cached until the next change.
 * @param {readonly ((state: Object) => unknown)[]} args.slices - The state-slice accessors. Their return values are compared by `===` against the previous call's.
 *                                                                 Order matters - the comparison is positional.
 * @returns {(state: Object) => unknown} The memoized selector. Call it with the current state to read the derivation.
 */
export const memoize = ({ compute, slices }) => {

  // The cache's "no value yet" state is encoded by `lastKeys === null`. Once the selector has run once, lastKeys is a non-null array (possibly empty when the
  // selector takes no slices) and the comparison branch can proceed unconditionally. Two closure variables instead of a wrapper object - one fewer level of
  // indirection on every cache check, which matters because cache-hit is the hot path for every selector called per dispatch.
  let lastKeys = null;
  let lastResult;

  return (state) => {

    const keys = slices.map((slice) => slice(state));

    // Cache hit when every slice returns a value identical to its prior return. `Array.every` short-circuits on the first mismatch so the comparison cost is
    // bounded by "how many slices match before one diverges," not by the slice count.
    if(lastKeys && (keys.length === lastKeys.length) && keys.every((k, i) => k === lastKeys[i])) {

      return lastResult;
    }

    lastKeys = keys;
    lastResult = compute(state);

    return lastResult;
  };
};
