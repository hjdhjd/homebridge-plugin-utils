/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.test.ts: Unit tests for the injectable Clock contract - the compile-time conformance and behavior-neutrality of the production systemClock (its now() tracks
 * Date.now(), its delay() IS node:timers/promises setTimeout including the AbortError shape, its schedule() IS the global callback timers read at call time and
 * forwards an unref to the platform handle's own unref(), and its timeout() IS AbortSignal.timeout), plus the shipped controllable TestClock double (advanceable
 * virtual time, deadline-ordered resolution, the advance(0)/negative flush, the matched node:timers/promises AbortError on abort, the no-listener-leak teardown on
 * both resolution paths, the requested history across every settlement path, the earliest-pending-deadline read, the step that lands on that deadline, the callback
 * timers that share that one timeline with the delays, the deadline signals whose reason a consumer cannot tell apart from the platform's, and the unref it accepts
 * and ignores because a virtual timeline has no process to hold open).
 */
import { describe, test } from "node:test";
import { getEventListeners, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Clock } from "./clock.ts";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { isTimeoutReason } from "./util.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { systemClock } from "./clock.ts";
import { tmpdir } from "node:os";

// Flush the microtask queue so a delay that became due during a synchronous `advance` has run its `resolve`/`reject` continuation before the test inspects the outcome.
// `advance` settles each due entry synchronously, but the awaiting code runs on a later microtask; a bare `await Promise.resolve()` yields long enough for those to run.
async function flushMicrotasks(): Promise<void> {

  await Promise.resolve();
}

// Assert that `thrown` is the AbortError shape that `node:timers/promises` setTimeout produces on abort: a name of "AbortError" and a STRING code of "ABORT_ERR". This is
// the fidelity anchor - both systemClock (the real primitive) and TestClock (the fabricated double) must satisfy it identically. We assert `name` + `code` ONLY, never
// `instanceof DOMException` or constructor identity, because the real rejection is a dedicated internal class (not a DOMException, whose code is the numeric 20) with no
// constructable global, so those identities cannot match.
function assertAbortError(thrown: unknown, message: string): void {

  assert.ok(thrown instanceof Error, message + " - the rejection must be an Error");
  assert.equal(thrown.name, "AbortError", message + " - name must be AbortError");
  assert.equal((thrown as Error & { code?: unknown }).code, "ABORT_ERR", message + " - code must be the string ABORT_ERR");
}

// Assert that `reason` is the deadline shape `AbortSignal.timeout` aborts with: a DOMException named "TimeoutError" that the library's own predicate accepts. This is
// the fidelity anchor for the third time shape - systemClock (the platform call itself) and TestClock (the fabricated double) must both satisfy it, because a consumer
// branching on a deadline reason must not be able to tell which clock produced it. Unlike the AbortError shape above, the constructor identity IS assertable here:
// DOMException is a constructable global, so the double reproduces the real class rather than only its observable fields.
function assertTimeoutReason(reason: unknown, message: string): void {

  assert.ok(reason instanceof DOMException, message + " - the reason must be a DOMException");
  assert.equal(reason.name, "TimeoutError", message + " - name must be TimeoutError");
  assert.equal(isTimeoutReason(reason), true, message + " - isTimeoutReason must accept it");
}

/**
 * Allocate a per-test tmpdir scratch root and answer an AsyncDisposable handle that removes it on scope exit, so the `await using` at the call site cleans up even
 * when the row throws. The CLI suite carries a helper of the same shape; each suite keeps its own rather than sharing one, so this suite's single filesystem row
 * does not reach across into another suite's file for a utility this small.
 *
 * @returns An AsyncDisposable carrying the scratch root's path.
 */
async function makeScratchRoot(): Promise<AsyncDisposable & { path: string }> {

  const path = await mkdtemp(join(tmpdir(), "hbpu-clock-"));

  return {

    path,
    async [Symbol.asyncDispose](): Promise<void> {

      await rm(path, { force: true, recursive: true });
    }
  };
}

