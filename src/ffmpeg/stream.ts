/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/stream.ts: Provide FFmpeg process control to support HomeKit livestreaming.
 */

/**
 * FFmpeg process management and socket handling to support HomeKit livestreaming sessions.
 *
 * This module defines the `FfmpegStreamingProcess` class and related interfaces for orchestrating and monitoring FFmpeg-powered video streams. It manages process
 * lifecycle, handles UDP socket creation for video health monitoring, and enables integration with Homebridge streaming delegates for robust error handling, stream
 * cleanup, and automatic tuning.
 *
 * Key features:
 *
 * - Automated start, monitoring, and termination of HomeKit-compatible FFmpeg video streams.
 * - Integration with Homebridge’s CameraStreamingDelegate for custom error hooks and lifecycle control.
 * - UDP socket creation and management for realtime video stream liveness detection.
 * - Intelligent error handling, including automatic tuning for FFmpeg’s stream probing requirements.
 * - Exposes access to the underlying FFmpeg child process for advanced scenarios.
 *
 * Designed for plugin developers and advanced users who require fine-grained control and diagnostics for HomeKit livestreaming, with seamless Homebridge integration.
 *
 * @module
 */
import type { CameraController, CameraStreamingDelegate, StreamRequestCallback } from "homebridge";
import type { ChildProcessWithoutNullStreams } from "child_process";
import type { FfmpegOptions } from "./options.js";
import { FfmpegProcess } from "./process.js";
import type { Nullable } from "../util.js";
import { createSocket } from "node:dgram";

/**
 * Extension of the Homebridge CameraStreamingDelegate with additional streaming controls and error handling hooks.
 *
 * @property adjustProbeSize     - Optional. Invoked to adjust probe size after stream startup errors.
 * @property controller          - The Homebridge CameraController instance managing the stream.
 * @property ffmpegErrorCheck    - Optional. Returns a user-friendly error message for specific FFmpeg errors, if detected.
 * @property stopStream          - Optional. Invoked to force stop a specific stream session by ID.
 *
 * @see CameraController
 * @see CameraStreamingDelegate
 *
 * @category FFmpeg
 */
export interface HomebridgeStreamingDelegate extends CameraStreamingDelegate {

  adjustProbeSize?: () => void;
  controller: CameraController;
  ffmpegErrorCheck?: (logEntry: string[]) => string | undefined;
  stopStream?: (sessionId: string) => void;
}

/**
 * Provides FFmpeg process management and socket handling to support HomeKit livestreaming sessions.
 *
 * This class extends `FfmpegProcess` to create, monitor, and terminate HomeKit-compatible video streams. Additionally, it invokes delegate hooks for error processing and
 * stream lifecycle management.
 *
 * @example
 *
 * ```ts
 * const streamingDelegate: HomebridgeStreamingDelegate = {
 *
 *   controller,
 *   stopStream: (sessionId) => { ... } // End-of-session cleanup code.
 * };
 *
 * const process = new FfmpegStreamingProcess(
 *
 *   streamingDelegate,
 *   sessionId,
 *   ffmpegOptions,
 *   commandLineArgs,
 *   { addressVersion: "ipv4", port: 5000 }
 * );
 * ```
 *
 * @see HomebridgeStreamingDelegate
 * @see FfmpegProcess
 *
 * @category FFmpeg
 */
export class FfmpegStreamingProcess extends FfmpegProcess {

  /*
   * The streaming delegate instance responsible for handling stream events and errors.
   */
  private delegate: HomebridgeStreamingDelegate;

  /**
   * The unique session identifier for this streaming process.
   */
  private sessionId: string;

  /**
   * The timeout reference used to monitor UDP stream health.
   */
  private streamTimeout?: NodeJS.Timeout;

