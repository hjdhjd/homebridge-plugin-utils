/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-publish.ts: The MQTT publish-outcome vocabulary and the graceful end the client and its shipped test double share.
 */

/**
 * The MQTT publish-outcome vocabulary and the graceful end the client and its shipped test double share: the error a publish is refused with while the client holds
 * no broker session, the pure router that classifies a guarded publish's failure into the one line that reports it, the per-topic memory a change-gated publish is
 * answered against, the sequence that states a plugin's final words before the client tears down, with its default grace and the warning a teardown logs when
 * words go unsaid, the end's state with the admission a publish faces once the end has begun, and the check that tells a callback the end or the abort cut short apart
 * from one that failed, with the line each owner logs for a connect handler cut short.
 *
 * Every piece lives here rather than beside the client because the double stands in for the client without standing in for its transport. The double's only edge
 * to `mqttClient.ts` is a type import, which the compiler erases, and the `/testing` entry point aggregates every shipped double...so a value import from the client
 * would pull the mqtt package and everything under it into the load closure of any consumer test process that reaches for any double at all. This module carries no
 * runtime dependency beyond `./util.ts` and `./clock.ts`, which lets the client and the double share every piece here while the double pays for no broker
 * library. The memory is here for the same reason: the double has to answer "is this the same payload?" exactly as the client does, and one class the two of them
 * import by value is what keeps them from drifting on the comparison or on how a payload is kept. The end sequence is here for it too: the grace, the order the
 * words are stated in and the warning have one definition, so a consumer's suite on the double sees the end a plugin meets on the client. So are the end's state, its
 * admission, the check and the connect handler's cancelled line, which is what keeps the two from disagreeing about which publish the end lets through, which failure is
 * a cancellation, and how a cancelled connect handler reads in the log.
 *
 * @module
 */
import { HbpuAbortError, composeSignals, formatErrorMessage, isHbpuAbortError, waitWithSignal } from "./util.ts";
import { armDeadline, yieldMacrotask } from "./clock.ts";
import type { Clock } from "./clock.ts";
import type { HomebridgePluginLogging } from "./util.ts";

/**
 * Rejected by {@link mqttClient!MqttClient.publish | MqttClient.publish} when the client holds no session with the broker: before the first CONNACK arrives, after a
 * transport failure drops the connection, after the broker closes it, and from the moment the client aborts. That set is exactly the window in which
 * {@link mqttClient!MqttClient.connected | MqttClient.connected} reads `false`, which is the reading a consumer can take for itself before it even attempts a publish.
 *
 * The posture behind the error is refusal rather than queuing. QoS 0 is at-most-once by definition, so a publish that cannot go out has no delivery guarantee left to
 * preserve by being held: retaining it grows memory for as long as the outage lasts, with no bound and no signal to the caller, and flushing the backlog on reconnect
 * delivers hours-old state changes and events to the broker as though they had just happened. Refusing on the spot keeps memory flat and keeps the broker's view of
 * the plugin honest...the caller learns immediately, and the next state change publishes normally once the session is back. A consumer holding state a subscriber may
 * have missed in the meantime restates it for itself from {@link mqttClient!MqttClient.onConnect | MqttClient.onConnect}, which runs on every session the client
 * establishes until {@link mqttClient!MqttClient.end | MqttClient.end} begins.
 *
 * {@link mqttClient!MqttClient.publishGuarded | MqttClient.publishGuarded} has no caller to answer, so it absorbs the refusal into a single debug line. A consumer
 * awaiting {@link mqttClient!MqttClient.publish | MqttClient.publish} directly tells the refusal apart from a delivery failure with `error instanceof
 * MqttOfflineError`.
 *
 * @category Utilities
 */
export class MqttOfflineError extends Error {

  public override readonly name = "MqttOfflineError" as const;

  public constructor(message = "The MQTT client is not connected to the broker.") {

    super(message);
  }
}

// Tell a cancelled publish apart from a failed one by the shape of the thrown value, as the fallback behind the signal-state read in the router below. The signals
// are what actually say whether a publish was cancelled, so they answer first; this covers the rejection they leave ambiguous, where a genuine failure and a teardown
// race and only the thrown value carries the answer. Both cancellation shapes a caller can produce are covered: HBPU's own lifecycles reject with an
// `HbpuAbortError`, while a consumer that hands `publish` a raw `AbortController` signal gets the platform's `DOMException`, whose `name` is "AbortError". Neither is
// a delivery fault. The check stays local to this module on purpose - it answers one question for one method, and the broader transport-failure taxonomy already has
// its own home in `routeMqttBrokerError`.
function isPublishCancellation(error: unknown): boolean {

  return isHbpuAbortError(error) || ((error instanceof Error) && (error.name === "AbortError"));
}

