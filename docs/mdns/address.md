[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / mdns/address

# mdns/address

The address arithmetic a resolved mDNS service's consumer needs, kept apart from [MdnsBrowser](browser.md#mdnsbrowser) itself: which advertised
address to dial, and whether a held address is still among what a fresh advertisement carries. [MdnsService.addresses](browser.md#addresses) promises only arrival order and no duplicates - no family preference, and no stability across a record's lapse and return - so
every consumer that wants a dialable address answers the same two questions this module answers, rather than each writing its own family and stability
rules.

**The ranges.** [isLinkLocal](#islinklocal) and this module's unique-local check test an IPv6 address's first sixteen-bit group against RFC 4291 section 2.5.6's
`fe80::/10` and RFC 4193 section 3.1's `fc00::/7` respectively, the same bit-mask idiom for both: a named prefix, a named mask, the first group read as
hex. Neither reaches for `node:net`'s `BlockList`, which parses a subnet at construction for a check this module makes at most twice per candidate
address.

## mDNS

### dialAddress()

```ts
function dialAddress(addresses): Nullable<string>;
```

Choose the address a consumer dials to reach a resolved mDNS service, ranking the whole set of what it advertises rather than reading the set's first
entry: over IPv6 where the service offers a routable address, over IPv4 otherwise, and over an unzoned link-local address only when nothing else
qualifies.

The answer is a function of the SET of advertised addresses and never of their order. [MdnsService.addresses](browser.md#addresses)
lists a host's addresses in the order its records arrived in the browser's cache, and a record that lapses and is re-announced re-enters at the end of
that order, so a caller that read "the first address" across two derivations of one service would read an ordinary re-announcement as the device having
moved. Ranking the set is what keeps the answer stable across that reordering: unique-local leads because it is the range a site assigns itself and so
survives an ISP prefix rotation, and within one class the lowest string wins, a comparison whose only job is to give one answer for one set.

While a host's address is changing, the browser reports only its live addresses once a replacement exists: the outgoing address leaves the reported
set the instant the incoming one is cached, and this function sees the incoming address alone. The outgoing address surfaces here only when it is
the host's last address of either family - nothing live to report - for the second its own hold keeps it reachable.

A zoned candidate is dropped before anything else classifies it. This library dials through undici, which parses the origin as a WHATWG URL, and a URL
has no syntax for an IPv6 zone ID: a zoned literal is refused as an invalid URL before any connection is attempted, even though Node's `net` module
accepts one.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `addresses` | readonly `string`[] | The service's advertised addresses, in any order. |

#### Returns

[`Nullable`](../util.md#nullable)\<`string`\>

The address to dial, or `null` when nothing advertised qualifies.

***

### isAdvertisedAt()

```ts
function isAdvertisedAt(addresses, address): boolean;
```

Whether a service still advertises `address`, the question a connection owner means to ask of a fresh advertisement - deliberately not the question
[dialAddress](#dialaddress) answers. A browser re-derives a host's address list every time one of its records lapses or returns, so the ranked pick can move
between a device's own addresses on nothing more than ordinary packet loss; a connection is stale only when the address it was opened at is gone from the
advertisement altogether. Comparing a held address against a fresh pick therefore tears healthy connections down on a reorder, and this membership test
does not.

`addresses` is read exactly as advertised, zoned entries included, because an address a consumer would never dial is still the service saying it answers
there: the comparison here is against the full advertised list, never against [dialAddress](#dialaddress)'s filtered, ranked view of it.

One case this test still cannot distinguish: a lone held address's own hold ending, versus the device having moved off it entirely - both read as
gone from the advertisement the same way, so the connection is reopened once either way. That case is the only one where a held address stays
advertised at all: once a live address of either family exists for the host, the outgoing address drops from the advertisement at once, and this
test reads false for it immediately, rather than after any grace window.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `addresses` | readonly `string`[] | The service's currently advertised addresses. |
| `address` | `string` | The address a held connection was opened at. |

#### Returns

`boolean`

`true` when `address` is still among `addresses`.

## Other

### isLinkLocal()

```ts
function isLinkLocal(address): boolean;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `address` | `string` |

#### Returns

`boolean`

***

### zoneOf()

```ts
function zoneOf(source): Nullable<string>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `string` |

#### Returns

[`Nullable`](../util.md#nullable)\<`string`\>
