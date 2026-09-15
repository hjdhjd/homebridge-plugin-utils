/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/index.ts: The library's test-support entry point - the cross-cutting helpers, the guard machinery, and every shipped test double, at one subpath.
 */

/**
 * Every piece of shipped test-support surface the library offers, reachable at one entry point.
 *
 * The package publishes one subpath per concern - the log client, the explicit-resource-management polyfills, the ESLint preset - and this is the concern named test
 * support. A consumer reaches all of it through `homebridge-plugin-utils/testing`: the cross-cutting helpers defined below - the capturing logger and its entry
 * finders, the unhandled-rejection assertion, the shared poll-with-deadline, and the macrotask yield with the two `TestClock` walks built on it - the runtime-floor
 * guard machinery in `runtime-floor.ts` beside this file, and the test doubles that stand in for the library's own dependency-inversion boundaries.
 *
 * The doubles are aggregated here, not relocated. Each one still sits beside the production module it stands in for - `clock-double.ts` beside `clock.ts`,
 * `recording-process-double.ts` beside `record.ts`, `socket-double.ts` beside `socket.ts`, `mqtt-client-double.ts` beside `mqttClient.ts` - because a double and its
 * subject drift apart the moment they stop sharing a directory. Only their export path lives here. The helpers and the guard machinery are the other case: they have
 * no production subject to sit beside, so this directory is where they are defined rather than merely re-exported.
 *
 * Nothing in production may import from this module, and that is what the dedicated subpath buys over a category tag on the main barrel. The production/test category
 * boundary becomes structural: a production module reaching for a double names a specifier that a reader and a grep can both see is wrong, rather than one everybody
 * has to remember not to write.
 *
 * @module
 */
import { setTimeout as delay, setImmediate as flushImmediate } from "node:timers/promises";
import type { HomebridgePluginLogging } from "../util.ts";
import type { TestClock } from "../clock-double.ts";
import assert from "node:assert/strict";
import { format } from "node:util";
import { noOpLog } from "../util.ts";

/* The shipped doubles, aggregated from their physical homes, and the guard machinery that lives in this directory alongside the helpers. Each module is re-exported
 * wholesale rather than symbol-by-symbol, because the module on the other side already curates what it publishes and a second enumeration here would be a list to keep
 * in sync for nothing.
 */
export * from "../clock-double.ts";
export * from "../ffmpeg/fmp4-builders.ts";
export * from "../ffmpeg/recording-process-double.ts";
export * from "../http-listener-double.ts";
export * from "../logclient/socket-double.ts";
export * from "../mdns/browser-double.ts";
export * from "../mdns/message-builders.ts";
export * from "../mqtt-client-double.ts";
export * from "./runtime-floor.ts";

/**
 * Return `items[index]`, asserting the element exists. Narrows the result to `T` so test bodies can use the value without non-null assertions and without a separate
 * `assert.ok`/use pair on every access.
 *
 * Designed for `noUncheckedIndexedAccess`-strict codebases where `items[index]` is typed `T | undefined` even inside a `length`-checked block. Test helpers that walk
 * a collection and distinguish specific indices (e.g., "the first emitted record should be ..." / "the second should be ...") are the primary use case.
 *
 * @typeParam T      - The element type of `items`. Assumes `T` does not include `undefined`; if it does, the assertion cannot distinguish a valid `undefined` element
 *                     from an out-of-bounds index.
 * @param items      - The collection to index into.
 * @param index      - The index to read. Negative indices are not supported (would always fail the assertion).
 * @param description - Optional human-readable descriptor for the failure message. Defaults to `"an item"`.
 *
 * @returns The element at `index`, narrowed to `T`.
 *
 * @throws `AssertionError` if `items[index]` is `undefined` (either because the index is out of bounds or because the element itself is `undefined`).
 *
 * @example
 *
 * ```ts
 * const boxes = Array.from(parser.consume(chunk));
 *
 * assert.deepEqual(expectAt(boxes, 0, "first box").bytes, expected);
 * ```
 *
 * @category Testing
 */
export function expectAt<T>(items: readonly T[], index: number, description = "an item"): T {

  const item = items[index];

  assert.ok(item !== undefined, "expected " + description + " at index " + index.toString());

  return item;
}