/**
 * Route a guarded publish's failure to the log line that reports it. Pure void function: no class state, no mqtt.js handles, no closure over a live client. The
 * client's own guarded path and the shipped double's counterpart both hand it the rejection and the signals that govern the publish, which is what keeps the two from
 * classifying the same outcome differently.
 *
 * The order the terms are read in is what makes the classification correct rather than merely plausible:
 *
 * - The signals answer first. A caller may abort with any reason it likes - a bare string, a custom error, nothing at all - and `publish` rejects with that reason
 *   verbatim, so only the signals governing this publish can say whether it was cancelled. A genuine delivery failure that loses a race with an abort lands on the
 *   quiet path too, which is the intent: once teardown is under way, a string of delivery failures on the way out tells a reader nothing they can act on.
 * - The thrown cancellation shapes come second, covering the rejection that arrives with neither signal reading aborted.
 * - An offline refusal comes third. It is not a delivery fault, and it drops to debug because the client's broker error line already reports the outage that
 *   produced it. That line reports a reason at error level the first time it appears; while reconnection is armed, each retry that fails for the same reason
 *   replays at debug until the reason changes or a session is established, and when reconnection is disabled the one report is final. Before the first CONNACK the
 *   connection is still being established, with its outcome reaching the log either way.
 *
 * Everything else is a genuine failure, and lands at error level naming the topic and the reason. The client's guarded path and the shipped double's counterpart
 * both run this router inside a repeat-demoting attempt, so a genuine failure whose reason matches the one the previous attempt failed with replays at debug instead.
 * {@link guardedPublishReason} owns the reason each failure is weighed by.
 *
 * @param options               - The publish's outcome and the signals that govern it.
 * @param options.clientSignal  - The lifetime signal of the client that issued the publish.
 * @param options.error         - The value the publish rejected with, unchanged.
 * @param options.log           - Logger that receives the routed line.
 * @param options.publishSignal - The caller's per-publish signal, when one was supplied.
 * @param options.topic         - The topic to name in the line, in whatever form the caller reports topics.
 *
 * @category Utilities
 */
export function routeGuardedPublishFailure(options: { clientSignal: AbortSignal; error: unknown; log: HomebridgePluginLogging; publishSignal?: AbortSignal;
  topic: string; }): void {

  const { clientSignal, error, log, publishSignal, topic } = options;

  if(clientSignal.aborted || (publishSignal?.aborted === true) || isPublishCancellation(error)) {

    log.debug("MQTT publish aborted: %s.", topic);

    return;
  }

  if(error instanceof MqttOfflineError) {

    log.debug("MQTT publish dropped while disconnected from the broker: %s.", topic);

    return;
  }

  log.error("Unable to publish to the MQTT topic %s: %s.", topic, formatErrorMessage(error));
}

/**
 * Name the reason a guarded publish rejected, as the tag a repeat is weighed against the next by. Pure function: it reads the rejection and nothing else, which is
 * what lets the client and the shipped double answer the same question the same way rather than each deriving a tag of its own.
 *
 * The transport's own code is the tag wherever the rejection carries one, because a broker refusing for a single reason refuses every topic for it: the topic
 * belongs in the reported line rather than in the tag, or one outage would read as a fresh fault per topic. Everything else answers the rendered message, which is
 * the most specific thing a rejection carrying no code has to offer.
 *
 * Every rejection is tagged, the quiet ones included, and that costs them nothing: {@link routeGuardedPublishFailure} reports a cancellation and an offline refusal
 * at debug, and a repeat-demoting adapter holds error and warn alone, so those lines reach the log live whatever tag the attempt settles with. The one visible
 * consequence is that a cancellation landing between two identical delivery failures changes the tag and makes the second failure report in full again, which is
 * louder rather than quieter and is the right direction for a log-volume mechanism to fail in.
 *
 * @param error - The value the publish rejected with, unchanged.
 *
 * @returns The tag this rejection is weighed by.
 *
 * @category Utilities
 */
export function guardedPublishReason(error: unknown): string {

  if((error instanceof Error) && ("code" in error) && (typeof error.code === "string")) {

    return error.code;
  }

  return formatErrorMessage(error);
}

