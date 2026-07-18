/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * cli/index.test.ts: Unit tests for the CLI module, covering the pure {@link prepareUi} transform (content-hashed mirror semantics, manifest shape, stale-build
 * cleanup, preservation of non-version entries, source-side validation), the pure {@link prepareDocs} transform (catalog validation, scope-hook forwarding,
 * atomic-write marker splicing), the pure {@link prepareChrome} transform (multi-region stamping across the README, docs, and webUI, external project-source
 * resolution, and all-or-nothing writes), the {@link runCli} dispatcher (argument routing, exit codes, usage banner), and the entry-point execution invoked through
 * a symlink (the real bin invocation path that a direct-path test never exercises). Every surface but the last runs against AsyncDisposable tmpdir
 * scratch roots and `process.stderr` capture helpers; the entry-point test alone spawns the CLI as a subprocess through a symlink. No test touches a real install
 * or modifies the working tree.
 */
import * as docChrome from "../docChrome.ts";
import * as webuiLoader from "../webui-loader.ts";
import { FEATURE_OPTIONS_DOC_BEGIN, FEATURE_OPTIONS_DOC_END, renderFeatureOptionsReference, spliceMarkedRegion } from "../featureOptions-docs.ts";
import { USAGE, prepareChrome, prepareDocs, prepareUi, runCli } from "./index.ts";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Allocate a per-test tmpdir scratch root and return an AsyncDisposable handle that removes it on scope exit. The `await using` idiom at the call site guarantees
 * cleanup even when the test body throws, replacing the closure-variable + beforeEach/afterEach shape with per-test resource management that aligns with the rest
 * of HBPU's AsyncDisposable discipline (RtpDemuxer, MqttClient, holdPort, etc.).
 *
 * @returns An AsyncDisposable carrying the tmpdir path.
 */
async function makeScratchRoot(): Promise<AsyncDisposable & { path: string }> {

  const path = await mkdtemp(join(tmpdir(), "hbpu-cli-"));

  return {

    path,
    async [Symbol.asyncDispose](): Promise<void> {

      await rm(path, { force: true, recursive: true });
    }
  };
}

/**
 * Populate a tmpdir as a synthetic HBPU source root. Writes a minimal `package.json` and a `dist/ui` tree containing the files the caller names. Each file's
 * content is its own name (so tests can detect mis-copied files by reading them back), which keeps the fixture trivially debuggable without a parallel
 * "expected content" structure the test would otherwise need to maintain.
 *
 * @param args
 * @param args.files   - File paths relative to `dist/ui`. Each path is created with content equal to the path string.
 * @param args.root    - The tmpdir directory to populate as the source root.
 * @param args.version - The version string to write into `package.json`.
 */
async function setupSource({ files, root, version }: { files: readonly string[]; root: string; version: string }): Promise<void> {

  await writeFile(join(root, "package.json"), JSON.stringify({ name: "homebridge-plugin-utils", version }, null, 2));

  await Promise.all(files.map(async (relative) => {

    const absolute = join(root, "dist", "ui", relative);

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, relative);
  }));
}

/**
 * Write the two compiled dist modules the `prepare-ui` dispatch reaches through computed dynamic imports for its loader stamp: `dist/webui-loader.js` and
 * `dist/featureOptions-docs.js`, each a thin re-export of the real source through a `file:` URL. This mirrors how the `prepare-docs` dispatch tests supply their
 * renderer, so a `runCli` (or subprocess) `prepare-ui` invocation exercises the genuine dynamic-import path rather than a mock, and hard-fails the same way when these
 * are absent.
 *
 * @param root - The synthetic HBPU source root whose `dist/` receives the two re-export modules.
 */
async function writeLoaderDist(root: string): Promise<void> {

  const realLoader = fileURLToPath(new URL("../webui-loader.ts", import.meta.url));
  const realDocs = fileURLToPath(new URL("../featureOptions-docs.ts", import.meta.url));

  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "webui-loader.js"), "export * from " + JSON.stringify(pathToFileURL(realLoader).href) + ";\n");
  await writeFile(join(root, "dist", "featureOptions-docs.js"), "export { renderFeatureOptionsReference, spliceMarkedRegion } from " +
    JSON.stringify(pathToFileURL(realDocs).href) + ";\n");
}

/**
 * Capture writes to a stream-like sink. Returned `stderr` matches the shape {@link runCli} consumes; `chunks` joins the accumulated writes for a final
 * comparison. Per-test instances eliminate cross-test contamination without needing a beforeEach hook.
 *
 * @returns A `{ chunks, stderr }` pair where `chunks()` returns the concatenated captured output and `stderr` is the sink to pass to {@link runCli}.
 */
function captureStderr(): { chunks: () => string; stderr: { write: (chunk: string) => boolean } } {

  const captured: string[] = [];

  return {

    chunks: (): string => captured.join(""),
    stderr: {

      write: (chunk: string): boolean => {

        captured.push(chunk);

        return true;
      }
    }
  };
}

