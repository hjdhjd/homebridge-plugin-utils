[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/record

# ffmpeg/record

FFmpeg process management for HomeKit Secure Video (HKSV) events and fMP4 livestreaming.

This module defines classes for orchestrating FFmpeg processes that produce fMP4 segments suitable for HomeKit Secure Video and realtime livestreaming scenarios. It
handles process lifecycle, segment buffering, initialization segment detection, and streaming event generation, abstracting away the complexity of interacting directly
with FFmpeg for these workflows.

Key features:

- Automated setup and management of FFmpeg processes for HKSV event recording and livestreaming (with support for audio and video).
- Parsing and generation of fMP4 boxes/segments for HomeKit, including initialization and media segments.
- Async generator APIs for efficient, event-driven segment handling.
- Flexible error handling and timeouts for HomeKit’s strict realtime requirements.
- Designed for Homebridge plugin authors or advanced users who need robust, platform-aware FFmpeg session control for HomeKit and related integrations.

## FFmpeg

### FfmpegLivestreamProcess

Manages a HomeKit livestream FFmpeg process for generating fMP4 segments.

#### Example

```ts
const process = new FfmpegLivestreamProcess(ffmpegOptions, recordingConfig, url, 30, true);
process.start();

const initSegment = await process.getInitSegment();
```

#### See

FfmpegFmp4Process

#### Extends

- `FfmpegFmp4Process`

#### Constructors

##### Constructor

```ts
new FfmpegLivestreamProcess(
   options, 
   recordingConfig, 
   url, 
   fps, 
   processAudio, 
   codec, 
   isVerbose): FfmpegLivestreamProcess;
```

Constructs a new FFmpeg livestream process.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | `undefined` | FFmpeg configuration options. |
| `recordingConfig` | `CameraRecordingConfiguration` | `undefined` | HomeKit recording configuration for the session. |
| `url` | `string` | `undefined` | Source RTSP or livestream URL. |
| `fps` | `number` | `undefined` | Video frames per second. |
| `processAudio` | `boolean` | `true` | If `true`, enables audio stream processing. Defaults to `true`. |
| `codec` | `string` | `"h264"` | Codec for the video stream input. Valid values are: `h264` and `hevc`. Defaults to `h264`. |
| `isVerbose` | `boolean` | `false` | If `true`, enables more verbose logging for debugging purposes. Defaults to `false`. |

###### Returns

[`FfmpegLivestreamProcess`](#ffmpeglivestreamprocess)

###### Overrides

```ts
FfmpegFmp4Process.constructor
```

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="haserror"></a> `hasError` | `public` | `boolean` | Indicates if an error has occurred during FFmpeg process execution. | `FfmpegFmp4Process.hasError` |
| <a id="isended"></a> `isEnded` | `public` | `boolean` | Indicates whether the FFmpeg process has ended. | `FfmpegFmp4Process.isEnded` |
| <a id="isstarted"></a> `isStarted` | `public` | `boolean` | Indicates whether the FFmpeg process has started. | `FfmpegFmp4Process.isStarted` |
| <a id="istimedout"></a> `isTimedOut` | `public` | `boolean` | - | `FfmpegFmp4Process.isTimedOut` |
| <a id="segmentlength"></a> `segmentLength?` | `public` | `number` | - | `FfmpegFmp4Process.segmentLength` |

#### Accessors

##### initSegment

###### Get Signature

```ts
get initSegment(): Nullable<Buffer<ArrayBufferLike>>;
```

Returns the initialization segment as a Buffer, or null if not yet available.

###### Example

```ts
const init = process.initSegment;
if(init) {

  // Use the initialization segment.
}
```

###### Returns

[`Nullable`](../util.md#nullable)\<`Buffer`\<`ArrayBufferLike`\>\>

The initialization segment Buffer, or `null` if not yet generated.

###### Inherited from

```ts
FfmpegFmp4Process.initSegment
```

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

```ts
FfmpegFmp4Process.stderr
```

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

```ts
FfmpegFmp4Process.stdin
```

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

```ts
FfmpegFmp4Process.stdout
```

#### Methods

##### getInitSegment()

```ts
getInitSegment(): Promise<Buffer<ArrayBufferLike>>;
```

Gets the fMP4 initialization segment generated by FFmpeg for the livestream.

###### Returns

`Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

A promise resolving to the initialization segment as a Buffer.

###### Example

```ts
const initSegment = await process.getInitSegment();
```

###### Overrides

```ts
FfmpegFmp4Process.getInitSegment
```

##### segmentGenerator()

```ts
segmentGenerator(): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Asynchronously generates complete segments from FFmpeg output, formatted for HomeKit Secure Video.

This async generator yields fMP4 segments as Buffers, or ends on process termination or timeout.

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

###### Yields

A Buffer containing a complete MP4 segment suitable for HomeKit.

###### Example

```ts
for await(const segment of process.segmentGenerator()) {

  // Process each segment for HomeKit.
}
```

###### Inherited from

```ts
FfmpegFmp4Process.segmentGenerator
```

##### start()

```ts
start(): void;
```

Starts the FFmpeg process, adjusting segment length for livestreams if set.

###### Returns

`void`

###### Example

```ts
process.start();
```

###### Inherited from

```ts
FfmpegFmp4Process.start
```

##### stop()

```ts
stop(logErrors): void;
```

Stops the FFmpeg process and logs errors if specified.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `logErrors` | `boolean` | If `true`, logs FFmpeg errors. Defaults to the internal process logging state. |

###### Returns

`void`

###### Example

```ts
process.stop();
```

###### Inherited from

```ts
FfmpegFmp4Process.stop
```

***

### FfmpegRecordingProcess

Manages a HomeKit Secure Video recording FFmpeg process.

#### Example

```ts
const process = new FfmpegRecordingProcess(ffmpegOptions, recordingConfig, 30, true, 5000000, 0);
process.start();
```

#### See

FfmpegFmp4Process

#### Extends

- `FfmpegFmp4Process`

#### Constructors

##### Constructor

```ts
new FfmpegRecordingProcess(
   options, 
   recordingConfig, 
   fps, 
   processAudio, 
   probesize, 
   timeshift, 
   codec, 
   isVerbose): FfmpegRecordingProcess;
```

Constructs a new FFmpeg recording process for HKSV events.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | `undefined` | FFmpeg configuration options. |
| `recordingConfig` | `CameraRecordingConfiguration` | `undefined` | HomeKit recording configuration for the session. |
| `fps` | `number` | `undefined` | Video frames per second. |
| `processAudio` | `boolean` | `undefined` | If `true`, enables audio stream processing. |
| `probesize` | `number` | `undefined` | Stream analysis size, in bytes. |
| `timeshift` | `number` | `undefined` | Timeshift offset for event-based recording, in milliseconds. |
| `codec` | `string` | `"h264"` | Codec for the video stream input. Valid values are: `h264` and `hevc`. Defaults to `h264`. |
| `isVerbose` | `boolean` | `false` | If `true`, enables more verbose logging for debugging purposes. Defaults to `false`. |

###### Returns

[`FfmpegRecordingProcess`](#ffmpegrecordingprocess)

###### Overrides

```ts
FfmpegFmp4Process.constructor
```

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="haserror-1"></a> `hasError` | `public` | `boolean` | Indicates if an error has occurred during FFmpeg process execution. | `FfmpegFmp4Process.hasError` |
| <a id="isended-1"></a> `isEnded` | `public` | `boolean` | Indicates whether the FFmpeg process has ended. | `FfmpegFmp4Process.isEnded` |
| <a id="isstarted-1"></a> `isStarted` | `public` | `boolean` | Indicates whether the FFmpeg process has started. | `FfmpegFmp4Process.isStarted` |
| <a id="istimedout-1"></a> `isTimedOut` | `public` | `boolean` | - | `FfmpegFmp4Process.isTimedOut` |
| <a id="segmentlength-1"></a> `segmentLength?` | `public` | `number` | - | `FfmpegFmp4Process.segmentLength` |

#### Accessors

##### initSegment

###### Get Signature

```ts
get initSegment(): Nullable<Buffer<ArrayBufferLike>>;
```

Returns the initialization segment as a Buffer, or null if not yet available.

###### Example

```ts
const init = process.initSegment;
if(init) {

  // Use the initialization segment.
}
```

###### Returns

[`Nullable`](../util.md#nullable)\<`Buffer`\<`ArrayBufferLike`\>\>

The initialization segment Buffer, or `null` if not yet generated.

###### Inherited from

```ts
FfmpegFmp4Process.initSegment
```

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

```ts
FfmpegFmp4Process.stderr
```

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

```ts
FfmpegFmp4Process.stdin
```

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

```ts
FfmpegFmp4Process.stdout
```

#### Methods

##### segmentGenerator()

```ts
segmentGenerator(): AsyncGenerator<Buffer<ArrayBufferLike>>;
```

Asynchronously generates complete segments from FFmpeg output, formatted for HomeKit Secure Video.

This async generator yields fMP4 segments as Buffers, or ends on process termination or timeout.

###### Returns

`AsyncGenerator`\<`Buffer`\<`ArrayBufferLike`\>\>

###### Yields

A Buffer containing a complete MP4 segment suitable for HomeKit.

###### Example

```ts
for await(const segment of process.segmentGenerator()) {

  // Process each segment for HomeKit.
}
```

###### Inherited from

```ts
FfmpegFmp4Process.segmentGenerator
```

##### start()

```ts
start(): void;
```

Starts the FFmpeg process, adjusting segment length for livestreams if set.

###### Returns

`void`

###### Example

```ts
process.start();
```

###### Inherited from

```ts
FfmpegFmp4Process.start
```

##### stop()

```ts
stop(logErrors): void;
```

Stops the FFmpeg process and logs errors if specified.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `logErrors` | `boolean` | If `true`, logs FFmpeg errors. Defaults to the internal process logging state. |

###### Returns

`void`

###### Example

```ts
process.stop();
```

###### Inherited from

```ts
FfmpegFmp4Process.stop
```
