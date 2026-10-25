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
 * - The change gate: the first payload on a topic recorded and a repeat of it suppressed, the Buffer copy and the cross-kind answer, a refused publish leaving the
 *   memory as it was, a parked publish remembered as it is issued so a call behind it is weighed against it and a return to the earlier value records, a parked publish
 *   forgotten when its own signal ends its wait, so a retry in the abort's own turn or one await later is suppressed and one after a settle records, and when it fails
 *   at release only while the entry still carries its own token, the lever's false-to-true transition clearing the memory where a re-assert does not, and a suppressed
 *   call saying nothing at all.
 * - Connection state: `connected` true on a fresh double, a publish refused and counted while it is false, the refusal answering ahead of the arbitrary refusal
 *   lever, the getter's republish absorbing the same refusal, and `connected` reading false once the double aborts.
 * - The connect notification: the lever's false-to-true edge invoking every registration once and in order, after the memory clear and with the session reading
 *   live; a write that is not that edge invoking nothing; a registration joining a session already held waiting for the edge after it; the releases - a signal, a
 *   pre-aborted signal, the abort - leaving the edge nothing to invoke; a faulting handler reaching the sentence the client logs while the registration beside it
 *   runs; a never-settling handler holding nothing back; the same function twice counting once; and a handler that releases a sibling or registers another mid-pass.
 * - The publish hold: a held publish recording only at release, behind the publish that preceded the hold; the double aborting during a hold rejecting the held
 *   publish at once, the refusal lever arming and the connection dropping during a hold each answering it at release, with the guarded form of the teardown
 *   reaching the debug line alone; a publish refused at issue never parking and the release freeing nothing; nested holds each freeing their own gate's
 *   publishes; and the get driver's republish parking too.
 * - The suffix view: publishedTo answering a topic's publishes in order, holding back a topic the suffix merely appears inside, answering an empty array when
 *   nothing matches, and handing back an array of its own rather than the recording.
 * - Registration: raw, get, and set entries carrying the appended suffix, the label, and the caller's init verbatim; a pre-aborted signal registering nothing; a
 *   signal aborting after registration releasing its own entry and no other.
 * - Teardown: aborting releasing every registration and turning every later call into a no-op - the drivers' quiet answer among them - the recorded history
 *   surviving, and scope exit disposing through abort.
 * - The final words: a registered word recorded while the double is live and the end aborting after it; a pre-aborted signal and an aborted double registering
 *   nothing; the refusals in registration order with the offline refusal; a second end() handed the first one's promise; a handler calling end() handed that same
 *   promise and run once, the end still aborting after it; an end and a disposal with nothing registered answering an empty array and aborting with the default
 *   reason; end() after abort() answering an empty array; disposal stating the words; a word pending when an outside abort lands refusing with its reason and the
 *   abort warning once; an abort, and an unawaited end() followed by an abort, each warning once, while an end, a disposal, and a registration its own signal
 *   released warn nothing; an invalid grace refused synchronously; a registration made once the end has begun never invoked; a word that never settles refused at the
 *   grace on a test clock and not before; a parked publish refused at the grace; a connect registration the end or the double's abort cuts short writing the cancelled
 *   line the client logs too at debug, whatever it fails with once the double has aborted, and one failing on a timeout of its own keeping the error line; the testing
 *   entry point, imported in a child process, loading neither mqtt nor the client, where importing the client loads mqtt; and the verbs held equal to the client's at
 *   compile time.
 * - The end's quiet: a word under the window recorded, issued at once or later; every other publish refused with the end's shutdown error, recording and counting
 *   nothing and leaving the guarded form only its aborted line; an aborted publish signal and an outside abort still answering with their own reasons and a
 *   change-gated repeat refused; the drivers running no handler and throwing no miss; a session restored running no registration; and a publish parked before
 *   the end recording at release.
 * - Unsubscribe: the tuple recorded and every registration on the reconstructed topic released, with the empty-id guard short-circuiting.
 * - The drivers: deliver running every raw handler on the topic with a Buffer, invokeGet republishing on the parent topic and honoring the lever, and invokeSet
 *   passing the lowercased value, the raw value, and the double's signal; a suffix matching no live registration throwing with the registered topics of that kind
 *   named, whether nothing of the kind was ever registered or the registration was released by its own signal; and the class example's call shape running as
 *   written.
 * - The unresolved-placeholder refusal: publish and publishGuarded refusing a brace-carrying tail - the raw rejection and the guarded path's single error line -
 *   ahead of the offline refusal and counting nothing; subscribe, subscribeGet, subscribeSet, and unsubscribe throwing synchronously and registering nothing on
 *   the same tail, while a brace-free tail passes every verb untouched; and the abort and empty-id guards answering ahead of the refusal, so a torn-down double
 *   and an empty id stay no-ops rather than reaching it.
 */
import type { Assert, Equal } from "./testing/index.ts";
import { HbpuAbortError, composeSignals, isTimeoutReason } from "./util.ts";
import { MQTT_AVAILABILITY_ONLINE, MQTT_AVAILABILITY_TOPIC } from "./mqtt-topics.ts";
import { MQTT_CONNECT_HANDLER_CANCELLED, MQTT_UNSAID_WORDS_WARNING, MqttOfflineError, guardedPublishReason } from "./mqtt-publish.ts";
import { assertNoUnhandledRejections, capturingLog, errnoError, expectAt, linesAt, settle } from "./testing/index.ts";
import { describe, test } from "node:test";
import { format, promisify } from "node:util";
import type { MqttClient } from "./mqttClient.ts";
import { TestClock } from "./clock-double.ts";
import { TestMqttClient } from "./mqtt-client-double.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";

// The availability statement the lever's false-to-true edge records, in the shape `published` captures it. Declared once because every row that crosses that edge
// asserts exactly this entry, and a row spelling it out for itself could disagree with the double and still pass. The tail is bare, since the double prefixes
// nothing.
const AVAILABILITY_RECORD = { payload: MQTT_AVAILABILITY_ONLINE, retain: true, topic: MQTT_AVAILABILITY_TOPIC };

