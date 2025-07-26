# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 1.26.1 (2025-07-26)
  * Housekeeping.

## 1.26.0 (2025-07-15)
  * Fix: address a regression in `validateName`.
  * Improvement: minor improvements to FFmpeg processing.
  * Housekeeping.

## 1.25.0 (2025-07-06)
  * Behavior change: `acquireService` will no longer attempt to rename a service if it's already been created. To get or set a service's user-visible name, use `getServiceName` and `setServiceName`.

## 1.24.0 (2025-07-05)
  * Behavior change: `validateName` is now `sanitizeName`.
  * New feature: `getServiceName` and `setServiceName` will get or set a service's user-visible name.
  * Improvement: A new `validateName` function that returns whether or not a name meets HomeKit naming rules.
  * Improvement: `acquireService` no longer requires a HAP context object. It will derive it from the service instead.
  * Improvement: added matching semantics to `audioEncoder` to mirror `videoEncoder` and better future-proof it. `EncoderOptions` are now `VideoEncoderOptions` as well.
  * Housekeeping.

## 1.23.0 (2025-06-17)
  * Improvement: added `intelGeneration` for better CPU detection of Intel CPU capabilities, particularly as it relates to AV1.
  * Improvement: AV1 decoding will be disabled if an Intel CPU below the 11th generation, since they don't have AV1 decoding available.
  * Housekeeping.

## 1.22.0 (2025-06-14)
  * Improvement: added AV1 support for decoding in FFmpeg.
  * Improvement: exposed the `start` method and the underlying `ChildProcess` in `FfmpegProcess` for use by consumers.
  * Housekeeping.

## 1.21.1 (2025-06-02)
  * Improvement: adjust `audioEncoder` semantics when we use `aac_at` to use `cbr` rather than `cvbr` for better HomeKit compatibility especially in very low bitrate scenarios.
  * Housekeeping.

## 1.21.0 (2025-06-01)
  * Improvement: evolved `audioEncoder` semantics to support multiple encoding types (AAC_LC and AAC_ELD).
  * Improvement: added additional semantics to `FfmpegRecordingProcess` and `FfmpegLivestreamProcess`.
  * Housekeeping.

## 1.20.0 (2025-05-31)
  * Improvement: evolving FFmpeg-related semantics for better future-proofing and growth. Now includes the ability to specify which audio and video stream to use when recording or segmenting into a livestream.
  * Fix: address audio sync issues when recording HKSV events.
  * Housekeeping.

## 1.19.0 (2025-05-29)
  * Improvement: added additional semantics to `videoEncoder` to address QSV-specific use cases.
  * Housekeeping.

## 1.18.0 (2025-05-27)
  * Improvement: added additional semantics to `validService`.

## 1.17.0 (2025-05-26)
  * Improvement: added options to selectively enable verbosity on specific FFmpeg recording or livestream instances.
  * Improvement: evolved semantics for FFmpeg recording to specify what the input codec is to better support hardware acceleration scenarios.
  * Housekeeping.

