/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp.ts: Signal-driven RTP/RTCP demultiplexer with FFmpeg keepalive heartbeat, and UDP port reservation registry.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and borrows from both. Thank you for your contributions to the community.
 */

/**
 * Signal-driven RTP/RTCP demultiplexing, FFmpeg keepalive heartbeat, and UDP port reservation for FFmpeg-based HomeKit livestreaming.
 *
 * This module exposes three cooperating surfaces:
 *
 *   - {@link RtpDemuxer} - an {@link AsyncDisposable} that owns one bound UDP socket. Inbound datagrams are classified as RTP or RTCP per RFC 5761 and forwarded to the
 *     respective destination ports through the same socket so the outbound source endpoint equals the bound input port - a property downstream consumers can leverage
 *     for source-endpoint filtering against locally-spoofed traffic, and a property that simultaneously minimizes the demuxer's bound-port footprint to exactly one
 *     kernel-tracked socket. A self-rearming inactivity {@link Watchdog} re-emits the last received RTCP packet to the RTP destination port at the
 *     {@link RTCP_HEARTBEAT_INTERVAL} cadence whenever inbound RTCP traffic stalls, keeping inbound traffic arriving at FFmpeg's RTP input during legitimate quiet
 *     periods in two-way audio. A second optional inactivity {@link Watchdog} aborts the demuxer when no inbound traffic arrives within a caller-configurable window.
 *   - {@link RtpPortAllocator} - a plugin-singleton registry that issues {@link PortReservation} handles. The allocator itself holds no OS resources; each reservation
 *     is the scoped resource that owns one or two UDP ports.
 *   - {@link PortReservation} - an {@link AsyncDisposable} handle. Disposal releases the reserved ports back to the allocator's internal pool. Callers use
 *     `await using reservation = await allocator.reserve(...)` for scope-bound lifetimes, or store the handle and dispose it explicitly when ownership outlives a
 *     single scope.
 *
 * Reservations are handles, not raw port numbers, so "did I remember to release?" is not a footgun: disposing the handle releases the held ports, and dropping a
 * reference without disposing is a type-level mistake the `AsyncDisposable` contract and `await using` idiom make hard to commit.
 *
 * @see {@link https://tools.ietf.org/html/rfc5761 | RFC 5761}
 *
 * @module
 */
import { HbpuAbortError, Watchdog, composeSignals, isTimeoutReason, markHandled, onAbort } from "../util.ts";
import type { HomebridgePluginLogging, Nullable } from "../util.ts";
import { createDgramSocket, loopbackAddress } from "./dgram-util.ts";
import type { IpFamily } from "./dgram-util.ts";
import { RTCP_HEARTBEAT_INTERVAL } from "./settings.ts";
import { RtpPacketParser } from "./rtp-parser.ts";
import type { Socket } from "node:dgram";
import { once } from "node:events";

// Upper bound on retry cycles when a `reserve()` call has to fall back to a fresh random-port pair because a specific consecutive port collided. The number is
// intentionally generous - ten attempts covers realistic host contention without masking true exhaustion, and a hard ceiling keeps the loop from spinning indefinitely
// when every ephemeral port is somehow in use.
const RESERVE_MAX_ATTEMPTS = 10;

/**
 * Construction-time options for {@link RtpDemuxer}.
 *
 * @property inactivityTimeout - Optional inactivity watchdog window, in milliseconds. The timer arms during construction (immediately after the bind call is issued)
 *                               and re-arms on every received datagram. When the window lapses without traffic, the demuxer aborts with `HbpuAbortError("timeout")`.
 *                               Omit to disable the watchdog entirely.
 * @property inputPort         - Required. The UDP port to bind to. Typically a value previously reserved via {@link RtpPortAllocator.reserve}. Pass `0` to request
 *                               kernel-assigned ephemeral allocation: the bind succeeds atomically against whichever port the kernel hands out, eliminating the
 *                               reserve-then-rebind race that a separate reservation step would carry. The assigned port is then observable via
 *                               {@link RtpDemuxer.inputPort} once {@link RtpDemuxer.ready} resolves.
 * @property ipFamily          - Optional. `"ipv4"` or `"ipv6"`. Defaults to `"ipv4"`.
 * @property log               - Optional logger. Used for debug tracing of socket lifecycle and heartbeat events, and for error-path diagnostics. The signal's reason
 *                               on abort remains the authoritative notification channel; logging is a convenience for operators.
 * @property rtcpPort          - Required. The destination UDP port (on the loopback interface) for classified RTCP packets. Typically FFmpeg's RTCP input port.
 * @property rtpPort           - Required. The destination UDP port (on the loopback interface) for classified RTP packets. Typically FFmpeg's RTP input port. The
 *                               heartbeat replay also targets this port - FFmpeg ignores the RTCP shape on its RTP input, but the arriving traffic keeps that input
 *                               fed during quiet periods.
 * @property signal            - Optional parent {@link AbortSignal} to compose with the demuxer's internal controller. When the parent aborts, the demuxer tears down.
 *
 * @category FFmpeg
 */
