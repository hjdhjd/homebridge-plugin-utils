/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqttClient.test.ts: Unit tests for the AsyncDisposable MqttClient - composed connection lifetime, signal-driven publish / subscribe semantics, subscribeSet handler-
 * timeout, transport-error routing, and AsyncDisposable wiring. Tests run against a real in-process aedes broker on an ephemeral localhost port (the same architectural
 * pattern the rest of HBPU uses for tests of subsystems that wrap external substrates - real spawn for FfmpegProcess, real UDP for RtpDemuxer, real DOM for the webUI).
 * Transport-level errno paths (ECONNREFUSED, ECONNRESET, ENOTFOUND) exercise real network failures; the error-routing switch is covered by direct invocation of the
 * pure {@link routeMqttBrokerError} helper, mirroring how `parseFfmpegCodecs` is tested directly with fixture strings while the spawn-end-to-end path is covered by
 * the FFmpeg integration suite that auto-enables when an FFmpeg binary is on PATH.
 */
import { HbpuAbortError, isHbpuAbortReason } from "./util.ts";
import { MqttClient, logGetterPublishOutcome, routeMqttBrokerError } from "./mqttClient.ts";
import { awaitConnect, logContains, recordClientPublishes, recordSubscribes, recordWireUnsubscribes, startTestBroker, waitForLog } from "./mqtt.helpers.ts";
import { capturingLog, silentLog } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import type { CapturingLog } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { format } from "node:util";
import { once } from "node:events";

// Render the first entry of `log` as a single interpolated string by feeding `(message, ...params)` through `node:util.format`, matching how a real logger would
// print the entry. Asserts that at least one entry exists so a regression that silently swallows the log call fails loudly here rather than producing a misleading
// empty-string match.
function firstRendered(log: CapturingLog): string {

  const [entry] = log.entries;

  assert.ok(entry, "expected at least one log entry to have been emitted");

  return format(entry.message, ...entry.params);
}

// Per-test event-loop settling window. After awaiting a deterministic broker event, this short delay lets any speculative-but-erroneous additional packet (the kind
// the de-dup tests assert is NOT issued) reach the broker before the assertion runs. 20ms is conservative against sub-millisecond localhost RTT - if a second
// subscribe / publish were on the wire it would arrive well within this window.
const SETTLE_MS = 20;

