/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-client-double.ts: A recording MqttClient test double - the plugin's half of the MQTT conversation, with no broker behind it - for the client in mqttClient.ts.
 */

/**
 * A recording {@link mqttClient!MqttClient | MqttClient} test double.
 *
 * A plugin that speaks MQTT registers subscriptions and publishes state, and what its tests need to assert is its own half of that conversation. This module ships the
 * double that answers it: a {@link TestMqttClient} recording which subscriptions were registered, on which topics, carrying which signals, what was published, and how
 * a refused publish was handled, with drivers that let a test deliver a message or run a registered getter or setter by hand.
 *
 * The double records, it does not simulate a broker. There is no connection, no topic prefixing (a topic is recorded as the caller's tail, verbatim), and nothing on
 * the wire...those are the real client's own contract, covered by the library's suite against a real broker, and a plugin's suite needs the plugin's side of the
 * interface rather than the transport's. What the double does mirror is the client's observable behavior, because that is what a consumer's code branches on: the
 * composed-signal check every publish opens with, the connection state a publish is refused on when it reads false, the pre-aborted early return that registers
 * nothing, the release of a registration when its per-subscription signal aborts, and the post-abort no-op posture of every method. The guarded path routes through
 * the client's own {@link mqtt-publish!routeGuardedPublishFailure | routeGuardedPublishFailure}, so a cancellation, an offline refusal, and a genuine failure reach
 * the same lines here that they reach on the client.
 *
 * Signatures come from the client's own exported types - {@link MqttHandler}, {@link MqttGetHandler}, {@link MqttSetHandler}, and the init types - so a method here
 * cannot drift from the method it stands in for without the compiler saying so.
 *
 * @module
 */
import { HbpuAbortError, composeSignals, markHandled, noOpLog, onAbort } from "./util.ts";
import type { HomebridgePluginLogging, Nullable } from "./util.ts";
import type { MqttGetHandler, MqttHandler, MqttPublishInit, MqttSetHandler, MqttSubscribeInit, MqttSubscribeSetInit } from "./mqttClient.ts";
import { MqttOfflineError, routeGuardedPublishFailure } from "./mqtt-publish.ts";

// The suffixes the client appends to a get and a set registration's topic. Named here because both sides of this module spell them: the registration side appends one,
// and the get driver strips it back off to recover the parent topic a republish goes to.
const GET_SUFFIX = "/get";
const SET_SUFFIX = "/set";

/**
 * One recorded subscription registration.
 *
 * @property handler - The callback exactly as the caller registered it - the raw handler, the getter, or the setter itself rather than a wrapper around it - so a
 *                     driver can run it directly. Which of those it is follows from `kind`.
 * @property init    - The init the caller passed, verbatim, so a test can assert which signal (and, for a set registration, which timeout) governs the entry.
 * @property kind    - Which registration verb produced the entry.
 * @property topic   - The topic the entry is registered on: the tail the caller passed, carrying the `/get` or `/set` suffix exactly as the client appends it.
 * @property type    - The human-readable label a get or set registration carries, and `undefined` for a raw registration, which has none.
 *
 * @category Testing
 */
export interface TestMqttSubscription {

  handler: MqttGetHandler | MqttHandler | MqttSetHandler;
  init: MqttSubscribeInit | MqttSubscribeSetInit;
  kind: "get" | "raw" | "set";
  topic: string;
  type: string | undefined;
}

/**
 * One recorded publish, as the caller issued it.
 *
 * @property payload - The payload passed to the publish, unchanged - a `Buffer` stays a `Buffer` and a string stays a string.
 * @property topic   - The topic tail passed to the publish. The double expands nothing, so this is what the caller wrote.
 *
 * @category Testing
 */
export interface TestMqttPublish {

  payload: Buffer | string;
  topic: string;
}

