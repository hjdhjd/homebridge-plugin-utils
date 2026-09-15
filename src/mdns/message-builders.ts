/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/message-builders.ts: Published DNS record and response builders for the mDNS suites and every consumer's tests.
 */

/**
 * Shared DNS record and response builders.
 *
 * The DNS-SD vocabulary every consumer's tests compose service discovery from - the library's own message suite, and, once it exists, the mDNS browser's suite
 * and downstream plugins alike. A
 * factory per record kind, {@link makeResponse} to encode a set of records as a response, and {@link makeServiceRecords} for the PTR, SRV, TXT, and address
 * records that together advertise one service instance. Ships on the `homebridge-plugin-utils/testing` entry point beside the other test doubles, so a consumer
 * builds real mDNS bytes without hand-rolling a header or re-deriving name compression.
 *
 * The response builder writes through the production encoder rather than assembling bytes of its own. That is the whole point of building this on the testing
 * entry instead of inside a suite: a fixture and the code under test would otherwise encode the same wire format twice, and the day the two disagree the suite
 * would prove nothing.
 *
 * **Wire-format constants.** Anything the production reader or writer consults lives in `message.ts` and is imported here, so one definition serves both. The
 * recommended TTLs below are the other case: production reads a ttl off the wire and never chooses one, so the RFC 6762 section 10 defaults are test-only values
 * and live with the builders.
 *
 * @module
 */
import type { DnsARecord, DnsAaaaRecord, DnsName, DnsOtherRecord, DnsPtrRecord, DnsRecord, DnsSrvRecord, DnsTxtRecord } from "./message.ts";
import { encodeDnsMessage, parseDnsName, parseIpv4, parseIpv6 } from "./message.ts";

// RFC 6762 section 10's recommended ttl for a record whose name or rdata is a host name, in seconds: short, because a host that moves should stop being found
// quickly.
const HOST_RECORD_TTL = 120;

// RFC 6762 section 10's recommended ttl for every other record, in seconds - seventy-five minutes.
const SERVICE_RECORD_TTL = 4500;

// Accept a name in either spelling a test finds convenient: labels already split, or a flat string to read through the production parser.
function toDnsName(name: DnsName | string): DnsName {

  return (typeof name === "string") ? parseDnsName(name) : name;
}

/**
 * Build an A record.
 *
 * @param options          - The record.
 * @param options.address  - The IPv4 address in dotted decimal, read through {@link parseIpv4} so a spelling the wire cannot carry is refused here.
 * @param options.flush    - Whether the cache-flush bit is set. Defaults to `false`.
 * @param options.name     - The owner name, as labels or as a flat string.
 * @param options.ttl      - The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a host name.
 *
 * @returns The record.
 *
 * @category Testing
 */
export function makeARecord({ address, flush = false, name, ttl = HOST_RECORD_TTL }: { readonly address: string; readonly flush?: boolean;
  readonly name: DnsName | string; readonly ttl?: number; }): DnsARecord {

  // The address is read through the encoder's own reader and the bytes discarded: the record keeps the text, and a spelling the wire cannot carry is refused at
  // the call that supplied it, under the reader's own name, rather than later inside the encoder.
  parseIpv4(address);

  return { address, flush, kind: "a", name: toDnsName(name), ttl };
}

/**
 * Build an AAAA record.
 *
 * @param options          - The record.
 * @param options.address  - The IPv6 address in the RFC 4291 text form, read through {@link parseIpv6} so a zone suffix or a dotted tail is refused here; a
 *                           record parsed back carries the RFC 5952 form.
 * @param options.flush    - Whether the cache-flush bit is set. Defaults to `false`.
 * @param options.name     - The owner name, as labels or as a flat string.
 * @param options.ttl      - The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a host name.
 *
 * @returns The record.
 *
 * @category Testing
 */
export function makeAaaaRecord({ address, flush = false, name, ttl = HOST_RECORD_TTL }: { readonly address: string; readonly flush?: boolean;
  readonly name: DnsName | string; readonly ttl?: number; }): DnsAaaaRecord {

  // The address is read through the encoder's own reader and the bytes discarded, exactly as makeARecord does: a zone suffix, a dotted tail, or a malformed group
  // is refused at the call that supplied it, under the reader's own name.
  parseIpv6(address);

  return { address, flush, kind: "aaaa", name: toDnsName(name), ttl };
}

