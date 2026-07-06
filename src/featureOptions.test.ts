/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions.test.ts: Unit tests for the hierarchical FeatureOptions system - the O(1) config lookup index, the global / controller / device scope resolution
 * precedence, value-centric option parsing, grouping, scope visualization (color), and the supporting helpers (expandOption, isValue, exists, getInteger, getFloat).
 *
 * Coverage focuses on behavior that is hard to see from reading the class alone: the greedy longest-prefix match used when value-centric option names overlap, the
 * first-write-wins rule for duplicate entries in configuredOptions, the scope hierarchy's "device overrides controller overrides global overrides default" contract,
 * and the edge-case surfaces of `value()` (null, undefined, fallback-to-default).
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptionFormatter } from "./featureOptions.ts";
import { applyClearOption, applySetOption, buildCatalogIndex, buildConfigIndex, expandOption, getDefaultValue, isDependencyMet, isValueOption,
  optionExists, resolveScope } from "./featureOptions.ts";
import { describe, test } from "node:test";
import { FeatureOptions } from "./featureOptions.ts";
import assert from "node:assert/strict";
import { capturingLog } from "./testing.helpers.ts";
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

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.75"]);
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

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.ABC123.75"]);
    assert.equal(fo.value("Audio.Volume", "ABC123"), "75");
  });

  test("replaces any prior entry for the same option-at-scope rather than accumulating duplicates", () => {

    // The set-as-replace semantic is core to why the renderer can stop tracking what was previously written. The model owns the prior-state drop end-to-end.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS, [ "Enable.Audio.Volume.ABC123.10", "Disable.Audio.Volume.ABC123" ]);

    fo.setOption({ enabled: true, id: "ABC123", option: "Audio.Volume", value: 50 });

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.ABC123.50"], "prior scoped entries for the same option must be removed before the new one is written");
  });

  test("a prior entry at a different scope is preserved when setOption writes a different scope", () => {

    // The scope discriminator is part of the addressing - setting ABC123 must not affect XYZ789.
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

    assert.deepEqual(fo.configuredOptions, ["Enable.Audio.Volume.XYZ789.30"], "only entries addressing the target scope are removed");
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

    assert.deepEqual(fo.configuredOptions, [ "Enable.Audio.10", "Enable.Volume.75" ],
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
    // value options) is invariant. We assert this indirectly by mutating a deep object the catalog rebuild would replace, then verifying it survives a config
    // mutation.
    const fo = new FeatureOptions(CATEGORIES, OPTIONS);
    const groupsBefore = fo.groups;

    fo.setOption({ enabled: false, option: "Motion.Detect" });

    assert.equal(fo.groups, groupsBefore, "the groups reference must be the same object after a config mutation - the catalog was not rebuilt");
  });
});

describe("FeatureOptions - browser-safe runtime-import boundary", () => {

  // Regression guard for the `dist/ui` shipping pipeline. `featureOptions.ts` compiles into `dist/featureOptions.js`, which the `copyFeatureOptions` build step copies
  // to `dist/ui/featureOptions.js` for the browser to load. Every relative value-import in `featureOptions.ts` therefore has to resolve - at browser runtime - to a
  // sibling file that the build step ALSO copies into `dist/ui/`. Importing from `./util.ts` is the canonical violation: `util.ts` is server-side (drags in
  // `node:timers/promises`) and the build pipeline does not ship it next to the orchestrator. This test reads the source file and asserts every relative
  // value-import points at a module on the allowlist - currently just `./formatters.ts`, the one browser-safe module the pipeline mirrors alongside
  // `featureOptions.js`. Adding a new relative value-import to featureOptions.ts means EITHER pointing it at another browser-safe module that copyFeatureOptions
  // ALSO ships, OR widening the allowlist here intentionally and wiring the new artifact through the build step.

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
        "). Found: " + specifier + ". If this is a new browser-safe module, add it here AND to build/fs-ops.mjs's copyFeatureOptions step.");
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

      assert.deepEqual(after, ["Enable.Audio.Volume.ABC123.75"]);
    });

    test("drops any prior entry addressing the same option-at-scope before appending the new entry", () => {

      const catalog = buildCatalogIndex(CATEGORIES, OPTIONS);
      const before = [ "Enable.Audio.Volume.ABC123.50", "Enable.Motion.Detect" ];
      const after = applySetOption({ args: { enabled: false, id: "ABC123", option: "Audio.Volume" }, catalog, configuredOptions: before });

      assert.deepEqual(after, [ "Enable.Motion.Detect", "Disable.Audio.Volume.ABC123" ]);
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

      assert.equal(optionExists({ configIndex, id: "dev1", option: "Motion.Detect" }), true);
      assert.equal(optionExists({ configIndex, option: "Motion.Detect" }), false, "device-scoped entry does not satisfy global-scope existence");
      assert.equal(optionExists({ configIndex, id: "dev2", option: "Motion.Detect" }), false);
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
