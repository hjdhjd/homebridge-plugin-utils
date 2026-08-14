/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * runtime-floor.test.ts: The engines-keyed conformance guard for the internal explicit-resource-management shims. While the package's `engines.node` floor sits below
 * the Node release that ships DisposableStack, AsyncDisposableStack, and SuppressedError as platform globals, this suite asserts the shims guard every construction
 * site in the shipped source and that the polyfill installs exactly what a runtime below the floor is missing. The moment the floor is bumped to that release, the live
 * assertion fails with an enumerated cleanup list - the anti-forget mechanism that turns "delete the shims" from a thing to remember into a thing the suite demands.
 */
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import type { ErmInstallTarget } from "./polyfills.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { installErmPolyfills } from "./polyfills.ts";

// One shipped source file as the sweep reads it.
interface SweptFile {

  path: string;
  text: string;
}

// The major version of the Node release that first ships DisposableStack (and the rest of the explicit-resource-management globals) as a platform global. At or above
// this floor the shims are redundant and the sunset runs; below it they are required.
const NODE_ERM_GLOBAL_MAJOR = 24;

// The shim modules the construction sweep skips. Each DEFINES the class it constructs - its own `move()` builds a fresh instance - so demanding that it import itself
// would be nonsense. `suppressed-error.ts` is deliberately NOT carved out, because it constructs no stack, and neither is `polyfills.ts`, which constructs nothing at
// all (it assigns class references) and imports both shims regardless.
const SHIM_BASENAMES = [ "async-disposable-stack.ts", "disposable-stack.ts" ];

// The import specifiers each shim is reached by, anchored with a leading path separator so the synchronous shim's guard is not satisfied by an import of the async one:
// "./async-disposable-stack.ts" contains "disposable-stack.ts" but not "/disposable-stack.ts". The anchoring is what keeps the two guards independent.
const ASYNC_SHIM_SPECIFIER = "/async-disposable-stack.ts";
const SYNC_SHIM_SPECIFIER = "/disposable-stack.ts";

// Every artifact the sunset deletes outright. Each is path-anchored so no entry is a substring of another - a bare "disposable-stack.ts" would also be found inside
// "src/async-disposable-stack.ts", which would let the enumeration check pass on a message that named only the longer path.
const SUNSET_ARTIFACTS = [

  "src/async-disposable-stack.ts",
  "src/async-disposable-stack.test.ts",
  "src/disposable-stack.ts",
  "src/disposable-stack.test.ts",
  "src/polyfills.ts",
  "src/polyfills.test.ts",
  "src/suppressed-error.ts",
  "src/suppressed-error.test.ts",
  "the \"./polyfills\" entry in the package.json exports map"
];

// The enumerated cleanup the live assertion emits the moment the engines floor reaches the platform-global release. It names every artifact to remove so the sunset is
// a mechanical checklist rather than an archaeology exercise. The message is composed from SUNSET_ARTIFACTS, so the checklist and the fragments the synthetic
// sunset-regime test looks for cannot drift apart. That synthetic test asserts these fragments are present, so this path runs green today.
const SUNSET_CLEANUP = [

  "The Node runtime floor has reached the release that ships the explicit-resource-management globals, so the in-package shims and the polyfill that installs them are",
  "now redundant. Complete the sunset: delete " + SUNSET_ARTIFACTS.join(", ") + "; delete the shim import from src/ffmpeg/rtp.ts (the call sites already read against",
  "the platform global); and delete this file."
].join(" ");