describe("systemClock - conformance and behavior-neutrality", () => {

  test("satisfies the Clock contract at compile time", () => {

    // The no-drift proof is purely type-level: the compiler enforces that the production const is assignable to the contract. A `satisfies` expression that fails to
    // compile fails the build; the runtime assertion is belt-and-suspenders that the binding is the same object.
    const conforms = systemClock satisfies Clock;

    assert.equal(conforms, systemClock, "systemClock must satisfy the Clock contract");
  });

  test("now() returns Date.now() within a tiny tolerance", () => {

    const before = Date.now();
    const observed = systemClock.now();
    const after = Date.now();

    assert.ok((observed >= before) && (observed <= after), "systemClock.now() must read the wall clock, falling within the surrounding Date.now() readings");
  });

  test("delay() resolves after the real elapsed time", async () => {

    // The ONE acceptable real wait in this suite: a fake clock cannot test the REAL clock, so we await a tiny 1ms real delay, mirroring the retry suite's `backoff: () =>
    // 1` idiom. We assert resolution only, not precise timing, since real-timer scheduling is not exact.
    await systemClock.delay(1);

    assert.ok(true, "systemClock.delay() must resolve after the real delay elapses");
  });

  test("delay() with a pre-aborted signal rejects with the node:timers/promises AbortError", async () => {

    const controller = new AbortController();

    controller.abort();

    await assert.rejects(() => systemClock.delay(50, { signal: controller.signal }), (error: unknown) => {

      assertAbortError(error, "systemClock pre-aborted delay");

      return true;
    });
  });

  test("delay() aborted mid-wait rejects with an AbortError, NOT the custom reason", async () => {

    const controller = new AbortController();

    // Use a custom Symbol reason to prove it does NOT surface: the real primitive rejects with its own AbortError, never `signal.reason`. This captures the exact shape
    // the TestClock double must reproduce.
    const customReason = Symbol("custom-abort-reason");
    const waited = systemClock.delay(1000, { signal: controller.signal });

    controller.abort(customReason);

    await assert.rejects(() => waited, (error: unknown) => {

      assertAbortError(error, "systemClock mid-wait delay");
      assert.notEqual(error, customReason, "the rejection must NOT be the custom signal reason");

      return true;
    });
  });

  test("systemClock.schedule arms the global timers, so a harness that replaces them observes every timer", (t) => {

    // The per-test enable is auto-restored when the row ends, so the real-time row that follows is never driven by a mock left running. This is the one mock-timer
    // use this suite keeps, because it is the contract every consumer suite that drives mock timers through an injected clock depends on.
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });

    // Both arms carry the unref policy, because a mocked timer handle carries `unref` just as the real one does. That is what lets a consumer suite driving mock
    // timers through a clock built with the policy set keep working, rather than meeting a missing method on the mock.
    const fired: string[] = [];
    const oneShot = systemClock.schedule(() => fired.push("one-shot"), 10, { unref: true });

    t.mock.timers.tick(10);

    assert.deepEqual(fired, ["one-shot"], "the production clock's one-shot is a global timer the harness can tick");

    const repeat = systemClock.schedule(() => fired.push("repeat"), 10, { repeat: true, unref: true });

    t.mock.timers.tick(20);

    assert.deepEqual(fired, [ "one-shot", "repeat", "repeat" ], "and its repeat is a global interval firing once per window");

    repeat[Symbol.dispose]();
    t.mock.timers.tick(1000);

    assert.equal(fired.length, 3, "disposing the handle cancels the underlying global timer, so a further tick fires nothing");

    oneShot[Symbol.dispose]();
  });

  test("systemClock.schedule fires a one-shot against real elapsed time", async () => {

    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    const handle = systemClock.schedule((): void => resolve(), 5);

    await promise;

    handle[Symbol.dispose]();
  });

  test("an unreferenced timer is absent from the process's active timers, while a referenced one counts", () => {

    /* The runner holds timers of its own, so every reading below is a delta against a synchronous sample rather than an absolute count, and nothing awaits between
     * an arm and the read that follows it - no other timer can enter or leave the list in between. The delivery supervisor's suite reads the platform's active
     * timers the same way, for the same reason.
     */
    const activeTimers = (): number => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    const sample = activeTimers();
    const referencedOneShot = systemClock.schedule((): void => undefined, 60000);
    const referencedRepeat = systemClock.schedule((): void => undefined, 60000, { repeat: true });

    assert.equal(activeTimers(), sample + 2, "a referenced one-shot and a referenced repeat each hold the process open");

    referencedOneShot[Symbol.dispose]();
    referencedRepeat[Symbol.dispose]();

    assert.equal(activeTimers(), sample, "and disposing them releases it again");

    // The referenced pair above is disposed by hand because its release is half of what this row reads. The unreferenced pair is held in `using` declarations
    // instead, so the assertion below can fail without stranding a live interval in the runner's loop.
    using unreferencedOneShot = systemClock.schedule((): void => undefined, 60000, { unref: true });
    using unreferencedRepeat = systemClock.schedule((): void => undefined, 60000, { repeat: true, unref: true });

    assert.equal(activeTimers(), sample, "an unreferenced one-shot and an unreferenced repeat stand pending without counting against the process");
    assert.notEqual(unreferencedOneShot, unreferencedRepeat, "each arm answers its own cancelling handle");
  });

  test("a process whose only pending work is unreferenced timers exits on its own", async () => {

    /* The process-lifetime property cannot be read from inside this suite, because the runner holds the event loop open on its own account. A child whose entire
     * pending workload is two unreferenced timers is the smallest arrangement that shows it: the child has to reach its own exit while both timers are still an
     * hour from firing. The deadline on the spawn is what makes this a proof - a child that instead held its timers would be killed and answer a null code, which
     * fails the assertion rather than hanging the suite.
     */
    await using scratch = await makeScratchRoot();

    const childPath = join(scratch.path, "unreferenced-timers.ts");
    const clockPath = fileURLToPath(new URL("./clock.ts", import.meta.url));

    // The child imports this repo's own clock by absolute path, quoted through JSON.stringify so a scratch root carrying a quote or a backslash still yields a
    // valid specifier. Composing the source by concatenation keeps the file free of template literals, as everything else here is.
    await writeFile(childPath, "import { systemClock } from " + JSON.stringify(clockPath) + ";\n\n" +
      "systemClock.schedule(() => undefined, 3600000, { unref: true });\n" +
      "systemClock.schedule(() => undefined, 3600000, { repeat: true, unref: true });\n" +
      "console.log(\"armed\");\n", "utf8");

    // Propagate a type-stripping flag, and only that flag, when the runner carries one, so the child can execute a .ts entry; never the --test, --import, or
    // coverage flags, which would derail it into a second test run. On a runtime that strips types by default the flag is absent and the child runs flagless.
    const stripFlag = process.execArgv.find((arg) => (arg === "--strip-types") || (arg === "--experimental-strip-types"));
    const childArgs = stripFlag ? [ stripFlag, childPath ] : [childPath];
    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolveResult) => {

      const stderrChunks: Buffer[] = [];
      const stdoutChunks: Buffer[] = [];
      const child = spawn(process.execPath, childArgs, { signal: AbortSignal.timeout(10000), stdio: [ "ignore", "pipe", "pipe" ] });

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      // A child killed at the deadline surfaces here as an error rather than as a clean close, so this listener is what turns a hung child into a failed assertion.
      child.on("error", (error: Error) => resolveResult({ code: null, stderr: error.message, stdout: "" }));
      child.on("close", (code) => resolveResult({ code, stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8") }));
    });

    assert.equal(result.code, 0, "the child must reach its own exit with both timers still pending; stderr: " + result.stderr);
    assert.equal(result.stdout, "armed\n", "and must have armed both of them before exiting; stderr: " + result.stderr);
  });

  test("systemClock.timeout answers the platform's deadline signal, aborting with its TimeoutError", async () => {

    // The other acceptable real wait in this suite, for the same reason as the delay() row above: only the real clock can prove the real deadline, so we await a 1ms
    // platform timeout. The signal's timer is unreferenced, but the test runner holds the process open, so the abort arrives.
    const signal = systemClock.timeout(1);

    assert.equal(signal.aborted, false, "a freshly armed deadline must not be aborted synchronously");

    await once(signal, "abort");

    assertTimeoutReason(signal.reason, "systemClock deadline signal");
  });
});

