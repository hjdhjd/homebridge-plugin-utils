/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * async-disposable-stack.test.ts: Unit tests for the internal AsyncDisposableStack shim - the TC39 Explicit Resource Management contract (last-in-first-out disposal
 * with each disposer AWAITED before the next begins, use()-time capture with the async disposal member preferred, null/undefined passthrough, registration and move
 * guards including registration attempted during an in-flight disposal, single- and multi-failure aggregation, and a repeat or concurrent disposal as a no-op), plus a
 * differential oracle that compares the shim against the platform global.
 */
import { describe, test } from "node:test";
import { AsyncDisposableStack } from "./async-disposable-stack.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// A factory that produces a fresh stack. The differential oracle drives the same scenario through two factories - one over the shim, one over the platform global - and
// compares their observable outcomes. The instance type is the platform interface, which the shim satisfies by construction.
type StackFactory = () => InstanceType<typeof globalThis.AsyncDisposableStack>;

// Register a disposer that logs its start, yields for `ms`, then logs its end. The pair of log entries is what proves SEQUENTIAL awaiting: if disposal awaited each
// disposer, no two disposers can interleave, so every "start" is immediately followed by its own "end". A `Promise.all` sweep interleaves them and the log shows it.
function loggingDisposer(log: string[], label: string, ms: number): () => Promise<void> {

  return async (): Promise<void> => {

    log.push(label + "-start");

    await delay(ms);

    log.push(label + "-end");
  };
}

// Run a happy-path last-in-first-out disposal and report the order plus the disposed-flag transition. The first-registered disposer is the SLOW one, so a sweep that
// started every disposer at once would show its "start" before the fast disposer's "end".
async function scenarioHappyLifo(makeStack: StackFactory): Promise<{ disposedAfter: boolean; disposedBefore: boolean; order: string[] }> {

  const order: string[] = [];
  const stack = makeStack();
  const disposedBefore = stack.disposed;

  stack.defer(loggingDisposer(order, "a", 20));
  stack.defer(loggingDisposer(order, "b", 1));
  stack.defer(loggingDisposer(order, "c", 0));

  await stack.disposeAsync();

  return { disposedAfter: stack.disposed, disposedBefore, order };
}

// Move the pending disposers to a new stack, then dispose both. The source must report disposed and run nothing (its own disposal is a no-op after the move); the target
// must run the transferred set last-in-first-out.
async function scenarioMoveThenDisposeBoth(makeStack: StackFactory): Promise<{ movedRan: string[]; sourceDisposed: boolean; targetDisposedInitially: boolean }> {

  const movedRan: string[] = [];
  const stack = makeStack();

  stack.defer(() => void movedRan.push("x"));
  stack.defer(() => void movedRan.push("y"));

  const moved = stack.move();
  const sourceDisposed = stack.disposed;
  const targetDisposedInitially = moved.disposed;

  await stack.disposeAsync();
  await moved.disposeAsync();

  return { movedRan, sourceDisposed, targetDisposedInitially };
}

// Run a single rejecting disposer among non-rejecting ones. Every disposer must run and the single error must be rethrown, unchanged, after the sweep completes.
async function scenarioSingleThrow(makeStack: StackFactory): Promise<{ order: string[]; thrownMessage: string | null }> {

  const order: string[] = [];
  const stack = makeStack();

  stack.defer(() => void order.push("a"));
  stack.defer(async () => {

    order.push("b");

    await delay(1);

    throw new Error("boom");
  });
  stack.defer(() => void order.push("c"));

  let thrownMessage: string | null = null;

  try {

    await stack.disposeAsync();
  } catch(error) {

    thrownMessage = (error as Error).message;
  }

  return { order, thrownMessage };
}

// Run two rejecting disposers with a non-rejecting one between them. The result must be a SuppressedError linking the newest failure (`error`) to the accumulated one
// (`suppressed`), with every disposer having run.
async function scenarioMultiThrow(makeStack: StackFactory): Promise<{ errorMessage: string | null; order: string[]; suppressedMessage: string | null;
  thrownName: string | null; }> {

  const order: string[] = [];
  const stack = makeStack();

  stack.defer(async () => {

    order.push("a");

    await delay(1);

    throw new Error("first");
  });
  stack.defer(() => void order.push("b"));
  stack.defer(async () => {

    order.push("c");

    throw new Error("second");
  });

  let errorMessage: string | null = null;
  let suppressedMessage: string | null = null;
  let thrownName: string | null = null;

  try {

    await stack.disposeAsync();
  } catch(error) {

    const suppressed = error as { error?: { message?: string }; name?: string; suppressed?: { message?: string } };

    errorMessage = suppressed.error?.message ?? null;
    suppressedMessage = suppressed.suppressed?.message ?? null;
    thrownName = suppressed.name ?? null;
  }

  return { errorMessage, order, suppressedMessage, thrownName };
}