/**
 * Return a no-op {@link HomebridgePluginLogging} implementation. Every method is present and well-typed, but discards its input - the tests that consume this fixture
 * treat logging as implementation detail and assert against behavior rather than captured log output.
 *
 * Derives from the production `noOpLog` SSOT in `util.ts` via spread, so the no-op method set has exactly one definition library-wide rather than re-declaring the
 * interface shape and per-method void-return annotations here. The spread yields a fresh object per call - the identity contract this helper's tests assert - while every
 * method is the shared, stateless no-op.
 *
 * @returns A logger whose methods are all no-ops.
 *
 * @example
 *
 * ```ts
 * import { silentLog } from "homebridge-plugin-utils/testing";
 *
 * const client = new MqttClient({ brokerUrl: "mqtt://localhost", log: silentLog(), topicPrefix: "test" });
 * ```
 *
 * @category Testing
 */
export function silentLog(): HomebridgePluginLogging {

  return { ...noOpLog };
}

/**
 * A single captured log emission from {@link capturingLog}. The tuple `(level, message, params)` mirrors what `HomebridgePluginLogging`'s methods receive; the shape is
 * narrow enough that tests can assert against it with `deepEqual` while carrying through the originating level so callers can filter by severity.
 *
 * @category Testing
 */
export interface TestLogEntry {

  /**
   * The severity the log method was called at.
   */
  level: "debug" | "error" | "info" | "warn";

  /**
   * The message passed to the log method.
   */
  message: string;

  /**
   * The remaining arguments passed to the log method alongside `message`.
   */
  params: unknown[];
}

/**
 * {@link capturingLog}'s return shape: a live {@link HomebridgePluginLogging} plus a `readonly` view of the entries captured so far. The read-only typing lets tests
 * assert against `entries` without being able to mutate them - the only code that pushes into the array is the logger methods themselves, which the factory closes
 * over in the live mutable reference.
 *
 * @category Testing
 */
export type CapturingLog = HomebridgePluginLogging & { readonly entries: readonly TestLogEntry[] };

/**
 * Return a capturing {@link HomebridgePluginLogging} implementation. Every method pushes a {@link TestLogEntry} into the logger's `entries` array; tests then assert
 * against that array to verify the class under test emitted the expected log lines at the expected severities.
 *
 * Lives here for the same reason as {@link silentLog}: the shape is identical across every test file that asserts on log output, and repeating the logger's
 * arrow-function bodies per test file is pure duplication. The `entries` view is `readonly` so tests cannot accidentally corrupt captured state mid-run; the factory
 * itself closes over the underlying mutable array so the logger methods can still push.
 *
 * @returns A logger that records every emission for later assertion.
 *
 * @example
 *
 * ```ts
 * import { capturingLog } from "homebridge-plugin-utils/testing";
 *
 * const log = capturingLog();
 *
 * classUnderTest.doSomething(log);
 *
 * assert.equal(log.entries.at(-1)?.level, "info");
 * ```
 *
 * @category Testing
 */
export function capturingLog(): CapturingLog {

  const entries: TestLogEntry[] = [];

  return {

    debug: (message: string, ...params: unknown[]): void => {

      entries.push({ level: "debug", message, params });
    },
    entries,
    error: (message: string, ...params: unknown[]): void => {

      entries.push({ level: "error", message, params });
    },
    info: (message: string, ...params: unknown[]): void => {

      entries.push({ level: "info", message, params });
    },
    warn: (message: string, ...params: unknown[]): void => {

      entries.push({ level: "warn", message, params });
    }
  };
}

/**
 * Render a captured {@link TestLogEntry} the way a real logger prints it, interpolating `params` into `message`'s format tokens.
 *
 * Plugin log calls carry their values printf-style - `log.info("Retrying in %d seconds.", 30)` - so the value a test cares about lives in `params` and never appears
 * in the captured `message` at all. Rendering is what puts it back into a single string that can be matched. This is the one rendering definition the finders below
 * compose, and it is exported on its own so a harness that wants the rendered line for an assertion shape of its own does not re-derive the render.
 *
 * @param entry - The captured entry to render.
 *
 * @returns The entry's message with its params interpolated.
 *
 * @category Testing
 */
export function formatLogEntry(entry: TestLogEntry): string {

  return format(entry.message, ...entry.params);
}

/**
 * Report whether any entry at `level`, once rendered through {@link formatLogEntry}, contains `substring`.
 *
 * The render is what makes the match meaningful - a search of the raw `message` field misses every value that arrived as a format parameter. The level restriction is
 * part of the assertion rather than a convenience: "this was reported as an error" and "this was mentioned at debug" are different claims about the same text.
 *
 * Takes the entries array rather than the {@link CapturingLog} itself, so a caller can search a slice. `loggedAt(log.entries.slice(before), "info", "Reconnected")`
 * answers "one more line after the reconnect" without standing up a second logger, and a harness holding a bare array needs no adapter.
 *
 * @param entries   - The captured entries to search.
 * @param level     - The severity to restrict the search to.
 * @param substring - The text to look for in the rendered line.
 *
 * @returns `true` when at least one entry at `level` renders to a line containing `substring`.
 *
 * @example
 *
 * ```ts
 * import { capturingLog, loggedAt } from "homebridge-plugin-utils/testing";
 *
 * const log = capturingLog();
 *
 * classUnderTest.retry(log);
 *
 * // The emission was `log.warn("Retrying in %d seconds.", 30)`, so "30" is nowhere in the captured message...only the render finds it.
 * assert.ok(loggedAt(log.entries, "warn", "30"));
 * ```
 *
 * @category Testing
 */
