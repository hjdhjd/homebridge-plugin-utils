/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/types.ts: Shared type definitions for the Homebridge UI log client.
 */

/**
 * Shared, dependency-light type definitions for the Homebridge UI log client.
 *
 * This module is the single home for the log client's domain vocabulary - the record shape every parser/filter/stitch path produces and consumes, the credential
 * discriminated union, and the request shapes that select a transport channel. Keeping these here (rather than scattered across the modules that use them) makes the
 * vocabulary discoverable in one place and lets the pure leaf modules (`parser.ts`, `filter.ts`, `stitch.ts`) and the transports share one definition rather than
 * re-declaring overlapping shapes.
 *
 * @module
 */
import type { Nullable } from "../util.ts";

/**
 * The severity level of a single log line.
 *
 * Severity in homebridge-config-ui-x is conveyed only by the ANSI color of the line, not by a textual label: `31` (red) is error, `33` (yellow) is warn, `90` (bright
 * black) is debug, `32` (green) is success, and an uncolored line is info. When the Homebridge process runs without `FORCE_COLOR` the color is usually absent, so a
 * record's level is frequently `null` (see {@link LogRecord.level}); a present level always maps to one of these five values.
 *
 * @category Log Client
 */
export type LogLevel = "debug" | "error" | "info" | "success" | "warn";

/**
 * A single parsed log line.
 *
 * Every field except `message` and `raw` is {@link Nullable} because the underlying log format makes them optional: the timestamp and plugin name are present only when
 * the line carries the conventional `[timestamp] [Plugin Name] message` bracketed prefix, and the level is present only when ANSI color survives to the client. `raw`
 * preserves the original line with all ANSI escapes intact (so a `--raw` consumer can reproduce the server's coloring), while `message` is the human-readable text with
 * ANSI stripped and the bracketed prefix removed.
 *
 * @property level     - The severity derived from the line's ANSI color, or `null` when the line carried no recognizable color (the common case under hb-service/systemd
 *                       without `FORCE_COLOR`).
 * @property message   - The line's human-readable text: ANSI-stripped and with the leading `[timestamp] [Plugin Name]` brackets removed when present.
 * @property plugin    - The plugin name from the second bracketed field, or `null` when the line carried no plugin bracket.
 * @property raw       - The original line exactly as received, with ANSI escapes and the bracketed prefix intact, but with newline terminators removed.
 * @property timestamp - The timestamp text from the first bracketed field, or `null` when the line carried no timestamp bracket.
 *
 * @category Log Client
 */
export interface LogRecord {

  readonly level: Nullable<LogLevel>;
  readonly message: string;
  readonly plugin: Nullable<string>;
  readonly raw: string;
  readonly timestamp: Nullable<string>;
}

/**
 * The credentials used to authenticate against the homebridge-config-ui-x API, modeled as a discriminated union so invalid combinations are unrepresentable.
 *
 * The three arms correspond to the three authentication paths the server exposes: a pre-acquired bearer token (`token`), an interactive username/password login with an
 * optional one-time passcode (`password`), and the no-authentication path (`noauth`) available only when the web UI is configured with `auth: "none"`. Expressing this
 * as a DU rather than a bag of optional fields means password-without-username, token-plus-password, and other nonsensical mixes cannot be constructed, and the `otp`
 * field has exactly one home where it is meaningful.
 *
 * @category Log Client
 */
export type LogClientCredentials = { readonly kind: "noauth" } |
  { readonly kind: "password"; readonly otp?: string; readonly password: string; readonly username: string } |
  { readonly kind: "token"; readonly token: string };

/**
 * How many log lines a history or seeded request should retain: an explicit count, or the sentinel `"all"` for the entire available history.
 *
 * The sentinel is a distinct literal rather than a magic number (e.g., `-1` or `Infinity`) so the "give me everything" intent is explicit at every call site and cannot
 * be confused with a real count. The number form is interpreted as "the most recent N lines."
 *
 * @category Log Client
 */
export type LogQuantity = number | "all";

/**
 * A request describing which log content to deliver and over which channel, modeled as a discriminated union on `mode`.
 *
 * The three modes map to the cost model: `follow` is a pure live tail over the socket (cheap, incremental); `history` is a one-shot retrieval of `quantity` past lines
 * (paid via the REST whole-file download when the quantity is deep); and `follow-history` seeds `quantity` past lines and then continues live, stitching the two so the
 * boundary neither drops nor (beyond a bounded overlap) duplicates lines. Carrying `quantity` only on the arms that need it keeps a bare `follow` from having to invent
 * a meaningless count.
 *
 * @category Log Client
 */
export type TailRequest = { readonly mode: "follow" } |
  { readonly mode: "follow-history"; readonly quantity: LogQuantity } |
  { readonly mode: "history"; readonly quantity: LogQuantity };
