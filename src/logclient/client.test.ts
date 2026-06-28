/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/client.test.ts: Unit tests for HomebridgeLogClient - tail() channel selection, follow-history socket-first stitch, leak-free teardown, token lifecycle.
 */
import type { LogSocketFactory, LogSocketInit, LogSocketLike } from "./socket.ts";
import { setTimeout as delay, setImmediate as flushImmediate } from "node:timers/promises";
import { describe, test } from "node:test";
import { HomebridgeLogClient } from "./client.ts";
import type { LogRecord } from "./types.ts";
import { LogSocket } from "./socket.ts";
import { TestLogSocketFactory } from "./socket-double.ts";
import { TestWebSocketFactory } from "./socket-double.ts";
import assert from "node:assert/strict";
import { silentLog } from "../testing.helpers.ts";

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
    const { calls, fetch } = immediateFetch([ "[t] [P] one", "[t] [P] two", "[t] [P] three" ]);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const records = await collect(client.tail({ mode: "history", quantity: "all" }));

    assert.deepEqual(records.map((record) => record.message), [ "one", "two", "three" ], "history mode must deliver the REST whole-file download");
    assert.equal(factory.createCalls.length, 0, "history mode must never construct a socket");
    assert.ok(calls.some((call) => call.url.includes("/log/download")), "history mode must hit the REST download endpoint");
  });

  test("history mode with a numeric quantity retains only the most recent N records", async () => {

    const factory = new TestLogSocketFactory();
    const { fetch } = immediateFetch([ "[t] [P] one", "[t] [P] two", "[t] [P] three", "[t] [P] four" ]);

    await using client = new HomebridgeLogClient({ credentials: { kind: "token", token: "raw.jwt" }, fetch, log: silentLog(), socketFactory: factory });

    const records = await collect(client.tail({ mode: "history", quantity: 2 }));

    assert.deepEqual(records.map((record) => record.message), [ "three", "four" ], "a numeric quantity must retain only the most recent N records");
  });

  test("follow mode uses the socket channel and never hits REST", async () => {

    const socketLines = [ "[t] [P] live one", "[t] [P] live two" ];
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
});

describe("HomebridgeLogClient - follow-history socket-first stitch", () => {

  test("buffers the socket seed first, then stitches history at the minimal overlap, then continues live", async () => {

    // History (oldest first) is A, B, C; the socket seed B, C overlaps history's tail and D is a genuinely new live line. The socket-first join must buffer the seed
    // before history finishes (the deferred fetch guarantees that), stitch at the 2-line overlap, and emit A, B, C, D with no dropped or extra line at the boundary.
    const historyLines = [ "[t] [P] A", "[t] [P] B", "[t] [P] C" ];
    const seedLines = [ "[t] [P] B", "[t] [P] C", "[t] [P] D" ];

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

        yield "[t] [P] B";
        yield "[t] [P] C";

        // Suspend until the test releases the continuation, mirroring a live stream that has delivered its seed and is awaiting genuinely new lines.
        await release.promise;

        yield "[t] [P] D";
        yield "[t] [P] E";
      },
      [Symbol.asyncDispose]: async (): Promise<void> => controller.abort(new Error("disposed"))
    };

    const factory: LogSocketFactory = { create: (): LogSocketLike => socket };
    const { fetch, resolveHistory } = deferredFetch([ "[t] [P] A", "[t] [P] B", "[t] [P] C" ]);

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
    const historyLines = [ "[t] [P] A", "[t] [P] B", "[t] [P] C", "[t] [P] D" ];
    const seedLines = [ "[t] [P] C", "[t] [P] D", "[t] [P] E" ];

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
});

describe("HomebridgeLogClient - leak-free teardown", () => {

  test("an early break disposes the per-call socket rather than leaking it", async () => {

    const { TestLogSocket } = await import("./socket-double.ts");
    const preset = new TestLogSocket({ lines: [ "[t] [P] first", "[t] [P] second", "[t] [P] third" ] });
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
    const preset = new TestLogSocket({ lines: ["[t] [P] live"] });
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
    const preset = new TestLogSocket({ lines: ["[t] [P] live"] });
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
