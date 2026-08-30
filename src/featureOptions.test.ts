/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions.test.ts: Unit tests for the hierarchical FeatureOptions system - the O(1) config lookup index, the global / controller / device scope resolution
 * precedence, value-centric option parsing, grouping, scope visualization (color), and the supporting helpers (expandOption, isValue, exists, getInteger, getFloat).
 *
 * Coverage focuses on behavior that is hard to see from reading the class alone: the greedy longest-prefix match used when value-centric option names overlap, the
 * first-write-wins rule for duplicate entries in configuredOptions, the scope hierarchy's "device overrides controller overrides global overrides default" contract,
 * and the edge-case surfaces of `value()` (null, undefined, fallback-to-default).
 */
import { ALL_CHOICES, applyClearOption, applySetOption, buildCatalogIndex, buildConfigIndex, composeScopeId, enumerateConfiguredEntries, expandOption,
  formatValueList, getDefaultValue, hasValueContent, isDependencyMet, isValidChoice, isValidScopeId, isValueOption, normalizeConfiguredOptions, optionExists,
  parseValueList, resolveScope, scopeSafeId, selectValues } from "./featureOptions.ts";
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptionFormatter } from "./featureOptions.ts";
import { describe, test } from "node:test";
import { FeatureOptions } from "./featureOptions.ts";
import assert from "node:assert/strict";
import { capturingLog } from "./testing/index.ts";
import { readFile } from "node:fs/promises";

// Reusable category / option fixtures. Organized for reuse across tests - most tests need the same "Motion / Audio / Network" shape and only vary configuredOptions.
const CATEGORIES: FeatureCategoryEntry[] = [

  { description: "Motion Options", name: "Motion" },
  { description: "Audio Options", name: "Audio" },
  { description: "Network Options", name: "Network" }
];

const OPTIONS: Record<string, FeatureOptionEntry[]> = {

  Audio: [

    { default: false, defaultValue: 50, description: "Audio volume level.", name: "Volume" },
    { default: true, description: "Mute parent toggle.", group: "", name: "Mute" }
  ],

  Motion: [

    { default: true, description: "Enable motion detection.", name: "Detect" },
    { default: false, description: "Motion sensitivity tuning.", group: "Detect", name: "Sensitivity" }
  ],

  Network: [

    { default: false, defaultValue: "1500", description: "Override MTU size.", name: "Mtu" },
    { default: false, defaultValue: 1000, description: "Bandwidth budget (kbps).", name: "Bandwidth" }
  ]
};

// Catalog fixture for the declared-scopes tests: one option per declaration shape plus an undeclared control, so each level's guard is exercised against an entry
// that is configured and an entry that is skipped. The DeviceOnly variants carry opposite defaults, which is what lets the default-fallback tests tell a
// correctly-resolved default apart from a disallowed entry leaking through: each fixture's default is the opposite of what its disallowed global entry encodes.
const SCOPED_CATEGORIES: FeatureCategoryEntry[] = [{ description: "Scoped Options", name: "Scoped" }];

const SCOPED_OPTIONS: Record<string, FeatureOptionEntry[]> = {

  Scoped: [

    { default: false, description: "Device-only option.", name: "DeviceOnly", scopes: ["device"] },
    { default: true, description: "Device-only option, default on.", name: "DeviceOnlyDefaultOn", scopes: ["device"] },
    { default: false, description: "Controller-only option.", name: "ControllerOnly", scopes: ["controller"] },
    { default: false, description: "Global-only option.", name: "GlobalOnly", scopes: ["global"] },
    { default: false, description: "Option declared at every level.", name: "Everywhere", scopes: [ "controller", "device", "global" ] },
    { default: false, description: "Option that declares nothing.", name: "Undeclared" },
    { default: false, defaultValue: 50, description: "Device-only value option.", name: "DeviceValue", scopes: ["device"] }
  ]
};

/* Compile-time shape exercises for the scopes declaration. These never run - the function is voided at module scope rather than called - so they add nothing to the
 * runtime totals; TypeScript still type-checks the body during `npm run typecheck`, so a shape regression fails the build here rather than silently at a consuming
 * plugin. The negative cases use `@ts-expect-error`, which fails the build if the error it expects ever stops occurring.
 */
const scopeDeclarationShapeExercises = (): void => {

  // A declaration names one level or several, in any combination.
  const deviceOnly: FeatureOptionEntry = { default: false, description: "Device-only.", name: "DeviceOnly", scopes: ["device"] };
  const controllerAndDevice: FeatureOptionEntry = { default: false, description: "Controller and device.", name: "Local", scopes: [ "controller", "device" ] };

  // An option declaring no level at all would render nowhere and resolve nowhere, so the non-empty tuple puts that state out of reach.
  // @ts-expect-error - an empty scopes declaration is rejected.
  const nowhere: FeatureOptionEntry = { default: false, description: "Nothing declared.", name: "Nowhere", scopes: [] };

  // "none" is what resolution reports when nothing matched, not a level an entry can be written at, so the declaration vocabulary excludes it.
  // @ts-expect-error - "none" is not a member of FeatureOptionScope.
  const resolutionOutcome: FeatureOptionEntry = { default: false, description: "Not a level.", name: "Outcome", scopes: ["none"] };

  void [ deviceOnly, controllerAndDevice, nowhere, resolutionOutcome ];
};

void scopeDeclarationShapeExercises;

describe("FeatureOptions - construction and defaults", () => {

  test("indexes defaults from the options catalog keyed on lowercased expanded names", () => {

    // defaultValue() should read "Motion.Detect" -> true and "Motion.Sensitivity" -> false regardless of input casing. The lookup key is the lowercased expanded form.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.defaultValue("Motion.Detect"), true);
    assert.equal(fo.defaultValue("motion.detect"), true);
    assert.equal(fo.defaultValue("MOTION.SENSITIVITY"), false);
  });

  test("returns defaultReturnValue for unknown options", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.defaultValue("Unknown.Option"), false);

    fo.defaultReturnValue = true;

    assert.equal(fo.defaultValue("Unknown.Option"), true);
  });

  test("populates the valueOptions index from options that declare defaultValue", () => {

    // Only options with `defaultValue` are value-centric. Volume (number) and Mtu (string) should both register; Detect (no defaultValue) must not.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.isValue("Audio.Volume"), true);
    assert.equal(fo.isValue("Network.Mtu"), true);
    assert.equal(fo.isValue("Motion.Detect"), false);
  });

  test("isValue returns false for empty or unknown options", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.isValue(""), false);
    assert.equal(fo.isValue("Does.Not.Exist"), false);
  });

  test("skips categories with no corresponding entry in the options map", () => {

    // The categories list is the driver of the generation loop; orphan categories (declared with no options) must be silently skipped without interfering with
    // other categories' defaults or value indices.
    const categories = [ ...CATEGORIES, { description: "Orphan", name: "Orphan" } ];
    const fo = new FeatureOptions(categories, OPTIONS);

    assert.equal(fo.defaultValue("Motion.Detect"), true);
    assert.equal(fo.defaultValue("Orphan.Anything"), false);
  });
});

describe("FeatureOptions - expandOption", () => {

  test("joins a category name and an option name with a dot", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.expandOption("Motion", "Detect"), "Motion.Detect");
  });

  test("accepts category and option entry objects as well as raw strings", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);
    const category = CATEGORIES[0];
    const option = OPTIONS["Motion"]?.[0];

    assert.ok(category, "test fixture must seed at least one category");
    assert.ok(option, "test fixture must seed at least one option under \"Motion\"");
    assert.equal(fo.expandOption(category, option), "Motion.Detect");
  });

  test("returns an empty string when the category name is empty", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.expandOption("", "Detect"), "");
  });

  test("returns the category alone when the option name is empty", () => {

    // Matches the semantic "category-level toggle" - a handful of UI paths surface a category-only entry that represents the whole category.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.expandOption("Motion", ""), "Motion");
  });
});

describe("FeatureOptions - scope hierarchy", () => {

  test("resolves to the default state when no option is configured at any scope", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.test("Motion.Detect"), true, "Motion.Detect defaults to true");
    assert.equal(fo.test("Motion.Sensitivity"), false, "Motion.Sensitivity defaults to false");
    assert.equal(fo.scope("Motion.Detect"), "none");
  });

  test("device scope wins over controller scope wins over global scope", () => {

    // Three layered overrides on the same option:
    //   global: Disable
    //   controller ctrl1: Enable
    //   device dev1: Disable
    // Device-level must win for device "dev1". Controller "ctrl1" in isolation must see enabled=true. Global-only must see enabled=false.
    const configured = [

      "Disable.Motion.Detect",
      "Enable.Motion.Detect.ctrl1",
      "Disable.Motion.Detect.dev1"
    ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.test("Motion.Detect", "dev1", "ctrl1"), false, "device scope wins");
    assert.equal(fo.scope("Motion.Detect", "dev1", "ctrl1"), "device");
    assert.equal(fo.test("Motion.Detect", undefined, "ctrl1"), true, "controller scope wins when no device override exists");
    assert.equal(fo.scope("Motion.Detect", undefined, "ctrl1"), "controller");
    assert.equal(fo.test("Motion.Detect"), false, "global scope applies when neither device nor controller is specified");
    assert.equal(fo.scope("Motion.Detect"), "global");
  });

  test("controller override does not spill to devices the controller does not own (no device id passed)", () => {

    // With only a controller override and no device id in the lookup, the controller scope is the answer. This is the canonical "disable at controller level" pattern
    // that propagates to all of its devices.
    const configured = ["Disable.Motion.Detect.ctrl1"];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.scope("Motion.Detect", undefined, "ctrl1"), "controller");
    assert.equal(fo.test("Motion.Detect", undefined, "ctrl1"), false);
  });

  test("device override on a device reverses a controller override at that device only", () => {

    // Canonical "disable at controller but re-enable at a specific device" pattern.
    const configured = [ "Disable.Motion.Detect.ctrl1", "Enable.Motion.Detect.devA" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.test("Motion.Detect", "devA", "ctrl1"), true, "device devA overrides to enabled");
    assert.equal(fo.test("Motion.Detect", "devB", "ctrl1"), false, "sibling device devB still sees controller-level disable");
  });

  test("lookups are case-insensitive across option names, device ids, and controller ids", () => {

    // Store with one casing, query with another. The lookup key normalization must collapse casing differences end-to-end.
    const configured = ["Enable.Motion.Detect.DevA"];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.test("motion.detect", "deva"), true);
    assert.equal(fo.test("MOTION.DETECT", "DEVA"), true);
  });

  test("first-write-wins for duplicate entries in configuredOptions", () => {

    // When the same option appears twice, the earliest entry is authoritative. This is the documented contract - callers may append without de-duping and the semantics
    // remain deterministic.
    const configured = [ "Enable.Motion.Detect", "Disable.Motion.Detect" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.test("Motion.Detect"), true, "first Enable entry must win over a subsequent Disable");
  });

  test("ignores configured entries that do not start with Enable or Disable", () => {

    // Garbage prefixes like "Toggle" must not introduce phantom lookup entries. Only Enable/Disable flow through.
    const configured = [ "Toggle.Motion.Detect", "Enable.Motion.Detect" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.exists("Motion.Detect"), true);
    assert.equal(fo.test("Motion.Detect"), true);
  });

  test("ignores configured entries with no dot separator", () => {

    // Entries like "EnableBroken" lack the `.` separator and must be silently dropped.
    const configured = [ "EnableMotionDetect", "Enable.Motion.Detect" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.test("Motion.Detect"), true);
    assert.equal(fo.exists("Motion.Detect"), true);
  });
});

describe("FeatureOptions - declared option scopes", () => {

  test("a device-declared option resolves its device entry and skips configured entries at every other level", () => {

    const catalog = buildCatalogIndex(SCOPED_CATEGORIES, SCOPED_OPTIONS);
    const configIndex = buildConfigIndex(catalog, [ "Enable.Scoped.DeviceOnly.dev1", "Enable.Scoped.DeviceOnly.ctrl1", "Enable.Scoped.DeviceOnly" ]);
    const atDevice = resolveScope({ catalog, configIndex, controller: "ctrl1", device: "dev1", option: "Scoped.DeviceOnly" });
    const atController = resolveScope({ catalog, configIndex, controller: "ctrl1", option: "Scoped.DeviceOnly" });

    assert.equal(atDevice.scope, "device");
    assert.equal(atDevice.enabled, true);
    assert.equal(atController.scope, "none", "the controller and global entries sit at levels the option does not declare");
    assert.equal(atController.enabled, false, "so the catalog default answers, not the enabled state those entries carry");
  });

  test("a controller-declared option resolves its controller entry and skips the device and global entries", () => {

    const catalog = buildCatalogIndex(SCOPED_CATEGORIES, SCOPED_OPTIONS);
    const configIndex = buildConfigIndex(catalog, [ "Enable.Scoped.ControllerOnly.dev1", "Enable.Scoped.ControllerOnly.ctrl1", "Enable.Scoped.ControllerOnly" ]);
    const atDevice = resolveScope({ catalog, configIndex, controller: "ctrl1", device: "dev1", option: "Scoped.ControllerOnly" });
    const global = resolveScope({ catalog, configIndex, option: "Scoped.ControllerOnly" });

    assert.equal(atDevice.scope, "controller", "the device entry is skipped and the walk continues to the level the option declares");
    assert.equal(atDevice.enabled, true);
    assert.equal(global.scope, "none", "with no controller in view the global entry is still undeclared, so the default answers");
    assert.equal(global.enabled, false);
  });

  test("a global-declared option resolves its global entry and skips the device and controller entries", () => {

    const catalog = buildCatalogIndex(SCOPED_CATEGORIES, SCOPED_OPTIONS);
    const configIndex = buildConfigIndex(catalog, [ "Enable.Scoped.GlobalOnly.dev1", "Enable.Scoped.GlobalOnly.ctrl1", "Enable.Scoped.GlobalOnly" ]);
    const resolved = resolveScope({ catalog, configIndex, controller: "ctrl1", device: "dev1", option: "Scoped.GlobalOnly" });

    assert.equal(resolved.scope, "global");
    assert.equal(resolved.enabled, true);
  });

  test("an option declaring every level walks the full device -> controller -> global precedence", () => {

    const catalog = buildCatalogIndex(SCOPED_CATEGORIES, SCOPED_OPTIONS);
    const configIndex = buildConfigIndex(catalog, [ "Enable.Scoped.Everywhere.dev1", "Enable.Scoped.Everywhere.ctrl1", "Enable.Scoped.Everywhere" ]);

    assert.equal(resolveScope({ catalog, configIndex, controller: "ctrl1", device: "dev1", option: "Scoped.Everywhere" }).scope, "device");
    assert.equal(resolveScope({ catalog, configIndex, controller: "ctrl1", option: "Scoped.Everywhere" }).scope, "controller");
    assert.equal(resolveScope({ catalog, configIndex, option: "Scoped.Everywhere" }).scope, "global");
  });

  test("an option that declares no scopes resolves at every level, as the shared fixtures throughout this suite do", () => {

    // The compatibility contract, asserted against the same catalog the rest of the suite resolves through: nothing in it declares scopes, so the walk is the full
    // device -> controller -> global -> default precedence.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const configIndex = buildConfigIndex(catalog, [ "Enable.Motion.Detect.dev1", "Disable.Motion.Detect.ctrl1", "Disable.Motion.Detect" ]);

    assert.deepEqual(catalog.scopes, {}, "no entry in the shared fixture declares a scope");
    assert.equal(resolveScope({ catalog, configIndex, controller: "ctrl1", device: "dev1", option: "Motion.Detect" }).scope, "device");
    assert.equal(resolveScope({ catalog, configIndex, controller: "ctrl1", option: "Motion.Detect" }).scope, "controller");
    assert.equal(resolveScope({ catalog, configIndex, option: "Motion.Detect" }).scope, "global");
    assert.equal(resolveScope({ catalog, configIndex, option: "Motion.Sensitivity" }).scope, "none", "an option with no entry anywhere still falls to the default");
  });

  test("the catalog default resolves even when every configured entry sits at an undeclared level, in both directions", () => {

    // A default belongs to the option rather than to a level, so the fallback is never gated. Both fixtures pin a default whose enabled state DIFFERS from the
    // disallowed global entry's, so an implementation that leaked that entry through would fail here rather than agreeing with the default by coincidence.
    const catalog = buildCatalogIndex(SCOPED_CATEGORIES, SCOPED_OPTIONS);
    const enabledGlobal = buildConfigIndex(catalog, ["Enable.Scoped.DeviceOnly"]);
    const disabledGlobal = buildConfigIndex(catalog, ["Disable.Scoped.DeviceOnlyDefaultOn"]);
    const defaultOff = resolveScope({ catalog, configIndex: enabledGlobal, device: "dev1", option: "Scoped.DeviceOnly" });
    const defaultOn = resolveScope({ catalog, configIndex: disabledGlobal, device: "dev1", option: "Scoped.DeviceOnlyDefaultOn" });

    assert.equal(defaultOff.scope, "none");
    assert.equal(defaultOff.enabled, false, "a default-off option stays off despite a disallowed global Enable");
    assert.equal(defaultOn.scope, "none");
    assert.equal(defaultOn.enabled, true, "a default-on option stays on despite a disallowed global Disable");
  });

  test("test() and value() enforce the declaration; exists() answers what is configured", () => {

    const fo = new FeatureOptions(SCOPED_CATEGORIES, SCOPED_OPTIONS, [ "Enable.Scoped.DeviceOnly", "Enable.Scoped.DeviceValue=75" ]);

    assert.equal(fo.test("Scoped.DeviceOnly"), false, "the global entry is at an undeclared level, so the default answers");
    assert.equal(fo.test("Scoped.DeviceOnly", "dev1"), false, "and a device view finds no device entry to apply");
    assert.equal(fo.value("Scoped.DeviceValue", "dev1"), null, "an undeclared level carries no value either - the option resolves to its default-off state");
    assert.equal(fo.exists("Scoped.DeviceOnly"), true, "the entry is configured, whatever resolution makes of it");
    assert.equal(fo.exists("Scoped.DeviceValue"), true);
  });

  test("a value declared at the level the option admits resolves normally", () => {

    // The other side of the enforcement above: the declaration narrows where a value is read from, it does not make a declared level unreadable.
    const fo = new FeatureOptions(SCOPED_CATEGORIES, SCOPED_OPTIONS, ["Enable.Scoped.DeviceValue.dev1=75"]);

    assert.equal(fo.value("Scoped.DeviceValue", "dev1"), "75");
    assert.equal(fo.test("Scoped.DeviceValue", "dev1"), true);
  });

  test("buildCatalogIndex registers a scopes entry only for options that declare one", () => {

    const catalog = buildCatalogIndex(SCOPED_CATEGORIES, SCOPED_OPTIONS);

    assert.deepEqual(catalog.scopes["scoped.deviceonly"], ["device"], "keyed on the lowercased expanded name, like every other registry");
    assert.deepEqual(catalog.scopes["scoped.everywhere"], [ "controller", "device", "global" ]);
    assert.equal(catalog.scopes["scoped.undeclared"], undefined, "an option that declares nothing gets no key");
  });
});

