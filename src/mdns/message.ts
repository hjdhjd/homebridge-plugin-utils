/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/message.ts: The DNS message vocabulary, parser, and encoder the mDNS browser composes over.
 */

/**
 * The DNS message vocabulary, parser, and encoder the mDNS browser composes over.
 *
 * One datagram goes in and one readonly {@link DnsMessage} or `null` comes out. {@link encodeDnsMessage} is the single encoder for the whole record union,
 * compressing names as it writes. {@link buildMdnsQuery} splits a query whose known answers overflow a packet. The name readings ({@link parseDnsName},
 * {@link formatDnsName}, {@link dnsNameKey}, {@link dnsNamesEqual}) and {@link txtEntries} are the presentations a consumer applies to what it parsed. Sockets,
 * cadence, caches, service types, and devices belong to the browser above this module; the wire is all that lives here.
 *
 * The two directions answer a malformed input differently, and the difference is the design rather than an inconsistency. The parser reads an untrusted wire at
 * the rate a LAN answers a service-enumeration query, so every length, offset, count, and pointer is checked against the datagram and every rejection collapses
 * to one `null` rather than an exception, the posture `findBox` takes in `ffmpeg/fmp4.ts`. The encoder writes what the library itself composed, so a label over
 * 63 bytes, a name over 255, a TXT string over 255, or an address that does not parse is a programming error: it throws an `Error` naming the offending value,
 * the policy `mqtt-topics.ts` applies to a malformed catalog. The two address readers, {@link parseIpv4} and {@link parseIpv6}, are public, so the record
 * builders on the testing entry check an address at construction against the one grammar the encoder writes from, and a refusal names the reader and the value.
 *
 * The module carries no runtime import. Its one import is a type, erased at compile time, and that is deliberate rather than an accident of its size: the shipped
 * builders on the testing entry and the browser both reach it, and a value edge to `./util.ts` would carry the library's timer and signal machinery in behind a
 * module that only reads and writes bytes.
 *
 * Name compression works in both directions. The writer emits a two-byte pointer wherever an earlier occurrence of a name's suffix already sits in the same
 * message, inside the rdata of a PTR and an SRV as RFC 6762 section 18.14 asks as well as on the owner names; the reader follows a pointer only backward, so a
 * chain ends by construction rather than by a hop counter.
 *
 * @module
 */
import type { Nullable } from "../util.ts";

/**
 * The DNS wire type of an A record: one IPv4 address, four bytes of rdata.
 *
 * @category mDNS
 */
export const DNS_TYPE_A = 1;

/**
 * The DNS wire type of a PTR record: one name, which mDNS compresses. DNS-SD names a service type with one, pointing at each instance of it.
 *
 * @category mDNS
 */
export const DNS_TYPE_PTR = 12;

/**
 * The DNS wire type of a TXT record: a sequence of length-prefixed strings. DNS-SD reads the RFC 6763 key-value pairs of one through {@link txtEntries}.
 *
 * @category mDNS
 */
export const DNS_TYPE_TXT = 16;

/**
 * The DNS wire type of an AAAA record: one IPv6 address, sixteen bytes of rdata.
 *
 * @category mDNS
 */
export const DNS_TYPE_AAAA = 28;

/**
 * The DNS wire type of an SRV record: priority, weight, and port, then a target name, which mDNS compresses.
 *
 * @category mDNS
 */
export const DNS_TYPE_SRV = 33;

/**
 * The Internet class, the only class multicast DNS carries. The top bit of a class field on the wire is not part of it: on a question it asks for a unicast
 * response and on a record it marks a cache flush, and both reach a reader as their own boolean.
 *
 * @category mDNS
 */
export const DNS_CLASS_IN = 1;

/**
 * The largest packet {@link buildMdnsQuery} emits unless a caller names its own limit: the payload that fits an Ethernet frame under either address family's IP
 * and UDP headers, well inside the 9000-byte ceiling RFC 6762 section 17 sets, and the same value Homebridge's own advertiser sends with.
 *
 * @category mDNS
 */
export const MDNS_PACKET_LIMIT = 1440;

// The fixed DNS header: id, flags, and the four section counts, two bytes each.
const DNS_HEADER_SIZE = 12;

// The largest wire form of a name, counting each label's length byte and the terminating zero (RFC 1035 section 2.3.4).
const DNS_NAME_LIMIT = 255;

// The largest label the six length bits under a label byte's two type bits can spell.
const DNS_LABEL_LIMIT = 63;

// One past the largest offset a 14-bit compression pointer reaches, so every comparison against it is exclusive.
const DNS_POINTER_LIMIT = 0x4000;

// The largest constituent string of a TXT record, whose length is one byte (RFC 1035 section 3.3.14).
const DNS_TXT_STRING_LIMIT = 255;

// The fixed bytes between a record's name and its rdata: type, class, ttl, and rdlength.
const DNS_RECORD_HEADER_SIZE = 10;

// The header flag bits this module reads and writes. The bits RFC 6762 section 18 says a querier ignores on reception - AA on a response it did not solicit, RD,
// RA, Z, AD, and CD - are neither surfaced nor cleared, so no mask names them.
const FLAG_RESPONSE = 0x8000;
const FLAG_OPCODE = 0x7800;
const FLAG_AUTHORITATIVE = 0x0400;
const FLAG_TRUNCATED = 0x0200;
const FLAG_RCODE = 0x000F;

// The top bit of a class field: the unicast-response bit of a question (RFC 6762 section 18.12) and the cache-flush bit of a record (section 18.13).
const CLASS_TOP_BIT = 0x8000;

// The two type bits at the top of a label byte, and the one combination that marks a compression pointer, so the marker and the mask are one value.
const LABEL_TYPE_MASK = 0xC0;
const LABEL_POINTER = LABEL_TYPE_MASK;

// The six length bits under those two type bits, which is the same width as the largest label they can spell.
const LABEL_LENGTH_MASK = DNS_LABEL_LIMIT;

// The groups of an IPv6 address, fixed by RFC 3596's sixteen-byte rdata.
const IPV6_GROUP_COUNT = 8;

// The writer's opening capacity, doubled on demand. A query or a response for one service comfortably fits, so the common message is written without a regrow.
const WRITER_INITIAL_SIZE = 512;

