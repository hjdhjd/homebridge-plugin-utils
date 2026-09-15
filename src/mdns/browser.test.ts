/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/browser.test.ts: Unit tests for the mDNS browser - the querying cadence and its spreads, known-answer suppression, what a response does to the cache,
 * the goodbye and cache-flush holds, per-record maintenance, active resolution, group membership across changing interfaces, and the lifecycle. Every row
 * drives one browser over a socket double on a virtual timeline, so what is asserted is what the browser put on the wire and what it derived from what came
 * back, never what a network happened to do.
 */
import { DNS_TYPE_A, DNS_TYPE_AAAA, DNS_TYPE_PTR, DNS_TYPE_SRV, DNS_TYPE_TXT, dnsNameKey, encodeDnsMessage, formatDnsName, parseDnsMessage,
  txtEntries } from "./message.ts";
import type { DnsMessage, DnsRecord } from "./message.ts";
import type { MdnsBrowserOptions, MdnsService } from "./browser.ts";
import type { TestBrowserRig, TestBrowserRigOptions, TestMdnsSend, TestMdnsSocket } from "./browser.helpers.ts";
import { TestMdnsSocketFactory, fixedInterfaces, makeBrowser } from "./browser.helpers.ts";
import { assertNoUnhandledRejections, capturingLog, expectAt, logCount, settle, silentLog } from "../testing/index.ts";
import { describe, test } from "node:test";
import { makeARecord, makeAaaaRecord, makePtrRecord, makeResponse, makeServiceRecords, makeSrvRecord, makeTxtRecord } from "./message-builders.ts";
import { HbpuAbortError } from "../util.ts";
import { MdnsBrowser } from "./browser.ts";
import type { NetworkInterfaceInfo } from "node:os";
import type { Nullable } from "../util.ts";
import { TestClock } from "../clock-double.ts";
import assert from "node:assert/strict";

// The type every row browses unless it says otherwise, and the same name as labels.
const SERVICE_TYPE = "_esphomelib._tcp.local";
const SERVICE_NAME = [ "_esphomelib", "_tcp", "local" ];

// Where a multicast query goes.
const GROUP = "224.0.0.251";

// Construction options that reach no network, for the rows that build a browser themselves rather than through the rig.
function baseOptions(overrides: Partial<MdnsBrowserOptions> = {}): MdnsBrowserOptions {

  return {

    interfaces: fixedInterfaces({ ipv4: ["192.0.2.1"] }),
    log: silentLog(),
    onEvent: (): void => undefined,
    random: (): number => 0,
    serviceType: SERVICE_TYPE,
    signal: new AbortController().signal,
    socketFactory: new TestMdnsSocketFactory().create,
    ...overrides
  };
}

// What a row varies about one instance's advertisement.
interface AdvertisementOptions {

  readonly address?: string;
  readonly host?: string;
  readonly instance?: string;
  readonly port?: number;
  readonly strings?: readonly string[];
}

// The same, with a lifetime for each record of it.
interface AgedAdvertisementOptions extends AdvertisementOptions {

  readonly addressTtl?: number;
  readonly ptrTtl?: number;
  readonly srvTtl?: number;
  readonly txtTtl?: number;
}

// The records one responder sends for one instance. Every field a row does not assert on is varied away from the builder's defaults, so a row that reads one
// cannot be passing on a default it never set.
function advertisement({ address = "192.0.2.50", host = "gdo", instance = "Garage Door", port = 6053,
  strings = ["mac=aabbccddeeff"] }: AdvertisementOptions = {}): readonly DnsRecord[] {

  return makeServiceRecords({ addresses: [address], host, instance, port, serviceType: "_esphomelib._tcp", strings });
}

// The same advertisement with a lifetime named for each record, which is what the rows about maintenance, goodbyes, and flushes turn on.
function advertisementAged({ address = "192.0.2.50", addressTtl = 120, host = "gdo", instance = "Garage Door", port = 6053, ptrTtl = 4500, srvTtl = 120,
  strings = ["mac=aabbccddeeff"], txtTtl = 4500 }: AgedAdvertisementOptions = {}): readonly DnsRecord[] {

  return [ makePtrRecord({ name: SERVICE_NAME, target: instanceName(instance), ttl: ptrTtl }),
    makeSrvRecord({ name: instanceName(instance), port, priority: 10, target: [ host, "local" ], ttl: srvTtl, weight: 5 }),
    makeTxtRecord({ name: instanceName(instance), strings, ttl: txtTtl }),
    makeARecord({ address, name: [ host, "local" ], ttl: addressTtl }) ];
}

/* The same instance advertised by a responder of the other family: the address record is an AAAA, and a row about what a resolution asks for leaves the address
 * out entirely by naming none.
 */
function advertisementAaaa({ address, addressTtl = 120, host = "gdo", instance = "Garage Door", port = 6053,
  strings = ["mac=aabbccddeeff"] }: AgedAdvertisementOptions = {}): readonly DnsRecord[] {

  const records: DnsRecord[] = [ makePtrRecord({ name: SERVICE_NAME, target: instanceName(instance), ttl: 4500 }),
    makeSrvRecord({ name: instanceName(instance), port, priority: 10, target: [ host, "local" ], ttl: 4500, weight: 5 }),
    makeTxtRecord({ name: instanceName(instance), strings, ttl: 4500 }) ];

  return (address === undefined) ? records : [ ...records, makeAaaaRecord({ address, name: [ host, "local" ], ttl: addressTtl }) ];
}

// The full name of an instance of the browsed type.
function instanceName(instance: string): string[] {

  return [ instance, ...SERVICE_NAME ];
}

/* Deliver one response, as a responder on the LAN would. A row names the source where the link a datagram arrived on is part of what it is proving, and
 * otherwise the double's own fixture source stands.
 */
function deliver(socket: TestMdnsSocket, records: readonly DnsRecord[], source?: string): void {

  const datagram = makeResponse({ answers: records });

  socket.emitMessage(datagram, (source === undefined) ? undefined : { address: source, family: "IPv6", port: 5353, size: datagram.length });
}

// A browser of the other family: the same rig, over links of that family and a socket asked for it. The link also carries an IPv4 address, which is the
// other-family entry the purity rows read.
async function makeIpv6Browser(overrides: Partial<MdnsBrowserOptions> = {}): Promise<TestBrowserRig> {

  return makeBrowser({ interfaces: fixedInterfaces({ ipv4: ["192.0.2.9"], ipv6: ["fe80::1"] }), ipFamilies: ["ipv6"], ...overrides });
}

// A browser over both families at once: one socket per family, over a host whose one link answers on both.
async function makeDualBrowser(overrides: Partial<MdnsBrowserOptions> & TestBrowserRigOptions = {}): Promise<TestBrowserRig> {

  return makeBrowser({ interfaces: fixedInterfaces({ ipv4: ["192.0.2.1"], ipv6: ["fe80::1"] }), ipFamilies: [ "ipv4", "ipv6" ], ...overrides });
}

// Read a datagram back through the production parser, which is also what proves the browser wrote something a reader can read.
function expectMessage(datagram: Buffer, description: string): DnsMessage {

  const message = parseDnsMessage(datagram);

  assert.ok(message, description + " must parse");

  return message;
}

// Step the clock to a moment, stopping at every deadline on the way so each timer fires at its own time, and answering every datagram sent between here
// and there.
function sentUntil(clock: TestClock, socket: TestMdnsSocket, at: number): readonly TestMdnsSend[] {

  const start = socket.sent.length;

  for(let next = clock.nextDeadline; (next !== null) && (next <= at); next = clock.nextDeadline) {

    clock.advanceToNext();
  }

  clock.advance(at - clock.now());

  return socket.sent.slice(start);
}

// What one deadline sent, having proved the run-up to it was quiet - which is how a row says a query lands exactly there rather than somewhere nearby.
function sentAt(clock: TestClock, socket: TestMdnsSocket, at: number, description: string): readonly TestMdnsSend[] {

  assert.equal(sentUntil(clock, socket, at - 1).length, 0, "nothing is sent before " + description);

  return sentUntil(clock, socket, at);
}

// Whether a datagram asks for a record of the named type.
function asksFor(datagram: Buffer, type: number): boolean {

  const message = parseDnsMessage(datagram);

  return message?.questions.some((question) => question.type === type) === true;
}

/* Walk the clock deadline by deadline up to a moment, answering the time of each datagram that matched. A row reads this where the deadlines it cares about are
 * interleaved with others - a browse cadence running underneath a resolution ladder, a maintenance checkpoint landing between two queries.
 */
function sendTimesUntil(rig: TestBrowserRig, until: number, matches: (datagram: Buffer) => boolean): number[] {

  const times: number[] = [];
  let index = rig.socket.sent.length;

  for(let next = rig.clock.nextDeadline; (next !== null) && (next <= until); next = rig.clock.nextDeadline) {

    rig.clock.advanceToNext();

    for(; index < rig.socket.sent.length; index++) {

      if(matches(expectAt(rig.socket.sent, index, "a datagram").datagram)) {

        times.push(rig.clock.now());
      }
    }
  }

  return times;
}

// Whether a datagram is the browsing question for the type this suite browses.
function isBrowseQuery(datagram: Buffer): boolean {

  const message = parseDnsMessage(datagram);

  return (message !== null) && !message.response && (message.questions.length === 1) &&
    (dnsNameKey(expectAt(message.questions, 0, "the question").name) === dnsNameKey(SERVICE_NAME)) &&
    (expectAt(message.questions, 0, "the question").type === DNS_TYPE_PTR);
}

// Every question one datagram asked, as a type and name pair a row can compare against.
function questionsOf(datagram: Buffer, description: string): { name: string; type: number }[] {

  return expectMessage(datagram, description).questions.map((question) => ({ name: formatDnsName(question.name), type: question.type }));
}

