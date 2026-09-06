/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doc-json.test.ts: Unit tests for the JSON string-value splice (spliceJsonStringValue).
 *
 * The happy-path rows compare the whole result against the input with exactly the target literal replaced, because leaving every other byte alone - the blank line a
 * plugin authored inside its schema, the member order, the indentation, the trailing newline - is the entire reason the splice walks the text instead of round-tripping
 * the document. The remaining rows drive the walk's hazards one at a time: a nested member of the same name, a sibling carrying escapes, a longer name sharing the
 * prefix, and each refusal. The function is pure, so every row spells its own document as a string and needs no fixture beyond it.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spliceJsonStringValue } from "./doc-json.ts";

// A canonical hand-authored configuration schema: members in the order an author wrote them, two levels of nesting, a blank line inside a nested object, and a trailing
// newline. Every byte of it outside the footer's literal is what the splice promises to preserve.
const DOCUMENT = [

  "{",
  "  \"pluginAlias\": \"Example\",",
  "  \"headerDisplay\": \"Example header.\",",
  "  \"schema\": {",
  "    \"type\": \"object\",",
  "    \"properties\": {",
  "",
  "      \"name\": { \"type\": \"string\" }",
  "    }",
  "  },",
  "  \"footerDisplay\": \"seeded footer\"",
  "}",
  ""
].join("\n");

