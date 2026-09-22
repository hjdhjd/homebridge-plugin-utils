/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqttClient.test.ts: Unit tests for the AsyncDisposable MqttClient - composed connection lifetime, signal-driven publish / subscribe semantics, the offline publish
 * posture and the connection state behind it, the guarded fire-and-forget publish, the change-gated publish option and the session-bound memory behind it,
 * subscribeSet handler-timeout, transport-error routing, and AsyncDisposable wiring. Tests run against a real in-process aedes broker on an ephemeral localhost
 * port (the same architectural pattern the rest of HBPU uses for tests of subsystems that wrap external substrates - real spawn for FfmpegProcess, real UDP for
 * RtpDemuxer, real DOM for the webUI).
 * Transport-level errno paths (ECONNREFUSED, ECONNRESET, ENOTFOUND) exercise real network failures; the error-routing switch is covered by direct invocation of the
 * pure {@link routeMqttBrokerError} helper, mirroring how `parseFfmpegCodecs` is tested directly with fixture strings while the spawn-end-to-end path is covered by
 * the FFmpeg integration suite that auto-enables when an FFmpeg binary is on PATH.
 */
import type { Assert, CapturingLog, Equal } from "./testing/index.ts";
import type { FeatureCategoryEntry, FeatureOptionEntry } from "./featureOptions.ts";
import { HbpuAbortError, isHbpuAbortReason } from "./util.ts";
import { MQTT_AVAILABILITY_OFFLINE, MQTT_AVAILABILITY_ONLINE, MQTT_AVAILABILITY_TOPIC } from "./mqtt-topics.ts";
import { MqttClient, brokerErrorReason, createMqttClient, logGetterPublishOutcome, mqttConnectionSettings, mqttFeatureOptions, redactBrokerUrl,
  redactKnownBrokerUrl, routeMqttBrokerError } from "./mqttClient.ts";
import { assertNoUnhandledRejections, capturingLog, errnoError, formatLogEntry, listenOnLoopback, logCount, loggedAt, silentLog, stopListening,
  waitUntil } from "./testing/index.ts";
import { awaitClientConnected, awaitConnect, firstRendered, logContains, recordClientPublishes, recordRetainedStoreCompletions, recordSubscribes,
  recordWireUnsubscribes, startTestBroker, waitForLog } from "./mqtt.helpers.ts";
import { describe, test } from "node:test";
import { FeatureOptions } from "./featureOptions.ts";
import { MqttOfflineError } from "./mqtt-publish.ts";
import assert from "node:assert/strict";
import { connect } from "mqtt";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

// Per-test event-loop settling window. After awaiting a deterministic broker event, this short delay lets any speculative-but-erroneous additional packet (the kind
// the de-dup tests assert is NOT issued) reach the broker before the assertion runs. 20ms is conservative against sub-millisecond localhost RTT - if a second
// subscribe / publish were on the wire it would arrive well within this window.
const SETTLE_MS = 20;

// Standard unreachable-broker URL for the construction tests that assert behavior on a non-listener: mqtt.js attempts to connect, the kernel returns ECONNREFUSED, and
// (because `reconnectInterval: 0`) does not retry. The client stays constructed, the connection stays down, and every test flow that does not require a live broker
// runs deterministically without standing one up.
const UNREACHABLE_BROKER = "mqtt://127.0.0.1:1";

// The two plugin availability statements, in the shape the broker's recorder captures them: the one every session opens with, and the one the broker's last will
// produces once the session ends without a DISCONNECT. Declared once because every row that accounts for a statement asserts exactly this entry, and a row spelling
// it for itself could disagree with the client and still pass. The `"test/"` prefix is `makeClient`'s own, and is the only literal either one carries.
const AVAILABILITY_ONLINE_RECORD = { payload: MQTT_AVAILABILITY_ONLINE, retain: true, topic: "test/" + MQTT_AVAILABILITY_TOPIC };
const AVAILABILITY_OFFLINE_RECORD = { payload: MQTT_AVAILABILITY_OFFLINE, retain: true, topic: "test/" + MQTT_AVAILABILITY_TOPIC };

// Construct a test client. The default broker URL is the unreachable test address so tests that do not need broker interaction do not pay broker-startup cost; tests
// that exercise the wire pass `brokerUrl: broker.url` from a per-test {@link startTestBroker} handle.
interface ClientOverrides {

  brokerUrl?: string;
  log?: CapturingLog;
  reconnectInterval?: number;
  signal?: AbortSignal;
}

function makeClient(overrides: ClientOverrides = {}): MqttClient {

  return new MqttClient({

    brokerUrl: overrides.brokerUrl ?? UNREACHABLE_BROKER,
    log: overrides.log ?? silentLog(),
    reconnectInterval: overrides.reconnectInterval ?? 0,
    topicPrefix: "test"
  }, {

    signal: overrides.signal
  });
}

// Start a tiny TCP server on an ephemeral localhost port that forcibly resets every incoming connection. Used to drive `ECONNRESET` through real network behavior:
// a connecting mqtt.js client completes the TCP handshake and immediately sees the socket reset, surfacing as the same `code: "ECONNRESET"` error event mqtt.js
// would emit in any environment where a broker accepts then drops connections (firewalls, load balancers, restarted brokers). `socket.resetAndDestroy()` sends a
// real TCP RST; bare `destroy()` would send a normal FIN, which mqtt.js sees as a clean close without the errno code that HBPU's transport-error handler routes.
//
// Returns an `AsyncDisposable` so callers use the canonical `await using reset = await startResetServer()` idiom that mirrors {@link startTestBroker}.
async function startResetServer(): Promise<{ url: string } & AsyncDisposable> {

  const server = createServer((socket) => socket.resetAndDestroy());

  const port = await listenOnLoopback(server);

  return {

    url: "mqtt://127.0.0.1:" + port.toString(),
    [Symbol.asyncDispose]: async (): Promise<void> => stopListening(server)
  };
}

// An MqttClient whose `publish` always rejects, which reaches `publishGuarded`'s delivery-failure branch deterministically. A real broker cannot be talked into
// failing a publish after the fact: HBPU publishes at QoS 0, where mqtt.js answers the publish callback on socket-write completion, so every broker-side rejection
// lands after the callback has already reported success. Substituting the delegation target is the honest way to drive the branch, and everything `publishGuarded`
// itself owns still runs for real - the topic expansion, the cancellation-versus-failure decision, and the log routing.
class FailingPublishClient extends MqttClient {

  public override async publish(): Promise<void> {

    throw new Error("broker refused the message.");
  }
}

describe("MqttClient - construction", () => {

  test("is not aborted on construction", async () => {

    await using client = makeClient();

    assert.equal(client.aborted, false);
    assert.equal(client.signal.aborted, false);
  });

  test("composes a parent signal into this.signal", async () => {

    const parent = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    await using client = makeClient({ signal: parent.signal });

    assert.equal(client.aborted, false);

    parent.abort(reason);

    assert.equal(client.aborted, true);
    assert.equal(client.signal.reason, reason);
  });

  test("pre-aborted parent signal tears the client down inline and rejects publishes with the parent's reason", async () => {

    const parent = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    parent.abort(reason);

    await using client = makeClient({ signal: parent.signal });

    assert.equal(client.aborted, true);
    assert.equal(client.signal.reason, reason);

    // The constructor still invokes mqtt.js's `connect()` so `#mqtt` is guaranteed non-null; the pre-aborted signal triggers `#teardown()` inline immediately
    // afterwards, which calls `mqtt.end(true)` and drops the in-flight connection attempt before any network work completes. Subsequent publishes reject with the
    // parent's reason - no broker round trip to race against.
    await assert.rejects(client.publish("topic", "msg"), (error: unknown) => error === reason);
  });

  test("invalid broker URL throws synchronously from the constructor with the underlying error as cause", () => {

    // The architectural contract: construction fails loudly for misconfiguration rather than silently producing a zombie client. Consumers wrap in try/catch if they
    // want graceful degradation. Telling the failure apart from any other is by `instanceof Error` + `cause` presence - never by the wrapper's message text - so the
    // assertion remains stable across message-wording changes, and the `cause` itself is the mqtt.js error the caller cares about for forensics.
    assert.throws(

      () => new MqttClient({ brokerUrl: "not-a-valid-url", log: silentLog(), topicPrefix: "test" }),
      (error: unknown) => (error instanceof Error) && (error.cause instanceof Error)
    );
  });
});

describe("MqttClient - abort and teardown", () => {

  test("abort defaults to HbpuAbortError(\"shutdown\")", async () => {

    const client = makeClient();

    client.abort();

    assert.equal(client.aborted, true);
    assert.equal(isHbpuAbortReason(client.signal.reason, "shutdown"), true);
  });

  test("abort propagates an explicit reason", async () => {

    const client = makeClient();
    const reason = new HbpuAbortError("replaced");

    client.abort(reason);

    assert.equal(client.signal.reason, reason);
  });

  test("abort is safe to call more than once", async () => {

    const client = makeClient();
    const first = new HbpuAbortError("shutdown");

    client.abort(first);
    client.abort(new HbpuAbortError("failed"));

    assert.equal(client.signal.reason, first);
  });

  test("[Symbol.asyncDispose] aborts the client", async () => {

    const client = makeClient();

    await client[Symbol.asyncDispose]();

    assert.equal(client.aborted, true);
  });

  test("publish after abort rejects with signal.reason", async () => {

    const client = makeClient();
    const reason = new HbpuAbortError("shutdown");

    client.abort(reason);

    await assert.rejects(client.publish("topic", "msg"), (error: unknown) => error === reason);
  });
});

describe("MqttClient - publish signal composition", () => {

  test("pre-aborted per-publish signal rejects without touching the broker", async () => {

    await using client = makeClient();

    const perPublish = new AbortController();
    const reason = new HbpuAbortError("replaced");

    perPublish.abort(reason);

    await assert.rejects(client.publish("topic", "msg", { signal: perPublish.signal }), (error: unknown) => error === reason);
  });

  /* This describe covers composition only, and deliberately holds no in-flight row. A publish with no broker session is refused before it ever reaches the wait, so
   * there is no parked publish on a disconnected client for a signal to interrupt. The during-wait mechanism itself - a signal aborting mid-wait and rejecting the
   * pending promise with its reason - is proven in the `waitWithSignal` suite, and the abort-first ordering is proven in the abort-and-teardown rows above. The one
   * in-flight window a connected client does have is the socket write's drain wait inside mqtt.js, which a unit test cannot construct deterministically.
   */
});

describe("MqttClient - publishGuarded", () => {

  test("a successful publish reaches the broker and says nothing at warn or error level", async () => {

    // The quiet path. `publishGuarded` delegates to `publish`, so the payload arrives on the expanded topic exactly as a direct publish would, and a successful
    // fire-and-forget publish is not an event worth a log line above debug.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = makeClient({ brokerUrl: broker.url, log });

      const publishes = recordClientPublishes(broker);

      // The wait is on the client's own reading rather than the broker's event: aedes fires `clientReady` while it is still handling the CONNECT, before the
      // client has parsed the CONNACK back off the socket, and a publish issued in that gap has no session to go out on.
      await awaitClientConnected(client);

      client.publishGuarded("device1/status", "on");

      // Every session opens with the plugin's own availability statement, so the wait names the entry this row is about rather than whichever one the broker sees
      // first, and the expected array carries both in the order they reached the broker.
      await waitUntil(() => publishes.entries.some((entry) => entry.topic === "test/device1/status"),
        { description: "the broker to record the guarded publish", timeoutMs: 5000 });

      assert.deepEqual(publishes.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: "test/device1/status" } ]);
      assert.deepEqual(log.entries.filter((entry) => [ "error", "warn" ].includes(entry.level)), [], "a successful publish must be quiet above debug level");
    });
  });

  test("a delivery failure is reported at error level, naming the expanded topic and the underlying reason", async () => {

    // The reporting contract: the caller has no promise to observe, so the log line is the entire failure surface and it has to carry both facts a reader needs -
    // which topic failed, in its broker-facing form, and why.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = new FailingPublishClient({ brokerUrl: broker.url, log, reconnectInterval: 0, topicPrefix: "test" });

      client.publishGuarded("device1/status", "on");

      /* The substituted publish rejects for every caller, the client's own availability statement included, so the connect produces a second error line of its own.
       * The wait counts the lines rather than answering on the first, because this row's publish rejects in a microtask of the same turn as construction while the
       * availability statement waits on a real CONNACK round trip, which is the order the two lines land in.
       */
      await waitUntil(() => (log.entries.filter((entry) => entry.level === "error").length >= 2),
        { description: "both guarded publish failures to be reported", timeoutMs: 5000 });

      const failures = log.entries.filter((entry) => entry.level === "error").map((entry) => formatLogEntry(entry));

      assert.deepEqual(failures, [ "Unable to publish to the MQTT topic test/device1/status: broker refused the message.",
        "Unable to publish to the MQTT topic " + AVAILABILITY_ONLINE_RECORD.topic + ": broker refused the message." ]);
    });
  });

  test("a per-publish abort is reported at debug level only and leaves the client usable", async () => {

    // Cancellation is not a delivery fault. The publish is issued before the CONNACK round trip completes, so it is refused for want of a session before the
    // per-publish signal even fires - and the signal reading is what classifies the attempt as cancelled whatever the rejection turns out to be. The controller is
    // aborted with no reason at all, the platform's own `AbortError` shape rather than HBPU's, proving the classification covers a consumer that wires a bare
    // `AbortController` into a publish.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = makeClient({ brokerUrl: broker.url, log });

      const perPublish = new AbortController();

      client.publishGuarded("device1/status", "on", { signal: perPublish.signal });
      perPublish.abort();

      await waitForLog(log, (entry) => (entry.level === "debug") && logContains("MQTT publish aborted: test/device1/status")(entry));

      assert.deepEqual(log.entries.filter((entry) => entry.level === "error"), [], "an aborted publish must not be reported as a delivery failure");

      // Only this publish was cancelled; the connection is untouched and still available to the next caller.
      assert.equal(client.aborted, false);
    });
  });

  test("a per-publish abort whose reason is a plain string is reported at debug level only", async () => {

    // `AbortController.abort` accepts any value as a reason, and a bare string is a common choice. This publish is refused for want of a session before CONNACK, so
    // the rejection is the offline error rather than the caller's string, and neither shape says anything about the caller's intent. Reading the per-publish signal
    // is what keeps the cancellation quiet, and the client is left usable for the next caller.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = makeClient({ brokerUrl: broker.url, log });

      const perPublish = new AbortController();

      client.publishGuarded("device1/status", "on", { signal: perPublish.signal });
      perPublish.abort("device disposed");

      await waitForLog(log, (entry) => (entry.level === "debug") && logContains("MQTT publish aborted: test/device1/status")(entry));

      assert.deepEqual(log.entries.filter((entry) => entry.level === "error"), [], "a string abort reason must not be reported as a delivery failure");
      assert.equal(client.aborted, false);
    });
  });

  test("a per-publish abort whose reason is a custom error is reported at debug level only", async () => {

    // The other end of the same freedom: a caller that aborts with its own `Error`. This publish is refused for want of a session before CONNACK, so neither HBPU's
    // own abort type nor the platform's "AbortError" name appears in the rejection and nothing about its shape says cancellation. The signal read is what tells the
    // two apart.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = makeClient({ brokerUrl: broker.url, log });

      const perPublish = new AbortController();

      client.publishGuarded("device1/status", "on", { signal: perPublish.signal });
      perPublish.abort(new Error("going away"));

      await waitForLog(log, (entry) => (entry.level === "debug") && logContains("MQTT publish aborted: test/device1/status")(entry));

      assert.deepEqual(log.entries.filter((entry) => entry.level === "error"), [], "a custom error abort reason must not be reported as a delivery failure");
    });
  });

  test("a publish issued against a torn-down client is reported at debug level only", async () => {

    // The teardown shape: `publish` short-circuits on the already-aborted connection signal and rejects with the client's own `HbpuAbortError`. A plugin shutting
    // down publishes its last state as it goes, and those publishes losing the race with teardown is the ordinary way a shutdown ends - not something to report as a
    // string of failures on the way out.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();
      const client = makeClient({ brokerUrl: broker.url, log });

      client.abort(new HbpuAbortError("shutdown"));
      client.publishGuarded("device1/status", "on");

      await waitForLog(log, (entry) => (entry.level === "debug") && logContains("MQTT publish aborted: test/device1/status")(entry));

      assert.deepEqual(log.entries.filter((entry) => entry.level === "error"), [], "a publish cancelled by teardown must not be reported as a delivery failure");
    });
  });

  test("a publish that keeps failing for the same reason reports once at error and replays at debug, and a session clears the memory", async () => {

    // The substituted publish rejects identically for every caller, so this row drives the whole demotion: the first failure at error, the availability statement's
    // own failure at error because the session that just opened cleared the memory, and the explicit repeat after it at debug.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = new FailingPublishClient({ brokerUrl: broker.url, log, reconnectInterval: 0, topicPrefix: "test" });

      client.publishGuarded("device1/status", "on");

      await waitUntil(() => (log.entries.filter((entry) => entry.level === "error").length >= 2),
        { description: "both guarded publish failures to be reported", timeoutMs: 5000 });

      client.publishGuarded("device1/status", "on");

      await waitUntil(() => loggedAt(log.entries, "debug", "Unable to publish to the MQTT topic test/device1/status"),
        { description: "the repeated failure to be replayed at debug", timeoutMs: 5000 });

      assert.equal(logCount(log.entries, "error", "Unable to publish to the MQTT topic test/device1/status"), 1,
        "the repeat of an unchanged reason must not reach error level a second time");
    });
  });
});

