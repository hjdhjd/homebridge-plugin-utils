/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * runtime-floor.test.ts: The engines-keyed conformance guard for the internal DisposableStack shim. While the package's `engines.node` floor sits below the Node
 * release that ships DisposableStack as a platform global, this suite asserts the shim guards every construction site in the shipped source. The moment the floor is
 * bumped to that release, the live assertion fails with an enumerated cleanup list - the anti-forget mechanism that turns "delete the shim" from a thing to remember
 * into a thing the suite demands.
 */
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The major version of the Node release that first ships DisposableStack (and the rest of the explicit-resource-management globals) as a platform global. At or above
// this floor the shim is redundant and the sunset runs; below it the shim is required.
const NODE_ERM_GLOBAL_MAJOR = 24;

// The enumerated cleanup the live assertion emits the moment the engines floor reaches the platform-global release. It names every artifact to remove so the sunset is
// a mechanical checklist rather than an archaeology exercise. The synthetic sunset-regime test asserts these fragments are present, so this path runs green today.
const SUNSET_CLEANUP = [

  "The Node runtime floor has reached the release that ships DisposableStack as a platform global, so the in-package shim is now redundant. Complete the sunset:",
  "delete src/disposable-stack.ts, delete the shim import from src/ffmpeg/rtp.ts (the call sites already read against the platform global), delete",
  "src/disposable-stack.test.ts, and delete this file."
].join(" ");