describe("prepareUi", () => {

  test("on a fresh destination creates the hashed-versioned subdir and writes the manifest", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: [ "webUi.mjs", "webUi-featureOptions.mjs", "webUi-featureOptions/state.mjs" ], root: sourceRoot, version: "2.0.0" });

    await prepareUi({ dest, sourceRoot });

    // Read the manifest first to discover the canonical subdir name. This matches how a real plugin's index.html navigates - it never reconstructs the join from
    // version + hash, just trusts what prepare-ui writes. The subdir name's format is verified in a separate test below.
    const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { hash: string; subdir: string; version: string };

    // The versioned subdir contains the mirrored files at their relative paths; each file's content equals its relative path (per the setupSource convention) so
    // the assertion below verifies both presence and content in one read.
    assert.equal(await readFile(join(dest, manifest.subdir, "webUi.mjs"), "utf8"), "webUi.mjs");
    assert.equal(await readFile(join(dest, manifest.subdir, "webUi-featureOptions.mjs"), "utf8"), "webUi-featureOptions.mjs");
    assert.equal(await readFile(join(dest, manifest.subdir, "webUi-featureOptions", "state.mjs"), "utf8"), "webUi-featureOptions/state.mjs");

    assert.equal(manifest.version, "2.0.0", "manifest carries the human-readable version");
    assert.equal(manifest.subdir, manifest.version + "-" + manifest.hash, "subdir is the version + hash join");
  });

  test("manifest.subdir matches the version-hash format the importmap consumer relies on", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    await prepareUi({ dest, sourceRoot });

    const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { hash: string; subdir: string; version: string };

    // The subdir format is part of the consumer contract - plugins that parse the manifest field rely on the `<semver>-<16hex>` shape. Pinning it here so any
    // future drift surfaces as a test failure before reaching consumers.
    assert.match(manifest.hash, /^[0-9a-f]{16}$/, "hash is the truncated SHA-256 prefix (16 hex chars)");
    assert.match(manifest.subdir, /^2\.0\.0-[0-9a-f]{16}$/, "subdir combines semver + hash with a hyphen");
  });

  test("creates the destination directory when it does not yet exist", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "nested", "deep", "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "1.0.0" });

    await prepareUi({ dest, sourceRoot });

    const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { subdir: string };

    assert.equal(await readFile(join(dest, manifest.subdir, "webUi.mjs"), "utf8"), "webUi.mjs");
  });

  test("re-running with unchanged source content produces an identical subdir name and manifest", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: [ "webUi.mjs", "webUi-featureOptions/state.mjs" ], root: sourceRoot, version: "2.0.0" });

    await prepareUi({ dest, sourceRoot });

    const firstManifest = await readFile(join(dest, "manifest.json"), "utf8");

    await prepareUi({ dest, sourceRoot });

    const secondManifest = await readFile(join(dest, "manifest.json"), "utf8");

    // Same content -> same hash -> same subdir -> same manifest bytes. This is the content-determinism property that makes the cache invalidation structural:
    // browsers caching a release-version's URLs stay valid across any number of prepare-ui re-runs against unchanged source.
    assert.equal(firstManifest, secondManifest, "manifest must be byte-identical across runs with unchanged source");
  });

  test("re-running with mutated source content produces a different subdir and sweeps the prior one", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    await prepareUi({ dest, sourceRoot });

    const firstManifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { hash: string; subdir: string };

    // The maintainer-iteration case: source changes without a version bump. The hash must change, the subdir name must change, and the prior subdir must be
    // swept so the destination doesn't accumulate stale builds.
    await writeFile(join(sourceRoot, "dist", "ui", "webUi.mjs"), "MODIFIED");
    await writeFile(join(sourceRoot, "dist", "ui", "added.mjs"), "added.mjs");

    await prepareUi({ dest, sourceRoot });

    const secondManifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { hash: string; subdir: string };

    assert.notEqual(secondManifest.hash, firstManifest.hash, "content change must produce a different hash");
    assert.notEqual(secondManifest.subdir, firstManifest.subdir, "content change must produce a different subdir");

    assert.equal(await readFile(join(dest, secondManifest.subdir, "webUi.mjs"), "utf8"), "MODIFIED", "modified file content must propagate");
    assert.equal(await readFile(join(dest, secondManifest.subdir, "added.mjs"), "utf8"), "added.mjs", "newly-added file must appear");

    const entries = await readdir(dest);

    assert.deepEqual(entries.toSorted(), [ secondManifest.subdir, "manifest.json" ].toSorted(), "the prior subdir is swept; only the current build + manifest remain");
  });

  test("renaming a source file without content change produces a different hash", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: [ "webUi.mjs", "old-name.mjs" ], root: sourceRoot, version: "2.0.0" });

    await prepareUi({ dest, sourceRoot });

    const firstManifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { hash: string };

    // Rename: the SAME content lives at a different path. Path inclusion in the hash input means this is detected as a change - which is the correct semantic
    // for a cache-bust scheme, since consumers import by name and a renamed file is a different import target even if the bytes are unchanged.
    await rm(join(sourceRoot, "dist", "ui", "old-name.mjs"));
    await writeFile(join(sourceRoot, "dist", "ui", "new-name.mjs"), "old-name.mjs");

    await prepareUi({ dest, sourceRoot });

    const secondManifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { hash: string };

    assert.notEqual(secondManifest.hash, firstManifest.hash, "rename without content change must still produce a different hash");
  });

  test("removes stale prior-build subdirs while keeping the current build", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    // Pre-seed the destination with multiple historical builds to verify the sweep targets every prior-shape entry: bare-semver dirs that pre-date this CLI
    // version's content-hash convention, hash-suffixed dirs from earlier iterations of the same release version, and pre-release-tagged versions. All three
    // shapes match the VERSION_PATTERN regex and should be removed.
    await mkdir(join(dest, "1.0.0"), { recursive: true });
    await writeFile(join(dest, "1.0.0", "old.mjs"), "v1");
    await mkdir(join(dest, "1.37.0-abc1234567890def0"), { recursive: true });
    await writeFile(join(dest, "1.37.0-abc1234567890def0", "old.mjs"), "v1.37");
    await mkdir(join(dest, "2.0.0-deadbeefcafef00d"), { recursive: true });
    await writeFile(join(dest, "2.0.0-deadbeefcafef00d", "stale.mjs"), "earlier build of the current version");
    await mkdir(join(dest, "2.0.0-rc.1"), { recursive: true });
    await writeFile(join(dest, "2.0.0-rc.1", "old.mjs"), "rc");

    await prepareUi({ dest, sourceRoot });

    const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { subdir: string };
    const entries = await readdir(dest);

    // Every prior build is gone; only the current build's subdir + manifest survive at the destination root.
    assert.deepEqual(entries.toSorted(), [ manifest.subdir, "manifest.json" ].toSorted());
  });

  test("preserves non-version-shaped entries in the destination", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    // Plugin author has their own files in the destination: a sibling directory, a markdown file, and a non-semver named directory. None of these should be
    // disturbed by the sweep. This is the discipline that lets prepare-ui coexist with whatever else lives in homebridge-ui/public/lib.
    await mkdir(join(dest, "plugin-assets"), { recursive: true });
    await writeFile(join(dest, "plugin-assets", "logo.svg"), "<svg/>");
    await writeFile(join(dest, "README.md"), "consumer notes");
    await mkdir(join(dest, "i18n"), { recursive: true });
    await writeFile(join(dest, "i18n", "en.json"), "{}");

    await prepareUi({ dest, sourceRoot });

    assert.equal(await readFile(join(dest, "plugin-assets", "logo.svg"), "utf8"), "<svg/>", "non-version sibling directory must survive");
    assert.equal(await readFile(join(dest, "README.md"), "utf8"), "consumer notes", "non-version root file must survive");
    assert.equal(await readFile(join(dest, "i18n", "en.json"), "utf8"), "{}", "non-version directory at root must survive");
  });

  test("throws a corrective-action error when the source has not been built", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    // Source root exists but lacks dist/ui. The error message should name the corrective action (npm run build) rather than the operation that failed, because
    // the user's next step matters more than the implementation detail of which stat call returned ENOENT.
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ version: "2.0.0" }));

    await assert.rejects(prepareUi({ dest, sourceRoot }), /HBPU has not been built/);
  });

  test("throws when the source dist/ui path exists but is not a directory", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    // Pathological setup: dist/ui exists as a regular file (perhaps from a botched build). The function must distinguish "directory" from "exists but wrong shape"
    // and surface the latter as a typed error, not silently proceed to fail downstream in the cp call.
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await writeFile(join(sourceRoot, "dist", "ui"), "I am not a directory");
    await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ version: "2.0.0" }));

    await assert.rejects(prepareUi({ dest, sourceRoot }), /is not a directory/);
  });

  test("throws when the source package.json has no version", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(join(sourceRoot, "dist", "ui"), { recursive: true });
    await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ name: "homebridge-plugin-utils" }));

    await assert.rejects(prepareUi({ dest, sourceRoot }), /no version field/);
  });

  test("manifest is well-formed JSON terminated with a newline", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    await prepareUi({ dest, sourceRoot });

    const raw = await readFile(join(dest, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as { hash: string; subdir: string; version: string };

    // The trailing-newline discipline is what every modern POSIX text-file producer follows; pretty-printing keeps the file readable for human debugging.
    assert.equal(raw.endsWith("\n"), true, "manifest must end with a trailing newline");
    assert.equal(manifest.version, "2.0.0");
    assert.equal(manifest.subdir, manifest.version + "-" + manifest.hash);
  });
});

