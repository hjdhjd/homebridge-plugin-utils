/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.mjs: Opinionated ESLint flat-config builder. Composes the `@hjdhjd` plugin together with the project's rule presets for TypeScript, JavaScript,
 * and browser-UI files.
 */
import eslintJs from "@eslint/js";
import plugin from "./plugin.mjs";
import stylistic from "@stylistic/eslint-plugin";
import ts from "typescript-eslint";

// Extract rules by name from a typescript-eslint config array. Throws if the named entry is missing so that a typescript-eslint version bump that renames
// config entries fails loudly rather than silently dropping rules.
function configRules(configs, name) {

  const entry = configs.find((c) => c.name === name);

  if(!entry) {

    throw new Error("typescript-eslint config entry not found: " + name);
  }

  return entry.rules;
}

/**
 * The ESLint plugin namespace map used by the composed configuration: `@hjdhjd` (this package's rules), `@stylistic` (the official stylistic-rules
 * plugin), and `@typescript-eslint`. Drop this object into the `plugins` slot of a flat config block to register every plugin namespace this preset
 * composes at once.
 *
 * The type annotation is deliberately loose since consumers that read the named `plugins` export do their own narrowing before touching rule entries.
 * It's annotated explicitly so the emitted type stays portable - the raw inference picks up typescript-eslint's exported `CompatiblePlugin` shape,
 * and the `tsconfig.eslint-plugin.json` declaration-only build (TS2742) refuses to serialize it into the `.d.ts` without citing a deep module path.
 *
 * @type {Record<string, { meta?: { name: string; version?: string }; rules?: Record<string, unknown> }>}
 */
const plugins = {

  "@hjdhjd": plugin,
  "@stylistic": stylistic,
  "@typescript-eslint": ts.plugin
};

/**
 * Rule preset for TypeScript source files. Opens with `typescript-eslint`'s compatibility overlay, builds on that plugin's strict and stylistic
 * type-checked configs, then layers project-specific overrides: type-aware lint rules (`await-thenable`, `no-floating-promises`,
 * `prefer-nullish-coalescing`, etc.) at warn level, explicit return-type and module-boundary requirements, and `@stylistic/member-delimiter-style`.
 * Disables the JavaScript-recommended versions of rules that have TypeScript-aware equivalents to avoid double-flagging.
 *
 * The compatibility overlay switches off the base ESLint rules whose errors the TypeScript compiler reports for itself - `no-undef`, `no-redeclare`, and
 * their siblings. That redundancy argument holds only where the compiler actually runs, which is why the overlay belongs to this preset rather than the
 * language-neutral {@link commonRules}: plain-JavaScript files have no compiler behind them and keep the full ESLint-recommended baseline. Upstream scopes
 * the overlay to the TypeScript file extensions for that same reason, so spreading it here matches how it is meant to apply.
 *
 * Deliberately omits `@typescript-eslint/promise-function-async` and forces `@typescript-eslint/require-await` (and the base `require-await`) off. The pair
 * encodes a tight coupling between Promise return types and the `async` keyword that predates the Disposable protocol: `[Symbol.asyncDispose]()` must be declared
 * `async ...(): Promise<void>` to satisfy `await using` even when the body is synchronous, and identity-preserving Promise pass-throughs (e.g., `markHandled` in
 * `src/mark-handled.ts`) cannot be marked `async` without wrapping the return in a fresh chain and breaking reference equality. Encoding the stance at the preset level
 * rather than scattering per-site `eslint-disable` directives is the SSOT.
 *
 * Spread into the `rules:` slot of a flat config block scoped to `.ts` files.
 */
