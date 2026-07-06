/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/stream.ts: FFmpeg process control for HomeKit livestreaming with signal-driven stream-health monitoring.
 */

/**
 * HomeKit livestreaming FFmpeg process with a signal-driven internal stream-health monitor.
 *
 * This module defines `FfmpegStreamingProcess`, the specialization of {@link FfmpegProcess} for HomeKit live video sessions. The subclass extends the base directly and
 * composes an internal UDP socket that watches the return port for inbound packets - the HomeKit client's RTCP receiver reports, which flow only once the client is
 * receiving FFmpeg's output. The watchdog arms on the first such packet; if that return traffic then stops for longer than the configured window the socket aborts the
 * process with `HbpuAbortError("timeout")` and the base class teardown handles the rest. There is no separate "delegate" surface, no error callbacks,
 * and no reach-through to the raw ChildProcess - every external interaction is through the inherited `signal`, `ready`, `exited`, `stdin`, `stderr`, `stderrLog`,
 * `abort()`, and `[Symbol.asyncDispose]`.
 *
 * `stdout` stays externally readable on this subclass because HBUP's two-way-audio talkback path forwards stdout bytes to the WebSocket that carries audio from the
 * camera back to the HomeKit client. Unlike the fMP4 subclasses, there is no internal consumer of the stdout stream that would race with an external reader.
 *
 * The stream-health socket is intentionally simpler than {@link ffmpeg/rtp!RtpDemuxer | RtpDemuxer}: its sole job is to detect liveness on a known return port. It
 * does not classify RTP vs. RTCP or forward packets. Two-way-audio demuxing is `RtpDemuxer`'s responsibility and lives in its own class.
 *
 * @module
 */
import { HbpuAbortError, Watchdog, onAbort } from "../util.ts";
import { createDgramSocket, loopbackAddress } from "./dgram-util.ts";
import type { FfmpegOptions } from "./options.ts";
import { FfmpegProcess } from "./process.ts";
import type { FfmpegProcessInit } from "./process.ts";
import type { IpFamily } from "./dgram-util.ts";
import { STREAM_HEALTH_TIMEOUT } from "./settings.ts";

/**
 * UDP return-port descriptor for the stream-health monitor.
 *
 * @property ipFamily   - The IP family: `"ipv4"` binds to `127.0.0.1`, `"ipv6"` binds to `::1`. Shares the {@link IpFamily} alias with `RtpDemuxerInit`,
 *                        `PortReservationInit`, and `PortReservation` so every UDP-aware init type in the FFmpeg subsystem reads from the same vocabulary.
 * @property port       - The UDP port to bind to. Pass `0` to request kernel-assigned ephemeral allocation: the bind succeeds atomically against whichever port
 *                        the kernel hands out, eliminating the reserve-then-rebind race that a separate reservation step would carry. The assigned port is then
 *                        observable via {@link FfmpegStreamingProcess.returnPort} once {@link FfmpegStreamingProcess.ready} resolves.
 *
 * @category FFmpeg
 */
export interface FfmpegStreamingReturnPort {

  ipFamily: IpFamily;
  port: number;
}

/**
 * Construction-time options for {@link FfmpegStreamingProcess}.
 *
 * @property healthTimeout    - Optional inactivity window, in milliseconds, between inbound packets on the return port (the HomeKit client's RTCP receiver reports).
 *                              The watchdog arms on the first such packet, then aborts with `HbpuAbortError("timeout")` if a later window elapses with no packet.
 *                              Defaults to {@link STREAM_HEALTH_TIMEOUT} (5 seconds). This is the watchdog's own cadence, not an FFmpeg input timeout.
 * @property returnPort       - Optional UDP return-port descriptor. When provided, the subclass binds a UDP socket to the port and enforces the liveness watchdog on
 *                              inbound traffic. Omit for two-way-audio sessions where packet flow is demuxed externally (e.g., via `RtpDemuxer`).
 *
 * @see FfmpegProcessInit
 *
 * @category FFmpeg
 */
export interface FfmpegStreamingInit extends FfmpegProcessInit {

  healthTimeout?: number;
  returnPort?: FfmpegStreamingReturnPort;
}

