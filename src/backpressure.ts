/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * backpressure.ts: Signal-driven, backpressure-aware write queue for Node.js writable streams.
 */

/**
 * AsyncDisposable write queue that serializes Buffer writes onto a Node {@link Writable}, respects backpressure via the stream's `drain` event, and composes into the
 * library's `AbortSignal`-driven lifecycle so a parent signal can tear the writer down uniformly with every other HBPU resource class.
 *
 * Primary use case: feeding fMP4 segments from a livestream event source into an FFmpeg process's stdin, where the downstream may not consume as fast as the upstream
 * produces.
 *
 * A paced write serves the same pipe when the moment bytes arrive matters as well as their order. FFmpeg passes each frame on as its bytes arrive, so a fragment
 * written whole leaves FFmpeg as a burst of frames and then a gap. Written as its frames, each when it is due, the fragment leaves at the pace it was recorded. The
 * writer decides when bytes enter the pipe, so the pacing lives here, and it learns nothing about the bytes it paces: it is handed pieces and their durations.
 *
 * @module
 */
import { HbpuAbortError, composeSignals, onAbort } from "./util.ts";
import type { Clock } from "./clock.ts";
import type { Nullable } from "./util.ts";
import { WakeableWait } from "./wakeable-wait.ts";
import type { Writable } from "node:stream";
import { once } from "node:events";
import { systemClock } from "./clock.ts";

/**
 * Rejects synchronously from {@link BackpressureWriter.write} when the pending queue is already at the configured {@link BackpressureWriterInit.highWaterMark}
 * and accepting the new chunk would push it over.
 *
 * Separate from the "writer has aborted" and "underlying stream is dead" failure modes so callers can distinguish backpressure-overflow (back off and retry later)
 * from terminal failures (give up or escalate) by type rather than by inspecting error message text.
 *
 * @category Utilities
 */
export class BackpressureOverflowError extends Error {

  public override readonly name = "BackpressureOverflowError" as const;

  public constructor(message = "BackpressureWriter: queue depth exceeds configured highWaterMark.") {

    super(message);
  }
}

/**
 * Rejected by an individual {@link BackpressureWriter.write} promise when the provider returned a {@link Writable} whose `writable` flag is `false` (the stream has
 * ended or been destroyed). The writer itself remains alive - a later stream replacement via the provider may revive the pipeline - so this is a per-write rejection,
 * not a terminal writer error.
 *
 * @category Utilities
 */
export class BackpressureClosedStreamError extends Error {

  public override readonly name = "BackpressureClosedStreamError" as const;

  public constructor(message = "BackpressureWriter: underlying stream is not writable.") {

    super(message);
  }
}

/**
 * One piece of a {@link BackpressureWriter.writePaced} write: the bytes it writes, and how long after them the next piece of the same write is due.
 *
 * @property bytes    - The bytes this piece writes.
 * @property duration - How long after this piece the next piece is due, in milliseconds. The last piece's duration is unused, because nothing in its write follows it.
 *
 * @category Utilities
 */
export interface PacedChunk {

  readonly bytes: Buffer;
  readonly duration: number;
}

/**
 * Options for one {@link BackpressureWriter.writePaced} write.
 *
 * @property startDelay - Optional time from the call to the moment the write's first piece is due, in milliseconds on the writer's clock. Defaults to `0`, and a
 *                        delay of zero or less holds nothing: the first piece goes out as soon as the write reaches the head of the queue. A positive delay holds
 *                        the first piece for all of it, whatever is queued behind the write. The writer bounds no hold, and the caller's delay does: a hold lasts
 *                        as long as its delay states, and an infinite one lasts until the writer aborts.
 *
 * @category Utilities
 */
export interface PacedWriteOptions {

  readonly startDelay?: number;
}

/**
 * Construction-time options for {@link BackpressureWriter}.
 *
 * @property clock         - Optional time source a paced write measures its start delay on, reads its schedule from and holds on. Defaults to {@link systemClock}; a
 *                           harness injects a `TestClock` and drives the pacing on virtual time. A plain `write()` never reads it.
 * @property highWaterMark - Optional ceiling on the total pending-write depth, including the in-flight entry that is currently awaiting `drain`. When specified, a
 *                           `write()` call that would push the pending queue past this depth rejects synchronously with a {@link BackpressureOverflowError} rather
 *                           than buffering unboundedly. A paced write counts once, however many pieces it holds. Omit for unbounded queueing (the caller trusts
 *                           upstream producers not to outrun the stream by more than available memory).
 * @property signal        - Optional parent {@link AbortSignal} to compose with the writer's internal controller. When the parent aborts, the writer tears down:
 *                           pending writes reject with `signal.reason`, any in-flight drain wait unwinds, and every subsequent `write()` call rejects immediately.
 *
 * @category Utilities
 */
