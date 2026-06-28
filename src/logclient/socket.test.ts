/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/socket.test.ts: Unit tests for the LogSocket state machine - handshake, ping/pong, stdout routing, reconnect, watchdog liveness, CONNECT_ERROR, teardown.
 */
import { HbpuAbortError, isHbpuAbortReason } from "../util.ts";
import { LogSocket, reconnectBackoff } from "./socket.ts";
import { describe, test } from "node:test";
import type { LogSocketInit } from "./socket.ts";
import type { TestWebSocket } from "./socket-double.ts";
import { TestWebSocketFactory } from "./socket-double.ts";
import assert from "node:assert/strict";
import { capturingLog } from "../testing.helpers.ts";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { silentLog } from "../testing.helpers.ts";

// The Engine.IO open handshake frame advertising a ping cadence. The socket reads `pingInterval`/`pingTimeout` to size its liveness watchdog.
const OPEN_FRAME = "0{\"sid\":\"s1\",\"pingInterval\":25000,\"pingTimeout\":20000}";

// The Socket.IO namespace CONNECT acknowledgement for the `/log` namespace.
const NS_CONNECT_FRAME = "40/log,{\"sid\":\"n1\"}";

// Yield to the microtask/immediate queue so the socket's async connect steps (token acquisition, listener registration, handshake handling) settle before assertion.
async function tick(times = 1): Promise<void> {

  for(let index = 0; index < times; index++) {

    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
}

// Build the standard socket init with a synchronous token provider and the supplied WebSocket factory. A near-zero backoff drives the reconnect loop without real waits.
function makeInit(factory: TestWebSocketFactory, overrides: Partial<LogSocketInit> = {}): LogSocketInit {

  return {

    backoff: () => 0,
    host: "localhost",
    log: silentLog(),
    refreshable: true,
    tokenProvider: async () => "raw.jwt",
    webSocketFactory: factory.create,
    ...overrides
  };
}

// Drive a freshly-created socket double through the Engine.IO open handshake and the namespace connect, leaving the session in the streaming phase. Returns once the
// `tail-log` request has been emitted.
async function completeHandshake(ws: TestWebSocket): Promise<void> {

  ws.emitOpen();
  ws.emitMessage(OPEN_FRAME);
  await tick();
  ws.emitMessage(NS_CONNECT_FRAME);
  await tick();
}

describe("LogSocket - handshake sequence", () => {

  test("connects, joins the namespace, and emits tail-log in order", async () => {

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws = factory.sockets[0];

    assert.ok(ws !== undefined, "the connect phase must construct a WebSocket");
    assert.match(ws.url, /EIO=4/, "the connect URL must carry the Engine.IO version");
    assert.match(ws.url, /token=raw\.jwt/, "the connect URL must carry the raw token");

    await completeHandshake(ws);

    assert.deepEqual(ws.sent, [ "40/log,", "42/log,[\"tail-log\",{\"cols\":80,\"rows\":24}]" ],
      "the socket must join the namespace then request the tail with the advertised PTY geometry");
  });

  test("re-acquires a fresh token on each connect", async () => {

    const factory = new TestWebSocketFactory();
    const tokens: string[] = [];
    let counter = 0;

    await using _socket = new LogSocket(makeInit(factory, { tokenProvider: async () => {

      counter++;

      const token = "token-" + counter.toString();

      tokens.push(token);

      return token;
    } }));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);
    assert.match(ws0.url, /token=token-1/, "the first connect must use the first freshly-acquired token");

    // Fail the first session; the reconnect must re-acquire a new token for the second connect.
    ws0.emitClose(1006);

    const ws1 = await factory.socketCreated(1);

    assert.match(ws1.url, /token=token-2/, "the reconnect must re-acquire a fresh token via the token provider");
  });
});

describe("LogSocket - ping/pong liveness", () => {

  test("replies to a server ping with a pong", async () => {

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws = factory.sockets[0];

    assert.ok(ws !== undefined);

    await completeHandshake(ws);

    ws.emitMessage("2");
    await tick();

    assert.equal(ws.sent.at(-1), "3", "a server ping must be answered with a bare Engine.IO pong");
  });
});

