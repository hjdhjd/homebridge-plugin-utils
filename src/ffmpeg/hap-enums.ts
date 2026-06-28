/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/hap-enums.ts: Single source of truth for the HAP protocol const enum mirrors that HomeKit camera plugins need at runtime.
 */

/**
 * Mirrors HAP protocol const enum values that HomeKit camera plugins need at value-side runtime. `verbatimModuleSyntax` disallows value imports of ambient const
 * enums, so the numeric and string contracts from hap-nodejs must be re-declared at value-side. Centralizing the mirrors here gives every consumer a single import
 * path and a single update point if upstream `hap-nodejs` ever changes a value.
 *
 * Values MUST stay in lockstep with the upstream definitions in `hap-nodejs/.../RecordingManagement.d.ts`, `hap-nodejs/.../RTPStreamManagement.d.ts`, and
 * `hap-nodejs/.../DataStreamServer.d.ts`. The matching type aliases let consumers import the canonical names from one place rather than re-declaring them.
 *
 * @module
 */
// We source the HAP enum types through "homebridge" rather than "@homebridge/hap-nodejs" directly. A consuming plugin runs against homebridge's own bundled copy of
// hap-nodejs, so type-checking production against that same copy is what keeps it from skewing when HBPU's direct hap-nodejs devDependency drifts from the version
// homebridge pins - two physically distinct copies of the package yield nominally distinct types even when their declarations are byte-identical. VideoCodecType is
// the lone exception: "homebridge" does not re-export it, so that one alias is sourced straight from hap-nodejs. The values below are hand-mirrored regardless of
// source, since verbatimModuleSyntax forbids value imports of ambient const enums.
import type { AudioRecordingCodecType as AudioRecordingCodecTypeEnum, AudioRecordingSamplerate as AudioRecordingSamplerateEnum,
  AudioStreamingCodecType as AudioStreamingCodecTypeEnum, AudioStreamingSamplerate as AudioStreamingSamplerateEnum, H264Level as H264LevelEnum,
  H264Profile as H264ProfileEnum, HDSProtocolSpecificErrorReason as HDSProtocolSpecificErrorReasonEnum, MediaContainerType as MediaContainerTypeEnum,
  SRTPCryptoSuites as SRTPCryptoSuitesEnum, StreamRequestTypes as StreamRequestTypesEnum } from "homebridge";
import type { VideoCodecType as VideoCodecTypeEnum } from "@homebridge/hap-nodejs";

/**
 * Numeric mirror of HAP's `AudioRecordingCodecType` const enum, suitable for runtime indexing into translation tables.
 *
 * @category FFmpeg
 */
