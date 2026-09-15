/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/browser.ts: The RFC 6762 querier that browses one service type over a reuse-bound socket per address family.
 */

/**
 * The multicast DNS querier a plugin browses one service type with: a socket per address family, one timeline, and one synchronous sink.
 *
 * {@link MdnsBrowser} owns the mDNS mechanism and nothing above it. It binds a datagram socket to port 5353 with address reuse for each family it serves, joins
 * the group on every non-internal interface of that family, asks the browsing question on the RFC 6762 section 5.2 cadence with the known-answer suppression of
 * section 7.1, caches what the responses carry, re-queries each cached record at the checkpoints section 5.2 names, holds a goodbye (section 10.1) and a flushed
 * name and type (section 10.2) for one second before deleting, and asks RFC 6763 section 12's follow-up questions for the records a responder did not attach.
 * Each transition it derives - a service found, updated, or lost - reaches the `onEvent` it was constructed with at the moment it derives it. Devices and
 * consumer projections belong to `discovery.ts` above this module, and the bytes belong to `message.ts` below it.
 *
 * **One socket per family.** A reuse-bound socket receives what its siblings receive, so each of these sits beside the operating system's own responder on the
 * well-known port and a second browser in the same process opens sockets of its own. The multicast interface is set on a socket before each of its sends rather
 * than one socket being bound per interface, which is what lets a single socket of a family ask the same question on every link of that family. Everything
 * above the sockets is singular: one cache, one timeline, one cadence, one known-answer list, one set of holds, and one warmup deadline serve every family.
 *
 * **One timeline.** Every timed action - the browse question's next send, each pending resolution attempt, each cached record's maintenance checkpoints and its
 * expiry, the one-second holds, the warmup deadline, and the interface poll - is a deadline in one min-heap, and exactly one `clock.schedule` is armed at the
 * nearest of them. A timer per record would cost dozens of handles to answer the question one heap answers. It is also why the warmup deadline behind
 * {@link MdnsBrowser.settled} lives here although the promise serves the consumer of the discovery surface: a second clock timer up there would cost what this
 * design refuses. An entry whose subject has been rescheduled is skipped by its generation rather than removed, so the heap never needs a delete.
 *
 * **One synchronous sink.** The browser's consumer is the discovery surface alone, and it is handed each transition as the browser derives it. That is what
 * makes {@link MdnsBrowser.services} a live reading of what the network has said rather than a view of what some consumer's loop has reached, and it leaves
 * asynchrony to exactly one place: the stream the plugin iterates.
 *
 * **The interface poll.** The interface set is re-read at every scheduled query, and a link that appears between queries is joined by a poll on the same
 * timeline. Without the poll, a browser holding nothing in its cache would learn of a new link only at the backed-off browse cadence, which climbs to an hour;
 * with it, whichever fire joins the link first also asks the browse question on it, so a responder there answers at once.
 *
 * **Divergences, stated.** A response is read whatever address it came from: RFC 6762 section 11 describes a source check this browser does not perform, on the
 * reasoning that a querier which ignores answers from off-subnet responders is the likelier field failure on a home network with several links. And membership
 * is joined on every non-internal interface of the family rather than on a curated set, because a plugin cannot tell the library which link its devices are on.
 *
 * **Purity per socket.** A socket caches the address records of its own family alone, which is what lets a link-local AAAA carry the zone of the datagram that
 * delivered it: a zone is the property of an IPv6 datagram's source, and a datagram on the IPv4 socket carries none. RFC 6762 section 20 describes a dual-stack
 * host as two logical segments with two `.local.` zones, and section 20 also has such a host perform its lookups over both families, which is what this browser
 * does: one host's addresses of both families meet in one service, in arrival order. Every query goes out on every socket, so a maintenance question over one
 * family's socket is what harvests the other family's address a dual-stack responder attaches for fate sharing (section 6.2). An IPv6 socket joins its group on
 * every link-local interface, named to the socket by its interface rather than an address, because a global or unique-local address is never a multicast link.
 *
 * **The fault rule.** A socket that fails - refused at bind, or dead after it listened - is dropped with a warning and the browser serves what remains, ending
 * only when no socket remains. That is what makes serving both families safe on a host whose kernel refuses one of them, and it leaves no silent half-death:
 * the warning is the consumer's signal. The cached records of a dropped family are left to expire at their ttl rather than flushed, because the browser can
 * neither confirm nor deny them without a socket of that family, and their maintenance questions go out on a surviving socket whose purity drops the answer.
 *
 * **The zone on a link-local address.** An IPv6 link-local address is only reachable through the link it was heard on, so an AAAA record carrying one is cached
 * with the zone of the datagram that delivered it, `fe80::...%en0`, and a consumer connects to the string as it reads it. A global or unique-local address stays
 * as the wire spelled it. A link-local address delivered by a source that carries no zone stays bare, because there is no zone to give it.
 *
 * **The accepted caveats.** RFC 6762 section 5.2's flush-bit shortcut - stop a question's series once a unique answer arrives - does not apply here: the browse
 * question asks for shared PTR records, and a resolution asks only for what is still missing, so an answered question stops on its own and an unanswered one
 * keeps the series the RFC prescribes. And `setMulticastInterface` binds the interface when the kernel takes the datagram, which is inside `send` itself: each
 * socket comes from `createDgramSocket`, which answers an address-literal destination without a resolver round trip. A send libuv queued against a full send
 * buffer would still leave under whatever interface is current when it flushes; awaiting each interface's send callback would serialize the sends and turn every
 * timer fire asynchronous, for a race a few small query packets an hour cannot produce.
 *
 * **Dependency inversion.** Each socket arrives through {@link MdnsSocketFactory} and the browser calls only the members {@link MdnsSocket} declares, so the
 * suite drives cadence, cache, holds, and suppression with no network and no wall clock. A consumer substitutes one level up instead, at
 * {@link MdnsBrowserFactory}, where the shipped `TestMdnsBrowser` stands in.
 *
 * @module
 */
import { DNS_TYPE_A, DNS_TYPE_AAAA, DNS_TYPE_PTR, DNS_TYPE_SRV, DNS_TYPE_TXT, buildMdnsQuery, dnsNameKey, dnsNamesEqual, dnsRecordType, formatDnsName, parseDnsMessage,
  parseDnsName } from "./message.ts";
import type { DnsName, DnsQuestion, DnsRecord, DnsRecordKind, DnsSrvRecord, DnsTxtRecord } from "./message.ts";
import { HbpuAbortError, composeSignals, exponentialBackoff, formatErrorMessage, membershipDelta, onAbort, sameEntries } from "../util.ts";
import type { HomebridgePluginLogging, Nullable } from "../util.ts";
import type { Clock } from "../clock.ts";
import type { IpFamily } from "../dgram-util.ts";
import type { NetworkInterfaceInfo } from "node:os";
import type { RemoteInfo } from "node:dgram";
import { createDgramSocket } from "../dgram-util.ts";
import { markHandled } from "../mark-handled.ts";
import { networkInterfaces } from "node:os";
import { systemClock } from "../clock.ts";

/**
 * The port multicast DNS is spoken on, which RFC 6762 section 5.2 makes both the destination and the source port of every query.
 *
 * @category mDNS
 */
export const MDNS_PORT = 5353;

/**
 * The longest interval between browsing queries, in milliseconds: the sixty minutes RFC 6762 section 5.2 offers as the cap a doubling series may stop at, and
 * the default for {@link MdnsBrowserOptions.ceilingMs}.
 *
 * @category mDNS
 */
export const MDNS_QUERY_CEILING_MS = 3600000;

/**
 * How long after the first query {@link MdnsBrowser.settled} resolves, in milliseconds, and the default for {@link MdnsBrowserOptions.warmupMs}. It is the
 * window a one-shot consumer gives a quiet network to answer in before it reads what was found.
 *
 * @category mDNS
 */
export const MDNS_WARMUP_MS = 10000;

/**
 * The address families a browser serves when {@link MdnsBrowserOptions.ipFamilies} names none: both of them, IPv4 first. RFC 6762 section 20 has a dual-stack
 * host perform its lookups over both families, and a consumer that wants one names it.
 *
 * @category mDNS
 */
export const MDNS_DEFAULT_FAMILIES = [ "ipv4", "ipv6" ] as const satisfies readonly [IpFamily, ...IpFamily[]];

// The interval between the first browsing query and the second, doubled for each one after it (RFC 6762 section 5.2), and the seed of a resolution's ladder.
const MDNS_QUERY_SEED_MS = 1000;

