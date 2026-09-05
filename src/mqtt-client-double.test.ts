/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-client-double.test.ts: Unit tests for the recording MqttClient double - what it records, how it routes a refused publish, and the abort lifecycle it mirrors.
 *
 * The scenarios, in the order they run:
 *
 * - Publishing: a string and a Buffer payload recorded verbatim on the topic tail; the refusal lever rejecting and counting in place of recording; a publish rejected
 *   by the double's own signal and by a per-publish signal.
 * - The guarded path: a successful publish that says nothing, a genuine failure on the error line, each cancellation term - the double aborted, the per-publish
 *   signal aborted, an HbpuAbortError refusal, an "AbortError"-named refusal - reaching the debug line, and an offline refusal reaching the dropped line. The signal
 *   terms are exercised with a plain error as the abort reason, so nothing about the rejection's shape can route them and only the signal read can.
 * - The change gate: the first payload on a topic recorded and a repeat of it suppressed, the Buffer copy and the cross-kind answer, a refused or parked publish
 *   leaving the memory as it was, the lever's false-to-true transition clearing it where a re-assert does not, and a suppressed call saying nothing at all.
 * - Connection state: `connected` true on a fresh double, a publish refused and counted while it is false, the refusal answering ahead of the arbitrary refusal
 *   lever, the getter's republish absorbing the same refusal, and `connected` reading false once the double aborts.
 * - The publish hold: a held publish recording only at release, behind the publish that preceded the hold; the double aborting, the refusal lever arming, and the
 *   connection dropping during a hold each answering the held publish at release, with the guarded form of the teardown reaching the debug line alone; a publish
 *   refused at issue never parking and the release freeing nothing; two holds each freeing their own gate's publishes; and the get driver's republish parking too.
 * - The suffix view: publishedTo answering a topic's publishes in order, holding back a topic the suffix merely appears inside, answering an empty array when
 *   nothing matches, and handing back an array of its own rather than the recording.
 * - Registration: raw, get, and set entries carrying the appended suffix, the label, and the caller's init verbatim; a pre-aborted signal registering nothing; a
 *   signal aborting after registration releasing its own entry and no other.
 * - Teardown: aborting releasing every registration and turning every later call into a no-op - the drivers' quiet answer among them - the recorded history
 *   surviving, and scope exit disposing through abort.
 * - Unsubscribe: the tuple recorded and every registration on the reconstructed topic released, with the empty-id guard short-circuiting.
 * - The drivers: deliver running every raw handler on the topic with a Buffer, invokeGet republishing on the parent topic and honoring the lever, and invokeSet
 *   passing the lowercased value, the raw value, and the double's signal; a suffix matching no live registration throwing with the registered topics of that kind
 *   named, whether nothing of the kind was ever registered or the registration was released by its own signal; and the class example's call shape running as
 *   written.
 */
import { assertNoUnhandledRejections, capturingLog, expectAt, settle } from "./testing/index.ts";
import { describe, test } from "node:test";
import type { CapturingLog } from "./testing/index.ts";
import { HbpuAbortError } from "./util.ts";
import { MqttOfflineError } from "./mqtt-publish.ts";
import { TestMqttClient } from "./mqtt-client-double.ts";
import assert from "node:assert/strict";
import { format } from "node:util";

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

      await settle();

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

      await settle();

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

      await settle();

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

      await settle();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
    });
  });

  test("a refusal carrying an MqttOfflineError drops to the dropped line", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishRejection = new MqttOfflineError();
      mqtt.publishGuarded("device1/status", "on");

      await settle();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish dropped while disconnected from the broker: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
      assert.equal(mqtt.rejectedPublishes, 1);
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

      await settle();

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

      await settle();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
    });
  });
});

