/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * dgram-util.test.ts: Unit tests for the IP-family translation tables, the dgram-socket factory, and the connected-datagram route probe in dgram-util.ts -
 * loopbackAddress, createDgramSocket, localAddressFor, and the IpFamily union's exhaustive coverage at the type level.
 */
import { createDgramSocket, localAddressFor, loopbackAddress } from "./dgram-util.ts";
import { describe, test } from "node:test";
import type { Socket } from "node:dgram";
import assert from "node:assert/strict";
import { assertNoUnhandledRejections } from "./testing/index.ts";
import { createSocket } from "node:dgram";
import { hasErrorCode } from "./util.ts";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
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

    // The IPv6 mapping is "::1" specifically (the IPv6 loopback), not "::" (the any-address). The test holds the literal so a future refactor that swaps to the
    // any-address - which would silently widen the bind surface - fails here.
    assert.equal(loopbackAddress("ipv6"), "::1", "ipv6 must map to the IPv6 loopback address exactly");
  });

  test("D1: two sockets that ask for address reuse share one port", async (t) => {

    const holder = createDgramSocket("ipv4", { reuseAddr: true });
    const sharer = createDgramSocket("ipv4", { reuseAddr: true });

    t.after(() => {

      holder.close();
      sharer.close();
    });

    await bindLoopback(holder, "127.0.0.1");

    const shared = holder.address().port;

    sharer.bind(shared, "127.0.0.1");
    await once(sharer, "listening");

    // This is what lets a multicast listener sit beside the operating system's own responder on a well-known port, each receiving every datagram delivered.
    assert.equal(sharer.address().port, shared, "the second socket must be bound to the port the first one holds");
  });

  test("D2: a socket that did not ask for address reuse is refused the port a reuse-bound socket holds", async (t) => {

    const holder = createDgramSocket("ipv4", { reuseAddr: true });
    const intruder = createDgramSocket("ipv4");

    t.after(() => {

      holder.close();
      intruder.close();
    });

    await bindLoopback(holder, "127.0.0.1");
    intruder.bind(holder.address().port, "127.0.0.1");

    const [error] = await once(intruder, "error") as [Error];

    assert.equal(hasErrorCode(error, "EADDRINUSE"), true, "a bind without the option must be refused the held port");
  });

  test("rejects values outside the IpFamily union at the type level", () => {

    // Type-level rejection only - no runtime invocation, since calling loopbackAddress with an unknown family would return undefined off the lookup table and that
    // is not the contract this test holds. The assignments below exercise the parameter type at typecheck time; the leading underscore on each binding marks it as
    // compile-time-only so the IDE does not flag it as unused. The `@ts-expect-error` directives fail typecheck if the IpFamily union ever widens, so the contract
    // is policed by `tsc --noEmit` rather than by the runner.
    type LoopbackParam = Parameters<typeof loopbackAddress>[0];

    const _ipv4: LoopbackParam = "ipv4";
    const _ipv6: LoopbackParam = "ipv6";

    // @ts-expect-error - "ipv7" is not in the IpFamily union.
    const _badStr: LoopbackParam = "ipv7";
    // @ts-expect-error - undefined is not in the IpFamily union.
    const _badUndef: LoopbackParam = undefined;
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

    // Type-level rejection only - see the parallel comment in the loopbackAddress describe. The directional contract this test holds: callers pass IpFamily into the
    // factory, and the dgram socket-type literal ("udp4" / "udp6") is the *table value* the factory hands back to `node:dgram`, never an accepted caller input.
    type FactoryParam = Parameters<typeof createDgramSocket>[0];

    const _ipv4: FactoryParam = "ipv4";
    const _ipv6: FactoryParam = "ipv6";

    // @ts-expect-error - "udp4" is the table value, not an IpFamily input.
    const _socketType: FactoryParam = "udp4";
    // @ts-expect-error - undefined is not in the IpFamily union.
    const _badUndef: FactoryParam = undefined;
  });
});

/* The local address this machine's routing table would send toward a host, computed inline so an arm can compare the module's answer against an independent one.
 * The port differs from the module's own, which is what shows the answer does not depend on it: no datagram is ever sent either way.
 *
 * @param host - The host to route toward.
 *
 * @returns The local address, or null when this machine has no route toward that host.
 */
