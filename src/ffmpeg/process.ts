/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/process.ts: Base class to provide FFmpeg process control and capability introspection.
 */

/**
 * FFmpeg process management with AbortSignal-based lifecycle.
 *
 * This module defines the `FfmpegProcess` base class, the foundation every other FFmpeg class in `homebridge-plugin-utils` builds on. Construction spawns the child; the
 * composed {@link AbortSignal} exposed as `this.signal` is the single source of truth for the process's lifetime. Every teardown path - external `abort()`, parent
 * signal aborting, natural exit, spawn failure, optional startup timeout - converges on the same signal.
 *
 * The class is an {@link AsyncDisposable} so callers can manage the process with `await using` for scope-bound lifetimes. It is intentionally not an `EventEmitter`:
 * ready/exit are {@link Promise}s, stderr accumulates to {@link FfmpegProcess.stderrLog}, and fine-grained termination hooks are registered against `this.signal`.
 *
 * Key features:
 *
 * - Spawn-on-construction. No `start()` step, no configure-then-run.
 * - {@link AbortSignal}-driven teardown. Node's native `spawn({ signal, killSignal })` owns the kill path; no manual SIGKILL fallback timer.
 * - `ready` promise resolves when FFmpeg produces its first stderr byte (the earliest reliable "we are actually running" signal).
 * - `exited` promise resolves with the child's exit code and signal once it terminates. Rejects with `signal.reason` only when the child never started (e.g., `ENOENT`).
 * - Reason-based teardown logging: `"failed"` dumps stderr at ERROR, `"timeout"` logs at WARN, other reasons log at DEBUG. The init's `onFailed` and `onTimeout`
 *   callbacks are asked about a failed or timed-out ending first, and each reports the ending its own way or leaves that report to stand. A failure whose
 *   decoded frames were asked on the GPU and whose hardware decoder refused the stream logs at DEBUG ahead of any callback, because every refusal marks the
 *   process's {@link FfmpegOptions} and later pipelines over them decode in software.
 * - Synchronous teardown classification. The abort that tears the process down runs its listeners inline, so the moment a consumer's listener on `this.signal`
 *   fires, `hasError` and the teardown reason already hold their final values. Shutdown logic may rely on that ordering: it is a contract of this class, and
 *   changing it is a breaking change rather than an implementation detail.
 *
 * @module
 */
import type { FfmpegEnding, FfmpegEndingOutcome, FfmpegEndingVerdict } from "./process-ending.ts";
import { HbpuAbortError, Watchdog, composeSignals, formatErrorMessage, isHbpuAbortError, isHbpuAbortReason, isTimeoutReason, markHandled, onAbort } from "../util.ts";
import type { HbpuAbortReason, HomebridgePluginLogging, Nullable } from "../util.ts";
import type { Readable, Writable } from "node:stream";
import { ffmpegEndingOutcome, ffmpegMarkRefusal } from "./process-ending.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EOL } from "node:os";
import type { FfmpegOptions } from "./options.ts";
import { spawn } from "node:child_process";

// Re-export the ending a callback is handed and the verdict it answers, so a plugin names them from the package root beside the init that carries the callbacks.
// The single source is `process-ending.ts`, which shares the rule for asking them with a test double; this file is just a forwarding re-export.
export type { FfmpegEnding, FfmpegEndingVerdict } from "./process-ending.ts";

// Matches non-printable control characters that #onStderrData replaces with EOL so control sequences become line boundaries rather than vanishing. Compiled once at
// module scope rather than per data event.
const NON_PRINTABLE_CHARS = /\p{C}+/gu;

// Shape-level type guard for exit-info-like cause values. The class attaches exit information to `HbpuAbortError`'s `cause` field for `"closed"` and `"failed"`
// reasons, but `cause` is typed `unknown` at the error boundary, so any consumer that wants to read exit info (including our own teardown logger) must narrow.
//
// The predicate's return type is intentionally narrower than the public `FfmpegProcessExitInfo`. The public type declares `exitSignal: Nullable<NodeJS.Signals>` - a
// compile-time union of ~30 specific strings. Runtime membership cannot be verified without a platform-dependent signal whitelist that would drift from Node itself,
// so the guard only checks `exitSignal` is a string (or null). The mismatch between "what we can produce strictly" and "what we can validate at the read side" is
// bridged by `satisfies FfmpegProcessExitInfo` at the production site (see `#onExit`), which gives us strict types for callers of `exited` without asking the
// read-side guard to lie about what it can actually check.
//
// `describeCause` only uses `exitSignal` for string concatenation, so losing the `NodeJS.Signals` narrowing here costs nothing. If a future consumer needs the strict
// union, they should either enforce it at the produce side (as `#onExit` does) or accept the looser shape at the read side.
function isExitInfoShape(value: unknown): value is { exitCode: Nullable<number>; exitSignal: Nullable<string> } {

  if((typeof value !== "object") || (value === null)) {

    return false;
  }

  const candidate = value as Record<string, unknown>;
  const exitCodeOk = (candidate["exitCode"] === null) || (typeof candidate["exitCode"] === "number");
  const exitSignalOk = (candidate["exitSignal"] === null) || (typeof candidate["exitSignal"] === "string");

  return exitCodeOk && exitSignalOk;
}

