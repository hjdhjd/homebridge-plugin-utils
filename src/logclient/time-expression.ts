/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/time-expression.ts: Pure CLI-layer parser turning a `--since`/`--until` time expression into an absolute epoch interval.
 */

/**
 * Pure, CLI-layer parsing of the `hblog` `--since`/`--until` time expressions into an absolute epoch interval.
 *
 * {@link parseTimeExpression} turns a user-typed expression (`1d`, `7am`, `2026-06-29`, `"2026-06-29 6am"`, `now`/`today`/`yesterday`) into the `{ start, end }` interval
 * the precision of the expression names. The lower edge (`start`) is what `--since` binds to and the upper edge (`end`) is what `--until` binds to, which is the whole
 * point of returning an INTERVAL rather than a single instant: a date-only `--until 2026-06-29` then includes the entire named day (its `end` is the last millisecond of
 * that day), while `--since 2026-06-29` starts at midnight (its `start`).
 *
 * The module lives at the CLI layer, exactly like `config.ts`: it is isolated, unit-tested against an injected `now`, and NOT part of the package barrel. It takes the
 * resolved `now` (epoch milliseconds) as an argument rather than reading the clock itself, so resolution is deterministic under test. It is Node-native and depends on no
 * date library (a house rule); the only shared dependency is {@link normalizeClock} in `parser.ts`, which owns the 12-hour-to-24-hour clock rule so this module does not
 * re-implement it. DST-gap instants are best-effort, in the same spirit as `parseLogTimestamp`.
 *
 * @module
 */
import type { Nullable } from "../util.ts";
import { normalizeClock } from "./parser.ts";

// The millisecond magnitudes the relative-expression units and the precision spans are built from, named so the arithmetic reads by intent rather than by magic number.
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

// The per-unit millisecond multipliers for a relative ("ago") expression's `<int><unit>` segments. Frozen so the shared module-scope table cannot be mutated by a
// consumer, mirroring the parser's SGR map.
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({ d: MS_PER_DAY, h: MS_PER_HOUR, m: MS_PER_MINUTE, s: MS_PER_SECOND });

// A relative ("ago") expression is one-or-more `<int><unit>` segments and nothing else: `1d`, `2h30m`, `90s`. The full-string anchor rejects a bare unit-less integer
// (`5`) and any stray character, so a relative expression is never confused with a clock or a date. The segment pattern walks each segment to sum the offset.
const RELATIVE_PATTERN = /^(?:\d+[dhms])+$/i;
const RELATIVE_SEGMENT_PATTERN = /(\d+)([dhms])/gi;

// A `YYYY-MM-DD` date, optionally followed by a `T` or a space and a clock the {@link parseClock} helper interprets. Two-digit month/day, four-digit year. The trailing
// capture is the clock text when present.
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/;

// A 24-hour clock `HH:mm[:ss]` (`14:30`, `7:00:00`); the seconds group is optional. When seconds are absent the reading is minute-precise, when present second-precise.
const CLOCK_24_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

// A 12-hour clock `h[:mm[:ss]]am|pm` (`7am`, `2pm`, `6:30am`). The meridiem is mandatory and an unspecified minute/second defaults to 0; a meridiem-bearing reading is
// second-precise.
const CLOCK_12_PATTERN = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*([AaPp][Mm])$/;

// Build the `{ start, end }` interval an expression denotes from its lower instant and its precision span. The interval is closed and inclusive on both ends: `end` is
// the last millisecond the precision covers (`start + spanMs - 1`), so a one-day span ends one millisecond before the next day's midnight, and a one-second span ends at
// `.999`. A point span (`1`) collapses the interval to a single instant (`end === start`).
function interval(start: number, spanMs: number): { end: number; start: number } {

  return { end: start + spanMs - 1, start };
}

// Compute local midnight of the calendar day `offsetDays` away from the day containing `now`. We read `now`'s LOCAL year/month/day and reconstruct midnight via the Date
// constructor, passing the offset through the day argument so the constructor normalizes a month/year rollover (day 0 is the prior month's last day). This is local,
// never UTC, so `today`/`yesterday` align with the host's own wall clock.
function startOfLocalDay(now: number, offsetDays: number): number {

  const reference = new Date(now);

  return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + offsetDays).getTime();
}

