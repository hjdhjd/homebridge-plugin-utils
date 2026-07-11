/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/cli-run.ts: The hblog command-line logic, pure-by-injection - arg parsing, config resolution, transport orchestration, output formatting, and signals.
 */

/**
 * The `hblog` command-line logic, written pure-by-injection.
 *
 * {@link runHblog} is the whole CLI behavior with none of the process coupling: it takes its argument vector, environment, output streams, working/home directories, and
 * the filesystem and transport seams as arguments rather than reading them from globals, and it returns the process exit code rather than calling `process.exit`. That
 * makes the entire flow - argument parsing, `~/.hblog.json` resolution, credential/request mapping, transport orchestration, output formatting, signal handling, and exit
 * codes - exercisable in tests against captured streams and fake transports, with no live server and no real process signals.
 *
 * The bin (`cli.ts`) is a thin shell that resolves its own real directory, dynamic-imports this module, and calls {@link runHblog} with the real `process` streams,
 * environment, and directories. Everything that can go wrong (a usage error, an auth failure, a broken pipe, a SIGINT) is decided here and reported as an exit code. The
 * bin records that code on `process.exitCode` and lets the event loop drain - so a piped stdout flushes in full - rather than forcing termination with `process.exit`.
 *
 * @module
 */
import type { HblogConnectionFlags, HblogEnv, ResolvedConnection } from "./config.ts";
import type { LogClientCredentials, LogQuantity, LogRecord, TailRequest } from "./types.ts";
import { formatErrorMessage, onAbort } from "../util.ts";
import { loadConfigFile, resolveConfigPath, resolveConnection } from "./config.ts";
import { HomebridgeLogClient } from "./client.ts";
import type { LogSocketFactory } from "./socket.ts";
import type { Nullable } from "../util.ts";
import { createLogFilter } from "./filter.ts";
import { parseArgs } from "node:util";
import { parseTimeExpression } from "./time-expression.ts";
import { systemClock } from "../clock.ts";

// The usage banner shown for `--help` and on a usage error. Kept as a module constant so the help text and the misuse text are one source of truth and a test can assert
// against it without coupling to formatting. The flags here mirror the `parseArgs` option table below; the two must stay in lockstep.
const USAGE = [

  "Usage: hblog [filters] [options]",
  "",
  "Tail or query a homebridge-config-ui-x log.",
  "",
  "Connection:",
  "  --host <host>          The homebridge-config-ui-x host (default: localhost).",
  "  --port <port>          The server port (default: 8581).",
  "  --tls                  Connect over TLS (https/wss).",
  "  --user <username>      The login username.",
  "  --pass <password>      The login password.",
  "  --token <token>        A pre-acquired bearer token (used verbatim).",
  "  --otp <code>           A one-time passcode for a 2FA-enabled account.",
  "",
  "Mode:",
  "  -f, --follow           Live-tail the log (default).",
  "  -n, --lines <N>        Retrieve the most recent N lines.",
  "  --all                  Retrieve the entire log (cannot be combined with -n).",
  "",
  "Time range:",
  "  --since <when>         Only show lines at or after <when> (e.g. 1d, 7am, 2026-06-29, \"2026-06-29 6am\").",
  "  --until <when>         Only show lines at or before <when>; bounds a closed past window (cannot combine with --follow).",
  "",
  "Filters:",
  "  -p, --plugin <name>    Only show lines from this plugin (repeatable).",
  "  -g, --grep <regex>     Only show lines whose message matches this regular expression.",
  "  -l, --level <level>    Only show lines at this level: debug, error, info, success, warn (repeatable).",
  "",
  "Output:",
  "  --json                 Emit one JSON record per line (NDJSON).",
  "  --raw                  Emit raw lines with ANSI escapes preserved.",
  "  --no-color             Strip ANSI escapes from the output.",
  "  --version              Print the hblog version and exit.",
  "  -h, --help             Print this help and exit."
].join("\n") + "\n";

// The exit codes the CLI returns. 0 is a clean success (including --help, --version, and a clean SIGINT/SIGTERM); 1 is a connection or authentication failure; 2 is a
// usage error (bad flags, contradictory mode flags, or incomplete credentials). Named as a frozen map so the call sites read by intent rather than by magic number.
const EXIT = Object.freeze({ failure: 1, success: 0, usage: 2 });

// The ANSI escape-sequence regex used to strip color when the output is not coloring. Mirrors the parser's CSI matcher; compiled once at module scope since it runs per
// emitted line on the output hot path.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g;

// The set of recognized log levels, used to validate `--level` values so a typo (`--level eror`) is a clear usage error rather than a filter that silently matches
// nothing.
const VALID_LEVELS = new Set<string>([ "debug", "error", "info", "success", "warn" ]);

