/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-topics-docs.test.ts: Unit tests for the MQTT topic-catalog documentation renderer - the two marked-region fragments it projects a catalog into.
 *
 * The worked example is an Access-shaped catalog carrying every row that plugin's document prints, asserted byte for byte, so a regression in a cell, a width, a
 * heading, or the row set fails here as a diff a reader can read. The rest of the rows isolate one clause each: a flat catalog with no grouping, the parameterized
 * markup and the widths measured on it, the sort, the vocabulary-order join, the omitted empty group, the empty section beside it, the column-separator escape,
 * per-verb device narrowing, every refusal the renderer owns, and the marked regions the renderer's output splices into a real document.
 */
import { MQTT_DEVICE_COLUMN, mqttAvailabilityEntry, mqttTopicCatalog } from "./mqtt-topics.ts";
import { MQTT_PUBLISHED_DOC_BEGIN, MQTT_PUBLISHED_DOC_END, MQTT_SUBSCRIBED_DOC_BEGIN, MQTT_SUBSCRIBED_DOC_END,
  renderMqttTopicsReference } from "./mqtt-topics-docs.ts";
import { describe, test } from "node:test";
import type { MqttTopicCatalog } from "./mqtt-topics.ts";
import assert from "node:assert/strict";
import { spliceMarkedRegion } from "./doc-markdown.ts";

/* The plugin availability block, transcribed by hand exactly as a reader meets it at the head of every published fragment. It is deliberately NOT composed from the
 * renderer's own constants and not derived from the renderer's own assembly: an oracle built out of the thing it checks agrees with it by construction and can
 * never fail. The other fixtures in this file earn their independence by tracing to a real shipped document, and this one earns it the same way, by being written
 * out rather than computed. Every fixture below opens with these lines and every row that asks about the block reads them, so the text is transcribed once.
 */
const AVAILABILITY_BLOCK_LINES = [

  "**Plugin availability.** The plugin publishes this topic for itself, directly under its configured topic prefix rather than under a device identity.",
  "",
  "| Topic           | Message Published",
  "|-----------------|----------------------------------",
  "| `availability`  | `online` while the plugin holds a broker session, `offline` by the broker's last will when the plugin exits or its connection drops. " +
    "Retained either way.",
  ""
];

// The same block as one string, for the rows that ask whether a fragment carries it, how many times, and where.
const AVAILABILITY_BLOCK = AVAILABILITY_BLOCK_LINES.join("\n");

// The three headings the Access document groups its topics under, named once because every worked-example entry and both expected fragments spell them.
const DOOR = "Door and Lock Topics";
const SIDE = "Side Door Topics (UA Gate Only)";
const TELEMETRY = "Telemetry Topics";

// The worked example: the Access document's own topic surface, declared as the catalog its call sites would read. Three groups, a device column whose vocabulary
// declares Access's device kinds in the order the document lists them, and every published and subscribed row that document carries.
const WORKED_CATALOG = mqttTopicCatalog({

  doorbell: { devices: ["doorbellHub"], get: "`true` will trigger a publish event of the current doorbell ring status.", group: DOOR, label: "doorbell",
    publish: "`true` when ringing, `false` when the ring ends.", topic: "doorbell" },
  dps: { devices: [ "ultra", "hub", "hubDoorMini", "gate", "enterprisePort" ], get: "`true` will trigger a publish event of the current door position sensor state.",
    group: DOOR, label: "door position sensor", publish: "`true` when open, `false` when closed, `unknown` if not wired. The door position sensor.", topic: "dps" },
  lock: { devices: ["allHubs"], get: "`true` will trigger a publish event of the current lock state.", group: DOOR, label: "lock",
    publish: "`true` when locked, `false` when unlocked.", set: "`true` to lock, `false` to unlock. On hubs other than UA Gate, locking requires a configured lock " +
      "delay interval - a door left on the default momentary unlock has no relock to perform, and the request is refused with an error in the log.", topic: "lock" },
  rel: { devices: ["hub"], group: DOOR, label: "remote release", publish: "`true` when open, `false` when closed. The remote release sensor.", topic: "rel" },
  ren: { devices: ["hub"], group: DOOR, label: "request to enter", publish: "`true` when open, `false` when closed. The request to enter sensor.", topic: "ren" },
  rex: { devices: [ "ultra", "hub", "hubDoorMini" ], group: DOOR, label: "request to exit",
    publish: "`true` when open, `false` when closed. The request to exit sensor.", topic: "rex" },
  sidedoorDps: { devices: ["gate"], get: "`true` will trigger a publish event of the current side door position sensor state.", group: SIDE,
    label: "side door position sensor",
    publish: "`true` when open, `false` when closed, `unknown` if not wired. The side door (pedestrian gate) position sensor.", topic: "sidedoor/dps" },
  sidedoorLock: { devices: ["gate"], get: "`true` will trigger a publish event of the current side door lock state.", group: SIDE, label: "side door lock",
    publish: "`true` when locked, `false` when unlocked. The side door lock state.",
    set: "`true` to lock, `false` to unlock. This controls the side door lock relay.", topic: "sidedoor/lock" },
  sidedoorUnlock: { devices: ["gate"], group: SIDE, label: "side door unlock",
    publish: "A JSON describing who unlocked the side door and how. See [Unlock Attribution](#unlock-attribution) for additional documentation. Published only when " +
      "`Controller.Webhooks` is enabled.", topic: "sidedoor/unlock" },
  telemetry: { devices: ["controller"], group: TELEMETRY, label: "telemetry",
    publish: "All UniFi Access telemetry from the realtime events API. This is the raw feed - you're on your own to parse through it for the messages you may be " +
      "interested in. This is published to the controller's identity rather than a device's, and only when `Controller.Publish.Telemetry` is enabled.",
    topic: "telemetry" },
  unlock: { devices: ["allHubs"], group: DOOR, label: "unlock",
    publish: "A JSON describing who unlocked the door and how. See [Unlock Attribution](#unlock-attribution) for additional documentation. Published only when " +
      "`Controller.Webhooks` is enabled.", topic: "unlock" }
}, {

  heading: "Access Device Type",
  vocabulary: {

    allHubs: "All hubs",
    controller: "Controller",
    doorbellHub: "Hub with a doorbell",
    enterprisePort: "Access Enterprise hub ports",
    gate: "UA Gate",
    hub: "UA Hub",
    hubDoorMini: "UA Hub Door Mini",
    ultra: "UA Ultra"
  }
});

