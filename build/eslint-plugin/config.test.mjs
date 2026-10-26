/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.mjs: Composition tests for the flat-config builder. Most resolve this package's own `eslint.config.mjs` through ESLint's own configuration
 * machinery and assert the effective rule severities and global vocabularies each file set ends up with: the TypeScript compatibility overlay confined to
 * TypeScript paths, the ESLint-recommended correctness baseline active on JavaScript and browser-UI paths, the browser and Node global vocabularies merging on
 * the test-side UI files that match both blocks, a Node global accepted only where the `node` option reaches, key sorting switched off for fixture paths and
 * kept for test and helper paths, the blank-line rule kept on at warn severity for source, browser-side, test, and fixture paths alike, with no blank line
 * allowed at a file's start or end and at most one in a row inside it, and a test-named file outside every linted glob left unlinted. The rest read the
 * builder's exports directly: the Node globals it reads from the runtime, which blocks its `node`, `tests`, and `fixtures` options emit, what a Node-only glob
 * resolves to, and where the test-file and fixture blocks sit. The settings-page rows lint text under a module of `src/webui/` and assert what the folder's block
 * refuses and admits there, that source outside the folder and the folder's test files are left alone, that the `webui` option opts out, where the block sits,
 * and that the package's lint entry exports the folder's rule preset. One row holds the lint helper itself to failing a row whose path no config lints or whose
 * text never parses.
 */
import * as lintEntry from "homebridge-plugin-utils/eslint";
import { config as buildConfig, commonRules, fixtureRules, globalsNode, testRules, webuiRules } from "./config.mjs";
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
// linted in memory and nothing is written to disk. Keeping only the named rule's messages keeps the assertion clear of the fixture's other findings, which
// belong to other rules. A message no rule raised fails the row outright, because a path no block lints answers only the notice that it was ignored, a text
// that never parsed answers only its parse error, and in each case no rule runs, so the row would read as no message from its rule. A row linting through a
// config other than this package's passes its own instance as the linter.
async function ruleMessages({ filePath = "src/util.ts", linter = eslint, rule, source }) {

  const [result] = await linter.lintText(source, { filePath });

  assert.deepEqual(result.messages.filter((message) => message.ruleId === null).map((message) => message.message), [], filePath + " must be linted and must parse.");

  return result.messages.filter((message) => message.ruleId === rule);
}

