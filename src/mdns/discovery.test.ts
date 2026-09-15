/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/discovery.test.ts: Unit tests for the discovery surface - the consumer's classification and the guard around it, the live device snapshot, the order a
 * consumer reads transitions in, the single iteration the stream offers, and the lifetime it shares with the browser underneath it. Every row drives the
 * shipped browser double, so what is asserted is the projection alone.
 */
import type { DiscoverServicesOptions, MdnsDiscovery, MdnsDiscoveryEvent } from "./discovery.ts";
import type { MdnsBrowserEvent, MdnsBrowserOptions, MdnsService } from "./browser.ts";
import { TestMdnsBrowserFactory, makeService } from "./browser-double.ts";
import { assertNoUnhandledRejections, capturingLog, expectAt, logCount, settle, silentLog } from "../testing/index.ts";
import { describe, test } from "node:test";
import { dnsNameKey, txtEntries } from "./message.ts";
import { HbpuAbortError } from "../util.ts";
import type { Nullable } from "../util.ts";
import type { TestMdnsBrowser } from "./browser-double.ts";
import assert from "node:assert/strict";
import { discoverServices } from "./discovery.ts";

const SERVICE_TYPE = "_esphomelib._tcp.local";

// What a plugin makes of a service: its own device, keyed by the address it found on the wire, or nothing at all for a service it does not recognize.
interface TestDevice {

  readonly mac: string;
}

// One resolved service, built by the shipped composer so the shape a row delivers is the shape a browser derives from the same advertisement. A row that wants a
// service its classification rejects leaves the TXT record without the entry the classification reads.
function service({ instance = "Garage Door", port = 6053, strings = ["mac=aabbccddeeff"] }: { instance?: string; port?: number;
  strings?: readonly string[]; } = {}): MdnsService {

  return makeService({ addresses: ["192.0.2.50"], host: "gdo", instance, port, serviceType: "_esphomelib._tcp", strings });
}

// The consumer's own classification: the device this plugin would build from a service, and `null` for one it does not want.
function classify(found: MdnsService): Nullable<TestDevice> {

  const mac = txtEntries(found.txt).get("mac");

  return (typeof mac === "string") ? { mac } : null;
}

// A discovery over the shipped double, with the double it was built on beside it.
function discovery(overrides: Partial<MdnsBrowserOptions> = {}): { browser: TestMdnsBrowser; devices: MdnsDiscovery<TestDevice>;
  factory: TestMdnsBrowserFactory; } {

  const factory = new TestMdnsBrowserFactory();
  const devices = discoverServices<TestDevice>({ browserFactory: factory, classify, log: silentLog(), serviceType: SERVICE_TYPE,
    signal: new AbortController().signal, ...overrides });

  return { browser: expectAt(factory.createCalls, 0, "the browser the discovery built").browser, devices, factory };
}

// The next transition a consumer's loop would be given.
async function nextEvent(iterator: AsyncIterator<MdnsDiscoveryEvent<TestDevice>>): Promise<MdnsDiscoveryEvent<TestDevice>> {

  const result = await iterator.next();

  assert.ok(!result.done, "the stream ended where an event was expected");

  return result.value;
}