export interface RtpDemuxerInit {

  inactivityTimeout?: number;
  inputPort: number;
  ipFamily?: IpFamily;
  log?: HomebridgePluginLogging;
  rtcpPort: number;
  rtpPort: number;
  signal?: AbortSignal;
}

/**
 * Signal-driven RTP/RTCP demultiplexer with FFmpeg keepalive heartbeat.
 *
 * The class owns one bound UDP socket. Inbound datagrams are classified by an internal {@link RtpPacketParser} and forwarded through the same socket to the configured
 * `rtpPort` (RTP-classified) or `rtcpPort` (RTCP-classified) on the loopback interface. Sharing the bound socket between receive and send gives the relay two
 * load-bearing properties:
 *
 *   1. **Source-endpoint symmetry.** Every forwarded datagram leaves the bound socket with source = `loopback:inputPort`. Because the demuxer holds an exclusive
 *      kernel bind on that port, no other non-root process can spoof that source endpoint - downstream receivers (typically FFmpeg) can therefore enforce source
 *      filtering against locally-injected traffic without coordinating ephemeral allocations with the demuxer.
 *   2. **Minimized bound-port footprint.** Exactly one kernel-tracked socket exists per demuxer instance; a dual-socket design would bind a second ephemeral port for
 *      the duration of the session, expanding the attack surface and the kernel-resource count for no architectural benefit.
 *
 * A self-rearming {@link Watchdog} replays the last observed RTCP packet to `rtpPort` whenever the gap between inbound RTCP arrivals exceeds the configured
 * {@link RTCP_HEARTBEAT_INTERVAL}. The heartbeat is part of the demuxer's invariant contract - FFmpeg-bound two-way audio is the only use case that constructs this
 * class, and that use case relies on the keepalive to keep inbound traffic arriving at FFmpeg's RTP input during legitimate quiet periods on the camera's audio
 * backchannel. No FFmpeg input-timeout flag (`-timeout` / `rw_timeout`) is configured anywhere - the keepalive is a defensive guard against any FFmpeg-side idle
 * handling of a quiet UDP/RTP input, not a timeout this code sets. The cadence is the single exported constant {@link RTCP_HEARTBEAT_INTERVAL}.
 *
 * An optional second {@link Watchdog} aborts the demuxer with `HbpuAbortError("timeout")` when no inbound traffic arrives within a caller-supplied window. Both
 * watchdogs compose against the same lifetime signal, so disposal cleans them up uniformly.
 *
 * @example
 *
 * ```ts
 * await using demuxer = new RtpDemuxer({
 *
 *   inactivityTimeout: 5_000,
 *   inputPort: audioIncomingPort,
 *   ipFamily: "ipv4",
 *   log,
 *   rtcpPort: audioIncomingRtcpPort,
 *   rtpPort: audioIncomingRtpPort,
 *   signal: session.signal
 * });
 *
 * try {
 *
 *   await demuxer.mediaReady;
 * } catch {
 *
 *   // Demuxer aborted before any inbound RTP arrived; abandon the return-audio setup.
 *   return;
 * }
 *
 * // Media is now flowing - safe to launch the consuming FFmpeg process.
 * ```
 *
 * @see RtpPacketParser
 * @see RTCP_HEARTBEAT_INTERVAL
 *
 * @category FFmpeg
 */
export class RtpDemuxer implements AsyncDisposable {

  /**
   * The composed abort signal representing this demuxer's lifetime. Aborts exactly once when the socket errors, the inactivity watchdog fires, the parent signal
   * propagates, or {@link RtpDemuxer.abort} is called; the reason encoded on `signal.reason` names the cause.
   */
  public readonly signal: AbortSignal;

