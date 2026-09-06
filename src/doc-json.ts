/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doc-json.ts: The JSON mechanic a documentation generator composes over - the in-place replacement of one top-level string value.
 */

/**
 * The JSON counterpart to the family's marked-region splice: the in-place replacement of a single top-level string member's value in a document a human authors and
 * reads.
 *
 * A generated region inside JSON cannot be framed the way a markdown region is. A marker pair would have to live inside the string literal itself, where it is visible
 * cruft in the raw file and needs escaping discipline of its own, so the member's name is the seed instead and the whole value is what the splice writes. Neither can
 * the document be round-tripped through a whole-document parse and re-serialization: that reformats the entire file and discards the blank lines and member spacing
 * its author put there - a plugin's `config.schema.json` carries several - which is a far larger edit than the one asked for. The walk here is therefore textual: it
 * never parses the document, it locates the value's span in the raw source and replaces exactly that span, so every byte outside it, blank lines included, comes
 * through as it was.
 *
 * The module exports one pure string function, {@link spliceJsonStringValue}. Like the markdown mechanics it sits beside, it is pure and isomorphic: no `node:`
 * imports, no `fs`, no `process`. Reading a document and writing it back belongs to the CLI verb that drives a generator.
 *
 * @module
 */

// The four characters JSON admits as whitespace between tokens.
const JSON_WHITESPACE = " \t\n\r";

// Answer the index of the first character at or after `start` that is not JSON whitespace, or the end of the source when nothing else follows.
function skipWhitespace(source: string, start: number): number {

  let index = start;

  while((index < source.length) && JSON_WHITESPACE.includes(source.charAt(index))) {

    index++;
  }

  return index;
}

/* Answer the index just past the closing quote of the string literal whose opening quote sits at `start`, or `undefined` when the literal never closes. A backslash
 * escapes the character after it, so an escaped quote or an escaped backslash inside the literal never reads as the literal's end...which is also why an unterminated
 * literal needs an answer of its own rather than one a caller could work out afterwards: a literal whose final byte is an escaped quote looks closed to a check on
 * the source's last character, and is not. What an open literal means belongs to the caller, and it means one thing where a member's name is read and another where
 * the target's own value is.
 */
function endOfStringLiteral(source: string, start: number): number | undefined {

  for(let index = start + 1; index < source.length; index++) {

    const character = source.charAt(index);

    if(character === "\\") {

      index++;

      continue;
    }

    if(character === "\"") {

      return index + 1;
    }
  }

  return undefined;
}

/**
 * Replace the value of the top-level string member named `key` in `source` with `value`, leaving every other byte of the document - member order, indentation, blank
 * lines, the trailing newline - exactly as it was. This is the JSON counterpart of {@link doc-markdown!spliceMarkedRegion}: the member's name plays the part a marker
 * pair plays in a markdown document, and the whole value is the generated region.
 *
 * The walk is textual and never parses the document. It tracks string literals - a backslash escapes the character after it - and bracket depth, so a sibling value
 * carrying a quote or a backslash is passed over, and a member of the same name nested inside a deeper object belongs to that object rather than to this one. The key
 * comparison is against the literal's raw text, which is what a hand-authored member reads as. The replacement is written through `JSON.stringify`, so a value
 * carrying quotes, backslashes, or newlines lands as a valid literal.
 *
 * The member has to exist already. Creating it would be a structural edit to a file the plugin owns - where the member sits and what surrounds it are the author's
 * decisions - so an absent member is refused exactly as an absent marker is, and the author seeds it once with an empty string.
 *
 * @param source - The full JSON document text.
 * @param key    - The name of the top-level member whose value is replaced.
 * @param value  - The value to write, escaped into a JSON string literal.
 *
 * @returns `source` with the named member's value replaced.
 *
 * @throws `Error` naming the function and the key when the document is not a JSON object, when the member is absent at the top level, when it appears there more than
 *         once - either way the target is not uniquely identified - when its value is not a string literal, and when that value's literal never closes, where any
 *         answer but a refusal would hand back a truncated document.
 *
 * @category Utilities
 */
export function spliceJsonStringValue(source: string, key: string, value: string): string {

  const documentStart = skipWhitespace(source, 0);

  if(source.charAt(documentStart) !== "{") {

    throw new Error("spliceJsonStringValue: source is not a JSON object, so the member \"" + key + "\" cannot be spliced.");
  }

  // The span of the target's value literal. The walk runs to the end of the top-level object even once it has found the member, so a second member of the same name is
  // refused rather than silently resolved to the first of the two.
  let span: { end: number; start: number } | undefined;
  let depth = 1;
  let index = documentStart + 1;

  while((index < source.length) && (depth > 0)) {

    const character = source.charAt(index);

    /* A string literal is the one construct whose contents are not structure, so the walk skips it whole rather than reading the brackets, colons, and commas a value
     * may contain. A literal followed by a colon is a member's name, and one of those at the top level is where the target can be.
     */
    if(character === "\"") {

      /* An open literal anywhere the walk passes through carries to the end of the source, because everything after it belongs to that string. The target's name is
       * then never read as a member and the run refuses as absent, which names the seed and is a diagnostic the author of a hand-edited document can act on.
       */
      const literalEnd = endOfStringLiteral(source, index) ?? source.length;
      const afterLiteral = skipWhitespace(source, literalEnd);

      if((depth === 1) && (source.charAt(afterLiteral) === ":") && (source.slice(index + 1, literalEnd - 1) === key)) {

        if(span !== undefined) {

          throw new Error("spliceJsonStringValue: multiple \"" + key + "\" members found at the top level of source; the member is ambiguous.");
        }

        const valueStart = skipWhitespace(source, afterLiteral + 1);

        if(source.charAt(valueStart) !== "\"") {

          throw new Error("spliceJsonStringValue: the value of member \"" + key + "\" in source is not a string literal.");
        }

        /* The target's own value is the one literal whose open end cannot be taken as the source's end. Splicing against that would write the new value in and answer
         * a document whose closing brace and trailing newline are gone, and a documentation stamp that truncates a file a plugin owns is worse than any diagnostic it
         * could print instead.
         */
        const valueEnd = endOfStringLiteral(source, valueStart);

        if(valueEnd === undefined) {

          throw new Error("spliceJsonStringValue: the value of member \"" + key + "\" in source is a string literal that never closes; seed it with an empty " +
            "string value for the stamp to fill.");
        }

        span = { end: valueEnd, start: valueStart };
      }

      index = literalEnd;

      continue;
    }

    // Brackets are the whole of the structure the walk tracks. The depth they keep is what tells a member of the top-level object apart from one nested inside it.
    if((character === "{") || (character === "[")) {

      depth++;
    } else if((character === "}") || (character === "]")) {

      depth--;
    }

    index++;
  }

  if(span === undefined) {

    throw new Error("spliceJsonStringValue: member \"" + key + "\" not found at the top level of source; seed it with an empty string value for the stamp to fill.");
  }

  return source.slice(0, span.start) + JSON.stringify(value) + source.slice(span.end);
}
