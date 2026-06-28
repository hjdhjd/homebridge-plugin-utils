/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/udp.helpers.test.ts: Unit tests for the UDP loopback helpers in udp.helpers.ts. The four primitives exercised here (reserveEphemeralPort, probePortAvailable,
 * holdPort, sendDatagram), together with bindReceiver (covered by the rtp suite), compose every UDP-driven test in the FFmpeg subsystem; a regression in their
 * bind/release semantics or in the await-on-completion contract would
 * cascade into the rtp and stream test suites as race-condition flakiness. Tests pin: the kernel-port-assignment contract, the deterministic release semantics
 * (probe-after-release works), the disposal contract (holdPort releases on dispose), and the round-trip datagram delivery.
 */
import { describe, test } from "node:test";
import { holdPort, probePortAvailable, reserveEphemeralPort, sendDatagram } from "./udp.helpers.ts";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";

describe("reserveEphemeralPort", () => {

  test("returns a positive integer port assigned by the kernel", async () => {

    // Port 0 means "kernel chooses." The OS picks a port in its ephemeral range (typically 32768-60999 on Linux, 49152-65535 elsewhere), and the helper returns the
    // chosen port after deterministically releasing the socket. We pin only the structural shape (positive 16-bit integer) since the exact range is OS-dependent.
    const port = await reserveEphemeralPort();

    assert.equal(typeof port, "number", "reserveEphemeralPort must return a number");
    assert.ok(Number.isInteger(port), "the returned port must be an integer");
    assert.ok((port > 0) && (port < 65536), "the returned port must fall within the valid 16-bit range");
  });

  test("returns a freed port - immediately reusable for a follow-up bind", async () => {

    // The deterministic-release contract: by the time reserveEphemeralPort resolves, the port is genuinely free. Probing the same port immediately after must
    // succeed; if the helper returned before the underlying handle was released, this probe would intermittently fail with EADDRINUSE.
    const port = await reserveEphemeralPort();

    await probePortAvailable(port);
  });

  test("supports IPv6 binding when ipFamily is \"ipv6\"", async () => {

    const port = await reserveEphemeralPort("ipv6");

    assert.ok(port > 0, "IPv6 ephemeral port must also be a positive integer");

    // Re-probe on IPv6 to confirm the released port is reusable on the same family.
    await probePortAvailable(port, "ipv6");
  });

  test("returns distinct ports across two consecutive calls", async () => {

    // While the kernel reuses ports over time, two back-to-back ephemeral assignments are overwhelmingly likely to differ. Exact non-equality isn't strictly
    // guaranteed (the kernel could in principle reuse) but in practice the test pins reliable behavior. If this ever flakes in CI, the helper's release-then-return
    // ordering is suspect and the failure is informative.
    const a = await reserveEphemeralPort();
    const b = await reserveEphemeralPort();

    assert.notEqual(a, b, "two consecutive reserveEphemeralPort calls should yield distinct ports (kernel ephemeral allocation)");
  });
});

describe("probePortAvailable", () => {

  test("resolves when the port is free (after a reserve-then-release cycle)", async () => {

    // The pattern reserve-then-probe is the canonical "did the subject release this port?" check. A successful probe after a known release proves the helper itself
    // is reliable for that pattern.
    const port = await reserveEphemeralPort();

    await probePortAvailable(port);
  });

  test("rejects with EADDRINUSE when the port is currently held", async (t) => {

    // Hold a port, then probe it - the bind must fail with EADDRINUSE. This is the negative case: probePortAvailable must surface the kernel's bind error so callers
    // can distinguish "port held" from "port free."
    const port = await reserveEphemeralPort();

    await using _holder = await holdPort(port);

    void _holder;
    await assert.rejects(probePortAvailable(port), { code: "EADDRINUSE" }, "probe must reject with EADDRINUSE when the port is held by another socket");

    t.diagnostic("verified probePortAvailable surfaces the kernel error for a held port");
  });
});

