/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/index.test.ts: Unit tests for the cross-cutting test helpers in testing/index.ts - expectAt, present, silentLog, capturingLog, formatLogEntry, loggedAt,
 * logCount, assertNoUnhandledRejections, waitUntil, settle, settleUntil, advanceThroughSchedule, drainClock, freePort, listenOnLoopback, stopListening, errnoError.
 * Helpers earn the same enumerated-criteria coverage as production code per the testing convention - every branch, every error path, every async outcome - because a
 * bug in a shared helper cascades into every test that consumes it.
 */
import type { CapturingLog, TestLogEntry } from "./index.ts";
import { advanceThroughSchedule, assertNoUnhandledRejections, capturingLog, drainClock, errnoError, expectAt, formatLogEntry, freePort, listenOnLoopback, logCount,
  loggedAt, present, settle, settleUntil, silentLog, stopListening, waitUntil } from "./index.ts";
import { createConnection, createServer } from "node:net";
import { describe, test } from "node:test";
import { TestClock } from "../clock-double.ts";
import assert from "node:assert/strict";
import { causeChain } from "../util.ts";
import { classifyTransportError } from "../transport-error.ts";
import { once } from "node:events";

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

describe("present", () => {

  test("returns the value when it is present", () => {

    // A truthiness check would wrongly reject every one of these, which is why the assertion compares against undefined and null rather than reading the value's
    // own truth.
    assert.equal(present(0, "a zero count"), 0, "zero is present and must come back unchanged");
    assert.equal(present("", "an empty label"), "", "the empty string is present and must come back unchanged");
    assert.equal(present(false, "a disabled flag"), false, "false is present and must come back unchanged");
  });

  test("throws an AssertionError naming the description and the value for null and for undefined", () => {

    assert.throws(() => present(undefined, "a missing record"), { message: "expected a missing record, got undefined", name: "AssertionError" },
      "an undefined value must throw naming the lookup and rendering what arrived");
    assert.throws(() => present(null, "a missing record"), { message: "expected a missing record, got null", name: "AssertionError" },
      "a null value must throw naming the lookup and rendering what arrived");
  });

  test("narrows the result to its present type", () => {

    const source: string | undefined = "alpha";
    const narrowed: string = present(source, "the alpha entry");

    assert.equal(narrowed.length, 5, "the result must be usable as a string with no cast and no non-null assertion");
  });

  test("returns a present object unchanged", () => {

    const subject = { a: 1 };

    // Reference identity rather than deep equality is what proves the helper hands the value straight back instead of reconstructing it.
    assert.equal(present(subject, "an object"), subject, "a present object must come back as the same reference");
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

describe("settleUntil", () => {

  test("answers on the first read when the predicate already holds", async () => {

    let reads = 0;
    let crossed = false;

    setImmediate(() => {

      crossed = true;
    });

    await settleUntil(() => {

      reads++;

      return true;
    }, { description: "a condition that already holds" });

    assert.equal(reads, 1, "a predicate that already holds must be read once and no more");
    assert.equal(crossed, false, "an immediate queued before the call must not have run, which is what proves no turn was crossed");
  });

  test("keeps yielding until the predicate turns true", async () => {

    let reads = 0;

    await settleUntil(() => {

      reads++;

      return reads === 3;
    }, { description: "a condition that turns true on the third read" });

    assert.equal(reads, 3, "the helper must keep yielding and re-reading until the predicate answers true");
  });

  test("crosses one macrotask turn between attempts", async () => {

    // A chain whose steps each schedule the next advances by exactly one link per macrotask boundary, so a budget of one turn per step fits only a helper that
    // yields one turn per attempt. A body that yielded nothing would spend the budget with the chain still mid-flight and throw instead.
    let step = 0;

    const advance = (): void => {

      step++;

      if(step < 3) {

        setImmediate(advance);
      }
    };

    setImmediate(advance);

    await settleUntil(() => step === 3, { description: "a three-step chain to run to its end", turns: 3 });

    assert.equal(step, 3, "a three-link chain must run out inside a budget of three turns, which one turn per attempt reaches exactly");
  });

  test("throws naming the description and the turn budget when the predicate never holds", async () => {

    await assert.rejects(settleUntil(() => false, { description: "a condition that never holds", turns: 3 }),
      { message: "settleUntil: a condition that never holds did not hold within 3 macrotask turns." },
      "the failure must name the state that never arrived and the budget it was given");
  });

  test("spends exactly the turn budget before it throws", async () => {

    let reads = 0;

    await assert.rejects(settleUntil(() => {

      reads++;

      return false;
    }, { description: "a condition that never holds", turns: 3 }), { name: "Error" }, "a predicate that never holds must end in the budget's own failure");

    /* The predicate is read once before each of the three yields and once more on the turn that throws, so a count of four is exactly three yields crossed. The row
     * above cannot make this claim: its message is built from the `turns` option rather than from anything measured, so it reads the same whether the throw came
     * after three yields or four. This is what tells the specified body apart from one whose budget check reads `turn === (turns + 1)`.
     */
    assert.equal(reads, 4, "the budget must be spent on exactly three yields, which fails an off-by-one budget check");
  });

  test("spends no real time", async () => {

    let yielded = 0;
    let polled = 0;

    const yieldStarted = Date.now();

    await settleUntil(() => {

      yielded++;

      return yielded === 11;
    }, { description: "a condition that turns true on the eleventh read" });

    const yieldCost = Date.now() - yieldStarted;
    const pollStarted = Date.now();

    await waitUntil(() => {

      polled++;

      return polled === 11;
    }, { description: "a condition that turns true on the eleventh read" });

    const pollCost = Date.now() - pollStarted;

    /* The same ten attempts, driven both ways under the same load. `waitUntil` sleeps a 5 ms poll before each retry and so cannot finish inside 50 ms; this helper
     * only yields, so it pays scheduler overhead and nothing else. Comparing the two rather than testing against a written-down millisecond budget is what keeps
     * the row honest on a loaded runner, where an absolute threshold measures the machine instead of the helper.
     */
    assert.ok(yieldCost < pollCost, "yielding macrotask turns must cost less real time than sleeping a poll interval between the same attempts");
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

describe("freePort", () => {

  test("answers a port the kernel chose", async () => {

    const port = await freePort();

    assert.ok(port > 0, "the answer must be a real port rather than the zero that asked the kernel for one");
    assert.ok(port <= 65535, "a TCP port cannot exceed the 16-bit range the protocol gives it");
  });

  test("releases the port before it answers, so the caller can bind it immediately", async () => {

    const port = await freePort();
    const server = createServer();
    const listening = once(server, "listening");

    // The single attempt is the assertion. A probe that retried would let a late release pass as an on-time one, and a bind that found the port still held would
    // reject this wait rather than resolving it.
    server.listen(port);

    await listening;

    const address = server.address();

    assert.ok((address !== null) && (typeof address === "object"), "the rebound server must report the address it took");

    const bound = address.port;
    const closed = once(server, "close");

    server.close();

    await closed;

    assert.equal(bound, port, "the answered port must bind on the first attempt, which is what proves the helper released its own handle before answering");
  });

  test("answers a different port on a second call while the first is still held", async () => {

    const first = await freePort();
    const holder = createServer();
    const listening = once(holder, "listening");

    holder.listen(first);

    await listening;

    const second = await freePort();
    const closed = once(holder, "close");

    holder.close();

    await closed;

    assert.notEqual(second, first, "a second call must not answer a port the caller is already holding, which fails an implementation that reuses one socket");
  });
});

describe("listenOnLoopback and stopListening", () => {

  test("binds a server to a kernel-assigned loopback port and answers it", async () => {

    const server = createServer((socket) => socket.end("served"));
    const port = await listenOnLoopback(server);

    assert.ok(port > 0, "the kernel must have assigned a real port");

    const socket = createConnection(port, "127.0.0.1");
    const served = await new Promise<Buffer>((resolve) => void socket.once("data", (chunk: Buffer) => resolve(chunk)));

    socket.destroy();

    await stopListening(server);

    assert.equal(String(served), "served", "a real connection to the answered port must reach the handler the server was built with");
  });

  test("binds the loopback interface rather than the wildcard address", async () => {

    const server = createServer();

    await listenOnLoopback(server);

    const address = server.address();

    assert.ok((address !== null) && (typeof address === "object"), "the bound server must report an address object");
    assert.equal(address.address, "127.0.0.1", "the bind must name the loopback interface rather than the wildcard address a port reservation takes");

    await stopListening(server);
  });

  test("rejects carrying the kernel's error when the port cannot be bound", async () => {

    const holder = createServer();
    const port = await listenOnLoopback(holder);
    const contender = createServer();

    /* What this proves is the failure PATH - that a bind failure reaches the caller as the returned promise's rejection rather than as a hang or an unhandled
     * "error" event - and nothing more. It makes no claim about the order the listeners were attached in: `once` settles on "error" whichever order they went on.
     */
    await assert.rejects(listenOnLoopback(contender, port), { code: "EADDRINUSE" });

    await stopListening(holder);
  });

  test("asks the kernel for a free port when none is named", async () => {

    const first = createServer();
    const second = createServer();
    const firstPort = await listenOnLoopback(first);
    const secondPort = await listenOnLoopback(second);

    assert.ok(firstPort > 0, "a defaulted call must answer a real port");
    assert.ok(secondPort > 0, "a second defaulted call must answer a real port");
    assert.notEqual(firstPort, secondPort, "two defaulted calls must not collide, which is what asking the kernel buys over a written-down number");

    await stopListening(first);
    await stopListening(second);
  });

  test("binds the port the caller names", async () => {

    const first = createServer();
    const named = await listenOnLoopback(first);

    await stopListening(first);

    const fresh = createServer();
    const rebound = await listenOnLoopback(fresh, named);

    // This is the case a fixture coming back on the address a client is already reconnecting to needs, and the row that would redden if the parameter were dropped.
    assert.equal(rebound, named, "a caller-named port must be the port that gets bound");

    await stopListening(fresh);
  });

  test("releases the handle, so the port rebinds in a single attempt", async () => {

    const server = createServer();
    const port = await listenOnLoopback(server);

    await stopListening(server);

    // The single attempt is the assertion: a rebind that needed a poll would mean the handle outlived the close this helper already resolved.
    const rebound = createServer();
    const reboundPort = await listenOnLoopback(rebound, port);

    assert.equal(reboundPort, port, "the released port must rebind on the first attempt, which proves the close resolved only once the handle was gone");

    await stopListening(rebound);
  });

  test("resolves for a server that never listened", async () => {

    // Node reports this close through the callback as an Error whose code is ERR_SERVER_NOT_RUNNING, and the helper reads that as its postcondition already met
    // rather than as a failure.
    await assert.doesNotReject(stopListening(createServer()), "closing a server that never listened must resolve rather than throwing");
  });

  test("resolves a second time after a close", async () => {

    const server = createServer();

    await listenOnLoopback(server);
    await stopListening(server);

    // This is the contract the HTTP listener suite's blocker depends on: an arm that frees a port by hand mid-body still lets its `await using` scope dispose the
    // same server, and the scope's own call has to find nothing left to do.
    await assert.doesNotReject(stopListening(server), "a second close must resolve, which is what keeps a scope disposal after a hand release a no-op");
  });
});

/* Compile-time exercises for the two clauses of the factory's signature that have no runtime footprint. These never run - the arrow is never called - and the gate
 * that reads them is `npx tsc --noEmit`, where each `@ts-expect-error` is consumed by the diagnostic its comment names and an unconsumed one reports TS2578.
 */
const _errnoErrorShapeExercises = (): void => {

  const stringCoded = errnoError("write EPIPE", "EPIPE");

  /* Writing back the SAME literal the error already carries is what isolates the modifier. A different literal is rejected by the code's own literal type whether
   * or not `readonly` is there, so a row written that way keeps compiling after the modifier is dropped and proves nothing about it.
   */
  // @ts-expect-error - the return type declares `code` readonly, so even a write of the value it already holds does not compile.
  stringCoded.code = "EPIPE";

  // A string code yields a type the platform's own errno shape admits, which is what a consumer declaring its listeners over NodeJS.ErrnoException needs.
  const _asErrno: NodeJS.ErrnoException = errnoError("write EPIPE", "EPIPE");

  // @ts-expect-error - a numeric code yields `Error & { readonly code: 20 }`, which the platform's errno shape does not admit, because its own code is a string.
  const _numericAsErrno: NodeJS.ErrnoException = errnoError("legacy", 20);
};

describe("errnoError", () => {

  test("builds an error carrying the message and the code", () => {

    const error = errnoError("write EPIPE", "EPIPE");

    assert.ok(error instanceof Error, "the result must be a real Error rather than a plain object wearing the shape");
    assert.equal(error.message, "write EPIPE", "the message must be the one the caller named");
    assert.equal(error.code, "EPIPE", "the code must be the one the caller named");
  });

  test("accepts the platform's numeric code as well as an errno string", () => {

    // The platform's own DOMException carries a numeric code, and the transport classifier has a branch that steps over one, so a fixture has to be able to carry it.
    const numeric = errnoError("legacy", 20);

    assert.equal(numeric.code, 20, "a numeric code must be carried through unchanged");
  });

  test("carries no cause property at all when none was given", () => {

    /* The library's cause descent ends on `"cause" in link` rather than on a value check, so an own `cause` valued undefined would send it one link further than
     * the error actually goes. This row is what holds the conditional construction in place, and it is the one a rewrite to an unbranched `{ cause }` breaks.
     */
    assert.equal("cause" in errnoError("no cause here", "ENOENT"), false, "omitting the cause must leave no cause property on the result at all");
  });

  test("attaches a cause through the Error options bag when one was given", () => {

    const root = errnoError("innermost", "ECONNREFUSED");
    const wrapper = errnoError("outer", "EPIPE", root);

    assert.equal(wrapper.cause, root, "the cause must be the exact value the caller handed in");
    assert.deepEqual([...causeChain(wrapper)], [ wrapper, root ], "the whole chain must be walkable by the library's own descent");
  });

  test("produces an error the transport classifier reads the code off", () => {

    // The integration the factory exists for: a fixture it built has to classify exactly as the hand-rolled shape it replaces did.
    assert.equal(classifyTransportError(errnoError("name not resolved", "ENOTFOUND")).kind, "dns",
      "the classifier must read the factory's code and answer the kind that code maps to");
  });
});
