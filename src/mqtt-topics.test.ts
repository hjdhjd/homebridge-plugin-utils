/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-topics.test.ts: Unit tests for the MQTT topic vocabulary - the composer, the get and set children, the placeholder grammar, the parameter resolver, the shared
 * refusal, and the catalog builder.
 *
 * Every row drives a pure function directly with its own strings, since the vocabulary holds no state and reaches nothing. The wire literals the rows assert are the
 * same ones the client and double suites assert on their own registrations, so a drift here and a drift there cannot pass each other. The compile-time half of the
 * placeholder contract lives in `_catalogShapeExercises`, which never runs and is owned by the typecheck gate alone; the runtime half is driven here through topics
 * typed `string`, which is the widened form a plugin reaches by declaring its catalog through plain constants.
 */
import { MQTT_DEVICE_COLUMN, MQTT_GET_SUFFIX, MQTT_SET_SUFFIX, assertResolvedMqttTopic, mqttGetTopic, mqttSetTopic, mqttTopic, mqttTopicCatalog,
  mqttTopicPlaceholders, resolveMqttTopic } from "./mqtt-topics.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Hand a topic back typed `string` rather than as its own literal: the widened form a plugin reaches by declaring its catalog through plain constants, where the
// compile-time guard is silent and the runtime refusals are the whole of the contract.
function widened(topic: string): string {

  return topic;
}

/* Compile-time shape exercises for the catalog and the composers. These never run - the function is never called, and its leading underscore marks it, with its
 * bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals; TypeScript still type-checks the body during
 * `npm run typecheck`, so a shape regression fails the build here rather than silently at a consuming plugin. Every negative case uses `@ts-expect-error`, which
 * fails the build if the error it expects ever stops occurring.
 */