const tsRules = {

  ...ts.configs.eslintRecommended.rules,
  ...configRules(ts.configs.strictTypeChecked, "typescript-eslint/strict-type-checked"),
  ...configRules(ts.configs.stylisticTypeChecked, "typescript-eslint/stylistic-type-checked"),
  "@stylistic/member-delimiter-style": "warn",
  "@typescript-eslint/await-thenable": "warn",
  "@typescript-eslint/consistent-type-imports": [ "warn", { "fixStyle": "separate-type-imports", "prefer": "type-imports" } ],
  "@typescript-eslint/explicit-function-return-type": "warn",
  "@typescript-eslint/explicit-module-boundary-types": "warn",
  "@typescript-eslint/no-confusing-void-expression": [ "error", { "ignoreArrowShorthand": true, "ignoreVoidOperator": true,
    "ignoreVoidReturningFunctions": true } ],
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-floating-promises": [ "warn", { "ignoreIIFE": true } ],
  "@typescript-eslint/no-non-null-assertion": "warn",
  "@typescript-eslint/no-unnecessary-condition": "warn",
  "@typescript-eslint/no-unused-expressions": "warn",
  "@typescript-eslint/no-unused-vars": [ "warn", { "args": "all", "argsIgnorePattern": "^_", "caughtErrors": "all", "caughtErrorsIgnorePattern": "^_",
    "ignoreUsingDeclarations": true, "varsIgnorePattern": "^_" } ],
  "@typescript-eslint/prefer-nullish-coalescing": "warn",
  "@typescript-eslint/require-await": "off",
  "no-unused-expressions": "off",
  "no-unused-vars": "off",
  "require-await": "off"
};

/**
 * Rule preset for JavaScript source files. Starts from `typescript-eslint`'s `disableTypeChecked` set (so type-aware rules don't fire on plain JS), then reconfigures
 * `no-unused-vars` - already active at "error" from {@link config}'s `eslintJs.configs.recommended` block - down to warn with the underscore-prefix ignore pattern and
 * with `ignoreUsingDeclarations` on, the same options the TypeScript preset's rule carries: a `using` or `await using` binding is used by construction, since the runtime
 * calls its disposal when the block exits, so a binding the code never reads again is not an unused one. Base `require-await` has no JavaScript-recommended equivalent to
 * conflict with, so nothing needs suppressing for `.js` / `.mjs` files the way the TypeScript preset must force its type-aware pair off - see the omission paragraph in
 * the {@link tsRules} JSDoc.
 *
 * Spread into the `rules:` slot of a flat config block scoped to `.js` / `.mjs` files.
 */
const jsRules = {

  ...ts.configs.disableTypeChecked.rules,

  // Restates the "off" value that `disableTypeChecked` already assigns to this rule.
  "@typescript-eslint/no-floating-promises": "off",
  "no-unused-vars": [ "warn", { "args": "all", "argsIgnorePattern": "^_", "caughtErrors": "all", "caughtErrorsIgnorePattern": "^_", "ignoreUsingDeclarations": true,
    "varsIgnorePattern": "^_" } ]
};

/**
 * Rule preset applied to every linted file regardless of language: the full `@hjdhjd/*` rule set, the `@stylistic/*` whitespace and formatting rules, the
 * project's opinionated `sort-imports` / `sort-keys` / `quotes` / `eqeqeq` / `curly` constraints, the `no-restricted-syntax` ban on template literals, and
 * the modernization rules (`no-var`, `prefer-rest-params`, `prefer-spread`) that read the same way in every language.
 *
 * The enabled ESLint-recommended baseline comes from the separate `eslintJs.configs.recommended` block pushed in {@link config}, and the compatibility
 * overlay that trades parts of that baseline away for compiler diagnostics lives in {@link tsRules}, scoped to the files the compiler actually covers.
 *
 * Spread into the `rules:` slot of the all-files block of a flat config.
 */
