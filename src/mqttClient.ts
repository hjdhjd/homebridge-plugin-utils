/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqttClient.ts: Signal-driven MQTT client for Homebridge plugins.
 */

/**
 * AsyncDisposable MQTT client whose connection lifetime is a composed {@link AbortSignal}.
 *
 * The client wraps the underlying MQTT.js connection in the same lifetime shape every other long-lived resource class in this library uses: a composed
 * `AbortSignal`, a single `abort()` verb, and `Symbol.asyncDispose` for scope-bound ownership. Per-subscription and per-publish signals compose into the connection-
 * level signal so that tearing down a specific handler or cancelling a single publish unwinds cleanly without touching the rest of the client.
 *
 * Non-abort transient disconnects continue to trigger MQTT.js's own auto-reconnect - `abort()` is specifically "this client is done for good," not "pause until
 * further notice." Calling `abort()` (or letting a parent signal fire) ends the connection permanently via `mqtt.end(true)`, rejects any pending publishes with the
 * signal's reason, clears all subscription state, and makes every subsequent call a no-op.
 *
 * Construction fails loudly on invalid broker URLs: the constructor throws with the underlying mqtt.js error attached as `cause`, so a misconfigured plugin cannot
 * silently sit in a zombie state where every call either pretends to succeed or throws an unrelated abort error. Callers who want graceful degradation wrap the
 * `new MqttClient(...)` call in their own try/catch.
 *
 * @module
 */
import { HbpuAbortError, composeSignals, formatErrorMessage, markHandled, onAbort, runWithAbort, waitWithSignal } from "./util.ts";
import type { HomebridgePluginLogging } from "./util.ts";
import type { MqttClient as MqttJsClient } from "mqtt";
import { connect } from "mqtt";
import util from "node:util";

// Default reconnect interval, in seconds. A one-minute cadence gives a typical LAN broker (a mosquitto instance restarting or a brief network blip) time to come
// back without hammering it with reconnect attempts, while still recovering well within the timescale a user would notice as "the plugin is broken."
const MQTT_DEFAULT_RECONNECT_INTERVAL = 60;

// Module-scope success sentinel for `subscribeSet` handler invocations. `runWithAbort` returns `null` when its composed signal fires, so we use a sentinel to
// distinguish "user setter ran to completion" from "the invocation was cancelled." Hoisted once at module load rather than allocated per message, and declared as
// `unique symbol` so the typed comparison below keeps its narrowing precision.
const SUBSCRIBE_SET_OK: unique symbol = Symbol("mqtt:subscribeSet:ok");

/**
 * A handler for raw MQTT messages delivered on a subscribed topic.
 *
 * @param payload - The message payload as received from the broker.
 *
 * @category Utilities
 */
export type MqttHandler = (payload: Buffer) => Promise<void> | void;

/**
 * A handler invoked by {@link MqttClient.subscribeGet} when a "true" message arrives on the `/get` topic. Returns the current value as a string that will be published
 * on the parent topic as the response.
 *
 * @category Utilities
 */
export type MqttGetHandler = () => string;

/**
 * A handler invoked by {@link MqttClient.subscribeSet} when a value is received on the `/set` topic.
 *
 * Receives three arguments:
 *
 * - `value`    - the lowercased normalized form, convenient for comparisons against fixtures like `"true"` / `"on"`.
 * - `rawValue` - the raw message string, for cases where case or surrounding whitespace matters.
 * - `signal`   - an {@link AbortSignal} that aborts when the subscription's connection-level signal fires or (if configured) the per-invocation timeout elapses.
 *                Signal-aware setters forward this to any cancellation-capable API they call (`fetch`, `events.once`, `node:timers/promises`, etc.) so the setter's work
 *                actually stops when the wrapper times out. Setters that ignore the signal continue to run after timeout, but the subscription slot is released either
 *                way; nothing is structurally blocked by a hanging setter.
 *
 * **Log-routing contract.** How the setter settles determines which log line `subscribeSet` emits:
 *
 * - **Return normally** (work completed successfully) - logs INFO `"MQTT: set message received for X: value."`.
 * - **Throw a non-abort error** (work failed for a reason unrelated to cancellation) - logs ERROR `"MQTT: error setting X to value: message."`.
 * - **Throw while the composed signal is already aborted** (the connection-level abort or the per-invocation timeout, whichever fired first) - logs WARN
 *   `"MQTT: set handler for X was cancelled before completion."`, regardless of what value is thrown. A setter that catches its own abort and returns normally
 *   is indistinguishable to the wrapper from a successful completion, which is why a signal-aware setter that wants cancellation reflected in the log stream
 *   should rethrow once it observes the signal has aborted, rather than swallow it.
 *
 * @category Utilities
 */
