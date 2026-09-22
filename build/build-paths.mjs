/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * build-paths.mjs: The directories the build reads from and writes to, shared by the steps that move files and by the audit that traces a packaged file back to
 * the source it came from. Each pair is declared in exactly one place so the two can never disagree about where the build puts things.
 *
 * Two of the pairs are also declared in a TypeScript project file, which is the compiler's own copy and the authority for what tsc does: SRC_ROOT and DIST_ROOT
 * are `rootDir` and `outDir` in tsconfig.build.json, and PLUGIN_SOURCE and PLUGIN_OUTPUT are the same two keys in tsconfig.eslint-plugin.json. They are restated
 * here because the audit must not parse a TypeScript project file at run time to learn them, and the suite holds the two copies to each other so a change to
 * either project reddens a test rather than silently teaching the build and the audit different geographies.
 */
"use strict";

// Where tsc compiles the library from, and where it emits: `rootDir` and `outDir` in tsconfig.build.json.
export const SRC_ROOT = "src";
export const DIST_ROOT = "dist";

// Where the declaration-only project reads the hand-authored lint plugin and emits its types: `rootDir` and `outDir` in tsconfig.eslint-plugin.json.
export const PLUGIN_SOURCE = "build/eslint-plugin";
export const PLUGIN_OUTPUT = "dist/eslint-plugin";

// Where the webUI copy step reads and writes. This pair has no second declaration anywhere: the copy step below is its only authority.
export const UI_SOURCE = "ui";
export const UI_OUTPUT = "dist/ui";
