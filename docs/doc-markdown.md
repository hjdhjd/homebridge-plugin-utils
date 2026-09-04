[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / doc-markdown

# doc-markdown

The markdown mechanics every documentation generator in the family composes over: the in-place splice of a marked region, and the markdown table with padded
columns.

Both are domain-free by design. A generator owns what its catalog holds, what a row says, and which marker pair frames its region; it reaches here for the two
mechanics that are the same whatever the domain, so two documents that share no subject matter still print tables a reader recognizes as one family's and still
regenerate through one splice.

The module exports two pure string functions:

  - [renderMarkdownTable](#rendermarkdowntable) - the table layout: the single width pass over every column but the last, the divider, and the row template.

  - [spliceMarkedRegion](#splicemarkedregion) - the in-place splice that replaces the region between a caller-named marker pair in an existing document with freshly rendered
    content, leaving the hand-written prose around it untouched.

Both are pure and isomorphic: no `node:` imports, no `fs`, no `process`. The only I/O - reading a document and writing it back - belongs to the CLI verb that
drives a generator, which is inherently a tooling concern. This module is therefore browser-safe and trivially testable, but it is a tooling concern and is
deliberately NOT mirrored into `dist/ui/` by the build pipeline.

## Utilities

### MarkdownTableInput

The table [renderMarkdownTable](#rendermarkdowntable) lays out.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="dividerwidth"></a> `dividerWidth` | `readonly` | `number` | The width, in dashes, of the divider segment under the last column. That column is never padded, so it has no measured width for its divider to track and the caller states the one its document reads well at. |
| <a id="headings"></a> `headings` | `readonly` | readonly `string`[] | The column headings, in column order. Their count is what every row's cell count must match. |
| <a id="rows"></a> `rows` | `readonly` | readonly readonly `string`[][] | The rows, each one a list of rendered cells in column order. |

***

### renderMarkdownTable()

```ts
function renderMarkdownTable(table): readonly string[];
```

Render a markdown table: a heading line, a divider line, and one line per row, with every column but the last padded to the widest thing it carries.

Each padded column is measured against its own heading and every cell beneath it, then given one trailing space so the widest cell does not sit flush against the
separator. The divider draws each padded column over that width plus the two gutters around the cell, and the last column over the caller's fixed width. The last
column is deliberately unmeasured: it carries the prose, and padding it would only trail spaces to the end of every line.

Cells are measured as the caller renders them. A caller that wraps a cell in markup - a code span, a link, an anchor - measures the markup with the text, which is
what keeps the raw source aligned even though the rendered document collapses the padding entirely. Padding is cosmetic; nothing downstream reads it.

The returned lines carry no trailing blank: a caller emitting several tables into one fragment decides how they sit against each other, so the framing is the
caller's.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `table` | [`MarkdownTableInput`](#markdowntableinput) | - |

#### Returns

readonly `string`[]

The table's lines: the heading line, the divider, then one line per row.

#### Throws

`Error` naming a row's index when it carries a different number of cells than the table has headings, since rendering it would shift every column after it.

***

### spliceMarkedRegion()

```ts
function spliceMarkedRegion(
   source, 
   content, 
   markers): string;
```

Replace the region strictly between the begin marker and the end marker in `source` with `content`, leaving both markers and all surrounding prose untouched. This is
the pure half of the in-place splice each generator's CLI verb performs; the verb supplies the trivial `readFile` / `writeFile` around it.

The replacement inserts a newline before and after `content`, so a marker pair on its own lines stays on its own lines and the rendered fragment is cleanly framed.
The operation is repeatable: splicing the same `content` into an already-spliced document reproduces it byte-for-byte. The caller names its region's pair, since
every generator in the family declares markers of its own and one document may carry several regions.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `source` | `string` | The full document text. |
| `content` | `string` | The content to insert between the markers, the fragment a renderer produced. |
| `markers` | \{ `beginMarker`: `string`; `endMarker`: `string`; \} | - |
| `markers.beginMarker` | `string` | The opening marker to search for. |
| `markers.endMarker` | `string` | The closing marker to search for. |

#### Returns

`string`

`source` with the marked region's contents replaced by `content`.

#### Throws

`Error` naming the offending marker when either marker is absent, when the closing marker precedes the opening marker, or when the document is ambiguous - a
        second begin marker after the first, or a second end marker - since the marked region would not be uniquely identified.
