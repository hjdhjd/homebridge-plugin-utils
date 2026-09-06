[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / doc-json

# doc-json

The JSON counterpart to the family's marked-region splice: the in-place replacement of a single top-level string member's value in a document a human authors and
reads.

A generated region inside JSON cannot be framed the way a markdown region is. A marker pair would have to live inside the string literal itself, where it is visible
cruft in the raw file and needs escaping discipline of its own, so the member's name is the seed instead and the whole value is what the splice writes. Neither can
the document be round-tripped through a whole-document parse and re-serialization: that reformats the entire file and discards the blank lines and member spacing
its author put there - a plugin's `config.schema.json` carries several - which is a far larger edit than the one asked for. The walk here is therefore textual: it
never parses the document, it locates the value's span in the raw source and replaces exactly that span, so every byte outside it, blank lines included, comes
through as it was.

The module exports one pure string function, [spliceJsonStringValue](#splicejsonstringvalue). Like the markdown mechanics it sits beside, it is pure and isomorphic: no `node:`
imports, no `fs`, no `process`. Reading a document and writing it back belongs to the CLI verb that drives a generator.

## Utilities

### spliceJsonStringValue()

```ts
function spliceJsonStringValue(
   source, 
   key, 
   value
): string;
```

Replace the value of the top-level string member named `key` in `source` with `value`, leaving every other byte of the document - member order, indentation, blank
lines, the trailing newline - exactly as it was. This is the JSON counterpart of [doc-markdown!spliceMarkedRegion](doc-markdown.md#splicemarkedregion): the member's name plays the part a marker
pair plays in a markdown document, and the whole value is the generated region.

The walk is textual and never parses the document. It tracks string literals - a backslash escapes the character after it - and bracket depth, so a sibling value
carrying a quote or a backslash is passed over, and a member of the same name nested inside a deeper object belongs to that object rather than to this one. The key
comparison is against the literal's raw text, which is what a hand-authored member reads as. The replacement is written through `JSON.stringify`, so a value
carrying quotes, backslashes, or newlines lands as a valid literal.

The member has to exist already. Creating it would be a structural edit to a file the plugin owns - where the member sits and what surrounds it are the author's
decisions - so an absent member is refused exactly as an absent marker is, and the author seeds it once with an empty string.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `source` | `string` | The full JSON document text. |
| `key` | `string` | The name of the top-level member whose value is replaced. |
| `value` | `string` | The value to write, escaped into a JSON string literal. |

#### Returns

`string`

`source` with the named member's value replaced.

#### Throws

`Error` naming the function and the key when the document is not a JSON object, when the member is absent at the top level, when it appears there more than
        once - either way the target is not uniquely identified - when its value is not a string literal, and when that value's literal never closes, where any
        answer but a refusal would hand back a truncated document.