export type MqttSetHandler = (value: string, rawValue: string, signal: AbortSignal) => Promise<void> | void;

/**
 * Static configuration for an {@link MqttClient}. Captures the broker connection parameters and the topic-prefix convention the client applies to every topic it
 * touches.
 *
 * @property brokerUrl         - The MQTT broker URL (for example, `"mqtt://localhost:1883"`).
 * @property log               - Logger used for connection and publish/subscribe tracing.
 * @property reconnectInterval - Seconds to wait between transient reconnect attempts. Defaults to 60.
 * @property topicPrefix       - Prefix prepended to every topic the client publishes or subscribes to. The caller is responsible for the remaining path structure;
 *                               this class never reinterprets the topic beyond concatenation.
 *
 * @category Utilities
 */
export interface MqttConfig {

  brokerUrl: string;
  log: HomebridgePluginLogging;
  reconnectInterval?: number;
  topicPrefix: string;
}

/**
 * Construction-time options for {@link MqttClient}.
 *
 * @property signal - Optional parent {@link AbortSignal} composed with the client's internal controller. When the parent aborts, the MQTT connection ends permanently.
 *
 * @category Utilities
 */
export interface MqttClientInit {

  signal?: AbortSignal;
}

/**
 * Result of routing a transport-level MQTT error through {@link routeMqttBrokerError}. Returned to the caller so the wiring layer (the `client.on("error", ...)`
 * handler in {@link MqttClient}) can apply the side effect on its own state. Keeping the routing pure - logging plus a flag - lets the routing logic be tested in
 * isolation against synthetic error inputs, without standing up a broker or injecting events into the underlying mqtt.js client.
 *
 * @property endTransport - `true` when the error code requires forcibly ending the underlying transport (the mqtt.js client should not attempt reconnect). Mirrors
 *                          the architectural rule that ENOTFOUND is the one transport error reconnect cannot recover from.
 *
 * @category Utilities
 */
export interface MqttBrokerErrorResult {

  endTransport: boolean;
}

/**
 * Route a transport-level MQTT error to the appropriate log line and signal whether the underlying transport should be ended. Pure function: no class state, no
 * mqtt.js handles, no closure over the live client. The wiring layer in {@link MqttClient} forwards every `client.on("error", ...)` invocation through here and acts
 * on the returned `endTransport` flag.
 *
 * The routing paths mirror the transport-error categories HBPU distinguishes:
 *
 * - `ECONNREFUSED` - the broker host is up but no listener accepts the connection. Recoverable; auto-reconnect handles it.
 * - `ECONNRESET`   - the broker accepted then dropped the connection. Recoverable; auto-reconnect handles it.
 * - `ENOTFOUND`    - DNS could not resolve the broker hostname. Non-recoverable - retrying the same hostname will keep failing - so we end the transport permanently
 *                    and emit a standalone log line without the retry-cadence suffix.
 * - default        - any other error code (or none). Logged through the retry-cadence formatter with `util.inspect` of the error, so a future mqtt.js error code we
 *                    did not anticipate still surfaces in the log stream rather than being silently swallowed.
 *
 * @param error             - The error event payload from the underlying mqtt.js client.
 * @param log               - Logger used to emit the routed message.
 * @param reconnectInterval - Configured reconnect interval (in seconds) used to format the retry-cadence suffix.
 *
 * @returns A {@link MqttBrokerErrorResult} indicating whether the wiring layer should end the transport.
 *
 * @category Utilities
 */
