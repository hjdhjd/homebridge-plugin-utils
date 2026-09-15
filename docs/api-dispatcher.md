[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / api-dispatcher

# api-dispatcher

A pooled HTTP dispatcher carrying vetted defaults for talking to a cloud API or a local gateway.

A plugin that talks to an HTTP API needs a connection pool, a retry policy for the statuses and faults worth retrying, and a user-agent on every request. None of
that is interesting work, all of it is the same work each time, and the copies drift in ways nobody notices until one of them misbehaves: a status list that has to
be kept in step by hand with the classification the plugin messages from, a keepalive that outlives the gateway reboot it was holding a socket through, a retry
curve tuned once and never revisited. This module owns that construction, so the interesting part - what a given API's statuses mean, and what the plugin does
about them - is all that is left to write.

The retry status list is exported rather than merely applied, because two questions are the same list and drift the moment they are written down twice: what the
transport retries, and which statuses a plugin then describes as transient when the retries run out. [API\_RETRY\_STATUS\_CODES](#api_retry_status_codes) is the one declaration both
read.

Construction costs nothing on the wire. The pool connects lazily, on the first request through it, so a dispatcher may be built during startup without any host
being reachable yet.

Teardown has an upper bound rather than an instant. Abort your in-flight signals first, then destroy the dispatcher. A retry backoff pending at that moment is a
plain timer the retry interceptor owns, so a request waiting on one settles against the destroyed pool - as an error whose code is `UND_ERR_DESTROYED` - no later
than when that backoff elapses, and sooner when the destroy interrupts the exchange before a backoff is even scheduled. The linger is therefore bounded by the
configured `maxTimeout`, which is the number to size a shutdown budget against.

## Utilities

### ApiDispatcherOptions

Construction options for [createApiDispatcher](#createapidispatcher), and for the derivations behind it.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="allowh2"></a> `allowH2?` | `boolean` | Whether to offer HTTP/2 during connection negotiation. Defaults to `true`; a server that does not speak it simply stays on HTTP/1.1. |
| <a id="clientttl"></a> `clientTtl?` | `number` \| `null` | How long, in milliseconds, a pooled connection may live before it is recycled. Defaults to `60000`, which bounds how long a keepalive socket to a host that has since rebooted can linger. Pass `null` to disable recycling entirely, which is what a plugin holding long-lived connections to a local gateway wants. |
| <a id="connections"></a> `connections?` | `number` | How many connections the pool may open to the origin. Defaults to `1`, which is what an API client issuing one request at a time needs. |
| <a id="origin"></a> `origin` | `string` \| `URL` | The origin every request through this dispatcher is sent to. |
| <a id="rejectunauthorized"></a> `rejectUnauthorized?` | `boolean` | Whether to require a valid TLS certificate chain. Defaults to `true`. Relaxing it is occasionally the only way to reach a device shipping a certificate it generated for itself, and a plugin that does relax it owns that decision. |
| <a id="retry"></a> `retry?` | `false` \| `RetryOptions` | The retry policy. Defaults to `{ maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, statusCodes: API_RETRY_STATUS_CODES, timeoutFactor: 2 }`. An object supplied here merges OVER those defaults field by field, so overriding `maxRetries` alone keeps the vetted status list. Pass `false` to compose no retry interceptor at all, which is what a protocol that answers with a retryable-looking status to MEAN something - a 503 that says "not ready yet" rather than "try again" - needs, since a retry would swallow the answer. **Remarks** These fields are the whole of what this module sets. Every other member of the transport's retry vocabulary keeps the transport's own default, including the list of methods eligible for retry and the connection-fault `errorCodes` axis, which means resets, refusals, and unresolvable names are retried underneath this policy whether or not any status is. |
| <a id="useragent"></a> `userAgent` | `string` | The user-agent stamped onto every request this dispatcher sends. |

***

### API\_RETRY\_STATUS\_CODES

```ts
const API_RETRY_STATUS_CODES: readonly number[];
```

The statuses a dispatcher from this module retries: `[ 400, 404, 429, 500, 502, 503, 504 ]`, frozen so the `readonly` type is enforced rather than advised.

A plugin that tells a user "the request kept failing on a transient error" derives THAT set of statuses from this list instead of restating it, which is the one
place where what the transport retries and what the plugin then says about it are the same question. Every other status-to-message decision belongs to the plugin,
whose protocol it is.

#### Remarks

This is a deliberate widening of the transport's own retry defaults, which cover 429, 500, 502, 503, and 504 alone. Real APIs answer well-formed requests
with a transient 400 or 404 while a device is rebooting or a backend is under load, and treating either as permanent gives up on a request that would have succeeded
a second later.

***

### apiPoolOptions()

```ts
function apiPoolOptions(options): Options;
```

Derive the pool construction options from [ApiDispatcherOptions](#apidispatcheroptions), applying every default.

Exported because it is the testable core of [createApiDispatcher](#createapidispatcher) and because a plugin that needs a pool option this module does not surface can start from
the vetted base rather than from nothing.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`ApiDispatcherOptions`](#apidispatcheroptions) | See [ApiDispatcherOptions](#apidispatcheroptions). |

#### Returns

`Options`

The pool options, carrying a `connect` entry only when the TLS check is being relaxed.

***

### apiRetryOptions()

```ts
function apiRetryOptions(retry): RetryOptions | undefined;
```

Derive the retry policy from the `retry` option, merging anything supplied over the defaults.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `retry` | `false` \| `RetryOptions` \| `undefined` | The `retry` option as written by the caller: an object to merge, `false` to opt out, or `undefined` to take the defaults whole. |

#### Returns

`RetryOptions` \| `undefined`

The retry options to hand the interceptor, or `undefined` when no retry interceptor should be composed at all.

***

### createApiDispatcher()

```ts
function createApiDispatcher(options): Dispatcher;
```

Build a pooled dispatcher for an HTTP API, with retries and a user-agent already composed in.

The dispatcher is returned, not installed: a plugin holds it in a field, hands it to its own client, or installs it globally, as it prefers. Its lifetime is the
plugin's too - it is an ordinary transport dispatcher, so `destroy()` goes on whatever teardown stack the plugin already keeps, and rebuilding a wedged one is
another call to this function.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`ApiDispatcherOptions`](#apidispatcheroptions) | See [ApiDispatcherOptions](#apidispatcheroptions). |

#### Returns

`Dispatcher`

The composed dispatcher.

#### Example

```ts
import { createApiDispatcher } from "homebridge-plugin-utils";

// Retries and the user-agent are already in place; nothing connects until the first request.
const dispatcher = createApiDispatcher({ origin: "https://api.example.com", userAgent: "my-plugin/1.0" });

const response = await request("https://api.example.com/devices", { dispatcher, signal: this.signal });
```

***

### headerStampInterceptor()

```ts
function headerStampInterceptor(name, value): DispatcherComposeInterceptor;
```

Build an interceptor that stamps one header onto every request dispatched through it.

The mechanism is separate from any policy about which header to stamp: [createApiDispatcher](#createapidispatcher) composes this with `"user-agent"`, and a plugin needing some
other per-request stamp - an API key, a correlation id - composes the same primitive with its own name and value.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The header name. Matched case-insensitively against whatever the request already carries, and any existing spelling of it is replaced. |
| `value` | `string` | The header value. |

#### Returns

`DispatcherComposeInterceptor`

An interceptor, ready to pass to a dispatcher's `compose`.
