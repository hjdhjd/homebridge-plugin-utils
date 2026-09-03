/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-publish.test.ts: Unit tests for the MQTT publish-outcome vocabulary - the offline refusal, the pure guarded-publish failure router, and the per-topic memory
 * a change-gated publish is weighed against.
 *
 * The router's rows drive the pure function directly with a capturing log, so what they assert is the classification itself rather than any one caller's route to it;
 * the client's guarded publish over a real broker stays in the client's own suite. The memory's rows drive the class directly for the same reason: what they state is
 * the comparison and the keeping rule themselves, while the client's and the double's suites state how each one reaches them.
 */
import { MqttLastPayloads, MqttOfflineError, routeGuardedPublishFailure } from "./mqtt-publish.ts";
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

describe("MqttLastPayloads - the change-gated memory", () => {

  // The memory is the one rule the client and the double both apply, so these rows state it where it lives rather than through either holder. The topics are spelled
  // as a caller spells them, since the class keys on exactly what it is handed.
  const TOPIC = "device1/status";
  const OTHER = "device2/status";

  test("answers false for a topic nothing was remembered for, and remembers one topic without touching another", () => {

    const memory = new MqttLastPayloads();

    assert.equal(memory.sameAsLast(TOPIC, "on"), false, "the first change-gated publish on any topic must go out");

    memory.remember(TOPIC, "on");

    assert.equal(memory.sameAsLast(TOPIC, "on"), true);
    assert.equal(memory.sameAsLast(TOPIC, "off"), false);
    assert.equal(memory.sameAsLast(OTHER, "on"), false, "remembering one topic must leave every other topic unremembered");
  });

  test("compares two Buffers by their bytes", () => {

    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, Buffer.from("on"));

    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("on")), true);
    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("off")), false);
  });

  test("never treats a string and a Buffer as the same payload, in either order", () => {

    // A topic's payloads are one kind or the other, so the cross-kind answer is the one that costs nothing: a string is never encoded to be compared.
    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, "on");

    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("on")), false);

    memory.remember(OTHER, Buffer.from("on"));

    assert.equal(memory.sameAsLast(OTHER, "on"), false);
  });

  test("keeps a copy of a remembered Buffer, so a caller rewriting its own buffer is weighed against the bytes that went out", () => {

    const memory = new MqttLastPayloads();
    const scratch = Buffer.from("on");

    memory.remember(TOPIC, scratch);
    scratch.write("no");

    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("on")), true, "a fresh buffer carrying the delivered bytes must still read as unchanged");
    assert.equal(memory.sameAsLast(TOPIC, scratch), false, "the rewritten buffer carries different bytes and must read as a change");
  });

  test("replaces what a topic held when it is remembered again", () => {

    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, "on");
    memory.remember(TOPIC, "off");

    assert.equal(memory.sameAsLast(TOPIC, "off"), true);
    assert.equal(memory.sameAsLast(TOPIC, "on"), false, "only the latest payload is remembered");
  });

  test("forgets every topic when it is cleared", () => {

    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, "on");
    memory.remember(OTHER, Buffer.from("on"));
    memory.clear();

    assert.equal(memory.sameAsLast(TOPIC, "on"), false);
    assert.equal(memory.sameAsLast(OTHER, Buffer.from("on")), false);
  });
});
