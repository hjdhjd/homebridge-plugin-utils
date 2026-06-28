/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.helpers.test.ts: Sanity tests for the {@link startTestBroker} test substrate. Confirms that the helper opens a real port, returns a connectable URL, and
 * releases all resources on disposal. The broker itself is aedes - we do not retest aedes here, only the wiring helper.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "mqtt";
import { createConnection } from "node:net";
import { once } from "node:events";
import { startTestBroker } from "./mqtt.helpers.ts";

describe("startTestBroker", () => {

  test("returns a handle whose URL parses as mqtt://127.0.0.1:<port> with a positive ephemeral port", async () => {

    // The contract: the helper binds 127.0.0.1:0 (kernel-assigned port) and exposes the resulting URL. Any consumer that pastes this URL into a real mqtt.connect call
    // must succeed; the URL shape is the entire surface area of the helper a typical test cares about.
    await using broker = await startTestBroker();
    const parsed = new URL(broker.url);

    assert.equal(parsed.protocol, "mqtt:");
    assert.equal(parsed.hostname, "127.0.0.1");
    assert.ok(Number.parseInt(parsed.port, 10) > 0, "ephemeral port must be a positive integer");
  });

  test("a real mqtt.js client can complete a connect handshake against the broker", async () => {

    // End-to-end smoke: real mqtt.js, real TCP, real CONNECT/CONNACK round trip. If this passes, every test in the MqttClient suite can rely on the broker being a
    // valid substrate for the production class.
    await using broker = await startTestBroker();

    const ready = once(broker.aedes, "clientReady");
    const client = connect(broker.url, { reconnectPeriod: 0, rejectUnauthorized: false });

    try {

      await ready;

      assert.equal(broker.aedes.connectedClients, 1, "the broker must observe exactly one connected client after the handshake completes");
    } finally {

      await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
    }
  });

  test("disposal releases the listening port so a fresh broker can rebind", async () => {

    // The disposal contract: after `await using` exits, the OS port is fully released. We verify by capturing the port, disposing, and probing the same port - a TCP
    // connect attempt must fail with ECONNREFUSED rather than silently succeed (which would prove the listener was still alive).
    let releasedPort: number;

    {

      await using broker = await startTestBroker();

      releasedPort = Number.parseInt(new URL(broker.url).port, 10);
    }

    // Probe the released port. A failed connect proves the listener is gone; a successful connect would mean the disposal lied.
    const probe = createConnection({ host: "127.0.0.1", port: releasedPort });
    const result: string = await new Promise((resolve) => {

      probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "no-code"));
      probe.once("connect", () => {

        probe.destroy();
        resolve("connected");
      });
    });

    assert.equal(result, "ECONNREFUSED", "a probe connect after disposal must fail with ECONNREFUSED, proving the broker released its listener");
  });

  test("multiple concurrent brokers each get a distinct port", async () => {

    // Tests run concurrently across files; verifying that two simultaneously-live brokers receive different ports rules out any silent port-collision class of bugs.
    await using a = await startTestBroker();
    await using b = await startTestBroker();

    assert.notEqual(a.url, b.url, "concurrent brokers must each bind a distinct ephemeral port");
  });
});