describe("TestMqttClient - publish", () => {

  test("records the payload and the topic tail verbatim, for a string and for a Buffer", async () => {

    const mqtt = new TestMqttClient();
    const snapshot = Buffer.from([ 1, 2, 3 ]);

    await mqtt.publish("device1/status", "on");
    await mqtt.publish("device1/snapshot", snapshot);

    assert.deepEqual(mqtt.published, [ { payload: "on", retain: false, topic: "device1/status" },
      { payload: snapshot, retain: false, topic: "device1/snapshot" } ]);
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

    assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: "device1/status" }]);
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

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: "device1/status" }]);
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

      assert.deepEqual(linesAt(log.entries, "error"), ["Unable to publish to the MQTT topic device1/status: broker refused the message."]);
      assert.deepEqual(linesAt(log.entries, "debug"), []);
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

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log.entries, "error"), []);
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

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log.entries, "error"), []);
    });
  });

  test("a refusal carrying an MqttOfflineError drops to the dropped line", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishRejection = new MqttOfflineError();
      mqtt.publishGuarded("device1/status", "on");

      await settle();

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish dropped while disconnected from the broker: device1/status."]);
      assert.deepEqual(linesAt(log.entries, "error"), []);
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

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log.entries, "error"), []);
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

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log.entries, "error"), []);
    });
  });

  test("a repeated failure answering the same reason is reported once and replayed at debug, and a changed reason reports in full", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      mqtt.publishRejection = new Error("broker refused the message");
      mqtt.publishGuarded("device1/status", "on");

      await settle();

      mqtt.publishGuarded("device1/status", "on");

      await settle();

      mqtt.publishRejection = new Error("broker refused the credentials");
      mqtt.publishGuarded("device1/status", "on");

      await settle();

      // The consumer's own test sees what a consumer's log would see: the fault once, its repeat at debug, and a fault that reads differently in full again.
      assert.deepEqual(linesAt(log.entries, "error"), [ "Unable to publish to the MQTT topic device1/status: broker refused the message.",
        "Unable to publish to the MQTT topic device1/status: broker refused the credentials." ]);
      assert.deepEqual(linesAt(log.entries, "debug"), ["Unable to publish to the MQTT topic device1/status: broker refused the message."]);
      assert.equal(mqtt.rejectedPublishes, 3);
    });
  });

  test("the double weighs a repeat by the same shared derivation the client does, code arm included", async () => {

    /* The double exists to answer a consumer's test the way the client answers the wire, so what counts as "the same failure" has to be one answer rather than two.
     * Both call the shared derivation, and this row drives its code arm through the double: two rejections carrying one transport code are one reason however their
     * messages differ, which a rendered-message tag would have read as two.
     */
    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      assert.equal(guardedPublishReason(errnoError("write EPIPE", "EPIPE")), "EPIPE", "the shared derivation reads the transport code");

      mqtt.publishRejection = errnoError("write EPIPE", "EPIPE");
      mqtt.publishGuarded("device1/status", "on");

      await settle();

      mqtt.publishRejection = errnoError("write EPIPE to a different topic", "EPIPE");
      mqtt.publishGuarded("device2/status", "on");

      await settle();

      assert.deepEqual(linesAt(log.entries, "error"), ["Unable to publish to the MQTT topic device1/status: write EPIPE."],
        "one transport code is one reason, so only the first rejection reaches error level");
      assert.deepEqual(linesAt(log.entries, "debug"), ["Unable to publish to the MQTT topic device2/status: write EPIPE to a different topic."],
        "the repeat under the same code is replayed at debug, naming its own topic");
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

      assert.deepEqual(mqtt.published, [ { payload: "on", retain: false, topic: TOPIC }, { payload: "off", retain: false, topic: TOPIC } ]);
      assert.equal(mqtt.rejectedPublishes, 0, "suppressing a publish is not refusing it");

      // A publish that does not ask for the gate neither reads the memory nor writes it, so it can neither arm nor disarm the gated call after it.
      await mqtt.publish(TOPIC, "on");

      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [ { payload: "on", retain: false, topic: TOPIC }, { payload: "off", retain: false, topic: TOPIC },
        { payload: "on", retain: false, topic: TOPIC } ]);
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
      assert.deepEqual(linesAt(log.entries, "error"), ["Unable to publish to the MQTT topic device1/status: broker refused the message."]);

      mqtt.publishRejection = null;
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "the refusal wrote nothing, so the retry of the same payload must record");
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

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }], "a lever write that moves nothing is not a session event");

      mqtt.connected = false;

      await mqtt.publish(TOPIC, "on", { ifChanged: true });

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "an unchanged payload is answered by the gate, ahead of the offline refusal");
      assert.equal(mqtt.rejectedPublishes, 0, "a publish the gate answered was never offered to the admissions");

      await assert.rejects(mqtt.publish(TOPIC, "off", { ifChanged: true }), MqttOfflineError);

      assert.equal(mqtt.rejectedPublishes, 1, "a changed payload with no session to carry it is refused and counted");

      mqtt.connected = true;
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      // The edge that restored the session falls between the two recordings, since it states the double's availability before the handler-free restatement after
      // it, which is the position the client's own connect puts it in.
      assert.deepEqual(mqtt.published,
        [ { payload: "on", retain: false, topic: TOPIC }, AVAILABILITY_RECORD, { payload: "on", retain: false, topic: TOPIC } ],
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

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "a torn-down double records nothing, whatever the memory holds");
    });
  });

  test("parks a change-gated call and suppresses a repeat issued while it is parked, then one issued after the release", async () => {

    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const release = mqtt.holdPublishes();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });

      await settle();

      assert.deepEqual(mqtt.published, [], "the first call parks before it is recorded");

      release();
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "the memory takes a payload as its publish is issued, so the repeat was weighed against the parked call and suppressed");

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.equal(mqtt.published.length, 1, "a call issued after the release is weighed against the same payload and suppressed");
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

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }]);
      assert.equal(mqtt.rejectedPublishes, 0);
      assert.deepEqual(log.entries, [], "nothing was attempted, so there is nothing to report at any level");
    });
  });

  test("records a change-gated return to the remembered payload issued while the publish that moved away from it is parked", async () => {

    // The return is weighed against the parked change rather than against the value before it, so the change and the return record and the double ends
    // holding the value the device returned to.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();

      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      await settle();

      const release = mqtt.holdPublishes();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      release();
      await settle();

      assert.deepEqual(mqtt.published, [ { payload: "off", retain: false, topic: TOPIC }, { payload: "on", retain: false, topic: TOPIC },
        { payload: "off", retain: false, topic: TOPIC } ], "the return to the earlier value must record after the change it follows");
    });
  });

  test("leaves the remembered payload in place when the refusal lever answers a changed one, so the unchanged payload is still suppressed", async () => {

    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      mqtt.publishRejection = new Error("broker refused the message.");
      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      await settle();

      mqtt.publishRejection = null;
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.equal(mqtt.rejectedPublishes, 1);
      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "a call the first admission refused issued nothing, so the payload remembered before it must still suppress its repeat");
    });
  });

  test("forgets a parked change-gated payload its own signal ends at release, so the same bytes offered again record", async () => {

    // The caller rewrites its buffer while the call is parked, so the forget has to go by the token its write was given rather than by the caller's buffer.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const perPublish = new AbortController();
      const reason = new HbpuAbortError("shutdown");
      const scratch = Buffer.from("on");
      const release = mqtt.holdPublishes();
      const failed = mqtt.publish(TOPIC, scratch, { ifChanged: true, signal: perPublish.signal });

      scratch.write("no");
      perPublish.abort(reason);
      release();

      await assert.rejects(failed, (error: unknown) => error === reason);

      mqtt.publishGuarded(TOPIC, Buffer.from("on"), { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: Buffer.from("on"), retain: false, topic: TOPIC }],
        "the failed call's payload was forgotten, so the same bytes offered again must record");
    });
  });

  test("forgets a parked change-gated payload the refusal lever answers at release, so the next change-gated publish of any value records", async () => {

    // Each topic held "off" before the refused call, and a forget deletes rather than restores: the failed "on" records when offered again on one topic, and the
    // earlier "off" records when offered again on the other.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();

      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      mqtt.publishGuarded(OTHER, "off", { ifChanged: true });
      await settle();

      const release = mqtt.holdPublishes();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      mqtt.publishGuarded(OTHER, "on", { ifChanged: true });
      mqtt.publishRejection = new Error("broker refused the message.");
      release();
      await settle();

      assert.equal(mqtt.rejectedPublishes, 2, "each parked call is refused at release");

      mqtt.publishRejection = null;
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      mqtt.publishGuarded(OTHER, "off", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published,
        [ { payload: "off", retain: false, topic: TOPIC }, { payload: "off", retain: false, topic: OTHER }, { payload: "on", retain: false, topic: TOPIC },
          { payload: "off", retain: false, topic: OTHER } ],
        "a refusal at release leaves nothing remembered on the topic, so the failed payload and the earlier one must each record");
    });
  });

  test("keeps a later publish's memory when an earlier parked publish of the same payload fails after it records, so its repeat is suppressed", async () => {

    // The holds nest, so the later calls record before the earlier one fails, and the failed call and the last of the later ones carry the same string, which is
    // what tells the token rule from a comparison of payloads: the topic's entry carries the later call's own token, so the failure leaves it in place.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const perPublish = new AbortController();
      const reason = new HbpuAbortError("shutdown");
      const releaseFirst = mqtt.holdPublishes();
      const failed = mqtt.publish(TOPIC, "on", { ifChanged: true, signal: perPublish.signal });
      const releaseSecond = mqtt.holdPublishes();

      mqtt.publishGuarded(TOPIC, "off", { ifChanged: true });
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      releaseSecond();
      await settle();

      assert.deepEqual(mqtt.published, [ { payload: "off", retain: false, topic: TOPIC }, { payload: "on", retain: false, topic: TOPIC } ],
        "the later calls record while the earlier call stays parked");

      perPublish.abort(reason);
      releaseFirst();

      await assert.rejects(failed, (error: unknown) => error === reason);

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.equal(mqtt.published.length, 2, "the entry carries the later call's token, so the failure left it and the repeat of the later payload is suppressed");
    });
  });

  test("records a change-gated retry issued after a parked publish's own signal ends it, as the client sends it", async () => {

    // The client forgets once its wait's rejection unwinds after the abort, so a retry issued after that has settled goes out; the double waits on its gate
    // through the same primitive, so its forget lands at the same hop and the retry issued after the settle, while the hold still stands, records at release.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const perPublish = new AbortController();
      const reason = new HbpuAbortError("shutdown");
      const release = mqtt.holdPublishes();
      const failed = assert.rejects(mqtt.publish(TOPIC, "on", { ifChanged: true, signal: perPublish.signal }), (error: unknown) => error === reason);

      perPublish.abort(reason);
      await settle();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      release();

      await failed;
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "the aborted call's payload was forgotten when its signal ended it, so the retry must record at release");
    });
  });

  test("suppresses a change-gated retry issued in the same turn as a parked publish's abort, and records one issued after a settle, as the client does", async () => {

    // The client forgets once its wait's rejection unwinds, a few microtask hops after the abort, so a retry of the same payload issued in the abort's own turn
    // is weighed against the aborted payload and suppressed, while one issued after the rejection has settled goes out. The retries differ only in their retain
    // flag, which the gate never reads, so the recording names which of them went out.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const perPublish = new AbortController();
      const reason = new HbpuAbortError("shutdown");
      const release = mqtt.holdPublishes();
      const failed = assert.rejects(mqtt.publish(TOPIC, "on", { ifChanged: true, signal: perPublish.signal }), (error: unknown) => error === reason);

      perPublish.abort(reason);
      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true, retain: true });
      await settle();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      release();

      await failed;
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "the retry in the abort's own turn must be suppressed, and the retry after the settle must record at release");
    });
  });

  test("suppresses a change-gated retry issued one await after a parked publish's abort, as the client suppresses it", async () => {

    // The client's forget lands in the catch around its wait, after the wait's rejection has unwound, so a retry issued one await after the abort is still
    // weighed against the aborted payload. The double waits on its gate through the same primitive, so its forget lands at the same hop and the retry is
    // suppressed here too.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const perPublish = new AbortController();
      const reason = new HbpuAbortError("shutdown");
      const release = mqtt.holdPublishes();
      const failed = assert.rejects(mqtt.publish(TOPIC, "on", { ifChanged: true, signal: perPublish.signal }), (error: unknown) => error === reason);

      perPublish.abort(reason);
      await Promise.resolve();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true, retain: true });
      release();

      await failed;
      await settle();

      assert.deepEqual(mqtt.published, [], "the retry one await after the abort must be weighed against the aborted payload and suppressed");
    });
  });

  test("keeps a parked change-gated payload remembered once it records, when its long-lived signal aborts afterwards", async () => {

    // A plugin's lifetime signal outlives each publish it governs. A parked publish's wait drops its listener once the gate opens, as the client's wait does once
    // it settles, so the signal aborting after the publish records forgets nothing and a repeat stays suppressed.
    await assertNoUnhandledRejections(async () => {

      const mqtt = new TestMqttClient();
      const lifetime = new AbortController();
      const release = mqtt.holdPublishes();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true, signal: lifetime.signal });
      release();
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }], "the parked call records at release");

      lifetime.abort(new HbpuAbortError("shutdown"));
      await settle();

      mqtt.publishGuarded(TOPIC, "on", { ifChanged: true });
      await settle();

      assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: TOPIC }],
        "the wait had settled when the gate opened, so the later abort forgets nothing and the repeat must be suppressed");
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

      await assert.rejects(mqtt.publish("device1/status", "on"), MqttOfflineError);

      assert.deepEqual(mqtt.published, [], "a refused publish records nothing");
      assert.equal(mqtt.rejectedPublishes, 1);

      // The client reads its session state before anything a broker could answer, so the double does too: with the lever armed while disconnected, the offline
      // refusal is what a caller sees.
      mqtt.publishRejection = new Error("broker refused the message");

      await assert.rejects(mqtt.publish("device1/status", "on"), MqttOfflineError);

      assert.equal(mqtt.rejectedPublishes, 2);

      mqtt.publishRejection = null;
      mqtt.publishGuarded("device1/status", "on");

      await settle();

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish dropped while disconnected from the broker: device1/status."]);
      assert.deepEqual(linesAt(log.entries, "error"), []);

      mqtt.connected = true;

      await mqtt.publish("device1/status", "on");

      // The lever's return to true is a session restored, so the double's own availability statement is recorded ahead of the publish this row then issues.
      assert.deepEqual(mqtt.published, [ AVAILABILITY_RECORD, { payload: "on", retain: false, topic: "device1/status" } ],
        "a session restored records again");
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

