[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / mqttClient

# mqttClient

AsyncDisposable MQTT client whose connection lifetime is a composed [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal).

The client wraps the underlying MQTT.js connection in the same lifetime shape every other long-lived resource class in this library uses: a composed
`AbortSignal`, a single `abort()` verb, and `Symbol.asyncDispose` for scope-bound ownership. Per-subscription and per-publish signals compose into the connection-
level signal so that tearing down a specific handler or cancelling a single publish unwinds cleanly without touching the rest of the client.

Non-abort transient disconnects continue to trigger MQTT.js's own auto-reconnect - `abort()` is specifically "this client is done for good," not "pause until
further notice." Calling `abort()` (or letting a parent signal fire) ends the connection permanently via `mqtt.end(true)`, rejects any pending publishes with the
signal's reason, clears all subscription state, and makes every subsequent call a no-op.

Construction fails loudly on invalid broker URLs: the constructor throws with the underlying mqtt.js error attached as `cause`, so a misconfigured plugin cannot
silently sit in a zombie state where every call either pretends to succeed or throws an unrelated abort error. Callers who want graceful degradation wrap the
`new MqttClient(...)` call in their own try/catch.

## Utilities

### MqttClient

Signal-driven MQTT client with automatic topic-prefix management, composed connection lifetime, and per-operation signal support.

#### Example

```ts
import { MqttClient } from "homebridge-plugin-utils";

await using mqtt = new MqttClient({ brokerUrl: "mqtt://localhost:1883", log, topicPrefix: "homebridge" }, { signal: platform.signal });

// A subscription that auto-unsubscribes on the per-feature signal.
const feature = new AbortController();

mqtt.subscribe("device1/status", (payload) => log.info("Status: %s.", payload.toString()), { signal: feature.signal });

// Abort-aware publish.
await mqtt.publish("device1/status", "on");
```

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new MqttClient(config, init?): MqttClient;
```

Construct and start a new MQTT client.

Connection is initiated synchronously as part of construction; there is no separate `connect()` step. A synchronous failure from mqtt.js (typically an invalid
broker URL) surfaces as an `Error` wrapping the underlying cause, so a misconfigured plugin fails loudly instead of living in a zombie state. Network-level
failures (an unreachable broker reachable by a valid URL) do not throw - they surface asynchronously through the client's `error` event, are logged, and trigger
mqtt.js's built-in auto-reconnect until [MqttClient.abort](#abort) or a parent signal ends the client for good. A pre-aborted parent signal still constructs
a client (so `#mqtt` stays non-null) and then immediately runs the regular teardown path.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config` | [`MqttConfig`](#mqttconfig) | Static broker / topic configuration. See [MqttConfig](#mqttconfig). |
| `init` | [`MqttClientInit`](#mqttclientinit) | Optional init options. See [MqttClientInit](#mqttclientinit). |

###### Returns

[`MqttClient`](#mqttclient)

###### Throws

`Error` (with the underlying mqtt.js error attached as `cause`) when mqtt.js's `connect()` fails synchronously.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The composed abort signal representing this client's lifetime. Aborts exactly once when [MqttClient.abort](#abort) is called or when the parent signal fires. |

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

`AsyncDisposable` implementation. Aborts the client (defaulting to `"shutdown"`), which tears the MQTT connection down and rejects any pending publishes through
the regular teardown path.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once teardown has been scheduled. MQTT.js's `end(true)` completes synchronously for userland purposes, so the awaited microtask
         is all the ordering the caller needs.

###### Implementation of

```ts
AsyncDisposable.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the client and tear the connection down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once. After this runs, every subsequent `publish`, `subscribe*`, or `unsubscribe` call is a no-op.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. Typically an [HbpuAbortError](util.md#hbpuaborterror); platform errors also interoperate by convention. |

###### Returns

`void`

##### publish()

```ts
publish(
   topic, 
   payload, 
init?): Promise<void>;
```

Publish `payload` to `topic`, returning a promise that resolves when the broker acknowledges the publish, or rejects on failure or abort.

The topic is prefixed with the configured [MqttConfig.topicPrefix](#topicprefix) before being sent; callers supply the topic tail (for example, `"device1/status"`).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail) to publish to. |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload to publish. Buffers and strings are passed through unchanged. |
| `init` | [`MqttPublishInit`](#mqttpublishinit) | Optional per-publish options. See [MqttPublishInit](#mqttpublishinit). |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the broker acknowledges, or rejects on error or abort.

##### subscribe()

```ts
subscribe(
   topic, 
   handler, 
   init?): void;
```

Subscribe to `topic` with the given handler. The topic is prefixed with the configured [MqttConfig.topicPrefix](#topicprefix) before being registered with the broker.
Multiple handlers may subscribe to the same topic; each gets independent delivery.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail) to subscribe to. |
| `handler` | [`MqttHandler`](#mqtthandler) | Callback invoked with each received payload. |
| `init` | [`MqttSubscribeInit`](#mqttsubscribeinit) | Optional per-subscription options. See [MqttSubscribeInit](#mqttsubscribeinit). |

###### Returns

`void`

##### subscribeGet()

```ts
subscribeGet(
   topic, 
   type, 
   getValue, 
   init?): void;
```

Subscribe to the `/get` child of `topic`. When a `"true"` message arrives on the get topic, the provided `getValue` callback runs and its return value is
published back on the parent topic. The classic HomeKit "get" pattern, wrapped once.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail); the `/get` suffix is appended automatically. |
| `type` | `string` | Human-readable label used in log messages (for example, `"Temperature"`). |
| `getValue` | [`MqttGetHandler`](#mqttgethandler) | Callback returning the current value as a string, invoked on each incoming `"true"` message. |
| `init` | [`MqttSubscribeInit`](#mqttsubscribeinit) | Optional per-subscription options. See [MqttSubscribeInit](#mqttsubscribeinit). |

###### Returns

`void`

##### subscribeSet()

```ts
subscribeSet(
   topic, 
   type, 
   setValue, 
   init?): void;
```

Subscribe to the `/set` child of `topic`. Each incoming message invokes `setValue` with the lowercased normalized value, the raw message string, and an
[AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) that composes the connection-level signal with the optional per-invocation `timeout`. Signal-aware setters forward that signal to cancellation-
capable APIs so the setter's work actually stops when the timeout elapses or the client aborts; signal-unaware setters continue to run but the subscription slot
is released either way, so a hanging setter cannot tie up the slot indefinitely.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail); the `/set` suffix is appended automatically. |
| `type` | `string` | Human-readable label used in log messages. |
| `setValue` | [`MqttSetHandler`](#mqttsethandler) | Callback invoked with each received value. Receives three arguments: `(value, rawValue, signal)`. See [MqttSetHandler](#mqttsethandler). |
| `init` | [`MqttSubscribeSetInit`](#mqttsubscribesetinit) | Optional per-subscription options including a handler-invocation `timeout`. See [MqttSubscribeSetInit](#mqttsubscribesetinit). |

###### Returns

`void`

##### unsubscribe()

```ts
unsubscribe(id, topic): void;
```

Unsubscribe all handlers for the specified `(id, topic)` tuple. Reconstructs the topic using the configured [MqttConfig.topicPrefix](#topicprefix), removes the
subscription from the internal map, and issues the wire-level unsubscribe. Preserved as a separate imperative verb for the mid-session feature-toggle pattern
where the caller has the `(id, topic)` tuple but never retained a dedicated controller.

Deliberately does not accept a `{ signal }` option: unsubscribe is synchronous and has nothing to cancel, and exposing a vestigial signal would suggest a
cancellation semantic the method cannot deliver. Callers composing teardown through a signal remove handlers by aborting the per-subscription signal they passed
to `subscribe*` instead.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier portion of the topic. An empty string short-circuits the whole call. |
| `topic` | `string` | The topic tail relative to the id. |

###### Returns

`void`

***

### MqttBrokerErrorResult

Result of routing a transport-level MQTT error through [routeMqttBrokerError](#routemqttbrokererror). Returned to the caller so the wiring layer (the `client.on("error", ...)`
handler in [MqttClient](#mqttclient)) can apply the side effect on its own state. Keeping the routing pure - logging plus a flag - lets the routing logic be tested in
isolation against synthetic error inputs, without standing up a broker or injecting events into the underlying mqtt.js client.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="endtransport"></a> `endTransport` | `boolean` | `true` when the error code requires forcibly ending the underlying transport (the mqtt.js client should not attempt reconnect). Mirrors the architectural rule that ENOTFOUND is the one transport error reconnect cannot recover from. |

***

### MqttClientInit

Construction-time options for [MqttClient](#mqttclient).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="signal-1"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional parent [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) composed with the client's internal controller. When the parent aborts, the MQTT connection ends permanently. |

***

### MqttConfig

Static configuration for an [MqttClient](#mqttclient). Captures the broker connection parameters and the topic-prefix convention the client applies to every topic it
touches.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="brokerurl"></a> `brokerUrl` | `string` | The MQTT broker URL (for example, `"mqtt://localhost:1883"`). |
| <a id="log"></a> `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Logger used for connection and publish/subscribe tracing. |
| <a id="reconnectinterval"></a> `reconnectInterval?` | `number` | Seconds to wait between transient reconnect attempts. Defaults to 60. |
| <a id="topicprefix"></a> `topicPrefix` | `string` | Prefix prepended to every topic the client publishes or subscribes to. The caller is responsible for the remaining path structure; this class never reinterprets the topic beyond concatenation. |

***

### MqttPublishInit

Per-publish options accepted by [MqttClient.publish](#publish).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="signal-2"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). When it aborts before the broker acknowledges the publish, the returned promise rejects with `signal.reason`. Composes with the connection-level signal. |

***

### MqttSubscribeInit

Per-subscription options accepted by [MqttClient.subscribe](#subscribe), [MqttClient.subscribeGet](#subscribeget), and [MqttClient.subscribeSet](#subscribeset).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="signal-3"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). When it aborts, the specific handler is removed and (if it was the last handler on the topic) the underlying MQTT subscription is dropped. Composes with the connection-level signal: a client-level abort removes every handler regardless of per-subscription state. |

***

### MqttSubscribeSetInit

Per-subscription options accepted by [MqttClient.subscribeSet](#subscribeset).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="signal-4"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) that auto-unsubscribes this handler. See [MqttSubscribeInit](#mqttsubscribeinit). |
| <a id="timeout"></a> `timeout?` | `number` | Optional timeout, in milliseconds, applied to each invocation of the user-supplied setter. When the setter takes longer than this, the invocation is cancelled and a warning is logged. Omit for no timeout - the setter still unwinds if the connection-level signal aborts, via [runWithAbort](util.md#runwithabort). |

***

### GetterPublishOutcome

```ts
type GetterPublishOutcome = 
  | {
  ok: true;
}
  | {
  error: unknown;
  ok: false;
};
```

Outcome of a getter-driven response publish issued by [MqttClient.subscribeGet](#subscribeget). Discriminated union: `ok: true` after a successful publish, `ok: false` with
the captured error after a failure. Passed to [logGetterPublishOutcome](#loggetterpublishoutcome) so the routing logic between the success and failure log lines is testable in
isolation against synthetic outcomes - the same architectural pattern [routeMqttBrokerError](#routemqttbrokererror) uses for transport-error log routing.

***

### MqttGetHandler

```ts
type MqttGetHandler = () => string;
```

A handler invoked by [MqttClient.subscribeGet](#subscribeget) when a "true" message arrives on the `/get` topic. Returns the current value as a string that will be published
on the parent topic as the response.

#### Returns

`string`

***

### MqttHandler

```ts
type MqttHandler = (payload) => 
  | Promise<void>
  | void;
```

A handler for raw MQTT messages delivered on a subscribed topic.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `payload` | `Buffer` | The message payload as received from the broker. |

#### Returns

  \| [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>
  \| `void`

***

### MqttSetHandler

```ts
type MqttSetHandler = (value, rawValue, signal) => 
  | Promise<void>
  | void;
```

A handler invoked by [MqttClient.subscribeSet](#subscribeset) when a value is received on the `/set` topic.

Receives three arguments:

- `value`    - the lowercased normalized form, convenient for comparisons against fixtures like `"true"` / `"on"`.
- `rawValue` - the raw message string, for cases where case or surrounding whitespace matters.
- `signal`   - an [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) that aborts when the subscription's connection-level signal fires or (if configured) the per-invocation timeout elapses.
               Signal-aware setters forward this to any cancellation-capable API they call (`fetch`, `events.once`, `node:timers/promises`, etc.) so the setter's work
               actually stops when the wrapper times out. Setters that ignore the signal continue to run after timeout, but the subscription slot is released either
               way; nothing is structurally blocked by a hanging setter.

**Log-routing contract.** How the setter settles determines which log line `subscribeSet` emits:

- **Return normally** (work completed successfully) - logs INFO `"MQTT: set message received for X: value."`.
- **Throw a non-abort error** (work failed for a reason unrelated to cancellation) - logs ERROR `"MQTT: error setting X to value: message."`.
- **Throw while the composed signal is already aborted** (the connection-level abort or the per-invocation timeout, whichever fired first) - logs WARN
  `"MQTT: set handler for X was cancelled before completion."`, regardless of what value is thrown. A setter that catches its own abort and returns normally
  is indistinguishable to the wrapper from a successful completion, which is why a signal-aware setter that wants cancellation reflected in the log stream
  should rethrow once it observes the signal has aborted, rather than swallow it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `rawValue` | `string` |
| `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) |

#### Returns

  \| [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>
  \| `void`

***

### logGetterPublishOutcome()

```ts
function logGetterPublishOutcome(
   log, 
   type, 
   outcome): void;
```

Route the outcome of a `subscribeGet` response publish to the appropriate log line. Pure function: no class state, no mqtt.js handles, no closure over the live
client. The wiring in [MqttClient.subscribeGet](#subscribeget) forwards each `.then` / `.catch` settlement here, and tests cover both branches by calling the function
directly with synthetic `{ ok: true }` and `{ ok: false, error: ... }` outcomes - bypassing the real-broker substrate where a forced QoS-0 publish failure would
require contrived socket-level setup that is not worth the test-architecture complexity.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Logger that receives the routed message. |
| `type` | `string` | Human-readable label (the `type` argument the caller passed to `subscribeGet`). |
| `outcome` | [`GetterPublishOutcome`](#getterpublishoutcome) | The publish outcome. See [GetterPublishOutcome](#getterpublishoutcome). |

#### Returns

`void`

***

### routeMqttBrokerError()

```ts
function routeMqttBrokerError(
   error, 
   log, 
   reconnectInterval): MqttBrokerErrorResult;
```

Route a transport-level MQTT error to the appropriate log line and signal whether the underlying transport should be ended. Pure function: no class state, no
mqtt.js handles, no closure over the live client. The wiring layer in [MqttClient](#mqttclient) forwards every `client.on("error", ...)` invocation through here and acts
on the returned `endTransport` flag.

The routing paths mirror the transport-error categories HBPU distinguishes:

- `ECONNREFUSED` - the broker host is up but no listener accepts the connection. Recoverable; auto-reconnect handles it.
- `ECONNRESET`   - the broker accepted then dropped the connection. Recoverable; auto-reconnect handles it.
- `ENOTFOUND`    - DNS could not resolve the broker hostname. Non-recoverable - retrying the same hostname will keep failing - so we end the transport permanently
                   and emit a standalone log line without the retry-cadence suffix.
- default        - any other error code (or none). Logged through the retry-cadence formatter with `util.inspect` of the error, so a future mqtt.js error code we
                   did not anticipate still surfaces in the log stream rather than being silently swallowed.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `ErrnoException` | The error event payload from the underlying mqtt.js client. |
| `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Logger used to emit the routed message. |
| `reconnectInterval` | `number` | Configured reconnect interval (in seconds) used to format the retry-cadence suffix. |

#### Returns

[`MqttBrokerErrorResult`](#mqttbrokererrorresult)

A [MqttBrokerErrorResult](#mqttbrokererrorresult) indicating whether the wiring layer should end the transport.
