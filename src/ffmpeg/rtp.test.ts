/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp.test.ts: Unit tests for the RtpDemuxer / RtpPortAllocator / PortReservation surface - single-socket forwarding, source-port symmetry,
 * always-on RTCP-replay heartbeat, signal-driven socket lifetime, two-tier readiness milestones, scope-bound port reservation handles, and concurrent
 * allocator behavior.
 */
import type { PortReservation, RtpProbeSocket } from "./rtp.ts";
import { RtpDemuxer, RtpPortAllocator } from "./rtp.ts";
import { bindReceiver, probePortAvailable, sendDatagram } from "./udp.helpers.ts";
import { describe, test } from "node:test";
import { HbpuAbortError } from "../util.ts";
import { RTCP_HEARTBEAT_INTERVAL } from "./settings.ts";
import { TestClock } from "../clock-double.ts";
import { TestProbeSocketFactory } from "./rtp.helpers.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { waitUntil } from "../testing/index.ts";

// Build a minimal RTP-shaped datagram. The parser reads the second byte's low seven bits for payload type - values above 90 and the distinguished 0 are RTP,
// everything else is RTCP. We pick 96 (a typical dynamic media payload type) for the "is this RTP?" assertions and 72 (a sender report identifier) for RTCP coverage.
// The optional `suffix` lets tests distinguish multiple sent datagrams by content so receiver assertions can tell which packet arrived.
function makeRtpDatagram(payloadType = 96, suffix: Buffer = Buffer.alloc(10)): Buffer {

  return Buffer.concat([ Buffer.from([ 0x80, payloadType & 0x7F ]), suffix ]);
}