/**
 * Build a PTR record.
 *
 * @param options         - The record.
 * @param options.flush   - Whether the cache-flush bit is set. Defaults to `false`, which is what a PTR always carries in practice: it is a shared record, and
 *                          RFC 6762 section 10.2 reserves the bit for the unique ones.
 * @param options.name    - The owner name, as labels or as a flat string.
 * @param options.target  - The name pointed at, as labels or as a flat string.
 * @param options.ttl     - The ttl in seconds. Defaults to the 4500 RFC 6762 section 10 recommends for a record that names no host.
 *
 * @returns The record.
 *
 * @category Testing
 */
export function makePtrRecord({ flush = false, name, target, ttl = SERVICE_RECORD_TTL }: { readonly flush?: boolean; readonly name: DnsName | string;
  readonly target: DnsName | string; readonly ttl?: number; }): DnsPtrRecord {

  return { flush, kind: "ptr", name: toDnsName(name), target: toDnsName(target), ttl };
}

/**
 * Build an SRV record.
 *
 * @param options           - The record.
 * @param options.flush     - Whether the cache-flush bit is set. Defaults to `false`.
 * @param options.name      - The owner name, as labels or as a flat string.
 * @param options.port      - The port the service answers on.
 * @param options.priority  - The RFC 2782 priority. Defaults to 0.
 * @param options.target    - The host name the service runs on, as labels or as a flat string.
 * @param options.ttl       - The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a record whose rdata names a host.
 * @param options.weight    - The RFC 2782 weight. Defaults to 0.
 *
 * @returns The record.
 *
 * @category Testing
 */
export function makeSrvRecord({ flush = false, name, port, priority = 0, target, ttl = HOST_RECORD_TTL, weight = 0 }: { readonly flush?: boolean;
  readonly name: DnsName | string; readonly port: number; readonly priority?: number; readonly target: DnsName | string; readonly ttl?: number;
  readonly weight?: number; }): DnsSrvRecord {

  return { flush, kind: "srv", name: toDnsName(name), port, priority, target: toDnsName(target), ttl, weight };
}

/**
 * Build a TXT record.
 *
 * @param options          - The record.
 * @param options.flush    - Whether the cache-flush bit is set. Defaults to `false`.
 * @param options.name     - The owner name, as labels or as a flat string.
 * @param options.strings  - The constituent strings. A string is encoded as UTF-8 and a Buffer passes through untouched, which is how a test spells a binary
 *                           value. Defaults to none, which the encoder writes as the single empty string RFC 6763 section 6.1 calls for.
 * @param options.ttl      - The ttl in seconds. Defaults to the 4500 RFC 6762 section 10 recommends for a record that names no host.
 *
 * @returns The record.
 *
 * @category Testing
 */
export function makeTxtRecord({ flush = false, name, strings = [], ttl = SERVICE_RECORD_TTL }: { readonly flush?: boolean; readonly name: DnsName | string;
  readonly strings?: readonly (Buffer | string)[]; readonly ttl?: number; }): DnsTxtRecord {

  return { flush, kind: "txt", name: toDnsName(name),
    strings: strings.map((value) => (typeof value === "string") ? Buffer.from(value, "utf8") : value), ttl };
}

/**
 * Build a record of a type the union does not model, carrying its rdata verbatim.
 *
 * @param options        - The record.
 * @param options.flush  - Whether the cache-flush bit is set. Defaults to `false`.
 * @param options.name   - The owner name, as labels or as a flat string.
 * @param options.rdata  - The rdata bytes, written and read back untouched.
 * @param options.ttl    - The ttl in seconds. Defaults to the 120 RFC 6762 section 10 recommends for a host name.
 * @param options.type   - The wire type. The encoder refuses a type the union models as an arm of its own.
 *
 * @returns The record.
 *
 * @category Testing
 */
export function makeOtherRecord({ flush = false, name, rdata, ttl = HOST_RECORD_TTL, type }: { readonly flush?: boolean; readonly name: DnsName | string;
  readonly rdata: Buffer; readonly ttl?: number; readonly type: number; }): DnsOtherRecord {

  return { flush, kind: "other", name: toDnsName(name), rdata, ttl, type };
}

