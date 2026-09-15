/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/message.test.ts: Unit tests for the DNS message module - the name readings, the bounds-checked parser and its compression walk, the encoder and its
 * compression writer, the RFC 6762 known-answer split, and the RFC 6763 TXT reading. The parser reads an untrusted wire, so every rejection is enumerated
 * alongside the well-formed vector it is one byte away from, and the parser and the encoder are proven inverses over one record of every kind.
 */
import { DNS_TYPE_A, DNS_TYPE_AAAA, DNS_TYPE_PTR, DNS_TYPE_SRV, DNS_TYPE_TXT, buildMdnsQuery, dnsNameKey, dnsNamesEqual, dnsRecordType, encodeDnsMessage,
  formatDnsName, parseDnsMessage, parseDnsName, parseIpv4, parseIpv6, txtEntries } from "./message.ts";
import type { DnsMessage, DnsRecord } from "./message.ts";
import { describe, test } from "node:test";
import { makeARecord, makeAaaaRecord, makeOtherRecord, makePtrRecord, makeResponse, makeServiceRecords, makeSrvRecord,
  makeTxtRecord } from "./message-builders.ts";
import assert from "node:assert/strict";
import { expectAt } from "../testing/index.ts";

// Assemble a datagram from literal byte lists and buffers, so a malformed vector is spelled exactly as the wire would carry it rather than through the encoder
// that is itself under test.
function makeDatagram(...parts: readonly (Buffer | readonly number[])[]): Buffer {

  return Buffer.concat(parts.map((part) => Array.isArray(part) ? Buffer.from(part) : (part as Buffer)));
}

// The twelve fixed header bytes.
function makeHeader({ additionals = 0, answers = 0, authorities = 0, flags = 0, id = 0, questions = 0 }: { readonly additionals?: number;
  readonly answers?: number; readonly authorities?: number; readonly flags?: number; readonly id?: number; readonly questions?: number; } = {}): Buffer {

  const header = Buffer.alloc(12);

  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(questions, 4);
  header.writeUInt16BE(answers, 6);
  header.writeUInt16BE(authorities, 8);
  header.writeUInt16BE(additionals, 10);

  return header;
}

// Spell a name as uncompressed labels followed by the root terminator.
function labels(...names: readonly string[]): Buffer {

  return Buffer.concat([ ...names.map((label) => Buffer.concat([ Buffer.from([Buffer.byteLength(label)]), Buffer.from(label) ])), Buffer.from([0]) ]);
}

// Spell a two-byte compression pointer at the given offset.
function pointer(offset: number): Buffer {

  return Buffer.from([ 0xC0 | (offset >> 8), offset & 0xFF ]);
}

// Spell one resource record. The rdlength defaults to the rdata's own length, and overriding it is how a vector claims more or fewer bytes than it carries.
function makeRecord({ classField = 1, name, rdata = Buffer.alloc(0), rdlength = rdata.length, ttl = 0, type }: { readonly classField?: number;
  readonly name: Buffer; readonly rdata?: Buffer; readonly rdlength?: number; readonly ttl?: number; readonly type: number; }): Buffer {

  const fixed = Buffer.alloc(10);

  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(classField, 2);
  fixed.writeUInt32BE(ttl, 4);
  fixed.writeUInt16BE(rdlength, 8);

  return Buffer.concat([ name, fixed, rdata ]);
}

// Spell one question: a name, then type and class.
function makeQuestion(name: Buffer, type = DNS_TYPE_PTR, classField = 1): Buffer {

  const fixed = Buffer.alloc(4);

  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(classField, 2);

  return Buffer.concat([ name, fixed ]);
}

// Parse a datagram that the row expects to be well-formed, failing the row rather than the assertion below it when it is not.
function expectMessage(datagram: Buffer, what: string): DnsMessage {

  const message = parseDnsMessage(datagram);

  assert.ok(message !== null, what + " must parse");

  return message;
}

// A label of the requested byte length, for the vectors that sit on the 63-byte and 255-byte limits.
function repeat(length: number): string {

  return "a".repeat(length);
}

describe("parseDnsName / formatDnsName - the label grammar", () => {

  test("N1: reads a flat name into labels, honoring escapes and dropping empty labels", () => {

    assert.deepEqual(parseDnsName("_hap._tcp.local"), [ "_hap", "_tcp", "local" ]);
    assert.deepEqual(parseDnsName(""), []);
    assert.deepEqual(parseDnsName("."), []);
    assert.deepEqual(parseDnsName("local."), ["local"]);

    // An escaped dot is part of the label, which is what makes a DNS-SD instance label carrying a dot expressible as a flat string.
    assert.deepEqual(parseDnsName("Living\\.Room._hap._tcp.local"), [ "Living.Room", "_hap", "_tcp", "local" ]);
    assert.deepEqual(parseDnsName("a\\\\b"), ["a\\b"]);
    assert.deepEqual(parseDnsName("a..b"), [ "a", "b" ]);
  });

  test("N2: presents labels as a flat name, escaping every dot and backslash", () => {

    assert.equal(formatDnsName([ "_hap", "_tcp", "local" ]), "_hap._tcp.local");
    assert.equal(formatDnsName([]), "");
    assert.equal(formatDnsName(["local"]), "local");
    assert.equal(formatDnsName([ "Living.Room", "_hap", "_tcp", "local" ]), "Living\\.Room._hap._tcp.local");
    assert.equal(formatDnsName(["a\\b"]), "a\\\\b");
    assert.equal(formatDnsName([ "a", "b" ]), "a.b");
    assert.equal(formatDnsName(["a.b\\c"]), "a\\.b\\\\c");
  });

  test("N3: the two readings are inverses over every name whose labels are non-empty", () => {

    const names = [ ["local"], [ "Living.Room", "_hap", "_tcp", "local" ], ["a\\b"], [ "one", "two", "three", "four", "five" ], [] ];

    for(const name of names) {

      assert.deepEqual(parseDnsName(formatDnsName(name)), name, "round trip of " + JSON.stringify(name));
    }
  });
});

describe("dnsNameKey / dnsNamesEqual - the RFC 6762 fold", () => {

  test("N4: folds the ASCII letters and nothing else", () => {

    assert.equal(dnsNameKey([ "MyPrinter", "local" ]), "myprinter.local");

    // A capital outside ASCII stays capital: RFC 6762 section 16 folds `A` to `Z` only, so a Unicode-aware fold would equate labels the protocol holds apart.
    assert.equal(dnsNameKey(["Étoile"]), "Étoile");
    assert.equal(dnsNamesEqual([ "MyPrinter", "local" ], [ "myprinter", "LOCAL" ]), true);
    assert.equal(dnsNamesEqual(["Étoile"], ["étoile"]), false);
    assert.equal(dnsNamesEqual([ "a", "local" ], ["a"]), false);
  });
});