describe("MqttClient - offline publish posture", () => {

  // Race a publish's settlement against a short budget, answering the rejection itself when the publish settled and a naming string when it did not. A publish this
  // posture refuses rejects in the same synchronous chain that issued it, so the budget is only ever spent by a regression: a pre-check that went missing leaves the
  // publish parked inside mqtt.js's offline queue for the length of the outage, and this race turns that hang into a named failure inside 100 ms.
  async function settleOrPending(promise: Promise<void>): Promise<unknown> {

    return Promise.race([ promise.then(() => "resolved", (error: unknown) => error), delay(100).then(() => "pending") ]);
  }

  test("a publish issued while the broker is unreachable rejects at once with MqttOfflineError, at a zero and at a positive reconnect interval", async () => {

    // The refusal does not depend on what mqtt.js is doing underneath it. With reconnection disabled the client will never come back on its own; with it armed the
    // client is between attempts. Neither state is a session, so both refuse. Each sub-case runs in its own scope with its own capturing log, so the client is
    // disposed and the lines are read fresh before the next interval is tried.
    async function refusesAt(reconnectInterval: number): Promise<void> {

      const log = capturingLog();

      await using client = makeClient({ log, reconnectInterval });

      await waitForLog(log, logContains("Connection refused"));

      const outcome = await settleOrPending(client.publish("device1/status", "on"));

      assert.ok((outcome instanceof MqttOfflineError) && (outcome.message === "The MQTT client is not connected to the broker."),
        "the publish must reject at once with the offline error and its exact sentence, observed: " + String(outcome));
      assert.equal(client.connected, false);
    }

    await refusesAt(0);
    await refusesAt(1);
  });

  test("a publish issued before the first CONNACK is refused, and the same client delivers after it", async () => {

    // The refusal window opens at construction: there is no session until the broker's CONNACK has been parsed, and a publish in that window is refused exactly as one
    // issued mid-outage is. The second half is the rest of the contract - the same client, on the same topic, delivering normally once the session exists - which is
    // what proves the pre-check gates on the session rather than latching the client off. The recorder is installed before the client so nothing on the wire is missed.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url, reconnectInterval: 1 });

    assert.equal(client.connected, false, "a client reports no session until its CONNACK has been parsed");

    const early = await settleOrPending(client.publish("device1/status", "early"));

    assert.ok(early instanceof MqttOfflineError, "a publish issued before the first CONNACK must be refused, observed: " + String(early));

    await awaitClientConnected(client);
    await client.publish("device1/status", "on");

    // The session that admitted the publish opened with the plugin's availability statement, so the wait names this row's own entry and the expected array opens
    // with the statement that preceded it.
    await waitUntil(() => publishes.entries.some((entry) => entry.topic === "test/device1/status"),
      { description: "the broker to record the delivered publish", timeoutMs: 5000 });

    assert.deepEqual(publishes.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: "test/device1/status" } ],
      "the refused payload must never have reached the broker");
  });

  test("connected reads false the instant the client aborts, ahead of mqtt.js's own close event", async () => {

    // mqtt.js clears its own flag from the socket's close handler, which runs a turn or two after `end(true)` has requested the teardown. Composing the lifetime signal
    // into the getter is what closes that window, so there is no instant at which a caller reads `aborted` true and `connected` true at the same time. The reads below
    // sit on the statement after the abort with nothing awaited in between, which is the only place the window would be observable.
    await using broker = await startTestBroker();
    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);

    client.abort();

    assert.equal(client.connected, false);
    assert.equal(client.aborted, true);
  });

  test("publishGuarded drops a publish while disconnected to one debug line after its trace, and stays silent about it at error", async () => {

    // The guarded path has no caller to answer, so its one line is the whole of what a reader gets - and the outage behind it is already on the error line the broker
    // error handler emits, which is why the drop itself belongs at debug. Asserting the trace's position ahead of the drop is what keeps the pre-check behind the one
    // line every publish call leaves whatever becomes of it.
    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();

      await using client = makeClient({ log, reconnectInterval: 1 });

      await waitForLog(log, logContains("Connection refused"));

      client.publishGuarded("device1/status", "on");

      await waitForLog(log, (entry) => (entry.level === "debug") &&
        logContains("MQTT publish dropped while disconnected from the broker: test/device1/status.")(entry));

      const debugLines = log.entries.filter((entry) => entry.level === "debug").map((entry) => formatLogEntry(entry));
      const traceIndex = debugLines.indexOf("MQTT publish: test/device1/status.");
      const dropIndex = debugLines.indexOf("MQTT publish dropped while disconnected from the broker: test/device1/status.");

      assert.equal(debugLines.filter((line) => line === "MQTT publish: test/device1/status.").length, 1, "a refused publish must still leave exactly one pre-send trace");
      assert.ok((traceIndex >= 0) && (traceIndex < dropIndex), "the pre-send trace must precede the line reporting the drop");
      assert.deepEqual(log.entries.filter((entry) => (entry.level === "error") && logContains("Unable to publish")(entry)), [],
        "a publish refused for want of a session must not be reported as a delivery failure");
    });
  });

  test("a broker that goes away makes the next publish reject offline, and a broker returning on the same port takes the publish after it", async () => {

    // The whole outage end to end against a real socket: a live session, the broker gone, the refusal, the broker back on the address the client is still reconnecting
    // to, and the next publish on the wire. The returning broker has to take the same port because the client is holding that address - a fresh ephemeral port would
    // leave it reconnecting to nothing. Every wait here is on an observed event rather than a sleep, so the row states its own timing rather than assuming one.
    const log = capturingLog();
    const broker = await startTestBroker();
    const port = Number.parseInt(new URL(broker.url).port, 10);

    await using client = makeClient({ brokerUrl: broker.url, log, reconnectInterval: 1 });

    await awaitClientConnected(client);
    await broker[Symbol.asyncDispose]();
    await waitForLog(log, logContains("Connection closed"));

    assert.equal(client.connected, false);

    const outcome = await settleOrPending(client.publish("device1/status", "gone"));

    assert.ok(outcome instanceof MqttOfflineError, "a publish issued while the broker is gone must be refused, observed: " + String(outcome));

    await using returned = await startTestBroker({ port });

    const publishes = recordClientPublishes(returned);

    await awaitClientConnected(client);
    await client.publish("device1/status", "back");

    // The recorder sits on the returning broker, so the session the client re-established states its availability there before this row's publish arrives.
    await waitUntil(() => publishes.entries.some((entry) => entry.topic === "test/device1/status"),
      { description: "the returning broker to record the delivered publish", timeoutMs: 5000 });

    assert.deepEqual(publishes.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "back", retain: false, topic: "test/device1/status" } ],
      "the publish issued during the outage must not replay on recovery");
  });
});

describe("MqttClient - change-gated publish", () => {

  // The `ifChanged` option end to end against a real broker: what goes out, what does not, and where the gate and the memory sit among the admissions every publish
  // already passes. Every row here publishes through `publishGuarded` unless it needs the promise, since the guarded form is what a poll-driven plugin calls.
  const TOPIC = "device1/status";
  const FULL_TOPIC = "test/device1/status";

  // Race a publish's settlement against a short budget, answering the rejection itself when the publish settled and a naming string when it did not, so a row can
  // state that an unchanged payload resolves during an outage rather than parking.
  async function settleOrPending(promise: Promise<void>): Promise<unknown> {

    return Promise.race([ promise.then(() => "resolved", (error: unknown) => error), delay(100).then(() => "pending") ]);
  }

  // A guarded publish hands its caller nothing to await, so a row that needs an acknowledgement to have reached the memory waits for the broker to record the
  // message and then lets the loop settle. The acknowledgement is the client's own write callback and the entry is the broker's read of the same bytes, two events
  // with no ordering between them, and the memory takes the payload a microtask after the first of them.
  async function awaitDelivered(delivered: () => number, count: number): Promise<void> {

    await waitUntil(() => (delivered() >= count), { description: "the broker records " + String(count) + " publish(es) from the client", timeoutMs: 5000 });
    await delay(SETTLE_MS);
  }

  test("sends the first change-gated payload, suppresses a repeat of it, and leaves the memory to change-gated publishes alone", async () => {

    // The whole of the parity behavior a consumer's own compare-then-publish cell had, plus the asymmetry that makes the option safe to mix with plain publishes on
    // one topic: a publish that does not ask for the gate neither reads the memory nor writes it, so a `subscribeGet` republish cannot arm or disarm the next gated
    // call.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 2);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });
    client.publishGuarded(TOPIC, "off", { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 3);
    await client.publish(TOPIC, "on");
    await awaitDelivered(() => publishes.entries.length, 4);

    client.publishGuarded(TOPIC, "off", { ifChanged: true });

    await delay(SETTLE_MS);

    assert.deepEqual(publishes.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: FULL_TOPIC },
      { payload: "off", retain: false, topic: FULL_TOPIC },
      { payload: "on", retain: false, topic: FULL_TOPIC } ], "the repeated payload and the payload the memory still holds must never have reached the broker");
  });

  test("weighs a Buffer payload against the bytes that were delivered rather than against the caller's buffer later on", async () => {

    // A plugin that fills one scratch buffer per pass is the case the copy exists for: rewriting the buffer after the publish must not rewrite what the memory
    // believes the broker has.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);

    const scratch = Buffer.from("on");

    client.publishGuarded(TOPIC, scratch, { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 2);

    scratch.write("no");

    client.publishGuarded(TOPIC, Buffer.from("on"), { ifChanged: true });
    client.publishGuarded(TOPIC, Buffer.from("off"), { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 3);

    assert.deepEqual(publishes.entries,
      [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: FULL_TOPIC }, { payload: "off", retain: false, topic: FULL_TOPIC } ],
      "a fresh buffer carrying the delivered bytes must be suppressed even after the original buffer was rewritten");
  });

  test("never treats a string and a Buffer as the same payload on the wire", async () => {

    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 2);

    client.publishGuarded(TOPIC, Buffer.from("on"), { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 3);

    assert.deepEqual(publishes.entries,
      [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: FULL_TOPIC }, { payload: "on", retain: false, topic: FULL_TOPIC } ],
      "a Buffer carrying a remembered string's bytes is a different kind of payload and must go out");
  });

  test("sends both of two change-gated publishes issued before the first acknowledgement, and suppresses one issued after they land", async () => {

    // The memory takes a payload on acknowledgement and not before, so a burst issued in one turn is honest about what had actually been delivered when each call
    // was made: nothing had, and both go out. Setting the memory on issue instead would swallow the second.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });
    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 3);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    await delay(SETTLE_MS);

    assert.deepEqual(publishes.entries,
      [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: FULL_TOPIC }, { payload: "on", retain: false, topic: FULL_TOPIC } ],
      "the third publish had an acknowledged payload to weigh against and must be suppressed");
  });

  test("resolves an unchanged payload through an outage, refuses a changed one every time it is offered, and sends again on a broker that returns", async () => {

    // The outage end to end against a real socket, which is where the memory's lifecycle shows: the gate answers ahead of the offline refusal, so an unchanged
    // payload resolves rather than being refused; a refusal writes nothing, so the same payload is refused again rather than being suppressed; and the connect that
    // ends the outage clears the memory, so a subscriber that missed a change while the broker was away hears the current value on the next pass.
    const log = capturingLog();
    const broker = await startTestBroker();
    const port = Number.parseInt(new URL(broker.url).port, 10);
    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url, log, reconnectInterval: 1 });

    await awaitClientConnected(client);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    await awaitDelivered(() => publishes.entries.length, 2);
    await broker[Symbol.asyncDispose]();
    await waitForLog(log, logContains("Connection closed"));

    assert.equal(client.connected, false);

    const unchanged = await settleOrPending(client.publish(TOPIC, "on", { ifChanged: true }));
    const changed = await settleOrPending(client.publish(TOPIC, "off", { ifChanged: true }));
    const offeredAgain = await settleOrPending(client.publish(TOPIC, "off", { ifChanged: true }));

    assert.equal(unchanged, "resolved", "a payload the broker already has is answered by the gate, ahead of the refusal, observed: " + String(unchanged));
    assert.ok(changed instanceof MqttOfflineError, "a changed payload with no session to carry it must be refused, observed: " + String(changed));
    assert.ok(offeredAgain instanceof MqttOfflineError, "a refused publish writes nothing, so the same payload must be refused again, observed: " +
      String(offeredAgain));

    await using returned = await startTestBroker({ port });

    const afterOutage = recordClientPublishes(returned);

    await awaitClientConnected(client);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    // The returning session states the plugin's availability before this row's restatement reaches the broker, so the wait names the restatement itself.
    await waitUntil(() => afterOutage.entries.some((entry) => entry.topic === FULL_TOPIC),
      { description: "the returning broker to record the restated payload", timeoutMs: 5000 });

    assert.deepEqual(afterOutage.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: FULL_TOPIC } ],
      "a session begins with nothing remembered, so the current value goes out again");
  });

  test("rejects a change-gated publish on an aborted client with the abort reason, and reports the guarded form on the aborted line", async () => {

    // The abort check answers ahead of the gate, so a torn-down client keeps rejecting with its own reason rather than quietly resolving a payload it has no way
    // to deliver.
    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();

      await using broker = await startTestBroker();

      const publishes = recordClientPublishes(broker);

      await using client = makeClient({ brokerUrl: broker.url, log });

      await awaitClientConnected(client);

      client.publishGuarded(TOPIC, "on", { ifChanged: true });

      await awaitDelivered(() => publishes.entries.length, 1);

      client.abort();

      const reason = await client.publish(TOPIC, "on", { ifChanged: true }).then(() => null, (error: unknown) => error);

      assert.ok(isHbpuAbortReason(reason, "shutdown"), "an aborted client rejects a change-gated publish with its own reason rather than resolving it, observed: " +
        String(reason));

      client.publishGuarded(TOPIC, "on", { ifChanged: true });

      await waitForLog(log, logContains("MQTT publish aborted: " + FULL_TOPIC + "."));
    });
  });

  test("lets a pre-aborted per-publish signal answer ahead of the change gate", async () => {

    // The per-publish signal governs a change-gated publish exactly as it governs any other, and it answers first: a cancelled publish is reported as cancelled
    // rather than silently reading as a payload the broker already had.
    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();

      await using broker = await startTestBroker();

      const publishes = recordClientPublishes(broker);

      await using client = makeClient({ brokerUrl: broker.url, log });

      await awaitClientConnected(client);

      client.publishGuarded(TOPIC, "on", { ifChanged: true });

      await awaitDelivered(() => publishes.entries.length, 2);

      const perPublish = new AbortController();

      perPublish.abort(new HbpuAbortError("replaced"));
      client.publishGuarded(TOPIC, "on", { ifChanged: true, signal: perPublish.signal });

      await waitForLog(log, logContains("MQTT publish aborted: " + FULL_TOPIC + "."));

      client.publishGuarded(TOPIC, "off", { ifChanged: true });

      await awaitDelivered(() => publishes.entries.length, 3);

      assert.deepEqual(publishes.entries,
        [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: FULL_TOPIC }, { payload: "off", retain: false, topic: FULL_TOPIC } ],
        "the cancelled publish must never have reached the broker, and the change after it must still go out");
    });
  });

  test("leaves exactly one publish trace in the log when a repeat of the payload is suppressed", async () => {

    // A suppressed publish attempted nothing, so there is nothing to report: the trace belongs to the call that reached the wire and to that call alone.
    await using broker = await startTestBroker();

    const log = capturingLog();
    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitClientConnected(client);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    // The count covers the availability statement as well as this row's own publish. Waiting on one alone would be satisfied by the statement while the row's
    // publish was still unacknowledged, leaving only the settle below between the row and a race.
    await awaitDelivered(() => publishes.entries.length, 2);

    client.publishGuarded(TOPIC, "on", { ifChanged: true });

    await delay(SETTLE_MS);

    const debugLines = log.entries.filter((entry) => entry.level === "debug").map((entry) => formatLogEntry(entry));

    assert.equal(debugLines.filter((line) => line === "MQTT publish: " + FULL_TOPIC + ".").length, 1,
      "a suppressed publish must leave no trace of its own, observed: " + JSON.stringify(debugLines));
    assert.deepEqual(publishes.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: FULL_TOPIC } ]);
  });
});

