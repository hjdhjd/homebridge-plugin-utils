#!/usr/bin/env node
/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fs-ops.mjs: Native node:fs/promises filesystem operations for HBPU's build and test scripts (rm, cp, mkdir). Node 22+ provides recursive flags natively, so no
 * shell-portability shim is needed for the handful of operations we use.
 *
 * Subcommands:
 *
 *   audit-package          refuse a package that would carry a file git does not track under a source root the package ships, or a test file of any shape.
 *   build-ui               mkdir dist/ui and copy shippable ui/*.mjs (excluding test-only files) into it (invoked by the `build-ui` npm script).
 *   clean <paths...>       rm -rf each path, silently ignoring missing entries; errors if no paths are supplied (invoked by `clean`).
 *   finalize               ready the emitted dist/ for shipping and local consumption: copy the browser-runtime modules into dist/ui and mark every declared bin
 *                          entry executable, after tsc emits them (invoked at the tail of `build`).
 *   publish-docs           promote the staged TypeDoc output into docs/ page by page, prune every generated page the run did not produce, and remove the staging
 *                          directory (invoked by `build-docs` after typedoc).
 */
import { DIST_ROOT, PLUGIN_OUTPUT, PLUGIN_SOURCE, SRC_ROOT, UI_OUTPUT, UI_SOURCE } from "./build-paths.mjs";
import { basename, dirname, join, relative, sep } from "node:path";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { BROWSER_MODULES } from "./browser-modules.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

// The name segments that mark a file as test-only: a suite, its shared data, and its shared code. A segment rather than a whole suffix, so one rule answers for
// every script extension the family writes rather than one entry per extension crossed with per segment.
const TEST_ONLY_SEGMENTS = [ ".fixtures", ".helpers", ".test" ];

// The script extensions a test-only name can end in, longest first so a four-character extension is matched before the three-character one it ends with: ".cts"
// and ".mts" both end in ".ts", and matching the shorter one would leave a stray character on the stem and miss the segment behind it.
const SCRIPT_EXTENSIONS = [ ".cjs", ".cts", ".mjs", ".mts", ".js", ".ts" ];

/* Answer whether a file name is test-only: the build copies none of these into dist/ui, and the package ships none of them at all.
 *
 * Two shapes count. A name beginning "test-" is test infrastructure rather than a suite - the module-resolution loader and the lint plugin's own harness are the
 * two the tree carries - and a name whose stem ends in one of the test-only segments is a suite or the data and code a suite shares. The stem is what is read
 * rather than the whole name, so the rule holds for every script extension rather than for the one extension a given caller happens to meet.
 *
 * @param name - A file's base name, without its directory.
 *
 * @returns `true` when the name is test-only.
 */
function isTestOnlyName(name) {

  if(name.startsWith("test-")) {

    return true;
  }

  const extension = SCRIPT_EXTENSIONS.find((candidate) => name.endsWith(candidate));

  if(extension === undefined) {

    return false;
  }

  const stem = name.slice(0, -extension.length);

  return TEST_ONLY_SEGMENTS.some((segment) => stem.endsWith(segment));
}

