/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/cli-run.test.ts: Unit tests for runHblog - arg/credential/request mapping, output formatting, color precedence, EPIPE, exit codes, signals, redaction.
 */
import type { CliStream, RunHblogOptions } from "./cli-run.ts";
import type { LogSocketFactory, LogSocketInit, LogSocketLike } from "./socket.ts";
import { describe, test } from "node:test";
import { LogSocket } from "./socket.ts";
import { TestLogSocketFactory } from "./socket-double.ts";
import { TestWebSocketFactory } from "./socket-double.ts";
import assert from "node:assert/strict";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { runHblog } from "./cli-run.ts";

// A capturing CliStream double. Records every chunk written so a test asserts the exact output, exposes a settable `isTTY`, and supports the `on`/`off` error hooks the
// EPIPE trap uses. The optional `failOnWrite` hook lets an EPIPE test fire a synthetic broken-pipe error to the registered listener the first time the run writes.
class CaptureStream implements CliStream {

  public readonly chunks: string[] = [];
  public isTTY: boolean | undefined;

  readonly #errorListeners: ((error: NodeJS.ErrnoException) => void)[] = [];
  readonly #failOnWrite: boolean;
  #failed = false;

  public constructor(options: { failOnWrite?: boolean; isTTY?: boolean } = {}) {

    this.#failOnWrite = options.failOnWrite ?? false;
    this.isTTY = options.isTTY;
  }

  public off(_event: "error", listener: (error: NodeJS.ErrnoException) => void): void {

    const index = this.#errorListeners.indexOf(listener);

    if(index !== -1) {

      this.#errorListeners.splice(index, 1);
    }
  }

  public on(_event: "error", listener: (error: NodeJS.ErrnoException) => void): void {

    this.#errorListeners.push(listener);
  }

  public get text(): string {

    return this.chunks.join("");
  }

