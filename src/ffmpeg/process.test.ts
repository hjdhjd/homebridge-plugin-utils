/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/process.test.ts: Unit tests for the FfmpegProcess base class - spawn-on-construction, composed signal lifecycle, ready/exited promises, reason-based teardown,
 * derived getters, startup timeout, and AsyncDisposable semantics.
 */
import type { CapturingLog, TestLogEntry } from "../testing.helpers.ts";
import { HbpuAbortError, isHbpuAbortReason } from "../util.ts";
import { describe, test } from "node:test";
import { FfmpegOptions } from "./options.ts";
import { FfmpegProcess } from "./process.ts";
import type { FfmpegProcessExitInfo } from "./process.ts";
import assert from "node:assert/strict";
import { capturingLog } from "../testing.helpers.ts";
import { setTimeout as delay } from "node:timers/promises";
import { makeCodecs } from "./codecs.helpers.ts";
import { once } from "node:events";

// Overrides accepted by {@link makeOptions}. Narrow keys cover only the fields FfmpegProcess actually reads, so tests can exercise individual branches (e.g.,
// `verbose: true` to cover the live-log path) without reconstructing the full options shape each time.
interface TestOptionsOverrides {

  debug?: boolean;
  ffmpegExec?: string;
  verbose?: boolean;
}

// Construct a real `FfmpegOptions` backed by a `makeCodecs` codec snapshot. `ffmpegExec` defaults to `process.execPath` so every test resolves to the running
// Node binary; hardware flags are both `false` because `FfmpegProcess` doesn't read them and software-only configs exercise the live-log / spawn plumbing that this
// suite cares about. Using the real constructor means the test reads hit the real getters on the real class - stub drift is impossible.
function makeOptions(logger: CapturingLog = capturingLog(), overrides: TestOptionsOverrides = {}): FfmpegOptions {

  return new FfmpegOptions({

    codecSupport: makeCodecs({

      ffmpegExec: overrides.ffmpegExec ?? process.execPath,
      ffmpegVersion: "test",
      verbose: overrides.verbose ?? false
    }),
    debug: overrides.debug ?? false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    log: logger,
    name: (): string => "test"
  });
}

// Inline Node script - produces a single stderr line, then exits with the given code after an optional delay. Used throughout the suite as a deterministic stand-in for
// FFmpeg's "emit to stderr, run briefly, exit" shape.
function stderrThenExit(exitCode = 0, delayMs = 10, message = "hello"): string[] {

  const script = "process.stderr.write(" + JSON.stringify(message + "\n") + "); setTimeout(() => process.exit(" + exitCode.toString() + "), " + delayMs.toString() + ");";

  return [ "-e", script ];
}

// Inline Node script - emits a stderr line, then idles indefinitely. Used to exercise abort-while-running flows. The child is kept alive by a long-lived interval so the
// parent's abort is the only way for it to exit.
function stderrThenIdle(message = "ready"): string[] {

  return [ "-e", "process.stderr.write(" + JSON.stringify(message + "\n") + "); setInterval(() => {}, 100000);" ];
}

// Inline Node script - writes NOTHING to stderr and idles. Used to exercise the startup-timeout path.
function silentIdle(): string[] {

  return [ "-e", "setInterval(() => {}, 100000);" ];
}