// Detect a bare `new DisposableStack()` construction. The shim exists precisely so this reads against an imported class rather than the platform global; the sweep
// confirms every occurrence in shipped source is backed by the shim import. `using`/`await using` declarations are intentionally NOT swept: the ES2024 compile target
// downlevels that syntax, so only bare global references survive to the runtime and could break on the Node 22 floor.
const NEW_DISPOSABLE_STACK = /new\s+DisposableStack\s*\(/;

// Detect a bare `new AsyncDisposableStack()` construction. No shim exists for the async variant, so any occurrence while the floor is below the platform-global release
// is an unguarded leak that would throw on Node 22.
const NEW_ASYNC_DISPOSABLE_STACK = /new\s+AsyncDisposableStack\s*\(/;

// Parse the Node major version from an `engines.node` range and decide the regime: below the platform-global major the shim is required (compat), at or above it the
// shim must be removed (sunset). We read the first integer run as the major, which is the semantics of every range form we accept (">=22.20", "^24", ">=24.0.0"). An
// unparseable value is a hard failure, never a silent default.
function parseRuntimeFloor(enginesNode: string): { major: number; regime: "compat" | "sunset" } {

  const digits = /(\d+)/.exec(enginesNode)?.[0];

  if(digits === undefined) {

    throw new Error("Unable to parse a Node major version from the engines.node value: " + JSON.stringify(enginesNode) + ".");
  }

  const major = Number(digits);

  return { major, regime: (major >= NODE_ERM_GLOBAL_MAJOR) ? "sunset" : "compat" };
}

// Map an `engines.node` range to the action the live assertion takes: in the sunset regime it fails with the enumerated cleanup, in the compat regime it runs the
// source sweep. Both arms of this function execute on every suite run - the synthetic tests drive the sunset arm with ">=24" and the sweep arm with ">=22.20", and the
// live assertion drives whichever the real package.json selects - so the sunset canary's firing path is never dead code proven only by a replica.
function planRuntimeFloorCheck(enginesNode: string): { kind: "sunset"; message: string } | { kind: "sweep" } {

  const { regime } = parseRuntimeFloor(enginesNode);

  if(regime === "sunset") {

    return { kind: "sunset", message: SUNSET_CLEANUP };
  }

  return { kind: "sweep" };
}

// Read the package's own `engines.node`. This test derives its regime from nothing but the package's declared runtime floor - the single source of truth for what the
// library supports.
async function readEnginesNode(): Promise<string> {

  const packageJsonText = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const packageJson = JSON.parse(packageJsonText) as { engines?: { node?: unknown } };
  const enginesNode = packageJson.engines?.node;

  if(typeof enginesNode !== "string") {

    throw new Error("The package.json engines.node field is missing or is not a string.");
  }

  return enginesNode;
}

// Enumerate the shipped source files the sweep inspects: every `.ts` under `src/` except test, helper, and fixture files, and except the shim module itself (which is
// the one file that legitimately defines and constructs DisposableStack without importing it). The sibling `ui/` tree is not walked - it is browser-runtime code, not
// host Node, so the host runtime floor does not constrain it. Reads run in parallel.
async function sweptSourceFiles(): Promise<{ path: string; text: string }[]> {

  const srcDirectory = fileURLToPath(new URL(".", import.meta.url));
  const relativePaths = await readdir(srcDirectory, { recursive: true });
  const excludedSuffixes = [ ".fixtures.ts", ".helpers.ts", ".test.ts" ];
  const candidatePaths = relativePaths.filter((relativePath) => {

    if(!relativePath.endsWith(".ts")) {

      return false;
    }

    if(excludedSuffixes.some((suffix) => relativePath.endsWith(suffix))) {

      return false;
    }

    return basename(relativePath) !== "disposable-stack.ts";
  });

  return Promise.all(candidatePaths.map(async (relativePath) => {

    const fullPath = join(srcDirectory, relativePath);

    return { path: fullPath, text: await readFile(fullPath, "utf8") };
  }));
}

describe("HBPU runtime floor - regime helper", () => {

  test("parses the compat floor and selects the compat regime", () => {

    const result = parseRuntimeFloor(">=22.20");

    assert.equal(result.major, 22);
    assert.equal(result.regime, "compat");
  });

  test("parses a >=24 floor and selects the sunset regime", () => {

    const result = parseRuntimeFloor(">=24");

    assert.equal(result.major, 24);
    assert.equal(result.regime, "sunset");
  });

  test("parses a ^24 floor and selects the sunset regime", () => {

    assert.equal(parseRuntimeFloor("^24").regime, "sunset");
  });

  test("throws on an unparseable engines value", () => {

    assert.throws(() => parseRuntimeFloor("not-a-version"), /Unable to parse/);
  });

  test("the sunset regime produces the enumerated cleanup plan", () => {

    const plan = planRuntimeFloorCheck(">=24");

    assert.equal(plan.kind, "sunset");

    // The assert.equal above narrows plan to the sunset variant, so plan.message is in scope here.
    const expectedFragments = [ "disposable-stack.ts", "src/ffmpeg/rtp.ts", "disposable-stack.test.ts", "this file" ];

    for(const fragment of expectedFragments) {

      assert.ok(plan.message.includes(fragment), "the sunset cleanup enumerates " + fragment);
    }
  });

  test("the compat regime selects the source sweep plan", () => {

    assert.equal(planRuntimeFloorCheck(">=22.20").kind, "sweep");
  });
});

describe("HBPU runtime floor - live conformance", () => {

  test("the engines floor keeps the shim regime, and the shim guards every DisposableStack construction site", async () => {

    const plan = planRuntimeFloorCheck(await readEnginesNode());

    // The floor reached the platform-global release: fail with the enumerated cleanup so the shim cannot silently outlive the runtime it works around.
    if(plan.kind === "sunset") {

      assert.fail(plan.message);
    }

    const files = await sweptSourceFiles();

    // A mis-scoped walk that enumerates almost nothing must fail loudly rather than pass vacuously.
    assert.ok(files.length >= 20, "the source walk enumerated " + files.length.toString() + " files, expected at least 20");

    // Self-test the detector so a silently-broken pattern fails loudly rather than reporting a false all-clear.
    assert.match("const stack = new DisposableStack();", NEW_DISPOSABLE_STACK, "the detector must match a synthetic positive");
    assert.doesNotMatch("const stack = new Stack();", NEW_DISPOSABLE_STACK, "the detector must not match an unrelated construction");

    const constructionSites = files.filter((file) => NEW_DISPOSABLE_STACK.test(file.text));

    // The known occurrence in rtp.ts proves the detector detects, and every construction site must be backed by the shim import.
    assert.ok(constructionSites.length >= 1, "at least one shipped file constructs a DisposableStack");
    assert.ok(constructionSites.some((file) => file.path.endsWith(join("ffmpeg", "rtp.ts"))), "src/ffmpeg/rtp.ts is among the DisposableStack construction sites");

    for(const file of constructionSites) {

      assert.ok(file.text.includes("disposable-stack.ts"), file.path + " constructs a DisposableStack but does not import the shim");
    }

    // No shipped file may construct an AsyncDisposableStack: there is no shim for it, so it would throw on the Node 22 floor.
    for(const file of files) {

      assert.doesNotMatch(file.text, NEW_ASYNC_DISPOSABLE_STACK, file.path + " constructs an AsyncDisposableStack, for which no shim exists");
    }
  });
});