describe("RtpDemuxer - construction and bind", () => {

  test("binds the socket on construction with kernel-assigned ephemeral port", async () => {

    // Construct with `inputPort: 0` to request kernel-assigned ephemeral allocation. The bind is atomic against whatever the kernel picks, eliminating the
    // reserve-then-rebind race a separate `reserveEphemeralPort` call would carry. The assigned port becomes observable on `RtpDemuxer.inputPort` once
    // `RtpDemuxer.ready` resolves.
    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    assert.ok(demuxer.inputPort > 0, "the inputPort getter must reflect the kernel-assigned port once ready resolves");
  });

  test("exposes aborted / isTimedOut as false while alive", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    assert.equal(demuxer.aborted, false);
    assert.equal(demuxer.isTimedOut, false);
  });

  test("pre-aborted parent signal tears the demuxer down without binding", async () => {

    const parent = new AbortController();
    const parentReason = new HbpuAbortError("shutdown");

    parent.abort(parentReason);

    // Port values are irrelevant: the pre-aborted parent signal short-circuits the constructor before bind is attempted. The assertions below verify the composed
    // signal reflects the parent's reason and that ready / mediaReady reject with the parent's reason.
    const demuxer = new RtpDemuxer({ inputPort: 50000, rtcpPort: 50001, rtpPort: 50002, signal: parent.signal });

    assert.equal(demuxer.aborted, true, "composed signal must be aborted the moment the constructor returns");
    assert.equal(demuxer.signal.reason, parentReason);

    await assert.rejects(demuxer.ready, (error: unknown) => error === parentReason);
    await assert.rejects(demuxer.mediaReady, (error: unknown) => error === parentReason);

    await demuxer[Symbol.asyncDispose]();
  });

  test("ready rejects with the parent's reason when the parent signal is pre-aborted", async () => {

    // The `ready` promise's first rejection contract: a consumer awaiting readiness of a pre-aborted demuxer sees the parent's abort reason, not an AbortError or a
    // pending promise. Normalizing through the `onAbort` teardown means the rejection type is the project's structured `HbpuAbortError` rather than the raw
    // `AbortError` that `events.once` would otherwise surface.
    const parent = new AbortController();
    const parentReason = new HbpuAbortError("shutdown");

    parent.abort(parentReason);

    const demuxer = new RtpDemuxer({ inputPort: 50000, rtcpPort: 50001, rtpPort: 50002, signal: parent.signal });

    await assert.rejects(demuxer.ready, (error: unknown) => error === parentReason);

    await demuxer[Symbol.asyncDispose]();
  });

  test("ready rejects with HbpuAbortError(failed) carrying the bind error when the port is already in use", async () => {

    // The `ready` promise's second rejection contract: when the socket errors during bind (typically EADDRINUSE), the pre-registered socket error listener aborts
    // the composed signal with `HbpuAbortError("failed", { cause: bindError })`; the `onAbort` teardown rejects the ready promise with `signal.reason`, so consumers
    // observe the typed failure with the original kernel error preserved on `.cause`.
    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    // Hold an ephemeral port with a sibling demuxer so the subject's bind collides. The holder claims the port atomically (no reserve-then-rebind race), then the
    // collider is constructed with the holder's now-known port as its explicit target. `holder.ready` settles before we instantiate the subject so the collision is
    // deterministic.
    await using holder = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await holder.ready;

    const collider = new RtpDemuxer({ inputPort: holder.inputPort, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    try {

      await assert.rejects(collider.ready, (error: unknown) => {

        assert.ok(error instanceof HbpuAbortError, "a collided bind must end the demuxer with the library's abort error");
        assert.equal(error.name, "failed", "a collided bind must fail the demuxer");
        assert.ok(error.cause instanceof Error, "the abort must carry the bind's own error as its cause");

        return true;
      });
    } finally {

      await collider[Symbol.asyncDispose]();
    }
  });
});

describe("RtpDemuxer - forwarding and source-port symmetry", () => {

  test("forwards an inbound RTP datagram to rtpPort", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    const datagram = makeRtpDatagram(96, Buffer.from("rtp-payload"));

    await sendDatagram(demuxer.inputPort, datagram);
    await waitUntil(() => rtpReceiver.received.length >= 1, { description: "RTP forward to arrive at rtpPort receiver" });

    assert.equal(rtcpReceiver.received.length, 0, "RTP-classified traffic must not arrive at the RTCP destination");
    assert.equal(rtpReceiver.received.length, 1);

    const [forwarded] = rtpReceiver.received;

    assert.ok(forwarded, "rtpReceiver must have captured exactly one forwarded datagram");
    assert.ok(forwarded.msg.equals(datagram), "forwarded RTP payload must match the original datagram byte-for-byte");
  });

  test("forwards an inbound RTCP datagram to rtcpPort", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    const datagram = makeRtpDatagram(72, Buffer.from("rtcp-payload"));

    await sendDatagram(demuxer.inputPort, datagram);
    await waitUntil(() => rtcpReceiver.received.length >= 1, { description: "RTCP forward to arrive at rtcpPort receiver" });

    assert.equal(rtcpReceiver.received.length, 1);

    const [forwarded] = rtcpReceiver.received;

    assert.ok(forwarded, "rtcpReceiver must have captured exactly one forwarded datagram");
    assert.ok(forwarded.msg.equals(datagram), "forwarded RTCP payload must match the original datagram byte-for-byte");
  });

  test("preserves source-port symmetry: outbound source.port equals demuxer.inputPort", async () => {

    // The security property single-socket forwarding provides: the kernel auto-fills outbound source = bound socket's port, and the demuxer holds an
    // exclusive bind on that port. Downstream consumers (typically FFmpeg) can therefore filter by source = `loopback:inputPort` to reject locally-spoofed
    // injections, because no other non-root process can spoof that source endpoint while the demuxer holds the bind. This test guards the property directly: the
    // receiver's `rinfo.port` on a forwarded datagram must equal the demuxer's bound `inputPort` value.
    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    await sendDatagram(demuxer.inputPort, makeRtpDatagram());
    await waitUntil(() => rtpReceiver.received.length >= 1, { description: "RTP forward to arrive" });

    const [forwarded] = rtpReceiver.received;

    assert.ok(forwarded, "rtpReceiver must have captured the forwarded datagram");
    assert.equal(forwarded.rinfo.port, demuxer.inputPort,
      "forwarded source.port must equal the demuxer's bound inputPort - this is the source-endpoint symmetry property downstream consumers rely on");
  });

  test("interleaved RTP/RTCP traffic preserves wire order on each output", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    // Send three RTP and two RTCP datagrams interleaved. Each carries an identifying suffix so we can verify both the destination port and the arrival ordering
    // per-output. Because dgram is order-preserving on loopback within a single sender, the kernel delivers in send order and the demuxer's synchronous
    // classify-and-forward inside the message handler preserves that order per-destination.
    const rtp1 = makeRtpDatagram(96, Buffer.from("rtp-1"));
    const rtcp1 = makeRtpDatagram(72, Buffer.from("rtcp-1"));
    const rtp2 = makeRtpDatagram(97, Buffer.from("rtp-2"));
    const rtcp2 = makeRtpDatagram(73, Buffer.from("rtcp-2"));
    const rtp3 = makeRtpDatagram(98, Buffer.from("rtp-3"));

    await sendDatagram(demuxer.inputPort, rtp1);
    await sendDatagram(demuxer.inputPort, rtcp1);
    await sendDatagram(demuxer.inputPort, rtp2);
    await sendDatagram(demuxer.inputPort, rtcp2);
    await sendDatagram(demuxer.inputPort, rtp3);

    await waitUntil(() => (rtpReceiver.received.length >= 3) && (rtcpReceiver.received.length >= 2), { description: "all five forwards to land on the right ports" });

    assert.equal(rtpReceiver.received.length, 3);
    assert.equal(rtcpReceiver.received.length, 2);

    const [ rtpFirst, rtpSecond, rtpThird ] = rtpReceiver.received;
    const [ rtcpFirst, rtcpSecond ] = rtcpReceiver.received;

    assert.ok(rtpFirst && rtpSecond && rtpThird, "all three RTP forwards must be present on the rtpPort receiver");
    assert.ok(rtcpFirst && rtcpSecond, "both RTCP forwards must be present on the rtcpPort receiver");
    assert.ok(rtpFirst.msg.equals(rtp1));
    assert.ok(rtpSecond.msg.equals(rtp2));
    assert.ok(rtpThird.msg.equals(rtp3));
    assert.ok(rtcpFirst.msg.equals(rtcp1));
    assert.ok(rtcpSecond.msg.equals(rtcp2));
  });
});

