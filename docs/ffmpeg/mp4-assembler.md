[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/mp4-assembler

# ffmpeg/mp4-assembler

AsyncDisposable fMP4 segment assembler.

The assembler composes a [Mp4BoxParser](mp4-parser.md#mp4boxparser) against an arbitrary Node [Readable](https://nodejs.org/api/stream.html#class-streamreadable) source (typically an FFmpeg process's stdout, but any Readable of well-formed
fMP4 bytes works - including in-memory fixtures for tests) and exposes complementary views over the single-pass box pipeline:

  - `initSegment: Promise<Buffer>` - resolves once with the concatenated bytes of every box that appeared before the first `moof` (typically ftyp + moov).
  - `segments(): AsyncGenerator<Buffer>` - yields each subsequent `moof` / `mdat` pair concatenated into a single Buffer.
  - `stream(): AsyncGenerator<Mp4Segment>` - yields the whole sequence tagged by kind: one `"init"` item carrying the initialization bytes, then a `"media"`
    item per fragment, so a caller can forward init and media through one loop.

One-shot artifacts (the init segment) are promises; continuous streams (media segments) are async generators. Lifetime is governed by
a composed [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal): external abort, parent signal propagation, source error, source end, or an optional inter-segment watchdog timeout all converge on the
same signal. The class is single-consumer by design - these views share one internal drain loop, not independent subscriptions, so a caller uses `stream()` OR the
`initSegment` / `segments()` pair, never both concurrently.

## FFmpeg

### Mp4SegmentAssembler

AsyncDisposable fMP4 segment assembler that converts a Readable byte source into an init segment promise and a media-segment async generator.

Construction kicks off a background drain loop that feeds [Mp4BoxParser](mp4-parser.md#mp4boxparser) from the source's `data` events and routes each parsed box through a small state
machine: everything before the first `moof` accumulates into the initialization segment; from the first `moof` onward, boxes accumulate into the current media
segment until an `mdat` flushes the accumulated pair to the output queue.

The single public teardown verb is [Mp4SegmentAssembler.abort](#abort), mirroring `AbortController.abort()`. `Symbol.asyncDispose` is implemented in terms of it and
awaits the drain loop's completion before returning, so `await using` guarantees the assembler has fully unwound by the time the surrounding scope exits.

#### Example

```ts
import { Mp4SegmentAssembler } from "homebridge-plugin-utils";

await using assembler = new Mp4SegmentAssembler(ffmpegStdout, { segmentTimeout: 4500, signal: session.signal });

const initSegment = await assembler.initSegment;

for await (const segment of assembler.segments()) {

  // Forward segment bytes to HomeKit.
}
```

#### See

Mp4BoxParser

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new Mp4SegmentAssembler(source, init?): Mp4SegmentAssembler;
```

Construct and start a new fMP4 segment assembler.

The drain loop starts synchronously as part of construction: by the time the constructor returns, the source's `data` events are being observed and the parser is
ready to emit boxes. There is no separate `start()` step.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `source` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Any [Readable](https://nodejs.org/api/stream.html#class-streamreadable) producing fMP4 byte chunks. Typically an FFmpeg process's stdout; any Readable works, which keeps the class testable in isolation with in-memory fixture streams. |
| `init` | [`Mp4SegmentAssemblerInit`](#mp4segmentassemblerinit) | Optional init options. See [Mp4SegmentAssemblerInit](#mp4segmentassemblerinit). |

###### Returns

[`Mp4SegmentAssembler`](#mp4segmentassembler)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="initsegment"></a> `initSegment` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\> | Promise that resolves with the concatenated initialization-segment bytes (typically `ftyp` + `moov`) once the first `moof` box arrives on the source. Rejects with `this.signal.reason` if the assembler is aborted before the initialization segment completes. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this assembler's lifetime. Aborts exactly once when the source ends, the source errors, the parent signal fires, the watchdog timeout expires, or [Mp4SegmentAssembler.abort](#abort) is called; the reason encoded on `signal.reason` names the cause. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

##### bufferedSegments

###### Get Signature

```ts
get bufferedSegments(): number;
```

The number of completed media segments buffered between the drain loop and the [Mp4SegmentAssembler.segments](#segments) consumer - the segments the producer has
assembled but the consumer has not yet pulled. A consumer pacing its reads slower than the source produces accrues a reserve here, and that reserve is what
absorbs an upstream stall: the consumer keeps pulling buffered segments while no new ones arrive. It is zero in steady state when the consumer keeps pace.

###### Returns

`number`

##### isTimedOut

###### Get Signature

```ts
get isTimedOut(): boolean;
```

`true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` emitted by the inter-segment watchdog and the platform
`TimeoutError` emitted by `AbortSignal.timeout()`. The branching lives in [isTimeoutReason](../util.md#istimeoutreason) so this getter stays a one-line delegation and every
resource class in the library shares one definition of "timeout."

###### Returns

`boolean`

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the assembler (defaulting to `"shutdown"`) and awaits actual drain-loop completion before returning, so callers using
`await using` are guaranteed every internal listener has been detached by the time the block exits.

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

Abort the assembler and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after natural completion is also safe
for the same reason.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror); platform errors (`TimeoutError`, `AbortError`) also interoperate by convention. |

###### Returns

`void`

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Async generator yielding each completed media segment (concatenated `moof` + `mdat` pair) as a single Buffer.

Yields only after [Mp4SegmentAssembler.initSegment](#initsegment) has resolved - the init segment is not surfaced through this stream. Terminates cleanly when the source
ends, the assembler aborts, or the optional caller signal aborts; in every case the queue is drained before the generator returns, so a consumer never loses a
segment that was already assembled before teardown.

**Single-consumer only.** The internal parked-waiter slot is single-writer; calling `segments()` concurrently with another consumer on the same assembler - including
the [Mp4SegmentAssembler.stream](#stream) view, which drives this generator internally - is unsupported and will hang one of the consumers when the producer's wake-up
resolves only the later parker. If fan-out is needed, tee at the consumer side by replicating each yielded Buffer into per-consumer queues external to the assembler.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the assembler's own signal - aborting it terminates only this generator call, not the assembler. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding concatenated `moof` + `mdat` pair buffers in stream order.

##### stream()

```ts
stream(init?): AsyncGenerator<Mp4Segment>;
```

Async generator yielding the whole segment stream as a kind-tagged sequence: exactly one [Mp4Segment](#mp4segment) of kind `"init"` carrying the initialization bytes,
followed by one of kind `"media"` per completed media fragment. This is a third view over the same single-pass pipeline, composed from [initSegment](#initsegment) and
[segments](#segments) - it lets a consumer forward the init segment and the media segments through a single loop without tracking which item is which by position.

Terminates cleanly on the same conditions as [segments](#segments): the source ends, the assembler aborts, or the optional caller signal aborts; queued media drains
before the generator returns, so no assembled segment is lost. If the assembler is aborted before the initialization segment arrives, the generator returns without
yielding anything.

**Single-consumer only.** `stream()` drives [segments](#segments) internally, so it shares the one parked-waiter slot. Use `stream()` OR the [initSegment](#initsegment) /
[segments](#segments) pair on a single assembler, never both concurrently - mixing them competes for the same drain and hangs one consumer.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the assembler's own signal - aborting it terminates only this generator call, not the assembler. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<[`Mp4Segment`](#mp4segment)\>

An async generator yielding one `"init"` segment followed by `"media"` segments in stream order.

***

### Mp4Segment

A single fMP4 segment yielded by [Mp4SegmentAssembler.stream](#stream), tagged with its kind so a consumer can tell the one-shot initialization segment apart from the
media fragments that follow it without relying on positional ordering.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bytes"></a> `bytes` | `Buffer` | The complete segment bytes: for `"init"`, the concatenated initialization boxes (typically `ftyp` + `moov`); for `"media"`, a concatenated `moof` + `mdat` pair. |
| <a id="kind"></a> `kind` | [`Mp4SegmentKind`](#mp4segmentkind-1) | `"init"` for the single leading initialization segment, `"media"` for each subsequent media fragment. |

***

### Mp4SegmentAssemblerInit

Construction-time options for [Mp4SegmentAssembler](#mp4segmentassembler).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="segmenttimeout"></a> `segmentTimeout?` | `number` | Optional watchdog window, in milliseconds. The timer arms when the initialization segment resolves (we begin expecting media segments) and re-arms on each completed media segment. If no segment arrives within the window, the assembler aborts with `HbpuAbortError("timeout")` and the generator terminates cleanly. Typical value for HKSV is a little under five seconds. |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the assembler's internal controller. When the parent aborts, the assembler tears down and the segment generator exits. |

***

### Mp4SegmentKind

```ts
type Mp4SegmentKind = "init" | "media";
```

The kind of a segment yielded by [Mp4SegmentAssembler.stream](#stream). `"init"` is the one-shot initialization segment; `"media"` is a continuous media fragment. A
consumer that paces or forwards every item uniformly can read [Mp4Segment.bytes](#bytes) without branching; a consumer that must treat the init segment specially
branches on this field.