// The one service the browser currently holds, which is what most rows are about.
function onlyService(rig: TestBrowserRig): MdnsService {

  assert.equal(rig.browser.services.size, 1, "exactly one service is held");

  return expectAt([...rig.browser.services.values()], 0, "the service");
}

describe("MdnsBrowser - construction", () => {

  test("B1: the sockets are asked for the families the browser serves in the order named, both unless told otherwise, and a repeated family is refused", () => {

    const byDefault = new TestMdnsSocketFactory();
    const forIpv6 = new TestMdnsSocketFactory();
    const browsers = [ new MdnsBrowser(baseOptions({ socketFactory: byDefault.create })),
      new MdnsBrowser(baseOptions({ ipFamilies: ["ipv6"], socketFactory: forIpv6.create })) ];

    // A browser that names no family serves both, IPv4 first, and one that names a family is asked for that family alone.
    assert.deepEqual(byDefault.createCalls.map((call) => call.ipFamily), [ "ipv4", "ipv6" ]);
    assert.deepEqual(forIpv6.createCalls.map((call) => call.ipFamily), ["ipv6"]);

    // A second socket of one family would join the same group on the same links and cache every record of it twice. The tuple type refuses an empty list, and
    // a repetition is the one shape it cannot refuse, so the constructor does.
    assert.throws(() => new MdnsBrowser(baseOptions({ ipFamilies: [ "ipv4", "ipv4" ] })),
      (error: unknown) => (error instanceof TypeError) && error.message.includes("`ipFamilies`"));

    for(const browser of browsers) {

      browser.abort();
    }
  });

  test("B2: a name that is not a service type, and one the wire cannot carry, are both refused where the option was named", () => {

    // A type needs a name, a transport, and a domain. Two labels describe nothing a responder can answer, and the refusal names what it was given.
    assert.throws(() => new MdnsBrowser(baseOptions({ serviceType: "_esphomelib._tcp" })),
      (error: unknown) => (error instanceof TypeError) && error.message.includes("_esphomelib._tcp"));

    // A label the wire cannot carry is the encoder's refusal rather than the browser's, and it arrives at construction rather than inside the first timer.
    const longLabel = "_" + "a".repeat(64);

    assert.throws(() => new MdnsBrowser(baseOptions({ serviceType: longLabel + "._tcp.local" })),
      (error: unknown) => (error instanceof Error) && !(error instanceof TypeError) && error.message.includes(longLabel));
  });

  test("B3: a ceiling under the seed interval and a warmup that is not positive are each refused", () => {

    assert.throws(() => new MdnsBrowser(baseOptions({ ceilingMs: 999 })), (error: unknown) => (error instanceof TypeError) && error.message.includes("ceilingMs"));
    assert.throws(() => new MdnsBrowser(baseOptions({ ceilingMs: Number.POSITIVE_INFINITY })), TypeError);
    assert.throws(() => new MdnsBrowser(baseOptions({ warmupMs: 0 })), (error: unknown) => (error instanceof TypeError) && error.message.includes("warmupMs"));
    assert.throws(() => new MdnsBrowser(baseOptions({ warmupMs: Number.NaN })), TypeError);
  });
});

describe("MdnsBrowser - cadence", () => {

  test("B4: the browsing query is one PTR question, asked of the group, with the header a multicast query carries", async () => {

    const { clock, socket } = await makeBrowser();
    const first = expectAt(sentAt(clock, socket, 20, "the first query"), 0, "the first query");

    assert.equal(first.address, GROUP);
    assert.equal(first.port, 5353);

    const message = expectMessage(first.datagram, "the first query");

    // RFC 6762 sections 18.1 and 18.2: a query carries id 0 and no flag bit at all.
    assert.equal(message.id, 0);
    assert.equal(message.response, false);
    assert.equal(message.truncated, false);
    assert.equal(message.answers.length, 0);
    assert.deepEqual(questionsOf(first.datagram, "the first query"), [{ name: SERVICE_TYPE, type: DNS_TYPE_PTR }]);

    // RFC 6762 section 5.4: a browsing query never asks for a unicast response.
    assert.equal(expectAt(message.questions, 0, "the question").unicastResponse, false);
  });

  test("B5: the first query is spread over the window RFC 6762 section 5.2 names, and a fractional deadline is armed whole", async () => {

    const earliest = await makeBrowser({ random: (): number => 0 });

    assert.equal(sentAt(earliest.clock, earliest.socket, 20, "the earliest first query").length, 1);

    const latest = await makeBrowser({ random: (): number => 1 });

    assert.equal(sentAt(latest.clock, latest.socket, 120, "the latest first query").length, 1);

    // A deadline of 53.333 ms is armed at 54 rather than 53, so a wait is never served early.
    const fractional = await makeBrowser({ random: (): number => 1 / 3 });

    assert.equal(sentAt(fractional.clock, fractional.socket, 54, "the fractional first query").length, 1);
  });

  test("B6: the interval doubles from one second and stops at the ceiling", async () => {

    const { clock, socket } = await makeBrowser();

    for(const at of [ 20, 1020, 3020, 7020, 15020 ]) {

      assert.equal(sentAt(clock, socket, at, "the query at " + at.toString()).length, 1);
    }

    // The ceiling is what the doubling stops at, and every query after it keeps that interval.
    const capped = await makeBrowser({ ceilingMs: 5000 });

    for(const at of [ 20, 1020, 3020, 7020, 12020, 17020 ]) {

      assert.equal(sentAt(capped.clock, capped.socket, at, "the capped query at " + at.toString()).length, 1);
    }
  });

  test("B30: the warmup promise resolves the stated window after the first query, whether or not anything could be asked", async () => {

    const settledAt: number[] = [];
    const { browser, clock, socket } = await makeBrowser({ warmupMs: 10000 });

    void browser.settled.then(() => settledAt.push(clock.now()));

    assert.equal(sentAt(clock, socket, 20, "the first query").length, 1);

    clock.advance(9999);
    await settle();
    assert.deepEqual(settledAt, [], "the warmup is not over one millisecond early");

    clock.advance(1);
    await settle();
    assert.deepEqual(settledAt, [10020], "the warmup ends exactly one window after the first query");

    // A host with nowhere to ask still settles on time: the deadline is defined by the clock, and what a network could not be asked is said by the warning the
    // refresh writes rather than by a promise that never resolves.
    const log = capturingLog();
    const quiet = await makeBrowser({ interfaces: fixedInterfaces({}), log, warmupMs: 10000 });
    const quietSettledAt: number[] = [];

    void quiet.browser.settled.then(() => quietSettledAt.push(quiet.clock.now()));
    sentUntil(quiet.clock, quiet.socket, 10020);
    await settle();
    assert.deepEqual(quietSettledAt, [10020]);
    assert.equal(logCount(log.entries, "warn", "No network interface joined"), 1);
  });
});

describe("MdnsBrowser - known answers", () => {

  test("B7: a browsing query offers every cached PTR of the browsed name and nothing else", async () => {

    const { clock, socket } = await makeBrowser();

    assert.equal(sentAt(clock, socket, 20, "the first query").length, 1);

    deliver(socket, advertisement({ instance: "Garage Door" }));
    deliver(socket, advertisement({ address: "192.0.2.51", host: "shed", instance: "Shed Door", port: 6054, strings: ["mac=001122334455"] }));

    const query = expectMessage(expectAt(sentAt(clock, socket, 1020, "the second query"), 0, "the second query").datagram, "the second query");

    assert.equal(query.answers.length, 2, "both PTR records are offered as known answers, and no SRV, TXT, or address is");
    assert.deepEqual(query.answers.map((record) => (record.kind === "ptr") ? formatDnsName(record.target) : record.kind).sort(),
      [ "Garage Door._esphomelib._tcp.local", "Shed Door._esphomelib._tcp.local" ]);

    // RFC 6762 section 10.2 reserves the cache-flush bit for a record one responder owns, and section 7.2 has the query clear it on every known answer.
    assert.equal(query.answers.every((record) => !record.flush), true);
  });

  test("B8: a known answer is offered while at least half its lifetime remains, and left out once it is not", async () => {

    const { clock, socket } = await makeBrowser();

    assert.equal(sentAt(clock, socket, 20, "the first query").length, 1);

    // Two instances whose PTR records have different lifetimes, so one reaches exactly half at the query below and the other is well past it at the one after.
    deliver(socket, advertisementAged({ instance: "Halfway", ptrTtl: 6 }));
    deliver(socket, advertisementAged({ address: "192.0.2.51", host: "shed", instance: "Later", port: 6054, ptrTtl: 8 }));

    assert.equal(sentAt(clock, socket, 1020, "the query before the one at half").length, 1);

    const halfway = expectMessage(expectAt(sentAt(clock, socket, 3020, "the query at half"), 0, "the query at half").datagram, "the query at half");

    // RFC 6762 section 7.1 leaves out an answer with less than half its lifetime left. Exactly half is still offered: three seconds of six have passed.
    assert.equal(halfway.answers.length, 2);

    deliver(socket, advertisementAged({ address: "192.0.2.52", host: "barn", instance: "Fresh", port: 6055, ptrTtl: 100 }));

    sentUntil(clock, socket, 7019);

    const past = expectMessage(expectAt(sentUntil(clock, socket, 7020), 0, "the query past half").datagram, "the query past half");

    // Seven seconds of the eight-second record have passed, so it is left out although it is still cached; the record received two seconds ago is offered.
    assert.deepEqual(past.answers.map((record) => (record.kind === "ptr") ? formatDnsName(record.target) : record.kind),
      ["Fresh._esphomelib._tcp.local"]);
  });
});