describe("RtpDemuxer - mediaReady milestone", () => {

  test("resolves on the first RTP-classified packet, not on RTCP-only traffic", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    // RTCP first - mediaReady should remain pending. We race a small timeout against mediaReady to confirm it did not resolve on the RTCP arrival.
    await sendDatagram(demuxer.inputPort, makeRtpDatagram(72, Buffer.from("rtcp-only")));
    await waitUntil(() => rtcpReceiver.received.length >= 1, { description: "RTCP forward to land" });

    let resolvedEarly = false;

    void demuxer.mediaReady.then(() => { resolvedEarly = true; });

    await delay(100);

    assert.equal(resolvedEarly, false, "mediaReady must NOT resolve on RTCP-only inbound traffic");

    // Now send an RTP - mediaReady should resolve.
    await sendDatagram(demuxer.inputPort, makeRtpDatagram(96, Buffer.from("rtp-first")));
    await demuxer.mediaReady;

    assert.ok(true, "mediaReady resolved after the first RTP-classified packet arrived");
  });

  test("rejects with signal.reason when the demuxer aborts before any RTP arrives", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    const demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    try {

      await demuxer.ready;

      const reason = new HbpuAbortError("shutdown");

      demuxer.abort(reason);

      await assert.rejects(demuxer.mediaReady, (error: unknown) => error === reason);
    } finally {

      await demuxer[Symbol.asyncDispose]();
    }
  });

  test("rejects with the parent's reason when the parent signal is pre-aborted", async () => {

    const parent = new AbortController();
    const parentReason = new HbpuAbortError("shutdown");

    parent.abort(parentReason);

    const demuxer = new RtpDemuxer({ inputPort: 50000, rtcpPort: 50001, rtpPort: 50002, signal: parent.signal });

    await assert.rejects(demuxer.mediaReady, (error: unknown) => error === parentReason);

    await demuxer[Symbol.asyncDispose]();
  });
});

describe("RtpDemuxer - heartbeat (always-on RTCP replay)", () => {

  // Heartbeat tests are unavoidably slow: the cadence is fixed at the canonical `RTCP_HEARTBEAT_INTERVAL` (3000 ms) because the constant is the demuxer's own
  // always-on keepalive cadence (not an FFmpeg timeout), so the tests must run at that real cadence. The tests below run sequentially and wait additively, collectively
  // costing roughly three and a half to four heartbeat windows of wall-clock time - acceptable for catching the heartbeat-related correctness guarantees of an always-on
  // contract that no production consumer can opt out of.

  test("fires after RTCP_HEARTBEAT_INTERVAL of inbound-RTCP quiet, replaying the most-recently-observed RTCP to rtpPort", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    // Two RTCPs with distinct payloads. The heartbeat must replay the LATEST one (rtcp2), not the first one - re-arming on each RTCP arrival is what makes the
    // heartbeat track the most recent RTCP. A stale-first-RTCP regression would surface as `heartbeat.msg.equals(rtcp1)`.
    const rtcp1 = makeRtpDatagram(72, Buffer.from("rtcp-first"));
    const rtcp2 = makeRtpDatagram(73, Buffer.from("rtcp-second"));

    await sendDatagram(demuxer.inputPort, rtcp1);
    await delay(50);
    await sendDatagram(demuxer.inputPort, rtcp2);

    // Wait past the cadence with comfortable slack for CI scheduling jitter.
    await delay(RTCP_HEARTBEAT_INTERVAL + 500);

    assert.equal(rtpReceiver.received.length, 1, "exactly one heartbeat fire must land on rtpPort within RTCP_HEARTBEAT_INTERVAL + slack");

    const [heartbeat] = rtpReceiver.received;

    assert.ok(heartbeat, "the heartbeat fire must be present on rtpPort");
    assert.ok(heartbeat.msg.equals(rtcp2), "the heartbeat replay must carry the LATEST observed RTCP (rtcp2), not the first (rtcp1)");
  });

  test("stays suppressed under busy RTCP traffic via watchdog rearming", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    // Send RTCPs spaced under the cadence so each arrival re-arms the heartbeat watchdog before it can fire. We send several datagrams across roughly one
    // cadence window plus a margin to make the test's claim stronger: even a near-miss where the gap approaches the cadence still suppresses the heartbeat.
    const arrivalsTarget = 8;
    const spacingMs = Math.floor(RTCP_HEARTBEAT_INTERVAL / 6);

    for(let i = 0; i < arrivalsTarget; i++) {

      // eslint-disable-next-line no-await-in-loop
      await sendDatagram(demuxer.inputPort, makeRtpDatagram(72, Buffer.from("rtcp-" + i.toString())));

      // eslint-disable-next-line no-await-in-loop
      await delay(spacingMs);
    }

    assert.equal(rtcpReceiver.received.length, arrivalsTarget, "every inbound RTCP must forward to rtcpPort");
    assert.equal(rtpReceiver.received.length, 0,
      "no heartbeat may fire while RTCP arrivals keep re-arming the watchdog - any non-zero value here is a re-arm regression");
  });

  test("stays dormant when no RTCP has ever been observed", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    // No RTCP ever arrives. The heartbeat watchdog must stay dormant - it is armed only by RTCP arrival, because the heartbeat replays the last observed RTCP and
    // there is nothing meaningful to replay before the first RTCP. A regression that arms the heartbeat at construction would surface as a no-op fire every
    // cadence (`#lastRtcp === undefined` -> skip the send -> re-arm), still leaving rtpReceiver empty - but that path is correct-by-accident; this test guards the
    // dormant-construction rule by asserting demuxer.aborted stays false through the window, confirming no other lifecycle assumption was violated.
    await delay(RTCP_HEARTBEAT_INTERVAL + 500);

    assert.equal(demuxer.aborted, false, "no inactivityTimeout means no abort on stall - the demuxer must remain live");
    assert.equal(rtpReceiver.received.length, 0, "without observed RTCP, the heartbeat watchdog must never fire");
  });
});

