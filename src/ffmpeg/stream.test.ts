/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/stream.test.ts: Unit tests for FfmpegStreamingProcess - signal-driven internal health socket, liveness watchdog, abort propagation, externally readable stdout.
 */
import { HbpuAbortError, isHbpuAbortReason } from "../util.ts";
import { describe, test } from "node:test";
import { holdPort, probePortAvailable, sendDatagram } from "./udp.helpers.ts";
import { FfmpegOptions } from "./options.ts";
import { FfmpegStreamingProcess } from "./stream.ts";
import type { HomebridgePluginLogging } from "../util.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { makeCodecs } from "./codecs.helpers.ts";
import { once } from "node:events";
import { silentLog } from "../testing.helpers.ts";

function makeOptions(logger: HomebridgePluginLogging = silentLog()): FfmpegOptions {

  return new FfmpegOptions({

    codecSupport: makeCodecs({ ffmpegExec: process.execPath, ffmpegVersion: "test" }),
    debug: false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    log: logger,
    name: (): string => "test"
  });
}

// Inline script: emit stderr (so ready resolves), then idle indefinitely. The streaming subclass's health socket is the only thing that drives abort in these tests.
function stderrThenIdle(message = "ready"): string[] {

  return [ "-e", "process.stderr.write(" + JSON.stringify(message + "\n") + "); setInterval(() => {}, 100000);" ];
}

// Inline script: emit stdout byte (for the externally-readable-stdout test), stderr ready line, then idle.
function stdoutAndStderrThenIdle(stdoutPayload: string, stderrPayload: string): string[] {

  return [ "-e",
    "process.stdout.write(" + JSON.stringify(stdoutPayload) + "); process.stderr.write(" + JSON.stringify(stderrPayload + "\n") + "); setInterval(() => {}, 100000);" ];
}

// Single-byte health datagram. The streaming process's watchdog only cares that any datagram arrived on the return port; the payload is semantically irrelevant.
const HEALTH_PAYLOAD = Buffer.from([0x00]);

describe("FfmpegStreamingProcess - construction without return port", () => {

  test("spawns and exposes the inherited surface without binding a socket", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stderrThenIdle() });

    await proc.ready;

    // No returnPort means no health monitor - the process stays alive until we abort it. `aborted` must still mirror the signal.
    assert.equal(proc.aborted, false);
    assert.equal(proc.hasError, false);
    assert.equal(proc.isTimedOut, false);

    // The `returnPort` getter projects `init.returnPort` (which was unset here) onto its undefined branch. Pinning the contract directly so a future regression
    // that returned a sentinel descriptor instead of `undefined` would surface here rather than via collateral failures elsewhere.
    assert.equal(proc.returnPort, undefined, "without a configured returnPort, the getter must return undefined - not a sentinel descriptor");
  });

  test("stdout stays externally readable because the subclass does not consume it", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stdoutAndStderrThenIdle("two-way-audio-bytes", "ready") });

    await proc.ready;

    // Read one chunk from stdout to prove an external consumer can attach. The talkback path in HBUP reads stdout this way. `events.once` returns a Promise of the
    // listener arguments - the canonical Node idiom for "await one event."
    const [chunk] = await once(proc.stdout, "data") as [Buffer];

    assert.equal(chunk.toString(), "two-way-audio-bytes", "stdout should be externally readable on streaming processes - the talkback path depends on it");
  });
});

