/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.mjs: Composition tests for the flat-config builder. Most resolve this package's own `eslint.config.mjs` through ESLint's own configuration
 * machinery and assert the effective rule severities and global vocabularies each file set ends up with: the TypeScript compatibility overlay confined to
 * TypeScript paths, the ESLint-recommended correctness baseline active on JavaScript and browser-UI paths, the browser and Node global vocabularies merging on
 * the test-side UI files that match both blocks, a Node global accepted only where the `node` option reaches, key sorting switched off for fixture paths and
 * kept for test and helper paths, the blank-line rule kept on at warn severity for source, browser-side, test, and fixture paths alike, with no blank line
 * allowed at a file's start or end and at most one in a row inside it, and a test-named file outside every linted glob left unlinted. The rest read the
 * builder's exports directly: the Node globals it reads from the runtime, which blocks its `node`, `tests`, and `fixtures` options emit, what a Node-only glob
 * resolves to, and where the test-file and fixture blocks sit.
 */
import { config as buildConfig, fixtureRules, globalsNode, testRules } from "./config.mjs";
import { describe, it } from "node:test";
import { ESLint } from "eslint";
import assert from "node:assert/strict";
import composedConfig from "../../eslint.config.mjs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// The package root, two directories up from this file. ESLint matches the `files` globs of a composed config against paths relative to its `cwd`, so the
// calculated configuration reflects the intended blocks only when the cwd is the directory those globs were written against.
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

// Resolving the repository's real composed config, rather than a purpose-built one assembled inside the test, is what makes these assertions a statement
// about what this package actually lints with. `overrideConfigFile: true` suppresses the on-disk config lookup so the imported array is the only source in
// play, and `calculateConfigForFile` reports the merged result without linting anything or initializing the type-aware project service.
const eslint = new ESLint({ cwd: packageRoot, overrideConfig: composedConfig, overrideConfigFile: true });

// ESLint normalizes every resolved rule entry to an array whose first element is the numeric severity (0 off, 1 warn, 2 error) and whose remaining elements
// are the rule's own option defaults. Reading just the severity keeps these assertions tied to the composition under test rather than to upstream option
// shapes, which change with rule releases and say nothing about how the blocks compose.
function severityOf(config, rule) {

  return config.rules?.[rule]?.[0];
}

// Reading a resolved severity says the rule is configured; linting a fixture says what it does, which is what the rows below assert. The text is linted under
// an existing project file's path because the preset declares no default project, so a virtual path has no project membership to lint against - the source is
// linted in memory and nothing is written to disk. Counting only the named rule's messages keeps the assertion clear of the fixture's other findings, which
// belong to other rules.
async function ruleMessageCount({ filePath = "src/util.ts", rule, source }) {

  const [result] = await eslint.lintText(source, { filePath });

  return result.messages.filter((message) => message.ruleId === rule).length;
}

// The blocks of a built config that carry a given rule set, found by that rule set rather than by position so a row can assert where each block sits.
function blocksCarrying(configs, rules) {

  return configs.filter((block) => isDeepStrictEqual(block.rules, rules));
}