describe("MqttClient - subscribe semantics", () => {

  test("pre-aborted per-subscription signal is a silent no-op", async () => {

    await using client = makeClient();

    const perSub = new AbortController();

    perSub.abort(new HbpuAbortError("shutdown"));

    // No throw, no state mutation. The client remains non-aborted and subsequent operations still succeed.
    client.subscribe("topic", () => { /* handler */ }, { signal: perSub.signal });

    assert.equal(client.aborted, false);
  });

  test("subscribe after client abort is a silent no-op", async () => {

    const client = makeClient();

    client.abort();

    // Expected pattern: calls after teardown do not throw, they simply do nothing. Callers unwinding concurrently with teardown expect quiet no-ops.
    client.subscribe("topic", () => { /* handler */ });

    assert.equal(client.aborted, true);
  });

  test("unsubscribe with a missing id is a silent no-op", async () => {

    await using client = makeClient();

    // Matches the imperative ergonomic contract: an empty id short-circuits the whole call because the topic structure would be malformed.
    client.unsubscribe("", "topic");

    assert.equal(client.aborted, false);
  });
});

describe("MqttClient - subscription lifecycle (real broker)", () => {

  test("first handler on a topic issues a single wire-level subscribe; additional handlers de-duplicate in-process", async () => {

    // Multi-handler per topic: the broker subscribe is issued exactly once even though two handlers register. HBPU's de-duplication is synchronous against its own
    // subscription map; the second `client.subscribe()` short-circuits before reaching mqtt.js, so no second SUBSCRIBE packet ever leaves the client.
    await using broker = await startTestBroker();
    const subscribed = recordSubscribes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const firstSubscribe = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", () => { /* handler */ });
    client.subscribe("device1/status", () => { /* second handler on same topic */ });

    await firstSubscribe;

    // Settle: any spurious additional subscribe packet (the bug this test guards against) would arrive within the localhost window. Asserting after the settle proves
    // the single-subscribe contract.
    await delay(SETTLE_MS);

    assert.deepEqual(subscribed, ["test/device1/status"]);
  });

  test("per-subscription signal abort removes the handler and, when last, issues a wire-level unsubscribe", async () => {

    await using broker = await startTestBroker();
    const unsubscribed = recordWireUnsubscribes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");
    const feature = new AbortController();

    client.subscribe("device1/status", () => { /* handler */ }, { signal: feature.signal });

    await subscribeRoundTrip;

    assert.deepEqual(unsubscribed, []);

    const unsubscribeRoundTrip = once(broker.aedes, "unsubscribe");

    feature.abort(new HbpuAbortError("shutdown"));

    await unsubscribeRoundTrip;

    // The handler was the only one on the topic; aborting its signal drops the wire-level subscribe too.
    assert.deepEqual(unsubscribed, ["test/device1/status"]);
  });

  test("connection-level abort ends the transport and disconnects from the broker without issuing per-topic unsubscribes", async () => {

    await using broker = await startTestBroker();
    const unsubscribed = recordWireUnsubscribes(broker);

    const client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const firstSubscribe = once(broker.aedes, "subscribe");
    const secondSubscribe = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", () => { /* handler */ });

    await firstSubscribe;

    client.subscribe("device2/status", () => { /* handler */ });

    await secondSubscribe;

    const disconnect = once(broker.aedes, "clientDisconnect");

    client.abort();

    await disconnect;

    // mqtt.end(true) drops every server-side subscription in one wire close; no per-topic unsubscribes are issued during teardown.
    assert.deepEqual(unsubscribed, []);
    assert.equal(client.aborted, true);
  });

  test("message dispatch invokes every registered handler on the topic", async () => {

    await using broker = await startTestBroker();
    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const received: string[] = [];
    const both: PromiseWithResolvers<void> = Promise.withResolvers();
    let pending = 2;

    const settle = (): void => {

      if(--pending === 0) {

        both.resolve();
      }
    };

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", (msg) => { received.push("A:" + msg.toString()); settle(); });
    client.subscribe("device1/status", (msg) => { received.push("B:" + msg.toString()); settle(); });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/status" }, () => { /* delivered */ });

    await both.promise;

    assert.deepEqual(received, [ "A:on", "B:on" ]);
  });

  test("message dispatch on an unsubscribed topic short-circuits silently", async () => {

    // The broker can deliver messages on a topic the client never subscribed to (broker fan-out hitting the wrong route, or a wildcard subscription elsewhere). The
    // client must not throw or log; the dispatch handler must short-circuit without invoking handlers (none registered) and without surfacing any noise.
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/orphan" }, () => { /* delivered */ });

    await delay(SETTLE_MS);

    // The dispatch path is "did mqtt.js's `message` event fire and then HBPU's handler returned without logging." The redacted-broker connect log line is fine; we
    // assert against the dispatch-error text specifically so unrelated INFO logs do not falsely fail the test.
    assert.equal(log.entries.some((entry) => entry.message.includes("threw")), false, "delivery to an unsubscribed topic must produce no handler-error log entries");
  });

  test("a synchronously-throwing handler is caught and logged - sibling handlers still run", async () => {

    // The sync-throw catch path in the dispatch handler. A handler that throws synchronously must NOT prevent its siblings from running, and the throw itself must
    // surface as an error log entry naming the topic - the contract is "one bad handler logs but does not destabilize the connection or skip its siblings."
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    const received: string[] = [];
    const survivorReceived: PromiseWithResolvers<void> = Promise.withResolvers();

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", () => { throw new Error("handler-boom"); });
    client.subscribe("device1/status", (msg) => { received.push("survivor:" + msg.toString()); survivorReceived.resolve(); });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/status" }, () => { /* delivered */ });

    await survivorReceived.promise;

    assert.deepEqual(received, ["survivor:on"], "the surviving handler must still run after the throwing handler");
    assert.ok(log.entries.some((entry) => (entry.level === "error") && entry.message.includes("handler for") && entry.message.includes("threw")),
      "the synchronous throw must surface as an error-level log entry naming the topic and the throw");
  });

  test("an asynchronously-rejecting handler is caught and logged via markHandled", async () => {

    // The async-rejection path: a handler that returns a Promise which rejects must NOT trigger Node's unhandledRejection. The dispatch wraps async handlers in
    // markHandled so the rejection is consumed by `logHandlerError`. Asserting via the captured log entry covers both that the rejection was handled and that the
    // log surface treats sync and async failures uniformly.
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", async () => { throw new Error("async-handler-boom"); });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/status" }, () => { /* delivered */ });

    // The dispatch chain is `handler() -> rejected Promise -> .catch(logHandlerError) -> log.error("...handler for %s threw: %s.", topic, message)`. The topic lives
    // in params[0] (interpolated by `format`), not in the format string itself, so a substring match against the rendered line covers both the format-routing
    // (the entry exists) and the parameter wiring (the topic is the one params[0] carries).
    await waitForLog(log, (entry) => logContains("threw")(entry) && logContains("test/device1/status")(entry));
  });

  test("a handler that keeps throwing is reported once at error, replayed at debug, and reported again when it throws differently", async () => {

    // A handler that faults on every message is the loudest consumer defect the dispatch can meet. The third message changes what the handler throws, which is a
    // different fault rather than the same one repeating, so it is reported in full again.
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    let thrown = 0;

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", () => {

      thrown++;

      throw new Error((thrown < 3) ? "handler-boom" : "handler-boom-two");
    });

    await subscribeRoundTrip;

    // Each message is delivered only once the handler has seen the one before it, so every fault reaches the adapter in the order the assertions below read them
    // rather than racing the delivery after it.
    const deliverAndSettle = async (message: number): Promise<void> => {

      broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/status" },
        () => { /* delivered */ });

      return waitUntil(() => (thrown > message), { description: "the handler to see message " + message.toString(), timeoutMs: 5000 });
    };

    await deliverAndSettle(0);
    await deliverAndSettle(1);
    await deliverAndSettle(2);

    await waitForLog(log, logContains("handler-boom-two"));

    assert.equal(logCount(log.entries, "error", "handler-boom-two"), 1, "a fault that differs from the one before it is reported in full");
    assert.equal(logCount(log.entries, "error", "threw: handler-boom."), 1, "the unchanged repeat must not reach error level a second time");
    assert.equal(logCount(log.entries, "debug", "threw: handler-boom."), 1, "the unchanged repeat is replayed at debug");
  });

  test("a getter's successful publish does not clear what another callback's fault is remembered under", async () => {

    /* The consumer memory is one adapter for the whole client, so anything that settles it settles it for every callback. A getter that publishes successfully is
     * progress rather than a fault and must leave that memory alone: were its success routed through an attempt, this row's second handler fault would report in
     * full again instead of replaying at debug, and one healthy getter would keep the demotion from ever firing.
     */
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    let thrown = 0;

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", () => {

      thrown++;

      throw new Error("handler-boom");
    });
    client.subscribeGet("device1/reading", "Reading", () => "on");

    await subscribeRoundTrip;

    const deliver = (topic: string, payload: string): void => {

      broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from(payload), qos: 0, retain: false, topic }, () => { /* delivered */ });
    };

    // The fault, reported in full because nothing precedes it.
    deliver("test/device1/status", "on");
    await waitUntil(() => (thrown > 0), { description: "the handler to fault once", timeoutMs: 5000 });

    // A getter publish that succeeds, between the two faults, which must change nothing about what the memory holds.
    deliver("test/device1/reading/get", "true");
    await waitForLog(log, (entry) => (entry.level === "info") && logContains("Reading status published")(entry));

    // The same fault again: unchanged reason, no fault in between, so it replays at debug.
    deliver("test/device1/status", "on");
    await waitUntil(() => (thrown > 1), { description: "the handler to fault a second time", timeoutMs: 5000 });
    await waitForLog(log, (entry) => (entry.level === "debug") && logContains("handler-boom")(entry));

    assert.equal(logCount(log.entries, "error", "threw: handler-boom."), 1, "an unrelated success must not restore the fault to full volume");
    assert.equal(logCount(log.entries, "debug", "threw: handler-boom."), 1, "the repeat is replayed at debug across the intervening success");
  });
});

describe("MqttClient - removeHandler edge cases", () => {

  test("per-subscription abort after client teardown short-circuits the removeHandler early-return", async () => {

    // The #removeHandler early-return: subscriptions are cleared during client teardown (#teardown calls #subscriptions.clear()), but per-subscription signals can
    // still abort afterwards if the caller holds a reference. The abort listener fires against an already-cleared subscription map and must short-circuit cleanly.
    // We construct that exact race here: subscribe with a per-sub signal, abort the client (clears subs), then abort the per-sub signal. The handler must not throw,
    // must not re-issue an unsubscribe (the client's mqtt.end(true) already covered all subscriptions), and must leave the broker in a clean state.
    await using broker = await startTestBroker();
    const unsubscribed = recordWireUnsubscribes(broker);

    const sub = new AbortController();
    const client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/motion", () => { /* no-op */ }, { signal: sub.signal });

    await subscribeRoundTrip;

    const disconnect = once(broker.aedes, "clientDisconnect");

    // Abort the client first - this fires teardown which clears the subscription map and ends the transport. The per-subscription composed signal aborts as part of
    // the same teardown, but its listener is registered AFTER teardown, so teardown runs first and the subscription map is empty when the per-sub listener fires.
    client.abort(new HbpuAbortError("shutdown"));

    await disconnect;

    // Independently abort the per-sub signal AFTER the client is already torn down. The composed signal has already aborted (during client.abort()), so this second
    // abort is a no-op at the listener level. The behavior we care about is from the FIRST abort path - teardown -> subscriptions cleared -> per-sub listener fires
    // -> #removeHandler hits the early return.
    sub.abort(new HbpuAbortError("shutdown"));

    await delay(SETTLE_MS);

    // The mqtt.end(true) path was issued by teardown; no per-topic unsubscribe must have leaked through the post-teardown abort path.
    assert.deepEqual(unsubscribed, [], "post-teardown per-sub abort must not issue a wire-level unsubscribe");
    assert.equal(client.aborted, true);
  });
});

