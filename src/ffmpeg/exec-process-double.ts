/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/exec-process-double.ts: An FFmpeg-free ExecProcess test double - a test drives its child's output, its exit and its spawn failure, with no child process
 * behind them.
 */

/**
 * An FFmpeg-free {@link ExecProcess} test double.
 *
 * A class that runs FFmpeg once has its hard cases in how the run ends: a clean exit with output to read, a failed exit whose stderr lines it reports, a spawn that
 * fails, a run its own signal ends. This module ships the double for those - a {@link TestExecProcess} a test drives one event at a time, with no child process
 * anywhere in sight - and a {@link TestExecProcessFactory} that builds one per `create` from the options and init the consumer passed and records them, so a suite
 * reads the command the consumer assembled from the recorded `args`.
 *
 * The double holds a {@link TestStreamingProcess} as the child it stands in for and adds no state machine of its own: its lifetime, its `stdin`, its levers, its
 * ending callbacks and its reading of the hardware decoder's refusal are the streaming double's, which settles, ends and marks as a real process does, and the
 * double adds only what a one-shot run adds over a streaming one, the collected stdout, the canned stdin and `result()`.
 *
 * Signatures come from the run's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
 * compiler saying so, and loading the double loads none of the run's spawn machinery.
 *
 * @module
 */
import type { ExecProcess, ExecProcessFactory, ExecResult, FfmpegExecInit } from "./exec.ts";
import type { FfmpegOptions } from "./options.ts";
import type { FfmpegProcessExitInfo } from "./process.ts";
import { TestStreamingProcess } from "./streaming-process-double.ts";
import type { Writable } from "node:stream";
import { buffer } from "node:stream/consumers";

/**
 * A driven, FFmpeg-free {@link ExecProcess} double: its child writes to stdout, exits or fails to spawn when a test says so, it records what a consumer writes to
 * stdin, and `result()` settles as the real run's does.
 *
 * The child is a {@link TestStreamingProcess} built from the init and the options, so the lifetime is the init's signal composed with the child's own, an exit ends
 * it as `"closed"` for an exit code of 0 and `"failed"` otherwise, a spawn failure ends it as `"failed"` with the spawn's error as its cause, a failed or timed-out
 * ending asks the init's `onFailed` or `onTimeout` with the lines {@link TestExecProcess.stderrLog} holds at that moment, a line reporting the hardware decoder's
 * refusal marks the options, and a refused GPU decode asks no callback, each as the streaming double states it. `result()` resolves with the exit information,
 * every byte the child wrote to stdout and the lines `stderrLog` holds once the child has exited, and rejects with the lifetime's reason when the spawn fails. A
 * canned `stdin` buffer in the init is written and `stdin` ended on the next microtask, unless the lifetime has ended by then, as the real run's is.
 *
 * Where it differs from the real run:
 *
 * - An abort kills a real child, which then exits on its own, while the double has no child to kill, so after an abort `result()` waits for
 *   {@link TestExecProcess.exit}, as a killed child's exit would end it. A test that stands in for a killed child pulls the exit lever with the exit a killed child
 *   reports, `{ exitCode: null, exitSignal: "SIGKILL" }`.
 * - A double built without options marks nothing when its lines report the refusal, and it reads every line it is handed, where the real run leaves unread the
 *   last line its child wrote with no line break, as the streaming double states.
 * - A second end of `stdin` that carries bytes reaches Node's uncaught-exception path as a write after the end, where the real run logs it.
 * - It logs nothing, a refused GPU decode's debug line among it.
 * - It does not catch a callback's throw, which therefore leaves the constructor, and so `create()`, under a parent signal already aborted, and reaches Node's
 *   uncaught-exception path under any later abort, where the real run logs it at error and runs its default report, as the streaming double states.
 * - It has no lever for the real run's startup timeout, so a suite reaches `onTimeout` by aborting the parent signal with `HbpuAbortError("timeout")`.
 *
 * @example
 *
 * ```ts
 * import { TestExecProcessFactory, expectAt } from "homebridge-plugin-utils/testing";
 *
 * const factory = new TestExecProcessFactory();
 * const snapshot = new SnapshotGrabber({ execFactory: factory, signal: controller.signal });
 * const pending = snapshot.grab();
 * const call = expectAt(factory.createCalls, 0, "the run the grabber started");
 *
 * // The command the grabber assembled, read without spawning anything, then the run's output and exit, exercised with no FFmpeg at all.
 * assert.ok(call.init.args?.includes("-frames:v"));
 * call.process.writeStdout(Buffer.from("invented image bytes"));
 * call.process.exit({ exitCode: 0, exitSignal: null });
 * await pending;
 * ```
 *
 * @see TestExecProcessFactory
 *
 * @category Testing
 */
export class TestExecProcess implements ExecProcess {

  /**
   * The abort signal representing this double's lifetime: the child's, composed from the init's signal and the child's own, as the real run composes its parent with
   * its own.
   */
  public readonly signal: AbortSignal;

  /**
   * The child's `stdin`, which records every chunk written to it in {@link TestExecProcess.stdinWrites}. It stays writable after the lifetime ends and is destroyed as
   * the child exits or fails to spawn.
   */
  public readonly stdin: Writable;

  readonly #child: TestStreamingProcess;

  readonly #stdout: Promise<Buffer>;

