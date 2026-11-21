/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-probe-socket-double.test.ts: Unit tests for the shipped socket-free TestProbeSocketFactory double - its conformance to the allocator's socket factory
 * type, the binds it records, the refused bind's error, the timing of its answers against the package's own sockets, a script that runs short or answers a port no
 * kernel would grant, and a socket closed while its bind is pending.
 */
import type { RtpProbeSocket, RtpProbeSocketFactory } from "./rtp.ts";
import { TestProbeSocketFactory, refusedBindError, settle } from "../testing/index.ts";
import { assertEachSubject, captureUncaughtExceptions, settlement } from "./process-parity.helpers.ts";
import { describe, test } from "node:test";
import { HbpuAbortError } from "../util.ts";
import { RtpPortAllocator } from "./rtp.ts";
import assert from "node:assert/strict";

// The invented ports the rows script. No row binds them.
const FIRST_PORT = 50000;
const SECOND_PORT = 50010;

// What a probe socket has emitted so far, in order: "listening" for a granted bind, and the code of the error a refused one raised.
function heard(socket: RtpProbeSocket): string[] {

  const events: string[] = [];

  socket.on("listening", () => events.push("listening"));
  socket.on("error", (error: NodeJS.ErrnoException) => events.push("error " + String(error.code)));

  return events;
}

describe("TestProbeSocketFactory - compile-time conformance", () => {

  test("create conforms to the allocator's RtpProbeSocketFactory (no cast)", () => {

    // The no-drift proof is type-level: the compiler holds the double's factory function to the type the allocator's socketFactory option takes.
    const conforms = new TestProbeSocketFactory([]).create satisfies RtpProbeSocketFactory;

    assert.equal(typeof conforms, "function", "the conforming factory function is what a suite hands the allocator");
  });
});

