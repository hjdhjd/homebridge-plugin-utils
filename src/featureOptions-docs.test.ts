/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions-docs.test.ts: Unit tests for the shared Feature Options documentation renderer - the catalog-to-markdown projection
 * (renderFeatureOptionsReference).
 *
 * Coverage focuses on the contract that is hard to see from the code alone: the index/detail structure, the per-row deep-link anchors, the value/toggle distinction
 * signaled by the "=<value>" placeholder, the raw (never formatted) default cell with its empty-string -> "none" substitution proven non-mutating, the two scope
 * hooks (string inserted, `undefined` omitted cleanly), and the category-level bare-key option. The canonical worked example is reproduced verbatim as the
 * contract test.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptionScope } from "./featureOptions.ts";
import { buildComposedScopeDescribers, buildFixedScopeDescribers, renderFeatureOptionsReference } from "./featureOptions-docs.ts";
import { describe, test } from "node:test";
import { ALL_CHOICES } from "./featureOptions.ts";
import assert from "node:assert/strict";

// Reusable category / option fixtures. The "Audio / Nvr" shape is the canonical worked example; the "Cfg" shape isolates the empty-default and category-level
// option edge cases without the noise of the worked example's two-category layout.
const WORKED_CATEGORIES: FeatureCategoryEntry[] = [ { description: "Audio", name: "Audio" }, { description: "Recording", name: "Nvr" } ];

const WORKED_OPTIONS: Record<string, FeatureOptionEntry[]> = {

  Audio: [

    { default: true, description: "Audio support.", name: "" },
    { default: false, description: "Two-way audio.", name: "TwoWay" }
  ],

  Nvr: [

    { default: true, defaultValue: 10, description: "Days of recordings to retain.", name: "Recording.Retention" }
  ]
};

// The canonical worked-example output, reproduced exactly as the renderer emits it. The printed whitespace here is illustrative only and the column padding is
// cosmetic, not part of the semantic contract; the renderer's column math sizes each table to its own widest cell, so the Nvr table aligns consistently rather than
// matching a hand-typed (and internally inconsistent) Nvr spacing. Every semantic line - the bullets, the anchors, the value/toggle key cells, the raw defaults -
// is the contract this fixture asserts.
const WORKED_OUTPUT = [

  " * [Audio](#audio): Audio",
  " * [Nvr](#nvr): Recording",
  "",
  "Options whose key ends in `=<value>` take a value - replace `=<value>` with your setting; all other options are simple on/off toggles. The default shown for each " +
    "option is what applies when you leave it unset.",
  "",
  "#### <A NAME=\"audio\"></A>Audio",
  "",
  "| Option                                     | Description",
  "|--------------------------------------------|-------------------------------------------------------------",
  "| <A NAME=\"Audio\"></A>`Audio`                | Audio support. **(default: enabled)**.",
  "| <A NAME=\"Audio.TwoWay\"></A>`Audio.TwoWay`  | Two-way audio. **(default: disabled)**.",
  "",
  "#### <A NAME=\"nvr\"></A>Recording",
  "",
  "| Option                                                                   | Description",
  "|--------------------------------------------------------------------------|-------------------------------------------------------------",
  "| <A NAME=\"Nvr.Recording.Retention\"></A>`Nvr.Recording.Retention=<value>`  | Days of recordings to retain. **(default: 10)**.",
  ""
].join("\n");

describe("renderFeatureOptionsReference - worked example (the contract)", () => {

  test("reproduces the canonical output for the worked-example input", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    assert.equal(output, WORKED_OUTPUT);
  });

  test("the Audio table aligns byte-for-byte with its expected printed spacing", () => {

    // The Audio table is rendered with internally consistent padding, so it is a byte-exact fixture independent of the full-output assertion above.
    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    assert.ok(output.includes("| <A NAME=\"Audio\"></A>`Audio`                | Audio support. **(default: enabled)**."));
    assert.ok(output.includes("| <A NAME=\"Audio.TwoWay\"></A>`Audio.TwoWay`  | Two-way audio. **(default: disabled)**."));
  });
});

