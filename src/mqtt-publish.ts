/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-publish.ts: The MQTT publish-outcome vocabulary the client and its shipped test double share.
 */

/**
 * The MQTT publish-outcome vocabulary the client and its shipped test double share: the error a publish is refused with while the client holds no broker session, the
 * pure router that classifies a guarded publish's failure into the one line that reports it, and the per-topic memory a change-gated publish is answered against.
 *
 * All three live here rather than beside the client because the double stands in for the client without standing in for its transport. The double's only edge to
 * `mqttClient.ts` is a type import, which the compiler erases, and the `/testing` entry point aggregates every shipped double...so a value import from the client
 * would pull the mqtt package and everything under it into the load closure of any consumer test process that reaches for any double at all. This module carries no
 * runtime dependency beyond `./util.ts`, which lets the client and the double share one refusal and one classification without either one paying for a broker
 * library. The memory is here for the same reason: the double has to answer "is this the same payload?" exactly as the client does, and one class the two of them
 * import by value is what keeps them from drifting on the comparison or on how a payload is kept.
 *
 * @module
 */
import { formatErrorMessage, isHbpuAbortError } from "./util.ts";
import type { HomebridgePluginLogging } from "./util.ts";

/**
 * Rejected by {@link mqttClient!MqttClient.publish | MqttClient.publish} when the client holds no session with the broker: before the first CONNACK arrives, after a
 * transport failure drops the connection, after the broker closes it, and from the moment the client aborts. That set is exactly the window in which
 * {@link mqttClient!MqttClient.connected | MqttClient.connected} reads `false`, which is the reading a consumer can take for itself before it even attempts a publish.
 *
 * The posture behind the error is refusal rather than queuing. QoS 0 is at-most-once by definition, so a publish that cannot go out has no delivery guarantee left to
 * preserve by being held: retaining it grows memory for as long as the outage lasts, with no bound and no signal to the caller, and flushing the backlog on reconnect
 * delivers hours-old state changes and events to the broker as though they had just happened. Refusing on the spot keeps memory flat and keeps the broker's view of
 * the plugin honest...the caller learns immediately, and the next state change publishes normally once the session is back.
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
 * - An offline refusal comes third. It is not a delivery fault, and it drops to debug because the outage that produced it is reported at error level by the client's
 *   broker error line: on every retry while reconnection is armed, once and as final when reconnection is disabled, and before the first CONNACK the connection is
 *   still being established, with its outcome reaching the log either way.
 *
 * Everything else is a genuine failure, and lands at error level naming the topic and the reason.
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
 * The last payload each topic went out with through a change-gated publish, kept per client so that such a publish goes out only when the payload moved.
 *
 * The client holds one behind the `ifChanged` option of {@link mqttClient!MqttPublishInit | MqttPublishInit}, and the shipped double holds its own mirror. A plugin
 * reaches the behavior through that option and never constructs one of these itself.
 *
 * Two payloads are the same when they are equal strings, or when they are Buffers carrying the same bytes. A string and a Buffer are never the same, whatever their
 * bytes: a topic's payloads are one kind or the other, and comparing across kinds would encode every string on the hot path to answer a question no caller asks.
 *
 * @category Utilities
 */
export class MqttLastPayloads {

  // The last payload delivered on each topic, keyed by the topic exactly as the caller spells it.
  readonly #payloads = new Map<string, Buffer | string>();

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

    const last = this.#payloads.get(topic);

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
   * Remember `payload` as what `topic` last went out with, replacing whatever was remembered for it.
   *
   * A Buffer is copied rather than kept by reference, so a caller that fills one scratch buffer per pass is weighed against the bytes it actually delivered rather
   * than against whatever that buffer holds by the time the next publish asks. A string is kept as it is, since nothing can rewrite it.
   *
   * @param topic   - The topic to remember under.
   * @param payload - The payload that went out.
   */
  public remember(topic: string, payload: Buffer | string): void {

    this.#payloads.set(topic, (typeof payload === "string") ? payload : Buffer.from(payload));
  }

  /**
   * Forget every topic, so the next change-gated publish on each one goes out. The client clears its memory on every connect and at teardown, and the double clears
   * its own when a session is restored and at abort.
   */
  public clear(): void {

    this.#payloads.clear();
  }
}