describe("RtpDemuxer - inactivity watchdog", () => {

  test("aborts with HbpuAbortError(timeout) when no packets arrive within inactivityTimeout", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    const demuxer = new RtpDemuxer({ inactivityTimeout: 60, inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    try {

      await demuxer.ready;

      // Wait long enough for the watchdog to fire. 200 ms gives several multiples of the 60 ms window for CI jitter absorption.
      await delay(200);

      assert.equal(demuxer.isTimedOut, true, "inactivity watchdog must abort the demuxer with a timeout reason");
      assert.throws(() => demuxer.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "timeout" });
    } finally {

      await demuxer[Symbol.asyncDispose]();
    }
  });

  test("an injected clock drives the inactivity window in virtual time, in both directions", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    const clock = new TestClock();
    const demuxer = new RtpDemuxer({ clock, inactivityTimeout: 1000, inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    try {

      await demuxer.ready;

      // The re-arm and the forward happen in the SAME synchronous message handler, so a forwarded datagram landing on the receiving socket is proof the window has
      // been re-armed at the clock's current virtual time. Synchronizing on that existing observable is what lets the two advances below be exact rather than
      // approximate, and it is why this row needs no real-time buffer at all.
      await sendDatagram(demuxer.inputPort, makeRtpDatagram());
      await waitUntil(() => rtpReceiver.received.length === 1, { description: "the first datagram is forwarded, so the inactivity window is armed" });

      clock.advance(999);

      assert.equal(demuxer.aborted, false, "one millisecond short of the window, nothing has fired");

      clock.advance(1);

      assert.equal(demuxer.isTimedOut, true, "the full window elapsing on the injected clock aborts the demuxer");
      assert.throws(() => demuxer.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "timeout" });
    } finally {

      await demuxer[Symbol.asyncDispose]();
    }
  });

  test("inbound datagrams re-arm the watchdog and keep the demuxer alive", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    const demuxer = new RtpDemuxer({ inactivityTimeout: 80, inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    try {

      await demuxer.ready;

      // Send four packets spaced under the watchdog window. If re-arming on each packet is broken, the demuxer would abort mid-sequence and later sends would
      // either error on send or the demuxer's aborted flag would flip.
      for(let i = 0; i < 4; i++) {

        // eslint-disable-next-line no-await-in-loop
        await sendDatagram(demuxer.inputPort, makeRtpDatagram());

        // eslint-disable-next-line no-await-in-loop
        await delay(30);
      }

      assert.equal(demuxer.aborted, false, "packets arriving inside the watchdog window must keep the demuxer alive");
      assert.equal(demuxer.isTimedOut, false);
    } finally {

      await demuxer[Symbol.asyncDispose]();
    }
  });
});

describe("RtpDemuxer - socket errors", () => {

  test("socket error aborts with HbpuAbortError(failed) carrying the underlying error on cause", async () => {

    // Regression guard for the socket `"error"` path: we provoke a real EADDRINUSE by binding two demuxers to the same port. The holder claims an ephemeral port
    // atomically (inputPort: 0 binds against whatever the kernel picks), then the collider is constructed with the holder's now-known port as its explicit target.
    // The collider's bind fails asynchronously with a kernel-level error, which fires our `"error"` listener and routes the failure through
    // `HbpuAbortError("failed", { cause })`. This is the only practical way to exercise the socket-error code path in-process without mocking the dgram module.
    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();
    await using holder = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await holder.ready;

    // Confirm the first demuxer is actually holding the port - otherwise the test premise collapses and the second bind would succeed.
    assert.equal(holder.aborted, false, "fixture pre-condition: the holder must be alive and bound before the collider attempts the same port");

    const collider = new RtpDemuxer({ inputPort: holder.inputPort, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    try {

      // Poll until the second demuxer's bind failure has surfaced. A short delay is enough on loopback because EADDRINUSE reports on the next event-loop turn after
      // bind; we await a few ticks and then assert. If the demuxer stayed alive (e.g., the test host's OS allows SO_REUSEPORT-style double-bind), that is a platform
      // surprise we want the test to flag loudly.
      await delay(50);

      assert.equal(collider.aborted, true, "collider must have aborted after failing to bind to a port held by another demuxer");
      assert.throws(() => collider.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "failed" });

      // The assertion above already establishes, at runtime, that signal.reason is a failed HbpuAbortError carrying the kernel error as its cause. signal.reason
      // itself stays typed unknown at the AbortSignal boundary, so this cast narrows only for the type checker, not for a fact TypeScript could otherwise see.
      const reason = collider.signal.reason as { cause?: unknown };

      assert.ok(reason.cause instanceof Error, "the underlying kernel error must be attached to `cause` so operators can see the root failure");
    } finally {

      await collider[Symbol.asyncDispose]();
    }
  });
});

describe("RtpDemuxer - signal-driven teardown", () => {

  test("external abort preserves signal.reason and is safe to call more than once", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    const demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    try {

      await demuxer.ready;

      const reason = new HbpuAbortError("shutdown");

      demuxer.abort(reason);

      assert.equal(demuxer.signal.reason, reason, "abort's explicit reason must be preserved on the signal");

      // Second abort with a different reason must NOT overwrite the first - the signal aborts once and stays at the first reason.
      demuxer.abort(new HbpuAbortError("replaced"));

      assert.equal(demuxer.signal.reason, reason, "subsequent abort calls must be no-ops once the signal has aborted");
    } finally {

      await demuxer[Symbol.asyncDispose]();
    }
  });

  test("parent-signal abort propagates through AbortSignal.any to the demuxer", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    const parent = new AbortController();
    const demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port, signal: parent.signal });

    try {

      await demuxer.ready;

      const parentReason = new HbpuAbortError("shutdown");

      parent.abort(parentReason);

      // Give the abort listener a turn of the event loop to run.
      await delay(10);

      assert.equal(demuxer.aborted, true);
      assert.equal(demuxer.signal.reason, parentReason, "AbortSignal.any must preserve the parent's abort reason when it aborts first");
    } finally {

      await demuxer[Symbol.asyncDispose]();
    }
  });

  test("[Symbol.asyncDispose] awaits the kernel-level socket close so the port is rebindable on return", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    const demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

    await demuxer.ready;

    // Capture the kernel-assigned port BEFORE dispose - the rebind probe below needs the specific port to verify release, but post-dispose the demuxer's socket is
    // closed and `socket.address()` would no longer be readable.
    const boundPort = demuxer.inputPort;

    await demuxer[Symbol.asyncDispose]();

    // A successful rebind on the same port proves the demuxer's socket was released. `probePortAvailable` awaits Node's close callback so callers do not need
    // to paper over a handle-release window with a polling delay - the dispose contract guarantees the port is releasable by the time it resolves.
    await probePortAvailable(boundPort);

    assert.equal(demuxer.aborted, true);
    assert.throws(() => demuxer.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" });
  });

  test("await using aborts with shutdown reason by the time the block exits", async () => {

    await using rtpReceiver = await bindReceiver();
    await using rtcpReceiver = await bindReceiver();

    let capturedSignal: AbortSignal | undefined;

    {

      await using demuxer = new RtpDemuxer({ inputPort: 0, rtcpPort: rtcpReceiver.port, rtpPort: rtpReceiver.port });

      capturedSignal = demuxer.signal;

      await demuxer.ready;
    }

    assert.ok(capturedSignal, "the demuxer must have observed an abort signal during ready resolution");
    assert.equal(capturedSignal.aborted, true);
    assert.throws(() => capturedSignal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" });
  });
});

