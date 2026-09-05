[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / http-listener

# http-listener

One plugin-hosted HTTP listener, shaped to the library's own lifecycle model.

A plugin that has to answer HTTP - an inbound delivery a controller posts, a document a media player fetches, a redirect an authorization flow lands on - needs
the same machinery every time: a server whose lifetime is an [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal), a port that is retried while something else holds it, a way to say which paths it
answers and with which methods, a body read that refuses to buffer without bound, and a teardown that releases the port rather than leaking it across a plugin
reload. That machinery is what this module owns, and it is all it owns: which port, which paths, what a request means, and what the answer is are the consumer's,
handed in as options and as a handler.

The pieces:

- [HttpListener](#httplistener) - the listener itself. Its lifetime is `signal`, composed from the caller's and its own; the signal firing closes the server, drops every
  connection so the port is releasable at once, cancels a pending bind retry, and releases every registered route.
- [HttpListener.route](#route) - register a handler for one exact path, or for [HTTP\_LISTENER\_ANY\_PATH](#http_listener_any_path), the catch-all a route claims to answer every request
  no exact route claims. Registration answers a [Disposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose) that releases the path.
- [HttpListenerHandler](#httplistenerhandler) - the route contract: a synchronous function from a [HttpListenerRequest](#httplistenerrequest) to a [HttpListenerResponse](#httplistenerresponse). Synchronous is the
  contract rather than an accommodation, because the answer is written the moment the handler returns, which keeps a delivery inside the sender's own receive
  budget and leaves nothing that can outlive the listener.

Every lifecycle line the listener writes carries the consumer's `label`, so the wording is the library's and uniform across plugins while the purpose still reads
in each line ("The document server is listening on port 10110.").

This module imports `node:http` and is therefore Node-only, like `util.ts`. A browser-targeted consumer cannot resolve that import.

## Utilities

### HttpListener

A signal-scoped HTTP listener: one `http.Server` whose lifetime is an [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal), with routes registered by handle, a bounded raw-body read, a bind retry
that composes over the library's own `retry()` on an injected [Clock](clock.md#clock), and a disposal that has released the port by the time it resolves.

#### Example

```ts
import { HTTP_LISTENER_ANY_PATH, HttpListener } from "homebridge-plugin-utils";

await using listener = new HttpListener({ label: "document server", log: this.log, port: 10110, signal: this.signal });

// One route answering every path, which is what a server with a single document to hand out wants.
using _route = listener.route(HTTP_LISTENER_ANY_PATH, () => ({ body: this.document(), headers: { "Content-Type": "text/plain" }, status: 200 }));

await listener.ready;
```

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new HttpListener(options): HttpListener;
```

Construct and start a listener. Binding begins immediately and is retried while the port is in use, so a caller that needs to know when it came up awaits
[HttpListener.ready](#ready).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`HttpListenerOptions`](#httplisteneroptions) | The listener's inputs. See [HttpListenerOptions](#httplisteneroptions). |

###### Returns

[`HttpListener`](#httplistener)

###### Throws

If `label` is empty, or `bodyLimit` or `retryMs` is not a positive finite number, or `port` is not an integer from 0 to 65535. Each refusal
names the option, so a misconfiguration is diagnosable where it was made.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves on the first successful bind, and rejects with `signal.reason` if the lifetime ends before one happens. Marked handled, so a consumer that never awaits it - one that simply registers routes and lets the listener come up on its own - does not turn a shutdown into an unhandled rejection. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this listener's lifetime. Aborts exactly once - when [HttpListener.abort](#abort) is called, when the caller's signal fires, or when the server fails in a way it cannot come back from; `signal.reason` names the cause. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once `this.signal` has aborted. Derived from the signal; no independent state.

###### Returns

`boolean`

##### boundPort

###### Get Signature

```ts
get boundPort(): number;
```

The port the listener is actually bound to, or zero before it has bound one and once it has closed. A caller that asked for an ephemeral port learns here which
one it was given.

###### Returns

`number`

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation. Aborts the listener (defaulting to `"shutdown"`) and awaits the server's own close, so the port is bindable again by the time
the surrounding `await using` scope's next statement runs. An in-flight request does not delay it: teardown drops every connection.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the server has closed.

###### Implementation of

```ts
AsyncDisposable.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the listener and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](util.md#hbpuaborterror); platform errors (`TimeoutError`, `AbortError`) also interoperate by convention. |

###### Returns

`void`

##### route()

```ts
route(
   path, 
   handler, 
   options?
): Disposable;
```

Register a handler for one path.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `path` | [`HttpListenerPath`](#httplistenerpath) | The path to route, exactly as a sender will address it, or [HTTP\_LISTENER\_ANY\_PATH](#http_listener_any_path) to answer every request no exact route claims. |
| `handler` | [`HttpListenerHandler`](#httplistenerhandler) | The function that answers requests to that path. |
| `options` | [`HttpListenerRouteOptions`](#httplistenerrouteoptions) | Optional per-route options. See [HttpListenerRouteOptions](#httplistenerrouteoptions). |

###### Returns

[`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

A handle whose disposal releases the path. Disposal removes only the registration this call made, so a handle disposed after its path was registered
         again removes nothing.

###### Throws

The lifetime's abort reason if the listener has ended, and a `TypeError` naming the collision if the path is already routed.

***

### HttpListenerOptions

Construction options for [HttpListener](#httplistener).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bodylimit"></a> `bodyLimit?` | `number` | The largest request body a route will be handed, in bytes. A body that crosses it is refused with 413 and never reaches a handler. Defaults to 65536. |
| <a id="clock"></a> `clock?` | [`Clock`](clock.md#clock) | Optional time source for the bind retry's waits, handed through to `retry()`. Defaults to `systemClock`; a `TestClock` puts the retry schedule on virtual time. |
| <a id="label"></a> `label` | `string` | The noun phrase every one of this listener's log lines names it by - "event receiver", "document server". Required, because the library owns the wording of those lines and the label is what carries the purpose in them. An empty label is refused. |
| <a id="log"></a> `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Where the listener's own lines go. |
| <a id="port"></a> `port` | `number` | The port to bind. Zero asks the operating system for an ephemeral one, which [HttpListener.boundPort](#boundport) then reports. |
| <a id="retryms"></a> `retryMs?` | `number` | How long to wait before retrying a port that was in use. Defaults to 5000. |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The caller's lifetime, composed into [HttpListener.signal](#signal). Firing it closes the listener for good. |

***

### HttpListenerRequest

One request, as a route sees it.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="body"></a> `body` | `readonly` | `Buffer` | The body exactly as it arrived. It stays raw bytes because a signature covers what was sent: parsing and re-serializing a payload before verification would change the whitespace and key order the signature was computed over and turn every authentic delivery into a refusal. |
| <a id="headers"></a> `headers` | `readonly` | `IncomingHttpHeaders` | The headers as Node parsed them. A consumer picks the header it cares about and applies its own rule for the string-or-array shape Node hands back, because what a repeated header means is the consumer's protocol rather than this listener's. |

***

### HttpListenerResponse

A route's answer to one request: the status to write, and optionally the headers and body to write with it.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="body-1"></a> `body?` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The response body. Omitted for a status that carries none. |
| <a id="headers-1"></a> `headers?` | `OutgoingHttpHeaders` | The response headers, written alongside the status. |
| <a id="status"></a> `status` | `number` | The status code to answer with. |

***

### HttpListenerRouteOptions

Per-route options for [HttpListener.route](#route).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="methods"></a> `methods?` | readonly `string`[] | The HTTP methods this route accepts, compared exactly against the request's method. Absent means every method; an empty list admits none. A request whose method is absent altogether is outside any declared list. |

***

### HttpListenerHandler

```ts
type HttpListenerHandler = (request) => HttpListenerResponse;
```

A route: the function that turns one request into one answer.

Synchronous by contract. The answer is written the moment the handler returns, so a delivery stays inside the sender's own receive budget and nothing a handler
started can outlive the listener. A handler with asynchronous work to do dispatches it and answers, rather than making the sender wait on it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`HttpListenerRequest`](#httplistenerrequest) | The request to answer. |

#### Returns

[`HttpListenerResponse`](#httplistenerresponse)

The answer to write.

***

### HttpListenerPath

```ts
type HttpListenerPath = string | typeof HTTP_LISTENER_ANY_PATH;
```

What a route is registered under: one exact path, or [HTTP\_LISTENER\_ANY\_PATH](#http_listener_any_path) for the catch-all.

***

### HTTP\_LISTENER\_ANY\_PATH

```ts
const HTTP_LISTENER_ANY_PATH: unique symbol;
```

The path a route claims to answer every request no exact route claims.

A symbol rather than a string or `null`: a sentinel that must never collide with a path a sender can address has to be something no sender can spell, and the
constant reads at the call site as what it is - `listener.route(HTTP_LISTENER_ANY_PATH, handler)`.
