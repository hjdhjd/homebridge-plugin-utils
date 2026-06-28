/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/integration.test.ts: Live end-to-end hblog integration suite, gated on HBLOG_INTEGRATION=1 and a real homebridge-config-ui-x server plus ~/.hblog.json.
 */
import type { CliStream, RunHblogOptions } from "./cli-run.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { hblogIntegrationEnabled } from "./integration.helpers.ts";
import { homedir } from "node:os";
import { runHblog } from "./cli-run.ts";

// A capturing CliStream that records every chunk and never colors. Unlike the unit tests' CaptureStream there is no synthetic write failure here - this suite drives the
// real pipeline, so the only EPIPE trap interaction is the no-op `on`/`off` registration the run performs. `isTTY` is false so the default color decision strips ANSI,
// and `write` always reports success so the run never sees backpressure from this sink.
class CapturedStream implements CliStream {

  public readonly chunks: string[] = [];
  public readonly isTTY = false;

  public off(): void {

    // The EPIPE trap removes its listener on teardown; a captured stream has no real event source, so removal is a no-op.
  }

  public on(): void {

    // The EPIPE trap registers an error listener; a captured stream never emits one, so registration is a no-op.
  }

  public get text(): string {

    return this.chunks.join("");
  }

  public write(chunk: string): boolean {

    this.chunks.push(chunk);

    return true;
  }
}

// Poll a captured stream until it has received at least one chunk or the time budget is exhausted. This is real network I/O, so a microtask flush is not enough - we
// await a real timer between polls. Used by the follow tests to know the live tail has produced output before we send the SIGINT that tears it down.
async function waitForOutput(stream: CapturedStream, attempts = 100, intervalMs = 100): Promise<void> {

  for(let attempt = 0; attempt < attempts; attempt++) {

    if(stream.chunks.length > 0) {

      return;
    }

    // eslint-disable-next-line no-await-in-loop
    await delay(intervalMs);
  }
}

// Build the live RunHblogOptions for a given argument vector. We deliberately leave `fetch`, `socketFactory`, `readFile`, and `stat` at their real defaults so the run
// uses the actual `~/.hblog.json`, the real environment, and the real homebridge-config-ui-x server - this suite's whole purpose is to exercise the production
// transports, config resolution, and credential derivation that the unit fakes cannot model. Only the streams are captured so assertions can inspect what was emitted.
function liveOptions(argv: readonly string[]): { options: RunHblogOptions; stderr: CapturedStream; stdout: CapturedStream } {

  const stderr = new CapturedStream();
  const stdout = new CapturedStream();

  const options: RunHblogOptions = {

    argv,
    cwd: process.cwd(),
    env: process.env,
    homedir: homedir(),
    stderr,
    stdout
  };

  return { options, stderr, stdout };
}

// This suite drives the REAL pipeline through `runHblog` against a live homebridge-config-ui-x server, using the real `~/.hblog.json` and the real transports. It is the
// missing safety net for the class of bug where a unit fake did not model real server behavior (bodyless-POST content-type, the info-vs-null level convention, the
// follow-history stitch). It is OFF by default and runs only when `HBLOG_INTEGRATION=1` is set; see `integration.helpers.ts` for the gate. Every assertion is tolerant of
// server state: it asserts shape, exit codes, and the no-false-warning contract, never specific log content (no hardcoded plugin names or messages), because the live
// log's contents are not under the test's control.
describe("hblog integration (live server)", { skip: !hblogIntegrationEnabled }, () => {

  // History mode pulls the whole REST log file, authenticates, downloads, and parses it. `--json` makes each output line a parseable record so we can assert the parse
  // shape end to end. Pulling the entire file is the documented cost of `-n`, so this test carries a long timeout.
  test("history (-n) authenticates, downloads, and parses real log lines", { timeout: 120000 }, async () => {

    const { options, stdout } = liveOptions([ "-n", "5", "--json" ]);
    const code = await runHblog(options);

    assert.equal(code, 0, "a completed history retrieval against the live server must exit 0");

    const lines = stdout.text.split("\n").filter((line) => line.length > 0);
    const records = lines.map((line) => JSON.parse(line) as { plugin: unknown; raw: unknown });

    assert.ok(records.length >= 1, "history mode must produce at least one parsed record");
    assert.ok(records.every((record) => typeof record.raw === "string"), "every record must carry a string raw line");
    assert.ok(records.some((record) => record.plugin !== null), "at least one record must be a formatted line with a non-null plugin");
  });

  // Follow mode opens the live socket, replays the seed window, and tails indefinitely. We wait for the first output (the seed), then drive a SIGINT and confirm the run
  // tears down cleanly with exit 0 and that at least one line reached stdout.
  test("follow (-f) streams the live seed and tears down cleanly on SIGINT", { timeout: 30000 }, async () => {

    const { options, stdout } = liveOptions(["-f"]);
    const run = runHblog(options);

    await waitForOutput(stdout);
    process.emit("SIGINT");

    const code = await run;

    assert.equal(code, 0, "a clean SIGINT-terminated follow must exit 0");
    assert.ok(stdout.text.split("\n").some((line) => line.length > 0), "follow mode must stream at least one line before teardown");
  });

  // A level filter on a colored server log must filter normally and must NOT trip the FORCE_COLOR advisory. The advisory fires only when the server's log is
  // color-stripped (every formatted line resolves to a null level); a colored log resolves uncolored messages to "info", so the filter applies and no warning should
  // appear. This is the regression guard for the info-vs-null level bug, exercised end to end against the real server's coloring.
  test("level filter on a colored server filters without a FORCE_COLOR warning", { timeout: 30000 }, async () => {

    const { options, stderr, stdout } = liveOptions([ "-l", "info", "-f" ]);
    const run = runHblog(options);

    await waitForOutput(stdout);
    process.emit("SIGINT");

    const code = await run;

    assert.equal(code, 0, "a clean SIGINT-terminated level-filtered follow must exit 0");
    assert.ok(!stderr.text.includes("FORCE_COLOR"), "a colored server log must not trip the FORCE_COLOR advisory");
    assert.ok(stdout.text.split("\n").some((line) => line.length > 0), "the level filter must still stream at least one line");
  });
});