describe("flat config composition", () => {

  // The compatibility overlay belongs to the TypeScript file set: the base rules it silences are ones the compiler reports itself, so a TypeScript path
  // resolves them off, while the later common block is what settles `prefer-const` at the warn severity every file set sees.
  it("silences the compiler-redundant base rules for TypeScript paths", async () => {

    const config = await eslint.calculateConfigForFile("src/util.ts");

    assert.equal(severityOf(config, "no-dupe-class-members"), 0);
    assert.equal(severityOf(config, "no-redeclare"), 0);
    assert.equal(severityOf(config, "no-undef"), 0);
    assert.equal(severityOf(config, "prefer-const"), 1);
  });

  // A plain-JavaScript path has no compiler backstop, so it carries the ESLint-recommended correctness rules at error severity along with the modernization
  // rules the common block states for every language.
  it("keeps the correctness and modernization baseline at error severity for JavaScript paths", async () => {

    const config = await eslint.calculateConfigForFile("build/fs-ops.mjs");

    assert.equal(severityOf(config, "no-undef"), 2);
    assert.equal(severityOf(config, "no-var"), 2);
    assert.equal(severityOf(config, "prefer-const"), 1);
    assert.equal(severityOf(config, "prefer-rest-params"), 2);
    assert.equal(severityOf(config, "prefer-spread"), 2);
  });

  // Browser-UI files reference host APIs that exist at runtime but not in source, so `no-undef` is only usable there alongside the preset's browser globals.
  it("pairs the browser globals with an active no-undef for UI paths", async () => {

    const config = await eslint.calculateConfigForFile("ui/webUi.mjs");
    const globals = config.languageOptions?.globals ?? {};

    assert.equal(severityOf(config, "no-undef"), 2);
    assert.equal(globals.clearInterval, "readonly");
    assert.equal(globals.setInterval, "readonly");
    assert.equal(globals.window, "readonly");
  });

  // A test-side UI file matches both the preset's UI block and its Node globals block, because this package's `node` option names the test-side files. Flat
  // config merges `globals` across every matching block, so such a file needs both vocabularies at once to satisfy `no-undef` - browser APIs from the DOM the
  // suite builds, Node APIs from the runner.
  it("merges the browser and Node vocabularies for test-side UI paths", async () => {

    const config = await eslint.calculateConfigForFile("ui/webUi.test.mjs");
    const globals = config.languageOptions?.globals ?? {};

    assert.equal(globals.document, "readonly");
    assert.equal(globals.process, "readonly");
  });

  // Two value declarations of one module are what the rule exists to catch, and their member lists make no difference to it.
  it("flags a second value import of one module", async () => {

    assert.equal(await ruleMessageCount({ rule: "no-duplicate-imports", source: "import { a } from \"x\";\nimport { b } from \"x\";\n" }), 1);
  });

  // The house style asks for a type-only declaration beside the value one, and `allowSeparateTypeImports` is what keeps the rule from contradicting the style
  // it serves: without the option every one of those pairs reads as a duplicate.
  it("admits the type-beside-value pair the house style requires", async () => {

    assert.equal(await ruleMessageCount({ rule: "no-duplicate-imports", source: "import type { T } from \"x\";\nimport { a } from \"x\";\n" }), 0);
  });

  // The build tooling runs under Node and matches the `node` option, while a browser-side UI module matches only the `ui` globs, so the same reference to
  // `process` is accepted in the one and reported in the other. That difference is why Node's globals reach only the files the option names.
  it("accepts a Node global in a Node-run file and reports it in a browser-side file", async () => {

    const source = "process.exitCode = 0;\n";

    assert.equal(await ruleMessageCount({ filePath: "build/fs-ops.mjs", rule: "no-undef", source }), 0);
    assert.equal(await ruleMessageCount({ filePath: "ui/webUi.mjs", rule: "no-undef", source }), 1);
  });

  // The final-newline rule requires a newline at a file's end and allows a blank line ahead of it, so the blank-line rule is what refuses that line: a text that
  // ends in one is reported once, and the same text ending in its newline alone is not.
  it("reports a blank line at the end of a file", async () => {

    const rule = "@stylistic/no-multiple-empty-lines";

    assert.equal(await ruleMessageCount({ rule, source: "const a = 1;\n\n" }), 1);
    assert.equal(await ruleMessageCount({ rule, source: "const a = 1;\n" }), 0);
  });

  // Inside a file the limit is the one blank line in a row the house style puts between statements, so two are reported and one is not.
  it("reports more than one blank line in a row and admits a single one", async () => {

    const rule = "@stylistic/no-multiple-empty-lines";

    assert.equal(await ruleMessageCount({ rule, source: "const a = 1;\n\n\nconst b = 2;\n" }), 1);
    assert.equal(await ruleMessageCount({ rule, source: "const a = 1;\n\nconst b = 2;\n" }), 0);
  });

  // A file opens on its first line of content, so a blank line ahead of it is reported.
  it("reports a blank line at the start of a file", async () => {

    assert.equal(await ruleMessageCount({ rule: "@stylistic/no-multiple-empty-lines", source: "\nconst a = 1;\n" }), 1);
  });

  // The blank-line rule sits in the common block at the warn severity the other stylistic rules carry, and neither the test-file relaxation nor the fixture
  // relaxation names it, so test and fixture paths keep it on just as source and browser-side paths do.
  it("keeps the blank-line rule at warn severity on source, browser-side, test, and fixture paths", async () => {

    const rule = "@stylistic/no-multiple-empty-lines";

    assert.equal(severityOf(await eslint.calculateConfigForFile("src/util.ts"), rule), 1);
    assert.equal(severityOf(await eslint.calculateConfigForFile("ui/webUi.mjs"), rule), 1);
    assert.equal(severityOf(await eslint.calculateConfigForFile("src/util.test.ts"), rule), 1);
    assert.equal(severityOf(await eslint.calculateConfigForFile("src/owned-connector.fixtures.ts"), rule), 1);
  });

  // The Node globals come from the runtime running the linter, so the names Node-run code reaches for most are present without a hand-kept list.
  it("reads the Node globals from the running runtime", () => {

    for(const name of [ "Buffer", "URL", "console", "fetch", "process", "setImmediate", "structuredClone" ]) {

      assert.equal(globalsNode[name], "readonly", name);
    }
  });

  // Node's globals are an opt-in for the files that run under Node, so a config that names none carries no block declaring them.
  it("emits the Node globals block only when the node option names files", () => {

    const nodeBlocks = (configs) => configs.filter((block) => block.languageOptions?.globals?.process !== undefined);

    assert.deepEqual(nodeBlocks(buildConfig({ js: ["tool.mjs"] })), []);
    assert.deepEqual(nodeBlocks(buildConfig({ js: ["tool.mjs"], node: ["tool.mjs"] })), [{ files: ["tool.mjs"], languageOptions: { globals: globalsNode } }]);
  });

  // The `node` globs join the linted set the way the `ui` globs do, so a file named only there is linted with the common rules rather than acquiring globals
  // alone, and the test-file pairing reaches it like any other linted file.
  it("lints a Node-only glob with the common rules and relaxes it as a test file", async () => {

    const nodeOnly = new ESLint({ cwd: packageRoot, overrideConfig: buildConfig({ node: ["build/fs-ops.test.mjs"] }), overrideConfigFile: true });
    const config = await nodeOnly.calculateConfigForFile("build/fs-ops.test.mjs");

    assert.equal(severityOf(config, "@hjdhjd/comment-style"), 2);
    assert.equal(severityOf(config, "@typescript-eslint/no-floating-promises"), 0);
    assert.equal(config.languageOptions?.globals?.process, "readonly");
  });

  // The test-file relaxations follow the family naming convention by default, paired with every linted glob, and sit ahead of a consumer's own blocks, so those
  // still have the final word. The pairs are compared as a set, because the order of a block's `files` entries has no effect on which files it matches.
  it("relaxes the family's test files by default, ahead of a consumer's own blocks", () => {

    const extra = { files: ["src/**/*.test.ts"], rules: { "@typescript-eslint/no-floating-promises": "warn" } };
    const configs = buildConfig({ extraConfigs: [extra], ts: ["src/**/*.ts"] });
    const blocks = blocksCarrying(configs, testRules);
    const familyGlobs = [ "**/*.test.ts", "**/*.fixtures.ts", "**/*.helpers.ts", "**/*.test.mjs", "**/*.fixtures.mjs", "**/*.helpers.mjs" ];

    assert.equal(blocks.length, 1);
    assert.deepEqual(new Set(blocks[0].files), new Set(familyGlobs.map((test) => [ "src/**/*.ts", test ])));
    assert.ok(configs.indexOf(blocks[0]) < configs.indexOf(extra), "the test-file block must precede the consumer's own blocks.");
  });

  // A block's `files` globs also pick files out of a linted directory, which is why the test-file block pairs its globs with the linted ones: a test-named file
  // outside every linted glob stays unlinted, so it resolves no configuration at all, while a test file among the linted ones resolves the relaxation.
  it("leaves a test-named file outside every linted glob unlinted and unrelaxed", async () => {

    assert.equal(await eslint.calculateConfigForFile("test/e2e/stray.test.ts"), undefined);
    assert.equal(severityOf(await eslint.calculateConfigForFile("src/util.test.ts"), "@typescript-eslint/no-floating-promises"), 0);
  });

  // An empty list opts out of the relaxations, and a config that lints nothing has nothing to relax.
  it("emits no test-file block for an empty tests list or a config that lints nothing", () => {

    assert.deepEqual(blocksCarrying(buildConfig({ tests: [], ts: ["src/**/*.ts"] }), testRules), []);
    assert.deepEqual(blocksCarrying(buildConfig(), testRules), []);
  });

  // The fixture relaxation follows the family's fixture naming by default, paired with every linted glob the way the test-file block is, and switches off key
  // sorting alone, so a fixture keeps every other rule. The pairs are compared as a set, as the test-file row compares its own.
  it("switches key sorting off for the family's fixture files by default", () => {

    const blocks = blocksCarrying(buildConfig({ ts: [ "src/**/*.ts", "test/**/*.ts" ] }), fixtureRules);

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].rules, { "sort-keys": "off" });
    assert.deepEqual(new Set(blocks[0].files), new Set([ [ "src/**/*.ts", "**/*.fixtures.ts" ], [ "src/**/*.ts", "**/*.fixtures.mjs" ],
      [ "test/**/*.ts", "**/*.fixtures.ts" ], [ "test/**/*.ts", "**/*.fixtures.mjs" ] ]));
  });

  // A consumer whose fixture files follow a different naming convention passes its own globs through the option, and the block pairs those globs with the
  // linted ones in place of the default.
  it("honors a custom fixtures list", () => {

    const blocks = blocksCarrying(buildConfig({ fixtures: ["**/*.capture.ts"], ts: ["src/**/*.ts"] }), fixtureRules);

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].files, [[ "src/**/*.ts", "**/*.capture.ts" ]]);
  });

  // An empty list opts out of the fixture relaxation without touching the test-file block, and a config that lints nothing has nothing to relax.
  it("emits no fixture block for an empty fixtures list or a config that lints nothing", () => {

    const optedOut = buildConfig({ fixtures: [], ts: ["src/**/*.ts"] });

    assert.deepEqual(blocksCarrying(optedOut, fixtureRules), []);
    assert.deepEqual(blocksCarrying(optedOut, testRules), blocksCarrying(buildConfig({ ts: ["src/**/*.ts"] }), testRules));
    assert.deepEqual(blocksCarrying(buildConfig(), fixtureRules), []);
    assert.deepEqual(blocksCarrying(buildConfig({ fixtures: ["**/*.capture.ts"] }), fixtureRules), []);
  });

  // The fixture block follows the test-file block, which follows the common block that enables key sorting, so the relaxation takes effect. It sits ahead of a
  // consumer's own blocks, so a consumer that wants key sorting back for its fixtures still has the final word.
  it("places the fixture block after the test-file block and ahead of a consumer's own blocks", async () => {

    const extra = { files: ["src/**/*.fixtures.ts"], rules: { "sort-keys": "warn" } };
    const configs = buildConfig({ extraConfigs: [extra], ts: ["src/**/*.ts"] });
    const [testBlock] = blocksCarrying(configs, testRules);
    const [fixtureBlock] = blocksCarrying(configs, fixtureRules);
    const consumer = new ESLint({ cwd: packageRoot, overrideConfig: configs, overrideConfigFile: true });

    assert.ok(configs.indexOf(testBlock) < configs.indexOf(fixtureBlock), "the fixture block must follow the test-file block.");
    assert.ok(configs.indexOf(fixtureBlock) < configs.indexOf(extra), "the fixture block must precede the consumer's own blocks.");
    assert.equal(severityOf(await consumer.calculateConfigForFile("src/owned-connector.fixtures.ts"), "sort-keys"), 1);
  });

  // The test-file default names the fixture files as well, so a fixture keeps the test relaxation beside its own: every file the fixture block reaches by default is
  // one the test-file block reaches too.
  it("keeps every default fixture glob inside the test-file default", () => {

    const configs = buildConfig({ ts: ["src/**/*.ts"] });
    const [testBlock] = blocksCarrying(configs, testRules);
    const [fixtureBlock] = blocksCarrying(configs, fixtureRules);

    for(const pair of fixtureBlock.files) {

      assert.ok(testBlock.files.some((testPair) => isDeepStrictEqual(testPair, pair)), pair.join(" and "));
    }
  });

  // Through this package's own composed config, a fixture path resolves key sorting off while keeping the test relaxation and the common rules, test and helper
  // paths keep key sorting on, and a fixture-named file outside every linted glob stays unlinted.
  it("switches key sorting off for linted fixture paths alone", async () => {

    const fixture = await eslint.calculateConfigForFile("src/owned-connector.fixtures.ts");

    assert.equal(severityOf(fixture, "sort-keys"), 0);
    assert.equal(severityOf(fixture, "@typescript-eslint/no-floating-promises"), 0);
    assert.equal(severityOf(fixture, "@hjdhjd/comment-style"), 2);
    assert.equal(severityOf(await eslint.calculateConfigForFile("ui/webUi.fixtures.mjs"), "sort-keys"), 0);
    assert.equal(severityOf(await eslint.calculateConfigForFile("src/util.test.ts"), "sort-keys"), 1);
    assert.equal(severityOf(await eslint.calculateConfigForFile("src/mqtt.helpers.ts"), "sort-keys"), 1);
    assert.equal(severityOf(await eslint.calculateConfigForFile("ui/ui.helpers.mjs"), "sort-keys"), 1);
    assert.equal(await eslint.calculateConfigForFile("test/e2e/stray.fixtures.ts"), undefined);
  });
});
