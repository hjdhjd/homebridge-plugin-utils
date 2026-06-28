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
 * MQTT testing now joins that family: real `mqtt.connect()` over real TCP loopback to a real (in-process) broker. Drift risk against mqtt.js's evolving API is
 * structurally eliminated - aedes and mqtt.js are co-developed by the same maintainers, and this helper interacts with both through their stable public surfaces.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see `typedoc.json`)
 * so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import type { AddressInfo, Server } from "node:net";
import type { CapturingLog, TestLogEntry } from "./testing.helpers.ts";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { format } from "node:util";
import { once } from "node:events";

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
 * Start an in-process MQTT broker on an ephemeral localhost port and return a {@link TestBroker} handle. The broker accepts the real MQTT v3.1.1 wire protocol;
 * `MqttClient` instances constructed against the returned URL communicate with it through real `mqtt.connect()` over real TCP.
 *
 * The broker binds to `127.0.0.1:0` so the OS assigns an unused port - no port conflicts across parallel test files, no manual port management. Each test should start
 * its own broker (the `await using` scope makes this trivial) so subscription state is isolated per test; the cost of broker startup on localhost is sub-millisecond
 * and dominated by the kernel's TCP-listen path.
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
export async function startTestBroker(): Promise<TestBroker> {

  const aedes = await Aedes.createBroker();
  const server: Server = createServer(aedes.handle);

  // Bind to an OS-assigned ephemeral port on the loopback interface. `0` lets the kernel pick an unused port, avoiding cross-file collisions when test runners
  // parallelize. We resolve only after `listen` reports success so the `url` field below is guaranteed to reflect a bound port.
  await new Promise<void>((resolve, reject) => {

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {

      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;

  return {

    aedes,
    url: "mqtt://127.0.0.1:" + port.toString(),
    [Symbol.asyncDispose]: async (): Promise<void> => {

      // Close the aedes broker first so it disconnects any still-live clients cleanly through the protocol layer (CONNACK-tracked sessions get a proper close), then
      // close the underlying TCP server so the listening socket is released. The two stages are sequential rather than parallel because aedes drives close events on
      // the connections it owns, and those events need the server's IO surface to flush before the server itself is torn down.
      await new Promise<void>((resolve) => aedes.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

/**
 * Recorded entry produced by {@link recordClientPublishes}. Captures the topic and the payload bytes (rendered as a UTF-8 string for ergonomic deepEqual assertions).
 */
export interface PublishRecord {

  payload: string;
  topic: string;
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
 * Handle returned by {@link recordClientPublishes}. Bundles the live `entries` array (filtered to client-originated publishes; broker-injected publishes have a null
 * client and are excluded) with `awaitFirst()`, a Promise that resolves on the first observed client publish - the synchronization point most tests use to wait for
 * an outbound publish to round-trip without having to know the trigger event's broker-event sequence.
 *
 * @property awaitFirst - Resolves on the first client-originated publish observed by the broker.
 * @property entries    - Live array of recorded publishes. New entries are appended as client publishes fire on the broker.
 */
export interface ClientPublishRecorder {

  awaitFirst: Promise<void>;
  readonly entries: PublishRecord[];
}

/**
 * Install a `publish` listener on `broker.aedes` that records ONLY client-originated PUBLISH packets, and returns a recorder bundling the live entries with a
 * "first publish observed" Promise. Aedes fires this event for two distinct sources: client publishes (`client` is the originating mqtt.js client) and broker-
 * injected publishes (`client` is null - emitted in response to `broker.aedes.publish(...)` test triggers). Recording only the client-originated stream lets tests
 * assert on outbound publishes from the {@link MqttClient} without conflating them with the broker-side trigger that often precedes them.
 *
 * @param broker - The handle returned by {@link startTestBroker}.
 *
 * @returns A {@link ClientPublishRecorder} - an entries array plus a Promise that resolves on the first observed client publish.
 */
export function recordClientPublishes(broker: TestBroker): ClientPublishRecorder {

  const entries: PublishRecord[] = [];
  const first: PromiseWithResolvers<void> = Promise.withResolvers();

  broker.aedes.on("publish", (packet, aedesClient) => {

    if(!aedesClient) {

      return;
    }

    entries.push({ payload: (packet.payload as Buffer).toString(), topic: packet.topic });
    first.resolve();
  });

  return { awaitFirst: first.promise, entries };
}

/**
 * Wait until `log` contains an entry matching `predicate`, or fail with a timeout error. Replaces blind `await delay(N)` patterns where the test is genuinely
 * waiting for an async log line to materialize - polling-with-deadline is honest about what's being awaited (a specific log entry) and fails loudly when the
 * expectation is not met within `timeoutMs` instead of silently passing on the absence of evidence.
 *
 * @param log       - Capturing logger to scan.
 * @param predicate - Predicate that selects the entry the test is waiting for.
 * @param timeoutMs - Maximum total wait time, in milliseconds. Defaults to 1000 - a comfortable margin for localhost-loopback log timing on slow CI runners.
 *
 * @throws `Error` if no matching entry is observed within `timeoutMs`.
 */
export async function waitForLog(log: CapturingLog, predicate: (entry: TestLogEntry) => boolean, timeoutMs = 1000): Promise<void> {

  const POLL_INTERVAL_MS = 5;
  const deadline = Date.now() + timeoutMs;

  while(Date.now() < deadline) {

    if(log.entries.some(predicate)) {

      return;
    }

    // The poll-with-deadline pattern is intentionally sequential - we cannot batch parallel awaits when each iteration's check depends on real-elapsed time. The
    // standard ESLint guidance against `await` in loops applies to throughput-sensitive batches; this is an upper-bounded synchronization helper, not a workload.
    // eslint-disable-next-line no-await-in-loop
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error("waitForLog: no matching log entry observed within " + timeoutMs.toString() + "ms.");
}

/**
 * Predicate factory for {@link waitForLog} (and other entry-scanning assertions) that matches a log entry whose interpolated message - format string fed through
 * `node:util.format` with its params - contains `substring`. Centralizing the rendering rule here means every test that asks "did the log emit a line mentioning X"
 * gets the same answer through one well-defined site, rather than reconstructing the message-plus-params interpolation by hand at every assertion.
 *
 * @param substring - The text fragment to search for in the rendered log line.
 *
 * @returns A predicate suitable for {@link waitForLog} or `Array.prototype.some`.
 */
export function logContains(substring: string): (entry: TestLogEntry) => boolean {

  return (entry) => format(entry.message, ...entry.params).includes(substring);
}