  /**
   * Promise that resolves once the underlying UDP socket has finished binding and entered its `"listening"` state. Rejects with `this.signal.reason` when the bind
   * fails, the parent signal propagates, or any other abort path fires before the socket becomes ready.
   *
   * The unhandled-rejection tracker is suppressed via {@link markHandled} so consumers that never observe readiness (fire-and-forget demuxers) do not produce warnings;
   * consumers that do observe rejection receive the same structured abort reason they would from `signal.reason`.
   */
  public readonly ready: Promise<void>;

  /**
   * Promise that resolves once the demuxer has forwarded its first RTP-classified packet - the application-level readiness milestone meaning "media is now flowing
   * through the relay to the downstream consumer." Rejects with `this.signal.reason` if the demuxer aborts before any RTP packet arrives.
   *
   * Pairs with {@link RtpDemuxer.ready} as a two-tier readiness model: `ready` resolves when the inbound socket has bound (network-level readiness); `mediaReady`
   * resolves when classified RTP traffic has begun flowing (application-level readiness). The canonical gating pattern for two-way audio is "stand up the return-audio
   * path, wait for inbound media before launching the consuming FFmpeg process":
   *
   * ```ts
   * try {
   *   await demuxer.mediaReady;
   * } catch {
   *   // Demuxer aborted before any RTP arrived; abandon the return-audio setup.
   *   return;
   * }
   * // Safe to launch the consuming FFmpeg process now that media is flowing.
   * ```
   *
   * The unhandled-rejection tracker is suppressed via {@link markHandled} so consumers that never observe this promise produce no warnings.
   */
  public readonly mediaReady: Promise<void>;

