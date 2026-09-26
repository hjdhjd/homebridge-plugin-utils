/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp.helpers.ts: The probe-socket double the RTP port allocator's suite drives.
 */

/**
 * The probe-socket double the port allocator's suite drives.
 *
 * The allocator reaches its probe sockets through {@link ffmpeg/rtp!RtpProbeSocketFactory | RtpProbeSocketFactory}, which is what lets this double stand where
 * `node:dgram` would: every bind answers what the row scripted, so a refused bind, a collision with a port the pool already holds, and a spent attempt budget
 * are each set up directly rather than waited for on a crowded host. The factory records the port every bind asked for, so a row reads the allocator's probing
 * back in order.
 *
 * This double stays here rather than shipping on the testing entry point because nothing outside this module's own suite drives the allocator at the socket; a
 * `*.helpers.ts` file reaches neither the published package nor the published documentation.
 *
 * @module
 */
import type { RtpProbeSocket, RtpProbeSocketFactory } from "./rtp.ts";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { expectAt } from "../testing/index.ts";

/**
 * What one scripted bind answers: the port the socket is bound to, or `"refused"` for a bind the kernel rejects because the port is taken. A bind to a specific
 * port is scripted with that same port, since a kernel that grants a specific bind grants exactly the port asked for.
 */
export type TestProbeBind = number | "refused";

// One probe socket. Its bind answers on the next tick, as a bind that waits on a resolver does, which is what lets an abort land while an answer is pending.
class TestProbeSocket extends EventEmitter implements RtpProbeSocket {

  #port = 0;

  readonly #factory: TestProbeSocketFactory;

  public constructor(factory: TestProbeSocketFactory) {

    super();

    this.#factory = factory;
  }

  public address(): AddressInfo {

    return { address: "0.0.0.0", family: "IPv4", port: this.#port };
  }

  public bind(port: number): void {

    const bind = this.#factory.binds.push(port) - 1;

    process.nextTick(() => {

      const answer = this.#factory.answer(bind);

      if(answer === "refused") {

        this.emit("error", Object.assign(new Error("bind EADDRINUSE 0.0.0.0:" + port.toString()), { code: "EADDRINUSE", syscall: "bind" }));

        return;
      }

      this.#port = answer;
      this.emit("listening");
    });
  }

  public close(): void {

    // A double holds no handle, so closing it releases nothing.
  }

  public unref(): void {

    // A double holds no handle, so there is nothing to keep the process open.
  }
}

/**
 * A probe-socket factory double that answers each bind from a script and records the port every bind asked for.
 */
export class TestProbeSocketFactory {

  /**
   * The port each bind asked for, in the order the binds were made: `0` for a random port, and the port itself for a specific one.
   */
  public readonly binds: number[] = [];

  readonly #script: readonly TestProbeBind[];

  /**
   * Construct a factory.
   *
   * @param script - What each bind answers, in the order the binds are made. A row scripts exactly the binds it expects, and a bind past the end fails the row.
   */
  public constructor(script: readonly TestProbeBind[]) {

    this.#script = script;
  }

  /**
   * The factory function this double exposes, bound as a property so it can be handed straight to the allocator without losing `this`.
   *
   * @returns A fresh socket double.
   */
  public readonly create: RtpProbeSocketFactory = (): RtpProbeSocket => new TestProbeSocket(this);

  /**
   * The scripted answer for one bind. A socket reads it when the answer is delivered rather than when the bind is made, because a throw inside `bind` reaches
   * the allocator as a refused bind, and a script that ran short would then pass for contention.
   *
   * @param bind - The bind's position in {@link TestProbeSocketFactory.binds}.
   *
   * @returns What that bind answers.
   */
  public answer(bind: number): TestProbeBind {

    return expectAt(this.#script, bind, "a scripted answer for bind " + bind.toString());
  }
}
