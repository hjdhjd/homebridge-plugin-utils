/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * browser-modules.test.mjs: Unit tests for the closure rule behind the browser bundle - that every module BROWSER_MODULES names loads nothing at runtime but
 * another module on that same list. The browser fetches each listed module directly out of dist/ui/, so a runtime import reaching anywhere else is a file the
 * page asks for and the copy step never shipped. Importing from `util.ts` is the canonical violation: it reaches for `isIP` from `node:net`, which no browser
 * resolves. Specifiers are read from the TypeScript parser rather than matched out of the source text, so every form a runtime edge can take arrives as a node
 * and a form nobody anticipated fails by exclusion rather than slipping past an enumeration.
 */
import { describe, test } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { BROWSER_MODULES } from "./browser-modules.mjs";
import assert from "node:assert/strict";
import ts from "typescript";

// The specifiers a listed module may load at runtime: each of its siblings on the list, spelled as the source spells it. `allowImportingTsExtensions` has the
// source name the `.ts` file and the emit rewrite turn it into the `.js` the browser fetches, so the source-level form is the one this guard compares against.
const ALLOWED = new Set(BROWSER_MODULES.map((name) => "./" + name + ".ts"));

// The fix every failure below points at, stated once so each message ends the same way.
const REMEDY = " A module joins the browser bundle only by being added to BROWSER_MODULES in build/browser-modules.mjs, and only if its own imports are " +
  "browser-safe.";

/**
 * Collect the module specifiers `source` loads at runtime that `allowed` does not carry.
 *
 * A declaration is a runtime edge unless it is spelled `import type` or `export type`. `verbatimModuleSyntax` emits every other form exactly as written, so a
 * declaration whose every named specifier carries an inline `type` qualifier still loads its module at runtime and still counts here. A dynamic import whose
 * argument is not a string literal names a module this guard cannot read, so it comes back as `null` for the caller to report rather than passing silently.
 *
 * @param {string} source - The TypeScript source to read.
 * @param {ReadonlySet<string>} allowed - The specifiers a runtime import in `source` may name.
 *
 * @returns {(string | null)[]} Every runtime specifier `allowed` does not carry, in source order, with `null` for a dynamic import whose specifier is computed.
 */
