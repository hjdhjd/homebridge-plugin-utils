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
 * @module
 */
import { HbpuAbortError, composeSignals, onAbort } from "./util.ts";
import type { Nullable } from "./util.ts";
import type { Writable } from "node:stream";
import { once } from "node:events";

/**
 * Thrown synchronously by {@link BackpressureWriter.write} when the pending queue is already at the configured {@link BackpressureWriterInit.highWaterMark} and
 * accepting the new chunk would push it over.
 *
 * Separate from the "writer has aborted" and "underlying stream is dead" failure modes so callers can discriminate backpressure-overflow (back off and retry later)
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
 * Construction-time options for {@link BackpressureWriter}.
 *
 * @property highWaterMark - Optional ceiling on the total pending-write depth, including the in-flight entry that is currently awaiting `drain`. When specified, a
 *                           `write()` call that would push the pending queue past this depth rejects synchronously with a {@link BackpressureOverflowError} rather
 *                           than buffering unboundedly. Omit for unbounded queueing (the caller trusts upstream producers not to outrun the stream by more than
 *                           available memory).
 * @property signal        - Optional parent {@link AbortSignal} to compose with the writer's internal controller. When the parent aborts, the writer tears down:
 *                           pending writes reject with `signal.reason`, any in-flight drain wait unwinds, and every subsequent `write()` call rejects immediately.
 *
 * @category Utilities
 */
export interface BackpressureWriterInit {

  highWaterMark?: number;
  signal?: AbortSignal;
}

// Queue entry: a pending write's buffer plus the resolvers for the promise we handed back to the caller. Held together so the drain loop has the resolvers at the same
// shift-point where it consumes the buffer, rather than carrying two parallel queues.
interface PendingWrite {

  chunk: Buffer;
  resolvers: PromiseWithResolvers<void>;
}

