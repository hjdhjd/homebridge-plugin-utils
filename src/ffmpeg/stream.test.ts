/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/stream.test.ts: Unit tests for FfmpegStreamingProcess - signal-driven internal health socket, liveness watchdog, abort propagation, externally readable stdout,
 * and the ending callback a socket failure asks - and the parity rows that run each lifecycle scenario a streaming consumer meets, the ending callbacks and the
 * hardware decoder's refusal among them, on the real process and on TestStreamingProcess alike.
 */
import { BackpressureClosedStreamError, BackpressureWriter } from "../backpressure.ts";
import type { FfmpegEnding, FfmpegEndingVerdict, FfmpegProcessExitInfo } from "./process.ts";
import type { FfmpegStreamingInit, StreamingProcess } from "./stream.ts";
import { FfmpegStreamingProcess, streamingProcessFactory } from "./stream.ts";
import { HbpuAbortError, onAbort } from "../util.ts";
import { TestStreamingProcessFactory, assertNoUnhandledRejections, capturingLog, expectAt, hardwareDecoderRefusalLine, linesAt, settle, silentLog, waitUntil }
  from "../testing/index.ts";
import { assertEachSubject, endingSpies, lifetimeState, reasonName, settlement } from "./process-parity.helpers.ts";
import { describe, mock, test } from "node:test";
import { holdPort, probePortAvailable, sendDatagram } from "./udp.helpers.ts";
import type { Clock } from "../clock.ts";
import type { EndingSpies } from "./process-parity.helpers.ts";
import { FfmpegOptions } from "./options.ts";
import type { HomebridgePluginLogging } from "../util.ts";
import { TestClock } from "../clock-double.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { makeCodecs } from "./codecs.helpers.ts";
import { once } from "node:events";

