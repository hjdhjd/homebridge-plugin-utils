/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * util.test.ts: Unit tests for the primitives exported by util.ts - HbpuAbortError, isHbpuAbortError, isHbpuAbortReason, isTimeoutReason, onAbort, waitWithSignal,
 * markHandled, the signal-aware retry(), the takeLast() ring buffer, composeSignals, superviseLoop, loopFaultReporter, Watchdog, and the string/number helpers
 * (formatBps, formatBytes, formatMs, formatSeconds, formatPercent, formatErrorMessage, defaultRetryBackoff, runWithAbort, toStartCase, sanitizeName, validateName).
 */
import { HbpuAbortError, Watchdog, composeSignals, defaultRetryBackoff, formatBps, formatBytes, formatErrorMessage, formatMs, formatPercent, formatSeconds,
  guardedDispatch, isHbpuAbortError, isHbpuAbortReason, isTimeoutReason, loopFaultReporter, markHandled, onAbort, prefixedLog, retry, runWithAbort, sanitizeName,
  superviseLoop,
  takeLast, toStartCase, validateName, waitWithSignal } from "./util.ts";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { assertNoUnhandledRejections, capturingLog, expectAt } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import util from "node:util";

// Block until `signal` aborts, then throw its reason. Models a signal-aware operation - `fetch(url, { signal })`, `events.once(emitter, event, { signal })`, etc. -
// that blocks until cancellation and surfaces `signal.reason` as the rejection. Uses `once` rather than a manual `addEventListener`-in-a-Promise construct for the same
// reason the library itself does: it is the modern Node idiom for "await one event." Note that `once` hangs on a pre-aborted signal (the event already fired), so
// callers must ensure the listener is registered before the abort occurs.
async function waitForAbort(signal: AbortSignal): Promise<never> {

  await once(signal, "abort");

  throw signal.reason;
}

describe("HbpuAbortError", () => {

  test("assigns the reason to .name", () => {

    const error = new HbpuAbortError("shutdown");

    assert.equal(error.name, "shutdown");
  });

  test("defaults .message to the reason name", () => {

    const error = new HbpuAbortError("timeout");

    assert.equal(error.message, "timeout");
  });

  test("honors an explicit message override", () => {

    const error = new HbpuAbortError("failed", { message: "spawn denied" });

    assert.equal(error.message, "spawn denied");
  });

  test("wires an Error cause through to .cause", () => {

    const underlying = new Error("boom");
    const error = new HbpuAbortError("failed", { cause: underlying });

    assert.equal(error.cause, underlying);
  });

  test("accepts a structured object as cause", () => {

    const context = { exitCode: 137, exitSignal: "SIGKILL" };
    const error = new HbpuAbortError("failed", { cause: context });

    assert.equal(error.cause, context);
  });

  test("is both an Error and an HbpuAbortError", () => {

    const error = new HbpuAbortError("closed");

    assert.ok(error instanceof Error, "HbpuAbortError must extend Error so existing error-handling paths apply");
    assert.ok(error instanceof HbpuAbortError, "instanceof HbpuAbortError must hold for own instances");
  });
});

describe("isHbpuAbortError", () => {

  test("returns true for HbpuAbortError instances", () => {

    assert.equal(isHbpuAbortError(new HbpuAbortError("shutdown")), true);
  });

  test("returns false for a plain Error", () => {

    assert.equal(isHbpuAbortError(new Error("not ours")), false);
  });

  test("returns false for a platform AbortController abort reason", () => {

    // AbortController.abort() without an explicit reason produces a platform DOMException AbortError. It is not one of ours - we distinguish by constructor, not by
    // convention.
    const controller = new AbortController();

    controller.abort();

    assert.equal(isHbpuAbortError(controller.signal.reason), false);
  });

  test("returns false for non-Error values", () => {

    const values: unknown[] = [ null, undefined, "shutdown", 42, { name: "shutdown" } ];

    for(const value of values) {

      assert.equal(isHbpuAbortError(value), false);
    }
  });
});

describe("isHbpuAbortReason", () => {

  test("returns true when the error matches the requested reason", () => {

    assert.equal(isHbpuAbortReason(new HbpuAbortError("timeout"), "timeout"), true);
  });

  test("returns false when the reason differs", () => {

    assert.equal(isHbpuAbortReason(new HbpuAbortError("failed"), "timeout"), false);
  });

  test("matches every HbpuAbortReason in the taxonomy", () => {

    const reasons = [ "closed", "failed", "replaced", "shutdown", "timeout" ] as const;

    for(const reason of reasons) {

      assert.equal(isHbpuAbortReason(new HbpuAbortError(reason), reason), true);
    }
  });

  test("returns false for a plain Error whose .name coincidentally matches a reason", () => {

    // A bare Error with .name = "timeout" must not pass - the predicate gates on HbpuAbortError constructor identity, not on name-string equality.
    const error = new Error("coincidence");

    error.name = "timeout";

    assert.equal(isHbpuAbortReason(error, "timeout"), false);
  });

  test("returns false for the platform TimeoutError from AbortSignal.timeout()", async () => {

    // AbortSignal.timeout() aborts with a DOMException whose name is "TimeoutError". It interoperates with the HBPU taxonomy by .name convention, but it is not an
    // HbpuAbortError - so this predicate returns false. Callers who want to match either HBPU or the platform branch on .name directly.
    const signal = AbortSignal.timeout(1);

    await once(signal, "abort");

    assert.equal(isHbpuAbortReason(signal.reason, "timeout"), false);
  });

  test("returns false for non-Error values", () => {

    const values: unknown[] = [ null, undefined, "shutdown", 42 ];

    for(const value of values) {

      assert.equal(isHbpuAbortReason(value, "shutdown"), false);
    }
  });

  test("narrows to HbpuAbortError so callers can read cause without a cast", () => {

    // The upgraded type predicate narrows `error` to `HbpuAbortError & { name: R }` - callers inside the truthy branch can access `.cause` and other fields without
    // further `as` assertions. This test exercises the runtime path; the absence of a cast on the next line is the type-level proof that the predicate narrows.
    const underlying = new Error("downstream");
    const error: unknown = new HbpuAbortError("failed", { cause: underlying });

    if(isHbpuAbortReason(error, "failed")) {

      assert.equal(error.cause, underlying);
      assert.equal(error.name, "failed");

      return;
    }

    assert.fail("expected the type predicate to accept an HbpuAbortError(\"failed\")");
  });
});

describe("isTimeoutReason", () => {

  test("returns true for HbpuAbortError(\"timeout\")", () => {

    assert.equal(isTimeoutReason(new HbpuAbortError("timeout")), true);
  });

  test("returns true for the platform TimeoutError from AbortSignal.timeout()", async () => {

    // `AbortSignal.timeout()` aborts with a DOMException whose `.name === "TimeoutError"`. This is the secondary match the predicate was built for - it lets consumers
    // distinguish timeouts uniformly whether the origin is a project watchdog or the platform's own timeout.
    const signal = AbortSignal.timeout(1);

    await once(signal, "abort");

    assert.equal(isTimeoutReason(signal.reason), true);
  });

  test("returns false for non-timeout HbpuAbortReason values", () => {

    const reasons = [ "closed", "failed", "replaced", "shutdown" ] as const;

    for(const reason of reasons) {

      assert.equal(isTimeoutReason(new HbpuAbortError(reason)), false);
    }
  });

  test("returns true for any Error whose .name is \"TimeoutError\"", () => {

    // The `instanceof Error` branch excludes non-error values from matching; it does NOT require a specific Error subclass. Any Error subclass or plain Error whose
    // `.name === "TimeoutError"` qualifies. This matches the project's pattern of distinguishing timeouts by `.name` rather than by constructor identity, so
    // framework-emitted TimeoutError shapes other than DOMException interoperate without special-casing.
    const error = new Error("stall");

    error.name = "TimeoutError";

    assert.equal(isTimeoutReason(error), true);
  });

  test("returns false for non-Error values whose .name coincidentally matches", () => {

    // Plain objects carrying `.name === "TimeoutError"` must not match - the `instanceof Error` guard catches this. Without it, an arbitrary user-land object shaped
    // like `{ name: "TimeoutError" }` would incorrectly trigger timeout semantics on any `signal.reason` field.
    const plain: unknown = { name: "TimeoutError" };

    assert.equal(isTimeoutReason(plain), false);
  });

  test("returns false for non-Error primitives", () => {

    const values: unknown[] = [ null, undefined, "TimeoutError", 42, true ];

    for(const value of values) {

      assert.equal(isTimeoutReason(value), false);
    }
  });
});

