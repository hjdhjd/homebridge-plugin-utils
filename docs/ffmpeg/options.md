[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/options

# ffmpeg/options

Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system.

This module defines interfaces and classes for specifying, adapting, and generating FFmpeg command-line arguments tailored to the host system's capabilities. It
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
const encoderOptions: VideoEncoderOptions = {

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

 - AudioEncoderOptions
 - VideoEncoderOptions
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

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="audiodecoder"></a> `audioDecoder` | `readonly` | `string` | `"libfdk_aac"` | Returns the audio decoder to use when decoding. |
| <a id="config"></a> `config` | `readonly` | [`FfmpegOptionsConfig`](#ffmpegoptionsconfig-1) | `undefined` | The configuration options used to initialize this instance. This is the single stored state on `FfmpegOptions`: every other public field on this class is either a getter that forwards to `this.config`, or a fixed constant independent of it (`audioDecoder`), so external callers have exactly one canonical path to each config-backed value and internal code never has to keep a parallel field in sync with `config` at construction time. |

#### Accessors

##### cropFilter

###### Get Signature

```ts
get cropFilter(): string;
```

Returns the FFmpeg crop filter string, or a default no-op filter if cropping is disabled.

###### Returns

`string`

The crop filter string for FFmpeg.

##### debug

###### Get Signature

```ts
get debug(): boolean;
```

Indicates if debug logging is enabled. Normalizes `undefined` to `false` so callers always see a definite boolean regardless of whether the config object set
the field explicitly.

###### Returns

`boolean`

##### hardwareDownloadFilters

###### Get Signature

```ts
get hardwareDownloadFilters(): string[];
```

Returns the platform-appropriate FFmpeg video filters needed to transfer hardware-decoded frames to system memory. When hardware decoding is active, decoded frames
may reside on the GPU and require explicit download before CPU-based filters (crop, scale, format conversion) can operate on them. Returns an empty array when
hardware decoding is disabled or when the platform handles the transfer implicitly (e.g. Raspberry Pi).

###### Returns

`string`[]

An array of FFmpeg filter strings to prepend to a video filter chain, or an empty array if no transfer is needed.

##### log

###### Get Signature

```ts
get log(): Logger;
```

Logging interface for output and errors.

###### Returns

[`Logger`](../util.md#logger)

##### name

###### Get Signature

```ts
get name(): () => string;
```

Function returning the name for this options instance to be used for logging.

###### Returns

() => `string`

#### Methods

##### audioEncoder()

```ts
audioEncoder(options?): string[];
```

Returns the audio encoder arguments to use when transcoding.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`AudioEncoderOptions`](#audioencoderoptions) | Optional. The encoder options to use for generating FFmpeg arguments. |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for audio encoding.

###### Example

```ts
const args = ffmpegOpts.audioEncoder();
```

##### hardwareEncodes()

```ts
hardwareEncodes(context): boolean;
```

Reports whether the given transcode context runs on the host's hardware encoder in this instance's resolved configuration. Live streaming uses the hardware
encoder whenever transcoding is resolved on; HKSV recording additionally excludes Raspberry Pi, whose h264_v4l2m2m encoder is unreliable for event recording - a
matter separate from the FFmpeg-7+ h264_v4l2m2m decoder regression noted in #configureRaspbianHwAccel, which affects decoding only. The answer reads the resolved
class config set in the constructor by #configureHwAccel, before any encoder method is callable.

The encoder choice, the source ceiling, and any consumer narration or policy all read this one predicate, so they can never disagree about a given context, and
relaxing the raspbian exclusion here flips every one of them together with no consumer change.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `context` | [`EncoderContext`](#encodercontext) | The transcode context whose hardware-encoder use is queried. |

###### Returns

`boolean`

`true` when `context` runs on the host's hardware encoder in the resolved configuration, `false` when it software-encodes.

##### maxSourcePixels()

```ts
maxSourcePixels(context): number;
```

Returns the maximum source pixel count the host's hardware transcode pipeline can ingest for the given encoding context, or `Infinity` when unconstrained.

Only Raspberry Pi's GPU imposes a real limit; every other host is unconstrained. A context is capped only when it actually runs on that hardware path - so today live
streaming on a Pi returns the RPi ceiling while recording on a Pi returns `Infinity` (it software-encodes). Consumers apply this value blindly; the "why" lives here.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `context` | [`EncoderContext`](#encodercontext) | The encoding context whose ceiling is requested. |

###### Returns

`number`

Maximum supported source pixel count for `context`.

##### recordEncoder()

```ts
recordEncoder(options): string[];
```

Returns the video encoder options to use for HomeKit Secure Video (HKSV) event recording.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`VideoEncoderOptions`](#videoencoderoptions) | Encoder options to use. |

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
| `options` | [`VideoEncoderOptions`](#videoencoderoptions) | Encoder options to use. |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for video encoding.

###### Example

```ts
const args = ffmpegOpts.streamEncoder(encoderOptions);
```

##### videoDecoder()

```ts
videoDecoder(codec?): string[];
```

Returns the video decoder arguments to use for decoding video.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `codec` | `string` | `"h264"` | Optional. Codec to decode (`"av1"`, `"h264"` (default), or `"hevc"`; `"h265"` is accepted as an alias for `"hevc"`, and codec matching is case-insensitive). |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for video decoding or an empty array if the codec isn't supported.

###### Example

```ts
const args = ffmpegOpts.videoDecoder("h264");
```

***

### AudioEncoderOptions

Options used for configuring audio encoding in FFmpeg operations.

The single field selects the AAC profile that drives encoder-specific arg emission in [FfmpegOptions.audioEncoder](#audioencoder) - AAC-ELD (the HomeKit Secure Video event-
recording default, lower bitrate, low-latency) versus AAC-LC (higher-quality livestream variant). The chosen profile maps to `aac_at` mode switches on macOS and to
`libfdk_aac` flags elsewhere.

#### Example

```ts
const encoderOptions: AudioEncoderOptions = {

  codec: AudioRecordingCodecType.AAC_ELD
};

// Use with FfmpegOptions for transcoding.
const ffmpegOpts = new FfmpegOptions(optionsConfig);
const args = ffmpegOpts.audioEncoder(encoderOptions);
```

#### See

FfmpegOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="codec"></a> `codec?` | `AudioRecordingCodecType` | Optional. AAC profile to encode (`AudioRecordingCodecType.AAC_ELD` or `AudioRecordingCodecType.AAC_LC`). Defaults to `AudioRecordingCodecType.AAC_ELD`. |

***

### FfmpegOptionsConfig

Configuration options for `FfmpegOptions`, defining transcoding, decoding, logging, and hardware acceleration settings.

#### Remarks

The `hardwareDecoding` and `hardwareTranscoding` flags are bidirectional. On input, they express the caller's desired hardware acceleration state. During
`FfmpegOptions` construction, the flags are resolved against the host's actual capabilities and the config object is mutated in place to reflect what is available.
After construction, these flags represent the resolved state...`hardwareDecoding` or `hardwareTranscoding` may be set to `false` if the required codecs or
accelerators are absent, or `hardwareDecoding` may be set to `true` if Intel Quick Sync Video is detected even when not explicitly requested.

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
| <a id="codecsupport"></a> `codecSupport` | [`FfmpegCodecs`](codecs.md#ffmpegcodecs) | FFmpeg codec capabilities and hardware support. |
| <a id="crop"></a> `crop?` | \{ `height`: `number`; `width`: `number`; `x`: `number`; `y`: `number`; \} | Optional. Cropping rectangle for output video. |
| `crop.height` | `number` | - |
| `crop.width` | `number` | - |
| `crop.x` | `number` | - |
| `crop.y` | `number` | - |
| <a id="debug-1"></a> `debug?` | `boolean` | Optional. Enable debug logging. |
| <a id="hardwaredecoding"></a> `hardwareDecoding` | `boolean` | Enable hardware-accelerated video decoding if available. |
| <a id="hardwaretranscoding"></a> `hardwareTranscoding` | `boolean` | Enable hardware-accelerated video encoding if available. |
| <a id="log-1"></a> `log` | [`Logger`](../util.md#logger) | Logging interface for output and errors. |
| <a id="name-1"></a> `name` | () => `string` | Function returning the name or label for this options set. |

***

### VideoEncoderOptions

Options used for configuring video encoding in FFmpeg operations.

These options control output bitrate, framerate, resolution, H.264 profile and level, input framerate, and smart quality optimizations.

#### Example

```ts
const encoderOptions: VideoEncoderOptions = {

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
| <a id="hardwaredecoding-1"></a> `hardwareDecoding?` | `boolean` | Optional. If `true`, the emitted encoder args assume the input stream has already been hardware-decoded (the GPU holds the frames). Used by the transfer-filter logic to decide between `hwupload`, `hwdownload`, or neither. Defaults to the resolved `FfmpegOptionsConfig.hardwareDecoding` value on the owning `FfmpegOptions` instance. |
| <a id="hardwaretranscoding-1"></a> `hardwareTranscoding?` | `boolean` | Optional. If `true`, the emitted args select a hardware-accelerated encoder (`h264_videotoolbox` / `h264_qsv` / `h264_v4l2m2m`) and the matching filter pipeline. If `false`, the args fall back to the libx264 software encoder. Defaults to the resolved `FfmpegOptionsConfig.hardwareTranscoding` value on the owning `FfmpegOptions` instance. |
| <a id="height"></a> `height` | `number` | Output video height, in pixels. |
| <a id="idrinterval"></a> `idrInterval` | `number` | Interval (in seconds) between keyframes (IDR frames). |
| <a id="inputfps"></a> `inputFps` | `number` | Input (source) frames per second. |
| <a id="level"></a> `level` | `H264Level` | H.264 profile level for output. |
| <a id="profile"></a> `profile` | `H264Profile` | H.264 profile for output. |
| <a id="smartquality"></a> `smartQuality?` | `boolean` | Optional. Enables variable-bitrate quality-constrained encoding on encoders that support it - libx264 (`-crf 20`), Apple Silicon VideoToolbox (`-q:v 90`), and Intel QSV (`-global_quality 20`). Intel VideoToolbox and v4l2m2m have no quality-constraint mode and always emit a fixed `-b:v` regardless. In all cases, `smartQuality` also adds `HOMEKIT_STREAMING_HEADROOM` to `-maxrate`, giving the encoder a narrow band of variation above the target bitrate. Defaults to `true`. |
| <a id="videofilters"></a> `videoFilters?` | readonly `string`[] | Optional. Caller-supplied CPU-side video filters appended at the tail of the composed filter chain, in caller order. When the encoder's own chain leaves frames GPU-resident at that point, the encoder inserts its platform's download transfer first, so callers never reason about GPU residency. Omitted or empty means the chain is exactly the encoder's own. |
| <a id="width"></a> `width` | `number` | Output video width, in pixels. |

***

### EncoderContext

```ts
type EncoderContext = "record" | "stream";
```

Every hardware-transcode context this module distinguishes, each with a source-pixel ceiling that can differ on a given host. Live streaming and HKSV recording
both transcode, but a host may admit one context to its hardware encoder and not the other (today: Raspberry Pi runs live transcoding on h264_v4l2m2m but falls
HKSV recording back to libx264). Consumed by `maxSourcePixels` and the `recordEncoder` software-fallback so both derive the same per-context hardware-capability
answer from one predicate.
