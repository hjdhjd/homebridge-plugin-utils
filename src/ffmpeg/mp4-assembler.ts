/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4-assembler.ts: AsyncDisposable fMP4 segment assembler composing Mp4BoxParser against a Readable byte source.
 */

/**
 * AsyncDisposable fMP4 segment assembler.
 *
 * The assembler composes a {@link Mp4BoxParser} against an arbitrary Node {@link Readable} source (typically an FFmpeg process's stdout, but any Readable of well-formed
 * fMP4 bytes works - including in-memory fixtures for tests) and exposes two views over the single-pass box pipeline:
 *
 *   - `initSegment: Promise<Buffer>` - resolves once with the concatenated bytes of every box that appeared before the first `moof` (typically ftyp + moov).
 *   - `segments(): AsyncGenerator<Buffer>` - yields each subsequent `moof` / `mdat` pair concatenated into a single Buffer.
 *
 * One-shot artifacts (the init segment) are promises; continuous streams (media segments) are async generators. Lifetime is governed by
 * a composed {@link AbortSignal}: external abort, parent signal propagation, source error, source end, or an optional inter-segment watchdog timeout all converge on the
 * same signal. The class is single-consumer by design - `initSegment` and `segments()` are two views on one internal drain loop, not independent subscriptions.
 *
 * @module
 */
import { BOX_TYPE_MDAT, BOX_TYPE_MOOF, Mp4BoxParser } from "./mp4-parser.ts";
import { HbpuAbortError, Watchdog, composeSignals, isTimeoutReason, markHandled, onAbort, waitWithSignal } from "../util.ts";
import type { Mp4Box } from "./mp4-parser.ts";
import type { Readable } from "node:stream";
import { on } from "node:events";

/**
 * Construction-time options for {@link Mp4SegmentAssembler}.
 *
 * @property segmentTimeout   - Optional watchdog window, in milliseconds. The timer arms when the initialization segment resolves (we begin expecting media segments)
 *                              and re-arms on each completed media segment. If no segment arrives within the window, the assembler aborts with
 *                              `HbpuAbortError("timeout")` and the generator terminates cleanly. Typical value for HKSV is a little under five seconds.
 * @property signal           - Optional parent {@link AbortSignal} to compose with the assembler's internal controller. When the parent aborts, the assembler tears
 *                              down and the segment generator exits.
 *
 * @category FFmpeg
 */
export interface Mp4SegmentAssemblerInit {

  segmentTimeout?: number;
  signal?: AbortSignal;
}

