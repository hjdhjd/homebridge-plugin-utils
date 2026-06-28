/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/stitch.test.ts: Unit tests for the history-plus-live overlap join.
 */
import { describe, test } from "node:test";
import { gapMarker, mergeHistoryThenLive, stitchLive } from "./stitch.ts";
import type { LogRecord } from "./types.ts";
import assert from "node:assert/strict";

// Build a minimal LogRecord identified solely by its raw text. The join compares by normalized `raw`, so the other fields are immaterial here and are filled with
// inert defaults; using the raw text as the record's identity keeps the fixtures readable.
function line(raw: string): LogRecord {

  return { level: null, message: raw, plugin: null, raw, timestamp: null };
}

// Project a record list down to its raw texts so assertions read as plain string arrays rather than full-record deep equals.
function raws(records: readonly LogRecord[]): string[] {

  return records.map((entry) => entry.raw);
}

describe("stitchLive", () => {

  test("joins history and live at a clean single-line overlap", () => {

    const history = [ line("a"), line("b"), line("c") ];
    const live = [ line("c"), line("d"), line("e") ];

    // History's tail "c" overlaps live's head "c"; the result is history followed by the post-overlap live lines, with no duplicate and no gap.
    assert.deepEqual(raws(stitchLive(history, live)), [ "a", "b", "c", "d", "e" ]);
  });

  test("joins at a multi-line overlap", () => {

    const history = [ line("a"), line("b"), line("c"), line("d") ];
    const live = [ line("c"), line("d"), line("e"), line("f") ];

    assert.deepEqual(raws(stitchLive(history, live)), [ "a", "b", "c", "d", "e", "f" ]);
  });

  test("emits history unchanged when live is wholly contained in history (total overlap)", () => {

    const history = [ line("a"), line("b"), line("c") ];
    const live = [ line("b"), line("c") ];

    // Every live line is already present at history's tail; there are no new lines, so the result is exactly history - no duplicates, no marker.
    assert.deepEqual(raws(stitchLive(history, live)), [ "a", "b", "c" ]);
  });

  test("emits a visible gap marker when no overlap is found", () => {

    const history = [ line("a"), line("b") ];
    const live = [ line("x"), line("y") ];
    const result = stitchLive(history, live);

    // History, then the gap marker, then all of live - the discontinuity is surfaced and no live line is lost.
    assert.deepEqual(raws(result), [ "a", "b", gapMarker().raw, "x", "y" ]);
    assert.equal(result[2]?.raw, gapMarker().raw);
  });

  test("never drops a distinct live line inside a duplicate run, accepting a bounded duplicate", () => {

    // History ends with two identical "A" lines; live begins with three "A" lines where the third is a genuinely new occurrence, then "B". A maximal-overlap join would
    // pair both history "A"s with live's first two and silently swallow the third "A". The minimal-overlap rule keeps it: the join uses overlap length 1, so the output
    // retains the new "A" (a bounded duplicate) and the distinct "B" survives.
    const history = [ line("X"), line("A"), line("A") ];
    const live = [ line("A"), line("A"), line("A"), line("B") ];
    const result = raws(stitchLive(history, live));

    // No distinct line is dropped: "B" is present, and the count of "A" never falls below the live side's distinct count.
    assert.ok(result.includes("B"), "the distinct live line B must never be dropped");
    assert.deepEqual(result, [ "X", "A", "A", "A", "A", "B" ]);
  });

  test("joins when the live seed reaches before the history window (history within live)", () => {

    // The small `-n N` case: history is the recent window [a,b,c], but the socket seed reaches further back, so live = [older x,y] ++ [a,b,c overlap] ++ [d,e new]. The
    // head-anchored path finds nothing (live's head "x" predates the window), so the within-buffer path locates [a,b,c] inside live and continues past it: the older seed
    // lines are dropped, the overlap is not duplicated, and the new lines survive.
    const history = [ line("a"), line("b"), line("c") ];
    const live = [ line("x"), line("y"), line("a"), line("b"), line("c"), line("d"), line("e") ];

    assert.deepEqual(raws(stitchLive(history, live)), [ "a", "b", "c", "d", "e" ]);
  });

  test("bounds the considered overlap length to maxOverlap", () => {

    const history = [ line("a"), line("b"), line("c"), line("d") ];
    const live = [ line("c"), line("d"), line("e") ];

    // With the search capped at a single line, the two-line head overlap ("c","d") is out of bound, so the head-anchored path finds nothing within the cap. The
    // within-buffer fallback then locates history's single-line tail ("d") inside live and joins there - the bound limits how deep a match is considered, but a correct
    // join still results when an anchor exists within the cap.
    const result = raws(stitchLive(history, live, { maxOverlap: 1 }));

    assert.deepEqual(result, [ "a", "b", "c", "d", "e" ]);
  });

  test("returns history unchanged when live is empty", () => {

    const history = [ line("a"), line("b") ];

    assert.deepEqual(raws(stitchLive(history, [])), [ "a", "b" ]);
  });

  test("returns live unchanged when history is empty", () => {

    const live = [ line("x"), line("y") ];

    assert.deepEqual(raws(stitchLive([], live)), [ "x", "y" ]);
  });

  test("returns an empty list when both sides are empty", () => {

    assert.deepEqual(stitchLive([], []), []);
  });

  test("treats the full live buffer as overlap when it exactly equals history", () => {

    const history = [ line("a"), line("b") ];
    const live = [ line("a"), line("b") ];

    // Live equals history exactly: total overlap, so the result is history alone.
    assert.deepEqual(raws(stitchLive(history, live)), [ "a", "b" ]);
  });

  test("keeps a within-buffer recurrence of history's tail and the distinct new line that follows it", () => {

    // The within-buffer (Path B) join: history's head does not overlap live's head, so the join must locate history's tail [a,b,c] inside live and continue past it. Here
    // [a,b,c] recurs LATER in the live buffer ([a,b,c] then [a,b,c] again, then "d"), modeling a server that replayed the same window twice in its seed. The leftmost-
    // occurrence rule anchors on the first [a,b,c], so the second [a,b,c] is kept as a bounded duplicate and the distinct new line "d" survives - never dropping a
    // distinct new line is the join's hard guarantee, and the older seed prefix [o1,o2] that predates the window is dropped.
    const history = [ line("a"), line("b"), line("c") ];
    const live = [ line("o1"), line("o2"), line("a"), line("b"), line("c"), line("a"), line("b"), line("c"), line("d") ];

    assert.deepEqual(raws(stitchLive(history, live)), [ "a", "b", "c", "a", "b", "c", "d" ]);
  });
});

describe("mergeHistoryThenLive", () => {

  test("delegates to the same join policy as stitchLive", () => {

    const history = [ line("a"), line("b"), line("c") ];
    const live = [ line("c"), line("d") ];

    assert.deepEqual(raws(mergeHistoryThenLive(history, live)), raws(stitchLive(history, live)));
  });

  test("forwards the maxOverlap bound", () => {

    const history = [ line("a"), line("b"), line("c"), line("d") ];
    const live = [ line("c"), line("d"), line("e") ];

    assert.deepEqual(raws(mergeHistoryThenLive(history, live, { maxOverlap: 1 })), raws(stitchLive(history, live, { maxOverlap: 1 })));
  });
});

describe("gapMarker", () => {

  test("produces a fresh, null-field record carrying the discontinuity notice", () => {

    const marker = gapMarker();

    assert.equal(marker.level, null);
    assert.equal(marker.plugin, null);
    assert.equal(marker.timestamp, null);
    assert.equal(marker.message, marker.raw);
    assert.ok(marker.raw.length > 0);
  });
});
