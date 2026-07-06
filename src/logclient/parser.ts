/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/parser.ts: Pure incremental line splitter and per-line parser for Homebridge UI log text.
 */

/**
 * Pure, incremental text-to-{@link LogRecord} parsing for the Homebridge UI log stream.
 *
 * The pure pieces that live here, shared by the socket and REST transports, are:
 *
 * - {@link LogLineSplitter} - a cursor-based incremental splitter that turns an unbounded stream of text chunks (from a WebSocket `stdout` event or a streamed REST
 *   download) into discrete raw lines, transparently handling lines split across chunk boundaries and the four newline conventions the stream mixes.
 * - {@link parseLogLine} - a per-line parser that extracts the timestamp/plugin brackets and the ANSI-color-derived severity level, producing a {@link LogRecord} whose
 *   `message` is ANSI-stripped and whose `raw` preserves the original escapes.
 *
 * A third pure function, {@link parseLogTimestamp} (with its shared {@link normalizeClock} clock-rule helper), interprets a {@link LogRecord.timestamp} string as an
 * epoch instant on demand. It is deliberately separate from {@link parseLogLine}, which leaves the timestamp as text: the epoch is a cold, cheaply-derivable value that
 * only the time-range query path needs, so it is computed by this one shared function when required rather than eagerly materialized on every parsed line.
 *
 * This module is the single owner of the ANSI escape regex and the SGR-code-to-{@link LogLevel} map - they live beside the parser that uses them, not in `settings.ts`
 * (which holds only scalars). The design mirrors the library's per-consumer incremental-assembly pattern (`process.ts`, `mp4-assembler.ts`): rather than sharing a
 * splitter core with `process.ts`, this splitter is purpose-built, because the two have opposite control-character requirements - `process.ts` strips non-printable
 * control characters to `os.EOL`, whereas this splitter must PRESERVE control characters because the ANSI color sequence IS the severity data.
 *
 * @module
 */
import type { LogLevel, LogRecord } from "./types.ts";
import type { Nullable } from "../util.ts";

// The ANSI escape-sequence regex. Matches CSI sequences (ESC `[` ... final byte) - which covers the SGR color sequences the log stream uses - so they can be stripped
// when building the human-readable `message`. Compiled once at module scope since it runs on every parsed line on the parse hot path. Two character classes cover the
// parameter bytes and then the intermediate bytes; the trailing class is the final byte that terminates the sequence.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g;

// The SGR (Select Graphic Rendition) foreground color codes homebridge-config-ui-x uses to convey severity, mapped to the corresponding {@link LogLevel}. The server
// colors the MESSAGE portion of a line - not the whole line - by wrapping it in a single SGR sequence: 31 (red) error, 33 (yellow) warn, 90 (bright black) debug, 32
// (green) success. An info line carries no message color, so the SGR code 39 is intentionally absent from this map (`readLevel` yields null for it); `parseLogLine` then
// promotes a colored line with no severity color to "info", reserving null for a color-stripped line. The timestamp (37/white) and plugin (36/cyan) colors are
// deliberately absent too - they prefix the message and must never be mistaken for severity. Frozen so the shared module-scope table cannot be mutated by a consumer.
const SGR_LEVEL: Readonly<Record<string, LogLevel>> = Object.freeze({

  "31": "error",
  "32": "success",
  "33": "warn",
  "90": "debug"
});