describe("FeatureOptions - logFeature (deviation logging)", () => {

  test("stays silent when a default-on feature is left enabled", () => {

    // Motion.Detect defaults to true. With no configured options the effective state matches the default - the convention says emit nothing.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);
    const log = capturingLog();

    fo.logFeature("Motion.Detect", "Motion sensor", log);

    assert.deepEqual(log.entries, []);
  });

  test("emits a disabled line when a default-on feature is turned off", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Disable.Motion.Detect"]);
    const log = capturingLog();

    fo.logFeature("Motion.Detect", "Motion sensor", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s disabled.", params: ["Motion sensor"] }]);
  });

  test("stays silent when a default-off feature is left disabled", () => {

    // Motion.Sensitivity defaults to false. Unconfigured effective state matches the default - no log.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);
    const log = capturingLog();

    fo.logFeature("Motion.Sensitivity", "Motion sensitivity", log);

    assert.deepEqual(log.entries, []);
  });

  test("emits an enabled line when a default-off feature is turned on", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Motion.Sensitivity"]);
    const log = capturingLog();

    fo.logFeature("Motion.Sensitivity", "Motion sensitivity", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled.", params: ["Motion sensitivity"] }]);
  });

  test("respects the device scope when reporting a deviation", () => {

    // Device-scoped Disable overrides the default-on state for that device only. Sibling devices stay silent.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Disable.Motion.Detect.devA"]);
    const logDevA = capturingLog();
    const logDevB = capturingLog();

    fo.logFeature("Motion.Detect", "Motion sensor", logDevA, "devA");
    fo.logFeature("Motion.Detect", "Motion sensor", logDevB, "devB");

    assert.deepEqual(logDevA.entries, [{ level: "info", message: "%s disabled.", params: ["Motion sensor"] }]);
    assert.deepEqual(logDevB.entries, [], "device devB sees the default and stays silent");
  });

  test("respects the controller scope when reporting a deviation", () => {

    // Controller-scoped Enable on a default-off option emits at the controller vantage point. Without the controller id the option resolves to its default and stays
    // silent, confirming the scope precedence threads through end to end.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Motion.Sensitivity.ctrl1"]);
    const logCtrl = capturingLog();
    const logBare = capturingLog();

    fo.logFeature("Motion.Sensitivity", "Motion sensitivity", logCtrl, undefined, "ctrl1");
    fo.logFeature("Motion.Sensitivity", "Motion sensitivity", logBare);

    assert.deepEqual(logCtrl.entries, [{ level: "info", message: "%s enabled.", params: ["Motion sensitivity"] }]);
    assert.deepEqual(logBare.entries, [], "no controller context resolves to the default and stays silent");
  });

  test("treats unknown options through defaultReturnValue and only logs when the effective state diverges from it", () => {

    // Unknown options fall through to defaultReturnValue. With the default false-state and no configured entry the effective is also false - silent. An explicit
    // Enable on the unknown key flips the effective state away from defaultReturnValue and earns an enabled line.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);
    const logSilent = capturingLog();

    fo.logFeature("Unknown.Option", "Mystery feature", logSilent);

    assert.deepEqual(logSilent.entries, [], "effective false against defaultReturnValue false is silent");

    const foEnabled = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Unknown.Option"]);
    const logEnabled = capturingLog();

    foEnabled.logFeature("Unknown.Option", "Mystery feature", logEnabled);

    assert.deepEqual(logEnabled.entries, [{ level: "info", message: "%s enabled.", params: ["Mystery feature"] }]);
  });

  test("normalizes option key casing the same way test and defaultValue do", () => {

    // logFeature must compose correctly with the case-insensitive lookups underneath. Mixed-case option keys and device ids must resolve identically.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Disable.Motion.Detect.DevA"]);
    const log = capturingLog();

    fo.logFeature("MOTION.DETECT", "Motion sensor", log, "deva");

    assert.deepEqual(log.entries, [{ level: "info", message: "%s disabled.", params: ["Motion sensor"] }]);
  });

  test("emits an enabled-at line for a default-off value-centric option turned on without an explicit value", () => {

    // Audio.Volume defaults to disabled with a registered defaultValue of 50. A bare Enable means the user accepted the registered default by enabling, so the message
    // includes that default value to communicate the effective configuration rather than "Volume enabled." which would hide the value the system actually uses.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume"]);
    const log = capturingLog();

    fo.logFeature("Audio.Volume", "Volume", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled at %s.", params: [ "Volume", "50" ] }]);
  });

  test("emits an enabled-at line for a default-off value-centric option turned on with a custom value", () => {

    // Both axes deviate: the user enabled an off-by-default option (boolean axis) and supplied a non-default value (value axis). One line communicates the full
    // effective configuration; we do not emit two lines for the two axes.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.75"]);
    const log = capturingLog();

    fo.logFeature("Audio.Volume", "Volume", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled at %s.", params: [ "Volume", "75" ] }]);
  });

  test("emits a disabled line for a default-on value-centric option turned off, ignoring the value", () => {

    // Construct a default-on value-centric option for this test - the shared OPTIONS fixture has only default-off value-centric entries. When disabled, the value is
    // irrelevant; the message collapses to the same shape as the boolean disabled path.
    const categories: FeatureCategoryEntry[] = [{ description: "Network Options", name: "Network" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Network: [{ default: true, defaultValue: "9000", description: "Jumbo MTU.", name: "Mtu" }]
    };
    const fo = new FeatureOptions(categories, options, ["Disable.Network.Mtu"]);
    const log = capturingLog();

    fo.logFeature("Network.Mtu", "MTU", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s disabled.", params: ["MTU"] }]);
  });

  test("stays silent when a default-on value-centric option remains at its registered default value", () => {

    // Both axes match the catalog: option is enabled per default and value is unspecified so the system uses the registered default. The convention says emit nothing.
    const categories: FeatureCategoryEntry[] = [{ description: "Network Options", name: "Network" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Network: [{ default: true, defaultValue: "9000", description: "Jumbo MTU.", name: "Mtu" }]
    };
    const fo = new FeatureOptions(categories, options);
    const log = capturingLog();

    fo.logFeature("Network.Mtu", "MTU", log);

    assert.deepEqual(log.entries, []);
  });

  test("emits a set-to line when only the value axis of a default-on value-centric option deviates", () => {

    // Boolean axis matches default (enabled), value axis deviates. The message uses "set to" rather than "enabled at" to communicate that the enable/disable state was
    // not the customization point - the value was. Operators can distinguish "user turned this feature on at X" from "feature was already on, user just changed X."
    const categories: FeatureCategoryEntry[] = [{ description: "Network Options", name: "Network" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Network: [{ default: true, defaultValue: "9000", description: "Jumbo MTU.", name: "Mtu" }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Network.Mtu.1500"]);
    const log = capturingLog();

    fo.logFeature("Network.Mtu", "MTU", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s set to %s.", params: [ "MTU", "1500" ] }]);
  });

  test("renders the value through the catalog-declared render function when one is present", () => {

    // The render function is the catalog's hook for "this option's value displays as <format>." A bandwidth option configured in raw kbps wants to read as "5.0 Mbps"
    // in the log, and the renderer lives with the declaration so every consumer (logFeature today, future surfaces tomorrow) renders identically.
    const categories: FeatureCategoryEntry[] = [{ description: "Stream Options", name: "Stream" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Stream: [{ default: false, defaultValue: 1000, description: "Bandwidth budget (kbps).", name: "Bandwidth",
        render: (value: string): string => (Number.parseInt(value, 10) / 1000).toFixed(1) + " Mbps" }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Stream.Bandwidth.5000"]);
    const log = capturingLog();

    fo.logFeature("Stream.Bandwidth", "Bandwidth", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled at %s.", params: [ "Bandwidth", "5.0 Mbps" ] }]);
  });

  test("falls back to the raw value when no render function is declared", () => {

    // The absence of `render` is the canonical path used by simple value-centric options. We assert the raw stored string is what reaches the log line so a missing
    // renderer does not silently corrupt output - it just shows the raw value.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.75"]);
    const log = capturingLog();

    fo.logFeature("Audio.Volume", "Volume", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled at %s.", params: [ "Volume", "75" ] }],
      "raw value must appear verbatim when no render function is declared on the catalog entry");
  });

  test("collapses to the boolean-axis message when a value-centric option has no concrete value to render", () => {

    // Degenerate catalog: a value-centric option declared with `defaultValue: undefined` and enabled at a scope that carries no explicit value. The option is enabled
    // per the user's choice but there is no value the system can display, so logFeature falls back to "<label> enabled." rather than emit "<label> enabled at ." which
    // would mislead an operator. This is defensive plumbing; well-formed catalogs never reach this branch.
    const categories: FeatureCategoryEntry[] = [{ description: "Audio Options", name: "Audio" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Audio: [{ default: false, defaultValue: undefined, description: "Free-form profile.", name: "Profile" }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Audio.Profile.devA"]);
    const log = capturingLog();

    fo.logFeature("Audio.Profile", "Profile", log, "devA");

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled.", params: ["Profile"] }]);
  });

  test("resolves every named built-in formatter from the registry and applies it to the rendered value", () => {

    // The named-formatter registry is the SSOT for shared display formats across plugins. Each row of the table exercises one formatter end to end: catalog declares
    // `render: <name>`, configured value reaches logFeature, the registry-resolved formatter produces the expected human-readable string. The wiring is uniform
    // across formatters (same lookup, same call), so one parameterized test proves the registry hookup for the entire set - per-formatter format correctness is
    // covered separately by the unit tests in util.test.ts.
    const cases: readonly { formatter: FeatureOptionFormatter; storedValue: string; expectedRender: string }[] = [

      { expectedRender: "5.5 Mbps", formatter: "bps", storedValue: "5500000" },
      { expectedRender: "2 KB", formatter: "bytes", storedValue: "2048" },
      { expectedRender: "1.5 Mbps", formatter: "kbps", storedValue: "1500" },
      { expectedRender: "1.5 s", formatter: "ms", storedValue: "1500" },
      { expectedRender: "75%", formatter: "percent", storedValue: "75" },
      { expectedRender: "2 min", formatter: "seconds", storedValue: "120" }
    ];

    for(const { formatter, storedValue, expectedRender } of cases) {

      const categories: FeatureCategoryEntry[] = [{ description: "Test Options", name: "Test" }];
      const options: Record<string, FeatureOptionEntry[]> = {

        Test: [{ default: false, defaultValue: 0, description: "Test option.", name: "Knob", render: formatter }]
      };
      const fo = new FeatureOptions(categories, options, ["Enable.Test.Knob." + storedValue]);
      const log = capturingLog();

      fo.logFeature("Test.Knob", "Knob", log);

      assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled at %s.", params: [ "Knob", expectedRender ] }],
        "formatter \"" + formatter + "\" must resolve from the registry and produce \"" + expectedRender + "\"");
    }
  });

  test("throws at construction time when a catalog entry names an unknown built-in formatter", () => {

    // Misconfiguration is loud at the boundary rather than silent at log time. A plugin that ships with `render: "unknown-format"` fails to construct its FeatureOptions
    // instance, which means the operator sees the misconfiguration in the plugin's startup error chain - not as quietly-degraded log output during normal operation.
    // This is the fail-fast pattern applied to catalog declarations.
    const categories: FeatureCategoryEntry[] = [{ description: "Stream Options", name: "Stream" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      // Cast intentionally widens the type so we can exercise the runtime guard from a JS caller's vantage point.
      Stream: [{ default: false, defaultValue: 0, description: "Bandwidth budget.", name: "Bandwidth", render: "nonexistent-format" as FeatureOptionFormatter }]
    };

    assert.throws(() => new FeatureOptions(categories, options),
      /unknown built-in formatter "nonexistent-format" declared on option "Stream\.Bandwidth"/);
  });

  test("does not invoke the render function on the disabled path", () => {

    // A value-centric option declared with `render` and turned off must collapse to the "<label> disabled." message shape. The render function is never invoked in
    // this path - asserted by giving the renderer a side effect (counter increment) and verifying it stays at zero after the disabled log line is emitted.
    let renderCalls = 0;
    const categories: FeatureCategoryEntry[] = [{ description: "Network Options", name: "Network" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Network: [{ default: true, defaultValue: "9000", description: "Jumbo MTU.", name: "Mtu", render: (value: string): string => {

        renderCalls++;

        return value + " bytes";
      } }]
    };
    const fo = new FeatureOptions(categories, options, ["Disable.Network.Mtu"]);
    const log = capturingLog();

    fo.logFeature("Network.Mtu", "MTU", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s disabled.", params: ["MTU"] }]);
    assert.equal(renderCalls, 0, "render function must not be invoked when the option is disabled - the value is irrelevant");
  });

  test("applies the render function to the registered default value when the user enables without specifying a value", () => {

    // Default-off option enabled with no explicit value -> the system uses the registered default, and the renderer must transform it just like an explicit value.
    // This closes the gap where the explicit-value path was covered but the registered-default fall-through path was not - both flow through the same renderer hookup
    // so a regression in either would surface here.
    const categories: FeatureCategoryEntry[] = [{ description: "Stream Options", name: "Stream" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Stream: [{ default: false, defaultValue: 1500000, description: "Bandwidth budget (bps).", name: "Bandwidth", render: "bps" }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Stream.Bandwidth"]);
    const log = capturingLog();

    fo.logFeature("Stream.Bandwidth", "Bandwidth", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled at %s.", params: [ "Bandwidth", "1.5 Mbps" ] }]);
  });

  test("respects the device scope for value-centric options with both axes deviating at the device", () => {

    // Value-centric scope interaction: a default-off option enabled at a specific device with an explicit value emits the enabled-at message for that device only;
    // a sibling device with no configuration resolves to the global default (disabled) and stays silent. This composes the scope-precedence logic in test()/value()
    // with the message-shape branching - both surfaces are individually tested elsewhere, this covers the interaction.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.devA.75"]);
    const logDevA = capturingLog();
    const logDevB = capturingLog();

    fo.logFeature("Audio.Volume", "Volume", logDevA, "devA");
    fo.logFeature("Audio.Volume", "Volume", logDevB, "devB");

    assert.deepEqual(logDevA.entries, [{ level: "info", message: "%s enabled at %s.", params: [ "Volume", "75" ] }]);
    assert.deepEqual(logDevB.entries, [], "sibling device sees the global default (disabled) and stays silent");
  });

  test("respects the controller scope for value-centric options when only the value axis deviates", () => {

    // Default-on value-centric option with a controller-scoped value override. Boolean axis matches default (enabled); value axis deviates from the registered
    // default. The message must be "<label> set to <value>." when looked up with the controller id, and silent when looked up without it (where the controller
    // override does not apply and the global default value remains in effect).
    const categories: FeatureCategoryEntry[] = [{ description: "Network Options", name: "Network" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Network: [{ default: true, defaultValue: "9000", description: "Jumbo MTU.", name: "Mtu" }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Network.Mtu.ctrl1.1500"]);
    const logCtrl = capturingLog();
    const logBare = capturingLog();

    fo.logFeature("Network.Mtu", "MTU", logCtrl, undefined, "ctrl1");
    fo.logFeature("Network.Mtu", "MTU", logBare);

    assert.deepEqual(logCtrl.entries, [{ level: "info", message: "%s set to %s.", params: [ "MTU", "1500" ] }]);
    assert.deepEqual(logBare.entries, [], "without the controller id the option resolves to the global default value and stays silent");
  });

  test("states an emptied list in words on the boolean-axis line rather than rendering nothing after \"at\"", () => {

    // A default-off list the user turned on and emptied deviates on both axes, so the line takes the "enabled" shape - and the shape has to say what the empty
    // selection is, since interpolating the value would emit "Smart detections enabled at ." instead.
    const categories: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ default: false, defaultValue: "face,person", description: "Smart detection types.", multiple: true, name: "SmartDetect" }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Motion.SmartDetect="]);
    const log = capturingLog();

    fo.logFeature("Motion.SmartDetect", "Smart detections", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s enabled with an empty selection.", params: ["Smart detections"] }]);
  });

  test("states an emptied list in words on the value-axis line, without consulting the catalog renderer", () => {

    // The other message shape: a default-on list left on, with only the selection moved away from the declared default. The renderer is declared for the values
    // the option offers rather than for their absence, so the empty selection resolves ahead of it - asserted through the same counter idiom the disabled path
    // uses.
    let renderCalls = 0;
    const categories: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ default: true, defaultValue: "face,person", description: "Smart detection types.", multiple: true, name: "SmartDetect",
        render: (value: string): string => {

          renderCalls++;

          return value + " detected";
        } }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Motion.SmartDetect="]);
    const log = capturingLog();

    fo.logFeature("Motion.SmartDetect", "Smart detections", log);

    assert.deepEqual(log.entries, [{ level: "info", message: "%s set to an empty selection.", params: ["Smart detections"] }]);
    assert.equal(renderCalls, 0, "a plugin's renderer is never handed the empty string");
  });
});

describe("FeatureOptions - exists / isScopeGlobal / isScopeDevice", () => {

  test("exists returns true only when the option has an explicit configuration entry", () => {

    const configured = ["Enable.Motion.Detect"];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.exists("Motion.Detect"), true);
    assert.equal(fo.exists("Motion.Sensitivity"), false, "an option with a default but no explicit entry must not exist");
  });

  test("exists respects the scope id", () => {

    // Global entry and device-scoped entry are separate keys.
    const configured = [ "Enable.Motion.Detect", "Disable.Motion.Detect.devA" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.exists("Motion.Detect"), true, "global entry exists");
    assert.equal(fo.exists("Motion.Detect", "devA"), true, "device entry exists");
    assert.equal(fo.exists("Motion.Detect", "devB"), false, "sibling device has no entry");
  });

  test("isScopeGlobal and isScopeDevice mirror exists at their respective scopes", () => {

    const configured = [ "Enable.Motion.Detect", "Disable.Motion.Detect.devA" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.isScopeGlobal("Motion.Detect"), true);
    assert.equal(fo.isScopeDevice("Motion.Detect", "devA"), true);
    assert.equal(fo.isScopeDevice("Motion.Detect", "devB"), false);
  });
});

describe("FeatureOptions - value resolution", () => {

  test("returns the registered default value when the option is unset but enabled by default", () => {

    // Mtu has defaultValue "1500" but default=false. With nothing configured, value() sees "not configured" and the option disabled by default, so it returns null.
    // Bandwidth has default=false too, so same result. To exercise the default-fallback path we need an option with default=true - construct a fixture for that.
    const options: Record<string, FeatureOptionEntry[]> = {

      Network: [{ default: true, defaultValue: "9000", description: "Jumbo MTU.", name: "Mtu" }]
    };
    const categories: FeatureCategoryEntry[] = [{ description: "Network", name: "Network" }];
    const fo = new FeatureOptions(categories, options);

    assert.equal(fo.value("Network.Mtu"), "9000", "default-on value-centric option must return its registered default");
  });

  test("returns null when the option is not value-centric", () => {

    // `Motion.Detect` has no defaultValue and therefore is not value-centric. value() must return null regardless of its enabled state.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.value("Motion.Detect"), null);
  });

  test("returns null when the option is explicitly disabled at any scope", () => {

    const configured = ["Disable.Network.Mtu"];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.value("Network.Mtu"), null);
  });

  test("returns the configured value at global scope when the option is enabled with a value", () => {

    // "Enable.Network.Mtu.1500" - single trailing segment at global scope is the value.
    const configured = ["Enable.Network.Mtu.1500"];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.value("Network.Mtu"), "1500");
  });

  test("returns the configured value at device scope when the option is enabled with a value", () => {

    // "Enable.Network.Mtu.devA.9000" - two trailing segments: scope id then value.
    const configured = ["Enable.Network.Mtu.devA.9000"];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, configured);

    assert.equal(fo.value("Network.Mtu", "devA"), "9000");
    assert.equal(fo.value("Network.Mtu"), null, "device-only configured value must not leak up to the global lookup");
  });

  test("returns undefined when the option is enabled at the device scope with no trailing value", () => {

    // "Enable.Network.Mtu.devA" is double-registered by the config-index builder: as a device-scope entry (`network.mtu.deva` -> enabled with no value) **and** as a
    // global value (`network.mtu` -> enabled with value "devA", because a single trailing segment at global scope IS the value). Looking up the option with the
    // matching device id resolves to the device entry, which is enabled but carries no value - the "enabled, no value" branch in value() returns undefined.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Network.Mtu.devA"]);

    assert.equal(fo.value("Network.Mtu", "devA"), undefined);
  });

  test("greedy longest-prefix match handles overlapping option names correctly", () => {

    // Construct a fixture where two value-centric options overlap - one name is a prefix of another. The index must prefer the longer name when both could match.
    const options: Record<string, FeatureOptionEntry[]> = {

      Audio: [

        { default: false, defaultValue: 50, description: "Master audio volume.", name: "Volume" },
        { default: false, defaultValue: 100, description: "Volume peak cutoff.", name: "Volume.Peak" }
      ]
    };
    const categories: FeatureCategoryEntry[] = [{ description: "Audio", name: "Audio" }];

    // "Enable.Audio.Volume.Peak.77" must bind to the longer option name "audio.volume.peak" with value "77", not to "audio.volume" with a nonsense trailing value.
    const fo = new FeatureOptions(categories, options, ["Enable.Audio.Volume.Peak.77"]);

    assert.equal(fo.value("Audio.Volume.Peak"), "77");

    // And the shorter option must *not* be registered by the longer's entry - that would be a false positive from non-greedy matching.
    assert.equal(fo.value("Audio.Volume"), null, "the shorter overlapping option must not inherit the longer option's value");
  });

  test("preserves original casing of the stored value", () => {

    // Keys are lowercased for lookup, but the value portion is stored with its original casing - users set human-readable values and expect them back verbatim.
    const options: Record<string, FeatureOptionEntry[]> = {

      Audio: [{ default: false, defaultValue: "Default", description: "Labelled audio profile.", name: "Profile" }]
    };
    const categories: FeatureCategoryEntry[] = [{ description: "Audio", name: "Audio" }];
    const fo = new FeatureOptions(categories, options, ["Enable.Audio.Profile.CinemaSurround"]);

    assert.equal(fo.value("Audio.Profile"), "CinemaSurround");
  });

  test("returns a list's stored empty selection verbatim, where an option storing a single value reads the same payload as unspecified", () => {

    // One stored shape, two readings. A list resolving to an empty payload was emptied on purpose, so the read answers it; on an option storing a single value
    // the same payload means nothing was given, and resolution carries on exactly as it always has.
    const categories: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ default: true, defaultValue: "face,person", description: "Smart detection types.", multiple: true, name: "SmartDetect" }]
    };
    const list = new FeatureOptions(categories, options, [ "Enable.Motion.SmartDetect=", "Enable.Motion.SmartDetect.devA=" ]);

    assert.equal(list.value("Motion.SmartDetect"), "", "the global empty selection reads back as itself");
    assert.equal(list.value("Motion.SmartDetect", "devA"), "", "and so does the scoped one");
    assert.deepEqual(list.valueList({ device: "devA", option: "Motion.SmartDetect" }), [], "an empty selection names no members");

    const single = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume="]);

    assert.equal(single.value("Audio.Volume"), undefined, "an empty payload on a single-valued option is still enabled with no value to report");
  });
});

/* The accessor reports a declaration rather than resolving one, which is the whole distinction from `value()` beside it. The rows walk what that means where a
 * caller might expect the resolving to have already happened - the wildcard and the declared-empty default - and where the honest answer is an absence.
 */
describe("FeatureOptions - valueDefault", () => {

  const PICKER_CATEGORIES: FeatureCategoryEntry[] = [{ description: "Picker Options", name: "Pick" }];

  const PICKER_OPTIONS: Record<string, FeatureOptionEntry[]> = {

    Pick: [

      { choices: [ { label: "A", value: "a" }, { label: "B", value: "b" } ], default: true, defaultValue: ALL_CHOICES, description: "Everything by default.",
        multiple: true, name: "Everything" },
      { choices: "sourced", default: true, defaultValue: "", description: "Nothing by default.", multiple: true, name: "Nothing" }
    ]
  };

  test("answers the registered default, with a numeric declaration in its string form and the lookup folding case", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.valueDefault("Network.Mtu"), "1500", "a string declaration answers itself");
    assert.equal(fo.valueDefault("Audio.Volume"), "50", "a numeric declaration answers the string form the value axis works in");
    assert.equal(fo.valueDefault("nEtWoRk.mTu"), "1500", "the lookup folds case exactly as every other option lookup does");
  });

  test("reports the wildcard and the declared-empty default verbatim rather than resolving either", () => {

    const fo = new FeatureOptions(PICKER_CATEGORIES, PICKER_OPTIONS);

    assert.equal(fo.valueDefault("Pick.Everything"), ALL_CHOICES, "the wildcard comes back as declared, since expanding it against a domain is valueList's job");
    assert.equal(fo.valueDefault("Pick.Nothing"), "", "a declared-empty default is the declaration as written, and not the absence of one");
  });

  test("answers undefined for an option that is not value-centric and for one the catalog does not carry", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.valueDefault("Motion.Detect"), undefined, "a boolean option registers no value-centric default");
    assert.equal(fo.valueDefault("Motion.Nonexistent"), undefined, "an option name the catalog does not carry");
  });
});

describe("FeatureOptions - getInteger and getFloat", () => {

  test("getInteger parses integer values and returns the number", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Network.Mtu.9000"]);

    assert.equal(fo.getInteger("Network.Mtu"), 9000);
  });

  test("getFloat parses the registered default value when unconfigured and default-enabled", () => {

    // Decimal values are not round-trippable through configuredOptions - the dot separator is also the scope / value delimiter - so we exercise getFloat via the
    // default-fallback path instead. A default-enabled value-centric option whose defaultValue is a decimal string surfaces that value through value() unchanged, and
    // getFloat parses it via parseFloat.
    const options: Record<string, FeatureOptionEntry[]> = {

      Audio: [{ default: true, defaultValue: "1.5", description: "Gain multiplier.", name: "Gain" }]
    };
    const categories: FeatureCategoryEntry[] = [{ description: "Audio", name: "Audio" }];
    const fo = new FeatureOptions(categories, options);

    assert.equal(fo.getFloat("Audio.Gain"), 1.5);
  });

  test("returns null when disabled", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Disable.Network.Mtu"]);

    assert.equal(fo.getInteger("Network.Mtu"), null);
  });

  test("returns undefined when not configured and default is disabled", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    // Mtu default is false, so value() returns null and the numeric parser converts a null input to null. The integer contract says null for disabled.
    assert.equal(fo.getInteger("Network.Mtu"), null);
  });

  test("returns undefined when the stored value is non-numeric", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Network.Mtu.not-a-number"]);

    assert.equal(fo.getInteger("Network.Mtu"), undefined);
  });
});

describe("FeatureOptions - groups", () => {

  test("builds a forward index from group to children", () => {

    // In the fixture, Motion.Sensitivity declares `group: "Detect"`. The expanded group name is "Motion.Detect" (category + group).
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.deepEqual(fo.groups["Motion.Detect"], ["Motion.Sensitivity"]);
  });

  test("empty-string group lifts the child to the category level", () => {

    // `group: ""` is the "no sub-group, just the category" convention. The expanded group becomes just the category name.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.deepEqual(fo.groups["Audio"], ["Audio.Mute"]);
  });

  test("builds a reverse index from child to parent group (O(1) lookup)", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.groupParents["Motion.Sensitivity"], "Motion.Detect");
    assert.equal(fo.groupParents["Audio.Mute"], "Audio");
    assert.equal(fo.groupParents["Motion.Detect"], undefined, "an option without a group declaration must not appear in the reverse index");
  });
});

describe("FeatureOptions.isDependencyMet (SSOT predicate for dependency-hidden state)", () => {

  // Single source of truth for "is this grouped option's parent enabled at the current scope?" Replaces ad hoc parent-path reconstruction at every call site that
  // needs to know whether a grouped option's row is currently usable. The model owns the reverse index it builds at catalog rebuild and is the only place that
  // should derive a child option's parent.

  test("returns true for options that have no `group` declaration (no dependency to fail)", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.isDependencyMet("Motion.Detect"), true, "ungrouped option has no parent - the dependency rule trivially holds");
    assert.equal(fo.isDependencyMet("Network.Mtu"), true, "another ungrouped option - same trivial-true outcome");
  });

  test("returns true for a grouped option whose parent is enabled at the queried scope", () => {

    // Motion.Detect is on by default; Motion.Sensitivity's group is "Detect" so its parent is "Motion.Detect". With the parent enabled, the dependency holds.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.isDependencyMet("Motion.Sensitivity"), true, "parent Motion.Detect is enabled by default - the child's dependency is met");
  });

  test("returns false for a grouped option whose parent is explicitly disabled at global scope", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Disable.Motion.Detect"]);

    assert.equal(fo.isDependencyMet("Motion.Sensitivity"), false, "parent Motion.Detect explicitly disabled - the child's dependency fails");
  });

  test("threads device + controller through `test()` for scope-aware dependency resolution", () => {

    // Parent disabled at the device scope only. From the global view the dependency is met (parent still enabled at global); from the device view it is not.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Disable.Motion.Detect.devA"]);

    assert.equal(fo.isDependencyMet("Motion.Sensitivity"), true,
      "from the global view, the parent's device-scope disable doesn't apply - dependency is met");
    assert.equal(fo.isDependencyMet("Motion.Sensitivity", "devA"), false,
      "from the device view, the parent's device-scope disable applies - dependency fails");
  });

  test("returns true for an option string that is not in the catalog at all (treated as having no dependency)", () => {

    // The predicate must not throw on stray strings (an exact-match miss on the reverse index returns undefined, which falls through to the "no parent" branch).
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.isDependencyMet("Unknown.Option"), true, "an unrecognized option has no parent in the reverse index - dependency trivially holds");
  });
});

describe("FeatureOptions - setters regenerate derived state", () => {

  test("assigning new configuredOptions rebuilds the lookup index", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    assert.equal(fo.test("Motion.Detect"), true, "default is enabled with no configured options");

    fo.configuredOptions = ["Disable.Motion.Detect"];

    assert.equal(fo.test("Motion.Detect"), false, "the new configuredOptions array must drive the lookup index");
    assert.equal(fo.exists("Motion.Detect"), true);
  });

  test("assigning a nullish configuredOptions falls back to an empty array", () => {

    // The setter tolerates a nullish input and normalizes to []. Exercises the `options ?? []` coalesce.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Disable.Motion.Detect"]);

    assert.equal(fo.test("Motion.Detect"), false);

    fo.configuredOptions = undefined;

    assert.deepEqual(fo.configuredOptions, []);
    assert.equal(fo.test("Motion.Detect"), true, "with an empty configured list the default is authoritative");
  });

  test("assigning new options rebuilds defaults, value index, and groups", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);
    const newCategories: FeatureCategoryEntry[] = [{ description: "Solo", name: "Solo" }];
    const newOptions: Record<string, FeatureOptionEntry[]> = {

      Solo: [{ default: true, defaultValue: 42, description: "Solo knob.", name: "Knob" }]
    };

    fo.categories = newCategories;
    fo.options = newOptions;

    assert.equal(fo.defaultValue("Solo.Knob"), true);
    assert.equal(fo.isValue("Solo.Knob"), true);
    assert.equal(fo.isValue("Motion.Detect"), false, "old options must be evicted from the value index");
  });

  test("assigning a nullish options map falls back to an empty record", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS);

    fo.options = undefined;

    assert.equal(fo.defaultValue("Motion.Detect"), false, "with no options defined the lookup resolves to the defaultReturnValue");
    assert.deepEqual(fo.groups, {});
  });
});