describe("FfmpegStreamingProcess - health socket watchdog", () => {

  test("does not arm or fire when no inbound packet ever arrives - a cold start with no first packet is immune", async () => {

    // Construct with `port: 0` to request kernel-assigned ephemeral allocation. The bind is atomic against whatever the kernel picks, eliminating the
    // reserve-then-rebind race a separate {@link reserveEphemeralPort} call would carry.
    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stderrThenIdle(), healthTimeout: 80, returnPort: { ipFamily: "ipv4", port: 0 } });

    await proc.ready;

    // The watchdog arms only on the first inbound packet, never on `ready` or at construction. With no datagram ever sent, the inactivity clock never starts, so the
    // process must stay alive through any wait - this is the cold-start case where the first return packet has not yet round-tripped. 80ms is the window we would have
    // tripped under the old ready-armed behavior; we wait 250ms (well past it) to prove the watchdog truly never armed. We deliberately do NOT `await proc.exited`
    // here: with no packet the watchdog never fires and `stderrThenIdle()` idles forever, so the process never exits on its own - awaiting it would hang the run.
    await delay(250);

    assert.equal(proc.isTimedOut, false, "with no inbound packet the watchdog must never arm, so a cold-start stream must not be aborted with a timeout reason");
    assert.equal(isHbpuAbortReason(proc.signal.reason, "timeout"), false, "the signal must not carry a timeout reason when no packet ever arrived");

    // Tear down explicitly so the still-idling child is reaped. `await using` would also dispose at scope exit, but aborting here makes the cleanup intent obvious and
    // settles the process deterministically before the assertions' scope ends.
    proc.abort(new HbpuAbortError("shutdown"));
  });

  test("inbound packets re-arm the watchdog and keep the process alive", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stderrThenIdle(), healthTimeout: 80, returnPort: { ipFamily: "ipv4", port: 0 } });

    await proc.ready;

    // The `assert.ok` narrows the `FfmpegStreamingReturnPort | undefined` union for TypeScript - we configured returnPort at construction, so this assertion never
    // fires in practice. The getter's docblock (stream.ts) documents the timing contract: the kernel-assigned port becomes observable when the socket's
    // `"listening"` event fires, which in practice precedes `proc.ready` since FFmpeg startup outlasts the UDP bind by orders of magnitude.
    assert.ok(proc.returnPort, "fixture pre-condition: returnPort must be set because we configured it");

    // Send four packets spaced under the watchdog window. If the watchdog does not re-arm on each packet, the process would abort mid-sequence and the last send
    // would fail with ECONNREFUSED once the socket closes.
    for(let i = 0; i < 4; i++) {

      // eslint-disable-next-line no-await-in-loop
      await sendDatagram(proc.returnPort.port, HEALTH_PAYLOAD);

      // eslint-disable-next-line no-await-in-loop
      await delay(40);
    }

    assert.equal(proc.aborted, false, "packets arriving within the window must keep the process alive");
    assert.equal(proc.isTimedOut, false);
  });

  test("fires HbpuAbortError(timeout) after the first packet arms the watchdog and silence then exceeds the window", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stderrThenIdle(), healthTimeout: 80, returnPort: { ipFamily: "ipv4", port: 0 } });

    await proc.ready;

    // The kernel-assigned port is observable once the socket's `"listening"` event has fired, which in practice precedes `proc.ready` because FFmpeg startup outlasts
    // the UDP bind by orders of magnitude - the same contract the re-arm test above relies on, so we read `proc.returnPort.port` directly rather than waiting on
    // `"listening"`. The `assert.ok` narrows the `FfmpegStreamingReturnPort | undefined` union for TypeScript.
    assert.ok(proc.returnPort, "fixture pre-condition: returnPort must be set because we configured it");

    // Send exactly ONE datagram and await its delivery. This is the arming packet: it proves the watchdog only fires AFTER liveness is established, which is the
    // regression guard that the fix did not simply delete the watchdog. Awaiting `sendDatagram` guarantees the packet has been handed to the kernel - and therefore the
    // message handler has armed - before the silence window opens below.
    await sendDatagram(proc.returnPort.port, HEALTH_PAYLOAD);

    // Now go silent for longer than the window. The watchdog was armed by the single packet above, so with no further packets it must count down and fire. 250ms is
    // generous slack past the 80ms window for the watchdog to fire and the abort to settle before the assertions run.
    await delay(250);

    assert.equal(proc.isTimedOut, true, "after the first packet arms the watchdog, a gap longer than the window with no further packets must abort with a timeout");
    assert.equal(isHbpuAbortReason(proc.signal.reason, "timeout"), true);
  });
});

describe("FfmpegStreamingProcess - teardown propagation", () => {

  test("aborting the process also tears down the health socket", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stderrThenIdle(), healthTimeout: 5_000, returnPort: { ipFamily: "ipv4", port: 0 } });

    await proc.ready;
    assert.ok(proc.returnPort, "fixture pre-condition: returnPort must be set because we configured it");

    // Capture the kernel-assigned port BEFORE dispose - after dispose the socket is closed and `socket.address()` is no longer readable, so a post-dispose read of
    // `proc.returnPort.port` would surface stale state. The captured value is what `probePortAvailable` needs to prove the socket released its port.
    const boundPort = proc.returnPort.port;

    proc.abort(new HbpuAbortError("shutdown"));

    await proc.exited;

    // After teardown, the port must be rebindable - proving the health socket closed. probePortAvailable either resolves (port released) or rejects with
    // EADDRINUSE (teardown failed to close the socket); we assert the success path.
    await probePortAvailable(boundPort);
  });

  test("parent-signal abort propagates through to the process and the health socket", async () => {

    const parent = new AbortController();

    await using proc = new FfmpegStreamingProcess(makeOptions(), {

      args: stderrThenIdle(),
      healthTimeout: 5_000,
      returnPort: { ipFamily: "ipv4", port: 0 },
      signal: parent.signal
    });

    await proc.ready;

    parent.abort(new HbpuAbortError("shutdown"));

    await proc.exited;

    assert.equal(isHbpuAbortReason(proc.signal.reason, "shutdown"), true);
  });
});