describe("onAbort", () => {

  test("fires the handler when the signal aborts", () => {

    // The normal path: register against a live signal, abort it, handler fires synchronously during `controller.abort()` dispatch.
    const controller = new AbortController();
    let fired = false;

    onAbort(controller.signal, () => {

      fired = true;
    });

    assert.equal(fired, false, "handler must not fire before abort is dispatched");

    controller.abort();

    assert.equal(fired, true, "handler must fire synchronously during abort dispatch");
  });

  test("fires the handler synchronously when called with a pre-aborted signal", () => {

    // The pre-aborted pitfall this helper exists to close: `addEventListener("abort", ...)` on an already-aborted signal does NOT re-dispatch the historical abort,
    // so a bare listener would silently skip the handler. `onAbort` detects the pre-aborted state and runs the handler inline so callers do not have to pair every
    // registration site with a separate pre-aborted check.
    const controller = new AbortController();

    controller.abort(new HbpuAbortError("shutdown"));

    let fired = false;

    onAbort(controller.signal, () => {

      fired = true;
    });

    assert.equal(fired, true, "handler must run inline when the signal is already aborted at call time");
  });

  test("fires at most once even when abort is called repeatedly", () => {

    // AbortController only fires the "abort" event once, so this is belt-and-suspenders: combined with `{ once: true }` on the underlying listener, duplicate aborts
    // cannot drive the handler more than once. Pins the rule so a future refactor that breaks either side shows up loudly.
    const controller = new AbortController();
    let fireCount = 0;

    onAbort(controller.signal, () => {

      fireCount += 1;
    });

    controller.abort();
    controller.abort();

    assert.equal(fireCount, 1);
  });

  test("multiple handlers on the same signal each fire in registration order", () => {

    // `onAbort` does not deduplicate across calls - each invocation registers an independent one-shot listener. Abort dispatch delivers to every registered listener
    // in attachment order, matching the EventTarget contract.
    const controller = new AbortController();
    const fired: string[] = [];

    onAbort(controller.signal, () => {

      fired.push("first");
    });

    onAbort(controller.signal, () => {

      fired.push("second");
    });

    controller.abort();

    assert.deepEqual(fired, [ "first", "second" ]);
  });

  test("returns a Disposable whose [Symbol.dispose] removes the listener before it fires", () => {

    // The scope-bound use case: a transient observer captures the returned handle, disposes it when its scope ends, and the handler never fires on the subsequent
    // signal abort. This is the guarantee `waitWithSignal` relies on to prevent listener accumulation on long-lived signals that see many short waits.
    const controller = new AbortController();
    let fired = false;

    const registration = onAbort(controller.signal, () => {

      fired = true;
    });

    registration[Symbol.dispose]();
    controller.abort();

    assert.equal(fired, false, "handler must not fire on abort once the returned disposer has been invoked");
  });

  test("[Symbol.dispose] is safe to call more than once", () => {

    // `removeEventListener` is a no-op for already-removed listeners per spec, so disposing twice must be a safe no-op. Pins the contract so a caller that both
    // manually disposes AND relies on `using`'s scope-exit dispatch (or disposes in response to two separate signals) cannot accidentally throw.
    const controller = new AbortController();

    const registration = onAbort(controller.signal, () => { /* No-op handler. */ });

    registration[Symbol.dispose]();
    registration[Symbol.dispose]();
  });

  test("[Symbol.dispose] is a safe no-op after the listener has already fired", () => {

    // `{ once: true }` auto-removes the listener on fire. Disposing afterwards must not throw - the backing `removeEventListener` is a no-op here, so callers that
    // combine `using` (scope-exit dispose) with a natural signal abort inside the scope do not have to guard against double-cleanup.
    const controller = new AbortController();
    let fireCount = 0;

    const registration = onAbort(controller.signal, () => {

      fireCount += 1;
    });

    controller.abort();

    assert.equal(fireCount, 1, "listener fires exactly once when the signal aborts");

    registration[Symbol.dispose]();

    assert.equal(fireCount, 1, "dispose after fire must not re-invoke or throw");
  });

  test("pre-aborted signal returns a Disposable whose [Symbol.dispose] is a no-op", () => {

    // On the pre-aborted path, no listener is registered (the handler ran inline). The returned disposer still implements `Symbol.dispose` so callers that consume
    // the result with `using` compile cleanly and run safely - a fire-and-forget no-op is the right semantic for "nothing to remove."
    const controller = new AbortController();

    controller.abort(new HbpuAbortError("shutdown"));

    let fired = false;
    const registration = onAbort(controller.signal, () => {

      fired = true;
    });

    assert.equal(fired, true, "pre-aborted path must run the handler inline");

    registration[Symbol.dispose]();
    registration[Symbol.dispose]();
  });

  test("consumed via `using`, the listener is removed when the scope exits", () => {

    // End-to-end integration of the scope-bound pattern. A `using` declaration inside a block binds the listener's lifetime to that block; exiting the block
    // disposes the handle and removes the listener, so a later signal abort is silently ignored. This is the shape `waitWithSignal` uses internally.
    const controller = new AbortController();
    let fired = false;

    {

      using _registration = onAbort(controller.signal, () => {

        fired = true;
      });
    }

    controller.abort();

    assert.equal(fired, false, "`using` scope exit must dispose the handle and remove the listener");
  });
});

describe("waitWithSignal", () => {

  test("returns the promise's resolved value when the signal does not abort", async () => {

    const controller = new AbortController();
    const result = await waitWithSignal(Promise.resolve("ok"), controller.signal);

    assert.equal(result, "ok");
  });

  test("propagates the promise's rejection when the signal does not abort", async () => {

    const controller = new AbortController();
    const reason = new Error("boom");

    await assert.rejects(waitWithSignal(Promise.reject(reason), controller.signal), (error: unknown) => error === reason);
  });

  test("rejects synchronously with signal.reason when the signal is already aborted", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    controller.abort(reason);

    // The promise argument should never be observed on the pre-aborted path; pass one that would hang forever to prove it.
    await assert.rejects(waitWithSignal(new Promise<string>(() => { /* pending forever */ }), controller.signal), (error: unknown) => error === reason);
  });

  test("rejects with signal.reason when the signal aborts during the wait", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("replaced");
    const resolvers: PromiseWithResolvers<string> = Promise.withResolvers();
    const waiter = waitWithSignal(resolvers.promise, controller.signal);

    // Abort on the next microtask so the listener is attached before the abort fires.
    queueMicrotask(() => {

      controller.abort(reason);
    });

    await assert.rejects(waiter, (error: unknown) => error === reason);
  });

  test("signal aborts arriving after the promise has settled do not affect the already-returned result", async () => {

    const controller = new AbortController();
    const result = await waitWithSignal(Promise.resolve("ok"), controller.signal);

    // Aborting after `waitWithSignal` has already returned must be a no-op - the listener is removed in the helper's finally block.
    controller.abort(new HbpuAbortError("shutdown"));

    assert.equal(result, "ok");
  });

  test("marks a rejecting promise as handled when the signal wins the race", async () => {

    // `assertNoUnhandledRejections` is the rigorous form: it monitors `process.on("unhandledRejection")` during body execution and asserts the channel stayed quiet.
    // Without this harness the test could pass even if `waitWithSignal` failed to observe the promise - Node's default warn-and-continue behavior would print to
    // stderr but neither fail the test nor surface through assertions.
    await assertNoUnhandledRejections(async () => {

      const controller = new AbortController();
      const reason = new HbpuAbortError("replaced");
      const laterRejection: PromiseWithResolvers<string> = Promise.withResolvers();
      const waiter = waitWithSignal(laterRejection.promise, controller.signal);

      queueMicrotask(() => {

        controller.abort(reason);
      });

      await assert.rejects(waiter, (error: unknown) => error === reason);

      // Reject the underlying promise AFTER the signal has already won the race. `waitWithSignal` must have observed the promise to prevent this rejection from
      // surfacing as an unhandled warning.
      laterRejection.reject(new Error("post-abort rejection"));
    });
  });

  test("marks a rejecting promise as handled even when the signal was pre-aborted", async () => {

    // The unified control flow covers the pre-aborted fast path too: `waitWithSignal` still attaches a rejection reaction to `promise` before rejecting on the
    // signal's reason, so a later rejection of `promise` is observed.
    await assertNoUnhandledRejections(async () => {

      const controller = new AbortController();
      const reason = new HbpuAbortError("shutdown");

      controller.abort(reason);

      const laterRejection: PromiseWithResolvers<string> = Promise.withResolvers();

      await assert.rejects(waitWithSignal(laterRejection.promise, controller.signal), (error: unknown) => error === reason);

      laterRejection.reject(new Error("post-abort rejection"));
    });
  });
});