// Match every SGR sequence in a string globally, capturing each one's numeric parameter. The severity color is read by scanning these from the point AFTER the
// timestamp/plugin brackets (see {@link readLevel}), because the server colors the message body, not the line prefix; the timestamp's and plugin's own colors sit before
// that point and are excluded by where the scan starts. The capture group is the parameter digits between `ESC[` and the terminating `m`.
// eslint-disable-next-line no-control-regex
const SGR_PATTERN = /\[([0-9;]*)m/g;

// Match the conventional `[timestamp] [Plugin Name] ` prefix at the start of an ANSI-stripped line, capturing the timestamp and plugin text. Each bracketed field is
// guaranteed present when the match succeeds: the timestamp is rendered white and the plugin name is rendered cyan; the remainder after the closing plugin bracket and
// its trailing space is the message body. Both captures use a negated character class (`[^\]]*`) that cannot cross a `]`, so a message containing brackets is not
// absorbed into the prefix.
const BRACKET_PREFIX_PATTERN = /^\[([^\]]*)\] \[([^\]]*)\] /;

// Recognize the Homebridge en-US default timestamp in both renderings the server emits: the 12-hour `M/D/YYYY, h:mm:ss AM` and the 24-hour `M/D/YYYY, HH:mm:ss` (meridiem
// absent). One module-scope regex serves both - the meridiem group is optional - mirroring the other compiled-once patterns above. The capture groups are, in order:
// month, day, four-digit year, hour, minute, second, and the optional AM/PM token.
const LOG_TIMESTAMP_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AaPp][Mm]))?$/;

// Capture the contents of the FIRST bracket at the very start of an ANSI-stripped line - used by {@link isLogLineStart} to test whether a line opens with a timestamp.
// Only the first bracket is captured (the negated class cannot cross a `]`), because a genuine log entry begins with `[timestamp]` whether or not a `[plugin]` bracket
// follows; the timestamp's parseability, not the presence of a second bracket, is what marks an entry start.
const LOG_LINE_START_PATTERN = /^\[([^\]]*)\]/;

// Strip every ANSI escape sequence from a string, leaving only the printable text. Used to derive the human-readable `message` from a raw line; the raw line itself
// retains the escapes so a `--raw` consumer can reproduce the server's coloring.
function stripAnsi(text: string): string {

  return text.replace(ANSI_PATTERN, "");
}

/**
 * Cursor-based incremental line splitter for the log text stream.
 *
 * Feed each text chunk through {@link LogLineSplitter.consume} and iterate the raw lines it yields. The splitter carries the bytes of an incomplete trailing line across
 * calls, so a line split across two chunks is reassembled transparently, and it recognizes all four newline conventions the PTY-driven stream mixes (`\r\n`, `\n\r`,
 * `\r`, `\n`) as single line breaks. Crucially, a chunk that ends with a lone `\r` or `\n` holds that terminator in the carry rather than yielding immediately: the next
 * chunk may begin with the matching second half of a `\n\r`/`\r\n` pair, and emitting eagerly would split one line break into two and inject a phantom blank line.
 *
 * The scan is a single integer cursor over the carried buffer; the buffer is rebuilt once per `consume` (the residual tail becomes the next carry), not once per line,
 * so per-line work is a single `slice` of the line's content with no quadratic buffer churn. Because the splitter holds at most one partial line plus the current chunk,
 * its memory is bounded by chunk size regardless of total stream length.
 *
 * The class is intentionally signal-free and event-free. Resource lifecycle and async consumption belong to the composing transport, exactly as `Mp4BoxParser` leaves
 * those concerns to `Mp4SegmentAssembler`.
 *
 * @example
 *
 * ```ts
 * const splitter = new LogLineSplitter();
 *
 * for(const line of splitter.consume(chunk)) {
 *
 *   handle(parseLogLine(line));
 * }
 * ```
 *
 * @category Log Client
 */
export class LogLineSplitter {

  // The residual carry: the bytes of an incomplete trailing line (and any held lone terminator) from the previous call, prepended to the next chunk. Empty when the
  // previous chunk ended exactly on a line break.
  #carry = "";

