#!/usr/bin/env node
/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fs-ops.mjs: Native node:fs/promises filesystem operations for HBPU's build and test scripts (rm, cp, mkdir). Node 22+ provides recursive flags natively, so no
 * shell-portability shim is needed for the handful of operations we use.
 *
 * Subcommands:
 *
 *   build-ui               mkdir dist/ui and copy shippable ui/*.mjs (excluding test-only files) into it (invoked by the `build-ui` npm script).
 *   clean <paths...>       rm -rf each path, silently ignoring missing entries; errors if no paths are supplied (invoked by `clean`).
 *   finalize               ready the emitted dist/ for shipping and local consumption: copy the browser-runtime modules into dist/ui and mark every declared bin
 *                          entry executable, after tsc emits them (invoked at the tail of `build`).
 *   publish-docs           promote the staged TypeDoc output into docs/ page by page, prune every generated page the run did not produce, and remove the staging
 *                          directory (invoked by `build-docs` after typedoc).
 */
import { basename, dirname, join, relative, sep } from "node:path";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { BROWSER_MODULES } from "./browser-modules.mjs";

// The published documentation tree, where every generated page lands beside the hand-authored files the publish preserves.
const DOCS_ROOT = "docs";

// The directory TypeDoc generates into: an ignored build artifact that exists only between the generator's run and the publish that empties it.
const DOCS_STAGING = ".docs-staging";

// Hand-authored files at the root of docs/ that the prune never removes. Every other markdown page under docs/ is generated, so introducing another hand-authored
// page means adding its name to this set.
const PRESERVED_DOCS = new Set([ "Changelog.md", "Overview.md" ]);

// Recursively remove every path in the list. `rm` with `force: true` already silences ENOENT, so missing paths are a no-op, matching POSIX `rm -f` semantics.
async function clean(paths) {

  await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
}

// Ensure dist/ui exists and copy the browser-side UI assets into it. Runs during the clean and build-ui phases, before tsc emits the compiled featureOptions.js,
// so the directory has to exist up front and the featureOptions copy step runs separately after tsc. We filter to shippable artifacts by excluding the
// test-only file shapes: `*.test.mjs` (suite files), `*.fixtures.mjs` (shared test data), `*.helpers.mjs` (shared test code), and `test-*.mjs` (test infrastructure,
// currently the `registerHooks` module-resolution loader). Suffix matches are centralized in `TEST_ONLY_SUFFIXES` so adding a new test-file shape is a one-line edit
// rather than a chain of `&& !entry.endsWith(...)` clauses. The resulting dist/ui/ contains only the browser runtime files consumers execute.
//
// The copy is recursive so the directory structure under `ui/` (the `webUi-featureOptions/`, `webUi-featureOptions/effects/`, `webUi-featureOptions/views/`
// subdirectories) is preserved as-is in `dist/ui/`. The filter is consulted per-entry: directories always pass through (returning `true` lets `cp` walk into them);
// files are kept only when they match the shippable shape.
const TEST_ONLY_SUFFIXES = [ ".fixtures.mjs", ".helpers.mjs", ".test.mjs" ];

async function buildUi() {

  await mkdir("dist/ui", { recursive: true });

  await cp("ui", "dist/ui", {

    filter: async (src) => {

      const s = await stat(src);

      if(s.isDirectory()) {

        return true;
      }

      const name = basename(src);

      if(!name.endsWith(".mjs") || name.startsWith("test-")) {

        return false;
      }

      return !TEST_ONLY_SUFFIXES.some((suffix) => name.endsWith(suffix));
    },
    recursive: true
  });
}

// Copy the compiled browser-runnable modules into dist/ui so the browser-side webUI can resolve them as siblings of the orchestrator. Runs after tsc emits the
// compiled `dist/*.js` files. The set of modules is `BROWSER_MODULES`, the single source of truth for "what the browser bundle needs at runtime"; adding a new
// browser-side runtime dependency means adding its name to that list and keeping the artifact's own imports browser-safe.
//
// Each module ships paired with its `.js.map` so browser DevTools can map runtime errors back to the original `.ts` source. The `.d.ts` / `.d.ts.map` artifacts
// are TypeScript-only and stay in `dist/` for type consumers; the browser never loads them, so they have no place in `dist/ui/`.
async function copyBrowserModules() {

  await Promise.all(BROWSER_MODULES.flatMap((name) => [

    cp(join("dist", name + ".js"), join("dist/ui", name + ".js")),
    cp(join("dist", name + ".js.map"), join("dist/ui", name + ".js.map"))
  ]));
}