// The window the first query of a series is delayed into, in milliseconds: RFC 6762 section 5.2's random 20 to 120 ms, which keeps a room full of devices
// powering up together from asking in the same instant.
const MDNS_FIRST_QUERY_MIN_MS = 20;
const MDNS_FIRST_QUERY_SPREAD_MS = 100;

// The fractions of a record's ttl at which RFC 6762 section 5.2 re-queries a record something still points at. A fire past the last of them is the record's
// expiry rather than another question.
const MDNS_MAINTENANCE_CHECKPOINTS = [ 0.8, 0.85, 0.9, 0.95 ] as const;

// The spread RFC 6762 section 5.2 adds to each checkpoint, as a fraction of the ttl, so a fleet of devices sharing a ttl does not re-query in lockstep.
const MDNS_MAINTENANCE_JITTER = 0.02;

// How long a goodbye (RFC 6762 section 10.1) and a flushed name and type (section 10.2) hold a record before it is deleted, in milliseconds. The hold is what
// lets an announcement that follows a responder's goodbye rescue what it was about to delete.
const MDNS_HOLD_MS = 1000;

// The longest a link that appears between queries goes unnoticed, in milliseconds: short against the browse cadence's ceiling, long against the cost of one
// interface enumeration.
const MDNS_INTERFACE_POLL_MS = 15000;

// The hop limit RFC 6762 section 11 asks every multicast DNS datagram to carry, so a packet that escapes onto a routed path is dropped rather than delivered.
const MDNS_MULTICAST_TTL = 255;

// RFC 4291 section 2.5.6: a link-local address is one whose first ten bits read 1111111010, which is fe80::/10 - the first group, masked to those ten bits,
// reads fe80.
const IPV6_LINK_LOCAL_PREFIX = 0xfe80;
const IPV6_LINK_LOCAL_PREFIX_MASK = 0xffc0;

/* What the family decides: the platform's own spelling of it, the group a socket of it sends to and joins, the address record it caches and asks for, and how a
 * host link of the family is named to that socket. One socket holds one profile for its life, so no site of it branches on the family.
 */
interface FamilyProfile {

  readonly addressKind: Extract<DnsRecordKind, "a" | "aaaa">;
  readonly addressType: number;
  readonly family: NetworkInterfaceInfo["family"];
  readonly group: string;
  readonly link: (entry: NetworkInterfaceInfo, name: string) => Nullable<string>;
}

/* The two families, each RFC 6762 section 3's group and RFC 6762 section 20's own logical segment. An IPv4 link is named to the socket by its address. An
 * IPv6 link is named by its interface, in the scoped-wildcard form Node accepts for a membership, a drop, and the multicast interface alike - a bare link-local
 * address joins but cannot drop - and only a link-local interface is a link: a global or unique-local address is never a multicast link, and its entry carries
 * a scope id of zero. Several link-local addresses on one interface name the same link, and the refresh keeps one membership for it. Each link predicate tests
 * an interface entry against its own row's `family`, so a family's platform spelling is written here once and the warning about a lost socket reads that same
 * field; the rows are in hand long before any predicate runs, which is what lets one read the other.
 */
const MDNS_FAMILY: Readonly<Record<IpFamily, FamilyProfile>> = {

  ipv4: { addressKind: "a", addressType: DNS_TYPE_A, family: "IPv4", group: "224.0.0.251",
    link: (entry: NetworkInterfaceInfo): Nullable<string> => ((entry.family === MDNS_FAMILY.ipv4.family) && !entry.internal) ? entry.address : null },
  ipv6: { addressKind: "aaaa", addressType: DNS_TYPE_AAAA, family: "IPv6", group: "ff02::fb",
    link: (entry: NetworkInterfaceInfo, name: string): Nullable<string> => ((entry.family === MDNS_FAMILY.ipv6.family) && !entry.internal &&
      (entry.scopeid !== 0)) ? "::%" + name : null }
};

/* One served family's socket and everything that belongs to that socket alone: the family's row, what this socket has done about each link designation that
 * family answers for, whether it has come up, the resolvers its own close settles, and the socket itself. `listening` exists because a membership added before
 * the socket is bound would bind it to an ephemeral port, so a refresh reconciles only the sockets that have come up.
 */
interface FamilySocket {

  readonly closed: PromiseWithResolvers<void>;
  readonly family: FamilyProfile;
  readonly interfaces: Map<string, "joined" | "refused">;
  listening: boolean;
  readonly socket: MdnsSocket;
}

// What one refresh joined through one socket: the socket and the links this call moved into its group, which are the links that have not yet heard the browse
// question.
interface RefreshedSocket {

  readonly entry: FamilySocket;
  readonly links: readonly string[];
}

/**
 * The members {@link MdnsBrowser} calls on a datagram socket, which `node:dgram`'s own `Socket` satisfies structurally.
 *
 * The interface is narrow rather than the platform class because the double in the browser's own suite implements exactly these members, while the compiler
 * proves that the real socket carries every one of them at {@link mdnsSocketFactory}. Each `on` declaration is met by the platform emitter's catch-all
 * signature, so the event names and their payloads are Node's documented contract rather than something the compiler checks; the opt-in differential suite
 * against a real responder is what proves them live.
 *
 * @category mDNS
 */
export interface MdnsSocket {

  addMembership(group: string, address?: string): void;
  bind(port: number, callback?: () => void): void;
  close(callback?: () => void): void;
  dropMembership(group: string, address?: string): void;
  on(event: "close" | "listening", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "message", listener: (datagram: Buffer, rinfo: RemoteInfo) => void): this;
  send(datagram: Buffer, port: number, address: string, callback?: (error: Nullable<Error>) => void): void;
  setMulticastInterface(address: string): void;
  setMulticastLoopback(flag: boolean): void;
  setMulticastTTL(ttl: number): void;
}

/**
 * How {@link MdnsBrowser} obtains a socket. It is asked once per family the browser serves, with that family. The production factory is
 * {@link mdnsSocketFactory}; a suite substitutes one that answers a double.
 *
 * @param ipFamily - The address family this socket serves.
 *
 * @returns An unbound socket.
 *
 * @category mDNS
 */
export type MdnsSocketFactory = (ipFamily: IpFamily) => MdnsSocket;

/**
 * The production {@link MdnsSocketFactory}: one reuse-bound datagram socket. Address reuse is what lets this socket share port 5353 with the operating system's
 * own responder, each receiving every datagram the group delivers.
 *
 * @category mDNS
 */
export const mdnsSocketFactory: MdnsSocketFactory = (ipFamily) => createDgramSocket(ipFamily, { reuseAddr: true });

/**
 * How {@link MdnsBrowser} learns which links exist. Defaults to `networkInterfaces` from `node:os`; a suite substitutes a fixture that answers whatever set the
 * row is about.
 *
 * @returns The host's interfaces, keyed by interface name, exactly as `node:os` reports them.
 *
 * @category mDNS
 */
export type MdnsInterfaceSource = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

/**
 * One service instance, as the cache currently resolves it. Every field is what the most recent records said.
 *
 * @property addresses - Every address of the host, of every family the browser serves, in arrival order and without duplicates, as a consumer connects to it: an
 *                       IPv6 link-local address carries the zone of the link it was heard on.
 * @property host      - The host name the SRV record targets.
 * @property instance  - The first label of `name`: the free-text instance label RFC 6763 section 4.1.1 defines, which is what a person recognizes the device by.
 * @property name      - The full instance name, which is this service's identity and the key it is held under.
 * @property port      - The port the SRV record names.
 * @property txt       - The most recently received TXT record, whose strings are copies rather than views over a datagram.
 *
 * @category mDNS
 */
export interface MdnsService {

  readonly addresses: readonly string[];
  readonly host: DnsName;
  readonly instance: string;
  readonly name: DnsName;
  readonly port: number;
  readonly txt: DnsTxtRecord;
}

/**
 * One transition {@link MdnsBrowser} derived, handed to `onEvent` as it derived it. A `lost` event carries the last service the instance resolved to, so a
 * consumer has the thing it is losing rather than only its name.
 *
 * @category mDNS
 */
export type MdnsBrowserEvent = { readonly kind: "found"; readonly service: MdnsService } |
  { readonly kind: "updated"; readonly previous: MdnsService; readonly service: MdnsService } |
  { readonly kind: "lost"; readonly service: MdnsService };

/**
 * What {@link MdnsBrowser} is constructed with.
 *
 * @category mDNS
 */
export interface MdnsBrowserOptions {

  /**
   * The longest interval between browsing queries, in milliseconds, and the ceiling a resolution's ladder climbs to. Must be finite and at least one second.
   * Defaults to {@link MDNS_QUERY_CEILING_MS}.
   */
  readonly ceilingMs?: number;