describe("FfmpegProcess - construction and readiness", () => {

  test("spawns on construction and resolves ready on first stderr output", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle("booting") });

    // If construction did not spawn, this await would never resolve. A short timer in the body would also hang.
    await proc.ready;

    assert.equal(proc.aborted, false);
    assert.equal(proc.hasError, false);
    assert.equal(proc.isTimedOut, false);
    assert.ok(proc.stderrLog.includes("booting"));
  });

  test("exited resolves with clean exit info when the child exits with code 0", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenExit(0, 10) });

    const exit: FfmpegProcessExitInfo = await proc.exited;

    assert.equal(exit.exitCode, 0);
    assert.equal(exit.exitSignal, null);

    // After a natural clean exit, signal aborts with reason "closed" - hasError must be false.
    assert.equal(proc.aborted, true);
    assert.equal(proc.hasError, false);
    assert.equal(isHbpuAbortReason(proc.signal.reason, "closed"), true);
  });

  test("exited resolves with non-zero code and signal.reason names the failure", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenExit(3, 10) });

    const exit = await proc.exited;

    assert.equal(exit.exitCode, 3);
    assert.equal(exit.exitSignal, null);

    assert.equal(proc.hasError, true);
    assert.equal(isHbpuAbortReason(proc.signal.reason, "failed"), true);
  });

  test("stderrLog accumulates lines across chunks and preserves them after exit", async () => {

    // Multi-line stderr output, all before exit.
    const script = [ "-e",
      "process.stderr.write(\"alpha\\nbeta\\n\"); process.stderr.write(\"gamma\\n\"); setTimeout(() => process.exit(0), 10);" ];

    await using proc = new FfmpegProcess(makeOptions(), { args: script });

    await proc.exited;

    assert.deepEqual(proc.stderrLog.slice(0, 3), [ "alpha", "beta", "gamma" ]);
  });

  test("args are captured immutably at construction - caller-side mutations do not leak", async () => {

    const logger = capturingLog();
    const args = [ "-e", "process.stderr.write(\"x\\n\"); setTimeout(() => process.exit(1), 20);" ];

    await using proc = new FfmpegProcess(makeOptions(logger), { args });

    // Freezing a copy of the caller's args at assignment means later caller-side mutation cannot leak into the stored `args` or into teardown logging.
    args.push("SHOULD-NEVER-APPEAR");

    await proc.exited;

    const commandLine = logger.entries.flatMap((entry) => entry.params).filter((param) => typeof param === "string").join(" ");

    assert.ok(!commandLine.includes("SHOULD-NEVER-APPEAR"), "caller-side args mutation must not leak into any log line");
  });
});

describe("FfmpegProcess - abort paths", () => {

  test("abort() with no reason defaults to HbpuAbortError(shutdown)", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

    await proc.ready;

    proc.abort();

    await proc.exited;

    assert.equal(isHbpuAbortReason(proc.signal.reason, "shutdown"), true);
  });

  test("abort() passes explicit HbpuAbortError reasons through unchanged", async () => {

    const reasons = [ "closed", "failed", "replaced", "shutdown", "timeout" ] as const;

    for(const reason of reasons) {

      // Each case runs its own process since abort is one-shot per instance. The `await using` declaration releases the prior iteration's process before the next
      // iteration constructs a new one.
      // eslint-disable-next-line no-await-in-loop
      await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

      // eslint-disable-next-line no-await-in-loop
      await proc.ready;

      const error = new HbpuAbortError(reason);

      proc.abort(error);

      // eslint-disable-next-line no-await-in-loop
      await proc.exited;

      assert.equal(proc.signal.reason, error, "reason should be the exact error instance passed to abort()");
      assert.equal(isHbpuAbortReason(proc.signal.reason, reason), true);
    }
  });

  test("re-abort guard: abort() before exit keeps the original reason despite kill-driven exit", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

    await proc.ready;

    const reason = new HbpuAbortError("replaced");

    proc.abort(reason);

    // The child is now being killed by Node's spawn({ signal, killSignal }). When the kill-driven "exit" fires, #onExit would normally abort with "failed" because
    // the exit code is non-zero, but the re-abort guard preserves our "replaced" reason.
    const exit = await proc.exited;

    assert.equal(proc.signal.reason, reason);
    assert.equal(isHbpuAbortReason(proc.signal.reason, "replaced"), true);
    assert.equal(proc.hasError, false, "hasError must not trigger just because the kill produced a nonzero exit");

    // The exit info itself still reflects what actually happened at the syscall level - the abort-guard preserves the reason, not the exit code.
    assert.ok((exit.exitSignal !== null) || (exit.exitCode !== 0), "kill-driven exit should surface either a signal or a non-zero exit code");
  });

  test("parent signal propagates: aborting the parent aborts the process with the parent's reason", async () => {

    const parent = new AbortController();
    const parentReason = new HbpuAbortError("shutdown");

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle(), signal: parent.signal });

    await proc.ready;

    parent.abort(parentReason);

    await proc.exited;

    // AbortSignal.any preserves the first-aborting source's reason, so the process's composed signal should carry exactly the parent's reason.
    assert.equal(proc.signal.reason, parentReason);
    assert.equal(isHbpuAbortReason(proc.signal.reason, "shutdown"), true);
  });

  test("a pre-aborted parent signal aborts the process immediately on construction", async () => {

    const parent = new AbortController();
    const parentReason = new HbpuAbortError("shutdown");

    parent.abort(parentReason);

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle(), signal: parent.signal });

    assert.equal(proc.aborted, true, "composed signal should be aborted the moment the constructor returns");

    await assert.rejects(proc.ready, (error: unknown) => error === parentReason);
  });

  test("abort() is idempotent - the first reason wins and subsequent calls are no-ops", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

    await proc.ready;

    const first = new HbpuAbortError("replaced");
    const second = new HbpuAbortError("shutdown");

    proc.abort(first);

    // Second call must not overwrite the first reason. The class contract promises "safe to call more than once; subsequent calls are no-ops".
    proc.abort(second);

    await proc.exited;

    assert.equal(proc.signal.reason, first, "the first abort reason must persist through subsequent abort() calls");
    assert.equal(isHbpuAbortReason(proc.signal.reason, "replaced"), true);
  });
});