// Detect a bare `new DisposableStack()` construction. The shim exists precisely so this reads against an imported class rather than the platform global; the sweep
// confirms every occurrence in shipped source is backed by the shim import. `using`/`await using` declarations need no separate detector: the bare construction call
// the regex targets appears identically regardless of the declaring keyword.
const NEW_DISPOSABLE_STACK = /new\s+DisposableStack\s*\(/;

// Detect a bare `new AsyncDisposableStack()` construction, held to the same shim-import rule as its synchronous sibling.
const NEW_ASYNC_DISPOSABLE_STACK = /new\s+AsyncDisposableStack\s*\(/;

// Decide whether one shipped file satisfies the shim-guard rule for a given construction pattern: a file that constructs the class must also import the module that
// defines it, and a file that constructs nothing satisfies the rule trivially. This per-file decision is a helper rather than an inline loop body so the tests can
// drive it BOTH ways - across the real shipped source, and against fabricated entries whose verdicts are known - which matters most for the async arm, where no real
// construction site exists today and an inline sweep body would therefore never execute.
function guardsConstruction(file: SweptFile, construction: RegExp, shimSpecifier: string): boolean {

  if(!construction.test(file.text)) {

    return true;
  }

  return file.text.includes(shimSpecifier);
}

// Parse the Node major version from an `engines.node` range and decide the regime: below the platform-global major the shims are required (compat), at or above it they
// must be removed (sunset). We read the first integer run as the major, which is the semantics of every range form we accept (">=22.20", "^24", ">=24.0.0"). An
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

// Enumerate the shipped source files the sweep inspects: every `.ts` under `src/` except test, helper, and fixture files, and except the shim modules themselves. The
// sibling `ui/` tree is not walked - it is browser-runtime code, not host Node, so the host runtime floor does not constrain it. Reads run in parallel.
async function sweptSourceFiles(): Promise<SweptFile[]> {

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

    return !SHIM_BASENAMES.includes(basename(relativePath));
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

    // The assert.equal above narrows plan to the sunset variant, so plan.message is in scope here. `src/ffmpeg/rtp.ts` and "this file" are the two cleanup steps that
    // are not outright deletions of a listed artifact, so they are named here rather than in SUNSET_ARTIFACTS.
    const expectedFragments = [ ...SUNSET_ARTIFACTS, "src/ffmpeg/rtp.ts", "this file" ];

    for(const fragment of expectedFragments) {

      assert.ok(plan.message.includes(fragment), "the sunset cleanup enumerates " + fragment);
    }
  });

  test("no sunset artifact is a substring of another", () => {

    // The enumeration check above is only as strong as its fragments are distinct: a fragment contained inside another would be satisfied by a message that named the
    // longer artifact alone. Path-anchoring every entry is what prevents that, and this is where the anchoring is enforced rather than assumed.
    for(const artifact of SUNSET_ARTIFACTS) {

      const others = SUNSET_ARTIFACTS.filter((candidate) => candidate !== artifact);

      assert.ok(!others.some((candidate) => candidate.includes(artifact)), artifact + " must not be a substring of another sunset artifact");
    }
  });

  test("the compat regime selects the source sweep plan", () => {

    assert.equal(planRuntimeFloorCheck(">=22.20").kind, "sweep");
  });
});