// Render a `"failed"` abort reason's `cause` for human consumption. Recognized cause shapes, in dispatch order:
//
//   - `FfmpegProcessExitInfo`: produced by `#onExit` for natural non-zero exits. Rendered as "exit code N" and/or "signal S".
//   - `Error`: produced by `#onSpawnError` from Node's ENOENT/EACCES/etc. Rendered as the error's message.
//   - anything else (including `null`, primitives, arbitrary user-supplied cause values): rendered as "unknown".
//
// `cause` is `unknown` by design; this function is the single narrowing point so the teardown logger never touches a field it has not validated. Pure and free-standing
// because it is stateless - no reason to attach it to the class.
function describeCause(cause: unknown): string {

  if(isExitInfoShape(cause)) {

    const parts: string[] = [];

    if(cause.exitCode !== null) {

      parts.push("exit code " + cause.exitCode.toString());
    }

    if(cause.exitSignal !== null) {

      parts.push("signal " + cause.exitSignal);
    }

    return (parts.length > 0) ? parts.join(", ") : "no exit information";
  }

  if(cause instanceof Error) {

    return cause.message;
  }

  return "unknown";
}

/**
 * Structured exit information surfaced through {@link FfmpegProcess.exited}.
 *
 * @property exitCode   - The process exit code, or `null` when the process was terminated by a signal.
 * @property exitSignal - The signal name (e.g., `"SIGKILL"`) that terminated the process, or `null` when the process exited normally.
 *
 * @category FFmpeg
 */
export interface FfmpegProcessExitInfo {

  exitCode: Nullable<number>;
  exitSignal: Nullable<NodeJS.Signals>;
}

/**
 * Construction-time options for {@link FfmpegProcess}.
 *
 * The ending callbacks let a plugin say how a failed or timed-out process is reported, in place of the default report, without subclassing. Each is asked at most
 * once, synchronously inside the abort that ends the process: the reason is final by then, and the asking comes before any abort listener a consumer added to the
 * process's own `signal`, or inside the constructor when the parent signal has already aborted. A listener on the parent signal the consumer passed in runs first,
 * since the parent dispatches its abort to its own listeners before the process's signal dispatches to its. A callback that throws has its throw logged at error, and
 * the default report runs in its place. A subclass that builds a callback for its base reads its own constructor's parameters and never the instance, which may not
 * yet be built when the callback is asked.
 *
 * @property args            - Optional. FFmpeg command-line arguments. Defaults to an empty array.
 * @property onFailed        - Optional. Asked when the process fails: an exit other than with code 0, a spawn failure, or a `"failed"` reason handed in through
 *                             `abort()` or the parent signal. A failed process that asked for its decoded frames on the GPU and read its hardware decoder's refusal
 *                             ends at debug ahead of this callback, which it does not ask. On `"handled"` the process logs nothing more for the failure; on
 *                             `"default"` it logs its summary, its command line and every stderr line at error.
 * @property onTimeout       - Optional. Asked when the process ends with `HbpuAbortError("timeout")` alone, whether a watchdog or the code that aborted the process
 *                             raised it, and never for a platform `TimeoutError`, which ends at debug. On `"handled"` the process logs nothing more for the
 *                             timeout; on `"default"` it logs one warning.
 * @property signal          - Optional. Parent {@link AbortSignal} to compose with the process's internal controller. When the parent aborts, the process tears down.
 * @property startupTimeout  - Optional. If FFmpeg does not produce stderr output within this many milliseconds, the process is aborted with
 *                             `HbpuAbortError("timeout")`. The window is armed on the options' clock, so a consumer's virtual clock drives it.
 *
 * @category FFmpeg
 */
export interface FfmpegProcessInit {

  args?: string[];
  onFailed?: (ending: FfmpegEnding) => FfmpegEndingVerdict;
  onTimeout?: (ending: FfmpegEnding) => FfmpegEndingVerdict;
  signal?: AbortSignal;
  startupTimeout?: number;
}

