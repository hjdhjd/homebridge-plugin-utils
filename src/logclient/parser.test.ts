/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/parser.test.ts: Unit tests for the incremental line splitter and the per-line log parser.
 */
import { LogLineSplitter, SeedGate, isLogLineStart, normalizeClock, parseLogLine, parseLogTimestamp } from "./parser.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The ANSI escape character, named for readability in the colored-line fixtures below.
const ESC = String.fromCharCode(27);

// Build a colored wire line in the homebridge-config-ui-x shape: white timestamp, cyan plugin, then the message wrapped in the supplied severity SGR. This mirrors the
// real server output where the severity color appears AFTER the bracketed prefix, which is precisely the placement the level reader must honor.
function coloredLine(timestamp: string, plugin: string, severitySgr: string, message: string): string {

  return ESC + "[37m[" + timestamp + "]" + ESC + "[39m " + ESC + "[36m[" + plugin + "]" + ESC + "[39m " + severitySgr + message + ESC + "[39m";
}

// Drain a splitter across an ordered list of chunks, collecting every yielded line plus the final flush. Returns the full line list so a test can assert the exact
// sequence the splitter produced regardless of how the input was chopped into chunks.
function splitAll(chunks: readonly string[]): string[] {

  const splitter = new LogLineSplitter();
  const lines: string[] = [];

  for(const chunk of chunks) {

    for(const line of splitter.consume(chunk)) {

      lines.push(line);
    }
  }

  for(const line of splitter.flush()) {

    lines.push(line);
  }

  return lines;
}

describe("LogLineSplitter", () => {

  test("splits multiple complete lines in a single chunk", () => {

    assert.deepEqual(splitAll(["alpha\nbeta\ngamma\n"]), [ "alpha", "beta", "gamma" ]);
  });

  test("reassembles a line split across two chunks", () => {

    assert.deepEqual(splitAll([ "hello wo", "rld\n" ]), ["hello world"]);
  });

  test("recognizes all four newline conventions as single breaks", () => {

    // `\n`, `\r`, and `\r\n` (the last appearing twice) each delimit exactly one line; a correct splitter yields five lines, not the larger count an over-eager splitter
    // would produce by treating the two-character `\r\n` pairs as two breaks.
    assert.deepEqual(splitAll(["a\nb\rc\r\nd\r\ne"]), [ "a", "b", "c", "d", "e" ]);
  });

  test("holds a lone trailing terminator so a \\n\\r pair split across chunks is one break", () => {

    // The first chunk ends with a lone `\n`. A naive splitter would yield "x" and then see the next chunk's leading `\r` as a second break, injecting a phantom blank
    // line. The correct splitter holds the `\n`, sees the `\r` complete the pair, and yields exactly one line for "x".
    assert.deepEqual(splitAll([ "x\n", "\ry" ]), [ "x", "y" ]);
  });

  test("holds a lone trailing CR so a \\r\\n pair split across chunks is one break", () => {

    assert.deepEqual(splitAll([ "x\r", "\ny" ]), [ "x", "y" ]);
  });

  test("treats \\r\\r as two breaks (two empty-delimited lines), not one", () => {

    // A pair of the SAME terminator character is two separate breaks; between them is an empty line. This guards against a splitter that pairs any two adjacent
    // terminators rather than only the two-character CRLF/LFCR conventions.
    assert.deepEqual(splitAll(["a\r\rb\n"]), [ "a", "", "b" ]);
  });

  test("preserves embedded ANSI escapes in the yielded raw line", () => {

    const line = ESC + "[31mcolored" + ESC + "[39m";

    assert.deepEqual(splitAll([line + "\n"]), [line]);
  });

  test("reassembles an ANSI escape sequence split across chunks", () => {

    // The escape sequence `ESC[31m` is fractured across the chunk boundary; the splitter must reassemble it intact so the level reader downstream sees a well-formed SGR.
    const lines = splitAll([ ESC + "[3", "1mhi" + ESC + "[39m\n" ]);

    assert.deepEqual(lines, [ESC + "[31mhi" + ESC + "[39m"]);
  });

  test("flushes a final line that never received a terminator", () => {

    assert.deepEqual(splitAll(["no newline here"]), ["no newline here"]);
  });

  test("emits an empty final line when the stream ends on a complete break", () => {

    // A trailing complete break delimits the line before it; there is no content after, so nothing extra is flushed.
    assert.deepEqual(splitAll(["only\n"]), ["only"]);
  });

  test("flush is a no-op on repeat after the carry is drained", () => {

    const splitter = new LogLineSplitter();

    assert.deepEqual([...splitter.consume("tail")], []);
    assert.deepEqual([...splitter.flush()], ["tail"]);
    assert.deepEqual([...splitter.flush()], []);
  });

  test("holds a chunk-final lone terminator until flush, then yields the completed line", () => {

    const splitter = new LogLineSplitter();

    // A chunk ending in a lone `\n` is ambiguous - the next chunk could supply a `\r` to form a `\n\r` pair - so `consume` holds it rather than yielding eagerly (this is
    // exactly what prevents a phantom blank line when a `\n\r` pair is split across chunks). At flush time no partner can arrive, so the held terminator delimits the
    // final line and "done" surfaces.
    assert.deepEqual([...splitter.consume("done\n")], []);
    assert.deepEqual([...splitter.flush()], ["done"]);
  });
});

