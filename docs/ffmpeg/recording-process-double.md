[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/recording-process-double

# ffmpeg/recording-process-double

Reusable test doubles for the recording dependency-inversion boundary.

The [RecordingProcess](record.md#recordingprocess) / [RecordingProcessFactory](record.md#recordingprocessfactory) boundary in `ffmpeg/record.ts` exists so a consuming plugin's HKSV recording path can be driven without
spawning a real FFmpeg child. This module ships the fakes that cash that in: a configurable [TestRecordingProcess](#testrecordingprocess) that yields caller-supplied init and media
segments deterministically, and a [TestRecordingProcessFactory](#testrecordingprocessfactory) that records every `create` call and hands back the process. Any HKSV-capable plugin can hold
the test factory in place of [recordingProcessFactory](record.md#recordingprocessfactory-1) to exercise its recording delegate FFmpeg-free, in CI, with
no binary on the path.

The double needs no real fMP4: a recording consumer forwards `segments()` output opaquely to HomeKit, so the segments are opaque `Buffer`s the test chooses. The
keyframe-bearing fMP4 concern (timeshift / prebuffer) lives entirely in a consumer's own segment double, not here.

## Testing

### TestRecordingProcess

A configurable, FFmpeg-free [RecordingProcess](record.md#recordingprocess) fake. It satisfies the same interface the production
[FfmpegRecordingProcess](record.md#ffmpegrecordingprocess) does, so a recording delegate constructs and drives it exactly as it would the real class - but
it spawns no child and yields caller-supplied bytes deterministically.

Fidelity to the real contract: `abort()` aborts a genuine [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) with a real [HbpuAbortError](../util.md#hbpuaborterror) reason (defaulting to `"shutdown"` exactly as
[FfmpegProcess.abort](process.md#abort) does), so a consumer's `isHbpuAbortReason` / timeout derivations stay meaningful, and `segments()`
composes its own signal with the passed per-call signal as the real assembler composes the two. Where it departs from the real process: `getInitSegment()` rejects
with `signal.reason` after any abort, where the real init wait stays resolved when the init segment arrived before the abort; and `segments()` returns at the first
item after either signal aborts, dropping the configured segments it has not yet yielded, where the real read hands over every segment already assembled before it
returns. The `stdin` sink records every written chunk and stays writable across abort, so a consumer driving a `BackpressureWriter` over it can assert the segment
feed regardless of abort ordering.

#### See

 - RecordingProcess
 - TestRecordingProcessFactory

#### Implements

- [`RecordingProcess`](record.md#recordingprocess)

#### Constructors

##### Constructor

```ts
new TestRecordingProcess(init?): TestRecordingProcess;
```

Construct a configurable recording-process fake.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | [`TestRecordingProcessInit`](#testrecordingprocessinit) | Optional configuration. See [TestRecordingProcessInit](#testrecordingprocessinit). Every field defaults, so a bare `new TestRecordingProcess()` is valid. |

###### Returns

[`TestRecordingProcess`](#testrecordingprocess)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="abortcalls"></a> `abortCalls` | `public readonly` | `unknown`[] | `[]` | - |
| <a id="stdin"></a> `stdin` | `public readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | `undefined` | Writable standard input stream the recording bytes are fed into. |
| <a id="stdinwrites"></a> `stdinWrites` | `public readonly` | `Buffer`\<`ArrayBufferLike`\>[] | `[]` | - |

#### Accessors

##### bufferedSegments

###### Get Signature

```ts
get bufferedSegments(): number;
```

The configured buffered-segment depth.

###### Returns

`number`

The number of assembled media segments buffered but not yet pulled through [RecordingProcess.segments](record.md#segments-4) - the consumer's catch-up reserve when the source
stalls.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`bufferedSegments`](record.md#bufferedsegments-3)

##### isTimedOut

###### Get Signature

```ts
get isTimedOut(): boolean;
```

The configured timed-out flag.

###### Returns

`boolean`

`true` when the abort reason indicates a timeout (the inter-segment watchdog fired or the platform `TimeoutError` was raised).

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`isTimedOut`](record.md#istimedout-3)

##### signal

###### Get Signature

```ts
get signal(): AbortSignal;
```

The abort signal representing this process's lifetime: the double's own controller's signal, with no parent signal composed into it. Aborts exactly once, at the
first `abort()` call; `signal.reason` carries that call's reason.

###### Returns

[`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

The composed abort signal representing the recording process's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`signal`](record.md#signal-5)

##### stderrLog

###### Get Signature

```ts
get stderrLog(): readonly string[];
```

The configured stderr lines.

###### Returns

readonly `string`[]

The accumulated stderr lines the process produced, preserved across teardown for post-mortem inspection. A readonly view: callers read, they do not mutate.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`stderrLog`](record.md#stderrlog-3)

#### Methods

##### abort()

```ts
abort(reason?): void;
```

Abort the recording process. Aborts the internal signal with the supplied reason, defaulting to a real `HbpuAbortError("shutdown")` exactly as the production
`FfmpegProcess.abort` does, and records the (defaulted) reason for assertions. Safe to call more than once: the underlying signal aborts only once.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`abort`](record.md#abort-3)

##### getInitSegment()

```ts
getInitSegment(): Promise<Buffer<ArrayBufferLike>>;
```

Resolve with the configured init segment. Rejects with `signal.reason` if `abort()` fired before init was requested. The real
`FfmpegFMp4Process.getInitSegment` rejects only when the process ends before the init segment arrives and stays resolved when the abort follows it, while this
double rejects after any abort.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the configured init segment bytes.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`getInitSegment`](record.md#getinitsegment-4)

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Yield the configured media segments in order. Composes this process's own signal with the passed `init.signal`, as the real `Mp4SegmentAssembler.segments`
composes the process signal with the per-call signal, and returns at the first item after either has aborted. The real read hands over every segment already
assembled before it returns; this double drops the configured segments it has not yet yielded.

This double does NOT gate media delivery on init-first the way the real assembler does. The real HKSV consumer always awaits `getInitSegment()` before iterating, so
the simplification is invisible to it; a future `segments()`-first consumer must not assume an ordering this double does not enforce.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with this process's own signal; aborting either terminates this generator call. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding the configured media segment buffers in order.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`segments`](record.md#segments-4)

##### stream()

```ts
stream(init?): AsyncGenerator<Mp4Segment>;
```

Yield the whole segment stream as a kind-tagged sequence: one [Mp4Segment](mp4-assembler.md#mp4segment) of kind `"init"` carrying the configured init segment, then one of kind `"media"`
per configured media segment, in order. Terminates on this process's own signal or the passed `init.signal` the same way [TestRecordingProcess.segments](#segments) does,
so an abort before the init item is yielded ends the stream with nothing yielded. The real `Mp4SegmentAssembler.stream` returns empty only when its init segment
never resolved, and hands over one that resolved before the abort; this double's configured init segment is always available, and an abort still yields nothing.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with this process's own signal; aborting either terminates this generator call. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<[`Mp4Segment`](mp4-assembler.md#mp4segment)\>

An async generator yielding one `"init"` segment followed by the configured `"media"` segments in order.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`stream`](record.md#stream-4)

***

### TestRecordingProcessFactory

A [RecordingProcessFactory](record.md#recordingprocessfactory) fake that records every `create` call (the options and init it was passed, for assertions) and returns a
[TestRecordingProcess](#testrecordingprocess), mirroring the create-call-recording discipline a consumer's streaming-delegate factory double uses. By default it returns a fresh,
default-configured process per call; supply a process to the constructor to return a single pre-configured instance from every `create`.

#### See

 - RecordingProcessFactory
 - TestRecordingProcess

#### Implements

- [`RecordingProcessFactory`](record.md#recordingprocessfactory)

#### Constructors

##### Constructor

```ts
new TestRecordingProcessFactory(process?): TestRecordingProcessFactory;
```

Construct a recording-process factory fake.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `process?` | [`TestRecordingProcess`](#testrecordingprocess) | Optional pre-configured [TestRecordingProcess](#testrecordingprocess) to return from every `create`. When omitted, each `create` returns a fresh, default-configured process. |

###### Returns

[`TestRecordingProcessFactory`](#testrecordingprocessfactory)

#### Properties

| Property | Modifier | Type | Default value |
| ------ | ------ | ------ | ------ |
| <a id="createcalls"></a> `createCalls` | `public readonly` | \{ `init`: [`FfmpegRecordingInit`](record.md#ffmpegrecordinginit); `options`: [`FfmpegOptions`](options.md#ffmpegoptions); `process`: [`TestRecordingProcess`](#testrecordingprocess); \}[] | `[]` |

#### Methods

##### create()

```ts
create(options, init): RecordingProcess;
```

Record the create call and return a [TestRecordingProcess](#testrecordingprocess) - the constructor-supplied instance when one was given, otherwise a fresh default-configured one.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | The [FfmpegOptions](options.md#ffmpegoptions) the consumer passed. |
| `init` | [`FfmpegRecordingInit`](record.md#ffmpegrecordinginit) | The [FfmpegRecordingInit](record.md#ffmpegrecordinginit) the consumer passed. |

###### Returns

[`RecordingProcess`](record.md#recordingprocess)

The recording-process double.

###### Implementation of

[`RecordingProcessFactory`](record.md#recordingprocessfactory).[`create`](record.md#create-1)

***

### TestRecordingProcessInit

Construction-time configuration for a [TestRecordingProcess](#testrecordingprocess). Every field has a deterministic default so a bare `new TestRecordingProcess()` is usable; supply
only the fields a given test steers a branch with.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bufferedsegments-1"></a> `bufferedSegments?` | `number` | The value the `bufferedSegments` getter reports. Defaults to `0`. |
| <a id="initsegment"></a> `initSegment?` | `Buffer`\<`ArrayBufferLike`\> | The buffer `getInitSegment()` resolves with. Defaults to an empty buffer. |
| <a id="istimedout-1"></a> `isTimedOut?` | `boolean` | The value the `isTimedOut` getter reports. Defaults to `false`. |
| <a id="segments-1"></a> `segments?` | `Buffer`\<`ArrayBufferLike`\>[] | The media-segment buffers `segments()` yields, in order. Defaults to an empty array. |
| <a id="stderrlog-1"></a> `stderrLog?` | readonly `string`[] | The lines the `stderrLog` getter reports. Defaults to an empty array. |