// Construct a LOCAL instant from explicit calendar and clock components, or `null` when the calendar names an impossible date. The calendar fields are round-tripped (the
// same guard as {@link parseLogTimestamp}) so `2026-02-30` is rejected rather than rolled into March; only the calendar is checked, so a DST-gap wall clock is
// best-effort accepted. `month` is 1-based here (the caller passes the human month), matching the regex captures.
function localInstant(year: number, month: number, day: number, hour: number, minute: number, second: number): Nullable<number> {

  const date = new Date(year, month - 1, day, hour, minute, second);

  if((date.getFullYear() !== year) || (date.getMonth() !== (month - 1)) || (date.getDate() !== day)) {

    return null;
  }

  return date.getTime();
}

// Parse a standalone clock string into its normalized 24-hour components plus the precision span the clock's own form implies. A bare `HH:mm` is minute-precise; any form
// carrying seconds, or any 12-hour (meridiem) form, is second-precise. The 12-hour-to-24-hour conversion and the range check are delegated to the shared
// `normalizeClock`, so this helper never re-implements the meridiem rule. Returns `null` when the text is not a clock or when a component is out of range.
function parseClock(text: string): Nullable<{ hour: number; minute: number; second: number; spanMs: number }> {

  // 24-hour `HH:mm[:ss]`. The seconds group decides the precision: absent is minute-precise, present is second-precise.
  const military = CLOCK_24_PATTERN.exec(text);

  if(military !== null) {

    const clock = normalizeClock({ hour: Number.parseInt(military[1] ?? "", 10), minute: Number.parseInt(military[2] ?? "", 10),
      second: (military[3] !== undefined) ? Number.parseInt(military[3], 10) : 0 });

    if(clock === null) {

      return null;
    }

    return { hour: clock.hour, minute: clock.minute, second: clock.second, spanMs: (military[3] !== undefined) ? MS_PER_SECOND : MS_PER_MINUTE };
  }

  // 12-hour `h[:mm[:ss]]am|pm`. A meridiem is always present, so the reading is second-precise; an unspecified minute/second defaults to 0.
  const meridian = CLOCK_12_PATTERN.exec(text);

  if(meridian !== null) {

    const clock = normalizeClock({ hour: Number.parseInt(meridian[1] ?? "", 10), meridiem: meridian[4],
      minute: (meridian[2] !== undefined) ? Number.parseInt(meridian[2], 10) : 0, second: (meridian[3] !== undefined) ? Number.parseInt(meridian[3], 10) : 0 });

    if(clock === null) {

      return null;
    }

    return { hour: clock.hour, minute: clock.minute, second: clock.second, spanMs: MS_PER_SECOND };
  }

  return null;
}

// Arm 1: a named token. `now` is a point, `today` is the whole local calendar day, and `yesterday` is the whole prior local day. Matched case-insensitively. Returns
// `null` for any other text so the chain falls through to the next arm.
function parseNamed(text: string, now: number): Nullable<{ end: number; start: number }> {

  switch(text.toLowerCase()) {

    case "now": {

      return interval(now, 1);
    }

    case "today": {

      return interval(startOfLocalDay(now, 0), MS_PER_DAY);
    }

    case "yesterday": {

      return interval(startOfLocalDay(now, -1), MS_PER_DAY);
    }

    default: {

      return null;
    }
  }
}

// Arm 2: a relative ("ago") expression - one-or-more `<int><unit>` segments summed into an offset subtracted from `now`. The result is a point instant. Returns `null`
// when the text is not a well-formed relative expression (a bare unit-less integer does not match), so the chain falls through.
function parseRelative(text: string, now: number): Nullable<{ end: number; start: number }> {

  if(!RELATIVE_PATTERN.test(text)) {

    return null;
  }

  // Sum every `<int><unit>` segment. The full-string guard above guarantees the string is one-or-more well-formed segments and nothing else, so the scan below cannot
  // meet a stray character; each unit is one of d/h/m/s and so is always present in the frozen multiplier table.
  let offsetMs = 0;

  // Reset the shared global regex's cursor to the scan start. `RELATIVE_SEGMENT_PATTERN` carries the `g` flag so its `lastIndex` persists across calls; rewinding it here
  // keeps the module-scope regex stateless across `parseRelative` invocations.
  RELATIVE_SEGMENT_PATTERN.lastIndex = 0;

  for(let match = RELATIVE_SEGMENT_PATTERN.exec(text); match !== null; match = RELATIVE_SEGMENT_PATTERN.exec(text)) {

    const amount = Number.parseInt(match[1] ?? "", 10);
    const unit = (match[2] ?? "").toLowerCase();

    offsetMs += amount * (UNIT_MS[unit] ?? 0);
  }

  return interval(now - offsetMs, 1);
}

