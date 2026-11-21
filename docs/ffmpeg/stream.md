[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/stream

# ffmpeg/stream

HomeKit livestreaming FFmpeg process with a signal-driven internal stream-health monitor.

This module defines `FfmpegStreamingProcess`, the specialization of [FfmpegProcess](process.md#ffmpegprocess) for HomeKit live video sessions. The subclass extends the base directly and
composes an internal UDP socket that watches the return port for inbound packets - the HomeKit client's RTCP receiver reports, which flow only once the client is
receiving FFmpeg's output. The watchdog arms on the first such packet; if that return traffic then stops for longer than the configured window the socket aborts the
process with `HbpuAbortError("timeout")` and the base class teardown handles the rest. There is no separate "delegate" surface and no reach-through to the raw
ChildProcess - every external interaction is through the inherited `signal`, `ready`, `exited`, `stdin`, `stderr`, `stderrLog`, `abort()`, and
`[Symbol.asyncDispose]`, and a plugin reports a failed or timed-out ending its own way through the `onFailed` and `onTimeout` callbacks its init inherits. The
health socket's own error line is logged before the process ends as failed, so it stands whatever `onFailed` answers.

`stdout` stays externally readable on this subclass because HBUP's two-way-audio talkback path forwards stdout bytes to the WebSocket that carries audio from the
camera back to the HomeKit client. Unlike the fMP4 subclasses, there is no internal consumer of the stdout stream that would race with an external reader.

The stream-health socket is intentionally simpler than [RtpDemuxer](rtp.md#rtpdemuxer): its sole job is to detect liveness on a known return port. It
does not classify RTP vs. RTCP or forward packets. Two-way-audio demuxing is `RtpDemuxer`'s responsibility and lives in its own class.

A consumer that wants its live view under test constructs the process through [StreamingProcessFactory](#streamingprocessfactory) and reads it through [StreamingProcess](#streamingprocess), the
streaming dependency-inversion boundary, whose production factory is [streamingProcessFactory](#streamingprocessfactory-1) and whose double ships on the testing entry point.

## FFmpeg

### FfmpegStreamingProcess

FFmpeg process specialization for HomeKit livestreaming. Extends [FfmpegProcess](process.md#ffmpegprocess) directly and composes an internal stream-health UDP socket when a return port
is configured.

Lifecycle is entirely signal-driven: construction spawns the child and (optionally) binds the health socket; the socket watches for inbound packets and aborts the
process with `"timeout"` if the window lapses; the inherited teardown path closes the socket and clears the watchdog timer as part of its signal-abort listener
fan-out. The subclass adds no new public verbs beyond what [FfmpegProcess](process.md#ffmpegprocess) provides. The class satisfies [StreamingProcess](#streamingprocess), and a consumer that
substitutes it under test constructs it through a [StreamingProcessFactory](#streamingprocessfactory).

#### Example

```ts
await using proc = new FfmpegStreamingProcess(ffmpegOptions, {

  args: commandLineArgs,
  returnPort: { ipFamily: "ipv4", port: 50000 },
  signal: session.controller.signal
});

await proc.ready;

// Observe the process from the session's own control flow. When the health socket detects a stall, proc.signal fires
// with reason "timeout" and proc.exited resolves with the kill-driven exit context. Surface crashes via the owning
// session's error path.
proc.exited.catch((error) => session.onStreamingError(error));
```

#### See

FfmpegProcess

#### Extends

- [`FfmpegProcess`](process.md#ffmpegprocess)

#### Implements

- [`StreamingProcess`](#streamingprocess)

#### Constructors

##### Constructor

```ts
new FfmpegStreamingProcess(options, init?): FfmpegStreamingProcess;
```

Construct and spawn a new streaming FFmpeg process.

Spawning happens synchronously as part of construction. When `init.returnPort` is supplied, the subclass binds a UDP socket and enforces the liveness watchdog; the
socket closes and the watchdog clears as part of the inherited teardown when the signal aborts for any reason.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init?` | [`FfmpegStreamingInit`](#ffmpegstreaminginit) | Optional init options. See [FfmpegStreamingInit](#ffmpegstreaminginit). |

###### Returns

[`FfmpegStreamingProcess`](#ffmpegstreamingprocess)

###### Overrides

[`FfmpegProcess`](process.md#ffmpegprocess).[`constructor`](process.md#constructor)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="exited"></a> `exited` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`. | [`StreamingProcess`](#streamingprocess).[`exited`](#exited-1) [`FfmpegProcess`](process.md#ffmpegprocess).[`exited`](process.md#exited) |
| <a id="ready"></a> `ready` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason` when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit). | [`StreamingProcess`](#streamingprocess).[`ready`](#ready-1) [`FfmpegProcess`](process.md#ffmpegprocess).[`ready`](process.md#ready) |
| <a id="signal"></a> `signal` | `public readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the reason encoded on `signal.reason` names the cause (see [HbpuAbortReason](../util.md#hbpuabortreason)). Subclasses and external callers attach `"abort"` listeners to this signal when they need scope-bound teardown hooks of their own. | [`StreamingProcess`](#streamingprocess).[`signal`](#signal-2) [`FfmpegProcess`](process.md#ffmpegprocess).[`signal`](process.md#signal) |
| <a id="stderr"></a> `stderr` | `public readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated [FfmpegProcess.stderrLog](process.md#stderrlog); most callers should prefer `stderrLog` since the class already buffers lines for them. | [`FfmpegProcess`](process.md#ffmpegprocess).[`stderr`](process.md#stderr) |
| <a id="stdin"></a> `stdin` | `public readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream for the FFmpeg process. | [`StreamingProcess`](#streamingprocess).[`stdin`](#stdin-1) [`FfmpegProcess`](process.md#ffmpegprocess).[`stdin`](process.md#stdin) |
| <a id="stdout"></a> `stdout` | `public readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard output stream. Subclasses that consume this stream internally narrow the public type to `never` via `declare`. | [`StreamingProcess`](#streamingprocess).[`stdout`](#stdout-1) [`FfmpegProcess`](process.md#ffmpegprocess).[`stdout`](process.md#stdout) |

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

##### commandLine

###### Get Signature

```ts
get commandLine(): readonly string[];
```

The composed FFmpeg argument vector this process was spawned with, readable from construction onward. The array is the frozen copy the class itself holds, returned
as a readonly view: callers read the exact vector the child received rather than recovering it from the construction log line.

###### Returns

readonly `string`[]

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`commandLine`](process.md#commandline)

##### hasError

###### Get Signature

```ts
get hasError(): boolean;
```

`true` when the abort reason was `HbpuAbortError("failed")`. Covers spawn failures and non-zero natural exits. Derived from `this.signal.reason`; no stored flag.
The value is final by the time any listener on `this.signal` runs, so a consumer's abort handler can read it synchronously rather than waiting on `exited`.

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

##### returnPort

###### Get Signature

```ts
get returnPort(): FfmpegStreamingReturnPort | undefined;
```

The UDP return-port descriptor the health socket is bound to, or `undefined` when no return port was configured. For a specific-port construction
(`init.returnPort.port` non-zero), this descriptor equals `init.returnPort` from the moment the constructor returns; for an ephemeral construction
(`init.returnPort.port === 0`), the `port` field is `0` until the kernel completes the bind, which it does inside the constructor because the health socket
comes from [createDgramSocket](../dgram-util.md#createdgramsocket) and binds to a loopback literal, so the kernel-assigned port reads from the moment construction returns, with no wait on
`ready`.

Returns a fresh descriptor on every read; callers must treat the result as read-only. The `ipFamily` field is the verbatim value passed at construction; the
`port` field reads from the live socket-address projection once captured (specific and ephemeral binds converge on a single read path).

###### Returns

[`FfmpegStreamingReturnPort`](#ffmpegstreamingreturnport) \| `undefined`

The bound return-port descriptor, or `undefined` when no return port was configured.

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
[asyncDispose](): Promise<void>;
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

***

### FfmpegStreamingInit

Construction-time options for [FfmpegStreamingProcess](#ffmpegstreamingprocess).

#### See

FfmpegProcessInit

#### Extends

- [`FfmpegProcessInit`](process.md#ffmpegprocessinit)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="args"></a> `args?` | `string`[] | Optional. FFmpeg command-line arguments. Defaults to an empty array. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`args`](process.md#args) |
| <a id="healthtimeout"></a> `healthTimeout?` | `number` | Optional inactivity window, in milliseconds, between inbound packets on the return port (the HomeKit client's RTCP receiver reports). The watchdog arms on the first such packet, then aborts with `HbpuAbortError("timeout")` if a later window elapses with no packet. Defaults to [STREAM\_HEALTH\_TIMEOUT](settings.md#stream_health_timeout) (5 seconds). This is the watchdog's own cadence, not an FFmpeg input timeout. | - |
| <a id="onfailed"></a> `onFailed?` | (`ending`) => [`FfmpegEndingVerdict`](process-ending.md#ffmpegendingverdict) | Optional. Asked when the process fails: an exit other than with code 0, a spawn failure, or a `"failed"` reason handed in through `abort()` or the parent signal. A failed process that asked for its decoded frames on the GPU and read its hardware decoder's refusal ends at debug ahead of this callback, which it does not ask. On `"handled"` the process logs nothing more for the failure; on `"default"` it logs its summary, its command line and every stderr line at error. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`onFailed`](process.md#onfailed) |
| <a id="ontimeout"></a> `onTimeout?` | (`ending`) => [`FfmpegEndingVerdict`](process-ending.md#ffmpegendingverdict) | Optional. Asked when the process ends with `HbpuAbortError("timeout")` alone, whether a watchdog or the code that aborted the process raised it, and never for a platform `TimeoutError`, which ends at debug. On `"handled"` the process logs nothing more for the timeout; on `"default"` it logs one warning. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`onTimeout`](process.md#ontimeout) |
| <a id="returnport-1"></a> `returnPort?` | [`FfmpegStreamingReturnPort`](#ffmpegstreamingreturnport) | Optional UDP return-port descriptor. When provided, the subclass binds a UDP socket to the port and enforces the liveness watchdog on inbound traffic. Omit for two-way-audio sessions where packet flow is demuxed externally (e.g., via `RtpDemuxer`). | - |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional. Parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the process's internal controller. When the parent aborts, the process tears down. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`signal`](process.md#signal-1) |
| <a id="startuptimeout"></a> `startupTimeout?` | `number` | Optional. If FFmpeg does not produce stderr output within this many milliseconds, the process is aborted with `HbpuAbortError("timeout")`. The window is armed on the options' clock, so a consumer's virtual clock drives it. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`startupTimeout`](process.md#startuptimeout) |

***

### FfmpegStreamingReturnPort

UDP return-port descriptor for the stream-health monitor.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ipfamily"></a> `ipFamily` | [`IpFamily`](../dgram-util.md#ipfamily) | The IP family: `"ipv4"` binds to `127.0.0.1`, `"ipv6"` binds to `::1`. Shares the [IpFamily](../dgram-util.md#ipfamily) alias with `RtpDemuxerInit`, `PortReservationInit`, and `PortReservation` so every UDP-aware init type in the FFmpeg subsystem reads from the same vocabulary. |
| <a id="port"></a> `port` | `number` | The UDP port to bind to. Pass `0` to request kernel-assigned ephemeral allocation: the bind succeeds atomically against whichever port the kernel hands out, eliminating the reserve-then-rebind race that a separate reservation step would carry. The bind completes inside the constructor, so the assigned port is observable via [FfmpegStreamingProcess.returnPort](#returnport) from the moment construction returns. |

***

### StreamingProcess

The minimal surface a streaming consumer reads off a streaming process. This is the product half of the streaming dependency-inversion boundary: a class that runs a
live view depends on this narrow interface rather than the concrete [FfmpegStreamingProcess](#ffmpegstreamingprocess), so a test can substitute a double without spawning FFmpeg. It is
an interface rather than the class because the class's private fields make its type one that only a real subclass, which spawns a child, can satisfy. The interface
is type-only, so importing it costs a consumer nothing at runtime.

Every member is inherited from [FfmpegProcess](process.md#ffmpegprocess), so [FfmpegStreamingProcess](#ffmpegstreamingprocess) satisfies it by inheritance and carries only an `implements` annotation. This
is the consumer's minimal surface rather than the class's full surface: a streaming consumer waits on `ready`, watches `exited` and the lifetime, writes into `stdin`
and reads `stdout`, and ends the process through the signal it passed in its init.

#### See

 - FfmpegStreamingProcess
 - StreamingProcessFactory

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="exited-1"></a> `exited` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates, and rejects with the lifetime's reason only when the child never started. The lifetime has ended by the time any continuation of a settled `exited` runs, so a consumer reads why the process ended from `signal.reason` there. |
| <a id="ready-1"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when the process has produced its first stderr output, and rejects with the lifetime's reason when the lifetime ends first. |
| <a id="signal-2"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing the process's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause. |
| <a id="stdin-1"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input. It stays writable after the lifetime ends until `exited` settles, when it is destroyed, so a writer over it meets the closed stream then. |
| <a id="stdout-1"></a> `stdout` | `readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard output, which ends when the child's output does. |

***

### StreamingProcessFactory

The creational half of the streaming dependency-inversion boundary: build a [StreamingProcess](#streamingprocess) from the shared options and an init. A consumer holds this
factory typed as the abstraction and constructs through it, so a test can substitute a factory that returns a double, and a suite reads the command the consumer
assembled from the init it passed. The production factory is [streamingProcessFactory](#streamingprocessfactory-1), whose `create` is exactly the [FfmpegStreamingProcess](#ffmpegstreamingprocess)
constructor call, so routing construction through this boundary changes no behavior, and a consumer wires it as it wires
[RecordingProcessFactory](record.md#recordingprocessfactory).

A plugin that reports a failed or timed-out ending its own way hands `onFailed` and `onTimeout` in the init, which reaches the process whole, so the factory builds
every streaming process a plugin runs with no subclass of its own.

#### See

 - streamingProcessFactory
 - StreamingProcess

#### Methods

##### create()

```ts
create(options, init): StreamingProcess;
```

Construct a streaming process for the supplied options and init.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init` | [`FfmpegStreamingInit`](#ffmpegstreaminginit) | Init options. See [FfmpegStreamingInit](#ffmpegstreaminginit). |

###### Returns

[`StreamingProcess`](#streamingprocess)

A new [StreamingProcess](#streamingprocess).

***

### streamingProcessFactory

```ts
const streamingProcessFactory: StreamingProcessFactory;
```

The production [StreamingProcessFactory](#streamingprocessfactory): builds the concrete FFmpeg-backed streaming process. A consumer holds this typed as the abstraction; a test
substitutes a fake factory. `create` is exactly the [FfmpegStreamingProcess](#ffmpegstreamingprocess) constructor call, so wiring construction through this boundary changes no behavior.

#### See

StreamingProcessFactory