// The ASCII letters RFC 6762 section 16 folds when it compares two names, and nothing else: a name is bytes, so a Unicode-aware fold would equate labels the
// protocol holds distinct.
const ASCII_UPPER = /[A-Z]/g;

// The two characters RFC 6763 section 4.3 escapes with a backslash when a label is presented as part of a flat string.
const NAME_ESCAPES = /[\\.]/g;

// One decimal octet of a dotted-quad address, admitting only digits so a trailing character or a hexadecimal prefix cannot slip through a numeric conversion.
const IPV4_OCTET = /^[0-9]{1,3}$/;

// One hexadecimal group of an IPv6 address.
const IPV6_GROUP = /^[0-9A-Fa-f]{1,4}$/;

/**
 * A name as its labels, each decoded as UTF-8, with the root as the empty array.
 *
 * A name is kept as labels rather than as one escaped string because a DNS-SD instance label is free text and may itself contain dots (RFC 6763 section 4.1.1),
 * so a flat string cannot be taken apart again without a convention. {@link formatDnsName} is the presentation for the places a flat string is what is wanted,
 * and {@link parseDnsName} reads one back.
 *
 * @category mDNS
 */
export type DnsName = readonly string[];

/**
 * One question of a message: the name asked about, the wire type asked for, and whether the asker set the top bit of the class field to request a unicast
 * response (RFC 6762 section 18.12).
 *
 * @category mDNS
 */
export interface DnsQuestion {

  readonly name: DnsName;
  readonly type: number;
  readonly unicastResponse: boolean;
}

// What every arm of the record union carries: the owner name, the ttl in seconds exactly as the wire spells it, and the cache-flush bit of the class field (RFC
// 6762 section 10.2), which a responder sets to tell a cache to replace what it holds for this name and type rather than to add to it.
interface DnsRecordBase {

  readonly flush: boolean;
  readonly name: DnsName;
  readonly ttl: number;
}

/**
 * An A record: one IPv4 address, presented in dotted decimal.
 *
 * @category mDNS
 */
export interface DnsARecord extends DnsRecordBase {

  readonly address: string;
  readonly kind: "a";
}

/**
 * An AAAA record: one IPv6 address, presented in the RFC 5952 text form - lowercase hexadecimal, leading zeros dropped, and the first longest run of two or more
 * zero groups written as `::`. A single zero group is never compressed, so the presentation is stable enough to compare as text.
 *
 * @category mDNS
 */
export interface DnsAaaaRecord extends DnsRecordBase {

  readonly address: string;
  readonly kind: "aaaa";
}

/**
 * A PTR record: one target name, decompressed by the parser and compressed again by the encoder.
 *
 * @category mDNS
 */
export interface DnsPtrRecord extends DnsRecordBase {

  readonly kind: "ptr";
  readonly target: DnsName;
}

/**
 * An SRV record: the RFC 2782 priority, weight, and port, and the target name they lead to, which mDNS compresses like any other name in rdata it lists.
 *
 * @category mDNS
 */
export interface DnsSrvRecord extends DnsRecordBase {

  readonly kind: "srv";
  readonly port: number;
  readonly priority: number;
  readonly target: DnsName;
  readonly weight: number;
}

/**
 * A TXT record: its constituent strings exactly as they arrived, undecoded, because RFC 6763 section 6.5 makes a value opaque binary. {@link txtEntries} is the
 * key-value reading for the consumers that want text.
 *
 * Each entry is a view over the datagram it was parsed from rather than a copy, so a consumer holding one past the receive that produced it copies with
 * `Buffer.from`.
 *
 * @category mDNS
 */
export interface DnsTxtRecord extends DnsRecordBase {

  readonly kind: "txt";
  readonly strings: readonly Buffer[];
}

/**
 * Every type this module does not model, carrying its wire type and its rdata bytes untouched.
 *
 * The rdata is never decompressed. RFC 6762 section 18.14 lists types whose rdata may carry a compressed name - NS, CNAME, SOA, and NSEC among them - and a
 * DNS-SD querier reads none of them, so a name inside this rdata reaches a consumer exactly as the wire spelled it, pointer bytes and all. The rdata is a view
 * over the datagram rather than a copy, so a consumer holding one past the receive that produced it copies with `Buffer.from`.
 *
 * @category mDNS
 */
export interface DnsOtherRecord extends DnsRecordBase {

  readonly kind: "other";
  readonly rdata: Buffer;
  readonly type: number;
}

/**
 * One resource record of a message, tagged by `kind` with the shape its rdata was read into.
 *
 * @category mDNS
 */
export type DnsRecord = DnsARecord | DnsAaaaRecord | DnsOtherRecord | DnsPtrRecord | DnsSrvRecord | DnsTxtRecord;

/**
 * The tag that tells one arm of {@link DnsRecord} from another.
 *
 * @category mDNS
 */
export type DnsRecordKind = DnsRecord["kind"];

/**
 * One parsed DNS message.
 *
 * Several things the wire carries are deliberately absent. The header bits RFC 6762 section 18 tells a querier to ignore on reception - AA, RD, RA, Z, AD, and CD
 * - are not surfaced, because a reader that cannot act on them has no use for them. The class of a question or a record is not surfaced either: multicast DNS
 * carries the Internet class alone, and the top bit that shares the field is surfaced as `unicastResponse` and `flush`. And a message whose OPCODE or RCODE is
 * nonzero never becomes a `DnsMessage` at all - RFC 6762 sections 18.3 and 18.11 tell a querier to ignore it, which for a reader is a rejection.
 *
 * @category mDNS
 */
export interface DnsMessage {

  readonly additionals: readonly DnsRecord[];
  readonly answers: readonly DnsRecord[];
  readonly authorities: readonly DnsRecord[];
  readonly id: number;
  readonly questions: readonly DnsQuestion[];
  readonly response: boolean;
  readonly truncated: boolean;
}

/**
 * What {@link encodeDnsMessage} accepts: a {@link DnsMessage} with every member optional. Every section defaults to empty, `id` to 0, and `response` and
 * `truncated` to `false`, so a message that came out of {@link parseDnsMessage} is itself a valid input and the two shapes cannot drift apart.
 *
 * @category mDNS
 */
export type DnsMessageInit = Partial<DnsMessage>;

