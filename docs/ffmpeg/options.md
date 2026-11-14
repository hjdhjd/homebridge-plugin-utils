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
- Dynamically generates the appropriate FFmpeg command-line arguments for livestreaming, HomeKit Secure Video (HKSV) event recording, and crop and fit filters.
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

// Generate the scale filter that fits a frame inside a requested size, as every transcode chain here scales.
const fit = ffmpegOpts.fitFilter({ height: 1080, width: 1920 });
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
| <a id="audiodecoder"></a> `audioDecoder` | `public readonly` | `string` | `"libfdk_aac"` | The fixed FFmpeg audio decoder used when decoding. |
| <a id="config"></a> `config` | `public readonly` | [`FfmpegOptionsConfig`](#ffmpegoptionsconfig-1) | `undefined` | The configuration options used to initialize this instance. This is the one stored configuration on `FfmpegOptions`: every config-backed public field on this class is a getter that forwards to `this.config`, so external callers have exactly one canonical path to each config-backed value and internal code never has to keep a parallel field in sync with `config` at construction time. Beside it the instance holds a fixed constant (`audioDecoder`) and what it learns at runtime rather than from its configuration: whether the host's hardware video decoder has refused its source (see `hardwareDecoderRefused`). |

#### Accessors

##### clock

###### Get Signature

```ts
get clock(): Clock | undefined;
```

The time source the callback timers of this session's processes are armed on, or `undefined` when the consumer configured none. Handed on unresolved, so each
primitive that arms a timer applies the `systemClock` default in the one place that default belongs.

###### Returns

[`Clock`](../clock.md#clock) \| `undefined`

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

##### hardwareDecoderRefused

###### Get Signature

```ts
get hardwareDecoderRefused(): boolean;
```

Whether the host's hardware video decoder has refused this instance's source. A refusal is FFmpeg reporting that its hardware decoder could not be set up for the
stream it was handed, which a decoder can do for a stream whose codec it otherwise takes, such as one whose frame size is beyond what it opens. While the mark
stands, every pipeline this instance describes decodes in software, exactly as one whose caller passed `hardwareDecoding: false`. The mark lasts until
`resetHardwareDecoderRefusal` or a new instance, and a consumer resets it when its source's dimensions or codec change.

###### Returns

`boolean`

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
| `options?` | [`AudioEncoderOptions`](#audioencoderoptions) | Optional. The encoder options to use for generating FFmpeg arguments. |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for audio encoding.

###### Example

```ts
const args = ffmpegOpts.audioEncoder();
```

##### fitFilter()

```ts
fitFilter(size): string;
```

Returns the FFmpeg scale filter string that fits a frame inside a requested width and height. The output keeps the source's aspect ratio, is never larger than the
source, and has even dimensions. Every transcode chain this class builds scales by this same rule, so a consumer composing its own chain, such as a snapshot
that follows `cropFilter` with it, receives the size a livestream or recording at that request would carry.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `size` | `Pick`\<[`VideoEncoderOptions`](#videoencoderoptions), `"height"` \| `"width"`\> | The width and height, in pixels, the output fits inside. A caller may pass the `VideoEncoderOptions` it already holds. |

###### Returns

`string`

The scale filter string for FFmpeg.

###### Example

```ts
// A filter chain that crops as configured and then fits the result inside 1920x1080.
const filters = [ ffmpegOpts.cropFilter, ffmpegOpts.fitFilter({ height: 1080, width: 1920 }) ].join(", ");
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

##### markHardwareDecoderRefusal()

```ts
markHardwareDecoderRefusal(): void;
```

Record that the host's hardware video decoder refused this instance's source. A refusal is FFmpeg reporting that its hardware decoder could not be set up for the
stream it was handed, and every `FfmpegProcess` built over this instance calls this when its stderr carries that report, whether or not the process then fails.
From then on every pipeline this instance describes decodes in software and, where it encodes on hardware, uploads its frames to the encoder, exactly as one whose
caller passed `hardwareDecoding: false`. The first call since construction or a reset logs the change at info, and a repeat does nothing. The mark lasts until
`resetHardwareDecoderRefusal` or a new instance, and a consumer resets it when its source's dimensions or codec change.

###### Returns

`void`

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

##### resetHardwareDecoderRefusal()

```ts
resetHardwareDecoderRefusal(): void;
```

Clear a recorded refusal by the host's hardware video decoder, so the pipelines this instance describes decode on hardware again wherever its configuration and
the source's codec allow. A refusal is FFmpeg reporting that its hardware decoder could not be set up for the stream it was handed, and its mark lasts until this
call or a new instance. A consumer resets when its source's dimensions or codec change, since the refusal answered the source as it was, and a later refusal of
the changed source marks the instance again. A refusal never touches the class config, so a reset restores exactly what construction resolved.

###### Returns

`void`

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
videoDecoder(options?): string[];
```

Returns the video decoder arguments to use for decoding video.

Whether the decoder runs on hardware and where it leaves its frames depend on the whole pipeline - the source's codec, the hardware flags, and what consumes the
frames next - so the decode args are built from the same pipeline description as the rest of the pipeline. The design rule is one object per pipeline, handed to
every builder: a caller passes `videoDecoder` the very options object it gives `streamEncoder` or `recordEncoder`, and the decode and encode sides then cannot
disagree about where the frames are. A pipeline that decodes on hardware and encodes on hardware keeps its frames on the GPU wherever its chain scales there. One
that decodes on hardware and encodes in software - a snapshot, say, which passes `{ hardwareTranscoding: false, inputCodec }` - receives them in system memory, in
the stream's own format, and so does a VideoToolbox pipeline whose caller-supplied filters run its chain on the CPU. A source the host's hardware decoder cannot
take, or has refused on this instance (see `hardwareDecoderRefused`), decodes in software, and the encoder side of the same pipeline uploads the frames it
receives.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | `Pick`\<[`VideoEncoderOptions`](#videoencoderoptions), \| `"hardwareDecoding"` \| `"hardwareTranscoding"` \| `"inputCodec"` \| `"videoFilters"`\> | Optional. The pipeline's description - typically the `VideoEncoderOptions` the caller hands its encoder. Its source codec, its hardware flags, and its caller-supplied filters decide whether the decoder runs on hardware and where it leaves its frames. Each flag resolves exactly as the encoders resolve it: an omitted flag takes the class config's value, and a flag the class config has turned off stays off. Omitting the object entirely describes an H.264 source in the pipeline the class config describes, with no caller filters. |

###### Returns

`string`[]

Array of FFmpeg command-line arguments for video decoding, or an empty array when the pipeline decodes in software.

###### Example

```ts
// A livestream: the decoder and the encoder read one pipeline description, source codec included.
const args = [ ...ffmpegOpts.videoDecoder(encoderOptions), ...ffmpegOpts.streamEncoder(encoderOptions) ];

// A snapshot, encoded in software: the decoder hands its frames over in system memory.
const snapshotArgs = ffmpegOpts.videoDecoder({ hardwareTranscoding: false, inputCodec: "hevc" });
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
accelerators are absent, or `hardwareDecoding` may be set to `true` if Intel Quick Sync Video is detected even when not explicitly requested. A later refusal by the
hardware decoder leaves them as construction resolved them, and the pipelines read it from `FfmpegOptions.hardwareDecoderRefused` instead.

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
| <a id="clock-1"></a> `clock?` | [`Clock`](../clock.md#clock) | Optional time source for the callback timers every process built from these options, and every resource those processes compose, arm: the startup watchdog, the streaming health watchdog, and the segment assembler's inter-segment watchdog. Left undefined, each of those falls back to `systemClock` on its own, so the options object carries the choice unresolved exactly as any other composer does. The clock lives here, beside `log` and `debug`, because these options ARE the per-session substrate a consumer configures once and every process, recording, and livestream is then built from, where an init carries per-construction lifetimes instead. A consumer's virtual clock therefore drives every window the process family arms. |
| <a id="codecsupport"></a> `codecSupport` | [`FfmpegCodecs`](codecs.md#ffmpegcodecs) | FFmpeg codec capabilities and hardware support. |
| <a id="crop"></a> `crop?` | \{ `height`: `number`; `width`: `number`; `x`: `number`; `y`: `number`; \} | Optional. Cropping rectangle for output video. Each of `width`, `height`, `x`, and `y` is a fraction of the source frame's corresponding dimension (0 to 1), not a pixel count or a percentage - `{ width: 1, height: 1, x: 0, y: 0 }` selects the full frame, `{ width: 0.5, height: 0.5, x: 0.25, y: 0.25 }` selects its centered quarter-area crop. Crop runs on the CPU, so with a crop configured a hardware decoder hands its frames over in system memory, and a hardware encode uploads the cropped frames. |
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
  inputCodec: "hevc",
  inputFps: 30,
  level: H264Level.LEVEL4_0,
  profile: H264Profile.HIGH,
  smartQuality: true,
  width: 1920
};

// Use with FfmpegOptions for transcoding or streaming. The decoder and the encoder read the same pipeline description.
const ffmpegOpts = new FfmpegOptions(optionsConfig);
const args = [ ...ffmpegOpts.videoDecoder(encoderOptions), ...ffmpegOpts.streamEncoder(encoderOptions) ];
```

#### See

 - FfmpegOptions
 - [FFmpeg Codecs Documentation](https://ffmpeg.org/ffmpeg-codecs.html)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bitrate"></a> `bitrate` | `number` | Target video bitrate, in kilobits per second. |
| <a id="fps"></a> `fps` | `number` | Target output frames per second. |
| <a id="hardwaredecoding-1"></a> `hardwareDecoding?` | `boolean` | Optional. If `true`, the pipeline decodes on hardware wherever the host's hardware decoder can take `inputCodec` and has not refused the owning instance's source (see `FfmpegOptions.hardwareDecoderRefused`), and in software elsewhere. Together with `hardwareTranscoding` it decides where the decoded frames live: a hardware decode feeding a hardware encode keeps them on the GPU, and a hardware decode feeding a software encode hands them over in system memory. Defaults to the resolved `FfmpegOptionsConfig.hardwareDecoding` value on the owning `FfmpegOptions` instance. |
| <a id="hardwaretranscoding-1"></a> `hardwareTranscoding?` | `boolean` | Optional. If `true`, the emitted args select a hardware-accelerated encoder (`h264_videotoolbox` / `h264_qsv` / `h264_v4l2m2m`) and the matching filter pipeline. If `false`, the args fall back to the libx264 software encoder. Defaults to the resolved `FfmpegOptionsConfig.hardwareTranscoding` value on the owning `FfmpegOptions` instance. |
| <a id="height"></a> `height` | `number` | Output video height, in pixels. The output fits inside this height and `width` together, keeping the source's aspect ratio, never larger than the source, at even dimensions. |
| <a id="idrinterval"></a> `idrInterval` | `number` | Interval (in seconds) between keyframes (IDR frames). |
| <a id="inputcodec"></a> `inputCodec?` | `string` | Optional. Codec of the source stream the pipeline decodes: `"av1"`, `"h264"`, or `"hevc"` (`"h265"` is accepted as an alias for `"hevc"`, and matching is case-insensitive). The host's hardware decoder takes only some codecs - AV1 needs Apple Silicon M3 or newer with FFmpeg 8, or 11th-generation Intel silicon - and a source it cannot take, or a codec outside that list, decodes in software, so the encoder side needs the codec to know where the frames arrive. Defaults to `"h264"`. |
| <a id="inputfps"></a> `inputFps` | `number` | Input (source) frames per second. |
| <a id="level"></a> `level` | `H264Level` | H.264 profile level for output. |
| <a id="profile"></a> `profile` | `H264Profile` | H.264 profile for output. |
| <a id="smartquality"></a> `smartQuality?` | `boolean` | Optional. Enables variable-bitrate quality-constrained encoding on encoders that support it - libx264 (`-crf 20`), Apple Silicon VideoToolbox (`-q:v 90`), and Intel QSV (`-global_quality 20`). Intel VideoToolbox and v4l2m2m have no quality-constraint mode and always emit a fixed `-b:v` regardless. In all cases, `smartQuality` also adds `HOMEKIT_STREAMING_HEADROOM` to `-maxrate`, giving the encoder a narrow band of variation above the target bitrate. Defaults to `true`. |
| <a id="videofilters"></a> `videoFilters?` | readonly `string`[] | Optional. Caller-supplied CPU-side video filters, run in caller order after the encoder's own crop and scale filters. They always run in system memory - the encoder's chain brings frames there ahead of them and hands their output on to a hardware encoder - so callers never reason about GPU residency. On VideoToolbox they move the whole chain onto the CPU, down to where the decoder hands its frames over, so pass `videoDecoder` this same options object. Omitted or empty means the chain is exactly the encoder's own. |
| <a id="width"></a> `width` | `number` | Output video width, in pixels. The output fits inside this width and `height` together, keeping the source's aspect ratio, never larger than the source, at even dimensions. |

***

### EncoderContext

```ts
type EncoderContext = "record" | "stream";
```

Every hardware-transcode context this module distinguishes, each with a source-pixel ceiling that can differ on a given host. Live streaming and HKSV recording
both transcode, but a host may admit one context to its hardware encoder and not the other (today: Raspberry Pi runs live transcoding on h264_v4l2m2m but falls
HKSV recording back to libx264). Consumed by `maxSourcePixels` and the `recordEncoder` software-fallback so both derive the same per-context hardware-capability
answer from one predicate.