describe("markHandled", () => {

  test("returns the original promise unchanged for chained assignment", () => {

    const resolvers: PromiseWithResolvers<number> = Promise.withResolvers();

    assert.equal(markHandled(resolvers.promise), resolvers.promise);
  });

  test("suppresses unhandled-rejection tracking without consuming the rejection", async () => {

    // The original promise still rejects through any observer's own chain - `markHandled` opts out of Node's unhandled-rejection warning but does not swallow the
    // error. A caller attaching a `.catch` after the call site still sees the rejection.
    const resolvers: PromiseWithResolvers<number> = Promise.withResolvers();
    const reason = new Error("boom");
    const handled = markHandled(resolvers.promise);

    resolvers.reject(reason);

    await assert.rejects(handled, (error: unknown) => error === reason);
  });

  test("resolves pass through unchanged", async () => {

    const resolvers: PromiseWithResolvers<string> = Promise.withResolvers();
    const handled = markHandled(resolvers.promise);

    resolvers.resolve("ok");

    assert.equal(await handled, "ok");
  });
});

describe("takeLast", () => {

  // Build an async iterable over `values` so the helper is exercised through its real `for await` consumption path rather than a synchronous shortcut.
  async function *asyncFrom<T>(values: readonly T[]): AsyncIterable<T> {

    for(const value of values) {

      yield value;
    }
  }

  test("returns nothing for a non-positive capacity without touching the source", async () => {

    let iterated = false;

    // A generator that flips the flag if it is ever asked for a value. A non-positive capacity must return before iterating, so the flag must stay false.
    async function *tattle(): AsyncIterable<number> {

      iterated = true;

      yield 1;
    }

    assert.deepEqual(await takeLast(tattle(), 0), []);
    assert.deepEqual(await takeLast(tattle(), -5), []);
    assert.equal(iterated, false, "takeLast must not iterate the source for a non-positive capacity");
  });

  test("returns all values in order when the source is shorter than the capacity", async () => {

    assert.deepEqual(await takeLast(asyncFrom([ "a", "b", "c" ]), 10), [ "a", "b", "c" ]);
  });

  test("returns all values in order when the source exactly fills the capacity", async () => {

    assert.deepEqual(await takeLast(asyncFrom([ 1, 2, 3 ]), 3), [ 1, 2, 3 ]);
  });

  test("retains only the last n values in original order when the source overflows", async () => {

    // Ten values into a ring of three retains the final three, oldest-to-newest. This is the core ring-buffer contract.
    assert.deepEqual(await takeLast(asyncFrom([ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ]), 3), [ 8, 9, 10 ]);
  });

  test("returns the last value for a capacity of one", async () => {

    assert.deepEqual(await takeLast(asyncFrom([ "x", "y", "z" ]), 1), ["z"]);
  });

  test("returns an empty array for an empty source", async () => {

    assert.deepEqual(await takeLast(asyncFrom<number>([]), 5), []);
  });

  test("recovers correct oldest-to-newest order across a wrap that does not land on slot zero", async () => {

    // Seven values into a ring of four wraps three times; the write cursor lands at index 3 (7 % 4), so the rotation that reconstructs order must read from slot 3
    // forward, wrapping once. The expected tail is the final four values in order, which only holds if the wrap math is correct.
    assert.deepEqual(await takeLast(asyncFrom([ 1, 2, 3, 4, 5, 6, 7 ]), 4), [ 4, 5, 6, 7 ]);
  });

  test("retains at most n values regardless of source length", async () => {

    // A larger overflow still retains exactly n, proving memory stays bounded rather than accumulating the whole source.
    const result = await takeLast(asyncFrom(Array.from({ length: 1000 }, (_unused, index) => index)), 5);

    assert.equal(result.length, 5);
    assert.deepEqual(result, [ 995, 996, 997, 998, 999 ]);
  });
});

describe("retry", () => {

  test("returns the first successful result without retrying", async () => {

    let calls = 0;
    const result = await retry(async () => {

      calls++;

      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  test("retries a transient failure until the operation succeeds", async () => {

    let calls = 0;
    const result = await retry(async () => {

      calls++;

      if(calls < 3) {

        throw new Error("transient");
      }

      return "done";
    }, { attempts: 5, backoff: () => 1 });

    assert.equal(result, "done");
    assert.equal(calls, 3);
  });

  test("throws the final attempt's error after attempts are exhausted", async () => {

    let calls = 0;

    await assert.rejects(retry(async () => {

      calls++;

      throw new Error("attempt-" + calls.toString());
    }, { attempts: 3, backoff: () => 1 }), /attempt-3/);

    assert.equal(calls, 3);
  });

  test("defaults to three attempts when no count is supplied", async () => {

    let calls = 0;

    await assert.rejects(retry(async () => {

      calls++;

      throw new Error("fail");
    }, { backoff: () => 1 }));

    assert.equal(calls, 3);
  });

  test("rejects synchronously when attempts is less than 1", async () => {

    let calls = 0;

    await assert.rejects(retry(async () => {

      calls++;

      return "unreachable";
    }, { attempts: 0 }), /attempts.*>= 1/);

    assert.equal(calls, 0);
  });

  test("honors a pre-aborted signal without invoking the operation", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    controller.abort(reason);

    let calls = 0;

    await assert.rejects(retry(async () => {

      calls++;

      return "unreachable";
    }, { signal: controller.signal }), (error: unknown) => error === reason);

    assert.equal(calls, 0);
  });

  test("rejects with signal.reason when aborted mid-attempt", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");
    const attempt = retry(waitForAbort, { signal: controller.signal });

    // Abort on the next tick so the operation has registered its abort listener before the abort fires. `events.once` (inside waitForAbort) hangs on a pre-aborted
    // signal, so ordering matters here.
    queueMicrotask(() => { controller.abort(reason); });

    await assert.rejects(attempt, (error: unknown) => error === reason);
  });

  test("rejects with signal.reason when aborted during a backoff wait", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("replaced");
    let calls = 0;
    const attempt = retry(async () => {

      calls++;

      throw new Error("transient");
    }, { attempts: 5, backoff: () => 200, signal: controller.signal });

    // The first attempt fails and retry enters its backoff wait, then we abort. The platform `setTimeout` from `node:timers/promises` rejects with a generic AbortError
    // here - retry's outer normalizer converts that into signal.reason, which is the library contract we care about.
    setTimeout(() => { controller.abort(reason); }, 20);

    await assert.rejects(attempt, (error: unknown) => error === reason);

    // Only the first attempt ran; the backoff abort preempted the second.
    assert.equal(calls, 1);
  });

  test("passes a signal to the operation that reflects caller aborts", async () => {

    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const attempt = retry(async (signal) => {

      observedSignal = signal;

      await waitForAbort(signal);
    }, { signal: controller.signal });

    queueMicrotask(() => { controller.abort(new HbpuAbortError("shutdown")); });

    await assert.rejects(attempt);

    assert.ok(observedSignal, "the operation must have observed a signal at least once before the abort fired");
    assert.equal(observedSignal.aborted, true);
  });

  test("stops immediately and rethrows the exact error when shouldRetry vetoes the first failure", async () => {

    const error = new Error("fatal");
    let calls = 0;
    let backoffCalls = 0;
    const backoff = (): number => {

      backoffCalls++;

      return 1;
    };

    await assert.rejects(retry(async () => {

      calls++;

      throw error;
    }, { attempts: 5, backoff, shouldRetry: () => false }), (thrown: unknown) => thrown === error);

    // A veto on the first failure rethrows that exact error with no further attempts and no backoff wait - the backoff policy is never consulted.
    assert.equal(calls, 1);
    assert.equal(backoffCalls, 0);
  });

  test("retries up to the attempt budget when shouldRetry allows every failure", async () => {

    let calls = 0;

    // shouldRetry returning true for every failure is behaviorally identical to omitting it: the loop exhausts its budget and rethrows the final attempt's error.
    await assert.rejects(retry(async () => {

      calls++;

      throw new Error("attempt-" + calls.toString());
    }, { attempts: 3, backoff: () => 1, shouldRetry: () => true }), /attempt-3/);

    assert.equal(calls, 3);
  });

  test("invokes shouldRetry with the rejected error and the 1-indexed failed-attempt number", async () => {

    const thrown: Error[] = [];
    const attemptNumbers: number[] = [];
    let receivedFirstError: unknown;
    const shouldRetry = (error: unknown, attemptNumber: number): boolean => {

      if(attemptNumber === 1) {

        receivedFirstError = error;
      }

      attemptNumbers.push(attemptNumber);

      return true;
    };

    await assert.rejects(retry(async () => {

      const error = new Error("transient");

      thrown.push(error);

      throw error;
    }, { attempts: 3, backoff: () => 1, shouldRetry }));

    // The predicate is consulted only while attempts remain: it sees the first two failures as attempts 1 then 2, but never the third - attempt 3 exhausts the budget
    // and the loop rethrows without consulting the predicate. The error handed to the predicate is the exact instance the operation threw for that attempt.
    assert.deepEqual(attemptNumbers, [ 1, 2 ]);
    assert.equal(receivedFirstError, thrown[0]);
  });

  test("with attempts set to Infinity, retries past the default budget until the operation succeeds", async () => {

    let calls = 0;
    const result = await retry(async () => {

      calls++;

      // Succeed only on the fifth call - well past the default three-attempt budget - to prove an unbounded count keeps retrying rather than exhausting at three.
      if(calls < 5) {

        throw new Error("transient");
      }

      return "done";
    }, { attempts: Infinity, backoff: () => 1 });

    assert.equal(result, "done");
    assert.equal(calls, 5);
  });

  test("with attempts set to Infinity, a shouldRetry veto terminates the otherwise-unbounded loop", async () => {

    const error = new Error("auth");
    let calls = 0;

    // The predicate allows the first two failures and vetoes the third, so an unbounded budget still terminates after exactly three attempts. Without the veto an
    // always-throwing operation under `attempts: Infinity` would never exit on its own.
    await assert.rejects(retry(async () => {

      calls++;

      throw error;
    }, { attempts: Infinity, backoff: () => 1, shouldRetry: (_error, attemptNumber) => attemptNumber < 3 }), (thrown: unknown) => thrown === error);

    assert.equal(calls, 3);
  });

  test("rejects with signal.reason when aborted mid-attempt even with shouldRetry present", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    // The predicate is present and would allow retries, but an aborted signal must still win: whatever bubbles out of the loop, the outer normalizer translates it to
    // the signal's reason. This guards that adding shouldRetry did not perturb the abort-normalization contract.
    const attempt = retry(waitForAbort, { shouldRetry: () => true, signal: controller.signal });

    // Abort on the next tick so the operation has registered its abort listener before the abort fires (see the mid-attempt test above for why ordering matters).
    queueMicrotask(() => { controller.abort(reason); });

    await assert.rejects(attempt, (error: unknown) => error === reason);
  });
});