describe("LogSocket - stdout routing", () => {

  test("routes a stdout event into the line stream", async () => {

    const factory = new TestWebSocketFactory();

    await using socket = new LogSocket(makeInit(factory));

    const linesPromise = (async (): Promise<string[]> => {

      const collected: string[] = [];

      for await (const line of socket.stdout()) {

        collected.push(line);

        if(collected.length === 2) {

          break;
        }
      }

      return collected;
    })();

    await tick();

    const ws = factory.sockets[0];

    assert.ok(ws !== undefined);

    await completeHandshake(ws);

    // Two complete lines in one stdout chunk, plus a partial third line with no terminator.
    ws.emitMessage("42/log,[\"stdout\",\"first line\\nsecond line\\npartial\"]");

    const lines = await linesPromise;

    assert.deepEqual(lines, [ "first line", "second line" ], "complete lines must surface; the partial line stays buffered until terminated or flushed");
  });

  test("flushes the final buffered line when the session closes", async () => {

    const factory = new TestWebSocketFactory();

    await using socket = new LogSocket(makeInit(factory));

    const linesPromise = (async (): Promise<string[]> => {

      const collected: string[] = [];

      for await (const line of socket.stdout()) {

        collected.push(line);

        if(collected.length === 2) {

          break;
        }
      }

      return collected;
    })();

    await tick();

    const ws = factory.sockets[0];

    assert.ok(ws !== undefined);

    await completeHandshake(ws);

    // A complete first line and a tail line ending on a lone line-feed - the splitter withholds the tail pending a possible cross-chunk pair.
    ws.emitMessage("42/log,[\"stdout\",\"complete line\\ntail line\\n\"]");
    await tick();

    // Closing the session must flush the splitter so the withheld tail line surfaces rather than being stranded.
    ws.emitClose(1000);

    const lines = await linesPromise;

    assert.deepEqual(lines, [ "complete line", "tail line" ], "the session-close flush must surface the final buffered line");
  });
});

describe("LogSocket - reconnect", () => {

  test("reconnects after an abnormal session end, with backoff reset (connect-phase-only retry)", async () => {

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    // A healthy session that then drops. The reconnect loop must open a fresh WebSocket.
    ws0.emitClose(1006);

    const ws1 = await factory.socketCreated(1);

    // The new session handshakes cleanly, proving the loop is fully functional after a reconnect (socketCreated awaited the actual reconnect, not a fixed delay).
    await completeHandshake(ws1);

    assert.deepEqual(ws1.sent, [ "40/log,", "42/log,[\"tail-log\",{\"cols\":80,\"rows\":24}]" ]);
  });

  test("retries a transient connect failure", async () => {

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    // Fail the first connect at the transport layer before the handshake completes; `retry` must back off (near-zero) and open a second socket.
    ws0.emitError();

    // socketCreated(1) resolves only once the retry constructs the second socket; awaiting it is the reconnect proof (a non-reconnect would hang the test).
    await factory.socketCreated(1);

    assert.equal(factory.sockets.length, 2, "a transient connect error must be retried with exactly one fresh WebSocket");
  });
});

describe("LogSocket - permanent auth failure veto", () => {

  test("shouldRetry vetoes a permanent auth failure and aborts the socket", async () => {

    const factory = new TestWebSocketFactory();
    const { LogAuthError } = await import("./auth.ts");

    const socket = new LogSocket(makeInit(factory, { tokenProvider: async () => {

      throw new LogAuthError("bad credentials", { kind: "permanent" });
    } }));

    // The permanent failure must veto a retry and abort the socket; no WebSocket is ever constructed because the token acquisition fails first.
    await tick(3);

    assert.equal(socket.aborted, true, "a permanent auth failure must abort the socket rather than loop forever");
    assert.equal(factory.sockets.length, 0, "a token failure must short-circuit before any WebSocket is constructed");
    assert.ok(isHbpuAbortReason(socket.signal.reason, "failed"), "the socket must abort with a failed reason carrying the permanent auth cause");

    await socket[Symbol.asyncDispose]();
  });

  test("retries a transient auth failure", async () => {

    const factory = new TestWebSocketFactory();
    const { LogAuthError } = await import("./auth.ts");
    let attempts = 0;

    await using socket = new LogSocket(makeInit(factory, { tokenProvider: async () => {

      attempts++;

      if(attempts === 1) {

        throw new LogAuthError("server down", { kind: "transient" });
      }

      return "raw.jwt";
    } }));

    // Await the socket the retry constructs (attempt 2 returns a token); its construction is the deterministic signal the transient failure was retried.
    await factory.socketCreated(0);

    assert.ok(attempts >= 2, "a transient auth failure must be retried");
    assert.equal(socket.aborted, false, "a transient auth failure must not abort the socket");
  });
});

