/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/message-builders.test.ts: Unit tests for the DNS record and response builders in message-builders.ts. Builders earn the same enumerated-criteria coverage
 * as production code per the testing convention - every default, every accepted name spelling, every record of a service advertisement - because the suites that
 * consume them, here and in every consumer's tests, silently lose their meaning if a builder drifts from the DNS-SD shape it encodes.
 */
import { describe, test } from "node:test";
import { makeARecord, makeAaaaRecord, makeOtherRecord, makePtrRecord, makeResponse, makeServiceRecords, makeSrvRecord, makeTxtRecord,
  makeTxtStrings } from "./message-builders.ts";
import { parseDnsMessage, txtEntries } from "./message.ts";
import type { Nullable } from "../util.ts";
import assert from "node:assert/strict";
import { expectAt } from "../testing/index.ts";

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
    const cases: readonly (readonly [string, RegExp])[] = [
      [ "fe80::50%en0", /^parseIpv6: the address "fe80::50%en0" carries "50%en0", which is not a hexadecimal group\.$/ ],
      [ "::ffff:192.0.2.1", /^parseIpv6: the address "::ffff:192\.0\.2\.1" carries "192\.0\.2\.1", which is not a hexadecimal group\.$/ ],
      [ "fe80:::1", /^parseIpv6: the address "fe80:::1" carries "", which is not a hexadecimal group\.$/ ]
    ];

    for(const [ address, message ] of cases) {

      assert.throws(() => makeAaaaRecord({ address, name: "host.local" }), { constructor: TypeError, message });
    }
  });

  test("B6: makeARecord refuses anything but four decimal octets with a TypeError naming the reader and the address", () => {

    assert.throws(() => makeARecord({ address: "1.2.3", name: "host.local" }), { constructor: TypeError,
      message: /^parseIpv4: the address "1\.2\.3" is not four decimal octets\.$/ });
    assert.throws(() => makeARecord({ address: "256.1.1.1", name: "host.local" }),
      { constructor: TypeError, message: /^parseIpv4: the address "256\.1\.1\.1" carries "256", which is not a decimal octet from 0 to 255\.$/ });
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
    const records = makeServiceRecords({ addresses: ["192.168.1.20"], host: "gateway", instance: "Living Room", port: 8080, serviceType: "_hap._tcp.local",
      strings: ["md=x"] });

    assert.deepEqual(records, [ makePtrRecord({ name: service, target: instance }), makeSrvRecord({ name: instance, port: 8080, target: host }),
      makeTxtRecord({ name: instance, strings: ["md=x"] }), makeARecord({ address: "192.168.1.20", name: host }) ]);

    // A PTR is a shared record, and RFC 6762 section 10.2 reserves the cache-flush bit for the records one responder owns outright, so `flush` reaches the other
    // three and never the PTR.
    const flushed = makeServiceRecords({ addresses: ["192.168.1.20"], flush: true, host: "gateway", instance: "Living Room", port: 8080,
      serviceType: "_hap._tcp.local", strings: ["md=x"] });

    assert.deepEqual(flushed.map((record) => record.flush), [ false, true, true, true ]);

    const elsewhere = makeServiceRecords({ addresses: ["192.168.1.20"], host: "gateway", instance: "Living Room", port: 8080,
      serviceType: "_hap._tcp.example.org" });

    assert.deepEqual(elsewhere.map((record) => record.name), [ [ "_hap", "_tcp", "example", "org" ], [ "Living Room", "_hap", "_tcp", "example", "org" ],
      [ "Living Room", "_hap", "_tcp", "example", "org" ], [ "gateway", "example", "org" ] ]);
  });

  test("K1: the address record is an AAAA or an A, by the spelling of the address it was given", () => {

    // The address says which record carries it: a spelling with a colon is IPv6, so the choice is read off the address rather than an option a caller has to set.
    const sixteenByte = expectAt(makeServiceRecords({ addresses: ["fe80::1"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp.local" }), 3,
      "the address record of an IPv6 advertisement");

    assert.ok(sixteenByte.kind === "aaaa");
    assert.equal(sixteenByte.address, "fe80::1");

    const fourByte = expectAt(makeServiceRecords({ addresses: ["10.0.0.5"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp.local" }), 3,
      "the address record of an IPv4 advertisement");

    assert.ok(fourByte.kind === "a");
    assert.equal(fourByte.address, "10.0.0.5");
  });

  test("K2: the family is chosen by the colon, so a malformed IPv6 spelling is refused by the IPv6 reader and never read as a dotted quad", () => {

    // A zone suffix reaches the AAAA builder and is refused there, and a malformed IPv6 spelling is refused by the IPv6 reader with the message that explains it
    // rather than routed to the A builder and refused as a dotted quad that is not four octets.
    assert.throws(() => makeServiceRecords({ addresses: ["fe80::50%en0"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp.local" }),
      { constructor: TypeError, message: /^parseIpv6: the address "fe80::50%en0" carries "50%en0"/ });
    assert.throws(() => makeServiceRecords({ addresses: ["fe80:::1"], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp.local" }),
      { constructor: TypeError, message: /^parseIpv6: the address "fe80:::1" carries ""/ });
  });

  test("K3: every address named is an address record of its own, in the order they were given and each of its own address's family", () => {

    const host = [ "gdo", "local" ];
    const records = makeServiceRecords({ addresses: [ "10.0.0.5", "fe80::1" ], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp.local" });

    // A dual-stack host advertises an address record per address under one host name, which RFC 6762 section 6.2 has a responder attach to the same name for
    // fate sharing. The order is the order they were named, and each address's own spelling is what chooses the record that carries it.
    assert.deepEqual(records.slice(3), [ makeARecord({ address: "10.0.0.5", name: host }), makeAaaaRecord({ address: "fe80::1", name: host }) ]);
  });

  test("K4: an instance named with no address at all is its PTR, SRV, and TXT alone", () => {

    const records = makeServiceRecords({ addresses: [], host: "gdo", instance: "x", port: 1, serviceType: "_hap._tcp.local" });

    // A responder that attaches no address record is exactly what RFC 6763 section 12 has a client ask about by name, and this is the advertisement of one.
    assert.deepEqual(records.map((record) => record.kind), [ "ptr", "srv", "txt" ]);
  });

  test("K5: a service type spelled without its domain is refused, naming the builder and the spelling it was given", () => {

    // The label floor is the rule production enforces at MdnsBrowser's own constructor, through the same shared predicate, so a domain-stripped spelling is
    // refused at the call rather than building a PTR whose name carries no domain at all.
    assert.throws(() => makeServiceRecords({ addresses: [], host: "x", instance: "y", port: 1, serviceType: "_hap._tcp" }),
      { constructor: TypeError,
        message: /^makeServiceRecords: `serviceType` must be a DNS-SD service type such as "_esphomelib\._tcp\.local", and "_hap\._tcp" is not\.$/ });
  });

  test("K6: a subtype-form service type is refused, since the domain labels are read positionally after the transport", () => {

    // A subtype form carries five labels and clears the label floor, so nothing but its own guard stops its second label, `_sub`, from being read as the
    // transport and a domain no responder ever advertised from being fabricated. A suite that wants a subtype PTR builds that record by hand instead.
    assert.throws(() => makeServiceRecords({ addresses: [], host: "x", instance: "y", port: 1, serviceType: "_printer._sub._http._tcp.local" }),
      { constructor: TypeError,
        message: /^makeServiceRecords: `serviceType` must be a base DNS-SD service type such as "_esphomelib\._tcp\.local" - name, transport, domain, and/ });
  });

  test("K6b: a base type whose transport is _udp is accepted and its records built, since the guard admits either transport", () => {

    // RFC 6763's service-type grammar admits a UDP transport as well as a TCP one, so the guard above compares the second label against each spelling rather
    // than assuming TCP. This row is the accepting side of that comparison: a guard narrowed to TCP alone would refuse a service this fixture must build.
    const records = makeServiceRecords({ addresses: [], host: "sleeper", instance: "Proxy", port: 5353, serviceType: "_sleep-proxy._udp.local" });
    const ptr = expectAt(records, 0, "the PTR of a _udp advertisement");
    const srv = expectAt(records, 1, "the SRV of a _udp advertisement");

    assert.deepEqual(ptr.name, [ "_sleep-proxy", "_udp", "local" ], "the PTR is owned by the service type exactly as it was spelled");
    assert.ok(srv.kind === "srv");
    assert.deepEqual(srv.target, [ "sleeper", "local" ], "the host sits under the domain labels read off the service type's own tail");
  });
});

describe("makeTxtStrings", () => {

  test("K7: encodes each of the three value states, omits an undefined field, and emits the object's own key order", () => {

    // RFC 6763 section 6.4 splits a string on its first `=`, so the three states a consumer can advertise are a value, an empty value, and a bare flag with
    // no `=` at all. An undefined field is the fourth case and is not a state on the wire: it is absent.
    assert.deepEqual(makeTxtStrings({ mac: "aabbccddeeff" }), ["mac=aabbccddeeff"], "a string value carries its key and an equals sign");
    assert.deepEqual(makeTxtStrings({ note: "" }), ["note="], "an empty string value is a key written with nothing after the equals sign");
    assert.deepEqual(makeTxtStrings({ flag: null }), ["flag"], "a null value is the wire's flag form, the bare key alone");
    assert.deepEqual(makeTxtStrings({ mac: "aabbccddeeff", skip: undefined }), ["mac=aabbccddeeff"], "an undefined field is omitted, not written as a flag");
    assert.deepEqual(makeTxtStrings({}), [], "an object with no fields at all advertises nothing");

    /* The fields are built from an ordered entry list rather than written as one object literal: the order they are inserted in is precisely what this row
     * distinguishes, and a literal here would be held to alphabetical key order, which is the order the row exists to prove the output is NOT.
     */
    const unsorted: Partial<Record<string, Nullable<string>>> = Object.fromEntries([ [ "zebra", "z" ], [ "mac", null ], [ "empty", "" ] ] as const);

    assert.deepEqual(makeTxtStrings(unsorted), [ "zebra=z", "mac", "empty=" ], "the object's own key order reaches the wire");
  });

  test("K8: refuses the two keys RFC 6763 section 6.4 cannot express, naming the key it was given", () => {

    assert.throws(() => makeTxtStrings({ "": "x" }),
      { constructor: TypeError, message: /^makeTxtStrings: a TXT key must be non-empty and contain no "=", and "" is not\.$/ });
    assert.throws(() => makeTxtStrings({ "a=b": "x" }),
      { constructor: TypeError, message: /^makeTxtStrings: a TXT key must be non-empty and contain no "=", and "a=b" is not\.$/ });
  });

  test("K9: a mixed-case key is legitimate wire content, and only the read side folds it", () => {

    assert.deepEqual(makeTxtStrings({ MAC: "aabbccddeeff" }), ["MAC=aabbccddeeff"], "the case a caller wrote survives onto the wire");

    // The fold to lowercase is txtEntries' own RFC 6762 section 16 rule applied at the read, not something this builder does to what it was handed.
    assert.deepEqual(txtEntries(makeTxtRecord({ name: "i.local", strings: makeTxtStrings({ MAC: "aabbccddeeff" }) })),
      new Map([[ "mac", "aabbccddeeff" ]]), "the key folds to lowercase only when it is read back");
  });

  test("K10: is the inverse of txtEntries over a fields object whose keys are already lowercase", () => {

    /* The two are inverses up to key case, so a round trip is exact only when txtEntries' own fold is a no-op - which is what the lowercase keys here make
     * it. The property holds for a fields object carrying no undefined value: an undefined field is omitted by design rather than round-tripped.
     */
    const fields = { mac: "aabbccddeeff", model: null, note: "" };

    assert.deepEqual(txtEntries(makeTxtRecord({ name: "i.local", strings: makeTxtStrings(fields) })),
      new Map([ [ "mac", "aabbccddeeff" ], [ "model", null ], [ "note", "" ] ]), "every field reads back as the state it was written in");
  });
});
