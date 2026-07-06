[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/frame

# logclient/frame

Pure Engine.IO / Socket.IO v4 wire codec.

The log client speaks raw Engine.IO over a single WebSocket: each WebSocket message is exactly one Engine.IO packet (no `\x1e` payload batching, since batching is an
HTTP-long-polling concern, not a WebSocket one), and a Socket.IO packet is layered inside an Engine.IO `message` packet. This module is the single source of truth for
that two-layer framing - the Engine.IO packet-type digits (`0` open, `2` ping, `3` pong, `4` message), the Socket.IO packet-type digits inside a message (`0` CONNECT,
`2` EVENT, `4` CONNECT_ERROR), and the `/log,` namespace prefix. It is deliberately pure and stateless, mirroring the `mp4-parser.ts` / `rtp-parser.ts` pure-parser
precedent: it turns wire text into a [ProtocolEvent](#protocolevent) discriminated union and back, and leaves all I/O, liveness, and lifecycle to the composing socket.

`allowEIO3` interop: the server is started with `allowEIO3: true`, so a downgraded EIO3 client would see the Socket.IO CONNECT acknowledgement as a bare `40` with no
namespace and no trailing payload, where EIO4 sends `40/log,{"sid":"..."}`. [decodeFrame](#decodeframe) treats both shapes as a namespace-connect for whichever namespace the
frame names (defaulting to the root namespace when none is present), so a consumer reading the decoded `kind` does not have to branch on the negotiated protocol
version. We always emit EIO4-shaped frames from [encodeFrame](#encodeframe); the interop only matters on the decode side.

## Log Client

### OutboundEvent

```ts
type OutboundEvent = 
  | {
  args: unknown;
  event: string;
  kind: "event";
  namespace: string;
}
  | {
  kind: "connect";
  namespace: string;
}
  | {
  kind: "pong";
};
```

An outbound protocol event to serialize, discriminated on `kind`.

The OutboundEvent union models three frame shapes: a namespace connect (`connect`), a namespace event with a JSON payload (`event` - this is how `tail-log` is
requested), and a heartbeat pong (`pong`). A fourth outbound frame, the namespace DISCONNECT, is hand-assembled separately (see [LOG\_NAMESPACE\_PATH](#log_namespace_path)) because its
fixed, argument-free shape needs no serialization through this codec. Modeling the outbound set as its own narrow union keeps [encodeFrame](#encodeframe) total over exactly
what it models, rather than re-using the wider inbound [ProtocolEvent](#protocolevent) and leaving unserializable arms.

***

### ProtocolEvent

```ts
type ProtocolEvent = 
  | {
  event: string;
  kind: "message";
  namespace: string;
  payload: unknown;
}
  | {
  kind: "namespaceConnect";
  namespace: string;
}
  | {
  kind: "namespaceError";
  namespace: string;
  reason: unknown;
}
  | {
  kind: "open";
  pingInterval: number;
  pingTimeout: number;
}
  | {
  kind: "ping";
}
  | {
  kind: "pong";
}
  | {
  kind: "unknown";
  raw: string;
};
```

A decoded protocol event, discriminated on `kind`.

The union collapses the two-layer Engine.IO/Socket.IO wire format into the handful of events the log client actually reacts to: the Engine.IO handshake (`open`) and
heartbeat (`ping`/`pong`), and the Socket.IO namespace lifecycle (`namespaceConnect`/`namespaceError`) and payload delivery (`message`). Any unrecognized string
frame the codec does not model - an empty frame, an unknown Engine.IO digit, or an unhandled Socket.IO packet type - decodes to `unknown` carrying the original text,
so a consumer can log it without the codec having to model every Engine.IO/Socket.IO packet type that the log stream never exercises.

***

### LOG\_NAMESPACE\_PATH

```ts
const LOG_NAMESPACE_PATH: string;
```

The Socket.IO namespace, with its leading slash, that the log stream is served on. The wire format addresses namespaces with a leading slash (`/log`), whereas the
`LOG_NAMESPACE` setting holds the bare name (`log`). This constant supplies the slash-prefixed namespace token used to hand-assemble the raw Socket.IO disconnect frame
(`"41/log,"`), where [encodeFrame](#encodeframe) is bypassed. It must NOT be passed to `encodeFrame`: that codec's connect and event arms take the bare `LOG_NAMESPACE` and
derive the leading slash themselves, so handing them `LOG_NAMESPACE_PATH` would prepend a second slash and emit a malformed `"//log,"` prefix.

***

### decodeFrame()

```ts
function decodeFrame(frame): ProtocolEvent;
```

Decode a single inbound WebSocket frame into a [ProtocolEvent](#protocolevent).

The decoder peels the leading Engine.IO packet-type digit and dispatches: `0` is the handshake open (whose JSON carries the ping interval/timeout), `2`/`3` are the
heartbeat, and `4` is a message whose remaining text is a Socket.IO packet decoded by the inner namespace/event parser. Its input is typed `string` - the composing
socket drops binary frames before they reach the decoder - so any unrecognized STRING frame (an empty frame, an unknown Engine.IO digit, or an unhandled Socket.IO
packet type) decodes to `unknown` carrying the original text.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `frame` | `string` | The raw WebSocket message text. |

#### Returns

[`ProtocolEvent`](#protocolevent)

The decoded protocol event.

***

### encodeFrame()

```ts
function encodeFrame(event): string;
```

Serialize an outbound protocol event to its Engine.IO/Socket.IO wire text.

Always emits EIO4-shaped frames: a namespace connect is `40<nsPrefix>`, an event is `42<nsPrefix>[event,args]`, and a pong is the bare Engine.IO `"3"`. The event
payload is `JSON.stringify`d as the `[eventName, args]` array the Socket.IO EVENT format requires.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `event` | [`OutboundEvent`](#outboundevent) | The outbound event to serialize. See [OutboundEvent](#outboundevent). |

#### Returns

`string`

The wire text to send as a single WebSocket message.
