[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/recording-process-double

# ffmpeg/recording-process-double

Reusable test doubles for the recording dependency-inversion seam.

The [RecordingProcess](record.md#recordingprocess) / [RecordingProcessFactory](record.md#recordingprocessfactory) seam in `ffmpeg/record.ts` exists so a consuming plugin's HKSV recording path can be driven without
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
[FfmpegProcess.abort](process.md#abort) does), so a consumer's `isHbpuAbortReason` / timeout derivations stay meaningful; `getInitSegment()`
rejects with `signal.reason` after a pre-init abort, mirroring the real assembler's init-reject contract; and `segments()` terminates on EITHER its own signal or the
passed per-call signal, mirroring how
the real assembler composes the two. The `stdin` sink records every written chunk and stays writable across abort, so a consumer driving a `BackpressureWriter` over it
can assert the segment feed regardless of abort ordering.

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
| `init` | [`TestRecordingProcessInit`](#testrecordingprocessinit) | Optional configuration. See [TestRecordingProcessInit](#testrecordingprocessinit). Every field defaults, so a bare `new TestRecordingProcess()` is valid. |

###### Returns

[`TestRecordingProcess`](#testrecordingprocess)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="abortcalls"></a> `abortCalls` | `readonly` | `unknown`[] | `[]` | - |
| <a id="stdin"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | `undefined` | Writable standard input stream the recording bytes are fed into. |
| <a id="stdinwrites"></a> `stdinWrites` | `readonly` | `Buffer`\<`ArrayBufferLike`\>[] | `[]` | - |

#### Accessors

##### bufferedSegments

###### Get Signature

```ts
get bufferedSegments(): number;
```

The configured buffered-segment depth.

###### Returns

`number`

The number of assembled media segments buffered but not yet pulled through [RecordingProcess.segments](record.md#segments-3) - the consumer's catch-up reserve when the source
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

The composed abort signal representing this process's lifetime. Aborts exactly once, when `abort()` is called; `signal.reason` carries the recorded reason.

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

Resolve with the configured init segment. Rejects with `signal.reason` if `abort()` fired before init was requested, mirroring the real
`FfmpegFMp4Process.getInitSegment` -> `Mp4SegmentAssembler.initSegment` reject-on-pre-init-abort contract.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the configured init segment bytes.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`getInitSegment`](record.md#getinitsegment-3)

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Yield the configured media segments in order. Terminates (returns) when EITHER this process's own signal aborts OR the passed `init.signal` aborts - composing both,
mirroring how the real `Mp4SegmentAssembler.segments` honors the process signal and the per-call signal together.

This double does NOT gate media delivery on init-first the way the real assembler does. The real HKSV consumer always awaits `getInitSegment()` before iterating, so
the simplification is invisible to it; a future `segments()`-first consumer must not assume an ordering this double does not enforce.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with this process's own signal; aborting either terminates this generator call. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding the configured media segment buffers in order.

###### Implementation of

[`RecordingProcess`](record.md#recordingprocess).[`segments`](record.md#segments-3)

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
| <a id="createcalls"></a> `createCalls` | `readonly` | \{ `init`: [`FfmpegRecordingInit`](record.md#ffmpegrecordinginit); `options`: [`FfmpegOptions`](options.md#ffmpegoptions); `process`: [`TestRecordingProcess`](#testrecordingprocess); \}[] | `[]` |

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

[`RecordingProcessFactory`](record.md#recordingprocessfactory).[`create`](record.md#create)

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