/**
 * Base class providing FFmpeg process management with signal-driven lifecycle.
 *
 * Construction spawns the child immediately. The composed `this.signal` is the single source of truth for the process's lifetime: external `abort()`, a parent signal
 * firing, a non-zero exit, a spawn failure, and (optionally) a startup-timeout all converge on the same signal. Subclasses register additional `"abort"` listeners on
 * `this.signal` rather than overriding `abort()` or `[Symbol.asyncDispose]`.
 *
 * @example
 *
 * ```ts
 * // Scope-bound: the child is guaranteed to be torn down when the block exits, regardless of success or exception.
 * await using proc = new FfmpegProcess(options, { args: [ "-i", "input.mp4", "-f", "null", "-" ] });
 *
 * await proc.ready;
 * const { exitCode } = await proc.exited;
 * ```
 *
 * @example
 *
 * ```ts
 * // Signal-driven: parent controls teardown through its own AbortController.
 * const controller = new AbortController();
 * const proc = new FfmpegProcess(options, { args, signal: controller.signal });
 *
 * // Later, from anywhere with the controller:
 * controller.abort();
 * ```
 *
 * @see {@link https://ffmpeg.org/documentation.html | FFmpeg Documentation}
 *
 * @see {@link https://nodejs.org/api/child_process.html#child_processspawncommand-args-options | Node.js child_process.spawn}
 *
 * @see FfmpegOptions
 *
 * @category FFmpeg
 */
export class FfmpegProcess implements AsyncDisposable {

  /**
   * The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the
   * reason encoded on `signal.reason` names the cause (see {@link HbpuAbortReason}). Subclasses and external callers attach `"abort"` listeners to this signal when they
   * need scope-bound teardown hooks of their own.
   */
  public readonly signal: AbortSignal;

  /**
   * Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason`
   * when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit).
   */
  public readonly ready: Promise<void>;

  /**
   * Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg
   * binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`.
   */
  public readonly exited: Promise<FfmpegProcessExitInfo>;

  /**
   * Writable standard input stream for the FFmpeg process.
   */
  public readonly stdin: Writable;

  /**
   * Readable standard output stream. Subclasses that consume this stream internally narrow the public type to `never` via `declare`.
   */
  public readonly stdout: Readable;

  /**
   * Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated {@link FfmpegProcess.stderrLog}; most callers
   * should prefer `stderrLog` since the class already buffers lines for them.
   */
  public readonly stderr: Readable;

  /**
   * The FFmpeg options instance this process was constructed with. Exposed for subclasses that need access to the shared configuration (codec support, logger, etc.).
   */
  protected readonly options: FfmpegOptions;

  /**
   * Logger instance resolved from `options.log`. Shared by all log output in this class and subclasses.
   */
  protected readonly log: HomebridgePluginLogging;

  /**
   * The resolved FFmpeg command-line arguments this process was spawned with. Retained so teardown logging can include the original command in error reports.
   */
  protected readonly args: readonly string[];

  /**
   * Protected alias for {@link FfmpegProcess.stdin}. Kept for symmetry with `_stdout` / `_stderr`; unlike `_stdout`, no subclass narrows the public `stdin` to
   * `never`, so this typed path exists for consistency rather than to route around a narrowing of its own.
   */
  protected readonly _stdin: Writable;

  /**
   * Protected alias for {@link FfmpegProcess.stdout}. Subclasses that publicly narrow `stdout` to `never` (because an internal consumer such as `Mp4SegmentAssembler`
   * owns the stream) still consume the underlying stream through this typed path.
   */
  protected readonly _stdout: Readable;

  /**
   * Protected alias for {@link FfmpegProcess.stderr}. Provided for symmetry with `_stdin` / `_stdout`.
   */
  protected readonly _stderr: Readable;

  // The private AbortController whose signal is fed into the composed `this.signal`. When a parent signal is provided, `AbortSignal.any` composes this controller's
  // signal with the parent's; otherwise `this.signal` is this controller's signal directly.
  readonly #controller: AbortController;

  // The init's ending callbacks, held from the constructor's first lines so the teardown can ask them even when it runs inside the constructor under a parent signal
  // already aborted.
  readonly #endingCallbacks: Pick<FfmpegProcessInit, "onFailed" | "onTimeout">;

  // The underlying Node ChildProcess. Held privately so subclasses route through `_stdin` / `_stdout` / `_stderr` rather than reaching into the raw object.
  readonly #process: ChildProcessWithoutNullStreams;

  // Accumulated stderr lines. Exposed publicly as a readonly view via `stderrLog`. Preserved across teardown for post-mortem inspection.
  readonly #stderrLog: string[] = [];

  // Pending partial stderr line (text read from the stream that has not yet terminated with a line break).
  #stderrBuffer = "";

