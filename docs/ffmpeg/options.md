[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/options

# ffmpeg/options

Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.

This module defines interfaces and classes for specifying, adapting, and generating FFmpeg command-line arguments tailored to the host system’s capabilities. It
automates the selection of codecs, pixel formats, hardware encoders/decoders, and streaming profiles for maximum compatibility and performance.

Key features:

- Encapsulates all FFmpeg transcoding and streaming options (including bitrate, resolution, framerate, H.264 profiles/levels, and quality optimizations).
- Detects and configures hardware-accelerated encoding and decoding (macOS VideoToolbox, Intel Quick Sync Video, and Raspberry Pi 4), falling back to software
  processing when required.
- Dynamically generates the appropriate FFmpeg command-line arguments for livestreaming, HomeKit Secure Video (HKSV) event recording, and crop filters.
- Provides strong TypeScript types and interfaces for reliable integration and extensibility in Homebridge.

This module is intended for plugin authors and advanced users who need precise, robust control over FFmpeg processing pipelines, with platform-aware optimizations and
safe fallbacks.

## FFmpeg

### FfmpegOptions

Provides Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.

This class generates and adapts FFmpeg command-line arguments for livestreaming and event recording, optimizing for system hardware and codec availability.

#### Example

```ts
const ffmpegOpts = new FfmpegOptions(optionsConfig);

// Generate video encoder arguments for streaming.
const encoderOptions: EncoderOptions = {

  bitrate: 3000,
  fps: 30,
  hardwareDecoding: true,
  hardwareTranscoding: true,
  height: 1080,
  idrInterval: 2,
  inputFps: 30,
  level: H264Level.LEVEL4_0,
  profile: H264Profile.HIGH,
  smartQuality: true,
  width: 1920
};
const args = ffmpegOpts.streamEncoder(encoderOptions);

// Generate crop filter string, if cropping is enabled.
const crop = ffmpegOpts.cropFilter;
```

#### See

 - EncoderOptions
 - FfmpegCodecs
 - [FFmpeg Documentation](https://ffmpeg.org/ffmpeg.html)

#### Constructors

##### Constructor

```ts
new FfmpegOptions(options): FfmpegOptions;
```

Creates an instance of Homebridge FFmpeg encoding and decoding options.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FfmpegOptionsConfig`](#ffmpegoptionsconfig-1) | FFmpeg options configuration. |

###### Returns

[`FfmpegOptions`](#ffmpegoptions)

###### Example

```ts
const ffmpegOpts = new FfmpegOptions(optionsConfig);
```

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="codecsupport"></a> `codecSupport` | `public` | [`FfmpegCodecs`](codecs.md#ffmpegcodecs) | FFmpeg codec and hardware capabilities for the current host. |
| <a id="config"></a> `config` | `readonly` | [`FfmpegOptionsConfig`](#ffmpegoptionsconfig-1) | The configuration options used to initialize this instance. |
| <a id="debug"></a> `debug` | `readonly` | `boolean` | Indicates if debug logging is enabled. |
| <a id="log"></a> `log` | `readonly` | \| [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) \| `Logging` | Logging interface for output and errors. |
| <a id="name"></a> `name` | `readonly` | () => `string` | Function returning the name for this options instance to be used for logging. |

#### Accessors

##### audioDecoder

###### Get Signature

```ts
get audioDecoder(): string;
```

Returns the audio decoder to use when decoding.

###### Returns

`string`

The FFmpeg audio decoder string.

##### cropFilter

###### Get Signature

```ts
get cropFilter(): string;
```

Returns the FFmpeg crop filter string, or a default no-op filter if cropping is disabled.

###### Returns

`string`

The crop filter string for FFmpeg.

##### hostSystemMaxPixels

###### Get Signature

```ts
get hostSystemMaxPixels(): number;
```

Returns the maximum pixel count supported by a specific hardware encoder on the host system, or `Infinity` if not limited.

###### Returns

`number`

Maximum supported pixel count.

#### Methods

##### audioEncoder()

```ts
audioEncoder(codec): string[];
```

Returns the audio encoder arguments to use when transcoding.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `codec` | `AudioRecordingCodecType` | `AudioRecordingCodecType.AAC_ELD` | Optional. Codec to encode (`AudioRecordingCodecType.AAC_ELD` (default) or `AudioRecordingCodecType.AAC_LC`). |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for audio encoding.

###### Example

```ts
const args = ffmpegOpts.audioEncoder();
```

##### recordEncoder()

```ts
recordEncoder(options): string[];
```

Returns the video encoder options to use for HomeKit Secure Video (HKSV) event recording.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`EncoderOptions`](#encoderoptions) | Encoder options to use. |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for video encoding.

##### streamEncoder()

```ts
streamEncoder(options): string[];
```

Returns the video encoder options to use when transcoding for livestreaming.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`EncoderOptions`](#encoderoptions) | Encoder options to use. |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for video encoding.

###### Example

```ts
const args = ffmpegOpts.streamEncoder(encoderOptions);
```

##### videoDecoder()

```ts
videoDecoder(codec): string[];
```

Returns the video decoder arguments to use for decoding video.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `codec` | `string` | `"h264"` | Optional. Codec to decode (`"av1"`, `"h264"` (default), or `"hevc"`). |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for video decoding or an empty array if the codec isn't supported.

###### Example

```ts
const args = ffmpegOpts.videoDecoder("h264");
```

***

### EncoderOptions

Options used for configuring video encoding in FFmpeg operations.

These options control output bitrate, framerate, resolution, H.264 profile and level, input framerate, and smart quality optimizations.

#### Example

```ts
const encoderOptions: EncoderOptions = {

  bitrate: 3000,
  fps: 30,
  hardwareDecoding: true,
  hardwareTranscoding: true,
  height: 1080,
  idrInterval: 2,
  inputFps: 30,
  level: H264Level.LEVEL4_0,
  profile: H264Profile.HIGH,
  smartQuality: true,
  width: 1920
};

// Use with FfmpegOptions for transcoding or streaming.
const ffmpegOpts = new FfmpegOptions(optionsConfig);
const args = ffmpegOpts.streamEncoder(encoderOptions);
```

#### See

 - FfmpegOptions
 - [FFmpeg Codecs Documentation](https://ffmpeg.org/ffmpeg-codecs.html)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bitrate"></a> `bitrate` | `number` | Target video bitrate, in kilobits per second. |
| <a id="fps"></a> `fps` | `number` | Target output frames per second. |
| <a id="hardwaredecoding"></a> `hardwareDecoding?` | `boolean` | Optional. If `true`, encoder options will account for hardware decoding (primarily for Intel QSV scenarios). Defaults to `true`. |
| <a id="hardwaretranscoding"></a> `hardwareTranscoding?` | `boolean` | - |
| <a id="height"></a> `height` | `number` | Output video height, in pixels. |
| <a id="idrinterval"></a> `idrInterval` | `number` | Interval (in seconds) between keyframes (IDR frames). |
| <a id="inputfps"></a> `inputFps` | `number` | Input (source) frames per second. |
| <a id="level"></a> `level` | `H264Level` | H.264 profile level for output. |
| <a id="profile"></a> `profile` | `H264Profile` | H.264 profile for output. |
| <a id="smartquality"></a> `smartQuality?` | `boolean` | Optional and applicable only when not using hardware acceleration. If `true`, enables smart quality and variable bitrate optimizations. Defaults to `true`. |
| <a id="width"></a> `width` | `number` | Output video width, in pixels. |

***

### FfmpegOptionsConfig

Configuration options for `FfmpegOptions`, defining transcoding, decoding, logging, and hardware acceleration settings.

#### Example

```ts
const optionsConfig: FfmpegOptionsConfig = {

  codecSupport: ffmpegCodecs,
  crop: { width: 1, height: 1, x: 0, y: 0 },
  debug: false,
  hardwareDecoding: true,
  hardwareTranscoding: true,
  log,
  name: () => "Camera"
};
```

#### See

FfmpegOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="codecsupport-1"></a> `codecSupport` | [`FfmpegCodecs`](codecs.md#ffmpegcodecs) | FFmpeg codec capabilities and hardware support. |
| <a id="crop"></a> `crop?` | \{ `height`: `number`; `width`: `number`; `x`: `number`; `y`: `number`; \} | Optional. Cropping rectangle for output video. |
| `crop.height` | `number` | - |
| `crop.width` | `number` | - |
| `crop.x` | `number` | - |
| `crop.y` | `number` | - |
| <a id="debug-1"></a> `debug` | `boolean` | Enable debug logging. |
| <a id="hardwaredecoding-1"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. |
| <a id="hardwaretranscoding-1"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video encoding if available. |
| <a id="log-1"></a> `log` | \| [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) \| `Logging` | Logging interface for output and errors. |
| <a id="name-1"></a> `name` | () => `string` | Function returning the name or label for this options set. |
