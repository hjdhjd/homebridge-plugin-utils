/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/runtime-floor.ts: The shared machinery behind an engines-keyed conformance guard - read the floor, decide the regime, sweep the source, fire the sunset.
 */

/**
 * The shared machinery behind an engines-keyed conformance guard.
 *
 * A package that works around a platform gap carries a debt: the workaround has to disappear when the gap closes, and nobody remembers to look. The guard suite is the
 * mechanism that remembers. It reads the package's own declared `engines.node` floor, decides from it whether the workaround is still owed, sweeps the shipped source to
 * confirm the workaround is actually applied everywhere it must be, and - the moment the floor reaches the release that closes the gap - fails with an enumerated
 * cleanup checklist instead of quietly continuing to pass.
 *
 * Every plugin in the family runs that same suite against a different workaround, and what varies between them is narrower than it looks: which major closes the gap,
 * which files to skip, what the checklist says, and what each one's own detectors look for. What does not vary is everything below. The regime decision, the engines
 * read, the source walk, and the sunset canary are one implementation here rather than a fourth hand-rolled copy per repository.
 *
 * What deliberately stays with the consumer is the policy: the patterns its sweep looks for, the predicates that decide whether a matching file is compliant, and the
 * artifact list its checklist enumerates. Those are the thing being guarded, not the guarding, and hoisting a domain's own detectors into domain-generic machinery
 * would couple every consumer to every other consumer's workaround.
 *
 * One authoring rule binds this module and everything else under `src/testing/`: the directory is shipped source, so a consumer's own sweep walks it. Prose here must
 * therefore describe what a detector looks for without reproducing text a detector would match, or a shipped module trips the very guard it exists to serve.
 *
 * @module
 */