  // Resolver pair for `ready`. First stderr byte resolves; teardown rejects if still pending.
  readonly #readyResolvers: PromiseWithResolvers<void>;

  // Resolver pair for `exited`. "exit" event resolves with the actual info; "error" rejects when the child never spawned.
  readonly #exitedResolvers: PromiseWithResolvers<FfmpegProcessExitInfo>;

  // Set `true` once the process has produced output - its first stderr byte. The ready promise resolves on that byte and the startup watchdog is cleared on it, so
  // each reads this field to act on the first byte alone.
  #firstStderr = false;

  // Set `true` once this process's own stderr reports that the hardware decoder refused the stream, held apart from the options' mark, which another process over
  // them may already have set. The drain reads it to mark the options once per process, and the teardown policy reads it to end a refused GPU decode at debug,
  // because only a refusal this process read can explain its failure.
  #sawHardwareDecoderRefusal = false;

  // The startup watchdog composed over this.signal, or `undefined` when no `startupTimeout` was configured. Armed at spawn, cleared by the first stderr byte, and
  // cleared by the primitive itself when the signal aborts for any reason, so no teardown wiring is needed.
  readonly #startupWatchdog: Watchdog | undefined;

  // Cached decision - should stderr lines be mirrored to `log.info`? Computed once from `args`, `verbose`, and `debug` during construction and immutable thereafter.
  // Cached rather than recomputed because the stderr hot path consults it per chunk and the inputs never change.
  readonly #liveLog: boolean;