describe("dnsRecordType - the wire type of a record", () => {

  test("R1: every modeled arm answers the type the encoder writes for it, and an unmodeled one answers the type it was read with", () => {

    const advertisement = makeServiceRecords({ addresses: ["192.0.2.50"], host: "gdo", instance: "Garage Door", port: 6053, serviceType: "_esphomelib._tcp",
      strings: ["mac=aabbccddeeff"] });

    assert.deepEqual(advertisement.map((record) => dnsRecordType(record)), [ DNS_TYPE_PTR, DNS_TYPE_SRV, DNS_TYPE_TXT, DNS_TYPE_A ]);

    // The arms an advertisement does not carry, read back off the wire so what is being typed is a parsed record rather than the literal that was composed.
    const extras = expectMessage(encodeDnsMessage({ answers: [ makeAaaaRecord({ address: "2001:db8::1", name: "gdo.local", ttl: 300 }),
      makeOtherRecord({ name: "gdo.local", rdata: Buffer.from([ 1, 2, 3 ]), ttl: 300, type: 99 }) ], response: true }), "the extra records");

    assert.deepEqual(extras.answers.map((record) => dnsRecordType(record)), [ DNS_TYPE_AAAA, 99 ]);
  });
});

describe("parseIpv4 / parseIpv6 - the address grammar", () => {

  test("A1: read a dotted quad and an RFC 4291 text address into their bytes", () => {

    assert.deepEqual([...parseIpv4("192.0.2.1")], [ 192, 0, 2, 1 ]);
    assert.deepEqual([...parseIpv6("fe80::1")], [ 0xFE, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 ]);
    assert.deepEqual([...parseIpv6("::")], new Array<number>(16).fill(0));
    assert.deepEqual([...parseIpv6("2001:DB8::1")], [ 0x20, 0x01, 0x0D, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 ], "a capital hexadecimal digit must read the same");
  });

  test("A2: refuse what the wire cannot carry with a TypeError naming the reader and the address", () => {

    // The readers are public so the record builders check an address at construction through the grammar the encoder writes from; the refusal names the reader,
    // and a zone suffix and a dotted tail both read as a group that is not hexadecimal.
    const cases: readonly (readonly [string, () => Buffer, RegExp])[] = [
      [ "a three-octet address", (): Buffer => parseIpv4("1.2.3"), /^parseIpv4: the address "1\.2\.3" is not four decimal octets\.$/ ],
      [ "an octet over 255", (): Buffer => parseIpv4("256.1.1.1"),
        /^parseIpv4: the address "256\.1\.1\.1" carries "256", which is not a decimal octet from 0 to 255\.$/ ],
      [ "a hexadecimal octet", (): Buffer => parseIpv4("0x1.2.3.4"), /^parseIpv4: the address "0x1\.2\.3\.4" carries "0x1", which is not a decimal octet/ ],
      [ "a zone suffix", (): Buffer => parseIpv6("fe80::50%en0"), /^parseIpv6: the address "fe80::50%en0" carries "50%en0", which is not a hexadecimal group\.$/ ],
      [ "a dotted tail", (): Buffer => parseIpv6("::ffff:192.0.2.1"),
        /^parseIpv6: the address "::ffff:192\.0\.2\.1" carries "192\.0\.2\.1", which is not a hexadecimal group\.$/ ],
      [ "two abbreviations", (): Buffer => parseIpv6("1::2::3"), /^parseIpv6: the address "1::2::3" carries more than one "::"\.$/ ],
      [ "too few groups", (): Buffer => parseIpv6("1:2:3"), /^parseIpv6: the address "1:2:3" does not expand to 8 groups\.$/ ],
      [ "too many groups", (): Buffer => parseIpv6("1:2:3:4:5:6:7:8:9"), /^parseIpv6: the address "1:2:3:4:5:6:7:8:9" does not expand to 8 groups\.$/ ],
      [ "an abbreviation standing for nothing", (): Buffer => parseIpv6("1:2:3:4::5:6:7:8"), /^parseIpv6: the address "1:2:3:4::5:6:7:8" does not expand to 8 groups\.$/ ]
    ];

    for(const [ what, read, message ] of cases) {

      assert.throws(read, { message, name: "TypeError" }, what + " must be refused by the reader that read it");
    }
  });
});

describe("parseDnsMessage - the header", () => {

  test("P1: reads the id and the two surfaced flag bits", () => {

    const response = expectMessage(makeHeader({ flags: 0x8400, id: 0x1234 }), "a bare response header");

    assert.equal(response.id, 4660);
    assert.equal(response.response, true);
    assert.equal(response.truncated, false);
    assert.deepEqual(response.questions, []);
    assert.deepEqual(response.answers, []);
    assert.deepEqual(response.authorities, []);
    assert.deepEqual(response.additionals, []);

    const truncated = expectMessage(makeHeader({ flags: 0x0200 }), "a truncated query header");

    assert.equal(truncated.truncated, true);
    assert.equal(truncated.response, false);
  });

  test("P5: rejects a nonzero OPCODE or RCODE", () => {

    // RFC 6762 sections 18.3 and 18.11 tell a querier to ignore both, which for a reader is a rejection rather than a partial reading.
    assert.equal(parseDnsMessage(makeHeader({ flags: 0x0800 })), null);
    assert.equal(parseDnsMessage(makeHeader({ flags: 0x8003 })), null);
  });

  test("P11: rejects a section count with no bytes behind it, without reserving anything on the strength of the claim", () => {

    assert.equal(parseDnsMessage(makeHeader({ answers: 65535 })), null);
  });
});

