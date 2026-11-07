/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions-retired.test.ts: The translation of retired feature option families, as tables of exact input and output pairs over the catalog shapes the
 * family's plugins declare.
 *
 * The boot view and the overlay are asserted apart because they answer different questions. The boot view is what an engine is built on, compared entry for entry,
 * since an extra entry, a dropped one, or a reordered array would change what the engine resolves. The overlay is what a reader holding its own device and
 * controller gets back, which is where a retired grammar's exact precedence lives - a composition without topology cannot tell a controller identifier from a
 * device one, so the rows pairing the two say which answer is which. The durable rewrite is asserted against the topology it composes through.
 *
 * The rows over the Protect-shaped catalog are the same rows that plugin's own translation holds, and the catalog here is declared to match its shapes: a
 * single-select pair of stream-tier options, a list family whose members all defaulted on, a kept-name family with mixed member defaults and an option declared under its
 * name, a kept-name family with no members, and a family left to the overlay. This file names retired option grammars throughout, deliberately: they are its
 * subject.
 */
import { ALL_CHOICES, FeatureOptions } from "./featureOptions.ts";
import type { FeatureCategoryEntry, FeatureOptionEntry } from "./featureOptions.ts";
import type { RetiredController, RetiredFamily, RetiredTranslation } from "./featureOptions-retired.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRetiredOptions } from "./featureOptions-retired.ts";

// The controller the rows resolve against, a sibling controller that proves one controller's entries never answer for another, the cameras beneath the first, and
// a camera no topology below places.
const CONTROLLER = "AABBCCDDEEFF";
const OTHER_CONTROLLER = "112233445566";
const CAMERA = "0123456789AB";
const OTHER_CAMERA = "BA9876543210";
const UNPLACED = "EEFF00112233";

// The tier picker's domain, best first, in the spelling the catalog offers it.
const TIERS = [ "High", "Medium", "Low" ];

// The leading detection types of Protect's table, in its order, and the types its retired per-type options defaulted on.
const DETECTION_TYPES = [ [ "Animal", "animal" ], [ "Face", "face" ], [ "LicensePlate", "licensePlate" ], [ "Package", "package" ], [ "Person", "person" ],
  [ "Vehicle", "vehicle" ] ] as const;
const OCCUPANCY_DEFAULTS: ReadonlySet<string> = new Set([ "Face", "Person" ]);

// The fob's buttons, each beside the wire id the selection stores, and the relay outputs the retired per-output options covered.
const FOB_BUTTONS = [ [ "Arm", "arm" ], [ "Night", "night" ], [ "Disarm", "disarm" ], [ "Panic", "panic" ], [ "Right", "right" ], [ "Left", "left" ] ] as const;
const FOB_DOMAIN = FOB_BUTTONS.map(([ , value ]) => value);
const RELAY_OUTPUTS = [ "1", "2" ];

const TIER_CHOICES = TIERS.map((tier) => ({ label: tier, value: tier }));

const PROTECT_CATEGORIES: FeatureCategoryEntry[] = [

  { description: "Fob", name: "Fob" },
  { description: "Motion & Occupancy", name: "Motion" },
  { description: "Relay", name: "Relay" },
  { description: "Video & Streaming", name: "Video" },
  { description: "Timeshift Buffer", name: "Video.Timeshift" }
];

const PROTECT_OPTIONS: Record<string, FeatureOptionEntry[]> = {

  Fob: [

    { choices: FOB_BUTTONS.map(([ label, value ]) => ({ label, value })), default: true, defaultValue: ALL_CHOICES, description: "Fob buttons.", multiple: true,
      name: "Buttons" }
  ],

  Motion: [

    { choices: "smartDetectTypes", default: false, defaultValue: "face,person", description: "Occupancy sensor.", multiple: true, name: "OccupancySensor" },
    { default: true, defaultValue: 300, description: "Occupancy duration.", group: "OccupancySensor", name: "OccupancySensor.Duration" },
    { default: false, description: "Smart detection.", name: "SmartDetect" },
    { choices: "smartDetectTypes", default: false, defaultValue: ALL_CHOICES, description: "Object sensors.", group: "SmartDetect", multiple: true,
      name: "SmartDetect.ObjectSensors" },
    { default: false, defaultValue: "", description: "License plates.", group: "SmartDetect", multiple: true, name: "SmartDetect.ObjectSensors.LicensePlate" }
  ],

  Relay: [

    { choices: "relayOutputs", default: true, defaultValue: ALL_CHOICES, description: "Relay outputs.", multiple: true, name: "Outputs" }
  ],

  Video: [

    { choices: TIER_CHOICES, default: false, defaultValue: "Medium", description: "Direct RTSP stream tier.", name: "Rtsp.Only" }
  ],

  "Video.Timeshift": [

    { choices: TIER_CHOICES, default: false, defaultValue: "High", description: "Timeshift stream tier.", name: "Only" }
  ]
};

// The Protect families, in that plugin's own order.
const PROTECT_FAMILIES: RetiredFamily[] = [

  { members: FOB_BUTTONS.map(([ label, value ]) => ({ default: true, option: "Fob.Button." + label, value })), option: "Fob.Buttons" },
  { keptName: true, members: [], option: "Motion.SmartDetect.ObjectSensors" },
  { keptName: true, members: DETECTION_TYPES.map(([ name, value ]) => ({ default: OCCUPANCY_DEFAULTS.has(name), option: "Motion.OccupancySensor." + name, value })),
    option: "Motion.OccupancySensor" },
  { members: RELAY_OUTPUTS.map((output) => ({ default: true, option: "Relay.Output." + output, value: output })), option: "Relay.Outputs", overlayOnly: true },
  { members: TIERS.map((tier) => ({ default: false, option: "Video.Rtsp.Only." + tier, value: tier })), option: "Video.Rtsp.Only" },
  { members: TIERS.map((tier) => ({ default: false, option: "Video.Timeshift.Only." + tier, value: tier })), option: "Video.Timeshift.Only" }
];

const protect = createRetiredOptions({ categories: PROTECT_CATEGORIES, families: PROTECT_FAMILIES, options: PROTECT_OPTIONS });

// The topology a settings page's probes gather: one controller with its cameras beneath it, and a sibling controller with its own.
const TOPOLOGY: RetiredController[] = [

  { devices: [ CAMERA, OTHER_CAMERA ], id: CONTROLLER },
  { devices: ["CC0011223344"], id: OTHER_CONTROLLER }
];

