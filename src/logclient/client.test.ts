/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/client.test.ts: Unit tests for HomebridgeLogClient - tail() channel selection, follow-history socket-first stitch, leak-free teardown, token lifecycle.
 */
import { HbpuAbortError, onAbort } from "../util.ts";
import type { LogSocketFactory, LogSocketInit, LogSocketLike } from "./socket.ts";
import { assertNoUnhandledRejections, silentLog } from "../testing.helpers.ts";
import { setTimeout as delay, setImmediate as flushImmediate } from "node:timers/promises";
import { describe, test } from "node:test";
import { HomebridgeLogClient } from "./client.ts";
import type { LogRecord } from "./types.ts";
import { LogSocket } from "./socket.ts";
import { TestLogSocketFactory } from "./socket-double.ts";
import { TestWebSocketFactory } from "./socket-double.ts";
import assert from "node:assert/strict";

// A captured fetch call: the URL the auth or REST transport produced. Enough to assert which transport ran.
interface FetchCall {

  url: string;
}

// Yield to the microtask/immediate queue so the client's async steps (token acquisition, socket buffering, history download) settle before assertion.
async function tick(times = 1): Promise<void> {

  for(let index = 0; index < times; index++) {

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
}

// Build a server-shaped auth success body carrying an access token, assembled with bracket-notation keys so the snake_case wire field names do not trip the camelcase
// lint rule in test source (the production auth code reads these same fields via string index access for the same reason).
function tokenBody(token: string): Record<string, unknown> {

  const body: Record<string, unknown> = {};

  body["access_token"] = token;
  body["expires_in"] = 28800;
  body["token_type"] = "Bearer";

  return body;
}

// Build a 200 `Response` whose body streams the supplied raw log lines (terminated, so the splitter yields each as a complete line). Used as the REST history payload.
function logResponse(lines: readonly string[]): Response {

  const encoder = new TextEncoder();
  const text = lines.map((line) => line + "\n").join("");

  const body = new ReadableStream<Uint8Array>({

    start(controller): void {

      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });

  return new Response(body, { status: 200 });
}

// Build a `fetch` seam double whose REST log-download responses resolve only when the returned `resolveHistory` is invoked. Auth endpoints (login/noauth) resolve
// immediately with a token so the token-provider closure never blocks. The deferred history lets a follow-history test buffer the socket's full seed before history
// finishes, making the socket-first ordering deterministic rather than timing-dependent.
function deferredFetch(historyLines: readonly string[]): { calls: FetchCall[]; fetch: typeof fetch; resolveHistory: () => void } {

  const calls: FetchCall[] = [];
  const gate: PromiseWithResolvers<void> = Promise.withResolvers();

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {

    const url = (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;

    calls.push({ url });

    // The REST history download waits behind the gate so a test controls when it finishes; auth endpoints answer immediately with a token.
    if(url.includes("/log/download")) {

      await gate.promise;

      return logResponse(historyLines);
    }

    return new Response(JSON.stringify(tokenBody("fresh.jwt")), { status: 200 });
  }) as typeof fetch;

  return { calls, fetch: fetchImpl, resolveHistory: (): void => gate.resolve() };
}

// Build a `fetch` seam double whose REST log-download responds immediately (no gate). Auth endpoints answer with a token. The captured calls let a test assert whether
// the REST channel was exercised at all.
function immediateFetch(historyLines: readonly string[] = []): { calls: FetchCall[]; fetch: typeof fetch } {

  const calls: FetchCall[] = [];

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {

    const url = (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;

    calls.push({ url });

    if(url.includes("/log/download")) {

      return logResponse(historyLines);
    }

    return new Response(JSON.stringify(tokenBody("fresh.jwt")), { status: 200 });
  }) as typeof fetch;

  return { calls, fetch: fetchImpl };
}

// Collect up to `limit` records from a stream, breaking once the limit is reached (which disposes the stream's per-call socket via the generator's `finally`). When
// `limit` is omitted the stream is drained to completion.
async function collect(stream: AsyncIterable<LogRecord>, limit?: number): Promise<LogRecord[]> {

  const records: LogRecord[] = [];

  for await (const record of stream) {

    records.push(record);

    if((limit !== undefined) && (records.length >= limit)) {

      break;
    }
  }

  return records;
}

describe("HomebridgeLogClient - tail channel selection", () => {

  test("history mode uses the REST channel and never opens a socket", async () => {

    const factory = new TestLogSocketFactory();
    const { calls, fetch } = immediateFetch([ "[6/29/2026, 12:00:00 PM] [P] one", "[6/29/2026, 12:00:00 PM] [P] two", "[6/29/2026, 12:00:00 PM] [P] three" ]);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const records = await collect(client.tail({ mode: "history", quantity: "all" }));

    assert.deepEqual(records.map((record) => record.message), [ "one", "two", "three" ], "history mode must deliver the REST whole-file download");
    assert.equal(factory.createCalls.length, 0, "history mode must never construct a socket");
    assert.ok(calls.some((call) => call.url.includes("/log/download")), "history mode must hit the REST download endpoint");
  });

  test("history mode with a numeric quantity retains only the most recent N records", async () => {

    const factory = new TestLogSocketFactory();
    const { fetch } = immediateFetch([ "[6/29/2026, 12:00:00 PM] [P] one", "[6/29/2026, 12:00:00 PM] [P] two",
      "[6/29/2026, 12:00:00 PM] [P] three", "[6/29/2026, 12:00:00 PM] [P] four" ]);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const records = await collect(client.tail({ mode: "history", quantity: 2 }));

    assert.deepEqual(records.map((record) => record.message), [ "three", "four" ], "a numeric quantity must retain only the most recent N records");
  });

  test("follow mode uses the socket channel and never hits REST", async () => {

    const socketLines = [ "[6/29/2026, 12:00:00 PM] [P] live one", "[6/29/2026, 12:00:00 PM] [P] live two" ];
    const { calls, fetch } = immediateFetch();

    // Pre-seed the single socket the factory hands out with the live lines it should yield.
    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: socketLines });
    const factory = new TestLogSocketFactory(preset);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const records = await collect(client.tail({ mode: "follow" }), 2);

    assert.deepEqual(records.map((record) => record.message), [ "live one", "live two" ], "follow mode must deliver the socket's live lines");
    assert.equal(factory.createCalls.length, 1, "follow mode must construct exactly one socket");
    assert.equal(calls.filter((call) => call.url.includes("/log/download")).length, 0, "follow mode must never hit the REST download endpoint");
  });

  test("follow mode drops the byte-seeded seed's leading fragment and preamble, starting at the first real entry", async () => {

    // The server seeds a native/file tail from a byte offset, so the raw stream opens with its `Loading logs...` / `File: ...` preamble, a blank line, and a truncated
    // fragment (the tail end of the line the offset cut through), before the first genuine entry. The seed gate must suppress all of that and deliver the log from the
    // first real `[timestamp]` line onward - the continuation line that follows a real entry still flows through, because the gate never re-closes once open.
    const socketLines = [
      "Loading logs using native method...",
      "File: /Users/hjd/.homebridge/homebridge.log",
      "",
      "e frame RPS.",
      "[6/29/2026, 12:00:00 PM] [P] first real entry",
      "    a continuation of the first entry",
      "[6/29/2026, 12:00:01 PM] [P] second real entry"
    ];
    const { fetch } = immediateFetch();

    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: socketLines });
    const factory = new TestLogSocketFactory(preset);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const records = await collect(client.tail({ mode: "follow" }), 3);

    assert.deepEqual(records.map((record) => record.message), [ "first real entry", "    a continuation of the first entry", "second real entry" ],
      "the follow stream must start at the first real entry, dropping the preamble and truncated fragment while keeping post-entry continuation lines");
  });
});