// Standard unreachable-broker URL for the construction tests that pin behavior on a non-listener: mqtt.js attempts to connect, the kernel returns ECONNREFUSED, and
// (because `reconnectInterval: 0`) does not retry. The client stays constructed, the connection stays down, and every test flow that does not require a live broker
// runs deterministically without standing one up.
const UNREACHABLE_BROKER = "mqtt://127.0.0.1:1";

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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const port = (server.address() as { port: number }).port;

  return {

    url: "mqtt://127.0.0.1:" + port.toString(),
    [Symbol.asyncDispose]: async (): Promise<void> => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
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

    // The constructor still invokes mqtt.js's `connect()` so `#mqtt` is a non-nullable invariant; the pre-aborted signal triggers `#teardown()` inline immediately
    // afterwards, which calls `mqtt.end(true)` and drops the in-flight connection attempt before any network work completes. Subsequent publishes reject with the
    // parent's reason - no broker round trip to race against.
    await assert.rejects(client.publish("topic", "msg"), (error: unknown) => error === reason);
  });

  test("invalid broker URL throws synchronously from the constructor with the underlying error as cause", () => {

    // The architectural contract: construction fails loudly for misconfiguration rather than silently producing a zombie client. Consumers wrap in try/catch if they
    // want graceful degradation. Discrimination is by `instanceof Error` + `cause` presence - never by the wrapper's message text - so the assertion remains stable
    // across message-wording changes, and the `cause` itself is the mqtt.js error the caller cares about for forensics.
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

  test("abort is idempotent", async () => {

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

  test("connection-level abort rejects in-flight publishes with signal.reason", async () => {

    const client = makeClient();

    // Issue the publish before abort. mqtt.js's internal publish sits queued against a non-connected socket; `waitWithSignal` rejects the returned promise as soon as
    // the client's signal fires.
    const pending = client.publish("topic", "msg");
    const reason = new HbpuAbortError("shutdown");

    client.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);
  });

  test("per-publish abort rejects the specific publish without killing the client", async () => {

    await using client = makeClient();

    const perPublish = new AbortController();
    const pending = client.publish("topic", "msg", { signal: perPublish.signal });
    const reason = new HbpuAbortError("replaced");

    perPublish.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);

    // Connection-level signal remains live - only this specific publish was cancelled.
    assert.equal(client.aborted, false);
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

    // Expected pattern: calls after teardown do not throw, they simply do nothing. Callers unwinding concurrently with teardown expect quiet idempotence.
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

    // Settle: any spurious additional subscribe packet (the bug this test pins) would arrive within the localhost window. Asserting after the settle proves the
    // single-subscribe contract.
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

    await using _client = makeClient({ brokerUrl: broker.url, log });

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

    await publishes.awaitFirst;

    assert.deepEqual(publishes.entries, [{ payload: "on", topic: "test/device1/switch" }],
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
    assert.deepEqual(publishes.entries, [], "no client-originated publish should occur when the trigger value does not match");
  });

  test("case-insensitive trigger: \"TRUE\" and mixed-case variants fire the getter", async () => {

    // `subscribeGet` lowercases the payload before comparison, so any casing of "true" triggers. This is the existing production behavior the test pins.
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

    // The critical invariant: multiple subscribers to the same topic are independent. Aborting one handler's signal must NOT unsubscribe the topic at the wire level
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
    // dispatch" invariant documented in `#wireMqttEvents`.
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

    await using _client = makeClient({ brokerUrl: UNREACHABLE_BROKER, log, reconnectInterval: 1 });

    await waitForLog(log, logContains("Connection refused"));
  });

  test("ECONNRESET logs \"Connection reset\" at error level (real reset server)", async () => {

    // A reset-on-accept TCP server produces ECONNRESET on the client side. mqtt.js receives the reset, emits an error event, HBPU routes it.
    await using resetServer = await startResetServer();
    const log = capturingLog();

    await using _client = makeClient({ brokerUrl: resetServer.url, log, reconnectInterval: 1 });

    await waitForLog(log, logContains("Connection reset"));
  });

  test("ENOTFOUND logs \"Hostname or IP address not found\" (real DNS failure)", async () => {

    // The `.invalid` TLD is reserved by RFC 2606 for unresolvable names; DNS lookups against it always fail with ENOTFOUND. mqtt.js sees the lookup error, emits an
    // error event, HBPU routes it to the standalone "Hostname or IP address not found" line and ends the transport (this is the one error code that is
    // non-recoverable through reconnect).
    const log = capturingLog();

    await using _client = makeClient({ brokerUrl: "mqtt://does-not-exist.invalid:1883", log, reconnectInterval: 1 });

    await waitForLog(log, logContains("Hostname or IP address not found"));
  });
});

describe("routeMqttBrokerError - pure function", () => {

  // The wiring tests above cover the connect-time ECONNREFUSED / ECONNRESET / ENOTFOUND paths through real network failures. The pure function tests below cover
  // the routing logic itself - including the `default` branch, which has no natural real-network analogue (no transport error in node:net produces an error without
  // an errno code). The function takes a synthetic error and returns the routing decision; tests assert against the captured log entries and the returned flag.

  function syntheticError(code?: string, message = "synthetic"): NodeJS.ErrnoException {

    const error: NodeJS.ErrnoException = new Error(message);

    if(code !== undefined) {

      error.code = code;
    }

    return error;
  }

  test("ECONNREFUSED returns endTransport: false and logs \"Connection refused\" with the retry cadence", () => {

    const log = capturingLog();
    const result = routeMqttBrokerError(syntheticError("ECONNREFUSED"), log, 60);

    assert.equal(result.endTransport, false);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Connection refused"), "log line must contain the \"Connection refused\" substring");
    assert.ok(rendered.includes("60"), "log line must include the configured reconnect interval");
  });

  test("ECONNRESET returns endTransport: false and logs \"Connection reset\"", () => {

    const log = capturingLog();
    const result = routeMqttBrokerError(syntheticError("ECONNRESET"), log, 60);

    assert.equal(result.endTransport, false);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Connection reset"));
  });

  test("ENOTFOUND returns endTransport: true and logs the standalone hostname-not-found line", () => {

    const log = capturingLog();
    const result = routeMqttBrokerError(syntheticError("ENOTFOUND"), log, 60);

    assert.equal(result.endTransport, true);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Hostname or IP address not found"));
    // The ENOTFOUND log line is standalone - no retry-cadence suffix - because reconnect cannot recover a bad hostname.
    assert.ok(!rendered.includes("Will retry again"), "ENOTFOUND must not include the retry-cadence suffix");
  });

  test("unknown error codes fall through to the default branch with util.inspect output", () => {

    const log = capturingLog();
    const result = routeMqttBrokerError(syntheticError("EWEIRD", "unfamiliar error"), log, 30);

    assert.equal(result.endTransport, false, "unknown errors do not imply end-permanently semantics - mqtt.js's reconnect retains control");

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Will retry again"), "unknown errors are still routed through the retry-cadence formatter");
    assert.ok(rendered.includes("unfamiliar error") || rendered.includes("EWEIRD"), "the inspected error payload must appear somewhere in the rendered log line");
  });

  test("errors with no .code at all fall through to the default branch (defensive coverage)", () => {

    // A bare Error without an errno code is shape-equivalent to "future mqtt.js error we did not anticipate." The default branch must still log it through the
    // retry-cadence formatter rather than silently swallowing or crashing.
    const log = capturingLog();
    const result = routeMqttBrokerError(syntheticError(undefined, "no code at all"), log, 60);

    assert.equal(result.endTransport, false);

    const rendered = firstRendered(log);

    assert.ok(rendered.includes("Will retry again"));
  });

  test("reconnect interval pluralization: 1 second is singular, others are plural", () => {

    // The retry-cadence suffix says "1 second" for interval 1 and "N seconds" for any other interval. Pin both branches.
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

describe("MqttClient - connect / close edge flag", () => {

  test("close without a prior connect is silent (no disconnect spam during initial retry loop)", async () => {

    // The edge-flag invariant: a close event only logs when we had previously connected. With the unreachable-broker URL, mqtt.js's connect attempt fails (logging
    // "Connection refused") and emits a close event without a preceding connect. HBPU's close handler must short-circuit on the close that follows. We use the
    // refused-log appearance as a deterministic synchronization point: it fires before the close event, so once it's observed we know the close-handler path has
    // also run - and we can then assert the silence we expect from the close path itself.
    const log = capturingLog();

    await using _client = makeClient({ brokerUrl: UNREACHABLE_BROKER, log, reconnectInterval: 0 });

    await waitForLog(log, logContains("Connection refused"));

    assert.equal(log.entries.some((entry) => entry.message.includes("Connection closed")), false,
      "close-without-connect must not log the \"Connection closed\" line");
  });

  test("connect then close logs the \"Connection closed\" line exactly once per cycle", async () => {

    // Stand up a real broker, let HBPU connect, then close the broker. The mqtt.js client observes the close event WITH a prior connect having fired, so HBPU's edge
    // flag is true and the disconnect log line is emitted exactly once.
    const broker = await startTestBroker();
    const log = capturingLog();

    await using _client = makeClient({ brokerUrl: broker.url, log, reconnectInterval: 0 });

    await awaitConnect(broker);

    await broker[Symbol.asyncDispose]();

    await waitForLog(log, logContains("Connection closed"));

    const closedLogs = log.entries.filter((entry) => entry.message.includes("Connection closed"));

    assert.equal(closedLogs.length, 1, "exactly one \"Connection closed\" log entry must fire per connect/close cycle");
  });

  test("connect logs the redacted broker URL (password-safe for status pages)", async () => {

    // Regex in the connect handler replaces `scheme://user:password@host` with `scheme://user:REDACTED@host` so a connected broker's URL never leaks credentials into
    // log output. This is an operational-safety invariant; aedes accepts arbitrary credentials by default, so the real broker honors the URL as-is.
    await using broker = await startTestBroker();
    const credentialedUrl = broker.url.replace("mqtt://", "mqtt://user:secretpass@");
    const log = capturingLog();

    await using _client = makeClient({ brokerUrl: credentialedUrl, log });

    await awaitConnect(broker);

    await waitForLog(log, logContains("Connected to"));

    const connectLog = log.entries.find((entry) => entry.message.includes("Connected to"));

    assert.ok(connectLog, "connect must emit the \"Connected to ...\" log line");

    const fullMessage = connectLog.message + " " + connectLog.params.map((param) => String(param)).join(" ");

    assert.ok(fullMessage.includes("REDACTED"), "the password segment of the broker URL must be redacted in the log output");
    assert.ok(!fullMessage.includes("secretpass"), "the raw password must never appear in any log line");
  });
});