describe("renderFeatureOptionsReference - index pass", () => {

  test("emits one bullet per category deep-linking to its lowercased anchor with the description verbatim", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });
    const lines = output.split("\n");

    assert.equal(lines[0], " * [Audio](#audio): Audio");
    assert.equal(lines[1], " * [Nvr](#nvr): Recording");
  });

  test("separates the index from the legend and detail with single blank lines", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });
    const lines = output.split("\n");

    // The two index bullets, exactly one blank line, the value-notation legend (the worked example has a value option), one blank line, then the first detail heading.
    assert.equal(lines[2], "");
    assert.ok(lines[3]?.startsWith("Options whose key ends in `=<value>`"));
    assert.equal(lines[4], "");
    assert.equal(lines[5], "#### <A NAME=\"audio\"></A>Audio");
  });

  test("skips a category that has no entry in the options map, in both the index and the detail", () => {

    // An orphan category (declared for future expansion, no options yet) must not produce a bullet or a detail section - matching buildCatalogIndex's skip rule.
    const categories = [ ...WORKED_CATEGORIES, { description: "Orphan", name: "Orphan" } ];
    const output = renderFeatureOptionsReference({ categories, options: WORKED_OPTIONS });

    assert.ok(!output.includes("Orphan"));
    assert.ok(!output.includes("#orphan"));
  });
});

describe("renderFeatureOptionsReference - detail headings and anchors", () => {

  test("emits a heading carrying an invisible lowercased anchor and the verbatim description", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    assert.ok(output.includes("#### <A NAME=\"audio\"></A>Audio"));
    assert.ok(output.includes("#### <A NAME=\"nvr\"></A>Recording"));
  });

  test("emits a per-row anchor with the case-preserved key immediately before the key code span", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    // The anchor preserves the catalog casing so deep links are stable; the code span follows immediately.
    assert.ok(output.includes("<A NAME=\"Audio.TwoWay\"></A>`Audio.TwoWay`"));
    assert.ok(output.includes("<A NAME=\"Nvr.Recording.Retention\"></A>`Nvr.Recording.Retention=<value>`"));
  });
});

