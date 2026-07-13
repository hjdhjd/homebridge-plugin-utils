[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/rtp

# ffmpeg/rtp

Signal-driven RTP/RTCP demultiplexing, FFmpeg keepalive heartbeat, and UDP port reservation for FFmpeg-based HomeKit livestreaming.

This module exposes the following cooperating surfaces:

  - [RtpDemuxer](#rtpdemuxer) - an [AsyncDisposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose) that owns one bound UDP socket. Inbound datagrams are classified as RTP or RTCP per RFC 5761 and forwarded to the
    respective destination ports through the same socket so the outbound source endpoint equals the bound input port - a property downstream consumers can leverage
    for source-endpoint filtering against locally-spoofed traffic, and a property that simultaneously minimizes the demuxer's bound-port footprint to exactly one
    kernel-tracked socket. A self-rearming inactivity [Watchdog](../util.md#watchdog) re-emits the last received RTCP packet to the RTP destination port at the
    [RTCP\_HEARTBEAT\_INTERVAL](settings.md#rtcp_heartbeat_interval) cadence whenever inbound RTCP traffic stalls, keeping inbound traffic arriving at FFmpeg's RTP input during legitimate quiet
    periods in two-way audio. A second optional inactivity [Watchdog](../util.md#watchdog) aborts the demuxer when no inbound traffic arrives within a caller-configurable window.
  - [RtpPortAllocator](#rtpportallocator) - a plugin-singleton registry that issues [PortReservation](#portreservation) handles. The allocator itself holds no OS resources; each reservation
    is the scoped resource that owns one or two UDP ports.
  - [PortReservation](#portreservation) - an [AsyncDisposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose) handle. Disposal releases the reserved ports back to the allocator's internal pool. Callers use
    `await using reservation = await allocator.reserve(...)` for scope-bound lifetimes, or store the handle and dispose it explicitly when ownership outlives a
    single scope.

Reservations are handles, not raw port numbers, so "did I remember to release?" is not a footgun: disposing the handle releases the held ports, and dropping a
reference without disposing is a type-level mistake the `AsyncDisposable` contract and `await using` idiom make hard to commit.

## See

[RFC 5761](https://tools.ietf.org/html/rfc5761)

## FFmpeg

### RtpDemuxer

Signal-driven RTP/RTCP demultiplexer with FFmpeg keepalive heartbeat.

The class owns one bound UDP socket. Inbound datagrams are classified by an internal [RtpPacketParser](rtp-parser.md#rtppacketparser) and forwarded through the same socket to the configured
`rtpPort` (RTP-classified) or `rtcpPort` (RTCP-classified) on the loopback interface. Sharing the bound socket between receive and send gives the relay two
essential properties:

  1. **Source-endpoint symmetry.** Every forwarded datagram leaves the bound socket with source = `loopback:inputPort`. Because the demuxer holds an exclusive
     kernel bind on that port, no other non-root process can spoof that source endpoint - downstream receivers (typically FFmpeg) can therefore enforce source
     filtering against locally-injected traffic without coordinating ephemeral allocations with the demuxer.
  2. **Minimized bound-port footprint.** Exactly one kernel-tracked socket exists per demuxer instance; a dual-socket design would bind a second ephemeral port for
     the duration of the session, expanding the attack surface and the kernel-resource count for no architectural benefit.

A self-rearming [Watchdog](../util.md#watchdog) replays the last observed RTCP packet to `rtpPort` whenever the gap between inbound RTCP arrivals exceeds the configured
[RTCP\_HEARTBEAT\_INTERVAL](settings.md#rtcp_heartbeat_interval). The heartbeat is part of the demuxer's contract - FFmpeg-bound two-way audio is the only use case that constructs this
class, and that use case relies on the keepalive to keep inbound traffic arriving at FFmpeg's RTP input during legitimate quiet periods on the camera's audio
backchannel. No FFmpeg input-timeout flag (`-timeout` / `rw_timeout`) is configured anywhere - the keepalive is a defensive guard against any FFmpeg-side idle
handling of a quiet UDP/RTP input, not a timeout this code sets. The cadence is the single exported constant [RTCP\_HEARTBEAT\_INTERVAL](settings.md#rtcp_heartbeat_interval).

An optional second [Watchdog](../util.md#watchdog) aborts the demuxer with `HbpuAbortError("timeout")` when no inbound traffic arrives within a caller-supplied window. Both
watchdogs compose against the same lifetime signal, so disposal cleans them up uniformly.

#### Example

```ts
await using demuxer = new RtpDemuxer({

  inactivityTimeout: 5_000,
  inputPort: audioIncomingPort,
  ipFamily: "ipv4",
  log,
  rtcpPort: audioIncomingRtcpPort,
  rtpPort: audioIncomingRtpPort,
  signal: session.signal
});

try {

  await demuxer.mediaReady;
} catch {

  // Demuxer aborted before any inbound RTP arrived; abandon the return-audio setup.
  return;
}

// Media is now flowing - safe to launch the consuming FFmpeg process.
```

#### See

 - RtpPacketParser
 - RTCP_HEARTBEAT_INTERVAL

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new RtpDemuxer(init): RtpDemuxer;
```

Construct and bind a new RTP demuxer.

Socket binding happens synchronously as part of construction: by the time the constructor returns, the socket has been asked to bind on the configured port and
the inactivity watchdog (if configured) is already armed. There is no separate `start()` step. The bind itself completes on a later turn; consumers that need to
sequence work against bind completion `await demuxer.ready`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`RtpDemuxerInit`](#rtpdemuxerinit) | Required init options. See [RtpDemuxerInit](#rtpdemuxerinit). |

###### Returns

[`RtpDemuxer`](#rtpdemuxer)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="mediaready"></a> `mediaReady` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Promise that resolves once the demuxer has forwarded its first RTP-classified packet - the application-level readiness milestone meaning "media is now flowing through the relay to the downstream consumer." Rejects with `this.signal.reason` if the demuxer aborts before any RTP packet arrives. Pairs with [RtpDemuxer.ready](#ready) as a two-tier readiness model: `ready` resolves when the inbound socket has bound (network-level readiness); `mediaReady` resolves when classified RTP traffic has begun flowing (application-level readiness). The canonical gating pattern for two-way audio is "stand up the return-audio path, wait for inbound media before launching the consuming FFmpeg process": `try { await demuxer.mediaReady; } catch { // Demuxer aborted before any RTP arrived; abandon the return-audio setup. return; } // Safe to launch the consuming FFmpeg process now that media is flowing.` The unhandled-rejection tracker is suppressed via [markHandled](../util.md#markhandled) so consumers that never observe this promise produce no warnings. |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Promise that resolves once the underlying UDP socket has finished binding and entered its `"listening"` state. Rejects with `this.signal.reason` when the bind fails, the parent signal propagates, or any other abort path fires before the socket becomes ready. The unhandled-rejection tracker is suppressed via [markHandled](../util.md#markhandled) so consumers that never observe readiness (fire-and-forget demuxers) do not produce warnings; consumers that do observe rejection receive the same structured abort reason they would from `signal.reason`. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this demuxer's lifetime. Aborts exactly once when the socket errors, the inactivity watchdog fires, the parent signal propagates, or [RtpDemuxer.abort](#abort) is called; the reason encoded on `signal.reason` names the cause. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

##### inputPort

###### Get Signature

```ts
get inputPort(): number;
```

The UDP port the demuxer is bound to. For a specific-port construction (`init.inputPort` non-zero), this equals `init.inputPort` from the moment the constructor
returns; for an ephemeral construction (`init.inputPort === 0`), the value is `0` until the kernel completes the bind, then the kernel-assigned port. Consumers
that need the assigned ephemeral port `await demuxer.ready` before reading this property.

Reads from the cached projection of `socket.address().port` captured at the `"listening"` event so the value reflects what the kernel actually bound, not just what
was requested. The two coincide for specific-port binds; they diverge for ephemeral binds where the requested value is `0` and the bound value is the kernel's pick.

###### Returns

`number`

##### isTimedOut

###### Get Signature

```ts
get isTimedOut(): boolean;
```

`true` when the abort reason indicates a timeout. Matches both the canonical `HbpuAbortError("timeout")` emitted by the inactivity watchdog and the platform
`TimeoutError` emitted by `AbortSignal.timeout()` - consumers branch on a single getter regardless of which code path produced the timeout. The branching
logic lives in [isTimeoutReason](../util.md#istimeoutreason) so this getter stays a one-line delegation and every resource class in the library shares one definition of "timeout."

###### Returns

`boolean`

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the demuxer (defaulting to `"shutdown"`) and awaits the socket's `"close"` event so the bound port is releasable by the
time the surrounding `await using` scope's next statement runs. Safe to invoke repeatedly: subsequent disposals collapse onto the same `#closed` promise.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the kernel has released the bound port.

###### Implementation of

```ts
AsyncDisposable.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the demuxer and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once. Calling `abort()` after a natural error or watchdog
timeout is also safe for the same reason.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror); platform errors (`TimeoutError`, `AbortError`) also interoperate by convention. |

###### Returns

`void`

***

### RtpPortAllocator

Registry that reserves consecutive UDP ports for FFmpeg-based RTP/RTCP sessions.

The allocator itself is a plugin-singleton registry - it holds no OS resources of its own, only a `Set` of ports marked as in-use. Reservations are the scoped
resource: each successful [RtpPortAllocator.reserve](#reserve) call returns a [PortReservation](#portreservation) handle whose disposal releases the held ports back to the pool.

The reservation bind-retry loop is signal-aware: passing `init.signal` to `reserve()` means an aborting parent signal cancels the pending reservation cleanly, even
when the loop is in the middle of probing candidate ports.

#### Examples

```ts
// Scope-bound: the reservation releases automatically when the block exits.
await using reservation = await allocator.reserve({ count: 2, signal: session.controller.signal });
const rtpPort  = reservation.port;
const rtcpPort = reservation.port + 1;
// ...use rtpPort and rtcpPort for the duration of the session.
```

```ts
// Non-scoped: store the handle on a session entry and dispose explicitly later.
const reservation = await allocator.reserve({ count: 2, signal: session.controller.signal });
session.ports = reservation;
// ...later:
await session.ports[Symbol.asyncDispose]();
```

#### Constructors

##### Constructor

```ts
new RtpPortAllocator(): RtpPortAllocator;
```

###### Returns

[`RtpPortAllocator`](#rtpportallocator)

#### Accessors

##### reservedCount

###### Get Signature

```ts
get reservedCount(): number;
```

The number of UDP ports currently held by live [PortReservation](#portreservation) handles. Exposed for operational diagnostics - a plugin that surfaces "how many
reservations are in flight right now" through a status endpoint can read this directly, and it is a useful signal for detecting leaks (a monotonically growing
count across normal session cycles indicates a reservation is not being disposed).

###### Returns

`number`

The number of reserved ports currently tracked by the allocator.

#### Methods

##### reserve()

```ts
reserve(init?): Promise<PortReservation>;
```

Reserve one or two consecutive UDP ports.

For a two-port reservation, the allocator first picks a random free port, then probes the next sequential port. If the sequential port is unavailable (already in
the in-use set or rejected by the OS), the first port is released and the allocator retries from scratch, up to `RESERVE_MAX_ATTEMPTS` attempts.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`PortReservationInit`](#portreservationinit) | Optional init options. See [PortReservationInit](#portreservationinit). |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`PortReservation`](#portreservation)\>

A [PortReservation](#portreservation) handle whose disposal releases the reserved ports.

###### Throws

The caller signal's abort reason, if the signal aborts before a reservation is obtained.

###### Throws

`RangeError` when `count` is anything other than `1` or `2`.

###### Throws

`Error` when no reservation could be obtained within the attempt budget.

***

### PortReservation

AsyncDisposable handle representing one or two reserved UDP ports.

Ports are held exclusively against the [RtpPortAllocator](#rtpportallocator)'s internal pool until `[Symbol.asyncDispose]` is invoked. Callers typically
manage the lifetime with `await using` for scope-bound reservations, or by storing the handle on a session entry and disposing explicitly when the session ends.

Disposal is safe to repeat: the first call releases the ports back to the allocator; subsequent calls are no-ops. This guarantees `await using` combined with an
explicit dispose (for example, on an error path that releases early and then falls through the `using` block) does not double-release.

#### Extends

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="count"></a> `count` | `readonly` | `1` \| `2` | `1` or `2`. A two-port reservation guarantees `port` and `port + 1` are both reserved. |
| <a id="ipfamily"></a> `ipFamily` | `readonly` | [`IpFamily`](dgram-util.md#ipfamily) | `"ipv4"` or `"ipv6"`. |
| <a id="port"></a> `port` | `readonly` | `number` | The first (and, for single-port reservations, only) reserved UDP port. |

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

###### Overrides

```ts
AsyncDisposable.[asyncDispose]
```

***

### PortReservationInit

Construction-time options for [RtpPortAllocator.reserve](#reserve).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="count-1"></a> `count?` | `1` \| `2` | Optional. The number of consecutive UDP ports to reserve. `1` yields a single port, `2` yields the reserved port plus the next port so FFmpeg's "RTP port N implies RTCP port N+1" convention is satisfied. Defaults to `1`. |
| <a id="ipfamily-1"></a> `ipFamily?` | [`IpFamily`](dgram-util.md#ipfamily) | Optional. `"ipv4"` or `"ipv6"`. Defaults to `"ipv4"`. |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional caller [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). Cancels in-flight bind-retry attempts. If the signal aborts while `reserve()` is still looking for consecutive ports, the partially reserved port (if any) is released and the promise rejects with `signal.reason`. |

***

### RtpDemuxerInit

Construction-time options for [RtpDemuxer](#rtpdemuxer).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="inactivitytimeout"></a> `inactivityTimeout?` | `number` | Optional inactivity watchdog window, in milliseconds. The timer arms during construction (immediately after the bind call is issued) and re-arms on every received datagram. When the window lapses without traffic, the demuxer aborts with `HbpuAbortError("timeout")`. Omit to disable the watchdog entirely. |
| <a id="inputport-1"></a> `inputPort` | `number` | Required. The UDP port to bind to. Typically a value previously reserved via [RtpPortAllocator.reserve](#reserve). Pass `0` to request kernel-assigned ephemeral allocation: the bind succeeds atomically against whichever port the kernel hands out, eliminating the reserve-then-rebind race that a separate reservation step would carry. The assigned port is then observable via [RtpDemuxer.inputPort](#inputport) once [RtpDemuxer.ready](#ready) resolves. |
| <a id="ipfamily-2"></a> `ipFamily?` | [`IpFamily`](dgram-util.md#ipfamily) | Optional. `"ipv4"` or `"ipv6"`. Defaults to `"ipv4"`. |
| <a id="log"></a> `log?` | [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) | Optional logger. Used for debug tracing of socket lifecycle and heartbeat events, and for error-path diagnostics. The signal's reason on abort remains the authoritative notification channel; logging is a convenience for operators. |
| <a id="rtcpport"></a> `rtcpPort` | `number` | Required. The destination UDP port (on the loopback interface) for classified RTCP packets. Typically FFmpeg's RTCP input port. |
| <a id="rtpport"></a> `rtpPort` | `number` | Required. The destination UDP port (on the loopback interface) for classified RTP packets. Typically FFmpeg's RTP input port. The heartbeat replay also targets this port - FFmpeg ignores the RTCP shape on its RTP input, but the arriving traffic keeps that input fed during quiet periods. |
| <a id="signal-2"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) to compose with the demuxer's internal controller. When the parent aborts, the demuxer tears down. |
