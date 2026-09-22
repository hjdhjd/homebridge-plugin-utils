/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/address.test.ts: Unit tests for address classification - the dial-address pick and the advertised-address membership test.
 */
import * as mdnsBarrel from "./index.ts";
import { describe, test } from "node:test";
import { dialAddress, isAdvertisedAt, isLinkLocal, zoneOf } from "./address.ts";
import type { Nullable } from "../util.ts";
import assert from "node:assert/strict";

describe("dialAddress - the address a consumer dials", () => {

  test("A1: ranks the advertised set by family and stability, and answers the same address whatever order the set arrived in", () => {

    /* Every row states the set and the one address the ranking answers for it. The pairs that appear twice in both orders are the rows that prove the answer
     * is a function of the set alone: a pick that read a tier positionally would answer one of the two orders correctly and the other wrongly.
     */
    const cases: readonly { readonly addresses: readonly string[]; readonly expected: Nullable<string>; readonly why: string }[] = [
      { addresses: ["192.0.2.10"], expected: "192.0.2.10", why: "IPv4-only device dialed there" },
      { addresses: [ "2001:db8::1", "192.0.2.10" ], expected: "2001:db8::1", why: "dual-stack dialed over IPv6" },
      { addresses: [ "192.0.2.10", "2001:db8::1" ], expected: "2001:db8::1", why: "same set, order reversed, same answer" },
      { addresses: [ "192.0.2.10", "fd00::1", "2001:db8::1" ], expected: "fd00::1", why: "unique-local outranks global" },
      { addresses: [ "2001:db8::1", "fd00::1" ], expected: "fd00::1", why: "unique-local preference holds with global listed first" },
      { addresses: [ "fd00::2", "fd00::1" ], expected: "fd00::1", why: "within unique-local class, lowest wins, not first-listed" },
      { addresses: [ "fd00::1", "fd00::2" ], expected: "fd00::1", why: "same pair reversed, same answer" },
      { addresses: [ "2001:db8::2", "2001:db8::1" ], expected: "2001:db8::1", why: "within global class, lowest wins, not first-listed" },
      { addresses: [ "2001:db8::1", "2001:db8::2" ], expected: "2001:db8::1", why: "same pair reversed, same answer" },
      { addresses: [ "fe80::1%en0", "2001:db8::1" ], expected: "2001:db8::1", why: "zoned address never dialed; routable one taken" },
      { addresses: [ "fe80::1", "192.0.2.10" ], expected: "192.0.2.10", why: "unzoned link-local yields to IPv4" },
      { addresses: [ "fe80::1", "2001:db8::1" ], expected: "2001:db8::1", why: "unzoned link-local yields to routable IPv6" },
      { addresses: [ "febf::1", "192.0.2.10" ], expected: "192.0.2.10", why: "link-local range runs to febf, matching fe80::/10" },
      { addresses: [ "fe80::2", "fe80::1" ], expected: "fe80::1", why: "among link-local last resort, lowest wins, not first-listed" },
      { addresses: [ "fe80::1%en0", "192.0.2.10" ], expected: "192.0.2.10", why: "zoned address skipped in favor of IPv4" },
      { addresses: ["fe80::1%en0"], expected: null, why: "only a zoned address; not classified" },
      { addresses: [], expected: null, why: "no address at all; not classified" },
      { addresses: [ "192.0.2.20", "192.0.2.10" ], expected: "192.0.2.10", why: "within IPv4, lowest wins, not first-listed" },
      { addresses: [ "192.0.2.10", "192.0.2.20" ], expected: "192.0.2.10", why: "same pair reversed, same answer" },
      { addresses: [ "fc00::1", "2001:db8::1" ], expected: "fc00::1", why: "unique-local low edge (fc00) outranks a lexically lower global address" },
      { addresses: [ "fdff::1", "2001:db8::1" ], expected: "fdff::1", why: "unique-local high edge (fdff) outranks a lexically lower global address" },
      { addresses: [ "fbff::1", "2001:db8::1" ], expected: "2001:db8::1",
        why: "fbff falls just short of fc00::/7, so it is routable, not unique-local; lowest string wins" },
      { addresses: [ "fe00::1", "2001:db8::1" ], expected: "2001:db8::1",
        why: "fe00 falls just past fc00::/7, so it is routable, not unique-local; lowest string wins" }
    ];

    for(const { addresses, expected, why } of cases) {

      assert.equal(dialAddress(addresses), expected, why);
    }
  });
});

