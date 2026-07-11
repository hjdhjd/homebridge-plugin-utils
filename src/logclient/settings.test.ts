/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/settings.test.ts: Unit tests for the log client's scalar constants.
 */
import { DEFAULT_HOST, DEFAULT_PORT, JITTER_FRACTION, LOG_NAMESPACE, MARGIN_MS, PTY_COLUMNS, PTY_ROWS, RECONNECT_BASE_MS, RECONNECT_CAP_MS,
  SOCKET_PATH } from "./settings.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// These constants govern both protocol and behavior across the transports; a silent drift in any of them changes how the client talks to the
// server (port, namespace, mount path) or how it reconnects (base delay, jitter). The tests pin each value so an accidental edit is caught loudly rather than shipping a
// subtly mis-configured client.
describe("logclient settings", () => {

  test("defaults the host to loopback", () => {

    assert.equal(DEFAULT_HOST, "localhost");
  });

  test("defaults the port to the homebridge-config-ui-x default", () => {

    assert.equal(DEFAULT_PORT, 8581);
  });

  test("names the log namespace", () => {

    assert.equal(LOG_NAMESPACE, "log");
  });

  test("mounts the socket at the Socket.IO default path", () => {

    assert.equal(SOCKET_PATH, "/socket.io/");
  });

  test("advertises conventional terminal dimensions", () => {

    assert.equal(PTY_COLUMNS, 80);
    assert.equal(PTY_ROWS, 24);
  });

  test("anchors the reconnect backoff at 500 ms", () => {

    assert.equal(RECONNECT_BASE_MS, 500);
  });

  test("caps the reconnect backoff at 5 seconds", () => {

    assert.equal(RECONNECT_CAP_MS, 5000);
  });

  test("uses a 50 percent jitter fraction", () => {

    assert.equal(JITTER_FRACTION, 0.5);
  });

  test("sizes the watchdog margin at 5 seconds", () => {

    assert.equal(MARGIN_MS, 5000);
  });
});