describe("prepareUi - webUI loader stamp", () => {

  // Build a scratch layout for the stamp tests: a synthetic HBPU source root, a `lib` destination, and the plugin's `index.html` beside it (so the stamp resolves it
  // from the destination's parent). The dest basename is `lib` so the derived libPath is the family-convention `./lib/`. The real webui-loader module and the real
  // splice primitive are injected, exercising the genuine parse/render/splice path rather than a mock.
  async function setupStamp(scratchPath: string, indexHtml: string): Promise<{ dest: string; indexPath: string; sourceRoot: string }> {

    const sourceRoot = join(scratchPath, "source");
    const dest = join(scratchPath, "lib");
    const indexPath = join(scratchPath, "index.html");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });
    await writeFile(indexPath, indexHtml);

    return { dest, indexPath, sourceRoot };
  }

  const CONFIG_COMMENT = "<!-- WEBUI LOADER CONFIG {\"bust\":[\"./protect-config.mjs\"],\"entry\":\"./ui.mjs\"} -->";
  const MARKED_INDEX = "<html>\n<body></body>\n" + CONFIG_COMMENT + "\n" + webuiLoader.WEBUI_LOADER_BEGIN + "\n" + webuiLoader.WEBUI_LOADER_END + "\n</html>\n";

  test("no index.html beside the destination is a no-op - the mirror still runs and no index.html is created", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "lib");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    await prepareUi({ dest, loader: webuiLoader, sourceRoot, splice: spliceMarkedRegion });

    assert.ok(await readFile(join(dest, "manifest.json"), "utf8"), "the mirror still produced its manifest");
    await assert.rejects(async () => readFile(join(scratch.path, "index.html"), "utf8"), "the stamp step creates no index.html when none exists");
  });

  test("an index.html without the loader markers is left byte-untouched", async () => {

    await using scratch = await makeScratchRoot();

    const plain = "<html>\n<body>no loader region here</body>\n</html>\n";
    const { dest, indexPath, sourceRoot } = await setupStamp(scratch.path, plain);

    await prepareUi({ dest, loader: webuiLoader, sourceRoot, splice: spliceMarkedRegion });

    assert.equal(await readFile(indexPath, "utf8"), plain, "an index.html with no BEGIN marker is not opted in and stays byte-identical");
  });

  test("a marked index.html with a valid config is stamped, and a second run is byte-identical", async () => {

    await using scratch = await makeScratchRoot();

    const { dest, indexPath, sourceRoot } = await setupStamp(scratch.path, MARKED_INDEX);

    await prepareUi({ dest, loader: webuiLoader, sourceRoot, splice: spliceMarkedRegion });

    const stamped = await readFile(indexPath, "utf8");

    assert.match(stamped, /<script type="module">/, "the loader block is stamped between the markers");
    assert.match(stamped, /"homebridge-plugin-utils\/": new URL\("\.\/lib\/" \+ manifest\.subdir \+ "\/"/,
      "the importmap prefix uses the mirrored package name and the derived ./lib/ libPath");
    assert.match(stamped, /await import\("\.\/ui\.mjs"\)/, "the entry import is present");
    assert.match(stamped, new RegExp(CONFIG_COMMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the config comment survives outside the marked region");

    await prepareUi({ dest, loader: webuiLoader, sourceRoot, splice: spliceMarkedRegion });

    assert.equal(await readFile(indexPath, "utf8"), stamped, "a second stamp run is byte-identical");
  });

  test("neighboring marked regions in the same html are left byte-identical through the stamp", async () => {

    await using scratch = await makeScratchRoot();

    const other = "<html>\n" + docChrome.DOCUMENTATION_BEGIN + "\ndocs region content\n" + docChrome.DOCUMENTATION_END + "\n" + CONFIG_COMMENT + "\n" +
      webuiLoader.WEBUI_LOADER_BEGIN + "\n" + webuiLoader.WEBUI_LOADER_END + "\n" + docChrome.PROJECTS_BEGIN + "\nprojects region content\n" + docChrome.PROJECTS_END +
      "\n</html>\n";
    const { dest, indexPath, sourceRoot } = await setupStamp(scratch.path, other);

    await prepareUi({ dest, loader: webuiLoader, sourceRoot, splice: spliceMarkedRegion });

    const result = await readFile(indexPath, "utf8");

    assert.ok(result.includes(docChrome.DOCUMENTATION_BEGIN + "\ndocs region content\n" + docChrome.DOCUMENTATION_END), "the DOCUMENTATION region is byte-identical");
    assert.ok(result.includes(docChrome.PROJECTS_BEGIN + "\nprojects region content\n" + docChrome.PROJECTS_END), "the PROJECTS region is byte-identical");
    assert.match(result, /<script type="module">/, "the loader region was the only region stamped");
  });

  test("duplicated loader markers propagate the splice ambiguity error under the stamp-phase frame", async () => {

    await using scratch = await makeScratchRoot();

    const dupMarkers = "<html>\n" + CONFIG_COMMENT + "\n" + webuiLoader.WEBUI_LOADER_BEGIN + "\n" + webuiLoader.WEBUI_LOADER_END + "\n" + webuiLoader.WEBUI_LOADER_BEGIN +
      "\n" + webuiLoader.WEBUI_LOADER_END + "\n</html>\n";
    const { dest, indexPath, sourceRoot } = await setupStamp(scratch.path, dupMarkers);

    await assert.rejects(async () => prepareUi({ dest, loader: webuiLoader, sourceRoot, splice: spliceMarkedRegion }),
      /mirror succeeded but stamping the loader[\s\S]*ambiguous/, "the ambiguous-marker error is framed as a stamp-phase failure over a completed mirror");

    // The failed stamp writes nothing over the original: the marked region still holds no stamped block.
    assert.doesNotMatch(await readFile(indexPath, "utf8"), /<script type="module">/, "a failed stamp leaves the index.html unstamped");
  });

  test("a package.json without a name field fails the stamp with the framed derivation error", async () => {

    await using scratch = await makeScratchRoot();

    const { dest, indexPath, sourceRoot } = await setupStamp(scratch.path, MARKED_INDEX);

    // The stamp derives the importmap prefix from the package name, so a name-less package.json is a precondition failure the stamp names; the mirror itself needs
    // only the version and completes first.
    await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ version: "2.0.0" }, null, 2));

    await assert.rejects(async () => prepareUi({ dest, loader: webuiLoader, sourceRoot, splice: spliceMarkedRegion }), /has no name field/);

    assert.equal(await readFile(indexPath, "utf8"), MARKED_INDEX, "the index.html is untouched when the stamp fails its precondition");
  });
});

// A minimal well-formed catalog module body: two categories, one of which carries a value option, sufficient to render a non-trivial fragment (including the
// `.<value>` legend) so the splice has substantive content to verify. Held as a module-scope constant rather than inlined as a parameter default so the multi-line
// ESM source stays out of the destructuring signature.
const VALID_CATALOG_BODY = "export const featureOptionCategories = [ { description: \"Audio\", name: \"Audio\" }, { description: \"Recording\", name: \"Nvr\" } ];\n" +
  "export const featureOptions = { Audio: [ { default: true, description: \"Audio support.\", name: \"\" } ], Nvr: [ { default: true, defaultValue: 10, " +
  "description: \"Days of recordings to retain.\", name: \"Recording.Retention\" } ] };\n";

// The two scope-hook export lines an annotated plugin (Protect/Access) would ship alongside its catalog. `describeCategoryScope` contributes a device-scope sentence
// under each category heading; `describeOptionScope` contributes a "<BR>"-prefixed suffix on each option's description cell. Both produce text that does not otherwise
// appear in the rendered fragment, so a test can assert their presence unambiguously, and both echo the entry's name so a test can confirm the hook saw the right
// catalog entry. Kept as standalone export lines so a catalog body can compose exactly the subset (both, neither, or one) each test needs.
const DESCRIBE_CATEGORY_SCOPE_EXPORT = "export const describeCategoryScope = (category) => \"Scope: applies to every \" + category.name + \" device.\";\n";
const DESCRIBE_OPTION_SCOPE_EXPORT = "export const describeOptionScope = (option) => \"<BR>Annotated scope for \" + option.name + \".\";\n";

/**
 * Write a synthetic plugin catalog module into a scratch root as a `.mjs` file (always ESM regardless of any ambient package.json) and return its absolute path.
 * The body is plain ESM with the two named exports {@link prepareDocs} validates and the renderer consumes. Writing real module source - rather than mocking the
 * dynamic import - exercises the genuine `pathToFileURL` + `import()` path the production code takes.
 *
 * @param args
 * @param args.body - The module body text. Defaults to {@link VALID_CATALOG_BODY}, a minimal two-category catalog with one value option.
 * @param args.root - The scratch directory the catalog file is written into.
 *
 * @returns The absolute path to the written catalog module.
 */
async function writeCatalog({ body = VALID_CATALOG_BODY, root }: { body?: string; root: string }): Promise<string> {

  const catalogPath = join(root, "catalog.mjs");

  await writeFile(catalogPath, body);

  return catalogPath;
}

