# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 1.2.0
  * New feature: full two-level configuration is now available via the webUI. You can now more fully configure feature option webUIs like the ones used in [homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect) to simpler ones like the ones used in [homebridge-hunter-hydrawise](https://github.com/hjdhjd/homebridge-hunter-hydrawise) and [homebridge-ratgdo](https://github.com/hjdhjd/homebridge-ratgdo).
  * New feature: added a robust UDP port allocator and manager to allow you to safely reserve and use UDP ports within Node. This is necessary in Homebridge in part because FFmpeg does not let you specify the port numbers for both the data and control channels in it's RTP support - they must be consecutive. This necessitates a port manager like `RtpPortAllocator` to allocate and manage UDP port reservations across your plugin to ensure there are no conflicts. This problem is really only encountered in the scenario where you have return audio (aka two-way audio) requirements, such as for a doorbell where the HomeKit client app needs to send audio back to the doorbell.
  * New feature: added RTP demuxer capabilities since FFmpeg does not currently support RFC 5761 (multiplexing RTP data and control packets on a single port) and HomeKit requires this for two-way audio capabilities.
  * New feature: added various TypeScript utility types like DeepPartial and DeepReadonly.
  * Improvement: added a show method on the webUi class to separate instantiation from UI rendering.
  * Improvement: added a color method to the feature options class to provide additional visual context to option scope and hierarchy.
  * Improvement: further refinements to our linting rules to ensure consistency across plugins.
  * Housekeeping.

## 1.1.0
  * New feature: added optional firstRunInit, firstRunRequired, and firstRunSubmit handlers for additional customization in the firstRun workflow.
  * New feature: globals are now shared for eslint.
  * Housekeeping.

## 1.0.0
  * Initial release with support for feature options, feature option webUI, plugin MQTT client support, and common linting and build scripts.