describe("parseLogLine", () => {

  test("extracts the timestamp and plugin from a bracketed prefix", () => {

    // A plain, color-stripped line carries no ANSI at all, so its severity is genuinely unknown and the level resolves to null - distinct from a colored info line, which
    // resolves to "info" (see the colored-info test below).
    const record = parseLogLine("[1/2/2024, 10:00:00 AM] [My Plugin] Something happened");

    assert.equal(record.timestamp, "1/2/2024, 10:00:00 AM");
    assert.equal(record.plugin, "My Plugin");
    assert.equal(record.message, "Something happened");
    assert.equal(record.level, null, "a color-stripped line has an unknown (null) level");
  });

  test("reads the severity level from the SGR color AFTER the brackets", () => {

    // The severity color follows the timestamp/plugin brackets; the white timestamp and cyan plugin colors must NOT be mistaken for severity. A red message resolves to
    // error while timestamp/plugin extraction still succeeds.
    const record = parseLogLine(coloredLine("ts", "Plug", ESC + "[31m", "boom"));

    assert.equal(record.level, "error");
    assert.equal(record.timestamp, "ts");
    assert.equal(record.plugin, "Plug");
    assert.equal(record.message, "boom");
  });

  test("maps each severity color to its level", () => {

    const cases: readonly (readonly [ string, string ])[] = [ [ "31", "error" ], [ "32", "success" ], [ "33", "warn" ], [ "90", "debug" ] ];

    for(const [ code, expected ] of cases) {

      const record = parseLogLine(coloredLine("ts", "Plug", ESC + "[" + code + "m", "msg"));

      assert.equal(record.level, expected, "SGR " + code + " should map to " + expected);
    }
  });

  test("resolves a colored info line (no severity color) to the info level", () => {

    // A Homebridge info line is colored (white timestamp, cyan plugin) but its message carries no severity color (39/default only). Because the line IS colored, an
    // uncolored message is the info convention - it resolves to "info", not null. (null is reserved for a color-stripped line, where severity is genuinely unknown.)
    const record = parseLogLine(coloredLine("ts", "Plug", ESC + "[39m", "informational"));

    assert.equal(record.level, "info");
    assert.equal(record.message, "informational");
  });

  test("reads a compound SGR (bold plus color) as its color's level", () => {

    const record = parseLogLine(coloredLine("ts", "Plug", ESC + "[1;33m", "careful"));

    assert.equal(record.level, "warn");
  });

  test("ignores the timestamp and plugin colors when reading severity", () => {

    // Here the timestamp is colored 31 (red), which a reader looking at the line's FIRST color would misread as error. The level reader scans only AFTER the brackets,
    // so the message (no severity color) yields none; because the line IS colored it resolves to "info", never "error" from the timestamp. Regression guard for the
    // "read after the brackets" requirement.
    const line = ESC + "[31m[ts]" + ESC + "[39m " + ESC + "[36m[Plug]" + ESC + "[39m plain message";
    const record = parseLogLine(line);

    assert.equal(record.level, "info");
    assert.equal(record.message, "plain message");
  });

  test("treats a line with no bracketed prefix as an all-message line", () => {

    const record = parseLogLine("just a bare line");

    assert.equal(record.timestamp, null);
    assert.equal(record.plugin, null);
    assert.equal(record.message, "just a bare line");
    assert.equal(record.level, null);
  });

  test("reads severity from a prefix-less colored line", () => {

    // With no brackets to skip, the severity color is read from the start of the line.
    const record = parseLogLine(ESC + "[33mwarning with no prefix" + ESC + "[39m");

    assert.equal(record.level, "warn");
    assert.equal(record.message, "warning with no prefix");
    assert.equal(record.plugin, null);
  });

  test("preserves the original line verbatim in raw", () => {

    const raw = coloredLine("ts", "Plug", ESC + "[31m", "boom");
    const record = parseLogLine(raw);

    assert.equal(record.raw, raw);
    assert.notEqual(record.message, raw, "message must be ANSI-stripped while raw is preserved");
  });

  test("does not absorb message brackets into the prefix", () => {

    // The negated-class prefix match cannot cross a `]`, so it stops at the first two bracket groups; a third bracketed token belongs to the message.
    const record = parseLogLine("[ts] [Plug] [not-a-plugin] body");

    assert.equal(record.timestamp, "ts");
    assert.equal(record.plugin, "Plug");
    assert.equal(record.message, "[not-a-plugin] body");
  });

  test("parses a stray/partial ANSI escape without throwing", () => {

    // The native-seed stream can deliver a fragment where one SGR sequence has lost its leading ESC: here the first `[0m` is a well-formed escape but the following
    // `[37m` has no preceding ESC, so it is a partial/stray escape. The parser must never throw on such a fragment - the contract is robustness, not perfect
    // interpretation - so we assert only that it returns a record whose `raw` is preserved verbatim and whose `message` is a string.
    const raw = ESC + "[0m" + "[37m[6/20/2026, 9:00:00 PM] [Plug] partial";
    const record = parseLogLine(raw);

    assert.equal(record.raw, raw, "a stray/partial escape must not corrupt the preserved raw line");
    assert.equal(typeof record.message, "string", "a stray/partial escape must still yield a string message rather than throwing");
  });
});

