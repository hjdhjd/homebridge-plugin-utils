/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/stitch.ts: Pure history-plus-live join for the follow-history mode.
 */

/**
 * Pure join of a REST history tail with a socket-seeded live buffer.
 *
 * The `follow-history` mode pulls two views of the same log: the REST whole-file download (history, exact but a one-time snapshot) and the socket's live stream, which
 * begins with a ~500-line seed that overlaps the END of the history and then continues with genuinely new lines. {@link stitchLive} joins them at their overlap so the
 * output reads as one continuous log: all of history, then exactly the live lines that history did not already contain.
 *
 * The join's correctness guarantee is asymmetric and deliberately so: it NEVER drops a distinct live line, at the cost of possibly emitting a bounded run of duplicate
 * lines at the seam. The hazard is repeated/identical lines - when several adjacent lines share the same text, the longest suffix-equals-prefix match could pair a
 * history line with a live line that is actually a new occurrence and silently swallow it. To avoid that, the join chooses the MINIMAL overlap among the valid matches
 * (keeping the most live content), accepting bounded duplicate chatter rather than risking silent loss. Equality is by normalized {@link LogRecord.raw}. When no overlap
 * is found at all, a single visible {@link gapMarker} record is emitted between history and live so the boundary discontinuity is never hidden.
 *
 * @module
 */
import type { LogRecord } from "./types.ts";
import type { Nullable } from "../util.ts";

// The sentinel text carried by the gap marker's `raw`/`message`. Distinct, unambiguous, and unlikely to collide with a real log line so a downstream consumer (or a
// human reading `--raw` output) can recognize the discontinuity. Lives here as the single source of truth for the marker wording.
const GAP_MARKER_TEXT = "--- log history and live stream could not be aligned; some lines may be missing or duplicated ---";

/**
 * Build the gap-marker record emitted between history and live when no overlap can be found.
 *
 * The marker is a real {@link LogRecord} (not a side channel) so it flows through the same iteration, filtering, and formatting as any other line - a consumer never has
 * to special-case it, and it is plainly visible in every output mode. Its `level` is `null` (it is not a severity-bearing line), its `plugin`/`timestamp` are `null`,
 * and its `message`/`raw` carry the human-readable discontinuity notice.
 *
 * @returns A fresh gap-marker {@link LogRecord}.
 *
 * @category Log Client
 */
export function gapMarker(): LogRecord {

  return { level: null, message: GAP_MARKER_TEXT, plugin: null, raw: GAP_MARKER_TEXT, timestamp: null };
}

/**
 * Options for {@link stitchLive}.
 *
 * @property maxOverlap - The maximum number of trailing-history / leading-live records to consider when searching for the overlap, bounding the search to the seed
 *                        window. Defaults to the full length of the shorter side. Capping this keeps the join's cost proportional to the seed size rather than to the
 *                        (potentially multi-MB) history.
 *
 * @category Log Client
 */
export interface StitchOptions {

  readonly maxOverlap?: number;
}

// Test whether the last `k` records of `history` equal the first `k` records of `live`, comparing by normalized `raw`. This is the overlap predicate the join searches
// over; it walks both windows forward from their respective anchor points (history's trailing-window start, live's head) so the comparison aligns the seam correctly.
function overlapsAt(history: readonly LogRecord[], live: readonly LogRecord[], k: number): boolean {

  const base = history.length - k;

  for(let index = 0; index < k; index++) {

    // `history[base + index]` walks forward from the start of history's trailing window; `live[index]` walks forward from the start of live. A single mismatch disproves
    // this overlap length. The `noUncheckedIndexedAccess`-safe reads use optional chaining on `raw`; out-of-range would yield `undefined` on both sides, but `k` is
    // always within bounds here by construction (`1 <= k <= min(history.length, live.length)`).
    if(history[base + index]?.raw !== live[index]?.raw) {

      return false;
    }
  }

  return true;
}

// Find the leftmost end-index in `live` at which history's last `k` records occur as a contiguous block (compared by normalized `raw`), or -1 when no such block exists.
// This is the within-buffer counterpart to {@link overlapsAt}: where that anchors at live's HEAD, this locates history's tail ANYWHERE in live - which is what
// the small-`-n` case needs, where the seed reaches further back than the requested history window.
function alignedEnd(history: readonly LogRecord[], live: readonly LogRecord[], k: number): number {

  const tail = history.slice(history.length - k);

  for(let end = k - 1; end < live.length; end++) {

    const start = end - k + 1;

    if(tail.every((record, index) => record.raw === live[start + index]?.raw)) {

      return end;
    }
  }

  return -1;
}

// Locate history WITHIN the live buffer when it does not overlap live's head. Find the LONGEST suffix of history present as a contiguous block in live (longest is the
// most confident anchor against repeats), take its leftmost occurrence (keeping the most live), and return history then the live lines after that block - so the seed
// lines that predate the requested window are dropped while no genuinely new line is lost. Returns null when no suffix of history appears in live.
function stitchWithin(history: readonly LogRecord[], live: readonly LogRecord[], bound: number): Nullable<LogRecord[]> {

  for(let k = Math.min(history.length, bound); k >= 1; k--) {

    const end = alignedEnd(history, live, k);

    if(end !== -1) {

      return [ ...history, ...live.slice(end + 1) ];
    }
  }

  return null;
}

