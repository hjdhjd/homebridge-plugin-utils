[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / async-queue

# async-queue

A single-consumer FIFO between a producer that pushes whenever it likes and one asynchronous consumer that reads at its own pace.

The shape recurs wherever something arrives on its own schedule and the code that wants it is an `await` away: media segments an assembler completes while the
consumer is still writing the last one to disk, log lines a socket receives in bursts while a terminal renders them one at a time, device transitions a discovery
surface derives while a plugin is busy building the last device. Handing each item straight to the consumer is not possible - it is not there to take it - and
dropping whatever arrives between reads loses exactly the items the consumer asked for. A queue with a parked read is the answer in every case: the producer
pushes and moves on, and the consumer's `for await` wakes when there is something to wake for.

What it deliberately is not: it holds no lifetime of its own. [AsyncQueue.drain](#drain) takes the signal that ends the read, because the lifetime belongs to
whatever owns the producer - a per-call signal one consumer can end alone, a socket's own, a browser's - and a queue that held one would need a second for the
per-call case. It applies no backpressure toward the producer either: [AsyncQueue.push](#push) never blocks and never throws, and a producer that outruns its
consumer is bounded by [AsyncQueueOptions.highWaterMark](#highwatermark) or not at all. A producer that must be slowed down rather than trimmed wants
`BackpressureWriter`, whose whole subject is the writable that cannot keep up.

## Utilities

### AsyncQueue

A single-consumer FIFO whose read is bound to an [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) and whose depth is optionally bounded.

Items are read in the order they were pushed. [AsyncQueue.push](#push) never blocks and never throws. With a [AsyncQueueOptions.highWaterMark](#highwatermark), a push that
meets a full queue drops the oldest item first and counts it in [AsyncQueue.dropped](#dropped), so a consumer that falls behind reads the newest items; without one
the queue grows without limit.

[AsyncQueue.drain](#drain) yields everything queued before it honors the signal - a push that lands while a batch is being read is read after that batch, in order
- parks on an empty queue until a push or the abort, and returns once the queue is empty and the signal has aborted. A pre-aborted signal therefore drains what
is queued and then returns at once, rather than discarding it, which is what makes "nothing already staged is lost on teardown" true for every consumer. A second
drain after one has returned reads whatever was pushed since, under the same rule.

**Single-consumer only.** One read parks at a time, so two concurrent `drain` calls are unsupported: the push that wakes one of them is a wake the other sleeps
through. A consumer that needs fan-out replicates each item into per-consumer queues of its own.

#### Example

```ts
import { AsyncQueue } from "homebridge-plugin-utils";

const lines = new AsyncQueue<string>({ highWaterMark: 10000 });

// The producer pushes whenever the wire says something, and never waits for anyone.
socket.on("line", (line: string) => lines.push(line));

// The consumer reads at its own pace, and the loop ends when the lifetime does - with everything staged before the abort already handed over.
for await (const line of lines.drain(this.signal)) {

  await render(line);
}
```

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | What the producer pushes and the consumer reads back. |

#### Constructors

##### Constructor

```ts
new AsyncQueue<T>(options?): AsyncQueue<T>;
```

Build a queue.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`AsyncQueueOptions`](#asyncqueueoptions) | See [AsyncQueueOptions](#asyncqueueoptions). |

###### Returns

[`AsyncQueue`](#asyncqueue)\<`T`\>

###### Throws

A `TypeError` when `highWaterMark` is present and is not a positive integer.

#### Accessors

##### dropped

###### Get Signature

```ts
get dropped(): number;
```

The number of items the high-water mark has discarded over this queue's life. Zero for a queue without a mark, and zero for one whose consumer has kept up.

###### Returns

`number`

##### size

###### Get Signature

```ts
get size(): number;
```

The number of items buffered and not yet handed to a read.

This reads zero while a batch a drain has already taken is still being yielded: those items belong to the read now, not to the queue.

###### Returns

`number`

#### Methods

##### drain()

```ts
drain(signal): AsyncGenerator<T>;
```

Read the queue until the signal aborts and nothing is left.

Everything queued is yielded before the abort is honored, so a consumer never loses an item that was already staged when the lifetime ended, and a signal that
had already aborted before the call drains what is there and then returns at once.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The lifetime of this read. It ends this generator and nothing else: the queue itself goes on accepting pushes. |

###### Returns

`AsyncGenerator`\<`T`\>

An async generator yielding each item in the order it was pushed.

##### push()

```ts
push(item): void;
```

Add an item to the back of the queue, waking a parked read.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `item` | `T` | What the consumer reads back. |

###### Returns

`void`

***

### AsyncQueueOptions

Construction options for [AsyncQueue](#asyncqueue).

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="highwatermark"></a> `highWaterMark?` | `readonly` | `number` | The largest number of items the queue holds before a push starts dropping. A push that meets a full queue discards the oldest item, counts it in [AsyncQueue.dropped](#dropped), and takes its place, so a consumer that has fallen behind reads the newest items rather than the stalest. Must be a positive integer. Omitted, the queue grows for as long as the producer keeps pushing. |