describe("TestMqttClient - connect notification", () => {

  /* The lever's false-to-true edge is the double's session restored, and it is what a scenario moves to make a consumer restate its held state. The rows here hold
   * the edge to the client's own contract: which registrations it invokes, in what order, what they read while they run, and what a faulting one does to the
   * registrations beside it. A property write cannot be awaited, so every row that asserts on an asynchronous handler's effect awaits a turn first.
   */
  test("the lever's false-to-true edge invokes every registration once, in order, with the session live and the memory already cleared", async () => {

    const mqtt = new TestMqttClient();
    const order: number[] = [];
    const readings: boolean[] = [];

    // The payload a consumer published change-gated before the outage. The memory holds it, so the handler's restatement below can only be recorded a second time
    // if the edge cleared the memory ahead of the handler.
    await mqtt.publish("device1/status", "on", { ifChanged: true });

    mqtt.onConnect(() => {

      order.push(1);
      readings.push(mqtt.connected);
      mqtt.publishGuarded("device1/status", "on", { ifChanged: true });
    });

    mqtt.onConnect(() => { order.push(2); });

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.deepEqual(order, [ 1, 2 ], "the registrations must be invoked in registration order");
    assert.deepEqual(readings, [true], "a handler must find the session reading live, so a publish it issues is admitted");
    // The edge records the double's availability before it invokes the registrations, so the statement sits between the payload published ahead of the outage and
    // the handler's restatement after it.
    assert.deepEqual(mqtt.published,
      [ { payload: "on", retain: false, topic: "device1/status" }, AVAILABILITY_RECORD, { payload: "on", retain: false, topic: "device1/status" } ],
      "the change-gated restatement must be recorded again, which it can only be if the edge cleared the memory ahead of the handler");
    assert.equal(mqtt.rejectedPublishes, 0, "a publish issued from a handler must not be refused");
  });

  test("a write that is not that edge invokes nothing", async () => {

    const mqtt = new TestMqttClient();

    let connects = 0;

    mqtt.onConnect(() => { connects++; });

    // A fresh double already holds a session, so this write leaves the lever where it stood.
    mqtt.connected = true;

    await settle();

    assert.equal(connects, 0, "re-asserting a session the double already holds is not a session event");

    mqtt.connected = false;

    await settle();

    assert.equal(connects, 0, "losing the session must invoke nothing");

    mqtt.connected = false;

    await settle();

    assert.equal(connects, 0, "re-asserting a session the double does not hold must invoke nothing");
  });

  test("registering on a double that already holds a session invokes nothing", async () => {

    const mqtt = new TestMqttClient();

    let connects = 0;

    mqtt.onConnect(() => { connects++; });

    await settle();

    assert.equal(connects, 0, "a registration joining a live session must wait for the edge that restores one");
  });

  test("a released registration, a pre-aborted signal, and an aborted double each leave the edge nothing to invoke", async () => {

    const mqtt = new TestMqttClient();
    const releasing = new AbortController();
    const preAborting = new AbortController();
    const counts = { late: 0, plain: 0, preAborted: 0, released: 0 };

    preAborting.abort(new HbpuAbortError("shutdown"));

    mqtt.onConnect(() => { counts.released++; }, { signal: releasing.signal });
    mqtt.onConnect(() => { counts.plain++; });
    mqtt.onConnect(() => { counts.preAborted++; }, { signal: preAborting.signal });

    releasing.abort(new HbpuAbortError("shutdown"));

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.deepEqual(counts, { late: 0, plain: 1, preAborted: 0, released: 0 },
      "the released and the pre-aborted registrations must be invoked by nothing, while the sibling beside them is invoked once");

    /* Aborting releases every registration the double holds, which the edge after it is what observes: the plain registration carried no signal of its own, so
     * nothing but the abort's own clear stands between it and a second invocation, and its count holding at one is that clear. A registration offered after the
     * abort is refused outright, as every other verb on this class refuses one.
     */
    mqtt.abort();
    mqtt.onConnect(() => { counts.late++; });

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.deepEqual(counts, { late: 0, plain: 1, preAborted: 0, released: 0 },
      "an aborted double must hold no registration for the edge to invoke, and must take none after the fact");
  });

  test("a throwing handler and a rejecting one each reach the sentence the client logs, and the registration between them still runs", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const mqtt = new TestMqttClient({ log });

      let recorded = 0;

      mqtt.onConnect(() => { throw new Error("connect-handler-boom"); });
      mqtt.onConnect(() => { recorded++; });
      mqtt.onConnect(async () => { throw new Error("connect-handler-rejection"); });

      mqtt.connected = false;
      mqtt.connected = true;

      await settle();

      assert.equal(recorded, 1, "the registration between the two faulting ones must still run");

      const failures = linesAt(log.entries, "error");

      assert.equal(failures.length, 2, "each faulting handler must leave exactly one failure line, observed: " + failures.join(" | "));
      assert.ok(failures.every((line) => line.startsWith("The MQTT connect handler failed: ")),
        "both failures must read as the sentence the client logs, observed: " + failures.join(" | "));
      assert.ok(failures.some((line) => line.includes("connect-handler-boom")), "the throw must carry its own message onto the line");
      assert.ok(failures.some((line) => line.includes("connect-handler-rejection")), "the rejection must carry its own message onto the line");
    });
  });

  test("a handler whose promise never settles does not hold back the one after it", async () => {

    const mqtt = new TestMqttClient();

    let recorded = 0;

    mqtt.onConnect((): Promise<void> => new Promise<void>(() => { /* This promise is deliberately left pending. */ }));
    mqtt.onConnect(() => { recorded++; });

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.equal(recorded, 1, "a registration must not wait on the one before it to settle");
  });

  test("registering the same function twice is one registration", async () => {

    const mqtt = new TestMqttClient();

    let connects = 0;

    const handler = (): void => {

      connects++;
    };

    mqtt.onConnect(handler);
    mqtt.onConnect(handler);

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.equal(connects, 1, "the same function registered twice must be invoked once per edge");
  });

  test("a handler that releases a sibling or registers another mid-pass does not destabilize the pass it is in", async () => {

    const mqtt = new TestMqttClient();
    const releasing = new AbortController();
    const counts = { first: 0, late: 0, second: 0, third: 0 };

    mqtt.onConnect(() => {

      counts.first++;
      releasing.abort(new HbpuAbortError("replaced"));
      mqtt.onConnect(() => { counts.late++; });
    });

    mqtt.onConnect(() => { counts.second++; }, { signal: releasing.signal });
    mqtt.onConnect(() => { counts.third++; });

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.deepEqual(counts, { first: 1, late: 0, second: 1, third: 1 },
      "the pass must invoke the registrations it snapshotted - the released sibling among them - and leave the one registered mid-pass for the edge after it");

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.deepEqual(counts, { first: 2, late: 1, second: 1, third: 2 },
      "the edge after it must invoke the registration the first handler made and leave the released sibling behind");
  });
});