describe("composeSignals", () => {

  test("returns the single defined signal unchanged when only one is provided", () => {

    const controller = new AbortController();

    // Reference equality matters here - a needless `AbortSignal.any([ ... ])` wrapper would allocate a derived signal and break callers who compare against the input.
    assert.equal(composeSignals(undefined, controller.signal), controller.signal);
    assert.equal(composeSignals(controller.signal, undefined, undefined), controller.signal);
  });

  test("throws TypeError when every input is undefined", () => {

    // A class whose lifetime is expressed by a signal cannot exist without one. Surfacing the misuse at the boundary catches the mistake loudly rather than silently
    // producing a signal that can never abort.
    assert.throws(() => composeSignals(), TypeError);
    assert.throws(() => composeSignals(undefined, undefined), TypeError);
  });

  test("composes two or more defined signals and aborts when any input aborts", () => {

    const parent = new AbortController();
    const internal = new AbortController();
    const composed = composeSignals(parent.signal, internal.signal);

    assert.notEqual(composed, parent.signal);
    assert.notEqual(composed, internal.signal);
    assert.equal(composed.aborted, false);

    const reason = new HbpuAbortError("replaced");

    internal.abort(reason);

    assert.equal(composed.aborted, true);
    assert.equal(composed.reason, reason);
  });

  test("propagates the first aborting input's reason", () => {

    const first = new AbortController();
    const second = new AbortController();
    const composed = composeSignals(first.signal, second.signal);

    const firstReason = new HbpuAbortError("shutdown");

    first.abort(firstReason);

    // Even if the second signal subsequently aborts, the composed reason reflects the winning abort - AbortSignal.any settles exactly once.
    second.abort(new HbpuAbortError("failed"));

    assert.equal(composed.reason, firstReason);
  });

  test("honors a pre-aborted input by returning an already-aborted composed signal", () => {

    const preAborted = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    preAborted.abort(reason);

    const fresh = new AbortController();
    const composed = composeSignals(preAborted.signal, fresh.signal);

    assert.equal(composed.aborted, true);
    assert.equal(composed.reason, reason);
  });
});

describe("superviseLoop", () => {

  test("resolves when the loop completes normally, without invoking onError", async () => {

    const controller = new AbortController();
    let loopRan = false;
    let onErrorCalls = 0;

    // Awaiting the supervisor directly (no assert.rejects wrapper) is itself the never-rejects assertion: a rejection here would surface as a thrown await and fail the
    // test. The unhandled-rejection monitor confirms the clean path leaves no dangling rejection behind.
    await assertNoUnhandledRejections(async () => {

      await superviseLoop({

        loop: async () => { loopRan = true; },
        onError: () => { onErrorCalls++; },
        signal: controller.signal
      });
    });

    assert.equal(loopRan, true, "the loop must have run to completion");
    assert.equal(onErrorCalls, 0, "a normal completion is not a fault, so onError must not be called");
  });

  test("swallows the throw silently when the signal is aborted, leaving onError uncalled", async () => {

    const controller = new AbortController();
    let onErrorCalls = 0;

    // Abort first, then run a loop that throws in response - this models the orderly teardown path, where the throw is the loop unwinding because we tore it down.
    controller.abort(new HbpuAbortError("shutdown"));

    await assertNoUnhandledRejections(async () => {

      await superviseLoop({

        loop: async (signal) => { throw signal.reason; },
        onError: () => { onErrorCalls++; },
        signal: controller.signal
      });
    });

    assert.equal(onErrorCalls, 0, "an abort-driven throw is orderly teardown, not a fault, so onError must not be called");
  });

  test("surfaces a genuine fault through onError exactly once, passing the thrown value unchanged", async () => {

    const controller = new AbortController();
    const boom = new Error("upstream failed");
    const observed: unknown[] = [];

    await assertNoUnhandledRejections(async () => {

      await superviseLoop({

        loop: async () => { throw boom; },
        onError: (error) => { observed.push(error); },
        signal: controller.signal
      });
    });

    // A single delivery, with the thrown value passed through byte-for-byte: the primitive runs the loop once and routes its fault straight to onError without wrapping.
    assert.deepEqual(observed, [boom], "a fault on an unaborted signal must reach onError exactly once, with the thrown value unchanged");
  });

  test("surfaces a synchronous throw from the loop the same way as an asynchronous one", async () => {

    const controller = new AbortController();
    const boom = new Error("threw before returning a promise");
    const observed: unknown[] = [];

    // A loop that throws synchronously - before it ever returns a promise - is still caught, because the loop is invoked inside the try, not merely awaited there.
    await superviseLoop({

      loop: () => { throw boom; },
      onError: (error) => { observed.push(error); },
      signal: controller.signal
    });

    assert.deepEqual(observed, [boom], "a synchronous throw must be caught and surfaced through onError exactly once");
  });

  test("passes the bound signal into the loop by identity", async () => {

    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let onErrorCalls = 0;

    await superviseLoop({

      loop: async (signal) => { observedSignal = signal; },
      onError: () => { onErrorCalls++; },
      signal: controller.signal
    });

    // The loop must receive the exact signal it was bound to - not a wrapper - so it can wire that signal into observe()/fetch()/stream reads and share its abort state.
    assert.equal(observedSignal, controller.signal);
    assert.equal(onErrorCalls, 0, "a clean completion must not invoke onError");
  });

  test("never rejects when a detached, faulting loop is voided", async () => {

    const controller = new AbortController();
    let onErrorCalls = 0;

    // The defining property for the detach-and-forget call site: voiding a supervised loop whose loop faults must not surface an unhandled rejection, because the fault
    // was delivered to onError and the returned promise resolved rather than rejected.
    await assertNoUnhandledRejections(async () => {

      void superviseLoop({

        loop: async () => { throw new Error("transient"); },
        onError: () => { onErrorCalls++; },
        signal: controller.signal
      });

      // Yield a turn so the voided supervisor begins settling; assertNoUnhandledRejections drains a full event-loop turn before inspecting the channel, which guarantees
      // the supervisor has resolved and onError has run by the time the outer assertion reads the count.
      await Promise.resolve();
    });

    assert.equal(onErrorCalls, 1, "the detached loop's fault must have been delivered to onError exactly once");
  });
});

