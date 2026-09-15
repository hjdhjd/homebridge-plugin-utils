/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/discovery.ts: The plugin-facing projection of an mDNS browse into devices, ordered events, and a live snapshot.
 */

/**
 * Service discovery as a plugin wants it: a pure `classify` from a resolved service to the plugin's own device, an ordered stream of what changed, a live
 * snapshot of what is out there, and a promise that says when a first look is over.
 *
 * {@link discoverServices} is the one projection every consuming plugin would otherwise write for itself. It runs an {@link mdns/browser!MdnsBrowser | MdnsBrowser}
 * underneath, hands each transition the browser derives to the consumer's `classify`, and keeps {@link MdnsDiscovery.devices} in step with the answers: a
 * service that classifies to a device is found, a device whose service later classifies to `null` is lost, and a service that never classifies to anything is
 * never mentioned. What the consumer iterates is the same sequence in the same order, one event at a time.
 *
 * **Two lifetimes, one surface.** A plugin that browses for as long as it runs iterates the stream and acts on each event. A plugin that runs a burst per cycle
 * awaits {@link MdnsDiscovery.settled}, reads `devices`, and disposes. The snapshot is what serves the second one: it reflects every event the browser has
 * produced whether or not anything has read the stream, because the projection runs synchronously as the browser derives each transition rather than when a
 * consumer's loop gets around to it.
 *
 * **One iteration.** The queue behind the stream is open from construction until the consumer's one iteration ends, for whatever reason: events produced before
 * the first `for await` are held for it, and events produced after it ends update `devices` and are queued nowhere. A second `for await` meets a stream that has
 * already ended, as `Mp4SegmentAssembler.segments` states for its own single consumer. A consumer that reads `devices` alone and never iterates therefore holds
 * its transitions until disposal, which is the bound a one-shot cycle lives inside anyway.
 *
 * **Faults.** The stream is wrapped in the library's own envelope, so a consumer's `for await` never has to catch: it ends. Which ending it was is what
 * `signal.reason` says - an `HbpuAbortError` named `"failed"` for a browser that lost its last socket, which the browser has already written a line about, and
 * `"shutdown"` for the consumer's own teardown.
 *
 * @module
 */
import type { MdnsBrowserEvent, MdnsBrowserFactory, MdnsBrowserOptions, MdnsService } from "./browser.ts";
import { formatErrorMessage, superviseStream } from "../util.ts";
import { AsyncQueue } from "../async-queue.ts";
import type { Nullable } from "../util.ts";
import { dnsNameKey } from "./message.ts";
import { mdnsBrowserFactory } from "./browser.ts";

/**
 * What {@link discoverServices} is called with: everything an {@link mdns/browser!MdnsBrowserOptions | MdnsBrowserOptions} carries except the levers that belong to
 * the browser's own suite, plus the consumer's classification and the one boundary a consumer substitutes at.
 *
 * @typeParam T - The consumer's device type.
 *
 * @category mDNS
 */
export interface DiscoverServicesOptions<T> extends Omit<MdnsBrowserOptions, "interfaces" | "onEvent" | "random" | "socketFactory"> {

  /**
   * How the browser underneath is constructed. Defaults to `mdnsBrowserFactory`; a consumer's test passes `TestMdnsBrowserFactory` from the testing entry point
   * and exercises its own `classify`, the snapshot, and the ordering with no socket at all.
   */
  readonly browserFactory?: MdnsBrowserFactory;

  /**
   * What a resolved service means to this plugin: its own device descriptor, or `null` for a service it does not want. Called for each service found and for
   * each service that changes, and a throw is logged and read as `null`.
   */
  readonly classify: (service: MdnsService) => Nullable<T>;
}

/**
 * One change to the set of devices. A `lost` event carries the device alone, because the service behind it is exactly what is no longer there.
 *
 * @typeParam T - The consumer's device type.
 *
 * @category mDNS
 */
export type MdnsDiscoveryEvent<T> = { readonly device: T; readonly kind: "found"; readonly service: MdnsService } |
  { readonly device: T; readonly kind: "updated"; readonly previous: MdnsService; readonly service: MdnsService } |
  { readonly device: T; readonly kind: "lost" };

/**
 * A live discovery: the stream of what changed, the snapshot of what is there, and the lifetime the two share.
 *
 * @typeParam T - The consumer's device type.
 *
 * @category mDNS
 */
export interface MdnsDiscovery<T> extends AsyncIterable<MdnsDiscoveryEvent<T>>, AsyncDisposable {

  abort(reason?: unknown): void;
  readonly devices: ReadonlyMap<string, T>;
  readonly settled: Promise<void>;
  readonly signal: AbortSignal;
}

