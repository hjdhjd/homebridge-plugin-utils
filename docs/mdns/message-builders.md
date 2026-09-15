[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / mdns/message-builders

# mdns/message-builders

Shared DNS record and response builders.

The DNS-SD vocabulary every consumer's tests compose service discovery from - the library's own message suite, and, once it exists, the mDNS browser's suite
and downstream plugins alike. A
factory per record kind, [makeResponse](#makeresponse) to encode a set of records as a response, and [makeServiceRecords](#makeservicerecords) for the PTR, SRV, TXT, and address
records that together advertise one service instance. Ships on the `homebridge-plugin-utils/testing` entry point beside the other test doubles, so a consumer
builds real mDNS bytes without hand-rolling a header or re-deriving name compression.

The response builder writes through the production encoder rather than assembling bytes of its own. That is the whole point of building this on the testing
entry instead of inside a suite: a fixture and the code under test would otherwise encode the same wire format twice, and the day the two disagree the suite
would prove nothing.

**Wire-format constants.** Anything the production reader or writer consults lives in `message.ts` and is imported here, so one definition serves both. The
recommended TTLs below are the other case: production reads a ttl off the wire and never chooses one, so the RFC 6762 section 10 defaults are test-only values
and live with the builders.

## Testing

### MdnsServiceFixture

What one service instance is advertised by: the names, the endpoint, the TXT strings, and every address of the host. [makeServiceRecords](#makeservicerecords) builds the
records of it and `makeService` on the testing entry point composes the resolved service a browser derives from those same records, so a test that advertises
with one and delivers with the other describes one instance by construction.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="addresses"></a> `addresses` | `readonly` | readonly `string`[] | Every address of the host, IPv4 in dotted decimal or IPv6 in the RFC 4291 text form without a zone. Each is carried by a record of its own, an A or an AAAA by that address's own spelling. |
| <a id="domain"></a> `domain?` | `readonly` | `string` \| [`DnsName`](message.md#dnsname) | The domain every name sits under, as labels or as a flat string. Defaults to `"local"`. |
| <a id="host"></a> `host` | `readonly` | `string` \| [`DnsName`](message.md#dnsname) | The host's own label, as labels or as a flat string, placed under the domain. |
| <a id="instance"></a> `instance` | `readonly` | `string` | The instance label, taken verbatim as one label: RFC 6763 section 4.1.1 makes it free text, so a dot in it is part of the name. |
| <a id="port"></a> `port` | `readonly` | `number` | The port the service answers on. |
| <a id="servicetype"></a> `serviceType` | `readonly` | `string` \| [`DnsName`](message.md#dnsname) | The service type, as labels or as a flat string (`"_hap._tcp"`), placed under the domain. |
| <a id="strings"></a> `strings?` | `readonly` | readonly (`string` \| `Buffer`\<`ArrayBufferLike`\>)[] | The TXT record's strings. Defaults to none. |

***

### makeAaaaRecord()

```ts
function makeAaaaRecord(options): DnsAaaaRecord;
```

Build an AAAA record.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `address`: `string`; `flush?`: `boolean`; `name`: `string` \| [`DnsName`](message.md#dnsname); `ttl?`: `number`; \} | The record. |
| `options.address` | `string` | The IPv6 address in the RFC 4291 text form, read through [parseIpv6](message.md#parseipv6) so a zone suffix or a dotted tail is refused here; a record parsed back carries the RFC 5952 form. |
| `options.flush?` | `boolean` | Whether the cache-flush bit is set. Defaults to `false`. |
| `options.name` | `string` \| [`DnsName`](message.md#dnsname) | The owner name, as labels or as a flat string. |
| `options.ttl?` | `number` | The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a host name. |

#### Returns

[`DnsAaaaRecord`](message.md#dnsaaaarecord)

The record.

***

### makeARecord()

```ts
function makeARecord(options): DnsARecord;
```

Build an A record.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `address`: `string`; `flush?`: `boolean`; `name`: `string` \| [`DnsName`](message.md#dnsname); `ttl?`: `number`; \} | The record. |
| `options.address` | `string` | The IPv4 address in dotted decimal, read through [parseIpv4](message.md#parseipv4) so a spelling the wire cannot carry is refused here. |
| `options.flush?` | `boolean` | Whether the cache-flush bit is set. Defaults to `false`. |
| `options.name` | `string` \| [`DnsName`](message.md#dnsname) | The owner name, as labels or as a flat string. |
| `options.ttl?` | `number` | The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a host name. |

#### Returns

[`DnsARecord`](message.md#dnsarecord)

The record.

***

### makeOtherRecord()

```ts
function makeOtherRecord(options): DnsOtherRecord;
```

Build a record of a type the union does not model, carrying its rdata verbatim.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `flush?`: `boolean`; `name`: `string` \| [`DnsName`](message.md#dnsname); `rdata`: `Buffer`; `ttl?`: `number`; `type`: `number`; \} | The record. |
| `options.flush?` | `boolean` | Whether the cache-flush bit is set. Defaults to `false`. |
| `options.name` | `string` \| [`DnsName`](message.md#dnsname) | The owner name, as labels or as a flat string. |
| `options.rdata` | `Buffer` | The rdata bytes, written and read back untouched. |
| `options.ttl?` | `number` | The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a host name. |
| `options.type` | `number` | The wire type. The encoder refuses a type the union models as an arm of its own. |

#### Returns

[`DnsOtherRecord`](message.md#dnsotherrecord)

The record.

***

### makePtrRecord()

```ts
function makePtrRecord(options): DnsPtrRecord;
```

Build a PTR record.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `flush?`: `boolean`; `name`: `string` \| [`DnsName`](message.md#dnsname); `target`: `string` \| [`DnsName`](message.md#dnsname); `ttl?`: `number`; \} | The record. |
| `options.flush?` | `boolean` | Whether the cache-flush bit is set. Defaults to `false`, which is what a PTR always carries in practice: it is a shared record, and RFC 6762 section 10.2 reserves the bit for the unique ones. |
| `options.name` | `string` \| [`DnsName`](message.md#dnsname) | The owner name, as labels or as a flat string. |
| `options.target` | `string` \| [`DnsName`](message.md#dnsname) | The name pointed at, as labels or as a flat string. |
| `options.ttl?` | `number` | The ttl in seconds. Defaults to the 4500 RFC 6762 section 10 recommends for a record that names no host. |

#### Returns

[`DnsPtrRecord`](message.md#dnsptrrecord)

The record.

***

### makeResponse()

```ts
function makeResponse(options?): Buffer;
```

Encode a set of records as a response datagram, through the production encoder.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `additionals?`: readonly [`DnsRecord`](message.md#dnsrecord)[]; `answers?`: readonly [`DnsRecord`](message.md#dnsrecord)[]; `authorities?`: readonly [`DnsRecord`](message.md#dnsrecord)[]; `truncated?`: `boolean`; \} | The response. |
| `options.additionals?` | readonly [`DnsRecord`](message.md#dnsrecord)[] | The additional section. Defaults to empty. |
| `options.answers?` | readonly [`DnsRecord`](message.md#dnsrecord)[] | The answer section. Defaults to empty. |
| `options.authorities?` | readonly [`DnsRecord`](message.md#dnsrecord)[] | The authority section. Defaults to empty. |
| `options.truncated?` | `boolean` | Whether TC is set. Defaults to `false`. |

#### Returns

`Buffer`

The datagram, with QR and AA set as a multicast response carries them.

***

### makeServiceRecords()

```ts
function makeServiceRecords(options): readonly DnsRecord[];
```

Build the records that advertise one service instance: the PTR from the service type to the instance, the SRV from the instance to the host, the TXT on the
instance, and one address record per address of the host, each an A or an AAAA by its own address's spelling - in that order, which is the order a responder
sends them and the order the compression pointers of an encoded response read most naturally.

The PTR is never flushed. It is a shared record, one of many under the same service name, and RFC 6762 section 10.2 reserves the cache-flush bit for records
whose name and type belong to one responder alone. `flush` therefore reaches the SRV, the TXT, and each address record only.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`MdnsServiceFixture`](#mdnsservicefixture) & \{ `flush?`: `boolean`; \} | The instance. See [MdnsServiceFixture](#mdnsservicefixture). |

#### Returns

readonly [`DnsRecord`](message.md#dnsrecord)[]

The records that advertise the instance, in advertising order. An instance named with no address is its PTR, SRV, and TXT alone.

***

### makeSrvRecord()

```ts
function makeSrvRecord(options): DnsSrvRecord;
```

Build an SRV record.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `flush?`: `boolean`; `name`: `string` \| [`DnsName`](message.md#dnsname); `port`: `number`; `priority?`: `number`; `target`: `string` \| [`DnsName`](message.md#dnsname); `ttl?`: `number`; `weight?`: `number`; \} | The record. |
| `options.flush?` | `boolean` | Whether the cache-flush bit is set. Defaults to `false`. |
| `options.name` | `string` \| [`DnsName`](message.md#dnsname) | The owner name, as labels or as a flat string. |
| `options.port` | `number` | The port the service answers on. |
| `options.priority?` | `number` | The RFC 2782 priority. Defaults to 0. |
| `options.target` | `string` \| [`DnsName`](message.md#dnsname) | The host name the service runs on, as labels or as a flat string. |
| `options.ttl?` | `number` | The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a record whose rdata names a host. |
| `options.weight?` | `number` | The RFC 2782 weight. Defaults to 0. |

#### Returns

[`DnsSrvRecord`](message.md#dnssrvrecord)

The record.

***

### makeTxtRecord()

```ts
function makeTxtRecord(options): DnsTxtRecord;
```

Build a TXT record.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `flush?`: `boolean`; `name`: `string` \| [`DnsName`](message.md#dnsname); `strings?`: readonly (`string` \| `Buffer`\<`ArrayBufferLike`\>)[]; `ttl?`: `number`; \} | The record. |
| `options.flush?` | `boolean` | Whether the cache-flush bit is set. Defaults to `false`. |
| `options.name` | `string` \| [`DnsName`](message.md#dnsname) | The owner name, as labels or as a flat string. |
| `options.strings?` | readonly (`string` \| `Buffer`\<`ArrayBufferLike`\>)[] | The constituent strings. A string is encoded as UTF-8 and a Buffer passes through untouched, which is how a test spells a binary value. Defaults to none, which the encoder writes as the single empty string RFC 6763 section 6.1 calls for. |
| `options.ttl?` | `number` | The ttl in seconds. Defaults to the 4500 RFC 6762 section 10 recommends for a record that names no host. |

#### Returns

[`DnsTxtRecord`](message.md#dnstxtrecord)

The record.
