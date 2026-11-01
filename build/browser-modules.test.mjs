/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * browser-modules.test.mjs: Unit tests for the closure rule behind the browser bundle - that every module BROWSER_MODULES names loads nothing at runtime but
 * another module on that same list. The browser fetches each listed module directly out of dist/ui/, so a runtime import reaching anywhere else is a file the
 * page asks for and the copy step never shipped. Importing from `util.ts` is the canonical violation: it reaches for `isIP` from `node:net`, which no browser
 * resolves. Specifiers are read from the TypeScript parser rather than matched out of the source text, so every form a runtime edge can take arrives as a node
 * and a form nobody anticipated fails by exclusion rather than slipping past an enumeration. Beside it stands the load rule - that every script dist/ui/ ships,
 * the compiled modules BROWSER_MODULES names and the hand-written scripts alike, loads in JavaScriptCore, Safari's engine, wherever macOS provides its shell, and
 * the naming module answers there exactly as it does in V8.
 */
import { UI_OUTPUT, UI_SOURCE } from "./build-paths.mjs";
import { after, describe, test } from "node:test";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { sanitizeName, validateName } from "../src/homekit-name.ts";
import { BROWSER_MODULES } from "./browser-modules.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeScratchRoot } from "../src/testing/index.ts";
import { promisify } from "node:util";
import { runToExit } from "./child-process.helpers.mjs";
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

// The JavaScriptCore shell macOS ships inside its system framework. A host without it skips the load rule rather than failing it, as the FFmpeg integration
// suites skip on a host without FFmpeg.
const JSC_SHELL = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";

// The build's copy step and the project tsc emits dist/ from, each resolved from this file so the suite runs from any working directory.
const COPY_STEP = fileURLToPath(new URL("./fs-ops.mjs", import.meta.url));
const BUILD_PROJECT = fileURLToPath(new URL("../tsconfig.build.json", import.meta.url));

/* The script the shell runs before each probe. The bare engine carries no DOM, and the feature-options store reads `CustomEvent` and extends `EventTarget` as it
 * loads, so without these every script importing the store would fail on a missing page global rather than on anything of its own. Empty classes are all a load
 * needs, because the rows prove that a script parses, links and evaluates in JavaScriptCore, not that the page behaves.
 */
const DOM_STAND_IN = "globalThis.EventTarget = class EventTarget {};\nglobalThis.Event = class Event {};\n" +
  "globalThis.CustomEvent = class CustomEvent extends Event {};\n";

/**
 * Answer the compiler options tsc emits dist/ with, read through the TypeScript API from the build's own project, so a listed module compiles here as it does there.
 *
 * The module kind is the one option set apart. tsc emits ESM for this package because nodenext reads the `"type": "module"` in package.json, but
 * `ts.transpileModule` compiles one file without reading any package.json, and under nodenext it then emits CommonJS, which no browser loads. ESNext asks for the
 * ESM the build emits, and every other option, the rewrite of a relative `.ts` import to `.js` among them, stays the build's own.
 *
 * @returns {ts.CompilerOptions} The build's compiler options, with an ESM module kind.
 */
function browserCompilerOptions() {

  const unrecoverable = [];
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => unrecoverable.push(diagnostic) };
  const parsed = ts.getParsedCommandLineOfConfigFile(BUILD_PROJECT, {}, host);
  const messages = [ ...unrecoverable, ...(parsed?.errors ?? []) ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

  assert.deepEqual(messages, [], "tsconfig.build.json must parse, since the load rule compiles each listed module with the options the build emits dist/ with.");

  return { ...parsed.options, module: ts.ModuleKind.ESNext };
}

