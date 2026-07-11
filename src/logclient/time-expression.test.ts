/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/time-expression.test.ts: Unit tests for parseTimeExpression - the named/relative/date/clock grammar arms and their interval edges.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseTimeExpression } from "./time-expression.ts";

// Millisecond magnitudes, mirrored from the module under test so the expected interval edges read by intent. A point span collapses to a single instant; the closed
// interval's `end` is `start + spanMs - 1`.
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

// A fixed reference instant for every test: 2026-06-29 15:30:45 local. Built via `new Date(...)` so the epoch is the host's own local time, which keeps every assertion
// timezone-independent (both the expectation and the parser construct local instants).
const NOW = new Date(2026, 5, 29, 15, 30, 45, 0).getTime();

describe("parseTimeExpression - named tokens", () => {

  test("now resolves to a point interval at now", () => {

    assert.deepEqual(parseTimeExpression("now", NOW), { end: NOW, start: NOW });
  });

  test("today resolves to the whole local day from midnight", () => {

    const start = new Date(2026, 5, 29).getTime();

    assert.deepEqual(parseTimeExpression("today", NOW), { end: start + MS_PER_DAY - 1, start });
  });

  test("yesterday resolves to the whole prior local day", () => {

    const start = new Date(2026, 5, 28).getTime();

    assert.deepEqual(parseTimeExpression("yesterday", NOW), { end: start + MS_PER_DAY - 1, start });
  });

  test("named tokens are case-insensitive", () => {

    assert.deepEqual(parseTimeExpression("NOW", NOW), { end: NOW, start: NOW });
    assert.deepEqual(parseTimeExpression("Today", NOW), parseTimeExpression("today", NOW));
  });
});

describe("parseTimeExpression - relative ages", () => {

  test("each unit subtracts its magnitude from now as a point interval", () => {

    const cases: readonly (readonly [ string, number ])[] = [

      [ "1d", MS_PER_DAY ],
      [ "2h", 2 * MS_PER_HOUR ],
      [ "30m", 30 * MS_PER_MINUTE ],
      [ "90s", 90 * MS_PER_SECOND ]
    ];

    for(const [ expr, offsetMs ] of cases) {

      const start = NOW - offsetMs;

      assert.deepEqual(parseTimeExpression(expr, NOW), { end: start, start }, expr + " must resolve to now minus its magnitude");
    }
  });

  test("a multi-segment relative expression sums its segments", () => {

    const start = NOW - ((2 * MS_PER_HOUR) + (30 * MS_PER_MINUTE));

    assert.deepEqual(parseTimeExpression("2h30m", NOW), { end: start, start });
  });

  test("a bare unit-less integer does not match", () => {

    assert.equal(parseTimeExpression("5", NOW), null);
  });
});

describe("parseTimeExpression - dates", () => {

  test("a date-only expression spans the whole LOCAL day", () => {

    // Local midnight, not UTC: a naive `new Date("2026-06-29")` would be UTC midnight and skew the window by the local offset. The expected start is built locally.
    const start = new Date(2026, 5, 29).getTime();

    assert.deepEqual(parseTimeExpression("2026-06-29", NOW), { end: start + MS_PER_DAY - 1, start });
  });

  test("a date with a bare HH:mm clock is minute-precise", () => {

    const start = new Date(2026, 5, 29, 6, 0, 0).getTime();

    assert.deepEqual(parseTimeExpression("2026-06-29T06:00", NOW), { end: start + MS_PER_MINUTE - 1, start });
  });

  test("a date with an HH:mm:ss clock is second-precise", () => {

    const start = new Date(2026, 5, 29, 6, 0, 0).getTime();

    assert.deepEqual(parseTimeExpression("2026-06-29 06:00:00", NOW), { end: start + MS_PER_SECOND - 1, start });
  });

  test("a date with a 12-hour clock is second-precise", () => {

    const start = new Date(2026, 5, 29, 6, 0, 0).getTime();

    assert.deepEqual(parseTimeExpression("2026-06-29 6am", NOW), { end: start + MS_PER_SECOND - 1, start });
  });

  test("a well-formed but impossible date returns null", () => {

    assert.equal(parseTimeExpression("2026-02-30", NOW), null);
  });

  test("a date with an out-of-range trailing clock returns null", () => {

    // The date matches but the trailing clock fails the range check, so the whole expression is unrecognized.
    assert.equal(parseTimeExpression("2026-06-29 25:00", NOW), null);
  });
});

describe("parseTimeExpression - clocks on now's date", () => {

  test("a clock resolves to now's local date at that time with a second span", () => {

    const start = new Date(2026, 5, 29, 7, 0, 0).getTime();

    assert.deepEqual(parseTimeExpression("7am", NOW), { end: start + MS_PER_SECOND - 1, start });
  });

  test("a bare 24-hour clock resolves on now's date with a minute span", () => {

    // A bare `HH:mm` is minute-precise wherever it appears, so a standalone `14:30` covers its whole minute exactly as `2026-06-29 14:30` does (the date-plus-clock arm).
    const start = new Date(2026, 5, 29, 14, 30, 0).getTime();

    assert.deepEqual(parseTimeExpression("14:30", NOW), { end: start + MS_PER_MINUTE - 1, start });
  });

  test("a standalone clock with explicit seconds is second-precise", () => {

    const start = new Date(2026, 5, 29, 14, 30, 15).getTime();

    assert.deepEqual(parseTimeExpression("14:30:15", NOW), { end: start + MS_PER_SECOND - 1, start });
  });

  test("a future clock is not rolled back to yesterday", () => {

    // NOW is 15:30; `7am` resolves to TODAY 07:00 (in the past relative to now here), but the point is that the arm always uses now's date - a clock later than now (e.g.
    // 11pm) still lands on today, never tomorrow or yesterday.
    const start = new Date(2026, 5, 29, 23, 0, 0).getTime();

    assert.deepEqual(parseTimeExpression("11pm", NOW), { end: start + MS_PER_SECOND - 1, start });
  });

  test("a clock that passes the regex but is out of range returns null", () => {

    // These are distinct from a regex-no-match null: the text IS a clock shape, but the component is out of range, so normalizeClock rejects it.
    assert.equal(parseTimeExpression("25:00", NOW), null, "hour 25 is out of the 24-hour range");
    assert.equal(parseTimeExpression("13am", NOW), null, "hour 13 with a meridiem is out of the 12-hour range");
  });
});

describe("parseTimeExpression - unrecognized input", () => {

  test("gibberish and empty input return null", () => {

    assert.equal(parseTimeExpression("xyz", NOW), null);
    assert.equal(parseTimeExpression("", NOW), null);
    assert.equal(parseTimeExpression("   ", NOW), null);
  });
});