/**
 * A recording {@link mqttClient!MqttClient | MqttClient} double: it captures what a plugin registered and published, refuses a publish on demand so a plugin can prove
 * its loop survives one, and hands a test the drivers to deliver a message or run a registered getter or setter without a broker.
 *
 * Fidelity to the client's contract is the point. Every mirrored method keeps the client's signature and its observable behavior - the composed-signal abort check on
 * publish, the log lines the guarded path routes between, the registration rules, the release of a registration on abort, and the no-op posture every method takes
 * once the double has aborted - so a consumer driven against this double branches exactly as it would against a live client.
 *
 * @example
 *
 * ```ts
 * import { TestMqttClient } from "homebridge-plugin-utils/testing";
 *
 * const mqtt = new TestMqttClient();
 *
 * // The plugin registers its subscriptions against the double, cast at its injection site.
 * plugin.configureMqtt(mqtt as unknown as MqttClient);
 *
 * // Run the registered setter by hand: no broker, no wire. The tail is the recorded topic, carrying the `/set` suffix the client appends.
 * await mqtt.invokeSet("device1/power/set", "TRUE");
 *
 * assert.equal(device.power, true);
 * ```
 *
 * @category Testing
 */
export class TestMqttClient implements AsyncDisposable {

  /**
   * The abort signal representing this double's lifetime, mirroring {@link mqttClient!MqttClient.signal | MqttClient.signal}. It aborts exactly once, when
   * {@link TestMqttClient.abort} is called or the double is disposed.
   */
  public readonly signal: AbortSignal;

  /**
   * Every recorded publish, in order. A publish the refusal lever rejected never lands here - it is counted in {@link TestMqttClient.rejectedPublishes} instead.
   * {@link TestMqttClient.publishedTo} is the view over this list a scenario reads when it cares about one topic rather than about the whole conversation.
   */
  public readonly published: TestMqttPublish[] = [];

  /**
   * The registrations that are currently live, in registration order. An entry leaves this list when its per-subscription signal aborts, when
   * {@link TestMqttClient.unsubscribe} names its topic, or when the double aborts - the client's release semantics, observable here as the entry's departure.
   */
  public readonly subscriptions: TestMqttSubscription[] = [];

  /**
   * Every `(id, topic)` tuple {@link TestMqttClient.unsubscribe} acted on, in order. A call the guard short-circuits - an aborted double, or an empty id - records
   * nothing.
   */
  public readonly unsubscribes: { id: string; topic: string }[] = [];

  /**
   * How many publishes the double refused - through the refusal lever, or because {@link TestMqttClient.connected} was false - counting the ones
   * {@link TestMqttClient.publishGuarded} absorbs and the republish {@link TestMqttClient.invokeGet} issues, so a test can assert a refusal happened without having
   * to observe the rejection itself.
   */
  public rejectedPublishes = 0;

  /**
   * The refusal lever. While it holds an error, every {@link TestMqttClient.publish} rejects with that error instead of recording, which is how a test proves a
   * plugin's loop survives a broker that will not take a message. Set it back to `null` to resume recording.
   */
  public publishRejection: Nullable<Error> = null;

  // The controller whose signal is this double's lifetime. Owned privately so `abort()` is the only way to fire it, exactly as the client owns its own.
  readonly #controller = new AbortController();

  // Backing state for the connection lever. A test writes it; the getter composes it with the lifetime signal, as the client composes mqtt.js's flag with its own.
  #connected = true;

  // The gate an admitted publish parks on while a hold is active, and null while none is. `holdPublishes` installs each gate and its release closure owns it.
  #hold: Nullable<Promise<void>> = null;

  // Where the guarded publish path reports.
  readonly #log: HomebridgePluginLogging;