function makeOptions(logger: HomebridgePluginLogging = silentLog(), clock?: Clock, ffmpegExec = process.execPath): FfmpegOptions {

  return new FfmpegOptions({

    clock,
    codecSupport: makeCodecs({ ffmpegExec, ffmpegVersion: "test" }),
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

    // The `returnPort` getter projects `init.returnPort` (which was unset here) onto its undefined branch. Asserting the contract directly so a future regression
    // that returned a sentinel descriptor instead of `undefined` would surface here rather than via collateral failures elsewhere.
    assert.equal(proc.returnPort, undefined, "without a configured returnPort, the getter must return undefined - not a sentinel descriptor");
  });

  test("stdout stays externally readable because the subclass does not consume it", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stdoutAndStderrThenIdle("two-way-audio-bytes", "ready") });

    await proc.ready;

    // Read one chunk from stdout to prove an external consumer can attach. The talkback path in HBUP reads stdout this way. `events.once` returns a Promise of the
    // listener arguments - the canonical Node idiom for "await one event." Stdout here is never switched into string or object mode, so a "data" event always
    // yields a Buffer, which is what makes the `[Buffer]` cast below safe.
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
    // process must stay alive through any wait - this is the cold-start case where the first return packet has not yet round-tripped. 80ms is comfortably inside the
    // window a ready-armed watchdog would have tripped on a cold start; we wait 250ms (well past it) to prove the first-packet-armed watchdog truly never arms without
    // a packet. We deliberately do NOT `await proc.exited` here: with no packet the watchdog never fires and `stderrThenIdle()` idles forever, so the process never
    // exits on its own - awaiting it would hang the run.
    await delay(250);

    assert.equal(proc.isTimedOut, false, "with no inbound packet the watchdog must never arm, so a cold-start stream must not be aborted with a timeout reason");
    assert.equal(proc.signal.reason, undefined);

    // Tear down explicitly so the still-idling child is reaped. `await using` would also dispose at scope exit, but aborting here makes the cleanup intent obvious and
    // settles the process deterministically before the assertions' scope ends.
    proc.abort(new HbpuAbortError("shutdown"));
  });

  test("inbound packets re-arm the watchdog and keep the process alive", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stderrThenIdle(), healthTimeout: 80, returnPort: { ipFamily: "ipv4", port: 0 } });

    await proc.ready;

    // The `assert.ok` narrows the `FfmpegStreamingReturnPort | undefined` union for TypeScript - we configured returnPort at construction, so this assertion never
    // fires in practice. The getter's docblock (stream.ts) documents the timing contract: the kernel-assigned port becomes observable when the socket's
    // `"listening"` event fires, which happens inside the constructor, because the health socket's bind to its loopback literal completes inside the call.
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

    // The kernel-assigned port is observable once the socket's `"listening"` event has fired, which happens inside the constructor because the health socket's bind
    // completes inside the call - the same contract the re-arm test above relies on, so we read `proc.returnPort.port` directly rather than waiting on
    // `"listening"`. The `assert.ok` narrows the `FfmpegStreamingReturnPort | undefined` union for TypeScript.
    assert.ok(proc.returnPort, "fixture pre-condition: returnPort must be set because we configured it");

    // Send exactly ONE datagram and await its delivery. This is the arming packet: it proves the watchdog only fires AFTER liveness is established, rather than
    // being armed unconditionally at construction. Awaiting `sendDatagram` guarantees the packet has been handed to the kernel - and therefore the message handler
    // has armed - before the silence window opens below.
    await sendDatagram(proc.returnPort.port, HEALTH_PAYLOAD);

    // Now go silent for longer than the window. The watchdog was armed by the single packet above, so with no further packets it must count down and fire. 250ms is
    // generous slack past the 80ms window for the watchdog to fire and the abort to settle before the assertions run.
    await delay(250);

    assert.equal(proc.isTimedOut, true, "after the first packet arms the watchdog, a gap longer than the window with no further packets must abort with a timeout");
    assert.throws(() => proc.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "timeout" });
  });

  test("a clock carried on the options drives the health window in virtual time, in both directions", async () => {

    const clock = new TestClock();

    await using proc = new FfmpegStreamingProcess(makeOptions(silentLog(), clock), { args: stderrThenIdle(), healthTimeout: 1000,
      returnPort: { ipFamily: "ipv4", port: 0 } });

    await proc.ready;

    assert.ok(proc.returnPort, "fixture pre-condition: returnPort must be set because we configured it");

    // The health socket's message handler does exactly one thing - arm the watchdog - so the arm's own effect on the injected clock IS the observable that follows
    // it. A pending entry appearing on the clock is therefore proof both that the first datagram reached the handler and that the handler armed on THIS clock rather
    // than on the platform, which is what makes the two advances below exact and what makes this row impossible to pass against an unwired composer.
    await sendDatagram(proc.returnPort.port, HEALTH_PAYLOAD);
    await waitUntil(() => clock.pending > 0, { description: "the first inbound packet arms the health window on the injected clock" });

    clock.advance(999);

    assert.equal(proc.aborted, false, "one millisecond short of the window, nothing has fired");

    clock.advance(1);

    assert.equal(proc.isTimedOut, true, "the full window elapsing on the injected clock aborts the process");
    assert.throws(() => proc.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "timeout" });
  });
});

describe("FfmpegStreamingProcess - teardown propagation", () => {

  test("aborting the process also tears down the health socket", async () => {

    await using proc = new FfmpegStreamingProcess(makeOptions(), { args: stderrThenIdle(), healthTimeout: 5000, returnPort: { ipFamily: "ipv4", port: 0 } });

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
      healthTimeout: 5000,
      returnPort: { ipFamily: "ipv4", port: 0 },
      signal: parent.signal
    });

    await proc.ready;

    parent.abort(new HbpuAbortError("shutdown"));

    await proc.exited;

    assert.throws(() => proc.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "shutdown" });
  });
});