  /**
   * The UDP port the demuxer is bound to. For a specific-port construction (`init.inputPort` non-zero), this equals `init.inputPort` from the moment the constructor
   * returns; for an ephemeral construction (`init.inputPort === 0`), the value is `0` until the kernel completes the bind, then the kernel-assigned port. Consumers
   * that need the assigned ephemeral port `await demuxer.ready` before reading this property.
   *
   * Reads from the cached projection of `socket.address().port` captured at the `"listening"` event so the value reflects what the kernel actually bound, not just what
   * was requested. The two coincide for specific-port binds; they diverge for ephemeral binds where the requested value is `0` and the bound value is the kernel's pick.
   */
  public get inputPort(): number {

    return this.#assignedInputPort ?? this.#requestedInputPort;
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * `true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` emitted by the inactivity watchdog and the platform
   * `TimeoutError` emitted by `AbortSignal.timeout()` - consumers discriminate on a single getter regardless of which code path produced the timeout. The discrimination
   * logic lives in {@link isTimeoutReason} so this getter stays a one-line delegation and every resource class in the library shares one definition of "timeout."
   */
  public get isTimedOut(): boolean {

    return isTimeoutReason(this.signal.reason);
  }

  // The port requested at construction (verbatim from `init.inputPort`). Equals the bound port for specific-port constructions; `0` for ephemeral constructions until
  // the kernel hands one out. Read through the {@link RtpDemuxer.inputPort} getter, which prefers {@link #assignedInputPort} once the bind settles.
  readonly #requestedInputPort: number;

  // The port the kernel actually bound to, captured from `socket.address().port` once the `"listening"` event fires. Undefined until then. For specific-port binds
  // this duplicates {@link #requestedInputPort} but the assignment keeps the post-bind read path uniform across both construction modes.
  #assignedInputPort: number | undefined;

  // The RTP destination port, supplied at construction. The destination of all RTP-classified forwards AND of the heartbeat replay (FFmpeg ignores the RTCP shape on
  // its RTP input but the arriving traffic keeps that input fed during silence, which is the point of the keepalive).
  readonly #rtpPort: number;

  // The RTCP destination port, supplied at construction. The destination of all RTCP-classified forwards.
  readonly #rtcpPort: number;

  // The loopback address for the configured IP family, resolved once at construction. Reused on every outbound send so we never re-translate the family during the hot
  // forwarding path.
  readonly #destAddress: string;

  // The private AbortController whose signal is composed into `this.signal`. Owning the controller internally keeps teardown reachable from every handler - the socket
  // error listener, the watchdog onFire callbacks, the message handler - without giving callers a handle to the raw controller.
  readonly #controller: AbortController;

  // The bound UDP socket. Receives inbound datagrams from HomeKit and sends forwarded datagrams (and heartbeats) to the loopback destination ports. Held privately so
  // the only interaction points are the demuxer's public surface and the internal listeners.
  readonly #socket: Socket;

  // The byte-to-record parser driving each datagram through classification. Stateless across datagrams (RTP wire format is datagram-framed) but instantiated once so
  // the class shape mirrors the MP4 pipeline.
  readonly #parser: RtpPacketParser;

  // Self-rearming heartbeat watchdog: when the inbound-RTCP gap exceeds RTCP_HEARTBEAT_INTERVAL, the watchdog's onFire replays the last observed RTCP datagram to
  // {@link #rtpPort} (keeping FFmpeg's RTP input fed during silence) and immediately re-arms itself so the cadence continues in the absence of fresh RTCP. Inbound
  // RTCP arrivals also call `arm()` to push the next fire forward - busy RTCP traffic suppresses the heartbeat naturally, quiet periods synthesize one.
  readonly #heartbeat: Watchdog;

  // Optional inactivity watchdog composed over this.signal, or `undefined` when no inactivityTimeout was configured. Re-armed on every inbound datagram; fires the
  // composed controller's abort on lapse. Self-cleans when the signal aborts for any reason, so no teardown wiring is needed.
  readonly #inactivityWatchdog: Watchdog | undefined;

  // Optional logger. Debug traces are emitted when present; absent logger is silent.
  readonly #log: HomebridgePluginLogging | undefined;

  // Promise that resolves when the socket emits `"close"` - i.e., the kernel has released the bound port. {@link RtpDemuxer.[Symbol.asyncDispose]} awaits this so the
  // `await using` contract truly means "the port is releasable again" by the time the surrounding scope exits, not merely "teardown has been scheduled."
  readonly #closed: Promise<void>;

  // The last RTCP datagram received, copied into our own buffer so the heartbeat replay sends stable bytes even after the underlying receive buffer is recycled by
  // Node's dgram subsystem. Undefined until the first RTCP arrives; the heartbeat onFire treats undefined as a no-op for the duration of the dormant period.
  #lastRtcp: Buffer | undefined;

  /**
   * Construct and bind a new RTP demuxer.
   *
   * Socket binding happens synchronously as part of construction: by the time the constructor returns, the socket has been asked to bind on the configured port and
   * the inactivity watchdog (if configured) is already armed. There is no separate `start()` step. The bind itself completes on a later turn; consumers that need to
   * sequence work against bind completion `await demuxer.ready`.
   *
   * @param init - Required init options. See {@link RtpDemuxerInit}.
   */
  public constructor(init: RtpDemuxerInit) {

    const { inactivityTimeout, inputPort, ipFamily = "ipv4", log, rtcpPort, rtpPort, signal: parentSignal } = init;

    this.#controller = new AbortController();
    this.signal = composeSignals(parentSignal, this.#controller.signal);

    this.#requestedInputPort = inputPort;
    this.#rtpPort = rtpPort;
    this.#rtcpPort = rtcpPort;
    this.#destAddress = loopbackAddress(ipFamily);
    this.#log = log;
    this.#parser = new RtpPacketParser();

    this.#socket = createDgramSocket(ipFamily);

    // Promise-based readiness milestones. `Promise.withResolvers` (ES2024) gives us the resolver handles directly, replacing the IIFE-with-try/catch pattern an
    // older `events.once`-based wiring would require. Resolvers settle once - subsequent resolve/reject calls are silent no-ops - so each milestone has exactly one
    // settling code path and rejection is centralized in the `onAbort` teardown handler below.
    const readyResolvers: PromiseWithResolvers<void> = Promise.withResolvers();
    const mediaReadyResolvers: PromiseWithResolvers<void> = Promise.withResolvers();
    const closedResolvers: PromiseWithResolvers<void> = Promise.withResolvers();

    this.ready = markHandled(readyResolvers.promise);
    this.mediaReady = markHandled(mediaReadyResolvers.promise);
    this.#closed = closedResolvers.promise;

    // Socket `"listening"` handler. Bind succeeded. Cache the kernel-assigned port (which differs from `inputPort` only on ephemeral binds), then signal readiness.
    this.#socket.once("listening", () => {

      this.#assignedInputPort = this.#socket.address().port;
      readyResolvers.resolve();
    });

    // Socket `"close"` handler. The kernel has released the bound port. Resolve the `#closed` promise so {@link [Symbol.asyncDispose]} can deterministically await
    // the port release, eliminating the rebind race a fire-and-forget close would carry.
    this.#socket.once("close", () => closedResolvers.resolve());

    // Socket `"error"` handler. Bind failures (typically EADDRINUSE) and runtime socket errors both flow through here. Gating on `!this.aborted` keeps the abort
    // idempotent when the socket error fires during a concurrent teardown (e.g., an ECONNRESET during an in-flight close). The error is preserved on `.cause` so
    // downstream diagnostics see the original kernel error.
    this.#socket.on("error", (error: Error) => {

      if(this.aborted) {

        return;
      }

      this.#log?.error("RtpDemuxer socket error on port %d: %s.", this.inputPort, error.message);
      this.#controller.abort(new HbpuAbortError("failed", { cause: error }));
    });

    // Heartbeat watchdog. The onFire replays the last observed RTCP datagram to `rtpPort` and immediately re-arms the watchdog so the cadence continues. Inbound
    // RTCP messages call `arm()` in the message handler, pushing the next fire forward - busy RTCP suppresses the heartbeat naturally, quiet periods synthesize one.
    // The pre-fire `!this.aborted` guard is belt-and-suspenders: the Watchdog primitive itself already skips onFire after the observed signal aborts, but a defensive
    // check here keeps the forwarding-path semantics legible at a glance. The watchdog stays dormant until the first inbound RTCP arrives - we deliberately do NOT
    // arm it from the constructor because heartbeats are RTCP-replays and there is nothing meaningful to replay before the first RTCP.
    this.#heartbeat = new Watchdog({

      onFire: (): void => {

        if((this.#lastRtcp !== undefined) && !this.aborted) {

          this.#log?.debug("RtpDemuxer sending FFmpeg a keepalive heartbeat.");
          this.#socket.send(this.#lastRtcp, this.#rtpPort, this.#destAddress);
        }

        this.#heartbeat.arm();
      },
      signal: this.signal,
      timeoutMs: RTCP_HEARTBEAT_INTERVAL
    });

    // Optional inactivity watchdog. Constructed only when the caller opted into liveness enforcement so absence carries no scheduled timer and no per-packet overhead.
    // The watchdog composes against `this.signal` so a parent abort (or any other internal abort) self-cleans the pending timer without explicit teardown.
    this.#inactivityWatchdog = (inactivityTimeout !== undefined) ? new Watchdog({

      onFire: (): void => {

        this.#log?.debug("RtpDemuxer inactivity watchdog fired after %d ms with no inbound packets on port %d.", inactivityTimeout, this.inputPort);
        this.#controller.abort(new HbpuAbortError("timeout"));
      },
      signal: this.signal,
      timeoutMs: inactivityTimeout
    }) : undefined;

    // Inbound message handler. Every datagram re-arms the inactivity watchdog. Each classified packet forwards out the same socket - source endpoint of the forward
    // equals `loopback:inputPort`, preserving the source-port symmetry property documented at the class level. RTP-classified packets resolve `mediaReady` on the
    // first arrival; RTCP-classified packets are captured for heartbeat replay and arm the heartbeat watchdog.
    this.#socket.on("message", (datagram: Buffer) => {

      this.#inactivityWatchdog?.arm();

      for(const packet of this.#parser.consume(datagram)) {

        if(packet.kind === "rtp") {

          this.#socket.send(packet.bytes, this.#rtpPort, this.#destAddress);

          // Resolve the first-RTP milestone. `Promise.withResolvers` settles once, so subsequent calls on every later RTP packet are silent no-ops - no flag required.
          mediaReadyResolvers.resolve();

          continue;
        }

        // Copy the RTCP datagram into our own buffer because the heartbeat replays it later, well after Node's dgram subsystem may have recycled the receive buffer
        // backing `datagram`. A reference assignment would leak corrupted bytes to the heartbeat replay; `Buffer.from(...)` is the canonical safe copy.
        this.#lastRtcp = Buffer.from(packet.bytes);
        this.#socket.send(packet.bytes, this.#rtcpPort, this.#destAddress);
        this.#heartbeat.arm();
      }
    });

    // Single teardown convergence point. `onAbort` registers the one-shot close listener for the normal abort path AND handles the "pre-aborted signal" edge case
    // where `addEventListener("abort", ...)` would otherwise silently skip the handler (the AbortSignal spec does not re-dispatch historical events). Rejecting the
    // milestone promises is idempotent - a milestone that already resolved is unaffected by the subsequent reject; a milestone still pending receives the signal's
    // reason as its rejection. The socket close fires the `"close"` event which resolves `#closed`, ungating `[Symbol.asyncDispose]`.
    onAbort(this.signal, () => {

      readyResolvers.reject(this.signal.reason);
      mediaReadyResolvers.reject(this.signal.reason);
      this.#socket.close();
    });

    if(this.signal.aborted) {

      return;
    }

    // The pre-bind debug log differentiates specific-port and ephemeral construction. For `inputPort === 0` the kernel has not picked yet, so logging "port 0" would
    // mislead an operator reading the trace; we name the intent ("kernel-assigned ephemeral port") and rely on subsequent error / timeout logs (which read
    // `this.inputPort` after the listening event captures the assigned value) to show the actual bound port.
    if(inputPort === 0) {

      this.#log?.debug("Binding RtpDemuxer on %s with a kernel-assigned ephemeral port forwarding to RTP %d / RTCP %d.", ipFamily, rtpPort, rtcpPort);
    } else {

      this.#log?.debug("Binding RtpDemuxer on %s port %d forwarding to RTP %d / RTCP %d.", ipFamily, inputPort, rtpPort, rtcpPort);
    }

    // Bind without an explicit address so the socket accepts inbound traffic from any interface (HomeKit's RTP traffic arrives via the LAN, not loopback). Outbound
    // forwards use the explicit loopback address so the kernel routes those datagrams locally - the source IP is then the loopback address and the source port is
    // the bound `inputPort`, completing the source-endpoint-symmetry property. A bind failure surfaces through the `"error"` listener above.
    this.#socket.bind(inputPort);

    // Arm the inactivity watchdog. The first packet's arrival re-arms it; if no packet ever arrives, the watchdog fires after `inactivityTimeout` ms from this point.
    // The heartbeat watchdog deliberately stays dormant - no inbound RTCP has been seen yet, so there is nothing to replay.
    this.#inactivityWatchdog?.arm();
  }

  /**
   * Abort the demuxer and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after a natural error or watchdog
   * timeout is also safe for the same reason.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}; platform errors (`TimeoutError`, `AbortError`) also interoperate by convention.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation. Aborts the demuxer (defaulting to `"shutdown"`) and awaits the socket's `"close"` event so the bound port is releasable by the
   * time the surrounding `await using` scope's next statement runs. Safe to invoke repeatedly: subsequent disposals collapse onto the same `#closed` promise.
   *
   * @returns A promise that resolves once the kernel has released the bound port.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();

    await this.#closed;
  }
}

/**
 * Construction-time options for {@link RtpPortAllocator.reserve}.
 *
 * @property count    - Optional. The number of consecutive UDP ports to reserve. `1` yields a single port, `2` yields the reserved port plus the next port so FFmpeg's
 *                      "RTP port N implies RTCP port N+1" convention is satisfied. Defaults to `1`.
 * @property ipFamily - Optional. `"ipv4"` or `"ipv6"`. Defaults to `"ipv4"`.
 * @property signal   - Optional caller {@link AbortSignal}. Cancels in-flight bind-retry attempts. If the signal aborts while `reserve()` is still looking for
 *                      consecutive ports, the partially reserved port (if any) is released and the promise rejects with `signal.reason`.
 *
 * @category FFmpeg
 */