// Ensure dist/ui exists and copy the browser-side UI assets into it. Runs during the clean and build-ui phases, before tsc emits the compiled browser modules,
// so the directory has to exist up front and the browser-modules copy step runs separately after tsc. We filter to shippable artifacts by excluding the
// test-only file shapes, which `isTestOnlyName` decides for this step and for the package audit alike. The resulting dist/ui/ contains only the browser runtime
// files consumers execute.
//
// The copy is recursive so the directory structure under `ui/` (the `webUi-featureOptions/`, `webUi-featureOptions/effects/`, `webUi-featureOptions/views/`
// subdirectories) is preserved as-is in `dist/ui/`. The filter is consulted per-entry: directories always pass through (returning `true` lets `cp` walk into them);
// files are kept only when they match the shippable shape.
async function buildUi() {

  await mkdir(UI_OUTPUT, { recursive: true });

  await cp(UI_SOURCE, UI_OUTPUT, {

    filter: async (src) => {

      const s = await stat(src);

      if(s.isDirectory()) {

        return true;
      }

      const name = basename(src);

      // Only the browser runtime ships, so the extension is asked first and the shared rule answers the rest.
      return name.endsWith(".mjs") && !isTestOnlyName(name);
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

    cp(join(DIST_ROOT, name + ".js"), join(UI_OUTPUT, name + ".js")),
    cp(join(DIST_ROOT, name + ".js.map"), join(UI_OUTPUT, name + ".js.map"))
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

/* Which output extensions one input extension produces. This is the only part of the tracing the audit owns outright, because it is the only part the build does
 * not state somewhere else: `declaration`, `declarationMap`, and `sourceMap` in the shared base decide that one module answers for a runtime file, a declaration,
 * and a source map, and the module family its extension puts it in decides what those three are called. The `.d.ts.map` a module also emits is absent because the
 * ignore file excludes it from the package, so it is never a path this traces.
 */
const TSC_OUTPUT_SUFFIXES = {

  ".cts": [ ".cjs", ".cjs.map", ".d.cts" ],
  ".mts": [ ".d.mts", ".mjs", ".mjs.map" ],
  ".ts": [ ".d.ts", ".js", ".js.map" ]
};

/* How a packaged path traces back to the file it came from. A path outside the compiled tree is its own source; a path inside it is something the build produced,
 * and each route below is one statement about what the build actually does, in the order they are tried: the filled subtrees first, since they are written by
 * steps of their own and would otherwise read as ordinary compiler output one directory deeper.
 *
 * Every directory and every roster here is read from where the build declares it - the shared path constants, and `BROWSER_MODULES` itself for the one route that
 * needs to know which modules the browser copy carries - so the table cannot drift from the build by restating something the build already says. What it adds is
 * only the direction: the build maps a source to an output, and this maps an output back to its source.
 *
 * A subtree owns every path beneath it, which is what the grouping below is for. Once a path is under a directory some step fills, only that step's routes may
 * answer for it, and a shape none of them names is a path this table does not explain - never something a broader route downstream is allowed to guess at. Both
 * filled subtrees need that: a file under the webUI output that is not a browser module, and a file under the lint plugin's output that is not a declaration,
 * would each otherwise resolve to a plausible-looking TypeScript source one or two directories down that nobody ever wrote.
 */
const DIST_SOURCE_ROUTES = [

  { prefix: UI_OUTPUT + "/", routes: [

    { source: (stem) => UI_SOURCE + "/" + stem + ".mjs", suffixes: [".mjs"] },
    { source: (stem) => (BROWSER_MODULES.includes(stem) ? (SRC_ROOT + "/" + stem + ".ts") : null), suffixes: [ ".js", ".js.map" ] }
  ] },
  { prefix: PLUGIN_OUTPUT + "/", routes: [{ source: (stem) => PLUGIN_SOURCE + "/" + stem + ".mjs", suffixes: [".d.mts"] }] },
  { prefix: DIST_ROOT + "/", routes: Object.entries(TSC_OUTPUT_SUFFIXES).map(([ extension, suffixes ]) => ({

    source: (stem) => SRC_ROOT + "/" + stem + extension, suffixes })) }
];

// Run a child process and answer its captured output. The readings below are the file's only child processes, and every one of them is read-only.
const run = promisify(execFile);

/* Name the file a packaged path came from, or `null` when nothing here explains it. A path outside the compiled tree is its own source, since nothing built it.
 *
 * @param path - A path as the pack listing spells it, relative to the package root.
 *
 * @returns The source path, or `null` for a path no route explains.
 */
function packagedSource(path) {

  if(!path.startsWith(DIST_ROOT + "/")) {

    return path;
  }

  /* The first subtree whose prefix claims the path owns it outright, and the table's last entry is the compiled root itself, so a path already known to be under
   * that root always finds one. What it does not always find is a route for its own shape, and that is the case worth being strict about: a file under a filled
   * subtree whose suffix none of that subtree's routes names is a path this table does not explain, so it answers nothing rather than falling through to a
   * broader route that would happily name a source nobody wrote.
   */
  const subtree = DIST_SOURCE_ROUTES.find((candidate) => path.startsWith(candidate.prefix));

  for(const route of subtree.routes) {

    const suffix = route.suffixes.find((candidate) => path.endsWith(candidate));

    if(suffix !== undefined) {

      return route.source(path.slice(subtree.prefix.length, -suffix.length));
    }
  }

  return null;
}

/* Take one of the audit's two readings under a single guard, refusing rather than unwinding when anything about it goes wrong. Spawning the tool, parsing what it
 * wrote, and reaching into the shape it was expected to have all happen inside `read`, so all three share one failure path and one sentence: there is no second,
 * separately reachable branch for a malformed answer that no test would ever reach. Both readings are read-only, and both need something the environment supplies
 * rather than something this file controls - a tool on the path, and a git checkout to be standing in - which is what the named subject reports.
 *
 * Each reading gives the child process its working directory explicitly, and both give the same one, because each resolves its subject from where the process
 * stands rather than from anything passed to it: `npm pack` finds the nearest package.json from the current directory and ignores `--prefix` for the purpose
 * entirely, and git resolves its repository the same way. Naming the directory at both call sites is what keeps them from ever reading different trees, and it
 * is the reason no caller should reach for a flag instead.
 *
 * @param subject - What the reading is, named in the refusal so a reader learns which one failed and which tool owed the answer.
 * @param read    - Takes the reading: spawns, parses, and shapes it.
 *
 * @returns Whatever `read` answered with.
 */
async function readOrRefuse(subject, read) {

  try {

    return await read();
  } catch {

    process.stderr.write("Unable to audit the package: could not read " + subject + ".\n");
    process.exit(1);
  }
}

/* Refuse a package that would carry a file whose source git does not track, or a test-only file of any shape.
 *
 * The pack listing is the subject, because it is the file set npm would actually upload - ignore rules and allowlist already applied - rather than a second model
 * of them, and every one of its paths is traced back to the file it came from and that source required to be tracked. Asking git which files it does not track
 * would answer a different and weaker question: with an ignore file present npm never reads the git ignore rules at all, so a gitignored module under the source
 * root still compiles into the output and ships, a gitignored file under the webUI root is still copied and ships, and anything gitignored under a directory the
 * allowlist admits ships verbatim. Tracing what ships catches all of those; asking git for untracked files catches none of them, and asking it for ignored files
 * instead would refuse a publish over a stray editor artifact npm was never going to pack.
 *
 * A path no route explains fails the audit rather than passing. That is deliberate and it is the whole reason the table is worth having: a build that grows a new
 * route refuses to publish until the table is taught about it, which is the safe direction for a check whose job is to say what is in the package.
 *
 * A reading that cannot be taken is a refusal too, not a crash. The audit runs at the tail of a publish, where an uncaught rejection's stack trace would bury the
 * one sentence a reader needs, so a missing tool, a directory that is no checkout, and output that does not parse or does not carry the shape this expects all
 * end in the same purpose-built refusal every other verb in this file uses. Each reading is spawned, parsed, and shaped inside ONE guarded step that names it,
 * so there is no separately reachable failure branch to leave untested: whatever goes wrong with a reading, the same sentence reports it and the same test row
 * exercises the path. It can only happen in a broken environment - the build runs from a checkout everywhere it runs, and the manifest declares no `prepare` and
 * no `postinstall`, so nothing runs a build from an installed package - but "it should not happen" is not a reason to answer it badly.
 */
async function auditPackage() {

  const shipped = await readOrRefuse("the package listing from npm", async () => {

    const { stdout } = await run("npm", [ "pack", "--dry-run", "--ignore-scripts", "--json" ], { cwd: process.cwd() });

    return JSON.parse(stdout)[0].files.map((file) => file.path);
  });

  const tracked = await readOrRefuse("the tracked-file listing from git", async () => {

    const { stdout } = await run("git", [ "ls-files", "-z" ], { cwd: process.cwd() });

    return new Set(stdout.split("\0").filter((path) => path.length > 0));
  });

  const strays = [];

  for(const path of shipped) {

    const source = packagedSource(path);

    if(source === null) {

      strays.push(path + " (no build route explains this path)");

      continue;
    }

    if(!tracked.has(source)) {

      strays.push((source === path) ? (path + " (git does not track it)") : (path + " (built from " + source + ", which git does not track)"));
    }
  }

  if(strays.length) {

    process.stderr.write("These files would ship without a tracked source: " + strays.join(", ") + ".\n");
    process.exit(1);
  }

  const tests = shipped.filter((path) => isTestOnlyName(basename(path)));

  if(tests.length) {

    process.stderr.write("These test-only files would ship in the package: " + tests.join(", ") + ".\n");
    process.exit(1);
  }
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

  case "audit-package": {

    await auditPackage();

    break;
  }

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

    process.stderr.write("Usage: fs-ops.mjs {audit-package | build-ui | clean <paths...> | finalize | publish-docs}\n");
    process.exit(1);
  }
}