export function routeMqttBrokerError(error: NodeJS.ErrnoException, log: HomebridgePluginLogging, reconnectInterval: number): MqttBrokerErrorResult {

  const logError = (message: string): void => {

    log.error("MQTT Broker: %s. Will retry again in %s second%s.", message, reconnectInterval, (reconnectInterval === 1) ? "" : "s");
  };

  switch(error.code) {

    case "ECONNREFUSED":

      logError("Connection refused");

      return { endTransport: false };

    case "ECONNRESET":

      logError("Connection reset");

      return { endTransport: false };

    case "ENOTFOUND":

      log.error("MQTT Broker: Hostname or IP address not found.");

      return { endTransport: true };

    default:

      logError(util.inspect(error, { sorted: true }));

      return { endTransport: false };
  }
}

/**
 * Outcome of a getter-driven response publish issued by {@link MqttClient.subscribeGet}. Discriminated union: `ok: true` after a successful publish, `ok: false` with
 * the captured error after a failure. Passed to {@link logGetterPublishOutcome} so the routing logic between the success and failure log lines is testable in
 * isolation against synthetic outcomes - the same architectural pattern {@link routeMqttBrokerError} uses for transport-error log routing.
 *
 * @category Utilities
 */
export type GetterPublishOutcome = { readonly ok: true } | { readonly error: unknown; readonly ok: false };

/**
 * Route the outcome of a `subscribeGet` response publish to the appropriate log line. Pure function: no class state, no mqtt.js handles, no closure over the live
 * client. The wiring in {@link MqttClient.subscribeGet} forwards each `.then` / `.catch` settlement here, and tests cover both branches by calling the function
 * directly with synthetic `{ ok: true }` and `{ ok: false, error: ... }` outcomes - bypassing the real-broker substrate where a forced QoS-0 publish failure would
 * require contrived socket-level setup that is not worth the test-architecture complexity.
 *
 * @param log     - Logger that receives the routed message.
 * @param type    - Human-readable label (the `type` argument the caller passed to `subscribeGet`).
 * @param outcome - The publish outcome. See {@link GetterPublishOutcome}.
 *
 * @category Utilities
 */
export function logGetterPublishOutcome(log: HomebridgePluginLogging, type: string, outcome: GetterPublishOutcome): void {

  if(outcome.ok) {

    log.info("MQTT: %s status published.", type);

    return;
  }

  log.error("MQTT: failed to publish %s status: %s.", type, formatErrorMessage(outcome.error));
}

/**
 * Per-subscription options accepted by {@link MqttClient.subscribe}, {@link MqttClient.subscribeGet}, and {@link MqttClient.subscribeSet}.
 *
 * @property signal - Optional {@link AbortSignal}. When it aborts, the specific handler is removed and (if it was the last handler on the topic) the underlying MQTT
 *                    subscription is dropped. Composes with the connection-level signal: a client-level abort removes every handler regardless of per-subscription
 *                    state.
 *
 * @category Utilities
 */
export interface MqttSubscribeInit {

  signal?: AbortSignal;
}

/**
 * Per-subscription options accepted by {@link MqttClient.subscribeSet}.
 *
 * @property signal  - Optional {@link AbortSignal} that auto-unsubscribes this handler. See {@link MqttSubscribeInit}.
 * @property timeout - Optional timeout, in milliseconds, applied to each invocation of the user-supplied setter. When the setter takes longer than this, the
 *                    invocation is cancelled and a warning is logged. Omit for no timeout - the setter still unwinds if the connection-level signal aborts, via
 *                    {@link runWithAbort}.
 *
 * @category Utilities
 */
