/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/address.ts: Address classification for a resolved mDNS service - which of its advertised addresses to dial, and whether a held one is still among them.
 */

/**
 * The address arithmetic a resolved mDNS service's consumer needs, kept apart from {@link mdns/browser!MdnsBrowser | MdnsBrowser} itself: which advertised
 * address to dial, and whether a held address is still among what a fresh advertisement carries. {@link mdns/browser!MdnsService.addresses |
 * MdnsService.addresses} promises only arrival order and no duplicates - no family preference, and no stability across a record's lapse and return - so
 * every consumer that wants a dialable address answers the same two questions this module answers, rather than each writing its own family and stability
 * rules.
 *
 * **The ranges.** {@link isLinkLocal} and this module's unique-local check test an IPv6 address's first sixteen-bit group against RFC 4291 section 2.5.6's
 * `fe80::/10` and RFC 4193 section 3.1's `fc00::/7` respectively, the same bit-mask idiom for both: a named prefix, a named mask, the first group read as
 * hex. Neither reaches for `node:net`'s `BlockList`, which parses a subnet at construction for a check this module makes at most twice per candidate
 * address.
 *
 * @module
 */
import type { Nullable } from "../util.ts";
import { isIP } from "node:net";

// RFC 4291 section 2.5.6: a link-local address is one whose first ten bits read 1111111010, which is fe80::/10 - the first group, masked to those ten bits,
// reads fe80.
const IPV6_LINK_LOCAL_PREFIX = 0xfe80;
const IPV6_LINK_LOCAL_PREFIX_MASK = 0xffc0;

// RFC 4193 section 3.1: a unique-local address is one whose first seven bits read 1111110, which is fc00::/7 - the first group, masked to those seven bits,
// reads fc00.
const IPV6_UNIQUE_LOCAL_PREFIX = 0xfc00;
const IPV6_UNIQUE_LOCAL_PREFIX_MASK = 0xfe00;

// An IPv6 address's first sixteen-bit group, in the text form the parser writes, read as hex - the one field isLinkLocal and isUniqueLocal each mask
// against their own prefix.
function firstGroup(address: string): number {

  return Number.parseInt(address.slice(0, address.indexOf(":")), 16);
}

// Whether an IPv6 address in the text form the parser writes is link-local: its first group falls in fe80::/10, which reads fe80 through febf.
export function isLinkLocal(address: string): boolean {

  return (firstGroup(address) & IPV6_LINK_LOCAL_PREFIX_MASK) === IPV6_LINK_LOCAL_PREFIX;
}

// Whether an IPv6 address in the text form the parser writes is unique-local: its first group falls in fc00::/7, which reads fc00 through fdff. Unique-local
// is the range a site assigns itself, so it survives an ISP handing out a new global prefix, which is what makes it worth ranking ahead of a global address.
function isUniqueLocal(address: string): boolean {

  return (firstGroup(address) & IPV6_UNIQUE_LOCAL_PREFIX_MASK) === IPV6_UNIQUE_LOCAL_PREFIX;
}

// The zone a datagram's source carries, which the platform writes after a percent sign for a link-local source, and null for a source without one.
export function zoneOf(source: string): Nullable<string> {

  const at = source.indexOf("%");

  return (at === -1) ? null : source.slice(at + 1);
}

// The lowest member of a candidate class by plain string comparison, or undefined when the class is empty. One answer for one set, whatever order the set
// arrived in.
function lowest(candidates: readonly string[]): string | undefined {

  return candidates.length ? candidates.reduce((best, candidate) => (candidate < best) ? candidate : best) : undefined;
}

/**
 * Choose the address a consumer dials to reach a resolved mDNS service, ranking the whole set of what it advertises rather than reading the set's first
 * entry: over IPv6 where the service offers a routable address, over IPv4 otherwise, and over an unzoned link-local address only when nothing else
 * qualifies.
 *
 * The answer is a function of the SET of advertised addresses and never of their order. {@link mdns/browser!MdnsService.addresses | MdnsService.addresses}
 * lists a host's addresses in the order its records arrived in the browser's cache, and a record that lapses and is re-announced re-enters at the end of
 * that order, so a caller that read "the first address" across two derivations of one service would read an ordinary re-announcement as the device having
 * moved. Ranking the set is what keeps the answer stable across that reordering: unique-local leads because it is the range a site assigns itself and so
 * survives an ISP prefix rotation, and within one class the lowest string wins, a comparison whose only job is to give one answer for one set.
 *
 * While a host's address is changing, the browser reports only its live addresses once a replacement exists: the outgoing address leaves the reported
 * set the instant the incoming one is cached, and this function sees the incoming address alone. The outgoing address surfaces here only when it is
 * the host's last address of either family - nothing live to report - for the second its own hold keeps it reachable.
 *
 * A zoned candidate is dropped before anything else classifies it. This library dials through undici, which parses the origin as a WHATWG URL, and a URL
 * has no syntax for an IPv6 zone ID: a zoned literal is refused as an invalid URL before any connection is attempted, even though Node's `net` module
 * accepts one.
 *
 * @param addresses - The service's advertised addresses, in any order.
 *
 * @returns The address to dial, or `null` when nothing advertised qualifies.
 *
 * @category mDNS
 */
export function dialAddress(addresses: readonly string[]): Nullable<string> {

  // undici parses the origin it dials as a WHATWG URL, which has no syntax for an IPv6 zone ID, so a zoned candidate leaves before anything is classified.
  const unzoned = addresses.filter((candidate) => zoneOf(candidate) === null);
  const ipv4 = unzoned.filter((candidate) => isIP(candidate) === 4);
  const ipv6 = unzoned.filter((candidate) => isIP(candidate) === 6);
  const linkLocal = ipv6.filter((candidate) => isLinkLocal(candidate));
  const routable = ipv6.filter((candidate) => !isLinkLocal(candidate));
  const uniqueLocal = routable.filter((candidate) => isUniqueLocal(candidate));

  // The ranking, best to last resort. Every tier is ranked by the same lowest-string comparator, so the address chosen is a function of the set alone,
  // never of the order its members arrived in.
  return lowest(uniqueLocal) ?? lowest(routable) ?? lowest(ipv4) ?? lowest(linkLocal) ?? null;
}

/**
 * Whether a service still advertises `address`, the question a connection owner means to ask of a fresh advertisement - deliberately not the question
 * {@link dialAddress} answers. A browser re-derives a host's address list every time one of its records lapses or returns, so the ranked pick can move
 * between a device's own addresses on nothing more than ordinary packet loss; a connection is stale only when the address it was opened at is gone from the
 * advertisement altogether. Comparing a held address against a fresh pick therefore tears healthy connections down on a reorder, and this membership test
 * does not.
 *
 * `addresses` is read exactly as advertised, zoned entries included, because an address a consumer would never dial is still the service saying it answers
 * there: the comparison here is against the full advertised list, never against {@link dialAddress}'s filtered, ranked view of it.
 *
 * One case this test still cannot distinguish: a lone held address's own hold ending, versus the device having moved off it entirely - both read as
 * gone from the advertisement the same way, so the connection is reopened once either way. That case is the only one where a held address stays
 * advertised at all: once a live address of either family exists for the host, the outgoing address drops from the advertisement at once, and this
 * test reads false for it immediately, rather than after any grace window.
 *
 * @param addresses - The service's currently advertised addresses.
 * @param address   - The address a held connection was opened at.
 *
 * @returns `true` when `address` is still among `addresses`.
 *
 * @category mDNS
 */
export function isAdvertisedAt(addresses: readonly string[], address: string): boolean {

  return addresses.includes(address);
}
