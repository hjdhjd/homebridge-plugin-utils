/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * async-queue.ts: One producer's items, one asynchronous consumer, and the signal that ends the read.
 */

/**
 * A single-consumer FIFO between a producer that pushes whenever it likes and one asynchronous consumer that reads at its own pace.
 *
 * The shape recurs wherever something arrives on its own schedule and the code that wants it is an `await` away: media segments an assembler completes while the
 * consumer is still writing the last one to disk, log lines a socket receives in bursts while a terminal renders them one at a time, device transitions a discovery
 * surface derives while a plugin is busy building the last device. Handing each item straight to the consumer is not possible - it is not there to take it - and
 * dropping whatever arrives between reads loses exactly the items the consumer asked for. A queue with a parked read is the answer in every case: the producer
 * pushes and moves on, and the consumer's `for await` wakes when there is something to wake for.
 *
 * What it deliberately is not: it holds no lifetime of its own. {@link AsyncQueue.drain} takes the signal that ends the read, because the lifetime belongs to
 * whatever owns the producer - a per-call signal one consumer can end alone, a socket's own, a browser's - and a queue that held one would need a second for the
 * per-call case. It applies no backpressure toward the producer either: {@link AsyncQueue.push} never blocks and never throws, and a producer that outruns its
 * consumer is bounded by {@link AsyncQueueOptions.highWaterMark} or not at all. A producer that must be slowed down rather than trimmed wants
 * `BackpressureWriter`, whose whole subject is the writable that cannot keep up.
 *
 * @module
 */
import { onAbort } from "./util.ts";

/**
 * Construction options for {@link AsyncQueue}.
 *
 * @category Utilities
 */
export interface AsyncQueueOptions {

  /**
   * The largest number of items the queue holds before a push starts dropping. A push that meets a full queue discards the oldest item, counts it in
   * {@link AsyncQueue.dropped}, and takes its place, so a consumer that has fallen behind reads the newest items rather than the stalest.
   *
   * Must be a positive integer. Omitted, the queue grows for as long as the producer keeps pushing.
   */
  readonly highWaterMark?: number;
}

/**
 * A single-consumer FIFO whose read is bound to an {@link AbortSignal} and whose depth is optionally bounded.
 *
 * Items are read in the order they were pushed. {@link AsyncQueue.push} never blocks and never throws. With a {@link AsyncQueueOptions.highWaterMark}, a push that
 * meets a full queue drops the oldest item first and counts it in {@link AsyncQueue.dropped}, so a consumer that falls behind reads the newest items; without one
 * the queue grows without limit.
 *
 * {@link AsyncQueue.drain} yields everything queued before it honors the signal - a push that lands while a batch is being read is read after that batch, in order
 * - parks on an empty queue until a push or the abort, and returns once the queue is empty and the signal has aborted. A pre-aborted signal therefore drains what
 * is queued and then returns at once, rather than discarding it, which is what makes "nothing already staged is lost on teardown" true for every consumer. A second
 * drain after one has returned reads whatever was pushed since, under the same rule.
 *
 * **Single-consumer only.** One read parks at a time, so two concurrent `drain` calls are unsupported: the push that wakes one of them is a wake the other sleeps
 * through. A consumer that needs fan-out replicates each item into per-consumer queues of its own.
 *
 * @typeParam T - What the producer pushes and the consumer reads back.
 *
 * @example
 *
 * ```ts
 * import { AsyncQueue } from "homebridge-plugin-utils";
 *
 * const lines = new AsyncQueue<string>({ highWaterMark: 10000 });
 *
 * // The producer pushes whenever the wire says something, and never waits for anyone.
 * socket.on("line", (line: string) => lines.push(line));
 *
 * // The consumer reads at its own pace, and the loop ends when the lifetime does - with everything staged before the abort already handed over.
 * for await (const line of lines.drain(this.signal)) {
 *
 *   await render(line);
 * }
 * ```
 *
 * @category Utilities
 */
export class AsyncQueue<T> {

  readonly #highWaterMark: number | undefined;

  #dropped = 0;

  /* The items, and the index of the oldest one still live. Everything before the head is a dropped item whose slot has not been reclaimed yet, which is why the
   * depth is derived from the two rather than kept as a third field that every path would have to remember to move.
   *
   * A drop advances the head rather than shifting the array. At the log socket's default mark of ten thousand, a shift moves ten thousand items one slot each per
   * dropped line; a head advance is one increment, and the reclaim below pays the copy once per mark's worth of drops.
   */
  #items: T[] = [];
  #head = 0;