export interface MqttSubscribeSetInit {

  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Per-publish options accepted by {@link MqttClient.publish}.
 *
 * @property signal - Optional {@link AbortSignal}. When it aborts before the broker acknowledges the publish, the returned promise rejects with `signal.reason`.
 *                    Composes with the connection-level signal.
 *
 * @category Utilities
 */
export interface MqttPublishInit {

  signal?: AbortSignal;
}

/**
 * Signal-driven MQTT client with automatic topic-prefix management, composed connection lifetime, and per-operation signal support.
 *
 * @example
 *
 * ```ts
 * import { MqttClient } from "homebridge-plugin-utils";
 *
 * await using mqtt = new MqttClient({ brokerUrl: "mqtt://localhost:1883", log, topicPrefix: "homebridge" }, { signal: platform.signal });
 *
 * // A subscription that auto-unsubscribes on the per-feature signal.
 * const feature = new AbortController();
 *
 * mqtt.subscribe("device1/status", (payload) => log.info("Status: %s.", payload.toString()), { signal: feature.signal });
 *
 * // Abort-aware publish.
 * await mqtt.publish("device1/status", "on");
 * ```
 *
 * @category Utilities
 */
export class MqttClient implements AsyncDisposable {

  /**
   * The composed abort signal representing this client's lifetime. Aborts exactly once when {@link MqttClient.abort} is called or when the parent signal fires.
   */
  public readonly signal: AbortSignal;

  readonly #brokerUrl: string;
  readonly #controller: AbortController;
  readonly #log: HomebridgePluginLogging;
  readonly #mqtt: MqttJsClient;
  readonly #reconnectInterval: number;
  readonly #subscriptions: Map<string, Set<MqttHandler>>;
  readonly #topicPrefix: string;
  #isConnected: boolean;