  /**
   * Construct and spawn a new FFmpeg process.
   *
   * Spawning happens synchronously as part of construction: by the time the constructor returns, the child is already running (or has already scheduled its `"error"`
   * event for a spawn failure). There is no separate `start()` step.
   *
   * @param options - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init    - Optional init options. See {@link FfmpegProcessInit}.
   */
  public constructor(options: FfmpegOptions, init: FfmpegProcessInit = {}) {

    const { args = [], onFailed, onTimeout, signal: parentSignal, startupTimeout } = init;

    this.options = options;
    this.log = options.log;
    this.#endingCallbacks = { onFailed, onTimeout };

    // Freeze a copy of the caller's args so the `readonly` type is enforced at runtime as well as in TypeScript. Without the copy, a caller mutating their own array
    // post-construction would silently mutate our stored value - visible in the teardown log, invisible during review.
    this.args = Object.freeze([...args]);

    // Resolve the logging decision once, at construction time. The live-log path runs on every stderr chunk; recomputing `this.args.includes("-loglevel")` each time
    // would be wasteful. Verbose and debug are configuration, not signal state, so they are also resolved here.
    this.#liveLog = this.args.includes("-loglevel") || this.#verbose || options.debug;

    // Compose our lifetime. The internal controller lets us abort the process from within the class; the optional parent signal lets a caller tear us down as part of
    // their own lifecycle. `composeSignals` handles the "one or both" case uniformly so we never hand-roll the `AbortSignal.any` branching.
    this.#controller = new AbortController();
    this.signal = composeSignals(parentSignal, this.#controller.signal);

    // Log the command once at construction. The policy: verbose/debug/loglevel-in-args configurations surface the command at info; every other configuration logs it
    // at debug. Consumers that need this in structured form read `commandLine` directly. We select the level dynamically so there is a single format string to maintain -
    // parallel if/else branches drift as they age.
    const commandLogLevel: "debug" | "info" = this.#liveLog ? "info" : "debug";

    this.log[commandLogLevel]("FFmpeg command (version: %s): %s %s.", this.#ffmpegVersion, this.#ffmpegExec, this.args.join(" "));

    // Wire up the ready/exited resolvers before spawning. Node emits spawn-failure `"error"` events on the next microtask; the resolvers must be in place by then so
    // the error path can settle them. We bind via typed locals so `PromiseWithResolvers<T>` is expressed as a type annotation rather than a call-site generic argument.
    const readyResolvers: PromiseWithResolvers<void> = Promise.withResolvers();
    const exitedResolvers: PromiseWithResolvers<FfmpegProcessExitInfo> = Promise.withResolvers();

    this.#readyResolvers = readyResolvers;
    this.#exitedResolvers = exitedResolvers;

    // Mark both promises as observed. Callers that await `ready` or `exited` still receive the rejection through their own chain - `markHandled` only opts the promise
    // out of Node's unhandled-rejection tracker for the case where nobody awaits one of them (e.g., a session that aborts before the process becomes ready and the
    // caller never asked for the ready outcome).
    this.ready = markHandled(readyResolvers.promise);
    this.exited = markHandled(exitedResolvers.promise);

    // Spawn immediately. Node's spawn accepts `{ signal, killSignal }` natively: when the signal aborts, Node kills the child with `killSignal`, letting the kernel
    // own the kill path. Pairing the signal with `SIGKILL` is the right choice for FFmpeg specifically because it is a media pipeline, not a service we want to
    // negotiate orderly shutdown with - when we are done, we are done. We spawn from `this.args` (the frozen copy) rather than the caller's live reference so the
    // class has a single source of truth for its command line.
    this.#process = spawn(this.#ffmpegExec, this.args, { killSignal: "SIGKILL", signal: this.signal });

    // Cache references to the child's streams. `ChildProcessWithoutNullStreams` guarantees these are non-null, and the cached references stay live even after the child
    // exits so subclasses can still inspect them.
    this.stdin = this._stdin = this.#process.stdin;
    this.stdout = this._stdout = this.#process.stdout;
    this.stderr = this._stderr = this.#process.stderr;

    // Attach listeners to the ChildProcess and its streams. Node's `EventEmitter.on` / `.once` do not accept the `{ signal }` option that `EventTarget.addEventListener`
    // does - that helper lives on the module-level `events.on` / `events.once` wrappers, which are oriented around promises and async iterators rather than callbacks.
    // For the base class's single-producer-single-consumer callbacks, manual attachment is fine: every listener sits on the child or one of its own pipes, which close
    // at the child's exit, so none outlives the process and there is no runaway-listener risk. The abort kills the child (Node's `spawn({ signal, killSignal })` owns
    // the kill path), but its pipes live until it exits, so events still arrive between the abort and the exit - the `"error"` Node raises for the kill, stderr the
    // child had already written, the exit itself - and each handler expects them: the spawn-error handler passes over an error on a child that spawned, the drain goes
    // on filling the log, and the exit handler keeps the abort's reason.
    this.#process.once("error", (error: NodeJS.ErrnoException) => this.#onSpawnError(error));
    this.#process.once("exit", (exitCode, exitSignal) => this.#onExit(exitCode, exitSignal));
    this.#process.stdin.on("error", (error: Error) => this.#onStdinError(error));
    this.#process.stderr.on("data", (chunk: Buffer) => this.#onStderrData(chunk));

    // Single teardown convergence point. `onAbort` registers the one-shot teardown listener for the normal abort path AND runs it synchronously when the signal is
    // already aborted at construction time - typically because the caller passed a pre-aborted parent signal. Under that signal Node kills the child it spawned, so
    // the exit settles `exited` when the child spawned, and `#onSpawnError` settles it when the spawn itself failed and no exit will follow.
    onAbort(this.signal, () => this.#teardown());

    // Optional startup watchdog, armed at spawn on the options' clock - the system clock when the consumer wired none - and converting a lapsed window into our own
    // `"timeout"` reason. The first stderr byte clears it, and the primitive clears itself the moment the process signal aborts for any reason: a natural exit, a
    // spawn failure, an external abort, or a parent signal already aborted at construction, which leaves it never armed at all. It therefore fires only on a process
    // that is still running and still silent when the window lapses...this is a startup watchdog, not a general stall detector.
    this.#startupWatchdog = (startupTimeout !== undefined) ? new Watchdog({

      clock: this.options.clock,
      onFire: (): void => this.#controller.abort(new HbpuAbortError("timeout")),
      signal: this.signal,
      timeoutMs: startupTimeout
    }) : undefined;

    this.#startupWatchdog?.arm();
  }

  /**
   * Abort the process and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after natural exit is also safe for the
   * same reason.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}; platform errors (`TimeoutError`, `AbortError`) also interoperate by convention.
   */
  public abort(reason?: unknown): void {

    // Fast path - no need to construct a default reason if we are already done.
    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation. Aborts the process (defaulting to `"shutdown"`) and awaits actual exit before returning, so callers using `await using` are
   * guaranteed the child has terminated by the time the block exits.
   *
   * @returns A promise that resolves once the child has fully exited.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();

    // `exited` rejects only when the child never spawned. In either case, the caller's dispose scope is done; swallow the rejection so `await using` does not surface
    // disposal errors that the caller has no way to react to.
    await this.exited.catch(() => { /* Disposal is cleanup - do not re-raise exit failures at the dispose boundary. */ });
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * The composed FFmpeg argument vector this process was spawned with, readable from construction onward. The array is the frozen copy the class itself holds, returned
   * as a readonly view: callers read the exact vector the child received rather than recovering it from the construction log line.
   */
  public get commandLine(): readonly string[] {

    return this.args;
  }

  /**
   * `true` when the abort reason was `HbpuAbortError("failed")`. Covers spawn failures and non-zero natural exits. Derived from `this.signal.reason`; no stored flag.
   * The value is final by the time any listener on `this.signal` runs, so a consumer's abort handler can read it synchronously rather than waiting on `exited`.
   */
  public get hasError(): boolean {

    return isHbpuAbortReason(this.signal.reason, "failed");
  }

  /**
   * `true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` and the platform `TimeoutError` emitted by
   * `AbortSignal.timeout()`. The branching lives in {@link isTimeoutReason} so this getter stays a one-line delegation and every resource class in the library
   * shares one definition of "timeout."
   */
  public get isTimedOut(): boolean {

    return isTimeoutReason(this.signal.reason);
  }

  /**
   * The accumulated stderr lines this process has produced, preserved across teardown for post-mortem inspection. The array is returned as a readonly view to make the
   * intent explicit: callers read from it, they do not mutate it.
   */
  public get stderrLog(): readonly string[] {

    return this.#stderrLog;
  }

  // Called when Node emits an `"error"` event on the child. The handler has exactly one job: handle the genuine pre-spawn failure case where the syscall never assigned
  // a pid and no `"exit"` event will fire. Every other shape of error (post-spawn AbortError from the signal-driven kill path, post-spawn kill / IPC errors, anything
  // else Node might attach) lands on a live child whose `"exit"` event is the canonical settlement - the exit listener will resolve `exited` with real exit info, and
  // re-aborting from here would only overwrite a meaningful signal reason with a derived one.
  //
  // The pid check is the deciding test. `.pid` is assigned synchronously by libuv when fork+exec succeeds, so checking it here is a reliable "did the kernel run our
  // child?" test that does not depend on event-ordering between `"spawn"` and `"error"`. When pid is set the child is alive (or was alive); when pid is undefined, the
  // spawn syscall failed before assigning one and this handler owns the diagnostic + settlement.
  #onSpawnError(error: NodeJS.ErrnoException): void {

    // Post-spawn: the child got a pid, so the `"exit"` event is the canonical settlement. Skip - the exit handler will resolve `exited` with the real exit info and the
    // re-abort guard there preserves whatever signal reason aborted us.
    if(this.#process.pid !== undefined) {

      return;
    }

    // Genuine pre-spawn failure. Emit a user-facing diagnostic (ENOENT is the common case - wrong FFmpeg path), abort with a structured reason preserving the
    // underlying error via `cause`, and settle `exited` ourselves since nothing else will.
    const message = (error.code === "ENOENT") ? ("unable to find \"" + (error.path ?? "unknown") + "\"") : error.message;

    this.log.error("FFmpeg failed to start: %s.", message);

    if(!this.aborted) {

      this.#controller.abort(new HbpuAbortError("failed", { cause: error }));
    }

    this.#exitedResolvers.reject(this.signal.reason);
  }

  // Called when Node emits an `"exit"` event on the child. This is the canonical settlement point for `exited` regardless of whether the exit was natural or driven by
  // abort: the caller always gets to read the actual exit code / signal. When we are not yet aborted, we convert the exit into an abort reason; when we are already
  // aborted (because the caller or a parent triggered the teardown), the existing `signal.reason` stands and we only resolve `exited`.
  #onExit(exitCode: Nullable<number>, exitSignal: Nullable<NodeJS.Signals>): void {

    // Flush any trailing stderr buffer that did not end with a newline - callers inspecting `stderrLog` after exit should see the complete record.
    if(this.#stderrBuffer.length > 0) {

      this.#stderrLog.push(this.#stderrBuffer);
      this.#stderrBuffer = "";
    }

    // Canonical: always settle `exited` with the actual exit info. Even when abort drove the kill and the exit code reflects the signal we sent, callers benefit from
    // knowing what actually happened at the syscall level.
    this.#exitedResolvers.resolve({ exitCode, exitSignal });

    // Re-abort guard. If the signal is already aborted - because we aborted it externally, because a parent aborted, or because `#onSpawnError` aborted us - the
    // existing reason is authoritative. Re-aborting would overwrite a meaningful reason (e.g., `"shutdown"`) with a less useful one derived from the kill-driven exit.
    if(this.aborted) {

      return;
    }

    // Natural exit. Code 0 is the closed case; anything else is a failure. The cause shape is the single constant either way; only the reason name varies. The
    // `satisfies` operator holds production to the strict `FfmpegProcessExitInfo` type so `exited`'s callers get the `NodeJS.Signals` narrowing; the read-side guard
    // (`isExitInfoShape`) verifies what the runtime can actually check. Both sides share this literal shape, so a future rename of either field breaks both ends.
    const reasonName: HbpuAbortReason = (exitCode === 0) ? "closed" : "failed";
    const cause = { exitCode, exitSignal } satisfies FfmpegProcessExitInfo;

    this.#controller.abort(new HbpuAbortError(reasonName, { cause }));
  }