/**
 * AsyncDisposable fMP4 segment assembler that converts a Readable byte source into an init segment promise and a media-segment async generator.
 *
 * Construction kicks off a background drain loop that feeds {@link Mp4BoxParser} from the source's `data` events and routes each parsed box through a small state
 * machine: everything before the first `moof` accumulates into the initialization segment; from the first `moof` onward, boxes accumulate into the current media
 * segment until an `mdat` flushes the accumulated pair to the output queue.
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

  // Accumulated box bytes for the media segment currently being built. Reset to empty each time an `mdat` flushes the pair into the output queue.
  #segmentParts: Buffer[] = [];

  // Completed media segments waiting to be yielded from `segments()`. A FIFO queue decouples the drain loop (producer) from the generator (consumer), which lets the
  // consumer fall behind momentarily without dropping data.
  #segmentQueue: Buffer[] = [];

  // Parked waiter the generator uses to block until a segment is pushed or the signal aborts. A single-slot optional field is enough because the class is
  // single-consumer by design.
  #segmentWaiter: PromiseWithResolvers<void> | undefined;

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

    const { signal: parentSignal, segmentTimeout } = init;

    this.#controller = new AbortController();
    this.signal = composeSignals(parentSignal, this.#controller.signal);

    this.#source = source;
    this.#parser = new Mp4BoxParser();

    // Instantiate the inter-segment watchdog only when the caller opted into timeout enforcement. When undefined, no watchdog is constructed and every `arm()` site
    // becomes a cheap `?.` no-op. The watchdog self-cleans when the composed signal aborts, so nothing else in this class needs to know about it.
    this.#watchdog = (segmentTimeout !== undefined) ? new Watchdog({

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

    return this.#segmentQueue.length;
  }

  /**
   * Async generator yielding each completed media segment (concatenated `moof` + `mdat` pair) as a single Buffer.
   *
   * Yields only after {@link Mp4SegmentAssembler.initSegment} has resolved - the init segment is not surfaced through this stream. Terminates cleanly when the source
   * ends, the assembler aborts, or the optional caller signal aborts; in every case the queue is drained before the generator returns, so a consumer never loses a
   * segment that was already assembled before teardown.
   *
   * **Single-consumer only.** The internal parked-waiter slot is single-writer; calling `segments()` concurrently with another consumer on the same assembler is
   * unsupported and will hang one of the consumers when the producer's wake-up resolves only the later parker. If fan-out is needed, tee at the consumer side by
   * replicating each yielded Buffer into per-consumer queues external to the assembler.
   *
   * @param init - Optional init options. `signal` composes with the assembler's own signal - aborting it terminates only this generator call, not the assembler.
   *
   * @returns An async generator yielding concatenated `moof` + `mdat` pair buffers in stream order.
   */
  public async *segments(init: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {

    // Compose the per-call signal with the assembler's own signal upfront so every wait in this method honors caller cancellation uniformly. A caller who passes
    // `init.signal` can terminate just this iterator (e.g., to drop a per-session consumer while the assembler keeps running for another session), while the
    // assembler's signal still governs the underlying pipeline.
    const composed = composeSignals(this.signal, init.signal);

    // Gate media-segment delivery on the init-first contract. `waitWithSignal` races the init promise against the composed signal so a caller abort during the init
    // wait terminates the iterator immediately rather than hanging until the assembler's own signal settles init.
    try {

      await waitWithSignal(this.initSegment, composed);
    } catch {

      return;
    }

    for(;;) {

      // Swap-drain the queue: hand ourselves whatever the producer has staged, leave a fresh empty array for the producer to push into, then yield the snapshot. The
      // outer for-loop re-enters on every yielded batch so segments pushed while the consumer awaited a previous yield are picked up on the next pass. Drain
      // unconditionally before checking abort - "no bytes lost" is the rule for segments already assembled before teardown.
      while(this.#segmentQueue.length > 0) {

        const drained = this.#segmentQueue;

        this.#segmentQueue = [];

        for(const segment of drained) {

          yield segment;
        }
      }

      if(composed.aborted) {

        return;
      }

      // Park until either a new segment is pushed (producer resolves the waiter) or the composed signal aborts. A per-iteration resolver is used so the waiter is
      // always fresh; sharing a resolver across iterations would require manual reset logic.
      const waiter: PromiseWithResolvers<void> = Promise.withResolvers();

      this.#segmentWaiter = waiter;

      // `onAbort` handles listener registration, the pre-aborted-signal pitfall, and the one-shot `{ once: true }` semantic through one primitive; the returned
      // `Disposable` is handed to `using` so the listener is deterministically removed on every scope-exit path (segment push via `#handleBox`, caller signal abort,
      // assembler abort, thrown error in the generator). The single unified primitive matches the shape `waitWithSignal` uses for exactly the same kind of parked wait.
      using _abortRegistration = onAbort(composed, () => waiter.resolve());

      try {

        // eslint-disable-next-line no-await-in-loop
        await waiter.promise;
      } finally {

        this.#segmentWaiter = undefined;
      }
    }
  }

  // Drain loop. Attaches the source's `end` listener, then iterates `events.on(source, "data", { signal })` until the composed signal aborts. For each chunk, the
  // parser is fed and every complete box is dispatched through `#handleBox`. Every exit path - source end, source error, external abort - converges on the signal
  // being aborted, which lets the generator's park loop unwind uniformly via `composed.aborted`.
  async #drain(): Promise<void> {

    // Source end: the byte producer has nothing more to say. Drive teardown through the signal with reason `"closed"`; the signal's teardown listener will resolve the
    // generator's parked waiter and reject any pending init. Guard against double-abort when the signal already fired (e.g., external teardown that destroyed the
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

      // Single classification point. Every rejection this loop can produce lands here, classified into one of two reasons today: our composed signal aborted
      // (already carries a structured `signal.reason`, `this.aborted` is true, pass through unchanged) or the source emitted an `"error"` event (the emitted error
      // is our `cause`, wrap into the `"failed"` reason so every consumer sees the same taxonomy). Parser failures would also land here if the parser ever threw,
      // which today it does not - `#handleBox` is synchronous and side-effect-only.
      if(!this.aborted) {

        this.#controller.abort(new HbpuAbortError("failed", { cause: error }));
      }
    } finally {

      this.#source.off("end", onEnd);
    }
  }

  // Single-box state machine. Before init resolves, boxes accumulate into `#initParts`; the first `moof` flushes them into the init promise, transitions to media
  // collection, and starts the first media segment with itself as the opening box. From there, each box is appended to the current segment; an `mdat` closes the pair
  // and pushes it to the output queue.
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
      this.#segmentWaiter?.resolve();
      this.#watchdog?.arm();
    }
  }

  // Single teardown convergence point, fired exactly once when `this.signal` aborts. Rejects a pending init promise and unblocks the generator so the drain-and-return
  // sequence can run. The watchdog self-cleans through its own signal listener, and `exited`-style promises are not in this class's contract - the generator is the
  // exit surface and it wakes up via the resolved waiter.
  #teardown(): void {

    // Promise resolvers are inert after first settlement, so calling reject on an already-resolved init promise is a safe no-op. This lets us keep the teardown
    // path uniform regardless of whether init arrived before the abort or not.
    this.#initResolvers.reject(this.signal.reason);

    this.#segmentWaiter?.resolve();
  }
}