export const AudioRecordingCodecType: { readonly AAC_ELD: AudioRecordingCodecTypeEnum.AAC_ELD; readonly AAC_LC: AudioRecordingCodecTypeEnum.AAC_LC } =
  { AAC_ELD: 1, AAC_LC: 0 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `codec?: AudioRecordingCodecType` annotations resolve through the shared module rather than
 * a local redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type AudioRecordingCodecType = AudioRecordingCodecTypeEnum;

/**
 * Numeric mirror of HAP's `AudioRecordingSamplerate` const enum, suitable for runtime indexing into translation tables and for constructing recording configurations
 * by enum name rather than by raw numeric value.
 *
 * @category FFmpeg
 */
export const AudioRecordingSamplerate: {
  readonly KHZ_8: AudioRecordingSamplerateEnum.KHZ_8;
  readonly KHZ_16: AudioRecordingSamplerateEnum.KHZ_16;
  readonly KHZ_24: AudioRecordingSamplerateEnum.KHZ_24;
  readonly KHZ_32: AudioRecordingSamplerateEnum.KHZ_32;
  readonly KHZ_44_1: AudioRecordingSamplerateEnum.KHZ_44_1;
  readonly KHZ_48: AudioRecordingSamplerateEnum.KHZ_48;
} = { KHZ_16: 1, KHZ_24: 2, KHZ_32: 3, KHZ_44_1: 4, KHZ_48: 5, KHZ_8: 0 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `samplerate: AudioRecordingSamplerate` annotations resolve through the shared module rather
 * than a local redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type AudioRecordingSamplerate = AudioRecordingSamplerateEnum;

/**
 * String mirror of HAP's `AudioStreamingCodecType` const enum, surfaced to HomeKit camera streaming delegates when declaring the audio codecs supported on live-stream
 * sessions.
 *
 * @category FFmpeg
 */
export const AudioStreamingCodecType: {
  readonly AAC_ELD: AudioStreamingCodecTypeEnum.AAC_ELD;
  readonly AMR: AudioStreamingCodecTypeEnum.AMR;
  readonly AMR_WB: AudioStreamingCodecTypeEnum.AMR_WB;
  readonly MSBC: AudioStreamingCodecTypeEnum.MSBC;
  readonly OPUS: AudioStreamingCodecTypeEnum.OPUS;
  readonly PCMA: AudioStreamingCodecTypeEnum.PCMA;
  readonly PCMU: AudioStreamingCodecTypeEnum.PCMU;
} = {

  // String const enum members are nominal in TypeScript: a raw string literal is not assignable to the enum member type without an explicit brand. The per-property
  // assertions make the intent visible at each value, and the assertion fails fast if the upstream string ever changes out from under us.
  AAC_ELD: "AAC-eld" as AudioStreamingCodecTypeEnum.AAC_ELD,
  AMR: "AMR" as AudioStreamingCodecTypeEnum.AMR,
  AMR_WB: "AMR-WB" as AudioStreamingCodecTypeEnum.AMR_WB,
  MSBC: "mSBC" as AudioStreamingCodecTypeEnum.MSBC,
  OPUS: "OPUS" as AudioStreamingCodecTypeEnum.OPUS,
  PCMA: "PCMA" as AudioStreamingCodecTypeEnum.PCMA,
  PCMU: "PCMU" as AudioStreamingCodecTypeEnum.PCMU
};

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `type: AudioStreamingCodecType` annotations resolve through the shared module rather than a
 * local redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type AudioStreamingCodecType = AudioStreamingCodecTypeEnum;

/**
 * Numeric mirror of HAP's `AudioStreamingSamplerate` const enum, surfaced to HomeKit camera streaming delegates when declaring the audio sample rates supported on
 * live-stream sessions.
 *
 * @category FFmpeg
 */
export const AudioStreamingSamplerate: {
  readonly KHZ_8: AudioStreamingSamplerateEnum.KHZ_8;
  readonly KHZ_16: AudioStreamingSamplerateEnum.KHZ_16;
  readonly KHZ_24: AudioStreamingSamplerateEnum.KHZ_24;
} = { KHZ_16: 16, KHZ_24: 24, KHZ_8: 8 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `samplerate: AudioStreamingSamplerate` annotations resolve through the shared module rather
 * than a local redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type AudioStreamingSamplerate = AudioStreamingSamplerateEnum;

/**
 * Numeric mirror of HAP's `H264Level` const enum, surfaced when declaring the H.264 levels a camera codec configuration advertises to HomeKit.
 *
 * @category FFmpeg
 */
export const H264Level: { readonly LEVEL3_1: H264LevelEnum.LEVEL3_1; readonly LEVEL3_2: H264LevelEnum.LEVEL3_2; readonly LEVEL4_0: H264LevelEnum.LEVEL4_0 } =
  { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `levels: H264Level[]` annotations resolve through the shared module rather than a local
 * redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type H264Level = H264LevelEnum;

/**
 * Numeric mirror of HAP's `H264Profile` const enum, surfaced when declaring the H.264 profiles a camera codec configuration advertises to HomeKit.
 *
 * @category FFmpeg
 */
export const H264Profile: { readonly BASELINE: H264ProfileEnum.BASELINE; readonly HIGH: H264ProfileEnum.HIGH; readonly MAIN: H264ProfileEnum.MAIN } =
  { BASELINE: 0, HIGH: 2, MAIN: 1 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `profiles: H264Profile[]` annotations resolve through the shared module rather than a local
 * redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type H264Profile = H264ProfileEnum;

/**
 * Numeric mirror of HAP's `HDSProtocolSpecificErrorReason` const enum, surfaced to HKSV recording delegates as the categorical reason a HomeKit data stream session
 * terminated. Recording delegates compare the value they receive in `close(reason)` against these names rather than against opaque numeric constants.
 *
 * @category FFmpeg
 */
export const HDSProtocolSpecificErrorReason: {
  readonly NORMAL: HDSProtocolSpecificErrorReasonEnum.NORMAL;
  readonly NOT_ALLOWED: HDSProtocolSpecificErrorReasonEnum.NOT_ALLOWED;
  readonly BUSY: HDSProtocolSpecificErrorReasonEnum.BUSY;
  readonly CANCELLED: HDSProtocolSpecificErrorReasonEnum.CANCELLED;
  readonly UNSUPPORTED: HDSProtocolSpecificErrorReasonEnum.UNSUPPORTED;
  readonly UNEXPECTED_FAILURE: HDSProtocolSpecificErrorReasonEnum.UNEXPECTED_FAILURE;
  readonly TIMEOUT: HDSProtocolSpecificErrorReasonEnum.TIMEOUT;
  readonly BAD_DATA: HDSProtocolSpecificErrorReasonEnum.BAD_DATA;
  readonly PROTOCOL_ERROR: HDSProtocolSpecificErrorReasonEnum.PROTOCOL_ERROR;
  readonly INVALID_CONFIGURATION: HDSProtocolSpecificErrorReasonEnum.INVALID_CONFIGURATION;
} = { BAD_DATA: 7, BUSY: 2, CANCELLED: 3, INVALID_CONFIGURATION: 9, NORMAL: 0, NOT_ALLOWED: 1, PROTOCOL_ERROR: 8, TIMEOUT: 6, UNEXPECTED_FAILURE: 5, UNSUPPORTED: 4 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `reason: HDSProtocolSpecificErrorReason` annotations resolve through the shared module
 * rather than a local redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type HDSProtocolSpecificErrorReason = HDSProtocolSpecificErrorReasonEnum;

/**
 * Numeric mirror of HAP's `SRTPCryptoSuites` const enum, surfaced when negotiating the SRTP cipher suite for HomeKit camera streaming sessions.
 *
 * @category FFmpeg
 */
export const SRTPCryptoSuites: {
  readonly AES_CM_128_HMAC_SHA1_80: SRTPCryptoSuitesEnum.AES_CM_128_HMAC_SHA1_80;
  readonly AES_CM_256_HMAC_SHA1_80: SRTPCryptoSuitesEnum.AES_CM_256_HMAC_SHA1_80;
  readonly NONE: SRTPCryptoSuitesEnum.NONE;
} = { AES_CM_128_HMAC_SHA1_80: 0, AES_CM_256_HMAC_SHA1_80: 1, NONE: 2 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `suite: SRTPCryptoSuites` annotations resolve through the shared module rather than a local
 * redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type SRTPCryptoSuites = SRTPCryptoSuitesEnum;

/**
 * Numeric mirror of HAP's `VideoCodecType` const enum, surfaced when declaring the video codec a camera advertises to HomeKit.
 *
 * @category FFmpeg
 */
export const VideoCodecType: { readonly H264: VideoCodecTypeEnum.H264 } = { H264: 0 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `type: VideoCodecType` annotations resolve through the shared module rather than a local
 * redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type VideoCodecType = VideoCodecTypeEnum;

/**
 * Numeric mirror of HAP's `MediaContainerType` const enum, surfaced when declaring the container format of HKSV recording fragments.
 *
 * @category FFmpeg
 */
export const MediaContainerType: { readonly FRAGMENTED_MP4: MediaContainerTypeEnum.FRAGMENTED_MP4 } = { FRAGMENTED_MP4: 0 };

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `type: MediaContainerType` annotations resolve through the shared module rather than a
 * local redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type MediaContainerType = MediaContainerTypeEnum;

/**
 * String mirror of HAP's `StreamRequestTypes` const enum, used by HomeKit camera streaming delegates to dispatch on the `type` field of incoming streaming-control
 * requests.
 *
 * @category FFmpeg
 */
export const StreamRequestTypes: {
  readonly RECONFIGURE: StreamRequestTypesEnum.RECONFIGURE;
  readonly START: StreamRequestTypesEnum.START;
  readonly STOP: StreamRequestTypesEnum.STOP;
} = {

  // String const enum members are nominal in TypeScript: a raw string literal is not assignable to the enum member type without an explicit brand. The per-property
  // assertions make the intent visible at each value, and the assertion fails fast if the upstream string ever changes out from under us.
  RECONFIGURE: "reconfigure" as StreamRequestTypesEnum.RECONFIGURE,
  START: "start" as StreamRequestTypesEnum.START,
  STOP: "stop" as StreamRequestTypesEnum.STOP
};

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `type: StreamRequestTypes` annotations resolve through the shared module rather than a
 * local redeclaration in each consumer.
 *
 * @category FFmpeg
 */
export type StreamRequestTypes = StreamRequestTypesEnum;