describe("HomebridgeLogClient - follow-history socket-first stitch", () => {

  test("buffers the socket seed first, then stitches history at the minimal overlap, then continues live", async () => {

    // History (oldest first) is A, B, C; the socket seed B, C overlaps history's tail and D is a genuinely new live line. The socket-first join must buffer the seed
    // before history finishes (the deferred fetch guarantees that), stitch at the 2-line overlap, and emit A, B, C, D with no dropped or extra line at the boundary.
    const historyLines = [ "[6/29/2026, 12:00:00 PM] [P] A", "[6/29/2026, 12:00:00 PM] [P] B", "[6/29/2026, 12:00:00 PM] [P] C" ];
    const seedLines = [ "[6/29/2026, 12:00:00 PM] [P] B", "[6/29/2026, 12:00:00 PM] [P] C", "[6/29/2026, 12:00:00 PM] [P] D" ];

    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: seedLines });
    const factory = new TestLogSocketFactory(preset);
    const { fetch, resolveHistory } = deferredFetch(historyLines);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const stream = client.tail({ mode: "follow-history", quantity: "all" });
    const collected = collect(stream, 4);

    // Let the socket yield its full seed into the buffer before history resolves, so the seed is buffered (not carried into the live continuation) and the ordering is
    // deterministic.
    await tick(10);

    resolveHistory();

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "A", "B", "C", "D" ],
      "follow-history must stitch at the minimal overlap so history is followed by exactly the new live lines");
    assert.equal(factory.createCalls.length, 1, "follow-history must construct exactly one socket");

    await stream[Symbol.asyncDispose]();
  });

  test("carries the in-flight live pull across the stitch boundary and continues the live stream", async () => {

    // A controllable socket double that yields its seed, then suspends on a release gate (modeling a live tail quiescent after its seed), then yields continuation lines.
    // This deterministically exercises the post-stitch live-continuation path: the pull outstanding when history finishes must become the first continuation line, with
    // no line lost or double-counted at the boundary.
    const release: PromiseWithResolvers<void> = Promise.withResolvers();

    const controller = new AbortController();
    const socket: LogSocketLike = {

      abort: (reason?: unknown): void => controller.abort(reason ?? new Error("aborted")),
      aborted: false,
      droppedLines: 0,
      signal: controller.signal,
      stdout: async function *(): AsyncGenerator<string> {

        yield "[6/29/2026, 12:00:00 PM] [P] B";
        yield "[6/29/2026, 12:00:00 PM] [P] C";

        // Suspend until the test releases the continuation, mirroring a live stream that has delivered its seed and is awaiting genuinely new lines.
        await release.promise;

        yield "[6/29/2026, 12:00:00 PM] [P] D";
        yield "[6/29/2026, 12:00:00 PM] [P] E";
      },
      [Symbol.asyncDispose]: async (): Promise<void> => controller.abort(new Error("disposed"))
    };

    const factory: LogSocketFactory = { create: (): LogSocketLike => socket };
    const { fetch, resolveHistory } = deferredFetch([ "[6/29/2026, 12:00:00 PM] [P] A", "[6/29/2026, 12:00:00 PM] [P] B", "[6/29/2026, 12:00:00 PM] [P] C" ]);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const stream = client.tail({ mode: "follow-history", quantity: "all" });
    const collected = collect(stream, 5);

    // Buffer the seed (B, C), then finish history while the next pull is outstanding (the socket is suspended on the release gate). The buffering loop must break with
    // that pull in flight and carry it into the continuation.
    await tick(6);

    resolveHistory();
    await tick(6);

    // Release the continuation so the carried in-flight pull resolves to D, followed by E.
    release.resolve();

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "A", "B", "C", "D", "E" ],
      "the in-flight pull must become the first continuation line, and the live stream must continue without dropping or duplicating a line");

    await stream[Symbol.asyncDispose]();
  });

  test("trims history to the requested numeric quantity before stitching", async () => {

    // History has four lines but the request asks for the most recent two (C, D); the socket seed C, D overlaps that trimmed tail and E is new. The trimmed history must
    // be the stitch basis, so the output is exactly C, D, E - the older A, B are excluded by the quantity, and no live line is dropped at the boundary.
    const historyLines = [ "[6/29/2026, 12:00:00 PM] [P] A", "[6/29/2026, 12:00:00 PM] [P] B", "[6/29/2026, 12:00:00 PM] [P] C", "[6/29/2026, 12:00:00 PM] [P] D" ];
    const seedLines = [ "[6/29/2026, 12:00:00 PM] [P] C", "[6/29/2026, 12:00:00 PM] [P] D", "[6/29/2026, 12:00:00 PM] [P] E" ];

    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: seedLines });
    const factory = new TestLogSocketFactory(preset);
    const { fetch, resolveHistory } = deferredFetch(historyLines);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const stream = client.tail({ mode: "follow-history", quantity: 2 });
    const collected = collect(stream, 3);

    await tick(10);

    resolveHistory();

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "C", "D", "E" ],
      "a numeric follow-history quantity must trim history to the most recent N before the stitch");

    await stream[Symbol.asyncDispose]();
  });

  test("breaks the buffering loop when the socket closes before history finishes, then still stitches", async () => {

    // The socket yields its seed (B, C) and then ENDS (the server closed the connection) while the REST history is still downloading behind the gate. The buffering loop
    // must break on the socket end (liveDone) rather than wait forever; once history resolves, the stitch is still served, with no continuation (the socket is gone).
    // A controllable socket whose `stdout()` returns after the seed models the closed connection.
    const controller = new AbortController();
    const socket: LogSocketLike = {

      abort: (reason?: unknown): void => controller.abort(reason ?? new Error("aborted")),
      aborted: false,
      droppedLines: 0,
      signal: controller.signal,
      stdout: async function *(): AsyncGenerator<string> {

        yield "[6/29/2026, 12:00:00 PM] [P] B";
        yield "[6/29/2026, 12:00:00 PM] [P] C";
      },
      [Symbol.asyncDispose]: async (): Promise<void> => controller.abort(new Error("disposed"))
    };

    const factory: LogSocketFactory = { create: (): LogSocketLike => socket };
    const { fetch, resolveHistory } = deferredFetch([ "[6/29/2026, 12:00:00 PM] [P] A", "[6/29/2026, 12:00:00 PM] [P] B", "[6/29/2026, 12:00:00 PM] [P] C" ]);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const stream = client.tail({ mode: "follow-history", quantity: "all" });
    const collected = collect(stream, 3);

    // Let the socket yield B, C and then END (its generator returns), so the buffering loop breaks on the done result before history is released.
    await tick(6);
    resolveHistory();

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "A", "B", "C" ],
      "a socket that closes mid-buffer must still produce the stitched history-plus-seed with no live continuation");

    await stream[Symbol.asyncDispose]();
  });
});

