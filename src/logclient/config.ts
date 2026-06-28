/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/config.ts: CLI-layer config-file loading and pure connection resolution for the hblog tool.
 */

/**
 * CLI-layer configuration for the `hblog` tool: loading the optional `~/.hblog.json` file and the pure merge of file / environment / flags into a connection.
 *
 * This module lives at the CLI layer on purpose: the engine ({@link logclient/client!HomebridgeLogClient | HomebridgeLogClient} and its transports) never reads the
 * user's home directory or any config file - all file I/O stays here, behind injectable seams, so the engine is portable and side-effect-free. Three pieces are exported:
 *
 * - {@link resolveConfigPath} - resolve the absolute config-file path, honoring the `HBLOG_CONFIG` environment override over the home-directory default
 *   ({@link DEFAULT_CONFIG_FILENAME}).
 * - {@link loadConfigFile} - read and parse the optional `~/.hblog.json`. A missing file resolves to `undefined` silently (the file is optional); a malformed file raises
 *   a clear, actionable error; unknown keys are ignored; and a file whose permissions are group/other-readable triggers a single one-line warning recommending `chmod
 *   600`, because the file may carry a password or a long-lived token in plaintext. The `readFile`, `stat`, and `warn` seams are injected so the loader is unit-tested
 *   without touching the real filesystem.
 * - {@link resolveConnection} - a PURE merge of the three configuration sources into one resolved connection, applying the precedence flags > environment > file >
 *   defaults. It performs no I/O of its own; the caller supplies the already-loaded file, the environment slice, and the parsed flags.
 *
 * @module
 */
import { DEFAULT_HOST, DEFAULT_PORT } from "./settings.ts";
import type { Nullable } from "../util.ts";
import { formatErrorMessage } from "../util.ts";

// The default path of the optional config file, relative to the user's home directory. Home-dir only (no project-local file) so a config carrying a password or token is
// never tempting to commit alongside a plugin's source. The CLI resolves this against the real home directory; the `HBLOG_CONFIG` environment variable overrides it.
export const DEFAULT_CONFIG_FILENAME = ".hblog.json";

// The permission mask that flags a config file as too permissive: any group or other read/write/execute bit set. A file carrying a plaintext credential should be owner-
// only (mode 600); when any of these bits is present we warn once and recommend `chmod 600`. We mask the raw `mode` (which carries file-type bits in its high bits) with
// this so only the group/other permission triplet is consulted.
const GROUP_OTHER_MASK = 0o077;

/**
 * The shape of the optional `~/.hblog.json` config file. Every field is optional; unknown keys in the file are ignored. The file deliberately carries no `otp` field - a
 * one-time passcode is, by definition, single-use and time-bound, so it only ever comes from the `--otp` flag or the `HBLOG_OTP` environment variable, never from a
 * persisted file.
 *
 * @property host     - The hostname or IP of the homebridge-config-ui-x server.
 * @property password - The account password, for username/password authentication.
 * @property port     - The TCP port the server listens on.
 * @property tls      - Whether to use the secure (`https`/`wss`) schemes.
 * @property token    - A pre-acquired bearer token, used verbatim.
 * @property username - The account username, for username/password authentication.
 *
 * @category Log Client
 */
export interface HblogConfigFile {

  readonly host?: string;
  readonly password?: string;
  readonly port?: number;
  readonly tls?: boolean;
  readonly token?: string;
  readonly username?: string;
}

/**
 * The environment-variable slice consulted by {@link resolveConnection}. The CLI reads these from `process.env` (`HBLOG_HOST`, `HBLOG_PORT`, `HBLOG_USER`, `HBLOG_PASS`,
 * `HBLOG_TOKEN`, `HBLOG_OTP`) and passes them here as already-extracted values so the resolver itself touches no globals.
 *
 * @property host     - The `HBLOG_HOST` value.
 * @property otp      - The `HBLOG_OTP` value (a one-time passcode).
 * @property password - The `HBLOG_PASS` value.
 * @property port     - The `HBLOG_PORT` value (still a string here; parsed during resolution).
 * @property token    - The `HBLOG_TOKEN` value.
 * @property username - The `HBLOG_USER` value.
 *
 * @category Log Client
 */
export interface HblogEnv {