describe("FfmpegStreamingProcess - pre-aborted-signal short circuit", () => {

  test("pre-aborted parent signal does NOT bind the return-port socket (no leak)", async () => {

    // The guarantee documented on `#startHealthMonitor`: when the composed signal is already aborted at the moment the health monitor would bind its
    // socket, the function must short-circuit. Without that guard, the abort listener attached to an already-aborted signal would never fire, leaking the socket for
    // the life of the process.
    //
    // Verification is two complementary checks:
    //
    //   1. INSIDE the holder's lifetime: assert the composed signal still carries the parent's reason. If the short-circuit failed, the process's bind would collide
    //      with the holder; even though the socket-error handler's `if(!this.aborted)` guard suppresses an aborted-with-failed in that case, the assertion still
    //      asserts the documented rule - the short-circuit must execute before any allocation happens.
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
        healthTimeout: 5000,
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
    // streaming process tries to bind. The bind to the loopback literal fails inside the constructor, so the kernel's error has reached the handler by the time
    // construction returns; the handler translates it into `HbpuAbortError("failed", { cause })` and aborts the process.
    //
    // `holdPort(0)` atomically grabs an ephemeral port (no reserve-then-rebind race); the holder retains the port for the duration of the test so the streaming
    // process's own bind collides on the same port. `await using` releases the holder at scope exit via its `Symbol.asyncDispose`, so the cleanup shape stays
    // flat rather than nested in a trailing finally.
    await using holder = await holdPort(0);

    await using proc = new FfmpegStreamingProcess(makeOptions(), {

      args: stderrThenIdle(),
      healthTimeout: 5000,
      returnPort: { ipFamily: "ipv4", port: holder.port }
    });

    // The bind failure has already surfaced inside the constructor; the short delay is only a margin before we assert.
    await delay(50);

    assert.equal(proc.aborted, true, "a bind failure on the return port must abort the streaming process");
    assert.throws(() => proc.signal.throwIfAborted(), { constructor: HbpuAbortError, name: "failed" });

    // Narrows to the `{ cause }` shape `HbpuAbortError("failed", { cause: error })` attaches via the standard Error `cause` option, which the assertion below
    // then verifies.
    const reason = proc.signal.reason as { cause?: unknown };

    assert.ok(reason.cause instanceof Error, "the underlying kernel error must be attached to the signal reason's `cause` field");
  });

  test("a bind failure asks onFailed once with the socket's error as its cause, and the socket's own line is the only error line once it handles it", async () => {

    await using holder = await holdPort(0);

    const logger = capturingLog();
    const onFailed = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled");

    await using proc = new FfmpegStreamingProcess(makeOptions(logger), { args: stderrThenIdle(), healthTimeout: 5000, onFailed,
      returnPort: { ipFamily: "ipv4", port: holder.port } });

    await waitUntil(() => proc.aborted, { description: "the bind failure on the held return port to abort the streaming process" });

    assert.equal(onFailed.mock.callCount(), 1, "onFailed is asked once");

    const { reason } = expectAt(onFailed.mock.calls, 0, "the asking").arguments[0];

    assert.equal(reason.name, "failed", "about a failed ending");
    assert.ok(reason.cause instanceof Error, "whose cause is the socket's error");
    assert.deepEqual(linesAt(logger.entries, "error"), ["Streaming process return-port socket error: " + reason.cause.message + "."],
      "and the socket's line, logged before the process ended, stands while the handled report does not");
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

    // The UDP bind completed inside the constructor; the short delay is only a margin before the first send.
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

/* The point a parity row starts from. `silent` is a child that runs and writes nothing, `ready` one that has written its first stderr line and idles, `exitsZero` and
 * `exitsNonzero` a child that exits on its own, writing nothing, with status 0 or 3, `stderrThenExitsNonzero` one that writes invented stderr lines and then exits
 * with status 3, `stdoutThenExits` one that writes to stdout and then exits with status 0, and `spawnFails` a process whose binary does not exist. The refusal
 * stages write the hardware decoder's refusal and exit a moment later, so the line is read before the exit: `refusalOnGpuThenExitsNonzero` asks for its decoded
 * frames on the GPU and exits nonzero, `refusalThenExitsNonzero` takes its frames in system memory and exits nonzero, and `refusalThenExitsZero` exits cleanly.
 */
type StreamingStage = "exitsNonzero" | "exitsZero" | "ready" | "refusalOnGpuThenExitsNonzero" | "refusalThenExitsNonzero" | "refusalThenExitsZero" | "silent" |
  "spawnFails" | "stderrThenExitsNonzero" | "stdoutThenExits";

// The ending callbacks a parity row hands a subject in its init.
type EndingCallbacks = Pick<FfmpegStreamingInit, "onFailed" | "onTimeout">;

// Bring a subject to a stage, its lifetime composed with `signal`, its init carrying `callbacks`, and built over `options` when a row hands its own.
type StartStreaming = (stage: StreamingStage, signal: AbortSignal, callbacks: EndingCallbacks, options?: FfmpegOptions) => Promise<StreamingProcess>;

// What the stdoutThenExits child writes to stdout.
const STDOUT_BYTES = "talkback-bytes";

// What the stderrThenExitsNonzero child writes to stderr, a line at a time, before it exits.
const STDERR_LINES = [ "An invented stderr line ahead of a failed exit.", "A second invented stderr line." ];

// A binary path nothing lives at, for the spawn that fails.
const MISSING_FFMPEG = "/nonexistent-hbpu-streaming-parity/ffmpeg";

// The exit a child killed by its process's abort reports.
const KILLED: FfmpegProcessExitInfo = { exitCode: null, exitSignal: "SIGKILL" };

// A child that writes the hardware decoder's refusal and exits with `exitCode` a moment later, the delay letting the process read the line before the exit ends it.
function refusalThenExit(exitCode: number): string[] {

  return [ "-e", "process.stderr.write(" + JSON.stringify(hardwareDecoderRefusalLine + "\n") + "); setTimeout(() => process.exit(" + exitCode.toString() + "), 10);" ];
}

// The stand-in script that brings the real process to a stage. The spawn that fails runs nothing, so it takes no script.
function streamingStageScript(stage: StreamingStage): string[] {

  switch(stage) {

    case "exitsNonzero":

      return [ "-e", "process.exit(3);" ];

    case "exitsZero":

      return [ "-e", "process.exit(0);" ];

    case "ready":

      return stderrThenIdle();

    case "refusalOnGpuThenExitsNonzero":

      // Node takes everything after `--` as positional argv, so the child runs its script while each subject sees the GPU-frames argument in its args.
      return [ ...refusalThenExit(3), "--", "-hwaccel_output_format", "videotoolbox_vld" ];

    case "refusalThenExitsNonzero":

      return refusalThenExit(3);

    case "refusalThenExitsZero":

      return refusalThenExit(0);

    case "silent":

      return [ "-e", "setInterval(() => {}, 100000);" ];

    case "spawnFails":

      return [];

    case "stderrThenExitsNonzero":

      return [ "-e", "process.stderr.write(" + JSON.stringify(STDERR_LINES.join("\n") + "\n") + ", () => process.exit(3));" ];

    case "stdoutThenExits":

      return [ "-e", "process.stdout.write(" + JSON.stringify(STDOUT_BYTES) + ", () => process.exit(0));" ];
  }
}

// The real subject: a process the production factory built, running the stage's script or pointed at a binary that does not exist, over the options the row handed
// or its own. For the ready stage it waits for the first stderr line, so the row starts where the double's ready lever leaves it.
async function startRealStreaming(stage: StreamingStage, signal: AbortSignal, callbacks: EndingCallbacks,
  options = makeOptions(silentLog(), undefined, (stage === "spawnFails") ? MISSING_FFMPEG : process.execPath)): Promise<StreamingProcess> {

  const proc = streamingProcessFactory.create(options, { ...callbacks, args: streamingStageScript(stage), signal });

  assert.ok(proc instanceof FfmpegStreamingProcess, "the production factory must build an FfmpegStreamingProcess");

  if(stage === "ready") {

    await proc.ready;
  }

  return proc;
}

/* The double subject: a process TestStreamingProcessFactory built over the row's signal, callbacks and options, or its own options, driven to the stage the real child
 * reaches on its own. A real child's own events arrive on a later turn than the row's start, so a stage's exit, output, stderr lines or spawn failure are pulled a
 * turn after the start. A real child the row's abort kills exits a turn later, reporting the kill, so the exit lever is pulled then with the exit a killed child
 * reports, unless the stage has already ended the child.
 */
async function startDoubleStreaming(stage: StreamingStage, signal: AbortSignal, callbacks: EndingCallbacks, options = makeOptions()): Promise<StreamingProcess> {

  const factory = new TestStreamingProcessFactory();

  factory.create(options, { ...callbacks, args: streamingStageScript(stage), signal });

  const proc = expectAt(factory.createCalls, 0, "the process the factory built").process;
  let ended = false;

  // The child ends on its own a turn after the start, as a real child does.
  const endsOnItsOwn = (lever: () => void): void => {

    ended = true;
    setImmediate(lever);
  };

  onAbort(signal, () => setImmediate(() => {

    if(!ended) {

      ended = true;
      proc.exit(KILLED);
    }
  }));

  switch(stage) {

    case "exitsNonzero":

      endsOnItsOwn(() => proc.exit({ exitCode: 3, exitSignal: null }));

      break;

    case "exitsZero":

      endsOnItsOwn(() => proc.exit({ exitCode: 0, exitSignal: null }));

      break;

    case "ready":

      proc.resolveReady();

      break;

    case "refusalOnGpuThenExitsNonzero":
    case "refusalThenExitsNonzero":
    case "refusalThenExitsZero":

      // The real child's refusal line resolves its ready and is in its log, and has marked its options, by the time its exit ends it.
      endsOnItsOwn(() => {

        proc.resolveReady();
        proc.stderrLog = [hardwareDecoderRefusalLine];
        proc.exit({ exitCode: (stage === "refusalThenExitsZero") ? 0 : 3, exitSignal: null });
      });

      break;

    case "silent":

      break;

    case "spawnFails":

      endsOnItsOwn(() => proc.failSpawn(Object.assign(new Error("spawn " + MISSING_FFMPEG + " ENOENT"), { code: "ENOENT" })));

      break;

    case "stderrThenExitsNonzero":

      // The real child's first stderr line resolves its ready, and every line it wrote is in its log by the time its exit ends it.
      endsOnItsOwn(() => {

        proc.resolveReady();
        proc.stderrLog = STDERR_LINES;
        proc.exit({ exitCode: 3, exitSignal: null });
      });

      break;

    case "stdoutThenExits":

      endsOnItsOwn(() => {

        proc.writeStdout(Buffer.from(STDOUT_BYTES));
        proc.exit({ exitCode: 0, exitSignal: null });
      });

      break;
  }

  return proc;
}

// What a row may hand withSubject beside its body: the ending callbacks its subject's init carries, the controller it aborted ahead of the start, and the options its
// subject is built over, a fresh object for each subject, when the row reads what a subject marks.
interface SubjectInit {

  callbacks?: EndingCallbacks;
  controller?: AbortController;
  options?: FfmpegOptions;
}

/* Run a parity row's body over a subject brought to `stage`, and reap the subject once the body is done, whatever it did: the row's signal ends a child still
 * running and its exit is awaited, so no real child outlives its row.
 */
async function withSubject<T>(start: StartStreaming, stage: StreamingStage, body: (proc: StreamingProcess, controller: AbortController) => Promise<T>,
  { callbacks = {}, controller = new AbortController(), options }: SubjectInit = {}): Promise<T> {

  const proc = await start(stage, controller.signal, callbacks, options);

  try {

    return await body(proc, controller);
  } finally {

    controller.abort(new HbpuAbortError("shutdown"));

    // A spawn that failed rejects exited, and reaping only waits for it to settle.
    await proc.exited.catch(() => undefined);
  }
}

// Run one streaming scenario against the double and against the real process through the shared parity runner, over this suite's starters.
async function assertEachStreaming<T>(expected: T, scenario: (start: StartStreaming) => Promise<T>): Promise<void> {

  await assertEachSubject({ double: startDoubleStreaming, real: startRealStreaming }, expected, scenario);
}

// The cause a lifetime's reason carries: an error by its code, as the spawn's error is, or the value itself, as an exit's information is.
function causeOf(signal: AbortSignal): unknown {

  const cause: unknown = (signal.reason as { cause?: unknown }).cause;

  return (cause instanceof Error) ? ("an error with code " + String((cause as NodeJS.ErrnoException).code)) : cause;
}

// What a row reads at the exit: how exited settled, the lifetime and the cause its reason carries, and whether stdin is still writable.
interface ExitReading {

  cause: unknown;
  exited: string;
  lifetime: string;
  stdinWritable: boolean;
}

/* Read a subject at its exit, from inside a continuation of exited, where its lifetime has already ended. A subject that settles exited and ends its lifetime in
 * separate turns reads "live" here.
 */
async function atExit(proc: StreamingProcess): Promise<ExitReading> {

  const read = (exited: string): ExitReading => ({ cause: causeOf(proc.signal), exited, lifetime: lifetimeState(proc.signal), stdinWritable: proc.stdin.writable });

  return proc.exited.then((info) => read("resolved " + String(info.exitCode) + " " + String(info.exitSignal)), (error: unknown) => read("rejected " + reasonName(error)));
}

// How a write settled: "written", or the name of the closed-stream error it rejected with.
async function writeOutcome(write: Promise<void>): Promise<string> {

  try {

    await write;

    return "written";
  } catch(error: unknown) {

    return (error instanceof BackpressureClosedStreamError) ? error.name : ("another error: " + String(error));
  }
}

describe("StreamingProcess - the real process and TestStreamingProcess agree on the lifecycle", () => {

  test("ready resolves once the child has written its first stderr line, and the lifetime stays live", async () => {

    await assertEachStreaming({ lifetime: "live", ready: "resolved" }, async (start) => withSubject(start, "ready", async (proc) => {

      const ready = await settlement(proc.ready);

      return { lifetime: lifetimeState(proc.signal), ready };
    }));
  });

  test("a spawn that fails rejects ready and exited with a failed reason carrying the spawn's error, the lifetime ended and stdin closed as exited settles", async () => {

    await assertEachStreaming({ exit: { cause: "an error with code ENOENT", exited: "rejected failed", lifetime: "failed", stdinWritable: false },
      ready: "rejected failed" }, async (start) => withSubject(start, "spawnFails", async (proc) => {

      const exit = atExit(proc);

      return { exit: await exit, ready: await settlement(proc.ready) };
    }));
  });

  for(const [ stage, exitCode, lifetime ] of [ [ "exitsZero", 0, "closed" ], [ "exitsNonzero", 3, "failed" ] ] as const) {

    test("a child exiting on its own with status " + String(exitCode) + " ends the lifetime " + lifetime + " as exited resolves and rejects ready", async () => {

      await assertEachStreaming({ exit: { cause: { exitCode, exitSignal: null }, exited: "resolved " + String(exitCode) + " null", lifetime, stdinWritable: false },
        ready: "rejected " + lifetime }, async (start) => withSubject(start, stage, async (proc) => {

        const exit = atExit(proc);

        return { exit: await exit, ready: await settlement(proc.ready) };
      }));
    });
  }

  test("an exit after the parent's abort keeps the abort's reason, stdin writable from the abort until exited settles", async () => {

    await assertEachStreaming({ exit: { cause: undefined, exited: "resolved null SIGKILL", lifetime: "replaced", stdinWritable: false }, stdinAfterAbort: true },
      async (start) => withSubject(start, "ready", async (proc, controller) => {

        const exit = atExit(proc);

        controller.abort(new HbpuAbortError("replaced"));

        const stdinAfterAbort = proc.stdin.writable;

        return { exit: await exit, stdinAfterAbort };
      }));
  });

  test("stdout carries what the child wrote and ends with the child's output", async () => {

    await assertEachStreaming({ lifetime: "closed", stdout: STDOUT_BYTES }, async (start) => withSubject(start, "stdoutThenExits", async (proc) => {

      const stdout = Buffer.concat(await proc.stdout.toArray() as Buffer[]).toString();

      await proc.exited;

      return { lifetime: lifetimeState(proc.signal), stdout };
    }));
  });

  test("a writer over stdin writes while the child runs and meets the closed stream once exited settles", async () => {

    await assertEachStreaming({ afterExit: "BackpressureClosedStreamError", whileRunning: "written" }, async (start) => withSubject(start, "ready",
      async (proc, controller) => {

        await using writer = new BackpressureWriter(() => proc.stdin);

        const whileRunning = await writeOutcome(writer.write(Buffer.from("frame")));

        controller.abort(new HbpuAbortError("replaced"));
        await proc.exited;

        return { afterExit: await writeOutcome(writer.write(Buffer.from("late"))), whileRunning };
      }));
  });

  test("an abort before ready rejects ready with the abort's reason", async () => {

    await assertEachStreaming({ lifetime: "replaced", ready: "rejected replaced" }, async (start) => withSubject(start, "silent", async (proc, controller) => {

      const ready = settlement(proc.ready);

      controller.abort(new HbpuAbortError("replaced"));

      return { lifetime: lifetimeState(proc.signal), ready: await ready };
    }));
  });

  test("nothing is reported unhandled when neither ready nor exited is read, whether the parent's abort or a failed spawn ends the process", async () => {

    await assertEachStreaming({ abort: "none", spawnFails: "none" }, async (start) => ({

      abort: await withSubject(start, "silent", async (proc, controller) => assertNoUnhandledRejections(async () => {

        controller.abort(new HbpuAbortError("replaced"));
        await settle();

        return lifetimeState(proc.signal) === "replaced" ? "none" : "the lifetime did not end";
      })),
      spawnFails: await withSubject(start, "spawnFails", async (proc) => assertNoUnhandledRejections(async () => {

        await waitUntil(() => proc.signal.aborted, { description: "the spawn to fail" });
        await settle();

        return "none";
      }))
    }));
  });
});

/* The askings a row's spies have taken: for each callback, the name of the reason each asking was about, in order. A row compares these, which say which callback a
 * subject asked, how often, and about what ending.
 */
function askings(spies: EndingSpies): { onFailed: string[]; onTimeout: string[] } {

  return { onFailed: spies.onFailed.mock.calls.map((call) => call.arguments[0].reason.name),
    onTimeout: spies.onTimeout.mock.calls.map((call) => call.arguments[0].reason.name) };
}

describe("StreamingProcess - the real process and TestStreamingProcess ask the same ending callbacks", () => {

  // An exit or a spawn failure is read inside a continuation of exited, where each subject has already asked. An abort is read right after it, inside which each
  // subject asks, and again once exited settles, so a second asking at the exit that follows the abort shows.

  test("a child that writes stderr lines and exits nonzero asks onFailed once with those lines", async () => {

    await assertEachStreaming({ asked: { onFailed: ["failed"], onTimeout: [] }, lines: [STDERR_LINES] }, async (start) => {

      const spies = endingSpies();

      return withSubject(start, "stderrThenExitsNonzero", async (proc) => proc.exited.then(() => ({ asked: askings(spies),
        lines: spies.onFailed.mock.calls.map((call) => [...call.arguments[0].stderrLog]) })), { callbacks: spies });
    });
  });

  test("the parent's timeout abort asks onTimeout once, inside the abort and no more at the exit that follows", async () => {

    const asked = { onFailed: [], onTimeout: ["timeout"] };

    await assertEachStreaming({ afterAbort: asked, atExit: asked }, async (start) => {

      const spies = endingSpies();

      return withSubject(start, "ready", async (proc, controller) => {

        controller.abort(new HbpuAbortError("timeout"));

        const afterAbort = askings(spies);

        await proc.exited;

        return { afterAbort, atExit: askings(spies) };
      }, { callbacks: spies });
    });
  });

  test("a spawn that fails asks onFailed once", async () => {

    await assertEachStreaming({ onFailed: ["failed"], onTimeout: [] }, async (start) => {

      const spies = endingSpies();

      return withSubject(start, "spawnFails", async (proc) => proc.exited.then(() => askings(spies), () => askings(spies)), { callbacks: spies });
    });
  });

  test("a child exiting cleanly on its own asks neither callback", async () => {

    await assertEachStreaming({ onFailed: [], onTimeout: [] }, async (start) => {

      const spies = endingSpies();

      return withSubject(start, "exitsZero", async (proc) => proc.exited.then(() => askings(spies)), { callbacks: spies });
    });
  });

  test("the parent's shutdown abort asks neither callback, inside the abort or at the exit that follows", async () => {

    const asked = { onFailed: [], onTimeout: [] };

    await assertEachStreaming({ afterAbort: asked, atExit: asked }, async (start) => {

      const spies = endingSpies();

      return withSubject(start, "ready", async (proc, controller) => {

        controller.abort(new HbpuAbortError("shutdown"));

        const afterAbort = askings(spies);

        await proc.exited;

        return { afterAbort, atExit: askings(spies) };
      }, { callbacks: spies });
    });
  });

  test("a parent already aborted as failed asks onFailed once, with no lines, by the time the subject's start has returned, and no more at the exit", async () => {

    const asked = { onFailed: ["failed"], onTimeout: [] };

    await assertEachStreaming({ afterStart: asked, atExit: asked, lines: [[]] }, async (start) => {

      const spies = endingSpies();
      const controller = new AbortController();

      controller.abort(new HbpuAbortError("failed"));

      return withSubject(start, "silent", async (proc) => {

        const afterStart = askings(spies);
        const lines = spies.onFailed.mock.calls.map((call) => [...call.arguments[0].stderrLog]);

        await proc.exited;

        return { afterStart, atExit: askings(spies), lines };
      }, { callbacks: spies, controller });
    });
  });
});

describe("StreamingProcess - the real process and TestStreamingProcess agree on the hardware decoder's refusal", () => {

  // Each subject is built over a fresh options object of its own, so each reading of the mark is that subject's own, and every reading is taken inside a
  // continuation of exited, where each subject has already marked its options and asked.

  // A refusal row's reading: the askings, the lifetime and whether the subject's own options were marked.
  async function refusalReading(start: StartStreaming, stage: StreamingStage): Promise<{ asked: ReturnType<typeof askings>; lifetime: string; marked: boolean }> {

    const spies = endingSpies();
    const options = makeOptions();

    return withSubject(start, stage, async (proc) => proc.exited.then(() => ({ asked: askings(spies), lifetime: lifetimeState(proc.signal),
      marked: options.hardwareDecoderRefused })), { callbacks: spies, options });
  }

  test("a failed child that reports the refusal with its frames asked on the GPU asks no callback and leaves its options marked", async () => {

    await assertEachStreaming({ asked: { onFailed: [], onTimeout: [] }, lifetime: "failed", marked: true },
      async (start) => refusalReading(start, "refusalOnGpuThenExitsNonzero"));
  });

  test("a failed child that reports the refusal with its frames in system memory asks onFailed once and leaves its options marked", async () => {

    await assertEachStreaming({ asked: { onFailed: ["failed"], onTimeout: [] }, lifetime: "failed", marked: true },
      async (start) => refusalReading(start, "refusalThenExitsNonzero"));
  });

  test("a child that reports the refusal and exits cleanly asks nothing and leaves its options marked", async () => {

    await assertEachStreaming({ asked: { onFailed: [], onTimeout: [] }, lifetime: "closed", marked: true },
      async (start) => refusalReading(start, "refusalThenExitsZero"));
  });
});