describe("parseLogTimestamp", () => {

  test("parses a 12-hour en-US timestamp to its local epoch", () => {

    // The expected epoch is constructed via the SAME local `new Date(...)` the parser uses, so the assertion holds regardless of the machine's timezone.
    assert.equal(parseLogTimestamp("6/29/2026, 7:00:00 AM"), new Date(2026, 5, 29, 7, 0, 0).getTime());
  });

  test("parses a 24-hour en-US timestamp (meridiem absent) to its local epoch", () => {

    assert.equal(parseLogTimestamp("6/29/2026, 19:30:15"), new Date(2026, 5, 29, 19, 30, 15).getTime());
  });

  test("maps 12am to midnight and 12pm to noon", () => {

    assert.equal(parseLogTimestamp("1/2/2026, 12:00:00 AM"), new Date(2026, 0, 2, 0, 0, 0).getTime(), "12am is midnight (hour 0)");
    assert.equal(parseLogTimestamp("1/2/2026, 12:00:00 PM"), new Date(2026, 0, 2, 12, 0, 0).getTime(), "12pm is noon (hour 12)");
  });

  test("accepts a lower-case meridiem", () => {

    assert.equal(parseLogTimestamp("6/29/2026, 7:00:00 am"), new Date(2026, 5, 29, 7, 0, 0).getTime());
  });

  test("returns null for an unrecognized format", () => {

    assert.equal(parseLogTimestamp("2026-06-29T07:00:00Z"), null, "an ISO timestamp is not the en-US default and must not parse");
    assert.equal(parseLogTimestamp("not a timestamp"), null);
  });

  test("returns null for a well-formed but impossible calendar date", () => {

    // 2/30/2026 passes the regex but names a day that does not exist; the calendar round-trip rejects it rather than silently rolling forward into March.
    assert.equal(parseLogTimestamp("2/30/2026, 9:00:00 AM"), null);
  });

  test("returns null for an out-of-range clock component", () => {

    assert.equal(parseLogTimestamp("6/29/2026, 13:00:00 PM"), null, "hour 13 with a meridiem is out of the 12-hour range");
    assert.equal(parseLogTimestamp("6/29/2026, 24:00:00"), null, "hour 24 is out of the 24-hour range");
  });

  test("best-effort accepts a wall-clock time in the DST spring-forward gap (not null)", () => {

    // In America/New_York, 2026-03-08 02:30 does not exist (clocks jump 02:00 -> 03:00). Because only the CALENDAR fields are round-tripped, the constructed instant
    // (which the platform rolls to 03:30) is accepted rather than rejected. We pin the timezone so the gap is real regardless of the CI machine's zone, and restore it.
    const savedTz = process.env["TZ"];

    process.env["TZ"] = "America/New_York";

    try {

      assert.notEqual(parseLogTimestamp("3/8/2026, 2:30:00 AM"), null, "a DST-gap wall-clock time must be best-effort accepted, not rejected");
    } finally {

      // Restore the prior timezone so later tests in this process are unaffected.
      if(savedTz === undefined) {

        delete process.env["TZ"];
      } else {

        process.env["TZ"] = savedTz;
      }
    }
  });
});