  /**
   * The time source every deadline is armed on. Defaults to `systemClock`.
   */
  readonly clock?: Clock;

  /**
   * Where the host's links are read from. Defaults to `networkInterfaces` from `node:os`.
   */
  readonly interfaces?: MdnsInterfaceSource;

  /**
   * The address families to browse. The browser holds one socket per family named: each joins its own family's group on every link of that family, caches its
   * own family's address records alone, and asks its own family's address question in a resolution, so one host's addresses of both families meet in one
   * service. A family whose socket fails is dropped with a warning and the browser serves what remains, ending only when no family remains. The list is the
   * order the sockets are created in and nothing else reads it, and each family may be named only once. Defaults to {@link MDNS_DEFAULT_FAMILIES}.
   */
  readonly ipFamilies?: readonly [IpFamily, ...IpFamily[]];

  /**
   * Where the browser's own lifecycle lines go.
   */
  readonly log: HomebridgePluginLogging;

  /**
   * Where each derived transition goes, synchronously, as the browser derives it.
   */
  readonly onEvent: (event: MdnsBrowserEvent) => void;

  /**
   * The source of the spreads RFC 6762 asks for: the delay before a first query and the jitter on each maintenance checkpoint. Defaults to `Math.random`; a
   * suite supplies a fixed reading so a cadence is exact.
   */
  readonly random?: () => number;

  /**
   * The service type to browse, spelled as a full DNS-SD type name - `"_esphomelib._tcp.local"`, or a subtype form such as `"_printer._sub._http._tcp.local"`.
   */
  readonly serviceType: string;

  /**
   * The caller's lifetime. Aborting it tears the browser down.
   */
  readonly signal: AbortSignal;

  /**
   * How each socket is obtained. The factory is asked once per served family, with that family. Defaults to {@link mdnsSocketFactory}.
   */
  readonly socketFactory?: MdnsSocketFactory;

  /**
   * How long after the first query {@link MdnsBrowser.settled} resolves, in milliseconds. Must be positive and finite. Defaults to {@link MDNS_WARMUP_MS}.
   */
  readonly warmupMs?: number;
}

/**
 * What a browser offers the discovery surface, and what the shipped `TestMdnsBrowser` implements in its place.
 *
 * @category mDNS
 */
export interface MdnsBrowserLike extends AsyncDisposable {

  abort(reason?: unknown): void;
  readonly ready: Promise<void>;
  readonly services: ReadonlyMap<string, MdnsService>;
  readonly settled: Promise<void>;
  readonly signal: AbortSignal;
}

/**
 * How the discovery surface obtains its browser. The production factory is {@link mdnsBrowserFactory}, whose `create` is exactly the constructor call, so
 * routing construction through it changes no behavior; a consumer's test substitutes the shipped double at this one boundary.
 *
 * @category mDNS
 */
export interface MdnsBrowserFactory {

  /**
   * Construct a browser for the supplied options.
   *
   * @param options - The browser's inputs. See {@link MdnsBrowserOptions}.
   *
   * @returns A live browser.
   */
  create(options: MdnsBrowserOptions): MdnsBrowserLike;
}

/**
 * The production {@link MdnsBrowserFactory}: one call to the {@link MdnsBrowser} constructor.
 *
 * @category mDNS
 */
export const mdnsBrowserFactory: MdnsBrowserFactory = { create: (options) => new MdnsBrowser(options) };

/* One scheduled action. An arm that names a subject spells its key by the keyspace the key belongs to - a cache record's key, an instance's key - so the
 * field's name says which map it opens, since every key here is a string and the compiler can prove only the arm. A generation sits on those arms alone: the
 * browse, refresh, and settled entries have no subject that can go stale under them.
 */
type TimelineTask = { readonly kind: "browse" } | { readonly generation: number; readonly kind: "maintain"; readonly recordKey: string } |
  { readonly kind: "refresh" } | { readonly generation: number; readonly instanceKey: string; readonly kind: "resolve" } | { readonly kind: "settled" };

// One deadline and what comes due at it.
interface TimelineEntry {

  readonly at: number;
  readonly task: TimelineTask;
}

// One cached record and the maintenance state that belongs to it: when it arrived, how long it lives, which checkpoint comes next, and the generation its
// current heap entry carries.
interface CacheEntry {

  checkpoint: number;
  expiresAt: number;
  generation: number;
  receivedAt: number;
  record: DnsRecord;
  ttlMs: number;
}

// One instance being resolved: which attempt of the ladder comes next, and the generation every entry of this resolution carries. The generation never changes,
// so an entry left behind by a resolution that ended is told apart by the state being gone or carrying a later one.
interface ResolveState {

  attempt: number;
  readonly generation: number;
}

/* The deadlines, as a binary min-heap. Pushes and pops are what the browser does constantly and a scan of the whole heap is what it never does, which is the
 * shape a heap answers and a sorted array does not. Both walks read a missing slot as the entry being placed, which is the totality the compiler asks for on an
 * indexed read and never a case the heap reaches: a parent below the length is always present, and the walk down tests each child for presence itself.
 */
class Timeline {

  readonly #entries: TimelineEntry[] = [];

  // Place an entry, walking it up toward the root by moving each later parent down into the hole rather than swapping pairs, so one write per level places it.
  public push(entry: TimelineEntry): void {

    const entries = this.#entries;
    let index = entries.length;

    while(index > 0) {

      const parent = (index - 1) >> 1;
      const above = entries[parent] ?? entry;

      if(above.at <= entry.at) {

        break;
      }

      entries[index] = above;
      index = parent;
    }

    entries[index] = entry;
  }

  // The earliest deadline, without removing it.
  public peek(): TimelineEntry | undefined {

    return this.#entries[0];
  }

  // Remove and answer the earliest deadline, walking the entry that was last down into the hole the root left.
  public pop(): TimelineEntry | undefined {

    const entries = this.#entries;
    const root = entries[0];
    const last = entries.pop();

    if((last === undefined) || (entries.length === 0)) {

      return root;
    }

    let index = 0;

    for(;;) {

      const left = (index * 2) + 1;
      const right = left + 1;
      const leftEntry = entries[left];
      const rightEntry = entries[right];
      const child = (leftEntry === undefined) ? undefined : (((rightEntry !== undefined) && (rightEntry.at < leftEntry.at)) ? rightEntry : leftEntry);

      if((child === undefined) || (child.at >= last.at)) {

        break;
      }

      entries[index] = child;
      index = (child === leftEntry) ? left : right;
    }

    entries[index] = last;

    return root;
  }

  // Drop every deadline, which is what a teardown does before it stops arming anything.
  public clear(): void {

    this.#entries.length = 0;
  }
}

/* What tells one cached record from another under the same name and type: the rdata, spelled as text. A responder that changes a port or an address announces a
 * record the cache has not seen, which is what makes the new one an addition and leaves the old one to expire or to be flushed.
 */
function rdataKey(record: DnsRecord): string {

  switch(record.kind) {

    case "a":
    case "aaaa": {

      return record.address;
    }

    case "other": {

      return record.type.toString() + ":" + record.rdata.toString("hex");
    }

    case "ptr": {

      return dnsNameKey(record.target);
    }

    case "srv": {

      return dnsNameKey(record.target) + ":" + record.port.toString() + ":" + record.priority.toString() + ":" + record.weight.toString();
    }

    case "txt": {

      return record.strings.map((value) => value.toString("hex")).join(",");
    }
  }
}

// The cache key of a record: its name, its wire type, and its rdata, which together are what RFC 6762 treats as one record.
function recordKey(record: DnsRecord): string {

  return dnsNameKey(record.name) + "|" + dnsRecordType(record).toString() + "|" + rdataKey(record);
}

// A TXT record's strings are views over the datagram the parser read, so what the cache keeps is a copy and the datagram is free to be reused underneath it.
function copyRecord(record: DnsRecord): DnsRecord {

  return (record.kind === "txt") ? { ...record, strings: record.strings.map((value) => Buffer.from(value)) } : record;
}

// Whether an IPv6 address in the text form the parser writes is link-local: its first group falls in fe80::/10, which reads fe80 through febf.
function isLinkLocal(address: string): boolean {

  const group = Number.parseInt(address.slice(0, address.indexOf(":")), 16);

  return (group & IPV6_LINK_LOCAL_PREFIX_MASK) === IPV6_LINK_LOCAL_PREFIX;
}

// The zone a datagram's source carries, which the platform writes after a percent sign for a link-local source, and null for a source without one.
function zoneOf(source: string): Nullable<string> {

  const at = source.indexOf("%");

  return (at === -1) ? null : source.slice(at + 1);
}

