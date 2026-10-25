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
import { posix } from "node:path";
import ts from "typescript";

/**
 * Name the specifiers the listed module `importer` may load at runtime: each module on the list, spelled as the importer's own source spells it.
 *
 * An entry is a module's path under `src/`, and the build keeps that path into `dist/ui/`, so a listed module's import of another listed module is written
 * relative to the importer's directory and reaches the same file in the source and in the shipped copy. A module at the root reaches a nested one as
 * `./webui/status.ts`, a nested module reaches a root one as `../formatters.ts`, and a nested module reaches a sibling in its own folder by its bare name.
 * `allowImportingTsExtensions` has the source name the `.ts` file and the emit rewrite turn it into the `.js` the browser fetches, so the source-level form is
 * the one this guard compares against.
 *
 * @param {string} importer - The importing module's list entry.
 * @param {readonly string[]} [listed] - The list the importer's reachable modules are drawn from: the real one, unless a row supplies its own.
 *
 * @returns {Set<string>} Every specifier the importer may name in a runtime import.
 */
function allowedFor(importer, listed = BROWSER_MODULES) {

  const from = posix.dirname(importer);

  return new Set(listed.map((name) => {

    const path = posix.relative(from, name);

    return (path.startsWith("../") ? path : ("./" + path)) + ".ts";
  }));
}

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
        if(node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) {

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

describe("browser-modules allowlist per importer", () => {

  // One nested importer over one list holding a module at the root and two in one folder, so each row's subject is the direction of the import rather than the
  // contents of the list.
  const allowed = allowedFor("webui/status", [ "formatters", "webui/sibling", "webui/status" ]);

  test("lets a nested module load a listed root module one directory up, and refuses the root-relative spelling", () => {

    assert.deepEqual(unsafeSpecifiers("import { formatBps } from \"../formatters.ts\";\nimport { formatBps as rootRelative } from \"./formatters.ts\";", allowed),
      ["./formatters.ts"], "a nested module reaches a root module one directory up, and the same name beside it is a file the copy step never ships there");
  });

  test("lets a nested module load a listed sibling in its own folder, and refuses the root-relative spelling", () => {

    assert.deepEqual(unsafeSpecifiers("import { wire } from \"./sibling.ts\";\nimport { wire as rootRelative } from \"./webui/sibling.ts\";", allowed),
      ["./webui/sibling.ts"], "a nested module reaches its sibling by its bare name, and a folder of the same name beneath it is a path the copy step never ships");
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
      const unsafe = unsafeSpecifiers(source, allowedFor(name));
      const found = unsafe.map((specifier) => (specifier === null) ? "a dynamic import whose specifier is computed" : "\"" + specifier + "\"").join(", ");

      assert.deepEqual(unsafe, [], "src/" + name + ".ts loads " + found + " at runtime, which the browser bundle does not carry." + REMEDY);
    }
  });
});
