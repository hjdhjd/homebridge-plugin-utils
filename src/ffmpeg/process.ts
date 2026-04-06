/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/process.ts: Base class to provide FFmpeg process control and capability introspection.
 */

/**
 * FFmpeg process management and capability introspection.
 *
 * This module defines the `FfmpegProcess` class, which abstracts the spawning, monitoring, and logging of FFmpeg subprocesses. It manages process state, handles
 * command-line argument composition, processes standard streams (stdin, stdout, stderr), and robustly reports process errors and exit conditions.
 *
 * Designed for use in Homebridge plugins, this module enables safe and flexible execution of FFmpeg commands, making it easier to integrate video/audio processing
 * pipelines with realtime control and diagnostics.
 *
 * Key features:
 *
 * - Comprehensive FFmpeg subprocess management (start, monitor, stop, cleanup).
 * - Streamlined error handling and logging, with pluggable loggers.
 * - Access to process I/O streams for data injection and consumption.
 * - Flexible callback and event-based architecture for streaming scenarios.
 *
 * Intended for developers needing direct, reliable control over FFmpeg process lifecycles with detailed runtime insights, especially in plugin or media automation
 * contexts.
 *
 * @module
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { HomebridgePluginLogging, Nullable } from "../util.js";
import type { Readable, Writable } from "node:stream";
import { EOL } from "node:os";
import { EventEmitter } from "node:events";
import { FFMPEG_INPUT_TIMEOUT } from "./settings.js";
import type { FfmpegOptions } from "./options.js";
import type { StreamRequestCallback } from "homebridge";
import util from "node:util";

// Matches non-printable control characters for stripping from FFmpeg stderr output. Compiled once at module scope rather than per data event.
const NON_PRINTABLE_CHARS = /\p{C}+/gu;

/**
 * Base class providing FFmpeg process management and capability introspection.
 *
 * This class encapsulates spawning, managing, and logging of FFmpeg processes, as well as handling process I/O and errors. It is designed as a reusable foundation for
 * advanced FFmpeg process control in Homebridge plugins or similar environments. Originally inspired by the Homebridge and homebridge-camera-ffmpeg source code.
 *
 * @example
 *
 * ```ts
 * // Create and start an FFmpeg process.
 * const process = new FfmpegProcess(options, ["-i", "input.mp4", "-f", "null", "-"]);
 * process.start();
 *
 * // Access process streams if needed.
 * const stdin = process.stdin;
 * const stdout = process.stdout;
 * const stderr = process.stderr;
 *
 * // Stop the FFmpeg process when done.
 * process.stop();
 * ```
 *
 * @see {@link https://ffmpeg.org/documentation.html | FFmpeg Documentation}
 *
 * @see {@link https://nodejs.org/api/child_process.html | Node.js child_process}
 *
 * @see FfmpegOptions
 *
 * @category FFmpeg
 */
export class FfmpegProcess extends EventEmitter {

  /**
   * Optional callback to be called when the FFmpeg process is ready for streaming.
   */
  protected callback: Nullable<StreamRequestCallback>;

  /**
   * The command line arguments for invoking FFmpeg.
   */
  protected commandLineArgs: string[];

  /**
   * Enables verbose logging for FFmpeg process output.
   */
  protected isVerbose: boolean;

  /**
   * Logger instance for output and error reporting.
   */
  protected readonly log: HomebridgePluginLogging;

  /**
   * FFmpeg process configuration options.
   */
  protected readonly options: FfmpegOptions;

  /**
   * The underlying Node.js ChildProcess instance for the FFmpeg process.
   */
  protected process: Nullable<ChildProcessWithoutNullStreams>;

  private _hasError: boolean;
  private _isStarted: boolean;

  /**
   * Accumulated log lines from standard error for error reporting and debugging.
   */
  private _stderrLog: string[];

  private ffmpegTimeout?: NodeJS.Timeout;
  private isLogging: boolean;
  private stderrBuffer: string;

  /**
   * Indicates whether the FFmpeg process has ended. Protected to allow subclass state transitions (e.g., signaling generators before shutdown).
   */
  protected _isEnded: boolean;

  // Create a new FFmpeg process instance.
  constructor(options: FfmpegOptions, commandLineArgs?: string[], callback?: StreamRequestCallback) {

    // Initialize our parent.
    super();

    this.callback = null;
    this.commandLineArgs = [];
    this._hasError = false;
    this._isEnded = false;
    this._isStarted = false;
    this.isLogging = false;
    this.log = options.log;
    this.options = options;
    this.process = null;
    this.stderrBuffer = "";
    this._stderrLog = [];

    // Toggle FFmpeg logging, if configured.
    this.isVerbose = this.options.codecSupport.verbose;

    // If we've specified a command line or a callback, let's save them.
    if(commandLineArgs) {

      this.commandLineArgs = commandLineArgs;
    }

    if(callback) {

      this.callback = callback;
    }
  }