describe("HomebridgeLogClient - leak-free teardown", () => {

  test("an early break disposes the per-call socket rather than leaking it", async () => {

    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: [ "[6/29/2026, 12:00:00 PM] [P] first", "[6/29/2026, 12:00:00 PM] [P] second", "[6/29/2026, 12:00:00 PM] [P] third" ] });
    const factory = new TestLogSocketFactory(preset);
    const { fetch } = immediateFetch();

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    // Break after a single record; the generator's `finally` must dispose the per-call socket.
    await collect(client.follow(), 1);

    const created = factory.createCalls[0];

    assert.ok(created !== undefined, "follow must construct a socket");
    assert.equal(created.socket.aborted, true, "an early break must dispose (abort) the per-call socket, not leak it");
    assert.ok(created.socket.abortCalls.length > 0, "disposal must have invoked abort on the per-call socket");
  });

  test("reports its lifetime via the aborted getter and aborts on disposal", async () => {

    const factory = new TestLogSocketFactory();
    const { fetch } = immediateFetch();

    const client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    assert.equal(client.aborted, false, "a fresh client must not be aborted");

    await client[Symbol.asyncDispose]();

    assert.equal(client.aborted, true, "disposing the client must abort its lifetime signal");

    // Disposal is idempotent: a second disposal must not throw or change the settled reason.
    await client[Symbol.asyncDispose]();

    assert.equal(client.aborted, true, "a second disposal must be a safe no-op");
  });
});