describe("TestMqttClient - the change gate", () => {

  // The double's half of the `ifChanged` contract. What is asserted here is where the gate and the memory sit among the double's own admissions and levers; the
  // comparison and keeping rules themselves are stated once in the vocabulary module's suite.
  const TOPIC = "device1/status";
  const OTHER = "device2/status";

  test("records the first payload on a topic, suppresses a repeat of it, and leaves the memory to change-gated publishes alone", async () => {

    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [ { payload: "on", topic: TOPIC }, { payload: "off", topic: TOPIC } ]);
      assert.equal(mqtt.rejectedPublishes, 0, "suppressing a publish is not refusing it");

      // A publish that does not ask for the gate neither reads the memory nor writes it, so it can neither arm nor disarm the gated call after it.
      await mqtt.publish(TOPIC, "on");

      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [ { payload: "on", topic: TOPIC }, { payload: "off", topic: TOPIC }, { payload: "on", topic: TOPIC } ]);
    });
  });

  test("keeps a copy of a remembered Buffer and never matches a Buffer against a remembered string", async () => {

    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const scratch = Buffer.from("on");

      mqtt.publishGuarded(TOPIC, scratch, { ifChanged: true });
      await settle();

      scratch.write("no");
      mqtt.publishGuarded(TOPIC, Buffer.from("on"), { ifChanged: true });
      await settle();

      assert.equal(mqtt.published.length, 1, "a fresh buffer carrying the recorded bytes must be suppressed even after the caller rewrote its own buffer");

      mqtt.publishGuarded(OTHER, "on", { ifChanged: true });
      await settle();

      mqtt.publishGuarded(OTHER, Buffer.from("on"), { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published.map((entry) => entry.topic), [ TOPIC, OTHER, OTHER ],
        "a Buffer carrying a remembered string's bytes is a different kind of payload and must be recorded");
    });
  });

  test("leaves the memory as it was when the refusal lever answers, so the same payload records once the lever is cleared", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishRejection = new Error("broker refused the message.");
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [], "a refused publish records nothing");
      assert.equal(mqtt.rejectedPublishes, 1);
      assert.deepEqual(linesAt(log, "error"), ["Unable to publish to the MQTT topic device1/status: broker refused the message."]);

      mqtt.publishRejection = null;
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", topic: TOPIC }], "the refusal wrote nothing, so the retry of the same payload must record");
    });
  });

  test("clears the memory when the lever restores a session, and leaves it standing on a write that moves nothing", async () => {

    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      // The client's connect fires once per session rather than on every reading of the connection, so re-asserting a lever that already reads true is not a session
      // event and must not wipe what the session delivered.
      mqtt.connected = true;
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", topic: TOPIC }], "a lever write that moves nothing is not a session event");

      mqtt.connected = false;

      await mqtt.publish(TOPIC, "on", { ifChanged: true });

      assert.deepEqual(mqtt.published, [{ payload: "on", topic: TOPIC }], "an unchanged payload is answered by the gate, ahead of the offline refusal");
      assert.equal(mqtt.rejectedPublishes, 0, "a publish the gate answered was never offered to the admissions");

      await assert.rejects(mqtt.publish(TOPIC, "off", { ifChanged: true }), MqttOfflineError);

      assert.equal(mqtt.rejectedPublishes, 1, "a changed payload with no session to carry it is refused and counted");

      mqtt.connected = true;
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [ { payload: "on", topic: TOPIC }, { payload: "on", topic: TOPIC } ],
        "a session restored begins with nothing remembered, so the current value records again");
    });
  });

  test("rejects a change-gated publish on an aborted double with the abort reason, and reports the guarded form on the aborted line", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      // A cancelled publish is answered by the signal rather than by the gate, and the per-publish signal is what shows it: the double's own abort empties the
      // memory, so after that nothing is remembered and the gate falls through whatever its position. A signal that cancels one publish leaves the memory
      // standing, so this call is the one that reads the gate's position against a payload the double still holds.
      const perPublish = new AbortController();
      const reason = new HbpuAbortError("replaced");

      perPublish.abort(reason);

      await assert.rejects(mqtt.publish(TOPIC, "on", { ifChanged: true, signal: perPublish.signal }), (error: unknown) => error === reason);

      mqtt.abort();

      await assert.rejects(mqtt.publish(TOPIC, "on", { ifChanged: true }), (error: unknown) => error === mqtt.signal.reason);

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(mqtt.published, [{ payload: "on", topic: TOPIC }], "a torn-down double records nothing, whatever the memory holds");
    });
  });

  test("parks two change-gated calls of one payload and records both at release, then suppresses the next", async () => {

    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const release = mqtt.holdPublishes();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });

      await settle();

      assert.deepEqual(mqtt.published, [], "both calls park before either is recorded");

      release();
      await settle();

      assert.deepEqual(mqtt.published, [ { payload: "on", topic: TOPIC }, { payload: "on", topic: TOPIC } ],
        "the memory takes a payload only once the publish is recorded, so neither parked call could suppress the other");

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.equal(mqtt.published.length, 2, "a call issued after the release has a recorded payload to weigh against and must be suppressed");
    });
  });

  test("says nothing, counts nothing, and records nothing when a payload is suppressed", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", topic: TOPIC }]);
      assert.equal(mqtt.rejectedPublishes, 0);
      assert.deepEqual(log.entries, [], "nothing was attempted, so there is nothing to report at any level");
    });
  });
});