/**
 * Browse a service type and project what turns up through the consumer's own `classify`.
 *
 * @typeParam T      - The consumer's device type.
 * @param options    - The discovery's inputs. See {@link DiscoverServicesOptions}.
 *
 * @returns A live discovery, to be iterated once and disposed when the consumer is done with it.
 *
 * @throws Everything the browser's own constructor throws, since the browser is built here: a `TypeError` naming a bad option, and the encoder's `Error` for a
 * service type the wire cannot carry.
 *
 * @example
 *
 * ```ts
 * import { discoverServices } from "homebridge-plugin-utils";
 *
 * await using discovery = discoverServices({
 *
 *   classify: (service) => { const mac = txtEntries(service.txt).get("mac"); return mac ? { address: service.addresses[0], mac } : null; },
 *   log: this.log,
 *   serviceType: "_esphomelib._tcp.local",
 *   signal: this.signal
 * });
 *
 * for await (const event of discovery) {
 *
 *   this.log.info("%s: %s.", event.kind, event.device.mac);
 * }
 * ```
 *
 * @category mDNS
 */
export function discoverServices<T>(options: DiscoverServicesOptions<T>): MdnsDiscovery<T> {

  const { browserFactory = mdnsBrowserFactory, classify, ...browserOptions } = options;
  const { log, serviceType } = browserOptions;
  const devices = new Map<string, T>();
  const queue = new AsyncQueue<MdnsDiscoveryEvent<T>>();
  let open = true;

  // Hand the consumer's loop one event, while it still has a loop to hand it to.
  const publish = (event: MdnsDiscoveryEvent<T>): void => {

    if(!open) {

      return;
    }

    queue.push(event);
  };

  // A `classify` belongs to the consumer and may do anything, including throw. A throw is that service's answer - no device - and is reported once here rather
  // than being allowed to unwind into the browser, where it would land in the middle of a caching pass.
  const guardedClassify = (service: MdnsService): Nullable<T> => {

    try {

      return classify(service);
    } catch(error: unknown) {

      log.error("Classifying the mDNS service %s failed and it is treated as no device: %s.", service.instance, formatErrorMessage(error));

      return null;
    }
  };

  /* The projection, run synchronously as the browser derives each transition. What the consumer is told is decided by what `classify` answers now against what
   * this map already holds, rather than by which browser event carried it: a service that stops classifying is a device lost even though the browser called it
   * an update, and a service that never classified is nothing to lose even though the browser called it lost.
   */
  const onEvent = (event: MdnsBrowserEvent): void => {

    const key = dnsNameKey(event.service.name);
    const previous = devices.get(key);
    const device = (event.kind === "lost") ? null : guardedClassify(event.service);

    if(device === null) {

      if(previous === undefined) {

        return;
      }

      devices.delete(key);
      publish({ device: previous, kind: "lost" });

      return;
    }

    devices.set(key, device);

    if(previous === undefined) {

      publish({ device, kind: "found", service: event.service });

      return;
    }

    // Only the browser's own update carries the service as it was, which is why the narrowing is spelled out: a `found` that meets a device already held cannot
    // arise from the browser's bookkeeping, and the service it carries is the best statement of what came before.
    publish({ device, kind: "updated", previous: (event.kind === "updated") ? event.previous : event.service, service: event.service });
  };

  const browser = browserFactory.create({ ...browserOptions, onEvent });

  /* The queue yields what is queued and parks when it is empty, returning when the browser's lifetime ends, which the envelope below reads as the orderly end of
   * the stream. The `finally` is the latch: every exit from the consumer's loop - a `break`, a `return`, a throw of its own, the end of the lifetime - runs it, and
   * nothing is queued after it.
   */
  async function *drain(): AsyncGenerator<MdnsDiscoveryEvent<T>> {

    try {

      yield* queue.drain(browser.signal);
    } finally {

      open = false;
    }
  }

  /* The library's fault envelope, created once so the iterable a consumer reads is one object: a second `for await` meets the generator this one already drove
   * to completion. `onError` is reachable only by a throw from the drain itself while the lifetime is live, which would be a defect here rather than anything
   * the browser did - a browser fault aborts the shared signal instead, and the browser has already written its own line about it.
   */
  const stream = superviseStream<MdnsDiscoveryEvent<T>>({

    onError: (error: unknown): void => log.error("Service discovery for %s stopped unexpectedly: %s.", serviceType, formatErrorMessage(error)),
    signal: browser.signal,
    source: () => drain()
  });

  return {

    [Symbol.asyncDispose]: async (): Promise<void> => {

      await browser[Symbol.asyncDispose]();
    },
    [Symbol.asyncIterator]: (): AsyncIterator<MdnsDiscoveryEvent<T>> => stream[Symbol.asyncIterator](),
    abort: (reason?: unknown): void => browser.abort(reason),
    devices,
    settled: browser.settled,
    signal: browser.signal
  };
}