function unsafeSpecifiers(source, allowed) {

  const parsed = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest);
  const unsafe = [];

  const record = (specifier) => {

    if((specifier === null) || !allowed.has(specifier)) {

      unsafe.push(specifier);
    }
  };

  const visit = (node) => {

    switch(node.kind) {

      case ts.SyntaxKind.CallExpression: {

        // A dynamic import is a call whose callee is the `import` keyword itself rather than a name, which is what tells it from an ordinary call.
        if(node.expression.kind === ts.SyntaxKind.ImportKeyword) {

          const [argument] = node.arguments;

          record(((argument !== undefined) && ts.isStringLiteral(argument)) ? argument.text : null);
        }

        break;
      }

      case ts.SyntaxKind.ExportDeclaration: {

        // A re-export carries a module specifier; a plain `export { x };` does not, and loads nothing.
        if(!node.isTypeOnly && (node.moduleSpecifier !== undefined)) {

          record(node.moduleSpecifier.text);
        }

        break;
      }

      case ts.SyntaxKind.ImportDeclaration: {

        // A side-effect import has no import clause at all, which leaves the type-only reading undefined and the declaration a runtime edge, as it should be.
        if(node.importClause?.isTypeOnly !== true) {

          record(node.moduleSpecifier.text);
        }

        break;
      }

      case ts.SyntaxKind.ImportEqualsDeclaration: {

        if(!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {

          record(ts.isStringLiteral(node.moduleReference.expression) ? node.moduleReference.expression.text : null);
        }

        break;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);

  return unsafe;
}

describe("browser-modules runtime-import forms", () => {

  // One allowlist for every synthetic row, carrying a single specifier, so each row's subject is the form of the import rather than the contents of the list.
  const allowed = new Set(["./formatters.ts"]);

  test("lets a specifier the allowlist carries through", () => {

    assert.deepEqual(unsafeSpecifiers("import { formatBps } from \"./formatters.ts\";", allowed), [],
      "a value import naming a listed sibling is the shape the bundle is built around and must pass");
  });

  test("refuses a relative specifier the allowlist does not carry", () => {

    assert.deepEqual(unsafeSpecifiers("import { markHandled } from \"./mark-handled.ts\";", allowed), ["./mark-handled.ts"],
      "a relative specifier off the allowlist names a file the copy step does not ship beside this one");
  });

  test("reads a side-effect import", () => {

    assert.deepEqual(unsafeSpecifiers("import \"./side-effect.ts\";", allowed), ["./side-effect.ts"],
      "an import with no clause still loads its module, so it is a runtime edge like any other");
  });

  test("reads a re-export in both spellings", () => {

    assert.deepEqual(unsafeSpecifiers("export * from \"./star.ts\";\nexport { named } from \"./named.ts\";\nexport { local };", allowed),
      [ "./star.ts", "./named.ts" ], "both re-export spellings load their module, and a plain export naming no module loads nothing");
  });

  test("reads an import-equals external module reference", () => {

    assert.deepEqual(unsafeSpecifiers("import legacy = require(\"./legacy.ts\");", allowed), ["./legacy.ts"],
      "the import-equals form reaches a module by a different grammar and must be read all the same");
  });

  test("reads a dynamic import that names a string literal", () => {

    assert.deepEqual(unsafeSpecifiers("const loaded = await import(\"./dynamic.ts\");", allowed), ["./dynamic.ts"],
      "a dynamic import loads its module when the call runs, so a literal specifier is read exactly as a static one is");
  });

  test("answers null for a dynamic import whose specifier is computed", () => {

    assert.deepEqual(unsafeSpecifiers("const loaded = await import(chosenName);", allowed), [null],
      "a computed specifier names a module nobody can read from the source, which is a failure rather than a pass");
  });

  test("reads a declaration whose every specifier carries an inline type qualifier", () => {

    assert.deepEqual(unsafeSpecifiers("import { type Alpha, type Beta } from \"./inline.ts\";", allowed), ["./inline.ts"],
      "verbatimModuleSyntax emits this declaration as written, so the module is loaded at runtime however its names are qualified");
  });

  test("ignores a type-only import and a type-only re-export", () => {

    assert.deepEqual(unsafeSpecifiers("import type { Nullable } from \"./util.ts\";\nexport type { Clock } from \"./clock.ts\";", allowed), [],
      "both forms are erased before emit, so neither reaches the browser and neither is a runtime edge");
  });

  test("refuses a node: specifier and a bare package specifier", () => {

    assert.deepEqual(unsafeSpecifiers("import { isIP } from \"node:net\";\nimport ts from \"typescript\";", allowed), [ "node:net", "typescript" ],
      "nothing outside the allowlist passes, so a Node builtin and a package are refused by exclusion rather than by being named");
  });
});

describe("browser-modules browser-safe closure", () => {

  test("names a source file that exists for every listed module", async () => {

    const stats = await Promise.all(BROWSER_MODULES.map((name) => stat(new URL("../src/" + name + ".ts", import.meta.url))));

    for(const [ index, entry ] of stats.entries()) {

      assert.ok(entry.isFile(), "src/" + BROWSER_MODULES[index] + ".ts must exist, since the copy step ships a compiled module for every listed name." + REMEDY);
    }
  });

  test("loads nothing at runtime outside the list", async () => {

    const sources = await Promise.all(BROWSER_MODULES.map((name) => readFile(new URL("../src/" + name + ".ts", import.meta.url), "utf8")));

    for(const [ index, source ] of sources.entries()) {

      const name = BROWSER_MODULES[index];
      const unsafe = unsafeSpecifiers(source, ALLOWED);
      const found = unsafe.map((specifier) => (specifier === null) ? "a dynamic import whose specifier is computed" : "\"" + specifier + "\"").join(", ");

      assert.deepEqual(unsafe, [], "src/" + name + ".ts loads " + found + " at runtime, which the browser bundle does not carry." + REMEDY);
    }
  });
});
