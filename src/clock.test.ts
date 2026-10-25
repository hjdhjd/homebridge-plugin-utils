/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.test.ts: Unit tests for the injectable Clock contract - the compile-time conformance and behavior-neutrality of the production systemClock (its now() tracks
 * Date.now(), its monotonic() reads process.hrtime in whole microseconds, never decreasing and rising across a real wait while the wall clock is stepped back,
 * its delay() IS node:timers/promises setTimeout including the AbortError shape, its schedule() IS the global callback timers read at call time and
 * forwards an unref to the platform handle's own unref(), past the platform timer's ceiling every member that arms time carries the delay as a chain of arms
 * that fires at the requested moment without the platform's overflow warning, an infinite span arms nothing and never elapses - its delay settling only when its
 * signal aborts, with the primitive's own AbortError, and a process holding only infinite waits and timers exiting on its own - while NaN and negative infinity keep
 * the platform's one-millisecond handling), plus the shipped controllable TestClock double (advanceable virtual time, the monotonic reading that moves with each
 * forward step and holds still on a backward or NaN one, deadline-ordered resolution, the
 * advance(0)/negative flush, the matched node:timers/promises AbortError on abort, the no-listener-leak teardown on every resolution path, the requested history
 * across every settlement path, the earliest-pending-deadline read, the step that lands on that deadline, the callback timers that share that one timeline with the
 * delays, the unref it accepts and ignores because a virtual timeline has no process to hold open, the window past the ceiling that is an ordinary entry on a
 * timeline with none, the infinite span that registers no entry, and the NaN span that comes due a millisecond out so the timeline stays numeric), plus the
 * cancellable deadline armDeadline builds on a clock's own timer (its reason a consumer cannot tell apart from the platform's, its release on disposal on each
 * clock, its span carried past the ceiling, its infinite span that never aborts, and its unreferenced timer that lets a process exit with a deadline still armed),
 * plus the macrotask yield beside the contract (it resolves only once the nextTick and microtask queues have drained, and mock timers replacing setImmediate and
 * setTimeout cannot park it).
 */
import { TIMER_DELAY_MAX_MS, armDeadline, systemClock, yieldMacrotask } from "./clock.ts";
import { describe, test } from "node:test";
import { makeScratchRoot, settle, waitUntil } from "./testing/index.ts";
import type { Clock } from "./clock.ts";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { getEventListeners } from "node:events";
import { isTimeoutReason } from "./util.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";
import timersPromises from "node:timers/promises";
import { writeFile } from "node:fs/promises";

// This repo's own clock module by absolute path, the specifier a child process imports it through.
const CLOCK_PATH = fileURLToPath(new URL("./clock.ts", import.meta.url));

// The prefix every row's scratch folder is named with, so a folder a killed run leaves behind names this suite.
const SCRATCH_PREFIX = "hbpu-clock-";

// How many successive monotonic reads a row compares, enough that a reading which ran backward even rarely would show.
const MONOTONIC_READS = 10000;

// The wall-clock time a row seeds mocked `Date` with before stepping it back to half of it.
const MOCKED_WALL_CLOCK_MS = 1000000;

// How long a child process may take to reach its own exit before its spawn's deadline kills it. Generous enough for a cold type-stripping start on a slow CI host,
// and short enough that the kill lands well inside the runner's own per-test timeout.
const CHILD_EXIT_BOUND_MS = 10000;

// How long a row waits in real time to tell a span that never comes due from one the platform fires after a millisecond. The platform fires timers in expiry
// order, so a wait well past that millisecond tells the two apart without leaning on the host's speed.
const REAL_WAIT_MS = 100;

