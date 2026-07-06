[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/cli

# logclient/cli

The `hblog` command-line bin.

This module is deliberately minimal and node:-builtins-only at the static-import level. A bin is invoked through an npm-managed symlink in `node_modules/.bin`; if it
statically imported a sibling module by relative path, that import would resolve against the symlink's directory under symlink-preserving or copied-package layouts and
fracture. So the bin imports only `node:` builtins for value, takes the engine's type via an erased `import type` (which the compiler strips entirely from the emitted
output), and reaches the actual CLI logic ([runHblog](cli-run.md#runhblog) in `cli-run.ts`) through a realpath-canonicalized DYNAMIC import of a computed file URL.

This design is robust because:

- The engine is reached by a COMPUTED URL (`pathToFileURL(join(dir, "cli-run.js")).href`), so the TypeScript compiler never tries to resolve it - which matters because
  `npm run typecheck` runs with no `dist/` present and before the build. A static `import { runHblog } from "./cli-run.ts"` would emit a `./cli-run.js` value import
  that fractures under symlinks; a static self-specifier (`homebridge-plugin-utils/logclient`) would resolve through the package `exports` map to a `dist/` path that
  does not exist at typecheck time. The computed dynamic import sidesteps both.
- The directory the engine is loaded from is the bin's OWN real directory, recovered with `realpathSync` exactly the way `cli/index.ts` recovers its source root, so
  the symlink indirection is collapsed before the join and the engine loads from the real package layout under every install mode.

The programmatic API ([HomebridgeLogClient](client.md#homebridgelogclient)) rides the existing package barrel; only the bin uses this dynamic-import
path.
