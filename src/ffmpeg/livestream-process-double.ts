/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/livestream-process-double.ts: An FFmpeg-free LivestreamProcess test double - a test drives its segments and its lifetime, with no child process behind them.
 */

/**
 * An FFmpeg-free {@link LivestreamProcess} test double.
 *
 * A class that owns a livestream has its hard cases in timing rather than in bytes: an abort that lands while it waits for the initialization segment, a source that
 * ends partway through a read, a dispose that meets a parked read. This module ships the double for those - a {@link TestLivestreamProcess} a test drives one step at
 * a time, resolving the initialization segment, feeding media segments, and closing the source when the row says so, with no child process anywhere in sight - and a
 * {@link TestLivestreamProcessFactory} that builds one per `create` from the init the consumer passed.
 *
 * The double is built on the primitives the real segment path uses rather than on an imitation of them. Its segments are an `AsyncQueue` drained under its lifetime
 * composed with the caller's signal, its stream waits for the initialization segment through `waitWithSignal`, and its initialization wait rejects with the lifetime's
 * reason when the lifetime ends first, exactly as the assembler's does. What it does on abort is therefore what the real process does: segments fed before the
 * lifetime ended are still handed over, and an initialization segment that resolved first stays resolved.
 *
 * The drivers refuse a sequence no real process produces rather than modeling it: feeding a media segment ahead of the initialization segment, resolving the
 * initialization segment twice, or driving a double whose lifetime has ended throws.
 *
 * Signatures come from the process's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
 * compiler saying so.
 *
 * @module
 */
import type { FfmpegLivestreamInit, LivestreamProcess, LivestreamProcessFactory } from "./record.ts";
import { HbpuAbortError, composeSignals, markHandled, onAbort, waitWithSignal } from "../util.ts";
import { AsyncQueue } from "../async-queue.ts";
import type { FfmpegOptions } from "./options.ts";
import type { Mp4Segment } from "./mp4-assembler.ts";

/**
 * A driven, FFmpeg-free {@link LivestreamProcess} double: it produces the initialization segment and the media segments a test hands it, in the order the test hands
 * them, and its lifetime ends the ways a real process's does.
 *
 * The lifetime is the parent signal the constructor receives composed with the double's own, and it ends once, by whichever comes first: the parent aborting,
 * {@link TestLivestreamProcess.abort}, {@link TestLivestreamProcess.end} for the source closing, or `[Symbol.asyncDispose]`.
 *
 * Where it differs from the real process: it spawns nothing, so it has no exit, no stderr, and no startup readiness, and its dispose has no exit to await.
 *
 * @example
 *
 * ```ts
 * import { TestLivestreamProcessFactory, expectAt } from "homebridge-plugin-utils/testing";
 *
 * const factory = new TestLivestreamProcessFactory();
 * const session = new CameraLivestreamSession({ processFactory: factory, signal: controller.signal });
 * const livestream = expectAt(factory.createCalls, 0, "the livestream process the session built").process;
 *
 * // The consumer's own init wait and segment loop, exercised with no FFmpeg at all.
 * livestream.resolveInit(initSegment);
 * livestream.feed(mediaSegment);
 * controller.abort();
 * ```
 *
 * @see TestLivestreamProcessFactory
 *
 * @category Testing
 */
export class TestLivestreamProcess implements LivestreamProcess {

  /**
   * The abort signal representing this double's lifetime, composed from the parent signal the constructor received and this double's own, as the real process
   * composes its parent with its own.
   */
  public readonly signal: AbortSignal;

  readonly #controller = new AbortController();

  #disposeCalls = 0;

  // The one initialization wait, marked handled where it is created as the assembler's is. A caller reaches it only through `getInitSegment`, whose own promise is
  // not marked, so a caller that drops one still meets the unhandled rejection a real process would give it.
  readonly #initSegment: Promise<Buffer>;

  readonly #initResolvers: PromiseWithResolvers<Buffer>;

  #initResolved = false;

  readonly #segmentQueue = new AsyncQueue<Buffer>();