describe("parseDnsMessage - name compression", () => {

  test("P2: follows the RFC 1035 section 4.1.4 example, including a chain of two pointers", () => {

    /* The example transposed into a question section. The first name is spelled in full at offset 12; the second is a label and a pointer to it; the third is a
     * pointer into the middle of the first; the fourth is the root; and the fifth is a bare pointer to the second, which reaches the first through it.
     */
    const first = labels("F", "ISI", "ARPA");
    const datagram = makeDatagram(makeHeader({ questions: 5 }), makeQuestion(first), makeQuestion(makeDatagram([ 3, 0x46, 0x4F, 0x4F ], pointer(12))),
      makeQuestion(pointer(18)), makeQuestion(Buffer.from([0])), makeQuestion(pointer(28)));
    const message = expectMessage(datagram, "the RFC 1035 example");

    assert.deepEqual(expectAt(message.questions, 0, "the full name").name, [ "F", "ISI", "ARPA" ]);
    assert.deepEqual(expectAt(message.questions, 1, "a label plus a pointer").name, [ "FOO", "F", "ISI", "ARPA" ]);
    assert.deepEqual(expectAt(message.questions, 2, "a pointer into a name").name, ["ARPA"]);
    assert.deepEqual(expectAt(message.questions, 3, "the root").name, []);
    assert.deepEqual(expectAt(message.questions, 4, "a two-hop chain").name, [ "FOO", "F", "ISI", "ARPA" ]);
  });

  test("P12: reads a name of exactly 255 wire bytes", () => {

    // 64 + 64 + 64 + 62 label bytes plus the terminator is 255 exactly, the largest wire form the format allows.
    const name = labels(repeat(63), repeat(63), repeat(63), repeat(61));

    assert.equal(name.length, 255);

    const message = expectMessage(makeDatagram(makeHeader({ questions: 1 }), makeQuestion(name)), "a 255-byte name");

    assert.deepEqual(expectAt(message.questions, 0, "the longest legal name").name, [ repeat(63), repeat(63), repeat(63), repeat(61) ]);
  });
});

describe("parseDnsMessage - records", () => {

  test("P3: reads back everything the encoder wrote, for one record of every kind", () => {

    const init = {

      additionals: [ makeTxtRecord({ name: "inst._x._tcp.local", strings: [ "a=1", "b" ] }),
        makeOtherRecord({ name: "x.local", rdata: Buffer.from([ 1, 2, 3 ]), type: 47 }) ],
      answers: [ makeARecord({ address: "10.0.0.5", name: "host.local" }), makeAaaaRecord({ address: "fe80::1", name: "host.local" }) ],
      authorities: [ makePtrRecord({ name: "_x._tcp.local", target: "inst._x._tcp.local" }),
        makeSrvRecord({ flush: true, name: "inst._x._tcp.local", port: 8080, priority: 1, target: "host.local", weight: 2 }) ],
      questions: [{ name: [ "_x", "_tcp", "local" ], type: DNS_TYPE_PTR, unicastResponse: true }]
    };

    const message = expectMessage(encodeDnsMessage(init), "a message carrying every record kind");

    assert.equal(message.id, 0);
    assert.equal(message.response, false);
    assert.equal(message.truncated, false);
    assert.deepEqual(message.questions, init.questions);
    assert.deepEqual(message.answers, init.answers);
    assert.deepEqual(message.authorities, init.authorities);
    assert.deepEqual(message.additionals, init.additionals);
  });

  test("P4: reads the top class bit as flush on a record and as unicastResponse on a question, and nowhere else", () => {

    const flushed = expectMessage(makeDatagram(makeHeader({ answers: 1 }), makeRecord({ classField: 0x8001, name: labels("x"), type: 99 })), "a flushed record");
    const plain = expectMessage(makeDatagram(makeHeader({ answers: 1 }), makeRecord({ classField: 0x0001, name: labels("x"), type: 99 })), "a plain record");

    assert.equal(expectAt(flushed.answers, 0, "the flushed record").flush, true);
    assert.equal(expectAt(plain.answers, 0, "the plain record").flush, false);

    const unicast = expectMessage(makeDatagram(makeHeader({ questions: 1 }), makeQuestion(labels("x"), DNS_TYPE_PTR, 0x8001)), "a unicast question");
    const multicast = expectMessage(makeDatagram(makeHeader({ questions: 1 }), makeQuestion(labels("x"), DNS_TYPE_PTR, 0x0001)), "a multicast question");

    assert.equal(expectAt(unicast.questions, 0, "the unicast question").unicastResponse, true);
    assert.equal(expectAt(multicast.questions, 0, "the multicast question").unicastResponse, false);
  });

  test("P8: ignores bytes after the last record", () => {

    const answers = [makeARecord({ address: "10.0.0.5", name: "host.local" })];
    const clean = makeResponse({ answers });
    const padded = expectMessage(makeDatagram(clean, [ 0xDE, 0xAD, 0xBE, 0xEF ]), "a padded response");

    assert.deepEqual(padded, expectMessage(clean, "the unpadded response"));
  });

  test("P9: hands back rdata and TXT strings as views over the datagram", () => {

    /* The message is copied into a Buffer.alloc-backed buffer before it is parsed, because Buffer.alloc never draws on the shared pool. A copied rdata could
     * otherwise land in the same ArrayBuffer by allocation coincidence and the row would pass without proving anything.
     */
    const encoded = makeResponse({ answers: [ makeOtherRecord({ name: "x.local", rdata: Buffer.from([ 1, 2, 3 ]), type: 99 }),
      makeTxtRecord({ name: "x.local", strings: ["abc"] }) ] });
    const datagram = Buffer.alloc(encoded.length);

    encoded.copy(datagram);

    const message = expectMessage(datagram, "a response carrying an other and a TXT record");
    const other = expectAt(message.answers, 0, "the other record");
    const text = expectAt(message.answers, 1, "the TXT record");

    assert.equal(other.kind, "other");
    assert.equal(text.kind, "txt");

    // The kind was asserted just above, so each cast below narrows to that arm's own shape rather than testing it. The name is 9 bytes at offset 12 and the
    // fixed fields are 10, so the first record's rdata begins at 31; the second name is a 2-byte pointer, so its rdata begins at 46 and its first string's
    // bytes at 47.
    assert.equal((other as { rdata: Buffer }).rdata.buffer, datagram.buffer);
    assert.equal((other as { rdata: Buffer }).rdata.byteOffset, datagram.byteOffset + 31);

    const strings = (text as { strings: readonly Buffer[] }).strings;

    assert.equal(expectAt(strings, 0, "the first string").buffer, datagram.buffer);
    assert.equal(expectAt(strings, 0, "the first string").byteOffset, datagram.byteOffset + 47);
  });

  test("P10: decompresses a name inside SRV rdata", () => {

    const encoded = makeResponse({ answers: [makeSrvRecord({ name: [ "svc", "local" ], port: 80, target: [ "host", "local" ] })] });

    /* The owner name is 11 bytes at offset 12 and the fixed fields are 10, so the rdata begins at 33: priority, weight, and port fill 33 through 38, the target's
     * `host` label fills 39 through 43, and the pointer at the target's `local` suffix begins at 44 and names the owner name's own `local` label at 16.
     */
    assert.equal(encoded.readUInt16BE(44), 0xC000 | 16, "the SRV target's shared suffix must be written as a pointer");

    const message = expectMessage(encoded, "an SRV response");
    const record = expectAt(message.answers, 0, "the SRV record");

    assert.equal(record.kind, "srv");
    assert.deepEqual((record as { target: readonly string[] }).target, [ "host", "local" ]);
  });

  test("P13: reads a whole service advertisement back with every name in full", () => {

    const answers = makeServiceRecords({ addresses: ["192.168.1.20"], host: "gateway", instance: "Living Room", port: 8080, serviceType: "_hap._tcp" });
    const encoded = makeResponse({ answers });

    /* The PTR's owner name is 17 bytes at offset 12 and its fixed fields are 10, so its rdata begins at 39 with the `Living Room` label. The SRV's owner name is
     * therefore a pointer to 39, which reaches the service name through the pointer that follows that label - a two-hop chain.
     */
    assert.equal(encoded.readUInt16BE(53), 0xC000 | 39, "the SRV's owner name must point into the PTR's rdata");

    const message = expectMessage(encoded, "a service advertisement");
    const instance = [ "Living Room", "_hap", "_tcp", "local" ];
    const service = [ "_hap", "_tcp", "local" ];
    const host = [ "gateway", "local" ];

    // The TXT record went out carrying no strings, which the wire spells as the single empty string RFC 6763 section 6.1 calls for, so it reads back as one.
    assert.deepEqual(message.answers, [

      makePtrRecord({ name: service, target: instance }), makeSrvRecord({ name: instance, port: 8080, target: host }),
      makeTxtRecord({ name: instance, strings: [Buffer.alloc(0)] }), makeARecord({ address: "192.168.1.20", name: host })
    ]);

    assert.deepEqual(answers.map((record) => record.name), [ service, instance, instance, host ]);
  });

  test("P14: reads a hand-assembled response, field by field", () => {

    /* Written as bytes rather than built by the encoder, so the row proves the reader against the wire itself rather than against the writer beside it. Offsets
     * referenced below: the question's name at 12 with its `local` label at 20, the PTR's rdata (and its `inst` label) at 43, and the SRV's target `host` label
     * at 68.
     */
    const datagram = Buffer.from([

      // Header: id 1, flags 0x8400 (a response, authoritative), one question, four answers.
      0x00, 0x01, 0x84, 0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00,

      // Question at 12: _x._tcp.local, type PTR, class IN.
      0x02, 0x5F, 0x78, 0x04, 0x5F, 0x74, 0x63, 0x70, 0x05, 0x6C, 0x6F, 0x63, 0x61, 0x6C, 0x00, 0x00, 0x0C, 0x00, 0x01,

      // Answer 1 at 31: a PTR on the question's name (a pointer to 12), ttl 4500, rdata the label `inst` and a pointer back to 12.
      0xC0, 0x0C, 0x00, 0x0C, 0x00, 0x01, 0x00, 0x00, 0x11, 0x94, 0x00, 0x07, 0x04, 0x69, 0x6E, 0x73, 0x74, 0xC0, 0x0C,

      // Answer 2 at 50: an SRV on the instance name (a pointer to the `inst` label at 43), ttl 120, priority 1, weight 2, port 8080, target host.local spelled
      // as the label `host` and a pointer to the `local` label at 20.
      0xC0, 0x2B, 0x00, 0x21, 0x00, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x0D, 0x00, 0x01, 0x00, 0x02, 0x1F, 0x90, 0x04, 0x68, 0x6F, 0x73, 0x74, 0xC0, 0x14,

      // Answer 3 at 75: a TXT on the instance name, ttl 4500, carrying the strings `a=1` and `b`.
      0xC0, 0x2B, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x11, 0x94, 0x00, 0x06, 0x03, 0x61, 0x3D, 0x31, 0x01, 0x62,

      // Answer 4 at 93: an A on host.local (a pointer to the SRV's target at 68), ttl 120, address 10.0.0.5.
      0xC0, 0x44, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x04, 0x0A, 0x00, 0x00, 0x05
    ]);

    const message = expectMessage(datagram, "the hand-assembled response");
    const instance = [ "inst", "_x", "_tcp", "local" ];

    assert.equal(message.id, 1);
    assert.equal(message.response, true);
    assert.equal(message.truncated, false);
    assert.deepEqual(message.questions, [{ name: [ "_x", "_tcp", "local" ], type: DNS_TYPE_PTR, unicastResponse: false }]);
    assert.deepEqual(message.answers, [

      { flush: false, kind: "ptr", name: [ "_x", "_tcp", "local" ], target: instance, ttl: 4500 },
      { flush: false, kind: "srv", name: instance, port: 8080, priority: 1, target: [ "host", "local" ], ttl: 120, weight: 2 },
      { flush: false, kind: "txt", name: instance, strings: [ Buffer.from("a=1"), Buffer.from("b") ], ttl: 4500 },
      { address: "10.0.0.5", flush: false, kind: "a", name: [ "host", "local" ], ttl: 120 }
    ]);
  });

  test("P16: reads a TXT record with an empty rdata as zero strings", () => {

    /* Spelled by hand because the encoder cannot produce it: a record carrying no strings goes out as the single empty string RFC 6763 section 6.1 calls for,
     * so the reader's rdlength-zero path is reachable only from a responder that sends one. It reads as zero strings rather than as a rejection.
     */
    const datagram = makeDatagram(makeHeader({ answers: 1 }), makeRecord({ name: labels("x", "local"), ttl: 4500, type: DNS_TYPE_TXT }));
    const message = expectMessage(datagram, "a TXT record whose rdata is empty");
    const record = expectAt(message.answers, 0, "the TXT record");

    assert.deepEqual(record, { flush: false, kind: "txt", name: [ "x", "local" ], strings: [], ttl: 4500 });
    assert.equal(txtEntries(record as never).size, 0);
  });
});

