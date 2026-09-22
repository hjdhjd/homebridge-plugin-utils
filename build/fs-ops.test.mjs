/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fs-ops.test.mjs: Unit tests for the build script's `publish-docs` and `audit-package` verbs - the promotion of a staged TypeDoc run into docs/, the prune of the
 * generated pages a run did not produce, the refusal that keeps an unstaged run from sweeping the published tree, and the audit that traces every packaged file
 * back to a source git tracks and refuses a test-only file of any shape. Every path the script names is relative to its working directory, so each row writes a
 * fixture repository under a tmpdir and runs the real script as a subprocess with that fixture as its working directory - the same invocation the `build-docs`
 * script and the publish gate make, exit code and stderr included. The audit rows make their fixture a real git repository so the verb's own `git ls-files` reads
 * a real index. Nothing here touches this repository's own docs, and the shared path constants get one row of their own holding them to the TypeScript projects
 * that declare the same pairs.
 */
import { DIST_ROOT, PLUGIN_OUTPUT, PLUGIN_SOURCE, SRC_ROOT } from "./build-paths.mjs";
import { after, describe, test } from "node:test";
import { dirname, join, relative, sep } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

// The script under test, resolved from this file's own location so the suite runs correctly from any working directory.
const SCRIPT = fileURLToPath(new URL("./fs-ops.mjs", import.meta.url));

// The repository root, so the row that holds the shared path constants to the TypeScript projects can read those projects wherever the suite is run from.
const PROJECT_ROOT = new URL("../", import.meta.url);

// The refusal a run with nothing staged answers with, held to the byte because it is the only thing that tells a caller which step they skipped.
const NOTHING_STAGED = "Nothing to publish: run typedoc first so .docs-staging holds the generated pages.\n";

// One tmpdir for the whole suite, with each row allocating its own repository directory inside it, which keeps the cleanup below to a single removal.
const fixtureRoot = await mkdtemp(join(tmpdir(), "hbpu-fs-ops-"));

after(async () => {

  await rm(fixtureRoot, { force: true, recursive: true });
});

/**
 * Write a map of relative path to content under `root`, creating each file's directory as it goes. An empty map still creates `root` itself, which is what lets a
 * row stage a directory with nothing in it.
 *
 * @param root  - The directory the tree is written under.
 * @param files - The tree, as a map of path relative to `root` to file content.
 */