  /**
   * Feed the splitter a text chunk and yield every complete raw line now available.
   *
   * Each yielded line is the content between line breaks with the terminator removed and ANSI escapes preserved. A line that is still incomplete (no terminator yet, or
   * only a held lone terminator that may pair with the next chunk) is carried internally and surfaces on a later call once its break is unambiguous.
   *
   * @param chunk - A contiguous slice of log text from the transport.
   *
   * @returns An iterable of every complete raw line contained in (or completed by) this chunk, in stream order.
   */
  public *consume(chunk: string): Iterable<string> {

    // Prepend the carry only when there is one, keeping the common "chunk completes its own lines and nothing is pending" path free of an empty-string concatenation.
    const buffer = this.#carry.length > 0 ? this.#carry + chunk : chunk;

    // `start` marks the beginning of the current line; `cursor` scans forward looking for terminators. We slice each line's content from `[start, breakStart)` and never
    // rebuild `buffer` mid-loop - the residual tail is computed once at the end.
    let start = 0;
    let cursor = 0;

    while(cursor < buffer.length) {

      const character = buffer.charAt(cursor);

      // Only `\r` and `\n` can start a line break; skip everything else with a single cursor advance.
      if((character !== "\r") && (character !== "\n")) {

        cursor++;

        continue;
      }

      // We found a terminator character. Determine whether it pairs with the following character to form a two-character break (`\r\n` or `\n\r`). The pair forms only
      // when the partner is the OTHER terminator character - `\r\r` and `\n\n` are two separate breaks (two lines), not one.
      const partner = character === "\r" ? "\n" : "\r";
      const hasNext = (cursor + 1) < buffer.length;

      // A lone terminator at the very end of the buffer is ambiguous: the next chunk might supply the partner that completes a two-character break. Hold the line (and
      // this terminator) in the carry rather than yielding, so a `\n\r`/`\r\n` pair split across chunks is never seen as two breaks. We stop scanning here; the residual
      // computed below preserves `[start, end)` including the held terminator.
      if(!hasNext) {

        break;
      }

      // The break is unambiguous now that we can see the next character. Yield the line content up to the terminator, then advance past either one or two characters
      // depending on whether the partner immediately follows.
      yield buffer.slice(start, cursor);

      const isPair = buffer.charAt(cursor + 1) === partner;

      cursor += isPair ? 2 : 1;
      start = cursor;
    }

    // The residual is everything from the last unfinished line's start to the end of the buffer, including any held lone terminator. It becomes the carry for the next
    // call. When `start` reached the buffer end exactly (the chunk ended on a complete break), the carry is empty.
    this.#carry = buffer.slice(start);
  }

  /**
   * Flush any buffered final line that never received a terminator.
   *
   * A log stream may end without a trailing newline, leaving the last line held in the carry. Call this once after the source has ended to surface that final line. It
   * yields at most one line and clears the carry; calling it again yields nothing. A held lone terminator with no content (a trailing bare `\r`/`\n`) flushes as an
   * empty final line, matching the convention that a terminator delimits a line that exists.
   *
   * @returns An iterable yielding the final unterminated line, or nothing if the carry is empty.
   */
  public *flush(): Iterable<string> {

    if(this.#carry.length === 0) {

      return;
    }

    // Strip a single trailing lone terminator that was being held for possible pairing; at flush time no partner will arrive, so it delimits the end of the final line.
    const trailing = this.#carry.replace(/[\r\n]$/, "");

    this.#carry = "";

    yield trailing;
  }
}

/**
 * Parse a single raw log line into a {@link LogRecord}.
 *
 * The `[timestamp] [Plugin Name] ` prefix is extracted from the ANSI-stripped text, and the remainder becomes the human-readable `message`. The severity level is read
 * from the SGR color sequence that the server wraps around the MESSAGE - which means it appears AFTER the timestamp/plugin brackets, not at the start of the line: the
 * timestamp (white) and plugin (cyan) carry their own colors, so reading the line's first color would always misclassify them as severity. We therefore scan for the
 * severity color starting just past the plugin bracket. The original line is preserved verbatim in `raw`. A colored line that carries no severity color resolves to
 * `level: "info"` (Homebridge's info convention), while a fully color-stripped line resolves to `level: null` because severity is genuinely unknown; a line with no
 * bracketed prefix resolves to `timestamp: null` / `plugin: null`, a `message` equal to the full stripped line, and a level read from any severity color present
 * anywhere in the (prefix-less) line.
 *
 * @param raw - A single raw log line (escapes intact, terminator already removed by {@link LogLineSplitter}).
 *
 * @returns The parsed {@link LogRecord}.
 *
 * @category Log Client
 */
