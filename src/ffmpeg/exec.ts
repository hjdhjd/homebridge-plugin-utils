/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/exec.ts: Execute arbitrary FFmpeg commands and return the results.
 */

/**
 * Executes arbitrary FFmpeg commands and returns the results.
 *
 * This module exposes the `FfmpegExec` class, which extends the core process handling of FFmpeg to support running custom command-line operations. It enables developers
 * to run FFmpeg commands from Node.js, capture both standard output and error streams, handle process exit codes, and optionally supply input via stdin.
 *
 * Intended for plugin developers and advanced users, this module is ideal for scenarios where you need direct control over FFmpeg execution—such as probing media,
 * transcoding, or automation tasks—while still benefiting from structured result handling and robust error logging.
 *
 * Key features:
 *
 * - Execute any FFmpeg command with custom arguments.
 * - Capture stdout, stderr, and exit codes as structured results.
 * - Optional stdin data injection.
 * - Configurable error logging.
 *
 * @module
 */
import type { FfmpegOptions } from "./options.js";
import { FfmpegProcess } from "./process.js";
import type { Nullable } from "../util.js";

/**
 * Describes the result of executing an FFmpeg process.
 *
 * @property exitCode        - The process exit code, or `null` if not available.
 * @property stderr          - The standard error output as a Buffer.
 * @property stdout          - The standard output as a Buffer.
 *
 * @category FFmpeg
 */
export type ProcessResult = {

  exitCode: Nullable<number>;
  stderr: Buffer;
  stdout: Buffer;
};

/**
 * Executes arbitrary FFmpeg commands and returns the results.
 *
 * This class extends `FfmpegProcess` to provide a simple interface for running FFmpeg with custom command-line arguments, capturing both standard output and standard
 * error, and returning process results in a structured format. Intended for plugin authors and advanced users who need to programmatically execute FFmpeg commands and
 * capture their results.
 *
 * @example
 *
 * ```ts
 * const exec = new FfmpegExec(options, ["-version"]);
 * const result = await exec.exec();
 *
 * if(result && result.exitCode === 0) {
 *
 *   console.log(result.stdout.toString());
 * }
 * ```
 *
 * @see FfmpegProcess
 * @see {@link https://ffmpeg.org/documentation.html | FFmpeg Documentation}
 *
 * @category FFmpeg
 */
export class FfmpegExec extends FfmpegProcess {

  private isLoggingErrors: boolean;

  /**
   * Creates a new instance of `FfmpegExec`.
   *
   * @param options          - The options used to configure FFmpeg execution.
   * @param commandLineArgs  - Optional. Command-line arguments to pass to the FFmpeg process.
   * @param logErrors        - Optional. If `true`, errors will be logged; otherwise, they will be suppressed. Defaults to `true`.
   *
   * @example
   *
   * ```ts
   * const exec = new FfmpegExec(options, ["-i", "input.mp4", "-f", "null", "-"]);
   * ```
   */
  constructor(options: FfmpegOptions, commandLineArgs?: string[], logErrors = true) {

    // Initialize our parent.
    super(options, commandLineArgs);

    // We want to log errors when they occur.
    this.isLoggingErrors = logErrors;
  }

  /**
   * Runs the FFmpeg process and returns the result, including exit code, stdout, and stderr.
   *
   * If `stdinData` is provided, it will be written to the process's standard input before execution. Returns `null` if the process fails to start.
   *
   * @param stdinData        - Optional. Data to write to FFmpeg's standard input.
   *
   * @returns A promise that resolves to a `ProcessResult` object containing the exit code, stdout, and stderr, or `null` if the process could not be started.
   *
   * @example
   *
   * ```ts
   * const exec = new FfmpegExec(options, ["-i", "input.wav", "output.mp3"]);
   * const result = await exec.exec();
   *
   * if(result) {
   *
   *   console.log("Exit code:", result.exitCode);
   *   console.log("FFmpeg output:", result.stdout.toString());
   * }
   * ```
   */
  public async exec(stdinData?: Buffer): Promise<Nullable<ProcessResult>> {

    return new Promise<Nullable<ProcessResult>>((resolve) => {

      this.start();

      if(this.process === null) {

        this.log.error("Unable to execute command.");

        return null;
      }

      // Write data to stdin and close
      if(stdinData) {

        this.process.stdin.end(stdinData);
      }

      const stderr: Buffer[] = [];
      const stdout: Buffer[] = [];

      // Read standard output and standard error into buffers.
      this.process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      this.process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

      // We prepend this listener to ensure we can properly cleanup after ourselves.
      this.process.prependOnceListener("exit", () => {

        // Trigger our process cleanup activities.
        this.stop();
      });

      // Return when process is done.
      this.process.once("exit", (exitCode) => {

        // Return the output and results.
        resolve({

          exitCode,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout)
        });
      });
    });
  }

  /**
   * Logs errors encountered during FFmpeg execution.
   *
   * If error logging is disabled, this method will do nothing. Otherwise, it calls the parent implementation for standard logging behavior.
   *
   * @param exitCode         - The exit code returned by the FFmpeg process.
   * @param signal           - The signal used to terminate the process, if any.
   */
  protected logFfmpegError(exitCode: number, signal: NodeJS.Signals): void {

    // If we're ignoring errors, we're done.
    if(!this.isLoggingErrors) {

      return;
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
  }

}
