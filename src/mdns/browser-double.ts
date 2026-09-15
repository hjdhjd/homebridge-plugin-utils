/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/browser-double.ts: A socket-free MdnsBrowser test double - the service store and the delivery verbs, with no network behind them.
 */

/**
 * A socket-free {@link mdns/browser!MdnsBrowser | MdnsBrowser} test double.
 *
 * A plugin that discovers devices over mDNS has one thing worth asserting about: what its own `classify` makes of a service, what its device map holds
 * afterwards, and what its loop is told in which order. This module ships the double for that - a {@link TestMdnsBrowser} whose verbs deliver a found, an
 * updated, and a lost transition on demand, with no socket, no group membership, no clock, and no wire format anywhere in sight.
 *
 * The double stands in for the browser, it does not reimplement a querier. What it mirrors is the contract a consumer above it can observe: the synchronous
 * sink, the service store the verbs read and write, the lifetime signal and the reason a verb on a dead browser throws, and the readiness and warmup promises
 * including their rejection when the lifetime ends first. What stays with the real class and its own suite is everything the protocol owns - the cadence, the
 * known-answer suppression, the cache and its maintenance, the holds, resolution, and membership.
 *
 * The verbs refuse a misuse rather than modeling it: finding an instance that is already present, or updating or losing one that was never found, is a test
 * describing a sequence no browser produces, and it throws an `Error` saying so.
 *
 * {@link makeService} sits beside the double as the composer of what those verbs deliver: it reads one resolved service off the very records
 * {@link mdns/message-builders!makeServiceRecords | makeServiceRecords} builds for the same options, so an advertisement put on the wire and a service handed to
 * a verb describe one instance rather than two spellings of it. It lives here rather than with the record builders because `message-builders.ts` depends
 * downward on the wire format alone and knows nothing of a browser's resolved shape.
 *
 * Signatures come from the browser's own exported types, imported for their types alone, so a verb here cannot drift from the contract it stands in for without
 * the compiler saying so. That type-only edge is also what keeps this module free of `node:dgram`: a consumer's test loads the double without opening a socket.
 *
 * @module
 */
import type { DnsName, DnsPtrRecord, DnsRecord, DnsSrvRecord, DnsTxtRecord } from "./message.ts";
import { HbpuAbortError, composeSignals, onAbort } from "../util.ts";
import type { MdnsBrowserFactory, MdnsBrowserLike, MdnsBrowserOptions, MdnsService } from "./browser.ts";
import type { MdnsServiceFixture } from "./message-builders.ts";
import { dnsNameKey } from "./message.ts";
import { makeServiceRecords } from "./message-builders.ts";
import { markHandled } from "../mark-handled.ts";

/**
 * Compose the resolved service a browser derives from the records {@link mdns/message-builders!makeServiceRecords | makeServiceRecords} builds for the same
 * options, which is what a row hands the delivery verbs of {@link TestMdnsBrowser}.
 *
 * Every name is read off those records rather than spelled a second time here: the PTR's target is the instance name, the SRV's target and port are the host and
 * the port, and the TXT record is the TXT record. A test that advertises an instance with the record builder and delivers it with this one therefore describes
 * one instance by construction. `addresses` is a fresh copy of what was named, and the type refuses a service with none, which is the browser's own rule that an
 * instance resolves only once its host has an address.
 *
 * @param options - The instance, carrying at least one address. See {@link mdns/message-builders!MdnsServiceFixture | MdnsServiceFixture}.
 *
 * @returns The service as a browser would have derived it from that advertisement.
 *
 * @category Testing
 */