// The count of the named rule's messages, which most rows assert.
async function ruleMessageCount(options) {

  return (await ruleMessages(options)).length;
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

  // The lint helper fails a row whose path no block lints and a row whose text never parses, so a row expecting no message from its rule cannot pass because
  // no rule ran. The text would draw that rule's message at a linted path.
  it("fails a row aimed at a path no config lints or a text that never parses", async () => {

    await assert.rejects(ruleMessageCount({ filePath: "test/e2e/stray.test.ts", rule: "no-var", source: "var a = 1;\n" }),
      { message: /^test\/e2e\/stray\.test\.ts must be linted and must parse\./u });
    await assert.rejects(ruleMessageCount({ rule: "no-var", source: "var = 1;\n" }), { message: /^src\/util\.ts must be linted and must parse\./u });
    assert.equal(await ruleMessageCount({ rule: "no-var", source: "var a = 1;\n" }), 1);
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

describe("the settings-page folder", () => {

  // A module in the folder, the path the rows lint their text under. The text is linted in memory under an existing project file's path, as the rows above lint
  // theirs, because the project service refuses a path it does not know, and a refused path reads no message from any rule.
  const webuiFile = "src/webui/address.ts";

  // The rules the folder's block sets.
  const webuiRuleNames = [ "@hjdhjd/split-type-imports", "@typescript-eslint/no-restricted-imports", "no-restricted-globals", "no-restricted-syntax" ];

  // A value import of each specifier, refused in the folder by the import rule.
  const valueImport = (specifier) => ({ rule: "@typescript-eslint/no-restricted-imports", source: "import { a } from " + JSON.stringify(specifier) + ";\n" });

  // The texts a module in the folder is refused, each beside the rule that refuses it.
  const refused = [

    ...[ "node:fs", "homebridge-plugin-utils", "../settings.ts", "./sub/../../settings.ts", "./..\\settings.ts" ].map(valueImport),
    { rule: "no-restricted-globals", source: "const a = process.env;\n" },
    { rule: "no-restricted-globals", source: "const a = globalThis.process;\n" },
    { rule: "no-restricted-syntax", source: "const a = import(\"./x.ts\");\n" }
  ];

  // Lint every text under one path at once and answer each text's count of messages from its own rule, keyed by the text so a failing row names the text whose
  // count moved. Each lint parses and runs its rules in one synchronous pass, so texts sharing a path never read one another's content.
  const countsAt = async ({ filePath, linter, texts }) => Object.fromEntries(await Promise.all(texts.map(async ({ rule, source }) => [ source,
    await ruleMessageCount({ filePath, linter, rule, source }) ])));

  // Every text keyed to the one count a row expects of it.
  const each = (texts, count) => Object.fromEntries(texts.map(({ source }) => [ source, count ]));

  // The folder's modules reach the browser and nothing else does, so a value may come only from inside the folder, through a "./" path, and a ".." segment or a
  // backslash, which a browser reads as a "/", is refused even behind a "./" opening, since each can climb out of the folder. A Node global, named bare or read
  // through globalThis, and a dynamic import are refused as well.
  it("refuses a value import from outside the folder, a Node global, and a dynamic import", async () => {

    assert.deepEqual(await countsAt({ filePath: webuiFile, texts: refused }), each(refused, 1));
  });

  // The compiler erases a type-only import, so it may come from anywhere, and a value import from inside the folder, its subfolders included, is what the folder
  // is for.
  it("admits a type-only import from anywhere and a value import from inside the folder", async () => {

    const admitted = [ ...[ "homebridge-plugin-utils", "../types.ts" ].map((specifier) => ({ rule: "@typescript-eslint/no-restricted-imports",
      source: "import type { T } from " + JSON.stringify(specifier) + ";\n" })), ...[ "./routes.ts", "./sub/x.ts" ].map(valueImport) ];

    assert.deepEqual(await countsAt({ filePath: webuiFile, texts: admitted }), each(admitted, 0));
  });

  // Every Node global the browser lacks is refused by name, and read through globalThis as well, each through the same message.
  it("refuses each Node global the browser lacks", async () => {

    const references = (name) => [ "", "globalThis." ].map((owner) => ({ rule: "no-restricted-globals", source: "const a = " + owner + name + ";\n" }));
    const globals = [ "Buffer", "__dirname", "__filename", "clearImmediate", "global", "module", "process", "require", "setImmediate" ].flatMap(references);

    assert.deepEqual(await countsAt({ filePath: webuiFile, texts: globals }), each(globals, 1));
  });

  // An import whose every name carries an inline `type` reads as type-only to the import rule, yet the compiler keeps it as a bare import that loads its module,
  // so the folder holds the family's split-type-imports rule at error severity, while source elsewhere and the folder's test files keep the common block's warning.
  it("refuses an inline type qualifier at error severity in the folder alone", async () => {

    const inline = { rule: "@hjdhjd/split-type-imports", source: "import { type X } from \"../settings.ts\";\n" };
    const severities = async (filePath) => (await ruleMessages({ ...inline, filePath })).map((message) => message.severity);

    assert.deepEqual(await severities(webuiFile), [2]);
    assert.deepEqual(await severities("src/util.ts"), [1]);
    assert.deepEqual(await severities("src/webui/address.test.ts"), [1]);
  });

  // The guard belongs to the folder alone: source elsewhere runs under Node, and a test file in the folder runs under Node's test runner, so each takes every
  // refused text without a message from the rule that refuses it in the folder.
  it("leaves source outside the folder and the folder's test files alone", async () => {

    assert.deepEqual(await countsAt({ filePath: "src/util.ts", texts: refused }), each(refused, 0));
    assert.deepEqual(await countsAt({ filePath: "src/webui/address.test.ts", texts: refused }), each(refused, 0));
  });

  // An empty list opts out: the builder emits no block for the folder, so a module there takes every refused text. The block pairs its globs with the linted ones,
  // so a config that lints nothing emits no block for the folder as well.
  it("emits no block for the folder when the webui option is empty or the config lints nothing", async () => {

    const optedOut = buildConfig({ ts: ["src/**/*.ts"], webui: [] });
    const consumer = new ESLint({ cwd: packageRoot, overrideConfig: optedOut, overrideConfigFile: true });

    assert.equal(blocksCarrying(buildConfig({ ts: ["src/**/*.ts"] }), webuiRules).length, 1);
    assert.deepEqual(blocksCarrying(optedOut, webuiRules), []);
    assert.deepEqual(blocksCarrying(buildConfig(), webuiRules), []);
    assert.deepEqual(await countsAt({ filePath: webuiFile, linter: consumer, texts: refused }), each(refused, 0));
  });

  // The block reaches a module the folder does not hold yet, every rule at error severity, while a test file the folder does not hold yet keeps the common block's
  // warn severity for the inline-type rule and the template-literal entry, which that block sets, and none of the folder's other rules.
  it("holds a new module in the folder to every rule at error severity", async () => {

    const newModule = await eslint.calculateConfigForFile("src/webui/x.ts");
    const newTest = await eslint.calculateConfigForFile("src/webui/x.test.ts");

    assert.deepEqual(webuiRuleNames.map((rule) => severityOf(newModule, rule)), [ 2, 2, 2, 2 ]);
    assert.deepEqual(webuiRuleNames.map((rule) => severityOf(newTest, rule)), [ 1, undefined, undefined, 1 ]);
  });

  // The folder's block follows the common block, whose template-literal entry it carries on at error severity, and sits ahead of a consumer's own blocks, so a
  // consumer still has the final word.
  it("places the folder's block after the common block and ahead of a consumer's own blocks", async () => {

    const extra = { files: ["src/webui/**/*.ts"], rules: { "no-restricted-globals": "off" } };
    const configs = buildConfig({ extraConfigs: [extra], ts: ["src/**/*.ts"] });
    const [block] = blocksCarrying(configs, webuiRules);
    const [common] = blocksCarrying(configs, commonRules);
    const consumer = new ESLint({ cwd: packageRoot, overrideConfig: configs, overrideConfigFile: true });

    assert.ok(configs.indexOf(common) < configs.indexOf(block), "the folder's block must follow the common block.");
    assert.ok(configs.indexOf(block) < configs.indexOf(extra), "the folder's block must precede the consumer's own blocks.");
    assert.equal(severityOf(await consumer.calculateConfigForFile("src/webui/x.ts"), "no-restricted-globals"), 0);
    assert.equal(await ruleMessageCount({ filePath: webuiFile, rule: "no-restricted-syntax", source: "const a = `x`;\n" }), 1);
  });

  // The folder's preset is public as its sibling presets are, imported here by the package's own name, so a consumer that scopes the guard to a block of its own
  // spreads the same rules the builder's block carries.
  it("exports the folder's rule preset from the package's lint entry", () => {

    assert.equal(lintEntry.webuiRules, webuiRules);
  });
});