// What a child process answered: its exit code, null when the spawn's deadline killed it, beside everything it wrote.
interface ChildOutcome {

  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

// Flush the microtask queue so a delay that became due during a synchronous `advance` has run its `resolve`/`reject` continuation before the test inspects the outcome.
// `advance` settles each due entry synchronously, but the awaiting code runs on a later microtask; a bare `await Promise.resolve()` yields long enough for those to run.
async function flushMicrotasks(): Promise<void> {

  await Promise.resolve();
}

// Race `pending` against a real wait on the promise primitive, answering "settled" when `pending` resolves or rejects first and "silent" when the wait ends first.
async function raceRealWait(pending: Promise<unknown>): Promise<"settled" | "silent"> {

  return await Promise.race([ pending.then((): "settled" => "settled", (): "settled" => "settled"), systemClock.delay(REAL_WAIT_MS).then((): "silent" => "silent") ]);
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
// the fidelity anchor for armDeadline's reason - a deadline on systemClock and one on TestClock must each satisfy it, because a consumer branching on a deadline
// reason must not be able to tell which clock, or the platform itself, produced it. Unlike the AbortError shape above, the constructor identity IS assertable here:
// DOMException is a constructable global, so the deadline reproduces the real class rather than only its observable fields.
function assertTimeoutReason(reason: unknown, message: string): void {

  assert.ok(reason instanceof DOMException, message + " - the reason must be a DOMException");
  assert.equal(reason.name, "TimeoutError", message + " - name must be TimeoutError");
  assert.equal(isTimeoutReason(reason), true, message + " - isTimeoutReason must accept it");
}

/**
 * Write `source` to a file named `name` under `root` and run it as a child Node process, answering its exit code and everything it wrote. The process-lifetime
 * property the child rows read cannot be read from inside this suite, because the runner holds the event loop open on its own account, so a child is the smallest
 * arrangement that shows it.
 *
 * The child carries a type-stripping flag, and only that flag, when the runner carries one, so it can execute a .ts entry; never the --test, --import, or coverage
 * flags, which would derail it into a second test run. On a runtime that strips types by default the flag is absent and the child runs flagless. The spawn is bounded
 * by a deadline, which is what makes a child row a proof: a child that fails to reach its own exit is killed there and answers a null code, which fails the row's
 * assertion rather than hanging the suite.
 *
 * @param root   - The scratch directory the child's entry file is written into.
 * @param name   - The entry file's name.
 * @param source - The child's source text.
 *
 * @returns The child's exit code, or null when the deadline killed it, beside its stdout and stderr.
 */
async function runChild(root: string, name: string, source: string): Promise<ChildOutcome> {

  const childPath = join(root, name);

  await writeFile(childPath, source, "utf8");

  const stripFlag = process.execArgv.find((arg) => (arg === "--strip-types") || (arg === "--experimental-strip-types"));
  const childArgs = stripFlag ? [ stripFlag, childPath ] : [childPath];

  using deadline = armDeadline(CHILD_EXIT_BOUND_MS);

  return await new Promise<ChildOutcome>((resolveOutcome) => {

    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    const child = spawn(process.execPath, childArgs, { signal: deadline.signal, stdio: [ "ignore", "pipe", "pipe" ] });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // A child killed at the deadline surfaces here as an error rather than as a clean close, so this listener is what turns a hung child into a failed assertion.
    child.on("error", (error: Error) => resolveOutcome({ code: null, stderr: error.message, stdout: "" }));
    child.on("close", (code) => resolveOutcome({ code, stderr: Buffer.concat(stderrChunks).toString("utf8"), stdout: Buffer.concat(stdoutChunks).toString("utf8") }));
  });
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

  test("monotonic() reads the platform's monotonic clock, between bracketing reads taken in its own truncated microseconds", () => {

    // The bracket reads the clock the way the member is documented to, truncated to whole microseconds and then put in milliseconds, so a read landing on the same
    // microsecond as a bound compares equal to it rather than falling outside a finer one.
    const bracket = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;
    const before = bracket();
    const observed = systemClock.monotonic();
    const after = bracket();

    assert.ok((observed >= before) && (observed <= after), "systemClock.monotonic() must fall within the surrounding reads: " + [ before, observed, after ].join(" "));
    assert.equal(Math.round(observed * 1000) / 1000, observed, "the reading must be a whole count of microseconds, in milliseconds");
  });

  test("monotonic() never decreases across successive reads", () => {

    let decreases = 0;
    let previous = systemClock.monotonic();

    for(let read = 0; read < MONOTONIC_READS; read++) {

      const current = systemClock.monotonic();

      if(current < previous) {

        decreases++;
      }

      previous = current;
    }

    assert.equal(decreases, 0, "no reading may fall below the one before it");
  });

  test("monotonic() rises across a real wait while mock timers step the wall clock back", async (t) => {

    // Only `Date` is mocked, so the wait below runs on the real timers while the wall clock is set back underneath it.
    t.mock.timers.enable({ apis: ["Date"], now: MOCKED_WALL_CLOCK_MS });

    const before = systemClock.monotonic();

    t.mock.timers.setTime(MOCKED_WALL_CLOCK_MS / 2);

    await timersPromises.setTimeout(5);

    assert.ok(Date.now() < MOCKED_WALL_CLOCK_MS, "the wall clock must have been stepped back");
    assert.ok(systemClock.monotonic() > before, "the monotonic reading must rise across the real wait whatever the wall clock did");
  });

  test("delay() resolves after the real elapsed time", async () => {

    // A real wait, kept as small as the real clock allows: a fake clock cannot test the REAL clock, so we await a tiny 1ms real delay, mirroring the retry suite's
    // `backoff: () => 1` idiom. We assert resolution only, not precise timing, since real-timer scheduling is not exact.
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

    // The per-test enable is auto-restored when the row ends, so the real-time row that follows is never driven by a mock left running. This row holds the contract
    // every consumer suite that drives mock timers through an injected clock depends on.
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

    // A child whose entire pending workload is unreferenced timers has to reach its own exit while each of them is still an hour from firing, inside the bound
    // `runChild` puts on its spawn.
    await using scratch = await makeScratchRoot(SCRATCH_PREFIX);

    // The child imports this repo's own clock by absolute path, quoted through JSON.stringify so a scratch root carrying a quote or a backslash still yields a
    // valid specifier. Composing the source by concatenation keeps the file free of template literals, as everything else here is.
    const result = await runChild(scratch.path, "unreferenced-timers.ts", "import { systemClock } from " + JSON.stringify(CLOCK_PATH) + ";\n\n" +
      "systemClock.schedule(() => undefined, 3600000, { unref: true });\n" +
      "systemClock.schedule(() => undefined, 3600000, { repeat: true, unref: true });\n" +
      "console.log(\"armed\");\n");

    assert.equal(result.code, 0, "the child must reach its own exit with both timers still pending; stderr: " + result.stderr);
    assert.equal(result.stdout, "armed\n", "and must have armed both of them before exiting; stderr: " + result.stderr);
  });

  test("the exported timer ceiling is the platform's 32-bit signed millisecond maximum", () => {

    // The rows past the ceiling state their windows through the exported constant, so they move with it rather than checking it. This row is the one place the
    // number is stated independently of the constant.
    assert.equal(TIMER_DELAY_MAX_MS, (2 ** 31) - 1, "the ceiling is the platform's own number, fixed outside this code");
  });

  test("a one-shot past the platform ceiling is carried as a chain of arms and fires at the requested moment", (t) => {

    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });

    // One past the platform timer's 32-bit signed millisecond ceiling: the smallest delay the platform would set to one millisecond. The ceiling is the platform's
    // number, fixed outside this library, so the rows read it from the exported constant and a row of its own holds that constant to the platform's number.
    const fired: number[] = [];
    const handle = systemClock.schedule((): number => fired.push(1), TIMER_DELAY_MAX_MS + 1);

    t.mock.timers.tick(TIMER_DELAY_MAX_MS);

    assert.deepEqual(fired, [], "a ceiling's worth of time elapsing fires nothing, because the first hop re-arms for the remainder instead of running the callback");

    t.mock.timers.tick(1);

    assert.deepEqual(fired, [1], "the remainder elapsing runs the callback, at exactly the moment asked for");

    t.mock.timers.tick(TIMER_DELAY_MAX_MS + 1);

    assert.deepEqual(fired, [1], "and a chained one-shot fires once");

    handle[Symbol.dispose]();
  });

