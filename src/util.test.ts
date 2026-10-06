/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * util.test.ts: Unit tests for the primitives exported by util.ts - HbpuAbortError, isHbpuAbortError, isHbpuAbortReason, isTimeoutReason, hasErrorCode, causeChain,
 * onAbort, waitWithSignal, sameEntries, membershipDelta, the signal-aware retry(), the takeLast() ring buffer, composeSignals, superviseLoop, superviseStream,
 * loopFaultReporter, guardedDispatch, Watchdog, prefixedLog, debugGatedLog, repeatDemotedLog, consoleLog, and the string/number helpers (formatBps, formatBytes,
 * formatMs, formatSeconds, formatPercent, formatErrorMessage, formatUrlHost, defaultRetryBackoff, exponentialBackoff, runWithAbort, toStartCase, sanitizeName,
 * validateName), and the numeric option guards assertPositiveInteger and assertPositiveFinite.
 */
import { HbpuAbortError, Watchdog, assertPositiveFinite, assertPositiveInteger, causeChain, composeSignals, consoleLog, debugGatedLog, defaultRetryBackoff,
  exponentialBackoff, formatBps, formatBytes, formatErrorMessage, formatMs, formatPercent, formatSeconds, formatUrlHost, guardedDispatch, hasErrorCode,
  isHbpuAbortError, isHbpuAbortReason, isTimeoutReason, loopFaultReporter, membershipDelta, onAbort, parseJson, prefixedLog, repeatDemotedLog, retry,
  runWithAbort, sameEntries, sanitizeName, superviseLoop, superviseStream, takeLast, toStartCase, validateName, waitWithSignal } from "./util.ts";
import { advanceThroughSchedule, assertNoUnhandledRejections, capturingLog, errnoError, expectAt, formatLogEntry, settle } from "./testing/index.ts";
import { describe, test } from "node:test";
import type { RetryBackoff } from "./util.ts";
import { TestClock } from "./clock-double.ts";
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

