#!/usr/bin/env node
/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * cli/index.ts: The homebridge-plugin-utils command-line interface.
 */

/**
 * The homebridge-plugin-utils CLI, exposed to consumers via the `bin` field in `package.json`. A single cohesive module: the content-hash helper, the `prepareUi`,
 * `prepareDocs`, `prepareMqttDocs`, and `prepareChrome` transforms, the `runCli` dispatcher, and the entry-point execution all live here with no inter-file relative
 * VALUE imports.
 *
 * That single-file shape is deliberate, not incidental. A bin is invoked through an `npm`-managed symlink in `node_modules/.bin`; if the entry imported a sibling
 * module by relative path AT LOAD TIME, that import would resolve against the symlink's directory under symlink-preserving or copied-package layouts and fail. With
 * every runtime edge pointing only at `node:` builtins, there is nothing to fracture - the CLI runs identically whether reached directly, through a symlink, through
 * a `file:` dependency, or under `--preserve-symlinks`. The lone `import type` of the renderer's signatures is fully erased by the compiler and emits no runtime edge,
 * so it carries the SSOT types without reintroducing a load-time relative dependency; when `prepareDocs` actually needs the renderer it reaches it through a computed
 * dynamic import the dispatch site supplies, the same indirection the `hblog` bin uses.
 *
 * The module is simultaneously the executable (run via the bin) and a side-effect-free library surface (`prepareUi` / `prepareDocs` / `prepareMqttDocs` /
 * `prepareChrome` / `runCli` / `USAGE`) that the test suite imports. The entry block at the bottom only executes when this module is the program entry point,
 * detected by comparing canonicalized real paths - see its comment for why a raw path comparison is insufficient.
 *
 * @module
 */
import type { ProjectEntry, docChromeRegions, parseDocChromeManifest, parseProjectEntries, renderDevBadges, renderDocIndex, renderLogo, renderMasthead,
  renderProjects } from "../docChrome.ts";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { parseWebUiLoaderConfig, renderWebUiBootRegion } from "../webui-loader.ts";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import type { renderFeatureOptionsReference } from "../featureOptions-docs.ts";
import type { renderMqttTopicsReference } from "../mqtt-topics-docs.ts";
import type { spliceMarkedRegion } from "../doc-markdown.ts";

// Semver-shaped subdir names that {@link prepareUi} owns. Only entries matching this pattern are candidates for the stale-build sweep; anything else in the
// destination is left alone. Pattern matches `MAJOR.MINOR.PATCH` plus the optional pre-release (`-...`) and build-metadata (`+...`) segments semver permits, so a
// plugin author who happens to name a subdir `assets` or `i18n` is never at risk of having it removed. The hash-suffixed shape this CLI writes (e.g.,
// `2.0.0-abc1234567890def`) falls into the pre-release segment, so the same pattern catches any bare-semver directory left behind by a plugin author or other
// tooling, alongside this CLI's own hash-suffixed directories from prior runs.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

// Truncated SHA-256 length used for the content-hash segment of the subdir name. 16 hex chars (64 bits) put the birthday-paradox collision threshold near ~2^32
// distinct builds (a chance collision between any specific pair is 2^-64), more than sufficient for cache-busting. Matches the truncation convention modern bundlers
// (Vite, Next.js, esbuild, webpack) use for the same purpose: short enough to scan visually in a path, long enough that a chance collision between two builds is
// astronomically unlikely.
const HASH_LENGTH = 16;

/**
 * Usage banner shown on no command or an unknown command. Kept as an exported constant so tests assert against its text without
 * coupling to formatting details and so README documentation can reference it via import rather than duplicate.
 */
export const USAGE = "Usage: homebridge-plugin-utils <command> [options]\n\n" +
  "Commands:\n  prepare-ui <destination>    Mirror HBPU's webUI into the plugin's lib directory.\n" +
  "  prepare-docs <catalog-module> [--doc <path>] [--check]    Generate the Feature Options reference into the plugin's docs.\n" +
  "  prepare-mqtt <catalog-module> [--doc <path>] [--check]    Generate the MQTT topic tables into the plugin's MQTT documentation.\n" +
  "  prepare-chrome <manifest> [--root <dir>] [--check]    Stamp the doc-chrome regions (masthead, nav, badges, logo, projects) across the plugin's docs, README, " +
  "and webUI.\n";

/**
 * Compute a deterministic content hash over `root`'s file tree. Walks every file in lexicographic order of relative POSIX path so two runs against the same content
 * produce the same hash regardless of underlying filesystem ordering or the absolute path the tree sits at. Mixes both the relative path and the file bytes into
 * the hash so renames produce a different output even when content bytes are unchanged - that is the correct cache-bust semantic, since a rename is a visible
 * difference to any consumer importing the file by name.
 *
 * The null-byte (`\0`) delimiters between path and content prevent the synthetic boundary-blurring case where a long path concatenated with a short content could
 * share its hash input with a shorter path concatenated with a longer content. SHA-256's preimage resistance covers anything more contrived, but the explicit
 * delimiter is the discipline that makes the hash input unambiguous on its face.
 *
 * Returns the first {@link HASH_LENGTH} hex characters of the hash. Truncation is deliberate: full SHA-256 (64 hex chars) would bloat the URL path and the
 * filesystem display without earning meaningful collision resistance for this use case.
 *
 * @param root - The directory whose tree contents are hashed.
 *
 * @returns The truncated hex hash, suitable for use as a path segment.
 */
async function computeContentHash(root: string): Promise<string> {

  // Node's recursive readdir plus `withFileTypes: true` gives us a flat Dirent[] for the entire tree in one syscall, eliminating the manual stack-walk that
  // older Node versions required. `parentPath` is the non-deprecated way to recover each entry's directory (the `path` alias was deprecated in Node 20.12 /
  // 21.4); using it here keeps the implementation aligned with current Node idioms.
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const filePaths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();

  // Read every file's bytes in parallel, then feed them into the hasher sequentially. Parallel reads keep the I/O latency bound to the slowest single file rather
  // than the sum of all files; the sequential hash update is required because the hasher is stateful and must consume bytes in the canonical sorted order to
  // produce the same digest every run.
  const fileBytes = await Promise.all(filePaths.map(async (path) => ({ bytes: await readFile(path), path })));

  const hasher = createHash("sha256");

  for(const { bytes, path } of fileBytes) {

    // Normalize separators to POSIX form so a hash computed on a Windows build matches a hash computed on Linux for the same tree contents. The relative path
    // anchors the hash to the tree structure (not the absolute location), so the same source tree built into `/tmp/a/dist/ui` and `/var/build/b/dist/ui` produces
    // an identical hash.
    const rel = relative(root, path).split(sep).join("/");

    hasher.update(rel);
    hasher.update("\0");
    hasher.update(bytes);
    hasher.update("\0");
  }

  return hasher.digest("hex").slice(0, HASH_LENGTH);
}

