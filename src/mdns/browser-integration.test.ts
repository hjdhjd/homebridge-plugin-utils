/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/browser-integration.test.ts: The differential suite - the browser against a real responder on a real network, over either address family or both.
 * Homebridge's own advertiser publishes a service, and the discovery surface is expected to find it and, once the advertiser says goodbye, to lose it. Opt-in
 * behind MDNS_INTEGRATION=1, because it advertises on the link this machine is attached to and depends on multicast actually reaching this host's sockets.
 */
import type { MdnsDiscovery, MdnsDiscoveryEvent } from "./discovery.ts";
import { describe, test } from "node:test";
import { dnsNameKey, txtEntries } from "./message.ts";
import { silentLog, waitUntil } from "../testing/index.ts";
import type { CiaoService } from "@homebridge/ciao";
import type { MdnsService } from "./browser.ts";
import assert from "node:assert/strict";
import ciao from "@homebridge/ciao";
import { discoverServices } from "./discovery.ts";
import { mdnsIntegrationEnabled } from "./integration.helpers.ts";
import { pid } from "node:process";
import { systemClock } from "../clock.ts";
import { waitWithSignal } from "../util.ts";

// The type this suite advertises under, which no real device answers for.
const SERVICE_TYPE = "hbpu-test";

// The port the advertised service claims. Nothing listens on it: what is being proven is the discovery of the advertisement, not a connection to it.
const SERVICE_PORT = 41234;

// How long a row waits for one event before it gives up. A quiet LAN answers a browsing query in well under a second; this is the ceiling, not the expectation.
const EVENT_TIMEOUT_MS = 10000;

// How long a row waits for the responder to reach its announced state. Probing and announcing across every link of a family is what fills this span, so the
// ceiling scales with how many links the host carries rather than with how fast the network answers.
const ANNOUNCE_TIMEOUT_MS = 15000;

// The responder's announced state, spelled as the responder's own type. The enum it belongs to is ambient and const, which this project's `isolatedModules`
// bars a value import of, so the state is named once here and compared by identity below.
const ANNOUNCED = "announced" as CiaoService["serviceState"];

/* A responder puts a goodbye on the wire only from its announced state: one still probing is torn down silently, and probing across every link of a family
 * outlasts the first answer a browser hears, so a row that says goodbye the moment it sees its service can be asking a responder that has nothing to withdraw
 * yet. Waiting for the announced state is what makes the goodbye these rows are about actually leave.
 */
async function awaitAnnounced(service: CiaoService): Promise<void> {

  await waitUntil(() => service.serviceState === ANNOUNCED, { description: "the responder to finish announcing", pollMs: 50, timeoutMs: ANNOUNCE_TIMEOUT_MS });
}

// The next event the consumer's loop would be given, bounded so a network that says nothing fails the row rather than hanging it.
async function nextEvent(discovery: MdnsDiscovery<MdnsService>, description: string): Promise<MdnsDiscoveryEvent<MdnsService>> {

  const iterator = discovery[Symbol.asyncIterator]();
  const result = await waitWithSignal(iterator.next(), systemClock.timeout(EVENT_TIMEOUT_MS));

  assert.ok(!result.done, "the discovery ended while waiting for " + description);

  return result.value;
}