// The surviving options a translation still overlays, read through the overlay itself: an overlaid option answers a selection, and any other answers undefined.
function overlaid(translation: RetiredTranslation, families: readonly RetiredFamily[] = PROTECT_FAMILIES): string[] {

  return families.map((family) => family.option).filter((option) => translation.selection({ domain: [], option }) !== undefined);
}

// One boot-view row: the configuration, the view the engine is built on, and, where the row says, the options still overlaid and the entries named for narration.
interface TranslationRow {

  readonly boot: readonly string[];
  readonly configured: readonly string[];
  readonly name: string;
  readonly overlaid?: readonly string[];
  readonly translated?: readonly string[];
}

/* The boot view, row for row as Protect's translation reads each configuration.
 *
 * A canonical configuration and text the translation cannot account for pass through untouched. A retired per-member entry composes the canonical value and joins
 * the overlay; a single-select family composes to the best tier named, whatever the entry order; a scope turning off everything a broader scope turned on states
 * the plain Disable, and one restating what it inherits states nothing. The user's own value outranks a family outright, per family. A kept-name family states
 * its selection only where its master resolves enabled, the empty selection included, and an option declared under its name is read as itself.
 */
const TRANSLATION_ROWS: readonly TranslationRow[] = [

  { boot: [ "Enable.Video.Rtsp.Only=High", "Disable.Device", "Enable.Motion.SmartDetect" ], configured: [ "Enable.Video.Rtsp.Only=High", "Disable.Device",
    "Enable.Motion.SmartDetect" ], name: "a canonical configuration passes through with no families and nothing translated", overlaid: [], translated: [] },
  { boot: [ "", "NotAnAction.Video.Rtsp.Only.High", "Enable", "Enable.Some.Option.Nobody.Declares", "Disable.Video.Rtsp.Only.Purple" ],
    configured: [ "", "NotAnAction.Video.Rtsp.Only.High", "Enable", "Enable.Some.Option.Nobody.Declares", "Disable.Video.Rtsp.Only.Purple" ],
    name: "entries the analysis cannot account for pass through byte-verbatim", translated: [] },
  { boot: ["Enable.Video.Rtsp.Only=High"], configured: ["Enable.Video.Rtsp.Only.High"], name: "a global per-tier entry composes the canonical tier",
    overlaid: ["Video.Rtsp.Only"], translated: ["Enable.Video.Rtsp.Only.High"] },
  { boot: ["Enable.Video.Rtsp.Only." + CAMERA + "=Medium"], configured: ["Enable.Video.Rtsp.Only.Medium." + CAMERA],
    name: "a device-scoped per-tier entry composes a scoped canonical tier", overlaid: ["Video.Rtsp.Only"] },
  { boot: ["Enable.Video.Rtsp.Only=High"], configured: [ "Enable.Video.Rtsp.Only.Low", "Enable.Video.Rtsp.Only.High" ],
    name: "a multi-tier configuration resolves to the best quality named, whatever the entry order", translated: [ "Enable.Video.Rtsp.Only.Low",
      "Enable.Video.Rtsp.Only.High" ] },
  { boot: [ "Enable.Video.Rtsp.Only=High", "Enable.Video.Timeshift.Only=Low" ], configured: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ],
    name: "the stream-tier families translate side by side", overlaid: [ "Video.Rtsp.Only", "Video.Timeshift.Only" ] },
  { boot: [ "Enable.Video.Rtsp.Only=High", "Disable.Video.Rtsp.Only." + CAMERA ], configured: [ "Enable.Video.Rtsp.Only.High",
    "Disable.Video.Rtsp.Only.High." + CAMERA ], name: "a scope that disables every tier a broader scope enables composes the plain Disable" },
  { boot: [], configured: ["Disable.Video.Rtsp.Only.High." + CAMERA], name: "a scope restating what it already inherits composes nothing",
    translated: ["Disable.Video.Rtsp.Only.High." + CAMERA] },
  { boot: ["Enable.Video.Rtsp.Only=Low"], configured: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Rtsp.Only=Low" ],
    name: "a canonical value supersedes the retired entries of its family outright", overlaid: [], translated: ["Enable.Video.Rtsp.Only.High"] },
  { boot: [ "Enable.Video.Rtsp.Only=Low", "Enable.Video.Timeshift.Only=High" ], configured: [ "Enable.Video.Rtsp.Only=Low", "Enable.Video.Timeshift.Only.High" ],
    name: "supersession does not reach across families", overlaid: ["Video.Timeshift.Only"] },
  { boot: ["Enable.Motion.OccupancySensor=face,person,vehicle"], configured: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ],
    name: "global per-type entries compose the master's selection in wire values", overlaid: ["Motion.OccupancySensor"],
    translated: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ] },
  { boot: ["Enable.Motion.OccupancySensor=person"], configured: [ "Enable.Motion.OccupancySensor", "Disable.Motion.OccupancySensor.Face" ],
    name: "a retired per-type Disable subtracts a default-on type" },
  { boot: ["Enable.Motion.OccupancySensor="], configured: [ "Enable.Motion.OccupancySensor", "Disable.Motion.OccupancySensor.Face",
    "Disable.Motion.OccupancySensor.Person" ], name: "an all-types-off selection with the master on survives as the explicit empty payload" },
  { boot: [], configured: ["Enable.Motion.OccupancySensor.Vehicle"], name: "per-type entries under a disabled master are dropped and named",
    translated: ["Enable.Motion.OccupancySensor.Vehicle"] },
  { boot: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor." + CAMERA + "=face,person,vehicle" ],
    configured: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ],
    name: "a global master stands as written while a member speaks at another scope", translated: ["Enable.Motion.OccupancySensor.Vehicle." + CAMERA] },
  { boot: ["Enable.Motion.OccupancySensor." + CAMERA + "=face,person"], configured: ["Enable.Motion.OccupancySensor." + CAMERA],
    name: "a scoped bare master is rewritten into the canonical scoped form", overlaid: ["Motion.OccupancySensor"] },
  { boot: ["Enable.Motion.OccupancySensor"], configured: ["Enable.Motion.OccupancySensor"],
    name: "a global bare master with no per-type entries passes through untouched", overlaid: [], translated: [] },
  { boot: [ "Enable.Motion.OccupancySensor.Duration", "Enable.Motion.OccupancySensor=face,person,vehicle" ],
    configured: [ "Enable.Motion.OccupancySensor.Duration", "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ],
    name: "a bare enable of the duration sibling is never read as a scoped master",
    translated: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ] },
  { boot: ["Enable.Motion.OccupancySensor=face,person,vehicle"], configured: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ],
    name: "a bare master enable never triggers supersession", overlaid: ["Motion.OccupancySensor"] },
  { boot: ["Enable.Motion.OccupancySensor=vehicle"], configured: [ "Enable.Motion.OccupancySensor.Vehicle", "Enable.Motion.OccupancySensor=vehicle" ],
    name: "a canonical value supersedes the per-type entries", overlaid: [], translated: ["Enable.Motion.OccupancySensor.Vehicle"] },
  { boot: ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA + "=*"], configured: ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA],
    name: "a scoped bare object-sensor master is rewritten to the all-choices selection at that scope", overlaid: [],
    translated: ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA] },
  { boot: ["Enable.Motion.SmartDetect.ObjectSensors"], configured: ["Enable.Motion.SmartDetect.ObjectSensors"],
    name: "a global bare object-sensor master passes through untouched", translated: [] },
  { boot: [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate", "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA + "=*" ],
    configured: [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate", "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA ],
    name: "a bare enable of the plate sibling is never read as a scoped master", translated: ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA] },
  { boot: ["Enable.Motion.SmartDetect.ObjectSensors=person"], configured: [ "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA,
    "Enable.Motion.SmartDetect.ObjectSensors=person" ], name: "a canonical value supersedes a scoped bare master" },
  { boot: ["Enable.Fob.Buttons=arm,night,disarm,right,left"], configured: ["Disable.Fob.Button.Panic"],
    name: "a global per-button Disable composes the buttons that remain", overlaid: ["Fob.Buttons"] },
  { boot: ["Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right,left"], configured: ["Disable.Fob.Button.Panic." + CAMERA],
    name: "a device-scoped per-button Disable composes that fob's own selection" },
  { boot: ["Disable.Fob.Buttons"], configured: FOB_BUTTONS.map(([label]) => "Disable.Fob.Button." + label),
    name: "a scope with every button disabled composes the plain Disable" },
  { boot: [ "Enable.Fob.Buttons=arm,night,disarm,right,left", "Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right" ], configured: [ "Disable.Fob.Button.Panic",
    "Disable.Fob.Button.Left." + CAMERA ], name: "a globally hidden button stays hidden at a fob scope whose own entries touch a different button" },
  { boot: ["Enable.Fob.Buttons=arm,night,disarm,right,left"], configured: [ "Disable.Fob.Button.Panic", "Disable.Fob.Button.Panic." + CAMERA ],
    name: "a fob scope that restates what it inherits composes nothing" },
  { boot: [ "Enable.Fob.Buttons=arm,night,disarm,right,left", "Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,panic,right" ],
    configured: [ "Disable.Fob.Button.Panic", "Disable.Fob.Button.Left." + CAMERA, "Enable.Fob.Button.Panic." + CAMERA ],
    name: "a fob scope that trades a button for another composes its own selection" },
  { boot: ["Disable.Relay.Output.2"], configured: ["Disable.Relay.Output.2"],
    name: "retired per-output entries pass through untouched while the family joins the overlay", overlaid: ["Relay.Outputs"], translated: ["Disable.Relay.Output.2"] },
  { boot: [ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ], configured: [ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ],
    name: "a canonical selection supersedes the retired per-output entries", overlaid: [] },
  { boot: [ "Enable.Video.Rtsp.Only." + CONTROLLER + "=High", "Enable.Video.Rtsp.Only." + CAMERA + "=Medium" ],
    configured: [ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Enable.Video.Rtsp.Only.Medium." + CAMERA ],
    name: "the boot view composes a controller and device pairing per scope, which is the documented approximation", overlaid: ["Video.Rtsp.Only"] }
];

