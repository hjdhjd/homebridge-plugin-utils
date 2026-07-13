[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/client

# logclient/client

AsyncDisposable client for the Homebridge UI log stream.

[HomebridgeLogClient](#homebridgelogclient) is the subsystem-local composition root: it holds the connection configuration and the credentials, and it composes the pure leaf modules
(`parser.ts`, `stitch.ts`, `time-window.ts`) with the transports (`auth.ts`, `rest.ts`, `socket.ts`) into the consumer-facing channels below, each returning a
[LogStream](#logstream):

- [HomebridgeLogClient.history](#history) - a one-shot REST whole-file download parsed into records, optionally trimmed to the most recent N lines.
- [HomebridgeLogClient.follow](#follow) - a live socket tail: the server's ~500-line seed followed by genuinely new lines, streamed indefinitely.
- [HomebridgeLogClient.tail](#tail) - a [TailRequest](types.md#tailrequest)-driven dispatcher that selects `history`, `follow`, the socket-first `follow-history` join, or the
  hedged-seed time-bounded `window` channel.

The following design points matter:

- **Token lifecycle via a closure.** The client builds one [TokenProvider](socket.md#tokenprovider-1) closure over [acquireToken](auth.md#acquiretoken) and the stored credentials. The socket invokes it on
  every connect attempt, so a `password`/`noauth` credential re-authenticates from the stored credentials on each reconnect (surviving token expiry across a drop). A
  static `token` credential is returned verbatim with no network call, so it is never "refreshed"; an expired static token instead surfaces later when the socket
  handshake is rejected.
- **Leak-free per-call teardown.** Each channel is an async generator wrapper, mirroring `mp4-assembler.ts`. It builds a per-call [LogSocketLike](socket.md#logsocketlike) through the
  injected [LogSocketFactory](socket.md#logsocketfactory) seam under a per-call abort controller composed with the client's lifetime, and its `finally` disposes that socket and aborts the
  per-call controller. Both `await using stream = client.follow()` and an early `break` out of the iteration therefore tear the per-call socket down with no leak.

Lifetime is a composed [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal): the optional caller `signal` composed with the client's own controller. Disposing the client (or aborting the caller
signal) aborts every in-flight channel, because each channel composes its per-call signal under the client's lifetime signal.

## Log Client

### HomebridgeLogClient

AsyncDisposable client for the Homebridge UI log stream.

#### Example

```ts
import { HomebridgeLogClient } from "homebridge-plugin-utils";

await using client = new HomebridgeLogClient({ credentials: { kind: "password", password: "secret", username: "admin" }, host: "localhost" });

await using stream = client.tail({ mode: "follow-history", quantity: 200 });

for await (const record of stream) {

  process.stdout.write(record.raw + "\n");
}
```

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new HomebridgeLogClient(options): HomebridgeLogClient;
```

Construct a new log client.

Construction performs no I/O: no connection is opened and no token is acquired until a channel is invoked. The token provider closure is built here so every channel
shares one authentication path.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`HomebridgeLogClientOptions`](#homebridgelogclientoptions) | Required options. See [HomebridgeLogClientOptions](#homebridgelogclientoptions). |

###### Returns

[`HomebridgeLogClient`](#homebridgelogclient)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this client's lifetime. Aborts exactly once - when the client is disposed (`[Symbol.asyncDispose]`) or the parent signal fires - and `signal.reason` names the cause. Every channel composes its per-call signal under this one, so disposing the client tears down all in-flight channels. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the client (defaulting to `"shutdown"`), which aborts every in-flight channel's per-call signal, so callers using
`await using` are guaranteed all channels have begun tearing down by the time the block exits.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A resolved promise once the abort has been issued.

###### Implementation of

```ts
AsyncDisposable.[asyncDispose]
```

##### follow()

```ts
follow(options?): LogStream;
```

Live-tail the log over the socket channel.

Builds a [LogSocketLike](socket.md#logsocketlike) through the injected factory seam and yields each parsed [LogRecord](types.md#logrecord) the server streams - the ~500-line seed first, then
genuinely new lines indefinitely. The stream terminates only when the caller stops iterating (an early `break`, which disposes the socket), the per-call signal
aborts, or the client is disposed.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional per-call options. |
| `options.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional per-call abort signal composed with the client's lifetime; aborting it terminates only this stream. |

###### Returns

[`LogStream`](#logstream)

A [LogStream](#logstream) of live records.

##### history()

```ts
history(options?): LogStream;
```

Retrieve historical log lines over the REST whole-file download channel.

Streams `GET .../log/download` through the parser and yields each parsed [LogRecord](types.md#logrecord). When `quantity` is a number, only the most recent N records are retained
(via [takeLast](../util.md#takelast), a bounded ring so a multi-MB log is never fully materialized); when it is `"all"` (the default), every record passes through. This is the
deep-history channel paid only when the caller explicitly wants history beyond the socket's ~500-line seed.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `quantity?`: [`LogQuantity`](types.md#logquantity); `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional per-call options. |
| `options.quantity?` | [`LogQuantity`](types.md#logquantity) | How many of the most recent records to retain. Defaults to `"all"`. |
| `options.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional per-call abort signal composed with the client's lifetime; aborting it terminates only this stream. |

###### Returns

[`LogStream`](#logstream)

A [LogStream](#logstream) of historical records, oldest first.

##### tail()

```ts
tail(request, options?): LogStream;
```

Deliver log content over the channel selected by the [TailRequest](types.md#tailrequest) discriminated union.

- `history` - delegates to [HomebridgeLogClient.history](#history) with the request's quantity.
- `follow` - delegates to [HomebridgeLogClient.follow](#follow).
- `follow-history` - the socket-first join: the socket connects and buffers its seed plus any live lines that arrive during the REST download into a bounded ring,
  then the REST history is downloaded and trimmed to the request's quantity, then the two are joined by [stitchLive](stitch.md#stitchlive) so the boundary overlap is removed without
  dropping a distinct live line, and finally the live stream continues. Connecting the socket first is what guarantees no live line produced during the download is
  lost.
- `window` - the hedged-seed time-bounded channel: the socket connects and buffers its seed while a parallel abortable whole-file download runs, a strict-coverage
  gate decides whether the seed covers `[since, until]` (serve from the seed and abort the download) or not (fall back to the download, stitched with the seed),
  and the merged output is time-window-filtered. A one-shot window terminates when its content has been served; a `follow` window continues live.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`TailRequest`](types.md#tailrequest) | The request describing which content to deliver and over which channel. See [TailRequest](types.md#tailrequest). |
| `options` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional per-call options. |
| `options.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional per-call abort signal composed with the client's lifetime; aborting it terminates only this stream. |

###### Returns

[`LogStream`](#logstream)

A [LogStream](#logstream) for the selected channel.

***

### HomebridgeLogClientOptions

Construction-time options for [HomebridgeLogClient](#homebridgelogclient).

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="credentials"></a> `credentials` | `readonly` | [`LogClientCredentials`](types.md#logclientcredentials) | The credentials used to authenticate. See [LogClientCredentials](types.md#logclientcredentials). |
| <a id="fetch"></a> `fetch?` | `readonly` | \{ (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; \} | Optional `fetch` implementation for the auth and REST transports. Defaults to the global `fetch`. Injected so the client is testable without a live server. |
| <a id="host"></a> `host?` | `readonly` | `string` | The hostname or IP of the homebridge-config-ui-x server. Defaults to `localhost`. |
| <a id="log"></a> `log?` | `readonly` | [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) | Optional logger for connection lifecycle and diagnostics. Defaults to a silent no-op sink when omitted. |
| <a id="port"></a> `port?` | `readonly` | `number` | The TCP port the server listens on. Defaults to `8581`. |
| <a id="signal-1"></a> `signal?` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) composed with the client's internal controller. When it aborts, every in-flight channel tears down. |
| <a id="socketfactory"></a> `socketFactory?` | `readonly` | [`LogSocketFactory`](socket.md#logsocketfactory) | Optional factory seam for constructing the live-log socket. Defaults to [logSocketFactory](socket.md#logsocketfactory-1). Injected so the client is testable without a WebSocket. |
| <a id="tls"></a> `tls?` | `readonly` | `boolean` | When `true`, use the secure (`https`/`wss`) schemes; when `false` or omitted, plaintext (`http`/`ws`). |

***

### LogStream

A consumer-facing log stream: an async iterable of parsed [LogRecord](types.md#logrecord)s that is also [AsyncDisposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose).

Every [HomebridgeLogClient](#homebridgelogclient) channel returns one. Iterate it with `for await (const record of stream)`; dispose it with `await using stream = client.follow()` (or
an early `break`) to tear down the underlying transport with no leak. The two super-interfaces capture exactly that contract: it is iterable, and it cleans up after
itself when the scope exits. A plain async generator satisfies it structurally - its `[Symbol.asyncIterator]` makes it iterable and its `[Symbol.asyncDispose]` (which
delegates to the generator's `return()`, running the `finally` that disposes the per-call socket) makes it disposable.

#### Extends

- `AsyncIterable`\<[`LogRecord`](types.md#logrecord)\>.[`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)