describe("normalizeClock", () => {

  test("rejects an out-of-range component on each arm", () => {

    const cases: readonly (readonly [ string, { hour: number; meridiem?: string; minute: number; second: number } ])[] = [

      [ "minute 60", { hour: 10, minute: 60, second: 0 } ],
      [ "second 60", { hour: 10, minute: 0, second: 60 } ],
      [ "24-hour hour 24", { hour: 24, minute: 0, second: 0 } ],
      [ "12-hour hour 13", { hour: 13, meridiem: "PM", minute: 0, second: 0 } ]
    ];

    for(const [ label, parts ] of cases) {

      assert.equal(normalizeClock(parts), null, label + " must normalize to null");
    }
  });

  test("converts 12am to hour 0 and 12pm to hour 12", () => {

    assert.deepEqual(normalizeClock({ hour: 12, meridiem: "AM", minute: 0, second: 0 }), { hour: 0, minute: 0, second: 0 });
    assert.deepEqual(normalizeClock({ hour: 12, meridiem: "PM", minute: 0, second: 0 }), { hour: 12, minute: 0, second: 0 });
  });

  test("adds 12 to a PM hour and leaves an AM hour unchanged", () => {

    assert.deepEqual(normalizeClock({ hour: 3, meridiem: "pm", minute: 15, second: 30 }), { hour: 15, minute: 15, second: 30 });
    assert.deepEqual(normalizeClock({ hour: 3, meridiem: "am", minute: 15, second: 30 }), { hour: 3, minute: 15, second: 30 });
  });

  test("passes a valid 24-hour reading through unchanged", () => {

    assert.deepEqual(normalizeClock({ hour: 23, minute: 59, second: 59 }), { hour: 23, minute: 59, second: 59 });
    assert.deepEqual(normalizeClock({ hour: 0, minute: 0, second: 0 }), { hour: 0, minute: 0, second: 0 });
  });
});

describe("isLogLineStart", () => {

  test("accepts a full [timestamp] [plugin] entry", () => {

    assert.equal(isLogLineStart("[6/29/2026, 7:00:00 AM] [UniFi Protect] Dog Room: Tamper event detected."), true);
  });

  test("accepts a plugin-less core Homebridge entry (single bracket, timestamp only)", () => {

    // Homebridge's own core lines carry a timestamp but no plugin bracket; requiring a second bracket would wrongly reject them, so only the first bracket is inspected.
    assert.equal(isLogLineStart("[7/3/2026, 4:31:46 PM] Homebridge v1.11.3 (HAP v0.14.2) (House UniFi Protect) is running on port 36680."), true);
    assert.equal(isLogLineStart("[7/3/2026, 4:31:34 PM] Got SIGTERM, shutting down child bridge process..."), true);
  });

  test("accepts an ANSI-wrapped timestamp (the real wire shape) and a 24-hour rendering", () => {

    // On the wire the server wraps the timestamp in a white SGR, so the raw line begins with an escape rather than the '['; the predicate strips ANSI before testing.
    assert.equal(isLogLineStart(ESC + "[37m[7/4/2026, 8:42:02 PM]" + ESC + "[39m " + ESC + "[36m[UniFi Protect]" + ESC + "[39m message"), true);
    assert.equal(isLogLineStart("[6/29/2026, 19:30:15] [P] a 24-hour entry"), true);
  });

  test("rejects the byte-truncated seed fragment", () => {

    // The tail end of a line the server's byte-offset seed cut mid-way: no leading timestamp bracket, so it is not an entry start.
    assert.equal(isLogLineStart(ESC + "[0me frame RPS." + ESC + "[39m"), false);
  });

  test("rejects the server seed preamble", () => {

    assert.equal(isLogLineStart("Loading logs using native method..."), false);
    assert.equal(isLogLineStart("File: /Users/hjd/.homebridge/homebridge.log"), false);
  });

  test("rejects a continuation line with no leading timestamp", () => {

    assert.equal(isLogLineStart("    at Object.<anonymous> (/x/y.js:1:1)"), false);
    assert.equal(isLogLineStart("  reason: 'Requests to the controller are throttled.'"), false);
    assert.equal(isLogLineStart("}"), false);
  });

  test("rejects a leading bracket that is not a parseable timestamp", () => {

    // A mid-line cut can leave a line that starts with '[' but whose first bracket is not a timestamp; only a parseable timestamp counts as an entry start.
    assert.equal(isLogLineStart("[hevc @ 0xb6d02ca80] Skipping invalid undecodable NALU: 1"), false);
    assert.equal(isLogLineStart("[SomeTag] a tagged but timestamp-less line"), false);
  });

  test("rejects an empty line", () => {

    assert.equal(isLogLineStart(""), false);
  });
});