  /**
   * Constructs a new FFmpeg streaming process for a HomeKit session.
   *
   * Sets up required delegate hooks, creates UDP return sockets if needed, and starts the FFmpeg process. Automatically handles FFmpeg process errors and cleans up on
   * failures.
   *
   * @param delegate         - The Homebridge streaming delegate for this session.
   * @param sessionId        - The HomeKit session identifier for this stream.
   * @param ffmpegOptions    - The FFmpeg configuration options.
   * @param commandLineArgs  - FFmpeg command-line arguments.
   * @param returnPort       - Optional. UDP port info for talkback support (used for two-way audio in HomeKit for cameras that support it).
   * @param callback         - Optional. Callback invoked when the stream is ready or errors occur.
   *
   * @example
   *
   * ```ts
   * const process = new FfmpegStreamingProcess(delegate, sessionId, ffmpegOptions, commandLineArgs, { addressVersion: "ipv6", port: 6000 });
   * ```
   */
  constructor(delegate: HomebridgeStreamingDelegate, sessionId: string, ffmpegOptions: FfmpegOptions, commandLineArgs: string[],
    returnPort?: { addressVersion: string, port: number }, callback?: StreamRequestCallback) {

    // Initialize our parent.
    super(ffmpegOptions);

    this.delegate = delegate;

    this.delegate.adjustProbeSize ??= (): void => {};
    this.delegate.ffmpegErrorCheck ??= (): undefined => undefined;
    this.delegate.stopStream ??= (): void => {};

    this.sessionId = sessionId;

    // Create the return port for FFmpeg, if requested to do so. The only time we don't do this is when we're standing up
    // a two-way audio stream - in that case, the audio work is done through RtpSplitter and not here.
    if(returnPort) {

      this.createSocket(returnPort);
    }

    // Start it up, with appropriate error handling.
    this.start(commandLineArgs, callback, (errorMessage: string) => {

      // Stop the stream.
      this.delegate.stopStream?.(this.sessionId);

      // Let homebridge know what happened and stop the stream if we've already started.
      if(!this.isStarted && this.callback) {

        this.callback(new Error(errorMessage));
        this.callback = null;

        return;
      }

      // Tell Homebridge to forcibly stop the streaming session.
      this.delegate.controller.forceStopStreamingSession(this.sessionId);
      this.delegate.stopStream?.(this.sessionId);
    });
  }

  /**
   * Creates and binds a UDP socket for monitoring the health of the outgoing video stream.
   *
   * Listens for UDP "message" events, sets and clears timeouts, and handles error/cleanup scenarios. If no messages are received within 5 seconds, forcibly stops the
   * stream and informs the delegate.
   *
   * @param portInfo - Object containing the address version ("ipv4" or "ipv6") and port number.
   */
  private createSocket(portInfo: { addressVersion: string, port: number }): void {

    let errorListener: (error: Error) => void;
    let messageListener: () => void;
    const socket = createSocket(portInfo.addressVersion === "ipv6" ? "udp6" : "udp4");

    // Cleanup after ourselves when the socket closes.
    socket.once("close", () => {

      if(this.streamTimeout) {

        clearTimeout(this.streamTimeout);
      }

      socket.off("error", errorListener);
      socket.off("message", messageListener);
    });

    // Handle potential network errors.
    socket.on("error", errorListener = (error: Error): void => {

      this.log.error("Socket error: %s.", error.name);
      void this.delegate.stopStream?.(this.sessionId);
    });

    // Manage our video streams in case we haven't received a stop request, but we're in fact dead zombies.
    socket.on("message", messageListener = (): void => {

      // Clear our last canary.
      if(this.streamTimeout) {

        clearTimeout(this.streamTimeout);
      }

      // Set our new canary.
      this.streamTimeout = setTimeout(() => {

        this.log.debug("Video stream appears to be inactive for 5 seconds. Stopping stream.");

        this.delegate.controller.forceStopStreamingSession(this.sessionId);
        void this.delegate.stopStream?.(this.sessionId);
      }, 5000);
    });

    // Bind to the port we're opening.
    socket.bind(portInfo.port, (portInfo.addressVersion === "ipv6") ? "::1" : "127.0.0.1");
  }

  /**
   * Returns the underlying FFmpeg child process, or null if the process is not running.
   *
   * @returns The current FFmpeg process, or `null` if not running.
   *
   * @example
   *
   * ```ts
   * const ffmpeg = process.ffmpegProcess;
   *
   * if(ffmpeg) {
   *
   *   // Interact directly with the child process if necessary.
   * }
   * ```
   */
  public get ffmpegProcess(): Nullable<ChildProcessWithoutNullStreams> {

    return this.process;
  }

  /**
   * Handle and logs FFmpeg process errors.
   *
   * If a known error condition is detected by the delegate, logs the custom message and returns. For "not enough frames to estimate rate; consider increasing probesize"
   * errors, invokes the delegate's `adjustProbeSize` hook for automatic tuning. Otherwise, falls back to the parent class's logging.
   *
   * @param exitCode - The exit code from FFmpeg.
   * @param signal   - The signal, if any, used to terminate the process.
   */
  protected logFfmpegError(exitCode: number, signal: NodeJS.Signals): void {

    // We want to process known streaming-related errors due to the performance and latency tweaks we've made to the FFmpeg command line. In some cases we may inform the
    // user and take no action, in others, we tune our own internal parameters.

    // Process any specific errors our caller is interested in.
    const errTest = this.delegate.ffmpegErrorCheck?.(this.stderrLog);

    if(errTest) {

      this.log.error(errTest);

      return;
    }

    // Test for probesize errors.
    const probesizeRegex = new RegExp("not enough frames to estimate rate; consider increasing probesize");

    if(this.stderrLog.some(logEntry => probesizeRegex.test(logEntry))) {

      // Let the streaming delegate know to adjust it's parameters for the next run and inform the user.
      this.delegate.adjustProbeSize?.();

      return;
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
  }
}
