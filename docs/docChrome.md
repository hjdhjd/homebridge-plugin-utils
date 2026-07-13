[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / docChrome

# docChrome

A shared documentation-chrome renderer for the family's plugins.

Every plugin hand-maintains the same "chrome" in many places: a multi-line badge/logo masthead byte-copied to the top of the README and every content doc, and an
ordered documentation index (each doc's title plus a one-line blurb) duplicated between the README's documentation section and the webUI's Support tab. Those copies
drift - a badge label here, a blurb there, an href form that differs per surface. This module collapses all of it into one per-plugin [DocChromeManifest](#docchromemanifest) that a
plugin authors once (as a typed module or a static JSON file), so each surface becomes a pure projection of a single source of truth.

The module exports pure string renderers - [renderMasthead](#rendermasthead), [renderDocIndex](#renderdocindex), [renderDevBadges](#renderdevbadges), [renderProjects](#renderprojects) - and the marker constants
each surface embeds, plus the [parseDocChromeManifest](#parsedocchromemanifest) / [parseProjectEntries](#parseprojectentries) validators. Like `featureOptions-docs.ts`, every function here is pure and
isomorphic: no `node:` imports, no `fs`, no `fetch`. Reading the target files, resolving a remote project list, and writing the spliced result back are the CLI's
concern; this module only ever renders already-resolved data. That keeps it browser-safe and trivially testable, though it is a tooling concern and is deliberately
NOT mirrored into `dist/ui/`.

## Doc Chrome

### Badge

A single shields-style badge: its alt text, its image URL, and the URL it links to. Stored as a full image URL rather than assembled from parts so the manifest stays
provider-agnostic - any badge service works, not just shields.io.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="alt"></a> `alt` | `readonly` | `string` |
| <a id="image"></a> `image` | `readonly` | `string` |
| <a id="link"></a> `link` | `readonly` | `string` |

***

### DocChromeManifest

The per-plugin documentation-chrome manifest - the single source of truth for a plugin's masthead, documentation index, dashboard badges, and project list. Authored
once per plugin (a typed TS module or a static JSON file) and consumed by the `prepare-chrome` CLI subcommand.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="devbadges"></a> `devBadges?` | `readonly` | readonly [`Badge`](#badge)[] |
| <a id="masthead"></a> `masthead` | `readonly` | [`Masthead`](#masthead-1) |
| <a id="nav"></a> `nav` | `readonly` | readonly [`NavSection`](#navsection)[] |
| <a id="projects"></a> `projects?` | `readonly` | [`ExternalSource`](#externalsource)\<[`ProjectEntry`](#projectentry)\> |
| <a id="repo"></a> `repo` | `readonly` | [`RepoCoordinates`](#repocoordinates) |
| <a id="surfaces"></a> `surfaces?` | `readonly` | \{ `readme?`: `string`; `webui?`: `string`; \} |
| `surfaces.readme?` | `readonly` | `string` |
| `surfaces.webui?` | `readonly` | `string` |

***

### Masthead

The masthead: the centered logo, the H1 title, the ordered badge row, and the H2 tagline. Rendered identically into the README and every content doc. Text fields are
author-owned markup (the tagline may contain markdown links) and pass through verbatim.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="badges"></a> `badges` | `readonly` | readonly [`Badge`](#badge)[] |
| <a id="logo"></a> `logo` | `readonly` | \{ `alt`: `string`; `href`: `string`; `src`: `string`; \} |
| `logo.alt` | `readonly` | `string` |
| `logo.href` | `readonly` | `string` |
| `logo.src` | `readonly` | `string` |
| <a id="tagline"></a> `tagline` | `readonly` | `string` |
| <a id="title"></a> `title` | `readonly` | `string` |

***

### NavSection

A named, ordered group of documentation entries (for example "Getting Started" or "Additional Topics"). Sections render in array order, and entries within a section
render in array order.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="entries"></a> `entries` | `readonly` | readonly [`DocEntry`](#docentry)[] |
| <a id="title-1"></a> `title` | `readonly` | `string` |

***

### ProjectEntry

One "other projects" entry for the webUI's project list. The rendered link text is `{title}: {blurb}`.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="blurb"></a> `blurb` | `readonly` | `string` |
| <a id="href"></a> `href` | `readonly` | `string` |
| <a id="title-2"></a> `title` | `readonly` | `string` |

***

### RepoCoordinates

Repository coordinates used to derive the GitHub blob URLs that navigation entries link to. The blob base is `https://github.com/{owner}/{name}/blob/{branch}`.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="branch"></a> `branch` | `readonly` | `string` |
| <a id="name"></a> `name` | `readonly` | `string` |
| <a id="owner"></a> `owner` | `readonly` | `string` |

***

### DocEntry

```ts
type DocEntry = 
  | {
  anchor: string;
  blurb: string;
  kind: "readme-anchor";
  title: string;
}
  | {
  blurb: string;
  file: string;
  kind: "doc";
  masthead?: boolean;
  title: string;
};
```

One documentation-index entry. A discriminated union on `kind`: a `"doc"` entry points at a file under the plugin's `docs/` tree (and may opt out of the masthead via
`masthead: false`, as the changelog does), while a `"readme-anchor"` entry points at a section anchor within the README itself. The renderer derives the correct href
per surface from this one canonical shape, so the same entry can render as an in-README anchor on the README and as an absolute blob URL everywhere else.

***

### ExternalSource

```ts
type ExternalSource<T> = 
  | readonly T[]
  | {
  file: string;
}
  | {
  url: string;
};
```

A manifest fragment whose data may be supplied inline (an array), read from a local file relative to the plugin root (`{ file }`), or fetched from a URL at stamp time
(`{ url }`). The CLI resolves these; the renderers only ever see the resolved inline array. The URL form is what lets a family-wide list (the project list) live in one
external file that every plugin's next build pulls from, without baking that list into this generic library.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

***

### NavSurface

```ts
type NavSurface = "doc-footer" | "readme" | "webui";
```

The surface a documentation index is rendered for. `"readme"` and `"doc-footer"` both render markdown; `"webui"` renders HTML. The surface also selects href
derivation: `"readme"` uses in-README section anchors for `readme-anchor` entries, while `"doc-footer"` and `"webui"` use absolute blob URLs (an anchor entry viewed
from anywhere other than the README itself must resolve to the README's absolute URL). Only `"doc-footer"` omits the current document from its own list.

***

### DEV\_BADGES\_BEGIN

```ts
const DEV_BADGES_BEGIN: "<!-- DEV BADGES:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->" = "<!-- DEV BADGES:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";
```

The opening marker of the auto-generated development-dashboard badge region (README only). See [renderDevBadges](#renderdevbadges).

***

### DEV\_BADGES\_END

```ts
const DEV_BADGES_END: "<!-- DEV BADGES:END -->" = "<!-- DEV BADGES:END -->";
```

The closing marker of the auto-generated development-dashboard badge region. See [DEV\_BADGES\_BEGIN](#dev_badges_begin).

***

### DOCUMENTATION\_BEGIN

```ts
const DOCUMENTATION_BEGIN: "<!-- DOCUMENTATION:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->" = "<!-- DOCUMENTATION:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";
```

The opening marker of the auto-generated documentation-index region, used in the README's documentation section, each content doc's footer, and the webUI's Support
tab. See [renderDocIndex](#renderdocindex).

***

### DOCUMENTATION\_END

```ts
const DOCUMENTATION_END: "<!-- DOCUMENTATION:END -->" = "<!-- DOCUMENTATION:END -->";
```

The closing marker of the auto-generated documentation-index region. See [DOCUMENTATION\_BEGIN](#documentation_begin).

***

### MASTHEAD\_BEGIN

```ts
const MASTHEAD_BEGIN: "<!-- MASTHEAD:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->" = "<!-- MASTHEAD:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";
```

The opening marker of the auto-generated masthead region. See [renderMasthead](#rendermasthead). The text doubles as an in-document warning not to edit the region by hand.

***

### MASTHEAD\_END

```ts
const MASTHEAD_END: "<!-- MASTHEAD:END -->" = "<!-- MASTHEAD:END -->";
```

The closing marker of the auto-generated masthead region. See [MASTHEAD\_BEGIN](#masthead_begin).

***

### PROJECTS\_BEGIN

```ts
const PROJECTS_BEGIN: "<!-- PROJECTS:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->" = "<!-- PROJECTS:BEGIN - Auto-generated by homebridge-plugin-utils. Do not edit this region by hand. -->";
```

The opening marker of the auto-generated project-list region (webUI only). See [renderProjects](#renderprojects).

***

### PROJECTS\_END

```ts
const PROJECTS_END: "<!-- PROJECTS:END -->" = "<!-- PROJECTS:END -->";
```

The closing marker of the auto-generated project-list region. See [PROJECTS\_BEGIN](#projects_begin).

***

### parseDocChromeManifest()

```ts
function parseDocChromeManifest(value, source): DocChromeManifest;
```

Validate a loaded value and return it typed as a well-formed [DocChromeManifest](#docchromemanifest), failing fast with a framed diagnostic that names the manifest source and the
offending field rather than surfacing an opaque error deep inside a renderer or a bare `resolve()` type error in the CLI. Validates every field the renderer or the
CLI consumes - `masthead`, `nav`, `repo`, and the optional `devBadges` and `surfaces`. The project source is validated separately at resolution time, since it may be
a remote reference rather than inline data.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `unknown` | The loaded manifest value, untrusted until validated. |
| `source` | `string` | The manifest's path or module specifier, for diagnostics. |

#### Returns

[`DocChromeManifest`](#docchromemanifest)

The same value, now typed as a validated [DocChromeManifest](#docchromemanifest).

***

### parseProjectEntries()

```ts
function parseProjectEntries(value, source): readonly ProjectEntry[];
```

Validate a resolved project source and return it typed as an array of [ProjectEntry](#projectentry). The CLI calls this after resolving the manifest's project source - which
may be inline data, a local file, or a remote URL - so a malformed external list fails fast with a framed diagnostic naming the source rather than rendering broken
markup.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `unknown` | The resolved project value, untrusted until validated. |
| `source` | `string` | The project source (a path or URL) for diagnostics. |

#### Returns

readonly [`ProjectEntry`](#projectentry)[]

The same value, now typed as a validated array of [ProjectEntry](#projectentry).

***

### renderDevBadges()

```ts
function renderDevBadges(manifest): string;
```

Render the development-dashboard badges - the README-only badge row (license, build status, dependencies, and the like) that sits apart from the masthead. Returns an
empty string when the manifest declares no dashboard badges.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `manifest` | [`DocChromeManifest`](#docchromemanifest) | The documentation-chrome manifest. |

#### Returns

`string`

The rendered badge rows, one badge per line.

***

### renderDocIndex()

```ts
function renderDocIndex(input): string;
```

Render the documentation index for a surface. On the markdown surfaces (`"readme"`, `"doc-footer"`) the output is one bullet per section with a nested bullet per
entry; on `"webui"` it is one `<h5>` heading and `<ul>` per section. Href derivation follows the surface: in-README anchors on `"readme"`, absolute blob URLs
elsewhere. A `"doc-footer"` render omits the current document (via `currentFile`) and drops any section left empty by that omission, so a doc's own footer never links
back to itself.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `input` | \{ `currentFile?`: `string`; `manifest`: [`DocChromeManifest`](#docchromemanifest); `surface`: [`NavSurface`](#navsurface); \} | - |
| `input.currentFile?` | `string` | The doc file being rendered into, relative to the plugin root. Only consulted for the `"doc-footer"` surface, to omit the self-link. |
| `input.manifest` | [`DocChromeManifest`](#docchromemanifest) | The documentation-chrome manifest. |
| `input.surface` | [`NavSurface`](#navsurface) | The surface to render for. |

#### Returns

`string`

The rendered documentation index.

***

### renderMasthead()

```ts
function renderMasthead(manifest): string;
```

Render the masthead - the centered logo, the H1 title, the ordered badge row, and the H2 tagline - as the markdown/HTML block a plugin embeds at the top of its README
and every content doc. The block is identical across those surfaces, so a single manifest drives all of them and the hand-copied mastheads collapse to one.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `manifest` | [`DocChromeManifest`](#docchromemanifest) | The documentation-chrome manifest. |

#### Returns

`string`

The rendered masthead block.

***

### renderProjects()

```ts
function renderProjects(projects): string;
```

Render the webUI project list - the "other projects" links - as an HTML `<ul>`. The CLI resolves the manifest's project source (inline, local file, or remote URL) to
this array before calling; the renderer never performs I/O. Entries are rendered in alphabetical order by title, so the list reads predictably no matter what order the
source - often a shared, remotely-fetched file every plugin points at - happens to hold. Each entry's link text is `{title}: {blurb}`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `projects` | readonly [`ProjectEntry`](#projectentry)[] | The resolved project entries. Their order is not significant; the renderer sorts them by title. |

#### Returns

`string`

The rendered project list.
