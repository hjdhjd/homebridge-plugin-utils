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

A consumer that wants its one-shot runs under test constructs them through [ExecProcessFactory](#execprocessfactory) and reads them through [ExecProcess](#execprocess), the exec
dependency-inversion boundary, whose production factory is [execProcessFactory](#execprocessfactory-1) and whose double ships on the testing entry point.

## FFmpeg

### FfmpegExec

One-shot FFmpeg execution. Extends [FfmpegProcess](process.md#ffmpegprocess) directly, inheriting its spawn-on-construction and signal-driven teardown semantics and adding the small
surface that the "feed bytes, read bytes, get exit status" pattern needs.

The public `stdout` type is narrowed to `never` via `declare`. Callers read collected output through [FfmpegExec.stdoutBuffer](#stdoutbuffer) (the raw Buffer) or
[FfmpegExec.result](#result) (the bundled result with exit context). The narrowing is a type-level contract; pure-JS callers that reach past the types still see the
underlying Readable, but a concurrent external reader would race with our internal collector - "do not do that" is the appropriate enforcement bar for a TypeScript
library.

The class satisfies [ExecProcess](#execprocess), and a consumer that substitutes it under test constructs it through an [ExecProcessFactory](#execprocessfactory).

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

#### Implements

- [`ExecProcess`](#execprocess)

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
| `init?` | [`FfmpegExecInit`](#ffmpegexecinit) | Optional init options. See [FfmpegExecInit](#ffmpegexecinit). |

###### Returns

[`FfmpegExec`](#ffmpegexec)

###### Overrides

[`FfmpegProcess`](process.md#ffmpegprocess).[`constructor`](process.md#constructor)

#### Properties

| Property | Modifier | Type | Description | Overrides | Inherited from |
| ------ | ------ | ------ | ------ | ------ | ------ |
| <a id="exited"></a> `exited` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the child's exit code and signal once the process terminates. Rejects with `this.signal.reason` only when the child never started (e.g., the FFmpeg binary could not be located); in every other case it resolves with the actual exit information, even when the abort reason is `"failed"`. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`exited`](process.md#exited) |
| <a id="ready"></a> `ready` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when FFmpeg has produced its first stderr byte - the earliest point at which we can reliably say the child is running. Rejects with `this.signal.reason` when the process aborts before becoming ready (external abort, spawn failure, startup timeout, early natural exit). | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`ready`](process.md#ready) |
| <a id="signal"></a> `signal` | `public readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this process's lifetime. Aborts exactly once when the child exits, the parent signal fires, or `abort()` is called; the reason encoded on `signal.reason` names the cause (see [HbpuAbortReason](../util.md#hbpuabortreason)). Subclasses and external callers attach `"abort"` listeners to this signal when they need scope-bound teardown hooks of their own. | - | [`ExecProcess`](#execprocess).[`signal`](#signal-1) [`FfmpegProcess`](process.md#ffmpegprocess).[`signal`](process.md#signal) |
| <a id="stderr"></a> `stderr` | `public readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | Readable standard error stream. Primarily useful to callers who want to observe stderr in addition to the accumulated [FfmpegProcess.stderrLog](process.md#stderrlog); most callers should prefer `stderrLog` since the class already buffers lines for them. | - | [`FfmpegProcess`](process.md#ffmpegprocess).[`stderr`](process.md#stderr) |
| <a id="stdin"></a> `stdin` | `public readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input stream for the FFmpeg process. | - | [`ExecProcess`](#execprocess).[`stdin`](#stdin-1) [`FfmpegProcess`](process.md#ffmpegprocess).[`stdin`](process.md#stdin) |
| <a id="stdout"></a> `stdout` | `public readonly` | `never` | stdout is consumed internally by the collector loop. The public type is narrowed to `never` so TypeScript callers cannot accidentally attach a second reader. | [`FfmpegProcess`](process.md#ffmpegprocess).[`stdout`](process.md#stdout) | - |
| <a id="stdoutbuffer"></a> `stdoutBuffer` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Buffer`\<`ArrayBufferLike`\>\> | Promise that resolves with every byte the child wrote to stdout before its stdout pipe closed. The pipe closes for any reason - natural EOF after a clean exit, abort-driven kill, synthetic stream destroy - and the promise settles the same way: whatever the consumer absorbed before close, byte-for-byte. Resolves with `Buffer.alloc(0)` only when the underlying readable surfaces a stream error (the catch branch in `#collectStdout`); the abort-kill path does not normally produce a stream error, so an aborted run yields whatever bytes happened to arrive before the kill landed - which may be all of them, some of them, or none of them. This promise is the data channel only. To distinguish "the child wrote nothing" from "the run was aborted before the child could write anything," consult [FfmpegExec.exited](process.md#exited) (`exitCode` / `exitSignal`) and [FfmpegProcess.signal](process.md#signal) (`signal.reason`). Those are the single source of truth for process disposition; an empty buffer carries no disposition meaning on its own. | - | - |

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

##### result()

```ts
result(): Promise<ExecResult>;
```

Await the process to completion and return the bundled result.

Resolves once the stdout collector and the base class's `exited` promise have settled. Rejects with the reason `exited` rejects with, which it does only when
the child never spawned (e.g., ENOENT). On any normal exit, including non-zero exit codes, this method resolves; callers distinguish outcomes by inspecting
`exitCode` and `exitSignal` in the result, or the derived `hasError` getter on the instance.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`ExecResult`](#execresult)\>

A promise resolving to an [ExecResult](#execresult) bundling stdout, exit code, exit signal, and the accumulated stderr log.

###### Implementation of

[`ExecProcess`](#execprocess).[`result`](#result-1)

***

### ExecProcess

The surface a one-shot consumer reads off an FFmpeg run, the contract each usage shape converges on. This is the product half of the exec dependency-inversion
boundary: a class that runs FFmpeg once depends on this narrow interface rather than the concrete [FfmpegExec](#ffmpegexec), so a test can substitute a double without
spawning FFmpeg. It is an interface rather than the class because the class's private fields make its type one that only a real subclass, which spawns a child, can
satisfy. The interface is type-only, so importing it costs a consumer nothing at runtime.

[FfmpegExec](#ffmpegexec) satisfies it with its own and inherited members and carries only an `implements` annotation. A consumer feeds `stdin`, or hands a canned buffer
in its init, reads the run through `result()`, and ends it through the signal it passed in its init.

#### See

 - FfmpegExec
 - ExecProcessFactory

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal-1"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing the run's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause. |
| <a id="stdin-1"></a> `stdin` | `readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | Writable standard input. A canned `stdin` buffer in the init is written to it and the stream ended on the next microtask, unless the lifetime has ended by then; otherwise the consumer writes and ends it. |

#### Methods

##### result()

```ts
result(): Promise<ExecResult>;
```

Resolves with the run's exit code, exit signal, stdout bytes and stderr lines once the child has exited, whatever its exit code, and rejects with the lifetime's
reason only when the child never started.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`ExecResult`](#execresult)\>

A promise resolving to the run's [ExecResult](#execresult).

***

### ExecProcessFactory

The creational half of the exec dependency-inversion boundary: build an [ExecProcess](#execprocess) from the shared options and an optional init. A consumer holds this
factory typed as the abstraction and constructs through it, so a test can substitute a factory that returns a double, and a suite reads the command the consumer
assembled from the init it passed. The production factory is [execProcessFactory](#execprocessfactory-1), whose `create` is exactly the [FfmpegExec](#ffmpegexec) constructor call, so
routing construction through this boundary changes no behavior.

#### See

 - execProcessFactory
 - ExecProcess

#### Methods

##### create()

```ts
create(options, init?): ExecProcess;
```

Construct and spawn a one-shot FFmpeg run for the supplied options and init.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | Shared [FfmpegOptions](options.md#ffmpegoptions) configuration (codec support, logger, debug flag, name). |
| `init?` | [`FfmpegExecInit`](#ffmpegexecinit) | Optional init options. See [FfmpegExecInit](#ffmpegexecinit). |

###### Returns

[`ExecProcess`](#execprocess)

A new [ExecProcess](#execprocess).

***

### ExecResult

Structured result returned by [FfmpegExec.result](#result).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="exitcode"></a> `exitCode` | [`Nullable`](../util.md#nullable)\<`number`\> | The process exit code, or `null` when the process was terminated by a signal. |
| <a id="exitsignal"></a> `exitSignal` | [`Nullable`](../util.md#nullable)\<`Signals`\> | The signal name (e.g., `"SIGKILL"`) that terminated the process, or `null` when the process exited normally. |
| <a id="stderrlog-1"></a> `stderrLog` | readonly `string`[] | The process's own readonly array of the stderr lines it accumulated, complete because the child has exited. |
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
| <a id="onfailed"></a> `onFailed?` | (`ending`) => [`FfmpegEndingVerdict`](process-ending.md#ffmpegendingverdict) | Optional. Asked when the process fails: an exit other than with code 0, a spawn failure, or a `"failed"` reason handed in through `abort()` or the parent signal. A failed process that asked for its decoded frames on the GPU and read its hardware decoder's refusal ends at debug ahead of this callback, which it does not ask. On `"handled"` the process logs nothing more for the failure; on `"default"` it logs its summary, its command line and every stderr line at error. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`onFailed`](process.md#onfailed) |
| <a id="ontimeout"></a> `onTimeout?` | (`ending`) => [`FfmpegEndingVerdict`](process-ending.md#ffmpegendingverdict) | Optional. Asked when the process ends with `HbpuAbortError("timeout")` alone, whether a watchdog or the code that aborted the process raised it, and never for a platform `TimeoutError`, which ends at debug. On `"handled"` the process logs nothing more for the timeout; on `"default"` it logs one warning. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`onTimeout`](process.md#ontimeout) |
| <a id="signal-2"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional. Parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the process's internal controller. When the parent aborts, the process tears down. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`signal`](process.md#signal-1) |
| <a id="startuptimeout"></a> `startupTimeout?` | `number` | Optional. If FFmpeg does not produce stderr output within this many milliseconds, the process is aborted with `HbpuAbortError("timeout")`. The window is armed on the options' clock, so a consumer's virtual clock drives it. | [`FfmpegProcessInit`](process.md#ffmpegprocessinit).[`startupTimeout`](process.md#startuptimeout) |
| <a id="stdin-2"></a> `stdin?` | `Buffer`\<`ArrayBufferLike`\> | Optional. When provided, the buffer is written to FFmpeg's standard input and the stream is ended on the next microtask after spawn. Covers the overwhelmingly common "feed this buffer, get stdout back" pattern without forcing callers to reach for the streaming-stdin API. Omit to drive stdin manually via the inherited `stdin` writable. | - |

***

### execProcessFactory

```ts
const execProcessFactory: ExecProcessFactory;
```

The production [ExecProcessFactory](#execprocessfactory): builds the concrete FFmpeg-backed one-shot run. A consumer holds this typed as the abstraction; a test substitutes a fake
factory. `create` is exactly the [FfmpegExec](#ffmpegexec) constructor call, so wiring construction through this boundary changes no behavior.

#### See

ExecProcessFactory