const WORKED_PUBLISHED = [

  ...AVAILABILITY_BLOCK_LINES,
  "#### Door and Lock Topics",
  "",
  "| Topic       | Access Device Type                                                        | Message Published",
  "|-------------|---------------------------------------------------------------------------|----------------------------------",
  "| `doorbell`  | Hub with a doorbell                                                       | `true` when ringing, `false` when the ring ends.",
  "| `dps`       | Access Enterprise hub ports, UA Gate, UA Hub, UA Hub Door Mini, UA Ultra  | `true` when open, `false` when closed, `unknown` if not wired. The door " +
    "position sensor.",
  "| `lock`      | All hubs                                                                  | `true` when locked, `false` when unlocked.",
  "| `rel`       | UA Hub                                                                    | `true` when open, `false` when closed. The remote release sensor.",
  "| `ren`       | UA Hub                                                                    | `true` when open, `false` when closed. The request to enter sensor.",
  "| `rex`       | UA Hub, UA Hub Door Mini, UA Ultra                                        | `true` when open, `false` when closed. The request to exit sensor.",
  "| `unlock`    | All hubs                                                                  | A JSON describing who unlocked the door and how. See [Unlock " +
    "Attribution](#unlock-attribution) for additional documentation. Published only when `Controller.Webhooks` is enabled.",
  "",
  "#### Side Door Topics (UA Gate Only)",
  "",
  "| Topic              | Access Device Type  | Message Published",
  "|--------------------|---------------------|----------------------------------",
  "| `sidedoor/dps`     | UA Gate             | `true` when open, `false` when closed, `unknown` if not wired. The side door (pedestrian gate) position sensor.",
  "| `sidedoor/lock`    | UA Gate             | `true` when locked, `false` when unlocked. The side door lock state.",
  "| `sidedoor/unlock`  | UA Gate             | A JSON describing who unlocked the side door and how. See [Unlock Attribution](#unlock-attribution) for additional " +
    "documentation. Published only when `Controller.Webhooks` is enabled.",
  "",
  "#### Telemetry Topics",
  "",
  "| Topic        | Access Device Type  | Message Published",
  "|--------------|---------------------|----------------------------------",
  "| `telemetry`  | Controller          | All UniFi Access telemetry from the realtime events API. This is the raw feed - you're on your own to parse through it for " +
    "the messages you may be interested in. This is published to the controller's identity rather than a device's, and only when `Controller.Publish.Telemetry` is " +
    "enabled.",
  ""
].join("\n");

const WORKED_SUBSCRIBED = [

  "#### Door and Lock Topics",
  "",
  "| Topic           | Access Device Type                                                        | Message Expected",
  "|-----------------|---------------------------------------------------------------------------|----------------------------------",
  "| `doorbell/get`  | Hub with a doorbell                                                       | `true` will trigger a publish event of the current doorbell ring " +
    "status.",
  "| `dps/get`       | Access Enterprise hub ports, UA Gate, UA Hub, UA Hub Door Mini, UA Ultra  | `true` will trigger a publish event of the current door position " +
    "sensor state.",
  "| `lock/get`      | All hubs                                                                  | `true` will trigger a publish event of the current lock state.",
  "| `lock/set`      | All hubs                                                                  | `true` to lock, `false` to unlock. On hubs other than UA Gate, " +
    "locking requires a configured lock delay interval - a door left on the default momentary unlock has no relock to perform, and the request is refused with an " +
    "error in the log.",
  "",
  "#### Side Door Topics (UA Gate Only)",
  "",
  "| Topic                | Access Device Type  | Message Expected",
  "|----------------------|---------------------|----------------------------------",
  "| `sidedoor/dps/get`   | UA Gate             | `true` will trigger a publish event of the current side door position sensor state.",
  "| `sidedoor/lock/get`  | UA Gate             | `true` will trigger a publish event of the current side door lock state.",
  "| `sidedoor/lock/set`  | UA Gate             | `true` to lock, `false` to unlock. This controls the side door lock relay.",
  ""
].join("\n");

// A flat, column-free catalog in the shape a zero-configuration plugin declares: publish-only entries sitting among entries that also take a get and a set.
const FLAT_CATALOG = mqttTopicCatalog({

  door: { get: "`true` will trigger a publish event of the current door state.", label: "door", publish: "`open`, `closed`, `opening`, or `closing`.",
    set: "`open` or `close`.", topic: "door" },
  light: { get: "`true` will trigger a publish event of the current light state.", label: "light", publish: "`true` when on, `false` when off.", topic: "light" },
  motion: { label: "motion", publish: "`true` when motion is detected.", topic: "motion" }
});