describe("MdnsBrowser - receive", () => {

  test("B9: a response is read whatever its id says, a query is not read at all, and a known answer never becomes a cache entry", async () => {

    // RFC 6762 section 7.1: the answer section of another host's query is what that host already knows, never something to cache.
    const asQuery = await makeBrowser();

    asQuery.socket.emitMessage(encodeDnsMessage({ answers: advertisement(), id: 0, response: false }));
    assert.equal(asQuery.events.length, 0);
    assert.equal(asQuery.browser.services.size, 0);

    // RFC 6762 section 18.1: a response is read without regard to its id, and a querier caches what it carries.
    const asResponse = await makeBrowser();

    asResponse.socket.emitMessage(encodeDnsMessage({ answers: advertisement(), id: 4321, response: true }));
    assert.deepEqual(asResponse.events.map((event) => event.kind), ["found"]);

    /* The browser's own query, looped back by a reuse-bound socket, carries its cached PTR records as known answers. Feeding it back proves it changes nothing:
     * neither instance is refreshed, so both are still lost when the lifetimes they arrived with run out rather than a second later.
     */
    const loopback = await makeBrowser();
    const aged = [ makePtrRecord({ name: SERVICE_NAME, target: instanceName("First"), ttl: 10 }),
      makePtrRecord({ name: SERVICE_NAME, target: instanceName("Second"), ttl: 10 }) ];

    loopback.clock.advance(20);
    deliver(loopback.socket, [ ...aged, ...advertisement({ instance: "First" }).slice(1), ...advertisement({ address: "192.0.2.51", host: "shed",
      instance: "Second", port: 6054 }).slice(1) ]);
    assert.equal(loopback.browser.services.size, 2);

    const query = expectAt(sentAt(loopback.clock, loopback.socket, 1020, "the query carrying both known answers"), 0, "the query");

    assert.equal(expectMessage(query.datagram, "the query").answers.length, 2);
    loopback.socket.emitMessage(query.datagram);
    assert.deepEqual(loopback.events.map((event) => event.kind), [ "found", "found" ]);

    // The PTR records arrived at 20 ms with ten seconds to live, so both instances go at 10020 ms and nothing the loopback carried moved that.
    loopback.clock.advance(10019 - loopback.clock.now());
    assert.equal(loopback.browser.services.size, 2);
    loopback.clock.advance(1);
    assert.equal(loopback.browser.services.size, 0);
    assert.deepEqual(loopback.events.map((event) => event.kind), [ "found", "found", "lost", "lost" ]);
  });

  test("B10: a datagram that does not parse is dropped with a debug line naming where it came from", async () => {

    const log = capturingLog();
    const { browser, events, socket } = await makeBrowser({ log });

    socket.emitMessage(makeResponse({ answers: advertisement() }).subarray(0, 11));
    assert.deepEqual(events, []);
    assert.equal(browser.services.size, 0);
    assert.equal(logCount(log.entries, "debug", "Dropped an unreadable mDNS datagram from 192.0.2.10."), 1);
    assert.equal(log.entries.filter((entry) => entry.level !== "debug").length, 0, "nothing else is said about it");
  });

  test("B11: one full advertisement derives one service carrying what the responder sent", async () => {

    const rig = await makeBrowser();

    deliver(rig.socket, makeServiceRecords({ addresses: ["192.0.2.50"], host: "gdo", instance: "Garage Door", port: 6053, serviceType: "_esphomelib._tcp",
      strings: [ "mac=aabbccddeeff", "project_name=ratgdo.ratgdo" ] }));

    const found = expectAt(rig.events, 0, "the found event");

    assert.equal(rig.events.length, 1);
    assert.equal(found.kind, "found");

    const service = onlyService(rig);

    assert.equal(service.instance, "Garage Door");
    assert.equal(service.port, 6053);
    assert.deepEqual(service.host, [ "gdo", "local" ]);
    assert.deepEqual(service.addresses, ["192.0.2.50"]);
    assert.deepEqual(service.name, instanceName("Garage Door"));

    const entries = txtEntries(service.txt);

    assert.equal(entries.get("mac"), "aabbccddeeff");
    assert.equal(entries.get("project_name"), "ratgdo.ratgdo");

    // The snapshot is keyed by the folded instance name, which is the identity every event names.
    assert.equal(rig.browser.services.has(dnsNameKey(instanceName("Garage Door"))), true);
  });

  test("B12: what the cache keeps is a copy, so the datagram it came from can be reused underneath it", async () => {

    const rig = await makeBrowser();
    const datagram = makeResponse({ answers: advertisement({ strings: ["mac=aabbccddeeff"] }) });

    rig.socket.emitMessage(datagram);

    const service = onlyService(rig);

    // Node hands the same buffer to the next datagram it reads, so a cache holding views would change under a consumer that is still reading it.
    datagram.fill(0);
    assert.equal(txtEntries(service.txt).get("mac"), "aabbccddeeff");
  });

  test("B23: a subtype and the plain type name one instance, and one instance is one service", async () => {

    const rig = await makeBrowser({ serviceType: "_printer._sub._http._tcp.local" });
    const printer = [ "Printer", "_http", "_tcp", "local" ];

    // RFC 6763 section 7.1: a subtype PTR and the plain PTR point at the same instance, and a browser for the subtype sees the subtype's.
    deliver(rig.socket, [ makePtrRecord({ name: [ "_printer", "_sub", "_http", "_tcp", "local" ], target: printer, ttl: 4500 }),
      ...makeServiceRecords({ addresses: ["192.0.2.60"], host: "printer", instance: "Printer", port: 631, serviceType: "_http._tcp", strings: ["rp=queue"] }) ]);

    assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);
    assert.equal(onlyService(rig).port, 631);
    assert.deepEqual(onlyService(rig).name, printer);
  });

  test("B31: a truncated response is read exactly as a whole one is", async () => {

    const rig = await makeBrowser();

    // RFC 6762 section 18.5: TC on a received response is ignored by a querier, because a multicast response is read on its own terms.
    rig.socket.emitMessage(makeResponse({ answers: advertisement(), truncated: true }));
    assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);
    assert.equal(onlyService(rig).port, 6053);
  });

  test("V2: an IPv6 browser caches its own family's address records, each link-local one carrying the zone it arrived on", async () => {

    const rig = await makeIpv6Browser();
    const records = makeServiceRecords({ addresses: ["fe80::50"], host: "gdo", instance: "Garage Door", port: 6053, serviceType: "_esphomelib._tcp",
      strings: ["mac=aabbccddeeff"] });

    // The builder reads the address's own spelling, so what a responder of this family advertises is an AAAA.
    assert.equal(expectAt(records, 3, "the address record").kind, "aaaa");

    deliver(rig.socket, records, "fe80::abcd%en0");
    assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);

    const service = onlyService(rig);

    assert.deepEqual(service.host, [ "gdo", "local" ]);
    assert.deepEqual(service.addresses, ["fe80::50%en0"], "what the wire said, with the zone of the datagram that delivered it");

    // A global address is reachable as the wire spelled it, so nothing is attached to it.
    deliver(rig.socket, [makeAaaaRecord({ address: "2001:db8::50", name: [ "gdo", "local" ], ttl: 120 })], "fe80::abcd%en0");
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated" ]);
    assert.deepEqual(onlyService(rig).addresses, [ "fe80::50%en0", "2001:db8::50" ]);

    // fe80::/10 runs through febf, so febf is inside it and fec0 is the first address past it.
    deliver(rig.socket, [ makeAaaaRecord({ address: "febf::50", name: [ "gdo", "local" ], ttl: 120 }),
      makeAaaaRecord({ address: "fec0::50", name: [ "gdo", "local" ], ttl: 120 }) ], "fe80::abcd%en0");
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated", "updated" ]);
    assert.deepEqual(onlyService(rig).addresses, [ "fe80::50%en0", "2001:db8::50", "febf::50%en0", "fec0::50" ]);

    // An A is a record of the other family, dropped with everything else this browser did not ask for.
    deliver(rig.socket, [makeARecord({ address: "192.0.2.50", name: [ "gdo", "local" ], ttl: 120 })], "fe80::abcd%en0");
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated", "updated" ]);
    assert.deepEqual(onlyService(rig).addresses, [ "fe80::50%en0", "2001:db8::50", "febf::50%en0", "fec0::50" ]);

    /* One walk answers both readings. The checkpoint times come from it, and whether an A was ever asked for is read off every datagram the browser has sent,
     * because a second walk to the same moment would begin where this one stopped and see nothing.
     */
    const maintained = sendTimesUntil(rig, 130000, (datagram) => asksFor(datagram, DNS_TYPE_AAAA));

    assert.ok(maintained.length > 0, "a cached AAAA is asked for again at its checkpoints");
    assert.equal(rig.socket.sent.some((send) => asksFor(send.datagram, DNS_TYPE_A)), false, "an A is never asked for, because none was ever cached");
  });

  test("V4: an IPv4-only browser reads its own family's address records alone, and never asks for an AAAA", async () => {

    const rig = await makeBrowser();

    deliver(rig.socket, [ ...makeServiceRecords({ addresses: ["192.0.2.50"], host: "gdo", instance: "Garage Door", port: 6053, serviceType: "_esphomelib._tcp",
      strings: ["mac=aabbccddeeff"] }), makeAaaaRecord({ address: "fe80::50", name: [ "gdo", "local" ], ttl: 120 }) ]);
    assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);
    assert.deepEqual(onlyService(rig).addresses, ["192.0.2.50"], "an AAAA beside the A belongs to the other family");

    const missing = await makeBrowser();

    missing.clock.advance(100);
    deliver(missing.socket, advertisementAaaa({ address: "fe80::50" }));
    assert.equal(missing.events.length, 0, "an AAAA alone leaves an IPv4 browser with no address for the host");

    const attempt = sentAt(missing.clock, missing.socket, 120, "the resolution attempt");

    assert.equal(attempt.length, 1);
    assert.deepEqual(questionsOf(expectAt(attempt, 0, "the attempt").datagram, "the attempt"), [{ name: "gdo.local", type: DNS_TYPE_A }]);
    assert.deepEqual(sendTimesUntil(missing, 130000, (datagram) => asksFor(datagram, DNS_TYPE_AAAA)), []);
  });
});

