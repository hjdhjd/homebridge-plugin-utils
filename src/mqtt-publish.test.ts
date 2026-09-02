/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-publish.test.ts: Unit tests for the MQTT publish-outcome vocabulary - the offline refusal and the pure guarded-publish failure router.
 *
 * The router's rows drive the pure function directly with a capturing log, so what they assert is the classification itself rather than any one caller's route to it;
 * the client's guarded publish over a real broker stays in the client's own suite.
 */
import { MqttOfflineError, routeGuardedPublishFailure } from "./mqtt-publish.ts";
import { describe, test } from "node:test";
import type { CapturingLog } from "./testing/index.ts";
import { HbpuAbortError } from "./util.ts";
import assert from "node:assert/strict";
import { capturingLog } from "./testing/index.ts";
import { firstRendered } from "./mqtt.helpers.ts";

describe("routeGuardedPublishFailure - pure function", () => {

  // The router is where the client and the shipped double meet, so these cases are the contract both of them inherit: which term answers first, and what each outcome
  // reads as on the line. Every case builds its own controllers so nothing carries between them, and the topic is fixed because the router only ever names it.
  const TOPIC = "test/device1/status";

  // Route one synthetic outcome and answer the log it wrote, so each case reads as the terms it sets and the single line they produce.
  function route(options: { clientSignal: AbortSignal; error: unknown; publishSignal?: AbortSignal }): CapturingLog {

    const log = capturingLog();

    routeGuardedPublishFailure({ clientSignal: options.clientSignal, error: options.error, log, publishSignal: options.publishSignal, topic: TOPIC });

    return log;
  }

  test("an aborted client signal routes a plain error to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();

    client.abort(new Error("going away"));

    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message."), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("an aborted per-publish signal routes a plain error to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();

    perPublish.abort(new Error("device disposed"));

    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message."), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("an HbpuAbortError with both signals live routes to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const log = route({ clientSignal: client.signal, error: new HbpuAbortError("shutdown"), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("a platform AbortError with both signals live routes to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const rejection = new Error("The operation was aborted");

    rejection.name = "AbortError";

    const log = route({ clientSignal: client.signal, error: rejection, publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("an MqttOfflineError with both signals live routes to the dropped line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const log = route({ clientSignal: client.signal, error: new MqttOfflineError(), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish dropped while disconnected from the broker: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("a plain error with both signals live routes to the failure line at error", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message."), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "Unable to publish to the MQTT topic test/device1/status: broker refused the message.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["error"]);
  });

  test("an aborted client signal outranks an MqttOfflineError", () => {

    // The ordering the router exists to state: a publish the caller has already torn down is cancelled, whatever the rejection that surfaced on the way out says.
    const client = new AbortController();
    const perPublish = new AbortController();

    client.abort(new HbpuAbortError("shutdown"));

    const log = route({ clientSignal: client.signal, error: new MqttOfflineError(), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("a caller that supplies no per-publish signal still reaches the failure line", () => {

    const client = new AbortController();
    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message.") });

    assert.equal(firstRendered(log), "Unable to publish to the MQTT topic test/device1/status: broker refused the message.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["error"]);
  });
});