/**
 * Write a synthetic plugin doc carrying the shared begin/end markers wrapped in hand-written prose, and return its absolute path. The prose on either side of the
 * marker pair lets each assertion confirm the splice replaces only the marked region and leaves the surrounding document untouched.
 *
 * @param args
 * @param args.root    - The scratch directory the doc file is written into.
 * @param args.markers - When `false`, the marker pair is omitted so the splice's missing-marker throw can be exercised. Defaults to `true`.
 *
 * @returns The absolute path to the written doc.
 */
async function writeDoc({ markers = true, root }: { markers?: boolean; root: string }): Promise<string> {

  const docPath = join(root, "FeatureOptions.md");
  const region = markers ? (FEATURE_OPTIONS_DOC_BEGIN + "\nstale content to be replaced\n" + FEATURE_OPTIONS_DOC_END) : "no markers here";

  await writeFile(docPath, "# Header\n\nHand-written intro.\n\n" + region + "\n\nHand-written footer.\n");

  return docPath;
}

describe("prepareDocs", () => {

  test("replaces the marked region with the rendered reference, repeatably, leaving surrounding prose intact", async () => {

    await using scratch = await makeScratchRoot();

    const catalogModulePath = await writeCatalog({ root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion });

    const first = await readFile(docPath, "utf8");

    // The hand-written prose on both sides of the marker pair must survive, and the stale placeholder between the markers must be gone, replaced by the rendered
    // tables. We assert against rendered structure (the category index bullets, a per-row anchor, the value-option placeholder) rather than a brittle full-string
    // match, so the test pins the splice's contract without coupling to the renderer's exact column padding.
    assert.match(first, /# Header/, "the hand-written header must be preserved");
    assert.match(first, /Hand-written footer\./, "the hand-written footer must be preserved");
    assert.equal(first.includes("stale content to be replaced"), false, "the stale marked-region content must be replaced");
    assert.match(first, /\* \[Audio\]\(#audio\): Audio/, "the rendered category index must appear in the marked region");
    assert.match(first, /`Nvr\.Recording\.Retention\.<value>`/, "the value option must render with the .<value> placeholder");

    // Re-running against the now-spliced doc must reproduce it byte-for-byte: the renderer is a pure projection of the unchanged catalog and the splice is
    // repeatable, so a second pass is a no-op. This is the property the plugin's build-docs script relies on to stay diff-free across rebuilds.
    await prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion });

    const second = await readFile(docPath, "utf8");

    assert.equal(second, first, "a second prepareDocs pass against unchanged input must leave the doc byte-identical");
  });

  test("throws naming the module when the catalog lacks featureOptionCategories", async () => {

    await using scratch = await makeScratchRoot();

    // The catalog exports featureOptions but not featureOptionCategories; the validation must reject it with a diagnostic that names the offending module and the
    // missing export, rather than letting a downstream undefined reach the renderer.
    const catalogModulePath = await writeCatalog({ body: "export const featureOptions = {};\n", root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await assert.rejects(prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion }),
      /does not export a `featureOptionCategories` array/);
  });

  test("throws when featureOptionCategories is not an array", async () => {

    await using scratch = await makeScratchRoot();

    // The export exists but is the wrong shape (an object, not an array). Array.isArray is what decides, so a non-array value is rejected the same way an absent
    // one is - the renderer never sees a mis-typed categories list.
    const catalogModulePath = await writeCatalog({ body: "export const featureOptionCategories = {}; export const featureOptions = {};\n", root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await assert.rejects(prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion }),
      /does not export a `featureOptionCategories` array/);
  });

  test("throws when featureOptions is absent or not a non-null object", async () => {

    await using scratch = await makeScratchRoot();

    // featureOptionCategories is well-formed but featureOptions is null - the object guard must reject a null as firmly as a missing export, since `typeof null` is
    // "object" and a naive typeof check would let it through to fail obscurely downstream.
    const catalogModulePath = await writeCatalog({ body: "export const featureOptionCategories = []; export const featureOptions = null;\n", root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await assert.rejects(prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion }),
      /does not export a `featureOptions` object/);
  });

  test("propagates the splice's throw when the doc lacks the marker pair", async () => {

    await using scratch = await makeScratchRoot();

    // The catalog is valid but the doc has no markers; prepareDocs lets the splice's own framed error propagate unchanged rather than swallowing or rewrapping it,
    // so the dispatch site can frame every failure uniformly.
    const catalogModulePath = await writeCatalog({ root: scratch.path });
    const docPath = await writeDoc({ markers: false, root: scratch.path });

    await assert.rejects(prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion }),
      /begin marker not found/);
  });

  test("forwards both optional scope hooks so their contributions land in the rendered doc", async () => {

    await using scratch = await makeScratchRoot();

    // A catalog that exports both scope hooks in addition to the required arrays. prepareDocs must read them off the same dynamic-imported namespace, validate them as
    // functions, and forward them to the renderer, which threads each into its output - the category hook as a device-scope line under the heading, the option hook as
    // a "<BR>"-prefixed suffix on the description cell. We assert against the exact strings the hooks emit (including the entry name they echo) so the test proves both
    // that the hooks were forwarded and that the renderer invoked them with the right catalog entry.
    const catalogModulePath = await writeCatalog({ body: VALID_CATALOG_BODY + DESCRIBE_CATEGORY_SCOPE_EXPORT + DESCRIBE_OPTION_SCOPE_EXPORT, root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion });

    const doc = await readFile(docPath, "utf8");

    assert.match(doc, /Scope: applies to every Audio device\./, "the category scope hook's device-scope line must appear under the Audio heading");
    assert.match(doc, /Scope: applies to every Nvr device\./, "the category scope hook must be invoked per category, echoing each category's name");
    assert.match(doc, /<BR>Annotated scope for Recording\.Retention\./, "the option scope hook's suffix must be appended to the option's description cell");
  });

  test("renders byte-identically to the no-hooks path when the catalog exports neither hook (the ratgdo path)", async () => {

    await using scratch = await makeScratchRoot();

    // The no-regression guarantee for the zero-hook plugin: a catalog exporting neither hook must produce exactly the document a hooks-unaware catalog always has. We
    // splice the same catalog into two separate docs - one through the plain no-hooks body, one through that same body re-read - and require byte equality, which pins
    // that the new hook-pickup code adds nothing to the output when both hooks are absent. The hook-contribution strings from the present-hooks test must also be
    // wholly absent, since neither hook was exported.
    const catalogModulePath = await writeCatalog({ body: VALID_CATALOG_BODY, root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion });

    const noHooksDoc = await readFile(docPath, "utf8");

    // Independently render the same catalog directly through the renderer with NO hook arguments at all - the literal pre-change call shape - and splice it into a
    // fresh copy of the same doc. Byte equality between this and the prepareDocs output proves prepareDocs's forwarding of two `undefined` hooks is inert: passing the
    // absent hooks through is indistinguishable from never passing them, so the ratgdo output is unchanged.
    const reference = renderFeatureOptionsReference({

      categories: [ { description: "Audio", name: "Audio" }, { description: "Recording", name: "Nvr" } ],
      options: { Audio: [{ default: true, description: "Audio support.", name: "" }],
        Nvr: [{ default: true, defaultValue: 10, description: "Days of recordings to retain.", name: "Recording.Retention" }] }
    });
    const baselineSource = "# Header\n\nHand-written intro.\n\n" + FEATURE_OPTIONS_DOC_BEGIN + "\nstale content to be replaced\n" + FEATURE_OPTIONS_DOC_END +
      "\n\nHand-written footer.\n";
    const baselineDoc = spliceMarkedRegion(baselineSource, reference);

    assert.equal(noHooksDoc, baselineDoc, "a catalog exporting neither hook must render byte-identically to the no-hook-argument render path");
    assert.equal(noHooksDoc.includes("<BR>"), false, "no option scope suffix may appear when the catalog exports no describeOptionScope");
    assert.equal(noHooksDoc.includes("Scope: applies to"), false, "no category scope line may appear when the catalog exports no describeCategoryScope");
  });

  test("throws naming the module when describeOptionScope is present but not a function", async () => {

    await using scratch = await makeScratchRoot();

    // The catalog's required arrays are well-formed, but describeOptionScope is exported as a non-callable value. The independent per-hook guard must reject it with a
    // diagnostic that names the offending module and export, exactly as the required-export guards do, rather than letting a non-function reach the renderer's optional
    // call site (where `value?.(...)` would throw an opaque "is not a function" deep in the traversal).
    const catalogModulePath = await writeCatalog({ body: VALID_CATALOG_BODY + "export const describeOptionScope = 42;\n", root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await assert.rejects(prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion }),
      /exports a non-function `describeOptionScope`/);
  });

  test("throws naming the module when describeCategoryScope is present but not a function", async () => {

    await using scratch = await makeScratchRoot();

    // The symmetric case for the category hook: a present-but-non-function describeCategoryScope is rejected by its own independent guard with a framed diagnostic, so
    // neither hook can slip a mis-typed value through to the renderer.
    const catalogModulePath = await writeCatalog({ body: VALID_CATALOG_BODY + "export const describeCategoryScope = \"not a function\";\n", root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await assert.rejects(prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion }),
      /exports a non-function `describeCategoryScope`/);
  });

  test("applies a single exported hook and omits the other cleanly", async () => {

    await using scratch = await makeScratchRoot();

    // The asymmetric case: a catalog that exports only describeOptionScope. The validated-independently contract means the present hook is forwarded and applied while
    // the absent one stays `undefined` and contributes nothing - no stray "undefined" literal, no empty line. We assert the option suffix appears AND that no category
    // scope line was emitted, proving the two hooks are wired through independently rather than all-or-nothing.
    const catalogModulePath = await writeCatalog({ body: VALID_CATALOG_BODY + DESCRIBE_OPTION_SCOPE_EXPORT, root: scratch.path });
    const docPath = await writeDoc({ root: scratch.path });

    await prepareDocs({ catalogModulePath, docPath, render: renderFeatureOptionsReference, splice: spliceMarkedRegion });

    const doc = await readFile(docPath, "utf8");

    assert.match(doc, /<BR>Annotated scope for Recording\.Retention\./, "the single exported option hook must be applied");
    assert.equal(doc.includes("Scope: applies to"), false, "the unexported category hook must be omitted cleanly, contributing no line");
  });
});

