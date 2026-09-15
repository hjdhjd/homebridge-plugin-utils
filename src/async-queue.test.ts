/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * async-queue.test.ts: Unit tests for AsyncQueue - the order items are read in, the parked read and what wakes it, the signal that ends a read, and the
 * high-water mark with its head index and the count it keeps.
 */
import { describe, test } from "node:test";
import { AsyncQueue } from "./async-queue.ts";
import assert from "node:assert/strict";
import { settle } from "./testing/index.ts";

describe("AsyncQueue - order and the parked read", () => {

  test("Q1: items are read in the order they were pushed", async () => {

    const queue = new AsyncQueue<string>();
    const iterator = queue.drain(new AbortController().signal);

    queue.push("a");
    queue.push("b");
    queue.push("c");

    const first = await iterator.next();
    const second = await iterator.next();
    const third = await iterator.next();

    assert.equal(first.value, "a", "the item pushed first is read first");
    assert.equal(second.value, "b", "the item pushed second is read second");
    assert.equal(third.value, "c", "the item pushed third is read third");
  });

  test("Q2: a read parked on an empty queue resumes on the next push", async () => {

    const queue = new AsyncQueue<string>();
    const iterator = queue.drain(new AbortController().signal);

    // The read reaches its park before anything is pushed, so the push is what has to wake it rather than something it finds already waiting.
    const parked = iterator.next();

    await settle();

    queue.push("x");

    const result = await parked;

    assert.equal(result.value, "x", "a push wakes the read that was parked on an empty queue");
  });

  test("Q3: items pushed while a batch is being read are read after it, in order", async () => {

    const queue = new AsyncQueue<string>();
    const iterator = queue.drain(new AbortController().signal);

    queue.push("a");
    queue.push("b");

    const first = await iterator.next();

    // The read holds a batch of two and has yielded one of them. A push landing now belongs behind that batch, not interleaved into it.
    queue.push("c");

    const second = await iterator.next();
    const third = await iterator.next();

    assert.equal(first.value, "a", "the first item of the batch is read first");
    assert.equal(second.value, "b", "the rest of the batch is read before anything pushed since");
    assert.equal(third.value, "c", "the item pushed mid-batch is read after that batch");
  });

  test("Q10: size counts what is buffered and not yet handed to a read", async () => {

    const queue = new AsyncQueue<string>();
    const iterator = queue.drain(new AbortController().signal);

    queue.push("a");
    queue.push("b");
    assert.equal(queue.size, 2, "both pushed items are buffered while nothing is reading");

    await iterator.next();

    // The read took the whole batch, so those two items belong to it rather than to the queue, even though one has not been yielded yet.
    assert.equal(queue.size, 0, "a batch a read has taken is no longer buffered");

    queue.push("c");
    assert.equal(queue.size, 1, "an item pushed after the batch was taken is buffered again");
  });
});

describe("AsyncQueue - the signal that ends a read", () => {

  test("Q4: everything queued before the abort is read before the drain returns", async () => {

    const queue = new AsyncQueue<string>();
    const controller = new AbortController();
    const iterator = queue.drain(controller.signal);

    queue.push("a");
    queue.push("b");
    controller.abort();

    const first = await iterator.next();
    const second = await iterator.next();
    const third = await iterator.next();

    assert.equal(first.value, "a", "an item queued before the abort is still read");
    assert.equal(second.value, "b", "every item queued before the abort is read, in order");
    assert.equal(third.done, true, "the read returns once the queue is empty and the signal has aborted");
  });

  test("Q5: a read parked on an empty queue returns when the signal aborts", async () => {

    const queue = new AsyncQueue<string>();
    const controller = new AbortController();
    const iterator = queue.drain(controller.signal);
    const parked = iterator.next();

    await settle();

    controller.abort();

    const result = await parked;

    assert.equal(result.done, true, "the abort ends a read that was parked on an empty queue");
  });

  test("Q6: a pre-aborted signal drains what is queued and returns at once", async () => {

    const queue = new AsyncQueue<string>();
    const controller = new AbortController();

    queue.push("a");
    controller.abort();

    const iterator = queue.drain(controller.signal);
    const first = await iterator.next();
    const second = await iterator.next();

    assert.equal(first.value, "a", "a signal that had already aborted still hands over what was queued");
    assert.equal(second.done, true, "the read returns as soon as the queue is empty");

    // Nothing queued under the same pre-aborted signal means the first read is the end of the stream.
    const empty = new AsyncQueue<string>();
    const firstOfEmpty = await empty.drain(controller.signal).next();

    assert.equal(firstOfEmpty.done, true, "an empty queue under a pre-aborted signal ends on the first read");
  });

  test("Q8: a second drain after one has returned reads what was pushed since", async () => {

    const queue = new AsyncQueue<string>();
    const controller = new AbortController();

    queue.push("a");
    controller.abort();

    const first: string[] = [];

    for await (const item of queue.drain(controller.signal)) {

      first.push(item);
    }

    assert.deepEqual(first, ["a"], "the first read hands over what was queued and ends");

    queue.push("b");

    const second: string[] = [];

    for await (const item of queue.drain(controller.signal)) {

      second.push(item);
    }

    assert.deepEqual(second, ["b"], "a second read hands over what was pushed since the first ended");
  });
});