export interface PortReservationInit {

  count?: 1 | 2;
  ipFamily?: IpFamily;
  signal?: AbortSignal;
}

/**
 * AsyncDisposable handle representing one or two reserved UDP ports.
 *
 * Ports are held exclusively against the {@link RtpPortAllocator}'s internal pool until `[Symbol.asyncDispose]` is invoked. Callers typically
 * manage the lifetime with `await using` for scope-bound reservations, or by storing the handle on a session entry and disposing explicitly when the session ends.
 *
 * Disposal is idempotent: the first call releases the ports back to the allocator; subsequent calls are no-ops. This guarantees `await using` combined with an
 * explicit dispose (for example, on an error path that releases early and then falls through the `using` block) does not double-release.
 *
 * @property count    - `1` or `2`. A two-port reservation guarantees `port` and `port + 1` are both reserved.
 * @property ipFamily - `"ipv4"` or `"ipv6"`.
 * @property port     - The first (and, for single-port reservations, only) reserved UDP port.
 *
 * @category FFmpeg
 */
export interface PortReservation extends AsyncDisposable {

  readonly count: 1 | 2;
  readonly ipFamily: IpFamily;
  readonly port: number;

  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Registry that reserves consecutive UDP ports for FFmpeg-based RTP/RTCP sessions.
 *
 * The allocator itself is a plugin-singleton registry - it holds no OS resources of its own, only a `Set` of ports marked as in-use. Reservations are the scoped
 * resource: each successful {@link RtpPortAllocator.reserve} call returns a {@link PortReservation} handle whose disposal releases the held ports back to the pool.
 *
 * The reservation bind-retry loop is signal-aware: passing `init.signal` to `reserve()` means an aborting parent signal cancels the pending reservation cleanly, even
 * when the loop is in the middle of probing candidate ports.
 *
 * @example
 *
 * ```ts
 * // Scope-bound: the reservation releases automatically when the block exits.
 * await using reservation = await allocator.reserve({ count: 2, signal: session.controller.signal });
 * const rtpPort  = reservation.port;
 * const rtcpPort = reservation.port + 1;
 * // ...use rtpPort and rtcpPort for the duration of the session.
 * ```
 *
 * @example
 *
 * ```ts
 * // Non-scoped: store the handle on a session entry and dispose explicitly later.
 * const reservation = await allocator.reserve({ count: 2, signal: session.controller.signal });
 * session.ports = reservation;
 * // ...later:
 * await session.ports[Symbol.asyncDispose]();
 * ```
 *
 * @category FFmpeg
 */
export class RtpPortAllocator {