describe("TestClock - construction and now()", () => {

  test("a bare new TestClock() seeds the virtual time at 0", () => {

    const clock = new TestClock();

    assert.equal(clock.now(), 0, "the default-constructed clock must report a virtual time of 0");
  });

  test("a seeded TestClock reflects the seed and each advance", () => {

    const clock = new TestClock(1000);

    assert.equal(clock.now(), 1000, "the seeded clock must report the seed");

    clock.advance(250);
    assert.equal(clock.now(), 1250, "advance must move the virtual time forward by the delta");

    clock.advance(-100);
    assert.equal(clock.now(), 1150, "a negative advance must move the virtual time backward by the delta");
  });
});

describe("TestClock - delay resolution and ordering", () => {

  test("a delay does not resolve before advance crosses its deadline, and does after", async () => {

    const clock = new TestClock();
    let resolved = false;

    const waited = clock.delay(100).then(() => {

      resolved = true;
    });

    clock.advance(50);
    await flushMicrotasks();
    assert.equal(resolved, false, "a delay must NOT resolve before its deadline is crossed");
    assert.equal(clock.pending, 1, "the unresolved delay must still be pending");

    clock.advance(50);
    await waited;
    assert.equal(resolved, true, "a delay must resolve once advance crosses its deadline");
    assert.equal(clock.pending, 0, "the resolved delay must no longer be pending");
  });

  test("out-of-order delays crossed by one advance resolve in ascending-deadline order", async () => {

    const clock = new TestClock();
    const order: number[] = [];

    // Register three delays out of deadline order. A single advance crosses all three; they must resolve shortest-deadline first regardless of registration order, which
    // gates the snapshot-filter-sort and rules out a lost-wakeup/index-shift bug.
    const a = clock.delay(300).then(() => order.push(300));
    const b = clock.delay(100).then(() => order.push(100));
    const c = clock.delay(200).then(() => order.push(200));

    clock.advance(300);
    await Promise.all([ a, b, c ]);

    assert.deepEqual(order, [ 100, 200, 300 ], "delays must resolve in ascending-deadline order, not registration order");
    assert.equal(clock.pending, 0, "every crossed delay must be cleared from pending");
  });

  test("a partial advance resolves only the crossed delays and leaves the rest pending", async () => {

    const clock = new TestClock();
    const resolved: number[] = [];

    const a = clock.delay(100).then(() => resolved.push(100));

    clock.delay(300);
    clock.delay(500);

    // Cross only the first deadline; the FALSE arm of `deadline <= now` must leave the other two registered.
    clock.advance(100);
    await a;

    assert.deepEqual(resolved, [100], "only the crossed delay must resolve");
    assert.equal(clock.pending, 2, "the two un-crossed delays must remain pending");
  });

  test("advance(0) flushes an already-due zero delay", async () => {

    const clock = new TestClock();

    const waited = clock.delay(0);

    // advance(0) moves time nowhere but MUST still flush an already-due entry - the flush is gated by the deadline, never by the sign of the advance delta.
    clock.advance(0);
    await waited;

    assert.equal(clock.pending, 0, "advance(0) must flush an already-due delay(0)");
  });

  test("advance(0) flushes an already-due negative delay", async () => {

    const clock = new TestClock();

    const waited = clock.delay(-100);

    clock.advance(0);
    await waited;

    assert.equal(clock.pending, 0, "advance(0) must flush an already-due delay(-100)");
  });

  test("a negative advance does not resolve a not-yet-due delay", async () => {

    const clock = new TestClock(1000);

    clock.delay(100);

    // Move time backward; the delay's deadline (1100) is not reached, so it must stay pending.
    clock.advance(-500);
    await flushMicrotasks();

    assert.equal(clock.now(), 500, "the negative advance must move the virtual time backward");
    assert.equal(clock.pending, 1, "a not-yet-due delay must remain pending after a negative advance");
  });
});

