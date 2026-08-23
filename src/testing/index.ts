/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/index.ts: The library's test-support entry point - the cross-cutting helpers, the guard machinery, and every shipped test double, at one subpath.
 */

/**
 * Every piece of shipped test-support surface the library offers, reachable at one entry point.
 *
 * The package publishes one subpath per concern - the log client, the explicit-resource-management polyfills, the ESLint preset - and this is the concern named test
 * support. A consumer reaches all of it through `homebridge-plugin-utils/testing`: the cross-cutting helpers defined below, the runtime-floor guard machinery in
 * `runtime-floor.ts` beside this file, and the test doubles that stand in for the library's own dependency-inversion boundaries.
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
import type { HomebridgePluginLogging } from "../util.ts";
import assert from "node:assert/strict";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { noOpLog } from "../util.ts";

/* The shipped doubles, aggregated from their physical homes, and the guard machinery that lives in this directory alongside the helpers. Each module is re-exported
 * wholesale rather than symbol-by-symbol, because the module on the other side already curates what it publishes and a second enumeration here would be a list to keep
 * in sync for nothing.
 */
export * from "../clock-double.ts";
export * from "../ffmpeg/fmp4-builders.ts";
export * from "../ffmpeg/recording-process-double.ts";
export * from "../logclient/socket-double.ts";
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
 * interface shape and per-method void-return annotations here. The spread yields a fresh object per call - the identity contract this helper's tests pin - while every
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
    await flushImmediate();

    assert.deepEqual(unhandled, [], "body triggered unhandled rejection(s)");

    return value;
  } finally {

    process.off("unhandledRejection", onUnhandled);
  }
}
