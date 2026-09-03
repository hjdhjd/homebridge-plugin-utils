/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doc-markdown.test.ts: Unit tests for the shared documentation markdown mechanics - the padded-column table layout (renderMarkdownTable) and the in-place marker
 * splice (spliceMarkedRegion).
 *
 * The table rows assert whole lines byte for byte rather than probing widths, because alignment is the only thing the layout promises and a hand-computed line is
 * the one assertion a padding regression cannot slip past. The splice rows cover its happy path, repeatability, prose preservation, and malformed-marker throws. Both
 * surfaces are pure string functions, so every row drives them directly with no fixture beyond its own strings.
 */
import { FEATURE_OPTIONS_DOC_BEGIN, FEATURE_OPTIONS_DOC_END } from "./featureOptions-docs.ts";
import { describe, test } from "node:test";
import { renderMarkdownTable, spliceMarkedRegion } from "./doc-markdown.ts";
import assert from "node:assert/strict";

/* Compile-time shape exercises for the splice's marker pair. These never run - the function is voided at module scope rather than called - so they add nothing to the
 * runtime totals; TypeScript still type-checks the body during `npm run typecheck`, so a shape regression fails the build here rather than silently at a consuming
 * generator. The negative case uses `@ts-expect-error`, which fails the build if the error it expects ever stops occurring.
 */
const docMarkdownShapeExercises = (): void => {

  // A caller names the pair framing its own region, because a domain-free splice has no document's convention to fall back on.
  const framed = spliceMarkedRegion("BEGIN\nold\nEND", "new", { beginMarker: "BEGIN", endMarker: "END" });

  // @ts-expect-error - the marker pair is required.
  const unframed = spliceMarkedRegion("BEGIN\nold\nEND", "new");

  void [ framed, unframed ];
};

void docMarkdownShapeExercises;