// Register a resource carrying BOTH disposal members, then mutate both after registration. The originally-captured async method must run, proving both use()-time capture
// and the async-over-sync preference.
async function scenarioCaptureThenMutate(makeStack: StackFactory): Promise<{ order: string[] }> {

  const order: string[] = [];
  const stack = makeStack();
  const resource = {

    [Symbol.asyncDispose]: async (): Promise<void> => {

      order.push("original-async");
    },
    [Symbol.dispose]: (): void => {

      order.push("original-sync");
    }
  };

  stack.use(resource);

  resource[Symbol.asyncDispose] = async (): Promise<void> => {

    order.push("mutated-async");
  };
  resource[Symbol.dispose] = (): void => {

    order.push("mutated-sync");
  };

  await stack.disposeAsync();

  return { order };
}

// Register a resource carrying ONLY the synchronous disposal member. An async stack accepts it and runs it.
async function scenarioSyncDisposableAccepted(makeStack: StackFactory): Promise<{ order: string[] }> {

  const order: string[] = [];
  const stack = makeStack();

  stack.use({ [Symbol.dispose]: (): void => {

    order.push("sync-only");
  } });

  await stack.disposeAsync();

  return { order };
}

// Pass null and undefined to use(). Both must return unchanged without being registered, so only the explicit disposer runs.
async function scenarioUseNullPassthrough(makeStack: StackFactory): Promise<{ order: string[] }> {

  const order: string[] = [];
  const stack = makeStack();

  // Both calls sit in statement position, where a void-typed result is unremarkable... the disposal order below proves neither registered a disposer, and the contract
  // suite pins the returned-unchanged behavior separately.
  stack.use(null);
  stack.use(undefined);
  stack.defer(() => void order.push("d"));

  await stack.disposeAsync();

  return { order };
}

// Call defer() on an already-disposed stack. It must throw a ReferenceError.
async function scenarioPostDisposeDefer(makeStack: StackFactory): Promise<{ threwReferenceError: boolean }> {

  const stack = makeStack();

  await stack.disposeAsync();

  let threwReferenceError = false;

  try {

    stack.defer(() => undefined);
  } catch(error) {

    threwReferenceError = error instanceof ReferenceError;
  }

  return { threwReferenceError };
}

// Attempt every registration and the move guard from INSIDE a slow, still-running disposer. The disposed flag flips before any disposer runs, so all four must be
// rejected rather than queued behind work that will never run them.
async function scenarioRegisterDuringDisposal(makeStack: StackFactory): Promise<{ disposedMidFlight: boolean; rejections: string[] }> {

  const rejections: string[] = [];
  const stack = makeStack();

  let disposedMidFlight = false;

  stack.defer(async () => {

    await delay(10);

    disposedMidFlight = stack.disposed;

    const attempts: { name: string; run: () => void }[] = [

      { name: "use", run: () => void stack.use(null) },
      { name: "adopt", run: () => void stack.adopt({}, () => undefined) },
      { name: "defer", run: () => stack.defer(() => undefined) },
      { name: "move", run: () => void stack.move() }
    ];

    for(const attempt of attempts) {

      try {

        attempt.run();
        rejections.push(attempt.name + ":no-throw");
      } catch(error) {

        rejections.push(attempt.name + ":" + ((error instanceof ReferenceError) ? "ReferenceError" : "other"));
      }
    }
  });

  await stack.disposeAsync();

  return { disposedMidFlight, rejections };
}

// Call disposeAsync() a second time while the first sweep is still awaiting a slow disposer. The second call must resolve without re-running anything, and it must not
// have to wait out the first sweep to do so.
async function scenarioConcurrentDisposal(makeStack: StackFactory): Promise<{ ran: string[]; secondSettledFirst: boolean }> {

  const ran: string[] = [];
  const stack = makeStack();

  stack.defer(loggingDisposer(ran, "slow", 20));

  const first = stack.disposeAsync();
  const second = stack.disposeAsync();
  const winner = await Promise.race([ second.then(() => "second"), first.then(() => "first") ]);

  await Promise.all([ first, second ]);

  return { ran, secondSettledFirst: winner === "second" };
}