describe("MqttClient - subscribeSet timeout", () => {

  test("a signal-aware setter is cancelled when the per-invocation timeout elapses", async () => {

    await using broker = await startTestBroker();
    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const setterResolvers: PromiseWithResolvers<"completed" | "aborted"> = Promise.withResolvers();

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    // Signal-aware setter: `delay` from `node:timers/promises` forwards the setter-signal through; when the timeout elapses the delay rejects with the signal's reason,
    // we catch that rejection and settle with `"aborted"`. A setter that completes within the timeout window would settle with `"completed"`. The test asserts on which
    // path the setter took, proving end-to-end that the timeout actually cancels the setter's work - not just releases the subscribeSet wrapper.
    client.subscribeSet("device1/switch", "Switch", async (_value, _raw, signal) => {

      try {

        await delay(500, undefined, { signal });
        setterResolvers.resolve("completed");
      } catch {

        setterResolvers.resolve("aborted");
      }
    }, { timeout: 20 });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/switch/set" }, () => { /* delivered */ });

    assert.equal(await setterResolvers.promise, "aborted");
  });
});

describe("MqttClient - reconnect vs abort", () => {

  test("transient close events do not trigger mqtt.end - mqtt.js's auto-reconnect governs recovery", async () => {

    // The broker connects, then is closed externally. The mqtt.js client observes the close, fires its "close" event, and (with reconnectInterval: 0 disabling auto-
    // reconnect) stays in the closed state. HBPU must NOT interpret this as a permanent end - that decision belongs to the abort path, not the close path.
    const broker = await startTestBroker();

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    // Close the broker side. mqtt.js sees the socket close and emits "close" without a preceding HBPU-driven abort.
    await broker[Symbol.asyncDispose]();

    // Yield for the close event to propagate up through mqtt.js to HBPU.
    await delay(SETTLE_MS);

    // The close handler in HBPU only logs; it does not abort the client and does not call mqtt.end on its own. The aborted flag remains false.
    assert.equal(client.aborted, false);
  });

  test("explicit abort() ends the transport permanently and the broker observes a clientDisconnect", async () => {

    // Abort is the subject of this test. The real-broker substrate observes the disconnect through aedes' clientDisconnect event - this is the visible side effect
    // of HBPU's `mqtt.end(true)` call inside #teardown.
    await using broker = await startTestBroker();
    const client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const disconnect = once(broker.aedes, "clientDisconnect");

    client.abort();

    await disconnect;

    assert.equal(client.aborted, true);
  });
});

describe("MqttClient - subscribeGet", () => {

  test("publishes the getter's return value to the parent topic when a \"true\" message arrives on /get", async () => {

    // Get-pattern contract: `subscribeGet(topic, ...)` subscribes to `topic/get`; when a "true" arrives, the getter runs and the result is published to the parent
    // `topic` (no `/get` suffix). Case-insensitive: "true", "True", "TRUE" all trigger the publish.
    await using broker = await startTestBroker();
    const subscribed = recordSubscribes(broker);
    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeGet("device1/switch", "Switch", () => "on");

    await subscribeRoundTrip;

    assert.deepEqual(subscribed, ["test/device1/switch/get"], "subscribeGet must subscribe to the /get child topic");

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("true"), qos: 0, retain: false, topic: "test/device1/switch/get" }, () => { /* ack */ });

    // The connect that carried the subscription also carried the plugin's availability statement, so the wait names the getter's own republish.
    await waitUntil(() => publishes.entries.some((entry) => entry.topic === "test/device1/switch"),
      { description: "the broker to record the getter's republish", timeoutMs: 5000 });

    assert.deepEqual(publishes.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: false, topic: "test/device1/switch" } ],
      "a \"true\" trigger on /get must publish the getter's result on the parent topic");
  });

  test("ignores messages whose lowercased value is not \"true\"", async () => {

    // The contract: only "true" triggers. Anything else (empty string, "false", arbitrary noise) is silently ignored so the broker-side fan-out can issue status
    // queries without forcing every listener to respond.
    await using broker = await startTestBroker();
    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    let invocations = 0;

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeGet("device1/switch", "Switch", () => {

      invocations++;

      return "on";
    });

    await subscribeRoundTrip;

    for(const payload of [ "", "false", "off", "TRUE " ]) {

      broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from(payload), qos: 0, retain: false, topic: "test/device1/switch/get" }, () => { /* ack */ });
    }

    await delay(SETTLE_MS);

    assert.equal(invocations, 0, "getters must only fire on a lowercased \"true\" payload");
    assert.deepEqual(publishes.entries, [AVAILABILITY_ONLINE_RECORD],
      "the session's own availability statement must be the only client-originated publish when the trigger value does not match");
  });

  test("case-insensitive trigger: \"TRUE\" and mixed-case variants fire the getter", async () => {

    // `subscribeGet` lowercases the payload before comparison, so any casing of "true" triggers. This is the existing production behavior the test proves.
    await using broker = await startTestBroker();
    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    let invocations = 0;
    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeGet("device1/switch", "Switch", () => {

      invocations++;

      return "on";
    });

    await subscribeRoundTrip;

    for(const payload of [ "TRUE", "True", "tRuE" ]) {

      broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from(payload), qos: 0, retain: false, topic: "test/device1/switch/get" }, () => { /* ack */ });
    }

    await delay(SETTLE_MS);

    assert.equal(invocations, 3, "all case variants of \"true\" must trigger the getter");
  });

  test("a successful response publish emits the info-level \"status published\" log entry", async () => {

    // Policy: a successful publish emits `log.info("%s status published.", type)`. The dual failure-path assertion on `log.error("failed to publish ...")` is
    // intentionally not exercised here: HBPU's response publish runs at QoS 0, where mqtt.js's publish callback fires on socket-write completion regardless of
    // broker-side processing - so any broker-side rejection (authorizePublish error, post-publish disconnect, etc.) lands AFTER the publish callback has already
    // resolved successfully. The `.catch` branch in subscribeGet's `void this.publish(...).then(info).catch(error)` chain is defensive code covering the rare
    // socket-write-failure case (kernel-level send error, mqtt.js-internal serialization fault); reproducing those against a real broker requires contrived
    // socket-level setup that is not worth the architectural complexity. Coverage of the catch branch comes through `client.publish`'s own error-path tests.
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeGet("device1/switch", "Switch", () => "on");

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("true"), qos: 0, retain: false, topic: "test/device1/switch/get" }, () => { /* ack */ });

    await waitForLog(log, (entry) => (entry.level === "info") && logContains("status published")(entry));
  });

  test("a getter response publish that keeps failing is reported once at error and replayed at debug", async () => {

    // The substituted publish is what makes the failure branch reachable at all: at QoS 0 a real broker answers the publish callback on socket write, so nothing a
    // broker does can fail a getter's own response publish.
    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = new FailingPublishClient({ brokerUrl: broker.url, log, reconnectInterval: 0, topicPrefix: "test" });

      await awaitClientConnected(client);

      const subscribeRoundTrip = once(broker.aedes, "subscribe");

      client.subscribeGet("device1/status", "Switch", () => "on");

      await subscribeRoundTrip;

      for(let message = 0; message < 2; message++) {

        broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("true"), qos: 0, retain: false, topic: "test/device1/status/get" },
          () => { /* ack */ });
      }

      await waitUntil(() => loggedAt(log.entries, "debug", "failed to publish Switch status"),
        { description: "the repeated getter failure to be replayed at debug", timeoutMs: 5000 });

      assert.equal(logCount(log.entries, "error", "failed to publish Switch status"), 1,
        "the repeat of an unchanged reason must not reach error level a second time");
    });
  });
});

describe("MqttClient - subscribeSet log policy", () => {

  test("normal setter completion logs at info with the received value", async () => {

    // Policy documented on MqttSetHandler: when the setter returns normally, log.info("set message received for %s: %s.", type, value). The invocation path goes through
    // `runWithAbort` + `SUBSCRIBE_SET_OK` sentinel, and a normally-returning setter resolves the sentinel which routes to the info log.
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeSet("device1/switch", "Switch", () => { /* setter completes synchronously. */ });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("ON"), qos: 0, retain: false, topic: "test/device1/switch/set" }, () => { /* ack */ });

    await waitForLog(log, (entry) => (entry.level === "info") && entry.message.includes("set message received") && entry.params.includes("on"));
  });

  test("setter throws a non-abort error: logs at error with the exception message", async () => {

    // Policy: a non-abort throw from the setter routes to log.error("error setting %s to %s: %s.", type, value, message). The wrapper catches the rethrow from
    // runWithAbort (when the signal has not aborted) and routes it to the error path; the client itself stays alive.
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeSet("device1/switch", "Switch", () => {

      throw new Error("device rejected update");
    });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/switch/set" }, () => { /* ack */ });

    await waitForLog(log, (entry) => (entry.level === "error") && entry.message.includes("error setting") && entry.params.includes("device rejected update"));
    assert.equal(client.aborted, false, "a setter error must not cascade to the client");
  });

  test("setter times out (signal-aware cancellation): logs at warn with the cancellation message", async () => {

    // Policy: a setter that observes its abort signal and rethrows signal.reason routes to log.warn("set handler for %s was cancelled before completion.", type). This
    // is one leg of the log routing documented on MqttSetHandler; `runWithAbort` returns null when its composed signal fires, which the wrapper distinguishes from
    // the success case via the `SUBSCRIBE_SET_OK` sentinel.
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeSet("device1/switch", "Switch", async (_value, _raw, signal) => {

      // A signal-aware setter that blocks on the signal and lets `runWithAbort` time it out. `delay` from node:timers/promises rejects with the signal's reason when
      // the composed signal aborts; we let that rejection propagate so the wrapper sees a "not SUBSCRIBE_SET_OK" result via runWithAbort returning null.
      await delay(500, undefined, { signal });
    }, { timeout: 20 });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/switch/set" }, () => { /* ack */ });

    // The 20ms setter timeout fires, the composed signal aborts, the setter's `delay(500, ..., { signal })` rejects with the signal's reason, runWithAbort returns
    // null, and the wrapper logs the warn entry. waitForLog polls until that entry appears - the chain settles in ~30ms typically; the 1000ms default ceiling is a
    // comfortable margin for slow CI runners.
    await waitForLog(log, (entry) => (entry.level === "warn") && logContains("was cancelled before completion")(entry));
  });

  test("a setter that keeps throwing the same error is reported once at error and replayed at debug", async () => {

    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitConnect(broker);

    let calls = 0;

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribeSet("device1/switch", "Switch", () => {

      calls++;

      throw new Error("device rejected update");
    });

    await subscribeRoundTrip;

    // The second message is delivered only once the setter has seen the first, so the repeat is weighed against a fault the adapter has already classified.
    const deliverAndSettle = async (message: number): Promise<void> => {

      broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("on"), qos: 0, retain: false, topic: "test/device1/switch/set" },
        () => { /* ack */ });

      return waitUntil(() => (calls > message), { description: "the setter to see message " + message.toString(), timeoutMs: 5000 });
    };

    await deliverAndSettle(0);
    await deliverAndSettle(1);

    await waitForLog(log, (entry) => (entry.level === "debug") && logContains("error setting")(entry));

    assert.equal(logCount(log.entries, "error", "error setting"), 1, "the unchanged repeat must not reach error level a second time");
  });
});

describe("MqttClient - unsubscribe ergonomics", () => {

  test("unsubscribe(id, topic) removes the subscription and issues a wire-level unsubscribe", async () => {

    // The imperative feature-toggle path: a subscription was made earlier, and now the caller wants to drop it without having retained a dedicated controller. The
    // client expands `(id, topic)` into `test/device1/motion` and dispatches the wire-level unsubscribe.
    await using broker = await startTestBroker();
    const subscribed = recordSubscribes(broker);
    const unsubscribed = recordWireUnsubscribes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/motion", () => { /* handler */ });

    await subscribeRoundTrip;

    const unsubscribeRoundTrip = once(broker.aedes, "unsubscribe");

    client.unsubscribe("device1", "motion");

    await unsubscribeRoundTrip;

    assert.deepEqual(subscribed, ["test/device1/motion"]);
    assert.deepEqual(unsubscribed, ["test/device1/motion"],
      "unsubscribe(id, topic) must dispatch the wire-level unsubscribe on the prefixed topic");
  });

  test("unsubscribe after client abort is a silent no-op", async () => {

    // After abort, the subscription map has been cleared and the transport has ended. The unsubscribe call must short-circuit rather than try to touch the dead
    // transport.
    await using broker = await startTestBroker();
    const unsubscribed = recordWireUnsubscribes(broker);

    const client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/motion", () => { /* handler */ });

    await subscribeRoundTrip;

    const disconnect = once(broker.aedes, "clientDisconnect");

    client.abort();

    await disconnect;

    // Snapshot what the broker observed during teardown - mqtt.end(true) drops connections without per-topic unsubscribes, so the array is empty.
    const unsubscribedSnapshot = [...unsubscribed];

    client.unsubscribe("device1", "motion");

    await delay(SETTLE_MS);

    assert.deepEqual(unsubscribed, unsubscribedSnapshot, "post-abort unsubscribe must not issue any new wire-level unsubscribe");
  });
});

describe("MqttClient - multi-handler topic dispatch", () => {

  test("per-subscription signal abort removes only the aborted handler; siblings keep receiving", async () => {

    // The rule here: multiple subscribers to the same topic are independent. Aborting one handler's signal must NOT unsubscribe the topic at the wire level
    // (other handlers are still live) and must NOT stop dispatch to the surviving handlers.
    await using broker = await startTestBroker();
    const unsubscribed = recordWireUnsubscribes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const ctrlA = new AbortController();
    const receivedByA: string[] = [];
    const receivedByB: string[] = [];

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    let firstResolvers: PromiseWithResolvers<void> = Promise.withResolvers();
    let bothFirstReceived = 2;

    client.subscribe("device1/status", (msg) => {

      receivedByA.push(msg.toString());

      if(--bothFirstReceived === 0) {

        firstResolvers.resolve();
      }
    }, { signal: ctrlA.signal });

    client.subscribe("device1/status", (msg) => {

      receivedByB.push(msg.toString());

      if(--bothFirstReceived === 0) {

        firstResolvers.resolve();
      }
    });

    await subscribeRoundTrip;

    // Both handlers receive the first delivery.
    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("first"), qos: 0, retain: false, topic: "test/device1/status" }, () => { /* ack */ });

    await firstResolvers.promise;

    assert.deepEqual(receivedByA, ["first"]);
    assert.deepEqual(receivedByB, ["first"]);

    // Abort handler A's signal. The wire-level unsubscribe must NOT fire because handler B is still registered.
    ctrlA.abort(new HbpuAbortError("shutdown"));

    await delay(SETTLE_MS);

    assert.deepEqual(unsubscribed, [], "wire-level unsubscribe must not fire while sibling handlers remain");

    // Deliver another message. Only handler B should observe it.
    const secondReceived: PromiseWithResolvers<void> = Promise.withResolvers();

    firstResolvers = Promise.withResolvers();
    bothFirstReceived = 1;

    // Replace handler B's resolver target so the next delivery resolves `secondReceived`. We cannot mutate the registered handler from outside; instead we rely on
    // the same handler closure (which decrements `bothFirstReceived` and resolves when zero) - resetting `bothFirstReceived` to 1 makes the next single delivery
    // resolve.
    void firstResolvers.promise.then(() => secondReceived.resolve());

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("second"), qos: 0, retain: false, topic: "test/device1/status" }, () => { /* ack */ });

    await secondReceived.promise;

    assert.deepEqual(receivedByA, ["first"], "aborted handler must not receive subsequent messages");
    assert.deepEqual(receivedByB, [ "first", "second" ], "surviving sibling must continue receiving after a peer aborts");

    // Now abort the client. With both handlers gone (ctrlA already aborted handler A; client.abort() handles the rest), teardown uses mqtt.end(true) rather than
    // per-topic unsubscribe.
    const disconnect = once(broker.aedes, "clientDisconnect");

    client.abort();

    await disconnect;

    assert.deepEqual(unsubscribed, [],
      "teardown uses mqtt.end(true) rather than per-topic unsubscribes - the subscription map is cleared on the way out, no per-topic work is owed");
  });

  test("handler that removes itself mid-dispatch does not destabilize the current fan-out", async () => {

    // The message handler iterates a snapshot of the handler set, so a handler that calls back into the client (e.g., via a per-subscription signal it controls) can
    // abort itself during dispatch without affecting the delivery to siblings already queued for invocation. This is the subtle "do not iterate the live Set during
    // dispatch" rule documented in `#wireMqttEvents`.
    await using broker = await startTestBroker();

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitConnect(broker);

    const ctrlFirst = new AbortController();
    const sawByFirst: string[] = [];
    const sawBySecond: string[] = [];

    const both: PromiseWithResolvers<void> = Promise.withResolvers();
    let pending = 2;

    const settle = (): void => {

      if(--pending === 0) {

        both.resolve();
      }
    };

    const subscribeRoundTrip = once(broker.aedes, "subscribe");

    client.subscribe("device1/status", (msg) => {

      sawByFirst.push(msg.toString());
      // Self-abort during dispatch. This would remove the first handler from the live set; the snapshot iteration must insulate the second handler from that
      // removal.
      ctrlFirst.abort(new HbpuAbortError("replaced"));
      settle();
    }, { signal: ctrlFirst.signal });

    client.subscribe("device1/status", (msg) => { sawBySecond.push(msg.toString()); settle(); });

    await subscribeRoundTrip;

    broker.aedes.publish({ cmd: "publish", dup: false, payload: Buffer.from("payload"), qos: 0, retain: false, topic: "test/device1/status" }, () => { /* ack */ });

    await both.promise;

    assert.deepEqual(sawByFirst, ["payload"]);
    assert.deepEqual(sawBySecond, ["payload"], "the second handler must still receive the message even though the first removed itself mid-dispatch");
  });
});