describe("hasErrorCode", () => {

  test("returns true for an Error carrying the code, and narrows it", () => {

    const error: unknown = errnoError("address already in use", "EADDRINUSE");

    assert.equal(hasErrorCode(error, "EADDRINUSE"), true);

    // The narrowing is the second half of the contract: inside the guard the code reads as the literal that was matched rather than as a widened string.
    if(hasErrorCode(error, "EADDRINUSE")) {

      const code: "EADDRINUSE" = error.code;

      assert.equal(code, "EADDRINUSE");

      return;
    }

    assert.fail("expected the type predicate to accept an Error carrying the code");
  });

  test("returns false for an Error carrying a different code", () => {

    assert.equal(hasErrorCode(errnoError("no such file", "ENOENT"), "EADDRINUSE"), false);
  });

  test("returns false for an Error carrying no code at all", () => {

    assert.equal(hasErrorCode(new Error("plain"), "EADDRINUSE"), false);
  });

  test("returns false for a plain object carrying the code", () => {

    // The `instanceof` term is what refuses this one. A rejection that is not an Error but happens to spell the field is not the failure the caller is asking about.
    assert.equal(hasErrorCode({ code: "EADDRINUSE" }, "EADDRINUSE"), false);
  });

  test("returns false for values carrying nothing at all", () => {

    for(const value of [ undefined, null, "EADDRINUSE", 0 ]) {

      assert.equal(hasErrorCode(value, "EADDRINUSE"), false);
    }
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
    // cannot drive the handler more than once. Asserts the rule so a future refactor that breaks either side shows up loudly.
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

    // `removeEventListener` is a no-op for already-removed listeners per spec, so disposing twice must be a safe no-op. Asserts the contract so a caller that both
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

      using abortRegistration = onAbort(controller.signal, () => {

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

  test("rejects with signal.reason when the signal is already aborted and the promise is still pending", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    controller.abort(reason);

    // A wait that is still waiting is what a signal that has already aborted ends: a promise that never settles, and one that settles only after the call was
    // made - a microtask later is enough - are both answered with the signal's reason, because the abort was the earlier of the two.
    await assert.rejects(waitWithSignal(new Promise<string>(() => { /* pending forever */ }), controller.signal), (error: unknown) => error === reason);
    await assert.rejects(waitWithSignal(Promise.resolve().then(() => "late"), controller.signal), (error: unknown) => error === reason);
  });

  test("delivers a promise that has already settled even when the signal is already aborted", async () => {

    // An abort ends only a wait that is still waiting: a promise that settled before the call is delivered as it settled, fulfilled or rejected, and the signal's
    // reason never displaces an answer that already exists.
    const controller = new AbortController();
    const boom = new Error("boom");

    controller.abort(new HbpuAbortError("shutdown"));

    const delivered = await waitWithSignal(Promise.resolve("ok"), controller.signal);

    assert.equal(delivered, "ok", "a fulfilled promise must be delivered under a signal that has already aborted");
    await assert.rejects(waitWithSignal(Promise.reject(boom), controller.signal), (error: unknown) => error === boom);
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

    // The pre-aborted path attaches the rejection reaction to `promise` before the deferred rejection on the signal's reason lands, so a later rejection of
    // `promise` is observed.
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

describe("sameEntries", () => {

  // The comparator every test that does not care about delegation uses: entries are records, and equality is whichever fields the caller cares about.
  interface Row { id: string; name: string }

  const sameRow = (x: Row, y: Row): boolean => (x.id === y.id) && (x.name === y.name);

  test("arrays of equal length whose every pair the comparator accepts are equal", () => {

    const a: Row[] = [ { id: "1", name: "One" }, { id: "2", name: "Two" } ];
    const b: Row[] = [ { id: "1", name: "One" }, { id: "2", name: "Two" } ];

    assert.equal(sameEntries(a, b, sameRow), true, "distinct objects with equal fields are equal entries");
  });

  test("a single differing pair makes the arrays unequal", () => {

    const a: Row[] = [ { id: "1", name: "One" }, { id: "2", name: "Two" } ];
    const b: Row[] = [ { id: "1", name: "One" }, { id: "2", name: "Deux" } ];

    assert.equal(sameEntries(a, b, sameRow), false);
  });

  test("a length mismatch is unequal without consulting the comparator", () => {

    let invoked = 0;
    const same = (x: Row, y: Row): boolean => {

      invoked++;

      return sameRow(x, y);
    };

    assert.equal(sameEntries([{ id: "1", name: "One" }], [ { id: "1", name: "One" }, { id: "2", name: "Two" } ], same), false);
    assert.equal(invoked, 0, "a length difference settles it before any pair is examined");
  });

  test("two empty arrays are equal", () => {

    assert.equal(sameEntries<Row>([], [], sameRow), true);
  });

  test("equality is the comparator's to decide, not the entries' own", () => {

    // The comparator is the whole point of the helper: identical objects can be unequal and differing ones equal, because only the caller knows which fields matter.
    const a: Row[] = [{ id: "1", name: "One" }];
    const b: Row[] = [{ id: "1", name: "Uno" }];

    assert.equal(sameEntries(a, b, (x, y) => x.id === y.id), true, "a comparator that reads only the id ignores the name");
    assert.equal(sameEntries(a, a, () => false), false, "a comparator that refuses everything makes an array unequal to itself");
  });

  test("the comparator is invoked once per pair and stops at the first difference", () => {

    const seen: string[] = [];
    const a: Row[] = [ { id: "1", name: "One" }, { id: "2", name: "Two" }, { id: "3", name: "Three" } ];
    const b: Row[] = [ { id: "1", name: "One" }, { id: "X", name: "Two" }, { id: "3", name: "Three" } ];

    sameEntries(a, b, (x, y) => {

      seen.push(x.id);

      return sameRow(x, y);
    });

    assert.deepEqual(seen, [ "1", "2" ], "the walk short-circuits at the second pair rather than finishing the array");
  });

  test("exactly one undefined side is unequal, and the comparator never sees it", () => {

    let invoked = 0;
    const same = (x: number, y: number): boolean => {

      invoked++;

      return x === y;
    };

    assert.equal(sameEntries<number | undefined>([ 1, undefined ], [ 1, 2 ], same as (x: number | undefined, y: number | undefined) => boolean), false,
      "an undefined slot never false-matches a present one");
    assert.equal(sameEntries<number | undefined>([ 1, undefined, 3 ], [ 1, 2, 3 ], same as (x: number | undefined, y: number | undefined) => boolean), false,
      "an undefined slot in the middle settles it before the equal tail is reached");
    assert.equal(invoked, 2, "each call reached the comparator exactly once - for its leading pair, the only one with both sides present");
  });

  test("both sides undefined is equal without invoking the comparator", () => {

    let invoked = 0;
    const never = (): boolean => {

      invoked++;

      return false;
    };

    assert.equal(sameEntries<undefined>([undefined], [undefined], never), true, "two absent entries are not a difference");
    assert.equal(invoked, 0, "the comparator is not asked about a pair with nothing in it");
  });
});

describe("membershipDelta", () => {

  test("two empty inputs leave both sides empty", () => {

    const delta = membershipDelta<string>([], []);

    assert.deepEqual(delta.toAdd, []);
    assert.deepEqual(delta.toRemove, []);
  });

  test("everything the source reports against nothing configured is an arrival", () => {

    const delta = membershipDelta([ "a", "b" ], []);

    assert.deepEqual(delta.toAdd, [ "a", "b" ]);
    assert.deepEqual(delta.toRemove, []);
  });

  test("everything configured against a source reporting nothing is a departure", () => {

    const delta = membershipDelta<string>([], [ "a", "b" ]);

    assert.deepEqual(delta.toAdd, []);
    assert.deepEqual(delta.toRemove, [ "a", "b" ]);
  });

  test("ids on both sides are reported as neither arrival nor departure", () => {

    const delta = membershipDelta([ "arrived", "kept", "also-kept" ], [ "kept", "also-kept", "departed" ]);

    assert.deepEqual(delta.toAdd, ["arrived"], "the shared middle is not an arrival");
    assert.deepEqual(delta.toRemove, ["departed"], "the shared middle is not a departure");
  });

  test("each side keeps the order of the input it came from", () => {

    const delta = membershipDelta([ "c", "a", "b" ], [ "z", "y" ]);

    assert.deepEqual(delta.toAdd, [ "c", "a", "b" ], "arrivals stay in the order the source reported them rather than being sorted");
    assert.deepEqual(delta.toRemove, [ "z", "y" ], "departures stay in the order they were configured in rather than being sorted");
  });

  test("an id repeated within an input is repeated in that input's output", () => {

    const delta = membershipDelta([ "a", "a", "b" ], [ "c", "c" ]);

    assert.deepEqual(delta.toAdd, [ "a", "a", "b" ], "filtering the array rather than a set of it is what keeps the repeat");
    assert.deepEqual(delta.toRemove, [ "c", "c" ]);
  });

  test("numeric ids diff exactly as string ids do", () => {

    const delta = membershipDelta([ 3, 1, 4 ], [ 1, 5 ]);

    assert.deepEqual(delta.toAdd, [ 3, 4 ]);
    assert.deepEqual(delta.toRemove, [5]);
  });

  // Identity is `Set`'s own comparison, SameValueZero, which parts from strict equality at NaN - it finds itself here, so a reported NaN counts as already
  // configured rather than as an arrival - and from Object.is at -0, which it holds to be the same id as 0.
  test("identity is SameValueZero rather than strict equality", () => {

    const delta = membershipDelta([ NaN, -0 ], [ NaN, 0 ]);

    assert.deepEqual(delta.toAdd, [], "NaN matches NaN and -0 matches 0, so neither reported id counts as new");
    assert.deepEqual(delta.toRemove, [], "the same identity rule in the other direction leaves nothing configured to drop");
  });

  test("neither input is mutated", () => {

    const currentIds = [ "a", "b" ];
    const configuredIds = [ "b", "c" ];
    const currentBefore = [...currentIds];
    const configuredBefore = [...configuredIds];

    membershipDelta(currentIds, configuredIds);

    assert.deepEqual(currentIds, currentBefore, "the reported ids come back untouched");
    assert.deepEqual(configuredIds, configuredBefore, "the configured ids come back untouched");
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

    // Seven values into a ring of four carries the write cursor past its zero boundary once; it lands at index 3 (7 % 4), so the rotation that reconstructs order
    // must read from slot 3 forward, wrapping once. The expected tail is the final four values in order, which only holds if the wrap math is correct.
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
    }, { attempts: 0 }), /attempts.*must be a positive integer/);

    assert.equal(calls, 0);
  });

  test("rejects a fractional or non-positive attempts count with the shared refusal, and accepts one", async () => {

    // The budget is a count of attempts, so a fraction is a budget no attempt number ever lands on. A caller that wants an unbounded run asks for it with the
    // documented `Infinity` sentinel rather than with a fractional or zero count, which is the case the count check is excluded for.
    let calls = 0;

    await assert.rejects(retry(async () => "unreachable", { attempts: 1.5 }),
      { constructor: TypeError, message: "retry: `attempts` must be a positive integer." });
    await assert.rejects(retry(async () => "unreachable", { attempts: 0 }),
      { constructor: TypeError, message: "retry: `attempts` must be a positive integer." });

    assert.equal(await retry(async () => {

      calls++;

      return "once";
    }, { attempts: 1 }), "once", "a budget of one is the smallest count the loop can honor");
    assert.equal(calls, 1, "a budget of one runs the operation exactly once");
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

  test("runs a whole backoff schedule on an injected clock, consulting the policy once per gap", async () => {

    const clock = new TestClock();
    const consulted: number[] = [];
    let calls = 0;
    const attempt = retry(async () => {

      calls++;

      throw new Error("attempt-" + calls.toString());
    }, { attempts: 4, backoff: (attemptNumber) => {

      consulted.push(attemptNumber);

      return attemptNumber * 10000;
    }, clock });

    // Attach the rejection handler before driving the clock. The retry rejects partway through the schedule below, and a promise left unobserved across a macrotask
    // boundary would surface as an unhandled rejection rather than as this row's assertion.
    const rejection = assert.rejects(attempt, /attempt-4/);

    await advanceThroughSchedule(clock, [ 20000, 30000, 40000 ]);
    await rejection;

    assert.equal(calls, 4, "every attempt in the budget ran");
    assert.deepEqual(consulted, [ 2, 3, 4 ], "the policy is consulted once per gap, with the 1-indexed attempt about to run");
    assert.equal(clock.now(), 90000, "the gaps summed to exactly the scheduled backoff total on virtual time");
    assert.equal(clock.pending, 0, "no backoff wait was left registered on the clock");
  });

  test("holds a backoff wait until virtual time reaches the deadline exactly", async () => {

    const clock = new TestClock();
    let calls = 0;
    const attempt = retry(async () => {

      calls++;

      if(calls < 2) {

        throw new Error("transient");
      }

      return "done";
    }, { attempts: 2, backoff: () => 5000, clock });

    await settle();

    assert.equal(clock.pending, 1, "the first failure parked retry on a backoff wait the injected clock holds");
    assert.equal(calls, 1, "the second attempt has not run yet");

    // One tick short of the deadline. A wait that released early - or a backoff that ignored the injected clock and reached for a real timer - would have run the
    // second attempt by now, so this is where the boundary is proven rather than assumed.
    clock.advance(4999);
    await settle();

    assert.equal(calls, 1, "a wait one millisecond short of the deadline still holds the next attempt");
    assert.equal(clock.pending, 1, "and the delay is still registered");

    clock.advance(1);

    assert.equal(await attempt, "done", "the final millisecond releases the wait and the next attempt succeeds");
    assert.equal(clock.now(), 5000, "the wait ran exactly the policy-dictated backoff, not a millisecond more");
    assert.equal(clock.pending, 0, "the released wait left nothing registered behind it");
  });

  test("an abort interrupts a backoff wait the injected clock is holding, and still rejects with signal.reason", async () => {

    const controller = new AbortController();
    const reason = new HbpuAbortError("replaced");
    const clock = new TestClock();
    let calls = 0;
    const attempt = retry(async () => {

      calls++;

      throw new Error("transient");
    }, { attempts: 5, backoff: () => 200000, clock, signal: controller.signal });
    const rejection = assert.rejects(attempt, (error: unknown) => error === reason);

    await settle();

    assert.equal(clock.pending, 1, "the first failure is parked on a backoff wait the clock holds");

    // Abort without advancing virtual time at all. The clock's own rejection is an AbortError that does NOT carry the caller's reason, so this row proves the outer
    // normalizer restores signal.reason for an injected clock's rejection exactly as it does for the platform timer's.
    controller.abort(reason);

    await rejection;

    assert.equal(calls, 1, "the abort preempted the second attempt");
    assert.equal(clock.pending, 0, "the aborted wait was removed from the clock rather than left registered");
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

describe("superviseStream", () => {

  // Drain a supervised stream into an array. Every scenario below consumes through this helper, so "the consumer's for-await exits without throwing" is asserted by the
  // helper simply returning: a stream that surfaced a source failure would reject here and fail the test before any assertion ran.
  async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {

    const received: T[] = [];

    for await (const value of stream) {

      received.push(value);
    }

    return received;
  }

  test("yields every value in order and completes when the source completes", async () => {

    const controller = new AbortController();
    let onErrorCalls = 0;

    const received = await drain(superviseStream({

      onError: () => { onErrorCalls++; },
      signal: controller.signal,
      source: async function *(): AsyncGenerator<number> {

        yield 1;
        yield 2;
        yield 3;
      }
    }));

    assert.deepEqual(received, [ 1, 2, 3 ], "values pass through in source order");
    assert.equal(onErrorCalls, 0, "a source that simply ends is not a fault");
  });

  test("preserves yielded value identity rather than cloning", async () => {

    const controller = new AbortController();
    const payload = { readings: [1] };

    const received = await drain(superviseStream({

      onError: () => undefined,
      signal: controller.signal,
      source: async function *(): AsyncGenerator<object> {

        yield payload;
      }
    }));

    assert.equal(received.length, 1);
    assert.equal(received[0], payload, "the consumer receives the very object the source yielded");
  });

  test("passes the bound signal into the source by identity", async () => {

    const controller = new AbortController();
    const seen: AbortSignal[] = [];

    await drain(superviseStream({

      onError: () => undefined,
      signal: controller.signal,
      source: async function *(signal: AbortSignal): AsyncGenerator<number> {

        seen.push(signal);

        yield 1;
      }
    }));

    assert.deepEqual(seen, [controller.signal], "the source receives the caller's own signal, not a derived one");
  });

  test("delivers a mid-stream fault to onError exactly once and ends the stream without throwing", async () => {

    const controller = new AbortController();
    const boom = new Error("the source failed");
    const observed: unknown[] = [];

    // The stream is drained without a try/catch: a source-originated failure that reached the consumer would fail this test as a thrown await, which is the
    // never-throws guarantee stated as an assertion.
    const received = await assertNoUnhandledRejections(async () => await drain(superviseStream({

      onError: (error) => { observed.push(error); },
      signal: controller.signal,
      source: async function *(): AsyncGenerator<number> {

        yield 1;

        throw boom;
      }
    })));

    assert.deepEqual(received, [1], "the values yielded before the fault still reached the consumer");
    assert.deepEqual(observed, [boom], "the fault reached onError exactly once, with the thrown value unchanged");
  });

  test("swallows a mid-stream throw silently when the signal is aborted, leaving onError uncalled", async () => {

    const controller = new AbortController();
    let onErrorCalls = 0;

    const received = await drain(superviseStream({

      onError: () => { onErrorCalls++; },
      signal: controller.signal,
      // Abort from inside the source, then throw the reason - the orderly teardown path, where the throw is the source unwinding because we tore it down.
      source: async function *(signal: AbortSignal): AsyncGenerator<number> {

        yield 1;

        controller.abort(new HbpuAbortError("shutdown"));

        throw signal.reason;
      }
    }));

    assert.deepEqual(received, [1], "the values yielded before teardown still reached the consumer");
    assert.equal(onErrorCalls, 0, "an abort-driven throw is orderly teardown, not a fault, so onError must not be called");
  });

  test("a pre-aborted signal yields nothing and never invokes the source", async () => {

    const controller = new AbortController();
    let sourceInvoked = false;
    let onErrorCalls = 0;

    controller.abort(new HbpuAbortError("shutdown"));

    const received = await drain(superviseStream({

      onError: () => { onErrorCalls++; },
      signal: controller.signal,
      source: (): AsyncGenerator<number> => {

        // The flag flips in the FACTORY, before any iterable exists, so it catches a source that was called and merely never iterated - the setup cost a torn-down
        // caller must not pay.
        sourceInvoked = true;

        return (async function *(): AsyncGenerator<number> {

          yield 1;
        })();
      }
    }));

    assert.deepEqual(received, [], "a pre-aborted stream yields nothing");
    assert.equal(sourceInvoked, false, "the source is never invoked on a pre-aborted signal");
    assert.equal(onErrorCalls, 0, "a pre-aborted signal is teardown, not a fault");
  });

  test("a consumer that breaks early runs the source's own cleanup", async () => {

    const controller = new AbortController();
    let cleanedUp = false;

    const stream = superviseStream({

      onError: () => undefined,
      signal: controller.signal,
      source: async function *(): AsyncGenerator<number> {

        try {

          yield 1;
          yield 2;
          yield 3;
        } finally {

          cleanedUp = true;
        }
      }
    });

    for await (const value of stream) {

      assert.equal(value, 1);

      break;
    }

    // Breaking out of the consumer's loop drives this generator's return path, which unwinds its own `for await` and closes the source iterator... so the source's
    // `finally` runs even though it never reached its last yield.
    assert.equal(cleanedUp, true, "the source's cleanup ran when the consumer stopped early");
  });

  test("a throw from onError propagates to the consumer", async () => {

    const controller = new AbortController();
    const handlerDefect = new Error("the fault handler itself failed");

    // The never-throws guarantee covers the source, not the handler: a broken onError is the caller's own defect and must not be swallowed into silence.
    await assert.rejects(() => drain(superviseStream({

      onError: () => { throw handlerDefect; },
      signal: controller.signal,
      source: async function *(): AsyncGenerator<number> {

        yield 1;

        throw new Error("the source failed");
      }
    })), (error: unknown) => error === handlerDefect);
  });

  test("supervises a source factory that throws before returning an iterable", async () => {

    const controller = new AbortController();
    const boom = new Error("the source could not be built");
    const observed: unknown[] = [];

    const received = await drain(superviseStream({

      onError: (error) => { observed.push(error); },
      signal: controller.signal,
      source: (): AsyncGenerator<number> => {

        throw boom;
      }
    }));

    assert.deepEqual(received, []);
    assert.deepEqual(observed, [boom], "a factory that throws before yielding anything is supervised like any other fault");
  });

  test("composes with loopFaultReporter: a genuine fault logs exactly once", async () => {

    const controller = new AbortController();
    const log = capturingLog();

    await drain(superviseStream({

      onError: loopFaultReporter(log, "sensor"),
      signal: controller.signal,
      source: async function *(): AsyncGenerator<number> {

        yield 1;

        throw new Error("upstream failed");
      }
    }));

    assert.equal(log.entries.length, 1, "the reporter serves this envelope exactly as it serves superviseLoop");
    assert.equal(expectAt(log.entries, 0, "the logged fault").level, "error");
  });
});

describe("loopFaultReporter", () => {

  // The single canonical template the reporter emits. Stating it here lets the tests assert the exact format string the consumers depend on, so a wording change is a
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

  // The two canonical failure templates the wrapper emits. Stating them here means a wording change is a deliberate test update rather than a silent drift, matching the
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
    const callback = (_error?: Error, value?: string): void => { received.push(value); };

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

  test("fires onFire once the timeout elapses without a re-arm", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    clock.advance(80);

    assert.equal(fired, 1, "onFire must run exactly once when the window lapses without a re-arm");
  });

  test("does not fire if no arm was scheduled", async () => {

    // This test covers the dormancy rule: constructing a Watchdog without calling `arm()` schedules nothing and fires nothing. Disposal is not the subject here -
    // a `using` binding would pull `[Symbol.dispose]` into the test's observable surface, which is the domain of the dispose-specific tests further down. The
    // construction below is deliberately unbound for that reason, which keeps the test's focus on the side-effect count rather than the handle lifetime.
    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    clock.advance(80);

    assert.equal(fired, 0, "a watchdog that was never armed must stay dormant");
  });

  test("a watchdog built with no clock arms the global timer", (t) => {

    // The one Watchdog row that injects NO clock: it proves the default path is still the platform timer, so a consumer that drives its suite on mock timers keeps
    // observing this window. The per-test enable is auto-restored when the row ends.
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    t.mock.timers.tick(80);

    assert.equal(fired, 1, "a watchdog with no injected clock fires on the global timer the harness replaced");
  });

  test("a re-arm issued from inside onFire installs a handle a later clear() can cancel", () => {

    // The ordering this row is the only check on: `arm()` nulls its handle field BEFORE running onFire, so a re-arm issued from inside onFire installs a fresh handle
    // that nothing later on the fire path overwrites. Null it after the fire instead and the re-armed handle is lost, leaving `clear()` with nothing to cancel and the
    // second window free to fire. The RTP heartbeat re-arms itself from inside its own onFire, so this is its ordering too.
    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ clock, onFire: (): void => {

      fired++;
      watchdog.arm();
    }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    clock.advance(30);

    assert.equal(fired, 1, "the first window fires and the callback re-arms a second one");

    // Cancel the re-armed window partway through it. This can only work if `clear()` can reach the handle the re-arm installed.
    clock.advance(10);
    watchdog.clear();
    clock.advance(100);

    assert.equal(fired, 1, "clear() cancelled the re-armed window, so no second fire ever lands");
  });

  test("re-arming restarts the window", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 50 });

    // Arm, wait part of the window, re-arm, wait part of the new window. If re-arm did not restart, the first arm's timer would fire around the 60ms mark.
    watchdog.arm();

    clock.advance(25);
    watchdog.arm();
    clock.advance(35);

    assert.equal(fired, 0, "re-arming must cancel the pending fire and restart from the new arm");

    clock.advance(40);

    assert.equal(fired, 1, "fires after the re-armed window lapses");
  });
});

describe("Watchdog - signal-driven termination", () => {

  test("signal abort clears the pending fire and suppresses onFire", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();
    controller.abort(new HbpuAbortError("shutdown"));

    clock.advance(80);

    assert.equal(fired, 0, "abort must suppress a pending onFire - the aborted guard is the contract");
  });

  test("arm() is a no-op when the signal is already aborted", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    controller.abort(new HbpuAbortError("shutdown"));

    using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    clock.advance(80);

    assert.equal(fired, 0, "arming a watchdog on a pre-aborted signal must schedule no fire");
  });

  test("onFire is skipped when the signal aborts between scheduling and fire", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();

    // Abort just before the timer fires. The setTimeout callback's aborted-guard is what closes this race, independent of the self-clean listener.
    clock.advance(20);
    controller.abort(new HbpuAbortError("replaced"));
    clock.advance(40);

    assert.equal(fired, 0, "the fire-time aborted guard must honor a last-moment abort even if self-clean did not race first");
  });
});

describe("Watchdog - clear (re-armable)", () => {

  test("clear() cancels a pending fire without aborting anything", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();
    watchdog.clear();

    clock.advance(80);

    assert.equal(fired, 0);
    assert.equal(controller.signal.aborted, false, "clear() must not touch the observed signal");
  });

  test("clear() is safe to call more than once", () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const watchdog = new Watchdog({ clock, onFire: (): void => { /* irrelevant */ }, signal: controller.signal, timeoutMs: 30 });

    watchdog.clear();
    watchdog.clear();
    // No assertion needed - reaching here without throwing is the test.
  });

  test("clear() leaves the watchdog re-armable", async () => {

    // Regression guard: clear() is semantically different from dispose(). Post-clear, `arm()` must still work so callers can re-enter the inactivity window after a
    // deliberate pause - for example, when a producer knows it is going to go quiet for a known interval and wants to defer the watchdog from firing during that gap.
    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog.arm();
    watchdog.clear();
    watchdog.arm();

    clock.advance(80);

    assert.equal(fired, 1, "clear() must not disable the watchdog - a subsequent arm() must schedule and fire normally");
  });
});

describe("Watchdog - dispose (permanently inert)", () => {

  test("[Symbol.dispose] clears a pending fire", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;

    {

      using watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

      watchdog.arm();
    }

    clock.advance(80);

    assert.equal(fired, 0, "scope-bound `using` must cancel the pending fire when the block exits");
  });

  test("arm() after dispose is a no-op (Disposable contract)", async () => {

    // Regression guard: a post-dispose `arm()` must NOT schedule a timer. The `using` declaration's entire value proposition is that the resource is dead when the
    // block exits; a re-armable post-dispose watchdog would silently violate that, producing fires after the scope the caller believes owns the resource has exited.
    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;
    const watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 30 });

    watchdog[Symbol.dispose]();
    watchdog.arm();

    clock.advance(80);

    assert.equal(fired, 0, "arm() after dispose must be a no-op - the Disposable contract demands the resource is dead");
  });

  test("arm() between dispose() calls still cannot resurrect the watchdog", async () => {

    // Hardening: cycle dispose -> arm -> dispose several times. Each arm must remain a no-op. This guards against a hypothetical regression where someone adds a
    // `#disposed = false` reset to dispose (so repeat disposal stops being a no-op) or to arm (breaking the contract).
    const clock = new TestClock();
    const controller = new AbortController();
    let fired = 0;
    const watchdog = new Watchdog({ clock, onFire: (): void => { fired++; }, signal: controller.signal, timeoutMs: 20 });

    for(let i = 0; i < 3; i++) {

      watchdog[Symbol.dispose]();
      watchdog.arm();
    }

    clock.advance(80);

    assert.equal(fired, 0, "repeated dispose/arm cycles must never resurrect the watchdog");
  });

  test("[Symbol.dispose] is safe to call more than once", () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const watchdog = new Watchdog({ clock, onFire: (): void => { /* irrelevant */ }, signal: controller.signal, timeoutMs: 30 });

    watchdog[Symbol.dispose]();
    watchdog[Symbol.dispose]();
    // No assertion needed - reaching here without throwing is the test.
  });

  test("[Symbol.dispose] does not touch the observed signal", () => {

    // Contract boundary: the watchdog does not own the signal, so disposing the watchdog must not abort the signal. Consumers who want teardown to propagate to the
    // signal wire that through their own controllers - the watchdog is a pure observer.
    const clock = new TestClock();
    const controller = new AbortController();

    using watchdog = new Watchdog({ clock, onFire: (): void => { /* irrelevant */ }, signal: controller.signal, timeoutMs: 30 });

    watchdog[Symbol.dispose]();

    assert.equal(controller.signal.aborted, false, "disposing a Watchdog must not abort the signal it observed");
  });
});