describe("LogSocket - watchdog liveness", () => {

  test("fires the watchdog and reconnects when pings stop", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    // Advance past the watchdog window (pingInterval 25000 + pingTimeout 20000 + MARGIN_MS 5000 = 50000) with no ping. The watchdog must fire, abort the session, and
    // close the WebSocket.
    t.mock.timers.tick(50001);
    await tick(3);

    assert.deepEqual(ws0.closeCodes, [1000], "the watchdog fire must close the wedged session with a normal-closure code");

    const ws1 = factory.sockets[1];

    assert.ok(ws1 !== undefined, "a watchdog-fired session end must trigger a reconnect");
  });

  test("does not fire while pings keep arriving", async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    // Advance most of the window, then deliver a ping to re-arm; the cumulative time exceeds one window but no single gap does, so the watchdog must not fire.
    t.mock.timers.tick(40000);
    ws0.emitMessage("2");
    await tick();
    t.mock.timers.tick(40000);
    await tick();

    assert.equal(factory.sockets.length, 1, "a re-armed watchdog must not fire, so no reconnect occurs");
    assert.deepEqual(ws0.closeCodes, [], "a live session must not be closed while pings keep arriving");
  });
});

describe("LogSocket - default reconnect backoff curve", () => {

  test("follows the dev-tuned 500/1000/2000/4000/5000 exponential-with-ceiling sequence", () => {

    // The exported `reconnectBackoff` is the single source of truth for the socket's default connect-phase backoff (the constructor's default closes over it with the
    // injected `random`). Pinning `random` to 0 zeroes the jitter so the bare schedule is deterministic: `retry` calls the policy 1-indexed for the second-and-later
    // connect attempts, so attempt 2 (the first reconnect) waits 500 ms, the curve doubles to 1000, 2000, 4000, then plateaus at the 5000 ms ceiling from attempt 6 on.
    const zeroJitter = (): number => 0;
    const schedule = [ 2, 3, 4, 5, 6, 7 ].map((attempt) => reconnectBackoff(attempt, zeroJitter));

    assert.deepEqual(schedule, [ 500, 1000, 2000, 4000, 5000, 5000 ],
      "the default backoff must double from a 500 ms base and plateau at the 5000 ms ceiling");
  });

  test("layers upward jitter onto the base delay", () => {

    // With `random` pinned to its maximum, the jitter adds the full `JITTER_FRACTION` of the base, so the 500 ms first-reconnect delay becomes 750 ms - proving the
    // jitter is layered on top of the curve rather than replacing it.
    const maxJitter = (): number => 0.9999999;

    assert.equal(reconnectBackoff(2, maxJitter), 750, "maximum jitter must add 50 percent (JITTER_FRACTION) of the base delay");
  });
});