  /* The bell, not the truth. The array is what a read looks at; this is only how a parked read finds out that looking again is worth it. A push that lands while
   * nothing is parked resolves nothing and needs to resolve nothing - the item is in the array, and the next pass of the drain finds it there - so the producer
   * never has to know whether anyone is listening.
   */
  #waiter: PromiseWithResolvers<void> | undefined;

  /**
   * Build a queue.
   *
   * @param options - See {@link AsyncQueueOptions}.
   *
   * @throws A `TypeError` when `highWaterMark` is present and is not a positive integer.
   */
  public constructor({ highWaterMark }: AsyncQueueOptions = {}) {

    // A mark that is not a positive integer describes no bound at all - a zero or a negative one is a queue that can never hold anything, and a fractional one is a
    // ceiling no integer depth ever reaches exactly. Refusing it here fails where the caller wrote it, rather than as a queue that quietly misbehaves later.
    if((highWaterMark !== undefined) && (!Number.isInteger(highWaterMark) || (highWaterMark < 1))) {

      throw new TypeError("AsyncQueue: `highWaterMark` must be a positive integer.");
    }

    this.#highWaterMark = highWaterMark;
  }

  /**
   * The number of items the high-water mark has discarded over this queue's life. Zero for a queue without a mark, and zero for one whose consumer has kept up.
   */
  public get dropped(): number {

    return this.#dropped;
  }

  /**
   * The number of items buffered and not yet handed to a read.
   *
   * This reads zero while a batch a drain has already taken is still being yielded: those items belong to the read now, not to the queue.
   */
  public get size(): number {

    return this.#items.length - this.#head;
  }

  /**
   * Add an item to the back of the queue, waking a parked read.
   *
   * @param item - What the consumer reads back.
   */
  public push(item: T): void {

    if((this.#highWaterMark !== undefined) && (this.size >= this.#highWaterMark)) {

      this.#head++;
      this.#dropped++;

      /* Reclaim the dead prefix once it has grown to the mark, so the copy costs a mark's worth of items for a mark's worth of drops - a constant per push,
       * amortized - and the array never holds more than twice the mark. Reclaiming on every drop would make the copy the very cost the head index exists to avoid,
       * and never reclaiming would let the array grow for as long as the producer keeps pushing, which is the bound the mark was asked for.
       */
      if(this.#head >= this.#highWaterMark) {

        this.#items = this.#items.slice(this.#head);
        this.#head = 0;
      }
    }

    this.#items.push(item);
    this.#waiter?.resolve();
  }

  /**
   * Read the queue until the signal aborts and nothing is left.
   *
   * Everything queued is yielded before the abort is honored, so a consumer never loses an item that was already staged when the lifetime ended, and a signal that
   * had already aborted before the call drains what is there and then returns at once.
   *
   * @param signal - The lifetime of this read. It ends this generator and nothing else: the queue itself goes on accepting pushes.
   *
   * @returns An async generator yielding each item in the order it was pushed.
   */
  public async *drain(signal: AbortSignal): AsyncGenerator<T> {

    for(;;) {

      while(this.size > 0) {

        /* Take the whole array and leave a fresh one behind, so a push that lands while the batch is being yielded goes to the producer's new array and is found
         * by the next pass rather than being interleaved into this one. The snapshot is trimmed only when the head has moved: a queue that has dropped nothing
         * hands its array over as it stands, which is the common case and costs no copy at all.
         */
        const drained = this.#items;
        const batch = (this.#head === 0) ? drained : drained.slice(this.#head);

        this.#items = [];
        this.#head = 0;

        for(const item of batch) {

          yield item;
        }
      }

      if(signal.aborted) {

        return;
      }

      // A fresh resolver per park, so the bell that was already rung for a previous batch cannot let this park through without a push. `onAbort` covers
      // registration, the already-aborted signal, and the one-shot listener in one primitive, and its disposer is handed to `using` so the listener is removed on
      // every way out of this scope - a push that wakes the park, the abort, a consumer that stops reading, a throw.
      const waiter: PromiseWithResolvers<void> = Promise.withResolvers();

      this.#waiter = waiter;

      using _abortRegistration = onAbort(signal, () => waiter.resolve());

      try {

        // eslint-disable-next-line no-await-in-loop
        await waiter.promise;
      } finally {

        this.#waiter = undefined;
      }
    }
  }
}
