[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/hap-enums

# ffmpeg/hap-enums

Mirrors HAP protocol const enum values that HomeKit camera plugins need at value-side runtime. `verbatimModuleSyntax` disallows value imports of ambient const
enums, so the numeric and string contracts from hap-nodejs must be re-declared at value-side. Centralizing the mirrors here gives every consumer a single import
path and a single update point if upstream `hap-nodejs` ever changes a value.

Values MUST stay in lockstep with the upstream definitions in `hap-nodejs/.../RecordingManagement.d.ts`, `hap-nodejs/.../RTPStreamManagement.d.ts`, and
`hap-nodejs/.../DataStreamServer.d.ts`. The matching type aliases let consumers import the canonical names from one place rather than re-declaring them.

## FFmpeg

### AudioRecordingCodecType

```ts
type AudioRecordingCodecType = AudioRecordingCodecTypeEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `codec?: AudioRecordingCodecType` annotations resolve through the shared module rather than
a local redeclaration in each consumer.

***

### AudioRecordingSamplerate

```ts
type AudioRecordingSamplerate = AudioRecordingSamplerateEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `samplerate: AudioRecordingSamplerate` annotations resolve through the shared module rather
than a local redeclaration in each consumer.

***

### AudioStreamingCodecType

```ts
type AudioStreamingCodecType = AudioStreamingCodecTypeEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `type: AudioStreamingCodecType` annotations resolve through the shared module rather than a
local redeclaration in each consumer.

***

### AudioStreamingSamplerate

```ts
type AudioStreamingSamplerate = AudioStreamingSamplerateEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `samplerate: AudioStreamingSamplerate` annotations resolve through the shared module rather
than a local redeclaration in each consumer.

***

### H264Level

```ts
type H264Level = H264LevelEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `levels: H264Level[]` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### H264Profile

```ts
type H264Profile = H264ProfileEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `profiles: H264Profile[]` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### HDSProtocolSpecificErrorReason

```ts
type HDSProtocolSpecificErrorReason = HDSProtocolSpecificErrorReasonEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `reason: HDSProtocolSpecificErrorReason` annotations resolve through the shared module
rather than a local redeclaration in each consumer.

***

### MediaContainerType

```ts
type MediaContainerType = MediaContainerTypeEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `type: MediaContainerType` annotations resolve through the shared module rather than a
local redeclaration in each consumer.

***

### SRTPCryptoSuites

```ts
type SRTPCryptoSuites = SRTPCryptoSuitesEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `suite: SRTPCryptoSuites` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### StreamRequestTypes

```ts
type StreamRequestTypes = StreamRequestTypesEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `type: StreamRequestTypes` annotations resolve through the shared module rather than a
local redeclaration in each consumer.

***

### VideoCodecType

```ts
type VideoCodecType = VideoCodecTypeEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `type: VideoCodecType` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### AudioRecordingCodecType

```ts
const AudioRecordingCodecType: {
  AAC_ELD: AudioRecordingCodecTypeEnum.AAC_ELD;
  AAC_LC: AudioRecordingCodecTypeEnum.AAC_LC;
};
```

Numeric mirror of HAP's `AudioRecordingCodecType` const enum, suitable for runtime indexing into translation tables.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-aac_eld"></a> `AAC_ELD` | `AudioRecordingCodecTypeEnum.AAC_ELD` |
| <a id="property-aac_lc"></a> `AAC_LC` | `AudioRecordingCodecTypeEnum.AAC_LC` |

***

### AudioRecordingSamplerate

```ts
const AudioRecordingSamplerate: {
  KHZ_16: AudioRecordingSamplerateEnum.KHZ_16;
  KHZ_24: AudioRecordingSamplerateEnum.KHZ_24;
  KHZ_32: AudioRecordingSamplerateEnum.KHZ_32;
  KHZ_44_1: AudioRecordingSamplerateEnum.KHZ_44_1;
  KHZ_48: AudioRecordingSamplerateEnum.KHZ_48;
  KHZ_8: AudioRecordingSamplerateEnum.KHZ_8;
};
```

Numeric mirror of HAP's `AudioRecordingSamplerate` const enum, suitable for runtime indexing into translation tables and for constructing recording configurations
by enum name rather than by raw numeric value.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-khz_16"></a> `KHZ_16` | `AudioRecordingSamplerateEnum.KHZ_16` |
| <a id="property-khz_24"></a> `KHZ_24` | `AudioRecordingSamplerateEnum.KHZ_24` |
| <a id="property-khz_32"></a> `KHZ_32` | `AudioRecordingSamplerateEnum.KHZ_32` |
| <a id="property-khz_44_1"></a> `KHZ_44_1` | `AudioRecordingSamplerateEnum.KHZ_44_1` |
| <a id="property-khz_48"></a> `KHZ_48` | `AudioRecordingSamplerateEnum.KHZ_48` |
| <a id="property-khz_8"></a> `KHZ_8` | `AudioRecordingSamplerateEnum.KHZ_8` |

***

### AudioStreamingCodecType

```ts
const AudioStreamingCodecType: {
  AAC_ELD: AudioStreamingCodecTypeEnum.AAC_ELD;
  AMR: AudioStreamingCodecTypeEnum.AMR;
  AMR_WB: AudioStreamingCodecTypeEnum.AMR_WB;
  MSBC: AudioStreamingCodecTypeEnum.MSBC;
  OPUS: AudioStreamingCodecTypeEnum.OPUS;
  PCMA: AudioStreamingCodecTypeEnum.PCMA;
  PCMU: AudioStreamingCodecTypeEnum.PCMU;
};
```

String mirror of HAP's `AudioStreamingCodecType` const enum, surfaced to HomeKit camera streaming delegates when declaring the audio codecs supported on live-stream
sessions.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-aac_eld-1"></a> `AAC_ELD` | `AudioStreamingCodecTypeEnum.AAC_ELD` |
| <a id="property-amr"></a> `AMR` | `AudioStreamingCodecTypeEnum.AMR` |
| <a id="property-amr_wb"></a> `AMR_WB` | `AudioStreamingCodecTypeEnum.AMR_WB` |
| <a id="property-msbc"></a> `MSBC` | `AudioStreamingCodecTypeEnum.MSBC` |
| <a id="property-opus"></a> `OPUS` | `AudioStreamingCodecTypeEnum.OPUS` |
| <a id="property-pcma"></a> `PCMA` | `AudioStreamingCodecTypeEnum.PCMA` |
| <a id="property-pcmu"></a> `PCMU` | `AudioStreamingCodecTypeEnum.PCMU` |

***

### AudioStreamingSamplerate

```ts
const AudioStreamingSamplerate: {
  KHZ_16: AudioStreamingSamplerateEnum.KHZ_16;
  KHZ_24: AudioStreamingSamplerateEnum.KHZ_24;
  KHZ_8: AudioStreamingSamplerateEnum.KHZ_8;
};
```

Numeric mirror of HAP's `AudioStreamingSamplerate` const enum, surfaced to HomeKit camera streaming delegates when declaring the audio sample rates supported on
live-stream sessions.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-khz_16-1"></a> `KHZ_16` | `AudioStreamingSamplerateEnum.KHZ_16` |
| <a id="property-khz_24-1"></a> `KHZ_24` | `AudioStreamingSamplerateEnum.KHZ_24` |
| <a id="property-khz_8-1"></a> `KHZ_8` | `AudioStreamingSamplerateEnum.KHZ_8` |

***

### H264Level

```ts
const H264Level: {
  LEVEL3_1: H264LevelEnum.LEVEL3_1;
  LEVEL3_2: H264LevelEnum.LEVEL3_2;
  LEVEL4_0: H264LevelEnum.LEVEL4_0;
};
```

Numeric mirror of HAP's `H264Level` const enum, surfaced when declaring the H.264 levels a camera codec configuration advertises to HomeKit.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-level3_1"></a> `LEVEL3_1` | `H264LevelEnum.LEVEL3_1` |
| <a id="property-level3_2"></a> `LEVEL3_2` | `H264LevelEnum.LEVEL3_2` |
| <a id="property-level4_0"></a> `LEVEL4_0` | `H264LevelEnum.LEVEL4_0` |

***

### H264Profile

```ts
const H264Profile: {
  BASELINE: H264ProfileEnum.BASELINE;
  HIGH: H264ProfileEnum.HIGH;
  MAIN: H264ProfileEnum.MAIN;
};
```

Numeric mirror of HAP's `H264Profile` const enum, surfaced when declaring the H.264 profiles a camera codec configuration advertises to HomeKit.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-baseline"></a> `BASELINE` | `H264ProfileEnum.BASELINE` |
| <a id="property-high"></a> `HIGH` | `H264ProfileEnum.HIGH` |
| <a id="property-main"></a> `MAIN` | `H264ProfileEnum.MAIN` |

***

### HDSProtocolSpecificErrorReason

```ts
const HDSProtocolSpecificErrorReason: {
  BAD_DATA: HDSProtocolSpecificErrorReasonEnum.BAD_DATA;
  BUSY: HDSProtocolSpecificErrorReasonEnum.BUSY;
  CANCELLED: HDSProtocolSpecificErrorReasonEnum.CANCELLED;
  INVALID_CONFIGURATION: HDSProtocolSpecificErrorReasonEnum.INVALID_CONFIGURATION;
  NORMAL: HDSProtocolSpecificErrorReasonEnum.NORMAL;
  NOT_ALLOWED: HDSProtocolSpecificErrorReasonEnum.NOT_ALLOWED;
  PROTOCOL_ERROR: HDSProtocolSpecificErrorReasonEnum.PROTOCOL_ERROR;
  TIMEOUT: HDSProtocolSpecificErrorReasonEnum.TIMEOUT;
  UNEXPECTED_FAILURE: HDSProtocolSpecificErrorReasonEnum.UNEXPECTED_FAILURE;
  UNSUPPORTED: HDSProtocolSpecificErrorReasonEnum.UNSUPPORTED;
};
```

Numeric mirror of HAP's `HDSProtocolSpecificErrorReason` const enum, surfaced to HKSV recording delegates as the categorical reason a HomeKit data stream session
terminated. Recording delegates compare the value they receive in `close(reason)` against these names rather than against opaque numeric constants.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-bad_data"></a> `BAD_DATA` | `HDSProtocolSpecificErrorReasonEnum.BAD_DATA` |
| <a id="property-busy"></a> `BUSY` | `HDSProtocolSpecificErrorReasonEnum.BUSY` |
| <a id="property-cancelled"></a> `CANCELLED` | `HDSProtocolSpecificErrorReasonEnum.CANCELLED` |
| <a id="property-invalid_configuration"></a> `INVALID_CONFIGURATION` | `HDSProtocolSpecificErrorReasonEnum.INVALID_CONFIGURATION` |
| <a id="property-normal"></a> `NORMAL` | `HDSProtocolSpecificErrorReasonEnum.NORMAL` |
| <a id="property-not_allowed"></a> `NOT_ALLOWED` | `HDSProtocolSpecificErrorReasonEnum.NOT_ALLOWED` |
| <a id="property-protocol_error"></a> `PROTOCOL_ERROR` | `HDSProtocolSpecificErrorReasonEnum.PROTOCOL_ERROR` |
| <a id="property-timeout"></a> `TIMEOUT` | `HDSProtocolSpecificErrorReasonEnum.TIMEOUT` |
| <a id="property-unexpected_failure"></a> `UNEXPECTED_FAILURE` | `HDSProtocolSpecificErrorReasonEnum.UNEXPECTED_FAILURE` |
| <a id="property-unsupported"></a> `UNSUPPORTED` | `HDSProtocolSpecificErrorReasonEnum.UNSUPPORTED` |

***

### MediaContainerType

```ts
const MediaContainerType: {
  FRAGMENTED_MP4: MediaContainerTypeEnum.FRAGMENTED_MP4;
};
```

Numeric mirror of HAP's `MediaContainerType` const enum, surfaced when declaring the container format of HKSV recording fragments.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-fragmented_mp4"></a> `FRAGMENTED_MP4` | `MediaContainerTypeEnum.FRAGMENTED_MP4` |

***

### SRTPCryptoSuites

```ts
const SRTPCryptoSuites: {
  AES_CM_128_HMAC_SHA1_80: SRTPCryptoSuitesEnum.AES_CM_128_HMAC_SHA1_80;
  AES_CM_256_HMAC_SHA1_80: SRTPCryptoSuitesEnum.AES_CM_256_HMAC_SHA1_80;
  NONE: SRTPCryptoSuitesEnum.NONE;
};
```

Numeric mirror of HAP's `SRTPCryptoSuites` const enum, surfaced when negotiating the SRTP cipher suite for HomeKit camera streaming sessions.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-aes_cm_128_hmac_sha1_80"></a> `AES_CM_128_HMAC_SHA1_80` | `SRTPCryptoSuitesEnum.AES_CM_128_HMAC_SHA1_80` |
| <a id="property-aes_cm_256_hmac_sha1_80"></a> `AES_CM_256_HMAC_SHA1_80` | `SRTPCryptoSuitesEnum.AES_CM_256_HMAC_SHA1_80` |
| <a id="property-none"></a> `NONE` | `SRTPCryptoSuitesEnum.NONE` |

***

### StreamRequestTypes

```ts
const StreamRequestTypes: {
  RECONFIGURE: StreamRequestTypesEnum.RECONFIGURE;
  START: StreamRequestTypesEnum.START;
  STOP: StreamRequestTypesEnum.STOP;
};
```

String mirror of HAP's `StreamRequestTypes` const enum, used by HomeKit camera streaming delegates to dispatch on the `type` field of incoming streaming-control
requests.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-reconfigure"></a> `RECONFIGURE` | `StreamRequestTypesEnum.RECONFIGURE` |
| <a id="property-start"></a> `START` | `StreamRequestTypesEnum.START` |
| <a id="property-stop"></a> `STOP` | `StreamRequestTypesEnum.STOP` |

***

### VideoCodecType

```ts
const VideoCodecType: {
  H264: VideoCodecTypeEnum.H264;
};
```

Numeric mirror of HAP's `VideoCodecType` const enum, surfaced when declaring the video codec a camera advertises to HomeKit.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-h264"></a> `H264` | `VideoCodecTypeEnum.H264` |