describe("consoleLog", () => {

  test("routes error, info, and warn to the matching console method, message and parameters intact", (t) => {

    // The console methods are mocked through the test context so restoration is the runner's job rather than a teardown this row could forget. Each channel has to
    // reach its own console method and no other, carrying the caller's format string and parameters through untouched, because Config UI X reads the level from
    // which console method wrote the line.
    const errorSpy = t.mock.method(console, "error", () => undefined);
    const infoSpy = t.mock.method(console, "info", () => undefined);
    const warnSpy = t.mock.method(console, "warn", () => undefined);

    consoleLog.error("Failed: %s", "x");
    consoleLog.info("Started: %s", "y");
    consoleLog.warn("Degraded: %s", "z");

    assert.equal(errorSpy.mock.callCount(), 1, "error reaches console.error exactly once");
    assert.equal(infoSpy.mock.callCount(), 1, "info reaches console.info exactly once");
    assert.equal(warnSpy.mock.callCount(), 1, "warn reaches console.warn exactly once");
    assert.deepEqual(expectAt(errorSpy.mock.calls, 0, "the console.error call").arguments, [ "Failed: %s", "x" ]);
    assert.deepEqual(expectAt(infoSpy.mock.calls, 0, "the console.info call").arguments, [ "Started: %s", "y" ]);
    assert.deepEqual(expectAt(warnSpy.mock.calls, 0, "the console.warn call").arguments, [ "Degraded: %s", "z" ]);
  });

  test("drops a debug line without touching any console method", (t) => {

    // The silent debug channel is the whole reason this constant exists rather than a bare console alias, so the row mocks every console method a forwarded debug
    // line could plausibly reach and asserts none of them was called.
    const spies = [ "debug", "error", "info", "log", "warn" ].map((level) => [ level, t.mock.method(console, level as "debug" | "error" | "info" | "log" | "warn",
      () => undefined) ] as const);

    consoleLog.debug("noisy %d", 1);

    for(const [ level, spy ] of spies) {

      assert.equal(spy.mock.callCount(), 0, "a debug line must not reach console." + level);
    }
  });

  test("is one module-scope object carrying exactly the channels the logging interface declares", async () => {

    // One shared instance rather than a factory's output, for the reason noOpLog is one: the methods are stateless, so every importer may hold the same reference.
    const reimported = await import("./util.ts");

    assert.equal(reimported.consoleLog, consoleLog, "a second import reads the same reference");
    assert.deepEqual(Object.keys(consoleLog).sort(), [ "debug", "error", "info", "warn" ], "the member set is exactly the channels the interface declares");
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
    // message and parameters must equal writing the prefix into the caller's own format string and formatting that, which proves the prefix goes through the format
    // string and the parameters reach the sink untouched.
    wrapped.info("Motion on %s at %d.", "front", 5, { zone: "porch" });
    wrapped.warn("Stream stalled.");

    const parameterized = expectAt(base.entries, 0, "the parameterized entry");
    const bare = expectAt(base.entries, 1, "the bare entry");

    assert.equal(formatLogEntry(parameterized), util.format(prefix + ": " + "Motion on %s at %d.", "front", 5, { zone: "porch" }));
    assert.equal(formatLogEntry(bare), util.format(prefix + ": " + "Stream stalled."));
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

describe("debugGatedLog", () => {

  test("an open gate routes the debug message and its parameters to the base warn level, verbatim", () => {

    // Homebridge prints warn unconditionally and suppresses its native debug channel behind its own switch, so an open gate emits the caller's debug line at warn -
    // message and parameter list exactly as handed in, with no wrapping of either.
    const base = capturingLog();
    const wrapped = debugGatedLog(base, () => true);

    wrapped.debug("Polling returned %d devices.", 3, { source: "cache" });

    assert.equal(base.entries.length, 1, "an open gate must emit exactly one entry");

    const entry = expectAt(base.entries, 0, "the gated debug entry");

    assert.equal(entry.level, "warn");
    assert.equal(entry.message, "Polling returned %d devices.");
    assert.deepEqual(entry.params, [ 3, { source: "cache" } ]);
  });

  test("a closed gate drops the debug line on every base level", () => {

    // Gate-off is silence, not a downgrade: the line does not reach warn, and it does not leak onto debug or any other level either. This is the deliberate design -
    // the plugin's own setting decides, regardless of what Homebridge's global debug switch is doing.
    const base = capturingLog();
    const wrapped = debugGatedLog(base, () => false);

    wrapped.debug("Polling returned %d devices.", 3);

    assert.deepEqual(base.entries, [], "a closed gate must emit nothing at any level");
  });

  test("the predicate is evaluated on every call so a configuration change reaches the very next line", () => {

    // The gate is a predicate rather than a captured boolean, so a user toggling the plugin's debug setting mid-session takes effect immediately. One wrapper, two
    // calls, gate flipped in between: only the call made while the gate was open produces an entry.
    const base = capturingLog();
    let enabled = false;
    const wrapped = debugGatedLog(base, () => enabled);

    wrapped.debug("suppressed");
    enabled = true;
    wrapped.debug("emitted");

    assert.deepEqual(base.entries.map((entry) => ({ level: entry.level, message: entry.message })), [{ level: "warn", message: "emitted" }]);
  });

  test("error, info, and warn pass through to the matching base level even while the gate is closed", () => {

    // The gate reaches the debug channel and nothing else. Running this with the gate closed is what proves it: if the gate leaked onto the pass-through levels, all
    // three of these would vanish.
    const base = capturingLog();
    const wrapped = debugGatedLog(base, () => false);

    wrapped.error("e", 1);
    wrapped.info("i", 2);
    wrapped.warn("w", 3);

    assert.deepEqual(base.entries, [

      { level: "error", message: "e", params: [1] },
      { level: "info", message: "i", params: [2] },
      { level: "warn", message: "w", params: [3] }
    ]);
  });

  test("the canonical gate-outermost composition skips prefix work on a suppressed line and applies it on an emitted one", () => {

    // `debugGatedLog(prefixedLog(base, prefix), isEnabled)` is the documented composition order, and the prefix supplier is the observable that separates it from the
    // reverse nesting: a suppressed debug line must never reach the inner wrapper at all, so the supplier stays uncalled. Flipping the gate then proves the same
    // wrapper does compose the prefix once the line is actually emitted.
    const base = capturingLog();
    let prefixCalls = 0;
    let enabled = false;

    const prefix = (): string => {

      prefixCalls++;

      return "Front Door";
    };

    const wrapped = debugGatedLog(prefixedLog(base, prefix), () => enabled);

    wrapped.debug("Suppressed line.");

    assert.equal(prefixCalls, 0, "a suppressed debug line must not invoke the prefix supplier");
    assert.equal(base.entries.length, 0, "a suppressed debug line must not reach the base logger");

    enabled = true;
    wrapped.debug("Emitted line.");

    assert.equal(prefixCalls, 1, "an emitted debug line must invoke the prefix supplier exactly once");

    const entry = expectAt(base.entries, 0, "the emitted entry");

    assert.equal(entry.level, "warn");
    assert.equal(entry.message, "Front Door: Emitted line.");
  });
});

describe("repeatDemotedLog", () => {

  test("holds a first failure's error and warn lines until the attempt ends, then releases them at their own levels in written order", () => {

    // An attempt classifies itself through its own return value, so nothing a callee writes can reach the base logger while `run` is still on the stack. Once it has
    // returned, the held lines go out at the levels they were written at, in the order they were written, message and parameters untouched.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);

    failures.attempt((attemptLog) => {

      attemptLog.error("Unable to reach %s.", "10.0.0.5");
      attemptLog.warn("Retrying in %d seconds.", 30);

      assert.equal(base.entries.length, 0, "an open attempt must hold its error and warn lines rather than writing them");
    }, () => "timeout");

    assert.equal(base.entries.length, 2, "a first failure must release exactly the lines it wrote, once each");

    const failure = expectAt(base.entries, 0, "the released error entry");
    const notice = expectAt(base.entries, 1, "the released warn entry");

    assert.equal(failure.level, "error");
    assert.equal(failure.message, "Unable to reach %s.");
    assert.deepEqual(failure.params, ["10.0.0.5"]);
    assert.equal(notice.level, "warn");
    assert.equal(notice.message, "Retrying in %d seconds.");
    assert.deepEqual(notice.params, [30]);
  });

  test("replays an unchanged repeat through the base debug level, message and parameters verbatim", () => {

    // The second attempt fails for the reason the first one did, so its report repeats something the user has already been told...it goes out at debug, where it
    // stays available to anyone reading the log at that level without being shown again.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);

    for(const attemptNumber of [ 1, 2 ]) {

      failures.attempt((attemptLog) => attemptLog.error("Unable to reach %s on attempt %d.", "10.0.0.5", attemptNumber), () => "timeout");
    }

    const first = expectAt(base.entries, 0, "the first failure's entry");
    const repeat = expectAt(base.entries, 1, "the repeat's entry");

    assert.equal(first.level, "error", "the first report of a reason must go out in full");
    assert.equal(repeat.level, "debug", "a failure repeating the remembered reason must be replayed at debug");
    assert.equal(repeat.message, "Unable to reach %s on attempt %d.");
    assert.deepEqual(repeat.params, [ "10.0.0.5", 2 ]);
  });

  test("a changed reason reports in full again, even directly after a run of demoted repeats", () => {

    // Every attempt here writes the identical message and varies only its reason, which is what separates a correct adapter from one keyed on the message text or
    // one deciding at the `error` call: the third attempt reports a different fault and must be shown, not buried under the run of repeats before it.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);

    for(const reason of [ "timeout", "timeout", "encryption-invalid" ]) {

      failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => reason);
    }

    assert.deepEqual(base.entries.map((entry) => entry.level), [ "error", "debug", "error" ],
      "a repeat must be demoted and a changed reason must report in full, however long the run of repeats before it");
  });

  test("a non-failure releases its lines at their own levels and clears the remembered reason", () => {

    // A success in between ends the episode: the failure after it reports that fault for the first time again rather than repeating the one before the success. The
    // successful attempt's own warn line is untouched by the classification and goes out at warn.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);

    failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");
    failures.attempt((attemptLog) => attemptLog.warn("Connected after a degraded handshake."), () => undefined);
    failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

    assert.deepEqual(base.entries.map((entry) => entry.level), [ "error", "warn", "error" ],
      "a non-failure must release its own lines at their levels and clear the memory, so the failure after it reports in full");
  });

  test("debug and info reach the base logger while the attempt is still open", () => {

    // Progress is worth showing as it happens, so neither level waits for the classification. Asserting from inside `run` is what proves they were not merely
    // released alongside everything else once the attempt ended.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);

    failures.attempt((attemptLog) => {

      attemptLog.debug("Opening the socket.");
      attemptLog.info("Handshake started.");

      assert.deepEqual(base.entries.map((entry) => entry.level), [ "debug", "info" ], "debug and info must reach the base logger before `run` returns");
    }, () => undefined);
  });

  test("a synchronous run yields a synchronous attempt returning the same value by identity", () => {

    // Nothing in the adapter may turn a synchronous attempt into an asynchronous one: the caller gets its own object back rather than a promise of it, and the held
    // line has already been replayed on the line after `attempt` returns. There is no `await` anywhere in this row, which is the point of it.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);
    const answer = { ok: false, reason: "timeout" };

    const outcome = failures.attempt((attemptLog) => {

      attemptLog.error("The connection could not be established.");

      return answer;
    }, (result) => result.ok ? undefined : result.reason);

    assert.equal(outcome, answer, "a synchronous attempt must return exactly the value `run` produced");
    assert.equal(outcome instanceof Promise, false, "a synchronous attempt must not hand back a promise");
    assert.equal(expectAt(base.entries, 0, "the released entry").level, "error", "a synchronous attempt must replay its lines before returning");
  });

  test("an asynchronous run holds its lines until the promise settles, and the attempt fulfills with the same value", async () => {

    // The classification is unavailable until the attempt's promise settles, so the hold has to outlive `run` returning. Asserting while the deferred promise is
    // still pending is what catches an adapter that replays as soon as `run` hands back its promise.
    await assertNoUnhandledRejections(async () => {

      const base = capturingLog();
      const failures = repeatDemotedLog(base);
      const deferred: PromiseWithResolvers<{ ok: boolean; reason: string }> = Promise.withResolvers();

      const pending = failures.attempt(async (attemptLog) => {

        attemptLog.error("The connection could not be established.");

        return deferred.promise;
      }, (result) => result.ok ? undefined : result.reason);

      assert.equal(base.entries.length, 0, "an attempt whose promise is still pending must hold its error line");

      const answer = { ok: false, reason: "timeout" };

      deferred.resolve(answer);

      assert.equal(await pending, answer, "an asynchronous attempt must fulfill with exactly the value `run` produced");
      assert.equal(base.entries.length, 1, "a settled attempt must release its held error line exactly once");
      assert.equal(expectAt(base.entries, 0, "the released entry").level, "error", "a first failure must be released at its own level");
    });
  });

  test("a synchronous throw releases at own levels, rethrows the same error, and leaves the remembered reason untouched", () => {

    // A throw is not a classified outcome. Its own line still has to be shown, and the episode must neither advance nor reset around it, so the attempt after the
    // throw is still a repeat of the one before it and arrives at debug.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);
    const boom = new Error("the transport collapsed mid-handshake");

    failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

    assert.throws(() => failures.attempt((attemptLog) => {

      attemptLog.error("The transport collapsed.");

      throw boom;
    }, () => "timeout"), (error: unknown) => error === boom);

    failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

    assert.equal(base.entries.length, 3, "each attempt must release exactly the one line it wrote");
    assert.deepEqual(base.entries.map((entry) => entry.level), [ "error", "error", "debug" ],
      "a throw must release at its own level and leave the remembered reason alone, so the attempt after it is still a repeat");
  });

  test("a rejection releases at own levels, rejects with the same error, and leaves the remembered reason untouched", async () => {

    // The asynchronous end mirrors the synchronous one exactly: a rejection is no more a classification than a throw is, so the lines go out in full and the memory
    // stands across it.
    await assertNoUnhandledRejections(async () => {

      const base = capturingLog();
      const failures = repeatDemotedLog(base);
      const boom = new Error("the transport collapsed mid-handshake");

      failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

      await assert.rejects(failures.attempt(async (attemptLog) => {

        attemptLog.error("The transport collapsed.");

        throw boom;
      }, () => "timeout"), (error: unknown) => error === boom);

      failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

      assert.equal(base.entries.length, 3, "each attempt must release exactly the one line it wrote");
      assert.deepEqual(base.entries.map((entry) => entry.level), [ "error", "error", "debug" ],
        "a rejection must release at its own level and leave the remembered reason alone, so the attempt after it is still a repeat");
    });
  });

  test("a throwing classifier releases at own levels, propagates the error, and leaves the remembered reason untouched", () => {

    // `reasonOf` runs before anything is released, so a throw from it leaves the attempt unclassified, handled exactly as a throw from `run` is...down to the
    // memory standing untouched across it.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);
    const boom = new Error("the outcome could not be classified");

    failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

    assert.throws(() => failures.attempt((attemptLog) => attemptLog.error("The classifier is about to fault."), () => { throw boom; }),
      (error: unknown) => error === boom);

    failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

    assert.deepEqual(base.entries.map((entry) => entry.level), [ "error", "error", "debug" ],
      "a throwing classifier must release at its own level and leave the remembered reason alone");
  });

  test("a throwing classifier on an asynchronous attempt releases at own levels, rejects with the same error, and leaves the remembered reason untouched", async () => {

    // The classification of an asynchronous attempt runs once its promise fulfills, through the same guarded call the synchronous path uses, so a throw from
    // `reasonOf` there is handled exactly as a rejection from `run` is: the held line goes out in full and the memory stands across it.
    await assertNoUnhandledRejections(async () => {

      const base = capturingLog();
      const failures = repeatDemotedLog(base);
      const boom = new Error("the outcome could not be classified");

      await failures.attempt(async (attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

      await assert.rejects(failures.attempt(async (attemptLog) => attemptLog.error("The classifier is about to fault."), () => { throw boom; }),
        (error: unknown) => error === boom);

      await failures.attempt(async (attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

      assert.deepEqual(base.entries.map((entry) => entry.level), [ "error", "error", "debug" ],
        "a throwing classifier on an asynchronous attempt must release at its own level and leave the remembered reason alone");
    });
  });

  test("an error or warn written after the attempt ended reaches the base logger immediately, at its own level", () => {

    // A callee that kept the logger past the attempt it was handed for must still be heard. No replay is coming to carry such a line, so it goes straight to the
    // base logger at the level it was written at, and it must go exactly once.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);

    const leaked = failures.attempt((attemptLog) => {

      attemptLog.error("The connection could not be established.");

      return attemptLog;
    }, () => "timeout");

    assert.equal(base.entries.length, 1, "the attempt must have released exactly the line it wrote");

    leaked.error("A late fault surfaced.");
    leaked.warn("A late warning surfaced.");

    assert.equal(base.entries.length, 3, "each line written after the attempt ended must reach the base logger exactly once");
    assert.deepEqual(base.entries.slice(1).map((entry) => entry.level), [ "error", "warn" ], "a late line must arrive at the level it was written at");
  });

  test("adapters remember their reasons independently", () => {

    // The memory belongs to the adapter rather than to the base logger, so two adapters writing to one sink never demote each other's first report.
    const base = capturingLog();
    const first = repeatDemotedLog(base);
    const second = repeatDemotedLog(base);

    first.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");
    second.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeout");

    assert.deepEqual(base.entries.map((entry) => entry.level), [ "error", "error" ],
      "a second adapter must report its own first failure in full, whatever another adapter has remembered");
  });

  test("composes over prefixedLog, so a demoted replay carries the prefix", () => {

    // The adapter hands every line to whatever logger it was built over, on the replay as much as on the live path, so the prefix reaches a demoted repeat exactly
    // as it reaches a full report.
    const base = capturingLog();
    const failures = repeatDemotedLog(prefixedLog(base, () => "Front Door"));

    for(const attemptNumber of [ 1, 2 ]) {

      failures.attempt((attemptLog) => attemptLog.error("Attempt %d could not connect.", attemptNumber), () => "timeout");
    }

    const repeat = expectAt(base.entries, 1, "the demoted repeat");

    assert.equal(repeat.level, "debug", "a repeat must be replayed at debug through the composed logger");
    assert.equal(repeat.message, "Front Door: Attempt %d could not connect.", "the replay must carry the prefix the composed logger applies");
    assert.deepEqual(repeat.params, [2]);
  });

  test("the reason type constrains the classifier, and an attempt answers with run's own type", async () => {

    // Enforced by `npm run typecheck` rather than at runtime: a misspelled tag must fail to compile, a synchronous attempt's result must be assignable to its own
    // non-promise type with no `await`, and an asynchronous one's must be assignable to the promise type `run` returned. Every call here passes both arrows
    // unannotated and no explicit type argument, which is the shape a consumer writes...a call that inferred `unknown` would redden the two assignments below.
    type Reason = "timeout" | "refused";

    const base = capturingLog();
    const failures = repeatDemotedLog<Reason>(base);
    const syncAnswer = { ok: false };
    const asyncAnswer = { ok: true };

    // @ts-expect-error - "timeuot" is not a member of Reason, so a classifier answering with it must fail to compile.
    failures.attempt((attemptLog) => attemptLog.error("The connection could not be established."), () => "timeuot");

    const synchronous: { ok: boolean } = failures.attempt((attemptLog) => {

      attemptLog.debug("Classifying a synchronous attempt.");

      return syncAnswer;
    }, (result) => result.ok ? undefined : "timeout");

    const asynchronous: Promise<{ ok: boolean }> = failures.attempt(async (attemptLog) => {

      attemptLog.debug("Classifying an asynchronous attempt.");

      return asyncAnswer;
    }, (result) => result.ok ? undefined : "refused");

    assert.equal(synchronous.ok, false, "a synchronous attempt must answer with the value `run` returned, with no promise in between");
    assert.equal((await asynchronous).ok, true, "an asynchronous attempt must fulfill with the value `run` produced");
  });

  test("held lines are replayed after the same attempt's live lines, in written order", () => {

    // The accepted cost of holding: within one attempt the live info and debug lines arrive first and the failure report last, however they were interleaved when
    // they were written.
    const base = capturingLog();
    const failures = repeatDemotedLog(base);

    failures.attempt((attemptLog) => {

      attemptLog.info("Opening the socket.");
      attemptLog.error("The connection could not be established.");
      attemptLog.info("Backing off before the next attempt.");
    }, () => "timeout");

    assert.deepEqual(base.entries.map((entry) => entry.level), [ "info", "info", "error" ],
      "the live lines must arrive in written order, with the held report released after them");
  });
});

describe("formatBps", () => {

  test("returns bits per second for sub-1000 values", () => {

    // Values below the kilobit boundary stay in bits per second, and the base tier rounds like every tier above it, so a fractional rate reaches one decimal place.
    assert.equal(formatBps(0), "0 bps");
    assert.equal(formatBps(500), "500 bps");
    assert.equal(formatBps(999), "999 bps");
    assert.equal(formatBps(2.56), "2.6 bps");
  });

  test("returns integer kbps for round thousand boundaries", () => {

    // An exact multiple of a thousand bits per second is a whole number of kilobits, and a value whose rounded form is whole renders without a decimal.
    assert.equal(formatBps(1000), "1 kbps");
    assert.equal(formatBps(15000), "15 kbps");
    assert.equal(formatBps(999000), "999 kbps");
  });

  test("returns one-decimal kbps for non-round values", () => {

    // A fractional kilobit value renders to one decimal place, and one whose rounded form is whole renders whole, so a decimal appears where it carries information.
    assert.equal(formatBps(1500), "1.5 kbps");
    assert.equal(formatBps(2000), "2 kbps");
    assert.equal(formatBps(2500), "2.5 kbps");
  });

  test("returns integer Mbps for round million boundaries", () => {

    // Parallel contract to the kbps path: exact multiples of 1000000 bits per second carry no decimal.
    assert.equal(formatBps(1000000), "1 Mbps");
    assert.equal(formatBps(5000000), "5 Mbps");
  });

  test("returns one-decimal Mbps for non-round megabit values", () => {

    assert.equal(formatBps(2560000), "2.6 Mbps");
    assert.equal(formatBps(1500000), "1.5 Mbps");
  });
});

describe("formatBytes", () => {

  test("renders sub-1024 values in bytes under the precision policy", () => {

    // Values below the kilobyte boundary stay in bytes, and the base tier rounds like every tier above it, so a fractional byte count reaches one decimal place.
    assert.equal(formatBytes(0), "0 bytes");
    assert.equal(formatBytes(512), "512 bytes");
    assert.equal(formatBytes(1023), "1023 bytes");
    assert.equal(formatBytes(512.25), "512.3 bytes");
  });

  test("returns integer KB for round 1024 boundaries", () => {

    // An exact multiple of 1024 bytes is a whole number of kilobytes, and a value whose rounded form is whole renders without a decimal.
    assert.equal(formatBytes(1024), "1 KB");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(1023 * 1024), "1023 KB");
  });

  test("returns one-decimal KB for non-round values", () => {

    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(2560), "2.5 KB");
  });

  test("returns integer MB at megabyte boundaries", () => {

    assert.equal(formatBytes(1048576), "1 MB");
    assert.equal(formatBytes(5 * 1048576), "5 MB");
  });

  test("returns one-decimal MB for non-round megabyte values", () => {

    assert.equal(formatBytes(2621440), "2.5 MB");
    assert.equal(formatBytes(1572864), "1.5 MB");
  });

  test("returns integer GB at gigabyte boundaries", () => {

    assert.equal(formatBytes(1073741824), "1 GB");
    assert.equal(formatBytes(2 * 1073741824), "2 GB");
  });

  test("returns one-decimal GB for non-round gigabyte values", () => {

    assert.equal(formatBytes(1.5 * 1073741824), "1.5 GB");
  });

  test("returns integer TB at terabyte boundaries", () => {

    // Asserts the cap-tier promotion: once a value reaches 1024 GB it must surface as "1 TB" rather than awkwardly continuing in the GB tier as "1024 GB".
    assert.equal(formatBytes(1099511627776), "1 TB");
    assert.equal(formatBytes(2 * 1099511627776), "2 TB");
  });

  test("returns one-decimal TB for non-round terabyte values", () => {

    assert.equal(formatBytes(1.5 * 1099511627776), "1.5 TB");
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
    // not an ellipsis-canonicalizer. We assert this so a future refactor does not silently broaden the strip pattern.
    assert.equal(formatErrorMessage(new Error("ellipsis...")), "ellipsis..");
  });

  test("appends the message of an error carried as the cause, so a wrapper's diagnosis survives into the log line", () => {

    // A client that wraps a transport rejection puts the sentence a reader needs one link below the sentence it caught. Rendering only the wrapper would log
    // "Unable to fetch the bootstrap" and drop the reason the controller gave, which is the whole of what the operator is looking for.
    const error = new Error("Unable to fetch the bootstrap", { cause: new Error("The controller refused the request: bad token.") });

    assert.equal(formatErrorMessage(error), "Unable to fetch the bootstrap: The controller refused the request: bad token");
  });

  test("appends every link of a deeper chain in order, each with its own trailing period stripped", () => {

    // Each link is rendered by the same rule the head is, so a chain reads as one sentence rather than as a head joined to raw messages.
    const error = new Error("a", { cause: new Error("b.", { cause: new Error("c.") }) });

    assert.equal(formatErrorMessage(error), "a: b: c", "every link contributes once, in chain order, with no doubled punctuation between them");
  });

  test("appends nothing for a cause whose words the rendered sentence already carries", () => {

    // The log client builds its authentication failures by embedding formatErrorMessage(cause) in the message and setting that same value as the cause. Appending
    // the cause unconditionally would log it twice, so a wrapper that quotes its own cause must render exactly as it would with no chain walk at all.
    const error = new Error("Login could not reach the server: connect ECONNREFUSED.", { cause: new Error("connect ECONNREFUSED") });

    assert.equal(formatErrorMessage(error), "Login could not reach the server: connect ECONNREFUSED");
  });

  test("appends nothing for a structured cause that is not an Error", () => {

    // Causes in this library are routinely plain objects carrying diagnostic context for code to read - a close code, a status, a response body. String() would
    // render one as "[object Object]", and anything richer would put whatever the object holds, credentials included, into a log line.
    const error = new HbpuAbortError("closed", { cause: { code: 1006 } });

    assert.equal(formatErrorMessage(error), "closed", "a structured cause contributes no text at all");
  });

  test("appends a link the sentence only partly carries, rather than treating the chain as already rendered", () => {

    // Containment is decided per link, not once for the chain: the middle link here is already in the head's own message, while the innermost one is the new
    // diagnosis and has to arrive. Skipping the rest of the chain after one contained link would lose it.
    const error = new Error("outer: mid", { cause: new Error("mid", { cause: new Error("inner") }) });

    assert.equal(formatErrorMessage(error), "outer: mid: inner");
  });

  test("renders a chain that refers back to itself once through, rather than repeating it", () => {

    // A cycle is what the depth bound exists for. Every link after the first pass repeats a message the sentence already carries, so containment appends nothing
    // and the bound ends the descent...no visited-set bookkeeping is needed for the rendering to terminate and stay readable.
    const first = new Error("a");
    const second = new Error("b", { cause: first });

    first.cause = second;

    assert.equal(formatErrorMessage(first), "a: b");
  });

  test("renders exactly the links the bounded descent yields and nothing below them", () => {

    // The bound belongs to the descent, so this reads it from behavior rather than restating a number the test would have to be edited to follow: the rendering
    // must carry precisely the messages causeChain yields for this input, and must stop short of a chain built far deeper than any plausible bound.
    const messages: string[] = [];

    for(let index = 0; index < 40; index++) {

      messages.push("link " + String(index));
    }

    // Built from the deepest link upward, because an error's cause is fixed at construction.
    let chained = new Error("deepest");

    for(const message of messages.toReversed()) {

      chained = new Error(message, { cause: chained });
    }

    const yielded = [...causeChain(chained)].filter((link) => link instanceof Error);
    const rendered = formatErrorMessage(chained);

    assert.equal(rendered, yielded.map((link) => link.message).join(": "), "the rendering carries one message per link the descent yielded, in order");
    assert.ok([ ...messages, "deepest" ].join(": ").startsWith(rendered + ": "),
      "the rendering is a strict prefix of the whole chain's join, ending at a link boundary, so the bound truncated it rather than the join being reordered");
  });

  test("appends nothing for a cause whose message is empty", () => {

    // An empty string is contained in every sentence, so the containment rule already covers an error constructed with no message. We assert it so nobody adds a
    // branch for a case the rule handles.
    assert.equal(formatErrorMessage(new Error("a", { cause: new Error("") })), "a");
  });

  test("descends past a structured link to render an error below it", () => {

    // A link that contributes no text still carries a chain beneath it. Ending the descent at the first non-Error link would hide the diagnosis a transport
    // stashed under a context object.
    const error = new Error("a", { cause: { cause: new Error("b") } });

    assert.equal(formatErrorMessage(error), "a: b");
  });
});

describe("causeChain", () => {

  test("yields the value handed in, then each link beneath it, ending at a link that carries no cause", () => {

    // The descent yields every link verbatim, including a final one that is not an object: a transport that rejects with a bare string below an error is a shape
    // readers have to see for themselves, because only the reader knows whether a string link means anything to it.
    const innermost = new Error("socket hang up", { cause: "ECONNRESET" });
    const middle = new Error("the request failed", { cause: innermost });
    const outer = new Error("unable to fetch", { cause: middle });

    assert.deepEqual([...causeChain(outer)], [ outer, middle, innermost, "ECONNRESET" ]);
  });

  test("yields a value that carries no cause at all exactly once", () => {

    const bare = new Error("nothing below this");

    assert.deepEqual([...causeChain(bare)], [bare], "a bare error is a chain of one, so every reader sees the same single link");
  });

  test("yields a non-error value exactly once", () => {

    assert.deepEqual([...causeChain("string-shaped failure")], ["string-shaped failure"]);
    assert.deepEqual([...causeChain(null)], [null], "null is not descended into, and yielding it keeps a reader's per-link checks uniform");
  });

  test("stops at the bound on a chain deeper than it, yielding an unbroken run from the head down", () => {

    // Built far deeper than any plausible bound, so the assertions read the bound from behavior. What has to hold is that the descent yields a contiguous prefix
    // of the chain and stops: a reader gets the nearest links, never a gap in the middle.
    const links: Error[] = [new Error("deepest")];

    for(let index = 0; index < 40; index++) {

      links.unshift(new Error("link " + String(index), { cause: links[0] }));
    }

    const yielded = [...causeChain(links[0])];

    assert.ok(yielded.length < links.length, "a chain deeper than the bound must be cut short, which is what keeps the descent finite");
    assert.deepEqual(yielded, links.slice(0, yielded.length), "the yielded links are the head and its nearest descendants, in order, with none skipped");
  });

  test("ends on a chain that refers back to itself, yielding its links in alternating order", () => {

    // The bound is the whole of the cycle defense: with no visited-set and no cycle check, a self-referential chain simply exhausts the depth. This test hangs
    // rather than fails if the bound is ever removed, which is itself the signal.
    const first = new Error("a");
    const second = new Error("b", { cause: first });

    first.cause = second;

    const yielded = [...causeChain(first)];

    assert.ok(yielded.length > 2, "the descent follows the cycle rather than stopping at the first repeat, because it holds no visited set");
    assert.deepEqual(yielded, Array.from({ length: yielded.length }, (_unused, index) => ((index % 2) === 0) ? first : second),
      "the cycle is yielded in chain order until the bound ends it");
  });
});

describe("parseJson", () => {

  // A recognizable value placed so the parser fails beside it. V8 quotes the text around an unexpected token in its own message, so any excerpt of this value in a
  // thrown message would mean that message was repeated.
  const marker = "Zq9XvK7wPj3RmT5y";

  // Every three-character run of the value, so an assertion rules out any excerpt however little of it a message quoted.
  const runsOf = (value: string): string[] => Array.from({ length: value.length - 2 }, (_unused, start) => value.slice(start, start + 3));

  test("returns the parsed value of well-formed text", () => {

    assert.deepEqual(parseJson({ subject: "The sample", text: "{\"host\": \"ui.local\", \"port\": [8581]}" }), { host: "ui.local", port: [8581] });
  });

  test("names the subject, the line and column, and the remedy, and carries none of the text", () => {

    assert.throws(() => parseJson({ remedy: "Fix it.", subject: "The sample", text: "{\n  \"token\": \"" + marker + "\"\n  \"host\": \"ui.local\"\n}\n" }),
      (error: Error) => {

        assert.equal(error.message, "The sample is not valid JSON at line 3, column 3. Fix it.");
        assert.ok(runsOf(marker).every((run) => !error.message.includes(run)), "no part of the text reaches the message");
        assert.equal(error.cause, undefined, "and the parser's own error, which quotes the text, is not carried as the cause");

        return true;
      });
  });

  test("names the subject alone where the parser reports no position", () => {

    assert.throws(() => parseJson({ subject: "The sample", text: "{\"token\": " + marker + "}" }), (error: Error) => {

      assert.equal(error.message, "The sample is not valid JSON.");
      assert.ok(runsOf(marker).every((run) => !error.message.includes(run)), "no part of the text reaches the message");

      return true;
    });
  });
});

describe("formatUrlHost", () => {

  test("passes a hostname through unchanged", () => {

    assert.equal(formatUrlHost("homebridge.local"), "homebridge.local");
  });

  test("passes a hostname carrying a colon-port tail through unchanged", () => {

    // This is the case the `isIP` reading exists for: a colon check would read the port separator as an IPv6 group and bracket the whole string, composing an
    // authority the URL parser then rejects.
    assert.equal(formatUrlHost("nas.local:8080"), "nas.local:8080");
  });

  test("passes an IPv4 literal through unchanged", () => {

    assert.equal(formatUrlHost("192.0.2.10"), "192.0.2.10");
  });

  test("passes an already-bracketed literal through unchanged", () => {

    // The caller composed the brackets, so what they hold is the caller's; bracketing again would compose "[[::1]]".
    assert.equal(formatUrlHost("[::1]"), "[::1]");
  });

  test("brackets a bare IPv6 literal", () => {

    assert.equal(formatUrlHost("::1"), "[::1]");
    assert.equal(formatUrlHost("2001:db8::1"), "[2001:db8::1]");
  });

  test("refuses a zoned literal with a TypeError naming the address", () => {

    /* `isIP` reads a zoned literal as IPv6 as readily as a bare one, so the zone is tested first. The refusal names the address because the platform's own
     * refusal, raised later inside the URL constructor, says only "Invalid URL".
     */
    assert.throws(() => formatUrlHost("fe80::1%en0"), { constructor: TypeError, message: /fe80::1%en0/ });
  });

  test("passes a bracketed zoned literal through as the caller's own composition", () => {

    assert.equal(formatUrlHost("[fe80::1%25en0]"), "[fe80::1%25en0]");
  });

  test("composes an authority the platform URL parser reads back", () => {

    // The bracketed form is what the grammar wants, and reading the hostname back off a parsed URL is what proves it: the platform answers the literal with its
    // brackets intact and the port separated from it.
    const url = new URL("http://" + formatUrlHost("2001:db8::1") + ":8581/");

    assert.equal(url.hostname, "[2001:db8::1]");
    assert.equal(url.port, "8581");
  });
});

describe("formatMs", () => {

  test("renders sub-second values in milliseconds under the precision policy", () => {

    assert.equal(formatMs(0), "0 ms");
    assert.equal(formatMs(250), "250 ms");
    assert.equal(formatMs(999), "999 ms");

    // The base tier rounds like every tier above it, so a fractional millisecond count reaches one decimal place rather than its raw spelling.
    assert.equal(formatMs(0.25), "0.3 ms");
    assert.equal(formatMs(250.25), "250.3 ms");
  });

  test("returns seconds at the second boundary, with one decimal for fractional values", () => {

    assert.equal(formatMs(1000), "1 s");
    assert.equal(formatMs(1500), "1.5 s");
    assert.equal(formatMs(15000), "15 s");
    assert.equal(formatMs(59500), "59.5 s");
  });

  test("returns minutes once values reach the minute boundary", () => {

    assert.equal(formatMs(60000), "1 min");
    assert.equal(formatMs(90000), "1.5 min");
    assert.equal(formatMs(1800000), "30 min");
  });

  test("returns hours once values reach the hour boundary", () => {

    assert.equal(formatMs(3600000), "1 hr");
    assert.equal(formatMs(5400000), "1.5 hr");

    // The top of the hour band asserts the day threshold from below. The last millisecond before the boundary rounds to a whole twenty-four hours, so it renders
    // without a decimal, and the tier chosen on the raw value keeps it in the hour band - the row is where the two halves of the precision policy meet.
    assert.equal(formatMs(82800000), "23 hr");
    assert.equal(formatMs(86399999), "24 hr");
  });

  test("returns days once values reach the day boundary", () => {

    // The unit label stays singular at every count, matching the ladder's register for the rungs below it ("2 hr", not "2 hrs").
    assert.equal(formatMs(86400000), "1 day");
    assert.equal(formatMs(129600000), "1.5 day");
    assert.equal(formatMs(604800000), "7 day");
  });
});

describe("formatPercent", () => {

  test("renders integer percentages without a trailing decimal", () => {

    // Matches the shared precision policy: whole numbers carry no decimal place, keeping the rendered line free of "50.0%"-style noise.
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(50), "50%");
    assert.equal(formatPercent(100), "100%");

    // The whole-or-fractional decision is taken on the rounded value, so a percentage that rounds to a whole renders without a decimal even though the raw value
    // carries one.
    assert.equal(formatPercent(49.96), "50%");
    assert.equal(formatPercent(0.04), "0%");

    // A negative value keeps its sign unless it rounds to zero, where the rendering reads "0%" rather than a signed zero.
    assert.equal(formatPercent(-2.56), "-2.6%");
    assert.equal(formatPercent(-0.04), "0%");
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

  test("renders sub-minute values in seconds under the precision policy", () => {

    assert.equal(formatSeconds(0), "0 s");
    assert.equal(formatSeconds(45), "45 s");
    assert.equal(formatSeconds(59), "59 s");

    // The base tier rounds like every tier above it, so a fractional second count reaches one decimal place rather than its raw spelling.
    assert.equal(formatSeconds(45.84), "45.8 s");
  });

  test("returns minutes at the minute boundary, with one decimal for fractional values", () => {

    assert.equal(formatSeconds(60), "1 min");
    assert.equal(formatSeconds(90), "1.5 min");
    assert.equal(formatSeconds(1800), "30 min");
  });

  test("returns hours once values reach the hour boundary", () => {

    assert.equal(formatSeconds(3600), "1 hr");
    assert.equal(formatSeconds(5400), "1.5 hr");
    assert.equal(formatSeconds(82800), "23 hr");

    // A value whose rounded form is a whole number renders whole: an hour and a minute is 1.0167 hours, and one decimal place of that is a whole hour.
    assert.equal(formatSeconds(3660), "1 hr");

    // Where the two halves meet, in seconds: the last second before the day boundary rounds to twenty-four whole hours, and the raw value keeps it in the hour band.
    assert.equal(formatSeconds(86399), "24 hr");
  });

  test("returns days once values reach the day boundary", () => {

    assert.equal(formatSeconds(86400), "1 day");
    assert.equal(formatSeconds(129600), "1.5 day");
    assert.equal(formatSeconds(604800), "7 day");
  });
});

describe("defaultRetryBackoff", () => {

  test("starts at 1 second for the second attempt", () => {

    // retry() never calls backoff for attempt 1 - the first attempt runs immediately - so the policy's anchor is attempt 2 at 1000ms.
    assert.equal(defaultRetryBackoff(2), 1000);
  });

  test("doubles exponentially until the 30-second ceiling", () => {

    assert.equal(defaultRetryBackoff(3), 2000);
    assert.equal(defaultRetryBackoff(4), 4000);
    assert.equal(defaultRetryBackoff(5), 8000);
    assert.equal(defaultRetryBackoff(6), 16000);
  });

  test("caps at 30 seconds regardless of attempt number", () => {

    // The Math.min(30000, ...) clamp is the contract: arbitrarily large attempt numbers stay at the ceiling.
    assert.equal(defaultRetryBackoff(7), 30000);
    assert.equal(defaultRetryBackoff(10), 30000);
    assert.equal(defaultRetryBackoff(100), 30000);
  });
});

describe("exponentialBackoff", () => {

  test("answers the default retry ladder at its defaults", () => {

    // The literal schedule, asserted against the numbers themselves rather than against defaultRetryBackoff - which derives from this same factory, so comparing the
    // two would assert nothing about either.
    const ladder: RetryBackoff = exponentialBackoff();

    assert.deepEqual([ 2, 3, 4, 5, 6, 7, 100 ].map(ladder), [ 1000, 2000, 4000, 8000, 16000, 30000, 30000 ],
      "the default ladder seeds at 1000 for attempt 2, doubles, and holds the 30000 ceiling");
  });

  test("answers the log client's reconnect schedule from a custom seed and ceiling", () => {

    const ladder = exponentialBackoff({ ceilingMs: 5000, seedMs: 500 });

    assert.deepEqual([ 2, 3, 4, 5, 6, 7 ].map(ladder), [ 500, 1000, 2000, 4000, 5000, 5000 ],
      "a 500 ms seed under a 5000 ms ceiling is the log client's curve before its jitter");
  });

  test("holds a ceiling below the seed from the second attempt", () => {

    // A ceiling under the seed is a caller's deliberate flat wait, so the clamp answers the ceiling from the very first retry rather than the seed.
    const ladder = exponentialBackoff({ ceilingMs: 250, seedMs: 1000 });

    assert.equal(ladder(2), 250, "the ceiling wins at the seed attempt");
    assert.equal(ladder(3), 250, "and at every attempt after it");
  });

  test("rejects a non-finite or non-positive option at construction", () => {

    // The boundary answers where the policy is declared, so a caller sees the mistake without waiting for a first retry that may be minutes away.
    assert.throws(() => exponentialBackoff({ seedMs: 0 }), /seedMs.*finite and positive/);
    assert.throws(() => exponentialBackoff({ ceilingMs: -1 }), /seedMs.*finite and positive/);
    assert.throws(() => exponentialBackoff({ ceilingMs: Infinity }), /seedMs.*finite and positive/);
    assert.throws(() => exponentialBackoff({ seedMs: Number.NaN }), /seedMs.*finite and positive/);
  });

  test("drives retry's waits", async () => {

    const clock = new TestClock();
    let calls = 0;
    const attempt = retry(async () => {

      calls++;

      if(calls < 4) {

        throw new Error("transient");
      }

      return "done";
    }, { attempts: 4, backoff: exponentialBackoff({ ceilingMs: 300, seedMs: 100 }), clock });

    // Walk the ladder's own gaps on virtual time: the seed, its double, then the ceiling clamping what would otherwise be 400. A ladder answering any other delay
    // strands the run on a wait this walk never releases, so the walk itself is the assertion.
    await advanceThroughSchedule(clock, [ 100, 200, 300 ]);

    assert.equal(await attempt, "done", "the fourth attempt succeeded once the ladder's waits had run");
    assert.equal(calls, 4, "every attempt in the budget ran");
    assert.equal(clock.now(), 600, "the waits summed to the seed, its double, and the ceiling");
  });
});

describe("runWithAbort", () => {

  test("returns the factory's value when neither timeout nor external signal fires", async () => {

    const result = await runWithAbort(async () => "ok", { timeout: 1000 });

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
    }, { signal: controller.signal, timeout: 5000 });

    assert.equal(result, null);
    assert.equal(observedReason, reason);
  });

  test("arms the timeout on the injected clock rather than on the platform", async () => {

    // Where the deadline landed is what this row reads: a platform-armed timeout would leave the clock's ledger empty and nothing for the advance to cross, so the
    // two readings below are the evidence and the advance is what makes the call answer.
    const clock = new TestClock();
    const result = runWithAbort(waitForAbort, { clock, timeout: 1000 });

    assert.equal(clock.pending, 1, "the deadline is registered on the injected clock");
    assert.deepEqual(clock.requested, [1000], "for exactly the window the caller asked for");

    clock.advance(1000);

    assert.equal(await result, null, "crossing the deadline aborts the composed signal, so the helper answers null");
  });

  test("releases its deadline when the factory's promise settles first", async () => {

    const clock = new TestClock();
    const { promise, resolve }: PromiseWithResolvers<string> = Promise.withResolvers();
    const result = runWithAbort(async () => promise, { clock, timeout: 1000 });

    assert.equal(clock.pending, 1, "the deadline is on the clock while the work runs");

    resolve("done");

    assert.equal(await result, "done", "the work's value comes back");
    assert.equal(clock.pending, 0, "and its settling released the deadline");
  });

  test("releases its deadline when the factory rejects", async () => {

    const clock = new TestClock();
    const boom = new Error("factory exploded");
    const { promise, reject }: PromiseWithResolvers<string> = Promise.withResolvers();
    const result = runWithAbort(async () => promise, { clock, timeout: 1000 });

    assert.equal(clock.pending, 1, "the deadline is on the clock while the factory runs");

    reject(boom);

    await assert.rejects(result, (error: unknown) => error === boom);

    assert.equal(clock.pending, 0, "and the rejection released it");
  });

  test("with a signal already aborted, arms its deadline and releases it on the early return", async () => {

    const clock = new TestClock();
    const controller = new AbortController();

    controller.abort(new HbpuAbortError("shutdown"));

    const result = await runWithAbort(async () => "unreachable", { clock, signal: controller.signal, timeout: 1000 });

    assert.equal(result, null, "the aborted signal short-circuits the call");
    assert.deepEqual(clock.requested, [1000], "after the deadline was armed for the span asked for");
    assert.equal(clock.pending, 0, "and the early return released it again");
  });

  test("with a signal and no timeout, asks the clock for nothing", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const result = await runWithAbort(async () => "ok", { clock, signal: controller.signal });

    assert.equal(result, "ok", "the factory's value comes back");
    assert.deepEqual(clock.requested, [], "no deadline is armed without a timeout");
    assert.equal(clock.pending, 0, "so nothing is on the clock");
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

    // The whitespace run is part of the match, so a run of spaces counts as a single separator and the word after it still gets capitalized.
    assert.equal(toStartCase("foo   bar"), "Foo   Bar");
  });

  test("leaves a word opening with a digit or an underscore as it stands", () => {

    // Only a letter is capitalized, so a word opening with anything else is untouched while the letter-led words around it still capitalize. These are the inputs
    // that distinguish the letter match from a broader word-character one, since uppercasing a digit or an underscore would be a no-op either way.
    assert.equal(toStartCase("1st place"), "1st Place");
    assert.equal(toStartCase("_private field"), "_private Field");
    assert.equal(toStartCase("abc 123 def"), "Abc 123 Def");
  });

  test("capitalizes a non-ASCII letter at the start of the string", () => {

    assert.equal(toStartCase("élan vital"), "Élan Vital");
    assert.equal(toStartCase("привет мир"), "Привет Мир");
    assert.equal(toStartCase("αλφα βήτα"), "Αλφα Βήτα");
  });

  test("capitalizes a non-ASCII letter after whitespace", () => {

    assert.equal(toStartCase("the élan of it"), "The Élan Of It");
  });

  test("passes a script that carries no case through unchanged", () => {

    assert.equal(toStartCase("東京 大阪"), "東京 大阪");
  });

  test("cases a letter outside the Basic Multilingual Plane as a single code point", () => {

    // Deseret small letter long I (U+10428) uppercases to Deseret capital letter long I (U+10400). A match reading UTF-16 code units rather than code points would
    // take the leading surrogate on its own, leaving the pair unchanged, so this asserts the whole code point is what gets matched and cased.
    assert.equal(toStartCase("\u{10428}x \u{10428}y"), "\u{10400}x \u{10400}y");
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

    // An emoji falls outside every character class a name may hold, so one anywhere in the name fails the match.
    assert.equal(validateName("Rocket \u{1F680}"), false);
  });

  test("rejects a letter that is also pictographic", () => {

    // U+2139 is a letter Unicode also marks pictographic, so a name's classes refuse it only because they subtract every pictograph.
    assert.equal(validateName("Info \u{2139}"), false);
  });

  test("rejects names containing disallowed punctuation", () => {

    assert.equal(validateName("Test|Switch"), false);
    assert.equal(validateName("Test/Switch"), false);
  });

  test("accepts a single character that may both start and end a name", () => {

    // A one-character name is its own first and last character, so a lone letter or number satisfies both ends of the rule at once.
    assert.equal(validateName("A"), true, "a single letter is a name");
    assert.equal(validateName("7"), true, "and so is a single number");
  });

  test("rejects a single character a name may not start with", () => {

    assert.equal(validateName("|"), false, "a character no name may hold is no name on its own");
    assert.equal(validateName("-"), false, "nor is one a name may hold only inside");
    assert.equal(validateName("."), false, "nor a period, which may end a name but never start one");
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

  test("strips every trailing character a name may not end with, so the result satisfies validateName", () => {

    // A hyphen and an ampersand are both allowed inside a name and neither may end one, so both have to go. Stripping only the last would leave "Test-", which the
    // validator rejects.
    assert.equal(sanitizeName("Test-&"), "Test");
    assert.equal(validateName(sanitizeName("Test-&")), true);

    // A longer run mixing a space and several permitted-but-not-final punctuation marks is stripped whole.
    assert.equal(sanitizeName("Test -&,#"), "Test");
    assert.equal(validateName(sanitizeName("Test -&,#")), true);

    // The trailing-period collapse runs after the strip, so periods the strip uncovers are collapsed too.
    assert.equal(sanitizeName("Test..-&"), "Test.");
  });

  test("keeps a single-character name, which validateName accepts, while an input with nothing valid still sanitizes to no name", () => {

    assert.equal(sanitizeName("A"), "A");
    assert.equal(validateName(sanitizeName("A")), true, "the sanitizer's answer for a one-letter name is one the validator accepts");
    assert.equal(sanitizeName("|"), "", "an input holding no permitted character sanitizes to the empty string");
    assert.equal(validateName(""), false, "which is not a name");
  });

  test("removes emojis entirely", () => {

    // Pictographic code points fall through the character-class replacement to a space, which is then trimmed out from the ends.
    assert.equal(sanitizeName("Rocket \u{1F680} Lamp"), "Rocket Lamp");
  });

  test("strips a letter that is also pictographic, so the result satisfies validateName", () => {

    // U+2139 is a letter Unicode also marks pictographic. The disallowed pass negates the same classes the validator matches, and those classes subtract every
    // pictograph, so the letter is stripped wherever it sits, in the form an emoji keyboard types too, and the answer is a name the validator accepts or no name at all.
    const rows: readonly (readonly [ string, string ])[] = [

      [ "Front \u{2139} Door", "Front Door" ],
      [ "\u{2139} Test", "Test" ],
      [ "Test \u{2139}", "Test" ],
      [ "A\u{2139}", "A" ],
      [ "\u{2139}", "" ],
      [ "\u{2139}\u{FE0F} Info", "Info" ],
      [ "Info \u{2139}\u{FE0F}", "Info" ],
      [ "\u{1F600} Lamp", "Lamp" ],
      [ "Garage \u{A9} Door", "Garage Door" ],
      [ "Test|Switch", "Test Switch" ],
      [ "Front Door", "Front Door" ]
    ];

    for(const [ input, expected ] of rows) {

      const answer = sanitizeName(input);

      assert.equal(answer, expected, "sanitizing " + JSON.stringify(input));
      assert.ok((answer === "") || validateName(answer), "the answer for " + JSON.stringify(input) + " is a name the validator accepts or no name at all");
    }
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

describe("assertPositiveInteger", () => {

  test("accepts a positive integer", () => {

    assert.doesNotThrow(() => assertPositiveInteger(1, { optionName: "capacity", owner: "RateBudget" }),
      "the smallest positive integer is a value every bounded option accepts");
    assert.doesNotThrow(() => assertPositiveInteger(4096, { optionName: "stdoutHighWater", owner: "LogSocket" }),
      "a large whole count is a value every bounded option accepts");
  });

  test("refuses a fractional value, naming the owner and the option", () => {

    assert.throws(() => assertPositiveInteger(1.5, { optionName: "capacity", owner: "RateBudget" }),
      { constructor: TypeError, message: "RateBudget: `capacity` must be a positive integer." });
  });

  test("refuses a value that is not a number at all", () => {

    assert.throws(() => assertPositiveInteger(Number.NaN, { optionName: "highWaterMark", owner: "AsyncQueue" }),
      { constructor: TypeError, message: "AsyncQueue: `highWaterMark` must be a positive integer." });

    // An infinite count describes no bound at all, so infinity is refused along with a value that is not a number.
    assert.throws(() => assertPositiveInteger(Number.POSITIVE_INFINITY, { optionName: "highWaterMark", owner: "AsyncQueue" }), TypeError);
  });

  test("refuses zero and a negative count", () => {

    assert.throws(() => assertPositiveInteger(0, { optionName: "stdoutHighWater", owner: "LogSocket" }),
      { constructor: TypeError, message: "LogSocket: `stdoutHighWater` must be a positive integer." });

    // A negative count is refused as well, because a negative bound describes no ceiling at all.
    assert.throws(() => assertPositiveInteger(-1, { optionName: "stdoutHighWater", owner: "LogSocket" }), TypeError);
  });
});

describe("assertPositiveFinite", () => {

  test("accepts a positive, finite quantity", () => {

    assert.doesNotThrow(() => assertPositiveFinite(1000, { optionName: "window", owner: "RateBudget", unit: "milliseconds" }),
      "a whole duration is a value every measured option accepts");
    assert.doesNotThrow(() => assertPositiveFinite(0.5, { optionName: "window", owner: "RateBudget", unit: "milliseconds" }),
      "a fractional quantity is fine where the unit is continuous");
  });

  test("refuses NaN, naming the owner, the option, and the unit", () => {

    assert.throws(() => assertPositiveFinite(Number.NaN, { optionName: "bodyLimit", owner: "HttpListener", unit: "bytes" }),
      { constructor: TypeError, message: "HttpListener: `bodyLimit` must be a positive, finite number of bytes." });
  });

  test("refuses an infinite value, naming the owner, the option, and the unit", () => {

    assert.throws(() => assertPositiveFinite(Number.POSITIVE_INFINITY, { optionName: "warmupMs", owner: "MdnsBrowser", unit: "milliseconds" }),
      { constructor: TypeError, message: "MdnsBrowser: `warmupMs` must be a positive, finite number of milliseconds." });
  });

  test("refuses zero and a negative quantity", () => {

    assert.throws(() => assertPositiveFinite(0, { optionName: "window", owner: "RateBudget", unit: "milliseconds" }),
      { constructor: TypeError, message: "RateBudget: `window` must be a positive, finite number of milliseconds." });

    // A negative quantity is refused as well, because a negative duration runs backwards.
    assert.throws(() => assertPositiveFinite(-5, { optionName: "window", owner: "RateBudget", unit: "milliseconds" }), TypeError);
  });
});
