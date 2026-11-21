[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/streaming-process-double

# ffmpeg/streaming-process-double

An FFmpeg-free [StreamingProcess](stream.md#streamingprocess) test double.

A class that runs a live view has its hard cases in the order a process's events arrive: an abort that lands before the process is ready, a child that exits on its
own while the class still writes into it, a spawn that fails before anything is written. This module ships the double for those - a [TestStreamingProcess](#teststreamingprocess) a
test drives one event at a time, with no child process anywhere in sight - and a [TestStreamingProcessFactory](#teststreamingprocessfactory) that builds one per `create` from the init the
consumer passed and records that init, so a suite reads the command the consumer assembled from the recorded `args`.

The double settles its promises and ends its lifetime as the real process does: `ready` and `exited` are marked handled, `ready` rejects with the lifetime's reason
when the lifetime ends while it is pending, an exit resolves `exited` and ends the lifetime in one step, and `stdin` and `stdout` close as `exited` settles. The
levers refuse an event no real process produces rather than modeling it. A failed or timed-out ending asks the `onFailed` or `onTimeout` callback the consumer
handed in its init, inside the abort that ends the lifetime, so a plugin's suite drives its own ending callbacks through the double. Stderr lines a suite sets
that report the hardware decoder's refusal mark the options the double was handed, and a refused GPU decode asks no callback, as on the real process.

Signatures come from the process's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
compiler saying so. Which line marks the refusal and which callback an ending asks come from `process-ending.ts`, the transport-free rules the real process reads
and asks through as well, so the two cannot disagree about them and loading the double loads none of the process's spawn machinery.

## Testing

### TestStreamingProcess

A driven, FFmpeg-free [StreamingProcess](stream.md#streamingprocess) double: its child becomes ready, writes to stdout, exits or fails to spawn when a test says so, and it records what a
consumer writes to stdin.

The lifetime is the parent signal the constructor receives composed with the double's own. The parent aborting ends it with the parent's reason, an exit before
any abort ends it as `"closed"` for an exit code of 0 and `"failed"` otherwise, and a spawn failure before any abort ends it as `"failed"` with the spawn's error as
its cause; whichever comes first stands. `stdin` and `stdout` stay open across an abort and close as `exited` settles, by an exit or a spawn failure, so a writer
over `stdin` meets the closed stream at the exit, as it does over a real child's.

The lifetime's end asks the init's ending callbacks as the real process's teardown does: `HbpuAbortError("failed")` asks `onFailed` and
`HbpuAbortError("timeout")` asks `onTimeout`, each handed the reason and the lines [TestStreamingProcess.stderrLog](#stderrlog) holds at that moment, synchronously inside
the abort, after `ready` rejects and before any abort listener a consumer added to the double's own `signal`, or inside the constructor when the parent signal has
already aborted. A listener on the parent signal the consumer passed in runs first, as it does on the real process. Any other ending asks neither. Nor does a
refused GPU decode: a failed ending of a double whose own stderr lines reported the hardware decoder's refusal and whose init's `args` ask for its decoded frames
on the GPU.

The stderr lines a suite sets are read for the hardware decoder's refusal as the real process reads the lines its child writes: the first line that carries it
marks the options the double was handed, at once and whether or not the double then fails, and no line is read after it, in that set or a later one. Setting
lines also shows the child has spawned and, while the lifetime is live, resolves a pending `ready`, as the real process's first stderr output does, so
[TestStreamingProcess.resolveReady](#resolveready) after them is refused as it is after a first pull.

Where it differs from the real process:

- An abort kills a real child, which then exits on its own, while the double has no child to kill, so after an abort its `exited` waits for
  [TestStreamingProcess.exit](#exit) or [TestStreamingProcess.failSpawn](#failspawn). A test that stands in for a killed child pulls the exit lever with the exit a killed
  child reports, `{ exitCode: null, exitSignal: "SIGKILL" }`.
- It logs nothing, so a callback's `"default"` reports nothing and a refused GPU decode logs no debug line, where the real process logs its report and that line.
- A double built without options marks nothing when its lines report the refusal, where the real process always holds the options it marks.
- It reads every line it is handed for the refusal, where the real process leaves unread the last line its child wrote with no line break, which it adds to its
  log at the exit.
- It does not catch a callback's throw, which therefore leaves the constructor, and so `create()`, under a parent signal already aborted, and reaches Node's
  uncaught-exception path under any later abort, where the real process logs it at error and runs its default report. A suite sees the bug in its own callback.
- It has no lever for the real process's own watchdogs or its return-port socket, so a suite reaches `onTimeout` by aborting the parent signal with
  `HbpuAbortError("timeout")`.

#### Example

```ts
import { TestStreamingProcessFactory, expectAt } from "homebridge-plugin-utils/testing";

const factory = new TestStreamingProcessFactory();
const session = new LiveViewSession({ processFactory: factory, signal: controller.signal });
const call = expectAt(factory.createCalls, 0, "the streaming process the session built");

// The command the session assembled, read without spawning anything, then the session's own readiness wait, ending callback and exit handling, exercised with
// no FFmpeg at all.
assert.ok(call.init.args?.includes("-re"));
call.process.resolveReady();
call.process.stderrLog = ["An invented stderr line the session's onFailed reads."];
call.process.exit({ exitCode: 1, exitSignal: null });
```

#### See

TestStreamingProcessFactory

#### Implements

- [`StreamingProcess`](stream.md#streamingprocess)

#### Constructors

##### Constructor

```ts
new TestStreamingProcess(init?, options?): TestStreamingProcess;
```

Construct a double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | `Pick`\<[`FfmpegStreamingInit`](stream.md#ffmpegstreaminginit), `"args"` \| `"onFailed"` \| `"onTimeout"` \| `"signal"`\> | Optional init options: the members of a consumer's [FfmpegStreamingInit](stream.md#ffmpegstreaminginit) the double reads. |
| `options?` | [`FfmpegOptions`](options.md#ffmpegoptions) | Optional. The [FfmpegOptions](options.md#ffmpegoptions) a line reporting the hardware decoder's refusal marks, as the real process marks the options it was built over. A double built without them marks nothing. |

###### Returns

[`TestStreamingProcess`](#teststreamingprocess)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="exited"></a> `exited` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo)\> | Resolves with the exit information [TestStreamingProcess.exit](#exit) was handed, and rejects with the lifetime's reason when [TestStreamingProcess.failSpawn](#failspawn) was pulled instead. Marked handled, as the real process's is. |
| <a id="ready"></a> `ready` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when [TestStreamingProcess.resolveReady](#resolveready) is pulled or stderr lines are first set, whichever comes first, as the real process's resolves on its child's first stderr output, and rejects with the lifetime's reason when the lifetime ends while it is pending. Marked handled, as the real process's is. |
| <a id="signal"></a> `signal` | `public readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal representing this double's lifetime, composed from the parent signal the constructor received and this double's own, as the real process composes its parent with its own. |
| <a id="stdin"></a> `stdin` | `public readonly` | [`Writable`](https://nodejs.org/api/stream.html#class-streamwritable) | A writable that records every chunk written to it in [TestStreamingProcess.stdinWrites](#stdinwrites). It stays writable after the lifetime ends and is destroyed as `exited` settles. |
| <a id="stdout"></a> `stdout` | `public readonly` | [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) | A readable carrying the bytes [TestStreamingProcess.writeStdout](#writestdout) was handed, in order, which ends as `exited` settles. |

#### Accessors

##### stderrLog

###### Get Signature

```ts
get stderrLog(): readonly string[];
```

The stderr lines the stood-in child has written, in place of the log a real child's stderr fills. A suite sets them before it drives an ending, because a failed
or timed-out ending hands its callback the lines this holds at that moment. Setting lines shows the child has spawned, so [TestStreamingProcess.failSpawn](#failspawn)
is refused after it, resolves a pending `ready` while the lifetime is live, so [TestStreamingProcess.resolveReady](#resolveready) is refused after it too, and reads them
for the hardware decoder's refusal until one carries it, marking the options the double was handed. Empty until a suite sets them.

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

Every chunk written to [TestStreamingProcess.stdin](#stdin), in the order written: the bytes a consumer fed the process.

###### Returns

readonly `Buffer`\<`ArrayBufferLike`\>[]

#### Methods

##### exit()

```ts
exit(info): void;
```

Exit the child, as a real child's exit does: `stdin` and `stdout` close, `exited` resolves with the exit information, and in the same step the lifetime ends with
`HbpuAbortError("closed")` for an exit code of 0 and `HbpuAbortError("failed")` otherwise, each carrying the exit information as its cause, unless the lifetime has
already ended, in which case its reason stands. The reason is therefore final before any continuation of `exited` runs, and a pending `ready` rejects with it.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `info` | [`FfmpegProcessExitInfo`](process.md#ffmpegprocessexitinfo) | The exit code and signal the child exits with. |

###### Returns

`void`

###### Throws

An `Error` once `exited` has settled, by an earlier exit or a spawn failure.

##### failSpawn()

```ts
failSpawn(cause): void;
```

Fail the spawn, as a real process whose binary cannot be started does: `stdin` and `stdout` close, the lifetime ends with `HbpuAbortError("failed")` carrying
`cause` unless it has already ended, in which case its reason stands, and `ready` and `exited` reject with the lifetime's reason.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `cause` | `Error` | The error the spawn failed with. |

###### Returns

`void`

###### Throws

An `Error` once the child has shown it spawned, by resolving ready, writing to stdout or having stderr lines set, and once `exited` has settled, because
        a spawn fails before any of those.

##### resolveReady()

```ts
resolveReady(): void;
```

Resolve `ready`, as a real process's first stderr output does. Setting [TestStreamingProcess.stderrLog](#stderrlog) while `ready` is pending resolves it as well, and
this lever is refused from then on.

###### Returns

`void`

###### Throws

The lifetime's reason once the lifetime has ended, and an `Error` when `ready` has already resolved, by this lever or by stderr lines.

##### writeStdout()

```ts
writeStdout(bytes): void;
```

Write bytes to `stdout`, as a real child's output does. Allowed between an abort and the exit, because a killed child's pipe carries what it wrote until it exits.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `bytes` | `Buffer` | The bytes the child writes. |

###### Returns

`void`

###### Throws

An `Error` once `exited` has settled, because `stdout` has ended.

***

### TestStreamingProcessFactory

A [StreamingProcessFactory](stream.md#streamingprocessfactory) double that records every `create` call and answers a fresh [TestStreamingProcess](#teststreamingprocess) over the options and the init the consumer
passed: the init's `signal` is the double's parent signal, so the consumer's own signal ends the process it gets back as it ends a real one, the init's `onFailed`
and `onTimeout` are the callbacks the double asks at its ending, its `args` decide whether a refused GPU decode asks neither, and the options are the ones a line
reporting the hardware decoder's refusal marks. A test reads the recorded init for the command the consumer assembled and the recorded process to drive it. There is
no form that hands back a process built ahead of the call, because such a process could neither hear the signal, ask the callbacks nor mark the options the
consumer passes to `create`.

#### See

 - StreamingProcessFactory
 - TestStreamingProcess

#### Implements

- [`StreamingProcessFactory`](stream.md#streamingprocessfactory)

#### Constructors

##### Constructor

```ts
new TestStreamingProcessFactory(): TestStreamingProcessFactory;
```

###### Returns

[`TestStreamingProcessFactory`](#teststreamingprocessfactory)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="createcalls"></a> `createCalls` | `public readonly` | \{ `init`: [`FfmpegStreamingInit`](stream.md#ffmpegstreaminginit); `options`: [`FfmpegOptions`](options.md#ffmpegoptions); `process`: [`TestStreamingProcess`](#teststreamingprocess); \}[] | `[]` | Every create call's options and init and the process it answered, in order, so a test can assert the boundary was reached with what it expected and can drive the process that came back. |

#### Methods

##### create()

```ts
create(options, init): StreamingProcess;
```

Record the create call and answer a fresh double over the options and the init's args, signal and ending callbacks.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | The [FfmpegOptions](options.md#ffmpegoptions) the consumer passed, which a line reporting the hardware decoder's refusal marks. |
| `init` | [`FfmpegStreamingInit`](stream.md#ffmpegstreaminginit) | The init the consumer passed. |

###### Returns

[`StreamingProcess`](stream.md#streamingprocess)

The streaming-process double.

###### Implementation of

[`StreamingProcessFactory`](stream.md#streamingprocessfactory).[`create`](stream.md#create)
