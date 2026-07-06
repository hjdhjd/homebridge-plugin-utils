[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/dgram-util

# ffmpeg/dgram-util

Single source of truth for the `"ipv4"` / `"ipv6"` -> `node:dgram` translations the FFmpeg subsystem needs.

Every call site in the FFmpeg subsystem that needs the ipFamily -> node:dgram translation routes through the table lookups exported here, rather than
hand-rolling `ipFamily === "ipv6" ? "udp6" : "udp4"` or `isIPv6 ? "::1" : "127.0.0.1"` inline. Keeping the mapping centralized means a future addition
(dual-stack socket types, SO_REUSEADDR flags, alternative loopback addresses in constrained test environments) has exactly one file to update, and
consumers - production or test - share the same vocabulary.

## FFmpeg

### IpFamily

```ts
type IpFamily = "ipv4" | "ipv6";
```

The two IP families the FFmpeg subsystem supports. Centralized here so consumers in `rtp.ts`, `stream.ts`, and the test fixtures share the same union rather than
re-declaring inline unions at every init-type boundary.

***

### createDgramSocket()

```ts
function createDgramSocket(ipFamily): Socket;
```

Create a `node:dgram` socket for the supplied IP family. Equivalent to `createSocket("udp4")` / `createSocket("udp6")` but routes the family -> socket-type lookup
through the single table above, so every call site shares one mapping.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ipFamily` | [`IpFamily`](#ipfamily) | The IP family for the new socket. |

#### Returns

[`Socket`](https://nodejs.org/api/dgram.html#class-dgramsocket)

A fresh unbound [Socket](https://nodejs.org/api/dgram.html#class-dgramsocket).

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
