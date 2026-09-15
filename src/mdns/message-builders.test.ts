/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/message-builders.test.ts: Unit tests for the DNS record and response builders in message-builders.ts. Builders earn the same enumerated-criteria coverage
 * as production code per the testing convention - every default, every accepted name spelling, every record of a service advertisement - because the suites that
 * consume them, here and in every consumer's tests, silently lose their meaning if a builder drifts from the DNS-SD shape it encodes.
 */
import { describe, test } from "node:test";
import { makeARecord, makeAaaaRecord, makeOtherRecord, makePtrRecord, makeResponse, makeServiceRecords, makeSrvRecord,
  makeTxtRecord } from "./message-builders.ts";
import assert from "node:assert/strict";
import { expectAt } from "../testing/index.ts";
import { parseDnsMessage } from "./message.ts";

describe("the record factories", () => {

  test("B1: answer their kind, their recommended ttl, and the defaults every optional field carries", () => {

    // RFC 6762 section 10 recommends 120 seconds where a name or an rdata names a host and 75 minutes everywhere else, so an A, an AAAA, an SRV, and a record of
    // an unmodeled type default to the short ttl while a PTR and a TXT default to the long one.
    const a = makeARecord({ address: "10.0.0.5", name: "host.local" });
    const aaaa = makeAaaaRecord({ address: "fe80::1", name: "host.local" });
    const other = makeOtherRecord({ name: "host.local", rdata: Buffer.from([1]), type: 99 });
    const ptr = makePtrRecord({ name: "_x._tcp.local", target: "inst._x._tcp.local" });
    const srv = makeSrvRecord({ name: "inst._x._tcp.local", port: 8080, target: "host.local" });
    const txt = makeTxtRecord({ name: "inst._x._tcp.local" });

    assert.deepEqual([ a.kind, aaaa.kind, other.kind, ptr.kind, srv.kind, txt.kind ], [ "a", "aaaa", "other", "ptr", "srv", "txt" ]);
    assert.deepEqual([ a.ttl, aaaa.ttl, other.ttl, srv.ttl ], [ 120, 120, 120, 120 ]);
    assert.deepEqual([ ptr.ttl, txt.ttl ], [ 4500, 4500 ]);
    assert.deepEqual([ a.flush, aaaa.flush, other.flush, ptr.flush, srv.flush, txt.flush ], [ false, false, false, false, false, false ]);
    assert.deepEqual([ srv.priority, srv.weight ], [ 0, 0 ]);
    assert.deepEqual(txt.strings, []);

    // The cache-flush bit is asked for the same way on every factory.
    assert.deepEqual([ makeARecord({ address: "10.0.0.5", flush: true, name: "host.local" }).flush,
      makeAaaaRecord({ address: "fe80::1", flush: true, name: "host.local" }).flush,
      makeOtherRecord({ flush: true, name: "host.local", rdata: Buffer.alloc(0), type: 99 }).flush,
      makePtrRecord({ flush: true, name: "_x._tcp.local", target: "i._x._tcp.local" }).flush,
      makeSrvRecord({ flush: true, name: "i._x._tcp.local", port: 1, target: "host.local" }).flush,
      makeTxtRecord({ flush: true, name: "i._x._tcp.local" }).flush ], [ true, true, true, true, true, true ]);

    // A string name is read through the production parser; an array is taken as the labels it already is, so a label carrying a dot needs no escaping.
    assert.deepEqual(a.name, [ "host", "local" ]);
    assert.deepEqual(ptr.target, [ "inst", "_x", "_tcp", "local" ]);
    assert.deepEqual(makeARecord({ address: "10.0.0.5", name: [ "Living.Room", "local" ] }).name, [ "Living.Room", "local" ]);
    assert.deepEqual(makePtrRecord({ name: [ "a", "b" ], target: [ "c", "d" ] }).target, [ "c", "d" ]);
    assert.deepEqual([ makeSrvRecord({ name: "i.local", port: 1, priority: 3, target: "h.local", ttl: 7, weight: 9 }).priority,
      makeSrvRecord({ name: "i.local", port: 1, priority: 3, target: "h.local", ttl: 7, weight: 9 }).weight ], [ 3, 9 ]);
    assert.equal(makeSrvRecord({ name: "i.local", port: 1, target: "h.local", ttl: 7 }).ttl, 7);
  });

  test("B2: encode a string entry as UTF-8 and pass a Buffer entry through untouched", () => {

    const binary = Buffer.from([ 0x00, 0xFF, 0x7F ]);
    const record = makeTxtRecord({ name: "i.local", strings: [ "héllo", binary ] });

    assert.deepEqual(expectAt(record.strings, 0, "the text entry"), Buffer.from("héllo", "utf8"));
    assert.equal(expectAt(record.strings, 1, "the binary entry"), binary, "a Buffer entry must reach the record without a copy");
  });

  test("B5: makeAaaaRecord refuses a zone suffix, a dotted tail, and a malformed group with a TypeError naming the reader and the address", () => {

    // The builder reads the address through the encoder's own reader at construction, so the spelling the browser attaches to a link-local address it reports,
    // the RFC 4291 mixed tail, and a malformed group are each refused at the call that supplied them and never reach the encoder.
    const cases: readonly (readonly [string, string, RegExp])[] = [
      [ "a zone suffix", "fe80::50%en0", /^parseIpv6: the address "fe80::50%en0" carries "50%en0", which is not a hexadecimal group\.$/ ],
      [ "a dotted tail", "::ffff:192.0.2.1", /^parseIpv6: the address "::ffff:192\.0\.2\.1" carries "192\.0\.2\.1", which is not a hexadecimal group\.$/ ],
      [ "an empty group", "fe80:::1", /^parseIpv6: the address "fe80:::1" carries "", which is not a hexadecimal group\.$/ ]
    ];

    for(const [ what, address, message ] of cases) {

      assert.throws(() => makeAaaaRecord({ address, name: "host.local" }), { message, name: "TypeError" }, what + " must be refused at construction");
    }
  });

  test("B6: makeARecord refuses anything but four decimal octets with a TypeError naming the reader and the address", () => {

    assert.throws(() => makeARecord({ address: "1.2.3", name: "host.local" }), { message: /^parseIpv4: the address "1\.2\.3" is not four decimal octets\.$/,
      name: "TypeError" }, "a three-octet address must be refused at construction");
    assert.throws(() => makeARecord({ address: "256.1.1.1", name: "host.local" }),
      { message: /^parseIpv4: the address "256\.1\.1\.1" carries "256", which is not a decimal octet from 0 to 255\.$/, name: "TypeError" },
      "an octet over 255 must be refused at construction");
  });
});

