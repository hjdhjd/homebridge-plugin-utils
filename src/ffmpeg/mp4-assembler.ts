/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4-assembler.ts: AsyncDisposable fMP4 segment assembler composing Mp4BoxParser against a Readable byte source.
 */

/**
 * AsyncDisposable fMP4 segment assembler.
 *
 * The assembler composes a {@link Mp4BoxParser} against an arbitrary Node {@link Readable} source (typically an FFmpeg process's stdout, but any Readable of well-formed
 * fMP4 bytes works - including in-memory fixtures for tests) and exposes complementary views over the single-pass box pipeline:
 *
 *   - `initSegment: Promise<Buffer>` - resolves once with the concatenated bytes of every box that appeared before the first `moof` (typically ftyp + moov).
 *   - `segments(): AsyncGenerator<Buffer>` - yields each subsequent media segment concatenated into a single Buffer (typically a `moof` / `mdat` pair, though any
 *     additional boxes between them are included verbatim).
 *   - `stream(): AsyncGenerator<Mp4Segment>` - yields the whole sequence tagged by kind: one `"init"` item carrying the initialization bytes, then a `"media"`
 *     item per fragment, so a caller can forward init and media through one loop.
 *
 * One-shot artifacts (the init segment) are promises; continuous streams (media segments) are async generators. Lifetime is governed by
 * a composed {@link AbortSignal}: external abort, parent signal propagation, source error, source end, or an optional inter-segment watchdog timeout all converge on the
 * same signal. The class is single-consumer by design - these views share one internal drain loop, not independent subscriptions, so a caller uses `stream()` OR the
 * `initSegment` / `segments()` pair, never both concurrently.
 *
 * @module
 */
import { BOX_TYPE_MDAT, BOX_TYPE_MOOF, Mp4BoxParser } from "./mp4-parser.ts";
import { HbpuAbortError, Watchdog, composeSignals, isTimeoutReason, markHandled, onAbort, waitWithSignal } from "../util.ts";
import { AsyncQueue } from "../async-queue.ts";
import type { Clock } from "../clock.ts";
import type { Mp4Box } from "./mp4-parser.ts";
import type { Readable } from "node:stream";
import { on } from "node:events";

/**
 * Construction-time options for {@link Mp4SegmentAssembler}.
 *
 * @property clock            - Optional time source for the inter-segment watchdog's window. Passed through to the watchdog unresolved, so the `systemClock`
 *                              default is applied in the one place it belongs. A caller that drives its media pacing on a controllable clock drives the segment
 *                              timeout from the same lever.
 * @property segmentTimeout   - Optional watchdog window, in milliseconds. The timer arms when the initialization segment resolves (we begin expecting media segments)
 *                              and re-arms on each completed media segment. If no segment arrives within the window, the assembler aborts with
 *                              `HbpuAbortError("timeout")` and the generator terminates cleanly. Typical value for HKSV is a little under five seconds.
 * @property signal           - Optional parent {@link AbortSignal} to compose with the assembler's internal controller. When the parent aborts, the assembler tears
 *                              down and the segment generator exits.
 *
 * @category FFmpeg
 */
export interface Mp4SegmentAssemblerInit {

  clock?: Clock;
  segmentTimeout?: number;
  signal?: AbortSignal;
}

/**
 * The kind of a segment yielded by {@link Mp4SegmentAssembler.stream}. `"init"` is the one-shot initialization segment; `"media"` is a continuous media fragment. A
 * consumer that paces or forwards every item uniformly can read {@link Mp4Segment.bytes} without branching; a consumer that must treat the init segment specially
 * branches on this field.
 *
 * @category FFmpeg
 */
export type Mp4SegmentKind = "init" | "media";

/**
 * A single fMP4 segment yielded by {@link Mp4SegmentAssembler.stream}, tagged with its kind so a consumer can tell the one-shot initialization segment apart from the
 * media fragments that follow it without relying on positional ordering.
 *
 * @property bytes  - The complete segment bytes: for `"init"`, the concatenated initialization boxes (typically `ftyp` + `moov`); for `"media"`, the concatenated
 *                    boxes making up the fragment (typically a `moof` + `mdat` pair, though any additional boxes between them are included verbatim).
 * @property kind   - `"init"` for the single leading initialization segment, `"media"` for each subsequent media fragment.
 *
 * @category FFmpeg
 */
export interface Mp4Segment {

