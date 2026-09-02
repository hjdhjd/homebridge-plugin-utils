/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-publish.ts: The MQTT publish-outcome vocabulary the client and its shipped test double share.
 */

/**
 * The MQTT publish-outcome vocabulary the client and its shipped test double share: the error a publish is refused with while the client holds no broker session, and
 * the pure router that classifies a guarded publish's failure into the one line that reports it.
 *
 * Both live here rather than beside the client because the double stands in for the client without standing in for its transport. The double's only edge to
 * `mqttClient.ts` is a type import, which the compiler erases, and the `/testing` entry point aggregates every shipped double...so a value import from the client
 * would pull the mqtt package and everything under it into the load closure of any consumer test process that reaches for any double at all. This module carries no
 * runtime dependency beyond `./util.ts`, which lets the client and the double share one refusal and one classification without either one paying for a broker
 * library.
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