describe("MdnsBrowser - resolution", () => {

  test("B13: a PTR with nothing behind it is asked about by name, in one message, after the same spread a first query gets", async () => {

    const rig = await makeBrowser();

    rig.clock.advance(100);
    deliver(rig.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 4500 })]);
    assert.equal(rig.events.length, 0, "a PTR alone is not a service");

    const sent = sentAt(rig.clock, rig.socket, 120, "the first resolution attempt");

    assert.equal(sent.length, 1, "the questions travel in one message rather than one each");

    // RFC 6763 section 12: the records a responder did not attach are what the client asks for, by the instance's own name.
    assert.deepEqual(questionsOf(expectAt(sent, 0, "the attempt").datagram, "the attempt"),
      [ { name: "Lonely._esphomelib._tcp.local", type: DNS_TYPE_SRV }, { name: "Lonely._esphomelib._tcp.local", type: DNS_TYPE_TXT } ]);

    // The resolution reads the same spread the browse series does, rounded the same way: 53.333 ms lands at 54 rather than at 53.
    const fractional = await makeBrowser({ random: (): number => 1 / 3 });

    fractional.clock.advance(100 - fractional.clock.now());
    deliver(fractional.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 4500 })]);
    assert.equal(sentAt(fractional.clock, fractional.socket, 154, "the fractional resolution attempt").length, 1);
  });

  test("B14: the resolution ladder doubles, narrows to what is missing, ends when the service resolves, and starts afresh for a PTR that returns", async () => {

    const ladder = await makeBrowser({ ceilingMs: 5000 });

    ladder.clock.advance(100);
    deliver(ladder.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 4500 })]);

    // Unanswered, each attempt waits twice as long as the one before it.
    assert.deepEqual(sendTimesUntil(ladder, 8000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [ 120, 1120, 3120, 7120 ]);

    const narrowing = await makeBrowser({ ceilingMs: 5000 });

    narrowing.clock.advance(100);
    deliver(narrowing.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 4500 })]);
    narrowing.clock.advance(120 - narrowing.clock.now());
    deliver(narrowing.socket, [ makeSrvRecord({ name: instanceName("Lonely"), port: 8080, priority: 10, target: [ "lonely", "local" ], ttl: 120, weight: 5 }),
      makeTxtRecord({ name: instanceName("Lonely"), strings: ["mac=aabbccddeeff"], ttl: 4500 }) ]);
    assert.equal(narrowing.events.length, 0, "an instance with no address does not resolve");

    // RFC 6763 section 12.2: the host an SRV names is the address record a responder should have attached, and the only thing left to ask for.
    sentUntil(narrowing.clock, narrowing.socket, 1119);

    const second = sentUntil(narrowing.clock, narrowing.socket, 1120);

    assert.deepEqual(questionsOf(expectAt(second, 0, "the second attempt").datagram, "the second attempt"), [{ name: "lonely.local", type: DNS_TYPE_A }]);

    narrowing.clock.advance(1200 - narrowing.clock.now());
    deliver(narrowing.socket, [makeARecord({ address: "192.0.2.70", name: [ "lonely", "local" ], ttl: 120 })]);
    assert.deepEqual(narrowing.events.map((event) => event.kind), ["found"]);
    assert.equal(onlyService(narrowing).port, 8080);

    // A resolution that answered asks nothing more, however long the clock runs past the ceiling.
    assert.deepEqual(sendTimesUntil(narrowing, 30000, (datagram) => asksFor(datagram, DNS_TYPE_SRV) || asksFor(datagram, DNS_TYPE_A)), []);

    const goodbye = await makeBrowser({ ceilingMs: 5000 });

    goodbye.clock.advance(100);
    deliver(goodbye.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 100 })]);
    assert.deepEqual(sendTimesUntil(goodbye, 1200, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [ 120, 1120 ]);
    goodbye.clock.advance(2000 - goodbye.clock.now());
    deliver(goodbye.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 0 })]);

    // The PTR is held for a second and then gone, and the ladder goes with it rather than asking about an instance nothing points at.
    assert.deepEqual(sendTimesUntil(goodbye, 30000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [],
      "the attempt that was pending when the PTR went is skipped rather than asked");

    const restartAt = goodbye.clock.now();

    deliver(goodbye.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 100 })]);

    // A PTR that comes back starts a fresh ladder: its second attempt is a second later, where a ladder carrying the old attempt count would have waited longer.
    assert.deepEqual(sendTimesUntil(goodbye, restartAt + 2000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [ restartAt + 20, restartAt + 1020 ]);
  });

  test("V3: an IPv6 browser asks for the host's AAAA, and asks for nothing the cache already holds", async () => {

    const rig = await makeIpv6Browser();

    rig.clock.advance(100);
    deliver(rig.socket, advertisementAaaa());
    assert.equal(rig.events.length, 0, "an instance with no address for its host is not a service");

    const attempt = sentAt(rig.clock, rig.socket, 120, "the resolution attempt");

    assert.equal(attempt.length, 1);

    // RFC 6763 section 12.2: the host the SRV names is what is left to ask for, and what is asked for is this browser's own family's address type.
    assert.deepEqual(questionsOf(expectAt(attempt, 0, "the attempt").datagram, "the attempt"), [{ name: "gdo.local", type: DNS_TYPE_AAAA }]);

    deliver(rig.socket, [makeAaaaRecord({ address: "fe80::50", name: [ "gdo", "local" ], ttl: 120 })], "fe80::abcd%en0");
    assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);
    assert.deepEqual(onlyService(rig).addresses, ["fe80::50%en0"]);

    const aboutTheHost = (datagram: Buffer): boolean => questionsOf(datagram, "a datagram").some((question) => (question.name === "gdo.local") &&
      [ DNS_TYPE_A, DNS_TYPE_AAAA ].includes(question.type));

    // An answered resolution stops, and the record's own first checkpoint is eighty percent of a 120-second lifetime away, so nothing asks after the host.
    assert.deepEqual(sendTimesUntil(rig, 90000, aboutTheHost), []);

    const attached = await makeIpv6Browser();

    attached.clock.advance(100);
    deliver(attached.socket, [ makePtrRecord({ name: SERVICE_NAME, target: instanceName("Garage Door"), ttl: 4500 }),
      makeSrvRecord({ name: instanceName("Garage Door"), port: 6053, priority: 10, target: [ "gdo", "local" ], ttl: 4500, weight: 5 }),
      makeAaaaRecord({ address: "fe80::50", name: [ "gdo", "local" ], ttl: 120 }) ], "fe80::abcd%en0");

    const forTxt = sentAt(attached.clock, attached.socket, 120, "the attempt for the missing TXT");

    // The AAAA the responder attached is an address of this browser's family, so the address question is not among what is asked for.
    assert.deepEqual(questionsOf(expectAt(forTxt, 0, "the attempt").datagram, "the attempt"),
      [{ name: "Garage Door._esphomelib._tcp.local", type: DNS_TYPE_TXT }]);
  });
});