// Mark every executable declared in package.json's `bin` field as user-executable (0o755). tsc emits plain 0o644 files with no execute bit. For a registry install
// npm sets the bit on bin targets itself, but it does NOT chmod the live source file behind a `file:` symlinked dependency - so a plugin consuming HBPU locally
// gets a non-executable CLI entry and a "Permission denied" the moment it invokes the bin. Reading the path set straight from package.json keeps the `bin`
// declaration the single source of truth: the build chmods whatever `bin` points at, so introducing or relocating a bin entry needs no parallel edit here.
async function makeBinExecutable() {

  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const bin = manifest.bin;

  // npm permits `bin` as either a string (a single executable named after the package) or an object map of command-name to path. Normalize both shapes to a flat
  // list of paths so the chmod loop is agnostic to which form the manifest uses.
  const binPaths = (typeof bin === "string") ? [bin] : Object.values(bin ?? {});

  await Promise.all(binPaths.map((binPath) => chmod(binPath, 0o755)));
}

// Post-tsc finalization: ready the emitted dist/ for shipping and local consumption. Placing the browser-runtime modules alongside the webUI and marking the
// CLI bin executable are independent concerns, so they run concurrently. This is the single tail-of-build step the `build` script invokes after tsc.
async function finalize() {

  await Promise.all([ copyBrowserModules(), makeBinExecutable() ]);
}

/* Publish the staged TypeDoc output into docs/. The generator writes into DOCS_STAGING rather than the published tree, so docs/ carries a complete result right up
 * to this step: a generation that fails never reaches docs/, and there is no window in which the tree lacks a page. Each staged page is promoted by a single rename
 * onto its published path - the atomic replacement the CLI's chrome stamper uses for its own writes - so no page is ever half-written and a reader of docs/ sees
 * either the whole previous page or the whole new one.
 *
 * The prune that follows removes every generated page this run did not produce, at any depth, which is how a module that was renamed or deleted stops leaving a
 * stale page behind. Only a markdown page is ever a candidate: a file of any other kind is left alone, and the hand-authored names in PRESERVED_DOCS are skipped.
 * Should the process die between the promotion and the prune, what remains is a stale page beside correct ones, which the next run removes.
 */
async function publishDocs() {

  const staged = await listMarkdown(DOCS_STAGING);

  // Pruning against an empty staged set would delete every published page, so an absent or empty staging directory is a refusal rather than a sweep. It means the
  // generator has not run, which only the caller can put right.
  if(!staged.length) {

    process.stderr.write("Nothing to publish: run typedoc first so " + DOCS_STAGING + " holds the generated pages.\n");
    process.exit(1);
  }

  // Promote each staged page onto its published path. The target's directory is created first, since a run may write a subdirectory docs/ does not carry yet, and
  // the rename replaces an existing page in place.
  await Promise.all(staged.map(async (page) => {

    const target = join(DOCS_ROOT, page);

    await mkdir(dirname(target), { recursive: true });
    await rename(join(DOCS_STAGING, page), target);
  }));

  /* Prune what the generator did not produce. The staged set is the whole of what a run writes, so any other markdown page under docs/ is either hand-authored or
   * the residue of a module that no longer exists. Membership is tested against the path relative to docs/, which is what confines the preserved names to the root:
   * a "Changelog.md" nested in a subdirectory is a generated page like any other.
   */
  const published = new Set(staged);

  await Promise.all((await listMarkdown(DOCS_ROOT)).filter((page) => !published.has(page) && !PRESERVED_DOCS.has(page)).map((page) => rm(join(DOCS_ROOT, page))));

  // What is left of the staging directory is the empty scaffolding the promotion renamed the pages out of.
  await rm(DOCS_STAGING, { force: true, recursive: true });
}

/* List every markdown page beneath `root` at any depth, answering paths relative to it with POSIX separators so a staged path and a published path compare as the
 * same string on any platform. Both halves of the publish read the tree through this one walk: the staged set it promotes and the published set it prunes against.
 *
 * A missing directory answers an empty list rather than surfacing ENOENT, which is what lets the publish tell an absent staging directory apart from a real failure
 * and lets a tree carrying no docs/ yet publish into a fresh one.
 */
async function listMarkdown(root) {

  let entries;

  try {

    // Node's recursive readdir with `withFileTypes: true` walks the whole tree in one call, and `parentPath` recovers each entry's directory.
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch(error) {

    if((error instanceof Error) && ("code" in error) && (error.code === "ENOENT")) {

      return [];
    }

    throw error;
  }

  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

const [ command, ...args ] = process.argv.slice(2);

switch(command) {

  case "build-ui": {

    await buildUi();

    break;
  }

  case "clean": {

    if(!args.length) {

      process.stderr.write("Usage: fs-ops.mjs clean <paths...>\n");
      process.exit(1);
    }

    await clean(args);

    break;
  }

  case "finalize": {

    await finalize();

    break;
  }

  case "publish-docs": {

    await publishDocs();

    break;
  }

  default: {

    process.stderr.write("Usage: fs-ops.mjs {build-ui | clean <paths...> | finalize | publish-docs}\n");
    process.exit(1);
  }
}
