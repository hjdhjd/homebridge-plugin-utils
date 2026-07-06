[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/exec

# ffmpeg/exec

One-shot FFmpeg execution with composed signal lifetime.

This module defines `FfmpegExec`, the specialization of [FfmpegProcess](process.md#ffmpegprocess) for the "feed a buffer, collect output, get an exit code" shape. Construction spawns
the child immediately (per the base class's spawn-on-construction contract); the composed `this.signal` governs its lifetime. The class narrows the inherited public
`stdout` to `never` because stdout is drained internally into [FfmpegExec.stdoutBuffer](#stdoutbuffer) and a concurrent external reader would race.

Two usage shapes:

- **Canned input.** Pass `stdin: Buffer` in the init options. The buffer is written to FFmpeg's stdin and the stream is ended on the next microtask after spawn, so
  one-liner callers do not have to touch the stdin stream at all.
- **Streaming input.** Omit the `stdin` init option and use the inherited `stdin` writable directly. Call `exec.stdin.end()` when done.

Both patterns converge on [FfmpegExec.result](#result), which bundles the collected stdout, exit code, exit signal, and accumulated stderr log.

## FFmpeg

### FfmpegExec

One-shot FFmpeg execution. Extends [FfmpegProcess](process.md#ffmpegprocess) directly, inheriting its spawn-on-construction and signal-driven teardown semantics and adding the small
surface that the "feed bytes, read bytes, get exit status" pattern needs.

The public `stdout` type is narrowed to `never` via `declare`. Callers read collected output through [FfmpegExec.stdoutBuffer](#stdoutbuffer) (the raw Buffer) or
[FfmpegExec.result](#result) (the bundled result with exit context). The narrowing is a type-level contract; pure-JS callers that reach past the types still see the
underlying Readable, but a concurrent external reader would race with our internal collector - "do not do that" is the appropriate enforcement bar for a TypeScript
library.

#### Examples

```ts
// Canned input, one-shot.
const exec = new FfmpegExec(options, { args, stdin: inputBuffer, signal });
const { exitCode, stdout } = await exec.result();
```

```ts
// Streaming input - write stdin progressively before awaiting the result.
const exec = new FfmpegExec(options, { args, signal });

exec.stdin.write(chunk1);
exec.stdin.write(chunk2);
exec.stdin.end();

const { exitCode, stdout } = await exec.result();
```

#### See

FfmpegProcess

#### Extends

- [`FfmpegProcess`](process.md#ffmpegprocess)

#### Constructors

##### Constructor

```ts
new FfmpegExec(options, init?): FfmpegExec;
```

Construct and spawn a new FFmpeg execution.

Spawning happens synchronously as part of construction. When `init.stdin` is supplied, the buffer is written to stdin and the stream is ended on the next
microtask, giving synchronous post-construction caller code (e.g., attaching a drain listener) a chance to run before stdin I/O begins.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init` | [`FfmpegExecInit`](#ffmpegexecinit) | Optional init options. See [FfmpegExecInit](#ffmpegexecinit). |

###### Returns

[`FfmpegExec`](#ffmpegexec)

###### Overrides

[`FfmpegProcess`](process.md#ffmpegprocess).[`constructor`](process.md#constructor)

#### Properties

| Property | Modifier | Type | Description | Overrides | Inherited from |
| ------ | ------ | ------ | ------ | ------ | ------ |
| <a id="exited"></a> `exited` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`exited`](process.md#exited) |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason` when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit). | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`ready`](process.md#ready) |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the reason encoded on `signal.reason` names the cause (see [HbpuAbortReason](../util.md#hbpuabortreason)). Subclasses and external callers attach `"abort"` listeners to this signal when they need scope-bound teardown hooks of their own. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`signal`](process.md#signal) |
| <a id="stderr"></a> `stderr` | `readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated [FfmpegProcess.stderrLog](process.md#stderrlog); most callers should prefer `stderrLog` since the class already buffers lines for them. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`stderr`](process.md#stderr) |
| <a id="stdin"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream for the FFmpeg process. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`stdin`](process.md#stdin) |
| <a id="stdout"></a> `stdout` | `readonly` | `never` | stdout is consumed internally by the collector loop. The public type is narrowed to `never` so TypeScript callers cannot accidentally attach a second reader. | [`FfmpegProcess`](process.md#ffmpegprocess).[`stdout`](process.md#stdout) | - |
| <a id="stdoutbuffer"></a> `stdoutBuffer` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\> | Promise that resolves with every byte the child wrote to stdout before its stdout pipe closed. The pipe closes for any reason - natural EOF after a clean exit, abort-driven kill, synthetic stream destroy - and the promise settles the same way: whatever the consumer absorbed before close, byte-for-byte. Resolves with `Buffer.alloc(0)` only when the underlying readable surfaces a stream error (the catch branch in `#collectStdout`); the abort-kill path does not normally produce a stream error, so an aborted run yields whatever bytes happened to arrive before the kill landed - which may be all of them, some of them, or none of them. This promise is the data channel only. To discriminate "the child wrote nothing" from "the run was aborted before the child could write anything," consult [FfmpegExec.exited](process.md#exited) (`exitCode` / `exitSignal`) and [FfmpegProcess.signal](process.md#signal) (`signal.reason`). Those are the single source of truth for process disposition; an empty buffer carries no disposition meaning on its own. | - | - |

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
`AbortSignal.timeout()`. The discrimination lives in [isTimeoutReason](../util.md#istimeoutreason) so this getter stays a one-line delegation and every resource class in the library
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

##### result()

```ts
result(): Promise<ExecResult>;
```

Await the process to completion and return the bundled result.

Resolves once both the stdout collector and the base class's `exited` promise settle. Rejects with the same reason `exited` would reject with (today, only when
the child never spawned - e.g., ENOENT). On any normal exit, including non-zero exit codes, this method resolves; callers discriminate outcomes by inspecting
`exitCode` and `exitSignal` in the result, or the derived `hasError` getter on the instance.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`ExecResult`](#execresult)\>

A promise resolving to an [ExecResult](#execresult) bundling stdout, exit code, exit signal, and the accumulated stderr log.

***

### ExecResult

Structured result returned by [FfmpegExec.result](#result).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="exitcode"></a> `exitCode` | [`Nullable`](../util.md#nullable)\<`number`\> | The process exit code, or `null` when the process was terminated by a signal. |
| <a id="exitsignal"></a> `exitSignal` | [`Nullable`](../util.md#nullable)\<`Signals`\> | The signal name (e.g., `"SIGKILL"`) that terminated the process, or `null` when the process exited normally. |
| <a id="stderrlog-1"></a> `stderrLog` | readonly `string`[] | A snapshot of the accumulated stderr lines at the moment `exited` resolved. Readonly because [FfmpegProcess.stderrLog](process.md#stderrlog) itself is readonly and this bundle is a pass-through view rather than an independent copy. |
| <a id="stdout-1"></a> `stdout` | `Buffer` | The complete stdout bytes collected over the lifetime of the process. |

***

### FfmpegExecInit

Construction-time options for [FfmpegExec](#ffmpegexec).

#### See

FfmpegProcessInit

#### Extends

- [`FfmpegProcessInit`](process.md#ffmpegprocessinit)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="args"></a> `args?` | `string`[] | Optional. FFmpeg command-line arguments. Defaults to an empty array. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`args`](process.md#args) |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional. Parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the process's internal controller. When the parent aborts, the process tears down. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`signal`](process.md#signal-1) |
| <a id="startuptimeout"></a> `startupTimeout?` | `number` | Optional. If FFmpeg does not produce stderr output within this many milliseconds, the process is aborted with `HbpuAbortError("timeout")`. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`startupTimeout`](process.md#startuptimeout) |
| <a id="stdin-1"></a> `stdin?` | `Buffer`\<`ArrayBufferLike`\> | Optional. When provided, the buffer is written to FFmpeg's standard input and the stream is ended on the next microtask after spawn. Covers the overwhelmingly common "feed this buffer, get stdout back" pattern without forcing callers to reach for the streaming-stdin API. Omit to drive stdin manually via the inherited `stdin` writable. | - |
