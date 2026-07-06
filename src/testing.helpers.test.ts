/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the cross-cutting test helpers in testing.helpers.ts - expectAt, silentLog, capturingLog, assertNoUnhandledRejections.
 * Helpers earn the same enumerated-criteria coverage as production code per the testing convention - every branch, every error path, every async outcome - because
 * a bug in a shared helper cascades into every test that consumes it.
 */
import { assertNoUnhandledRejections, capturingLog, expectAt, silentLog } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import type { CapturingLog } from "./testing.helpers.ts";
import assert from "node:assert/strict";

describe("expectAt", () => {

  test("returns the indexed element when present", () => {

    const items = [ "a", "b", "c" ];

    assert.equal(expectAt(items, 0, "first"), "a", "expectAt(0) must return the first element");
    assert.equal(expectAt(items, 2, "last"), "c", "expectAt(last index) must return the last element");
  });

  test("throws an AssertionError naming the descriptor and index when the slot is empty", () => {

    // The contract per the docstring: AssertionError when the indexed slot is undefined. Verify both that the throw fires and that its message names the descriptor
    // and index, since those are the diagnostic affordance for failures in test bodies that walk a collection.
    assert.throws(() => expectAt([], 0, "missing record"), { message: /missing record at index 0/, name: "AssertionError" },
      "out-of-bounds access must throw with the descriptor and the literal index in the message");

    // Negative indices are explicitly out of contract per the docstring; they always fail because items[-1] is undefined.
    assert.throws(() => expectAt(["x"], -1, "negative"), { message: /negative at index -1/, name: "AssertionError" },
      "negative index must throw and surface the negative index in the message");
  });

  test("uses the default \"an item\" descriptor when the caller omits the description", () => {

    // Default-argument coverage: the docstring promises `description = "an item"` when omitted, and the failure message must reflect that default exactly so callers
    // who skip the descriptor still get a recognizable diagnostic.
    assert.throws(() => expectAt([], 0), { message: /an item at index 0/ }, "the default descriptor must appear in the failure message verbatim");
  });

  test("narrows readonly arrays the same way as mutable ones", () => {

    // Type-level confirmation that the single readonly T[] parameter accepts a readonly array the same way it accepts a mutable one. The runtime path is the
    // same; this test pins the type contract for `readonly T[]` callers (e.g., test bodies that walk a `readonly` snapshot of accumulator state).
    const items: readonly string[] = ["alpha"];

    assert.equal(expectAt(items, 0, "alpha slot"), "alpha", "readonly arrays must narrow through expectAt the same as mutable ones");
  });
});

describe("silentLog", () => {

  test("returns an object with debug/error/info/warn methods that do nothing", () => {

    // Trivial factory, but the test pins the entire surface so a future addition to the HomebridgePluginLogging interface that adds a new method without
    // updating silentLog would cause silent test failures elsewhere - this test surfaces the gap directly.
    const log = silentLog();

    assert.equal(typeof log.debug, "function", "silentLog must expose a .debug method");
    assert.equal(typeof log.error, "function", "silentLog must expose a .error method");
    assert.equal(typeof log.info, "function", "silentLog must expose a .info method");
    assert.equal(typeof log.warn, "function", "silentLog must expose a .warn method");

    // The methods must be safe to call with arbitrary arguments. The bodies are typed `(): void => {...}` so they return undefined implicitly; we cannot assert on
    // that return value (the lint rule blocks `assert.equal(voidCall(), undefined)` as a confusing void-expression composition), so the contract is verified by the
    // call simply not throwing. assert.doesNotThrow makes the intent explicit.
    assert.doesNotThrow(() => log.debug("anything", { extra: 1 }), "silentLog.debug must accept structured args without throwing");
    assert.doesNotThrow(() => log.info("a"));
    assert.doesNotThrow(() => log.warn("b", "c"));
    assert.doesNotThrow(() => log.error("d", new Error("ignored")));
  });

  test("returns a fresh logger per call (no shared state across consumers)", () => {

    // Each caller must own its own logger so test files cannot accidentally observe each other's log activity. Identity check is sufficient: distinct object
    // references prove the factory is not memoizing.
    assert.notEqual(silentLog(), silentLog(), "silentLog must return a fresh object per call");
  });
});