export function parseLogLine(raw: string): LogRecord {

  // Strip ANSI to get the printable text, then peel the conventional `[timestamp] [Plugin Name] ` prefix. When the prefix is absent the whole stripped line is the
  // message and both bracketed fields are null.
  const stripped = stripAnsi(raw);
  const match = BRACKET_PREFIX_PATTERN.exec(stripped);

  if(match === null) {

    // No bracketed prefix: this is a status or continuation line, not a formatted Homebridge log line, so the "uncolored = info" convention does not apply. The level is
    // whatever severity color the line carries (read from the whole line, since there is no prefix to skip past), or null.
    return { level: readLevel(raw, 0), message: stripped, plugin: null, raw, timestamp: null };
  }

  // A formatted log line. The severity SGR colors the message, so it sits after the timestamp/plugin brackets; we anchor the scan just past the plugin bracket's closing
  // `]` in the raw line so the timestamp's (white) and plugin's (cyan) own colors are not read as severity. When the message has no severity color, the level depends
  // on whether the line is colored at ALL: a colored line with an uncolored message is Homebridge's info convention ("info"), whereas a line with no ANSI whatsoever is
  // color-stripped, leaving severity genuinely unknown (null). We read "is the line colored" for free from the strip already performed - stripping shortened the text if
  // and only if the line carried ANSI - rather than scanning a second time.
  const colored = stripped.length !== raw.length;
  const level = readLevel(raw, messageColorStart(raw)) ?? (colored ? "info" : null);

  // `match[1]` is the timestamp text and `match[2]` is the plugin text; each bracketed field is guaranteed present when the match succeeds. The message is the
  // stripped text after the matched prefix.
  return { level, message: stripped.slice(match[0].length), plugin: match[2] ?? null, raw, timestamp: match[1] ?? null };
}

// Locate, in the RAW (still-escaped) line, the index just past the second `]` - the plugin bracket's close - so the severity-color scan starts at the message portion
// and never sees the timestamp's or plugin's own color. The closing bracket `]` never appears inside the SGR sequences the server emits, so scanning the raw line for it
// is unambiguous. Returns 0 when fewer than two `]` are present (no recognizable prefix), letting the caller scan from the start.
function messageColorStart(raw: string): number {

  const firstClose = raw.indexOf("]");

  if(firstClose === -1) {

    return 0;
  }

  const secondClose = raw.indexOf("]", firstClose + 1);

  return secondClose === -1 ? 0 : secondClose + 1;
}

// Read the severity level from the first severity-mapping SGR color sequence at or after `from` in the raw line, or null when none is present. Scanning from `from`
// (past the bracket prefix) excludes the timestamp/plugin colors; the first SGR whose parameter maps to a severity wins. An SGR parameter may be a semicolon-separated
// list (e.g., `1;31` for bold red), so each component is consulted against the severity map. Resets and default-color codes (0, 39) never map, so they are skipped
// transparently and the genuine severity color is found.
function readLevel(raw: string, from: number): LogRecord["level"] {

  // Reset the shared global regex's cursor to the scan start. `SGR_PATTERN` carries the `g` flag so successive `.exec` calls walk every SGR sequence in the line; setting
  // `lastIndex` bounds the walk to the message portion and keeps the module-scope regex stateless across `parseLogLine` calls.
  SGR_PATTERN.lastIndex = from;

  for(let match = SGR_PATTERN.exec(raw); match !== null; match = SGR_PATTERN.exec(raw)) {

    // `match[1]` is the captured parameter string; split on semicolons so a compound SGR like `1;31m` is checked component-by-component against the severity map.
    const parameters = (match[1] ?? "").split(";");

    for(const parameter of parameters) {

      const mapped = SGR_LEVEL[parameter];

      if(mapped !== undefined) {

        return mapped;
      }
    }
  }

  return null;
}

