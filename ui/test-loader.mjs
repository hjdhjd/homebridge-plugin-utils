/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/test-loader.mjs: In-process module-resolution hook that routes every browser-shipped UI file's static import of `./featureOptions.js` to the TypeScript
 * source at test time.
 *
 * Invoked via `node --import ./ui/test-loader.mjs ...` from the `test` script in `package.json`. Uses Node 22.15+'s `module.registerHooks()` to install the
 * `resolve` hook synchronously in the main thread; no worker boundary, no IPC, no separate registration bootstrap. The file both defines and installs the hook in
 * one place, because `registerHooks` is in-process - unlike the older `module.register()` API, which spawns a loader worker and requires the hook module to live in
 * its own URL-registered file.
 *
 * **Why the hook exists.** In production, browser-shipped UI files (orchestrator, state, search, renderer, etc.) import `FeatureOptions` and friends from
 * `./featureOptions.js`, and the browser loads the compiled artifact that `copy-featureOptions` placed at `dist/ui/featureOptions.js`. In the test environment
 * there is no corresponding file next to the importer - we run directly from `ui/` without a build step - so the import would fail with `ERR_MODULE_NOT_FOUND`.
 * Rather than drop a permanent shim next to each importer (which would give `ui/featureOptions.js` two meanings depending on context), we redirect the offending
 * specifier to `src/featureOptions.ts` whenever it originates from a file under `/ui/`, and let Node's `--strip-types` handle the `.ts` extension.
 *
 * **Why the parent-URL match.** Scoping to `/ui/` parent URLs leaves unrelated `./featureOptions.js` specifiers (e.g., a future file in `src/` or `build/`) free
 * to resolve via the default mechanism. Any browser-shipped UI file gets the redirect; nothing outside `ui/` does.
 *
 * **Version contract.** `registerHooks` is a Node 22.15+ API. The library's production `engines.node: ">=22"` is NOT narrowed by this file - test infrastructure is
 * a developer-only concern, and the library itself loads on any Node 22.x without touching this loader. Contributors running the test suite need Node 22.15+; end
 * users installing the published package do not.
 */
"use strict";

import { registerHooks } from "node:module";

// The parent-URL substring we redirect for. Any module under `/ui/` that imports the production specifier gets the redirect; modules outside `ui/` resolve via the
// default mechanism. Using a substring rather than a single hardcoded suffix lets every browser-shipped UI file (orchestrator, state, search, renderer, etc.)
// share one rule.
const UI_PARENT_FRAGMENT = "/ui/";

// The specifier pattern UI files use in production. The featureOptions module compiles to `dist/ui/featureOptions.js`; sibling files at `dist/ui/` import it via
// `./featureOptions.js`, files nested one level deep (`dist/ui/webUi-featureOptions/store.mjs`) reach it via `../featureOptions.js`, files nested two levels deep
// (`dist/ui/webUi-featureOptions/effects/persist.mjs`) reach it via `../../featureOptions.js`. The regex accepts any number of leading `../` segments before the
// `featureOptions.js` tail so every depth resolves through the same rule. The end-anchor on `featureOptions.js` keeps the match precise - unrelated files whose
// names happen to contain the substring would not match.
const PRODUCTION_SPECIFIER_PATTERN = /^(?:\.\.?\/)+featureOptions\.js$/;

// URL of the TypeScript source we route to. `../src/featureOptions.ts` is the sibling-of-`ui/` TS file that the production `finalize` step would otherwise
// compile into `dist/ui/featureOptions.js`. At test time, Node's `--strip-types` handles the `.ts` extension and strips type annotations on load.
const SOURCE_URL = new URL("../src/featureOptions.ts", import.meta.url).href;

registerHooks({

  // Resolve hook invoked for every import specifier the test process encounters. Intercepts UI-file-to-featureOptions static imports and forwards them to the TS
  // source; every other specifier falls through to the default resolution unchanged. Node's hook contract accepts both sync and async implementations - we return
  // synchronously for the match path and return the downstream Promise unchanged for the fallthrough path, so no `await` is needed in this function body.
  resolve(specifier, context, nextResolve) {

    if(PRODUCTION_SPECIFIER_PATTERN.test(specifier) && context.parentURL?.includes(UI_PARENT_FRAGMENT)) {

      // `shortCircuit: true` tells Node this is a terminal decision - do not walk further hooks. The URL is the TS source; Node's strip-types runtime handles the
      // `.ts` extension downstream without further help from us.
      return { shortCircuit: true, url: SOURCE_URL };
    }

    return nextResolve(specifier, context);
  }
});