describe("RtpPortAllocator - single-port reservations", () => {

  test("reserve returns a PortReservation with the expected shape", async () => {

    const allocator = new RtpPortAllocator();

    await using reservation = await allocator.reserve();

    assert.equal(typeof reservation.port, "number");
    assert.equal(reservation.count, 1);
    assert.equal(reservation.ipFamily, "ipv4");
    assert.equal(typeof reservation[Symbol.asyncDispose], "function");
  });

  test("concurrent reservations get distinct ports and track correctly in the pool", async () => {

    // Ten concurrent reservations; the ephemeral-port pool is large enough for this on any reasonable host. We verify two guarantees: every reservation holds a
    // distinct port (no double-allocation race), and `reservedCount` tracks the pool size exactly across the acquire-all / release-all cycle.
    const allocator = new RtpPortAllocator();
    const reservations = await Promise.all(Array.from({ length: 10 }, async () => allocator.reserve()));

    assert.equal(allocator.reservedCount, 10, "all 10 concurrent reservations must be in the pool");

    const uniquePorts = new Set(reservations.map((reservation) => reservation.port));

    assert.equal(uniquePorts.size, reservations.length, "concurrent reservations must issue distinct ports");

    // Release everything so the pool is clean for the next test.
    for(const reservation of reservations) {

      // eslint-disable-next-line no-await-in-loop
      await reservation[Symbol.asyncDispose]();
    }

    assert.equal(allocator.reservedCount, 0, "disposing every reservation must fully drain the pool");
  });

  test("disposing a reservation releases the port back to the pool", async () => {

    // Direct guarantee: reserve adds to #inUse, dispose removes from #inUse. The `reservedCount` accessor exposes the pool size as a first-class observable so the
    // test can assert the state transition directly rather than inferring it from follow-on reserve() behavior.
    const allocator = new RtpPortAllocator();

    assert.equal(allocator.reservedCount, 0, "fixture pre-condition");

    const reservation = await allocator.reserve();

    assert.equal(allocator.reservedCount, 1, "successful reserve must mark the port in-use");

    await reservation[Symbol.asyncDispose]();

    assert.equal(allocator.reservedCount, 0, "disposal must release the port back to the pool");
  });
});