describe("FfmpegStreamingProcess - pre-aborted-signal short circuit", () => {

  test("pre-aborted parent signal does NOT bind the return-port socket (no leak)", async () => {

    // The load-bearing invariant documented on `#startHealthMonitor`: when the composed signal is already aborted at the moment the health monitor would bind its
    // socket, the function must short-circuit. Without that guard, the abort listener attached to an already-aborted signal would never fire, leaking the socket for
    // the life of the process.
    //
    // Verification is two complementary checks:
    //
    //   1. INSIDE the holder's lifetime: assert the composed signal still carries the parent's reason. If the short-circuit failed, the process's bind would collide
    //      with the holder; even though the socket-error handler's `if(!this.aborted)` guard suppresses an aborted-with-failed in that case, the assertion still pins
    //      the documented invariant - the short-circuit must execute before any allocation happens.
    //   2. AFTER the holder releases: probe the same port. The proc is disposed via `await using` at try-block exit, the holder is released explicitly in the finally
    //      block - so the only way the probe could fail with `EADDRINUSE` is if the proc allocated and bound a health socket that wasn't properly closed. That's the
    //      exact "no leak" mode the test name promises, surfaced as a probe failure rather than a signal-reason mismatch.
    //
    // `holdPort(0)` atomically grabs an ephemeral port (race-free - the kernel hands one to the holder with no reserve-then-rebind window). Capture the bound port
    // as a separate `port` const before the try/finally so the post-disposal probe reads a plain value rather than a property of a disposed handle - `holder` is
    // the lifecycle anchor, `port` is the value.
    const holder = await holdPort(0);
    const port = holder.port;

    try {

      const parent = new AbortController();
      const parentReason = new HbpuAbortError("shutdown");

      parent.abort(parentReason);

      await using proc = new FfmpegStreamingProcess(makeOptions(), {

        args: stderrThenIdle(),
        healthTimeout: 5_000,
        returnPort: { ipFamily: "ipv4", port },
        signal: parent.signal
      });

      // Process is already aborted on construction - ready / exited settle via the base class's pre-aborted path. We only need to wait long enough for any
      // kernel-level socket allocation to have completed had the short-circuit failed.
      await proc.exited.catch(() => { /* ignore - exit settles without a successful spawn. */ });

      assert.equal(proc.signal.reason, parentReason,
        "composed signal must carry the parent's reason, not a bind error - proves the short-circuit fired before bind");
    } finally {

      await holder[Symbol.asyncDispose]();
    }

    // Port released by the holder. If the proc had leaked a health socket onto the same port, this probe rejects with `EADDRINUSE`; if the short-circuit fired
    // correctly, no socket was ever allocated and the probe succeeds.
    await probePortAvailable(port);
  });
});

describe("FfmpegStreamingProcess - health socket error path", () => {

  test("a kernel-level bind failure on the return port aborts the process with \"failed\" + cause", async () => {

    // Regression guard for the socket `"error"` path in `#startHealthMonitor`. We provoke a real EADDRINUSE by holding the return port with a second socket before the
    // streaming process tries to bind. The kernel surfaces the error on the next event-loop turn; the handler translates it into `HbpuAbortError("failed", { cause })`
    // and aborts the process.
    //
    // `holdPort(0)` atomically grabs an ephemeral port (no reserve-then-rebind race); the holder retains the port for the duration of the test so the streaming
    // process's own bind collides on the same port. `await using` releases the holder at scope exit via its `Symbol.asyncDispose`, so the cleanup shape stays
    // flat rather than nested in a trailing finally.
    await using holder = await holdPort(0);

    await using proc = new FfmpegStreamingProcess(makeOptions(), {

      args: stderrThenIdle(),
      healthTimeout: 5_000,
      returnPort: { ipFamily: "ipv4", port: holder.port }
    });

    // Wait for the bind failure to surface. EADDRINUSE reports on the next event-loop turn after bind.
    await delay(50);

    assert.equal(proc.aborted, true, "a bind failure on the return port must abort the streaming process");
    assert.equal(isHbpuAbortReason(proc.signal.reason, "failed"), true, "the abort reason must be \"failed\" carrying the underlying socket error");

    const reason = proc.signal.reason as { cause?: unknown };

    assert.ok(reason.cause instanceof Error, "the underlying kernel error must be attached to the signal reason's `cause` field");
  });
});

describe("FfmpegStreamingProcess - IPv6 return port", () => {

  test("binds on ::1 when ipFamily is \"ipv6\" and re-arms the watchdog on inbound packets", async () => {

    // The IPv6 path is identical to the IPv4 path except for the socket family and bind address. We exercise it end-to-end: bind an ephemeral IPv6 port via the
    // kernel-atomic `port: 0` allocation, send a datagram to [::1], assert the watchdog did not fire (inbound packet re-armed it).
    await using proc = new FfmpegStreamingProcess(makeOptions(), {

      args: stderrThenIdle(),
      healthTimeout: 100,
      returnPort: { ipFamily: "ipv6", port: 0 }
    });

    await proc.ready;
    assert.ok(proc.returnPort, "fixture pre-condition: returnPort must be set because we configured it");

    // Give the UDP bind a turn to complete before sending.
    await delay(10);

    await sendDatagram(proc.returnPort.port, HEALTH_PAYLOAD, "ipv6");

    // Wait short of the watchdog window plus a couple more sends so the re-arm behavior is proven to work across multiple IPv6 datagrams.
    await delay(40);
    await sendDatagram(proc.returnPort.port, HEALTH_PAYLOAD, "ipv6");
    await delay(40);

    assert.equal(proc.aborted, false, "IPv6 packets arriving within the window must re-arm the watchdog and keep the process alive");
    assert.equal(proc.isTimedOut, false);
  });
});