/**
 * Mirror HBPU's compiled browser-side webUI into a plugin's homebridge-ui/public/lib directory under a content-hashed, version-named subdirectory. The subdir name
 * combines the package's semver version with a short content hash of `dist/ui/` (e.g., `2.0.0-abc1234567890def`), so the browser's HTTP cache invalidates
 * structurally on any content change rather than via per-file query-string hacks: the plugin's `index.html` reads the small manifest written alongside, then
 * injects a trailing-slash importmap entry that prefixes every `./lib/` import with the hashed-versioned path. Transitive imports inherit the prefix through
 * relative-URL resolution, so cache-busting reaches files the importmap never names.
 *
 * The content hash is what makes the maintainer-iteration use case work. A semver-only subdir name would stay constant across the maintainer's
 * edit/rebuild/test cycle (version doesn't bump on every save), and the browser would happily serve cached copies of the stale URLs. Hashing the tree means any
 * source change produces a different subdir name, which produces different URLs, which forces fresh fetches. Same code path serves the published-release case: a
 * release ships with a fixed hash, and every consumer fetching it sees the same URL space and caches aggressively within it.
 *
 * Operates repeatably. A re-run against unchanged source content produces the same subdir name + same contents + same manifest. Stale prior-build subdirs are
 * removed in the same pass; non-version-shaped entries in the destination are left untouched so a plugin's own files (assets, sibling tooling, README copies)
 * survive across runs.
 *
 * When the `loader` and `splice` namespaces are injected, a final step stamps the plugin's webUI script loader: the `index.html` beside the destination is read, its
 * `WEBUI LOADER CONFIG` comment parsed, the loader block rendered from that config plus this run's `libPath` and package name, and spliced into its marked region with
 * an atomic `.tmp` + rename. The step is marker-gated - no `index.html`, or no BEGIN marker, is a silent no-op - so a plugin that has not opted in, and every
 * no-injection caller, mirror exactly as before. The stamp derives from the same package name and destination the mirror used, so the two never drift.
 *
 * @param args
 * @param args.dest       - The plugin's destination directory (typically `homebridge-ui/public/lib`). Created if missing.
 * @param args.loader     - The injected webUI-loader namespace (marker constants, `parseWebUiLoaderConfig`, `renderWebUiBootRegion`). Absent = no stamp step, so the
 *                          mirror-only path and its existing tests are untouched. Supplied with `splice`, it stamps the plugin's `index.html` loader region.
 * @param args.sourceRoot - Path to HBPU's package root (the directory containing `package.json` and `dist/`). The entry block resolves this from the CLI's own
 *                          real path; tests pass a tmpdir populated with a synthetic HBPU layout.
 * @param args.splice     - The injected {@link spliceMarkedRegion} from `doc-markdown.ts` that replaces the loader's marked region. Paired with `loader`; absent =
 *                          no stamp step.
 *
 * @throws When the source has not been built (`dist/ui/` missing), the source `package.json` lacks a `version` field (or, when stamping, a `name` field), or the source
 *         `dist/ui` path exists but is not a directory; and, when stamping, propagates the parse/splice framed errors under a "mirror succeeded, stamp failed" frame.
 */
export async function prepareUi({ dest, loader, sourceRoot, splice }: {

  dest: string;
  loader?: WebUiLoaderModule;
  sourceRoot: string;
  splice?: typeof spliceMarkedRegion;
}): Promise<void> {

  const sourceUiDir = join(sourceRoot, "dist", "ui");
  const sourcePackageJson = join(sourceRoot, "package.json");

  // Validate the source side first so failures name the corrective action rather than the operation we couldn't perform. Each way the source can be wrong is
  // structurally distinct: `dist/ui` missing means HBPU hasn't been built; `package.json` missing or version-less means the package is malformed. Each surfaces
  // as a typed error with the path that diagnosed the problem.
  let sourceUiStat;

  try {

    sourceUiStat = await stat(sourceUiDir);
  } catch {

    throw new Error("HBPU has not been built: " + sourceUiDir + " is missing. Run `npm run build` in HBPU first.");
  }

  if(!sourceUiStat.isDirectory()) {

    throw new Error("HBPU source path is not a directory: " + sourceUiDir + ".");
  }

  const packageManifestRaw = await readFile(sourcePackageJson, "utf8");
  const packageManifest = JSON.parse(packageManifestRaw) as { name?: string; version?: string };
  const version = packageManifest.version;

  if(!version) {

    throw new Error("HBPU package.json at " + sourcePackageJson + " has no version field.");
  }

  // Compute the content hash before any destination work begins so the source side is fully validated and characterized before we touch the plugin's directory.
  // The subdir name combines version + hash: version stays the human-readable, operator-recognizable segment; hash supplies the change-detection that makes the
  // cache invalidation structurally complete across both maintainer-iteration and published-release use cases.
  const hash = await computeContentHash(sourceUiDir);
  const subdir = version + "-" + hash;

  // Resolve the destination to an absolute path up front so every subsequent path operation reads against the same canonical base. The destination is created via
  // `mkdir({ recursive: true })` rather than relying on `cp` to lazily create it, so the readdir-based stale-build sweep below can run against a known-extant
  // directory on every invocation (including the first run against a never-before-existing path).
  const absDest = resolve(dest);

  await mkdir(absDest, { recursive: true });

  const versionedDest = join(absDest, subdir);

  // Repeatable reset of the versioned subdir. Wipe first so the copy step always starts from a known-empty target; the same-content stability is upheld
  // by the hash being a deterministic function of the source, so re-running with unchanged content produces the same subdir name + same contents + same manifest,
  // even though the implementation re-does the work. `force: true` swallows ENOENT so a first run against an empty destination doesn't surface the missing-target
  // as an error.
  await rm(versionedDest, { force: true, recursive: true });
  await cp(sourceUiDir, versionedDest, { recursive: true });

  // Destination manifest sits at the top of `dest`, NOT inside the versioned subdir. The plugin's `index.html` reads it (with `cache: "no-store"`) to discover
  // which subdir to load from. Every manifest field serves a distinct purpose: `version` for human-readable identification, `hash` for change-detection, `subdir`
  // for the canonical "where to load from" answer that consumers reference directly without reconstructing the join. The join convention stays here in the
  // producer; if we ever change it (different delimiter, different segment order), no consumer breaks. Pretty-printed JSON because the file is human-read often
  // enough to matter (debugging sessions, README screenshots, support requests).
  await writeFile(join(absDest, "manifest.json"), JSON.stringify({ hash, subdir, version }, null, 2) + "\n");

  // Sweep stale versioned subdirs from prior runs. The semver-shape filter is the discipline that keeps the sweep narrow: anything in the destination that doesn't
  // look like a version we own (plugin's own files, sibling tools, hand-curated content) survives untouched. The current subdir is skipped here since we just
  // (re)created it above; the loop targets only OLDER builds left over from prior runs (different version, different hash, or both).
  const entries = await readdir(absDest, { withFileTypes: true });

  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name) && (entry.name !== subdir))
    .map((entry) => rm(join(absDest, entry.name), { force: true, recursive: true })));

  // Stamp the webUI script loader when the loader namespace is injected. The mirror is complete by now (subdir, manifest, sweep), so the stamp is a final overlay on
  // the plugin's index.html; without injection this is skipped entirely and the mirror-only path is unchanged. The importmap prefix derives from the mirrored package's
  // own name, so a missing name is a stamp-only precondition failure rather than a mirror one.
  if(loader && splice) {

    const packageName = packageManifest.name;

    if(!packageName) {

      throw new Error("HBPU package.json at " + sourcePackageJson + " has no name field; the webUI loader importmap prefix derives from it.");
    }

    await stampWebUiLoader({ absDest, loader, packageName, splice });
  }
}

// The subset of the `webui-loader` module the CLI reaches through a computed dynamic import at dispatch time: the marker strings, the config parser, and the boot-region
// renderer. Declaring it as an interface built from the module's own export types keeps the injected namespace in lockstep with `webui-loader.ts` without a load-time
// value import that would fracture this symlink-safe bin.
interface WebUiLoaderModule {