describe("TestMqttClient - availability", () => {

  /* The double's half of the availability contract: what a fresh double has recorded, what the lever's false-to-true edge records and where among a consumer's own
   * publishes it lands, which lever writes record nothing at all, and the retention every entry carries. The double models no will, because a will is the broker's
   * to publish and there is no broker here.
   */
  test("a fresh double has published nothing, so there is no statement at construction", async () => {

    // The asymmetry with the client, asserted rather than assumed: the client's first connect is a session established and states availability, while a fresh
    // double is a session already held, with no edge to cross. A birth entry here would shift every index-based assertion a consumer's own suite holds.
    const mqtt = new TestMqttClient();

    await settle();

    assert.deepEqual(mqtt.published, [], "a fresh double must record nothing until a scenario drives the lever");
  });

  test("the lever's false-to-true edge records exactly one retained statement, ahead of what a registration publishes", async () => {

    const mqtt = new TestMqttClient();

    mqtt.onConnect(() => mqtt.publishGuarded("device1/status", "on"));

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    // The order is the row: a consumer's registration restating its devices' availability must record behind the double's own statement, which is where the
    // client's connect puts it on the wire.
    assert.deepEqual(mqtt.published, [ AVAILABILITY_RECORD, { payload: "on", retain: false, topic: "device1/status" } ],
      "the edge must record the statement once, retained, on the bare tail, ahead of anything a registration publishes");
  });

  test("a write that leaves the lever where it was, and a write to false, record nothing", async () => {

    // The edge is the session event, not the reading of it, so only a crossing records. Each write is settled on its own so a later one cannot mask an entry an
    // earlier one should never have made.
    const mqtt = new TestMqttClient();

    mqtt.connected = true;

    await settle();

    assert.deepEqual(mqtt.published, [], "a write to true on a double that already reads true is not a session event");

    mqtt.connected = false;

    await settle();

    assert.deepEqual(mqtt.published, [], "a write to false is a session lost, which states nothing");

    mqtt.connected = false;

    await settle();

    assert.deepEqual(mqtt.published, [], "a repeated write to false is not a session event either");
  });

  test("records the retention a caller asked for, and false when the caller asked for nothing", async () => {

    const mqtt = new TestMqttClient();

    mqtt.publishGuarded("t", "p", { retain: true });
    mqtt.publishGuarded("t", "q");

    await settle();

    assert.deepEqual(mqtt.published, [ { payload: "p", retain: true, topic: "t" }, { payload: "q", retain: false, topic: "t" } ],
      "the record must carry what the caller asked for, and the default must read false rather than absent");
  });
});

