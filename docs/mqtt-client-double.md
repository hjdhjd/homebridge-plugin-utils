[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / mqtt-client-double

# mqtt-client-double

A recording [MqttClient](mqttClient.md#mqttclient) test double.

A plugin that speaks MQTT registers subscriptions and publishes state, and what its tests need to assert is its own half of that conversation. This module ships the
double that answers it: a [TestMqttClient](#testmqttclient) recording which subscriptions were registered, on which topics, carrying which signals, what was published, and how
a refused publish was handled, with drivers that let a test deliver a message or run a registered getter or setter by hand.

The double records, it does not simulate a broker. There is no connection, no topic prefixing (a topic is recorded as the caller's tail, verbatim), and nothing on
the wire...those are the real client's own contract, covered by the library's suite against a real broker, and a plugin's suite needs the plugin's side of the
interface rather than the transport's. What the double does mirror is the client's observable behavior, because that is what a consumer's code branches on: the
composed-signal check every publish opens with, the connection state a publish is refused on when it reads false, the pre-aborted early return that registers
nothing, the release of a registration when its per-subscription signal aborts, the change gate a publish asking for `ifChanged` is answered by and the
session-bound memory behind it, and the post-abort no-op posture of every method. The guarded path routes through
the client's own [routeGuardedPublishFailure](mqtt-publish.md#routeguardedpublishfailure), so a cancellation, an offline refusal, and a genuine failure reach
the same lines here that they reach on the client.

Signatures come from the client's own exported types - [MqttHandler](mqttClient.md#mqtthandler), [MqttGetHandler](mqttClient.md#mqttgethandler), [MqttSetHandler](mqttClient.md#mqttsethandler), and the init types - so a method here
cannot drift from the method it stands in for without the compiler saying so.

## Testing

### TestMqttClient

A recording [MqttClient](mqttClient.md#mqttclient) double: it captures what a plugin registered and published, refuses a publish on demand so a plugin can prove
its loop survives one, and hands a test the drivers to deliver a message or run a registered getter or setter without a broker.

Fidelity to the client's contract is the point. Every mirrored method keeps the client's signature and its observable behavior - the composed-signal abort check on
publish, the log lines the guarded path routes between, the registration rules, the release of a registration on abort, and the no-op posture every method takes
once the double has aborted - so a consumer driven against this double branches exactly as it would against a live client.

#### Example

```ts
import { TestMqttClient } from "homebridge-plugin-utils/testing";

const mqtt = new TestMqttClient();

// The plugin registers its subscriptions against the double, cast at its injection site.
plugin.configureMqtt(mqtt as unknown as MqttClient);

// Run the registered setter by hand: no broker, no wire. The tail is the recorded topic, carrying the `/set` suffix the client appends.
await mqtt.invokeSet("device1/power/set", "TRUE");

assert.equal(device.power, true);
```

#### Implements

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Constructors

##### Constructor

```ts
new TestMqttClient(options?): TestMqttClient;
```

Construct a recording double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `log?`: [`HomebridgePluginLogging`](util.md#homebridgepluginlogging); \} | Optional construction options. `log` is the logger [TestMqttClient.publishGuarded](#publishguarded) reports on, defaulting to the library's `noOpLog` so a test asserting on behavior rather than on log output constructs the double bare; a test reading the guarded path's wording passes a `capturingLog()`. |
| `options.log?` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | - |

###### Returns

[`TestMqttClient`](#testmqttclient)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="published"></a> `published` | `readonly` | [`TestMqttPublish`](#testmqttpublish)[] | `[]` | Every recorded publish, in order. A publish the refusal lever rejected never lands here - it is counted in [TestMqttClient.rejectedPublishes](#rejectedpublishes) instead. [TestMqttClient.publishedTo](#publishedto) is the view over this list a scenario reads when it cares about one topic rather than about the whole conversation. |
| <a id="publishrejection"></a> `publishRejection` | `public` | [`Nullable`](util.md#nullable)\<`Error`\> | `null` | The refusal lever. While it holds an error, every [TestMqttClient.publish](#publish) rejects with that error instead of recording, which is how a test proves a plugin's loop survives a broker that will not take a message. Set it back to `null` to resume recording. |
| <a id="rejectedpublishes"></a> `rejectedPublishes` | `public` | `number` | `0` | How many publishes the double refused - through the refusal lever, or because [TestMqttClient.connected](#connected) was false - counting the ones [TestMqttClient.publishGuarded](#publishguarded) absorbs and the republish [TestMqttClient.invokeGet](#invokeget) issues, so a test can assert a refusal happened without having to observe the rejection itself. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | `undefined` | The abort signal representing this double's lifetime, mirroring [MqttClient.signal](mqttClient.md#signal). It aborts exactly once, when [TestMqttClient.abort](#abort) is called or the double is disposed. |
| <a id="subscriptions"></a> `subscriptions` | `readonly` | [`TestMqttSubscription`](#testmqttsubscription)[] | `[]` | The registrations that are currently live, in registration order. An entry leaves this list when its per-subscription signal aborts, when [TestMqttClient.unsubscribe](#unsubscribe) names its topic, or when the double aborts - the client's release semantics, observable here as the entry's departure. |
| <a id="unsubscribes"></a> `unsubscribes` | `readonly` | \{ `id`: `string`; `topic`: `string`; \}[] | `[]` | Every `(id, topic)` tuple [TestMqttClient.unsubscribe](#unsubscribe) acted on, in order. A call the guard short-circuits - an aborted double, or an empty id - records nothing. |

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

The connection lever, mirroring [MqttClient.connected](mqttClient.md#connected). It reads `true` on a fresh double and `false` once the double
aborts, whatever the lever itself holds, which is the composition the client makes between mqtt.js's flag and its own lifetime.

Setting it to `false` stands in for a broker the client holds no session with: every [TestMqttClient.publish](#publish) is then refused with
[MqttOfflineError](mqtt-publish.md#mqttofflineerror) and counted, which is the outage a consumer's own code has to survive. Set it back to `true` to resume recording. Moving the lever
from `false` to `true` is a session restored and clears the change-gated memory, exactly as the client's connect clears its own; a write that leaves the lever
where it was is not a session event and leaves the memory standing.

###### Returns

`boolean`

###### Set Signature

```ts
set connected(value): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `boolean` |

###### Returns

`void`

#### Methods

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

`AsyncDisposable` implementation, mirroring the client's: it aborts the double, defaulting to `"shutdown"`.

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

Abort the double, mirroring [MqttClient.abort](mqttClient.md#abort): it defaults to `HbpuAbortError("shutdown")` when no reason is supplied, and
explicit reasons pass through unchanged. Safe to call more than once. Afterwards every publish, subscribe, and unsubscribe call is a no-op, and a driver
invocation takes the same quiet posture rather than reporting a miss, since teardown released every registration it could have matched.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. See [HbpuAbortError](util.md#hbpuaborterror). |

###### Returns

`void`

##### deliver()

```ts
deliver(topic, payload): Promise<void>;
```

Deliver `payload` to every raw handler registered on `topic` - the test's hand on the broker side, standing in for an inbound message. Handlers are invoked in
registration order in a single pass, and the pass is awaited as a whole, so every effect they produce is settled by the time this resolves.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The recorded topic to deliver on, matched exactly against [TestMqttSubscription.topic](#topic-1). |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The message payload. A string is converted to a `Buffer` first, since a `Buffer` is what the client hands a handler. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

##### holdPublishes()

```ts
holdPublishes(): () => void;
```

Park every publish admitted from here on and return the closure that releases them. A parked publish has passed the admissions [TestMqttClient.publish](#publish)
opens with and is waiting to be recorded - where a real publish sits while the broker acknowledges it - so a scenario can land a teardown, an outage, or a
refusal ON an in-flight publish rather than racing one.

Each call installs a fresh gate, and a publish parks on whichever gate is active when it is admitted. A release resolves its own gate and stands down as the
active hold only while nothing has replaced it, so an earlier release frees exactly the publishes parked on its own gate and leaves a later hold standing. A
second call is a second gate, not an error.

Everything that publishes parks with it. [TestMqttClient.publishGuarded](#publishguarded) routes through `publish`, so a guarded publish released after the double aborts
reaches the aborted line at debug; [TestMqttClient.invokeGet](#invokeget)'s republish parks too, so a get-driver invocation issued during a hold resolves at release.
[TestMqttClient.abort](#abort) releases nothing - the release is the test's own hand, and a held publish on a double that aborted rejects when it comes. A hold a
scenario never releases leaves that scenario's own awaited publishes pending.

###### Returns

The closure that releases the publishes parked on this call's gate. Safe to call more than once.

() => `void`

##### invokeGet()

```ts
invokeGet(topicSuffix): Promise<string | undefined>;
```

Run the getter registered on the topic ending in `topicSuffix` and publish its value on the parent topic - the test's hand on the `"true"` message the client's
get pattern waits for. The republish goes through [TestMqttClient.publish](#publish), so it lands in `published` and honors the refusal lever.

A suffix that matches no live get registration is a mis-bound driver call rather than a scenario, so it throws with the registered get topics named. A double
that has aborted is the one exception: it released every registration on the way down, and it answers quietly, as every method does after teardown.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topicSuffix` | `string` | The tail to match. The first get registration whose recorded topic ends with it is the one that runs; on a live double, matching none of them throws. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`string` \| `undefined`\>

The getter's value, or `undefined` on a double that has aborted - the one arm that answers without a getter having run.

##### invokeSet()

```ts
invokeSet(topicSuffix, rawValue): Promise<void>;
```

Run the setter registered on the topic ending in `topicSuffix` - the test's hand on an inbound set message. The setter receives the arguments the client passes
it: the lowercased value, the raw value, and this double's signal.

The miss posture is [TestMqttClient.invokeGet](#invokeget)'s: on a live double an unmatched suffix throws with the registered set topics named, and on a double that
has aborted the call returns quietly.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topicSuffix` | `string` | The tail to match. The first set registration whose recorded topic ends with it is the one that runs; on a live double, matching none of them throws. |
| `rawValue` | `string` | The raw message value, passed through as the setter's second argument and lowercased for its first. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

##### publish()

```ts
publish(
   topic, 
   payload, 
   init?
): Promise<void>;
```

Record a publish of `payload` to `topic`, mirroring [MqttClient.publish](mqttClient.md#publish). The composed signal is read first, so a publish
issued after teardown rejects with the abort reason rather than recording. [TestMqttClient.connected](#connected) is read next: while it is false the publish is
refused with [MqttOfflineError](mqtt-publish.md#mqttofflineerror), exactly as the client refuses a publish it has no broker session for. The refusal lever - when armed - rejects last, in
place of recording. A publish those admissions let through parks on the gate [TestMqttClient.holdPublishes](#holdpublishes) installed, if one is active, and faces
those same admissions again when the gate is released, so the state at release is what answers a held publish.

With `ifChanged`, the double records only when the payload differs from the last one it recorded for a change-gated publish on the topic. The gate answers once
the composed signal and the placeholder refusal have, and ahead of the session and lever admissions, which is where the client's own gate sits; the memory takes
the payload once the publish is recorded, and it is cleared when [TestMqttClient.connected](#connected) is set to `true` and when the double aborts, which is where
the client clears its own. The comparison and keeping rules are [MqttLastPayloads](mqtt-publish.md#mqttlastpayloads)'s. A suppressed publish records
nothing, counts nothing, and says nothing.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail) to publish to. Recorded verbatim; the double expands nothing. |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload to publish. Buffers and strings are recorded unchanged. |
| `init` | [`MqttPublishInit`](mqttClient.md#mqttpublishinit) | Optional per-publish options. See [MqttPublishInit](mqttClient.md#mqttpublishinit). A tail still carrying a brace is refused through [assertResolvedMqttTopic](mqtt-topics.md#assertresolvedmqtttopic) once the composed signal has answered, ahead of the session and lever admissions, which is where the client's own publish refuses one. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the publish is recorded - or at once, with nothing recorded, when `ifChanged` finds the payload unchanged - or rejects
         with the composed signal's reason, with [MqttOfflineError](mqtt-publish.md#mqttofflineerror), or with the armed refusal.

##### publishedTo()

```ts
publishedTo(topicSuffix): TestMqttPublish[];
```

The recorded publishes whose topic ends with `topicSuffix`, in publish order. Suffix matching is the double's own addressing - the tail match
[TestMqttClient.invokeGet](#invokeget) and [TestMqttClient.invokeSet](#invokeset) find a registration by - so a scenario names a topic here the way it already names one.

An empty answer is an outcome rather than a mis-bound call, which is why this accessor stays quiet where the drivers report a miss: a scenario proving nothing
reached a topic asks exactly this question and reads the empty list as its result.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topicSuffix` | `string` | The tail to match against each recorded topic. |

###### Returns

[`TestMqttPublish`](#testmqttpublish)[]

A fresh array of the matching publishes, in the order they were recorded. Mutating it leaves [TestMqttClient.published](#published) untouched.

##### publishGuarded()

```ts
publishGuarded(
   topic, 
   payload, 
   init?
): void;
```

The fire-and-forget counterpart to [TestMqttClient.publish](#publish), mirroring [MqttClient.publishGuarded](mqttClient.md#publishguarded): it returns
nothing, never throws, and never rejects...an outcome the caller has no use for lands in the log instead.

The rejection and the signals that govern it go to the client's own [routeGuardedPublishFailure](mqtt-publish.md#routeguardedpublishfailure), so the double
and the client cannot classify the same outcome differently. Each outcome resolves to one line: a publish cancelled by this double's abort, by the caller's
own signal, or by a rejection carrying either cancellation shape reaches the aborted line at debug; a publish refused through
[TestMqttClient.connected](#connected) reaches the dropped line at debug; anything else is a genuine failure and lands on the error line. The router owns the
reasoning behind that order. Every line names the topic tail, since the double expands nothing, and a change-gated publish the memory suppresses reaches no
line at all, since nothing was attempted.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail) to publish to. |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload to publish. |
| `init` | [`MqttPublishInit`](mqttClient.md#mqttpublishinit) | Optional per-publish options. See [MqttPublishInit](mqttClient.md#mqttpublishinit). |

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

Record a raw subscription on `topic`, mirroring [MqttClient.subscribe](mqttClient.md#subscribe). An aborted double or a pre-aborted
per-subscription signal records nothing, and a supplied signal releases the entry when it - or the double - aborts. A tail still carrying a brace is refused
through [assertResolvedMqttTopic](mqtt-topics.md#assertresolvedmqtttopic), after those guards.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail) to subscribe to. Recorded verbatim. |
| `handler` | [`MqttHandler`](mqttClient.md#mqtthandler) | The callback to record. [TestMqttClient.deliver](#deliver) runs it. |
| `init` | [`MqttSubscribeInit`](mqttClient.md#mqttsubscribeinit) | Optional per-subscription options. See [MqttSubscribeInit](mqttClient.md#mqttsubscribeinit). |

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

Record a get subscription on the `/get` child of `topic`, mirroring [MqttClient.subscribeGet](mqttClient.md#subscribeget). The registration rules
are [TestMqttClient.subscribe](#subscribe)'s; [TestMqttClient.invokeGet](#invokeget) is what runs the getter.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail); the `/get` suffix is appended to the recorded topic exactly as the client appends it. |
| `type` | `string` | Human-readable label, recorded alongside the registration. |
| `getValue` | [`MqttGetHandler`](mqttClient.md#mqttgethandler) | The getter to record. See [MqttGetHandler](mqttClient.md#mqttgethandler). |
| `init` | [`MqttSubscribeInit`](mqttClient.md#mqttsubscribeinit) | Optional per-subscription options. See [MqttSubscribeInit](mqttClient.md#mqttsubscribeinit). |

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

Record a set subscription on the `/set` child of `topic`, mirroring [MqttClient.subscribeSet](mqttClient.md#subscribeset). The registration rules
are [TestMqttClient.subscribe](#subscribe)'s; [TestMqttClient.invokeSet](#invokeset) is what runs the setter.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The relative topic (tail); the `/set` suffix is appended to the recorded topic exactly as the client appends it. |
| `type` | `string` | Human-readable label, recorded alongside the registration. |
| `setValue` | [`MqttSetHandler`](mqttClient.md#mqttsethandler) | The setter to record. See [MqttSetHandler](mqttClient.md#mqttsethandler). |
| `init` | [`MqttSubscribeSetInit`](mqttClient.md#mqttsubscribesetinit) | Optional per-subscription options, including a handler-invocation `timeout`. Recorded verbatim. See [MqttSubscribeSetInit](mqttClient.md#mqttsubscribesetinit). |

###### Returns

`void`

##### unsubscribe()

```ts
unsubscribe(id, topic): void;
```

Record an unsubscribe of the `(id, topic)` tuple and release every registration on the topic it names, mirroring
[MqttClient.unsubscribe](mqttClient.md#unsubscribe).

A tail still carrying a brace is refused through [assertResolvedMqttTopic](mqtt-topics.md#assertresolvedmqtttopic), after those guards.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier portion of the topic. An empty string short-circuits the whole call, as it does on the client. |
| `topic` | `string` | The topic tail relative to the id. |

###### Returns

`void`

***

### TestMqttPublish

One recorded publish, as the caller issued it.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="payload"></a> `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload passed to the publish, unchanged - a `Buffer` stays a `Buffer` and a string stays a string. |
| <a id="topic"></a> `topic` | `string` | The topic tail passed to the publish. The double expands nothing, so this is what the caller wrote. |

***

### TestMqttSubscription

One recorded subscription registration.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="handler"></a> `handler` | \| [`MqttHandler`](mqttClient.md#mqtthandler) \| [`MqttGetHandler`](mqttClient.md#mqttgethandler) \| [`MqttSetHandler`](mqttClient.md#mqttsethandler) | The callback exactly as the caller registered it - the raw handler, the getter, or the setter itself rather than a wrapper around it - so a driver can run it directly. Which of those it is follows from `kind`. |
| <a id="init"></a> `init` | \| [`MqttSubscribeInit`](mqttClient.md#mqttsubscribeinit) \| [`MqttSubscribeSetInit`](mqttClient.md#mqttsubscribesetinit) | The init the caller passed, verbatim, so a test can assert which signal (and, for a set registration, which timeout) governs the entry. |
| <a id="kind"></a> `kind` | `"raw"` \| `"get"` \| `"set"` | Which registration verb produced the entry. |
| <a id="topic-1"></a> `topic` | `string` | The topic the entry is registered on: the tail the caller passed, carrying the `/get` or `/set` suffix exactly as the client appends it. |
| <a id="type"></a> `type` | `string` \| `undefined` | The human-readable label a get or set registration carries, and `undefined` for a raw registration, which has none. |