/* The address record as the cache keeps it. A link-local IPv6 address means nothing without the link it was heard on, and a consumer cannot connect to one
 * without its zone, so the address is stamped with the zone of the datagram that delivered it, here, where the datagram is in hand. A global or unique-local
 * address is routable as the wire spelled it and stays bare, and so does an IPv4 address. Stamping at the cache rather than at derivation is what makes the
 * cache key tell one link's copy of an address from another's, and what keeps a zone from travelling beside an address anywhere downstream.
 */
function zonedRecord(record: DnsRecord, rinfo: RemoteInfo): DnsRecord {

  if((record.kind !== "aaaa") || !isLinkLocal(record.address)) {

    return record;
  }

  const zone = zoneOf(rinfo.address);

  return (zone === null) ? record : { ...record, address: record.address + "%" + zone };
}

// Whether two derivations of one instance say the same thing. The instance label is part of the name and cannot differ, so what is left is the endpoint, the
// addresses in the order they arrived, and the TXT record's strings.
function sameService(previous: MdnsService, current: MdnsService): boolean {

  return (previous.port === current.port) && dnsNamesEqual(previous.host, current.host) &&
    sameEntries(previous.addresses, current.addresses, (x, y) => x === y) &&
    sameEntries(previous.txt.strings, current.txt.strings, (x, y) => x.equals(y));
}

/**
 * The RFC 6762 querier for one service type: a socket, a cadence, a cache, and the transitions it derives from them.
 *
 * @example
 *
 * ```ts
 * import { MdnsBrowser } from "homebridge-plugin-utils";
 *
 * await using browser = new MdnsBrowser({
 *
 *   log: this.log,
 *   onEvent: (event) => this.log.info("%s: %s.", event.kind, event.service.instance),
 *   serviceType: "_esphomelib._tcp.local",
 *   signal: this.signal
 * });
 *
 * await browser.settled;
 * ```
 *
 * @category mDNS
 */
export class MdnsBrowser implements MdnsBrowserLike {

  /**
   * Resolves once the first socket of any served family is bound and listening, whichever family that is, and rejects with the lifetime's reason when the
   * lifetime ends before that. Marked handled, so a consumer that never awaits it is not reported as an unhandled rejection.
   */
  public readonly ready: Promise<void>;

  /**
   * Every service the cache currently resolves, keyed by the folded instance name. It is the same store the events are derived from, so what a consumer reads
   * here and what it was told cannot disagree.
   */
  public readonly services: ReadonlyMap<string, MdnsService>;

  /**
   * Resolves `warmupMs` after the first query is sent, whether or not any interface carried it, and rejects with the lifetime's reason when the lifetime ends
   * first. The deadline is defined by time rather than by what answered, which is what a one-shot consumer needs: it waits a stated window and then reads
   * {@link MdnsBrowser.services}. A network where nothing could be asked says so through the warning the interface refresh writes. Marked handled.
   */
  public readonly settled: Promise<void>;

  /**
   * The abort signal representing this browser's lifetime, composed from the caller's and this browser's own. Its reason names why: `"failed"` carrying the
   * socket error as its cause, and `"shutdown"` for a caller's own teardown.
   */
  public readonly signal: AbortSignal;

  // The deadline the one armed timer is set for, and `null` when nothing is armed. Comparing against it is what keeps an unchanged nearest deadline from
  // re-arming a timer that is already correct.
  #armedAt: Nullable<number> = null;

  // Every record the responses carried that this browser has interest in, keyed by name, type, and rdata.
  readonly #cache = new Map<string, CacheEntry>();

  // How many browsing queries have gone out, which is the attempt the doubling series is consulted with.
  #cycle = 0;

  // Resolves once every socket this browser created has emitted its close event, which is what disposal awaits. A socket dropped after a fault still resolves
  // its own, because the drop closes it.
  readonly #closed: Promise<void>;

  readonly #clock: Clock;

  readonly #controller = new AbortController();

  // Where the host's links are read from, consulted afresh at every scheduled query.
  readonly #interfaceSource: MdnsInterfaceSource;

  // The doubling series, shared by the browse cadence and by every resolution.
  readonly #ladder: (attempt: number) => number;

  readonly #log: HomebridgePluginLogging;

  // Whether the warning about having no interface has been written for the current episode.
  #noInterfaceWarned = false;

  readonly #onEvent: (event: MdnsBrowserEvent) => void;

  // The browsing question, built once because it never varies.
  readonly #question: DnsQuestion;

  readonly #random: () => number;

  readonly #readyResolvers: PromiseWithResolvers<void>;

  // The instances with a PTR but no complete service yet, each with the ladder it is being asked for on.
  readonly #resolutions = new Map<string, ResolveState>();

  // The one counter every generation is drawn from, so a generation means the same thing wherever it is compared.
  #sequence = 0;

  readonly #serviceName: DnsName;

  readonly #services = new Map<string, MdnsService>();

  readonly #settledResolvers: PromiseWithResolvers<void>;

  /* The sockets still serving this browser, in creation order. A socket that fails is spliced out of this list and a teardown takes the whole of it, so
   * membership here is the one thing every socket handler reads to know whether its socket still serves.
   */
  readonly #sockets: FamilySocket[] = [];

  // Whether the browse series has been started, which the first socket to listen does and nothing clears: a browser starts once, and a torn-down browser's
  // sockets deliver nothing the serving guard admits.
  #started = false;

  // When the first query went out, which is what the warmup deadline counts from, and `null` until it has.
  #firstQueryAt: Nullable<number> = null;

  readonly #timeline = new Timeline();

  // The one armed timer, and `undefined` when nothing is armed.
  #timer: Disposable | undefined;

  readonly #warmupMs: number;

