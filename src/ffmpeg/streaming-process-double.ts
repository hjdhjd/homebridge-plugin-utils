/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/streaming-process-double.ts: An FFmpeg-free StreamingProcess test double - a test drives its readiness, its output, its exit and its spawn failure, with no
 * child process behind them.
 */

/**
 * An FFmpeg-free {@link StreamingProcess} test double.
 *
 * A class that runs a live view has its hard cases in the order a process's events arrive: an abort that lands before the process is ready, a child that exits on its
 * own while the class still writes into it, a spawn that fails before anything is written. This module ships the double for those - a {@link TestStreamingProcess} a
 * test drives one event at a time, with no child process anywhere in sight - and a {@link TestStreamingProcessFactory} that builds one per `create` from the init the
 * consumer passed and records that init, so a suite reads the command the consumer assembled from the recorded `args`.
 *
 * The double settles its promises and ends its lifetime as the real process does: `ready` and `exited` are marked handled, `ready` rejects with the lifetime's reason
 * when the lifetime ends while it is pending, an exit resolves `exited` and ends the lifetime in one step, and `stdin` and `stdout` close as `exited` settles. The
 * levers refuse an event no real process produces rather than modeling it. A failed or timed-out ending asks the `onFailed` or `onTimeout` callback the consumer
 * handed in its init, inside the abort that ends the lifetime, so a plugin's suite drives its own ending callbacks through the double. Stderr lines a suite sets
 * that report the hardware decoder's refusal mark the options the double was handed, and a refused GPU decode asks no callback, as on the real process.
 *
 * Signatures come from the process's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
 * compiler saying so. Which line marks the refusal and which callback an ending asks come from `process-ending.ts`, the transport-free rules the real process reads
 * and asks through as well, so the two cannot disagree about them and loading the double loads none of the process's spawn machinery.
 *
 * @module
 */
import type { FfmpegStreamingInit, StreamingProcess, StreamingProcessFactory } from "./stream.ts";
import { HbpuAbortError, composeSignals, isHbpuAbortError, markHandled, onAbort } from "../util.ts";
import { Readable, Writable } from "node:stream";
import { ffmpegEndingOutcome, ffmpegMarkRefusal } from "./process-ending.ts";
import type { FfmpegOptions } from "./options.ts";
import type { FfmpegProcessExitInfo } from "./process.ts";

/* How far the child the double stands in for has come, which decides what each lever may do next: "spawning" until it shows it has spawned, "started" once it has
 * written to stdout, or had stderr lines set once the lifetime had ended, "ready" once ready has resolved, by its lever or by stderr lines set while the lifetime
 * was live, and "exited" or "spawnFailed" once exited has settled.
 */
type ChildState = "exited" | "ready" | "spawnFailed" | "spawning" | "started";