describe("TestMqttClient - the publish hold", () => {

  test("a held publish records only at release, behind the publish that preceded the hold", async () => {

    const mqtt = new TestMqttClient();

    await mqtt.publish("device1/status", "before");

    const release = mqtt.holdPublishes();
    const parked = mqtt.publish("device1/status", "held");

    await settle();

    assert.deepEqual(mqtt.published, [{ payload: "before", retain: false, topic: "device1/status" }], "a parked publish records nothing while it waits");

    release();
    await parked;

    assert.deepEqual(mqtt.published, [ { payload: "before", retain: false, topic: "device1/status" },
      { payload: "held", retain: false, topic: "device1/status" } ]);
    assert.equal(mqtt.rejectedPublishes, 0, "parking a publish is not refusing it");
  });

  test("a held publish rejects with the abort reason when the double aborts during the hold", async () => {

    const mqtt = new TestMqttClient();
    const release = mqtt.holdPublishes();
    const parked = mqtt.publish("device1/status", "on");

    await settle();

    // Tearing the double down onto a parked publish is the race the hold exists to force. The parked wait observes the composed signal as the client's wait on
    // its write does, so the publish rejects at the abort rather than recording into a double that is already down.
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

      assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: device1/status."]);
      assert.deepEqual(linesAt(log.entries, "error"), []);
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

    await assert.rejects(parked, MqttOfflineError);

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

    await assert.rejects(mqtt.publish("device1/status", "on"), MqttOfflineError);

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

    assert.deepEqual(mqtt.published, [{ payload: "1", retain: false, topic: "device1/first" }],
      "the first release frees the publish parked on its own gate alone");

    // The second hold is still the active one, so a publish issued after the first release parks rather than recording - the ownership guard the release makes.
    const third = mqtt.publish("device1/third", "3");

    await settle();

    assert.deepEqual(mqtt.published, [{ payload: "1", retain: false, topic: "device1/first" }],
      "the first release did not stand the second hold down");

    releaseSecond();
    await Promise.all([ second, third ]);

    assert.deepEqual(mqtt.published,
      [ { payload: "1", retain: false, topic: "device1/first" }, { payload: "2", retain: false, topic: "device1/second" },
        { payload: "3", retain: false, topic: "device1/third" } ]);
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
    assert.deepEqual(mqtt.published, [{ payload: "42", retain: false, topic: "device1/status" }]);
  });
});

describe("TestMqttClient - publishedTo", () => {

  test("answers the publishes whose topic ends with the suffix, in order, and holds back a topic it merely appears inside", async () => {

    const mqtt = new TestMqttClient();

    // The middle topic carries "status" in its body rather than at its end, so a substring or prefix match would answer three where the suffix match answers two.
    await mqtt.publish("device1/power/status", "on");
    await mqtt.publish("device1/status/detail", "verbose");
    await mqtt.publish("device2/power/status", "off");

    assert.deepEqual(mqtt.publishedTo("status"), [ { payload: "on", retain: false, topic: "device1/power/status" },
      { payload: "off", retain: false, topic: "device2/power/status" } ]);
    assert.deepEqual(mqtt.publishedTo("device1/power/status"), [{ payload: "on", retain: false, topic: "device1/power/status" }],
      "a whole topic is a suffix of itself");
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

      await using scopedClient = mqtt;

      assert.equal(mqtt.aborted, false, "the double is live inside the owning scope");
    };

    await owned();

    assert.equal(mqtt.aborted, true);
    assert.throws(() => mqtt.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" });
  });
});

// Register a word that holds the end open until the row releases it, recording the window the end hands it.
function holdEnd(mqtt: TestMqttClient): { readonly release: () => void; readonly windows: AbortSignal[] } {

  const gate: PromiseWithResolvers<void> = Promise.withResolvers();
  const windows: AbortSignal[] = [];

  mqtt.onEnd((signal) => {

    windows.push(signal);

    return gate.promise;
  });

  return { release: () => gate.resolve(), windows };
}