export interface BackpressureWriterInit {

  clock?: Clock;
  highWaterMark?: number;
  signal?: AbortSignal;
}

// Queue entry: a pending write's buffer plus the resolvers for the promise we handed back to the caller. Held together so the drain loop has the resolvers at the same
// shift-point where it consumes the buffer, rather than carrying two parallel queues.
interface PendingWrite {

  chunk: Buffer;
  resolvers: PromiseWithResolvers<void>;
}

// Queue entry for a paced write: its pieces, the monotonic reading its first piece is due at, and the resolvers, settled once for the whole write. The start is
// null for a write that stated no delay, whose first piece is due at once. The entry holds what was asked for and nothing about how far the drain has got through
// it...the next piece and the schedule live in the paced method's locals, so an entry is never left carrying progress from a drain that ended.
interface PendingPacedWrite {

  readonly chunks: readonly PacedChunk[];
  readonly resolvers: PromiseWithResolvers<void>;
  readonly start: Nullable<number>;
}

// How a paced entry's pieces ended, as the paced method reports it to the drain loop: every piece flushed, the writer aborted with the entry already rejected by
// teardown, or the stream found closed after a hold or a drain.
type PacedEnding = "aborted" | "closed" | "flushed";

/**
 * AsyncDisposable backpressure-aware write queue for Node {@link Writable} streams.
 *
 * Each call to {@link BackpressureWriter.write} returns a Promise that resolves once the chunk has been written (and any triggered backpressure has drained) or rejects
 * if the writer aborts mid-write. Concurrent writes serialize through an internal FIFO queue; ordering matches call order. The stream itself is resolved lazily through
 * a caller-supplied provider on each drain turn, so the writer may outlive any particular stream instance - the provider is consulted per chunk, and a `null` return is
 * a signal to drop the chunk (the associated write promise still resolves, treating the drop as a success from the caller's perspective).
 *
 * {@link BackpressureWriter.writePaced} queues a list of pieces as one entry and writes them a duration apart: the first once its start delay has passed, at once
 * when it states none, and each later piece when it is due. It shares the queue, its order, its admission and its teardown with `write`. Its first piece waits
 * for its start whatever is queued behind it, and once the write queued behind it is itself due, the pieces it has left go out at once.
 *
 * @example
 *
 * ```ts
 * import { BackpressureWriter } from "homebridge-plugin-utils";
 *
 * await using writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null, { signal: session.signal });
 *
 * // Each write awaits its own flush; concurrent writes queue behind prior ones.
 * await writer.write(segmentOne);
 * await writer.write(segmentTwo);
 * ```
 *
 * @category Utilities
 */
export class BackpressureWriter implements AsyncDisposable {

  /**
   * The composed abort signal representing this writer's lifetime. Aborts exactly once when {@link BackpressureWriter.abort} is called, when the parent signal fires,
   * or when the underlying stream surfaces an error that invalidates the writer; `signal.reason` names the cause.
   */
  public readonly signal: AbortSignal;

  // The time source a paced write reads its schedule from and holds on. The plain path never reads it.
  readonly #clock: Clock;

  // The private AbortController whose signal is composed into `this.signal`. Owning the controller internally keeps teardown reachable from any handler - drain-wait
  // cancellation, stream-error escalation, explicit abort - without giving callers a handle to the raw controller.
  readonly #controller: AbortController;

  // Optional queue-depth ceiling. When undefined, the queue is unbounded and the only memory discipline is whatever the caller imposes by awaiting prior writes before
  // issuing new ones.
  readonly #highWaterMark: number | undefined;

  // Caller-provided resolver for the target stream. Evaluated lazily on each drain-loop iteration so the writer can survive stream replacement across FFmpeg process
  // restarts, and so callers can bind the writer to a stream that does not yet exist at construction time.
  readonly #streamProvider: () => Nullable<Writable>;