const FLAT_PUBLISHED = [

  ...AVAILABILITY_BLOCK_LINES,
  "| Topic     | Message Published",
  "|-----------|----------------------------------",
  "| `door`    | `open`, `closed`, `opening`, or `closing`.",
  "| `light`   | `true` when on, `false` when off.",
  "| `motion`  | `true` when motion is detected.",
  ""
].join("\n");

const FLAT_SUBSCRIBED = [

  "| Topic        | Message Expected",
  "|--------------|----------------------------------",
  "| `door/get`   | `true` will trigger a publish event of the current door state.",
  "| `door/set`   | `open` or `close`.",
  "| `light/get`  | `true` will trigger a publish event of the current light state.",
  ""
].join("\n");

// Parameterized tails, including one that carries a placeholder mid-topic and one whose children are parameterized too. Asserted byte for byte because the widths
// are measured on the rendered markup: a width taken from the raw topic would misalign every row here against its divider.
const PARAMETERIZED_CATALOG = mqttTopicCatalog({

  relay: { get: "`true` will trigger a publish event of the named output's state.", label: "relay output", publish: "`true` when open, `false` when closed.",
    set: "`true` to open, `false` to close.", topic: "relay/{output}" },
  smartMetadata: { label: "smart metadata", publish: "The detection metadata for the named object class.", topic: "motion/smart/{object}/metadata" },
  smartMotion: { label: "smart motion", publish: "`true` when the named object class is detected.", topic: "motion/smart/{object}" }
});

const PARAMETERIZED_PUBLISHED = [

  ...AVAILABILITY_BLOCK_LINES,
  "| Topic                                             | Message Published",
  "|---------------------------------------------------|----------------------------------",
  "| <CODE>motion/smart/<I>object</I></CODE>           | `true` when the named object class is detected.",
  "| <CODE>motion/smart/<I>object</I>/metadata</CODE>  | The detection metadata for the named object class.",
  "| <CODE>relay/<I>output</I></CODE>                  | `true` when open, `false` when closed.",
  ""
].join("\n");

const PARAMETERIZED_SUBSCRIBED = [

  "| Topic                                 | Message Expected",
  "|---------------------------------------|----------------------------------",
  "| <CODE>relay/<I>output</I>/get</CODE>  | `true` will trigger a publish event of the named output's state.",
  "| <CODE>relay/<I>output</I>/set</CODE>  | `true` to open, `false` to close.",
  ""
].join("\n");

const ESCAPED_PUBLISHED = [

  ...AVAILABILITY_BLOCK_LINES,
  "| Topic     | Device Type  | Message Published",
  "|-----------|--------------|----------------------------------",
  "| `choice`  | Hub \\| Gate  | Either `on` \\| `off`, whichever applies.",
  ""
].join("\n");

const VOCABULARY_ORDER_PUBLISHED = [

  ...AVAILABILITY_BLOCK_LINES,
  "| Topic   | Protect Device Type  | Message Published",
  "|---------|----------------------|----------------------------------",
  "| `lock`  | Camera, Sensor       | The lock state.",
  ""
].join("\n");

const NARROWED_PUBLISHED = [

  ...AVAILABILITY_BLOCK_LINES,
  "| Topic           | Protect Device Type  | Message Published",
  "|-----------------|----------------------|----------------------------------",
  "| `ambientlight`  | Camera, Sensor       | The ambient light level, in lux.",
  ""
].join("\n");

const NARROWED_SUBSCRIBED = [

  "| Topic               | Protect Device Type  | Message Expected",
  "|---------------------|----------------------|----------------------------------",
  "| `ambientlight/get`  | Sensor               | `true` will trigger a publish event of the ambient light level, in lux.",
  ""
].join("\n");

const EMPTY_GROUP_PUBLISHED = [

  ...AVAILABILITY_BLOCK_LINES,
  "#### Door",
  "",
  "| Topic   | Message Published",
  "|---------|----------------------------------",
  "| `lock`  | The lock state.",
  "",
  "#### Telemetry",
  "",
  "| Topic        | Message Published",
  "|--------------|----------------------------------",
  "| `telemetry`  | The raw realtime feed.",
  ""
].join("\n");

const EMPTY_GROUP_SUBSCRIBED = [

  "#### Door",
  "",
  "| Topic       | Message Expected",
  "|-------------|----------------------------------",
  "| `lock/get`  | A request to publish the state.",
  ""
].join("\n");

// The renderer meets a catalog through compiled JavaScript, which carries no types, so a shape the declaration's own type rules out still reaches it at the docs
// build. A row that needs such a shape casts its way past the declaration to reach what the renderer would actually meet.
function asCatalog(value: unknown): MqttTopicCatalog {

  return value as MqttTopicCatalog;
}