describe("TestClock - abort and no-leak", () => {

  test("a delay with a pre-aborted signal rejects with an AbortError and never lands in pending", async () => {

    const clock = new TestClock();
    const controller = new AbortController();

    controller.abort();

    await assert.rejects(() => clock.delay(100, { signal: controller.signal }), (error: unknown) => {

      assertAbortError(error, "TestClock pre-aborted delay");

      return true;
    });

    assert.equal(clock.pending, 0, "a pre-aborted delay must be removed synchronously, never lingering in pending");
  });

  test("a delay aborted mid-wait rejects with an AbortError and returns pending to baseline", async () => {

    const clock = new TestClock();
    const controller = new AbortController();
    const customReason = Symbol("custom-abort-reason");

    const waited = clock.delay(100, { signal: controller.signal });

    assert.equal(clock.pending, 1, "the registered delay must be pending before the abort");

    controller.abort(customReason);

    await assert.rejects(() => waited, (error: unknown) => {

      assertAbortError(error, "TestClock mid-wait delay");
      assert.notEqual(error, customReason, "the rejection must be the AbortError, NOT the custom signal reason - matching node:timers/promises");

      return true;
    });

    assert.equal(clock.pending, 0, "the aborted delay must be removed, returning pending to baseline (no leak)");
  });

  test("a delay that resolves via advance detaches its abort listener (no leak on the resolve path)", async () => {

    const clock = new TestClock();
    const controller = new AbortController();

    // A delay WITH a (non-aborting) signal that resolves by advance. The resolve path must detach the abort listener via dispose - so a later abort of the same signal
    // does nothing (no late rejection, no second settlement). We prove the detachment by reading the listener count on the signal directly, and then by aborting AFTER
    // resolution and confirming nothing changes and no unhandled rejection surfaces.
    const waited = clock.delay(100, { signal: controller.signal });

    clock.advance(100);
    await waited;

    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "the resolve path detaches the abort listener");
    assert.equal(clock.pending, 0, "the resolved delay must be cleared from pending");

    // Aborting the signal after the listener was detached must be inert: the promise already resolved, and the detached listener cannot fire a late rejection.
    controller.abort();
    await flushMicrotasks();

    assert.equal(clock.pending, 0, "a post-resolution abort must remain a no-op with the listener detached");
  });

  test("the TestClock AbortError shape matches systemClock's exactly", async () => {

    // The fidelity anchor: drive both clocks down their abort path and assert their rejections carry the SAME name AND code. If the double drifted from the real
    // primitive, this divergence would surface here.
    const realController = new AbortController();
    const fakeController = new AbortController();

    realController.abort();
    fakeController.abort();

    const realError = await systemClock.delay(50, { signal: realController.signal }).then(() => undefined, (error: unknown) => error);
    const fakeError = await new TestClock().delay(50, { signal: fakeController.signal }).then(() => undefined, (error: unknown) => error);

    assertAbortError(realError, "systemClock abort");
    assertAbortError(fakeError, "TestClock abort");

    const realCode = (realError as Error & { code?: unknown }).code;
    const fakeCode = (fakeError as Error & { code?: unknown }).code;

    assert.equal((fakeError as Error).name, (realError as Error).name, "the TestClock AbortError name must match systemClock's");
    assert.equal(fakeCode, realCode, "the TestClock AbortError code must match systemClock's");
  });
});

