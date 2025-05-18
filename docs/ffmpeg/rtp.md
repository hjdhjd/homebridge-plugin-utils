[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/rtp

# ffmpeg/rtp

RTP and RTCP packet demultiplexer and UDP port management for FFmpeg-based HomeKit livestreaming.

This module supplies classes and helpers to support realtime streaming via FFmpeg in Homebridge and similar HomeKit environments. It enables the demultiplexing of RTP
and RTCP packets on a single UDP port, as required by HomeKit and RFC 5761, working around FFmpeg’s lack of native support for RTP/RTCP multiplexing. It also manages
the allocation and tracking of UDP ports for RTP and RTCP, helping prevent conflicts in dynamic, multi-session streaming scenarios.

Key features:

- Demultiplexes RTP and RTCP packets received on a single UDP port, forwarding them to the correct FFmpeg destinations for HomeKit livestream compatibility.
- Injects periodic heartbeat messages to keep two-way audio streams alive with FFmpeg’s strict timeout requirements.
- Dynamically allocates and reserves UDP ports for RTP/RTCP, supporting consecutive port pairing for correct FFmpeg operation.
- Event-driven architecture for integration with plugin or automation logic.

Designed for plugin developers and advanced users implementing HomeKit livestreaming, audio/video bridging, or similar applications requiring precise RTP/RTCP handling
with FFmpeg.

## FFmpeg

### RtpDemuxer

Utility for demultiplexing RTP and RTCP packets on a single UDP port for HomeKit compatibility.

FFmpeg does not support multiplexing RTP and RTCP data on a single UDP port (RFC 5761) and HomeKit requires this for livestreaming. This class listens on a UDP port
and demultiplexes RTP and RTCP traffic, forwarding them to separate RTP and RTCP ports as required by FFmpeg.

Credit to [dgreif](https://github.com/dgreif), [brandawg93](https://github.com/brandawg93), and [Sunoo](https://github.com/Sunoo) for foundational ideas and
collaboration.

#### Example

```ts
// Create an RtpDemuxer to split packets for FFmpeg compatibility.
const demuxer = new RtpDemuxer("ipv4", 50000, 50002, 50004, log);

// Close the demuxer when finished.
demuxer.close();
```

#### See

 - [RFC 5761](https://tools.ietf.org/html/rfc5761)
 - [homebridge-camera-ffmpeg](https://github.com/homebridge/homebridge-camera-ffmpeg)

#### Extends

- `EventEmitter`

#### Constructors

##### Constructor

```ts
new RtpDemuxer(
   ipFamily, 
   inputPort, 
   rtcpPort, 
   rtpPort, 
   log): RtpDemuxer;
```

Constructs a new RtpDemuxer for a specified IP family and port set.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ipFamily` | `"ipv4"` \| `"ipv6"` | The IP family: "ipv4" or "ipv6". |
| `inputPort` | `number` | The UDP port to listen on for incoming packets. |
| `rtcpPort` | `number` | The UDP port to forward RTCP packets to. |
| `rtpPort` | `number` | The UDP port to forward RTP packets to. |
| `log` | [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) | Logger instance for debug and error messages. |

###### Returns

[`RtpDemuxer`](#rtpdemuxer)

###### Example

```ts
const demuxer = new RtpDemuxer("ipv4", 50000, 50002, 50004, log);
```

###### Overrides

```ts
EventEmitter.constructor
```

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="socket"></a> `socket` | `readonly` | `Socket` |

#### Accessors

##### isRunning

###### Get Signature

```ts
get isRunning(): boolean;
```

Indicates if the demuxer is running and accepting packets.

###### Example

```ts
if(demuxer.isRunning) {
  // Demuxer is active.
}
```

###### Returns

`boolean`

`true` if running, otherwise `false`.

#### Methods

##### close()

```ts
close(): void;
```

Closes the demuxer, its socket, and any heartbeat timers.

###### Returns

`void`

###### Example

```ts
demuxer.close();
```

***

### RtpPortAllocator

Allocates and tracks UDP ports for RTP and RTCP to avoid port conflicts in environments with high network activity.

This utility class is used to find and reserve available UDP ports for demuxing FFmpeg streams or other network activities.

#### Example

```ts
const allocator = new RtpPortAllocator();

// Reserve two consecutive ports for RTP and RTCP.
const rtpPort = await allocator.reserve("ipv4", 2);

// Cancel reservation if not needed.
allocator.cancel(rtpPort);
```

#### Constructors

##### Constructor

```ts
new RtpPortAllocator(): RtpPortAllocator;
```

Instantiates a new RTP port allocator and tracker.

###### Returns

[`RtpPortAllocator`](#rtpportallocator)

#### Methods

##### cancel()

```ts
cancel(port): void;
```

Cancels and releases a previously reserved port, making it available for future use.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `port` | `number` | The port number to release. |

###### Returns

`void`

###### Example

```ts
allocator.cancel(50000);
```

##### reserve()

```ts
reserve(ipFamily, portCount): Promise<number>;
```

Reserves one or two consecutive UDP ports for FFmpeg or network use.

If two ports are reserved, ensures they are consecutive for RTP and RTCP usage. Returns the first port in the sequence, or `-1` if we're unable to allocate.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `ipFamily` | `"ipv4"` \| `"ipv6"` | `"ipv4"` | Optional. "ipv4" or "ipv6". Defaults to "ipv4". |
| `portCount` | `1` \| `2` | `1` | Optional. The number of consecutive ports to reserve (1 or 2). Defaults to 1. |

###### Returns

`Promise`\<`number`\>

A promise resolving to the first reserved port, or `-1` if unavailable.

###### Remarks

FFmpeg currently lacks the ability to specify both the RTP and RTCP ports. FFmpeg always assumes, by convention, that when you specify an RTP port, the RTCP
port is the RTP port + 1. In order to work around that challenge, we need to always ensure that when we reserve multiple ports for RTP (primarily for two-way audio
use cases) that we we are reserving consecutive ports only.

###### Example

```ts
// Reserve a single port.
const port = await allocator.reserve();

// Reserve two consecutive ports for RTP/RTCP.
const rtpPort = await allocator.reserve("ipv4", 2);
```