/**
 * Join a history tail and a live buffer at their overlap.
 *
 * Searches for valid overlap lengths `k` (where history's last `k` records equal live's first `k` records, by normalized `raw`) within the bounded window, then:
 *
 * - If the MAXIMAL valid overlap covers all of `live`, every live line is already in history (total overlap): the result is `history` unchanged.
 * - Otherwise, if any overlap is valid, the join uses the MINIMAL valid overlap and returns `history` followed by `live` from that offset, so every distinct live line
 *   survives even when repeated lines make a longer match look valid.
 * - If no head overlap is valid but history's tail appears as a contiguous block somewhere inside `live` (the within-buffer case, e.g. a small `-n N` whose live seed
 *   reaches further back than the requested window), the join locates that block and continues past it - returning `history` followed by `live` from that point, dropping
 *   the older seed prefix that predates the window.
 * - If neither a head overlap nor a within-buffer alignment is found, the result is `history`, a single {@link gapMarker}, then all of `live`, so the discontinuity is
 *   visible and no live line is dropped.
 *
 * Either input being empty short-circuits: an empty `live` returns `history`, and an empty `history` returns `live` (nothing to align against, no marker needed).
 *
 * @param history - The trailing history records, in chronological order (oldest first).
 * @param live    - The seed-plus-live records, in chronological order (oldest first); its leading records are the seed that overlaps history's tail.
 * @param options - Optional bounds. See {@link StitchOptions}.
 *
 * @returns The joined record list.
 *
 * @category Log Client
 */
export function stitchLive(history: readonly LogRecord[], live: readonly LogRecord[], options: StitchOptions = {}): LogRecord[] {

  // Empty-input short-circuits: with nothing on one side there is no seam to align, so we pass the other side through unchanged and emit no marker.
  if(live.length === 0) {

    return [...history];
  }

  if(history.length === 0) {

    return [...live];
  }

  // Bound the search to the seed window: never consider an overlap longer than the shorter side, and honor an explicit `maxOverlap` cap so the cost is proportional to
  // the seed rather than to the full history.
  const naturalBound = Math.min(history.length, live.length);
  const bound = (options.maxOverlap !== undefined) ? Math.min(naturalBound, Math.max(0, options.maxOverlap)) : naturalBound;

  // Single pass over candidate overlap lengths, capturing both the minimal and maximal valid `k`. Minimal drives the join (keep the most live content -> never drop a
  // distinct line); maximal drives the total-overlap test (all of live already present -> no new lines).
  let minK = 0;
  let maxK = 0;

  for(let k = 1; k <= bound; k++) {

    if(overlapsAt(history, live, k)) {

      if(minK === 0) {

        minK = k;
      }

      maxK = k;
    }
  }

  // Total overlap: the longest valid match consumes all of live, so there are no new live lines yet. Return history unchanged - no duplicates, no marker.
  if(maxK === live.length) {

    return [...history];
  }

  // Partial head overlap (the common case - history is a superset of the seed, e.g. `--all -f` or a large `-n`): join at the minimal valid offset, retaining every live
  // line from that point on. This is where bounded duplicate chatter may appear at the seam, in exchange for never dropping a distinct live line.
  if(minK > 0) {

    return [ ...history, ...live.slice(minK) ];
  }

  // No head overlap. This happens when the live seed reaches further back than the requested history window (a small `-n N`), so history sits WITHIN the live buffer
  // rather than overlapping its head. Locate history's tail as a contiguous block in live and continue past it, dropping the older seed lines that predate the window.
  const within = stitchWithin(history, live, bound);

  if(within !== null) {

    return within;
  }

  // Neither alignment held - history's tail appears nowhere in live: surface the discontinuity rather than hide it, and keep every live line.
  return [ ...history, gapMarker(), ...live ];
}

/**
 * Thin coordinator that joins an already-collected history tail and live buffer via {@link stitchLive}.
 *
 * This is the composition seam the client uses for `follow-history`: it takes the already-materialized history tail and the already-buffered seed-plus-live records and
 * defers entirely to {@link stitchLive} for the join policy. It exists so callers have one named entry point for "merge history then live" rather than re-deriving the
 * call, and so the join policy lives in exactly one place. It performs no I/O of its own - the caller is responsible for having collected both sides (the socket seeds
 * into a bounded ring and the REST download streams into records before this is called).
 *
 * @param history - The trailing history records, oldest first.
 * @param live    - The seed-plus-live records, oldest first.
 * @param options - Optional bounds forwarded to {@link stitchLive}.
 *
 * @returns The joined record list.
 *
 * @category Log Client
 */
export function mergeHistoryThenLive(history: readonly LogRecord[], live: readonly LogRecord[], options: StitchOptions = {}): LogRecord[] {

  return stitchLive(history, live, options);
}