/**
 * Parse a Homebridge log timestamp into epoch milliseconds, or `null` when the text is not a recognized timestamp.
 *
 * The Homebridge UI renders the first bracketed field as the host's locale/clock string. This recognizes the en-US default in both its renderings - the 12-hour
 * `M/D/YYYY, h:mm:ss AM` and the 24-hour `M/D/YYYY, HH:mm:ss` - via a single regex, constructs the instant in LOCAL time (matching how the server formats it in the
 * host's own timezone), and returns its epoch milliseconds. The shared {@link normalizeClock} helper owns the meridiem-to-24-hour conversion and the clock-component
 * range check, so that rule lives in exactly one place.
 *
 * Deliberate limitations, in the same register as the rest of the client: only the en-US 12h/24h default is recognized, so a server running another locale yields
 * `null` (the time-window stage carries forward the most recent parsed instant, so a null-epoch line is kept iff its parent record is in-window, never dropped merely for
 * lacking a parseable epoch); and the interpretation is LOCAL time, so a client whose timezone differs from the server's skews the absolute values. A well-formed but
 * impossible calendar date (for example `2/30`) returns `null`; a wall-clock time that falls in the client's DST spring-forward gap is best-effort accepted rather than
 * rejected, because only the calendar fields are round-trip-validated.
 *
 * @param text - The raw timestamp text from a {@link LogRecord.timestamp} (the first bracketed field), for example `"6/29/2026, 7:00:00 AM"`.
 *
 * @returns The instant as epoch milliseconds, or `null` when the text is not a recognized en-US timestamp or names an impossible calendar date.
 *
 * @category Log Client
 */
export function parseLogTimestamp(text: string): Nullable<number> {

  const match = LOG_TIMESTAMP_PATTERN.exec(text);

  if(match === null) {

    return null;
  }

  // The numeric groups are guaranteed present by a successful match; the optional meridiem group is undefined for a 24-hour rendering. We parse the calendar fields
  // here and delegate the clock fields to `normalizeClock`, which owns the range check and the 12-hour-to-24-hour conversion.
  const month = Number.parseInt(match[1] ?? "", 10);
  const day = Number.parseInt(match[2] ?? "", 10);
  const year = Number.parseInt(match[3] ?? "", 10);
  const clock = normalizeClock({ hour: Number.parseInt(match[4] ?? "", 10), meridiem: match[7], minute: Number.parseInt(match[5] ?? "", 10),
    second: Number.parseInt(match[6] ?? "", 10) });

  // An out-of-range clock component (an impossible hour/minute/second) invalidates the whole timestamp.
  if(clock === null) {

    return null;
  }

  // Construct the instant in LOCAL time, then round-trip the CALENDAR fields only. The round-trip rejects a well-formed-but-impossible date (the Date constructor rolls
  // `2/30` forward into March, so the day/month no longer match); we intentionally do NOT round-trip the hour/minute/second, so a wall-clock time in the DST spring-
  // forward gap survives rather than being rejected. Because both the clock and the calendar are validated, the result is total and needs no `NaN` guard.
  const date = new Date(year, month - 1, day, clock.hour, clock.minute, clock.second);

  if((date.getFullYear() !== year) || (date.getMonth() !== (month - 1)) || (date.getDate() !== day)) {

    return null;
  }

  return date.getTime();
}

