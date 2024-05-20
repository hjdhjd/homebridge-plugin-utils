/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint-rules.mjs: Opinionated default linting rules for Homebridge plugins.
 */
import stylistic from "@stylistic/eslint-plugin";
import tsEslint from "@typescript-eslint/eslint-plugin";

// ESlint plugins to use.
const plugins = {

  "@stylistic": stylistic,
  "@typescript-eslint": tsEslint
};

// TypeScript-specific rules.
const tsRules = {

  ...tsEslint.configs.strictTypeChecked,
  ...tsEslint.configs.stylisticTypeChecked,
  "@typescript-eslint/explicit-function-return-type": "warn",
  "@typescript-eslint/explicit-module-boundary-types": "warn",
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-floating-promises": ["warn", { "ignoreIIFE": true }],
  "@typescript-eslint/no-non-null-assertion": "warn",
  "no-dupe-class-members": "off",
  "no-undef": "off",
  "no-unused-vars": "off"
};

// JavaScript-specific rules.
const jsRules = {

  ...tsEslint.configs.disableTypeChecked,
  "@typescript-eslint/no-floating-promises": "off"
};

// Rules that exist across both JavaScript and TypeScript files.
const commonRules = {

  ...tsEslint.configs.eslintRecommended,
  "@stylistic/brace-style": "error",
  "@stylistic/comma-dangle": "error",
  "@stylistic/generator-star-spacing": "error",
  "@stylistic/implicit-arrow-linebreak": "error",
  "@stylistic/indent": ["warn", 2, { "SwitchCase": 1 }],
  "@stylistic/keyword-spacing": ["error",
    { "overrides": { "catch": { "after": false }, "for": { "after": false }, "if": { "after": false }, "switch": { "after": false}, "while": { "after": false } } }],
  "@stylistic/linebreak-style": ["warn", "unix"],
  "@stylistic/lines-between-class-members": ["warn", "always", { "exceptAfterSingleLine": true }],
  "@stylistic/max-len": ["warn", 170],
  "@stylistic/no-tabs": "error",
  "@stylistic/no-trailing-spaces": "error",
  "@stylistic/semi": ["warn", "always"],
  "@stylistic/space-before-function-paren": ["error", { "anonymous": "never", "asyncArrow": "always", "named": "never" }],
  "@stylistic/space-in-parens": "error",
  "@stylistic/space-infix-ops": "error",
  "@stylistic/space-unary-ops": "error",
  "@typescript-eslint/no-this-alias": "warn",
  "camelcase": "warn",
  "curly": ["warn", "all"],
  "dot-notation": "warn",
  "eqeqeq": "warn",
  "no-await-in-loop": "warn",
  "no-console": "warn",
  "prefer-arrow-callback": "warn",
  "quotes": ["warn", "double", { "avoidEscape": true }],
  "sort-imports": "warn",
  "sort-keys": "warn",
  "sort-vars": "warn"
};

// Globals that tend to exist in Homebridge projects.
const globalsUi = Object.fromEntries(["console", "document", "fetch", "homebridge"].map(key => [key, "readonly"]));

export default {

  globals: {

    ui: globalsUi
  },
  plugins: plugins,
  rules: {

    common: commonRules,
    js: jsRules,
    ts: tsRules
  }
};