export function makeService(options: MdnsServiceFixture & { readonly addresses: readonly [string, ...string[]] }): MdnsService {

  /* The builder answers one PTR, one SRV, and one TXT for the instance, in that order, ahead of its address records. That order is the builder's own documented
   * contract, and reading the three positionally is what lets this compose a service without naming anything the advertisement already names.
   */
  const [ ptr, srv, txt ] = makeServiceRecords(options) as readonly [ DnsPtrRecord, DnsSrvRecord, DnsTxtRecord, ...DnsRecord[] ];

  // The instance name is what the PTR points at, and the builder places the instance label at its head, so the name carries at least that one label.
  const name = ptr.target as readonly [string, ...string[]];

  return { addresses: [...options.addresses], host: srv.target, instance: name[0], name, port: srv.port, txt };
}

/**
 * A socket-free {@link mdns/browser!MdnsBrowser | MdnsBrowser} double: it delivers the transitions a test names, in the order the test names them.
 *
 * @example
 *
 * ```ts
 * import { TestMdnsBrowserFactory } from "homebridge-plugin-utils/testing";
 *
 * const factory = new TestMdnsBrowserFactory();
 * const discovery = discoverServices({ browserFactory: factory, classify, log, serviceType: "_esphomelib._tcp.local", signal });
 * const browser = expectAt(factory.createCalls, 0, "the browser the discovery built").browser;
 *
 * // The consumer's own classify, snapshot, and ordering, exercised with no network at all.
 * browser.found(service);
 * assert.equal(discovery.devices.size, 1);
 * ```
 *
 * @category Testing
 */
export class TestMdnsBrowser implements MdnsBrowserLike {

  /**
   * The options this double was constructed with, exposed so a test can assert on what the consumer asked for - its service type above all.
   */
  public readonly options: MdnsBrowserOptions;

  /**
   * Mirrors {@link mdns/browser!MdnsBrowser.ready | MdnsBrowser.ready}, and marked handled as that one is. A double is listening the moment it exists, so this
   * resolves at construction; one built over a lifetime that had already ended rejects with that lifetime's reason, exactly as the real class does when it never
   * gets to bind.
   */
  public readonly ready: Promise<void>;

  /**
   * The services this double currently holds, keyed by the folded instance name. It is the same store the verbs read and write, so what a test reads and what a
   * delivery meets cannot disagree.
   */
  public readonly services: ReadonlyMap<string, MdnsService>;

  /**
   * Mirrors {@link mdns/browser!MdnsBrowser.settled | MdnsBrowser.settled}, and marked handled as that one is. It stays pending until {@link TestMdnsBrowser.settle}
   * is called, because when a warmup is over is the test's decision here rather than a clock's, and it rejects with the lifetime's reason when the lifetime ends
   * first.
   */
  public readonly settled: Promise<void>;

  /**
   * The abort signal representing this double's lifetime, composed from the caller's and this double's own, mirroring the real class's composition.
   */
  public readonly signal: AbortSignal;

  readonly #controller = new AbortController();

  readonly #services = new Map<string, MdnsService>();

  readonly #settledResolvers: PromiseWithResolvers<void>;