  readonly host?: string;
  readonly otp?: string;
  readonly password?: string;
  readonly port?: string;
  readonly token?: string;
  readonly username?: string;
}

/**
 * The command-line connection flags consulted by {@link resolveConnection}. These are the parsed `--host`, `--port`, `--tls`, `--user`, `--pass`, `--token`, and `--otp`
 * values. They take the highest precedence in the merge.
 *
 * @property host     - The `--host` value.
 * @property otp      - The `--otp` value.
 * @property password - The `--pass` value.
 * @property port     - The `--port` value (already parsed to a number by the flag parser, or omitted).
 * @property tls      - The `--tls` value.
 * @property token    - The `--token` value.
 * @property username - The `--user` value.
 *
 * @category Log Client
 */
export interface HblogConnectionFlags {

  readonly host?: string;
  readonly otp?: string;
  readonly password?: string;
  readonly port?: number;
  readonly tls?: boolean;
  readonly token?: string;
  readonly username?: string;
}

/**
 * The fully-resolved connection produced by {@link resolveConnection}: the connection target plus the credential material the CLI uses to build a
 * {@link logclient/types!LogClientCredentials | LogClientCredentials} discriminated union. `host`, `port`, and `tls` always carry a concrete value (defaults applied);
 * the credential fields are {@link Nullable} because none, some, or all of them may have been supplied across the three sources.
 *
 * @property host     - The resolved hostname or IP.
 * @property otp      - The resolved one-time passcode, or `null` when none was supplied.
 * @property password - The resolved password, or `null` when none was supplied.
 * @property port     - The resolved TCP port.
 * @property tls      - The resolved TLS flag.
 * @property token    - The resolved bearer token, or `null` when none was supplied.
 * @property username - The resolved username, or `null` when none was supplied.
 *
 * @category Log Client
 */
export interface ResolvedConnection {

  readonly host: string;
  readonly otp: Nullable<string>;
  readonly password: Nullable<string>;
  readonly port: number;
  readonly tls: boolean;
  readonly token: Nullable<string>;
  readonly username: Nullable<string>;
}

/**
 * Options accepted by {@link loadConfigFile}: the injectable filesystem and warning seams. All default to the real Node implementations / a `process.stderr` writer, so a
 * caller (the CLI) can omit them in production and a test can supply doubles.
 *
 * @property readFile - Reads the file's UTF-8 text. Defaults to `node:fs/promises` `readFile`. A rejection whose `code` is `ENOENT` is treated as "file absent."
 * @property stat     - Stats the file for its permission mode. Defaults to `node:fs/promises` `stat`. Used only for the group/other-readable security warning.
 * @property warn     - Sink for the single one-line security warning. Defaults to a `process.stderr` writer. Injected so a test asserts the warning without capturing
 *                      real stderr.
 *
 * @category Log Client
 */
export interface LoadConfigFileOptions {

  readonly readFile?: (path: string) => Promise<string>;
  readonly stat?: (path: string) => Promise<{ readonly mode: number }>;
  readonly warn?: (message: string) => void;
}

// The default `readFile` seam: read the file as UTF-8 text via `node:fs/promises`. Imported lazily inside the default so a caller that always injects its own seam pays
// no `node:fs/promises` import cost, and the engine-adjacent module stays free of an unconditional Node filesystem dependency at load time.
async function defaultReadFile(path: string): Promise<string> {

  const { readFile } = await import("node:fs/promises");

  return readFile(path, "utf8");
}

// The default `stat` seam: stat the file via `node:fs/promises`, narrowing to just the `mode` field the permission check needs. Lazily imported for the same reason as
// the read seam.
async function defaultStat(path: string): Promise<{ readonly mode: number }> {

  const { stat } = await import("node:fs/promises");

  const stats = await stat(path);

  return { mode: stats.mode };
}

// Test whether a thrown filesystem error denotes a missing file. Node's `readFile`/`stat` reject with an error carrying `code: "ENOENT"` when the path does not exist;
// that is the silent "no config file" case rather than a failure. We read `code` defensively off an unknown error shape.
function isFileNotFound(error: unknown): boolean {

  return (typeof error === "object") && (error !== null) && ("code" in error) && (error.code === "ENOENT");
}