  /**
   * Construct and start a new MQTT client.
   *
   * Connection is initiated synchronously as part of construction; there is no separate `connect()` step. A synchronous failure from mqtt.js (typically an invalid
   * broker URL) surfaces as an `Error` wrapping the underlying cause, so a misconfigured plugin fails loudly instead of living in a zombie state. Network-level
   * failures (an unreachable broker reachable by a valid URL) do not throw - they surface asynchronously through the client's `error` event, are logged, and trigger
   * mqtt.js's built-in auto-reconnect until {@link MqttClient.abort} or a parent signal ends the client for good. A pre-aborted parent signal still constructs
   * a client (so `#mqtt` stays non-null) and then immediately runs the regular teardown path.
   *
   * @param config - Static broker / topic configuration. See {@link MqttConfig}.
   * @param init   - Optional init options. See {@link MqttClientInit}.
   *
   * @throws `Error` (with the underlying mqtt.js error attached as `cause`) when mqtt.js's `connect()` fails synchronously.
   */
  public constructor(config: MqttConfig, init: MqttClientInit = {}) {

    this.#brokerUrl = config.brokerUrl;
    this.#isConnected = false;
    this.#log = config.log;
    this.#reconnectInterval = config.reconnectInterval ?? MQTT_DEFAULT_RECONNECT_INTERVAL;
    this.#subscriptions = new Map();
    this.#topicPrefix = config.topicPrefix;

    this.#controller = new AbortController();
    this.signal = composeSignals(init.signal, this.#controller.signal);

    // Establish the underlying MQTT.js connection unconditionally so `#mqtt` is always a live reference by the time the constructor returns. A synchronous failure
    // (typically URL parsing) is wrapped in an Error whose `cause` carries the original error, so callers distinguish via `error.cause` rather than matching on
    // mqtt.js's internal message text.
    try {

      // We connect with `rejectUnauthorized: false` deliberately. The broker URL is user-supplied and, in the typical Homebridge deployment, points at a local
      // LAN broker (a mosquitto instance on the same network) that is frequently fronted by a self-signed certificate with no chain to a public CA. Enforcing strict
      // certificate-chain verification would break those common self-signed setups and force users to hand-wire a CA bundle, so we accept the broker's certificate as
      // presented. The trust boundary here is the user's own network and their own broker, not a public endpoint, which makes this the correct posture rather than a
      // weakening of transport security.
      this.#mqtt = connect(this.#brokerUrl, { reconnectPeriod: this.#reconnectInterval * 1000, rejectUnauthorized: false });
    } catch(error) {

      throw new Error("MqttClient: connection setup failed.", { cause: error });
    }

    this.#wireMqttEvents(this.#mqtt);

    // Teardown convergence point. `onAbort` registers the one-shot teardown handler AND runs it synchronously when the signal is already aborted at construction
    // time (the AbortSignal spec does not re-dispatch historical events, so bare `addEventListener` would silently skip the handler for a pre-aborted parent).
    // Running the handler in both paths means pre-aborted construction unwinds identically to a mid-session abort - the brief mqtt.js `connect()` call above is
    // cancelled by `end(true)` before any network work proceeds.
    onAbort(this.signal, () => this.#teardown());
  }

  /**
   * Publish `payload` to `topic`, returning a promise that resolves when the broker acknowledges the publish, or rejects on failure or abort.
   *
   * The topic is prefixed with the configured {@link MqttConfig.topicPrefix} before being sent; callers supply the topic tail (for example, `"device1/status"`).
   *
   * @param topic   - The relative topic (tail) to publish to.
   * @param payload - The payload to publish. Buffers and strings are passed through unchanged.
   * @param init    - Optional per-publish options. See {@link MqttPublishInit}.
   *
   * @returns A promise that resolves once the broker acknowledges, or rejects on error or abort.
   */
  public async publish(topic: string, payload: Buffer | string, init: MqttPublishInit = {}): Promise<void> {

    const composed = composeSignals(this.signal, init.signal);

    // Short-circuit pre-aborted signals before queueing anything into mqtt.js. Without this check, a publish issued after the client has already torn down would
    // still enqueue inside mqtt.js's internal buffer (which is already being flushed by `end(true)`), producing a phantom write.
    composed.throwIfAborted();

    const full = this.#expandTopic(topic);

    this.#log.debug("MQTT publish: %s.", full);

    // Wrap mqtt.js's callback-style publish in a promise, then race it against the composed signal through `waitWithSignal` - the canonical primitive every other
    // signal-aware wait in this library uses. `Promise.withResolvers` is the codebase-wide pattern for callback-bridged deferreds; using it here keeps the hop from
    // mqtt.js's callback shape to a Promise on the same primitive every other wrap in HBPU uses.
    const { promise: ackPromise, resolve, reject }: PromiseWithResolvers<void> = Promise.withResolvers();

    this.#mqtt.publish(full, payload, (error) => {

      if(error) {

        reject(error);

        return;
      }

      resolve();
    });

    return waitWithSignal(ackPromise, composed);
  }

