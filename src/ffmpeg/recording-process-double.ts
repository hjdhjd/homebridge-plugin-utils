/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/recording-process-double.ts: A reusable, FFmpeg-free test double for the RecordingProcess dependency-inversion seam.
 */

/**
 * Reusable test doubles for the recording dependency-inversion seam.
 *
 * The {@link RecordingProcess} / {@link RecordingProcessFactory} seam in `ffmpeg/record.ts` exists so a consuming plugin's HKSV recording path can be driven without
 * spawning a real FFmpeg child. This module ships the fakes that cash that in: a configurable {@link TestRecordingProcess} that yields caller-supplied init and media
 * segments deterministically, and a {@link TestRecordingProcessFactory} that records every `create` call and hands back the process. Any HKSV-capable plugin can hold
 * the test factory in place of {@link ffmpeg/record!recordingProcessFactory | recordingProcessFactory} to exercise its recording delegate FFmpeg-free, in CI, with
 * no binary on the path.
 *
 * The double needs no real fMP4: a recording consumer forwards `segments()` output opaquely to HomeKit, so the segments are opaque `Buffer`s the test chooses. The
 * keyframe-bearing fMP4 concern (timeshift / prebuffer) lives entirely in a consumer's own segment double, not here.
 *
 * @module
 */
import type { FfmpegRecordingInit, RecordingProcess, RecordingProcessFactory } from "./record.ts";
import { HbpuAbortError, composeSignals } from "../util.ts";
import type { FfmpegOptions } from "./options.ts";
import type { Mp4Segment } from "./mp4-assembler.ts";
import { Writable } from "node:stream";

/**
 * Construction-time configuration for a {@link TestRecordingProcess}. Every field has a deterministic default so a bare `new TestRecordingProcess()` is usable; supply
 * only the fields a given test steers a branch with.
 *
 * @property bufferedSegments - The value the `bufferedSegments` getter reports. Defaults to `0`.
 * @property initSegment      - The buffer `getInitSegment()` resolves with. Defaults to an empty buffer.
 * @property isTimedOut       - The value the `isTimedOut` getter reports. Defaults to `false`.
 * @property segments         - The media-segment buffers `segments()` yields, in order. Defaults to an empty array.
 * @property stderrLog        - The lines the `stderrLog` getter reports. Defaults to an empty array.
 *
 * @category Testing
 */
export interface TestRecordingProcessInit {

  bufferedSegments?: number;
  initSegment?: Buffer;
  isTimedOut?: boolean;
  segments?: Buffer[];
  stderrLog?: readonly string[];
}

/**
 * A configurable, FFmpeg-free {@link RecordingProcess} fake. It satisfies the same interface the production
 * {@link ffmpeg/record!FfmpegRecordingProcess | FfmpegRecordingProcess} does, so a recording delegate constructs and drives it exactly as it would the real class - but
 * it spawns no child and yields caller-supplied bytes deterministically.
 *
 * Fidelity to the real contract: `abort()` aborts a genuine {@link AbortSignal} with a real {@link HbpuAbortError} reason (defaulting to `"shutdown"` exactly as
 * {@link ffmpeg/process!FfmpegProcess.abort | FfmpegProcess.abort} does), so a consumer's `isHbpuAbortReason` / timeout derivations stay meaningful; `getInitSegment()`
 * rejects with `signal.reason` after a pre-init abort, mirroring the real assembler's init-reject contract; and `segments()` terminates on EITHER its own signal or the
 * passed per-call signal, mirroring how
 * the real assembler composes the two. The `stdin` sink records every written chunk and stays writable across abort, so a consumer driving a `BackpressureWriter` over it
 * can assert the segment feed regardless of abort ordering.
 *
 * @see RecordingProcess
 * @see TestRecordingProcessFactory
 *
 * @category Testing
 */
export class TestRecordingProcess implements RecordingProcess {

  // The reasons every `abort(reason?)` call was invoked with, in order, for assertions. A no-argument call records the defaulted `HbpuAbortError("shutdown")` so the
  // recorded reason matches `signal.reason`.
  public readonly abortCalls: unknown[] = [];