describe("loopFaultReporter", () => {

  // The single canonical template the reporter emits. Pinning it here lets the tests assert the exact format string the consumers depend on, so a wording change is a
  // deliberate test update rather than a silent drift.
  const CANONICAL_MESSAGE = "HomeKit updates for %s stopped unexpectedly and will not resume until the Homebridge plugin restarts: %s.";

  test("returns a handler function (factory shape)", () => {

    const handler = loopFaultReporter(capturingLog(), "membership");

    assert.equal(typeof handler, "function");
  });

  test("logs the canonical message once, with the label and the formatErrorMessage-rendered error", () => {

    const log = capturingLog();
    const boom = new Error("upstream failed");

    loopFaultReporter(log, "membership")(boom);

    assert.equal(log.entries.length, 1, "a single fault must produce exactly one error log line");

    const entry = expectAt(log.entries, 0, "the reported fault");

    assert.equal(entry.level, "error");
    assert.equal(entry.message, CANONICAL_MESSAGE);
    assert.deepEqual(entry.params, [ "membership", formatErrorMessage(boom) ]);
  });

  test("renders a non-Error throw through formatErrorMessage rather than a re-inlined String()", () => {

    const log = capturingLog();

    // A bare string ending in a period is the distinguishing case: formatErrorMessage strips the trailing period, whereas a re-inlined String(error) would keep it.
    // Asserting the rendered param equals formatErrorMessage's own output proves the factory single-sources its formatting through it instead of re-deriving it here.
    const thrown = "device went offline.";

    loopFaultReporter(log, "reachability")(thrown);

    const entry = expectAt(log.entries, 0, "the reported fault");

    assert.equal(entry.params.at(-1), formatErrorMessage(thrown));
    assert.equal(entry.params.at(-1), "device went offline", "the trailing period must be stripped, proving formatErrorMessage rendered the value");
  });

  test("composes with superviseLoop: a genuine fault on a non-aborted signal logs exactly once", async () => {

    const controller = new AbortController();
    const log = capturingLog();
    const boom = new Error("transient");

    await superviseLoop({

      loop: async () => { throw boom; },
      onError: loopFaultReporter(log, "telemetry"),
      signal: controller.signal
    });

    assert.equal(log.entries.length, 1, "an unaborted fault must be surfaced through the reporter exactly once");

    const entry = expectAt(log.entries, 0, "the reported fault");

    assert.equal(entry.message, CANONICAL_MESSAGE);
    assert.deepEqual(entry.params, [ "telemetry", formatErrorMessage(boom) ]);
  });

  test("composes with superviseLoop: an abort-driven throw is swallowed before the reporter runs", async () => {

    const controller = new AbortController();
    const log = capturingLog();

    // Abort first, then run a loop that throws its reason. superviseLoop swallows the abort-driven throw before ever reaching onError, so the reporter never fires.
    controller.abort(new HbpuAbortError("shutdown"));

    await superviseLoop({

      loop: async (signal) => { throw signal.reason; },
      onError: loopFaultReporter(log, "telemetry"),
      signal: controller.signal
    });

    assert.equal(log.entries.length, 0, "the envelope swallows an abort-driven throw before onError, so the reporter must not log");
  });
});

describe("guardedDispatch", () => {

  // The two canonical failure templates the wrapper emits. Pinning them here means a wording change is a deliberate test update rather than a silent drift, matching the
  // loopFaultReporter suite's convention above.
  const CALLBACK_LESS_MESSAGE = "The %s handler failed: %s.";
  const POST_ANSWER_MESSAGE = "The %s handler failed after it had already responded to HomeKit: %s.";

  test("callback-less: a throwing handler floats nothing and logs the fault exactly once", async () => {

    const log = capturingLog();
    const boom = new Error("the recording state could not be applied");

    // The whole call happens under the unhandled-rejection monitor: a wrapper that let the handler's rejection float would fail here before any log assertion runs. The
    // monitor also drains a full event-loop turn before returning, so the handler has settled and its fault has been logged by the time the outer assertions read it.
    await assertNoUnhandledRejections(async () => {

      guardedDispatch({ handler: async () => { throw boom; }, label: "recording activation", log });
    });

    assert.equal(log.entries.length, 1, "a callback-less fault has no callback to carry it, so it must be logged exactly once");

    const entry = expectAt(log.entries, 0, "the logged fault");

    assert.equal(entry.level, "error");
    assert.equal(entry.message, CALLBACK_LESS_MESSAGE);
    assert.deepEqual(entry.params, [ "recording activation", formatErrorMessage(boom) ]);
  });

  test("callback-less: a well-behaved handler runs and logs nothing", async () => {

    const log = capturingLog();
    let ran = false;

    await assertNoUnhandledRejections(async () => {

      guardedDispatch({ handler: async () => { ran = true; }, label: "recording activation", log });
    });

    assert.equal(ran, true, "the handler must have run to completion");
    assert.equal(log.entries.length, 0, "a clean completion is not a fault, so nothing must be logged");
  });

  test("callback: a fault before any answer is delivered to the callback exactly once, and is not additionally logged", async () => {

    const log = capturingLog();
    const boom = new Error("the snapshot could not be produced");
    const received: (Error | undefined)[] = [];
    const callback = (error?: Error): void => { received.push(error); };

    await assertNoUnhandledRejections(async () => {

      // The handler faults before it ever answers, so the still-open callback is the single most useful place for the error to surface.
      guardedDispatch({ callback, handler: async () => { throw boom; }, label: "snapshot request", log });
    });

    assert.deepEqual(received, [boom], "the still-open callback must receive the fault exactly once, unchanged");
    assert.equal(log.entries.length, 0, "a before-answer fault is delivered through the callback, so it must not also be logged");
  });

  test("callback: an answer followed by a throw stands, the callback is not fired again, and the late fault is logged", async () => {

    const log = capturingLog();
    const boom = new Error("cleanup failed after the response was sent");
    const received: (Error | undefined)[] = [];
    const callback = (error?: Error): void => { received.push(error); };

    await assertNoUnhandledRejections(async () => {

      // The handler answers cleanly, then faults during its own teardown. The answer already went to HomeKit, so it must stand and the late fault is logged instead.
      guardedDispatch({ callback, handler: async (answer) => { answer(); throw boom; }, label: "snapshot request", log });
    });

    assert.deepEqual(received, [undefined], "the original answer stands and the real callback fires exactly once");
    assert.equal(log.entries.length, 1, "a fault after the answer cannot change HomeKit's answer, so it must be logged");

    const entry = expectAt(log.entries, 0, "the logged post-answer fault");

    assert.equal(entry.message, POST_ANSWER_MESSAGE);
    assert.deepEqual(entry.params, [ "snapshot request", formatErrorMessage(boom) ]);
  });

  test("callback: a well-behaved handler answers exactly once and logs nothing", async () => {

    const log = capturingLog();
    const received: (Error | undefined)[] = [];
    const callback = (error?: Error): void => { received.push(error); };

    await assertNoUnhandledRejections(async () => {

      guardedDispatch({ callback, handler: async (answer) => { answer(); }, label: "snapshot request", log });
    });

    assert.deepEqual(received, [undefined], "the callback must be answered exactly once with no error");
    assert.equal(log.entries.length, 0, "a clean answer is not a fault");
  });

  test("callback: a handler that answers twice fires the real callback only once, and forwards the payload of the first answer", async () => {

    const log = capturingLog();
    const received: (string | undefined)[] = [];

    // A richer callback shape carrying a success payload alongside the error slot; the guard must forward the handler's exact answer, not just the error.
    const callback = (error?: Error, value?: string): void => { received.push(value); };

    await assertNoUnhandledRejections(async () => {

      guardedDispatch({ callback, handler: async (answer) => { answer(undefined, "first"); answer(undefined, "second"); }, label: "snapshot request", log });
    });

    assert.deepEqual(received, ["first"], "only the first answer, with its payload, may reach the real callback");
    assert.equal(log.entries.length, 0, "answering twice is not a fault");
  });

  test("callback: a synchronous throw before answering is delivered to the callback, the same as a rejection", async () => {

    const log = capturingLog();
    const boom = new Error("threw before returning a promise");
    const received: (Error | undefined)[] = [];
    const callback = (error?: Error): void => { received.push(error); };

    await assertNoUnhandledRejections(async () => {

      // A handler that throws synchronously - before it ever returns a promise - is caught the same way, because it runs inside the try, not merely awaited there.
      guardedDispatch({ callback, handler: () => { throw boom; }, label: "snapshot request", log });
    });

    assert.deepEqual(received, [boom], "a synchronous throw must route through the same before-answer delivery as a rejection");
    assert.equal(log.entries.length, 0, "the fault reached the callback, so it must not also be logged");
  });

  test("callback: a non-Error throw before answering is coerced to an Error for the callback", async () => {

    const log = capturingLog();
    const received: (Error | undefined)[] = [];
    const callback = (error?: Error): void => { received.push(error); };

    // A thrown value that is not an Error, typed as `unknown` to model a handler that rejects with something other than an Error - the case the wrapper must coerce.
    const thrown: unknown = "the socket reset.";

    await assertNoUnhandledRejections(async () => {

      guardedDispatch({ callback, handler: async () => { throw thrown; }, label: "snapshot request", log });
    });

    const delivered = expectAt(received, 0, "the delivered error");

    assert.ok(delivered instanceof Error, "a non-Error throw must be coerced to an Error so the callback always receives an Error");
    assert.equal(delivered.message, "the socket reset", "the coerced message is rendered through formatErrorMessage, which strips the trailing period");
  });
});