describe("TestClock - requested history and stepping", () => {

  test("requested records every delay's ms in call order, across all three settlement paths", async () => {

    const clock = new TestClock();
    const midWait = new AbortController();
    const preAborted = new AbortController();

    preAborted.abort();

    // One delay per settlement path - crossed by advance, aborted mid-wait, and pre-aborted - so the history is proven to carry the waits that never came due
    // alongside the one that did. A wait a consumer asked for belongs to its cadence whatever became of the wait.
    const crossed = clock.delay(100);
    const aborting = clock.delay(250, { signal: midWait.signal });
    const preRejected = clock.delay(500, { signal: preAborted.signal });

    await assert.rejects(() => preRejected, (error: unknown) => {

      assertAbortError(error, "TestClock pre-aborted delay");

      return true;
    });

    midWait.abort();

    await assert.rejects(() => aborting, (error: unknown) => {

      assertAbortError(error, "TestClock mid-wait delay");

      return true;
    });

    clock.advance(100);
    await crossed;

    assert.deepEqual(clock.requested, [ 100, 250, 500 ], "every requested delay is recorded, in call order");
    assert.equal(clock.pending, 0, "and every one of them has left the pending list");
  });

  test("nextDeadline reads null on a fresh clock, the earliest of out-of-order deadlines, and null again once the last wait leaves", async () => {

    const clock = new TestClock();
    const controller = new AbortController();

    assert.equal(clock.nextDeadline, null, "a clock with nothing pending has no next deadline");

    // Registered out of deadline order, so the answer cannot be registration order dressed up as a minimum.
    const late = clock.delay(300);
    const early = clock.delay(100);
    const aborting = clock.delay(200, { signal: controller.signal });

    assert.equal(clock.nextDeadline, 100, "the earliest deadline answers, whatever order the waits were registered in");

    clock.advance(100);
    await early;

    assert.equal(clock.nextDeadline, 200, "the answer moves up to the next wait as each one settles");

    controller.abort();

    await assert.rejects(() => aborting, (error: unknown) => {

      assertAbortError(error, "TestClock mid-wait delay");

      return true;
    });

    assert.equal(clock.nextDeadline, 300, "an aborted wait leaves the pending list, so it stops answering");

    clock.advance(200);
    await late;

    assert.equal(clock.nextDeadline, null, "the last wait settling returns the answer to null");
  });

  test("advanceToNext answers false and moves no time when nothing is pending", () => {

    const clock = new TestClock(1000);

    assert.equal(clock.advanceToNext(), false, "there is no deadline to step to");
    assert.equal(clock.now(), 1000, "and an empty clock's step is not a step at all");
  });

  test("advanceToNext lands exactly on the earliest deadline, settling everything due there and nothing later", async () => {

    const clock = new TestClock();
    const settled: string[] = [];

    // Two waits share the earliest deadline and a third comes later, so one step is proven to settle a whole deadline's worth at once without reaching past it.
    const firstAtHundred = clock.delay(100).then(() => settled.push("first at 100"));
    const secondAtHundred = clock.delay(100).then(() => settled.push("second at 100"));

    clock.delay(400);

    assert.equal(clock.advanceToNext(), true);

    await Promise.all([ firstAtHundred, secondAtHundred ]);

    assert.equal(clock.now(), 100, "the step lands on the deadline itself, never past it");
    assert.deepEqual(settled, [ "first at 100", "second at 100" ], "waits sharing a deadline settle together, in registration order");
    assert.equal(clock.pending, 1, "the later wait is left alone");
    assert.equal(clock.nextDeadline, 400, "and it is what the next step would land on");
  });

  test("advanceToNext flushes an already-due negative delay without moving time backward", async () => {

    const clock = new TestClock(1000);

    const waited = clock.delay(-100);

    assert.equal(clock.nextDeadline, 900, "a negative delay's deadline is already behind the clock");
    assert.equal(clock.advanceToNext(), true);

    await waited;

    assert.equal(clock.now(), 1000, "the step is clamped at zero, so an already-due wait is flushed rather than reached backward for");
    assert.equal(clock.pending, 0, "and it is flushed, not stranded");
  });

  test("a while drain settles every registered wait, in deadline order", async () => {

    const clock = new TestClock();
    const settled: number[] = [];
    const waits = [ 300, 100, 200 ].map((ms) => clock.delay(ms).then(() => settled.push(ms)));

    let steps = 0;

    while(clock.advanceToNext()) {

      steps++;
    }

    await Promise.all(waits);

    assert.deepEqual(settled, [ 100, 200, 300 ], "the drain walks the deadlines in ascending order");
    assert.equal(steps, 3, "one step per distinct deadline");
    assert.equal(clock.now(), 300, "the drain leaves the clock standing on the last deadline");
    assert.equal(clock.pending, 0, "and nothing is left pending");
    assert.deepEqual(clock.requested, [ 300, 100, 200 ], "the history keeps call order, not deadline order");
  });
});

