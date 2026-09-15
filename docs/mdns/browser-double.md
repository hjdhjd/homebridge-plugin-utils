[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / mdns/browser-double

# mdns/browser-double

A socket-free [MdnsBrowser](browser.md#mdnsbrowser) test double.

A plugin that discovers devices over mDNS has one thing worth asserting about: what its own `classify` makes of a service, what its device map holds
afterwards, and what its loop is told in which order. This module ships the double for that - a [TestMdnsBrowser](#testmdnsbrowser) whose verbs deliver a found, an
updated, and a lost transition on demand, with no socket, no group membership, no clock, and no wire format anywhere in sight.

The double stands in for the browser, it does not reimplement a querier. What it mirrors is the contract a consumer above it can observe: the synchronous
sink, the service store the verbs read and write, the lifetime signal and the reason a verb on a dead browser throws, and the readiness and warmup promises
including their rejection when the lifetime ends first. What stays with the real class and its own suite is everything the protocol owns - the cadence, the
known-answer suppression, the cache and its maintenance, the holds, resolution, and membership.

The verbs refuse a misuse rather than modeling it: finding an instance that is already present, or updating or losing one that was never found, is a test
describing a sequence no browser produces, and it throws an `Error` saying so.

[makeService](#makeservice) sits beside the double as the composer of what those verbs deliver: it reads one resolved service off the very records
[makeServiceRecords](message-builders.md#makeservicerecords) builds for the same options, so an advertisement put on the wire and a service handed to
a verb describe one instance rather than two spellings of it. It lives here rather than with the record builders because `message-builders.ts` depends
downward on the wire format alone and knows nothing of a browser's resolved shape.

Signatures come from the browser's own exported types, imported for their types alone, so a verb here cannot drift from the contract it stands in for without
the compiler saying so. That type-only edge is also what keeps this module free of `node:dgram`: a consumer's test loads the double without opening a socket.

## Testing

### TestMdnsBrowser

A socket-free [MdnsBrowser](browser.md#mdnsbrowser) double: it delivers the transitions a test names, in the order the test names them.

#### Example

```ts
import { TestMdnsBrowserFactory } from "homebridge-plugin-utils/testing";

const factory = new TestMdnsBrowserFactory();
const discovery = discoverServices({ browserFactory: factory, classify, log, serviceType: "_esphomelib._tcp.local", signal });
const browser = expectAt(factory.createCalls, 0, "the browser the discovery built").browser;

// The consumer's own classify, snapshot, and ordering, exercised with no network at all.
browser.found(service);
assert.equal(discovery.devices.size, 1);
```

#### Implements

- [`MdnsBrowserLike`](browser.md#mdnsbrowserlike)

#### Constructors

##### Constructor

```ts
new TestMdnsBrowser(options): TestMdnsBrowser;
```

Construct a double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions) | The browser options the consumer passed, exactly as the real class receives them. See [mdns/browser!MdnsBrowserOptions](browser.md#mdnsbrowseroptions). |

###### Returns

[`TestMdnsBrowser`](#testmdnsbrowser)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="options"></a> `options` | `readonly` | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions) | The options this double was constructed with, exposed so a test can assert on what the consumer asked for - its service type above all. |
| <a id="ready"></a> `ready` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Mirrors [MdnsBrowser.ready](browser.md#ready), and marked handled as that one is. A double is listening the moment it exists, so this resolves at construction; one built over a lifetime that had already ended rejects with that lifetime's reason, exactly as the real class does when it never gets to bind. |
| <a id="services"></a> `services` | `readonly` | `ReadonlyMap`\<`string`, [`MdnsService`](browser.md#mdnsservice)\> | The services this double currently holds, keyed by the folded instance name. It is the same store the verbs read and write, so what a test reads and what a delivery meets cannot disagree. |
| <a id="settled"></a> `settled` | `readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Mirrors [MdnsBrowser.settled](browser.md#settled), and marked handled as that one is. It stays pending until [TestMdnsBrowser.settle](#settle) is called, because when a warmup is over is the test's decision here rather than a clock's, and it rejects with the lifetime's reason when the lifetime ends first. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal representing this double's lifetime, composed from the caller's and this double's own, mirroring the real class's composition. |

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

`AsyncDisposable` implementation, mirroring the real class's: it aborts the double, defaulting to `"shutdown"`. There is no socket to wait on, so it
resolves once the abort has run.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the abort has run.

###### Implementation of

```ts
MdnsBrowserLike.[asyncDispose]
```

##### abort()

```ts
abort(reason?): void;
```

Abort the double, mirroring [MdnsBrowser.abort](browser.md#abort): it defaults to `HbpuAbortError("shutdown")` when no reason is supplied,
and explicit reasons pass through unchanged. Safe to call more than once. Afterwards every delivery verb refuses.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. See [HbpuAbortError](../util.md#hbpuaborterror). |

###### Returns

`void`

###### Implementation of

[`MdnsBrowserLike`](browser.md#mdnsbrowserlike).[`abort`](browser.md#abort-1)

##### found()

```ts
found(service): void;
```

Deliver a `found` transition for a service the double is not already holding.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service` | [`MdnsService`](browser.md#mdnsservice) | The service found. |

###### Returns

`void`

###### Throws

The lifetime's reason once the double has aborted, and an `Error` naming the instance when it is already present.

##### lost()

```ts
lost(name): void;
```

Deliver a `lost` transition for a service the double is holding, carrying the last service it held for the instance.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | [`DnsName`](message.md#dnsname) | The full instance name that is gone. |

###### Returns

`void`

###### Throws

The lifetime's reason once the double has aborted, and an `Error` naming the instance when it is not present.

##### settle()

```ts
settle(): void;
```

Resolve [TestMdnsBrowser.settled](#settled), which is this double's stand-in for the real browser's warmup window elapsing. A double whose lifetime has already
ended has a rejected promise, so a call here is inert rather than a second settlement.

###### Returns

`void`

##### updated()

```ts
updated(service): void;
```

Deliver an `updated` transition for a service the double is holding, carrying what it held as `previous`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service` | [`MdnsService`](browser.md#mdnsservice) | The service as it currently stands. |

###### Returns

`void`

###### Throws

The lifetime's reason once the double has aborted, and an `Error` naming the instance when it is not present.

***

### TestMdnsBrowserFactory

An [MdnsBrowserFactory](browser.md#mdnsbrowserfactory) double that records every `create` call and answers a fresh [TestMdnsBrowser](#testmdnsbrowser), mirroring the
create-call-recording discipline `TestRecordingProcessFactory` and `TestLogSocketFactory` use. A test reads the recorded browser to drive it.

#### Implements

- [`MdnsBrowserFactory`](browser.md#mdnsbrowserfactory)

#### Constructors

##### Constructor

```ts
new TestMdnsBrowserFactory(): TestMdnsBrowserFactory;
```

###### Returns

[`TestMdnsBrowserFactory`](#testmdnsbrowserfactory)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="createcalls"></a> `createCalls` | `readonly` | \{ `browser`: [`TestMdnsBrowser`](#testmdnsbrowser); `options`: [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions); \}[] | `[]` | Every create call's options and the browser it answered, in order, so a test can assert the boundary was reached with the options it expected and can drive the browser that came back. |

#### Methods

##### create()

```ts
create(options): MdnsBrowserLike;
```

Record the create call and answer a fresh double.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`MdnsBrowserOptions`](browser.md#mdnsbrowseroptions) | The browser options the consumer passed. |

###### Returns

[`MdnsBrowserLike`](browser.md#mdnsbrowserlike)

The browser double.

###### Implementation of

[`MdnsBrowserFactory`](browser.md#mdnsbrowserfactory).[`create`](browser.md#create)

***

### makeService()

```ts
function makeService(options): MdnsService;
```

Compose the resolved service a browser derives from the records [makeServiceRecords](message-builders.md#makeservicerecords) builds for the same
options, which is what a row hands the delivery verbs of [TestMdnsBrowser](#testmdnsbrowser).

Every name is read off those records rather than spelled a second time here: the PTR's target is the instance name, the SRV's target and port are the host and
the port, and the TXT record is the TXT record. A test that advertises an instance with the record builder and delivers it with this one therefore describes
one instance by construction. `addresses` is a fresh copy of what was named, and the type refuses a service with none, which is the browser's own rule that an
instance resolves only once its host has an address.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`MdnsServiceFixture`](message-builders.md#mdnsservicefixture) & \{ `addresses`: readonly \[`string`, `string`\]; \} | The instance, carrying at least one address. See [MdnsServiceFixture](message-builders.md#mdnsservicefixture). |

#### Returns

[`MdnsService`](browser.md#mdnsservice)

The service as a browser would have derived it from that advertisement.