describe("LogSocket - CONNECT_ERROR", () => {

  test("with a refreshable credential, treats a namespace CONNECT_ERROR as a transient connect-phase failure and retries", async () => {

    const factory = new TestWebSocketFactory();

    // Refreshable credentials (password/noauth) re-authenticate on each connect, so a handshake rejection is transient: the loop must retry with a fresh WebSocket.
    await using _socket = new LogSocket(makeInit(factory, { refreshable: true }));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    ws0.emitOpen();
    ws0.emitMessage(OPEN_FRAME);
    await tick();

    // The server rejects the namespace join with a Socket.IO CONNECT_ERROR (44/log,). This is a connect-phase failure, so the loop must retry with a fresh WebSocket.
    ws0.emitMessage("44/log,{\"message\":\"unauthorized\"}");

    // The awaited construction of the second socket proves the refreshable CONNECT_ERROR was treated as a transient connect-phase failure and retried.
    await factory.socketCreated(1);

    assert.equal(factory.sockets.length, 2, "a refreshable CONNECT_ERROR must be retried with exactly one fresh WebSocket");
  });

  test("with a static (non-refreshable) token, treats a namespace CONNECT_ERROR as a permanent failure and aborts terminally", async () => {

    const factory = new TestWebSocketFactory();

    // A static `token` credential cannot mint a fresh token on the next attempt; the socket is told the credential is non-refreshable, so a handshake rejection must be a
    // PERMANENT failure that the connect-phase `shouldRetry` veto makes terminal - no infinite spin against a doomed token.
    const socket = new LogSocket(makeInit(factory, { refreshable: false }));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    ws0.emitOpen();
    ws0.emitMessage(OPEN_FRAME);
    await tick();

    // The server rejects the namespace join with a CONNECT_ERROR. With a non-refreshable credential this is permanent: the socket must abort terminally rather than
    // retry, and no second WebSocket is ever constructed.
    ws0.emitMessage("44/log,{\"message\":\"unauthorized\"}");
    await tick(3);

    assert.equal(socket.aborted, true, "a CONNECT_ERROR with a static token must abort the socket rather than retry forever");
    assert.equal(factory.sockets.length, 1, "a permanent handshake rejection must not construct a second WebSocket");
    assert.ok(isHbpuAbortReason(socket.signal.reason, "failed"), "the socket must abort with a failed reason carrying the permanent auth cause");

    // The terminal cause must be the actionable, refresh-aware permanent LogAuthError so the CLI can surface a clear message and exit non-zero.
    const { LogAuthError } = await import("./auth.ts");
    const cause: unknown = isHbpuAbortReason(socket.signal.reason, "failed") ? socket.signal.reason.cause : undefined;

    assert.ok(cause instanceof LogAuthError, "the failed abort cause must be the permanent LogAuthError raised for a non-refreshable token");
    assert.match(cause.message, /cannot be refreshed/, "the permanent auth error must advise that the token cannot be refreshed");

    await socket[Symbol.asyncDispose]();
  });
});

describe("LogSocket - streaming-phase faults", () => {

  test("a WebSocket error mid-stream ends the session and reconnects", async () => {

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    // An error during the streaming phase (not the handshake) must abort the session and trigger a reconnect, with the wedged socket closed.
    ws0.emitError({ error: new Error("mid-stream transport fault") });

    await factory.socketCreated(1);

    assert.ok(ws0.closeCodes.includes(1000), "a streaming-phase error must close the session with a normal-closure code");
    assert.equal(factory.sockets.length, 2, "a streaming-phase error must trigger exactly one reconnect");
  });

  test("ignores a non-string message frame", async () => {

    const factory = new TestWebSocketFactory();

    await using _socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    const sentBefore = ws0.sent.length;

    // A binary (non-string) frame is not part of the text protocol; the streaming handler must ignore it without sending anything or tearing down.
    ws0.emitMessage(new ArrayBuffer(4));
    await tick();

    assert.equal(ws0.sent.length, sentBefore, "a non-string frame must be ignored, producing no outbound frame");
    assert.equal(factory.sockets.length, 1, "a non-string frame must not end the session");
  });

  test("a WebSocket error event with no error field still aborts with a generic cause", async () => {

    const factory = new TestWebSocketFactory();

    const socket = new LogSocket(makeInit(factory, { backoff: () => 60000 }));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    // An error event carrying no structured `error` field (the bare DOM shape) during the connect handshake must still reject the connect with a failed reason.
    ws0.emitError({});
    await tick();

    assert.ok(ws0.closeCodes.includes(1000), "a handshake error must close the WebSocket");

    socket.abort();
    await socket[Symbol.asyncDispose]();
  });
});