  // The pool of ports currently marked as in use. A `Set` because membership checks in the bind-retry loop need O(1), and the allocator never needs ordering.
  readonly #inUse = new Set<number>();

  /**
   * The number of UDP ports currently held by live {@link PortReservation} handles. Exposed for operational diagnostics - a plugin that surfaces "how many
   * reservations are in flight right now" through a status endpoint can read this directly, and it is a useful signal for detecting leaks (a monotonically growing
   * count across normal session cycles indicates a reservation is not being disposed).
   *
   * @returns The number of reserved ports currently tracked by the allocator.
   */
  public get reservedCount(): number {

    return this.#inUse.size;
  }

  /**
   * Reserve one or two consecutive UDP ports.
   *
   * For a two-port reservation, the allocator first picks a random free port, then probes the next sequential port. If the sequential port is unavailable (already in
   * the in-use set or rejected by the OS), the first port is released and the allocator retries from scratch, up to `RESERVE_MAX_ATTEMPTS` attempts.
   *
   * @param init - Optional init options. See {@link PortReservationInit}.
   *
   * @returns A {@link PortReservation} handle whose disposal releases the reserved ports.
   *
   * @throws The caller signal's abort reason, if the signal aborts before a reservation is obtained.
   * @throws `RangeError` when `count` is anything other than `1` or `2`.
   * @throws `Error` when no reservation could be obtained within the attempt budget.
   */
  public async reserve(init: PortReservationInit = {}): Promise<PortReservation> {

    const { count = 1, ipFamily = "ipv4", signal } = init;

    // Sanity-check the count. The type system narrows `count` to `1 | 2` at the call site, but a JS consumer can bypass the types and pass anything; widening to
    // `number` here lets the runtime guard catch the out-of-range case with a clear message rather than an infinite reservation loop.
    const requestedCount: number = count;

    if((requestedCount !== 1) && (requestedCount !== 2)) {

      throw new RangeError("RtpPortAllocator.reserve: count must be 1 or 2.");
    }

    signal?.throwIfAborted();

    for(let attempt = 0; attempt < RESERVE_MAX_ATTEMPTS; attempt++) {

      signal?.throwIfAborted();

      // Two-phase commit via ES 2023 Explicit Resource Management. `#acquirePort` atomically adds to `#inUse` and registers the matching release on the stack, so a
      // successful acquire always leaves the port paired with its cleanup. If we return a reservation, `stack.move()` transfers ownership away from scope-bound
      // disposal and the ports stay in `#inUse`. Every other exit path - null-retry `continue`, thrown caller abort, any future exception - hits `using`'s automatic
      // disposal and releases the tentative ports. This is the platform-standard pattern for "acquire, maybe commit, release on failure."
      using stack = new DisposableStack();

      // eslint-disable-next-line no-await-in-loop
      const firstPort = await this.#acquirePort(stack, ipFamily, 0, signal);

      if(firstPort === null) {

        continue;
      }

      if(count === 1) {

        const reservation = this.#makeReservation(firstPort, 1, ipFamily);

        stack.move();

        return reservation;
      }

      // eslint-disable-next-line no-await-in-loop
      const secondPort = await this.#acquirePort(stack, ipFamily, firstPort + 1, signal);

      if(secondPort === null) {

        continue;
      }

      const reservation = this.#makeReservation(firstPort, 2, ipFamily);

      stack.move();

      return reservation;
    }

    const portDescription = (count === 1) ? "a port" : count.toString() + " consecutive ports";

    throw new Error("RtpPortAllocator: unable to reserve " + portDescription + " after " + RESERVE_MAX_ATTEMPTS.toString() + " attempts.");
  }

