/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * backpressure.ts: Backpressure-aware write queue for Node.js writable streams.
 */

/**
 * Backpressure-aware write queue for Node.js writable streams.
 *
 * This module provides a utility class for writing data to a writable stream while respecting backpressure signals. It maintains an internal queue and serializes writes,
 * pausing when the stream signals it isn't ready and resuming when it drains. This is particularly useful when feeding data from an event-driven source (e.g., fMP4
 * segments from a livestream) into a process stdin that may not consume data as fast as it arrives.
 *
 * @module
 */
import type { Nullable } from "./util.js";
import type { Writable } from "node:stream";

/**
 * A backpressure-aware write queue that serializes writes to a writable stream, pausing when the stream signals backpressure and resuming on drain.
 *
 * The stream is resolved lazily via a getter function on each write, allowing the writer to be created before the stream exists and to handle stream replacement across
 * process restarts.
 *
 * @example
 *
 * ```ts
 * // Create a writer that feeds segments to an FFmpeg process stdin.
 * const writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null);
 *
 * // Enqueue segments as they arrive from a livestream source.
 * livestream.on("segment", (segment) => writer.write(segment));
 *
 * // When the session ends, close the writer to release pending data.
 * writer.close();
 * ```
 *
 * @category Utilities
 */
export class BackpressureWriter {

  private drainListener: Nullable<() => void>;
  private drainStream: Nullable<Writable>;
  private readonly getStream: () => Nullable<Writable>;
  private isClosed: boolean;
  private isWriting: boolean;
  private readonly onWrite: Nullable<() => void>;
  private readonly queue: Buffer[];

  /**
   * Creates a new backpressure-aware write queue.
   *
   * @param getStream    - A function that returns the current writable stream, or `null` if the stream is unavailable. Evaluated on each write attempt, allowing the
   *                        writer to be created before the stream exists or to track a stream that changes across process restarts. For a static stream, wrap it in an
   *                        arrow function: `() => stream`.
   * @param onWrite      - Optional. A callback invoked after each segment is successfully written to the underlying stream. Useful for tracking write statistics.
   *
   * @example
   *
   * ```ts
   * // Lazy resolution...the stream is resolved on each write.
   * const writer = new BackpressureWriter(() => this.ffmpegProcess?.stdin ?? null, () => segmentCount++);
   *
   * // Static stream...wrap in an arrow function.
   * const writer = new BackpressureWriter(() => stream);
   * ```
   */
  constructor(getStream: () => Nullable<Writable>, onWrite?: () => void) {

    this.drainListener = null;
    this.drainStream = null;
    this.getStream = getStream;
    this.isClosed = false;
    this.isWriting = false;
    this.onWrite = onWrite ?? null;
    this.queue = [];
  }

  /**
   * Enqueues data to be written to the stream. If the stream is available and not under backpressure, the data is written immediately. Otherwise, it is queued and
   * written when the stream signals it is ready via the drain event.
   *
   * @param data         - The buffer to write to the stream.
   *
   * @returns Returns `true` if the data was accepted (stream is available), `false` if the stream is unavailable or the writer has been closed.
   */
  public write(data: Buffer): boolean {

    // If the writer has been closed or the stream is unavailable or not writable, reject the write.
    const stream = this.isClosed ? null : this.getStream();

    if(!stream?.writable) {

      return false;
    }

    // Add the data to the queue and process it.
    this.queue.push(data);
    this.processQueue();

    return true;
  }

  /**
   * Closes the writer, clearing any pending data and removing drain listeners. After closing, all subsequent writes are rejected. This should be called when the
   * underlying stream is being shut down or the session is ending.
   */
  public close(): void {

    this.isClosed = true;
    this.isWriting = false;
    this.queue.length = 0;

    // Remove any pending drain listener.
    if(this.drainListener && this.drainStream) {

      this.drainStream.off("drain", this.drainListener);
      this.drainListener = null;
      this.drainStream = null;
    }
  }

  /**
   * Returns the number of segments currently queued and waiting to be written.
   */
  public get pending(): number {

    return this.queue.length;
  }

  // Process the write queue. Dequeues segments and writes them to the stream, respecting backpressure by waiting for drain events before continuing. The synchronous
  // success path uses a loop rather than recursion to avoid growing the call stack when processing a burst of queued segments (e.g., initial timeshift buffer flush).
  private processQueue(): void {

    // If we already have a write in progress, we're done...the drain listener will resume processing.
    if(this.isWriting) {

      return;
    }

    // Process as many queued segments as the stream can accept without backpressure.
    while(this.queue.length) {

      // Resolve the stream. If it's gone or no longer writable, we can't write.
      const stream = this.isClosed ? null : this.getStream();

      if(!stream?.writable) {

        return;
      }

      // Dequeue and write.
      this.isWriting = true;

      const segment = this.queue.shift();

      if(!stream.write(segment)) {

        // The stream signaled backpressure. Wait for drain before processing the next segment.
        this.drainStream = stream;
        this.drainListener = (): void => {

          this.drainStream = null;
          this.drainListener = null;
          this.isWriting = false;
          this.onWrite?.();
          this.processQueue();
        };

        stream.once("drain", this.drainListener);

        return;
      }

      // Write succeeded immediately. Notify the caller and continue to the next segment.
      this.isWriting = false;
      this.onWrite?.();
    }
  }
}
