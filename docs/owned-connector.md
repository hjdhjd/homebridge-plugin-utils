[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / owned-connector

# owned-connector

The connector a library hands undici, so the sockets a dispatcher dials are held by the library rather than only by the pool.

A dispatcher owns its connections and vends none of them, which is the right boundary nearly always and leaves a library unable to do what this connector does. It
cannot cut a dial that is still in its TCP or TLS handshake when the caller's lifetime ends, because undici's client discards the connector's return value and
holds nothing of its own until the connect completes - a socket mid-handshake is reachable through a connector like this one and nowhere else. It cannot let go of
everything at teardown without waiting on a peer that is under no obligation to answer. It cannot read the error the dial itself failed with. And it cannot read
the error an established connection raised once the dial was over.

Those errors earn a paragraph of their own, because nothing about them is guessable from a call site. Observed on 2026-09-19: undici's WebSocket delivered an
empty `TypeError` for every opening-handshake failure - a self-signed peer, a hostname mismatch, and a refused port alike - while the connector's own callback
received the real error, with its errno, about a millisecond earlier. Observed on 2026-10-24: an open WebSocket the peer resets delivers the same empty `TypeError`
as one the peer hangs up on without a close frame, while the socket underneath raised `ECONNRESET` before the WebSocket reported anything. So a consumer that
wants to name what went wrong reads `lastDialFailure`, then `lastConnectionFailure`, ahead of the event.

The boundary. This module owns sockets and stops there: it builds no dispatcher, logs nothing, and decides nothing about what a failure means. Which protocols to
offer and whether to verify the peer's certificate are the caller's own policy, carried through as values rather than judged here.

## Utilities

### OwnedConnector

A connector that holds every socket it vends, and the two operations that let go of them.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="connect"></a> `connect` | `readonly` | `connector` | The connector to hand undici - a `Pool`'s or an `Agent`'s `connect` option. Every socket it vends is held from the moment it is created, before any event has fired on it, and a socket that finishes connecting moves from the dialing collection into the established one so a cancellation can reach the first without touching the second. |
| <a id="lastconnectionfailure"></a> `lastConnectionFailure` | `readonly` | `Error` \| `undefined` | The first network or TLS error any established socket raised since the connector's most recent successful connect: `undefined` before any connect, and `undefined` again after each one that succeeds. It records only an error the socket itself raised: a system error carrying a numeric `errno`, such as a peer's reset, or a TLS-layer error whose `code` opens `ERR_SSL_`, such as a corrupt record after the handshake. An error the transport destroys the socket with is left out, as is one a caller destroys it with that carries neither mark, and undici destroys an HTTP socket with an error of its own when the peer ends it with a bare FIN or a `Connection: close`, so a bare FIN, a clean close and [release](#release) record nothing. The first such error stands, because the errors a socket raises after it are its consequences, and it is held as the socket raised it, so its `errno` and its `cause` chain are intact. One slot serves every socket the connector holds, so on a pool a second socket's error is dropped while the first is held, and any successful connect clears the slot. It is a getter, so a caller reads the current value rather than a snapshot taken when this object was built. |
| <a id="lastdialfailure"></a> `lastDialFailure` | `readonly` | `Error` \| `undefined` | The error the most recent dial vended: `undefined` before any dial, and `undefined` again after one that succeeded, so it describes the most recent dial and nothing older. It is a getter, so a caller reads the current value rather than a snapshot taken when this object was built. |

#### Methods

##### cutDials()

```ts
cutDials(reason): void;
```

Destroy every socket still connecting, with an error: `reason` itself when it is an `Error` (every `DOMException` is one), and otherwise a fresh
`RequestAbortedError`, which is the transport's own class for a signal aborted without a reason. Destroying with an error is what makes the pending request
reject with that very object - a socket destroyed with no error emits nothing the connector listens for, and the request would hang until the transport's own
connect timer. Sockets that have finished connecting are left alone.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason` | `unknown` |

###### Returns

`void`

##### release()

```ts
release(): void;
```

Destroy every socket still held: a connecting one with a fresh `ClientDestroyedError`, so a request cut this way classifies exactly as an ordinary pool reset
already does, and an established one with a bare destroy, because nothing is pending on the connector's side of an established socket - a request in flight on
one meets the dispatcher's own destroy instead.

###### Returns

`void`

***

### OwnedConnectorOptions

Construction options for [createOwnedConnector](#createownedconnector).

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="allowh2"></a> `allowH2` | `readonly` | `boolean` | Which application protocols the dial offers while the connection is negotiated. `true` offers `h2` beside `http/1.1`; `false` offers `http/1.1` alone. The caller states it because the connector cannot infer it, and the consequence is the caller's rather than the protocol's: a dialer that upgrades to a WebSocket states `false`, because a WebSocket upgrade cannot run over HTTP/2, while a pooled HTTP client that wants the faster protocol when the peer has it states `true`. |
| <a id="rejectunauthorized"></a> `rejectUnauthorized?` | `readonly` | `boolean` | Whether the peer's certificate chain must satisfy the platform's verification. It has three states, and the difference between them is the whole reason the field is optional. Omitted leaves the question to the platform, so whatever the process was started with still decides and a user's own `NODE_TLS_REJECT_UNAUTHORIZED` still relaxes it. `true` requires a chain the platform accepts, and no environment setting can relax that. `false` verifies not at all, which is how a caller reaches a device presenting a certificate no chain accepts...a caller that does relax it owns that decision. A caller with no opinion omits it. |

***

### createOwnedConnector()

```ts
function createOwnedConnector(options): OwnedConnector;
```

Build a connector that tracks every socket it vends, from the moment it is vended.

A dial is held from the vend rather than from the completed connect because nobody else can reach a socket mid-handshake. That is the whole reason this exists: a
cancellation, a deadline, a pool reset and a teardown all reduce to one operation - cut the dials still in flight - and none of them could reach a connecting
socket without it.

The two collections are two because the operations differ. A cancellation must end a dial and must never touch a connection some other request is using, so a
socket moves out of the dialing collection and into the established one the moment its connect completes. Neither operation clears a collection itself - a
destroyed dial leaves through its own connector callback, and a destroyed established socket leaves through its close handler - which keeps each of them the live
picture of what is actually held.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`OwnedConnectorOptions`](#ownedconnectoroptions) | Which protocols to offer, and whether to verify the peer's certificate. See [OwnedConnectorOptions](#ownedconnectoroptions). |

#### Returns

[`OwnedConnector`](#ownedconnector)

The connector, and the operations that let its sockets go.

#### Example

```ts
import { Agent } from "undici";
import { createOwnedConnector } from "homebridge-plugin-utils";

// The dispatcher dials through the connector, so a teardown reaches sockets the pool would never vend.
const connector = createOwnedConnector({ allowH2: true });
const dispatcher = new Agent({ allowH2: true, connect: connector.connect });

// Later, when this caller's lifetime ends.
await dispatcher.destroy();
connector.release();
```