  // Prepare and start our FFmpeg process.
  private prepareProcess(commandLineArgs?: string[], callback?: StreamRequestCallback): boolean {

    // If we've specified a new command line or callback, let's save them.
    if(commandLineArgs) {

      this.commandLineArgs = commandLineArgs;
    }

    // Save the callback, if we have one.
    if(callback) {

      this.callback = callback;
    }

    // See if we should display ffmpeg command output.
    this.isLogging = false;

    // Track if we've started or ended FFmpeg.
    this._isStarted = false;
    this._isEnded = false;

    // If we've got a loglevel specified, ensure we display it.
    if(this.commandLineArgs.includes("-loglevel")) {

      this.isLogging = true;
    }

    // Inform the user, if we've been asked to do so.
    if(this.isLogging || this.isVerbose || this.options.debug) {

      this.log.info("FFmpeg command (version: %s): %s %s", this.options.codecSupport.ffmpegVersion, this.options.codecSupport.ffmpegExec,
        this.commandLineArgs.join(" "));
    } else {

      this.log.debug("FFmpeg command (version: %s): %s %s", this.options.codecSupport.ffmpegVersion, this.options.codecSupport.ffmpegExec,
        this.commandLineArgs.join(" "));
    }

    return true;
  }

  /**
   * Starts the FFmpeg process with the provided command line and callback.
   *
   * @param commandLineArgs  - Optional. Arguments for FFmpeg command line.
   * @param callback         - Optional. Callback invoked when streaming is ready.
   * @param errorHandler     - Optional. Function called if FFmpeg fails to start or terminates with error.
   *
   * @example
   *
   * ```ts
   * process.start(["-i", "input.mp4", "-f", "null", "-"]);
   * ```
   */
  public start(commandLineArgs?: string[], callback?: StreamRequestCallback, errorHandler?: (errorMessage: string) => Promise<void> | void): void {

    // Prepared our FFmpeg process.
    if(!this.prepareProcess(commandLineArgs, callback)) {

      this.log.error("Error preparing to run FFmpeg.");

      return;
    }

    // Execute the command line based on what we've prepared.
    this.process = spawn(this.options.codecSupport.ffmpegExec, this.commandLineArgs);

    // Configure any post-spawn listeners and other plumbing.
    this.configureProcess(errorHandler);
  }

  // Configure our FFmpeg process, once started.
  protected configureProcess(errorHandler?: (errorMessage: string) => Promise<void> | void): void {

    let dataListener: (data: Buffer) => void;
    let errorListener: (error: Error) => void;

    // Handle errors emitted during process creation, such as an invalid command line.
    this.process?.once("error", (error: NodeJS.ErrnoException) => {

      let message = error.message;

      if(error.code === "ENOENT") {

        message = "unable to find '" + (error.path ?? "unknown") + "'";
      }

      this.log.error("FFmpeg failed to start: %s.", message);

      // Execute our error handler, if one is provided.
      if(errorHandler) {

        void errorHandler(error.name + ": " + message);
      }
    });

    // Handle errors on stdin.
    this.process?.stdin.on("error", errorListener = (error: Error): void => {

      if(!error.message.includes("EPIPE")) {

        this.log.error("FFmpeg error: %s.", error.message);
      }

    });

    // Handle logging output that gets sent to stderr.
    this.process?.stderr.on("data", dataListener = (data: Buffer): void => {

      // Inform us when we start receiving data back from FFmpeg. We do this here because it's the only
      // truly reliable place we can check on FFmpeg. stdin and stdout may not be used at all, depending
      // on the way FFmpeg is called, but stderr will always be there.
      if(!this._isStarted) {

        this._isStarted = true;
        this._isEnded = false;
        this.log.debug("FFmpeg process started.");

        // Always remember to execute the callback once we're setup to let homebridge know we're streaming.
        if(this.callback) {

          this.callback();
          this.callback = null;
        }
      }

      // Append to the current line we've been buffering. We don't want to output not-printable characters to ensure the log output is readable.
      this.stderrBuffer += data.toString().replace(NON_PRINTABLE_CHARS, EOL);

      // Debugging and additional logging collection.
      for(;;) {

        // Find the next newline.
        const lineIndex = this.stderrBuffer.indexOf(EOL);

        // If there's no newline, we're done until we get more data.
        if(lineIndex === -1) {

          return;
        }

        // Grab the next complete line, and increment our buffer.
        const line = this.stderrBuffer.slice(0, lineIndex);

        this.stderrBuffer = this.stderrBuffer.slice(lineIndex + EOL.length);
        this._stderrLog.push(line);

        // Show it to the user if it's been requested.
        if(this.isLogging || this.isVerbose || this.options.debug) {

          this.log.info(line);
        }
      }
    });

    // Handle our process termination.
    this.process?.once("exit", (exitCode: Nullable<number>, signal: Nullable<NodeJS.Signals>) => {

      // Clear out our canary.
      if(this.ffmpegTimeout) {

        clearTimeout(this.ffmpegTimeout);
      }

      this._isStarted = false;
      this._isEnded = true;

      // Some utilities to streamline things.
      const logPrefix = "FFmpeg process ended ";

      // FFmpeg ended normally and our canary didn't need to enforce FFmpeg's extinction.
      if(this.ffmpegTimeout && (exitCode === 0)) {

        this.log.debug(logPrefix + "(Normal).");
      } else if(((exitCode === null) || (exitCode === 255)) && this.process?.killed) {

        // FFmpeg has ended. Let's figure out if it's because we killed it or whether it died of natural causes.
        this.log.debug(logPrefix + (signal === "SIGKILL" ? "(Killed)." : "(Expected)."));
      } else {

        // Flag that we've run into an FFmpeg error.
        this._hasError = true;

        // Flush out any remaining output in our error buffer.
        if(this.stderrBuffer.length) {

          this._stderrLog.push(this.stderrBuffer + "\n");
          this.stderrBuffer = "";
        }

        // Inform the user.
        this.logFfmpegError(exitCode, signal);

        // Execute our error handler, if one is provided.
        if(errorHandler) {

          void errorHandler(util.format(this.options.name() + ": " + logPrefix + " unexpectedly with exit code %s and signal %s.", exitCode, signal));
        }
      }

      // Cleanup after ourselves. We intentionally preserve _stderrLog so callers can inspect it for post-mortem diagnostics after the process exits.
      this.process?.stdin.off("error", errorListener);
      this.process?.stderr.off("data", dataListener);
      this.process = null;
    });
  }