/**
 * FFmpeg process specialization for HomeKit livestreaming. Extends {@link FfmpegProcess} directly and composes an internal stream-health UDP socket when a return port
 * is configured.
 *
 * Lifecycle is entirely signal-driven: construction spawns the child and (optionally) binds the health socket; the socket watches for inbound packets and aborts the
 * process with `"timeout"` if the window lapses; the inherited teardown path closes the socket and clears the watchdog timer as part of its signal-abort listener
 * fan-out. The subclass adds no new public verbs beyond what {@link FfmpegProcess} provides.
 *
 * @example
 *
 * ```ts
 * await using proc = new FfmpegStreamingProcess(ffmpegOptions, {
 *
 *   args: commandLineArgs,
 *   returnPort: { ipFamily: "ipv4", port: 50000 },
 *   signal: session.controller.signal
 * });
 *
 * await proc.ready;
 *
 * // Observe the process from the session's own control flow. When the health socket detects a stall, proc.signal fires
 * // with reason "timeout" and proc.exited resolves with the kill-driven exit context. Surface crashes via the owning
 * // session's error path.
 * proc.exited.catch((error) => session.onStreamingError(error));
 * ```
 *
 * @see FfmpegProcess
 *
 * @category FFmpeg
 */
export class FfmpegStreamingProcess extends FfmpegProcess {

  // The return-port descriptor requested at construction (verbatim from `init.returnPort`). Undefined when no return port was configured. Read through the
  // {@link FfmpegStreamingProcess.returnPort} getter, which projects the kernel-assigned port over this descriptor once the bind settles.
  readonly #requestedReturnPort: FfmpegStreamingReturnPort | undefined;

  // The port the kernel actually bound the health socket to, captured from `socket.address().port` once the `"listening"` event fires. Undefined until then. For
  // specific-port binds this duplicates {@link #requestedReturnPort}'s port field but the assignment keeps the post-bind read path uniform across both construction
  // modes (specific port and `port: 0` ephemeral).
  #assignedReturnPort: number | undefined;

  /**
   * Construct and spawn a new streaming FFmpeg process.
   *
   * Spawning happens synchronously as part of construction. When `init.returnPort` is supplied, the subclass binds a UDP socket and enforces the liveness watchdog; the
   * socket closes and the watchdog clears as part of the inherited teardown when the signal aborts for any reason.
   *
   * @param options - Shared {@link FfmpegOptions} configuration (codec support, logger, debug flag, name).
   * @param init    - Optional init options. See {@link FfmpegStreamingInit}.
   */
  public constructor(options: FfmpegOptions, init: FfmpegStreamingInit = {}) {

    super(options, init);

    this.#requestedReturnPort = init.returnPort;

    if(init.returnPort) {

      this.#startHealthMonitor(init.returnPort, init.healthTimeout ?? STREAM_HEALTH_TIMEOUT);
    }
  }

  /**
   * The UDP return-port descriptor the health socket is bound to, or `undefined` when no return port was configured. For a specific-port construction
   * (`init.returnPort.port` non-zero), this descriptor equals `init.returnPort` from the moment the constructor returns; for an ephemeral construction
   * (`init.returnPort.port === 0`), the `port` field is `0` until the kernel completes the bind, then the kernel-assigned port. Consumers that need the assigned
   * ephemeral port `await proc.ready` before reading it; in practice the health-socket bind completes well before the FFmpeg child reaches the `ready` signal, so a
   * post-`ready` read always observes the kernel's pick.
   *
   * Returns a fresh descriptor on every read; callers must treat the result as read-only. The `ipFamily` field is the verbatim value passed at construction; the
   * `port` field reads from the live socket-address projection once captured (specific and ephemeral binds converge on a single read path).
   *
   * @returns The bound return-port descriptor, or `undefined` when no return port was configured.
   */
  public get returnPort(): FfmpegStreamingReturnPort | undefined {

    if(this.#requestedReturnPort === undefined) {

      return undefined;
    }

    return {

      ipFamily: this.#requestedReturnPort.ipFamily,
      port: this.#assignedReturnPort ?? this.#requestedReturnPort.port
    };
  }