/**
 * Normalize a raw clock reading - the captured hour/minute/second plus an optional meridiem token - into a 24-hour `{ hour, minute, second }`, or `null` when any
 * component is out of range. This is the SINGLE source of truth for the meridiem-to-24-hour conversion and the clock-component range check, shared by
 * {@link parseLogTimestamp} and the CLI-layer time-expression parser so neither re-implements the rule. It is a named export for those consumers and its own test, but it
 * is intentionally not part of the package barrel.
 *
 * Range rules: minute and second are 0-59 in every rendering; when a meridiem is present the hour is a 12-hour value (1-12), and without one it is a 24-hour value
 * (0-23). An out-of-range component yields `null`. The conversion maps `12am` to 0 and `12pm` to 12, adds 12 to any other PM hour, and leaves any other AM hour and every
 * 24-hour reading unchanged.
 *
 * @param parts          - The raw clock components.
 * @param parts.hour     - The hour as written (1-12 with a meridiem, 0-23 without).
 * @param parts.meridiem - The matched `AM`/`PM` token (any case) when the source carried one, or `undefined` for a 24-hour rendering.
 * @param parts.minute   - The minute (0-59).
 * @param parts.second   - The second (0-59).
 *
 * @returns The normalized 24-hour `{ hour, minute, second }`, or `null` when any component is out of range.
 *
 * @category Log Client
 */
export function normalizeClock(parts: { hour: number; meridiem?: string; minute: number; second: number }): Nullable<{ hour: number; minute: number; second: number }> {

  const { hour, meridiem, minute, second } = parts;

  // Minute and second are 0-59 regardless of rendering; an out-of-range component invalidates the reading.
  if((minute < 0) || (minute > 59) || (second < 0) || (second > 59)) {

    return null;
  }

  // No meridiem means a 24-hour reading (0-23) that is already normalized; validate the range and pass it through verbatim.
  if(meridiem === undefined) {

    if((hour < 0) || (hour > 23)) {

      return null;
    }

    return { hour, minute, second };
  }

  // A meridiem is present, so the hour is a 12-hour value (1-12).
  if((hour < 1) || (hour > 12)) {

    return null;
  }

  // Convert to 24-hour: `12am` is midnight (0) and `12pm` is noon (12); any other PM hour is `+12` and any other AM hour is unchanged.
  const isPm = meridiem.charAt(0).toLowerCase() === "p";

  if(hour === 12) {

    return { hour: isPm ? 12 : 0, minute, second };
  }

  return { hour: isPm ? hour + 12 : hour, minute, second };
}

/**
 * Determine whether a raw log line begins a new Homebridge log entry - that is, whether it opens with a parseable bracketed timestamp.
 *
 * Every genuine entry the server emits starts with a `[timestamp]` field; a `[plugin]` bracket may or may not follow, because Homebridge's own core lines (for example
 * `[7/3/2026, 4:31:46 PM] Homebridge v1.11.3 ... is running`) carry a timestamp but no plugin prefix. Only the FIRST bracket is inspected: requiring a second `[plugin]`
 * bracket would wrongly reject those core lines. A line that is not an entry start - the server's `Loading logs...` / `File: ...` seed preamble, a byte-truncated seed
 * fragment, or a continuation line such as a stack frame or a wrapped object dump - has no leading parseable timestamp and returns `false`. ANSI is stripped first
 * because the server wraps the timestamp in an SGR color, so the raw line begins with an escape sequence rather than the `[`.
 *
 * @param raw - A single raw log line (escapes intact, terminator already removed by {@link LogLineSplitter}).
 *
 * @returns `true` when the line opens with a parseable en-US timestamp bracket, `false` otherwise.
 *
 * @category Log Client
 */
export function isLogLineStart(raw: string): boolean {

  const match = LOG_LINE_START_PATTERN.exec(stripAnsi(raw));

  return (match !== null) && (parseLogTimestamp(match[1] ?? "") !== null);
}