describe("runCli", () => {

  test("with no arguments writes the usage banner and exits 0", async () => {

    await using scratch = await makeScratchRoot();

    const capture = captureStderr();
    const code = await runCli({ argv: [], cwd: scratch.path, sourceRoot: scratch.path, stderr: capture.stderr });

    assert.equal(code, 0);
    assert.equal(capture.chunks(), USAGE);
  });

  test("with an unknown command writes the usage banner and exits 1", async () => {

    await using scratch = await makeScratchRoot();

    const capture = captureStderr();
    const code = await runCli({ argv: ["nonsense"], cwd: scratch.path, sourceRoot: scratch.path, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.equal(capture.chunks(), USAGE);
  });

  test("prepare-ui without a destination argument writes a misuse message and exits 1", async () => {

    await using scratch = await makeScratchRoot();

    const capture = captureStderr();
    const code = await runCli({ argv: ["prepare-ui"], cwd: scratch.path, sourceRoot: scratch.path, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /missing required destination argument/);
  });

  test("prepare-ui dispatches to the function and exits 0 on success", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    // The prepare-ui dispatch reaches HBPU's loader renderer and the splice primitive through computed dynamic imports of its built dist; supply them the same way the
    // prepare-docs dispatch tests supply their renderer. No index.html beside the destination means the stamp itself is a no-op, so this pins the dispatch + mirror.
    await writeLoaderDist(sourceRoot);

    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-ui", dest ], cwd: sourceRoot, sourceRoot, stderr: capture.stderr });

    assert.equal(code, 0);
    assert.equal(capture.chunks(), "", "successful dispatch must not write to stderr");

    const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { subdir: string };

    assert.equal(await readFile(join(dest, manifest.subdir, "webUi.mjs"), "utf8"), "webUi.mjs");
  });

  test("prepare-ui surfaces the function's error message and exits 1", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    // The loader dist is present so the dispatch's computed imports succeed and control reaches prepareUi, but the source has no dist/ui - prepareUi throws with the
    // corrective-action message, and the dispatcher should surface it on stderr rather than letting the rejection escape unhandled.
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ version: "2.0.0" }));
    await writeLoaderDist(sourceRoot);

    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-ui", dest ], cwd: sourceRoot, sourceRoot, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /HBPU has not been built/);
  });

  test("prepare-ui frames a not-built HBPU when the loader modules are absent from sourceRoot", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const dest = join(scratch.path, "dest");

    // The source has a dist/ui to mirror but no dist/webui-loader.js, so the dispatch's computed import of the loader renderer fails. The dispatcher must catch that and
    // frame it as the actionable "HBPU has not been built" condition rather than silently skipping a wanted stamp - the same hard-fail prepare-docs applies to its
    // absent renderer, and the reason a dist complete enough to mirror dist/ui yet missing the loader is treated as a build inconsistency.
    await mkdir(sourceRoot, { recursive: true });
    await setupSource({ files: ["webUi.mjs"], root: sourceRoot, version: "2.0.0" });

    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-ui", dest ], cwd: sourceRoot, sourceRoot, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /HBPU has not been built:.*webui-loader\.js/);
  });

  test("prepare-docs without a catalog-module argument writes a misuse message and exits 1", async () => {

    await using scratch = await makeScratchRoot();

    const capture = captureStderr();
    const code = await runCli({ argv: ["prepare-docs"], cwd: scratch.path, sourceRoot: scratch.path, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /missing required catalog-module argument/);
  });

  test("prepare-docs frames a not-built HBPU when the renderer module is absent from sourceRoot", async () => {

    await using scratch = await makeScratchRoot();

    // The sourceRoot tmpdir has no dist/featureOptions-docs.js, so the renderer's dynamic import fails. The dispatcher must catch that specific failure and frame it
    // as the actionable "HBPU has not been built" condition, distinct from a render/splice failure - and it must do so without ever reaching prepareDocs (a catalog
    // argument is supplied here precisely so the only thing that can fail is the renderer import). This exercises the renderer-missing branch with no built dist.
    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-docs", "dist/options.js" ], cwd: scratch.path, sourceRoot: scratch.path, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /HBPU has not been built/);
    assert.match(capture.chunks(), /featureOptions-docs\.js is missing/);
  });

  test("prepare-docs dispatches to prepareDocs, regenerates the doc, and exits 0 on success", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const cwd = join(scratch.path, "plugin");

    // Build a synthetic HBPU sourceRoot whose dist/featureOptions-docs.js re-exports the REAL renderer and splice from this repo's source. This exercises the full
    // dispatch path - the renderer dynamic import, the prepareDocs call, and the success return - with a self-contained sourceRoot, so the test stays independent of
    // whether dist/ has been built. The re-export resolves the source by its absolute file URL, the same indirection the production dynamic import uses.
    const realDocsModule = fileURLToPath(new URL("../featureOptions-docs.ts", import.meta.url));

    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await writeFile(join(sourceRoot, "dist", "featureOptions-docs.js"), "export { renderFeatureOptionsReference, spliceMarkedRegion } from " +
      JSON.stringify(pathToFileURL(realDocsModule).href) + ";\n");

    // The plugin side: a compiled catalog module and a doc carrying the marker pair, both addressed by paths relative to the injected cwd to prove the dispatcher
    // resolves its arguments against cwd rather than the process working directory.
    await mkdir(join(cwd, "dist"), { recursive: true });
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "dist", "options.js"), VALID_CATALOG_BODY);
    await writeFile(join(cwd, "docs", "FeatureOptions.md"), "# Plugin\n\n" + FEATURE_OPTIONS_DOC_BEGIN + "\nstale\n" + FEATURE_OPTIONS_DOC_END + "\n");

    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-docs", "dist/options.js" ], cwd, sourceRoot, stderr: capture.stderr });

    assert.equal(code, 0);
    assert.equal(capture.chunks(), "", "successful dispatch must not write to stderr");

    const doc = await readFile(join(cwd, "docs", "FeatureOptions.md"), "utf8");

    assert.equal(doc.includes("stale"), false, "the stale marked-region content must be replaced");
    assert.match(doc, /`Nvr\.Recording\.Retention\.<value>`/, "the rendered reference must land in the default docs/FeatureOptions.md");
  });

  test("prepare-docs honors --doc to target a non-default reference path, and surfaces prepareDocs errors as exit 1", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const cwd = join(scratch.path, "plugin");
    const realDocsModule = fileURLToPath(new URL("../featureOptions-docs.ts", import.meta.url));

    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await writeFile(join(sourceRoot, "dist", "featureOptions-docs.js"), "export { renderFeatureOptionsReference, spliceMarkedRegion } from " +
      JSON.stringify(pathToFileURL(realDocsModule).href) + ";\n");

    // The doc lives at a non-default path and is referenced through --doc; it deliberately lacks the marker pair so prepareDocs's splice throws. The dispatcher must
    // both honor the --doc override (resolving it against cwd) and surface the propagated splice error as a framed stderr line with exit 1 - covering the prepareDocs
    // failure branch that the renderer-missing test cannot reach.
    await mkdir(join(cwd, "dist"), { recursive: true });
    await mkdir(join(cwd, "reference"), { recursive: true });
    await writeFile(join(cwd, "dist", "options.js"), VALID_CATALOG_BODY);
    await writeFile(join(cwd, "reference", "Options.md"), "no markers in this file");

    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-docs", "dist/options.js", "--doc", "reference/Options.md" ], cwd, sourceRoot, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /homebridge-plugin-utils prepare-docs: /, "the prepareDocs failure must be framed under the subcommand prefix");
    assert.match(capture.chunks(), /begin marker not found/, "the propagated splice error must be surfaced verbatim");
  });
});