/**
 * AsyncDisposable backpressure-aware write queue for Node {@link Writable} streams.
 *
 * Each call to {@link BackpressureWriter.write} returns a Promise that resolves once the chunk has been written (and any triggered backpressure has drained) or rejects
 * if the writer aborts mid-write. Concurrent writes serialize through an internal FIFO queue; ordering matches call order. The stream itself is resolved lazily through
 * a caller-supplied provider on each drain turn, so the writer may outlive any particular stream instance - the provider is consulted per chunk, and a `null` return is
 * a signal to drop the chunk (the associated write promise still resolves, treating the drop as a success from the caller's perspective).
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

  // The private AbortController whose signal is composed into `this.signal`. Owning the controller internally keeps teardown reachable from any handler - drain-wait
  // cancellation, stream-error escalation, explicit abort - without giving callers a handle to the raw controller.
  readonly #controller: AbortController;

  // Optional queue-depth ceiling. When undefined, the queue is unbounded and the only memory discipline is whatever the caller imposes by awaiting prior writes before
  // issuing new ones.
  readonly #highWaterMark: number | undefined;

  // Caller-provided resolver for the target stream. Evaluated lazily on each drain-loop iteration so the writer can survive stream replacement across FFmpeg process
  // restarts, and so callers can bind the writer to a stream that does not yet exist at construction time.
  readonly #streamProvider: () => Nullable<Writable>;

  // FIFO queue of pending writes. Each entry pairs the buffer with its resolver so the drain loop can settle the caller's promise at the same point it consumes the
  // chunk. The drain loop peeks `queue[0]` during the write (so queue.length reflects total pending, including the in-flight entry) and shifts the entry off only
  // after it has fully flushed or failed.
  readonly #queue: PendingWrite[] = [];

  // The active drain-loop promise, if any. Held so `[Symbol.asyncDispose]` can await actual completion before returning, so `await using` callers are guaranteed no
  // stream interaction is still in flight by the time the surrounding scope exits.
  #drainTask: Promise<void> | undefined;

  // True while the drain loop is active (set at entry, cleared in the loop's `finally`). Used by `write()` to decide whether to spawn a new drain - the flag flips
  // back to false the moment the loop exits, whether synchronously (queue emptied in one pass, no backpressure) or asynchronously (after a drain wait or abort) - so
  // a subsequent `write()` that arrives right after an empty-queue exit correctly re-spawns the loop rather than being stranded by a stale drain-task reference.
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

    this.#streamProvider = streamProvider;
    this.#highWaterMark = init.highWaterMark;

    this.#controller = new AbortController();
    this.signal = composeSignals(init.signal, this.#controller.signal);

    // Single teardown convergence point. `onAbort` registers the one-shot teardown handler AND handles the pre-aborted-signal edge case where `addEventListener`
    // would otherwise skip the handler. Rejects every pending entry - including the in-flight entry when the drain loop is parked on
    // `events.once(stream, "drain", { signal })`. The drain loop's catch branch may also reject the in-flight resolver under the same abort; promise resolvers are
    // idempotent after first settlement, so the second call is a no-op. Rejecting from here unconditionally is load-bearing in the stream-error escalation path,
    // where the drain loop shifts the in-flight entry before calling `this.#controller.abort(...)` - by the time the listener runs, only the queued entries remain
    // in the queue, and leaving any of them unrejected would orphan the caller's promise.
    onAbort(this.signal, () => this.#teardown());
  }

  /**
   * Enqueue `chunk` for writing. Concurrent calls serialize in FIFO order via the internal queue.
   *
   * @param chunk - The buffer to write.
   *
   * @returns A promise that resolves when the chunk has been flushed to the underlying stream (including any required drain wait), or immediately if the provider
   *          returned `null` at dispatch time (drop semantics). The promise rejects in the following cases:
   *
   * - `this.signal.reason` - the writer aborted before or during the write.
   * - {@link BackpressureOverflowError} (thrown synchronously) - `highWaterMark` is configured and the queue depth already equals or exceeds it.
   * - {@link BackpressureClosedStreamError} - the provider returned a stream whose `writable` flag is `false`. The writer itself stays alive for a potential later
   *   stream replacement.
   *
   * @throws {@link BackpressureOverflowError} when `highWaterMark` is exceeded.
   */
  public async write(chunk: Buffer): Promise<void> {

    // Pre-aborted short-circuit: a write issued after teardown has nothing live to attach to. Rejecting with the signal's reason keeps semantics uniform with the
    // mid-write abort path - callers discriminate on `signal.reason` / `isHbpuAbortReason` in either case.
    if(this.signal.aborted) {

      throw this.signal.reason;
    }

    // Queue-overflow fail-fast. Rejecting synchronously lets upstream producers apply their own pacing rather than silently accumulating unbounded backlog. A
    // dedicated {@link BackpressureOverflowError} class (not an `HbpuAbortError`) is thrown here because the writer itself is still healthy - the caller supplied too
    // much work, not the system asking for teardown - and consumers who care about the distinction can `instanceof`-check rather than match on message text.
    if((this.#highWaterMark !== undefined) && (this.#queue.length >= this.#highWaterMark)) {

      throw new BackpressureOverflowError();
    }

    const resolvers: PromiseWithResolvers<void> = Promise.withResolvers();

    this.#queue.push({ chunk, resolvers });

    // Spin up the drain loop when nothing is already processing. We key off the `#processing` flag rather than `#drainTask` because an async function's body runs
    // synchronously until its first `await`: a no-backpressure drain completes before `write()` returns, leaving `#drainTask` set to a resolved-but-not-yet-cleared
    // promise that would falsely gate subsequent writes. `#processing` is flipped true at the top of `#drain` and false in its `finally`, so checking it gives us a
    // truthful "is a drain currently running?" answer with no chained-promise races.
    if(!this.#processing) {

      this.#drainTask = this.#drain();
    }

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
   * Total number of entries in the pending-write queue, including the in-flight entry (if the drain loop is parked on `events.once(stream, "drain", { signal })`).
   * Matches the depth that the configured `highWaterMark` is compared against, so adaptive producers watching this value see the same accounting the writer uses
   * internally.
   */
  public get pending(): number {

    return this.#queue.length;
  }

  // Drain loop. Iterates the queue, writing each chunk through the provider's current stream, honoring backpressure via `events.once(stream, "drain", { signal })`.
  // Runs until the queue is empty or the signal aborts; every in-flight write is settled before exit (resolved on successful write, rejected via drain-abort on
  // teardown). Note the peek-then-shift pattern: the entry stays at `queue[0]` while the write is in flight, so `queue.length` reflects the true pending count
  // (including the in-flight entry) and `highWaterMark` checks in `write()` work uniformly whether the drain is idle or mid-wait.
  async #drain(): Promise<void> {

    this.#processing = true;

    try {

      while((this.#queue.length > 0) && !this.signal.aborted) {

        const entry = this.#queue[0];

        // `length`-guarded peek: the loop condition just checked non-empty, so we always have an entry. `noUncheckedIndexedAccess` widens the indexed access to
        // `PendingWrite | undefined`; the null check below narrows for the compiler without changing runtime semantics.
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

          // `stream.write()` returns `false` when the high-water mark has been breached; the write is still queued by Node, but we must wait for `drain` before
          // pushing more bytes or we risk unbounded memory growth at the kernel level. `events.once` with `{ signal }` ties the wait to the writer's lifetime so an
          // abort during drain rejects the wait with the signal's reason rather than hanging.
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

  // Teardown convergence point, fired exactly once when `this.signal` aborts. Rejects every pending entry with the signal's reason, regardless of whether the drain
  // loop is currently processing. Promise resolvers are idempotent after first settlement, so if the drain loop's catch branch also rejects the in-flight resolver
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