  /**
   * Construct a browser and bind it. Binding begins immediately; a caller that needs to know when the socket came up awaits {@link MdnsBrowser.ready}, and one
   * that wants to give the network a moment to answer awaits {@link MdnsBrowser.settled}.
   *
   * @param options - The browser's inputs. See {@link MdnsBrowserOptions}.
   *
   * @throws {TypeError} If `serviceType` does not read as a DNS-SD service type, if `ceilingMs` is not finite or is under a second, if `warmupMs` is not a
   * positive finite number, or if `ipFamilies` names a family more than once. Each refusal names the option, so a misconfiguration is diagnosable where it was
   * made.
   *
   * @throws The encoder's own `Error`, naming the value, when `serviceType` spells a name the wire cannot carry.
   */
  public constructor(options: MdnsBrowserOptions) {

    const { ceilingMs = MDNS_QUERY_CEILING_MS, clock = systemClock, interfaces = networkInterfaces, ipFamilies = MDNS_DEFAULT_FAMILIES, log, onEvent,
      random = Math.random, serviceType, signal, socketFactory = mdnsSocketFactory, warmupMs = MDNS_WARMUP_MS } = options;
    const serviceName = parseDnsName(serviceType);

    /* A service type is a name, a transport, and a domain at the very least, and `parseDnsName` is total rather than throwing, so the judgement of what it read
     * is the browser's to make. Anything shorter would browse for something no responder can answer.
     */
    if(serviceName.length < 3) {

      throw new TypeError("MdnsBrowser: `serviceType` must be a DNS-SD service type such as \"_esphomelib._tcp.local\", and \"" + serviceType + "\" is not.");
    }

    if(!Number.isFinite(ceilingMs) || (ceilingMs < MDNS_QUERY_SEED_MS)) {

      throw new TypeError("MdnsBrowser: `ceilingMs` must be a finite number of milliseconds, and at least " + MDNS_QUERY_SEED_MS.toString() + ".");
    }

    if(!Number.isFinite(warmupMs) || (warmupMs <= 0)) {

      throw new TypeError("MdnsBrowser: `warmupMs` must be a positive, finite number of milliseconds.");
    }

    // The tuple type refuses an empty list at compile time; a repetition is the one shape it cannot refuse, and a second socket of a family would join the same
    // group on the same links and cache the same records twice.
    if(new Set(ipFamilies).size !== ipFamilies.length) {

      throw new TypeError("MdnsBrowser: `ipFamilies` must name each address family once.");
    }

    const question: DnsQuestion = { name: serviceName, type: DNS_TYPE_PTR, unicastResponse: false };

    // Encoding the question once and discarding the packets is what refuses a type the wire cannot carry - a label over 63 bytes, a name over 255 - here, where
    // the option was named, instead of inside the first timer callback where the encoder's Error would have nowhere to go.
    buildMdnsQuery({ questions: [question] });

    this.#clock = clock;
    this.#interfaceSource = interfaces;
    this.#ladder = exponentialBackoff({ ceilingMs, seedMs: MDNS_QUERY_SEED_MS });
    this.#log = log;
    this.#onEvent = onEvent;
    this.#question = question;
    this.#random = random;
    this.#serviceName = serviceName;
    this.#warmupMs = warmupMs;
    this.services = this.#services;

    this.signal = composeSignals(signal, this.#controller.signal);

    this.#readyResolvers = Promise.withResolvers();
    this.#settledResolvers = Promise.withResolvers();
    this.ready = markHandled(this.#readyResolvers.promise);
    this.settled = markHandled(this.#settledResolvers.promise);

    // One socket per family named, in the order they were named. Each handler but the close resolver opens with the serving guard, because a socket that has
    // left this browser is inert whatever its emitter still delivers; its close is the one event it still owes, since the disposal below waits on it.
    for(const family of ipFamilies) {

      const entry: FamilySocket = { closed: Promise.withResolvers(), family: MDNS_FAMILY[family], interfaces: new Map(), listening: false,
        socket: socketFactory(family) };

      this.#sockets.push(entry);
      entry.socket.on("error", (error: Error) => this.#drop(entry, error));
      entry.socket.on("listening", () => this.#listening(entry));
      entry.socket.on("message", (datagram: Buffer, rinfo: RemoteInfo) => this.#receive(entry, datagram, rinfo));
      entry.socket.on("close", () => entry.closed.resolve());
    }

    // Composed over every socket created rather than over the ones still serving, because a dropped socket is closed by the drop and settles its own promise.
    // An `all` over an empty list resolves at once, which is why this waits for the creation loop above.
    this.#closed = Promise.all(this.#sockets.map((entry) => entry.closed.promise)).then(() => undefined);

    // The single teardown convergence point, whichever path ends the lifetime. `onAbort` runs it inline for a lifetime that had already ended, which is why it
    // is registered before the binds below rather than after them.
    onAbort(this.signal, () => this.#teardown());

    // An already-ended lifetime tore down sockets that never listened. There is nothing to bind.
    if(this.signal.aborted) {

      return;
    }

    /* The walk is over a snapshot of the list. A socket from `createDgramSocket` answers an address-literal destination with no resolver round trip, so its
     * bind completes inside `bind()` itself and its `listening` or `error` fires before the call returns; a refused bind therefore runs the drop below, which
     * splices the very list this walks. Nothing the listening handler runs can end the browser, so a refused bind is the one mutation the walk has to survive.
     */
    for(const entry of [...this.#sockets]) {

      entry.socket.bind(MDNS_PORT);
    }
  }

  /**
   * Abort the browser and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once: later calls are no-ops, because the underlying signal aborts once.
   *
   * @param reason - Optional abort reason. See {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation. Aborts the browser, defaulting to `"shutdown"`, and awaits the socket's own close, so the port is released by the time
   * the surrounding `await using` scope's next statement runs.
   *
   * @returns A promise that resolves once the socket has closed.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();

    await this.#closed;
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  // Whether a socket still serves this browser. One that has left - dropped after a fault, or taken by the teardown - is inert, whatever its platform emitter
  // still delivers and whatever a double can deliver, so every socket handler but the close resolver opens with this.
  #serving(entry: FamilySocket): boolean {

    return this.#sockets.includes(entry);
  }

  /* The fault rule, which is one rule at both moments a socket can be lost: a bind the kernel refuses on a host without this family and a socket that dies long
   * after it listened are the same loss to the browser. The socket is dropped, the browser serves what remains, and only the last one taken ends it. The guard
   * is what makes a second error from one socket, and an error arriving during a teardown, a no-op rather than a splice that removes whichever socket sits at
   * the index a miss would answer. A dropped family's cached records are left to expire at their ttl rather than flushed, because the browser can neither
   * confirm nor deny them without a socket of that family, and their maintenance questions go out on a surviving socket whose purity drops the answer.
   */
  #drop(entry: FamilySocket, error: Error): void {

    if(!this.#serving(entry)) {

      return;
    }

    this.#sockets.splice(this.#sockets.indexOf(entry), 1);

    /* The memberships go with the entry, and the close is what resolves this socket's own promise, so the disposal waiting on every one of them can settle. A
     * socket that never bound still closes, and the close cannot refuse: a datagram socket refuses one only after it has already closed, and the guard above
     * admits a socket that is still serving. Nothing reads the interface source here either - the warning below reports the loss at once, and the no-link
     * episode is re-read at the next refresh.
     */
    entry.socket.close();

    if(this.#sockets.length > 0) {

      this.#log.warn("The mDNS browser for %s lost its %s socket and continues over %s: %s.", formatDnsName(this.#serviceName), entry.family.family,
        this.#sockets.map((remaining) => remaining.family.family).join(" and "), formatErrorMessage(error));

      return;
    }

    this.#log.error("The mDNS browser for %s stopped after a socket error and discovery for it has ended: %s.", formatDnsName(this.#serviceName),
      formatErrorMessage(error));
    this.abort(new HbpuAbortError("failed", { cause: error }));
  }

  /* One socket is bound. Set the multicast options the stage this browser was designed against proved, join what that socket's family has, and - on the first
   * socket to come up, whichever family it serves - start the two series that run for the browser's life. Nothing is sent from there: the first browse follows
   * within 120 ms and asks on every link the refresh joined. A socket that comes up after the browse series has begun is a set of links appearing between
   * queries, so it hears the browsing question at once; one that comes up after the start but before the first browse fires needs nothing, because that pending
   * browse asks on every listening socket.
   */
  #listening(entry: FamilySocket): void {

    if(!this.#serving(entry)) {

      return;
    }

    const now = this.#clock.now();

    entry.listening = true;
    entry.socket.setMulticastTTL(MDNS_MULTICAST_TTL);
    entry.socket.setMulticastLoopback(true);

    const refreshed = this.#refreshInterfaces();

    if(this.#started) {

      if(this.#firstQueryAt !== null) {

        this.#browseNew(refreshed);
      }

      return;
    }

    this.#started = true;
    this.#timeline.push({ at: now + MDNS_INTERFACE_POLL_MS, task: { kind: "refresh" } });
    this.#readyResolvers.resolve();
    this.#timeline.push({ at: now + this.#firstQueryDelay(), task: { kind: "browse" } });
    this.#arm();
  }

  // Arm the one timer at the timeline's nearest deadline, rounding a fractional deadline up so a wait is never served early. A nearest deadline that has not
  // moved keeps the handle it already has, and a timeline with nothing left - which is what a teardown leaves - arms nothing.
  #arm(): void {

    const next = this.#timeline.peek();

    if((next === undefined) || (next.at === this.#armedAt)) {

      return;
    }

    this.#timer?.[Symbol.dispose]();
    this.#armedAt = next.at;
    this.#timer = this.#clock.schedule(() => this.#fire(), Math.max(0, Math.ceil(next.at - this.#clock.now())));
  }

  /* Run everything that has come due, then reconcile once over every instance those entries touched and re-arm. Reconciling once per fire rather than once per
   * entry is what makes the expiry of records that share a deadline - the several addresses one flush holds, say - one transition rather than several.
   */
  #fire(): void {

    // The one-shot that brought us here is spent, so the arm below always replaces it rather than trusting a deadline that matches.
    this.#timer = undefined;
    this.#armedAt = null;

    const now = this.#clock.now();
    const touched = new Set<string>();

    for(let next = this.#timeline.peek(); (next !== undefined) && (next.at <= now); next = this.#timeline.peek()) {

      this.#timeline.pop();
      this.#run(next.task, now, touched);
    }

    this.#reconcile(touched);
    this.#arm();
  }

  // One due entry. A subject that has been rescheduled or has gone leaves its earlier entry behind, and the generation is what tells that entry apart without
  // the heap ever having to remove one.
  #run(task: TimelineTask, now: number, touched: Set<string>): void {

    switch(task.kind) {

      case "browse": {

        this.#browse(now);

        return;
      }

      case "maintain": {

        const entry = this.#cache.get(task.recordKey);

        if(entry?.generation === task.generation) {

          this.#maintain(task.recordKey, entry, touched);
        }

        return;
      }

      case "refresh": {

        this.#browseNew(this.#refreshInterfaces());
        this.#timeline.push({ at: now + MDNS_INTERFACE_POLL_MS, task: { kind: "refresh" } });

        return;
      }

      case "resolve": {

        const state = this.#resolutions.get(task.instanceKey);

        if(state?.generation === task.generation) {

          this.#resolve(task.instanceKey, state, now);
        }

        return;
      }

      case "settled": {

        this.#settledResolvers.resolve();

        return;
      }
    }
  }

  // One browsing query: the links are re-read first, so a browse that joins a link also asks on it, and the next query is laddered from here.
  #browse(now: number): void {

    this.#refreshInterfaces();
    this.#sendAll(this.#browsePackets(now));

    // The warmup window is measured from the first query, whether or not a link carried it.
    if(this.#firstQueryAt === null) {

      this.#firstQueryAt = now;
      this.#timeline.push({ at: now + this.#warmupMs, task: { kind: "settled" } });
    }

    this.#cycle++;
    this.#timeline.push({ at: now + this.#ladder(this.#cycle + 1), task: { kind: "browse" } });
  }

  /* The browsing query's packets: the question, and as known answers the PTR records this browser already holds for the name it is browsing. RFC 6762 section
   * 7.1 leaves out an answer whose remaining lifetime has fallen below half its original, so a responder refreshes it rather than staying silent about it.
   */
  #browsePackets(now: number): Buffer[] {

    const knownAnswers: DnsRecord[] = [];

    for(const entry of this.#cache.values()) {

      if((entry.record.kind === "ptr") && ((entry.expiresAt - now) >= (entry.ttlMs / 2))) {

        knownAnswers.push(entry.record);
      }
    }

    return buildMdnsQuery({ knownAnswers, questions: [this.#question] });
  }

  // A maintenance or resolution query. The links are re-read first and whichever fire joins one asks the browse question on it, so a link that appears between
  // browses hears what it needs to answer rather than waiting for the cadence to come around.
  #send(packets: readonly Buffer[]): void {

    this.#browseNew(this.#refreshInterfaces());
    this.#sendAll(packets);
  }

  // Send every packet out over every listening socket, each on the links its own group is joined on. A query reaches every family the browser serves, which is
  // what lets one family's socket harvest the other family's address record a dual-stack responder attaches for fate sharing.
  #sendAll(packets: readonly Buffer[]): void {

    for(const entry of this.#sockets) {

      if(entry.listening) {

        this.#sendOn(entry, packets, this.#joined(entry));
      }
    }
  }

  // Ask the browse question on links that have just joined, which is the one place it is asked outside the browse fire itself.
  #browseNew(refreshed: readonly RefreshedSocket[]): void {

    if(refreshed.length === 0) {

      return;
    }

    const packets = this.#browsePackets(this.#clock.now());

    for(const { entry, links } of refreshed) {

      this.#sendOn(entry, packets, links);
    }
  }

  /* Send every packet on every named link of one socket, setting that socket's multicast interface immediately before each link's packets. Neither call may
   * throw out of a timer callback: the operating system refuses an address it has dropped since the refresh, and a socket closed by a teardown refuses
   * everything, so a failure costs this link this datagram and the next refresh decides what to do about the address.
   */
  #sendOn(entry: FamilySocket, packets: readonly Buffer[], links: readonly string[]): void {

    for(const link of links) {

      try {

        entry.socket.setMulticastInterface(link);

        for(const packet of packets) {

          entry.socket.send(packet, MDNS_PORT, entry.family.group, (error) => {

            if((error === null) || this.aborted) {

              return;
            }

            this.#log.debug("mDNS send on %s failed: %s", link, formatErrorMessage(error));
          });
        }
      } catch(error: unknown) {

        if(this.aborted) {

          continue;
        }

        this.#log.debug("mDNS send on %s failed: %s", link, formatErrorMessage(error));
      }
    }
  }

