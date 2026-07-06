/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * cli/index.test.ts: Unit tests for the CLI module. Four test surfaces: the pure {@link prepareUi} transform (content-hashed mirror semantics, manifest shape,
 * stale-build cleanup, preservation of non-version entries, source-side validation), the pure {@link prepareDocs} transform (catalog validation, scope-hook
 * forwarding, atomic-write marker splicing), the {@link runCli} dispatcher (argument routing, exit codes, usage banner), and the entry-point execution invoked
 * through a symlink (the real bin invocation path that a direct-path test never exercises). Every surface but the last runs against AsyncDisposable tmpdir
 * scratch roots and `process.stderr` capture helpers; the entry-point test alone spawns the CLI as a subprocess through a symlink. No test touches a real install
 * or modifies the working tree.
 */
import { FEATURE_OPTIONS_DOC_BEGIN, FEATURE_OPTIONS_DOC_END, renderFeatureOptionsReference, spliceMarkedRegion } from "../featureOptions-docs.ts";
import { USAGE, prepareDocs, prepareUi, runCli } from "./index.ts";
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

  test("replaces the marked region with the rendered reference, idempotently, leaving surrounding prose intact", async () => {

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
    // idempotent, so a second pass is a no-op. This is the property the plugin's build-docs script relies on to stay diff-free across rebuilds.
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

    // The export exists but is the wrong shape (an object, not an array). Array.isArray is the discriminant, so a non-array value is rejected the same way an absent
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

    // Source root exists but has no dist/ui - prepareUi will throw with the corrective-action message, and the dispatcher should surface it on stderr rather than
    // letting the rejection escape unhandled.
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ version: "2.0.0" }));

    const capture = captureStderr();
    const code = await runCli({ argv: [ "prepare-ui", dest ], cwd: sourceRoot, sourceRoot, stderr: capture.stderr });

    assert.equal(code, 1);
    assert.match(capture.chunks(), /HBPU has not been built/);
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