/**
 * Encode a set of records as a response datagram, through the production encoder.
 *
 * @param options              - The response.
 * @param options.additionals  - The additional section. Defaults to empty.
 * @param options.answers      - The answer section. Defaults to empty.
 * @param options.authorities  - The authority section. Defaults to empty.
 * @param options.truncated    - Whether TC is set. Defaults to `false`.
 *
 * @returns The datagram, with QR and AA set as a multicast response carries them.
 *
 * @category Testing
 */
export function makeResponse({ additionals = [], answers = [], authorities = [], truncated = false }: { readonly additionals?: readonly DnsRecord[];
  readonly answers?: readonly DnsRecord[]; readonly authorities?: readonly DnsRecord[]; readonly truncated?: boolean; } = {}): Buffer {

  return encodeDnsMessage({ additionals, answers, authorities, response: true, truncated });
}

/**
 * What one service instance is advertised by: the names, the endpoint, the TXT strings, and every address of the host. {@link makeServiceRecords} builds the
 * records of it and `makeService` on the testing entry point composes the resolved service a browser derives from those same records, so a test that advertises
 * with one and delivers with the other describes one instance by construction.
 *
 * @property addresses    - Every address of the host, IPv4 in dotted decimal or IPv6 in the RFC 4291 text form without a zone. Each is carried by a record of
 *                          its own, an A or an AAAA by that address's own spelling.
 * @property domain       - The domain every name sits under, as labels or as a flat string. Defaults to `"local"`.
 * @property host         - The host's own label, as labels or as a flat string, placed under the domain.
 * @property instance     - The instance label, taken verbatim as one label: RFC 6763 section 4.1.1 makes it free text, so a dot in it is part of the name.
 * @property port         - The port the service answers on.
 * @property serviceType  - The service type, as labels or as a flat string (`"_hap._tcp"`), placed under the domain.
 * @property strings      - The TXT record's strings. Defaults to none.
 *
 * @category Testing
 */
export interface MdnsServiceFixture {

  readonly addresses: readonly string[];
  readonly domain?: DnsName | string;
  readonly host: DnsName | string;
  readonly instance: string;
  readonly port: number;
  readonly serviceType: DnsName | string;
  readonly strings?: readonly (Buffer | string)[];
}

/**
 * Build the records that advertise one service instance: the PTR from the service type to the instance, the SRV from the instance to the host, the TXT on the
 * instance, and one address record per address of the host, each an A or an AAAA by its own address's spelling - in that order, which is the order a responder
 * sends them and the order the compression pointers of an encoded response read most naturally.
 *
 * The PTR is never flushed. It is a shared record, one of many under the same service name, and RFC 6762 section 10.2 reserves the cache-flush bit for records
 * whose name and type belong to one responder alone. `flush` therefore reaches the SRV, the TXT, and each address record only.
 *
 * @param options          - The instance. See {@link MdnsServiceFixture}.
 * @param options.flush    - Whether the cache-flush bit is set on the unique records. Defaults to `false`.
 *
 * @returns The records that advertise the instance, in advertising order. An instance named with no address is its PTR, SRV, and TXT alone.
 *
 * @category Testing
 */
export function makeServiceRecords({ addresses, domain = "local", flush = false, host, instance, port, serviceType,
  strings = [] }: MdnsServiceFixture & { readonly flush?: boolean }): readonly DnsRecord[] {

  const domainLabels = toDnsName(domain);
  const serviceName = [ ...toDnsName(serviceType), ...domainLabels ];
  const hostName = [ ...toDnsName(host), ...domainLabels ];
  const instanceName = [ instance, ...serviceName ];

  return [ makePtrRecord({ name: serviceName, target: instanceName }), makeSrvRecord({ flush, name: instanceName, port, target: hostName }),
    makeTxtRecord({ flush, name: instanceName, strings }),
    ...addresses.map((address) => address.includes(":") ? makeAaaaRecord({ address, flush, name: hostName }) : makeARecord({ address, flush, name: hostName })) ];
}