// Narrow an unknown parsed JSON value to a plain record (a JSON object) so individual fields can be read without unsafe member access. An array is excluded: a config
// file whose top level is an array (or any non-object) is malformed, so it must not be treated as a record.
function isRecord(value: unknown): value is Record<string, unknown> {

  return (typeof value === "object") && (value !== null) && !Array.isArray(value);
}

// Read one optional string field off the parsed config record. A present non-string value is ignored (treated as absent) rather than coerced, so a malformed field type
// degrades to "unset" rather than smuggling a number/boolean into a string slot.
function readString(record: Record<string, unknown>, key: string): string | undefined {

  const value = record[key];

  return (typeof value === "string") ? value : undefined;
}

// Read the named optional numeric field off the parsed config record. A present non-number value is ignored (treated as absent) rather than coerced.
function readNumber(record: Record<string, unknown>, key: string): number | undefined {

  const value = record[key];

  return (typeof value === "number") ? value : undefined;
}

// Read the named optional boolean field off the parsed config record. A present non-boolean value is ignored (treated as absent) rather than coerced.
function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {

  const value = record[key];

  return (typeof value === "boolean") ? value : undefined;
}

/**
 * Load and parse the optional `~/.hblog.json` config file.
 *
 * The file is optional: when it does not exist (ENOENT) this resolves to `undefined` silently. Every other failure is thrown as a clear, actionable error naming the
 * path: a non-ENOENT read failure (a permission or I/O fault), a file that cannot be parsed as JSON, or a file whose top-level value is not a JSON object. Recognized
 * keys ({@link HblogConfigFile}) are picked out by type (a wrong-typed field is ignored, not coerced); any unknown key is ignored. As a security courtesy, if the file's
 * permissions allow group or other access (`mode & 0o077`), a single one-line warning recommending `chmod 600` is emitted through the `warn` seam, because the file may
 * store a password or a long-lived token in plaintext.
 *
 * @param path    - The absolute path of the config file to load (the CLI resolves `~/.hblog.json`, or honors `HBLOG_CONFIG`).
 * @param options - The injectable filesystem and warning seams. See {@link LoadConfigFileOptions}.
 *
 * @returns The parsed {@link HblogConfigFile}, or `undefined` when the file is absent (ENOENT).
 *
 * @throws `Error` when the file exists but cannot be read (a non-ENOENT read failure), contains malformed JSON, or whose top-level value is not a JSON object.
 *
 * @category Log Client
 */
export async function loadConfigFile(path: string, options: LoadConfigFileOptions = {}): Promise<HblogConfigFile | undefined> {

  const readFile = options.readFile ?? defaultReadFile;
  const stat = options.stat ?? defaultStat;
  const warn = options.warn ?? ((message: string): void => { process.stderr.write(message + "\n"); });

  let text: string;

  try {

    text = await readFile(path);
  } catch(error: unknown) {

    // A missing file is the silent, expected "no config" case; any other read failure (a permission error, an I/O fault) is a genuine problem the user should see.
    if(isFileNotFound(error)) {

      return undefined;
    }

    throw new Error("Unable to read the config file " + path + ": " + formatErrorMessage(error) + ".");
  }

  let parsed: unknown;

  try {

    parsed = JSON.parse(text);
  } catch(error: unknown) {

    throw new Error("The config file " + path + " is not valid JSON: " + formatErrorMessage(error) + ". Fix the file or remove it.");
  }

  if(!isRecord(parsed)) {

    throw new Error("The config file " + path + " must contain a JSON object. Fix the file or remove it.");
  }

  // Stat the file for its permission mode and warn once if it is group/other-readable. A stat failure here is non-fatal: the file parsed fine, so we skip the security
  // courtesy rather than fail the load over an inability to read permissions (e.g., on a filesystem that does not report a meaningful mode).
  try {

    const stats = await stat(path);

    if((stats.mode & GROUP_OTHER_MASK) !== 0) {

      warn("Warning: the config file " + path + " is readable by other users; it may contain credentials. Run `chmod 600 " + path + "` to restrict it to your account.");
    }
  } catch {

    // Permissions could not be determined; skip the security warning rather than fail an otherwise-valid load.
  }

  // Pick out the recognized keys by type; unknown keys and wrong-typed values are ignored. Building a fresh object (rather than returning `parsed`) keeps the result
  // exactly the declared shape and drops any extraneous keys the file carried.
  return {

    host: readString(parsed, "host"),
    password: readString(parsed, "password"),
    port: readNumber(parsed, "port"),
    tls: readBoolean(parsed, "tls"),
    token: readString(parsed, "token"),
    username: readString(parsed, "username")
  };
}

