/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.mjs: Composition tests for the flat-config builder. Most resolve this package's own `eslint.config.mjs` through ESLint's own configuration
 * machinery and assert the effective rule severities and global vocabularies each file set ends up with: the TypeScript compatibility overlay confined to
 * TypeScript paths, the ESLint-recommended correctness baseline active on JavaScript and browser-UI paths, the browser and Node global vocabularies merging on
 * the test-side UI files that match both blocks, a Node global accepted only where the `node` option reaches, and a test-named file outside every linted glob
 * left unlinted. The rest read the builder's exports directly: the Node globals it reads from the runtime, which blocks its `node` and `tests` options emit, what
 * a Node-only glob resolves to, and where the test-file block sits.
 */
import { config as buildConfig, globalsNode, testRules } from "./config.mjs";
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

// The blocks of a built config that carry the test-file rule set, found by that rule set rather than by position so a row can assert where the block sits.
function testBlocks(configs) {

  return configs.filter((block) => isDeepStrictEqual(block.rules, testRules));
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
  // still have the final word.
  it("relaxes the family's test files by default, ahead of a consumer's own blocks", () => {

    const extra = { files: ["src/**/*.test.ts"], rules: { "@typescript-eslint/no-floating-promises": "warn" } };
    const configs = buildConfig({ extraConfigs: [extra], ts: ["src/**/*.ts"] });
    const blocks = testBlocks(configs);
    const familyGlobs = [ "**/*.test.ts", "**/*.fixtures.ts", "**/*.helpers.ts", "**/*.test.mjs", "**/*.fixtures.mjs", "**/*.helpers.mjs" ];

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].files, familyGlobs.map((test) => [ "src/**/*.ts", test ]));
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

    assert.deepEqual(testBlocks(buildConfig({ tests: [], ts: ["src/**/*.ts"] })), []);
    assert.deepEqual(testBlocks(buildConfig()), []);
  });
});