describe("spliceJsonStringValue", () => {

  test("replaces the named value and leaves every other byte of the document as it was", () => {

    const footer = "See the [example developer page](https://github.com/acme/example) for detailed documentation.";
    const result = spliceJsonStringValue(DOCUMENT, "footerDisplay", footer);

    // The expectation is the input with exactly the target's literal swapped, which is the strongest statement of "nothing else moved" available: any reformatting,
    // re-indentation, or dropped blank line anywhere in the document fails this one comparison.
    assert.equal(result, DOCUMENT.replace("\"seeded footer\"", JSON.stringify(footer)));
    assert.ok(result.includes("    \"properties\": {\n\n      \"name\""), "the hand-authored blank line inside the nested object survives");
    assert.ok(result.startsWith("{\n  \"pluginAlias\": \"Example\",\n"), "so do the member order and the indentation");
    assert.ok(result.endsWith("}\n"), "and so does the trailing newline");
    assert.equal((JSON.parse(result) as { footerDisplay: string }).footerDisplay, footer, "and the document still reads as the value that was written");
  });

  test("writes a value carrying a quote, a backslash, and a newline as a literal JSON reads back exactly", () => {

    const value = "A \"quoted\" phrase, a C:\\Users path, and\na second line.";
    const result = spliceJsonStringValue(DOCUMENT, "footerDisplay", value);

    assert.equal((JSON.parse(result) as { footerDisplay: string }).footerDisplay, value);
    assert.ok(result.includes("\\\"quoted\\\""), "the quotes are escaped in the raw text rather than closing the literal early");
    assert.ok(!result.includes("phrase, a C:\\Users"), "and so is the backslash");
  });

  test("refuses a document with no such member at the top level, and one that is not an object at all", () => {

    const seeded = "{\n  \"pluginAlias\": \"Example\"\n}\n";

    // The diagnostic has to carry all three facts a plugin author needs: which function refused, which member it looked for, and what to author so the next run works.
    assert.throws(() => spliceJsonStringValue(seeded, "footerDisplay", "x"),
      /spliceJsonStringValue: member "footerDisplay" not found at the top level of source; seed it with an empty string value/);
    assert.throws(() => spliceJsonStringValue("[ \"footerDisplay\" ]\n", "footerDisplay", "x"), /spliceJsonStringValue: source is not a JSON object/);
  });

  test("refuses a document carrying the member twice at the top level", () => {

    const duplicated = "{\n  \"footerDisplay\": \"first\",\n  \"footerDisplay\": \"second\"\n}\n";

    assert.throws(() => spliceJsonStringValue(duplicated, "footerDisplay", "x"),
      /spliceJsonStringValue: multiple "footerDisplay" members found at the top level of source/);
  });

  test("passes over a member of the same name nested inside another object", () => {

    const nested = [

      "{",
      "  \"schema\": {",
      "    \"footerDisplay\": \"a property of its own, not the document's footer\"",
      "  },",
      "  \"footerDisplay\": \"seeded\"",
      "}",
      ""
    ].join("\n");

    const result = spliceJsonStringValue(nested, "footerDisplay", "stamped");

    assert.equal(result, nested.replace("\"seeded\"", "\"stamped\""));
    assert.ok(result.includes("\"footerDisplay\": \"a property of its own, not the document's footer\""), "the nested member keeps its own value");
  });

  test("refuses a member whose value is not a string literal", () => {

    const structured = "{\n  \"footerDisplay\": { \"text\": \"nope\" }\n}\n";

    assert.throws(() => spliceJsonStringValue(structured, "footerDisplay", "x"),
      /spliceJsonStringValue: the value of member "footerDisplay" in source is not a string literal/);
  });

  test("walks past an earlier sibling whose value carries an escaped quote and an escaped backslash", () => {

    /* The sibling carries an ODD number of escaped quotes on purpose. A walk that read `\"` as the literal's end would take an even count back into step by luck at
     * the value's real closing quote and splice correctly anyway, so a matched pair would leave the escape handling unproven; with one, the walk stays out of step
     * for the rest of the document and never finds the target at all.
     */
    const escaped = [

      "{",
      "  \"headerDisplay\": \"a \\\"quoted phrase and a C:\\\\Users\\\\home path\",",
      "  \"footerDisplay\": \"seeded\"",
      "}",
      ""
    ].join("\n");

    const result = spliceJsonStringValue(escaped, "footerDisplay", "stamped");

    assert.equal(result, escaped.replace("\"seeded\"", "\"stamped\""));
    assert.equal((JSON.parse(result) as { headerDisplay: string }).headerDisplay, "a \"quoted phrase and a C:\\Users\\home path");
  });

  test("does not match a longer member sharing the name's prefix, and accepts whitespace before the colon", () => {

    const prefixed = [

      "{",
      "  \"footerDisplayExtra\": \"a different member entirely\",",
      "  \"footerDisplay\" : \"seeded\"",
      "}",
      ""
    ].join("\n");

    const result = spliceJsonStringValue(prefixed, "footerDisplay", "stamped");

    assert.equal(result, prefixed.replace("\"seeded\"", "\"stamped\""));
    assert.ok(result.includes("\"footerDisplayExtra\": \"a different member entirely\""), "the longer name names a member of its own");
  });

  test("reports the member as absent when an unterminated literal swallows it, rather than walking off the end", () => {

    /* A document a hand edit left malformed: the sibling's literal is never closed, so the walk is inside a string when it passes the target's name and never reads
     * it as a member. Ending an unterminated literal at the end of the source is what keeps that a framed refusal naming the seed, which is a diagnostic an author
     * can act on, rather than a walk into whatever follows the document.
     */
    const unterminated = "{\n  \"headerDisplay\": \"never closed,\n  \"footerDisplay\": \"seeded\"\n}\n";

    assert.throws(() => spliceJsonStringValue(unterminated, "footerDisplay", "stamped"),
      /spliceJsonStringValue: member "footerDisplay" not found at the top level of source; seed it with an empty string value/);
  });

  test("refuses a target whose own value literal never closes, in either shape that runs to the end of the source", () => {

    /* Reading the end of the source as the target's closing quote would splice the new value in and answer a document with its closing brace and trailing newline
     * gone, so each shape asserts the refusal AND asserts that nothing came back at all: a documentation stamp must never truncate the file it was pointed at. The
     * escaped-quote shape is why an open literal cannot be recognized from the source's last character - a value whose final byte is an escaped quote reads as
     * closed to such a check, and is not.
     */
    const refusal = /spliceJsonStringValue: the value of member "footerDisplay" in source is a string literal that never closes; seed it with an empty string value/;
    const shapes = [ "{\n  \"footerDisplay\": \"never closed\n", "{\n  \"footerDisplay\": \"never closed\\\"" ];

    for(const source of shapes) {

      let returned: string | undefined;

      assert.throws(() => {

        returned = spliceJsonStringValue(source, "footerDisplay", "stamped");
      }, refusal, "the splice answered a truncated document rather than refusing an open literal");
      assert.equal(returned, undefined, "the truncated document never comes back to the caller");
    }
  });
});