describe("capturingLog", () => {

  test("captures every emission with level, message, and structured params", () => {

    const log = capturingLog();

    log.debug("first", { ctx: 1 });
    log.info("second", "extra-string");
    log.warn("third");
    log.error("fourth", new Error("boom"));

    assert.equal(log.entries.length, 4, "every emission must surface as a captured entry");
    assert.deepEqual(log.entries[0], { level: "debug", message: "first", params: [{ ctx: 1 }] });
    assert.deepEqual(log.entries[1], { level: "info", message: "second", params: ["extra-string"] });
    assert.deepEqual(log.entries[2], { level: "warn", message: "third", params: [] });

    const errorEntry = log.entries[3];

    assert.ok(errorEntry, "error emission must produce an entry at the expected index");
    assert.equal(errorEntry.level, "error");
    assert.equal(errorEntry.message, "fourth");
  });

  test("preserves emission order (entries array is FIFO)", () => {

    // Order matters for tests asserting on log sequences; if entries were stored in a Set or unordered structure, race-sensitive tests would silently fail. Pin the
    // FIFO contract so a future refactor that swaps in an alternate container surfaces here.
    const log = capturingLog();
    const seq = [ 1, 2, 3, 4, 5 ];

    for(const i of seq) {

      log.info("msg-" + i.toString());
    }

    assert.deepEqual(log.entries.map((e) => e.message), seq.map((i) => "msg-" + i.toString()), "entries must reflect emission order strictly");
  });

  test("the entries view is readonly at the type level", () => {

    // Per the CapturingLog typedef, `entries` is `readonly TestLogEntry[]`. Tests can read but not push; this prevents accidental in-test corruption of captured
    // state mid-run. The type-level check is the only enforcement mechanism since `readonly` is erased at runtime - the assignment below would silently succeed
    // without `@ts-expect-error` policing it.
    const log: CapturingLog = capturingLog();

    log.info("anchor");

    assert.equal(log.entries.length, 1, "the underlying array still mutates from inside the factory");

    // @ts-expect-error - entries is readonly TestLogEntry[]; tests must not push directly.
    void log.entries.push;
  });

  test("returns a fresh logger per call (no shared entries across consumers)", () => {

    const a = capturingLog();
    const b = capturingLog();

    a.info("only on a");

    assert.equal(a.entries.length, 1, "entries must accumulate on the logger that received the emission");
    assert.equal(b.entries.length, 0, "the other logger must not see emissions from the first one");
  });
});

describe("assertNoUnhandledRejections", () => {

  test("returns the body's resolved value when no rejection occurs", async () => {

    // The success path: a body that resolves cleanly returns its value through the helper unchanged. The contract preserves the body's type (`<T>`) so callers can
    // assign through to the resolved shape without an extra `await`.
    const value = await assertNoUnhandledRejections(async () => 42);

    assert.equal(value, 42, "helper must return the body's resolved value verbatim");
  });

  test("throws the body's error when the body itself rejects", async () => {

    // If the body throws or rejects, that error must propagate - the helper's contract is about UNHANDLED rejections specifically, not about errors the body
    // produces directly. A body-thrown error is a handled rejection (the helper awaits and catches via the throw site) and must surface to the caller.
    await assert.rejects(async () => assertNoUnhandledRejections(async () => { throw new Error("body-direct"); }), { message: "body-direct" },
      "errors thrown directly by the body must propagate unchanged");
  });

  test("removes the unhandledRejection listener even when the body throws", async () => {

    // The finally clause is a hidden safety contract: the listener is added at entry and must come off at exit, success OR failure. If the listener leaked across
    // assertions, subsequent unrelated code that triggers a benign unhandledRejection would surface here. We verify by counting listeners before and after.
    const before = process.listenerCount("unhandledRejection");

    await assert.rejects(async () => assertNoUnhandledRejections(async () => { throw new Error("any"); }));

    const after = process.listenerCount("unhandledRejection");

    assert.equal(after, before, "the unhandledRejection listener must be removed in the finally clause regardless of how the body settled");
  });
});
