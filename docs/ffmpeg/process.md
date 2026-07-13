[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/process

# ffmpeg/process

FFmpeg process management with AbortSignal-based lifecycle.

This module defines the `FfmpegProcess` base class, the foundation every other FFmpeg class in `homebridge-plugin-utils` builds on. Construction spawns the child; the
composed [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) exposed as `this.signal` is the single source of truth for the process's lifetime. Every teardown path - external `abort()`, parent
signal aborting, natural exit, spawn failure, optional startup timeout - converges on the same signal.

The class is an [AsyncDisposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose) so callers can manage the process with `await using` for scope-bound lifetimes. It is intentionally not an `EventEmitter`:
ready/exit are [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)s, stderr accumulates to [FfmpegProcess.stderrLog](#stderrlog), and fine-grained termination hooks are registered against `this.signal`.

Key features:

- Spawn-on-construction. No `start()` step, no configure-then-run.
- [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)-driven teardown. Node's native `spawn({ signal, killSignal })` owns the kill path; no manual SIGKILL fallback timer.
- `ready` promise resolves when FFmpeg produces its first stderr byte (the earliest reliable "we are actually running" signal).
- `exited` promise resolves with the child's exit code and signal once it terminates. Rejects with `signal.reason` only when the child never started (e.g., `ENOENT`).
- Reason-based teardown logging: `"failed"` dumps stderr at ERROR, `"timeout"` logs at WARN, other reasons log at DEBUG.

## FFmpeg

### FfmpegProcess

Base class providing FFmpeg process management with signal-driven lifecycle.

Construction spawns the child immediately. The composed `this.signal` is the single source of truth for the process's lifetime: external `abort()`, a parent signal
firing, a non-zero exit, a spawn failure, and (optionally) a startup-timeout all converge on the same signal. Subclasses register additional `"abort"` listeners on
`this.signal` rather than overriding `abort()` or `[Symbol.asyncDispose]`.

#### Examples

```ts
// Scope-bound: the child is guaranteed to be torn down when the block exits, regardless of success or exception.
await using proc = new FfmpegProcess(options, { args: [ "-i", "input.mp4", "-f", "null", "-" ] });

await proc.ready;
const { exitCode } = await proc.exited;
```

```ts
// Signal-driven: parent controls teardown through its own AbortController.
const controller = new AbortController();
const proc = new FfmpegProcess(options, { args, signal: controller.signal });

// Later, from anywhere with the controller:
controller.abort();
```

#### See

 - [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
 - [Node.js child\_process.spawn](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)
 - FfmpegOptions

#### Extended by

- [`FfmpegExec`](exec.md#ffmpegexec)
- [`FfmpegFMp4Process`](record.md#abstract-ffmpegfmp4process)
- [`FfmpegStreamingProcess`](stream.md#ffmpegstreamingprocess)

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new FfmpegProcess(options, init?): FfmpegProcess;
```

Construct and spawn a new FFmpeg process.

Spawning happens synchronously as part of construction: by the time the constructor returns, the child is already running (or has already scheduled its `"error"`
event for a spawn failure). There is no separate `start()` step.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init` | [`FfmpegProcessInit`](#ffmpegprocessinit) | Optional init options. See [FfmpegProcessInit](#ffmpegprocessinit). |

###### Returns

[`FfmpegProcess`](#ffmpegprocess)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="exited"></a> `exited` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`. |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason` when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit). |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the reason encoded on `signal.reason` names the cause (see [HbpuAbortReason](../util.md#hbpuabortreason)). Subclasses and external callers attach `"abort"` listeners to this signal when they need scope-bound teardown hooks of their own. |
| <a id="stderr"></a> `stderr` | `readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated [FfmpegProcess.stderrLog](#stderrlog); most callers should prefer `stderrLog` since the class already buffers lines for them. |
| <a id="stdin"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream for the FFmpeg process. |
| <a id="stdout"></a> `stdout` | `readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard output stream. Subclasses that consume this stream internally narrow the public type to `never` via `declare`. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

##### hasError

###### Get Signature

```ts
get hasError(): boolean;
```

`true` when the abort reason was `HbpuAbortError("failed")`. Covers spawn failures and non-zero natural exits. Derived from `this.signal.reason`; no stored flag.

###### Returns

`boolean`

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

##### stderrLog

###### Get Signature

```ts
get stderrLog(): readonly string[];
```

The accumulated stderr lines this process has produced, preserved across teardown for post-mortem inspection. The array is returned as a readonly view to make the
intent explicit: callers read from it, they do not mutate it.

###### Returns

readonly `string`[]

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

###### Implementation of

```ts
AsyncDisposable.[asyncDispose]
```

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

***

### FfmpegProcessExitInfo

Structured exit information surfaced through [FfmpegProcess.exited](#exited).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="exitcode"></a> `exitCode` | [`Nullable`](../util.md#nullable)\<`number`\> | The process exit code, or `null` when the process was terminated by a signal. |
| <a id="exitsignal"></a> `exitSignal` | [`Nullable`](../util.md#nullable)\<`Signals`\> | The signal name (e.g., `"SIGKILL"`) that terminated the process, or `null` when the process exited normally. |

***

### FfmpegProcessInit

Construction-time options for [FfmpegProcess](#ffmpegprocess).

#### Extended by

- [`FfmpegExecInit`](exec.md#ffmpegexecinit)
- [`FfmpegRecordingInit`](record.md#ffmpegrecordinginit)
- [`FfmpegLivestreamInit`](record.md#ffmpeglivestreaminit)
- [`FfmpegStreamingInit`](stream.md#ffmpegstreaminginit)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="args"></a> `args?` | `string`[] | Optional. FFmpeg command-line arguments. Defaults to an empty array. |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional. Parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the process's internal controller. When the parent aborts, the process tears down. |
| <a id="startuptimeout"></a> `startupTimeout?` | `number` | Optional. If FFmpeg does not produce stderr output within this many milliseconds, the process is aborted with `HbpuAbortError("timeout")`. |
