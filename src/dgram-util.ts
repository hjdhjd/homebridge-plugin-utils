/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * dgram-util.ts: Shared UDP socket helpers - the IP-family translation tables, the socket factory, and the connected-datagram route probe.
 */

/**
 * Single source of truth for the `"ipv4"` / `"ipv6"` -> `node:dgram` translations every datagram consumer in the library needs.
 *
 * Every call site that needs the ipFamily -> node:dgram translation routes through the table lookups exported here, rather than hand-rolling
 * `ipFamily === "ipv6" ? "udp6" : "udp4"` or `isIPv6 ? "::1" : "127.0.0.1"` inline. Keeping the mapping centralized means a future addition (dual-stack socket
 * types, alternative loopback addresses in constrained test environments) has exactly one file to update, and consumers - production or test - share the same
 * vocabulary. A socket option a caller needs travels the same way: {@link createDgramSocket} carries the address-reuse flag as an option of its own, so a
 * multicast listener that has to share a well-known port asks for it by name here rather than reaching past the factory to `createSocket`. The FFmpeg
 * subsystem's `rtp.ts` and `stream.ts` and the test fixtures beside them are examples of that traffic.
 *
 * {@link localAddressFor} lives here for the same reason: it is a datagram helper, answering which local address the operating system would route toward a host by
 * connecting a socket and reading what the kernel bound, and the translation tables above are what it opens that socket through.
 *
 * This module imports `node:dgram`, `node:dns`, `node:dns/promises`, and `node:net` and is therefore Node-only, like `util.ts`. A browser-targeted consumer cannot
 * resolve those imports.
 *
 * @module
 */
import type { Socket, SocketOptions } from "node:dgram";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { lookup as lookupByCallback } from "node:dns";
import { once } from "node:events";
import { waitWithSignal } from "./util.ts";

/**
 * The two IP families the library's datagram helpers support. Centralized here so consumers - the FFmpeg subsystem's `rtp.ts` and `stream.ts`, the test fixtures
 * beside them, and anything else opening a datagram socket - share the same union rather than re-declaring inline unions at every init-type boundary.
 *
 * @category Utilities
 */
export type IpFamily = "ipv4" | "ipv6";

// `node:dgram` socket-type strings keyed by IP family. The union is narrowed by the `as const` so downstream types (e.g., the parameter to `createSocket`) retain
// the literal types `"udp4"` / `"udp6"` through the lookup.
const DGRAM_SOCKET_TYPE = { ipv4: "udp4", ipv6: "udp6" } as const;

// Loopback addresses keyed by IP family. Note that `"::1"` is the IPv6 loopback specifically, not the any-address form - sockets bound here accept only local-host
// traffic, which matches every current consumer's intent (health probes, port reservations, test fixtures).
const LOOPBACK_ADDRESS = { ipv4: "127.0.0.1", ipv6: "::1" } as const;

// The destination the route probe connects toward: the discard service port. Nothing is ever sent, so which port it is has no effect on the answer - the port exists
// only to give the kernel a destination to consult its routing table about. Port zero cannot serve: `connect` refuses it outright.
const ROUTE_PROBE_PORT = 9;

/* The destination lookup every socket from this factory sends through. The platform resolves a destination before it writes, and answers even an address literal
 * on a later tick of the event loop; a literal is answered here at once, so the kernel takes the datagram inside `send`, and whatever the caller set on the
 * socket just before - the multicast interface above all - is what the datagram leaves under. A name is handed to the platform resolver unchanged. The callback
 * runs synchronously for a literal by design, and the socket's send path accepts either timing. It is declared against the socket option's own type, so the
 * two cannot drift apart; the platform hands the family as a bare number where that type declares an options object, and it is passed through untouched.
 */
const lookupDestination: NonNullable<SocketOptions["lookup"]> = (hostname, options, callback): void => {

  const family = isIP(hostname);

  if(family !== 0) {

    callback(null, hostname, family);

    return;
  }

  lookupByCallback(hostname, options, callback);
};

/**
 * Resolve the loopback address string for the supplied IP family. The returned literal is suitable for passing to `socket.bind(port, address)` or
 * `socket.send(..., address, ...)`.
 *
 * @param ipFamily - The IP family to resolve.
 *
 * @returns `"127.0.0.1"` for `"ipv4"` or `"::1"` for `"ipv6"`.
 *
 * @category Utilities
 */
export function loopbackAddress(ipFamily: IpFamily): (typeof LOOPBACK_ADDRESS)[IpFamily] {

  return LOOPBACK_ADDRESS[ipFamily];
}