describe("renderFeatureOptionsReference - default cell and value/toggle distinction", () => {

  test("renders an enabled toggle default as \"enabled\" and a disabled toggle as \"disabled\"", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    assert.ok(output.includes("Audio support. **(default: enabled)**."));
    assert.ok(output.includes("Two-way audio. **(default: disabled)**."));
  });

  test("renders a value option with the =<value> placeholder and its raw declared default", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    // The "=<value>" suffix is the lexical signal of value-ness; the default is the raw "10", never formatted.
    assert.ok(output.includes("`Nvr.Recording.Retention=<value>`"));
    assert.ok(output.includes("Days of recordings to retain. **(default: 10)**."));
  });

  test("does not append the =<value> placeholder to a plain toggle option", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    // A toggle's key span must be the bare key with no placeholder suffix.
    assert.ok(output.includes("`Audio.TwoWay`"));
    assert.ok(!output.includes("`Audio.TwoWay=<value>`"));
  });

  test("substitutes an empty-string default to \"none\" at render time without mutating the entry", () => {

    // A value option whose declared default is the empty string renders "none" - communicating "defaults to no value" rather than an empty cell. The substitution must
    // be render-only: the caller's entry is unchanged afterward.
    const categories: FeatureCategoryEntry[] = [{ description: "Configuration", name: "Cfg" }];
    const entry: FeatureOptionEntry = { default: false, defaultValue: "", description: "A path.", name: "Path" };
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [entry] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("A path. **(default: none)**."));
    assert.equal(entry.defaultValue, "", "the renderer must not mutate the input entry's defaultValue");
  });

  test("treats a value option declared with an undefined defaultValue as value-centric, rendering \"none\"", () => {

    // The defaultValue key is present (so the option is value-centric and gets the =<value> placeholder) but its value is undefined; the default cell collapses to
    // "none" via the same empty-default path.
    const categories: FeatureCategoryEntry[] = [{ description: "Configuration", name: "Cfg" }];
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [{ default: false, defaultValue: undefined, description: "Token.", name: "Token" }] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("`Cfg.Token=<value>`"));
    assert.ok(output.includes("Token. **(default: none)**."));
  });

  test("renders a numeric zero default as \"0\", not the empty-string substitution", () => {

    // The empty-default substitution keys on the empty string specifically; a real zero default is a legitimate value and must render as "0".
    const categories: FeatureCategoryEntry[] = [{ description: "Tuning", name: "Tuning" }];
    const options: Record<string, FeatureOptionEntry[]> = { Tuning: [{ default: true, defaultValue: 0, description: "Offset.", name: "Offset" }] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("Offset. **(default: 0)**."));
    assert.ok(!output.includes("(default: none)"));
  });

  test("words a multi-select's all-choices default as \"all\" without mutating the entry", () => {

    // The all-choices default stands for every member of a domain the catalog cannot enumerate, so printing the character itself would leave a reader with
    // nothing to look it up against. Like the empty-default substitution, this is render-only.
    const categories: FeatureCategoryEntry[] = [{ description: "Detection", name: "Motion" }];
    const entry: FeatureOptionEntry = { choices: "smartDetectTypes", default: true, defaultValue: ALL_CHOICES, description: "Detected object types.",
      multiple: true, name: "Types" };
    const options: Record<string, FeatureOptionEntry[]> = { Motion: [entry] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("Detected object types. **(default: all)**."));
    assert.equal(entry.defaultValue, ALL_CHOICES, "the renderer must not mutate the input entry's defaultValue");
  });

  test("renders a multi-select's plain list default verbatim, as the user would type it", () => {

    // Only the reserved spelling is worded. An ordinary list default is a value a user would type into their configuration and prints exactly as declared.
    const categories: FeatureCategoryEntry[] = [{ description: "Detection", name: "Motion" }];
    const options: Record<string, FeatureOptionEntry[]> = {

      Motion: [{ choices: [ { label: "Person", value: "person" }, { label: "Vehicle", value: "vehicle" } ], default: true, defaultValue: "person,vehicle",
        description: "Detected object types.", multiple: true, name: "Types" }]
    };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("Detected object types. **(default: person,vehicle)**."));
    assert.ok(!output.includes("(default: all)"), "the wording is reserved for the all-choices spelling alone");
  });
});

describe("renderFeatureOptionsReference - category-level option", () => {

  test("renders the bare category key for an option with an empty name", () => {

    // expandOption returns the category name alone for an empty-named option, so the key cell is the bare category key - both in the anchor and the code span.
    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    assert.ok(output.includes("<A NAME=\"Audio\"></A>`Audio`"));
    assert.ok(!output.includes("`Audio.`"));
  });
});