describe("AsyncDisposableStack - contract", () => {

  test("disposes registered callbacks in last-in-first-out order, awaiting each before the next", async () => {

    const result = await scenarioHappyLifo(() => new AsyncDisposableStack());

    // The slow disposer was registered FIRST, so it runs LAST - and its "start" appears only after the faster later-registered disposers have both started AND ended.
    // A sweep that fired every disposer concurrently would interleave those entries.
    assert.deepEqual(result.order, [ "c-start", "c-end", "b-start", "b-end", "a-start", "a-end" ]);
    assert.equal(result.disposedBefore, false);
    assert.equal(result.disposedAfter, true);
  });

  test("use() binds the disposal method to the value as its receiver", async () => {

    const seen: string[] = [];
    const resource = { marker: "R", async [Symbol.asyncDispose](): Promise<void> {

      seen.push(this.marker);
    } };
    const stack = new AsyncDisposableStack();

    assert.equal(stack.use(resource), resource, "use() returns the value unchanged");

    await stack.disposeAsync();

    assert.deepEqual(seen, ["R"]);
  });

  test("use() prefers the async disposal member and captures it at registration time", async () => {

    assert.deepEqual((await scenarioCaptureThenMutate(() => new AsyncDisposableStack())).order, ["original-async"]);
  });

  test("use() accepts a synchronous Disposable", async () => {

    assert.deepEqual((await scenarioSyncDisposableAccepted(() => new AsyncDisposableStack())).order, ["sync-only"]);
  });

  test("use() passes null and undefined through without registering them", async () => {

    const order: string[] = [];
    const stack = new AsyncDisposableStack();
    const nullResult: unknown = stack.use(null);

    assert.equal(nullResult, null, "use(null) returns null unchanged");

    // use(undefined) sits in statement position; its passthrough is symmetric to null's and the disposal below proves neither registered a disposer.
    stack.use(undefined);
    stack.defer(() => void order.push("only"));

    await stack.disposeAsync();

    assert.deepEqual(order, ["only"], "neither null nor undefined registered a disposer");
  });

  test("adopt() invokes the callback with the value and returns the value unchanged", async () => {

    const seen: string[] = [];
    const value = { id: "V" };
    const stack = new AsyncDisposableStack();

    assert.equal(stack.adopt(value, (adopted) => void seen.push(adopted.id)), value);

    await stack.disposeAsync();

    assert.deepEqual(seen, ["V"]);
  });

  test("adopt() and defer() await a callback that returns a promise", async () => {

    const order: string[] = [];
    const stack = new AsyncDisposableStack();

    stack.adopt("V", async (value: string): Promise<void> => {

      order.push("adopt-start:" + value);

      await delay(15);

      order.push("adopt-end");
    });
    stack.defer(loggingDisposer(order, "defer", 1));

    await stack.disposeAsync();

    assert.deepEqual(order, [ "defer-start", "defer-end", "adopt-start:V", "adopt-end" ], "a promise-returning callback is awaited before the next disposer begins");
  });

  test("use() throws a TypeError when neither disposal member is callable", async () => {

    const stack = new AsyncDisposableStack();

    assert.throws(() => stack.use({ [Symbol.asyncDispose]: 42 } as unknown as AsyncDisposable), TypeError);
    assert.throws(() => stack.use({} as unknown as AsyncDisposable), TypeError);

    await stack.disposeAsync();
  });

  test("adopt() throws a TypeError when onDisposeAsync is not a function", async () => {

    const stack = new AsyncDisposableStack();

    assert.throws(() => stack.adopt({}, 42 as unknown as (value: object) => void), TypeError);

    await stack.disposeAsync();
  });

  test("defer() throws a TypeError when the callback is not a function", async () => {

    const stack = new AsyncDisposableStack();

    assert.throws(() => stack.defer(42 as unknown as () => void), TypeError);

    await stack.disposeAsync();
  });

  test("use(), adopt(), defer(), and move() throw a ReferenceError once disposed", async () => {

    const stack = new AsyncDisposableStack();

    await stack.disposeAsync();

    assert.throws(() => stack.use(null), ReferenceError);
    assert.throws(() => stack.adopt({}, () => undefined), ReferenceError);
    assert.throws(() => stack.defer(() => undefined), ReferenceError);
    assert.throws(() => stack.move(), ReferenceError);
  });

  test("use(), adopt(), defer(), and move() throw a ReferenceError while a disposal is still in flight", async () => {

    const result = await scenarioRegisterDuringDisposal(() => new AsyncDisposableStack());

    assert.equal(result.disposedMidFlight, true, "the disposed flag flips before any disposer runs, not after the sweep completes");
    assert.deepEqual(result.rejections, [ "use:ReferenceError", "adopt:ReferenceError", "defer:ReferenceError", "move:ReferenceError" ]);
  });

  test("move() transfers the pending disposers without running them and disposes the source", async () => {

    const order: string[] = [];
    const stack = new AsyncDisposableStack();

    stack.defer(() => void order.push("a"));
    stack.defer(() => void order.push("b"));

    const moved = stack.move();

    assert.equal(stack.disposed, true, "the source is disposed after move()");
    assert.equal(moved.disposed, false, "the target is live after move()");
    assert.deepEqual(order, [], "move() runs nothing");

    await moved.disposeAsync();

    assert.deepEqual(order, [ "b", "a" ], "the target runs the transferred disposers last-in-first-out");
  });

  test("disposeAsync() is safe to call more than once", async () => {

    let count = 0;
    const stack = new AsyncDisposableStack();

    stack.defer(() => {

      count++;
    });

    await stack.disposeAsync();
    await stack.disposeAsync();

    assert.equal(count, 1);
  });

  test("a second disposeAsync() during a slow first sweep resolves at once and re-runs nothing", async () => {

    const result = await scenarioConcurrentDisposal(() => new AsyncDisposableStack());

    assert.deepEqual(result.ran, [ "slow-start", "slow-end" ], "the disposer ran exactly once");
    assert.equal(result.secondSettledFirst, true, "the second call does not wait out the first sweep");
  });

  test("disposeAsync() runs every disposer and rethrows a single failure", async () => {

    const result = await scenarioSingleThrow(() => new AsyncDisposableStack());

    assert.deepEqual(result.order, [ "c", "b", "a" ], "every disposer ran despite the failure");
    assert.equal(result.thrownMessage, "boom");
  });

  test("disposeAsync() rethrows a single failure with its identity preserved", async () => {

    const boom = new Error("boom");
    const stack = new AsyncDisposableStack();

    stack.defer(async () => {

      await delay(1);

      throw boom;
    });

    await assert.rejects(() => stack.disposeAsync(), (error: unknown) => error === boom);
  });

  test("disposeAsync() chains multiple failures through a SuppressedError", async () => {

    const result = await scenarioMultiThrow(() => new AsyncDisposableStack());

    assert.deepEqual(result.order, [ "c", "b", "a" ], "every disposer ran despite the failures");
    assert.equal(result.thrownName, "SuppressedError");
    assert.equal(result.errorMessage, "first", "the newest failure is the SuppressedError's error");
    assert.equal(result.suppressedMessage, "second", "the accumulated failure is the SuppressedError's suppressed");
  });

  test("[Symbol.asyncDispose]() delegates to disposeAsync()", async () => {

    let disposed = false;
    const stack = new AsyncDisposableStack();

    stack.defer(() => {

      disposed = true;
    });

    await stack[Symbol.asyncDispose]();

    assert.equal(disposed, true);
    assert.equal(stack.disposed, true);
  });

  test("reports the platform toStringTag", () => {

    assert.equal(Object.prototype.toString.call(new AsyncDisposableStack()), "[object AsyncDisposableStack]");
  });

  test("disposed transitions from false to true", async () => {

    const stack = new AsyncDisposableStack();

    assert.equal(stack.disposed, false);

    await stack.disposeAsync();

    assert.equal(stack.disposed, true);
  });
});