/**
 * The last payload each topic was issued with through a change-gated publish, kept per client so that such a publish goes out only when the payload moved.
 *
 * The client holds one behind the `ifChanged` option of {@link mqttClient!MqttPublishInit | MqttPublishInit}, and the shipped double holds its own mirror. A plugin
 * reaches the behavior through that option and never constructs one of these itself.
 *
 * A payload is remembered when its publish is issued, so a change-gated publish issued before an earlier one completes is weighed against the earlier payload.
 * Each remember mints a token for that write, and the holder of a publish that fails once issued hands the token to {@link MqttLastPayloads.forget}, which
 * empties the topic only while the topic's entry still carries it, so the retry goes out and a later publish that has taken the topic since keeps its own entry.
 *
 * Two payloads are the same when they are equal strings, or when they are Buffers carrying the same bytes. A string and a Buffer are never the same, whatever their
 * bytes: a topic's payloads are one kind or the other, and comparing across kinds would encode every string on the hot path to answer a question no caller asks.
 *
 * @category Utilities
 */
export class MqttLastPayloads {

  // The last payload issued on each topic beside the token its write was given, keyed by the topic exactly as the caller spells it.
  readonly #payloads = new Map<string, { readonly payload: Buffer | string; readonly token: object }>();

  /**
   * Answer whether `payload` is what was last remembered for `topic`.
   *
   * @param topic   - The topic to read, spelled as the caller spells its topics.
   * @param payload - The payload to weigh against what was remembered.
   *
   * @returns `true` when a payload was remembered for `topic` and it is the same one, and `false` otherwise, so the first change-gated publish on any topic goes
   *          out.
   */
  public sameAsLast(topic: string, payload: Buffer | string): boolean {

    const last = this.#payloads.get(topic)?.payload;

    if(last === undefined) {

      return false;
    }

    // A string on either side settles the answer by value, which is both halves of the cross-kind rule in one comparison: two strings match when they read the same,
    // and a string never matches a Buffer.
    if((typeof last === "string") || (typeof payload === "string")) {

      return last === payload;
    }

    return last.equals(payload);
  }

  /**
   * Remember `payload` as what `topic` was last issued with, replacing whatever was remembered for it, and answer the token minted for this write.
   *
   * A Buffer is copied rather than kept by reference, so a caller that fills one scratch buffer per pass is weighed against the bytes it issued rather than against
   * whatever that buffer holds by the time the next publish asks. A string is kept as it is, since nothing can rewrite it.
   *
   * @param topic   - The topic to remember under.
   * @param payload - The payload being issued.
   *
   * @returns A token that belongs to this write alone, which is what {@link MqttLastPayloads.forget} takes if the publish that issued it fails.
   */
  public remember(topic: string, payload: Buffer | string): object {

    const token = {};

    this.#payloads.set(topic, { payload: (typeof payload === "string") ? payload : Buffer.from(payload), token });

    return token;
  }

  /**
   * Forget what `topic` holds when its entry still carries `token`, so the next change-gated publish on the topic goes out whatever its payload.
   *
   * Each remember mints its own token, so the test answers whether the entry is still the failed publish's own write, never whether the payloads match. A later
   * publish remembered on the topic since carries a token of its own, so its entry stays even when its payload is the same string or the same bytes, and a caller
   * that rewrote its scratch buffer after the publish was issued cannot keep the failed payload remembered.
   *
   * @param topic - The topic to forget.
   * @param token - The token `remember` answered for the publish that failed.
   */
  public forget(topic: string, token: object): void {

    if(this.#payloads.get(topic)?.token === token) {

      this.#payloads.delete(topic);
    }
  }

  /**
   * Forget every topic, so the next change-gated publish on each one goes out. The client clears its memory on every connect and at teardown, and the double clears
   * its own when a session is restored and at abort.
   */
  public clear(): void {

    this.#payloads.clear();
  }
}

/**
 * The grace {@link mqttClient!MqttClient.end | MqttClient.end} gives a plugin's final words when its caller names none, in milliseconds.
 *
 * A second is long enough for a retained word to reach a broker on the local network many times over, and short enough to fit well inside the window Homebridge
 * gives a shutdown before it ends the process, leaving room for everything else a plugin tears down.
 *
 * @category Utilities
 */
export const MQTT_DEFAULT_END_GRACE_MS = 1000;

/**
 * The warning a teardown logs when a plugin's final words go unsaid: the client was aborted - directly, through a parent signal, or while `end()` was still stating
 * the words - while {@link mqttClient!MqttClient.onEnd | MqttClient.onEnd} registrations were held. Its one format argument is the number of registrations held.
 *
 * The client logs it from its teardown and the shipped double from its abort, each on its own logger, so a plugin's log names the misorder in the field and a
 * consumer's suite reads the same line on the double.
 *
 * @category Utilities
 */