describe("discoverServices - projection", () => {

  test("S1: a found service is a found device, and the snapshot holds it before anything has read the stream", async () => {

    const { browser, devices } = discovery();
    const found = service();

    browser.found(found);

    // The projection runs as the browser derives the transition, which is what makes the snapshot a reading of the network rather than of the consumer's loop.
    assert.deepEqual([...devices.devices.entries()], [[ dnsNameKey(found.name), { mac: "aabbccddeeff" } ]]);
    assert.deepEqual(await nextEvent(devices[Symbol.asyncIterator]()), { device: { mac: "aabbccddeeff" }, kind: "found", service: found });
    devices.abort();
  });

  test("S2: an updated service carries the service as it was and the device as it now reads", async () => {

    const { browser, devices } = discovery();
    const first = service({ strings: ["mac=aabbccddeeff"] });
    const second = service({ port: 6060, strings: ["mac=001122334455"] });
    const iterator = devices[Symbol.asyncIterator]();

    browser.found(first);
    browser.updated(second);
    assert.equal((await nextEvent(iterator)).kind, "found");
    assert.deepEqual(await nextEvent(iterator), { device: { mac: "001122334455" }, kind: "updated", previous: first, service: second });
    assert.deepEqual([...devices.devices.values()], [{ mac: "001122334455" }]);
    devices.abort();
  });

  test("S3: transitions produced while the consumer is waiting are read in the order they were produced", async () => {

    const { browser, devices } = discovery();
    const found = service();
    const iterator = devices[Symbol.asyncIterator]();

    // The consumer is parked on an empty queue, and two transitions arrive before it wakes: a queue is what keeps the second from overtaking the first.
    const parked = iterator.next();

    browser.found(found);
    browser.lost(found.name);

    const first = await parked;

    assert.ok(!first.done);
    assert.equal(first.value.kind, "found");
    assert.deepEqual(await nextEvent(iterator), { device: { mac: "aabbccddeeff" }, kind: "lost" });
    assert.equal(devices.devices.size, 0);
    devices.abort();
  });

  test("S4: a service the plugin does not want is never mentioned and never held", async () => {

    const { browser, devices } = discovery();

    browser.found(service({ strings: ["project_name=something.else"] }));
    assert.equal(devices.devices.size, 0);

    // Nothing is queued either, which is what the stream ending quietly on abort proves.
    devices.abort();

    const iterator = devices[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).done, true);
  });

  test("S5: a device whose service stops classifying is a device lost, carrying the device that was held", async () => {

    const { browser, devices } = discovery();
    const iterator = devices[Symbol.asyncIterator]();

    browser.found(service());
    browser.updated(service({ strings: ["project_name=something.else"] }));
    assert.equal((await nextEvent(iterator)).kind, "found");
    assert.deepEqual(await nextEvent(iterator), { device: { mac: "aabbccddeeff" }, kind: "lost" });
    assert.equal(devices.devices.size, 0);
    devices.abort();
  });

  test("S6: a classification that throws is reported once and reads as no device", async () => {

    const log = capturingLog();
    const factory = new TestMdnsBrowserFactory();
    const devices = discoverServices<TestDevice>({

      browserFactory: factory,
      classify: (): Nullable<TestDevice> => {

        throw new Error("the plugin's own defect");
      },
      log,
      serviceType: SERVICE_TYPE,
      signal: new AbortController().signal
    });
    const browser = expectAt(factory.createCalls, 0, "the browser").browser;

    // The throw belongs to the consumer, and it is that service's answer rather than something that unwinds into the browser's own caching pass.
    browser.found(service());
    assert.equal(logCount(log.entries, "error", "Classifying the mDNS service Garage Door failed"), 1);
    assert.equal(devices.devices.size, 0);
    assert.equal(browser.services.size, 1, "the browser still holds what it found");
    devices.abort();
  });

  test("S10: losing a service that never became a device says nothing", async () => {

    const { browser, devices } = discovery();
    const unwanted = service({ strings: ["project_name=something.else"] });

    browser.found(unwanted);
    browser.lost(unwanted.name);
    assert.equal(devices.devices.size, 0);
    devices.abort();

    const iterator = devices[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).done, true);
  });
});