describe("MqttClient - transport error handler (real network)", () => {

  test("ECONNREFUSED logs \"Connection refused\" at error level (real unreachable port)", async () => {

    // mqtt.js attempts to connect to a port nothing is listening on; the kernel returns ECONNREFUSED, mqtt.js emits an error event with that errno code, HBPU routes
    // it through {@link routeMqttBrokerError} to the "Connection refused" log line. Real network behavior - no synthesized error injection.
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: UNREACHABLE_BROKER, log, reconnectInterval: 1 });

    await waitForLog(log, logContains("Connection refused"));
  });

  test("ECONNRESET logs \"Connection reset\" at error level (real reset server)", async () => {

    // A reset-on-accept TCP server produces ECONNRESET on the client side. mqtt.js receives the reset, emits an error event, HBPU routes it.
    await using resetServer = await startResetServer();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: resetServer.url, log, reconnectInterval: 1 });

    await waitForLog(log, logContains("Connection reset"));
  });

  test("ENOTFOUND logs \"Hostname or IP address not found\" and mqtt.js keeps retrying the lookup (real DNS failure)", async () => {

    // The `.invalid` TLD is reserved by RFC 2606 for unresolvable names; DNS lookups against it always fail with ENOTFOUND. mqtt.js sees the lookup error and emits an
    // error event, HBPU routes it to a log line carrying the retry cadence, and mqtt.js retries the lookup at the configured interval exactly as it does for every
    // other transport error.
    const log = capturingLog();
    const isHostnameLine = logContains("Hostname or IP address not found");

    await using client = makeClient({ brokerUrl: "mqtt://does-not-exist.invalid:1883", log, reconnectInterval: 1 });

    await waitForLog(log, isHostnameLine);

    assert.ok(firstRendered(log).includes("Will retry again in 1 second"), "the hostname line must carry the retry cadence at reconnectInterval 1");

    // `waitForLog` resolves on `entries.some(predicate)` over every entry captured so far, so waiting for a SECOND attempt means excluding the entries already seen
    // by identity. A substring alone would be satisfied instantly by the first line and prove nothing about the retry loop.
    const seen = new Set(log.entries);

    await waitForLog(log, (entry) => !seen.has(entry) && isHostnameLine(entry));
  });

  test("a broker that keeps refusing reports the refusal once at error and replays it at debug", async () => {

    // mqtt.js retries on the configured cadence and emits the same ECONNREFUSED every time, which is the outage this adapter exists to quiet: the first report is
    // the one a reader acts on, and every one after it is the same fact at debug.
    const log = capturingLog();
    const isRefusedLine = logContains("Connection refused");

    await using client = makeClient({ brokerUrl: UNREACHABLE_BROKER, log, reconnectInterval: 1 });

    await waitForLog(log, (entry) => (entry.level === "error") && isRefusedLine(entry));

    const seen = new Set(log.entries);

    await waitForLog(log, (entry) => !seen.has(entry) && isRefusedLine(entry));

    assert.equal(logCount(log.entries, "error", "Connection refused"), 1, "only the first refusal of an unbroken run is reported at error level");
    assert.ok(loggedAt(log.entries, "debug", "Connection refused"), "the repeat must be replayed at debug, message and parameters verbatim");
  });
});

describe("routeMqttBrokerError - pure function", () => {

  // The wiring tests above cover the connect-time ECONNREFUSED / ECONNRESET / ENOTFOUND paths through real network failures. The pure function tests below cover
  // the routing logic itself - including the `default` branch, which has no natural real-network analogue (no transport error in node:net produces an error without
  // an errno code). The function takes a synthetic error and emits one log line; tests assert against the captured log entries.

  function syntheticError(code?: string, message = "synthetic"): Error & { readonly code?: string } {

    return (code === undefined) ? new Error(message) : errnoError(message, code);
  }

  test("ECONNREFUSED logs \"Connection refused\" with the retry cadence", () => {

    const log = capturingLog();

    routeMqttBrokerError(syntheticError("ECONNREFUSED"), log, 60);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Connection refused"), "log line must contain the \"Connection refused\" substring");
    assert.ok(rendered.includes("60"), "log line must include the configured reconnect interval");
  });

  test("ECONNRESET logs \"Connection reset\"", () => {

    const log = capturingLog();

    routeMqttBrokerError(syntheticError("ECONNRESET"), log, 60);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Connection reset"));
  });

  test("ENOTFOUND logs the hostname-not-found line through the retry-cadence formatter", () => {

    const log = capturingLog();

    routeMqttBrokerError(syntheticError("ENOTFOUND"), log, 60);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Hostname or IP address not found"));
    // A DNS answer is not proof the hostname is wrong, so an unresolvable name is retried on the same cadence as every other transport error and says so.
    assert.ok(rendered.includes("Will retry again"), "ENOTFOUND must carry the retry-cadence suffix");
  });

  test("unknown error codes fall through to the default branch with util.inspect output", () => {

    const log = capturingLog();

    routeMqttBrokerError(syntheticError("EWEIRD", "unfamiliar error"), log, 30);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Will retry again"), "unknown errors are still routed through the retry-cadence formatter");
    assert.ok(rendered.includes("unfamiliar error") || rendered.includes("EWEIRD"), "the inspected error payload must appear somewhere in the rendered log line");
  });

  test("errors with no .code at all fall through to the default branch (defensive coverage)", () => {

    // A bare Error without an errno code is shape-equivalent to "future mqtt.js error we did not anticipate." The default branch must still log it through the
    // retry-cadence formatter rather than silently swallowing or crashing.
    const log = capturingLog();

    routeMqttBrokerError(syntheticError(undefined, "no code at all"), log, 60);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Will retry again"));
  });

  test("a reconnect interval mqtt.js will not arm renders the disabled-reconnection sentence in place of the retry cadence", () => {

    // mqtt.js arms its reconnect timer on `reconnectPeriod > 0`, a comparison that is false for zero, for a negative value, and for a value that is not a number
    // alike. The line has to say so for all three: a reader told to expect a retry in 0 seconds goes looking for a network fault instead of the configuration that
    // turned reconnection off. A fresh log per case is what lets each one fail on its own, since `firstRendered` reads only the first entry a log holds.
    for(const reconnectInterval of [ 0, -1, Number.NaN ]) {

      const log = capturingLog();

      routeMqttBrokerError(syntheticError("ECONNREFUSED"), log, reconnectInterval);

      assert.equal(firstRendered(log), "MQTT Broker: Connection refused. Automatic reconnection is disabled.");
      assert.equal(log.entries.length, 1, "the router must emit exactly one line whatever the interval");
    }
  });

  test("reconnect interval pluralization: 1 second is singular, others are plural", () => {

    // The retry-cadence suffix says "1 second" for interval 1 and "N seconds" for any other interval. Assert both branches.
    const logSingular = capturingLog();

    routeMqttBrokerError(syntheticError("ECONNREFUSED"), logSingular, 1);

    const renderedSingular = firstRendered(logSingular);

    assert.ok(renderedSingular.includes("1 second.") || renderedSingular.includes("1 second "), "interval 1 must render \"1 second\" without the plural \"s\"");

    const logPlural = capturingLog();

    routeMqttBrokerError(syntheticError("ECONNREFUSED"), logPlural, 5);

    const renderedPlural = firstRendered(logPlural);

    assert.ok(renderedPlural.includes("5 seconds"), "intervals other than 1 must render with the plural \"seconds\"");
  });
});

describe("logGetterPublishOutcome - pure function", () => {

  // The wiring through `subscribeGet` exercises only the success branch with a real broker (at QoS 0, mqtt.js's publish callback fires success on socket-write
  // before any broker-side rejection lands, so the failure branch cannot be reached through real-broker behavior). The pure function tests below cover both
  // branches by calling the function directly with synthetic outcomes - the same architectural pattern `routeMqttBrokerError` uses for the unknown-errno branch
  // that has no real-network analogue.

  test("ok outcome emits an info-level \"status published\" entry naming the type", () => {

    const log = capturingLog();

    logGetterPublishOutcome(log, "Switch", { ok: true });

    const [entry] = log.entries;

    assert.ok(entry, "the success branch must emit exactly one log entry");
    assert.equal(entry.level, "info", "the success branch must log at info level");
    assert.ok(firstRendered(log).includes("Switch status published"), "the rendered line must mention the type and \"status published\"");
  });

  test("non-ok outcome emits an error-level \"failed to publish\" entry with the stripped error message", () => {

    const log = capturingLog();

    logGetterPublishOutcome(log, "Switch", { error: new Error("device refused update."), ok: false });

    const [entry] = log.entries;

    assert.ok(entry, "the failure branch must emit exactly one log entry");
    assert.equal(entry.level, "error", "the failure branch must log at error level");

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("failed to publish Switch status"), "rendered line must contain the failure-routing format");
    assert.ok(rendered.includes("device refused update"), "rendered line must contain the underlying error message");
    assert.ok(!rendered.includes("update.."), "the trailing period from the source error must be stripped to avoid \"..\" in the log");
  });

  test("non-Error rejection values are coerced through String(...) before logging", () => {

    // Promise rejections can carry any value. The failure branch must remain robust to non-Error throws; we verify by rejecting with a string and confirming the
    // rendered line surfaces the string form.
    const log = capturingLog();

    logGetterPublishOutcome(log, "Switch", { error: "string-shaped failure", ok: false });

    assert.ok(firstRendered(log).includes("string-shaped failure"), "non-Error rejections must still surface their string form in the log");
  });
});

describe("brokerErrorReason - pure function", () => {

  // Each arm is asserted against a synthetic error rather than driven through the client, because mqtt.js emits only one of these shapes on demand: a real broken
  // endpoint produces a string errno, while a protocol refusal's numeric code and an error carrying no code at all cannot be provoked deterministically. Reading
  // the derivation directly is what lets every arm be stated, which is the same reason the routers beside it are tested this way.
  test("a string errno code is the tag, so an outage repeating under one code reads as one reason", () => {

    assert.equal(brokerErrorReason(errnoError("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED")), "ECONNREFUSED");
    assert.equal(brokerErrorReason(errnoError("read ECONNRESET", "ECONNRESET")), "ECONNRESET");
  });

  test("a numeric protocol code answers its own decimal text, so two refusal reasons stay two tags", () => {

    // mqtt.js raises `ErrorWithReasonCode` for a protocol-level refusal, whose `code` is a number rather than an errno string.
    assert.equal(brokerErrorReason(errnoError("Connection refused: Not authorized", 135)), "135");
    assert.notEqual(brokerErrorReason(errnoError("Connection refused: Bad User Name or Password", 134)),
      brokerErrorReason(errnoError("Connection refused: Not authorized", 135)));
  });

  test("an error carrying no code answers one fixed tag rather than none", () => {

    // A reason of `undefined` would tell the adapter the episode closed, which is the opposite of what an uncoded error that keeps repeating means.
    const reason = brokerErrorReason(new Error("the transport gave up"));

    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 0, "an uncoded error must still answer a tag, so its repeat can be demoted like a coded one");
    assert.equal(brokerErrorReason(new Error("a different message, still uncoded")), reason, "every uncoded error reads as the same one reason");
  });
});

describe("MqttClient - connect / close edge flag", () => {

  test("close without a prior connect is silent (no disconnect spam during initial retry loop)", async () => {

    // The edge-flag rule: a close event only logs when we had previously connected. With the unreachable-broker URL, mqtt.js's connect attempt fails (logging
    // "Connection refused") and emits a close event without a preceding connect. HBPU's close handler must short-circuit on the close that follows. We use the
    // refused-log appearance as a deterministic synchronization point: it fires before the close event, so once it's observed we know the close-handler path has
    // also run - and we can then assert the silence we expect from the close path itself.
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: UNREACHABLE_BROKER, log, reconnectInterval: 0 });

    await waitForLog(log, logContains("Connection refused"));

    assert.equal(log.entries.some((entry) => entry.message.includes("Connection closed")), false,
      "close-without-connect must not log the \"Connection closed\" line");
  });

  test("connect then close logs the \"Connection closed\" line exactly once per cycle", async () => {

    // Stand up a real broker, let HBPU connect, then close the broker. The mqtt.js client observes the close event WITH a prior connect having fired, so HBPU's edge
    // flag is true and the disconnect log line is emitted exactly once.
    const broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log, reconnectInterval: 0 });

    await awaitConnect(broker);

    await broker[Symbol.asyncDispose]();

    await waitForLog(log, logContains("Connection closed"));

    const closedLogs = log.entries.filter((entry) => entry.message.includes("Connection closed"));

    assert.equal(closedLogs.length, 1, "exactly one \"Connection closed\" log entry must fire per connect/close cycle");
  });

  test("connect logs the redacted broker URL (password-safe for status pages)", async () => {

    // The connect handler routes the broker URL through `redactBrokerUrl`, which renders `scheme://user:password@host` as `scheme://user:REDACTED@host` so a
    // connected broker's URL never leaks credentials into log output. This is an operational-safety guarantee; aedes accepts arbitrary credentials by default, so
    // the real broker honors the URL as-is.
    await using broker = await startTestBroker();
    const credentialedUrl = broker.url.replace("mqtt://", "mqtt://user:secretpass@");
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: credentialedUrl, log });

    await awaitConnect(broker);

    await waitForLog(log, logContains("Connected to"));

    const connectLog = log.entries.find((entry) => entry.message.includes("Connected to"));

    assert.ok(connectLog, "connect must emit the \"Connected to ...\" log line");

    const fullMessage = connectLog.message + " " + connectLog.params.map((param) => String(param)).join(" ");

    assert.ok(fullMessage.includes("REDACTED"), "the password segment of the broker URL must be redacted in the log output");
    assert.ok(!fullMessage.includes("secretpass"), "the raw password must never appear in any log line");
  });
});

