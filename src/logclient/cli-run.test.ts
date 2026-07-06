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

// A capturing CliStream double. Records every chunk written so a test asserts the exact output, exposes a settable `isTTY`, and supports `on`/`off` hooks for the stdout
// `error` trap and the backpressure `drain` wait. Optional behaviors drive the run's non-happy paths, each fired at most once (on the first write):
//
// - `failOnWrite` / `failCode`: fire a SYNCHRONOUS stdout error to the error listeners - an EPIPE (the clean-stop path) or an arbitrary errno (the failure path) - then
//   report the write as accepted. This models an error observed inline with the write.
// - `backpressure`: report the first N writes as buffer-full (return `false`) and schedule a `drain` on a later turn so the parked writer resumes, exercising the
//   backpressure-honoring loop and `awaitWritable`'s drain path.
// - `asyncErrorCode`: report the first write as buffer-full (return `false`, parking the writer in its drain wait) and then deliver the error on a LATER turn, with no
//   drain ever scheduled - modeling a pipe that breaks while the run is blocked on backpressure, so only the abort race can unwind the wait.
class CaptureStream implements CliStream {

  public readonly chunks: string[] = [];
  public isTTY: boolean | undefined;

  readonly #asyncErrorCode: string | undefined;
  #backpressureRemaining: number;
  readonly #drainListeners: (() => void)[] = [];
  readonly #errorListeners: ((error: NodeJS.ErrnoException) => void)[] = [];
  readonly #failCode: string | undefined;
  #failed = false;

  public constructor(options: { asyncErrorCode?: string; backpressure?: number; failCode?: string; failOnWrite?: boolean; isTTY?: boolean } = {}) {

    this.#asyncErrorCode = options.asyncErrorCode;
    this.#backpressureRemaining = options.backpressure ?? 0;

    // `failOnWrite` is the EPIPE-specific convenience the clean-stop test uses; `failCode` generalizes it to any errno so the non-EPIPE failure path is testable.
    this.#failCode = options.failCode ?? (options.failOnWrite ? "EPIPE" : undefined);
    this.isTTY = options.isTTY;
  }

