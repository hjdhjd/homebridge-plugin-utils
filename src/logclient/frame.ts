/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/frame.ts: Pure Engine.IO / Socket.IO wire codec for the log namespace.
 */

/**
 * Pure Engine.IO / Socket.IO v4 wire codec.
 *
 * The log client speaks raw Engine.IO over a single WebSocket: each WebSocket message is exactly one Engine.IO packet (no `\x1e` payload batching, since batching is an
 * HTTP-long-polling concern, not a WebSocket one), and a Socket.IO packet is layered inside an Engine.IO `message` packet. This module is the single source of truth for
 * that two-layer framing - the Engine.IO packet-type digits (`0` open, `2` ping, `3` pong, `4` message), the Socket.IO packet-type digits inside a message (`0` CONNECT,
 * `2` EVENT, `4` CONNECT_ERROR), and the `/log,` namespace prefix. It is deliberately pure and stateful-free, mirroring the `mp4-parser.ts` / `rtp-parser.ts` pure-parser
 * precedent: it turns wire text into a {@link ProtocolEvent} discriminated union and back, and leaves all I/O, liveness, and lifecycle to the composing socket.
 *
 * `allowEIO3` interop: the server is started with `allowEIO3: true`, so a downgraded EIO3 client would see the Socket.IO CONNECT acknowledgement as a bare `40` with no
 * namespace and no trailing payload, where EIO4 sends `40/log,{"sid":"..."}`. {@link decodeFrame} treats both shapes as a namespace-connect for whichever namespace the
 * frame names (defaulting to the root namespace when none is present), so a consumer reading the decoded `kind` does not have to branch on the negotiated protocol
 * version. We always emit EIO4-shaped frames from {@link encodeFrame}; the interop only matters on the decode side.
 *
 * @module
 */
import { LOG_NAMESPACE } from "./settings.ts";

// The Engine.IO packet-type digit for an `open` packet: the server's first frame, carrying the session handshake JSON (ping interval/timeout, sid).
const ENGINE_OPEN = "0";

// The Engine.IO packet-type digit for a `ping`. Under the WebSocket transport in EIO4 the server is the pinger, so an inbound `"2"` is a server ping the client must
// answer with a `"3"` pong.
const ENGINE_PING = "2";

// The Engine.IO packet-type digit for a `pong`. Surfaced for completeness on decode; the client emits one via {@link encodeFrame} in response to each server ping.
const ENGINE_PONG = "3";

// The Engine.IO packet-type digit for a `message`: the envelope that carries a Socket.IO packet as its remaining text.
const ENGINE_MESSAGE = "4";

// The Socket.IO packet-type digit (inside an Engine.IO message) for a namespace CONNECT acknowledgement.
const SOCKET_CONNECT = "0";

// The Socket.IO packet-type digit for an EVENT - the packet that carries `[eventName, ...args]` JSON, which is how the server delivers `stdout` log chunks.
const SOCKET_EVENT = "2";

// The Socket.IO packet-type digit for a CONNECT_ERROR - the server's rejection of a namespace connect (e.g., an auth failure surfaced at the namespace layer).
const SOCKET_CONNECT_ERROR = "4";

/**
 * A decoded protocol event, discriminated on `kind`.
 *
 * The union collapses the two-layer Engine.IO/Socket.IO wire format into the handful of events the log client actually reacts to: the Engine.IO handshake (`open`) and
 * heartbeat (`ping`/`pong`), and the Socket.IO namespace lifecycle (`namespaceConnect`/`namespaceError`) and payload delivery (`message`). Anything the codec does not
 * recognize - including binary frames, which our text protocol never uses - decodes to `unknown` carrying the original text, so a consumer can log it without the codec
 * having to model every Engine.IO/Socket.IO packet type that the log stream never exercises.
 *
 * @category Log Client
 */
export type ProtocolEvent = { readonly kind: "message"; readonly event: string; readonly namespace: string; readonly payload: unknown } |
  { readonly kind: "namespaceConnect"; readonly namespace: string } |
  { readonly kind: "namespaceError"; readonly namespace: string; readonly reason: unknown } |
  { readonly kind: "open"; readonly pingInterval: number; readonly pingTimeout: number } |
  { readonly kind: "ping" } |
  { readonly kind: "pong" } |
  { readonly kind: "unknown"; readonly raw: string };

