[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / backpressure

# backpressure

AsyncDisposable write queue that serializes Buffer writes onto a Node [Writable](https://nodejs.org/api/stream.html#class-streamwritable), respects backpressure via the stream's `drain` event, and composes into the
library's `AbortSignal`-driven lifecycle so a parent signal can tear the writer down uniformly with every other HBPU resource class.

Primary use case: feeding fMP4 segments from a livestream event source into an FFmpeg process's stdin, where the downstream may not consume as fast as the upstream
produces.

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
| `message` | `string` | `"BackpressureWriter: underlying stream is not writable."` |

###### Returns

[`BackpressureClosedStreamError`](#backpressureclosedstreamerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Overrides |
| ------ | ------ | ------ | ------ |
| <a id="name"></a> `name` | `readonly` | `"BackpressureClosedStreamError"` | `Error.name` |

***

### BackpressureOverflowError

Thrown synchronously by [BackpressureWriter.write](#write) when the pending queue is already at the configured [BackpressureWriterInit.highWaterMark](#highwatermark) and
accepting the new chunk would push it over.

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
| `message` | `string` | `"BackpressureWriter: queue depth exceeds configured highWaterMark."` |

###### Returns

[`BackpressureOverflowError`](#backpressureoverflowerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Overrides |
| ------ | ------ | ------ | ------ |
| <a id="name-1"></a> `name` | `readonly` | `"BackpressureOverflowError"` | `Error.name` |

***

### BackpressureWriter

AsyncDisposable backpressure-aware write queue for Node [Writable](https://nodejs.org/api/stream.html#class-streamwritable) streams.

Each call to [BackpressureWriter.write](#write) returns a Promise that resolves once the chunk has been written (and any triggered backpressure has drained) or rejects
if the writer aborts mid-write. Concurrent writes serialize through an internal FIFO queue; ordering matches call order. The stream itself is resolved lazily through
a caller-supplied provider on each drain turn, so the writer may outlive any particular stream instance - the provider is consulted per chunk, and a `null` return is
a signal to drop the chunk (the associated write promise still resolves, treating the drop as a success from the caller's perspective).

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
| `init` | [`BackpressureWriterInit`](#backpressurewriterinit) | Optional init options. See [BackpressureWriterInit](#backpressurewriterinit). |

###### Returns

[`BackpressureWriter`](#backpressurewriter)

###### Example

```ts
await using writer = new BackpressureWriter(() => this.ffmpegProcess?.stdin ?? null, { highWaterMark: 64, signal: session.signal });
```

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this writer's lifetime. Aborts exactly once when [BackpressureWriter.abort](#abort) is called, when the parent signal fires, or when the underlying stream surfaces an error that invalidates the writer; `signal.reason` names the cause. |

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

Total number of entries in the pending-write queue, including the in-flight entry (if the drain loop is parked on `events.once(stream, "drain", { signal })`).
Matches the depth that the configured `highWaterMark` is compared against, so adaptive producers watching this value see the same accounting the writer uses
internally.

###### Returns

`number`

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the writer (defaulting to `"shutdown"`) and awaits actual drain-loop completion before returning, so callers using
`await using` are guaranteed every pending write has settled by the time the surrounding scope exits.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the drain loop has fully exited.

###### Implementation of

```ts
AsyncDisposable.[asyncDispose]
```

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

A promise that resolves when the chunk has been flushed to the underlying stream (including any required drain wait), or immediately if the provider
         returned `null` at dispatch time (drop semantics). The promise rejects in the following cases:

- `this.signal.reason` - the writer aborted before or during the write.
- [BackpressureOverflowError](#backpressureoverflowerror) (thrown synchronously) - `highWaterMark` is configured and the queue depth already equals or exceeds it.
- [BackpressureClosedStreamError](#backpressureclosedstreamerror) - the provider returned a stream whose `writable` flag is `false`. The writer itself stays alive for a potential later
  stream replacement.

###### Throws

[BackpressureOverflowError](#backpressureoverflowerror) when `highWaterMark` is exceeded.

***

### BackpressureWriterInit

Construction-time options for [BackpressureWriter](#backpressurewriter).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="highwatermark"></a> `highWaterMark?` | `number` | Optional ceiling on the total pending-write depth, including the in-flight entry that is currently awaiting `drain`. When specified, a `write()` call that would push the pending queue past this depth rejects synchronously with a [BackpressureOverflowError](#backpressureoverflowerror) rather than buffering unboundedly. Omit for unbounded queueing (the caller trusts upstream producers not to outrun the stream by more than available memory). |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the writer's internal controller. When the parent aborts, the writer tears down: pending writes reject with `signal.reason`, any in-flight drain wait unwinds, and every subsequent `write()` call rejects immediately. |
