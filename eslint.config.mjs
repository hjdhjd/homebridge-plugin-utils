/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "./build/eslint-plugin/index.mjs";

export default hbPluginUtils({

  allowDefaultProject: [],

  // Test-file relaxation. Node's test runner registers `describe()` / `test()` calls as side-effects and awaits them itself, so the "await or explicitly void"
  // convention from `no-floating-promises` does not apply at the register-and-move-on level. Disabling it inside both the TypeScript `src/` tests and the
  // browser-shaped `ui/` tests encodes the test idiom as configuration, rather than scattering per-line disables through the test files. The `^_` ignore pattern
  // for unused vars (supporting the `using _dom = createTestDom()` pattern for disposal-only bindings) now lives in the shared `tsRules` / `jsRules` because the
  // same idiom applies in production `src/` code too (e.g., `using _abortRegistration = onAbort(...)` in `util.ts`), so a split test-only relaxation would be an
  // artificial asymmetry.
  extraConfigs: [{

    files: [ "src/**/*.test.ts", "src/**/*.fixtures.ts", "src/**/*.helpers.ts", "ui/**/*.test.mjs", "ui/**/*.fixtures.mjs", "ui/**/*.helpers.mjs" ],
    rules: {

      "@typescript-eslint/no-floating-promises": "off"
    }
  }],
  js: [ "build/**/*.mjs", "ui/**/*.@(js|mjs)", "eslint.config.mjs" ],
  ts: ["src/**/*.ts"],
  ui: ["ui/**/*.@(js|mjs)"]
});