/**
 * The event-hook shape {@link CliStream} exposes for the stream events the CLI observes. Modeled as an overloaded call signature - the same shape `EventEmitter.on`/
 * `off` present - so each event's listener is typed to exactly what that event delivers: `"error"` hands the listener the failing error (an `EPIPE` broken pipe, or a
 * genuine write fault such as `ENOSPC`), while `"drain"` delivers nothing and merely signals that the writable buffer has fallen back below its high-water mark.
 *
 * @category Log Client
 */
export interface CliStreamEventHook {

  (event: "drain", listener: () => void): void;
  (event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
}

/**
 * A minimal output-stream surface {@link runHblog} writes to. Models the subset of a Node `WriteStream` the CLI actually uses: `write` for output, the optional `isTTY`
 * flag that drives the auto-color decision, and the optional `on`/`off` event hooks used to trap a broken-pipe (`EPIPE`) error and to await `drain` when a write reports
 * backpressure. The narrow interface keeps a test sink small (a `write` function is enough) while `process.stdout`/`process.stderr` satisfy it structurally.
 *
 * @category Log Client
 */
export interface CliStream {

  isTTY?: boolean;
  off?: CliStreamEventHook;
  on?: CliStreamEventHook;
  write: (chunk: string) => boolean;
}

/**
 * Options accepted by {@link runHblog}. Every external dependency the CLI touches is an injected seam, so the whole flow runs deterministically in tests.
 *
 * @property argv          - The argument vector (typically `process.argv.slice(2)`).
 * @property cwd           - The current working directory. Reserved for future relative-path resolution; the home directory is the config-file anchor today.
 * @property env           - The environment map (typically `process.env`).
 * @property fetch         - Optional `fetch` seam forwarded to the engine's auth and REST transports. Defaults to the global `fetch`.
 * @property homedir       - The user's home directory, used to locate `~/.hblog.json` unless `HBLOG_CONFIG` overrides the path.
 * @property now           - Optional wall-clock epoch source (milliseconds) used to resolve the `--since`/`--until` time-range expressions against a single deterministic
 *                           instant. Defaults to `systemClock.now`; a test injects a fixed clock so a windowed run's bounds are reproducible.
 * @property readFile      - Optional file-read seam forwarded to the config loader and used to read the package version. Defaults to `node:fs/promises` `readFile`.
 * @property socketFactory - Optional socket-factory seam forwarded to the engine, so a test drives the live tail without a WebSocket. Defaults to the real factory.
 * @property stat          - Optional file-stat seam forwarded to the config loader for the permissions warning. Defaults to `node:fs/promises` `stat`.
 * @property stderr        - The diagnostics/warnings stream. Production passes `process.stderr`.
 * @property stdout        - The log-data stream. Production passes `process.stdout`.
 *
 * @category Log Client
 */
export interface RunHblogOptions {

  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly homedir: string;
  readonly now?: () => number;
  readonly readFile?: (path: string) => Promise<string>;
  readonly socketFactory?: LogSocketFactory;
  readonly stat?: (path: string) => Promise<{ readonly mode: number }>;
  readonly stderr: CliStream;
  readonly stdout: CliStream;
}

// The parsed shape of the command-line flags, after `parseArgs`. The flag-style booleans default to `false` when absent; `tls` is the one exception, staying
// `boolean | undefined` so its absence can fall through to file/default resolution. Repeatable options are arrays; `lines`/`grep` are single strings.
interface ParsedFlags {

  all: boolean;
  follow: boolean;
  grep: string | undefined;
  help: boolean;
  host: string | undefined;
  json: boolean;
  level: string[];
  lines: string | undefined;
  noColor: boolean;
  otp: string | undefined;
  pass: string | undefined;
  plugin: string[];
  port: string | undefined;
  raw: boolean;
  since: string | undefined;
  tls: boolean | undefined;
  token: string | undefined;
  until: string | undefined;
  user: string | undefined;
  version: boolean;
}

// A usage error carrying the message to print to stderr. Thrown by the parsing/mapping helpers and caught by `runHblog`, which prints the message plus usage and returns
// the usage exit code. Modeled as a typed error rather than a sentinel return so the helpers stay total over their success type.
class UsageError extends Error {

