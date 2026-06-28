/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/frame.test.ts: Unit tests for the Engine.IO / Socket.IO wire codec.
 */
import { LOG_NAMESPACE_PATH, decodeFrame, encodeFrame } from "./frame.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("decodeFrame", () => {

  test("decodes the Engine.IO open handshake and surfaces ping interval/timeout", () => {

    const event = decodeFrame("0{\"sid\":\"abc\",\"pingInterval\":25000,\"pingTimeout\":20000}");

    assert.deepEqual(event, { kind: "open", pingInterval: 25000, pingTimeout: 20000 });
  });

  test("falls back to zero intervals when the open handshake is malformed", () => {

    const event = decodeFrame("0not-json");

    assert.deepEqual(event, { kind: "open", pingInterval: 0, pingTimeout: 0 });
  });

  test("falls back to zero intervals when the handshake omits the ping fields", () => {

    const event = decodeFrame("0{\"sid\":\"abc\"}");

    assert.deepEqual(event, { kind: "open", pingInterval: 0, pingTimeout: 0 });
  });

  test("decodes a ping", () => {

    assert.deepEqual(decodeFrame("2"), { kind: "ping" });
  });

  test("decodes a pong", () => {

    assert.deepEqual(decodeFrame("3"), { kind: "pong" });
  });

  test("decodes a namespace CONNECT acknowledgement with an EIO4 payload", () => {

    // EIO4 sends `40/log,{"sid":"..."}`; the payload is discarded and the event is a namespace connect for the log namespace.
    assert.deepEqual(decodeFrame("40/log,{\"sid\":\"xyz\"}"), { kind: "namespaceConnect", namespace: "log" });
  });

  test("decodes a bare EIO3 namespace CONNECT (allowEIO3 interop)", () => {

    // Under allowEIO3 a downgraded client sees a bare `40` with no namespace and no payload; it must still decode as a namespace connect, defaulting to the root
    // namespace, so a consumer does not have to branch on the protocol version.
    assert.deepEqual(decodeFrame("40"), { kind: "namespaceConnect", namespace: "/" });
  });

  test("decodes a CONNECT_ERROR and surfaces the reason verbatim", () => {

    assert.deepEqual(decodeFrame("44/log,{\"message\":\"unauthorized\"}"),
      { kind: "namespaceError", namespace: "log", reason: { message: "unauthorized" } });
  });

  test("decodes a CONNECT_ERROR with no reason payload to a null reason", () => {

    assert.deepEqual(decodeFrame("44/log,"), { kind: "namespaceError", namespace: "log", reason: null });
  });

  test("decodes a namespace EVENT into its event name and payload", () => {

    assert.deepEqual(decodeFrame("42/log,[\"stdout\",\"hello world\"]"),
      { event: "stdout", kind: "message", namespace: "log", payload: "hello world" });
  });

  test("decodes an EVENT on the root namespace", () => {

    assert.deepEqual(decodeFrame("42[\"ping\",1]"), { event: "ping", kind: "message", namespace: "/", payload: 1 });
  });

  test("peels a numeric ack id preceding the EVENT payload", () => {

    // The Socket.IO EVENT format permits a numeric ack id between the namespace and the JSON array; the decoder skips it and still recovers the event name and payload.
    assert.deepEqual(decodeFrame("42/log,17[\"stdout\",\"acked\"]"),
      { event: "stdout", kind: "message", namespace: "log", payload: "acked" });
  });

  test("decodes an EVENT with no payload to an undefined payload", () => {

    assert.deepEqual(decodeFrame("42/log,[\"stdout\"]"), { event: "stdout", kind: "message", namespace: "log", payload: undefined });
  });

  test("classifies an EVENT whose body is not a string-led array as unknown", () => {

    const event = decodeFrame("42/log,[42,\"oops\"]");

    assert.deepEqual(event, { kind: "unknown", raw: "42/log,[42,\"oops\"]" });
  });

  test("classifies an empty frame as unknown", () => {

    assert.deepEqual(decodeFrame(""), { kind: "unknown", raw: "" });
  });

  test("classifies an unrecognized Engine.IO digit as unknown", () => {

    assert.deepEqual(decodeFrame("9whatever"), { kind: "unknown", raw: "9whatever" });
  });

  test("classifies an unhandled Socket.IO packet type (DISCONNECT) as unknown", () => {

    // `41/log,` is a Socket.IO DISCONNECT - not part of the log stream's vocabulary - so it surfaces as unknown carrying the original message frame.
    assert.deepEqual(decodeFrame("41/log,"), { kind: "unknown", raw: "41/log," });
  });

  test("recovers gracefully from a namespace prefix missing its terminating comma", () => {

    // A `/log` prefix with no comma is malformed; the decoder treats the remainder as the namespace and leaves an empty body, decoding as a namespace connect.
    assert.deepEqual(decodeFrame("40/log"), { kind: "namespaceConnect", namespace: "log" });
  });
});

describe("encodeFrame", () => {

  test("encodes a namespace connect", () => {

    assert.equal(encodeFrame({ kind: "connect", namespace: "log" }), "40/log,");
  });

  test("encodes a root-namespace connect with no prefix", () => {

    assert.equal(encodeFrame({ kind: "connect", namespace: "/" }), "40");
  });

  test("encodes a namespace event with its payload", () => {

    assert.equal(encodeFrame({ args: { cols: 80, rows: 24 }, event: "tail-log", kind: "event", namespace: "log" }),
      "42/log,[\"tail-log\",{\"cols\":80,\"rows\":24}]");
  });

  test("encodes a pong as the bare Engine.IO packet", () => {

    assert.equal(encodeFrame({ kind: "pong" }), "3");
  });

  test("round-trips an event through encode then decode", () => {

    const wire = encodeFrame({ args: "payload", event: "stdout", kind: "event", namespace: "log" });

    assert.deepEqual(decodeFrame(wire), { event: "stdout", kind: "message", namespace: "log", payload: "payload" });
  });
});

describe("LOG_NAMESPACE_PATH", () => {

  test("prefixes the bare log namespace with a leading slash", () => {

    assert.equal(LOG_NAMESPACE_PATH, "/log");
  });
});
