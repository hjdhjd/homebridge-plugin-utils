[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/endpoints

# logclient/endpoints

Single authority for constructing the URLs the log client connects to.

Every transport (`auth.ts`, `rest.ts`, `socket.ts`) applies the same TLS-to-scheme mapping (http/https for REST and auth, ws/wss for the socket) and authority assembly
over the same host + port. Routing that derivation through one module keeps the mapping and assembly in exactly one place, so a change to how URLs are built propagates
everywhere rather than being re-derived (and potentially diverging) at each call site. The functions are pure string builders with no I/O.

## Log Client

### EndpointTarget

The connection target shared by every URL builder in this module.

#### Extended by

- [`AcquireTokenOptions`](auth.md#acquiretokenoptions)
- [`SocketTarget`](#sockettarget)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="host"></a> `host` | `readonly` | `string` | The hostname or IP address of the homebridge-config-ui-x server. |
| <a id="port"></a> `port` | `readonly` | `number` | The TCP port the server listens on. |
| <a id="tls"></a> `tls?` | `readonly` | `boolean` | When `true`, URLs use the secure scheme (`https`/`wss`); when `false` or omitted, the plaintext scheme (`http`/`ws`). |

***

### SocketTarget

The connection target plus the raw handshake token, used to build the WebSocket connect URL.

#### Extends

- [`EndpointTarget`](#endpointtarget)

#### Extended by

- [`DownloadLogOptions`](rest.md#downloadlogoptions)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="host-1"></a> `host` | `readonly` | `string` | The hostname or IP address of the homebridge-config-ui-x server. | [`EndpointTarget`](#endpointtarget).[`host`](#host) |
| <a id="port-1"></a> `port` | `readonly` | `number` | The TCP port the server listens on. | [`EndpointTarget`](#endpointtarget).[`port`](#port) |
| <a id="tls-1"></a> `tls?` | `readonly` | `boolean` | When `true`, URLs use the secure scheme (`https`/`wss`); when `false` or omitted, the plaintext scheme (`http`/`ws`). | [`EndpointTarget`](#endpointtarget).[`tls`](#tls) |
| <a id="token"></a> `token` | `readonly` | `string` | The raw JWT, passed verbatim in the query string. The server's WebSocket guard reads `client.handshake.query.token` with no `Bearer` prefix and no fallback, so the token must be the bare JWT. | - |

***

### httpBaseUrl()

```ts
function httpBaseUrl(target): string;
```

Build the HTTP(S) base URL (scheme + authority, no trailing slash) for the REST and auth endpoints.

The returned string is the origin only - callers append the specific API path. We construct it through the platform `URL` so host and port are normalized and
encoded consistently, then read `URL.origin`, which yields the scheme + authority with no trailing slash, so callers can concatenate a leading-slash path without
producing a double slash.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `target` | [`EndpointTarget`](#endpointtarget) | The connection target. See [EndpointTarget](#endpointtarget). |

#### Returns

`string`

The origin, e.g. `https://localhost:8581`, with no trailing slash.

***

### socketUrl()

```ts
function socketUrl(target): string;
```

Build the WebSocket connect URL for the live-log Socket.IO stream.

The URL carries the Engine.IO version, the WebSocket transport selector, and the raw token in its query string; the server's handshake guard authenticates from that
token alone. We build through the platform `URL` and `searchParams` so the token is percent-encoded correctly (a JWT contains `.` and may carry `-`/`_` from base64url,
which are URL-safe, but routing through `searchParams` keeps encoding correct regardless of token shape).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `target` | [`SocketTarget`](#sockettarget) | The connection target plus the raw token. See [SocketTarget](#sockettarget). |

#### Returns

`string`

The full `ws(s)://host:port/socket.io/?EIO=4&transport=websocket&token=<rawjwt>` connect URL.