  // FIFO queue of pending writes. Each entry pairs the buffer, or a paced write's pieces, with its resolver so the drain loop can settle the caller's promise at the
  // same point it consumes the entry. The drain loop peeks `queue[0]` during the write (so queue.length reflects total pending, including the in-flight entry) and
  // shifts the entry off only after it has fully flushed or failed.
  readonly #queue: (PendingPacedWrite | PendingWrite)[] = [];

  // The active drain-loop promise, if any. Held so `[Symbol.asyncDispose]` can await actual completion before returning, so `await using` callers are guaranteed no
  // stream interaction is still in flight by the time the surrounding scope exits.
  #drainTask: Promise<void> | undefined;

  // The wait a paced write holds on before a piece, built by the first paced write to reach the drain and kept for the writer's life. A write landing directly
  // behind the head wakes it, so a later piece's hold reads the moment that write falls due and ends there, and a first piece's hold goes round for the time its
  // start has left. Until a paced write runs it stays undefined, so on a writer that never paces the wake `#enqueue` sends is an optional call on nothing.
  #hold: WakeableWait<"queued"> | undefined;

  // True while the drain loop is active (set at entry, cleared in the loop's `finally`). Used by `#enqueue` to decide whether to spawn a new drain - the flag flips
  // back to false the moment the loop exits, whether synchronously (queue emptied in one pass, no backpressure) or asynchronously (after a drain wait or abort) - so
  // a subsequent write that arrives right after an empty-queue exit correctly re-spawns the loop rather than being stranded by a stale drain-task reference.
  #processing = false;

