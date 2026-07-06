/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/filter.test.ts: Unit tests for the log-record predicate builder.
 */
import type { LogLevel, LogRecord } from "./types.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createLogFilter } from "./filter.ts";

// Build a LogRecord with sensible defaults so each test overrides only the fields it cares about. The `raw` mirrors `message` since the filter never inspects `raw`.
function record(overrides: Partial<LogRecord> = {}): LogRecord {

  const message = overrides.message ?? "a message";

  return { level: overrides.level ?? null, message, plugin: overrides.plugin ?? null, raw: overrides.raw ?? message, timestamp: overrides.timestamp ?? null };
}

describe("createLogFilter", () => {

  test("an empty filter passes every record", () => {

    const filter = createLogFilter();

    assert.equal(filter(record({ level: "error", message: "anything", plugin: "X" })), true);
    assert.equal(filter(record({ level: null, message: "", plugin: null })), true);
  });

  test("an all-empty-array filter also passes every record", () => {

    // Empty allow-lists are treated the same as omitted fields: no constraint.
    const filter = createLogFilter({ levels: [], plugins: [] });

    assert.equal(filter(record({ level: "warn", plugin: "Y" })), true);
  });

  test("grep admits matching messages and rejects non-matching ones", () => {

    const filter = createLogFilter({ grep: /timeout/ });

    assert.equal(filter(record({ message: "connection timeout occurred" })), true);
    assert.equal(filter(record({ message: "all systems nominal" })), false);
  });

  test("grep is applied to the stripped message, not the raw line", () => {

    // The filter tests `message`; a record whose raw carries escapes but whose message is plain still matches a plain pattern.
    const filter = createLogFilter({ grep: /^plain$/ });

    assert.equal(filter(record({ message: "plain", raw: "[31mplain[39m" })), true);
  });

  test("a global-flag grep matches order-independently across records", () => {

    // A `/g` RegExp has a stateful `lastIndex`; the filter must reset it per record so a match never depends on the previous call's residual cursor.
    const filter = createLogFilter({ grep: /foo/g });

    assert.equal(filter(record({ message: "foo" })), true);
    assert.equal(filter(record({ message: "foo" })), true);
    assert.equal(filter(record({ message: "foo" })), true);
  });

  test("level allow-list admits listed levels and rejects others", () => {

    const filter = createLogFilter({ levels: [ "error", "warn" ] });

    assert.equal(filter(record({ level: "error" })), true);
    assert.equal(filter(record({ level: "warn" })), true);
    assert.equal(filter(record({ level: "info" })), false);
  });

  test("a null level never satisfies a non-empty level allow-list", () => {

    const filter = createLogFilter({ levels: ["error"] });

    assert.equal(filter(record({ level: null })), false);
  });

  test("plugin allow-list matches case-insensitively", () => {

    const filter = createLogFilter({ plugins: ["My Plugin"] });

    assert.equal(filter(record({ plugin: "my plugin" })), true);
    assert.equal(filter(record({ plugin: "MY PLUGIN" })), true);
    assert.equal(filter(record({ plugin: "Other" })), false);
  });

  test("a null plugin never satisfies a non-empty plugin allow-list", () => {

    const filter = createLogFilter({ plugins: ["X"] });

    assert.equal(filter(record({ plugin: null })), false);
  });

  test("combined criteria require every active criterion to pass (logical AND)", () => {

    const filter = createLogFilter({ grep: /boom/, levels: ["error"], plugins: ["Plug"] });

    // Grep, level, and plugin all satisfied.
    assert.equal(filter(record({ level: "error", message: "boom happened", plugin: "Plug" })), true);
    // Grep fails.
    assert.equal(filter(record({ level: "error", message: "quiet", plugin: "Plug" })), false);
    // Level fails.
    assert.equal(filter(record({ level: "warn", message: "boom", plugin: "Plug" })), false);
    // Plugin fails.
    assert.equal(filter(record({ level: "error", message: "boom", plugin: "Other" })), false);
  });

  test("every LogLevel can be allow-listed", () => {

    const levels: readonly LogLevel[] = [ "debug", "error", "info", "success", "warn" ];
    const filter = createLogFilter({ levels });

    for(const level of levels) {

      assert.equal(filter(record({ level })), true, level + " should pass its own allow-list");
    }
  });
});