const commonRules = {

  "@hjdhjd/blank-line-after-open-brace": "warn",
  "@hjdhjd/comment-style": "error",
  "@hjdhjd/enforce-node-protocol": "warn",
  "@hjdhjd/no-boolean-error-predicate": "error",
  "@hjdhjd/no-dom-node-equality": "error",
  "@hjdhjd/no-numeric-separators": "warn",
  "@hjdhjd/paren-comparisons-in-logical": "warn",
  "@hjdhjd/split-type-imports": "warn",
  "@stylistic/array-bracket-spacing": [ "warn", "always", { "arraysInArrays": true, "objectsInArrays": true, "singleValue": false } ],
  "@stylistic/block-spacing": "warn",
  "@stylistic/brace-style": [ "warn", "1tbs", { "allowSingleLine": true } ],
  "@stylistic/comma-dangle": "warn",
  "@stylistic/eol-last": [ "warn", "always" ],
  "@stylistic/generator-star-spacing": "warn",
  "@stylistic/implicit-arrow-linebreak": "warn",
  "@stylistic/indent": [ "warn", 2, { "SwitchCase": 1 } ],
  "@stylistic/keyword-spacing": [ "warn",
    { "overrides": { "for": { "after": false }, "if": { "after": false }, "switch": { "after": false }, "while": { "after": false } } } ],
  "@stylistic/linebreak-style": [ "warn", "unix" ],
  "@stylistic/lines-between-class-members": [ "warn", "always", { "exceptAfterSingleLine": true } ],
  "@stylistic/max-len": [ "warn", 170 ],
  "@stylistic/no-tabs": "warn",
  "@stylistic/no-trailing-spaces": "warn",
  "@stylistic/operator-linebreak": [ "warn", "after", { "overrides": { ":": "after", "?": "after" } } ],
  "@stylistic/padding-line-between-statements": [ "warn",

    // Require a blank line before every statement type in next.
    { "blankLine": "always", "next": [ "break", "case", "class", "continue", "default", "export", "for", "function", "if", "import", "return" ], "prev": "*" },

    // Require blank lines after every statement type in prev.
    { "blankLine": "always", "next": "*", "prev": [ "const", "directive", "let", "var" ] },

    // Multiple sequential case declarations may be grouped together.
    { "blankLine": "any", "next": [ "case", "default" ], "prev": [ "case", "default" ] },

    // Multiple sequential variable declarations may be grouped together.
    { "blankLine": "any", "next": [ "const", "let", "var" ], "prev": [ "const", "let", "var" ] },

    // Multiple sequential export declarations may be grouped together.
    { "blankLine": "any", "next": "export", "prev": "export" },

    // Multiple sequential import declarations must be grouped together.
    { "blankLine": "never", "next": "import", "prev": "import" },

    // Multiple sequential directive prologues must be grouped together.
    { "blankLine": "never", "next": "directive", "prev": "directive" }
  ],
  "@stylistic/semi": [ "warn", "always" ],
  "@stylistic/space-before-function-paren": [ "warn", { "anonymous": "never", "asyncArrow": "always", "catch": "never", "named": "never" } ],
  "@stylistic/space-in-parens": "warn",
  "@stylistic/space-infix-ops": "warn",
  "@stylistic/space-unary-ops": "warn",
  "@typescript-eslint/dot-notation": [ "warn", { "allowIndexSignaturePropertyAccess": true } ],
  "@typescript-eslint/no-this-alias": "warn",
  "camelcase": "warn",
  "curly": [ "warn", "all" ],
  "dot-notation": "off",
  "eqeqeq": "warn",
  "logical-assignment-operators": [ "warn", "always", { "enforceForIfStatements": true } ],
  "no-await-in-loop": "warn",
  "no-console": "warn",
  // Requires one declaration per module for each kind of import, with the option admitting the type-beside-value pair the house style calls for.
  "no-duplicate-imports": [ "warn", { "allowSeparateTypeImports": true } ],
  "no-restricted-syntax": [ "warn", "TemplateLiteral" ],
  "no-var": "error",
  "prefer-arrow-callback": "warn",
  "prefer-const": "warn",
  "prefer-rest-params": "error",
  "prefer-spread": "error",
  "quotes": [ "warn", "double", { "allowTemplateLiterals": false, "avoidEscape": false } ],
  "sort-imports": "warn",
  "sort-keys": "warn",
  "sort-vars": "warn"
};

/**
 * Browser-environment globals typically present in Homebridge webUI files - `window`, `document`, `fetch`, the Homebridge configuration API entry
 * point, and a few timer functions. Each is declared as `"readonly"` so `no-undef` accepts references without permitting reassignment.
 *
 * Pass into the `languageOptions.globals` slot of a flat config block scoped to UI files.
 */