export const MQTT_UNSAID_WORDS_WARNING = "The MQTT client was aborted before end() finished, so its final words went unsaid (onEnd registrations held: %d); await " +
  "end() so it runs before the client's signal is aborted.";

/**
 * The line a connect handler is reported with at debug when the owner's own lifecycle cut it short - an `HbpuAbortError` once the end has begun, a refused publish among
 * them, or any failure once the owner has aborted - rather than when it failed on its own terms. {@link isMqttCallbackCutShort} tells the two apart.
 *
 * The client logs it from its connect pass and the shipped double from its own, each on its own logger, so a consumer's suite reads on the double the line a plugin's log
 * carries in the field.
 *
 * @category Utilities
 */
export const MQTT_CONNECT_HANDLER_CANCELLED = "The MQTT connect handler was cancelled before completion.";

/**
 * State a plugin's final words: the sequence {@link mqttClient!MqttClient.end | MqttClient.end} and the shipped double's `end()` each run before they tear down.
 *
 * One window bounds the whole statement, closing when the grace runs out on `clock` or when `signal`, the owner's lifetime, aborts, whichever comes first. The
 * window goes to `onWindow` once it is composed and before any handler runs, which is where an owner records it as the signal its end admits a publish under, so
 * a word a handler issues synchronously meets an end that already knows its window. Each handler is then invoked synchronously, in the order given, with the
 * window's signal and before anything is awaited, so every word is issued while the owner still holds its session, and a handler that throws has refused exactly
 * as one whose promise rejects has. The wait for the words is bounded by the window, so a word still unsettled when it closes refuses with the window's reason -
 * the deadline's `TimeoutError`, or the owner's abort reason - and a handler that never settles holds shutdown for the grace at most. Once every word has settled,
 * the sequence yields one turn of the event loop through {@link clock!yieldMacrotask | yieldMacrotask}, because mqtt.js reports a publish written while its bytes
 * are still corked and hands them to the socket on a deferred tick: an owner that tore its connection down on the same turn would destroy them unsent.
 *
 * @param options          - The words to state and the window that bounds them.
 * @param options.clock    - The time source the grace is armed on.
 * @param options.grace    - The grace, in milliseconds. The caller has already refused one that is not a positive, finite number.
 * @param options.handlers - A snapshot of the registered handlers, in registration order. See {@link mqttClient!MqttEndHandler | MqttEndHandler}.
 * @param options.onWindow - Invoked once, synchronously, with the window each handler is then handed. It runs outside the isolation each handler gets, so it must
 *                           not throw; each owner's callback only assigns its end's state.
 * @param options.signal   - The owner's lifetime signal.
 *
 * @returns The refusals, in registration order: the value each refusing handler threw or rejected with, or the window's reason for one still unsettled when it
 *          closed. A word that settled leaves nothing behind, so an end whose every word was stated resolves an empty array. Never rejects.
 *
 * @category Utilities
 */
export async function stateMqttFinalWords({ clock, grace, handlers, onWindow, signal }: { clock: Clock; grace: number;
  handlers: readonly ((signal: AbortSignal) => Promise<void> | void)[]; onWindow: (window: AbortSignal) => void; signal: AbortSignal; }): Promise<unknown[]> {

  using deadline = armDeadline(grace, { clock });

  const endWindow = composeSignals(signal, deadline.signal);

  onWindow(endWindow);

  /* Each word is an async function called here, so its handler runs synchronously, in registration order, before the first await below, and a handler that
   * throws rejects its own word rather than escaping the pass and skipping the handlers after it. The wait on what a handler returns is bounded by the window
   * rather than left to the handler, because a plugin's publish may ignore the signal it was handed, and an unbounded wait on it would hold Homebridge's shutdown
   * for as long as the broker stayed silent.
   */
  const words = handlers.map(async (handler): Promise<void> => {

    await waitWithSignal(Promise.resolve(handler(endWindow)), endWindow);
  });

  const outcomes = await Promise.allSettled(words);

  await yieldMacrotask();

  return outcomes.flatMap((outcome): unknown[] => (outcome.status === "rejected") ? [outcome.reason as unknown] : []);
}