/* The wire type of each modeled arm, written once. Every reader shares it: {@link writeRdata} answers with the entry for the arm it just wrote, so encoding an
 * arm and naming its type are one statement, and the `other` arm reads the values to refuse a record wearing a modeled type. A new arm of the union therefore
 * fails to compile at each reader until it is taught the arm too - at this table's missing key and at that switch's missing case - which is what keeps every
 * reader in step.
 */
const MODELED_WIRE_TYPES: Readonly<Record<Exclude<DnsRecordKind, "other">, number>> = {

  a: DNS_TYPE_A,
  aaaa: DNS_TYPE_AAAA,
  ptr: DNS_TYPE_PTR,
  srv: DNS_TYPE_SRV,
  txt: DNS_TYPE_TXT
};

// Fold the ASCII letters A to Z and nothing else, the comparison RFC 6762 section 16 defines. Anything above ASCII passes through untouched, so two labels that
// differ only in a non-ASCII case distinction stay distinct, as the protocol requires.
function foldAscii(text: string): string {

  return text.replace(ASCII_UPPER, (letter) => letter.toLowerCase());
}

/**
 * Read a flat name into its labels.
 *
 * Dots separate labels unless escaped. A backslash escapes the character after it, so `\.` is a literal dot inside a label and `\\` is a literal backslash; any
 * other backslash is dropped and the character it introduced is kept. Empty labels contribute nothing, so `""`, `"."`, and a trailing dot all read as a
 * name with one fewer label rather than as a label that is the empty string - the wire has no way to spell an empty label, since a zero length byte is the
 * terminator.
 *
 * @param text - The name as a flat string, in the form {@link formatDnsName} writes.
 *
 * @returns The labels, with the root reading as the empty array.
 *
 * @category mDNS
 */
export function parseDnsName(text: string): DnsName {

  const labels: string[] = [];
  let label = "";

  for(let index = 0; index < text.length; index++) {

    const character = text.charAt(index);

    if(character === "\\") {

      // The escaped character is taken verbatim. Reading past the end of the string answers "", so a trailing lone backslash contributes nothing.
      index++;
      label += text.charAt(index);

      continue;
    }

    if(character !== ".") {

      label += character;

      continue;
    }

    if(label.length > 0) {

      labels.push(label);
    }

    label = "";
  }

  if(label.length > 0) {

    labels.push(label);
  }

  return labels;
}

/**
 * Present a name as one flat string: the labels joined by dots, with every dot and backslash inside a label escaped by a backslash as RFC 6763 section 4.3
 * recommends. There is no trailing dot, and the root reads as the empty string.
 *
 * {@link parseDnsName} reads the result back to the name it was given, for every name whose labels are non-empty.
 *
 * @param name - The name as its labels.
 *
 * @returns The escaped, dot-joined presentation.
 *
 * @category mDNS
 */
export function formatDnsName(name: DnsName): string {

  return name.map((label) => label.replace(NAME_ESCAPES, "\\$&")).join(".");
}

/**
 * The canonical form of a name for comparison and for keying a cache: {@link formatDnsName} with the ASCII letters A to Z folded to lowercase and nothing else
 * folded, which is exactly the comparison RFC 6762 section 16 defines.
 *
 * @param name - The name as its labels.
 *
 * @returns The folded presentation, equal for two names the protocol considers the same.
 *
 * @category mDNS
 */
export function dnsNameKey(name: DnsName): string {

  return foldAscii(formatDnsName(name));
}

/**
 * Whether two names are the same under the RFC 6762 section 16 fold: the same number of labels, and each pair equal once the ASCII letters A to Z are folded.
 *
 * Computed label by label rather than by building either name's key, so a comparison that fails at the first label costs nothing beyond it.
 *
 * @param a - One name.
 * @param b - The other name.
 *
 * @returns Whether the protocol considers them the same name.
 *
 * @category mDNS
 */
export function dnsNamesEqual(a: DnsName, b: DnsName): boolean {

  return (a.length === b.length) && a.every((label, index) => foldAscii(label) === foldAscii(b[index] ?? ""));
}

/**
 * The wire type a record carries: a modeled arm answers the type the encoder writes for its kind, and an `other` record answers the type it was read with.
 *
 * This is the one reading of a record's type outside the encoder, and it reads the encoder's own table rather than a second copy of it. A cache keyed by name and
 * type, and a question asking for one record again, both name the same number the writer would put on the wire.
 *
 * @param record - The record.
 *
 * @returns The DNS wire type.
 *
 * @category mDNS
 */
export function dnsRecordType(record: DnsRecord): number {

  return (record.kind === "other") ? record.type : MODELED_WIRE_TYPES[record.kind];
}

// One name read out of a datagram: its labels, and the offset the bytes after it begin at. When a pointer was followed, `next` is the byte after that pointer
// rather than wherever the walk ended up, because that is where the caller's own reading continues.
interface DnsNameRead {

  readonly name: DnsName;
  readonly next: number;
}

// One record read out of a datagram, and the offset the record after it begins at.
interface DnsRecordRead {

  readonly next: number;
  readonly record: DnsRecord;
}

/* Walk a name from `start`, following compression pointers backward.
 *
 * `limit` bounds the labels this name may span: the end of the rdata for a name inside rdata, and the end of the datagram everywhere else. Following a pointer
 * widens the bound to the whole datagram, because a target may lie anywhere earlier in the message.
 *
 * A pointer must land strictly before the offset the current walk segment began at - the name's own start before any jump, and the previous target after one.
 * That is RFC 1035 section 4.1.4's "prior occurrence" stated as a check, and it is what makes a chain finite: every hop moves strictly earlier, so no chain can
 * revisit an offset and no hop counter is needed. A walk that compared instead against the name's own start would accept a pair of pointers aimed at each other
 * and spin forever.
 */