  public constructor(message: string) {

    super(message);
    this.name = "UsageError";
  }
}

// Strip ANSI escape sequences from a line. Used when the output is not coloring (a non-TTY stdout, `NO_COLOR`, or `--no-color`); `--raw` and a TTY keep them intact.
function stripAnsi(text: string): string {

  return text.replace(ANSI_PATTERN, "");
}

// Redact a bearer token from any text the CLI is about to print. A network-level error message can embed the connect URL (which carries `token=<jwt>`), and a token can
// appear in other diagnostic shapes, so we replace both the bare token substring and any `token=...` query parameter with a placeholder. This is the chokepoint for
// credential-safe diagnostics: the hard-error stderr writes (the setup failure, a captured stdout write error - via failWithStdoutError, on either the normal-completion
// or the catch path - and the streaming catch's generic error) route through it, while the usage banner, the config-permission warning, and the level advisory never
// carry a token.
function redactToken(text: string, token: Nullable<string>): string {

  // Always scrub a `token=...` query parameter regardless of whether we hold the literal token, since a URL built from a refreshed token may carry a value we never saw.
  let redacted = text.replace(/([?&]token=)[^&\s"]+/g, "$1<redacted>");

  // When we hold the literal token, scrub any bare occurrence of it too (e.g., a message that interpolated the token without the URL framing).
  if((token !== null) && (token.length > 0)) {

    redacted = redacted.split(token).join("<redacted>");
  }

  return redacted;
}

// Parse the argument vector into the strongly-typed flag shape. `parseArgs` is configured strict, so an unknown flag throws; we translate that into a `UsageError` so the
// user gets a friendly message plus the usage banner rather than a raw parser stack. Repeatable options (`plugin`, `level`) are `multiple`; the rest are single.
function parseFlags(argv: readonly string[]): ParsedFlags {

  let values;

  try {

    ({ values } = parseArgs({

      allowPositionals: false,
      args: [...argv],
      options: {

        all: { type: "boolean" },
        follow: { short: "f", type: "boolean" },
        grep: { short: "g", type: "string" },
        help: { short: "h", type: "boolean" },
        host: { type: "string" },
        json: { type: "boolean" },
        level: { multiple: true, short: "l", type: "string" },
        lines: { short: "n", type: "string" },
        "no-color": { type: "boolean" },
        otp: { type: "string" },
        pass: { type: "string" },
        plugin: { multiple: true, short: "p", type: "string" },
        port: { type: "string" },
        raw: { type: "boolean" },
        since: { type: "string" },
        tls: { type: "boolean" },
        token: { type: "string" },
        until: { type: "string" },
        user: { type: "string" },
        version: { type: "boolean" }
      },
      strict: true
    }));
  } catch(error: unknown) {

    throw new UsageError(formatErrorMessage(error) + ".");
  }

  // Normalize the loosely-typed `parseArgs` result into the strict `ParsedFlags` shape, defaulting booleans to `false` and repeatable options to empty arrays so the
  // downstream mapping never has to branch on `undefined` for those. `tls` is left optional so its absence falls through to the file/default in `resolveConnection`.
  return {

    all: values.all ?? false,
    follow: values.follow ?? false,
    grep: values.grep,
    help: values.help ?? false,
    host: values.host,
    json: values.json ?? false,
    level: values.level ?? [],
    lines: values.lines,
    noColor: values["no-color"] ?? false,
    otp: values.otp,
    pass: values.pass,
    plugin: values.plugin ?? [],
    port: values.port,
    raw: values.raw ?? false,
    since: values.since,
    tls: values.tls,
    token: values.token,
    until: values.until,
    user: values.user,
    version: values.version ?? false
  };
}

// Build the connection-flag slice `resolveConnection` consumes from the parsed flags, parsing the `--port` string into a number. A non-numeric `--port` is a usage error
// (the user explicitly typed a bad value, unlike the environment's lower-precedence port which is silently ignored).
function connectionFlags(flags: ParsedFlags): HblogConnectionFlags {

  let port: number | undefined;

  if(flags.port !== undefined) {

    const parsed = Number.parseInt(flags.port, 10);

    if(!Number.isFinite(parsed) || (parsed <= 0)) {

      throw new UsageError("The --port value must be a positive integer.");
    }

    port = parsed;
  }

  return { host: flags.host, otp: flags.otp, password: flags.pass, port, tls: flags.tls, token: flags.token, username: flags.user };
}

// Extract the environment slice `resolveConnection` consumes from the process environment. The `HBLOG_*` variables map to the same fields the flags carry; they sit
// between flags and the config file in precedence.
function environmentSlice(env: NodeJS.ProcessEnv): HblogEnv {

  return { host: env["HBLOG_HOST"], otp: env["HBLOG_OTP"], password: env["HBLOG_PASS"], port: env["HBLOG_PORT"], token: env["HBLOG_TOKEN"], username: env["HBLOG_USER"] };
}

// Derive the credential discriminated union from the resolved connection. A token wins outright; otherwise a complete username+password pair (with an optional OTP) is a
// password login; otherwise, with no credential material at all, the noauth path is used. A half-supplied username/password pair is a usage error - the user meant to log
// in but left out half of it, and silently falling back to noauth would mask the mistake.
function deriveCredentials(connection: ResolvedConnection): LogClientCredentials {

  if(connection.token !== null) {

    return { kind: "token", token: connection.token };
  }

  const hasUser = connection.username !== null;
  const hasPass = connection.password !== null;

  if((connection.username !== null) && (connection.password !== null)) {

    // A complete login pair. Include the `otp` key only when present so the password arm stays exactly the declared shape (the field has a home only when meaningful).
    if(connection.otp !== null) {

      return { kind: "password", otp: connection.otp, password: connection.password, username: connection.username };
    }

    return { kind: "password", password: connection.password, username: connection.username };
  }

  if(hasUser || hasPass) {

    throw new UsageError("Both --user and --pass are required for password authentication (or supply --token, or omit both for a no-auth server).");
  }

  return { kind: "noauth" };
}

// Build a usage error for an unparseable `--since`/`--until` value, naming the offending flag and listing the accepted forms. The accepted-forms text lives here as one
// source of truth so every throw site for a time-range flag shares this one message.
function timeExpressionError(flag: string, value: string): UsageError {

  return new UsageError("The " + flag + " value \"" + value + "\" is not a recognized time expression; use a relative age (1d, 2h30m), a clock (7am, 14:30), " +
    "a date (2026-06-29), a date and time (\"2026-06-29 6am\"), or now/today/yesterday.");
}

// Resolve the `--since`/`--until` flags into an absolute epoch window against the single `now` instant. Each present flag is parsed via `parseTimeExpression`; an
// unparseable value is a usage error naming the offending flag. `--since` binds to the interval's lower edge (`.start`) and `--until` to its
// upper edge (`.end`), so a date-only `--until 2026-06-29` includes the whole named day while `--since 2026-06-29` starts at midnight. An inverted window (since after
// until) can never match a line, so it too is a usage error rather than silent empty output.
function deriveWindow(flags: ParsedFlags, now: number): { since: Nullable<number>; until: Nullable<number> } {

  let since: Nullable<number> = null;
  let until: Nullable<number> = null;

  if(flags.since !== undefined) {

    const resolved = parseTimeExpression(flags.since, now);

    if(resolved === null) {

      throw timeExpressionError("--since", flags.since);
    }

    since = resolved.start;
  }

  if(flags.until !== undefined) {

    const resolved = parseTimeExpression(flags.until, now);

    if(resolved === null) {

      throw timeExpressionError("--until", flags.until);
    }

    until = resolved.end;
  }

  if((since !== null) && (until !== null) && (since > until)) {

    throw new UsageError("The --since value must be earlier than the --until value.");
  }

  return { since, until };
}

// Map the mode flags and the resolved time window into a `TailRequest`. `--all` and `-n` are mutually exclusive; a time range cannot combine with `-n` (a window is a
// filter over a whole-file retrieval, not a line count); and a `--until` bound cannot combine with a live `--follow` (a closed past window never ends). A time-bounded
// query maps to the engine's `window` channel, which owns the hedged-seed retrieval and the time-bounded selection: the user's `since`/`until` pass through UNCHANGED (a
// bare `--since` keeps `until: null`, which the engine fills with the snapshot horizon for a one-shot - there is no implicit `until = now` at the CLI), and `follow`
// selects live continuation versus one-shot termination. The non-windowed {follow, quantity} combinations map to the other arms: follow alone -> live tail; follow + a
// quantity -> seeded live tail; a quantity alone -> one-shot history; nothing -> the default live tail.
function deriveRequest(flags: ParsedFlags, windowBounds: { since: Nullable<number>; until: Nullable<number> }): TailRequest {

  if(flags.all && (flags.lines !== undefined)) {

    throw new UsageError("Use either -n/--lines or --all, not both.");
  }

  const hasWindow = (windowBounds.since !== null) || (windowBounds.until !== null);

  if(hasWindow && (flags.lines !== undefined)) {

    throw new UsageError("Use a time range (--since/--until) or -n/--lines, not both.");
  }

  if((windowBounds.until !== null) && flags.follow) {

    throw new UsageError("--until bounds a closed window and cannot combine with --follow.");
  }

  if(hasWindow) {

    // A time-bounded query is delivered over the engine's windowed channel. The user's bounds pass through verbatim; the engine serves it from the socket seed when the
    // seed covers the window and otherwise falls back to the whole-file download, and owns the `[since, until]` filtering.
    return { follow: flags.follow, mode: "window", since: windowBounds.since, until: windowBounds.until };
  }

  let quantity: LogQuantity | undefined;

  if(flags.all) {

    // `--all` asks for the entire log over the whole-file download.
    quantity = "all";
  } else if(flags.lines !== undefined) {

    const parsed = Number.parseInt(flags.lines, 10);

    if(!Number.isFinite(parsed) || (parsed <= 0)) {

      throw new UsageError("The -n/--lines value must be a positive integer.");
    }

    quantity = parsed;
  }

  // Follow is the default when no mode flag is given, so a bare `hblog` live-tails. A quantity with follow seeds the live tail from history; a quantity without follow is
  // a one-shot history retrieval that ends when the file is drained.
  if(flags.follow || (quantity === undefined)) {

    return (quantity === undefined) ? { mode: "follow" } : { mode: "follow-history", quantity };
  }

  return { mode: "history", quantity };
}

// Validate and build the level allow-list from the repeatable `--level` flag, lower-casing each value and rejecting an unrecognized level as a usage error so a typo
// surfaces loudly rather than as silent empty output. Returns the typed level array, or undefined when no level filter was requested.
function deriveLevels(rawLevels: readonly string[]): ("debug" | "error" | "info" | "success" | "warn")[] | undefined {

  if(rawLevels.length === 0) {

    return undefined;
  }

  const levels: ("debug" | "error" | "info" | "success" | "warn")[] = [];

  for(const raw of rawLevels) {

    const level = raw.toLowerCase();

    if(!VALID_LEVELS.has(level)) {

      throw new UsageError("Unknown --level value \"" + raw + "\"; valid levels are debug, error, info, success, warn.");
    }

    levels.push(level as "debug" | "error" | "info" | "success" | "warn");
  }

  return levels;
}

// Compile the `--grep` flag into a RegExp, translating an invalid pattern into a usage error rather than letting the raw `RegExp` SyntaxError escape. Returns undefined
// when no grep was requested.
function deriveGrep(pattern: string | undefined): RegExp | undefined {

  if(pattern === undefined) {

    return undefined;
  }

  try {

    return new RegExp(pattern);
  } catch(error: unknown) {

    throw new UsageError("The -g/--grep value is not a valid regular expression: " + formatErrorMessage(error) + ".");
  }
}

// Decide whether output should carry ANSI color, by a defined precedence: `--no-color` forces stripping; `--raw` forces preservation; otherwise `NO_COLOR` strips,
// `FORCE_COLOR` preserves, and finally a TTY stdout colors while a non-TTY (a pipe or file) strips. `--no-color` outranks `--raw` because removing color is the more
// specific, safer directive when a user contradicts themselves.
function shouldColor(flags: ParsedFlags, env: NodeJS.ProcessEnv, stdout: CliStream): boolean {

  if(flags.noColor) {

    return false;
  }

  if(flags.raw) {

    return true;
  }

  // `NO_COLOR` is honored when set to any non-empty value, per the de-facto NO_COLOR convention. `FORCE_COLOR` set to any non-empty value forces color on even off a TTY.
  if((env["NO_COLOR"] !== undefined) && (env["NO_COLOR"] !== "")) {

    return false;
  }

  if((env["FORCE_COLOR"] !== undefined) && (env["FORCE_COLOR"] !== "")) {

    return true;
  }

  return stdout.isTTY === true;
}

// Read the package version for `--version` from the package's own `package.json`, resolved relative to this compiled module (dist/logclient/cli-run.js -> ../../). Uses
// the injected `readFile` so a test pins the version without the real package file. A read or parse failure degrades to "unknown" rather than failing the command.
async function readVersion(readFile: (path: string) => Promise<string>): Promise<string> {

  try {

    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(await readFile(path));

    if((typeof parsed === "object") && (parsed !== null) && ("version" in parsed) && (typeof parsed.version === "string")) {

      return parsed.version;
    }
  } catch {

    // Fall through to the unknown sentinel; a missing or malformed package.json must not turn `--version` into an error.
  }

  return "unknown";
}

// Format one record for output. `--json` emits the record as NDJSON; otherwise the raw line is emitted, with ANSI stripped when not coloring. Both forms append a single
// newline so the consumer reads one record per line.
function formatRecord(record: LogRecord, json: boolean, color: boolean): string {

  if(json) {

    return JSON.stringify(record) + "\n";
  }

  return (color ? record.raw : stripAnsi(record.raw)) + "\n";
}

/**
 * Run the `hblog` command-line flow and return the process exit code.
 *
 * Parses {@link RunHblogOptions.argv}, handles `--help`/`--version` immediately, resolves the connection across flags / environment / `~/.hblog.json` (honoring
 * `HBLOG_CONFIG`), maps the result into a {@link LogClientCredentials} and a {@link TailRequest}, builds a {@link HomebridgeLogClient}, runs the selected channel,
 * applies the {@link createLogFilter} criteria, and writes log data to stdout (NDJSON for `--json`, raw/stripped lines otherwise) while routing diagnostics and warnings
 * to stderr. A SIGINT/SIGTERM aborts the run cleanly (exit 0); a broken pipe (`EPIPE`) on stdout also ends cleanly (exit 0); a usage error returns 2; a connection or
 * authentication failure returns 1. Token redaction is applied at the hard-error stderr writes (the setup failure, a captured stdout write error on either the
 * normal-completion or the catch path, and the streaming catch's generic error); the usage and advisory writes never carry a token.
 *
 * @param options - The injected argument vector, environment, streams, directories, and seams. See {@link RunHblogOptions}.
 *
 * @returns The process exit code: 0 success / clean signal / help / version, 1 connection or auth failure, 2 usage error.
 *
 * @category Log Client
 */
export async function runHblog(options: RunHblogOptions): Promise<number> {

  const { argv, env, homedir, stderr, stdout } = options;
  const readFile = options.readFile;

  // Parse flags first; an unknown or malformed flag is a usage error before any I/O.
  let flags: ParsedFlags;

  try {

    flags = parseFlags(argv);
  } catch(error: unknown) {

    return reportUsage(stderr, error);
  }

  // `--help` and `--version` short-circuit to stdout with a clean exit, before any connection work.
  if(flags.help) {

    stdout.write(USAGE);

    return EXIT.success;
  }

  if(flags.version) {

    const version = await readVersion(readFile ?? defaultReadFile);

    stdout.write("hblog " + version + "\n");

    return EXIT.success;
  }

  // Resolve the connection, credentials, request, and filter criteria. Any usage error here (bad port, contradictory mode flags, half-supplied credentials, bad grep, an
  // unknown level) is reported with the usage banner and the usage exit code. A config-file parse failure is a hard error too, surfaced with its actionable message.
  let connection: ResolvedConnection;
  let credentials: LogClientCredentials;
  let request: TailRequest;
  let filter: (record: LogRecord) => boolean;
  let wantColor: boolean;
  let levelFilterActive: boolean;

  try {

    const configPath = resolveConfigPath({ env, homedir });
    const file = await loadConfigFile(configPath, { readFile: options.readFile, stat: options.stat, warn: (message) => stderr.write(message + "\n") });

    connection = resolveConnection({ env: environmentSlice(env), file, flags: connectionFlags(flags) });
    credentials = deriveCredentials(connection);

    // Evaluate the wall-clock seam EXACTLY ONCE so both time-range bounds resolve against a single instant (no cross-flag drift), then derive the window and the request.
    // The window's bounds are consumed only here (to build the request); the engine's `window` channel owns the time-bounded selection, so nothing downstream re-filters.
    const now = (options.now ?? systemClock.now)();
    const windowBounds = deriveWindow(flags, now);

    request = deriveRequest(flags, windowBounds);

    const levels = deriveLevels(flags.level);

    levelFilterActive = levels !== undefined;
    filter = createLogFilter({ grep: deriveGrep(flags.grep), levels, plugins: (flags.plugin.length > 0) ? flags.plugin : undefined });
    wantColor = shouldColor(flags, env, stdout);
  } catch(error: unknown) {

    if(error instanceof UsageError) {

      return reportUsage(stderr, error);
    }

    // A non-usage failure during setup (a config-file parse/read error) is a hard failure with an actionable message; redact any token defensively.
    stderr.write(redactToken(formatErrorMessage(error) + ".", connectionToken(flags, env)) + "\n");

    return EXIT.failure;
  }

  // Run the live/historical tail and stream records to stdout. The token used by the connection is captured for redaction of any error or diagnostic that follows.
  return streamRecords({ color: wantColor, connection, credentials, filter, flags, levelFilterActive, options, request });
}

// The default file-read seam: read the file as UTF-8 via `node:fs/promises`. Lazily imported so a caller that injects its own seam pays no Node-filesystem import cost.
async function defaultReadFile(path: string): Promise<string> {

  const { readFile } = await import("node:fs/promises");

  return readFile(path, "utf8");
}

// Best-effort capture of the token that will be used for the connection, for redaction of a setup-phase error before `resolveConnection` has run. We read the flag/env
// token directly (the sources known before the config file loads); a file-only token is not yet known here, but a file-only token never appears in a setup error message.
function connectionToken(flags: ParsedFlags, env: NodeJS.ProcessEnv): Nullable<string> {

  return flags.token ?? env["HBLOG_TOKEN"] ?? null;
}

// Report a usage error: print the message (if any) and the usage banner to stderr, then return the usage exit code. A bare `UsageError` with an empty message prints just
// the usage banner.
function reportUsage(stderr: CliStream, error: unknown): number {

  const message = (error instanceof Error) ? error.message : String(error);

  if(message.length > 0) {

    stderr.write(message + "\n\n");
  }

  stderr.write(USAGE);

  return EXIT.usage;
}

// The state threaded into the record-streaming phase. Grouped into one options object so the streaming function reads its inputs by name rather than via a long
// positional list.
interface StreamRecordsState {

  color: boolean;
  connection: ResolvedConnection;
  credentials: LogClientCredentials;
  filter: (record: LogRecord) => boolean;
  flags: ParsedFlags;
  levelFilterActive: boolean;
  options: RunHblogOptions;
  request: TailRequest;
}

// Build the client, run the selected channel, and stream filtered records to stdout. Owns the signal wiring (SIGINT/SIGTERM abort the run cleanly), the EPIPE trap (a
// closed downstream pipe ends the run cleanly), and the level-without-color advisory. Returns the exit code: 0 on a clean end (stream exhausted, clean signal, or EPIPE),
// 1 on a connection/auth failure.
async function streamRecords(state: StreamRecordsState): Promise<number> {

  const { color, connection, credentials, filter, flags, levelFilterActive, options, request } = state;
  const { stderr, stdout } = options;
  const token = connection.token;

  // The run controller: SIGINT/SIGTERM and an EPIPE all abort it, which tears down the client and ends iteration cleanly. A clean abort is success; a fault is reported.
  const controller = new AbortController();

  // Track whether the run ended because of an intentional clean teardown (a signal or a broken pipe) so the catch below classifies the resulting iteration unwind as
  // success rather than a failure.
  let cleanStop = false;

  // A non-EPIPE stdout write error (for example ENOSPC when redirecting to a full disk) is a genuine failure rather than a clean stop; capture it here so the catch can
  // surface it with an actionable message instead of the run ending silently.
  let stdoutError: NodeJS.ErrnoException | null = null;

  // The signal and EPIPE wiring. Registered now and removed in the `finally` so the CLI leaves no dangling listeners (important when `runHblog` is invoked repeatedly in
  // a test process).
  const onSignal = (): void => {

    cleanStop = true;
    controller.abort();
  };

  const onPipeError = (error: NodeJS.ErrnoException): void => {

    // A broken downstream pipe (`hblog -f | head`) is the canonical clean stop: the reader went away, so we end with success rather than an error. Any other stdout error
    // (for example a full disk when redirecting to a file) is a genuine failure. Either way we abort so the run unwinds promptly; the catch distinguishes the two.
    if(error.code === "EPIPE") {

      cleanStop = true;
    } else {

      stdoutError = error;
    }

    controller.abort();
  };

  // Surface a captured non-EPIPE stdout write error as a failure with a redacted, actionable message. Shared by the two paths that can observe it: the drain completing
  // normally, and the drain unwinding into the catch when the abort interrupts it - so the failure message lives in exactly one place.
  const failWithStdoutError = (writeError: NodeJS.ErrnoException): number => {

    stderr.write(redactToken("Error: " + formatErrorMessage(writeError) + ".", token) + "\n");

    return EXIT.failure;
  };

  const signalCleanup = registerSignalHandlers(onSignal);

  stdout.on?.("error", onPipeError);

  // The level-without-color advisory state. Severity is carried only by ANSI color, so when the server emits its log without color (common under hb-service/systemd) the
  // parser cannot determine any level and a strict --level filter would silently reject every line. We detect that precisely: a formatted log line (one with a plugin
  // prefix) that parses to a null level can only be color-stripped, because a colored line always resolves to at least "info". On the first such line we warn once and
  // bypass the level dimension thereafter, so the user still sees output. A colored log never trips this - levels apply normally and no warning fires.
  let colorStripped = false;

  try {

    // The non-level predicate (plugin/grep only) for the level-without-color bypass, compiled once. While a level filter is active and no level has appeared, a strict
    // level filter would reject every record, so we fall back to this predicate and pass the record through on the level dimension.
    const nonLevelFilter = levelFilterActive ? createLogFilter({ grep: deriveGrep(flags.grep), plugins: (flags.plugin.length > 0) ? flags.plugin : undefined }) : filter;

    await using client = new HomebridgeLogClient({

      credentials,
      fetch: options.fetch,
      host: connection.host,
      port: connection.port,
      signal: controller.signal,
      socketFactory: options.socketFactory,
      tls: connection.tls
    });

    await using stream = client.tail(request, { signal: controller.signal });

    // Stream the selected channel's records directly. Time-bounded selection lives in the engine's `window` channel (it alone holds the merged seed/download instant the
    // coverage gate and the snapshot horizon need); the CLI owns only the content filtering below.
    for await (const record of stream) {

      // A formatted log line (one with a plugin prefix) that parses to a null level is the unambiguous signal that the server's log is color-stripped - a colored line
      // always resolves to "info" or a severity, never null. Conclude levels are unavailable on first sight, warn once, then bypass the level dimension.
      if(levelFilterActive && !colorStripped && (record.plugin !== null) && (record.level === null)) {

        colorStripped = true;

        stderr.write("Warning: a --level filter is active but the log lines carry no color, so levels are unknown; set FORCE_COLOR=1 on the Homebridge process to " +
          "enable level filtering. Passing lines through unfiltered by level.\n");
      }

      // While the log is color-stripped a strict level filter would reject every line, so apply only the plugin/grep predicate; otherwise the full filter (including the
      // level dimension) applies. On a colored log this is always the full filter.
      if(levelFilterActive && colorStripped) {

        if(!nonLevelFilter(record)) {

          continue;
        }
      } else if(!filter(record)) {

        continue;
      }

      // Write the formatted record, honoring backpressure. A `false` return means the writable buffer has crossed its high-water mark; we suspend until it drains (or the
      // run aborts) so a bulk `--all`/`-n` download bounds its memory to that mark rather than buffering the whole history in Node's write queue. Pairing this with the
      // bin's natural exit (`process.exitCode`, not `process.exit`) is what guarantees the tail reaches the consumer: a `write` returning is not the same as its bytes
      // reaching the OS, and only an event-loop-drained exit flushes the final buffered chunk. A broken pipe still surfaces via the `error` listener, aborting the wait.
      if(!stdout.write(formatRecord(record, flags.json, color))) {

        await awaitWritable(stdout, controller.signal);
      }
    }

    // The stream drained without throwing. A stdout write error captured during the drain is still a failure: the abort fired from the stdout `error` listener does not
    // always unwind the loop before it finishes, since a fully-buffered history download drains synchronously.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(stdoutError !== null) {

      return failWithStdoutError(stdoutError);
    }

    return EXIT.success;
  } catch(error: unknown) {

    // A non-EPIPE stdout write error is a genuine failure, so surface it ahead of the clean-stop check. Like `cleanStop` it is set asynchronously from the stdout `error`
    // listener, so the compiler's linear-flow narrowing does not reflect its runtime value here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(stdoutError !== null) {

      return failWithStdoutError(stdoutError);
    }

    // A clean stop (signal or EPIPE) unwinds the iteration via the aborted signal; classify that as success. Anything else is a genuine connection or authentication
    // failure: surface a redacted, actionable message and return the failure code. `cleanStop` and the aborted state are both set asynchronously from signal/EPIPE
    // listeners, so the compiler's linear-flow narrowing does not reflect their runtime value here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(cleanStop || controller.signal.aborted) {

      return EXIT.success;
    }

    stderr.write(redactToken("Error: " + formatErrorMessage(error) + ".", token) + "\n");

    return EXIT.failure;
  } finally {

    // Remove the signal and pipe-error listeners on every exit path so a repeated invocation (in tests, or a long-lived host) does not accumulate handlers.
    signalCleanup();
    stdout.off?.("error", onPipeError);
  }
}