// A minimal but complete doc-chrome manifest covering every entry kind the stamper handles: a README-anchor entry, a doc entry that receives a masthead, and a doc
// entry (the changelog) that opts out of the masthead. Serialized to a `.mjs` module by writeManifest so the genuine dynamic-import load path is exercised. Tests
// spread over it to add a project source or drop a field.
const BASE_MANIFEST = {

  devBadges: [{ alt: "License", image: "https://img.test/license.svg", link: "https://plugin.test/license" }],
  masthead: {

    badges: [{ alt: "Downloads", image: "https://img.test/dl.svg", link: "https://plugin.test/npm" }],
    logo: { alt: "example-plugin", href: "https://github.com/acme/example-plugin", src: "https://raw.test/logo.svg" },
    tagline: "Support using Homebridge.",
    title: "Example Plugin"
  },
  nav: [{ entries: [

    { anchor: "installation", blurb: "installing this plugin.", kind: "readme-anchor", title: "Installation" },
    { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", title: "Best Practices" },
    { blurb: "release history.", file: "docs/Changelog.md", kind: "doc", masthead: false, title: "Changelog" }
  ], title: "Getting Started" }],
  repo: { branch: "main", name: "example-plugin", owner: "acme" }
};

// Wrap a stale placeholder in a begin/end marker pair - the shape each stampable region has before prepareChrome replaces its interior.
function markedRegion(begin: string, end: string): string {

  return begin + "\nstale region content\n" + end;
}

/**
 * Write a doc-chrome manifest into a scratch root as a `.mjs` module exporting `docChrome`, and return its absolute path. Serializing a plain object through JSON keeps
 * each test's manifest a readable data literal while still exercising the real extension-dispatched module load path.
 *
 * @param args
 * @param args.manifest - The manifest object to serialize.
 * @param args.root     - The scratch directory the manifest is written into.
 *
 * @returns The absolute path to the written manifest module.
 */
async function writeManifest({ manifest, root }: { manifest: unknown; root: string }): Promise<string> {

  const manifestPath = join(root, "docChrome.mjs");

  await writeFile(manifestPath, "export const docChrome = " + JSON.stringify(manifest) + ";\n");

  return manifestPath;
}

/**
 * Write a synthetic plugin documentation tree into a scratch root - a README with the masthead, documentation, and dashboard-badge regions; a content doc with the
 * masthead and footer regions; a changelog with only the footer region (it opts out of the masthead); and, unless suppressed, a webUI carrying the documentation and
 * project regions. Every region is a marker pair around a stale placeholder, wrapped in hand-written prose so each assertion can confirm the splice touches only its
 * region.
 *
 * @param args
 * @param args.root  - The scratch directory the tree is written into.
 * @param args.webui - When `false`, the webUI file is omitted so the webUI-absent skip can be exercised. Defaults to `true`.
 */
async function writePluginTree({ root, webui = true }: { root: string; webui?: boolean }): Promise<void> {

  await writeFile(join(root, "README.md"), "# Top\n\n" + markedRegion(docChrome.MASTHEAD_BEGIN, docChrome.MASTHEAD_END) + "\n\nHand intro.\n\n## Documentation\n" +
    markedRegion(docChrome.DOCUMENTATION_BEGIN, docChrome.DOCUMENTATION_END) + "\n\n## Dashboard\n" + markedRegion(docChrome.DEV_BADGES_BEGIN, docChrome.DEV_BADGES_END) +
    "\n\nHand footer.\n");

  await mkdir(join(root, "docs"), { recursive: true });

  await writeFile(join(root, "docs", "BestPractices.md"), "# BP\n\n" + markedRegion(docChrome.MASTHEAD_BEGIN, docChrome.MASTHEAD_END) + "\n\nBody.\n\n" +
    markedRegion(docChrome.DOCUMENTATION_BEGIN, docChrome.DOCUMENTATION_END) + "\n");

  await writeFile(join(root, "docs", "Changelog.md"), "# Changelog\n\nBody.\n\n" + markedRegion(docChrome.DOCUMENTATION_BEGIN, docChrome.DOCUMENTATION_END) + "\n");

  if(webui) {

    await mkdir(join(root, "homebridge-ui", "public"), { recursive: true });

    await writeFile(join(root, "homebridge-ui", "public", "index.html"), "<html>\n" + markedRegion(docChrome.DOCUMENTATION_BEGIN, docChrome.DOCUMENTATION_END) + "\n" +
      markedRegion(docChrome.PROJECTS_BEGIN, docChrome.PROJECTS_END) + "\n</html>\n");
  }
}

describe("prepareChrome", () => {

  test("stamps every region across the README, docs, and webUI, leaving surrounding prose intact", async () => {

    await using scratch = await makeScratchRoot();

    const manifest = { ...BASE_MANIFEST, projects: [{ blurb: "garage support.", href: "https://github.com/acme/ratgdo", title: "ratgdo" }] };
    const manifestPath = await writeManifest({ manifest, root: scratch.path });

    await writePluginTree({ root: scratch.path });

    await prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion });

    const readme = await readFile(join(scratch.path, "README.md"), "utf8");

    assert.match(readme, /# Top/, "the hand-written header must be preserved");
    assert.match(readme, /Hand footer\./, "the hand-written footer must be preserved");
    assert.equal(readme.includes("stale region content"), false, "every README region's placeholder must be replaced");
    assert.match(readme, /# Example Plugin/, "the masthead title must be stamped");
    assert.match(readme, /\* \[Installation\]\(#installation\): installing this plugin\./, "the README nav must use an in-page anchor for the README-hosted entry");
    assert.match(readme, /\[!\[License\]/, "the dashboard badges must be stamped");

    const bestPractices = await readFile(join(scratch.path, "docs", "BestPractices.md"), "utf8");
    const footer = bestPractices.slice(bestPractices.indexOf(docChrome.DOCUMENTATION_BEGIN));

    assert.match(bestPractices, /# Example Plugin/, "the doc masthead must be stamped");
    assert.match(footer, /README\.md#installation/, "the doc footer must resolve the anchor entry to the absolute README URL");
    assert.equal(footer.includes("BestPractices.md"), false, "the doc footer must omit the current doc's own entry");

    const changelog = await readFile(join(scratch.path, "docs", "Changelog.md"), "utf8");

    assert.equal(changelog.includes("Example Plugin"), false, "the changelog opts out of the masthead");
    assert.match(changelog, /Best Practices/, "the changelog still receives the footer nav");

    const html = await readFile(join(scratch.path, "homebridge-ui", "public", "index.html"), "utf8");

    assert.match(html, /<h5>Getting Started<\/h5>/, "the webUI nav must be stamped as HTML");
    assert.match(html, /ratgdo: garage support\./, "the webUI project list must be stamped");
  });

  test("a doc entry opted out of both regions stays byte-untouched while remaining listed in every documentation index", async () => {

    await using scratch = await makeScratchRoot();

    const entries = [

      { anchor: "installation", blurb: "installing this plugin.", kind: "readme-anchor", title: "Installation" },
      { blurb: "best practices.", file: "docs/BestPractices.md", kind: "doc", title: "Best Practices" },
      { blurb: "release history.", file: "docs/Changelog.md", footer: false, kind: "doc", masthead: false, title: "Changelog" }
    ];

    const manifest = { ...BASE_MANIFEST, nav: [{ entries, title: "Getting Started" }] };
    const manifestPath = await writeManifest({ manifest, root: scratch.path });

    await writePluginTree({ root: scratch.path });

    // A fully-opted-out file needs no marker pairs at all: replace the tree's changelog with pure prose so the assertion below proves the stamper never touches it.
    const pristine = "# Changelog\n\nHand-written history, no chrome.\n";

    await writeFile(join(scratch.path, "docs", "Changelog.md"), pristine);

    await prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion });

    assert.equal(await readFile(join(scratch.path, "docs", "Changelog.md"), "utf8"), pristine, "the fully-opted-out changelog must be byte-untouched");

    const readme = await readFile(join(scratch.path, "README.md"), "utf8");

    assert.match(readme, /\[Changelog\]/, "the README documentation index still lists the changelog");

    const bestPractices = await readFile(join(scratch.path, "docs", "BestPractices.md"), "utf8");
    const footer = bestPractices.slice(bestPractices.indexOf(docChrome.DOCUMENTATION_BEGIN));

    assert.match(footer, /\[Changelog\]/, "a sibling doc's footer still lists the changelog");
  });

  test("loads a manifest authored as static JSON, not just a module", async () => {

    await using scratch = await makeScratchRoot();

    // Author the manifest as a .json file to exercise loadDocChromeManifest's JSON branch - the alternative to the .mjs module every other test uses - and confirm both
    // authoring formats converge on the same validated stamp.
    const manifestPath = join(scratch.path, "docChrome.json");

    await writeFile(manifestPath, JSON.stringify(BASE_MANIFEST));
    await writePluginTree({ root: scratch.path });

    await prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion });

    const readme = await readFile(join(scratch.path, "README.md"), "utf8");

    assert.match(readme, /# Example Plugin/, "a JSON-authored manifest must stamp the masthead identically to a module-authored one");
  });

  test("is all-or-nothing across files: a target missing its markers aborts with zero writes", async () => {

    await using scratch = await makeScratchRoot();

    const manifestPath = await writeManifest({ manifest: BASE_MANIFEST, root: scratch.path });

    await writePluginTree({ root: scratch.path });

    // Break one doc: strip its markers so its splice throws during the in-memory validate-all pass, before any file is written.
    await writeFile(join(scratch.path, "docs", "BestPractices.md"), "# BP\n\nno markers here.\n");

    const readmeBefore = await readFile(join(scratch.path, "README.md"), "utf8");

    await assert.rejects(prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion }), /begin marker not found/);

    assert.equal(await readFile(join(scratch.path, "README.md"), "utf8"), readmeBefore, "no file may be written when any region fails to splice");
  });

  test("resolves a remote project source through the injected fetch", async () => {

    await using scratch = await makeScratchRoot();

    const manifest = { ...BASE_MANIFEST, projects: { url: "https://projects.test/list.json" } };
    const manifestPath = await writeManifest({ manifest, root: scratch.path });

    await writePluginTree({ root: scratch.path });

    let requested = "";
    const fetchImpl = (async (input: string): Promise<unknown> => {

      requested = input;

      return { ok: true, status: 200,
        text: async (): Promise<string> => JSON.stringify([{ blurb: "access support.", href: "https://github.com/acme/access", title: "unifi-access" }]) };
    }) as unknown as typeof fetch;

    await prepareChrome({ chrome: docChrome, fetchImpl, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion });

    assert.equal(requested, "https://projects.test/list.json", "the manifest's project URL must be fetched");

    const html = await readFile(join(scratch.path, "homebridge-ui", "public", "index.html"), "utf8");

    assert.match(html, /unifi-access: access support\./, "the fetched project list must be stamped into the webUI");
  });

  test("fails with a framed error when the remote project fetch is not OK", async () => {

    await using scratch = await makeScratchRoot();

    const manifest = { ...BASE_MANIFEST, projects: { url: "https://projects.test/missing.json" } };
    const manifestPath = await writeManifest({ manifest, root: scratch.path });

    await writePluginTree({ root: scratch.path });

    const fetchImpl = (async (): Promise<unknown> => ({ ok: false, status: 404, text: async (): Promise<string> => "" })) as unknown as typeof fetch;

    await assert.rejects(prepareChrome({ chrome: docChrome, fetchImpl, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion }), /HTTP 404/);
  });

  test("resolves a local-file project source relative to the plugin root", async () => {

    await using scratch = await makeScratchRoot();

    const manifest = { ...BASE_MANIFEST, projects: { file: "projects.json" } };
    const manifestPath = await writeManifest({ manifest, root: scratch.path });

    await writePluginTree({ root: scratch.path });

    const projects = [{ blurb: "streaming server.", href: "https://github.com/acme/prismcast", title: "prismcast" }];

    await writeFile(join(scratch.path, "projects.json"), JSON.stringify(projects));

    await prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion });

    const html = await readFile(join(scratch.path, "homebridge-ui", "public", "index.html"), "utf8");

    assert.match(html, /prismcast: streaming server\./, "the local-file project list must be stamped into the webUI");
  });

  test("frames a manifest that is not valid JSON with a source-naming diagnostic", async () => {

    await using scratch = await makeScratchRoot();

    const manifestPath = join(scratch.path, "docChrome.json");

    await writeFile(manifestPath, "{ not valid json");
    await writePluginTree({ root: scratch.path });

    await assert.rejects(prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion }),
      /Doc-chrome manifest .* is not valid JSON/);
  });

  test("frames a local project list that is not valid JSON with a source-naming diagnostic", async () => {

    await using scratch = await makeScratchRoot();

    const manifest = { ...BASE_MANIFEST, projects: { file: "projects.json" } };
    const manifestPath = await writeManifest({ manifest, root: scratch.path });

    await writePluginTree({ root: scratch.path });
    await writeFile(join(scratch.path, "projects.json"), "{ not valid json");

    await assert.rejects(prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion }),
      /The project list at .* is not valid JSON/);
  });

  test("skips the webUI when no index.html is present, still stamping the README and docs", async () => {

    await using scratch = await makeScratchRoot();

    const manifestPath = await writeManifest({ manifest: BASE_MANIFEST, root: scratch.path });

    await writePluginTree({ root: scratch.path, webui: false });

    await prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion });

    const readme = await readFile(join(scratch.path, "README.md"), "utf8");

    assert.equal(readme.includes("stale region content"), false, "the README regions must be stamped even when no webUI is present");
  });

  test("rejects a mis-shaped manifest with a field-naming diagnostic and writes nothing", async () => {

    await using scratch = await makeScratchRoot();

    const { masthead: _masthead, ...withoutMasthead } = BASE_MANIFEST;
    const manifestPath = await writeManifest({ manifest: withoutMasthead, root: scratch.path });

    await writePluginTree({ root: scratch.path });

    const readmeBefore = await readFile(join(scratch.path, "README.md"), "utf8");

    await assert.rejects(prepareChrome({ chrome: docChrome, manifestPath, pluginRoot: scratch.path, splice: spliceMarkedRegion }), /`masthead` must be an object/);

    assert.equal(await readFile(join(scratch.path, "README.md"), "utf8"), readmeBefore, "a manifest rejected before planning must write nothing");
  });
});

