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
- Flexible error handling and timeouts for HomeKit's strict realtime requirements.
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
   isVerbose?): FfmpegLivestreamProcess;
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

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="segmentlength"></a> `segmentLength?` | `public` | `number` | Optional override for the fMP4 fragment duration, in milliseconds. When set, the `-frag_duration` argument is updated before starting the FFmpeg process. |

#### Accessors

##### hasError

###### Get Signature

```ts
get hasError(): boolean;
```

Indicates if an error has occurred during FFmpeg process execution.

###### Returns

`boolean`

###### Inherited from

```ts
FfmpegFMp4Process.hasError
```

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

##### isEnded

###### Get Signature

```ts
get isEnded(): boolean;
```

Indicates whether the FFmpeg process has ended.

###### Returns

`boolean`

###### Inherited from

```ts
FfmpegFMp4Process.isEnded
```

##### isStarted

###### Get Signature

```ts
get isStarted(): boolean;
```

Indicates whether the FFmpeg process has started.

###### Returns

`boolean`

###### Inherited from

```ts
FfmpegFMp4Process.isStarted
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

##### stderrLog

###### Get Signature

```ts
get stderrLog(): string[];
```

Returns the accumulated standard error log lines from the FFmpeg process.

###### Returns

`string`[]

An array of stderr log lines.

###### Inherited from

```ts
FfmpegFMp4Process.stderrLog
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

##### start()

```ts
start(): void;
```

Starts the FFmpeg process, adjusting the fragment duration if segmentLength has been set.

###### Returns

`void`

###### Example

```ts
process.start();
```

###### Overrides

```ts
FfmpegFMp4Process.start
```

##### stop()

```ts
stop(logErrors?): void;
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
   fMp4Options?, 
   isVerbose?): FfmpegRecordingProcess;
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

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="istimedout"></a> `isTimedOut` | `public` | `boolean` | Indicates whether the recording has timed out waiting for FFmpeg output. |

#### Accessors

##### hasError

###### Get Signature

```ts
get hasError(): boolean;
```

Indicates if an error has occurred during FFmpeg process execution.

###### Returns

`boolean`

###### Inherited from

```ts
FfmpegFMp4Process.hasError
```

##### isEnded

###### Get Signature

```ts
get isEnded(): boolean;
```

Indicates whether the FFmpeg process has ended.

###### Returns

`boolean`

###### Inherited from

```ts
FfmpegFMp4Process.isEnded
```

##### isStarted

###### Get Signature

```ts
get isStarted(): boolean;
```

Indicates whether the FFmpeg process has started.

###### Returns

`boolean`

###### Inherited from

```ts
FfmpegFMp4Process.isStarted
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

##### stderrLog

###### Get Signature

```ts
get stderrLog(): string[];
```

Returns the accumulated standard error log lines from the FFmpeg process.

###### Returns

`string`[]

An array of stderr log lines.

###### Inherited from

```ts
FfmpegFMp4Process.stderrLog
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

```ts
FfmpegFMp4Process.start
```

##### stop()

```ts
stop(logErrors?): void;
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

### FMp4AudioInputConfig

Configuration for a separate audio input source in an fMP4 livestream session. This interface describes the audio source when video and audio come from different
endpoints, such as cameras like DoorBird that expose audio through a separate HTTP API.

When the audio source is a raw stream (not a self-describing container), specify `format`, `sampleRate`, and optionally `channels` so FFmpeg knows how to interpret
the input. For self-describing sources like RTSP or container-based HTTP streams, only `url` is required.

#### Example

```ts
// Raw audio from a DoorBird audio.cgi endpoint.
const rawAudioInput: FMp4AudioInputConfig = {

  format: "mulaw",
  sampleRate: 8000,
  url: "http://doorbird-ip/bha-api/audio.cgi"
};

// Self-describing RTSP audio stream - only URL is needed.
const rtspAudioInput: FMp4AudioInputConfig = {

  url: "rtsp://camera-ip/audio"
};
```

#### See

FMp4LivestreamOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="channels"></a> `channels?` | `number` | Optional. Number of audio channels. Defaults to `1`. |
| <a id="format"></a> `format?` | `"alaw"` \| `"mulaw"` \| `"s16le"` | Optional. Raw audio format for the input stream. When set, FFmpeg is told to expect this format rather than probing the stream. Valid values are `alaw` (G.711 A-law), `mulaw` (G.711 mu-law), and `s16le` (16-bit signed little-endian PCM). Omit for self-describing sources. |
| <a id="samplerate"></a> `sampleRate?` | `number` | Optional. Audio sample rate in Hz (e.g., `8000`). Used when `format` is set. Defaults to `8000`. |
| <a id="url"></a> `url` | `string` | The URL of the audio input source. |