describe("FfmpegProcess - derived getters", () => {

  test("isTimedOut returns true for HbpuAbortError(timeout)", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

    await proc.ready;

    proc.abort(new HbpuAbortError("timeout"));

    await proc.exited;

    assert.equal(proc.isTimedOut, true);
    assert.equal(proc.hasError, false);
  });

  test("isTimedOut returns true for a platform TimeoutError as the signal.reason", async () => {

    const outerTimeout = AbortSignal.timeout(5);

    // Wait for the timeout to fire, then pass its reason directly to abort() to simulate a platform-timeout-driven teardown. `events.once` on the abort signal is
    // the modern Node idiom - no manual addEventListener + Promise wrapper.
    await once(outerTimeout, "abort");

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

    await proc.ready;

    proc.abort(outerTimeout.reason);

    await proc.exited;

    assert.equal(proc.isTimedOut, true, "platform TimeoutError should be recognized as a timeout by isTimedOut");
  });

  test("hasError returns true only for HbpuAbortError(failed)", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenExit(1, 10) });

    await proc.exited;

    assert.equal(proc.hasError, true);
    assert.equal(proc.isTimedOut, false);
  });

  test("aborted mirrors signal.aborted", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

    // Wait for ready so the child has definitely exec'd - we want to exercise the "abort a running child" transition, not a spawn/abort race.
    await proc.ready;

    assert.equal(proc.aborted, false);
    assert.equal(proc.signal.aborted, false);

    proc.abort();

    assert.equal(proc.aborted, true);
    assert.equal(proc.signal.aborted, true);

    await proc.exited;
  });
});

describe("FfmpegProcess - startup timeout", () => {

  test("aborts with HbpuAbortError(timeout) when no stderr arrives within the window", async () => {

    await using proc = new FfmpegProcess(makeOptions(), { args: silentIdle(), startupTimeout: 50 });

    // The process never writes to stderr, so ready should never resolve - it should reject with the timeout reason once the watchdog fires.
    await assert.rejects(proc.ready, (error: unknown) => isHbpuAbortReason(error, "timeout"));

    assert.equal(proc.isTimedOut, true);

    await proc.exited;
  });

  test("does not fire once ready has resolved", async () => {

    // Longer timeout than the stderr delay - the process writes to stderr before the watchdog fires, so the watchdog must remain silent.
    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle(), startupTimeout: 500 });

    await proc.ready;

    // Wait past the watchdog window. If the watchdog misbehaves it would abort here.
    await delay(600);

    assert.equal(proc.aborted, false, "watchdog must not fire once we are already past the first-stderr milestone");
    assert.equal(proc.isTimedOut, false);
  });
});

describe("FfmpegProcess - asyncDispose", () => {

  test("await using tears down the child by the time the block exits", async () => {

    let exitResolved = false;

    {

      await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

      await proc.ready;

      // Wire the flag through `exited` so we can assert below that dispose awaited actual termination.
      void proc.exited.then(() => {

        exitResolved = true;
      });

      // Block ends here; AsyncDisposable runs, aborts the child, awaits exit.
    }

    // After the `await using` scope exits, proc has been disposed. We run a microtask to give the `.then` handler above a chance to fire; then assert.
    await Promise.resolve();

    assert.equal(exitResolved, true, "[Symbol.asyncDispose] must await `exited` before returning");
  });

  test("explicit asyncDispose aborts and waits for exit", async () => {

    // The explicit `[Symbol.asyncDispose]()` call below is the line under test - we want to verify the dispose method works when invoked directly. `await using` is
    // a belt-and-suspenders safety net so a future regression that lets `proc.ready` reject (e.g., a startup timeout, an ENOENT path) does not leak the proc. When
    // dispose has already run by the time the block exits, the auto-dispose is a no-op because abort is idempotent and `exited` has already settled.
    await using proc = new FfmpegProcess(makeOptions(), { args: stderrThenIdle() });

    await proc.ready;
    await proc[Symbol.asyncDispose]();

    assert.equal(proc.aborted, true);
    assert.equal(isHbpuAbortReason(proc.signal.reason, "shutdown"), true);
  });
});