describe("runCli - prepare-chrome dispatch", () => {

  // Build a synthetic HBPU sourceRoot whose dist modules re-export the REAL doc-chrome renderers and the real splice from this repo's source, so the dispatch path -
  // both computed dynamic imports, the prepareChrome call, and the success return - runs against a self-contained root independent of whether dist/ has been built.
  async function writeSyntheticSource(sourceRoot: string): Promise<void> {

    const realChrome = fileURLToPath(new URL("../docChrome.ts", import.meta.url));
    const realDocs = fileURLToPath(new URL("../featureOptions-docs.ts", import.meta.url));

    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await writeFile(join(sourceRoot, "dist", "docChrome.js"), "export * from " + JSON.stringify(pathToFileURL(realChrome).href) + ";\n");
    await writeFile(join(sourceRoot, "dist", "featureOptions-docs.js"), "export { renderFeatureOptionsReference, spliceMarkedRegion } from " +
      JSON.stringify(pathToFileURL(realDocs).href) + ";\n");
  }

  test("dispatches to prepareChrome, stamps the tree, and exits 0 on success", async () => {

    await using scratch = await makeScratchRoot();

    const sourceRoot = join(scratch.path, "source");
    const cwd = join(scratch.path, "plugin");

    await writeSyntheticSource(sourceRoot);
    await mkdir(cwd, { recursive: true });

    const manifest = { ...BASE_MANIFEST, projects: [{ blurb: "garage support.", href: "https://github.com/acme/ratgdo", title: "ratgdo" }] };

    await writeManifest({ manifest, root: cwd });
    await writePluginTree({ root: cwd });

    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-chrome", "docChrome.mjs" ], cwd, sourceRoot, stderr: capture.stderr });

    assert.equal(code, 0, "successful dispatch must exit 0; stderr: " + capture.chunks());
    assert.equal(capture.chunks(), "", "successful dispatch must not write to stderr");

    const readme = await readFile(join(cwd, "README.md"), "utf8");

    assert.match(readme, /# Example Plugin/, "the masthead must be stamped through the dispatch path");
    assert.equal(readme.includes("stale region content"), false, "the README regions must be replaced");
  });

  test("with no manifest argument exits 1 with a framed usage error", async () => {

    await using scratch = await makeScratchRoot();

    const capture = captureStderr();
    const code = await runCli({ argv: ["prepare-chrome"], cwd: scratch.path, sourceRoot: scratch.path, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /missing required manifest argument/);
  });

  test("reports HBPU not built and exits 1 when the compiled renderer is missing", async () => {

    await using scratch = await makeScratchRoot();

    const cwd = join(scratch.path, "plugin");

    await mkdir(cwd, { recursive: true });
    await writeManifest({ manifest: BASE_MANIFEST, root: cwd });

    // The sourceRoot has no dist/docChrome.js, so the renderer's dynamic import fails and the dispatcher must frame it as the actionable not-built condition.
    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-chrome", "docChrome.mjs" ], cwd, sourceRoot: join(scratch.path, "empty"), stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /HBPU has not been built/);
  });
});

describe("CLI entry point (invoked through a symlink)", () => {

  test("runs and writes the manifest when reached through a symlink, not just by direct path", async () => {

    await using scratch = await makeScratchRoot();

    // Build a self-contained synthetic HBPU package root: a package.json with a version, a dist/ui tree to mirror (including a nested directory to prove recursive
    // copy), and a copy of THIS CLI module at dist/cli/index.ts. Copying the real source rather than symlinking to it keeps the CLI's sourceRoot resolution
    // (dirname(realpath(self))/../..) anchored inside the synthetic root, so the spawned process mirrors the synthetic dist/ui rather than HBPU's real one.
    const pkgRoot = join(scratch.path, "pkg");
    const dest = join(scratch.path, "dest");

    await mkdir(join(pkgRoot, "dist", "cli"), { recursive: true });
    await mkdir(join(pkgRoot, "dist", "ui", "views"), { recursive: true });
    await writeFile(join(pkgRoot, "package.json"), JSON.stringify({ name: "homebridge-plugin-utils", version: "9.9.9" }));
    await writeFile(join(pkgRoot, "dist", "ui", "webUi.mjs"), "webUi");
    await writeFile(join(pkgRoot, "dist", "ui", "views", "options.mjs"), "options");

    // The dispatch dynamically imports the loader renderer and the splice primitive from the package's own dist, so the synthetic package must carry them; without an
    // index.html beside the destination the stamp is a no-op, so this keeps the entry-point test focused on the symlink resolution while satisfying the dispatch.
    await writeLoaderDist(pkgRoot);

    const cliSource = fileURLToPath(new URL("./index.ts", import.meta.url));

    await cp(cliSource, join(pkgRoot, "dist", "cli", "index.ts"));

    // The symlink stands in for npm's node_modules/.bin entry: it points at the real CLI file but lives elsewhere, so the launch path (argv[1]) is the symlink
    // while the module's resolved URL is the target. That divergence is exactly what a naive path comparison fails on, and what the realpath-normalized entry check
    // handles. A direct-path invocation would never exercise it, so the symlink is required to cover the entry-point divergence.
    const binLink = join(scratch.path, "bin-link");

    await symlink(join(pkgRoot, "dist", "cli", "index.ts"), binLink);

    // Propagate only the type-stripping flag (when the test runner uses one) so the child can execute the .ts entry; never the --test / --import / coverage flags,
    // which would derail the child into a second test run. On Node versions that strip types by default the flag is absent and the child runs flagless.
    const stripFlag = process.execArgv.find((arg) => (arg === "--strip-types") || (arg === "--experimental-strip-types"));
    const childArgs = stripFlag ? [ stripFlag, binLink, "prepare-ui", dest ] : [ binLink, "prepare-ui", dest ];

    const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult) => {

      const stderrChunks: Buffer[] = [];
      const child = spawn(process.execPath, childArgs, { stdio: [ "ignore", "ignore", "pipe" ] });

      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("close", (code) => resolveResult({ code, stderr: Buffer.concat(stderrChunks).toString("utf8") }));
    });

    assert.equal(result.code, 0, "the CLI invoked through a symlink must exit 0; stderr: " + result.stderr);

    // The manifest exists only if the entry check fired (the bug was a silent no-op here) AND prepareUi resolved sourceRoot to the synthetic pkgRoot. Asserting the
    // version came from the synthetic package.json confirms both: the CLI ran, and it read the right package root.
    const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { subdir: string; version: string };

    assert.equal(manifest.version, "9.9.9", "manifest version must come from the synthetic package.json");
    assert.equal(await readFile(join(dest, manifest.subdir, "webUi.mjs"), "utf8"), "webUi", "mirrored top-level file must be present under the versioned subdir");
    assert.equal(await readFile(join(dest, manifest.subdir, "views", "options.mjs"), "utf8"), "options", "nested file must be mirrored recursively");
  });
});