describe("FeatureOptions.setOption - encoded entry composition", () => {

  test("writes a global Enable entry for a non-value option and the lookup index reflects it immediately", () => {

    // Verifies the round-trip: setOption mutates the canonical configuredOptions array, and buildConfigIndex rebuilds the lookup so a subsequent test() reads
    // the new state without any caller-side index management.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Motion.Detect"]);
    assert.equal(fo.test("Motion.Detect"), true);
    assert.equal(fo.scope("Motion.Detect"), "global");
  });

  test("writes a Disable entry when enabled is false, and the value argument is silently dropped for disabled entries", () => {

    // The model encodes the resolution semantics: a disabled value-centric option has no meaningful value. The setter swallows the passed value rather than
    // emitting a malformed entry, so callers can hand whatever they have without pre-filtering.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: false, option: "Audio.Volume", value: 75 });

    assert.deepEqual(fo.configuredOptions, ["Disable.Audio.Volume"]);
    assert.equal(fo.value("Audio.Volume"), null, "value() on a disabled value-centric option returns null");
  });

  test("appends a value segment when enabled is true for a value-centric option", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, option: "Audio.Volume", value: 75 });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume=75"]);
    assert.equal(fo.value("Audio.Volume"), "75");
  });

  test("does not append a value segment when the option is not value-centric, even if a value is supplied", () => {

    // Defensive guard for callers that pass a value uniformly. The setter consults the model's own value-option registry to decide whether to emit the tail, so
    // the entry-format contract is honored from one place.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, option: "Motion.Detect", value: 999 });

    assert.deepEqual(fo.configuredOptions, ["Enable.Motion.Detect"]);
  });

  test("appends the scope id segment when id is supplied", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, id: "ABC123", option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Motion.Detect.ABC123"]);
    assert.equal(fo.test("Motion.Detect", "ABC123"), true);
    assert.equal(fo.scope("Motion.Detect", "ABC123"), "device");
  });

  test("emits both id and value segments for a scoped value-centric Enable entry", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, id: "ABC123", option: "Audio.Volume", value: 75 });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.ABC123=75"]);
    assert.equal(fo.value("Audio.Volume", "ABC123"), "75");
  });

  test("replaces any prior entry for the same option-at-scope rather than accumulating duplicates", () => {

    // The set-as-replace semantic is core to why the renderer can stop tracking what was previously written. The model owns the prior-state drop end-to-end.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [ "Enable.Audio.Volume.ABC123.10", "Disable.Audio.Volume.ABC123" ]);

    fo.setOption({ enabled: true, id: "ABC123", option: "Audio.Volume", value: 50 });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.ABC123=50"], "prior scoped entries for the same option must be removed before the new one is written");
  });

  test("a prior entry at a different scope is preserved when setOption writes a different scope", () => {

    // The scope tag is part of the addressing - setting ABC123 must not affect XYZ789.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Motion.Detect.XYZ789"]);

    fo.setOption({ enabled: false, id: "ABC123", option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, [ "Enable.Motion.Detect.XYZ789", "Disable.Motion.Detect.ABC123" ]);
  });

  test("matching is case-insensitive when locating the prior entry to replace", () => {

    // The renderer composes entries from FeatureOptionEntry names whose casing varies by plugin; the model must match prior entries regardless of how they were
    // originally cased.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["enable.motion.detect.abc123"]);

    fo.setOption({ enabled: false, id: "ABC123", option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, ["Disable.Motion.Detect.ABC123"]);
  });

  test("an empty id string is treated as global scope (no id segment emitted)", () => {

    // Defensive contract for callers that destructure a missing field into the empty string. The id is omitted from the entry when it has no length, matching
    // the encoded form for the global scope.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, id: "", option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Motion.Detect"]);
  });

  test("stores a list's supplied empty selection at either scope and reads it back as the selection it is", () => {

    // The round trip the empty selection has to survive: composed by the writer, decoded by the parser, and answered by the read - at the global scope and at a
    // device scope alike. Both entries are the bare-delimiter form, which is the spelling the grammar already had for "a value that is present and empty".
    const categories: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ default: true, defaultValue: "face,person", description: "Smart detection types.", multiple: true, name: "SmartDetect" }]
    };
    const fo = new FeatureOptions(categories, options, []);

    fo.setOption({ enabled: true, option: "Motion.SmartDetect", value: "" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Motion.SmartDetect="], "the global empty selection composes the bare-delimiter entry");
    assert.equal(fo.value("Motion.SmartDetect"), "", "and reads back as the empty selection rather than the registered default");

    fo.setOption({ enabled: true, id: "ABC123", option: "Motion.SmartDetect", value: "" });

    assert.deepEqual(fo.configuredOptions, [ "Enable.Motion.SmartDetect=", "Enable.Motion.SmartDetect.ABC123=" ],
      "the scoped empty selection composes the same way, alongside the global one");
    assert.equal(fo.value("Motion.SmartDetect", "ABC123"), "", "the scope carries its own empty selection");
    assert.deepEqual(fo.valueList({ device: "ABC123", option: "Motion.SmartDetect" }), [], "which selects no members");
  });

  test("a list asked to enable with no value at all composes exactly as every other option does", () => {

    // An omitted value says nothing about the selection, so the list gets the grammar's ordinary answers: the registered default where nothing is configured,
    // the bare entry globally, and a reduction to a clear at a scope.
    const categories: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ default: true, defaultValue: "face,person", description: "Smart detection types.", multiple: true, name: "SmartDetect" }]
    };
    const fo = new FeatureOptions(categories, options, []);

    assert.equal(fo.value("Motion.SmartDetect"), "face,person", "an unconfigured list resolves the registered default");

    fo.setOption({ enabled: true, option: "Motion.SmartDetect" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Motion.SmartDetect"], "the bare enable composes without a payload");
    assert.equal(fo.value("Motion.SmartDetect"), undefined, "which is enabled at an explicit scope with nothing given");

    const scoped = new FeatureOptions(categories, options, ["Enable.Motion.SmartDetect.ABC123=face"]);

    scoped.setOption({ enabled: true, id: "ABC123", option: "Motion.SmartDetect" });

    assert.deepEqual(scoped.configuredOptions, [], "and a scoped enable with no value still reduces to clearing the scope");
  });

  test("a supplied empty value on an option storing a single value persists nothing, at either scope", () => {

    // The parity boundary of the empty selection: only a list reads a supplied empty as something the user chose. Every other option answers the way it always
    // has - the bare entry globally, and a clear at a scope.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);

    assert.deepEqual(applySetOption({ args: { enabled: true, option: "Audio.Volume", value: "" }, catalog, configuredOptions: [] }),
      ["Enable.Audio.Volume"], "the global write composes the bare form");
    assert.deepEqual(applySetOption({ args: { enabled: true, id: "ABC123", option: "Audio.Volume", value: "" }, catalog,
      configuredOptions: ["Enable.Audio.Volume.ABC123=50"] }), [], "the scoped write reduces to clearing the scope");
  });
});