/**
 * Create a `node:dgram` socket for the supplied IP family. Equivalent to `createSocket("udp4")` / `createSocket("udp6")` but routes the family -> socket-type lookup
 * through the single table above, so every call site shares one mapping.
 *
 * Every socket the factory makes answers an address-literal destination without a resolver round trip, while a name resolves through the platform resolver. A
 * datagram to a literal is therefore on the wire before `send` returns, so a caller that sets the socket's multicast interface before each send has the
 * interface it set when the kernel takes the datagram. A `bind` or a `connect` to a literal completes inside the call for the same reason, so a caller registers
 * its `listening` or `connect` listener before calling, which is the platform's own documented order.
 *
 * @param ipFamily             - The IP family for the new socket.
 * @param options              - Optional socket options.
 * @param options.reuseAddr    - Whether the socket shares its port with every other reuse-bound socket on the host. That is what lets a multicast listener sit
 *                               beside the operating system's own responder on a well-known port, each receiving every datagram the group delivers. Defaults to
 *                               `false`.
 *
 * @returns A fresh unbound {@link Socket}.
 *
 * @category Utilities
 */
export function createDgramSocket(ipFamily: IpFamily, { reuseAddr = false }: { readonly reuseAddr?: boolean } = {}): Socket {

  return createSocket({ lookup: lookupDestination, reuseAddr, type: DGRAM_SOCKET_TYPE[ipFamily] });
}

/**
 * The local address the operating system routes toward a host, which is the interface a peer at that host can reach this process on.
 *
 * The host is resolved first, through the platform resolver and in the operating system's own order, and the socket is opened in the family the record answered. A
 * name's records decide the family rather than its spelling, so a host whose only record is an IPv6 one is probed over an IPv6 socket and answered rather than
 * refused. A literal is answered by the resolver without a query and in its own family, so a literal travels this same path with no branch of its own. The socket is
 * opened only once the resolver has answered, which is also what makes a lifetime that ends during the lookup open nothing at all.
 *
 * That socket is then connected and its local address read. No packet is sent: connecting a datagram socket only fixes its default destination, and fixing that
 * destination is what makes the kernel consult its routing table and bind the local address it would send from. That is a more honest answer than enumerating the
 * host's interfaces and guessing which one faces the peer, because a host with several interfaces has no single right answer to guess at.
 *
 * The `connect` event is awaited rather than a callback passed, because the platform declares that callback to take no arguments: a callback shape that reads an
 * error argument types only by declaring a parameter the contract does not promise, and then reads past it at runtime. With no callback, the runtime emits `connect`
 * on success and `error` on failure, which `events.once` turns into a rejection carrying the family code - so an address whose family the socket cannot reach is a
 * failure the caller sees rather than an address that means nothing.
 *
 * The socket is unreferenced, so it never holds the process open. A name lookup already in flight is a threadpool request no API cancels, so it holds the process
 * until the resolver answers however this call ends; `signal` ends the caller's wait at once, and the lookup then drains into the wait combinator below, which has
 * already marked its answer handled.
 *
 * @param host            - The peer's address or hostname.
 * @param options         - Optional inputs.
 * @param options.signal  - The caller's lifetime. Aborting it rejects with the signal's reason, whether it had already fired or fires while the lookup is pending.
 *
 * @returns The local address the route toward that host would leave from.
 *
 * @throws The resolver's own error when the host does not resolve, the address-family error when the resolved address cannot be reached, and `signal.reason` when
 * the caller's lifetime ends first.
 *
 * @example
 *
 * ```ts
 * import { localAddressFor } from "homebridge-plugin-utils";
 *
 * // The address to hand a controller as the endpoint it should post back to.
 * const endpoint = await localAddressFor(controllerHost, { signal: this.signal });
 * ```
 *
 * @category Utilities
 */
export async function localAddressFor(host: string, options: { signal?: AbortSignal } = {}): Promise<string> {

  // A lifetime that has already ended opens no socket at all, rather than opening one and tearing it down a line later.
  options.signal?.throwIfAborted();

  /* The resolver is what decides the family, so a name's records rather than its spelling choose the socket. Opening the socket only once the answer is in hand is
   * also what makes a lifetime that ends during the lookup open nothing at all, and this wait is ended by the same combinator the connect wait below explains.
   */
  const resolved = lookup(host);
  const { address, family } = await ((options.signal === undefined) ? resolved : waitWithSignal(resolved, options.signal));
  const socket = createDgramSocket((family === 6) ? "ipv6" : "ipv4");

  // Excluded from Node's reference counting, so a probe in flight never keeps the process alive on its own account.
  socket.unref();

  try {

    // Registered before the connect is asked for, so an outcome arriving in the same turn as the request has a listener waiting for it.
    const connected = once(socket, "connect");

    socket.connect(ROUTE_PROBE_PORT, address);

    /* `waitWithSignal` is the library's one combinator for a wait a caller's signal may end: it rejects with the signal's reason rather than a bare `AbortError`,
     * and it marks the underlying promise handled, so a `connect` or `error` that settles against the closed socket after an abort lands somewhere. That is why
     * `once` above takes no signal of its own and no catch is hand-rolled here.
     */
    await ((options.signal === undefined) ? connected : waitWithSignal(connected, options.signal));

    return socket.address().address;
  } finally {

    /* Closed on every path, including both failure paths. A second close is the only thing `close()` throws on and this function performs none, so the swallowing
     * catch a defensive version would carry here would only hide a real defect.
     */
    socket.close();
  }
}
