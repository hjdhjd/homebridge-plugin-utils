/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/store.test.mjs: Unit tests for the reactive state primitive.
 */
"use strict";

import { FeatureOptionsStore, effect, memoize } from "./store.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// A trivial reducer for tests that do not exercise reducer logic itself - returns the new state from the action's `nextState` field if present, otherwise returns
// the state unchanged. Keeps individual tests focused on the store/effect/memoize behavior under examination rather than reducer correctness.
const passThroughReducer = (state, action) => action.nextState ?? state;

describe("FeatureOptionsStore", () => {

  test("constructor seeds the store with the supplied initial state", () => {

    const store = new FeatureOptionsStore({ initialState: { count: 0 }, reducer: passThroughReducer });

    assert.deepEqual(store.state, { count: 0 });
  });

  test("dispatch applies the reducer and replaces the state with its return value", () => {

    const reducer = (state, action) => {

      switch(action.type) {

        case "increment":

          return { count: state.count + 1 };

        default:

          return state;
      }
    };

    const store = new FeatureOptionsStore({ initialState: { count: 0 }, reducer });

    store.dispatch({ type: "increment" });

    assert.equal(store.state.count, 1);

    store.dispatch({ type: "increment" });

    assert.equal(store.state.count, 2);
  });

  test("dispatch fires a CustomEvent named after action.type with the action as event.detail", () => {

    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    const received = [];

    store.addEventListener("test:action", (event) => received.push(event.detail));

    store.dispatch({ payload: 42, type: "test:action" });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { payload: 42, type: "test:action" });
  });

  test("subscribers reading store.state inside a handler see the post-dispatch state, not the pre-dispatch state", () => {

    const reducer = (state, action) => ({ ...state, value: action.value });
    const store = new FeatureOptionsStore({ initialState: { value: "initial" }, reducer });
    const observed = [];

    store.addEventListener("set", () => observed.push(store.state.value));

    store.dispatch({ type: "set", value: "first" });
    store.dispatch({ type: "set", value: "second" });

    assert.deepEqual(observed, [ "first", "second" ], "handler reads must see the post-dispatch state every time, never the pre-dispatch state");
  });

  test("state getter returns the current state reference - reducer-produced fresh state replaces it on dispatch", () => {

    const reducer = (_state, action) => action.nextState;
    const initial = { count: 0 };
    const next = { count: 1 };
    const store = new FeatureOptionsStore({ initialState: initial, reducer });

    assert.equal(store.state, initial, "pre-dispatch state reference is the initial value");

    store.dispatch({ nextState: next, type: "replace" });

    assert.equal(store.state, next, "post-dispatch state reference is the reducer's return value");
  });

  test("a dispatched event carries the state the reducer replaced, so a second dispatch reports the first dispatch's own result", () => {

    // The seed and the first dispatch's result are deep-equal on purpose: a subscriber comparing by structure could not tell them apart, so asserting identity
    // here is what proves the capture happens before the reducer runs rather than after it.
    const initial = { count: 0 };
    const first = { count: 0 };
    const second = { count: 1 };
    const store = new FeatureOptionsStore({ initialState: initial, reducer: (_state, action) => action.nextState });
    const seen = [];

    store.addEventListener("replace", (event) => seen.push(event.previous));

    store.dispatch({ nextState: first, type: "replace" });
    store.dispatch({ nextState: second, type: "replace" });

    assert.equal(seen[0], initial, "the first dispatch reports the state the store was seeded with");
    assert.equal(seen[1], first, "the second dispatch reports the first dispatch's own result, by reference");
    assert.notEqual(seen[1], initial, "and not the seed it is structurally identical to");
  });

  test("the dispatched event answers three distinct readings - the action, the state the dispatch replaced, and the store's post-dispatch state", () => {

    const initial = { count: 0 };
    const next = { count: 1 };
    const store = new FeatureOptionsStore({ initialState: initial, reducer: (_state, action) => action.nextState });
    const observed = [];

    store.addEventListener("replace", (event) => observed.push({ detail: event.detail, previous: event.previous, state: store.state }));

    const action = { nextState: next, type: "replace" };

    store.dispatch(action);

    assert.equal(observed[0].detail, action, "the detail is the dispatched action itself");
    assert.equal(observed[0].previous, initial, "previous hands back the state captured before the reducer ran, by reference");
    assert.equal(observed[0].state, next, "while the store itself already answers the reducer's result");
  });

  test("multiple subscribers all fire in registration order on a single dispatch", () => {

    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    const order = [];

    store.addEventListener("ping", () => order.push("first"));
    store.addEventListener("ping", () => order.push("second"));
    store.addEventListener("ping", () => order.push("third"));

    store.dispatch({ type: "ping" });

    assert.deepEqual(order, [ "first", "second", "third" ]);
  });

  test("dispatching different action types fires only the listeners registered for those types", () => {

    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    let aCount = 0;
    let bCount = 0;

    store.addEventListener("a", () => aCount++);
    store.addEventListener("b", () => bCount++);

    store.dispatch({ type: "a" });
    store.dispatch({ type: "a" });
    store.dispatch({ type: "b" });

    assert.equal(aCount, 2);
    assert.equal(bCount, 1);
  });
});

