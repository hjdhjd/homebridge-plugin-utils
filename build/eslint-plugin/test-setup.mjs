/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * test-setup.mjs: Shared RuleTester scaffold for the plugin's per-rule test suites. Wires ESLint's `RuleTester` static class to the `node:test` runner's
 * `describe` / `it` hooks so each rule's `*.test.mjs` file can construct a tester without repeating the static-assignment dance. The assignments mutate
 * the `RuleTester` class itself, so they run exactly once on first import regardless of how many test files reach in.
 *
 * Mirrors the host package's `src/testing.helpers.ts` convention - shared test infrastructure lives at the top of its module, alongside the entry-point
 * files (`plugin.mjs`, `config.mjs`, `index.mjs`), with co-located test files in `rules/` importing back up via `../test-setup.mjs`.
 */
import { describe, it } from "node:test";
import { RuleTester } from "eslint";

RuleTester.describe = describe;
RuleTester.it = it;

// `RuleTester.itOnly` is dispatched when a test case is declared with `{ only: true, ... }`. We map it to `it.only` (not plain `it`) so the test case
// is actually marked exclusive. Note: node:test additionally requires the `--test-only` CLI flag for `.only` markers to take effect; without it the
// markers are silently ignored and every test runs as normal. Use `npm run test:focus` (or `node --test --test-only ...`) when debugging with `only: true`.
RuleTester.itOnly = it.only;

export { RuleTester };