import { basename, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The file shapes that are never shipped source: a suite, its shared code, its shared data. The trio matches the exclusion globs a package's build tsconfig already
// applies, so the sweep's notion of "shipped" and the compiler's stay one definition rather than two that can drift. It is fixed rather than a parameter because all
// three real consumers define shipped source exactly this way; a consumer that needs to skip more reaches for `skipBasenames`.
const NON_SHIPPED_SUFFIXES = [ ".fixtures.ts", ".helpers.ts", ".test.ts" ];

/**
 * One shipped source file as the sweep read it: where it lives and what it says. Fields are `readonly` because a sweep result is a snapshot for predicates to read, and
 * nothing downstream has any business editing it.
 *
 * @category Testing
 */
export interface SweptFile {

  /**
   * The file's absolute filesystem path, suitable for a failure message and for an `endsWith` check against a known location.
   */
  readonly path: string;

  /**
   * The file's full text, as UTF-8.
   */
  readonly text: string;
}

/**
 * The regime an `engines.node` floor selects, and the major version it was read from.
 *
 * @category Testing
 */
export interface RuntimeFloor {

  /**
   * The Node major version parsed out of the range.
   */
  readonly major: number;

  /**
   * `"compat"` while the floor sits below the release that closes the gap, so the workaround is still owed. `"sunset"` at or above it, so the workaround must go.
   */
  readonly regime: "compat" | "sunset";
}

/**
 * What the guard does about the floor it just read: sweep the source, or fail with the cleanup checklist.
 *
 * The two arms are one value rather than a regime beside an optional message, because a regime that is not the sunset arm has no message to carry and pairing them as
 * independent parameters would make that combination expressible. Here it is not: only the sunset arm has a `message` field at all.
 *
 * @category Testing
 */
export type RuntimeFloorPlan = { readonly kind: "sunset"; readonly message: string } | { readonly kind: "sweep" };

/**
 * What {@link parseRuntimeFloor} needs: the declared range, and the major that closes the gap.
 *
 * @category Testing
 */
export interface RuntimeFloorQuery {

  /**
   * The package's declared `engines.node` range, in any of the forms a package.json carries (`">=22.20"`, `"^24"`, `">=24.0.0"`).
   */
  readonly enginesNode: string;

  /**
   * The Node major at or above which the workaround is redundant and the sunset is due. This is the consumer's own policy - each guard works around a different gap
   * that closed in a different release - so it is a parameter rather than a constant here.
   */
  readonly sunsetMajor: number;
}

/**
 * What {@link planRuntimeFloorCheck} needs: everything {@link parseRuntimeFloor} needs, plus the checklist to fail with when the sunset comes due.
 *
 * @category Testing
 */
export interface RuntimeFloorPlanQuery extends RuntimeFloorQuery {

  /**
   * The enumerated cleanup the sunset arm carries. Compose it from the artifact list with {@link composeSunsetCleanup} when the checklist is list-shaped, so the message
   * and the fragments a test looks for cannot drift apart; write it by hand when it is prose.
   */
  readonly sunsetMessage: string;
}

/**
 * What {@link composeSunsetCleanup} assembles a checklist from.
 *
 * @category Testing
 */
export interface SunsetCleanupFrame {

  /**
   * Every artifact the sunset removes or restores, each naming a distinct path. Keeping them distinct is what lets a test assert the message enumerates all of them: a
   * fragment contained inside another would be satisfied by a message that named only the longer one.
   */
  readonly artifacts: readonly string[];

  /**
   * Text appended after the list - the trailing steps that are not deletions of a listed artifact, or simply the closing punctuation. Defaults to the empty string.
   */
  readonly epilogue?: string;

  /**
   * Text placed before the list, ending at the point the list should begin.
   */
  readonly prologue: string;

  /**
   * What joins the artifacts. Defaults to `", "`; a checklist whose entries contain commas of their own wants `"; "`.
   */
  readonly separator?: string;
}

/**
 * What {@link sweepSourceFiles} walks.
 *
 * @category Testing
 */
export interface SourceSweep {

  /**
   * The directories to walk, as URLs. Every real consumer derives its root from `import.meta.url`, so taking URLs lets the caller pass `new URL(".", import.meta.url)`
   * directly and keeps the path conversion in one place instead of at each call site.
   */
  readonly roots: readonly URL[];

  /**
   * File basenames to leave out of the walk beyond the never-shipped suffixes - a module the guard's own rule cannot sensibly be applied to. Defaults to none.
   */
  readonly skipBasenames?: readonly string[];
}

/**
 * Read the Node major out of an `engines.node` range and decide which regime it selects.
 *
 * The first run of digits is the major, which is the reading every range form a package.json carries agrees on (`">=22.20"`, `"^24"`, `">=24.0.0"`). A range with no
 * digits at all is a hard failure rather than a silent default, because a guard that quietly assumed a regime would be a guard that quietly stopped guarding.
 *
 * @param query - See {@link RuntimeFloorQuery}.
 *
 * @returns The parsed major and the regime it selects.
 *
 * @throws `Error` naming the offending value when no major version can be read from it.
 *
 * @category Testing
 */
export function parseRuntimeFloor(query: RuntimeFloorQuery): RuntimeFloor {

  const digits = /(\d+)/.exec(query.enginesNode)?.[0];

  if(digits === undefined) {

    throw new Error("Unable to parse a Node major version from the engines.node value: " + JSON.stringify(query.enginesNode) + ".");
  }

  const major = Number(digits);

  return { major, regime: (major >= query.sunsetMajor) ? "sunset" : "compat" };
}

/**
 * Map an `engines.node` range to what the guard should do about it: fail with the cleanup checklist, or run the source sweep.
 *
 * Both arms run on every suite that drives this synthetically as well as live - a guard feeds it a sunset-regime range and a compat-regime range alongside the real
 * package's own value - so the firing path is exercised rather than left as dead code a replica claims to cover.
 *
 * @param query - See {@link RuntimeFloorPlanQuery}.
 *
 * @returns The sunset arm carrying the checklist, or the sweep arm.
 *
 * @category Testing
 */
export function planRuntimeFloorCheck(query: RuntimeFloorPlanQuery): RuntimeFloorPlan {

  if(parseRuntimeFloor(query).regime === "sunset") {

    return { kind: "sunset", message: query.sunsetMessage };
  }

  return { kind: "sweep" };
}

/**
 * The canary. Fail the calling test with the enumerated checklist when the plan says the sunset has come due, and do nothing at all when it has not.
 *
 * This consumes the plan as one value rather than taking a regime and a message side by side, so there is no way to ask it to fire without giving it something to say.
 *
 * @param plan - The plan {@link planRuntimeFloorCheck} produced.
 *
 * @throws `AssertionError` carrying the cleanup checklist when the plan is the sunset arm.
 *
 * @category Testing
 */
export function assertRuntimeFloorCompat(plan: RuntimeFloorPlan): void {

  if(plan.kind === "sunset") {

    assert.fail(plan.message);
  }
}

/**
 * Assemble a cleanup checklist from the artifact list it enumerates.
 *
 * Composing the message from the same array a test asserts the fragments of is the point: the checklist and the fragments cannot drift apart, because there is only one
 * list. A guard whose checklist is prose rather than a list skips this and writes its message directly.
 *
 * @param frame - See {@link SunsetCleanupFrame}.
 *
 * @returns The composed checklist.
 *
 * @category Testing
 */
export function composeSunsetCleanup(frame: SunsetCleanupFrame): string {

  const { artifacts, epilogue = "", prologue, separator = ", " } = frame;

  return prologue + artifacts.join(separator) + epilogue;
}

/**
 * Read a package's declared `engines.node`, given the package's root directory.
 *
 * The root is a parameter and not derived from this module's own location, which is the whole reason this reader can be shared: a hoisted copy that pathed relative to
 * itself would read this library's package.json from inside every consumer that called it, and quietly guard the wrong floor.
 *
 * @param packageRoot - The consuming package's root directory, as a URL. A guard suite sitting in `src/` passes `new URL("../", import.meta.url)`.
 *
 * @returns The declared range.
 *
 * @throws `Error` when the package.json has no `engines.node` string.
 *
 * @category Testing
 */
export async function readEnginesNode(packageRoot: URL): Promise<string> {

  const packageJson = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8")) as { engines?: { node?: unknown } };
  const enginesNode = packageJson.engines?.node;

  if(typeof enginesNode !== "string") {

    throw new Error("The package.json engines.node field is missing or is not a string.");
  }

  return enginesNode;
}

/**
 * Walk the shipped source a guard inspects: every `.ts` file under the given roots, minus the suites, helpers, and fixtures that never ship, minus any basename the
 * caller asks to skip.
 *
 * Reads run in parallel, since the walk is I/O against a few dozen small files and nothing downstream depends on the order they arrive in.
 *
 * @param sweep - See {@link SourceSweep}.
 *
 * @returns One record per shipped file, each carrying its absolute path and full text.
 *
 * @category Testing
 */
export async function sweepSourceFiles(sweep: SourceSweep): Promise<SweptFile[]> {

  const { roots, skipBasenames = [] } = sweep;

  const perRoot = await Promise.all(roots.map(async (root) => {

    const directory = fileURLToPath(root);
    const relativePaths = await readdir(directory, { recursive: true });
    const candidates = relativePaths.filter((relativePath) => {

      if(!relativePath.endsWith(".ts") || NON_SHIPPED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) {

        return false;
      }

      return !skipBasenames.includes(basename(relativePath));
    });

    return Promise.all(candidates.map(async (relativePath): Promise<SweptFile> => {

      const path = join(directory, relativePath);

      return { path, text: await readFile(path, "utf8") };
    }));
  }));

  return perRoot.flat();
}