  // Every chunk written to `stdin`, in order, so a consumer feeding the recording-write path can assert exactly what it fed.
  public readonly stdinWrites: Buffer[] = [];

  public readonly stdin: Writable;

  // The internal controller whose signal is exposed as the process lifetime. Owned privately so the only way to abort is through `abort()`, which records the call.
  readonly #controller = new AbortController();

  readonly #bufferedSegments: number;
  readonly #initSegment: Buffer;
  readonly #isTimedOut: boolean;
  readonly #segments: readonly Buffer[];
  readonly #stderrLog: readonly string[];

  /**
   * Construct a configurable recording-process fake.
   *
   * @param init - Optional configuration. See {@link TestRecordingProcessInit}. Every field defaults, so a bare `new TestRecordingProcess()` is valid.
   */
  public constructor(init: TestRecordingProcessInit = {}) {

    this.#bufferedSegments = init.bufferedSegments ?? 0;
    this.#initSegment = init.initSegment ?? Buffer.alloc(0);
    this.#isTimedOut = init.isTimedOut ?? false;
    this.#segments = init.segments ?? [];
    this.#stderrLog = init.stderrLog ?? [];

    // A genuine recording sink that records each chunk and immediately acknowledges the write. It is intentionally independent of the abort path: `abort()` never ends or
    // destroys it, so it stays `writable` and a consumer's writes land regardless of abort ordering. This is a deliberate divergence from the real `FfmpegProcess.stdin`,
    // which Node destroys as soon as the abort signal fires and the kill signal takes effect; the double stays open indefinitely so a recording consumer can flush its
    // in-flight segment feed and assert on it without racing the abort-triggered teardown the real stream would otherwise undergo.
    this.stdin = new Writable({

      write: (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void => {

        this.stdinWrites.push(chunk);
        callback();
      }
    });
  }

  /**
   * Abort the recording process. Aborts the internal signal with the supplied reason, defaulting to a real `HbpuAbortError("shutdown")` exactly as the production
   * `FfmpegProcess.abort` does, and records the (defaulted) reason for assertions. Safe to call more than once: the underlying signal aborts only once.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    const resolvedReason = reason ?? new HbpuAbortError("shutdown");

    this.abortCalls.push(resolvedReason);
    this.#controller.abort(resolvedReason);
  }

  /**
   * The configured buffered-segment depth.
   */
  public get bufferedSegments(): number {

    return this.#bufferedSegments;
  }

  /**
   * Resolve with the configured init segment. Rejects with `signal.reason` if `abort()` fired before init was requested, mirroring the real
   * `FfmpegFMp4Process.getInitSegment` -> `Mp4SegmentAssembler.initSegment` reject-on-pre-init-abort contract.
   *
   * @returns A promise resolving to the configured init segment bytes.
   */
  public async getInitSegment(): Promise<Buffer> {

    if(this.#controller.signal.aborted) {

      throw this.#controller.signal.reason;
    }

    return this.#initSegment;
  }

  /**
   * The configured timed-out flag.
   */
  public get isTimedOut(): boolean {

    return this.#isTimedOut;
  }

  /**
   * Yield the configured media segments in order. Terminates (returns) when EITHER this process's own signal aborts OR the passed `init.signal` aborts - composing both,
   * mirroring how the real `Mp4SegmentAssembler.segments` honors the process signal and the per-call signal together.
   *
   * This double does NOT gate media delivery on init-first the way the real assembler does. The real HKSV consumer always awaits `getInitSegment()` before iterating, so
   * the simplification is invisible to it; a future `segments()`-first consumer must not assume an ordering this double does not enforce.
   *
   * @param init - Optional init options. `signal` composes with this process's own signal; aborting either terminates this generator call.
   *
   * @returns An async generator yielding the configured media segment buffers in order.
   */
  public async *segments(init: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {

    // Compose the per-call signal with our own signal upfront so a single check governs both cancellation sources, mirroring the real assembler. The composed signal is
    // checked before each yield so an abort that fires mid-iteration terminates the generator without yielding the remaining configured segments.
    const composed = composeSignals(this.#controller.signal, init.signal);

    for(const segment of this.#segments) {

      if(composed.aborted) {

        return;
      }

      yield segment;
    }
  }

  /**
   * The composed abort signal representing this process's lifetime. Aborts exactly once, when `abort()` is called; `signal.reason` carries the recorded reason.
   */
  public get signal(): AbortSignal {

    return this.#controller.signal;
  }

  /**
   * The configured stderr lines.
   */
  public get stderrLog(): readonly string[] {

    return this.#stderrLog;
  }

  /**
   * Yield the whole segment stream as a kind-tagged sequence: one {@link Mp4Segment} of kind `"init"` carrying the configured init segment, then one of kind `"media"`
   * per configured media segment, in order. Terminates on this process's own signal or the passed `init.signal` the same way {@link TestRecordingProcess.segments} does;
   * an abort before the init item is yielded ends the stream with nothing yielded, mirroring the real `Mp4SegmentAssembler.stream` return-on-pre-init-abort behavior.
   *
   * @param init - Optional init options. `signal` composes with this process's own signal; aborting either terminates this generator call.
   *
   * @returns An async generator yielding one `"init"` segment followed by the configured `"media"` segments in order.
   */
  public async *stream(init: { signal?: AbortSignal } = {}): AsyncGenerator<Mp4Segment> {

    // Compose the per-call signal with our own so one check governs both cancellation sources, mirroring the real assembler.
    const composed = composeSignals(this.#controller.signal, init.signal);

    // The init item leads, then each configured media segment, all tagged by kind. One abort check per item - before every yield - mirrors segments(): an abort before
    // the init item ends the stream with nothing yielded, matching the real assembler's return-on-pre-init-abort behavior.
    const items: Mp4Segment[] = [ { bytes: this.#initSegment, kind: "init" }, ...this.#segments.map((bytes): Mp4Segment => ({ bytes, kind: "media" })) ];

    for(const item of items) {

      if(composed.aborted) {

        return;
      }

      yield item;
    }
  }
}

/**
 * A {@link RecordingProcessFactory} fake that records every `create` call (the options and init it was passed, for assertions) and returns a
 * {@link TestRecordingProcess}, mirroring the create-call-recording discipline a consumer's streaming-delegate factory double uses. By default it returns a fresh,
 * default-configured process per call; supply a process to the constructor to return a single pre-configured instance from every `create`.
 *
 * @see RecordingProcessFactory
 * @see TestRecordingProcess
 *
 * @category Testing
 */
export class TestRecordingProcessFactory implements RecordingProcessFactory {

  // Every create call's arguments and the process returned, in order, so a test can assert the seam was exercised exactly once with exactly the expected options/init.
  public readonly createCalls: { init: FfmpegRecordingInit; options: FfmpegOptions; process: TestRecordingProcess }[] = [];

  // The pre-configured process to return from every create, when supplied; otherwise each create returns a fresh default-configured process.
  readonly #process: TestRecordingProcess | undefined;

  /**
   * Construct a recording-process factory fake.
   *
   * @param process - Optional pre-configured {@link TestRecordingProcess} to return from every `create`. When omitted, each `create` returns a fresh,
   *                  default-configured process.
   */
  public constructor(process?: TestRecordingProcess) {

    this.#process = process;
  }

  /**
   * Record the create call and return a {@link TestRecordingProcess} - the constructor-supplied instance when one was given, otherwise a fresh default-configured one.
   *
   * @param options - The {@link FfmpegOptions} the consumer passed.
   * @param init    - The {@link FfmpegRecordingInit} the consumer passed.
   *
   * @returns The recording-process double.
   */
  public create(options: FfmpegOptions, init: FfmpegRecordingInit): RecordingProcess {

    const process = this.#process ?? new TestRecordingProcess();

    this.createCalls.push({ init, options, process });

    return process;
  }
}