describe("renderFeatureOptionsReference - cell escaping", () => {

  test("escapes a category description containing a pipe and angle brackets in both the index and the heading", () => {

    // A category description carrying markdown-significant characters must be neutralized so it cannot inject a phantom table column ("|") or be swallowed as markup
    // ("<...>"). The escaping applies to the description text in both the index bullet and the detail heading; the category name and anchor are left untouched.
    const categories: FeatureCategoryEntry[] = [{ description: "A | B <tag>", name: "Cfg" }];
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [{ default: true, description: "X.", name: "" }] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes(" * [Cfg](#cfg): A \\| B &lt;tag&gt;"));
    assert.ok(output.includes("#### <A NAME=\"cfg\"></A>A \\| B &lt;tag&gt;"));
  });

  test("escapes a pipe in an option description", () => {

    // An option description's pipe would otherwise split the row into an extra column; it must render as the escaped "\|".
    const categories: FeatureCategoryEntry[] = [{ description: "Configuration", name: "Cfg" }];
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [{ default: true, description: "Either A | B.", name: "Mode" }] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("Either A \\| B. **(default: enabled)**."));
  });

  test("passes a scope-hook return containing markup through verbatim without escaping", () => {

    // The scope hook is plugin-owned markup - a "<BR>" line break is intentional HTML the plugin controls - so it must pass through unescaped. Escaping it would break
    // the plugin's own rendering (e.g. Protect's device-scope suffixes).
    const categories: FeatureCategoryEntry[] = [{ description: "Configuration", name: "Cfg" }];
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [{ default: true, description: "X.", name: "Mode" }] };
    const output = renderFeatureOptionsReference({

      categories,
      describeOptionScope: (): string => " <BR>*A note.*",
      options
    });

    assert.ok(output.includes("X. **(default: enabled)**. <BR>*A note.*"));
    assert.ok(!output.includes("&lt;BR&gt;"));
  });

  test("escapes a pipe in a value option's rendered default", () => {

    // The rendered default is catalog-derived plain text; a pipe inside it must be escaped just like a description so the table column count is preserved.
    const categories: FeatureCategoryEntry[] = [{ description: "Configuration", name: "Cfg" }];
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [{ default: true, defaultValue: "a|b", description: "Pattern.", name: "Pattern" }] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("Pattern. **(default: a\\|b)**."));
  });

  test("does not entity-escape the dotted key", () => {

    // The key is a constrained identifier living inside a code span where entities would not decode; even when a name carries an "&", the key cell must render it raw.
    // We feed an "&" through the category name to prove the key cell (anchor + code span) is left untouched while the description text around it is escaped.
    const categories: FeatureCategoryEntry[] = [{ description: "A & B", name: "A&B" }];
    const options: Record<string, FeatureOptionEntry[]> = { "A&B": [{ default: true, description: "X.", name: "" }] };
    const output = renderFeatureOptionsReference({ categories, options });

    // The key cell renders the raw "&" in both the anchor and the code span; the entity form must not appear inside the key span.
    assert.ok(output.includes("<A NAME=\"A&B\"></A>`A&B`"));
    assert.ok(!output.includes("`A&amp;B`"));

    // The catalog-derived description text, by contrast, is escaped.
    assert.ok(output.includes("#### <A NAME=\"a&b\"></A>A &amp; B"));
  });
});

describe("renderFeatureOptionsReference - conditional legend", () => {

  test("emits the value-notation legend exactly once when the catalog has a value option", () => {

    // The worked example carries a value option, so the legend appears between the index's trailing blank line and the first heading, followed by its own blank line.
    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });
    const legend = "Options whose key ends in `=<value>` take a value - replace `=<value>` with your setting; all other options are simple on/off toggles. The default " +
      "shown for each option is what applies when you leave it unset.";

    assert.ok(output.includes(legend));
    assert.equal(output.split(legend).length - 1, 1);
  });

  test("omits the legend entirely - and emits no stray blank line - for a toggle-only catalog", () => {

    // A catalog with no value options never renders the "=<value>" placeholder, so the legend that documents it is suppressed. The index's single blank line must lead
    // directly into the first heading with no extra blank line where the legend would have been.
    const categories: FeatureCategoryEntry[] = [{ description: "Configuration", name: "Cfg" }];
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [{ default: true, description: "A toggle.", name: "Toggle" }] };
    const output = renderFeatureOptionsReference({ categories, options });
    const lines = output.split("\n");

    assert.ok(!output.includes("Options whose key ends in"));
    assert.equal(lines[0], " * [Cfg](#cfg): Configuration");
    assert.equal(lines[1], "");
    assert.equal(lines[2], "#### <A NAME=\"cfg\"></A>Configuration");
  });
});