describe("FeatureOptions.clearOption - addresses entries by intent", () => {

  test("removes the matching global entry and leaves unrelated entries intact", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [ "Enable.Motion.Detect", "Disable.Audio.Mute" ]);

    fo.clearOption({ option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, ["Disable.Audio.Mute"]);
    assert.equal(fo.exists("Motion.Detect"), false);
  });

  test("removes both bare and value-tail forms for a value-centric option at the same scope", () => {

    // The value-aware matcher must catch `Enable.Audio.Volume.ABC123.50` AND `Disable.Audio.Volume.ABC123` (the form without a value tail). Both lexically address
    // the same option-at-scope from the renderer's perspective.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [

      "Enable.Audio.Volume.ABC123.50",
      "Disable.Audio.Volume.ABC123",
      "Enable.Audio.Volume.XYZ789.30"
    ]);

    fo.clearOption({ id: "ABC123", option: "Audio.Volume" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.XYZ789=30"], "only entries addressing the target scope are removed, and the survivor modernizes");
  });

  test("is a no-op fast path when no entry addresses the target - the configuredOptions reference is unchanged", () => {

    // Skipping the rebuild on no-match is an explicit optimization the implementation makes. Verifies the reference identity is preserved so the caller's snapshot
    // stays stable.
    const initial = [ "Enable.Motion.Detect", "Disable.Audio.Mute" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, initial);
    const before = fo.configuredOptions;

    fo.clearOption({ option: "Network.Mtu" });

    assert.equal(fo.configuredOptions, before, "no-match clear must not allocate a new array");
  });

  test("rejects entries that do not begin with Enable. or Disable. (defensive against external array tampering)", () => {

    // The configuredOptions array can be populated from user-edited JSON. A non-canonical prefix should be left alone rather than swept up by the matcher.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [ "Enable.Motion.Detect", "Garbage.Motion.Detect" ]);

    fo.clearOption({ option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, ["Garbage.Motion.Detect"], "only canonical Enable/Disable entries are subject to removal");
  });

  test("matches across casing differences in both action prefix and option name", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [ "enable.motion.detect", "DISABLE.MOTION.DETECT.ABC123" ]);

    fo.clearOption({ option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, ["DISABLE.MOTION.DETECT.ABC123"], "the global clear removes only the global entry, regardless of casing");
  });

  test("does not match a non-value option that has a trailing segment - that segment must belong to a longer option name", () => {

    // For non-value options, any tail past the scope id implies a different option. The matcher must reject these to preserve the longer option's entry intact.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Motion.Detect.ABC123"]);

    // Motion is a category, not an option, and is not registered as value-centric. Clearing "Motion" must not subsume `Enable.Motion.Detect.ABC123`.
    fo.clearOption({ option: "Motion" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Motion.Detect.ABC123"]);
  });
});

describe("FeatureOptions - shared parser correctness", () => {

  // The matcher and the index builder both run entries through parseEntry, so a behavioral assertion that proves they agree on prefix-collision cases is the
  // black-box equivalent of testing the parser directly. Setup: a value-centric "Audio" option AND a value-centric "Audio.Volume" option in distinct categories,
  // verifying greedy longest-prefix matching picks the more specific option name.
  const COLLISION_CATEGORIES: FeatureCategoryEntry[] = [

    { description: "Audio (top-level)", name: "Audio" },
    { description: "Volume container", name: "Volume" }
  ];

  const COLLISION_OPTIONS: Record<string, FeatureOptionEntry[]> = {

    Audio: [{ default: false, defaultValue: 10, description: "Audio top-level value.", name: "" }],
    Volume: [{ default: false, defaultValue: 50, description: "Volume setting.", name: "" }]
  };

  // The two options expand to "Audio" and "Volume" respectively (a category with an empty-name option folds to just the category name). To create the genuine
  // prefix collision between "audio" and "audio.volume", we instead use a more direct setup with explicit option names.
  const NESTED_CATEGORIES: FeatureCategoryEntry[] = [{ description: "Audio", name: "Audio" }];
  const NESTED_OPTIONS: Record<string, FeatureOptionEntry[]> = {

    Audio: [

      { default: false, defaultValue: 10, description: "Audio top-level value.", name: "" },
      { default: false, defaultValue: 50, description: "Audio volume sub-value.", name: "Volume" }
    ]
  };

  test("the greedy longest-prefix match prefers a more specific value-option name over a shorter prefix", () => {

    // Both "Audio" (expanded form: "audio") and "Audio.Volume" (expanded form: "audio.volume") are value-centric. An entry `Enable.Audio.Volume.50` must resolve
    // to the longer option (Audio.Volume = 50), not to the shorter option with a dotted value (Audio = "Volume.50").
    const fo = new FeatureOptions(NESTED_CATEGORIES, NESTED_OPTIONS, ["Enable.Audio.Volume.50"]);

    assert.equal(fo.value("Audio.Volume"), "50", "the longer value-option name wins: Audio.Volume resolves to 50");
    assert.equal(fo.value("Audio"), null, "Audio at the global scope is not explicitly enabled - the entry was claimed by Audio.Volume");
  });

  test("clearOption against a shorter prefix does not subsume entries whose tail belongs to a longer option", () => {

    // The reverse direction of the prior test: clearing Audio must not remove `Enable.Audio.Volume.50`, which addresses Audio.Volume.
    const fo = new FeatureOptions(NESTED_CATEGORIES, NESTED_OPTIONS, ["Enable.Audio.Volume.50"]);

    fo.clearOption({ option: "Audio" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.50"], "the longer-option entry must survive a clear targeting the shorter prefix");
  });

  test("setOption replaces only entries that the shared parser resolves to the same target, not prefix collisions", () => {

    // setOption({ option: "Audio.Volume", id: undefined, value: 75 }) must overwrite `Enable.Audio.Volume.50` (same option) but leave any hypothetical entry that
    // resolves to a different option untouched. We mix the value-centric collision case with a sibling entry to confirm the matcher is precise.
    const fo = new FeatureOptions(COLLISION_CATEGORIES, COLLISION_OPTIONS, [ "Enable.Audio.10", "Enable.Volume.50" ]);

    // "Audio" and "Volume" both expand to bare category names; setOption against "Volume" must replace only the Volume entry.
    fo.setOption({ enabled: true, option: "Volume", value: 75 });

    assert.deepEqual(fo.configuredOptions, [ "Enable.Audio.10", "Enable.Volume=75" ],
      "the Audio entry is left untouched - it addresses a different lookup target than Volume");
  });

  test("first-write-wins on duplicate entries is preserved when the index is built through the shared parser", () => {

    // The shared parser must keep buildConfigIndex's first-write-wins semantic intact - the earliest entry in the array takes precedence over later duplicates.
    // This is the contract hand-edited configs rely on when an option is listed twice.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [ "Disable.Motion.Detect", "Enable.Motion.Detect" ]);

    assert.equal(fo.test("Motion.Detect"), false, "the earliest entry (Disable) wins over the later duplicate (Enable)");
  });

  test("the index rebuild on a config-only mutation does not touch the catalog-derived state", () => {

    // Behavioral assertion that buildConfigIndex is the only thing that runs on setOption/clearOption/configuredOptions setter - the catalog (defaults, groups,
    // value options) does not change. We assert this indirectly by mutating a deep object the catalog rebuild would replace, then verifying it survives a config
    // mutation.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);
    const groupsBefore = fo.groups;

    fo.setOption({ enabled: false, option: "Motion.Detect" });

    assert.equal(fo.groups, groupsBefore, "the groups reference must be the same object after a config mutation - the catalog was not rebuilt");
  });
});

// The payload delimiter gives a value its own separator, so dots are left to address and nothing else. These tests pin the reader and the writer against each
// other across both accepted forms: what the canonical "=" grammar decodes to, what the legacy dot grammar still decodes to for configurations authored before
// it, and what the composer writes.
describe("FeatureOptions - the value payload delimiter", () => {

  test("a global value round-trips verbatim with periods and spaces intact", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume=St. Andrews"]);

    assert.equal(fo.value("Audio.Volume"), "St. Andrews", "everything behind the delimiter is the value, punctuation and original casing preserved");
  });

  test("a scoped value round-trips verbatim, with the id read from the segment ahead of the delimiter", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.123=Mr. Smith's Garden"]);

    assert.equal(fo.value("Audio.Volume", "123"), "Mr. Smith's Garden");
    assert.equal(fo.value("Audio.Volume"), null, "a scoped value must not leak up to the global lookup");
  });

  test("only the first delimiter splits, so a value may contain further ones", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.Kitchen=EQ=flat"]);

    assert.equal(fo.value("Audio.Volume", "Kitchen"), "EQ=flat", "the address ends at the first delimiter and the rest is value, delimiters included");
  });

  test("an empty value behind the delimiter reads as unspecified", () => {

    // The engine already treats an empty value as "no value given" wherever it appears, and the delimiter form is no exception.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume="]);

    assert.equal(fo.test("Audio.Volume"), true, "the option is still explicitly enabled");
    assert.equal(fo.value("Audio.Volume"), undefined, "enabled at an explicit scope with no value to report");
  });

  test("the legacy global form reads a single trailing segment as the value", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.50"]);

    assert.equal(fo.value("Audio.Volume"), "50");
  });

  test("a legacy scoped value round-trips verbatim with periods, spaces, and apostrophes intact", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.Kitchen.St. Cecilia's 7.1 Mix"]);

    assert.equal(fo.value("Audio.Volume", "Kitchen"), "St. Cecilia's 7.1 Mix",
      "everything past the id segment is the value, with punctuation and original casing preserved");
  });

  test("a legacy trailing period and a legacy multi-dot value both survive the round-trip", () => {

    // Under the legacy form the value is whatever follows the id's dot, so neither a terminal period nor interior ones need escaping.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [ "Enable.Audio.Volume.Kitchen.Zone 1.", "Enable.Network.Mtu.Attic.a.b.c" ]);

    assert.equal(fo.value("Audio.Volume", "Kitchen"), "Zone 1.");
    assert.equal(fo.value("Network.Mtu", "Attic"), "a.b.c");
  });

  test("a legacy dotted remainder reads as id-and-value rather than as a global value", () => {

    // The documented reading of the ambiguity the legacy form cannot settle: with no id segment to anchor on, a global value containing a period is
    // indistinguishable from a scope id followed by a value, and the scoped reading wins. Expressing that unambiguously is what the delimiter form is for. The
    // value keeps the space that trailed the period in the authored text.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.St. Andrews"]);

    assert.equal(fo.value("Audio.Volume", "St"), " Andrews", "the first segment is the scope id and the remainder is the value");
    assert.equal(fo.value("Audio.Volume"), null, "no global value is registered - Audio.Volume is default-off and unset at the global scope");
  });

  test("a dotted address ahead of the delimiter falls back to the legacy reading", () => {

    // The canonical grammar never writes a dotted address, so the delimiter cannot be claiming this entry. It reads under the legacy dot grammar instead, with
    // the "=" as ordinary value text - the reading a configuration authored before the delimiter existed meant: an id followed by a free-form value.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.a.b=x"]);

    assert.equal(fo.value("Audio.Volume", "a"), "b=x", "the first segment is the scope id and the delimiter rides inside the value");
    assert.equal(fo.value("Audio.Volume"), null, "no global value is registered");
  });

  test("the greedy longest-prefix match holds across the delimiter form", () => {

    // The same discipline the legacy form gets: with both "Audio" and "Audio.Volume" value-centric, `Enable.Audio.Volume=50` must bind to the longer option name
    // rather than to "Audio" carrying the value "Volume=50".
    const categories: FeatureCategoryEntry[] = [{ description: "Audio", name: "Audio" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Audio: [

        { default: false, defaultValue: 10, description: "Audio top-level value.", name: "" },
        { default: false, defaultValue: 50, description: "Audio volume sub-value.", name: "Volume" }
      ]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Audio.Volume=50"]);

    assert.equal(fo.value("Audio.Volume"), "50", "the longer value-option name wins");
    assert.equal(fo.value("Audio"), null, "the shorter option must not claim the entry");
  });

  test("the composer writes the delimiter form at both scopes, and the bare form when there is no value", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, option: "Audio.Volume", value: "St. Andrews" });
    fo.setOption({ enabled: true, id: "Kitchen", option: "Network.Mtu", value: "9000" });
    fo.setOption({ enabled: true, option: "Motion.Detect" });

    assert.deepEqual(fo.configuredOptions, [ "Enable.Audio.Volume=St. Andrews", "Enable.Network.Mtu.Kitchen=9000", "Enable.Motion.Detect" ]);
    assert.equal(fo.value("Audio.Volume"), "St. Andrews", "a free-form global value round-trips through the composer");
    assert.equal(fo.value("Network.Mtu", "Kitchen"), "9000");
  });

  test("the composer trims a value, and composes the bare form when nothing survives the trim", () => {

    // Trimming belongs to the writer, not the parser: this is the framework's only writer, while a hand-authored entry is taken exactly as the grammar reads it.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, option: "Audio.Volume", value: "  St. Andrews  " });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume=St. Andrews"], "surrounding whitespace is trimmed before composing");
    assert.equal(fo.value("Audio.Volume"), "St. Andrews");

    fo.setOption({ enabled: true, option: "Audio.Volume", value: "   " });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume"], "a value that is only whitespace composes the bare form, never an empty payload");
    assert.equal(fo.value("Audio.Volume"), undefined, "enabled at an explicit scope with no value to report");
  });

  test("whitespace around the delimiter is tolerated, and normalization emits the tight form", () => {

    // A hand-authored entry with the delimiter padded out reads exactly as the tight form the composer writes, at either scope. The address is right-trimmed and
    // the value trimmed; dots stay exact, so this tolerance never reaches the address separators.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const padded = [ "Enable.Audio.Volume = 50", "Enable.Network.Mtu.Kitchen = 9000" ];
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, padded);

    assert.equal(fo.value("Audio.Volume"), "50", "the padded global form resolves as the tight form does");
    assert.equal(fo.value("Network.Mtu", "Kitchen"), "9000", "the padded scoped form resolves as the tight form does");

    assert.deepEqual(normalizeConfiguredOptions(catalog, padded), [ "Enable.Audio.Volume=50", "Enable.Network.Mtu.Kitchen=9000" ],
      "saving converges the padded form on the tight canonical one");
  });

  test("a value-centric option set at a scope without a value persists nothing", () => {

    // The grammar has no scoped spelling for "enabled here, nothing given": the bare form would put the id where the legacy grammar reads a global value, and a
    // trailing delimiter is the shape base64 padding takes in a legacy entry. So the mutation reduces to clearing the scope, and resolution falls back to
    // inheritance - here, the catalog default.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);
    const before = fo.configuredOptions;

    fo.setOption({ enabled: true, id: "ABC123", option: "Audio.Volume" });

    assert.equal(fo.configuredOptions, before, "nothing to record and nothing to drop, so the array reference is unchanged");
    assert.equal(fo.test("Audio.Volume", "ABC123"), false, "resolution falls through to the catalog default");
    assert.equal(fo.scope("Audio.Volume", "ABC123"), "none", "no scope claims the option");
    assert.equal(fo.value("Audio.Volume"), null, "and no global value is invented out of the id");
  });

  test("the legacy bare-with-id form keeps its global-value reading", () => {

    // Pinned as it has always resolved, for configurations that predate the delimiter: the single trailing segment is read as this option's global value, while the
    // primary key registers the same text as a scope. Both readings are live at once, which is the ambiguity the delimiter form exists to avoid.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.ABC123"]);

    assert.equal(fo.value("Audio.Volume"), "ABC123", "the trailing segment reads as the global value");
    assert.equal(fo.test("Audio.Volume", "ABC123"), true, "and the same text registers a scope through the primary key");
    assert.equal(fo.value("Audio.Volume", "ABC123"), undefined, "which carries no value of its own");
  });

  test("a legacy global value ending in base64 padding keeps its legacy reading", () => {

    // The field case the content rule exists for: a base64-encoded key ends in "=" padding, which puts a bare delimiter at the end of a legacy-form entry. A
    // contentless payload can never be canonical, so the entry stays a legacy global value with its padding intact - one or two padding characters alike.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="]);

    assert.equal(fo.value("Audio.Volume"), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", "the padding is part of the value, not a payload delimiter");
    assert.equal(fo.test("Audio.Volume"), true, "the option reads as explicitly enabled at the global scope");

    const doublePadded = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.AAECAwQFBgcICQoLDA0ODw=="]);

    assert.equal(doublePadded.value("Audio.Volume"), "AAECAwQFBgcICQoLDA0ODw==", "double padding reads the same way");
  });

  test("a legacy scoped value ending in base64 padding keeps its legacy reading", () => {

    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.Kitchen.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="]);

    assert.equal(fo.value("Audio.Volume", "Kitchen"), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", "the id-and-value reading survives the trailing padding");
    assert.equal(fo.value("Audio.Volume"), null, "and nothing leaks to the global scope");
  });

  test("a value with no content never persists, at either scope", () => {

    // The content rule, from the writer's side: a value that is empty or all "=" once trimmed sits outside the canonical value domain, per the hasValueContent
    // predicate the writer and the parser share. Globally the enable persists bare; at a scope the mutation reduces to a clear.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, []);

    fo.setOption({ enabled: true, option: "Audio.Volume", value: "==" });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume"], "an all-delimiter value composes the bare global form");

    fo.setOption({ enabled: true, id: "Kitchen", option: "Audio.Volume", value: "  =  " });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume"], "an all-delimiter value at a scope persists nothing");
  });

  test("a global set replaces a legacy padding-form entry addressing the same option", () => {

    // The settling moment for the base64 legacy form: the user re-saves the option and the padding-form entry is replaced by the canonical spelling rather than
    // accumulating beside it. Cross-form replacement falls out of the shared parser, exactly as it does for every other legacy shape.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const before = ["Enable.Audio.Volume.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="];
    const after = applySetOption({ args: { enabled: true, option: "Audio.Volume", value: "50" }, catalog, configuredOptions: before });

    assert.deepEqual(after, ["Enable.Audio.Volume=50"], "one surviving entry in the canonical form");
  });

  test("a write replaces a legacy-form entry addressing the same scope, leaving one surviving entry", () => {

    // Cross-form replacement has to fall out of the shared parser rather than any special-casing: the matcher decodes the legacy entry to the same option-at-scope
    // the new write addresses, so a webUI edit overwrites it instead of leaving a duplicate behind.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const before = [ "Enable.Audio.Volume.Kitchen.St. Cecilia's 7.1 Mix", "Enable.Motion.Detect" ];
    const after = applySetOption({ args: { enabled: true, id: "Kitchen", option: "Audio.Volume", value: "Zone 1.2" }, catalog, configuredOptions: before });

    assert.deepEqual(after, [ "Enable.Motion.Detect", "Enable.Audio.Volume.Kitchen=Zone 1.2" ], "the legacy entry at that scope is replaced, not accumulated");
  });

  test("a scoped all-delimiter payload keeps its legacy reading on a list option too", () => {

    // The empty selection is spelled with the zero-length payload alone. An all-"=" payload is the shape base64 padding takes at the end of a legacy entry, so
    // the collision guard holds for every option: the whole tail reads as this option's global value and no scope is claimed.
    const categories: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ default: false, defaultValue: "face,person", description: "Smart detection types.", multiple: true, name: "SmartDetect" }]
    };
    const fo = new FeatureOptions(categories, options, ["Enable.Motion.SmartDetect.ABC123=="]);

    assert.equal(fo.value("Motion.SmartDetect"), "ABC123==", "the tail reads as a legacy global value, padding intact");
    assert.equal(fo.scope("Motion.SmartDetect", "ABC123"), "global", "the id segment is value text here, so no device scope is claimed");
  });

  test("a zero-length scoped payload on an option storing a single value still reads under the legacy grammar", () => {

    // The carve-out's other boundary, and the constraint a plugin converting an option to a list accepts: without the list declaration this entry is exactly the
    // base64-padding shape, so the tail stays a legacy global value.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, ["Enable.Audio.Volume.Kitchen="]);

    assert.equal(fo.value("Audio.Volume"), "Kitchen=", "the tail reads as a legacy global value, delimiter intact");
    assert.equal(fo.scope("Audio.Volume", "Kitchen"), "global", "and no scoped entry is claimed");
  });
});

