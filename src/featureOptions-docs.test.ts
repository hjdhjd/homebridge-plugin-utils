/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions-docs.test.ts: Unit tests for the shared Feature Options documentation renderer - the catalog-to-markdown projection (renderFeatureOptionsReference)
 * and the in-place marker splice (spliceMarkedRegion).
 *
 * Coverage focuses on the contract that is hard to see from the code alone: the index/detail structure, the per-row deep-link anchors, the value/toggle distinction
 * signaled by the ".<value>" placeholder, the raw (never formatted) default cell with its empty-string -> "none" substitution proven non-mutating, the two scope
 * hooks (string inserted, `undefined` omitted cleanly), the category-level bare-key option, and the splice's happy path, idempotency, prose preservation, and
 * malformed-marker throws. The canonical worked example is reproduced verbatim as the load-bearing contract test.
 */
import { FEATURE_OPTIONS_DOC_BEGIN, FEATURE_OPTIONS_DOC_END, renderFeatureOptionsReference, spliceMarkedRegion } from "./featureOptions-docs.ts";
import type { FeatureCategoryEntry, FeatureOptionEntry } from "./featureOptions.ts";
import { describe, test } from "node:test";
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
// is the load-bearing contract this fixture pins.
const WORKED_OUTPUT = [

  " * [Audio](#audio): Audio",
  " * [Nvr](#nvr): Recording",
  "",
  "Options whose key ends in `.<value>` take a value - replace `.<value>` with your setting; all other options are simple on/off toggles. The default shown for each " +
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
  "| <A NAME=\"Nvr.Recording.Retention\"></A>`Nvr.Recording.Retention.<value>`  | Days of recordings to retain. **(default: 10)**.",
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
    assert.ok(lines[3]?.startsWith("Options whose key ends in `.<value>`"));
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
    assert.ok(output.includes("<A NAME=\"Nvr.Recording.Retention\"></A>`Nvr.Recording.Retention.<value>`"));
  });
});

describe("renderFeatureOptionsReference - default cell and value/toggle distinction", () => {

  test("renders an enabled toggle default as \"enabled\" and a disabled toggle as \"disabled\"", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    assert.ok(output.includes("Audio support. **(default: enabled)**."));
    assert.ok(output.includes("Two-way audio. **(default: disabled)**."));
  });

  test("renders a value option with the .<value> placeholder and its raw declared default", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    // The ".<value>" suffix is the lexical signal of value-ness; the default is the raw "10", never formatted.
    assert.ok(output.includes("`Nvr.Recording.Retention.<value>`"));
    assert.ok(output.includes("Days of recordings to retain. **(default: 10)**."));
  });

  test("does not append the .<value> placeholder to a plain toggle option", () => {

    const output = renderFeatureOptionsReference({ categories: WORKED_CATEGORIES, options: WORKED_OPTIONS });

    // A toggle's key span must be the bare key with no placeholder suffix.
    assert.ok(output.includes("`Audio.TwoWay`"));
    assert.ok(!output.includes("`Audio.TwoWay.<value>`"));
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

    // The defaultValue key is present (so the option is value-centric and gets the .<value> placeholder) but its value is undefined; the default cell collapses to
    // "none" via the same empty-default path.
    const categories: FeatureCategoryEntry[] = [{ description: "Configuration", name: "Cfg" }];
    const options: Record<string, FeatureOptionEntry[]> = { Cfg: [{ default: false, defaultValue: undefined, description: "Token.", name: "Token" }] };
    const output = renderFeatureOptionsReference({ categories, options });

    assert.ok(output.includes("`Cfg.Token.<value>`"));
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
    const legend = "Options whose key ends in `.<value>` take a value - replace `.<value>` with your setting; all other options are simple on/off toggles. The default " +
      "shown for each option is what applies when you leave it unset.";

    assert.ok(output.includes(legend));
    assert.equal(output.split(legend).length - 1, 1);
  });

  test("omits the legend entirely - and emits no stray blank line - for a toggle-only catalog", () => {

    // A catalog with no value options never renders the ".<value>" placeholder, so the legend that documents it is suppressed. The index's single blank line must lead
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

describe("spliceMarkedRegion - replacement", () => {

  // A canonical marked document: hand-written prose around a marked region holding stale generated content.
  const document = [

    "# Feature Options",
    "",
    "Intro prose the maintainer owns.",
    "",
    FEATURE_OPTIONS_DOC_BEGIN,
    "stale generated content",
    FEATURE_OPTIONS_DOC_END,
    "",
    "Footer prose."
  ].join("\n");

  test("replaces the region strictly between the markers, framing the content with newlines", () => {

    const result = spliceMarkedRegion(document, "FRESH CONTENT");

    assert.ok(result.includes(FEATURE_OPTIONS_DOC_BEGIN + "\nFRESH CONTENT\n" + FEATURE_OPTIONS_DOC_END));
    assert.ok(!result.includes("stale generated content"));
  });

  test("preserves the surrounding hand-written prose untouched", () => {

    const result = spliceMarkedRegion(document, "FRESH CONTENT");

    assert.ok(result.startsWith("# Feature Options\n\nIntro prose the maintainer owns.\n"));
    assert.ok(result.endsWith("\nFooter prose."));
  });

  test("is idempotent: splicing the same content twice yields an identical document", () => {

    const once = spliceMarkedRegion(document, "FRESH CONTENT");
    const twice = spliceMarkedRegion(once, "FRESH CONTENT");

    assert.equal(once, twice);
  });

  test("honors overridden begin and end markers", () => {

    const custom = "BEGIN_HERE\nold\nEND_HERE";
    const result = spliceMarkedRegion(custom, "new", { beginMarker: "BEGIN_HERE", endMarker: "END_HERE" });

    assert.equal(result, "BEGIN_HERE\nnew\nEND_HERE");
  });
});

describe("spliceMarkedRegion - malformed markers", () => {

  test("throws naming the begin marker when it is absent", () => {

    const source = "no markers here at all\n" + FEATURE_OPTIONS_DOC_END;

    assert.throws(() => spliceMarkedRegion(source, "x"), /begin marker not found/);
  });

  test("throws naming the end marker when it is absent", () => {

    const source = FEATURE_OPTIONS_DOC_BEGIN + "\nno end marker here";

    assert.throws(() => spliceMarkedRegion(source, "x"), /end marker not found/);
  });

  test("throws when the end marker precedes the begin marker", () => {

    // The markers are present but inverted, which would otherwise produce a negative-length region.
    const source = FEATURE_OPTIONS_DOC_END + "\ncontent\n" + FEATURE_OPTIONS_DOC_BEGIN;

    assert.throws(() => spliceMarkedRegion(source, "x"), /precedes begin marker/);
  });

  test("throws when the document contains a second begin marker", () => {

    // Two begin markers make the marked region ambiguous - splicing into the first pair would leave the duplicate begin marker (and stale content) behind.
    const source = FEATURE_OPTIONS_DOC_BEGIN + "\nfirst\n" + FEATURE_OPTIONS_DOC_BEGIN + "\nsecond\n" + FEATURE_OPTIONS_DOC_END;

    assert.throws(() => spliceMarkedRegion(source, "x"), /multiple begin markers found/);
  });

  test("throws when the document contains a second end marker", () => {

    // Two end markers are likewise ambiguous; the region cannot be uniquely identified.
    const source = FEATURE_OPTIONS_DOC_BEGIN + "\ncontent\n" + FEATURE_OPTIONS_DOC_END + "\nmore\n" + FEATURE_OPTIONS_DOC_END;

    assert.throws(() => spliceMarkedRegion(source, "x"), /multiple end markers found/);
  });
});
