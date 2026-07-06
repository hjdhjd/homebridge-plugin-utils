[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/auth

# logclient/auth

Token acquisition for the Homebridge UI log client.

[acquireToken](#acquiretoken) turns a [LogClientCredentials](types.md#logclientcredentials) discriminated union into a raw bearer token by talking to the homebridge-config-ui-x authentication API. Each
credential arm maps to one of the server's authentication paths: a pre-acquired `token` is returned verbatim with no network call, a `password` arm posts to `POST
/api/auth/login` (carrying an optional one-time passcode), and `noauth` posts to `POST /api/auth/noauth`, which the server honors only when its UI is configured with
`auth: "none"`.

The module's load-bearing concern beyond "get a token" is failure classification. The socket's reconnect loop re-authenticates on every reconnect, so it must be able
to tell a transient fault (the server is briefly down or returned a 5xx) from a permanent one (the credentials are wrong, an OTP is required, or noauth is disabled).
A transient fault should be retried with backoff; a permanent one must fail the reconnect fast so the user gets an actionable error rather than an endless retry loop
against credentials that will never work. [acquireToken](#acquiretoken) therefore rejects with a [LogAuthError](#logautherror) whose `kind` discriminates `"permanent"` from
`"transient"`, and the reconnect's `shouldRetry` predicate vetoes a retry on the permanent kind via [isPermanentAuthError](#ispermanentautherror).

The `fetch` implementation is injected (defaulting to the global `fetch`) so the whole module is exercised in tests without a live server.

## Log Client

### LogAuthError

The error thrown by [acquireToken](#acquiretoken) when authentication fails.

Carries a [LogAuthErrorKind](#logautherrorkind-1) discriminator so a consumer (specifically the socket's reconnect `shouldRetry` predicate) can distinguish a permanent credential
problem from a transient network/server fault without parsing the message text. The message itself is already actionable - it names the failing path and the reason -
so it can be surfaced to the user directly.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new LogAuthError(message, options): LogAuthError;
```

Construct a new authentication error.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `message` | `string` | A human-readable, actionable description of the failure. |
| `options` | [`LogAuthErrorOptions`](#logautherroroptions) | The classification and optional underlying cause. See [LogAuthErrorOptions](#logautherroroptions). |

###### Returns

[`LogAuthError`](#logautherror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="kind"></a> `kind` | `readonly` | [`LogAuthErrorKind`](#logautherrorkind-1) | The failure classification. `"permanent"` failures must not be retried; `"transient"` failures may be. |

***

### AcquireTokenOptions

Options accepted by [acquireToken](#acquiretoken): the connection target plus an injectable `fetch` seam.

#### Extends

- [`EndpointTarget`](endpoints.md#endpointtarget)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="fetch"></a> `fetch?` | `readonly` | \{ (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; \} | The fetch implementation to use. Defaults to the global `fetch`. Injected so the auth flow is testable without a live server. | - |
| <a id="host"></a> `host` | `readonly` | `string` | The hostname or IP of the homebridge-config-ui-x server. | [`EndpointTarget`](endpoints.md#endpointtarget).[`host`](endpoints.md#host) |
| <a id="port"></a> `port` | `readonly` | `number` | The TCP port the server listens on. | [`EndpointTarget`](endpoints.md#endpointtarget).[`port`](endpoints.md#port) |
| <a id="tls"></a> `tls?` | `readonly` | `boolean` | When `true`, use the secure (`https`) scheme; when `false` or omitted, plaintext (`http`). | [`EndpointTarget`](endpoints.md#endpointtarget).[`tls`](endpoints.md#tls) |

***

### LogAuthErrorOptions

Options accepted by [LogAuthError](#logautherror)'s constructor.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="cause"></a> `cause?` | `readonly` | `unknown` | The underlying cause (a network error, or the HTTP response context), attached for diagnostics. |
| <a id="kind-1"></a> `kind` | `readonly` | [`LogAuthErrorKind`](#logautherrorkind-1) | The failure classification. See [LogAuthErrorKind](#logautherrorkind-1). |

***

### LogAuthErrorKind

```ts
type LogAuthErrorKind = "permanent" | "transient";
```

The classification of an authentication failure, used by the reconnect loop to decide whether to retry.

- `"permanent"` - the credentials are wrong, an OTP is required, or noauth is disabled. Retrying with the same credentials will keep failing, so the reconnect loop
  vetoes a retry and surfaces the error to the user.
- `"transient"` - a network fault or a server-side 5xx/429. The condition may clear on its own, so the reconnect loop retries with backoff.

***

### acquireToken()

```ts
function acquireToken(credentials, options): Promise<string>;
```

Acquire a raw bearer token for the homebridge-config-ui-x API from the supplied credentials.

Dispatches on the credential discriminated union:

- `token` - returns the pre-acquired token verbatim, with no network call. A static token that has since expired is not detected here; the failure surfaces later when
  the socket handshake is rejected.
- `password` - posts `{ username, password, otp? }` to `POST /api/auth/login`.
- `noauth` - posts to `POST /api/auth/noauth`, which the server honors only when its UI is configured with `auth: "none"`.

On failure it rejects with a [LogAuthError](#logautherror) whose `kind` classifies the failure as permanent (wrong credentials, OTP required, noauth disabled, broken success
body) or transient (network fault, 5xx, 429), so the reconnect loop can fail fast on permanent failures and retry transient ones.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `credentials` | [`LogClientCredentials`](types.md#logclientcredentials) | The credentials to authenticate with. See [LogClientCredentials](types.md#logclientcredentials). |
| `options` | [`AcquireTokenOptions`](#acquiretokenoptions) | The connection target and the injectable `fetch` seam. See [AcquireTokenOptions](#acquiretokenoptions). |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`string`\>

A promise resolving to the raw bearer token (the bare JWT, with no `Bearer` prefix).

#### Throws

[LogAuthError](#logautherror) on any authentication failure, classified permanent or transient.

***

### isPermanentAuthError()

```ts
function isPermanentAuthError(error): boolean;
```

Type guard: returns `true` when `error` is a [LogAuthError](#logautherror) classified `"permanent"`.

The reconnect loop's `shouldRetry` predicate consults this to veto a retry the instant a permanent credential failure surfaces, so a wrong password or a missing OTP
fails the reconnect fast rather than looping forever against credentials that cannot succeed.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `unknown` | The value to test. |

#### Returns

`boolean`

`true` when `error` is a permanent authentication failure.
