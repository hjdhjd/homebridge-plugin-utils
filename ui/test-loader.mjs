/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/test-loader.mjs: In-process module-resolution hook that routes every browser-shipped UI file's static import of a dual-shipped browser module to its
 * TypeScript source at test time.
 *
 * Invoked via `node --import ./ui/test-loader.mjs ...` from the `test` script in `package.json`. Uses Node 22.15+'s `module.registerHooks()` to install the
 * `resolve` hook synchronously in the main thread; no worker boundary, no IPC, no separate registration bootstrap. The file both defines and installs the hook in
 * one place, because `registerHooks` is in-process - unlike the older `module.register()` API, which spawns a loader worker and requires the hook module to live in
 * its own URL-registered file.
 *
 * **Why the hook exists.** In production, browser-shipped UI files (orchestrator, state, search, renderer, status panel, etc.) import the dual-shipped modules from
 * `./featureOptions.js`, `./webui-status.js`, and the like, and the browser loads the compiled artifacts the build's finalize step placed at `dist/ui/`. In the
 * test environment there is no corresponding file next to the importer - we run directly from `ui/` without a build step - so the import would fail with
 * `ERR_MODULE_NOT_FOUND`. Rather than drop a permanent shim next to each importer (which would give `ui/<module>.js` two meanings depending on context), we redirect
 * each offending specifier to its `src/<module>.ts` source whenever it originates from a file under `/ui/`, and let Node's `--strip-types` handle the `.ts` extension.
 *
 * **Why the list drives it.** The redirect set is `BROWSER_MODULES`, the single source of truth for which compiled-TS modules the browser bundle carries; the build's
 * copy step and this loader import the same list, so a module added to the dual-ship pipeline is redirected here without a parallel edit.
 *
 * **Why the parent-URL match.** Scoping to `/ui/` parent URLs leaves an unrelated `./featureOptions.js` specifier (e.g., a future file in `src/` or `build/`) free
 * to resolve via the default mechanism. Any browser-shipped UI file gets the redirect; nothing outside `ui/` does.
 *
 * **Version contract.** `registerHooks` is a Node 22.15+ API. The library's production floor is `engines.node: ">=22.20"`, which already exceeds that requirement, so
 * this loader adds no constraint beyond the published engines floor - any environment that satisfies the package's own Node requirement can run the test suite.
 */
"use strict";

import { BROWSER_MODULES } from "../build/browser-modules.mjs";
import { registerHooks } from "node:module";

// The parent-URL substring we redirect for. Any module under `/ui/` that imports a production specifier gets the redirect; modules outside `ui/` resolve via the
// default mechanism. Using a substring rather than a single hardcoded suffix lets every browser-shipped UI file (orchestrator, state, search, renderer, status
// panel, etc.) share one rule.
const UI_PARENT_FRAGMENT = "/ui/";

// Escape any regex-special characters in a module basename so the assembled alternation matches the name literally rather than as a pattern.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The specifier pattern UI files use in production, built from `BROWSER_MODULES`. A dual-shipped module compiles to `dist/ui/<name>.js`; sibling files at `dist/ui/`
// import it via `./<name>.js`, files nested one level deep (`dist/ui/webUi-featureOptions/store.mjs`) reach it via `../<name>.js`, files nested two levels deep
// (`dist/ui/webUi-featureOptions/views/statusPanel.mjs`) reach it via `../../<name>.js`. The regex accepts any number of leading `../` segments before the tail so
// every depth resolves through the same rule, and the captured group names which module a matched specifier refers to. The end-anchor keeps the match precise -
// unrelated files whose names merely contain a module name would not match.
const PRODUCTION_SPECIFIER_PATTERN = new RegExp("^(?:\\.\\.?/)+(" + BROWSER_MODULES.map(escapeRegExp).join("|") + ")\\.js$");

// The TypeScript source URL each browser module redirects to, keyed by module basename. `../src/<name>.ts` is the sibling-of-`ui/` TS file that the production
// finalize step would otherwise compile into `dist/ui/<name>.js`. At test time, Node's `--strip-types` handles the `.ts` extension and strips type annotations on
// load. Resolved once at module load so the resolve hook does no per-call URL work.
const SOURCE_URLS = new Map(BROWSER_MODULES.map((name) => [ name, new URL("../src/" + name + ".ts", import.meta.url).href ]));

registerHooks({

  // Resolve hook invoked for every import specifier the test process encounters. Intercepts a UI-file-to-browser-module static import and forwards it to the TS
  // source; every other specifier falls through to the default resolution unchanged. Node's hook contract accepts both sync and async implementations - we return
  // synchronously for the match path and return the downstream Promise unchanged for the fallthrough path, so no `await` is needed in this function body.
  resolve(specifier, context, nextResolve) {

    const match = PRODUCTION_SPECIFIER_PATTERN.exec(specifier);

    if(match && context.parentURL?.includes(UI_PARENT_FRAGMENT)) {

      // `shortCircuit: true` tells Node this is a terminal decision - do not walk further hooks. The URL is the matched module's TS source; Node's strip-types
      // runtime handles the `.ts` extension downstream without further help from us.
      return { shortCircuit: true, url: SOURCE_URLS.get(match[1]) };
    }

    return nextResolve(specifier, context);
  }
});