const _catalogShapeExercises = (): void => {

  const id = "AABBCCDDEEFF";

  const catalog = mqttTopicCatalog({

    lock: { devices: ["camera"], get: "A request to publish the state.", label: "lock", publish: "The lock state.", set: "The state to set.", topic: "lock" },
    smartMotion: { devices: [ "camera", "sensor" ], label: "smart motion", publish: "The smart detection event.", topic: "motion/smart/{object}" }
  }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

  // The positive controls. A plain tail composes, a topic the caller computed at runtime composes, and a template resolves against the names it spells.
  const _composed = mqttTopic(id, catalog.lock.topic);
  const _computed = mqttTopic(id, widened("device1/status"));
  const _resolved = resolveMqttTopic(catalog.smartMotion.topic, { object: "person" });

  // A near miss of a real field IS caught by the excess-property check, which is the positive control for the type-level half of the field guard.
  // @ts-expect-error - `lable` is not a field an entry declares.
  const _nearMiss = mqttTopicCatalog({ lock: { lable: "lock", publish: "The lock state.", topic: "lock" } });

  // @ts-expect-error - the record names a parameter the template does not.
  const _wrongParameter = resolveMqttTopic(catalog.smartMotion.topic, { objekt: "person" });

  // @ts-expect-error - the record is missing the parameter the template names.
  const _missingParameter = resolveMqttTopic(catalog.smartMotion.topic, {});

  // @ts-expect-error - an unresolved template never reaches the identity composer.
  const _unresolvedIdentity = mqttTopic(id, catalog.smartMotion.topic);

  // @ts-expect-error - an unresolved template never reaches the child composer either.
  const _unresolvedChild = mqttGetTopic(catalog.smartMotion.topic);

  // @ts-expect-error - an entry names a device kind the column's vocabulary does not declare.
  const _unknownDevice = mqttTopicCatalog({ lock: { devices: ["nope"], label: "lock", publish: "p", topic: "lock" } },
    { heading: "Protect Device Type", vocabulary: { camera: "Camera" } });

  // @ts-expect-error - an empty devices tuple names nothing.
  const _emptyDevices = mqttTopicCatalog({ lock: { devices: [], label: "lock", publish: "p", topic: "lock" } },
    { heading: "Protect Device Type", vocabulary: { camera: "Camera" } });

  // @ts-expect-error - under a column, every entry carries a devices list.
  const _missingDevices = mqttTopicCatalog({ lock: { label: "lock", publish: "p", topic: "lock" } },
    { heading: "Protect Device Type", vocabulary: { camera: "Camera" } });

  // @ts-expect-error - without a column, no entry carries one.
  const _strayDevices = mqttTopicCatalog({ lock: { devices: ["camera"], label: "lock", publish: "p", topic: "lock" } });

  // The positive controls for a verb's narrowing. The first names a kind its entry lists; the second names one the vocabulary declares and the entry does not,
  // which compiles because the vocabulary is the line this type draws, and which the renderer refuses at the docs build.
  const _narrowedGet = mqttTopicCatalog({

    lock: { devices: ["camera"], get: "A request to publish the state.", getDevices: ["camera"], label: "lock", publish: "The lock state.",
      set: "The state to set.", topic: "lock" },
    smartMotion: { devices: [ "camera", "sensor" ], label: "smart motion", publish: "The smart detection event.", topic: "motion/smart/{object}" }
  }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

  const _narrowedToVocabulary = mqttTopicCatalog({

    lock: { devices: ["camera"], get: "A request to publish the state.", getDevices: ["sensor"], label: "lock", publish: "The lock state.", topic: "lock" }
  }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

  // @ts-expect-error - a narrowing names a device kind the column's vocabulary does not declare.
  const _unknownNarrowing = mqttTopicCatalog({ lock: { devices: ["camera"], get: "A request.", getDevices: ["nope"], label: "lock", topic: "lock" } },
    { heading: "Protect Device Type", vocabulary: { camera: "Camera" } });

  // @ts-expect-error - an empty narrowing names nothing.
  const _emptyNarrowing = mqttTopicCatalog({ lock: { devices: ["camera"], get: "A request.", getDevices: [], label: "lock", topic: "lock" } },
    { heading: "Protect Device Type", vocabulary: { camera: "Camera" } });

  // @ts-expect-error - without a column, no entry carries a narrowing either.
  const _strayNarrowing = mqttTopicCatalog({ lock: { get: "A request.", getDevices: ["camera"], label: "lock", topic: "lock" } });

  // @ts-expect-error - an empty placeholder names no parameter, so nothing could ever resolve it.
  const _emptyPlaceholder = resolveMqttTopic("power{}/state", { "": "x" });

  // Groups declared `as const` and spread into the call keep every topic's literal type, so the guard holds through the assembled catalog.
  const doorGroup = { lock: { label: "lock", publish: "The lock state.", topic: "lock" } } as const;
  const motionGroup = { smartMotion: { label: "smart motion", publish: "The smart detection event.", topic: "motion/smart/{object}" } } as const;
  const fromConstGroups = mqttTopicCatalog({ ...doorGroup, ...motionGroup });

  // @ts-expect-error - the `as const` form still refuses an unresolved template.
  const _constGroupUnresolved = mqttTopic(id, fromConstGroups.smartMotion.topic);

  // The same groups without `as const` widen every topic to `string`, which silences the guard. This composes with no directive at all, and it is exactly the case
  // the runtime refusal covers: the rows above drive that throw through the client, the double, and the resolver.
  const plainDoorGroup = { lock: { label: "lock", publish: "The lock state.", topic: "lock" } };
  const plainMotionGroup = { smartMotion: { label: "smart motion", publish: "The smart detection event.", topic: "motion/smart/{object}" } };
  const fromPlainGroups = mqttTopicCatalog({ ...plainDoorGroup, ...plainMotionGroup });
  const _widenedUnresolved = mqttTopic(id, fromPlainGroups.smartMotion.topic);
};

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

describe("mqttTopicPlaceholders - reading a template's parameter names", () => {

  test("answers an empty list for a plain tail", () => {

    assert.deepEqual(mqttTopicPlaceholders("lock"), []);
    assert.deepEqual(mqttTopicPlaceholders("sidedoor/lock"), []);
  });

  test("answers one name, and two names in the order the topic spells them", () => {

    assert.deepEqual(mqttTopicPlaceholders("motion/smart/{object}"), ["object"]);
    assert.deepEqual(mqttTopicPlaceholders("relay/{output}/state/{index}"), [ "output", "index" ]);
  });

  test("lists a repeated name once per appearance", () => {

    // The list is what the topic spells, not the set of distinct names: the renderer walks it positionally to build one markup fragment per placeholder.
    assert.deepEqual(mqttTopicPlaceholders("zone/{zone}/child/{zone}"), [ "zone", "zone" ]);
  });

  test("admits any run of non-brace characters as a name", () => {

    assert.deepEqual(mqttTopicPlaceholders("relay/{output-2}/{class 3}"), [ "output-2", "class 3" ]);
  });

  test("answers nothing for a brace the grammar does not admit", () => {

    // An empty pair and an unclosed opener are malformed rather than parameterized, so nothing here matches and the refusals below are what answer them.
    assert.deepEqual(mqttTopicPlaceholders("power{}/state"), []);
    assert.deepEqual(mqttTopicPlaceholders("power{state"), []);
  });
});

describe("resolveMqttTopic - substituting parameter values", () => {

  test("substitutes one placeholder, two placeholders, and the same placeholder twice", () => {

    assert.equal(resolveMqttTopic("motion/smart/{object}", { object: "person" }), "motion/smart/person");
    assert.equal(resolveMqttTopic("relay/{output}/state/{index}", { index: "2", output: "1" }), "relay/1/state/2");
    assert.equal(resolveMqttTopic("zone/{zone}/child/{zone}", { zone: "4" }), "zone/4/child/4");
  });

  test("passes a plain tail through unchanged", () => {

    assert.equal(resolveMqttTopic("sidedoor/lock", {}), "sidedoor/lock");
  });

  test("uses a parameter's value verbatim, so a value carrying a slash extends the hierarchy", () => {

    // The value is the caller's own wire data. Rewriting it here would be the library deciding what a plugin's identities may look like.
    assert.equal(resolveMqttTopic("motion/smart/{object}", { object: "vehicle/licensePlate" }), "motion/smart/vehicle/licensePlate");
  });

  test("throws naming the placeholder when the record does not carry it, and never splices the word undefined", () => {

    // The widened case: a topic typed `string` carries no literal for the parameter record to be derived from, so the compile-time guard is silent and this throw is
    // the whole of the contract.
    const template = widened("motion/smart/{object}");

    assert.throws(() => resolveMqttTopic(template, {}),
      /^Error: resolveMqttTopic: the topic "motion\/smart\/\{object\}" names a parameter "object" the record does not carry\.$/);

    let resolved = "";

    try {

      resolved = resolveMqttTopic(template, {});
    } catch {

      // The throw is the point; what matters here is that nothing was produced.
    }

    assert.equal(resolved, "", "a missing parameter must produce no topic at all, least of all one carrying the word undefined");
  });

  test("throws naming the topic when a brace survives the substitution", () => {

    // An empty pair names no parameter and an unclosed opener closes nothing, so neither matches the grammar and neither is substituted. The residual check is what
    // keeps either of them off the wire.
    const emptyPair = widened("power{}/state");
    const unclosed = widened("power{state");

    assert.throws(() => resolveMqttTopic(emptyPair, {}), /^Error: resolveMqttTopic: the topic "power\{\}\/state" carries a brace; a placeholder must be resolved/);
    assert.throws(() => resolveMqttTopic(unclosed, {}), /^Error: resolveMqttTopic: the topic "power\{state" carries a brace; a placeholder must be resolved/);
  });
});

describe("assertResolvedMqttTopic - the shared refusal", () => {

  test("says nothing about a topic carrying no brace", () => {

    assert.doesNotThrow(() => assertResolvedMqttTopic("MqttClient", "sidedoor/lock"));
  });

  test("opens its message with the caller that met the topic", () => {

    // The same predicate answers for the client, the double, and the resolver, so the caller's name is the only thing that distinguishes every sentence.
    assert.throws(() => assertResolvedMqttTopic("MqttClient", "relay/{output}"), /^Error: MqttClient: the topic "relay\/\{output\}" carries a brace;/);
    assert.throws(() => assertResolvedMqttTopic("TestMqttClient", "relay/output}"), /^Error: TestMqttClient: the topic "relay\/output\}" carries a brace;/);
  });
});

describe("mqttTopicCatalog - declaration", () => {

  // Every topic shape the family's plugins declare between them, in one catalog: a plain tail, a multi-segment tail, one and two placeholders, a publish-only entry,
  // a set-only entry, an entry declaring all three verbs, and a tail that is the whole topic after the prefix because its plugin composes no identity at all (ComEd's
  // fixed label, and PowerView's two-segment identity, which is the caller's string and so is the same declaration shape).
  const ACCEPTANCE_ENTRIES = {

    chime: { get: "The current chime volume.", label: "chime volume", publish: "The chime volume.", set: "The volume to set.", topic: "chime" },
    hourlyPrice: { label: "hourly price", publish: "The current hourly price, in cents.", topic: "hourlyprice" },
    relayState: { label: "relay output", publish: "The relay output's state.", topic: "relay/{output}/state" },
    sideDoorLock: { get: "A request to publish the state.", label: "side door lock", publish: "The side door lock state.", set: "The state to set.",
      topic: "sidedoor/lock" },
    smartMetadata: { label: "smart metadata", publish: "The smart detection metadata.", topic: "motion/smart/{object}/{index}" },
    snapshot: { label: "snapshot trigger", set: "A trigger for a fresh snapshot.", topic: "snapshot" },
    telemetry: { label: "telemetry", publish: "The raw realtime feed.", topic: "telemetry" }
  };

  test("accepts every topic shape the family declares and hands each entry back as it was written", () => {

    const catalog = mqttTopicCatalog(ACCEPTANCE_ENTRIES);

    assert.deepEqual(Object.keys(catalog).toSorted(), Object.keys(ACCEPTANCE_ENTRIES).toSorted(), "every declared key must be present, and no other");
    assert.deepEqual(catalog, ACCEPTANCE_ENTRIES, "every entry must come back structurally identical to the way it was declared");
  });

  test("accepts a grouped catalog as readily as an ungrouped one", () => {

    const grouped = mqttTopicCatalog({

      lock: { group: "Door and Lock", label: "lock", publish: "The lock state.", topic: "lock" },
      telemetry: { group: "Telemetry", label: "telemetry", publish: "The raw realtime feed.", topic: "telemetry" }
    });

    assert.deepEqual(Object.keys(grouped), [ "lock", "telemetry" ]);
    assert.equal(grouped.lock.group, "Door and Lock");
  });

  test("returns a fresh object rather than the declaration it was handed", () => {

    const catalog = mqttTopicCatalog(ACCEPTANCE_ENTRIES);

    assert.notEqual(catalog, ACCEPTANCE_ENTRIES, "the caller's literal must never become the catalog by identity");
  });

  test("attaches a declared column under the symbol, which no iteration over the entries lists", () => {

    const column = { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } };
    const catalog = mqttTopicCatalog({ lock: { devices: ["camera"], label: "lock", publish: "The lock state.", topic: "lock" } }, column);

    assert.equal(catalog[MQTT_DEVICE_COLUMN], column, "the column is reachable through the symbol");
    assert.deepEqual(Object.keys(catalog), ["lock"], "the symbol is invisible to every walk over the entries");
  });

  test("carries no column when none was declared", () => {

    const catalog = mqttTopicCatalog({ lock: { label: "lock", publish: "The lock state.", topic: "lock" } });

    assert.equal(MQTT_DEVICE_COLUMN in catalog, false, "a catalog declaring no column carries nothing under the symbol");
  });

  test("hands back an entry carrying a verb's narrowing as it was written, and reads nothing from it", () => {

    // Protect's ambient light: published by the camera and the sensor, answered on its get child by the sensor alone. The builder's job is to carry that
    // declaration through untouched, since a narrowing is documentation the renderer projects rather than anything the runtime consults.
    const catalog = mqttTopicCatalog({

      ambientlight: { devices: [ "camera", "sensor" ], get: "A request to publish the ambient light level.", getDevices: ["sensor"], label: "ambient light",
        publish: "The ambient light level, in lux.", topic: "ambientlight" }
    }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    assert.deepEqual(catalog.ambientlight, { devices: [ "camera", "sensor" ], get: "A request to publish the ambient light level.", getDevices: ["sensor"],
      label: "ambient light", publish: "The ambient light level, in lux.", topic: "ambientlight" }, "the entry must come back exactly as it was declared");

    // The compiler checks a narrowing's kinds against the vocabulary, exactly as it does a devices list, and the builder checks nothing further: a narrowing naming
    // a kind the entry does not list is the renderer's refusal to make at the docs build, not the builder's at a plugin's startup.
    assert.doesNotThrow(() => mqttTopicCatalog({

      lock: { devices: ["camera"], get: "A request to publish the state.", getDevices: ["sensor"], label: "lock", publish: "The lock state.", topic: "lock" }
    }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } }));
  });

  test("reads nothing out of the column beyond attaching it", () => {

    // The document's checks belong to the renderer, so the builder must not touch the vocabulary. A vocabulary that throws on any property read proves it.
    const hostile = new Proxy({}, { get: (): never => {

      throw new Error("the builder must not read the column's vocabulary");
    } }) as Readonly<Record<string, string>>;

    const column = { heading: "Protect Device Type", vocabulary: hostile };
    const catalog = mqttTopicCatalog({ lock: { devices: ["camera"], label: "lock", publish: "The lock state.", topic: "lock" } }, column);

    assert.equal(catalog[MQTT_DEVICE_COLUMN], column);
  });
});

describe("mqttTopicCatalog - refusals", () => {

  test("throws when the catalog declares no entries", () => {

    assert.throws(() => mqttTopicCatalog({}), /^Error: mqttTopicCatalog: the catalog declares no entries\.$/);
  });

  test("throws naming the key and the field when an entry declares a field the entry type does not admit", () => {

    // TypeScript's excess-property check does not reach an entry literal handed to a generic builder unless the stray name is a near miss of a real one, so the
    // runtime is the guard for anything else.
    assert.throws(() => mqttTopicCatalog({ lock: { label: "lock", publish: "The lock state.", topic: "lock", unrelatedField: true } }),
      /^Error: mqttTopicCatalog: the entry lock declares an unknown field "unrelatedField"\.$/);
  });

  test("throws naming the key when an entry declares an empty topic", () => {

    assert.throws(() => mqttTopicCatalog({ lock: { label: "lock", publish: "The lock state.", topic: "" } }),
      /^Error: mqttTopicCatalog: the entry lock declares an empty topic\.$/);
  });

  test("throws naming the key when an entry declares none of publish, get, or set", () => {

    assert.throws(() => mqttTopicCatalog({ lock: { label: "lock", topic: "lock" } }),
      /^Error: mqttTopicCatalog: the entry lock declares none of publish, get, or set/);
  });

  test("throws naming the key when an entry's topic carries a brace outside a placeholder", () => {

    assert.throws(() => mqttTopicCatalog({ power: { label: "power", publish: "The power state.", topic: "power{}/state" } }),
      /^Error: mqttTopicCatalog: the entry power declares the topic "power\{\}\/state", which carries a brace outside a placeholder\.$/);
    assert.throws(() => mqttTopicCatalog({ power: { label: "power", publish: "The power state.", topic: "power{state" } }),
      /^Error: mqttTopicCatalog: the entry power declares the topic "power\{state", which carries a brace outside a placeholder\.$/);
  });

  test("throws naming both keys when two entries declare the same tail", () => {

    // A tail is one topic on the broker whatever heading it renders under, so two entries reaching it is a collision even when they group apart.
    assert.throws(() => mqttTopicCatalog({

      doorLock: { group: "Door", label: "lock", publish: "The lock state.", topic: "lock" },
      gateLock: { group: "Gate", label: "lock", publish: "The lock state.", topic: "lock" }
    }), /^Error: mqttTopicCatalog: the entries doorLock and gateLock both produce the wire topic "lock"\.$/);
  });

  test("throws naming both keys when one entry's tail is another entry's composed child", () => {

    // The get and set children an entry declares are wire topics of its own, so a plain tail that lands on one of them collides even though the two declarations
    // spell different strings.
    assert.throws(() => mqttTopicCatalog({

      lock: { get: "A request to publish the state.", label: "lock", publish: "The lock state.", topic: "lock" },
      lockGetShadow: { label: "shadow", publish: "Something else entirely.", topic: "lock/get" }
    }), /^Error: mqttTopicCatalog: the entries lock and lockGetShadow both produce the wire topic "lock\/get"\.$/);
  });
});
