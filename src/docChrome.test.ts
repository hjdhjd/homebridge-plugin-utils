/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * docChrome.test.ts: Unit tests for the shared documentation-chrome renderers - the masthead, documentation index, dashboard badges, and project list projections, plus
 * the manifest and project-entry validators. Coverage pins each surface's canonical output byte-for-byte, proves the per-surface href derivation and HTML escaping,
 * exercises the doc-footer self-omission, and asserts the validators' framed diagnostics for every mis-shaped field.
 */
import type { DocChromeManifest, ProjectEntry } from "./docChrome.ts";
import { describe, test } from "node:test";
import { parseDocChromeManifest, parseProjectEntries, renderDevBadges, renderDocIndex, renderMasthead, renderProjects } from "./docChrome.ts";
import assert from "node:assert/strict";

// The canonical worked-example manifest. Two masthead badges, one dashboard badge, and two nav sections that between them cover every entry kind: a README anchor, a
// plain doc, and a doc whose blurb carries "&" and "<...>" so the markdown-verbatim and HTML-escaped surfaces can be told apart.
const MANIFEST: DocChromeManifest = {

  devBadges: [

    { alt: "License", image: "https://img.example/license.svg", link: "https://example.test/license" }
  ],
  masthead: {

    badges: [

      { alt: "Downloads", image: "https://img.example/dl.svg", link: "https://example.test/npm" },
      { alt: "Version", image: "https://img.example/v.svg", link: "https://example.test/npm" }
    ],
    logo: { alt: "example-plugin: the logo", href: "https://github.com/acme/example-plugin", src: "https://raw.example/logo.svg" },
    tagline: "Complete support using [Homebridge](https://homebridge.io).",
    title: "Example Plugin"
  },
  nav: [

    { entries: [

      { anchor: "installation", blurb: "installing this plugin.", kind: "readme-anchor", title: "Installation" },
      { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", title: "Best Practices" }
    ], title: "Getting Started" },
    { entries: [

      { blurb: "audio & <video> options.", file: "docs/AudioOptions.md", kind: "doc", title: "Audio Options" }
    ], title: "Additional Topics" }
  ],
  repo: { branch: "main", name: "example-plugin", owner: "acme" }
};

// The masthead block, reproduced exactly as the renderer emits it - the exact contract that makes adoption a byte-for-byte marker insertion.
const MASTHEAD_OUTPUT = [

  "<SPAN ALIGN=\"CENTER\" STYLE=\"text-align:center\">",
  "<DIV ALIGN=\"CENTER\" STYLE=\"text-align:center\">",
  "",
  "[![example-plugin: the logo](https://raw.example/logo.svg)](https://github.com/acme/example-plugin)",
  "",
  "# Example Plugin",
  "",
  "[![Downloads](https://img.example/dl.svg)](https://example.test/npm)",
  "[![Version](https://img.example/v.svg)](https://example.test/npm)",
  "",
  "## Complete support using [Homebridge](https://homebridge.io).",
  "</DIV>",
  "</SPAN>"
].join("\n");

// The README documentation index: in-page anchors for anchor entries, absolute blob URLs for docs, blurbs verbatim (markdown surface).
const README_NAV_OUTPUT = [

  "* Getting Started",
  "  * [Installation](#installation): installing this plugin.",
  "  * [Best Practices](https://github.com/acme/example-plugin/blob/main/docs/BestPractices.md): best practices.",
  "",
  "* Additional Topics",
  "  * [Audio Options](https://github.com/acme/example-plugin/blob/main/docs/AudioOptions.md): audio & <video> options."
].join("\n");

// The footer index rendered into docs/AudioOptions.md: the anchor entry now resolves to the README's absolute URL, and the self-entry (Audio Options) is dropped, which
// empties and therefore removes the "Additional Topics" section.
const DOC_FOOTER_OUTPUT = [

  "* Getting Started",
  "  * [Installation](https://github.com/acme/example-plugin/blob/main/README.md#installation): installing this plugin.",
  "  * [Best Practices](https://github.com/acme/example-plugin/blob/main/docs/BestPractices.md): best practices."
].join("\n");

// The webUI documentation index: HTML, absolute URLs everywhere, and the "&"/"<>" blurb HTML-escaped.
const WEBUI_NAV_OUTPUT = [

  "<h5>Getting Started</h5>",
  "<ul dir=\"auto\">",
  "  <li><a target=\"_blank\" href=\"https://github.com/acme/example-plugin/blob/main/README.md#installation\">Installation</a>: installing this plugin.</li>",
  "  <li><a target=\"_blank\" href=\"https://github.com/acme/example-plugin/blob/main/docs/BestPractices.md\">Best Practices</a>: best practices.</li>",
  "</ul>",
  "",
  "<h5>Additional Topics</h5>",
  "<ul dir=\"auto\">",
  "  <li><a target=\"_blank\" href=\"https://github.com/acme/example-plugin/blob/main/docs/AudioOptions.md\">Audio Options</a>: audio &amp; &lt;video&gt; options.</li>",
  "</ul>"
].join("\n");

describe("renderMasthead", () => {

  test("reproduces the canonical masthead block byte-for-byte", () => {

    assert.equal(renderMasthead(MANIFEST), MASTHEAD_OUTPUT);
  });
});

describe("renderDevBadges", () => {

  test("renders one linked badge image per dashboard badge", () => {

    assert.equal(renderDevBadges(MANIFEST), "[![License](https://img.example/license.svg)](https://example.test/license)");
  });

  test("returns an empty string when the manifest declares no dashboard badges", () => {

    const { devBadges: _devBadges, ...withoutDevBadges } = MANIFEST;

    assert.equal(renderDevBadges(withoutDevBadges), "");
  });
});

describe("renderDocIndex", () => {

  test("renders the README surface with in-page anchors and verbatim blurbs", () => {

    assert.equal(renderDocIndex({ manifest: MANIFEST, surface: "readme" }), README_NAV_OUTPUT);
  });

  test("renders the doc-footer surface with absolute URLs and omits the current doc, dropping the emptied section", () => {

    assert.equal(renderDocIndex({ currentFile: "docs/AudioOptions.md", manifest: MANIFEST, surface: "doc-footer" }), DOC_FOOTER_OUTPUT);
  });

  test("renders the webUI surface as HTML with escaped text and absolute URLs", () => {

    assert.equal(renderDocIndex({ manifest: MANIFEST, surface: "webui" }), WEBUI_NAV_OUTPUT);
  });

  test("the webUI surface ignores currentFile and never omits a self-link", () => {

    assert.equal(renderDocIndex({ currentFile: "docs/AudioOptions.md", manifest: MANIFEST, surface: "webui" }), WEBUI_NAV_OUTPUT);
  });
});

describe("renderProjects", () => {

  test("renders the project list as an HTML unordered list with escaped link text", () => {

    const projects: ProjectEntry[] = [

      { blurb: "garage door & gate support.", href: "https://github.com/acme/ratgdo", title: "ratgdo" }
    ];

    const expected = [

      "<ul dir=\"auto\">",
      "  <li><a target=\"_blank\" href=\"https://github.com/acme/ratgdo\">ratgdo: garage door &amp; gate support.</a></li>",
      "</ul>"
    ].join("\n");

    assert.equal(renderProjects(projects), expected);
  });

  test("orders entries alphabetically by title regardless of source order, case-insensitively", () => {

    const projects: ProjectEntry[] = [

      { blurb: "z.", href: "https://x/z", title: "Zebra" },
      { blurb: "a.", href: "https://x/a", title: "apple" },
      { blurb: "m.", href: "https://x/m", title: "Mango" }
    ];

    const expected = [

      "<ul dir=\"auto\">",
      "  <li><a target=\"_blank\" href=\"https://x/a\">apple: a.</a></li>",
      "  <li><a target=\"_blank\" href=\"https://x/m\">Mango: m.</a></li>",
      "  <li><a target=\"_blank\" href=\"https://x/z\">Zebra: z.</a></li>",
      "</ul>"
    ].join("\n");

    assert.equal(renderProjects(projects), expected);
  });

  test("keeps entries whose titles are equal in their original order", () => {

    const projects: ProjectEntry[] = [

      { blurb: "first.", href: "https://x/1", title: "same" },
      { blurb: "second.", href: "https://x/2", title: "same" }
    ];

    const expected = [

      "<ul dir=\"auto\">",
      "  <li><a target=\"_blank\" href=\"https://x/1\">same: first.</a></li>",
      "  <li><a target=\"_blank\" href=\"https://x/2\">same: second.</a></li>",
      "</ul>"
    ].join("\n");

    assert.equal(renderProjects(projects), expected);
  });

  test("renders an empty list as the bare unordered-list shell", () => {

    assert.equal(renderProjects([]), "<ul dir=\"auto\">\n\n</ul>");
  });
});

describe("parseDocChromeManifest", () => {

  // Each failure case is constructed fresh by spread-overriding one field of the worked manifest (or rebuilding the offending sub-tree from scratch), rather than
  // mutating a loosely-typed clone. That keeps the invalid inputs readable and side-effect-free, and never reads through an index signature or an unchecked array index.
  test("accepts the canonical worked manifest", () => {

    assert.doesNotThrow(() => parseDocChromeManifest(MANIFEST, "manifest.js"));
  });

  test("rejects a non-object manifest", () => {

    assert.throws(() => parseDocChromeManifest(null, "manifest.js"), /must export a manifest object/);
    assert.throws(() => parseDocChromeManifest("nope", "manifest.js"), /must export a manifest object/);
  });

  test("rejects a missing or non-object masthead", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, masthead: undefined }, "manifest.js"), /`masthead` must be an object/);
  });

  test("rejects an empty masthead title", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, masthead: { ...MANIFEST.masthead, title: "" } }, "manifest.js"),
      /masthead\.title` must be a non-empty string/);
  });

  test("rejects a missing logo field", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, masthead: { ...MANIFEST.masthead, logo: undefined } }, "manifest.js"),
      /masthead\.logo` must be an object/);
  });

  test("rejects a badge missing its image", () => {

    const masthead = { ...MANIFEST.masthead, badges: [{ alt: "License", link: "https://example.test/license" }] };

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, masthead }, "manifest.js"), /masthead\.badges\[0\]\.image` must be a non-empty string/);
  });

  test("rejects a non-array badge collection", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, masthead: { ...MANIFEST.masthead, badges: "nope" } }, "manifest.js"),
      /masthead\.badges` must be an array/);
  });

  test("rejects missing repository coordinates", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, repo: undefined }, "manifest.js"), /`repo` must be an object/);
  });

  test("rejects a non-array nav", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav: {} }, "manifest.js"), /`nav` must be an array/);
  });

  test("rejects a non-object badge", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, masthead: { ...MANIFEST.masthead, badges: ["nope"] } }, "manifest.js"),
      /masthead\.badges\[0\]` must be an object/);
  });

  test("rejects a non-object nav section", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav: ["nope"] }, "manifest.js"), /nav\[0\]` must be an object/);
  });

  test("rejects nav section entries that are not an array", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav: [{ entries: "nope", title: "Getting Started" }] }, "manifest.js"),
      /nav\[0\]\.entries` must be an array/);
  });

  test("rejects a non-object nav entry", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav: [{ entries: ["nope"], title: "Getting Started" }] }, "manifest.js"),
      /nav\[0\]\.entries\[0\]` must be an object/);
  });

  test("rejects a nav entry with an unknown kind", () => {

    const nav = [{ entries: [{ blurb: "b", kind: "mystery", title: "t" }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav }, "manifest.js"), /nav\[0\]\.entries\[0\]\.kind` must be "doc" or "readme-anchor"/);
  });

  test("rejects a doc entry with a non-boolean masthead flag", () => {

    const nav = [{ entries: [{ blurb: "b", file: "docs/X.md", kind: "doc", masthead: "yes", title: "t" }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav }, "manifest.js"), /nav\[0\]\.entries\[0\]\.masthead` must be a boolean/);
  });

  test("rejects a readme-anchor entry missing its anchor", () => {

    const nav = [{ entries: [{ blurb: "b", kind: "readme-anchor", title: "t" }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav }, "manifest.js"), /nav\[0\]\.entries\[0\]\.anchor` must be a non-empty string/);
  });

  test("rejects a non-array devBadges when present", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, devBadges: "nope" }, "manifest.js"), /`devBadges` must be an array/);
  });

  test("rejects a non-object surfaces when present", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, surfaces: "nope" }, "manifest.js"), /`surfaces` must be an object/);
  });

  test("rejects a non-string surfaces path override", () => {

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, surfaces: { readme: 123 } }, "manifest.js"), /surfaces\.readme` must be a non-empty string/);
  });

  test("accepts a manifest with valid surface path overrides", () => {

    assert.doesNotThrow(() => parseDocChromeManifest({ ...MANIFEST, surfaces: { readme: "README.md", webui: "ui/index.html" } }, "manifest.js"));
  });
});

describe("parseProjectEntries", () => {

  test("accepts a well-formed project list", () => {

    const projects = [{ blurb: "b", href: "https://example.test/x", title: "x" }];

    assert.doesNotThrow(() => parseProjectEntries(projects, "projects.json"));
  });

  test("rejects a non-array project source", () => {

    assert.throws(() => parseProjectEntries({}, "projects.json"), /must resolve to an array of project entries/);
  });

  test("rejects a non-object project entry", () => {

    assert.throws(() => parseProjectEntries(["nope"], "projects.json"), /project entry \[0\] must be an object/);
  });

  test("rejects a project entry missing its href", () => {

    const projects = [{ blurb: "b", title: "x" }];

    assert.throws(() => parseProjectEntries(projects, "projects.json"), /project entry \[0\]\.href` must be a non-empty string/);
  });
});
