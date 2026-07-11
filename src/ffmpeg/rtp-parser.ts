/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-parser.ts: Pure byte-to-record parser for RTP/RTCP datagrams.
 */

/**
 * Pure stateful byte-to-record parser for RTP and RTCP datagrams multiplexed on a single UDP port per RFC 5761.
 *
 * Each RTP or RTCP packet arrives as a self-contained UDP datagram, so the parser does not have to reassemble anything across chunks. Its job is classification: given
 * the raw datagram bytes, decide whether the packet is RTP or RTCP and surface the payload type for callers that distinguish further. This mirrors the shape of
 * {@link ffmpeg/mp4-parser!Mp4BoxParser | Mp4BoxParser} (pure, stateful class, `consume(chunk)` returning an iterable) so the composing caller - typically
 * {@link ffmpeg/rtp!RtpDemuxer | RtpDemuxer} - can drive either parser through the same wiring.
 *
 * @module
 */

// RTP/RTCP demultiplexing threshold per RFC 5761. The second byte of every RTP/RTCP header carries the payload type in its low seven bits. RFC 5761 documents that
// values above 90 (and the distinguished value 0) are never used by standard RTCP packet types, so they are safe to treat as RTP; everything else is routed to RTCP.
const RTP_PAYLOAD_TYPE_THRESHOLD = 90;

/**
 * Classification of a UDP datagram emitted by {@link RtpPacketParser}. `"rtp"` denotes a media packet; `"rtcp"` denotes a control packet. Consumers typically
 * branch on this union to route to the correct downstream FFmpeg port.
 *
 * @category FFmpeg
 */
export type RtpPacketKind = "rtcp" | "rtp";

/**
 * A single classified RTP or RTCP packet.
 *
 * @property bytes        - The complete UDP datagram bytes. Emitted as-is from the parser; consumers that need to hold it past the iteration loop should copy with
 *                          `Buffer.from()` if the upstream datagram lifetime is suspect.
 * @property kind         - `"rtp"` or `"rtcp"`, derived from the header's payload type field.
 * @property payloadType  - The 7-bit payload type value from the second byte of the header, masked against `0x7F`. Provided raw so consumers can match specific RTP
 *                          payload types (e.g., opus, g711) without re-parsing the header.
 *
 * @category FFmpeg
 */
export interface RtpPacket {

  bytes: Buffer;
  kind: RtpPacketKind;
  payloadType: number;
}

/**
 * Pure stateful parser that classifies UDP datagrams as RTP or RTCP and surfaces them as {@link RtpPacket} records.
 *
 * Unlike {@link ffmpeg/mp4-parser!Mp4BoxParser | Mp4BoxParser}, the RTP wire format is already datagram-framed - each UDP message is a complete packet - so there is no
 * cross-call state to carry. The class shape mirrors the MP4 parser for consistency: composing resource classes (demuxers, assemblers) drive any parser of this shape
 * without having to know whether the wire format was stream-oriented or datagram-oriented.
 *
 * The class is intentionally signal-free and event-free. Resource lifecycle, liveness monitoring, and async consumption are the composing caller's concern - see
 * {@link ffmpeg/rtp!RtpDemuxer | RtpDemuxer}.
 *
 * @example
 *
 * ```ts
 * import { RtpPacketParser } from "homebridge-plugin-utils";
 *
 * const parser = new RtpPacketParser();
 *
 * socket.on("message", (datagram) => {
 *
 *   for(const packet of parser.consume(datagram)) {
 *
 *     if(packet.kind === "rtp") {
 *
 *       socket.send(packet.bytes, rtpPort);
 *     }
 *   }
 * });
 * ```
 *
 * @see RtpDemuxer
 *
 * @category FFmpeg
 */
export class RtpPacketParser {

  /**
   * Feed the parser a UDP datagram and yield the single classified packet it contains.
   *
   * Datagrams shorter than the two-byte minimum required to read the payload type field are silently dropped. Callers that need to observe malformed input should do so
   * at the socket layer; the parser's contract is "classify well-formed headers," not "diagnose corruption."
   *
   * @param datagram - A complete UDP datagram received from the RTP/RTCP socket.
   *
   * @returns An iterable yielding zero packets (empty datagram) or exactly one packet (well-formed datagram).
   */
  public *consume(datagram: Buffer): Iterable<RtpPacket> {

    // Two bytes is the minimum needed to read the payload type. Anything shorter is silently dropped - the RTP/RTCP fixed headers are at least 12 and 8 bytes
    // respectively, so a datagram this short cannot be a legitimate packet.
    if(datagram.length < 2) {

      return;
    }

    // Payload type lives in the low seven bits of the second header byte (the top bit is the marker bit in RTP and the padding bit in RTCP; we only care about the
    // low seven here).
    const payloadType = datagram.readUInt8(1) & 0x7F;

    // Classification follows the RFC 5761 demux rule: values above 90 and the distinguished value 0 are RTP; everything else is RTCP. The split is intentionally
    // expressed as a single boolean so the path stays branch-predictable in the hot loop.
    const kind: RtpPacketKind = ((payloadType > RTP_PAYLOAD_TYPE_THRESHOLD) || (payloadType === 0)) ? "rtp" : "rtcp";

    yield { bytes: datagram, kind, payloadType };
  }
}