  public write(chunk: string): boolean {

    // On the first write, optionally fire a synthetic EPIPE to the registered listeners, modeling a downstream pipe (`| head`) that closed. The chunk is still recorded
    // so a test can see what was attempted.
    if(this.#failOnWrite && !this.#failed) {

      this.#failed = true;

      const error = new Error("write EPIPE") as NodeJS.ErrnoException;

      error.code = "EPIPE";

      for(const listener of [...this.#errorListeners]) {

        listener(error);
      }
    }

    this.chunks.push(chunk);

    return true;
  }
}

// Build a `fetch` seam double. Auth endpoints (login/noauth) answer with a token; the REST log download answers with the supplied lines, or rejects with `downloadError`
// when one is provided (to exercise the failure and redaction paths). Every requested URL is captured for assertions on which channel/credential ran.
function fakeFetch(options: { downloadError?: Error; lines?: readonly string[] } = {}): { calls: string[]; fetch: typeof fetch } {

  const calls: string[] = [];
  const lines = options.lines ?? [];

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {

    const url = (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;

    calls.push(url);

    if(url.includes("/log/download")) {

      if(options.downloadError !== undefined) {

        throw options.downloadError;
      }

      return new Response(lines.map((line) => line + "\n").join(""), { status: 200 });
    }

    // An auth endpoint: answer with a token body. Bracket-notation keys keep the snake_case wire names from tripping the camelcase lint rule in test source.
    const body: Record<string, unknown> = {};

    body["access_token"] = "fresh.jwt";
    body["token_type"] = "Bearer";

    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  return { calls, fetch: fetchImpl };
}

// Build a LogSocketFactory that constructs a REAL LogSocket driven by an injected WebSocket double, with a near-zero backoff. Unlike the TestLogSocket double (which has
// its own controller and ignores the init signal), a real LogSocket composes the client's per-call signal into its lifetime, so a SIGINT/SIGTERM-driven client abort
// genuinely tears it down - which is what the follow/signal tests need to terminate. The returned `wsFactory` lets a test inspect how many WebSockets were constructed.
function realSocketFactory(): { socketFactory: LogSocketFactory; wsFactory: TestWebSocketFactory } {

  const wsFactory = new TestWebSocketFactory();

  const socketFactory: LogSocketFactory = {

    create: (init: LogSocketInit): LogSocketLike => new LogSocket({ ...init, backoff: () => 0, webSocketFactory: wsFactory.create })
  };

  return { socketFactory, wsFactory };
}

// A default `readFile` seam that always reports the file is missing (an ENOENT-shaped rejection), so the config loader never touches the real `~/.hblog.json` and
// resolution falls through to env/flags/defaults. Tests that exercise `--version` or the config file override `readFile` with their own.
async function missingFileReadFile(): Promise<string> {

  const error = new Error("ENOENT") as Error & { code: string };

  error.code = "ENOENT";

  throw error;
}

// Build the base runHblog options with capturing streams and a default environment/home. Individual tests override `argv`, `env`, the streams, and the transport seams.
function makeOptions(overrides: Partial<RunHblogOptions> & { argv: readonly string[] }): { options: RunHblogOptions; stderr: CaptureStream; stdout: CaptureStream } {

  const stdout = (overrides.stdout as CaptureStream | undefined) ?? new CaptureStream();
  const stderr = (overrides.stderr as CaptureStream | undefined) ?? new CaptureStream();

  const options: RunHblogOptions = {

    cwd: "/work",
    env: {},
    homedir: "/home/dev",
    readFile: missingFileReadFile,
    stat: async (): Promise<{ readonly mode: number }> => ({ mode: 0o100600 }),
    stderr,
    stdout,
    ...overrides
  };

  return { options, stderr, stdout };
}

// Yield to the microtask/immediate queue so the run's async steps settle before a test drives a signal or inspects output.
async function tick(times = 1): Promise<void> {

  for(let index = 0; index < times; index++) {

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
}

describe("runHblog - help and version", () => {

  test("--help prints usage to stdout and exits 0", async () => {

    const { options, stdout } = makeOptions({ argv: ["--help"] });
    const code = await runHblog(options);

    assert.equal(code, 0, "--help must exit 0");
    assert.match(stdout.text, /Usage: hblog/, "--help must print the usage banner to stdout");
  });

  test("--version reads the package version via the injected readFile and exits 0", async () => {

    const stdout = new CaptureStream();
    const { options } = makeOptions({ argv: ["--version"], readFile: async (): Promise<string> => JSON.stringify({ version: "9.9.9" }), stdout });

    const code = await runHblog(options);

    assert.equal(code, 0, "--version must exit 0");
    assert.match(stdout.text, /hblog 9\.9\.9/, "--version must print the resolved package version");
  });
});

describe("runHblog - usage errors", () => {

  test("-n together with --all is a usage error (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "-n", "5", "--all" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "combining -n and --all must be a usage error");
    assert.match(stderr.text, /not both/, "the usage error must explain -n and --all are mutually exclusive");
    assert.match(stderr.text, /Usage: hblog/, "a usage error must print the usage banner");
  });

  test("a half-supplied credential (user without pass) is a usage error (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "--user", "admin", "-n", "1" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "supplying --user without --pass must be a usage error");
    assert.match(stderr.text, /Both --user and --pass/, "the error must name the missing half of the credential pair");
  });

  test("an unknown flag is a usage error (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: ["--nonsense"] });
    const code = await runHblog(options);

    assert.equal(code, 2, "an unknown flag must be a usage error");
    assert.match(stderr.text, /Usage: hblog/, "an unknown flag must print the usage banner");
  });

  test("an invalid --port is a usage error (exit 2)", async () => {

    const { options } = makeOptions({ argv: [ "--port", "abc", "-n", "1" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "a non-numeric --port must be a usage error");
  });

  test("an unknown --level is a usage error (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "--level", "eror", "-n", "1" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "a misspelled --level must be a usage error");
    assert.match(stderr.text, /valid levels/, "the error must list the valid levels");
  });

  test("an invalid --grep regex is a usage error (exit 2)", async () => {

    const { options } = makeOptions({ argv: [ "--grep", "(", "-n", "1" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "an invalid --grep pattern must be a usage error");
  });
});

describe("runHblog - request and credential mapping (history channel)", () => {

  test("a token credential in history mode hits the REST download and no auth endpoint, exit 0", async () => {

    const { calls, fetch } = fakeFetch({ lines: [ "[t] [P] one", "[t] [P] two", "[t] [P] three" ] });
    const factory = new TestLogSocketFactory();
    const { options, stdout } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, socketFactory: factory });

    const code = await runHblog(options);

    assert.equal(code, 0, "a completed history retrieval must exit 0");
    assert.equal(factory.createCalls.length, 0, "history mode must not construct a socket");
    assert.ok(calls.some((url) => url.includes("/log/download")), "history mode must hit the REST download endpoint");
    assert.equal(calls.filter((url) => url.includes("/api/auth")).length, 0, "a token credential must not hit any auth endpoint");
    assert.equal(stdout.text.split("\n").filter((line) => line.length > 0).length, 3, "all three history lines must be written to stdout");
  });

  test("a password credential in history mode authenticates via the login endpoint", async () => {

    const { calls, fetch } = fakeFetch({ lines: ["[t] [P] one"] });
    const { options } = makeOptions({ argv: [ "--user", "admin", "--pass", "secret", "-n", "1" ], fetch });

    const code = await runHblog(options);

    assert.equal(code, 0);
    assert.ok(calls.some((url) => url.includes("/api/auth/login")), "a password credential must authenticate via the login endpoint");
  });

  test("no credential in history mode uses the noauth endpoint", async () => {

    const { calls, fetch } = fakeFetch({ lines: ["[t] [P] one"] });
    const { options } = makeOptions({ argv: ["--all"], fetch });

    const code = await runHblog(options);

    assert.equal(code, 0);
    assert.ok(calls.some((url) => url.includes("/api/auth/noauth")), "no credential must use the noauth endpoint");
  });

  test("a numeric -n retains only the most recent N lines", async () => {

    const { fetch } = fakeFetch({ lines: [ "[t] [P] one", "[t] [P] two", "[t] [P] three", "[t] [P] four" ] });
    const { options, stdout } = makeOptions({ argv: [ "--token", "abc.jwt", "-n", "2" ], fetch });

    await runHblog(options);

    const lines = stdout.text.split("\n").filter((line) => line.length > 0);

    assert.deepEqual(lines, [ "[t] [P] three", "[t] [P] four" ], "a numeric -n must retain only the most recent N lines");
  });

  test("--follow selects the socket channel (no REST download)", async () => {

    const { calls, fetch } = fakeFetch();
    const { socketFactory, wsFactory } = realSocketFactory();
    const stdout = new CaptureStream();
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--follow" ], fetch, socketFactory, stdout });

    // A live follow opens a socket and tails indefinitely; we drive a SIGINT to end it cleanly. The real socket composes the client signal, so the abort tears it down.
    const run = runHblog(options);

    await tick(4);
    process.emit("SIGINT");

    const code = await run;

    assert.equal(code, 0, "a clean SIGINT-terminated follow must exit 0");
    assert.ok(wsFactory.sockets.length >= 1, "--follow must construct a socket");
    assert.equal(calls.filter((url) => url.includes("/log/download")).length, 0, "--follow must not hit the REST download endpoint");
  });
});

describe("runHblog - output formatting and color precedence", () => {

  // A line whose message carries an SGR red (error) color, used to test ANSI stripping vs preservation.
  const COLORED = "[t] [P] [31mboom[39m";

  test("default output to a non-TTY strips ANSI", async () => {

    const { fetch } = fakeFetch({ lines: [COLORED] });
    const stdout = new CaptureStream({ isTTY: false });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    await runHblog(options);

    assert.ok(!stdout.text.includes("["), "a non-TTY stdout must strip ANSI escapes by default");
    assert.match(stdout.text, /boom/, "the message text must survive stripping");
  });

  test("a TTY stdout preserves ANSI", async () => {

    const { fetch } = fakeFetch({ lines: [COLORED] });
    const stdout = new CaptureStream({ isTTY: true });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    await runHblog(options);

    assert.ok(stdout.text.includes("[31m"), "a TTY stdout must preserve ANSI escapes");
  });

  test("NO_COLOR strips ANSI even on a TTY", async () => {

    const { fetch } = fakeFetch({ lines: [COLORED] });
    const stdout = new CaptureStream({ isTTY: true });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], env: { NO_COLOR: "1" }, fetch, stdout });

    await runHblog(options);

    assert.ok(!stdout.text.includes("["), "NO_COLOR must strip ANSI even when stdout is a TTY");
  });