describe("TestMqttClient - connection state", () => {

  test("connected defaults to true, and setting it false makes the double refuse exactly as the client does", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      assert.equal(mqtt.connected, true, "a fresh double stands in for a client that holds a session");

      mqtt.connected = false;

      await assert.rejects(mqtt.publish("device1/status", "on"), (error: unknown) => error instanceof MqttOfflineError);

      assert.deepEqual(mqtt.published, [], "a refused publish records nothing");
      assert.equal(mqtt.rejectedPublishes, 1);

      // The client reads its session state before anything else, so the double does too: with both refusals armed the offline one is what a caller sees.
      mqtt.publishRejection = new Error("broker refused the message");

      await assert.rejects(mqtt.publish("device1/status", "on"), (error: unknown) => error instanceof MqttOfflineError);

      assert.equal(mqtt.rejectedPublishes, 2);

      mqtt.publishRejection = null;
      mqtt.publishGuarded("device1/status", "on");

      await settle();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish dropped while disconnected from the broker: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);

      mqtt.connected = true;

      await mqtt.publish("device1/status", "on");

      assert.deepEqual(mqtt.published, [{ payload: "on", topic: "device1/status" }], "a session restored records again");
    });
  });

  test("invokeGet's republish while connected is false is refused, counted, and still answers the getter's value", async () => {

    // The get driver absorbs a refused republish rather than answering it, which is the client's own posture: the get path reports a failed republish in its log and
    // hands the caller the value it asked for either way. The counter is what a test reads to prove the refusal happened at all.
    const mqtt = new TestMqttClient();

    mqtt.subscribeGet("device1/status", "Status", () => "42");
    mqtt.connected = false;

    assert.equal(await mqtt.invokeGet("device1/status/get"), "42");
    assert.deepEqual(mqtt.published, []);
    assert.equal(mqtt.rejectedPublishes, 1);
  });

  test("connected reads false once the double aborts, whatever the lever holds", async () => {

    // The composition the client makes between mqtt.js's flag and its own lifetime, mirrored: the lever is left true and the abort is what answers, so a consumer
    // reading `connected` on a torn-down double is told the truth without the test having to reset anything.
    const mqtt = new TestMqttClient();

    mqtt.abort();

    assert.equal(mqtt.connected, false);
    assert.equal(mqtt.aborted, true);
  });
});

