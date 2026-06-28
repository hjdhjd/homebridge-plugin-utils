# `@hjdhjd` ESLint plugin

A self-contained ESLint flat-config plugin bundled inside `homebridge-plugin-utils`. Provides five custom rules and an opinionated flat-config builder
tuned for Homebridge plugin development - TypeScript backend, JavaScript build tooling, browser-side webUI - all in one consistent rule surface.

## Quick start

The repo's root `eslint.config.mjs` consumes the plugin through its config helper:

```js
import hbPluginUtils from "./build/eslint-plugin/index.mjs";

export default hbPluginUtils({

  ts: [ "src/**/*.ts" ],
  js: [ "build/**/*.mjs", "eslint.config.mjs" ],
  ui: [ "ui/**/*.@(js|mjs)" ]
});
```

That single call returns a complete flat-config array: TypeScript rules scoped to `.ts` files, JavaScript rules scoped to `.mjs` files, the common
`@hjdhjd/*` and `@stylistic/*` rule set applied everywhere, and webUI globals scoped to UI files.

## File layout

```
build/eslint-plugin/
├── README.md                                       # this file
├── index.mjs                                       # public surface: re-exports plugin + config
├── plugin.mjs                                      # the ESLint plugin object: { meta, rules }
├── config.mjs                                      # opinionated flat-config builder and rule presets
├── test-setup.mjs                                  # shared RuleTester scaffold for the rule test suites
└── rules/
    ├── blank-line-after-open-brace.mjs             # @hjdhjd/blank-line-after-open-brace
    ├── blank-line-after-open-brace.test.mjs        # co-located RuleTester suite
    ├── comment-style.mjs                           # @hjdhjd/comment-style
    ├── comment-style.test.mjs                      # co-located RuleTester suite
    ├── enforce-node-protocol.mjs                   # @hjdhjd/enforce-node-protocol
    ├── enforce-node-protocol.test.mjs              # co-located RuleTester suite
    ├── paren-comparisons-in-logical.mjs            # @hjdhjd/paren-comparisons-in-logical
    ├── paren-comparisons-in-logical.test.mjs       # co-located RuleTester suite
    ├── split-type-imports.mjs                      # @hjdhjd/split-type-imports
    └── split-type-imports.test.mjs                 # co-located RuleTester suite
```

Each `rules/*.mjs` file is the full unit for one rule: copyright header, module-level constants, pure helpers, rule header comment, rule object, default
export. Tests for a rule live in `<rule-name>.test.mjs` alongside it. The two layers above the rules - `plugin.mjs` (what the plugin IS) and `config.mjs`
(what the plugin RECOMMENDS) - are cleanly separated so a consumer can use the rules without inheriting the opinions, or use the opinions without
reaching into rule internals.

## Public surface

`index.mjs` exposes the package's full API as re-exports:

| Export | From | What it is |
|---|---|---|
| `default` / `config` | `config.mjs` | The flat-config builder function. Takes file-glob options, returns an array suitable for `export default` in `eslint.config.mjs`. |
| `plugin` | `plugin.mjs` | The ESLint plugin object - `{ meta, rules }`. Drop into a flat config block under `plugins["@hjdhjd"]`. |
| `plugins` | `config.mjs` | The composed plugin namespace map - `@hjdhjd`, `@stylistic`, `@typescript-eslint`. |
| `commonRules` | `config.mjs` | Rule preset applied to every linted file regardless of language. |
| `tsRules` | `config.mjs` | TypeScript-specific rule preset. |
| `jsRules` | `config.mjs` | JavaScript-specific rule preset. |
| `globalsUi` | `config.mjs` | Browser-environment globals dictionary for webUI files. |

Every named export has JSDoc on its source declaration.

## The rules

Each rule is described in detail by its own file's header comment. One-line summaries:

| Rule | Purpose |
|---|---|
| `@hjdhjd/blank-line-after-open-brace` | Require a blank line after an opening brace when the brace is followed by a newline and the next line carries non-whitespace content. Covers block statements, class bodies, object expressions, and TypeScript interface/type-literal bodies. |
| `@hjdhjd/comment-style` | Enforce ASCII-first comment style. Substitutes Unicode arrows/comparison glyphs/em-dash with ASCII equivalents, removes decorative banner separators, and strips characters from the Unicode Box Drawing block. |
| `@hjdhjd/enforce-node-protocol` | Require the `node:` protocol prefix on every reference to a Node.js built-in module. |
| `@hjdhjd/paren-comparisons-in-logical` | Require parentheses around any comparison operand that is a direct child of a compound `&&` or `||` expression. |
| `@hjdhjd/split-type-imports` | Require type imports and re-exports to live in declaration-level `import type` / `export type` statements rather than as inline specifier-level `type` qualifiers. Pairs with `@typescript-eslint/consistent-type-imports` configured with `fixStyle: "separate-type-imports"` to express the split-form policy as a single source of truth. |

## Plugin shape

`plugin.mjs` exports the standard ESLint plugin shape:

```js
{
  meta: { name: "@hjdhjd/eslint-rules", version: <package.json version> },
  rules: { /* the five rules above */ }
}
```

The version is sourced from the host package's `package.json` via the ECMAScript `import attributes` syntax (`with { type: "json" }`), so it auto-syncs
with the package version on release.

## Architecture conventions

The plugin follows a few intentional conventions that make it predictable to extend and to read:

- **One rule per file under `rules/`.** Each rule file is self-contained: its constants, pure helpers, rule header, rule object, and default export all
  live in one place. Helpers are private to the rule's file - cross-rule shared utilities are deliberately avoided to prevent premature abstractions.

- **Pure helpers at module scope, taking dependencies as parameters.** A helper that needs `sourceCode` takes it as its first argument rather than
  closing over it. The function signature tells the truth about what the helper uses, and the helpers are reachable for unit-testing in isolation if
  needed.

- **The rule's `create(context)` body stays minimal.** It reads options from `context`, sets up the thin reporter wrapper, and declares its visitors.
  All real logic lives in the module-level helpers above.

- **Three-part rule header comment on every rule.** What the rule enforces (one sentence), what cases it covers (enumerated), and any non-obvious
  design decisions. Open any rule file and the first comment block tells you everything you need to know.

- **Tests co-located with rules.** A rule's `RuleTester` suite lives in `<rule-name>.test.mjs` next to the rule file. Matches the convention used
  throughout `src/` in the host package.

- **Plugin meta in standard ESLint shape.** `meta.name` plus `meta.version` so the plugin is identifiable to ESLint's cache invalidation, the lint
  output, and any tooling that inspects loaded plugins.

## Adding a new rule

1. Create `rules/<new-rule-name>.mjs` with:
   - Copyright header.
   - Module-level constants and pure helpers for the rule.
   - The three-part rule header comment.
   - The rule object as a `const`, with default export.

2. Create `rules/<new-rule-name>.test.mjs` co-located alongside, importing `RuleTester` from the shared `../test-setup.mjs` scaffold:

   ```js
   import { RuleTester } from "../test-setup.mjs";
   import rule from "./<new-rule-name>.mjs";

   const ruleTester = new RuleTester(/* optional languageOptions */);

   ruleTester.run("<new-rule-name>", rule, { invalid: [ /* ... */ ], valid: [ /* ... */ ] });
   ```

   Cover every case the rule's header documents under "Cases covered" plus negative passthrough cases that prove the canonical form is ignored.

3. In `plugin.mjs`, add one `import` line and one entry to the `rules` map (alphabetical).

4. If the rule should be enabled by default, add one line to the appropriate preset in `config.mjs`: `commonRules` (applies to every linted file), `tsRules` (TypeScript-only), or `jsRules` (JavaScript-only).

That's the whole motion. No other files need to change.

## Composing with downstream consumers

The `config()` helper is the primary API for consumers who want the full opinionated stack. For consumers who want only the plugin's rules without
the opinions, import `plugin` from `index.mjs` and wire it into their own flat config directly:

```js
import { plugin } from "homebridge-plugin-utils/build/eslint-plugin/index.mjs";

export default [{

  plugins: { "@hjdhjd": plugin },

  rules: {

    "@hjdhjd/comment-style": "error",
    "@hjdhjd/split-type-imports": "warn"
  }
}];
```

The plugin is namespace-agnostic - register it under any name you like in `plugins:` and reference the rules under that prefix. The `@hjdhjd/` namespace
in `commonRules` is wired to match the bundled defaults; if you re-namespace the plugin in your own config, you'll also need to remap the rule names.
