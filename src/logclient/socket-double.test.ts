/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/socket-double.test.ts: Unit tests for the socket test doubles - the WebSocket double's emit/capture contract and the LogSocket double's line/abort behavior.
 */
import { TestLogSocket, TestLogSocketFactory, TestWebSocket, TestWebSocketFactory } from "./socket-double.ts";
import { describe, test } from "node:test";
import { HbpuAbortError } from "../util.ts";
import type { LogSocketInit } from "./socket.ts";
import assert from "node:assert/strict";
import { isHbpuAbortReason } from "../util.ts";
import { silentLog } from "../testing.helpers.ts";

// A minimal LogSocketInit for the factory tests; the double ignores everything but records it.
const INIT: LogSocketInit = { host: "localhost", log: silentLog(), refreshable: true, tokenProvider: async () => "raw.jwt" };

describe("TestWebSocket", () => {

  test("dispatches emitted events to registered listeners", () => {

    const ws = new TestWebSocket("ws://localhost/socket.io/");
    const events: string[] = [];

    ws.addEventListener("open", () => events.push("open"));
    ws.addEventListener("message", (event) => events.push("message:" + String(event.data)));
    ws.addEventListener("close", (event) => events.push("close:" + event.code.toString()));
    ws.addEventListener("error", () => events.push("error"));

    ws.emitOpen();
    ws.emitMessage("hello");
    ws.emitError();
    ws.emitClose(1006);

    assert.deepEqual(events, [ "open", "message:hello", "error", "close:1006" ]);
  });

  test("captures sent frames and close codes in order", () => {

    const ws = new TestWebSocket();

    ws.send("40/log,");
    ws.send("3");
    ws.close(1000);

    assert.deepEqual(ws.sent, [ "40/log,", "3" ]);
    assert.deepEqual(ws.closeCodes, [1000]);
  });

  test("starts OPEN and flips to CLOSED on close", () => {

    const ws = new TestWebSocket();

    assert.equal(ws.readyState, 1, "the double starts in the OPEN readyState");

    ws.close();

    assert.equal(ws.readyState, 3, "the double flips to the CLOSED readyState after close");
    assert.deepEqual(ws.closeCodes, [1000], "close with no argument records the default normal-closure code");
  });

  test("emitClose flips readyState to CLOSED", () => {

    const ws = new TestWebSocket();

    ws.emitClose();

    assert.equal(ws.readyState, 3, "an inbound close event flips the double to CLOSED");
  });

  test("emitError defaults to an error-carrying event shape", () => {

    const ws = new TestWebSocket();
    const received: unknown[] = [];

    ws.addEventListener("error", (event) => received.push(event));

    ws.emitError();

    const event = received[0];

    assert.ok((typeof event === "object") && (event !== null) && ("error" in event), "the default error event must carry an error field");
  });
});

describe("TestWebSocketFactory", () => {

  test("records each create call and mints a fresh socket per call", () => {

    const factory = new TestWebSocketFactory();

    const a = factory.create("ws://host/a");
    const b = factory.create("ws://host/b");

    assert.notEqual(a, b, "each create must return a distinct socket");
    assert.deepEqual(factory.urls, [ "ws://host/a", "ws://host/b" ]);
    assert.equal(factory.sockets.length, 2);
  });

  test("returns a fixed socket from every create when one is supplied", () => {

    const fixed = new TestWebSocket();
    const factory = new TestWebSocketFactory(fixed);

    const a = factory.create("ws://host/a");
    const b = factory.create("ws://host/b");

    assert.equal(a, fixed);
    assert.equal(b, fixed);
    assert.deepEqual(factory.sockets, [ fixed, fixed ]);
  });
});

describe("TestLogSocket", () => {

  test("yields the configured lines then parks until aborted", async () => {

    const socket = new TestLogSocket({ lines: [ "line one", "line two" ] });
    const collected: string[] = [];
    let parked = false;

    const consumer = (async (): Promise<void> => {

      for await (const line of socket.stdout()) {

        collected.push(line);

        // Once both configured lines have arrived, mark that the generator is about to park (it parks after exhausting the configured lines), then abort to release it.
        if(collected.length === 2) {

          parked = true;
          socket.abort();
        }
      }
    })();

    await consumer;

    assert.equal(parked, true, "the double must deliver both configured lines before parking");
    assert.deepEqual(collected, [ "line one", "line two" ], "the double must yield its configured lines, then terminate on abort");
  });

  test("abort aborts a genuine signal with a real HbpuAbortError and records the reason", () => {

    const socket = new TestLogSocket();

    assert.equal(socket.aborted, false);

    socket.abort();

    assert.equal(socket.aborted, true);
    assert.ok(isHbpuAbortReason(socket.signal.reason, "shutdown"), "a no-argument abort must default to a real HbpuAbortError(shutdown)");
    assert.equal(socket.abortCalls.length, 1, "abort must record the call");
  });

  test("abort passes an explicit reason through unchanged", () => {

    const socket = new TestLogSocket();
    const reason = new HbpuAbortError("failed");

    socket.abort(reason);

    assert.equal(socket.signal.reason, reason);
    assert.deepEqual(socket.abortCalls, [reason]);
  });

  test("reports the configured droppedLines", () => {

    const socket = new TestLogSocket({ droppedLines: 7 });

    assert.equal(socket.droppedLines, 7);
  });

  test("stdout on an already-aborted socket terminates immediately", async () => {

    const socket = new TestLogSocket({ lines: [ "never", "yielded" ] });

    socket.abort();

    const collected: string[] = [];

    for await (const line of socket.stdout()) {

      collected.push(line);
    }

    assert.deepEqual(collected, [], "stdout on a pre-aborted socket must yield nothing and return immediately");
  });

  test("[Symbol.asyncDispose] aborts the socket", async () => {

    const socket = new TestLogSocket();

    await socket[Symbol.asyncDispose]();

    assert.equal(socket.aborted, true, "disposal must abort the socket");
  });
});

describe("TestLogSocketFactory", () => {

  test("records each create call and mints a fresh socket per call", () => {

    const factory = new TestLogSocketFactory();

    const a = factory.create(INIT);
    const b = factory.create(INIT);

    assert.notEqual(a, b, "each create must return a distinct socket");
    assert.equal(factory.createCalls.length, 2);
    assert.equal(factory.createCalls[0]?.init, INIT, "the factory must record the init it was passed");
  });

  test("returns a fixed socket from every create when one is supplied", () => {

    const fixed = new TestLogSocket();
    const factory = new TestLogSocketFactory(fixed);

    const a = factory.create(INIT);
    const b = factory.create(INIT);

    assert.equal(a, fixed);
    assert.equal(b, fixed);
  });
});
