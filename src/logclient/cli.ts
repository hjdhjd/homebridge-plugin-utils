#!/usr/bin/env node
/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/cli.ts: The hblog bin - a node:-builtins-only shell that realpath-resolves its own directory and dynamic-imports the engine logic.
 */

/**
 * The `hblog` command-line bin.
 *
 * This module is deliberately minimal and node:-builtins-only at the static-import level. A bin is invoked through an npm-managed symlink in `node_modules/.bin`; if it
 * statically imported a sibling module by relative path, that import would resolve against the symlink's directory under symlink-preserving or copied-package layouts and
 * fracture. So the bin imports only `node:` builtins for value, takes the engine's type via an erased `import type` (which the compiler strips entirely from the emitted
 * output), and reaches the actual CLI logic ({@link runHblog} in `cli-run.ts`) through a realpath-canonicalized DYNAMIC import of a computed file URL.
 *
 * Two properties make this robust:
 *
 * - The engine is reached by a COMPUTED URL (`pathToFileURL(join(dir, "cli-run.js")).href`), so the TypeScript compiler never tries to resolve it - which matters because
 *   `npm run typecheck` runs with no `dist/` present and before the build. A static `import { runHblog } from "./cli-run.ts"` would emit a `./cli-run.js` value import
 *   that fractures under symlinks; a static self-specifier (`homebridge-plugin-utils/logclient`) would resolve through the package `exports` map to a `dist/` path that
 *   does not exist at typecheck time. The computed dynamic import sidesteps both.
 * - The directory the engine is loaded from is the bin's OWN real directory, recovered with `realpathSync` exactly the way `cli/index.ts` recovers its source root, so
 *   the symlink indirection is collapsed before the join and the engine loads from the real package layout under every install mode.
 *
 * The programmatic API ({@link logclient/client!HomebridgeLogClient | HomebridgeLogClient}) rides the existing package barrel; only the bin uses this dynamic-import
 * path.
 *
 * @module
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import type { runHblog } from "./cli-run.ts";

/**
 * Decide whether this module is the program entry point (run as the `hblog` bin) versus imported as a library. Canonicalizes the real path of both the launch path
 * (`process.argv[1]`) and this module's own URL before comparing them.
 *
 * The realpath normalization is load-bearing, exactly as in `cli/index.ts`: npm exposes a bin as a symlink in `node_modules/.bin`, so under default Node the launch path
 * is the symlink while `import.meta.url` is the resolved target - a raw string comparison never matches and the bin silently does nothing. Canonicalizing both sides
 * collapses that indirection (and any `file:`-dependency, copied-package, or `--preserve-symlinks` layout) to a single real path. We use this rather than
 * `import.meta.main` because the latter is `undefined` on Node 22.0-22.17 (it landed in 22.18), which would reintroduce the silent no-op on the lower end of the `>=22`
 * support range.
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

// Execute the bin when this module is the program entry point. When imported instead, `isEntryPoint()` is false and this module is inert (it exports nothing).
if(isEntryPoint()) {

  // Recover the bin's own real directory, collapsing any symlink indirection, then load the engine from the real `cli-run.js` beside it via a computed file URL. The
  // dynamic import target is a runtime-computed URL, so the compiler never resolves it (no `dist/` needed at typecheck) and the path is correct under every symlink mode.
  const directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const engineUrl = pathToFileURL(join(directory, "cli-run.js")).href;

  // The dynamic import resolves to the engine module; we type the result through the erased `import type` so the binding is fully typed without a value import. The
  // computed-URL import is `any` to the compiler (it cannot resolve a non-literal specifier), so the assertion narrows it to the engine's known shape.
  const engine = await import(engineUrl) as { runHblog: typeof runHblog };

  // `process.exit` propagates the exit code the CLI decided (0 success / clean signal / help / version, 1 connection or auth failure, 2 usage error).
  process.exit(await engine.runHblog({

    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    homedir: (await import("node:os")).homedir(),
    stderr: process.stderr,
    stdout: process.stdout
  }));
}