describe("renderMqttTopicsReference - the worked example (the contract)", () => {

  test("reproduces the published tables the Access document carries, byte for byte", () => {

    assert.equal(renderMqttTopicsReference(WORKED_CATALOG).published, WORKED_PUBLISHED);
  });

  test("reproduces the subscribed tables the Access document carries, byte for byte", () => {

    assert.equal(renderMqttTopicsReference(WORKED_CATALOG).subscribed, WORKED_SUBSCRIBED);
  });

  test("emits exactly the rows the entries declare and no others", () => {

    // The row set is the whole point of the projection, so it is checked on its own terms rather than left implicit in the byte-exact fragments: a topic the plugin
    // never publishes cannot appear, and a topic it does publish cannot go missing.
    const reference = renderMqttTopicsReference(WORKED_CATALOG);
    const topics = (section: string): string[] => section.split("\n").filter((line) => line.startsWith("| `")).map((line) => line.split("`")[1] ?? "");

    // The plugin availability topic leads the published enumeration because the renderer emits its block ahead of every catalog row, and it belongs to the plugin
    // rather than to any entry the catalog declares.
    assert.deepEqual(topics(reference.published),
      [ ...topics(AVAILABILITY_BLOCK), "doorbell", "dps", "lock", "rel", "ren", "rex", "unlock", "sidedoor/dps", "sidedoor/lock", "sidedoor/unlock",
        "telemetry" ]);
    assert.deepEqual(topics(reference.subscribed),
      [ "doorbell/get", "dps/get", "lock/get", "lock/set", "sidedoor/dps/get", "sidedoor/lock/get", "sidedoor/lock/set" ]);
  });

  test("omits a group that has no rows in a section", () => {

    // Telemetry publishes and subscribes to nothing, so its heading belongs in the published section alone.
    const reference = renderMqttTopicsReference(WORKED_CATALOG);

    assert.ok(reference.published.includes("#### " + TELEMETRY), "the telemetry group heads its own published table");
    assert.equal(reference.subscribed.includes(TELEMETRY), false, "a group with no subscribed rows prints no heading over nothing");
  });
});

describe("renderMqttTopicsReference - a flat catalog", () => {

  test("renders one table per section with no heading above it", () => {

    const reference = renderMqttTopicsReference(FLAT_CATALOG);

    assert.equal(reference.published, FLAT_PUBLISHED);
    assert.equal(reference.subscribed, FLAT_SUBSCRIBED);
    assert.equal(reference.published.includes("####"), false, "an ungrouped catalog prints no group heading");
  });

  test("gives a publish-only entry a published row and no subscribed row", () => {

    const reference = renderMqttTopicsReference(FLAT_CATALOG);

    assert.ok(reference.published.includes("| `motion`"), "the publish-only entry prints among the published rows");
    assert.equal(reference.subscribed.includes("motion"), false, "an entry declaring neither get nor set is subscribed to nothing");
  });
});

describe("renderMqttTopicsReference - parameterized topics", () => {

  test("renders each placeholder as italic markup inside an HTML code span, measured as it prints", () => {

    const reference = renderMqttTopicsReference(PARAMETERIZED_CATALOG);

    assert.equal(reference.published, PARAMETERIZED_PUBLISHED);
    assert.equal(reference.subscribed, PARAMETERIZED_SUBSCRIBED);
  });

  test("carries the placeholder markup into a subscribed child", () => {

    const reference = renderMqttTopicsReference(PARAMETERIZED_CATALOG);

    assert.ok(reference.subscribed.includes("<CODE>relay/<I>output</I>/get</CODE>"), "a get child of a template is itself a template");
    assert.ok(reference.subscribed.includes("<CODE>relay/<I>output</I>/set</CODE>"), "so is its set child");
  });
});

