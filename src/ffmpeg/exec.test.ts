/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/exec.test.ts: Unit tests for FfmpegExec - canned stdin, stdout collection, bundled result, abort cancellation.
 */
import { HbpuAbortError, isHbpuAbortReason } from "../util.ts";
import { describe, test } from "node:test";
import type { ExecResult } from "./exec.ts";
import { FfmpegExec } from "./exec.ts";
import { FfmpegOptions } from "./options.ts";
import type { Readable } from "node:stream";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { makeCodecs } from "./codecs.helpers.ts";
import { silentLog } from "../testing.helpers.ts";

// Construct a real `FfmpegOptions`. `ffmpegExec` resolves to the running Node binary so every test spawns Node with an inline `-e` script; the script determines
// per-test behavior. Hardware flags stay false because FfmpegExec doesn't read them and software-only configs exercise the spawn plumbing this suite covers.
function makeOptions(): FfmpegOptions {

  return new FfmpegOptions({

    codecSupport: makeCodecs({ ffmpegExec: process.execPath, ffmpegVersion: "test" }),
    debug: false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    log: silentLog(),
    name: (): string => "test"
  });
}

// Inline Node script that reads stdin and echoes it to stdout - lets us verify the canned-stdin path actually fed the child's stdin. Exits cleanly once stdin ends.
const ECHO_STDIN_SCRIPT = "process.stdin.on(\"data\", (c) => process.stdout.write(c)); process.stdin.on(\"end\", () => process.exit(0));";

// Inline Node script that emits a fixed marker to stdout and exits with the given code. Covers the "no stdin, collect stdout, get exit code" shape.
function emitThenExit(marker: string, exitCode = 0): string[] {

  return [ "-e", "process.stdout.write(" + JSON.stringify(marker) + "); setTimeout(() => process.exit(" + exitCode.toString() + "), 10);" ];
}

describe("FfmpegExec - canned stdin pattern", () => {

  test("stdin buffer is fed to the child and echoed stdout is collected via result()", async () => {

    const input = Buffer.from("hello world");

    await using exec = new FfmpegExec(makeOptions(), { args: [ "-e", ECHO_STDIN_SCRIPT ], stdin: input });

    const result: ExecResult = await exec.result();

    assert.deepEqual(result.stdout, input, "stdout should echo the canned stdin buffer byte-for-byte");
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitSignal, null);
  });

  test("empty stdin buffer is accepted and the child sees immediate EOF", async () => {

    // Empty input buffer should still drive the canned-stdin path: the child writes nothing, stdin closes on the next microtask, child exits cleanly.
    await using exec = new FfmpegExec(makeOptions(), { args: [ "-e", ECHO_STDIN_SCRIPT ], stdin: Buffer.alloc(0) });

    const result = await exec.result();

    assert.equal(result.stdout.length, 0, "empty stdin should produce empty stdout via the echo path");
    assert.equal(result.exitCode, 0);
  });
});

describe("FfmpegExec - streaming stdin pattern", () => {

  test("omitting stdin lets the caller drive the writable directly", async () => {

    // No canned stdin. The caller writes chunks progressively, ends the stream, and then reads the result.
    await using exec = new FfmpegExec(makeOptions(), { args: [ "-e", ECHO_STDIN_SCRIPT ] });

    exec.stdin.write(Buffer.from("alpha-"));
    exec.stdin.write(Buffer.from("beta"));
    exec.stdin.end();

    const result = await exec.result();

    assert.deepEqual(result.stdout, Buffer.from("alpha-beta"), "streamed stdin should flow through to stdout in write order");
    assert.equal(result.exitCode, 0);
  });
});

describe("FfmpegExec - stdout collection", () => {

  test("stdoutBuffer resolves with the complete output when the child emits without consuming stdin", async () => {

    await using exec = new FfmpegExec(makeOptions(), { args: emitThenExit("OUTPUT_MARKER") });

    const collected = await exec.stdoutBuffer;

    assert.equal(collected.toString(), "OUTPUT_MARKER", "stdoutBuffer should collect every byte the child emits");

    const result = await exec.result();

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, collected, "result().stdout should match the standalone stdoutBuffer read");
  });

  test("non-zero exit code is surfaced through result() without rejecting", async () => {

    await using exec = new FfmpegExec(makeOptions(), { args: emitThenExit("QUIET", 3) });

    const result = await exec.result();

    assert.equal(result.exitCode, 3);
    assert.equal(result.exitSignal, null);
    assert.equal(result.stdout.toString(), "QUIET");

    // The base class still marks the signal as aborted with "failed" on non-zero exit - result() does not hide that.
    assert.equal(exec.hasError, true);
  });
});