  readonly bytes: Buffer;
  readonly kind: Mp4SegmentKind;
}

/**
 * AsyncDisposable fMP4 segment assembler that converts a Readable byte source into an init segment promise and a media-segment async generator.
 *
 * Construction kicks off a background drain loop that feeds {@link Mp4BoxParser} from the source's `data` events and routes each parsed box through a small state
 * machine: everything before the first `moof` accumulates into the initialization segment; from the first `moof` onward, boxes accumulate into the current media
 * segment until an `mdat` flushes the accumulated boxes to the output queue.
 *
 * The single public teardown verb is {@link Mp4SegmentAssembler.abort}, mirroring `AbortController.abort()`. `Symbol.asyncDispose` is implemented in terms of it and
 * awaits the drain loop's completion before returning, so `await using` guarantees the assembler has fully unwound by the time the surrounding scope exits.
 *
 * @example
 *
 * ```ts
 * import { Mp4SegmentAssembler } from "homebridge-plugin-utils";
 *
 * await using assembler = new Mp4SegmentAssembler(ffmpegStdout, { segmentTimeout: 4500, signal: session.signal });
 *
 * const initSegment = await assembler.initSegment;
 *
 * for await (const segment of assembler.segments()) {
 *
 *   // Forward segment bytes to HomeKit.
 * }
 * ```
 *
 * @see Mp4BoxParser
 *
 * @category FFmpeg
 */
export class Mp4SegmentAssembler implements AsyncDisposable {

  /**
   * The composed abort signal representing this assembler's lifetime. Aborts exactly once when the source ends, the source errors, the parent signal fires, the
   * watchdog timeout expires, or {@link Mp4SegmentAssembler.abort} is called; the reason encoded on `signal.reason` names the cause.
   */
  public readonly signal: AbortSignal;

  /**
   * Promise that resolves with the concatenated initialization-segment bytes (typically `ftyp` + `moov`) once the first `moof` box arrives on the source. Rejects with
   * `this.signal.reason` if the assembler is aborted before the initialization segment completes.
   */
  public readonly initSegment: Promise<Buffer>;

  // The private AbortController whose signal is composed into `this.signal`. Owning the controller internally keeps teardown reachable from any handler - the parser,
  // the source error listener, the watchdog - without giving callers a handle to the raw controller.
  readonly #controller: AbortController;

  // The byte source. Held so drain-path listeners (`end`, `error`) can be attached and detached in one place.
  readonly #source: Readable;

  // The box parser driving the drain loop. Stateful: carries residual bytes across chunks.
  readonly #parser: Mp4BoxParser;

  // Inter-segment watchdog composed over this.signal, or `undefined` when no `segmentTimeout` was configured. Armed when the init segment resolves and re-armed on each
  // completed media segment; fires the composed controller with `HbpuAbortError("timeout")` on lapse. Self-cleans when the signal aborts for any other reason.
  readonly #watchdog: Watchdog | undefined;

  // Resolver pair for {@link initSegment}. Resolved when the first `moof` arrives (with the accumulated init parts); rejected from the teardown path if still pending.
  readonly #initResolvers: PromiseWithResolvers<Buffer>;

  // Accumulated box bytes for the initialization segment. Flipped to empty and concatenated once the first `moof` flushes them into `initSegment`.
  #initParts: Buffer[] = [];

  // Set `true` once the initialization segment has resolved. The phase flag for the drain state machine: `false` means "collecting init boxes"; `true` means "collecting
  // media boxes."
  #initResolved = false;

  // Accumulated box bytes for the media segment currently being built. Reset to empty each time an `mdat` flushes the accumulated boxes into the output queue.
  #segmentParts: Buffer[] = [];

  // Completed media segments waiting for `segments()` to hand them over. The queue lets the consumer fall behind momentarily without dropping data, and it is why
  // this class is single-consumer: one read parks on it at a time.
  readonly #segmentQueue = new AsyncQueue<Buffer>();

  // The drain loop's promise. Held so `[Symbol.asyncDispose]` can await actual completion before returning, so callers using `await using` are guaranteed all drain
  // listeners have been detached by the time the block exits.
  #drainTask: Promise<void> | undefined;

