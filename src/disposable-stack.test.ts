/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * disposable-stack.test.ts: Unit tests for the internal DisposableStack shim - the TC39 Explicit Resource Management contract (last-in-first-out disposal,
 * use()-time dispose-method capture, null/undefined passthrough, registration and move guards, single- and multi-failure aggregation), a forced-fallback control
 * that exercises the synthesized-SuppressedError branch Node 22 relies on, and a differential oracle that compares the shim against the platform global.
 */
import { describe, test } from "node:test";
import { DisposableStack } from "./disposable-stack.ts";
import assert from "node:assert/strict";

// A factory that produces a fresh stack. The differential oracle drives the same scenario through two factories - one over the shim, one over the platform global -
// and compares their observable outcomes. The instance type is the platform interface, which the shim satisfies by construction.
type StackFactory = () => InstanceType<typeof globalThis.DisposableStack>;

// Run a happy-path last-in-first-out disposal and report the order plus the disposed-flag transition.
function scenarioHappyLifo(makeStack: StackFactory): { disposedAfter: boolean; disposedBefore: boolean; order: string[] } {

  const order: string[] = [];
  const stack = makeStack();
  const disposedBefore = stack.disposed;

  stack.defer(() => order.push("a"));
  stack.defer(() => order.push("b"));
  stack.defer(() => order.push("c"));
  stack.dispose();

  return { disposedAfter: stack.disposed, disposedBefore, order };
}

// Move the pending disposers to a new stack, then dispose both. The source must report disposed and run nothing (its own dispose is a no-op after the move); the target
// must run the transferred set last-in-first-out.
function scenarioMoveThenDisposeBoth(makeStack: StackFactory): { movedRan: string[]; sourceDisposed: boolean; targetDisposedInitially: boolean } {

  const movedRan: string[] = [];
  const stack = makeStack();

  stack.defer(() => movedRan.push("x"));
  stack.defer(() => movedRan.push("y"));

  const moved = stack.move();
  const sourceDisposed = stack.disposed;
  const targetDisposedInitially = moved.disposed;

  stack.dispose();
  moved.dispose();

  return { movedRan, sourceDisposed, targetDisposedInitially };
}

// Run a single throwing disposer among non-throwing ones. Every disposer must run and the single error must be rethrown after the sweep completes.
function scenarioSingleThrow(makeStack: StackFactory): { order: string[]; thrownMessage: string | null } {

  const order: string[] = [];
  const stack = makeStack();

  stack.defer(() => order.push("a"));
  stack.defer(() => {

    order.push("b");

    throw new Error("boom");
  });
  stack.defer(() => order.push("c"));

  let thrownMessage: string | null = null;

  try {

    stack.dispose();
  } catch(error) {

    thrownMessage = (error as Error).message;
  }

  return { order, thrownMessage };
}

// Run two throwing disposers with a non-throwing one between them. The result must be a SuppressedError linking the newest failure (`error`) to the accumulated one
// (`suppressed`), with every disposer having run.
function scenarioMultiThrow(makeStack: StackFactory): { errorMessage: string | null; order: string[]; suppressedMessage: string | null; thrownName: string | null } {

  const order: string[] = [];
  const stack = makeStack();

  stack.defer(() => {

    order.push("a");

    throw new Error("first");
  });
  stack.defer(() => order.push("b"));
  stack.defer(() => {

    order.push("c");

    throw new Error("second");
  });

  let errorMessage: string | null = null;
  let suppressedMessage: string | null = null;
  let thrownName: string | null = null;

  try {

    stack.dispose();
  } catch(error) {

    const suppressed = error as { error?: { message?: string }; name?: string; suppressed?: { message?: string } };

    errorMessage = suppressed.error?.message ?? null;
    suppressedMessage = suppressed.suppressed?.message ?? null;
    thrownName = suppressed.name ?? null;
  }

  return { errorMessage, order, suppressedMessage, thrownName };
}

// Register a Disposable, then mutate its dispose method after registration. The originally-captured method must run, proving use()-time capture.
function scenarioCaptureThenMutate(makeStack: StackFactory): { order: string[] } {

  const order: string[] = [];
  const stack = makeStack();
  const resource = { [Symbol.dispose]: (): void => {

    order.push("original");
  } };

  stack.use(resource);

  resource[Symbol.dispose] = (): void => {

    order.push("mutated");
  };

  stack.dispose();

  return { order };
}