  // Bind a UDP socket to the return port and enforce a re-armed inactivity watchdog. Called from the constructor when a return-port descriptor is provided. The
  // pre-aborted-signal guard is load-bearing: if the caller passed an already-aborted parent signal, the base class's teardown runs synchronously during `super()` and
  // `this.signal` is aborted by the time we get here. Registering an `"abort"` listener on an already-aborted signal does NOT re-dispatch, so the socket and watchdog
  // timer would leak if we proceeded. Short-circuiting leaves no resources allocated.
  #startHealthMonitor(returnPort: FfmpegStreamingReturnPort, timeoutMs: number): void {

    if(this.aborted) {

      return;
    }

    const socket = createDgramSocket(returnPort.ipFamily);

    // Capture the kernel-assigned port as soon as the bind succeeds. For specific-port binds this duplicates `returnPort.port`; for ephemeral binds (port: 0) this
    // is where the kernel's pick becomes observable via {@link returnPort}. Wired as `once("listening", ...)` so it fires exactly when the bind transitions to the
    // listening state - the same moment after which message events can arrive. The handler captures `socket` by closure to avoid `this.#socket`-style reads from
    // an async event handler.
    socket.once("listening", () => {

      this.#assignedReturnPort = socket.address().port;
    });

    // Inactivity watchdog: if no packets arrive within `timeoutMs`, abort the process with `"timeout"`. Self-cleans when `this.signal` aborts for any other reason,
    // so the teardown listener below only has to close the socket.
    const watchdog = new Watchdog({

      onFire: (): void => {

        this.log.debug("Streaming process inactivity watchdog fired after %d ms with no inbound packets.", timeoutMs);
        this.abort(new HbpuAbortError("timeout"));
      },
      signal: this.signal,
      timeoutMs
    });

    // Inbound-packet handler and the SOLE arm site for the watchdog. The first inbound packet performs the initial arm; every subsequent packet re-arms it. We do
    // not inspect the payload - liveness is the only signal this socket cares about.
    socket.on("message", () => { watchdog.arm(); });

    // Socket errors on the health port are treated as fatal - if the kernel cannot deliver us packets, we cannot tell the stream is alive. Abort with `"failed"` and
    // surface the underlying error via `cause` so downstream diagnostics carry the root cause.
    socket.on("error", (error: Error) => {

      this.log.error("Streaming process return-port socket error: %s.", error.message);

      if(!this.aborted) {

        this.abort(new HbpuAbortError("failed", { cause: error }));
      }
    });

    // Teardown convergence point: when `this.signal` aborts for any reason, close the socket. The watchdog's timer is handled by its own self-clean listener on the
    // same signal, so nothing else is owed here. `onAbort` is preferred over bare `addEventListener` even though the early `aborted` short-circuit above already
    // guards the pre-aborted case for this allocation path - resource-class teardown handlers throughout HBPU go through `onAbort` so no constructor site has to
    // re-implement the AbortSignal pre-aborted-listener workaround.
    onAbort(this.signal, () => socket.close());

    // Bind. Binding may fail asynchronously with an `"error"` event, which the listener above catches.
    socket.bind(returnPort.port, loopbackAddress(returnPort.ipFamily));

    // This is an inactivity watchdog, and "inactivity" presupposes prior activity: it watches one thing - a *flowing* return stream that dried up - so it arms only
    // on the first inbound packet (the message handler above), then re-arms on every subsequent one. There is deliberately NO arm at construction or on `ready`,
    // because the watchdog must not police startup or establishment. Those are separate concerns owned elsewhere: "did the child process start" is the base-class
    // optional `startupTimeout` (documented in process.ts), and "did the return stream ever go live" is the consumer's - the HomeKit session lifecycle and the
    // consumer's establishment gate - which is the only thing that bounds a stream that never delivers a first packet. We do not fold that bound in here, and on the
    // one-way live-view path that bound stays external to this class, owned by the consumer rather than this watchdog. Arming on `ready` was wrong precisely because a
    // ready-armed clock starts before any media has round-tripped: on a cold start the first return packet cannot arrive within the window (prime, transcode, SRTP
    // egress, client decode, client RTCP back all have to complete first), so the clock counts down through that legitimate first-packet latency and false-positives
    // on a perfectly healthy stream. Arming on the packet itself is immune by construction. Note the message handler arms regardless of `ready`: any datagram that
    // arrives before stderr does still starts the inactivity clock, so a stream that is already alive never waits on the spawn signal to be protected.
  }
}