describe("Watchdog - arming and firing", () => {

  // Watchdog uses `setTimeout` for the inactivity window. Mocking that primitive lets the tests advance virtual time deterministically via `mock.timers.tick`,
  // which removes the real-time waits that would otherwise make these tests both slow and flake-prone under CI variability.
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("fires onFire once the timeout elapses without a re-arm", async () => {

    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    mock.timers.tick(80);

    assert.equal(fired, 1, "onFire must run exactly once when the window lapses without a re-arm");
  });

  test("does not fire if no arm was scheduled", async () => {

    // This test covers the dormancy rule: constructing a Watchdog without calling `arm()` schedules nothing and fires nothing. Disposal is not the subject here -
    // a `using` binding would pull `[Symbol.dispose]` into the test's observable surface, which is the domain of the dispose-specific tests further down. Using `void`
    // on the construction expression (rather than binding it to `_watchdog` or similar) keeps the test's focus on the side-effect count, not the handle lifetime.
    const controller = new AbortController();
    let fired = 0;

    void new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    mock.timers.tick(80);

    assert.equal(fired, 0, "a watchdog that was never armed must stay dormant");
  });

  test("re-arming restarts the window", async () => {

    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 50 });

    // Arm, wait part of the window, re-arm, wait part of the new window. If re-arm did not restart, the first arm's timer would fire around the 60ms mark.
    watchdog.arm();

    mock.timers.tick(25);
    watchdog.arm();
    mock.timers.tick(35);

    assert.equal(fired, 0, "re-arming must cancel the pending fire and restart from the new arm");

    mock.timers.tick(40);

    assert.equal(fired, 1, "fires after the re-armed window lapses");
  });
});

describe("Watchdog - signal-driven termination", () => {

  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("signal abort clears the pending fire and suppresses onFire", async () => {

    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();
    controller.abort(new HbpuAbortError("shutdown"));

    mock.timers.tick(80);

    assert.equal(fired, 0, "abort must suppress a pending onFire - the aborted guard is the contract");
  });

  test("arm() is a no-op when the signal is already aborted", async () => {

    const controller = new AbortController();
    let fired = 0;

    controller.abort(new HbpuAbortError("shutdown"));

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    mock.timers.tick(80);

    assert.equal(fired, 0, "arming a watchdog on a pre-aborted signal must schedule no fire");
  });

  test("onFire is skipped when the signal aborts between scheduling and fire", async () => {

    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    // Abort just before the timer fires. The setTimeout callback's aborted-guard is what closes this race, independent of the self-clean listener.
    mock.timers.tick(20);
    controller.abort(new HbpuAbortError("replaced"));
    mock.timers.tick(40);

    assert.equal(fired, 0, "the fire-time aborted guard must honor a last-moment abort even if self-clean did not race first");
  });
});

describe("Watchdog - clear (re-armable)", () => {

  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("clear() cancels a pending fire without aborting anything", async () => {

    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();
    watchdog.clear();

    mock.timers.tick(80);

    assert.equal(fired, 0);
    assert.equal(controller.signal.aborted, false, "clear() must not touch the observed signal");
  });

  test("clear() is safe to call more than once", () => {

    const controller = new AbortController();
    const watchdog = new Watchdog({ onFire: (): void => { /* irrelevant */ }, signal: controller.signal, timeoutMs: 30 });

    watchdog.clear();
    watchdog.clear();
    // No assertion needed - reaching here without throwing is the test.
  });

  test("clear() leaves the watchdog re-armable", async () => {

    // Regression guard: clear() is semantically different from dispose(). Post-clear, `arm()` must still work so callers can re-enter the inactivity window after a
    // deliberate pause - for example, when a producer knows it is going to go quiet for a known interval and wants to defer the watchdog from firing during that gap.
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();
    watchdog.clear();
    watchdog.arm();

    mock.timers.tick(80);

    assert.equal(fired, 1, "clear() must not disable the watchdog - a subsequent arm() must schedule and fire normally");
  });
});

describe("Watchdog - dispose (permanently inert)", () => {

  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("[Symbol.dispose] clears a pending fire", async () => {

    const controller = new AbortController();
    let fired = 0;

    {

      using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

      watchdog.arm();
    }

    mock.timers.tick(80);

    assert.equal(fired, 0, "scope-bound `using` must cancel the pending fire when the block exits");
  });

  test("arm() after dispose is a no-op (Disposable contract)", async () => {

    // Regression guard: a post-dispose `arm()` must NOT schedule a timer. The `using` declaration's entire value proposition is that the resource is dead when the
    // block exits; a re-armable post-dispose watchdog would silently violate that, producing fires after the scope the caller believes owns the resource has exited.
    const controller = new AbortController();
    let fired = 0;
    const watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog[Symbol.dispose]();
    watchdog.arm();

    mock.timers.tick(80);

    assert.equal(fired, 0, "arm() after dispose must be a no-op - the Disposable contract demands the resource is dead");
  });

  test("arm() between dispose() calls still cannot resurrect the watchdog", async () => {

    // Hardening: cycle dispose -> arm -> dispose several times. Each arm must remain a no-op. This guards against a hypothetical regression where someone adds a
    // `#disposed = false` reset to dispose (so repeat disposal stops being a no-op) or to arm (breaking the contract).
    const controller = new AbortController();
    let fired = 0;
    const watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 20 });

    for(let i = 0; i < 3; i++) {

      watchdog[Symbol.dispose]();
      watchdog.arm();
    }

    mock.timers.tick(80);

    assert.equal(fired, 0, "repeated dispose/arm cycles must never resurrect the watchdog");
  });

  test("[Symbol.dispose] is safe to call more than once", () => {

    const controller = new AbortController();
    const watchdog = new Watchdog({ onFire: (): void => { /* irrelevant */ }, signal: controller.signal, timeoutMs: 30 });

    watchdog[Symbol.dispose]();
    watchdog[Symbol.dispose]();
    // No assertion needed - reaching here without throwing is the test.
  });

  test("[Symbol.dispose] does not touch the observed signal", () => {

    // Contract boundary: the watchdog does not own the signal, so disposing the watchdog must not abort the signal. Consumers who want teardown to propagate to the
    // signal wire that through their own controllers - the watchdog is a pure observer.
    const controller = new AbortController();

    using watchdog = new Watchdog({ onFire: (): void => { /* irrelevant */ }, signal: controller.signal, timeoutMs: 30 });

    watchdog[Symbol.dispose]();

    assert.equal(controller.signal.aborted, false, "disposing a Watchdog must not abort the signal it observed");
  });
});

describe("prefixedLog", () => {

  test("prefixes the message, passes the parameters through untouched, and calls only the matching level", () => {

    // The wrapper prepends the supplier's value and the family's ": " separator to the message string, leaves the parameter list exactly as the caller passed it, and
    // routes to the base level of the same name and no other.
    const base = capturingLog();
    const wrapped = prefixedLog(base, () => "Front Door");

    wrapped.info("Connected to %s.", "host");

    assert.equal(base.entries.length, 1, "only the info level must have been called");

    const entry = expectAt(base.entries, 0, "the info entry");

    assert.equal(entry.level, "info");
    assert.equal(entry.message, "Front Door: Connected to %s.");
    assert.deepEqual(entry.params, ["host"]);
  });

  test("evaluates the prefix supplier on every call so a changed identity flows into the very next line", () => {

    // The prefix is a supplier, not a captured string, so a renamed accessory or retitled controller reaches the next line without any re-wiring. A supplier that
    // yields "A" then "B" produces those prefixes in order.
    const base = capturingLog();
    const prefixes = [ "A", "B" ];
    const wrapped = prefixedLog(base, () => prefixes.shift() ?? "?");

    wrapped.info("first");
    wrapped.info("second");

    assert.deepEqual(base.entries.map((entry) => entry.message), [ "A: first", "B: second" ]);
  });

  test("the composed output matches formatting the prefixed message directly, for parameterized and bare messages", () => {

    const base = capturingLog();
    const prefix = "Camera 3";
    const wrapped = prefixedLog(base, () => prefix);

    // The parameterized case exercises %s, %d, and a trailing object parameter; the bare case has no parameters at all. In each, formatting the wrapper's captured
    // message and parameters must equal writing the prefix into the caller's own format string and formatting that, which proves the prefix rides the format string and
    // the parameters reach the sink untouched.
    wrapped.info("Motion on %s at %d.", "front", 5, { zone: "porch" });
    wrapped.warn("Stream stalled.");

    const parameterized = expectAt(base.entries, 0, "the parameterized entry");
    const bare = expectAt(base.entries, 1, "the bare entry");

    assert.equal(util.format(parameterized.message, ...parameterized.params), util.format(prefix + ": " + "Motion on %s at %d.", "front", 5, { zone: "porch" }));
    assert.equal(util.format(bare.message, ...bare.params), util.format(prefix + ": " + "Stream stalled."));
  });

  test("each wrapped level routes to the base method of the same name and no other", () => {

    const base = capturingLog();
    const wrapped = prefixedLog(base, () => "X");

    wrapped.debug("d");
    wrapped.error("e");
    wrapped.info("i");
    wrapped.warn("w");

    // Each level is present exactly once, in call order, carrying its own prefixed message - so no level routes to a sibling method.
    assert.deepEqual(base.entries.map((entry) => ({ level: entry.level, message: entry.message })), [

      { level: "debug", message: "X: d" },
      { level: "error", message: "X: e" },
      { level: "info", message: "X: i" },
      { level: "warn", message: "X: w" }
    ]);
  });
});