async function writeTree(root, files) {

  await mkdir(root, { recursive: true });

  await Promise.all(Object.entries(files).map(async ([ path, content ]) => {

    const target = join(root, path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }));
}

/**
 * Write a fixture repository: a published docs/ tree carrying a page at its root, a page in a subdirectory, the hand-authored files the prune preserves, and one
 * file of another kind, plus whatever the row stages. Each file's content says what it is, so a row reading a page back tells a promoted page from the one it
 * replaced without a second table of expected bytes.
 *
 * @param args
 * @param args.name      - The name of this row's repository directory under the suite's fixture root.
 * @param args.published - Published pages beyond the baseline, as a map of path relative to docs/ to content.
 * @param args.staged    - The staged pages, as a map of path relative to the staging directory to content. An empty map stages a directory holding nothing, while
 *                         omitting the field leaves the staging directory absent altogether.
 *
 * @returns The absolute path to the fixture repository, the working directory a run is given.
 */
async function makeFixture({ name, published = {}, staged }) {

  const root = join(fixtureRoot, name);

  await writeTree(join(root, "docs"), { "Changelog.md": "hand-authored changelog.\n", "Overview.md": "hand-authored overview.\n",
    "README.md": "the published index page.\n", "logo.svg": "<svg>a file of another kind</svg>\n", "sub/Page.md": "the published sub page.\n", ...published });

  if(staged !== undefined) {

    await writeTree(join(root, ".docs-staging"), staged);
  }

  return root;
}

/**
 * Read every file under a tree into a map of POSIX-relative path to content. Files of every kind take part, not only the markdown pages, because "touches nothing"
 * is a claim about the whole tree.
 *
 * @param root - The directory to read.
 *
 * @returns The tree's contents, keyed by path relative to `root`.
 */
async function snapshotTree(root) {

  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  const contents = await Promise.all(files.map((path) => readFile(path, "utf8")));

  return new Map(files.map((path, index) => [ relative(root, path).split(sep).join("/"), contents[index] ]));
}

/**
 * Run one of the script's verbs with a fixture repository as its working directory. A non-zero exit is an outcome the refusal tests below assert on rather than a
 * failure of the run itself, so the callback's error is read for its exit status instead of being rethrown.
 *
 * @param cwd  - The fixture repository the run resolves its own paths against.
 * @param verb - The subcommand to run.
 *
 * @returns The run's exit code and its captured stderr.
 */
function runVerb(cwd, verb) {

  return new Promise((resolve) => {

    execFile(process.execPath, [ SCRIPT, verb ], { cwd }, (error, _stdout, stderr) => {

      resolve({ code: (error === null) ? 0 : error.code, stderr });
    });
  });
}

/**
 * Write a fixture package: a git repository carrying a manifest, an ignore file allowlisting what a package ships, a git ignore rule for the compiled tree, one
 * tracked source under each of two roots, and whatever else the row plants. Files listed as tracked are staged, which is all `git ls-files` reads; nothing is
 * committed, so the fixture needs no identity of its own.
 *
 * @param args
 * @param args.exclude   - Whether the ignore file carries the test-only exclusion lines the real one carries. A row exercising the shipped-shape check leaves them
 *                         out, since a file the ignore file excludes never reaches the pack listing the check reads.
 * @param args.init      - Whether to make the directory a git repository at all. The row that asks what happens without one leaves it out.
 * @param args.name      - The name of this row's repository directory under the suite's fixture root.
 * @param args.tracked   - Files to write and stage, as a map of path relative to the repository to content.
 * @param args.untracked - Files to write and leave unstaged, in the same shape.
 *
 * @returns The absolute path to the fixture repository, the working directory a run is given.
 */
async function makeAuditFixture({ exclude = true, init = true, name, tracked = {}, untracked = {} }) {

  const root = join(fixtureRoot, name);
  const manifest = JSON.stringify({ name: "audit-fixture", version: "1.0.0" }) + "\n";
  const allowlist = "*\n!build/**\n!dist/**\n!package.json\n";
  const npmignore = allowlist + (exclude ? "build/**/*.test.mjs\nbuild/**/test-*.mjs\n" : "");
  const baseline = { ".gitignore": "dist\n", ".npmignore": npmignore, "build/tool.mjs": "export const tool = 1;\n", "package.json": manifest,
    "src/index.ts": "export const index = 1;\n", "ui/panel.mjs": "export const panel = 1;\n", ...tracked };
  const run = promisify(execFile);

  /* The order here is the whole of what makes an untracked row untracked, and it is easy to get backwards: the tracked set is written, staged, and committed
   * FIRST, and only then are the untracked and ignored files planted. Planting first and staging after would sweep them into the index - `git add build` adds
   * whatever is under that directory at the moment it runs, the file the row means to leave alone included - and every row that expects a refusal would pass for
   * the wrong reason. For the same reason the index is given explicit file paths and never a directory.
   */
  await writeTree(root, baseline);

  if(init) {

    await run("git", [ "init", "-q" ], { cwd: root });
    await run("git", [ "add", "--", ...Object.keys(baseline) ], { cwd: root });
    await run("git", [ "-c", "commit.gpgsign=false", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture",
      "commit", "-q", "-m", "fixture baseline" ], { cwd: root });
  }

  await writeTree(root, untracked);

  return root;
}

/**
 * Assert what git makes of a planted path before a row runs the verb on it. A row that means to plant something untracked has to know it actually is: were the
 * fixture ever to stage it by accident, every assertion after this would pass for the wrong reason and the row would stop testing anything.
 *
 * @param root   - The fixture repository.
 * @param path   - The planted path, relative to that repository.
 * @param status - The porcelain code expected, or `null` to assert git says nothing at all about the path, which is what an ignored file reads as.
 */
async function assertPlanted(root, path, status) {

  const { stdout } = await promisify(execFile)("git", [ "status", "--porcelain", "--", path ], { cwd: root });

  assert.equal(stdout.trim(), (status === null) ? "" : (status + " " + path), "the fixture must leave " + path + " in the state this row depends on");
}

describe("fs-ops publish-docs", () => {

  test("promotes every staged page and replaces an existing one", async () => {

    const root = await makeFixture({ name: "promote", staged: {

      "README.md": "the generated index page.\n",
      "fresh/Module.md": "a page in a directory the published tree does not carry yet.\n",
      "sub/Page.md": "the published sub page.\n"
    } });

    const { code, stderr } = await runVerb(root, "publish-docs");

    assert.equal(code, 0, "a staged run must publish; stderr: " + stderr);
    assert.equal(await readFile(join(root, "docs", "README.md"), "utf8"), "the generated index page.\n", "an existing page must end up carrying the staged bytes");
    assert.equal(await readFile(join(root, "docs", "fresh", "Module.md"), "utf8"), "a page in a directory the published tree does not carry yet.\n",
      "a staged page must land in a directory the published tree gains for it");
    await assert.rejects(stat(join(root, ".docs-staging")), { code: "ENOENT" }, "the staging directory must be gone once its pages are published");
  });

  test("prunes a generated page the run did not produce, in the root and in a subdirectory", async () => {

    const root = await makeFixture({ name: "prune",
      published: { "sub/zzz-stale.md": "a page whose module is gone.\n", "zzz-stale.md": "a page whose module is gone.\n" },
      staged: { "README.md": "the published index page.\n", "sub/Page.md": "the published sub page.\n" } });

    const initial = await snapshotTree(join(root, "docs"));
    const { code, stderr } = await runVerb(root, "publish-docs");

    assert.equal(code, 0, "a staged run must publish; stderr: " + stderr);

    const remaining = await snapshotTree(join(root, "docs"));

    assert.deepEqual([...remaining.keys()].toSorted(), [ "Changelog.md", "Overview.md", "README.md", "logo.svg", "sub/Page.md" ],
      "a generated page the run did not produce must be pruned at every depth, and nothing else may be");

    for(const kept of [ "Changelog.md", "Overview.md", "logo.svg" ]) {

      assert.equal(remaining.get(kept), initial.get(kept), kept + " must be byte-identical to what the run found");
    }
  });

  test("refuses an empty staging directory and touches nothing", async () => {

    const root = await makeFixture({ name: "empty", staged: {} });
    const initial = await snapshotTree(join(root, "docs"));
    const { code, stderr } = await runVerb(root, "publish-docs");

    assert.equal(code, 1, "a staging directory holding no page must be refused, since a prune against it would delete every published page");
    assert.equal(stderr, NOTHING_STAGED, "the refusal must name the step the caller skipped");
    assert.deepEqual(await snapshotTree(join(root, "docs")), initial, "a refused run must leave every published page as it found it");
    assert.ok((await stat(join(root, ".docs-staging"))).isDirectory(), "a refused run must not remove the staging directory either");
  });

  test("refuses a missing staging directory and touches nothing", async () => {

    const root = await makeFixture({ name: "missing" });
    const initial = await snapshotTree(join(root, "docs"));
    const { code, stderr } = await runVerb(root, "publish-docs");

    assert.equal(code, 1, "an absent staging directory must be refused for the same reason an empty one is");
    assert.equal(stderr, NOTHING_STAGED, "the refusal must name the step the caller skipped");
    assert.deepEqual(await snapshotTree(join(root, "docs")), initial, "a refused run must leave every published page as it found it");
  });
});

describe("fs-ops audit-package", () => {

  test("a built package whose every file traces to a tracked source passes silently", async () => {

    /* The shape every continuous-integration run and every publish actually meets, and the one that must never fail: the build has run, so a compiled tree sits
     * beside the sources, git is told to ignore it, and the package ships it. Each compiled path has to be traced back to the source it came from and that source
     * found in the index. A check that asked git which files it does not track would pass this too, and would pass the next three rows as well.
     */
    const root = await makeAuditFixture({ name: "audit-built",
      tracked: { "src/a.ts": "export const a = 1;\n", "ui/b.mjs": "export const b = 1;\n" },
      untracked: { "dist/a.js": "export const a = 1;\n", "dist/ui/b.mjs": "export const b = 1;\n" } });
    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 0, "a package built from tracked sources must pass; stderr: " + stderr);
    assert.equal(stderr, "", "and it must do so silently, like every other verb here");
  });

  test("a compiled module whose TypeScript source git does not track is refused, naming both paths", async () => {

    // The leak the tracing exists for: with an ignore file present npm never reads the git ignore rules, so a module git was told to forget still compiles into the
    // package. The refusal names the packaged path and the source it traces to, because the packaged path alone would not say what to fix.
    const root = await makeAuditFixture({ name: "audit-untracked-src", untracked: { "dist/c.js": "export const c = 1;\n", "src/c.ts": "export const c = 1;\n" } });

    // The precondition the row rests on: the source really is untracked, and the compiled file really is ignored, exactly as a real build output is.
    await assertPlanted(root, "src/c.ts", "??");
    await assertPlanted(root, "dist/c.js", null);

    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "a packaged file whose source is untracked must fail the audit");
    assert.ok(stderr.includes("dist/c.js"), "the refusal must name the packaged path");
    assert.ok(stderr.includes("src/c.ts"), "and the source it traces to, which is the file that needs committing");
  });

  test("a copied webUI module whose source git does not track is refused", async () => {

    const root = await makeAuditFixture({ name: "audit-untracked-ui",
      untracked: { "dist/ui/d.mjs": "export const d = 1;\n", "ui/d.mjs": "export const d = 1;\n" } });

    await assertPlanted(root, "ui/d.mjs", "??");

    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "the copy step ships what it finds, so an untracked source reaches the package through it too");
    assert.ok(stderr.includes("dist/ui/d.mjs"), "the refusal must name the packaged path");
    assert.ok(stderr.includes("ui/d.mjs"), "and the source it was copied from");
  });

  test("an untracked file under a directory the allowlist ships verbatim is refused", async () => {

    // No build step is involved here at all: the allowlist admits the directory, so the file is its own source and the question is asked of it directly.
    const root = await makeAuditFixture({ name: "audit-untracked-build", untracked: { "build/e.mjs": "export const e = 1;\n" } });

    await assertPlanted(root, "build/e.mjs", "??");

    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "a file that ships as itself must be tracked as itself");
    assert.ok(stderr.includes("build/e.mjs"), "the refusal must name the path");
  });

  test("a compiled path no build route explains is refused as unexplained", async () => {

    /* Fail-closed, and this row is what encodes it: a path under the compiled tree that the route table does not recognize is refused rather than waved through,
     * so a build that grows a route the table does not know stops the publish until the table learns it.
     */
    const root = await makeAuditFixture({ name: "audit-unexplained", untracked: { "dist/f.txt": "not something any route produces\n" } });

    // This row's subject is ignored rather than untracked, which is the point: git says nothing about it, and the refusal comes from the trace alone.
    await assertPlanted(root, "dist/f.txt", null);

    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "a compiled path no route explains must fail rather than pass");
    assert.ok(stderr.includes("dist/f.txt"), "the refusal must name the path");
    assert.ok(stderr.includes("no build route explains"), "and say what is wrong with it, which is different from an untracked source");
  });

  test("a tracked test file that would ship is refused", async () => {

    // The ignore file's exclusions are left out here on purpose: a file it excludes never reaches the pack listing, so this row would have nothing to check. The
    // exclusions and this check are belt and braces, and this row is the brace - what notices if the ignore file ever stops doing its half.
    const root = await makeAuditFixture({ exclude: false, name: "audit-test-file", tracked: { "build/g.test.mjs": "export const suite = 1;\n" } });
    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "a test file reaches the package through the allowlist whether or not git tracks it");
    assert.ok(stderr.includes("build/g.test.mjs"), "the refusal must name the path");
  });

  test("a tracked test-infrastructure file that would ship is refused", async () => {

    // The other arm of the shared rule: a name beginning "test-" is infrastructure rather than a suite, and it ships by the same route a suite does.
    const root = await makeAuditFixture({ exclude: false, name: "audit-test-prefix", tracked: { "build/test-h.mjs": "export const harness = 1;\n" } });
    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "a test-infrastructure file ships exactly as a suite file does, and is refused the same way");
    assert.ok(stderr.includes("build/test-h.mjs"), "the refusal must name the path");
  });

  test("a directory that is no git checkout is refused with a sentence, not a stack trace", async () => {

    /* The audit runs at the tail of a publish, where an uncaught rejection's stack would bury the one sentence a reader needs. This fixture is a real package
     * directory with no repository behind it, so the tracked-file reading is the half that cannot answer, and the refusal has to say so by name.
     */
    const root = await makeAuditFixture({ init: false, name: "audit-no-repository" });
    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "a reading that cannot be taken is a refusal, not a crash");
    assert.ok(stderr.includes("git"), "the refusal must name the tool that could not answer");
    assert.ok(!stderr.includes("at "), "and must be the file's own sentence rather than a stack trace");
  });

  test("a file under a filled subtree whose shape that subtree has no route for is refused as unexplained", async () => {

    /* The subtree that claims a path owns it outright. The lint plugin's output directory carries declarations and nothing else, so a runtime file appearing
     * there is a path the table does not explain - and the refusal has to SAY that, because the alternative failure is silent and plausible: were the lookup
     * allowed to fall through to the compiled root's routes, this path would resolve to `src/eslint-plugin/probe.ts`, a file nobody ever wrote, and the refusal
     * would send a reader to commit it. The exit code is 1 either way, so the message is the whole of what this row tells the two cases apart by.
     */
    const root = await makeAuditFixture({ name: "audit-subtree-shape",
      untracked: { "dist/eslint-plugin/probe.js": "export const probe = 1;\n" } });

    await assertPlanted(root, "dist/eslint-plugin/probe.js", null);

    const { code, stderr } = await runVerb(root, "audit-package");

    assert.equal(code, 1, "a shape the claiming subtree has no route for must fail");
    assert.ok(stderr.includes("dist/eslint-plugin/probe.js"), "the refusal must name the packaged path");
    assert.ok(stderr.includes("no build route explains"), "and must say the table does not explain it, rather than naming a source nobody wrote");
    assert.ok(!stderr.includes("src/eslint-plugin"), "a fallthrough to the compiled root's routes would invent exactly this source");
  });
});

