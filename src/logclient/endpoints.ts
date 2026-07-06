/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/endpoints.ts: Authority and URL construction for the Homebridge UI log client.
 */

/**
 * Single authority for constructing the URLs the log client connects to.
 *
 * Every transport (`auth.ts`, `rest.ts`, `socket.ts`) applies the same TLS-to-scheme mapping (http/https for REST and auth, ws/wss for the socket) and authority assembly
 * over the same host + port. Routing that derivation through one module keeps the mapping and assembly in exactly one place, so a change to how URLs are built propagates
 * everywhere rather than being re-derived (and potentially diverging) at each call site. The functions are pure string builders with no I/O.
 *
 * @module
 */
import { SOCKET_PATH } from "./settings.ts";

// Format a host for inclusion in a URL authority, bracketing a bare IPv6 literal as the URL syntax requires. A literal IPv6 address contains colons, which collide with
// the host:port separator, so the URL grammar requires it to be wrapped in square brackets (`[::1]:8581`). A hostname or IPv4 address passes through unchanged. We
// detect an IPv6 literal by the presence of a colon and the absence of existing brackets, which is sufficient because no hostname or IPv4 address contains a colon.
function formatHost(host: string): string {

  if(host.includes(":") && !host.startsWith("[")) {

    return "[" + host + "]";
  }

  return host;
}

// Build the scheme + authority origin for a target under a given scheme. We assemble the authority string by hand (bracketing IPv6) and construct a `URL` from the
// complete string so the platform validates and normalizes it in one pass - rather than mutating an empty `URL`'s `hostname`, whose setter silently rejects a bare IPv6
// literal. The `URL.origin` is the scheme + authority with no trailing slash; `httpBaseUrl` exposes that origin string for downstream path concatenation, while
// `socketUrl` keeps the `URL` object and configures it further via `pathname`/`searchParams`.
function originFor(scheme: string, target: EndpointTarget): URL {

  return new URL(scheme + "://" + formatHost(target.host) + ":" + target.port.toString());
}

/**
 * The connection target shared by every URL builder in this module.
 *
 * @property host - The hostname or IP address of the homebridge-config-ui-x server.
 * @property port - The TCP port the server listens on.
 * @property tls  - When `true`, URLs use the secure scheme (`https`/`wss`); when `false` or omitted, the plaintext scheme (`http`/`ws`).
 *
 * @category Log Client
 */
export interface EndpointTarget {

  readonly host: string;
  readonly port: number;
  readonly tls?: boolean;
}

/**
 * Build the HTTP(S) base URL (scheme + authority, no trailing slash) for the REST and auth endpoints.
 *
 * The returned string is the origin only - callers append the specific API path. We construct it through the platform `URL` so host and port are normalized and
 * encoded consistently, then read `URL.origin`, which yields the scheme + authority with no trailing slash, so callers can concatenate a leading-slash path without
 * producing a double slash.
 *
 * @param target - The connection target. See {@link EndpointTarget}.
 *
 * @returns The origin, e.g. `https://localhost:8581`, with no trailing slash.
 *
 * @category Log Client
 */
export function httpBaseUrl(target: EndpointTarget): string {

  // The scheme follows the TLS flag: `https` when secure, `http` otherwise. `URL.origin` yields the scheme + authority with no path - exactly the trailing-slash-free
  // base callers want to append a leading-slash path to.
  return originFor(target.tls === true ? "https" : "http", target).origin;
}

/**
 * The connection target plus the raw handshake token, used to build the WebSocket connect URL.
 *
 * @property token - The raw JWT, passed verbatim in the query string. The server's WebSocket guard reads `client.handshake.query.token` with no `Bearer` prefix and no
 *                   fallback, so the token must be the bare JWT.
 *
 * @category Log Client
 */
export interface SocketTarget extends EndpointTarget {

  readonly token: string;
}

/**
 * Build the WebSocket connect URL for the live-log Socket.IO stream.
 *
 * The URL carries the Engine.IO version, the WebSocket transport selector, and the raw token in its query string; the server's handshake guard authenticates from that
 * token alone. We build through the platform `URL` and `searchParams` so the token is percent-encoded correctly (a JWT contains `.` and may carry `-`/`_` from base64url,
 * which are URL-safe, but routing through `searchParams` keeps encoding correct regardless of token shape).
 *
 * @param target - The connection target plus the raw token. See {@link SocketTarget}.
 *
 * @returns The full `ws(s)://host:port/socket.io/?EIO=4&transport=websocket&token=<rawjwt>` connect URL.
 *
 * @category Log Client
 */
export function socketUrl(target: SocketTarget): string {

  // The WebSocket schemes mirror the HTTP schemes: `wss` for TLS, `ws` otherwise. We start from the validated origin, then set the Socket.IO mount path and the standard
  // Engine.IO query parameters; the server requires `EIO=4` and the `websocket` transport for a raw WebSocket connection. Routing the token through `searchParams`
  // percent-encodes it correctly regardless of its character set.
  const url = originFor(target.tls === true ? "wss" : "ws", target);

  url.pathname = SOCKET_PATH;
  url.searchParams.set("EIO", "4");
  url.searchParams.set("transport", "websocket");
  url.searchParams.set("token", target.token);

  return url.toString();
}
