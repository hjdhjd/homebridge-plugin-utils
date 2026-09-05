[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / http-listener-double

# http-listener-double

A socket-free [HttpListener](http-listener.md#httplistener) test double.

A plugin that hosts an HTTP surface registers routes and answers requests, and what its tests need to assert is that half: which paths it claimed, with which
method filters, and what its handler answers when a request arrives. This module ships the double for it - a [TestHttpListener](#testhttplistener) that records the routes and
hands a test [TestHttpListener.deliver](#deliver) to run one through the listener's own matching rules, with no port, no kernel, and no `node:http`.

The double stands in for the listener, it does not reimplement a server. What it mirrors is the observable contract a consumer branches on: the lifetime signal and
the abort reason a verb on a dead listener throws, the duplicate-path refusal, the disposal that removes only its own registration, the release of every route at
teardown, and the matching a delivery meets - an exact route ahead of the catch-all, 404 for a path nothing claims, 405 for a method a route's filter excludes.
What stays with the real class and its suite is everything the wire owns: the bounded body read and its 413, the client resets and the connection drops at
teardown, and the translation of a handler fault into a logged line and a 500. A handler that throws propagates straight out of `deliver`, because a test wants
its own fault in hand rather than a status standing in for it.

Signatures come from the listener's own exported types, imported for their types alone, so a method here cannot drift from the method it stands in for without the
compiler saying so. That type-only edge is also what keeps this module free of `node:http`: a consumer's test loads the double without loading a server.

## Testing

### TestHttpListener

A socket-free [HttpListener](http-listener.md#httplistener) double: it records what a consumer routed and answers a delivery from that table alone.

#### Example

```ts
import { TestHttpListener } from "homebridge-plugin-utils/testing";

const listener = new TestHttpListener({ port: 10110 });

// The consumer registers its routes against the double, cast at its injection site. The two classes carry private fields, so nothing structural assigns one to
// the other and the cast is the injection point's own statement that the double stands in for the listener.
plugin.configureListener(listener as unknown as HttpListener);

// Run the registered handler by hand: no port, no wire. The answer is the one the consumer's sender would read.
assert.equal(listener.deliver("/events", { body: Buffer.from("{}"), headers: {} }).status, 200);
```

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new TestHttpListener(options?): TestHttpListener;
```

Construct a double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `port?`: `number`; `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional construction options. |
| `options.port?` | `number` | The port [TestHttpListener.boundPort](#boundport) reports while the double is live. Defaults to 0, which is what the real class reports before it has bound anything, so a test that asserts on a port passes one of its own. |
| `options.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The caller's lifetime, composed into [TestHttpListener.signal](#signal), mirroring the real class's own composition. |

###### Returns

[`TestHttpListener`](#testhttplistener)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Mirrors [HttpListener.ready](http-listener.md#ready), and marked handled as that one is. A double is bound the moment it exists, so this resolves on construction; a double built over a lifetime that had already ended rejects with that lifetime's reason, exactly as the real class does when it never gets to call `listen()`. |
| <a id="routes"></a> `routes` | `readonly` | `ReadonlyMap`\<[`HttpListenerPath`](http-listener.md#httplistenerpath), [`TestHttpListenerRoute`](#testhttplistenerroute-1)\> | The routes currently registered, keyed by exact path or by the catch-all sentinel - the wiring view a test asserts through. It is the same store [TestHttpListener.deliver](#deliver) matches against, so what a test reads and what a delivery meets cannot disagree. Registrations leave it when their handle is disposed and when the double aborts. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal representing this double's lifetime, mirroring [HttpListener.signal](http-listener.md#signal). It aborts exactly once - when [TestHttpListener.abort](#abort) is called, when the caller's signal fires, or when the double is disposed. |

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

The port this double reports as bound: the constructed one while it is live, and zero once it has aborted, which is what the real class reports once its server
has closed.

###### Returns

`number`

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation, mirroring the real class's: it aborts the double, defaulting to `"shutdown"`. There is no socket to wait on, so it resolves
once the abort has run - which is what the real class's own await amounts to by the time its server has closed.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the abort has run.

###### Implementation of

```ts
AsyncDisposable.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the double, mirroring [HttpListener.abort](http-listener.md#abort): it defaults to `HbpuAbortError("shutdown")` when no reason is
supplied, and explicit reasons pass through unchanged. Safe to call more than once. Afterwards every route is released and `route()` refuses.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. See [HbpuAbortError](util.md#hbpuaborterror). |

###### Returns

`void`

##### deliver()

```ts
deliver(
   path, 
   request, 
   method?
): HttpListenerResponse;
```

Answer one delivery from the route table, exactly as the real serve path would: an exact route takes precedence over the catch-all, a path nothing claims is a
404, and a method the matched route's filter excludes is a 405. Anything else is the matched handler's own answer, and a handler that throws propagates out of
this call rather than becoming the 500 the real class logs and writes.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `path` | [`HttpListenerPath`](http-listener.md#httplistenerpath) | `undefined` | The path the delivery is addressed to. |
| `request` | [`HttpListenerRequest`](http-listener.md#httplistenerrequest) | `undefined` | The request to hand the matched handler. |
| `method` | `string` | `"POST"` | The delivery's HTTP method, compared against the matched route's filter. Defaults to `"POST"`. |

###### Returns

[`HttpListenerResponse`](http-listener.md#httplistenerresponse)

The status the consumer's sender would read, and the handler's own answer when one ran.

##### route()

```ts
route(
   path, 
   handler, 
   options?
): Disposable;
```

Register a handler for one path, mirroring [HttpListener.route](http-listener.md#route) including both of its refusals.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `path` | [`HttpListenerPath`](http-listener.md#httplistenerpath) | The path to route, or the catch-all sentinel. |
| `handler` | [`HttpListenerHandler`](http-listener.md#httplistenerhandler) | The function that answers requests to that path. |
| `options` | [`HttpListenerRouteOptions`](http-listener.md#httplistenerrouteoptions) | Optional per-route options. |

###### Returns

[`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

A handle whose disposal releases the path, removing only the registration this call made.

###### Throws

The lifetime's abort reason if the double has ended, and a `TypeError` naming the collision if the path is already routed.

***

### TestHttpListenerRoute

One recorded route, as the consumer registered it.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="handler"></a> `handler` | `readonly` | [`HttpListenerHandler`](http-listener.md#httplistenerhandler) | The handler exactly as the caller registered it, so a test can read it or run it directly. |
| <a id="methods"></a> `methods?` | `readonly` | readonly `string`[] | The method filter the route was registered with, and `undefined` for a route that accepts every method. |
