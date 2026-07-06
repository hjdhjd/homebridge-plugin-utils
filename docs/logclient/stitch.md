[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/stitch

# logclient/stitch

Pure join of a REST history tail with a socket-seeded live buffer.

The `follow-history` mode pulls two views of the same log: the REST whole-file download (history, exact but a one-time snapshot) and the socket's live stream, which
begins with a ~500-line seed that overlaps the END of the history and then continues with genuinely new lines. [stitchLive](#stitchlive) joins them at their overlap so the
output reads as one continuous log: all of history, then exactly the live lines that history did not already contain.

The join's correctness guarantee is asymmetric and deliberately so: it NEVER drops a distinct live line, at the cost of possibly emitting a bounded run of duplicate
lines at the seam. The hazard is repeated/identical lines - when several adjacent lines share the same text, the longest suffix-equals-prefix match could pair a
history line with a live line that is actually a new occurrence and silently swallow it. To avoid that, the join chooses the MINIMAL overlap among the valid matches
(keeping the most live content), accepting bounded duplicate chatter rather than risking silent loss. Equality is by normalized [LogRecord.raw](types.md#raw). When no overlap
is found at all, a single visible [gapMarker](#gapmarker) record is emitted between history and live so the boundary discontinuity is never hidden.

## Log Client

### StitchOptions

Options for [stitchLive](#stitchlive).

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="maxoverlap"></a> `maxOverlap?` | `readonly` | `number` | The maximum number of trailing-history / leading-live records to consider when searching for the overlap, bounding the search to the seed window. Defaults to the full length of the shorter side. Capping this keeps the join's cost proportional to the seed size rather than to the (potentially multi-MB) history. |

***

### gapMarker()

```ts
function gapMarker(): LogRecord;
```

Build the gap-marker record emitted between history and live when no overlap can be found.

The marker is a real [LogRecord](types.md#logrecord) (not a side channel) so it flows through the same iteration, filtering, and formatting as any other line - a consumer never has
to special-case it, and it is plainly visible in every output mode. Its `level` is `null` (it is not a severity-bearing line), its `plugin`/`timestamp` are `null`,
and its `message`/`raw` carry the human-readable discontinuity notice.

#### Returns

[`LogRecord`](types.md#logrecord)

A fresh gap-marker [LogRecord](types.md#logrecord).

***

### mergeHistoryThenLive()

```ts
function mergeHistoryThenLive(
   history, 
   live, 
   options?): LogRecord[];
```

Thin coordinator that joins an already-collected history tail and live buffer via [stitchLive](#stitchlive).

This is the composition seam the client uses for `follow-history`: it takes the already-materialized history tail and the already-buffered seed-plus-live records and
defers entirely to [stitchLive](#stitchlive) for the join policy. It exists so callers have one named entry point for "merge history then live" rather than re-deriving the
call, and so the join policy lives in exactly one place. It performs no I/O of its own - the caller is responsible for having collected both sides (the socket seeds
into a bounded ring and the REST download streams into records before this is called).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `history` | readonly [`LogRecord`](types.md#logrecord)[] | The trailing history records, oldest first. |
| `live` | readonly [`LogRecord`](types.md#logrecord)[] | The seed-plus-live records, oldest first. |
| `options` | [`StitchOptions`](#stitchoptions) | Optional bounds forwarded to [stitchLive](#stitchlive). |

#### Returns

[`LogRecord`](types.md#logrecord)[]

The joined record list.

***

### stitchLive()

```ts
function stitchLive(
   history, 
   live, 
   options?): LogRecord[];
```

Join a history tail and a live buffer at their overlap.

Searches for valid overlap lengths `k` (where history's last `k` records equal live's first `k` records, by normalized `raw`) within the bounded window, then:

- If the MAXIMAL valid overlap covers all of `live`, every live line is already in history (total overlap): the result is `history` unchanged.
- Otherwise, if any overlap is valid, the join uses the MINIMAL valid overlap and returns `history` followed by `live` from that offset, so every distinct live line
  survives even when repeated lines make a longer match look valid.
- If no head overlap is valid but history's tail appears as a contiguous block somewhere inside `live` (the within-buffer case, e.g. a small `-n N` whose live seed
  reaches further back than the requested window), the join locates that block and continues past it - returning `history` followed by `live` from that point, dropping
  the older seed prefix that predates the window.
- If neither a head overlap nor a within-buffer alignment is found, the result is `history`, a single [gapMarker](#gapmarker), then all of `live`, so the discontinuity is
  visible and no live line is dropped.

Either input being empty short-circuits: an empty `live` returns `history`, and an empty `history` returns `live` (nothing to align against, no marker needed).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `history` | readonly [`LogRecord`](types.md#logrecord)[] | The trailing history records, in chronological order (oldest first). |
| `live` | readonly [`LogRecord`](types.md#logrecord)[] | The seed-plus-live records, in chronological order (oldest first); its leading records are the seed that overlaps history's tail. |
| `options` | [`StitchOptions`](#stitchoptions) | Optional bounds. See [StitchOptions](#stitchoptions). |

#### Returns

[`LogRecord`](types.md#logrecord)[]

The joined record list.
