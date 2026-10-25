/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.helpers.ts: Real-broker test substrate for the MqttClient test suite.
 */

/**
 * Real-broker test substrate for the {@link MqttClient} test suite.
 *
 * {@link startTestBroker} starts an in-process MQTT broker on an ephemeral localhost port using `aedes` (the canonical Node-ecosystem in-process broker, co-maintained
 * with mqtt.js). Tests construct a real `MqttClient` against the returned URL; the broker speaks the real MQTT v3.1.1 wire protocol, fans out PUBLISH messages to
 * subscribers, and surfaces aedes's full event stream (`subscribe`, `unsubscribe`, `publish`, `clientReady`, `clientDisconnect`) for test-side observation. There is no
 * mqtt-shaped "fake client" parallel; the broker is the protocol, the protocol is the test.
 *
 * The pattern matches HBPU's house style for testing subsystems with external substrates:
 * - `FfmpegProcess` tests substitute the binary via `process.execPath` (real spawn, scripted Node).
 * - `RtpDemuxer` tests bind real UDP sockets on localhost ephemeral ports (real wire, real OS networking).
 * - `webUiFeatureOptions` tests run against happy-dom (real DOM API surface).
 *
 * MQTT testing follows the same real-substrate pattern: real `mqtt.connect()` over TCP loopback to an in-process broker. Drift risk against mqtt.js's evolving API is
 * structurally eliminated - aedes and mqtt.js are co-developed by the same maintainers, and this helper interacts with both through their stable public surfaces.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see `typedoc.json`)
 * so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import type { CapturingLog, TestLogEntry } from "./testing/index.ts";
import { formatLogEntry, listenOnLoopback, stopListening, waitUntil } from "./testing/index.ts";
import { Aedes } from "aedes";
import type { MqttClient } from "./mqttClient.ts";
import type { Server } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";

// The rows behind `waitForLog` and `awaitClientConnected` drive a real in-process broker or a real TCP socket, and under the parallel full-suite run those
// waits pay OS scheduling and event-loop contention that an in-memory wait never sees...the shared `waitUntil` default is the right floor for in-memory
// state, not for a socket round trip. This deadline sits well inside the per-test budget, so a row that waits twice still fits with room to spare.
const REAL_BROKER_WAIT_MS = 5000;

/**
 * Handle returned by {@link startTestBroker}. Implements `AsyncDisposable` so test sites can use the canonical `await using broker = await startTestBroker()` idiom for
 * scope-bound teardown - identical in shape to HBPU's other lifetime-managed test substrates (`RtpDemuxer`, `FfmpegProcess`).
 *
 * @property aedes - The underlying aedes broker instance. Tests use this for wire-level observation (`aedes.on("subscribe" | "publish" | ...)`), for injecting messages
 *                   to subscribers (`aedes.publish({ ... })`), and for installing aedes hooks (`aedes.authorizePublish = ...`) when a test needs to simulate
 *                   broker-side behavior like rejecting a publish.
 * @property url   - The `mqtt://127.0.0.1:<ephemeral-port>` URL the broker is listening on. Pass this to `MqttClient` as `brokerUrl`.
 */
export interface TestBroker extends AsyncDisposable {

  readonly aedes: Aedes;
  readonly url: string;
}

/**
 * Start an in-process MQTT broker on a localhost port - ephemeral unless the caller names one - and return a {@link TestBroker} handle. The broker accepts the real
 * MQTT v3.1.1 wire protocol; `MqttClient` instances constructed against the returned URL communicate with it through real `mqtt.connect()` over real TCP.
 *
 * The broker binds to `127.0.0.1:0` by default so the OS assigns an unused port - no port conflicts across parallel test files, no manual port management. Each test
 * should start its own broker (the `await using` scope makes this trivial) so subscription state is isolated per test; the cost of broker startup on localhost is
 * sub-millisecond and dominated by the kernel's TCP-listen path.
 *
 * Passing a fixed `port` is what lets a test bring a broker back on the address a client is already reconnecting to, which is the only way to observe a recovery
 * end to end: the client is holding that address, so a fresh ephemeral port would leave it reconnecting to nothing.
 *
 * @param options      - Optional broker options.
 * @param options.port - The port to listen on. Defaults to `0`, which asks the kernel for an unused one.
 *
 * @returns A {@link TestBroker} ready to accept connections. Disposal closes the aedes broker (which disconnects all live clients), then closes the underlying TCP
 *          server.
 *
 * @example
 *
 * ```ts
 * await using broker = await startTestBroker();
 * await using client = new MqttClient({ brokerUrl: broker.url, log: silentLog(), topicPrefix: "test" });
 *
 * client.subscribe("device1/status", (payload) => console.log(payload.toString()));
 *
 * // Inject a message via the broker - mqtt.js delivers it to the subscribed handler over the real wire.
 * broker.aedes.publish({ cmd: "publish", dup: false, qos: 0, retain: false, topic: "test/device1/status", payload: Buffer.from("on") }, () => { });
 * ```
 */