  /**
   * Subscribe to `topic` with the given handler. The topic is prefixed with the configured {@link MqttConfig.topicPrefix} before being registered with the broker.
   * Multiple handlers may subscribe to the same topic; each gets independent delivery.
   *
   * @param topic   - The relative topic (tail) to subscribe to.
   * @param handler - Callback invoked with each received payload.
   * @param init    - Optional per-subscription options. See {@link MqttSubscribeInit}.
   */
  public subscribe(topic: string, handler: MqttHandler, init: MqttSubscribeInit = {}): void {

    // Ignore subscribes that cannot produce any effect: the client is already dead or the caller handed us a pre-aborted per-subscription signal. Early-return keeps
    // the subscription map honest - nothing gets registered that cannot receive.
    if(this.signal.aborted || init.signal?.aborted) {

      return;
    }

    const full = this.#expandTopic(topic);

    this.#log.debug("MQTT subscribe: %s.", full);

    let handlers = this.#subscriptions.get(full);

    if(!handlers) {

      handlers = new Set();
      this.#subscriptions.set(full, handlers);

      // First handler on this topic: issue the wire-level subscribe. Subsequent handlers on the same topic reuse the existing broker subscription, matching the
      // "pay once per topic" cost model the MQTT protocol naturally provides.
      this.#mqtt.subscribe(full);
    }

    handlers.add(handler);

    // Per-subscription cleanup: compose the caller's signal with the connection-level signal so either teardown path fires the listener exactly once. Attaching the
    // listener to the composed signal (rather than to `init.signal` directly) ensures the listener auto-releases when the client aborts even if the caller never
    // aborts their per-subscription controller - the composed signal is what prevents the closure from pinning the handler past the connection's lifetime.
    if(init.signal) {

      const composed = composeSignals(this.signal, init.signal);

      onAbort(composed, () => this.#removeHandler(full, handler));
    }
  }

  /**
   * Subscribe to the `/get` child of `topic`. When a `"true"` message arrives on the get topic, the provided `getValue` callback runs and its return value is
   * published back on the parent topic. The classic HomeKit "get" pattern, wrapped once.
   *
   * @param topic    - The relative topic (tail); the `/get` suffix is appended automatically.
   * @param type     - Human-readable label used in log messages (for example, `"Temperature"`).
   * @param getValue - Callback returning the current value as a string, invoked on each incoming `"true"` message.
   * @param init     - Optional per-subscription options. See {@link MqttSubscribeInit}.
   */
  public subscribeGet(topic: string, type: string, getValue: MqttGetHandler, init: MqttSubscribeInit = {}): void {

    this.subscribe(topic + "/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // The get-pattern contract: only `"true"` triggers a republish. Other values (empty, `"false"`, noise) are ignored silently so the broker-side fan-out can
      // request status without every listener responding.
      if(value !== "true") {

        return;
      }

      // Sequence both log lines through {@link logGetterPublishOutcome} so the routing between success and failure is expressible as a pure function and testable in
      // isolation. The publish promise settles exactly once - either `.then` (success) or `.catch` (failure) runs - and each path forwards its outcome through the
      // single routing point, keeping the log surface honest about what actually happened on the wire.
      void this.publish(topic, getValue())
        .then(() => logGetterPublishOutcome(this.#log, type, { ok: true }))
        .catch((error: unknown) => logGetterPublishOutcome(this.#log, type, { error, ok: false }));
    }, init);
  }

  /**
   * Subscribe to the `/set` child of `topic`. Each incoming message invokes `setValue` with the lowercased normalized value, the raw message string, and an
   * {@link AbortSignal} that composes the connection-level signal with the optional per-invocation `timeout`. Signal-aware setters forward that signal to cancellation-
   * capable APIs so the setter's work actually stops when the timeout elapses or the client aborts; signal-unaware setters continue to run but the subscription slot
   * is released either way, so a hanging setter cannot tie up the slot indefinitely.
   *
   * @param topic    - The relative topic (tail); the `/set` suffix is appended automatically.
   * @param type     - Human-readable label used in log messages.
   * @param setValue - Callback invoked with each received value. Receives three arguments: `(value, rawValue, signal)`. See {@link MqttSetHandler}.
   * @param init     - Optional per-subscription options including a handler-invocation `timeout`. See {@link MqttSubscribeSetInit}.
   */
  public subscribeSet(topic: string, type: string, setValue: MqttSetHandler, init: MqttSubscribeSetInit = {}): void {

    const timeout = init.timeout;

    this.subscribe(topic + "/set", async (message: Buffer) => {

      const rawValue = message.toString();
      const value = rawValue.toLowerCase();

      try {

        // `runWithAbort` composes the connection-level signal with the optional per-invocation timeout and passes the composed signal to its factory. We forward that
        // signal into the user's setter so signal-aware setters can actually cancel in-flight work on timeout or teardown. A module-level sentinel distinguishes "user
        // setter ran to completion" from "runWithAbort returned null because the signal aborted," keeping cancellation on the `warn` log path rather than the error
        // path. The `{ signal, timeout?: number }` option form accepts `timeout: undefined`, so a single call shape covers both the with-timeout and without-timeout
        // cases.
        const result = await runWithAbort<typeof SUBSCRIBE_SET_OK>(async (setterSignal) => {

          await setValue(value, rawValue, setterSignal);

          return SUBSCRIBE_SET_OK;
        }, { signal: this.signal, timeout });

        if(result !== SUBSCRIBE_SET_OK) {

          this.#log.warn("MQTT: set handler for %s was cancelled before completion.", type);

          return;
        }

        this.#log.info("MQTT: set message received for %s: %s.", type, value);
      } catch(error) {

        this.#log.error("MQTT: error setting %s to %s: %s.", type, value, formatErrorMessage(error));
      }
    }, init);
  }

  /**
   * Unsubscribe all handlers for the specified `(id, topic)` tuple. Reconstructs the topic using the configured {@link MqttConfig.topicPrefix}, removes the
   * subscription from the internal map, and issues the wire-level unsubscribe. Preserved as a separate imperative verb for the mid-session feature-toggle pattern
   * where the caller has the `(id, topic)` tuple but never retained a dedicated controller.
   *
   * Deliberately does not accept a `{ signal }` option: unsubscribe is synchronous and has nothing to cancel, and exposing a vestigial signal would suggest a
   * cancellation semantic the method cannot deliver. Callers composing teardown through a signal remove handlers by aborting the per-subscription signal they passed
   * to `subscribe*` instead.
   *
   * @param id    - The device or accessory identifier portion of the topic. An empty string short-circuits the whole call.
   * @param topic - The topic tail relative to the id.
   */
  public unsubscribe(id: string, topic: string): void {

    // No-op on an aborted client: the wire-level subscribe has already been released by `#teardown`, and the subscription map is empty. Checking the signal up front
    // lets subsequent `this.#mqtt` accesses run unguarded.
    if(this.signal.aborted || !id) {

      return;
    }

    const full = this.#expandTopic(id + "/" + topic);

    this.#subscriptions.delete(full);
    this.#mqtt.unsubscribe(full);
  }

  /**
   * Abort the client and tear the connection down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once. After this runs, every subsequent `publish`, `subscribe*`, or `unsubscribe` call is a no-op.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}; platform errors also interoperate by convention.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation. Aborts the client (defaulting to `"shutdown"`), which tears the MQTT connection down and rejects any pending publishes through
   * the regular teardown path.
   *
   * @returns A promise that resolves once teardown has been scheduled. MQTT.js's `end(true)` completes synchronously for userland purposes, so the awaited microtask
   *          is all the ordering the caller needs.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  // Wire up the MQTT.js event handlers that drive message dispatch, connection lifecycle logging, and error escalation. Extracted into a helper so the constructor
  // reads as a linear flow (set up state -> compose signal -> connect -> wire events).
  #wireMqttEvents(client: MqttJsClient): void {

    client.on("connect", () => {

      this.#isConnected = true;

      // The replace strips the password from the broker URL's `user:password@host` userinfo before logging, so credentials never reach the log stream. The capture
      // groups preserve the scheme-plus-username prefix and the `@host` suffix while swapping only the password segment for REDACTED.
      this.#log.info("MQTT Broker: Connected to %s (topic: %s).", this.#brokerUrl.replace(/^(.*:\/\/.*:)(.*)(@.*)$/, "$1REDACTED$3"), this.#topicPrefix);
    });

    client.on("close", () => {

      // Only log a disconnect when we had previously connected - otherwise we would spam the log on every failed connect attempt during a retry loop. Tracking
      // `#isConnected` as an edge flag (true on connect, false on close) captures the transition cleanly; mqtt.js's own `.connected` property is already `false` by
      // the time this listener fires, so it cannot answer the "were we previously connected?" question on its own.
      if(!this.#isConnected) {

        return;
      }

      this.#isConnected = false;
      this.#log.info("MQTT Broker: Connection closed.");
    });

    client.on("message", (topic: string, message: Buffer) => {

      const handlers = this.#subscriptions.get(topic);

      if(!handlers) {

        return;
      }

      // Snapshot the handler set before iterating so a handler that removes itself (or a sibling) mid-dispatch cannot alter which handlers this dispatch pass
      // invokes. Iterating the live Set directly would still be spec-correct - Set iteration order and hole-skipping on delete are well-defined - but it would make
      // the invocation set implicit and mutation-order-dependent. The snapshot cost is O(n) in handlers per topic, same as the dispatch itself, so the overhead is
      // negligible. Sync handlers run inline so their effects are observable on the calling turn (matching
      // EventEmitter's dispatch model and the public contract these tests assert); only the per-handler error handling is split between the sync and async legs,
      // both of which route through the same `logHandlerError` so the log surface is single-source-of-truth. One bad handler logs but does not destabilize the
      // connection or skip its siblings.
      const logHandlerError = (err: unknown): void => {

        this.#log.error("MQTT: handler for %s threw: %s.", topic, formatErrorMessage(err));
      };

      for(const handler of [...handlers]) {

        try {

          const result = handler(message);

          if(result instanceof Promise) {

            void markHandled(result.catch(logHandlerError));
          }
        } catch(err) {

          logHandlerError(err);
        }
      }
    });

    client.on("error", (error: Error) => {

      // Route the error through the pure {@link routeMqttBrokerError} helper, which selects the right log line for each known errno code (and the default branch for
      // unknown codes). The wiring layer's only side-effect responsibility is acting on the returned `endTransport` flag - the routing logic is testable in isolation
      // through direct invocation against synthetic errors, so this `client.on("error", ...)` callback stays a thin adapter from the mqtt.js event surface to the
      // pure routing function.
      const result = routeMqttBrokerError(error, this.#log, this.#reconnectInterval);

      if(result.endTransport) {

        this.#mqtt.end(true);
      }
    });
  }

  // Remove a single handler from a topic's subscription set. When the last handler leaves, the underlying MQTT subscription is dropped so idle topics do not continue
  // consuming broker bandwidth. Safe to call for handlers that were never registered (silently no-ops) and safe to call after the connection has aborted (the
  // subscription map is cleared by `#teardown`, so the initial `!handlers` check short-circuits before any `#mqtt` interaction).
  #removeHandler(full: string, handler: MqttHandler): void {

    const handlers = this.#subscriptions.get(full);

    if(!handlers) {

      return;
    }

    handlers.delete(handler);

    if(handlers.size === 0) {

      this.#subscriptions.delete(full);
      this.#mqtt.unsubscribe(full);
    }
  }

  // Expand a relative topic tail into the full broker-facing topic. Always concatenates with the configured prefix; the caller is responsible for any id structure
  // inside the tail. Keeping this as a single small helper means every publish / subscribe site goes through identical expansion logic, avoiding drift.
  #expandTopic(topic: string): string {

    return this.#topicPrefix + "/" + topic;
  }

  // Single teardown convergence point, fired exactly once when `this.signal` aborts. Clears the subscription map so multi-consumer fan-out stops delivering messages
  // on the way out, then ends the MQTT.js connection with `force = true` so any in-flight publish / subscribe packets are dropped rather than awaited - the client is
  // unambiguously done, and the underlying library's reconnect logic exits permanently. The `#mqtt` reference is not nulled: callers never reach `#mqtt` accesses
  // when the signal is aborted (every public method short-circuits on `signal.aborted`), and keeping the reference preserves the `readonly #mqtt: MqttJsClient`
  // guarantee that lets TypeScript drop every non-null assertion in the live paths.
  #teardown(): void {

    this.#subscriptions.clear();
    this.#mqtt.end(true);
  }
}