/**
 * A one-way admission latch that suppresses the unusable leading lines of a live socket log seed until the first genuine log entry.
 *
 * The homebridge-config-ui-x native/file log method seeds a live tail by streaming the tail of the log file from a BYTE offset rather than a line boundary, so the first
 * line of file content is a fragment - the tail end of whatever line the offset fell inside - preceded by the server's own `Loading logs...` / `File: ...` preamble. None
 * of that is a showable entry. This gate drops every line until the first that begins a real entry - a parseable leading `[timestamp]`, per {@link isLogLineStart} - then
 * latches OPEN and admits everything thereafter, so the continuation lines and plugin-less core lines that legitimately lack a full prefix flow through untouched.
 *
 * It is composed per stream, exactly as {@link LogLineSplitter} is: the consumer owns WHEN to apply it (only on the byte-seeded socket seed - the REST whole-file
 * download starts at byte 0 and needs no gate), while this owns the latch policy. Once open it never closes, so steady-state admission is a single boolean read and the
 * recognition predicate runs only across the short leading prefix, never the live stream.
 *
 * A bounded safety valve guards the pathological case of a stream whose timestamps are not the recognized en-US rendering (a non-default server locale): if no entry
 * start is seen within `maxSkip` lines, the gate concludes the format is unrecognized, latches open, and admits the rest rather than suppressing the stream forever.
 * `maxSkip` is sized above any plausible leading-noise run yet well below the ~500-line seed, so it never fires for a normal log and bounds worst-case loss when it does.
 *
 * @example
 *
 * ```ts
 * const gate = new SeedGate(SEED_GATE_MAX_SKIP);
 *
 * for(const line of splitter.consume(chunk)) {
 *
 *   if(gate.admit(line)) {
 *
 *     emit(line);
 *   }
 * }
 * ```
 *
 * @category Log Client
 */
export class SeedGate {

  // Whether the latch has opened. Once true, every line is admitted with a single boolean read and the recognition predicate is never consulted again.
  #open = false;

  // The number of leading non-entry lines dropped so far while the latch is still closed. Bounded by `#maxSkip`, at which point the gate gives up and opens.
  #skipped = 0;

  // The safety-valve bound: the most leading non-entry lines to drop before concluding the stream carries no recognizable entry start and opening the latch regardless.
  readonly #maxSkip: number;

  /**
   * @param maxSkip - The safety-valve bound: the most leading non-entry lines to drop before opening the latch unconditionally. The consumer injects it (production
   *                  passes `SEED_GATE_MAX_SKIP`) so a test can drive the bounded-open path with a small value.
   */
  constructor(maxSkip: number) {

    this.#maxSkip = maxSkip;
  }

  /**
   * Decide whether a raw line is admitted, advancing the latch. Once the latch has opened every line is admitted; before then, only the first line that begins a genuine
   * entry (which opens the latch) or the line at which the skip bound is reached (the unrecognized-format safety valve) is admitted, and every leading non-entry line is
   * dropped.
   *
   * @param line - A single raw log line from the seed stream.
   *
   * @returns `true` if the line should be emitted, `false` if it is leading seed noise to drop.
   */
  public admit(line: string): boolean {

    // Once the first real entry has opened the latch, every subsequent line is admitted with a single boolean read - no re-parsing across the live stream.
    if(this.#open) {

      return true;
    }

    // The first line that begins a genuine entry opens the latch and is itself admitted.
    if(isLogLineStart(line)) {

      this.#open = true;

      return true;
    }

    // Still leading seed noise (the byte-seek fragment, the server preamble, or an orphaned continuation of the truncated entry): drop it - unless we have already
    // dropped `#maxSkip` lines without seeing an entry start, which means the stream carries no recognized timestamp (an unrecognized locale/format). In that case
    // stop gating and admit the rest so the stream is never suppressed indefinitely.
    if(this.#skipped >= this.#maxSkip) {

      this.#open = true;

      return true;
    }

    this.#skipped++;

    return false;
  }
}