describe("RtpPortAllocator - consecutive-port reservations", () => {

  test("count: 2 reserves two consecutive ports", async () => {

    const allocator = new RtpPortAllocator();

    await using reservation = await allocator.reserve({ count: 2 });

    assert.equal(reservation.count, 2);
    assert.equal(typeof reservation.port, "number");
    // The caller uses reservation.port for RTP and reservation.port + 1 for RTCP; the allocator guarantees the next port is also held.
  });

  test("sequential count: 2 reservations do not overlap", async () => {

    const allocator = new RtpPortAllocator();

    await using first = await allocator.reserve({ count: 2 });
    await using second = await allocator.reserve({ count: 2 });

    assert.equal(allocator.reservedCount, 4, "two count=2 reservations must hold four ports");

    const firstRange = [ first.port, first.port + 1 ];
    const secondRange = [ second.port, second.port + 1 ];

    for(const port of firstRange) {

      assert.equal(secondRange.includes(port), false, "consecutive reservations must not collide on either port of the range");
    }
  });
});

describe("RtpPortAllocator - signal handling", () => {

  test("throws the caller's abort reason when signal is already aborted at call time", async () => {

    const allocator = new RtpPortAllocator();
    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");

    controller.abort(reason);

    await assert.rejects(allocator.reserve({ signal: controller.signal }), (error: unknown) => error === reason);
  });

  test("throws RangeError when count is not 1 or 2", async () => {

    const allocator = new RtpPortAllocator();

    await assert.rejects(allocator.reserve({ count: 3 as unknown as 1 | 2 }), RangeError);
  });

  test("reservedCount is stable across every reachable reserve() failure mode", async () => {

    // Two-phase-commit rule: any reserve() call that does NOT return a live reservation must leave the allocator's pool unchanged. This covers the ports-leak
    // bug class structurally - the `DisposableStack.move()` commit point transfers ownership only on success, so every non-success exit path runs scope-bound
    // disposal on whatever was tentatively acquired. We exercise every failure mode black-box testing can reach: a pre-aborted signal, RangeError on invalid count,
    // and a microtask-timed abort. The package's own socket factory answers a bind inside the call, so that abort lands between the two acquires: the first port
    // is already tentatively held when the second acquire's `throwIfAborted` throws, and the scope-bound release returns it to the pool. An abort inside a pending
    // bind is reachable only through a factory whose binds answer later, which is why the scripted-factory rows in the retry and collision block exercise that
    // rethrow rather than this row.
    const allocator = new RtpPortAllocator();
    const baseline = allocator.reservedCount;

    // Pre-aborted signal.
    {

      const ctrl = new AbortController();

      ctrl.abort(new HbpuAbortError("shutdown"));
      await assert.rejects(allocator.reserve({ count: 2, signal: ctrl.signal }));
      assert.equal(allocator.reservedCount, baseline, "pre-aborted signal must not leak");
    }

    // RangeError on invalid count.
    await assert.rejects(allocator.reserve({ count: 3 as unknown as 1 | 2 }));
    assert.equal(allocator.reservedCount, baseline, "RangeError path must not leak");

    // Microtask-timed abort - takes effect between the two acquires, after the first port is tentatively held and before the second probe socket opens.
    for(let trial = 0; trial < 20; trial++) {

      const ctrl = new AbortController();

      queueMicrotask(() => { queueMicrotask(() => { ctrl.abort(new HbpuAbortError("shutdown")); }); });

      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(allocator.reserve({ count: 2, signal: ctrl.signal }));
    }

    assert.equal(allocator.reservedCount, baseline, "20 microtask-aborted reservations must not leak");
  });

  test("successful reservation actually holds its ports (catches forgotten stack.move())", async () => {

    // The `DisposableStack.move()` pattern's failure mode is loud: if a future maintainer forgets to call `stack.move()` before returning a reservation, the
    // scope-bound disposer fires on return and releases the ports. The returned reservation would then refer to ports not actually held by the pool - a correctness
    // bug callers would see immediately. This test catches that regression by asserting the positive guarantee: after a successful reserve(), the claimed ports
    // ARE in the pool.
    const allocator = new RtpPortAllocator();

    {

      await using r1 = await allocator.reserve({ count: 1 });

      assert.equal(r1.count, 1);
      assert.equal(allocator.reservedCount, 1, "count=1 reservation must hold exactly one port");
    }

    assert.equal(allocator.reservedCount, 0);

    {

      await using r2 = await allocator.reserve({ count: 2 });

      assert.equal(r2.count, 2);
      assert.equal(allocator.reservedCount, 2, "count=2 reservation must hold exactly two ports");
    }

    assert.equal(allocator.reservedCount, 0);
  });
});