  /**
   * Construct a double.
   *
   * @param init        - Optional init options.
   * @param init.signal - The parent signal the real process would compose into its lifetime: the one a consumer passes in its
   *                      {@link FfmpegLivestreamInit}. Aborting it ends the double with that signal's reason.
   */
  public constructor(init: { signal?: AbortSignal } = {}) {

    this.signal = composeSignals(init.signal, this.#controller.signal);
    this.#initResolvers = Promise.withResolvers();
    this.#initSegment = markHandled(this.#initResolvers.promise);

    // Registered last, so a parent that had already aborted rejects the initialization wait at once, as the assembler's teardown does for a pre-aborted signal. Once
    // the wait has resolved the rejection is inert, which is why an initialization segment that arrived before the lifetime ended stays resolved.
    onAbort(this.signal, () => this.#initResolvers.reject(this.signal.reason));
  }

  /**
   * How many times `[Symbol.asyncDispose]` has been called. Dispose is the one way to end the process that a consumer reaches through {@link LivestreamProcess}, so it
   * is the one act this double records.
   */
  public get disposeCalls(): number {

    return this.#disposeCalls;
  }

  /**
   * Resolve the initialization segment, as the first `moof` arriving does for a real process.
   *
   * @param bytes - The initialization segment bytes.
   *
   * @throws The lifetime's reason once the lifetime has ended, and an `Error` when the initialization segment has already resolved.
   */
  public resolveInit(bytes: Buffer): void {

    this.#refuseWhenEnded();

    if(this.#initResolved) {

      throw new Error("TestLivestreamProcess: the init segment has already resolved, so it cannot resolve again.");
    }

    this.#initResolved = true;
    this.#initResolvers.resolve(bytes);
  }

  /**
   * Produce one media segment, as an `mdat` completing a fragment does for a real process: it is queued for the next read.
   *
   * @param segment - The media segment bytes.
   *
   * @throws The lifetime's reason once the lifetime has ended, and an `Error` when the initialization segment has not resolved, because a real process produces no
   *         media ahead of it.
   */
  public feed(segment: Buffer): void {

    this.#refuseWhenEnded();

    if(!this.#initResolved) {

      throw new Error("TestLivestreamProcess: the init segment has not resolved, so a media segment cannot be fed ahead of it.");
    }

    this.#segmentQueue.push(segment);
  }

  /**
   * Close the source, as a real process's stdout ending does: the lifetime ends with `HbpuAbortError("closed")`, so a pending initialization wait rejects with that
   * reason and a read hands over every segment fed and then returns. A no-op once the lifetime has ended, as the real source end is.
   */
  public end(): void {

    if(this.signal.aborted) {

      return;
    }

    this.#controller.abort(new HbpuAbortError("closed"));
  }

  /**
   * End the lifetime, mirroring {@link ffmpeg/process!FfmpegProcess.abort | FfmpegProcess.abort}: it defaults to `HbpuAbortError("shutdown")` when no reason is
   * supplied, and explicit reasons pass through unchanged. A no-op once the lifetime has ended, so the first reason stands.
   *
   * @param reason - Optional abort reason. See {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    if(this.signal.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * Resolve with the initialization segment {@link TestLivestreamProcess.resolveInit} produced. Rejects with the lifetime's reason when the lifetime ends before the
   * segment resolved, and stays resolved when the lifetime ends after it. Each call returns a promise of its own, as the real method's does.
   *
   * @returns A promise resolving to the initialization segment bytes.
   */
  public async getInitSegment(): Promise<Buffer> {

    return this.#initSegment;
  }

  /**
   * Read each media segment fed, in order. The read is the queue's drain under the lifetime composed with `init.signal`, the composition the real assembler reads
   * under: every segment fed before the lifetime ended is handed over before the read returns, and a read whose queue is empty parks until a segment is fed or a
   * signal aborts.
   *
   * @param init - Optional init options. `signal` composes with this double's own signal; aborting it terminates only this generator call, not the double.
   *
   * @returns An async generator yielding the fed media segments in order.
   */
  public segments(init: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {

    return this.#segmentQueue.drain(composeSignals(this.signal, init.signal));
  }

  /**
   * Read the whole stream as a kind-tagged sequence: one {@link Mp4Segment} of kind `"init"` once the initialization segment resolves, then one of kind `"media"` per
   * segment fed. A lifetime that ended before the initialization segment resolved ends the stream with nothing yielded; one that ended after it hands over the
   * initialization item and every segment fed, then returns.
   *
   * @param init - Optional init options. `signal` composes with this double's own signal; aborting it terminates only this generator call, not the double.
   *
   * @returns An async generator yielding one `"init"` segment followed by `"media"` segments in order.
   */
  public async *stream(init: { signal?: AbortSignal } = {}): AsyncGenerator<Mp4Segment> {

    // The real stream's own composition: the initialization wait raced against the composed signal, where a wait that already settled is delivered even under a signal
    // that has already aborted, then the init item, then the segments read.
    const composed = composeSignals(this.signal, init.signal);

    let initBytes: Buffer;

    try {

      initBytes = await waitWithSignal(this.#initSegment, composed);
    } catch {

      return;
    }

    yield { bytes: initBytes, kind: "init" };

    for await (const segment of this.segments(init)) {

      yield { bytes: segment, kind: "media" };
    }
  }

  /**
   * `AsyncDisposable` implementation: it records the call and ends the lifetime as {@link TestLivestreamProcess.abort} does with no reason, defaulting to
   * `"shutdown"` as the real dispose's abort does. There is no child to wait on, so it resolves once the abort has run. Safe to call more than once, and every call is
   * counted in {@link TestLivestreamProcess.disposeCalls}.
   *
   * @returns A promise that resolves once the abort has run.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.#disposeCalls++;
    this.abort();
  }

  // A driver on a double whose lifetime has ended answers with the reason it ended for, rather than producing segments no real process would produce after its end.
  #refuseWhenEnded(): void {

    if(this.signal.aborted) {

      throw this.signal.reason;
    }
  }
}

/**
 * A {@link LivestreamProcessFactory} double that records every `create` call and answers a fresh {@link TestLivestreamProcess} whose parent signal is the `signal`
 * of the init the consumer passed, so the consumer's own signal ends the process it gets back as it ends a real one. A test reads the recorded process to drive it.
 * There is no form that hands back a process built ahead of the call, because such a process could not hear the signal the consumer passes to `create`.
 *
 * @see LivestreamProcessFactory
 * @see TestLivestreamProcess
 *
 * @category Testing
 */
export class TestLivestreamProcessFactory implements LivestreamProcessFactory {

  /**
   * Every create call's options and init and the process it answered, in order, so a test can assert the boundary was reached with what it expected and can drive the
   * process that came back.
   */
  public readonly createCalls: { init: FfmpegLivestreamInit; options: FfmpegOptions; process: TestLivestreamProcess }[] = [];

  /**
   * Record the create call and answer a fresh double over the init's signal.
   *
   * @param options - The {@link FfmpegOptions} the consumer passed.
   * @param init    - The {@link FfmpegLivestreamInit} the consumer passed.
   *
   * @returns The livestream-process double.
   */
  public create(options: FfmpegOptions, init: FfmpegLivestreamInit): LivestreamProcess {

    const process = new TestLivestreamProcess({ signal: init.signal });

    this.createCalls.push({ init, options, process });

    return process;
  }
}