// Pass null and undefined to use(). Both must return unchanged without being registered, so only the explicit disposer runs.
function scenarioUseNullPassthrough(makeStack: StackFactory): { order: string[] } {

  const order: string[] = [];
  const stack = makeStack();

  // Both calls sit in statement position, where a void-typed result is unremarkable... the disposal order below proves neither registered a disposer, and the contract
  // suite pins the returned-unchanged behavior separately.
  stack.use(null);
  stack.use(undefined);
  stack.defer(() => order.push("d"));
  stack.dispose();

  return { order };
}

// Call defer() on an already-disposed stack. It must throw a ReferenceError.
function scenarioPostDisposeDefer(makeStack: StackFactory): { threwReferenceError: boolean } {

  const stack = makeStack();

  stack.dispose();

  let threwReferenceError = false;

  try {

    stack.defer(() => undefined);
  } catch(error) {

    threwReferenceError = error instanceof ReferenceError;
  }

  return { threwReferenceError };
}

describe("DisposableStack - contract", () => {

  test("disposes registered callbacks in last-in-first-out order", () => {

    const order: string[] = [];
    const stack = new DisposableStack();

    stack.defer(() => order.push("a"));
    stack.defer(() => order.push("b"));
    stack.defer(() => order.push("c"));
    stack.dispose();

    assert.deepEqual(order, [ "c", "b", "a" ]);
  });

  test("use() binds the disposal method to the value as its receiver", () => {

    const seen: string[] = [];
    const resource = { marker: "R", [Symbol.dispose](): void {

      seen.push(this.marker);
    } };
    const stack = new DisposableStack();

    assert.equal(stack.use(resource), resource, "use() returns the value unchanged");

    stack.dispose();

    assert.deepEqual(seen, ["R"]);
  });

  test("use() passes null and undefined through without registering them", () => {

    const order: string[] = [];
    const stack = new DisposableStack();
    const nullResult: unknown = stack.use(null);

    assert.equal(nullResult, null, "use(null) returns null unchanged");

    // use(undefined) sits in statement position; its passthrough is symmetric to null's and the disposal below proves neither registered a disposer.
    stack.use(undefined);
    stack.defer(() => order.push("only"));
    stack.dispose();

    assert.deepEqual(order, ["only"], "neither null nor undefined registered a disposer");
  });

  test("use() captures the dispose method at registration time", () => {

    assert.deepEqual(scenarioCaptureThenMutate(() => new DisposableStack()).order, ["original"]);
  });

  test("adopt() invokes the callback with the value and returns the value unchanged", () => {

    const seen: string[] = [];
    const value = { id: "V" };
    const stack = new DisposableStack();

    assert.equal(stack.adopt(value, (adopted) => seen.push(adopted.id)), value);

    stack.dispose();

    assert.deepEqual(seen, ["V"]);
  });

  test("use() throws a TypeError when the dispose member is not callable", () => {

    const stack = new DisposableStack();

    assert.throws(() => stack.use({ [Symbol.dispose]: 42 } as unknown as Disposable), TypeError);
  });

  test("adopt() throws a TypeError when onDispose is not a function", () => {

    const stack = new DisposableStack();

    assert.throws(() => stack.adopt({}, 42 as unknown as (value: object) => void), TypeError);
  });

  test("defer() throws a TypeError when the callback is not a function", () => {

    const stack = new DisposableStack();

    assert.throws(() => stack.defer(42 as unknown as () => void), TypeError);
  });

  test("use(), adopt(), defer(), and move() throw a ReferenceError once disposed", () => {

    const stack = new DisposableStack();

    stack.dispose();

    assert.throws(() => stack.use(null), ReferenceError);
    assert.throws(() => stack.adopt({}, () => undefined), ReferenceError);
    assert.throws(() => stack.defer(() => undefined), ReferenceError);
    assert.throws(() => stack.move(), ReferenceError);
  });

  test("move() transfers the pending disposers without running them and disposes the source", () => {

    const order: string[] = [];
    const stack = new DisposableStack();

    stack.defer(() => order.push("a"));
    stack.defer(() => order.push("b"));

    const moved = stack.move();

    assert.equal(stack.disposed, true, "the source is disposed after move()");
    assert.equal(moved.disposed, false, "the target is live after move()");
    assert.deepEqual(order, [], "move() runs nothing");

    moved.dispose();

    assert.deepEqual(order, [ "b", "a" ], "the target runs the transferred disposers last-in-first-out");
  });

  test("dispose() is safe to call more than once", () => {

    let count = 0;
    const stack = new DisposableStack();

    stack.defer(() => {

      count++;
    });
    stack.dispose();
    stack.dispose();

    assert.equal(count, 1);
  });

  test("dispose() runs every disposer and rethrows a single failure", () => {

    const result = scenarioSingleThrow(() => new DisposableStack());

    assert.deepEqual(result.order, [ "c", "b", "a" ], "every disposer ran despite the failure");
    assert.equal(result.thrownMessage, "boom");
  });

  test("dispose() chains multiple failures through a SuppressedError", () => {

    const result = scenarioMultiThrow(() => new DisposableStack());

    assert.deepEqual(result.order, [ "c", "b", "a" ], "every disposer ran despite the failures");
    assert.equal(result.thrownName, "SuppressedError");
    assert.equal(result.errorMessage, "first", "the newest failure is the SuppressedError's error");
    assert.equal(result.suppressedMessage, "second", "the accumulated failure is the SuppressedError's suppressed");
  });

  test("[Symbol.dispose]() delegates to dispose()", () => {

    let disposed = false;
    const stack = new DisposableStack();

    stack.defer(() => {

      disposed = true;
    });
    stack[Symbol.dispose]();

    assert.equal(disposed, true);
    assert.equal(stack.disposed, true);
  });

  test("disposed transitions from false to true", () => {

    const stack = new DisposableStack();

    assert.equal(stack.disposed, false);

    stack.dispose();

    assert.equal(stack.disposed, true);
  });

  // The multi-failure aggregation branch that a runtime without the SuppressedError global relies on cannot run on any environment that ships the global, so we force
  // it: save and delete the global, drive a multi-throw disposal, assert the synthesized fallback has the correct shape and that every disposer ran, and restore the
  // global in a finally so the deletion never leaks to another test. Without this control the synthesized branch would ship unexercised by any gate.
  test("synthesizes a SuppressedError-shaped fallback when the platform global is absent", () => {

    const savedSuppressedError = globalThis.SuppressedError;

    try {

      delete (globalThis as { SuppressedError?: unknown }).SuppressedError;

      const order: string[] = [];
      const firstError = new Error("first");
      const secondError = new Error("second");
      const stack = new DisposableStack();

      stack.defer(() => {

        order.push("a");

        throw firstError;
      });
      stack.defer(() => order.push("b"));
      stack.defer(() => {

        order.push("c");

        throw secondError;
      });

      let caught: unknown;

      try {

        stack.dispose();
      } catch(error) {

        caught = error;
      }

      assert.ok(caught instanceof Error, "the synthesized fallback is an Error");

      const suppressed = caught as Error & { error: unknown; suppressed: unknown };

      assert.equal(suppressed.name, "SuppressedError", "the synthesized fallback is named SuppressedError");
      assert.equal(suppressed.error, firstError, "the newest failure is carried as error");
      assert.equal(suppressed.suppressed, secondError, "the accumulated failure is carried as suppressed");
      assert.deepEqual(order, [ "c", "b", "a" ], "every disposer ran despite the failures");
    } finally {

      globalThis.SuppressedError = savedSuppressedError;
    }
  });
});