describe("discoverServices - lifetime", () => {

  test("S7: the discovery is the browser's lifetime, and ending it ends the consumer's loop without a throw", async () => {

    await assertNoUnhandledRejections(async () => {

      const { browser, devices, factory } = discovery();
      const seen: string[] = [];

      browser.found(service());
      browser.settle();
      await devices.settled;

      assert.equal(devices.signal, browser.signal);
      assert.equal(factory.createCalls.length, 1);
      assert.equal(expectAt(factory.createCalls, 0, "the create call").options.serviceType, SERVICE_TYPE);

      const reading = (async (): Promise<void> => {

        for await (const event of devices) {

          seen.push(event.kind);
        }
      })();

      devices.abort();
      await reading;
      assert.deepEqual(seen, ["found"]);
      assert.equal(browser.aborted, true);
      assert.ok(browser.signal.reason instanceof HbpuAbortError);
    });
  });

  test("S8: with no factory named, the discovery builds the browser the library ships", async () => {

    await assertNoUnhandledRejections(async () => {

      const controller = new AbortController();
      const reason = new HbpuAbortError("shutdown");

      controller.abort(reason);

      // A lifetime that has already ended binds no socket, which is what lets this row prove the default construction without touching a network.
      const production = discoverServices<TestDevice>({ classify, log: silentLog(), serviceType: SERVICE_TYPE, signal: controller.signal });

      await assert.rejects(production.settled, (error: unknown) => error === reason);
      assert.equal(production.signal.aborted, true);

      // The same call with a factory named reaches the double instead, which is what makes the boundary a consumer's to substitute at.
      const factory = new TestMdnsBrowserFactory();
      const substituted = discoverServices<TestDevice>({ browserFactory: factory, classify, log: silentLog(), serviceType: SERVICE_TYPE,
        signal: new AbortController().signal });

      assert.equal(factory.createCalls.length, 1);
      substituted.abort();
      await production[Symbol.asyncDispose]();
    });
  });

  test("S9: a browser that failed ends the loop quietly and says why through the reason", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const { browser, devices } = discovery({ log });
      const cause = new Error("the socket went");
      const seen: string[] = [];
      const reading = (async (): Promise<void> => {

        for await (const event of devices) {

          seen.push(event.kind);
        }
      })();

      browser.abort(new HbpuAbortError("failed", { cause }));
      await reading;

      // The envelope is for a defect in the drain itself: a browser fault ends the lifetime, and the browser has already written the line about it.
      assert.equal(log.entries.filter((entry) => entry.level === "error").length, 0);
      assert.deepEqual(seen, []);

      const observed: unknown = devices.signal.reason;

      assert.ok(observed instanceof HbpuAbortError);
      assert.equal(observed.name, "failed");
      assert.equal(observed.cause, cause);
    });
  });

  test("S11: the stream is read once, and what happens after it has been read still reaches the snapshot", async () => {

    const { browser, devices } = discovery();
    const seen: string[] = [];

    browser.found(service({ instance: "First" }));

    for await (const event of devices) {

      seen.push(event.kind);

      break;
    }

    // The queue closes with the consumer's one iteration, and the snapshot goes on being what the browser has said.
    browser.found(service({ instance: "Second", strings: ["mac=001122334455"] }));
    assert.equal(devices.devices.size, 2);

    for await (const event of devices) {

      seen.push(event.kind);
    }

    assert.deepEqual(seen, ["found"]);
    devices.abort();
  });

  test("S13: an event queued behind the one a consumer stops on is not delivered by a later iteration", async () => {

    const { browser, devices } = discovery();
    const seen: string[] = [];

    browser.found(service({ instance: "First" }));
    browser.found(service({ instance: "Second", strings: ["mac=001122334455"] }));
    assert.equal(devices.devices.size, 2);

    for await (const event of devices) {

      seen.push(event.kind);

      break;
    }

    assert.deepEqual(seen, ["found"]);

    // The consumer's one iteration ended on that break, and the event it never reached is not what a later loop is given: the stream is read once, and the
    // snapshot is where the rest of what the browser said lives.
    for await (const event of devices) {

      seen.push(event.kind);
    }

    assert.deepEqual(seen, ["found"]);
    assert.equal(devices.devices.size, 2);
    devices.abort();
  });

  test("S14: an event published in the same frame as the abort is delivered before the stream ends", async () => {

    const { browser, devices } = discovery();
    const iterator = devices[Symbol.asyncIterator]();
    const parked = iterator.next();

    await settle();

    // Both land in one synchronous frame, with the consumer's read parked. The queue is read before the signal, so what was published before the abort is handed
    // over even though the lifetime ended in the same frame it was published in.
    browser.found(service({ instance: "First" }));
    devices.abort();

    const delivered = await parked;

    assert.ok(!delivered.done, "the stream ended where the event published in the abort's frame was expected");
    assert.equal(delivered.value.kind, "found");

    const afterwards = await iterator.next();

    assert.equal(afterwards.done, true);
  });

  test("S12: the levers that belong to the browser's own suite are not on the surface a plugin reads", () => {

    /* Each directive is an assertion: the surface omits what a plugin has no business setting, and the typecheck gate fails the day one of them stops being
     * omitted and leaves its directive unused. The bindings are compile-time only, which their leading underscores mark.
     */
    const base = { classify, log: silentLog(), serviceType: SERVICE_TYPE, signal: new AbortController().signal };
    const _interfaces: DiscoverServicesOptions<TestDevice> = {

      ...base,
      // @ts-expect-error - the interface source belongs to the browser's own suite.
      interfaces: () => ({})
    };
    const _onEvent: DiscoverServicesOptions<TestDevice> = {

      ...base,
      // @ts-expect-error - the sink is the surface's own.
      onEvent: (_event: MdnsBrowserEvent) => undefined
    };
    const _random: DiscoverServicesOptions<TestDevice> = {

      ...base,
      // @ts-expect-error - the spread source belongs to the browser's own suite.
      random: () => 0
    };
    const _socketFactory: DiscoverServicesOptions<TestDevice> = {

      ...base,
      // @ts-expect-error - the socket boundary belongs to the browser's own suite.
      socketFactory: () => undefined
    };
  });
});