  test("disposing a chained one-shot mid-chain cancels the hop that is live, so nothing fires later", (t) => {

    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });

    // Two ceilings and a little more, so the chain has three hops; the disposal lands while the second is armed. A disposer that still held the first hop's handle
    // would clear a timer that has already fired and leave the live one to run the chain to its end.
    const fired: number[] = [];
    const handle = systemClock.schedule((): number => fired.push(1), (2 * TIMER_DELAY_MAX_MS) + 5);

    t.mock.timers.tick(TIMER_DELAY_MAX_MS + 2);
    handle[Symbol.dispose]();

    // The mock times a hop armed inside a callback from the end of the tick that ran the callback, so the chain's last hop needs a tick of its own to be reachable
    // at all; a disposer that still held the first hop's handle would let the chain run on and fire here.
    t.mock.timers.tick((2 * TIMER_DELAY_MAX_MS) + 5);
    t.mock.timers.tick(10);

    assert.deepEqual(fired, [], "the chain is cancelled at whichever hop is live, and no later hop fires");
  });

  test("a repeat past the ceiling fires once per period, re-armed before its callback so a callback disposing its own handle cancels the next fire", (t) => {

    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });

    // The callback closes over `handle`, the binding its own statement declares. That is safe by construction: the callback runs inside a later tick, long after
    // that statement has completed, so it can never observe the binding before it is initialized. Each period is two ticks, a ceiling's worth and then the remainder,
    // because the mock times a hop armed inside a callback from the end of the tick that ran the callback, where the platform arms it at the moment of the fire.
    const fired: number[] = [];
    const handle = systemClock.schedule((): void => {

      fired.push(fired.length + 1);

      if(fired.length === 2) {

        handle[Symbol.dispose]();
      }
    }, TIMER_DELAY_MAX_MS + 1, { repeat: true });

    t.mock.timers.tick(TIMER_DELAY_MAX_MS);

    assert.deepEqual(fired, [], "a ceiling's worth of time fires nothing: the first hop re-arms for the remainder");

    t.mock.timers.tick(1);

    assert.deepEqual(fired, [1], "the first period's remainder elapsing fires once");

    t.mock.timers.tick(TIMER_DELAY_MAX_MS);
    t.mock.timers.tick(1);

    assert.deepEqual(fired, [ 1, 2 ], "the second period fires once more, and that callback disposes its own handle");

    t.mock.timers.tick(TIMER_DELAY_MAX_MS);
    t.mock.timers.tick(1);

    assert.deepEqual(fired, [ 1, 2 ], "the disposal cancelled the period the re-arm had already started, so nothing fires afterwards");
  });

  test("each shape past the ceiling arms without the platform's overflow warning, and an abort mid-chain rejects the delay with the primitive's AbortError", async () => {

    // The platform announces a delay it has set to one millisecond through a process warning, emitted on a later tick, so the read below yields a macrotask first.
    const warnings: string[] = [];
    const observe = (warning: Error): number => warnings.push(warning.name);

    process.on("warning", observe);

    try {

      using oneShot = systemClock.schedule((): void => undefined, TIMER_DELAY_MAX_MS + 1, { unref: true });
      using repeat = systemClock.schedule((): void => undefined, TIMER_DELAY_MAX_MS + 1, { repeat: true, unref: true });

      const controller = new AbortController();
      const waited = systemClock.delay(TIMER_DELAY_MAX_MS + 1, { signal: controller.signal });

      await settle();

      assert.deepEqual(warnings, [], "no shape armed past the ceiling draws the platform's overflow warning, because each armed at most the ceiling");
      assert.notEqual(oneShot, repeat, "each arm answers its own handle");

      controller.abort();

      await assert.rejects(() => waited, (error: unknown) => {

        assertAbortError(error, "a chained delay aborted mid-wait");

        return true;
      });
    } finally {

      process.off("warning", observe);
    }
  });

  test("systemClock.schedule at an infinite window arms no global timer, so no one-shot or repeat fires or warns, and its disposer clears nothing", async (t) => {

    // The spies call through, so any timer an arm reached would still run. The real wait is the promise primitive, which never reads the global timers, so every
    // count below is the arms' own.
    const globalSetTimeout = t.mock.method(globalThis, "setTimeout");
    const globalSetInterval = t.mock.method(globalThis, "setInterval");
    const globalClearTimeout = t.mock.method(globalThis, "clearTimeout");
    const warnings: string[] = [];
    const observe = (warning: Error): number => warnings.push(warning.name);

    process.on("warning", observe);

    try {

      const fired: string[] = [];

      // Each handle is held in a `using` declaration as well, so an assertion that fails cannot strand a live interval in the runner's loop. The scope's own
      // disposal is one more call on a disposer that does nothing.
      using oneShot = systemClock.schedule((): number => fired.push("one-shot"), Infinity);
      using repeat = systemClock.schedule((): number => fired.push("repeat"), Infinity, { repeat: true });

      await systemClock.delay(REAL_WAIT_MS);

      assert.equal(globalSetTimeout.mock.callCount(), 0, "an infinite one-shot arms no global setTimeout, at the call or across the wait after it");
      assert.equal(globalSetInterval.mock.callCount(), 0, "and an infinite repeat arms no global setInterval");
      assert.deepEqual(fired, [], "neither fires within a real wait, where the platform's own arm would have fired each after a millisecond");
      assert.deepEqual(warnings, [], "and neither draws the platform's overflow warning");

      oneShot[Symbol.dispose]();
      oneShot[Symbol.dispose]();
      repeat[Symbol.dispose]();
      repeat[Symbol.dispose]();

      assert.equal(globalClearTimeout.mock.callCount(), 0, "disposing each handle twice clears nothing, because nothing was armed");
    } finally {

      process.off("warning", observe);
    }
  });

  test("systemClock.delay at an infinite span reaches the primitive only on abort, holds one listener until then, and rejects with its AbortError", async (t) => {

    // The spy sits on the module object the delay reads the promise primitive from at call time, and calls through. The race partner is a global timer, which never
    // reaches the primitive, so every count below is the delay's own.
    const primitive = t.mock.method(timersPromises, "setTimeout");
    const controller = new AbortController();
    const waited = systemClock.delay(Infinity, { signal: controller.signal });
    const outcome = await Promise.race([ waited.then((): string => "settled", (): string => "settled"),
      new Promise<string>((resolveSilent) => setTimeout((): void => resolveSilent("silent"), REAL_WAIT_MS)) ]);

    assert.equal(outcome, "silent", "an infinite delay stays pending across a real wait");
    assert.equal(primitive.mock.callCount(), 0, "arming no timer while it waits");
    assert.equal(getEventListeners(controller.signal, "abort").length, 1, "and holding one abort listener on its signal");

    controller.abort();

    await assert.rejects(() => waited, (error: unknown) => {

      assertAbortError(error, "an infinite delay aborted mid-wait");

      return true;
    });

    assert.equal(primitive.mock.callCount(), 1, "the abort hands the signal to the promise primitive once");
    assert.equal(primitive.mock.calls[0]?.arguments[2]?.signal?.aborted, true, "already aborted, so the primitive rejects at once and arms nothing");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "and the listener leaves with the abort that fired it");

    // A signal already aborted when the delay is asked for rejects the same way, with no listener at all.
    const preAborted = new AbortController();

    preAborted.abort();

    await assert.rejects(() => systemClock.delay(Infinity, { signal: preAborted.signal }), (error: unknown) => {

      assertAbortError(error, "an infinite delay with a pre-aborted signal");

      return true;
    });

    assert.equal(primitive.mock.callCount(), 2, "a signal already aborted goes straight to the promise primitive");
    assert.equal(primitive.mock.calls[1]?.arguments[2]?.signal, preAborted.signal, "handing it that signal");
    assert.equal(getEventListeners(preAborted.signal, "abort").length, 0, "with no listener registered");
  });

  test("systemClock.delay at an infinite span with no signal never settles, staying silent across a real wait", async () => {

    assert.equal(await raceRealWait(systemClock.delay(Infinity)), "silent", "with no signal to end it, an infinite delay neither resolves nor rejects");
  });

  test("a process holding only a signalless infinite systemClock.delay and a referenced infinite systemClock.schedule exits on its own, neither coming due", async () => {

    // The wait is awaited inside an async function rather than at the top level, because a top-level await on a promise that never settles is itself a process
    // error. The timer carries no unref, so the child reaches its own exit only when nothing was armed, and the wait and the timer each log if they ever come due.
    await using scratch = await makeScratchRoot(SCRATCH_PREFIX);

    const result = await runChild(scratch.path, "infinite-spans.ts", "import { systemClock } from " + JSON.stringify(CLOCK_PATH) + ";\n\n" +
      "async function waitForever(): Promise<void> {\n\n  await systemClock.delay(Infinity);\n  console.log(\"settled\");\n}\n\n" +
      "void waitForever();\n" +
      "systemClock.schedule(() => console.log(\"fired\"), Infinity);\n" +
      "console.log(\"armed\");\n");

    assert.equal(result.code, 0, "the child must reach its own exit with the infinite wait and timer still pending; stderr: " + result.stderr);
    assert.equal(result.stdout, "armed\n", "and neither may come due before it does; stderr: " + result.stderr);
    assert.equal(result.stderr.includes("TimeoutOverflowWarning"), false, "and nothing it armed may draw the platform's overflow warning; stderr: " + result.stderr);
  });

  test("systemClock.schedule at a NaN window keeps the platform's handling, firing a one-shot after a millisecond", async () => {

    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    const handle = systemClock.schedule((): void => resolve(), NaN);

    assert.equal(await raceRealWait(promise), "settled", "the platform sets a NaN window to one millisecond, so the one-shot fires well inside a real wait");

    handle[Symbol.dispose]();
  });

  test("systemClock.delay at a NaN span keeps the platform's handling, resolving after a millisecond", async () => {

    assert.equal(await raceRealWait(systemClock.delay(NaN)), "settled", "the platform sets a NaN delay to one millisecond, so it resolves well inside a real wait");
  });

  test("systemClock.schedule and delay at negative infinity keep the platform's handling of a negative span, each coming due after a millisecond", async () => {

    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    const handle = systemClock.schedule((): void => resolve(), -Infinity);

    assert.equal(await raceRealWait(promise), "settled", "the platform sets a negative window to one millisecond, so the one-shot fires well inside a real wait");
    assert.equal(await raceRealWait(systemClock.delay(-Infinity)), "settled", "and the delay resolves well inside one, as every negative delay does");

    handle[Symbol.dispose]();
  });

  test("a delay past the ceiling awaits the promise primitive once per hop and resolves at the requested moment", async (t) => {

    // The promise primitive is read off the module object at call time, which is what lets the mock reach it here; a wait bound by a named import would run on the
    // real timers regardless of the mock.
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let resolved = false;

    const waited = systemClock.delay(TIMER_DELAY_MAX_MS + 1).then((): void => {

      resolved = true;
    });

    t.mock.timers.tick(TIMER_DELAY_MAX_MS);
    await settle();

    assert.equal(resolved, false, "a ceiling's worth of time resolves nothing: the first hop's continuation awaits the remainder");

    t.mock.timers.tick(1);
    await waited;

    assert.equal(resolved, true, "the remainder elapsing resolves the wait, at exactly the moment asked for");
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

  test("monotonic() starts at the seed and equals the virtual time through forward steps", () => {

    const clock = new TestClock(1000);

    assert.equal(clock.monotonic(), 1000, "the reading must start at the seed");

    clock.advance(250);
    clock.advance(0);
    clock.advance(50);

    assert.equal(clock.monotonic(), 1300, "each forward step must move the reading by its delta");
    assert.equal(clock.monotonic(), clock.now(), "and the reading must equal the virtual time through forward steps");
  });

  test("monotonic() stays still on a backward step and moves by the next forward one", () => {

    const clock = new TestClock(1000);

    clock.advance(500);
    clock.advance(-200);

    assert.equal(clock.now(), 1300, "the backward step moves the virtual time");
    assert.equal(clock.monotonic(), 1500, "a backward step must leave the reading where it was");

    clock.advance(100);

    assert.equal(clock.monotonic(), 1600, "the next forward step must move the reading by that step alone");
  });

  test("monotonic() stays still on a NaN step and moves by the next forward one", () => {

    const clock = new TestClock(1000);

    clock.advance(Number.NaN);

    assert.ok(Number.isNaN(clock.now()), "the NaN step carries the virtual time to NaN");
    assert.equal(clock.monotonic(), 1000, "a NaN step must leave the reading where it was, so it stays numeric");

    clock.advance(100);

    assert.equal(clock.monotonic(), 1100, "the next forward step must move the reading by that step alone");
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

  test("a window past the platform ceiling is an ordinary entry on the virtual timeline, coming due at exactly the moment asked for", async () => {

    const clock = new TestClock();
    const fired: string[] = [];

    // Each shape at one past the platform's ceiling, so the double is proven to need no chain of its own: a virtual timeline has no ceiling, and each entry comes
    // due when the clock reaches it, which is the moment the production clock's chain delivers.
    clock.schedule((): number => fired.push("one-shot"), TIMER_DELAY_MAX_MS + 1);

    const waited = clock.delay(TIMER_DELAY_MAX_MS + 1);

    assert.equal(clock.nextDeadline, TIMER_DELAY_MAX_MS + 1, "the entries come due at the window asked for");

    clock.advance(TIMER_DELAY_MAX_MS);

    assert.deepEqual(fired, [], "a ceiling's worth of virtual time fires nothing");

    clock.advance(1);
    await waited;

    assert.deepEqual(fired, ["one-shot"], "the remainder fires the timer");
    assert.deepEqual(clock.requested, [ TIMER_DELAY_MAX_MS + 1, TIMER_DELAY_MAX_MS + 1 ], "and the ledger records each window as asked");
  });
});

describe("TestClock - infinite, NaN and negative-infinity spans", () => {

  test("an infinite delay, one-shot and repeat leave pending, nextDeadline and advanceToNext empty, advance(Infinity) fires none, and requested holds each", async () => {

    const clock = new TestClock();
    const fired: string[] = [];
    let settled = false;

    void clock.delay(Infinity).then((): void => {

      settled = true;
    });

    const oneShot = clock.schedule((): number => fired.push("one-shot"), Infinity);
    const repeat = clock.schedule((): number => fired.push("repeat"), Infinity, { repeat: true });

    // The counts are read before any step, because an infinite repeat on the timeline would come due again at every deadline it re-armed to and loop without end
    // inside the advance below.
    assert.equal(clock.pending, 0, "no infinite span registers an entry");
    assert.equal(clock.nextDeadline, null, "so the timeline has no deadline to answer");
    assert.deepEqual(clock.requested, [ Infinity, Infinity, Infinity ], "while the ledger records each span as asked");
    assert.equal(clock.advanceToNext(), false, "the step finds nothing to step to");
    assert.equal(clock.now(), 0, "and moves no time");

    clock.advance(Infinity);
    await flushMicrotasks();

    assert.deepEqual(fired, [], "even an infinite advance fires neither timer");
    assert.equal(settled, false, "or settles the delay");

    oneShot[Symbol.dispose]();
    oneShot[Symbol.dispose]();
    repeat[Symbol.dispose]();
    repeat[Symbol.dispose]();

    assert.equal(clock.pending, 0, "disposing each handle twice finds nothing to remove");
  });

  test("an infinite delay with a signal registers no entry in pending and rejects with the AbortError on abort, leaving a finite sibling in place", async () => {

    // A finite sibling sits on the timeline first, because the abort handler and the infinite handle's disposer each remove an entry that was never registered,
    // and a removal that did not find it must leave the sibling where it is.
    const clock = new TestClock();
    const controller = new AbortController();

    void clock.delay(100);

    const waited = clock.delay(Infinity, { signal: controller.signal });
    const handle = clock.schedule((): void => undefined, Infinity);

    assert.equal(clock.pending, 1, "only the finite sibling registers an entry");
    assert.equal(clock.nextDeadline, 100, "so the sibling's deadline is the only one");

    controller.abort();

    await assert.rejects(() => waited, (error: unknown) => {

      assertAbortError(error, "an infinite TestClock delay aborted mid-wait");

      return true;
    });

    handle[Symbol.dispose]();
    handle[Symbol.dispose]();

    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "the abort listener leaves with the abort");
    assert.equal(clock.pending, 1, "and neither the abort nor disposing the infinite handle twice removes the sibling");
    assert.equal(clock.nextDeadline, 100, "which still comes due when asked");
  });

  test("a NaN delay, one-shot and repeat come due one millisecond out, so nextDeadline, advanceToNext and the virtual time stay numeric for a later delay", async () => {

    const clock = new TestClock();
    const fired: string[] = [];
    let nanSettled = false;
    let laterSettled = false;

    // The NaN delay is registered first, because the earliest-deadline read seeds from the first entry, and a NaN deadline there would stay the answer however the
    // entries after it compared.
    void clock.delay(NaN).then((): void => {

      nanSettled = true;
    });

    clock.schedule((): number => fired.push("one-shot"), NaN);

    const repeat = clock.schedule((): number => fired.push("repeat"), NaN, { repeat: true });

    assert.equal(clock.pending, 3, "each NaN span registers an entry");
    assert.equal(clock.nextDeadline, 1, "coming due one millisecond out, as the platform fires a NaN timer");
    assert.deepEqual(clock.requested, [ NaN, NaN, NaN ], "and the ledger records each span as asked");
    assert.equal(clock.advanceToNext(), true);

    await flushMicrotasks();

    assert.equal(clock.now(), 1, "the step lands on a numeric time");
    assert.equal(nanSettled, true, "settling the NaN delay");
    assert.deepEqual(fired, [ "one-shot", "repeat" ], "and firing the NaN one-shot and the repeat's first period");

    clock.advance(1);

    assert.deepEqual(fired, [ "one-shot", "repeat", "repeat" ], "the NaN repeat's period is one millisecond");

    repeat[Symbol.dispose]();

    void clock.delay(100).then((): void => {

      laterSettled = true;
    });

    clock.advance(100);
    await flushMicrotasks();

    assert.equal(laterSettled, true, "and a later delay settles on the timeline the NaN entries left numeric");
  });

  test("a negative-infinity delay and one-shot are already due, so advance(0) flushes them without moving time", async () => {

    const clock = new TestClock();
    const fired: string[] = [];
    let settled = false;

    void clock.delay(-Infinity).then((): void => {

      settled = true;
    });

    clock.schedule((): number => fired.push("one-shot"), -Infinity);

    assert.equal(clock.pending, 2, "a negative-infinity span registers an entry, as every negative span does");
    assert.equal(clock.nextDeadline, -Infinity, "with a deadline already behind the clock");

    clock.advance(0);
    await flushMicrotasks();

    assert.equal(settled, true, "advance(0) flushes the delay");
    assert.deepEqual(fired, ["one-shot"], "and the one-shot");
    assert.equal(clock.now(), 0, "without moving time");
    assert.equal(clock.pending, 0, "leaving nothing pending");
  });
});

describe("armDeadline - a cancellable deadline on a clock's own timer", () => {

  test("aborts at its deadline, with a reason indistinguishable from the platform's", async () => {

    // The differential oracle for the deadline's reason. We compare against a LIVE platform reason rather than against a restatement of what the platform is believed
    // to produce, so a future platform change to the message or the class surfaces here as a failure instead of passing against a stale literal.
    const platformSignal = AbortSignal.timeout(1);

    await waitUntil(() => platformSignal.aborted, { description: "the platform's own deadline to abort" });

    const clock = new TestClock();

    using deadline = armDeadline(500, { clock });

    assert.equal(deadline.signal.aborted, false, "an armed deadline is not aborted at creation");
    assert.deepEqual(clock.requested, [500], "the span reaches the ledger through the schedule call the deadline is armed on");
    assert.equal(clock.pending, 1, "and the armed deadline is outstanding on the timeline");

    clock.advance(499);

    assert.equal(deadline.signal.aborted, false, "an advance short of the span leaves the signal live");

    clock.advance(1);

    assert.equal(deadline.signal.aborted, true, "crossing the span aborts it");
    assert.equal(clock.pending, 0, "and a fired deadline has left the timeline");
    assertTimeoutReason(deadline.signal.reason, "the deadline's reason");

    const platformReason: unknown = platformSignal.reason;
    const deadlineReason: unknown = deadline.signal.reason;

    assert.ok(platformReason instanceof DOMException, "the platform's reason must be a DOMException");
    assert.ok(deadlineReason instanceof DOMException, "the deadline's reason must be a DOMException");
    assert.equal(deadlineReason.name, platformReason.name, "the reasons must carry the same name");
    assert.equal(deadlineReason.message, platformReason.message, "the reasons must carry the same message");
    assert.equal(deadlineReason.constructor, platformReason.constructor, "the reasons must come from the same constructor");
  });

  test("disposing it before it fires releases its timer, so its entry leaves the timeline and the signal stays live", () => {

    const clock = new TestClock();
    const deadline = armDeadline(500, { clock });

    assert.equal(clock.pending, 1, "the armed deadline is outstanding");

    clock.advance(200);
    deadline[Symbol.dispose]();

    assert.equal(clock.pending, 0, "disposing it takes its entry off the timeline");
    assert.equal(clock.nextDeadline, null, "so nothing is left to come due");

    clock.advance(1000);

    assert.equal(deadline.signal.aborted, false, "and crossing the span it was armed for aborts nothing");
    assert.deepEqual(clock.requested, [500], "while the ledger keeps the span that was asked for");
  });

  test("disposing it after it fires, and disposing it again, change nothing", async () => {

    const clock = new TestClock();
    const deadline = armDeadline(100, { clock });
    let resolved = false;

    const waited = clock.delay(300).then((): void => {

      resolved = true;
    });

    clock.advance(100);

    const reason: unknown = deadline.signal.reason;

    assert.equal(deadline.signal.aborted, true, "the deadline fired at its span");

    // A dispose after the fire finds the entry already gone, and a repeat finds nothing at all, so neither may throw, revive the signal, or reach the later delay.
    assert.doesNotThrow(() => deadline[Symbol.dispose](), "a dispose after the fire is harmless");
    assert.doesNotThrow(() => deadline[Symbol.dispose](), "and so is a repeat of it");
    assert.equal(deadline.signal.aborted, true, "the signal stays aborted");
    assert.equal(deadline.signal.reason, reason, "with the reason it fired with");
    assert.equal(clock.pending, 1, "and the later delay is still on the timeline");

    clock.advance(200);
    await waited;

    assert.equal(resolved, true, "where it resolves once its own time is crossed");
  });

  test("a deadline and a delay share one timeline, so each step settles the entry that is next", async () => {

    const clock = new TestClock();

    using deadline = armDeadline(500, { clock });

    let resolved = false;

    const waited = clock.delay(300).then((): void => {

      resolved = true;
    });

    assert.equal(clock.nextDeadline, 300, "the delay comes due first");
    assert.equal(clock.advanceToNext(), true, "the first step lands on it");

    await waited;

    assert.equal(resolved, true, "and resolves it");
    assert.equal(deadline.signal.aborted, false, "with the deadline still live");
    assert.equal(clock.now(), 300, "at the delay's own time");
    assert.equal(clock.advanceToNext(), true, "a second step lands on the deadline");
    assert.equal(deadline.signal.aborted, true, "and aborts it");
    assert.equal(clock.now(), 500, "at exactly its span");
    assert.equal(clock.pending, 0, "leaving the timeline empty");
  });

  test("armed with no clock named, it runs on the system clock and aborts with the platform's reason", async () => {

    // A real wait, kept as small as the real clock allows: only the real clock can prove the default, so we arm a 1ms deadline. Its timer is unreferenced, but the
    // runner holds the process open, so the abort arrives.
    using deadline = armDeadline(1);

    assert.equal(deadline.signal.aborted, false, "a freshly armed deadline is not aborted synchronously");

    await waitUntil(() => deadline.signal.aborted, { description: "the default-clock deadline to abort" });

    assertTimeoutReason(deadline.signal.reason, "the default-clock deadline");
  });

  test("a span past the ceiling arms on the real timers without the platform's overflow warning", async () => {

    // The platform announces a delay it has set to one millisecond through a process warning, emitted on a later tick, so the read below yields a macrotask first.
    // A span past the ceiling cannot be waited out here, so the deadline is released at once and the read is of what arming it drew.
    const warnings: string[] = [];
    const observe = (warning: Error): number => warnings.push(warning.name);

    process.on("warning", observe);

    try {

      const deadline = armDeadline(TIMER_DELAY_MAX_MS + 1);

      deadline[Symbol.dispose]();

      await settle();

      assert.deepEqual(warnings, [], "arming a span past the ceiling draws no overflow warning, because its first hop arms at most the ceiling");
      assert.equal(deadline.signal.aborted, false, "and the released deadline's signal stays live");
    } finally {

      process.off("warning", observe);
    }
  });

  test("a span past the ceiling is one entry on the double, carrying the full span", () => {

    // A virtual timeline has no ceiling, so the double needs no chain: the deadline is the one entry its schedule call registers, at the span asked for.
    const clock = new TestClock();

    using deadline = armDeadline(TIMER_DELAY_MAX_MS + 1, { clock });

    assert.deepEqual(clock.requested, [TIMER_DELAY_MAX_MS + 1], "the ledger records the full span");
    assert.equal(clock.pending, 1, "as one entry");
    assert.equal(clock.nextDeadline, TIMER_DELAY_MAX_MS + 1, "coming due at the span asked for");

    clock.advance(TIMER_DELAY_MAX_MS);

    assert.equal(deadline.signal.aborted, false, "a ceiling's worth of virtual time aborts nothing");

    clock.advance(1);

    assert.equal(deadline.signal.aborted, true, "and the remainder aborts it");
  });

  test("an infinite span never aborts: on the system clock across a real wait, and on the double, which registers no entry, across a long advance", async () => {

    using onSystem = armDeadline(Infinity);

    await systemClock.delay(REAL_WAIT_MS);

    assert.equal(onSystem.signal.aborted, false, "a deadline the platform would have fired after a millisecond stays live across a real wait");

    const clock = new TestClock();

    using onDouble = armDeadline(Infinity, { clock });

    assert.equal(clock.pending, 0, "the double registers no entry for the deadline");
    assert.equal(clock.nextDeadline, null, "so it has no deadline to answer");
    assert.deepEqual(clock.requested, [Infinity], "while the ledger records the span asked for");

    clock.advance(Number.MAX_VALUE);

    assert.equal(onDouble.signal.aborted, false, "and the longest finite advance aborts nothing");
  });

  test("a span past the ceiling on the system clock is carried as a chain and aborts at exactly the moment asked for", (t) => {

    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });

    using deadline = armDeadline(TIMER_DELAY_MAX_MS + 1);

    t.mock.timers.tick(TIMER_DELAY_MAX_MS);

    assert.equal(deadline.signal.aborted, false, "a full ceiling's worth of time leaves the deadline live, because its first hop re-arms for the remainder");

    t.mock.timers.tick(1);

    assert.equal(deadline.signal.aborted, true, "one millisecond more aborts it");
    assertTimeoutReason(deadline.signal.reason, "the chained deadline");
  });

  test("disposing it on the system clock clears its timer within the ceiling and past it, while an undisposed twin of each aborts", (t) => {

    // Each released deadline is armed beside an undisposed twin of the same span, so the twins aborting at the same advance shows the harness reached those timers
    // and the released deadlines stayed live because of their disposal rather than because the advance missed them.
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });

    const within = armDeadline(1000);
    const withinTwin = armDeadline(1000);
    const past = armDeadline(TIMER_DELAY_MAX_MS + 1);
    const pastTwin = armDeadline(TIMER_DELAY_MAX_MS + 1);

    within[Symbol.dispose]();
    past[Symbol.dispose]();

    t.mock.timers.tick(TIMER_DELAY_MAX_MS);
    t.mock.timers.tick(1);

    assert.equal(within.signal.aborted, false, "a released deadline within the ceiling stays live past its span");
    assert.equal(past.signal.aborted, false, "and so does a released deadline past it");
    assert.equal(withinTwin.signal.aborted, true, "while the undisposed twin within the ceiling aborts");
    assert.equal(pastTwin.signal.aborted, true, "and so does the undisposed twin past it");
  });

  test("a process holding a deadline on the system clock exits on its own, whether the deadline was released or left armed", async () => {

    /* Each child arms a deadline far longer than the bound `runChild` puts on its spawn, so reaching its own exit inside that bound is the proof. One child releases
     * its deadline before it exits and the other never does: a released timer is cleared outright, and one left armed is unreferenced, so neither may hold the
     * child's event loop open. The children run side by side, so the row's wait stays within a single bound.
     */
    await using scratch = await makeScratchRoot(SCRATCH_PREFIX);

    const importLine = "import { armDeadline } from " + JSON.stringify(CLOCK_PATH) + ";\n\n";
    const [ released, armed ] = await Promise.all([

      runChild(scratch.path, "released-deadline.ts", importLine + "const deadline = armDeadline(300000);\n\ndeadline[Symbol.dispose]();\nconsole.log(\"released\");\n"),
      runChild(scratch.path, "armed-deadline.ts", importLine + "armDeadline(3600000);\nconsole.log(\"armed\");\n")
    ]);

    assert.equal(released.code, 0, "the child that released its deadline must reach its own exit; stderr: " + released.stderr);
    assert.equal(released.stdout, "released\n", "having armed and released it first; stderr: " + released.stderr);
    assert.equal(armed.code, 0, "the child that left its deadline armed must reach its own exit as well; stderr: " + armed.stderr);
    assert.equal(armed.stdout, "armed\n", "having armed it first; stderr: " + armed.stderr);
  });
});

