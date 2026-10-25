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
 * The double records, it does not simulate a broker. There is no connection, no topic prefixing (a topic is recorded as the caller's tail, verbatim), no last will (a
 * will is published by the broker, and there is none behind this double to publish one), and nothing on the wire...those are the real client's own contract, covered by
 * the library's suite against a real broker, and a plugin's suite needs the plugin's side of the interface rather than the transport's. What the double does mirror is
 * the client's observable behavior, because that is what a consumer's code branches on: the composed-signal check every publish opens with, the connection state a
 * publish is refused on when it reads false, the pre-aborted early return that registers nothing, the release of a registration when its per-subscription signal aborts,
 * the change gate a publish asking for `ifChanged` is answered by and the session-bound memory behind it, the connect registrations the client notifies on every session
 * it establishes until its end begins - driven here by the lever's false-to-true edge, which is the double's session restored - the retained availability statement that
 * same edge records ahead of those registrations, the final words the end registrations state within the end's grace, the admission that refuses every other publish once
 * the end has begun, and the warning a teardown logs when the words go unsaid, each run from the module the client runs it from, the quiet the end keeps over every
 * driver, and the post-abort no-op posture of every method. The guarded path routes through the client's own
 * {@link mqtt-publish!routeGuardedPublishFailure | routeGuardedPublishFailure}, so a cancellation, an offline refusal, and a genuine failure reach the same lines here
 * that they reach on the client.
 *
 * Signatures come from the client's own exported types - {@link MqttHandler}, {@link MqttGetHandler}, {@link MqttSetHandler}, and the init types - so a method here
 * cannot drift from the method it stands in for without the compiler saying so.
 *
 * @module
 */
import { HbpuAbortError, assertPositiveFinite, composeSignals, guardedDispatch, markHandled, noOpLog, onAbort, repeatDemotedLog, waitWithSignal } from "./util.ts";
import type { HomebridgePluginLogging, Nullable, RepeatDemotedLog } from "./util.ts";
import { MQTT_AVAILABILITY_ONLINE, MQTT_AVAILABILITY_TOPIC, MQTT_GET_SUFFIX, assertResolvedMqttTopic, mqttGetTopic, mqttSetTopic, mqttTopic } from "./mqtt-topics.ts";
import { MQTT_CONNECT_HANDLER_CANCELLED, MQTT_DEFAULT_END_GRACE_MS, MQTT_UNSAID_WORDS_WARNING, MqttLastPayloads, MqttOfflineError, assertAdmittedDuringMqttEnd,
  guardedPublishReason, isMqttCallbackCutShort, routeGuardedPublishFailure, stateMqttFinalWords } from "./mqtt-publish.ts";
import type { MqttConnectHandler, MqttEndHandler, MqttGetHandler, MqttHandler, MqttPublishInit, MqttSetHandler, MqttSubscribeInit,
  MqttSubscribeSetInit } from "./mqttClient.ts";
import type { Clock } from "./clock.ts";
import type { MqttEndState } from "./mqtt-publish.ts";
import { systemClock } from "./clock.ts";

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
 * @property retain  - The retention the caller asked for, and `false` when the init named none, so the flag reads the same way whether or not it was spelled.
 * @property topic   - The topic tail passed to the publish. The double expands nothing, so this is what the caller wrote.
 *
 * @category Testing
 */
export interface TestMqttPublish {

  readonly payload: Buffer | string;
  readonly retain: boolean;
  readonly topic: string;
}