describe("MqttClient - connect notification", () => {

  /* The notification end to end against a real broker: who is invoked and how often, in what order, what the session and the change-gated memory read at the moment
   * a handler runs, and what a faulting handler does to the registrations beside it.
   *
   * Every wait is on an observed event - the client's own session reading, the connect line the listener emits, a counter a handler moved, a publish the broker
   * recorded - rather than on a sleep. The connect line earns its place for a reason of its own: `awaitClientConnected` answers on mqtt.js's flag, which mqtt.js
   * sets before it emits the event this listener is bound to, so a row that has to know the listener already ran waits for the line the listener itself writes.
   */
  const CONNECT_WAIT_MS = 5000;

  test("a registration made before the first connect is invoked exactly once by it", async () => {

    await using broker = await startTestBroker();

    await using client = makeClient({ brokerUrl: broker.url });

    let connects = 0;

    client.onConnect(() => { connects++; });

    await awaitClientConnected(client);
    await waitUntil(() => connects === 1, { description: "the first connect to reach the registration", timeoutMs: CONNECT_WAIT_MS });
    await delay(SETTLE_MS);

    assert.equal(connects, 1, "the first session must invoke a registration exactly once");
  });

  test("a session re-established after an outage invokes the registration again, with the session live and the memory already cleared", async () => {

    /* The whole point of the notification, against a real socket: the broker goes away, comes back on the address the client is still reconnecting to, and the
     * handler restates the state a subscriber missed. The restatement is change-gated on a payload the handler already published before the outage, so it can only
     * reach the returning broker if the connect cleared the memory before invoking the handler - and it can only be admitted at all if the session reads live by
     * the time the handler runs.
     */
    const log = capturingLog();
    const broker = await startTestBroker();
    const port = Number.parseInt(new URL(broker.url).port, 10);
    const readings: boolean[] = [];

    let connects = 0;

    await using client = makeClient({ brokerUrl: broker.url, log, reconnectInterval: 1 });

    client.onConnect(async () => {

      connects++;
      readings.push(client.connected);

      await client.publish("device1/status", "held", { ifChanged: true });
    });

    await awaitClientConnected(client);
    await waitUntil(() => connects === 1, { description: "the first connect to reach the registration", timeoutMs: CONNECT_WAIT_MS });

    await broker[Symbol.asyncDispose]();
    await waitForLog(log, logContains("Connection closed"));

    await using returned = await startTestBroker({ port });

    const publishes = recordClientPublishes(returned);

    // The re-established session states the plugin's availability ahead of the registration it then invokes, so the wait names the handler's own restatement
    // rather than resolving on the statement that precedes it.
    await waitUntil(() => publishes.entries.some((entry) => entry.topic === "test/device1/status"),
      { description: "the returning broker to record the handler's restatement", timeoutMs: CONNECT_WAIT_MS });
    await delay(SETTLE_MS);

    assert.deepEqual(publishes.entries, [ AVAILABILITY_ONLINE_RECORD, { payload: "held", retain: false, topic: "test/device1/status" } ],
      "the handler's change-gated restatement must reach the returning broker, which it can only do if the connect cleared the memory ahead of it");
    assert.equal(connects, 2, "a re-established session must invoke the registration exactly once more");
    assert.deepEqual(readings, [ true, true ], "a handler must find the session live on every connect, so a publish it issues is admitted");
  });

  test("registering while a session is already held invokes nothing until the connect after it", async () => {

    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    // Both waits are the row: the session reading is what makes the registration below one against a live session, and the connect line is what proves the listener
    // has already run, so a zero count afterwards is the absence of a replay rather than a connect that has yet to happen.
    await awaitClientConnected(client);
    await waitForLog(log, logContains("Connected to"));

    let connects = 0;

    client.onConnect(() => { connects++; });

    await delay(SETTLE_MS);

    assert.equal(connects, 0, "a registration joining a live session must wait for the connect after it rather than replaying the one it joined");
  });

  test("a registration released before the connect is not invoked by it, and a pre-aborted signal registers nothing", async () => {

    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    const releasing = new AbortController();
    const preAborting = new AbortController();
    const counts = { plain: 0, preAborted: 0, released: 0 };

    preAborting.abort(new HbpuAbortError("shutdown"));

    client.onConnect(() => { counts.released++; }, { signal: releasing.signal });
    client.onConnect(() => { counts.plain++; });
    client.onConnect(() => { counts.preAborted++; }, { signal: preAborting.signal });

    releasing.abort(new HbpuAbortError("shutdown"));

    await awaitClientConnected(client);
    await waitForLog(log, logContains("Connected to"));
    await delay(SETTLE_MS);

    assert.deepEqual(counts, { plain: 1, preAborted: 0, released: 0 },
      "the released and the pre-aborted registrations must be invoked by nothing, while the sibling beside them is invoked once");

    // An aborted client registers nothing and says nothing about it - the no-op posture every other verb on this class takes once the signal has fired.
    await using aborted = makeClient({ brokerUrl: broker.url });

    aborted.abort();

    assert.doesNotThrow(() => aborted.onConnect(() => { throw new Error("an aborted client must invoke nothing it was handed"); }),
      "onConnect on an aborted client must be a silent no-op");
  });

  test("handlers run in registration order, and one whose promise never settles does not hold back the ones after it", async () => {

    await using broker = await startTestBroker();

    await using client = makeClient({ brokerUrl: broker.url });

    const order: number[] = [];

    client.onConnect((): Promise<void> => {

      order.push(1);

      // A handler that never settles. Awaiting one before invoking the next would leave the two after it unreached and the wait below to time out.
      return new Promise<void>(() => { /* This promise is deliberately left pending. */ });
    });

    client.onConnect(() => { order.push(2); });
    client.onConnect(() => { order.push(3); });

    await waitUntil(() => order.length === 3, { description: "every registration to have been invoked", timeoutMs: CONNECT_WAIT_MS });

    assert.deepEqual(order, [ 1, 2, 3 ], "the registrations must run in registration order, none of them waiting on the one before it");
  });

  test("a synchronously-throwing handler is logged and the registrations after it still run", async () => {

    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    let recorded = 0;

    client.onConnect(() => { throw new Error("connect-handler-boom"); });
    client.onConnect(() => { recorded++; });

    await waitUntil(() => recorded === 1, { description: "the registration after the throwing one to run", timeoutMs: CONNECT_WAIT_MS });
    await waitForLog(log, logContains("The MQTT connect handler failed"));

    const failed = log.entries.filter((entry) => (entry.level === "error") && logContains("The MQTT connect handler failed")(entry));
    const failures = failed.map((entry) => formatLogEntry(entry));

    assert.equal(failures.length, 1, "a throwing handler must leave exactly one failure line");
    assert.ok(failures[0]?.includes("connect-handler-boom"), "the failure line must carry the thrown message, observed: " + String(failures[0]));
  });

  test("an asynchronously-rejecting handler reaches the same line and never floats as an unhandled rejection", async () => {

    await assertNoUnhandledRejections(async () => {

      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = makeClient({ brokerUrl: broker.url, log });

      let recorded = 0;

      client.onConnect(async () => { throw new Error("connect-handler-rejection"); });
      client.onConnect(() => { recorded++; });

      await waitForLog(log, logContains("connect-handler-rejection"));
      await waitUntil(() => recorded === 1, { description: "the registration after the rejecting one to run", timeoutMs: CONNECT_WAIT_MS });

      const failure = log.entries.find((entry) => (entry.level === "error") && logContains("connect-handler-rejection")(entry));

      assert.ok(failure, "a rejecting handler must reach the same error line a throwing one does");
      assert.ok(formatLogEntry(failure).startsWith("The MQTT connect handler failed: "),
        "the failure line must read as the sentence both failure shapes share, observed: " + formatLogEntry(failure));
    });
  });

  test("registering the same function twice is one registration", async () => {

    await using broker = await startTestBroker();

    await using client = makeClient({ brokerUrl: broker.url });

    let connects = 0;

    const handler = (): void => {

      connects++;
    };

    client.onConnect(handler);
    client.onConnect(handler);

    await waitUntil(() => connects === 1, { description: "the connect to reach the registration", timeoutMs: CONNECT_WAIT_MS });
    await delay(SETTLE_MS);

    assert.equal(connects, 1, "the same function registered twice must be invoked once per connect, as it is on a topic");
  });

  test("a handler that releases a sibling or registers another mid-pass does not destabilize the current pass", async () => {

    /* The snapshot rule, on the connect pass rather than on the message pass: the set may move underneath while the pass runs, and which registrations this connect
     * invokes is settled before the first one is called. A sibling released mid-pass is still invoked by the pass it was in, and a registration made mid-pass waits
     * for the connect after it.
     */
    await using broker = await startTestBroker();
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    const releasing = new AbortController();
    const counts = { first: 0, late: 0, second: 0, third: 0 };

    client.onConnect(() => {

      counts.first++;
      releasing.abort(new HbpuAbortError("replaced"));
      client.onConnect(() => { counts.late++; });
    });

    client.onConnect(() => { counts.second++; }, { signal: releasing.signal });
    client.onConnect(() => { counts.third++; });

    await awaitClientConnected(client);
    await waitForLog(log, logContains("Connected to"));
    await delay(SETTLE_MS);

    assert.deepEqual(counts, { first: 1, late: 0, second: 1, third: 1 },
      "the pass must invoke the registrations it snapshotted - the released sibling among them - and leave the one registered mid-pass for the connect after it");
  });
});

describe("MqttClient - availability", () => {

  /* The plugin-scoped half of the availability contract, end to end against a real broker: what the client states on each session it establishes, where that
   * statement sits among a consumer's own publishes, what the broker keeps for a subscriber that was not listening yet, and what the broker says on the client's
   * behalf once the connection ends without a DISCONNECT.
   */
  const AVAILABILITY_WAIT_MS = 5000;

  // Open a raw mqtt.js client, subscribe it to one topic, and answer the first message the broker replays onto it - which, for a subscriber attaching after the
  // fact, can only be the retained copy. The delivery wait is raced against an explicit budget so the teardown below always runs: an unbounded wait against a
  // broker that retained nothing holds the raw connection open and carries the whole process past the runner's own per-test timeout instead of failing this row.
  // The budget's timer is unreferenced, so winning the race does not leave a pending timer holding the event loop open.
  async function readRetained(url: string, topic: string): Promise<{ payload: string; retain: boolean; topic: string }> {

    const raw = connect(url);

    try {

      // Both waits are bridged through `Promise.withResolvers` on mqtt.js's own typed event surface, which is the codebase's pattern for turning a callback event
      // into a promise, and which keeps the packet's own `retain` reading typed rather than recovered from a tuple.
      const connected: PromiseWithResolvers<void> = Promise.withResolvers();
      const delivered: PromiseWithResolvers<{ payload: string; retain: boolean; topic: string }> = Promise.withResolvers();

      raw.once("connect", () => connected.resolve());
      raw.once("message", (deliveredTopic, payload, packet) => {

        delivered.resolve({ payload: payload.toString(), retain: packet.retain, topic: deliveredTopic });
      });

      await connected.promise;
      raw.subscribe(topic);

      const received = await Promise.race([ delivered.promise, delay(AVAILABILITY_WAIT_MS, null, { ref: false }) ]);

      assert.ok(received, "the broker must replay the retained statement to a subscriber that attaches after it was published");

      return received;
    } finally {

      raw.end(true);
    }
  }

  test("a first connect puts exactly one retained statement on the plugin's availability topic", async () => {

    // The recorder is installed ahead of the client so nothing the connect produces is missed, and the settle after the connect line is what makes the count an
    // exactness claim rather than a snapshot taken too early: a second statement would have arrived inside it.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);
    const log = capturingLog();

    await using client = makeClient({ brokerUrl: broker.url, log });

    await awaitClientConnected(client);
    await waitForLog(log, logContains("Connected to"));
    await delay(SETTLE_MS);

    assert.deepEqual(publishes.entries, [AVAILABILITY_ONLINE_RECORD],
      "a session must state the plugin's availability exactly once, retained, on the availability topic under the configured prefix");
  });

  test("puts the plugin's statement on the wire ahead of anything a connect handler publishes", async () => {

    // The order is the whole of this row, so it asserts the recorded sequence rather than membership: a set comparison would pass with the statement trailing the
    // handler's publish, which is exactly the arrangement that lets a subscriber read a device as reachable under a plugin that has said nothing at all. The
    // recorder reports arrival at the broker, which is the order the guarantee is about.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    client.onConnect(() => client.publishGuarded("device1/status", "on"));

    await waitUntil(() => (publishes.entries.length >= 2), { description: "the broker to record both publishes", timeoutMs: AVAILABILITY_WAIT_MS });

    assert.deepEqual(publishes.entries.map((entry) => entry.topic), [ AVAILABILITY_ONLINE_RECORD.topic, "test/device1/status" ],
      "a consumer's connect handler must find the plugin's own statement already on the wire");
  });

  test("a session re-established after an outage restates it, retained, exactly once", async () => {

    // The same shape the connect-notification suite uses to drive a real outage: dispose the broker, wait for the close line, and stand a fresh one up on the port
    // the client is still reconnecting to. The recorder on the returning broker sees only what the re-established session produced.
    const log = capturingLog();
    const broker = await startTestBroker();
    const port = Number.parseInt(new URL(broker.url).port, 10);

    await using client = makeClient({ brokerUrl: broker.url, log, reconnectInterval: 1 });

    await awaitClientConnected(client);
    await broker[Symbol.asyncDispose]();
    await waitForLog(log, logContains("Connection closed"));

    await using returned = await startTestBroker({ port });

    const afterOutage = recordClientPublishes(returned);

    await awaitClientConnected(client);
    await waitUntil(() => (afterOutage.entries.length >= 1),
      { description: "the returning broker to record the restated statement", timeoutMs: AVAILABILITY_WAIT_MS });
    await delay(SETTLE_MS);

    assert.deepEqual(afterOutage.entries, [AVAILABILITY_ONLINE_RECORD],
      "every session the client establishes must restate the plugin's availability, once and retained");
  });

  test("carries a consumer's retain flag to the wire, and leaves a publish that asks for nothing unretained", async () => {

    // The flag reaches the broker rather than merely reaching the options object, which is what the recorder's own reading of the packet proves. Both halves run
    // on one session so the default and the request are read off the same wire.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);
    await client.publish("device1/status", "on", { retain: true });
    await client.publish("device1/other", "on");
    await waitUntil(() => (publishes.entries.length >= 3), { description: "the broker to record both consumer publishes", timeoutMs: AVAILABILITY_WAIT_MS });

    assert.deepEqual(publishes.entries,
      [ AVAILABILITY_ONLINE_RECORD, { payload: "on", retain: true, topic: "test/device1/status" },
        { payload: "on", retain: false, topic: "test/device1/other" } ],
      "a publish asking for retention must be retained on the wire, and one asking for nothing must not be");
  });

  test("a forced teardown makes the broker publish the offline statement, retained", async () => {

    // The client's only teardown destroys the socket without sending a DISCONNECT, which is the shape that leaves the broker holding a will to publish. The abort
    // is explicit and lands while the broker is still listening, so the will's own publish is not racing the broker's teardown; the scope-bound disposal below is
    // then a no-op on an already-aborted client.
    await using broker = await startTestBroker();

    const publishes = recordClientPublishes(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);
    await waitUntil(() => (publishes.entries.length >= 1), { description: "the session's own statement to reach the broker", timeoutMs: AVAILABILITY_WAIT_MS });

    client.abort();

    await waitUntil(() => publishes.entries.some((entry) => (entry.payload === AVAILABILITY_OFFLINE_RECORD.payload)),
      { description: "the broker to publish the client's will", timeoutMs: AVAILABILITY_WAIT_MS });

    assert.deepEqual(publishes.entries.at(-1), AVAILABILITY_OFFLINE_RECORD,
      "a client that goes away without a DISCONNECT must leave the broker to state the plugin's absence, retained");
  });

  test("the broker retains both statements, so a subscriber attaching after either one reads it", async () => {

    /* Each half opens its subscriber only after the broker's own pipeline has completed the statement it is about, which is what
     * `recordRetainedStoreCompletions` observes and what arrival order cannot promise: aedes writes the retained store and only then emits the event this
     * recorder is bound to, and the replay a late subscriber reads comes out of that same store. Subscribing on any earlier reading - the client's session flag,
     * or arrival at the broker - races the store write, and a subscriber that wins that race finds nothing retained and waits out its budget.
     */
    await using broker = await startTestBroker();

    const completions = recordRetainedStoreCompletions(broker);

    await using client = makeClient({ brokerUrl: broker.url });

    await awaitClientConnected(client);
    await waitUntil(() => completions.entries.some((entry) => (entry.payload === AVAILABILITY_ONLINE_RECORD.payload)),
      { description: "the broker's retained store to hold the online statement", timeoutMs: AVAILABILITY_WAIT_MS });

    assert.deepEqual(await readRetained(broker.url, AVAILABILITY_ONLINE_RECORD.topic), AVAILABILITY_ONLINE_RECORD,
      "a subscriber attaching after the connect must read the retained online statement, with the packet's retain flag set");

    client.abort();

    await waitUntil(() => completions.entries.some((entry) => (entry.payload === AVAILABILITY_OFFLINE_RECORD.payload)),
      { description: "the broker's retained store to hold the offline statement", timeoutMs: AVAILABILITY_WAIT_MS });

    assert.deepEqual(await readRetained(broker.url, AVAILABILITY_OFFLINE_RECORD.topic), AVAILABILITY_OFFLINE_RECORD,
      "a subscriber attaching after the teardown must read the retained offline statement the will produced");
  });
});