/**
 * Resolve the absolute path of the config file to load.
 *
 * The `HBLOG_CONFIG` environment variable overrides everything when set to a non-empty value (handy for tests and non-standard layouts); otherwise the default
 * {@link DEFAULT_CONFIG_FILENAME} (`.hblog.json`) under the supplied home directory is used. Home-dir only - there is no project-local config file, so a config carrying
 * a password or token is never tempting to commit alongside a plugin's source. The join uses a single forward slash, which both POSIX and Windows accept in a path passed
 * to `readFile`, so no `node:path` import is needed on this hot setup path.
 *
 * @param sources         - The path inputs.
 * @param sources.env     - The environment map; only `HBLOG_CONFIG` is consulted.
 * @param sources.homedir - The user's home directory, the anchor for the default config-file path.
 *
 * @returns The absolute path to load the config file from.
 *
 * @category Log Client
 */
export function resolveConfigPath(sources: { env: NodeJS.ProcessEnv; homedir: string }): string {

  const override = sources.env["HBLOG_CONFIG"];

  if((override !== undefined) && (override.length > 0)) {

    return override;
  }

  return sources.homedir.replace(/[/\\]+$/, "") + "/" + DEFAULT_CONFIG_FILENAME;
}

// Resolve one optional string across the three sources in precedence order (flags > env > file), returning `null` when none supplied. The first defined value wins; an
// empty string is a defined value (the user explicitly passed it) so it is honored rather than skipped.
function pickString(flag: string | undefined, env: string | undefined, file: string | undefined): Nullable<string> {

  return flag ?? env ?? file ?? null;
}

/**
 * Resolve the three configuration sources into a single {@link ResolvedConnection}, applying the precedence flags > environment > file > defaults.
 *
 * This is a PURE function: it reads only its arguments and allocates only the result, performing no I/O. The caller is responsible for having loaded the file (via
 * {@link loadConfigFile}), extracted the environment slice, and parsed the flags. `host`, `port`, and `tls` always resolve to a concrete value (their defaults are
 * `localhost`, `8581`, and `false`); the credential fields resolve to `null` when no source supplied them, leaving the CLI to decide which
 * {@link logclient/types!LogClientCredentials | LogClientCredentials} arm the resolved material implies. The `port` from the environment is a string, so it is
 * parsed here; a non-numeric `HBLOG_PORT` is ignored (falls through to the next source) rather than producing a `NaN` port.
 *
 * @param sources       - The three configuration sources.
 * @param sources.env   - The environment slice. See {@link HblogEnv}.
 * @param sources.file  - The loaded config file, or `undefined` when absent. See {@link HblogConfigFile}.
 * @param sources.flags - The parsed command-line flags. See {@link HblogConnectionFlags}.
 *
 * @returns The fully-resolved connection.
 *
 * @category Log Client
 */
export function resolveConnection(sources: { env: HblogEnv; file: HblogConfigFile | undefined; flags: HblogConnectionFlags }): ResolvedConnection {

  const { env, file, flags } = sources;

  // Parse the environment port from its string form. A non-numeric value is discarded so it does not mask a lower-precedence source with a `NaN`; an integer parse is
  // used since a port is a whole number.
  const envPort = (env.port !== undefined) ? Number.parseInt(env.port, 10) : undefined;
  const envPortValid = (envPort !== undefined) && Number.isFinite(envPort);

  return {

    host: flags.host ?? env.host ?? file?.host ?? DEFAULT_HOST,
    otp: pickString(flags.otp, env.otp, undefined),
    password: pickString(flags.password, env.password, file?.password),
    port: flags.port ?? (envPortValid ? envPort : undefined) ?? file?.port ?? DEFAULT_PORT,
    tls: flags.tls ?? file?.tls ?? false,
    token: pickString(flags.token, env.token, file?.token),
    username: pickString(flags.username, env.username, file?.username)
  };
}
