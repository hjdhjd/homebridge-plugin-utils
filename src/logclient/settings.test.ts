/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/settings.test.ts: Unit tests for the log client's scalar constants.
 */
import { DEFAULT_HOST, DEFAULT_PORT, JITTER_FRACTION, LOG_NAMESPACE, MARGIN_MS, PTY_COLUMNS, PTY_ROWS, RECONNECT_BASE_MS, RECONNECT_CAP_MS, SEED_GATE_MAX_SKIP,
  SEED_QUIESCENCE_MS, SEED_SETTLE_MS, SEED_WINDOW_MAX_MS, SOCKET_PATH } from "./settings.ts";
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

  test("judges a seed burst complete after a quarter second of quiet", () => {

    assert.equal(SEED_QUIESCENCE_MS, 250);
  });

  test("holds a seed-served window open for a one-second settle floor", () => {

    assert.equal(SEED_SETTLE_MS, 1000);
  });

  test("caps a seed-served window at 5 seconds", () => {

    assert.equal(SEED_WINDOW_MAX_MS, 5000);
  });

  test("gives up on an unrecognized seed format after 100 dropped lines", () => {

    assert.equal(SEED_GATE_MAX_SKIP, 100);
  });

  test("orders the seed terminators so the quiet gap ends nothing early and the floor stays inside the cap", () => {

    /* The three are read through `number` bindings rather than compared as the literal types the constants carry. A comparison between two literal types is settled by
     * the compiler, which both trips the unnecessary-condition rule and would leave this row asserting nothing at all at run time.
     */
    const cap: number = SEED_WINDOW_MAX_MS;
    const floor: number = SEED_SETTLE_MS;
    const quiet: number = SEED_QUIESCENCE_MS;

    assert.ok(quiet < floor, "a quiet gap that outlasted the settle floor would end a window the floor is still holding open");
    assert.ok(floor < cap, "a settle floor beyond the hard cap would make the cap the only terminator a quiet log ever reaches");
  });
});