// A plugin-side meta shape, standing in for the typed annotation channel a composing plugin threads through its own catalog.
interface PluginMeta {

  icon: string;
}

/* Compile-time assignability proof for the group's meta channel and its category name. These never run - the function is never called, and its leading underscore
 * marks it, with its bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals; TypeScript still type-checks the body
 * during `npm run typecheck`, so a return type that drops the generic or widens the category name to `string` fails the build here rather than silently at a
 * consuming plugin.
 */
const _mqttGroupShapeExercises = (): void => {

  const typed = mqttFeatureOptions<PluginMeta>({ defaultTopic: "hydrawise" });

  // A plugin whose catalog is typed over its own meta channel names that type at the call and assigns both halves of the group straight in. A return typed over the
  // `unknown` forms is not assignable to either of these, which is the bridge the generic removes from the plugin side.
  const _category: FeatureCategoryEntry<PluginMeta> = typed.category;
  const _options: FeatureOptionEntry<PluginMeta>[] = typed.options;

  /* The category name is the literal `"Mqtt"`, so a catalog record keyed on literal category names takes it as a computed key and stays keyed on those literals. A
   * `name: string` would contribute a string index signature instead, leaving the record's `Mqtt` key unsatisfied.
   */
  const _catalog: Record<"Device" | "Mqtt", FeatureOptionEntry<PluginMeta>[]> = {

    Device: [],
    [typed.category.name]: typed.options
  };

  // The computed key above is only a literal key if the category name is the literal itself, so this holds that name fixed against a widening to `string`.
  type _CategoryNameIsLiteral = Assert<Equal<typeof typed.category.name, "Mqtt">>;

  // An un-parameterized call resolves to the `unknown` forms and assigns into an untyped catalog, so every existing consumer compiles unchanged.
  const bare = mqttFeatureOptions({ defaultTopic: "ratgdo" });
  const _bareCategory: FeatureCategoryEntry = bare.category;
  const _bareOptions: FeatureOptionEntry[] = bare.options;
};

describe("mqttFeatureOptions - canonical MQTT feature-option group", () => {

  test("declares the MQTT category and exactly two entries carrying the catalog's exact literals", () => {

    const { category, options } = mqttFeatureOptions({ defaultTopic: "homebridge" });

    assert.deepEqual(category, { description: "MQTT", name: "Mqtt" });
    assert.equal(options.length, 2, "the group declares exactly two entries");

    const [ url, topic ] = options;

    assert.ok(url, "the group must declare a Url entry");
    assert.ok(topic, "the group must declare a Topic entry");

    // The descriptions are owner-visible catalog surface and the defaults are the design: Url disabled so an unconfigured broker resolves to null, Topic enabled so
    // an unconfigured topic resolves to the registered default. A swapped description or a flipped default fails here.
    assert.equal(url.default, false);
    assert.equal(url.defaultValue, "");
    assert.equal(url.description, "URL of the MQTT broker to connect to (e.g. mqtt://1.2.3.4).");
    assert.equal(url.inputSize, 30);
    assert.equal(url.name, "Url");

    assert.equal(topic.default, true);
    assert.equal(topic.defaultValue, "homebridge");
    assert.equal(topic.description, "Topic prefix for published and subscribed MQTT messages.");
    assert.equal(topic.inputSize, 20);
    assert.equal(topic.name, "Topic");
  });

  test("threads the caller's default topic and scope declaration onto both entries", () => {

    const first = mqttFeatureOptions({ defaultTopic: "hydrawise" });
    const second = mqttFeatureOptions({ defaultTopic: "ratgdo" });
    const scoped = mqttFeatureOptions({ defaultTopic: "protect", scopes: ["controller"] });

    const [ firstUrl, firstTopic ] = first.options;
    const [ secondUrl, secondTopic ] = second.options;
    const [ scopedUrl, scopedTopic ] = scoped.options;

    assert.ok(firstUrl);
    assert.ok(firstTopic);
    assert.ok(secondUrl);
    assert.ok(secondTopic);
    assert.ok(scopedUrl);
    assert.ok(scopedTopic);

    // Two calls with different topics register different defaults - a topic hardcoded in the factory would make these identical - and the topic lands on the Topic
    // entry alone rather than bleeding into the broker URL's own empty default.
    assert.equal(firstTopic.defaultValue, "hydrawise");
    assert.equal(secondTopic.defaultValue, "ratgdo");
    assert.equal(secondUrl.defaultValue, "");

    // The scope declaration lands on every entry, asserted entry by entry rather than swept: a factory threading it to only one of the two would still satisfy a
    // some-style check across the array.
    assert.deepEqual(scopedUrl.scopes, ["controller"]);
    assert.deepEqual(scopedTopic.scopes, ["controller"]);
    assert.deepEqual(firstUrl.scopes, ["global"]);
    assert.deepEqual(firstTopic.scopes, ["global"]);
  });

  test("allocates a fresh object graph per call and never embeds the caller's scopes array", () => {

    const callerScopes: NonNullable<FeatureOptionEntry["scopes"]> = ["controller"];

    const a = mqttFeatureOptions({ defaultTopic: "alpha", scopes: callerScopes });
    const b = mqttFeatureOptions({ defaultTopic: "beta", scopes: callerScopes });

    const [ aUrl, aTopic ] = a.options;
    const [ bUrl, bTopic ] = b.options;

    assert.ok(aUrl);
    assert.ok(aTopic);
    assert.ok(bUrl);
    assert.ok(bTopic);

    // Distinctness at every level between two calls. The scopes tuple is readonly-typed, so a mutation probe on it would not compile; reference inequality is both
    // the compiling form and the stronger statement, since it rules out sharing rather than sampling one consequence of it.
    assert.notStrictEqual(a.category, b.category);
    assert.notStrictEqual(a.options, b.options);
    assert.notStrictEqual(aUrl, bUrl);
    assert.notStrictEqual(aTopic, bTopic);
    assert.notStrictEqual(aUrl.scopes, bUrl.scopes);
    assert.notStrictEqual(aTopic.scopes, bTopic.scopes);

    // Within a single call the two entries hold their own tuples, and neither is the array the caller passed in - so a caller that later mutates its own array
    // cannot reach into a catalog it has already handed over.
    assert.notStrictEqual(aUrl.scopes, aTopic.scopes);
    assert.notStrictEqual(aUrl.scopes, callerScopes);
    assert.notStrictEqual(aTopic.scopes, callerScopes);

    // The default-scopes path allocates per call as well, rather than handing every caller one shared module-level tuple.
    const c = mqttFeatureOptions({ defaultTopic: "gamma" });
    const d = mqttFeatureOptions({ defaultTopic: "delta" });

    const [ cUrl, cTopic ] = c.options;
    const [ dUrl, dTopic ] = d.options;

    assert.ok(cUrl);
    assert.ok(cTopic);
    assert.ok(dUrl);
    assert.ok(dTopic);

    assert.notStrictEqual(cUrl.scopes, cTopic.scopes);
    assert.notStrictEqual(cUrl.scopes, dUrl.scopes);
    assert.notStrictEqual(cTopic.scopes, dTopic.scopes);

    // Mutation smoke on the mutable string fields. A category or entry hoisted to module scope - the category is the tempting one, since it depends on no
    // configuration - would let one call's edit surface in another call's catalog.
    a.category.description = "mutated";
    aUrl.description = "mutated";

    assert.equal(b.category.description, "MQTT");
    assert.equal(bUrl.description, "URL of the MQTT broker to connect to (e.g. mqtt://1.2.3.4).");
  });

  test("an unconfigured catalog surfaces the registered topic and reports no broker URL", () => {

    const { category, options } = mqttFeatureOptions({ defaultTopic: "hydrawise" });
    const featureOptions = new FeatureOptions([category], { [category.name]: options });

    // Topic defaults enabled, so with nothing configured anywhere `value()` falls through to the default registered by the catalog - the single-source-of-truth
    // point of the group, and the reason a consuming plugin carries no topic fallback of its own. Url defaults disabled, so the same unconfigured state resolves to
    // null, which is the unambiguous "MQTT is off" answer. Flipping either default fails exactly one of these two assertions.
    assert.equal(featureOptions.value("Mqtt.Topic"), "hydrawise");
    assert.equal(featureOptions.value("Mqtt.Url"), null);
  });
});

/* The resolution the two controller-scoped plugins and the four global-scope ones share. Every row drives a real engine over a real catalog composed from the
 * group itself, and every row builds its own engine, because `setOption` mutates in place and one row's entries reaching the next would read as a resolution
 * defect rather than as the leak it is.
 */
describe("mqttConnectionSettings - broker and topic-prefix resolution", () => {

  /* Seven fixtures, pairwise distinct, so no row can pass by one of them coinciding with another. The canonical prefix is deliberately not "test/canonical"
   * either: a resolver that hardcoded a plausible canonical string rather than reading the catalog would still fail here.
   */
  const CONTROLLER = "AABBCCDDEEFF";
  const OTHER_CONTROLLER = "112233445566";
  const PROPERTY_BROKER = "mqtt://property.broker:1883";
  const PROPERTY_TOPIC = "property/prefix";
  const OPTION_BROKER = "mqtt://option.broker:1883";
  const OPTION_TOPIC = "option/prefix";
  const CANONICAL = "canonical/prefix";

  // A fresh engine over a catalog composing nothing but the MQTT group, at the scope the caller asks for. Controller scope is the default because it is what the
  // two large plugins declare; the global-scope rows ask for theirs.
  function engineWith(scopes: NonNullable<FeatureOptionEntry["scopes"]> = ["controller"]): FeatureOptions {

    const group = mqttFeatureOptions({ defaultTopic: CANONICAL, scopes });

    return new FeatureOptions([group.category], { [group.category.name]: group.options });
  }

  test("no broker anywhere leaves MQTT off for the identity", () => {

    assert.deepEqual(mqttConnectionSettings({ config: {}, controller: CONTROLLER, featureOptions: engineWith() }), null,
      "an empty configuration with nothing configured has no broker to connect to");
    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC }, controller: CONTROLLER, featureOptions: engineWith() }), null,
      "a topic is not a broker, so a configuration carrying one and nothing else is still off");
    assert.deepEqual(mqttConnectionSettings({ config: { mqttUrl: "" }, controller: CONTROLLER, featureOptions: engineWith() }), null,
      "an empty property broker is no broker at all");
    assert.deepEqual(mqttConnectionSettings({ controller: CONTROLLER, featureOptions: engineWith() }), null,
      "and a plugin that carries no configuration properties at all resolves the same way");
  });

  test("a configuration carrying only the properties resolves both of them", () => {

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER,
      featureOptions: engineWith() }), { brokerUrl: PROPERTY_BROKER, topicPrefix: PROPERTY_TOPIC },
    "the transition assertion: a configuration nobody has opened the webUI on must keep resolving exactly what it always resolved");
  });

  test("a property broker with no topic beside it resolves the catalog's registered canonical prefix", () => {

    assert.deepEqual(mqttConnectionSettings({ config: { mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: engineWith() }),
      { brokerUrl: PROPERTY_BROKER, topicPrefix: CANONICAL },
      "the canonical prefix is read from the catalog the plugin registered it in, so a hardcoded string cannot answer here");
  });

  test("an empty property topic is read as unset and the canonical prefix answers", () => {

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: "", mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: engineWith() }),
      { brokerUrl: PROPERTY_BROKER, topicPrefix: CANONICAL },
      "a blank configuration field produces this, and passing it through would turn off an identity whose user configured a broker");
  });

  test("a configured broker outranks the property broker", () => {

    const withTopic = engineWith();

    withTopic.setOption({ enabled: true, id: CONTROLLER, option: "Mqtt.Url", value: OPTION_BROKER });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER,
      featureOptions: withTopic }), { brokerUrl: OPTION_BROKER, topicPrefix: PROPERTY_TOPIC },
    "the configured broker answers and the untouched topic still reads its property");

    const withoutTopic = engineWith();

    withoutTopic.setOption({ enabled: true, id: CONTROLLER, option: "Mqtt.Url", value: OPTION_BROKER });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: withoutTopic }),
      { brokerUrl: OPTION_BROKER, topicPrefix: CANONICAL }, "and with no property topic the canonical prefix closes the chain");
  });

  test("a configured topic outranks the property topic", () => {

    const engine = engineWith();

    engine.setOption({ enabled: true, id: CONTROLLER, option: "Mqtt.Topic", value: OPTION_TOPIC });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: engine }),
      { brokerUrl: PROPERTY_BROKER, topicPrefix: OPTION_TOPIC }, "the user's own configured entry is their choice and supersedes the property");
  });

  test("a topic the user turned off turns MQTT off, even beside a usable property topic and broker", () => {

    const engine = engineWith();

    engine.setOption({ enabled: false, id: CONTROLLER, option: "Mqtt.Topic" });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: engine }),
      null, "a configured option rules in every state, so a property must not resurrect a topic the user switched off");
  });

  test("an identity that resolves no controller reads its properties alone, and another controller's entries never reach it", () => {

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, featureOptions: engineWith() }),
      { brokerUrl: PROPERTY_BROKER, topicPrefix: PROPERTY_TOPIC }, "with no identity to address, the properties are the whole of the answer");

    const elsewhere = engineWith();

    elsewhere.setOption({ enabled: true, id: OTHER_CONTROLLER, option: "Mqtt.Url", value: OPTION_BROKER });
    elsewhere.setOption({ enabled: true, id: OTHER_CONTROLLER, option: "Mqtt.Topic", value: OPTION_TOPIC });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, featureOptions: elsewhere }),
      { brokerUrl: PROPERTY_BROKER, topicPrefix: PROPERTY_TOPIC }, "another controller's entries must not reach an identity that never resolves one");
  });

  test("a global-scope catalog resolves its own configured entries with no identity passed", () => {

    const engine = engineWith(["global"]);

    engine.setOption({ enabled: true, option: "Mqtt.Url", value: OPTION_BROKER });
    engine.setOption({ enabled: true, option: "Mqtt.Topic", value: OPTION_TOPIC });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, featureOptions: engine }),
      { brokerUrl: OPTION_BROKER, topicPrefix: OPTION_TOPIC }, "the four global-scope plugins pass no identity, and their configured entries must still answer");
  });

  test("a topic the user enabled without giving it a value turns MQTT off", () => {

    /* A bare enable is a state only the global scope can express - a scoped enable carrying no value reduces to clearing the scope - so these two rows sit at
     * global scope. A hand-authored scoped entry of the same shape degrades through the very same guard.
     */
    const engine = engineWith(["global"]);

    engine.setOption({ enabled: true, option: "Mqtt.Topic" });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttUrl: PROPERTY_BROKER }, featureOptions: engine }), null,
      "an enable carrying nothing is still the user speaking about the topic, so the canonical prefix must not answer over it");
  });

  test("a broker the user enabled without giving it a value turns MQTT off", () => {

    const engine = engineWith(["global"]);

    engine.setOption({ enabled: true, option: "Mqtt.Url" });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, featureOptions: engine }), null,
      "the same rule on the broker: an enable with no value must not fall back to the property");
  });

  test("a broker the user turned off turns MQTT off, even beside a usable property broker", () => {

    const engine = engineWith();

    engine.setOption({ enabled: false, id: CONTROLLER, option: "Mqtt.Url" });

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: PROPERTY_TOPIC, mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: engine }),
      null, "a property broker must not resurrect a broker the user switched off");
  });

  test("a catalog with no usable canonical topic is refused before anything is read", () => {

    const deviceOnly = new FeatureOptions([{ description: "Device", name: "Device" }],
      { Device: [{ default: true, description: "Make this device available in HomeKit.", name: "" }] });

    assert.throws(() => mqttConnectionSettings({ config: { mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: deviceOnly }),
      /^Error: mqttConnectionSettings: .*Mqtt\.Topic/);

    // With no configuration at all the check still runs, which is what says it precedes every read rather than depending on one of them.
    assert.throws(() => mqttConnectionSettings({ controller: CONTROLLER, featureOptions: deviceOnly }), /^Error: mqttConnectionSettings: .*Mqtt\.Topic/);

    // A group composed with an empty canonical topic is the same programming error: the client would read the empty prefix as MQTT off, with nothing logged.
    const emptyGroup = mqttFeatureOptions({ defaultTopic: "", scopes: ["controller"] });
    const emptyCanonical = new FeatureOptions([emptyGroup.category], { [emptyGroup.category.name]: emptyGroup.options });

    assert.throws(() => mqttConnectionSettings({ config: { mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: emptyCanonical }),
      /^Error: mqttConnectionSettings: .*Mqtt\.Topic/);

    assert.doesNotThrow(() => mqttConnectionSettings({ config: { mqttUrl: PROPERTY_BROKER }, controller: CONTROLLER, featureOptions: engineWith() }),
      "a catalog carrying the group with a non-empty canonical topic must resolve rather than refuse");
  });
});