/**
 * An outbound protocol event to serialize, discriminated on `kind`.
 *
 * The client only ever needs to send three frame shapes: a namespace connect (`connect`), a namespace event with a JSON payload (`event` - this is how `tail-log` is
 * requested), and a heartbeat pong (`pong`). Modeling the outbound set as its own narrow union keeps {@link encodeFrame} total over exactly what the client sends, rather
 * than re-using the wider inbound {@link ProtocolEvent} and leaving unserializable arms.
 *
 * @category Log Client
 */
export type OutboundEvent = { readonly args: unknown; readonly event: string; readonly kind: "event"; readonly namespace: string } |
  { readonly kind: "connect"; readonly namespace: string } |
  { readonly kind: "pong" };

// Build the Socket.IO namespace prefix that addresses a frame at a namespace. The root namespace ("/") is implicit on the wire and carries no prefix; any other
// namespace is emitted as `/<name>,` - note the leading slash the server expects and the trailing comma that terminates the namespace token. Centralized here so both
// the connect and event encoders address namespaces identically.
function namespacePrefix(namespace: string): string {

  if(namespace === "/") {

    return "";
  }

  return "/" + namespace + ",";
}

/**
 * Serialize an outbound protocol event to its Engine.IO/Socket.IO wire text.
 *
 * Always emits EIO4-shaped frames: a namespace connect is `40<nsPrefix>`, an event is `42<nsPrefix>[event,args]`, and a pong is the bare Engine.IO `"3"`. The event
 * payload is `JSON.stringify`d as the `[eventName, args]` array the Socket.IO EVENT format requires.
 *
 * @param event - The outbound event to serialize. See {@link OutboundEvent}.
 *
 * @returns The wire text to send as a single WebSocket message.
 *
 * @category Log Client
 */
export function encodeFrame(event: OutboundEvent): string {

  switch(event.kind) {

    case "connect": {

      // A namespace CONNECT is an Engine.IO message (`4`) wrapping a Socket.IO CONNECT (`0`), addressed at the namespace.
      return ENGINE_MESSAGE + SOCKET_CONNECT + namespacePrefix(event.namespace);
    }

    case "event": {

      // A namespace EVENT is an Engine.IO message (`4`) wrapping a Socket.IO EVENT (`2`), addressed at the namespace, followed by the `[eventName, args]` JSON array.
      return ENGINE_MESSAGE + SOCKET_EVENT + namespacePrefix(event.namespace) + JSON.stringify([ event.event, event.args ]);
    }

    case "pong": {

      // A pong is a bare Engine.IO packet with no Socket.IO layer.
      return ENGINE_PONG;
    }

    default: {

      // The union is exhausted above; this satisfies the compiler's exhaustiveness check and guards against a future arm being added without a handler.
      return "";
    }
  }
}

