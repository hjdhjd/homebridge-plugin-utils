/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/browser.helpers.ts: The datagram-socket double and the rig the mDNS browser's own suite drives it through.
 */

/**
 * The socket double the browser's suite drives, and the rig that assembles a browser around it.
 *
 * The browser reaches its socket through {@link mdns/browser!MdnsSocketFactory | MdnsSocketFactory}, which is what lets this double stand where `node:dgram` would:
 * the suite then drives the cadence, the known-answer suppression, the cache and its maintenance, the holds, and the memberships with no network and no wall
 * clock at all. It records what the browser did - which ports it bound, which groups it joined and was refused, which interface each datagram left under, and
 * the datagram itself - and it delivers what a row says the network said.
 *
 * This double stays here rather than shipping on the testing entry point because nothing outside this module's own suite drives a browser at the socket. A
 * consumer substitutes one level up, at the browser factory, where `TestMdnsBrowser` stands in; a `*.helpers.ts` file reaches neither the published package nor
 * the published documentation.
 *
 * @module
 */
import type { MdnsBrowserEvent, MdnsBrowserOptions, MdnsInterfaceSource, MdnsSocket, MdnsSocketFactory } from "./browser.ts";
import { expectAt, settle, silentLog } from "../testing/index.ts";
import type { IpFamily } from "../dgram-util.ts";
import { MdnsBrowser } from "./browser.ts";
import type { NetworkInterfaceInfo } from "node:os";
import type { Nullable } from "../util.ts";
import type { RemoteInfo } from "node:dgram";
import { TestClock } from "../clock-double.ts";

/**
 * One datagram the browser handed the socket, with the interface that was current when it did.
 */
export interface TestMdnsSend {

  readonly address: string;
  readonly datagram: Buffer;
  readonly interfaceAddress: Nullable<string>;
  readonly port: number;
}

/**
 * Everything a row needs to drive one browser: the browser, the timeline it lives on, the events its sink collected, and the sockets underneath it - every one
 * in creation order, with `socket` the first of them, which is the only one a single-family row has.
 */
export interface TestBrowserRig {

  readonly browser: MdnsBrowser;
  readonly clock: TestClock;
  readonly events: MdnsBrowserEvent[];
  readonly socket: TestMdnsSocket;
  readonly sockets: readonly TestMdnsSocket[];
}

/**
 * What a row wants of the rig itself rather than of the browser it builds: which sockets come up, and which refuse their bind.
 */
export interface TestBrowserRigOptions {

  /**
   * An error per family whose bind is to be refused. The factory sets it on that family's socket at creation, because the browser binds inside its own
   * constructor and a row cannot reach {@link TestBrowserRig.sockets} until that returns.
   */
  readonly failBind?: Partial<Record<IpFamily, Error>>;

  /**
   * Which families the rig brings up with `emitListening()`, in creation order, before it settles. Defaults to every socket whose bind the row did not refuse,
   * so the rig never brings up a socket the constructor has already dropped. A row that wants another ordering names fewer here and emits the rest itself.
   */
  readonly listening?: readonly IpFamily[];
}

/**
 * A datagram socket double: it records what the browser did to it and delivers what a row says arrived.
 */
export class TestMdnsSocket implements MdnsSocket {

  // Every port `bind` was called with, which is empty for a browser that never got as far as binding.
  public readonly bound: number[] = [];

  // Every address `setMulticastInterface` was called with, in order, so a row reads which link each datagram left under.
  public readonly interfaces: string[] = [];

  // Every address `addMembership` was called with, refused ones included, so a row reads that a refusal was retried.
  public readonly joinAttempts: string[] = [];

  // The addresses the group is currently joined on, in the order they were joined, with a dropped one removed.
  public readonly memberships: string[] = [];

  // The addresses `addMembership` refuses, which a row fills to make a join fail.
  public readonly refuseJoin = new Set<string>();

  // Every datagram sent, in order.
  public readonly sent: TestMdnsSend[] = [];

  // Whether `close` has been called.
  public closed = false;