describe("AsyncDisposableStack - differential oracle against the platform global", () => {

  const nativeAsyncDisposableStack = globalThis.AsyncDisposableStack;

  // Skip only when the platform global is absent, which never happens on the library's test environments. It is documented here for completeness: the oracle needs a
  // reference implementation to differ against, and that reference is the platform class.
  const skip = (typeof nativeAsyncDisposableStack === "function") ? false : "the platform AsyncDisposableStack global is absent";
  const scenarios: { name: string; run: (makeStack: StackFactory) => Promise<unknown> }[] = [

    { name: "happy last-in-first-out disposal", run: scenarioHappyLifo },
    { name: "move then dispose both stacks", run: scenarioMoveThenDisposeBoth },
    { name: "single failure rethrow", run: scenarioSingleThrow },
    { name: "multiple failures suppression chain", run: scenarioMultiThrow },
    { name: "use()-time capture then mutate", run: scenarioCaptureThenMutate },
    { name: "use() accepts a synchronous Disposable", run: scenarioSyncDisposableAccepted },
    { name: "use() null and undefined passthrough", run: scenarioUseNullPassthrough },
    { name: "defer after dispose", run: scenarioPostDisposeDefer },
    { name: "registration during an in-flight disposal", run: scenarioRegisterDuringDisposal },
    { name: "a concurrent second disposal", run: scenarioConcurrentDisposal }
  ];

  for(const scenario of scenarios) {

    test(scenario.name, { skip }, async () => {

      const shimOutcome = await scenario.run(() => new AsyncDisposableStack());
      const nativeOutcome = await scenario.run(() => new nativeAsyncDisposableStack());

      assert.deepEqual(shimOutcome, nativeOutcome, "the shim matches the platform global for " + scenario.name);
    });
  }
});
