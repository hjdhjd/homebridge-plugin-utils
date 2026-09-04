[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / mqtt-topics

# mqtt-topics

The MQTT topic vocabulary every other MQTT module and every consumer reads: the device-scoped composer both `unsubscribe` verbs spell the `(id, topic)` tuple
through, the get and set children the client subscribes on, and the catalog a plugin declares its whole topic surface in.

A catalog is one declaration three readers share: the plugin's publish and subscribe sites take their tails and their log labels from it, the documentation
renderer projects it into the plugin's MQTT document, and the builder validates it once when the declaring module is evaluated. Braces are reserved in every tail
for the catalog's placeholders, so a parameterized tail names what varies rather than enumerating it, and [resolveMqttTopic](#resolvemqtttopic) is the one way a value reaches
one.

The module imports nothing, and that is the design rather than an accident of its size. The shipped test double reaches it, and so does the documentation renderer
that must stay free of every `node:` builtin to remain isomorphic. A value edge to `./util.ts` would carry `node:timers/promises` in behind it through
`clock.ts`, so the vocabulary stands on its own and every module above it - the transport-bearing client, the transport-free double, the renderer - composes the
same topics from the same statements.

## Utilities

### MqttTopicDeviceColumn

The device-type column a plugin's MQTT document carries, declared once beside the entries.

Documentation only: nothing at runtime reads it, so it is data the renderer projects rather than a hook anything calls. Entries name device kinds by key into
`vocabulary`, and the renderer joins an entry's labels in the order the vocabulary declares them, so one declaration fixes both the spelling of every label and
the order every cell reads in.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `V` *extends* `Readonly`\<`Record`\<`string`, `string`\>\> | `Readonly`\<`Record`\<`string`, `string`\>\> | The vocabulary's own shape, inferred from the declaration so an entry naming an undeclared kind is a compile error. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="heading"></a> `heading` | `readonly` | `string` | The column's header text, as the document prints it. |
| <a id="vocabulary"></a> `vocabulary` | `readonly` | `V` | The device kinds, from the key an entry names to the label a cell shows. |

***

### MqttTopicEntry

One topic a plugin declares: its tail, the name its verbs log under, the document's message texts, and the device kinds it belongs to.

The presence of `publish`, `get`, and `set` is the declaration that the plugin performs that verb. A consumer publishes an entry only when it declares `publish`,
and the renderer emits exactly the rows the entry declares, so one declaration answers both what the code does and what the document says. Author-owned markdown
in the three message texts reaches the document verbatim, except the column separator, which the renderer escapes.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TDevice` *extends* `string` | `string` | The device-kind keys this entry may name, fixed by the catalog's column vocabulary. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="devices"></a> `devices?` | `readonly` | readonly \[`TDevice`, `TDevice`\] | Optional. The device kinds the topic belongs to, named by key into the catalog's column vocabulary, as a non-empty tuple. Present only when the catalog declares a column, which the builder's two overloads make a compile-time pair wherever the entries' literal type survives. |
| <a id="get"></a> `get?` | `readonly` | `string` | Optional. The message text the document prints for the topic's get child. Its presence declares that the plugin subscribes to that child. |
| <a id="group"></a> `group?` | `readonly` | `string` | Optional. The heading the entry's rows render under. A catalog groups all of its entries or none of them. |
| <a id="label"></a> `label` | `readonly` | `string` | The name the get and set verbs log under, handed to `subscribeGet` and `subscribeSet` as their `type` argument. |
| <a id="publish"></a> `publish?` | `readonly` | `string` | Optional. The message text the document prints for the published topic. Its presence declares that the plugin publishes it. |
| <a id="set"></a> `set?` | `readonly` | `string` | Optional. The message text the document prints for the topic's set child. Its presence declares that the plugin subscribes to that child. |
| <a id="topic"></a> `topic` | `readonly` | `string` | The tail relative to the identity the caller composes with, or the whole topic after the prefix for a plugin that composes no identity. A template when it carries placeholders. |

***

### MqttTopicCatalog

```ts
type MqttTopicCatalog<TDevice, V> = MqttTopicEntries<TDevice> & {
  [MQTT_DEVICE_COLUMN]?: MqttTopicDeviceColumn<V>;
};
```

What [mqttTopicCatalog](#mqtttopiccatalog-1) returns and the renderer reads: the entries, with the device column attached under [MQTT\_DEVICE\_COLUMN](#mqtt_device_column) when one was
declared. The symbol key is invisible to every iteration over the entries, so a plugin's call sites and the renderer both walk the entries alone.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `[MQTT_DEVICE_COLUMN]?` | [`MqttTopicDeviceColumn`](#mqtttopicdevicecolumn)\<`V`\> |

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TDevice` *extends* `string` | `string` | The device-kind keys the entries name. |
| `V` *extends* `Readonly`\<`Record`\<`string`, `string`\>\> | `Readonly`\<`Record`\<`string`, `string`\>\> | The column vocabulary's own shape. |

***

### MqttTopicCatalogWithColumn

```ts
type MqttTopicCatalogWithColumn<T, V> = T & {
  [MQTT_DEVICE_COLUMN]: MqttTopicDeviceColumn<V>;
};
```

What the column-bearing form of [mqttTopicCatalog](#mqtttopiccatalog-1) returns: the entries exactly as the plugin declared them, with the device column attached under
[MQTT\_DEVICE\_COLUMN](#mqtt_device_column).

The shape is a named export so that a consumer can spell it. A plugin that exports its own catalog and emits declarations has to write this return type into
its declaration file, and a type keyed by a unique symbol can be written there only through an alias the library exports: the emitter names the alias from a
module that imports the builder alone, where it has no way to reference the key as a value.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `[MQTT_DEVICE_COLUMN]` | [`MqttTopicDeviceColumn`](#mqtttopicdevicecolumn)\<`V`\> |

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The entries as declared, whose literal type carries through so per-key access and the placeholder guard read the same as at the call site. |
| `V` *extends* `Readonly`\<`Record`\<`string`, `string`\>\> | The column vocabulary's own shape. |

***

### MqttTopicEntries

```ts
type MqttTopicEntries<TDevice> = Readonly<Record<string, MqttTopicEntry<TDevice>>>;
```

The keyed record a plugin hands [mqttTopicCatalog](#mqtttopiccatalog-1). The keys are the names its call sites read entries by.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TDevice` *extends* `string` | `string` | The device-kind keys the entries may name. |

***

### MqttTopicEntriesWithDevices

```ts
type MqttTopicEntriesWithDevices<TDevice> = Readonly<Record<string, MqttTopicEntry<TDevice> & {
  devices: readonly [TDevice, ...TDevice[]];
}>>;
```

The entries a catalog declaring a device column hands [mqttTopicCatalog](#mqtttopiccatalog-1): every one of them carrying a non-empty `devices` list.

The column and the lists are one decision, so the builder's column-bearing overload constrains its entries through this type and an entry that forgot its list
fails to compile rather than reaching the renderer as a documentation defect.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `TDevice` *extends* `string` | The device-kind keys the entries may name, taken from the column's vocabulary. |

***

### MqttTopicParameters

```ts
type MqttTopicParameters<T> = T extends `${string}{${infer Name}}${infer Rest}` ? Name | MqttTopicParameters<Rest> : never;
```

The parameter names a topic template carries, as a union of string literals, and `never` for a plain tail.

The derivation is what makes [resolveMqttTopic](#resolvemqtttopic)'s parameter record exact: the template's own text names the keys that record must carry, so a misspelled or
missing name is a compile error at the call site rather than an `undefined` segment on the wire. It holds only while the topic's literal type survives, which is
the authoring rule [mqttTopicCatalog](#mqtttopiccatalog-1) states, and it is why every reader below refuses a stray brace at runtime as well.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` *extends* `string` | The topic template whose parameter names are being read. |

***

### ResolvedMqttTopic

```ts
type ResolvedMqttTopic<T> = [MqttTopicParameters<T>] extends [never] ? T : "This topic carries a placeholder; resolve it through resolveMqttTopic before composing it.";
```

A topic carrying no unresolved placeholder: the topic itself when it is plain, and a sentence saying what to do about it when it is not.

This is the parameter type [mqttTopic](#mqtttopic), [mqttGetTopic](#mqttgettopic), and [mqttSetTopic](#mqttsettopic) take, so handing a composer a template reads as a type error naming
the remedy rather than as a topic no broker ever matches. A plain `string` resolves to itself, so every caller composing a tail it computed at runtime is
unaffected.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` *extends* `string` | The topic being composed. |

***

### WellFormedMqttTopic

```ts
type WellFormedMqttTopic<T> = "" extends MqttTopicParameters<T> ? "This topic carries an empty placeholder; a placeholder names its parameter." : T;
```

A topic whose every placeholder names a parameter: the topic itself, and a sentence when one of them is the empty pair.

[resolveMqttTopic](#resolvemqtttopic) takes its topic through this type because an empty placeholder names no parameter, so no record could resolve it. A compile error says
that at the call site where the literal survives, and the resolver's residual check says it everywhere else.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` *extends* `string` | The topic being resolved. |

***

### MQTT\_DEVICE\_COLUMN

```ts
const MQTT_DEVICE_COLUMN: unique symbol;
```

The key a catalog's device column is attached under. A symbol, so no entry key can collide with it and no iteration over the entries - `Object.entries`,
`Object.keys`, `for...in` - ever lists it.

***

### MQTT\_GET\_SUFFIX

```ts
const MQTT_GET_SUFFIX: "/get" = "/get";
```

The suffix the client appends to a topic to name the child a get request arrives on. A `"true"` message there asks for a republish on the parent topic.

The constant is what a reader taking a child apart again works from: [TestMqttClient.invokeGet](mqtt-client-double.md#invokeget) strips exactly
this much off a recorded topic to recover the parent it republishes to. A reader composing a child rather than splitting one names it through
[mqttGetTopic](#mqttgettopic).

***

### MQTT\_SET\_SUFFIX

```ts
const MQTT_SET_SUFFIX: "/set" = "/set";
```

The suffix the client appends to a topic to name the child a set message arrives on. Each message that arrives there carries the value the setter is asked to
apply.

***

### assertResolvedMqttTopic()

```ts
function assertResolvedMqttTopic(caller, topic): void;
```

Refuse a topic that still carries a brace, naming the caller that meant to use it.

The one refusal the resolver, the client's three wire verbs, and the shipped double all reach, shared the way the guarded-publish router is shared: the predicate
and the sentence are stated once, so a topic that would have gone to the broker with an unresolved placeholder in it is refused identically wherever it was
headed. The compile-time guard covers the call sites where a topic's literal type survives; this covers every other one, which is what makes the contract
unconditional rather than conditional on how a plugin declared its catalog.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `caller` | `string` | The symbol whose name opens the message, so the refusal reads as the verb that met it. |
| `topic` | `string` | The topic to check. |

#### Returns

`void`

#### Throws

`Error` naming the caller and the topic when the topic carries either brace.

***

### mqttGetTopic()

```ts
function mqttGetTopic<T>(topic): string;
```

Name the get child of a topic tail: the tail with [MQTT\_GET\_SUFFIX](#mqtt_get_suffix) appended.

This is the one home of the get join, for the reason [mqttTopic](#mqtttopic) is the one home of the identity join - a convention repeated at each site drifts one site at
a time, and a convention stated once cannot. The client's own [MqttClient.subscribeGet](mqttClient.md#subscribeget), the double's registrations, the
documentation renderer's subscribed rows, and a consumer releasing a child through `unsubscribe(id, mqttGetTopic(entry.topic))` all spell it here.

The `topic` parameter is typed [ResolvedMqttTopic](#resolvedmqtttopic), so handing this an unresolved template is a compile error wherever the topic's literal type survives. A
plain `string` passes through unchanged.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `string` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | [`ResolvedMqttTopic`](#resolvedmqtttopic)\<`T`\> | The topic tail whose get child is being named. |

#### Returns

`string`

The child topic a get request arrives on.

***

### mqttSetTopic()

```ts
function mqttSetTopic<T>(topic): string;
```

Name the set child of a topic tail: the tail with [MQTT\_SET\_SUFFIX](#mqtt_set_suffix) appended.

The get child's rationale, on the set side: [MqttClient.subscribeSet](mqttClient.md#subscribeset), the double's registrations, the renderer's
subscribed rows, and a consumer releasing a child through `unsubscribe(id, mqttSetTopic(entry.topic))` all reach the same statement.

The `topic` parameter is typed [ResolvedMqttTopic](#resolvedmqtttopic), so handing this an unresolved template is a compile error wherever the topic's literal type survives. A
plain `string` passes through unchanged.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `string` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | [`ResolvedMqttTopic`](#resolvedmqtttopic)\<`T`\> | The topic tail whose set child is being named. |

#### Returns

`string`

The child topic a set message arrives on.

***

### mqttTopic()

```ts
function mqttTopic<T>(id, topic): string;
```

Compose the topic tail for one owner's MQTT topic: the owner's identity as the leading segment, joined to the topic tail by a single slash. The client prepends the
topic prefix its configuration carries and nothing else, so the topic the broker sees is `prefix/id/topic`.

Every publisher and subscriber in a plugin spells a device-scoped topic through this function rather than repeating the concatenation at each site, and the two
verbs that receive the tuple already split - [MqttClient.unsubscribe](mqttClient.md#unsubscribe) and
[TestMqttClient.unsubscribe](mqtt-client-double.md#unsubscribe) - rebuild the tail through it as well, so the convention has exactly one home.

The identity is scope-agnostic: a device identity and a controller identity are both just the leading segment, so one composer serves a per-device topic and a
controller's own telemetry topic alike. The parameters are positional rather than named because the two strings arrive in wire order, and that order is the whole
of what the function states.

The `topic` parameter is typed [ResolvedMqttTopic](#resolvedmqtttopic), which is what makes handing a composer an unresolved template a compile error wherever the topic's
literal type survives; a plain `string` passes through unchanged, so every caller composing a tail it computed at runtime is unaffected.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `string` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `id` | `string` | The identity the topic addresses, spelled as the device or controller is addressed everywhere else. |
| `topic` | [`ResolvedMqttTopic`](#resolvedmqtttopic)\<`T`\> | The topic tail relative to that identity, carried through verbatim however many segments it holds. |

#### Returns

`string`

The composed topic tail.

#### Example

```ts
import { mqttTopic } from "homebridge-plugin-utils";

// The broker sees the client's configured topic prefix followed by this tail.
await mqtt.publish(mqttTopic(device.mac, "motion"), "true");
```

***

### mqttTopicCatalog()

#### Call Signature

```ts
function mqttTopicCatalog<T>(entries): T;
```

Declare a plugin's MQTT topic surface: validate the entries once, attach the device column when one is given, and return the catalog its call sites and its
document both read.

The catalog is the single source of truth for a plugin's topics. Its publish and subscribe sites take their tails and their log labels from it, the documentation
renderer projects it into the plugin's MQTT document, and this builder checks what the runtime reads the moment the declaring module is evaluated - which for the
documented form, `export const mqttTopics = mqttTopicCatalog(...)` at module scope, is the plugin's own import. A malformed catalog is a programming error, so it
is named where it can be seen rather than carried forward.

Two overloads, because the column and the entries' device lists are one decision. Without a column, an entry declaring `devices` fails to compile. With one, the
vocabulary's keys are inferred from the declaration, so an entry missing its list, an empty list, and a list naming an undeclared kind each fail to compile. The
runtime reads nothing from the column beyond attaching it: the document's own checks - a missing or stray list, an unknown key, mixed groups - belong to the
renderer, because the compiled JavaScript the CLI loads carries no types and a documentation mistake should fail the docs build rather than a plugin's startup.

The authoring rule the compile-time half depends on: TypeScript keeps a topic's literal type while the entries literal reaches this builder inline, or through
group constants declared `as const` and spread into the call. An intermediate constant without `as const`, a spread of plain constants, or an explicit type
annotation on the exported catalog widens every topic to `string` and silences the guard. Declare the catalog inline or from `as const` groups, and never
annotate the export - the builder types it. Because that half is conditional on how the catalog is written, [assertResolvedMqttTopic](#assertresolvedmqtttopic) at the client's three
wire verbs is what makes the contract unconditional.

##### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `Readonly`\<`Record`\<`string`, [`MqttTopicEntry`](#mqtttopicentry)\<`never`\>\>\> |

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `entries` | `T` | The topics, keyed by the names the plugin's call sites read them by. |

##### Returns

`T`

A fresh catalog carrying every entry. The caller's own literal is never mutated.

##### Throws

`Error` naming the offending key when the catalog declares no entries, when an entry declares a field outside the seven, an empty topic, none of
        `publish`, `get`, or `set`, or a brace outside a well-formed placeholder, and naming both keys when two entries produce the same wire topic.

##### Example

```ts
import { mqttGetTopic, mqttTopic, mqttTopicCatalog, resolveMqttTopic } from "homebridge-plugin-utils";

export const mqttTopics = mqttTopicCatalog({

  lock: { devices: ["camera"], get: "`true` requests a publish of the current lock state.", group: "Door", label: "lock",
    publish: "`true` when locked, `false` when unlocked.", set: "`true` to lock, `false` to unlock.", topic: "lock" },
  smartMotion: { devices: [ "camera", "sensor" ], group: "Motion", label: "smart motion",
    publish: "The smart detection event for the named object class.", topic: "motion/smart/{object}" }
}, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });
```

A catalog assembled from groups keeps the guard as long as each group is declared `as const`:

```ts
const door = { lock: { label: "lock", publish: "`true` when locked.", topic: "lock" } } as const;
const motion = { smartMotion: { label: "smart motion", publish: "The smart detection event.", topic: "motion/smart/{object}" } } as const;

export const mqttTopics = mqttTopicCatalog({ ...door, ...motion });
```

The call sites then read every tail and every label from that one declaration:

```ts
await mqtt.publish(mqttTopic(device.mac, mqttTopics.lock.topic), "true");
mqtt.subscribeGet(mqttTopics.lock.topic, mqttTopics.lock.label, () => this.lockState);
mqtt.unsubscribe(device.mac, mqttGetTopic(mqttTopics.lock.topic));
await mqtt.publish(mqttTopic(device.mac, resolveMqttTopic(mqttTopics.smartMotion.topic, { object: event.type })), "true");
```

#### Call Signature

```ts
function mqttTopicCatalog<V, T>(entries, column): MqttTopicCatalogWithColumn<T, V>;
```

Declare a topic surface that a device-type column accompanies. The validation, the authoring rule, and the examples are the ones above; what this form adds is the
column, inferred from its own declaration so an entry missing its device list, carrying an empty one, or naming a kind the vocabulary does not declare each fail to
compile wherever the entries' literal type survives.

##### Type Parameters

| Type Parameter |
| ------ |
| `V` *extends* `Readonly`\<`Record`\<`string`, `string`\>\> |
| `T` *extends* `Readonly`\<`Record`\<`string`, [`MqttTopicEntry`](#mqtttopicentry)\<keyof `V` & `string`\> & \{ `devices`: readonly \[keyof `V` & `string`, keyof `V` & `string`\]; \}\>\> |

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `entries` | `T` | The topics, keyed by the names the plugin's call sites read them by, each carrying a non-empty `devices` list. |
| `column` | [`MqttTopicDeviceColumn`](#mqtttopicdevicecolumn)\<`V`\> | The device-type column the document prints, whose vocabulary fixes the kinds an entry may name. |

##### Returns

[`MqttTopicCatalogWithColumn`](#mqtttopiccatalogwithcolumn)\<`T`, `V`\>

A fresh [MqttTopicCatalogWithColumn](#mqtttopiccatalogwithcolumn) carrying every entry with the column attached under [MQTT\_DEVICE\_COLUMN](#mqtt_device_column). The caller's own literal is
         never mutated.

***

### mqttTopicPlaceholders()

```ts
function mqttTopicPlaceholders(topic): readonly string[];
```

The placeholder names a topic carries, in order of appearance, and an empty list for a plain tail. A name repeated in the topic is listed once per appearance.

The renderer reads this to build the markup a parameterized topic cell shows; a consumer rarely needs it, since the parameter record's own keys are what a call
site works from.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | `string` | The topic to read the placeholder names out of. |

#### Returns

readonly `string`[]

The names, in the order the topic spells them.

***

### resolveMqttTopic()

```ts
function resolveMqttTopic<T>(topic, parameters): string;
```

Resolve a topic template against a record of parameter values: each placeholder is replaced by the parameter of that name, and a plain tail passes through
unchanged.

The record's keys are derived from the template's own literal type, so a misspelled or missing name is a compile error at every call site where that literal
survives. Where it does not, the two throws below are what stand in its place: a placeholder naming a parameter the record does not carry, and a brace left in
the result that the grammar never admitted. A parameter's VALUE goes in verbatim - a value carrying a slash extends the topic's hierarchy, which is the caller's
to prevent, since the value is the caller's own wire data.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `string` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `topic` | [`WellFormedMqttTopic`](#wellformedmqtttopic)\<`T`\> | The topic template to resolve. |
| `parameters` | `Readonly`\<`Record`\<[`MqttTopicParameters`](#mqtttopicparameters)\<`T`\>, `string`\>\> | The value for each placeholder the template names. |

#### Returns

`string`

The resolved topic.

#### Throws

`Error` naming the placeholder when the record does not carry it, and naming the topic when the result still carries a brace.

#### Example

```ts
await mqtt.publish(mqttTopic(device.mac, resolveMqttTopic(mqttTopics.smartMotion.topic, { object: event.type })), "true");
```