  /**
   * Construct a new backpressure-aware writer.
   *
   * @param streamProvider - A function that returns the current writable stream, or `null` to drop incoming chunks. Evaluated lazily on each drain-loop iteration.
   * @param init           - Optional init options. See {@link BackpressureWriterInit}.
   *
   * @example
   *
   * ```ts
   * await using writer = new BackpressureWriter(() => this.ffmpegProcess?.stdin ?? null, { highWaterMark: 64, signal: session.signal });
   * ```
   */
  public constructor(streamProvider: () => Nullable<Writable>, init: BackpressureWriterInit = {}) {

    this.#clock = init.clock ?? systemClock;
    this.#streamProvider = streamProvider;
    this.#highWaterMark = init.highWaterMark;

    this.#controller = new AbortController();
    this.signal = composeSignals(init.signal, this.#controller.signal);

    // Single teardown convergence point. `onAbort` registers the one-shot teardown handler AND handles the pre-aborted-signal edge case where `addEventListener`
    // would otherwise skip the handler. Rejects every pending entry - including the in-flight entry when the drain loop is parked on
    // `events.once(stream, "drain", { signal })`. The drain loop's catch branch may also reject the in-flight resolver under the same abort; promise resolvers are
    // inert after first settlement, so the second call is a no-op. Rejecting from here unconditionally is required in the stream-error escalation path,
    // where the drain loop shifts the in-flight entry before calling `this.#controller.abort(...)` - by the time the listener runs, only the queued entries remain
    // in the queue, and leaving any of them unrejected would orphan the caller's promise.
    onAbort(this.signal, () => this.#teardown());
  }

  /**
   * Enqueue `chunk` for writing. Concurrent calls serialize in FIFO order via the internal queue.
   *
   * @param chunk - The buffer to write.
   *
   * @returns A promise that resolves when the chunk has been flushed to the underlying stream (including any required drain wait), or, once the drain loop reaches
   *          this entry, immediately if the provider then returns `null` (drop semantics). The promise rejects in the following cases:
   *
   * - `this.signal.reason` - the writer aborted before or during the write.
   * - {@link BackpressureOverflowError} (rejects synchronously) - `highWaterMark` is configured and the queue depth already equals or exceeds it.
   * - {@link BackpressureClosedStreamError} - the provider returned a stream whose `writable` flag is `false`. The writer itself stays alive for a potential later
   *   stream replacement.
   * - The underlying stream's own error, by reference - the stream emitted an error while writing or draining this entry. The writer aborts itself with
   *   `"failed"` afterward, which rejects every other queued entry with that abort reason rather than with the stream's error.
   *
   * @throws {@link BackpressureOverflowError} when `highWaterMark` is exceeded.
   */
  public async write(chunk: Buffer): Promise<void> {

    this.#checkAdmission();

    const resolvers: PromiseWithResolvers<void> = Promise.withResolvers();

    this.#enqueue({ chunk, resolvers });

    return resolvers.promise;
  }

  /**
   * Enqueue `chunks` as one paced write: the first piece is written once its start delay has passed, at once when it states none, and each later piece when it is
   * due, so bytes that carry their own timing reach the stream at that pace rather than as one burst.
   *
   * A start delay is measured from the call on the writer's clock, so time the write spends queued behind others counts toward it, and a delay of zero or less
   * holds nothing. Piece k is due at the moment the first piece was written plus the durations of the pieces before it. The schedule is fixed then, so a slow
   * drain or a late timer never pushes later pieces out: a piece already due when the drain reaches it is written at once, and the pieces after it keep their own
   * times.
   *
   * The first piece waits for its start whatever is queued behind the write, a {@link BackpressureWriter.write} or another paced write, so a write queued behind
   * one that is holding waits its turn. A later piece waits for its own time or until the write behind is due, whichever comes first: a plain write and a paced
   * write stating no delay are due at once, and a paced write stating a delay is due at its start, however many writes are queued behind it. Once the write
   * behind is due, every piece left is written at once, in order, ahead of the newer bytes. That catch-up is what keeps a source whose writes arrive late from
   * falling further behind, and it works only for a caller that issues each paced write without awaiting the one before it: awaiting each one leaves nothing
   * queued behind the write that is holding, so a write that starts late finishes late and the next one starts later still.
   *
   * The writer bounds no hold, and the caller's delays do. A hold lasts as long as its delay states, an infinite one until the writer aborts, and every write
   * queued behind it waits as long. A queue limit therefore needs room for every write the longest hold keeps queued, with the write holding and the next
   * arrival: a `highWaterMark` that leaves less refuses writes with {@link BackpressureOverflowError}, and a write the queue refuses ends no hold.
   *
   * The provider is consulted once for the whole write, when it reaches the head of the queue, and every piece goes to that stream. The writer listens to the stream
   * only while it waits for `drain`, so an error the stream raises while a paced write holds before a piece surfaces as a closed stream: when the next piece is
   * due the stream is not writable, the write rejects with {@link BackpressureClosedStreamError}, its remaining pieces are dropped, and the writer stays alive. A
   * stream that ends while a piece waits for its `drain` keeps the write waiting until the writer aborts, as it keeps a plain write, because a stream that has ended
   * emits no `drain`.
   *
   * @param chunks  - The pieces to write, in order, each carrying how long after it the next piece is due.
   * @param options - Optional options. See {@link PacedWriteOptions}.
   *
   * @returns A promise with {@link BackpressureWriter.write}'s contract, settled once for the whole write: it resolves when every piece has been flushed, at once
   *          for an empty list, which queues nothing, and when the drain reaches the write if the provider then returns `null`, which drops every piece without
   *          holding for the start. It rejects as `write` does, and with {@link BackpressureClosedStreamError} when the stream is not writable before a later
   *          piece, or before the first once it has waited for its start.
   *
   * @throws {@link BackpressureOverflowError} when `highWaterMark` is exceeded. A paced write counts once against it, however many pieces it holds.
   *
   * @example
   *
   * ```ts
   * import { BackpressureWriter } from "homebridge-plugin-utils";
   * import type { PacedChunk } from "homebridge-plugin-utils";
   *
   * const writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null, { signal: session.signal });
   *
   * // Each fragment arrives as its frames, each with its duration. None is awaited before the next is issued, so a fragment still holding its last frames when the
   * // next one arrives writes them at once.
   * camera.on("fragment", (frames: PacedChunk[]) => {
   *
   *   writer.writePaced(frames).catch((error: unknown) => log.debug("A paced write ended early.", { error }));
   * });
   * ```
   */
  public async writePaced(chunks: readonly PacedChunk[], { startDelay = 0 }: PacedWriteOptions = {}): Promise<void> {

    // The refusals come ahead of the empty-list check, so a paced write is refused exactly when a plain one would be.
    this.#checkAdmission();

    // Nothing to write is a write that has already finished. It queues nothing, so it wakes nothing, starts no drain and reads no clock.
    if(chunks.length === 0) {

      return;
    }

    const resolvers: PromiseWithResolvers<void> = Promise.withResolvers();

    // A stated delay becomes the moment the first piece is due, read once from the clock here so the delay counts from the call. A delay of zero or less holds
    // nothing and reads no clock, so it takes the path a write stating no delay takes.
    this.#enqueue({ chunks, resolvers, start: (startDelay > 0) ? (this.#clock.monotonic() + startDelay) : null });

    return resolvers.promise;
  }

  /**
   * Abort the writer and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Every queued write rejects with the signal's reason; any
   * in-flight drain wait rejects with the signal's reason as well, and that rejection propagates out of the in-flight `write()` promise.
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
   * `AsyncDisposable` implementation. Aborts the writer (defaulting to `"shutdown"`) and awaits actual drain-loop completion before returning, so callers using
   * `await using` are guaranteed every pending write has settled by the time the surrounding scope exits.
   *
   * @returns A promise that resolves once the drain loop has fully exited.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();

    if(this.#drainTask) {

      // Drain failures are already observed through the individual write promises; swallow here so `await using` does not surface cleanup-side errors the caller has
      // no way to react to.
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
   * Total number of entries in the pending-write queue, including the in-flight entry (if the drain loop is parked on `events.once(stream, "drain", { signal })`, or
   * on a paced write's hold before a piece, its first among them). A paced write is one entry, however many pieces it holds, from the moment it is queued until its
   * last piece has flushed.
   * Matches the depth that the configured `highWaterMark` is compared against, so adaptive producers watching this value see the same accounting the writer uses
   * internally.
   */
  public get pending(): number {

    return this.#queue.length;
  }

  // The refusals every write method makes before it queues anything, in the one order they are made: an aborted writer, then a full queue. Each throws, so the
  // calling method's promise rejects with it, and the writer is left exactly as it was.
  #checkAdmission(): void {

    // Pre-aborted short-circuit: a write issued after teardown has nothing live to attach to. Rejecting with the signal's reason keeps semantics uniform with the
    // mid-write abort path - callers branch on `signal.reason` / `isHbpuAbortReason` whichever path rejected them.
    if(this.signal.aborted) {

      throw this.signal.reason;
    }

    // Queue-overflow fail-fast. Rejecting synchronously lets upstream producers apply their own pacing rather than silently accumulating unbounded backlog. A
    // dedicated {@link BackpressureOverflowError} class (not an `HbpuAbortError`) is thrown here because the writer itself is still healthy - the caller supplied too
    // much work, not the system asking for teardown - and consumers who care about the distinction can `instanceof`-check rather than match on message text.
    if((this.#highWaterMark !== undefined) && (this.#queue.length >= this.#highWaterMark)) {

      throw new BackpressureOverflowError();
    }
  }

  // Queue an admitted entry, plain or paced, and set the queue moving: wake a paced hold the entry lands behind, and start the drain loop when none is running.
  #enqueue(entry: PendingPacedWrite | PendingWrite): void {

    this.#queue.push(entry);

    // An entry that lands directly behind the head wakes any paced hold in progress, because the write behind the head is the one a later piece's hold ends on:
    // the hold reads when that write falls due, and a first piece's hold goes round for the time its start has left. An entry landing deeper changes nothing a
    // hold waits for, so it wakes nothing.
    if(this.#queue.length === 2) {

      this.#hold?.wake("queued");
    }

    // Spin up the drain loop when nothing is already processing. We key off the `#processing` flag rather than `#drainTask` because an async function's body runs
    // synchronously until its first `await`: a no-backpressure drain completes before the write method returns, leaving `#drainTask` set to a resolved promise
    // that is not yet cleared and would falsely gate subsequent writes. `#processing` is flipped true at the top of `#drain` and false in its `finally`, so checking
    // it gives us a truthful "is a drain currently running?" answer with no chained-promise races.
    if(!this.#processing) {

      this.#drainTask = this.#drain();
    }
  }

  // Drain loop. Iterates the queue, writing each chunk through the provider's current stream, honoring backpressure via `events.once(stream, "drain", { signal })`.
  // Runs until the queue is empty or the signal aborts; every in-flight write is settled before exit (resolved on successful write, rejected via drain-abort on
  // teardown). Note the peek-then-shift pattern: the entry stays at `queue[0]` while the write is in flight, so `queue.length` reflects the true pending count
  // (including the in-flight entry) and the `highWaterMark` check at admission works uniformly whether the drain is idle or mid-wait.
  async #drain(): Promise<void> {

    this.#processing = true;

    try {

      while((this.#queue.length > 0) && !this.signal.aborted) {

        const entry = this.#queue[0];

        // `length`-guarded peek: the loop condition just checked non-empty, so we always have an entry. `noUncheckedIndexedAccess` widens the indexed access to a
        // queue entry or `undefined`; the null check below narrows for the compiler without changing runtime semantics.
        if(!entry) {

          break;
        }

        // Re-evaluate the stream on every iteration. The provider is free to return a different instance across turns (stream replacement across restarts) or `null`
        // (no live stream right now - drop the chunk). Both cases are expected in HBUP's pipeline and are handled here without surfacing as errors to the caller.
        const stream = this.#streamProvider();

        if(!stream) {

          // Drop semantics: the provider explicitly said "no stream." The write promise resolves so the caller can continue without branching on a per-write return;
          // the surrounding session is responsible for deciding whether the lack of a stream is itself a fault.
          this.#queue.shift();
          entry.resolvers.resolve();

          continue;
        }

        if(!stream.writable) {

          // Stream exists but has ended. Reject this specific write with a {@link BackpressureClosedStreamError} and let the caller decide whether to escalate - we
          // do not abort the writer here, because a later stream replacement (via the provider) may revive the pipeline.
          this.#queue.shift();
          entry.resolvers.reject(new BackpressureClosedStreamError());

          continue;
        }

        try {

          /* A paced entry writes its pieces through the paced method, which reports how it ended rather than settling anything itself. An aborted writer has
           * already had its entry rejected and its queue emptied by teardown, so the loop is done. A stream found closed after a hold or a drain is answered exactly as
           * the closed-stream branch above answers one at the head of the queue: this write rejects, its remaining pieces are dropped, and the writer lives on.
           */
          if("chunks" in entry) {

            // eslint-disable-next-line no-await-in-loop
            switch(await this.#writePieces(stream, entry)) {

              case "aborted": {

                return;
              }

              case "closed": {

                this.#queue.shift();
                entry.resolvers.reject(new BackpressureClosedStreamError());

                continue;
              }

              case "flushed": {

                this.#queue.shift();
                entry.resolvers.resolve();

                continue;
              }
            }
          }

          // `stream.write()` returns `false` when the high-water mark has been breached; the write is still queued by Node, but we must wait for `drain` before
          // pushing more bytes or we risk unbounded growth of Node's internal write buffer in process memory. `events.once` with `{ signal }` ties the wait to the
          // writer's lifetime so an abort during drain rejects the wait with the signal's reason rather than hanging.
          if(!stream.write(entry.chunk)) {

            // eslint-disable-next-line no-await-in-loop
            await once(stream, "drain", { signal: this.signal });
          }

          this.#queue.shift();
          entry.resolvers.resolve();
        } catch(error: unknown) {

          // Two rejection shapes land here. (a) Our signal aborted mid-drain: `once` rejects with `signal.reason`; we surface that to the caller and exit the loop
          // because teardown is already in flight. (b) The stream emitted an error via some path `events.once` exposes: the write that triggered the error cannot
          // complete, so we reject this caller and abort the writer with `"failed"` so no subsequent write tries to reuse a broken stream silently.
          this.#queue.shift();

          if(this.aborted) {

            entry.resolvers.reject(this.signal.reason);

            return;
          }

          entry.resolvers.reject(error);
          this.#controller.abort(new HbpuAbortError("failed", { cause: error }));

          return;
        }
      }
    } finally {

      this.#processing = false;
    }
  }

  /* Write one paced entry's pieces to `stream`, each when it is due, and report how the write ended. The first piece of an entry with a start holds for it first.
   * The schedule is read once, from the clock's monotonic reading as the first piece goes out, and piece k is due at that reading plus the durations before it,
   * so a late piece never moves the pieces after it.
   *
   * The method settles nothing and never shifts the entry: it answers "flushed", "aborted" or "closed" and the drain loop settles the entry from that. Before every
   * piece it reads the writer's signal first, because an aborted writer's entry has already been rejected by teardown and no byte may follow that settlement. An
   * abort that lands as the last piece's drain resolves has no piece left to stop, so it reaches the drain loop as "flushed", where settling is inert: teardown has
   * already settled the entry and emptied the queue. Before every piece the method then reads the stream, because a stream that ended or errored while this write
   * held is not writable, and that is the drain loop's closed-stream case rather than a failure of the writer. A wait's rejection on abort and a stream's error
   * during a drain wait propagate to the drain loop's catch, whose arms already answer each of them.
   */
  async #writePieces(stream: Writable, { chunks, start }: PendingPacedWrite): Promise<PacedEnding> {

    const hold = this.#hold ??= new WakeableWait({ clock: this.#clock, signal: this.signal });

    /* Hold the first piece until the entry's start, for as long as the writer is alive, whatever is queued behind this entry: the caller's delay bounds the hold,
     * and the writer does not. An elapsed wait ends the hold, because the clock has said the start passed, and reading the clock again would turn the platform's
     * whole-millisecond truncation of a fractional delay into a second wait. A woken wait goes round for the time the start has left, whether the wake came from a
     * write landing behind this entry or was remembered from an earlier write. An entry with no start never waits here.
     */
    while((start !== null) && !this.aborted) {

      const left = start - this.#clock.monotonic();

      if(left <= 0) {

        break;
      }

      // eslint-disable-next-line no-await-in-loop
      const outcome = await hold.wait(left);

      if(outcome.kind === "elapsed") {

        break;
      }
    }

    let due = this.#clock.monotonic();

    // Whether the entry behind this one has fallen due, kept for the rest of this write because an entry behind, once due, stays due: a moment the hold has waited
    // out is never read again, and every piece left goes out at once.
    let behindDue = false;

    for(const { bytes, duration } of chunks) {

      /* Hold until this piece is due or the entry behind is due, whichever is nearer, for as long as the writer is alive. One reading of the clock measures the
       * piece's time and the entry behind's moment alike, so when they fall together they count as elapsed together. An elapsed wait ends the hold, because the
       * clock has said the moment it waited for passed: this piece goes out, and when that moment was the entry behind's, every piece left goes with it. A woken
       * wait goes round, so the queue decides...a wake remembered from an earlier write finds the queue as it was and the hold carries on for the time it has left.
       * The first piece is due at the reading just taken, so it never waits here.
       */
      while(!this.aborted && !behindDue) {

        const now = this.#clock.monotonic();
        const behind = this.#behindDueAt();
        const left = Math.min(due, behind) - now;

        if(left <= 0) {

          behindDue = behind <= now;

          break;
        }

        // eslint-disable-next-line no-await-in-loop
        const outcome = await hold.wait(left);

        if(outcome.kind === "elapsed") {

          behindDue = behind <= due;

          break;
        }
      }

      if(this.aborted) {

        return "aborted";
      }

      if(!stream.writable) {

        return "closed";
      }

      if(!stream.write(bytes)) {

        // eslint-disable-next-line no-await-in-loop
        await once(stream, "drain", { signal: this.signal });
      }

      due += duration;
    }

    return "flushed";
  }