/**
 * Reduce the naming module's answers for every Unicode scalar value to a run-length digest: one series per placement, each a list of `[codePoint, answer]` pairs
 * marking where the answer changes. The validator's answer is 1 or 0, and the sanitizer's is its output with the character marked, which keeps the runs long while
 * still telling apart every output the character could produce. The digest is exact, so the digests of JavaScriptCore and V8 match only when every answer does.
 *
 * The parity row runs this in JavaScriptCore and in V8, reaching JavaScriptCore as its own source text inside the probe, so it reads nothing from outside its
 * parameter.
 *
 * @param {object} module
 * @param {(name: string) => string} module.sanitizeName - The naming module's sanitizer.
 * @param {(name: string) => boolean} module.validateName - The naming module's validator.
 *
 * @returns {Record<string, [number, number | string][]>} The digest, keyed by placement.
 */
function namingDigest({ sanitizeName, validateName }) {

  const MARKER = "\u0001";
  const placements = [
    [ "validateName with the character alone", (character) => validateName(character) ? 1 : 0 ],
    [ "validateName with the character between letters", (character) => validateName("a" + character + "b") ? 1 : 0 ],
    [ "validateName with the character last after a letter", (character) => validateName("a" + character) ? 1 : 0 ],
    [ "sanitizeName with the character at the start, inside and at the end",
      (character) => sanitizeName(character + "a" + character + "b" + character).replaceAll(character, MARKER) ]
  ];
  const digest = Object.fromEntries(placements.map(([name]) => [ name, [] ]));
  const previous = placements.map(() => undefined);

  for(let codePoint = 0; codePoint <= 0x10FFFF; codePoint++) {

    // Surrogate code points are not scalar values, so the sweep passes over them.
    if((codePoint >= 0xD800) && (codePoint <= 0xDFFF)) {

      continue;
    }

    const character = String.fromCodePoint(codePoint);

    for(const [ index, [ name, answer ] ] of placements.entries()) {

      const key = answer(character);

      if(key !== previous[index]) {

        digest[name].push([ codePoint, key ]);
        previous[index] = key;
      }
    }
  }

  return digest;
}

/**
 * Find the first code point at which one run-length series answers differently from another. Each series holds its answer from one run's start to the next, so
 * the first difference falls on a run start of one series or the other, and only those code points need comparing.
 *
 * @param {[number, number | string][]} left - One engine's series.
 * @param {[number, number | string][]} right - The other engine's series for the same placement.
 *
 * @returns {number | null} The first code point the series disagree on, or `null` when they agree everywhere.
 */
function firstDivergence(left, right) {

  const answerAt = (series, codePoint) => series.findLast(([start]) => start <= codePoint)?.[1];
  const starts = [...new Set([ ...left, ...right ].map(([start]) => start))].sort((a, b) => a - b);

  return starts.find((start) => answerAt(left, start) !== answerAt(right, start)) ?? null;
}

/* The load rule and the naming module's parity check. Node's run of the unit suite loads every script dist/ui/ ships, or the source it compiles from, in V8,
 * Chrome's engine, so V8 needs no rows of its own here. JavaScriptCore, Safari's engine, refuses some patterns V8 accepts and computes some character classes
 * differently, and a script that throws while it loads takes its settings page down in Safari while every Node row stays green. So each load row loads one shipped
 * script in JavaScriptCore's shell, and the parity row holds the naming module's answers there to V8's. The scratch tree is laid out as the build lays out
 * dist/ui/, by the build's own copy step and with its own compiler options, so a script's relative imports resolve as they do on the page and the rows need no
 * prior build.
 */