// The redaction contract, one row per URL shape, each fixed to the exact string the platform's URL parser produces. The list covers the shapes that defeated
// authored credential patterns during design - a password containing "@", an empty username, a colon inside the password, a bracketed IPv6 host, a username
// carrying the "$&" sequence a string-valued replacement would interpret - plus the two schemes WHATWG treats as special, whose canonical re-serialization elides a
// default port, lowercases the host, and adds a trailing slash.
const REDACTION_FIXTURES: readonly { expected: string; input: string }[] = [

  { expected: "mqtt://user:REDACTED@host:1883", input: "mqtt://user:pass@host:1883" },
  { expected: "mqtts://user:REDACTED@host:8883", input: "mqtts://user:pass@host:8883" },
  { expected: "mqtt://host", input: "mqtt://host" },
  { expected: "mqtt://user:REDACTED@host", input: "mqtt://user:P@ssw0rd@host" },
  { expected: "mqtt://:REDACTED@host", input: "mqtt://:pass@host" },
  { expected: "mqtt://user:@host", input: "mqtt://user:@host" },
  { expected: "mqtt://user:REDACTED@host", input: "mqtt://user:pa:ss@host" },
  { expected: "mqtt://user:REDACTED@[::1]:1883", input: "mqtt://user:pass@[::1]:1883" },
  { expected: "ws://user:REDACTED@broker.example.com/", input: "ws://user:pass@broker.example.com:80" },
  { expected: "wss://user:REDACTED@host.example.com/", input: "wss://user:pass@Host.Example.com" },
  { expected: "mqtt://us$&er:REDACTED@host", input: "mqtt://us$&er:pass@host" },
  { expected: "<broker URL redacted>", input: "not-a-valid-url" }
];

describe("redactBrokerUrl / redactKnownBrokerUrl - credential excision", () => {

  test("every broker URL shape redacts to its exact form", () => {

    for(const fixture of REDACTION_FIXTURES) {

      assert.equal(redactBrokerUrl(fixture.input), fixture.expected, fixture.input);
    }
  });

  test("no password fragment survives, whatever shape the password takes", () => {

    // The parser takes the LAST "@" as the userinfo boundary, so "P@ssw0rd" is the password in full rather than a password of "P" with a stray tail, and a colon
    // inside the password is password text rather than the start of a new field. Both shapes leave nothing behind.
    assert.ok(!redactBrokerUrl("mqtt://user:P@ssw0rd@host").includes("ssw0rd"));
    assert.ok(redactBrokerUrl("mqtt://user:P@ssw0rd@host").includes("REDACTED"));
    assert.ok(!redactBrokerUrl("mqtt://:pass@host").includes("pass"));
    assert.ok(redactBrokerUrl("mqtt://:pass@host").includes("REDACTED"));
    assert.ok(!redactBrokerUrl("mqtt://user:pa:ss@host").includes("pa:"));
    assert.ok(redactBrokerUrl("mqtt://user:pa:ss@host").includes("REDACTED"));
  });

  test("a known URL is excised from surrounding text wherever it appears", () => {

    const brokerUrl = "mqtt://user:pass@host:1883";
    const text = "first " + brokerUrl + "\nsecond " + brokerUrl + "\ndone";

    // Every occurrence goes, not just the first - an error chain is free to quote the URL more than once.
    assert.equal(redactKnownBrokerUrl(text, brokerUrl), "first mqtt://user:REDACTED@host:1883\nsecond mqtt://user:REDACTED@host:1883\ndone");
    assert.equal(redactKnownBrokerUrl("nothing to see here", brokerUrl), "nothing to see here");
  });

  test("a URL carrying a $-sequence is excised rather than re-injected", () => {

    // A string-valued replaceAll would interpret the "$&" in the replacement and paste the original credentialed URL back into the text. Splitting on the literal
    // and joining with the redacted form gives the substring no interpretation at all, so the credential actually leaves.
    const brokerUrl = "mqtt://us$&er:pass@host";
    const text = "connecting to " + brokerUrl + " now";

    assert.equal(redactKnownBrokerUrl(text, brokerUrl), "connecting to mqtt://us$&er:REDACTED@host now");
    assert.ok(!redactKnownBrokerUrl(text, brokerUrl).includes("pass@"));
  });
});

describe("createMqttClient - guarded construction", () => {

  test("an absent broker URL or topic prefix returns null and logs nothing", () => {

    // MQTT being unconfigured, or its topic explicitly disabled, is the ordinary off state rather than an event...a helper that logged here would put a line in
    // every log stream belonging to a user who simply does not use MQTT.
    for(const brokerUrl of [ undefined, null, "" ]) {

      const log = capturingLog();

      assert.equal(createMqttClient({ brokerUrl, log, topicPrefix: "test" }), null, "broker URL: " + String(brokerUrl));
      assert.equal(log.entries.length, 0, "an unconfigured broker must not log");
    }

    for(const topicPrefix of [ undefined, null, "" ]) {

      const log = capturingLog();

      assert.equal(createMqttClient({ brokerUrl: UNREACHABLE_BROKER, log, topicPrefix }), null, "topic prefix: " + String(topicPrefix));
      assert.equal(log.entries.length, 0, "a disabled topic must not log");
    }
  });

  test("an unusable broker URL returns null and logs exactly one error", () => {

    const log = capturingLog();

    // Prove the throw here rather than assuming it. Were this literal ever to stop throwing, the helper assertion below would pass for the wrong reason - a
    // well-formed-but-unreachable URL constructs happily and would return a client, not null.
    assert.throws(() => new MqttClient({ brokerUrl: "not-a-valid-url", log: silentLog(), topicPrefix: "test" }));

    assert.equal(createMqttClient({ brokerUrl: "not-a-valid-url", log, topicPrefix: "test" }), null);
    assert.equal(log.entries.length, 1, "a construction failure logs once");

    const [entry] = log.entries;

    assert.ok(entry);
    assert.equal(entry.level, "error", "a construction failure is an error, not a warning");
  });

  test("a credentialed broker URL that throws logs the cause without the credential", () => {

    // This exact input is what gives the assertion its teeth: it throws synchronously AND mqtt.js quotes the configured URL verbatim in the error chain, so the redaction
    // path is genuinely exercised. A plain invalid URL throws without ever naming the URL, and a well-formed credentialed URL does not throw at all.
    const brokerUrl = "mqtt://user:secret123@:::bad::port";
    const log = capturingLog();

    assert.throws(() => new MqttClient({ brokerUrl, log: silentLog(), topicPrefix: "test" }));

    assert.equal(createMqttClient({ brokerUrl, log, topicPrefix: "test" }), null);
    assert.equal(log.entries.length, 1);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("ERR_INVALID_ARG_VALUE"), "the underlying cause must survive into the log line");
    assert.ok(!rendered.includes("secret123"), "the configured credential must never reach the log stream");
    assert.ok(rendered.includes("<broker URL redacted>"), "an unparseable URL is replaced by the placeholder");
  });

  test("a usable configuration returns a live client and forwards init to the constructor", async () => {

    await using broker = await startTestBroker();

    const controller = new AbortController();
    const log = capturingLog();
    const client = createMqttClient({ brokerUrl: broker.url, log, reconnectInterval: 0, topicPrefix: "test" }, { signal: controller.signal });

    assert.ok(client, "a usable configuration must produce a client, never null");
    assert.ok(client instanceof MqttClient);

    await awaitConnect(broker);

    assert.equal(client.aborted, false);

    // Aborting the signal we handed the helper ends the client, which can only happen if `init` reached the constructor - a helper that dropped it would leave the
    // client live here.
    controller.abort();

    assert.equal(client.aborted, true);
  });
});

describe("MqttClient - the unresolved-placeholder refusal", () => {

  // A tail a plugin declared as a template and never resolved. Nothing in the family's own catalogs carries a brace, so this shape only ever reaches the client
  // through the widened declaration form, which is exactly the case the compile-time guard cannot see.
  const UNRESOLVED = "relay/{output}/state";

  test("publish rejects with the refusal, ahead of the offline posture and before anything reaches the wire", async () => {

    // The client here has no session at all, so the offline refusal is armed and waiting. The brace refusal answering instead is what proves it sits ahead of the
    // expansion and the connection reading.
    await using client = makeClient();

    await assert.rejects(client.publish(UNRESOLVED, "on"),
      /^Error: MqttClient: the topic "relay\/\{output\}\/state" carries a brace; a placeholder must be resolved through resolveMqttTopic before the topic is used\.$/);
    assert.equal(client.connected, false);
  });

  test("publishGuarded never throws and reports the refusal on one error line naming the expanded topic", async () => {

    await assertNoUnhandledRejections(async () => {

      // A live broker, so the only error line the log can carry is the one the refusal produced.
      await using broker = await startTestBroker();
      const log = capturingLog();

      await using client = makeClient({ brokerUrl: broker.url, log });

      await awaitClientConnected(client);

      assert.doesNotThrow(() => client.publishGuarded(UNRESOLVED, "on"), "the guarded form answers in the log, never to the caller");

      await waitForLog(log, (entry) => entry.level === "error");

      const failures = log.entries.filter((entry) => entry.level === "error").map((entry) => formatLogEntry(entry));

      assert.deepEqual(failures, ["Unable to publish to the MQTT topic test/relay/{output}/state: MqttClient: the topic \"relay/{output}/state\" carries a brace; " +
        "a placeholder must be resolved through resolveMqttTopic before the topic is used."]);
    });
  });

  test("subscribe, subscribeGet, subscribeSet, and unsubscribe throw synchronously with the refusal", async () => {

    await using client = makeClient();

    const refusal = /^Error: MqttClient: the topic "relay\/\{output\}(\/state)?(\/get|\/set)?" carries a brace;/;

    assert.throws(() => client.subscribe(UNRESOLVED, () => { /* Never registered. */ }), refusal);
    assert.throws(() => client.subscribeGet("relay/{output}", "relay", () => "on"), refusal);
    assert.throws(() => client.subscribeSet("relay/{output}", "relay", () => { /* Never registered. */ }), refusal);
    assert.throws(() => client.unsubscribe("device1", UNRESOLVED), refusal);
  });

  test("leaves a brace-free tail alone on every verb", async () => {

    // The floor: the refusal is a check on a shape no family tail carries, so every ordinary path answers exactly as it did before it.
    await using client = makeClient();

    assert.doesNotThrow(() => client.subscribe("relay/1/state", () => { /* Registered. */ }));
    assert.doesNotThrow(() => client.subscribeGet("relay/1", "relay", () => "on"));
    assert.doesNotThrow(() => client.subscribeSet("relay/1", "relay", () => { /* Registered. */ }));
    assert.doesNotThrow(() => client.unsubscribe("device1", "relay/1/state"));
  });

  test("answers after the abort and empty-id guards, so a torn-down client and an empty id stay no-ops", async () => {

    // The ordering contract. The refusal is a diagnostic for a live client; a client that has already been torn down keeps the silence its own documentation
    // promises, and an empty id short-circuits before anything is inspected.
    const client = makeClient();

    client.abort();

    const reason = await client.publish(UNRESOLVED, "on").then(() => null, (error: unknown) => error);

    assert.ok(isHbpuAbortReason(reason, "shutdown"), "an aborted client rejects with its own abort reason rather than the refusal, observed: " + String(reason));
    assert.doesNotThrow(() => client.subscribe(UNRESOLVED, () => { /* Never reached. */ }), "subscribe on an aborted client stays a no-op");
    assert.doesNotThrow(() => client.unsubscribe("device1", UNRESOLVED), "unsubscribe on an aborted client stays a no-op");

    await using live = makeClient();

    assert.doesNotThrow(() => live.unsubscribe("", UNRESOLVED), "an empty id short-circuits ahead of the refusal");
  });
});