  // Stdin error listener. FFmpeg's stdin typically closes cleanly once we are done piping data; the only error we expect in normal operation is `EPIPE`, which happens
  // when we try to write after ffmpeg has already exited. We swallow `EPIPE` silently and log anything else. The stream stays writable after an abort until the killed
  // child exits, so a write in that window can still reach this listener and its `EPIPE` is swallowed like any other; the stream is destroyed at the exit and the
  // listener goes with it, so no manual `.off()` is needed.
  #onStdinError(error: Error): void {

    if(error.message.includes("EPIPE")) {

      return;
    }

    this.log.error("FFmpeg error: %s.", error.message);
  }

  // Stderr data listener. Responsibilities, in order: mark the process as "ready" and clear the startup watchdog on first byte (this is the only reliable signal that
  // FFmpeg is running, since stdin and stdout may not be used at all depending on the invocation), append each complete line to the rolling stderr log, mark the
  // options when a line reports that the hardware decoder refused the stream, and emit live-log output if configured.
  #onStderrData(chunk: Buffer): void {

    if(!this.#firstStderr) {

      this.#firstStderr = true;
      this.#startupWatchdog?.clear();
      this.#readyResolvers.resolve();
      this.log.debug("FFmpeg process started.");
    }

    // Replace non-printable characters with EOL so control sequences become line boundaries rather than silently vanishing. Keeping this as a pre-normalization step
    // means the line-splitting below does not have to worry about hidden escape sequences fracturing log entries.
    this.#stderrBuffer += chunk.toString().replace(NON_PRINTABLE_CHARS, EOL);

    // Line-by-line drain. EOL from `node:os` handles Windows-style line endings as a single unit; using it explicitly rather than searching for `"\n"` keeps this loop
    // correct across platforms.
    for(;;) {

      const lineIndex = this.#stderrBuffer.indexOf(EOL);

      if(lineIndex === -1) {

        return;
      }

      const line = this.#stderrBuffer.slice(0, lineIndex);

      this.#stderrBuffer = this.#stderrBuffer.slice(lineIndex + EOL.length);
      this.#stderrLog.push(line);

      // A line that reports the decoder's refusal marks our options the moment we read it, through the step in `process-ending.ts` a test double reads its lines
      // through as well. The assignment reads no line once this process has seen the refusal, keeping a long-running process's drain at one flag read per line.
      this.#sawHardwareDecoderRefusal ||= ffmpegMarkRefusal(line, this.options);

      if(this.#liveLog) {

        this.log.info(line);
      }
    }
  }

  // Single teardown convergence point. Fires exactly once (registered with `{ once: true }`) when `this.signal` aborts, regardless of which path triggered the abort.
  // Responsibilities: settle `ready` if still pending, apply the reason-based teardown log policy. Note that `exited` is NOT settled here - the `"exit"` or `"error"`
  // listener is the single source of truth for that promise, so that callers always read the real exit info when one is available.
  #teardown(): void {

    // Reject ready if still pending. If it already resolved because we saw first stderr, this call is a no-op (promise resolvers are inert after first settlement).
    this.#readyResolvers.reject(this.signal.reason);

    // Apply the reason-based teardown log policy.
    this.#logTeardown();
  }

  // Reason-based teardown logging. The policy is driven by `this.signal.reason`, mapping each reason variant to a log level and message shape:
  //
  //   - A refused GPU decode             -> DEBUG naming the refusal, with no callback asked: a `"failed"` reason on a process whose own stderr reported the hardware
  //                                         decoder's refusal and whose args asked for its decoded frames on the GPU. The refusal ended the process, and its options
  //                                         already decode every later pipeline in software.
  //   - `HbpuAbortError("failed", ...)`  -> the init's `onFailed`, then, unless it answers `"handled"`, ERROR with the full stderr dump and exit context.
  //   - `HbpuAbortError("timeout")`      -> the init's `onTimeout`, then, unless it answers `"handled"`, a static WARN.
  //   - Any other HbpuAbortError         -> DEBUG with the reason name (self-inflicted or orderly teardown).
  //   - Platform TimeoutError/AbortError -> DEBUG with the reason name (no dump).
  //   - Anything else                    -> DEBUG with a generic message.
  //
  // A callback lets a plugin report a failed or timed-out ending its own way without re-implementing this policy or trying to pre-empt the base's listener ordering:
  // it answers `"handled"` once it has said what it wants said, or `"default"` to let the report here stand. A process kind with answers of its own hands its base
  // callbacks that ask the plugin's first and its own after, so whether an ending asks a callback at all, which one and in what order is stated once, in the rules
  // `ffmpegEndingOutcome` and `ffmpegEndingVerdict` hold.
  #logTeardown(): void {

    const reason: unknown = this.signal.reason;

    if(isHbpuAbortError(reason)) {

      switch(reason.name) {

        case "failed": {

          const outcome = this.#endingOutcome(reason);

          if(outcome === "refused") {

            this.log.debug("%s because the hardware video decoder could not open the stream (%s).", this.#teardownPrefix, describeCause(reason.cause));

            return;
          }

          if(outcome === "default") {

            this.#logFailureReport(reason);
          }

          return;
        }

        case "timeout": {

          if(this.#endingOutcome(reason) === "default") {

            this.#logTimeoutReport();
          }

          return;
        }

        default: {

          this.log.debug("%s (%s).", this.#teardownPrefix, reason.name);

          return;
        }
      }
    }

    // Platform TimeoutError / AbortError or any other reason. Log at debug - if callers want richer behavior, they observe `exited` or attach their own abort listener.
    const name = (reason instanceof Error) ? reason.name : "unknown";

    this.log.debug("%s (%s).", this.#teardownPrefix, name);
  }

  // Decide a failed or timed-out ending, asking the init's ending callbacks unless this process's own refusal sighting makes it a refused GPU decode, here inside the
  // abort's dispatch, so the outcome is in before the report and before any abort listener a consumer added to this process's `signal` runs. A listener on the parent
  // signal the consumer passed in has already run by then, since the parent dispatches to its own listeners first. The asking is guarded because a throw inside the
  // dispatch would surface as Node's `uncaughtException` rather than reach the code that aborted us: a throwing callback is logged at error and read as `"default"`,
  // so the ending still gets the base's report.
  #endingOutcome(reason: HbpuAbortError): FfmpegEndingOutcome {

    try {

      return ffmpegEndingOutcome({ reason, stderrLog: this.stderrLog }, { args: this.args, sawRefusal: this.#sawHardwareDecoderRefusal }, this.#endingCallbacks);
    } catch(error: unknown) {

      this.log.error("%s, and its ending callback threw: %s.", this.#teardownPrefix, formatErrorMessage(error));

      return "default";
    }
  }

  // The default report for a failed ending: an "ended unexpectedly" summary naming the cause, the command that produced it, then every stderr line read, all at error.
  // The cause is the exit information for an exit other than with code 0, the underlying `Error` for a spawn failure, or whatever the code that aborted the process
  // attached.
  #logFailureReport(reason: HbpuAbortError): void {

    this.log.error("%s unexpectedly. Reason: %s.", this.#teardownPrefix, describeCause(reason.cause));
    this.log.error("FFmpeg (%s) command that errored out was: %s %s.", this.#ffmpegVersion, this.#ffmpegExec, this.args.join(" "));

    for(const line of this.#stderrLog) {

      this.log.error(line);
    }
  }

  // The default report for a timed-out ending: one warning, because a stall that trips a watchdog on a general FFmpeg process, a live stream among them, genuinely is a
  // problem. A process kind whose timeout is routine answers `onTimeout` itself and leaves the severity to the consumer that holds the input-feed context.
  #logTimeoutReport(): void {

    this.log.warn("%s: stalled past its watchdog window.", this.#teardownPrefix);
  }

  // Common prefix used by the BASE teardown log lines: the caller's camera / session name followed by the canonical teardown phrase. Single source of truth so the
  // wording stays consistent across the failed / timeout / debug DEFAULT bodies, the line for a throwing callback, and any future base teardown message. An ending
  // callback cannot reach this private getter and composes its own line from the options it was built over, so a change to this prefix leaves a callback's wording as
  // it is. Keyed off `options.name()` rather than cached because the name function can return different values over the instance's lifetime (e.g., a mid-session camera
  // rename in HBUP).
  get #teardownPrefix(): string {

    return this.options.name() + ": FFmpeg process ended";
  }

  // Private forwarders to the codec-support scalars this class reads during spawn and teardown; routing each through a named accessor keeps the long
  // `this.options.config.codecSupport.X` path out of the call sites and makes it obvious at a glance which config values the class actually depends on. The class
  // reads these scalars from a handful of call sites across construction, spawn, and teardown. No stored state - each getter is a one-line forward through the
  // config chain.
  get #ffmpegExec(): string {

    return this.options.config.codecSupport.ffmpegExec;
  }

  get #ffmpegVersion(): string {

    return this.options.config.codecSupport.ffmpegVersion;
  }

  get #verbose(): boolean {

    return this.options.config.codecSupport.verbose;
  }
}
