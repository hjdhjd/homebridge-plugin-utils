/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fs-ops.test.mjs: Unit tests for the build script's `publish-docs` verb - the promotion of a staged TypeDoc run into docs/, the prune of the generated pages a run
 * did not produce, and the refusal that keeps an unstaged run from sweeping the published tree. Every path the script names is relative to its working directory, so
 * each row writes a fixture repository under a tmpdir and runs the real script as a subprocess with that fixture as its working directory - the same invocation the
 * `build-docs` script makes, exit code and stderr included. Nothing here touches this repository's own docs.
 */
import { after, describe, test } from "node:test";
import { dirname, join, relative, sep } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// The script under test, resolved from this file's own location so the suite runs correctly from any working directory.
const SCRIPT = fileURLToPath(new URL("./fs-ops.mjs", import.meta.url));

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
 * Write a fixture repository: a published docs/ tree carrying a page at its root, a page in a subdirectory, the two hand-authored files the prune preserves, and one
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
 * Run the script's `publish-docs` verb with a fixture repository as its working directory. A non-zero exit is an outcome two of the rows below assert on rather
 * than a failure of the run itself, so the callback's error is read for its exit status instead of being rethrown.
 *
 * @param cwd - The fixture repository the run resolves docs/ and the staging directory against.
 *
 * @returns The run's exit code and its captured stderr.
 */
function runPublish(cwd) {

  return new Promise((resolve) => {

    execFile(process.execPath, [ SCRIPT, "publish-docs" ], { cwd }, (error, _stdout, stderr) => {

      resolve({ code: (error === null) ? 0 : error.code, stderr });
    });
  });
}

describe("fs-ops publish-docs", () => {

  test("promotes every staged page and replaces an existing one", async () => {

    const root = await makeFixture({ name: "promote", staged: {

      "README.md": "the generated index page.\n",
      "fresh/Module.md": "a page in a directory the published tree does not carry yet.\n",
      "sub/Page.md": "the published sub page.\n"
    } });

    const { code, stderr } = await runPublish(root);

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
    const { code, stderr } = await runPublish(root);

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
    const { code, stderr } = await runPublish(root);

    assert.equal(code, 1, "a staging directory holding no page must be refused, since a prune against it would delete every published page");
    assert.equal(stderr, NOTHING_STAGED, "the refusal must name the step the caller skipped");
    assert.deepEqual(await snapshotTree(join(root, "docs")), initial, "a refused run must leave every published page as it found it");
    assert.ok((await stat(join(root, ".docs-staging"))).isDirectory(), "a refused run must not remove the staging directory either");
  });

  test("refuses a missing staging directory and touches nothing", async () => {

    const root = await makeFixture({ name: "missing" });
    const initial = await snapshotTree(join(root, "docs"));
    const { code, stderr } = await runPublish(root);

    assert.equal(code, 1, "an absent staging directory must be refused for the same reason an empty one is");
    assert.equal(stderr, NOTHING_STAGED, "the refusal must name the step the caller skipped");
    assert.deepEqual(await snapshotTree(join(root, "docs")), initial, "a refused run must leave every published page as it found it");
  });
});