describe("HomebridgeLogClient - token lifecycle", () => {

  test("password credentials re-authenticate on every connect (the socket gets a fresh token provider invocation)", async () => {

    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: ["[6/29/2026, 12:00:00 PM] [P] live"] });
    const factory = new TestLogSocketFactory(preset);
    const { calls, fetch } = immediateFetch();

    await using client = new HomebridgeLogClient({

      credentials: { kind: "password", password: "secret", username: "admin" },
      fetch,
      log: silentLog(),
      socketFactory: factory
    });

    // Start a follow stream so the client constructs a socket through the factory; the socket is the carrier of the token-provider closure the client builds once.
    await using stream = client.follow();
    const drained = collect(stream, 1);

    await tick(2);

    // The socket is constructed with a token provider; invoking it must re-authenticate via the login endpoint and return a fresh token. We invoke it twice (modeling two
    // connect attempts) and assert each one re-hits the auth endpoint - i.e., there is no static caching that would skip re-auth on reconnect.
    const created = factory.createCalls[0];

    assert.ok(created !== undefined);

    const tokenA = await created.init.tokenProvider(client.signal);
    const tokenB = await created.init.tokenProvider(client.signal);

    assert.equal(tokenA, "fresh.jwt", "password credentials must acquire a token from the login endpoint");
    assert.equal(tokenB, "fresh.jwt");
    assert.equal(calls.filter((call) => call.url.includes("/api/auth/login")).length, 2,
      "each connect must re-authenticate via the login endpoint (refresh on reconnect)");

    await drained;
  });

  test("a static token credential returns the same token verbatim with no network call (no refresh)", async () => {

    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: ["[6/29/2026, 12:00:00 PM] [P] live"] });
    const factory = new TestLogSocketFactory(preset);
    const { calls, fetch } = immediateFetch();

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "static.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    // Start a follow stream so the client constructs a socket carrying the token-provider closure.
    await using stream = client.follow();
    const drained = collect(stream, 1);

    await tick(2);

    const created = factory.createCalls[0];

    assert.ok(created !== undefined);

    const tokenA = await created.init.tokenProvider(client.signal);
    const tokenB = await created.init.tokenProvider(client.signal);

    assert.equal(tokenA, "static.jwt", "a static token must be returned verbatim");
    assert.equal(tokenB, "static.jwt", "a static token must be returned verbatim on every invocation");
    assert.equal(calls.filter((call) => call.url.includes("/api/auth")).length, 0, "a static token must never hit any auth endpoint (no refresh)");

    await drained;
  });

  test("a static-token client whose socket handshake is rejected ends terminally rather than spinning", async () => {

    // Drive a REAL LogSocket (through the WebSocket seam) from the client so the end-to-end token-lifecycle remediation is exercised: the client derives `refreshable:
    // false` from the static `token` credential, the socket raises a permanent LogAuthError on the handshake rejection, and the connect-phase veto makes the socket abort
    // terminally. The `follow()` stream's iteration therefore ends rather than reconnecting forever against a doomed token.
    const wsFactory = new TestWebSocketFactory();

    const socketFactory: LogSocketFactory = {

      // The client populates the init (including `refreshable`, derived from the credential); we forward it to a real LogSocket but inject the WebSocket seam and a
      // near-zero backoff so the (would-be) reconnect runs without real waits.
      create: (init: LogSocketInit): LogSocketLike => new LogSocket({ ...init, backoff: () => 0, webSocketFactory: wsFactory.create })
    };

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "static.jwt" }, log: silentLog(), socketFactory });

    // Iterate the follow stream to completion. If the remediation regressed (infinite reconnect), this would never resolve; the terminal abort is what lets it return.
    const followDone = (async (): Promise<void> => {

      for await (const _record of client.follow()) {

        // No records are delivered; the loop exists only to observe that the stream terminates when the socket aborts terminally.
      }
    })();

    await flushImmediate();

    const ws0 = wsFactory.sockets[0];

    assert.ok(ws0 !== undefined, "the follow channel must construct a WebSocket for its single connect attempt");

    // Complete the Engine.IO open handshake, then reject the namespace join with a CONNECT_ERROR. With a non-refreshable static token this is permanent.
    ws0.emitOpen();
    ws0.emitMessage("0{\"sid\":\"s1\",\"pingInterval\":25000,\"pingTimeout\":20000}");
    await flushImmediate();
    ws0.emitMessage("44/log,{\"message\":\"unauthorized\"}");

    // A short real delay lets the connect-phase `retry` settle its veto and the socket abort; then the follow stream's iteration unwinds.
    await delay(20);
    await followDone;

    assert.equal(wsFactory.sockets.length, 1, "a static-token handshake rejection must be terminal - no second WebSocket (no infinite reconnect spin)");
  });
});

// The fixed snapshot horizon for the windowed-channel tests: 2026-06-29 12:00:00 local. Each test enables `mock.timers` with this as `now`, so the engine's
// `horizonNow = Date.now()` and a one-shot's upper bound resolve to noon, while log-line timestamps (parsed from explicit M/D/YYYY strings, which `mock.timers` does NOT
// rewrite) are authored relative to it. A bare `--since` therefore filters to `[since, noon]`.
const WINDOW_HORIZON = new Date(2026, 5, 29, 12, 0, 0).getTime();

// The wall-clock terminator constants, mirrored from settings.ts so the timing assertions read against named values rather than magic numbers.
const SEED_SETTLE_MS = 1000;
const SEED_WINDOW_MAX_MS = 5000;

// The epoch of a given local clock time on 2026-06-29, for authoring a window's `since`/`until` bounds relative to WINDOW_HORIZON.
function epochAt(hour: number, minute: number): number {

  return new Date(2026, 5, 29, hour, minute, 0).getTime();
}