describe("AsyncQueue - the high-water mark", () => {

  test("Q7: a queue at its high-water mark drops the oldest item and counts it", async () => {

    const queue = new AsyncQueue<string>({ highWaterMark: 3 });
    const controller = new AbortController();

    for(const item of [ "a", "b", "c", "d", "e", "f" ]) {

      queue.push(item);
    }

    assert.equal(queue.dropped, 3, "the three pushes beyond the mark each drop an item");
    assert.equal(queue.size, 3, "the queue holds exactly the mark");

    controller.abort();

    const survivors: string[] = [];

    for await (const item of queue.drain(controller.signal)) {

      survivors.push(item);
    }

    assert.deepEqual(survivors, [ "d", "e", "f" ], "what survives is the newest items, in the order they were pushed");
  });

  test("Q9: a high-water mark that is not a positive integer is refused at construction", () => {

    const refusal = (error: unknown): boolean => (error instanceof TypeError) && error.message.includes("highWaterMark");

    assert.throws(() => new AsyncQueue<string>({ highWaterMark: 0 }), refusal, "a mark of zero is a queue that could never hold anything");
    assert.throws(() => new AsyncQueue<string>({ highWaterMark: -1 }), refusal, "a negative mark describes no bound at all");
    assert.throws(() => new AsyncQueue<string>({ highWaterMark: 1.5 }), refusal, "a fractional mark is a ceiling no integer depth reaches exactly");
    assert.equal(new AsyncQueue<string>({ highWaterMark: 1 }).size, 0, "the smallest positive integer is a mark the queue accepts");
  });

  test("Q11: a queue without a high-water mark drops nothing", () => {

    const queue = new AsyncQueue<number>();

    for(let item = 0; item < 10000; item++) {

      queue.push(item);
    }

    assert.equal(queue.dropped, 0, "a queue without a mark discards nothing");
    assert.equal(queue.size, 10000, "a queue without a mark holds everything pushed");
  });

  test("Q12: a queue nobody drains holds its newest items at the mark and hands them to a later drain in order", async () => {

    const queue = new AsyncQueue<string>({ highWaterMark: 4 });
    const controller = new AbortController();

    // Fourteen pushes at a mark of four. The dead prefix is reclaimed at the fourth drop and again at the eighth, which leaves the head standing at two when the
    // drain takes its snapshot: the path where the snapshot has to be trimmed rather than handed over as it stands.
    for(let item = 1; item <= 14; item++) {

      queue.push("i" + item.toString());
    }

    assert.equal(queue.dropped, 10, "ten of the fourteen pushes met a full queue");
    assert.equal(queue.size, 4, "the queue holds exactly the mark however many were dropped");

    controller.abort();

    const survivors: string[] = [];

    for await (const item of queue.drain(controller.signal)) {

      survivors.push(item);
    }

    assert.deepEqual(survivors, [ "i11", "i12", "i13", "i14" ], "the four newest items are handed over in the order they were pushed");

    // A second cycle on the same queue. The drain reset the head along with the array, so four more pushes are four more items rather than two.
    for(let item = 15; item <= 18; item++) {

      queue.push("i" + item.toString());
    }

    assert.equal(queue.size, 4, "the queue counts a fresh cycle's pushes from an empty array");
    assert.equal(queue.dropped, 10, "a drain discards nothing, so the count stands where the drops left it");
  });
});
