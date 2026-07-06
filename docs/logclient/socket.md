[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/socket

# logclient/socket

AsyncDisposable live-log socket for the Homebridge UI log stream.

[LogSocket](#logsocket) owns a single WebSocket connection to the homebridge-config-ui-x Socket.IO log namespace and surfaces the raw `stdout` text the server streams as a
bounded push-to-pull `AsyncIterable<string>`. It composes the library's own primitives rather than reinventing them: [composeSignals](../util.md#composesignals) / [onAbort](../util.md#onabort) for
lifetime, [Watchdog](../util.md#watchdog) for ping liveness, [retry](../util.md#retry) (driving the connect phase with the log client's own dev-tuned backoff curve), and [HbpuAbortError](../util.md#hbpuaborterror)
for the abort taxonomy. The wire framing is delegated entirely to the pure [decodeFrame](frame.md#decodeframe) / [encodeFrame](frame.md#encodeframe) codec.

Lifecycle, in one pass:

- A background reconnect loop runs for the socket's lifetime: `while(!signal.aborted)`, each iteration `retry()`s the CONNECT PHASE ONLY (re-acquire the token, open
  the WebSocket, await the Engine.IO open handshake, join the `/log` namespace, emit `tail-log`). Wrapping only the connect phase in `retry` means the exponential
  backoff curve RESETS after every healthy session - a socket that stays connected for hours and then drops reconnects briskly rather than at the climbed-up delay a
  single long-lived `retry` would have reached.
- The connect-phase backoff is the log client's own jittered exponential curve: a 500 ms base (`RECONNECT_BASE_MS`) doubling each attempt and plateauing at a 5-second
  ceiling (`RECONNECT_CAP_MS`), deliberately snappier than `defaultRetryBackoff`'s 30-second ceiling so the tail resumes promptly after a Homebridge restart. `random`
  is injectable (default `Math.random`) so the jitter is deterministic in tests.
- `shouldRetry` vetoes a retry the instant a permanent authentication failure surfaces (wrong password, missing OTP, noauth disabled), so a credential problem fails
  the socket fast with an actionable error rather than looping forever.
- Once connected, each server ping (`"2"`) is answered with a pong (`"3"`) and re-arms the liveness [Watchdog](../util.md#watchdog); if no ping arrives within
  `pingInterval + pingTimeout + MARGIN_MS`, the watchdog aborts the session and the loop reconnects.
- A Socket.IO CONNECT_ERROR (`44/log,`) on the namespace is surfaced as a connect-phase failure - transient and retried for a refreshable credential (password/noauth),
  permanent and made terminal by the `shouldRetry` veto for a static token that cannot be refreshed.

Teardown is idempotent and state-gated: it sends a namespace DISCONNECT (`41/log,`) only when the socket is still OPEN, ALWAYS issues `close(1000)`, clears the
watchdog, and settles the parked stdout waiter exactly once. The class introduces NO `Clock` dependency - reconnect timing is exercised in tests by injecting a
near-zero `backoff`, and the watchdog by `node:test` `mock.timers`.

## Log Client

### LogSocket

AsyncDisposable client for the live Homebridge log stream over a single Socket.IO WebSocket, with automatic reconnect, ping liveness, and a bounded push-to-pull line
stream.

#### Example

```ts
await using socket = new LogSocket({

  host: "localhost",
  log,
  refreshable: true,
  tokenProvider: (signal) => acquireToken(credentials, { host: "localhost", port: 8581, signal }),
  signal: session.signal
});

for await (const line of socket.stdout()) {

  process.stdout.write(line + "\n");
}
```

#### Implements

- [`LogSocketLike`](#logsocketlike)

#### Constructors

##### Constructor

```ts
new LogSocket(init): LogSocket;
```

Construct and start a new live-log socket. The reconnect loop starts synchronously as part of construction: by the time the constructor returns, the first connect
attempt is already in flight (unless the signal was pre-aborted, in which case the socket tears down immediately).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`LogSocketInit`](#logsocketinit) | Required init options. See [LogSocketInit](#logsocketinit). |

###### Returns

[`LogSocket`](#logsocket)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this socket's lifetime. Aborts exactly once - when [LogSocket.abort](#abort) is called, the parent signal fires, or the reconnect loop gives up on a permanent failure - and `signal.reason` names the cause. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

`true` once the socket's lifetime signal has aborted.

###### Implementation of

[`LogSocketLike`](#logsocketlike).[`aborted`](#aborted-1)

##### droppedLines

###### Get Signature

```ts
get droppedLines(): number;
```

The number of stdout lines dropped so far because the consumer fell behind the high-water mark. Zero in steady state; non-zero only after the bounded queue
overflowed, which is also logged once.

###### Returns

`number`

The number of stdout lines dropped because the consumer fell behind the high-water mark. Zero in steady state.

###### Implementation of

[`LogSocketLike`](#logsocketlike).[`droppedLines`](#droppedlines-1)

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the socket (defaulting to `"shutdown"`) and awaits the reconnect loop's completion before returning, so callers using
`await using` are guaranteed the connection is closed and the loop has unwound by the time the block exits.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the reconnect loop has fully exited.

###### Implementation of

```ts
LogSocketLike.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the socket and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: the underlying signal aborts only once, so subsequent calls are no-ops.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

###### Implementation of

[`LogSocketLike`](#logsocketlike).[`abort`](#abort-1)

##### stdout()

```ts
stdout(): AsyncGenerator<string>;
```

The bounded push-to-pull stream of raw log lines (ANSI intact, terminators removed) the server streams over the log namespace's `stdout` events.

The server delivers `stdout` as raw text chunks whose boundaries do not align with log lines; the socket runs each chunk through a per-session
[LogLineSplitter](parser.md#loglinesplitter), yields complete lines here, and flushes it on each session's close so the final line is never stranded. Mirroring
`Mp4SegmentAssembler.segments`, a bounded queue decouples the WebSocket producer from this consumer, and a single parked waiter blocks the consumer when the queue is
empty until a line is pushed or the socket aborts. The queue survives reconnects - the same iterable keeps yielding across a drop-and-reconnect - so a consumer
iterates it once for the whole socket lifetime. The stream terminates (returns) when the socket aborts; the queue is drained before it returns, so a line already
staged before teardown is never lost.

**Single-consumer only.** The parked-waiter slot is single-writer; iterating `stdout()` concurrently from two consumers is unsupported.

###### Returns

`AsyncGenerator`\<`string`\>

An async generator yielding raw log lines in stream order.

###### Implementation of

[`LogSocketLike`](#logsocketlike).[`stdout`](#stdout-1)

***

### LogSocketFactory

The creational half of the socket dependency-inversion seam: build a [LogSocketLike](#logsocketlike) from the socket init. A client holds this factory typed as the abstraction
and constructs through it, so a test can substitute a factory that returns a fake socket. The production factory is [logSocketFactory](#logsocketfactory-1), whose `create` is exactly
the [LogSocket](#logsocket) constructor call, so routing construction through this seam is behavior-neutral - mirroring the `RecordingProcessFactory` precedent.

#### Methods

##### create()

```ts
create(init): LogSocketLike;
```

Construct a live-log socket for the supplied init.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`LogSocketInit`](#logsocketinit) | The socket init options. See [LogSocketInit](#logsocketinit). |

###### Returns

[`LogSocketLike`](#logsocketlike)

A new [LogSocketLike](#logsocketlike).

***

### LogSocketInit

Construction-time options for [LogSocket](#logsocket).

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="backoff"></a> `backoff?` | `readonly` | (`attempt`) => `number` | Optional override for the connect-phase backoff policy, invoked with the 1-indexed attempt about to run and returning the delay in milliseconds. Defaults to the log client's own jittered exponential curve - a `RECONNECT_BASE_MS` base doubling each attempt and capped at `RECONNECT_CAP_MS`, plus up to `JITTER_FRACTION` upward jitter. Overridden in tests with a near-zero delay so the reconnect loop runs without real waits. |
| <a id="host"></a> `host` | `readonly` | `string` | The hostname or IP of the homebridge-config-ui-x server. |
| <a id="log"></a> `log` | `readonly` | [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) | Logger for connection lifecycle and overflow diagnostics. |
| <a id="port"></a> `port?` | `readonly` | `number` | The TCP port the server listens on. Defaults to `8581`. |
| <a id="random"></a> `random?` | `readonly` | () => `number` | Injectable source of `[0, 1)` randomness for backoff jitter. Defaults to `Math.random`; pinned in tests for deterministic backoff. |
| <a id="refreshable"></a> `refreshable` | `readonly` | `boolean` | Whether the credential backing [LogSocketInit.tokenProvider](#tokenprovider) can mint a fresh token on a reconnect. `true` for `password`/`noauth` credentials (each connect re-authenticates), `false` for a static `token`. When `false`, a handshake/namespace auth rejection is raised as a permanent [LogAuthError](auth.md#logautherror) so the connect-phase retry veto makes it terminal rather than retrying a token that cannot be refreshed. |
| <a id="signal-1"></a> `signal?` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) composed with the socket's internal controller. When the parent aborts, the socket tears down. |
| <a id="stdouthighwater"></a> `stdoutHighWater?` | `readonly` | `number` | Optional high-water mark for the bounded stdout queue. Defaults to `10000`. Overflow drops the oldest lines. |
| <a id="tls"></a> `tls?` | `readonly` | `boolean` | When `true`, use the secure (`wss`) scheme; when `false` or omitted, plaintext (`ws`). |
| <a id="tokenprovider"></a> `tokenProvider` | `readonly` | [`TokenProvider`](#tokenprovider-1) | Re-acquires a fresh token per connect attempt. See [TokenProvider](#tokenprovider-1). |
| <a id="websocketfactory"></a> `webSocketFactory?` | `readonly` | [`WebSocketFactory`](#websocketfactory-1) | The factory that constructs the underlying WebSocket. Defaults to [webSocketFactory](#websocketfactory-2). |

***

### LogSocketLike

The consumer-facing surface of a live-log socket: the minimal interface a client reads off a [LogSocket](#logsocket). This is the product half of the socket
dependency-inversion seam, so a client depends on this narrow interface rather than the concrete [LogSocket](#logsocket) and a test can substitute a fake that yields
caller-supplied lines without standing up a WebSocket. Every member is defined on [LogSocket](#logsocket), so the real class satisfies it by `implements` with zero runtime
change.

#### Extends

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="aborted-1"></a> `aborted` | `readonly` | `boolean` | `true` once the socket's lifetime signal has aborted. |
| <a id="droppedlines-1"></a> `droppedLines` | `readonly` | `number` | The number of stdout lines dropped because the consumer fell behind the high-water mark. Zero in steady state. |
| <a id="signal-2"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing the socket's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause. |

#### Methods

##### abort()

```ts
abort(reason?): void;
```

Abort the socket and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

##### stdout()

```ts
stdout(): AsyncGenerator<string>;
```

The bounded push-to-pull stream of raw log lines the server streams over the log namespace. Terminates when the socket aborts.

###### Returns

`AsyncGenerator`\<`string`\>

An async generator yielding raw log lines in stream order.

***

### WebSocketLike

A minimal WebSocket surface the [LogSocket](#logsocket) depends on, so the concrete implementation (the platform global `WebSocket`, or a test double) is an injected seam.

The shape is the subset of the DOM `WebSocket` interface the socket actually uses: the four lifecycle events via `addEventListener`, `send` for outbound frames,
`close` for teardown, and `readyState` (compared against [WEBSOCKET\_OPEN](#websocket_open)) so teardown can gate the namespace-disconnect frame on an open connection. Modeling
the seam as this narrow interface rather than the full `WebSocket` keeps a test double small and makes the socket's exact dependency surface explicit.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="readystate"></a> `readyState` | `readonly` | `number` |

#### Methods

##### addEventListener()

###### Call Signature

```ts
addEventListener(type, listener): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `type` | `"close"` |
| `listener` | (`event`) => `void` |

###### Returns

`void`

###### Call Signature

```ts
addEventListener(type, listener): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `type` | `"error"` |
| `listener` | (`event`) => `void` |

###### Returns

`void`

###### Call Signature

```ts
addEventListener(type, listener): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `type` | `"message"` |
| `listener` | (`event`) => `void` |

###### Returns

`void`

###### Call Signature

```ts
addEventListener(type, listener): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `type` | `"open"` |
| `listener` | () => `void` |

###### Returns

`void`

##### close()

```ts
close(code?): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `code?` | `number` |

###### Returns

`void`

##### send()

```ts
send(data): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `string` |

###### Returns

`void`

***

### TokenProvider

```ts
type TokenProvider = (signal) => Promise<string>;
```

Re-acquire a fresh raw bearer token. Invoked once per connect attempt so a reconnect after a token has expired re-authenticates from the stored credentials. The
provider may reject with a permanent authentication failure, which the reconnect loop classifies terminal via [isPermanentAuthError](auth.md#ispermanentautherror).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The connect attempt's abort signal, forwarded so a token acquisition in flight is cancelled when the attempt is aborted. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`string`\>

A promise resolving to the raw bearer token (the bare JWT, no `Bearer` prefix).

***

### WebSocketFactory

```ts
type WebSocketFactory = (url) => WebSocketLike;
```

The factory seam that constructs a [WebSocketLike](#websocketlike) for a given connect URL.

The production factory wraps the platform global `WebSocket`; a test substitutes a factory that returns a controllable double, so the whole socket state machine -
handshake, ping/pong, reconnect, teardown - is exercised without a real network.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `url` | `string` | The fully-formed `ws(s)://...` connect URL, already carrying `EIO=4`, the transport selector, and the raw token in its query string. |

#### Returns

[`WebSocketLike`](#websocketlike)

A [WebSocketLike](#websocketlike) that begins connecting immediately, exactly as the platform `WebSocket` constructor does.

***

### logSocketFactory

```ts
const logSocketFactory: LogSocketFactory;
```

The production [LogSocketFactory](#logsocketfactory): builds the concrete WebSocket-backed [LogSocket](#logsocket). A client holds the factory typed as the seam abstraction; a test
substitutes a fake factory. `create` is exactly the [LogSocket](#logsocket) constructor call, so wiring construction through this seam is behavior-neutral.

***

### WEBSOCKET\_OPEN

```ts
const WEBSOCKET_OPEN: 1 = 1;
```

The numeric `readyState` value denoting an open WebSocket. The DOM `WebSocket.OPEN` constant is `1`; we name it as a module constant so the seam interface does not
have to carry the static constant and teardown can gate on it without depending on the concrete class.

***

### webSocketFactory

```ts
const webSocketFactory: WebSocketFactory;
```

The production [WebSocketFactory](#websocketfactory-1): constructs the platform global `WebSocket`. A consumer holds the factory typed as the seam abstraction; a test substitutes a
double. The platform `WebSocket` begins connecting on construction, which is exactly the factory contract.

#### Param

**url**

The connect URL.

#### Returns

A live platform `WebSocket`, typed as the [WebSocketLike](#websocketlike) seam.

***

### reconnectBackoff()

```ts
function reconnectBackoff(attempt, random?): number;
```

The log client's connect-phase reconnect backoff policy: a dev-tuned jittered exponential curve with a low ceiling.

This is the single source of truth for the socket's default reconnect timing. The base delay is `RECONNECT_BASE_MS` (500 ms) and it doubles with each successive
connect attempt, plateauing at the `RECONNECT_CAP_MS` ceiling (5 s) - deliberately snappier than `defaultRetryBackoff`'s 30-second ceiling, because a log-tailing
dev tool should resume the tail promptly after the frequent Homebridge restarts a plugin developer does rather than back off to a half-minute lag. Up to
`JITTER_FRACTION` of the computed base is added as upward jitter so a fleet of clients does not reconnect in lockstep after a shared outage.

It is exported (rather than left inline in the constructor) so the bare schedule is a directly unit-testable function: with `random` pinned to `0` the curve yields the
exact, deterministic 500, 1000, 2000, 4000, 5000, 5000, ... sequence. `retry` invokes the socket's backoff 1-indexed with the attempt about to run and never with
`attempt === 1` (the first attempt runs immediately), so `attempt - 2` is the zero-based exponent for the second-and-later attempts.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `attempt` | `number` | `undefined` | The 1-indexed connect attempt about to run. Called only for the second and later attempts (the first runs with no wait). |
| `random` | () => `number` | `Math.random` | Source of `[0, 1)` randomness for the jitter. Defaults to `Math.random`; pinned in tests for a deterministic schedule. |

#### Returns

`number`

The delay, in milliseconds, to wait before running `attempt`.
