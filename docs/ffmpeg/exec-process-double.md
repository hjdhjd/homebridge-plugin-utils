[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/exec-process-double

# ffmpeg/exec-process-double

An FFmpeg-free [ExecProcess](exec.md#execprocess) test double.

A class that runs FFmpeg once has its hard cases in how the run ends: a clean exit with output to read, a failed exit whose stderr lines it reports, a spawn that
fails, a run its own signal ends. This module ships the double for those - a [TestExecProcess](#testexecprocess) a test drives one event at a time, with no child process
anywhere in sight - and a [TestExecProcessFactory](#testexecprocessfactory) that builds one per `create` from the options and init the consumer passed and records them, so a suite
reads the command the consumer assembled from the recorded `args`.

The double holds a [TestStreamingProcess](streaming-process-double.md#teststreamingprocess) as the child it stands in for and adds no state machine of its own: its lifetime, its `stdin`, its levers, its
ending callbacks and its reading of the hardware decoder's refusal are the streaming double's, which settles, ends and marks as a real process does, and the
double adds only what a one-shot run adds over a streaming one, the collected stdout, the canned stdin and `result()`.

Signatures come from the run's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
compiler saying so, and loading the double loads none of the run's spawn machinery.

## Testing

### TestExecProcess

A driven, FFmpeg-free [ExecProcess](exec.md#execprocess) double: its child writes to stdout, exits or fails to spawn when a test says so, it records what a consumer writes to
stdin, and `result()` settles as the real run's does.

The child is a [TestStreamingProcess](streaming-process-double.md#teststreamingprocess) built from the init and the options, so the lifetime is the init's signal composed with the child's own, an exit ends
it as `"closed"` for an exit code of 0 and `"failed"` otherwise, a spawn failure ends it as `"failed"` with the spawn's error as its cause, a failed or timed-out
ending asks the init's `onFailed` or `onTimeout` with the lines [TestExecProcess.stderrLog](#stderrlog) holds at that moment, a line reporting the hardware decoder's
refusal marks the options, and a refused GPU decode asks no callback, each as the streaming double states it. `result()` resolves with the exit information,
every byte the child wrote to stdout and the lines `stderrLog` holds once the child has exited, and rejects with the lifetime's reason when the spawn fails. A
canned `stdin` buffer in the init is written and `stdin` ended on the next microtask, unless the lifetime has ended by then, as the real run's is.

Where it differs from the real run:

- An abort kills a real child, which then exits on its own, while the double has no child to kill, so after an abort `result()` waits for
  [TestExecProcess.exit](#exit), as a killed child's exit would end it. A test that stands in for a killed child pulls the exit lever with the exit a killed child
  reports, `{ exitCode: null, exitSignal: "SIGKILL" }`.
- A double built without options marks nothing when its lines report the refusal, and it reads every line it is handed, where the real run leaves unread the
  last line its child wrote with no line break, as the streaming double states.
- A second end of `stdin` that carries bytes reaches Node's uncaught-exception path as a write after the end, where the real run logs it.
- It logs nothing, a refused GPU decode's debug line among it.
- It does not catch a callback's throw, which therefore leaves the constructor, and so `create()`, under a parent signal already aborted, and reaches Node's
  uncaught-exception path under any later abort, where the real run logs it at error and runs its default report, as the streaming double states.
- It has no lever for the real run's startup timeout, so a suite reaches `onTimeout` by aborting the parent signal with `HbpuAbortError("timeout")`.

#### Example

```ts
import { TestExecProcessFactory, expectAt } from "homebridge-plugin-utils/testing";

const factory = new TestExecProcessFactory();
const snapshot = new SnapshotGrabber({ execFactory: factory, signal: controller.signal });
const pending = snapshot.grab();
const call = expectAt(factory.createCalls, 0, "the run the grabber started");

// The command the grabber assembled, read without spawning anything, then the run's output and exit, exercised with no FFmpeg at all.
assert.ok(call.init.args?.includes("-frames:v"));
call.process.writeStdout(Buffer.from("invented image bytes"));
call.process.exit({ exitCode: 0, exitSignal: null });
await pending;
```

#### See

TestExecProcessFactory

#### Implements

- [`ExecProcess`](exec.md#execprocess)

#### Constructors

##### Constructor

```ts
new TestExecProcess(init?, options?): TestExecProcess;
```

Construct a double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | `Pick`\<[`FfmpegExecInit`](exec.md#ffmpegexecinit), `"args"` \| `"onFailed"` \| `"onTimeout"` \| `"signal"` \| `"stdin"`\> | Optional init options: the members of a consumer's [FfmpegExecInit](exec.md#ffmpegexecinit) the double reads. |
| `options?` | [`FfmpegOptions`](options.md#ffmpegoptions) | Optional. The [FfmpegOptions](options.md#ffmpegoptions) a line reporting the hardware decoder's refusal marks, handed to the child. A double built without them marks nothing. |

###### Returns

[`TestExecProcess`](#testexecprocess)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `public readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal representing this double's lifetime: the child's, composed from the init's signal and the child's own, as the real run composes its parent with its own. |
| <a id="stdin"></a> `stdin` | `public readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | The child's `stdin`, which records every chunk written to it in [TestExecProcess.stdinWrites](#stdinwrites). It stays writable after the lifetime ends and is destroyed as the child exits or fails to spawn. |

#### Accessors

##### stderrLog

###### Get Signature

```ts
get stderrLog(): readonly string[];
```

The stderr lines the stood-in child has written, held by the child. A suite sets them before it drives an ending, because a failed or timed-out ending hands its
callback the lines this holds at that moment, and `result()` carries the lines it holds once the child has exited. Setting lines shows the child has spawned and
reads them for the hardware decoder's refusal, as [TestStreamingProcess.stderrLog](streaming-process-double.md#stderrlog) states. Empty until a suite sets them.

###### Returns

readonly `string`[]

###### Set Signature

```ts
set stderrLog(lines): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `lines` | readonly `string`[] |

###### Returns

`void`

##### stdinWrites

###### Get Signature

```ts
get stdinWrites(): readonly Buffer<ArrayBufferLike>[];
```

Every chunk written to [TestExecProcess.stdin](#stdin), in the order written, the canned buffer among them: the bytes a consumer fed the run.

###### Returns

readonly `Buffer`\<`ArrayBufferLike`\>[]

#### Methods

##### exit()

```ts
exit(info): void;
```

Exit the child, as a real child's exit does. See [TestStreamingProcess.exit](streaming-process-double.md#exit).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `info` | [`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo) | The exit code and signal the child exits with. |

###### Returns

`void`

###### Throws

An `Error` once the child has exited or failed to spawn.

##### failSpawn()

```ts
failSpawn(cause): void;
```

Fail the spawn, as a real run whose binary cannot be started does. See [TestStreamingProcess.failSpawn](streaming-process-double.md#failspawn).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `cause` | `Error` | The error the spawn failed with. |

###### Returns

`void`

###### Throws

An `Error` once the child has written to stdout or had stderr lines set, and once it has exited or failed to spawn.

##### result()

```ts
result(): Promise<ExecResult>;
```

Await the child's exit and answer the bundled result, as the real run's `result()` does: the exit information, every byte the child wrote to stdout and the lines
[TestExecProcess.stderrLog](#stderrlog) holds. A repeated call answers the same bytes.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`ExecResult`](exec.md#execresult)\>

A promise resolving to the run's [ExecResult](exec.md#execresult), and rejecting with the lifetime's reason when the spawn failed.

###### Implementation of

[`ExecProcess`](exec.md#execprocess).[`result`](exec.md#result-1)

##### writeStdout()

```ts
writeStdout(bytes): void;
```

Write bytes to the child's stdout, as a real child's output does. See [TestStreamingProcess.writeStdout](streaming-process-double.md#writestdout).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `bytes` | `Buffer` | The bytes the child writes. |

###### Returns

`void`

###### Throws

An `Error` once the child has exited or failed to spawn.

***

### TestExecProcessFactory

An [ExecProcessFactory](exec.md#execprocessfactory) double that records every `create` call and answers a fresh [TestExecProcess](#testexecprocess) over the options and the init the consumer
passed: the init's `signal` is the double's parent signal, so the consumer's own signal ends the run it gets back as it ends a real one, the init's `onFailed` and
`onTimeout` are the callbacks the double's child asks at its ending, its `args` decide whether a refused GPU decode asks neither, its `stdin` is the canned buffer
the double feeds itself, and the options are the ones a line reporting the hardware decoder's refusal marks. A test reads the recorded init for the command the
consumer assembled and the recorded process to drive it.

#### See

 - ExecProcessFactory
 - TestExecProcess

#### Implements

- [`ExecProcessFactory`](exec.md#execprocessfactory)

#### Constructors

##### Constructor

```ts
new TestExecProcessFactory(): TestExecProcessFactory;
```

###### Returns

[`TestExecProcessFactory`](#testexecprocessfactory)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="createcalls"></a> `createCalls` | `public readonly` | \{ `init`: [`FfmpegExecInit`](exec.md#ffmpegexecinit); `options`: [`FfmpegOptions`](options.md#ffmpegoptions); `process`: [`TestExecProcess`](#testexecprocess); \}[] | `[]` | Every create call's options and init and the process it answered, in order, an omitted init recorded as an empty one, as the real run's constructor reads it, so a test can assert the boundary was reached with what it expected and can drive the process that came back. |

#### Methods

##### create()

```ts
create(options, init?): ExecProcess;
```

Record the create call and answer a fresh double over the options and the init's args, signal, ending callbacks and canned stdin.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | The [FfmpegOptions](options.md#ffmpegoptions) the consumer passed, which a line reporting the hardware decoder's refusal marks. |
| `init?` | [`FfmpegExecInit`](exec.md#ffmpegexecinit) | The init the consumer passed, an empty one when it passed none. |

###### Returns

[`ExecProcess`](exec.md#execprocess)

The exec-process double.

###### Implementation of

[`ExecProcessFactory`](exec.md#execprocessfactory).[`create`](exec.md#create)
