[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / backpressure

# backpressure

AsyncDisposable write queue that serializes Buffer writes onto a Node [Writable](https://nodejs.org/api/stream.html#class-streamwritable), respects backpressure via the stream's `drain` event, and composes into the
library's `AbortSignal`-driven lifecycle so a parent signal can tear the writer down uniformly with every other HBPU resource class.

Primary use case: feeding fMP4 segments from a livestream event source into an FFmpeg process's stdin, where the downstream may not consume as fast as the upstream
produces.

A paced write serves the same pipe when the moment bytes arrive matters as well as their order. FFmpeg passes each frame on as its bytes arrive, so a fragment
written whole leaves FFmpeg as a burst of frames and then a gap. Written as its frames, each when it is due, the fragment leaves at the pace it was recorded. The
writer decides when bytes enter the pipe, so the pacing lives here, and it learns nothing about the bytes it paces: it is handed pieces and their durations.

## Utilities

### BackpressureClosedStreamError

Rejected by an individual [BackpressureWriter.write](#write) promise when the provider returned a [Writable](https://nodejs.org/api/stream.html#class-streamwritable) whose `writable` flag is `false` (the stream has
ended or been destroyed). The writer itself remains alive - a later stream replacement via the provider may revive the pipeline - so this is a per-write rejection,
not a terminal writer error.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new BackpressureClosedStreamError(message?): BackpressureClosedStreamError;
```

###### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `message?` | `string` | `"BackpressureWriter: underlying stream is not writable."` |

###### Returns

[`BackpressureClosedStreamError`](#backpressureclosedstreamerror)

###### Overrides

`Error.constructor`

#### Properties

| Property | Modifier | Type | Overrides |
| ------ | ------ | ------ | ------ |
| <a id="name"></a> `name` | `public readonly` | `"BackpressureClosedStreamError"` | `Error.name` |

***

### BackpressureOverflowError

Rejects synchronously from [BackpressureWriter.write](#write) when the pending queue is already at the configured [BackpressureWriterInit.highWaterMark](#highwatermark)
and accepting the new chunk would push it over.

Separate from the "writer has aborted" and "underlying stream is dead" failure modes so callers can distinguish backpressure-overflow (back off and retry later)
from terminal failures (give up or escalate) by type rather than by inspecting error message text.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new BackpressureOverflowError(message?): BackpressureOverflowError;
```

###### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `message?` | `string` | `"BackpressureWriter: queue depth exceeds configured highWaterMark."` |

###### Returns

[`BackpressureOverflowError`](#backpressureoverflowerror)

###### Overrides

`Error.constructor`

#### Properties

| Property | Modifier | Type | Overrides |
| ------ | ------ | ------ | ------ |
| <a id="name-1"></a> `name` | `public readonly` | `"BackpressureOverflowError"` | `Error.name` |

***

### BackpressureWriter

AsyncDisposable backpressure-aware write queue for Node [Writable](https://nodejs.org/api/stream.html#class-streamwritable) streams.

Each call to [BackpressureWriter.write](#write) returns a Promise that resolves once the chunk has been written (and any triggered backpressure has drained) or rejects
if the writer aborts mid-write. Concurrent writes serialize through an internal FIFO queue; ordering matches call order. The stream itself is resolved lazily through
a caller-supplied provider on each drain turn, so the writer may outlive any particular stream instance - the provider is consulted per chunk, and a `null` return is
a signal to drop the chunk (the associated write promise still resolves, treating the drop as a success from the caller's perspective).

[BackpressureWriter.writePaced](#writepaced) queues a list of pieces as one entry and writes them a duration apart: the first once its start delay has passed, at once
when it states none, and each later piece when it is due. It shares the queue, its order, its admission and its teardown with `write`. Its first piece waits
for its start whatever is queued behind it, and once the write queued behind it is itself due, the pieces it has left go out at once.

#### Example

```ts
import { BackpressureWriter } from "homebridge-plugin-utils";

await using writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null, { signal: session.signal });

// Each write awaits its own flush; concurrent writes queue behind prior ones.
await writer.write(segmentOne);
await writer.write(segmentTwo);
```

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new BackpressureWriter(streamProvider, init?): BackpressureWriter;
```

Construct a new backpressure-aware writer.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `streamProvider` | () => [`Nullable`](util.md#nullable)\<[`Writable`](https://nodejs.org/api/stream.html#class-streamwritable)\> | A function that returns the current writable stream, or `null` to drop incoming chunks. Evaluated lazily on each drain-loop iteration. |
| `init?` | [`BackpressureWriterInit`](#backpressurewriterinit) | Optional init options. See [BackpressureWriterInit](#backpressurewriterinit). |

###### Returns

[`BackpressureWriter`](#backpressurewriter)

###### Example

```ts
await using writer = new BackpressureWriter(() => this.ffmpegProcess?.stdin ?? null, { highWaterMark: 64, signal: session.signal });
```

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `public readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this writer's lifetime. Aborts exactly once when [BackpressureWriter.abort](#abort) is called, when the parent signal fires, or when the underlying stream surfaces an error that invalidates the writer; `signal.reason` names the cause. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

##### pending

###### Get Signature

```ts
get pending(): number;
```

Total number of entries in the pending-write queue, including the in-flight entry (if the drain loop is parked on `events.once(stream, "drain", { signal })`, or
on a paced write's hold before a piece, its first among them). A paced write is one entry, however many pieces it holds, from the moment it is queued until its
last piece has flushed.
Matches the depth that the configured `highWaterMark` is compared against, so adaptive producers watching this value see the same accounting the writer uses
internally.

###### Returns

`number`

#### Methods

##### \[asyncDispose\]()

```ts
[asyncDispose](): Promise<void>;
```

`AsyncDisposable` implementation. Aborts the writer (defaulting to `"shutdown"`) and awaits actual drain-loop completion before returning, so callers using
`await using` are guaranteed every pending write has settled by the time the surrounding scope exits.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the drain loop has fully exited.

###### Implementation of

`AsyncDisposable.[asyncDispose]`

##### abort()

```ts
abort(reason?): void;
```

Abort the writer and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Every queued write rejects with the signal's reason; any
in-flight drain wait rejects with the signal's reason as well, and that rejection propagates out of the in-flight `write()` promise.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](util.md#hbpuaborterror); platform errors (`TimeoutError`, `AbortError`) also interoperate by convention. |

###### Returns

`void`

##### write()

```ts
write(chunk): Promise<void>;
```

Enqueue `chunk` for writing. Concurrent calls serialize in FIFO order via the internal queue.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `chunk` | `Buffer` | The buffer to write. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves when the chunk has been flushed to the underlying stream (including any required drain wait), or, once the drain loop reaches
         this entry, immediately if the provider then returns `null` (drop semantics). The promise rejects in the following cases:

- `this.signal.reason` - the writer aborted before or during the write.
- [BackpressureOverflowError](#backpressureoverflowerror) (rejects synchronously) - `highWaterMark` is configured and the queue depth already equals or exceeds it.
- [BackpressureClosedStreamError](#backpressureclosedstreamerror) - the provider returned a stream whose `writable` flag is `false`. The writer itself stays alive for a potential later
  stream replacement.
- The underlying stream's own error, by reference - the stream emitted an error while writing or draining this entry. The writer aborts itself with
  `"failed"` afterward, which rejects every other queued entry with that abort reason rather than with the stream's error.

###### Throws

[BackpressureOverflowError](#backpressureoverflowerror) when `highWaterMark` is exceeded.

##### writePaced()

```ts
writePaced(chunks, options?): Promise<void>;
```

Enqueue `chunks` as one paced write: the first piece is written once its start delay has passed, at once when it states none, and each later piece when it is
due, so bytes that carry their own timing reach the stream at that pace rather than as one burst.

A start delay is measured from the call on the writer's clock, so time the write spends queued behind others counts toward it, and a delay of zero or less
holds nothing. Piece k is due at the moment the first piece was written plus the durations of the pieces before it. The schedule is fixed then, so a slow
drain or a late timer never pushes later pieces out: a piece already due when the drain reaches it is written at once, and the pieces after it keep their own
times.

The first piece waits for its start whatever is queued behind the write, a [BackpressureWriter.write](#write) or another paced write, so a write queued behind
one that is holding waits its turn. A later piece waits for its own time or until the write behind is due, whichever comes first: a plain write and a paced
write stating no delay are due at once, and a paced write stating a delay is due at its start, however many writes are queued behind it. Once the write
behind is due, every piece left is written at once, in order, ahead of the newer bytes. That catch-up is what keeps a source whose writes arrive late from
falling further behind, and it works only for a caller that issues each paced write without awaiting the one before it: awaiting each one leaves nothing
queued behind the write that is holding, so a write that starts late finishes late and the next one starts later still.

The writer bounds no hold, and the caller's delays do. A hold lasts as long as its delay states, an infinite one until the writer aborts, and every write
queued behind it waits as long. A queue limit therefore needs room for every write the longest hold keeps queued, with the write holding and the next
arrival: a `highWaterMark` that leaves less refuses writes with [BackpressureOverflowError](#backpressureoverflowerror), and a write the queue refuses ends no hold.

The provider is consulted once for the whole write, when it reaches the head of the queue, and every piece goes to that stream. The writer listens to the stream
only while it waits for `drain`, so an error the stream raises while a paced write holds before a piece surfaces as a closed stream: when the next piece is
due the stream is not writable, the write rejects with [BackpressureClosedStreamError](#backpressureclosedstreamerror), its remaining pieces are dropped, and the writer stays alive. A
stream that ends while a piece waits for its `drain` keeps the write waiting until the writer aborts, as it keeps a plain write, because a stream that has ended
emits no `drain`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `chunks` | readonly [`PacedChunk`](#pacedchunk)[] | The pieces to write, in order, each carrying how long after it the next piece is due. |
| `options?` | [`PacedWriteOptions`](#pacedwriteoptions) | Optional options. See [PacedWriteOptions](#pacedwriteoptions). |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise with [BackpressureWriter.write](#write)'s contract, settled once for the whole write: it resolves when every piece has been flushed, at once
         for an empty list, which queues nothing, and when the drain reaches the write if the provider then returns `null`, which drops every piece without
         holding for the start. It rejects as `write` does, and with [BackpressureClosedStreamError](#backpressureclosedstreamerror) when the stream is not writable before a later
         piece, or before the first once it has waited for its start.

###### Throws

[BackpressureOverflowError](#backpressureoverflowerror) when `highWaterMark` is exceeded. A paced write counts once against it, however many pieces it holds.

###### Example

```ts
import { BackpressureWriter } from "homebridge-plugin-utils";
import type { PacedChunk } from "homebridge-plugin-utils";

const writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null, { signal: session.signal });

// Each fragment arrives as its frames, each with its duration. None is awaited before the next is issued, so a fragment still holding its last frames when the
// next one arrives writes them at once.
camera.on("fragment", (frames: PacedChunk[]) => {

  writer.writePaced(frames).catch((error: unknown) => log.debug("A paced write ended early.", { error }));
});
```

***

### BackpressureWriterInit

Construction-time options for [BackpressureWriter](#backpressurewriter).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="clock"></a> `clock?` | [`Clock`](clock.md#clock) | Optional time source a paced write measures its start delay on, reads its schedule from and holds on. Defaults to [systemClock](clock.md#systemclock); a harness injects a `TestClock` and drives the pacing on virtual time. A plain `write()` never reads it. |
| <a id="highwatermark"></a> `highWaterMark?` | `number` | Optional ceiling on the total pending-write depth, including the in-flight entry that is currently awaiting `drain`. When specified, a `write()` call that would push the pending queue past this depth rejects synchronously with a [BackpressureOverflowError](#backpressureoverflowerror) rather than buffering unboundedly. A paced write counts once, however many pieces it holds. Omit for unbounded queueing (the caller trusts upstream producers not to outrun the stream by more than available memory). |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the writer's internal controller. When the parent aborts, the writer tears down: pending writes reject with `signal.reason`, any in-flight drain wait unwinds, and every subsequent `write()` call rejects immediately. |

***

### PacedChunk

One piece of a [BackpressureWriter.writePaced](#writepaced) write: the bytes it writes, and how long after them the next piece of the same write is due.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="bytes"></a> `bytes` | `readonly` | `Buffer` | The bytes this piece writes. |
| <a id="duration"></a> `duration` | `readonly` | `number` | How long after this piece the next piece is due, in milliseconds. The last piece's duration is unused, because nothing in its write follows it. |

***

### PacedWriteOptions

Options for one [BackpressureWriter.writePaced](#writepaced) write.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="startdelay"></a> `startDelay?` | `readonly` | `number` | Optional time from the call to the moment the write's first piece is due, in milliseconds on the writer's clock. Defaults to `0`, and a delay of zero or less holds nothing: the first piece goes out as soon as the write reaches the head of the queue. A positive delay holds the first piece for all of it, whatever is queued behind the write. The writer bounds no hold, and the caller's delay does: a hold lasts as long as its delay states, and an infinite one lasts until the writer aborts. |