  readonly WEBUI_LOADER_BEGIN: string;
  readonly WEBUI_LOADER_END: string;
  readonly parseWebUiLoaderConfig: typeof parseWebUiLoaderConfig;
  readonly renderWebUiBootRegion: typeof renderWebUiBootRegion;
}

// The subset of the `featureOptions-docs` module the CLI reaches through a computed dynamic import at dispatch time: the two marker strings and the reference renderer.
// Declaring it as an interface built from the module's own export types keeps the injected namespace in lockstep with `featureOptions-docs.ts` without a load-time
// value import that would fracture this symlink-safe bin.
interface FeatureOptionsDocsModule {

  readonly FEATURE_OPTIONS_DOC_BEGIN: string;
  readonly FEATURE_OPTIONS_DOC_END: string;
  readonly renderFeatureOptionsReference: typeof renderFeatureOptionsReference;
}

// Stamp the rendered loader block into the plugin's index.html. Marker-gated and a no-op on repeat: no index.html beside the destination, or no BEGIN marker, is a
// silent skip (a plugin without a config UI, or one that has not opted into the stamped loader, is left untouched); otherwise the config comment is parsed, the block
// rendered from it plus this run's destination-relative libPath and the mirrored package's name, and spliced into the marked region with an atomic `.tmp` + rename.
// The parse and splice throw their own framed errors; a stamp-phase failure re-frames them so the message states the mirror already succeeded and only the stamp
// failed, since by this point the destination has been mirrored and only the plugin's index.html overlay remains.
async function stampWebUiLoader({ absDest, loader, packageName, splice }: {

  absDest: string;
  loader: WebUiLoaderModule;
  packageName: string;
  splice: typeof spliceMarkedRegion;
}): Promise<void> {

  const indexPath = join(dirname(absDest), "index.html");
  let html: string;

  try {

    html = await readFile(indexPath, "utf8");
  } catch {

    // No index.html beside the destination: a plugin without a custom config UI page has nothing to stamp.
    return;
  }

  // No marked region means the plugin has not opted into the stamped loader; leave its index.html untouched.
  if(!html.includes(loader.WEBUI_LOADER_BEGIN)) {

    return;
  }

  try {

    const config = loader.parseWebUiLoaderConfig(html, indexPath);

    // The destination-relative segment the manifest fetch and the importmap prefix resolve against - `"./lib/"` for the family convention - derived from the mirror's
    // own destination basename so it is correct for any destination the plugin chose.
    const libPath = "./" + basename(absDest) + "/";
    const script = loader.renderWebUiBootRegion({ bust: config.bust, entry: config.entry, libPath, packageName });
    const stamped = splice(html, script, { beginMarker: loader.WEBUI_LOADER_BEGIN, endMarker: loader.WEBUI_LOADER_END });

    await writeFile(indexPath + ".tmp", stamped, "utf8");
    await rename(indexPath + ".tmp", indexPath);
  } catch(error) {

    throw new Error("The webUI mirror succeeded but stamping the loader in " + indexPath + " failed: " + (error instanceof Error ? error.message : String(error)) + ".");
  }
}

/**
 * Regenerate a plugin's Feature Options reference by projecting its live catalog through HBPU's shared renderer and splicing the result into the plugin's doc, in
 * place between the shared `FEATURE OPTIONS:BEGIN` / `END` markers. This centralizes the read/splice/atomic-write orchestration so a plugin's `build-docs` script
 * only needs a single line invoking this subcommand instead of a bespoke `*-gendocs.ts` shim.
 *
 * Pure-by-injection on `docs` and `splice`: the renderer's own module namespace and the splice helper are passed in rather than imported statically, so this function is
 * unit-testable against the real `featureOptions-docs.ts` exports without a built `dist/`, and the CLI's single-file no-static-relative-import discipline is preserved
 * (the dispatch site reaches both through computed dynamic imports). The catalog is loaded by dynamic import of its absolute path resolved to a `file:` URL, since a bare
 * absolute path is not a valid ESM specifier on every platform. The module's required exports are validated up front so a mis-shaped catalog fails with a
 * diagnostic naming the offending module and export rather than a downstream type error inside the renderer.
 *
 * The same catalog module may OPTIONALLY export scope hooks - `describeCategoryScope` and `describeOptionScope` - that the renderer threads through to contribute
 * plugin-private scope prose (a device-scope line under a category heading, a suffix on an option's description cell). These are the annotated-plugin extension point
 * (Protect/Access); a zero-config plugin (ratgdo) exports neither and documents every option unconditionally. Each hook is validated INDEPENDENTLY: if a module exports
 * one under either name it MUST be a function, else this throws a framed diagnostic naming the module and the offending export; an absent hook is simply omitted, and
 * the renderer already treats an absent hook as "omit cleanly". Because the hooks arrive through the dynamic-imported catalog namespace (never a static relative
 * import), they preserve the bin's symlink-safe load-time edge discipline exactly as the catalog arrays do.
 *
 * One pass answers both modes. The rendered fragment is spliced into a copy of the doc in memory and the result compared with the bytes read from disk, so the answer
 * is the doc's own path when the two differ and nothing when they match. `"write"` mode then writes exactly that answer: the new contents are staged in a sibling
 * `.tmp` file and renamed over the doc, and the rename is atomic on a single filesystem, so a crash mid-write can never leave a half-spliced doc behind - the file is
 * either the prior content or the complete new content, never a truncated splice. A doc that already matches is not written at all and keeps its bytes and its
 * modification time. `"check"` mode writes nothing and returns the same answer, so a caller cannot get a clean check and a differing write.
 *
 * @param args
 * @param args.catalogModulePath - Absolute path to the plugin's compiled catalog module exporting `featureOptionCategories` (an array) and `featureOptions` (an
 *                                 object). Resolved to a `file:` URL before the dynamic import.
 * @param args.docPath           - Absolute path to the doc whose marked region is replaced (typically the plugin's `docs/FeatureOptions.md`).
 * @param args.docs              - The injected `featureOptions-docs` namespace: its two marker constants and {@link renderFeatureOptionsReference}.
 * @param args.mode              - `"write"` to write the doc when it differs, `"check"` to report without writing. Defaults to `"write"`.
 * @param args.splice            - The injected {@link spliceMarkedRegion} from `doc-markdown.ts`.
 *
 * @returns The absolute paths whose spliced content differs from the file on disk - this doc's path, or nothing. Both modes answer the same set.
 *
 * @throws When the catalog module lacks `featureOptionCategories` (or it is not an array) or `featureOptions` (or it is not a non-null object), when it exports a
 *         present-but-non-function `describeCategoryScope` or `describeOptionScope`, and propagates the splice's own framed errors when the doc's marker pair is absent
 *         or ambiguous.
 */
