/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-client-double.test.ts: Unit tests for the recording MqttClient double - what it records, how it routes a refused publish, and the abort lifecycle it mirrors.
 *
 * The scenarios, in the order they run:
 *
 * - Publishing: a string and a Buffer payload recorded verbatim on the topic tail; the refusal lever rejecting and counting in place of recording; a publish rejected
 *   by the double's own signal and by a per-publish signal.
 * - The guarded path: a successful publish that says nothing, a genuine failure on the error line, and each cancellation term - the double aborted, the per-publish
 *   signal aborted, an HbpuAbortError refusal, an "AbortError"-named refusal - reaching the debug line. The signal terms are exercised with a plain error as the abort
 *   reason, so nothing about the rejection's shape can route them and only the signal read can.
 * - Registration: raw, get, and set entries carrying the appended suffix, the label, and the caller's init verbatim; a pre-aborted signal registering nothing; a
 *   signal aborting after registration releasing its own entry and no other.
 * - Teardown: aborting releasing every registration and turning every later call into a no-op, the recorded history surviving, and scope exit disposing through abort.
 * - Unsubscribe: the tuple recorded and every registration on the reconstructed topic released, with the empty-id guard short-circuiting.
 * - The drivers: deliver running every raw handler on the topic with a Buffer, invokeGet republishing on the parent topic and honoring the lever, and invokeSet
 *   passing the lowercased value, the raw value, and the double's signal.
 */
import { assertNoUnhandledRejections, capturingLog, expectAt } from "./testing/index.ts";
import { describe, test } from "node:test";
import type { CapturingLog } from "./testing/index.ts";
import { HbpuAbortError } from "./util.ts";
import { TestMqttClient } from "./mqtt-client-double.ts";
import assert from "node:assert/strict";
import { format } from "node:util";
import { setImmediate as tick } from "node:timers/promises";

// Render every captured line at `level` the way the logger itself would, so a scenario asserts on the finished sentence rather than on the format string and its
// arguments separately.
function linesAt(log: CapturingLog, level: "debug" | "error" | "info" | "warn"): string[] {

  return log.entries.filter((entry) => entry.level === level).map((entry) => format(entry.message, ...entry.params));
}

describe("TestMqttClient - publish", () => {

  test("records the payload and the topic tail verbatim, for a string and for a Buffer", async () => {

    const mqtt = new TestMqttClient();
    const snapshot = Buffer.from([ 1, 2, 3 ]);

    await mqtt.publish("device1/status", "on");
    await mqtt.publish("device1/snapshot", snapshot);

    assert.deepEqual(mqtt.published, [ { payload: "on", topic: "device1/status" }, { payload: snapshot, topic: "device1/snapshot" } ]);
    assert.equal(mqtt.rejectedPublishes, 0);
  });

  test("the refusal lever rejects with the armed error, counts, and records nothing until it is cleared", async () => {

    const mqtt = new TestMqttClient();
    const refusal = new Error("broker refused the message");

    mqtt.publishRejection = refusal;

    await assert.rejects(mqtt.publish("device1/status", "on"), (error: unknown) => error === refusal);

    assert.equal(mqtt.rejectedPublishes, 1);
    assert.deepEqual(mqtt.published, []);

    // Clearing the lever returns the double to recording, so one scenario can drive a consumer through a refusal and out the other side of it.
    mqtt.publishRejection = null;

    await mqtt.publish("device1/status", "on");

    assert.deepEqual(mqtt.published, [{ payload: "on", topic: "device1/status" }]);
    assert.equal(mqtt.rejectedPublishes, 1);
  });

  test("a publish issued after the double aborted rejects with the abort reason and records nothing", async () => {

    const mqtt = new TestMqttClient();

    mqtt.abort();

    await assert.rejects(mqtt.publish("device1/status", "on"), (error: unknown) => error === mqtt.signal.reason);

    assert.deepEqual(mqtt.published, []);
  });

  test("a publish carrying an aborted per-publish signal rejects and records nothing", async () => {

    const mqtt = new TestMqttClient();
    const perPublish = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    perPublish.abort(reason);

    await assert.rejects(mqtt.publish("device1/status", "on", { signal: perPublish.signal }), (error: unknown) => error === reason);

    assert.deepEqual(mqtt.published, []);
    assert.equal(mqtt.aborted, false, "cancelling one publish leaves the double live");
  });
});

