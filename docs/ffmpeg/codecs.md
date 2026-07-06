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

Construct via the static factory [FfmpegCodecs.probe](#probe) to run the live probe pipeline, or via [FfmpegCodecs.fromState](#fromstate) to inject pre-assembled state
(tests, cached capability data). Instances are immutable value objects - every getter and predicate reads from a frozen [FfmpegCodecsState](#ffmpegcodecsstate) snapshot
assembled at construction, so callers holding a reference know its state cannot shift underneath them.

#### Example

```ts
const codecs = await FfmpegCodecs.probe({ ffmpegExec: "ffmpeg", log: console, verbose: true });

if(codecs) {

  console.log("Available FFmpeg version:", codecs.ffmpegVersion);

  if(codecs.hasDecoder("h264", "h264_v4l2m2m")) {

    console.log("Hardware H.264 decoder is available.");
  }
}
```

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

##### ffmpegExec

###### Get Signature

```ts
get ffmpegExec(): string;
```

The path or command name used to invoke FFmpeg.

###### Returns

`string`

##### ffmpegMajorVersion

###### Get Signature

```ts
get ffmpegMajorVersion(): number;
```

Returns the detected FFmpeg major version as a number, or `0` when detection failed or the version string doesn't begin with an integer. Useful for display
("Running FFmpeg 8") and for callers that need the raw major number. Use [ffmpegAtLeast](#ffmpegatleast) for version-gating comparisons so all version logic flows through
a single boundary-correct comparison primitive.

###### Returns

`number`

The major version number (e.g., `6`, `7`, `8`, `10`), or `0` if the version is unknown or non-numeric.

##### ffmpegVersion

###### Get Signature

```ts
get ffmpegVersion(): string;
```

Returns the detected FFmpeg version string. `"unknown"` when the probe ran but the `ffmpeg version X Copyright...` line was not found in stdout. Any other value
is the literal version string reported by the binary and may carry suffixes (`"8.1.1-tessus"`, `"4.4.2-0ubuntu0.22.04.1"`, etc.). For version-comparison decisions,
prefer [ffmpegAtLeast](#ffmpegatleast) over parsing this string directly.

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

Returns the host system type we are running on as one of `"generic"`, `"macOS.Apple"`, `"macOS.Intel"`, or `"raspbian"`.

###### Remarks

We are only trying to detect host capabilities to the extent they impact which FFmpeg options we are going to use.

###### Returns

`string`

##### verbose

###### Get Signature

```ts
get verbose(): boolean;
```

Indicates whether verbose logging is enabled for FFmpeg probing and downstream consumers.

###### Returns

`boolean`

#### Methods

##### ffmpegAtLeast()

```ts
ffmpegAtLeast(
   major, 
   minor?, 
   patch?): boolean;
```

Return `true` when the detected FFmpeg build is at least the requested version. Compares major, then minor, then patch - the canonical semver ordering. This is
the single source of truth for version-gating decisions across the library; callers prefer this over hand-rolled comparisons so the boundary logic (major-equal
but minor-greater means "newer", etc.) lives in one place and stays consistent.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `major` | `number` | `undefined` | The minimum major version to accept. |
| `minor` | `number` | `0` | The minimum minor version, when major is equal. Defaults to `0`. |
| `patch` | `number` | `0` | The minimum patch version, when major and minor are equal. Defaults to `0`. |

###### Returns

`boolean`

`true` if the detected version is >= the requested version; `false` otherwise. Returns `false` for unknown or unparseable version strings (major = 0).

###### Example

```ts
if(codecs.ffmpegAtLeast(8)) {

  // FFmpeg 8.0.0 or later.
}

if(codecs.ffmpegAtLeast(8, 1)) {

  // FFmpeg 8.1.0 or later.
}
```

##### hasDecoder()

```ts
hasDecoder(codec, decoder): boolean;
```

Checks whether a specific decoder is available for a given codec.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `codec` | `string` | The codec name, e.g., `"h264"`. |
| `decoder` | `string` | The decoder name to check for, e.g., `"h264_qsv"`. |

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
| `codec` | `string` | The codec name, e.g., `"h264"`. |
| `encoder` | `string` | The encoder name to check for, e.g., `"h264_videotoolbox"`. |

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

Checks whether a given hardware acceleration method is available and validated on the host, as provided by the output of `ffmpeg -hwaccels` and the per-accel
capability probe.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accel` | `string` | The hardware acceleration method name, e.g., `"videotoolbox"`. |

###### Returns

`boolean`

`true` if the hardware acceleration method is available, `false` otherwise.

###### Example

```ts
if(codecs.hasHwAccel("videotoolbox")) {

  // Hardware acceleration is supported.
}
```

##### fromState()

```ts
static fromState(state): FfmpegCodecs;
```

Sync factory. Wraps a pre-assembled [FfmpegCodecsState](#ffmpegcodecsstate) in a `FfmpegCodecs` instance without running any probes. Intended for tests that build a stand-in
capability snapshot and for plugins that cache probe results across restarts and want to rehydrate the class without re-probing.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `state` | [`FfmpegCodecsState`](#ffmpegcodecsstate) | Fully-assembled capability snapshot. |

###### Returns

[`FfmpegCodecs`](#ffmpegcodecs)

A populated `FfmpegCodecs` instance backed by the supplied state.

###### Example

```ts
const codecs = FfmpegCodecs.fromState({

  codecs: {},
  cpuGeneration: 0,
  ffmpegExec: "ffmpeg",
  ffmpegVersion: "8.0",
  ffmpegVersionParts: parseFfmpegVersionParts("8.0"),
  gpuMem: 0,
  hostSystem: "macOS.Apple",
  hwAccels: new Set([ "videotoolbox" ]),
  verbose: false
});
```

##### probe()

```ts
static probe(options, init?): Promise<FfmpegCodecs | null>;
```

Async factory. Runs the full probe pipeline (host-system detection, optional Raspberry Pi GPU memory, FFmpeg version + codec inventory + hardware-accel inventory
with per-accel capability validation) and returns a populated instance on success, or `null` when any required probe fails. Every inner probe runs under a
watchdog timeout so a slow or hung FFmpeg binary cannot stall the caller indefinitely; the optional `init.signal` composes with that timeout so callers can cancel
probing from outside (for example, during plugin shutdown).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FOptions`](#foptions) | Options used to configure the probe (FFmpeg executable, logger, verbose flag). |
| `init` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional probe options. `signal` cancels in-flight probes; the per-call watchdog still applies. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`FfmpegCodecs`](#ffmpegcodecs) \| `null`\>

A promise that resolves to a populated `FfmpegCodecs` instance, or `null` if probing failed.

###### Example

```ts
const codecs = await FfmpegCodecs.probe({ log: plugin.log }, { signal: shutdown.signal });

if(!codecs) {

  plugin.log.error("FFmpeg probing failed.");
}
```

***

### FfmpegCodecsState

Immutable state shape that a populated `FfmpegCodecs` instance holds. Produced by [FfmpegCodecs.probe](#probe) from live probing, or by [FfmpegCodecs.fromState](#fromstate)
for callers that already have the capability data (tests, cached probe results, plugin-side injection of pre-computed capabilities). The state is the single source
of truth for every getter and predicate on the class - the instance is a thin accessor facade.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="codecs"></a> `codecs` | `readonly` | `Readonly`\<`Record`\<`string`, \{ `decoders`: `ReadonlySet`\<`string`\>; `encoders`: `ReadonlySet`\<`string`\>; \}\>\> | Format-keyed index of advertised decoders and encoders. |
| <a id="cpugeneration-1"></a> `cpuGeneration` | `readonly` | `number` | Detected CPU generation for Intel Linux hosts and Apple Silicon macOS hosts; `0` when unknown. |
| <a id="ffmpegexec-1"></a> `ffmpegExec` | `readonly` | `string` | The path or command used to invoke FFmpeg. |
| <a id="ffmpegversion-1"></a> `ffmpegVersion` | `readonly` | `string` | FFmpeg version string as reported by `ffmpeg -version`; `"unknown"` when the version line was absent. |
| <a id="ffmpegversionparts"></a> `ffmpegVersionParts` | `readonly` | [`FfmpegVersionParts`](#ffmpegversionparts-1) | Pre-parsed numeric triple derived from `ffmpegVersion`; produced by [parseFfmpegVersionParts](#parseffmpegversionparts). |
| <a id="gpumem-1"></a> `gpuMem` | `readonly` | `number` | Raspberry Pi GPU memory in megabytes (from `vcgencmd get_mem gpu`); `0` on non-RPi hosts. |
| <a id="hostsystem-1"></a> `hostSystem` | `readonly` | `string` | `"generic"`, `"macOS.Apple"`, `"macOS.Intel"`, or `"raspbian"`. |
| <a id="hwaccels"></a> `hwAccels` | `readonly` | `ReadonlySet`\<`string`\> | Advertised and capability-validated hardware accelerator names in lowercase. |
| <a id="verbose-1"></a> `verbose` | `readonly` | `boolean` | Controls verbose logging behavior propagated to consumers. |

***

### FfmpegVersionParts

A parsed FFmpeg version, split into its numeric triple. Produced by [parseFfmpegVersionParts](#parseffmpegversionparts); consumed by [ffmpegVersionAtLeast](#ffmpegversionatleast).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="major"></a> `major` | `number` | The leading integer (e.g., 6, 7, 8, 10). 0 when the version string doesn't begin with a digit. |
| <a id="minor"></a> `minor` | `number` | The second numeric segment. 0 when absent or non-numeric. |
| <a id="patch"></a> `patch` | `number` | The third numeric segment. 0 when absent or non-numeric. |

***

### FOptions

Options for configuring FFmpeg probing.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ffmpegexec-2"></a> `ffmpegExec?` | `string` | Optional. The path or command used to execute FFmpeg. Defaults to "ffmpeg". |
| <a id="log"></a> `log` | [`Logger`](../util.md#logger) | Logging interface for output and errors. |
| <a id="verbose-2"></a> `verbose?` | `boolean` | Optional. Enables or disables verbose logging output. Defaults to `false`. |

***

### ffmpegVersionAtLeast()

```ts
function ffmpegVersionAtLeast(
   parts, 
   major, 
   minor?, 
   patch?): boolean;
```

Return `true` when `parts` represents an FFmpeg version at least as new as the requested major/minor/patch. Compares major, then minor, then patch - the canonical
semver ordering. This is the single source of truth for version-gating comparisons across the library; both the `FfmpegCodecs.ffmpegAtLeast` instance method and the
test-side fixtures delegate here so the boundary logic lives in one implementation.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `parts` | [`FfmpegVersionParts`](#ffmpegversionparts-1) | `undefined` | A parsed version triple as produced by [parseFfmpegVersionParts](#parseffmpegversionparts). |
| `major` | `number` | `undefined` | The minimum major version to accept. |
| `minor` | `number` | `0` | The minimum minor version, when major is equal. Defaults to `0`. |
| `patch` | `number` | `0` | The minimum patch version, when major and minor are equal. Defaults to `0`. |

#### Returns

`boolean`

`true` if `parts` is >= the requested version; `false` otherwise.

#### Example

```ts
const parts = parseFfmpegVersionParts("8.1.2");

ffmpegVersionAtLeast(parts, 8);        // true - 8.1.2 >= 8.0.0
ffmpegVersionAtLeast(parts, 8, 1, 3);  // false - 8.1.2 < 8.1.3
ffmpegVersionAtLeast(parts, 9);        // false - 8.1.2 < 9.0.0
```

***

### parseFfmpegCodecs()

```ts
function parseFfmpegCodecs(stdout): Record<string, {
  decoders: Set<string>;
  encoders: Set<string>;
}>;
```

Parse the stdout of `ffmpeg -codecs` into a format-keyed index of decoders and encoders. Both sets are lowercased for case-insensitive `hasDecoder` /
`hasEncoder` lookups. Formats with only decoders or only encoders still produce a full entry (the opposite set is simply empty).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `stdout` | `string` | Captured stdout from `ffmpeg -hide_banner -codecs`. |

#### Returns

`Record`\<`string`, \{
  `decoders`: `Set`\<`string`\>;
  `encoders`: `Set`\<`string`\>;
\}\>

A record keyed by codec format, each entry carrying the decoders and encoders reported for that format.

***

### parseFfmpegHwAccels()

```ts
function parseFfmpegHwAccels(stdout): string[];
```

Parse the stdout of `ffmpeg -hwaccels` and return the list of hardware-acceleration method names in lowercase, in the order they appeared. Skips blank lines and
the leading `"Hardware acceleration methods:"` banner.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `stdout` | `string` | Captured stdout from `ffmpeg -hide_banner -hwaccels`. |

#### Returns

`string`[]

Lowercased acceleration method names, one per entry.

***

### parseFfmpegVersion()

```ts
function parseFfmpegVersion(stdout): string;
```

Parse the stdout of `ffmpeg -version` and return the version string. Returns `"unknown"` when the expected `"ffmpeg version X Copyright..."` line is not found -
matching the behavior of the class-level probe, which records the literal `"unknown"` when it cannot identify the binary.

Exposed as a module-scope helper (rather than remaining a closure inside the class) so the parse logic is unit-testable against fixture strings without spinning up
the probe plumbing.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `stdout` | `string` | Captured stdout from `ffmpeg -hide_banner -version`. |

#### Returns

`string`

The version string, or `"unknown"` if the version line is absent.

***

### parseFfmpegVersionParts()

```ts
function parseFfmpegVersionParts(version): FfmpegVersionParts;
```

Parse an FFmpeg version string into its numeric triple. Splits on `.` and `-` so real-world version strings parse correctly across release tarballs ("8.1.1"),
distributor suffixes ("8.1.1-tessus"), distro packages ("4.4.2-0ubuntu0.22.04.1"), and git snapshots ("N-123456-gabcdef"). Any non-numeric segment yields `0` via the
`|| 0` fallback, which gives a safe, conservative result: an unknown build parses as `{ major: 0, minor: 0, patch: 0 }` and fails every [ffmpegVersionAtLeast](#ffmpegversionatleast)
check where the requested major is >= 1.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `version` | `string` | An FFmpeg version string as produced by [parseFfmpegVersion](#parseffmpegversion) or by `FfmpegCodecs.ffmpegVersion`. |

#### Returns

[`FfmpegVersionParts`](#ffmpegversionparts-1)

The parsed numeric triple.

#### Example

```ts
parseFfmpegVersionParts("8.1.1");            // { major: 8, minor: 1, patch: 1 }
parseFfmpegVersionParts("8.1.1-tessus");     // { major: 8, minor: 1, patch: 1 }
parseFfmpegVersionParts("N-123456-gabcdef"); // { major: 0, minor: 123456, patch: 0 }  - git snapshot, effectively "unknown"
parseFfmpegVersionParts("unknown");          // { major: 0, minor: 0, patch: 0 }
```

***

### parseRpiGpuMem()

```ts
function parseRpiGpuMem(stdout): number;
```

Parse the stdout of `vcgencmd get_mem gpu` into a megabyte value. Returns `0` when the expected `gpu=<N>M` shape is absent or the captured digits fail integer
parsing - matching the class-level fallback.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `stdout` | `string` | Captured stdout from `vcgencmd get_mem gpu`. |

#### Returns

`number`

The reported GPU memory size in megabytes, or `0` when the value could not be read.