/**
 * A driven, FFmpeg-free {@link StreamingProcess} double: its child becomes ready, writes to stdout, exits or fails to spawn when a test says so, and it records what a
 * consumer writes to stdin.
 *
 * The lifetime is the parent signal the constructor receives composed with the double's own. The parent aborting ends it with the parent's reason, an exit before
 * any abort ends it as `"closed"` for an exit code of 0 and `"failed"` otherwise, and a spawn failure before any abort ends it as `"failed"` with the spawn's error as
 * its cause; whichever comes first stands. `stdin` and `stdout` stay open across an abort and close as `exited` settles, by an exit or a spawn failure, so a writer
 * over `stdin` meets the closed stream at the exit, as it does over a real child's.
 *
 * The lifetime's end asks the init's ending callbacks as the real process's teardown does: `HbpuAbortError("failed")` asks `onFailed` and
 * `HbpuAbortError("timeout")` asks `onTimeout`, each handed the reason and the lines {@link TestStreamingProcess.stderrLog} holds at that moment, synchronously inside
 * the abort, after `ready` rejects and before any abort listener a consumer added to the double's own `signal`, or inside the constructor when the parent signal has
 * already aborted. A listener on the parent signal the consumer passed in runs first, as it does on the real process. Any other ending asks neither. Nor does a
 * refused GPU decode: a failed ending of a double whose own stderr lines reported the hardware decoder's refusal and whose init's `args` ask for its decoded frames
 * on the GPU.
 *
 * The stderr lines a suite sets are read for the hardware decoder's refusal as the real process reads the lines its child writes: the first line that carries it
 * marks the options the double was handed, at once and whether or not the double then fails, and no line is read after it, in that set or a later one. Setting
 * lines also shows the child has spawned and, while the lifetime is live, resolves a pending `ready`, as the real process's first stderr output does, so
 * {@link TestStreamingProcess.resolveReady} after them is refused as it is after a first pull.
 *
 * Where it differs from the real process:
 *
 * - An abort kills a real child, which then exits on its own, while the double has no child to kill, so after an abort its `exited` waits for
 *   {@link TestStreamingProcess.exit} or {@link TestStreamingProcess.failSpawn}. A test that stands in for a killed child pulls the exit lever with the exit a killed
 *   child reports, `{ exitCode: null, exitSignal: "SIGKILL" }`.
 * - It logs nothing, so a callback's `"default"` reports nothing and a refused GPU decode logs no debug line, where the real process logs its report and that line.
 * - A double built without options marks nothing when its lines report the refusal, where the real process always holds the options it marks.
 * - It reads every line it is handed for the refusal, where the real process leaves unread the last line its child wrote with no line break, which it adds to its
 *   log at the exit.
 * - It does not catch a callback's throw, which therefore leaves the constructor, and so `create()`, under a parent signal already aborted, and reaches Node's
 *   uncaught-exception path under any later abort, where the real process logs it at error and runs its default report. A suite sees the bug in its own callback.
 * - It has no lever for the real process's own watchdogs or its return-port socket, so a suite reaches `onTimeout` by aborting the parent signal with
 *   `HbpuAbortError("timeout")`.
 *
 * @example
 *
 * ```ts
 * import { TestStreamingProcessFactory, expectAt } from "homebridge-plugin-utils/testing";
 *
 * const factory = new TestStreamingProcessFactory();
 * const session = new LiveViewSession({ processFactory: factory, signal: controller.signal });
 * const call = expectAt(factory.createCalls, 0, "the streaming process the session built");
 *
 * // The command the session assembled, read without spawning anything, then the session's own readiness wait, ending callback and exit handling, exercised with
 * // no FFmpeg at all.
 * assert.ok(call.init.args?.includes("-re"));
 * call.process.resolveReady();
 * call.process.stderrLog = ["An invented stderr line the session's onFailed reads."];
 * call.process.exit({ exitCode: 1, exitSignal: null });
 * ```
 *
 * @see TestStreamingProcessFactory
 *
 * @category Testing
 */
export class TestStreamingProcess implements StreamingProcess {

  /**
   * Resolves with the exit information {@link TestStreamingProcess.exit} was handed, and rejects with the lifetime's reason when
   * {@link TestStreamingProcess.failSpawn} was pulled instead. Marked handled, as the real process's is.
   */
  public readonly exited: Promise<FfmpegProcessExitInfo>;

  /**
   * Resolves when {@link TestStreamingProcess.resolveReady} is pulled or stderr lines are first set, whichever comes first, as the real process's resolves on its
   * child's first stderr output, and rejects with the lifetime's reason when the lifetime ends while it is pending. Marked handled, as the real process's is.
   */
  public readonly ready: Promise<void>;

  /**
   * The abort signal representing this double's lifetime, composed from the parent signal the constructor received and this double's own, as the real process
   * composes its parent with its own.
   */
  public readonly signal: AbortSignal;