export async function startTestBroker(options: { port?: number } = {}): Promise<TestBroker> {

  const aedes = await Aedes.createBroker();
  const server: Server = createServer(aedes.handle);

  // Bind on the loopback interface, at the port the caller named or - by default - at `0`, which lets the kernel pick an unused one and avoids cross-file collisions
  // when test runners parallelize. We resolve only after `listen` reports success so the `url` field below is guaranteed to reflect a bound port.
  const port = await listenOnLoopback(server, options.port);

  return {

    aedes,
    url: "mqtt://127.0.0.1:" + port.toString(),
    [Symbol.asyncDispose]: async (): Promise<void> => {

      // Close the aedes broker first so it disconnects any still-live clients cleanly through the protocol layer (CONNACK-tracked sessions get a proper close), then
      // close the underlying TCP server so the listening socket is released. Each teardown step runs sequentially rather than in parallel because aedes drives close
      // events on the connections it owns, and those events need the server's IO surface to flush before the server itself is torn down.
      await new Promise<void>((resolve) => aedes.close(() => resolve()));
      await stopListening(server);
    }
  };
}

/**
 * Recorded entry produced by {@link recordClientPublishes} and by {@link recordRetainedStoreCompletions}. Captures the topic, the payload bytes (rendered as a UTF-8
 * string for ergonomic deepEqual assertions), and the packet's retain flag, which is what lets a row tell a statement the broker keeps for a late subscriber apart
 * from an ordinary event. Every member is written once, when the packet is captured, and never again.
 */
export interface PublishRecord {

  readonly payload: string;
  readonly retain: boolean;
  readonly topic: string;
}

/**
 * Wait for `broker` to observe a successful CONNECT handshake from any client. Returns when aedes fires `clientReady` for the next connecting mqtt.js client - the
 * deterministic synchronization point most tests use to confirm "the MqttClient under test has finished its CONNACK round trip."
 *
 * @param broker - The handle returned by {@link startTestBroker}.
 *
 * @returns A promise that resolves when the next `clientReady` event fires.
 */
export async function awaitConnect(broker: TestBroker): Promise<void> {

  await once(broker.aedes, "clientReady");
}

/**
 * Wait until `client` reports that it holds a broker session, or fail with a timeout error.
 *
 * This is the client-side counterpart to {@link awaitConnect}, and the two are not interchangeable. `awaitConnect` resolves on aedes's `clientReady`, which the
 * broker emits while it is still handling the CONNECT - before the client has parsed the CONNACK back off the socket and set its own flag. A test that publishes
 * immediately after it therefore reaches the client's offline pre-check while the client still reports no session, and the publish is refused. Waiting on the
 * client's own getter waits on exactly the reading the pre-check consults, so a publish that follows it is issued against a live session.
 *
 * @param client    - The client under test.
 * @param timeoutMs - Maximum total wait time, in milliseconds. Defaults to `REAL_BROKER_WAIT_MS`.
 *
 * @throws `Error` if the client does not report a session within `timeoutMs`.
 */
export async function awaitClientConnected(client: MqttClient, timeoutMs = REAL_BROKER_WAIT_MS): Promise<void> {

  return waitUntil(() => client.connected, { description: "the client to hold a broker session", timeoutMs });
}

/**
 * Install a `subscribe` listener on `broker.aedes` and return an array that auto-populates with every subscribed topic the broker observes, in order. Tests use the
 * returned reference for `assert.deepEqual` checks against expected wire-level subscribe activity.
 *
 * @param broker - The handle returned by {@link startTestBroker}.
 *
 * @returns A live array of subscribed topic names. New entries are appended as subscribe events fire on the broker.
 */