  // Every link the group is currently joined on through one socket.
  #joined(entry: FamilySocket): string[] {

    const links: string[] = [];

    for(const [ link, state ] of entry.interfaces) {

      if(state === "joined") {

        links.push(link);
      }
    }

    return links;
  }

  /* Re-read the host's links once and reconcile every listening socket's memberships against them, each socket over the links its own family answers for. A
   * socket that has not come up is skipped: a membership added before the bind would bind that socket to an ephemeral port.
   *
   * @returns Each listening socket that joined something and the links it joined, which are the ones that have not yet heard the browse question.
   */
  #refreshInterfaces(): RefreshedSocket[] {

    const interfaces = this.#interfaceSource();
    const refreshed: RefreshedSocket[] = [];

    for(const entry of this.#sockets) {

      if(!entry.listening) {

        continue;
      }

      const links = this.#refreshSocket(entry, interfaces);

      if(links.length > 0) {

        refreshed.push({ entry, links });
      }
    }

    /* The episode memory is this one flag over the whole browser, written here and nowhere else: a refresh that leaves some group joined somewhere clears it,
     * and the first refresh that leaves every group joined nowhere writes the warning. The read waits until every serving socket is listening, because a socket
     * still coming up is a socket whose links are unknown rather than a socket with no link; under a bind that completes inside the call, every socket is up or
     * dropped by the time the constructor returns.
     */
    if(!this.#sockets.every((entry) => entry.listening)) {

      return refreshed;
    }

    if(this.#sockets.some((entry) => this.#joined(entry).length > 0)) {

      this.#noInterfaceWarned = false;
    } else if(!this.#noInterfaceWarned) {

      this.#log.warn("No network interface joined the mDNS group, so discovery for %s can hear only what reaches its sockets unsolicited.",
        formatDnsName(this.#serviceName));

      this.#noInterfaceWarned = true;
    }

    return refreshed;
  }

  /* One socket's memberships, reconciled against the links its own family answers for: join what is new or still refused, drop what has gone, and forget a
   * vanished link entirely so its return warns afresh. A refusal is warned once per episode and retried at every query, because the usual causes - a link that
   * is up but not yet configured, a transient routing state - clear on their own and a line per query would be noise.
   *
   * @returns The links this call moved into the group through this socket.
   */
  #refreshSocket(entry: FamilySocket, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {

    const present: string[] = [];

    for(const [ name, infos ] of Object.entries(interfaces)) {

      // `NodeJS.Dict` types every value optional, and the profile answers which of the entries are links of this socket's family and how each one of them is
      // named to the socket.
      for(const info of infos ?? []) {

        const link = entry.family.link(info, name);

        if((link === null) || present.includes(link)) {

          continue;
        }

        present.push(link);
      }
    }

    const { toRemove } = membershipDelta(present, [...entry.interfaces.keys()]);
    const joined: string[] = [];

    for(const link of toRemove) {

      if(entry.interfaces.get(link) === "joined") {

        try {

          entry.socket.dropMembership(entry.family.group, link);
        } catch(error: unknown) {

          this.#log.debug("mDNS membership drop on %s failed: %s", link, formatErrorMessage(error));
        }
      }

      entry.interfaces.delete(link);
    }

    for(const link of present) {

      const state = entry.interfaces.get(link);

      if(state === "joined") {

        continue;
      }

      try {

        entry.socket.addMembership(entry.family.group, link);
        entry.interfaces.set(link, "joined");
        joined.push(link);
      } catch(error: unknown) {

        if(state !== "refused") {

          this.#log.warn("Could not join the mDNS group on %s (%s): %s.", link, formatDnsName(this.#serviceName), formatErrorMessage(error));
        }

        entry.interfaces.set(link, "refused");
      }
    }

    return joined;
  }

  // The delay before the first query of a series, which RFC 6762 section 5.2 spreads over 20 to 120 ms. The browse series and every resolution share it.
  #firstQueryDelay(): number {

    return MDNS_FIRST_QUERY_MIN_MS + (this.#random() * MDNS_FIRST_QUERY_SPREAD_MS);
  }

  /* One received datagram. A query changes nothing here: this socket hears its own questions looped back, and RFC 6762 section 7.1 forbids caching what another
   * host listed as its known answers. A response is read whatever its id says and whatever its TC bit says, as RFC 6762 sections 18.1 and 18.5 require.
   */
  #receive(entry: FamilySocket, datagram: Buffer, rinfo: RemoteInfo): void {

    // A datagram delivered after the lifetime has ended would otherwise populate a cache nothing will maintain and arm a timer nothing will fire, and one from
    // a socket that has left the browser is an address family this browser does not serve.
    if(this.aborted || !this.#serving(entry)) {

      return;
    }

    const message = parseDnsMessage(datagram);

    if(message === null) {

      this.#log.debug("Dropped an unreadable mDNS datagram from %s.", rinfo.address);

      return;
    }

    if(!message.response) {

      return;
    }

    const now = this.#clock.now();
    const touched = new Set<string>();
    const sections = [ message.answers, message.authorities, message.additionals ];

    /* Every section is read once per pass, so the order a responder chose for its records never matters: the PTR records name the instances, an SRV or a TXT
     * attaches to an instance something already points at, and an address record of this socket's own family attaches to a host an SRV already targets.
     * Anything else is dropped without a word, because the parse is the filter and a browser has nothing to say about a record it did not ask for.
     */
    for(const section of sections) {

      for(const record of section) {

        // A PTR whose target is the root points at no instance, so there is nothing to hold it under.
        if((record.kind === "ptr") && dnsNamesEqual(record.name, this.#serviceName) && (record.target.length > 0)) {

          this.#cacheRecord(record, now, touched);
        }
      }
    }

    const instances = this.#instanceKeys();

    for(const section of sections) {

      for(const record of section) {

        if(((record.kind === "srv") || (record.kind === "txt")) && instances.has(dnsNameKey(record.name))) {

          this.#cacheRecord(record, now, touched);
        }
      }
    }

    const hosts = this.#hostKeys();

    for(const section of sections) {

      for(const record of section) {

        /* Purity, at its one site: an address record of this socket's family attaches to a host an SRV already targets, and a record of the other family - which
         * RFC 6762 section 6.2 has a responder attach for fate sharing - is dropped here and cached from its own socket instead. That is what keeps the zone
         * rule intact, since a link-local AAAA is stamped from an IPv6 datagram's source and a datagram on the IPv4 socket carries no zone.
         */
        if((record.kind === entry.family.addressKind) && hosts.has(dnsNameKey(record.name))) {

          this.#cacheRecord(zonedRecord(record, rinfo), now, touched);
        }
      }
    }

    this.#reconcile(touched);
    this.#arm();
  }

  /* Cache one record, or hold it when its ttl is zero. A record arriving for the first time and one arriving again write the same fields and reschedule the
   * same way, which is what makes an announcement during a hold RFC 6762 section 10.1's rescue: the refreshed entry draws a new generation and the hold's own
   * heap entry goes stale.
   */
  #cacheRecord(record: DnsRecord, now: number, touched: Set<string>): void {

    for(const instance of this.#instancesOf(record)) {

      touched.add(instance);
    }

    const key = recordKey(record);
    const existing = this.#cache.get(key);

    // A goodbye for something this cache never held is nothing to hold.
    if(record.ttl === 0) {

      if(existing !== undefined) {

        this.#hold(key, existing, now);
      }

      return;
    }

    const ttlMs = record.ttl * 1000;
    const entry: CacheEntry = existing ?? { checkpoint: 0, expiresAt: 0, generation: 0, receivedAt: 0, record, ttlMs };

    entry.checkpoint = 0;
    entry.expiresAt = now + ttlMs;
    entry.receivedAt = now;
    entry.record = copyRecord(record);
    entry.ttlMs = ttlMs;

    this.#cache.set(key, entry);
    this.#reschedule(key, entry, this.#checkpointDeadline(entry, MDNS_MAINTENANCE_CHECKPOINTS[0]));

    if(!record.flush) {

      return;
    }

    /* RFC 6762 section 10.2: a record carrying the cache-flush bit replaces what this cache holds under the same name and type rather than adding to it, and
     * what it replaces is held for a second rather than deleted. The one-second grace is what keeps the several records of one announcement - which arrive in
     * separate packets and all carry the bit - from flushing each other.
     */
    const name = dnsNameKey(record.name);
    const type = dnsRecordType(record);

    for(const [ otherKey, other ] of this.#cache) {

      if((otherKey === key) || (dnsNameKey(other.record.name) !== name) || (dnsRecordType(other.record) !== type) ||
        ((now - other.receivedAt) <= MDNS_HOLD_MS)) {

        continue;
      }

      this.#hold(otherKey, other, now);
    }
  }

  // Hold a record for the second RFC 6762 sections 10.1 and 10.2 both give one before it is deleted, which is the state a checkpoint past the last one deletes.
  #hold(key: string, entry: CacheEntry, now: number): void {

    entry.checkpoint = MDNS_MAINTENANCE_CHECKPOINTS.length;
    entry.expiresAt = now + MDNS_HOLD_MS;
    this.#reschedule(key, entry, entry.expiresAt);
  }

  // The one place a cache entry's next deadline is set: the generation it draws here is the one its heap entry carries, so the two cannot drift apart.
  #reschedule(key: string, entry: CacheEntry, at: number): void {

    this.#sequence++;
    entry.generation = this.#sequence;
    this.#timeline.push({ at, task: { generation: entry.generation, kind: "maintain", recordKey: key } });
  }

  // Where a checkpoint falls, written once: the fraction of the record's lifetime RFC 6762 section 5.2 names, plus the spread it asks for.
  #checkpointDeadline(entry: CacheEntry, fraction: number): number {

    return entry.receivedAt + (entry.ttlMs * (fraction + (this.#random() * MDNS_MAINTENANCE_JITTER)));
  }

  /* A cached record has come due. RFC 6762 section 5.2 re-queries a record only while something still has interest in it, so a record whose instance no longer
   * points at it is deleted without a question; otherwise the next checkpoint asks for it again, and a fire past the last checkpoint is its expiry.
   */
  #maintain(key: string, entry: CacheEntry, touched: Set<string>): void {

    if(!this.#hasInterest(entry.record)) {

      this.#delete(key, entry, touched);

      return;
    }

    const fraction = MDNS_MAINTENANCE_CHECKPOINTS[entry.checkpoint];

    if(fraction === undefined) {

      this.#delete(key, entry, touched);

      return;
    }

    // The question asks for this one record and carries no known answer: RFC 6762 scopes known-answer suppression to a browsing series, and offering the record
    // being maintained as an answer to the question asking for it would suppress the very response it needs.
    this.#send(buildMdnsQuery({ questions: [{ name: entry.record.name, type: dnsRecordType(entry.record), unicastResponse: false }] }));

    entry.checkpoint++;

    const next = MDNS_MAINTENANCE_CHECKPOINTS[entry.checkpoint];

    this.#reschedule(key, entry, (next === undefined) ? entry.expiresAt : this.#checkpointDeadline(entry, next));
  }

  // Whether anything in the cache still points at a record: an SRV or a TXT needs an instance a PTR names, and an address needs a host an SRV targets. A PTR is
  // itself the interest, since nothing above it points at it.
  #hasInterest(record: DnsRecord): boolean {

    switch(record.kind) {

      case "a":
      case "aaaa": {

        return this.#hostKeys().has(dnsNameKey(record.name));
      }

      case "srv":
      case "txt": {

        return this.#instanceKeys().has(dnsNameKey(record.name));
      }

      default: {

        return true;
      }
    }
  }

  // Delete a cached record, naming the instances a consumer may now see differently.
  #delete(key: string, entry: CacheEntry, touched: Set<string>): void {

    for(const instance of this.#instancesOf(entry.record)) {

      touched.add(instance);
    }

    this.#cache.delete(key);
  }

  // The instances a record bears on, which is what a change to it can change: a PTR names one by its target, an SRV or a TXT by its owner, and an address by
  // every instance whose SRV targets its owner, since one host can serve several instances.
  #instancesOf(record: DnsRecord): string[] {

    switch(record.kind) {

      case "ptr": {

        return [dnsNameKey(record.target)];
      }

      case "srv":
      case "txt": {

        return [dnsNameKey(record.name)];
      }

      default: {

        const host = dnsNameKey(record.name);
        const instances: string[] = [];

        for(const entry of this.#cache.values()) {

          if((entry.record.kind === "srv") && (dnsNameKey(entry.record.target) === host)) {

            instances.push(dnsNameKey(entry.record.name));
          }
        }

        return instances;
      }
    }
  }

  // Every instance the cache names: the target of each cached PTR, all of which are for the browsed name because nothing else is cached.
  #instanceKeys(): Set<string> {

    const keys = new Set<string>();

    for(const entry of this.#cache.values()) {

      if(entry.record.kind === "ptr") {

        keys.add(dnsNameKey(entry.record.target));
      }
    }

    return keys;
  }

  // Every host the cache points at: the target of each cached SRV.
  #hostKeys(): Set<string> {

    const keys = new Set<string>();

    for(const entry of this.#cache.values()) {

      if(entry.record.kind === "srv") {

        keys.add(dnsNameKey(entry.record.target));
      }
    }

    return keys;
  }

  /* Derive each named instance afresh and report what changed, once per cause: one datagram's records are reconciled together however many of them changed, and
   * so is everything one timer fire ran, which is what makes a re-announcement that moves a port and adds an address a single update.
   */
  #reconcile(touched: ReadonlySet<string>): void {

    const instances = this.#instanceKeys();
    const now = this.#clock.now();

    for(const key of touched) {

      // A consumer that tears the discovery down from inside an event leaves the rest of this batch underived rather than pushing onto a timeline that has been
      // cleared.
      if(this.aborted) {

        return;
      }

      const service = this.#derive(key);
      const previous = this.#services.get(key);

      if(service !== null) {

        // The instance resolves, so whatever was being asked for has arrived.
        this.#resolutions.delete(key);

        if(previous === undefined) {

          this.#services.set(key, service);
          this.#onEvent({ kind: "found", service });
        } else if(!sameService(previous, service)) {

          this.#services.set(key, service);
          this.#onEvent({ kind: "updated", previous, service });
        }

        continue;
      }

      if(previous !== undefined) {

        this.#services.delete(key);
        this.#onEvent({ kind: "lost", service: previous });
      }

      /* An instance a PTR still names but that does not resolve is missing records RFC 6763 section 12 says a client asks for by name. An instance whose PTR has
       * left the cache is nothing to ask about, and dropping its ladder here is what lets a PTR that comes back start a fresh one.
       */
      if(!instances.has(key)) {

        this.#resolutions.delete(key);

        continue;
      }

      if(!this.#resolutions.has(key)) {

        this.#sequence++;

        const generation = this.#sequence;

        this.#resolutions.set(key, { attempt: 1, generation });
        this.#timeline.push({ at: now + this.#firstQueryDelay(), task: { generation, instanceKey: key, kind: "resolve" } });
      }
    }
  }

  /* What one instance currently resolves to, or `null` when the cache cannot answer for it yet. It needs the PTR that names it, an SRV and a TXT of its own,
   * and at least one address for the host the SRV targets. The most recently received SRV and TXT are the truth: a responder that moves a port announces the
   * new record while the old one is still cached, and the newer arrival is what it is telling us. Two records that arrived in the same instant are ordered by
   * when the cache took them, so a responder whose announcement lands inside one millisecond still reads as one statement.
   */
  #derive(instanceKey: string): Nullable<MdnsService> {

    let name: Nullable<DnsName> = null;
    let srv: Nullable<DnsSrvRecord> = null;
    let srvAt = 0;
    let txt: Nullable<DnsTxtRecord> = null;
    let txtAt = 0;

    for(const entry of this.#cache.values()) {

      const record = entry.record;

      switch(record.kind) {

        case "ptr": {

          if(dnsNameKey(record.target) === instanceKey) {

            name = record.target;
          }

          break;
        }

        case "srv": {

          if((dnsNameKey(record.name) === instanceKey) && ((srv === null) || (entry.receivedAt >= srvAt))) {

            srv = record;
            srvAt = entry.receivedAt;
          }

          break;
        }

        case "txt": {

          if((dnsNameKey(record.name) === instanceKey) && ((txt === null) || (entry.receivedAt >= txtAt))) {

            txt = record;
            txtAt = entry.receivedAt;
          }

          break;
        }

        default: {

          break;
        }
      }
    }

    if((name === null) || (srv === null) || (txt === null)) {

      return null;
    }

    const host = dnsNameKey(srv.target);
    const addresses: string[] = [];

    for(const entry of this.#cache.values()) {

      // Any address kind answers here: the caching pass admits only the families this browser serves, so what the cache holds for a host is already exactly the
      // set of addresses a consumer may connect to, and the order is the order they arrived in.
      if(((entry.record.kind === "a") || (entry.record.kind === "aaaa")) && (dnsNameKey(entry.record.name) === host) &&
        !addresses.includes(entry.record.address)) {

        addresses.push(entry.record.address);
      }
    }

    if(addresses.length === 0) {

      return null;
    }

    // The PTR pass drops a target that is the root, so an instance always has a first label to be known by.
    return { addresses, host: srv.target, instance: name[0] ?? "", name, port: srv.port, txt };
  }

  /* One resolution attempt: ask, in one message, for whatever this instance is still missing, then ladder the next attempt. RFC 6763 section 12 puts this on
   * the client, because a responder is only recommended to attach the SRV, TXT, and address records its PTR implies, and plenty do not.
   */
  #resolve(instanceKey: string, state: ResolveState, now: number): void {

    let name: Nullable<DnsName> = null;
    let srv: Nullable<DnsSrvRecord> = null;
    let srvAt = 0;
    let hasTxt = false;

    for(const entry of this.#cache.values()) {

      const record = entry.record;

      if((record.kind === "ptr") && (dnsNameKey(record.target) === instanceKey)) {

        name = record.target;
      }

      if((record.kind === "srv") && (dnsNameKey(record.name) === instanceKey) && ((srv === null) || (entry.receivedAt >= srvAt))) {

        srv = record;
        srvAt = entry.receivedAt;
      }

      if((record.kind === "txt") && (dnsNameKey(record.name) === instanceKey)) {

        hasTxt = true;
      }
    }

    // The PTR left the cache earlier in this same fire, ahead of this entry. The reconciliation that ends the fire drops the ladder, so nothing is asked here
    // and no further attempt is scheduled.
    if(name === null) {

      return;
    }

    const questions: DnsQuestion[] = [];

    if(srv === null) {

      questions.push({ name, type: DNS_TYPE_SRV, unicastResponse: false });
    }

    if(!hasTxt) {

      questions.push({ name, type: DNS_TYPE_TXT, unicastResponse: false });
    }

    /* Once the SRV is in hand the host it names is what is left to ask for, which is RFC 6763 section 12.2's additional record arriving late. Every served
     * family's address type is asked for, in this one message, and there is no per-family reading of what is still missing: a resolution runs only while the
     * instance does not derive, and an instance derives the moment its host has one address of any served family, so at the point of asking the host has no
     * address of either. The other family's address arrives through the responder's own announcements and through the maintenance question for the first
     * address, which goes out on every socket and is answered on the other family's socket with that family's record attached (RFC 6762 section 6.2). RFC 6762
     * section 20 has a dual-stack host perform its lookups over both families: these questions go out on every socket, as every query does, and a family's
     * question reaching the other family's socket is dropped by purity when it is answered and simply unanswered by a single-stack responder.
     */
    if((srv !== null) && !this.#hasAddressFor(srv.target)) {

      for(const entry of this.#sockets) {

        questions.push({ name: srv.target, type: entry.family.addressType, unicastResponse: false });
      }
    }

    if(questions.length > 0) {

      this.#send(buildMdnsQuery({ questions }));
    }

    // The ladder answers the delay before the attempt it is consulted about, so the attempt that just went out buys the wait before the next one.
    const at = now + this.#ladder(state.attempt + 1);

    state.attempt++;
    this.#timeline.push({ at, task: { generation: state.generation, instanceKey, kind: "resolve" } });
  }

  // Whether the cache holds any address at all for a host, of either family, which is what the derivation reads too: one address of one served family is what
  // makes an instance resolve, and what ends its resolution.
  #hasAddressFor(host: DnsName): boolean {

    const key = dnsNameKey(host);

    for(const entry of this.#cache.values()) {

      if(((entry.record.kind === "a") || (entry.record.kind === "aaaa")) && (dnsNameKey(entry.record.name) === key)) {

        return true;
      }
    }

    return false;
  }

  /* The teardown convergence point, run exactly once when `this.signal` aborts. No event is emitted for what the cache is holding: the consumer's stream ends on
   * the same signal, so a farewell nobody could read would only be noise. Dropping the memberships is courtesy - closing each socket drops them anyway, which is
   * why a refusal from a socket already on its way down is nothing to report.
   */
  #teardown(): void {

    this.#timer?.[Symbol.dispose]();
    this.#timer = undefined;
    this.#armedAt = null;
    this.#timeline.clear();
    this.#cache.clear();
    this.#resolutions.clear();
    this.#services.clear();

    // Taking the list first is what makes every delivery from here on inert through the serving guard, whatever the platform emitters still hand over.
    const sockets = this.#sockets.splice(0);

    for(const entry of sockets) {

      try {

        for(const [ link, state ] of entry.interfaces) {

          if(state === "joined") {

            entry.socket.dropMembership(entry.family.group, link);
          }
        }
      } catch {

        // The socket is going down and the kernel releases every membership with it.
      }

      // Outside the try above, and unconditional: a first close never throws, and a membership one socket refuses must skip neither that socket's own close nor
      // the next socket's, or the close that resolves its promise never happens and the disposal waiting on every one of them never settles.
      entry.socket.close();
    }

    this.#readyResolvers.reject(this.signal.reason);
    this.#settledResolvers.reject(this.signal.reason);
  }
}