  /**
   * Construct a recording double.
   *
   * @param options - Optional construction options. `log` is the logger {@link TestMqttClient.publishGuarded} reports on, defaulting to the library's `noOpLog` so a
   *                  test asserting on behavior rather than on log output constructs the double bare; a test reading the guarded path's wording passes a
   *                  `capturingLog()`.
   */
  public constructor(options: { log?: HomebridgePluginLogging } = {}) {

    this.#log = options.log ?? noOpLog;
    this.signal = this.#controller.signal;

    // The client's teardown clears its whole subscription map on abort, independent of the per-subscription release listeners, so a client-level abort also releases
    // the registrations that never carried a signal of their own. Clearing in place preserves the array identity a test may already be holding. Only the live
    // registrations go: the publish and unsubscribe records are history, and a test reads them after teardown to assert what the consumer did on its way out.
    onAbort(this.signal, () => {

      this.subscriptions.length = 0;
    });
  }

  /**
   * Record a publish of `payload` to `topic`, mirroring {@link mqttClient!MqttClient.publish | MqttClient.publish}. The composed signal is read first, so a publish
   * issued after teardown rejects with the abort reason rather than recording. {@link TestMqttClient.connected} is read next: while it is false the publish is
   * refused with {@link MqttOfflineError}, exactly as the client refuses a publish it has no broker session for. The refusal lever - when armed - rejects last, in
   * place of recording. A publish those admissions let through parks on the gate {@link TestMqttClient.holdPublishes} installed, if one is active, and faces
   * those same admissions again when the gate is released, so the state at release is what answers a held publish.
   *
   * @param topic   - The relative topic (tail) to publish to. Recorded verbatim; the double expands nothing.
   * @param payload - The payload to publish. Buffers and strings are recorded unchanged.
   * @param init    - Optional per-publish options. See {@link MqttPublishInit}.
   *
   * @returns A promise that resolves once the publish is recorded, or rejects with the composed signal's reason, with {@link MqttOfflineError}, or with the armed
   *          refusal.
   */
  public async publish(topic: string, payload: Buffer | string, init: MqttPublishInit = {}): Promise<void> {

    const composed = composeSignals(this.signal, init.signal);

    this.#admit(composed);

    // A hold parks the publish between two admissions, on whichever gate is active at this moment rather than on whatever the hold holds by the time it wakes. The
    // second admission runs on the same composed signal the first did, mirroring the real client, which races its in-flight acknowledgement against that signal and
    // rejects a publish a teardown catches mid-flight; the connection and lever re-reads stand for a broker answer that arrives after the flight rather than before.
    const gate = this.#hold;

    if(gate !== null) {

      await gate;
      this.#admit(composed);
    }

    this.published.push({ payload, topic });
  }

