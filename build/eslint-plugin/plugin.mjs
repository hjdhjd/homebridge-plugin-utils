/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * plugin.mjs: The `@hjdhjd` ESLint plugin object - meta block plus the rule registry.
 */
import packageJson from "../../package.json" with { type: "json" };
import ruleBlankAfterOpenBrace from "./rules/blank-line-after-open-brace.mjs";
import ruleCommentStyle from "./rules/comment-style.mjs";
import ruleEnforceNodeProtocol from "./rules/enforce-node-protocol.mjs";
import ruleParenComparisonsInLogical from "./rules/paren-comparisons-in-logical.mjs";
import ruleSplitTypeImports from "./rules/split-type-imports.mjs";

/**
 * The `@hjdhjd` ESLint plugin object. Follows the standard ESLint plugin shape - a `meta` block identifying the plugin (used by ESLint's cache
 * invalidation and tooling) plus a `rules` map keyed by the rule name that consumers reference under the `@hjdhjd/` namespace.
 *
 * Register the plugin in a flat config under the `plugins` property, then reference its rules by their fully qualified name:
 *
 * ```js
 * import { plugin } from "homebridge-plugin-utils/eslint";
 * export default [{
 *   plugins: { "@hjdhjd": plugin },
 *   rules: { "@hjdhjd/split-type-imports": "warn" }
 * }];
 * ```
 *
 * For a fully composed configuration that wires this plugin together with the project's TypeScript, JavaScript, and webUI rule presets, prefer the
 * `config()` helper exported from `./config.mjs`.
 */
const plugin = {

  meta: {

    name: "@hjdhjd/eslint-rules",
    version: packageJson.version
  },
  rules: {

    "blank-line-after-open-brace": ruleBlankAfterOpenBrace,
    "comment-style": ruleCommentStyle,
    "enforce-node-protocol": ruleEnforceNodeProtocol,
    "paren-comparisons-in-logical": ruleParenComparisonsInLogical,
    "split-type-imports": ruleSplitTypeImports
  }
};

export default plugin;
