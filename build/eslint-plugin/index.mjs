/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.mjs: Public surface of the bundled `@hjdhjd` ESLint plugin. Re-exports the plugin object and the opinionated config builder.
 */
export { default as plugin } from "./plugin.mjs";
export { commonRules, config, globalsUi, jsRules, plugins, tsRules } from "./config.mjs";
export { default } from "./config.mjs";