describe("parseDnsMessage - malformed input", () => {

  test("P6: rejects every malformed shape with null, never a throw and never a hang", () => {

    const name = labels("x", "local");

    // The ping-pong vector: an `other` record whose rdata is two pointers aimed at each other, then a record whose name is a pointer to the first of the pair.
    // The second hop's target lies after the offset that hop was read from, so the walk rejects it; a walk comparing every target against the name's own start
    // instead would follow the pair forever.
    const pingPong = makeDatagram(makeHeader({ answers: 2 }), makeRecord({ name: Buffer.from([0]), rdata: makeDatagram(pointer(25), pointer(23)), type: 99 }),
      makeRecord({ name: pointer(23), type: 99 }));

    const vectors: readonly (readonly [string, Buffer])[] = [

      [ "a header one byte short", makeHeader().subarray(0, 11) ],
      [ "a question count with no bytes behind it", makeHeader({ questions: 1 }) ],
      [ "a question whose type and class run past the end", makeDatagram(makeHeader({ questions: 1 }), name, [ 0x00, 0x0C ]) ],
      [ "an rdlength that runs past the end", makeDatagram(makeHeader({ answers: 1 }), makeRecord({ name, rdlength: 4, type: 99 })) ],
      [ "a pointer to its own name's start", makeDatagram(makeHeader({ answers: 1 }), makeRecord({ name: pointer(12), type: 99 })) ],
      [ "a pointer forward", makeDatagram(makeHeader({ answers: 1 }), makeRecord({ name: makeDatagram([ 1, 0x78 ], pointer(20)), type: 99 })) ],
      [ "a label loop", makeDatagram(makeHeader({ answers: 1 }), makeRecord({ name: makeDatagram([ 1, 0x78 ], pointer(12)), type: 99 })) ],
      [ "a pair of pointers aimed at each other", pingPong ],
      [ "an unsupported label type", makeDatagram(makeHeader({ answers: 1 }), makeRecord({ name: makeDatagram([ 0x40, 0x78, 0x00 ]), type: 99 })) ],
      [ "a name of 256 wire bytes", makeDatagram(makeHeader({ questions: 1 }),
        makeQuestion(labels(repeat(63), repeat(63), repeat(63), repeat(62)))) ],
      [ "an A record of five rdata bytes", makeDatagram(makeHeader({ answers: 1 }),
        makeRecord({ name, rdata: Buffer.alloc(5), type: DNS_TYPE_A })) ],
      [ "an AAAA record of fifteen rdata bytes", makeDatagram(makeHeader({ answers: 1 }),
        makeRecord({ name, rdata: Buffer.alloc(15), type: DNS_TYPE_AAAA })) ],
      [ "an SRV record of five rdata bytes", makeDatagram(makeHeader({ answers: 1 }),
        makeRecord({ name, rdata: Buffer.alloc(5), type: DNS_TYPE_SRV })) ],
      [ "a PTR whose target ends before its rdata does", makeDatagram(makeHeader({ answers: 1 }),
        makeRecord({ name, rdata: makeDatagram(labels("a"), [0x00]), type: DNS_TYPE_PTR })) ],
      [ "an SRV whose target ends before its rdata does", makeDatagram(makeHeader({ answers: 1 }),
        makeRecord({ name, rdata: makeDatagram(Buffer.alloc(6), labels("a"), [0x00]), type: DNS_TYPE_SRV })) ],
      [ "a TXT string that overruns its rdata", makeDatagram(makeHeader({ answers: 1 }),
        makeRecord({ name, rdata: makeDatagram([ 1, 0x61, 9, 0x62 ]), type: DNS_TYPE_TXT })) ]
    ];

    for(const [ what, datagram ] of vectors) {

      assert.equal(parseDnsMessage(datagram), null, what + " must read as null");
    }
  });

  test("P7: never throws on any prefix or any single-byte corruption of a well-formed message", () => {

    // A query carrying known answers is the shape that exercises the question walk and every record arm in one datagram, which `makeResponse` cannot build
    // because it writes no question.
    const datagram = encodeDnsMessage({

      additionals: [makeOtherRecord({ name: "x.local", rdata: Buffer.from([ 1, 2, 3 ]), type: 99 })],
      answers: [ makeARecord({ address: "10.0.0.5", name: "host.local" }), makeAaaaRecord({ address: "fe80::1", name: "host.local" }),
        makePtrRecord({ name: "_x._tcp.local", target: "inst._x._tcp.local" }) ],
      authorities: [ makeSrvRecord({ name: "inst._x._tcp.local", port: 8080, target: "host.local" }),
        makeTxtRecord({ name: "inst._x._tcp.local", strings: [ "a=1", "b" ] }) ],
      questions: [{ name: [ "_x", "_tcp", "local" ], type: DNS_TYPE_PTR, unicastResponse: false }]
    });

    for(let length = 0; length < datagram.length; length++) {

      assert.doesNotThrow(() => parseDnsMessage(datagram.subarray(0, length)), "a prefix of " + length.toString() + " bytes must not throw");
    }

    for(let index = 0; index < datagram.length; index++) {

      const corrupted = Buffer.from(datagram);

      corrupted.writeUInt8(0xFF, index);
      assert.doesNotThrow(() => parseDnsMessage(corrupted), "byte " + index.toString() + " replaced by 0xFF must not throw");
    }
  });
});