export async function prepareDocs({ catalogModulePath, docPath, docs, mode = "write", splice }: {

  catalogModulePath: string;
  docPath: string;
  docs: FeatureOptionsDocsModule;
  mode?: "check" | "write";
  splice: typeof spliceMarkedRegion;
}): Promise<readonly string[]> {

  // Load the catalog by dynamic import. A bare absolute filesystem path is not a portable ESM specifier (Windows drive letters in particular are mis-parsed), so we
  // convert it to a `file:` URL first - the same indirection the `hblog` bin uses to reach its sibling library from a single-file launcher. The namespace is typed with
  // the required catalog exports plus the OPTIONAL scope hooks, each `unknown` until validated below - the same honest-until-checked shape the catalog arrays
  // carry, so nothing reaches the renderer as a mis-typed value.
  const catalog = await import(pathToFileURL(catalogModulePath).href) as {
    describeCategoryScope?: unknown;
    describeOptionScope?: unknown;
    featureOptionCategories?: unknown;
    featureOptions?: unknown;
  };

  // Validate the catalog's required exports before rendering so a mis-built or wrong-module path fails with a diagnostic that names what is wrong and where,
  // rather than surfacing as an opaque type error deep inside the renderer's traversal.
  if(!Array.isArray(catalog.featureOptionCategories)) {

    throw new Error("Catalog module " + catalogModulePath + " does not export a `featureOptionCategories` array.");
  }

  if((typeof catalog.featureOptions !== "object") || (catalog.featureOptions === null)) {

    throw new Error("Catalog module " + catalogModulePath + " does not export a `featureOptions` object.");
  }

  // Validate every OPTIONAL scope hook independently. Each is present-but-must-be-a-function or absent: a present non-function is a mis-shaped catalog and fails
  // with a diagnostic naming the module and the offending export (the same framing the required exports use), while an absent hook stays `undefined` and is inert -
  // the renderer treats a missing hook as "omit cleanly", so the zero-hook path (ratgdo) is unchanged. We check before casting so the cast to the renderer's hook
  // parameter type only happens once the value is known to be callable, mirroring how the catalog arrays are cast only after their shape guard.
  if((catalog.describeCategoryScope !== undefined) && (typeof catalog.describeCategoryScope !== "function")) {

    throw new Error("Catalog module " + catalogModulePath + " exports a non-function `describeCategoryScope`.");
  }

  if((catalog.describeOptionScope !== undefined) && (typeof catalog.describeOptionScope !== "function")) {

    throw new Error("Catalog module " + catalogModulePath + " exports a non-function `describeOptionScope`.");
  }

  // Render the live catalog into the markdown fragment. The optional scope hooks are forwarded through alongside the catalog; an `undefined` hook is inert, so a
  // zero-hook catalog renders cleanly. The renderer is the single source of truth for the index, the per-category tables, and the scope prose the optional hooks
  // contribute, while this function only wires the catalog and its hooks to it. Each hook is cast to the renderer's parameter type only after its function
  // guard above, the same discipline the catalog arrays follow.
  const reference = docs.renderFeatureOptionsReference({

    categories: catalog.featureOptionCategories as Parameters<typeof docs.renderFeatureOptionsReference>[0]["categories"],
    describeCategoryScope: catalog.describeCategoryScope as Parameters<typeof docs.renderFeatureOptionsReference>[0]["describeCategoryScope"],
    describeOptionScope: catalog.describeOptionScope as Parameters<typeof docs.renderFeatureOptionsReference>[0]["describeOptionScope"],
    options: catalog.featureOptions as Parameters<typeof docs.renderFeatureOptionsReference>[0]["options"] });

  // Read the existing doc and splice the rendered fragment in place between the markers the renderer's own module names, leaving the hand-written header and intro
  // untouched. The splice throws its own framed errors on a missing or ambiguous marker pair; we let those propagate so the dispatch site frames them uniformly.
  const source = await readFile(docPath, "utf8");
  const updated = splice(source, reference, { beginMarker: docs.FEATURE_OPTIONS_DOC_BEGIN, endMarker: docs.FEATURE_OPTIONS_DOC_END });

  // The answer both modes share: the spliced document compared against the bytes it came from, never the rendered fragment on its own, since the splice frames the
  // fragment with newlines and leaves the rest of the document around it.
  const changed = (updated === source) ? [] : [docPath];

  // Atomic write: stage in a sibling temp file, then rename over the doc. A doc that already matches is skipped entirely, so its modification time survives the run.
  if((mode === "write") && (changed.length > 0)) {

    await writeFile(docPath + ".tmp", updated, "utf8");
    await rename(docPath + ".tmp", docPath);
  }

  return changed;
}

// The subset of the `mqtt-topics-docs` module the CLI reaches through a computed dynamic import at dispatch time: the four marker strings and the reference renderer.
// Declaring it as an interface built from the module's own export types keeps the injected namespace in lockstep with `mqtt-topics-docs.ts` without a load-time value
// import that would fracture this symlink-safe bin.
interface MqttTopicsDocsModule {

  readonly MQTT_PUBLISHED_DOC_BEGIN: string;
  readonly MQTT_PUBLISHED_DOC_END: string;
  readonly MQTT_SUBSCRIBED_DOC_BEGIN: string;
  readonly MQTT_SUBSCRIBED_DOC_END: string;
  readonly renderMqttTopicsReference: typeof renderMqttTopicsReference;
}

/**
 * Regenerate a plugin's MQTT topic tables by projecting its live topic catalog through HBPU's shared renderer and splicing the two results into the plugin's MQTT
 * document, in place between the shared `MQTT PUBLISHED` and `MQTT SUBSCRIBED` marker pairs. This makes the document a projection of the same declaration the
 * plugin's publish and subscribe sites read their tails from, so the two cannot drift apart.
 *
 * Pure-by-injection on `docs` and `splice` exactly as {@link prepareDocs} is: the renderer's module namespace and the splice helper are passed in rather than
 * imported statically, so this function is unit-testable against the real `mqtt-topics-docs.ts` exports without a built `dist/`, and the CLI's single-file
 * no-static-relative-import discipline is preserved. The catalog is loaded by dynamic import of its absolute path resolved to a `file:` URL, since a bare absolute
 * path is not a valid ESM specifier on every platform. Its one required export is validated up front so a mis-built or wrong-module path fails with a diagnostic
 * naming what is wrong and where.
 *
 * Both regions are spliced against the in-memory copy before a single atomic write. A document that carries the published pair but not the subscribed one therefore
 * fails on the second splice with nothing yet written, leaving the file byte-identical rather than half generated. That same pass answers both modes: the twice-spliced
 * document is compared with the bytes read from disk, so the answer is the document's own path when they differ and nothing when they match. `"write"` mode writes
 * exactly that answer, staging a sibling `.tmp` file and renaming it over the document, which is atomic on a single filesystem; a document that already matches keeps
 * its bytes and its modification time. `"check"` mode writes nothing and returns the same answer.
 *
 * @param args
 * @param args.catalogModulePath - Absolute path to the plugin's compiled catalog module exporting `mqttTopics` (an object). Resolved to a `file:` URL before the
 *                                 dynamic import.
 * @param args.docPath           - Absolute path to the document whose two marked regions are replaced (typically the plugin's `docs/MQTT.md`).
 * @param args.docs              - The injected `mqtt-topics-docs` namespace: its four marker constants and {@link renderMqttTopicsReference}.
 * @param args.mode              - `"write"` to write the document when it differs, `"check"` to report without writing. Defaults to `"write"`.
 * @param args.splice            - The injected {@link spliceMarkedRegion} from `doc-markdown.ts`.
 *
 * @returns The absolute paths whose spliced content differs from the file on disk - this document's path, or nothing. Both modes answer the same set.
 *
 * @throws When the catalog module lacks `mqttTopics` (or it is not a non-null object), propagating the renderer's own framed errors for a mis-declared catalog and
 *         the splice's framed errors when either marker pair is absent or ambiguous.
 */
