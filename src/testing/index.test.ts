/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/index.test.ts: Unit tests for the cross-cutting test helpers in testing/index.ts - expectAt, silentLog, capturingLog, formatLogEntry, loggedAt, logCount,
 * assertNoUnhandledRejections, waitUntil, settle, advanceThroughSchedule, drainClock. Helpers earn the same enumerated-criteria coverage as production code per the
 * testing convention - every branch, every error path, every async outcome - because a bug in a shared helper cascades into every test that consumes it.
 */
import type { CapturingLog, TestLogEntry } from "./index.ts";
import { advanceThroughSchedule, assertNoUnhandledRejections, capturingLog, drainClock, expectAt, formatLogEntry, logCount, loggedAt, settle, silentLog,
  waitUntil } from "./index.ts";
import { describe, test } from "node:test";
import { TestClock } from "../clock-double.ts";
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
    // same; this test locks in the type contract for `readonly T[]` callers (e.g., test bodies that walk a `readonly` snapshot of accumulator state).
    const items: readonly string[] = ["alpha"];

    assert.equal(expectAt(items, 0, "alpha slot"), "alpha", "readonly arrays must narrow through expectAt the same as mutable ones");
  });
});

describe("silentLog", () => {

  test("returns an object with debug/error/info/warn methods that do nothing", () => {

    // Trivial factory, but the test locks in the current method surface explicitly rather than relying on structural typing to catch drift. Because silentLog
    // spreads the typed noOpLog object, TypeScript already rejects a HomebridgePluginLogging addition that noOpLog fails to implement - the real gap this
    // test guards is a method that compiles cleanly on both the interface and noOpLog but is never added to the assertions below.
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

    // Order matters for tests asserting on log sequences; if entries were stored in a Set or unordered structure, race-sensitive tests would silently fail. Assert the
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
    // state mid-run. The type-level check is the only enforcement mechanism since `readonly` is erased at runtime - the property access below would silently
    // succeed without `@ts-expect-error` policing it.
    const log: CapturingLog = capturingLog();

    log.info("anchor");

    assert.equal(log.entries.length, 1, "the underlying array still mutates from inside the factory");

    // @ts-expect-error - entries is readonly TestLogEntry[]; tests must not push directly.
    const _push: unknown = log.entries.push;
  });

  test("returns a fresh logger per call (no shared entries across consumers)", () => {

    const a = capturingLog();
    const b = capturingLog();

    a.info("only on a");

    assert.equal(a.entries.length, 1, "entries must accumulate on the logger that received the emission");
    assert.equal(b.entries.length, 0, "the other logger must not see emissions from the first one");
  });
});

describe("formatLogEntry", () => {

  test("interpolates params into the message's format tokens", () => {

    // The expectation is written out literally rather than derived from a `util.format` call of our own, which would assert only that the implementation equals
    // itself and would pass just as happily if the render were dropped on both sides.
    const entry: TestLogEntry = { level: "info", message: "Motion on %s at %d.", params: [ "porch", 5 ] };

    assert.equal(formatLogEntry(entry), "Motion on porch at 5.", "each token must be replaced by the param in the corresponding position");
  });

  test("returns the message unchanged when there are no params, including an unconsumed token", () => {

    // A message logged with no params is not a template awaiting arguments...an unconsumed token stays exactly as written, so a finder matching the rendered line
    // still sees the literal "%s" a caller wrote.
    assert.equal(formatLogEntry({ level: "warn", message: "Stream stalled.", params: [] }), "Stream stalled.", "a message with no tokens must survive verbatim");
    assert.equal(formatLogEntry({ level: "warn", message: "A literal %s token.", params: [] }), "A literal %s token.",
      "with no params there is nothing to substitute, so the token itself is the output");
  });
});

