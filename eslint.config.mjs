/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Applies the shared `hbPluginUtils` lint config, exported to other Homebridge plugins as `./eslint`, to this package's own sources.
 */
import hbPluginUtils from "./build/eslint-plugin/index.mjs";

export default hbPluginUtils({

  // Every linted file already belongs to a project declared in tsconfig.json's include list, so none need typescript-eslint's default-project fallback.
  allowDefaultProject: [],
  js: [ "build/**/*.mjs", "ui/**/*.@(js|mjs)", "eslint.config.mjs" ],

  // The build tooling, this config file, and the test loader and test-side files under `ui/` run under Node rather than in a browser, so they take Node's
  // globals. The test-side `ui/` files also match the `ui` globs, because they build a DOM and run it under the Node test runner, and flat config merges
  // `globals` across every block a file matches, so they carry both vocabularies at once. The test-file relaxations come from the preset's `tests` default,
  // which already names this package's test, fixture, and helper files.
  node: [ "build/**/*.mjs", "eslint.config.mjs", "ui/**/*.fixtures.mjs", "ui/**/*.helpers.mjs", "ui/**/*.test.mjs", "ui/test-loader.mjs" ],
  ts: ["src/**/*.ts"],
  ui: ["ui/**/*.@(js|mjs)"]
});