describe("FfmpegProcess - spawn failure", () => {

  test("ENOENT: exited rejects and signal.reason is HbpuAbortError(failed)", async () => {

    const logger = capturingLog();
    const options = makeOptions(logger, { ffmpegExec: "/definitely/not/a/real/binary/ffmpeg-" + Date.now().toString() });

    await using proc = new FfmpegProcess(options, { args: [] });

    await assert.rejects(proc.ready, (error: unknown) => isHbpuAbortReason(error, "failed"));
    await assert.rejects(proc.exited, (error: unknown) => isHbpuAbortReason(error, "failed"));

    assert.equal(proc.hasError, true);

    // The spawn-error path logs the generic "FFmpeg failed to start" diagnostic at error level.
    const errorLogs = logger.entries.filter((e) => e.level === "error");

    assert.ok(errorLogs.some((entry) => entry.message.includes("FFmpeg failed to start")), "ENOENT should log an error-level diagnostic");
  });
});

describe("FfmpegProcess - live-log paths", () => {

  // Helper: run a short-lived process with the given options overrides and return the captured log entries. Every case in this block wants the same setup - construct,
  // wait for exit, inspect entries - so extracting it keeps each test focused on its assertion.
  async function runForLogs(overrides: TestOptionsOverrides, args: string[]): Promise<readonly TestLogEntry[]> {

    const logger = capturingLog();

    await using proc = new FfmpegProcess(makeOptions(logger, overrides), { args });

    await proc.exited.catch(() => { /* Exit outcome is not the subject under test here. */ });

    return logger.entries;
  }

  test("verbose: true routes stderr lines to log.info", async () => {

    const entries = await runForLogs({ verbose: true }, stderrThenExit(0, 10, "VISIBLE_LINE"));

    assert.ok(entries.some((entry) => (entry.level === "info") && (entry.message === "VISIBLE_LINE")),
      "a verbose process must surface its stderr line via log.info");
  });

  test("debug: true routes stderr lines to log.info", async () => {

    const entries = await runForLogs({ debug: true }, stderrThenExit(0, 10, "VISIBLE_LINE"));

    assert.ok(entries.some((entry) => (entry.level === "info") && (entry.message === "VISIBLE_LINE")),
      "a debug-enabled process must surface its stderr line via log.info");
  });

  test("-loglevel in args routes stderr lines to log.info", async () => {

    // Node does not understand `-loglevel`; the `--` separator tells Node that everything after it is positional argv. Our class still sees `-loglevel` in
    // `args.includes("-loglevel")`, which is exactly the decision the live-log branch is gated on.
    const entries = await runForLogs({}, [ ...stderrThenExit(0, 10, "VISIBLE_LINE"), "--", "-loglevel", "info" ]);

    assert.ok(entries.some((entry) => (entry.level === "info") && (entry.message === "VISIBLE_LINE")),
      "a process spawned with -loglevel in args must surface stderr via log.info regardless of verbose/debug flags");
  });

  test("default configuration keeps stderr out of log.info and at debug only", async () => {

    const entries = await runForLogs({}, stderrThenExit(0, 10, "QUIET_LINE"));

    // Under defaults, stderr lines are accumulated to stderrLog but NOT mirrored to log.info. The only info-level entry that should appear is nothing at all.
    const infoLines = entries.filter((entry) => (entry.level === "info") && (entry.message === "QUIET_LINE"));

    assert.equal(infoLines.length, 0, "default (non-verbose, non-debug, no -loglevel) must not route stderr to log.info");
  });

  test("construction-time command log fires at info when live-log is active", async () => {

    const entries = await runForLogs({ verbose: true }, stderrThenExit(0, 10));

    const commandLogs = entries.filter((entry) => entry.message.startsWith("FFmpeg command (version:"));

    assert.ok(commandLogs.some((entry) => entry.level === "info"), "the construction-time command log must fire at info under live-log");
    assert.ok(!commandLogs.some((entry) => entry.level === "debug"), "no debug duplicate of the command log should appear under live-log");
  });

  test("construction-time command log fires at debug when live-log is inactive", async () => {

    const entries = await runForLogs({}, stderrThenExit(0, 10));

    const commandLogs = entries.filter((entry) => entry.message.startsWith("FFmpeg command (version:"));

    assert.ok(commandLogs.some((entry) => entry.level === "debug"), "the construction-time command log must fire at debug when live-log is inactive");
    assert.ok(!commandLogs.some((entry) => entry.level === "info"), "no info duplicate of the command log should appear outside live-log");
  });
});

