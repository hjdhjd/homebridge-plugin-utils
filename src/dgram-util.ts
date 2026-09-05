/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * dgram-util.ts: Shared UDP socket helpers - the IP-family translation tables and the socket factory.
 */

/**
 * Single source of truth for the `"ipv4"` / `"ipv6"` -> `node:dgram` translations every datagram consumer in the library needs.
 *
 * Every call site that needs the ipFamily -> node:dgram translation routes through the table lookups exported here, rather than hand-rolling
 * `ipFamily === "ipv6" ? "udp6" : "udp4"` or `isIPv6 ? "::1" : "127.0.0.1"` inline. Keeping the mapping centralized means a future addition (dual-stack socket
 * types, SO_REUSEADDR flags, alternative loopback addresses in constrained test environments) has exactly one file to update, and consumers - production or
 * test - share the same vocabulary. The FFmpeg subsystem's `rtp.ts` and `stream.ts` and the test fixtures beside them are examples of that traffic.
 *
 * This module imports `node:dgram` and is therefore Node-only, like `util.ts`. A browser-targeted consumer cannot resolve that import.
 *
 * @module
 */
import type { Socket } from "node:dgram";
import { createSocket } from "node:dgram";

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
 * @param ipFamily - The IP family for the new socket.
 *
 * @returns A fresh unbound {@link Socket}.
 *
 * @category Utilities
 */
export function createDgramSocket(ipFamily: IpFamily): Socket {

  return createSocket(DGRAM_SOCKET_TYPE[ipFamily]);
}
