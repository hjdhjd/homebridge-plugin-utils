/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-parser.test.ts: Unit tests for the RtpPacketParser - payload-type-driven RTP/RTCP classification and datagram framing.
 */
import { describe, test } from "node:test";
import { RtpPacketParser } from "./rtp-parser.ts";
import assert from "node:assert/strict";
import { expectAt } from "../testing.helpers.ts";

// Synthesize a minimal RTP/RTCP datagram stub. The first two bytes carry the version/payload-type fields the parser cares about; everything after is opaque padding so
// the datagram clears the parser's "at least two bytes" length guard. Using a helper keeps tests focused on the payload-type boundary they are verifying.
function makeDatagram(payloadType: number, extra: Buffer = Buffer.alloc(10)): Buffer {

  const header = Buffer.alloc(2);

  // Version/flags byte - values here are irrelevant to the parser's classification; we set a plausible RTP v2 header (0x80) for realism.
  header.writeUInt8(0x80, 0);
  header.writeUInt8(payloadType & 0x7F, 1);

  return Buffer.concat([ header, extra ]);
}

describe("RtpPacketParser - classification", () => {

  test("classifies payload type 0 as RTP (distinguished value)", () => {

    const parser = new RtpPacketParser();
    const packets = Array.from(parser.consume(makeDatagram(0)));
    const packet = expectAt(packets, 0, "classified packet");

    assert.equal(packet.kind, "rtp");
    assert.equal(packet.payloadType, 0);
  });

  test("classifies payload type > 90 as RTP", () => {

    const parser = new RtpPacketParser();

    for(const payloadType of [ 91, 96, 97, 111, 127 ]) {

      const packets = Array.from(parser.consume(makeDatagram(payloadType)));
      const packet = expectAt(packets, 0, "classified packet");

      assert.equal(packet.kind, "rtp", "payload type " + payloadType.toString() + " must classify as RTP");
      assert.equal(packet.payloadType, payloadType);
    }
  });

  test("classifies payload types 1-90 as RTCP (the RFC 5761 safe range)", () => {

    const parser = new RtpPacketParser();

    for(const payloadType of [ 1, 72, 77, 89, 90 ]) {

      const packets = Array.from(parser.consume(makeDatagram(payloadType)));
      const packet = expectAt(packets, 0, "classified packet");

      assert.equal(packet.kind, "rtcp", "payload type " + payloadType.toString() + " must classify as RTCP");
      assert.equal(packet.payloadType, payloadType);
    }
  });

  test("masks off the top bit of the second header byte (marker / padding bit) before computing payload type", () => {

    const parser = new RtpPacketParser();

    // Set the top bit (marker bit in RTP, padding bit in RTCP) and a payload type of 96. The parser must ignore the top bit and produce payload type 96.
    const datagram = Buffer.from([ 0x80, 0x80 | 96, ...Buffer.alloc(10) ]);
    const packets = Array.from(parser.consume(datagram));
    const packet = expectAt(packets, 0, "marker-bit packet");

    assert.equal(packet.payloadType, 96);
    assert.equal(packet.kind, "rtp");
  });
});

describe("RtpPacketParser - framing", () => {

  test("emits the datagram bytes verbatim on RtpPacket.bytes", () => {

    const parser = new RtpPacketParser();
    const payload = Buffer.from("rtpbody", "ascii");
    const datagram = makeDatagram(96, payload);
    const packets = Array.from(parser.consume(datagram));
    const packet = expectAt(packets, 0, "framed packet");

    assert.deepEqual(packet.bytes, datagram);
  });

  test("yields nothing for datagrams shorter than two bytes", () => {

    const parser = new RtpPacketParser();

    assert.deepEqual(Array.from(parser.consume(Buffer.alloc(0))), []);
    assert.deepEqual(Array.from(parser.consume(Buffer.from([0x80]))), []);
  });

  test("yields exactly one packet per call regardless of datagram size", () => {

    const parser = new RtpPacketParser();

    // Repeated calls never accumulate across datagrams - RTP framing is one-packet-per-datagram by protocol, so each call is independent.
    const first = Array.from(parser.consume(makeDatagram(96)));
    const second = Array.from(parser.consume(makeDatagram(72)));

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(expectAt(first, 0, "first packet").kind, "rtp");
    assert.equal(expectAt(second, 0, "second packet").kind, "rtcp");
  });
});
