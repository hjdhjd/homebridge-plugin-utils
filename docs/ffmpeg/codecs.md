[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/codecs

# ffmpeg/codecs

Probe FFmpeg capabilities and codecs on the host system.

Utilities for dynamically probing FFmpeg capabilities on the host system, including codec and hardware acceleration support.

This module provides classes and interfaces to detect which FFmpeg encoders, decoders, and hardware acceleration methods are available, as well as host platform
detection (such as macOS or Raspberry Pi specifics) that directly impact transcoding or livestreaming use cases. It enables advanced plugin development by allowing
dynamic adaptation to the host's video processing features, helping ensure compatibility and optimal performance when working with camera-related Homebridge plugins
that leverage FFmpeg.

Key features include:

- Querying the FFmpeg version, available codecs, and hardware acceleration methods.
- Detecting host hardware platform details that are relevant to transcoding in FFmpeg.
- Checking for the presence of specific encoders/decoders and validating hardware acceleration support.

This module is intended for use by plugin developers or advanced users who need to introspect and adapt to system-level FFmpeg capabilities programmatically.

## FFmpeg

### FfmpegCodecs

Probe FFmpeg capabilities and codecs on the host system.

This class provides methods to check available FFmpeg decoders, encoders, and hardware acceleration methods, as well as to determine system-specific resources such as
GPU memory (on Raspberry Pi). Intended for plugin authors or advanced users needing to assess FFmpeg capabilities dynamically.

#### Example

```ts
const codecs = new FfmpegCodecs({

  ffmpegExec: "ffmpeg",
  log: console,
  verbose: true
});

// Probe system and FFmpeg capabilities.
const ready = await codecs.probe();

if(ready) {

  console.log("Available FFmpeg version:", codecs.ffmpegVersion);

  if(codecs.hasDecoder("h264", "h264_v4l2m2m")) {

    console.log("Hardware H.264 decoder is available.");
  }
}
```

#### Constructors

##### Constructor

```ts
new FfmpegCodecs(options): FfmpegCodecs;
```

Creates an instance of `FfmpegCodecs`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FOptions`](#foptions) | Options used to configure FFmpeg probing. |

###### Returns

[`FfmpegCodecs`](#ffmpegcodecs)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="ffmpegexec"></a> `ffmpegExec` | `readonly` | `string` | The path or command name to invoke FFmpeg. |
| <a id="verbose"></a> `verbose` | `readonly` | `boolean` | Indicates whether verbose logging is enabled for FFmpeg probing. |

#### Accessors

##### cpuGeneration

###### Get Signature

```ts
get cpuGeneration(): number;
```

Returns the CPU generation if we're on Linux and have an Intel processor or on macOS and have an Apple Silicon processor.

###### Returns

`number`

Returns the CPU generation or 0 if it can't be detected or an invalid platform.

##### ffmpegVersion

###### Get Signature

```ts
get ffmpegVersion(): string;
```

Returns the detected FFmpeg version string, or "unknown" if detection failed.

###### Returns

`string`

##### gpuMem

###### Get Signature

```ts
get gpuMem(): number;
```

Returns the amount of GPU memory available on the host system, in megabytes.

###### Remarks

Always returns `0` on non-Raspberry Pi systems.

###### Returns

`number`

##### hostSystem

###### Get Signature

```ts
get hostSystem(): string;
```

Returns the host system type we are running on as one of "generic", "macOS.Apple", "macOS.Intel", or "raspbian".

###### Remarks

We are only trying to detect host capabilities to the extent they impact which FFmpeg options we are going to use.

###### Returns

`string`

#### Methods

##### hasDecoder()

```ts
hasDecoder(codec, decoder): boolean;
```

Checks whether a specific decoder is available for a given codec.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `codec` | `string` | The codec name, e.g., "h264". |
| `decoder` | `string` | The decoder name to check for, e.g., "h264_qsv". |

###### Returns

`boolean`

`true` if the decoder is available for the codec, `false` otherwise.

###### Example

```ts

if(codecs.hasDecoder("h264", "h264_qsv")) {

  // Use hardware decoding.
}
```

##### hasEncoder()

```ts
hasEncoder(codec, encoder): boolean;
```

Checks whether a specific encoder is available for a given codec.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `codec` | `string` | The codec name, e.g., "h264". |
| `encoder` | `string` | The encoder name to check for, e.g., "h264_videotoolbox". |

###### Returns

`boolean`

`true` if the encoder is available for the codec, `false` otherwise.

###### Example

```ts

if(codecs.hasEncoder("h264", "h264_videotoolbox")) {

  // Use hardware encoding.
}
```

##### hasHwAccel()

```ts
hasHwAccel(accel): boolean;
```

Checks whether a given hardware acceleration method is available and validated on the host, as provided by the output of `ffmpeg -hwaccels`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accel` | `string` | The hardware acceleration method name, e.g., "videotoolbox". |

###### Returns

`boolean`

`true` if the hardware acceleration method is available, `false` otherwise.

###### Example

```ts
if(codecs.hasHwAccel("videotoolbox")) {

  // Hardware acceleration is supported.
}
```

##### probe()

```ts
probe(): Promise<boolean>;
```

Probes the host system and FFmpeg executable for capabilities, version, codecs, and hardware acceleration support.

Returns `true` if probing succeeded, otherwise `false`.

###### Returns

`Promise`\<`boolean`\>

A promise that resolves to `true` if probing is successful, or `false` on failure.

###### Example

```ts

const ready = await codecs.probe();

if(!ready) {

  console.log("FFmpeg probing failed.");
}
```

***

### FOptions

Options for configuring FFmpeg probing.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ffmpegexec-1"></a> `ffmpegExec?` | `string` | Optional. The path or command used to execute FFmpeg. Defaults to "ffmpeg". |
| <a id="log"></a> `log` | \| [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) \| `Logging` | Logging interface for output and errors. |
| <a id="verbose-1"></a> `verbose?` | `boolean` | Optional. Enables or disables verbose logging output. Defaults to `false`. |