describe("HBPU runtime floor - shim guard enforcement", () => {

  test("the construction detectors match what they are meant to match, and nothing else", () => {

    assert.match("const stack = new DisposableStack();", NEW_DISPOSABLE_STACK, "the synchronous detector must match a synthetic positive");
    assert.doesNotMatch("const stack = new Stack();", NEW_DISPOSABLE_STACK, "the synchronous detector must not match an unrelated construction");
    assert.match("await using stack = new AsyncDisposableStack();", NEW_ASYNC_DISPOSABLE_STACK, "the async detector must match a synthetic positive");
    assert.doesNotMatch("const stack = new DisposableStack();", NEW_ASYNC_DISPOSABLE_STACK, "the async detector must not match the synchronous construction");
  });

  test("the guard rejects a construction without its shim import and accepts one with it", () => {

    // No shipped file constructs an AsyncDisposableStack today - the polyfill pattern means construction sites live in consumer repositories - so the live sweep below
    // never exercises the async arm's rejecting branch. Feeding the helper fabricated entries with known verdicts is what keeps that branch from shipping as a
    // vacuous all-clear.
    const violation = { path: "synthetic-violation.ts", text: "const stack = new AsyncDisposableStack();" };
    const compliant = { path: "synthetic-compliant.ts", text: "import { AsyncDisposableStack } from \"./async-disposable-stack.ts\";\n" +
      "const stack = new AsyncDisposableStack();" };
    const inert = { path: "synthetic-inert.ts", text: "const registry = new Map();" };

    assert.equal(guardsConstruction(violation, NEW_ASYNC_DISPOSABLE_STACK, ASYNC_SHIM_SPECIFIER), false, "constructing without the shim import must be rejected");
    assert.equal(guardsConstruction(compliant, NEW_ASYNC_DISPOSABLE_STACK, ASYNC_SHIM_SPECIFIER), true, "constructing with the shim import must be accepted");
    assert.equal(guardsConstruction(inert, NEW_ASYNC_DISPOSABLE_STACK, ASYNC_SHIM_SPECIFIER), true, "a file constructing neither stack satisfies the rule trivially");
  });

  test("importing the async shim does not satisfy the synchronous shim's guard", () => {

    // The two specifiers are anchored so they cannot stand in for each other. Without the leading separator, "disposable-stack.ts" would be found inside an import of
    // "./async-disposable-stack.ts" and this file would pass while constructing an unguarded synchronous stack.
    const wrongShim = { path: "synthetic-wrong-shim.ts", text: "import { AsyncDisposableStack } from \"./async-disposable-stack.ts\";\n" +
      "const stack = new DisposableStack();" };

    assert.equal(guardsConstruction(wrongShim, NEW_DISPOSABLE_STACK, SYNC_SHIM_SPECIFIER), false, "the async shim import must not satisfy the synchronous guard");
  });

  test("the polyfill installs exactly the explicit-resource-management constructors a runtime below the floor is missing", () => {

    const target: ErmInstallTarget = {};

    installErmPolyfills(target);

    // A behavioral pin rather than a text search: a grep over the module's source cannot tell a real install line from a mention of the same name in its
    // documentation, and the sunset checklist is only worth trusting if what it promises to remove is what the module actually installs.
    assert.deepEqual(Object.keys(target).sort(), [ "AsyncDisposableStack", "DisposableStack", "SuppressedError" ]);
  });
});

describe("HBPU runtime floor - live conformance", () => {

  test("the engines floor keeps the shim regime, and the shims guard every construction site", async () => {

    const plan = planRuntimeFloorCheck(await readEnginesNode());

    // The floor reached the platform-global release: fail with the enumerated cleanup so the shims cannot silently outlive the runtime they work around.
    if(plan.kind === "sunset") {

      assert.fail(plan.message);
    }

    const files = await sweptSourceFiles();

    // A mis-scoped walk that enumerates almost nothing must fail loudly rather than pass vacuously.
    assert.ok(files.length >= 20, "the source walk enumerated " + files.length.toString() + " files, expected at least 20");

    const constructionSites = files.filter((file) => NEW_DISPOSABLE_STACK.test(file.text));

    // The known occurrence in rtp.ts proves the synchronous detector detects. There is deliberately no matching minimum for the async arm: zero shipped construction
    // sites is the correct state today, since a consumer reaches the async stack through the polyfill and constructs it in its own repository.
    assert.ok(constructionSites.length >= 1, "at least one shipped file constructs a DisposableStack");
    assert.ok(constructionSites.some((file) => file.path.endsWith(join("ffmpeg", "rtp.ts"))), "src/ffmpeg/rtp.ts is among the DisposableStack construction sites");

    for(const file of files) {

      assert.ok(guardsConstruction(file, NEW_DISPOSABLE_STACK, SYNC_SHIM_SPECIFIER), file.path + " constructs a DisposableStack but does not import the shim");
      assert.ok(guardsConstruction(file, NEW_ASYNC_DISPOSABLE_STACK, ASYNC_SHIM_SPECIFIER), file.path + " constructs an AsyncDisposableStack but does not import " +
        "the shim");
    }
  });
});