describe("DisposableStack - differential oracle against the platform global", () => {

  const nativeDisposableStack = globalThis.DisposableStack;

  // Skip only when the platform global is absent, which never happens on the library's test environments. It is documented here for completeness: the oracle needs a
  // reference implementation to differ against, and that reference is the platform class.
  const skip = (typeof nativeDisposableStack === "function") ? false : "the platform DisposableStack global is absent";
  const scenarios: { name: string; run: (makeStack: StackFactory) => unknown }[] = [

    { name: "happy last-in-first-out disposal", run: scenarioHappyLifo },
    { name: "move then dispose both stacks", run: scenarioMoveThenDisposeBoth },
    { name: "single failure rethrow", run: scenarioSingleThrow },
    { name: "multiple failures suppression chain", run: scenarioMultiThrow },
    { name: "use()-time capture then mutate", run: scenarioCaptureThenMutate },
    { name: "use() null and undefined passthrough", run: scenarioUseNullPassthrough },
    { name: "defer after dispose", run: scenarioPostDisposeDefer }
  ];

  for(const scenario of scenarios) {

    test(scenario.name, { skip }, () => {

      const shimOutcome = scenario.run(() => new DisposableStack());
      const nativeOutcome = scenario.run(() => new nativeDisposableStack());

      assert.deepEqual(shimOutcome, nativeOutcome, "the shim matches the platform global for " + scenario.name);
    });
  }
});