function readName(datagram: Buffer, start: number, limit: number): Nullable<DnsNameRead> {

  const labels: string[] = [];
  let bound = limit;
  let next = -1;
  let offset = start;
  let origin = start;
  let wireLength = 1;

  while(offset < bound) {

    const control = datagram.readUInt8(offset);

    // A zero byte is the root label, and it ends the name.
    if(control === 0) {

      return { name: labels, next: (next < 0) ? (offset + 1) : next };
    }

    const labelType = control & LABEL_TYPE_MASK;

    if(labelType === LABEL_POINTER) {

      if((offset + 2) > bound) {

        return null;
      }

      const target = datagram.readUInt16BE(offset) & (DNS_POINTER_LIMIT - 1);

      if(target >= origin) {

        return null;
      }

      // The first pointer is where the caller's reading resumes, whatever the rest of the chain does.
      if(next < 0) {

        next = offset + 2;
      }

      bound = datagram.length;
      offset = target;
      origin = target;

      continue;
    }

    // The label types 0x40 and 0x80 were reserved and then abandoned; a byte carrying either is a message this reader cannot follow.
    if(labelType !== 0) {

      return null;
    }

    const length = control & LABEL_LENGTH_MASK;
    const end = offset + 1 + length;

    if(end > bound) {

      return null;
    }

    // Measured as the wire spells it - each label's bytes plus its length byte, plus the terminator counted at the start - so a chain of pointers cannot
    // assemble a name longer than the format allows.
    wireLength += length + 1;

    if(wireLength > DNS_NAME_LIMIT) {

      return null;
    }

    labels.push(datagram.toString("utf8", offset + 1, end));
    offset = end;
  }

  return null;
}

// Present four bytes as a dotted-quad address.
function formatIpv4(bytes: Buffer): string {

  return [ bytes.readUInt8(0), bytes.readUInt8(1), bytes.readUInt8(2), bytes.readUInt8(3) ].join(".");
}

/* Present sixteen bytes in the RFC 5952 text form: lowercase hexadecimal groups with leading zeros dropped, and the longest run of two or more zero groups
 * replaced by `::`. Ties go to the first such run, and a single zero group is written out, both as section 4.2 requires - the rules exist so that one address
 * has one presentation, which is what lets a consumer compare two of these as text.
 */
function formatIpv6(bytes: Buffer): string {

  const groups: number[] = [];

  for(let offset = 0; offset < (IPV6_GROUP_COUNT * 2); offset += 2) {

    groups.push(bytes.readUInt16BE(offset));
  }

  // A best length of one to start with is what refuses to compress a lone zero group, and comparing strictly greater is what gives a tie to the earlier run.
  let bestLength = 1;
  let bestStart = -1;
  let runLength = 0;
  let runStart = -1;

  for(const [ index, group ] of groups.entries()) {

    if(group !== 0) {

      runLength = 0;

      continue;
    }

    runStart = (runLength === 0) ? index : runStart;
    runLength++;

    if(runLength > bestLength) {

      bestLength = runLength;
      bestStart = runStart;
    }
  }

  const rendered = groups.map((group) => group.toString(16));

  if(bestStart < 0) {

    return rendered.join(":");
  }

  return rendered.slice(0, bestStart).join(":") + "::" + rendered.slice(bestStart + bestLength).join(":");
}

/* Read one resource record starting at `start`: its owner name, the ten fixed bytes, and the rdata read into the arm its type names.
 *
 * Every arm that fails - a wrong-length address, an SRV too short to hold its three fields, a name inside rdata that does not end exactly where the rdata does,
 * a TXT whose strings do not tile the rdata - answers `null`, which rejects the whole message. A record this reader cannot make sense of is a message it cannot
 * be sure it has read correctly, and the browser above it counts the drop rather than salvaging part of a datagram.
 */
function readRecord(datagram: Buffer, start: number): Nullable<DnsRecordRead> {

  const owner = readName(datagram, start, datagram.length);

  if(owner === null) {

    return null;
  }

  const header = owner.next;

  if((header + DNS_RECORD_HEADER_SIZE) > datagram.length) {

    return null;
  }

  const rdata = header + DNS_RECORD_HEADER_SIZE;
  const rdlength = datagram.readUInt16BE(header + 8);
  const rdataEnd = rdata + rdlength;

  if(rdataEnd > datagram.length) {

    return null;
  }

  const base = { flush: (datagram.readUInt16BE(header + 2) & CLASS_TOP_BIT) !== 0, name: owner.name, ttl: datagram.readUInt32BE(header + 4) };
  const next = rdataEnd;
  const type = datagram.readUInt16BE(header);

  switch(type) {

    case DNS_TYPE_A: {

      // An A record's rdata is exactly the four bytes of the address (RFC 1035 section 3.4.1).
      if(rdlength !== 4) {

        return null;
      }

      return { next, record: { ...base, address: formatIpv4(datagram.subarray(rdata, rdataEnd)), kind: "a" } };
    }

    case DNS_TYPE_AAAA: {

      // An AAAA record's rdata is exactly the sixteen bytes of the address (RFC 3596 section 2.2).
      if(rdlength !== 16) {

        return null;
      }

      return { next, record: { ...base, address: formatIpv6(datagram.subarray(rdata, rdataEnd)), kind: "aaaa" } };
    }

    case DNS_TYPE_PTR: {

      const target = readName(datagram, rdata, rdataEnd);

      if(target?.next !== rdataEnd) {

        return null;
      }

      return { next, record: { ...base, kind: "ptr", target: target.name } };
    }

    case DNS_TYPE_SRV: {

      // Priority, weight, and port occupy the first six bytes, and the target name spends the rest (RFC 2782).
      if(rdlength < 6) {

        return null;
      }

      const target = readName(datagram, rdata + 6, rdataEnd);

      if(target?.next !== rdataEnd) {

        return null;
      }

      return { next, record: { ...base, kind: "srv", port: datagram.readUInt16BE(rdata + 4), priority: datagram.readUInt16BE(rdata),
        target: target.name, weight: datagram.readUInt16BE(rdata + 2) } };
    }

    case DNS_TYPE_TXT: {

      const strings: Buffer[] = [];
      let offset = rdata;

      // The strings tile the rdata exactly (RFC 1035 section 3.3.14), so one that claims more bytes than remain rejects the message. An empty rdata is zero
      // strings, which RFC 6763 section 6.1 says to read as the single empty string a well-formed responder would have sent.
      while(offset < rdataEnd) {

        const end = offset + 1 + datagram.readUInt8(offset);

        if(end > rdataEnd) {

          return null;
        }

        strings.push(datagram.subarray(offset + 1, end));
        offset = end;
      }

      return { next, record: { ...base, kind: "txt", strings } };
    }

    default: {

      return { next, record: { ...base, kind: "other", rdata: datagram.subarray(rdata, rdataEnd), type } };
    }
  }
}