export async function prepareMqttDocs({ catalogModulePath, docPath, docs, mode = "write", splice }: {

  catalogModulePath: string;
  docPath: string;
  docs: MqttTopicsDocsModule;
  mode?: "check" | "write";
  splice: typeof spliceMarkedRegion;
}): Promise<readonly string[]> {

  // Load the catalog by dynamic import, converting the absolute path to a `file:` URL first for the reason {@link prepareDocs} converts its own. The namespace is
  // typed with the one required export as `unknown` until it is validated below, so nothing reaches the renderer as a mis-typed value.
  const catalog = await import(pathToFileURL(catalogModulePath).href) as { mqttTopics?: unknown };

  if((typeof catalog.mqttTopics !== "object") || (catalog.mqttTopics === null)) {

    throw new Error("Catalog module " + catalogModulePath + " does not export an `mqttTopics` object.");
  }

  // Render both sections from one traversal. The device column travels inside the catalog under its own symbol, so there is no second export to find here and no
  // second binding that could drift - the renderer owns every check the document's shape needs and frames its own diagnostics.
  const reference = docs.renderMqttTopicsReference(catalog.mqttTopics as Parameters<typeof docs.renderMqttTopicsReference>[0]);

  // Splice both regions against the in-memory copy, then write once.
  const source = await readFile(docPath, "utf8");
  const withPublished = splice(source, reference.published, { beginMarker: docs.MQTT_PUBLISHED_DOC_BEGIN, endMarker: docs.MQTT_PUBLISHED_DOC_END });
  const updated = splice(withPublished, reference.subscribed, { beginMarker: docs.MQTT_SUBSCRIBED_DOC_BEGIN, endMarker: docs.MQTT_SUBSCRIBED_DOC_END });

  // The answer both modes share: the twice-spliced document compared against the bytes it came from, so a document already carrying both rendered tables answers empty.
  const changed = (updated === source) ? [] : [docPath];

  // Atomic write: stage in a sibling temp file, then rename over the document. A document that already matches is skipped, so its modification time survives the run.
  if((mode === "write") && (changed.length > 0)) {

    await writeFile(docPath + ".tmp", updated, "utf8");
    await rename(docPath + ".tmp", docPath);
  }

  return changed;
}

// The diagnostic thrown when the manifest's `projects` field is neither an inline array nor a { file } / { url } reference. Named so the two guard clauses in
// resolveProjects share one message rather than duplicating the string.
const PROJECTS_SOURCE_ERROR = "The manifest `projects` field must be an array, a { file } reference, or a { url } reference.";

// Parse JSON, re-throwing a parse failure as a framed error that names where the invalid JSON lives. Plain `JSON.parse` throws a bare `SyntaxError` with no source
// attribution; wrapping it keeps a malformed manifest or project list reporting the same "names the source" quality as the shape validators.
function parseJsonFramed(raw: string, describe: string): unknown {

  try {

    return JSON.parse(raw);
  } catch(error) {

    throw new Error(describe + " is not valid JSON: " + (error instanceof Error ? error.message : String(error)) + ".");
  }
}

// Load a documentation-chrome manifest, dispatching on the path's extension: a `.json` file is read and parsed as data, while any other path is dynamically
// imported as a module and its `docChrome` (or default) export taken. Both paths converge on one in-memory value the caller validates, so a plugin may author its
// manifest as a typed module or a static JSON file with no change to the mechanism. The dynamic import goes through a `file:` URL for the same portability reason
// `prepareDocs` converts the catalog path.
async function loadDocChromeManifest(manifestPath: string): Promise<unknown> {

  if(manifestPath.endsWith(".json")) {

    return parseJsonFramed(await readFile(manifestPath, "utf8"), "Doc-chrome manifest " + manifestPath);
  }

  const namespace = await import(pathToFileURL(manifestPath).href) as { default?: unknown; docChrome?: unknown };

  return namespace.docChrome ?? namespace.default;
}

// Resolve the manifest's project source to an inline array of entries. The source may be omitted (no project region is stamped), an inline array, a local file relative
// to the plugin root, or a remote URL fetched at stamp time. The remote form is what lets a family-wide project list live in one external file that every plugin's build
// pulls from, keeping this library free of any plugin-specific data. The injected `parseEntries` validates the resolved entries and returns them typed, so every
// manifest-shape check stays the single responsibility of `docChrome.ts`.
async function resolveProjects(source: unknown, { fetchImpl, manifestPath, parseEntries, pluginRoot }: {
  fetchImpl: typeof fetch;
  manifestPath: string;
  parseEntries: (value: unknown, origin: string) => readonly ProjectEntry[];
  pluginRoot: string;
}): Promise<readonly ProjectEntry[] | undefined> {

  if(source === undefined) {

    return undefined;
  }

  // An inline array is validated against the manifest path, since that is where it was authored.
  if(Array.isArray(source)) {

    return parseEntries(source, manifestPath);
  }

  if((typeof source !== "object") || (source === null)) {

    throw new Error(PROJECTS_SOURCE_ERROR);
  }

  // A remote reference is fetched at stamp time; a non-OK response is a framed error naming the URL and status. We read the body as text and parse it ourselves so a
  // malformed remote list reports through the same framed-JSON path as a local one.
  if(("url" in source) && (typeof source.url === "string")) {

    const response = await fetchImpl(source.url);

    if(!response.ok) {

      throw new Error("Failed to fetch the project list from " + source.url + ": HTTP " + String(response.status) + ".");
    }

    return parseEntries(parseJsonFramed(await response.text(), "The project list fetched from " + source.url), source.url);
  }

  // A local-file reference is read relative to the plugin root and parsed as JSON.
  if(("file" in source) && (typeof source.file === "string")) {

    const filePath = resolve(pluginRoot, source.file);

    return parseEntries(parseJsonFramed(await readFile(filePath, "utf8"), "The project list at " + filePath), filePath);
  }

  throw new Error(PROJECTS_SOURCE_ERROR);
}

// The subset of the `docChrome` module the CLI reaches through a computed dynamic import at dispatch time: the marked-region marker strings, the manifest and project
// validators, and the surface renderers. Declaring it as an interface built from the module's own export types keeps the injected namespace in lockstep with
// `docChrome.ts` without a load-time value import that would fracture this symlink-safe bin.
interface DocChromeModule {

  readonly DEV_BADGES_BEGIN: string;
  readonly DEV_BADGES_END: string;
  readonly DOCUMENTATION_BEGIN: string;
  readonly DOCUMENTATION_END: string;
  readonly LOGO_BEGIN: string;
  readonly LOGO_END: string;
  readonly MASTHEAD_BEGIN: string;
  readonly MASTHEAD_END: string;
  readonly PROJECTS_BEGIN: string;
  readonly PROJECTS_END: string;
  readonly docChromeRegions: typeof docChromeRegions;
  readonly parseDocChromeManifest: typeof parseDocChromeManifest;
  readonly parseProjectEntries: typeof parseProjectEntries;
  readonly renderDevBadges: typeof renderDevBadges;
  readonly renderDocIndex: typeof renderDocIndex;
  readonly renderLogo: typeof renderLogo;
  readonly renderMasthead: typeof renderMasthead;
  readonly renderProjects: typeof renderProjects;
}