describe("formatBps", () => {

  test("returns bits per second for sub-1000 values", () => {

    // Values below the kilobit boundary are returned verbatim with a "bps" suffix; no fractional precision is introduced.
    assert.equal(formatBps(0), "0 bps");
    assert.equal(formatBps(500), "500 bps");
    assert.equal(formatBps(999), "999 bps");
  });

  test("returns integer kbps for round thousand boundaries", () => {

    // Exact multiples of 1000 bits per second must not pick up a phantom decimal - the formatter suppresses the fractional part when (value % 1000) === 0.
    assert.equal(formatBps(1000), "1 kbps");
    assert.equal(formatBps(15000), "15 kbps");
    assert.equal(formatBps(999000), "999 kbps");
  });

  test("returns one-decimal kbps for non-round values", () => {

    // Non-integral kbps values retain a single decimal - the formatter's stated precision contract for "human readable" output.
    assert.equal(formatBps(1500), "1.5 kbps");
    assert.equal(formatBps(2000), "2 kbps");
    assert.equal(formatBps(2500), "2.5 kbps");
  });

  test("returns integer Mbps for round million boundaries", () => {

    // Parallel contract to the kbps path: exact multiples of 1_000_000 bits per second carry no decimal.
    assert.equal(formatBps(1_000_000), "1 Mbps");
    assert.equal(formatBps(5_000_000), "5 Mbps");
  });

  test("returns one-decimal Mbps for non-round megabit values", () => {

    assert.equal(formatBps(2_560_000), "2.6 Mbps");
    assert.equal(formatBps(1_500_000), "1.5 Mbps");
  });
});

describe("formatBytes", () => {

  test("returns raw bytes for sub-1024 values", () => {

    // Values below the kilobyte boundary are returned verbatim with a "bytes" suffix; no fractional precision is introduced.
    assert.equal(formatBytes(0), "0 bytes");
    assert.equal(formatBytes(512), "512 bytes");
    assert.equal(formatBytes(1023), "1023 bytes");
  });

  test("returns integer KB for round 1024 boundaries", () => {

    // Exact multiples of 1024 bytes must not pick up a phantom decimal - the formatter suppresses the fractional part when (value % 1024) === 0.
    assert.equal(formatBytes(1024), "1 KB");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(1023 * 1024), "1023 KB");
  });

  test("returns one-decimal KB for non-round values", () => {

    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(2560), "2.5 KB");
  });

  test("returns integer MB at megabyte boundaries", () => {

    assert.equal(formatBytes(1_048_576), "1 MB");
    assert.equal(formatBytes(5 * 1_048_576), "5 MB");
  });

  test("returns one-decimal MB for non-round megabyte values", () => {

    assert.equal(formatBytes(2_621_440), "2.5 MB");
    assert.equal(formatBytes(1_572_864), "1.5 MB");
  });

  test("returns integer GB at gigabyte boundaries", () => {

    assert.equal(formatBytes(1_073_741_824), "1 GB");
    assert.equal(formatBytes(2 * 1_073_741_824), "2 GB");
  });

  test("returns one-decimal GB for non-round gigabyte values", () => {

    assert.equal(formatBytes(1.5 * 1_073_741_824), "1.5 GB");
  });

  test("returns integer TB at terabyte boundaries", () => {

    // Pins the cap-tier promotion: once a value reaches 1024 GB it must surface as "1 TB" rather than awkwardly continuing in the GB tier as "1024 GB".
    assert.equal(formatBytes(1_099_511_627_776), "1 TB");
    assert.equal(formatBytes(2 * 1_099_511_627_776), "2 TB");
  });

  test("returns one-decimal TB for non-round terabyte values", () => {

    assert.equal(formatBytes(1.5 * 1_099_511_627_776), "1.5 TB");
  });
});

describe("formatErrorMessage", () => {

  test("renders an Error instance through its .message and strips the trailing period", () => {

    // Errors thrown by Node libraries and platform APIs frequently end with a period (e.g., "connect ECONNREFUSED 127.0.0.1:1."); the embedding log line itself
    // ends with a period, so leaving the source error's trailing period in place produces "...:1.." in the rendered output. The formatter strips exactly one
    // trailing period so the renderer's own punctuation is the canonical end-of-sentence marker.
    assert.equal(formatErrorMessage(new Error("device refused update.")), "device refused update");
  });

  test("renders an Error without a trailing period unchanged", () => {

    assert.equal(formatErrorMessage(new Error("device refused update")), "device refused update");
  });

  test("coerces non-Error rejections through String(...)", () => {

    // Promise rejections can carry any value; defensive callers must surface a renderable string regardless of the thrown shape.
    assert.equal(formatErrorMessage("string-shaped failure"), "string-shaped failure");
    assert.equal(formatErrorMessage(42), "42");
    assert.equal(formatErrorMessage(null), "null");
    assert.equal(formatErrorMessage(undefined), "undefined");
  });

  test("strips a trailing period from non-Error string rejections too", () => {

    // The trailing-period strip applies uniformly across both branches so the renderer cannot accidentally produce ".." for either Error or non-Error inputs.
    assert.equal(formatErrorMessage("string-shaped failure."), "string-shaped failure");
  });

  test("strips only a single trailing period (multiple-period suffixes survive)", () => {

    // Some upstream error messages legitimately end with an ellipsis or a deliberate "..". The formatter's contract is "strip a single trailing period" - it is
    // not an ellipsis-canonicalizer. We pin this so a future refactor does not silently broaden the strip pattern.
    assert.equal(formatErrorMessage(new Error("ellipsis...")), "ellipsis..");
  });
});

describe("formatMs", () => {

  test("returns raw milliseconds for sub-second values", () => {

    assert.equal(formatMs(0), "0 ms");
    assert.equal(formatMs(250), "250 ms");
    assert.equal(formatMs(999), "999 ms");
  });

  test("returns seconds at the second boundary, with one decimal for fractional values", () => {

    assert.equal(formatMs(1_000), "1 s");
    assert.equal(formatMs(1_500), "1.5 s");
    assert.equal(formatMs(15_000), "15 s");
    assert.equal(formatMs(59_500), "59.5 s");
  });

  test("returns minutes once values reach the minute boundary", () => {

    assert.equal(formatMs(60_000), "1 min");
    assert.equal(formatMs(90_000), "1.5 min");
    assert.equal(formatMs(1_800_000), "30 min");
  });

  test("returns hours once values reach the hour boundary", () => {

    assert.equal(formatMs(3_600_000), "1 hr");
    assert.equal(formatMs(5_400_000), "1.5 hr");
  });
});

describe("formatPercent", () => {

  test("renders integer percentages without a trailing decimal", () => {

    // Matches the shared precision policy: whole numbers carry no decimal place, keeping the rendered line free of "50.0%"-style noise.
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(50), "50%");
    assert.equal(formatPercent(100), "100%");
  });

  test("renders fractional percentages with a single decimal place", () => {

    // Non-integral values get one decimal through the same formatMagnitude helper used by the magnitude-based formatters, so precision policy stays uniform across
    // every util.ts format helper.
    assert.equal(formatPercent(33.333), "33.3%");
    assert.equal(formatPercent(0.5), "0.5%");
    assert.equal(formatPercent(75.5), "75.5%");
  });
});