describe("TestMqttClient - final words", () => {

  /* The graceful end on the double, row for row with the client's own suite wherever the double can observe the row: the word recorded while the double is still
   * live, the refusals in registration order, the promise a repeat call is handed, the window an outside abort closes, a parked publish refused at the grace, and
   * the warning an abort logs when it leaves registered words unsaid. The double has no parent signal, so its abort is the one teardown that can warn here.
   *
   * The cut-short rows state the line a connect registration reaches when the end or the double's abort cuts it short, the one the client logs too, read from the shared
   * module, beside the error line it keeps otherwise. The drivers hand a handler's failure to the test, so the connect pass is the one wrapped callback the double
   * reports.
   */

  // The rendered warning for one unsaid registration, the line each warning row expects.
  const UNSAID_ONE = format(MQTT_UNSAID_WORDS_WARNING, 1);

  // The device-scope word every recording row registers, as the double records it.
  const DEVICE_WORD = { payload: "offline", retain: true, topic: "device1/availability" };

  // Register the device-scope word, publishing under the window the end hands it.
  function registerDeviceWord(mqtt: TestMqttClient, init: { signal?: AbortSignal } = {}): void {

    mqtt.onEnd((signal) => mqtt.publish(DEVICE_WORD.topic, DEVICE_WORD.payload, { retain: true, signal }), init);
  }

  test("records a registered word while the double is still live, then aborts, with no refusal", async () => {

    const mqtt = new TestMqttClient();
    const liveAtRecord: boolean[] = [];

    mqtt.onEnd(async (signal) => {

      await mqtt.publish(DEVICE_WORD.topic, DEVICE_WORD.payload, { retain: true, signal });
      liveAtRecord.push(!mqtt.aborted);
    });

    assert.deepEqual(await mqtt.end(), [], "a word stated within the grace must leave no refusal");
    assert.deepEqual(mqtt.published, [DEVICE_WORD], "the word must be recorded");
    assert.deepEqual(liveAtRecord, [true], "while the double was still live, ahead of the end's own abort");
    assert.equal(mqtt.aborted, true, "and the end must then abort the double");
  });

  test("a handler registered with an already-aborted signal is never invoked, and an aborted double registers nothing", async () => {

    const mqtt = new TestMqttClient();
    const aborted = new TestMqttClient();
    const preAborted = new AbortController();

    let invoked = 0;

    preAborted.abort(new HbpuAbortError("shutdown"));
    mqtt.onEnd(() => {

      invoked++;
    }, { signal: preAborted.signal });

    aborted.abort();
    aborted.onEnd(() => {

      invoked++;
    });

    assert.deepEqual(await mqtt.end(), []);
    assert.deepEqual(await aborted.end(), []);
    assert.equal(invoked, 0, "neither registration may be held for an end to invoke");
  });

  test("refusals return in registration order, with the offline refusal for a word issued while the lever reads disconnected", async () => {

    const mqtt = new TestMqttClient();
    const thrown = new Error("the second handler threw.");
    const rejected = new Error("the fourth handler rejected.");

    mqtt.connected = false;

    registerDeviceWord(mqtt);
    mqtt.onEnd(() => {

      throw thrown;
    });
    mqtt.onEnd(() => { /* A word with nothing left to say settles at once. */ });
    mqtt.onEnd(async () => {

      throw rejected;
    });

    const [ offline, ...rest ] = await mqtt.end();

    assert.ok(offline instanceof MqttOfflineError, "the word issued with no session must refuse with MqttOfflineError, first, where it was registered");
    assert.deepEqual(rest, [ thrown, rejected ], "and the other refusals must follow in registration order, with nothing for the word that settled");
    assert.equal(mqtt.rejectedPublishes, 1, "the refused word is counted like any other refusal");
  });

  test("a second end() returns the identical promise, while the first is running and after it has finished", async () => {

    const mqtt = new TestMqttClient();

    registerDeviceWord(mqtt);

    const first = mqtt.end();

    assert.equal(mqtt.end(), first, "a call during the end must be handed the first call's promise");
    assert.deepEqual(await first, []);
    assert.equal(mqtt.end(), first, "and so must one after it, though the double has aborted by then");
  });

  test("a handler that calls end() is handed the identical promise and runs once, and the end still completes with its own abort", async () => {

    // The handler keeps what end() hands it and returns its word alone, because a handler awaiting end() would hold the end until the grace. The end has begun
    // before the first handler runs, so the call inside the handler is a repeat call rather than a second end started inside the first.
    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });
    const inner: Promise<unknown[]>[] = [];

    mqtt.onEnd((signal) => {

      inner.push(mqtt.end());

      return mqtt.publish(DEVICE_WORD.topic, DEVICE_WORD.payload, { retain: true, signal });
    });

    const outer = mqtt.end();

    assert.deepEqual(await outer, [], "the word the handler stated must leave no refusal");
    assert.equal(inner.length, 1, "the handler must run once");
    assert.equal(inner[0], outer, "and the call it made must be handed the outer call's promise");
    assert.deepEqual(mqtt.published, [DEVICE_WORD], "the word must be recorded once");
    assert.throws(() => mqtt.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" },
      "and the end must complete with its own abort, the one that provokes the will on the client");
    assert.deepEqual(linesAt(log.entries, "warn"), [], "which leaves nothing unsaid to warn about");
  });

  test("with no end registration, end() and disposal each resolve an empty array, abort with the default reason, and warn nothing", async () => {

    const log = capturingLog();
    const ended = new TestMqttClient({ log });
    const disposed = new TestMqttClient({ log });

    assert.deepEqual(await ended.end(), [], "an end with nothing registered has nothing to refuse");

    await disposed[Symbol.asyncDispose]();

    for(const mqtt of [ ended, disposed ]) {

      assert.throws(() => mqtt.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" }, "the end must abort with the default reason");
    }

    assert.deepEqual(linesAt(log.entries, "warn"), [], "and an abort holding no registration must add no warning");
  });

  test("end() after abort() resolves an empty array and invokes nothing", async () => {

    const mqtt = new TestMqttClient();

    let invoked = 0;

    mqtt.onEnd(() => {

      invoked++;
    });

    mqtt.abort();

    assert.deepEqual(await mqtt.end(), []);
    assert.equal(invoked, 0, "the abort released every registration, so the end has nothing to state");
  });

  test("disposal states the words before the double aborts", async () => {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });

    // Scope-bound ownership is how a consumer holds the double, so the disposal worth proving is the one the scope exit fires.
    const owned = async (): Promise<void> => {

      await using scopedClient = mqtt;

      registerDeviceWord(scopedClient);
    };

    await owned();

    assert.deepEqual(mqtt.published, [DEVICE_WORD], "disposal must state the registered word");
    assert.equal(mqtt.aborted, true, "and then abort the double");
    assert.deepEqual(linesAt(log.entries, "warn"), [], "with nothing unsaid to warn about, since the abort was the end's own");
  });

  test("a word still pending when the double is aborted from outside refuses with the abort's reason, the end resolves, and the warning logs once", async () => {

    // The handler waits on a gate before it publishes, as the client's row does, so it is still pending when the abort lands.
    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const reason = new HbpuAbortError("failed");

    mqtt.onEnd(async (signal) => {

      await gate.promise;
      await mqtt.publish(DEVICE_WORD.topic, DEVICE_WORD.payload, { retain: true, signal });
    });

    const ending = mqtt.end();

    await settle();
    mqtt.abort(reason);

    assert.deepEqual(await ending, [reason], "the window closes on the outside abort, so the pending word must refuse with that abort's own reason");
    assert.deepEqual(linesAt(log.entries, "warn"), [UNSAID_ONE], "the abort was not the end's own, so it must warn once");

    gate.resolve();
    await settle();

    assert.deepEqual(mqtt.published, [], "the publish the released gate lets through must record nothing on the aborted double");
    assert.deepEqual(linesAt(log.entries, "warn"), [UNSAID_ONE], "and must add no warning");
  });

  test("abort() with a registration held warns once and states nothing", () => {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });

    let invoked = 0;

    mqtt.onEnd(() => {

      invoked++;
    });

    mqtt.abort();
    mqtt.abort();

    assert.equal(invoked, 0, "an abort states no word");
    assert.deepEqual(linesAt(log.entries, "warn"), [UNSAID_ONE], "and with a registration held it must warn once, a second abort adding nothing");
  });

  test("end() left unawaited and followed by abort() in the same turn warns once", async () => {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });

    let invoked = 0;

    mqtt.onEnd(() => {

      invoked++;
    });

    const ending = mqtt.end();

    mqtt.abort();

    assert.deepEqual(await ending, [], "the end must still resolve, and never throw");
    assert.equal(invoked, 1, "the end invoked the handler before the abort landed");
    assert.deepEqual(linesAt(log.entries, "warn"), [UNSAID_ONE], "and the abort, landing while the end was still running, must warn once");
  });

  test("end(), disposal, and a registration released by its own signal before the abort warn nothing", async () => {

    const log = capturingLog();
    const ended = new TestMqttClient({ log });
    const disposed = new TestMqttClient({ log });
    const released = new TestMqttClient({ log });
    const device = new AbortController();

    ended.onEnd(() => { /* Stated by the end. */ });
    disposed.onEnd(() => { /* Stated by the disposal. */ });
    released.onEnd(() => { /* Released by its own signal. */ }, { signal: device.signal });

    await ended.end();
    await disposed[Symbol.asyncDispose]();

    device.abort(new HbpuAbortError("shutdown"));
    released.abort();

    assert.deepEqual(linesAt(log.entries, "warn"), [], "an end's own abort, and an abort holding no registration, have nothing unsaid to warn about");
  });

  test("an invalid grace throws TypeError synchronously and leaves the double live", () => {

    const mqtt = new TestMqttClient();

    for(const grace of [ 0, -1, Number.NaN, Infinity ]) {

      assert.throws(() => mqtt.end({ grace }), { constructor: TypeError, message: "TestMqttClient: `grace` must be a positive, finite number of milliseconds." },
        "a grace of " + String(grace) + " must be refused at the call");
    }

    assert.equal(mqtt.aborted, false, "a refused grace must leave the double as it was");
  });

  test("a registration onEnd makes once end() has begun is never invoked, from outside the end and from inside a handler alike", async () => {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });

    let late = 0;

    mqtt.onEnd(() => {

      mqtt.onEnd(() => {

        late++;
      });
    });

    const ending = mqtt.end();

    mqtt.onEnd(() => {

      late++;
    });

    assert.deepEqual(await ending, []);
    assert.equal(late, 0, "the end had already settled which handlers it invokes, so neither late registration may run");
    assert.deepEqual(linesAt(log.entries, "warn"), [], "and the end's own abort clears the late registrations without a warning");
  });

  test("on a test clock, a handler that never settles refuses with the deadline's reason once the clock passes the grace, and not before", async () => {

    const clock = new TestClock();
    const mqtt = new TestMqttClient({ clock });

    let settled = false;

    mqtt.onEnd(() => new Promise<void>(() => { /* Never settles. */ }));

    const ending = mqtt.end({ grace: 500 });

    void ending.then(() => {

      settled = true;
    });

    clock.advance(499);
    await settle();

    assert.equal(settled, false, "the end must still be waiting a millisecond short of the grace");
    assert.equal(mqtt.aborted, false, "and the double must still be live");

    clock.advance(1);

    const [refusal] = await ending;

    assert.ok(isTimeoutReason(refusal), "the word unsettled at the grace must refuse with the deadline's TimeoutError");
    assert.equal(mqtt.aborted, true, "and the end must then abort the double");
  });

  test("a publish parked by holdPublishes is refused at the grace with the deadline's reason and records nothing", async () => {

    // A parked publish stands for a write the broker never acknowledges, which is where the client refuses a word at the grace, and the double refuses it the same
    // way because the publish waits on its gate under the window's signal.
    const clock = new TestClock();
    const mqtt = new TestMqttClient({ clock });
    const release = mqtt.holdPublishes();

    registerDeviceWord(mqtt);

    const ending = mqtt.end({ grace: 500 });

    clock.advance(500);

    const [refusal] = await ending;

    assert.ok(isTimeoutReason(refusal), "the parked word must refuse with the deadline's TimeoutError at the grace");
    assert.deepEqual(mqtt.published, [], "and record nothing");

    release();
    await settle();

    assert.deepEqual(mqtt.published, [], "the release after the end frees nothing, since the parked word has already been refused");
  });

  test("while the end is under way, a connect registration already running whose publish it refuses writes the client's debug cancelled line", async () => {

    // The registration runs on the lever's false-to-true edge ahead of the end and waits on the gate, so the publish it issues once the row opens the gate meets an
    // end stating its words, under no signal of the window's, while the double's own signal is still live.
    const log = capturingLog();
    const mqtt = new TestMqttClient({ clock: new TestClock(), log });
    const proceed: PromiseWithResolvers<void> = Promise.withResolvers();

    let running = false;

    mqtt.onConnect(async () => {

      running = true;

      await proceed.promise;
      await mqtt.publish("device1/state", "restated");
    });

    mqtt.connected = false;
    mqtt.connected = true;

    assert.equal(running, true, "the registration must be running ahead of the end");

    const { release } = holdEnd(mqtt);
    const ending = mqtt.end({ grace: 500 });

    proceed.resolve();
    await settle();

    assert.deepEqual(linesAt(log.entries, "debug").filter((line) => line.startsWith("The MQTT connect handler")), [MQTT_CONNECT_HANDLER_CANCELLED],
      "the registration the end cut short must write the cancelled line the client logs too, at debug");
    assert.deepEqual(linesAt(log.entries, "error"), [], "and never the error line");

    release();

    assert.deepEqual(await ending, []);
  });

  test("outside the end and before any abort, a connect registration failing with HbpuAbortError timeout writes the error line naming timeout", async () => {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });

    mqtt.onConnect(async () => {

      throw new HbpuAbortError("timeout");
    });

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.deepEqual(linesAt(log.entries, "error"), ["The MQTT connect handler failed: timeout."], "a timeout of the registration's own must reach the error line");
    assert.deepEqual(linesAt(log.entries, "debug").filter((line) => line.startsWith("The MQTT connect handler")), [], "and must not read as cancelled");
  });

  test("once the double has aborted, a running connect registration failing with a plain Error writes the debug cancelled line, not its error line", async () => {

    // The registration runs on the lever's false-to-true edge and waits on the gate, so the error it throws once the row opens the gate is no HbpuAbortError and
    // lands after the double's own signal has aborted, with its end never begun. The double has no parent signal, so its own abort is the one way to reach this.
    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });
    const proceed: PromiseWithResolvers<void> = Promise.withResolvers();

    let running = false;

    mqtt.onConnect(async () => {

      running = true;

      await proceed.promise;

      throw new Error("the device went away.");
    });

    mqtt.connected = false;
    mqtt.connected = true;

    assert.equal(running, true, "the registration must be running ahead of the abort");

    mqtt.abort();
    proceed.resolve();
    await settle();

    assert.deepEqual(linesAt(log.entries, "debug").filter((line) => line.startsWith("The MQTT connect handler")), [MQTT_CONNECT_HANDLER_CANCELLED],
      "the registration the abort cut short must write the cancelled line the client logs too, at debug");
    assert.deepEqual(linesAt(log.entries, "error"), [], "and never the error line, whatever it failed with");
  });

  test("the double and the module it shares with the client load neither mqtt nor the client at runtime, so the testing entry point stays broker-free", async () => {

    /* A child process imports the testing entry point under a resolve hook that records every URL the process resolves, so an edge reached through another module and
     * a dynamic import that runs while the entry point loads are seen as readily as a direct one, and a type-only import, which type stripping erases, is never
     * resolved at all. The child then imports the client, which is the control: the same hook must see it load mqtt. A child is the arrangement because this suite's
     * own process has already loaded the testing entry point, so a hook registered inside this row would see none of its resolutions, and a run sharing one process
     * across files would have loaded the client as well. The child's deadline turns one that never exits into a failed row rather than a hung suite.
     */
    const CHILD_EXIT_BOUND_MS = 10000;
    const source = [

      "import { registerHooks } from 'node:module';",
      "const resolved = [];",
      "registerHooks({ resolve: (specifier, context, nextResolve) => {",
      "  const result = nextResolve(specifier, context);",
      "  resolved.push(result.url);",
      "  return result;",
      "} });",
      "await import(" + JSON.stringify(new URL("./testing/index.ts", import.meta.url).href) + ");",
      "const entry = [...resolved];",
      "await import(" + JSON.stringify(new URL("./mqttClient.ts", import.meta.url).href) + ");",
      "process.stdout.write(JSON.stringify({ client: resolved.slice(entry.length), entry }));"
    ].join("\n");

    const { stdout } = await promisify(execFile)(process.execPath, [ "--input-type=module", "--eval", source ], { timeout: CHILD_EXIT_BOUND_MS });
    const { client, entry } = JSON.parse(stdout) as { client: string[]; entry: string[] };
    const loads = (urls: string[], fragment: string): boolean => urls.some((url) => url.includes(fragment));

    assert.equal(loads(entry, "/node_modules/mqtt/"), false, "the testing entry point must not load mqtt at runtime");
    assert.equal(loads(entry, "/src/mqttClient.ts"), false, "nor the client");
    assert.ok(loads(entry, "/src/mqtt-client-double.ts") && loads(entry, "/src/mqtt-publish.ts"),
      "while the hook must be seen to record the entry point loading the double and the module it shares with the client");
    assert.ok(loads(client, "/node_modules/mqtt/"), "and the control: importing the client must be seen to load mqtt");
  });
});