describe("FfmpegProcess - teardown logging", () => {

  // Helper: abort with a "failed" reason carrying the supplied `cause`, then return the error-level entries emitted during teardown. Encapsulates the "abort a running
  // child with a crafted cause and read the log" pattern shared by every test in this block.
  async function failWithCause(cause: unknown): Promise<readonly TestLogEntry[]> {

    const logger = capturingLog();

    await using proc = new FfmpegProcess(makeOptions(logger), { args: stderrThenIdle() });

    await proc.ready;

    proc.abort(new HbpuAbortError("failed", { cause }));

    await proc.exited;

    return logger.entries.filter((entry) => entry.level === "error");
  }

  test("FfmpegProcessExitInfo cause renders as exit-code context", async () => {

    const errorEntries = await failWithCause({ exitCode: 42, exitSignal: null });

    // The first error log embeds the describeCause output as its `%s` parameter. We look across all params for the expected fragment to stay robust to format tweaks.
    const fragments = errorEntries.flatMap((entry) => entry.params).filter((param) => typeof param === "string");

    assert.ok(fragments.some((fragment) => fragment.includes("exit code 42")), "exit-info cause must render as \"exit code N\"");
  });

  test("exit-signal-only cause renders as signal context", async () => {

    const errorEntries = await failWithCause({ exitCode: null, exitSignal: "SIGKILL" });
    const fragments = errorEntries.flatMap((entry) => entry.params).filter((param) => typeof param === "string");

    assert.ok(fragments.some((fragment) => fragment.includes("signal SIGKILL")), "signal-only exit-info cause must render as \"signal S\"");
  });

  test("Error cause renders via the error message", async () => {

    const errorEntries = await failWithCause(new Error("underlying boom"));
    const fragments = errorEntries.flatMap((entry) => entry.params).filter((param) => typeof param === "string");

    assert.ok(fragments.some((fragment) => fragment.includes("underlying boom")), "Error cause must surface its .message through the teardown log");
  });

  test("null cause does not crash teardown", async () => {

    // A null cause must not crash the teardown logger; isExitInfoShape's object/null guard keeps the "in" check from throwing on a null cause.
    const errorEntries = await failWithCause(null);
    const fragments = errorEntries.flatMap((entry) => entry.params).filter((param) => typeof param === "string");

    assert.ok(fragments.some((fragment) => fragment === "unknown"), "null cause must render as \"unknown\" without crashing");
  });

  test("primitive cause does not crash teardown", async () => {

    // Covers the same class of bug for numbers, strings, booleans - anything where the `in` operator would throw. A single representative check is enough; the
    // isExitInfoShape guard covers the whole "not an object" branch uniformly.
    const errorEntries = await failWithCause(42);
    const fragments = errorEntries.flatMap((entry) => entry.params).filter((param) => typeof param === "string");

    assert.ok(fragments.some((fragment) => fragment === "unknown"), "primitive cause must render as \"unknown\" without crashing");
  });

  test("malformed cause with wrong property types does not masquerade as valid exit info", async () => {

    // Object shape resembles FfmpegProcessExitInfo but the property types do not match (exitCode must be number|null, exitSignal must be string|null). The type guard
    // must reject this, otherwise describeCause would coerce the values into a nonsense log line like "exit code [object Object]". Regression test: the guard promises
    // property types at the type level; its runtime check must honor that promise.
    const errorEntries = await failWithCause({ exitCode: "not-a-number", exitSignal: 42 });
    const fragments = errorEntries.flatMap((entry) => entry.params).filter((param) => typeof param === "string");

    assert.ok(fragments.some((fragment) => fragment === "unknown"),
      "cause shapes that do not satisfy FfmpegProcessExitInfo's declared property types must fall through to \"unknown\"");
  });

  test("failed teardown dumps stderrLog at error level", async () => {

    const logger = capturingLog();
    const script = [ "-e", "process.stderr.write(\"diagnostic-line\\n\"); setInterval(() => {}, 100000);" ];

    await using proc = new FfmpegProcess(makeOptions(logger), { args: script });

    await proc.ready;

    proc.abort(new HbpuAbortError("failed", { cause: { exitCode: 1, exitSignal: null } }));

    await proc.exited;

    const errorEntries = logger.entries.filter((entry) => entry.level === "error");

    assert.ok(errorEntries.some((entry) => entry.message === "diagnostic-line"),
      "failed teardown must dump accumulated stderr lines at error level so operators see what ffmpeg said before dying");
  });

  test("a timeout teardown logs at warn by default", async () => {

    const logger = capturingLog();

    await using proc = new FfmpegProcess(makeOptions(logger), { args: stderrThenIdle() });

    await proc.ready;
    proc.abort(new HbpuAbortError("timeout"));
    await proc.exited;

    assert.ok(logger.entries.some((entry) => (entry.level === "warn") && entry.message.includes("stalled past its watchdog window")),
      "the base FfmpegProcess timeout teardown logs at warn");
  });
});