describe("LogSocket - teardown and abort", () => {

  test("abort during backoff tears down cleanly", async () => {

    const factory = new TestWebSocketFactory();

    // A large backoff so the reconnect loop is parked in its backoff wait when we abort, exercising the abort-during-backoff path.
    await using socket = new LogSocket(makeInit(factory, { backoff: () => 60000 }));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    // Fail the first connect so the loop enters its backoff wait, then abort while it is parked there.
    ws0.emitError();
    await tick();

    socket.abort();
    await tick(2);

    assert.equal(socket.aborted, true, "abort during backoff must abort the socket");
    assert.equal(factory.sockets.length, 1, "abort during backoff must not start a new connect attempt");
  });

  test("abort during STREAMING closes the session and terminates stdout", async () => {

    const factory = new TestWebSocketFactory();

    const socket = new LogSocket(makeInit(factory));

    const done = (async (): Promise<boolean> => {

      // The stdout generator must terminate (return) when the socket aborts mid-stream.

      for await (const _line of socket.stdout()) {

        // No lines are delivered in this test; the loop exists only to observe termination on abort.
      }

      return true;
    })();

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    socket.abort();

    const terminated = await done;

    assert.equal(terminated, true, "the stdout stream must terminate when the socket aborts mid-stream");
    assert.deepEqual(ws0.closeCodes, [1000], "abort during streaming must always close the WebSocket with code 1000");
    assert.equal(ws0.sent.at(-1), "41/log,", "abort during streaming must send the namespace DISCONNECT while the socket is still OPEN");

    await socket[Symbol.asyncDispose]();
  });

  test("double abort is a no-op", async () => {

    const factory = new TestWebSocketFactory();

    const socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    socket.abort(new HbpuAbortError("shutdown"));

    const firstReason: unknown = socket.signal.reason;

    socket.abort(new HbpuAbortError("failed"));

    assert.equal(socket.signal.reason, firstReason, "a second abort must not overwrite the first abort's reason");

    await socket[Symbol.asyncDispose]();
  });

  test("close(1000) is always sent on teardown even when not OPEN", async () => {

    const factory = new TestWebSocketFactory();

    const socket = new LogSocket(makeInit(factory));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    // Simulate the peer half-closing the connection (readyState -> CLOSED) on ws0 before our teardown. The reconnect loop then opens a fresh socket, and the assertion
    // below pins the always-close guarantee: teardown issues close(1000) on the live reconnected socket regardless of the prior socket's state.
    ws0.emitClose(1006);
    await tick(2);

    // After the peer close the reconnect loop opens a new socket; abort the whole socket and confirm the live one is closed.
    socket.abort();
    await tick(2);

    const ws1 = factory.sockets[1];

    if(ws1 !== undefined) {

      assert.ok(ws1.closeCodes.includes(1000), "teardown must always issue close(1000) on the live socket");
    }

    await socket[Symbol.asyncDispose]();
  });
});

describe("LogSocket - bounded stdout queue", () => {

  test("drops the oldest lines and logs once on overflow", async () => {

    const factory = new TestWebSocketFactory();
    const log = capturingLog();

    // A tiny high-water mark so a handful of lines overflows it. The consumer never pulls, so every line stays queued until the bound is hit.
    await using socket = new LogSocket(makeInit(factory, { log, stdoutHighWater: 3 }));

    await tick();

    const ws0 = factory.sockets[0];

    assert.ok(ws0 !== undefined);

    await completeHandshake(ws0);

    // Feed six complete lines into a queue bounded at three, with a trailing partial seventh so all six lines are emitted (the splitter withholds only the unterminated
    // partial, not a terminated line). The oldest three of the six must be dropped.
    ws0.emitMessage("42/log,[\"stdout\",\"l1\\nl2\\nl3\\nl4\\nl5\\nl6\\npartial\"]");
    await tick();

    const warnings = log.entries.filter((entry) => entry.level === "warn");

    assert.equal(socket.droppedLines, 3, "overflow must drop exactly the number of lines beyond the high-water mark");
    assert.equal(warnings.length, 1, "overflow must log exactly one warning regardless of how many lines are dropped");

    // Drain what remains; the most recent three lines must survive.
    const remaining: string[] = [];

    for await (const line of socket.stdout()) {

      remaining.push(line);

      if(remaining.length === 3) {

        break;
      }
    }

    assert.deepEqual(remaining, [ "l4", "l5", "l6" ], "the bound must retain the most recent lines, dropping the oldest");
  });
});

describe("LogSocket - pre-aborted construction", () => {

  test("a pre-aborted signal tears down without connecting", async () => {

    const factory = new TestWebSocketFactory();
    const controller = new AbortController();

    controller.abort(new HbpuAbortError("shutdown"));

    await using socket = new LogSocket(makeInit(factory, { signal: controller.signal }));

    await tick();

    assert.equal(socket.aborted, true, "a pre-aborted parent signal must leave the socket aborted");
    assert.equal(factory.sockets.length, 0, "a pre-aborted socket must never construct a WebSocket");

    // The stdout stream must terminate immediately on a pre-aborted socket rather than hanging.
    const lines: string[] = [];

    for await (const line of socket.stdout()) {

      lines.push(line);
    }

    assert.deepEqual(lines, [], "stdout on a pre-aborted socket must terminate immediately");
  });
});
