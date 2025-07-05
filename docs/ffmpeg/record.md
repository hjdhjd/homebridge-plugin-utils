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

FfmpegFMp4Process

#### Extends

- `FfmpegFMp4Process`

#### Constructors

##### Constructor

```ts
new FfmpegLivestreamProcess(
   options, 
   recordingConfig, 
   livestreamOptions, 
   isVerbose): FfmpegLivestreamProcess;
```

Constructs a new FFmpeg livestream process.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | `undefined` | FFmpeg configuration options. |
| `recordingConfig` | `CameraRecordingConfiguration` | `undefined` | HomeKit recording configuration for the session. |
| `livestreamOptions` | [`PartialWithId`](../util.md#partialwithid)\<[`FMp4LivestreamOptions`](#fmp4livestreamoptions), `"url"`\> | `undefined` | livestream segmenting options. |
| `isVerbose` | `boolean` | `false` | If `true`, enables more verbose logging for debugging purposes. Defaults to `false`. |

###### Returns

[`FfmpegLivestreamProcess`](#ffmpeglivestreamprocess)

###### Overrides

```ts
FfmpegFMp4Process.constructor
```

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="haserror"></a> `hasError` | `public` | `boolean` | Indicates if an error has occurred during FFmpeg process execution. | `FfmpegFMp4Process.hasError` |
| <a id="isended"></a> `isEnded` | `public` | `boolean` | Indicates whether the FFmpeg process has ended. | `FfmpegFMp4Process.isEnded` |
| <a id="isstarted"></a> `isStarted` | `public` | `boolean` | Indicates whether the FFmpeg process has started. | `FfmpegFMp4Process.isStarted` |
| <a id="istimedout"></a> `isTimedOut` | `public` | `boolean` | - | `FfmpegFMp4Process.isTimedOut` |
| <a id="process"></a> `process` | `public` | [`Nullable`](../util.md#nullable)\<`ChildProcessWithoutNullStreams`\> | The underlying Node.js ChildProcess instance for the FFmpeg process. | `FfmpegFMp4Process.process` |
| <a id="segmentlength"></a> `segmentLength?` | `public` | `number` | - | `FfmpegFMp4Process.segmentLength` |

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
FfmpegFMp4Process.initSegment
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
FfmpegFMp4Process.stderr
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
FfmpegFMp4Process.stdin
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
FfmpegFMp4Process.stdout
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
FfmpegFMp4Process.getInitSegment
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
FfmpegFMp4Process.segmentGenerator
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
FfmpegFMp4Process.start
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
FfmpegFMp4Process.stop
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

FfmpegFMp4Process

#### Extends

- `FfmpegFMp4Process`

#### Constructors

##### Constructor

```ts
new FfmpegRecordingProcess(
   options, 
   recordingConfig, 
   fMp4Options, 
   isVerbose): FfmpegRecordingProcess;
```

Constructs a new FFmpeg recording process for HKSV events.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `options` | [`FfmpegOptions`](options.md#ffmpegoptions) | `undefined` | FFmpeg configuration options. |
| `recordingConfig` | `CameraRecordingConfiguration` | `undefined` | HomeKit recording configuration for the session. |
| `fMp4Options` | `Partial`\<[`FMp4RecordingOptions`](#fmp4recordingoptions)\> | `{}` | fMP4 recording options. |
| `isVerbose` | `boolean` | `false` | If `true`, enables more verbose logging for debugging purposes. Defaults to `false`. |

###### Returns

[`FfmpegRecordingProcess`](#ffmpegrecordingprocess)

###### Overrides

```ts
FfmpegFMp4Process.constructor
```

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="haserror-1"></a> `hasError` | `public` | `boolean` | Indicates if an error has occurred during FFmpeg process execution. | `FfmpegFMp4Process.hasError` |
| <a id="isended-1"></a> `isEnded` | `public` | `boolean` | Indicates whether the FFmpeg process has ended. | `FfmpegFMp4Process.isEnded` |
| <a id="isstarted-1"></a> `isStarted` | `public` | `boolean` | Indicates whether the FFmpeg process has started. | `FfmpegFMp4Process.isStarted` |
| <a id="istimedout-1"></a> `isTimedOut` | `public` | `boolean` | - | `FfmpegFMp4Process.isTimedOut` |
| <a id="process-1"></a> `process` | `public` | [`Nullable`](../util.md#nullable)\<`ChildProcessWithoutNullStreams`\> | The underlying Node.js ChildProcess instance for the FFmpeg process. | `FfmpegFMp4Process.process` |
| <a id="segmentlength-1"></a> `segmentLength?` | `public` | `number` | - | `FfmpegFMp4Process.segmentLength` |

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
FfmpegFMp4Process.initSegment
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
FfmpegFMp4Process.stderr
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
FfmpegFMp4Process.stdin
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
FfmpegFMp4Process.stdout
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
FfmpegFMp4Process.segmentGenerator
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
FfmpegFMp4Process.start
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
FfmpegFMp4Process.stop
```

## Other

### FMp4BaseOptions

Base options for configuring an fMP4 recording or livestream session. These options aren't used directly but are inherited and used by it's descendents.

#### Extended by

- [`FMp4RecordingOptions`](#fmp4recordingoptions)
- [`FMp4LivestreamOptions`](#fmp4livestreamoptions)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="audiostream"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). |
| <a id="codec"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`. |
| <a id="enableaudio"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. |
| <a id="hardwaretranscoding"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. |
| <a id="videostream"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). |

***

### FMp4LivestreamOptions

Options for configuring an fMP4 recording or livestream session.

#### Extends

- [`FMp4BaseOptions`](#fmp4baseoptions)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="audiostream-1"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioStream`](#audiostream) |
| <a id="codec-1"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`codec`](#codec) |
| <a id="enableaudio-1"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. | [`FMp4BaseOptions`](#fmp4baseoptions).[`enableAudio`](#enableaudio) |
| <a id="hardwaretranscoding-1"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareTranscoding`](#hardwaretranscoding) |
| <a id="url"></a> `url` | `string` | Source URL for livestream (RTSP) remuxing to fMP4. | - |
| <a id="videostream-1"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoStream`](#videostream) |

***

### FMp4RecordingOptions

Options for configuring an fMP4 recording or livestream session.

#### Extends

- [`FMp4BaseOptions`](#fmp4baseoptions)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="audiostream-2"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioStream`](#audiostream) |
| <a id="codec-2"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`codec`](#codec) |
| <a id="enableaudio-2"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. | [`FMp4BaseOptions`](#fmp4baseoptions).[`enableAudio`](#enableaudio) |
| <a id="fps"></a> `fps` | `number` | The video frames per second for the session. | - |
| <a id="hardwaretranscoding-2"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareTranscoding`](#hardwaretranscoding) |
| <a id="timeshift"></a> `timeshift` | `number` | Timeshift offset for event-based recording (in milliseconds). | - |
| <a id="transcodeaudio"></a> `transcodeAudio` | `boolean` | Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. | - |
| <a id="videostream-2"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoStream`](#videostream) |