describe("TestProbeSocketFactory - binds and their answers", () => {

  test("binds are recorded in the order made, a random port as 0 and a specific one as itself, each answered with its scripted port", () => {

    const probes = new TestProbeSocketFactory([ FIRST_PORT, SECOND_PORT ]);
    const random = probes.create("ipv4");
    const specific = probes.create("ipv6");

    random.bind(0);
    specific.bind(SECOND_PORT);

    assert.deepEqual({ binds: probes.binds, ports: [ random.address().port, specific.address().port ] }, { binds: [ 0, SECOND_PORT ],
      ports: [ FIRST_PORT, SECOND_PORT ] });
  });

  test("a refused bind answers the refused-bind error, carrying its code, its syscall and the port it asked for", () => {

    const socket = new TestProbeSocketFactory(["refused"]).create("ipv4");
    const errors: unknown[] = [];

    socket.on("error", (error: unknown) => errors.push(error));
    socket.bind(FIRST_PORT);

    const [error] = errors as (NodeJS.ErrnoException & { port?: number })[];

    assert.ok(error instanceof Error, "the refused bind raises an Error");
    assert.deepEqual({ code: error.code, message: error.message, port: error.port, syscall: error.syscall },
      { code: "EADDRINUSE", message: "bind EADDRINUSE 0.0.0.0:" + FIRST_PORT.toString(), port: FIRST_PORT, syscall: "bind" });
  });

  test("refusedBindError builds an Error carrying EADDRINUSE, bind and the port it is handed, its message naming the IPv4 any-address and that port", () => {

    const { code, message, port, syscall } = refusedBindError(SECOND_PORT);

    assert.deepEqual({ code, message, port, syscall }, { code: "EADDRINUSE", message: "bind EADDRINUSE 0.0.0.0:" + SECOND_PORT.toString(), port: SECOND_PORT,
      syscall: "bind" });
  });

  test("each bind is answered inside the call, and with deferred on a later turn of the event loop, past the tick and microtask queues", async () => {

    const inside = new TestProbeSocketFactory([FIRST_PORT]).create("ipv4");
    const deferred = new TestProbeSocketFactory([FIRST_PORT], { deferred: true }).create("ipv4");
    const insideEvents = heard(inside);
    const deferredEvents = heard(deferred);

    inside.bind(0);
    deferred.bind(0);

    const atBind = { deferred: [...deferredEvents], inside: [...insideEvents] };

    // A tick passes with the deferred bind still unanswered, which is what lets the cleanup an abort queues run ahead of the answer.
    await new Promise<void>((resolve) => process.nextTick(resolve));

    const afterTick = { deferred: [...deferredEvents], inside: [...insideEvents] };

    await settle();

    assert.deepEqual({ afterTick, afterTurn: { deferred: deferredEvents, inside: insideEvents }, atBind }, { afterTick: { deferred: [], inside: ["listening"] },
      afterTurn: { deferred: ["listening"], inside: ["listening"] }, atBind: { deferred: [], inside: ["listening"] } });
  });

  test("a script that runs short leaves the bind unanswered and throws naming the bind on Node's uncaught-exception channel, whatever the timing", async () => {

    const reading = await captureUncaughtExceptions(async (captured) => {

      const inside = new TestProbeSocketFactory([]).create("ipv4");
      const deferred = new TestProbeSocketFactory([], { deferred: true }).create("ipv4");
      const events = { deferred: heard(deferred), inside: heard(inside) };

      inside.bind(0);
      deferred.bind(FIRST_PORT);
      await settle();

      return { events, thrown: captured.map((error) => (error instanceof Error) ? error.message : String(error)) };
    });

    assert.deepEqual(reading, { events: { deferred: [], inside: [] }, thrown: [ "TestProbeSocketFactory: the script holds no answer for bind 0, which asked for port 0.",
      "TestProbeSocketFactory: the script holds no answer for bind 0, which asked for port " + FIRST_PORT.toString() + "." ] });
  });

  test("a scripted port no kernel would grant leaves the bind unanswered and throws the check's error on Node's uncaught-exception channel", async () => {

    // Zero, a port past the highest UDP carries and a port that is not a whole number, each for a random bind, and another port than a specific bind asked for,
    // from a deferred double so the refusal holds whatever the timing.
    const cases = [ { answer: 0, port: 0 }, { answer: 65536, port: 0 }, { answer: 1.5, port: 0 }, { answer: SECOND_PORT, deferred: true, port: FIRST_PORT } ];
    const reading = await captureUncaughtExceptions(async (captured) => {

      const events = cases.map(({ answer, deferred = false, port }) => {

        const socket = new TestProbeSocketFactory([answer], { deferred }).create("ipv4");
        const socketEvents = heard(socket);

        socket.bind(port);

        return socketEvents;
      });

      await settle();

      return { events, thrown: captured.map((error) => (error instanceof Error) ? error.message : String(error)) };
    });

    assert.deepEqual(reading, { events: [ [], [], [], [] ], thrown: [ "TestProbeSocketFactory: the kernel binds a port from 1 to 65535, so a bind cannot complete on 0.",
      "TestProbeSocketFactory: the kernel binds a port from 1 to 65535, so a bind cannot complete on 65536.",
      "TestProbeSocketFactory: the kernel binds a port from 1 to 65535, so a bind cannot complete on 1.5.",
      "TestProbeSocketFactory: a specific-port bind completes on the port it asked for, so it cannot complete on " + SECOND_PORT.toString() + "." ] });
  });

  test("a deferred refusal whose reservation aborts while the bind is pending rejects the reservation and raises nothing on the uncaught-exception channel", async () => {

    const reading = await captureUncaughtExceptions(async (captured) => {

      const probes = new TestProbeSocketFactory(["refused"], { deferred: true });
      const controller = new AbortController();
      const pending = new RtpPortAllocator({ socketFactory: probes.create }).reserve({ signal: controller.signal });

      // The abort lands while the bind waits for its answer, so the allocator drops its listeners and closes the socket before the refusal arrives a turn later.
      controller.abort(new HbpuAbortError("shutdown"));

      const reserve = await settlement(pending);

      // The row crosses a turn past the answer's before it looks, so an error the closed socket raised would have reached the channel by then.
      await settle();

      return { binds: [...probes.binds], reserve, thrown: [...captured] };
    });

    assert.deepEqual(reading, { binds: [0], reserve: "rejected shutdown", thrown: [] });
  });

  test("a deferred refusal whose reservation and abort run straight in a timer's callback raises nothing on the uncaught-exception channel", async () => {

    const reading = await captureUncaughtExceptions(async (captured) => {

      const probes = new TestProbeSocketFactory(["refused"], { deferred: true });
      const controller = new AbortController();

      // The reservation and its abort both run straight in a timer's callback, where Node runs the tick queue ahead of the microtask in which the allocator closes
      // the socket. An answer that arrived on the next tick would reach the socket still open with its listeners already removed, so the answer waits a turn.
      const { pending } = await new Promise<{ pending: Promise<unknown> }>((resolve) => {

        setImmediate(() => {

          const reservation = new RtpPortAllocator({ socketFactory: probes.create }).reserve({ signal: controller.signal });

          controller.abort(new HbpuAbortError("shutdown"));
          resolve({ pending: reservation });
        });
      });

      const reserve = await settlement(pending);

      // The row crosses a turn past the answer's before it looks, so an error the socket raised would have reached the channel by then.
      await settle();

      return { binds: [...probes.binds], reserve, thrown: captured.map((error) => (error instanceof Error) ? error.message : String(error)) };
    });

    assert.deepEqual(reading, { binds: [0], reserve: "rejected shutdown", thrown: [] });
  });

  test("a deferred refusal no listener takes surfaces on Node's uncaught-exception channel, where one answered inside the call throws out of bind", async () => {

    const reading = await captureUncaughtExceptions(async (captured) => {

      const inside = new TestProbeSocketFactory(["refused"]).create("ipv4");
      const deferred = new TestProbeSocketFactory(["refused"], { deferred: true }).create("ipv4");

      // An emitter throws an `"error"` event no listener takes. Inside the call that throw leaves `bind`, and a turn later there is no caller left to throw to.
      assert.throws(() => inside.bind(FIRST_PORT), { code: "EADDRINUSE" });
      deferred.bind(SECOND_PORT);
      await settle();

      return captured.map((error) => (error instanceof Error) ? error.message : String(error));
    });

    assert.deepEqual(reading, ["bind EADDRINUSE 0.0.0.0:" + SECOND_PORT.toString()]);
  });
});

describe("TestProbeSocketFactory - the allocator over the double and over the package's own sockets", () => {

  // An allocator's starter: over the double, its probes scripted to grant one random bind, or over the package's own sockets.
  type StartAllocator = () => RtpPortAllocator;

  test("a single-port reservation whose signal aborts in the same turn as reserve() rejects over the double as over the package's sockets", async () => {

    const starters: { double: StartAllocator; real: StartAllocator } = {

      double: (): RtpPortAllocator => new RtpPortAllocator({ socketFactory: new TestProbeSocketFactory([FIRST_PORT]).create }),
      real: (): RtpPortAllocator => new RtpPortAllocator()
    };

    await assertEachSubject(starters, { reserve: "rejected shutdown" }, async (start) => {

      const controller = new AbortController();
      const pending = start().reserve({ signal: controller.signal });

      controller.abort(new HbpuAbortError("shutdown"));

      // The bind completes inside reserve() on each subject, so the abort lands with the port already held, and the reservation is refused all the same.
      return { reserve: await settlement(pending) };
    });
  });
});