const globalsUi = Object.fromEntries([ "clearInterval", "clearTimeout", "console", "container", "document", "fetch", "getComputedStyle", "homebridge",
  "setInterval", "setTimeout", "window" ].map((key) => [ key, "readonly" ]));

/**
 * Node-environment globals: every global the Node runtime running the linter provides - `process`, `console`, `fetch`, `Buffer`, `setImmediate`, and the rest -
 * read from `globalThis` as this module loads. Each is declared as `"readonly"` so `no-undef` accepts references without permitting reassignment.
 *
 * The runtime is the one source of truth for which globals Node provides, so the list follows the Node version that runs the lint rather than a hand-kept copy
 * that goes stale as Node adds globals, and it needs no dependency to carry one. Only the names are read, never the values, so no lazily-initialized global is
 * touched. The {@link config} builder applies it to the files its `node` option names rather than to every JavaScript file, because a browser-side module that
 * accepted Node's names would stop `no-undef` from catching a reference that fails in the browser.
 *
 * Pass into the `languageOptions.globals` slot of a flat config block scoped to Node-run files.
 */
const globalsNode = Object.fromEntries(Object.getOwnPropertyNames(globalThis).map((key) => [ key, "readonly" ]));

/**
 * Rule preset for test, fixture, and helper files. Node's test runner registers each `describe()` and `test()` call as a side effect and awaits it itself, so
 * the "await or explicitly void" convention `@typescript-eslint/no-floating-promises` enforces does not apply to a registration call. Encoding the test idiom
 * once here spares every test file a per-line disable and every consumer a copy of the same block.
 *
 * Spread into the `rules:` slot of a flat config block scoped to test files.
 */
const testRules = {

  "@typescript-eslint/no-floating-promises": "off"
};

/**
 * Rule preset for fixture files. A fixture embeds output captured from a device or controller, and its key order is the order the wire delivered, which a test
 * may assert on as evidence, so `sort-keys` would have the fixture re-key the data it exists to preserve. Test and helper files construct their own objects,
 * so they keep the rule.
 *
 * Spread into the `rules:` slot of a flat config block scoped to fixture files.
 */
const fixtureRules = {

  "sort-keys": "off"
};

// The family's fixture-file naming convention, in `.ts` and `.mjs`, wherever the file lives. It is the `fixtures` default and part of the `tests` default in
// `config`, so the `fixtures` and `tests` defaults name the same fixture files.
const fixtureGlobs = [ "**/*.fixtures.ts", "**/*.fixtures.mjs" ];

// Pair every glob in `linted` with every glob in `globs`, in the form where a file must match both. In flat config a block's `files` globs also pick files out of a
// linted directory, so a relaxation block scoped through this pairing reaches only files the preset already lints and never widens what gets linted. The pairing
// is empty when `linted` or `globs` is.
function pairWithLinted({ globs, linted }) {

  return linted.flatMap((glob) => globs.map((scoped) => [ glob, scoped ]));
}

/**
 * Build a ready-to-use ESLint flat config array. Consumers call this function and export default the result.
 *
 * Every option is optional, and every one but `tests` and `fixtures` defaults to an empty array, mirrored by the destructuring defaults in the signature below.
 * `tests` defaults to the family's naming convention for test, fixture, and helper files wherever the file lives, `fixtures` defaults to the fixture-file part of
 * that convention, and an empty array for an option opts it out. The JSDoc marks them optional with the bracket form so the emitted declaration types each property
 * as optional, matching how consumers actually call this - passing only the subset they need.
 *
 * @param {object} [options] - Configuration options.
 * @param {string[]} [options.ts] - Glob patterns for TypeScript files (strict + stylistic type-checked rules).
 * @param {string[]} [options.js] - Glob patterns for JavaScript files (disable-type-checked rules).
 * @param {string[]} [options.ui] - Glob patterns for browser UI files (adds browser globals).
 * @param {string[]} [options.node] - Glob patterns for files that run under Node (linted, adds Node globals).
 * @param {string[]} [options.tests] - Glob patterns for linted test, fixture, and helper files (adds test rule relaxations). Defaults to the family naming convention.
 * @param {string[]} [options.fixtures] - Glob patterns for linted fixture files (switches sort-keys off). Defaults to the family naming convention for fixtures.
 * @param {string[]} [options.allowDefaultProject] - Globs passed to parserOptions.projectService.allowDefaultProject.
 * @param {string[]} [options.ignores] - Global ignore patterns (in addition to the hardcoded "dist" ignore on the common block).
 * @param {object[]} [options.extraConfigs] - Additional flat config objects appended to the output.
 * @returns {object[]} A flat config array suitable for `export default` in eslint.config.mjs. Block ordering is significant - do not reorder.
 */