// Arm 3: a `YYYY-MM-DD` date with an optional clock. A date alone spans the whole local day; a date with a clock takes the clock's own precision (minute for a bare
// `HH:mm`, second otherwise). Always LOCAL, never `new Date("2026-06-29")` (which is UTC midnight by spec and would skew the window by the local offset). Returns `null`
// when the text is not a date, when the date is impossible, or when the trailing clock is unparseable.
function parseDateExpression(text: string): Nullable<{ end: number; start: number }> {

  const match = DATE_PATTERN.exec(text);

  if(match === null) {

    return null;
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const clockText = match[4];

  // Date only: the whole local calendar day, from local midnight, a day span.
  if(clockText === undefined) {

    const start = localInstant(year, month, day, 0, 0, 0);

    return (start === null) ? null : interval(start, MS_PER_DAY);
  }

  // Date plus a clock: apply the clock to the named calendar day at the clock's own precision.
  const clock = parseClock(clockText);

  if(clock === null) {

    return null;
  }

  const start = localInstant(year, month, day, clock.hour, clock.minute, clock.second);

  return (start === null) ? null : interval(start, clock.spanMs);
}

// Arm 4: a standalone clock applied to NOW's local calendar date, at the clock's OWN form-determined precision - the same span arm 3 uses for a date-plus-clock - so a
// bare 24-hour `14:30` covers its whole minute exactly as `2026-06-29 14:30`, while a meridiem time (`7am`) or an explicit-seconds time pins an exact second. A clock
// in the future relative to `now` is NOT rolled back to yesterday: if it is 3am and the user types `--since 7am`, the window starts at today 07:00 (an empty result until
// 7am), matching journalctl. Returns `null` when the text is not a clock.
function parseClockToday(text: string, now: number): Nullable<{ end: number; start: number }> {

  const clock = parseClock(text);

  if(clock === null) {

    return null;
  }

  const reference = new Date(now);
  const start = localInstant(reference.getFullYear(), reference.getMonth() + 1, reference.getDate(), clock.hour, clock.minute, clock.second);

  return (start === null) ? null : interval(start, clock.spanMs);
}

/**
 * Parse a `--since`/`--until` time expression into the absolute epoch interval it denotes, resolved against the injected `now`.
 *
 * The expression is matched in precedence order, first match wins (named tokens and the meridiem are case-insensitive):
 *
 * 1. A named token - `now` (a point), `today` (the whole local day), `yesterday` (the whole prior local day).
 * 2. A relative age - one-or-more `<int><unit>` segments (`1d`, `2h`, `30m`, `90s`, `2h30m`), as `now - sum`; a bare unit-less integer does not match.
 * 3. A `YYYY-MM-DD` date with an optional clock (`2026-06-29`, `2026-06-29T06:00`, `2026-06-29 06:00:00`, `"2026-06-29 6am"`); date-only spans the whole local day.
 * 4. A standalone clock applied to NOW's local date (`7am`, `2pm`, `14:30`, `7:00:00`); a future clock is not rolled back, matching journalctl.
 *
 * The returned interval's lower edge (`start`) is what `--since` binds to and its upper edge (`end`) is what `--until` binds to, so the precision of the expression
 * decides how much of a named day or second a bound covers. Returns `null` for any unrecognized or out-of-range input; the CLI maps `null` to a usage error listing the
 * accepted forms.
 *
 * @param expr - The user-typed time expression.
 * @param now  - The reference instant in epoch milliseconds, against which named, relative, and clock-today expressions resolve.
 *
 * @returns The `{ start, end }` epoch-millisecond interval the expression denotes, or `null` when the expression is not recognized.
 *
 * @category Log Client
 */
export function parseTimeExpression(expr: string, now: number): Nullable<{ end: number; start: number }> {

  // Normalize surrounding whitespace once; an empty expression matches nothing.
  const text = expr.trim();

  if(text.length === 0) {

    return null;
  }

  // Resolve in precedence order, first match wins. Each arm returns `null` when it does not apply, so the `??` chain falls through to the next arm and finally to a
  // `null` "unrecognized expression" result the CLI maps to a usage error.
  return parseNamed(text, now) ?? parseRelative(text, now) ?? parseDateExpression(text) ?? parseClockToday(text, now);
}