describe("PortReservation - disposal", () => {

  test("double-dispose is a safe no-op", async () => {

    // Repeat-safety guard: the second disposal must not double-delete from `#inUse`. A naive implementation that unconditionally removes ports on every dispose would
    // silently break if a future caller re-reserved the same port between the two disposes - the second dispose would release someone else's port. `reservedCount`
    // gives us a direct guarantee to assert: after the first disposal the pool is at zero, and the second disposal must not change that.
    const allocator = new RtpPortAllocator();
    const reservation: PortReservation = await allocator.reserve();

    await reservation[Symbol.asyncDispose]();
    assert.equal(allocator.reservedCount, 0, "first disposal must release the port");

    await reservation[Symbol.asyncDispose]();
    assert.equal(allocator.reservedCount, 0, "second disposal must not further mutate the pool");
  });

  test("disposing a count: 2 reservation releases both held ports", async () => {

    // Count-2 release path: the disposer must delete both ports from `#inUse`, not just the first. `reservedCount` makes this a positive assertion - the pool
    // shrinks from 2 to 0, not from 2 to 1 - catching a one-port-release regression that a follow-on reserve() cannot detect on an uncrowded host.
    const allocator = new RtpPortAllocator();
    const reservation = await allocator.reserve({ count: 2 });

    assert.equal(allocator.reservedCount, 2, "count=2 reserve must hold two ports");

    await reservation[Symbol.asyncDispose]();

    assert.equal(allocator.reservedCount, 0, "disposing a count=2 reservation must release both ports, not just one");
  });
});

