/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/time-window.test.ts: Unit tests for the timeWindow async-generator transform - inclusive bounds, carry-forward, and arrival-order processing.
 */
import { describe, test } from "node:test";
import type { LogRecord } from "./types.ts";
import type { Nullable } from "../util.ts";
import assert from "node:assert/strict";
import { timeWindow } from "./time-window.ts";

// Pad a number to two digits for the minute/second fields the timestamp regex requires.
function pad(value: number): string {

  return value.toString().padStart(2, "0");
}

// Build a 24-hour `M/D/2026` timestamp string the parser recognizes, for a time on 2026-06-29. Used as the record's timestamp text so `timeWindow` parses a real instant.
function stamp(hour: number, minute: number, second: number): string {

  return "6/29/2026, " + hour.toString() + ":" + pad(minute) + ":" + pad(second);
}

// The local epoch of the same 2026-06-29 wall-clock time, constructed the SAME way the parser does, so bounds and assertions are timezone-invariant.
function epoch(hour: number, minute: number, second: number): number {

  return new Date(2026, 5, 29, hour, minute, second).getTime();
}

// Build a record carrying a timestamp at the given wall-clock time. `message` doubles as the identity asserted on, and `raw` carries it too.
function at(hour: number, minute: number, second: number, message: string): LogRecord {

  return { level: null, message, plugin: "P", raw: message, timestamp: stamp(hour, minute, second) };
}

// Build a null-timestamp record - a continuation line, a bare status line, or the stitch gap marker - whose placement depends entirely on carry-forward.
function continuation(message: string): LogRecord {

  return { level: null, message, plugin: null, raw: message, timestamp: null };
}

// Adapt an array into an async iterable so the transform consumes it exactly as it would a live channel.
async function *fromArray(records: readonly LogRecord[]): AsyncGenerator<LogRecord> {

  for(const record of records) {

    yield record;
  }
}

// Drain the transform into the list of surviving record messages, in yield order.
async function windowed(records: readonly LogRecord[], bounds: { since: Nullable<number>; until: Nullable<number> }): Promise<string[]> {

  const kept: string[] = [];

  for await (const record of timeWindow(fromArray(records), bounds)) {

    kept.push(record.message);
  }

  return kept;
}

describe("timeWindow - bounds", () => {

  test("since-only drops records before the lower bound (inclusive)", async () => {

    const records = [ at(10, 0, 0, "ten"), at(11, 0, 0, "eleven"), at(12, 0, 0, "twelve") ];
    const kept = await windowed(records, { since: epoch(11, 0, 0), until: null });

    assert.deepEqual(kept, [ "eleven", "twelve" ], "the record exactly at `since` is kept; the earlier one is dropped");
  });

  test("until-only drops records after the upper bound (inclusive)", async () => {

    const records = [ at(10, 0, 0, "ten"), at(11, 0, 0, "eleven"), at(12, 0, 0, "twelve") ];
    const kept = await windowed(records, { since: null, until: epoch(11, 0, 0) });

    assert.deepEqual(kept, [ "ten", "eleven" ], "the record exactly at `until` is kept; the later one is dropped");
  });

  test("both bounds keep only the closed interval, inclusive on each edge", async () => {

    const records = [ at(10, 0, 0, "ten"), at(11, 0, 0, "eleven"), at(12, 0, 0, "twelve"), at(13, 0, 0, "thirteen") ];
    const kept = await windowed(records, { since: epoch(11, 0, 0), until: epoch(12, 0, 0) });

    assert.deepEqual(kept, [ "eleven", "twelve" ], "both boundary records are inclusive; outside records are dropped");
  });
});

describe("timeWindow - carry-forward", () => {

  test("a continuation line is kept with an in-window parent and dropped with an out-of-window parent", async () => {

    // `a` (10:00) is before the window and dropped; its continuation inherits 10:00 and is dropped too. `b` (11:30) is in-window and kept; its continuation inherits
    // 11:30 and is kept. `c` (13:00) is after the window and dropped; its continuation inherits 13:00 and is dropped. This is the stack-trace-intact rule.
    const records = [

      at(10, 0, 0, "a"), continuation("a-cont"),
      at(11, 30, 0, "b"), continuation("b-cont"),
      at(13, 0, 0, "c"), continuation("c-cont")
    ];

    const kept = await windowed(records, { since: epoch(11, 0, 0), until: epoch(12, 0, 0) });

    assert.deepEqual(kept, [ "b", "b-cont" ], "a continuation is kept iff its parent timestamp is in-window");
  });

  test("a leading null-epoch line is excluded by a since bound but included by a pure until bound", async () => {

    // A line before ANY timestamp - a partial first line from the download, or a leading banner - has no placeable instant and is the oldest content in a chronological
    // stream. A lower `since` bound excludes it (it cannot be shown to be at or after `since`); a pure upper `until` bound includes it (it precedes everything).
    const records = [ continuation("preamble"), at(13, 0, 0, "later") ];

    assert.deepEqual(await windowed(records, { since: epoch(11, 0, 0), until: null }), ["later"], "a since bound excludes a pre-timestamp leading line");
    assert.deepEqual(await windowed(records, { since: null, until: epoch(14, 0, 0) }), [ "preamble", "later" ], "a pure until bound includes the leading line");
  });

  test("the carry updates on an out-of-window timestamp so a later continuation inherits correctly", async () => {

    // `early` (09:00) is dropped but still updates the carry; its continuation inherits 09:00 and is dropped. Then `mid` (11:30) updates the carry to an in-window
    // instant, so its continuation is kept. The carry must advance on EVERY real timestamp, not only on kept ones.
    const records = [ at(9, 0, 0, "early"), continuation("early-cont"), at(11, 30, 0, "mid"), continuation("mid-cont") ];
    const kept = await windowed(records, { since: epoch(11, 0, 0), until: epoch(12, 0, 0) });

    assert.deepEqual(kept, [ "mid", "mid-cont" ], "the carry advances across skipped records so a later continuation inherits the nearest parent");
  });

  test("a null-timestamp gap marker inside the window is kept", async () => {

    // The stitch emits a null-timestamp gap marker for a discontinuity; arriving after an in-window timestamp it inherits that instant and must be shown - a window must
    // never hide a discontinuity marker.
    const records = [ at(11, 30, 0, "before"), continuation("--- gap ---"), at(11, 45, 0, "after") ];
    const kept = await windowed(records, { since: epoch(11, 0, 0), until: epoch(12, 0, 0) });

    assert.deepEqual(kept, [ "before", "--- gap ---", "after" ], "a gap marker inherits the prior in-window instant and is shown");
  });
});

describe("timeWindow - ordering", () => {

  test("kept records preserve arrival order", async () => {

    const records = [ at(11, 5, 0, "first"), at(11, 10, 0, "second"), at(11, 15, 0, "third") ];
    const kept = await windowed(records, { since: epoch(11, 0, 0), until: epoch(12, 0, 0) });

    assert.deepEqual(kept, [ "first", "second", "third" ], "the transform yields kept records in source arrival order");
  });
});
