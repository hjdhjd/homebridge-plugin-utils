[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / mdns/browser

# mdns/browser

The multicast DNS querier a plugin browses one service type with: a socket per address family, one timeline, and one synchronous sink.

[MdnsBrowser](#mdnsbrowser) owns the mDNS mechanism and nothing above it. It binds a datagram socket to port 5353 with address reuse for each family it serves, joins
the group on every non-internal interface of that family, asks the browsing question on the RFC 6762 section 5.2 cadence with the known-answer suppression of
section 7.1, caches what the responses carry, re-queries each cached record at the checkpoints section 5.2 names, holds a goodbye (section 10.1) and a flushed
name and type (section 10.2) for one second before deleting, and asks RFC 6763 section 12's follow-up questions for the records a responder did not attach.
Each transition it derives - a service found, updated, or lost - reaches the `onEvent` it was constructed with at the moment it derives it. Devices and
consumer projections belong to `discovery.ts` above this module, and the bytes belong to `message.ts` below it.

**One socket per family.** A reuse-bound socket receives what its siblings receive, so each of these sits beside the operating system's own responder on the
well-known port and a second browser in the same process opens sockets of its own. The multicast interface is set on a socket before each of its sends rather
than one socket being bound per interface, which is what lets a single socket of a family ask the same question on every link of that family. Everything
above the sockets is singular: one cache, one timeline, one cadence, one known-answer list, one set of holds, and one warmup deadline serve every family.

**One timeline.** Every timed action - the browse question's next send, each pending resolution attempt, each cached record's maintenance checkpoints and its
expiry, the one-second holds, the warmup deadline, and the interface poll - is a deadline in one min-heap, and exactly one `clock.schedule` is armed at the
nearest of them. A timer per record would cost dozens of handles to answer the question one heap answers. It is also why the warmup deadline behind
[MdnsBrowser.settled](#settled) lives here although the promise serves the consumer of the discovery surface: a second clock timer up there would cost what this
design refuses. An entry whose subject has been rescheduled is skipped by its generation rather than removed, so the heap never needs a delete.

**One synchronous sink.** The browser's consumer is the discovery surface alone, and it is handed each transition as the browser derives it. That is what
makes [MdnsBrowser.services](#services) a live reading of what the network has said rather than a view of what some consumer's loop has reached, and it leaves
asynchrony to exactly one place: the stream the plugin iterates.

**The interface poll.** The interface set is re-read at every scheduled query, and a link that appears between queries is joined by a poll on the same
timeline. Without the poll, a browser holding nothing in its cache would learn of a new link only at the backed-off browse cadence, which climbs to an hour;
with it, whichever fire joins the link first also asks the browse question on it, so a responder there answers at once.

**Divergences, stated.** A response is read whatever address it came from: RFC 6762 section 11 describes a source check this browser does not perform, on the
reasoning that a querier which ignores answers from off-subnet responders is the likelier field failure on a home network with several links. And membership
is joined on every non-internal interface of the family rather than on a curated set, because a plugin cannot tell the library which link its devices are on.

**Purity per socket.** A socket caches the address records of its own family alone, which is what lets a link-local AAAA carry the zone of the datagram that
delivered it: a zone is the property of an IPv6 datagram's source, and a datagram on the IPv4 socket carries none. RFC 6762 section 20 describes a dual-stack
host as two logical segments with two `.local.` zones, and section 20 also has such a host perform its lookups over both families, which is what this browser
does: one host's addresses of both families meet in one service, in arrival order. Every query goes out on every socket, so a maintenance question over one
family's socket is what harvests the other family's address a dual-stack responder attaches for fate sharing (section 6.2). An IPv6 socket joins its group on
every link-local interface, named to the socket by its interface rather than an address, because a global or unique-local address is never a multicast link.

**The fault rule.** A socket that fails - refused at bind, or dead after it listened - is dropped with a warning and the browser serves what remains, ending
only when no socket remains. That is what makes serving both families safe on a host whose kernel refuses one of them, and it leaves no silent half-death:
the warning is the consumer's signal. The cached records of a dropped family are left to expire at their ttl rather than flushed, because the browser can
neither confirm nor deny them without a socket of that family, and their maintenance questions go out on a surviving socket whose purity drops the answer.

**The zone on a link-local address.** An IPv6 link-local address is only reachable through the link it was heard on, so an AAAA record carrying one is cached
with the zone of the datagram that delivered it, `fe80::...%en0`, and a consumer connects to the string as it reads it. A global or unique-local address stays
as the wire spelled it. A link-local address delivered by a source that carries no zone stays bare, because there is no zone to give it.

**The accepted caveats.** RFC 6762 section 5.2's flush-bit shortcut - stop a question's series once a unique answer arrives - does not apply here: the browse
question asks for shared PTR records, and a resolution asks only for what is still missing, so an answered question stops on its own and an unanswered one
keeps the series the RFC prescribes. And `setMulticastInterface` binds the interface when the kernel takes the datagram, which is inside `send` itself: each
socket comes from `createDgramSocket`, which answers an address-literal destination without a resolver round trip. A send libuv queued against a full send
buffer would still leave under whatever interface is current when it flushes; awaiting each interface's send callback would serialize the sends and turn every
timer fire asynchronous, for a race a few small query packets an hour cannot produce.

**Dependency inversion.** Each socket arrives through [MdnsSocketFactory](#mdnssocketfactory) and the browser calls only the members [MdnsSocket](#mdnssocket) declares, so the
suite drives cadence, cache, holds, and suppression with no network and no wall clock. A consumer substitutes one level up instead, at
[MdnsBrowserFactory](#mdnsbrowserfactory), where the shipped `TestMdnsBrowser` stands in.

## mDNS

### MdnsBrowser

The RFC 6762 querier for one service type: a socket, a cadence, a cache, and the transitions it derives from them.

#### Example

```ts
import { MdnsBrowser } from "homebridge-plugin-utils";

await using browser = new MdnsBrowser({

  log: this.log,
  onEvent: (event) => this.log.info("%s: %s.", event.kind, event.service.instance),
  serviceType: "_esphomelib._tcp.local",
  signal: this.signal
});

await browser.settled;
```

#### Implements

- [`MdnsBrowserLike`](#mdnsbrowserlike)

#### Constructors

##### Constructor

```ts
new MdnsBrowser(options): MdnsBrowser;
```

Construct a browser and bind it. Binding begins immediately; a caller that needs to know when the socket came up awaits [MdnsBrowser.ready](#ready), and one
that wants to give the network a moment to answer awaits [MdnsBrowser.settled](#settled).

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`MdnsBrowserOptions`](#mdnsbrowseroptions) | The browser's inputs. See [MdnsBrowserOptions](#mdnsbrowseroptions). |

###### Returns

[`MdnsBrowser`](#mdnsbrowser)

###### Throws

If `serviceType` does not read as a DNS-SD service type, if `ceilingMs` is not finite or is under a second, if `warmupMs` is not a
positive finite number, or if `ipFamilies` names a family more than once. Each refusal names the option, so a misconfiguration is diagnosable where it was
made.

###### Throws

The encoder's own `Error`, naming the value, when `serviceType` spells a name the wire cannot carry.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves once the first socket of any served family is bound and listening, whichever family that is, and rejects with the lifetime's reason when the lifetime ends before that. Marked handled, so a consumer that never awaits it is not reported as an unhandled rejection. |
| <a id="services"></a> `services` | `readonly` | `ReadonlyMap`\<`string`, [`MdnsService`](#mdnsservice)\> | Every service the cache currently resolves, keyed by the folded instance name. It is the same store the events are derived from, so what a consumer reads here and what it was told cannot disagree. |
| <a id="settled"></a> `settled` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves `warmupMs` after the first query is sent, whether or not any interface carried it, and rejects with the lifetime's reason when the lifetime ends first. The deadline is defined by time rather than by what answered, which is what a one-shot consumer needs: it waits a stated window and then reads [MdnsBrowser.services](#services). A network where nothing could be asked says so through the warning the interface refresh writes. Marked handled. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal representing this browser's lifetime, composed from the caller's and this browser's own. Its reason names why: `"failed"` carrying the socket error as its cause, and `"shutdown"` for a caller's own teardown. |

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

`AsyncDisposable` implementation. Aborts the browser, defaulting to `"shutdown"`, and awaits the socket's own close, so the port is released by the time
the surrounding `await using` scope's next statement runs.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the socket has closed.

###### Implementation of

```ts
MdnsBrowserLike.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the browser and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.

Safe to call more than once: later calls are no-ops, because the underlying signal aborts once.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. See [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

###### Implementation of

[`MdnsBrowserLike`](#mdnsbrowserlike).[`abort`](#abort-1)

***

### MdnsBrowserFactory

How the discovery surface obtains its browser. The production factory is [mdnsBrowserFactory](#mdnsbrowserfactory-1), whose `create` is exactly the constructor call, so
routing construction through it changes no behavior; a consumer's test substitutes the shipped double at this one boundary.

#### Methods

##### create()

```ts
create(options): MdnsBrowserLike;
```

Construct a browser for the supplied options.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`MdnsBrowserOptions`](#mdnsbrowseroptions) | The browser's inputs. See [MdnsBrowserOptions](#mdnsbrowseroptions). |

###### Returns

[`MdnsBrowserLike`](#mdnsbrowserlike)

A live browser.

***

### MdnsBrowserLike

What a browser offers the discovery surface, and what the shipped `TestMdnsBrowser` implements in its place.

#### Extends

- [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose)

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="ready-1"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> |
| <a id="services-1"></a> `services` | `readonly` | `ReadonlyMap`\<`string`, [`MdnsService`](#mdnsservice)\> |
| <a id="settled-1"></a> `settled` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> |
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

### MdnsBrowserOptions

What [MdnsBrowser](#mdnsbrowser) is constructed with.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="ceilingms"></a> `ceilingMs?` | `readonly` | `number` | The longest interval between browsing queries, in milliseconds, and the ceiling a resolution's ladder climbs to. Must be finite and at least one second. Defaults to [MDNS\_QUERY\_CEILING\_MS](#mdns_query_ceiling_ms). |
| <a id="clock"></a> `clock?` | `readonly` | [`Clock`](../clock.md#clock) | The time source every deadline is armed on. Defaults to `systemClock`. |
| <a id="interfaces"></a> `interfaces?` | `readonly` | [`MdnsInterfaceSource`](#mdnsinterfacesource) | Where the host's links are read from. Defaults to `networkInterfaces` from `node:os`. |
| <a id="ipfamilies"></a> `ipFamilies?` | `readonly` | readonly \[[`IpFamily`](../dgram-util.md#ipfamily), [`IpFamily`](../dgram-util.md#ipfamily)\] | The address families to browse. The browser holds one socket per family named: each joins its own family's group on every link of that family, caches its own family's address records alone, and asks its own family's address question in a resolution, so one host's addresses of both families meet in one service. A family whose socket fails is dropped with a warning and the browser serves what remains, ending only when no family remains. The list is the order the sockets are created in and nothing else reads it, and each family may be named only once. Defaults to [MDNS\_DEFAULT\_FAMILIES](#mdns_default_families). |
| <a id="log"></a> `log` | `readonly` | [`HomebridgePluginLogging`](../util.md#homebridgepluginlogging) | Where the browser's own lifecycle lines go. |
| <a id="onevent"></a> `onEvent` | `readonly` | (`event`) => `void` | Where each derived transition goes, synchronously, as the browser derives it. |
| <a id="random"></a> `random?` | `readonly` | () => `number` | The source of the spreads RFC 6762 asks for: the delay before a first query and the jitter on each maintenance checkpoint. Defaults to `Math.random`; a suite supplies a fixed reading so a cadence is exact. |
| <a id="servicetype"></a> `serviceType` | `readonly` | `string` | The service type to browse, spelled as a full DNS-SD type name - `"_esphomelib._tcp.local"`, or a subtype form such as `"_printer._sub._http._tcp.local"`. |
| <a id="signal-2"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The caller's lifetime. Aborting it tears the browser down. |
| <a id="socketfactory"></a> `socketFactory?` | `readonly` | [`MdnsSocketFactory`](#mdnssocketfactory) | How each socket is obtained. The factory is asked once per served family, with that family. Defaults to [mdnsSocketFactory](#mdnssocketfactory-1). |
| <a id="warmupms"></a> `warmupMs?` | `readonly` | `number` | How long after the first query [MdnsBrowser.settled](#settled) resolves, in milliseconds. Must be positive and finite. Defaults to [MDNS\_WARMUP\_MS](#mdns_warmup_ms). |

***

### MdnsService

One service instance, as the cache currently resolves it. Every field is what the most recent records said.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="addresses"></a> `addresses` | `readonly` | readonly `string`[] | Every address of the host, of every family the browser serves, in arrival order and without duplicates, as a consumer connects to it: an IPv6 link-local address carries the zone of the link it was heard on. |
| <a id="host"></a> `host` | `readonly` | [`DnsName`](message.md#dnsname) | The host name the SRV record targets. |
| <a id="instance"></a> `instance` | `readonly` | `string` | The first label of `name`: the free-text instance label RFC 6763 section 4.1.1 defines, which is what a person recognizes the device by. |
| <a id="name"></a> `name` | `readonly` | [`DnsName`](message.md#dnsname) | The full instance name, which is this service's identity and the key it is held under. |
| <a id="port"></a> `port` | `readonly` | `number` | The port the SRV record names. |
| <a id="txt"></a> `txt` | `readonly` | [`DnsTxtRecord`](message.md#dnstxtrecord) | The most recently received TXT record, whose strings are copies rather than views over a datagram. |

***

### MdnsSocket

The members [MdnsBrowser](#mdnsbrowser) calls on a datagram socket, which `node:dgram`'s own `Socket` satisfies structurally.

The interface is narrow rather than the platform class because the double in the browser's own suite implements exactly these members, while the compiler
proves that the real socket carries every one of them at [mdnsSocketFactory](#mdnssocketfactory-1). Each `on` declaration is met by the platform emitter's catch-all
signature, so the event names and their payloads are Node's documented contract rather than something the compiler checks; the opt-in differential suite
against a real responder is what proves them live.

#### Methods

##### addMembership()

```ts
addMembership(group, address?): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `group` | `string` |
| `address?` | `string` |

###### Returns

`void`

##### bind()

```ts
bind(port, callback?): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `port` | `number` |
| `callback?` | () => `void` |

###### Returns

`void`

##### close()

```ts
close(callback?): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `callback?` | () => `void` |

###### Returns

`void`

##### dropMembership()

```ts
dropMembership(group, address?): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `group` | `string` |
| `address?` | `string` |

###### Returns

`void`

##### on()

###### Call Signature

```ts
on(event, listener): this;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"close"` \| `"listening"` |
| `listener` | () => `void` |

###### Returns

`this`

###### Call Signature

```ts
on(event, listener): this;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"error"` |
| `listener` | (`error`) => `void` |

###### Returns

`this`

###### Call Signature

```ts
on(event, listener): this;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"message"` |
| `listener` | (`datagram`, `rinfo`) => `void` |

###### Returns

`this`

##### send()

```ts
send(
   datagram, 
   port, 
   address, 
   callback?
): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `datagram` | `Buffer` |
| `port` | `number` |
| `address` | `string` |
| `callback?` | (`error`) => `void` |

###### Returns

`void`

##### setMulticastInterface()

```ts
setMulticastInterface(address): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `address` | `string` |

###### Returns

`void`

##### setMulticastLoopback()

```ts
setMulticastLoopback(flag): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `flag` | `boolean` |

###### Returns

`void`

##### setMulticastTTL()

```ts
setMulticastTTL(ttl): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `ttl` | `number` |

###### Returns

`void`

***

### MdnsBrowserEvent

```ts
type MdnsBrowserEvent = 
  | {
  kind: "found";
  service: MdnsService;
}
  | {
  kind: "updated";
  previous: MdnsService;
  service: MdnsService;
}
  | {
  kind: "lost";
  service: MdnsService;
};
```

One transition [MdnsBrowser](#mdnsbrowser) derived, handed to `onEvent` as it derived it. A `lost` event carries the last service the instance resolved to, so a
consumer has the thing it is losing rather than only its name.

***

### MdnsInterfaceSource

```ts
type MdnsInterfaceSource = () => NodeJS.Dict<NetworkInterfaceInfo[]>;
```

How [MdnsBrowser](#mdnsbrowser) learns which links exist. Defaults to `networkInterfaces` from `node:os`; a suite substitutes a fixture that answers whatever set the
row is about.

#### Returns

`NodeJS.Dict`\<`NetworkInterfaceInfo`[]\>

The host's interfaces, keyed by interface name, exactly as `node:os` reports them.

***

### MdnsSocketFactory

```ts
type MdnsSocketFactory = (ipFamily) => MdnsSocket;
```

How [MdnsBrowser](#mdnsbrowser) obtains a socket. It is asked once per family the browser serves, with that family. The production factory is
[mdnsSocketFactory](#mdnssocketfactory-1); a suite substitutes one that answers a double.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ipFamily` | [`IpFamily`](../dgram-util.md#ipfamily) | The address family this socket serves. |

#### Returns

[`MdnsSocket`](#mdnssocket)

An unbound socket.

***

### MDNS\_DEFAULT\_FAMILIES

```ts
const MDNS_DEFAULT_FAMILIES: readonly ["ipv4", "ipv6"];
```

The address families a browser serves when [MdnsBrowserOptions.ipFamilies](#ipfamilies) names none: both of them, IPv4 first. RFC 6762 section 20 has a dual-stack
host perform its lookups over both families, and a consumer that wants one names it.

***

### MDNS\_PORT

```ts
const MDNS_PORT: 5353 = 5353;
```

The port multicast DNS is spoken on, which RFC 6762 section 5.2 makes both the destination and the source port of every query.

***

### MDNS\_QUERY\_CEILING\_MS

```ts
const MDNS_QUERY_CEILING_MS: 3600000 = 3600000;
```

The longest interval between browsing queries, in milliseconds: the sixty minutes RFC 6762 section 5.2 offers as the cap a doubling series may stop at, and
the default for [MdnsBrowserOptions.ceilingMs](#ceilingms).

***

### MDNS\_WARMUP\_MS

```ts
const MDNS_WARMUP_MS: 10000 = 10000;
```

How long after the first query [MdnsBrowser.settled](#settled) resolves, in milliseconds, and the default for [MdnsBrowserOptions.warmupMs](#warmupms). It is the
window a one-shot consumer gives a quiet network to answer in before it reads what was found.

***

### mdnsBrowserFactory

```ts
const mdnsBrowserFactory: MdnsBrowserFactory;
```

The production [MdnsBrowserFactory](#mdnsbrowserfactory): one call to the [MdnsBrowser](#mdnsbrowser) constructor.

***

### mdnsSocketFactory

```ts
const mdnsSocketFactory: MdnsSocketFactory;
```

The production [MdnsSocketFactory](#mdnssocketfactory): one reuse-bound datagram socket. Address reuse is what lets this socket share port 5353 with the operating system's
own responder, each receiving every datagram the group delivers.