export function recordSubscribes(broker: TestBroker): string[] {

  const subscribed: string[] = [];

  broker.aedes.on("subscribe", (subscriptions) => {

    for(const subscription of subscriptions) {

      subscribed.push(subscription.topic);
    }
  });

  return subscribed;
}

/**
 * Install an `unsubscribe` listener on `broker.aedes` that records ONLY wire-level UNSUBSCRIBE packets - the events fired while the originating client is still
 * connected. Aedes also fires this event during disconnect cleanup (with `client.connected === false`) as broker bookkeeping for the dropped subscriptions; those
 * events are NOT wire packets the {@link MqttClient} sent and must not be conflated with intentional unsubscribes. Centralizing the filter here means every test
 * that asks "did the client send wire-level UNSUBSCRIBEs" gets the same answer through one well-commented site.
 *
 * @param broker - The handle returned by {@link startTestBroker}.
 *
 * @returns A live array of wire-level UNSUBSCRIBE topic names.
 */
export function recordWireUnsubscribes(broker: TestBroker): string[] {

  const wire: string[] = [];

  broker.aedes.on("unsubscribe", (unsubscriptions, aedesClient) => {

    if(!aedesClient.connected) {

      return;
    }

    wire.push(...unsubscriptions);
  });

  return wire;
}

/**
 * Handle returned by {@link recordClientPublishes} and by {@link recordRetainedStoreCompletions}. Bundles the live `entries` array (filtered to client-originated,
 * authorized PUBLISH packets; broker-injected
 * publishes never reach this instrument at all, since {@link https://github.com/moscajs/aedes | aedes}'s `authorizePublish` hook is invoked only from the wire-level
 * PUBLISH handler and the will's own teardown path, never from `Aedes.prototype.publish()`'s direct-injection form). A row waits on the entry it means by polling
 * this array through the shared `waitUntil`, which is what lets it name the publish it is waiting for rather than a position in a sequence.
 *
 * @property entries - Live array of recorded publishes, in true packet-arrival order. New entries are appended as client publishes arrive at the broker.
 */
export interface ClientPublishRecorder {

  readonly entries: PublishRecord[];
}

/**
 * Install a hook on `broker.aedes.authorizePublish` that records every authorized, client-originated PUBLISH packet in true packet-arrival order, and returns a
 * recorder holding the live entries a row waits on.
 *
 * `authorizePublish` runs synchronously as `handlePublish` parses each PUBLISH packet off a client's stream (and, separately, as a disconnecting client's own will
 * is provoked), strictly ahead of aedes's `storeRetained` / `emitPacket` / `callPublished` pipeline. That pipeline's own `"publish"` EventEmitter event fires only
 * once a packet's pipeline completes, and a retained packet's pipeline takes an extra asynchronous persistence hop
 * (`node_modules/aedes/aedes.js:277-284`) a non-retained packet's pipeline skips, so that event can fire out of true arrival order whenever a retained and a
 * non-retained publish race in the same synchronous turn. Recording at `authorizePublish` instead reports the order packets actually reached the broker in, which
 * is the order every consumer means when it reads `entries` as an ordered record of what a plugin published.
 *
 * The hook delegates to whatever `authorizePublish` was already installed (the aedes default, or a row's own override), captured once at call time and invoked with
 * the broker as receiver, so installing this recorder never changes what the broker authorizes - it observes the same verdict every other consumer of the hook
 * would have gotten. A packet the delegate rejects is not recorded, which keeps the record to the publishes the broker accepted. That slot holds one function
 * rather than a list of listeners, so a row wanting a verdict of its own installs it BEFORE calling this and lets the recorder capture it as the delegate;
 * assigning the slot afterwards replaces the hook and silences the recording.
 *
 * One row - "a late subscriber reads the retained statement off the broker" - does not use this function: it needs the guarantee that the retained store is
 * durably written before it opens a second subscriber, which only the pipeline-completion event can give, and uses {@link recordRetainedStoreCompletions}
 * instead.
 *
 * @param broker - The handle returned by {@link startTestBroker}.
 *
 * @returns A {@link ClientPublishRecorder} - an entries array, in arrival order.
 */
