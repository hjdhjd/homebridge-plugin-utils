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
| [backpressure](backpressure.md) | AsyncDisposable write queue that serializes Buffer writes onto a Node [Writable](https://nodejs.org/api/stream.html#class-streamwritable), respects backpressure via the stream's `drain` event, and composes into the library's `AbortSignal`-driven lifecycle so a parent signal can tear the writer down uniformly with every other HBPU resource class. |
| [clock](clock.md) | An injectable wall-clock time seam. |
| [clock-double](clock-double.md) | A reusable, controllable [Clock](clock.md#clock) test double. |
| [disposable-stack](disposable-stack.md) | A drop-in implementation of the TC39 Explicit Resource Management `DisposableStack`. |
| [docChrome](docChrome.md) | A shared documentation-chrome renderer for the family's plugins. |
| [featureOptions](featureOptions.md) | A hierarchical feature option system for plugins and applications. |
| [featureOptions-docs](featureOptions-docs.md) | A shared documentation renderer for the [FeatureOptions](featureOptions.md#featureoptions) catalog. |
| [ffmpeg/codecs](ffmpeg/codecs.md) | Probe FFmpeg capabilities and codecs on the host system. |
| [ffmpeg/dgram-util](ffmpeg/dgram-util.md) | Single source of truth for the `"ipv4"` / `"ipv6"` -> `node:dgram` translations the FFmpeg subsystem needs. |
| [ffmpeg/exec](ffmpeg/exec.md) | One-shot FFmpeg execution with composed signal lifetime. |
| [ffmpeg/fmp4](ffmpeg/fmp4.md) | ISO BMFF (fMP4) box parsing utilities for working with fragmented MP4 data. |
| [ffmpeg/fmp4-builders](ffmpeg/fmp4-builders.md) | Shared ISO BMFF (fMP4) byte-level construction builders. |
| [ffmpeg/hap-enums](ffmpeg/hap-enums.md) | Mirrors HAP protocol const enum values that HomeKit camera plugins need at value-side runtime. `verbatimModuleSyntax` disallows value imports of ambient const enums, so the numeric and string contracts from hap-nodejs must be re-declared at value-side. Centralizing the mirrors here gives every consumer a single import path and a single update point if upstream `hap-nodejs` ever changes a value. |
| [ffmpeg/mp4-assembler](ffmpeg/mp4-assembler.md) | AsyncDisposable fMP4 segment assembler. |
| [ffmpeg/mp4-parser](ffmpeg/mp4-parser.md) | Pure stateful byte-to-record parser for ISO BMFF (fMP4) box streams. |
| [ffmpeg/options](ffmpeg/options.md) | Homebridge FFmpeg transcoding, decoding, and encoding options, selecting codecs, pixel formats, and hardware acceleration for the host system. |
| [ffmpeg/process](ffmpeg/process.md) | FFmpeg process management with AbortSignal-based lifecycle. |
| [ffmpeg/record](ffmpeg/record.md) | fMP4 FFmpeg processes for HomeKit Secure Video (HKSV) events and livestreaming. |
| [ffmpeg/recording-process-double](ffmpeg/recording-process-double.md) | Reusable test doubles for the recording dependency-inversion seam. |
| [ffmpeg/rtp](ffmpeg/rtp.md) | Signal-driven RTP/RTCP demultiplexing, FFmpeg keepalive heartbeat, and UDP port reservation for FFmpeg-based HomeKit livestreaming. |
| [ffmpeg/rtp-parser](ffmpeg/rtp-parser.md) | Pure stateful byte-to-record parser for RTP and RTCP datagrams multiplexed on a single UDP port per RFC 5761. |
| [ffmpeg/settings](ffmpeg/settings.md) | - |
| [ffmpeg/stream](ffmpeg/stream.md) | HomeKit livestreaming FFmpeg process with a signal-driven internal stream-health monitor. |
| [formatters](formatters.md) | **Why this file exists.** `featureOptions.ts` ships into `dist/ui/` for the browser to load (via the `copyFeatureOptions` build step). The catalog's built-in formatter registry needs `formatBps`, `formatBytes`, `formatMs`, `formatPercent`, and `formatSeconds` at runtime - and pulling them from `util.ts` would drag in `util.ts`'s `node:timers/promises` import, which the browser cannot resolve. This module is the SSOT for the magnitude-rendering policy. It has zero runtime imports of any kind, so shipping it alongside `featureOptions.js` is safe in any runtime that can execute ES2024+ JavaScript. |
| [homebridge-enums](homebridge-enums.md) | Mirrors homebridge-core const enum values that plugins need at value-side runtime. `verbatimModuleSyntax` disallows value imports of ambient const enums, so the string contracts from homebridge's `api.d.ts` are re-declared here at value-side. This is the homebridge-core counterpart of the HAP mirrors in `ffmpeg/hap-enums.ts`: every Homebridge plugin registers for the `api` lifecycle events, so centralizing the mirror gives every consumer a single import path and a single update point if upstream `homebridge` ever changes a value. |
| [logclient/auth](logclient/auth.md) | Token acquisition for the Homebridge UI log client. |
| [logclient/cli](logclient/cli.md) | The `hblog` command-line bin. |
| [logclient/cli-run](logclient/cli-run.md) | The `hblog` command-line logic, written pure-by-injection. |
| [logclient/client](logclient/client.md) | AsyncDisposable client for the Homebridge UI log stream. |
| [logclient/config](logclient/config.md) | CLI-layer configuration for the `hblog` tool: loading the optional `~/.hblog.json` file and the pure merge of file / environment / flags into a connection. |
| [logclient/endpoints](logclient/endpoints.md) | Single authority for constructing the URLs the log client connects to. |
| [logclient/filter](logclient/filter.md) | Pure [LogRecord](logclient/types.md#logrecord) filter construction. |
| [logclient/frame](logclient/frame.md) | Pure Engine.IO / Socket.IO v4 wire codec. |
| [logclient/parser](logclient/parser.md) | Pure, incremental text-to-[LogRecord](logclient/types.md#logrecord) parsing for the Homebridge UI log stream. |
| [logclient/rest](logclient/rest.md) | Streamed REST log retrieval for the Homebridge UI log client. |
| [logclient/socket](logclient/socket.md) | AsyncDisposable live-log socket for the Homebridge UI log stream. |
| [logclient/socket-double](logclient/socket-double.md) | Reusable test doubles for the log client's two socket seams. |
| [logclient/stitch](logclient/stitch.md) | Pure join of a REST history tail with a socket-seeded live buffer. |
| [logclient/time-expression](logclient/time-expression.md) | Pure, CLI-layer parsing of the `hblog` `--since`/`--until` time expressions into an absolute epoch interval. |
| [logclient/time-window](logclient/time-window.md) | The internal time-window stream transform for the `hblog` CLI. |
| [logclient/types](logclient/types.md) | Shared, dependency-light type definitions for the Homebridge UI log client. |
| [mqttClient](mqttClient.md) | AsyncDisposable MQTT client whose connection lifetime is a composed [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). |
| [service](service.md) | Homebridge service helper utilities. |
| [timer-registry](timer-registry.md) | A lifetime-bounded registry of callback timers. |
| [util](util.md) | TypeScript Utilities. |
| [webui-loader](webui-loader.md) | The webUI boot-region stamp. A plugin's `index.html` carries a marker-fenced region that homebridge-plugin-utils generates and every build re-stamps. The region reports its own boot failures on the page, injects an importmap mapping the bare package specifier to the hashed-versioned subdir the `prepare-ui` CLI mirrors into place, and dynamically imports the plugin's entry module. It is identical across the family, so this module renders it from one template: the plugin declares its entry and cache-bust list in a config comment, and `prepare-ui` stamps the rendered region into the marker-fenced block on every build. |