  // Stop the FFmpeg process and complete any cleanup activities.
  protected stopProcess(): void {

    // Check to make sure we aren't using stdin for data before telling FFmpeg we're done.
    if(!this.commandLineArgs.includes("pipe:0")) {

      this.process?.stdin.end("q");
    }

    // Close our input and output.
    this.process?.stdin.destroy();
    this.process?.stdout.destroy();

    // In case we need to kill it again, just to be sure it's really dead.
    this.ffmpegTimeout = setTimeout(() => {

      this.process?.kill("SIGKILL");
    }, FFMPEG_INPUT_TIMEOUT);

    // Send the kill shot.
    this.process?.kill();
  }

  /**
   * Stops the FFmpeg process and performs necessary cleanup.
   *
   * @example
   *
   * ```ts
   * process.stop();
   * ```
   */
  public stop(): void {

    this.stopProcess();
  }

  /**
   * Logs an error message for FFmpeg process termination.
   *
   * @param exitCode         - The exit code from FFmpeg.
   * @param signal           - The signal, if any, used to terminate the process.
   */
  protected logFfmpegError(exitCode: Nullable<number>, signal: Nullable<NodeJS.Signals>): void {

    // Something else has occurred. Inform the user, and stop everything.
    this.log.error("FFmpeg process ended unexpectedly with %s%s%s.", (exitCode !== null) ? "an exit code of " + exitCode.toString() : "",
      ((exitCode !== null) && signal) ? " and " : "", signal ? "a signal received of " + signal : "");

    this.log.error("FFmpeg (%s) command that errored out was: %s %s", this.options.codecSupport.ffmpegVersion, this.options.codecSupport.ffmpegExec,
      this.commandLineArgs.join(" "));

    for(const x of this._stderrLog) {

      this.log.error(x);
    }
  }

  /**
   * Indicates if an error has occurred during FFmpeg process execution.
   */
  public get hasError(): boolean {

    return this._hasError;
  }

  /**
   * Indicates whether the FFmpeg process has ended.
   */
  public get isEnded(): boolean {

    return this._isEnded;
  }

  /**
   * Indicates whether the FFmpeg process has started.
   */
  public get isStarted(): boolean {

    return this._isStarted;
  }

  /**
   * Returns the accumulated standard error log lines from the FFmpeg process.
   *
   * @returns An array of stderr log lines.
   */
  public get stderrLog(): string[] {

    return this._stderrLog;
  }

  /**
   * Returns the writable standard input stream for the FFmpeg process, if available.
   *
   * @returns The standard input stream, or `null` if not available.
   */
  public get stdin(): Nullable<Writable> {

    return this.process?.stdin ?? null;
  }

  /**
   * Returns the readable standard output stream for the FFmpeg process, if available.
   *
   * @returns The standard output stream, or `null` if not available.
   */
  public get stdout(): Nullable<Readable> {

    return this.process?.stdout ?? null;
  }

  /**
   * Returns the readable standard error stream for the FFmpeg process, if available.
   *
   * @returns The standard error stream, or `null` if not available.
   */
  public get stderr(): Nullable<Readable> {

    return this.process?.stderr ?? null;
  }
}
