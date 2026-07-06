[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/socket-double

# logclient/socket-double

Reusable test doubles for the log client's two socket seams.

Two seams drive the live-log transport: the low-level [WebSocketFactory](socket.md#websocketfactory-1) ([LogSocket](socket.md#logsocket) builds a [WebSocketLike](socket.md#websocketlike) from
it) and the high-level [LogSocketFactory](socket.md#logsocketfactory) (a client builds a [LogSocketLike](socket.md#logsocketlike) from it). This module ships the fakes that cash both in, mirroring the
shape of `recording-process-double.ts`:

- [TestWebSocket](#testwebsocket) - a controllable [WebSocketLike](socket.md#websocketlike) that captures every frame sent and every close code, and exposes `emitOpen` / `emitMessage` /
  `emitError` / `emitClose` so a test drives the socket state machine frame by frame without a real network. [TestWebSocketFactory](#testwebsocketfactory) records every `create` call
  (the connect URL) and returns the socket.
- [TestLogSocket](#testlogsocket) - a [LogSocketLike](socket.md#logsocketlike) that yields caller-supplied lines from `stdout()` and aborts a genuine [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) on `abort()`.
  [TestLogSocketFactory](#testlogsocketfactory) records every `create` call (the init it was passed) and returns the socket, so a client can be exercised without a WebSocket at all.

## Testing

### TestLogSocket

A [LogSocketLike](socket.md#logsocketlike) test double. It yields caller-supplied lines from `stdout()` and then parks until aborted, mirroring how the real socket keeps a live stream
open after the seed; `abort()` aborts a genuine [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) with a real [HbpuAbortError](../util.md#hbpuaborterror) reason so a consumer's abort-reason derivations stay meaningful.
A consumer can drive a client end to end against this double without a WebSocket.

#### Implements

- [`LogSocketLike`](socket.md#logsocketlike)

#### Constructors

##### Constructor

```ts
new TestLogSocket(init?): TestLogSocket;
```

Construct a log-socket double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`TestLogSocketInit`](#testlogsocketinit) | Optional configuration. See [TestLogSocketInit](#testlogsocketinit). Every field defaults, so a bare `new TestLogSocket()` is valid. |

###### Returns

[`TestLogSocket`](#testlogsocket)

#### Properties

| Property | Modifier | Type | Default value |
| ------ | ------ | ------ | ------ |
| <a id="abortcalls"></a> `abortCalls` | `readonly` | `unknown`[] | `[]` |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once the socket's signal has aborted.

###### Returns

`boolean`

`true` once the socket's lifetime signal has aborted.

###### Implementation of

[`LogSocketLike`](socket.md#logsocketlike).[`aborted`](socket.md#aborted-1)

##### droppedLines

###### Get Signature

```ts
get droppedLines(): number;
```

The configured dropped-line count.

###### Returns

`number`

The number of stdout lines dropped because the consumer fell behind the high-water mark. Zero in steady state.

###### Implementation of

[`LogSocketLike`](socket.md#logsocketlike).[`droppedLines`](socket.md#droppedlines-1)

##### signal

###### Get Signature

```ts
get signal(): AbortSignal;
```

The composed abort signal representing this socket's lifetime. Aborts exactly once, when `abort()` is called.

###### Returns

[`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

The composed abort signal representing the socket's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause.

###### Implementation of

[`LogSocketLike`](socket.md#logsocketlike).[`signal`](socket.md#signal-2)

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the socket (defaulting to `"shutdown"`).

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A resolved promise once the abort has been issued.

###### Implementation of

```ts
LogSocketLike.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the socket. Aborts the internal signal with the supplied reason, defaulting to a real `HbpuAbortError("shutdown")`, and records the (defaulted) reason. Safe to
call more than once: the underlying signal aborts only once.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

###### Implementation of

[`LogSocketLike`](socket.md#logsocketlike).[`abort`](socket.md#abort-1)

##### stdout()

```ts
stdout(): AsyncGenerator<string>;
```

Yield the configured lines in order, then park until the socket aborts (mirroring a live stream that stays open after its seed). Terminates (returns) when the
signal aborts, so a consumer iterating this generator unwinds cleanly on `abort()` or disposal.

###### Returns

`AsyncGenerator`\<`string`\>

An async generator yielding the configured raw log lines, then parking until abort.

###### Implementation of

[`LogSocketLike`](socket.md#logsocketlike).[`stdout`](socket.md#stdout-1)

***

### TestLogSocketFactory

A [LogSocketFactory](socket.md#logsocketfactory) double that records every `create` call (the init it was passed) and returns a [TestLogSocket](#testlogsocket), mirroring the create-call-recording
discipline `TestRecordingProcessFactory` uses. By default it returns a fresh, default-configured socket per call; supply a socket to the constructor to return a single
pre-configured instance from every `create`.

#### Implements

- [`LogSocketFactory`](socket.md#logsocketfactory)

#### Constructors

##### Constructor

```ts
new TestLogSocketFactory(socket?): TestLogSocketFactory;
```

Construct a log-socket-factory double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `socket?` | [`TestLogSocket`](#testlogsocket) | Optional pre-configured [TestLogSocket](#testlogsocket) to return from every `create`. When omitted, each `create` returns a fresh, default-configured socket. |

###### Returns

[`TestLogSocketFactory`](#testlogsocketfactory)

#### Properties

| Property | Modifier | Type | Default value |
| ------ | ------ | ------ | ------ |
| <a id="createcalls"></a> `createCalls` | `readonly` | \{ `init`: [`LogSocketInit`](socket.md#logsocketinit); `socket`: [`TestLogSocket`](#testlogsocket); \}[] | `[]` |

#### Methods

##### create()

```ts
create(init): LogSocketLike;
```

Record the create call and return a [TestLogSocket](#testlogsocket) - the constructor-supplied instance when one was given, otherwise a fresh default-configured one.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`LogSocketInit`](socket.md#logsocketinit) | The [LogSocketInit](socket.md#logsocketinit) the consumer passed. |

###### Returns

[`LogSocketLike`](socket.md#logsocketlike)

The log-socket double.

###### Implementation of

[`LogSocketFactory`](socket.md#logsocketfactory).[`create`](socket.md#create)

***

### TestWebSocket

A controllable [WebSocketLike](socket.md#websocketlike) test double. It captures every frame the socket under test sends and every close code it issues, and it exposes explicit emit
methods so a test can drive the connection through its handshake, ping/pong, streaming, and teardown by hand - no real network, fully deterministic.

Fidelity to the seam contract: `readyState` starts OPEN and flips to CLOSED on the first `close()` (or an inbound [TestWebSocket.emitClose](#emitclose)), so the socket's
teardown gate (send the namespace DISCONNECT only while OPEN) behaves exactly as it would against a real connection; `send` records the frame regardless of state so a
test can assert the exact wire sequence including any post-close send attempt.

#### Implements

- [`WebSocketLike`](socket.md#websocketlike)

#### Constructors

##### Constructor

```ts
new TestWebSocket(url?): TestWebSocket;
```

Construct a controllable WebSocket double.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `url` | `string` | `""` | The connect URL the factory was asked to build. Defaults to an empty string for tests that do not assert on the URL. |

###### Returns

[`TestWebSocket`](#testwebsocket)

#### Properties

| Property | Modifier | Type | Default value |
| ------ | ------ | ------ | ------ |
| <a id="closecodes"></a> `closeCodes` | `readonly` | `number`[] | `[]` |
| <a id="sent"></a> `sent` | `readonly` | `string`[] | `[]` |
| <a id="url"></a> `url` | `readonly` | `string` | `undefined` |

#### Accessors

##### readyState

###### Get Signature

```ts
get readyState(): number;
```

The current readyState: [WEBSOCKET\_OPEN](socket.md#websocket_open) until the first close, `WEBSOCKET_CLOSED` after.

###### Returns

`number`

###### Implementation of

[`WebSocketLike`](socket.md#websocketlike).[`readyState`](socket.md#readystate)

#### Methods

##### addEventListener()

###### Call Signature

```ts
addEventListener(type, listener): void;
```

Register a listener. Mirrors the DOM `addEventListener` overloads the [WebSocketLike](socket.md#websocketlike) seam declares; the matching `emit*` method dispatches to every
registered listener of that type.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `"close"` | The event type to listen for. |
| `listener` | (`event`) => `void` | The listener to register. |

###### Returns

`void`

###### Implementation of

[`WebSocketLike`](socket.md#websocketlike).[`addEventListener`](socket.md#addeventlistener)

###### Call Signature

```ts
addEventListener(type, listener): void;
```

Register a listener. Mirrors the DOM `addEventListener` overloads the [WebSocketLike](socket.md#websocketlike) seam declares; the matching `emit*` method dispatches to every
registered listener of that type.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `"error"` | The event type to listen for. |
| `listener` | (`event`) => `void` | The listener to register. |

###### Returns

`void`

###### Implementation of

[`WebSocketLike`](socket.md#websocketlike).[`addEventListener`](socket.md#addeventlistener)

###### Call Signature

```ts
addEventListener(type, listener): void;
```

Register a listener. Mirrors the DOM `addEventListener` overloads the [WebSocketLike](socket.md#websocketlike) seam declares; the matching `emit*` method dispatches to every
registered listener of that type.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `"message"` | The event type to listen for. |
| `listener` | (`event`) => `void` | The listener to register. |

###### Returns

`void`

###### Implementation of

[`WebSocketLike`](socket.md#websocketlike).[`addEventListener`](socket.md#addeventlistener)

###### Call Signature

```ts
addEventListener(type, listener): void;
```

Register a listener. Mirrors the DOM `addEventListener` overloads the [WebSocketLike](socket.md#websocketlike) seam declares; the matching `emit*` method dispatches to every
registered listener of that type.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `"open"` | The event type to listen for. |
| `listener` | () => `void` | The listener to register. |

###### Returns

`void`

###### Implementation of

[`WebSocketLike`](socket.md#websocketlike).[`addEventListener`](socket.md#addeventlistener)

##### close()

```ts
close(code?): void;
```

Close the socket. Records the close code and flips `readyState` to CLOSED. Idempotent in the sense the seam needs: a second close simply records a second code.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `code` | `number` | `1000` | The close code. Defaults to 1000 (normal closure), matching the platform default. |

###### Returns

`void`

###### Implementation of

[`WebSocketLike`](socket.md#websocketlike).[`close`](socket.md#close)

##### emitClose()

```ts
emitClose(code?): void;
```

Dispatch a `close` event to every registered close listener and flip `readyState` to CLOSED, simulating the peer closing the connection.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `code` | `number` | `1000` | The close code to deliver. Defaults to 1000. |

###### Returns

`void`

##### emitError()

```ts
emitError(event?): void;
```

Dispatch an `error` event to every registered error listener, simulating a transport-level error.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `event` | `unknown` | The error event payload. Defaults to an object carrying an `error` field, the shape the socket's error describer reads. |

###### Returns

`void`

##### emitMessage()

```ts
emitMessage(data): void;
```

Dispatch a `message` event carrying `data` to every registered message listener, simulating an inbound frame.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `data` | `unknown` | The frame text (or any value, to exercise the socket's non-string guard). |

###### Returns

`void`

##### emitOpen()

```ts
emitOpen(): void;
```

Dispatch an `open` event to every registered open listener, simulating the transport-layer connection opening.

###### Returns

`void`

##### send()

```ts
send(data): void;
```

Record an outbound frame. The frame is captured regardless of `readyState` so a test can assert the full wire sequence, including any send attempted after close.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `data` | `string` | The frame text. |

###### Returns

`void`

###### Implementation of

[`WebSocketLike`](socket.md#websocketlike).[`send`](socket.md#send)

***

### TestWebSocketFactory

A [WebSocketFactory](socket.md#websocketfactory-1) double that records every `create` call (the connect URL) and returns a [TestWebSocket](#testwebsocket). By default it returns a fresh socket per
call, which is exactly what the reconnect path needs - each connect attempt gets a distinct controllable socket - and the recorded sockets are retained in order so a
test can drive the second attempt's socket after failing the first.

#### Constructors

##### Constructor

```ts
new TestWebSocketFactory(socket?): TestWebSocketFactory;
```

Construct a WebSocket-factory double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `socket?` | [`TestWebSocket`](#testwebsocket) | Optional fixed [TestWebSocket](#testwebsocket) to return from every `create`. When omitted, each `create` returns a fresh socket built with the call's URL. |

###### Returns

[`TestWebSocketFactory`](#testwebsocketfactory)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="create-1"></a> `create` | `readonly` | [`WebSocketFactory`](socket.md#websocketfactory-1) | `undefined` | The [WebSocketFactory](socket.md#websocketfactory-1) function this double exposes. Bound as an arrow property so it can be passed directly as the `webSocketFactory` seam without losing `this`. **Param** **url** The connect URL. |
| <a id="sockets"></a> `sockets` | `readonly` | [`TestWebSocket`](#testwebsocket)[] | `[]` | - |
| <a id="urls"></a> `urls` | `readonly` | `string`[] | `[]` | - |

#### Methods

##### socketCreated()

```ts
socketCreated(index): Promise<TestWebSocket>;
```

Resolve when the socket at `index` (0-based, in creation order) has been constructed, returning it - immediately when it already exists. Lets a reconnect test
await the next connect attempt's socket deterministically instead of racing the reconnect loop's backoff against a fixed wall-clock delay.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `index` | `number` | The 0-based creation-order index to await. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`TestWebSocket`](#testwebsocket)\>

A promise resolving to the [TestWebSocket](#testwebsocket) at that index.

***

### TestLogSocketInit

Construction-time configuration for a [TestLogSocket](#testlogsocket). Every field defaults, so a bare `new TestLogSocket()` is usable.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="droppedlines-1"></a> `droppedLines?` | `number` | The value the `droppedLines` getter reports. Defaults to `0`. |
| <a id="lines"></a> `lines?` | readonly `string`[] | The raw log lines `stdout()` yields, in order, before it parks awaiting abort. Defaults to an empty array. |