describe("TestMqttClient - publishGuarded", () => {

  test("a successful guarded publish records and says nothing at any level", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishGuarded("device1/status", "on");

      await tick();

      assert.deepEqual(mqtt.published, [{ payload: "on", topic: "device1/status" }]);
      assert.deepEqual(log.entries, []);
    });
  });

  test("a genuine failure is reported at error level, naming the topic tail and the reason", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishRejection = new Error("broker refused the message");
      mqtt.publishGuarded("device1/status", "on");

      await tick();

      assert.deepEqual(linesAt(log, "error"), ["Unable to publish to the MQTT topic device1/status: broker refused the message."]);
      assert.deepEqual(linesAt(log, "debug"), []);
      assert.equal(mqtt.rejectedPublishes, 1);
    });
  });

  test("a refusal carrying an HbpuAbortError drops to the debug line", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishRejection = new HbpuAbortError("shutdown");
      mqtt.publishGuarded("device1/status", "on");

      await tick();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
    });
  });

  test("a refusal carrying a platform AbortError drops to the debug line", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });
      const refusal = new Error("The operation was aborted");

      refusal.name = "AbortError";
      mqtt.publishRejection = refusal;
      mqtt.publishGuarded("device1/status", "on");

      await tick();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
    });
  });

  test("an aborted per-publish signal drops to the debug line whatever the rejection looks like", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });
      const perPublish = new AbortController();

      // The signal is aborted with a plain error, so the rejection carries neither cancellation shape. Reading the caller's own signal is the only thing that can keep
      // this line quiet, which is what makes the term the scenario proves unambiguous.
      perPublish.abort(new Error("device disposed"));
      mqtt.publishGuarded("device1/status", "on", { signal: perPublish.signal });

      await tick();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
      assert.equal(mqtt.aborted, false);
    });
  });

  test("an aborted double drops to the debug line whatever the rejection looks like", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      // The same isolation from the other side: aborting with a plain error leaves the double's own signal as the only term that can route this quietly.
      mqtt.abort(new Error("platform shutting down"));
      mqtt.publishGuarded("device1/status", "on");

      await tick();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
    });
  });
});

describe("TestMqttClient - registration", () => {

  test("records a raw subscription with the caller's topic, handler, and init verbatim", () => {

    const mqtt = new TestMqttClient();
    const init = { signal: new AbortController().signal };
    const handler = (): void => { /* Recorded, never run by this scenario. */ };

    mqtt.subscribe("device1/status", handler, init);

    const entry = expectAt(mqtt.subscriptions, 0, "the raw registration");

    assert.equal(entry.handler, handler);
    assert.equal(entry.init, init);
    assert.equal(entry.kind, "raw");
    assert.equal(entry.topic, "device1/status");
    assert.equal(entry.type, undefined, "a raw registration carries no label");
  });

  test("records get and set subscriptions on the appended suffix, carrying the label and the init", () => {

    const mqtt = new TestMqttClient();
    const setInit = { signal: new AbortController().signal, timeout: 500 };
    const getValue = (): string => "on";
    const setValue = (): void => { /* Recorded, never run by this scenario. */ };

    mqtt.subscribeGet("device1/power", "Power", getValue);
    mqtt.subscribeSet("device1/power", "Power", setValue, setInit);

    const get = expectAt(mqtt.subscriptions, 0, "the get registration");
    const set = expectAt(mqtt.subscriptions, 1, "the set registration");

    assert.equal(get.handler, getValue, "the getter is recorded as registered, not wrapped");
    assert.equal(get.kind, "get");
    assert.equal(get.topic, "device1/power/get");
    assert.equal(get.type, "Power");
    assert.equal(set.handler, setValue, "the setter is recorded as registered, not wrapped");
    assert.equal(set.init, setInit, "the set init is recorded verbatim, timeout and all");
    assert.equal(set.kind, "set");
    assert.equal(set.topic, "device1/power/set");
    assert.equal(set.type, "Power");
  });

  test("a pre-aborted per-subscription signal registers nothing, whichever verb is used", () => {

    const mqtt = new TestMqttClient();
    const controller = new AbortController();

    controller.abort();

    mqtt.subscribe("device1/status", () => { /* Never registered. */ }, { signal: controller.signal });
    mqtt.subscribeGet("device1/power", "Power", () => "on", { signal: controller.signal });
    mqtt.subscribeSet("device1/power", "Power", () => { /* Never registered. */ }, { signal: controller.signal });

    assert.deepEqual(mqtt.subscriptions, []);
  });

  test("a per-subscription signal aborting after registration releases its own entry and no other", () => {

    const mqtt = new TestMqttClient();
    const first = new AbortController();

    mqtt.subscribe("device1/status", () => { /* Released by its own signal. */ }, { signal: first.signal });
    mqtt.subscribe("device2/status", () => { /* Outlives the first registration. */ });

    assert.equal(mqtt.subscriptions.length, 2);

    first.abort();

    assert.deepEqual(mqtt.subscriptions.map((entry) => entry.topic), ["device2/status"]);
  });
});

