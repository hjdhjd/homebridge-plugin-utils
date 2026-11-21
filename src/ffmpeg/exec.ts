/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/exec.ts: One-shot FFmpeg execution - feed optional stdin, collect stdout, capture exit status.
 */

/**
 * One-shot FFmpeg execution with composed signal lifetime.
 *
 * This module defines `FfmpegExec`, the specialization of {@link FfmpegProcess} for the "feed a buffer, collect output, get an exit code" shape. Construction spawns
 * the child immediately (per the base class's spawn-on-construction contract); the composed `this.signal` governs its lifetime. The class narrows the inherited public
 * `stdout` to `never` because stdout is drained internally into {@link FfmpegExec.stdoutBuffer} and a concurrent external reader would race.
 *
 * Two usage shapes:
 *
 * - **Canned input.** Pass `stdin: Buffer` in the init options. The buffer is written to FFmpeg's stdin and the stream is ended on the next microtask after spawn, so
 *   one-liner callers do not have to touch the stdin stream at all.
 * - **Streaming input.** Omit the `stdin` init option and use the inherited `stdin` writable directly. Call `exec.stdin.end()` when done.
 *
 * Both patterns converge on {@link FfmpegExec.result}, which bundles the collected stdout, exit code, exit signal, and accumulated stderr log.
 *
 * A consumer that wants its one-shot runs under test constructs them through {@link ExecProcessFactory} and reads them through {@link ExecProcess}, the exec
 * dependency-inversion boundary, whose production factory is {@link execProcessFactory} and whose double ships on the testing entry point.
 *
 * @module
 */
import type { FfmpegOptions } from "./options.ts";
import { FfmpegProcess } from "./process.ts";
import type { FfmpegProcessInit } from "./process.ts";
import type { Nullable } from "../util.ts";
import type { Writable } from "node:stream";
import { buffer } from "node:stream/consumers";

/**
 * Construction-time options for {@link FfmpegExec}.
 *
 * @property stdin   - Optional. When provided, the buffer is written to FFmpeg's standard input and the stream is ended on the next microtask after spawn. Covers the
 *                     overwhelmingly common "feed this buffer, get stdout back" pattern without forcing callers to reach for the streaming-stdin API. Omit to drive
 *                     stdin manually via the inherited `stdin` writable.
 *
 * @see FfmpegProcessInit
 *
 * @category FFmpeg
 */
export interface FfmpegExecInit extends FfmpegProcessInit {

  stdin?: Buffer;
}

/**
 * Structured result returned by {@link FfmpegExec.result}.
 *
 * @property exitCode    - The process exit code, or `null` when the process was terminated by a signal.
 * @property exitSignal  - The signal name (e.g., `"SIGKILL"`) that terminated the process, or `null` when the process exited normally.
 * @property stderrLog   - The process's own readonly array of the stderr lines it accumulated, complete because the child has exited.
 * @property stdout      - The complete stdout bytes collected over the lifetime of the process.
 *
 * @category FFmpeg
 */
export interface ExecResult {

  exitCode: Nullable<number>;
  exitSignal: Nullable<NodeJS.Signals>;
  stderrLog: readonly string[];
  stdout: Buffer;
}

/**
 * The surface a one-shot consumer reads off an FFmpeg run, the contract each usage shape converges on. This is the product half of the exec dependency-inversion
 * boundary: a class that runs FFmpeg once depends on this narrow interface rather than the concrete {@link FfmpegExec}, so a test can substitute a double without
 * spawning FFmpeg. It is an interface rather than the class because the class's private fields make its type one that only a real subclass, which spawns a child, can
 * satisfy. The interface is type-only, so importing it costs a consumer nothing at runtime.
 *
 * {@link FfmpegExec} satisfies it with its own and inherited members and carries only an `implements` annotation. A consumer feeds `stdin`, or hands a canned buffer
 * in its init, reads the run through `result()`, and ends it through the signal it passed in its init.
 *
 * @see FfmpegExec
 * @see ExecProcessFactory
 *
 * @category FFmpeg
 */
export interface ExecProcess {

  /**
   * Resolves with the run's exit code, exit signal, stdout bytes and stderr lines once the child has exited, whatever its exit code, and rejects with the lifetime's
   * reason only when the child never started.
   *
   * @returns A promise resolving to the run's {@link ExecResult}.
   */
  result(): Promise<ExecResult>;

