[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/rtp-parser

# ffmpeg/rtp-parser

Pure stateful byte-to-record parser for RTP and RTCP datagrams multiplexed on a single UDP port per RFC 5761.

Each RTP or RTCP packet arrives as a self-contained UDP datagram, so the parser does not have to reassemble anything across chunks. Its job is classification: given
the raw datagram bytes, decide whether the packet is RTP or RTCP and surface the payload type for callers that distinguish further. This mirrors the shape of
[Mp4BoxParser](mp4-parser.md#mp4boxparser) (pure, stateful class, `consume(chunk)` returning an iterable) so the composing caller - typically
[RtpDemuxer](rtp.md#rtpdemuxer) - can drive either parser through the same wiring.

## FFmpeg

### RtpPacketParser

Pure stateful parser that classifies UDP datagrams as RTP or RTCP and surfaces them as [RtpPacket](#rtppacket) records.

Unlike [Mp4BoxParser](mp4-parser.md#mp4boxparser), the RTP wire format is already datagram-framed - each UDP message is a complete packet - so there is no
cross-call state to carry. The class shape mirrors the MP4 parser for consistency: composing resource classes (demuxers, assemblers) drive any parser of this shape
without having to know whether the wire format was stream-oriented or datagram-oriented.

The class is intentionally signal-free and event-free. Resource lifecycle, liveness monitoring, and async consumption are the composing caller's concern - see
[RtpDemuxer](rtp.md#rtpdemuxer).

#### Example

```ts
import { RtpPacketParser } from "homebridge-plugin-utils";

const parser = new RtpPacketParser();

socket.on("message", (datagram) => {

  for(const packet of parser.consume(datagram)) {

    if(packet.kind === "rtp") {

      socket.send(packet.bytes, rtpPort);
    }
  }
});
```

#### See

RtpDemuxer

#### Constructors

##### Constructor

```ts
new RtpPacketParser(): RtpPacketParser;
```

###### Returns

[`RtpPacketParser`](#rtppacketparser)

#### Methods

##### consume()

```ts
consume(datagram): Iterable<RtpPacket>;
```

Feed the parser a UDP datagram and yield the single classified packet it contains.

Datagrams shorter than the two-byte minimum required to read the payload type field are silently dropped. Callers that need to observe malformed input should do so
at the socket layer; the parser's contract is "classify well-formed headers," not "diagnose corruption."

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `datagram` | `Buffer` | A complete UDP datagram received from the RTP/RTCP socket. |

###### Returns

`Iterable`\<[`RtpPacket`](#rtppacket)\>

An iterable yielding zero packets (empty datagram) or exactly one packet (well-formed datagram).

***

### RtpPacket

A single classified RTP or RTCP packet.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bytes"></a> `bytes` | `Buffer` | The complete UDP datagram bytes. Emitted as-is from the parser; consumers that need to hold it past the iteration loop should copy with `Buffer.from()` if the upstream datagram lifetime is suspect. |
| <a id="kind"></a> `kind` | [`RtpPacketKind`](#rtppacketkind-1) | `"rtp"` or `"rtcp"`, derived from the header's payload type field. |
| <a id="payloadtype"></a> `payloadType` | `number` | The 7-bit payload type value from the second byte of the header, masked against `0x7F`. Provided raw so consumers can match specific RTP payload types (e.g., opus, g711) without re-parsing the header. |

***

### RtpPacketKind

```ts
type RtpPacketKind = "rtcp" | "rtp";
```

Classification of a UDP datagram emitted by [RtpPacketParser](#rtppacketparser). `"rtp"` denotes a media packet; `"rtcp"` denotes a control packet. Consumers typically
branch on this union to route to the correct downstream FFmpeg port.
