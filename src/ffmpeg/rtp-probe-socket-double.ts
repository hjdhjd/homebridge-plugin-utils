/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-probe-socket-double.ts: A socket-free probe-socket test double for the RTP port allocator - a test scripts what each bind answers, with no socket
 * behind it.
 */

/**
 * A socket-free probe-socket test double for the RTP port allocator.
 *
 * {@link ffmpeg/rtp!RtpPortAllocator | RtpPortAllocator} reaches its probe sockets through an {@link RtpProbeSocketFactory}, which is what lets this double stand
 * where the package's own sockets would: every bind answers what the suite scripted, so a refused bind, a collision with a port the pool already holds, a spent
 * attempt budget and an abort while a bind is pending are each set up directly rather than waited for on a crowded host. This module ships a
 * {@link TestProbeSocketFactory} that answers each bind from its script and records the port every bind asked for, so a suite reads the allocator's probing back
 * in order, and the error a refused bind answers, built here once for every socket double the package ships.
 *
 * Signatures come from the allocator's own exported types, imported for their types alone, and the module imports nothing from the testing entry point that
 * re-exports it, so loading the double loads neither a socket nor the entry point.
 *
 * @module
 */
import type { RtpProbeSocket, RtpProbeSocketFactory } from "./rtp.ts";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { HIGHEST_UDP_PORT } from "./rtp-port.ts";
import type { Nullable } from "../util.ts";
import { yieldMacrotask } from "../clock.ts";

/**
 * What one scripted bind answers: the port the socket is bound to, or `"refused"` for a bind the kernel rejects because the port is taken. A bind to a specific
 * port is scripted with that same port, since a kernel that grants a specific bind grants exactly the port asked for, and a socket double refuses a port no
 * kernel would grant.
 *
 * @category Testing
 */
export type TestSocketBind = number | "refused";

/**
 * Check the port a scripted answer completes a bind on against what a kernel grants: a whole number from 1 to 65535 and, for a bind to a specific port, that
 * port itself. Every socket double the package ships reads its scripted ports through this one check, so the doubles refuse the same answers and none of them
 * reports a bind no kernel would grant.
 *
 * @param check               - The answer and the bind it completes.
 * @param check.answer        - The port the scripted answer completes the bind on.
 * @param check.double        - The name of the double that read the answer, which opens the error's message.
 * @param check.requestedPort - The port the bind asked for: `0` for a kernel-assigned ephemeral port, any other value for that specific port.
 *
 * @returns An `Error` naming the port no kernel would grant, and `null` when a kernel could grant it.
 *
 * @category Testing
 *
 * @internal
 */
export function bindAnswerError({ answer, double, requestedPort }: { answer: number; double: string; requestedPort: number }): Nullable<Error> {

  // The highest port UDP carries is the highest a bind can complete on.
  if(!Number.isInteger(answer) || (answer < 1) || (answer > HIGHEST_UDP_PORT)) {

    return new Error(double + ": the kernel binds a port from 1 to 65535, so a bind cannot complete on " + String(answer) + ".");
  }

  if((requestedPort !== 0) && (answer !== requestedPort)) {

    return new Error(double + ": a specific-port bind completes on the port it asked for, so it cannot complete on " + String(answer) + ".");
  }

  return null;
}

/**
 * The error a socket double answers a refused bind with: an `Error` carrying `code` `"EADDRINUSE"`, `syscall` `"bind"` and the `port` asked for, as a bind the
 * kernel refuses because the port is taken carries them. The address family is not modeled, so the message names the IPv4 any-address whatever the family asked.
 *
 * @param port - The port the refused bind asked for.
 *
 * @returns The refused bind's error.
 *
 * @category Testing
 *
 * @internal
 */
export function refusedBindError(port: number): Error & { readonly code: "EADDRINUSE"; readonly port: number; readonly syscall: "bind" } {

  return Object.assign(new Error("bind EADDRINUSE 0.0.0.0:" + port.toString()), { code: "EADDRINUSE", port, syscall: "bind" } as const);
}

// What a probe socket's bind is handed to settle it with the scripted answer, once the factory that made the socket has read that answer.
type SettleBind = (answer: TestSocketBind) => void;

// Throw a fault on the next tick, where it surfaces on Node's uncaught-exception channel rather than inside the bind that found it or the promise that carried it.
function throwLater(fault: unknown): void {

  process.nextTick(() => {

    throw fault;
  });
}

// One probe socket. The factory that made it records each bind and reads its answer, so the socket holds only the port a granted bind assigned it and whether it
// has been closed, and turns the answer into the event the allocator waits for.
class TestProbeSocket extends EventEmitter implements RtpProbeSocket {

  #closed = false;

  #port = 0;

  readonly #onBind: (port: number, settle: SettleBind) => void;

  public constructor(onBind: (port: number, settle: SettleBind) => void) {

    super();

    this.#onBind = onBind;
  }

  public address(): AddressInfo {

    return { address: "0.0.0.0", family: "IPv4", port: this.#port };
  }

  public bind(port: number): void {

    this.#onBind(port, (answer) => {

      // An answer that arrives once the socket is closed emits nothing, as a real socket closed before its bind completes emits nothing, so an abort that closed
      // the socket while its bind was pending leaves no event behind for the listeners the abort has already removed.
      if(this.#closed) {

        return;
      }

      if(answer === "refused") {

        this.emit("error", refusedBindError(port));

        return;
      }

      this.#port = answer;
      this.emit("listening");
    });
  }

  // A double holds no handle, so closing it releases nothing and only silences an answer still to arrive.
  public close(): void {

    this.#closed = true;
  }

  public unref(): void {

    // A double holds no handle, so there is nothing to keep the process open.
  }
}