  /**
   * A writable that records every chunk written to it in {@link TestStreamingProcess.stdinWrites}. It stays writable after the lifetime ends and is destroyed as
   * `exited` settles.
   */
  public readonly stdin: Writable;

  /**
   * A readable carrying the bytes {@link TestStreamingProcess.writeStdout} was handed, in order, which ends as `exited` settles.
   */
  public readonly stdout: Readable;

  readonly #args: readonly string[];

  #child: ChildState = "spawning";

  readonly #controller = new AbortController();

  readonly #endingCallbacks: Pick<FfmpegStreamingInit, "onFailed" | "onTimeout">;

  readonly #exitedResolvers: PromiseWithResolvers<FfmpegProcessExitInfo>;

  readonly #options: FfmpegOptions | undefined;

  readonly #readyResolvers: PromiseWithResolvers<void>;

  // Set once a line this double was handed reports the hardware decoder's refusal, held apart from the options' mark as the real process holds its own sighting,
  // because only a refusal this child reported can explain its failure.
  #sawRefusal = false;

  #stderrLog: readonly string[] = [];

  readonly #stdinWrites: Buffer[] = [];

  /**
   * Construct a double.
   *
   * @param init           - Optional init options: the members of a consumer's {@link FfmpegStreamingInit} the double reads.
   * @param init.args      - The arguments the real process would be spawned with, copied at construction and read as empty when absent. Whether they ask for the
   *                         decoded frames on the GPU decides whether a refusal the double's lines report ends a failure ahead of `onFailed`, as on the real process.
   * @param init.onFailed  - Asked when the lifetime ends with `HbpuAbortError("failed")`, as the real process asks it, unless the ending is a refused GPU decode. Its
   *                         answer changes nothing here, because the double has no report for `"default"` to leave standing.
   * @param init.onTimeout - Asked when the lifetime ends with `HbpuAbortError("timeout")`, as the real process asks it, its answer likewise changing nothing here.
   * @param init.signal    - The parent signal the real process would compose into its lifetime: the one a consumer passes in its {@link FfmpegStreamingInit}.
   *                         Aborting it ends the double with that signal's reason.
   * @param options        - Optional. The {@link FfmpegOptions} a line reporting the hardware decoder's refusal marks, as the real process marks the options it was
   *                         built over. A double built without them marks nothing.
   */
  public constructor(init: Pick<FfmpegStreamingInit, "args" | "onFailed" | "onTimeout" | "signal"> = {}, options?: FfmpegOptions) {

    // Copied as the real process copies its own, so a consumer that changes its array afterward leaves the double's reading of it unchanged.
    this.#args = [...(init.args ?? [])];
    this.#options = options;

    // Held before the abort listener is registered, because under a parent signal already aborted that listener runs inside this constructor and asks them there.
    this.#endingCallbacks = { onFailed: init.onFailed, onTimeout: init.onTimeout };
    this.signal = composeSignals(init.signal, this.#controller.signal);
    this.#readyResolvers = Promise.withResolvers();
    this.#exitedResolvers = Promise.withResolvers();
    this.ready = markHandled(this.#readyResolvers.promise);
    this.exited = markHandled(this.#exitedResolvers.promise);

    this.stdin = new Writable({

      write: (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void => {

        this.#stdinWrites.push(chunk);
        callback();
      }
    });

    // The bytes come from the stdout lever alone, so a read asks the source for nothing and the stream hands over what the lever pushed.
    this.stdout = new Readable({ read: (): void => undefined });

    // Registered last, so a parent that had already aborted ends the double inside this constructor, as the real process's teardown runs inside its own for a
    // pre-aborted signal.
    onAbort(this.signal, () => this.#end());
  }

  /**
   * The stderr lines the stood-in child has written, in place of the log a real child's stderr fills. A suite sets them before it drives an ending, because a failed
   * or timed-out ending hands its callback the lines this holds at that moment. Setting lines shows the child has spawned, so {@link TestStreamingProcess.failSpawn}
   * is refused after it, resolves a pending `ready` while the lifetime is live, so {@link TestStreamingProcess.resolveReady} is refused after it too, and reads them
   * for the hardware decoder's refusal until one carries it, marking the options the double was handed. Empty until a suite sets them.
   */
  public get stderrLog(): readonly string[] {

    return this.#stderrLog;
  }

  public set stderrLog(lines: readonly string[]) {

    this.#stderrLog = lines;

    // A child that wrote to stderr has spawned, as one that wrote to stdout has, so no spawn failure can follow it, and its first stderr output resolves a pending
    // ready, as the real process's does. Once the lifetime has ended, ready has already rejected and the resolve is inert, so the lines show the spawn alone.
    if((lines.length > 0) && ((this.#child === "spawning") || (this.#child === "started"))) {

      this.#child = this.signal.aborted ? "started" : "ready";
      this.#readyResolvers.resolve();
    }

    // Each line is read through the step the real process's drain reads by, and the reading stops at the first refusal, in this set and every later one, as the
    // drain's does.
    this.#sawRefusal ||= lines.some((line) => ffmpegMarkRefusal(line, this.#options));
  }

  /**
   * Every chunk written to {@link TestStreamingProcess.stdin}, in the order written: the bytes a consumer fed the process.
   */
  public get stdinWrites(): readonly Buffer[] {

    return this.#stdinWrites;
  }

  /**
   * Resolve `ready`, as a real process's first stderr output does. Setting {@link TestStreamingProcess.stderrLog} while `ready` is pending resolves it as well, and
   * this lever is refused from then on.
   *
   * @throws The lifetime's reason once the lifetime has ended, and an `Error` when `ready` has already resolved, by this lever or by stderr lines.
   */
  public resolveReady(): void {

    if(this.signal.aborted) {

      throw this.signal.reason;
    }

    if(this.#child === "ready") {

      throw new Error("TestStreamingProcess: ready has already resolved, so it cannot resolve again.");
    }

    this.#child = "ready";
    this.#readyResolvers.resolve();
  }

  /**
   * Write bytes to `stdout`, as a real child's output does. Allowed between an abort and the exit, because a killed child's pipe carries what it wrote until it exits.
   *
   * @param bytes - The bytes the child writes.
   *
   * @throws An `Error` once `exited` has settled, because `stdout` has ended.
   */
  public writeStdout(bytes: Buffer): void {

    this.#refuseWhenSettled("stdout takes no more bytes");

    if(this.#child === "spawning") {

      this.#child = "started";
    }

    this.stdout.push(bytes);
  }

  /**
   * Exit the child, as a real child's exit does: `stdin` and `stdout` close, `exited` resolves with the exit information, and in the same step the lifetime ends with
   * `HbpuAbortError("closed")` for an exit code of 0 and `HbpuAbortError("failed")` otherwise, each carrying the exit information as its cause, unless the lifetime has
   * already ended, in which case its reason stands. The reason is therefore final before any continuation of `exited` runs, and a pending `ready` rejects with it.
   *
   * @param info - The exit code and signal the child exits with.
   *
   * @throws An `Error` once `exited` has settled, by an earlier exit or a spawn failure.
   */
  public exit({ exitCode, exitSignal }: FfmpegProcessExitInfo): void {

    this.#refuseWhenSettled("the child cannot exit");
    this.#child = "exited";
    this.#closeStdio();
    this.#exitedResolvers.resolve({ exitCode, exitSignal });

    if(!this.signal.aborted) {

      this.#controller.abort(new HbpuAbortError((exitCode === 0) ? "closed" : "failed", { cause: { exitCode, exitSignal } }));
    }
  }

  /**
   * Fail the spawn, as a real process whose binary cannot be started does: `stdin` and `stdout` close, the lifetime ends with `HbpuAbortError("failed")` carrying
   * `cause` unless it has already ended, in which case its reason stands, and `ready` and `exited` reject with the lifetime's reason.
   *
   * @param cause - The error the spawn failed with.
   *
   * @throws An `Error` once the child has shown it spawned, by resolving ready, writing to stdout or having stderr lines set, and once `exited` has settled, because
   *         a spawn fails before any of those.
   */
  public failSpawn(cause: Error): void {

    this.#refuseWhenSettled("the spawn cannot fail");

    if(this.#child !== "spawning") {

      throw new Error("TestStreamingProcess: the child has already shown it spawned, so the spawn cannot fail.");
    }

    this.#child = "spawnFailed";
    this.#closeStdio();

    if(!this.signal.aborted) {

      this.#controller.abort(new HbpuAbortError("failed", { cause }));
    }

    this.#exitedResolvers.reject(this.signal.reason);
  }

  // Close the child's pipes as exited settles: stdin is destroyed, so a writer meets the closed stream, and stdout ends once what was written to it has been read.
  #closeStdio(): void {

    this.stdin.destroy();
    this.stdout.push(null);
  }

  // The lifetime's end, run inside the abort that ends it: a pending ready rejects with the reason, inert once ready has resolved, and then the ending is decided
  // through the rule the real process decides by, over the double's own sighting of the refusal and never the options' mark, so a refused GPU decode asks no
  // callback. The answer goes unread, since the double has no report to run and no line to log, and a throw is left uncaught so it surfaces as the bug in the
  // suite's own callback it is.
  #end(): void {

    const reason: unknown = this.signal.reason;

    this.#readyResolvers.reject(reason);

    if(isHbpuAbortError(reason)) {

      ffmpegEndingOutcome({ reason, stderrLog: this.stderrLog }, { args: this.#args, sawRefusal: this.#sawRefusal }, this.#endingCallbacks);
    }
  }

  // A lever for an event only a child that has not ended can produce refuses once exited has settled, because no real process produces one after its end.
  #refuseWhenSettled(outcome: string): void {

    if((this.#child === "exited") || (this.#child === "spawnFailed")) {

      throw new Error("TestStreamingProcess: exited has already settled, so " + outcome + ".");
    }
  }
}

/**
 * A {@link StreamingProcessFactory} double that records every `create` call and answers a fresh {@link TestStreamingProcess} over the options and the init the consumer
 * passed: the init's `signal` is the double's parent signal, so the consumer's own signal ends the process it gets back as it ends a real one, the init's `onFailed`
 * and `onTimeout` are the callbacks the double asks at its ending, its `args` decide whether a refused GPU decode asks neither, and the options are the ones a line
 * reporting the hardware decoder's refusal marks. A test reads the recorded init for the command the consumer assembled and the recorded process to drive it. There is
 * no form that hands back a process built ahead of the call, because such a process could neither hear the signal, ask the callbacks nor mark the options the
 * consumer passes to `create`.
 *
 * @see StreamingProcessFactory
 * @see TestStreamingProcess
 *
 * @category Testing
 */
export class TestStreamingProcessFactory implements StreamingProcessFactory {

  /**
   * Every create call's options and init and the process it answered, in order, so a test can assert the boundary was reached with what it expected and can drive the
   * process that came back.
   */
  public readonly createCalls: { init: FfmpegStreamingInit; options: FfmpegOptions; process: TestStreamingProcess }[] = [];

  /**
   * Record the create call and answer a fresh double over the options and the init's args, signal and ending callbacks.
   *
   * @param options - The {@link FfmpegOptions} the consumer passed, which a line reporting the hardware decoder's refusal marks.
   * @param init    - The init the consumer passed.
   *
   * @returns The streaming-process double.
   */
  public create(options: FfmpegOptions, init: FfmpegStreamingInit): StreamingProcess {

    const process = new TestStreamingProcess(init, options);

    this.createCalls.push({ init, options, process });

    return process;
  }
}