function config({
  allowDefaultProject = [],
  extraConfigs = [],
  fixtures = fixtureGlobs,
  ignores = [],
  js = [],
  node = [],
  tests = [ "**/*.test.ts", "**/*.test.mjs", ...fixtureGlobs, "**/*.helpers.ts", "**/*.helpers.mjs" ],
  ts: tsFiles = [],
  ui = []
} = {}) {

  const allFiles = [ ...tsFiles, ...js, ...ui, ...node ];
  const configs = [];

  // Global ignores block.
  if(ignores.length > 0) {

    configs.push({ ignores });
  }

  // Core ESLint recommended rules. This block must precede the TS/JS blocks so that their rule overrides (e.g., no-unused-vars: "off") take priority.
  if(allFiles.length > 0) {

    configs.push(eslintJs.configs.recommended);
  }

  // TypeScript-specific rules.
  if(tsFiles.length > 0) {

    configs.push({

      files: tsFiles,
      rules: { ...tsRules }
    });
  }

  // JavaScript-specific rules.
  if(js.length > 0) {

    configs.push({

      files: js,
      rules: { ...jsRules }
    });
  }

  // Common rules applied to all linted files.
  if(allFiles.length > 0) {

    configs.push({

      files: allFiles,

      ignores: ["dist"],

      languageOptions: {

        ecmaVersion: "latest",
        parser: ts.parser,
        parserOptions: {

          ecmaVersion: "latest",

          projectService: {

            allowDefaultProject,
            defaultProject: "./tsconfig.json"
          }
        },

        sourceType: "module"
      },

      linterOptions: {

        reportUnusedDisableDirectives: "error"
      },

      plugins: { ...plugins },

      rules: { ...commonRules }
    });
  }

  // UI globals block.
  if(ui.length > 0) {

    configs.push({

      files: ui,

      languageOptions: {

        globals: { ...globalsUi }
      }
    });
  }

  // Node globals block.
  if(node.length > 0) {

    configs.push({

      files: node,

      languageOptions: {

        globals: { ...globalsNode }
      }
    });
  }

  // Test-file relaxations, reaching only the test files the preset already lints. The block sits ahead of the escape hatch so a consumer's own block still has the
  // final word.
  const testFiles = pairWithLinted({ globs: tests, linted: allFiles });

  if(testFiles.length > 0) {

    configs.push({

      files: testFiles,
      rules: { ...testRules }
    });
  }

  // Fixture-file relaxations, reaching only the fixture files the preset already lints. The block sits after the common block that enables `sort-keys`, so the
  // relaxation takes effect, and ahead of the escape hatch, so a consumer's own block still has the final word.
  const fixtureFiles = pairWithLinted({ globs: fixtures, linted: allFiles });

  if(fixtureFiles.length > 0) {

    configs.push({

      files: fixtureFiles,
      rules: { ...fixtureRules }
    });
  }

  // Escape hatch for project-specific config blocks.
  configs.push(...extraConfigs);

  return configs;
}

export default config;

// Named exports for advanced customization or gradual migration.
export { commonRules, config, fixtureRules, globalsNode, globalsUi, jsRules, plugins, testRules, tsRules };
