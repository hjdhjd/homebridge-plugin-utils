[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / mdns/message

# mdns/message

The DNS message vocabulary, parser, and encoder the mDNS browser composes over.

One datagram goes in and one readonly [DnsMessage](#dnsmessage) or `null` comes out. [encodeDnsMessage](#encodednsmessage) is the single encoder for the whole record union,
compressing names as it writes. [buildMdnsQuery](#buildmdnsquery) splits a query whose known answers overflow a packet. The name readings ([parseDnsName](#parsednsname),
[formatDnsName](#formatdnsname), [dnsNameKey](#dnsnamekey), [dnsNamesEqual](#dnsnamesequal)) and [txtEntries](#txtentries) are the presentations a consumer applies to what it parsed. Sockets,
cadence, caches, service types, and devices belong to the browser above this module; the wire is all that lives here.

The two directions answer a malformed input differently, and the difference is the design rather than an inconsistency. The parser reads an untrusted wire at
the rate a LAN answers a service-enumeration query, so every length, offset, count, and pointer is checked against the datagram and every rejection collapses
to one `null` rather than an exception, the posture `findBox` takes in `ffmpeg/fmp4.ts`. The encoder writes what the library itself composed, so a label over
63 bytes, a name over 255, a TXT string over 255, or an address that does not parse is a programming error: it throws an `Error` naming the offending value,
the policy `mqtt-topics.ts` applies to a malformed catalog. The two address readers, [parseIpv4](#parseipv4) and [parseIpv6](#parseipv6), are public, so the record
builders on the testing entry check an address at construction against the one grammar the encoder writes from, and a refusal names the reader and the value.

The module carries no runtime import. Its one import is a type, erased at compile time, and that is deliberate rather than an accident of its size: the shipped
builders on the testing entry and the browser both reach it, and a value edge to `./util.ts` would carry the library's timer and signal machinery in behind a
module that only reads and writes bytes.

Name compression works in both directions. The writer emits a two-byte pointer wherever an earlier occurrence of a name's suffix already sits in the same
message, inside the rdata of a PTR and an SRV as RFC 6762 section 18.14 asks as well as on the owner names; the reader follows a pointer only backward, so a
chain ends by construction rather than by a hop counter.

## mDNS

### DnsAaaaRecord

An AAAA record: one IPv6 address, presented in the RFC 5952 text form - lowercase hexadecimal, leading zeros dropped, and the first longest run of two or more
zero groups written as `::`. A single zero group is never compressed, so the presentation is stable enough to compare as text.

#### Extends

- `DnsRecordBase`

#### Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="address"></a> `address` | `readonly` | `string` | - |
| <a id="flush"></a> `flush` | `readonly` | `boolean` | `DnsRecordBase.flush` |
| <a id="kind"></a> `kind` | `readonly` | `"aaaa"` | - |
| <a id="name"></a> `name` | `readonly` | [`DnsName`](#dnsname) | `DnsRecordBase.name` |
| <a id="ttl"></a> `ttl` | `readonly` | `number` | `DnsRecordBase.ttl` |

***

### DnsARecord

An A record: one IPv4 address, presented in dotted decimal.

#### Extends

- `DnsRecordBase`

#### Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="address-1"></a> `address` | `readonly` | `string` | - |
| <a id="flush-1"></a> `flush` | `readonly` | `boolean` | `DnsRecordBase.flush` |
| <a id="kind-1"></a> `kind` | `readonly` | `"a"` | - |
| <a id="name-1"></a> `name` | `readonly` | [`DnsName`](#dnsname) | `DnsRecordBase.name` |
| <a id="ttl-1"></a> `ttl` | `readonly` | `number` | `DnsRecordBase.ttl` |

***

### DnsMessage

One parsed DNS message.

Several things the wire carries are deliberately absent. The header bits RFC 6762 section 18 tells a querier to ignore on reception - AA, RD, RA, Z, AD, and CD
- are not surfaced, because a reader that cannot act on them has no use for them. The class of a question or a record is not surfaced either: multicast DNS
carries the Internet class alone, and the top bit that shares the field is surfaced as `unicastResponse` and `flush`. And a message whose OPCODE or RCODE is
nonzero never becomes a `DnsMessage` at all - RFC 6762 sections 18.3 and 18.11 tell a querier to ignore it, which for a reader is a rejection.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="additionals"></a> `additionals` | `readonly` | readonly [`DnsRecord`](#dnsrecord)[] |
| <a id="answers"></a> `answers` | `readonly` | readonly [`DnsRecord`](#dnsrecord)[] |
| <a id="authorities"></a> `authorities` | `readonly` | readonly [`DnsRecord`](#dnsrecord)[] |
| <a id="id"></a> `id` | `readonly` | `number` |
| <a id="questions"></a> `questions` | `readonly` | readonly [`DnsQuestion`](#dnsquestion)[] |
| <a id="response"></a> `response` | `readonly` | `boolean` |
| <a id="truncated"></a> `truncated` | `readonly` | `boolean` |

***

### DnsOtherRecord

Every type this module does not model, carrying its wire type and its rdata bytes untouched.

The rdata is never decompressed. RFC 6762 section 18.14 lists types whose rdata may carry a compressed name - NS, CNAME, SOA, and NSEC among them - and a
DNS-SD querier reads none of them, so a name inside this rdata reaches a consumer exactly as the wire spelled it, pointer bytes and all. The rdata is a view
over the datagram rather than a copy, so a consumer holding one past the receive that produced it copies with `Buffer.from`.

#### Extends

- `DnsRecordBase`

#### Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="flush-2"></a> `flush` | `readonly` | `boolean` | `DnsRecordBase.flush` |
| <a id="kind-2"></a> `kind` | `readonly` | `"other"` | - |
| <a id="name-2"></a> `name` | `readonly` | [`DnsName`](#dnsname) | `DnsRecordBase.name` |
| <a id="rdata"></a> `rdata` | `readonly` | `Buffer` | - |
| <a id="ttl-2"></a> `ttl` | `readonly` | `number` | `DnsRecordBase.ttl` |
| <a id="type"></a> `type` | `readonly` | `number` | - |

***

### DnsPtrRecord

A PTR record: one target name, decompressed by the parser and compressed again by the encoder.

#### Extends

- `DnsRecordBase`

#### Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="flush-3"></a> `flush` | `readonly` | `boolean` | `DnsRecordBase.flush` |
| <a id="kind-3"></a> `kind` | `readonly` | `"ptr"` | - |
| <a id="name-3"></a> `name` | `readonly` | [`DnsName`](#dnsname) | `DnsRecordBase.name` |
| <a id="target"></a> `target` | `readonly` | [`DnsName`](#dnsname) | - |
| <a id="ttl-3"></a> `ttl` | `readonly` | `number` | `DnsRecordBase.ttl` |

***

### DnsQuestion

One question of a message: the name asked about, the wire type asked for, and whether the asker set the top bit of the class field to request a unicast
response (RFC 6762 section 18.12).

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="name-4"></a> `name` | `readonly` | [`DnsName`](#dnsname) |
| <a id="type-1"></a> `type` | `readonly` | `number` |
| <a id="unicastresponse"></a> `unicastResponse` | `readonly` | `boolean` |

***

### DnsSrvRecord

An SRV record: the RFC 2782 priority, weight, and port, and the target name they lead to, which mDNS compresses like any other name in rdata it lists.

#### Extends

- `DnsRecordBase`

#### Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="flush-4"></a> `flush` | `readonly` | `boolean` | `DnsRecordBase.flush` |
| <a id="kind-4"></a> `kind` | `readonly` | `"srv"` | - |
| <a id="name-5"></a> `name` | `readonly` | [`DnsName`](#dnsname) | `DnsRecordBase.name` |
| <a id="port"></a> `port` | `readonly` | `number` | - |
| <a id="priority"></a> `priority` | `readonly` | `number` | - |
| <a id="target-1"></a> `target` | `readonly` | [`DnsName`](#dnsname) | - |
| <a id="ttl-4"></a> `ttl` | `readonly` | `number` | `DnsRecordBase.ttl` |
| <a id="weight"></a> `weight` | `readonly` | `number` | - |

***

### DnsTxtRecord

A TXT record: its constituent strings exactly as they arrived, undecoded, because RFC 6763 section 6.5 makes a value opaque binary. [txtEntries](#txtentries) is the
key-value reading for the consumers that want text.

Each entry is a view over the datagram it was parsed from rather than a copy, so a consumer holding one past the receive that produced it copies with
`Buffer.from`.

#### Extends

- `DnsRecordBase`

#### Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="flush-5"></a> `flush` | `readonly` | `boolean` | `DnsRecordBase.flush` |
| <a id="kind-5"></a> `kind` | `readonly` | `"txt"` | - |
| <a id="name-6"></a> `name` | `readonly` | [`DnsName`](#dnsname) | `DnsRecordBase.name` |
| <a id="strings"></a> `strings` | `readonly` | readonly `Buffer`\<`ArrayBufferLike`\>[] | - |
| <a id="ttl-5"></a> `ttl` | `readonly` | `number` | `DnsRecordBase.ttl` |

***

### DnsMessageInit

```ts
type DnsMessageInit = Partial<DnsMessage>;
```

What [encodeDnsMessage](#encodednsmessage) accepts: a [DnsMessage](#dnsmessage) with every member optional. Every section defaults to empty, `id` to 0, and `response` and
`truncated` to `false`, so a message that came out of [parseDnsMessage](#parsednsmessage) is itself a valid input and the two shapes cannot drift apart.

***

### DnsName

```ts
type DnsName = readonly string[];
```

A name as its labels, each decoded as UTF-8, with the root as the empty array.

A name is kept as labels rather than as one escaped string because a DNS-SD instance label is free text and may itself contain dots (RFC 6763 section 4.1.1),
so a flat string cannot be taken apart again without a convention. [formatDnsName](#formatdnsname) is the presentation for the places a flat string is what is wanted,
and [parseDnsName](#parsednsname) reads one back.

***

### DnsRecord

```ts
type DnsRecord = 
  | DnsARecord
  | DnsAaaaRecord
  | DnsOtherRecord
  | DnsPtrRecord
  | DnsSrvRecord
  | DnsTxtRecord;
```

One resource record of a message, tagged by `kind` with the shape its rdata was read into.

***

### DnsRecordKind

```ts
type DnsRecordKind = DnsRecord["kind"];
```

The tag that tells one arm of [DnsRecord](#dnsrecord) from another.

***

### DNS\_CLASS\_IN

```ts
const DNS_CLASS_IN: 1 = 1;
```

The Internet class, the only class multicast DNS carries. The top bit of a class field on the wire is not part of it: on a question it asks for a unicast
response and on a record it marks a cache flush, and both reach a reader as their own boolean.

***

### DNS\_TYPE\_A

```ts
const DNS_TYPE_A: 1 = 1;
```

The DNS wire type of an A record: one IPv4 address, four bytes of rdata.

***

### DNS\_TYPE\_AAAA

```ts
const DNS_TYPE_AAAA: 28 = 28;
```

The DNS wire type of an AAAA record: one IPv6 address, sixteen bytes of rdata.

***

### DNS\_TYPE\_PTR

```ts
const DNS_TYPE_PTR: 12 = 12;
```

The DNS wire type of a PTR record: one name, which mDNS compresses. DNS-SD names a service type with one, pointing at each instance of it.

***

### DNS\_TYPE\_SRV

```ts
const DNS_TYPE_SRV: 33 = 33;
```

The DNS wire type of an SRV record: priority, weight, and port, then a target name, which mDNS compresses.

***

### DNS\_TYPE\_TXT

```ts
const DNS_TYPE_TXT: 16 = 16;
```

The DNS wire type of a TXT record: a sequence of length-prefixed strings. DNS-SD reads the RFC 6763 key-value pairs of one through [txtEntries](#txtentries).

***

### MDNS\_PACKET\_LIMIT

```ts
const MDNS_PACKET_LIMIT: 1440 = 1440;
```

The largest packet [buildMdnsQuery](#buildmdnsquery) emits unless a caller names its own limit: the payload that fits an Ethernet frame under either address family's IP
and UDP headers, well inside the 9000-byte ceiling RFC 6762 section 17 sets, and the same value Homebridge's own advertiser sends with.

***

### buildMdnsQuery()

```ts
function buildMdnsQuery(options): Buffer<ArrayBufferLike>[];
```

Build the packets of one multicast query, splitting its known answers across as many as they need.

A query carries id 0 and no flag bit (RFC 6762 sections 18.1 and 18.2), its questions in the first packet only, and its known answers in the answer section
with the cache-flush bit clear on every one of them (section 10.2). When the next known answer would push a packet over `limit`, section 7.2's split applies:
the packet so far goes out with TC set, and a following packet carrying no question continues the list. Every packet is its own compression scope, since a
pointer can only reach within the packet that carries it.

An answer too large for a packet of its own is omitted rather than sent in a form no reader could use. Its only cost is one response this query does not
suppress, which is the same cost a querier pays for every answer it has not cached yet.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `knownAnswers?`: readonly [`DnsRecord`](#dnsrecord)[]; `limit?`: `number`; `questions`: readonly [`DnsQuestion`](#dnsquestion)[]; \} | The query. |
| `options.knownAnswers?` | readonly [`DnsRecord`](#dnsrecord)[] | The records the querier already holds, offered in order and delivered in that order across the packets. Defaults to none. |
| `options.limit?` | `number` | The largest packet to emit, in bytes. Defaults to [MDNS\_PACKET\_LIMIT](#mdns_packet_limit). |
| `options.questions` | readonly [`DnsQuestion`](#dnsquestion)[] | The questions, carried by the first packet. |

#### Returns

`Buffer`\<`ArrayBufferLike`\>[]

The packets, in the order they are to be sent. Always at least one.

#### Throws

An `Error` when the questions do not fit `limit`, since a query that cannot ask anything is a composed-input error rather than a split to make.

***

### dnsNameKey()

```ts
function dnsNameKey(name): string;
```

The canonical form of a name for comparison and for keying a cache: [formatDnsName](#formatdnsname) with the ASCII letters A to Z folded to lowercase and nothing else
folded, which is exactly the comparison RFC 6762 section 16 defines.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | [`DnsName`](#dnsname) | The name as its labels. |

#### Returns

`string`

The folded presentation, equal for two names the protocol considers the same.

***

### dnsNamesEqual()

```ts
function dnsNamesEqual(a, b): boolean;
```

Whether two names are the same under the RFC 6762 section 16 fold: the same number of labels, and each pair equal once the ASCII letters A to Z are folded.

Computed label by label rather than by building either name's key, so a comparison that fails at the first label costs nothing beyond it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `a` | [`DnsName`](#dnsname) | One name. |
| `b` | [`DnsName`](#dnsname) | The other name. |

#### Returns

`boolean`

Whether the protocol considers them the same name.

***

### dnsRecordType()

```ts
function dnsRecordType(record): number;
```

The wire type a record carries: a modeled arm answers the type the encoder writes for its kind, and an `other` record answers the type it was read with.

This is the one reading of a record's type outside the encoder, and it reads the encoder's own table rather than a second copy of it. A cache keyed by name and
type, and a question asking for one record again, both name the same number the writer would put on the wire.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `record` | [`DnsRecord`](#dnsrecord) | The record. |

#### Returns

`number`

The DNS wire type.

***

### encodeDnsMessage()

```ts
function encodeDnsMessage(init): Buffer;
```

Write a message to bytes.

Names are compressed wherever an earlier occurrence of a suffix already sits in the message, on owner names and inside the rdata of PTR and SRV records alike,
as RFC 6762 section 18.14 asks. A response sets QR and AA together, since a multicast response is authoritative by definition (section 18.4).

What a caller composed and the wire cannot carry throws an `Error` naming the offending value: an empty label, a label over 63 bytes, a name over 255 wire
bytes, a TXT string over 255 bytes, an address that is not four decimal octets or eight hexadecimal groups (the `TypeError` of [parseIpv4](#parseipv4) or
[parseIpv6](#parseipv6), which read the address), and an `other` record wearing a type the union models as its own arm. A numeric field wider than the wire allows
it - `id`, `ttl`, `port`, `priority`, `weight`, and a type - throws the platform's own range error from the typed write, which already names the value, so no
separate check restates it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`DnsMessageInit`](#dnsmessageinit) | The message. Every section defaults to empty, `id` to 0, and `response` and `truncated` to `false`. |

#### Returns

`Buffer`

The encoded datagram.

***

### formatDnsName()

```ts
function formatDnsName(name): string;
```

Present a name as one flat string: the labels joined by dots, with every dot and backslash inside a label escaped by a backslash as RFC 6763 section 4.3
recommends. There is no trailing dot, and the root reads as the empty string.

[parseDnsName](#parsednsname) reads the result back to the name it was given, for every name whose labels are non-empty.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | [`DnsName`](#dnsname) | The name as its labels. |

#### Returns

`string`

The escaped, dot-joined presentation.

***

### parseDnsMessage()

```ts
function parseDnsMessage(datagram): Nullable<DnsMessage>;
```

Read one datagram into a message.

Every rejection reason collapses to one `null` - a short header, a nonzero OPCODE or RCODE, a section count with no bytes behind it, a name that runs off the
end or points forward, an rdata that overruns the datagram, a record whose rdata does not match its type - so a caller cannot tell from the return value which
one occurred, exactly as `findBox` does in `ffmpeg/fmp4.ts`. That is what the receive path wants: a LAN answers a service-enumeration query at roughly a
hundred packets a second, and a reader that never throws costs nothing to call on all of them.

The `strings` of a TXT record and the `rdata` of an `other` record are views over `datagram` rather than copies, so a caller holding either past the receive
that produced it copies with `Buffer.from`.

Records are decoded from every section whether the message is a query or a response. A query's answer section carries its sender's known answers, which a
querier may read but must not cache (RFC 6762 section 7.1) - that rule belongs to the browser holding the cache, not to this reader.

Bytes after the last record of the last section are ignored.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `datagram` | `Buffer` | One complete UDP datagram, as received. |

#### Returns

[`Nullable`](../util.md#nullable)\<[`DnsMessage`](#dnsmessage)\>

The message, or `null` when the datagram is not one this reader can read in full.

***

### parseDnsName()

```ts
function parseDnsName(text): DnsName;
```

Read a flat name into its labels.

Dots separate labels unless escaped. A backslash escapes the character after it, so `\.` is a literal dot inside a label and `\\` is a literal backslash; any
other backslash is dropped and the character it introduced is kept. Empty labels contribute nothing, so `""`, `"."`, and a trailing dot all read as a
name with one fewer label rather than as a label that is the empty string - the wire has no way to spell an empty label, since a zero length byte is the
terminator.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `text` | `string` | The name as a flat string, in the form [formatDnsName](#formatdnsname) writes. |

#### Returns

[`DnsName`](#dnsname)

The labels, with the root reading as the empty array.

***

### parseIpv4()

```ts
function parseIpv4(address): Buffer;
```

Read a dotted-quad IPv4 address into its four bytes.

The grammar is exactly what the encoder writes from: four decimal octets from 0 to 255 separated by dots, and nothing else. The record builders on the testing
entry read an address through this function at construction, so a spelling the wire cannot carry is refused where it was supplied rather than at encode time.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `address` | `string` | The address in dotted decimal. |

#### Returns

`Buffer`

The four bytes, in address order.

#### Throws

A `TypeError` naming this reader and the address when the spelling is not four decimal octets.

***

### parseIpv6()

```ts
function parseIpv6(address): Buffer;
```

Read an IPv6 address into its sixteen bytes: hexadecimal groups separated by colons, with at most one `::` standing for a run of one or more zero groups.

The grammar is exactly what the encoder writes from, and it is narrower than the platform's own `isIPv6`: a zone suffix (`fe80::1%en0`, the form the browser
attaches to a link-local address it reports) and the mixed dotted tail RFC 4291 allows (`::ffff:192.168.1.1`) are both refused. An AAAA record this module
wrote is always spelled the way its RFC 5952 presentation reads, the record builders on the testing entry read an address through this function at
construction, and refusing the two forms outright is a clearer answer than a partial reading of either.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `address` | `string` | The address in the RFC 4291 text form, without a zone. |

#### Returns

`Buffer`

The sixteen bytes, in address order.

#### Throws

A `TypeError` naming this reader and the address when the spelling carries more than one `::`, does not expand to eight groups, or carries a group that
is not one to four hexadecimal digits - a zone suffix and a dotted tail both read as such a group.

***

### txtEntries()

```ts
function txtEntries(record): ReadonlyMap<string, Nullable<string>>;
```

Read a TXT record as the key-value pairs RFC 6763 sections 6.3 through 6.5 define.

Each string is a key, the bytes before its first `=`, and a value, the bytes after it. A string with no `=` is a flag, and maps to `null`. Keys are folded to
lowercase over ASCII, so `PaperSize` and `papersize` are one key. An empty string and a string that opens with `=` carry no key and are silently ignored, and
when a key appears more than once the first occurrence wins and the rest are dropped.

A consumer therefore distinguishes four states: the key is absent from the map; it maps to `null`, so it is a flag; it maps to `""`, so it was written with an
`=` and nothing after it; or it maps to a value. Values are decoded as UTF-8 here, which is what a consumer reading configuration wants; a consumer whose
values are binary reads `strings` instead, since RFC 6763 section 6.5 makes a value opaque.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `record` | [`DnsTxtRecord`](#dnstxtrecord) | The TXT record. |

#### Returns

`ReadonlyMap`\<`string`, [`Nullable`](../util.md#nullable)\<`string`\>\>

The pairs, in the order the record spells them.