  /**
   * Construct and start a new fMP4 segment assembler.
   *
   * The drain loop starts synchronously as part of construction: by the time the constructor returns, the source's `data` events are being observed and the parser is
   * ready to emit boxes. There is no separate `start()` step.
   *
   * @param source - Any {@link Readable} producing fMP4 byte chunks. Typically an FFmpeg process's stdout; any Readable works, which keeps the class testable in
   *                 isolation with in-memory fixture streams.
   * @param init   - Optional init options. See {@link Mp4SegmentAssemblerInit}.
   */
  public constructor(source: Readable, init: Mp4SegmentAssemblerInit = {}) {

    const { clock, segmentTimeout, signal: parentSignal } = init;

    this.#controller = new AbortController();
    this.signal = composeSignals(parentSignal, this.#controller.signal);

    this.#source = source;
    this.#parser = new Mp4BoxParser();

    // Instantiate the inter-segment watchdog only when the caller opted into timeout enforcement. When undefined, no watchdog is constructed and every `arm()` site
    // becomes a cheap `?.` no-op. The watchdog self-cleans when the composed signal aborts, so nothing else in this class needs to know about it.
    this.#watchdog = (segmentTimeout !== undefined) ? new Watchdog({

      clock,
      onFire: (): void => {

        this.#controller.abort(new HbpuAbortError("timeout"));
      },
      signal: this.signal,
      timeoutMs: segmentTimeout
    }) : undefined;