describe("TestClock - callback timers", () => {

  test("a one-shot fires exactly once at its deadline, and its handle is inert afterwards", () => {

    const clock = new TestClock();
    const fired: string[] = [];
    const handle = clock.schedule(() => fired.push("one-shot"), 100);

    assert.equal(clock.pending, 1, "an armed timer is outstanding until it fires");

    clock.advance(99);

    assert.deepEqual(fired, [], "an advance short of the deadline fires nothing");

    clock.advance(1);

    assert.deepEqual(fired, ["one-shot"], "crossing the deadline fires the callback");
    assert.equal(clock.pending, 0, "and a fired one-shot has left the timeline");

    clock.advance(1000);

    assert.deepEqual(fired, ["one-shot"], "a one-shot fires once, never again on a later advance");

    // Disposing a handle whose one-shot already fired finds nothing to remove, so it must neither throw nor disturb the timeline.
    handle[Symbol.dispose]();
    handle[Symbol.dispose]();

    assert.equal(clock.pending, 0, "disposing after the fire, and disposing twice, are both no-ops");
  });

  test("disposing a one-shot before its deadline cancels it", () => {

    const clock = new TestClock();
    const fired: string[] = [];
    const handle = clock.schedule(() => fired.push("cancelled"), 100);

    handle[Symbol.dispose]();

    assert.equal(clock.pending, 0, "a cancelled timer leaves the timeline immediately");

    clock.advance(1000);

    assert.deepEqual(fired, [], "and nothing fires once the deadline passes");
  });

  test("a repeat re-arms from its own deadline rather than from the current time, and its dispose stops it", () => {

    const clock = new TestClock();
    const fired: number[] = [];
    const handle = clock.schedule(() => fired.push(clock.now()), 10, { repeat: true });

    // A span of 25 covers the deadlines at 10 and at 20 but not the one at 30. A repeat re-armed from the current time instead of from its own deadline would fire
    // once here and land its next deadline at 35, so this input separates the correct cadence from that drift.
    clock.advance(25);

    assert.deepEqual(fired, [ 25, 25 ], "one fire per elapsed interval, not one per advance");
    assert.equal(clock.pending, 1, "a repeat stays on the timeline across its fires");

    clock.advance(5);

    assert.equal(fired.length, 3, "the third window elapses at 30, exactly one interval past the second");

    handle[Symbol.dispose]();

    assert.equal(clock.pending, 0, "disposing the handle takes the repeat off the timeline");

    clock.advance(1000);

    assert.equal(fired.length, 3, "and nothing fires afterwards");
  });

  test("a repeat floors its first deadline and its period at one millisecond", () => {

    const clock = new TestClock();
    let fired = 0;
    const handle = clock.schedule(() => fired++, 0, { repeat: true });

    // The platform floors a zero-period interval at one millisecond, first fire included. A first deadline seeded from the raw zero would come due immediately and
    // then once more per pass, so this span reads four fires against a floored three.
    clock.advance(3);

    assert.equal(fired, 3, "a zero-period repeat fires once per millisecond of elapsed virtual time");
    assert.deepEqual(clock.requested, [0], "and the ledger records the window as asked, before the floor");

    handle[Symbol.dispose]();
  });

  test("delays and callbacks settle on one timeline in deadline order, FIFO on a tie", async () => {

    const clock = new TestClock();
    const observed: number[] = [];

    // A delay registered FIRST at the same deadline as a callback, so the tie is decided by registration order rather than by kind. The delay's continuation runs on
    // a later microtask while a callback runs inside `advance`, so each callback reads the pending count `advance` has reached at the moment it fires.
    const waited = clock.delay(10);

    clock.schedule(() => observed.push(clock.pending), 10);
    clock.schedule(() => observed.push(clock.pending), 20);

    assert.equal(clock.nextDeadline, 10, "the shared earliest deadline answers before anything settles");

    clock.advance(20);

    assert.deepEqual(observed, [ 1, 0 ], "the delay left the list on the tie before the callback at 10 ran, and the callback at 20 ran last");
    assert.equal(clock.pending, 0, "every entry has settled");

    await waited;
  });

  test("a callback that arms an already-due timer from inside its fire settles it in the same advance", () => {

    const clock = new TestClock();
    const fired: string[] = [];

    clock.schedule(() => {

      fired.push("outer");
      clock.schedule(() => fired.push("inner, already due"), 0);
      clock.schedule(() => fired.push("inner, still future"), 50);
    }, 10);

    clock.advance(10);

    assert.deepEqual(fired, [ "outer", "inner, already due" ], "an already-due timer armed mid-pass settles in that pass, as the platform settles it in one tick");
    assert.equal(clock.pending, 1, "the future timer is left armed");
    assert.equal(clock.nextDeadline, 60, "measured from the virtual time at which it was armed");
  });

  test("a callback that disposes a sibling due at the same deadline cancels it mid-pass", () => {

    const clock = new TestClock();
    const fired: string[] = [];

    // The first callback closes over the second handle, which is initialized on the next statement. The closure runs during `advance`, long after that
    // initialization, so it reads a live handle rather than a hole.
    clock.schedule(() => {

      fired.push("first");
      second[Symbol.dispose]();
    }, 10);

    const second = clock.schedule(() => fired.push("second"), 10);

    clock.advance(10);

    assert.deepEqual(fired, ["first"], "the pass re-checks each entry at fire time, so a sibling cancelled mid-pass never fires");
    assert.equal(clock.pending, 0, "and neither entry is stranded on the timeline");
  });

  test("a repeat fired by a nested advance is not fired again by the outer pass", () => {

    const clock = new TestClock();

    let repeats = 0;

    // A one-shot that advances the clock from inside its own fire, registered BEFORE a repeat sharing its deadline. The nested advance settles the repeat's first two
    // windows; the outer pass then reaches the repeat's snapshot entry with a deadline it has already pushed past, which the fire-time due check must decline.
    clock.schedule(() => clock.advance(10), 10);

    const handle = clock.schedule(() => repeats++, 10, { repeat: true });

    clock.advance(10);

    assert.equal(repeats, 2, "the repeat fires once per window the nested advance crossed, and no extra time for the outer pass");
    assert.equal(clock.now(), 20, "the nested advance moved the timeline the outer pass then measures against");

    handle[Symbol.dispose]();
  });

  test("requested and advanceToNext cover callback timers beside delays", () => {

    const clock = new TestClock();
    const fired: string[] = [];

    clock.delay(100);
    clock.schedule(() => fired.push("timer at 40"), 40);
    clock.delay(250);

    assert.deepEqual(clock.requested, [ 100, 40, 250 ], "a scheduled window lands in the ledger in call order, beside the delays");
    assert.equal(clock.nextDeadline, 40, "a callback timer is an equal candidate for the earliest deadline");
    assert.equal(clock.advanceToNext(), true);
    assert.equal(clock.now(), 40, "the step lands on the callback timer's deadline");
    assert.deepEqual(fired, ["timer at 40"], "and the step fires it rather than only settling delays");
    assert.equal(clock.pending, 2, "the two later delays are left alone");
  });

  test("an unreferenced timer is an ordinary entry on the timeline, because a virtual timeline has no process to hold open", () => {

    const clock = new TestClock();
    const fired: string[] = [];

    clock.schedule(() => fired.push("one-shot"), 100, { unref: true });

    const repeat = clock.schedule(() => fired.push("repeat"), 100, { repeat: true, unref: true });

    assert.equal(clock.pending, 2, "the double counts an unreferenced timer as outstanding, exactly as it counts a referenced one");

    clock.advance(100);

    assert.deepEqual(fired, [ "one-shot", "repeat" ], "both come due at their deadline, in registration order on the tie");
    assert.equal(clock.pending, 1, "the one-shot has left the timeline and the repeat stands, as they would without the flag");

    repeat[Symbol.dispose]();
  });
});