// Register process-level SIGINT and SIGTERM handlers that invoke `onSignal`, returning a cleanup function that removes them. The cleanup is always called from the
// streaming phase's `finally`, so a repeated invocation (in tests, or a long-lived host) never accumulates handlers. Both signals abort the run cleanly so an interrupted
// tail flushes and exits 0.
function registerSignalHandlers(onSignal: () => void): () => void {

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return (): void => {

    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

// Wait until the output stream can accept more data (its `drain` event) or the run aborts - whichever comes first. This is the seam-adapted twin of the
// `events.once(stream, "drain", { signal })` idiom the BackpressureWriter uses: the narrow `CliStream` is not a full `EventEmitter`, so we race the stream's `drain`
// against the controller's `abort` over the seam's `on`/`off` hooks by hand. Tying the wait to the signal is required, not decorative - a broken pipe (or a SIGINT)
// during backpressure aborts the controller, and without the race the run would block forever on a `drain` that a closed pipe never emits. A seam that reports
// backpressure but exposes no event hooks (a capturing test sink) cannot signal drain, so we resolve at once and let the loop proceed.
function awaitWritable(stream: CliStream, signal: AbortSignal): Promise<void> {

  // A run that is already aborting has nothing to wait for, and a seam that exposes no event hooks (a capturing test sink) cannot signal drain - either way, resolve at
  // once and let the loop proceed. Guarding the aborted case here also means `onAbort` below never fires its handler inline, so `finish` runs on a later tick when
  // `registration` is fully initialized.
  if(signal.aborted || !stream.on || !stream.off) {

    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {

    // The single settlement point, shared by the drain and the abort path so listener teardown lives in one place: it removes the drain listener, disposes the abort
    // registration (which removes the abort listener, so a bulk download's many drain cycles never accumulate handlers on the signal), and resolves. Each removal is
    // harmless to repeat, so whichever event fires second is a safe no-op.
    const finish = (): void => {

      stream.off?.("drain", finish);
      registration[Symbol.dispose]();
      resolve();
    };

    stream.on?.("drain", finish);

    const registration = onAbort(signal, finish);
  });
}