describe("MdnsBrowser - cache", () => {

  test("B15: the same records again say nothing new and reset the lifetime they are maintained against", async () => {

    const rig = await makeBrowser();

    rig.clock.advance(100);
    deliver(rig.socket, advertisementAged({ srvTtl: 100 }));
    rig.clock.advance(4900);
    deliver(rig.socket, advertisementAged({ srvTtl: 100 }));
    assert.deepEqual(rig.events.map((event) => event.kind), ["found"], "an unchanged advertisement is not an update");

    // The second receipt is what eighty percent is measured from, so the re-query lands 80 seconds after it rather than after the first.
    assert.deepEqual(sendTimesUntil(rig, 86000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [85000]);
  });

  test("B16: a changed endpoint, a new address, and both at once are each one update carrying what came before", async () => {

    const ports = await makeBrowser();

    ports.clock.advance(100);
    deliver(ports.socket, advertisementAged({ port: 6053 }));
    deliver(ports.socket, advertisementAged({ port: 6060 }));

    const update = expectAt(ports.events, 1, "the update");

    assert.equal(ports.events.length, 2);
    assert.ok(update.kind === "updated");
    assert.equal(update.previous.port, 6053);
    assert.equal(update.service.port, 6060);

    const addresses = await makeBrowser();

    addresses.clock.advance(100);
    deliver(addresses.socket, advertisementAged());
    deliver(addresses.socket, [makeARecord({ address: "192.0.2.51", name: [ "gdo", "local" ], ttl: 120 })]);
    assert.deepEqual(addresses.events.map((event) => event.kind), [ "found", "updated" ]);
    assert.deepEqual(onlyService(addresses).addresses, [ "192.0.2.50", "192.0.2.51" ], "addresses read in the order they arrived");

    /* One packet carrying both changes is one update. The SRV is read in the pass that attaches records to an instance and the address in the pass after it, so
     * a browser that reconciled per pass, or per record, would say the same thing twice.
     */
    const together = await makeBrowser();

    together.clock.advance(100);
    deliver(together.socket, advertisementAged());
    deliver(together.socket, [ makeSrvRecord({ name: instanceName("Garage Door"), port: 6060, priority: 10, target: [ "gdo", "local" ], ttl: 120, weight: 5 }),
      makeARecord({ address: "192.0.2.51", name: [ "gdo", "local" ], ttl: 120 }) ]);
    assert.deepEqual(together.events.map((event) => event.kind), [ "found", "updated" ]);
    assert.equal(onlyService(together).port, 6060);
    assert.deepEqual(onlyService(together).addresses, [ "192.0.2.50", "192.0.2.51" ]);
  });

  test("B17: a goodbye holds the record for a second, and an announcement inside that second rescues it", async () => {

    const farewell = makeSrvRecord({ name: instanceName("Garage Door"), port: 6053, priority: 10, target: [ "gdo", "local" ], ttl: 0, weight: 5 });
    const lost = await makeBrowser();

    lost.clock.advance(100);
    deliver(lost.socket, advertisementAged({ srvTtl: 100 }));
    deliver(lost.socket, [farewell]);
    assert.deepEqual(lost.events.map((event) => event.kind), ["found"], "a goodbye is not a loss yet");

    // RFC 6762 section 10.1: one second, and then the record is gone.
    lost.clock.advance(999);
    assert.deepEqual(lost.events.map((event) => event.kind), ["found"]);
    lost.clock.advance(1);
    assert.deepEqual(lost.events.map((event) => event.kind), [ "found", "lost" ]);
    assert.equal(lost.browser.services.size, 0);

    const rescued = await makeBrowser();

    rescued.clock.advance(100);
    deliver(rescued.socket, advertisementAged({ srvTtl: 100 }));
    deliver(rescued.socket, [farewell]);
    rescued.clock.advance(500);
    deliver(rescued.socket, advertisementAged({ srvTtl: 100 }));

    // The refreshed record carries a new deadline, so the hold that was pending against the old one has nothing left to expire.
    rescued.clock.advance(1500);
    assert.deepEqual(rescued.events.map((event) => event.kind), ["found"]);
    assert.equal(rescued.browser.services.size, 1);
  });

  test("B18: a flushed record retires what the cache held under its name and type, a second later and in one step", async () => {

    const rig = await makeBrowser();

    rig.clock.advance(100);
    deliver(rig.socket, advertisementAged());
    deliver(rig.socket, [makeARecord({ address: "192.0.2.51", name: [ "gdo", "local" ], ttl: 120 })]);
    rig.clock.advance(1500);
    deliver(rig.socket, [makeARecord({ address: "192.0.2.52", flush: true, name: [ "gdo", "local" ], ttl: 120 })]);

    // RFC 6762 section 10.2: the flushed record is added at once and the older ones are held rather than dropped where they stand.
    assert.deepEqual(onlyService(rig).addresses, [ "192.0.2.50", "192.0.2.51", "192.0.2.52" ]);
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated", "updated" ]);

    rig.clock.advance(999);
    assert.equal(rig.events.length, 3);

    // Both held records share a deadline, so they leave in one step and the consumer is told once.
    rig.clock.advance(1);
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated", "updated", "updated" ]);
    assert.deepEqual(onlyService(rig).addresses, ["192.0.2.52"]);
  });

  test("B19: a flushed record leaves a record received inside the last second alone", async () => {

    const rig = await makeBrowser();

    rig.clock.advance(100);
    deliver(rig.socket, advertisementAged());
    deliver(rig.socket, [makeARecord({ address: "192.0.2.51", name: [ "gdo", "local" ], ttl: 120 })]);
    rig.clock.advance(500);
    deliver(rig.socket, [makeARecord({ address: "192.0.2.52", flush: true, name: [ "gdo", "local" ], ttl: 120 })]);
    assert.deepEqual(onlyService(rig).addresses, [ "192.0.2.50", "192.0.2.51", "192.0.2.52" ]);

    // RFC 6762 section 10.2's one-second grace: the records half a second old are part of the same announcement, not what it replaces.
    rig.clock.advance(2000);
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated", "updated" ]);
    assert.deepEqual(onlyService(rig).addresses, [ "192.0.2.50", "192.0.2.51", "192.0.2.52" ]);
  });

  test("B20: a record is asked for again at each checkpoint of its lifetime, spread as asked, and is deleted at the end of it", async () => {

    const rig = await makeBrowser();

    rig.clock.advance(100);
    deliver(rig.socket, advertisementAged({ addressTtl: 4500, srvTtl: 100 }));

    // RFC 6762 section 5.2: eighty, eighty-five, ninety, and ninety-five percent of the lifetime, each asking for that one record and offering nothing.
    assert.deepEqual(sendTimesUntil(rig, 96000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [ 80100, 85100, 90100, 95100 ]);

    const query = expectMessage(expectAt(rig.socket.sent.filter((send) => asksFor(send.datagram, DNS_TYPE_SRV)), 0, "a checkpoint query").datagram, "a checkpoint");

    assert.equal(query.questions.length, 1);
    assert.equal(query.answers.length, 0, "a maintenance question offers no known answer, which would suppress the answer it is asking for");

    rig.clock.advance(100099 - rig.clock.now());
    assert.equal(rig.browser.services.size, 1);
    rig.clock.advance(1);
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "lost" ]);

    // The spread is drawn from the same source the first query's delay is: at its maximum the first checkpoint is two percent of the lifetime later.
    const spread = await makeBrowser({ random: (): number => 1 });

    spread.clock.advance(100);
    deliver(spread.socket, advertisementAged({ addressTtl: 4500, srvTtl: 100 }));
    assert.deepEqual(sendTimesUntil(spread, 83000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [82100]);

    // A record nothing points at any more is deleted at its checkpoint without a question, which is RFC 6762 section 5.2's rule about local interest.
    const uninterested = await makeBrowser();

    uninterested.clock.advance(100);
    deliver(uninterested.socket, advertisementAged({ addressTtl: 4500, srvTtl: 100 }));
    uninterested.clock.advance(9900);
    deliver(uninterested.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Garage Door"), ttl: 0 })]);
    uninterested.clock.advance(999);
    assert.deepEqual(uninterested.events.map((event) => event.kind), ["found"]);
    uninterested.clock.advance(1);
    assert.deepEqual(uninterested.events.map((event) => event.kind), [ "found", "lost" ]);
    assert.deepEqual(sendTimesUntil(uninterested, 100000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), []);
  });

  test("B21: a record that answers its checkpoint starts its cycle again, and the checkpoint it left behind never fires", async () => {

    const rig = await makeBrowser();

    rig.clock.advance(100);
    deliver(rig.socket, advertisementAged({ addressTtl: 4500, srvTtl: 100 }));
    assert.deepEqual(sendTimesUntil(rig, 85200, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [ 80100, 85100 ]);

    const answeredAt = rig.clock.now();

    deliver(rig.socket, advertisementAged({ addressTtl: 4500, srvTtl: 100 }));

    // The refreshed record draws a new deadline, so the checkpoint pending against the old one is skipped and the next question is eighty percent of a fresh
    // lifetime away.
    assert.deepEqual(sendTimesUntil(rig, answeredAt + 81000, (datagram) => asksFor(datagram, DNS_TYPE_SRV)), [answeredAt + 80000]);
  });

  test("V5: one link-local address heard on two links is two addresses, each carrying its own zone", async () => {

    const rig = await makeIpv6Browser({ interfaces: fixedInterfaces({ ipv6: [ "fe80::1", "fe80::2" ] }) });
    const records = makeServiceRecords({ addresses: ["fe80::50"], host: "gdo", instance: "Garage Door", port: 6053, serviceType: "_esphomelib._tcp",
      strings: ["mac=aabbccddeeff"] });

    // RFC 6762 section 14: the same link-local name may be in use on different links, so the zone is what tells one link's copy of an address from another's.
    deliver(rig.socket, records, "fe80::abcd%en0");
    deliver(rig.socket, records, "fe80::abcd%en1");
    assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated" ]);
    assert.deepEqual(onlyService(rig).addresses, [ "fe80::50%en0", "fe80::50%en1" ], "addresses read in the order they arrived");
  });

  test("V6: a cached AAAA is asked for again at its own checkpoint, as an AAAA", async () => {

    const rig = await makeIpv6Browser({ random: (): number => 0 });

    deliver(rig.socket, advertisementAaaa({ address: "fe80::50", addressTtl: 100 }), "fe80::abcd%en0");
    assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);

    // RFC 6762 section 5.2's first checkpoint is eighty percent of the record's own lifetime, and what is asked for there is the record's own type.
    assert.deepEqual(sendTimesUntil(rig, 81000, (datagram) => asksFor(datagram, DNS_TYPE_AAAA)), [80000]);

    const checkpoint = rig.socket.sent.filter((send) => asksFor(send.datagram, DNS_TYPE_AAAA));

    assert.deepEqual(questionsOf(expectAt(checkpoint, 0, "the checkpoint query").datagram, "the checkpoint"), [{ name: "gdo.local", type: DNS_TYPE_AAAA }]);
    assert.equal(rig.socket.sent.some((send) => asksFor(send.datagram, DNS_TYPE_A)), false, "an A is never asked for at any point of the record's life");
  });
});

describe("MdnsBrowser - interfaces", () => {

  test("B24: the group is joined on every link of the family that is not internal, and on nothing else", async () => {

    const { socket } = await makeBrowser({ interfaces: fixedInterfaces({ ipv4: [ "192.0.2.1", "192.0.2.2" ], ipv6: ["fe80::1"] }) });

    assert.deepEqual(socket.memberships, [ "192.0.2.1", "192.0.2.2" ]);
    assert.deepEqual(socket.joinAttempts, [ "192.0.2.1", "192.0.2.2" ], "the loopback and the IPv6 link are not even tried");
  });

  test("B25: the links are read afresh at each query, so one that appears is joined and one that vanishes is dropped", async () => {

    let addresses: readonly string[] = ["192.0.2.1"];
    const { clock, socket } = await makeBrowser({ interfaces: (): NodeJS.Dict<NetworkInterfaceInfo[]> => fixedInterfaces({ ipv4: addresses })() });

    assert.deepEqual(socket.memberships, ["192.0.2.1"]);

    // The query at 1020 ms is long before the first poll tick, so what joins the second link is the query's own refresh.
    addresses = [ "192.0.2.1", "192.0.2.2" ];
    clock.advance(1020 - clock.now());
    assert.deepEqual(socket.memberships, [ "192.0.2.1", "192.0.2.2" ]);

    addresses = ["192.0.2.2"];
    clock.advance(3020 - clock.now());
    assert.deepEqual(socket.memberships, ["192.0.2.2"]);
  });

  test("B26: every packet goes out once per link with that link set, a refused join is warned once an episode, and so is having no link at all", async () => {

    const { clock, socket } = await makeBrowser({ interfaces: fixedInterfaces({ ipv4: [ "192.0.2.1", "192.0.2.2" ] }) });
    const first = sentAt(clock, socket, 20, "the first query");

    // The interface is set immediately before each link's datagram rather than once for the query, so the second link's copy cannot leave under the first.
    assert.deepEqual(first.map((send) => send.interfaceAddress), [ "192.0.2.1", "192.0.2.2" ]);
    assert.equal(expectAt(first, 0, "the first copy").datagram.equals(expectAt(first, 1, "the second copy").datagram), true);

    const log = capturingLog();
    const clock2 = new TestClock();
    const factory = new TestMdnsSocketFactory();
    let addresses: readonly string[] = [ "192.0.2.1", "192.0.2.9" ];
    const browser = new MdnsBrowser(baseOptions({ clock: clock2, interfaces: (): NodeJS.Dict<NetworkInterfaceInfo[]> => fixedInterfaces({ ipv4: addresses })(),
      ipFamilies: ["ipv4"], log, socketFactory: factory.create }));
    const refusing = expectAt(factory.createCalls, 0, "the socket").socket;

    refusing.refuseJoin.add("192.0.2.9");
    refusing.emitListening();
    await settle();
    assert.deepEqual(refusing.memberships, ["192.0.2.1"]);
    assert.equal(logCount(log.entries, "warn", "Could not join the mDNS group on 192.0.2.9"), 1);

    // The join is tried again at the next query, because the usual reasons one fails clear on their own; the warning is not written again for the same episode.
    clock2.advance(20);
    assert.equal(refusing.joinAttempts.filter((address) => address === "192.0.2.9").length, 2);
    assert.equal(logCount(log.entries, "warn", "Could not join the mDNS group on 192.0.2.9"), 1);

    // A link that goes away is forgotten, so its return is a fresh episode and says so once.
    addresses = ["192.0.2.1"];
    clock2.advance(1000);
    addresses = [ "192.0.2.1", "192.0.2.9" ];
    clock2.advance(2000);
    assert.equal(logCount(log.entries, "warn", "Could not join the mDNS group on 192.0.2.9"), 2);
    browser.abort();

    const quietLog = capturingLog();
    let quietAddresses: readonly string[] = [];
    const quiet = await makeBrowser({ interfaces: (): NodeJS.Dict<NetworkInterfaceInfo[]> => fixedInterfaces({ ipv4: quietAddresses })(), log: quietLog });

    quiet.clock.advance(1020);
    assert.equal(logCount(quietLog.entries, "warn", "No network interface joined"), 1, "two queries with nowhere to ask say so once");

    quietAddresses = ["192.0.2.1"];
    quiet.clock.advance(2000);
    quietAddresses = [];
    quiet.clock.advance(4000);
    assert.equal(logCount(quietLog.entries, "warn", "No network interface joined"), 2, "a link that came and went is a fresh episode");
  });

  test("B32: the poll joins a link that appears between queries, and that link hears the browsing question at once", async () => {

    let addresses: readonly string[] = ["192.0.2.1"];
    const rig = await makeBrowser({ interfaces: (): NodeJS.Dict<NetworkInterfaceInfo[]> => fixedInterfaces({ ipv4: addresses })() });

    for(const at of [ 20, 1020, 3020, 7020, 15020 ]) {

      assert.equal(sentAt(rig.clock, rig.socket, at, "the query at " + at.toString()).length, 1);
    }

    rig.clock.advance(20000 - rig.clock.now());
    addresses = [ "192.0.2.1", "192.0.2.3" ];

    /* The browse cadence has climbed to sixteen seconds by now, so the poll is what notices the link - and the fire that joins it asks the browsing question on
     * it there and then, rather than leaving it silent until the cadence comes around.
     */
    const joined = sentAt(rig.clock, rig.socket, 30000, "the poll tick that joins the new link");

    assert.deepEqual(joined.map((send) => send.interfaceAddress), ["192.0.2.3"]);
    assert.equal(isBrowseQuery(expectAt(joined, 0, "the question the new link hears").datagram), true);
    assert.deepEqual(rig.socket.memberships, [ "192.0.2.1", "192.0.2.3" ]);

    const both = sentAt(rig.clock, rig.socket, 31020, "the browse after the join");

    assert.deepEqual(both.map((send) => send.interfaceAddress), [ "192.0.2.1", "192.0.2.3" ]);
  });

  test("B33: a poll that finds nothing new sends nothing, keeps one timer, and is still polling minutes later", async () => {

    let addresses: readonly string[] = ["192.0.2.1"];
    const rig = await makeBrowser({ interfaces: (): NodeJS.Dict<NetworkInterfaceInfo[]> => fixedInterfaces({ ipv4: addresses })() });

    for(const at of [ 20, 1020, 3020, 7020 ]) {

      assert.equal(sentAt(rig.clock, rig.socket, at, "the query at " + at.toString()).length, 1);
    }

    assert.equal(sentAt(rig.clock, rig.socket, 15000, "the first poll tick").length, 0, "a poll that changes nothing sends nothing");
    assert.equal(rig.clock.pending, 1);
    assert.equal(sentAt(rig.clock, rig.socket, 15020, "the query after the tick").length, 1);
    assert.equal(sentAt(rig.clock, rig.socket, 30000, "the second poll tick").length, 0);
    assert.equal(rig.clock.pending, 1);

    // The poll is still arming itself a minute in, which is what keeps a link that appears late from waiting for the cadence.
    rig.clock.advance(40000 - rig.clock.now());
    addresses = [ "192.0.2.1", "192.0.2.4" ];

    const joined = sentAt(rig.clock, rig.socket, 45000, "the third poll tick");

    assert.deepEqual(joined.map((send) => send.interfaceAddress), ["192.0.2.4"]);
  });

  test("B34: whichever fire joins a link is the one that asks the browsing question on it", async () => {

    let addresses: readonly string[] = ["192.0.2.1"];
    const rig = await makeBrowser({ interfaces: (): NodeJS.Dict<NetworkInterfaceInfo[]> => fixedInterfaces({ ipv4: addresses })() });

    sentUntil(rig.clock, rig.socket, 16000);
    deliver(rig.socket, [makePtrRecord({ name: SERVICE_NAME, target: instanceName("Lonely"), ttl: 4500 })]);
    assert.equal(sentAt(rig.clock, rig.socket, 16020, "the first resolution attempt").length, 1);
    assert.equal(sentAt(rig.clock, rig.socket, 17020, "the second attempt").length, 1);

    rig.clock.advance(18000 - rig.clock.now());
    addresses = [ "192.0.2.1", "192.0.2.5" ];

    // A resolution's own fire re-reads the links like any other, so the new one hears the browsing question a whole browse cycle before the cadence reaches it.
    const joining = sentAt(rig.clock, rig.socket, 19020, "the attempt that joins the new link");

    assert.deepEqual(joining.map((send) => send.interfaceAddress), [ "192.0.2.5", "192.0.2.1", "192.0.2.5" ]);
    assert.equal(isBrowseQuery(expectAt(joining, 0, "the question the new link hears").datagram), true);
    assert.equal(asksFor(expectAt(joining, 1, "the attempt on the first link").datagram, DNS_TYPE_SRV), true);
    assert.equal(asksFor(expectAt(joining, 2, "the attempt on the new link").datagram, DNS_TYPE_SRV), true);
    sentUntil(rig.clock, rig.socket, 29999);
    assert.equal(sentUntil(rig.clock, rig.socket, 30000).length, 0, "a poll with nothing to join sends nothing");

    const browse = sentUntil(rig.clock, rig.socket, 31020).filter((send) => isBrowseQuery(send.datagram));

    assert.deepEqual(browse.map((send) => send.interfaceAddress), [ "192.0.2.1", "192.0.2.5" ]);
  });

  test("V1: an IPv6 browser joins its group on each link-local interface by name, asks there, and drops the link that goes away", async () => {

    let addresses: readonly string[] = [ "fe80::1", "fe80::2" ];
    const links = (): NodeJS.Dict<NetworkInterfaceInfo[]> => fixedInterfaces({ ipv4: ["192.0.2.9"], ipv6: addresses })();
    const { clock, socket } = await makeIpv6Browser({ interfaces: links });

    // A link of this family is named to the socket by its interface. The loopback, the tunnel carrying only a unique-local address, the global address beside
    // the first link's own, and the IPv4 address beside it are none of them links of the family, and none is even tried.
    assert.deepEqual(socket.memberships, [ "::%en0", "::%en1" ]);
    assert.deepEqual(socket.joinAttempts, [ "::%en0", "::%en1" ]);

    const first = sentAt(clock, socket, 20, "the first query");

    assert.deepEqual(first.map((send) => send.address), [ "ff02::fb", "ff02::fb" ], "RFC 6762 section 3's group for this family");
    assert.deepEqual(first.map((send) => send.port), [ 5353, 5353 ]);
    assert.deepEqual(first.map((send) => send.interfaceAddress), [ "::%en0", "::%en1" ]);
    assert.equal(expectAt(first, 0, "the first copy").datagram.equals(expectAt(first, 1, "the second copy").datagram), true);

    // A link that goes away is dropped under the designation its join was made with, and the survivor keeps the interface it was already named by.
    addresses = ["fe80::1"];
    clock.advance(1020 - clock.now());
    assert.deepEqual(socket.memberships, ["::%en0"]);
  });
});

describe("MdnsBrowser - both families", () => {

  test("F1: a response caches the address records of the socket it arrived on, and one host's addresses of both families meet in one service in arrival order",
    async () => {

      const rig = await makeDualBrowser();
      const ipv4 = expectAt(rig.sockets, 0, "the IPv4 socket");
      const ipv6 = expectAt(rig.sockets, 1, "the IPv6 socket");

      // Both sockets came up before the first browse fired, so nothing leaves either of them until it does, and then it leaves exactly once on each, under
      // that socket's own link and to that socket's own group.
      assert.equal(sentUntil(rig.clock, ipv6, 19).length, 0, "nothing is sent on the IPv6 socket before the first query");

      const firstOnIpv4 = sentAt(rig.clock, ipv4, 20, "the first query");

      assert.deepEqual(firstOnIpv4.map((send) => ({ address: send.address, link: send.interfaceAddress })),
        [{ address: "224.0.0.251", link: "192.0.2.1" }]);
      assert.deepEqual(ipv6.sent.map((send) => ({ address: send.address, link: send.interfaceAddress })), [{ address: "ff02::fb", link: "::%en0" }]);

      // An advertisement of a dual-stack host, delivered on the IPv4 socket: the A is cached and the AAAA beside it is left to the socket of its own family.
      deliver(ipv4, makeServiceRecords({ addresses: [ "192.0.2.50", "fe80::50" ], host: "gdo", instance: "Garage Door", port: 6053,
        serviceType: "_esphomelib._tcp", strings: ["mac=aabbccddeeff"] }));
      assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);
      assert.deepEqual(onlyService(rig).addresses, ["192.0.2.50"], "an AAAA heard on the IPv4 socket is a record of the other family");

      /* The same AAAA on its own socket, from a source carrying a zone, is one update and the host's second address. RFC 6762 section 6.2 is why a responder
       * attached it to the IPv4 answer in the first place, and purity is why the zone on it here is the zone of the link it actually arrived over.
       */
      deliver(ipv6, [makeAaaaRecord({ address: "fe80::50", name: [ "gdo", "local" ], ttl: 120 })], "fe80::abcd%en0");
      assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated" ]);
      assert.deepEqual(onlyService(rig).addresses, [ "192.0.2.50", "fe80::50%en0" ], "addresses read in the order they arrived");
    });

  test("F2: a socket whose bind is refused inside the call is dropped with a warning, the socket after it still binds, and the browser comes up there alone",
    async () => {

      const log = capturingLog();
      const refused = new Error("EAFNOSUPPORT");
      const rig = await makeDualBrowser({ failBind: { ipv4: refused }, listening: [], log });
      const ipv4 = expectAt(rig.sockets, 0, "the IPv4 socket");
      const ipv6 = expectAt(rig.sockets, 1, "the IPv6 socket");

      /* The refusal reaches the browser inside `bind()` itself and splices the very list the constructor is walking, which is why that walk is over a snapshot
       * of it: the socket after the one that was lost is still asked to bind.
       */
      assert.deepEqual(ipv4.bound, [5353]);
      assert.deepEqual(ipv6.bound, [5353], "the socket after the refused one still binds");
      assert.equal(ipv4.closed, true, "a socket that could not bind is closed by the drop");
      assert.equal(rig.browser.aborted, false, "a family the kernel refuses is a loss, not the end of the browser");
      assert.equal(logCount(log.entries, "warn", "lost its IPv4 socket and continues over IPv6"), 1);

      let ready = false;

      void rig.browser.ready.then((): void => {

        ready = true;
      });

      await settle();
      assert.equal(ready, false, "no socket has listened yet, so the browser has not come up");

      // The dropped socket is inert from here on, whatever its own emitter still delivers: it has left the list every handler reads.
      ipv4.emitListening();
      assert.deepEqual(ipv4.joinAttempts, [], "a socket that has left the browser joins nothing");
      assert.equal(ipv4.ttl, null, "and is told nothing about multicast");

      await settle();
      assert.equal(ready, false, "and never brings the browser up");

      ipv6.emitListening();
      await settle();
      assert.equal(ready, true, "the browser comes up on whichever socket listens, whatever family it serves");

      const first = sentAt(rig.clock, ipv6, 20, "the first query");

      assert.deepEqual(first.map((send) => send.interfaceAddress), ["::%en0"]);
      assert.deepEqual(ipv4.sent, [], "the socket that was dropped carries nothing");
    });

  test("F3: a socket that fails after it listens is dropped and the browser continues, a second error from it changes nothing, its family's addresses expire " +
    "at their lifetime, and the last socket's failure ends the browser", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const rig = await makeDualBrowser({ log });
      const ipv4 = expectAt(rig.sockets, 0, "the IPv4 socket");
      const ipv6 = expectAt(rig.sockets, 1, "the IPv6 socket");

      rig.clock.advance(100);
      deliver(ipv4, advertisementAged({ addressTtl: 4500, srvTtl: 4500 }));
      deliver(ipv6, [makeAaaaRecord({ address: "fe80::50", name: [ "gdo", "local" ], ttl: 120 })], "fe80::abcd%en0");
      assert.deepEqual(onlyService(rig).addresses, [ "192.0.2.50", "fe80::50%en0" ]);

      const boom = new Error("boom");

      ipv6.emitError(boom);
      assert.equal(rig.browser.aborted, false, "a browser that still holds a socket carries on");
      assert.equal(rig.clock.pending, 1, "the one timer is still armed");
      assert.equal(ipv6.closed, true, "the socket a fault took is closed by the drop, so the disposal it is waited on by can settle");
      assert.equal(logCount(log.entries, "warn", "lost its IPv6 socket and continues over IPv4"), 1);
      assert.equal(logCount(log.entries, "error", "stopped after a socket error"), 0);

      // A second error from a socket that has already left says nothing new and takes nothing with it.
      ipv6.emitError(new Error("again"));
      assert.equal(logCount(log.entries, "warn", "lost its IPv6 socket"), 1);
      assert.equal(rig.browser.aborted, false);

      const sentOnTheDropped = ipv6.sent.length;

      // The first browse fired where this row's own step landed, at 100, so the second is one seed interval past it.
      assert.equal(sentAt(rig.clock, ipv4, 1100, "the browse after the drop").length, 1, "the surviving socket carries the next query");
      assert.equal(ipv6.sent.length, sentOnTheDropped, "and the dropped one carries nothing more");

      /* The dropped family's records are left to expire rather than flushed: the maintenance question for the AAAA goes out on the socket that remains, whose
       * purity would drop an answer of the other family, so the record's own lifetime is what ends it.
       */
      assert.deepEqual(sendTimesUntil(rig, 96200, (datagram) => asksFor(datagram, DNS_TYPE_AAAA)), [96100]);
      rig.clock.advance(120200 - rig.clock.now());
      assert.deepEqual(rig.events.map((event) => event.kind), [ "found", "updated", "updated" ]);
      assert.deepEqual(onlyService(rig).addresses, ["192.0.2.50"], "the dropped family's address expired at its own lifetime, as one update");

      // The last socket's failure is what ends the browser, and the line that says so is the one a single-socket browser has always written.
      const last = new Error("last");

      ipv4.emitError(last);
      assert.equal(logCount(log.entries, "error", "stopped after a socket error"), 1);
      assert.equal(rig.browser.aborted, true);

      const reason: unknown = rig.browser.signal.reason;

      assert.ok(reason instanceof HbpuAbortError);
      assert.equal(reason.name, "failed");
      assert.equal(reason.cause, last);
      await rig.browser[Symbol.asyncDispose]();
    });
  });

  test("F4: a resolution asks for every served family's address once the host has none, in one message on every socket, and ends when one of either arrives",
    async () => {

      const rig = await makeDualBrowser();
      const ipv4 = expectAt(rig.sockets, 0, "the IPv4 socket");
      const ipv6 = expectAt(rig.sockets, 1, "the IPv6 socket");

      rig.clock.advance(100);
      deliver(ipv4, advertisementAaaa());
      assert.equal(rig.events.length, 0, "an instance with no address for its host is not a service");

      const attempt = sentAt(rig.clock, ipv4, 120, "the resolution attempt");
      const onIpv6 = ipv6.sent.filter((send) => asksFor(send.datagram, DNS_TYPE_AAAA));
      const bothTypes = [ { name: "gdo.local", type: DNS_TYPE_A }, { name: "gdo.local", type: DNS_TYPE_AAAA } ];

      /* RFC 6762 section 20 has a dual-stack host perform its lookups over both families, and there is no per-family reading of what is missing: an instance
       * derives the moment its host has one address of any served family, so at the point of asking it has none of either.
       */
      assert.equal(attempt.length, 1, "one message carries both questions");
      assert.deepEqual(questionsOf(expectAt(attempt, 0, "the attempt").datagram, "the attempt"), bothTypes);
      assert.equal(onIpv6.length, 1, "and the same message leaves on the other family's socket");
      assert.deepEqual(questionsOf(expectAt(onIpv6, 0, "the attempt on the IPv6 socket").datagram, "the attempt"), bothTypes);

      // One address of either family resolves the instance, so the AAAA alone ends the ladder and nothing asks after the host again.
      deliver(ipv6, [makeAaaaRecord({ address: "fe80::50", name: [ "gdo", "local" ], ttl: 120 })], "fe80::abcd%en0");
      assert.deepEqual(rig.events.map((event) => event.kind), ["found"]);
      assert.deepEqual(onlyService(rig).addresses, ["fe80::50%en0"]);

      const aboutTheHost = (datagram: Buffer): boolean => questionsOf(datagram, "a datagram").some((question) => (question.name === "gdo.local") &&
        [ DNS_TYPE_A, DNS_TYPE_AAAA ].includes(question.type));

      assert.deepEqual(sendTimesUntil(rig, 90000, aboutTheHost), []);
    });

  test("F5: disposal resolves only once every socket has closed, and one socket's refusal at teardown never skips the next", async () => {

    await assertNoUnhandledRejections(async () => {

      const rig = await makeDualBrowser();
      const ipv4 = expectAt(rig.sockets, 0, "the IPv4 socket");
      const ipv6 = expectAt(rig.sockets, 1, "the IPv6 socket");
      let disposed = false;

      ipv6.deferClose = true;

      const disposal = rig.browser[Symbol.asyncDispose]();

      void disposal.then((): void => {

        disposed = true;
      });

      await settle();
      assert.equal(ipv4.closed, true, "every socket is asked to close at once");
      assert.equal(ipv6.closed, true);
      assert.equal(disposed, false, "the disposal waits on the socket that has not delivered its close");

      ipv6.emitClose();
      await disposal;
      await settle();
      assert.equal(disposed, true, "and resolves once every socket has");

      const second = await makeDualBrowser();
      const refusing = expectAt(second.sockets, 0, "the IPv4 socket");
      const after = expectAt(second.sockets, 1, "the IPv6 socket");

      // The double refuses a membership it does not hold, so forgetting the join is what makes this socket's drop throw at teardown. The drops sit in a try of
      // that socket's own and the close is outside it, which is why neither close is skipped.
      refusing.memberships.length = 0;
      await second.browser[Symbol.asyncDispose]();
      assert.equal(refusing.closed, true, "the socket whose membership drop threw is still closed");
      assert.equal(after.closed, true, "and so is the one after it");
    });
  });

  test("F6: a browser starts on whichever socket listens first, a socket that comes up after the first query hears the browsing question on its links at once",
    async () => {

      const rig = await makeDualBrowser({ listening: ["ipv6"] });
      const ipv4 = expectAt(rig.sockets, 0, "the IPv4 socket");
      const ipv6 = expectAt(rig.sockets, 1, "the IPv6 socket");

      /* The IPv4 socket is in the list and has not listened, and the refresh leaves it alone: a membership added before a socket is bound would bind it to an
       * ephemeral port.
       */
      await rig.browser.ready;
      assert.deepEqual(ipv4.joinAttempts, [], "a socket that has not come up is never asked to join");
      assert.deepEqual(ipv6.memberships, ["::%en0"]);

      const first = sentAt(rig.clock, ipv6, 20, "the first query");

      assert.deepEqual(first.map((send) => send.interfaceAddress), ["::%en0"]);
      assert.equal(ipv4.sent.length, 0, "the socket that has not come up carries nothing");

      // A socket coming up after the first browse is a set of links appearing between queries, so it hears the browsing question there and then.
      ipv4.emitListening();
      assert.deepEqual(ipv4.joinAttempts, ["192.0.2.1"]);
      assert.deepEqual(ipv4.sent.map((send) => send.interfaceAddress), ["192.0.2.1"]);
      assert.equal(isBrowseQuery(expectAt(ipv4.sent, 0, "the question the new socket hears").datagram), true);
      assert.equal(rig.clock.pending, 1, "no second timer is armed for it");

      const sentOnIpv6 = ipv6.sent.length;
      const next = sentAt(rig.clock, ipv4, 1020, "the browse after the second socket came up");

      // The next scheduled browse leaves on both sockets, each copy under its own interface.
      assert.deepEqual(next.map((send) => send.interfaceAddress), ["192.0.2.1"]);
      assert.deepEqual(ipv6.sent.slice(sentOnIpv6).map((send) => send.interfaceAddress), ["::%en0"]);
    });

  test("F7: the no-link warning is written only once every serving socket is listening and none of them has a link", async () => {

    const oneFamily = capturingLog();

    await makeDualBrowser({ interfaces: fixedInterfaces({ ipv4: ["192.0.2.1"] }), log: oneFamily });
    assert.equal(logCount(oneFamily.entries, "warn", "No network interface joined"), 0, "one family's link is enough to keep it silent");

    const neither = capturingLog();

    await makeDualBrowser({ interfaces: fixedInterfaces({}), log: neither });
    assert.equal(logCount(neither.entries, "warn", "No network interface joined"), 1, "no listening socket has a link, so it is written once");

    // The read waits while a socket is still coming up, because a socket whose links are unknown is not a socket with no link.
    const waiting = capturingLog();
    const late = await makeDualBrowser({ interfaces: fixedInterfaces({ ipv6: ["fe80::1"] }), listening: ["ipv4"], log: waiting });

    assert.equal(logCount(waiting.entries, "warn", "No network interface joined"), 0, "the IPv6 socket has not come up, so nothing is read yet");
    expectAt(late.sockets, 1, "the IPv6 socket").emitListening();
    assert.equal(logCount(waiting.entries, "warn", "No network interface joined"), 0, "and its link is enough once it has");
  });

  test("F8: both sockets refused at bind end the browser, with the warning for the first loss, the error line once, and both promises carrying the last error",
    async () => {

      await assertNoUnhandledRejections(async () => {

        const log = capturingLog();
        const refusedIpv4 = new Error("no IPv4 here");
        const refusedIpv6 = new Error("no IPv6 here");
        const rig = await makeDualBrowser({ failBind: { ipv4: refusedIpv4, ipv6: refusedIpv6 }, listening: [], log });

        assert.equal(logCount(log.entries, "warn", "lost its IPv4 socket and continues over IPv6"), 1, "a socket still remained when the first was lost");
        assert.equal(logCount(log.entries, "error", "stopped after a socket error"), 1, "the last loss writes the error line once");
        assert.equal(rig.browser.aborted, true);

        const reason: unknown = rig.browser.signal.reason;

        assert.ok(reason instanceof HbpuAbortError);
        assert.equal(reason.name, "failed");
        assert.equal(reason.cause, refusedIpv6, "the reason carries the error of the socket lost last");
        await assert.rejects(rig.browser.ready, (error: unknown) => error === reason);
        await assert.rejects(rig.browser.settled, (error: unknown) => error === reason);
        await rig.browser[Symbol.asyncDispose]();
      });
    });
});