  /**
   * Construct a double.
   *
   * @param options - The browser options the consumer passed, exactly as the real class receives them. See {@link mdns/browser!MdnsBrowserOptions}.
   */
  public constructor(options: MdnsBrowserOptions) {

    this.options = options;
    this.signal = composeSignals(options.signal, this.#controller.signal);
    this.services = this.#services;

    const readyResolvers: PromiseWithResolvers<void> = Promise.withResolvers();

    this.#settledResolvers = Promise.withResolvers();
    this.ready = markHandled(readyResolvers.promise);
    this.settled = markHandled(this.#settledResolvers.promise);

    // Registered before `ready` is resolved, so a lifetime that had already ended rejects both promises rather than resolving one of them first.
    onAbort(this.signal, () => {

      readyResolvers.reject(this.signal.reason);
      this.#settledResolvers.reject(this.signal.reason);
    });

    readyResolvers.resolve();
  }

  /**
   * Deliver a `found` transition for a service the double is not already holding.
   *
   * @param service - The service found.
   *
   * @throws The lifetime's reason once the double has aborted, and an `Error` naming the instance when it is already present.
   */
  public found(service: MdnsService): void {

    this.#refuseWhenEnded();

    const key = dnsNameKey(service.name);

    if(this.#services.has(key)) {

      throw new Error("TestMdnsBrowser: " + key + " is already present, so it cannot be found again.");
    }

    this.#services.set(key, service);
    this.options.onEvent({ kind: "found", service });
  }

  /**
   * Deliver an `updated` transition for a service the double is holding, carrying what it held as `previous`.
   *
   * @param service - The service as it currently stands.
   *
   * @throws The lifetime's reason once the double has aborted, and an `Error` naming the instance when it is not present.
   */
  public updated(service: MdnsService): void {

    this.#refuseWhenEnded();

    const key = dnsNameKey(service.name);
    const previous = this.#services.get(key);

    if(previous === undefined) {

      throw new Error("TestMdnsBrowser: " + key + " is not present, so it cannot be updated.");
    }

    this.#services.set(key, service);
    this.options.onEvent({ kind: "updated", previous, service });
  }

  /**
   * Deliver a `lost` transition for a service the double is holding, carrying the last service it held for the instance.
   *
   * @param name - The full instance name that is gone.
   *
   * @throws The lifetime's reason once the double has aborted, and an `Error` naming the instance when it is not present.
   */
  public lost(name: DnsName): void {

    this.#refuseWhenEnded();

    const key = dnsNameKey(name);
    const service = this.#services.get(key);

    if(service === undefined) {

      throw new Error("TestMdnsBrowser: " + key + " is not present, so it cannot be lost.");
    }

    this.#services.delete(key);
    this.options.onEvent({ kind: "lost", service });
  }

  /**
   * Resolve {@link TestMdnsBrowser.settled}, which is this double's stand-in for the real browser's warmup window elapsing. A double whose lifetime has already
   * ended has a rejected promise, so a call here is inert rather than a second settlement.
   */
  public settle(): void {

    this.#settledResolvers.resolve();
  }

  /**
   * Abort the double, mirroring {@link mdns/browser!MdnsBrowser.abort | MdnsBrowser.abort}: it defaults to `HbpuAbortError("shutdown")` when no reason is supplied,
   * and explicit reasons pass through unchanged. Safe to call more than once. Afterwards every delivery verb refuses.
   *
   * @param reason - Optional abort reason. See {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation, mirroring the real class's: it aborts the double, defaulting to `"shutdown"`. There is no socket to wait on, so it
   * resolves once the abort has run.
   *
   * @returns A promise that resolves once the abort has run.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  // A delivery verb on a double whose lifetime has ended answers with the reason it ended for, rather than quietly delivering to a consumer that has torn down.
  #refuseWhenEnded(): void {

    if(this.aborted) {

      throw this.signal.reason;
    }
  }
}

/**
 * An {@link mdns/browser!MdnsBrowserFactory | MdnsBrowserFactory} double that records every `create` call and answers a fresh {@link TestMdnsBrowser}, mirroring the
 * create-call-recording discipline `TestRecordingProcessFactory` and `TestLogSocketFactory` use. A test reads the recorded browser to drive it.
 *
 * @category Testing
 */
export class TestMdnsBrowserFactory implements MdnsBrowserFactory {

  /**
   * Every create call's options and the browser it answered, in order, so a test can assert the boundary was reached with the options it expected and can drive
   * the browser that came back.
   */
  public readonly createCalls: { browser: TestMdnsBrowser; options: MdnsBrowserOptions }[] = [];

  /**
   * Record the create call and answer a fresh double.
   *
   * @param options - The browser options the consumer passed.
   *
   * @returns The browser double.
   */
  public create(options: MdnsBrowserOptions): MdnsBrowserLike {

    const browser = new TestMdnsBrowser(options);

    this.createCalls.push({ browser, options });

    return browser;
  }
}
