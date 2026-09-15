/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doc-markdown.ts: The markdown mechanics every documentation generator composes over - the marked-region splice and the padded-column table.
 */

/**
 * The markdown mechanics every documentation generator in the family composes over: the in-place splice of a marked region, and the markdown table with padded
 * columns.
 *
 * Both are domain-free by design. A generator owns what its catalog holds, what a row says, and which marker pair frames its region; it reaches here for the two
 * mechanics that are the same whatever the domain, so two documents that share no subject matter still print tables a reader recognizes as one family's and still
 * regenerate through one splice.
 *
 * The module exports two pure string functions:
 *
 *   - {@link renderMarkdownTable} - the table layout: the single width pass over every column but the last, the divider, and the row template.
 *
 *   - {@link spliceMarkedRegion} - the in-place splice that replaces the region between a caller-named marker pair in an existing document with freshly rendered
 *     content, leaving the hand-written prose around it untouched.
 *
 * Both are pure and isomorphic: no `node:` imports, no `fs`, no `process`. The only I/O - reading a document and writing it back - belongs to the CLI verb that
 * drives a generator, which is inherently a tooling concern. This module is therefore browser-safe and trivially testable, but it is a tooling concern and is
 * deliberately NOT mirrored into `dist/ui/` by the build pipeline.
 *
 * @module
 */

// One trailing space of breathing room added to every auto-computed column width so the widest cell does not sit flush against the column separator. Purely cosmetic
// alignment, matching the canonical rendering the family converges on.
const COLUMN_PADDING = 1;

/**
 * The table {@link renderMarkdownTable} lays out.
 *
 * @property dividerWidth - The width, in dashes, of the divider segment under the last column. That column is never padded, so it has no measured width for its
 *                          divider to track and the caller states the one its document reads well at.
 * @property headings     - The column headings, in column order. Their count is what every row's cell count must match.
 * @property rows         - The rows, each one a list of rendered cells in column order.
 *
 * @category Utilities
 */
export interface MarkdownTableInput {