describe("TestMqttClient - teardown", () => {

  test("aborting releases every registration, keeps the recorded history, and makes every later call a no-op", async () => {

    const mqtt = new TestMqttClient();

    mqtt.subscribe("device1/status", () => { /* Released by the double's abort, through its own signal. */ }, { signal: new AbortController().signal });
    mqtt.subscribe("device2/status", () => { /* Released by the double's abort, carrying no signal of its own. */ });

    await mqtt.publish("device1/status", "on");

    mqtt.unsubscribe("device3", "status");
    mqtt.abort();

    assert.equal(mqtt.aborted, true);
    assert.deepEqual(mqtt.subscriptions, [], "a registration that carried no signal of its own is released too");
    assert.equal(mqtt.published.length, 1, "the publish history survives teardown, so a test can read what the consumer did on its way out");
    assert.equal(mqtt.unsubscribes.length, 1);

    mqtt.subscribe("device4/status", () => { /* Never registered. */ });
    mqtt.subscribeGet("device4/power", "Power", () => "on");
    mqtt.subscribeSet("device4/power", "Power", () => { /* Never registered. */ });
    mqtt.unsubscribe("device1", "status");
    mqtt.publishGuarded("device1/status", "off");

    await tick();

    assert.deepEqual(mqtt.subscriptions, []);
    assert.equal(mqtt.unsubscribes.length, 1, "the aborted guard short-circuits before anything is recorded");
    assert.equal(mqtt.published.length, 1);
  });

  test("a second abort leaves the first reason standing", () => {

    const mqtt = new TestMqttClient();
    const first = new HbpuAbortError("shutdown");

    mqtt.abort(first);
    mqtt.abort(new HbpuAbortError("timeout"));

    assert.equal(mqtt.signal.reason, first);
  });

  test("scope exit disposes through abort, defaulting the reason", async () => {

    const mqtt = new TestMqttClient();

    // Scope-bound ownership is how a consumer holds the double, so the disposal worth proving is the one the scope exit fires rather than a direct call.
    const owned = async (): Promise<void> => {

      await using _scoped = mqtt;

      assert.equal(mqtt.aborted, false, "the double is live inside the owning scope");
    };

    await owned();

    assert.equal(mqtt.aborted, true);
    assert.ok(mqtt.signal.reason instanceof HbpuAbortError, "disposal defaults the abort reason exactly as a bare abort() does");
  });
});