describe("MdnsBrowser integration (ciao advertiser)", { skip: !mdnsIntegrationEnabled }, () => {

  test("I1: a service a real responder advertises is found, carrying the port and the TXT entry it advertised", { timeout: 30000 }, async () => {

    const responder = ciao.getResponder();
    const instance = "hbpu-" + pid.toString();
    const advertised = responder.createService({ name: instance, port: SERVICE_PORT, txt: { hbpu: "1" }, type: SERVICE_TYPE });

    try {

      await advertised.advertise();

      await using discovery = discoverServices<MdnsService>({ classify: (service: MdnsService): MdnsService => service, log: silentLog(),
        serviceType: "_" + SERVICE_TYPE + "._tcp.local", signal: new AbortController().signal });

      const event = await nextEvent(discovery, "the advertised service");

      assert.equal(event.kind, "found");
      assert.equal(event.device.instance, instance);
      assert.equal(event.device.port, SERVICE_PORT);
      assert.equal(txtEntries(event.device.txt).get("hbpu"), "1");
      assert.ok(event.device.addresses.length > 0, "a found service carries at least one address");
    } finally {

      await advertised.end();
      await responder.shutdown();
    }
  });

  test("I2: a service the responder says goodbye to is lost", { timeout: 30000 }, async () => {

    const responder = ciao.getResponder();
    const instance = "hbpu-" + pid.toString() + "-bye";
    const advertised = responder.createService({ name: instance, port: SERVICE_PORT, txt: { hbpu: "1" }, type: SERVICE_TYPE });

    try {

      await advertised.advertise();

      await using discovery = discoverServices<MdnsService>({ classify: (service: MdnsService): MdnsService => service, log: silentLog(),
        serviceType: "_" + SERVICE_TYPE + "._tcp.local", signal: new AbortController().signal });

      assert.equal((await nextEvent(discovery, "the advertised service")).kind, "found");

      // The goodbye carries a zero lifetime, which the browser holds for a second before it deletes what it was holding.
      await awaitAnnounced(advertised);
      await advertised.end();
      assert.equal((await nextEvent(discovery, "the goodbye")).kind, "lost");
    } finally {

      await responder.shutdown();
    }
  });

  test("I3: a service a real responder advertises over IPv6 is found, its link-local addresses carrying their zone", { timeout: 30000 }, async () => {

    const responder = ciao.getResponder({ advertiseIpv6: true });
    const instance = "hbpu6-" + pid.toString();
    const advertised = responder.createService({ name: instance, port: SERVICE_PORT, txt: { hbpu: "1" }, type: SERVICE_TYPE });

    try {

      await advertised.advertise();

      await using discovery = discoverServices<MdnsService>({ classify: (service: MdnsService): MdnsService => service, ipFamilies: ["ipv6"], log: silentLog(),
        serviceType: "_" + SERVICE_TYPE + "._tcp.local", signal: new AbortController().signal });

      const event = await nextEvent(discovery, "the advertised service");

      assert.equal(event.kind, "found");
      assert.equal(event.device.instance, instance);
      assert.equal(event.device.port, SERVICE_PORT);
      assert.equal(txtEntries(event.device.txt).get("hbpu"), "1");
      assert.ok(event.device.addresses.length > 0, "a found service carries at least one address");

      const linkLocal = event.device.addresses.filter((address) => address.startsWith("fe80:"));

      // RFC 6762 section 20 makes this the IPv6 `.local.` zone, so every address is of that family alone, and a link-local one is reachable only through the
      // link it was heard on.
      assert.equal(event.device.addresses.some((address) => address.includes(".")), false, "an address of the other family never reaches an IPv6 browse");
      assert.ok(linkLocal.length > 0, "the responder answers with the link-local address of the link this query went out on");
      assert.equal(linkLocal.every((address) => address.includes("%")), true, "a link-local address carries the zone of the link it arrived on");
    } finally {

      await advertised.end();
      await responder.shutdown();
    }
  });

  test("I4: a service the responder says goodbye to over IPv6 is lost", { timeout: 30000 }, async () => {

    const responder = ciao.getResponder({ advertiseIpv6: true });
    const instance = "hbpu6-" + pid.toString() + "-bye";
    const advertised = responder.createService({ name: instance, port: SERVICE_PORT, txt: { hbpu: "1" }, type: SERVICE_TYPE });

    try {

      await advertised.advertise();

      await using discovery = discoverServices<MdnsService>({ classify: (service: MdnsService): MdnsService => service, ipFamilies: ["ipv6"], log: silentLog(),
        serviceType: "_" + SERVICE_TYPE + "._tcp.local", signal: new AbortController().signal });

      assert.equal((await nextEvent(discovery, "the advertised service")).kind, "found");

      // The goodbye carries a zero lifetime, which the browser holds for a second before it deletes what it was holding.
      await awaitAnnounced(advertised);
      await advertised.end();
      assert.equal((await nextEvent(discovery, "the goodbye")).kind, "lost");
    } finally {

      await responder.shutdown();
    }
  });

  test("I5: a dual-stack advertisement under the default browse is one service carrying an IPv4 address and a zoned link-local IPv6 address", { timeout: 30000 },
    async () => {

      const responder = ciao.getResponder({ advertiseIpv6: true });
      const instance = "hbpu-dual-" + pid.toString();
      const advertised = responder.createService({ name: instance, port: SERVICE_PORT, txt: { hbpu: "1" }, type: SERVICE_TYPE });

      try {

        await advertised.advertise();

        /* A responder still announcing has already put this instance's PTR on the wire, so a browse that starts there caches it and then offers it back as a
         * known answer, which RFC 6762 section 7.1 has every responder suppress - and this responder's announcement over IPv6 carries no address record, though
         * RFC 6762 section 8.3 has a responder announce all of its records, so the host's second family would then wait for a maintenance question. Browsing an
         * announced responder is what puts the browse question on the wire with nothing to suppress it, which is the exchange this row is about: one question,
         * answered over both families, merged into one service.
         */
        await awaitAnnounced(advertised);

        // No family is named, so the browse is the library's own default: a socket per family over one cache, which is what merges the responder's two
        // families into one service.
        await using discovery = discoverServices<MdnsService>({ classify: (service: MdnsService): MdnsService => service, log: silentLog(),
          serviceType: "_" + SERVICE_TYPE + "._tcp.local", signal: new AbortController().signal });

        const event = await nextEvent(discovery, "the advertised service");

        assert.equal(event.kind, "found");
        assert.equal(event.device.instance, instance);

        /* The two families arrive on their own sockets and in their own datagrams, so the second address may reach the consumer on the found event or on the
         * update behind it. What is being proven is the merge, not which event carried it, so the live snapshot is what this reads.
         */
        const key = dnsNameKey(event.device.name);
        const addressesNow = (): readonly string[] => discovery.devices.get(key)?.addresses ?? [];

        await waitUntil(() => addressesNow().some((address) => address.includes("%")),
          { description: "the IPv6 address of the dual-stack responder", pollMs: 50, timeoutMs: EVENT_TIMEOUT_MS });
        assert.ok(addressesNow().some((address) => address.includes(".")), "one service carries the responder's IPv4 address");
        assert.ok(addressesNow().some((address) => address.startsWith("fe80:") && address.includes("%")),
          "and its link-local IPv6 address, carrying the zone of the link it arrived on");
      } finally {

        await advertised.end();
        await responder.shutdown();
      }
    });
});