describe("isAdvertisedAt - the membership test a connection owner asks", () => {

  test("A2: reads the full advertised list exactly as advertised, zoned entries included", () => {

    /* Membership is the question a connection owner means to ask, and it is deliberately not the ranked pick: the held address is compared against every
     * address the service advertises, in whatever order and whatever spelling, so a reorder or a newly gained address never reads as a move.
     */
    const cases: readonly { readonly addresses: readonly string[]; readonly advertised: boolean; readonly held: string; readonly why: string }[] = [
      { addresses: ["192.0.2.10"], advertised: true, held: "192.0.2.10", why: "held address is the only one advertised; not moved" },
      { addresses: ["192.0.2.11"], advertised: false, held: "192.0.2.10", why: "different address and nothing else; moved" },
      { addresses: [ "192.0.2.10", "2001:db8::1" ], advertised: false, held: "fd00::1",
        why: "held address gone; reads as moved (also how a lapse of its own record reads)" },
      { addresses: [ "192.0.2.10", "2001:db8::1", "fd00::1" ], advertised: true, held: "2001:db8::1",
        why: "preferred record returned and moved the pick to fd00::1, but held address still advertised" },
      { addresses: [ "fd00::1", "2001:db8::1" ], advertised: true, held: "fd00::1", why: "held address present; membership holds whatever the order" },
      { addresses: [ "2001:db8::1", "fd00::1" ], advertised: true, held: "fd00::1", why: "same set reversed, same answer" },
      { addresses: [ "2001:db8::1", "192.0.2.10" ], advertised: true, held: "192.0.2.10",
        why: "device gained a higher-ranked IPv6 address but still advertises the IPv4 address the connection is on" },
      { addresses: ["fe80::1%en0"], advertised: true, held: "fe80::1%en0", why: "zoned address held; still advertised zoned, matches exactly" },
      { addresses: ["fe80::1%en0"], advertised: false, held: "fe80::1", why: "held address lacks the zone the service still advertises; not the same string" },
      { addresses: [], advertised: false, held: "192.0.2.10", why: "nothing advertised; not present" }
    ];

    for(const { addresses, advertised, held, why } of cases) {

      assert.equal(isAdvertisedAt(addresses, held), advertised, why);
    }
  });
});

describe("isLinkLocal - the fe80::/10 boundary", () => {

  test("A3: classifies the range's own edges and the neighbors just outside them", () => {

    const cases: readonly { readonly address: string; readonly expected: boolean; readonly why: string }[] = [
      { address: "fe80::1", expected: true, why: "the low edge of fe80::/10" },
      { address: "febf::1", expected: true, why: "the high edge of fe80::/10" },
      { address: "fe7f::1", expected: false, why: "the neighbor just below the low edge" },
      { address: "fec0::1", expected: false, why: "the neighbor just past the high edge" }
    ];

    for(const { address, expected, why } of cases) {

      assert.equal(isLinkLocal(address), expected, why);
    }
  });
});

describe("zoneOf - the zone a datagram's source carries", () => {

  test("A4: answers the text after the percent sign, and null for a source carrying none", () => {

    assert.equal(zoneOf("fe80::1%en0"), "en0", "a zoned source answers the link it was heard on");
    assert.equal(zoneOf("2001:db8::1"), null, "a source with no percent sign carries no zone");
  });
});

describe("the mdns barrel - only the ranked pick and the membership test are public", () => {

  test("A5: publishes dialAddress and isAdvertisedAt, and keeps the two classifiers package-internal", () => {

    // The classifiers carry `export` so browser.ts can import them across modules, which is exactly why the barrel names what it re-exports rather than
    // widening to the whole module: this asserts the curation holds, rather than trusting the form of the re-export line to speak for itself.
    assert.equal("dialAddress" in mdnsBarrel, true, "the ranked pick is this package's public surface");
    assert.equal("isAdvertisedAt" in mdnsBarrel, true, "the membership test is this package's public surface");
    assert.equal("isLinkLocal" in mdnsBarrel, false, "the link-local classifier stays package-internal");
    assert.equal("zoneOf" in mdnsBarrel, false, "the zone reading stays package-internal");
  });
});