describe("yieldMacrotask - the yield beside the clock contract", () => {

  test("resolves only once the nextTick and microtask queues have drained, a tick queued from inside a microtask included", async () => {

    // This is the order a corked stream depends on: its uncork is a tick queued while a write runs, and the caller's continuation is a chain of microtasks. Each
    // queue is fed here, the tick queue from inside the microtask queue as well, and the yield must resolve behind every entry.
    const order: string[] = [];

    process.nextTick(() => {

      order.push("tick");
    });

    queueMicrotask(() => {

      order.push("microtask");

      process.nextTick(() => {

        order.push("tick from a microtask");
      });
    });

    await yieldMacrotask();

    order.push("yield");

    assert.equal(order.length, 4, "every entry queued ahead of the yield must have run");
    assert.equal(order.at(-1), "yield", "and the yield must resolve behind all of them");
  });

  test("reaches the queue while mock timers replace setImmediate and setTimeout, so no harness can park it", async (t) => {

    // Real immediates, one queued behind the other, are armed before the mock takes the globals, so the row ends on its own whichever way the yield goes rather
    // than waiting out the runner's timeout: a parked yield loses the race to them, while a live one resolves on the turn the first of them runs.
    const realImmediate = globalThis.setImmediate;
    const parked = new Promise<string>((resolve) => {

      realImmediate(() => realImmediate(() => resolve("parked")));
    });

    t.mock.timers.enable({ apis: [ "setImmediate", "setTimeout" ] });

    assert.equal(await Promise.race([ yieldMacrotask().then(() => "yielded"), parked ]), "yielded",
      "the yield is bound to the platform's own setImmediate, so a harness that replaces the timers afterwards must not park it");
  });
});