/**
 * A recording {@link mqttClient!MqttClient | MqttClient} double: it captures what a plugin registered and published, refuses a publish on demand so a plugin can prove
 * its loop survives one, and hands a test the drivers to deliver a message or run a registered getter or setter without a broker.
 *
 * Fidelity to the client's contract is the point. Every mirrored method keeps the client's signature and its observable behavior - the composed-signal abort check on
 * publish, the log lines the guarded path routes between, the registration rules, the release of a registration on abort, and the no-op posture every method takes
 * once the double has aborted - so a consumer driven against this double branches exactly as it would against a live client. That holds for the graceful end too:
 * {@link TestMqttClient.onEnd}, {@link TestMqttClient.end} and disposal state a plugin's final words through the sequence the client runs, and an abort that leaves
 * them unsaid logs the client's warning, so a consumer's suite can assert its shutdown states its words before it aborts.
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

  // The time source the end's grace is armed on, the client's own option mirrored.
  readonly #clock: Clock;

  // The controller whose signal is this double's lifetime. Owned privately so `abort()` is the only way to fire it, exactly as the client owns its own.
  readonly #controller = new AbortController();

  // The connect registrations the lever's false-to-true edge invokes, mirroring the set the client's connect listener reads. A `Set` keeps the client's rules: the
  // same function registered twice is one registration, and iteration answers in registration order.
  readonly #connectHandlers = new Set<MqttConnectHandler>();

  // Backing state for the connection lever. A test writes it; the getter composes it with the lifetime signal, as the client composes mqtt.js's flag with its own.
  #connected = true;

  // Where the graceful end stands, the client's own field mirrored in the shape the two share: not begun, stating the final words under the window a publish is
  // admitted by, or closing with the abort that follows them.
  #end: MqttEndState = { kind: "open" };

  // The end registrations `end()` invokes, held under the client's rules: the same function registered twice is one registration, and iteration answers in
  // registration order.
  readonly #endHandlers = new Set<MqttEndHandler>();

  // The gate an admitted publish parks on while a hold is active, and null while none is. `holdPublishes` installs each gate and its release closure owns it.
  #hold: Nullable<Promise<void>> = null;

  // The change-gated memory the client keeps for the life of a session, mirrored: this one is cleared when the lever restores a session and at abort, where the
  // client clears its own on connect and at teardown.
  readonly #lastPayloads = new MqttLastPayloads();

  // Where the guarded publish path reports.
  readonly #log: HomebridgePluginLogging;

  // The repeat memory for guarded publishes, mirroring the client's: a rejection that keeps answering the same tag is reported once and replayed at debug, and a
  // session restored clears it, where the client's own is cleared on connect.
  readonly #publishFailures: RepeatDemotedLog;

  /**
   * Construct a recording double.
   *
   * @param options       - Optional construction options.
   * @param options.clock - The time source the grace of {@link TestMqttClient.end} is armed on, defaulting to the library's `systemClock`, as the client's own option
   *                        does. A test that drives the grace by hand passes a `TestClock`.
   * @param options.log   - The logger {@link TestMqttClient.publishGuarded} reports on and the abort warns on, defaulting to the library's `noOpLog` so a test asserting
   *                        on behavior rather than on log output constructs the double bare; a test reading the double's wording passes a `capturingLog()`.
   */
  public constructor(options: { clock?: Clock; log?: HomebridgePluginLogging } = {}) {

    this.#clock = options.clock ?? systemClock;
    this.#log = options.log ?? noOpLog;
    this.#publishFailures = repeatDemotedLog(this.#log);
    this.signal = this.#controller.signal;

    /* The client's teardown clears its whole subscription map on abort, independent of the per-subscription release listeners, so a client-level abort also
     * releases the registrations that never carried a signal of their own. Clearing in place preserves the array identity a test may already be holding. Only the
     * live registrations go: the publish and unsubscribe records are history, and a test reads them after teardown to assert what the consumer did on its way out.
     * The change-gated memory goes with them, since the client's own teardown clears its memory alongside its subscription map, and the connect and end
     * registrations go too, since the client's teardown clears its own.
     *
     * The warning comes first, read before the clear empties the end registrations, under the client's own condition: an abort that is not the end's own, with
     * registrations still held, leaves their words unsaid. The double has no parent signal, so its abort is the one teardown that can say so here.
     */
    onAbort(this.signal, () => {

      if((this.#endHandlers.size > 0) && (this.#end.kind !== "closing")) {

        this.#log.warn(MQTT_UNSAID_WORDS_WARNING, this.#endHandlers.size);
      }

      this.subscriptions.length = 0;
      this.#connectHandlers.clear();
      this.#endHandlers.clear();
      this.#lastPayloads.clear();
    });
  }

  /**
   * Record a publish of `payload` to `topic`, mirroring {@link mqttClient!MqttClient.publish | MqttClient.publish}. The composed signal is read first, so a publish
   * issued after teardown rejects with the abort reason rather than recording. The end's admission is read next, through the client's own
   * {@link mqtt-publish!assertAdmittedDuringMqttEnd | assertAdmittedDuringMqttEnd}: once {@link TestMqttClient.end} has begun, a publish whose own signal is not
   * the window the end handed its handlers rejects with `HbpuAbortError("shutdown")`, recording and counting nothing. {@link TestMqttClient.connected} is read
   * after it: while it is false the publish is refused with {@link MqttOfflineError}, exactly as the client refuses a publish it has no broker session for. The
   * refusal lever - when armed - rejects last, in place of recording. A publish those admissions let through parks on the gate
   * {@link TestMqttClient.holdPublishes} installed, if one is active. The composed signal ends the park at once, as it ends the client's wait on a write still in
   * flight, and otherwise the publish faces the signal, session and lever admissions again when the gate is released, so the state at release is what answers
   * it. The end's admission is not checked again at release: it answers when the publish is issued, as the client's does, whose write already handed to mqtt.js
   * is never recalled when the end begins, so a publish parked before the end began records at release while the words are stated.
   *
   * With `ifChanged`, the double records only when the payload differs from the last one a change-gated publish issued on the topic. The gate answers once the composed
   * signal, the end's admission and the placeholder refusal have, and ahead of the session and lever admissions, which is where the client's own gate sits. The memory
   * takes the payload once the first admission passes and before any hold, where the client takes its own as it hands the payload to mqtt.js, so a call issued while an
   * earlier one is parked is weighed against the parked payload. A parked publish waits on its gate through the primitive the client waits on its write with, so an abort
   * ends the wait and the publish forgets its payload in the same catch, after the same unwinding, as the client's failed publish does; a refusal by the second admission
   * at release forgets through that catch too, each time only while the topic's entry still carries its own token. The memory is cleared when
   * {@link TestMqttClient.connected} is set to `true` and when the double aborts, which is where the client clears its own. The comparison and keeping rules are
   * {@link mqtt-publish!MqttLastPayloads | MqttLastPayloads}'s. A suppressed publish records nothing, counts nothing, and says nothing.
   *
   * A tail still carrying a brace is refused through {@link mqtt-topics!assertResolvedMqttTopic | assertResolvedMqttTopic} once the composed signal and the end's
   * admission have answered, ahead of the session and lever admissions, which is where the client's own publish refuses one.
   *
   * @param topic   - The relative topic (tail) to publish to. Recorded verbatim; the double expands nothing.
   * @param payload - The payload to publish. Buffers and strings are recorded unchanged.
   * @param init    - Optional per-publish options. See {@link MqttPublishInit}.
   *
   * @returns A promise that resolves once the publish is recorded - or at once, with nothing recorded, when `ifChanged` finds the payload unchanged - or rejects
   *          with the composed signal's reason, with `HbpuAbortError("shutdown")` when the end does not admit it, with {@link MqttOfflineError}, or with the
   *          armed refusal.
   */
  public async publish(topic: string, payload: Buffer | string, init: MqttPublishInit = {}): Promise<void> {

    const composed = composeSignals(this.signal, init.signal);

    /* The composed signal answers first, so a torn-down double stays silent. The end's admission answers after it, reading the caller's own signal as the client's
     * does, and it is read here alone rather than in `#admit`, so a publish parked before the end began is not refused at release. The placeholder refusal answers
     * after them, ahead of the session and lever admissions - the order the client's own publish keeps - so a disconnected double and a disconnected client answer
     * a brace-carrying tail with the same error. The admission below reads the composed signal again; that repeat is a no-op and keeps the admission whole for the
     * post-hold pass.
     */
    composed.throwIfAborted();
    assertAdmittedDuringMqttEnd({ end: this.#end, signal: init.signal });
    assertResolvedMqttTopic("TestMqttClient", topic);

    // The change gate answers ahead of the session and lever admissions, where the client's own gate answers ahead of its offline refusal: an unchanged payload
    // resolves with nothing recorded, nothing counted, and nothing said, whatever the levers hold.
    if(init.ifChanged && this.#lastPayloads.sameAsLast(topic, payload)) {

      return;
    }

    this.#admit(composed);

    // The memory takes a change-gated payload once the first admission has passed and before any hold, which is where the client takes its own as it hands the
    // payload to mqtt.js: a call issued while this one is parked is weighed against this payload, and a call the admission refused never reaches this line.
    const token = init.ifChanged ? this.#lastPayloads.remember(topic, payload) : null;

    /* A hold parks the publish between its admissions, on whichever gate is active at this moment rather than on whatever the hold holds by the time it wakes.
     * The double observes its abort the way the client observes its write's abort: it waits on the gate through `waitWithSignal`, the primitive the client
     * waits on its write with, so the composed signal ends the wait and the forget in the catch lands at the same hop after the abort in every order, whether a
     * retry comes in the abort's own turn, a few awaits later or after a settle. A wait that has settled has dropped its listener, so a signal that aborts after
     * the gate opens touches nothing. The admission after the wait sits in the same try, so its refusal at release - the lever, or the connection dropped,
     * standing for a broker answer that arrives after the flight - forgets through the same catch, and the forget reads this call's own token, so a later
     * publish that has taken the topic since keeps its entry.
     */
    const gate = this.#hold;

    if(gate !== null) {

      try {

        await waitWithSignal(gate, composed);
        this.#admit(composed);
      } catch(error) {

        if(token !== null) {

          this.#lastPayloads.forget(topic, token);
        }

        throw error;
      }
    }

    this.published.push({ payload, retain: init.retain ?? false, topic });
  }

  /**
   * The fire-and-forget counterpart to {@link TestMqttClient.publish}, mirroring {@link mqttClient!MqttClient.publishGuarded | MqttClient.publishGuarded}: it returns
   * nothing, never throws, and never rejects...an outcome the caller has no use for lands in the log instead.
   *
   * The rejection and the signals that govern it go to the client's own {@link mqtt-publish!routeGuardedPublishFailure | routeGuardedPublishFailure}, so the double
   * and the client cannot classify the same outcome differently. Each outcome resolves to one line: a publish cancelled by this double's abort, by the caller's
   * own signal, or by a rejection carrying either cancellation shape reaches the aborted line at debug; a publish refused through
   * {@link TestMqttClient.connected} reaches the dropped line at debug; anything else is a genuine failure and lands on the error line. The router owns the
   * reasoning behind that order. Every line names the topic tail, since the double expands nothing, and a change-gated publish the memory suppresses reaches no
   * line at all, since nothing was attempted. A failure that keeps answering the same tag is reported once and replayed at debug until the tag changes or a
   * session is restored, which is the client's own cadence rather than a behavior of the double's own.
   *
   * @param topic   - The relative topic (tail) to publish to.
   * @param payload - The payload to publish.
   * @param init    - Optional per-publish options. See {@link MqttPublishInit}.
   */
  public publishGuarded(topic: string, payload: Buffer | string, init: MqttPublishInit = {}): void {

    /* `markHandled` covers the case the `.catch` cannot: a logger that itself throws would turn a reported failure into an unhandled rejection. The client guards
     * its own guarded path the same way, and demotes a repeat the same way too: the attempt wraps the report rather than the publish, and the tag comes from the
     * shared {@link mqtt-publish!guardedPublishReason | guardedPublishReason} the client calls, so a consumer's test cannot see one demote where the other reports.
     */
    void markHandled(this.publish(topic, payload, init).catch((error: unknown) => {

      this.#publishFailures.attempt((attemptLog) => routeGuardedPublishFailure({ clientSignal: this.signal, error, log: attemptLog, publishSignal: init.signal,
        topic }), () => guardedPublishReason(error));
    }));
  }

  /**
   * Park every publish admitted from here on and return the closure that releases them. A parked publish has passed the admissions {@link TestMqttClient.publish}
   * opens with and is waiting to be recorded - where a real publish sits while mqtt.js writes it to the connection - so a scenario can land a teardown, an
   * outage, or a refusal ON an in-flight publish rather than racing one.
   *
   * Each call installs a fresh gate, and a publish parks on whichever gate is active when it is admitted. A release resolves its own gate and stands down as the
   * active hold only while nothing has replaced it, so an earlier release frees exactly the publishes parked on its own gate and leaves a later hold standing. A
   * second call is a second gate, not an error.
   *
   * Everything that publishes parks with it. {@link TestMqttClient.publishGuarded} routes through `publish`, so a guarded publish parked when the double aborts
   * reaches the aborted line at debug; {@link TestMqttClient.invokeGet}'s republish parks too, so a get-driver invocation issued during a hold resolves at release.
   * {@link TestMqttClient.abort} releases nothing, but it ends the wait of every held publish, which rejects with the abort reason at once, as the client rejects
   * a publish whose write is still in flight; a publish's own signal does the same for that publish. A hold a scenario never releases leaves that scenario's own
   * awaited publishes pending until a signal ends them.
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
   * per-subscription signal records nothing, and a supplied signal releases the entry when it - or the double - aborts. A tail still carrying a brace is refused
   * through {@link mqtt-topics!assertResolvedMqttTopic | assertResolvedMqttTopic}, after those guards.
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

    this.#register({ handler: getValue, init, kind: "get", topic: mqttGetTopic(topic), type });
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

    this.#register({ handler: setValue, init, kind: "set", topic: mqttSetTopic(topic), type });
  }

  /**
   * Record an unsubscribe of the `(id, topic)` tuple and release every registration on the topic it names, mirroring
   * {@link mqttClient!MqttClient.unsubscribe | MqttClient.unsubscribe}.
   *
   * An aborted double or an empty `id` is a no-op, releasing nothing. A tail still carrying a brace is refused through
   * {@link mqtt-topics!assertResolvedMqttTopic | assertResolvedMqttTopic}, after those guards.
   *
   * @param id    - The device or accessory identifier portion of the topic. An empty string short-circuits the whole call, as it does on the client.
   * @param topic - The topic tail relative to the id.
   */
  public unsubscribe(id: string, topic: string): void {

    // The client's guard: an aborted client has already released every registration, and an empty id short-circuits before anything is touched.
    if(this.signal.aborted || !id) {

      return;
    }

    // Refuse a tail still carrying a placeholder, after the no-op guards above, so an aborted double and an empty id stay the no-ops the client's own verb documents.
    assertResolvedMqttTopic("TestMqttClient", topic);

    const full = mqttTopic(id, topic);

    this.unsubscribes.push({ id, topic });

    // The client deletes the map entry for the reconstructed topic, which drops every handler registered on it at once. Removing from a snapshot rather than from the
    // live array keeps the splices from shifting indices out from under the iteration.
    for(const entry of this.subscriptions.filter((subscription) => subscription.topic === full)) {

      this.#remove(entry);
    }
  }

  /**
   * Record a connect registration, mirroring {@link mqttClient!MqttClient.onConnect | MqttClient.onConnect}: an aborted double or a pre-aborted per-registration
   * signal registers nothing, a supplied signal releases the registration when it - or the double - aborts, and registering the same function twice is one
   * registration.
   *
   * Moving {@link TestMqttClient.connected} from `false` to `true` is what makes a registration fire, since that edge is the double's session restored. The
   * registrations run after the memory clear and after the lever has taken its value, so a handler reading `connected` sees `true` and a publish it issues is
   * admitted, exactly as one is on the client. A write that leaves the lever where it stood, and a write to `false`, invoke nothing, and from the moment
   * {@link TestMqttClient.end} begins the edge invokes nothing at all, as a session the client establishes during its end runs no connect handler.
   *
   * A registration that throws, or whose promise rejects, is logged on the double's logger as the client logs one, `"The MQTT connect handler failed: ..."` at error, and
   * disturbs neither the double nor the registrations around it. One that fails with an {@link HbpuAbortError} once {@link TestMqttClient.end} has begun, or fails in any
   * way once the double has aborted, was cut short rather than failing, and is logged at debug as
   * {@link mqtt-publish!MQTT_CONNECT_HANDLER_CANCELLED | MQTT_CONNECT_HANDLER_CANCELLED} instead, the line the client logs.
   *
   * A property write cannot be awaited, so a scenario whose handler is asynchronous awaits a turn after the write - the shipped `settle` helper - before it asserts
   * what the handler did.
   *
   * @param handler - The callback to record. See {@link mqttClient!MqttConnectHandler | MqttConnectHandler}.
   * @param init    - Optional per-registration options. See {@link MqttSubscribeInit}.
   */
  public onConnect(handler: MqttConnectHandler, init: MqttSubscribeInit = {}): void {

    // The client's registration-time guards, which `#register` keeps for the subscribe family: nothing is held that can never be invoked.
    if(this.signal.aborted || init.signal?.aborted) {

      return;
    }

    this.#connectHandlers.add(handler);

    // The release the client composes, composed the same way: attaching to the composed signal rather than to the caller's is what makes a double-level teardown
    // release the registration too.
    if(init.signal) {

      onAbort(composeSignals(this.signal, init.signal), () => this.#connectHandlers.delete(handler));
    }
  }

  /**
   * Record an end registration, mirroring {@link mqttClient!MqttClient.onEnd | MqttClient.onEnd}: an aborted double or a pre-aborted per-registration signal
   * registers nothing, a registration made once the end has begun is never invoked, a supplied signal releases the registration when it - or the double - aborts,
   * and registering the same function twice is one registration.
   *
   * Only {@link TestMqttClient.end} and disposal invoke a registration. An abort with registrations still held states nothing and logs the client's warning on the
   * double's logger, naming how many went unsaid.
   *
   * A word is recorded under the signal its handler is handed, the one signal the end admits a publish under, so a publish under any other is refused once the end
   * has begun, as on the client.
   *
   * @param handler - The callback that states the final words. See {@link mqttClient!MqttEndHandler | MqttEndHandler}.
   * @param init    - Optional per-registration options. See {@link MqttSubscribeInit}.
   */
  public onEnd(handler: MqttEndHandler, init: MqttSubscribeInit = {}): void {

    // The client's guards, and like the client's, none reads the end's state: a registration made once the end has taken its snapshot is never invoked, and the
    // abort clears it with the rest.
    if(this.signal.aborted || init.signal?.aborted) {

      return;
    }

    this.#endHandlers.add(handler);

    // The release the client composes, composed the same way, so a double-level teardown releases the registration too.
    if(init.signal) {

      onAbort(composeSignals(this.signal, init.signal), () => this.#endHandlers.delete(handler));
    }
  }

  /**
   * End the double gracefully, mirroring {@link mqttClient!MqttClient.end | MqttClient.end}: every end registration is invoked in registration order with the end's
   * window, the words are waited on within the grace, one turn of the event loop passes, and the double aborts with `HbpuAbortError("shutdown")`. The sequence is
   * the client's own, imported from the shared module, so a word the client would refuse at the grace - a publish parked by
   * {@link TestMqttClient.holdPublishes} among them - is refused here with the same reason.
   *
   * From the moment it begins, the end keeps the double quiet but for the words, as the client's keeps the client: a publish whose own signal is not the window a
   * handler was handed rejects with `HbpuAbortError("shutdown")`, which the guarded form reports at debug alone; {@link TestMqttClient.deliver},
   * {@link TestMqttClient.invokeGet} and {@link TestMqttClient.invokeSet} return without running a handler; and a session restored through
   * {@link TestMqttClient.connected} runs no connect registration. The shutdown order is the client's, and its own `end()` states it.
   *
   * A second call returns the first call's promise, and a call on an aborted double resolves an empty array, as on the client.
   *
   * @param options       - Optional end options.
   * @param options.grace - The longest the end waits for the words, in milliseconds. Defaults to {@link mqtt-publish!MQTT_DEFAULT_END_GRACE_MS | one second}.
   *
   * @returns A promise resolving with the refusals in registration order, and an empty array when every word was stated. It never rejects.
   *
   * @throws `TypeError` synchronously when `grace` is not a positive, finite number of milliseconds.
   */
  public end({ grace = MQTT_DEFAULT_END_GRACE_MS }: { grace?: number } = {}): Promise<unknown[]> {

    assertPositiveFinite(grace, { optionName: "grace", owner: "TestMqttClient", unit: "milliseconds" });

    // The client's order: the stored promise answers ahead of the aborted check, so a repeat call is handed the first call's promise however the first one ended.
    if(this.#end.kind !== "open") {

      return this.#end.words;
    }

    if(this.aborted) {

      return Promise.resolve([]);
    }

    // The state moves to stating through the window callback `#stateThenClose` hands the sequence, before a handler runs and before this call returns, as on the
    // client, so a handler calling `end()` again is handed this promise rather than starting a second end, and a word it issues synchronously is admitted.
    const { promise: words, resolve }: PromiseWithResolvers<unknown[]> = Promise.withResolvers();

    resolve(this.#stateThenClose(grace, words));

    return words;
  }

  /**
   * Abort the double, mirroring {@link mqttClient!MqttClient.abort | MqttClient.abort}: it defaults to `HbpuAbortError("shutdown")` when no reason is supplied, and
   * explicit reasons pass through unchanged. Safe to call more than once. Afterwards every publish, subscribe, and unsubscribe call is a no-op, and a driver
   * invocation takes the same quiet posture rather than reporting a miss, since teardown released every registration it could have matched. Like the client's, the
   * abort states no final words; {@link TestMqttClient.end} is the graceful counterpart.
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
   * `AsyncDisposable` implementation, mirroring the client's: it ends the double through {@link TestMqttClient.end}, so the final words are stated before the
   * double aborts with `"shutdown"`.
   *
   * @returns A promise that resolves once the final words have settled and the double has aborted, which takes at most the default grace when any words are
   *          registered.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    await this.end();
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
   * {@link MqttOfflineError} and counted, which is the outage a consumer's own code has to survive. Set it back to `true` to resume recording. Moving the lever
   * from `false` to `true` is a session restored and clears the change-gated memory, exactly as the client's connect clears its own; a write that leaves the lever
   * where it was is not a session event and leaves the memory standing. That same edge runs every registration {@link TestMqttClient.onConnect} holds, which is
   * how a scenario drives a consumer's restatement of held state without a broker, until {@link TestMqttClient.end} begins: from then on the edge runs none.
   *
   * The edge is also where the double states its availability, as the client's connect does: a retained `online` on the availability tail, recorded ahead of those
   * registrations. A fresh double records nothing of the kind, and the asymmetry with the client is deliberate rather than an omission - the client's first connect
   * is a session established, while a fresh double is a session already held, with no edge to cross - so a scenario that wants the statement drives the lever from
   * `false` to `true`. Recording one at construction would shift every index-based assertion a consumer's own suite already holds. Once the end has begun, its
   * admission refuses the statement, which records nothing and reaches the aborted line at debug, as on the client.
   */
  public get connected(): boolean {

    return !this.aborted && this.#connected;
  }

  public set connected(value: boolean) {

    // The lever moving from false to true is a session restored, which begins with nothing remembered, as the client's does on every connect. A write that leaves
    // the lever where it was is not a session event, since the client's connect fires once per session rather than on every reading of it. The edge is read ahead of
    // the write that follows it, which is what leaves one reading of it for the memory clear and the registrations below to share.
    const restored = value && !this.#connected;

    this.#connected = value;

    if(!restored) {

      return;
    }

    this.#lastPayloads.clear();

    // A session restored is the outage over, so the publish memory starts again from nothing, where the client's own is cleared on every connect. An attempt
    // answering no tag is how an adapter is told an episode closed, and it writes nothing of its own.
    this.#publishFailures.attempt(() => undefined, () => undefined);

    // The availability statement is recorded ahead of the registrations below, which is where the client's connect puts it, so a consumer's handler restating its
    // devices' availability records behind the plugin's own statement here exactly as it lands behind it on the wire. The tail is bare, since the double prefixes
    // nothing, and the guarded form is what keeps this setter synchronous - the client's own choice at the same point.
    this.publishGuarded(MQTT_AVAILABILITY_TOPIC, MQTT_AVAILABILITY_ONLINE, { retain: true });

    // Once the end has begun the edge runs no registration, where the client's connect runs no handler, and the end's admission has already refused the statement
    // above. The state is read once, ahead of the snapshot, as the client reads it.
    if(this.#end.kind !== "open") {

      return;
    }

    /* The registrations run after the write above, so a handler reading `connected` is told `true` and a publish it issues is admitted - the order the client keeps,
     * where mqtt.js sets its own flag before it emits the connect - and after the memory clear, so a change-gated publish of an unchanged payload is recorded again.
     * The snapshot answers a handler that registers another or releases a sibling while the pass runs, and the isolation is the client's own `guardedDispatch`,
     * imported by value here as it is there, so a faulting handler is caught alike on the client and the double and reported in one sentence neither one can drift
     * from. A handler the end or the abort cut short is told apart by the shared check the client's pass reads, and written at debug in the cancelled line the two read
     * from the shared module, with every other failure rethrown for `guardedDispatch` to report.
     */
    for(const handler of [...this.#connectHandlers]) {

      guardedDispatch({ handler: async (): Promise<void> => {

        try {

          await handler();
        } catch(error) {

          if(!isMqttCallbackCutShort({ end: this.#end, error, signal: this.signal })) {

            throw error;
          }

          this.#log.debug(MQTT_CONNECT_HANDLER_CANCELLED);
        }
      }, label: "MQTT connect", log: this.#log });
    }
  }

  /**
   * Deliver `payload` to every raw handler registered on `topic` - the test's hand on the broker side, standing in for an inbound message. Handlers are invoked in
   * registration order in a single pass, and the pass is awaited as a whole, so every effect they produce is settled by the time this resolves.
   *
   * Once {@link TestMqttClient.end} has begun, the delivery returns without looking up a registration, as the client's message dispatch is quiet from then on.
   *
   * @param topic   - The recorded topic to deliver on, matched exactly against {@link TestMqttSubscription.topic}.
   * @param payload - The message payload. A string is converted to a `Buffer` first, since a `Buffer` is what the client hands a handler.
   */
  public async deliver(topic: string, payload: Buffer | string): Promise<void> {

    // The client's message dispatch returns before its lookup once the end has begun, so the delivery does too.
    if(this.#end.kind !== "open") {

      return;
    }

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
   * whose {@link TestMqttClient.end} has begun, or that has aborted, is the exception: it answers quietly without looking up a registration, since the client
   * answers no get once its end has begun and teardown released every registration on the way down.
   *
   * @param topicSuffix - The tail to match. The first get registration whose recorded topic ends with it is the one that runs; on a live double, matching none of
   *                      them throws.
   *
   * @returns The getter's value, or `undefined` once the end has begun or the double has aborted - the one arm that answers without a getter having run.
   */
  public async invokeGet(topicSuffix: string): Promise<string | undefined> {

    // Teardown released every registration, so a driver call on an aborted double could only ever miss, and the client answers no get once its end has begun.
    // Answering quietly in each case is the no-op posture the class documents for every method after abort, and it keeps a consumer's own shutdown path drivable
    // without a scenario having to know where the double's end stands.
    if(this.signal.aborted || (this.#end.kind !== "open")) {

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

    // The same `kind`-established assertion the delivery path makes.
    const value = (entry.handler as MqttGetHandler)();

    // The recorded topic carries the `/get` suffix the client appended, so the republish goes to that topic with the suffix taken back off. The client's get path
    // answers a failed republish in its log rather than to a caller, and the driver takes the same posture: a refusal is absorbed here, already counted in
    // `rejectedPublishes`, and the getter's value is still what the caller asked for.
    await this.publish(entry.topic.slice(0, -MQTT_GET_SUFFIX.length), value).catch(() => { /* The refusal is counted, not answered. */ });

    return value;
  }

  /**
   * Run the setter registered on the topic ending in `topicSuffix` - the test's hand on an inbound set message. The setter receives the arguments the client passes
   * it: the lowercased value, the raw value, and this double's signal.
   *
   * The miss posture is {@link TestMqttClient.invokeGet}'s: on a live double an unmatched suffix throws with the registered set topics named, and on a double whose
   * {@link TestMqttClient.end} has begun, or that has aborted, the call returns quietly without running a setter, since the client dispatches no set once its end
   * has begun.
   *
   * @param topicSuffix - The tail to match. The first set registration whose recorded topic ends with it is the one that runs; on a live double, matching none of
   *                      them throws.
   * @param rawValue    - The raw message value, passed through as the setter's second argument and lowercased for its first.
   */
  public async invokeSet(topicSuffix: string, rawValue: string): Promise<void> {

    // The get driver's quiet posture, on the set side.
    if(this.signal.aborted || (this.#end.kind !== "open")) {

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

  // State the final words through the client's own sequence, then abort with the end's own abort. The state moves to stating with the window the sequence hands
  // back before its first handler, as on the client, and to closing just before the abort, so the abort listener reads it as the end's own and stays quiet, as the
  // client's teardown does.
  async #stateThenClose(grace: number, words: Promise<unknown[]>): Promise<unknown[]> {

    const refusals = await stateMqttFinalWords({ clock: this.#clock, grace, handlers: [...this.#endHandlers],
      onWindow: (window): void => { this.#end = { kind: "stating", window, words }; }, signal: this.signal });

    this.#end = { kind: "closing", words };
    this.abort();

    return refusals;
  }

  // The publish admission, stated once and run by each of `publish`'s admission passes. The client composes its lifetime signal with the caller's and short-circuits a
  // pre-aborted publish before anything reaches the wire, and composing the same way here is what makes a consumer's per-publish cancellation observable against the
  // double. The client then refuses a publish it has no session for before anything a broker could answer, so the double reads its own connection state before the
  // lever: a test that arms the lever while disconnected gets the offline refusal, because an arbitrary refusal a test arms stands for a broker that took the message
  // and said no, and there is no broker to say anything while the double is disconnected. A refusal records nothing, and the counter is what a test reads instead.
  // The end's admission is not part of this pass: `publish` reads it once, when the publish is issued, because the client reads its own then and never recalls a write it
  // has already handed to mqtt.js, so a publish parked before the end began records at release.
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

    // Refuse a tail still carrying a placeholder, after the registration guards, which is where the client's own subscribe refuses one. Every subscribe verb reaches
    // this, so the raw, get, and set paths all answer alike.
    assertResolvedMqttTopic("TestMqttClient", entry.topic);

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