describe("fs-ops build paths", () => {

  test("the shared path constants agree with the TypeScript projects that also declare them", async () => {

    /* The audit traces a compiled path back to its source through directory constants rather than by parsing a TypeScript project file at run time, so two copies
     * of the same two pairs exist: the compiler's, and the build's. This row is what holds them together - change `rootDir` or `outDir` in either project and the
     * suite goes red until the shared constants follow, which is the whole reason it is safe not to parse them at run time.
     *
     * Both project files open with a block comment, so they are read through a strip rather than handed to `JSON.parse` directly. Neither carries a line comment
     * in its body, confirmed when this row was written, which is why stripping block comments alone is enough.
     */
    const read = async (file) => JSON.parse((await readFile(new URL(file, PROJECT_ROOT), "utf8")).replace(/\/\*[\s\S]*?\*\//g, ""));
    const library = await read("tsconfig.build.json");
    const plugin = await read("tsconfig.eslint-plugin.json");

    assert.equal(library.compilerOptions.rootDir, SRC_ROOT, "tsconfig.build.json's rootDir is what SRC_ROOT restates");
    assert.equal(library.compilerOptions.outDir, DIST_ROOT, "tsconfig.build.json's outDir is what DIST_ROOT restates");
    assert.equal(plugin.compilerOptions.rootDir, PLUGIN_SOURCE, "tsconfig.eslint-plugin.json's rootDir is what PLUGIN_SOURCE restates");
    assert.equal(plugin.compilerOptions.outDir, PLUGIN_OUTPUT, "tsconfig.eslint-plugin.json's outDir is what PLUGIN_OUTPUT restates");
  });
});
