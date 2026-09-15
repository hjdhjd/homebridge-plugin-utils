/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/browser-double.test.ts: Unit tests for the shipped mDNS browser double - the synchronous delivery verbs, the service store they read and write, the
 * refusals that keep a test from describing a sequence no browser produces, and the lifetime promises a consumer above it awaits.
 */
import type { MdnsBrowserEvent, MdnsBrowserOptions, MdnsService } from "./browser.ts";
import { TestMdnsBrowser, TestMdnsBrowserFactory, makeService } from "./browser-double.ts";
import { assertNoUnhandledRejections, expectAt, silentLog } from "../testing/index.ts";
import { describe, test } from "node:test";
import { HbpuAbortError } from "../util.ts";
import assert from "node:assert/strict";
import { makeServiceRecords } from "./message-builders.ts";

const SERVICE_TYPE = "_esphomelib._tcp.local";

// One resolved service, with every field varied from one call to the next so a row reading one cannot be reading a default. The shipped composer is what builds
// it, so the shape a row delivers is the shape a browser derives from the same advertisement.
function service({ instance = "Garage Door", port = 6053 }: { instance?: string; port?: number } = {}): MdnsService {

  return makeService({ addresses: ["192.0.2.50"], host: "gdo", instance, port, serviceType: "_esphomelib._tcp", strings: ["mac=aabbccddeeff"] });
}

// The options a consumer would have handed the real browser, with the sink pointed at a row's own array.
function options(events: MdnsBrowserEvent[], signal: AbortSignal = new AbortController().signal): MdnsBrowserOptions {

  return { log: silentLog(), onEvent: (event: MdnsBrowserEvent): void => {

    events.push(event);
  }, serviceType: SERVICE_TYPE, signal };
}

describe("TestMdnsBrowser - delivery", () => {

  test("T1: a found service reaches the sink as it is delivered and is held afterwards", () => {

    const events: MdnsBrowserEvent[] = [];
    const browser = new TestMdnsBrowser(options(events));
    const found = service();

    browser.found(found);

    // The real browser hands its consumer each transition as it derives it, and so does this: there is nothing to await.
    assert.deepEqual(events, [{ kind: "found", service: found }]);
    assert.equal(browser.services.get("garage door._esphomelib._tcp.local"), found);
  });

  test("T2: finding an instance that is already held is refused by name", () => {

    const events: MdnsBrowserEvent[] = [];
    const browser = new TestMdnsBrowser(options(events));

    browser.found(service());
    assert.throws(() => browser.found(service({ port: 6060 })),
      (error: unknown) => (error instanceof Error) && error.message.includes("garage door._esphomelib._tcp.local"));
    assert.equal(events.length, 1);
  });

  test("T3: an update carries what was held before it", () => {

    const events: MdnsBrowserEvent[] = [];
    const browser = new TestMdnsBrowser(options(events));
    const first = service({ port: 6053 });
    const second = service({ port: 6060 });

    browser.found(first);
    browser.updated(second);
    assert.deepEqual(events, [ { kind: "found", service: first }, { kind: "updated", previous: first, service: second } ]);
    assert.equal(browser.services.get("garage door._esphomelib._tcp.local"), second);
  });

  test("T4: losing or updating an instance that was never found is refused by name", () => {

    const events: MdnsBrowserEvent[] = [];
    const browser = new TestMdnsBrowser(options(events));

    assert.throws(() => browser.lost(service().name), (error: unknown) => (error instanceof Error) && error.message.includes("cannot be lost"));
    assert.throws(() => browser.updated(service()), (error: unknown) => (error instanceof Error) && error.message.includes("cannot be updated"));

    // A lost instance carries the last service the double held for it, which is what a consumer projecting a device reads.
    const found = service({ instance: "Shed Door", port: 6054 });

    browser.found(found);
    browser.lost(found.name);
    assert.deepEqual(expectAt(events, 1, "the lost event"), { kind: "lost", service: found });
    assert.equal(browser.services.size, 0);
  });

  test("T5: the warmup promise is pending until the test says the warmup is over", async () => {

    const events: MdnsBrowserEvent[] = [];
    const browser = new TestMdnsBrowser(options(events));
    const pending = Symbol("pending");

    assert.equal(await Promise.race([ browser.settled, Promise.resolve(pending) ]), pending);
    browser.settle();
    await browser.settled;
  });

  test("T6: every delivery verb on a browser whose lifetime has ended answers with the reason it ended for", async () => {

    await assertNoUnhandledRejections(async () => {

      const events: MdnsBrowserEvent[] = [];
      const browser = new TestMdnsBrowser(options(events));
      const found = service();

      browser.found(found);
      browser.abort(new HbpuAbortError("replaced"));

      for(const verb of [ (): void => browser.found(service({ instance: "Another" })), (): void => browser.updated(found),
        (): void => browser.lost(found.name) ]) {

        assert.throws(verb, (error: unknown) => (error instanceof HbpuAbortError) && (error.name === "replaced"));
      }

      assert.equal(events.length, 1, "nothing reaches a consumer that has torn down");
      await browser[Symbol.asyncDispose]();
    });
  });
});

