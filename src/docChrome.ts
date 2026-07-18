/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * docChrome.ts: Pure, isomorphic renderers that project a per-plugin documentation-chrome manifest into the masthead, navigation index, dashboard badges, and project
 * list that every family plugin repeats by hand across its README, its docs, and its webUI.
 */

/**
 * A shared documentation-chrome renderer for the family's plugins.
 *
 * Every plugin hand-maintains the same "chrome" in many places: a multi-line badge/logo masthead byte-copied to the top of the README and every content doc, and an
 * ordered documentation index (each doc's title plus a one-line blurb) duplicated between the README's documentation section and the webUI's Support tab. Those copies
 * drift - a badge label here, a blurb there, an href form that differs per surface. This module collapses all of it into one per-plugin {@link DocChromeManifest} that a
 * plugin authors once (as a typed module or a static JSON file), so each surface becomes a pure projection of a single source of truth.
 *
 * The module exports pure string renderers - {@link renderMasthead}, {@link renderDocIndex}, {@link renderDevBadges}, {@link renderProjects} - and the marker constants
 * each surface embeds, plus the {@link parseDocChromeManifest} / {@link parseProjectEntries} validators. Like `featureOptions-docs.ts`, every function here is pure and
 * isomorphic: no `node:` imports, no `fs`, no `fetch`. Reading the target files, resolving a remote project list, and writing the spliced result back are the CLI's
 * concern; this module only ever renders already-resolved data. That keeps it browser-safe and trivially testable, though it is a tooling concern and is deliberately
 * NOT mirrored into `dist/ui/`.
 *
 * @module
 */

/**
 * Repository coordinates used to derive the GitHub blob URLs that navigation entries link to. The blob base is `https://github.com/{owner}/{name}/blob/{branch}`.
 *
 * @category Doc Chrome
 */
export interface RepoCoordinates {

  readonly branch: string;
  readonly name: string;
  readonly owner: string;
}

/**
 * A single shields-style badge: its alt text, its image URL, and the URL it links to. Stored as a full image URL rather than assembled from parts so the manifest stays
 * provider-agnostic - any badge service works, not just shields.io.
 *
 * @category Doc Chrome
 */
export interface Badge {

  readonly alt: string;
  readonly image: string;
  readonly link: string;
}

/**
 * The masthead: the centered logo, the H1 title, the ordered badge row, and the H2 tagline. Rendered identically into the README and every content doc. Text fields are
 * author-owned markup (the tagline may contain markdown links) and pass through verbatim.
 *
 * @category Doc Chrome
 */
export interface Masthead {

  readonly badges: readonly Badge[];
  readonly logo: { readonly alt: string; readonly href: string; readonly src: string };
  readonly tagline: string;
  readonly title: string;
}

/**
 * One documentation-index entry. A discriminated union on `kind`: a `"doc"` entry points at a file under the plugin's `docs/` tree (and may opt out of the masthead via
 * `masthead: false`, or of the documentation-footer region via `footer: false` - with both opted out, a linked file such as the changelog stays entirely free of stamped
 * chrome while remaining listed in every documentation index), while a `"readme-anchor"` entry points at a section anchor within the README itself. The renderer derives
 * the correct href
 * per surface from this one canonical shape, so the same entry can render as an in-README anchor on the README and as an absolute blob URL everywhere else.
 *
 * @category Doc Chrome
 */
export type DocEntry =
  { readonly anchor: string; readonly blurb: string; readonly kind: "readme-anchor"; readonly title: string } |
  { readonly blurb: string; readonly file: string; readonly footer?: boolean; readonly kind: "doc"; readonly masthead?: boolean; readonly title: string };

/**
 * A named, ordered group of documentation entries (for example "Getting Started" or "Additional Topics"). Sections render in array order, and entries within a section
 * render in array order.
 *
 * @category Doc Chrome
 */
export interface NavSection {

  readonly entries: readonly DocEntry[];
  readonly title: string;
}

