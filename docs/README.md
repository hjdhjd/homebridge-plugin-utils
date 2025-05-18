**homebridge-plugin-utils**

***

<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

# Homebridge Plugin Utilities

[![Downloads](https://img.shields.io/npm/dt/homebridge-plugin-utils?color=%23491F59&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-plugin-utils)
[![Version](https://img.shields.io/npm/v/homebridge-plugin-utils?color=%23491F59&label=Latest%20Version&logo=homebridge&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-plugin-utils)
[![Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=%23491F59&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)

## Opinionated utilities to provide useful capabilities and create rich configuration webUI experiences for Homebridge plugins.
</DIV>
</SPAN>

`homebridge-plugin-utils` is a utility library for [Homebridge](https://homebridge.io) [plugins](https://developers.homebridge.io) that aims to provide a set of common core capabilities that can accelerate and streamline plugin development. It's opinionated and largely derived from my other plugins and my desire to increase code reuse and make it easier to provide rich capabilities across all my plugins so that each of my plugins can focus on providing their unique capabilities rather than copying over the same capabilities (feature options, MQTT support, and a rich webUI interface to name a few) time after time.

The design decisions are driven by my own needs as I continue to create, evolve, and maintain my plugins but I also wanted to provide these as a resource to others, should it be of interest.

## Modules

| Module | Description |
| ------ | ------ |
| [featureoptions](featureoptions.md) | A hierarchical feature option system for plugins and applications. |
| [ffmpeg/codecs](ffmpeg/codecs.md) | Probe FFmpeg capabilities and codecs on the host system. |
| [ffmpeg/exec](ffmpeg/exec.md) | Executes arbitrary FFmpeg commands and returns the results. |
| [ffmpeg/options](ffmpeg/options.md) | Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system. |
| [ffmpeg/process](ffmpeg/process.md) | FFmpeg process management and capability introspection. |
| [ffmpeg/record](ffmpeg/record.md) | FFmpeg process management for HomeKit Secure Video (HKSV) events and fMP4 livestreaming. |
| [ffmpeg/rtp](ffmpeg/rtp.md) | RTP and RTCP packet demultiplexer and UDP port management for FFmpeg-based HomeKit livestreaming. |
| [ffmpeg/stream](ffmpeg/stream.md) | FFmpeg process management and socket handling to support HomeKit livestreaming sessions. |
| [mqttclient](mqttclient.md) | MQTT connectivity and topic management for Homebridge plugins. |
| [service](service.md) | Homebridge service helper utilities. |
| [util](util.md) | TypeScript Utilities. |