describe("encodeDnsMessage - the header and the flags", () => {

  test("E1: writes id 0 and no flag bit by default, QR and AA on a response, and TC on a truncated message", () => {

    const empty = encodeDnsMessage({});

    assert.equal(empty.length, 12);
    assert.deepEqual(empty, Buffer.alloc(12));

    const response = encodeDnsMessage({ id: 7, response: true });

    // RFC 6762 section 18.4: a multicast response is authoritative by definition, so QR and AA go out together.
    assert.equal(response.readUInt16BE(2), 0x8400);
    assert.equal(response.readUInt16BE(0), 7);
    assert.equal(encodeDnsMessage({ truncated: true }).readUInt16BE(2), 0x0200);
  });
});

describe("encodeDnsMessage - name compression", () => {

  test("E2: points at the longest suffix already written", () => {

    const repeated = encodeDnsMessage({ questions: [ { name: [ "a", "b", "c" ], type: DNS_TYPE_PTR, unicastResponse: false },
      { name: [ "a", "b", "c" ], type: DNS_TYPE_PTR, unicastResponse: false } ] });

    // The first name occupies 12 through 18 and its type and class 19 through 22, so the second name begins at 23 and is the whole name as a pointer to 12.
    assert.deepEqual(repeated.subarray(23, 25), Buffer.from([ 0xC0, 0x0C ]));

    const suffix = encodeDnsMessage({ questions: [ { name: [ "a", "b", "c" ], type: DNS_TYPE_PTR, unicastResponse: false },
      { name: [ "b", "c" ], type: DNS_TYPE_PTR, unicastResponse: false } ] });

    // The `b` label of the first name sits at 14, and the second name shares exactly that suffix.
    assert.deepEqual(suffix.subarray(23, 25), Buffer.from([ 0xC0, 0x0E ]));

    const partial = encodeDnsMessage({ questions: [ { name: [ "a", "b", "c" ], type: DNS_TYPE_PTR, unicastResponse: false },
      { name: [ "x", "b", "c" ], type: DNS_TYPE_PTR, unicastResponse: false } ] });

    assert.deepEqual(partial.subarray(23, 27), Buffer.from([ 0x01, 0x78, 0xC0, 0x0E ]));
  });

  test("E3: preserves a name's case through encode and parse", () => {

    const message = expectMessage(makeResponse({ answers: [makeARecord({ address: "10.0.0.5", name: [ "MyPrinter", "local" ] })] }), "a mixed-case name");

    assert.deepEqual(expectAt(message.answers, 0, "the record").name, [ "MyPrinter", "local" ]);
  });

  test("E4: never points at the root, and never points at an offset a 14-bit pointer cannot reach", () => {

    const roots = encodeDnsMessage({ questions: [ { name: [], type: DNS_TYPE_PTR, unicastResponse: false },
      { name: [], type: DNS_TYPE_PTR, unicastResponse: false } ] });

    // A pointer costs two bytes to say what the one-byte root already says, so the root is written out both times.
    assert.equal(roots.readUInt8(12), 0x00);
    assert.equal(roots.readUInt8(17), 0x00);

    /* The boundary itself, proven from both sides. A first record on `[ "a", "b" ]` puts its name at 12 and its rdata at 27; sizing that rdata places the second
     * record's name at exactly the pointer limit in one message and at the last reachable offset in the other. The third record repeats the second's name, and
     * whether it is written out or pointed at is the whole question.
     */
    const far = [ "far", "away" ];
    const beyond = encodeDnsMessage({ answers: [ makeOtherRecord({ name: [ "a", "b" ], rdata: Buffer.alloc(16357), type: 99 }),
      makeOtherRecord({ name: far, rdata: Buffer.alloc(0), type: 99 }), makeOtherRecord({ name: far, rdata: Buffer.alloc(0), type: 99 }) ] });

    assert.equal(beyond.readUInt8(16384), 0x03, "a name at the pointer limit must be written out by the name that repeats it");
    assert.equal(beyond.readUInt8(16404), 0x03);

    const within = encodeDnsMessage({ answers: [ makeOtherRecord({ name: [ "a", "b" ], rdata: Buffer.alloc(16356), type: 99 }),
      makeOtherRecord({ name: far, rdata: Buffer.alloc(0), type: 99 }), makeOtherRecord({ name: far, rdata: Buffer.alloc(0), type: 99 }) ] });

    assert.equal(within.readUInt8(16383), 0x03);
    assert.deepEqual(within.subarray(16403, 16405), Buffer.from([ 0xFF, 0xFF ]), "the last reachable offset must still be pointed at");

    for(const [ what, datagram ] of [ [ "beyond", beyond ], [ "within", within ] ] as const) {

      const message = expectMessage(datagram, "the " + what + " message");

      assert.deepEqual(expectAt(message.answers, 1, "the second record").name, far);
      assert.deepEqual(expectAt(message.answers, 2, "the third record").name, far);
    }
  });

  test("E8: keys a suffix so a label carrying a dot or a space never matches two labels", () => {

    for(const label of [ "Living.Room", "Living Room" ]) {

      const datagram = encodeDnsMessage({ questions: [ { name: [ label, "local" ], type: DNS_TYPE_PTR, unicastResponse: false },
        { name: [ "Living", "Room", "local" ], type: DNS_TYPE_PTR, unicastResponse: false } ] });

      // The first name is 19 bytes at offset 12 with its `local` label at 24, so the second name begins at 35 and must be its own two labels plus a pointer at
      // that shared suffix - never a pointer to the first name's start, which a key joining labels with a dot or a space would have produced.
      assert.deepEqual(datagram.subarray(35, 49), Buffer.concat([ Buffer.from([6]), Buffer.from("Living"), Buffer.from([4]), Buffer.from("Room"),
        Buffer.from([ 0xC0, 0x18 ]) ]), "the second name after a label of \"" + label + "\"");

      const message = expectMessage(datagram, "a message carrying \"" + label + "\"");

      assert.deepEqual(expectAt(message.questions, 0, "the first name").name, [ label, "local" ]);
      assert.deepEqual(expectAt(message.questions, 1, "the second name").name, [ "Living", "Room", "local" ]);
    }
  });
});