export function loggedAt(entries: readonly TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && formatLogEntry(entry).includes(substring));
}

/**
 * Count the entries at `level` whose rendered line contains `substring`, matching by the same rules as {@link loggedAt}.
 *
 * Distinct from {@link loggedAt} because "emitted exactly once" is a stronger claim than "emitted at all", and it is the one worth asserting around retry loops and
 * reconnect handlers: a path that logs its warning on every attempt satisfies a presence check and fails a count of one.
 *
 * @param entries   - The captured entries to search.
 * @param level     - The severity to restrict the count to.
 * @param substring - The text to look for in the rendered line.
 *
 * @returns The number of entries at `level` whose rendered line contains `substring`.
 *
 * @category Testing
 */
export function logCount(entries: readonly TestLogEntry[], level: TestLogEntry["level"], substring: string): number {

  return entries.filter((entry) => (entry.level === level) && formatLogEntry(entry).includes(substring)).length;
}

/**
 * Run `body` while monitoring `process`'s `unhandledRejection` channel, and assert that no rejections surface during execution. Turns Node's default
 * warn-and-continue behavior into a hard test assertion, so tests that claim "this flow does not trigger an unhandled rejection" get deterministic coverage rather
 * than relying on log inspection.
 *
 * Node emits `unhandledRejection` one turn of the event loop after a Promise rejects without a handler; the helper drains with a `setImmediate` before asserting so
 * any pending emissions surface before the check.
 *
 * @typeParam T - The resolved value type of `body`.
 * @param body  - Async body to execute under monitoring.
 *
 * @returns The body's resolved value.
 *
 * @throws `AssertionError` if `body` triggered one or more unhandled rejections.
 *
 * @example
 *
 * ```ts
 * await assertNoUnhandledRejections(async () => {
 *
 *   const resolvers = Promise.withResolvers<string>();
 *   await assert.rejects(waitWithSignal(resolvers.promise, abortedSignal));
 *   resolvers.reject(new Error("late"));
 * });
 * ```
 *
 * @category Testing
 */
export async function assertNoUnhandledRejections<T>(body: () => Promise<T>): Promise<T> {

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {

    unhandled.push(reason);
  };

  process.on("unhandledRejection", onUnhandled);

  try {

    const value = await body();

    // Drain one event-loop turn so any pending `unhandledRejection` events surface before we inspect the channel.
    await settle();

    assert.deepEqual(unhandled, [], "body triggered unhandled rejection(s)");

    return value;
  } finally {

    process.off("unhandledRejection", onUnhandled);
  }
}

/**
 * Resolve as soon as `predicate()` reads `true`, polling every `pollMs` milliseconds until a deadline `timeoutMs` out, and throw when the deadline passes with the
 * predicate still false.
 *
 * This is the one poll-with-deadline the test suites share, for the waits whose subject is a state that settles on a later tick rather than on an event a test can
 * await directly: a datagram the kernel delivers on the loopback interface, a log line a handler emits, a client's connection flag flipping once its CONNACK is
 * parsed. A deadline that fails loudly is what makes those waits honest...a fixed sleep passes on the absence of evidence, and it pays its full duration on every
 * run whether or not the state settled in the first millisecond.
 *
 * @param predicate           - The condition to poll. Called immediately and then once per interval, so a state that is already settled costs no wait at all.
 * @param options             - Wait options.
 * @param options.description - What the wait is for, in the grammar of "waiting for _____". It is the whole of the failure message, so name the state rather than
 *                              the assertion.
 * @param options.pollMs      - Milliseconds between polls. Defaults to 5.
 * @param options.timeoutMs   - Maximum total wait, in milliseconds. Defaults to 1000 - a comfortable margin for localhost timing on a slow CI runner.
 *
 * @throws `Error` when `timeoutMs` elapses with the predicate still false.
 *
 * @example
 *
 * ```ts
 * await waitUntil(() => receiver.received.length >= 1, { description: "the forwarded datagram to arrive" });
 * ```
 *
 * @category Testing
 */