  public off(event: "drain", listener: () => void): void;
  public off(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  public off(event: "drain" | "error", listener: unknown): void {

    const listeners: unknown[] = (event === "drain") ? this.#drainListeners : this.#errorListeners;
    const index = listeners.indexOf(listener);

    if(index !== -1) {

      listeners.splice(index, 1);
    }
  }

  public on(event: "drain", listener: () => void): void;
  public on(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  public on(event: "drain" | "error", listener: unknown): void {

    if(event === "drain") {

      this.#drainListeners.push(listener as () => void);
    } else {

      this.#errorListeners.push(listener as (error: NodeJS.ErrnoException) => void);
    }
  }

  public get text(): string {

    return this.chunks.join("");
  }

  public write(chunk: string): boolean {

    // Record the chunk first so a test can see exactly what was attempted, regardless of which behavior path the write takes below.
    this.chunks.push(chunk);

    // Deferred stdout error: the first write reports backpressure (returns `false`, parking the writer in its drain wait), then delivers the error on a later turn - with
    // no drain ever scheduled - so the wait can only unwind via the abort race, modeling a pipe that breaks mid-backpressure.
    if((this.#asyncErrorCode !== undefined) && !this.#failed) {

      this.#failed = true;

      const code = this.#asyncErrorCode;

      setImmediate(() => this.#emitError(code));

      return false;
    }

    // Synchronous stdout error: fire on the first write, before returning, modeling a downstream pipe that closed (EPIPE) or a genuine write failure (any other errno).
    if((this.#failCode !== undefined) && !this.#failed) {

      this.#failed = true;

      this.#emitError(this.#failCode);
    }

    // Simulated backpressure: report the first N writes as buffer-full and schedule a `drain` on a later turn so the parked writer resumes.
    if(this.#backpressureRemaining > 0) {

      this.#backpressureRemaining--;

      setImmediate(() => {

        for(const listener of [...this.#drainListeners]) {

          listener();
        }
      });

      return false;
    }

    return true;
  }

  // Fire a synthetic stdout error carrying `code` to every registered error listener, snapshotting the list so a listener that removes itself during dispatch does not
  // perturb the iteration.
  #emitError(code: string): void {

    const error = new Error("write " + code) as NodeJS.ErrnoException;

    error.code = code;

    for(const listener of [...this.#errorListeners]) {

      listener(error);
    }
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
    // 0o100600 is a regular file (S_IFREG) with owner-only (0600) permissions, picked so the config loader's group/world-readable permissions warning stays silent for
    // any test that overrides `readFile` with a real config.
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
    // must NOT fire. Regression guard: a colored line with an uncolored message must resolve to "info", never null, so a strict --level filter on a colored log must
    // never trip the FORCE_COLOR bypass.
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

  test("a non-EPIPE stdout error surfaces as a failure (exit 1)", async () => {

    const { fetch } = fakeFetch({ lines: [ "[t] [P] one", "[t] [P] two", "[t] [P] three" ] });
    const stdout = new CaptureStream({ failCode: "ENOSPC" });
    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    const code = await runHblog(options);

    assert.equal(code, 1, "a non-EPIPE stdout write error must surface as a failure with exit 1");
    assert.match(stderr.text, /ENOSPC/, "the stdout write failure must be reported to stderr");
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

describe("runHblog - backpressure", () => {

  test("a stdout that reports backpressure drains and still writes every record (exit 0)", async () => {

    // The first two writes report the buffer as full; the sink schedules a `drain` after each, so the run must suspend and resume rather than dropping records. All three
    // history lines must survive the round trip, which proves the backpressure-honoring loop neither loses nor reorders output.
    const { fetch } = fakeFetch({ lines: [ "[t] [P] one", "[t] [P] two", "[t] [P] three" ] });
    const stdout = new CaptureStream({ backpressure: 2 });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    const code = await runHblog(options);

    assert.equal(code, 0, "a run that honors backpressure must still complete cleanly with exit 0");
    assert.deepEqual(stdout.text.split("\n").filter((line) => line.length > 0), [ "[t] [P] one", "[t] [P] two", "[t] [P] three" ],
      "every record must be written in order once the stream drains");
  });

  test("a broken pipe while parked on backpressure ends the run cleanly without hanging (exit 0)", async () => {

    // The write reports backpressure and then delivers an EPIPE on a later turn, with no drain ever scheduled - so the run is genuinely parked in its drain wait when the
    // pipe breaks. Only the abort race can unwind that wait; if it did not, this test would hang rather than fail, which is the regression the race guards against.
    const { fetch } = fakeFetch({ lines: ["[t] [P] one"] });
    const stdout = new CaptureStream({ asyncErrorCode: "EPIPE" });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    const code = await runHblog(options);

    assert.equal(code, 0, "a broken pipe during a backpressure wait must end the run cleanly with exit 0");
  });

  test("a non-EPIPE stdout error while parked on backpressure surfaces as a failure (exit 1)", async () => {

    // The counterpart to the EPIPE case: an ENOSPC delivered while the run is parked on backpressure must still be classified as a failure, surfaced to stderr, and
    // reported with exit 1 - the deferred error observed during the drain wait takes the same failure path as one observed inline with the write.
    const { fetch } = fakeFetch({ lines: ["[t] [P] one"] });
    const stdout = new CaptureStream({ asyncErrorCode: "ENOSPC" });
    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    const code = await runHblog(options);

    assert.equal(code, 1, "a non-EPIPE stdout error during a backpressure wait must surface as a failure with exit 1");
    assert.match(stderr.text, /ENOSPC/, "the deferred stdout write failure must be reported to stderr");
  });

  test("a write that reports backpressure after the run has already aborted resolves without parking (exit 0)", async () => {

    // The first write fires a synchronous EPIPE - which aborts the run inline - and then reports the buffer as full. By the time the loop reaches its drain wait the run
    // is already aborted, so `awaitWritable` takes its fast path and resolves at once rather than registering a `drain` listener that would never be cleaned up.
    const { fetch } = fakeFetch({ lines: [ "[t] [P] one", "[t] [P] two" ] });
    const stdout = new CaptureStream({ backpressure: 1, failOnWrite: true });
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--all" ], fetch, stdout });

    const code = await runHblog(options);

    assert.equal(code, 0, "a broken pipe that also reports backpressure must end the run cleanly with exit 0");
  });
});

// Build a `fetch` seam whose REST log-download resolves only when the returned `resolveHistory` is invoked, mirroring client.test.ts. The deferred history lets a
// follow-history test buffer the socket's full seed before history finishes, making the socket-first stitch ordering deterministic rather than timing-dependent.
function deferredFetch(historyLines: readonly string[]): { fetch: typeof fetch; resolveHistory: () => void } {

  const gate: PromiseWithResolvers<void> = Promise.withResolvers();

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {

    const url = (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;

    if(url.includes("/log/download")) {

      await gate.promise;

      return new Response(historyLines.map((line) => line + "\n").join(""), { status: 200 });
    }

    // An auth endpoint: answer with a token. Bracket-notation keys keep the snake_case wire names from tripping the camelcase lint rule in test source.
    const body: Record<string, unknown> = {};

    body["access_token"] = "fresh.jwt";
    body["token_type"] = "Bearer";

    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  return { fetch: fetchImpl, resolveHistory: (): void => gate.resolve() };
}

describe("runHblog - time range", () => {

  test("--help lists the Time range section with --since and --until", async () => {

    const { options, stdout } = makeOptions({ argv: ["--help"] });
    const code = await runHblog(options);

    assert.equal(code, 0, "--help must exit 0");
    assert.match(stdout.text, /Time range:/, "the help must include the Time range section");
    assert.match(stdout.text, /--since <when>/, "the help must document --since");
    assert.match(stdout.text, /--until <when>/, "the help must document --until");
  });

  test("a one-shot --since filters history to the window, carries continuations, and honors the injected now", async (t) => {

    // The engine's `window` channel now owns the time-bounded selection, and a one-shot's upper bound is `Date.now()` (the snapshot horizon). We pin BOTH clocks to
    // 2026-06-29 13:00 local: `mock.timers` fixes `Date.now()` (the engine horizon) while the same epoch is injected as the CLI `now` (which resolves `--since 1h` to
    // 12:00). The window is therefore `[12:00, 13:00]`: the 10:00 line and its null-timestamp continuation are dropped; the 12:30 line and its continuation are kept (the
    // continuation inherits its in-window parent's instant). An empty socket (no seed) lets the immediate download win the gate, so the one-shot serves the filtered
    // download and ends.
    const now = new Date(2026, 5, 29, 13, 0, 0).getTime();

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now });

    const lines = [

      "[6/29/2026, 10:00:00 AM] [P] before-window",
      "    cont-before",
      "[6/29/2026, 12:30:00 PM] [P] after-window",
      "    cont-after"
    ];

    const { fetch } = fakeFetch({ lines });
    const { options, stdout } = makeOptions({ argv: [ "--token", "abc.jwt", "--since", "1h" ], fetch, now: () => now, socketFactory: new TestLogSocketFactory() });

    const code = await runHblog(options);

    assert.equal(code, 0, "a one-shot windowed history retrieval must exit 0");

    const text = stdout.text;

    assert.ok(text.includes("after-window"), "a line at or after --since must be kept");
    assert.ok(text.includes("cont-after"), "a continuation of an in-window line must be carried through");
    assert.ok(!text.includes("before-window"), "a line before --since must be dropped");
    assert.ok(!text.includes("cont-before"), "a continuation of an out-of-window line must be dropped");
  });

  test("a bare --since keeps until null and never raises a since-after-until error for a future --since (no implicit until = now)", async (t) => {

    // The regression guard for the implicit-`until = now` hazard. With `now` pinned to 2026-06-29 03:00, `--since 7am` resolves to 07:00 - in the FUTURE relative to now.
    // A bare `--since` must keep `until: null` (NOT an implicit `until = now`), so this is NOT a `since > until` usage error; it is a valid one-shot whose engine horizon
    // (03:00) is below `since` (07:00), yielding empty output and a clean exit 0 rather than exit 2.
    const now = new Date(2026, 5, 29, 3, 0, 0).getTime();

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now });

    const lines = [ "[6/29/2026, 1:00:00 AM] [P] one", "[6/29/2026, 2:00:00 AM] [P] two" ];
    const { fetch } = fakeFetch({ lines });
    const { options, stdout } = makeOptions({ argv: [ "--token", "abc.jwt", "--since", "7am" ], fetch, now: () => now, socketFactory: new TestLogSocketFactory() });

    const code = await runHblog(options);

    assert.equal(code, 0, "a future bare --since must be a valid (empty) one-shot, not a since-after-until usage error");
    assert.equal(stdout.text, "", "no line is at or after a future --since, so the output is empty");
  });

  test("--since with --follow seeds a follow-history window and keeps a later live line", async () => {

    // `--since` with `--follow` maps to the window channel (`mode: "window"`, `follow: true`): the socket connects for its seed-plus-live while the REST history
    // downloads, the two are stitched, and the window wraps the stitched stream. The socket here delivers its seed then ENDS (modeling a socket that closed after the
    // seed), so the run terminates naturally after history resolves - no signal-propagation timing is needed. History's 10:00 line is dropped by the window; the 12:30
    // overlap line and the genuinely-new 12:45 live line both survive. That hist-old (history-only, pre-window) is fetched-then-filtered while live-new (socket-only)
    // survives demonstrates both channels ran and were stitched under the window.
    const now = new Date(2026, 5, 29, 13, 0, 0).getTime();
    const history = [ "[6/29/2026, 10:00:00 AM] [P] hist-old", "[6/29/2026, 12:30:00 PM] [P] hist-recent" ];
    const seed = [ "[6/29/2026, 12:30:00 PM] [P] hist-recent", "[6/29/2026, 12:45:00 PM] [P] live-new" ];

    const controller = new AbortController();
    let created = 0;

    const socket: LogSocketLike = {

      abort: (reason?: unknown): void => controller.abort(reason ?? new Error("aborted")),
      aborted: false,
      droppedLines: 0,
      signal: controller.signal,
      stdout: async function *(): AsyncGenerator<string> {

        for(const line of seed) {

          yield line;
        }
      },
      [Symbol.asyncDispose]: async (): Promise<void> => controller.abort(new Error("disposed"))
    };

    const socketFactory: LogSocketFactory = { create: (): LogSocketLike => {

      created++;

      return socket;
    } };

    const { fetch, resolveHistory } = deferredFetch(history);
    const stdout = new CaptureStream();
    const { options } = makeOptions({ argv: [ "--token", "abc.jwt", "--since", "1h", "--follow" ], fetch, now: () => now, socketFactory, stdout });

    const run = runHblog(options);

    // Let the socket buffer its full seed before history resolves, so the stitch overlaps at the shared 12:30 line rather than carrying the seed into the continuation.
    await tick(10);
    resolveHistory();

    const code = await run;

    assert.equal(code, 0, "a --since --follow run whose socket ends must exit 0");
    assert.equal(created, 1, "follow-history must construct exactly one socket");

    const text = stdout.text;

    assert.ok(text.includes("hist-recent"), "the in-window history seed line must be kept");
    assert.ok(text.includes("live-new"), "the later, genuinely-new live line must be kept");
    assert.ok(!text.includes("hist-old"), "a history line before --since must be filtered out of the window");
  });
});

describe("runHblog - time-range usage errors", () => {

  test("an invalid --since is a usage error naming --since (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--since", "lol" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "an unparseable --since must be a usage error");
    assert.match(stderr.text, /--since value "lol"/, "the error must name the --since flag and the offending value");
    assert.match(stderr.text, /Usage: hblog/, "a usage error must print the usage banner");
  });

  test("an invalid --until is a usage error naming --until (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--until", "nope" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "an unparseable --until must be a usage error");
    assert.match(stderr.text, /--until value "nope"/, "the error must name the --until flag and the offending value");
  });

  test("--since later than --until is a usage error (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--since", "2026-06-29", "--until", "2026-06-28" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "an inverted window must be a usage error");
    assert.match(stderr.text, /earlier than/, "the error must explain the ordering requirement");
  });

  test("-n combined with a time range is a usage error (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--since", "1d", "-n", "5" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "combining -n with a time range must be a usage error");
    assert.match(stderr.text, /not both/, "the error must explain -n and a time range are mutually exclusive");
  });

  test("--until combined with --follow is a usage error (exit 2)", async () => {

    const { options, stderr } = makeOptions({ argv: [ "--token", "abc.jwt", "--until", "now", "--follow" ] });
    const code = await runHblog(options);

    assert.equal(code, 2, "--until with --follow must be a usage error");
    assert.match(stderr.text, /--until bounds a closed window/, "the error must explain --until cannot combine with --follow");
  });
});