describe("TestMdnsBrowser - lifetime", () => {

  test("T7: the factory records every browser a consumer asked it for, with the options it asked with", () => {

    const events: MdnsBrowserEvent[] = [];
    const factory = new TestMdnsBrowserFactory();
    const asked = options(events);
    const browser = factory.create(asked);
    const recorded = expectAt(factory.createCalls, 0, "the create call");

    assert.equal(factory.createCalls.length, 1);
    assert.equal(recorded.browser, browser);
    assert.equal(recorded.options, asked);
    assert.equal(recorded.browser.options.serviceType, SERVICE_TYPE);
  });

  test("T8: a lifetime that had already ended rejects both promises with its reason", async () => {

    await assertNoUnhandledRejections(async () => {

      const controller = new AbortController();
      const reason = new HbpuAbortError("shutdown");

      controller.abort(reason);

      const events: MdnsBrowserEvent[] = [];
      const browser = new TestMdnsBrowser(options(events, controller.signal));

      assert.equal(browser.aborted, true);
      await assert.rejects(browser.ready, (error: unknown) => error === reason);
      await assert.rejects(browser.settled, (error: unknown) => error === reason);
    });
  });
});

describe("makeService", () => {

  test("T9: the composed service reads its names, its endpoint, and its TXT off the records the same options advertise, and holds addresses of its own", () => {

    const addresses: readonly [string, ...string[]] = [ "192.0.2.50", "fe80::1" ];
    const options = { addresses, host: "gdo", instance: "Garage Door", port: 6053, serviceType: "_esphomelib._tcp", strings: ["mac=aabbccddeeff"] };
    const advertised = makeServiceRecords(options);
    const derived = makeService(options);
    const ptr = expectAt(advertised, 0, "the PTR of the advertisement");
    const srv = expectAt(advertised, 1, "the SRV of the advertisement");
    const txt = expectAt(advertised, 2, "the TXT of the advertisement");

    // One set of options describes one instance in both spellings, because the service is read off these very records rather than composed beside them.
    assert.ok((ptr.kind === "ptr") && (srv.kind === "srv") && (txt.kind === "txt"), "the advertisement leads with its PTR, SRV, and TXT");
    assert.deepEqual(derived.name, ptr.target, "the instance name is what the PTR points at");
    assert.deepEqual(derived.host, srv.target, "the host is what the SRV targets");
    assert.equal(derived.port, srv.port);
    assert.deepEqual(derived.txt, txt, "the TXT record is the one the advertisement carries");
    assert.equal(derived.instance, "Garage Door", "the instance label is the first label of the name");

    // The service holds its own list rather than a view over the caller's, so an array a test reuses cannot reach inside a service it already handed over.
    assert.deepEqual(derived.addresses, [ "192.0.2.50", "fe80::1" ]);
    assert.notEqual(derived.addresses, addresses);
  });
});