describe("renderFeatureOptionsReference - scope hooks", () => {

  test("inserts the describeCategoryScope string under the heading followed by a blank line", () => {

    const output = renderFeatureOptionsReference({

      categories: WORKED_CATEGORIES,
      describeCategoryScope: (category): string => "These option(s) apply to: " + category.description + " devices.",
      options: WORKED_OPTIONS
    });
    const lines = output.split("\n");
    const headingIndex = lines.indexOf("#### <A NAME=\"audio\"></A>Audio");

    // Heading, blank, the scope line, blank, then the table header.
    assert.ok(headingIndex >= 0);
    assert.equal(lines[headingIndex + 1], "");
    assert.equal(lines[headingIndex + 2], "These option(s) apply to: Audio devices.");
    assert.equal(lines[headingIndex + 3], "");
    assert.ok(lines[headingIndex + 4]?.startsWith("| Option"));
  });

  test("appends the describeOptionScope string to the description cell", () => {

    const output = renderFeatureOptionsReference({

      categories: WORKED_CATEGORIES,
      describeOptionScope: (option): string | undefined => (option.name === "TwoWay") ? " <BR>*Supported on cameras with a microphone.*" : undefined,
      options: WORKED_OPTIONS
    });

    // The suffix is appended after the bolded default; an option the hook returns `undefined` for carries no suffix.
    assert.ok(output.includes("Two-way audio. **(default: disabled)**. <BR>*Supported on cameras with a microphone.*"));
    assert.ok(output.includes("Audio support. **(default: enabled)**.\n"));
  });

  test("omits the category-scope line entirely when describeCategoryScope returns undefined", () => {

    // A hook that returns undefined for a category must produce neither the literal "undefined" nor a stray blank line - the heading is followed directly by its table.
    const output = renderFeatureOptionsReference({

      categories: WORKED_CATEGORIES,
      describeCategoryScope: (): string | undefined => undefined,
      options: WORKED_OPTIONS
    });
    const lines = output.split("\n");
    const headingIndex = lines.indexOf("#### <A NAME=\"audio\"></A>Audio");

    assert.ok(!output.includes("undefined"));
    assert.equal(lines[headingIndex + 1], "");
    assert.ok(lines[headingIndex + 2]?.startsWith("| Option"));
  });

  test("omits the option-scope suffix cleanly when describeOptionScope returns undefined", () => {

    const output = renderFeatureOptionsReference({

      categories: WORKED_CATEGORIES,
      describeOptionScope: (): string | undefined => undefined,
      options: WORKED_OPTIONS
    });

    assert.ok(!output.includes("undefined"));

    // The row ends at the period after the bolded default, with no trailing suffix.
    assert.ok(output.includes("Two-way audio. **(default: disabled)**.\n"));
  });

  test("a no-hooks catalog (ratgdo shape) emits zero device-scope lines", () => {

    // With no hooks supplied, every heading is followed directly by its table - there is no scope sentence anywhere and no "undefined" leakage.
    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    assert.ok(!output.includes("undefined"));
    assert.ok(!output.includes("apply to"));
    assert.equal(output, WORKED_OUTPUT);
  });
});

describe("renderFeatureOptionsReference - meta channel", () => {

  test("forwards the typed option and category meta to the hooks", () => {

    // The renderer reconstitutes the concrete meta types at its boundary so the hooks see them typed; the core never inspects meta.
    interface OptionMeta {

      supportedBy: string;
    }

    interface CategoryMeta {

      models: string[];
    }

    const categories: FeatureCategoryEntry<CategoryMeta>[] = [{ description: "Audio", meta: { models: [ "G4", "G5" ] }, name: "Audio" }];
    const options: Record<string, FeatureOptionEntry<OptionMeta>[]> = {

      Audio: [{ default: true, description: "Audio support.", meta: { supportedBy: "all cameras" }, name: "" }]
    };

    // The hooks assert the meta arrived (rather than relying on a non-null assertion), which both satisfies the no-non-null-assertion rule and strengthens the test:
    // a regression that dropped meta would fail here instead of silently rendering an empty string.
    const output = renderFeatureOptionsReference<OptionMeta, CategoryMeta>({

      categories,
      describeCategoryScope: (category): string => {

        assert.ok(category.meta, "category meta must reach the hook");

        return "Models: " + category.meta.models.join(", ") + ".";
      },
      describeOptionScope: (option): string => {

        assert.ok(option.meta, "option meta must reach the hook");

        return " Supported by " + option.meta.supportedBy + ".";
      },
      options
    });

    assert.ok(output.includes("Models: G4, G5."));
    assert.ok(output.includes("Supported by all cameras."));
  });
});