  /* When set, `close()` marks the socket closed and holds its close event for {@link TestMdnsSocket.emitClose}, so a row can observe a disposal that is still
   * waiting on this socket. Unset, a close delivers on a microtask, which is what every row that simply disposes relies on.
   */
  public deferClose = false;

  // When set to an error, `bind()` records the port and then delivers that error to the error listeners inside the call itself, which is the shape a bind the
  // kernel refuses has on the platform socket.
  public failBind: Nullable<Error> = null;

  // What `setMulticastLoopback` was last told, and `null` until it is told anything.
  public loopback: Nullable<boolean> = null;

  // What `setMulticastTTL` was last told, and `null` until it is told anything.
  public ttl: Nullable<number> = null;

  readonly #closeListeners: (() => void)[] = [];
  readonly #errorListeners: ((error: Error) => void)[] = [];
  readonly #listeningListeners: (() => void)[] = [];
  readonly #messageListeners: ((datagram: Buffer, rinfo: RemoteInfo) => void)[] = [];

  // The interface currently set, which is what the next send is recorded under.
  #interface: Nullable<string> = null;

  // What `close` was given, held until the close event is delivered.
  #closeCallback: (() => void) | undefined = undefined;

  public addMembership(group: string, address?: string): void {

    // A join with no address named leaves the choice of link to the operating system, which this double records as the empty address rather than as the group.
    const link = address ?? "";

    this.joinAttempts.push(link);

    if(this.refuseJoin.has(link)) {

      throw new Error("addMembership: the group " + group + " cannot be joined on " + link + ".");
    }

    this.memberships.push(link);
  }

  public bind(port: number, callback?: () => void): void {

    this.bound.push(port);

    // A bind the kernel refuses reaches the browser as this socket's error event, raised inside the `bind()` call rather than thrown out of it.
    if(this.failBind !== null) {

      this.emitError(this.failBind);

      return;
    }

    callback?.();
  }

  public close(callback?: () => void): void {

    this.closed = true;
    this.#closeCallback = callback;

    if(this.deferClose) {

      return;
    }

    queueMicrotask(() => this.emitClose());
  }

  public dropMembership(group: string, address?: string): void {

    const index = this.memberships.indexOf(address ?? "");

    if(index === -1) {

      throw new Error("dropMembership: the group " + group + " is not joined on " + (address ?? "") + ".");
    }

    this.memberships.splice(index, 1);
  }

  public on(event: "close" | "listening", listener: () => void): this;
  public on(event: "error", listener: (error: Error) => void): this;
  public on(event: "message", listener: (datagram: Buffer, rinfo: RemoteInfo) => void): this;
  public on(event: "close" | "error" | "listening" | "message", listener: unknown): this {

    // Each branch casts the untyped listener to the shape its own event carries. The cast is safe because the declarations above constrain every caller to pass
    // a listener already shaped for the event it names; this broader signature exists only to unify them for the switch.
    switch(event) {

      case "close": {

        this.#closeListeners.push(listener as () => void);

        break;
      }

      case "error": {

        this.#errorListeners.push(listener as (error: Error) => void);

        break;
      }

      case "listening": {

        this.#listeningListeners.push(listener as () => void);

        break;
      }

      case "message": {

        this.#messageListeners.push(listener as (datagram: Buffer, rinfo: RemoteInfo) => void);

        break;
      }
    }

    return this;
  }