// Saving a configuration also modernizes it. The mutation transforms run their results through the normalizer, so entries still in the legacy form are rewritten
// into the canonical one as part of a save the user already asked for - and never merely because something read the configuration.
describe("FeatureOptions - normalization on save", () => {

  test("an edit to one option modernizes a legacy value entry for another", () => {

    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const before = [ "Enable.Audio.Volume.Kitchen.St. Cecilia's Mix", "Disable.Motion.Detect", "Enable.Network.Mtu = 9000" ];
    const after = applySetOption({ args: { enabled: true, option: "Motion.Sensitivity" }, catalog, configuredOptions: before });

    assert.deepEqual(after, [

      "Enable.Audio.Volume.Kitchen=St. Cecilia's Mix",
      "Disable.Motion.Detect",
      "Enable.Network.Mtu=9000",
      "Enable.Motion.Sensitivity"
    ], "value entries modernize, the boolean entry is untouched, and the caller's own edit lands last");

    assert.deepEqual(before, [ "Enable.Audio.Volume.Kitchen.St. Cecilia's Mix", "Disable.Motion.Detect", "Enable.Network.Mtu = 9000" ],
      "the input array is never mutated");
  });

  test("the legacy single-trailing-segment form is deliberately left as written", () => {

    // Its trailing segment does double duty - the index registers it as the option's global value AND, through the primary key, as an enable at a scope of that
    // same name - and no one canonical entry carries both readings. Rewriting it would settle an ambiguity that belongs to the user, so a save leaves it alone
    // even while modernizing everything around it.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const before = [ "Enable.Audio.Volume.ABC123", "Enable.Network.Mtu.Attic.1500" ];
    const after = applySetOption({ args: { enabled: true, option: "Motion.Detect" }, catalog, configuredOptions: before });

    assert.deepEqual(after, [ "Enable.Audio.Volume.ABC123", "Enable.Network.Mtu.Attic=1500", "Enable.Motion.Detect" ],
      "the ambiguous single-segment entry survives verbatim while the unambiguous scoped one modernizes");

    // The reading it would have lost had it been rewritten: the scope registration the primary key carries.
    assert.equal(new FeatureOptions(CATEGORIES, OPTIONS, [...after]).test("Audio.Volume", "ABC123"), true, "the scope reading survives the save");
  });

  test("entries the parser cannot fully account for pass through byte-verbatim", () => {

    // Boolean options, options absent from the catalog, disabled entries, and outright malformed strings are a user's own text. We only reshape what we can state
    // the meaning of exactly.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const before = [

      "Enable.Motion.Detect",
      "Disable.Audio.Volume.ABC123",
      "Enable.Unknown.Option.50",
      "Garbage.Motion.Detect",
      "NoDotsAtAll"
    ];

    assert.equal(normalizeConfiguredOptions(catalog, before), before, "nothing needed rewriting, so the input reference comes back unchanged");
  });

  test("normalizing an already-normalized array changes nothing", () => {

    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const once = normalizeConfiguredOptions(catalog, [ "Enable.Audio.Volume.Kitchen.St. Cecilia's Mix", "Enable.Network.Mtu = 9000" ]);

    assert.deepEqual(once, [ "Enable.Audio.Volume.Kitchen=St. Cecilia's Mix", "Enable.Network.Mtu=9000" ]);
    assert.equal(normalizeConfiguredOptions(catalog, once), once, "a second pass finds nothing to change and returns the same reference");
  });

  test("legacy values carrying the delimiter modernize into the canonical form on save", () => {

    // A base64 value's padding rules the scope reading out - the composer cannot address an id containing "=" - so both legacy shapes are unambiguous here and
    // both modernize: the single-segment form to a global value, the dotted form to a scoped one. The rewritten entries re-read to exactly the values the
    // originals carried, padding included.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const before = [ "Enable.Audio.Volume.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", "Enable.Network.Mtu.Attic.SGVsbG8=" ];
    const after = normalizeConfiguredOptions(catalog, before);

    assert.deepEqual(after, [ "Enable.Audio.Volume=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", "Enable.Network.Mtu.Attic=SGVsbG8=" ]);
    assert.equal(normalizeConfiguredOptions(catalog, after), after, "a second pass finds nothing to change and returns the same reference");

    const reread = new FeatureOptions(CATEGORIES, OPTIONS, [...after]);

    assert.equal(reread.value("Audio.Volume"), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", "the modernized global entry re-reads to the same value");
    assert.equal(reread.value("Network.Mtu", "Attic"), "SGVsbG8=", "the modernized scoped entry re-reads to the same value");
  });

  test("a legacy entry read as an id plus a value is rewritten to say so", () => {

    // The disclosure that makes normalization worth doing: `Enable.Audio.Volume.St. Andrews` resolves as the id "St" carrying the value " Andrews", and rewriting
    // it in the canonical form puts that reading in front of the user instead of leaving it latent. The value arrives trimmed, since the canonical value domain
    // has no room for edge whitespace.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);

    assert.deepEqual(normalizeConfiguredOptions(catalog, ["Enable.Audio.Volume.St. Andrews"]), ["Enable.Audio.Volume.St=Andrews"]);
  });

  test("a list's stored empty selection is already canonical at either scope and survives a save untouched", () => {

    // Normalization rewrites an entry only into something that re-reads as exactly what it replaced, so the spelling the writer composes for an empty selection
    // has to be the spelling the parser answers - at both scopes. A save moves neither entry, and a second pass finds nothing to do.
    const categories: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ default: true, defaultValue: "face,person", description: "Smart detection types.", multiple: true, name: "SmartDetect" }]
    };
    const catalog = buildCatalogIndex(categories, options);
    const stored = [ "Enable.Motion.SmartDetect=", "Enable.Motion.SmartDetect.ABC123=" ];
    const once = normalizeConfiguredOptions(catalog, stored);

    assert.deepEqual(once, [ "Enable.Motion.SmartDetect=", "Enable.Motion.SmartDetect.ABC123=" ], "both empty-selection entries are already canonical");
    assert.equal(normalizeConfiguredOptions(catalog, once), once, "a second pass finds nothing to change and returns the same reference");
  });
});

describe("FeatureOptions - browser-safe runtime-import boundary", () => {

  // Regression guard for the `dist/ui` shipping pipeline. `featureOptions.ts` compiles into `dist/featureOptions.js`, which the browser-module copy step copies
  // to `dist/ui/featureOptions.js` for the browser to load. Every relative value-import in `featureOptions.ts` therefore has to resolve - at browser runtime - to a
  // sibling file that the copy step ALSO ships into `dist/ui/`. Importing from `./util.ts` is the canonical violation: `util.ts` is server-side (drags in
  // `node:timers/promises`) and the build pipeline does not ship it next to the orchestrator. This test reads the source file and asserts every relative
  // value-import points at a module on the allowlist - currently just `./formatters.ts`, the one browser-safe module the pipeline mirrors alongside
  // `featureOptions.js`. Adding a new relative value-import to featureOptions.ts means EITHER pointing it at another browser-safe module the copy step ALSO ships,
  // OR widening the allowlist here intentionally and registering the new artifact in the `BROWSER_MODULES` list the copy step is driven from.

  test("featureOptions.ts has no relative value-imports outside the browser-safe allowlist", async () => {

    const source = await readFile(new URL("./featureOptions.ts", import.meta.url), "utf8");

    // Match `import { ... } from "./module.ts";` lines. The `import type` form is excluded by the negative lookahead - those are erased at emit and never reach the
    // browser. The capture group pulls the relative module specifier so we can compare it against the allowlist.
    const valueImportRe = /^import(?!\s+type\b)\s+[^;]+from\s+"(\.[^"]+)";/gm;
    const allowed = new Set(["./formatters.ts"]);
    const found = new Set<string>();

    for(const match of source.matchAll(valueImportRe)) {

      const specifier = match[1];

      if(specifier !== undefined) {

        found.add(specifier);
      }
    }

    for(const specifier of found) {

      assert.ok(allowed.has(specifier), "featureOptions.ts must only relative-value-import from a browser-safe module (allowlist: " + [...allowed].join(", ") +
        "). Found: " + specifier + ". If this is a new browser-safe module, add it here AND to the BROWSER_MODULES list in build/browser-modules.mjs.");
    }
  });
});