/**
 * One "other projects" entry for the webUI's project list. The rendered link text is `{title}: {blurb}`.
 *
 * @category Doc Chrome
 */
export interface ProjectEntry {

  readonly blurb: string;
  readonly href: string;
  readonly title: string;
}

/**
 * A manifest fragment whose data may be supplied inline (an array), read from a local file relative to the plugin root (`{ file }`), or fetched from a URL at stamp time
 * (`{ url }`). The CLI resolves these; the renderers only ever see the resolved inline array. The URL form is what lets a family-wide list (the project list) live in one
 * external file that every plugin's next build pulls from, without baking that list into this generic library.
 *
 * @category Doc Chrome
 */
export type ExternalSource<T> = readonly T[] | { readonly file: string } | { readonly url: string };

/**
 * The per-plugin documentation-chrome manifest - the single source of truth for a plugin's masthead, documentation index, dashboard badges, and project list. Authored
 * once per plugin (a typed TS module or a static JSON file) and consumed by the `prepare-chrome` CLI subcommand.
 *
 * @category Doc Chrome
 */
export interface DocChromeManifest {

  readonly devBadges?: readonly Badge[];
  readonly masthead: Masthead;
  readonly nav: readonly NavSection[];
  readonly projects?: ExternalSource<ProjectEntry>;
  readonly repo: RepoCoordinates;
  readonly surfaces?: { readonly readme?: string; readonly webui?: string };
}

/**
 * The surface a documentation index is rendered for. `"readme"` and `"doc-footer"` both render markdown; `"webui"` renders HTML. The surface also selects href
 * derivation: `"readme"` uses in-README section anchors for `readme-anchor` entries, while `"doc-footer"` and `"webui"` use absolute blob URLs (an anchor entry viewed
 * from anywhere other than the README itself must resolve to the README's absolute URL). Only `"doc-footer"` omits the current document from its own list.
 *
 * @category Doc Chrome
 */
export type NavSurface = "doc-footer" | "readme" | "webui";

/**
 * The opening marker of the auto-generated masthead region. See {@link renderMasthead}. The text doubles as an in-document warning not to edit the region by hand.
 *
 * @category Doc Chrome
 */
export const MASTHEAD_BEGIN = "<!-- MASTHEAD:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";

/**
 * The closing marker of the auto-generated masthead region. See {@link MASTHEAD_BEGIN}.
 *
 * @category Doc Chrome
 */
export const MASTHEAD_END = "<!-- MASTHEAD:END -->";

/**
 * The opening marker of the auto-generated documentation-index region, used in the README's documentation section, each content doc's footer, and the webUI's Support
 * tab. See {@link renderDocIndex}.
 *
 * @category Doc Chrome
 */
export const DOCUMENTATION_BEGIN = "<!-- DOCUMENTATION:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";

/**
 * The closing marker of the auto-generated documentation-index region. See {@link DOCUMENTATION_BEGIN}.
 *
 * @category Doc Chrome
 */
export const DOCUMENTATION_END = "<!-- DOCUMENTATION:END -->";

/**
 * The opening marker of the auto-generated development-dashboard badge region (README only). See {@link renderDevBadges}.
 *
 * @category Doc Chrome
 */
export const DEV_BADGES_BEGIN = "<!-- DEV BADGES:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";

/**
 * The closing marker of the auto-generated development-dashboard badge region. See {@link DEV_BADGES_BEGIN}.
 *
 * @category Doc Chrome
 */
export const DEV_BADGES_END = "<!-- DEV BADGES:END -->";

/**
 * The opening marker of the auto-generated project-list region (webUI only). See {@link renderProjects}.
 *
 * @category Doc Chrome
 */
export const PROJECTS_BEGIN = "<!-- PROJECTS:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";

/**
 * The closing marker of the auto-generated project-list region. See {@link PROJECTS_BEGIN}.
 *
 * @category Doc Chrome
 */
export const PROJECTS_END = "<!-- PROJECTS:END -->";

