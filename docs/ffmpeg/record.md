[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/record

# ffmpeg/record

fMP4 FFmpeg processes for HomeKit Secure Video (HKSV) events and livestreaming.

This module defines an abstract base [FfmpegFMp4Process](#abstract-ffmpegfmp4process) and its concrete fMP4-mode specializations,
[FfmpegRecordingProcess](#ffmpegrecordingprocess) for HKSV event recording (stdin pipe input, transcoded output) and
[FfmpegLivestreamProcess](#ffmpeglivestreamprocess) for fMP4 livestreaming (RTSP input, codec copy). The base exists **solely to centralize
composition wiring** - it owns the internal [Mp4SegmentAssembler](mp4-assembler.md#mp4segmentassembler), delegates `getInitSegment` / `segments` to it,
and propagates assembler teardown reasons up to the process. It contains no pipeline logic and no command-line assembly;
the byte-to-segment pipeline lives in the assembler so this base stays composition-only.

Both concrete subclasses:

- Spawn FFmpeg on construction and expose the inherited `signal`, `ready`, `exited`, `stdin`, `stderr`, `stderrLog`,
  `abort()`, and `[Symbol.asyncDispose]`.
- Narrow the inherited public `stdout` to `never`, because the assembler owns the stream and a concurrent external reader
  would race.
- Build their FFmpeg arg vector via the pure helper `buildFMp4CommandLine`, which takes fully-resolved options plus
  mode-specific hook values and returns the vector. Neither subclass calls `super()` until the arg vector is finalized,
  so the constructor-before-super contract is respected.

The command-line hook values that differ per mode:

| Hook                     | Recording                                  | Livestream                              |
|--------------------------|--------------------------------------------|-----------------------------------------|
| `inputArgs`              | `-i pipe:0` + probesize + `-ss`            | `-i <url>` + `-rtsp_transport tcp`      |
| `separateAudioInputArgs` | `[]`                                       | Separate audio URL when configured      |
| `audioInputIndex`        | `0`                                        | `0` or `1` (if separate audio)          |
| `audioTarget`            | `recordingConfig.audioCodec` (transcoding) | `init.audio` when provided              |
| `videoEncoderArgs`       | `options.recordEncoder(...)`               | `-codec:v copy`                         |
| `postFilterArgs`         | `[]`                                       | `-frag_duration <segmentLength * 1000>` |
| `metadataLabel`          | `"HKSV Event"`                             | `"Livestream Buffer"`                   |

The shared pipeline primitive ([Mp4SegmentAssembler](mp4-assembler.md#mp4segmentassembler)) also means this module avoids template-method coupling between
the base and the concrete subclasses: no abstract hook methods, no mode-specific state on the base. The base is pure lifecycle
composition; the subclasses are pure args builders plus (for recording) a known-error message substitution.

## FFmpeg

### `abstract` FfmpegFMp4Process

Abstract base for FFmpeg processes that produce fragmented MP4 segments on their stdout. Owns the composition wiring between the process's stdout and an internal
[Mp4SegmentAssembler](mp4-assembler.md#mp4segmentassembler), plus the bridge that propagates assembler teardown to the process when the assembler aborts for reasons the process's own exit handler
cannot discover on its own (watchdog timeout, source stream error).

This base deliberately contains **no pipeline logic** and **no command-line assembly**. The byte-to-segment pipeline lives in [Mp4SegmentAssembler](mp4-assembler.md#mp4segmentassembler), and each
concrete subclass builds its own FFmpeg arg vector. The base exists solely to consolidate the composition shape - internal assembler field, the delegating public
methods, and the bridge registration - that would otherwise duplicate across every fMP4 subclass. The constructor takes only `segmentTimeout` as a mode-specific knob
and holds no mode-specific state, so the base avoids template-method coupling with its subclasses.

Subclasses must call `super(options, init, segmentTimeout?)` from their constructor, having already folded their subclass-specific init into a base-compatible
[FfmpegProcessInit](process.md#ffmpegprocessinit) (typically by spreading their own init and setting `args` to their built command line).

#### See

 - Mp4SegmentAssembler
 - FfmpegProcess

#### Extends

- [`FfmpegProcess`](process.md#ffmpegprocess)

#### Extended by

- [`FfmpegRecordingProcess`](#ffmpegrecordingprocess)
- [`FfmpegLivestreamProcess`](#ffmpeglivestreamprocess)

#### Properties

| Property | Modifier | Type | Description | Overrides | Inherited from |
| ------ | ------ | ------ | ------ | ------ | ------ |
| <a id="exited"></a> `exited` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`exited`](process.md#exited) |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason` when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit). | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`ready`](process.md#ready) |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the reason encoded on `signal.reason` names the cause (see [HbpuAbortReason](../util.md#hbpuabortreason)). Subclasses and external callers attach `"abort"` listeners to this signal when they need scope-bound teardown hooks of their own. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`signal`](process.md#signal) |
| <a id="stderr"></a> `stderr` | `readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated [FfmpegProcess.stderrLog](process.md#stderrlog); most callers should prefer `stderrLog` since the class already buffers lines for them. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`stderr`](process.md#stderr) |
| <a id="stdin"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream for the FFmpeg process. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`stdin`](process.md#stdin) |
| <a id="stdout"></a> `stdout` | `readonly` | `never` | stdout is consumed internally by the assembler. The public type is narrowed to `never` so TypeScript callers cannot accidentally attach a concurrent reader. | [`FfmpegProcess`](process.md#ffmpegprocess).[`stdout`](process.md#stdout) | - |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`aborted`](process.md#aborted)

##### bufferedSegments

###### Get Signature

```ts
get bufferedSegments(): number;
```

The number of assembled media segments buffered in the internal assembler but not yet pulled through [FfmpegFMp4Process.segments](#segments) - the consumer's catch-up
reserve when the FFmpeg source stalls. Delegates to [Mp4SegmentAssembler.bufferedSegments](mp4-assembler.md#bufferedsegments).

###### Returns

`number`

The buffered-segment depth.

##### hasError

###### Get Signature

```ts
get hasError(): boolean;
```

`true` when the abort reason was `HbpuAbortError("failed")`. Covers spawn failures and non-zero natural exits. Derived from `this.signal.reason`; no stored flag.

###### Returns

`boolean`

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`hasError`](process.md#haserror)

##### isTimedOut

###### Get Signature

```ts
get isTimedOut(): boolean;
```

`true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` and the platform `TimeoutError` emitted by
`AbortSignal.timeout()`. The branching lives in [isTimeoutReason](../util.md#istimeoutreason) so this getter stays a one-line delegation and every resource class in the library
shares one definition of "timeout."

###### Returns

`boolean`

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`isTimedOut`](process.md#istimedout)

##### stderrLog

###### Get Signature

```ts
get stderrLog(): readonly string[];
```

The accumulated stderr lines this process has produced, preserved across teardown for post-mortem inspection. The array is returned as a readonly view to make the
intent explicit: callers read from it, they do not mutate it.

###### Returns

readonly `string`[]

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`stderrLog`](process.md#stderrlog)

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the process (defaulting to `"shutdown"`) and awaits actual exit before returning, so callers using `await using` are
guaranteed the child has terminated by the time the block exits.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the child has fully exited.

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`[asyncDispose]`](process.md#asyncdispose)

##### abort()

```ts
abort(reason?): void;
```

Abort the process and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after natural exit is also safe for the
same reason.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror); platform errors (`TimeoutError`, `AbortError`) also interoperate by convention. |

###### Returns

`void`

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`abort`](process.md#abort)

##### getInitSegment()

```ts
getInitSegment(): Promise<Buffer<ArrayBufferLike>>;
```

Resolve with the fMP4 initialization segment (typically `ftyp` + `moov`) once it appears on stdout. Rejects with `this.signal.reason` if the process aborts before
the initialization segment completes.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the initialization segment bytes.

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Async generator yielding each completed media segment (concatenated `moof` + `mdat` pair) as a single Buffer. Terminates cleanly when the process or the caller's
signal aborts, or when the underlying stdout ends.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding media segment buffers in stream order.

##### stream()

```ts
stream(init?): AsyncGenerator<Mp4Segment>;
```

Async generator yielding the whole segment stream as a kind-tagged sequence: one [Mp4Segment](mp4-assembler.md#mp4segment) of kind `"init"` carrying the initialization bytes, then one of
kind `"media"` per completed media fragment. Delegates to [Mp4SegmentAssembler.stream](mp4-assembler.md#stream); it is a third view over the same pipeline as
[FfmpegFMp4Process.getInitSegment](#getinitsegment) / [FfmpegFMp4Process.segments](#segments) and shares their single-consumer contract - use one view or the other, never both.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<[`Mp4Segment`](mp4-assembler.md#mp4segment)\>

An async generator yielding one `"init"` segment followed by `"media"` segments in stream order.

***

### FfmpegLivestreamProcess

FFmpeg process specialization for fMP4 livestreaming from an RTSP source. Builds its command line from the provided livestream source and delegates segment production
to [FfmpegFMp4Process](#abstract-ffmpegfmp4process).

Used by HBUP as an alternative HKSV segment source when pulling directly from an RTSP URL (bypasses the Protect livestream API for debug and diagnostic scenarios).
Matches the polymorphic `{ getInitSegment(): Promise<Buffer>; segments(): AsyncGenerator<Buffer> }` interface HBUP uses across the native Protect livestream and this
class. Unlike recording, livestream does not enforce an inter-segment watchdog timeout: a live camera feed legitimately quiets down during low-motion periods and does
not carry HKSV's 5-second hard timing contract. Callers that need a liveness cap can compose their own timeout via the process's `signal`.

#### Example

```ts
await using proc = new FfmpegLivestreamProcess(ffmpegOptions, {

  audio: { codec: AudioRecordingCodecType.AAC_LC, samplerate: AudioRecordingSamplerate.KHZ_16 },
  livestream: { url: "rtsp://camera/stream" },
  segmentLength: 1000,
  signal: session.controller.signal
});

const init = await proc.getInitSegment();

for await (const segment of proc.segments()) {

  // Forward each media segment to the downstream consumer.
}
```

#### See

 - FfmpegFMp4Process
 - FfmpegProcess

#### Extends

- [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process)

#### Constructors

##### Constructor

```ts
new FfmpegLivestreamProcess(options, init): FfmpegLivestreamProcess;
```

Construct and spawn a new fMP4 livestream process.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init` | [`FfmpegLivestreamInit`](#ffmpeglivestreaminit) | Init options. See [FfmpegLivestreamInit](#ffmpeglivestreaminit). |

###### Returns

[`FfmpegLivestreamProcess`](#ffmpeglivestreamprocess)

###### Overrides

```ts
FfmpegFMp4Process.constructor
```

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="exited-1"></a> `exited` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`exited`](#exited) |
| <a id="ready-1"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason` when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit). | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`ready`](#ready) |
| <a id="signal-1"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the reason encoded on `signal.reason` names the cause (see [HbpuAbortReason](../util.md#hbpuabortreason)). Subclasses and external callers attach `"abort"` listeners to this signal when they need scope-bound teardown hooks of their own. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`signal`](#signal) |
| <a id="stderr-1"></a> `stderr` | `readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated [FfmpegProcess.stderrLog](process.md#stderrlog); most callers should prefer `stderrLog` since the class already buffers lines for them. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stderr`](#stderr) |
| <a id="stdin-1"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream for the FFmpeg process. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stdin`](#stdin) |
| <a id="stdout-1"></a> `stdout` | `readonly` | `never` | stdout is consumed internally by the assembler. The public type is narrowed to `never` so TypeScript callers cannot accidentally attach a concurrent reader. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stdout`](#stdout) |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`aborted`](#aborted)

##### bufferedSegments

###### Get Signature

```ts
get bufferedSegments(): number;
```

The number of assembled media segments buffered in the internal assembler but not yet pulled through [FfmpegFMp4Process.segments](#segments) - the consumer's catch-up
reserve when the FFmpeg source stalls. Delegates to [Mp4SegmentAssembler.bufferedSegments](mp4-assembler.md#bufferedsegments).

###### Returns

`number`

The buffered-segment depth.

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`bufferedSegments`](#bufferedsegments)

##### hasError

###### Get Signature

```ts
get hasError(): boolean;
```

`true` when the abort reason was `HbpuAbortError("failed")`. Covers spawn failures and non-zero natural exits. Derived from `this.signal.reason`; no stored flag.

###### Returns

`boolean`

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`hasError`](#haserror)

##### isTimedOut

###### Get Signature

```ts
get isTimedOut(): boolean;
```

`true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` and the platform `TimeoutError` emitted by
`AbortSignal.timeout()`. The branching lives in [isTimeoutReason](../util.md#istimeoutreason) so this getter stays a one-line delegation and every resource class in the library
shares one definition of "timeout."

###### Returns

`boolean`

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`isTimedOut`](#istimedout)

##### stderrLog

###### Get Signature

```ts
get stderrLog(): readonly string[];
```

The accumulated stderr lines this process has produced, preserved across teardown for post-mortem inspection. The array is returned as a readonly view to make the
intent explicit: callers read from it, they do not mutate it.

###### Returns

readonly `string`[]

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stderrLog`](#stderrlog)

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the process (defaulting to `"shutdown"`) and awaits actual exit before returning, so callers using `await using` are
guaranteed the child has terminated by the time the block exits.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the child has fully exited.

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`[asyncDispose]`](#asyncdispose)

##### abort()

```ts
abort(reason?): void;
```

Abort the process and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after natural exit is also safe for the
same reason.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror); platform errors (`TimeoutError`, `AbortError`) also interoperate by convention. |

###### Returns

`void`

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`abort`](#abort)

##### getInitSegment()

```ts
getInitSegment(): Promise<Buffer<ArrayBufferLike>>;
```

Resolve with the fMP4 initialization segment (typically `ftyp` + `moov`) once it appears on stdout. Rejects with `this.signal.reason` if the process aborts before
the initialization segment completes.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the initialization segment bytes.

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`getInitSegment`](#getinitsegment)

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Async generator yielding each completed media segment (concatenated `moof` + `mdat` pair) as a single Buffer. Terminates cleanly when the process or the caller's
signal aborts, or when the underlying stdout ends.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding media segment buffers in stream order.

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`segments`](#segments)

##### stream()

```ts
stream(init?): AsyncGenerator<Mp4Segment>;
```

Async generator yielding the whole segment stream as a kind-tagged sequence: one [Mp4Segment](mp4-assembler.md#mp4segment) of kind `"init"` carrying the initialization bytes, then one of
kind `"media"` per completed media fragment. Delegates to [Mp4SegmentAssembler.stream](mp4-assembler.md#stream); it is a third view over the same pipeline as
[FfmpegFMp4Process.getInitSegment](#getinitsegment) / [FfmpegFMp4Process.segments](#segments) and shares their single-consumer contract - use one view or the other, never both.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<[`Mp4Segment`](mp4-assembler.md#mp4segment)\>

An async generator yielding one `"init"` segment followed by `"media"` segments in stream order.

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stream`](#stream)

***

### FfmpegRecordingProcess

FFmpeg process specialization for HomeKit Secure Video (HKSV) event recording. Builds its command line from the provided HKSV recording configuration and delegates
segment production to [FfmpegFMp4Process](#abstract-ffmpegfmp4process). Overrides `FfmpegProcess.logFailedTeardown` to substitute a friendly user-facing message when the stderr log
matches one of the tolerated HKSV error patterns, suppressing the canonical ERROR dump for those known benign cases. Also overrides
`FfmpegProcess.logTimeoutTeardown` to demote the benign inter-segment watchdog reap to debug - a recording ends exactly this way when its segment source quiets,
so the base's WARN would be alarming.

#### Example

```ts
await using proc = new FfmpegRecordingProcess(ffmpegOptions, {

  recording: { fps: 30, probesize: 5_000_000, timeshift: 0 },
  recordingConfig,
  signal: delegate.abortController.signal
});

const init = await proc.getInitSegment();

for await (const segment of proc.segments()) {

  // Forward each media segment to HomeKit.
}
```

#### See

 - FfmpegFMp4Process
 - FfmpegProcess

#### Extends

- [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process)

#### Implements

- [`RecordingProcess`](#recordingprocess)

#### Constructors

##### Constructor

```ts
new FfmpegRecordingProcess(options, init): FfmpegRecordingProcess;
```

Construct and spawn a new HKSV recording process.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init` | [`FfmpegRecordingInit`](#ffmpegrecordinginit) | Init options. See [FfmpegRecordingInit](#ffmpegrecordinginit). |

###### Returns

[`FfmpegRecordingProcess`](#ffmpegrecordingprocess)

###### Overrides

```ts
FfmpegFMp4Process.constructor
```

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="exited-2"></a> `exited` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`exited`](#exited) |
| <a id="ready-2"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason` when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit). | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`ready`](#ready) |
| <a id="signal-2"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the reason encoded on `signal.reason` names the cause (see [HbpuAbortReason](../util.md#hbpuabortreason)). Subclasses and external callers attach `"abort"` listeners to this signal when they need scope-bound teardown hooks of their own. | [`RecordingProcess`](#recordingprocess).[`signal`](#signal-5) [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`signal`](#signal) |
| <a id="stderr-2"></a> `stderr` | `readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated [FfmpegProcess.stderrLog](process.md#stderrlog); most callers should prefer `stderrLog` since the class already buffers lines for them. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stderr`](#stderr) |
| <a id="stdin-2"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream for the FFmpeg process. | [`RecordingProcess`](#recordingprocess).[`stdin`](#stdin-3) [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stdin`](#stdin) |
| <a id="stdout-2"></a> `stdout` | `readonly` | `never` | stdout is consumed internally by the assembler. The public type is narrowed to `never` so TypeScript callers cannot accidentally attach a concurrent reader. | [`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stdout`](#stdout) |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`aborted`](#aborted)

##### bufferedSegments

###### Get Signature

```ts
get bufferedSegments(): number;
```

The number of assembled media segments buffered in the internal assembler but not yet pulled through [FfmpegFMp4Process.segments](#segments) - the consumer's catch-up
reserve when the FFmpeg source stalls. Delegates to [Mp4SegmentAssembler.bufferedSegments](mp4-assembler.md#bufferedsegments).

###### Returns

`number`

The buffered-segment depth.

The number of assembled media segments buffered but not yet pulled through [RecordingProcess.segments](#segments-3) - the consumer's catch-up reserve when the source
stalls.

###### Implementation of

[`RecordingProcess`](#recordingprocess).[`bufferedSegments`](#bufferedsegments-3)

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`bufferedSegments`](#bufferedsegments)

##### hasError

###### Get Signature

```ts
get hasError(): boolean;
```

`true` when the abort reason was `HbpuAbortError("failed")`. Covers spawn failures and non-zero natural exits. Derived from `this.signal.reason`; no stored flag.

###### Returns

`boolean`

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`hasError`](#haserror)

##### isTimedOut

###### Get Signature

```ts
get isTimedOut(): boolean;
```

`true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` and the platform `TimeoutError` emitted by
`AbortSignal.timeout()`. The branching lives in [isTimeoutReason](../util.md#istimeoutreason) so this getter stays a one-line delegation and every resource class in the library
shares one definition of "timeout."

###### Returns

`boolean`

`true` when the abort reason indicates a timeout (the inter-segment watchdog fired or the platform `TimeoutError` was raised).

###### Implementation of

[`RecordingProcess`](#recordingprocess).[`isTimedOut`](#istimedout-3)

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`isTimedOut`](#istimedout)

##### stderrLog

###### Get Signature

```ts
get stderrLog(): readonly string[];
```

The accumulated stderr lines this process has produced, preserved across teardown for post-mortem inspection. The array is returned as a readonly view to make the
intent explicit: callers read from it, they do not mutate it.

###### Returns

readonly `string`[]

The accumulated stderr lines the process produced, preserved across teardown for post-mortem inspection. A readonly view: callers read, they do not mutate.

###### Implementation of

[`RecordingProcess`](#recordingprocess).[`stderrLog`](#stderrlog-3)

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stderrLog`](#stderrlog)

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the process (defaulting to `"shutdown"`) and awaits actual exit before returning, so callers using `await using` are
guaranteed the child has terminated by the time the block exits.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the child has fully exited.

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`[asyncDispose]`](#asyncdispose)

##### abort()

```ts
abort(reason?): void;
```

Abort the process and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after natural exit is also safe for the
same reason.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror); platform errors (`TimeoutError`, `AbortError`) also interoperate by convention. |

###### Returns

`void`

###### Implementation of

[`RecordingProcess`](#recordingprocess).[`abort`](#abort-3)

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`abort`](#abort)

##### getInitSegment()

```ts
getInitSegment(): Promise<Buffer<ArrayBufferLike>>;
```

Resolve with the fMP4 initialization segment (typically `ftyp` + `moov`) once it appears on stdout. Rejects with `this.signal.reason` if the process aborts before
the initialization segment completes.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the initialization segment bytes.

###### Implementation of

[`RecordingProcess`](#recordingprocess).[`getInitSegment`](#getinitsegment-3)

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`getInitSegment`](#getinitsegment)

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Async generator yielding each completed media segment (concatenated `moof` + `mdat` pair) as a single Buffer. Terminates cleanly when the process or the caller's
signal aborts, or when the underlying stdout ends.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding media segment buffers in stream order.

###### Implementation of

[`RecordingProcess`](#recordingprocess).[`segments`](#segments-3)

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`segments`](#segments)

##### stream()

```ts
stream(init?): AsyncGenerator<Mp4Segment>;
```

Async generator yielding the whole segment stream as a kind-tagged sequence: one [Mp4Segment](mp4-assembler.md#mp4segment) of kind `"init"` carrying the initialization bytes, then one of
kind `"media"` per completed media fragment. Delegates to [Mp4SegmentAssembler.stream](mp4-assembler.md#stream); it is a third view over the same pipeline as
[FfmpegFMp4Process.getInitSegment](#getinitsegment) / [FfmpegFMp4Process.segments](#segments) and shares their single-consumer contract - use one view or the other, never both.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<[`Mp4Segment`](mp4-assembler.md#mp4segment)\>

An async generator yielding one `"init"` segment followed by `"media"` segments in stream order.

###### Implementation of

[`RecordingProcess`](#recordingprocess).[`stream`](#stream-3)

###### Inherited from

[`FfmpegFMp4Process`](#abstract-ffmpegfmp4process).[`stream`](#stream)

***

### FfmpegLivestreamInit

Construction-time options for [FfmpegLivestreamProcess](#ffmpeglivestreamprocess).

#### Remarks

Supplying `args` (inherited from [FfmpegProcessInit](process.md#ffmpegprocessinit)) is an advanced escape hatch that replaces the auto-built command line entirely. When `args` is
present, the mode-specific config fields (`audio`, `livestream`, `segmentLength`, `verbose`) do not participate in command-line assembly - they become no-ops. Typical
callers omit `args` and let the class build the command line from `livestream` + `audio`.

#### See

 - FfmpegProcessInit
 - FMp4AudioTarget
 - FMp4LivestreamOptions

#### Extends

- [`FfmpegProcessInit`](process.md#ffmpegprocessinit)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="args"></a> `args?` | `string`[] | Optional. FFmpeg command-line arguments. Defaults to an empty array. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`args`](process.md#args) |
| <a id="audio"></a> `audio?` | [`FMp4AudioTarget`](#fmp4audiotarget) | Optional. The resolved audio-encode target. When provided, the audio stream is transcoded to it (with any filters it carries); when omitted, the already-encoded audio is copied through untouched. This is the livestream path's sole audio-filter source. | - |
| <a id="livestream"></a> `livestream` | [`PartialWithId`](../util.md#partialwithid)\<[`FMp4LivestreamOptions`](#fmp4livestreamoptions), `"url"`\> | Livestream source configuration. `url` is required; other [FMp4BaseOptions](#fmp4baseoptions) fields are optional and default when omitted. | - |
| <a id="segmentlength"></a> `segmentLength?` | `number` | Optional. fMP4 fragment duration in milliseconds, applied to `-frag_duration` at construction time. Defaults to 1000 ms (1 second). | - |
| <a id="signal-3"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional. Parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the process's internal controller. When the parent aborts, the process tears down. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`signal`](process.md#signal-1) |
| <a id="startuptimeout"></a> `startupTimeout?` | `number` | Optional. If FFmpeg does not produce stderr output within this many milliseconds, the process is aborted with `HbpuAbortError("timeout")`. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`startupTimeout`](process.md#startuptimeout) |
| <a id="verbose"></a> `verbose?` | `boolean` | Optional. When `true`, FFmpeg is invoked with verbose logging (`-loglevel level+verbose`) regardless of the global `codecSupport.verbose` flag. Defaults to `false`. | - |

***

### FfmpegRecordingInit

Construction-time options for [FfmpegRecordingProcess](#ffmpegrecordingprocess).

#### Remarks

Supplying `args` (inherited from [FfmpegProcessInit](process.md#ffmpegprocessinit)) is an advanced escape hatch that replaces the auto-built command line entirely. When `args` is
present, the mode-specific config fields (`recording`, `verbose`) do not participate in command-line assembly - they become no-ops. Typical callers omit `args` and
let the class build the command line from the recording configuration.

#### See

 - FfmpegProcessInit
 - FMp4RecordingOptions

#### Extends

- [`FfmpegProcessInit`](process.md#ffmpegprocessinit)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="args-1"></a> `args?` | `string`[] | Optional. FFmpeg command-line arguments. Defaults to an empty array. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`args`](process.md#args) |
| <a id="recording"></a> `recording?` | `Partial`\<[`FMp4RecordingOptions`](#fmp4recordingoptions)\> | Optional. fMP4 recording options. Every field defaults when omitted; the interface surface matches [FMp4RecordingOptions](#fmp4recordingoptions) but with all fields optional. | - |
| <a id="recordingconfig"></a> `recordingConfig` | `CameraRecordingConfiguration` | The HomeKit recording configuration (resolution, codec profile, audio codec, sample rate, channels) produced by the HKSV delegate. | - |
| <a id="signal-4"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional. Parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the process's internal controller. When the parent aborts, the process tears down. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`signal`](process.md#signal-1) |
| <a id="startuptimeout-1"></a> `startupTimeout?` | `number` | Optional. If FFmpeg does not produce stderr output within this many milliseconds, the process is aborted with `HbpuAbortError("timeout")`. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`startupTimeout`](process.md#startuptimeout) |
| <a id="verbose-1"></a> `verbose?` | `boolean` | Optional. When `true`, FFmpeg is invoked with verbose logging (`-loglevel level+verbose`) regardless of the global `codecSupport.verbose` flag. Defaults to `false`. | - |

***

### FMp4AudioInputConfig

Configuration for a separate audio input source in an fMP4 livestream session. This interface describes the audio source when video and audio come from different
endpoints, such as cameras like DoorBird that expose audio through a separate HTTP API.

When the audio source is a raw stream (not a self-describing container), specify `format`, `sampleRate`, and optionally `channels` so FFmpeg knows how to interpret
the input. For self-describing sources like RTSP or container-based HTTP streams, only `url` is required.

#### See

FMp4LivestreamOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="channels"></a> `channels?` | `number` | Optional. Number of audio channels. Defaults to `1`. |
| <a id="format"></a> `format?` | `"alaw"` \| `"mulaw"` \| `"s16le"` | Optional. Raw audio format for the input stream. When set, FFmpeg is told to expect this format rather than probing the stream. Valid values are `alaw` (G.711 A-law), `mulaw` (G.711 mu-law), and `s16le` (16-bit signed little-endian PCM). Omit for self-describing sources. |
| <a id="samplerate"></a> `sampleRate?` | `number` | Optional. Audio sample rate in Hz (e.g., `8000`). Used when `format` is set. Defaults to `8000`. |
| <a id="url"></a> `url` | `string` | The URL of the audio input source. |

***

### FMp4AudioTarget

The resolved audio-encode target for fMP4 production. Its presence on an fMP4 command line is the single signal to transcode the audio stream to this target; its
absence means the already-encoded audio is copied through untouched. Any audio filters are carried inside the target because filtering requires transcoding - a filter
without a transcode is unrepresentable by construction, so the filters-require-transcoding rule holds declaratively rather than through a runtime override.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="channels-1"></a> `channels?` | `number` | Optional. Number of output audio channels. Defaults to `1` when omitted. |
| <a id="codec"></a> `codec` | `AudioRecordingCodecType` | The AAC codec variant to encode to (low-complexity or enhanced low-delay). |
| <a id="filters"></a> `filters?` | `string`[] | Optional. Audio filters applied ahead of the encoder. Supplying filters is what makes the transcode carry them; an empty or omitted list transcodes without filtering. |
| <a id="samplerate-1"></a> `samplerate` | `AudioRecordingSamplerate` | The output audio sample rate. |

***

### FMp4BaseOptions

Base options shared by both fMP4 recording and livestream sessions.

#### Extended by

- [`FMp4RecordingOptions`](#fmp4recordingoptions)
- [`FMp4LivestreamOptions`](#fmp4livestreamoptions)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="audiofilters"></a> `audioFilters` | `string`[] | Audio filters for FFmpeg to process. These are passed as an array of filters. Recording-only: the livestream builder ignores this field, driving its audio-filter decision from the `audio` target instead. |
| <a id="audiostream"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). |
| <a id="codec-1"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc` (`h265` is accepted as an alias for `hevc`). Defaults to `h264`. |
| <a id="enableaudio"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. |
| <a id="hardwaredecoding"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions` when FFmpeg is at least 8.x; on an older FFmpeg the default is always `false` regardless of what `ffmpegOptions` specifies. |
| <a id="hardwaretranscoding"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. |
| <a id="transcodeaudio"></a> `transcodeAudio` | `boolean` | Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. Recording-only: the livestream builder ignores this field, driving its transcode decision from the `audio` target instead. |
| <a id="videofilters"></a> `videoFilters` | `string`[] | Video filters for FFmpeg to process. These are passed as an array of filters. |
| <a id="videostream"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). |

***

### FMp4LivestreamOptions

Options for configuring an fMP4 livestream session.

#### See

FMp4AudioInputConfig

#### Extends

- [`FMp4BaseOptions`](#fmp4baseoptions)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="audiofilters-1"></a> `audioFilters` | `string`[] | Audio filters for FFmpeg to process. These are passed as an array of filters. Recording-only: the livestream builder ignores this field, driving its audio-filter decision from the `audio` target instead. | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioFilters`](#audiofilters) |
| <a id="audioinput"></a> `audioInput?` | `string` \| [`FMp4AudioInputConfig`](#fmp4audioinputconfig) | Optional. A separate audio input source. When provided, audio is read from this source instead of the primary `url`. Can be a URL string for self-describing sources (e.g., RTSP), or an `FMp4AudioInputConfig` object for raw audio streams that require format metadata. | - |
| <a id="audiostream-1"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioStream`](#audiostream) |
| <a id="codec-2"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc` (`h265` is accepted as an alias for `hevc`). Defaults to `h264`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`codec`](#codec-1) |
| <a id="enableaudio-1"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. | [`FMp4BaseOptions`](#fmp4baseoptions).[`enableAudio`](#enableaudio) |
| <a id="hardwaredecoding-1"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions` when FFmpeg is at least 8.x; on an older FFmpeg the default is always `false` regardless of what `ffmpegOptions` specifies. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareDecoding`](#hardwaredecoding) |
| <a id="hardwaretranscoding-1"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareTranscoding`](#hardwaretranscoding) |
| <a id="transcodeaudio-1"></a> `transcodeAudio` | `boolean` | Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. Recording-only: the livestream builder ignores this field, driving its transcode decision from the `audio` target instead. | [`FMp4BaseOptions`](#fmp4baseoptions).[`transcodeAudio`](#transcodeaudio) |
| <a id="url-1"></a> `url` | `string` | Source URL for livestream (RTSP) remuxing to fMP4. | - |
| <a id="videofilters-1"></a> `videoFilters` | `string`[] | Video filters for FFmpeg to process. These are passed as an array of filters. | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoFilters`](#videofilters) |
| <a id="videostream-1"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoStream`](#videostream) |

***

### FMp4RecordingOptions

Options for configuring an fMP4 HKSV recording session.

#### Extends

- [`FMp4BaseOptions`](#fmp4baseoptions)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="audiofilters-2"></a> `audioFilters` | `string`[] | Audio filters for FFmpeg to process. These are passed as an array of filters. Recording-only: the livestream builder ignores this field, driving its audio-filter decision from the `audio` target instead. | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioFilters`](#audiofilters) |
| <a id="audiostream-2"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioStream`](#audiostream) |
| <a id="codec-3"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc` (`h265` is accepted as an alias for `hevc`). Defaults to `h264`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`codec`](#codec-1) |
| <a id="enableaudio-2"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. | [`FMp4BaseOptions`](#fmp4baseoptions).[`enableAudio`](#enableaudio) |
| <a id="fps"></a> `fps` | `number` | The video frames per second for the session. Defaults to 30. | - |
| <a id="hardwaredecoding-2"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions` when FFmpeg is at least 8.x; on an older FFmpeg the default is always `false` regardless of what `ffmpegOptions` specifies. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareDecoding`](#hardwaredecoding) |
| <a id="hardwaretranscoding-2"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareTranscoding`](#hardwaretranscoding) |
| <a id="probesize"></a> `probesize` | `number` | Number of bytes to analyze for stream information. Defaults to 5,000,000 bytes (mirrors FFmpeg's own default probesize). | - |
| <a id="timeshift"></a> `timeshift` | `number` | Timeshift offset for event-based recording (in milliseconds). Defaults to 0. | - |
| <a id="transcodeaudio-2"></a> `transcodeAudio` | `boolean` | Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. Recording-only: the livestream builder ignores this field, driving its transcode decision from the `audio` target instead. | [`FMp4BaseOptions`](#fmp4baseoptions).[`transcodeAudio`](#transcodeaudio) |
| <a id="videofilters-2"></a> `videoFilters` | `string`[] | Video filters for FFmpeg to process. These are passed as an array of filters. | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoFilters`](#videofilters) |
| <a id="videostream-2"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoStream`](#videostream) |

***

### RecordingProcess

The minimal surface a recording consumer reads off a recording process. This is the product half of the recording dependency-inversion seam: an HKSV recording
delegate depends on this narrow interface rather than the concrete [FfmpegRecordingProcess](#ffmpegrecordingprocess), so a test (or any alternative segment source) can substitute a
fake without dragging FFmpeg into the consumer's dependency graph. The interface is type-only, so importing it costs a consumer nothing at runtime.

Every member here is defined on [FfmpegFMp4Process](#abstract-ffmpegfmp4process) (`getInitSegment`, `segments`, `stream`, `bufferedSegments`) or inherited from [FfmpegProcess](process.md#ffmpegprocess)
(`abort`, `isTimedOut`, `signal`, `stderrLog`, `stdin`), so the real [FfmpegRecordingProcess](#ffmpegrecordingprocess) satisfies it by inheritance and carries only an `implements`
annotation - zero runtime behavior change. This is deliberately the consumer's minimal surface, not the class's full surface: `ready`, `exited`, `stdout`,
`aborted`, `hasError`, and `[Symbol.asyncDispose]` are NOT here because the recording consumer does not read them.

#### See

 - FfmpegRecordingProcess
 - RecordingProcessFactory

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="bufferedsegments-3"></a> `bufferedSegments` | `readonly` | `number` | The number of assembled media segments buffered but not yet pulled through [RecordingProcess.segments](#segments-3) - the consumer's catch-up reserve when the source stalls. |
| <a id="istimedout-3"></a> `isTimedOut` | `readonly` | `boolean` | `true` when the abort reason indicates a timeout (the inter-segment watchdog fired or the platform `TimeoutError` was raised). |
| <a id="signal-5"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing the recording process's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause. |
| <a id="stderrlog-3"></a> `stderrLog` | `readonly` | readonly `string`[] | The accumulated stderr lines the process produced, preserved across teardown for post-mortem inspection. A readonly view: callers read, they do not mutate. |
| <a id="stdin-3"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream the recording bytes are fed into. |

#### Methods

##### abort()

```ts
abort(reason?): void;
```

Abort the recording process and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

##### getInitSegment()

```ts
getInitSegment(): Promise<Buffer<ArrayBufferLike>>;
```

Resolve with the fMP4 initialization segment (typically `ftyp` + `moov`). Rejects with `signal.reason` if the process aborts before the initialization segment
completes.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the initialization segment bytes.

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Async generator yielding each completed media segment (a concatenated `moof` + `mdat` pair) as a single Buffer, in stream order. Terminates cleanly when the process
or the caller's signal aborts, or when the underlying source ends.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding media segment buffers in stream order.

##### stream()

```ts
stream(init?): AsyncGenerator<Mp4Segment>;
```

Async generator yielding the whole segment stream as a kind-tagged sequence: one [Mp4Segment](mp4-assembler.md#mp4segment) of kind `"init"` carrying the initialization bytes, then one of
kind `"media"` per completed media fragment. A third view over the same pipeline as [RecordingProcess.getInitSegment](#getinitsegment-3) / [RecordingProcess.segments](#segments-3) that
shares their single-consumer contract - a consumer uses this view or that pair, never both.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with the process's own signal; aborting it terminates only this generator call, not the process. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<[`Mp4Segment`](mp4-assembler.md#mp4segment)\>

An async generator yielding one `"init"` segment followed by `"media"` segments in stream order.

***

### RecordingProcessFactory

The creational half of the recording dependency-inversion seam: build a [RecordingProcess](#recordingprocess) from the shared options and the recording init. A consumer holds
this factory typed as the abstraction and constructs through it, so a test can substitute a factory that returns a fake recording process. The production factory is
[recordingProcessFactory](#recordingprocessfactory-1), whose `create` is exactly the [FfmpegRecordingProcess](#ffmpegrecordingprocess) constructor call - so routing construction through this seam is
behavior-neutral, mirroring HBUP's `streamingDelegateFactory` precedent.

#### See

 - recordingProcessFactory
 - RecordingProcess

#### Methods

##### create()

```ts
create(options, init): RecordingProcess;
```

Construct a recording process for the supplied options and recording init.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init` | [`FfmpegRecordingInit`](#ffmpegrecordinginit) | Recording init options. See [FfmpegRecordingInit](#ffmpegrecordinginit). |

###### Returns

[`RecordingProcess`](#recordingprocess)

A new [RecordingProcess](#recordingprocess).

***

### recordingProcessFactory

```ts
const recordingProcessFactory: RecordingProcessFactory;
```

The production [RecordingProcessFactory](#recordingprocessfactory): builds the concrete FFmpeg-backed recording process. A consumer holds this typed as the abstraction; a test substitutes
a fake factory. `create` is exactly the [FfmpegRecordingProcess](#ffmpegrecordingprocess) constructor call, so wiring construction through this seam is behavior-neutral.

#### See

RecordingProcessFactory