  readonly dividerWidth: number;
  readonly headings: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

// One line of a markdown table - the heading line or a body row. Every cell whose column carries a measured width is padded to it, and the cells are joined by the
// column separator with its single-space gutters. A column with no measured width is the last one, which nothing pads: its text runs to the end of the line.
function renderTableLine(cells: readonly string[], widths: readonly number[]): string {

  return "| " + cells.map((cell, column) => {

    const width = widths[column];

    return (width === undefined) ? cell : cell.padEnd(width);
  }).join(" | ");
}

/**
 * Render a markdown table: a heading line, a divider line, and one line per row, with every column but the last padded to the widest thing it carries.
 *
 * Each padded column is measured against its own heading and every cell beneath it, then given one trailing space so the widest cell does not sit flush against the
 * separator. The divider draws each padded column over that width plus the two gutters around the cell, and the last column over the caller's fixed width. The last
 * column is deliberately unmeasured: it carries the prose, and padding it would only trail spaces to the end of every line.
 *
 * Cells are measured as the caller renders them. A caller that wraps a cell in markup - a code span, a link, an anchor - measures the markup with the text, which is
 * what keeps the raw source aligned even though the rendered document collapses the padding entirely. Padding is cosmetic; nothing downstream reads it.
 *
 * The returned lines carry no trailing blank: a caller emitting several tables into one fragment decides how they sit against each other, so the framing is the
 * caller's.
 *
 * @param table
 * @param table.dividerWidth - The width, in dashes, of the divider segment under the last column.
 * @param table.headings     - The column headings, in column order.
 * @param table.rows         - The rows, each one a list of rendered cells in column order.
 *
 * @returns The table's lines: the heading line, the divider, then one line per row.
 *
 * @throws `Error` naming a row's index when it carries a different number of cells than the table has headings, since rendering it would shift every column after it.
 *
 * @category Utilities
 */
export function renderMarkdownTable({ dividerWidth, headings, rows }: MarkdownTableInput): readonly string[] {

  // Seed every padded column with its own heading's width. The last heading is left out, which is what marks that column as the unpadded one for the rest of the pass.
  const widths = headings.slice(0, -1).map((heading) => heading.length);

  // One pass over the rows both refuses a mis-shaped row and grows every padded column to its widest cell. A row carrying a different number of cells than the table
  // has headings would shift every column after it and read as a different table, so it is named here rather than rendered.
  for(const [ index, row ] of rows.entries()) {

    if(row.length !== headings.length) {

      throw new Error("renderMarkdownTable: the row at index " + index.toString() + " carries " + row.length.toString() + " cells for " +
        headings.length.toString() + " headings.");
    }

    for(const [ column, cell ] of row.entries()) {

      const width = widths[column];

      if(width !== undefined) {

        widths[column] = Math.max(width, cell.length);
      }
    }
  }

  // The breathing room goes on once the widest cell in each column is known, so the padding is added exactly once per column rather than carried through the pass.
  const paddedWidths = widths.map((width) => width + COLUMN_PADDING);

  // The divider draws each padded column over its width plus the two single-space gutters around the cell, then the last column over the caller's fixed width.
  const divider = paddedWidths.map((width) => "|" + "-".repeat(width + 2)).join("") + "|" + "-".repeat(dividerWidth);

  return [ renderTableLine(headings, paddedWidths), divider, ...rows.map((row) => renderTableLine(row, paddedWidths)) ];
}

/**
 * Replace the region strictly between the begin marker and the end marker in `source` with `content`, leaving both markers and all surrounding prose untouched. This is
 * the pure half of the in-place splice each generator's CLI verb performs; the verb supplies the trivial `readFile` / `writeFile` around it.
 *
 * The replacement inserts a newline before and after `content`, so a marker pair on its own lines stays on its own lines and the rendered fragment is cleanly framed.
 * The operation is repeatable: splicing the same `content` into an already-spliced document reproduces it byte-for-byte. The caller names its region's pair, since
 * every generator in the family declares markers of its own and one document may carry several regions.
 *
 * @param source              - The full document text.
 * @param content             - The content to insert between the markers, the fragment a renderer produced.
 * @param markers
 * @param markers.beginMarker - The opening marker to search for.
 * @param markers.endMarker   - The closing marker to search for.
 *
 * @returns `source` with the marked region's contents replaced by `content`.
 *
 * @throws `Error` naming the offending marker when either marker is absent, when the closing marker precedes the opening marker, or when the document is ambiguous - a
 *         second begin marker after the first, or a second end marker - since the marked region would not be uniquely identified.
 *
 * @category Utilities
 */
export function spliceMarkedRegion(source: string, content: string, { beginMarker, endMarker }: { beginMarker: string; endMarker: string }): string {

  const beginIndex = source.indexOf(beginMarker);

  if(beginIndex === -1) {

    throw new Error("spliceMarkedRegion: begin marker not found in source: \"" + beginMarker + "\".");
  }

  const endIndex = source.indexOf(endMarker);

  if(endIndex === -1) {

    throw new Error("spliceMarkedRegion: end marker not found in source: \"" + endMarker + "\".");
  }

  // The end marker must not begin before the begin marker ends, so the comparison is against the end of the begin marker rather than its start. An end marker that
  // overlaps the begin marker is rejected as malformed rather than producing a negative-length region. One that sits immediately after it splices an empty region...the
  // legitimate state of a fresh marker pair with nothing between it yet.
  const regionStart = beginIndex + beginMarker.length;

  if(endIndex < regionStart) {

    throw new Error("spliceMarkedRegion: end marker \"" + endMarker + "\" precedes begin marker \"" + beginMarker + "\" in source.");
  }

  // Reject an ambiguous document. A second begin marker after the first - or a second end marker anywhere - means the marked region is not uniquely identified, and
  // splicing into the first pair would silently leave the duplicate marker (and any stale content between the duplicates) behind. We search from just past the end of
  // the first occurrence (the `includes` fromIndex argument) so an exact re-find of the same marker is not mistaken for a duplicate.
  if(source.includes(beginMarker, beginIndex + beginMarker.length)) {

    throw new Error("spliceMarkedRegion: multiple begin markers found in source; the marked region is ambiguous.");
  }

  if(source.includes(endMarker, endIndex + endMarker.length)) {

    throw new Error("spliceMarkedRegion: multiple end markers found in source; the marked region is ambiguous.");
  }

  // Reassemble: everything up to and including the begin marker, a newline-framed copy of the new content, then everything from the end marker onward.
  return source.slice(0, regionStart) + "\n" + content + "\n" + source.slice(endIndex);
}