describe("formatSeconds", () => {

  test("returns raw seconds for sub-minute values", () => {

    assert.equal(formatSeconds(0), "0 s");
    assert.equal(formatSeconds(45), "45 s");
    assert.equal(formatSeconds(59), "59 s");
  });

  test("returns minutes at the minute boundary, with one decimal for fractional values", () => {

    assert.equal(formatSeconds(60), "1 min");
    assert.equal(formatSeconds(90), "1.5 min");
    assert.equal(formatSeconds(1_800), "30 min");
  });

  test("returns hours once values reach the hour boundary", () => {

    assert.equal(formatSeconds(3_600), "1 hr");
    assert.equal(formatSeconds(5_400), "1.5 hr");
  });
});

describe("defaultRetryBackoff", () => {

  test("starts at 1 second for the second attempt", () => {

    // retry() never calls backoff for attempt 1 - the first attempt runs immediately - so the policy's anchor is attempt 2 at 1_000ms.
    assert.equal(defaultRetryBackoff(2), 1_000);
  });

  test("doubles exponentially until the 30-second ceiling", () => {

    assert.equal(defaultRetryBackoff(3), 2_000);
    assert.equal(defaultRetryBackoff(4), 4_000);
    assert.equal(defaultRetryBackoff(5), 8_000);
    assert.equal(defaultRetryBackoff(6), 16_000);
  });

  test("caps at 30 seconds regardless of attempt number", () => {

    // The Math.min(30_000, ...) clamp is the contract: arbitrarily large attempt numbers stay at the ceiling.
    assert.equal(defaultRetryBackoff(7), 30_000);
    assert.equal(defaultRetryBackoff(10), 30_000);
    assert.equal(defaultRetryBackoff(100), 30_000);
  });
});

describe("runWithAbort", () => {

  test("returns the factory's value when neither timeout nor external signal fires", async () => {

    const result = await runWithAbort(async () => "ok", { timeout: 1_000 });

    assert.equal(result, "ok");
  });

  test("returns null when the timeout elapses before the factory settles", async () => {

    // A factory that waits for its signal models the idiomatic usage - any abortable operation (fetch, events.once) would behave the same under a 5ms budget.
    const result = await runWithAbort<string>(async (signal) => {

      await once(signal, "abort");

      throw signal.reason;
    }, { timeout: 5 });

    assert.equal(result, null);
  });

  test("returns null when an external pre-aborted signal is supplied", async () => {

    // Fast path: an already-aborted signal short-circuits before the factory runs. We prove the factory never ran by failing the test from inside it if it does.
    const controller = new AbortController();

    controller.abort(new HbpuAbortError("shutdown"));

    let invoked = false;
    const result = await runWithAbort(async () => {

      invoked = true;

      return "unreachable";
    }, { signal: controller.signal });

    assert.equal(result, null);
    assert.equal(invoked, false);
  });

  test("returns null when the external signal aborts while the factory is pending", async () => {

    const controller = new AbortController();

    queueMicrotask(() => { controller.abort(new HbpuAbortError("replaced")); });

    const result = await runWithAbort(async (signal) => {

      await once(signal, "abort");

      throw signal.reason;
    }, { signal: controller.signal });

    assert.equal(result, null);
  });

  test("propagates genuine factory errors when no abort has fired", async () => {

    // Errors that originate inside the factory - not driven by cancellation - must surface unchanged. The signal-aborted branch in the catch must not swallow them.
    const boom = new Error("factory exploded");

    await assert.rejects(runWithAbort(async () => { throw boom; }, { timeout: 50 }), (error: unknown) => error === boom);
  });

  test("composes timeout and external signal - whichever fires first wins", async () => {

    // With a generous timeout and a near-immediate external abort, the external signal reliably wins. We verify by observing the composed signal's abort reason inside
    // the factory.
    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    queueMicrotask(() => { controller.abort(reason); });

    let observedReason: unknown;
    const result = await runWithAbort(async (signal) => {

      await once(signal, "abort");

      observedReason = signal.reason;

      throw signal.reason;
    }, { signal: controller.signal, timeout: 5_000 });

    assert.equal(result, null);
    assert.equal(observedReason, reason);
  });
});

describe("toStartCase", () => {

  test("capitalizes the first letter of every word", () => {

    assert.equal(toStartCase("this is a test"), "This Is A Test");
  });

  test("leaves already-capitalized words unchanged", () => {

    assert.equal(toStartCase("Hello World"), "Hello World");
  });

  test("handles a single word", () => {

    assert.equal(toStartCase("hello"), "Hello");
  });

  test("returns an empty string for empty input", () => {

    assert.equal(toStartCase(""), "");
  });

  test("capitalizes after runs of whitespace", () => {

    // The regex matches `\s+\w`, so runs of whitespace are treated as a single separator and the next word still gets capitalized.
    assert.equal(toStartCase("foo   bar"), "Foo   Bar");
  });
});

describe("validateName", () => {

  test("accepts a plain alphanumeric name", () => {

    assert.equal(validateName("Living Room Lamp"), true);
  });

  test("accepts the allowed special characters inside the name", () => {

    // HomeKit allows -"',.#& as interior characters - the regex permits them in the body but still requires letter/number bookends.
    assert.equal(validateName("Kitchen-Lamp"), true);
    assert.equal(validateName("O'Brien 1"), true);
    assert.equal(validateName("Room 2.0"), true);
  });

  test("permits a trailing period", () => {

    // The regex explicitly lists `.` as an allowed end character alongside letters and numbers.
    assert.equal(validateName("Device."), true);
  });

  test("rejects names that start with a disallowed character", () => {

    assert.equal(validateName(" Leading Space"), false);
    assert.equal(validateName("-Dash"), false);
  });

  test("rejects names that end with a disallowed non-period character", () => {

    assert.equal(validateName("Trailing-"), false);
    assert.equal(validateName("Trailing "), false);
  });

  test("rejects double spaces", () => {

    assert.equal(validateName("Two  Spaces"), false);
  });

  test("rejects names containing emoji", () => {

    // The `(?!.*\p{Extended_Pictographic})` lookahead is the emoji-exclusion guard - any pictographic code point anywhere in the name fails the match.
    assert.equal(validateName("Rocket \u{1F680}"), false);
  });

  test("rejects names containing disallowed punctuation", () => {

    assert.equal(validateName("Test|Switch"), false);
    assert.equal(validateName("Test/Switch"), false);
  });
});

describe("sanitizeName", () => {

  test("returns a valid name unchanged", () => {

    // Fast path: when the input already satisfies validateName, the sanitizer returns early without invoking the replacement chain.
    const input = "Living Room Lamp";

    assert.equal(sanitizeName(input), input);
  });

  test("replaces disallowed characters with spaces", () => {

    // Pipe is the canonical JSDoc example - it becomes a space, which then survives the whitespace-squash pass since there are no adjacent spaces.
    assert.equal(sanitizeName("Test|Switch"), "Test Switch");
  });

  test("collapses multiple spaces introduced by replacement", () => {

    // Two disallowed characters in a row would produce two spaces; the `\s+` collapse reduces them to one.
    assert.equal(sanitizeName("A||B"), "A B");
  });

  test("trims leading and trailing whitespace", () => {

    assert.equal(sanitizeName("  Hello  "), "Hello");
  });

  test("strips leading non-letter / non-number characters", () => {

    // Leading hyphen is allowed in the body but forbidden as the first character. The sanitizer strips it so the result is well-formed.
    assert.equal(sanitizeName("-Switch"), "Switch");
  });

  test("collapses two or more trailing periods to a single period", () => {

    // A bare "Device..." already satisfies validateName (ends with `.`), so the fast path would return it unchanged. To exercise the ellipsis-collapse step we pair it
    // with a leading dash, which forces the slow replacement chain; the leading-non-letter strip + trailing-period collapse together produce "Device.".
    assert.equal(sanitizeName("-Device..."), "Device.");
  });

  test("strips a trailing non-letter / non-number / non-period character", () => {

    // After emoji replacement this name ends with a space. The sanitizer trims, then strips any remaining trailing non-letter/number/period character.
    assert.equal(sanitizeName("Device \u{1F680}"), "Device");
  });

  test("removes emojis entirely", () => {

    // Pictographic code points fall through the character-class replacement to a space, which is then trimmed out from the ends.
    assert.equal(sanitizeName("Rocket \u{1F680} Lamp"), "Rocket Lamp");
  });

  test("produces a HomeKit-valid result from a messy input", () => {

    // Round-trip: the sanitizer's output should itself pass validateName for any non-empty input with at least one valid character. This guards against subtle regex
    // regressions that could leave invalid residue (double spaces, trailing junk, etc.).
    const messy = "  --Living | Room \u{1F680} Lamp...   ";
    const cleaned = sanitizeName(messy);

    assert.equal(validateName(cleaned), true);
    assert.equal(cleaned, "Living Room Lamp.");
  });
});
