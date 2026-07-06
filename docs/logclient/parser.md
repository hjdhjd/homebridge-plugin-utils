[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/parser

# logclient/parser

Pure, incremental text-to-[LogRecord](types.md#logrecord) parsing for the Homebridge UI log stream.

The pure pieces that live here, shared by the socket and REST transports, are:

- [LogLineSplitter](#loglinesplitter) - a cursor-based incremental splitter that turns an unbounded stream of text chunks (from a WebSocket `stdout` event or a streamed REST
  download) into discrete raw lines, transparently handling lines split across chunk boundaries and the four newline conventions the stream mixes.
- [parseLogLine](#parselogline) - a per-line parser that extracts the timestamp/plugin brackets and the ANSI-color-derived severity level, producing a [LogRecord](types.md#logrecord) whose
  `message` is ANSI-stripped and whose `raw` preserves the original escapes.

A third pure function, [parseLogTimestamp](#parselogtimestamp) (with its shared [normalizeClock](#normalizeclock) clock-rule helper), interprets a [LogRecord.timestamp](types.md#timestamp) string as an
epoch instant on demand. It is deliberately separate from [parseLogLine](#parselogline), which leaves the timestamp as text: the epoch is a cold, cheaply-derivable value that
only the time-range query path needs, so it is computed by this one shared function when required rather than eagerly materialized on every parsed line.

This module is the single owner of the ANSI escape regex and the SGR-code-to-[LogLevel](types.md#loglevel) map - they live beside the parser that uses them, not in `settings.ts`
(which holds only scalars). The design mirrors the library's per-consumer incremental-assembly pattern (`process.ts`, `mp4-assembler.ts`): rather than sharing a
splitter core with `process.ts`, this splitter is purpose-built, because the two have opposite control-character requirements - `process.ts` strips non-printable
control characters to `os.EOL`, whereas this splitter must PRESERVE control characters because the ANSI color sequence IS the severity data.

## Log Client

### LogLineSplitter

Cursor-based incremental line splitter for the log text stream.

Feed each text chunk through [LogLineSplitter.consume](#consume) and iterate the raw lines it yields. The splitter carries the bytes of an incomplete trailing line across
calls, so a line split across two chunks is reassembled transparently, and it recognizes all four newline conventions the PTY-driven stream mixes (`\r\n`, `\n\r`,
`\r`, `\n`) as single line breaks. Crucially, a chunk that ends with a lone `\r` or `\n` holds that terminator in the carry rather than yielding immediately: the next
chunk may begin with the matching second half of a `\n\r`/`\r\n` pair, and emitting eagerly would split one line break into two and inject a phantom blank line.

The scan is a single integer cursor over the carried buffer; the buffer is rebuilt once per `consume` (the residual tail becomes the next carry), not once per line,
so per-line work is a single `slice` of the line's content with no quadratic buffer churn. Because the splitter holds at most one partial line plus the current chunk,
its memory is bounded by chunk size regardless of total stream length.

The class is intentionally signal-free and event-free. Resource lifecycle and async consumption belong to the composing transport, exactly as `Mp4BoxParser` leaves
those concerns to `Mp4SegmentAssembler`.

#### Example

```ts
const splitter = new LogLineSplitter();

for(const line of splitter.consume(chunk)) {

  handle(parseLogLine(line));
}
```

#### Constructors

##### Constructor

```ts
new LogLineSplitter(): LogLineSplitter;
```

###### Returns

[`LogLineSplitter`](#loglinesplitter)

#### Methods

##### consume()

```ts
consume(chunk): Iterable<string>;
```

Feed the splitter a text chunk and yield every complete raw line now available.

Each yielded line is the content between line breaks with the terminator removed and ANSI escapes preserved. A line that is still incomplete (no terminator yet, or
only a held lone terminator that may pair with the next chunk) is carried internally and surfaces on a later call once its break is unambiguous.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `chunk` | `string` | A contiguous slice of log text from the transport. |

###### Returns

`Iterable`\<`string`\>

An iterable of every complete raw line contained in (or completed by) this chunk, in stream order.

##### flush()

```ts
flush(): Iterable<string>;
```

Flush any buffered final line that never received a terminator.

A log stream may end without a trailing newline, leaving the last line held in the carry. Call this once after the source has ended to surface that final line. It
yields at most one line and clears the carry; calling it again yields nothing. A held lone terminator with no content (a trailing bare `\r`/`\n`) flushes as an
empty final line, matching the convention that a terminator delimits a line that exists.

###### Returns

`Iterable`\<`string`\>

An iterable yielding the final unterminated line, or nothing if the carry is empty.

***

### SeedGate

A one-way admission latch that suppresses the unusable leading lines of a live socket log seed until the first genuine log entry.

The homebridge-config-ui-x native/file log method seeds a live tail by streaming the tail of the log file from a BYTE offset rather than a line boundary, so the first
line of file content is a fragment - the tail end of whatever line the offset fell inside - preceded by the server's own `Loading logs...` / `File: ...` preamble. None
of that is a showable entry. This gate drops every line until the first that begins a real entry - a parseable leading `[timestamp]`, per [isLogLineStart](#isloglinestart) - then
latches OPEN and admits everything thereafter, so the continuation lines and plugin-less core lines that legitimately lack a full prefix flow through untouched.

It is composed per stream, exactly as [LogLineSplitter](#loglinesplitter) is: the consumer owns WHEN to apply it (only on the byte-seeded socket seed - the REST whole-file
download starts at byte 0 and needs no gate), while this owns the latch policy. Once open it never closes, so steady-state admission is a single boolean read and the
recognition predicate runs only across the short leading prefix, never the live stream.

A bounded safety valve guards the pathological case of a stream whose timestamps are not the recognized en-US rendering (a non-default server locale): if no entry
start is seen within `maxSkip` lines, the gate concludes the format is unrecognized, latches open, and admits the rest rather than suppressing the stream forever.
`maxSkip` is sized above any plausible leading-noise run yet well below the ~500-line seed, so it never fires for a normal log and bounds worst-case loss when it does.

#### Example

```ts
const gate = new SeedGate(SEED_GATE_MAX_SKIP);

for(const line of splitter.consume(chunk)) {

  if(gate.admit(line)) {

    emit(line);
  }
}
```

#### Constructors

##### Constructor

```ts
new SeedGate(maxSkip): SeedGate;
```

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `maxSkip` | `number` | The safety-valve bound: the most leading non-entry lines to drop before opening the latch unconditionally. The consumer injects it (production passes `SEED_GATE_MAX_SKIP`) so a test can drive the bounded-open path with a small value. |

###### Returns

[`SeedGate`](#seedgate)

#### Methods

##### admit()

```ts
admit(line): boolean;
```

Decide whether a raw line is admitted, advancing the latch. Once the latch has opened every line is admitted; before then, only the first line that begins a genuine
entry (which opens the latch) or the line at which the skip bound is reached (the unrecognized-format safety valve) is admitted, and every leading non-entry line is
dropped.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `line` | `string` | A single raw log line from the seed stream. |

###### Returns

`boolean`

`true` if the line should be emitted, `false` if it is leading seed noise to drop.

***

### isLogLineStart()

```ts
function isLogLineStart(raw): boolean;
```

Determine whether a raw log line begins a new Homebridge log entry - that is, whether it opens with a parseable bracketed timestamp.

Every genuine entry the server emits starts with a `[timestamp]` field; a `[plugin]` bracket may or may not follow, because Homebridge's own core lines (for example
`[7/3/2026, 4:31:46 PM] Homebridge v1.11.3 ... is running`) carry a timestamp but no plugin prefix. Only the FIRST bracket is inspected: requiring a second `[plugin]`
bracket would wrongly reject those core lines. A line that is not an entry start - the server's `Loading logs...` / `File: ...` seed preamble, a byte-truncated seed
fragment, or a continuation line such as a stack frame or a wrapped object dump - has no leading parseable timestamp and returns `false`. ANSI is stripped first
because the server wraps the timestamp in an SGR color, so the raw line begins with an escape sequence rather than the `[`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `raw` | `string` | A single raw log line (escapes intact, terminator already removed by [LogLineSplitter](#loglinesplitter)). |

#### Returns

`boolean`

`true` when the line opens with a parseable en-US timestamp bracket, `false` otherwise.

***

### normalizeClock()

```ts
function normalizeClock(parts): Nullable<{
  hour: number;
  minute: number;
  second: number;
}>;
```

Normalize a raw clock reading - the captured hour/minute/second plus an optional meridiem token - into a 24-hour `{ hour, minute, second }`, or `null` when any
component is out of range. This is the SINGLE source of truth for the meridiem-to-24-hour conversion and the clock-component range check, shared by
[parseLogTimestamp](#parselogtimestamp) and the CLI-layer time-expression parser so neither re-implements the rule. It is a named export for those consumers and its own test, but it
is intentionally not part of the package barrel.

Range rules: minute and second are 0-59 in every rendering; when a meridiem is present the hour is a 12-hour value (1-12), and without one it is a 24-hour value
(0-23). An out-of-range component yields `null`. The conversion maps `12am` to 0 and `12pm` to 12, adds 12 to any other PM hour, and leaves any other AM hour and every
24-hour reading unchanged.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `parts` | \{ `hour`: `number`; `meridiem?`: `string`; `minute`: `number`; `second`: `number`; \} | The raw clock components. |
| `parts.hour` | `number` | The hour as written (1-12 with a meridiem, 0-23 without). |
| `parts.meridiem?` | `string` | The matched `AM`/`PM` token (any case) when the source carried one, or `undefined` for a 24-hour rendering. |
| `parts.minute` | `number` | The minute (0-59). |
| `parts.second` | `number` | The second (0-59). |

#### Returns

[`Nullable`](../util.md#nullable)\<\{
  `hour`: `number`;
  `minute`: `number`;
  `second`: `number`;
\}\>

The normalized 24-hour `{ hour, minute, second }`, or `null` when any component is out of range.

***

### parseLogLine()

```ts
function parseLogLine(raw): LogRecord;
```

Parse a single raw log line into a [LogRecord](types.md#logrecord).

The `[timestamp] [Plugin Name] ` prefix is extracted from the ANSI-stripped text, and the remainder becomes the human-readable `message`. The severity level is read
from the SGR color sequence that the server wraps around the MESSAGE - which means it appears AFTER the timestamp/plugin brackets, not at the start of the line: the
timestamp (white) and plugin (cyan) carry their own colors, so reading the line's first color would always misclassify them as severity. We therefore scan for the
severity color starting just past the plugin bracket. The original line is preserved verbatim in `raw`. A colored line that carries no severity color resolves to
`level: "info"` (Homebridge's info convention), while a fully color-stripped line resolves to `level: null` because severity is genuinely unknown; a line with no
bracketed prefix resolves to `timestamp: null` / `plugin: null`, a `message` equal to the full stripped line, and a level read from any severity color present
anywhere in the (prefix-less) line.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `raw` | `string` | A single raw log line (escapes intact, terminator already removed by [LogLineSplitter](#loglinesplitter)). |

#### Returns

[`LogRecord`](types.md#logrecord)

The parsed [LogRecord](types.md#logrecord).

***

### parseLogTimestamp()

```ts
function parseLogTimestamp(text): Nullable<number>;
```

Parse a Homebridge log timestamp into epoch milliseconds, or `null` when the text is not a recognized timestamp.

The Homebridge UI renders the first bracketed field as the host's locale/clock string. This recognizes the en-US default in both its renderings - the 12-hour
`M/D/YYYY, h:mm:ss AM` and the 24-hour `M/D/YYYY, HH:mm:ss` - via a single regex, constructs the instant in LOCAL time (matching how the server formats it in the
host's own timezone), and returns its epoch milliseconds. The shared [normalizeClock](#normalizeclock) helper owns the meridiem-to-24-hour conversion and the clock-component
range check, so that rule lives in exactly one place.

Deliberate limitations, in the same register as the rest of the client: only the en-US 12h/24h default is recognized, so a server running another locale yields
`null` (the time-window stage carries forward the most recent parsed instant, so a null-epoch line is kept iff its parent record is in-window, never dropped merely for
lacking a parseable epoch); and the interpretation is LOCAL time, so a client whose timezone differs from the server's skews the absolute values. A well-formed but
impossible calendar date (for example `2/30`) returns `null`; a wall-clock time that falls in the client's DST spring-forward gap is best-effort accepted rather than
rejected, because only the calendar fields are round-trip-validated.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `text` | `string` | The raw timestamp text from a [LogRecord.timestamp](types.md#timestamp) (the first bracketed field), for example `"6/29/2026, 7:00:00 AM"`. |

#### Returns

[`Nullable`](../util.md#nullable)\<`number`\>

The instant as epoch milliseconds, or `null` when the text is not a recognized en-US timestamp or names an impossible calendar date.