// The pure functional core exposes the same semantics as the class but with an immutable-state contract: inputs are never mutated, fresh allocations are returned
// by transforms, no-op transforms preserve reference identity for change-detection consumers. The class tests above cover the semantics; these tests cover the
// contract that the pure form adds on top - the part reducer-driven consumers (the webUI store) rely on for memoization and structural-sharing correctness.
describe("FeatureOptions - pure functional core", () => {

  describe("buildCatalogIndex", () => {

    test("derives defaults, value-options, groups, group parents, and sorted-value-option-names from raw inputs", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);

      assert.equal(catalog.defaults["motion.detect"], true, "boolean default from catalog");
      assert.equal(catalog.defaults["audio.volume"], false, "value-centric default from catalog");
      assert.equal(catalog.valueOptions["audio.volume"], 50, "value-centric default value indexed");
      assert.equal(catalog.valueOptions["network.mtu"], "1500", "string-typed default value indexed");
      assert.deepEqual(catalog.groupParents, { "Audio.Mute": "Audio", "Motion.Sensitivity": "Motion.Detect" }, "child-to-parent reverse index");
      assert.deepEqual(catalog.groups["Motion.Detect"], ["Motion.Sensitivity"], "parent-to-children forward index");
      assert.deepEqual(catalog.sortedValueOptionNames, [...catalog.sortedValueOptionNames].sort((a, b) => b.length - a.length), "sorted longest-first");
    });

    test("preserves the input categories and options references on the resulting index", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);

      assert.equal(catalog.categories, CATEGORIES, "categories reference preserved verbatim");
      assert.equal(catalog.options, OPTIONS, "options reference preserved verbatim");
    });

    test("throws at index-build time when a render declaration names an unknown built-in formatter", () => {

      const bad: Record<string, FeatureOptionEntry[]> = {

        Motion: [{ default: false, defaultValue: 0, description: "Bad formatter.", name: "Detect", render: "bogus" as FeatureOptionFormatter }]
      };

      assert.throws(() => buildCatalogIndex(CATEGORIES, bad), /unknown built-in formatter "bogus"/);
    });

    test("keys the raw-entry lookup by the lowercased expanded name, as every other registry here is keyed", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const [volume] = OPTIONS["Audio"] ?? [];

      assert.ok(volume, "fixture sanity check");
      assert.equal(catalog.optionsByName["audio.volume"], volume, "the raw entry, by identity, under the lowercased name");
      assert.equal(catalog.optionsByName["motion.detect"]?.name, "Detect", "a boolean option is registered exactly as a value option is");
      assert.equal(Object.keys(catalog.optionsByName).length, Object.keys(catalog.defaults).length, "every option the defaults map carries has an entry here");
      assert.equal(catalog.optionsByName["unknown.option"], undefined, "an option the catalog does not declare has no entry");
    });

    // The picker declarations are catalog data the engine itself never reads, so the one thing that can go wrong with them is a plugin declaring a combination
    // nothing downstream can honor. Each case gets its own single-fault fixture, and each assertion matches the case's own detail phrase plus the entry name, so a
    // check that starts firing for the wrong reason fails here rather than in whatever consumer the wrong entry reached.
    describe("picker declaration validation", () => {

      const withOption = (option: FeatureOptionEntry): Record<string, FeatureOptionEntry[]> => ({ Motion: [option] });

      const CHOICE_LIST = [ { label: "High", value: "high" }, { label: "Low", value: "low" } ];

      test("rejects a choice or list declared without a default value", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption({ choices: CHOICE_LIST, default: false, description: "No default.", name: "Tier" })),
          /a choice or list without a default value declared on option "Motion\.Tier"/);
        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption({ default: false, description: "No default.", multiple: true, name: "Plates" })),
          /a choice or list without a default value declared on option "Motion\.Plates"/);
      });

      test("rejects a secret choice", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: CHOICE_LIST, default: false, defaultValue: "high", description: "Masked picker.", name: "Tier", secret: true })),
        /a secret choice declared on option "Motion\.Tier"/);
      });

      test("rejects an empty choices declaration in either spelling", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption({ choices: [], default: false, defaultValue: "", description: "Empty list.", name: "Tier" })),
          /an empty choices declaration declared on option "Motion\.Tier"/);
        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption({ choices: "", default: false, defaultValue: "", description: "Empty source.", name: "Tier" })),
          /an empty choices declaration declared on option "Motion\.Tier"/);
      });

      test("rejects an inline choice that fails the shared validity rule", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: [{ label: "", value: "high" }], default: false, defaultValue: "high", description: "Unlabelled.", name: "Tier" })),
        /an invalid choice declared on option "Motion\.Tier"/);
        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: [{ label: "Both", value: "a,b" }], default: false, defaultValue: "a,b", description: "Delimited value.", name: "Tier" })),
        /an invalid choice declared on option "Motion\.Tier"/);
      });

      test("rejects a non-string default on a choice or list", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: CHOICE_LIST, default: false, defaultValue: 5, description: "Numeric default.", name: "Tier" })),
        /a non-string default on a choice or list declared on option "Motion\.Tier"/);
      });

      test("rejects an all-choices default outside a multiple choice", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: CHOICE_LIST, default: false, defaultValue: ALL_CHOICES, description: "Single picker.", name: "Tier" })),
        /an all-choices default outside a multiple choice declared on option "Motion\.Tier"/);
        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { default: false, defaultValue: ALL_CHOICES, description: "No list to expand.", multiple: true, name: "Plates" })),
        /an all-choices default outside a multiple choice declared on option "Motion\.Plates"/);
        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { default: false, defaultValue: ALL_CHOICES, description: "An ordinary value option.", name: "Mtu" })),
        /an all-choices default outside a multiple choice declared on option "Motion\.Mtu"/);
      });

      test("rejects a default naming a value the inline list does not offer", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: CHOICE_LIST, default: false, defaultValue: "medium", description: "Absent default.", name: "Tier" })),
        /a default outside the declared choices declared on option "Motion\.Tier"/);
        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: CHOICE_LIST, default: false, defaultValue: "high,medium", description: "One absent entry.", multiple: true, name: "Tier" })),
        /a default outside the declared choices declared on option "Motion\.Tier"/);
      });

      test("rejects a presentation style with nothing to present", () => {

        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { default: false, defaultValue: "high", description: "A style with no list behind it.", name: "Tier", style: "radio" })),
        /a presentation style without choices declared on option "Motion\.Tier"/);
        assert.throws(() => buildCatalogIndex(CATEGORIES, withOption(
          { choices: CHOICE_LIST, default: false, defaultValue: "high,low", description: "A styled list.", multiple: true, name: "Tier", style: "radio" })),
        /a presentation style on a multiple choice declared on option "Motion\.Tier"/);
      });

      test("accepts every legal declaration, including the ones the checks above come closest to catching", () => {

        const legal: Record<string, FeatureOptionEntry[]> = {

          Motion: [

            { choices: CHOICE_LIST, default: false, defaultValue: "high", description: "A single picker.", name: "Tier" },
            { choices: CHOICE_LIST, default: false, defaultValue: "", description: "A picker starting with no value.", name: "TierUnset" },
            { choices: CHOICE_LIST, default: false, defaultValue: "high", description: "A picker held to a dropdown.", name: "TierDropdown", style: "dropdown" },
            { choices: CHOICE_LIST, default: false, defaultValue: "high", description: "A picker held to a radio group.", name: "TierRadio", style: "radio" },
            { choices: CHOICE_LIST, default: false, defaultValue: ALL_CHOICES, description: "Everything by default.", multiple: true, name: "Tiers" },
            { choices: CHOICE_LIST, default: false, defaultValue: "high,low", description: "An explicit list default.", multiple: true, name: "TierList" },
            { choices: "smartDetectTypes", default: false, defaultValue: "person", description: "A source-backed picker.", multiple: true, name: "Detected" },
            { default: false, defaultValue: "", description: "A free-form list.", multiple: true, name: "Plates" },
            { default: false, defaultValue: 50, description: "An ordinary value option, untouched by any of this.", name: "Volume" },
            { default: true, description: "An ordinary boolean, untouched by any of this.", name: "Detect" }
          ]
        };

        const catalog = buildCatalogIndex(CATEGORIES, legal);

        assert.equal(catalog.optionsByName["motion.detected"]?.choices, "smartDetectTypes", "a source name passes through as declared");
        assert.equal(catalog.optionsByName["motion.tierradio"]?.style, "radio", "a declared style passes through as the editor vocabulary it is");
        assert.equal(catalog.valueOptions["motion.tiers"], ALL_CHOICES, "an all-choices default is registered like any other value default");
      });
    });
  });

  describe("buildConfigIndex", () => {

    test("constructs an immutable Map of lookup keys to enabled/value records", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const index = buildConfigIndex(catalog, [ "Enable.Motion.Detect.dev1", "Disable.Motion.Sensitivity" ]);

      assert.equal(index.get("motion.detect.dev1")?.enabled, true);
      assert.equal(index.get("motion.sensitivity")?.enabled, false);
    });

    test("returns a fresh Map on each call so memoization consumers see a new reference per config snapshot", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const a = buildConfigIndex(catalog, ["Enable.Motion.Detect"]);
      const b = buildConfigIndex(catalog, ["Enable.Motion.Detect"]);

      assert.notEqual(a, b, "different invocations return different Map references");
    });
  });

  describe("applySetOption", () => {

    test("returns a fresh array - the input is not mutated", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const before: readonly string[] = ["Enable.Audio.Mute"];
      const after = applySetOption({ args: { enabled: true, option: "Motion.Detect" }, catalog, configuredOptions: before });

      assert.notEqual(after, before, "fresh array reference");
      assert.deepEqual(before, ["Enable.Audio.Mute"], "input array contents preserved verbatim");
    });

    test("preserves the caller's casing on the appended entry's option and id segments", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const after = applySetOption({ args: { enabled: true, id: "ABC123", option: "Audio.Volume", value: 75 }, catalog, configuredOptions: [] });

      assert.deepEqual(after, ["Enable.Audio.Volume.ABC123=75"]);
    });

    test("drops any prior entry addressing the same option-at-scope before appending the new entry", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const before = [ "Enable.Audio.Volume.ABC123.50", "Enable.Motion.Detect" ];
      const after = applySetOption({ args: { enabled: false, id: "ABC123", option: "Audio.Volume" }, catalog, configuredOptions: before });

      assert.deepEqual(after, [ "Enable.Motion.Detect", "Disable.Audio.Volume.ABC123" ]);
    });

    test("returns the SAME input reference when a scoped enable without value content finds nothing to drop", () => {

      // The scoped-enable-without-content reduction delegates to applyClearOption, so it inherits the reference-stable no-op: change-detection consumers see
      // the mutation wrote nothing without comparing contents.
      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const before = ["Enable.Motion.Detect"];
      const after = applySetOption({ args: { enabled: true, id: "ABC123", option: "Audio.Volume" }, catalog, configuredOptions: before });

      assert.equal(after, before, "reference-stable on no-op so change-detection consumers can compare by ===");
    });

    test("reduces a scoped enable without value content to clearing the scope", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const before = [ "Enable.Audio.Volume.ABC123=50", "Enable.Motion.Detect" ];
      const after = applySetOption({ args: { enabled: true, id: "ABC123", option: "Audio.Volume", value: "  " }, catalog, configuredOptions: before });

      assert.deepEqual(after, ["Enable.Motion.Detect"], "the scope's entry is dropped and nothing replaces it");
    });
  });

  describe("hasValueContent", () => {

    test("accepts any trimmed text carrying a non-delimiter character and rejects the rest", () => {

      // The shared definition of "carries a value": whitespace-only and all-"=" payloads sit outside the canonical value domain, which is exactly the shape of
      // base64 terminal padding - while padding attached to real content rides along like any other character.
      assert.equal(hasValueContent("50"), true, "ordinary text carries content");
      assert.equal(hasValueContent("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="), true, "a full base64 value carries content, padding included");
      assert.equal(hasValueContent(""), false, "the empty string carries nothing");
      assert.equal(hasValueContent("   "), false, "whitespace alone carries nothing");
      assert.equal(hasValueContent("="), false, "a lone delimiter carries nothing");
      assert.equal(hasValueContent(" == "), false, "delimiters and edge whitespace together still carry nothing");
    });
  });

  // The grammar is a contract two sides read: the browser editor composing a list and a plugin splitting it back apart. Each row is therefore checked in both
  // directions - what the text parses to, and what formatting that parse composes - so the normalization a stored value settles into is pinned, not just the split.
  describe("the greedy-prefix discipline", () => {

    test("an option name that is merely a PREFIX of a longer token does not claim that token's value", () => {

      // "Audio.Volume" is a prefix of "Audio.Volumes", which no option declares. The parser has to recognize that the candidate ran out mid-token and keep trying
      // shorter names rather than reading the tail as this option carrying a value - a leak that would have an entry for one option silently configure another.
      // The rule is documented as the greedy-prefix discipline and is pinned here rather than left to whichever fixture happens to exercise it.
      const options = new FeatureOptions(CATEGORIES, structuredClone(OPTIONS), ["Enable.Audio.Volumes=5"]);

      assert.equal(options.scope("Audio.Volume"), "none", "nothing was configured for this option at any scope");
      assert.equal(options.test("Audio.Volume"), false, "so it keeps its default-off state rather than being enabled by the entry beside it");
      assert.equal(options.value("Audio.Volume"), null, "and carries no value - reading 5 here would be the longer token's value leaking into it");
    });
  });

  describe("the list grammar", () => {

    const LIST_ROWS: readonly { input: string; parsed: readonly string[]; formatted: string }[] = [

      { formatted: "", input: "", parsed: [] },
      { formatted: "", input: "   ", parsed: [] },
      { formatted: "a", input: "a", parsed: ["a"] },
      { formatted: "a,b", input: "a,b", parsed: [ "a", "b" ] },
      { formatted: "a,b", input: " a , b ", parsed: [ "a", "b" ] },
      { formatted: "a,b", input: "a,,b", parsed: [ "a", "b" ] },
      { formatted: "a", input: ",a,", parsed: ["a"] },
      { formatted: "a,b,c", input: "a, b,,c ", parsed: [ "a", "b", "c" ] },
      { formatted: "ABC123,XYZ789", input: "ABC123,XYZ789", parsed: [ "ABC123", "XYZ789" ] },
      { formatted: "a,a", input: "a,a", parsed: [ "a", "a" ] },
      { formatted: "*", input: "*", parsed: ["*"] }
    ];

    test("parses every row to its entries and formats that parse back to the canonical text", () => {

      for(const { formatted, input, parsed } of LIST_ROWS) {

        assert.deepEqual(parseValueList(input), parsed, "parse of " + JSON.stringify(input));
        assert.equal(formatValueList(parseValueList(input)), formatted, "format of the parse of " + JSON.stringify(input));
      }
    });

    test("a parse followed by a format is stable under a second pass", () => {

      // Stability is what lets a value be re-written on every save without drifting: the canonical text has to parse to the same entries the raw text did.
      for(const { input } of LIST_ROWS) {

        const canonical = formatValueList(parseValueList(input));

        assert.equal(formatValueList(parseValueList(canonical)), canonical, "second pass over " + JSON.stringify(input));
      }
    });

    test("the grammar preserves duplicates, leaving de-duplication to the selection derivation", () => {

      assert.deepEqual(parseValueList("a,a"), [ "a", "a" ], "the grammar reports what the text says");
      assert.deepEqual(selectValues({ domain: [ "a", "b" ], multiple: true, value: "a,a" }).selected, ["a"], "the selection is where a repeat collapses");
    });
  });

  describe("isValidChoice", () => {

    test("accepts a labelled, addressable value and rejects every shape that is not one", () => {

      assert.equal(isValidChoice({ label: "High", value: "high" }), true, "a label and an addressable value");
      assert.equal(isValidChoice({ label: "", value: "high" }), false, "an empty label shows the user nothing");
      assert.equal(isValidChoice({ label: "High", value: "" }), false, "an empty value stores nothing");
      assert.equal(isValidChoice({ label: "High", value: "a,b" }), false, "a value carrying the delimiter would come back as two entries");
      assert.equal(isValidChoice({ label: "Everything", value: "*" }), false, "a value spelling the all-choices default would be read as the wildcard");
      assert.equal(isValidChoice({ value: "high" }), false, "no label at all");
      assert.equal(isValidChoice({ label: "High" }), false, "no value at all");
      assert.equal(isValidChoice({ label: "High", value: 5 }), false, "a value that is not text cannot be stored");
      assert.equal(isValidChoice("high"), false, "a bare string is not a choice");
      assert.equal(isValidChoice(null), false, "null is an object by typeof and is excluded explicitly");
    });
  });

  describe("selectValues", () => {

    const DOMAIN = [ "a", "b", "c" ];

    test("reads a list value against the domain, expanding the wildcard and preserving what the domain lacks", () => {

      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: true, value: undefined }), { selected: [], unknown: [] }, "nothing stored");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: true, value: "" }), { selected: [], unknown: [] }, "an empty value names no entries");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: true, value: "b,a" }), { selected: [ "a", "b" ], unknown: [] }, "selected read in domain order");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: true, value: "b,zzz" }), { selected: ["b"], unknown: ["zzz"] }, "an absent entry is reported");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: true, value: ALL_CHOICES }), { selected: DOMAIN, unknown: [] }, "the wildcard is the whole domain");
      assert.deepEqual(selectValues({ domain: [ "a", "a", "b" ], multiple: true, value: ALL_CHOICES }), { selected: [ "a", "b" ], unknown: [] },
        "a repeated domain member is selected once");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: true, value: "a,a,zzz,zzz" }), { selected: ["a"], unknown: ["zzz"] }, "both sides de-duplicate");
    });

    test("reads a single-valued option as one candidate, with no wildcard reading", () => {

      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: false, value: "b" }), { selected: ["b"], unknown: [] }, "a member of the domain");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: false, value: "zzz" }), { selected: [], unknown: ["zzz"] }, "a value the domain lacks");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: false, value: "" }), { selected: [], unknown: [] }, "an empty value is not an unknown one");
      assert.deepEqual(selectValues({ domain: DOMAIN, multiple: false, value: ALL_CHOICES }), { selected: [], unknown: [ALL_CHOICES] },
        "the wildcard has no meaning off a multiple option and reads as an ordinary unknown value");
    });
  });

  describe("applyClearOption", () => {

    test("returns the SAME input reference as a no-op when nothing addresses the target", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const before = ["Enable.Motion.Detect"];
      const after = applyClearOption({ args: { option: "Audio.Volume" }, catalog, configuredOptions: before });

      assert.equal(after, before, "reference-stable on no-op so change-detection consumers can compare by ===");
    });

    test("returns a fresh array when entries match, leaving the input untouched", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const before: readonly string[] = [ "Enable.Motion.Detect", "Enable.Audio.Volume.50" ];
      const after = applyClearOption({ args: { option: "Audio.Volume" }, catalog, configuredOptions: before });

      assert.notEqual(after, before, "fresh array reference");
      assert.deepEqual(before, [ "Enable.Motion.Detect", "Enable.Audio.Volume.50" ], "input array contents preserved verbatim");
      assert.deepEqual(after, ["Enable.Motion.Detect"]);
    });
  });

  describe("resolveScope", () => {

    test("walks the device -> controller -> global precedence and reports the resolved scope", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const configIndex = buildConfigIndex(catalog, [ "Enable.Motion.Detect.dev1", "Disable.Motion.Detect.ctrl1" ]);

      assert.equal(resolveScope({ catalog, configIndex, controller: "ctrl1", device: "dev1", option: "Motion.Detect" }).scope, "device");
      assert.equal(resolveScope({ catalog, configIndex, controller: "ctrl1", option: "Motion.Detect" }).scope, "controller");
      assert.equal(resolveScope({ catalog, configIndex, option: "Motion.Detect" }).scope, "none", "falls back to catalog default when no explicit entry matches");
    });

    test("returns enabled + optionValue together for value-centric options resolved at any scope", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const configIndex = buildConfigIndex(catalog, ["Enable.Audio.Volume.dev1.75"]);
      const resolved = resolveScope({ catalog, configIndex, device: "dev1", option: "Audio.Volume" });

      assert.equal(resolved.scope, "device");
      assert.equal(resolved.enabled, true);
      assert.equal(resolved.optionValue, "75");
    });

    test("honors defaultReturnValue for options not in the catalog's defaults map", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const configIndex = buildConfigIndex(catalog, []);

      assert.equal(resolveScope({ catalog, configIndex, defaultReturnValue: true, option: "Unknown.Option" }).enabled, true);
      assert.equal(resolveScope({ catalog, configIndex, defaultReturnValue: false, option: "Unknown.Option" }).enabled, false);
    });
  });

  describe("pure query helpers", () => {

    test("expandOption composes category.option, with edge cases for empty inputs", () => {

      const [motionCategory] = CATEGORIES;
      const [motionDetect] = OPTIONS["Motion"] ?? [];

      assert.ok(motionCategory && motionDetect, "fixture sanity check");
      assert.equal(expandOption("Motion", "Detect"), "Motion.Detect");
      assert.equal(expandOption(motionCategory, motionDetect), "Motion.Detect", "accepts entry objects as well as raw strings");
      assert.equal(expandOption("", "Detect"), "", "empty category collapses to empty string");
      assert.equal(expandOption("Motion", ""), "Motion", "empty option returns category alone");
    });

    test("getDefaultValue reads the catalog index and falls back to the supplied default", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);

      assert.equal(getDefaultValue({ catalog, option: "Motion.Detect" }), true);
      assert.equal(getDefaultValue({ catalog, defaultReturnValue: true, option: "Unknown.Option" }), true);
      assert.equal(getDefaultValue({ catalog, option: "Unknown.Option" }), false, "fallback defaults to false when not supplied");
    });

    test("isValueOption recognizes value-centric options regardless of casing", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);

      assert.equal(isValueOption(catalog, "Audio.Volume"), true);
      assert.equal(isValueOption(catalog, "audio.volume"), true);
      assert.equal(isValueOption(catalog, "Motion.Detect"), false, "boolean option");
      assert.equal(isValueOption(catalog, ""), false, "empty string");
    });

    test("optionExists answers explicit-presence questions over the config index", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const configIndex = buildConfigIndex(catalog, ["Enable.Motion.Detect.dev1"]);

      assert.equal(optionExists({ catalog, configIndex, id: "dev1", option: "Motion.Detect" }), true);
      assert.equal(optionExists({ catalog, configIndex, option: "Motion.Detect" }), false, "device-scoped entry does not satisfy global-scope existence");
      assert.equal(optionExists({ catalog, configIndex, id: "dev2", option: "Motion.Detect" }), false);
    });

    test("isDependencyMet returns true for ungrouped options and resolves the parent's state for grouped options", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const enabledParent = buildConfigIndex(catalog, ["Enable.Motion.Detect"]);
      const disabledParent = buildConfigIndex(catalog, ["Disable.Motion.Detect"]);

      assert.equal(isDependencyMet({ catalog, configIndex: enabledParent, option: "Motion.Detect" }), true, "ungrouped option has no dependency");
      assert.equal(isDependencyMet({ catalog, configIndex: enabledParent, option: "Motion.Sensitivity" }), true, "grouped option with enabled parent");
      assert.equal(isDependencyMet({ catalog, configIndex: disabledParent, option: "Motion.Sensitivity" }), false, "grouped option with disabled parent");
    });
  });
});