describe("browser-modules in JavaScriptCore", { skip: existsSync(JSC_SHELL) ? false : "The macOS JavaScriptCore shell is not present on this host." }, async () => {

  const scratch = await makeScratchRoot("hbpu-browser-modules-");

  after(async () => {

    await scratch[Symbol.asyncDispose]();
  });

  const uiOutput = join(scratch.path, UI_OUTPUT);
  const standIn = join(scratch.path, "dom-stand-in.js");

  // The hand-written scripts are whatever the build's copy step ships when it runs over a copy of ui/, so the rows follow the build's own rule for what ships.
  await cp(fileURLToPath(new URL("../" + UI_SOURCE, import.meta.url)), join(scratch.path, UI_SOURCE), { recursive: true });
  await promisify(execFile)(process.execPath, [ COPY_STEP, "build-ui" ], { cwd: scratch.path });

  const handWritten = (await readdir(uiOutput, { recursive: true })).filter((path) => path.endsWith(".mjs")).sort();
  const compilerOptions = browserCompilerOptions();

  // Each listed module lands at its entry beside the copied scripts, where the build's finalize step places it, so a hand-written script's import of it resolves.
  await Promise.all(BROWSER_MODULES.map(async (entry) => {

    const source = new URL("../src/" + entry + ".ts", import.meta.url);
    const target = join(uiOutput, entry + ".js");

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, ts.transpileModule(await readFile(source, "utf8"), { compilerOptions, fileName: fileURLToPath(source) }).outputText);
  }));

  await writeFile(standIn, DOM_STAND_IN);

  const scripts = [ ...BROWSER_MODULES.map((entry) => ({ path: entry + ".js", source: "src/" + entry + ".ts" })),
    ...handWritten.map((path) => ({ path, source: posix.join(UI_SOURCE, path) })) ];

  // The hand-written rows are drawn from what the copy step ships, so a copy step that ships nothing would leave them absent rather than failing. This row is what
  // turns that case into a failure.
  test("finds a hand-written script the copy step ships", () => {

    assert.ok(handWritten.length > 0, "The copy step shipped no script from " + UI_SOURCE + "/ into " + UI_OUTPUT + "/, so no hand-written script has a load row.");
  });

  for(const [ index, { path, source } ] of scripts.entries()) {

    test("loads " + source, async (t) => {

      // The probe imports the script as a page does, so the shell links and evaluates it together with every script it imports in turn.
      const probe = join(scratch.path, "probe-" + index + ".mjs");

      await writeFile(probe, "import \"./" + posix.join(UI_OUTPUT, path) + "\";\n");

      // The shell runs the stand-in as a script and then the probe as a module. The row's signal ends the shell if the runner abandons the row, and the message
      // carries everything the shell printed, whichever stream it went to, because the shell prints an uncaught exception on its standard output.
      const { code, stderr, stdout } = await runToExit(JSC_SHELL, [ standIn, "-m", probe ], { signal: t.signal });

      assert.equal(code, 0, source + " fails to load in JavaScriptCore, Safari's engine. The shell printed:\n" + stdout + stderr);
    });
  }

  // Loading proves the naming module's classes compile in JavaScriptCore, not that they hold the same characters there, and the classes rest on Unicode property
  // sets each engine computes on its own. So this row sweeps every scalar value through the module in each engine and compares the digests, which are all that
  // crosses the process boundary.
  test("answers every scalar value in JavaScriptCore as V8 does for src/homekit-name.ts", async (t) => {

    const probe = join(scratch.path, "homekit-name-parity.mjs");

    await writeFile(probe, "import { sanitizeName, validateName } from \"./" + posix.join(UI_OUTPUT, "homekit-name.js") + "\";\n\nprint(JSON.stringify((" +
      namingDigest.toString() + ")({ sanitizeName, validateName })));\n");

    const { code, stderr, stdout } = await runToExit(JSC_SHELL, [ "-m", probe ], { signal: t.signal });

    assert.equal(code, 0, "src/homekit-name.ts fails its parity probe in JavaScriptCore. The shell printed:\n" + stdout + stderr);

    const inJavaScriptCore = JSON.parse(stdout);
    const inV8 = namingDigest({ sanitizeName, validateName });
    const divergences = Object.keys(inV8).flatMap((placement) => {

      const codePoint = firstDivergence(inJavaScriptCore[placement], inV8[placement]);

      return (codePoint === null) ? [] : [placement + " first differs at U+" + codePoint.toString(16).toUpperCase().padStart(4, "0")];
    });

    assert.deepEqual(divergences, [], "src/homekit-name.ts answers differently in JavaScriptCore and V8: " + divergences.join("; ") + ".");
  });
});
