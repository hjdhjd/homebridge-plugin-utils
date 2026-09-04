[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / mqtt-publish

# mqtt-publish

The MQTT publish-outcome vocabulary the client and its shipped test double share: the error a publish is refused with while the client holds no broker session, the
pure router that classifies a guarded publish's failure into the one line that reports it, and the per-topic memory a change-gated publish is answered against.

All three live here rather than beside the client because the double stands in for the client without standing in for its transport. The double's only edge to
`mqttClient.ts` is a type import, which the compiler erases, and the `/testing` entry point aggregates every shipped double...so a value import from the client
would pull the mqtt package and everything under it into the load closure of any consumer test process that reaches for any double at all. This module carries no
runtime dependency beyond `./util.ts`, which lets the client and the double share one refusal and one classification without either one paying for a broker
library. The memory is here for the same reason: the double has to answer "is this the same payload?" exactly as the client does, and one class the two of them
import by value is what keeps them from drifting on the comparison or on how a payload is kept.

## Utilities

### MqttLastPayloads

The last payload each topic went out with through a change-gated publish, kept per client so that such a publish goes out only when the payload moved.

The client holds one behind the `ifChanged` option of [MqttPublishInit](mqttClient.md#mqttpublishinit), and the shipped double holds its own mirror. A plugin
reaches the behavior through that option and never constructs one of these itself.

Two payloads are the same when they are equal strings, or when they are Buffers carrying the same bytes. A string and a Buffer are never the same, whatever their
bytes: a topic's payloads are one kind or the other, and comparing across kinds would encode every string on the hot path to answer a question no caller asks.

#### Constructors

##### Constructor

```ts
new MqttLastPayloads(): MqttLastPayloads;
```

###### Returns

[`MqttLastPayloads`](#mqttlastpayloads)

#### Methods

##### clear()

```ts
clear(): void;
```

Forget every topic, so the next change-gated publish on each one goes out. The client clears its memory on every connect and at teardown, and the double clears
its own when a session is restored and at abort.

###### Returns

`void`

##### remember()

```ts
remember(topic, payload): void;
```

Remember `payload` as what `topic` last went out with, replacing whatever was remembered for it.

A Buffer is copied rather than kept by reference, so a caller that fills one scratch buffer per pass is weighed against the bytes it actually delivered rather
than against whatever that buffer holds by the time the next publish asks. A string is kept as it is, since nothing can rewrite it.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The topic to remember under. |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload that went out. |

###### Returns

`void`

##### sameAsLast()

```ts
sameAsLast(topic, payload): boolean;
```

Answer whether `payload` is what was last remembered for `topic`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The topic to read, spelled as the caller spells its topics. |
| `payload` | `string` \| `Buffer`\<`ArrayBufferLike`\> | The payload to weigh against what was remembered. |

###### Returns

`boolean`

`true` when a payload was remembered for `topic` and it is the same one, and `false` otherwise, so the first change-gated publish on any topic goes
         out.

***

### MqttOfflineError

Rejected by [MqttClient.publish](mqttClient.md#publish) when the client holds no session with the broker: before the first CONNACK arrives, after a
transport failure drops the connection, after the broker closes it, and from the moment the client aborts. That set is exactly the window in which
[MqttClient.connected](mqttClient.md#connected) reads `false`, which is the reading a consumer can take for itself before it even attempts a publish.

The posture behind the error is refusal rather than queuing. QoS 0 is at-most-once by definition, so a publish that cannot go out has no delivery guarantee left to
preserve by being held: retaining it grows memory for as long as the outage lasts, with no bound and no signal to the caller, and flushing the backlog on reconnect
delivers hours-old state changes and events to the broker as though they had just happened. Refusing on the spot keeps memory flat and keeps the broker's view of
the plugin honest...the caller learns immediately, and the next state change publishes normally once the session is back.

[MqttClient.publishGuarded](mqttClient.md#publishguarded) has no caller to answer, so it absorbs the refusal into a single debug line. A consumer
awaiting [MqttClient.publish](mqttClient.md#publish) directly tells the refusal apart from a delivery failure with `error instanceof
MqttOfflineError`.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new MqttOfflineError(message?): MqttOfflineError;
```

###### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `message` | `string` | `"The MQTT client is not connected to the broker."` |

###### Returns

[`MqttOfflineError`](#mqttofflineerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Overrides |
| ------ | ------ | ------ | ------ |
| <a id="name"></a> `name` | `readonly` | `"MqttOfflineError"` | `Error.name` |

***

### routeGuardedPublishFailure()

```ts
function routeGuardedPublishFailure(options): void;
```

Route a guarded publish's failure to the log line that reports it. Pure void function: no class state, no mqtt.js handles, no closure over a live client. The
client's own guarded path and the shipped double's counterpart both hand it the rejection and the signals that govern the publish, which is what keeps the two from
classifying the same outcome differently.

The order the terms are read in is what makes the classification correct rather than merely plausible:

- The signals answer first. A caller may abort with any reason it likes - a bare string, a custom error, nothing at all - and `publish` rejects with that reason
  verbatim, so only the signals governing this publish can say whether it was cancelled. A genuine delivery failure that loses a race with an abort lands on the
  quiet path too, which is the intent: once teardown is under way, a string of delivery failures on the way out tells a reader nothing they can act on.
- The thrown cancellation shapes come second, covering the rejection that arrives with neither signal reading aborted.
- An offline refusal comes third. It is not a delivery fault, and it drops to debug because the outage that produced it is reported at error level by the client's
  broker error line: on every retry while reconnection is armed, once and as final when reconnection is disabled, and before the first CONNACK the connection is
  still being established, with its outcome reaching the log either way.

Everything else is a genuine failure, and lands at error level naming the topic and the reason.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `clientSignal`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); `error`: `unknown`; `log`: [`HomebridgePluginLogging`](util.md#homebridgepluginlogging); `publishSignal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); `topic`: `string`; \} | The publish's outcome and the signals that govern it. |
| `options.clientSignal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The lifetime signal of the client that issued the publish. |
| `options.error` | `unknown` | The value the publish rejected with, unchanged. |
| `options.log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Logger that receives the routed line. |
| `options.publishSignal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The caller's per-publish signal, when one was supplied. |
| `options.topic` | `string` | The topic to name in the line, in whatever form the caller reports topics. |

#### Returns

`void`