// Build an en-US-formatted Homebridge log line at the given local clock time on 2026-06-29 carrying `message`, so its parsed instant is deterministic relative to
// WINDOW_HORIZON. `hour` is 24-hour; the rendered clock is 12-hour with a meridiem, matching the parser's recognized en-US default.
function line(hour: number, minute: number, message: string): string {

  const meridiem = (hour < 12) ? "AM" : "PM";
  const hour12 = ((hour % 12) === 0) ? 12 : (hour % 12);

  return "[6/29/2026, " + hour12.toString() + ":" + minute.toString().padStart(2, "0") + ":00 " + meridiem + "] [P] " + message;
}

// A scripted LogSocketLike for the windowed-channel tests. `stdout()` yields each line in `initial` (oldest-first), then either ENDS (when `end` is set, modeling a
// socket that closed after its seed) or PARKS awaiting `feed()`/`end()`/abort (modeling a live tail). `feed(text)` pushes a further line and wakes the consumer; `end()`
// ends the stream. It aborts a real signal and records every abort reason, so a test can assert the terminator aborted the socket and no stale timer re-aborts it.
class ScriptedSocket implements LogSocketLike {

  public readonly abortReasons: unknown[] = [];
  public readonly droppedLines = 0;

  readonly #controller = new AbortController();
  #ended: boolean;
  readonly #queue: string[];
  #waiter: PromiseWithResolvers<void> | undefined;

  public constructor(initial: readonly string[] = [], options: { end?: boolean } = {}) {

    this.#ended = options.end ?? false;
    this.#queue = [...initial];
  }

  public abort(reason?: unknown): void {

    this.abortReasons.push(reason);
    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
    this.#waiter?.resolve();
  }

  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort(new HbpuAbortError("shutdown"));
  }

  public get aborted(): boolean {

    return this.#controller.signal.aborted;
  }

  public get signal(): AbortSignal {

    return this.#controller.signal;
  }

  public end(): void {

    this.#ended = true;
    this.#waiter?.resolve();
  }

  public feed(text: string): void {

    this.#queue.push(text);
    this.#waiter?.resolve();
  }

  public async *stdout(): AsyncGenerator<string> {

    for(;;) {

      while(this.#queue.length > 0) {

        if(this.#controller.signal.aborted) {

          return;
        }

        const next = this.#queue.shift();

        if(next !== undefined) {

          yield next;
        }
      }

      if(this.#controller.signal.aborted || this.#ended) {

        return;
      }

      const waiter: PromiseWithResolvers<void> = Promise.withResolvers();

      this.#waiter = waiter;

      using _registration = onAbort(this.#controller.signal, () => waiter.resolve());

      // eslint-disable-next-line no-await-in-loop
      await waiter.promise;

      this.#waiter = undefined;
    }
  }
}

// What the windowed-channel `fetch` double exposes back to a test.
//
// @property downloadAbortReason - The reason on the signal the download forwarded to `fetch`, or `undefined` if it has not aborted. A seed-covers supersession aborts the
//                                 download's own child controller with `HbpuAbortError("replaced")` DURING the run, distinct from the `"shutdown"` the teardown later
//                                 issues, so a test discriminates "superseded early" from "torn down at the end" by the reason rather than by mere aborted-ness.
// @property downloadStarted     - Whether the `/log/download` request was issued at all.
// @property fetch               - The `fetch` seam to inject.
interface WindowFetch {

  downloadAbortReason: () => unknown;
  downloadStarted: () => boolean;
  fetch: typeof fetch;
}

// Build the windowed-channel `fetch` double. Auth endpoints answer with a token immediately. The `/log/download` response models one of three speculative-download
// outcomes: "open" enqueues `historyLines` but never closes (the download stays in flight until the seed-covers path aborts it, at which point its body is errored,
// mirroring undici tearing a request down); "complete" enqueues `historyLines` and closes (the download resolves, the no-cover fallback's basis); "reject" returns HTTP
// 400 (the systemd/custom "no log file" case). An optional `gate` defers the response so a test can let the seed fully buffer before the download settles. The forwarded
// signal and whether the request was issued are captured, so a test asserts the speculative download was superseded.
function windowFetch(options: { gate?: Promise<void>; historyLines?: readonly string[]; mode: "complete" | "open" | "reject" }): WindowFetch {

  const encoder = new TextEncoder();
  const historyLines = options.historyLines ?? [];
  let downloadSignal: AbortSignal | undefined;
  let started = false;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {

    const url = (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;

    if(!url.includes("/log/download")) {

      const body: Record<string, unknown> = {};

      body["access_token"] = "fresh.jwt";
      body["token_type"] = "Bearer";

      return new Response(JSON.stringify(body), { status: 200 });
    }

    started = true;
    downloadSignal = init?.signal ?? undefined;

    if(options.gate !== undefined) {

      await options.gate;
    }

    if(options.mode === "reject") {

      return new Response("Bad Request", { status: 400 });
    }

    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    const stream = new ReadableStream<Uint8Array>({

      start(controller): void {

        streamController = controller;

        for(const text of historyLines) {

          controller.enqueue(encoder.encode(text + "\n"));
        }

        if(options.mode === "complete") {

          controller.close();
        }
      }
    });

    // An "open" download never closes on its own; mirror undici by erroring its body when the forwarded signal aborts, so the consumer's read rejects and the speculative
    // collection settles (its rejection neutralized by the channel) rather than draining forever.
    const signal = init?.signal ?? undefined;

    if((options.mode === "open") && (signal !== undefined)) {

      signal.addEventListener("abort", () => {

        try {

          streamController?.error(signal.reason);
        } catch {

          // The body may already be closed; erroring a closed stream is a harmless no-op for the test.
        }
      }, { once: true });
    }

    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  return { downloadAbortReason: (): unknown => (downloadSignal?.aborted === true) ? downloadSignal.reason : undefined, downloadStarted: (): boolean => started,
    fetch: fetchImpl };
}

// Build a HomebridgeLogClient wired to a fixed windowed-channel socket and `fetch` double, using a static-token credential so no auth round-trip is needed.
function windowClient(fetchImpl: typeof fetch, socket: LogSocketLike): HomebridgeLogClient {

  return new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch: fetchImpl, log: silentLog(),
    socketFactory: { create: (): LogSocketLike => socket } });
}