export async function waitUntil(predicate: () => boolean, { description, pollMs = 5, timeoutMs = 1000 }: { description: string; pollMs?: number;
  timeoutMs?: number; }): Promise<void> {

  const deadline = Date.now() + timeoutMs;

  while(!predicate()) {

    if(Date.now() >= deadline) {

      throw new Error("waitUntil: " + description + " did not hold within " + timeoutMs.toString() + " ms.");
    }

    // The poll-with-deadline pattern is intentionally sequential - we cannot batch parallel awaits when each iteration's check depends on real-elapsed time. The
    // standard ESLint guidance against `await` in loops applies to throughput-sensitive batches; this is an upper-bounded synchronization helper, not a workload.
    // eslint-disable-next-line no-await-in-loop
    await delay(pollMs);
  }
}

/**
 * Yield to the macrotask queue `turns` times, so the continuations a test has already released have run by the time it looks at what they did.
 *
 * Each turn yields one macrotask, which drains the entire microtask cascade first: a chain of promise continuations - an attempt's rejection, the checks that follow it,
 * the clock registration those checks arm - comes to rest before the caller looks. One turn is the default, and it is enough for any cascade that stays in promise-land;
 * a caller names more turns only when its subject's cascade crosses more than one macrotask boundary of its own, a handshake whose steps each schedule the next being
 * the usual case. A `turns` of zero yields nothing at all.
 *
 * @param turns - How many macrotask boundaries to cross. Defaults to 1.
 *
 * @example
 *
 * ```ts
 * clock.advance(100);
 * await settle();
 *
 * assert.equal(attempts.length, 2);
 * ```
 *
 * @category Testing
 */
export async function settle(turns = 1): Promise<void> {

  for(let turn = 0; turn < turns; turn++) {

    // The yield is the whole point of the loop, so its awaits cannot be batched...each turn has to reach the queue before the next one is crossed.
    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
}

/**
 * Walk `clock` through a schedule of waits, letting the queue come to rest before each step and once more after the last.
 *
 * A subject registers its next wait only after the one before it has settled, so a single advance across the whole schedule moves past deadlines that were never
 * registered and strands every wait after the first; stepping releases one wait at a time. The trailing yield lets whatever the last step released run to completion, so
 * the caller reads a finished body rather than one still mid-continuation.
 *
 * @param clock - The clock whose virtual time the walk moves.
 * @param waits - The waits to step through, in the order the subject registers them.
 *
 * @example
 *
 * ```ts
 * // An operation whose backoff schedule is 100 ms and then 200 ms, walked to completion.
 * await advanceThroughSchedule(clock, [ 100, 200 ]);
 *
 * assert.equal(clock.now(), 300);
 * ```
 *
 * @category Testing
 */
export async function advanceThroughSchedule(clock: TestClock, waits: readonly number[]): Promise<void> {

  for(const wait of waits) {

    // Each step has to let the wait it released register its successor before virtual time moves again, so these awaits are sequential by design.
    // eslint-disable-next-line no-await-in-loop
    await settle();
    clock.advance(wait);
  }

  await settle();
}

/**
 * Step `clock` to each pending deadline until nothing is pending, and answer how many steps that took.
 *
 * The bound is what separates a finished drain from a spinning one: a repeating timer never empties the list, and a suite that hangs on one is a far worse failure than
 * a suite that throws naming the limit it was given. Every step is followed by a yield before the clock is asked for the next deadline, so the continuations a step
 * released have registered their own waits before the drain decides it is finished...which is also what lets the work after the last deadline run before the count comes
 * back.
 *
 * @param clock - The clock to drain.
 * @param limit - The maximum number of steps to take. Defaults to 1000.
 *
 * @returns The number of deadlines stepped to, which is zero for a clock that had nothing pending.
 *
 * @throws `Error` when the clock still has entries pending after `limit` steps.
 *
 * @example
 *
 * ```ts
 * // A body awaiting two delays in sequence, drained to completion.
 * const steps = await drainClock(clock);
 *
 * assert.equal(steps, 2);
 * ```
 *
 * @category Testing
 */
export async function drainClock(clock: TestClock, limit = 1000): Promise<number> {

  let steps = 0;

  for(;;) {

    // Each pass has to let the continuations the last step released register their next deadline before the clock is asked for it, so these awaits are sequential too.
    // eslint-disable-next-line no-await-in-loop
    await settle();

    if(!clock.advanceToNext()) {

      return steps;
    }

    steps++;

    if(steps > limit) {

      throw new Error("drainClock: the clock still had entries pending after " + limit.toString() + " steps.");
    }
  }
}