/**
 * A socket-free {@link RtpProbeSocketFactory} double: each socket it makes answers its bind from a script, and the factory records the port every bind asked for.
 *
 * Each bind is answered inside `bind`, as a socket from the package's own factory answers a bind to an address literal, so an allocator over the double settles as
 * it does over its default sockets. Built with `deferred`, the double answers each bind on a later turn of the event loop instead, the timing of a substitute
 * that waits on a resolver, which an {@link RtpProbeSocketFactory} may hand the allocator, and the one timing in which an abort can land while a bind is pending.
 * The answer waits a whole turn rather than a tick, so the cleanup an abort queues has run by the time it arrives, wherever the reservation and its abort were
 * called from. A socket closed while its bind is pending emits nothing when the answer arrives, as a real socket closed before its bind completes emits nothing.
 *
 * Where it differs from the package's own sockets:
 *
 * - It binds nothing, so a granted bind holds no port and the collisions a crowded host would report are the ones the script names.
 * - It reads no address family: every socket reports the IPv4 any-address, and a refused bind's error names it, whatever family the allocator asked for.
 * - A script that runs short, or that answers a bind with a port no kernel would grant, one that is not a whole number from 1 to 65535 or another than a
 *   specific bind asked for, leaves that bind unanswered and throws an `Error` naming it on a later tick, whatever the timing, which surfaces on Node's
 *   uncaught-exception channel and fails the running test, while the reservation waiting on the bind never settles. A throw inside `bind` would reach the
 *   allocator as a refused port and pass for contention.
 *
 * @example
 *
 * ```ts
 * import { TestProbeSocketFactory } from "homebridge-plugin-utils/testing";
 *
 * // The first bind is refused, so the allocator's retry reserves the port the second bind is granted.
 * const probes = new TestProbeSocketFactory([ "refused", 50000 ]);
 * const allocator = new RtpPortAllocator({ socketFactory: probes.create });
 *
 * await using reservation = await allocator.reserve();
 *
 * assert.equal(reservation.port, 50000);
 * assert.deepEqual(probes.binds, [ 0, 0 ]);
 * ```
 *
 * @category Testing
 */
export class TestProbeSocketFactory {

  /**
   * The port each bind asked for, in the order the binds were made: `0` for a random port, and the port itself for a specific one.
   */
  public readonly binds: number[] = [];

  readonly #deferred: boolean;

  readonly #script: readonly TestSocketBind[];

  /**
   * Construct a factory.
   *
   * @param script           - What each bind answers, in the order the binds are made. A suite scripts exactly the binds it expects, and a bind past the end,
   *                           or one answered with a port no kernel would grant, throws on a later tick rather than being answered.
   * @param options          - Optional options.
   * @param options.deferred - Answer each bind on a later turn of the event loop rather than inside `bind`, as a substitute socket that waits on a resolver
   *                           does. Defaults to `false`.
   */
  public constructor(script: readonly TestSocketBind[], { deferred = false }: { readonly deferred?: boolean } = {}) {

    this.#deferred = deferred;
    this.#script = script;
  }

  /**
   * The factory function this double exposes, bound as a property so it is handed straight to the allocator's `socketFactory` without losing `this`. The address
   * family it is asked for goes unread.
   *
   * @returns A fresh socket double.
   */
  public readonly create: RtpProbeSocketFactory = (): RtpProbeSocket => new TestProbeSocket((port, settle) => this.#answer(port, settle));

  // Record one bind and settle it with its scripted answer, inside the call or on a later turn of the event loop as the factory was built to. A bind the script
  // holds no answer for, or answers with a port no kernel would grant, is left unanswered and its error thrown on a later tick, because a throw inside `bind` would
  // reach the allocator as a refused port.
  #answer(port: number, settle: SettleBind): void {

    const bind = this.binds.push(port) - 1;
    const answer = this.#script[bind];

    if(answer === undefined) {

      throwLater(new Error("TestProbeSocketFactory: the script holds no answer for bind " + bind.toString() + ", which asked for port " + port.toString() + "."));

      return;
    }

    const fault = (answer === "refused") ? null : bindAnswerError({ answer, double: "TestProbeSocketFactory", requestedPort: port });

    if(fault !== null) {

      throwLater(fault);

      return;
    }

    // A deferred answer waits a turn of the event loop rather than a tick. After a timer's callback Node runs the tick queue ahead of the microtask queue, so an
    // answer on the next tick could reach a socket whose reservation has aborted, its listeners removed, before the microtask that closes it has run. The turn is
    // the clock module's `yieldMacrotask`, the package's one yield to the event loop, which a suite that replaces the timer module's members cannot park. What an
    // answer throws, an `"error"` event no listener takes among them, is thrown on from the yield's promise, so it surfaces where a socket's own callback would
    // have put it.
    if(this.#deferred) {

      void yieldMacrotask().then(() => settle(answer)).catch(throwLater);

      return;
    }

    settle(answer);
  }
}