describe("encodeDnsMessage - rdata", () => {

  test("E5: writes a TXT record carrying no strings as the single empty string", () => {

    const datagram = encodeDnsMessage({ answers: [makeTxtRecord({ name: "x.local" })] });

    // The name is 9 bytes at offset 12, so the rdlength field sits at 29 and the rdata at 31.
    assert.equal(datagram.readUInt16BE(29), 1);
    assert.equal(datagram.readUInt8(31), 0x00);

    const message = expectMessage(datagram, "an empty TXT record");
    const record = expectAt(message.answers, 0, "the TXT record");

    assert.equal(record.kind, "txt");
    assert.deepEqual((record as { strings: readonly Buffer[] }).strings, [Buffer.alloc(0)]);
    assert.equal(txtEntries(record as never).size, 0);
  });

  test("E7: round-trips every address through the RFC 5952 presentation", () => {

    const message = expectMessage(makeResponse({ answers: [makeARecord({ address: "192.168.1.10", name: "host.local" })] }), "an A record");

    assert.equal((expectAt(message.answers, 0, "the A record") as { address: string }).address, "192.168.1.10");

    /* The tie vector matters most: `2001:db8:0:0:1:0:0:1` carries two runs of two zero groups, and section 4.2 gives the compression to the first. The single
     * zero group of `1:0:1:1:1:1:1:1` is never compressed at all, and a capital in the input comes back lowercase.
     */
    const vectors: readonly (readonly [string, string])[] = [ [ "fe80::1", "fe80::1" ], [ "::", "::" ], [ "::1", "::1" ], [ "1::", "1::" ],
      [ "1:0:1:1:1:1:1:1", "1:0:1:1:1:1:1:1" ], [ "2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1" ], [ "2001:DB8::1", "2001:db8::1" ] ];

    for(const [ written, read ] of vectors) {

      const parsed = expectMessage(makeResponse({ answers: [makeAaaaRecord({ address: written, name: "host.local" })] }), "an AAAA record of " + written);

      assert.equal((expectAt(parsed.answers, 0, "the AAAA record") as { address: string }).address, read, written + " must present as " + read);
    }
  });

  test("E6: throws an Error naming the value for anything the wire cannot carry", () => {

    const name = "host.local";
    const cases: readonly (readonly [string, () => Buffer, RegExp])[] = [

      [ "a 64-byte label", (): Buffer => encodeDnsMessage({ questions: [{ name: [repeat(64)], type: DNS_TYPE_PTR, unicastResponse: false }] }), /64 bytes, over the 63/ ],
      [ "an empty label", (): Buffer => encodeDnsMessage({ questions: [{ name: [ "", "local" ], type: DNS_TYPE_PTR, unicastResponse: false }] }), /empty label/ ],
      [ "a 256-byte name", (): Buffer => encodeDnsMessage({ questions: [{ name: [ repeat(63), repeat(63), repeat(63), repeat(62) ], type: DNS_TYPE_PTR,
        unicastResponse: false }] }), /256 wire bytes, over the 255/ ],
      [ "a 256-byte TXT string", (): Buffer => encodeDnsMessage({ answers: [makeTxtRecord({ name, strings: ["b".repeat(256)] })] }), /256 bytes, over the 255/ ],
      // The address rows compose their records literally, so what they prove is the encoder's own reach into the readers: a builder refuses these at construction.
      [ "a three-octet address", (): Buffer => encodeDnsMessage({ answers: [{ address: "1.2.3", flush: false, kind: "a", name: parseDnsName(name), ttl: 120 }] }),
        /"1\.2\.3" is not four decimal octets/ ],
      [ "an octet over 255", (): Buffer => encodeDnsMessage({ answers: [{ address: "256.1.1.1", flush: false, kind: "a", name: parseDnsName(name), ttl: 120 }] }),
        /carries "256"/ ],
      [ "an empty group", (): Buffer => encodeDnsMessage({ answers: [{ address: "fe80:::1", flush: false, kind: "aaaa", name: parseDnsName(name), ttl: 120 }] }),
        /"fe80:::1" carries "", which is not a hexadecimal group/ ],
      [ "a dotted tail", (): Buffer => encodeDnsMessage({ answers: [{ address: "::ffff:192.168.1.1", flush: false, kind: "aaaa", name: parseDnsName(name),
        ttl: 120 }] }), /carries "192\.168\.1\.1"/ ],
      [ "two abbreviations", (): Buffer => encodeDnsMessage({ answers: [{ address: "1::2::3", flush: false, kind: "aaaa", name: parseDnsName(name), ttl: 120 }] }),
        /"1::2::3" carries more than one/ ],
      [ "too few groups", (): Buffer => encodeDnsMessage({ answers: [{ address: "1:2:3", flush: false, kind: "aaaa", name: parseDnsName(name), ttl: 120 }] }),
        /"1:2:3" does not expand to 8 groups/ ],
      [ "an other record wearing a modeled type", (): Buffer => encodeDnsMessage({ answers: [makeOtherRecord({ name, rdata: Buffer.alloc(0), type: DNS_TYPE_PTR })] }),
        /names the type 12/ ]
    ];

    for(const [ what, encode, message ] of cases) {

      assert.throws(encode, { message }, what + " must throw an Error naming the value");
    }
  });

  test("E9: encodes and reads back the largest label, name, and TXT string the wire allows", () => {

    const name = [ repeat(63), repeat(63), repeat(63), repeat(61) ];
    const longest = "z".repeat(255);
    const strings = [longest];
    const message = expectMessage(makeResponse({ answers: [makeTxtRecord({ name, strings })] }), "the largest legal shapes");
    const record = expectAt(message.answers, 0, "the TXT record");

    assert.deepEqual(record.name, name);
    assert.deepEqual((record as { strings: readonly Buffer[] }).strings, [Buffer.from(longest)]);
  });

  test("P15: writes a datagram this row spells out byte for byte", () => {

    /* Predicted by hand from the layouts rather than captured from the encoder, so the row would fail if the writer's field order, endianness, or ttl width ever
     * moved. Header, then the owner name as labels, then type, class, ttl, rdlength, and the four address octets.
     */
    const a = encodeDnsMessage({ answers: [makeARecord({ address: "10.0.0.5", name: "host.local" })], id: 1, response: true });

    assert.deepEqual(a, Buffer.from([

      0x00, 0x01, 0x84, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x04, 0x68, 0x6F, 0x73, 0x74, 0x05, 0x6C, 0x6F, 0x63, 0x61, 0x6C, 0x00,
      0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x04, 0x0A, 0x00, 0x00, 0x05
    ]));

    /* A target that shares no suffix with the owner name, so the SRV rdata carries no pointer at all. Priority, weight, and port are all different from one
     * another, so the three fixed fields cannot be permuted without disagreeing with the bytes spelled below.
     */
    const srv = encodeDnsMessage({ answers: [makeSrvRecord({ name: ["a"], port: 8080, priority: 1, target: ["b"], weight: 2 })] });

    assert.deepEqual(srv, Buffer.from([

      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x01, 0x61, 0x00, 0x00, 0x21, 0x00, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x09,
      0x00, 0x01, 0x00, 0x02, 0x1F, 0x90, 0x01, 0x62, 0x00
    ]));
  });
});