  public send(datagram: Buffer, port: number, address: string, callback?: (error: Nullable<Error>) => void): void {

    this.sent.push({ address, datagram, interfaceAddress: this.#interface, port });
    queueMicrotask(() => callback?.(null));
  }

  public setMulticastInterface(address: string): void {

    this.#interface = address;
    this.interfaces.push(address);
  }

  public setMulticastLoopback(flag: boolean): void {

    this.loopback = flag;
  }

  public setMulticastTTL(ttl: number): void {

    this.ttl = ttl;
  }

  // Bring the socket up, which is what a row does in place of a kernel answering a bind.
  public emitListening(): void {

    for(const listener of [...this.#listeningListeners]) {

      listener();
    }
  }

  // Deliver one datagram, from a source the row can name and otherwise from an address that is plainly a fixture.
  public emitMessage(datagram: Buffer, rinfo: RemoteInfo = { address: "192.0.2.10", family: "IPv4", port: 5353, size: datagram.length }): void {

    for(const listener of [...this.#messageListeners]) {

      listener(datagram, rinfo);
    }
  }

  // Deliver the close event: the callback `close` was given, then the close listeners. A row calls this where `deferClose` is set and the close is being held.
  public emitClose(): void {

    const callback = this.#closeCallback;

    this.#closeCallback = undefined;
    callback?.();

    for(const listener of [...this.#closeListeners]) {

      listener();
    }
  }

  // Fail the socket.
  public emitError(error: Error): void {

    for(const listener of [...this.#errorListeners]) {

      listener(error);
    }
  }
}

/**
 * A socket-factory double that records every call and answers a fresh {@link TestMdnsSocket}.
 */
export class TestMdnsSocketFactory {

  // Every create call's family and the socket it answered, in order.
  public readonly createCalls: { ipFamily: IpFamily; socket: TestMdnsSocket }[] = [];

  readonly #failBind: Partial<Record<IpFamily, Error>>;

  /**
   * Construct a factory.
   *
   * @param options           - What the factory is to do beyond answering sockets.
   * @param options.failBind  - An error per family whose bind is to be refused, set on that family's socket before it is answered. Defaults to none.
   */
  public constructor({ failBind = {} }: { readonly failBind?: Partial<Record<IpFamily, Error>> } = {}) {

    this.#failBind = failBind;
  }

  /**
   * The factory function this double exposes, bound as a property so it can be handed straight to the browser without losing `this`.
   *
   * @param ipFamily - The address family the browser asked for.
   *
   * @returns The socket double.
   */
  public readonly create: MdnsSocketFactory = (ipFamily: IpFamily): MdnsSocket => {

    const socket = new TestMdnsSocket();

    // Set before the socket is answered, because the browser binds inside its own constructor and a row cannot reach the socket until that call returns.
    socket.failBind = this.#failBind[ipFamily] ?? null;
    this.createCalls.push({ ipFamily, socket });

    return socket;
  };
}

/**
 * An interface source answering the addresses a row names, each family's list indexed by the link it sits on: index `i` is the link `en<i>`, carrying that
 * index's IPv4 address when the row named one and that index's IPv6 link-local address, with scope id `i + 1`, when it named one, so a row that names both
 * describes a host whose link answers on both families. The first IPv6 link also carries the global `2001:db8::1`, which is no multicast link and would name
 * the same designation anyway.
 *
 * Two entries stand beside them for the filters to reject, whatever a row names. `lo0` is the loopback: an IPv4 address, the IPv6 loopback whose scope id is
 * zero, and an internal link-local address whose scope id is one, which only the internal test rejects. `utun0` carries a unique-local IPv6 address whose scope
 * id is zero and which is not internal, so it is a link of neither family - the IPv4 filter rejects it on its family and the IPv6 filter on its scope id.
 *
 * @param addresses        - The links the host is to report.
 * @param addresses.ipv4   - The IPv4 addresses, in order. An address's position names the link it sits on, so a row that drops one leaves every survivor on the
 *                           link it was already named by. Defaults to none.
 * @param addresses.ipv6   - The IPv6 link-local addresses, in order, read the same way. Defaults to none.
 *
 * @returns The source, ready to be handed to a browser.
 */
export function fixedInterfaces({ ipv4 = [], ipv6 = [] }: { readonly ipv4?: readonly string[]; readonly ipv6?: readonly string[] }): MdnsInterfaceSource {

  return (): NodeJS.Dict<NetworkInterfaceInfo[]> => {

    const links: NodeJS.Dict<NetworkInterfaceInfo[]> = {

      lo0: [ { address: "127.0.0.1", cidr: "127.0.0.1/8", family: "IPv4", internal: true, mac: "00:00:00:00:00:00", netmask: "255.0.0.0" },
        { address: "::1", cidr: "::1/128", family: "IPv6", internal: true, mac: "00:00:00:00:00:00",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", scopeid: 0 },
        { address: "fe80::1", cidr: "fe80::1/64", family: "IPv6", internal: true, mac: "00:00:00:00:00:00", netmask: "ffff:ffff:ffff:ffff::", scopeid: 1 } ],
      utun0: [{ address: "fd00::1", cidr: "fd00::1/64", family: "IPv6", internal: false, mac: "00:00:00:00:00:00", netmask: "ffff:ffff:ffff:ffff::",
        scopeid: 0 }]
    };

    // The index is what names the link, so the two lists have to be walked together rather than one after the other.
    for(let index = 0; index < Math.max(ipv4.length, ipv6.length); index++) {

      const entries: NetworkInterfaceInfo[] = [];
      const mac = "02:00:00:00:00:0" + index.toString();
      const v4 = ipv4[index];
      const v6 = ipv6[index];

      if(v4 !== undefined) {

        entries.push({ address: v4, cidr: v4 + "/24", family: "IPv4", internal: false, mac, netmask: "255.255.255.0" });
      }

      if(v6 !== undefined) {

        entries.push({ address: v6, cidr: v6 + "/64", family: "IPv6", internal: false, mac, netmask: "ffff:ffff:ffff:ffff::", scopeid: index + 1 });
      }

      // The first IPv6 link carries what a real one does beside its link-local address: a global address, rejected on a link whose link-local entry is admitted
      // in the same walk.
      if((v6 !== undefined) && (index === 0)) {

        entries.push({ address: "2001:db8::1", cidr: "2001:db8::1/64", family: "IPv6", internal: false, mac, netmask: "ffff:ffff:ffff:ffff::", scopeid: 0 });
      }

      links["en" + index.toString()] = entries;
    }

    return links;
  };
}

/**
 * Build a browser on a virtual timeline over socket doubles, bring it up, and answer everything a row drives it through.
 *
 * The rig serves one family, IPv4, unless a row says otherwise. That is the rig's own default rather than the library's, which is both families: a row here
 * asserts what one socket put on the wire, and giving every row a second socket would change what every one of them reads. A dual row names `ipFamilies` and
 * the links of both families itself.
 *
 * @param overrides            - Whatever this row wants instead of the defaults: another interface source, a capturing log, a fixed reading for the spreads, a
 *                               service type, a lifetime of its own, the families to serve.
 * @param overrides.failBind   - See {@link TestBrowserRigOptions.failBind}.
 * @param overrides.listening  - See {@link TestBrowserRigOptions.listening}.
 *
 * @returns The browser, its clock, the events its sink has collected, and its sockets.
 */
export async function makeBrowser({ failBind, listening, ...overrides }: Partial<MdnsBrowserOptions> & TestBrowserRigOptions = {}): Promise<TestBrowserRig> {

  const clock = new TestClock();
  const events: MdnsBrowserEvent[] = [];
  const factory = new TestMdnsSocketFactory({ failBind });
  const browser = new MdnsBrowser({

    clock,
    interfaces: fixedInterfaces({ ipv4: ["192.0.2.1"] }),
    ipFamilies: ["ipv4"],
    log: silentLog(),
    onEvent: (event: MdnsBrowserEvent): void => {

      events.push(event);
    },
    random: (): number => 0,
    serviceType: "_esphomelib._tcp.local",
    signal: new AbortController().signal,
    socketFactory: factory.create,
    ...overrides
  });

  // A socket the constructor already dropped is never brought up, so the rig's default never contradicts what the row asked of the bind.
  const brought = listening ?? factory.createCalls.filter((call) => call.socket.failBind === null).map((call) => call.ipFamily);

  for(const call of factory.createCalls) {

    if(brought.includes(call.ipFamily)) {

      call.socket.emitListening();
    }
  }

  await settle();

  const sockets = factory.createCalls.map((call) => call.socket);

  return { browser, clock, events, socket: expectAt(sockets, 0, "the first socket the browser created"), sockets };
}
