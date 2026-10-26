[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/livestream-process-double

# ffmpeg/livestream-process-double

An FFmpeg-free [LivestreamProcess](record.md#livestreamprocess) test double.

A class that owns a livestream has its hard cases in timing rather than in bytes: an abort that lands while it waits for the initialization segment, a source that
ends partway through a read, a dispose that meets a parked read. This module ships the double for those - a [TestLivestreamProcess](#testlivestreamprocess) a test drives one step at
a time, resolving the initialization segment, feeding media segments, and closing the source when the row says so, with no child process anywhere in sight - and a
[TestLivestreamProcessFactory](#testlivestreamprocessfactory) that builds one per `create` from the init the consumer passed.

The double is built on the primitives the real segment path uses rather than on an imitation of them. Its segments are an `AsyncQueue` drained under its lifetime
composed with the caller's signal, its stream waits for the initialization segment through `waitWithSignal`, and its initialization wait rejects with the lifetime's
reason when the lifetime ends first, exactly as the assembler's does. What it does on abort is therefore what the real process does: segments fed before the
lifetime ended are still handed over, and an initialization segment that resolved first stays resolved.

The drivers refuse a sequence no real process produces rather than modeling it: feeding a media segment ahead of the initialization segment, resolving the
initialization segment twice, or driving a double whose lifetime has ended throws.

Signatures come from the process's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
compiler saying so.

## Testing

### TestLivestreamProcess

A driven, FFmpeg-free [LivestreamProcess](record.md#livestreamprocess) double: it produces the initialization segment and the media segments a test hands it, in the order the test hands
them, and its lifetime ends the ways a real process's does.

The lifetime is the parent signal the constructor receives composed with the double's own, and it ends once, by whichever comes first: the parent aborting,
[TestLivestreamProcess.abort](#abort), [TestLivestreamProcess.end](#end) for the source closing, or `[Symbol.asyncDispose]`.

Where it differs from the real process: it spawns nothing, so it has no exit, no stderr, and no startup readiness, and its dispose has no exit to await.

#### Example

```ts
import { TestLivestreamProcessFactory, expectAt } from "homebridge-plugin-utils/testing";

const factory = new TestLivestreamProcessFactory();
const session = new CameraLivestreamSession({ processFactory: factory, signal: controller.signal });
const livestream = expectAt(factory.createCalls, 0, "the livestream process the session built").process;

// The consumer's own init wait and segment loop, exercised with no FFmpeg at all.
livestream.resolveInit(initSegment);
livestream.feed(mediaSegment);
controller.abort();
```

#### See

TestLivestreamProcessFactory

#### Implements

- [`LivestreamProcess`](record.md#livestreamprocess)

#### Constructors

##### Constructor

```ts
new TestLivestreamProcess(init?): TestLivestreamProcess;
```

Construct a double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The parent signal the real process would compose into its lifetime: the one a consumer passes in its [FfmpegLivestreamInit](record.md#ffmpeglivestreaminit). Aborting it ends the double with that signal's reason. |

###### Returns

[`TestLivestreamProcess`](#testlivestreamprocess)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `public readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal representing this double's lifetime, composed from the parent signal the constructor received and this double's own, as the real process composes its parent with its own. |

#### Accessors

##### disposeCalls

###### Get Signature

```ts
get disposeCalls(): number;
```

How many times `[Symbol.asyncDispose]` has been called. Dispose is the one way to end the process that a consumer reaches through [LivestreamProcess](record.md#livestreamprocess), so it
is the one act this double records.

###### Returns

`number`

#### Methods

##### \[asyncDispose\]()

```ts
[asyncDispose](): Promise<void>;
```

`AsyncDisposable` implementation: it records the call and ends the lifetime as [TestLivestreamProcess.abort](#abort) does with no reason, defaulting to
`"shutdown"` as the real dispose's abort does. There is no child to wait on, so it resolves once the abort has run. Safe to call more than once, and every call is
counted in [TestLivestreamProcess.disposeCalls](#disposecalls).

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the abort has run.

###### Implementation of

`LivestreamProcess.[asyncDispose]`

##### abort()

```ts
abort(reason?): void;
```

End the lifetime, mirroring [FfmpegProcess.abort](process.md#abort): it defaults to `HbpuAbortError("shutdown")` when no reason is
supplied, and explicit reasons pass through unchanged. A no-op once the lifetime has ended, so the first reason stands.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. See [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

##### end()

```ts
end(): void;
```

Close the source, as a real process's stdout ending does: the lifetime ends with `HbpuAbortError("closed")`, so a pending initialization wait rejects with that
reason and a read hands over every segment fed and then returns. A no-op once the lifetime has ended, as the real source end is.

###### Returns

`void`

##### feed()

```ts
feed(segment): void;
```

Produce one media segment, as an `mdat` completing a fragment does for a real process: it is queued for the next read.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `segment` | `Buffer` | The media segment bytes. |

###### Returns

`void`

###### Throws

The lifetime's reason once the lifetime has ended, and an `Error` when the initialization segment has not resolved, because a real process produces no
        media ahead of it.

##### getInitSegment()

```ts
getInitSegment(): Promise<Buffer<ArrayBufferLike>>;
```

Resolve with the initialization segment [TestLivestreamProcess.resolveInit](#resolveinit) produced. Rejects with the lifetime's reason when the lifetime ends before the
segment resolved, and stays resolved when the lifetime ends after it. Each call returns a promise of its own, as the real method's does.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the initialization segment bytes.

###### Implementation of

[`LivestreamProcess`](record.md#livestreamprocess).[`getInitSegment`](record.md#getinitsegment-3)

##### resolveInit()

```ts
resolveInit(bytes): void;
```

Resolve the initialization segment, as the first `moof` arriving does for a real process.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `bytes` | `Buffer` | The initialization segment bytes. |

###### Returns

`void`

###### Throws

The lifetime's reason once the lifetime has ended, and an `Error` when the initialization segment has already resolved.

##### segments()

```ts
segments(init?): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Read each media segment fed, in order. The read is the queue's drain under the lifetime composed with `init.signal`, the composition the real assembler reads
under: every segment fed before the lifetime ended is handed over before the read returns, and a read whose queue is empty parks until a segment is fed or a
signal aborts.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with this double's own signal; aborting it terminates only this generator call, not the double. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

An async generator yielding the fed media segments in order.

###### Implementation of

[`LivestreamProcess`](record.md#livestreamprocess).[`segments`](record.md#segments-3)

##### stream()

```ts
stream(init?): AsyncGenerator<Mp4Segment>;
```

Read the whole stream as a kind-tagged sequence: one [Mp4Segment](mp4-assembler.md#mp4segment) of kind `"init"` once the initialization segment resolves, then one of kind `"media"` per
segment fed. A lifetime that ended before the initialization segment resolved ends the stream with nothing yielded; one that ended after it hands over the
initialization item and every segment fed, then returns.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` composes with this double's own signal; aborting it terminates only this generator call, not the double. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

`AsyncGenerator`\<[`Mp4Segment`](mp4-assembler.md#mp4segment)\>

An async generator yielding one `"init"` segment followed by `"media"` segments in order.

###### Implementation of

[`LivestreamProcess`](record.md#livestreamprocess).[`stream`](record.md#stream-3)

***

### TestLivestreamProcessFactory

A [LivestreamProcessFactory](record.md#livestreamprocessfactory) double that records every `create` call and answers a fresh [TestLivestreamProcess](#testlivestreamprocess) whose parent signal is the `signal`
of the init the consumer passed, so the consumer's own signal ends the process it gets back as it ends a real one. A test reads the recorded process to drive it.
There is no form that hands back a process built ahead of the call, because such a process could not hear the signal the consumer passes to `create`.

#### See

 - LivestreamProcessFactory
 - TestLivestreamProcess

#### Implements

- [`LivestreamProcessFactory`](record.md#livestreamprocessfactory)

#### Constructors

##### Constructor

```ts
new TestLivestreamProcessFactory(): TestLivestreamProcessFactory;
```

###### Returns

[`TestLivestreamProcessFactory`](#testlivestreamprocessfactory)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="createcalls"></a> `createCalls` | `public readonly` | \{ `init`: [`FfmpegLivestreamInit`](record.md#ffmpeglivestreaminit); `options`: [`FfmpegOptions`](options.md#ffmpegoptions); `process`: [`TestLivestreamProcess`](#testlivestreamprocess); \}[] | `[]` | Every create call's options and init and the process it answered, in order, so a test can assert the boundary was reached with what it expected and can drive the process that came back. |

#### Methods

##### create()

```ts
create(options, init): LivestreamProcess;
```

Record the create call and answer a fresh double over the init's signal.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | The [FfmpegOptions](options.md#ffmpegoptions) the consumer passed. |
| `init` | [`FfmpegLivestreamInit`](record.md#ffmpeglivestreaminit) | The [FfmpegLivestreamInit](record.md#ffmpeglivestreaminit) the consumer passed. |

###### Returns

[`LivestreamProcess`](record.md#livestreamprocess)

The livestream-process double.

###### Implementation of

[`LivestreamProcessFactory`](record.md#livestreamprocessfactory).[`create`](record.md#create)