async function probeRoute(host: string): Promise<string | null> {

  const socket = createSocket("udp4");

  socket.unref();

  try {

    const connected = once(socket, "connect");

    socket.connect(443, host);
    await connected;

    return socket.address().address;
  } catch {

    return null;
  } finally {

    socket.close();
  }
}

describe("localAddressFor", () => {

  test("a loopback address answers itself, in either family", async () => {

    assert.equal(await localAddressFor("127.0.0.1"), "127.0.0.1");
    assert.equal(await localAddressFor("::1"), "::1", "an IPv6 host is probed over an IPv6 socket, so the answer is the IPv6 loopback");
  });

  test("a name answers an address literal rather than the name it was asked about", async () => {

    // A stand-in that handed the input back would pass a weaker assertion than this one: the answer has to be an address, and it has to be a loopback one.
    const named = await localAddressFor("localhost");

    assert.ok(named.startsWith("127.") || (named === "::1"), "a loopback peer is reached over loopback, and the answer is an address rather than a name");
  });

  test("the answered address is in the family the resolver named", async () => {

    /* The property itself: whatever family the platform resolver puts first for a name, the probe answers in. On a machine whose resolver answers `localhost` with an
     * IPv6 record first this row is exactly what a spelling-driven family fails, because the name carries no colon and would have been probed over IPv4 while the
     * resolver was naming an IPv6 address. On a machine that answers IPv4 first both readings agree and the row asserts the property without telling them apart.
     */
    const { family } = await lookup("localhost");

    assert.equal(isIP(await localAddressFor("localhost")), family, "the probe follows the resolver into the family it answered in");
  });

  test("a lifetime that stays open lets the probe answer", async () => {

    /* The connect wait takes its signal arm whenever a caller supplies a lifetime, and the two abort rows below walk that arm only on its rejecting side - the
     * unresolvable-host one rejects on the lookup wait rather than this one, because the resolution comes first. This row walks the same arm on a call that succeeds,
     * which is what keeps this module's branch coverage whole. It exercises the arm rather than telling one implementation from another.
     */
    assert.equal(await localAddressFor("127.0.0.1", { signal: new AbortController().signal }), "127.0.0.1");
  });

  test("a host that does not resolve rejects with the lookup's own error", async () => {

    /* The reserved suffix never resolves, so this is the failure a user's mistyped or unreachable address produces. The rejection carries the lookup's own code,
     * which is what a caller needs to tell an unreachable host from anything else - and what a probe that ignored its failure would replace with an address meaning
     * nothing.
     */
    await assert.rejects(localAddressFor("no-such-host.invalid"), (error: unknown) => hasErrorCode(error, "ENOTFOUND"));
  });

  test("the answer is the operating system's own routing rather than an assumed loopback", async (t) => {

    /* The documentation range. Nothing is sent to it and nothing needs to answer, but the kernel still picks the interface it would leave from, and the inline probe
     * computes that same answer independently over a different port - so this arm fails an implementation that hardcoded a loopback address, and shows the port the
     * probe connects toward does not enter into the answer.
     *
     * A machine with no route toward it fails both sides identically, which would prove nothing, so that case skips with its reason recorded.
     */
    const expected = await probeRoute("192.0.2.1");

    if(expected === null) {

      t.skip("this machine has no route toward the documentation range, so both sides of the comparison would fail identically");

      return;
    }

    assert.equal(await localAddressFor("192.0.2.1"), expected);
  });

  test("a lifetime that has already ended rejects before any socket exists", async () => {

    const controller = new AbortController();
    const reason = new Error("the caller went away");

    controller.abort(reason);

    await assert.rejects(localAddressFor("127.0.0.1", { signal: controller.signal }), (error: unknown) => error === reason);
  });

  test("a lifetime that ends during a pending lookup rejects with that lifetime's reason", async () => {

    await assertNoUnhandledRejections(async () => {

      const controller = new AbortController();
      const reason = new Error("the caller went away");

      /* The call runs to its first await before returning here, so the lookup is in flight by the time the abort lands. What it rejects with is the assertion: the
       * signal's own reason, rather than the platform's `AbortError` or the lookup's own failure, which is what the wait would surface if it were awaited bare.
       */
      const pending = localAddressFor("no-such-host.invalid", { signal: controller.signal });

      controller.abort(reason);

      await assert.rejects(pending, (error: unknown) => error === reason);
    });
  });
});
