/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/integration.helpers.ts: Gate predicate for the FFmpeg integration test suites.
 */

/**
 * Resolves the boolean that gates the FFmpeg integration test suites (`codecs.test.ts`, `options.test.ts`). The resolution is sticky: it runs once at module load and
 * the result is reused for every `describe` skip predicate that imports it.
 *
 * Two inputs feed the decision, in this order of precedence:
 *
 * 1. The `FFMPEG_INTEGRATION` environment variable, when set, wins. `"1"` forces the integration suites on (useful in CI matrices where we want a hard contract that the
 *    runner has FFmpeg). `"0"` forces them off (useful when FFmpeg is present but the run should skip integration for some other reason - container quirks, asan
 *    overhead, an active reproduction harness). Any other value falls through to autodetection.
 *
 * 2. With no override, we probe for an FFmpeg binary on PATH via a synchronous `ffmpeg -version` spawn. This is the regular-development path: if the host has FFmpeg
 *    installed, the integration suites run as part of the default `npm run test` invocation. If it does not, those suites quietly skip.
 *
 * The probe is synchronous because `describe` evaluates its `skip` option at registration time, not asynchronously, so the predicate has to be a plain boolean. The
 * spawn is cheap (sub-100ms on a warm system) and Node's module cache ensures it runs exactly once even if multiple test files import this helper.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see `typedoc.json`)
 * so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import { env } from "node:process";
import { spawnSync } from "node:child_process";

// Probe for an FFmpeg binary on PATH by spawning `ffmpeg -version`. We treat any non-zero exit, signal termination, or spawn error (ENOENT, EACCES) as "no usable
// FFmpeg" - the integration suites need a working binary, not just a discoverable name. stdio is fully ignored so the probe stays silent during test startup.
const probeFfmpegAvailable = (): boolean => {

  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });

  return !result.error && (result.status === 0);
};

/**
 * Resolved at module load time. `true` when the FFmpeg integration suites should run, `false` when they should be skipped. See the module-level documentation for the
 * full resolution rules.
 */
export const ffmpegIntegrationEnabled: boolean = ((): boolean => {

  const override = env["FFMPEG_INTEGRATION"];

  if(override === "1") {

    return true;
  }

  if(override === "0") {

    return false;
  }

  return probeFfmpegAvailable();
})();
