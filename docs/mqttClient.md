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

A publish issued while the client is not connected to the broker rejects at once with [MqttOfflineError](mqtt-publish.md#mqttofflineerror) and is never queued, so nothing is retained during
an outage and nothing replays after it, and [MqttClient.connected](#connected) answers the same question a consumer can ask for itself before it publishes. See
[MqttConfig.reconnectInterval](#reconnectinterval) for the setting that leaves automatic reconnection disabled entirely.

For a state topic a plugin re-derives on a schedule, the `ifChanged` option on [MqttPublishInit](#mqttpublishinit) publishes only when the payload moved, remembering per
topic what the broker last acknowledged for the life of a session.

The module offers two construction postures. Direct construction fails loudly on an invalid broker URL: the constructor throws with the underlying mqtt.js error
attached as `cause`, so a misconfigured plugin cannot silently sit in a zombie state where every call either pretends to succeed or throws an unrelated abort
error. [createMqttClient](#createmqttclient) is the graceful path, answering `null` for an unconfigured broker and for a construction failure alike, so a mistyped MQTT entry
degrades to "MQTT is off" instead of blocking plugin load.

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

##### connected

###### Get Signature

```ts
get connected(): boolean;
```

`true` while the client holds a live session with the broker. Two readings compose into it: mqtt.js's own `connected` flag - set when the broker's CONNACK
arrives, cleared when the connection closes, and the same flag its send path consults - and this client's lifetime signal, which is what makes the answer
`false` from the instant [MqttClient.abort](#abort) runs even though mqtt.js clears its flag only when the socket's close event lands a turn or two later.
Composing them keeps this getter and [MqttClient.aborted](#aborted) in agreement at every instant. Derived from both; no field of its own.

This is the reading [MqttClient.publish](#publish) takes before it hands anything to mqtt.js, so a consumer that would rather not attempt a publish it knows will
be refused asks the same question here first.

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
   init?
): Promise<void>;
```

Publish `payload` to `topic`, returning a promise that resolves when the broker acknowledges the publish, or rejects on failure, on abort, or because there is
no broker session to carry it.

The topic is prefixed with the configured [MqttConfig.topicPrefix](#topicprefix) before being sent; callers supply the topic tail (for example, `"device1/status"`).

A publish issued while [MqttClient.connected](#connected) reads `false` is refused on the spot rather than held for delivery once the broker returns, so nothing is
retained during an outage and nothing replays after it. See [MqttOfflineError](mqtt-publish.md#mqttofflineerror) for the reasoning.

With `ifChanged` set on [MqttPublishInit](#mqttpublishinit), the publish goes out only when the payload differs from the last one the broker acknowledged for a change-gated
publish on that topic. The gate answers after the abort check and the placeholder refusal and before the trace and the offline refusal, so a torn-down client
keeps rejecting with its own reason, an unchanged payload during an outage resolves rather than being refused, and a suppressed publish leaves no line in the
log, since nothing was attempted. The memory takes a payload only once the broker has acknowledged it, so a refused, failed, or cancelled publish leaves the
next attempt free to go out, and it is cleared on every connect and at teardown, which is what makes the first change-gated publish after an outage always go
out: a subscriber that missed a change while the broker was away hears the current value on the next pass. Only a change-gated publish is weighed against the
memory or written into it, so a publish without the option on the same topic neither reads nor updates it, and a [MqttClient.subscribeGet](#subscribeget) republish
stays a plain restatement. The boundary is state, never events: an event's payload repeating is the event happening again - a second ring on a doorbell topic,
a second detection on a motion topic - and the gate would swallow it. The comparison is
[MqttLastPayloads](mqtt-publish.md#mqttlastpayloads)'s rule: strings by value, Buffers by their bytes, a string never the same as a Buffer, and a remembered
Buffer copied. The promise reads as "ensure the broker has this value" - it resolves whether the payload just went out or the broker already had it, and rejects
only as an attempted publish does.

A tail still carrying a brace is refused through [assertResolvedMqttTopic](mqtt-topics.md#assertresolvedmqtttopic), after the abort check and before
anything else, so an unresolved placeholder never reaches the broker.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail) to publish to. |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload to publish. Buffers and strings are passed through unchanged. |
| `init` | [`MqttPublishInit`](#mqttpublishinit) | Optional per-publish options. See [MqttPublishInit](#mqttpublishinit). |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the broker acknowledges - or at once, with nothing sent, when `ifChanged` finds the payload unchanged - rejects with
         [MqttOfflineError](mqtt-publish.md#mqttofflineerror) when the client is not connected to the broker, and otherwise rejects with the abort reason or the underlying error.

##### publishGuarded()

```ts
publishGuarded(
   topic, 
   payload, 
   init?
): void;
```

Publish `payload` to `topic` without waiting for the outcome. The fire-and-forget counterpart to [publish](#publish), for state fan-out where the caller has nothing
to do with an acknowledgement and no way to answer a failure: it returns nothing, never throws, and never rejects, so a delivery failure lands in the client's
log instead of floating as an unhandled rejection.

Every outcome resolves to exactly one line, all of them naming the expanded topic. A genuine failure is reported at error level with the underlying reason. A
cancellation - the client tearing down, or a device-scoped signal firing as its accessory is disposed - is the lifecycle working as intended and drops to a
debug line. A publish refused because the client holds no broker session drops to a debug line of its own, since the outage behind it is already reported at
error level by the broker error line. [routeGuardedPublishFailure](mqtt-publish.md#routeguardedpublishfailure) owns the classification and the reasoning behind the order it reads those terms in.

`init` passes through to [publish](#publish) unchanged, which is what lets a per-publish signal cancel this one publish quietly while the connection carries on,
and what lets a change-gated publish suppress itself just as quietly when the broker already has the payload.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail) to publish to. |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload to publish. Buffers and strings are passed through unchanged. |
| `init` | [`MqttPublishInit`](#mqttpublishinit) | Optional per-publish options. See [MqttPublishInit](#mqttpublishinit). |

###### Returns

`void`

##### subscribe()

```ts
subscribe(
   topic, 
   handler, 
   init?
): void;
```

Subscribe to `topic` with the given handler. The topic is prefixed with the configured [MqttConfig.topicPrefix](#topicprefix) before being registered with the broker.
Multiple handlers may subscribe to the same topic; each gets independent delivery. A tail still carrying a brace is refused through
[assertResolvedMqttTopic](mqtt-topics.md#assertresolvedmqtttopic), after the aborted short-circuit, so an unresolved placeholder never becomes a
subscription.

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
   init?
): void;
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
   init?
): void;
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

A tail still carrying a brace is refused through [assertResolvedMqttTopic](mqtt-topics.md#assertresolvedmqtttopic), after the aborted and empty-id guards, so
both of those stay the no-ops documented above.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier portion of the topic. An empty string short-circuits the whole call. |
| `topic` | `string` | The topic tail relative to the id. |

###### Returns

`void`

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
| <a id="reconnectinterval"></a> `reconnectInterval?` | `number` | Seconds to wait between transient reconnect attempts. Defaults to 60. Automatic reconnection is armed only for a positive value: 0, a negative value, or a value that is not a number leaves it disabled, and the client then stays disconnected after its first transport failure until it is aborted, refusing every publish with [MqttOfflineError](mqtt-publish.md#mqttofflineerror). |
| <a id="topicprefix"></a> `topicPrefix` | `string` | Prefix prepended to every topic the client publishes or subscribes to. The caller is responsible for the remaining path structure; this class never reinterprets the topic beyond concatenation. |

***

### MqttPublishInit

Per-publish options accepted by [MqttClient.publish](#publish) and [MqttClient.publishGuarded](#publishguarded).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ifchanged"></a> `ifChanged?` | `boolean` | Optional. When `true`, the publish goes out only when `payload` differs from the last payload this client delivered on `topic` through a publish that also asked for it, and otherwise resolves at once with nothing sent. For a state topic whose value a plugin re-derives on a schedule, never for an event. The memory's rules are stated on [MqttClient.publish](#publish). |
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

### MqttClientConfigCandidate

```ts
type MqttClientConfigCandidate = Omit<MqttConfig, "brokerUrl" | "topicPrefix"> & {
  brokerUrl?: Nullable<string>;
  topicPrefix?: Nullable<string>;
};
```

The configuration [createMqttClient](#createmqttclient) accepts: an [MqttConfig](#mqttconfig) whose broker URL and topic prefix may be absent or `null`, exactly as the feature-option
engine reports them. `FeatureOptions.value()` answers `null` for an option that is unconfigured or explicitly disabled, so a caller hands both resolved values
straight through and narrows nothing at the call site.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `brokerUrl?` | [`Nullable`](util.md#nullable)\<`string`\> |
| `topicPrefix?` | [`Nullable`](util.md#nullable)\<`string`\> |

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

### createMqttClient()

```ts
function createMqttClient(config, init?): Nullable<MqttClient>;
```

Construct an [MqttClient](#mqttclient) when the configuration supports one, and answer `null` when it does not. This is the graceful counterpart to direct construction:
where `new MqttClient(...)` throws on an unusable broker URL, this degrades, because a mistyped MQTT entry must never keep a plugin from loading.

`null` is the entire construction-failure vocabulary, and it covers two situations the caller does not have to tell apart:

- **MQTT is off.** The broker URL or the topic prefix is absent, `null`, or empty - the ordinary state of a plugin whose user never configured MQTT, or who
  switched it back off. Nothing is logged, because a feature being off is not an event.
- **Construction failed.** The broker URL is present but unusable. The failure is logged once at error level, with the broker URL excised from the inspected
  error chain through [redactKnownBrokerUrl](#redactknownbrokerurl), since that chain embeds the configured URL verbatim.

The guard covers construction and nothing beyond it. Signal semantics stay the caller's, identical to direct construction: a pre-aborted `init.signal` yields a
constructed client that has already ended, not a `null`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config` | [`MqttClientConfigCandidate`](#mqttclientconfigcandidate) | Broker / topic configuration, both resolved option values passed through as-is. See [MqttClientConfigCandidate](#mqttclientconfigcandidate). |
| `init?` | [`MqttClientInit`](#mqttclientinit) | Optional init options, forwarded to the constructor unchanged. See [MqttClientInit](#mqttclientinit). |

#### Returns

[`Nullable`](util.md#nullable)\<[`MqttClient`](#mqttclient)\>

A live [MqttClient](#mqttclient), or `null` when MQTT is unconfigured or construction failed. Never throws.

#### Example

```ts
import { createMqttClient, mqttConnectionSettings } from "homebridge-plugin-utils";

const settings = mqttConnectionSettings({ controller: mac, featureOptions });

this.mqtt ??= settings && createMqttClient({ ...settings, log }, { signal: platform.signal });
```

***

### logGetterPublishOutcome()

```ts
function logGetterPublishOutcome(
   log, 
   type, 
   outcome
): void;
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

### redactBrokerUrl()

```ts
function redactBrokerUrl(brokerUrl): string;
```

Redact the credentials out of a broker URL so it is safe to put in a log line. The platform's own `URL` parser is the single source of URL-grammar truth here:
what counts as a password is whatever the parser says it is, rather than whatever a hand-authored expression can be talked into matching.

Three outcomes, in the order the function decides them:

- A URL that parses and carries a password comes back with the password replaced by `REDACTED`. Re-serializing through `href` canonicalizes the WHATWG-special
  schemes - `ws` and `wss` drop a default port, gain a trailing slash on an empty path, and lowercase their host - so the log shows the canonical redacted form
  for those two schemes. The mqtt-family schemes are non-special and round-trip byte for byte.
- A URL that parses and carries no password comes back verbatim, never re-serialized at all. This is the common case, and it pays for nothing beyond the parse.
- A string the parser rejects comes back as a fixed placeholder. Unparseable means unclassifiable...a string we cannot take apart is one whose credential we
  cannot locate, and a placeholder cannot leak what it does not carry.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `brokerUrl` | `string` | The broker URL as configured. |

#### Returns

`string`

The URL with any password excised, the input verbatim when there is no password to excise, or a placeholder when the input does not parse.

***

### redactKnownBrokerUrl()

```ts
function redactKnownBrokerUrl(text, brokerUrl): string;
```

Excise every occurrence of a known broker URL from arbitrary text, replacing each with that URL's redacted form. An inspected error chain embeds the configured
URL verbatim, so excising the exact string we already hold is complete for that leak - there is nothing to discover in the text, only something to remove from it.

Split-and-join rather than a string-valued `replaceAll`, because JavaScript interprets `$`-sequences inside a string replacement: a URL whose username contains
`$&` would make the replacement re-inject the original credentialed URL, the precise opposite of the intent. Splitting on the literal and joining with the
redacted form gives the substring no interpretation at all, and it covers however many occurrences appear.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `text` | `string` | The text to scrub, typically an inspected error chain. |
| `brokerUrl` | `string` | The broker URL to excise. Its redacted form is what replaces each occurrence. |

#### Returns

`string`

The text with every occurrence of `brokerUrl` replaced by its redacted form. Text that never mentions the URL comes back unchanged.

***

### routeMqttBrokerError()

```ts
function routeMqttBrokerError(
   error, 
   log, 
   reconnectInterval
): void;
```

Route a transport-level MQTT error to the appropriate log line. Pure function: no class state, no mqtt.js handles, no closure over the live client. The wiring layer
in [MqttClient](#mqttclient) forwards every `client.on("error", ...)` invocation through here, and mqtt.js's own reconnect policy keeps control of the transport, so every
error resolves to a log line and nothing else.

The routing paths mirror the transport-error categories HBPU distinguishes:

- `ECONNREFUSED` - the broker host is up but no listener accepts the connection. Auto-reconnect handles it.
- `ECONNRESET`   - the broker accepted then dropped the connection. Auto-reconnect handles it.
- `ENOTFOUND`    - DNS could not resolve the broker hostname. Retried like every other transport error, because a lookup fails for reasons that clear on their own:
                   a resolver that is not up yet at boot, or a name that resolves only once the device answering to it appears.
- default        - any other error code (or none). Logged with `util.inspect` of the error, so a future mqtt.js error code we did not anticipate still surfaces in
                   the log stream rather than being silently swallowed.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `ErrnoException` | The error event payload from the underlying mqtt.js client. |
| `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Logger used to emit the routed message. |
| `reconnectInterval` | `number` | Configured reconnect interval (in seconds) used to render the cadence sentence. See [MqttConfig.reconnectInterval](#reconnectinterval) for the values that leave automatic reconnection disabled. |

#### Returns

`void`

## Feature Options

### MqttConfigProperties

The MQTT properties a plugin's own configuration block may carry: the broker URL and the topic prefix, as they were spelled before the feature options took the
settings over. [mqttConnectionSettings](#mqttconnectionsettings-1) reads them as the transition fallback for an identity no configured option answers for, so a configuration nobody
has opened the webUI on keeps resolving exactly what it always resolved. A plugin whose transition has ended carries neither property and omits `config`
altogether; a plugin that still declares one documents its own sunset, since when the property stops being read is the plugin's decision rather than this
library's.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="mqtttopic"></a> `mqttTopic?` | `string` | Optional. The topic prefix the plugin's configuration block carries. An empty string is read as no topic at all. |
| <a id="mqtturl"></a> `mqttUrl?` | `string` | Optional. The broker URL the plugin's configuration block carries. |

***

### MqttConnectionSettingsInput

The input [mqttConnectionSettings](#mqttconnectionsettings-1) resolves from.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="config"></a> `config?` | [`MqttConfigProperties`](#mqttconfigproperties) | Optional. The plugin's own configuration properties for this identity. See [MqttConfigProperties](#mqttconfigproperties). Omitted by a plugin that carries none. |
| <a id="controller"></a> `controller?` | `string` | Optional. The identity the options resolve at: a controller's MAC for a plugin declaring the group at controller scope, omitted for a plugin declaring it at global scope. |
| <a id="featureoptions"></a> `featureOptions` | [`FeatureOptions`](featureOptions.md#featureoptions) | The feature-option engine, over a catalog that composes the group [mqttFeatureOptions](#mqttfeatureoptions) builds. |

***

### MqttFeatureOptionsConfig

Configuration accepted by [mqttFeatureOptions](#mqttfeatureoptions). Carries the two facts that vary per plugin: the topic prefix the plugin publishes under by default, and the
scope levels the entries are configurable at.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="defaulttopic"></a> `defaultTopic` | `string` | The topic prefix used when the user has not configured one. Registered as the `Mqtt.Topic` entry's declared default value, so an unconfigured topic resolves to it through `FeatureOptions.value()` and the plugin needs no fallback of its own. |
| <a id="scopes"></a> `scopes?` | readonly \[[`FeatureOptionScope`](featureOptions.md#featureoptionscope), [`FeatureOptionScope`](featureOptions.md#featureoptionscope)\] | Optional. The levels both entries may be configured at, named in the [FeatureOptionEntry.scopes](featureOptions.md#scopes-1) vocabulary. Defaults to `["global"]`, which suits a plugin that talks to a single account or device; a plugin whose controllers each carry their own broker passes `["controller"]`. |

***

### MqttFeatureOptionsGroup

The MQTT feature-option group [mqttFeatureOptions](#mqttfeatureoptions) returns: the category and the entries belonging to it, shaped to drop straight into a plugin's own catalog.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TMeta` | `unknown` | The concrete type of the opaque meta annotation the composing plugin's catalog carries, mirroring [FeatureOptionEntry](featureOptions.md#featureoptionentry) and [FeatureCategoryEntry](featureOptions.md#featurecategoryentry) so both halves of the group speak the same channel. Defaults to `unknown`, which is what an un-parameterized call resolves to. |

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="category"></a> `category` | [`FeatureCategoryEntry`](featureOptions.md#featurecategoryentry)\<`TMeta`\> & \{ `name`: `"Mqtt"`; \} | The MQTT category entry, whose `name` is typed as the literal `"Mqtt"` rather than as `string`. See [mqttFeatureOptions](#mqttfeatureoptions) for what that buys a composing plugin. |
| <a id="options"></a> `options` | [`FeatureOptionEntry`](featureOptions.md#featureoptionentry)\<`TMeta`\>[] | The option entries belonging to the category. |

***

### MqttConnectionSettings

```ts
type MqttConnectionSettings = Pick<MqttConfig, "brokerUrl" | "topicPrefix">;
```

What [mqttConnectionSettings](#mqttconnectionsettings-1) resolves: the half of an [MqttConfig](#mqttconfig) that comes from configuration rather than from the caller, so
`createMqttClient({ ...settings, log }, init)` composes the two halves with no bridge in between.

***

### mqttConnectionSettings()

```ts
function mqttConnectionSettings(input): Nullable<MqttConnectionSettings>;
```

Resolve the broker URL and topic prefix one identity's MQTT client is constructed from, or `null` when MQTT is off for that identity.

`null` covers every way a plugin ends up with no client: no broker configured anywhere, an option the user set to off, and an option the user enabled without
giving it a value. A caller hands the result to [createMqttClient](#createmqttclient) and is done, because the answers line up with what that guard already refuses.

Both options resolve through [consolidatedValue](featureOptions.md#consolidatedvalue), the engine's one statement of the rule a configured option follows, so
this module states no precedence of its own. What that rule yields here: a configured entry answers whatever the user made of it, an untouched option yields to
the configuration property, and an untouched `Mqtt.Topic` with no property beside it answers the catalog's registered default - the same string the plugin passed
as `defaultTopic`, so the canonical prefix has exactly one statement and this function needs no constant of its own.

An empty property topic is read as unset. A blank configuration field is what produces one, and the client refuses an empty prefix outright, so passing it
through would turn MQTT off for an identity whose user has configured a broker.

The catalog contract is checked before anything is read: a catalog that never composed the group, or composed it with an empty `defaultTopic`, has no canonical
prefix to answer with, and the client would read the resulting empty prefix as MQTT off with nothing logged. That is a programming error rather than a
configuration state, so it throws where it can be seen rather than degrading into silence.

Both consumers resolve this once, where the client is constructed, behind the example's `??=`: a client's broker and prefix are fixed for its lifetime, so a
later re-resolution reaches no existing client.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `input` | [`MqttConnectionSettingsInput`](#mqttconnectionsettingsinput) | The engine, the identity, and the configuration properties. See [MqttConnectionSettingsInput](#mqttconnectionsettingsinput). |

#### Returns

[`Nullable`](util.md#nullable)\<[`MqttConnectionSettings`](#mqttconnectionsettings)\>

The resolved broker URL and topic prefix, or `null` when MQTT is off for this identity. See [MqttConnectionSettings](#mqttconnectionsettings).

#### Throws

`Error` naming `Mqtt.Topic` when the catalog carries no MQTT group, or carries one registered with an empty canonical topic.

#### Example

```ts
import { createMqttClient, mqttConnectionSettings } from "homebridge-plugin-utils";

const settings = mqttConnectionSettings({ config: this.config, controller: mac, featureOptions });

this.mqtt ??= settings && createMqttClient({ ...settings, log }, { signal: platform.signal });
```

***

### mqttFeatureOptions()

```ts
function mqttFeatureOptions<TMeta>(config): MqttFeatureOptionsGroup<TMeta>;
```

Build the canonical MQTT feature-option group - a category and its two entries - for a plugin to compose into its own feature-option catalog. The library that
ships the MQTT mechanism ships its configuration surface alongside it, so every plugin exposing an MQTT broker offers the same two options under the same names,
with the same descriptions, resolved by the same engine.

The two entries carry deliberately opposite defaults, because `FeatureOptions.value()` answers differently for each. `Mqtt.Url` defaults to disabled, so an
unconfigured broker resolves to `null` - an unambiguous "MQTT is off" a consumer can branch on without inspecting the string. `Mqtt.Topic` defaults to enabled, so
an unconfigured topic resolves to the `defaultTopic` registered here rather than to `null`, which is what lets the plugin's canonical topic live in the catalog
alone.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TMeta` | `unknown` | The concrete type of the opaque meta annotation the composing plugin's catalog carries, threaded onto both halves of the group so the result assigns straight into a `FeatureOptionEntry<TMeta>[]` catalog rather than needing a bridge on the plugin side. Defaults to `unknown`, which is what an un-parameterized call resolves to; the group sets no `meta` of its own, so the parameter is a compile-time thread with nothing behind it at runtime. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config` | [`MqttFeatureOptionsConfig`](#mqttfeatureoptionsconfig) | The per-plugin facts the group needs. See [MqttFeatureOptionsConfig](#mqttfeatureoptionsconfig). |

#### Returns

[`MqttFeatureOptionsGroup`](#mqttfeatureoptionsgroup)\<`TMeta`\>

A category entry and the two option entries belonging to it. See [MqttFeatureOptionsGroup](#mqttfeatureoptionsgroup). Every object is freshly allocated per call, so composing
         plugins never share catalog state. The category's `name` is typed as the literal `"Mqtt"` rather than as `string`, which is what lets a plugin whose catalog
         record is keyed on its literal category names (`Record<"Device" | "Mqtt", FeatureOptionEntry[]>`) write `[mqtt.category.name]` as a computed key without
         widening the record's key type.

#### Example

```ts
import { mqttFeatureOptions } from "homebridge-plugin-utils";

const mqtt = mqttFeatureOptions({ defaultTopic: "hydrawise" });

export const featureOptionCategories = [ { description: "Device", name: "Device" }, mqtt.category ];

export const featureOptions: Record<string, FeatureOptionEntry[]> = {

  Device: [ { default: true, description: "Make this device available in HomeKit.", name: "" } ],
  [mqtt.category.name]: mqtt.options
};
```
