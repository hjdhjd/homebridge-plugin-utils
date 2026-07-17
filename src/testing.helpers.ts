/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: Cross-cutting test helpers shared across the HBPU test suite.
 */

/**
 * Cross-cutting test helpers shared across every test file in the HBPU suite.
 *
 * Domain-specific helpers live next to the modules they exercise (e.g., `ffmpeg/fmp4-builders.ts` for ISO BMFF construction, `mqtt.helpers.ts` for the MQTT transport
 * stub). This module holds the primitives that are useful regardless of subject:
 *
 * - {@link expectAt} - narrow-or-fail indexed access helper that papers over `noUncheckedIndexedAccess` without introducing non-null assertions in test bodies.
 * - {@link silentLog} - no-op {@link HomebridgePluginLogging} factory for tests that treat logging as implementation detail.
 * - {@link capturingLog} - entries-capturing {@link HomebridgePluginLogging} factory for tests that assert against log output. Pairs with {@link TestLogEntry}.
 * - {@link assertNoUnhandledRejections} - `unhandledRejection` monitor that turns Node's warn-and-continue default into a hard test assertion.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see `typedoc.json`)
 * so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import type { HomebridgePluginLogging } from "./util.ts";
import assert from "node:assert/strict";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { noOpLog } from "./util.ts";

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
 * interface shape and per-method void-return annotations here. The spread yields a fresh object per call - the identity contract this helper's tests pin - while every
 * method is the shared, stateless no-op.
 *
 * @returns A logger whose methods are all no-ops.
 *
 * @example
 *
 * ```ts
 * import { silentLog } from "./testing.helpers.ts";
 *
 * const client = new MqttClient({ brokerUrl: "mqtt://localhost", log: silentLog(), topicPrefix: "test" });
 * ```
 */
export function silentLog(): HomebridgePluginLogging {

  return { ...noOpLog };
}

/**
 * A single captured log emission from {@link capturingLog}. The tuple `(level, message, params)` mirrors what `HomebridgePluginLogging`'s methods receive; the shape is
 * narrow enough that tests can assert against it with `deepEqual` while carrying through the originating level so callers can filter by severity.
 */
export interface TestLogEntry {

  level: "debug" | "error" | "info" | "warn";
  message: string;
  params: unknown[];
}

/**
 * {@link capturingLog}'s return shape: a live {@link HomebridgePluginLogging} plus a `readonly` view of the entries captured so far. The read-only typing lets tests
 * assert against `entries` without being able to mutate them - the only code that pushes into the array is the logger methods themselves, which the factory closes
 * over in the live mutable reference.
 */
export type CapturingLog = HomebridgePluginLogging & { readonly entries: readonly TestLogEntry[] };

/**
 * Return a capturing {@link HomebridgePluginLogging} implementation. Every method pushes a {@link TestLogEntry} into the logger's `entries` array; tests then assert
 * against that array to verify the class under test emitted the expected log lines at the expected severities.
 *
 * Hoisted into the shared testing-helpers module for the same reason as {@link silentLog}: the shape is identical across every test file that asserts on log output,
 * and repeating the logger's arrow-function bodies per test file is pure duplication. The `entries` view is `readonly` so tests cannot accidentally corrupt captured
 * state mid-run; the factory itself closes over the underlying mutable array so the logger methods can still push.
 *
 * @returns A logger that records every emission for later assertion.
 *
 * @example
 *
 * ```ts
 * import { capturingLog } from "./testing.helpers.ts";
 *
 * const log = capturingLog();
 *
 * classUnderTest.doSomething(log);
 *
 * assert.equal(log.entries.at(-1)?.level, "info");
 * ```
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
    await flushImmediate();

    assert.deepEqual(unhandled, [], "body triggered unhandled rejection(s)");

    return value;
  } finally {

    process.off("unhandledRejection", onUnhandled);
  }
}