describe("renderMarkdownTable - layout", () => {

  test("reproduces the two-column feature-options shape byte for byte", () => {

    // The widest key cell is 21 characters, so the Option column is 22 wide and its divider segment 24 dashes; the description divider is the caller's 61.
    const lines = renderMarkdownTable({ dividerWidth: 61, headings: [ "Option", "Description" ],
      rows: [ [ "`Audio`", "Audio support." ], [ "`Audio.TwoWay.Enable`", "Two-way audio." ] ] });

    assert.deepEqual(lines, [

      "| Option                 | Description",
      "|------------------------|-------------------------------------------------------------",
      "| `Audio`                | Audio support.",
      "| `Audio.TwoWay.Enable`  | Two-way audio."
    ]);
  });

  test("reproduces the three-column topic shape byte for byte", () => {

    // The widest topic cell is 32 characters and the widest device cell is the 18-character heading, so the two padded columns are 33 and 19 wide.
    const lines = renderMarkdownTable({ dividerWidth: 34, headings: [ "Topic", "Access Device Type", "Message Published" ],
      rows: [ [ "`lock`", "All hubs", "`true` when locked." ], [ "<CODE>relay/<I>output</I></CODE>", "UA Hub", "The relay state." ] ] });

    assert.deepEqual(lines, [

      "| Topic                             | Access Device Type  | Message Published",
      "|-----------------------------------|---------------------|----------------------------------",
      "| `lock`                            | All hubs            | `true` when locked.",
      "| <CODE>relay/<I>output</I></CODE>  | UA Hub              | The relay state."
    ]);
  });

  test("sizes a column from its heading when the heading is wider than every cell", () => {

    const lines = renderMarkdownTable({ dividerWidth: 12, headings: [ "LongestHeading", "Last" ], rows: [[ "ab", "x" ]] });

    assert.deepEqual(lines, [

      "| LongestHeading  | Last",
      "|-----------------|------------",
      "| ab              | x"
    ]);
  });

  test("pads a column exactly one space past its widest cell", () => {

    // The widest cell is five characters, so the column is six wide: the cell is followed by one padding space and then the separator's own gutter.
    const lines = renderMarkdownTable({ dividerWidth: 12, headings: [ "H", "Last" ], rows: [[ "12345", "x" ]] });

    assert.deepEqual(lines, [

      "| H      | Last",
      "|--------|------------",
      "| 12345  | x"
    ]);
  });

  test("never pads the last column", () => {

    const lines = renderMarkdownTable({ dividerWidth: 12, headings: [ "H", "Last" ], rows: [[ "12345", "x" ]] });

    for(const line of lines) {

      assert.equal(line, line.trimEnd(), "no line may carry a trailing space, which is what padding the last column would produce");
    }
  });

  test("yields the heading line and the divider alone for a table with no rows", () => {

    const lines = renderMarkdownTable({ dividerWidth: 12, headings: [ "Option", "Description" ], rows: [] });

    assert.deepEqual(lines, [ "| Option  | Description", "|---------|------------" ]);
  });

  test("carries no trailing blank line, leaving the framing to the caller", () => {

    const lines = renderMarkdownTable({ dividerWidth: 12, headings: [ "H", "Last" ], rows: [[ "a", "b" ]] });

    assert.equal(lines.length, 3);
    assert.notEqual(lines.at(-1), "");
  });

  test("throws naming a row whose cell count does not match the headings", () => {

    assert.throws(() => renderMarkdownTable({ dividerWidth: 12, headings: [ "A", "B", "C" ], rows: [ [ "a", "b", "c" ], [ "a", "b" ] ] }),
      /^Error: renderMarkdownTable: the row at index 1 carries 2 cells for 3 headings\.$/);
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

  // The pair the document above embeds, named once so every row below spells the region it splices rather than relying on a convention the splice does not carry.
  const markers = { beginMarker: FEATURE_OPTIONS_DOC_BEGIN, endMarker: FEATURE_OPTIONS_DOC_END };

  test("replaces the region strictly between the markers, framing the content with newlines", () => {

    const result = spliceMarkedRegion(document, "FRESH CONTENT", markers);

    assert.ok(result.includes(FEATURE_OPTIONS_DOC_BEGIN + "\nFRESH CONTENT\n" + FEATURE_OPTIONS_DOC_END));
    assert.ok(!result.includes("stale generated content"));
  });

  test("preserves the surrounding hand-written prose untouched", () => {

    const result = spliceMarkedRegion(document, "FRESH CONTENT", markers);

    assert.ok(result.startsWith("# Feature Options\n\nIntro prose the maintainer owns.\n"));
    assert.ok(result.endsWith("\nFooter prose."));
  });

  test("is repeatable: splicing the same content twice yields an identical document", () => {

    const once = spliceMarkedRegion(document, "FRESH CONTENT", markers);
    const twice = spliceMarkedRegion(once, "FRESH CONTENT", markers);

    assert.equal(once, twice);
  });

  test("honors a caller's own begin and end markers", () => {

    const custom = "BEGIN_HERE\nold\nEND_HERE";
    const result = spliceMarkedRegion(custom, "new", { beginMarker: "BEGIN_HERE", endMarker: "END_HERE" });

    assert.equal(result, "BEGIN_HERE\nnew\nEND_HERE");
  });
});

describe("spliceMarkedRegion - malformed markers", () => {

  // Every row below splices the feature-options pair, which is what makes each fixture's one deliberate defect the only thing under test.
  const markers = { beginMarker: FEATURE_OPTIONS_DOC_BEGIN, endMarker: FEATURE_OPTIONS_DOC_END };

  test("throws naming the begin marker when it is absent", () => {

    const source = "no markers here at all\n" + FEATURE_OPTIONS_DOC_END;

    assert.throws(() => spliceMarkedRegion(source, "x", markers), /begin marker not found/);
  });

  test("throws naming the end marker when it is absent", () => {

    const source = FEATURE_OPTIONS_DOC_BEGIN + "\nno end marker here";

    assert.throws(() => spliceMarkedRegion(source, "x", markers), /end marker not found/);
  });

  test("throws when the end marker precedes the begin marker", () => {

    // The markers are present but inverted, which would otherwise produce a negative-length region.
    const source = FEATURE_OPTIONS_DOC_END + "\ncontent\n" + FEATURE_OPTIONS_DOC_BEGIN;

    assert.throws(() => spliceMarkedRegion(source, "x", markers), /precedes begin marker/);
  });

  test("throws when the document contains a second begin marker", () => {

    // Two begin markers make the marked region ambiguous - splicing into the first pair would leave the duplicate begin marker (and stale content) behind.
    const source = FEATURE_OPTIONS_DOC_BEGIN + "\nfirst\n" + FEATURE_OPTIONS_DOC_BEGIN + "\nsecond\n" + FEATURE_OPTIONS_DOC_END;

    assert.throws(() => spliceMarkedRegion(source, "x", markers), /multiple begin markers found/);
  });

  test("throws when the document contains a second end marker", () => {

    // Two end markers are likewise ambiguous; the region cannot be uniquely identified.
    const source = FEATURE_OPTIONS_DOC_BEGIN + "\ncontent\n" + FEATURE_OPTIONS_DOC_END + "\nmore\n" + FEATURE_OPTIONS_DOC_END;

    assert.throws(() => spliceMarkedRegion(source, "x", markers), /multiple end markers found/);
  });
});