/**
 * Stamp a plugin's documentation-chrome regions - the masthead, the documentation index, the dashboard badges, and the project list - across its README, every content
 * doc, and its webUI Support tab, from one per-plugin manifest. This is the multi-region, multi-file counterpart to {@link prepareDocs}: where that regenerates one
 * feature-options region in one doc, this regenerates several named regions in many files, so a plugin's masthead and navigation cannot drift between the surfaces that
 * repeat them.
 *
 * Pure-by-injection like {@link prepareDocs}: the `docChrome` renderers and validator arrive through the injected `chrome` namespace and the splice helper through
 * `splice`, so this function is unit-testable against the real exports without a built `dist/`, and the CLI's single-file no-static-relative-import discipline is
 * preserved. `fetchImpl` is injected (defaulting to the global `fetch`) so the remote project-source path is testable without network access.
 *
 * The manifest is loaded (a typed module or a static JSON file), validated with a field-naming diagnostic, and its optional project source resolved to inline data. The
 * per-file edit plan is then built - the README carries the masthead, the documentation index, and the dashboard badges; each content doc carries whichever regions
 * `docChromeRegions` plans for its entry; the webUI, when present, carries the documentation index, the logo, and the project list. Every region is spliced against its
 * own marker pair through the shared, ambiguity-rejecting splice primitive.
 *
 * The write is all-or-nothing across files in the realistic failure mode. Splicing happens entirely in memory first, so a missing or ambiguous marker in any file
 * aborts the run before a single write. That same pass answers both modes by comparing each target's spliced content with the bytes it was read from: `"write"` mode
 * writes exactly the targets that differ, in two phases - each one's new content staged in a sibling `.tmp`, and only once all temps exist are they renamed over their
 * targets, so a staging failure leaves every original untouched and each promotion is an atomic rename - while `"check"` mode writes nothing and returns the same set.
 * A target already carrying its rendered regions is never staged, so it keeps its bytes and its modification time, and a run over an unchanged tree touches no file.
 *
 * @param args
 * @param args.chrome       - The injected `docChrome` module namespace (its renderers, marker constants, region planner, and validators).
 * @param args.fetchImpl    - The `fetch` implementation used to resolve a remote project source. Defaults to the global `fetch`; tests inject a fake.
 * @param args.manifestPath - Absolute path to the plugin's manifest - a compiled module or a `.json` file.
 * @param args.mode         - `"write"` to write the targets that differ, `"check"` to report them without writing. Defaults to `"write"`.
 * @param args.pluginRoot   - Absolute path to the plugin root that the manifest's surface and file references resolve against.
 * @param args.splice       - The injected {@link spliceMarkedRegion} from `doc-markdown.ts`.
 *
 * @returns The absolute paths of every planned target whose spliced content differs from the file on disk. Both modes answer the same set.
 *
 * @throws When the manifest is mis-shaped, when a resolved project source is malformed, when a target file cannot be read, or when any region's marker pair is absent or
 *         ambiguous - propagating the splice's own framed errors so the dispatch site frames them uniformly.
 */
export async function prepareChrome({ chrome, fetchImpl = fetch, manifestPath, mode = "write", pluginRoot, splice }: {

  chrome: DocChromeModule;
  fetchImpl?: typeof fetch;
  manifestPath: string;
  mode?: "check" | "write";
  pluginRoot: string;
  splice: typeof spliceMarkedRegion;
}): Promise<readonly string[]> {

  const { DEV_BADGES_BEGIN, DEV_BADGES_END, DOCUMENTATION_BEGIN, DOCUMENTATION_END, LOGO_BEGIN, LOGO_END, MASTHEAD_BEGIN, MASTHEAD_END, PROJECTS_BEGIN, PROJECTS_END,
    docChromeRegions, parseDocChromeManifest, parseProjectEntries, renderDevBadges, renderDocIndex, renderLogo, renderMasthead, renderProjects } = chrome;

  // Load and validate the manifest up front so a mis-shaped manifest fails with a diagnostic naming the offending field rather than a downstream render error. Parsing
  // returns the same value typed as a validated manifest, so every field access below is type-checked.
  const manifest = parseDocChromeManifest(await loadDocChromeManifest(manifestPath), manifestPath);

  // Resolve the optional project source to inline data before rendering; the renderers never perform I/O.
  const projects = await resolveProjects(manifest.projects, { fetchImpl, manifestPath, parseEntries: parseProjectEntries, pluginRoot });

  // Build the per-file edit plan. Each target file collects the ordered marked-region splices that apply to it; a file may carry more than one region - the
  // README carries the masthead, the documentation index, and, when declared, the dashboard badges - each spliced independently against its own marker pair.
  const plan = new Map<string, { begin: string; content: string; end: string }[]>();

  const addRegion = (path: string, begin: string, end: string, content: string): void => {

    const edits = plan.get(path) ?? [];

    edits.push({ begin, content, end });
    plan.set(path, edits);
  };

  // The README: the masthead, the documentation index, and - when declared - the dashboard badges.
  const readmePath = resolve(pluginRoot, manifest.surfaces?.readme ?? "README.md");

  addRegion(readmePath, MASTHEAD_BEGIN, MASTHEAD_END, renderMasthead(manifest));
  addRegion(readmePath, DOCUMENTATION_BEGIN, DOCUMENTATION_END, renderDocIndex({ manifest, surface: "readme" }));

  if((manifest.devBadges !== undefined) && (manifest.devBadges.length > 0)) {

    addRegion(readmePath, DEV_BADGES_BEGIN, DEV_BADGES_END, renderDevBadges(manifest));
  }

  // Each content doc: whichever regions the manifest entry plans for. A file that plans for neither - the changelog is the canonical case - receives no stamped regions
  // at all while remaining listed in every documentation index.
  for(const section of manifest.nav) {

    for(const entry of section.entries) {

      if(entry.kind !== "doc") {

        continue;
      }

      const docPath = resolve(pluginRoot, entry.file);
      const regions = docChromeRegions(entry);

      if(regions.masthead) {

        addRegion(docPath, MASTHEAD_BEGIN, MASTHEAD_END, renderMasthead(manifest));
      }

      if(regions.documentation) {

        addRegion(docPath, DOCUMENTATION_BEGIN, DOCUMENTATION_END, renderDocIndex({ currentFile: entry.file, manifest, surface: "doc-footer" }));
      }
    }
  }

  // The webUI Support tab is optional: a plugin without a custom config UI has no target to stamp, so we include its regions only when the file exists. The
  // documentation index and the logo are always stamped there; the project list only when a source resolved. Each of those regions needs its own marker pair present in
  // the page, so a page is either authored with every pair it is planned for or the run fails naming the one it lacks.
  const webuiPath = resolve(pluginRoot, manifest.surfaces?.webui ?? "homebridge-ui/public/index.html");
  let webuiExists = true;

  try {

    await stat(webuiPath);
  } catch(error) {

    // A missing webUI is expected for a plugin without a custom config UI; any other stat failure (a permissions error, say) is a genuine problem we must surface rather
    // than silently treat as "no webUI".
    if((error instanceof Error) && ("code" in error) && (error.code === "ENOENT")) {

      webuiExists = false;
    } else {

      throw error;
    }
  }

  if(webuiExists) {

    addRegion(webuiPath, DOCUMENTATION_BEGIN, DOCUMENTATION_END, renderDocIndex({ manifest, surface: "webui" }));
    addRegion(webuiPath, LOGO_BEGIN, LOGO_END, renderLogo(manifest));

    if(projects !== undefined) {

      addRegion(webuiPath, PROJECTS_BEGIN, PROJECTS_END, renderProjects(projects));
    }
  }

  // Validate-all: read each target and splice every region in memory. Splicing validates each marker pair, so a missing, inverted, or duplicated marker anywhere aborts
  // the whole run here - before any file is written - rather than leaving a partial stamp behind.
  const staged = await Promise.all([...plan].map(async ([ path, edits ]) => {

    let source: string;

    try {

      source = await readFile(path, "utf8");
    } catch {

      throw new Error("Target file " + path + " could not be read; ensure it exists and carries the required markers.");
    }

    let content = source;

    // Splice each region against its own marker pair; a malformed marker throws, rejecting the whole collection (per the validate-all note above).
    for(const edit of edits) {

      content = splice(content, edit.content, { beginMarker: edit.begin, endMarker: edit.end });
    }

    return { content, path, source };
  }));

  // The answer both modes share: the planned targets whose spliced content differs from the bytes they were read from. Computing it once here is what makes a clean
  // check and a differing write impossible to observe, and it is the whole of the work in check mode.
  const differing = staged.filter(({ content, source }) => content !== source);
  const changed = differing.map(({ path }) => path);

  if(mode === "check") {

    return changed;
  }

  // Write-all in two phases for strong cross-file atomicity, over the differing targets alone. Stage each one's new content in a sibling `.tmp` first; if any staging
  // write fails, remove the temps already written and abort with every original untouched. Only once all temps exist do we rename them over their targets, so the
  // promotion phase - a set of atomic renames - cannot leave a half-spliced file behind. An empty set stages nothing and renames nothing.
  const tmpPaths = changed.map((path) => path + ".tmp");

  try {

    await Promise.all(differing.map(({ content, path }) => writeFile(path + ".tmp", content, "utf8")));
  } catch(error) {

    await Promise.all(tmpPaths.map((tmpPath) => rm(tmpPath, { force: true })));

    throw error;
  }

  try {

    await Promise.all(changed.map((path) => rename(path + ".tmp", path)));
  } catch(error) {

    // A rename-phase failure is rare - every temp staged successfully - but it can leave some targets promoted and others not. Best-effort remove any temp that survives
    // so a failed run does not litter the tree; the already-promoted targets are left as they are, since their content is the intended new content.
    await Promise.all(tmpPaths.map((tmpPath) => rm(tmpPath, { force: true })));

    throw error;
  }

  return changed;
}

