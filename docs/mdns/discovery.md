[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / mdns/discovery

# mdns/discovery

Service discovery as a plugin wants it: a pure `classify` from a resolved service to the plugin's own device, an ordered stream of what changed, a live
snapshot of what is out there, and a promise that says when a first look is over.

[discoverServices](#discoverservices) is the one projection every consuming plugin would otherwise write for itself. It runs an [MdnsBrowser](browser.md#mdnsbrowser)
underneath, hands each transition the browser derives to the consumer's `classify`, and keeps [MdnsDiscovery.devices](#devices) in step with the answers: a
service that classifies to a device is found, a device whose service later classifies to `null` is lost, and a service that never classifies to anything is
never mentioned. What the consumer iterates is the same sequence in the same order, one event at a time.

**Two lifetimes, one surface.** A plugin that browses for as long as it runs iterates the stream and acts on each event. A plugin that runs a burst per cycle
awaits [MdnsDiscovery.settled](#settled), reads `devices`, and disposes. The snapshot is what serves the second one: it reflects every event the browser has
produced whether or not anything has read the stream, because the projection runs synchronously as the browser derives each transition rather than when a
consumer's loop gets around to it.

**One iteration.** The queue behind the stream is open from construction until the consumer's one iteration ends, for whatever reason: events produced before
the first `for await` are held for it, and events produced after it ends update `devices` and are queued nowhere. A second `for await` meets a stream that has
already ended, as `Mp4SegmentAssembler.segments` states for its own single consumer. A consumer that reads `devices` alone and never iterates therefore holds
its transitions until disposal, which is the bound a one-shot cycle lives inside anyway.

**Faults.** The stream is wrapped in the library's own envelope, so a consumer's `for await` never has to catch: it ends. Which ending it was is what
`signal.reason` says - an `HbpuAbortError` named `"failed"` for a browser that lost its last socket, which the browser has already written a line about, and
`"shutdown"` for the consumer's own teardown.

## mDNS

### DiscoverServicesOptions

What [discoverServices](#discoverservices) is called with: everything an [MdnsBrowserOptions](browser.md#mdnsbrowseroptions) carries except the levers that belong to
the browser's own suite, plus the consumer's classification and the one boundary a consumer substitutes at.

#### Extends

- `Omit`\<[`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions), `"interfaces"` \| `"onEvent"` \| `"random"` \| `"socketFactory"`\>

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's device type. |

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="browserfactory"></a> `browserFactory?` | `readonly` | [`MdnsBrowserFactory`](browser.md#mdnsbrowserfactory) | How the browser underneath is constructed. Defaults to `mdnsBrowserFactory`; a consumer's test passes `TestMdnsBrowserFactory` from the testing entry point and exercises its own `classify`, the snapshot, and the ordering with no socket at all. | - |
| <a id="ceilingms"></a> `ceilingMs?` | `readonly` | `number` | The longest interval between browsing queries, in milliseconds, and the ceiling a resolution's ladder climbs to. Must be finite and at least one second. Defaults to [MDNS\_QUERY\_CEILING\_MS](browser.md#mdns_query_ceiling_ms). | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions).[`ceilingMs`](browser.md#ceilingms) |
| <a id="classify"></a> `classify` | `readonly` | (`service`) => [`Nullable`](../util.md#nullable)\<`T`\> | What a resolved service means to this plugin: its own device descriptor, or `null` for a service it does not want. Called for each service found and for each service that changes, and a throw is logged and read as `null`. | - |
| <a id="clock"></a> `clock?` | `readonly` | [`Clock`](../clock.md#clock) | The time source every deadline is armed on. Defaults to `systemClock`. | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions).[`clock`](browser.md#clock) |
| <a id="ipfamilies"></a> `ipFamilies?` | `readonly` | readonly \[[`IpFamily`](../dgram-util.md#ipfamily), [`IpFamily`](../dgram-util.md#ipfamily)\] | The address families to browse. The browser holds one socket per family named: each joins its own family's group on every link of that family, caches its own family's address records alone, and asks its own family's address question in a resolution, so one host's addresses of both families meet in one service. A family whose socket fails is dropped with a warning and the browser serves what remains, ending only when no family remains. The list is the order the sockets are created in and nothing else reads it, and each family may be named only once. Defaults to [MDNS\_DEFAULT\_FAMILIES](browser.md#mdns_default_families). | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions).[`ipFamilies`](browser.md#ipfamilies) |
| <a id="log"></a> `log` | `readonly` | [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) | Where the browser's own lifecycle lines go. | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions).[`log`](browser.md#log) |
| <a id="servicetype"></a> `serviceType` | `readonly` | `string` | The service type to browse, spelled as a full DNS-SD type name - `"_esphomelib._tcp.local"`, or a subtype form such as `"_printer._sub._http._tcp.local"`. | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions).[`serviceType`](browser.md#servicetype) |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The caller's lifetime. Aborting it tears the browser down. | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions).[`signal`](browser.md#signal-2) |
| <a id="warmupms"></a> `warmupMs?` | `readonly` | `number` | How long after the first query [MdnsBrowser.settled](browser.md#settled) resolves, in milliseconds. Must be positive and finite. Defaults to [MDNS\_WARMUP\_MS](browser.md#mdns_warmup_ms). | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions).[`warmupMs`](browser.md#warmupms) |

***

### MdnsDiscovery

A live discovery: the stream of what changed, the snapshot of what is there, and the lifetime the two share.

#### Extends

- `AsyncIterable`\<[`MdnsDiscoveryEvent`](#mdnsdiscoveryevent)\<`T`\>\>.[`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's device type. |

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="devices"></a> `devices` | `readonly` | `ReadonlyMap`\<`string`, `T`\> |
| <a id="settled"></a> `settled` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> |
| <a id="signal-1"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) |

#### Methods

##### abort()

```ts
abort(reason?): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason?` | `unknown` |

###### Returns

`void`

***

### MdnsDiscoveryEvent

```ts
type MdnsDiscoveryEvent<T> = 
  | {
  device: T;
  kind: "found";
  service: MdnsService;
}
  | {
  device: T;
  kind: "updated";
  previous: MdnsService;
  service: MdnsService;
}
  | {
  device: T;
  kind: "lost";
};
```

One change to the set of devices. A `lost` event carries the device alone, because the service behind it is exactly what is no longer there.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's device type. |

***

### discoverServices()

```ts
function discoverServices<T>(options): MdnsDiscovery<T>;
```

Browse a service type and project what turns up through the consumer's own `classify`.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's device type. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`DiscoverServicesOptions`](#discoverservicesoptions)\<`T`\> | The discovery's inputs. See [DiscoverServicesOptions](#discoverservicesoptions). |

#### Returns

[`MdnsDiscovery`](#mdnsdiscovery)\<`T`\>

A live discovery, to be iterated once and disposed when the consumer is done with it.

#### Throws

Everything the browser's own constructor throws, since the browser is built here: a `TypeError` naming a bad option, and the encoder's `Error` for a
service type the wire cannot carry.

#### Example

```ts
import { discoverServices } from "homebridge-plugin-utils";

await using discovery = discoverServices({

  classify: (service) => { const mac = txtEntries(service.txt).get("mac"); return mac ? { address: service.addresses[0], mac } : null; },
  log: this.log,
  serviceType: "_esphomelib._tcp.local",
  signal: this.signal
});

for await (const event of discovery) {

  this.log.info("%s: %s.", event.kind, event.device.mac);
}
```