  /**
   * Construct a double.
   *
   * @param init           - Optional init options: the members of a consumer's {@link FfmpegExecInit} the double reads.
   * @param init.args      - The arguments the real run would be spawned with, handed to the child, whose reading of them decides whether a refusal its lines report
   *                         ends a failure ahead of `onFailed`.
   * @param init.onFailed  - Asked by the child when the lifetime ends with `HbpuAbortError("failed")`, as the real run asks it, unless the ending is a refused GPU
   *                         decode.
   * @param init.onTimeout - Asked by the child when the lifetime ends with `HbpuAbortError("timeout")`, as the real run asks it.
   * @param init.signal    - The parent signal the real run would compose into its lifetime: the one a consumer passes in its {@link FfmpegExecInit}. Aborting it ends
   *                         the double with that signal's reason.
   * @param init.stdin     - A canned buffer, written to `stdin` and the stream ended on the next microtask unless the lifetime has ended by then.
   * @param options        - Optional. The {@link FfmpegOptions} a line reporting the hardware decoder's refusal marks, handed to the child. A double built without
   *                         them marks nothing.
   */
  public constructor(init: Pick<FfmpegExecInit, "args" | "onFailed" | "onTimeout" | "signal" | "stdin"> = {}, options?: FfmpegOptions) {

    this.#child = new TestStreamingProcess(init, options);
    this.signal = this.#child.signal;
    this.stdin = this.#child.stdin;

    // One collection of the child's stdout, begun here as the real run begins its own, so every result() call joins the same bytes and nothing is read twice.
    this.#stdout = buffer(this.#child.stdout);

    if(init.stdin !== undefined) {

      const stdinBuffer = init.stdin;

      queueMicrotask(() => {

        if(this.signal.aborted) {

          return;
        }

        this.stdin.end(stdinBuffer);
      });
    }
  }

  /**
   * The stderr lines the stood-in child has written, held by the child. A suite sets them before it drives an ending, because a failed or timed-out ending hands its
   * callback the lines this holds at that moment, and `result()` carries the lines it holds once the child has exited. Setting lines shows the child has spawned and
   * reads them for the hardware decoder's refusal, as {@link TestStreamingProcess.stderrLog} states. Empty until a suite sets them.
   */
  public get stderrLog(): readonly string[] {

    return this.#child.stderrLog;
  }

  public set stderrLog(lines: readonly string[]) {

    this.#child.stderrLog = lines;
  }

  /**
   * Every chunk written to {@link TestExecProcess.stdin}, in the order written, the canned buffer among them: the bytes a consumer fed the run.
   */
  public get stdinWrites(): readonly Buffer[] {

    return this.#child.stdinWrites;
  }

  /**
   * Exit the child, as a real child's exit does. See {@link TestStreamingProcess.exit}.
   *
   * @param info - The exit code and signal the child exits with.
   *
   * @throws An `Error` once the child has exited or failed to spawn.
   */
  public exit(info: FfmpegProcessExitInfo): void {

    this.#child.exit(info);
  }

  /**
   * Fail the spawn, as a real run whose binary cannot be started does. See {@link TestStreamingProcess.failSpawn}.
   *
   * @param cause - The error the spawn failed with.
   *
   * @throws An `Error` once the child has written to stdout or had stderr lines set, and once it has exited or failed to spawn.
   */
  public failSpawn(cause: Error): void {

    this.#child.failSpawn(cause);
  }

  /**
   * Await the child's exit and answer the bundled result, as the real run's `result()` does: the exit information, every byte the child wrote to stdout and the lines
   * {@link TestExecProcess.stderrLog} holds. A repeated call answers the same bytes.
   *
   * @returns A promise resolving to the run's {@link ExecResult}, and rejecting with the lifetime's reason when the spawn failed.
   */
  public async result(): Promise<ExecResult> {

    const [ stdout, exit ] = await Promise.all([ this.#stdout, this.#child.exited ]);

    return { exitCode: exit.exitCode, exitSignal: exit.exitSignal, stderrLog: this.stderrLog, stdout };
  }

  /**
   * Write bytes to the child's stdout, as a real child's output does. See {@link TestStreamingProcess.writeStdout}.
   *
   * @param bytes - The bytes the child writes.
   *
   * @throws An `Error` once the child has exited or failed to spawn.
   */
  public writeStdout(bytes: Buffer): void {

    this.#child.writeStdout(bytes);
  }
}

/**
 * An {@link ExecProcessFactory} double that records every `create` call and answers a fresh {@link TestExecProcess} over the options and the init the consumer
 * passed: the init's `signal` is the double's parent signal, so the consumer's own signal ends the run it gets back as it ends a real one, the init's `onFailed` and
 * `onTimeout` are the callbacks the double's child asks at its ending, its `args` decide whether a refused GPU decode asks neither, its `stdin` is the canned buffer
 * the double feeds itself, and the options are the ones a line reporting the hardware decoder's refusal marks. A test reads the recorded init for the command the
 * consumer assembled and the recorded process to drive it.
 *
 * @see ExecProcessFactory
 * @see TestExecProcess
 *
 * @category Testing
 */
export class TestExecProcessFactory implements ExecProcessFactory {

  /**
   * Every create call's options and init and the process it answered, in order, an omitted init recorded as an empty one, as the real run's constructor reads it, so a
   * test can assert the boundary was reached with what it expected and can drive the process that came back.
   */
  public readonly createCalls: { init: FfmpegExecInit; options: FfmpegOptions; process: TestExecProcess }[] = [];

  /**
   * Record the create call and answer a fresh double over the options and the init's args, signal, ending callbacks and canned stdin.
   *
   * @param options - The {@link FfmpegOptions} the consumer passed, which a line reporting the hardware decoder's refusal marks.
   * @param init    - The init the consumer passed, an empty one when it passed none.
   *
   * @returns The exec-process double.
   */
  public create(options: FfmpegOptions, init: FfmpegExecInit = {}): ExecProcess {

    const process = new TestExecProcess(init, options);

    this.createCalls.push({ init, options, process });

    return process;
  }
}