describe("MdnsBrowser - lifecycle", () => {

  test("B22: one timer is armed while the browser lives, however much it is holding, and none once it has gone", async () => {

    await assertNoUnhandledRejections(async () => {

      const rig = await makeBrowser();

      assert.equal(rig.clock.pending, 1, "one timer answers every deadline");

      rig.clock.advance(100);
      deliver(rig.socket, advertisementAged({ instance: "First" }));
      deliver(rig.socket, advertisementAged({ address: "192.0.2.51", host: "shed", instance: "Second", port: 6054 }));
      deliver(rig.socket, advertisementAged({ address: "192.0.2.52", host: "barn", instance: "Third", port: 6055 }));
      assert.equal(rig.browser.services.size, 3);
      assert.equal(rig.clock.pending, 1, "still one timer, with a dozen records on the timeline");

      await rig.browser[Symbol.asyncDispose]();
      assert.equal(rig.clock.pending, 0);
      assert.equal(rig.browser.services.size, 0);

      // A datagram the socket delivers after the lifetime has ended arms nothing and caches nothing.
      deliver(rig.socket, advertisementAged({ instance: "Fourth" }));
      assert.equal(rig.clock.pending, 0);
      assert.equal(rig.browser.services.size, 0);
    });
  });

  test("B35: a consumer that ends the lifetime from inside an event leaves nothing armed and nothing held", async () => {

    await assertNoUnhandledRejections(async () => {

      let browser: Nullable<MdnsBrowser> = null;
      let delivered = 0;
      const rig = await makeBrowser({ onEvent: (): void => {

        delivered++;
        browser?.abort();
      } });

      browser = rig.browser;
      rig.clock.advance(100);

      /* One datagram naming an instance and another behind it: the first reaches the consumer, whose handler ends the lifetime from inside that event, and the
       * instance behind it is never derived, so nothing is scheduled for it and the timeline the teardown emptied stays that way.
       */
      deliver(rig.socket, [ ...advertisement({ instance: "First" }), ...advertisement({ address: "192.0.2.51", host: "shed", instance: "Second", port: 6054 }) ]);

      assert.equal(rig.browser.aborted, true);
      assert.equal(delivered, 1, "the event the consumer ended the lifetime from is the last one it is handed");
      assert.equal(rig.clock.pending, 0, "nothing is armed once the lifetime has ended");
      assert.equal(rig.browser.services.size, 0);
    });
  });

  test("B27: a socket error is reported once and ends the browser, naming what failed", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const { browser, socket } = await makeBrowser({ log });
      const boom = new Error("boom");

      socket.emitError(boom);
      assert.equal(logCount(log.entries, "error", "The mDNS browser for _esphomelib._tcp.local stopped after a socket error"), 1);
      assert.equal(browser.aborted, true);

      const reason: unknown = browser.signal.reason;

      assert.ok(reason instanceof HbpuAbortError);
      assert.equal(reason.name, "failed");
      assert.equal(reason.cause, boom);

      // A second failure on the way down is the same failure, and is not reported a second time.
      socket.emitError(new Error("again"));
      assert.equal(logCount(log.entries, "error", "The mDNS browser for _esphomelib._tcp.local stopped after a socket error"), 1);
    });
  });

  test("B28: a lifetime that had already ended binds nothing and rejects both promises with its reason", async () => {

    await assertNoUnhandledRejections(async () => {

      const controller = new AbortController();
      const reason = new HbpuAbortError("shutdown");

      controller.abort(reason);

      const factory = new TestMdnsSocketFactory();
      const browser = new MdnsBrowser(baseOptions({ signal: controller.signal, socketFactory: factory.create }));
      const sockets = factory.createCalls.map((call) => call.socket);

      assert.equal(sockets.length, 2, "a browser that named no family still created a socket per family");
      assert.deepEqual(sockets.map((socket) => socket.bound), [ [], [] ], "a socket that will never listen is never asked to bind");
      assert.deepEqual(sockets.map((socket) => socket.closed), [ true, true ]);
      await assert.rejects(browser.ready, (error: unknown) => error === reason);
      await assert.rejects(browser.settled, (error: unknown) => error === reason);
    });
  });

  test("B29: disposal closes the socket and ends both promises with the reason it ended for", async () => {

    await assertNoUnhandledRejections(async () => {

      const rig = await makeBrowser();
      const settled = rig.browser.settled;

      {

        // The scope is what ends it, which is how a plugin holds one.
        await using browser = rig.browser;

        assert.equal(browser.aborted, false);
      }

      assert.deepEqual(rig.sockets.map((socket) => socket.closed), [true], "every socket the browser held is closed");
      await assert.rejects(settled, (error: unknown) => (error instanceof HbpuAbortError) && (error.name === "shutdown"));
    });
  });
});
