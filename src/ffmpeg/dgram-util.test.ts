/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/dgram-util.test.ts: Unit tests for the IP-family translation tables and dgram-socket factory in dgram-util.ts - loopbackAddress, createDgramSocket,
 * and the IpFamily union's exhaustive coverage at the type level.
 */
import { createDgramSocket, loopbackAddress } from "./dgram-util.ts";
import { describe, test } from "node:test";
import type { Socket } from "node:dgram";
import assert from "node:assert/strict";
import { once } from "node:events";

// Bring `socket` up on the loopback interface and resolve once `"listening"` fires (or reject on `"error"`). Awaiting the listening event before inspecting
// `socket.address()` is the contract the dgram API documents; calling `address()` against an unbound socket throws on every supported Node version. The helper is
// inline rather than imported from `udp.helpers.ts` because that helper returns the bound port and immediately closes - this test wants the live socket to inspect.
async function bindLoopback(socket: Socket, address: string): Promise<void> {

  socket.bind(0, address);
  await once(socket, "listening");
}

describe("loopbackAddress", () => {

  test("returns the IPv4 loopback string for ipFamily \"ipv4\"", () => {

    assert.equal(loopbackAddress("ipv4"), "127.0.0.1", "ipv4 must map to the IPv4 loopback address exactly");
  });

  test("returns the IPv6 loopback string for ipFamily \"ipv6\"", () => {

    // The IPv6 mapping is "::1" specifically (the IPv6 loopback), not "::" (the any-address). The test pins the literal so a future refactor that swaps to the
    // any-address - which would silently widen the bind surface - fails here.
    assert.equal(loopbackAddress("ipv6"), "::1", "ipv6 must map to the IPv6 loopback address exactly");
  });

  test("rejects values outside the IpFamily union at the type level", () => {

    // Type-level rejection only - no runtime invocation, since calling loopbackAddress with an unknown family would return undefined off the lookup table and that
    // is not the contract this test pins. The assignments below exercise the parameter type at typecheck time; `void` marks each binding as deliberately read so the
    // IDE does not flag them as unused. The `@ts-expect-error` directives fail typecheck if the IpFamily union ever widens, so the contract is policed by
    // `tsc --noEmit` rather than by the runner.
    type LoopbackParam = Parameters<typeof loopbackAddress>[0];

    const ipv4: LoopbackParam = "ipv4";
    const ipv6: LoopbackParam = "ipv6";

    // @ts-expect-error - "ipv7" is not in the IpFamily union.
    const badStr: LoopbackParam = "ipv7";
    // @ts-expect-error - undefined is not in the IpFamily union.
    const badUndef: LoopbackParam = undefined;

    void ipv4; void ipv6; void badStr; void badUndef;
  });
});

describe("createDgramSocket", () => {

  test("returns a UDP4-family socket for ipFamily \"ipv4\"", async (t) => {

    const socket = createDgramSocket("ipv4");

    t.after(() => socket.close());

    // Bind on the IPv4 loopback so `address()` returns a populated `{ family }` field. A UDP6 socket would fail to bind on `127.0.0.1` with `EAFNOSUPPORT`, so the
    // successful bind is itself part of the verification.
    await bindLoopback(socket, "127.0.0.1");

    assert.equal(socket.address().family, "IPv4", "createDgramSocket(\"ipv4\") must yield a socket whose family is IPv4");
  });

  test("returns a UDP6-family socket for ipFamily \"ipv6\"", async (t) => {

    const socket = createDgramSocket("ipv6");

    t.after(() => socket.close());

    await bindLoopback(socket, "::1");

    assert.equal(socket.address().family, "IPv6", "createDgramSocket(\"ipv6\") must yield a socket whose family is IPv6");
  });

  test("returns a fresh socket per call - independent instances", (t) => {

    const a = createDgramSocket("ipv4");
    const b = createDgramSocket("ipv4");

    t.after(() => {

      a.close();
      b.close();
    });

    // Identity check: two consecutive calls must hand back distinct Socket instances. A cached / shared socket would share lifecycle and break the per-consumer
    // bind/close pattern that callers rely on.
    assert.notEqual(a, b, "createDgramSocket must return a new Socket per call, never a shared instance");
  });

  test("rejects values outside the IpFamily union at the type level", () => {

    // Type-level rejection only - see the parallel comment in the loopbackAddress describe. The directional contract this test pins: callers pass IpFamily into the
    // factory, and the dgram socket-type literal ("udp4" / "udp6") is the *table value* the factory hands back to `node:dgram`, never an accepted caller input.
    type FactoryParam = Parameters<typeof createDgramSocket>[0];

    const ipv4: FactoryParam = "ipv4";
    const ipv6: FactoryParam = "ipv6";

    // @ts-expect-error - "udp4" is the table value, not an IpFamily input.
    const socketType: FactoryParam = "udp4";
    // @ts-expect-error - undefined is not in the IpFamily union.
    const badUndef: FactoryParam = undefined;

    void ipv4; void ipv6; void socketType; void badUndef;
  });
});