// Escape text destined for an HTML text node. We neutralize "&", "<", and ">" so a blurb containing any of them renders as literal text rather than being parsed as
// markup. "&" is replaced first so the entities we introduce are not themselves re-escaped. This applies only to the webUI (HTML) surface; the markdown surfaces embed
// author-owned prose verbatim, matching the hand-authored source the renderer reproduces.
function escapeHtmlText(text: string): string {

  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Escape a value destined for a double-quoted HTML attribute (an href). It builds on the text-node escaping - the shared single source of truth for the "&"/"<"/">"
// entities - and adds the double quote that would otherwise terminate the attribute early. The quote substitution runs after the text escaping, so the "&" it introduces
// is not itself re-escaped.
function escapeHtmlAttr(value: string): string {

  return escapeHtmlText(value).replaceAll("\"", "&quot;");
}

// The absolute GitHub blob base for a repository, the prefix every non-local navigation href is built on.
function blobBaseUrl(repo: RepoCoordinates): string {

  return "https://github.com/" + repo.owner + "/" + repo.name + "/blob/" + repo.branch;
}

// Render a single badge as a linked markdown image, the shape both the masthead and the dashboard badges share.
function renderBadge(badge: Badge): string {

  return "[![" + badge.alt + "](" + badge.image + ")](" + badge.link + ")";
}

// Derive the href for a documentation entry on a given surface. On the README itself a `readme-anchor` entry is an in-page anchor; viewed from anywhere else it must
// resolve to the README's absolute blob URL. A `doc` entry is always an absolute blob URL to its file, identical on every surface - which is what collapses the
// per-surface href drift the hand-maintained lists suffer from.
function docEntryHref(entry: DocEntry, repo: RepoCoordinates, local: boolean): string {

  if(entry.kind === "readme-anchor") {

    return local ? ("#" + entry.anchor) : (blobBaseUrl(repo) + "/README.md#" + entry.anchor);
  }

  return blobBaseUrl(repo) + "/" + entry.file;
}

/**
 * Render the masthead - the centered logo, the H1 title, the ordered badge row, and the H2 tagline - as the markdown/HTML block a plugin embeds at the top of its README
 * and every content doc. The block is identical across those surfaces, so a single manifest drives all of them and the hand-copied mastheads collapse to one.
 *
 * @param manifest - The documentation-chrome manifest.
 *
 * @returns The rendered masthead block.
 *
 * @category Doc Chrome
 */
export function renderMasthead(manifest: DocChromeManifest): string {

  const { badges, logo, tagline, title } = manifest.masthead;

  // Assemble the block line by line: the centering wrapper, the linked logo image, the title, one linked badge image per badge, and the tagline. A pushed empty string
  // is a blank line, keeping the vertical rhythm explicit rather than threading "\n\n" through concatenations.
  const lines = [

    "<SPAN ALIGN=\"CENTER\" STYLE=\"text-align:center\">",
    "<DIV ALIGN=\"CENTER\" STYLE=\"text-align:center\">",
    "",
    "[![" + logo.alt + "](" + logo.src + ")](" + logo.href + ")",
    "",
    "# " + title,
    "",
    ...badges.map(renderBadge),
    "",
    "## " + tagline,
    "</DIV>",
    "</SPAN>"
  ];

  return lines.join("\n");
}

/**
 * Render the development-dashboard badges - the README-only badge row (license, build status, dependencies, and the like) that sits apart from the masthead. Returns an
 * empty string when the manifest declares no dashboard badges.
 *
 * @param manifest - The documentation-chrome manifest.
 *
 * @returns The rendered badge rows, one badge per line.
 *
 * @category Doc Chrome
 */
export function renderDevBadges(manifest: DocChromeManifest): string {

  return (manifest.devBadges ?? []).map(renderBadge).join("\n");
}

/**
 * Render the documentation index for a surface. On the markdown surfaces (`"readme"`, `"doc-footer"`) the output is one bullet per section with a nested bullet per
 * entry; on `"webui"` it is one `<h5>` heading and `<ul>` per section. Href derivation follows the surface: in-README anchors on `"readme"`, absolute blob URLs
 * elsewhere. A `"doc-footer"` render omits the current document (via `currentFile`) and drops any section left empty by that omission, so a doc's own footer never links
 * back to itself.
 *
 * @param input
 * @param input.currentFile - The doc file being rendered into, relative to the plugin root. Only consulted for the `"doc-footer"` surface, to omit the self-link.
 * @param input.manifest    - The documentation-chrome manifest.
 * @param input.surface     - The surface to render for.
 *
 * @returns The rendered documentation index.
 *
 * @category Doc Chrome
 */
export function renderDocIndex({ currentFile, manifest, surface }: { currentFile?: string; manifest: DocChromeManifest; surface: NavSurface }): string {

  if(surface === "webui") {

    // The webUI surface renders HTML and never omits a self-link (it is not itself a doc). Each entry links to an absolute blob URL.
    const sections = manifest.nav.map((section) => {

      const items = section.entries.map((entry) => {

        return "  <li><a target=\"_blank\" href=\"" + escapeHtmlAttr(docEntryHref(entry, manifest.repo, false)) + "\">" + escapeHtmlText(entry.title) + "</a>: " +
          escapeHtmlText(entry.blurb) + "</li>";
      });

      return "<h5>" + escapeHtmlText(section.title) + "</h5>\n<ul dir=\"auto\">\n" + items.join("\n") + "\n</ul>";
    });

    return sections.join("\n\n");
  }

  // The markdown surfaces. `"readme"` uses in-page anchors for anchor entries; `"doc-footer"` uses absolute URLs and omits the current doc.
  const local = surface === "readme";
  const omitFile = (surface === "doc-footer") ? currentFile : undefined;
  const sections: string[] = [];

  for(const section of manifest.nav) {

    const bullets = section.entries
      .filter((entry) => !((entry.kind === "doc") && (entry.file === omitFile)))
      .map((entry) => "  * [" + entry.title + "](" + docEntryHref(entry, manifest.repo, local) + "): " + entry.blurb);

    // Drop a section that the self-omission emptied, so a footer never renders a heading with no entries beneath it.
    if(bullets.length === 0) {

      continue;
    }

    sections.push([ "* " + section.title, ...bullets ].join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * Render the webUI project list - the "other projects" links - as an HTML `<ul>`. The CLI resolves the manifest's project source (inline, local file, or remote URL) to
 * this array before calling; the renderer never performs I/O. Entries are rendered in alphabetical order by title, so the list reads predictably no matter what order the
 * source - often a shared, remotely-fetched file every plugin points at - happens to hold. Each entry's link text is `{title}: {blurb}`.
 *
 * @param projects - The resolved project entries. Their order is not significant; the renderer sorts them by title.
 *
 * @returns The rendered project list.
 *
 * @category Doc Chrome
 */
export function renderProjects(projects: readonly ProjectEntry[]): string {

  // Sort a copy by lowercased title so the output is alphabetical and consistent regardless of the source order, without disturbing the caller's array. We compare
  // lowercased titles directly rather than through localeCompare so the ordering is identical on every build machine, independent of the host's locale.
  const ordered = projects.toSorted((left, right) => {

    const leftTitle = left.title.toLowerCase();
    const rightTitle = right.title.toLowerCase();

    if(leftTitle < rightTitle) {

      return -1;
    }

    if(leftTitle > rightTitle) {

      return 1;
    }

    return 0;
  });

  const items = ordered.map((project) => {

    return "  <li><a target=\"_blank\" href=\"" + escapeHtmlAttr(project.href) + "\">" + escapeHtmlText(project.title) + ": " +
      escapeHtmlText(project.blurb) + "</a></li>";
  });

  return "<ul dir=\"auto\">\n" + items.join("\n") + "\n</ul>";
}

// Throw a uniformly framed validation error naming the manifest source and the offending path, mirroring the diagnostics the catalog validation in the CLI produces.
function fail(source: string, detail: string): never {

  throw new Error("Doc-chrome manifest " + source + " " + detail + ".");
}

// Assert that a value is a non-empty string at a named path, else fail with a framed diagnostic.
function assertString(value: unknown, path: string, source: string): asserts value is string {

  if((typeof value !== "string") || (value.length === 0)) {

    fail(source, "field `" + path + "` must be a non-empty string");
  }
}

// Validate a badge's shape. Shared by the masthead badges and the optional dashboard badges.
function assertBadge(value: unknown, path: string, source: string): void {

  if((typeof value !== "object") || (value === null)) {

    fail(source, "field `" + path + "` must be an object");
  }

  const badge = value as { alt?: unknown; image?: unknown; link?: unknown };

  assertString(badge.alt, path + ".alt", source);
  assertString(badge.image, path + ".image", source);
  assertString(badge.link, path + ".link", source);
}

// Validate one documentation entry. The `kind` tag selects which additional field is required.
function assertDocEntry(value: unknown, path: string, source: string): void {

  if((typeof value !== "object") || (value === null)) {

    fail(source, "field `" + path + "` must be an object");
  }

  const entry = value as { anchor?: unknown; blurb?: unknown; file?: unknown; footer?: unknown; kind?: unknown; masthead?: unknown; title?: unknown };

  assertString(entry.title, path + ".title", source);
  assertString(entry.blurb, path + ".blurb", source);

  switch(entry.kind) {

    case "doc": {

      assertString(entry.file, path + ".file", source);

      if((entry.footer !== undefined) && (typeof entry.footer !== "boolean")) {

        fail(source, "field `" + path + ".footer` must be a boolean when present");
      }

      if((entry.masthead !== undefined) && (typeof entry.masthead !== "boolean")) {

        fail(source, "field `" + path + ".masthead` must be a boolean when present");
      }

      return;
    }

    case "readme-anchor": {

      assertString(entry.anchor, path + ".anchor", source);

      return;
    }

    default: {

      fail(source, "field `" + path + ".kind` must be \"doc\" or \"readme-anchor\"");
    }
  }
}

/**
 * Validate a loaded value and return it typed as a well-formed {@link DocChromeManifest}, failing fast with a framed diagnostic that names the manifest source and the
 * offending field rather than surfacing an opaque error deep inside a renderer or a bare `resolve()` type error in the CLI. Validates every field the renderer or the
 * CLI consumes - `masthead`, `nav`, `repo`, and the optional `devBadges` and `surfaces`. The project source is validated separately at resolution time, since it may be
 * a remote reference rather than inline data.
 *
 * @param value  - The loaded manifest value, untrusted until validated.
 * @param source - The manifest's path or module specifier, for diagnostics.
 *
 * @returns The same value, now typed as a validated {@link DocChromeManifest}.
 *
 * @category Doc Chrome
 */
export function parseDocChromeManifest(value: unknown, source: string): DocChromeManifest {

  if((typeof value !== "object") || (value === null)) {

    fail(source, "must export a manifest object");
  }

  const manifest = value as { devBadges?: unknown; masthead?: unknown; nav?: unknown; repo?: unknown; surfaces?: unknown };

  // The masthead and its nested logo and badge row.
  if((typeof manifest.masthead !== "object") || (manifest.masthead === null)) {

    fail(source, "field `masthead` must be an object");
  }

  const masthead = manifest.masthead as { badges?: unknown; logo?: unknown; tagline?: unknown; title?: unknown };

  assertString(masthead.title, "masthead.title", source);
  assertString(masthead.tagline, "masthead.tagline", source);

  if((typeof masthead.logo !== "object") || (masthead.logo === null)) {

    fail(source, "field `masthead.logo` must be an object");
  }

  const logo = masthead.logo as { alt?: unknown; href?: unknown; src?: unknown };

  assertString(logo.alt, "masthead.logo.alt", source);
  assertString(logo.href, "masthead.logo.href", source);
  assertString(logo.src, "masthead.logo.src", source);

  if(!Array.isArray(masthead.badges)) {

    fail(source, "field `masthead.badges` must be an array");
  }

  for(const [ index, badge ] of masthead.badges.entries()) {

    assertBadge(badge, "masthead.badges[" + String(index) + "]", source);
  }

  // The repository coordinates.
  if((typeof manifest.repo !== "object") || (manifest.repo === null)) {

    fail(source, "field `repo` must be an object");
  }

  const repo = manifest.repo as { branch?: unknown; name?: unknown; owner?: unknown };

  assertString(repo.branch, "repo.branch", source);
  assertString(repo.name, "repo.name", source);
  assertString(repo.owner, "repo.owner", source);

  // The navigation sections and their entries.
  if(!Array.isArray(manifest.nav)) {

    fail(source, "field `nav` must be an array");
  }

  for(const [ sectionIndex, section ] of manifest.nav.entries()) {

    if((typeof section !== "object") || (section === null)) {

      fail(source, "field `nav[" + String(sectionIndex) + "]` must be an object");
    }

    const navSection = section as { entries?: unknown; title?: unknown };

    assertString(navSection.title, "nav[" + String(sectionIndex) + "].title", source);

    if(!Array.isArray(navSection.entries)) {

      fail(source, "field `nav[" + String(sectionIndex) + "].entries` must be an array");
    }

    for(const [ entryIndex, entry ] of navSection.entries.entries()) {

      assertDocEntry(entry, "nav[" + String(sectionIndex) + "].entries[" + String(entryIndex) + "]", source);
    }
  }

  // The optional dashboard badges.
  if(manifest.devBadges !== undefined) {

    if(!Array.isArray(manifest.devBadges)) {

      fail(source, "field `devBadges` must be an array when present");
    }

    for(const [ index, badge ] of manifest.devBadges.entries()) {

      assertBadge(badge, "devBadges[" + String(index) + "]", source);
    }
  }

  // The optional per-surface path overrides. These are consumed by the CLI's `resolve()` calls, so validating them here keeps the framed-diagnostic guarantee whole for
  // a JSON-authored manifest that could otherwise smuggle a non-string path past the type system.
  if(manifest.surfaces !== undefined) {

    if((typeof manifest.surfaces !== "object") || (manifest.surfaces === null)) {

      fail(source, "field `surfaces` must be an object when present");
    }

    const surfaces = manifest.surfaces as { readme?: unknown; webui?: unknown };

    if((surfaces.readme !== undefined) && ((typeof surfaces.readme !== "string") || (surfaces.readme.length === 0))) {

      fail(source, "field `surfaces.readme` must be a non-empty string when present");
    }

    if((surfaces.webui !== undefined) && ((typeof surfaces.webui !== "string") || (surfaces.webui.length === 0))) {

      fail(source, "field `surfaces.webui` must be a non-empty string when present");
    }
  }

  return value as DocChromeManifest;
}

/**
 * Validate a resolved project source and return it typed as an array of {@link ProjectEntry}. The CLI calls this after resolving the manifest's project source - which
 * may be inline data, a local file, or a remote URL - so a malformed external list fails fast with a framed diagnostic naming the source rather than rendering broken
 * markup.
 *
 * @param value  - The resolved project value, untrusted until validated.
 * @param source - The project source (a path or URL) for diagnostics.
 *
 * @returns The same value, now typed as a validated array of {@link ProjectEntry}.
 *
 * @category Doc Chrome
 */
export function parseProjectEntries(value: unknown, source: string): readonly ProjectEntry[] {

  if(!Array.isArray(value)) {

    fail(source, "project source must resolve to an array of project entries");
  }

  for(const [ index, entry ] of value.entries()) {

    if((typeof entry !== "object") || (entry === null)) {

      fail(source, "project entry [" + String(index) + "] must be an object");
    }

    const project = entry as { blurb?: unknown; href?: unknown; title?: unknown };

    assertString(project.blurb, "project entry [" + String(index) + "].blurb", source);
    assertString(project.href, "project entry [" + String(index) + "].href", source);
    assertString(project.title, "project entry [" + String(index) + "].title", source);
  }

  return value as readonly ProjectEntry[];
}