/* A picker's `choices` and `style` declarations are editor data. Nothing in the engine - the entry grammar, storage, scope resolution, value() - is allowed to
 * read either, which is the property that lets a plugin attach a picker to an existing option, or restyle one it already has, while every configuration already
 * written goes on resolving to what it always did. The `multiple` declaration beside them is the one that does reach the engine, at the empty selection alone:
 * "on, with nothing selected" is a state a list can be in, so the grammar gives it the bare-delimiter spelling a scoped entry stores and a read answers as the
 * empty list. Away from that one point a list resolves like any other value option, which is the ground the rows below stand on - every value they store or
 * read carries content.
 *
 * The guard proves it by building the same catalog twice, once with the declarations and once without, and comparing every DERIVED map. The three members that
 * are not derived are excluded by construction rather than by exception: `categories` and `options` are the raw inputs preserved verbatim, and `optionsByName`
 * holds those same raw entries, so all three necessarily carry whatever the plugin declared.
 */
describe("FeatureOptions - the choices declarations are inert to the engine", () => {

  const PLAIN: Record<string, FeatureOptionEntry[]> = {

    Motion: [

      { default: true, description: "Enable motion detection.", name: "Detect" },
      { default: false, defaultValue: "high", description: "Detection tier.", group: "Detect", name: "Tier" },
      { default: false, defaultValue: "high", description: "Detection quality.", name: "Quality" }
    ]
  };

  const PICKERS: Record<string, FeatureOptionEntry[]> = {

    Motion: [

      { default: true, description: "Enable motion detection.", name: "Detect" },
      { choices: [ { label: "High", value: "high" }, { label: "Low", value: "low" } ], default: false, defaultValue: "high", description: "Detection tier.",
        group: "Detect", multiple: true, name: "Tier" },
      { choices: [ { label: "High", value: "high" }, { label: "Low", value: "low" } ], default: false, defaultValue: "high", description: "Detection quality.",
        name: "Quality", style: "radio" }
    ]
  };

  const MOTION_CATEGORY: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];

  test("every derived map of the catalog index reads identically with and without the declarations", () => {

    const plain = buildCatalogIndex(MOTION_CATEGORY, PLAIN);
    const pickers = buildCatalogIndex(MOTION_CATEGORY, PICKERS);

    assert.deepEqual(pickers.defaults, plain.defaults, "defaults");
    assert.deepEqual(pickers.groupParents, plain.groupParents, "groupParents");
    assert.deepEqual(pickers.groups, plain.groups, "groups");
    assert.deepEqual(pickers.renderers, plain.renderers, "renderers");
    assert.deepEqual(pickers.scopes, plain.scopes, "scopes");
    assert.deepEqual(pickers.sortedValueOptionNames, plain.sortedValueOptionNames, "sortedValueOptionNames");
    assert.deepEqual(pickers.valueOptions, plain.valueOptions, "valueOptions");
  });

  test("resolution, storage, and value() answer identically with and without the declarations", () => {

    const configured = [ "Enable.Motion.Tier.dev1=low", "Disable.Motion.Detect" ];
    const plain = new FeatureOptions(MOTION_CATEGORY, structuredClone(PLAIN), [...configured]);
    const pickers = new FeatureOptions(MOTION_CATEGORY, structuredClone(PICKERS), [...configured]);

    assert.equal(pickers.value("Motion.Tier", "dev1"), plain.value("Motion.Tier", "dev1"), "a scoped value resolves the same");
    assert.equal(pickers.value("Motion.Tier"), plain.value("Motion.Tier"), "the global fallback resolves the same");
    assert.equal(pickers.scope("Motion.Tier", "dev1"), plain.scope("Motion.Tier", "dev1"), "the resolved scope is the same");
    assert.equal(pickers.test("Motion.Detect"), plain.test("Motion.Detect"), "a boolean beside it resolves the same");

    // The storage path is the other half: the entry a write composes reads the grammar alone, so a list value is one string to it like any other.
    pickers.setOption({ enabled: true, id: "dev2", option: "Motion.Tier", value: "high,low" });
    plain.setOption({ enabled: true, id: "dev2", option: "Motion.Tier", value: "high,low" });

    assert.deepEqual(pickers.configuredOptions, plain.configuredOptions, "the composed entries are identical");
  });
});

/* The list read is the Node-side counterpart of the browser's checkbox group: one call answers "what did the user pick here", with the wildcard expanded and the
 * device's own vocabulary applied. The rows below walk the three ways a domain can be settled - supplied by the caller, taken from an inline catalog list, or
 * absent entirely - because each one answers a different question about the same stored text.
 */
describe("FeatureOptions - valueList", () => {

  const LIST_CATEGORIES: FeatureCategoryEntry[] = [{ description: "Picker Options", name: "Pick" }];

  const INLINE_CHOICES = [ { label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" } ];

  const LIST_OPTIONS: Record<string, FeatureOptionEntry[]> = {

    Pick: [

      { choices: "sourced", default: true, defaultValue: "", description: "A source-backed multi-select.", multiple: true, name: "Sourced" },
      { choices: "sourced", default: true, defaultValue: "", description: "A source-backed single choice.", name: "SourcedSingle" },
      { choices: INLINE_CHOICES, default: true, defaultValue: "", description: "An inline multi-select.", multiple: true, name: "Inline" },
      { choices: INLINE_CHOICES, default: true, defaultValue: "", description: "An inline single choice.", name: "Single" },
      { choices: INLINE_CHOICES, default: true, defaultValue: ALL_CHOICES, description: "Everything by default.", multiple: true, name: "Everything" },
      { default: false, description: "An ordinary boolean.", name: "Toggle" },

      /* The substitution rows need a default that is neither empty nor the wildcard, since either of those reads the same whether the substitution happened or
       * not. The entries below declare a concrete one - a member of the inline list, a single choice, and a free-form comma list - so each row's expected value
       * could only have come from the default being substituted.
       */
      { choices: INLINE_CHOICES, default: true, defaultValue: "b", description: "An inline multi-select defaulting to one member.", multiple: true,
        name: "InlineDefault" },
      { choices: INLINE_CHOICES, default: true, defaultValue: "c", description: "An inline single choice with a default.", name: "SingleDefault" },
      { default: true, defaultValue: "x,y", description: "A free-form list with a default.", multiple: true, name: "FreeDefault" }
    ]
  };

  const DOMAIN = [ "a", "b", "c" ];

  const featureOptionsWith = (configured: string[]): FeatureOptions => new FeatureOptions(LIST_CATEGORIES, structuredClone(LIST_OPTIONS), configured);

  test("reads the empty list for an option that resolves to no value at all", () => {

    const disabled = featureOptionsWith(["Disable.Pick.Sourced"]);

    assert.deepEqual(disabled.valueList({ domain: DOMAIN, option: "Pick.Sourced" }), [], "a disabled option has no value to read");

    const bare = featureOptionsWith(["Enable.Pick.Sourced.dev1"]);

    assert.deepEqual(bare.valueList({ device: "dev1", domain: DOMAIN, option: "Pick.Sourced" }), [], "enabled at a scope with no value carries nothing");
    assert.deepEqual(bare.valueList({ domain: DOMAIN, option: "Pick.Nonexistent" }), [], "an option name the catalog does not carry");
    assert.deepEqual(bare.valueList({ domain: DOMAIN, option: "Pick.Toggle" }), [], "a boolean option is not value-centric");
  });

  test("reads a supplied domain in domain order, dropping what the device no longer offers", () => {

    const options = featureOptionsWith([ "Enable.Pick.Sourced.dev1=b,a", "Enable.Pick.Sourced.dev2=b,zzz" ]);

    assert.deepEqual(options.valueList({ device: "dev1", domain: DOMAIN, option: "Pick.Sourced" }), [ "a", "b" ], "domain order, not stored order");
    assert.deepEqual(options.valueList({ device: "dev2", domain: DOMAIN, option: "Pick.Sourced" }), ["b"], "a value outside the domain does not read as selected");
  });

  test("expands the all-choices default against the supplied domain when nothing is configured", () => {

    const options = featureOptionsWith([]);

    assert.deepEqual(options.valueList({ domain: DOMAIN, option: "Pick.Everything" }), DOMAIN, "the catalog default stands for the whole domain");
  });

  test("takes an inline catalog list as the domain when the caller supplies none", () => {

    const options = featureOptionsWith([ "Enable.Pick.Inline.dev1=b,a", "Enable.Pick.Single.dev1=b", "Enable.Pick.Single.dev2=zzz" ]);

    assert.deepEqual(options.valueList({ device: "dev1", option: "Pick.Inline" }), [ "a", "b" ], "the inline list answers as the domain");
    assert.deepEqual(options.valueList({ device: "dev1", option: "Pick.Single" }), ["b"], "a single choice reads as the one member it names");
    assert.deepEqual(options.valueList({ device: "dev2", option: "Pick.Single" }), [], "a single choice outside the list selects nothing");
  });

  test("reads a source-backed value as typed when no domain is available to read it against", () => {

    const options = featureOptionsWith([ "Enable.Pick.Sourced.dev1=b,a", "Enable.Pick.SourcedSingle.dev1=b" ]);

    assert.deepEqual(options.valueList({ device: "dev1", option: "Pick.Sourced" }), [ "b", "a" ], "stored order, since nothing here can reorder it");
    assert.deepEqual(options.valueList({ device: "dev1", option: "Pick.SourcedSingle" }), ["b"], "a single choice is the one value it stores");
  });

  test("substitutes the registered default for an option enabled with nothing stored, and only when the caller asks for it", () => {

    const options = featureOptionsWith([ "Enable.Pick.InlineDefault.dev1", "Enable.Pick.SingleDefault.dev1" ]);

    assert.deepEqual(options.valueList({ defaultWhenUnset: true, device: "dev1", option: "Pick.InlineDefault" }), ["b"],
      "the substituted default reads against the inline list exactly as a stored value would");
    assert.deepEqual(options.valueList({ defaultWhenUnset: true, device: "dev1", option: "Pick.SingleDefault" }), ["c"],
      "a single-valued option answers its default as the one member it names");
    assert.deepEqual(options.valueList({ device: "dev1", option: "Pick.InlineDefault" }), [],
      "the same read without the flag is the empty list, which is what every caller that does not ask still gets");
  });

  test("expands a substituted all-choices default against the supplied domain", () => {

    const options = featureOptionsWith(["Enable.Pick.Everything.dev1"]);

    assert.deepEqual(options.valueList({ defaultWhenUnset: true, device: "dev1", domain: DOMAIN, option: "Pick.Everything" }), DOMAIN,
      "a substituted wildcard runs the same expansion a stored one would");
    assert.deepEqual(options.valueList({ device: "dev1", domain: DOMAIN, option: "Pick.Everything" }), [],
      "and without the flag the scope's silence still names nothing");
  });

  test("the substitution reaches neither an emptied selection nor a disabled option", () => {

    // The resolutions that are not "enabled here, nothing given". An emptied list is a selection the user made rather than a value they omitted, so handing it
    // the default would hand back the one thing they said they did not want; a disabled option has no value to substitute for at all.
    const emptied = featureOptionsWith(["Enable.Pick.InlineDefault.dev1="]);

    assert.deepEqual(emptied.valueList({ defaultWhenUnset: true, device: "dev1", option: "Pick.InlineDefault" }), [],
      "an emptied selection stays empty with the flag set");

    const disabled = featureOptionsWith(["Disable.Pick.InlineDefault.dev1"]);

    assert.deepEqual(disabled.valueList({ defaultWhenUnset: true, device: "dev1", option: "Pick.InlineDefault" }), [],
      "a disabled option reads as nothing selected with the flag set");
  });

  test("substitutes a free-form list default and reads it through the list grammar", () => {

    const options = featureOptionsWith(["Enable.Pick.FreeDefault.dev1"]);

    assert.deepEqual(options.valueList({ defaultWhenUnset: true, device: "dev1", option: "Pick.FreeDefault" }), [ "x", "y" ],
      "with no domain to read it against, the substituted default parses as the list it is written as");
  });
});

// The enumeration is the supported alternative to a plugin scanning the configured-options array itself, so what it must prove is that it reads the SAME grammar
// the engine reads. These tests therefore walk the grammar's boundaries rather than its happy path: where the greedy prefix match lands, where the canonical form
// stops and the legacy form takes over, what case folding does and does not touch, and how much whitespace the delimiter tolerates.
describe("FeatureOptions - enumerateConfiguredEntries", () => {

  const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);

  // Fixture objects for the category-plus-entry composition path, written out rather than indexed off CATEGORIES / OPTIONS so the test reads without a non-null
  // assertion under noUncheckedIndexedAccess.
  const audioCategory: FeatureCategoryEntry = { description: "Audio Options", name: "Audio" };
  const volumeOption: FeatureOptionEntry = { default: false, defaultValue: 50, description: "Audio volume level.", name: "Volume" };

  test("yields one record per addressing entry, global and scoped, in the array's own order", () => {

    const configuredOptions = [ "Enable.Motion.Detect", "Enable.Audio.Mute", "Disable.Motion.Detect.ABC123" ];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "Motion.Detect" })], [

      { enabled: true, id: "" },
      { enabled: false, id: "ABC123" }
    ], "the global entry, then the scoped one, with the unrelated option's entry skipped");
  });

  test("a boolean option yields no value while a value option yields the value it carries", () => {

    const configuredOptions = [ "Enable.Motion.Detect.dev1", "Enable.Audio.Volume.dev1=75" ];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "Motion.Detect" })], [{ enabled: true, id: "dev1" }],
      "a boolean option's record carries no value property at all");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "Audio.Volume" })], [{ enabled: true, id: "dev1", value: "75" }],
      "a value option's record carries the value beside the scope");
  });

  test("reads the legacy dotted forms and the delimiter form alike", () => {

    const legacy = [ "Enable.Audio.Volume.50", "Enable.Audio.Volume.Kitchen.60" ];
    const canonical = [ "Enable.Audio.Volume=50", "Enable.Audio.Volume.Kitchen=60" ];
    const expected = [ { enabled: true, id: "", value: "50" }, { enabled: true, id: "Kitchen", value: "60" } ];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: legacy, option: "Audio.Volume" })], expected,
      "the legacy dot grammar reads as a global value and an id-plus-value pair");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: canonical, option: "Audio.Volume" })], expected,
      "the canonical delimiter form reads identically - one grammar, two spellings");
  });

  test("matching folds case while the yielded records keep the casing the entry was written in", () => {

    const configuredOptions = ["ENABLE.audio.VOLUME.KiTcHeN=Loud"];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "AuDiO.vOlUmE" })], [{ enabled: true, id: "KiTcHeN", value: "Loud" }],
      "the option lookup folds case, and the identifier and value come back exactly as the user typed them");
  });

  test("whitespace around the delimiter is tolerated, exactly as the engine tolerates it", () => {

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: ["Enable.Audio.Volume.Kitchen = 50"], option: "Audio.Volume" })],
      [{ enabled: true, id: "Kitchen", value: "50" }], "a hand-spaced entry reads as the tight form the composer writes");
  });

  test("an empty payload yields an empty value, distinct from a bare enable that yields none", () => {

    // The canonical / legacy boundary. `Enable.Audio.Volume=` is the shape whose payload carries nothing, which the engine registers as an empty value; a bare
    // `Enable.Audio.Volume` never reaches the value grammar at all; and a legacy dotted tail is a value like any other. Three spellings, three distinct records.
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: ["Enable.Audio.Volume="], option: "Audio.Volume" })],
      [{ enabled: true, id: "", value: "" }], "an empty payload is a value that happens to be empty");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: ["Enable.Audio.Volume"], option: "Audio.Volume" })],
      [{ enabled: true, id: "" }], "a bare enable carries no value property");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: ["Enable.Audio.Volume.50"], option: "Audio.Volume" })],
      [{ enabled: true, id: "", value: "50" }], "a legacy dotted tail is the value");
  });

  test("the greedy longest-prefix match decides which option an entry belongs to", () => {

    // Both "Audio" and "Audio.Volume" are value-centric here, so `Enable.Audio.Volume.50` is ambiguous on its face. The engine resolves it to the longer option,
    // and the enumeration must agree: the entry is Audio.Volume carrying 50, and it says nothing whatsoever about Audio - not even Audio at a scope named
    // "Volume", which is the reading a naive prefix scan would invent.
    const nested = buildCatalogIndex([{ description: "Audio", name: "Audio" }], {

      Audio: [

        { default: false, defaultValue: 10, description: "Audio top-level value.", name: "" },
        { default: false, defaultValue: 50, description: "Audio volume sub-value.", name: "Volume" }
      ]
    });
    const configuredOptions = ["Enable.Audio.Volume.50"];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog: nested, configuredOptions, option: "Audio.Volume" })], [{ enabled: true, id: "", value: "50" }],
      "the longer option name claims the entry");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog: nested, configuredOptions, option: "Audio" })], [],
      "the shorter option is not configured by an entry the longer one claimed");
  });

  test("a raw tail carrying the delimiter never reads as a scope", () => {

    // The composer ends an address at the first "=", so no id it writes can hold the delimiter. That decides what the raw tail of a canonical value entry says
    // about a shorter option: `Enable.Device.Name=Foo` is the Device.Name option carrying "Foo", and it is not the Device option at a scope named "Name=Foo",
    // because no configuration can express that scope in the first place.
    const deviceCatalog = buildCatalogIndex([{ description: "Device Options", name: "Device" }], {

      Device: [

        { default: false, description: "Device top-level toggle.", name: "" },
        { default: false, defaultValue: "unnamed", description: "Device name override.", name: "Name" }
      ]
    });

    assert.deepEqual([...enumerateConfiguredEntries({ catalog: deviceCatalog, configuredOptions: ["Enable.Device.Name=Foo"], option: "Device" })], [],
      "a delimiter-bearing raw tail is not a scope of the shorter option");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog: deviceCatalog, configuredOptions: ["Enable.Device.Name=Foo"], option: "Device.Name" })],
      [{ enabled: true, id: "", value: "Foo" }], "the entry is the value option's global value");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog: deviceCatalog, configuredOptions: ["Enable.Device.Name.SERIAL=Foo"], option: "Device" })], [],
      "the scoped value form says nothing about the shorter option either");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog: deviceCatalog, configuredOptions: ["Enable.Device.Name.SERIAL=Foo"], option: "Device.Name" })],
      [{ enabled: true, id: "SERIAL", value: "Foo" }], "the scoped value form still yields the id it carries");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: ["Enable.Motion.Detect.abc=def"], option: "Motion.Detect" })], [],
      "a delimiter-bearing tail on a boolean option is an address the composer cannot write either");
  });

  test("a catalog option name is never read as a scope of a shorter option", () => {

    // "Motion.Detect" is an option in its own right, so `Enable.Motion.Detect` cannot be the "Motion" option at a scope named "Detect" - and there is no "Motion"
    // option here at all, which is the ordinary case a plugin hits when its category name is a prefix of its option names.
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: ["Enable.Motion.Detect"], option: "Motion" })], [],
      "the catalog settles the ambiguity that the raw string alone cannot");
  });

  test("an option nobody configured, an unparseable entry, and an empty option name each yield nothing", () => {

    const configuredOptions = [ "Enable.Motion.Detect", "Toggle.Audio.Volume", "NotAnEntry" ];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "Network.Mtu" })], [], "an unconfigured option yields no records");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "Audio.Volume" })], [],
      "an unknown action and a dotless string are not entries the grammar accepts");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "" })], [], "an empty option name addresses nothing");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, category: "", configuredOptions, option: "Volume" })], [],
      "an empty category composes to an empty option name, which addresses nothing");
  });

  test("a category composes with an option exactly as expandOption composes them", () => {

    const configuredOptions = ["Enable.Audio.Volume.Kitchen=50"];
    const expected = [{ enabled: true, id: "Kitchen", value: "50" }];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, category: "Audio", configuredOptions, option: "Volume" })], expected,
      "category and option as plain strings");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, category: audioCategory, configuredOptions, option: volumeOption })], expected,
      "category and option as catalog entry objects");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: expandOption(audioCategory, volumeOption) })], expected,
      "the expanded name on its own, with no category supplied");
  });

  test("without a category, an option entry is read as the expanded name it is not", () => {

    // The trap on the composition path, worth stating because it fails quietly: omitting the category means whatever `option` carries IS the expanded name, and a
    // catalog entry's name is the bare option name rather than the expanded one. Supply the category, or expand first.
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions: ["Enable.Audio.Volume=50"], option: volumeOption })], [],
      "a bare \"Volume\" addresses nothing - the catalog names this option \"Audio.Volume\"");
  });

  test("duplicate entries each yield a record - precedence is resolveScope's question, not this one", () => {

    const configuredOptions = [ "Disable.Motion.Detect", "Enable.Motion.Detect" ];

    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "Motion.Detect" })], [

      { enabled: false, id: "" },
      { enabled: true, id: "" }
    ], "both entries the user wrote are reported; the first-write-wins rule belongs to the lookup index");
  });
});

