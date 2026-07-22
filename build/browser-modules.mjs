/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * browser-modules.mjs: The single source of truth for the compiled-TypeScript modules the browser-side webUI loads at runtime.
 */
"use strict";

// The compiled-TS modules the browser bundle carries alongside the webUI. `featureOptions` and `formatters` back the catalog and its magnitude renderers;
// `webui-status` is the live device-status wire contract the status panel consumes. The build's finalize step copies each of these from `dist/` into `dist/ui/`, and
// the test loader redirects each production specifier to its `src/*.ts` source - both consumers import this list rather than restating it, so the two can never drift.
// Every module named here is obligated to keep its own imports browser-safe (no Node-only APIs), since the browser resolves each one directly.
export const BROWSER_MODULES = [ "featureOptions", "formatters", "webui-status" ];
