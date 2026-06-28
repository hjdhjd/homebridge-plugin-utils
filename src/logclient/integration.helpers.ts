/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/integration.helpers.ts: Gate predicate for the hblog live-server integration test suite.
 */

/**
 * Resolves the boolean that gates the hblog integration test suite (`integration.test.ts`). The resolution is sticky: it runs once at module load and the result is
 * reused for every `describe` skip predicate that imports it.
 *
 * Unlike the FFmpeg integration gate (`ffmpeg/integration.helpers.ts`), there is NO autodetection here. The FFmpeg gate can cheaply probe for a usable binary on PATH,
 * but the hblog suite needs a live homebridge-config-ui-x server plus real credentials in `~/.hblog.json`, and there is no guaranteed, side-effect-free way to confirm
 * both are present without actually authenticating against the server. So this gate is purely opt-in and OFF by default: only an explicit `HBLOG_INTEGRATION=1` turns it
 * on.
 *
 * The single input is the `HBLOG_INTEGRATION` environment variable: exactly `"1"` enables the suite (run it deliberately, against a server you control); anything else -
 * unset, `"0"`, or any other value - leaves it skipped. This keeps the default `npm run test` invocation free of any network dependency while still letting a developer
 * run the live end-to-end safety net on demand.
 *
 * The predicate is a plain boolean because `describe` evaluates its `skip` option at registration time, not asynchronously. Node's module cache ensures the lookup
 * happens exactly once even if multiple test files import this helper.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see `typedoc.json`)
 * so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import { env } from "node:process";

/**
 * Resolved at module load time. `true` when the hblog integration suite should run, `false` when it should be skipped. Driven solely by `HBLOG_INTEGRATION === "1"`;
 * there is no autodetection, so the suite is OFF by default. See the module-level documentation for the full resolution rules.
 */
export const hblogIntegrationEnabled: boolean = env["HBLOG_INTEGRATION"] === "1";