export function recordClientPublishes(broker: TestBroker): ClientPublishRecorder {

  const entries: PublishRecord[] = [];
  const delegate = broker.aedes.authorizePublish;

  broker.aedes.authorizePublish = (client, packet, callback): void => {

    delegate.call(broker.aedes, client, packet, (error?: Error | null) => {

      if(!error && client) {

        // The packet's `payload` field is typed as `Buffer | string` to accommodate locally-constructed publish packets, but a packet arriving through this hook
        // was parsed off the wire by mqtt-packet, which slices the payload directly out of the incoming byte stream as a Buffer - the string branch never applies
        // to a client-originated publish.
        entries.push({ payload: (packet.payload as Buffer).toString(), retain: packet.retain, topic: packet.topic });
      }

      callback(error);
    });
  };

  return { entries };
}

/**
 * Install a `publish` listener on `broker.aedes` that records ONLY client-originated PUBLISH packets, in the order aedes's own pipeline completes them rather than
 * the order they arrived in. It exists for the one row that means "the broker's retained store durably holds this," a guarantee only the
 * pipeline-completion event gives: aedes runs `storeRetained` and only then emits `"publish"` (`node_modules/aedes/aedes.js:277-284`, `:348-357`), and the retained
 * replay a late subscriber reads comes out of that same store, so this event firing is proof the store has the entry, where {@link recordClientPublishes}'s arrival
 * order is not - a subscribe issued on arrival-order timing could still race the store write and find nothing retained.
 *
 * Every other row - one that means "what did the plugin publish, and in what order" rather than "has the broker's retained store been written yet" - uses
 * {@link recordClientPublishes} instead.
 *
 * @param broker - The handle returned by {@link startTestBroker}.
 *
 * @returns A {@link ClientPublishRecorder} - an entries array, in pipeline-completion order.
 */
export function recordRetainedStoreCompletions(broker: TestBroker): ClientPublishRecorder {

  const entries: PublishRecord[] = [];

  broker.aedes.on("publish", (packet, aedesClient) => {

    if(!aedesClient) {

      return;
    }

    entries.push({ payload: (packet.payload as Buffer).toString(), retain: packet.retain, topic: packet.topic });
  });

  return { entries };
}

/**
 * Wait until `log` contains an entry matching `predicate`, or fail with a timeout error. The log-scoped face of {@link waitUntil}: all it adds over the shared poll
 * is the scan across the captured entries, which is what lets a test name the line it is waiting for rather than the shape of the wait.
 *
 * @param log       - Capturing logger to scan.
 * @param predicate - Predicate that selects the entry the test is waiting for.
 * @param timeoutMs - Maximum total wait time, in milliseconds. Defaults to `REAL_BROKER_WAIT_MS`, sized for a real-socket round trip under a loaded suite.
 *
 * @throws `Error` if no matching entry is observed within `timeoutMs`.
 */
export async function waitForLog(log: CapturingLog, predicate: (entry: TestLogEntry) => boolean, timeoutMs = REAL_BROKER_WAIT_MS): Promise<void> {

  return waitUntil(() => log.entries.some(predicate), { description: "a matching log entry", timeoutMs });
}

/**
 * Predicate factory for {@link waitForLog} (and other entry-scanning assertions) that matches a log entry whose line, rendered through {@link formatLogEntry},
 * contains `substring`. Rendering through the testing entry's one rendering definition means every test that asks "did the log emit a line mentioning X" gets the
 * answer the shared finders give, rather than reconstructing the message-plus-params interpolation by hand at every assertion.
 *
 * @param substring - The text fragment to search for in the rendered log line.
 *
 * @returns A predicate suitable for {@link waitForLog} or `Array.prototype.some`.
 */
export function logContains(substring: string): (entry: TestLogEntry) => boolean {

  return (entry) => formatLogEntry(entry).includes(substring);
}

// Render the first entry of `log` as a single interpolated string, matching how a real logger would print the entry. Asserts that at least one entry exists so a
// regression that silently swallows the log call fails loudly here rather than producing a misleading empty-string match.
export function firstRendered(log: CapturingLog): string {

  const [entry] = log.entries;

  assert.ok(entry, "expected at least one log entry to have been emitted");

  return formatLogEntry(entry);
}