// Parse the Socket.IO body that follows the Engine.IO message digit. The body is `<socketDigit>[<nsPrefix>][<ackId>][<json>]`; we peel each segment in order and return
// the resulting protocol event. Kept as a focused helper so {@link decodeFrame} stays a readable Engine.IO-layer switch.
function decodeSocketMessage(body: string): ProtocolEvent {

  const socketDigit = body.charAt(0);
  let rest = body.slice(1);

  // Peel an optional namespace prefix. A namespaced frame begins with `/`; the namespace token runs up to (and is terminated by) the first comma. When no leading slash
  // is present the frame addresses the root namespace, which carries no prefix on the wire.
  let namespace = "/";

  if(rest.startsWith("/")) {

    const comma = rest.indexOf(",");

    // A namespace prefix without its terminating comma is malformed; treat the whole remainder as the namespace and leave nothing for the payload, which the JSON peel
    // below tolerates as an empty body.
    if(comma === -1) {

      namespace = rest.slice(1);
      rest = "";
    } else {

      namespace = rest.slice(1, comma);
      rest = rest.slice(comma + 1);
    }
  }

  switch(socketDigit) {

    case SOCKET_CONNECT: {

      // A namespace CONNECT acknowledgement. EIO4 carries a `{"sid":"..."}` payload we do not need; EIO3 (under `allowEIO3`) carries nothing. Either way the event is a
      // namespace connect for the named namespace - the payload is intentionally discarded.
      return { kind: "namespaceConnect", namespace };
    }

    case SOCKET_CONNECT_ERROR: {

      // A namespace CONNECT_ERROR. The trailing JSON, when present, is the server's rejection reason (often `{ message }`); we surface it verbatim as `reason` for the
      // consumer to render. A malformed or absent reason decodes to `null`.
      return { kind: "namespaceError", namespace, reason: safeJsonParse(rest) };
    }

    case SOCKET_EVENT: {

      // A namespace EVENT carrying `[eventName, ...args]`. Peel an optional numeric ack id that may precede the JSON array (the server does not request acks on the log
      // stream, but the format permits one, so we skip leading digits before the `[`). The first array element is the event name; the second is the payload we forward.
      const jsonStart = rest.search(/[[{"]/);
      const json = jsonStart === -1 ? rest : rest.slice(jsonStart);
      const parsed = safeJsonParse(json);

      if(!Array.isArray(parsed) || (parsed.length === 0) || (typeof parsed[0] !== "string")) {

        // An EVENT whose body is not a `[stringEventName, ...]` array is not something we can route; surface it as unknown rather than fabricating an event name.
        return { kind: "unknown", raw: ENGINE_MESSAGE + body };
      }

      return { event: parsed[0], kind: "message", namespace, payload: parsed.length > 1 ? parsed[1] : undefined };
    }

    default: {

      // Any other Socket.IO packet type (ACK, BINARY_EVENT, BINARY_ACK, DISCONNECT) is not part of the log stream's vocabulary; surface the original message frame as
      // unknown so the consumer can log it without us modeling packet types the stream never produces.
      return { kind: "unknown", raw: ENGINE_MESSAGE + body };
    }
  }
}

// Parse JSON, returning `null` rather than throwing on malformed input. The wire is a trusted server, but a partial or non-JSON body must not crash the decoder; the
// caller treats a `null` result as "no structured payload."
function safeJsonParse(text: string): unknown {

  if(text.length === 0) {

    return null;
  }

  try {

    return JSON.parse(text);
  } catch {

    return null;
  }
}

/**
 * Decode a single inbound WebSocket frame into a {@link ProtocolEvent}.
 *
 * The decoder peels the leading Engine.IO packet-type digit and dispatches: `0` is the handshake open (whose JSON carries the ping interval/timeout), `2`/`3` are the
 * heartbeat, and `4` is a message whose remaining text is a Socket.IO packet decoded by the inner namespace/event parser. Anything else - including a non-string (binary)
 * frame, which our text protocol never produces - decodes to `unknown` carrying the original text.
 *
 * @param frame - The raw WebSocket message text.
 *
 * @returns The decoded protocol event.
 *
 * @category Log Client
 */
export function decodeFrame(frame: string): ProtocolEvent {

  // An empty frame carries no packet-type digit; classify it as unknown rather than indexing into nothing.
  if(frame.length === 0) {

    return { kind: "unknown", raw: frame };
  }

  const engineDigit = frame.charAt(0);
  const body = frame.slice(1);

  switch(engineDigit) {

    case ENGINE_OPEN: {

      // The Engine.IO open handshake. Its JSON body carries `pingInterval` and `pingTimeout` (milliseconds), which the socket uses to size its liveness watchdog. A
      // malformed or absent handshake decodes to zero intervals, which the consumer treats as "fall back to defaults."
      const handshake = safeJsonParse(body);
      const intervalValue = isRecord(handshake) ? handshake["pingInterval"] : undefined;
      const timeoutValue = isRecord(handshake) ? handshake["pingTimeout"] : undefined;
      const pingInterval = (typeof intervalValue === "number") ? intervalValue : 0;
      const pingTimeout = (typeof timeoutValue === "number") ? timeoutValue : 0;

      return { kind: "open", pingInterval, pingTimeout };
    }

    case ENGINE_PING: {

      return { kind: "ping" };
    }

    case ENGINE_PONG: {

      return { kind: "pong" };
    }

    case ENGINE_MESSAGE: {

      return decodeSocketMessage(body);
    }

    default: {

      return { kind: "unknown", raw: frame };
    }
  }
}

// Narrow an unknown value to a plain record so its properties can be read without unsafe member access. Used to read the handshake JSON's numeric fields defensively.
function isRecord(value: unknown): value is Record<string, unknown> {

  return (typeof value === "object") && (value !== null);
}

/**
 * The Socket.IO namespace, with its leading slash, that the log stream is served on. The wire format addresses namespaces with a leading slash (`/log`), whereas the
 * `LOG_NAMESPACE` setting holds the bare name (`log`). This constant supplies the slash-prefixed namespace token used to hand-assemble the raw Socket.IO disconnect frame
 * (`"41/log,"`), where {@link encodeFrame} is bypassed. It must NOT be passed to `encodeFrame`: that codec's connect and event arms take the bare `LOG_NAMESPACE` and
 * derive the leading slash themselves, so handing them `LOG_NAMESPACE_PATH` would prepend a second slash and emit a malformed `"//log,"` prefix.
 *
 * @category Log Client
 */
export const LOG_NAMESPACE_PATH = "/" + LOG_NAMESPACE;
