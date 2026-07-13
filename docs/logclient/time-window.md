[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/time-window

# logclient/time-window

The internal time-window stream transform for the `hblog` CLI.

[timeWindow](#timewindow) wraps a record stream and yields only the records whose instant falls inside an inclusive `[since, until]` epoch window, parsing each record's
timestamp on demand via [parseLogTimestamp](parser.md#parselogtimestamp). It is deliberately NOT shaped like `createLogFilter` (a reusable `(record) => boolean` predicate) and is NOT part of
the package barrel: it carries per-stream state (the carry-forward instant), so a single async-generator transform - fresh state per call, structurally single-use -
makes cross-stream reuse with stale state unrepresentable, whereas a reused predicate would be wrong on a second stream.

The carry-forward is the detail that matters. A record with no parseable instant (a `null` timestamp, or text in an unrecognized locale) is a continuation line of a
multi-line message (a stack trace whose only first line carries `[timestamp]`), a bare status line, or a parse failure. A naive "is this record's own epoch in range"
test would shred every stack trace - the first line in, the traceback gone. Instead a null-epoch line inherits the instant of the most recent record that DID parse, so
a continuation is kept iff its parent is. This is a log-semantics rule intrinsic to "filter records by time correctly," so it lives in this primitive. The generator
necessarily processes records in arrival order, and every channel yields in order (history is file order, live is arrival order, the stitch preserves order), so the
carry-forward is sound; the stitch's null-timestamp gap marker inherits and shows, because a window must never hide a discontinuity marker.

## Functions

### timeWindow()

```ts
function timeWindow(source, bounds): AsyncGenerator<LogRecord>;
```

Filter a record stream to an inclusive `[since, until]` epoch window, with carry-forward for records that carry no parseable instant.

For each source record: derive its epoch on demand from its timestamp text; update the carried instant whenever a record DID parse (so a later continuation inherits
the correct parent even across a skipped region); judge the record by its own epoch when it has one, otherwise by the carried instant. A record that arrives before ANY
timestamp has been seen is treated as the oldest possible instant: a `since` lower bound excludes it, a pure `until` upper bound includes it. Both bounds are
inclusive, and a `null` bound is unbounded on that side.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `source` | `AsyncIterable`\<[`LogRecord`](types.md#logrecord)\> | The upstream record stream (a channel's `LogStream`, or any async iterable of records in arrival order). |
| `bounds` | \{ `since`: [`Nullable`](../util.md#nullable)\<`number`\>; `until`: [`Nullable`](../util.md#nullable)\<`number`\>; \} | The window bounds in epoch milliseconds. `since` is the inclusive lower bound (`null` for unbounded-below); `until` is the inclusive upper bound (`null` for unbounded-above). |
| `bounds.since` | [`Nullable`](../util.md#nullable)\<`number`\> | - |
| `bounds.until` | [`Nullable`](../util.md#nullable)\<`number`\> | - |

#### Returns

`AsyncGenerator`\<[`LogRecord`](types.md#logrecord)\>

An async generator yielding only the records inside the window, in arrival order.