/* Report a check's answer and the exit code it implies: one full sentence per target whose content would change, framed under the verb exactly as every other
 * diagnostic this file writes is, and `1` when any target would change. An empty answer writes nothing and returns `0`, so a documentation tree that is already what
 * the verbs would produce passes silently. Shared by the docs verbs so the line's wording has one home rather than one copy per verb.
 */
function reportCheck(verb: string, changed: readonly string[], stderr: { write: (chunk: string) => unknown }): number {

  for(const path of changed) {

    stderr.write("homebridge-plugin-utils " + verb + ": " + path + " is out of date.\n");
  }

  return (changed.length > 0) ? 1 : 0;
}

/**
 * Run the CLI against a synthetic argv vector. Returns the process exit code that the entry block propagates. Pure-by-injection: takes its `cwd`, `stderr`, and
 * `sourceRoot` as arguments rather than reading them from globals, so tests exercise the full dispatch path against a captured stderr, a tmpdir source root, and a
 * tmpdir working directory without ever touching `process.exit` or the real filesystem outside the tmpdir scope.
 *
 * @param args
 * @param args.argv       - Positional and flag arguments (typically `process.argv.slice(2)`).
 * @param args.cwd        - The working directory that relative subcommand path arguments resolve against. Production passes `process.cwd()`; tests pass a tmpdir.
 * @param args.sourceRoot - Path to HBPU's package root (resolved from the CLI's real path by the entry block; tests pass a tmpdir).
 * @param args.stderr     - Stream-like sink for usage and error output. Production passes `process.stderr`; tests pass a captured-output collector.
 *
 * @returns The exit code: `0` on success or on an explicit no-arg invocation showing the usage banner, `1` on misuse or subcommand failure.
 */