describe("renderMqttTopicsReference - ordering and joining", () => {

  test("orders rows as the topic tree reads rather than by declaration order", () => {

    // The declaration below is deliberately out of order, so an implementation that printed declaration order would fail on the first line index.
    const catalog = mqttTopicCatalog({

      first: { label: "first", publish: "Declared first, printed last.", topic: "zulu" },
      fourth: { label: "fourth", publish: "Declared last, printed first.", topic: "alpha" },
      second: { label: "second", publish: "Declared second, printed third.", topic: "light/brightness" },
      third: { label: "third", publish: "Declared third, printed second.", topic: "light" }
    });

    // Every index into a published fragment counts from the end of the plugin availability block, which the renderer emits ahead of the catalog's own table. The
    // offset is read off the block constant rather than written out, so a change to the block's shape moves these reads with it.
    const lines = renderMqttTopicsReference(catalog).published.split("\n");
    const firstRow = AVAILABILITY_BLOCK_LINES.length + 2;

    assert.ok(lines[firstRow]?.startsWith("| `alpha`"), "the tree's first topic leads, observed: " + String(lines[firstRow]));
    assert.ok(lines[firstRow + 1]?.startsWith("| `light`"), "a parent sorts ahead of its own child topic, observed: " + String(lines[firstRow + 1]));
    assert.ok(lines[firstRow + 2]?.startsWith("| `light/brightness`"), "the child follows its parent, observed: " + String(lines[firstRow + 2]));
    assert.ok(lines[firstRow + 3]?.startsWith("| `zulu`"), "the tree's last topic trails, observed: " + String(lines[firstRow + 3]));
  });

  test("lists a topic's own get and set rows before the rows of the topics beneath it, and a hyphenated sibling after its base", () => {

    // The shapes a comparison of the printed child topic reads wrong: a hyphen sorts below a slash, so `leak-external/get` would lead `leak/get`, and a child's
    // own segment sorts below the get suffix, so `light/brightness/get` would lead `light/get`. A whole-string comparison of the entry's own topic reads a further
    // shape wrong for the same reason as the first: `light-external` would lead `light/brightness`, where the tree reads `light` and everything beneath it first.
    // Keying each row on its entry's topic, segment by segment, reads each of them as the tree.
    const catalog = mqttTopicCatalog({

      externalLeak: { get: "`true` will trigger a publish event of the current external leak state.", label: "external leak", topic: "leak-external" },
      externalLight: { get: "`true` will trigger a publish event of the current external light state.", label: "external light", topic: "light-external" },
      leak: { get: "`true` will trigger a publish event of the current leak state.", label: "leak", topic: "leak" },
      light: { get: "`true` or `false` when the light is on or off.", label: "light", set: "`true` or `false` to turn the light on or off.", topic: "light" },
      lightBrightness: { get: "The brightness level, as a percentage.", label: "light brightness", set: "A number between 0 and 100.", topic: "light/brightness" }
    });

    const reference = renderMqttTopicsReference(catalog);
    const lines = reference.subscribed.split("\n");

    assert.ok(lines[2]?.startsWith("| `leak/get`"), "a base topic's row leads its hyphenated sibling, observed: " + String(lines[2]));
    assert.ok(lines[3]?.startsWith("| `leak-external/get`"), "the hyphenated sibling follows it, observed: " + String(lines[3]));
    assert.ok(lines[4]?.startsWith("| `light/get`"), "a topic's own get row leads the rows beneath it, observed: " + String(lines[4]));
    assert.ok(lines[5]?.startsWith("| `light/set`"), "its set row follows its get row, observed: " + String(lines[5]));
    assert.ok(lines[6]?.startsWith("| `light/brightness/get`"), "the topic beneath it follows both, observed: " + String(lines[6]));
    assert.ok(lines[7]?.startsWith("| `light/brightness/set`"), "and its set row trails, observed: " + String(lines[7]));
    assert.ok(lines[8]?.startsWith("| `light-external/get`"), "a hyphenated sibling of a topic with children trails all of its rows, observed: " + String(lines[8]));
    // A catalog whose entries declare no publish text contributes no table of its own, and what remains is the plugin availability block: the library's own client
    // publishes that topic for every plugin, so the published fragment is never empty however little the catalog declares.
    assert.equal(reference.published, AVAILABILITY_BLOCK + "\n",
      "a catalog whose entries declare no publish text renders the plugin availability block and no catalog table");
  });

  test("joins device labels in the vocabulary's declared order, not the entry's", () => {

    const catalog = mqttTopicCatalog({

      lock: { devices: [ "sensor", "camera" ], label: "lock", publish: "The lock state.", topic: "lock" }
    }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    assert.equal(renderMqttTopicsReference(catalog).published, VOCABULARY_ORDER_PUBLISHED);
    assert.equal(renderMqttTopicsReference(catalog).subscribed, "", "an entry declaring neither a get nor a set child leaves the subscribed section with no rows");
  });

  test("escapes the column separator in a message and in a device label, and nothing else", () => {

    const catalog = mqttTopicCatalog({

      choice: { devices: ["either"], label: "choice", publish: "Either `on` | `off`, whichever applies.", topic: "choice" }
    }, { heading: "Device Type", vocabulary: { either: "Hub | Gate" } });

    assert.equal(renderMqttTopicsReference(catalog).published, ESCAPED_PUBLISHED);
    assert.equal(renderMqttTopicsReference(catalog).subscribed, "", "an entry declaring neither a get nor a set child leaves the subscribed section with no rows");
  });

  test("leaves two entries that declare the same wire topic in their declared order", () => {

    // The builder refuses a duplicate tail, so this shape only reaches the renderer from a catalog that never went through it. The projection is not a second
    // validator: it prints both rows and its sort leaves equal topics where it found them.
    const lines = renderMqttTopicsReference(asCatalog({

      first: { label: "first", publish: "Declared first.", topic: "lock" },
      second: { label: "second", publish: "Declared second.", topic: "lock" }
    })).published.split("\n");

    const firstRow = AVAILABILITY_BLOCK_LINES.length + 2;

    assert.ok(lines[firstRow]?.endsWith("Declared first."), "the first declaration keeps its place, observed: " + String(lines[firstRow]));
    assert.ok(lines[firstRow + 1]?.endsWith("Declared second."), "and the second follows it, observed: " + String(lines[firstRow + 1]));
  });

  test("omits an empty group from the section it has no rows in", () => {

    const catalog = mqttTopicCatalog({

      lock: { get: "A request to publish the state.", group: "Door", label: "lock", publish: "The lock state.", topic: "lock" },
      telemetry: { group: "Telemetry", label: "telemetry", publish: "The raw realtime feed.", topic: "telemetry" }
    });

    const reference = renderMqttTopicsReference(catalog);

    assert.equal(reference.published, EMPTY_GROUP_PUBLISHED);
    assert.equal(reference.subscribed, EMPTY_GROUP_SUBSCRIBED);
  });
});

describe("renderMqttTopicsReference - per-verb device narrowing", () => {

  test("credits a verb's row to the kinds its narrowing names and every other row to the entry's whole list", () => {

    // Protect's ambient light: the camera and the sensor both publish it, and the sensor alone answers its get child. The published row credits both kinds while
    // the get row credits the sensor, so the document credits the camera with the publish alone and never with a request it does not answer.
    const catalog = mqttTopicCatalog({

      ambientlight: { devices: [ "camera", "sensor" ], get: "`true` will trigger a publish event of the ambient light level, in lux.", getDevices: ["sensor"],
        label: "ambient light", publish: "The ambient light level, in lux.", topic: "ambientlight" }
    }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    const reference = renderMqttTopicsReference(catalog);

    assert.equal(reference.published, NARROWED_PUBLISHED);
    assert.equal(reference.subscribed, NARROWED_SUBSCRIBED);
  });

  test("narrows each verb independently and joins a narrowing's labels in the vocabulary's order", () => {

    // Each verb reads its own field and nothing else, and the publish narrowing is declared out of the vocabulary's order to show which order the cell follows.
    const catalog = mqttTopicCatalog({

      thing: { devices: [ "a", "b", "c" ], get: "A get.", getDevices: ["b"], label: "thing", publish: "A publish.", publishDevices: [ "b", "a" ], set: "A set.",
        setDevices: ["c"], topic: "thing" }
    }, { heading: "Kind", vocabulary: { a: "A", b: "B", c: "C" } });

    const reference = renderMqttTopicsReference(catalog);
    const deviceCell = (line: string): string => (line.split("|")[2] ?? "").trim();

    assert.equal(deviceCell(reference.published.split("\n")[AVAILABILITY_BLOCK_LINES.length + 2] ?? ""), "A, B",
      "the published row credits its own narrowing, in the vocabulary's order");
    assert.equal(deviceCell(reference.subscribed.split("\n")[2] ?? ""), "B", "the get row credits its own narrowing alone");
    assert.equal(deviceCell(reference.subscribed.split("\n")[3] ?? ""), "C", "and the set row credits its own");
  });
});

describe("renderMqttTopicsReference - the plugin availability row", () => {

  /* The one row the renderer emits from its own knowledge rather than from a catalog, and the per-device row a consumer's own catalog contributes beside it. The
   * block is checked against the hand-transcribed constant at the head of this file, which is what keeps the oracle independent of the renderer's own assembly.
   */
  test("renders the plugin-level block for a catalog declaring a device column", () => {

    const catalog = mqttTopicCatalog({

      lock: { devices: ["camera"], label: "lock", publish: "`true` when locked.", topic: "lock" }
    }, { heading: "Device Type", vocabulary: { camera: "Camera" } });

    assert.ok(renderMqttTopicsReference(catalog).published.startsWith(AVAILABILITY_BLOCK),
      "a column-bearing catalog's published fragment must open with the plugin availability block, topic cell and message cell alike");
  });

  test("renders the plugin-level block for a catalog declaring no column", () => {

    // The block is the same in both shapes, because the plugin publishes the topic whatever its catalog declares and no plugin can opt out of it.
    const catalog = mqttTopicCatalog({ lock: { label: "lock", publish: "`true` when locked.", topic: "lock" } });

    assert.ok(renderMqttTopicsReference(catalog).published.startsWith(AVAILABILITY_BLOCK),
      "a catalog declaring no column must carry the same block, with the same two cells");
  });

  test("renders the shipped entry's own per-device row, with its message text and a device cell drawn from the vocabulary", () => {

    const catalog = mqttTopicCatalog({

      availability: { ...mqttAvailabilityEntry, devices: [ "camera", "sensor" ] }
    }, { heading: "Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    // The last matching row is the catalog's, since the block's own row leads the fragment.
    const row = renderMqttTopicsReference(catalog).published.split("\n").filter((line) => line.startsWith("| `availability`")).at(-1) ?? "";

    assert.ok(row.includes("Camera, Sensor"), "the device cell joins the entry's kinds in the vocabulary's declared order, observed: " + row);
    assert.ok(row.includes(mqttAvailabilityEntry.publish),
      "the row prints the entry's own message text, which is where a per-device row's payload words come from");
  });

  test("keeps the plugin-level row and a consumer's per-device row distinct, in distinct parts of the fragment", () => {

    // Both rows print the same topic cell, because the renderer prints an entry's tail rather than an identity-composed topic. What tells them apart is which part
    // of the fragment each sits in, and the device cell only the catalog's row carries.
    const catalog = mqttTopicCatalog({

      availability: { ...mqttAvailabilityEntry, devices: [ "camera", "sensor" ] },
      lock: { devices: ["camera"], label: "lock", publish: "`true` when locked.", topic: "lock" }
    }, { heading: "Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    const fragment = renderMqttTopicsReference(catalog).published;

    assert.ok(fragment.startsWith(AVAILABILITY_BLOCK), "the plugin-level block must open the fragment");

    const catalogPart = fragment.slice(AVAILABILITY_BLOCK.length);
    const availabilityRows = (part: string): string[] => part.split("\n").filter((line) => line.startsWith("| `availability`"));

    assert.equal(availabilityRows(AVAILABILITY_BLOCK).length, 1, "the block carries the plugin-level row and only it");
    assert.equal(availabilityRows(catalogPart).length, 1, "the catalog's own table carries the per-device row and only it");
    assert.equal(availabilityRows(AVAILABILITY_BLOCK)[0]?.split("|").length, 3, "the plugin-level row carries a topic cell and a message cell and no device cell");
    assert.equal(availabilityRows(catalogPart)[0]?.split("|").length, 4, "the per-device row carries the device cell the plugin-level row does not");
  });

  test("renders a grouped catalog's spread entry under its own group, with the block present once and ahead of every heading", () => {

    /* The shipped entry ships group-less, so a consumer whose catalog groups its entries has to give it one on the spread. This is the row that proves such a
     * consumer can use the entry at all: every other worked example pairs it with an ungrouped sibling.
     */
    const grouped = mqttTopicCatalog({

      availability: { ...mqttAvailabilityEntry, devices: [ "camera", "sensor" ], group: "Status" },
      lock: { devices: ["camera"], group: "Door", label: "lock", publish: "`true` when locked.", topic: "lock" }
    }, { heading: "Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    const fragment = renderMqttTopicsReference(grouped).published;
    const sections = fragment.split("#### ");

    // Counted rather than merely found, so a block the grouped path emitted once per group would redden here.
    assert.equal(fragment.split(AVAILABILITY_BLOCK).length - 1, 1, "the block must be emitted exactly once, however the catalog groups its entries");
    assert.ok(fragment.startsWith(AVAILABILITY_BLOCK), "the block must precede every group heading");
    assert.ok(sections[1]?.startsWith("Status"), "the group the consumer gave the spread entry heads the first table, observed: " + String(sections[1]));
    assert.ok(sections[1]?.includes("| `availability`"), "the entry's own row sits under that heading");
    assert.ok(sections[2]?.startsWith("Door"), "the sibling's group follows it, observed: " + String(sections[2]));
  });
});

describe("renderMqttTopicsReference - refusals", () => {

  test("throws when the column declares no heading text", () => {

    const catalog = mqttTopicCatalog({ lock: { devices: ["camera"], label: "lock", publish: "The lock state.", topic: "lock" } },
      { heading: "Protect Device Type", vocabulary: { camera: "Camera" } });

    assert.throws(() => renderMqttTopicsReference(asCatalog({ ...catalog, [MQTT_DEVICE_COLUMN]: { vocabulary: { camera: "Camera" } } })),
      /^Error: renderMqttTopicsReference: the catalog's device column declares no heading text\.$/);
  });

  test("throws naming the column when it declares no vocabulary object", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ [MQTT_DEVICE_COLUMN]: { heading: "Protect Device Type", vocabulary: null },
      lock: { devices: ["camera"], label: "lock", publish: "p", topic: "lock" } })),
    /^Error: renderMqttTopicsReference: the catalog's device column "Protect Device Type" declares no vocabulary object\.$/);
  });

  test("throws naming the column when its vocabulary is not an object at all", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ [MQTT_DEVICE_COLUMN]: { heading: "Protect Device Type", vocabulary: "Camera" },
      lock: { devices: ["camera"], label: "lock", publish: "p", topic: "lock" } })),
    /^Error: renderMqttTopicsReference: the catalog's device column "Protect Device Type" declares no vocabulary object\.$/);
  });

  test("throws naming the column and the entry when an entry carries no devices list", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ [MQTT_DEVICE_COLUMN]: { heading: "Protect Device Type", vocabulary: { camera: "Camera" } },
      lock: { label: "lock", publish: "p", topic: "lock" } })),
    /^Error: renderMqttTopicsReference: the column "Protect Device Type" needs a devices list on the entry lock\.$/);
  });

  test("throws naming the column and the entry when a devices list is empty", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ [MQTT_DEVICE_COLUMN]: { heading: "Protect Device Type", vocabulary: { camera: "Camera" } },
      lock: { devices: [], label: "lock", publish: "p", topic: "lock" } })),
    /^Error: renderMqttTopicsReference: the column "Protect Device Type" needs a devices list on the entry lock\.$/);
  });

  test("throws naming the entry and the kind when a device is not in the vocabulary", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ [MQTT_DEVICE_COLUMN]: { heading: "Protect Device Type", vocabulary: { camera: "Camera" } },
      lock: { devices: ["sensor"], label: "lock", publish: "p", topic: "lock" } })),
    /^Error: renderMqttTopicsReference: the entry lock names a device "sensor" the column's vocabulary does not declare\.$/);
  });

  test("throws naming the entry when it carries a devices list and the catalog declares no column", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ lock: { devices: ["camera"], label: "lock", publish: "p", topic: "lock" } })),
      /^Error: renderMqttTopicsReference: the entry lock declares devices but the catalog declares no column\.$/);
  });

  test("throws naming both entries when one declares no group and the first one does", () => {

    assert.throws(() => renderMqttTopicsReference(mqttTopicCatalog({

      lock: { group: "Door", label: "lock", publish: "The lock state.", topic: "lock" },
      telemetry: { label: "telemetry", publish: "The raw realtime feed.", topic: "telemetry" }
    })), /^Error: renderMqttTopicsReference: the entry telemetry declares no group while the entry lock declares one\.$/);
  });

  test("throws naming both entries when one declares a group and the first one does not", () => {

    assert.throws(() => renderMqttTopicsReference(mqttTopicCatalog({

      lock: { label: "lock", publish: "The lock state.", topic: "lock" },
      telemetry: { group: "Telemetry", label: "telemetry", publish: "The raw realtime feed.", topic: "telemetry" }
    })), /^Error: renderMqttTopicsReference: the entry telemetry declares a group while the entry lock declares none\.$/);
  });

  test("throws naming the entry and the field when it carries a verb's narrowing and the catalog declares no column", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ lock: { get: "A request.", getDevices: ["camera"], label: "lock", topic: "lock" } })),
      /^Error: renderMqttTopicsReference: the entry lock declares getDevices but the catalog declares no column\.$/);
  });

  test("throws naming the entry and the field when a narrowing is declared without its verb's own message text", () => {

    const catalog = mqttTopicCatalog({

      lock: { devices: [ "camera", "sensor" ], getDevices: ["sensor"], label: "lock", publish: "The lock state.", topic: "lock" }
    }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    assert.throws(() => renderMqttTopicsReference(catalog), /^Error: renderMqttTopicsReference: the entry lock declares getDevices but no get\.$/);
  });

  test("throws naming the entry and the field when a narrowing carries nothing", () => {

    assert.throws(() => renderMqttTopicsReference(asCatalog({ [MQTT_DEVICE_COLUMN]: { heading: "Protect Device Type", vocabulary: { camera: "Camera" } },
      lock: { devices: ["camera"], get: "A request.", getDevices: [], label: "lock", publish: "p", topic: "lock" } })),
    /^Error: renderMqttTopicsReference: the entry lock declares an empty getDevices list\.$/);
  });

  test("throws naming the entry, the kind, and the field when a narrowing names a kind the entry's devices list does not carry", () => {

    const catalog = mqttTopicCatalog({

      lock: { devices: ["camera"], get: "A request.", getDevices: ["sensor"], label: "lock", publish: "p", topic: "lock" }
    }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    assert.throws(() => renderMqttTopicsReference(catalog),
      /^Error: renderMqttTopicsReference: the entry lock names a device "sensor" in getDevices that its devices list does not carry\.$/);
  });

  test("throws naming the entry and the kind when a kind it lists is credited by none of its verbs", () => {

    const catalog = mqttTopicCatalog({

      lock: { devices: [ "camera", "sensor" ], label: "lock", publish: "p", publishDevices: ["camera"], topic: "lock" }
    }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });

    assert.throws(() => renderMqttTopicsReference(catalog),
      /^Error: renderMqttTopicsReference: the entry lock lists a device "sensor" that none of its verbs credits\.$/);
  });
});