describe("FfmpegExec - abort cancellation", () => {

  test("aborting mid-execution terminates the child and the lifetime channels reflect the cause", async () => {

    // Stderr ready line, then idle indefinitely. Only abort drives termination. The script deliberately writes nothing to stdout: this test asserts the lifetime
    // channels (stdoutBuffer settles, signal.reason carries the cause, exited reports the kill), not byte content. Mixing a partial stdout write into the script
    // would tempt a content assertion that stdoutBuffer's contract does not guarantee - `stdoutBuffer` is the data channel, not a disposition sentinel.
    const script = [ "-e", "process.stderr.write(\"ready\\n\"); setInterval(() => {}, 100000);" ];

    await using exec = new FfmpegExec(makeOptions(), { args: script });

    // Wait for ready so the abort lands mid-execution rather than pre-spawn; without this, the abort could race the spawn and surface as `"failed"` instead.
    await exec.ready;

    exec.abort(new HbpuAbortError("shutdown"));

    const stdout = await exec.stdoutBuffer;
    const exit = await exec.exited;

    // Load-bearing invariants of the abort path, none of which concern the byte content of `stdout` - that is incidental to disposition and would be racy to
    // assert against.

    // 1. `stdoutBuffer` always settles to a Buffer, never rejects, never hangs. Callers may `await` it without a try/catch on every code path.
    assert.ok(Buffer.isBuffer(stdout), "stdoutBuffer must settle to a Buffer instance regardless of how the run ended");

    // 2. The lifetime signal carries the caller's abort reason verbatim. This is the SSOT for "why did this end" - any caller that needs to discriminate disposition
    //    consults `signal.reason`, not the byte content of stdout.
    assert.equal(isHbpuAbortReason(exec.signal.reason, "shutdown"), true);

    // 3. The OS-level exit info is populated. Kill-driven exit surfaces either a signal or a non-zero code; this is the second SSOT for disposition, complementing
    //    `signal.reason` with the syscall-level facts.
    assert.ok((exit.exitSignal !== null) || (exit.exitCode !== 0), "kill-driven exit should expose either a signal or a non-zero exit code");
  });
});

describe("FfmpegExec - result bundle shape", () => {

  test("stderrLog on the result is a snapshot of the accumulated lines at exit", async () => {

    // Write one line to stderr and exit cleanly. The base class's stderr buffering produces a single accumulated line.
    const script = [ "-e", "process.stderr.write(\"diagnostic\\n\"); setTimeout(() => process.exit(0), 10);" ];

    await using exec = new FfmpegExec(makeOptions(), { args: script });

    const result = await exec.result();

    assert.ok(result.stderrLog.includes("diagnostic"), "result.stderrLog should carry the accumulated stderr lines at exit");
  });
});

describe("FfmpegExec - stdoutBuffer abnormal-termination contract", () => {

  test("stdoutBuffer resolves with an empty buffer when the underlying stdout is destroyed with an error", async () => {

    // The load-bearing invariant on `#collectStdout`: the try/catch around `node:stream/consumers buffer()` resolves to `Buffer.alloc(0)` when the stream errors or
    // is destroyed mid-read. Callers reading `stdoutBuffer` always see a Buffer - never a rejection - and an empty payload signals "this run produced nothing
    // salvageable; route decisions through exitCode and exitSignal instead of through partial bytes."
    //
    // To exercise the catch branch specifically (distinct from the abort-kill path already covered), we destroy the underlying stdout Readable with an error after
    // a known prefix has been written. `stream.destroy(error)` is Node's canonical way to surface a stream error; the consumer rejects with the destroy error and
    // the collector's catch branch yields the empty buffer.
    //
    // Accessing `_stdout` from outside the subclass is unorthodox but intentional: the test exercises the internal collector's error-handling branch, which only
    // fires when the readable surfaces an error. The structural cast reaches past the public `declare readonly stdout: never` narrowing that `FfmpegExec` applies
    // to its own public surface.
    const script = [ "-e", "process.stderr.write(\"ready\\n\"); process.stdout.write(\"prefix-bytes\"); setInterval(() => {}, 10_000);" ];

    await using exec = new FfmpegExec(makeOptions(), { args: script });

    await exec.ready;

    // Give the child's stdout write a turn to reach the exec's buffered readable before we destroy it.
    await delay(30);

    const readable = (exec as unknown as { _stdout: Readable })._stdout;

    readable.destroy(new Error("synthetic stdout error"));

    // stdoutBuffer must resolve - never reject - with an empty buffer because the stream errored before completing. The contract is all-or-nothing: callers consult
    // exitCode and exitSignal to discriminate "no output" from "the run was aborted." An empty result on an aborted run signals "nothing salvageable" rather than
    // "the child wrote nothing."
    const collected = await exec.stdoutBuffer;

    assert.equal(collected.length, 0,
      "stdoutBuffer must resolve with an empty buffer when the underlying stdout is destroyed with an error; " +
      "the catch branch in #collectStdout returns Buffer.alloc(0) on stream error");
  });
});