describe("effect", () => {

  test("runs the function once immediately upon registration", () => {

    const store = new FeatureOptionsStore({ initialState: { count: 0 }, reducer: passThroughReducer });
    const controller = new AbortController();
    let calls = 0;

    effect({ events: ["tick"], fn: () => calls++, signal: controller.signal, store });

    assert.equal(calls, 1, "immediate run on registration");
  });

  test("subscribes the function to every listed action type", () => {

    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    const controller = new AbortController();
    let calls = 0;

    effect({ events: [ "a", "b", "c" ], fn: () => calls++, signal: controller.signal, store });

    // The immediate-run pass counts as call 1; each dispatch below adds another.
    store.dispatch({ type: "a" });
    store.dispatch({ type: "b" });
    store.dispatch({ type: "c" });
    store.dispatch({ type: "unrelated" });

    assert.equal(calls, 4, "1 immediate + 3 matching dispatches; the unrelated action does not fire the effect");
  });

  test("aborting the signal removes every subscription registered by the effect in one operation", () => {

    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    const controller = new AbortController();
    let calls = 0;

    effect({ events: ["tick"], fn: () => calls++, signal: controller.signal, store });

    store.dispatch({ type: "tick" });

    assert.equal(calls, 2, "1 immediate + 1 dispatched");

    controller.abort();

    store.dispatch({ type: "tick" });
    store.dispatch({ type: "tick" });

    assert.equal(calls, 2, "post-abort dispatches do not fire the effect");
  });

  test("a pre-aborted signal prevents both the immediate run and the subscription registration", () => {

    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    const controller = new AbortController();

    controller.abort();

    let calls = 0;

    effect({ events: ["tick"], fn: () => calls++, signal: controller.signal, store });

    store.dispatch({ type: "tick" });

    assert.equal(calls, 0, "neither the immediate run nor any subsequent dispatch reaches the effect when the signal was already aborted at registration");
  });

  test("the handler receives the dispatched action as its argument on subscription firings, and undefined on the immediate run", () => {

    // The two-phase contract: the immediate run is "no triggering action" (action === undefined); every subsequent firing carries the dispatched action so a
    // handler that genuinely needs the payload (e.g., scope-aware cache invalidation that reads action.args.id) reads it directly without reaching through
    // event.detail. Handlers that ignore the argument (the majority) declare `() => void` and pay no cost.
    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    const controller = new AbortController();
    const received = [];

    effect({ events: ["tick"], fn: (action) => received.push(action), signal: controller.signal, store });

    store.dispatch({ payload: 1, type: "tick" });
    store.dispatch({ payload: 2, type: "tick" });

    assert.equal(received[0], undefined, "immediate run carries no triggering action");
    assert.deepEqual(received[1], { payload: 1, type: "tick" }, "first dispatch firing receives the dispatched action verbatim");
    assert.deepEqual(received[2], { payload: 2, type: "tick" }, "second dispatch firing receives its own dispatched action");
  });

  test("the immediate run carries no replaced state, matching the undefined action it already carries", () => {

    const store = new FeatureOptionsStore({ initialState: { count: 0 }, reducer: passThroughReducer });
    const controller = new AbortController();
    const received = [];

    effect({ events: ["tick"], fn: (action, previous) => received.push({ action, previous }), signal: controller.signal, store });

    assert.equal(received.length, 1, "registration runs the body once");
    assert.equal(received[0].action, undefined, "no triggering action on the immediate run");
    assert.equal(received[0].previous, undefined, "and no replaced state either - the two arguments are defined together or not at all");
  });

  test("a subscribed handler receives the state the dispatch replaced as its second argument", () => {

    const store = new FeatureOptionsStore({ initialState: { count: 0 }, reducer: (state, action) => ({ count: state.count + action.by }) });
    const controller = new AbortController();
    const received = [];
    const before = store.state;

    effect({ events: ["add"], fn: (_action, previous) => received.push(previous), signal: controller.signal, store });

    store.dispatch({ by: 1, type: "add" });

    assert.equal(received.length, 2, "the immediate run plus the one dispatch");
    assert.equal(received[1], before, "the dispatch hands the handler the pre-reducer state by reference");
    assert.notEqual(received[1], store.state, "which is a different object from the post-dispatch state the handler can already read off the store");
  });

  test("multiple effects on the same store coexist - aborting one does not affect the others", () => {

    const store = new FeatureOptionsStore({ initialState: {}, reducer: passThroughReducer });
    const a = new AbortController();
    const b = new AbortController();
    let callsA = 0;
    let callsB = 0;

    effect({ events: ["tick"], fn: () => callsA++, signal: a.signal, store });
    effect({ events: ["tick"], fn: () => callsB++, signal: b.signal, store });

    store.dispatch({ type: "tick" });

    assert.equal(callsA, 2);
    assert.equal(callsB, 2);

    a.abort();

    store.dispatch({ type: "tick" });

    assert.equal(callsA, 2, "aborted effect stops receiving events");
    assert.equal(callsB, 3, "unaborted effect continues receiving events");
  });
});