describe("FfmpegProcess - stderr trailing-buffer flush on exit", () => {

  test("partial stderr line with no terminating EOL is flushed to stderrLog on exit", async () => {

    // Write a complete line followed by a fragment that lacks a trailing EOL, then exit. The line-splitting loop in `#onStderrData` leaves the unterminated tail in the
    // internal buffer; the `#onExit` handler flushes it so the post-mortem record callers read through `stderrLog` is complete. Without that flush, the last thing
    // FFmpeg said before dying would silently vanish, which is exactly the diagnostic operators need most.
    const script = [ "-e", "process.stderr.write(\"complete\\nfragment-no-eol\"); setTimeout(() => process.exit(0), 10);" ];

    await using proc = new FfmpegProcess(makeOptions(), { args: script });

    await proc.exited;

    assert.ok(proc.stderrLog.includes("complete"), "complete lines must be present in stderrLog");
    assert.ok(proc.stderrLog.includes("fragment-no-eol"), "trailing unterminated fragment must be flushed to stderrLog on exit");
  });
});

describe("FfmpegProcess - stdin error handling", () => {

  // We exercise the `#onStdinError` branches by emitting synthetic `"error"` events directly on `proc.stdin`. The handler's contract is a pure decision: EPIPE swallow
  // vs. error-level log. That decision is what we test - not Node's underlying stream emission rules, which vary across kernel paths, write sizes, and stdio detach
  // timing. Emitting directly isolates the handler from those variables and keeps the test deterministic.
  test("EPIPE on stdin is swallowed without logging", async () => {

    const logger = capturingLog();

    await using proc = new FfmpegProcess(makeOptions(logger), { args: stderrThenIdle() });

    await proc.ready;

    // FFmpeg's stdin closing after the child exits is the canonical EPIPE source in production. The handler treats EPIPE as expected and never logs.
    proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    proc.abort();
    await proc.exited;

    const errorEntries = logger.entries.filter((entry) => (entry.level === "error") && entry.message.startsWith("FFmpeg error:"));

    assert.equal(errorEntries.length, 0, "EPIPE on stdin must be swallowed without emitting an error-level log line");
  });

  test("non-EPIPE stdin error is logged at error level", async () => {

    const logger = capturingLog();

    await using proc = new FfmpegProcess(makeOptions(logger), { args: stderrThenIdle() });

    await proc.ready;

    // Anything that is not EPIPE is unexpected and gets logged. We use a clearly non-EPIPE message so the EPIPE-substring check at the handler's branch point cannot
    // false-match - it would be a real regression if a future change to the EPIPE substring made unrelated errors look like EPIPE and get swallowed.
    proc.stdin.emit("error", new Error("synthetic stdin failure"));

    proc.abort();
    await proc.exited;

    const errorEntries = logger.entries.filter((entry) => (entry.level === "error") && entry.message.startsWith("FFmpeg error:"));

    assert.ok(errorEntries.some((entry) => entry.params.some((param) => (typeof param === "string") && param.includes("synthetic stdin failure"))),
      "a non-EPIPE stdin error must surface at error level so operators see the unexpected failure");
  });
});