***

### FMp4LivestreamOptions

Options for configuring an fMP4 livestream session.

#### See

FMp4AudioInputConfig

#### Extends

- [`FMp4BaseOptions`](#fmp4baseoptions)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="audiofilters-1"></a> `audioFilters` | `string`[] | Audio filters for FFmpeg to process. These are passed as an array of filters. | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioFilters`](#audiofilters) |
| <a id="audioinput"></a> `audioInput?` | `string` \| [`FMp4AudioInputConfig`](#fmp4audioinputconfig) | Optional. A separate audio input source. When provided, audio is read from this source instead of the primary `url`. Can be a URL string for self-describing sources (e.g., RTSP), or an `FMp4AudioInputConfig` object for raw audio streams that require format metadata. | - |
| <a id="audiostream-1"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioStream`](#audiostream) |
| <a id="codec-1"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`codec`](#codec) |
| <a id="enableaudio-1"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. | [`FMp4BaseOptions`](#fmp4baseoptions).[`enableAudio`](#enableaudio) |
| <a id="hardwaredecoding-1"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareDecoding`](#hardwaredecoding) |
| <a id="hardwaretranscoding-1"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareTranscoding`](#hardwaretranscoding) |
| <a id="transcodeaudio-1"></a> `transcodeAudio` | `boolean` | Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`transcodeAudio`](#transcodeaudio) |
| <a id="url-1"></a> `url` | `string` | Source URL for livestream (RTSP) remuxing to fMP4. | - |
| <a id="videofilters-1"></a> `videoFilters` | `string`[] | Video filters for FFmpeg to process. These are passed as an array of filters. | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoFilters`](#videofilters) |
| <a id="videostream-1"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoStream`](#videostream) |

## Other

### FMp4BaseOptions

Base options shared by both fMP4 recording and livestream sessions.

#### Extended by

- [`FMp4RecordingOptions`](#fmp4recordingoptions)
- [`FMp4LivestreamOptions`](#fmp4livestreamoptions)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="audiofilters"></a> `audioFilters` | `string`[] | Audio filters for FFmpeg to process. These are passed as an array of filters. |
| <a id="audiostream"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). |
| <a id="codec"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`. |
| <a id="enableaudio"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. |
| <a id="hardwaredecoding"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions`. |
| <a id="hardwaretranscoding"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. |
| <a id="transcodeaudio"></a> `transcodeAudio` | `boolean` | Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. |
| <a id="videofilters"></a> `videoFilters` | `string`[] | Video filters for FFmpeg to process. These are passed as an array of filters. |
| <a id="videostream"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). |

***

### FMp4RecordingOptions

Options for configuring an fMP4 HKSV recording session.

#### Extends

- [`FMp4BaseOptions`](#fmp4baseoptions)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="audiofilters-2"></a> `audioFilters` | `string`[] | Audio filters for FFmpeg to process. These are passed as an array of filters. | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioFilters`](#audiofilters) |
| <a id="audiostream-2"></a> `audioStream` | `number` | Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`audioStream`](#audiostream) |
| <a id="codec-2"></a> `codec` | `string` | The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`codec`](#codec) |
| <a id="enableaudio-2"></a> `enableAudio` | `boolean` | Indicates whether to enable audio or not. | [`FMp4BaseOptions`](#fmp4baseoptions).[`enableAudio`](#enableaudio) |
| <a id="fps"></a> `fps` | `number` | The video frames per second for the session. | - |
| <a id="hardwaredecoding-2"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareDecoding`](#hardwaredecoding) |
| <a id="hardwaretranscoding-2"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`hardwareTranscoding`](#hardwaretranscoding) |
| <a id="probesize"></a> `probesize` | `number` | Number of bytes to analyze for stream information. | - |
| <a id="timeshift"></a> `timeshift` | `number` | Timeshift offset for event-based recording (in milliseconds). | - |
| <a id="transcodeaudio-2"></a> `transcodeAudio` | `boolean` | Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`. | [`FMp4BaseOptions`](#fmp4baseoptions).[`transcodeAudio`](#transcodeaudio) |
| <a id="videofilters-2"></a> `videoFilters` | `string`[] | Video filters for FFmpeg to process. These are passed as an array of filters. | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoFilters`](#videofilters) |
| <a id="videostream-2"></a> `videoStream` | `number` | Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream). | [`FMp4BaseOptions`](#fmp4baseoptions).[`videoStream`](#videostream) |