describe("makeResponse", () => {

  test("B3: encodes its sections as a response the parser reads back", () => {

    const answer = makeARecord({ address: "10.0.0.5", name: "host.local" });
    const additional = makeTxtRecord({ name: "i._x._tcp.local", strings: ["md=x"] });
    const message = parseDnsMessage(makeResponse({ additionals: [additional], answers: [answer] }));

    assert.ok(message !== null, "the response must parse");
    assert.equal(message.response, true);
    assert.deepEqual(message.answers, [answer]);
    assert.deepEqual(message.additionals, [additional]);
    assert.deepEqual(message.questions, []);
    assert.deepEqual(message.authorities, []);
  });
});

describe("makeServiceRecords", () => {

  test("B4: answers the PTR, SRV, TXT, and A of one instance, flushing only the unique three", () => {

    const service = [ "_hap", "_tcp", "local" ];
    const instance = [ "Living Room", "_hap", "_tcp", "local" ];
    const host = [ "gateway", "local" ];
    const records = makeServiceRecords({ addresses: ["192.168.1.20"], host: "gateway", instance: "Living Room", port: 8080, serviceType: "_hap._tcp",
      strings: ["md=x"] });

    assert.deepEqual(records, [ makePtrRecord({ name: service, target: instance }), makeSrvRecord({ name: instance, port: 8080, target: host }),
      makeTxtRecord({ name: instance, strings: ["md=x"] }), makeARecord({ address: "192.168.1.20", name: host }) ]);

    // A PTR is a shared record, and RFC 6762 section 10.2 reserves the cache-flush bit for the records one responder owns outright, so `flush` reaches the other
    // three and never the PTR.
    const flushed = makeServiceRecords({ addresses: ["192.168.1.20"], flush: true, host: "gateway", instance: "Living Room", port: 8080,
      serviceType: "_hap._tcp", strings: ["md=x"] });

    assert.deepEqual(flushed.map((record) => record.flush), [ false, true, true, true ]);

    const elsewhere = makeServiceRecords({ addresses: ["192.168.1.20"], domain: "example.org", host: "gateway", instance: "Living Room", port: 8080,
      serviceType: "_hap._tcp" });

    assert.deepEqual(elsewhere.map((record) => record.name), [ [ "_hap", "_tcp", "example", "org" ], [ "Living Room", "_hap", "_tcp", "example", "org" ],
      [ "Living Room", "_hap", "_tcp", "example", "org" ], [ "gateway", "example", "org" ] ]);
  });

  test("K1: the address record is an AAAA or an A, by the spelling of the address it was given", () => {

    // The address says which record carries it: a spelling with a colon is IPv6, so the choice is read off the address rather than an option a caller has to set.
    const sixteenByte = expectAt(makeServiceRecords({ addresses: ["fe80::1"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp" }), 3,
      "the address record of an IPv6 advertisement");

    assert.ok(sixteenByte.kind === "aaaa");
    assert.equal(sixteenByte.address, "fe80::1");

    const fourByte = expectAt(makeServiceRecords({ addresses: ["10.0.0.5"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp" }), 3,
      "the address record of an IPv4 advertisement");

    assert.ok(fourByte.kind === "a");
    assert.equal(fourByte.address, "10.0.0.5");
  });

  test("K2: the family is chosen by the colon, so a malformed IPv6 spelling is refused by the IPv6 reader and never read as a dotted quad", () => {

    // A zone suffix reaches the AAAA builder and is refused there, and a malformed IPv6 spelling is refused by the IPv6 reader with the message that explains it
    // rather than routed to the A builder and refused as a dotted quad that is not four octets.
    assert.throws(() => makeServiceRecords({ addresses: ["fe80::50%en0"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp" }),
      { message: /^parseIpv6: the address "fe80::50%en0" carries "50%en0"/, name: "TypeError" }, "a zone suffix must be refused through the advertisement");
    assert.throws(() => makeServiceRecords({ addresses: ["fe80:::1"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp" }),
      { message: /^parseIpv6: the address "fe80:::1" carries ""/, name: "TypeError" }, "a malformed IPv6 spelling must be refused by the IPv6 reader");
  });

  test("K3: every address named is an address record of its own, in the order they were given and each of its own address's family", () => {

    const host = [ "gdo", "local" ];
    const records = makeServiceRecords({ addresses: [ "10.0.0.5", "fe80::1" ], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp" });

    // A dual-stack host advertises an address record per address under one host name, which RFC 6762 section 6.2 has a responder attach to the same name for
    // fate sharing. The order is the order they were named, and each address's own spelling is what chooses the record that carries it.
    assert.deepEqual(records.slice(3), [ makeARecord({ address: "10.0.0.5", name: host }), makeAaaaRecord({ address: "fe80::1", name: host }) ]);
  });

  test("K4: an instance named with no address at all is its PTR, SRV, and TXT alone", () => {

    const records = makeServiceRecords({ addresses: [], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp" });

    // A responder that attaches no address record is exactly what RFC 6763 section 12 has a client ask about by name, and this is the advertisement of one.
    assert.deepEqual(records.map((record) => record.kind), [ "ptr", "srv", "txt" ]);
  });
});
