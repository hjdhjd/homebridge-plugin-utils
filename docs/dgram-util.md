[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / dgram-util

# dgram-util

Single source of truth for the `"ipv4"` / `"ipv6"` -> `node:dgram` translations every datagram consumer in the library needs.

Every call site that needs the ipFamily -> node:dgram translation routes through the table lookups exported here, rather than hand-rolling
`ipFamily === "ipv6" ? "udp6" : "udp4"` or `isIPv6 ? "::1" : "127.0.0.1"` inline. Keeping the mapping centralized means a future addition (dual-stack socket
types, alternative loopback addresses in constrained test environments) has exactly one file to update, and consumers - production or test - share the same
vocabulary. A socket option a caller needs travels the same way: [createDgramSocket](#createdgramsocket) carries the address-reuse flag as an option of its own, so a
multicast listener that has to share a well-known port asks for it by name here rather than reaching past the factory to `createSocket`. The FFmpeg
subsystem's `rtp.ts` and `stream.ts` and the test fixtures beside them are examples of that traffic.

[localAddressFor](#localaddressfor) lives here for the same reason: it is a datagram helper, answering which local address the operating system would route toward a host by
connecting a socket and reading what the kernel bound, and the translation tables above are what it opens that socket through.

This module imports `node:dgram` and `node:dns/promises` and is therefore Node-only, like `util.ts`. A browser-targeted consumer cannot resolve those imports.

## Utilities

### IpFamily

```ts
type IpFamily = "ipv4" | "ipv6";
```

The two IP families the library's datagram helpers support. Centralized here so consumers - the FFmpeg subsystem's `rtp.ts` and `stream.ts`, the test fixtures
beside them, and anything else opening a datagram socket - share the same union rather than re-declaring inline unions at every init-type boundary.

***

### createDgramSocket()

```ts
function createDgramSocket(ipFamily, options?): Socket;
```

Create a `node:dgram` socket for the supplied IP family. Equivalent to `createSocket("udp4")` / `createSocket("udp6")` but routes the family -> socket-type lookup
through the single table above, so every call site shares one mapping.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ipFamily` | [`IpFamily`](#ipfamily) | The IP family for the new socket. |
| `options` | \{ `reuseAddr?`: `boolean`; \} | Optional socket options. |
| `options.reuseAddr?` | `boolean` | Whether the socket shares its port with every other reuse-bound socket on the host. That is what lets a multicast listener sit beside the operating system's own responder on a well-known port, each receiving every datagram the group delivers. Defaults to `false`. |

#### Returns

[`Socket`](https://nodejs.org/api/dgram.html#class-dgramsocket)

A fresh unbound [Socket](https://nodejs.org/api/dgram.html#class-dgramsocket).

***

### localAddressFor()

```ts
function localAddressFor(host, options?): Promise<string>;
```

The local address the operating system routes toward a host, which is the interface a peer at that host can reach this process on.

The host is resolved first, through the platform resolver and in the operating system's own order, and the socket is opened in the family the record answered. A
name's records decide the family rather than its spelling, so a host whose only record is an IPv6 one is probed over an IPv6 socket and answered rather than
refused. A literal is answered by the resolver without a query and in its own family, so a literal travels this same path with no branch of its own. The socket is
opened only once the resolver has answered, which is also what makes a lifetime that ends during the lookup open nothing at all.

That socket is then connected and its local address read. No packet is sent: connecting a datagram socket only fixes its default destination, and fixing that
destination is what makes the kernel consult its routing table and bind the local address it would send from. That is a more honest answer than enumerating the
host's interfaces and guessing which one faces the peer, because a host with several interfaces has no single right answer to guess at.

The `connect` event is awaited rather than a callback passed, because the platform declares that callback to take no arguments: a callback shape that reads an
error argument types only by declaring a parameter the contract does not promise, and then reads past it at runtime. With no callback, the runtime emits `connect`
on success and `error` on failure, which `events.once` turns into a rejection carrying the family code - so an address whose family the socket cannot reach is a
failure the caller sees rather than an address that means nothing.

The socket is unreferenced, so it never holds the process open. A name lookup already in flight is a threadpool request no API cancels, so it holds the process
until the resolver answers however this call ends; `signal` ends the caller's wait at once, and the lookup then drains into the wait combinator below, which has
already marked its answer handled.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `host` | `string` | The peer's address or hostname. |
| `options` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional inputs. |
| `options.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The caller's lifetime. Aborting it rejects with the signal's reason, whether it had already fired or fires while the lookup is pending. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`string`\>

The local address the route toward that host would leave from.

#### Throws

The resolver's own error when the host does not resolve, the address-family error when the resolved address cannot be reached, and `signal.reason` when
the caller's lifetime ends first.

#### Example

```ts
import { localAddressFor } from "homebridge-plugin-utils";

// The address to hand a controller as the endpoint it should post back to.
const endpoint = await localAddressFor(controllerHost, { signal: this.signal });
```

***

### loopbackAddress()

```ts
function loopbackAddress(ipFamily): "127.0.0.1" | "::1";
```

Resolve the loopback address string for the supplied IP family. The returned literal is suitable for passing to `socket.bind(port, address)` or
`socket.send(..., address, ...)`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ipFamily` | [`IpFamily`](#ipfamily) | The IP family to resolve. |

#### Returns

`"127.0.0.1"` \| `"::1"`

`"127.0.0.1"` for `"ipv4"` or `"::1"` for `"ipv6"`.
