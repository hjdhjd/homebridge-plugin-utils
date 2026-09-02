/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-topics.ts: The MQTT topic vocabulary the client, its shipped test double, and every consumer compose their topics through.
 */

/**
 * The MQTT topic vocabulary every other MQTT module and every consumer reads: the device-scoped composer both `unsubscribe` verbs spell the `(id, topic)` tuple
 * through, the get and set suffixes the client appends to a subscription's topic, and the two functions that name a topic's get and set children.
 *
 * The module imports nothing, and that is the design rather than an accident of its size. The shipped test double reaches it, and so does the documentation renderer
 * that must stay free of every `node:` builtin to remain isomorphic. A value edge to `./util.ts` would carry `node:timers/promises` in behind it through
 * `clock.ts`, so the vocabulary stands on its own and every module above it - the transport-bearing client, the transport-free double, the renderer - composes the
 * same topics from the same statements.
 *
 * @module
 */

/**
 * The suffix the client appends to a topic to name the child a get request arrives on. A `"true"` message there asks for a republish on the parent topic.
 *
 * The constant is what a reader taking a child apart again works from: {@link mqtt-client-double!TestMqttClient.invokeGet | TestMqttClient.invokeGet} strips exactly
 * this much off a recorded topic to recover the parent it republishes to. A reader composing a child rather than splitting one names it through
 * {@link mqttGetTopic}.
 *
 * @category Utilities
 */
export const MQTT_GET_SUFFIX = "/get";

/**
 * The suffix the client appends to a topic to name the child a set message arrives on. Each message that arrives there carries the value the setter is asked to
 * apply.
 *
 * @category Utilities
 */
export const MQTT_SET_SUFFIX = "/set";

/**
 * Name the get child of a topic tail: the tail with {@link MQTT_GET_SUFFIX} appended.
 *
 * This is the one home of the get join, for the reason {@link mqttTopic} is the one home of the identity join - a convention repeated at each site drifts one site at
 * a time, and a convention stated once cannot. The client's own {@link mqttClient!MqttClient.subscribeGet | MqttClient.subscribeGet}, the double's registrations, the
 * documentation renderer's subscribed rows, and a consumer releasing a child through `unsubscribe(id, mqttGetTopic(entry.topic))` all spell it here.
 *
 * @param topic - The topic tail whose get child is being named.
 *
 * @returns The child topic a get request arrives on.
 *
 * @category Utilities
 */
export function mqttGetTopic(topic: string): string {

  return topic + MQTT_GET_SUFFIX;
}

/**
 * Name the set child of a topic tail: the tail with {@link MQTT_SET_SUFFIX} appended.
 *
 * The get child's rationale, on the set side: {@link mqttClient!MqttClient.subscribeSet | MqttClient.subscribeSet}, the double's registrations, the renderer's
 * subscribed rows, and a consumer releasing a child through `unsubscribe(id, mqttSetTopic(entry.topic))` all reach the same statement.
 *
 * @param topic - The topic tail whose set child is being named.
 *
 * @returns The child topic a set message arrives on.
 *
 * @category Utilities
 */
export function mqttSetTopic(topic: string): string {

  return topic + MQTT_SET_SUFFIX;
}

/**
 * Compose the topic tail for one owner's MQTT topic: the owner's identity as the leading segment, joined to the topic tail by a single slash. The client prepends the
 * topic prefix its configuration carries and nothing else, so the topic the broker sees is `prefix/id/topic`.
 *
 * Every publisher and subscriber in a plugin spells a device-scoped topic through this function rather than repeating the concatenation at each site, and the two
 * verbs that receive the tuple already split - {@link mqttClient!MqttClient.unsubscribe | MqttClient.unsubscribe} and
 * {@link mqtt-client-double!TestMqttClient.unsubscribe | TestMqttClient.unsubscribe} - rebuild the tail through it as well, so the convention has exactly one home.
 *
 * The identity is scope-agnostic: a device identity and a controller identity are both just the leading segment, so one composer serves a per-device topic and a
 * controller's own telemetry topic alike. The parameters are positional rather than named because the two strings arrive in wire order, and that order is the whole
 * of what the function states.
 *
 * @param id    - The identity the topic addresses, spelled as the device or controller is addressed everywhere else.
 * @param topic - The topic tail relative to that identity, carried through verbatim however many segments it holds.
 *
 * @returns The composed topic tail.
 *
 * @example
 *
 * ```ts
 * import { mqttTopic } from "homebridge-plugin-utils";
 *
 * // The broker sees the client's configured topic prefix followed by this tail.
 * await mqtt.publish(mqttTopic(device.mac, "motion"), "true");
 * ```
 *
 * @category Utilities
 */
export function mqttTopic(id: string, topic: string): string {

  return id + "/" + topic;
}