describe("buildMdnsQuery - the RFC 6762 known-answer split", () => {

  // The browse question every query row below asks.
  const question = { name: [ "_hap", "_tcp", "local" ], type: DNS_TYPE_PTR, unicastResponse: false };

  // A known answer under the browsed service name, sized by its target's instance label.
  function knownAnswer(instance: string, flush = false): DnsRecord {

    return makePtrRecord({ flush, name: [ "_hap", "_tcp", "local" ], target: [ instance, "_hap", "_tcp", "local" ] });
  }

  test("Q1: writes one packet with id 0, no flag bit, and the class field the question asked for", () => {

    const packets = buildMdnsQuery({ questions: [question] });
    const only = expectAt(packets, 0, "the only packet");

    assert.equal(packets.length, 1);
    assert.equal(only.readUInt16BE(0), 0);
    assert.equal(only.readUInt16BE(2), 0);
    assert.equal(only.readUInt16BE(4), 1);
    assert.equal(only.readUInt16BE(6), 0);

    // The class field follows the name, which is 17 bytes at offset 12, and the two type bytes after it.
    assert.equal(only.readUInt16BE(31), 0x0001);

    const unicast = expectAt(buildMdnsQuery({ questions: [{ ...question, unicastResponse: true }] }), 0, "the unicast packet");

    assert.equal(unicast.readUInt16BE(31), 0x8001);
  });

  test("Q2: clears the cache-flush bit on every known answer", () => {

    const packets = buildMdnsQuery({ knownAnswers: [ knownAnswer("one"), knownAnswer("two", true), knownAnswer("three") ], questions: [question] });
    const only = expectAt(packets, 0, "the only packet");

    assert.equal(packets.length, 1);
    assert.equal(only.readUInt16BE(6), 3);
    assert.equal((only.readUInt16BE(2) & 0x0200), 0);

    // RFC 6762 section 10.2 forbids the bit in a known-answer list, so the record built with it set must go out without it. Each answer's owner name is the
    // two-byte pointer the writer compressed it to, so the class field sits four bytes past the name's start.
    let offset = 33;

    for(let index = 0; index < 3; index++) {

      assert.equal(only.readUInt16BE(offset + 4), 0x0001, "answer " + index.toString() + " must carry the Internet class alone");
      offset += 12 + only.readUInt16BE(offset + 10);
    }
  });

  test("Q3: splits across packets, setting TC on every packet but the last and carrying the questions only in the first", () => {

    const answers = Array.from({ length: 8 }, (_, index) => knownAnswer("instance" + index.toString()));
    const packets = buildMdnsQuery({ knownAnswers: answers, limit: 120, questions: [question] });
    const delivered: DnsRecord[] = [];

    assert.ok(packets.length >= 2, "eight answers under a 120-byte limit must not fit one packet");

    for(const [ index, packet ] of packets.entries()) {

      const message = expectMessage(packet, "packet " + index.toString());

      assert.ok(packet.length <= 120, "packet " + index.toString() + " must fit the limit");
      assert.equal(message.truncated, index < (packets.length - 1), "packet " + index.toString() + " must carry TC only if another follows");
      assert.equal(message.questions.length, (index === 0) ? 1 : 0, "only the first packet carries the questions");
      delivered.push(...message.answers);
    }

    // A miscounted answer count fails one way or the other: too many claimed and the packet parses null, too few and an answer never reaches this list.
    assert.deepEqual(delivered, answers);
  });

  test("Q4: opens a second packet for an answer that fits an empty packet but not beside the question", () => {

    const packets = buildMdnsQuery({ knownAnswers: [knownAnswer("inst")], limit: 50, questions: [question] });

    assert.equal(packets.length, 2);

    const first = expectMessage(expectAt(packets, 0, "the first packet"), "the first packet");
    const second = expectMessage(expectAt(packets, 1, "the second packet"), "the second packet");

    assert.equal(first.answers.length, 0);
    assert.equal(first.truncated, true);
    assert.equal(first.questions.length, 1);
    assert.equal(second.questions.length, 0);
    assert.equal(second.truncated, false);
    assert.deepEqual(second.answers, [knownAnswer("inst")]);
  });

  test("Q5: omits an answer that fits no packet, and serves the one after it from a rewound writer", () => {

    /* The middle answer's target is what overflows: it fits neither beside the first answer nor in a packet of its own. The first answer's owner name differs
     * from the other two, so the third answer's name is the first occurrence of `[ "b", "local" ]` that survives - and it must be written out in full. A reset
     * that kept its suffix map would hand it the omitted answer's offset, which the reset has vacated.
     */
    const first = makePtrRecord({ name: [ "a", "local" ], target: [ "one", "local" ] });
    const middle = makePtrRecord({ name: [ "b", "local" ], target: [ repeat(60), repeat(60), repeat(60), "local" ] });
    const last = makePtrRecord({ name: [ "b", "local" ], target: [ "three", "local" ] });
    const packets = buildMdnsQuery({ knownAnswers: [ first, middle, last ], limit: 100, questions: [] });

    assert.equal(packets.length, 2);

    const second = expectAt(packets, 1, "the second packet");

    assert.equal(second.readUInt8(12), 0x01, "the surviving answer's name must be written out, never pointed at its own start");
    assert.deepEqual(expectMessage(expectAt(packets, 0, "the first packet"), "the first packet").answers, [first]);
    assert.deepEqual(expectMessage(second, "the second packet").answers, [last]);
  });

  test("Q6: keeps every packet its own compression scope", () => {

    const answers = [ knownAnswer("one"), knownAnswer("two"), knownAnswer("three") ];
    const packets = buildMdnsQuery({ knownAnswers: answers, limit: 60, questions: [] });

    assert.equal(packets.length, 3);

    for(const [ index, packet ] of packets.entries()) {

      // A pointer reaches only within the packet that carries it, so a packet that borrowed an offset from its predecessor would not parse on its own.
      assert.deepEqual(expectMessage(packet, "packet " + index.toString()).answers, [expectAt(answers, index, "the answer")]);
    }
  });

  test("Q7: refuses a limit the questions themselves do not fit", () => {

    assert.throws(() => buildMdnsQuery({ limit: 20, questions: [question] }), { message: /33 bytes, over the packet limit of 20/ });
  });

  test("Q8: omits two consecutive answers that fit no packet and serves the one after them", () => {

    /* The first two answers each overflow a packet of their own, so each is dropped, and the second one is dropped without closing the packet the first one
     * already emptied - an empty packet has nothing to send. The third answer is then served from that same packet, so the whole list costs two packets rather
     * than one per refusal.
     */
    const answers = [ knownAnswer(repeat(60)), knownAnswer(repeat(61)), knownAnswer("three") ];
    const packets = buildMdnsQuery({ knownAnswers: answers, limit: 100, questions: [question] });

    assert.equal(packets.length, 2);

    const first = expectMessage(expectAt(packets, 0, "the first packet"), "the first packet");
    const second = expectMessage(expectAt(packets, 1, "the second packet"), "the second packet");

    assert.equal(first.questions.length, 1);
    assert.equal(first.truncated, true);
    assert.equal(first.answers.length, 0);
    assert.equal(second.questions.length, 0);
    assert.equal(second.truncated, false);
    assert.deepEqual(second.answers, [expectAt(answers, 2, "the answer that fits")]);

    for(const [ index, packet ] of packets.entries()) {

      assert.ok(packet.length <= 100, "packet " + index.toString() + " must fit the limit");
    }
  });
});