describe("TestMqttClient - the end's quiet", () => {

  /* What the end keeps quiet while it states the words, row for row with the client's own suite: a word under the window recorded, every other publish refused
   * with nothing recorded or counted, the drivers answering without running a handler, a session restored running no registration, and a publish parked before
   * the end recording at release. Each row holds the end open on a word it settles itself, with the grace on a TestClock no row advances.
   */

  // The refusal every publish the end does not admit rejects with.
  const SHUTDOWN = { constructor: HbpuAbortError, name: "shutdown" };

  test("while the end states its words, a publish under the window it handed is recorded, issued at once or later, and passed through composeSignals", async () => {

    // The first word is issued as the handler is invoked, before it awaits anything, so it meets an end that has already recorded its window. The second is
    // issued once the row lets the handler go on, under the window passed through composeSignals with nothing beside it, which hands the window itself back.
    const mqtt = new TestMqttClient({ clock: new TestClock() });
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();

    mqtt.onEnd(async (signal) => {

      const first = mqtt.publish("device1/first", "said", { retain: true, signal });

      await gate.promise;
      await first;
      await mqtt.publish("device1/second", "said", { retain: true, signal: composeSignals(signal, undefined) });
    });

    const ending = mqtt.end({ grace: 500 });

    gate.resolve();

    assert.deepEqual(await ending, [], "every word was admitted, so none leaves a refusal");
    assert.deepEqual(mqtt.published, [ { payload: "said", retain: true, topic: "device1/first" }, { payload: "said", retain: true, topic: "device1/second" } ],
      "each word must be recorded");
    assert.throws(() => mqtt.signal.throwIfAborted(), SHUTDOWN, "and the end must still complete with its own abort");
  });

  test("while the end states its words, a publish under no signal or another is refused with shutdown, records nothing, leaving only the aborted line", async () => {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ clock: new TestClock(), log });
    const { release, windows } = holdEnd(mqtt);
    const ending = mqtt.end({ grace: 500 });
    const window = expectAt(windows, 0, "the window the end handed its word");

    // The refusal lever is armed as well, so a publish that got past the end's admission to the double's own would answer with the lever's error and be counted.
    mqtt.publishRejection = new Error("broker refused the message");

    await assert.rejects(mqtt.publish("device1/status", "on"), SHUTDOWN, "a publish carrying no signal must be refused");
    await assert.rejects(mqtt.publish("device1/status", "on", { signal: new AbortController().signal }), SHUTDOWN, "and so must one carrying an unrelated signal");
    await assert.rejects(mqtt.publish("device1/status", "on", { signal: composeSignals(window, new AbortController().signal) }), SHUTDOWN,
      "and one carrying a signal composed from the window and another, which is a fresh signal rather than the window");

    mqtt.publishGuarded("device1/status", "on");
    await settle();

    assert.deepEqual(mqtt.published, [], "no refused publish may be recorded");
    assert.equal(mqtt.rejectedPublishes, 0, "and none may be counted, since the end's refusal is no broker's answer");
    assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: device1/status."], "the guarded form must write the aborted line and nothing else");
    assert.deepEqual([ ...linesAt(log.entries, "warn"), ...linesAt(log.entries, "error") ], [], "and a refusal is no fault, so nothing reaches warn or error");

    mqtt.publishRejection = null;
    release();

    assert.deepEqual(await ending, []);
  });

  test("while the end states its words, an aborted publish signal or double answers with its own reason, and a change-gated repeat is refused", async () => {

    const mqtt = new TestMqttClient({ clock: new TestClock() });

    holdEnd(mqtt);

    await mqtt.publish("device1/status", "on", { ifChanged: true });

    const ending = mqtt.end({ grace: 500 });
    const own = new AbortController();
    const ownReason = new HbpuAbortError("closed");

    own.abort(ownReason);

    await assert.rejects(mqtt.publish("device1/status", "on", { signal: own.signal }), (error: unknown) => error === ownReason,
      "an aborted publish signal must answer with its own reason, ahead of the end's admission");
    await assert.rejects(mqtt.publish("device1/status", "on", { ifChanged: true }), SHUTDOWN,
      "a change-gated repeat outside the window must be refused, never resolved on the strength of the publish ahead of the end");

    const outside = new HbpuAbortError("failed");

    mqtt.abort(outside);

    await assert.rejects(mqtt.publish("device1/status", "on"), (error: unknown) => error === outside,
      "and an aborted double must answer with its abort's reason rather than the end's");
    assert.deepEqual(await ending, [outside], "the held word refuses with the outside abort's reason");
    assert.equal(mqtt.published.length, 1, "and only the publish ahead of the end was recorded");
  });

  test("while the end states its words, deliver, invokeGet and invokeSet run no handler, getter or setter, publish no get response, and throw no miss", async () => {

    const mqtt = new TestMqttClient({ clock: new TestClock() });
    const invoked: string[] = [];
    const { release } = holdEnd(mqtt);

    mqtt.subscribe("device1/status", () => {

      invoked.push("raw");
    });
    mqtt.subscribeGet("device1/power", "Power", () => {

      invoked.push("get");

      return "on";
    });
    mqtt.subscribeSet("device1/power", "Power", () => {

      invoked.push("set");
    });

    const ending = mqtt.end({ grace: 500 });

    await mqtt.deliver("device1/status", "during");

    assert.equal(await mqtt.invokeGet("device1/power/get"), undefined, "the get driver must answer without running the getter");

    await mqtt.invokeSet("device1/power/set", "ON");

    // A suffix nothing is registered on throws its miss on a live double, so answering quietly here is the driver returning ahead of any lookup.
    assert.equal(await mqtt.invokeGet("device9/missing/get"), undefined, "an unmatched get suffix must answer quietly");

    await mqtt.invokeSet("device9/missing/set", "ON");

    assert.deepEqual(invoked, [], "no driver may reach a handler, a getter or a setter while the end states its words");
    assert.deepEqual(mqtt.published, [], "and no get response may be recorded");
    assert.equal(mqtt.subscriptions.length, 3, "though every registration is still held, so the quiet is the end's and not a release");

    release();

    assert.deepEqual(await ending, []);
  });

  test("a session restored while the end states its words records nothing, writes the aborted line for the availability tail, and runs no registration", async () => {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ clock: new TestClock(), log });

    let connects = 0;

    mqtt.onConnect(() => {

      connects++;
    });

    mqtt.connected = false;

    const { release } = holdEnd(mqtt);
    const ending = mqtt.end({ grace: 500 });

    mqtt.connected = true;
    await settle();

    assert.equal(connects, 0, "the restored edge must run no connect registration while the end states its words");
    assert.deepEqual(mqtt.published, [], "and must record no availability statement");
    assert.deepEqual(linesAt(log.entries, "debug"), ["MQTT publish aborted: availability."], "since the end refuses it onto the aborted line");

    release();

    assert.deepEqual(await ending, []);
  });

  test("a publish parked by holdPublishes before the end began records at release while the end states its words", async () => {

    // The end's admission answers when a publish is issued, as the client's does for a write it has already handed to mqtt.js, so a publish parked ahead of the
    // end faces only the signal, session and lever admissions at release.
    const mqtt = new TestMqttClient({ clock: new TestClock() });
    const releasePublishes = mqtt.holdPublishes();
    const parked = mqtt.publish("device1/status", "on");
    const { release } = holdEnd(mqtt);
    const ending = mqtt.end({ grace: 500 });

    releasePublishes();
    await parked;

    assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: "device1/status" }], "the parked publish must record at release");

    release();

    assert.deepEqual(await ending, []);
  });
});