describe("RtpPortAllocator - retry and collision paths", () => {

  /* Every path the allocator can take under port contention has a row here. The probe-socket factory the allocator takes at construction is what makes each
   * one deterministic: the double answers every bind with what the row scripted, so a refused bind, a collision with a port the pool already holds, a spent
   * attempt budget, and an abort while a bind is pending are each set up directly rather than waited for on a crowded host. The ports are scripted and never
   * bound, so their numbers are arbitrary. Every other allocator row binds real sockets through the default factory.
   */

  // The allocator's attempt budget. The exhaustion rows assert it through the error's message, and the collision row scripts more collisions than it allows.
  const ATTEMPT_BUDGET = 10;

  test("a refused random-port bind is retried on the next attempt, which reserves the port it binds", async () => {

    const probes = new TestProbeSocketFactory([ "refused", 50000 ]);
    const allocator = new RtpPortAllocator({ socketFactory: probes.create });

    await using reservation = await allocator.reserve();

    assert.equal(reservation.port, 50000);
    assert.equal(allocator.reservedCount, 1, "a refused bind must leave nothing in the pool");
    assert.deepEqual(probes.binds, [ 0, 0 ]);
  });

  test("a refused sequential neighbor releases the first port, and the next attempt reserves a fresh pair", async () => {

    const probes = new TestProbeSocketFactory([ 50000, "refused", 50010, 50011 ]);
    const allocator = new RtpPortAllocator({ socketFactory: probes.create });

    await using reservation = await allocator.reserve({ count: 2 });

    assert.equal(reservation.port, 50010);
    assert.equal(allocator.reservedCount, 2, "the first attempt's port must leave the pool when its neighbor is refused");
    assert.deepEqual(probes.binds, [ 0, 50001, 0, 50011 ]);
  });

  test("a sequential neighbor the pool already holds fails the specific-port probe, and the held port survives the retry", async () => {

    const probes = new TestProbeSocketFactory([ 50001, 50000, 50001, 50010, 50011 ]);
    const allocator = new RtpPortAllocator({ socketFactory: probes.create });

    await using held = await allocator.reserve();

    const pair = await allocator.reserve({ count: 2 });

    assert.equal(held.port, 50001);
    assert.equal(pair.port, 50010);
    assert.equal(allocator.reservedCount, 3, "the pool must hold the single port and the fresh pair, and nothing from the abandoned attempt");
    assert.deepEqual(probes.binds, [ 0, 0, 50001, 0, 50011 ]);

    await pair[Symbol.asyncDispose]();

    assert.equal(allocator.reservedCount, 1, "releasing the pair must leave the held port in the pool");
  });

  test("a random-port bind that lands on a held port retries inside the same attempt, so collisions beyond the attempt budget still reserve", async () => {

    // The first reservation holds 50000, and the second one's probes land on it for a full budget of binds before a fresh port arrives. Were a collision to
    // spend an attempt, the budget would be gone before the fresh port.
    const probes = new TestProbeSocketFactory([ 50000, ...Array.from({ length: ATTEMPT_BUDGET }, () => 50000), 50010 ]);
    const allocator = new RtpPortAllocator({ socketFactory: probes.create });

    await using held = await allocator.reserve();
    await using reservation = await allocator.reserve();

    assert.equal(held.port, 50000);
    assert.equal(reservation.port, 50010);
    assert.equal(allocator.reservedCount, 2);
    assert.deepEqual(probes.binds, Array.from({ length: ATTEMPT_BUDGET + 2 }, () => 0));
  });

  test("an attempt budget spent on refused neighbors rejects with the exhaustion error and leaves the pool empty", async () => {

    // Each attempt binds a fresh first port and is refused its neighbor, so every attempt holds a port that its retry has to release.
    const probes = new TestProbeSocketFactory(Array.from({ length: ATTEMPT_BUDGET }, (_, attempt) => [ 50000 + (attempt * 10), "refused" ] as const).flat());
    const allocator = new RtpPortAllocator({ socketFactory: probes.create });

    await assert.rejects(allocator.reserve({ count: 2 }),
      { message: "RtpPortAllocator: unable to reserve 2 consecutive ports after " + ATTEMPT_BUDGET.toString() + " attempts." });

    assert.equal(allocator.reservedCount, 0, "every attempt's first port must leave the pool");
    assert.equal(probes.binds.length, 2 * ATTEMPT_BUDGET);
  });

  test("an attempt budget spent on refused single-port binds rejects with the single-port exhaustion error and leaves the pool empty", async () => {

    // Each attempt's one bind is refused, so no attempt holds a port, and the exhaustion error names the single-port form rather than a consecutive range.
    const probes = new TestProbeSocketFactory(Array.from({ length: ATTEMPT_BUDGET }, () => "refused" as const));
    const allocator = new RtpPortAllocator({ socketFactory: probes.create });

    await assert.rejects(allocator.reserve(), { message: "RtpPortAllocator: unable to reserve a port after " + ATTEMPT_BUDGET.toString() + " attempts." });

    assert.equal(allocator.reservedCount, 0, "a refused bind must leave nothing in the pool");
    assert.deepEqual(probes.binds, Array.from({ length: ATTEMPT_BUDGET }, () => 0));
  });

  test("an abort while a probe bind is pending rejects with the signal's reason and leaves the pool empty", async () => {

    // The double answers a bind on the next tick, so the abort below lands while the first probe waits for its answer. The package's own factory answers a bind
    // inside the call, so only a factory whose binds answer later reaches this path.
    const probes = new TestProbeSocketFactory([50000]);
    const allocator = new RtpPortAllocator({ socketFactory: probes.create });
    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");
    const pending = allocator.reserve({ signal: controller.signal });

    controller.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(allocator.reservedCount, 0);
    assert.deepEqual(probes.binds, [0]);
  });

  test("an abort as the final attempt's probe opens rejects with the signal's reason rather than the exhaustion error", async () => {

    // Every earlier attempt is refused, so the budget is spent by the time the final probe answers. The rethrow inside the probe is what surfaces the caller's
    // reason here: were the aborted probe to report a refused bind instead, the loop would end on the exhaustion error.
    const probes = new TestProbeSocketFactory([ ...Array.from({ length: ATTEMPT_BUDGET - 1 }, () => "refused" as const), 50000 ]);
    const controller = new AbortController();
    const reason = new HbpuAbortError("shutdown");
    const allocator = new RtpPortAllocator({ socketFactory: (ipFamily): RtpProbeSocket => {

      if(probes.binds.length === (ATTEMPT_BUDGET - 1)) {

        controller.abort(reason);
      }

      return probes.create(ipFamily);
    } });

    await assert.rejects(allocator.reserve({ signal: controller.signal }), (error: unknown) => error === reason);
    assert.equal(allocator.reservedCount, 0);
    assert.equal(probes.binds.length, ATTEMPT_BUDGET);
  });
});