    // Wire up the init resolvers before starting any listeners. Callers reading `initSegment` should see a promise that can be awaited regardless of whether the source
    // has already emitted anything by the time they get the reference. `markHandled` opts the promise out of Node's unhandled-rejection tracker for the case where a
    // consumer uses only `segments()` and never awaits the init segment directly.
    this.#initResolvers = Promise.withResolvers();
    this.initSegment = markHandled(this.#initResolvers.promise);

    // Attach a permanent source `"error"` absorber. Node's EventEmitter crashes the host process when `"error"` is emitted with no listeners, and the
    // `events.on`-driven error handling inside `#drain` only protects while the drain loop is active. A phantom listener that lives for the assembler's lifetime
    // guarantees no stray source error can crash the host - even during the sub-microtask window between drain termination and our teardown, or after teardown if the
    // caller keeps the source alive past the assembler's useful life. During drain, Node dispatches `"error"` to every listener in registration order so `events.on`
    // still rejects the iterator; the absorber just backstops the cases `events.on` does not cover. Released with the assembler instance.
    this.#source.on("error", () => { /* Intentionally empty - see rationale above. */ });

    // Single teardown convergence point. `onAbort` registers the one-shot teardown listener for the normal abort path AND handles the "pre-aborted signal" edge case
    // where `addEventListener("abort", ...)` would otherwise silently skip the handler (the AbortSignal spec does not re-dispatch historical events). Pairing it with
    // the `signal.aborted` short-circuit below means `initSegment` settles consistently regardless of whether the parent signal was live at construction time.
    onAbort(this.signal, () => this.#teardown());

    if(this.signal.aborted) {

      return;
    }

    // Start the drain pipeline. The returned promise is retained so `[Symbol.asyncDispose]` can await the drain's completion before returning. `#drain` is written to
    // always resolve - its body catches and classifies errors inline - so nothing can reject out of it, and no `markHandled` wrapper is needed here.
    this.#drainTask = this.#drain();
  }

  /**
   * Abort the assembler and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after natural completion is also safe
   * for the same reason.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}; platform errors (`TimeoutError`, `AbortError`) also interoperate by convention.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation. Aborts the assembler (defaulting to `"shutdown"`) and awaits actual drain-loop completion before returning, so callers using
   * `await using` are guaranteed every internal listener has been detached by the time the block exits.
   *
   * @returns A promise that resolves once the drain loop has fully exited.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();

    if(this.#drainTask) {

      // Drain failures are already observed internally; swallow here so `await using` does not surface cleanup-side errors the caller cannot react to.
      await this.#drainTask.catch(() => { /* Cleanup swallows outcome. */ });
    }
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * `true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` emitted by the inter-segment watchdog and the platform
   * `TimeoutError` emitted by `AbortSignal.timeout()`. The branching lives in {@link isTimeoutReason} so this getter stays a one-line delegation and every
   * resource class in the library shares one definition of "timeout."
   */
  public get isTimedOut(): boolean {

    return isTimeoutReason(this.signal.reason);
  }

  /**
   * The number of completed media segments buffered between the drain loop and the {@link Mp4SegmentAssembler.segments} consumer - the segments the producer has
   * assembled but the consumer has not yet pulled. A consumer pacing its reads slower than the source produces accrues a reserve here, and that reserve is what
   * absorbs an upstream stall: the consumer keeps pulling buffered segments while no new ones arrive. It is zero in steady state when the consumer keeps pace.
   */
  public get bufferedSegments(): number {

    return this.#segmentQueue.size;
  }

  /**
   * Async generator yielding each completed media segment as a single Buffer, its boxes concatenated in order (typically a `moof` + `mdat` pair, though any
   * additional boxes between them are included verbatim).
   *
   * The first segment it yields follows {@link Mp4SegmentAssembler.initSegment}: nothing is queued before the first `moof`, so the init-first contract holds by
   * construction, and the init segment itself is never surfaced through this stream. Terminates cleanly when the source ends, the assembler aborts, or the optional
   * caller signal aborts; in every case the queue is drained before the generator returns, so a consumer never loses a segment that was already assembled before
   * teardown - a call made after the lifetime has ended reads what was assembled and not yet handed over, then returns at once.
   *
   * **Single-consumer only.** The queue parks one read at a time; calling `segments()` concurrently with another consumer on the same assembler - including the
   * {@link Mp4SegmentAssembler.stream} view, which drives this generator internally - is unsupported and will hang one of the consumers, because the push that wakes
   * one park is a wake the other sleeps through. If fan-out is needed, tee at the consumer side by replicating each yielded Buffer into per-consumer queues external
   * to the assembler.
   *
   * @param init - Optional init options. `signal` composes with the assembler's own signal - aborting it terminates only this generator call, not the assembler.
   *
   * @returns An async generator yielding each media segment's concatenated boxes as a Buffer, in stream order.
   */
  public segments(init: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {

    // The read is the queue's drain under a signal composed from the assembler's own and the caller's: the drain hands over everything assembled before it honors
    // that signal, and the per-call half ends this read alone - the assembler goes on running for whoever else is reading it. No init gate stands here because none
    // is needed: nothing reaches the queue before the first `moof`, so the first segment a read meets already follows the initialization segment.
    return this.#segmentQueue.drain(composeSignals(this.signal, init.signal));
  }

  /**
   * Async generator yielding the whole segment stream as a kind-tagged sequence: exactly one {@link Mp4Segment} of kind `"init"` carrying the initialization bytes,
   * followed by one of kind `"media"` per completed media fragment. This is a third view over the same single-pass pipeline, composed from {@link initSegment} and
   * {@link segments} - it lets a consumer forward the init segment and the media segments through a single loop without tracking which item is which by position.
   *
   * Terminates cleanly on the same conditions as {@link segments}: the source ends, the assembler aborts, or the optional caller signal aborts; queued media drains
   * before the generator returns, so no assembled segment is lost. If the assembler is aborted before the initialization segment arrives, the generator returns without
   * yielding anything. A call that starts after the lifetime has ended, with the initialization segment already resolved, hands over that segment and every media
   * segment assembled and not yet read, then returns - the same reading {@link segments} gives a late call, because the init wait delivers a promise that has already
   * settled even under a signal that has already aborted.
   *
   * **Single-consumer only.** `stream()` drives {@link segments} internally, so it shares the one queue. Use `stream()` OR the {@link initSegment} /
   * {@link segments} pair on a single assembler, never both concurrently - mixing them competes for the same drain and hangs one consumer.
   *
   * @param init - Optional init options. `signal` composes with the assembler's own signal - aborting it terminates only this generator call, not the assembler.
   *
   * @returns An async generator yielding one `"init"` segment followed by `"media"` segments in stream order.
   */
  public async *stream(init: { signal?: AbortSignal } = {}): AsyncGenerator<Mp4Segment> {

    // Wait for the initialization segment first, racing the caller signal exactly as segments() does, so a caller abort during the init wait ends this stream at once
    // rather than hanging until the assembler's own signal settles init. A rejection here (aborted before the first moof) ends the stream with nothing yielded, while
    // an init segment that resolved before the lifetime ended is delivered under the aborted signal, so a late call reads what segments() would.
    const composed = composeSignals(this.signal, init.signal);

    let initBytes: Buffer;

    try {

      initBytes = await waitWithSignal(this.initSegment, composed);
    } catch {

      return;
    }

    // The one init item, then every media segment relabeled. The media loop delegates to segments() so the queue's drain under the per-call signal stays in exactly
    // one place rather than being reimplemented here.
    yield { bytes: initBytes, kind: "init" };

    for await (const segment of this.segments(init)) {

      yield { bytes: segment, kind: "media" };
    }
  }

  // Drain loop. Attaches the source's `end` listener, then iterates `events.on(source, "data", { signal })` until the composed signal aborts. For each chunk, the
  // parser is fed and every complete box is dispatched through `#handleBox`. Every exit path - source end, source error, external abort - converges on the signal
  // being aborted, which every `segments()` read observes through its composed signal, so the queue's drain ends the same way whichever path fired.
  async #drain(): Promise<void> {

    // Source end: the byte producer has nothing more to say. Drive teardown through the signal with reason `"closed"`; the signal's teardown listener rejects any
    // pending init, and the queue's own drain observes the abort. Guard against double-abort when the signal already fired (e.g., external teardown that destroyed the
    // source and produced both `end` and our own abort).
    const onEnd = (): void => {

      if(this.aborted) {

        return;
      }

      this.#controller.abort(new HbpuAbortError("closed"));
    };

    this.#source.once("end", onEnd);

    try {

      // `events.on` yields each emission as an array of event arguments. For Readable's `data` event the array is `[chunk]`; we destructure inside the loop so the
      // typing stays explicit. The `{ signal }` option wires abort-driven termination into the iterator directly - when the signal fires, the iterator rejects its next
      // call with the signal's reason. `events.on` also listens to the source's `"error"` events internally and rejects the iterator with the emitted error; the catch
      // block below classifies both exit paths.
      for await (const eventArgs of on(this.#source, "data", { signal: this.signal })) {

        const [chunk] = eventArgs as [Buffer];

        for(const box of this.#parser.consume(chunk)) {

          this.#handleBox(box);
        }
      }
    } catch(error: unknown) {

      // Single classification point. Every rejection this loop can produce is classified here: our composed signal aborted (already carries a structured
      // `signal.reason`, `this.aborted` is true, pass through unchanged) or the source emitted an `"error"` event (the emitted error is our `cause`, wrap it
      // into the `"failed"` reason so every consumer sees the same taxonomy). Parser failures would also land here if the parser ever threw - `#handleBox` is
      // synchronous and side-effect-only, so it does not.
      if(!this.aborted) {

        this.#controller.abort(new HbpuAbortError("failed", { cause: error }));
      }
    } finally {

      this.#source.off("end", onEnd);
    }
  }

  // Single-box state machine. Before init resolves, boxes accumulate into `#initParts`; the first `moof` flushes them into the init promise, transitions to media
  // collection, and starts the first media segment with itself as the opening box. From there, each box is appended to the current segment; an `mdat` closes the
  // segment and pushes it to the output queue.
  #handleBox(box: Mp4Box): void {

    if(!this.#initResolved) {

      if(box.type === BOX_TYPE_MOOF) {

        // First `moof` - the preceding boxes (typically ftyp + moov) are the complete init segment. Concatenate them once, resolve the promise, and transition into
        // media-collection mode with this `moof` starting the first segment.
        const init = Buffer.concat(this.#initParts);

        this.#initParts = [];
        this.#initResolved = true;
        this.#initResolvers.resolve(init);
        this.#segmentParts.push(box.bytes);
        this.#watchdog?.arm();

        return;
      }

      this.#initParts.push(box.bytes);

      return;
    }

    // Media-collection phase: every box contributes to the current pair, and `mdat` is the flush signal. Non-moof/non-mdat boxes (uncommon in fMP4 fragments, but
    // possible) are appended to the current pair so the downstream consumer sees the stream verbatim.
    this.#segmentParts.push(box.bytes);

    if(box.type === BOX_TYPE_MDAT) {

      const segment = Buffer.concat(this.#segmentParts);

      this.#segmentParts = [];
      this.#segmentQueue.push(segment);
      this.#watchdog?.arm();
    }
  }

  // Single teardown convergence point, fired exactly once when `this.signal` aborts. Rejects a pending init promise; the queue's drain observes the signal itself,
  // so there is nothing here to wake it with. The watchdog self-cleans through its own signal listener, and `exited`-style promises are not in this class's
  // contract - the generator is the exit surface.
  #teardown(): void {

    // Promise resolvers are inert after first settlement, so calling reject on an already-resolved init promise is a safe no-op. This lets us keep the teardown
    // path uniform regardless of whether init arrived before the abort or not.
    this.#initResolvers.reject(this.signal.reason);
  }
}