export async function runCli({ argv, cwd, sourceRoot, stderr }: {

  argv: readonly string[];
  cwd: string;
  sourceRoot: string;
  stderr: { write: (chunk: string) => unknown };
}): Promise<number> {

  // parseArgs runs in strict mode, so an unrecognized flag (e.g. a typo'd `--docs`) throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` here rather than falling through to the
  // usage banner. That throw is intentionally uncaught - the per-case try/catch blocks below wrap only the subcommand work - so it surfaces as a rejected `runCli`
  // promise at the entry point, distinct from the default case's banner handling for an unknown positional command.
  const { positionals, values } = parseArgs({ allowPositionals: true, args: [...argv],
    options: { check: { type: "boolean" }, doc: { type: "string" }, root: { type: "string" } }, strict: true });
  const [ command, ...rest ] = positionals;

  // The docs verbs share one mode: `--check` renders and compares every target it would write and reports instead of writing, which is the whole docs gate in
  // one invocation per verb. `prepare-ui` mirrors a directory rather than splicing a document, so it has no target set to answer and ignores the flag.
  const mode = values.check ? "check" : "write";

  switch(command) {

    case "prepare-ui": {

      const [destination] = rest;

      if(!destination) {

        stderr.write("homebridge-plugin-utils prepare-ui: missing required destination argument.\n");

        return 1;
      }

      // Reach HBPU's own loader renderer and the splice primitive through computed dynamic imports of their compiled modules - never static relative imports - so the
      // single-file bin stays symlink-safe. A dist complete enough to mirror `dist/ui` yet missing these is a build inconsistency that must fail loudly rather than
      // silently skip the wanted stamp, exactly as prepare-docs hard-fails on its own missing renderer.
      const loaderPath = join(sourceRoot, "dist", "webui-loader.js");
      const uiSplicePath = join(sourceRoot, "dist", "doc-markdown.js");

      let loader: WebUiLoaderModule;
      let uiSplicer: { spliceMarkedRegion: typeof spliceMarkedRegion };

      try {

        loader = await import(pathToFileURL(loaderPath).href) as WebUiLoaderModule;
        uiSplicer = await import(pathToFileURL(uiSplicePath).href) as typeof uiSplicer;
      } catch {

        stderr.write("homebridge-plugin-utils prepare-ui: HBPU has not been built: " + loaderPath + " or " + uiSplicePath + " is missing. Run `npm run build` in " +
          "HBPU first.\n");

        return 1;
      }

      try {

        await prepareUi({ dest: destination, loader, sourceRoot, splice: uiSplicer.spliceMarkedRegion });
      } catch(error) {

        stderr.write("homebridge-plugin-utils prepare-ui: " + (error instanceof Error ? error.message : String(error)) + "\n");

        return 1;
      }

      return 0;
    }

    case "prepare-docs": {

      const [catalogArg] = rest;

      if(!catalogArg) {

        stderr.write("homebridge-plugin-utils prepare-docs: missing required catalog-module argument.\n");

        return 1;
      }

      // Resolve both paths against the injected working directory. The catalog argument is the plugin's compiled options module; the doc defaults to the family's
      // canonical `docs/FeatureOptions.md` and is overridable through `--doc` for a plugin that ships its reference elsewhere.
      const catalogModulePath = resolve(cwd, catalogArg);
      const docPath = resolve(cwd, values.doc ?? "docs/FeatureOptions.md");

      // Reach HBPU's own renderer and the splice primitive through computed dynamic imports of their compiled modules - never static relative imports - so the
      // single-file bin stays symlink-safe (it imports only `node:` builtins at load time). A failed import here means HBPU itself has not been built, which is a
      // distinct, actionable condition from a downstream render/splice failure, so we frame it separately and point at the corrective action.
      const rendererPath = join(sourceRoot, "dist", "featureOptions-docs.js");
      const splicePath = join(sourceRoot, "dist", "doc-markdown.js");

      let renderer: FeatureOptionsDocsModule;
      let splicer: { spliceMarkedRegion: typeof spliceMarkedRegion };

      try {

        renderer = await import(pathToFileURL(rendererPath).href) as FeatureOptionsDocsModule;
        splicer = await import(pathToFileURL(splicePath).href) as typeof splicer;
      } catch {

        stderr.write("homebridge-plugin-utils prepare-docs: HBPU has not been built: " + rendererPath + " or " + splicePath + " is missing. Run `npm run build` in " +
          "HBPU first.\n");

        return 1;
      }

      try {

        const changed = await prepareDocs({ catalogModulePath, docPath, docs: renderer, mode, splice: splicer.spliceMarkedRegion });

        if(mode === "check") {

          return reportCheck("prepare-docs", changed, stderr);
        }
      } catch(error) {

        stderr.write("homebridge-plugin-utils prepare-docs: " + (error instanceof Error ? error.message : String(error)) + "\n");

        return 1;
      }

      return 0;
    }

    case "prepare-mqtt": {

      const [catalogArg] = rest;

      if(!catalogArg) {

        stderr.write("homebridge-plugin-utils prepare-mqtt: missing required catalog-module argument.\n");

        return 1;
      }

      // Resolve both paths against the injected working directory. The catalog argument is the plugin's compiled topics module; the document defaults to the
      // family's canonical `docs/MQTT.md` and is overridable through `--doc` for a plugin that ships its tables elsewhere.
      const catalogModulePath = resolve(cwd, catalogArg);
      const docPath = resolve(cwd, values.doc ?? "docs/MQTT.md");

      // Reach HBPU's own renderer and the splice primitive through computed dynamic imports of their compiled modules - never static relative imports - so the
      // single-file bin stays symlink-safe. A failed import means HBPU itself has not been built, a distinct and actionable condition from a downstream failure.
      const docsPath = join(sourceRoot, "dist", "mqtt-topics-docs.js");
      const splicePath = join(sourceRoot, "dist", "doc-markdown.js");

      let docs: MqttTopicsDocsModule;
      let splicer: { spliceMarkedRegion: typeof spliceMarkedRegion };

      try {

        docs = await import(pathToFileURL(docsPath).href) as MqttTopicsDocsModule;
        splicer = await import(pathToFileURL(splicePath).href) as typeof splicer;
      } catch {

        stderr.write("homebridge-plugin-utils prepare-mqtt: HBPU has not been built: " + docsPath + " or " + splicePath + " is missing. Run `npm run build` in " +
          "HBPU first.\n");

        return 1;
      }

      try {

        const changed = await prepareMqttDocs({ catalogModulePath, docPath, docs, mode, splice: splicer.spliceMarkedRegion });

        if(mode === "check") {

          return reportCheck("prepare-mqtt", changed, stderr);
        }
      } catch(error) {

        stderr.write("homebridge-plugin-utils prepare-mqtt: " + (error instanceof Error ? error.message : String(error)) + "\n");

        return 1;
      }

      return 0;
    }

    case "prepare-chrome": {

      const [manifestArg] = rest;

      if(!manifestArg) {

        stderr.write("homebridge-plugin-utils prepare-chrome: missing required manifest argument.\n");

        return 1;
      }

      // Resolve the manifest path and the plugin root that the manifest's surface and file references resolve against. The root defaults to the working directory.
      const manifestPath = resolve(cwd, manifestArg);
      const pluginRoot = resolve(cwd, values.root ?? ".");

      // Reach HBPU's own doc-chrome renderers and the splice primitive through computed dynamic imports of their compiled modules - never static relative imports - so
      // the single-file bin stays symlink-safe. A failed import means HBPU itself has not been built, a distinct and actionable condition from a downstream failure.
      const chromePath = join(sourceRoot, "dist", "docChrome.js");
      const splicePath = join(sourceRoot, "dist", "doc-markdown.js");

      let chrome: DocChromeModule;
      let splicer: { spliceMarkedRegion: typeof spliceMarkedRegion };

      try {

        chrome = await import(pathToFileURL(chromePath).href) as DocChromeModule;
        splicer = await import(pathToFileURL(splicePath).href) as typeof splicer;
      } catch {

        stderr.write("homebridge-plugin-utils prepare-chrome: HBPU has not been built: " + chromePath + " or " + splicePath + " is missing. Run `npm run build` in " +
          "HBPU first.\n");

        return 1;
      }

      try {

        const changed = await prepareChrome({ chrome, manifestPath, mode, pluginRoot, splice: splicer.spliceMarkedRegion });

        if(mode === "check") {

          return reportCheck("prepare-chrome", changed, stderr);
        }
      } catch(error) {

        stderr.write("homebridge-plugin-utils prepare-chrome: " + (error instanceof Error ? error.message : String(error)) + "\n");

        return 1;
      }

      return 0;
    }

    default: {

      stderr.write(USAGE);

      // A bare `homebridge-plugin-utils` invocation (no command at all) is treated as a help request and exits 0; an unknown command is a misuse and exits 1. Both
      // write the usage banner so the user sees the same prompt either way - only the exit code differentiates.
      return command ? 1 : 0;
    }
  }
}

/**
 * Decide whether this module is the program entry point (run as the bin) versus imported as a library (by the test suite). Canonicalizes the real path of both the
 * launch path (`process.argv[1]`) and this module's own URL before comparing them.
 *
 * The realpath normalization is the detail that matters. npm exposes a bin as a symlink in `node_modules/.bin`, so under default Node the launch path is the
 * symlink while `import.meta.url` is the resolved target - a raw string comparison never matches and the CLI silently does nothing. Canonicalizing both sides
 * collapses that indirection (and any `file:`-dependency, copied-package, or `--preserve-symlinks` layout) to a single real path, so the check holds however the
 * launcher reached this file. We keep this explicit realpath comparison rather than deferring to `import.meta.main`: the symlink and copied-package indirection is the
 * concern the entry-point check exists to handle, and resolving it explicitly keeps that handling visible at the call site.
 *
 * @returns `true` when invoked as the program entry, `false` when imported or when the launch path cannot be resolved.
 */
function isEntryPoint(): boolean {

  const entryPath = process.argv[1];

  if(!entryPath) {

    return false;
  }

  try {

    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {

    // A realpath throws only when a path does not resolve on disk - not a state a genuine entry-point invocation reaches, so treat it as "not the entry."
    return false;
  }
}

// Execute the CLI when this module is the program entry point. When imported by the test suite instead, `isEntryPoint()` is false and the module exposes
// `prepareUi` / `prepareDocs` / `prepareMqttDocs` / `prepareChrome` / `runCli` / `USAGE` as a side-effect-free library surface.
if(isEntryPoint()) {

  // Resolve HBPU's package root from this file's real location. The compiled CLI sits at `dist/cli/index.js`; walking two segments up from its real directory
  // reaches the package root regardless of how the package is installed (a plugin's `node_modules`, a workspace symlink, a global install) or which Node
  // symlink-resolution mode is in effect - the realpath has already collapsed any indirection.
  const sourceRoot = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "..");

  process.exit(await runCli({ argv: process.argv.slice(2), cwd: process.cwd(), sourceRoot, stderr: process.stderr }));
}