// One overlay row: the configuration, the option read, and what each reader gets back - undefined where the overlay has nothing to say.
interface OverlayRow {

  readonly configured: readonly string[];
  readonly name: string;
  readonly option: string;
  readonly reads: readonly { readonly controller?: string; readonly device?: string; readonly domain: readonly string[]; readonly selected?: readonly string[] }[];
}

/* The overlay, row for row as Protect's runtime read answers each configuration. A global entry reaches every camera and a scoped one only its own; a controller
 * scope composes with a device scope through the reader's own controller and never leaks to a camera beneath another; the answer is expressed in the reader's
 * domain, confined to it, and matched without regard to casing. A family nothing configured is not overlaid at all, and the reader reads the engine.
 */
const OVERLAY_ROWS: readonly OverlayRow[] = [

  { configured: [], name: "an unconfigured family is not overlaid, so the reader reads the engine", option: "Video.Rtsp.Only",
    reads: [{ controller: CONTROLLER, device: CAMERA, domain: TIERS }] },
  { configured: ["Enable.Video.Rtsp.Only.Medium"], name: "a global per-tier entry reaches every camera", option: "Video.Rtsp.Only",
    reads: [ { controller: CONTROLLER, device: CAMERA, domain: TIERS, selected: ["Medium"] }, { controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: TIERS,
      selected: ["Medium"] } ] },
  { configured: ["Enable.Video.Rtsp.Only.High." + CAMERA], name: "a device-scoped per-tier entry reaches only its own camera", option: "Video.Rtsp.Only",
    reads: [ { controller: CONTROLLER, device: CAMERA, domain: TIERS, selected: ["High"] },
      { controller: CONTROLLER, device: OTHER_CAMERA, domain: TIERS, selected: [] } ] },
  { configured: [ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Enable.Video.Rtsp.Only.Medium." + CAMERA ],
    name: "a controller-scoped tier composes with a device-scoped tier and the best quality still wins", option: "Video.Rtsp.Only",
    reads: [ { controller: CONTROLLER, device: CAMERA, domain: TIERS, selected: ["High"] }, { controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: TIERS,
      selected: [] } ] },
  { configured: [ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Disable.Video.Rtsp.Only.High." + CAMERA ],
    name: "a device-scoped disable of the controller's tier resolves to no tier", option: "Video.Rtsp.Only",
    reads: [ { controller: CONTROLLER, device: CAMERA, domain: TIERS, selected: [] },
      { controller: CONTROLLER, device: OTHER_CAMERA, domain: TIERS, selected: ["High"] } ] },
  { configured: ["enable.video.RTSP.only.HIGH"], name: "retired option names match without regard to casing", option: "Video.Rtsp.Only",
    reads: [{ controller: CONTROLLER, device: CAMERA, domain: TIERS, selected: ["High"] }] },
  { configured: ["Enable.Video.Timeshift.Only.Low"], name: "the selection is answered in the domain's own spelling", option: "Video.Timeshift.Only",
    reads: [{ controller: CONTROLLER, device: CAMERA, domain: [ "HIGH", "MEDIUM", "LOW" ], selected: ["LOW"] }] },
  { configured: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ], name: "the occupancy selection is confined to the domain the caller offers",
    option: "Motion.OccupancySensor", reads: [{ controller: CONTROLLER, device: CAMERA, domain: [ "person", "vehicle" ], selected: [ "person", "vehicle" ] }] },
  { configured: [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER, "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ],
    name: "a controller-scoped type composes with a device-scoped type and never leaks to another controller", option: "Motion.OccupancySensor",
    reads: [ { controller: CONTROLLER, device: CAMERA, domain: [ "face", "person", "vehicle" ], selected: [ "person", "vehicle" ] },
      { controller: CONTROLLER, device: OTHER_CAMERA, domain: [ "face", "person", "vehicle" ], selected: ["person"] },
      { controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: [ "face", "person", "vehicle" ], selected: [ "face", "person" ] } ] },
  { configured: [ "Disable.Fob.Button.Panic." + CONTROLLER, "Disable.Fob.Button.Left." + CAMERA ],
    name: "a controller-scoped button subtraction composes with a device-scoped one and never leaks to another controller", option: "Fob.Buttons",
    reads: [ { controller: CONTROLLER, device: CAMERA, domain: FOB_DOMAIN, selected: [ "arm", "night", "disarm", "right" ] },
      { controller: CONTROLLER, device: OTHER_CAMERA, domain: FOB_DOMAIN, selected: [ "arm", "night", "disarm", "right", "left" ] },
      { controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: FOB_DOMAIN, selected: FOB_DOMAIN } ] },
  { configured: [ "Disable.Relay.Output.1." + CONTROLLER, "Disable.Relay.Output.2." + CAMERA ],
    name: "a controller-scoped output subtraction composes with a device-scoped one and never leaks to another controller", option: "Relay.Outputs",
    reads: [ { controller: CONTROLLER, device: CAMERA, domain: [ "1", "2", "3" ], selected: [] },
      { controller: CONTROLLER, device: OTHER_CAMERA, domain: [ "1", "2", "3" ], selected: ["2"] },
      { controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: [ "1", "2", "3" ], selected: [ "1", "2" ] } ] }
];

// One durable-rewrite row: the configuration, the topology the pass had, and what it writes and reports.
interface MigrationRow {

  readonly configured: readonly string[];
  readonly controllers: readonly RetiredController[];
  readonly migrated: readonly string[];
  readonly name: string;
  readonly remaining: boolean;
}

/* The durable rewrite, row for row as Protect's migration writes each configuration. Protect's devices sit beneath controllers, so a pass with no topology hands
 * over an empty list, which holds every family naming a scope the pass cannot place. A topology placing every scope composes through each device's true
 * controller, and retirement is per family.
 */
const MIGRATION_ROWS: readonly MigrationRow[] = [

  { configured: ["Enable.Video.Rtsp.Only.High"], controllers: [], migrated: ["Enable.Video.Rtsp.Only=High"],
    name: "a global-only configuration migrates with no topology and reports nothing remaining", remaining: false },
  { configured: ["Enable.Video.Rtsp.Only.Medium." + CAMERA], controllers: [], migrated: ["Enable.Video.Rtsp.Only.Medium." + CAMERA],
    name: "a scoped entry with no topology keeps its family's entries and reports them remaining", remaining: true },
  { configured: [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER, "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ],
    controllers: TOPOLOGY, migrated: [ "Enable.Motion.OccupancySensor." + CONTROLLER + "=person", "Enable.Motion.OccupancySensor." + CAMERA + "=person,vehicle" ],
    name: "a controller-plus-device composition migrates exactly once the topology places the scopes", remaining: false },
  { configured: [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER, "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ],
    controllers: [], migrated: [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER,
      "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ], name: "without topology the same family waits rather than writing the approximation", remaining: true },
  { configured: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low." + UNPLACED ], controllers: TOPOLOGY,
    migrated: [ "Enable.Video.Timeshift.Only.Low." + UNPLACED, "Enable.Video.Rtsp.Only=High" ],
    name: "a family the topology cannot place waits while its neighbors migrate", remaining: true },
  { configured: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Rtsp.Only=Low" ], controllers: [], migrated: ["Enable.Video.Rtsp.Only=Low"],
    name: "a superseded family's retired entries are dropped outright", remaining: false },

  // A held kept-name entry stays byte-verbatim beside a neighbor's composition, which a writer that normalized the surviving entries would corrupt.
  { configured: [ "Enable.Motion.OccupancySensor." + UNPLACED, "Enable.Video.Rtsp.Only.High" ], controllers: TOPOLOGY,
    migrated: [ "Enable.Motion.OccupancySensor." + UNPLACED, "Enable.Video.Rtsp.Only=High" ],
    name: "an unplaced occupancy scope is held byte-verbatim while a neighbor migrates", remaining: true }
];

describe("createRetiredOptions - the boot view over a Protect-shaped catalog", () => {

  for(const row of TRANSLATION_ROWS) {

    test(row.name, () => {

      const translation = protect.translate(row.configured);

      assert.deepEqual(translation.configuredOptions, row.boot, "the view the engine is built on");

      if(row.overlaid) {

        assert.deepEqual(overlaid(translation), row.overlaid, "the options still overlaid");
      }

      if(row.translated) {

        assert.deepEqual(translation.translated, row.translated, "the entries named for the startup narration");
      }
    });
  }
});

describe("createRetiredOptions - the overlay over a Protect-shaped catalog", () => {

  for(const row of OVERLAY_ROWS) {

    test(row.name, () => {

      const translation = protect.translate(row.configured);

      for(const { controller, device, domain, selected } of row.reads) {

        assert.deepEqual(translation.selection({ controller, device, domain, option: row.option }), selected, "the read at device " + String(device) +
          " under controller " + String(controller));
      }
    });
  }
});

describe("createRetiredOptions - the durable rewrite over a Protect-shaped catalog", () => {

  for(const row of MIGRATION_ROWS) {

    test(row.name, () => {

      const migration = protect.migrate({ configuredOptions: row.configured, controllers: row.controllers });

      assert.deepEqual(migration.configuredOptions, row.migrated, "what the pass writes");
      assert.equal(migration.remaining, row.remaining, "whether a family waits for a wider topology");
    });
  }

  // A plugin with no controller level omits the topology, which composes every family through its scope and the global level: exact, since nothing sits between.
  test("an omitted topology is a flat plugin, whose scoped entries migrate on the first pass", () => {

    const migration = protect.migrate({ configuredOptions: ["Enable.Video.Rtsp.Only.Medium." + CAMERA] });

    assert.deepEqual(migration.configuredOptions, ["Enable.Video.Rtsp.Only." + CAMERA + "=Medium"], "the scope composes through itself and the global level");
    assert.equal(migration.remaining, false, "and nothing waits");
  });

  test("a controller in any casing answers for itself and a device for its controller", () => {

    const topology = [{ devices: [CAMERA.toLowerCase()], id: CONTROLLER.toLowerCase() }];
    const migration = protect.migrate({ configuredOptions: [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER,
      "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ], controllers: topology });

    assert.deepEqual(migration.configuredOptions, [ "Enable.Motion.OccupancySensor." + CONTROLLER + "=person",
      "Enable.Motion.OccupancySensor." + CAMERA + "=person,vehicle" ], "the camera composes through the controller the topology spelled differently");
    assert.equal(migration.remaining, false);
  });
});

/* The blind spots a differential reading sorted text over a members-only domain cannot see: the order compositions are emitted in, a scope spelled in differing
 * casings, a bare entry for a surviving option that took a new name, the plain Disable a family whose members all defaulted on composes, and a superseded
 * overlay-only family.
 */
describe("createRetiredOptions - what a sorted reading cannot see", () => {

  test("families emit in the order they are declared, whatever order their entries appear in", () => {

    const configured = [ "Enable.Video.Timeshift.Only.Low", "Enable.Video.Rtsp.Only.High" ];

    assert.deepEqual(protect.translate(configured).configuredOptions, [ "Enable.Video.Rtsp.Only=High", "Enable.Video.Timeshift.Only=Low" ],
      "the direct-RTSP family is declared first, so its composition is emitted first");
    assert.deepEqual(protect.migrate({ configuredOptions: configured, controllers: [] }).configuredOptions,
      [ "Enable.Video.Rtsp.Only=High", "Enable.Video.Timeshift.Only=Low" ], "and the durable rewrite emits in the same order");
  });

  test("a scope spelled in different casings composes once, in the spelling it first appeared in", () => {

    const configured = [ "Disable.Fob.Button.Panic." + CAMERA, "Disable.Fob.Button.Left." + CAMERA.toLowerCase() ];

    assert.deepEqual(protect.translate(configured).configuredOptions, ["Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right"],
      "the subtractions compose at the one scope they name");
    assert.deepEqual(protect.migrate({ configuredOptions: configured, controllers: TOPOLOGY }).configuredOptions,
      ["Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right"], "and the durable rewrite places it once");
  });

  test("a bare entry for a surviving option that took a new name supersedes its family", () => {

    for(const [ configured, kept ] of [ [ [ "Disable.Fob.Button.Panic", "Enable.Fob.Buttons" ], ["Enable.Fob.Buttons"] ],
      [ [ "Enable.Video.Rtsp.Only.High", "Disable.Video.Rtsp.Only" ], ["Disable.Video.Rtsp.Only"] ] ] as const) {

      const translation = protect.translate(configured);

      assert.deepEqual(translation.configuredOptions, kept, "the user's own entry is what the engine is left with: " + configured.join(", "));
      assert.deepEqual(overlaid(translation), [], "and the superseded family is not overlaid");
      assert.deepEqual(protect.migrate({ configuredOptions: configured, controllers: [] }).configuredOptions, kept, "nor rewritten");
    }
  });

  test("a superseded overlay-only family keeps its entries in the boot view and answers nothing through the overlay", () => {

    for(const configured of [ [ "Disable.Relay.Output.2", "Enable.Relay.Outputs" ], [ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ] ]) {

      const translation = protect.translate(configured);

      assert.equal(translation.configuredOptions, configured, "the boot view is the input itself");
      assert.equal(translation.selection({ controller: CONTROLLER, device: CAMERA, domain: [ "1", "2", "3" ], option: "Relay.Outputs" }), undefined,
        "and the reader reads the engine");
      assert.deepEqual(translation.translated, ["Disable.Relay.Output.2"], "the set-aside entry is still named for the startup line");
    }
  });

  test("an overlay-only family composes like any other at the durable rewrite", () => {

    assert.deepEqual(protect.migrate({ configuredOptions: ["Disable.Relay.Output.2." + CAMERA], controllers: TOPOLOGY }).configuredOptions,
      ["Enable.Relay.Outputs." + CAMERA + "=1"], "the rewrite has the topology the boot view lacks, so it states the output that remains");
  });

  test("every member selected states the list itself where the surviving option's default is a literal list", () => {

    // The all-choices value stands for whatever domain a device reports, which a literal default does not mean, so a scope selecting every member states them.
    const categories = [{ description: "Logging", name: "Log" }];
    const options = { Log: [{ choices: [ { label: "A", value: "A" }, { label: "B", value: "B" } ], default: true, defaultValue: "A,B", description: "Listed.",
      multiple: true, name: "Events" }] };
    const listed = createRetiredOptions({ categories, families: [{ members: [ { default: true, option: "Log.A", value: "A" }, { default: true, option: "Log.B",
      value: "B" } ], option: "Log.Events" }], options });

    assert.deepEqual(listed.migrate({ configuredOptions: [ "Disable.Log.A", "Enable.Log.A." + CAMERA ] }).configuredOptions,
      [ "Enable.Log.Events=B", "Enable.Log.Events." + CAMERA + "=A,B" ]);
  });

  test("every member selected states the all-choices value where the surviving option's default is that value", () => {

    // The global subtraction leaves every button but one and the camera's re-enable restores it, so the camera's scope selects every member the retired catalog
    // knew. Stating the all-choices value there keeps it tracking whatever buttons the fob reports, which a literal list would freeze.
    assert.deepEqual(protect.translate([ "Disable.Fob.Button.Panic", "Enable.Fob.Button.Panic." + CAMERA ]).configuredOptions,
      [ "Enable.Fob.Buttons=arm,night,disarm,right,left", "Enable.Fob.Buttons." + CAMERA + "=*" ]);
  });
});

describe("createRetiredOptions - no-ops and convergence", () => {

  test("each act answers the input reference when nothing retired is configured", () => {

    for(const configured of [ [], ["Enable.Video.Rtsp.Only=High"], [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Duration" ] ]) {

      const translation = protect.translate(configured);

      assert.equal(translation.configuredOptions, configured, "the boot view is the input itself");
      assert.deepEqual(translation.translated, [], "with nothing to narrate");

      for(const migration of [ protect.migrate({ configuredOptions: configured }), protect.migrate({ configuredOptions: configured, controllers: TOPOLOGY }) ]) {

        assert.equal(migration.configuredOptions, configured, "and the rewrite writes nothing");
        assert.equal(migration.remaining, false, "with nothing left for a later pass");
      }
    }
  });

  test("a scoped master Disable is no retired shape, so neither act touches it", () => {

    // A Disable of the kept name at a scope spells the same thing in the retired grammar and the current one, and nothing composed could say it, so it stands.
    const configured = ["Disable.Motion.OccupancySensor." + CAMERA];
    const translation = protect.translate(configured);
    const migration = protect.migrate({ configuredOptions: configured, controllers: [] });

    assert.equal(translation.configuredOptions, configured, "the boot view is the input itself");
    assert.deepEqual(translation.translated, [], "with nothing to narrate");
    assert.deepEqual(overlaid(translation), [], "and nothing overlaid");
    assert.equal(migration.configuredOptions, configured, "the rewrite writes nothing, even holding unplaced scopes");
    assert.equal(migration.remaining, false, "and nothing waits for a wider topology");
  });

  test("a second pass over a rewritten configuration stays put, and the overlay has nothing left to say", () => {

    for(const row of MIGRATION_ROWS.filter(({ remaining }) => !remaining)) {

      const first = protect.migrate({ configuredOptions: row.configured, controllers: row.controllers });
      const second = protect.migrate({ configuredOptions: first.configuredOptions, controllers: row.controllers });

      assert.equal(second.configuredOptions, first.configuredOptions, "the second pass answers its input itself: " + row.name);
      assert.deepEqual(overlaid(protect.translate(first.configuredOptions)), [], "and a converged configuration is overlaid nowhere: " + row.name);
    }
  });
});

// A family is the plugin's own declaration, so one that cannot mean what it says is refused when the translation is built, as the catalog builder refuses its own.
describe("createRetiredOptions - a misdeclared family", () => {

  test("a surviving option the catalog does not declare is refused, naming it", () => {

    assert.throws(() => createRetiredOptions({ categories: PROTECT_CATEGORIES, families: [{ members: [], option: "Video.Rtsp.Gone" }], options: PROTECT_OPTIONS }),
      { message: "FeatureOptions: the retired family carried by \"Video.Rtsp.Gone\" names an option the catalog does not declare." });
  });

  test("a member the catalog still declares is refused, naming it", () => {

    assert.throws(() => createRetiredOptions({ categories: PROTECT_CATEGORIES, families: [{ members: [{ default: true, option: "Motion.SmartDetect", value: "on" }],
      option: "Video.Rtsp.Only" }], options: PROTECT_OPTIONS }),
    { message: "FeatureOptions: the retired member \"Motion.SmartDetect\" is an option the catalog still declares." });
  });
});

// A plugin's configuration arrives untyped, so each case is what a hand-edited file could hold, handed in as the setting the signature declares.
const asSetting = (setting: unknown): string[] => setting as string[];

describe("createRetiredOptions - a setting that is not a list of strings", () => {

  // A two-member family over a catalog no plugin declares, so these rows read the setting's rule alone.
  const categories = [{ description: "Widget", name: "Widget" }];
  const options = { Widget: [{ choices: [ { label: "Alpha", value: "Alpha" }, { label: "Beta", value: "Beta" } ], default: true, defaultValue: "Alpha,Beta",
    description: "Parts.", multiple: true, name: "Parts" }] };
  const widget = createRetiredOptions({ categories, families: [{ members: [ { default: true, option: "Widget.Alpha", value: "Alpha" },
    { default: true, option: "Widget.Beta", value: "Beta" } ], option: "Widget.Parts" }], options });

  test("a setting that is not a list holds no entries, and neither act throws on it", () => {

    for(const setting of [ "Disable.Widget.Alpha", { options: ["Disable.Widget.Alpha"] }, 5 ]) {

      const translation = widget.translate(asSetting(setting));

      assert.deepEqual(translation.configuredOptions, [], "the boot view holds no entries: " + JSON.stringify(setting));
      assert.deepEqual(translation.translated, [], "with nothing to narrate: " + JSON.stringify(setting));
      assert.deepEqual(widget.migrate({ configuredOptions: asSetting(setting), controllers: [] }).configuredOptions, [],
        "and the rewrite writes an empty list: " + JSON.stringify(setting));
    }
  });

  test("a list keeps its strings, so a retired entry beside entries that are not strings still translates", () => {

    const setting = asSetting([ null, "Disable.Widget.Alpha", 5, {} ]);
    const translation = widget.translate(setting);

    assert.deepEqual(translation.configuredOptions, ["Enable.Widget.Parts=Beta"], "the boot view composes the retired entry alone");
    assert.deepEqual(translation.translated, ["Disable.Widget.Alpha"], "and narrates it");
    assert.deepEqual(widget.migrate({ configuredOptions: setting }).configuredOptions, ["Enable.Widget.Parts=Beta"], "as does the rewrite");
  });

  test("a list holding no retired entry is answered without its other values, never by reference", () => {

    const setting = asSetting([ "Disable.Widget.Parts", null ]);

    assert.deepEqual(widget.translate(setting).configuredOptions, ["Disable.Widget.Parts"], "the boot view keeps the string alone");
    assert.deepEqual(widget.migrate({ configuredOptions: setting }).configuredOptions, ["Disable.Widget.Parts"],
      "and so does the rewrite, which a settings page writes back");
  });
});

// The HBUA shape: a flat plugin whose sensor and logging lists carry what its retired grammar spelled as one switch per sensor and per logging category, every
// member defaulting on.
const ACCESS_CATEGORIES: FeatureCategoryEntry[] = [

  { description: "Hub", name: "Hub" },
  { description: "Logging", name: "Log" }
];

const ACCESS_OPTIONS: Record<string, FeatureOptionEntry[]> = {

  Hub: [

    { choices: "hubSensors", default: true, defaultValue: ALL_CHOICES, description: "Hub sensors.", multiple: true, name: "Sensors" },
    { default: true, description: "Side door lock.", name: "SideDoor" }
  ],

  Log: [

    { choices: "logEvents", default: true, defaultValue: ALL_CHOICES, description: "Logged events.", multiple: true, name: "Events" }
  ]
};

const SENSOR_MEMBERS = [ "DPS", "REL", "REN", "REX", "SideDoorDPS" ];
const EVENT_MEMBERS = [ "Doorbell", "DPS", "Lock", "REL", "REN", "REX" ];

const ACCESS_FAMILIES: RetiredFamily[] = [

  { members: SENSOR_MEMBERS.map((value) => ({ default: true, option: "Hub." + ((value === "SideDoorDPS") ? "SideDoor.DPS" : value), value })), option: "Hub.Sensors" },
  { members: EVENT_MEMBERS.map((value) => ({ default: true, option: "Log." + value, value })), option: "Log.Events" }
];

const access = createRetiredOptions({ categories: ACCESS_CATEGORIES, families: ACCESS_FAMILIES, options: ACCESS_OPTIONS });

const ACCESS_CONTROLLER = "AABBCCDDEEFF";
const ACCESS_OTHER = "112233445566";
const ACCESS_DEVICE = "0123456789AB";

// What a list resolves to at a scope, read through the served engine exactly as the plugin's own device read takes it.
function accessSelects(configured: readonly string[], option: string, id?: string): readonly string[] {

  return new FeatureOptions(ACCESS_CATEGORIES, ACCESS_OPTIONS, [...configured]).valueList({ defaultWhenUnset: true, device: id,
    domain: (option === "Hub.Sensors") ? SENSOR_MEMBERS : EVENT_MEMBERS, option });
}

describe("createRetiredOptions - the HBUA families", () => {

  test("a globally disabled sensor composes the list of everything else, and the retired entry leaves", () => {

    const migrated = access.migrate({ configuredOptions: ["Disable.Hub.DPS"] }).configuredOptions;

    assert.deepEqual(migrated, ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"], "one member's switch turned off composes the list carrying every other member");
    assert.deepEqual(accessSelects(migrated, "Hub.Sensors"), [ "REL", "REN", "REX", "SideDoorDPS" ], "and the composed list resolves to exactly those members");
    assert.deepEqual(accessSelects(migrated, "Log.Events"), EVENT_MEMBERS, "while the family nothing was configured for composes nothing and still reads whole");
  });

  test("a scoped logging category turned off composes that scope's list alone", () => {

    const migrated = access.migrate({ configuredOptions: ["Disable.Log.Lock." + ACCESS_CONTROLLER] }).configuredOptions;

    assert.deepEqual(accessSelects(migrated, "Log.Events", ACCESS_CONTROLLER), [ "Doorbell", "DPS", "REL", "REN", "REX" ], "the named scope loses the category");
    assert.deepEqual(accessSelects(migrated, "Log.Events"), EVENT_MEMBERS, "and the global reading is untouched");
    assert.deepEqual(accessSelects(migrated, "Log.Events", ACCESS_OTHER), EVENT_MEMBERS, "as is every other scope's");
  });

  test("a member re-enabled at one scope over a global disable keeps that scope every member", () => {

    const migrated = access.migrate({ configuredOptions: [ "Disable.Hub.DPS", "Enable.Hub.DPS." + ACCESS_DEVICE ] }).configuredOptions;

    assert.ok(migrated.includes("Enable.Hub.Sensors." + ACCESS_DEVICE + "=" + ALL_CHOICES),
      "a scope composing every member stores the all-members form, in the spelling the scope was written in");
    assert.deepEqual(accessSelects(migrated, "Hub.Sensors", ACCESS_DEVICE), SENSOR_MEMBERS, "so the device keeps the sensor the global entry took away");
    assert.deepEqual(accessSelects(migrated, "Hub.Sensors"), [ "REL", "REN", "REX", "SideDoorDPS" ], "while every other hub reads the global composition");
  });

  test("a retired entry is read and dropped in any spelling the grammar accepts", () => {

    const migrated = access.migrate({ configuredOptions: [("Disable.Hub.REX." + ACCESS_CONTROLLER).toLowerCase()] }).configuredOptions;

    assert.deepEqual(accessSelects(migrated, "Hub.Sensors", ACCESS_CONTROLLER), [ "DPS", "REL", "REN", "SideDoorDPS" ], "the entry is read at the scope it names");
    assert.ok(migrated.every((entry) => !entry.toLowerCase().includes("hub.rex")), "and no retired entry survives the pass");
  });

  test("a configuration carrying no retired entry composes nothing at all", () => {

    for(const configured of [ ["Enable.Hub.Sensors=REL,REN"], [] ]) {

      assert.equal(access.migrate({ configuredOptions: configured }).configuredOptions, configured, "the rewrite answers its input itself");
    }
  });

  test("a scope restating what it would inherit composes no entry of its own", () => {

    const migrated = access.migrate({ configuredOptions: [ "Disable.Hub.DPS", "Disable.Hub.DPS." + ACCESS_DEVICE ] }).configuredOptions;

    assert.deepEqual(migrated, ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"], "the scoped entry composes what the global one does, so nothing is written for it");
    assert.deepEqual(accessSelects(migrated, "Hub.Sensors", ACCESS_DEVICE), [ "REL", "REN", "REX", "SideDoorDPS" ], "and the device still reads what it read before");
  });

  test("the side door's sensor and the doorbell category compose onto their own families", () => {

    const sensors = access.migrate({ configuredOptions: ["Disable.Hub.SideDoor.DPS"] }).configuredOptions;

    assert.deepEqual(accessSelects(sensors, "Hub.Sensors"), [ "DPS", "REL", "REN", "REX" ], "a name whose own prefix is another catalog option is read as itself");

    const events = access.migrate({ configuredOptions: ["Disable.Log.Doorbell"] }).configuredOptions;

    assert.deepEqual(events, ["Enable.Log.Events=DPS,Lock,REL,REN,REX"], "and the doorbell category composes onto the logging list in the order it lists them");
    assert.deepEqual(accessSelects(events, "Log.Events"), [ "DPS", "Lock", "REL", "REN", "REX" ], "which resolves to exactly those categories");
  });

  test("every category turned off composes the plain Disable", () => {

    assert.deepEqual(access.migrate({ configuredOptions: EVENT_MEMBERS.map((value) => "Disable.Log." + value) }).configuredOptions, ["Disable.Log.Events"],
      "an empty composition and a disabled list each read as nothing selected, and the Disable says it in the spelling a user would write");
  });

  test("a bare entry for a surviving list supersedes its family", () => {

    assert.deepEqual(access.migrate({ configuredOptions: [ "Disable.Log.Lock", "Disable.Log.Events" ] }).configuredOptions, ["Disable.Log.Events"],
      "the user's own Disable outranks the retired subtraction beside it");
    assert.deepEqual(access.migrate({ configuredOptions: [ "Disable.Hub.DPS", "Enable.Hub.Sensors." + ACCESS_DEVICE ] }).configuredOptions,
      ["Enable.Hub.Sensors." + ACCESS_DEVICE], "and so does a bare scoped enable, at whatever scope it sits");
  });
});

// The ratgdo shape: a flat plugin whose logging list carries what its retired grammar spelled as one switch per event, every one defaulting on, beside an
// unrelated global switch.
const RATGDO_EVENTS = [ "Opener", "Light", "Motion", "Obstruction", "VehiclePresence" ];
const RATGDO_CATEGORIES: FeatureCategoryEntry[] = [{ description: "Logging", name: "Log" }];

const RATGDO_OPTIONS: Record<string, FeatureOptionEntry[]> = {

  Log: [

    { default: false, description: "Debug logging.", name: "Debug", scopes: ["global"] },
    { choices: RATGDO_EVENTS.map((value) => ({ label: value, value })), default: true, defaultValue: ALL_CHOICES, description: "Logged events.", multiple: true,
      name: "Events", scopes: [ "device", "global" ] }
  ]
};

const ratgdo = createRetiredOptions({ categories: RATGDO_CATEGORIES, families: [{ members: RATGDO_EVENTS.map((value) => ({ default: true, option: "Log." + value,
  value })), option: "Log.Events" }], options: RATGDO_OPTIONS });

const RATGDO_DEVICE = "AABBCCDDEEFF";

// One ratgdo row: the configuration, what the rewrite writes, and what the served engine reads from it globally and at the device.
interface RatgdoRow {

  readonly configured: readonly string[];
  readonly device: readonly string[];
  readonly global: readonly string[];
  readonly migrated: readonly string[];
}

const RATGDO_ROWS: readonly RatgdoRow[] = [

  { configured: ["Disable.Log.Opener"], device: [ "Light", "Motion", "Obstruction", "VehiclePresence" ], global: [ "Light", "Motion", "Obstruction", "VehiclePresence" ],
    migrated: ["Enable.Log.Events=Light,Motion,Obstruction,VehiclePresence"] },
  { configured: RATGDO_EVENTS.map((value) => "Disable.Log." + value), device: [], global: [], migrated: ["Disable.Log.Events"] },
  { configured: RATGDO_EVENTS.map((value) => "Disable.Log." + value + "." + RATGDO_DEVICE), device: [], global: RATGDO_EVENTS,
    migrated: ["Disable.Log.Events." + RATGDO_DEVICE] },
  { configured: [ "Disable.Log.Light", "Enable.Log.Light." + RATGDO_DEVICE ], device: RATGDO_EVENTS, global: [ "Opener", "Motion", "Obstruction", "VehiclePresence" ],
    migrated: [ "Enable.Log.Events=Opener,Motion,Obstruction,VehiclePresence", "Enable.Log.Events." + RATGDO_DEVICE + "=*" ] },
  { configured: ["Enable.Log.Opener"], device: RATGDO_EVENTS, global: RATGDO_EVENTS, migrated: [] },
  { configured: ["disable.log.light." + RATGDO_DEVICE.toLowerCase()], device: [ "Opener", "Motion", "Obstruction", "VehiclePresence" ], global: RATGDO_EVENTS,
    migrated: ["Enable.Log.Events." + RATGDO_DEVICE.toLowerCase() + "=Opener,Motion,Obstruction,VehiclePresence"] },
  { configured: [ "Disable.Log.Light." + RATGDO_DEVICE, "Disable.Log.Motion." + RATGDO_DEVICE.toLowerCase() ], device: [ "Opener", "Obstruction", "VehiclePresence" ],
    global: RATGDO_EVENTS, migrated: ["Enable.Log.Events." + RATGDO_DEVICE + "=Opener,Obstruction,VehiclePresence"] },
  { configured: [ "Enable.Log.Debug", "Disable.Log.Motion" ], device: [ "Opener", "Light", "Obstruction", "VehiclePresence" ],
    global: [ "Opener", "Light", "Obstruction", "VehiclePresence" ], migrated: [ "Enable.Log.Debug", "Enable.Log.Events=Opener,Light,Obstruction,VehiclePresence" ] },
  { configured: [ "Enable.Log.Events=Opener", "Disable.Log.Light" ], device: ["Opener"], global: ["Opener"], migrated: ["Enable.Log.Events=Opener"] },
  { configured: ["Enable.Log.Events=Opener"], device: ["Opener"], global: ["Opener"], migrated: ["Enable.Log.Events=Opener"] }
];

describe("createRetiredOptions - the ratgdo family", () => {

  for(const row of RATGDO_ROWS) {

    test(JSON.stringify(row.configured), () => {

      const migration = ratgdo.migrate({ configuredOptions: row.configured });
      const engine = new FeatureOptions(RATGDO_CATEGORIES, RATGDO_OPTIONS, [...migration.configuredOptions]);
      const read = (id?: string): readonly string[] => engine.valueList({ defaultWhenUnset: true, device: id, domain: RATGDO_EVENTS, option: "Log.Events" });

      assert.deepEqual(migration.configuredOptions, row.migrated, "what the rewrite writes");
      assert.deepEqual(read(), row.global, "what the global scope reads");
      assert.deepEqual(read(RATGDO_DEVICE), row.device, "what the device reads");
      assert.equal(ratgdo.migrate({ configuredOptions: migration.configuredOptions }).configuredOptions, migration.configuredOptions, "and a second pass stays put");
    });
  }
});