  test("--raw preserves ANSI even on a non-TTY", async () => {

    const { fetch } = fakeFetch({ lines: [COLORED] });
    const stdout = new CaptureStream({ isTTY: false });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--raw" ], fetch, stdout });

    await runHblog(options);

    assert.ok(stdout.text.includes("[31m"), "--raw must preserve ANSI even off a TTY");
  });

  test("--no-color outranks --raw", async () => {

    const { fetch } = fakeFetch({ lines: [COLORED] });
    const stdout = new CaptureStream({ isTTY: true });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--raw", "--no-color" ], fetch, stdout });

    await runHblog(options);

    assert.ok(!stdout.text.includes("["), "--no-color must outrank --raw and strip ANSI");
  });

  test("--json emits one parseable JSON record per line", async () => {

    const { fetch } = fakeFetch({ lines: [ "[ts] [Plug] hello", "[ts] [Plug] world" ] });
    const stdout = new CaptureStream();
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--json" ], fetch, stdout });

    await runHblog(options);

    const lines = stdout.text.split("\n").filter((line) => line.length > 0);
    const records = lines.map((line) => JSON.parse(line) as { message: string; plugin: string });

    assert.equal(records.length, 2, "--json must emit one record per line");
    assert.deepEqual(records.map((record) => record.message), [ "hello", "world" ], "each NDJSON record must carry the parsed message");
    assert.equal(records[0]?.plugin, "Plug", "each NDJSON record must carry the parsed plugin");
  });
});