describe("renderMqttTopicsReference - the marked regions", () => {

  test("names one marker pair per region, each carrying the do-not-edit warning", () => {

    assert.equal(MQTT_PUBLISHED_DOC_BEGIN, "<!-- MQTT PUBLISHED:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->");
    assert.equal(MQTT_PUBLISHED_DOC_END, "<!-- MQTT PUBLISHED:END -->");
    assert.equal(MQTT_SUBSCRIBED_DOC_BEGIN, "<!-- MQTT SUBSCRIBED:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->");
    assert.equal(MQTT_SUBSCRIBED_DOC_END, "<!-- MQTT SUBSCRIBED:END -->");
  });

  test("splices both regions repeatably, leaving the prose before, between, and after untouched", () => {

    const document = [

      "# MQTT",
      "",
      "Intro prose the maintainer owns.",
      "",
      "### Topics Published",
      "",
      MQTT_PUBLISHED_DOC_BEGIN,
      "stale published tables",
      MQTT_PUBLISHED_DOC_END,
      "",
      "Prose between the two sections.",
      "",
      "### Topics Subscribed",
      "",
      MQTT_SUBSCRIBED_DOC_BEGIN,
      "stale subscribed tables",
      MQTT_SUBSCRIBED_DOC_END,
      "",
      "Footer prose."
    ].join("\n");

    const reference = renderMqttTopicsReference(WORKED_CATALOG);

    const splice = (source: string): string => spliceMarkedRegion(spliceMarkedRegion(source, reference.published,
      { beginMarker: MQTT_PUBLISHED_DOC_BEGIN, endMarker: MQTT_PUBLISHED_DOC_END }), reference.subscribed,
    { beginMarker: MQTT_SUBSCRIBED_DOC_BEGIN, endMarker: MQTT_SUBSCRIBED_DOC_END });

    const once = splice(document);

    assert.ok(once.startsWith("# MQTT\n\nIntro prose the maintainer owns.\n"));
    assert.ok(once.includes("\nProse between the two sections.\n"));
    assert.ok(once.endsWith("\nFooter prose."));
    assert.equal(once.includes("stale published tables"), false);
    assert.equal(once.includes("stale subscribed tables"), false);
    assert.equal(splice(once), once, "splicing the same reference into an already generated document reproduces it byte for byte");
  });

  test("leaves a publish-only plugin's subscribed region carrying nothing but its own two markers", () => {

    // What a plugin that only publishes actually gets. The section renders as an empty fragment, and the splice frames a fragment with a newline on each side, so
    // the region between the markers holds one blank line: no heading, no divider, and no header row standing over a table with no rows.
    const catalog = mqttTopicCatalog({

      motion: { label: "motion", publish: "`true` when motion is detected.", topic: "motion" },
      status: { label: "status", publish: "The device state.", topic: "status" }
    });

    const document = [ MQTT_PUBLISHED_DOC_BEGIN, "stale published tables", MQTT_PUBLISHED_DOC_END, "", MQTT_SUBSCRIBED_DOC_BEGIN, "stale subscribed tables",
      MQTT_SUBSCRIBED_DOC_END ].join("\n");

    const reference = renderMqttTopicsReference(catalog);

    const rendered = spliceMarkedRegion(spliceMarkedRegion(document, reference.published,
      { beginMarker: MQTT_PUBLISHED_DOC_BEGIN, endMarker: MQTT_PUBLISHED_DOC_END }), reference.subscribed,
    { beginMarker: MQTT_SUBSCRIBED_DOC_BEGIN, endMarker: MQTT_SUBSCRIBED_DOC_END });

    assert.equal(reference.subscribed, "", "a catalog declaring no get or set child renders no subscribed section at all");
    assert.ok(rendered.endsWith(MQTT_SUBSCRIBED_DOC_BEGIN + "\n\n" + MQTT_SUBSCRIBED_DOC_END),
      "the subscribed region must hold one blank line and nothing else, observed: " + JSON.stringify(rendered));
    assert.ok(rendered.includes("| `motion`"), "the published region must still carry its table, observed: " + JSON.stringify(rendered));
    assert.equal(rendered.includes("stale subscribed tables"), false);
  });
});