describe("TestClock - deadline signals", () => {

  test("a deadline signal aborts when the clock crosses its deadline, and not before", () => {

    const clock = new TestClock();
    const signal = clock.timeout(100);

    assert.equal(signal.aborted, false, "an armed deadline is not aborted at creation");

    clock.advance(99);

    assert.equal(signal.aborted, false, "an advance short of the deadline leaves the signal unaborted");

    clock.advance(1);

    assert.equal(signal.aborted, true, "crossing the deadline aborts the signal");
    assertTimeoutReason(signal.reason, "the double's deadline signal");
  });

  test("a deadline records its window in the ledger and leaves the timeline once it has fired", () => {

    const clock = new TestClock();

    clock.timeout(250);

    assert.deepEqual(clock.requested, [250], "the window reaches the ledger through the schedule call the deadline is built on");
    assert.equal(clock.pending, 1, "an armed deadline is outstanding until the clock crosses it");

    clock.advance(250);

    assert.equal(clock.pending, 0, "a fired deadline has left the timeline");

    clock.advance(1000);

    assert.equal(clock.pending, 0, "and a later advance finds nothing left of it");
    assert.deepEqual(clock.requested, [250], "the ledger records the one window that was asked for, once");
  });

  test("the double's deadline reason is indistinguishable from the platform's", async () => {

    // The differential oracle for the third time shape. We compare against a LIVE platform reason rather than against a restatement of what the platform is believed
    // to produce, so a future platform change to the message or the class surfaces here as a failure instead of passing against a stale literal.
    const platformSignal = AbortSignal.timeout(1);

    await once(platformSignal, "abort");

    const clock = new TestClock();
    const doubleSignal = clock.timeout(1);

    clock.advance(1);

    const platformReason: unknown = platformSignal.reason;
    const doubleReason: unknown = doubleSignal.reason;

    assert.ok(platformReason instanceof DOMException, "the platform's reason must be a DOMException");
    assert.ok(doubleReason instanceof DOMException, "the double's reason must be a DOMException");
    assert.equal(doubleReason.name, platformReason.name, "the two reasons must carry the same name");
    assert.equal(doubleReason.message, platformReason.message, "the two reasons must carry the same message");
    assert.equal(doubleReason.constructor, platformReason.constructor, "the two reasons must come from the same constructor");
    assert.equal(isTimeoutReason(platformReason), true, "the library's predicate accepts the platform's reason");
    assert.equal(isTimeoutReason(doubleReason), true, "and accepts the double's identically");
  });

  test("a deadline and a delay share one timeline, so each step settles the entry that is next", async () => {

    const clock = new TestClock();
    const signal = clock.timeout(500);
    const waited = clock.delay(700);

    assert.equal(clock.nextDeadline, 500, "the deadline is the earlier of the two entries");
    assert.equal(clock.advanceToNext(), true, "the first step lands on it");
    assert.equal(signal.aborted, true, "and aborts the deadline signal");
    assert.equal(clock.now(), 500, "virtual time moved exactly to the deadline");
    assert.equal(clock.pending, 1, "the delay is still outstanding");
    assert.equal(clock.advanceToNext(), true, "a second step lands on the delay");

    await waited;

    assert.equal(clock.now(), 700, "which moved virtual time to the wait's own deadline");
    assert.equal(clock.pending, 0, "and left the timeline empty");
  });
});
