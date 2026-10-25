/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * browser-modules.mjs: The single source of truth for the compiled-TypeScript modules the browser-side webUI loads at runtime.
 */
"use strict";

// The compiled-TS modules the browser bundle carries alongside the webUI. `featureOptions` and `formatters` back the catalog and its magnitude renderers;
// `homekit-name` is HomeKit's naming rule, the sanitizer and validator a plugin's settings page applies to a name before it is saved; `mark-handled` is the
// identity-preserving handled mark the library and the page alike reach for; `webui/address` is the listed-address rule a plugin's settings cards apply before a
// Save; `webui/saveflow` is the shared save flow a plugin's settings cards run every press of their Save through; `webui/status` is the live device-status wire
// contract the status panel consumes. An entry is a module's path under `src/` without its extension, and the build keeps that path
// into `dist/ui/`: the finalize step copies `dist/<entry>.js` to `dist/ui/<entry>.js`, so a module's relative imports resolve in the browser as the compiler
// wrote them, and a browser import is the package name plus that path (`homebridge-plugin-utils/webui/status.js`). The test loader redirects each production
// specifier to its `src/<entry>.ts` source - every consumer imports this list rather than restating it, so none can drift. Every module named here is obligated
// to keep its own imports browser-safe (no Node-only APIs), since the browser resolves each one directly. A module that declares types alone, such as the commit
// vocabulary the save flow imports by type, compiles to nothing the browser loads and is not listed.
export const BROWSER_MODULES = [ "featureOptions", "formatters", "homekit-name", "mark-handled", "webui/address", "webui/saveflow", "webui/status" ];