/* One question settles every scoped address the engine handles: does this key name a scope of this option, or does it name a different option outright? The rows
 * below put that question to every side of it - the composer that builds an address, the writers that refuse one they cannot assign, and the readers that
 * pass over one belonging elsewhere - because any two of them answering differently is the state the arbitration exists to rule out.
 */
describe("FeatureOptions - scope addressing", () => {

  // A catalog whose shorter option name prefixes a longer one, which is the shape a plugin lands on whenever it hangs a sub-option off a parent toggle. Neither
  // entry declares scopes, so every level is reachable and what the rows exercise is the arbitration itself rather than a scope restriction standing in for it.
  const COLLIDING_CATEGORIES: FeatureCategoryEntry[] = [{ description: "Motion Options", name: "Motion" }];

  const COLLIDING_OPTIONS: Record<string, FeatureOptionEntry[]> = {

    Motion: [

      { default: true, description: "Enable motion detection.", name: "Detect" },
      { default: false, description: "Detection sensitivity.", name: "Detect.Sensitivity" }
    ]
  };

  const COLLISION_REFUSAL = /"Sensitivity" cannot address a scope of "Motion\.Detect", because "Motion\.Detect\.Sensitivity" is a feature option in its own right/;

  describe("isValidScopeId", () => {

    test("answers the identifier rule: non-empty, and carrying neither a period nor an equals sign", () => {

      assert.equal(isValidScopeId("home-263d11d4"), true, "a dash-joined hex identifier");
      assert.equal(isValidScopeId("27"), true, "a bare device number");
      assert.equal(isValidScopeId(""), false, "an empty string names no scope at all");
      assert.equal(isValidScopeId("home.263d11d4"), false, "a period separates address segments");
      assert.equal(isValidScopeId("a=b"), false, "the first equals sign ends the address");
    });

    test("answers false for every part the composer turns away, and accepts the pair it composes", () => {

      // The screen a consumer runs and the throw the composer raises have to read the same string the same way, or a plugin that screens first still meets the
      // throw it screened to avoid. Every part the composer's own rows reject is asserted here against the predicate directly.
      for(const part of [ "home.263d11d4", "2.7", "a=b", "" ]) {

        assert.equal(isValidScopeId(part), false, "the composer rejects \"" + part + "\", so the screen must too");
      }

      assert.equal(isValidScopeId("home-263d11d4") && isValidScopeId("27"), true, "the pair the composer accepts passes the screen");
      assert.doesNotThrow(() => composeScopeId("home-263d11d4", "27"), "a pair the screen accepts composes without throwing");
    });
  });

  describe("scopeSafeId", () => {

    test("replaces each reserved character wherever it appears", () => {

      assert.equal(scopeSafeId("home.263d"), "home-263d", "a period is what the address grammar reads as its own segment separator");
      assert.equal(scopeSafeId("a=b.c"), "a-b-c", "an equals sign ends an address, so both reserved characters are replaced");
      assert.equal(scopeSafeId("a..b==c"), "a--b--c", "every occurrence is replaced, not merely the first of each");
    });

    test("passes an already-usable identifier through unchanged, and cannot invent one from empty", () => {

      // Answering an already-usable identifier byte-identical is what lets a plugin adopt the repair without moving a single address its users have configured.
      assert.equal(scopeSafeId("home-263d11d4"), "home-263d11d4", "an identifier the rule already accepts is answered character for character");
      assert.equal(scopeSafeId(""), "", "no substitution can invent an identifier from an empty string");
      assert.equal(isValidScopeId(scopeSafeId("")), false, "so the predicate stays the usability check after the repair, rather than being made redundant by it");
    });

    test("a sanitized identifier satisfies the predicate and composes", () => {

      // The repair and the rule it repairs against read one statement of the reserved set, so anything the repair answers has to pass the screen. A repair that
      // left a reserved character behind would fail here, and would compose nothing at all below - the composer throws rather than answering a value.
      for(const input of [ "home.263d", "a=b.c", "...=" ]) {

        assert.equal(isValidScopeId(scopeSafeId(input)), true, "the repair of \"" + input + "\" has to satisfy the screen");
      }

      assert.equal(composeScopeId(scopeSafeId("home.263d"), "27"), "home-263d-27", "the repaired part leads, then the device, joined by the composer's own separator");
    });
  });

  describe("composeScopeId", () => {

    test("joins a controller and a device into the identifier a hand-rolled join composes byte for byte", () => {

      // The literal a consuming plugin already composes by hand for a hub-scoped device. The composer has to answer with exactly this string, or adopting it
      // re-scopes every option that plugin's users have configured.
      assert.equal(composeScopeId("home-263d11d4", "27"), "home-263d11d4-27");
    });

    test("refuses either part when it cannot serve as an identifier segment, naming the part it turned away", () => {

      assert.throws(() => composeScopeId("home.263d11d4", "27"), /controller part "home\.263d11d4"/, "a period in the controller part");
      assert.throws(() => composeScopeId("home-263d11d4", "2.7"), /device part "2\.7"/, "a period in the device part");
      assert.throws(() => composeScopeId("home-263d11d4", "a=b"), /device part "a=b"/, "the payload delimiter in the device part");
      assert.throws(() => composeScopeId("", "27"), /controller part ""/, "an empty controller part");
    });

    test("names the controller when neither part is usable, the order the parts take in the composed value", () => {

      // Both parts are unusable here, so the row pins which one the single message names. A composer that checked the device first would answer with the device
      // part instead, which is the reading this rules out.
      assert.throws(() => composeScopeId("", "a=b"), /controller part ""/, "the part that comes first in the composed value is the part the caller hears about");
    });
  });

  test("a composed identifier round-trips through the writer, the resolver, and the enumerator alike", () => {

    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const id = composeScopeId("home-263d11d4", "27");
    const configuredOptions = applySetOption({ args: { enabled: true, id, option: "Motion.Detect" }, catalog, configuredOptions: [] });

    assert.deepEqual(configuredOptions, ["Enable.Motion.Detect.home-263d11d4-27"]);
    assert.equal(resolveScope({ catalog, configIndex: buildConfigIndex(catalog, configuredOptions), device: id, option: "Motion.Detect" }).scope, "device");
    assert.deepEqual([...enumerateConfiguredEntries({ catalog, configuredOptions, option: "Motion.Detect" })], [{ enabled: true, id }],
      "the enumerator reports the same address the writer composed and the resolver matched");
  });

  test("a present id carrying a reserved character is refused by both writers", () => {

    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const configuredOptions = ["Enable.Motion.Detect"];
    const dotted = /"foo\.bar" cannot address a scope of "Motion\.Detect", because a scope identifier must be a non-empty string/;
    const delimited = /"a=b" cannot address a scope of "Motion\.Detect", because a scope identifier must be a non-empty string/;

    assert.throws(() => applySetOption({ args: { enabled: true, id: "foo.bar", option: "Motion.Detect" }, catalog, configuredOptions }), dotted);
    assert.throws(() => applySetOption({ args: { enabled: true, id: "a=b", option: "Motion.Detect" }, catalog, configuredOptions }), delimited);
    assert.throws(() => applyClearOption({ args: { id: "foo.bar", option: "Motion.Detect" }, catalog, configuredOptions }), dotted);
    assert.throws(() => applyClearOption({ args: { id: "a=b", option: "Motion.Detect" }, catalog, configuredOptions }), delimited);
    assert.deepEqual(configuredOptions, ["Enable.Motion.Detect"], "a refused write leaves the array it was handed exactly as it found it");
  });

  test("a write whose id composes another catalog option's own address is refused, and that option's entry survives", () => {

    const catalog = buildCatalogIndex(COLLIDING_CATEGORIES, COLLIDING_OPTIONS);
    const configuredOptions = ["Enable.Motion.Detect.Sensitivity"];

    assert.throws(() => applySetOption({ args: { enabled: false, id: "Sensitivity", option: "Motion.Detect" }, catalog, configuredOptions }), COLLISION_REFUSAL);
    assert.deepEqual(configuredOptions, ["Enable.Motion.Detect.Sensitivity"], "the longer option's own global entry is untouched");
  });

  test("a clear whose id composes another catalog option's own address is refused rather than deleting that option's entry", () => {

    // The data-loss shape this rules out: taken literally, clearing "Motion.Detect at a scope named Sensitivity" filters out the entry that IS the
    // Motion.Detect.Sensitivity option, so a gesture aimed at one option erases another one's setting with nothing on screen to show for it.
    const catalog = buildCatalogIndex(COLLIDING_CATEGORIES, COLLIDING_OPTIONS);
    const configuredOptions = ["Enable.Motion.Detect.Sensitivity"];

    assert.throws(() => applyClearOption({ args: { id: "Sensitivity", option: "Motion.Detect" }, catalog, configuredOptions }), COLLISION_REFUSAL);
    assert.deepEqual(configuredOptions, ["Enable.Motion.Detect.Sensitivity"], "the entry the clear would have deleted is still there");
  });

  test("a key the catalog claims for another option is not readable as a scope of the shorter one", () => {

    const catalog = buildCatalogIndex(COLLIDING_CATEGORIES, COLLIDING_OPTIONS);
    const configIndex = buildConfigIndex(catalog, ["Enable.Motion.Detect.Sensitivity"]);

    assert.equal(resolveScope({ catalog, configIndex, device: "Sensitivity", option: "Motion.Detect" }).scope, "none",
      "the device lookup passes over a key belonging to the longer option, and the walk lands on the catalog default");
    assert.equal(resolveScope({ catalog, configIndex, option: "Motion.Detect.Sensitivity" }).scope, "global", "the entry is the longer option's global setting");
    assert.equal(optionExists({ catalog, configIndex, id: "Sensitivity", option: "Motion.Detect" }), false, "the existence probe agrees with the resolver");
    assert.equal(optionExists({ catalog, configIndex, option: "Motion.Detect.Sensitivity" }), true, "while the longer option reads configured at global scope");
  });

  test("the controller lookup arbitrates on the same terms the device lookup does", () => {

    const catalog = buildCatalogIndex(COLLIDING_CATEGORIES, COLLIDING_OPTIONS);
    const configIndex = buildConfigIndex(catalog, ["Enable.Motion.Detect.Sensitivity"]);

    assert.equal(resolveScope({ catalog, configIndex, controller: "Sensitivity", option: "Motion.Detect" }).scope, "none",
      "a controller id spelling the longer option's trailing segment reads no differently than a device id does");
  });

  test("an ordinary id under the colliding catalog writes, resolves, and clears for both options", () => {

    // The control an over-broad check fails: the catalog shape that makes the collision expressible is common and deliberate, so every ordinary device id under
    // it has to keep working for the parent option and the child alike.
    const catalog = buildCatalogIndex(COLLIDING_CATEGORIES, COLLIDING_OPTIONS);

    for(const option of [ "Motion.Detect", "Motion.Detect.Sensitivity" ]) {

      const written = applySetOption({ args: { enabled: true, id: "dev1", option }, catalog, configuredOptions: [] });
      const configIndex = buildConfigIndex(catalog, written);

      assert.deepEqual(written, ["Enable." + option + ".dev1"], option + " writes its scoped entry");
      assert.equal(resolveScope({ catalog, configIndex, device: "dev1", option }).scope, "device", option + " resolves at device scope");
      assert.equal(optionExists({ catalog, configIndex, id: "dev1", option }), true, option + " reads as configured there");
      assert.deepEqual(applyClearOption({ args: { id: "dev1", option }, catalog, configuredOptions: written }), [], option + " clears cleanly");
    }
  });

  test("an entry left behind by an option the catalog no longer declares still resolves at its scope", () => {

    // Written as a raw entry rather than through the writer, because what this pins is a configuration that outlived its option: nothing in the catalog claims
    // the key, so the arbitration has nothing to assign it elsewhere and the read lands exactly where it always did.
    const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
    const configIndex = buildConfigIndex(catalog, ["Enable.Retired.Feature.dev1"]);
    const resolved = resolveScope({ catalog, configIndex, device: "dev1", option: "Retired.Feature" });

    assert.equal(resolved.scope, "device", "a stale option's scoped entry resolves as it always has");
    assert.equal(resolved.enabled, true);
    assert.equal(optionExists({ catalog, configIndex, id: "dev1", option: "Retired.Feature" }), true, "and the existence probe reads it too");
  });
});