// A category and a bare toggle for driving the scope hooks directly. The hooks read `scopes` and nothing else, so every row below varies that one field and spreads
// the rest.
const SCOPE_CATEGORY: FeatureCategoryEntry = { description: "Audio", name: "Audio" };
const SCOPE_OPTION: FeatureOptionEntry = { default: true, description: "Audio support.", name: "Support" };

describe("buildFixedScopeDescribers", () => {

  const { describeCategoryScope, describeOptionScope } = buildFixedScopeDescribers();

  test("renders the global-only sentence verbatim", () => {

    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: ["global"] }, SCOPE_CATEGORY), "<BR>This option may only be applied globally.");
  });

  test("renders the global-or-device sentence verbatim", () => {

    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "device", "global" ] }, SCOPE_CATEGORY),
      "<BR>This option may be applied globally or on individual devices.");
  });

  test("compares the declaration as a SET, so declaration order does not change the sentence", () => {

    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "global", "device" ] }, SCOPE_CATEGORY),
      "<BR>This option may be applied globally or on individual devices.", "the reversed declaration earns the same sentence");
  });

  test("says nothing at all for an option that declares no scopes", () => {

    assert.equal(describeOptionScope(SCOPE_OPTION, SCOPE_CATEGORY), undefined, "an absent declaration omits the suffix rather than rendering empty prose");
  });

  test("says nothing for a scope set it has no grounded sentence for, rather than inventing one", () => {

    // A hierarchy with a controller tier, or one that is device-only, is not something this builder has copy for. Returning undefined sends that catalog to the
    // composed builder instead of silently describing it with a sentence that would be wrong.
    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: ["controller"] }, SCOPE_CATEGORY), undefined, "a controller-only declaration");
    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: ["device"] }, SCOPE_CATEGORY), undefined, "a device-only declaration");
    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "controller", "global" ] }, SCOPE_CATEGORY), undefined, "a controller-and-global declaration");
    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "controller", "device", "global" ] }, SCOPE_CATEGORY), undefined, "all three levels");
  });

  test("the category hook is the honest no-op", () => {

    assert.equal(describeCategoryScope(SCOPE_CATEGORY), undefined, "a category declares no scopes, so there is nothing at that level to describe");
  });

  test("agrees with the live consumer hooks on every scope shape their real catalogs declare", () => {

    /* The acceptance bar for retiring the hand-written copies is output equivalence over the real inputs, not equivalence of the decision procedure. The live hooks
     * branch on a membership test where this builder matches the exact set, so the two agree only where it matters: over the scope shapes ratgdo and comed's
     * catalogs are known to carry - [ "device", "global" ] and [ "global" ] - and this row runs both decisions side by side over both of them.
     */
    const liveMembershipHook = (scopes: readonly FeatureOptionScope[]): string => {

      return scopes.includes("device") ? "<BR>This option may be applied globally or on individual devices." : "<BR>This option may only be applied globally.";
    };

    for(const scopes of [ [ "device", "global" ], ["global"] ] as const) {

      assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes }, SCOPE_CATEGORY), liveMembershipHook(scopes),
        "the builder must render what the live hook renders for " + JSON.stringify(scopes));
    }
  });
});

