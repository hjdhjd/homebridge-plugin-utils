/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * docChrome.test.ts: Unit tests for the shared documentation-chrome renderers - the masthead, documentation index, dashboard badges, logo, project list, and
 * configuration-schema footer projections - plus the region plan a documentation entry answers and the manifest and project-entry validators. Coverage pins each
 * surface's canonical output byte-for-byte, proves the per-surface href derivation and HTML escaping, exercises the doc-footer self-omission, and asserts the
 * validators' framed diagnostics for every mis-shaped field.
 */
import type { DocChromeManifest, DocEntry, ProjectEntry } from "./docChrome.ts";
import { LOGO_BEGIN, LOGO_END, MASTHEAD_BEGIN, MASTHEAD_END, docChromeRegions, parseDocChromeManifest, parseProjectEntries, renderDevBadges, renderDocIndex,
  renderLogo, renderMasthead, renderProjects, renderSchemaFooter } from "./docChrome.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The canonical worked-example manifest. Two masthead badges, one dashboard badge, and two nav sections that between them cover every entry kind: a README anchor, a
// plain doc, and an entry pointing outside the repository, plus a second doc whose blurb carries "&" and "<...>" so the markdown-verbatim and HTML-escaped surfaces
// can be told apart.
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
      { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", title: "Best Practices" },
      { blurb: "the companion plugin's own documentation.", kind: "external", title: "Companion Plugin", url: "https://github.com/acme/companion-plugin#readme" }
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

// The README documentation index: in-page anchors for anchor entries, absolute blob URLs for docs, the external entry's own URL verbatim, blurbs verbatim (markdown
// surface).
const README_NAV_OUTPUT = [

  "* Getting Started",
  "  * [Installation](#installation): installing this plugin.",
  "  * [Best Practices](https://github.com/acme/example-plugin/blob/main/docs/BestPractices.md): best practices.",
  "  * [Companion Plugin](https://github.com/acme/companion-plugin#readme): the companion plugin's own documentation.",
  "",
  "* Additional Topics",
  "  * [Audio Options](https://github.com/acme/example-plugin/blob/main/docs/AudioOptions.md): audio & <video> options."
].join("\n");

// The footer index rendered into docs/AudioOptions.md: the anchor entry now resolves to the README's absolute URL, the external entry carries the same URL it did on
// the README, and the self-entry (Audio Options) is dropped, which empties and therefore removes the "Additional Topics" section.
const DOC_FOOTER_OUTPUT = [

  "* Getting Started",
  "  * [Installation](https://github.com/acme/example-plugin/blob/main/README.md#installation): installing this plugin.",
  "  * [Best Practices](https://github.com/acme/example-plugin/blob/main/docs/BestPractices.md): best practices.",
  "  * [Companion Plugin](https://github.com/acme/companion-plugin#readme): the companion plugin's own documentation."
].join("\n");

// The webUI documentation index: HTML, absolute URLs everywhere, the external entry's URL still verbatim, and the "&"/"<>" blurb HTML-escaped.
const WEBUI_NAV_OUTPUT = [

  "<h5>Getting Started</h5>",
  "<div class=\"px-4\">",
  "<ul dir=\"auto\">",
  "  <li><a target=\"_blank\" href=\"https://github.com/acme/example-plugin/blob/main/README.md#installation\">Installation</a>: installing this plugin.</li>",
  "  <li><a target=\"_blank\" href=\"https://github.com/acme/example-plugin/blob/main/docs/BestPractices.md\">Best Practices</a>: best practices.</li>",
  "  <li><a target=\"_blank\" href=\"https://github.com/acme/companion-plugin#readme\">Companion Plugin</a>: the companion plugin's own documentation.</li>",
  "</ul>",
  "</div>",
  "",
  "<h5>Additional Topics</h5>",
  "<div class=\"px-4\">",
  "<ul dir=\"auto\">",
  "  <li><a target=\"_blank\" href=\"https://github.com/acme/example-plugin/blob/main/docs/AudioOptions.md\">Audio Options</a>: audio &amp; &lt;video&gt; options.</li>",
  "</ul>",
  "</div>"
].join("\n");

describe("docChromeRegions", () => {

  test("an entry naming no file of the plugin's own carries neither region", () => {

    const anchor: DocEntry = { anchor: "installation", blurb: "installing this plugin.", kind: "readme-anchor", title: "Installation" };
    const external: DocEntry = { blurb: "the companion plugin's own documentation.", kind: "external", title: "Companion Plugin",
      url: "https://github.com/acme/companion-plugin#readme" };

    assert.deepEqual(docChromeRegions(anchor), { documentation: false, masthead: false }, "a README anchor points into a file the README itself owns");
    assert.deepEqual(docChromeRegions(external), { documentation: false, masthead: false }, "an external entry points outside the repository entirely");
  });

  test("a doc entry opting out of the masthead keeps its footer index", () => {

    const entry: DocEntry = { blurb: "release history.", file: "docs/Changelog.md", kind: "doc", masthead: false, title: "Changelog" };

    assert.deepEqual(docChromeRegions(entry), { documentation: true, masthead: false });
  });

  test("a doc entry opting out of the footer index keeps its masthead", () => {

    const entry: DocEntry = { blurb: "best practices.", file: "docs/BestPractices.md", footer: false, kind: "doc", title: "Best Practices" };

    assert.deepEqual(docChromeRegions(entry), { documentation: false, masthead: true });
  });

  test("a doc entry declaring neither opt-out carries both regions", () => {

    const entry: DocEntry = { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", title: "Best Practices" };

    assert.deepEqual(docChromeRegions(entry), { documentation: true, masthead: true });
  });
});

describe("renderMasthead", () => {

  test("reproduces the canonical masthead block byte-for-byte", () => {

    assert.equal(renderMasthead(MANIFEST), MASTHEAD_OUTPUT);
  });
});

describe("renderLogo", () => {

  test("renders the manifest's artwork as one classed image element", () => {

    const rendered = renderLogo(MANIFEST);

    assert.equal(rendered, "<img class=\"chrome-logo\" src=\"https://raw.example/logo.svg\" alt=\"example-plugin: the logo\" />");
    assert.equal(rendered.includes("\n"), false, "the region's content is a single line the page's own wrapper markup surrounds");
  });

  test("escapes a quote and an ampersand in both attribute values", () => {

    const manifest: DocChromeManifest = { ...MANIFEST, masthead: { ...MANIFEST.masthead,
      logo: { alt: "Acme & \"Friends\" logo", href: "https://github.com/acme/example-plugin", src: "https://raw.example/logo.svg?q=\"a\"&r=b" } } };

    assert.equal(renderLogo(manifest),
      "<img class=\"chrome-logo\" src=\"https://raw.example/logo.svg?q=&quot;a&quot;&amp;r=b\" alt=\"Acme &amp; &quot;Friends&quot; logo\" />");
  });

  test("the logo markers follow the family's marked-region template", () => {

    // Derived from an existing pair rather than retyped, so a change to the family's template moves both together instead of leaving the newest pair behind.
    assert.equal(LOGO_BEGIN, MASTHEAD_BEGIN.replace("MASTHEAD", "LOGO"));
    assert.equal(LOGO_END, MASTHEAD_END.replace("MASTHEAD", "LOGO"));
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

  test("the webUI surface indents its section bodies and leaves the headings flush, while the markdown surfaces carry no presentation at all", () => {

    const webui = renderDocIndex({ manifest: MANIFEST, surface: "webui" });

    /* Heading flush, body indented is the rhythm the hand-authored sections of a support tab establish, so the generated region has to match it or the tab breaks
     * exactly where the hand-authored copy ends. The indent is presentation for that one surface: a markdown bullet list has nowhere to put a class and no reason
     * to, so the readme and doc-footer surfaces are asserted free of it rather than left unstated.
     */
    assert.match(webui, /<div class="px-4">\n<ul dir="auto">/, "each webUI section list sits inside the padded wrapper that carries the indent");
    assert.doesNotMatch(webui, /<ul[^>]*class=/, "the list itself carries no class: a padding utility on it would replace its own indentation rather than add to it");
    assert.doesNotMatch(webui, /<h5 [^>]*class=/, "while the headings stay flush outside the wrapper, carrying no class of their own");

    for(const surface of [ "doc-footer", "readme" ] as const) {

      assert.doesNotMatch(renderDocIndex({ manifest: MANIFEST, surface }), /px-4/, surface + " renders document structure, so no presentation class reaches it");
    }
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

describe("renderSchemaFooter", () => {

  // The opening clause every footer carries, and the blob base its document links hang off. Spelled once here so each row below states only what it is about.
  const OPENING = "See the [example-plugin developer page](https://github.com/acme/example-plugin) for detailed documentation";
  const BLOB = "https://github.com/acme/example-plugin/blob/main";

  test("names the repository page alone when no entry is flagged for the footer", () => {

    assert.equal(renderSchemaFooter(MANIFEST), OPENING + ".");
  });

  test("lists the flagged entries in navigation order, joined as the sentence's own grammar", () => {

    // The flags sit in both sections, so the order the sentence reads in is the navigation's rather than any one section's, and the list grammar is the conjunction a
    // reader expects of an English sentence rather than a bare join.
    const nav: DocChromeManifest["nav"] = [

      { entries: [

        { anchor: "installation", blurb: "installing this plugin.", kind: "readme-anchor", title: "Installation" },
        { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", schema: true, title: "Best Practices" },
        { blurb: "every feature option.", file: "docs/FeatureOptions.md", kind: "doc", schema: true, title: "Feature Options" }
      ], title: "Getting Started" },
      { entries: [

        { blurb: "audio & <video> options.", file: "docs/AudioOptions.md", kind: "doc", schema: true, title: "Audio Options" }
      ], title: "Additional Topics" }
    ];

    assert.equal(renderSchemaFooter({ ...MANIFEST, nav }), OPENING + ", including [Best Practices](" + BLOB + "/docs/BestPractices.md), [Feature Options](" + BLOB +
      "/docs/FeatureOptions.md), and [Audio Options](" + BLOB + "/docs/AudioOptions.md).");

    // Two entries read as a bare conjunction rather than a comma list, which is the same grammar the feature-options scope sentences are joined with.
    const pair: DocChromeManifest["nav"] = [{ entries: [

      { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", schema: true, title: "Best Practices" },
      { blurb: "every feature option.", file: "docs/FeatureOptions.md", kind: "doc", schema: true, title: "Feature Options" }
    ], title: "Getting Started" }];

    assert.equal(renderSchemaFooter({ ...MANIFEST, nav: pair }), OPENING + ", including [Best Practices](" + BLOB + "/docs/BestPractices.md) and [Feature Options](" +
      BLOB + "/docs/FeatureOptions.md).");
  });

  test("renders a flagged external entry at its own destination", () => {

    const nav: DocChromeManifest["nav"] = [{ entries: [

      { blurb: "the companion plugin's own documentation.", kind: "external", schema: true, title: "Companion Plugin", url: "https://github.com/acme/companion#readme" }
    ], title: "Getting Started" }];

    assert.equal(renderSchemaFooter({ ...MANIFEST, nav }), OPENING + ", including [Companion Plugin](https://github.com/acme/companion#readme).");
  });

  test("omits an entry that carries no flag", () => {

    const nav: DocChromeManifest["nav"] = [{ entries: [

      { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", schema: true, title: "Best Practices" },
      { blurb: "release history.", file: "docs/Changelog.md", kind: "doc", title: "Changelog" }
    ], title: "Getting Started" }];

    const rendered = renderSchemaFooter({ ...MANIFEST, nav });

    assert.equal(rendered, OPENING + ", including [Best Practices](" + BLOB + "/docs/BestPractices.md).");
    assert.equal(rendered.includes("Changelog"), false, "a footer that listed every navigation entry would name the changelog under a configuration form");
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

  test("rejects a nav entry with an unknown kind, naming every kind the union admits", () => {

    const nav = [{ entries: [{ blurb: "b", kind: "mystery", title: "t" }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav }, "manifest.js"),
      /nav\[0\]\.entries\[0\]\.kind` must be "doc", "external", or "readme-anchor"/);
  });

  test("accepts an external entry carrying a url", () => {

    const nav = [{ entries: [{ blurb: "b", kind: "external", title: "t", url: "https://example.test/elsewhere" }], title: "Getting Started" }];

    assert.doesNotThrow(() => parseDocChromeManifest({ ...MANIFEST, nav }, "manifest.js"));
  });

  test("rejects an external entry missing its url", () => {

    const nav = [{ entries: [{ blurb: "b", kind: "external", title: "t" }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav }, "manifest.js"), /nav\[0\]\.entries\[0\]\.url` must be a non-empty string/);
  });

  test("rejects an external entry whose url is not a string", () => {

    // A JSON-authored manifest can smuggle any shape past the type system, so the validator's url check is a genuine runtime guard rather than a restatement of the
    // union. An entry that reached the renderer with a non-string url would emit it into an href attribute as "[object Object]".
    const nav = [{ entries: [{ blurb: "b", kind: "external", title: "t", url: { href: "https://example.test" } }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav }, "manifest.js"), /nav\[0\]\.entries\[0\]\.url` must be a non-empty string/);
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

  test("accepts the schema-footer flag on both kinds that can carry it, and rejects a non-boolean naming the entry", () => {

    const flagged = [{ entries: [

      { blurb: "b", file: "docs/X.md", kind: "doc", schema: true, title: "t" },
      { blurb: "b", kind: "external", schema: false, title: "t", url: "https://example.test/elsewhere" }
    ], title: "Getting Started" }];

    assert.doesNotThrow(() => parseDocChromeManifest({ ...MANIFEST, nav: flagged }, "manifest.js"));

    const mistyped = [{ entries: [{ blurb: "b", file: "docs/X.md", kind: "doc", schema: "yes", title: "t" }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav: mistyped }, "manifest.js"), /nav\[0\]\.entries\[0\]\.schema` must be a boolean/);

    const mistypedExternal = [{ entries: [{ blurb: "b", kind: "external", schema: 1, title: "t", url: "https://example.test/x" }], title: "Getting Started" }];

    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, nav: mistypedExternal }, "manifest.js"), /nav\[0\]\.entries\[0\]\.schema` must be a boolean/);
  });

  test("accepts a schema surface path and rejects an empty one", () => {

    assert.doesNotThrow(() => parseDocChromeManifest({ ...MANIFEST, surfaces: { schema: "config.schema.json" } }, "manifest.js"));
    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, surfaces: { schema: "" } }, "manifest.js"), /surfaces\.schema` must be a non-empty string/);
  });

  test("rejects an empty webUI surface path, naming that field", () => {

    // Every surface path answers to the same rule, so the webUI's arm is asserted in its own right rather than through the readme's row. An empty override
    // resolves to the plugin root itself, which the stamper would then try to read as a file.
    assert.throws(() => parseDocChromeManifest({ ...MANIFEST, surfaces: { webui: "" } }, "manifest.js"), /surfaces\.webui` must be a non-empty string/);
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