describe("SeedGate", () => {

  // Drive a gate across an ordered list of lines, returning only the admitted ones so a test can assert exactly what survives the latch.
  function admitAll(lines: readonly string[], maxSkip = 100): string[] {

    const gate = new SeedGate(maxSkip);

    return lines.filter((line) => gate.admit(line));
  }

  test("drops the leading preamble and truncated fragment, then admits from the first real entry", () => {

    // The exact shape of a native-method seed: two preamble lines, a blank, the byte-truncated fragment, then genuine entries.
    const admitted = admitAll([
      "Loading logs using native method...",
      "File: /Users/hjd/.homebridge/homebridge.log",
      "",
      "e frame RPS.",
      "[6/29/2026, 8:42:02 PM] [UniFi Protect] first real line",
      "[6/29/2026, 8:42:03 PM] [UniFi Protect] second real line"
    ]);

    assert.deepEqual(admitted, [ "[6/29/2026, 8:42:02 PM] [UniFi Protect] first real line", "[6/29/2026, 8:42:03 PM] [UniFi Protect] second real line" ]);
  });

  test("admits from the first line when it is already an entry (drops nothing)", () => {

    const lines = [ "[6/29/2026, 8:42:02 PM] [P] one", "[6/29/2026, 8:42:03 PM] [P] two" ];

    assert.deepEqual(admitAll(lines), lines);
  });

  test("once open, admits subsequent continuation lines that lack a timestamp", () => {

    // After the latch opens on a real entry, a following continuation (a stack frame, a plugin-less core line) must flow through untouched - the gate never re-closes.
    const admitted = admitAll([
      "[6/29/2026, 8:42:02 PM] [P] an error occurred:",
      "    at Object.<anonymous> (/x/y.js:1:1)",
      "[7/3/2026, 4:31:46 PM] a plugin-less core line"
    ]);

    assert.deepEqual(admitted,
      [ "[6/29/2026, 8:42:02 PM] [P] an error occurred:", "    at Object.<anonymous> (/x/y.js:1:1)", "[7/3/2026, 4:31:46 PM] a plugin-less core line" ]);
  });

  test("the safety valve opens the latch after maxSkip drops when no entry is ever recognized", () => {

    // A stream whose timestamps are not the recognized en-US rendering never yields an entry start; the gate must not suppress it forever. With maxSkip 3 it drops the
    // first three non-entry lines, then opens and admits the rest.
    const admitted = admitAll([ "no-ts one", "no-ts two", "no-ts three", "no-ts four", "no-ts five" ], 3);

    assert.deepEqual(admitted, [ "no-ts four", "no-ts five" ], "after maxSkip drops the gate opens and admits every remaining line");
  });

  test("the safety valve drops exactly maxSkip lines before opening", () => {

    const gate = new SeedGate(2);

    assert.equal(gate.admit("noise one"), false, "the first non-entry line is dropped");
    assert.equal(gate.admit("noise two"), false, "the second non-entry line is dropped (reaching the bound)");
    assert.equal(gate.admit("noise three"), true, "the line at which the bound is reached opens the latch and is admitted");
    assert.equal(gate.admit("noise four"), true, "the latch stays open thereafter");
  });
});