describe("HomebridgeLogClient - window channel (hedged seed)", () => {

  test("seed-covers serves the window from the seed, aborts the download, and continues live", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The seed's oldest line (10:00) strictly precedes `since` (11:00), so the seed covers `[11:00, noon]`. The never-closing, distinctively-tagged download must be
    // aborted and must never reach the output; the in-window seed line and a later live line are served, the pre-window seed line filtered out.
    const socket = new ScriptedSocket([ line(10, 0, "pre"), line(11, 30, "in-window"), line(11, 45, "live-new") ], { end: true });
    const download = windowFetch({ historyLines: [line(9, 0, "DOWNLOAD-LEAK")], mode: "open" });

    await using client = windowClient(download.fetch, socket);

    const records = await collect(client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null }));

    assert.deepEqual(records.map((record) => record.message), [ "in-window", "live-new" ], "the seed must serve the in-window line and the later live line");
    assert.ok(!records.some((record) => record.message === "DOWNLOAD-LEAK"), "the aborted speculative download must never reach the output");
    assert.equal(download.downloadStarted(), true, "the speculative download must have started");

    const reason = download.downloadAbortReason();

    assert.ok((reason instanceof HbpuAbortError) && (reason.name === "replaced"),
      "the seed-covers decision must abort the speculative download with the supersession reason, not merely tear it down at the end");
  });

  test("a completed download before any seed decision is used (no spin, no hang)", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // An empty socket parks immediately, so no seed line ever decides; the completing download therefore wins the gate's race and is used as the no-cover basis. The
    // one-shot ends after the download is served (no live continuation), so the run completes without the terminator firing.
    const socket = new ScriptedSocket([]);
    const download = windowFetch({ historyLines: [ line(8, 30, "h-0830"), line(9, 30, "h-0930"), line(10, 0, "h-1000") ], mode: "complete" });

    await using client = windowClient(download.fetch, socket);

    const records = await collect(client.tail({ follow: false, mode: "window", since: epochAt(9, 0), until: null }));

    assert.deepEqual(records.map((record) => record.message), [ "h-0930", "h-1000" ], "the completed download is served, filtered to the window");

    const reason = download.downloadAbortReason();

    assert.ok(!((reason instanceof HbpuAbortError) && (reason.name === "replaced")), "a used (no-cover) download must NOT be superseded by a seed-covers abort");
  });

  test("a deep (no-cover) one-shot stitches the download with the FULL buffered seed, no spurious gap marker", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // `since` (9:00) precedes the seed's oldest line (10:00), so the seed does NOT cover the window - the download (reaching back before 9:00) is the basis. The gate
    // must buffer the FULL seed (10:00, 10:30, 11:00) so `stitchLive` aligns on the three-line overlap rather than manufacturing a gap marker from a single-line buffer.
    const seed = [ line(10, 0, "s-10"), line(10, 30, "s-1030"), line(11, 0, "s-11") ];
    const history = [ line(8, 30, "h-0830"), line(9, 30, "h-0930"), line(10, 0, "s-10"), line(10, 30, "s-1030"), line(11, 0, "s-11") ];
    const socket = new ScriptedSocket(seed, { end: true });
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const download = windowFetch({ gate: gate.promise, historyLines: history, mode: "complete" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: false, mode: "window", since: epochAt(9, 0), until: null }));

    // Let the full seed buffer (the socket ends, so the gate loop drains it and parks on `await downloadPromise`) before releasing the download.
    await tick(10);
    gate.resolve();

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "h-0930", "s-10", "s-1030", "s-11" ],
      "a deep window stitches the download with the full seed and filters to the window");
    assert.ok(!records.some((record) => record.message.includes("could not be aligned")), "the full-seed stitch must NOT manufacture a gap marker");
  });

  test("a quiet seed-covers one-shot terminates at the settle floor, not the hard cap", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The seed covers `[11:00, noon]` and the socket then goes quiet (parks). The wall-clock terminator must end the one-shot at roughly the settle floor - below the
    // hard cap - so advancing past the floor (plus a quiescence interval) terminates while advancing only a fraction of the cap.
    const socket = new ScriptedSocket([ line(10, 0, "pre"), line(11, 30, "in-window") ]);
    const download = windowFetch({ mode: "open" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null }));

    // Let the gate decide and the seed serve, so the continuation parks with the terminator armed.
    await tick(10);

    // Advance past the settle floor plus a quiescence interval (still far below the cap); the quiescence terminator must fire and end the one-shot.
    t.mock.timers.tick(SEED_SETTLE_MS + 300);

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), ["in-window"], "the quiet one-shot serves the in-window seed line then terminates at the floor");
    assert.equal(socket.aborted, true, "the terminator must have aborted the socket");
  });

  test("a window whose socket ends before any decision falls back to the download", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The socket ends immediately (no seed), so no coverage decision is reached; the channel awaits the download and serves it filtered to the window.
    const socket = new ScriptedSocket([], { end: true });
    const download = windowFetch({ historyLines: [ line(8, 30, "h-0830"), line(11, 0, "h-1100") ], mode: "complete" });

    await using client = windowClient(download.fetch, socket);

    const records = await collect(client.tail({ follow: false, mode: "window", since: epochAt(10, 0), until: null }));

    assert.deepEqual(records.map((record) => record.message), ["h-1100"], "the download fallback serves, filtered to the window (h-0830 precedes since)");
  });

  test("a download that fails before the seed decides does not pre-empt a seed-servable window (Phase 2)", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The download FAILS (a systemd/custom 400) before the seed's first parseable line arrives, so the gate latches the failure and hands off to the bounded seed-only
    // Phase 2. The seed (fed after the failure) covers the window, which Phase 2 must serve: a failed download must not throw away a seed-servable window.
    const socket = new ScriptedSocket([]);
    const download = windowFetch({ mode: "reject" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null }));

    // Let the download fail and the gate enter Phase 2 (awaiting the parked seed pull), then feed a leading null-timestamp orphan and a covering seed line. The seed
    // gate drops the orphan upstream, so Phase 2's first parked pull resolves to the covering line directly; `pre` (10:00) is out of the window and `in-window` is kept.
    await tick(10);
    socket.feed("    an orphan continuation with no timestamp");
    socket.feed(line(10, 0, "pre"));
    socket.feed(line(11, 30, "in-window"));
    await tick(5);
    socket.end();

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), ["in-window"],
      "Phase 2 must serve the covering seed despite the failed download, with the orphan gate-dropped");
  });

  test("a deep window whose download fails AFTER the seed is shown not to cover surfaces the actionable error", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The download fails before any seed line, so the gate enters Phase 2; the fed seed line (11:00) does NOT reach back to `since` (10:00), so the seed cannot cover
    // the deep window either. With neither source able to serve, Phase 2 surfaces the download's actionable error rather than serving a partial window.
    const socket = new ScriptedSocket([]);
    const download = windowFetch({ mode: "reject" });

    await using client = windowClient(download.fetch, socket);

    const stream = client.tail({ follow: false, mode: "window", since: epochAt(10, 0), until: null });

    const rejection = assert.rejects(collect(stream), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.match(error.message, /no log file/i, "the surfaced error must be the download's actionable message");

      return true;
    });

    await tick(10);
    socket.feed(line(11, 0, "s-11"));

    await rejection;
  });

  test("a window whose download fails and whose socket then ends in Phase 2 surfaces the actionable error", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The download fails before any seed line (the gate enters Phase 2), then the socket ENDS with no parseable line. Phase 2 must surface the actionable error, not
    // hang on a pull that will never resolve.
    const socket = new ScriptedSocket([]);
    const download = windowFetch({ mode: "reject" });

    await using client = windowClient(download.fetch, socket);

    const stream = client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null });

    const rejection = assert.rejects(collect(stream), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.match(error.message, /no log file/i, "the surfaced error must be the download's actionable message");

      return true;
    });

    await tick(10);
    socket.end();

    await rejection;
  });

  test("an undecidable seed against a failed download surfaces the actionable error at the gate deadline without hanging", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The download fails AND the only seed line is a null-timestamp orphan (which the seed gate drops upstream) AND the socket never ends, so no parseable line ever
    // reaches Phase 2. Phase 2 must NOT hang: at its wall-clock deadline it surfaces the download's actionable error rather than awaiting a line that never comes.
    const socket = new ScriptedSocket(["    an orphan continuation line with no timestamp"]);
    const download = windowFetch({ mode: "reject" });

    await using client = windowClient(download.fetch, socket);

    const stream = client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null });

    const rejection = assert.rejects(collect(stream), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.match(error.message, /no log file/i, "the surfaced error must be the download's actionable message");

      return true;
    });

    // Let the download fail and Phase 2 park on a pull that never resolves (the gate drops the orphan and the socket never ends), then fire the wall-clock gate deadline.
    await tick(10);
    t.mock.timers.tick(SEED_WINDOW_MAX_MS + 1);

    await rejection;
  });

  test("a --until-only (since === null) one-shot buffers until the download, serves it stitched, and terminates", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // `since === null` (a bare `--until`) is never covered by the recent seed, so the channel buffers seed-plus-live until the download resolves, stitches, and serves
    // filtered to `[.., until]`. The socket ends after its seed so the one-shot completes naturally.
    const seed = [ line(10, 0, "s-10"), line(10, 30, "s-1030") ];
    const history = [ line(9, 0, "h-0900"), line(10, 0, "s-10"), line(10, 30, "s-1030") ];
    const socket = new ScriptedSocket(seed, { end: true });
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const download = windowFetch({ gate: gate.promise, historyLines: history, mode: "complete" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: false, mode: "window", since: null, until: epochAt(10, 15) }));

    await tick(10);
    gate.resolve();

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "h-0900", "s-10" ],
      "the --until-only window serves the download stitched with the seed, filtered at until (s-1030 at 10:30 exceeds the 10:15 bound)");
  });

  test("a no-cover follow window stitches the download then continues live", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    // The seed's oldest line (11:00) does not reach back to `since` (10:00), so the window is deep (no-cover): the download is the basis, stitched with the full seed,
    // the live stream then continues.
    const seed = [ line(11, 0, "s-11"), line(11, 30, "s-1130") ];
    const history = [ line(9, 0, "h-0900"), line(11, 0, "s-11"), line(11, 30, "s-1130") ];
    const socket = new ScriptedSocket(seed);
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const download = windowFetch({ gate: gate.promise, historyLines: history, mode: "complete" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: true, mode: "window", since: epochAt(10, 0), until: null }), 4);

    // Buffer the full seed, release the download (no-cover serve of the stitch), then feed two genuinely-new live lines the follow continuation must deliver in order.
    await tick(10);
    gate.resolve();
    await tick(5);
    socket.feed(line(11, 45, "live-new"));
    await tick(2);
    socket.feed(line(11, 50, "live-later"));

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "s-11", "s-1130", "live-new", "live-later" ],
      "a no-cover follow window serves the stitched window then continues live in order (h-0900 precedes since)");
  });

  test("a quiet seed-covers one-shot does not truncate on a sub-settle intra-burst gap", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    const socket = new ScriptedSocket([ line(10, 0, "pre"), line(11, 30, "in-window") ]);
    const download = windowFetch({ mode: "open" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null }));

    await tick(10);

    // A gap shorter than the settle floor must NOT terminate the one-shot: advance 600 ms (below the 1000 ms floor), then a late in-window line arrives and is served.
    t.mock.timers.tick(600);
    socket.feed(line(11, 50, "late-in-window"));
    await tick(5);

    // Now go quiet well past the floor; the one-shot terminates, having kept the post-gap line.
    t.mock.timers.tick(SEED_SETTLE_MS + 500);

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "in-window", "late-in-window" ],
      "a line arriving after a sub-settle gap must NOT be truncated by a premature terminator");
  });

  test("a busy seed-covers one-shot terminates at the hard cap", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    const socket = new ScriptedSocket([ line(10, 0, "pre"), line(11, 30, "in-window") ]);
    const download = windowFetch({ mode: "open" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null }));

    await tick(10);

    // Keep feeding post-horizon source lines closer together than the quiescence interval, so quiescence keeps re-arming and never fires; the hard cap must terminate.
    for(let elapsed = 0; elapsed < SEED_WINDOW_MAX_MS; elapsed += 200) {

      socket.feed(line(12, 30, "post-horizon"));

      // eslint-disable-next-line no-await-in-loop
      await tick(2);

      t.mock.timers.tick(200);
    }

    t.mock.timers.tick(400);
    await tick(5);

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), ["in-window"],
      "post-horizon lines are filtered out of the window, and the hard cap terminates the otherwise-never-quiescent one-shot");
    assert.equal(socket.aborted, true, "the hard cap must have aborted the socket to terminate the run");
  });

  test("a follow window arms no terminator and continues live past the hard cap", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    const socket = new ScriptedSocket([ line(10, 0, "pre"), line(11, 30, "in-window") ]);
    const download = windowFetch({ mode: "open" });

    await using client = windowClient(download.fetch, socket);

    const collected = collect(client.tail({ follow: true, mode: "window", since: epochAt(11, 0), until: null }), 3);

    await tick(10);

    // Advance well past the hard cap; a follow window arms no terminator, so the socket must stay alive and keep delivering live lines.
    t.mock.timers.tick(SEED_WINDOW_MAX_MS * 3);
    await tick(5);

    assert.equal(socket.aborted, false, "a follow window must arm no terminator, so the socket survives past the cap");

    socket.feed(line(12, 30, "live-a"));
    socket.feed(line(12, 45, "live-b"));

    const records = await collected;

    assert.deepEqual(records.map((record) => record.message), [ "in-window", "live-a", "live-b" ],
      "the follow window continues serving live lines indefinitely (until null means no upper bound)");
  });

  test("a seed-covers run and a no-cover failed-download run each produce no unhandled rejection", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    await assertNoUnhandledRejections(async () => {

      // Seed-covers: the aborted speculative download's rejection must be neutralized rather than floating.
      const seedSocket = new ScriptedSocket([ line(10, 0, "pre"), line(11, 30, "in-window") ], { end: true });
      const seedDownload = windowFetch({ mode: "open" });

      await using seedClient = windowClient(seedDownload.fetch, seedSocket);

      await collect(seedClient.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null }));

      // No-cover genuine failure: the deep window cannot be served and the download fails, so the actionable error surfaces - its rejection observed, not floating.
      const deepSocket = new ScriptedSocket([line(11, 0, "s-11")], { end: true });
      const deepDownload = windowFetch({ mode: "reject" });

      await using deepClient = windowClient(deepDownload.fetch, deepSocket);

      await assert.rejects(collect(deepClient.tail({ follow: false, mode: "window", since: epochAt(10, 0), until: null })), /no log file/i);
    });
  });

  test("no wall-clock timer survives the channel's disposal", async (t) => {

    t.mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: WINDOW_HORIZON });

    const socket = new ScriptedSocket([ line(10, 0, "pre"), line(11, 30, "in-window") ]);
    const download = windowFetch({ mode: "open" });

    await using client = windowClient(download.fetch, socket);

    // Serve one in-window record, then break - disposing the stream mid-serve while the one-shot terminator is armed. The finally must clear both wall-clock timers.
    await collect(client.tail({ follow: false, mode: "window", since: epochAt(11, 0), until: null }), 1);

    const reasonsAfterDisposal = socket.abortReasons.length;

    // Advancing far past the hard cap must NOT re-abort the socket via a stale terminator timer.
    t.mock.timers.tick(SEED_WINDOW_MAX_MS * 2);
    await tick(5);

    assert.equal(socket.abortReasons.length, reasonsAfterDisposal, "no stale wall-clock timer may fire after the channel is disposed");
    assert.ok(!socket.abortReasons.some((reason) => (reason instanceof HbpuAbortError) && (reason.name === "timeout")),
      "the one-shot terminator must not fire after disposal (its timers were cleared)");
  });
});
