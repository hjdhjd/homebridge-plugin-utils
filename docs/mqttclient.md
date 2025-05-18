[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / mqttclient

# mqttclient

MQTT connectivity and topic management for Homebridge plugins.

## Classes

### MqttClient

MQTT connectivity and topic management class for Homebridge plugins.

This class manages connection, publishing, subscription, and message handling for an MQTT broker, and provides convenience methods for Homebridge accessories to
interact with MQTT topics using a standard topic prefix.

#### Example

```ts
const mqtt = new MqttClient("mqtt://localhost:1883", "homebridge", log);

// Publish a message to a topic.
mqtt.publish("device1", "status", "on");

// Subscribe to a topic.
mqtt.subscribe("device1", "status", (msg) => {

  console.log(msg.toString());
});

// Subscribe to a 'get' topic and automatically publish a value in response.
mqtt.subscribeGet("device1", "temperature", "Temperature", () => "21.5");

// Subscribe to a 'set' topic and handle value changes.
mqtt.subscribeSet("device1", "switch", "Switch", (value) => {

  console.log("Switch set to", value);
});

// Unsubscribe from a topic.
mqtt.unsubscribe("device1", "status");
```

#### Constructors

##### Constructor

```ts
new MqttClient(
   brokerUrl, 
   topicPrefix, 
   log, 
   reconnectInterval): MqttClient;
```

Creates a new MQTT client for connecting to a broker and managing topics with a given prefix.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `brokerUrl` | `string` | `undefined` | The MQTT broker URL (e.g., "mqtt://localhost:1883"). |
| `topicPrefix` | `string` | `undefined` | Prefix to use for all MQTT topics (e.g., "homebridge"). |
| `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | `undefined` | Logger for debug and info messages. |
| `reconnectInterval` | `number` | `MQTT_DEFAULT_RECONNECT_INTERVAL` | Optional. Interval (in seconds) to wait between reconnection attempts. Defaults to 60 seconds. |

###### Returns

[`MqttClient`](#mqttclient)

###### Example

```ts
const mqtt = new MqttClient("mqtt://localhost", "homebridge", log);
```

###### Remarks

URL must conform to formats supported by [MQTT.js](https://github.com/mqttjs/MQTT.js).

#### Methods

##### publish()

```ts
publish(
   id, 
   topic, 
   message): void;
```

Publishes a message to a topic for a specific device.

Expands the topic using the topic prefix and device ID, then publishes the provided message string.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier. |
| `topic` | `string` | The topic name to publish to. |
| `message` | `string` | The message payload to publish. |

###### Returns

`void`

###### Example

```ts
mqtt.publish("device1", "status", "on");
```

##### subscribe()

```ts
subscribe(
   id, 
   topic, 
   callback): void;
```

Subscribes to a topic for a specific device and registers a handler for incoming messages.

The topic is expanded using the prefix and device ID, and the callback will be called for each message received.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier. |
| `topic` | `string` | The topic name to subscribe to. |
| `callback` | (`cbBuffer`) => `void` | Handler function called with the message buffer. |

###### Returns

`void`

###### Example

```ts
mqtt.subscribe("device1", "status", (msg) => {

  console.log(msg.toString());
});
```

##### subscribeGet()

```ts
subscribeGet(
   id, 
   topic, 
   type, 
   getValue, 
   log): void;
```

Subscribes to a '<topic>/get' topic and publishes a value in response to "true" messages.

When a message "true" is received on the '<topic>/get' topic, this method will publish the result of `getValue()` on the main topic. The log will record each status
publication event.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier. |
| `topic` | `string` | The topic name to use. |
| `type` | `string` | A human-readable label for log messages (e.g., "Temperature"). |
| `getValue` | () => `string` | Function to get the value to publish as a string. |
| `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Optional logger for status output. Defaults to the class logger. |

###### Returns

`void`

###### Example

```ts
mqtt.subscribeGet("device1", "temperature", "Temperature", () => "21.5");
```

##### subscribeSet()

```ts
subscribeSet(
   id, 
   topic, 
   type, 
   setValue, 
   log): void;
```

Subscribes to a '<topic>/set' topic and calls a setter when a message is received.

The `setValue` function is called with both a normalized value and the raw string. Handles both synchronous and promise-based setters. Logs when set messages are
received and when errors occur.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier. |
| `topic` | `string` | The topic name to use. |
| `type` | `string` | A human-readable label for log messages (e.g., "Switch"). |
| `setValue` | (`value`, `rawValue`) => `void` \| `Promise`\<`void`\> | Function to call when a value is set. Can be synchronous or return a Promise. |
| `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Optional logger for status output. Defaults to the class logger. |

###### Returns

`void`

###### Example

```ts
mqtt.subscribeSet("device1", "switch", "Switch", (value) => {

  console.log("Switch set to", value);
});
```

##### unsubscribe()

```ts
unsubscribe(id, topic): void;
```

Unsubscribes from a topic for a specific device, removing its message handler.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The device or accessory identifier. |
| `topic` | `string` | The topic name to unsubscribe from. |

###### Returns

`void`

###### Example

```ts
mqtt.unsubscribe("device1", "status");
```