describe("buildComposedScopeDescribers", () => {

  // A three-level vocabulary in the shape the builder asks for: every phrase is self-contained and carries its own preposition, so it reads correctly wherever the
  // list grammar places it.
  const vocabulary = { controller: "at the controller level", device: "on each zone", global: "globally" };

  test("renders a single level with the frame's mechanics - markup, leading word, closing period", () => {

    const { describeOptionScope } = buildComposedScopeDescribers({ vocabulary });

    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: ["global"] }, SCOPE_CATEGORY), " <BR>*Configurable globally.*");
  });

  test("joins MULTIPLE levels with \"or\" by default", () => {

    /* The default list type is asserted on a multi-entry rendering because a single entry renders identically under either grammar and would prove nothing about
     * which one is in force. A builder that silently defaulted to conjunction fails this row on the word "and".
     */
    const { describeOptionScope } = buildComposedScopeDescribers({ vocabulary });

    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "device", "global" ] }, SCOPE_CATEGORY), " <BR>*Configurable on each zone or globally.*");
    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "controller", "device", "global" ] }, SCOPE_CATEGORY),
      " <BR>*Configurable at the controller level, on each zone, or globally.*", "three levels take the serial comma before the \"or\"");
  });

  test("joins with \"and\" when the caller asks for a conjunction", () => {

    const { describeOptionScope } = buildComposedScopeDescribers({ listType: "conjunction", vocabulary });

    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "device", "global" ] }, SCOPE_CATEGORY), " <BR>*Configurable on each zone and globally.*");
    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "controller", "device", "global" ] }, SCOPE_CATEGORY),
      " <BR>*Configurable at the controller level, on each zone, and globally.*");
  });

  test("renders the caller's vocabulary phrase verbatim, in the order the option declares", () => {

    const { describeOptionScope } = buildComposedScopeDescribers({

      vocabulary: { controller: "for the whole site", device: "per sprinkler valve", global: "across every account" }
    });

    assert.equal(describeOptionScope({ ...SCOPE_OPTION, scopes: [ "global", "device" ] }, SCOPE_CATEGORY),
      " <BR>*Configurable across every account or per sprinkler valve.*", "the phrases are the caller's and the order is the declaration's");
  });

  test("opens with \"Configurable\" by default, and with the caller's word when overridden", () => {

    // Both halves are locked in: a hardcoded leading word passes the default row and must fail the override row.
    assert.equal(buildComposedScopeDescribers({ vocabulary }).describeOptionScope({ ...SCOPE_OPTION, scopes: ["global"] }, SCOPE_CATEGORY),
      " <BR>*Configurable globally.*", "the grounded default");
    assert.equal(buildComposedScopeDescribers({ leadingWord: "Settable", vocabulary }).describeOptionScope({ ...SCOPE_OPTION, scopes: ["global"] }, SCOPE_CATEGORY),
      " <BR>*Settable globally.*", "the override, placed verbatim");
  });

  test("says nothing at all for an option that declares no scopes", () => {

    assert.equal(buildComposedScopeDescribers({ vocabulary }).describeOptionScope(SCOPE_OPTION, SCOPE_CATEGORY), undefined);
  });

  test("the category hook is the honest no-op", () => {

    assert.equal(buildComposedScopeDescribers({ vocabulary }).describeCategoryScope(SCOPE_CATEGORY), undefined);
  });

  test("the composed suffix lands in the rendered table exactly as the hook produced it", () => {

    // The end-to-end assertion: the renderer passes hook-owned markup through verbatim, so the italics and the leading break survive into the description cell.
    const { describeCategoryScope, describeOptionScope } = buildComposedScopeDescribers({ vocabulary });
    const output = renderFeatureOptionsReference({

      categories: [SCOPE_CATEGORY],
      describeCategoryScope,
      describeOptionScope,
      options: { Audio: [{ ...SCOPE_OPTION, scopes: [ "device", "global" ] }] }
    });

    assert.ok(output.includes("Audio support. **(default: enabled)**. <BR>*Configurable on each zone or globally.*"),
      "the suffix is concatenated onto the bolded default with its markup intact");
  });
});