/**
 * Read one datagram into a message.
 *
 * Every rejection reason collapses to one `null` - a short header, a nonzero OPCODE or RCODE, a section count with no bytes behind it, a name that runs off the
 * end or points forward, an rdata that overruns the datagram, a record whose rdata does not match its type - so a caller cannot tell from the return value which
 * one occurred, exactly as `findBox` does in `ffmpeg/fmp4.ts`. That is what the receive path wants: a LAN answers a service-enumeration query at roughly a
 * hundred packets a second, and a reader that never throws costs nothing to call on all of them.
 *
 * The `strings` of a TXT record and the `rdata` of an `other` record are views over `datagram` rather than copies, so a caller holding either past the receive
 * that produced it copies with `Buffer.from`.
 *
 * Records are decoded from every section whether the message is a query or a response. A query's answer section carries its sender's known answers, which a
 * querier may read but must not cache (RFC 6762 section 7.1) - that rule belongs to the browser holding the cache, not to this reader.
 *
 * Bytes after the last record of the last section are ignored.
 *
 * @param datagram - One complete UDP datagram, as received.
 *
 * @returns The message, or `null` when the datagram is not one this reader can read in full.
 *
 * @category mDNS
 */
export function parseDnsMessage(datagram: Buffer): Nullable<DnsMessage> {

  if(datagram.length < DNS_HEADER_SIZE) {

    return null;
  }

  const flags = datagram.readUInt16BE(2);

  // RFC 6762 sections 18.3 and 18.11: a querier silently ignores a message carrying a nonzero OPCODE or RCODE, which for a reader is a rejection.
  if(((flags & FLAG_OPCODE) !== 0) || ((flags & FLAG_RCODE) !== 0)) {

    return null;
  }

  const questionCount = datagram.readUInt16BE(4);
  const questions: DnsQuestion[] = [];
  let offset = DNS_HEADER_SIZE;

  // Nothing is preallocated from a count. A hostile header can claim sixty-five thousand records over twelve bytes, and the walk fails at the first read
  // past the end rather than reserving anything on the strength of the claim.
  for(let index = 0; index < questionCount; index++) {

    const owner = readName(datagram, offset, datagram.length);

    if(owner === null) {

      return null;
    }

    // The four bytes of type and class that follow the name have to be there.
    if((owner.next + 4) > datagram.length) {

      return null;
    }

    questions.push({ name: owner.name, type: datagram.readUInt16BE(owner.next),
      unicastResponse: (datagram.readUInt16BE(owner.next + 2) & CLASS_TOP_BIT) !== 0 });
    offset = owner.next + 4;
  }

  // The three record sections are the same walk over their own counts, threading the one offset through all of them.
  const readSection = (count: number): Nullable<DnsRecord[]> => {

    const records: DnsRecord[] = [];

    for(let index = 0; index < count; index++) {

      const read = readRecord(datagram, offset);

      if(read === null) {

        return null;
      }

      records.push(read.record);
      offset = read.next;
    }

    return records;
  };

  const answers = readSection(datagram.readUInt16BE(6));

  if(answers === null) {

    return null;
  }

  const authorities = readSection(datagram.readUInt16BE(8));

  if(authorities === null) {

    return null;
  }

  const additionals = readSection(datagram.readUInt16BE(10));

  if(additionals === null) {

    return null;
  }

  return { additionals, answers, authorities, id: datagram.readUInt16BE(0), questions, response: (flags & FLAG_RESPONSE) !== 0,
    truncated: (flags & FLAG_TRUNCATED) !== 0 };
}

/* The growable buffer one message is written into, and the compression state that goes with it.
 *
 * The suffix map is what makes compression work: every name written records the offset of each of its suffixes, and a later name emits a two-byte pointer at the
 * first suffix already on record. A suffix is keyed by each of its labels' UTF-8 byte length in decimal, a colon, and the label's text, concatenated. The length
 * prefix is what makes the key safe - a label may carry any character, a dot and a space included, so no join separator can tell `["Living.Room", "local"]` from
 * `["Living", "Room", "local"]`, and a key that confused those two would have the second name point at the first and decode as something nobody sent.
 *
 * An offset at or beyond the pointer limit is never recorded, since a 14-bit pointer cannot reach it; every entry the map holds is therefore one a later name may
 * point at, and a name whose earlier occurrence sits out of reach is written out in full.
 */
class MessageWriter {

  #buffer: Buffer;
  #offset: number;
  #suffixes: Map<string, number>;

  constructor() {

    this.#buffer = Buffer.alloc(WRITER_INITIAL_SIZE);
    this.#offset = 0;
    this.#suffixes = new Map<string, number>();
  }

  // The bytes written so far, which is what the packet limit is measured against.
  public get length(): number {

    return this.#offset;
  }

  // Grow the buffer until the next write fits, doubling rather than fitting exactly so a message written field by field regrows a handful of times at most.
  #reserve(bytes: number): void {