describe("TestMqttClient - the publish hold", () => {

  test("a held publish records only at release, behind the publish that preceded the hold", async () => {

    const mqtt = new TestMqttClient();

    await mqtt.publish("device1/status", "before");

    const release = mqtt.holdPublishes();
    const parked = mqtt.publish("device1/status", "held");

    await settle();

    assert.deepEqual(mqtt.published, [{ payload: "before", topic: "device1/status" }], "a parked publish records nothing while it waits");

    release();
    await parked;

    assert.deepEqual(mqtt.published, [ { payload: "before", topic: "device1/status" }, { payload: "held", topic: "device1/status" } ]);
    assert.equal(mqtt.rejectedPublishes, 0, "parking a publish is not refusing it");
  });

  test("a held publish rejects at release with the abort reason when the double aborted during the hold", async () => {

    const mqtt = new TestMqttClient();
    const release = mqtt.holdPublishes();
    const parked = mqtt.publish("device1/status", "on");

    await settle();

    // Tearing the double down onto a parked publish is the race the hold exists to force. The second admission is what answers it: the composed signal the first
    // admission read is the same one read at release, so the publish rejects rather than recording into a double that is already down.
    mqtt.abort();
    release();

    await assert.rejects(parked, (error: unknown) => error === mqtt.signal.reason);

    assert.deepEqual(mqtt.published, []);
  });

  test("the guarded form of that teardown reaches the debug aborted line and nothing at error", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });
      const release = mqtt.holdPublishes();

      mqtt.publishGuarded("device1/status", "on");

      await settle();

      assert.deepEqual(log.entries, [], "a parked guarded publish says nothing while it waits");

      mqtt.abort();
      release();

      await settle();

      assert.deepEqual(linesAt(log, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log, "error"), []);
      assert.deepEqual(mqtt.published, []);
    });
  });

  test("the refusal lever armed during a hold rejects the held publish at release and counts once", async () => {

    const mqtt = new TestMqttClient();
    const refusal = new Error("broker refused the message");
    const release = mqtt.holdPublishes();
    const parked = mqtt.publish("device1/status", "on");

    await settle();

    assert.equal(mqtt.rejectedPublishes, 0, "a parked publish has been refused nothing yet");

    mqtt.publishRejection = refusal;
    release();

    await assert.rejects(parked, (error: unknown) => error === refusal);

    assert.equal(mqtt.rejectedPublishes, 1, "the refusal is counted at the admission that made it, and only there");
    assert.deepEqual(mqtt.published, []);
  });

  test("connected dropping during a hold refuses the held publish at release with MqttOfflineError and counts once", async () => {

    const mqtt = new TestMqttClient();
    const release = mqtt.holdPublishes();
    const parked = mqtt.publish("device1/status", "on");

    await settle();

    mqtt.connected = false;
    release();

    await assert.rejects(parked, (error: unknown) => error instanceof MqttOfflineError);

    assert.equal(mqtt.rejectedPublishes, 1);
    assert.deepEqual(mqtt.published, []);
  });

  test("a publish the lever refuses at issue never parks, counts once, and the release frees nothing", async () => {

    const mqtt = new TestMqttClient();
    const refusal = new Error("broker refused the message");

    mqtt.publishRejection = refusal;

    const release = mqtt.holdPublishes();

    // The rejection arriving with no release behind it is what proves the publish was refused ahead of the park rather than parked and refused at release.
    await assert.rejects(mqtt.publish("device1/status", "on"), (error: unknown) => error === refusal);

    assert.equal(mqtt.rejectedPublishes, 1);

    release();
    await settle();

    assert.deepEqual(mqtt.published, []);
    assert.equal(mqtt.rejectedPublishes, 1, "nothing was parked, so the release refuses nothing a second time");
  });

  test("a publish refused offline at issue never parks, counts once, and the release frees nothing", async () => {

    const mqtt = new TestMqttClient();

    mqtt.connected = false;

    const release = mqtt.holdPublishes();

    await assert.rejects(mqtt.publish("device1/status", "on"), (error: unknown) => error instanceof MqttOfflineError);

    assert.equal(mqtt.rejectedPublishes, 1);

    release();
    await settle();

    assert.deepEqual(mqtt.published, []);
    assert.equal(mqtt.rejectedPublishes, 1, "nothing was parked, so the release refuses nothing a second time");
  });

  test("each release frees its own gate's publishes and leaves a later hold standing", async () => {

    const mqtt = new TestMqttClient();
    const releaseFirst = mqtt.holdPublishes();
    const first = mqtt.publish("device1/first", "1");
    const releaseSecond = mqtt.holdPublishes();
    const second = mqtt.publish("device1/second", "2");

    await settle();

    assert.deepEqual(mqtt.published, []);

    releaseFirst();
    await first;

    assert.deepEqual(mqtt.published, [{ payload: "1", topic: "device1/first" }], "the first release frees the publish parked on its own gate alone");

    // The second hold is still the active one, so a publish issued after the first release parks rather than recording - the ownership guard the release makes.
    const third = mqtt.publish("device1/third", "3");

    await settle();

    assert.deepEqual(mqtt.published, [{ payload: "1", topic: "device1/first" }], "the first release did not stand the second hold down");

    releaseSecond();
    await Promise.all([ second, third ]);

    assert.deepEqual(mqtt.published,
      [ { payload: "1", topic: "device1/first" }, { payload: "2", topic: "device1/second" }, { payload: "3", topic: "device1/third" } ]);
  });

  test("the get driver's republish parks with everything else and lands at release", async () => {

    const mqtt = new TestMqttClient();

    mqtt.subscribeGet("device1/status", "Status", () => "42");

    const release = mqtt.holdPublishes();
    const invoked = mqtt.invokeGet("device1/status/get");

    await settle();

    assert.deepEqual(mqtt.published, [], "the republish is parked, so the driver has not answered yet");

    release();

    assert.equal(await invoked, "42");
    assert.deepEqual(mqtt.published, [{ payload: "42", topic: "device1/status" }]);
  });
});