  /**
   * The composed abort signal representing the run's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause.
   */
  readonly signal: AbortSignal;

  /**
   * Writable standard input. A canned `stdin` buffer in the init is written to it and the stream ended on the next microtask, unless the lifetime has ended by then;
   * otherwise the consumer writes and ends it.
   */
  readonly stdin: Writable;
}

/**
 * The creational half of the exec dependency-inversion boundary: build an {@link ExecProcess} from the shared options and an optional init. A consumer holds this
 * factory typed as the abstraction and constructs through it, so a test can substitute a factory that returns a double, and a suite reads the command the consumer
 * assembled from the init it passed. The production factory is {@link execProcessFactory}, whose `create` is exactly the {@link FfmpegExec} constructor call, so
 * routing construction through this boundary changes no behavior.
 *
 * @see execProcessFactory
 * @see ExecProcess
 *
 * @category FFmpeg
 */
export interface ExecProcessFactory {

  /**
   * Construct and spawn a one-shot FFmpeg run for the supplied options and init.
   *
   * @param options - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init    - Optional init options. See {@link FfmpegExecInit}.
   *
   * @returns A new {@link ExecProcess}.
   */
  create(options: FfmpegOptions, init?: FfmpegExecInit): ExecProcess;
}

/**
 * One-shot FFmpeg execution. Extends {@link FfmpegProcess} directly, inheriting its spawn-on-construction and signal-driven teardown semantics and adding the small
 * surface that the "feed bytes, read bytes, get exit status" pattern needs.
 *
 * The public `stdout` type is narrowed to `never` via `declare`. Callers read collected output through {@link FfmpegExec.stdoutBuffer} (the raw Buffer) or
 * {@link FfmpegExec.result} (the bundled result with exit context). The narrowing is a type-level contract; pure-JS callers that reach past the types still see the
 * underlying Readable, but a concurrent external reader would race with our internal collector - "do not do that" is the appropriate enforcement bar for a TypeScript
 * library.
 *
 * The class satisfies {@link ExecProcess}, and a consumer that substitutes it under test constructs it through an {@link ExecProcessFactory}.
 *
 * @example
 *
 * ```ts
 * // Canned input, one-shot.
 * const exec = new FfmpegExec(options, { args, stdin: inputBuffer, signal });
 * const { exitCode, stdout } = await exec.result();
 * ```
 *
 * @example
 *
 * ```ts
 * // Streaming input - write stdin progressively before awaiting the result.
 * const exec = new FfmpegExec(options, { args, signal });
 *
 * exec.stdin.write(chunk1);
 * exec.stdin.write(chunk2);
 * exec.stdin.end();
 *
 * const { exitCode, stdout } = await exec.result();
 * ```
 *
 * @see FfmpegProcess
 *
 * @category FFmpeg
 */
export class FfmpegExec extends FfmpegProcess implements ExecProcess {

  /**
   * stdout is consumed internally by the collector loop. The public type is narrowed to `never` so TypeScript callers cannot accidentally attach a second reader.
   */
  public declare readonly stdout: never;

  /**
   * Promise that resolves with every byte the child wrote to stdout before its stdout pipe closed. The pipe closes for any reason - natural EOF after a clean exit,
   * abort-driven kill, synthetic stream destroy - and the promise settles the same way: whatever the consumer absorbed before close, byte-for-byte.
   *
   * Resolves with `Buffer.alloc(0)` only when the underlying readable surfaces a stream error (the catch branch in `#collectStdout`); the abort-kill
   * path does not normally produce a stream error, so an aborted run yields whatever bytes happened to arrive before the kill landed - which may be all of them, some
   * of them, or none of them.
   *
   * This promise is the data channel only. To distinguish "the child wrote nothing" from "the run was aborted before the child could write anything," consult
   * {@link FfmpegExec.exited} (`exitCode` / `exitSignal`) and {@link FfmpegProcess.signal} (`signal.reason`). Those are the single source of truth for process
   * disposition; an empty buffer carries no disposition meaning on its own.
   */
  public readonly stdoutBuffer: Promise<Buffer>;