describe("holdPort", () => {

  test("returns an AsyncDisposable that releases the port on dispose", async () => {

    // The contract: after `await using`, the port is held. After scope exit (auto-dispose), the port is free.
    const port = await reserveEphemeralPort();

    {

      await using _holder = await holdPort(port);

      void _holder;

      // While held, probing must fail with EADDRINUSE.
      await assert.rejects(probePortAvailable(port), { code: "EADDRINUSE" }, "while holdPort is in scope, the port must be unavailable");
    }

    // After scope exit, the disposer has run; the port must be free again.
    await probePortAvailable(port);
  });

  test("the disposable's [Symbol.asyncDispose] is callable directly (not just via using)", async () => {

    // For tests that can't use the `await using` form (e.g., conditional disposal), the asyncDispose Symbol must be reachable as a function. Pin that contract so
    // a future refactor that wraps the symbol in a private property surfaces here.
    const port = await reserveEphemeralPort();
    const holder = await holdPort(port);

    assert.equal(typeof holder[Symbol.asyncDispose], "function", "holder must expose Symbol.asyncDispose as a function");

    await holder[Symbol.asyncDispose]();
    await probePortAvailable(port);
  });

  test("supports IPv6 holds when ipFamily is \"ipv6\"", async () => {

    const port = await reserveEphemeralPort("ipv6");

    await using _holder = await holdPort(port, "ipv6");

    void _holder;
    await assert.rejects(probePortAvailable(port, "ipv6"), { code: "EADDRINUSE" }, "IPv6 hold must produce EADDRINUSE on a same-family probe");
  });

  test("holdPort(0) returns a handle whose `port` field carries the kernel-assigned ephemeral port", async () => {

    // The race-free ephemeral-acquisition contract: `holdPort(0)` delegates allocation to the kernel and exposes the assigned port on the returned handle. The
    // handle's `.port` field must be (a) a number, (b) non-zero (the kernel actually picked one rather than echoing the placeholder), and (c) identify the same
    // port the holder is bound to (a probe collides with EADDRINUSE while the holder is alive).
    await using holder = await holdPort(0);

    assert.equal(typeof holder.port, "number", "the `port` field must be a number");
    assert.notEqual(holder.port, 0, "the returned port must be the kernel-assigned ephemeral, not the placeholder zero");
    await assert.rejects(probePortAvailable(holder.port), { code: "EADDRINUSE" },
      "the `port` field must identify the port that's actually held - probing it must collide with the holder");
  });
});

describe("sendDatagram", () => {

  test("delivers the payload bytes to a listener bound on the loopback port", async (t) => {

    // The delivery contract: sendDatagram opens a fresh sender, sends the payload to (loopback, port), waits for the send callback, then releases the sender. The
    // listener observes the payload bytes verbatim. Use a manually-bound receiver here rather than reserveEphemeralPort to avoid the reserve-and-release-and-rebind
    // pattern - the receiver needs to stay live across the send.
    const receiver = createSocket("udp4");

    t.after(async () => {

      const closed = once(receiver, "close");

      receiver.close();
      await closed;
    });

    receiver.bind(0, "127.0.0.1");
    await once(receiver, "listening");

    const port = receiver.address().port;
    const message = once(receiver, "message");

    await sendDatagram(port, Buffer.from("payload"));

    const args = await message as [ Buffer, unknown ];

    assert.deepEqual(args[0], Buffer.from("payload"), "the receiver must observe the exact payload bytes the sender wrote");
  });

  test("releases the sender socket after the send completes (no handle leak)", async (t) => {

    // The finally block must close the sender even on success. We can't easily inspect handle counts, but we can verify that running many sendDatagram calls in
    // sequence does not progressively leak. Sending 5 datagrams to a single receiver and observing all 5 receive cleanly proves the helper isn't holding handles.
    // We bind the receiver, register a Promise that resolves once 5 messages arrive, dispatch the sends in parallel (no per-send dependency means parallel is the
    // most natural shape and avoids the no-await-in-loop lint), and wait for the receive Promise instead of guessing at flush timing.
    const receiver = createSocket("udp4");

    t.after(async () => {

      const closed = once(receiver, "close");

      receiver.close();
      await closed;
    });

    receiver.bind(0, "127.0.0.1");
    await once(receiver, "listening");

    const port = receiver.address().port;
    const observed: string[] = [];
    const fiveReceived = new Promise<void>((resolve) => {

      receiver.on("message", (msg: Buffer) => {

        observed.push(msg.toString("utf8"));

        if(observed.length === 5) {

          resolve();
        }
      });
    });

    await Promise.all([ 1, 2, 3, 4, 5 ].map(async (i) => sendDatagram(port, Buffer.from("msg-" + i.toString()))));
    await fiveReceived;

    assert.equal(observed.length, 5, "all 5 datagrams must be received - leak-free per-send sender lifecycle");
  });

  test("supports IPv6 sends when ipFamily is \"ipv6\"", async (t) => {

    const receiver = createSocket("udp6");

    t.after(async () => {

      const closed = once(receiver, "close");

      receiver.close();
      await closed;
    });

    receiver.bind(0, "::1");
    await once(receiver, "listening");

    const port = receiver.address().port;
    const message = once(receiver, "message");

    await sendDatagram(port, Buffer.from("ipv6-payload"), "ipv6");

    const args = await message as [ Buffer, unknown ];

    assert.deepEqual(args[0], Buffer.from("ipv6-payload"), "IPv6 send must deliver the payload to an IPv6 receiver");
  });
});
