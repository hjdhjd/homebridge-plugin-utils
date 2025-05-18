[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/process

# ffmpeg/process

FFmpeg process management and capability introspection.

This module defines the `FfmpegProcess` class, which abstracts the spawning, monitoring, and logging of FFmpeg subprocesses. It manages process state, handles
command-line argument composition, processes standard streams (stdin, stdout, stderr), and robustly reports process errors and exit conditions.

Designed for use in Homebridge plugins, this module enables safe and flexible execution of FFmpeg commands, making it easier to integrate video/audio processing
pipelines with realtime control and diagnostics.

Key features:

- Comprehensive FFmpeg subprocess management (start, monitor, stop, cleanup).
- Streamlined error handling and logging, with pluggable loggers.
- Access to process I/O streams for data injection and consumption.
- Flexible callback and event-based architecture for streaming scenarios.

Intended for developers needing direct, reliable control over FFmpeg process lifecycles with detailed runtime insights, especially in plugin or media automation
contexts.

## FFmpeg

### FfmpegProcess

Base class providing FFmpeg process management and capability introspection.

This class encapsulates spawning, managing, and logging of FFmpeg processes, as well as handling process I/O and errors. It is designed as a reusable foundation for
advanced FFmpeg process control in Homebridge plugins or similar environments. Originally inspired by the Homebridge and homebridge-camera-ffmpeg source code.

#### Example

```ts
// Create and start an FFmpeg process.
const process = new FfmpegProcess(options, ["-i", "input.mp4", "-f", "null", "-"]);
process.start();

// Access process streams if needed.
const stdin = process.stdin;
const stdout = process.stdout;
const stderr = process.stderr;

// Stop the FFmpeg process when done.
process.stop();
```

#### See

 - [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
 - [Node.js child\_process](https://nodejs.org/api/child_process.html)
 - FfmpegOptions

#### Extends

- `EventEmitter`

#### Extended by

- [`FfmpegExec`](exec.md#ffmpegexec)
- [`FfmpegStreamingProcess`](stream.md#ffmpegstreamingprocess)

#### Constructors

##### Constructor

```ts
new FfmpegProcess(
   options, 
   commandLineArgs?, 
   callback?): FfmpegProcess;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) |
| `commandLineArgs?` | `string`[] |
| `callback?` | `StreamRequestCallback` |

###### Returns

[`FfmpegProcess`](#ffmpegprocess)

###### Overrides

```ts
EventEmitter.constructor
```

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="haserror"></a> `hasError` | `public` | `boolean` | Indicates if an error has occurred during FFmpeg process execution. |
| <a id="isended"></a> `isEnded` | `public` | `boolean` | Indicates whether the FFmpeg process has ended. |
| <a id="isstarted"></a> `isStarted` | `public` | `boolean` | Indicates whether the FFmpeg process has started. |

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

##### stdin

###### Get Signature

```ts
get stdin(): Nullable<Writable>;
```

Returns the writable standard input stream for the FFmpeg process, if available.

###### Returns

[`Nullable`](../util.md#nullable)\<`Writable`\>

The standard input stream, or `null` if not available.

##### stdout

###### Get Signature

```ts
get stdout(): Nullable<Readable>;
```

Returns the readable standard output stream for the FFmpeg process, if available.

###### Returns

[`Nullable`](../util.md#nullable)\<`Readable`\>

The standard output stream, or `null` if not available.

#### Methods

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