  /**
   * The fire-and-forget counterpart to {@link TestMqttClient.publish}, mirroring {@link mqttClient!MqttClient.publishGuarded | MqttClient.publishGuarded}: it returns
   * nothing, never throws, and never rejects...an outcome the caller has no use for lands in the log instead.
   *
   * The rejection and the signals that govern it go to the client's own {@link mqtt-publish!routeGuardedPublishFailure | routeGuardedPublishFailure}, so the double
   * and the client cannot classify the same outcome differently. Each outcome resolves to one line: a publish cancelled by this double's abort, by the caller's
   * own signal, or by a rejection carrying either cancellation shape reaches the aborted line at debug; a publish refused through
   * {@link TestMqttClient.connected} reaches the dropped line at debug; anything else is a genuine failure and lands on the error line. The router owns the
   * reasoning behind that order. Every line names the topic tail, since the double expands nothing.
   *
   * @param topic   - The relative topic (tail) to publish to.
   * @param payload - The payload to publish.
   * @param init    - Optional per-publish options. See {@link MqttPublishInit}.
   */
  public publishGuarded(topic: string, payload: Buffer | string, init: MqttPublishInit = {}): void {

    // `markHandled` covers the case the `.catch` cannot: a logger that itself throws would turn a reported failure into an unhandled rejection. The client guards its
    // own guarded path the same way.
    void markHandled(this.publish(topic, payload, init).catch((error: unknown) => {

      routeGuardedPublishFailure({ clientSignal: this.signal, error, log: this.#log, publishSignal: init.signal, topic });
    }));
  }

  /**
   * Park every publish admitted from here on and return the closure that releases them. A parked publish has passed the admissions {@link TestMqttClient.publish}
   * opens with and is waiting to be recorded - where a real publish sits while the broker acknowledges it - so a scenario can land a teardown, an outage, or a
   * refusal ON an in-flight publish rather than racing one.
   *
   * Each call installs a fresh gate, and a publish parks on whichever gate is active when it is admitted. A release resolves its own gate and stands down as the
   * active hold only while nothing has replaced it, so an earlier release frees exactly the publishes parked on its own gate and leaves a later hold standing. A
   * second call is a second gate, not an error.
   *
   * Everything that publishes parks with it. {@link TestMqttClient.publishGuarded} routes through `publish`, so a guarded publish released after the double aborts
   * reaches the aborted line at debug; {@link TestMqttClient.invokeGet}'s republish parks too, so a get-driver invocation issued during a hold resolves at release.
   * {@link TestMqttClient.abort} releases nothing - the release is the test's own hand, and a held publish on a double that aborted rejects when it comes. A hold a
   * scenario never releases leaves that scenario's own awaited publishes pending.
   *
   * @returns The closure that releases the publishes parked on this call's gate. Safe to call more than once.
   */
  public holdPublishes(): () => void {

    const gate: PromiseWithResolvers<void> = Promise.withResolvers();

    this.#hold = gate.promise;

    return (): void => {

      // Stand down only while this gate is still the active hold. A later `holdPublishes` has replaced it, and clearing unconditionally would let that later hold's
      // parked publishes through on this release. The resolve is unconditional, since the publishes waiting on this gate are this closure's to free either way.
      if(this.#hold === gate.promise) {

        this.#hold = null;
      }

      gate.resolve();
    };
  }

  /**
   * The recorded publishes whose topic ends with `topicSuffix`, in publish order. Suffix matching is the double's own addressing - the tail match
   * {@link TestMqttClient.invokeGet} and {@link TestMqttClient.invokeSet} find a registration by - so a scenario names a topic here the way it already names one.
   *
   * An empty answer is an outcome rather than a mis-bound call, which is why this accessor stays quiet where the drivers report a miss: a scenario proving nothing
   * reached a topic asks exactly this question and reads the empty list as its result.
   *
   * @param topicSuffix - The tail to match against each recorded topic.
   *
   * @returns A fresh array of the matching publishes, in the order they were recorded. Mutating it leaves {@link TestMqttClient.published} untouched.
   */
  public publishedTo(topicSuffix: string): TestMqttPublish[] {

    return this.published.filter((entry) => entry.topic.endsWith(topicSuffix));
  }

  /**
   * Record a raw subscription on `topic`, mirroring {@link mqttClient!MqttClient.subscribe | MqttClient.subscribe}. An aborted double or a pre-aborted
   * per-subscription signal records nothing, and a supplied signal releases the entry when it - or the double - aborts.
   *
   * @param topic   - The relative topic (tail) to subscribe to. Recorded verbatim.
   * @param handler - The callback to record. {@link TestMqttClient.deliver} runs it.
   * @param init    - Optional per-subscription options. See {@link MqttSubscribeInit}.
   */
  public subscribe(topic: string, handler: MqttHandler, init: MqttSubscribeInit = {}): void {

    this.#register({ handler, init, kind: "raw", topic, type: undefined });
  }

  /**
   * Record a get subscription on the `/get` child of `topic`, mirroring {@link mqttClient!MqttClient.subscribeGet | MqttClient.subscribeGet}. The registration rules
   * are {@link TestMqttClient.subscribe}'s; {@link TestMqttClient.invokeGet} is what runs the getter.
   *
   * @param topic    - The relative topic (tail); the `/get` suffix is appended to the recorded topic exactly as the client appends it.
   * @param type     - Human-readable label, recorded alongside the registration.
   * @param getValue - The getter to record. See {@link MqttGetHandler}.
   * @param init     - Optional per-subscription options. See {@link MqttSubscribeInit}.
   */
  public subscribeGet(topic: string, type: string, getValue: MqttGetHandler, init: MqttSubscribeInit = {}): void {

    this.#register({ handler: getValue, init, kind: "get", topic: topic + GET_SUFFIX, type });
  }

  /**
   * Record a set subscription on the `/set` child of `topic`, mirroring {@link mqttClient!MqttClient.subscribeSet | MqttClient.subscribeSet}. The registration rules
   * are {@link TestMqttClient.subscribe}'s; {@link TestMqttClient.invokeSet} is what runs the setter.
   *
   * @param topic    - The relative topic (tail); the `/set` suffix is appended to the recorded topic exactly as the client appends it.
   * @param type     - Human-readable label, recorded alongside the registration.
   * @param setValue - The setter to record. See {@link MqttSetHandler}.
   * @param init     - Optional per-subscription options, including a handler-invocation `timeout`. Recorded verbatim. See {@link MqttSubscribeSetInit}.
   */
  public subscribeSet(topic: string, type: string, setValue: MqttSetHandler, init: MqttSubscribeSetInit = {}): void {

    this.#register({ handler: setValue, init, kind: "set", topic: topic + SET_SUFFIX, type });
  }

  /**
   * Record an unsubscribe of the `(id, topic)` tuple and release every registration on the topic it names, mirroring
   * {@link mqttClient!MqttClient.unsubscribe | MqttClient.unsubscribe}.
   *
   * @param id    - The device or accessory identifier portion of the topic. An empty string short-circuits the whole call, as it does on the client.
   * @param topic - The topic tail relative to the id.
   */
  public unsubscribe(id: string, topic: string): void {

    // The client's guard: an aborted client has already released every registration, and an empty id short-circuits before anything is touched.
    if(this.signal.aborted || !id) {

      return;
    }

    const full = id + "/" + topic;

    this.unsubscribes.push({ id, topic });

    // The client deletes the map entry for the reconstructed topic, which drops every handler registered on it at once. Removing from a snapshot rather than from the
    // live array keeps the splices from shifting indices out from under the iteration.
    for(const entry of this.subscriptions.filter((subscription) => subscription.topic === full)) {

      this.#remove(entry);
    }
  }

  /**
   * Abort the double, mirroring {@link mqttClient!MqttClient.abort | MqttClient.abort}: it defaults to `HbpuAbortError("shutdown")` when no reason is supplied, and
   * explicit reasons pass through unchanged. Safe to call more than once. Afterwards every publish, subscribe, and unsubscribe call is a no-op, and a driver
   * invocation takes the same quiet posture rather than reporting a miss, since teardown released every registration it could have matched.
   *
   * @param reason - Optional abort reason. See {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation, mirroring the client's: it aborts the double, defaulting to `"shutdown"`.
   *
   * @returns A promise that resolves once the abort has run.
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

  /**
   * The connection lever, mirroring {@link mqttClient!MqttClient.connected | MqttClient.connected}. It reads `true` on a fresh double and `false` once the double
   * aborts, whatever the lever itself holds, which is the composition the client makes between mqtt.js's flag and its own lifetime.
   *
   * Setting it to `false` stands in for a broker the client holds no session with: every {@link TestMqttClient.publish} is then refused with
   * {@link MqttOfflineError} and counted, which is the outage a consumer's own code has to survive. Set it back to `true` to resume recording.
   */
  public get connected(): boolean {

    return !this.aborted && this.#connected;
  }

  public set connected(value: boolean) {

    this.#connected = value;
  }

  /**
   * Deliver `payload` to every raw handler registered on `topic` - the test's hand on the broker side, standing in for an inbound message. Handlers are invoked in
   * registration order in a single pass, and the pass is awaited as a whole, so every effect they produce is settled by the time this resolves.
   *
   * @param topic   - The recorded topic to deliver on, matched exactly against {@link TestMqttSubscription.topic}.
   * @param payload - The message payload. A string is converted to a `Buffer` first, since a `Buffer` is what the client hands a handler.
   */
  public async deliver(topic: string, payload: Buffer | string): Promise<void> {

    const message = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

    // Snapshot the matching entries so a handler that subscribes or unsubscribes mid-delivery cannot change which handlers this pass invokes - the posture the client's
    // own message dispatch takes over its handler set. Every handler is invoked in one pass in registration order, as the client dispatches them rather than holding
    // each back until the one before it settles, and the pass is awaited as a whole so an asynchronous handler's effects are settled by the time the driver returns.
    const dispatched = this.subscriptions.filter((subscription) => (subscription.kind === "raw") && (subscription.topic === topic));

    /* A handler may be synchronous or asynchronous, so each result is normalized to a promise before the aggregate wait...a synchronous handler has already run to
     * completion by then and contributes an already-resolved one.
     *
     * The recorded handler's shape follows from its `kind`, which a single-shape record cannot express to the compiler. The assertion asserts only what the `kind`
     * filter above has already established.
     */
    await Promise.all(dispatched.map((entry) => Promise.resolve((entry.handler as MqttHandler)(message))));
  }

  /**
   * Run the getter registered on the topic ending in `topicSuffix` and publish its value on the parent topic - the test's hand on the `"true"` message the client's
   * get pattern waits for. The republish goes through {@link TestMqttClient.publish}, so it lands in `published` and honors the refusal lever.
   *
   * A suffix that matches no live get registration is a mis-bound driver call rather than a scenario, so it throws with the registered get topics named. A double
   * that has aborted is the one exception: it released every registration on the way down, and it answers quietly, as every method does after teardown.
   *
   * @param topicSuffix - The tail to match. The first get registration whose recorded topic ends with it is the one that runs; on a live double, matching none of
   *                      them throws.
   *
   * @returns The getter's value, or `undefined` on a double that has aborted - the one arm that answers without a getter having run.
   */
  public async invokeGet(topicSuffix: string): Promise<string | undefined> {

    // Teardown released every registration, so a driver call on an aborted double could only ever miss. Answering quietly is the no-op posture the class documents
    // for every method after abort, and it keeps a consumer's own shutdown path drivable without a scenario having to know the double is already down.
    if(this.signal.aborted) {

      return undefined;
    }

    const entry = this.subscriptions.find((subscription) => (subscription.kind === "get") && subscription.topic.endsWith(topicSuffix));

    /* A live double holding no match means the call named a topic nothing was registered on, or the registration's own signal released it before the driver ran.
     * Either way the scenario is not exercising what it reads as exercising, so the driver fails the test at the call site rather than passing vacuously - a
     * silent answer here relocates the mistake to whoever reads the result.
     */
    if(!entry) {

      throw new Error(this.#missMessage("get", topicSuffix));
    }

    const value = (entry.handler as MqttGetHandler)();

    // The recorded topic carries the `/get` suffix the client appended, so the republish goes to that topic with the suffix taken back off. The client's get path
    // answers a failed republish in its log rather than to a caller, and the driver takes the same posture: a refusal is absorbed here, already counted in
    // `rejectedPublishes`, and the getter's value is still what the caller asked for.
    await this.publish(entry.topic.slice(0, -GET_SUFFIX.length), value).catch(() => { /* The refusal is counted, not answered. */ });

    return value;
  }

  /**
   * Run the setter registered on the topic ending in `topicSuffix` - the test's hand on an inbound set message. The setter receives the arguments the client passes
   * it: the lowercased value, the raw value, and this double's signal.
   *
   * The miss posture is {@link TestMqttClient.invokeGet}'s: on a live double an unmatched suffix throws with the registered set topics named, and on a double that
   * has aborted the call returns quietly.
   *
   * @param topicSuffix - The tail to match. The first set registration whose recorded topic ends with it is the one that runs; on a live double, matching none of
   *                      them throws.
   * @param rawValue    - The raw message value, passed through as the setter's second argument and lowercased for its first.
   */
  public async invokeSet(topicSuffix: string, rawValue: string): Promise<void> {

    // The get driver's aborted posture, on the set side.
    if(this.signal.aborted) {

      return;
    }

    const entry = this.subscriptions.find((subscription) => (subscription.kind === "set") && subscription.topic.endsWith(topicSuffix));

    // And its miss posture: an unmatched suffix on a live double is an authoring mistake, and the message hands the author what is registered.
    if(!entry) {

      throw new Error(this.#missMessage("set", topicSuffix));
    }

    // The same `kind`-established assertion the delivery path makes.
    await (entry.handler as MqttSetHandler)(rawValue.toLowerCase(), rawValue, this.signal);
  }

  // The publish admission, stated once and run by each of `publish`'s admission passes. The client composes its lifetime signal with the caller's and short-circuits a
  // pre-aborted publish before anything reaches the wire, and composing the same way here is what makes a consumer's per-publish cancellation observable against the
  // double. The client then refuses a publish it has no session for before it consults anything else, so the double reads its own connection state before the lever:
  // a test that arms both gets the offline refusal, because an arbitrary refusal a test arms stands for a broker that took the message and said no, and there is no
  // broker to say anything while the double is disconnected. Nothing is recorded on either refusal, and the counter is what a test reads instead.
  #admit(composed: AbortSignal): void {

    composed.throwIfAborted();

    if(!this.connected) {

      this.rejectedPublishes++;

      throw new MqttOfflineError();
    }

    if(this.publishRejection !== null) {

      this.rejectedPublishes++;

      throw this.publishRejection;
    }
  }

  // Record a registration under the client's registration-time rules: nothing is registered that cannot receive (an aborted double, or a pre-aborted
  // per-subscription signal), and a supplied signal releases the entry when either it or the double aborts. Attaching the release to the composed signal rather than
  // to the caller's is what makes it fire on a double-level teardown too, exactly as the client attaches its own.
  #register(entry: TestMqttSubscription): void {

    if(this.signal.aborted || entry.init.signal?.aborted) {

      return;
    }

    this.subscriptions.push(entry);

    if(entry.init.signal) {

      onAbort(composeSignals(this.signal, entry.init.signal), () => this.#remove(entry));
    }
  }

  // Remove `entry` by identity. The guarded `indexOf` makes a second removal a safe no-op, which is what the abort path needs: aborting the double clears the whole
  // list and then fires each composed release listener, so every entry that carried a signal is asked to leave a list it has already left.
  #remove(entry: TestMqttSubscription): void {

    const index = this.subscriptions.indexOf(entry);

    if(index !== -1) {

      this.subscriptions.splice(index, 1);
    }
  }

  // The sentence a missed driver invocation carries. It names the suffix that matched nothing and enumerates the live registrations of the kind the driver looked
  // in, which is the whole correction: reading it tells an author whether the topic was misspelled, whether the suffix was left off the tail, or whether the
  // registration they expected has been released. A double holding none of that kind gets its own closing phrase, since a list that would be empty says less than
  // the fact that nothing of the kind is registered at all.
  #missMessage(kind: "get" | "set", topicSuffix: string): string {

    const registered = this.subscriptions.filter((subscription) => subscription.kind === kind).map((subscription) => "\"" + subscription.topic + "\"");

    return "TestMqttClient: no " + kind + " registration's topic ends with \"" + topicSuffix + "\"; " +
      ((registered.length > 0) ? "the registered " + kind + " topics are " + registered.join(", ") : "no " + kind + " topics are registered") + ".";
  }
}
