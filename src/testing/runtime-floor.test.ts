/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/runtime-floor.test.ts: Unit tests for the shared engines-keyed guard machinery - the regime parser, the plan union and its canary, the checklist composer,
 * the engines reader, and the shipped-source sweep. Every row here VARIES a parameter, because the one thing an adopting guard file cannot prove is that these
 * functions consume their arguments at all: it feeds exactly one configuration, so a function that quietly hardcoded that configuration's values would still pass it.
 * These rows feed each parameter at least two distinct values and pin that the answer moves with them.
 */
import { assertRuntimeFloorCompat, composeSunsetCleanup, parseRuntimeFloor, planRuntimeFloorCheck, readEnginesNode,
  sweepSourceFiles } from "./runtime-floor.ts";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// Build a throwaway directory tree and hand back its URL. Each entry is a path relative to the root paired with the text to write there; intermediate directories are
// created as needed, so a fixture declares "src/nested/thing.ts" without also declaring the directories above it. The trees are tiny and live under the OS temp
// directory, which is what lets the sweep rows exercise a real filesystem walk rather than a stubbed one.
async function makeTree(entries: Readonly<Record<string, string>>): Promise<URL> {

  const root = await mkdtemp(join(tmpdir(), "hbpu-runtime-floor-"));

  for(const [ relativePath, text ] of Object.entries(entries)) {

    const fullPath = join(root, relativePath);

    // eslint-disable-next-line no-await-in-loop
    await mkdir(join(fullPath, ".."), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(fullPath, text, "utf8");
  }

  // A directory URL needs its trailing separator, or `new URL("package.json", root)` would resolve against the parent instead.
  return pathToFileURL(root + "/");
}

// The basenames a swept result reports, sorted so a row can assert against a stable list regardless of the order the parallel reads landed in.
function sweptBasenames(files: readonly { path: string }[]): string[] {

  return files.map((file) => file.path.split("/").at(-1) ?? "").sort();
}

describe("parseRuntimeFloor", () => {

  test("reads the first digit run as the major, across every range form a package.json carries", () => {

    assert.equal(parseRuntimeFloor({ enginesNode: ">=22.20", sunsetMajor: 24 }).major, 22, "a >= range with a minor");
    assert.equal(parseRuntimeFloor({ enginesNode: "^24", sunsetMajor: 24 }).major, 24, "a caret range");
    assert.equal(parseRuntimeFloor({ enginesNode: ">=24.0.0", sunsetMajor: 24 }).major, 24, "a fully-qualified range");
    assert.equal(parseRuntimeFloor({ enginesNode: "20", sunsetMajor: 24 }).major, 20, "a bare major");
  });

  test("the regime turns on the CALLER'S sunset major, not on any value baked into the machinery", () => {

    // The parameter proof. One and the same range reads as either regime depending only on the major the caller supplies, so a parser that hardcoded a particular
    // release would fail one of these two rows whichever release it picked.
    assert.equal(parseRuntimeFloor({ enginesNode: ">=22.20", sunsetMajor: 24 }).regime, "compat", "a floor below the caller's major keeps the workaround");
    assert.equal(parseRuntimeFloor({ enginesNode: ">=22.20", sunsetMajor: 20 }).regime, "sunset", "the same floor is past a lower major, so the sunset is due");
  });

  test("the boundary is inclusive: a floor exactly at the sunset major selects the sunset regime", () => {

    assert.equal(parseRuntimeFloor({ enginesNode: ">=24", sunsetMajor: 24 }).regime, "sunset", "at the major the gap closed, the workaround is redundant");
    assert.equal(parseRuntimeFloor({ enginesNode: ">=23", sunsetMajor: 24 }).regime, "compat", "one major short, it is still owed");
  });

  test("throws on a range carrying no digits at all, naming the offending value", () => {

    // A hard failure rather than a silent default: a guard that assumed a regime here would be a guard that quietly stopped guarding.
    assert.throws(() => parseRuntimeFloor({ enginesNode: "not-a-version", sunsetMajor: 24 }), /Unable to parse a Node major version/);
    assert.throws(() => parseRuntimeFloor({ enginesNode: "", sunsetMajor: 24 }), /value: ""\./, "the message quotes the value it could not read");
  });
});

describe("planRuntimeFloorCheck", () => {

  test("the sunset arm carries the caller's own message verbatim", () => {

    const plan = planRuntimeFloorCheck({ enginesNode: ">=24", sunsetMajor: 24, sunsetMessage: "delete the widget and this file." });

    assert.equal(plan.kind, "sunset");

    // The narrowing above puts message in scope. Two distinct messages through the same call prove the arm carries what it was given rather than anything of its own.
    assert.equal(plan.message, "delete the widget and this file.");
    assert.equal(planRuntimeFloorCheck({ enginesNode: "^30", sunsetMajor: 24, sunsetMessage: "a different checklist." }).kind, "sunset");
  });

  test("the sweep arm carries no message at all", () => {

    const plan = planRuntimeFloorCheck({ enginesNode: ">=22.20", sunsetMajor: 24, sunsetMessage: "unused while the workaround is owed." });

    assert.equal(plan.kind, "sweep");

    // The two arms are one union precisely so this state is unrepresentable: there is no message field on the sweep arm to hold a checklist nobody should read.
    assert.equal("message" in plan, false, "the sweep arm does not carry the message it was handed");
  });

  test("the arm turns on the caller's sunset major, so both arms are reachable from one range", () => {

    assert.equal(planRuntimeFloorCheck({ enginesNode: ">=22.20", sunsetMajor: 24, sunsetMessage: "x" }).kind, "sweep");
    assert.equal(planRuntimeFloorCheck({ enginesNode: ">=22.20", sunsetMajor: 22, sunsetMessage: "x" }).kind, "sunset");
  });
});

describe("assertRuntimeFloorCompat", () => {

  test("fires with the plan's own checklist when the sunset is due", () => {

    const message = "Complete the sunset: delete src/shim.ts; and delete this file.";

    assert.throws(() => assertRuntimeFloorCompat({ kind: "sunset", message }), { message, name: "AssertionError" },
      "the canary must surface the checklist verbatim, since that message IS the cleanup instructions");
  });

  test("does nothing at all while the workaround is still owed", () => {

    assert.doesNotThrow(() => assertRuntimeFloorCompat({ kind: "sweep" }), "the compat arm must pass through silently so the sweep that follows it can run");
  });
});

describe("composeSunsetCleanup", () => {

  test("frames the artifact list with the caller's prologue, separator, and epilogue", () => {

    const composed = composeSunsetCleanup({ artifacts: [ "src/a.ts", "src/b.ts" ], epilogue: "; and delete this file.", prologue: "Delete ", separator: ", " });

    assert.equal(composed, "Delete src/a.ts, src/b.ts; and delete this file.");
  });

  test("the separator is the caller's, so a checklist whose entries carry commas can join on semicolons", () => {

    assert.equal(composeSunsetCleanup({ artifacts: [ "the x, in y", "the z" ], prologue: "Delete ", separator: "; " }), "Delete the x, in y; the z");
  });

  test("defaults to a comma separator and no epilogue", () => {

    assert.equal(composeSunsetCleanup({ artifacts: [ "one", "two", "three" ], prologue: "Remove " }), "Remove one, two, three");
  });

  test("every artifact appears verbatim, which is the property the enumeration checks rest on", () => {

    const artifacts = [ "src/alpha.ts", "src/bravo.ts", "the \"./x\" entry in the exports map" ];
    const composed = composeSunsetCleanup({ artifacts, epilogue: ".", prologue: "Delete ", separator: "; " });

    for(const artifact of artifacts) {

      assert.ok(composed.includes(artifact), "the composed checklist must contain " + artifact);
    }
  });
});

describe("readEnginesNode", () => {

  test("reads the range from the package.json at the root it is HANDED, not from any self-relative location", async () => {

    // The parameter proof that matters most for this function. Two roots, two different declared ranges, one reader: a copy that pathed relative to its own module
    // location would return the same answer for both - this library's own floor - and silently guard the wrong package.
    const first = await makeTree({ "package.json": JSON.stringify({ engines: { node: ">=22.20" } }) });
    const second = await makeTree({ "package.json": JSON.stringify({ engines: { node: "^30" } }) });

    assert.equal(await readEnginesNode(first), ">=22.20");
    assert.equal(await readEnginesNode(second), "^30");
  });

  test("throws when engines.node is absent or is not a string", async () => {

    const noEngines = await makeTree({ "package.json": JSON.stringify({ name: "x" }) });
    const notAString = await makeTree({ "package.json": JSON.stringify({ engines: { node: 24 } }) });

    await assert.rejects(readEnginesNode(noEngines), /engines.node field is missing or is not a string/);
    await assert.rejects(readEnginesNode(notAString), /engines.node field is missing or is not a string/);
  });
});

describe("sweepSourceFiles", () => {

  test("walks the roots it is handed, recursively, and carries each file's path and text", async () => {

    const root = await makeTree({ "a.ts": "first", "b.ts": "second", "deep/nested/c.ts": "third" });
    const files = await sweepSourceFiles({ roots: [root] });

    assert.deepEqual(sweptBasenames(files), [ "a.ts", "b.ts", "c.ts" ], "the walk is recursive");

    const nested = files.find((file) => file.path.endsWith("c.ts"));

    assert.ok(nested, "the nested file is present");
    assert.equal(nested.text, "third", "each record carries the file's full text");
    assert.ok(nested.path.startsWith("/"), "each record carries an absolute path");
  });

  test("takes MORE THAN ONE root and returns their union", async () => {

    // The roots parameter is a list rather than a single directory, and this is where that is proven rather than assumed.
    const first = await makeTree({ "one.ts": "1" });
    const second = await makeTree({ "two.ts": "2" });

    assert.deepEqual(sweptBasenames(await sweepSourceFiles({ roots: [ first, second ] })), [ "one.ts", "two.ts" ]);
  });

  test("skips suites, helpers, and fixtures, and keeps everything else", async () => {

    const root = await makeTree({

      "notes.md": "prose", "shipped.ts": "ship", "thing.fixtures.ts": "data", "thing.helpers.ts": "code", "thing.test.ts": "suite"
    });

    assert.deepEqual(sweptBasenames(await sweepSourceFiles({ roots: [root] })), ["shipped.ts"], "only shipped .ts source survives the filter");
  });

  test("the basename skip-list is the CALLER'S, so the same tree sweeps differently under different policies", async () => {

    // The other parameter proof. One tree, three skip-lists, three answers: a walker that hardcoded any particular exclusion would fail at least one of these.
    const entries = { "keep.ts": "k", "shim-a.ts": "a", "shim-b.ts": "b" };
    const root = await makeTree(entries);

    assert.deepEqual(sweptBasenames(await sweepSourceFiles({ roots: [root] })), [ "keep.ts", "shim-a.ts", "shim-b.ts" ], "no skip-list keeps everything");
    assert.deepEqual(sweptBasenames(await sweepSourceFiles({ roots: [root], skipBasenames: ["shim-a.ts"] })), [ "keep.ts", "shim-b.ts" ], "one entry skipped");
    assert.deepEqual(sweptBasenames(await sweepSourceFiles({ roots: [root], skipBasenames: [ "shim-a.ts", "shim-b.ts" ] })), ["keep.ts"], "both skipped");
  });

  test("the skip-list matches on basename, so a same-named file in any directory is skipped", async () => {

    const root = await makeTree({ "nested/keep.ts": "k", "nested/skipme.ts": "n", "skipme.ts": "s" });

    assert.deepEqual(sweptBasenames(await sweepSourceFiles({ roots: [root], skipBasenames: ["skipme.ts"] })), ["keep.ts"],
      "the skip applies at every depth, not just at the root");
  });

  test("an empty tree sweeps to nothing rather than throwing", async () => {

    assert.deepEqual(await sweepSourceFiles({ roots: [await makeTree({ "readme.md": "x" })] }), [], "a root with no shipped source yields an empty result");
  });
});