describe("loggedAt and logCount", () => {

  test("finds a value that lives only in params, where a raw message match cannot see it", () => {

    // This is the whole reason the family exists, so both halves are asserted together: the value the caller wants to hold fixed is a format parameter, and the captured
    // message carries only the token that will consume it.
    const entries: TestLogEntry[] = [{ level: "warn", message: "Retrying in %d seconds.", params: [30] }];
    const entry = expectAt(entries, 0, "the retry entry");

    assert.equal(entry.message.includes("30"), false, "the captured message holds the token rather than the value, so a raw match must miss it");
    assert.ok(loggedAt(entries, "warn", "30"), "the rendered line holds the value, so the finder must match it");
  });

  test("restricts both the search and the count to the requested level", () => {

    // The same text at two severities is a realistic shape - a line that is debug detail in one path and a reported failure in another - and "this was reported as
    // an error" is the claim a test means to make.
    const entries: TestLogEntry[] = [

      { level: "debug", message: "Connection refused.", params: [] },
      { level: "info", message: "Connection refused.", params: [] }
    ];

    assert.equal(loggedAt(entries, "error", "Connection refused"), false, "matches at other levels must not satisfy an error-level search");
    assert.ok(loggedAt(entries, "debug", "Connection refused"), "the same text at the requested level must match");
    assert.equal(logCount(entries, "error", "Connection refused"), 0, "the count must ignore entries at other levels");
    assert.equal(logCount(entries, "debug", "Connection refused"), 1, "the count must include the requested level only");
  });

  test("counts every match at the level rather than reporting mere presence", () => {

    // Two matches at the level, one at another level, one non-matching entry. A count that collapsed to a presence test would report 1 here and pass every
    // exactly-once assertion a retry loop is supposed to fail.
    const entries: TestLogEntry[] = [

      { level: "error", message: "Unable to publish to %s.", params: ["test/device1/status"] },
      { level: "error", message: "Unable to publish to %s.", params: ["test/device2/status"] },
      { level: "info", message: "Unable to publish to %s.", params: ["test/device3/status"] },
      { level: "error", message: "Connected to the broker.", params: [] }
    ];

    assert.equal(logCount(entries, "error", "Unable to publish"), 2, "both error-level matches must be counted, and neither the info-level nor the unrelated entry");
    assert.ok(loggedAt(entries, "error", "Unable to publish"), "a repeated line is still found");
    assert.equal(loggedAt(entries, "error", "Unable to subscribe"), false, "a substring that appears nowhere must not match");
    assert.equal(logCount(entries, "error", "Unable to subscribe"), 0, "a substring that appears nowhere must count zero");
  });

  test("reports nothing found against an empty entries array", () => {

    assert.equal(loggedAt([], "info", "anything"), false, "an empty array can carry no match");
    assert.equal(logCount([], "info", "anything"), 0, "an empty array counts zero");
  });

  test("composes with a live capturingLog, including over a slice of its entries", () => {

    const log = capturingLog();

    log.info("Connected to %s.", "mqtt://127.0.0.1:1883");
    log.warn("Retrying in %d seconds.", 30);

    assert.ok(loggedAt(log.entries, "info", "mqtt://127.0.0.1:1883"), "the readonly entries view must feed the finders with no adaptation");
    assert.equal(logCount(log.entries, "warn", "Retrying"), 1, "the count reads the live capture the same way it reads a literal array");

    // Searching a slice is the reason the finders take the entries array rather than the logger: it answers "one more line after this point" without a second
    // logger, and the slice's own entries must still render their params.
    const before = log.entries.length;

    log.warn("Retrying in %d seconds.", 60);

    assert.equal(logCount(log.entries.slice(before), "warn", "Retrying"), 1, "a slice must see only the entries it contains");
    assert.ok(loggedAt(log.entries.slice(before), "warn", "60"), "an entry reached through a slice must still be rendered before matching");
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

describe("waitUntil", () => {

  test("resolves on the first read when the predicate already holds", async () => {

    // The helper reads the predicate before it ever sleeps, so a state that has already settled costs no wait at all. Counting the reads is what proves that: a helper
    // that slept first would still resolve, just a poll interval later than it needed to, and no assertion on the outcome alone would notice.
    let reads = 0;

    await waitUntil(() => {

      reads++;

      return true;
    }, { description: "a condition that already holds" });

    assert.equal(reads, 1, "a settled predicate must be read once and answered without a wait");
  });

  test("keeps polling until the predicate turns true", async () => {

    // The case the helper exists for: a state that settles later than the read that first asked about it. Counting the reads keeps the row deterministic - it holds
    // the loop count fixed rather than a duration, so nothing here depends on how a loaded CI runner schedules the sleeps.
    let reads = 0;

    await waitUntil(() => {

      reads++;

      return reads >= 3;
    }, { description: "the third read to come back true", pollMs: 1 });

    assert.equal(reads, 3, "the helper must keep polling until the predicate answers true");
  });

  test("throws naming the description and the deadline when the predicate never holds", async () => {

    // The whole point of a deadline over a fixed sleep: it fails loudly, and the message names the state the caller was waiting for rather than the shape of the
    // wait. A reader meeting this line in a CI log should know what did not happen without opening the test.
    await assert.rejects(async () => waitUntil(() => false, { description: "a condition that never holds", pollMs: 1, timeoutMs: 20 }),
      { message: "waitUntil: a condition that never holds did not hold within 20 ms." },
      "an expired deadline must throw with the caller's description and the deadline it was given");
  });
});

describe("settle", () => {

  test("yields one macrotask by default, so a continuation chain queued before the call has run when it resolves", async () => {

    // The two flags are the two queues the helper has to clear. A macrotask callback only runs once the loop reaches the immediate phase, and a promise chain only
    // unwinds as its microtasks drain...one turn of the yield reaches both, which is the whole reason a suite awaits this instead of a bare promise.
    let fired = false;
    let chained = false;

    setImmediate(() => {

      fired = true;
    });

    void Promise.resolve().then(() => "first").then(() => "second").then(() => {

      chained = true;
    });

    await settle();

    assert.equal(fired, true, "one turn must cross the macrotask boundary, so a queued immediate has run");
    assert.equal(chained, true, "one turn must drain the microtask cascade, so a chained continuation has run");
  });

  test("yields one macrotask per turn", async () => {

    // A cascade that schedules its next step from inside the last one crosses a boundary per step, which is the case a caller names more turns for. Chaining three
    // immediates and counting them after two turns and then a third is what tells a per-turn yield apart from one that always crosses a single boundary.
    let turns = 0;

    const chain = (remaining: number): void => {

      if(remaining === 0) {

        return;
      }

      setImmediate(() => {

        turns++;
        chain(remaining - 1);
      });
    };

    chain(3);

    await settle(2);

    assert.equal(turns, 2, "two turns must cross two macrotask boundaries, running two links of the chain");

    await settle();

    assert.equal(turns, 3, "a further turn must run the link the second turn released");
  });
});

describe("advanceThroughSchedule", () => {

  test("releases a chain of waits one step at a time", async () => {

    // The reason the walk exists: the second wait is registered only when the first one resolves, so a single advance across the whole schedule would move past a
    // deadline nothing had asked for yet and strand the body at its second await. Stepping with a yield between the steps releases them in order.
    const clock = new TestClock();

    let done = false;

    void (async (): Promise<void> => {

      await clock.delay(100);
      await clock.delay(200);

      done = true;
    })();

    await advanceThroughSchedule(clock, [ 100, 200 ]);

    assert.equal(done, true, "the walk must release every wait in the schedule, leaving the body finished");
    assert.equal(clock.now(), 300, "virtual time must land on the sum of the schedule");
  });

  test("lets the attempt the last step released run to completion", async () => {

    // The trailing yield is what separates a released wait from a finished body. Without it the last advance resolves the delay and the walk returns before the
    // continuation waiting on it has run, and the caller reads state its own call already produced.
    const clock = new TestClock();

    let finished = false;

    void (async (): Promise<void> => {

      await clock.delay(50);

      // A real attempt's continuation chain runs more than one microtask deep before it acts, which is exactly what the trailing yield exists to cover.
      await Promise.resolve();

      finished = true;
    })();

    await advanceThroughSchedule(clock, [50]);

    assert.equal(finished, true, "the trailing yield must let the continuation the last step released run before the walk answers");
  });
});

describe("drainClock", () => {

  test("steps to each pending deadline until the clock is idle and answers the step count", async () => {

    // The drain is the walk for a caller that does not know the schedule: it asks the clock where the next deadline is rather than being told. Two sequential waits
    // are two deadlines, and an idle clock at the end is what proves the loop stopped because there was nothing left rather than because it gave up.
    const clock = new TestClock();

    let done = false;

    void (async (): Promise<void> => {

      await clock.delay(100);
      await clock.delay(200);

      done = true;
    })();

    const steps = await drainClock(clock);

    assert.equal(steps, 2, "each deadline the drain steps to must count once");
    assert.equal(done, true, "the drain must leave the body finished");
    assert.equal(clock.pending, 0, "the drain must end with nothing pending");
  });

  test("answers zero for an idle clock", async () => {

    // A clock with nothing registered is the boundary case the loop's first check owns: the drain must answer immediately rather than advancing time nobody asked
    // it to move.
    const steps = await drainClock(new TestClock());

    assert.equal(steps, 0, "a clock with nothing pending must cost no steps at all");
  });

  test("throws naming the limit when a repeating timer keeps the clock busy", async () => {

    // A repeating timer re-arms itself on every fire, so the pending list never empties and an unbounded drain would spin until the runner killed the suite. The
    // bound turns that hang into a message that names what happened and how far the drain got.
    const clock = new TestClock();
    const handle = clock.schedule(() => undefined, 10, { repeat: true });

    try {

      await assert.rejects(async () => drainClock(clock, 3), { message: "drainClock: the clock still had entries pending after 3 steps.", name: "Error" },
        "a drain that exceeds its bound must throw naming the limit rather than spinning");
    } finally {

      handle[Symbol.dispose]();
    }
  });

  test("lets the continuation after the last deadline run before answering", async () => {

    // The same contract the walk's trailing yield carries, in the drain's shape: the pass that finds nothing pending yields before it looks, so the work released
    // by the last deadline has run by the time the count comes back.
    const clock = new TestClock();

    let finished = false;

    void (async (): Promise<void> => {

      await clock.delay(10);

      finished = true;
    })();

    await drainClock(clock);

    assert.equal(finished, true, "the drain must answer only once the work its last step released has run");
  });

  test("yields before the first step, so a body that reaches the clock a microtask late still drains", async () => {

    // A subject does not always register its first wait synchronously...a body that awaits anything at all on its way to the clock registers a turn later. The
    // yield at the top of the pass is what lets the drain see that wait, rather than reading an empty list and deciding the clock was idle all along.
    const clock = new TestClock();

    let finished = false;

    void (async (): Promise<void> => {

      await Promise.resolve();
      await clock.delay(10);

      finished = true;
    })();

    const steps = await drainClock(clock);

    assert.equal(steps, 1, "the leading yield must let a late registration reach the clock before the drain asks for a deadline");
    assert.equal(finished, true, "the drain must leave the body finished");
    assert.equal(clock.pending, 0, "the drain must end with nothing pending");
  });
});