/* Compile-time parity of the graceful end's verbs with the client's. These never run - the function is never called, and its leading underscore marks it, with its
 * bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals; TypeScript still type-checks the body during
 * `npm run typecheck`, so a double whose onEnd or end drifts from the client's signature fails the build here rather than at a consumer's injection site.
 */
const _endParityExercises = (): void => {

  type _OnEndMatchesClient = Assert<Equal<TestMqttClient["onEnd"], MqttClient["onEnd"]>>;
  type _EndMatchesClient = Assert<Equal<TestMqttClient["end"], MqttClient["end"]>>;
};

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
    assert.deepEqual(mqtt.published, [{ payload: "on", retain: false, topic: "device1/power" }]);
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

    // The example in the class documentation is shipped guidance, so it is kept executable here...a plugin registers its setter on the parent topic and the test
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

      assert.deepEqual(linesAt(log.entries, "error"), ["Unable to publish to the MQTT topic relay/{output}/state: TestMqttClient: the topic " +
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

    await assert.rejects(mqtt.publish(UNRESOLVED, "on"), { constructor: HbpuAbortError, name: "shutdown" });
    assert.doesNotThrow(() => mqtt.subscribe(UNRESOLVED, () => { /* Never reached. */ }), "subscribe on an aborted double stays a no-op");
    assert.doesNotThrow(() => mqtt.unsubscribe("device1", UNRESOLVED), "unsubscribe on an aborted double stays a no-op");

    const live = new TestMqttClient();

    assert.doesNotThrow(() => live.unsubscribe("", UNRESOLVED), "an empty id short-circuits ahead of the refusal");

    assert.deepEqual(live.unsubscribes, []);
    assert.deepEqual(mqtt.published, []);
  });
});
