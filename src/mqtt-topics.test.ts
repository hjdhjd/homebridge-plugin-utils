/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-topics.test.ts: Unit tests for the MQTT topic vocabulary - the device-scoped topic composer, the get and set suffixes, and the two functions that name a
 * topic's children.
 *
 * Every row drives a pure function directly with its own strings, since the vocabulary holds no state and reaches nothing. The wire literals the rows assert are the
 * same ones the client and double suites pin on their own registrations, so a drift here and a drift there cannot pass each other.
 */
import { MQTT_GET_SUFFIX, MQTT_SET_SUFFIX, mqttGetTopic, mqttSetTopic, mqttTopic } from "./mqtt-topics.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("mqttTopic - device-scoped topic composition", () => {

  // The two identities the rows compose. The composer branches on nothing, so a device identity and a controller identity are here to state that rather than to
  // exercise separate paths.
  const DEVICE_ID = "AABBCCDDEEFF";
  const CONTROLLER_ID = "112233445566";

  test("joins a single-segment topic tail to the id with one slash", () => {

    assert.equal(mqttTopic(DEVICE_ID, "motion"), "AABBCCDDEEFF/motion", "the id must be the leading segment, joined to the tail by a single slash");
  });

  test("passes a multi-segment topic tail through unchanged", () => {

    // Everything after the joining slash belongs to the tail, which the client forwards verbatim behind its configured prefix.
    assert.equal(mqttTopic(DEVICE_ID, "motion/smart/person/metadata"), "AABBCCDDEEFF/motion/smart/person/metadata",
      "a multi-segment tail must keep every one of its segments after the joining slash");
    assert.equal(mqttTopic(DEVICE_ID, "sidedoor/lock"), "AABBCCDDEEFF/sidedoor/lock", "a two-segment tail must compose the same way");
  });

  test("is scope-agnostic, composing a controller identity the same way as a device identity", () => {

    assert.equal(mqttTopic(CONTROLLER_ID, "telemetry"), "112233445566/telemetry", "a controller's own topic must compose identically to a device topic");
  });
});

describe("MQTT_GET_SUFFIX and MQTT_SET_SUFFIX - the child suffix vocabulary", () => {

  test("names the get and set suffixes the client appends", () => {

    assert.equal(MQTT_GET_SUFFIX, "/get", "the get suffix is the wire text every get registration ends in");
    assert.equal(MQTT_SET_SUFFIX, "/set", "the set suffix is the wire text every set registration ends in");
  });
});

describe("mqttGetTopic and mqttSetTopic - child topic composition", () => {

  test("names the get and set children of a single-segment tail", () => {

    assert.equal(mqttGetTopic("motion"), "motion/get", "a get child is the tail with the get suffix appended");
    assert.equal(mqttSetTopic("motion"), "motion/set", "a set child is the tail with the set suffix appended");
  });

  test("keeps a multi-segment tail whole under either child", () => {

    // Everything the caller handed over stays in front of the suffix, which is what lets a nested tail like a side door's lock name its own children.
    assert.equal(mqttGetTopic("sidedoor/lock"), "sidedoor/lock/get", "a multi-segment tail keeps every segment ahead of the get suffix");
    assert.equal(mqttSetTopic("sidedoor/lock"), "sidedoor/lock/set", "a multi-segment tail keeps every segment ahead of the set suffix");
  });

  test("composes a child from the suffix constant, so the two cannot disagree", () => {

    // The strip in the double's get driver reads the constant back off a composed child, so this row states the round trip the two sides share.
    const child = mqttGetTopic("light/brightness");

    assert.equal(child.slice(0, -MQTT_GET_SUFFIX.length), "light/brightness", "stripping the constant off a composed child recovers the parent tail");
  });
});
