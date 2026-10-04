/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * browser-modules.mjs: The single source of truth for the compiled-TypeScript modules the browser-side webUI loads at runtime.
 */
"use strict";

// The compiled-TS modules the browser bundle carries alongside the webUI. `featureOptions` and `formatters` back the catalog and its magnitude renderers;
// `mark-handled` is the identity-preserving handled mark both the library and the page reach for; `webui/status` is the live device-status wire contract the status
// panel consumes. An entry is a module's path under `src/` without its extension, and the build keeps that path into `dist/ui/`: the finalize step copies
// `dist/<entry>.js` to `dist/ui/<entry>.js`, so a module's relative imports resolve in the browser as the compiler wrote them, and a browser import is the package
// name plus that path (`homebridge-plugin-utils/webui/status.js`). The test loader redirects each production specifier to its `src/<entry>.ts` source - every
// consumer imports this list rather than restating it, so none can drift. Every module named here is obligated to keep its own imports browser-safe (no Node-only
// APIs), since the browser resolves each one directly.
export const BROWSER_MODULES = [ "featureOptions", "formatters", "mark-handled", "webui/status" ];