  // Acquire a single UDP port by binding a throwaway socket, reading back the assigned port, marking it in-use, and registering the matching release on the caller's
  // `DisposableStack`. `requestedPort === 0` asks the OS for a random ephemeral port; non-zero asks for that specific port and expects it to be available. Returns the
  // assigned port on success, or `null` on any non-abort failure so the caller can retry. Aborts propagate as thrown rejections (the caller's signal is honored by
  // `events.once`). Registering the release on the caller-supplied stack keeps the add-with-cleanup contract atomic - no call site can acquire a port without also
  // pairing it with a disposer, so the "forgot to clean up on failure" bug class is impossible by construction.
  async #acquirePort(stack: DisposableStack, ipFamily: IpFamily, requestedPort: number, signal: AbortSignal | undefined): Promise<Nullable<number>> {

    for(;;) {

      signal?.throwIfAborted();

      const socket = createDgramSocket(ipFamily);

      // Exclude this probe socket from Node's reference counting so it never prevents the process from exiting while a reservation is pending.
      socket.unref();

      try {

        // `events.once` listens for the `"listening"` event, rejecting on both abort and the socket's own `"error"` event. Wrapping the call once lets us treat bind
        // failures (EADDRINUSE on a specific port) and abort propagation through a single catch. `{ signal }` accepts `undefined` verbatim - events.once's internal
        // `if (options?.signal)` gate skips the abort wiring when signal is absent - so one unconditional call shape covers both with-signal and without-signal cases.
        const listening = once(socket, "listening", { signal });

        socket.bind(requestedPort);

        // eslint-disable-next-line no-await-in-loop
        await listening;
      } catch {

        socket.close();

        // Abort takes precedence: rethrow so the caller's `throwIfAborted` observes the same reason at the outer layer. Any other error is a bind failure; we surface
        // `null` so the outer retry loop can fall through to the next attempt. The raw rejection from `events.once` is intentionally not propagated - bind failures
        // converge on the `null` return so the outer retry loop can fall through to the next port without coupling to kernel-error specifics.
        if(signal?.aborted) {

          throw signal.reason;
        }

        return null;
      }

      const assignedPort = socket.address().port;

      socket.close();

      if(this.#inUse.has(assignedPort)) {

        // Specific-port requests either land or fail; they must not retry internally because the caller is looking for that exact port. Random-port requests loop
        // inside this function until a fresh, un-reserved port is found.
        if(requestedPort !== 0) {

          return null;
        }

        continue;
      }

      this.#inUse.add(assignedPort);
      stack.defer(() => this.#inUse.delete(assignedPort));

      return assignedPort;
    }
  }

  // Construct the PortReservation handle. The returned object captures a closure over the ports to release and a local `disposed` flag so double-dispose is a no-op.
  // We use an arrow function for the disposer so `this` resolves to the allocator, giving the closure lexical access to `this.#inUse` without threading a reference.
  #makeReservation(firstPort: number, count: 1 | 2, ipFamily: IpFamily): PortReservation {

    const portsHeld = (count === 2) ? [ firstPort, firstPort + 1 ] : [firstPort];
    let disposed = false;

    const dispose = async (): Promise<void> => {

      if(disposed) {

        return;
      }

      disposed = true;

      for(const port of portsHeld) {

        this.#inUse.delete(port);
      }
    };

    return {

      count,
      ipFamily,
      port: firstPort,
      [Symbol.asyncDispose]: dispose
    };
  }
}