/**
 * Where an MQTT owner's graceful end stands: not begun, stating the final words, or closing with the abort that follows them. The client and the shipped double
 * each hold one, and that one value answers every question the end raises - whether `end()` has begun, the promise a repeat call is handed, whether a teardown is
 * the end's own, and which signal a publish is admitted under while the words are stated - so those answers cannot disagree.
 *
 * - `open`    - The end has not begun.
 * - `stating` - The end is stating the words. `window` is the signal {@link stateMqttFinalWords} hands each handler, recorded before the first one runs, and
 *               `words` is the promise `end()` returned.
 * - `closing` - The words have settled, and the end's own abort follows in the same turn. `words` is that same promise.
 *
 * @category Utilities
 */
export type MqttEndState = { readonly kind: "open" } | { readonly kind: "stating"; readonly window: AbortSignal; readonly words: Promise<unknown[]> } |
  { readonly kind: "closing"; readonly words: Promise<unknown[]> };

/**
 * Refuse a publish the graceful end does not admit. Pure function: it reads the end's state and the publish's own signal and nothing else, and the client's
 * publish and the shipped double's each call it by value, so neither can let through a publish the other refuses while the words are stated.
 *
 * The rule is identity. Before the end begins every publish is admitted here. While it is stating, a publish is admitted only when its own signal is the very
 * signal the end handed its handlers, and one with no signal or with any other signal is refused, a signal composed from the window and a second signal among
 * them. A signal composed from the window and nothing else is the window itself, since composing a single signal hands it back unchanged, so a word passed
 * through that way is admitted. Once the end is closing nothing is admitted, though by then an owner's abort check answers ahead of this one.
 *
 * The refusal is a cancellation rather than a fault: `HbpuAbortError("shutdown")` reaches a guarded publish's aborted line at debug and nothing else, so a state
 * loop still publishing while the words are stated goes quiet without the plugin having to quiet it first.
 *
 * @param options        - The end's state and the publish's signal.
 * @param options.end    - Where the owner's end stands. See {@link MqttEndState}.
 * @param options.signal - The publish's own signal as its caller supplied it, never one composed with the owner's lifetime, which is never the window.
 *
 * @throws `HbpuAbortError("shutdown")` once the end has begun, unless the end is stating and `signal` is its window.
 *
 * @category Utilities
 */
export function assertAdmittedDuringMqttEnd({ end, signal }: { end: MqttEndState; signal?: AbortSignal }): void {

  if((end.kind === "open") || ((end.kind === "stating") && (signal === end.window))) {

    return;
  }

  throw new HbpuAbortError("shutdown");
}

/**
 * Answer whether a consumer callback an MQTT owner wraps - a raw message handler, a setter or a connect handler - or the response publish that answers a get was cut
 * short by the owner's own lifecycle rather than failing on its own terms. Pure function: it reads the failure, the end's state and the owner's lifetime signal and
 * nothing else, and the client and the shipped double each call it by value, so neither can report as a fault what the other reports as a cancellation.
 *
 * A callback was cut short when it fails with an {@link HbpuAbortError} once the end has begun, or fails in any way once the owner's signal has aborted. An
 * `HbpuAbortError` is what the end hands a callback still running: a publish it issues once the end has begun is refused with `HbpuAbortError("shutdown")` through
 * {@link assertAdmittedDuringMqttEnd}. Once the owner's signal has aborted the failure's shape says nothing, because an owner may be aborted with any reason - a parent
 * signal's bare `abort()` among them - and a publish then rejects with that reason verbatim, so the signal's state answers alone. That is the rule a setter lives under
 * through {@link util!runWithAbort | runWithAbort}, which answers `null` once its signal has aborted whatever the setter threw, so a raw handler, a connect handler and a
 * get's response read a teardown as a setter does. At any other time a failure is the callback's own - its own work timing out with `HbpuAbortError("timeout")` among
 * them - and keeps the line that reports a failure with its reason.
 *
 * @param options        - The callback's failure and the owner's state.
 * @param options.end    - Where the owner's end stands. See {@link MqttEndState}.
 * @param options.error  - The value the callback threw or rejected with, unchanged.
 * @param options.signal - The owner's lifetime signal itself, never one composed from it, which would also abort on a deadline of the callback's own.
 *
 * @returns `true` when `error` is an `HbpuAbortError` and the end has begun, or when `signal` has aborted whatever `error` is, and `false` otherwise.
 *
 * @category Utilities
 */
export function isMqttCallbackCutShort({ end, error, signal }: { end: MqttEndState; error: unknown; signal: AbortSignal }): boolean {

  return (isHbpuAbortError(error) && (end.kind !== "open")) || signal.aborted;
}