describe("memoize", () => {

  test("computes on the first call and returns the cached result on subsequent calls with identical slice references", () => {

    const slice = (state) => state.value;
    let computeCount = 0;
    const selector = memoize({ compute: (state) => {

      computeCount++;

      return state.value * 2;
    }, slices: [slice] });

    const state = { value: 5 };

    assert.equal(selector(state), 10, "first call computes");
    assert.equal(selector(state), 10, "same state reference returns cached");
    assert.equal(selector(state), 10, "still cached");
    assert.equal(computeCount, 1, "compute ran exactly once");
  });

  test("recomputes when any slice's return value changes", () => {

    let computeCount = 0;
    const selector = memoize({

      compute: (state) => {

        computeCount++;

        return state.a + state.b;
      },
      slices: [ (s) => s.a, (s) => s.b ]
    });

    selector({ a: 1, b: 2 });
    selector({ a: 1, b: 2 });

    assert.equal(computeCount, 1, "identical slice values stay cached");

    selector({ a: 1, b: 3 });

    assert.equal(computeCount, 2, "any slice change triggers recompute");

    selector({ a: 1, b: 3 });

    assert.equal(computeCount, 2, "back to cached after the recompute");
  });

  test("compares slice values by reference / strict equality - new object reference invalidates even with identical contents", () => {

    let computeCount = 0;
    const selector = memoize({ compute: () => computeCount++, slices: [(s) => s.list] });

    const list = [ 1, 2, 3 ];

    selector({ list });
    selector({ list });

    assert.equal(computeCount, 1, "same array reference stays cached");

    selector({ list: [ 1, 2, 3 ] });

    assert.equal(computeCount, 2, "structurally equal but reference-different array invalidates the cache");
  });

  test("primitive slice values use === comparison so primitives compare by value", () => {

    let computeCount = 0;
    const selector = memoize({ compute: () => computeCount++, slices: [(s) => s.count] });

    selector({ count: 1 });
    selector({ count: 1 });

    assert.equal(computeCount, 1);

    selector({ count: 2 });

    assert.equal(computeCount, 2);
  });

  test("handles an empty slices array - the cache always hits after the first call", () => {

    let computeCount = 0;
    const selector = memoize({ compute: () => {

      computeCount++;

      return "constant";
    }, slices: [] });

    assert.equal(selector({}), "constant");
    assert.equal(selector({ unrelated: "value" }), "constant");
    assert.equal(selector({ another: 42 }), "constant");
    assert.equal(computeCount, 1, "with no slices to invalidate against, the cache holds forever after the first call");
  });

  test("a throwing compute leaves the cache untouched, so the next call with the same slices recomputes", () => {

    // A derivation reaching into plugin-supplied code can throw, and the cache must not remember the keys of a call that produced no result. If it did, the very
    // next call would find those keys matching and hand back the stale result - or undefined - for as long as the slices held still, which on a page whose
    // catalog and scope rarely move is the rest of its life.
    let computeCount = 0;
    const slices = { list: [ 1, 2, 3 ] };
    const selector = memoize({ compute: () => {

      computeCount++;

      if(computeCount === 1) {

        throw new TypeError("the plugin's own hook refused.");
      }

      return "computed";
    }, slices: [(s) => s.list] });

    assert.throws(() => selector(slices), TypeError, "the first call surfaces the throw rather than swallowing it");
    assert.equal(computeCount, 1, "the throwing pass ran once");

    assert.equal(selector(slices), "computed", "the next call over the very same slices recomputes rather than serving a poisoned cache");
    assert.equal(computeCount, 2, "and it ran the derivation a second time");

    assert.equal(selector(slices), "computed", "a third call over the same slices is an ordinary cache hit");
    assert.equal(computeCount, 2, "with no further derivation");
  });

  test("memoize is a per-selector closure - two memoized selectors over the same shape do not share a cache", () => {

    let aCount = 0;
    let bCount = 0;
    const a = memoize({ compute: () => aCount++, slices: [(s) => s.value] });
    const b = memoize({ compute: () => bCount++, slices: [(s) => s.value] });

    const state = { value: 1 };

    a(state);
    a(state);
    b(state);
    b(state);

    assert.equal(aCount, 1);
    assert.equal(bCount, 1);
  });
});