    if((this.#offset + bytes) <= this.#buffer.length) {

      return;
    }

    let size = this.#buffer.length;

    while(size < (this.#offset + bytes)) {

      size *= 2;
    }

    const grown = Buffer.alloc(size);

    this.#buffer.copy(grown, 0, 0, this.#offset);
    this.#buffer = grown;
  }

  public writeUInt8(value: number): void {

    this.#reserve(1);
    this.#buffer.writeUInt8(value, this.#offset);
    this.#offset += 1;
  }

  public writeUInt16(value: number): void {

    this.#reserve(2);
    this.#buffer.writeUInt16BE(value, this.#offset);
    this.#offset += 2;
  }

  public writeUInt32(value: number): void {

    this.#reserve(4);
    this.#buffer.writeUInt32BE(value, this.#offset);
    this.#offset += 4;
  }

  public writeBytes(bytes: Buffer): void {

    this.#reserve(bytes.length);
    bytes.copy(this.#buffer, this.#offset);
    this.#offset += bytes.length;
  }

  // Overwrite two bytes already written, which is how a field whose value is only known later - a record's type and rdlength, a packet's TC bit and answer
  // count - reaches the wire without the caller having to measure ahead.
  public patchUInt16(offset: number, value: number): void {

    this.#buffer.writeUInt16BE(value, offset);
  }

  // The offset a later reset returns to.
  public mark(): number {

    return this.#offset;
  }

  /* Discard everything written since `mark`, including every suffix recorded at or beyond it.
   *
   * Dropping those entries is what makes the reset safe rather than merely short: a suffix recorded inside the discarded bytes names an offset the reset has
   * vacated, and a later name pointing at it would decode as whatever ends up there instead.
   */
  public reset(mark: number): void {

    this.#offset = mark;

    for(const [ key, offset ] of this.#suffixes) {

      if(offset >= mark) {

        this.#suffixes.delete(key);
      }
    }
  }

  /* Write a name, emitting a pointer at the longest suffix already written into this message.
   *
   * Every label is measured as UTF-8 bytes rather than characters, because that is what the wire carries and what both limits are counted in. An empty label,
   * a label over 63 bytes, and a name whose wire form exceeds 255 bytes are all things the format cannot spell, so each throws rather than writing something a
   * reader would reject.
   */
  public writeName(name: DnsName): void {

    // Each label paired with the key of the suffix it begins, built from the last label backward so every key is one concatenation onto the shorter key below it.
    const suffixes: { bytes: Buffer; key: string }[] = [];
    let key = "";

    for(const label of name.toReversed()) {

      const bytes = Buffer.from(label, "utf8");

      key = bytes.length.toString() + ":" + label + key;
      suffixes.push({ bytes, key });
    }

    suffixes.reverse();

    let wireLength = 1;

    for(const suffix of suffixes) {

      const pointer = this.#suffixes.get(suffix.key);

      if(pointer !== undefined) {

        this.writeUInt16((LABEL_POINTER << 8) | pointer);

        return;
      }

      if(suffix.bytes.length === 0) {

        throw new Error("encodeDnsMessage: the name \"" + formatDnsName(name) + "\" carries an empty label, which the wire can spell only as a terminator.");
      }

      if(suffix.bytes.length > DNS_LABEL_LIMIT) {

        throw new Error("encodeDnsMessage: the label \"" + suffix.bytes.toString("utf8") + "\" is " + suffix.bytes.length.toString() + " bytes, over the " +
          DNS_LABEL_LIMIT.toString() + " a label may spend.");
      }

      wireLength += suffix.bytes.length + 1;

      if(wireLength > DNS_NAME_LIMIT) {

        throw new Error("encodeDnsMessage: the name \"" + formatDnsName(name) + "\" needs " + wireLength.toString() + " wire bytes, over the " +
          DNS_NAME_LIMIT.toString() + " a name may spend.");
      }

      if(this.#offset < DNS_POINTER_LIMIT) {

        this.#suffixes.set(suffix.key, this.#offset);
      }

      this.writeUInt8(suffix.bytes.length);
      this.writeBytes(suffix.bytes);
    }

    // The root, which is one zero byte and is never written as a pointer: a pointer costs two bytes to say what one already says.
    this.writeUInt8(0);
  }

  // A copy of exactly the bytes written, so the packet a caller receives does not share the writer's spare capacity.
  public finish(): Buffer {

    return Buffer.from(this.#buffer.subarray(0, this.#offset));
  }
}

/**
 * Read a dotted-quad IPv4 address into its four bytes.
 *
 * The grammar is exactly what the encoder writes from: four decimal octets from 0 to 255 separated by dots, and nothing else. The record builders on the testing
 * entry read an address through this function at construction, so a spelling the wire cannot carry is refused where it was supplied rather than at encode time.
 *
 * @param address - The address in dotted decimal.
 *
 * @returns The four bytes, in address order.
 *
 * @throws A `TypeError` naming this reader and the address when the spelling is not four decimal octets.
 *
 * @category mDNS
 */
export function parseIpv4(address: string): Buffer {

  const bytes = Buffer.alloc(4);
  const parts = address.split(".");

  if(parts.length !== 4) {

    throw new TypeError("parseIpv4: the address \"" + address + "\" is not four decimal octets.");
  }

  for(const [ index, part ] of parts.entries()) {

    const octet = Number(part);

    if(!IPV4_OCTET.test(part) || (octet > 255)) {

      throw new TypeError("parseIpv4: the address \"" + address + "\" carries \"" + part + "\", which is not a decimal octet from 0 to 255.");
    }

    bytes.writeUInt8(octet, index);
  }

  return bytes;
}

/**
 * Read an IPv6 address into its sixteen bytes: hexadecimal groups separated by colons, with at most one `::` standing for a run of one or more zero groups.
 *
 * The grammar is exactly what the encoder writes from, and it is narrower than the platform's own `isIPv6`: a zone suffix (`fe80::1%en0`, the form the browser
 * attaches to a link-local address it reports) and the mixed dotted tail RFC 4291 allows (`::ffff:192.168.1.1`) are both refused. An AAAA record this module
 * wrote is always spelled the way its RFC 5952 presentation reads, the record builders on the testing entry read an address through this function at
 * construction, and refusing the two forms outright is a clearer answer than a partial reading of either.
 *
 * @param address - The address in the RFC 4291 text form, without a zone.
 *
 * @returns The sixteen bytes, in address order.
 *
 * @throws A `TypeError` naming this reader and the address when the spelling carries more than one `::`, does not expand to eight groups, or carries a group that
 * is not one to four hexadecimal digits - a zone suffix and a dotted tail both read as such a group.
 *
 * @category mDNS
 */
export function parseIpv6(address: string): Buffer {

  const sides = address.split("::");

  if(sides.length > 2) {

    throw new TypeError("parseIpv6: the address \"" + address + "\" carries more than one \"::\".");
  }

  const [ head = "", tail = "" ] = sides;
  const headGroups = (head === "") ? [] : head.split(":");
  const tailGroups = (tail === "") ? [] : tail.split(":");
  const fill = IPV6_GROUP_COUNT - headGroups.length - tailGroups.length;

  // A `::` stands for at least one group of zeros; an address without one spells all eight groups itself.
  if(address.includes("::") ? (fill < 1) : (fill !== 0)) {

    throw new TypeError("parseIpv6: the address \"" + address + "\" does not expand to " + IPV6_GROUP_COUNT.toString() + " groups.");
  }

  const bytes = Buffer.alloc(IPV6_GROUP_COUNT * 2);
  const groups = [ ...headGroups, ...new Array<string>(fill).fill("0"), ...tailGroups ];

  for(const [ index, group ] of groups.entries()) {

    if(!IPV6_GROUP.test(group)) {

      throw new TypeError("parseIpv6: the address \"" + address + "\" carries \"" + group + "\", which is not a hexadecimal group.");
    }

    bytes.writeUInt16BE(parseInt(group, 16), index * 2);
  }

  return bytes;
}

/* Write one record's rdata and answer the wire type it was written as.
 *
 * One switch does both jobs, so an arm's layout and the type that names it are stated in one place. The switch carries no `default` and every case returns, which
 * under `noImplicitReturns` is what makes the compiler prove it covers the union: a new arm stops the build here until its rdata is written.
 */
function writeRdata(writer: MessageWriter, record: DnsRecord): number {

  switch(record.kind) {

    case "a": {

      writer.writeBytes(parseIpv4(record.address));

      return MODELED_WIRE_TYPES.a;
    }

    case "aaaa": {

      writer.writeBytes(parseIpv6(record.address));

      return MODELED_WIRE_TYPES.aaaa;
    }

    case "other": {

      // A modeled type has a layout this module writes from its own arm, so an `other` record wearing one would go out as opaque bytes and come back parsed
      // through that layout - a record nobody composed. The union has an arm for each of these types, and that arm is how to send one.
      if(Object.values(MODELED_WIRE_TYPES).includes(record.type)) {

        throw new Error("encodeDnsMessage: an \"other\" record on \"" + formatDnsName(record.name) + "\" names the type " + record.type.toString() +
          ", which the record union models as an arm of its own.");
      }

      writer.writeBytes(record.rdata);

      return record.type;
    }

    case "ptr": {

      writer.writeName(record.target);

      return MODELED_WIRE_TYPES.ptr;
    }

    case "srv": {

      writer.writeUInt16(record.priority);
      writer.writeUInt16(record.weight);
      writer.writeUInt16(record.port);
      writer.writeName(record.target);

      return MODELED_WIRE_TYPES.srv;
    }

    case "txt": {

      // RFC 6763 section 6.1: a TXT record is never empty on the wire, and a record carrying no strings goes out as the single empty string a reader treats as
      // equivalent.
      if(record.strings.length === 0) {

        writer.writeUInt8(0);

        return MODELED_WIRE_TYPES.txt;
      }

      for(const value of record.strings) {

        if(value.length > DNS_TXT_STRING_LIMIT) {

          throw new Error("encodeDnsMessage: a TXT string on \"" + formatDnsName(record.name) + "\" is " + value.length.toString() + " bytes, over the " +
            DNS_TXT_STRING_LIMIT.toString() + " one string may spend.");
        }

        writer.writeUInt8(value.length);
        writer.writeBytes(value);
      }

      return MODELED_WIRE_TYPES.txt;
    }
  }
}

/* Write one record: its name, the ten fixed bytes, and its rdata.
 *
 * The type and rdlength fields are written as placeholders and patched once the rdata has settled both, which is what lets the rdata be written straight into
 * the buffer instead of being measured into a scratch one first. `flush` is a parameter rather than the record's own bit because a known answer in a
 * query must go out with the bit clear whatever the cached record carries (RFC 6762 section 10.2).
 */
function writeRecord(writer: MessageWriter, record: DnsRecord, flush = record.flush): void {

  writer.writeName(record.name);

  const header = writer.mark();

  writer.writeUInt16(0);
  writer.writeUInt16(DNS_CLASS_IN | (flush ? CLASS_TOP_BIT : 0));
  writer.writeUInt32(record.ttl);
  writer.writeUInt16(0);

  const rdata = header + DNS_RECORD_HEADER_SIZE;
  const type = writeRdata(writer, record);

  writer.patchUInt16(header, type);
  writer.patchUInt16(rdata - 2, writer.length - rdata);
}

/* Write the twelve fixed header bytes in wire order: id, flags, and the four section counts.
 *
 * Both writers of a message spell the same header, so it is spelled once here. The encoder knows every count before it starts and passes them all; the query
 * builder passes only the question count and patches the flags and the answer count into the packet as it closes.
 */
function writeHeader(writer: MessageWriter, { additionals = 0, answers = 0, authorities = 0, flags = 0, id = 0, questions = 0 }: { readonly additionals?: number;
  readonly answers?: number; readonly authorities?: number; readonly flags?: number; readonly id?: number; readonly questions?: number; }): void {

  writer.writeUInt16(id);
  writer.writeUInt16(flags);
  writer.writeUInt16(questions);
  writer.writeUInt16(answers);
  writer.writeUInt16(authorities);
  writer.writeUInt16(additionals);
}

// Write one question: the name asked about, the type asked for, and the class field whose top bit asks for a unicast response (RFC 6762 section 18.12). The
// encoder and the query builder both ask the same way, so both reach the wire through this.
function writeQuestion(writer: MessageWriter, question: DnsQuestion): void {

  writer.writeName(question.name);
  writer.writeUInt16(question.type);
  writer.writeUInt16(DNS_CLASS_IN | (question.unicastResponse ? CLASS_TOP_BIT : 0));
}

/**
 * Write a message to bytes.
 *
 * Names are compressed wherever an earlier occurrence of a suffix already sits in the message, on owner names and inside the rdata of PTR and SRV records alike,
 * as RFC 6762 section 18.14 asks. A response sets QR and AA together, since a multicast response is authoritative by definition (section 18.4).
 *
 * What a caller composed and the wire cannot carry throws an `Error` naming the offending value: an empty label, a label over 63 bytes, a name over 255 wire
 * bytes, a TXT string over 255 bytes, an address that is not four decimal octets or eight hexadecimal groups (the `TypeError` of {@link parseIpv4} or
 * {@link parseIpv6}, which read the address), and an `other` record wearing a type the union models as its own arm. A numeric field wider than the wire allows
 * it - `id`, `ttl`, `port`, `priority`, `weight`, and a type - throws the platform's own range error from the typed write, which already names the value, so no
 * separate check restates it.
 *
 * @param init - The message. Every section defaults to empty, `id` to 0, and `response` and `truncated` to `false`.
 *
 * @returns The encoded datagram.
 *
 * @category mDNS
 */
export function encodeDnsMessage({ additionals = [], answers = [], authorities = [], id = 0, questions = [], response = false,
  truncated = false }: DnsMessageInit): Buffer {

  const writer = new MessageWriter();

  writeHeader(writer, { additionals: additionals.length, answers: answers.length, authorities: authorities.length,
    flags: (response ? (FLAG_RESPONSE | FLAG_AUTHORITATIVE) : 0) | (truncated ? FLAG_TRUNCATED : 0), id, questions: questions.length });

  for(const question of questions) {

    writeQuestion(writer, question);
  }

  // The three record sections go out in the order the header counted them.
  for(const section of [ answers, authorities, additionals ]) {

    for(const record of section) {

      writeRecord(writer, record);
    }
  }

  return writer.finish();
}

/**
 * Build the packets of one multicast query, splitting its known answers across as many as they need.
 *
 * A query carries id 0 and no flag bit (RFC 6762 sections 18.1 and 18.2), its questions in the first packet only, and its known answers in the answer section
 * with the cache-flush bit clear on every one of them (section 10.2). When the next known answer would push a packet over `limit`, section 7.2's split applies:
 * the packet so far goes out with TC set, and a following packet carrying no question continues the list. Every packet is its own compression scope, since a
 * pointer can only reach within the packet that carries it.
 *
 * An answer too large for a packet of its own is omitted rather than sent in a form no reader could use. Its only cost is one response this query does not
 * suppress, which is the same cost a querier pays for every answer it has not cached yet.
 *
 * @param options                - The query.
 * @param options.knownAnswers   - The records the querier already holds, offered in order and delivered in that order across the packets. Defaults to none.
 * @param options.limit          - The largest packet to emit, in bytes. Defaults to {@link MDNS_PACKET_LIMIT}.
 * @param options.questions      - The questions, carried by the first packet.
 *
 * @returns The packets, in the order they are to be sent. Always at least one.
 *
 * @throws An `Error` when the questions do not fit `limit`, since a query that cannot ask anything is a composed-input error rather than a split to make.
 *
 * @category mDNS
 */
export function buildMdnsQuery({ knownAnswers = [], limit = MDNS_PACKET_LIMIT, questions }: { readonly knownAnswers?: readonly DnsRecord[];
  readonly limit?: number; readonly questions: readonly DnsQuestion[]; }): Buffer[] {

  // A packet's header: id 0, no flag bit, and a question count only the first packet carries. The flags and answer count are patched as the packet closes.
  const openPacket = (count: number): MessageWriter => {

    const packet = new MessageWriter();

    writeHeader(packet, { questions: count });

    return packet;
  };

  const packets: Buffer[] = [];
  let answerCount = 0;
  let writer = openPacket(questions.length);

  for(const question of questions) {

    writeQuestion(writer, question);
  }

  if(writer.length > limit) {

    throw new Error("buildMdnsQuery: the questions need " + writer.length.toString() + " bytes, over the packet limit of " + limit.toString() + ".");
  }

  /* Offer one known answer to the packet under construction, keeping it only if the packet stays within the limit and rewinding the writer if it does not.
   *
   * RFC 6762 section 10.2 forbids the cache-flush bit in a known-answer list, so every answer goes out with it clear whatever the cached record carries.
   */
  const offer = (answer: DnsRecord): boolean => {

    const mark = writer.mark();

    writeRecord(writer, answer, false);

    if(writer.length > limit) {

      writer.reset(mark);

      return false;
    }

    answerCount++;

    return true;
  };

  for(const answer of knownAnswers) {

    if(offer(answer)) {

      continue;
    }

    // The answer does not fit beside what this packet already holds. A packet holding only its header - the offer rewound whatever it wrote - cannot make room
    // for it, so it is dropped and the next answer is offered to the same empty packet.
    if(writer.length === DNS_HEADER_SIZE) {

      continue;
    }

    writer.patchUInt16(2, FLAG_TRUNCATED);
    writer.patchUInt16(6, answerCount);
    packets.push(writer.finish());

    answerCount = 0;
    writer = openPacket(0);

    // A second refusal means the answer overflows an empty packet, and the offer has already rewound the writer for the answer that follows it.
    offer(answer);
  }

  writer.patchUInt16(6, answerCount);
  packets.push(writer.finish());

  return packets;
}

/**
 * Read a TXT record as the key-value pairs RFC 6763 sections 6.3 through 6.5 define.
 *
 * Each string is a key, the bytes before its first `=`, and a value, the bytes after it. A string with no `=` is a flag, and maps to `null`. Keys are folded to
 * lowercase over ASCII, so `PaperSize` and `papersize` are one key. An empty string and a string that opens with `=` carry no key and are silently ignored, and
 * when a key appears more than once the first occurrence wins and the rest are dropped.
 *
 * A consumer therefore distinguishes four states: the key is absent from the map; it maps to `null`, so it is a flag; it maps to `""`, so it was written with an
 * `=` and nothing after it; or it maps to a value. Values are decoded as UTF-8 here, which is what a consumer reading configuration wants; a consumer whose
 * values are binary reads `strings` instead, since RFC 6763 section 6.5 makes a value opaque.
 *
 * @param record - The TXT record.
 *
 * @returns The pairs, in the order the record spells them.
 *
 * @category mDNS
 */
export function txtEntries(record: DnsTxtRecord): ReadonlyMap<string, Nullable<string>> {

  const entries = new Map<string, Nullable<string>>();

  for(const value of record.strings) {

    const separator = value.indexOf("=");

    // A string with nothing in it and a string whose key is missing are both nothing to record (RFC 6763 sections 6.1 and 6.4).
    if((value.length === 0) || (separator === 0)) {

      continue;
    }

    const key = foldAscii((separator < 0) ? value.toString("utf8") : value.toString("utf8", 0, separator));

    // RFC 6763 section 6.4: a client reading a repeated key takes the first occurrence and ignores every later one.
    if(entries.has(key)) {

      continue;
    }

    entries.set(key, (separator < 0) ? null : value.toString("utf8", separator + 1));
  }

  return entries;
}
