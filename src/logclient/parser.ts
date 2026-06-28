/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/parser.ts: Pure incremental line splitter and per-line parser for Homebridge UI log text.
 */

/**
 * Pure, incremental text-to-{@link LogRecord} parsing for the Homebridge UI log stream.
 *
 * Two pure pieces live here, both shared by the socket and REST transports:
 *
 * - {@link LogLineSplitter} - a cursor-based incremental splitter that turns an unbounded stream of text chunks (from a WebSocket `stdout` event or a streamed REST
 *   download) into discrete raw lines, transparently handling lines split across chunk boundaries and the four newline conventions the stream mixes.
 * - {@link parseLogLine} - a per-line parser that extracts the timestamp/plugin brackets and the ANSI-color-derived severity level, producing a {@link LogRecord} whose
 *   `message` is ANSI-stripped and whose `raw` preserves the original escapes.
 *
 * This module is the single owner of the ANSI escape regex and the SGR-code-to-{@link LogLevel} map - they live beside the parser that uses them, not in `settings.ts`
 * (which holds only scalars). The design mirrors the library's per-consumer incremental-assembly pattern (`process.ts`, `mp4-assembler.ts`): rather than sharing a
 * splitter core with `process.ts`, this splitter is purpose-built, because the two have opposite control-character requirements - `process.ts` strips non-printable
 * control characters to `os.EOL`, whereas this splitter must PRESERVE control characters because the ANSI color sequence IS the severity data.
 *
 * @module
 */
import type { LogLevel, LogRecord } from "./types.ts";

// The ANSI escape-sequence regex. Matches CSI sequences (ESC `[` ... final byte) - which covers the SGR color sequences the log stream uses - so they can be stripped
// when building the human-readable `message`. Compiled once at module scope since it runs on every parsed line on the parse hot path. The character class spans the
// parameter and intermediate bytes; the trailing class is the final byte that terminates the sequence.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g;

// The SGR (Select Graphic Rendition) foreground color codes homebridge-config-ui-x uses to convey severity, mapped to the corresponding {@link LogLevel}. The server
// colors the MESSAGE portion of a line - not the whole line - by wrapping it in a single SGR sequence: 31 (red) error, 33 (yellow) warn, 90 (bright black) debug, 32
// (green) success. An info line carries no message color, so 39/info is intentionally absent from this map and resolves to a null level. The timestamp (37/white) and
// plugin (36/cyan) colors are deliberately absent too - they prefix the message and must never be mistaken for severity. Frozen so the shared module-scope table cannot
// be mutated by a consumer.
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

// Match the conventional `[timestamp] [Plugin Name] ` prefix at the start of an ANSI-stripped line, capturing the timestamp and plugin text. The two bracketed fields
// are the timestamp (rendered white) and the plugin name (rendered cyan); the remainder after the second bracket and its trailing space is the message body. Both
// captures are non-greedy so a message that itself contains brackets does not get absorbed into the prefix.
const BRACKET_PREFIX_PATTERN = /^\[([^\]]*)\] \[([^\]]*)\] /;

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
 * severity color starting just past the plugin bracket. The original line is preserved verbatim in `raw`. A line with no recognizable severity color resolves to
 * `level: null`; a line with no bracketed prefix resolves to `timestamp: null` / `plugin: null`, a `message` equal to the full stripped line, and a level read from any
 * severity color present anywhere in the (prefix-less) line.
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

  // `match[1]` is the timestamp text and `match[2]` is the plugin text; both are guaranteed present by the two capture groups when the match succeeds. The
  // message is the stripped text after the matched prefix.
  return { level, message: stripped.slice(match[0].length), plugin: match[2] ?? null, raw, timestamp: match[1] ?? null };
}

// Locate, in the RAW (still-escaped) line, the index just past the second `]` - the plugin bracket's close - so the severity-color scan starts at the message portion
// and never sees the timestamp's or plugin's own color. The brackets are literal characters that ANSI sequences never contain, so scanning the raw line for them is
// unambiguous. Returns 0 when fewer than two `]` are present (no recognizable prefix), letting the caller scan from the start.
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