describe("runHblog - filtering", () => {

  test("--plugin filters to a single plugin", async () => {

    const { fetch } = fakeFetch({ lines: [ "[t] [Alpha] one", "[t] [Beta] two", "[t] [Alpha] three" ] });
    const stdout = new CaptureStream();
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--plugin", "Alpha" ], fetch, stdout });

    await runHblog(options);

    const lines = stdout.text.split("\n").filter((line) => line.length > 0);

    assert.deepEqual(lines, [ "[t] [Alpha] one", "[t] [Alpha] three" ], "--plugin must retain only the named plugin's lines");
  });

  test("--grep filters by message regex", async () => {

    const { fetch } = fakeFetch({ lines: [ "[t] [P] apple", "[t] [P] banana", "[t] [P] apricot" ] });
    const stdout = new CaptureStream();
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--grep", "^ap" ], fetch, stdout });

    await runHblog(options);

    const lines = stdout.text.split("\n").filter((line) => line.length > 0);

    assert.deepEqual(lines, [ "[t] [P] apple", "[t] [P] apricot" ], "--grep must retain only messages matching the pattern");
  });

  test("a --level filter with no color warns once and passes lines through", async () => {

    // The seed lines carry no ANSI color, so every record's level is null. A strict level filter would reject all of them; instead the CLI must warn once and pass them
    // through on the level dimension, never producing silent empty output.
    const { fetch } = fakeFetch({ lines: [ "[t] [P] one", "[t] [P] two" ] });
    const { options, stderr, stdout } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--level", "error" ], fetch });

    await runHblog(options);

    const warnings = stderr.text.split("\n").filter((line) => line.includes("FORCE_COLOR"));

    assert.equal(warnings.length, 1, "a level filter with no color must warn exactly once");
    assert.equal(stdout.text.split("\n").filter((line) => line.length > 0).length, 2, "the lines must be passed through rather than silently dropped");
  });

  test("a --level filter on a colored log filters strictly with no FORCE_COLOR warning", async () => {

    // Colored lines carry real severity - an uncolored message resolves to "info", a red one to "error" - so a level filter applies normally and the FORCE_COLOR advisory
    // must NOT fire. Regression guard for the bug where an all-info colored window was mistaken for a colorless log and every line was passed through unfiltered.
    const ESC = String.fromCharCode(27);
    const prefix = ESC + "[37m[t]" + ESC + "[39m " + ESC + "[36m[P]" + ESC + "[39m ";
    const { fetch } = fakeFetch({ lines: [ prefix + "motion detected", prefix + ESC + "[31mboom" + ESC + "[39m" ] });
    const { options, stderr, stdout } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--level", "error" ], fetch });

    await runHblog(options);

    assert.ok(!stderr.text.includes("FORCE_COLOR"), "a colored log must not trip the FORCE_COLOR advisory");

    const shown = stdout.text.split("\n").filter((line) => line.length > 0);

    assert.equal(shown.length, 1, "only the error line passes a strict -l error filter on a colored log");
    assert.match(shown[0] ?? "", /boom/, "the surviving line must be the error");
  });

  test("a level-bypassed color-stripped line is still subject to the plugin filter", async () => {

    // The seed lines carry no ANSI color, so every record's level is null and the CLI bypasses the level dimension (warning once about FORCE_COLOR). The bypass must NOT
    // disable the other filter dimensions: with --plugin Alpha the Beta line is still dropped, so only the Alpha line survives even though --level error would otherwise
    // have rejected both. We also confirm the color-stripped advisory still fires, since the bypass condition was met.
    const { fetch } = fakeFetch({ lines: [ "[t] [Alpha] one", "[t] [Beta] two" ] });
    const { options, stderr, stdout } = makeOptions({ argv: [ "--token", "abc.jwt", "--all", "--level", "error", "--plugin", "Alpha" ], fetch });

    await runHblog(options);

    const lines = stdout.text.split("\n").filter((line) => line.length > 0);

    assert.deepEqual(lines, ["[t] [Alpha] one"], "the level bypass must not waive the --plugin filter; the Beta line must still be dropped");
    assert.ok(stderr.text.includes("FORCE_COLOR"), "the color-stripped advisory must still fire even when another filter dimension is active");
  });
});