  /**
   * Construct and spawn a new FFmpeg execution.
   *
   * Spawning happens synchronously as part of construction. When `init.stdin` is supplied, the buffer is written to stdin and the stream is ended on the next
   * microtask, giving synchronous post-construction caller code (e.g., attaching a drain listener) a chance to run before stdin I/O begins.
   *
   * @param options - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init    - Optional init options. See {@link FfmpegExecInit}.
   */
  public constructor(options: FfmpegOptions, init: FfmpegExecInit = {}) {

    super(options, init);

    // Drain stdout into an in-memory buffer via Node's `node:stream/consumers` helper. The consumer attaches the necessary listeners and respects internal buffering,
    // so chunks that landed in the paused stream before consumption began are still delivered. The collector is a pure transducer over the readable - it does not
    // observe the lifetime signal, and it deliberately knows nothing about why the readable might close. The disposition of the run lives in `exited` and
    // `signal.reason`; conflating it into the byte content would create a sentinel callers cannot rely on (Node's stream layer cannot deterministically deliver
    // "all-or-nothing" on a kill-driven close). The catch in `#collectStdout` exists only to honor the never-rejects shape on `stdoutBuffer` when the readable
    // surfaces a genuine stream error.
    this.stdoutBuffer = this.#collectStdout();

    // Canned stdin: write and end on the next microtask so synchronous caller code that runs between construction and the first await (e.g., attaching `"drain"` or
    // `"error"` listeners on the inherited `stdin` writable, inspecting `proc.signal`, wiring diagnostic hooks) executes before stdin I/O starts. We skip the write
    // when the composed signal has already aborted: the kill path is ending the child, so its stdin, writable until the exit, would only feed a run that is over, and
    // a write that lands once the killed child has gone would surface an EPIPE we would then have to swallow. The base class's own stdin error listener already
    // swallows EPIPE generally, so this guard is a redundant safeguard, not strictly required for correctness.
    if(init.stdin !== undefined) {

      const stdinBuffer = init.stdin;

      queueMicrotask(() => {

        if(this.aborted) {

          return;
        }

        this._stdin.end(stdinBuffer);
      });
    }
  }

  /**
   * Await the process to completion and return the bundled result.
   *
   * Resolves once the stdout collector and the base class's `exited` promise have settled. Rejects with the reason `exited` rejects with, which it does only when
   * the child never spawned (e.g., ENOENT). On any normal exit, including non-zero exit codes, this method resolves; callers distinguish outcomes by inspecting
   * `exitCode` and `exitSignal` in the result, or the derived `hasError` getter on the instance.
   *
   * @returns A promise resolving to an {@link ExecResult} bundling stdout, exit code, exit signal, and the accumulated stderr log.
   */
  public async result(): Promise<ExecResult> {

    const [ stdout, exit ] = await Promise.all([ this.stdoutBuffer, this.exited ]);

    return { exitCode: exit.exitCode, exitSignal: exit.exitSignal, stderrLog: this.stderrLog, stdout };
  }

  // Buffer-collector wrapper around `node:stream/consumers` `buffer()`. The happy path resolves with whatever bytes the consumer absorbed before the readable closed,
  // for any close cause - clean EOF, kill-driven pipe close after abort, anything else. The catch is reserved for the rare path where the readable surfaces a stream
  // error (e.g., a synthetic `readable.destroy(err)` injected by a test, a hardware-level pipe fault); we resolve with `Buffer.alloc(0)` there only to preserve the
  // never-rejects shape on `stdoutBuffer`. Private method rather than an inline `await buffer(...)` because keeping the try/catch in one place preserves that
  // shape across every caller path.
  async #collectStdout(): Promise<Buffer> {

    try {

      return await buffer(this._stdout);
    } catch {

      return Buffer.alloc(0);
    }
  }
}

/**
 * The production {@link ExecProcessFactory}: builds the concrete FFmpeg-backed one-shot run. A consumer holds this typed as the abstraction; a test substitutes a fake
 * factory. `create` is exactly the {@link FfmpegExec} constructor call, so wiring construction through this boundary changes no behavior.
 *
 * @see ExecProcessFactory
 *
 * @category FFmpeg
 */
export const execProcessFactory: ExecProcessFactory = {

  create: (options: FfmpegOptions, init?: FfmpegExecInit): ExecProcess => new FfmpegExec(options, init)
};
