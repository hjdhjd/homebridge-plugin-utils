/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/time-window.ts: Internal async-generator transform that filters a record stream to an inclusive epoch window with carry-forward.
 */

/**
 * The internal time-window stream transform for the `hblog` CLI.
 *
 * {@link timeWindow} wraps a record stream and yields only the records whose instant falls inside an inclusive `[since, until]` epoch window, parsing each record's
 * timestamp on demand via {@link parseLogTimestamp}. It is deliberately NOT shaped like `createLogFilter` (a reusable `(record) => boolean` predicate) and is NOT part of
 * the package barrel: it carries per-stream state (the carry-forward instant), so a single async-generator transform - fresh state per call, structurally single-use -
 * makes cross-stream reuse with stale state unrepresentable, whereas a reused predicate would be wrong on a second stream.
 *
 * The carry-forward is the detail that matters. A record with no parseable instant (a `null` timestamp, or text in an unrecognized locale) is a continuation line of a
 * multi-line message (a stack trace whose only first line carries `[timestamp]`), a bare status line, or a parse failure. A naive "is this record's own epoch in range"
 * test would shred every stack trace - the first line in, the traceback gone. Instead a null-epoch line inherits the instant of the most recent record that DID parse, so
 * a continuation is kept iff its parent is. This is a log-semantics rule intrinsic to "filter records by time correctly," so it lives in this primitive. The generator
 * necessarily processes records in arrival order, and every channel yields in order (history is file order, live is arrival order, the stitch preserves order), so the
 * carry-forward is sound; the stitch's null-timestamp gap marker inherits and shows, because a window must never hide a discontinuity marker.
 *
 * @module
 */
import type { LogRecord } from "./types.ts";
import type { Nullable } from "../util.ts";
import { parseLogTimestamp } from "./parser.ts";

/**
 * Filter a record stream to an inclusive `[since, until]` epoch window, with carry-forward for records that carry no parseable instant.
 *
 * For each source record: derive its epoch on demand from its timestamp text; update the carried instant whenever a record DID parse (so a later continuation inherits
 * the correct parent even across a skipped region); judge the record by its own epoch when it has one, otherwise by the carried instant. A record that arrives before ANY
 * timestamp has been seen is treated as the oldest possible instant: a `since` lower bound excludes it, a pure `until` upper bound includes it. Both bounds are
 * inclusive, and a `null` bound is unbounded on that side.
 *
 * @param source - The upstream record stream (a channel's `LogStream`, or any async iterable of records in arrival order).
 * @param bounds - The window bounds in epoch milliseconds. `since` is the inclusive lower bound (`null` for unbounded-below); `until` is the inclusive upper bound
 *                 (`null` for unbounded-above).
 *
 * @returns An async generator yielding only the records inside the window, in arrival order.
 */
export async function *timeWindow(source: AsyncIterable<LogRecord>, bounds: { since: Nullable<number>; until: Nullable<number> }): AsyncGenerator<LogRecord> {

  const { since, until } = bounds;

  // The carried epoch of the most recent record that parsed to an instant. A null-epoch line inherits this so it is kept iff its parent is.
  let carried: Nullable<number> = null;

  for await (const record of source) {

    // Derive the epoch on demand; a null timestamp (or an unrecognized format) yields null and the record falls back to the carried parent instant.
    const epoch = (record.timestamp !== null) ? parseLogTimestamp(record.timestamp) : null;

    // Update the carry on EVERY real timestamp, in-window or not, so a later continuation inherits the correct parent instant even across a region the window skips.
    if(epoch !== null) {

      carried = epoch;
    }

    // The instant this record is judged by: its own epoch when it has one, otherwise the carried parent instant.
    const effective = epoch ?? carried;

    // A null effective instant means a null-epoch line arrived before ANY timestamp has been seen - a partial first line from the download, or a leading banner - so it
    // has no placeable instant. We treat it as the oldest possible moment: a lower `since` bound excludes it (a leading orphan cannot be shown to be at or after `since`,
    // and it is the oldest content in a chronological stream), while a pure upper `until` bound includes it (it precedes everything, so it is within "up to `until`").
    if(effective === null) {

      if(since !== null) {

        continue;
      }

      yield record;

      continue;
    }

    // Apply the inclusive bounds. A record before `since` or after `until` is skipped; everything else is admitted.
    if((since !== null) && (effective < since)) {

      continue;
    }

    if((until !== null) && (effective > until)) {

      continue;
    }

    yield record;
  }
}