describe("runHblog - failures, EPIPE, and signals", () => {

  test("a connection failure exits 1 with an actionable message", async () => {

    const { fetch } = fakeFetch({ downloadError: new Error("connection refused") });
    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch });

    const code = await runHblog(options);

    assert.equal(code, 1, "a connection failure must exit 1");
    assert.match(stderr.text, /connection refused/, "the failure message must be surfaced");
  });

  test("the token is redacted from an error message", async () => {

    // An error whose message embeds both the literal token and a `token=...` URL query, modeling a network error that leaked the connect URL. Neither form may survive to
    // stderr.
    const token = "super.secret.jwt";
    const leakyError = new Error("connect ECONNREFUSED http://localhost:8581/socket.io/?EIO=4&token=" + token + " using " + token);
    const { fetch } = fakeFetch({ downloadError: leakyError });
    const { options, stderr } = makeOptions({ argv: [ "--token", token, "--all" ], fetch });

    const code = await runHblog(options);

    assert.equal(code, 1, "the failure must still exit 1");
    assert.ok(!stderr.text.includes(token), "the token must never appear in error output");
    assert.match(stderr.text, /<redacted>/, "the leaked token must be replaced with the redaction placeholder");
  });

  test("a broken pipe (EPIPE) on stdout ends the run cleanly (exit 0)", async () => {

    const { fetch } = fakeFetch({ lines: [ "[t] [P] one", "[t] [P] two", "[t] [P] three" ] });
    const stdout = new CaptureStream({ failOnWrite: true });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    const code = await runHblog(options);

    assert.equal(code, 0, "a broken downstream pipe must end the run cleanly with exit 0");
  });

  test("SIGTERM aborts a live follow cleanly (exit 0)", async () => {

    const { fetch } = fakeFetch();
    const { socketFactory } = realSocketFactory();
    const stdout = new CaptureStream();
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--follow" ], fetch, socketFactory, stdout });

    const run = runHblog(options);

    await tick(4);
    process.emit("SIGTERM");

    const code = await run;

    assert.equal(code, 0, "a SIGTERM-terminated follow must exit 0");
  });
});
