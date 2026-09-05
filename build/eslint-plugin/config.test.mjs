/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.mjs: Composition tests for the flat-config builder. These resolve this package's own `eslint.config.mjs` through ESLint's own configuration
 * machinery and assert the effective rule severities and global vocabularies each file set ends up with: the TypeScript compatibility overlay confined to
 * TypeScript paths, the ESLint-recommended correctness baseline active on JavaScript and browser-UI paths, and the browser and Node global vocabularies
 * merging on the test-side UI files that match both blocks.
 */
import { describe, it } from "node:test";
import { ESLint } from "eslint";
import assert from "node:assert/strict";
import composedConfig from "../../eslint.config.mjs";
import { fileURLToPath } from "node:url";

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

// Reading a resolved severity says the rule is configured; linting a fixture says what it does with its option, which is what the rows below assert. The text
// is linted under an existing project file's path because the preset declares no default project, so a virtual path has no project membership to lint
// against - the source is linted in memory and nothing is written to disk. Counting only this rule's messages keeps the assertion clear of the fixture's
// unused bindings, which belong to another rule.
async function duplicateImportCount(source) {

  const [result] = await eslint.lintText(source, { filePath: "src/util.ts" });

  return result.messages.filter((message) => message.ruleId === "no-duplicate-imports").length;
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

  // A test-side UI file matches both the preset's UI block and this package's Node-environment block. Flat config merges `globals` across every matching
  // block, so such a file needs both vocabularies at once to satisfy `no-undef` - browser APIs from the DOM the suite builds, Node APIs from the runner.
  it("merges the browser and Node vocabularies for test-side UI paths", async () => {

    const config = await eslint.calculateConfigForFile("ui/webUi.test.mjs");
    const globals = config.languageOptions?.globals ?? {};

    assert.equal(globals.document, "readonly");
    assert.equal(globals.process, "readonly");
  });

  // Two value declarations of one module are what the rule exists to catch, and their member lists make no difference to it.
  it("flags a second value import of one module", async () => {

    assert.equal(await duplicateImportCount("import { a } from \"x\";\nimport { b } from \"x\";\n"), 1);
  });

  // The house style asks for a type-only declaration beside the value one, and `allowSeparateTypeImports` is what keeps the rule from contradicting the style
  // it serves: without the option every one of those pairs reads as a duplicate.
  it("admits the type-beside-value pair the house style requires", async () => {

    assert.equal(await duplicateImportCount("import type { T } from \"x\";\nimport { a } from \"x\";\n"), 0);
  });
});