  /* The monotonic reading at which the entry behind the head falls due, the moment a later piece's hold ends at. Nothing queued behind is never due, answered as
   * `Infinity`. A plain write and a paced write stating no delay are due at once, answered as `-Infinity`. A paced write stating a delay is due at its start
   * however deep the queue behind it is, because it holds its own first piece for its start whatever is queued behind it.
   */
  #behindDueAt(): number {

    const behind = this.#queue.at(1);

    if(!behind) {

      return Infinity;
    }

    if(!("chunks" in behind)) {

      return -Infinity;
    }

    return behind.start ?? -Infinity;
  }

  // Teardown convergence point, fired exactly once when `this.signal` aborts. Rejects every pending entry with the signal's reason, regardless of whether the drain
  // loop is currently processing. Promise resolvers are inert after first settlement, so if the drain loop's catch branch also rejects the in-flight resolver
  // (e.g., when `events.once(..., { signal })` rejects on the same abort), the second call is a no-op. Draining the queue unconditionally here prevents the
  // stream-error escalation path from orphaning queued resolvers - `#drain`'s catch shifts the in-flight entry and then calls `this.#controller.abort(...)`, which
  // fires this listener synchronously while the remaining queued entries are still in the queue.
  #teardown(): void {

    // `signal.reason` is typed `any` in the DOM lib. The `: unknown` annotation narrows it to `unknown` for the `@typescript-eslint/no-unsafe-assignment` rule, which
    // surfaces stray `any` values on assignment. `unknown` flows through `resolvers.reject()` unchanged - reject accepts any value.
    const reason: unknown = this.signal.reason;
    const pending = this.#queue.splice(0);

    for(const entry of pending) {

      entry.resolvers.reject(reason);
    }
  }
}