describe("txtEntries - the RFC 6763 key-value reading", () => {

  // Read a TXT record built from the given strings.
  function entriesOf(...strings: readonly string[]): ReadonlyMap<string, string | null> {

    return txtEntries(makeTxtRecord({ name: "x.local", strings }));
  }

  test("T1: tells a flag, an empty value, a value, and an absent key apart", () => {

    const entries = entriesOf("flag", "empty=", "key=value");

    assert.equal(entries.get("flag"), null);
    assert.equal(entries.get("empty"), "");
    assert.equal(entries.get("key"), "value");
    assert.equal(entries.has("absent"), false);
  });

  test("T2: takes the first occurrence of a repeated key", () => {

    assert.equal(entriesOf("k=first", "k=second").get("k"), "first");
  });

  test("T3: folds a key to lowercase", () => {

    const entries = entriesOf("PaperSize=A4");

    assert.equal(entries.get("papersize"), "A4");
    assert.equal(entries.has("PaperSize"), false);
  });

  test("T4: ignores a string whose key is missing", () => {

    const entries = entriesOf("=x", "k=v");

    assert.deepEqual([...entries.keys()], ["k"]);
  });

  test("T5: ignores an empty string", () => {

    const entries = entriesOf("", "k=v");

    assert.deepEqual([...entries.keys()], ["k"]);
  });

  test("T6: keeps every byte after the first equals sign, spaces and further equals signs included", () => {

    assert.equal(entriesOf("k= a=b ").get("k"), " a=b ");
  });

  test("T7: decodes a value as UTF-8", () => {

    assert.equal(entriesOf("k=héllo").get("k"), "héllo");
  });
});
