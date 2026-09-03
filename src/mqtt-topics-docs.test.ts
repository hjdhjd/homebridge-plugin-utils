/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-topics-docs.test.ts: Unit tests for the MQTT topic-catalog documentation renderer - the two marked-region fragments it projects a catalog into.
 *
 * The worked example is an Access-shaped catalog carrying every row that plugin's document prints, asserted byte for byte, so a regression in a cell, a width, a
 * heading, or the row set fails here as a diff a reader can read. The rest of the rows isolate one clause each: the parameterized markup and the widths measured on
 * it, the sort, the vocabulary-order join, the omitted empty group, the empty section beside it, the column-separator escape, and every refusal the renderer owns.
 */
import { MQTT_DEVICE_COLUMN, mqttTopicCatalog } from "./mqtt-topics.ts";
import { MQTT_PUBLISHED_DOC_BEGIN, MQTT_PUBLISHED_DOC_END, MQTT_SUBSCRIBED_DOC_BEGIN, MQTT_SUBSCRIBED_DOC_END,
  renderMqttTopicsReference } from "./mqtt-topics-docs.ts";
import { describe, test } from "node:test";
import type { MqttTopicCatalog } from "./mqtt-topics.ts";
import assert from "node:assert/strict";
import { spliceMarkedRegion } from "./doc-markdown.ts";

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

  "| Topic     | Device Type  | Message Published",
  "|-----------|--------------|----------------------------------",
  "| `choice`  | Hub \\| Gate  | Either `on` \\| `off`, whichever applies.",
  ""
].join("\n");

const VOCABULARY_ORDER_PUBLISHED = [

  "| Topic   | Protect Device Type  | Message Published",
  "|---------|----------------------|----------------------------------",
  "| `lock`  | Camera, Sensor       | The lock state.",
  ""
].join("\n");

const EMPTY_GROUP_PUBLISHED = [

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

    assert.deepEqual(topics(reference.published),
      [ "doorbell", "dps", "lock", "rel", "ren", "rex", "unlock", "sidedoor/dps", "sidedoor/lock", "sidedoor/unlock", "telemetry" ]);
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

  test("sorts rows by their raw topic rather than by declaration order", () => {

    // The declaration below is deliberately out of order, so an implementation that printed declaration order would fail on the first line index.
    const catalog = mqttTopicCatalog({

      first: { label: "first", publish: "Declared first, printed last.", topic: "zulu" },
      fourth: { label: "fourth", publish: "Declared last, printed first.", topic: "alpha" },
      second: { label: "second", publish: "Declared second, printed third.", topic: "light/brightness" },
      third: { label: "third", publish: "Declared third, printed second.", topic: "light" }
    });

    const lines = renderMqttTopicsReference(catalog).published.split("\n");

    assert.ok(lines[2]?.startsWith("| `alpha`"), "the first row is the lowest raw topic, observed: " + String(lines[2]));
    assert.ok(lines[3]?.startsWith("| `light`"), "a parent sorts ahead of its own child topic, observed: " + String(lines[3]));
    assert.ok(lines[4]?.startsWith("| `light/brightness`"), "the child follows its parent, observed: " + String(lines[4]));
    assert.ok(lines[5]?.startsWith("| `zulu`"), "the highest raw topic is last, observed: " + String(lines[5]));
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

    assert.ok(lines[2]?.endsWith("Declared first."), "the first declaration keeps its place, observed: " + String(lines[2]));
    assert.ok(lines[3]?.endsWith("Declared second."), "and the second follows it, observed: " + String(lines[3]));
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
