[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/stream

# ffmpeg/stream

FFmpeg process management and socket handling to support HomeKit livestreaming sessions.

This module defines the `FfmpegStreamingProcess` class and related interfaces for orchestrating and monitoring FFmpeg-powered video streams. It manages process
lifecycle, handles UDP socket creation for video health monitoring, and enables integration with Homebridge streaming delegates for robust error handling, stream
cleanup, and automatic tuning.

Key features:

- Automated start, monitoring, and termination of HomeKit-compatible FFmpeg video streams.
- Integration with Homebridge’s CameraStreamingDelegate for custom error hooks and lifecycle control.
- UDP socket creation and management for realtime video stream liveness detection.
- Intelligent error handling, including automatic tuning for FFmpeg’s stream probing requirements.
- Exposes access to the underlying FFmpeg child process for advanced scenarios.

Designed for plugin developers and advanced users who require fine-grained control and diagnostics for HomeKit livestreaming, with seamless Homebridge integration.

## FFmpeg

### FfmpegStreamingProcess

Provides FFmpeg process management and socket handling to support HomeKit livestreaming sessions.

This class extends `FfmpegProcess` to create, monitor, and terminate HomeKit-compatible video streams. Additionally, it invokes delegate hooks for error processing and
stream lifecycle management.

#### Example

```ts
const streamingDelegate: HomebridgeStreamingDelegate = {

  controller,
  stopStream: (sessionId) => { ... } // End-of-session cleanup code.
};

const process = new FfmpegStreamingProcess(

  streamingDelegate,
  sessionId,
  ffmpegOptions,
  commandLineArgs,
  { addressVersion: "ipv4", port: 5000 }
);
```

#### See

 - HomebridgeStreamingDelegate
 - FfmpegProcess

#### Extends

- [`FfmpegProcess`](process.md#ffmpegprocess)

#### Constructors

##### Constructor

```ts
new FfmpegStreamingProcess(
   delegate, 
   sessionId, 
   ffmpegOptions, 
   commandLineArgs, 
   returnPort?, 
   callback?): FfmpegStreamingProcess;
```

Constructs a new FFmpeg streaming process for a HomeKit session.

Sets up required delegate hooks, creates UDP return sockets if needed, and starts the FFmpeg process. Automatically handles FFmpeg process errors and cleans up on
failures.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `delegate` | [`HomebridgeStreamingDelegate`](#homebridgestreamingdelegate) | The Homebridge streaming delegate for this session. |
| `sessionId` | `string` | The HomeKit session identifier for this stream. |
| `ffmpegOptions` | [`FfmpegOptions`](options.md#ffmpegoptions) | The FFmpeg configuration options. |
| `commandLineArgs` | `string`[] | FFmpeg command-line arguments. |
| `returnPort?` | \{ `addressVersion`: `string`; `port`: `number`; \} | Optional. UDP port info for the return stream (used except for two-way audio). |
| `returnPort.addressVersion?` | `string` | - |
| `returnPort.port?` | `number` | - |
| `callback?` | `StreamRequestCallback` | Optional. Callback invoked when the stream is ready or errors occur. |

###### Returns

[`FfmpegStreamingProcess`](#ffmpegstreamingprocess)

###### Example

```ts
const process = new FfmpegStreamingProcess(delegate, sessionId, ffmpegOptions, commandLineArgs, { addressVersion: "ipv6", port: 6000 });
```

###### Overrides

[`FfmpegProcess`](process.md#ffmpegprocess).[`constructor`](process.md#ffmpegprocess#constructor)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="haserror"></a> `hasError` | `public` | `boolean` | Indicates if an error has occurred during FFmpeg process execution. | [`FfmpegProcess`](process.md#ffmpegprocess).[`hasError`](process.md#ffmpegprocess#haserror) |
| <a id="isended"></a> `isEnded` | `public` | `boolean` | Indicates whether the FFmpeg process has ended. | [`FfmpegProcess`](process.md#ffmpegprocess).[`isEnded`](process.md#ffmpegprocess#isended) |
| <a id="isstarted"></a> `isStarted` | `public` | `boolean` | Indicates whether the FFmpeg process has started. | [`FfmpegProcess`](process.md#ffmpegprocess).[`isStarted`](process.md#ffmpegprocess#isstarted) |

#### Accessors

##### ffmpegProcess

###### Get Signature

```ts
get ffmpegProcess(): Nullable<ChildProcessWithoutNullStreams>;
```

Returns the underlying FFmpeg child process, or null if the process is not running.

###### Example

```ts
const ffmpeg = process.ffmpegProcess;

if(ffmpeg) {

  // Interact directly with the child process if necessary.
}
```

###### Returns

[`Nullable`](../util.md#nullable)\<`ChildProcessWithoutNullStreams`\>

The current FFmpeg process, or `null` if not running.

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

### HomebridgeStreamingDelegate

Extension of the Homebridge CameraStreamingDelegate with additional streaming controls and error handling hooks.

#### See

 - CameraController
 - CameraStreamingDelegate

#### Extends

- `CameraStreamingDelegate`

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="adjustprobesize"></a> `adjustProbeSize?` | () => `void` | Optional. Invoked to adjust probe size after stream startup errors. |
| <a id="controller"></a> `controller` | `CameraController` | The Homebridge CameraController instance managing the stream. |
| <a id="ffmpegerrorcheck"></a> `ffmpegErrorCheck?` | (`logEntry`) => `undefined` \| `string` | Optional. Returns a user-friendly error message for specific FFmpeg errors, if detected. |
| <a id="stopstream"></a> `stopStream?` | (`sessionId`) => `void` | Optional. Invoked to force stop a specific stream session by ID. |