describe("TestMqttClient - unsubscribe", () => {

  test("records the tuple and releases every registration on the reconstructed topic", () => {

    const mqtt = new TestMqttClient();

    mqtt.subscribe("device1/status", () => { /* Released by the unsubscribe. */ });
    mqtt.subscribe("device1/status", () => { /* Released by the same unsubscribe. */ });
    mqtt.subscribe("device2/status", () => { /* On another topic, untouched. */ });

    mqtt.unsubscribe("device1", "status");

    assert.deepEqual(mqtt.unsubscribes, [{ id: "device1", topic: "status" }]);
    assert.deepEqual(mqtt.subscriptions.map((entry) => entry.topic), ["device2/status"]);
  });

  test("an empty id short-circuits the whole call", () => {

    const mqtt = new TestMqttClient();

    mqtt.subscribe("device1/status", () => { /* Untouched by a short-circuited call. */ });
    mqtt.unsubscribe("", "status");

    assert.deepEqual(mqtt.unsubscribes, []);
    assert.equal(mqtt.subscriptions.length, 1);
  });
});

describe("TestMqttClient - drivers", () => {

  test("deliver runs every raw handler on the topic, in registration order, and awaits the pass", async () => {

    const mqtt = new TestMqttClient();
    const seen: string[] = [];

    mqtt.subscribe("device1/status", (payload: Buffer) => {

      seen.push("first:" + payload.toString());
    });

    // An asynchronous handler settles before delivery resolves, so a consumer whose handler awaits its own work is observable by the time the driver returns.
    mqtt.subscribe("device1/status", async (payload: Buffer) => {

      await tick();
      seen.push("second:" + payload.toString());
    });

    mqtt.subscribeGet("device1/status", "Status", () => "on");

    mqtt.subscribe("device2/status", () => {

      seen.push("other");
    });

    await mqtt.deliver("device1/status", "on");

    assert.deepEqual(seen, [ "first:on", "second:on" ], "only the raw handlers on the delivered topic run");
  });

  test("deliver hands a Buffer payload through unchanged", async () => {

    const mqtt = new TestMqttClient();
    const received: Buffer[] = [];
    const payload = Buffer.from([ 0, 1, 2 ]);

    mqtt.subscribe("device1/raw", (message: Buffer) => {

      received.push(message);
    });

    await mqtt.deliver("device1/raw", payload);

    assert.equal(expectAt(received, 0, "the delivered payload"), payload);
  });

  test("invokeGet answers the getter's value and publishes it on the parent topic", async () => {

    const mqtt = new TestMqttClient();

    mqtt.subscribeGet("device1/power", "Power", () => "on");

    assert.equal(await mqtt.invokeGet("device1/power/get"), "on");
    assert.deepEqual(mqtt.published, [{ payload: "on", topic: "device1/power" }]);
  });

  test("invokeGet counts a refused republish and still answers the getter's value", async () => {

    const mqtt = new TestMqttClient();

    mqtt.subscribeGet("device1/power", "Power", () => "on");

    mqtt.publishRejection = new Error("broker refused the message");

    assert.equal(await mqtt.invokeGet("power/get"), "on");
    assert.deepEqual(mqtt.published, [], "the refused republish is not recorded");
    assert.equal(mqtt.rejectedPublishes, 1);
  });

  test("invokeGet answers undefined when no get registration matches the suffix", async () => {

    const mqtt = new TestMqttClient();
    let called = false;

    mqtt.subscribeGet("device1/power", "Power", () => {

      called = true;

      return "on";
    });

    assert.equal(await mqtt.invokeGet("device2/power/get"), undefined);
    assert.equal(called, false);
    assert.deepEqual(mqtt.published, []);
  });

  test("invokeSet passes the lowercased value, the raw value, and the double's signal", async () => {

    const mqtt = new TestMqttClient();
    const calls: { rawValue: string; signal: AbortSignal; value: string }[] = [];

    mqtt.subscribeSet("device1/power", "Power", (value, rawValue, signal) => {

      calls.push({ rawValue, signal, value });
    });

    await mqtt.invokeSet("device1/power/set", "TRUE");

    const call = expectAt(calls, 0, "the setter invocation");

    assert.equal(call.value, "true");
    assert.equal(call.rawValue, "TRUE");
    assert.equal(call.signal, mqtt.signal);
  });

  test("invokeSet leaves an unmatched suffix alone", async () => {

    const mqtt = new TestMqttClient();
    let called = false;

    mqtt.subscribeSet("device1/power", "Power", () => {

      called = true;
    });

    await mqtt.invokeSet("device2/power/set", "true");

    assert.equal(called, false);
  });
});