## 1.16.0 (2025-05-18)
  * New feature: FFmpeg process utilities, including well-tested capabilities that provide livestreaming, HomeKit Secure Video (HKSV) event recording, and more. These capabilities were ported over and enhanced from my existing [Homebridge UniFi Protect](https://github.com/hjdhjd/homebridge-unifi-protect) plugin.
  * Improvement: significant documentation updates.
  * Fix: address a minor issue in value-centric feature option detection.
  * Housekeeping.

## 1.15.3 (2025-03-16)
  * Housekeeping.

## 1.15.2 (2025-03-16)
  * Housekeeping.

## 1.15.1 (2025-03-16)
  * Housekeeping.

## 1.15.0 (2025-03-16)
  * New feature: `formatBps` to format bitrates to bps, kbps, and Mbps.
  * Housekeeping.

## 1.14.0 (2025-01-05)
  * New feature: `toCamelCase` to camel case a string.
  * Housekeeping.

## 1.13.0 (2024-12-23)
  * Behavior change: don't show the first run screen if there are no devices, but the user has configured everything they needed to.
  * Housekeeping.

## 1.12.0 (2024-12-21)
  * Improvement: remove support for anything below Node 20 and optimize for Node 20 and above.
  * Housekeeping.

## 1.11.3 (2024-12-08)
  * Fix: minor regression in `retry`.
  * Housekeeping and documentation updates.

## 1.11.2 (2024-12-08)
  * Minor fixes and enhancements.
  * Housekeeping.

## 1.11.1 (2024-12-07)
  * Minor fixes and enhancements.
  * Housekeeping.

## 1.11.0 (2024-12-07)
  * Breaking change: `serial` is now `serialNumber` in the feature option webUI configuration to be consistent with the `SerialNumber` characteristic in Homebridge/HomeKit.
  * Behavior change: value-centric feature options can now be explicitly disabled like binary feature options. `null` will be returned when a value-centric feature option has been disabled.
  * Behavior change: the feature option webUI now handles value-centric feature options like binary feature options, with the ability to explicitly disable them.
  * Housekeeping.

## 1.10.2 (2024-10-14)
  * Housekeeping.

## 1.10.1 (2024-10-12)
  * Housekeeping.

## 1.10.0 (2024-10-12)
  * New feature: `Nullable` as a template utility type.
  * Housekeeping.

## 1.9.0 (2024-09-29)
  * New feature: `validateName` to ensure a proper HomeKit name.
  * Improvement: `acquireService` will now filter names through `validateName` as well.
  * Housekeeping.

## 1.8.2 (2024-09-22)
  * Housekeeping.

## 1.8.1 (2024-09-14)
  * Housekeeping.

## 1.8.0 (2024-09-14)
  * Improvement: additional typechecking.

## 1.7.0 (2024-08-04)
  * Update to ESlint v9.
  * Housekeeping.

## 1.6.1 (2024-07-22)
  * Housekeeping.

## 1.6.0 (2024-07-20)
  * New feature: added `acquireService` and `validService` functions to allow for convenient service creation, retrieval, naming, and validation.
  * Improvement: additional linting rules.
  * Housekeeping.

## 1.5.0 (2024-06-14)
  * New feature: added `runWithTimeout` function to allow the arbitrary execution of a promise with a guaranteed timeout.

## 1.4.0 (2024-06-06)
  * Improvement: additional typechecking.

## 1.3.0 (2024-06-03)
  * New feature: added a limit option to the retry utility function.

## 1.2.0 (2024-06-01)
  * New feature: full two-level configuration is now available via the webUI. You can now more fully configure feature option webUIs like the ones used in [homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect) to simpler ones like the ones used in [homebridge-hunter-hydrawise](https://github.com/hjdhjd/homebridge-hunter-hydrawise) and [homebridge-ratgdo](https://github.com/hjdhjd/homebridge-ratgdo).
  * New feature: added a robust UDP port allocator and manager to allow you to safely reserve and use UDP ports within Node. This is necessary in Homebridge in part because FFmpeg does not let you specify the port numbers for both the data and control channels in it's RTP support - they must be consecutive. This necessitates a port manager like `RtpPortAllocator` to allocate and manage UDP port reservations across your plugin to ensure there are no conflicts. This problem is really only encountered in the scenario where you have return audio (aka two-way audio) requirements, such as for a doorbell where the HomeKit client app needs to send audio back to the doorbell.
  * New feature: added RTP demuxer capabilities since FFmpeg does not currently support RFC 5761 (multiplexing RTP data and control packets on a single port) and HomeKit requires this for two-way audio capabilities.
  * New feature: added various TypeScript utility types like DeepPartial and DeepReadonly.
  * Improvement: added a show method on the webUi class to separate instantiation from UI rendering.
  * Improvement: added a color method to the feature options class to provide additional visual context to option scope and hierarchy.
  * Improvement: further refinements to our linting rules to ensure consistency across plugins.
  * Housekeeping.

## 1.1.0 (2024-05-20)
  * New feature: added optional firstRunInit, firstRunRequired, and firstRunSubmit handlers for additional customization in the firstRun workflow.
  * New feature: globals are now shared for eslint.
  * Housekeeping.

## 1.0.0 (2024-05-18)
  * Initial release with support for feature options, feature option webUI, plugin MQTT client support, and common linting and build scripts.