describe("TestMqttClient - publishedTo", () => {

  test("answers the publishes whose topic ends with the suffix, in order, and holds back a topic it merely appears inside", async () => {

    const mqtt = new TestMqttClient();

    // The middle topic carries "status" in its body rather than at its end, so a substring or prefix match would answer three where the suffix match answers two.
    await mqtt.publish("device1/power/status", "on");
    await mqtt.publish("device1/status/detail", "verbose");
    await mqtt.publish("device2/power/status", "off");

    assert.deepEqual(mqtt.publishedTo("status"), [ { payload: "on", topic: "device1/power/status" }, { payload: "off", topic: "device2/power/status" } ]);
    assert.deepEqual(mqtt.publishedTo("device1/power/status"), [{ payload: "on", topic: "device1/power/status" }], "a whole topic is a suffix of itself");
  });

  test("answers an empty array when no recorded topic ends with the suffix", async () => {

    const mqtt = new TestMqttClient();

    await mqtt.publish("device1/status", "on");

    assert.deepEqual(mqtt.publishedTo("device9/status"), [], "nothing having reached a topic is an outcome, not a miss to report");
  });

  test("answers a fresh array rather than the recording itself", async () => {

    const mqtt = new TestMqttClient();

    await mqtt.publish("device1/status", "on");

    const answer = mqtt.publishedTo("device1/status");

    assert.notEqual(answer, mqtt.published);

    answer.length = 0;

    assert.equal(mqtt.published.length, 1, "mutating the answer leaves the recording intact");
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

    await settle();

    assert.deepEqual(mqtt.subscriptions, []);
    assert.equal(mqtt.unsubscribes.length, 1, "the aborted guard short-circuits before anything is recorded");
    assert.equal(mqtt.published.length, 1);
  });

  test("both drivers answer quietly on an aborted double rather than reporting a miss", async () => {

    const mqtt = new TestMqttClient();
    let called = false;

    mqtt.subscribeGet("device1/power", "Power", () => {

      called = true;

      return "on";
    });

    mqtt.subscribeSet("device1/power", "Power", () => {

      called = true;
    });

    mqtt.abort();

    // Teardown released both registrations, so every driver call after it misses. The quiet answer is the no-op posture the calls above take: a consumer's shutdown
    // path stays drivable, and a live double is the only place an unmatched suffix is worth reporting.
    assert.equal(await mqtt.invokeGet("device1/power/get"), undefined);
    await mqtt.invokeSet("device1/power/set", "TRUE");

    assert.equal(called, false, "neither handler runs on a torn-down double");
    assert.deepEqual(mqtt.published, [], "and the get driver's republish never happens");
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

      await settle();
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

  test("invokeGet throws on an unmatched suffix, naming the suffix and the registered get topics", async () => {

    const mqtt = new TestMqttClient();
    let called = false;

    mqtt.subscribeGet("device1/power", "Power", () => {

      called = true;

      return "on";
    });

    // A set registration stands alongside the get one so the enumeration proves it carries the kind the driver looked in...an author who reached for the wrong
    // driver reads that straight from the failure rather than from a second run.
    mqtt.subscribeSet("device1/brightness", "Brightness", () => { /* Never run by this scenario. */ });

    await assert.rejects(mqtt.invokeGet("device2/power/get"), (error: Error) => {

      assert.match(error.message, /device2\/power\/get/, "the missed suffix is named");
      assert.match(error.message, /"device1\/power\/get"/, "the registered get topic is enumerated");
      assert.equal(error.message.includes("device1/brightness/set"), false, "a get miss enumerates the get topics, not the set topics");

      return true;
    });

    assert.equal(called, false, "a miss never reaches a getter");
    assert.deepEqual(mqtt.published, [], "and never republishes");
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

  test("invokeSet throws on an unmatched suffix, naming the suffix and the registered set topics", async () => {

    const mqtt = new TestMqttClient();
    let called = false;

    mqtt.subscribeSet("device1/power", "Power", () => {

      called = true;
    });

    await assert.rejects(mqtt.invokeSet("device2/power/set", "true"), (error: Error) => {

      assert.match(error.message, /device2\/power\/set/, "the missed suffix is named");
      assert.match(error.message, /"device1\/power\/set"/, "the registered set topic is enumerated");

      return true;
    });

    assert.equal(called, false, "a miss never reaches a setter");
  });

  test("a miss on a double holding no registrations of that kind reads as its own phrase", async () => {

    // A raw registration is neither kind the drivers look in, so this double holds a registration and still has nothing to enumerate...the phrase is what keeps the
    // sentence from trailing off into an empty list.
    const mqtt = new TestMqttClient();

    mqtt.subscribe("device1/status", () => { /* Neither a getter nor a setter. */ });

    await assert.rejects(mqtt.invokeGet("device1/status/get"), (error: Error) => {

      assert.match(error.message, /device1\/status\/get/, "the missed suffix is named");
      assert.match(error.message, /no get topics are registered/, "and an empty list of that kind reads as a phrase");

      return true;
    });
  });

  test("a registration released by its own signal is a miss that throws, since the quiet posture belongs to the double's abort alone", async () => {

    // Driving a topic whose handler the consumer's own lifecycle released is the stale binding worth hearing about, so a live double reports it. The empty
    // enumeration is what tells the author the registration is gone rather than misnamed.
    const mqtt = new TestMqttClient();
    const controller = new AbortController();

    mqtt.subscribeSet("device1/power", "Power", () => { /* Released before the driver runs. */ }, { signal: controller.signal });

    controller.abort();

    await assert.rejects(mqtt.invokeSet("device1/power/set", "TRUE"), (error: Error) => {

      assert.match(error.message, /device1\/power\/set/, "the missed suffix is named");
      assert.match(error.message, /no set topics are registered/, "and the released registration is gone from the enumeration");

      return true;
    });

    assert.equal(mqtt.aborted, false, "the double itself never aborted");
  });

  test("the class example's call shape runs as written: a registration on the parent topic, driven on the suffixed tail", async () => {

    // The example in the class documentation is shipped guidance, so it is pinned executable here...a plugin registers its setter on the parent topic and the test
    // drives the recorded topic, which carries the suffix the client appends. Drift in either half fails this row rather than a consumer's first attempt.
    const mqtt = new TestMqttClient();
    const device = { power: false };

    mqtt.subscribeSet("device1/power", "Power", (value) => {

      device.power = (value === "true");
    });

    await mqtt.invokeSet("device1/power/set", "TRUE");

    assert.equal(device.power, true);
  });
});

describe("TestMqttClient - the unresolved-placeholder refusal", () => {

  // The double refuses what the client refuses, so a scenario that hands it a template fails where the plugin would have failed rather than recording a topic the
  // broker could never match.
  const UNRESOLVED = "relay/{output}/state";

  test("publish rejects with the refusal and records nothing", async () => {

    const mqtt = new TestMqttClient();

    await assert.rejects(mqtt.publish(UNRESOLVED, "on"), { message: "TestMqttClient: the topic \"relay/{output}/state\" carries a brace; a placeholder must be " +
      "resolved through resolveMqttTopic before the topic is used." });
    assert.deepEqual(mqtt.published, []);
  });

  test("refuses a brace-carrying tail ahead of the offline refusal, counting no refusal", async () => {

    // The double here holds no session, so the offline refusal is armed and waiting. The brace refusal answering instead, with the counter untouched, is what
    // proves it sits ahead of the session admission, exactly where the client's own refusal sits.
    const mqtt = new TestMqttClient();

    mqtt.connected = false;

    await assert.rejects(mqtt.publish(UNRESOLVED, "on"), { message: "TestMqttClient: the topic \"relay/{output}/state\" carries a brace; a placeholder must be " +
      "resolved through resolveMqttTopic before the topic is used." });
    assert.equal(mqtt.rejectedPublishes, 0);
    assert.deepEqual(mqtt.published, []);
  });

  test("publishGuarded never throws and reports the refusal on one error line naming the tail", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      assert.doesNotThrow(() => mqtt.publishGuarded(UNRESOLVED, "on"));

      await settle();

      assert.deepEqual(linesAt(log, "error"), ["Unable to publish to the MQTT topic relay/{output}/state: TestMqttClient: the topic " +
        "\"relay/{output}/state\" carries a brace; a placeholder must be resolved through resolveMqttTopic before the topic is used."]);
      assert.deepEqual(mqtt.published, []);
    });
  });

  test("subscribe, subscribeGet, subscribeSet, and unsubscribe throw synchronously and register nothing", () => {

    const mqtt = new TestMqttClient();
    const refusal = /^Error: TestMqttClient: the topic "relay\/\{output\}(\/state)?(\/get|\/set)?" carries a brace;/;

    assert.throws(() => mqtt.subscribe(UNRESOLVED, () => { /* Never registered. */ }), refusal);
    assert.throws(() => mqtt.subscribeGet("relay/{output}", "relay", () => "on"), refusal);
    assert.throws(() => mqtt.subscribeSet("relay/{output}", "relay", () => { /* Never registered. */ }), refusal);
    assert.throws(() => mqtt.unsubscribe("device1", UNRESOLVED), refusal);

    assert.deepEqual(mqtt.subscriptions, []);
    assert.deepEqual(mqtt.unsubscribes, []);
  });

  test("leaves a brace-free tail alone on every verb", () => {

    const mqtt = new TestMqttClient();

    assert.doesNotThrow(() => mqtt.subscribe("relay/1/state", () => { /* Registered. */ }));
    assert.doesNotThrow(() => mqtt.subscribeGet("relay/1", "relay", () => "on"));
    assert.doesNotThrow(() => mqtt.subscribeSet("relay/1", "relay", () => { /* Registered. */ }));
    assert.doesNotThrow(() => mqtt.unsubscribe("device1", "relay/1/state"));

    assert.deepEqual(mqtt.subscriptions.map((entry) => entry.topic), [ "relay/1/state", "relay/1/get", "relay/1/set" ]);
  });

  test("answers after the abort and empty-id guards, so a torn-down double and an empty id stay no-ops", async () => {

    const mqtt = new TestMqttClient();

    mqtt.abort();

    const reason = await mqtt.publish(UNRESOLVED, "on").then(() => null, (error: unknown) => error);

    assert.ok(reason instanceof HbpuAbortError, "an aborted double rejects with its own abort reason rather than the refusal, observed: " + String(reason));
    assert.doesNotThrow(() => mqtt.subscribe(UNRESOLVED, () => { /* Never reached. */ }), "subscribe on an aborted double stays a no-op");
    assert.doesNotThrow(() => mqtt.unsubscribe("device1", UNRESOLVED), "unsubscribe on an aborted double stays a no-op");

    const live = new TestMqttClient();

    assert.doesNotThrow(() => live.unsubscribe("", UNRESOLVED), "an empty id short-circuits ahead of the refusal");

    assert.deepEqual(live.unsubscribes, []);
    assert.deepEqual(mqtt.published, []);
  });
});
