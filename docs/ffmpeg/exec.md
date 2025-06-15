[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/exec

# ffmpeg/exec

Executes arbitrary FFmpeg commands and returns the results.

This module exposes the `FfmpegExec` class, which extends the core process handling of FFmpeg to support running custom command-line operations. It enables developers
to run FFmpeg commands from Node.js, capture both standard output and error streams, handle process exit codes, and optionally supply input via stdin.

Intended for plugin developers and advanced users, this module is ideal for scenarios where you need direct control over FFmpeg execution—such as probing media,
transcoding, or automation tasks—while still benefiting from structured result handling and robust error logging.

Key features:

- Execute any FFmpeg command with custom arguments.
- Capture stdout, stderr, and exit codes as structured results.
- Optional stdin data injection.
- Configurable error logging.

## FFmpeg

### FfmpegExec

Executes arbitrary FFmpeg commands and returns the results.

This class extends `FfmpegProcess` to provide a simple interface for running FFmpeg with custom command-line arguments, capturing both standard output and standard
error, and returning process results in a structured format. Intended for plugin authors and advanced users who need to programmatically execute FFmpeg commands and
capture their results.

#### Example

```ts
const exec = new FfmpegExec(options, ["-version"]);
const result = await exec.exec();

if(result && result.exitCode === 0) {

  console.log(result.stdout.toString());
}
```

#### See

 - FfmpegProcess
 - [FFmpeg Documentation](https://ffmpeg.org/documentation.html)

#### Extends

- [`FfmpegProcess`](process.md#ffmpegprocess)

#### Constructors

##### Constructor

```ts
new FfmpegExec(
   options, 
   commandLineArgs?, 
   logErrors?): FfmpegExec;
```

Creates a new instance of `FfmpegExec`.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | `undefined` | The options used to configure FFmpeg execution. |
| `commandLineArgs?` | `string`[] | `undefined` | Optional. Command-line arguments to pass to the FFmpeg process. |
| `logErrors?` | `boolean` | `true` | Optional. If `true`, errors will be logged; otherwise, they will be suppressed. Defaults to `true`. |

###### Returns

[`FfmpegExec`](#ffmpegexec)

###### Example

```ts
const exec = new FfmpegExec(options, ["-i", "input.mp4", "-f", "null", "-"]);
```

###### Overrides

[`FfmpegProcess`](process.md#ffmpegprocess).[`constructor`](process.md#ffmpegprocess#constructor)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="haserror"></a> `hasError` | `public` | `boolean` | Indicates if an error has occurred during FFmpeg process execution. | [`FfmpegProcess`](process.md#ffmpegprocess).[`hasError`](process.md#ffmpegprocess#haserror) |
| <a id="isended"></a> `isEnded` | `public` | `boolean` | Indicates whether the FFmpeg process has ended. | [`FfmpegProcess`](process.md#ffmpegprocess).[`isEnded`](process.md#ffmpegprocess#isended) |
| <a id="isstarted"></a> `isStarted` | `public` | `boolean` | Indicates whether the FFmpeg process has started. | [`FfmpegProcess`](process.md#ffmpegprocess).[`isStarted`](process.md#ffmpegprocess#isstarted) |
| <a id="process"></a> `process` | `public` | [`Nullable`](../util.md#nullable)\<`ChildProcessWithoutNullStreams`\> | The underlying Node.js ChildProcess instance for the FFmpeg process. | [`FfmpegProcess`](process.md#ffmpegprocess).[`process`](process.md#ffmpegprocess#process) |

#### Accessors

##### stderr

###### Get Signature

```ts
get stderr(): Nullable<Readable>;
```

Returns the readable standard error stream for the FFmpeg process, if available.

###### Returns

[`Nullable`](../util.md#nullable)\<`Readable`\>

The standard error stream, or `null` if not available.

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`stderr`](process.md#ffmpegprocess#stderr)

##### stdin

###### Get Signature

```ts
get stdin(): Nullable<Writable>;
```

Returns the writable standard input stream for the FFmpeg process, if available.

###### Returns

[`Nullable`](../util.md#nullable)\<`Writable`\>

The standard input stream, or `null` if not available.

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`stdin`](process.md#ffmpegprocess#stdin)

##### stdout

###### Get Signature

```ts
get stdout(): Nullable<Readable>;
```

Returns the readable standard output stream for the FFmpeg process, if available.

###### Returns

[`Nullable`](../util.md#nullable)\<`Readable`\>

The standard output stream, or `null` if not available.

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`stdout`](process.md#ffmpegprocess#stdout)

#### Methods

##### exec()

```ts
exec(stdinData?): Promise<Nullable<ProcessResult>>;
```

Runs the FFmpeg process and returns the result, including exit code, stdout, and stderr.

If `stdinData` is provided, it will be written to the process's standard input before execution. Returns `null` if the process fails to start.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `stdinData?` | `Buffer`\<`ArrayBufferLike`\> | Optional. Data to write to FFmpeg's standard input. |

###### Returns

`Promise`\<[`Nullable`](../util.md#nullable)\<[`ProcessResult`](#processresult)\>\>

A promise that resolves to a `ProcessResult` object containing the exit code, stdout, and stderr, or `null` if the process could not be started.

###### Example

```ts
const exec = new FfmpegExec(options, ["-i", "input.wav", "output.mp3"]);
const result = await exec.exec();

if(result) {

  console.log("Exit code:", result.exitCode);
  console.log("FFmpeg output:", result.stdout.toString());
}
```

##### start()

```ts
start(
   commandLineArgs?, 
   callback?, 
   errorHandler?): void;
```

Starts the FFmpeg process with the provided command line and callback.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `commandLineArgs?` | `string`[] | Optional. Arguments for FFmpeg command line. |
| `callback?` | `StreamRequestCallback` | Optional. Callback invoked when streaming is ready. |
| `errorHandler?` | (`errorMessage`) => `void` \| `Promise`\<`void`\> | Optional. Function called if FFmpeg fails to start or terminates with error. |

###### Returns

`void`

###### Example

```ts
process.start(["-i", "input.mp4", "-f", "null", "-"]);
```

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`start`](process.md#ffmpegprocess#start)

##### stop()

```ts
stop(): void;
```

Stops the FFmpeg process and performs necessary cleanup.

###### Returns

`void`

###### Example

```ts
process.stop();
```

###### Inherited from

[`FfmpegProcess`](process.md#ffmpegprocess).[`stop`](process.md#ffmpegprocess#stop)

***

### ProcessResult

```ts
type ProcessResult = {
  exitCode: Nullable<number>;
  stderr: Buffer;
  stdout: Buffer;
};
```

Describes the result of executing an FFmpeg process.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="exitcode"></a> `exitCode` | [`Nullable`](../util.md#nullable)\<`number`\> | The process exit code, or `null` if not available. |
| <a id="stderr-1"></a> `stderr` | `Buffer` | The standard error output as a Buffer. |
| <a id="stdout-1"></a> `stdout` | `Buffer` | The standard output as a Buffer. |
