/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-demuxer-double.test.ts: Unit tests for the RtpDemuxerHandle dependency-inversion boundary - the compile-time conformance of the production class and
 * factory, plus the shipped socket-free TestRtpDemuxer / TestRtpDemuxerFactory doubles (the bind settled inside the constructor from its scripted answer, each lever,
 * the double's refusals, the port it reads, a parent already aborted, and the factory's script and create-call recording over the consumer's signal). The real demuxer
 * and the double run the same lifecycle scenarios side by side in rtp.test.ts.
 */
import type { Assert, Equal, Extends } from "../testing/index.ts";
import type { RtpDemuxer, RtpDemuxerFactory, RtpDemuxerHandle, RtpDemuxerInit } from "./rtp.ts";
import { TestRtpDemuxer, TestRtpDemuxerFactory, assertNoUnhandledRejections, expectAt, settle } from "../testing/index.ts";
import { describe, test } from "node:test";
import { lifetimeState, reasonName, settlement } from "./process-parity.helpers.ts";
import { HbpuAbortError } from "../util.ts";
import assert from "node:assert/strict";
import { rtpDemuxerFactory } from "./rtp.ts";

// The invented ports the rows construct over and bind to. No row opens a socket, so none is ever bound.
const REQUESTED_PORT = 50000;
const ASSIGNED_PORT = 50010;

describe("RtpDemuxerHandle boundary - compile-time conformance", () => {

  test("the production RtpDemuxer and rtpDemuxerFactory conform to the boundary types (no cast)", () => {

    // The no-drift proof is type-level: the compiler holds the production factory to the creational interface and the production class to the product interface. No
    // real RtpDemuxer is constructed here, because its constructor binds a socket; rtp.test.ts runs the real class against this double.
    const factoryConforms = rtpDemuxerFactory satisfies RtpDemuxerFactory;

    // A type-only assertion that an RtpDemuxer value is assignable to RtpDemuxerHandle. The cast never executes at a constructed instance; the binding's sole purpose
    // is to make `tsc` reject the file if the class ever stops satisfying the interface.
    const classConforms: RtpDemuxerHandle = null as unknown as RtpDemuxer;

    // The reason the boundary is an interface: the class's private fields make its type one no structural object satisfies, the double included. The claim is
    // type-level, so `tsc` rejects this file if the double ever becomes assignable to the class.
    type _DoubleIsNotTheClass = Assert<Equal<Extends<TestRtpDemuxer, RtpDemuxer>, false>>;

    assert.ok(factoryConforms, "the production rtpDemuxerFactory must satisfy RtpDemuxerFactory");
    assert.equal(classConforms, null, "the type-level RtpDemuxer -> RtpDemuxerHandle assignment is the conformance proof");
  });
});

describe("TestRtpDemuxer - the bind inside the constructor", () => {

  test("a scripted port is bound, and a refusal has failed the lifetime, the moment the constructor returns", () => {

    // Read with no await between the constructor and the reading, so a bind settled even a microtask late reads unbound here.
    const bound = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);
    const boundReading = { aborted: bound.aborted, inputPort: bound.inputPort, reason: lifetimeState(bound.signal) };
    const refused = new TestRtpDemuxer({ inputPort: REQUESTED_PORT }, "refused");
    const refusedReading = { aborted: refused.aborted, inputPort: refused.inputPort, reason: lifetimeState(refused.signal) };

    assert.deepEqual({ bound: boundReading, refused: refusedReading }, { bound: { aborted: false, inputPort: ASSIGNED_PORT, reason: "live" },
      refused: { aborted: true, inputPort: REQUESTED_PORT, reason: "failed" } });
  });

  test("a bound demuxer's ready has resolved and its inputPort reads the bound port past the lifetime's end", async () => {

    const demuxer = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);

    demuxer.abort();

    assert.deepEqual({ inputPort: demuxer.inputPort, lifetime: lifetimeState(demuxer.signal), ready: await settlement(demuxer.ready) },
      { inputPort: ASSIGNED_PORT, lifetime: "shutdown", ready: "resolved" });
  });

  test("a refused bind rejects ready and mediaReady as failed, the lifetime's cause the refused bind's error for the port asked for", async () => {

    const demuxer = new TestRtpDemuxer({ inputPort: REQUESTED_PORT }, "refused");
    const { code, port, syscall } = (demuxer.signal.reason as HbpuAbortError).cause as { code?: string; port?: number; syscall?: string };

    assert.deepEqual({ cause: { code, port, syscall }, mediaReady: await settlement(demuxer.mediaReady), ready: await settlement(demuxer.ready) },
      { cause: { code: "EADDRINUSE", port: REQUESTED_PORT, syscall: "bind" }, mediaReady: "rejected failed", ready: "rejected failed" });
  });

  test("a specific-port construction binds its own port with no answer and with its own port as the answer", () => {

    const unnamed = new TestRtpDemuxer({ inputPort: REQUESTED_PORT });
    const named = new TestRtpDemuxer({ inputPort: REQUESTED_PORT }, REQUESTED_PORT);

    assert.deepEqual({ named: named.inputPort, unnamed: unnamed.inputPort }, { named: REQUESTED_PORT, unnamed: REQUESTED_PORT });
  });

  test("an ephemeral bind completes on the lowest and the highest port UDP carries", () => {

    assert.deepEqual([ 1, 65535 ].map((port) => new TestRtpDemuxer({ inputPort: 0 }, port).inputPort), [ 1, 65535 ]);
  });

  test("a parent already aborted binds nothing, so the answer is neither read nor validated and the requested port stands", async () => {

    const signal = AbortSignal.abort(new HbpuAbortError("timeout"));
    const unscripted = new TestRtpDemuxer({ inputPort: 0, signal });
    const invalid = new TestRtpDemuxer({ inputPort: REQUESTED_PORT, signal }, 1.5);

    assert.deepEqual({ invalid: invalid.inputPort, ready: await settlement(invalid.ready), unscripted: unscripted.inputPort },
      { invalid: REQUESTED_PORT, ready: "rejected timeout", unscripted: 0 });
  });
});

describe("TestRtpDemuxer - levers", () => {

  test("resolveMediaReady after the bind resolves mediaReady and leaves the lifetime live", async () => {

    const demuxer = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);

    demuxer.resolveMediaReady();

    assert.deepEqual({ lifetime: lifetimeState(demuxer.signal), mediaReady: await settlement(demuxer.mediaReady) }, { lifetime: "live", mediaReady: "resolved" });
  });

  test("failSocket after the bind leaves ready resolved and rejects the pending mediaReady as failed, the lifetime carrying the socket's error", async () => {

    const demuxer = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);
    const cause = new Error("An invented socket error.");

    demuxer.failSocket(cause);

    // Read ahead of the promises, so a double that passed over the failure reads as a live lifetime here rather than as a mediaReady that never settles.
    assert.equal(lifetimeState(demuxer.signal), "failed", "the socket's failure ends the lifetime");
    assert.deepEqual({ cause: (demuxer.signal.reason as HbpuAbortError).cause, mediaReady: await settlement(demuxer.mediaReady), ready: await settlement(demuxer.ready) },
      { cause, mediaReady: "rejected failed", ready: "resolved" });
  });

  test("failSocket after mediaReady ends the lifetime as failed and leaves ready and mediaReady resolved", async () => {

    const demuxer = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);

    demuxer.resolveMediaReady();
    demuxer.failSocket(new Error("An invented socket error."));

    assert.deepEqual({ lifetime: lifetimeState(demuxer.signal), mediaReady: await settlement(demuxer.mediaReady), ready: await settlement(demuxer.ready) },
      { lifetime: "failed", mediaReady: "resolved", ready: "resolved" });
  });

  test("failSocket once the lifetime has ended changes nothing, so the first reason stands", () => {

    const demuxer = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);
    const reason = new HbpuAbortError("replaced");

    demuxer.abort(reason);
    demuxer.failSocket(new Error("An invented socket error during teardown."));

    assert.equal(demuxer.signal.reason, reason);
  });

  test("a parent already aborted rejects ready and mediaReady inside the constructor, so a handler attached at once has run after one microtask turn", async () => {

    const demuxer = new TestRtpDemuxer({ inputPort: REQUESTED_PORT, signal: AbortSignal.abort(new HbpuAbortError("timeout")) });
    const seen: string[] = [];

    void demuxer.ready.catch((error: unknown) => {

      seen.push("ready " + reasonName(error));
    });

    void demuxer.mediaReady.catch((error: unknown) => {

      seen.push("mediaReady " + reasonName(error));
    });

    await Promise.resolve();

    assert.deepEqual(seen, [ "ready timeout", "mediaReady timeout" ]);
  });

  test("ready and mediaReady raise no unhandled rejection when neither is read, whichever way the lifetime ends", async () => {

    await assertNoUnhandledRejections(async () => {

      const parent = new AbortController();
      const bound = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);

      new TestRtpDemuxer({ inputPort: REQUESTED_PORT, signal: AbortSignal.abort(new HbpuAbortError("timeout")) });
      new TestRtpDemuxer({ inputPort: 0, signal: parent.signal }, ASSIGNED_PORT);
      new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT).abort();
      new TestRtpDemuxer({ inputPort: REQUESTED_PORT }).failSocket(new Error("An invented bind collision."));
      new TestRtpDemuxer({ inputPort: REQUESTED_PORT }, "refused");
      bound.failSocket(new Error("An invented socket error."));
      parent.abort(new HbpuAbortError("replaced"));

      await settle();
    });
  });
});

describe("TestRtpDemuxer - the double refuses what a real demuxer cannot do", () => {

  test("the constructor throws for a bind answered with a port that is not a whole number from 1 to 65535", () => {

    for(const port of [ -1, 0, 1.5, 65536 ]) {

      assert.throws(() => new TestRtpDemuxer({ inputPort: 0 }, port),
        { message: "TestRtpDemuxer: the kernel binds a port from 1 to 65535, so a bind cannot complete on " + String(port) + "." });
    }
  });

  test("a specific-port construction answered with another port throws from the constructor", () => {

    assert.throws(() => new TestRtpDemuxer({ inputPort: REQUESTED_PORT }, REQUESTED_PORT + 1),
      { message: "TestRtpDemuxer: a specific-port bind completes on the port it asked for, so it cannot complete on " + String(REQUESTED_PORT + 1) + "." });
  });

  test("an ephemeral construction with no answer throws from the constructor, naming the answer it lacks", () => {

    assert.throws(() => new TestRtpDemuxer({ inputPort: 0 }), { message: "TestRtpDemuxer: an ephemeral bind completes on the port the kernel assigns, so an " +
      "ephemeral construction is handed that port as its bind's answer." });
  });

  test("resolveMediaReady throws the lifetime's reason after the end, a refused bind's among them, and an error once mediaReady has resolved", () => {

    const ended = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);
    const refused = new TestRtpDemuxer({ inputPort: REQUESTED_PORT }, "refused");
    const flowing = new TestRtpDemuxer({ inputPort: 0 }, ASSIGNED_PORT);

    ended.abort(new HbpuAbortError("replaced"));
    flowing.resolveMediaReady();

    assert.throws(() => ended.resolveMediaReady(), { constructor: HbpuAbortError, name: "replaced" });
    assert.throws(() => refused.resolveMediaReady(), { constructor: HbpuAbortError, name: "failed" });
    assert.throws(() => flowing.resolveMediaReady(), { message: "TestRtpDemuxer: mediaReady has already resolved, so it cannot resolve again." });
  });
});

describe("TestRtpDemuxerFactory - create-call recording", () => {

  test("create records each init with the demuxer it answered, in order, and answers a fresh demuxer over that init on every call", () => {

    const factory = new TestRtpDemuxerFactory([ASSIGNED_PORT]);
    const first: RtpDemuxerInit = { inputPort: 0, rtcpPort: 50001, rtpPort: 50002 };
    const second: RtpDemuxerInit = { inputPort: REQUESTED_PORT, ipFamily: "ipv6", rtcpPort: 50003, rtpPort: 50004 };
    const firstDemuxer = factory.create(first);
    const secondDemuxer = factory.create(second);
    const firstCall = expectAt(factory.createCalls, 0, "the first create call");
    const secondCall = expectAt(factory.createCalls, 1, "the second create call");

    assert.equal(factory.createCalls.length, 2, "every create call must be recorded");
    assert.equal(firstCall.init, first, "the recorded init must be the exact reference passed to create()");
    assert.equal(secondCall.init, second, "the recorded inits must be in call order");
    assert.equal(firstCall.demuxer, firstDemuxer, "the recorded demuxer must be the one create() answered");
    assert.equal(secondCall.demuxer, secondDemuxer, "the recorded demuxers must be in call order");
    assert.ok(firstDemuxer instanceof TestRtpDemuxer, "create() must answer a TestRtpDemuxer");
    assert.notEqual(secondDemuxer, firstDemuxer, "every create() must answer a fresh demuxer");
    assert.equal(secondDemuxer.inputPort, REQUESTED_PORT, "the demuxer reads the port its init asked for");
  });

  test("a demuxer the factory built ends when the signal passed to create aborts, and one built over another signal goes on", () => {

    const factory = new TestRtpDemuxerFactory([ ASSIGNED_PORT, ASSIGNED_PORT + 1 ]);
    const ended = new AbortController();
    const reason = new HbpuAbortError("replaced");

    factory.create({ inputPort: 0, rtcpPort: 50001, rtpPort: 50002, signal: ended.signal });
    factory.create({ inputPort: 0, rtcpPort: 50003, rtpPort: 50004, signal: new AbortController().signal });

    ended.abort(reason);

    assert.equal(expectAt(factory.createCalls, 0, "the demuxer built over the aborted signal").demuxer.signal.reason, reason,
      "the consumer's signal must end the demuxer the factory built with that signal's reason");
    assert.equal(expectAt(factory.createCalls, 1, "the demuxer built over a live signal").demuxer.signal.aborted, false,
      "a demuxer built over another signal must not end with it");
  });
});

describe("TestRtpDemuxerFactory - the script of binds", () => {

  // An init asking for `inputPort`, its forwarding ports invented.
  const initFor = (inputPort: number, signal?: AbortSignal): RtpDemuxerInit => ({ inputPort, rtcpPort: 50001, rtpPort: 50002, signal });

  test("each construction that binds takes the script's next answer in order, a specific-port one's among them, and once it is spent each builds unscripted", () => {

    const factory = new TestRtpDemuxerFactory([ ASSIGNED_PORT, REQUESTED_PORT, "refused" ]);

    factory.create(initFor(0));
    factory.create(initFor(REQUESTED_PORT));
    factory.create(initFor(REQUESTED_PORT));
    factory.create(initFor(REQUESTED_PORT));

    assert.deepEqual(factory.createCalls.map(({ demuxer }) => ({ inputPort: demuxer.inputPort, lifetime: lifetimeState(demuxer.signal) })), [
      { inputPort: ASSIGNED_PORT, lifetime: "live" }, { inputPort: REQUESTED_PORT, lifetime: "live" }, { inputPort: REQUESTED_PORT, lifetime: "failed" },
      { inputPort: REQUESTED_PORT, lifetime: "live" } ]);
  });

  test("a construction under a signal already aborted takes no answer, leaving it for the next construction that binds", () => {

    const factory = new TestRtpDemuxerFactory([ASSIGNED_PORT]);

    factory.create(initFor(0, AbortSignal.abort(new HbpuAbortError("timeout"))));
    factory.create(initFor(0));

    assert.deepEqual(factory.createCalls.map(({ demuxer }) => demuxer.inputPort), [ 0, ASSIGNED_PORT ]);
  });

  test("a construction that throws records no call, its answer spent, and the next construction takes the answer after it", () => {

    const factory = new TestRtpDemuxerFactory([ REQUESTED_PORT + 1, ASSIGNED_PORT ]);

    assert.throws(() => factory.create(initFor(REQUESTED_PORT)),
      { message: "TestRtpDemuxer: a specific-port bind completes on the port it asked for, so it cannot complete on " + String(REQUESTED_PORT + 1) + "." });
    assert.throws(() => new TestRtpDemuxerFactory().create(initFor(0)), { message: "TestRtpDemuxer: an ephemeral bind completes on the port the kernel assigns, so " +
      "an ephemeral construction is handed that port as its bind's answer." });

    factory.create(initFor(0));

    assert.deepEqual(factory.createCalls.map(({ demuxer }) => demuxer.inputPort), [ASSIGNED_PORT]);
  });

  test("a construction asked for a port no UDP socket can hold throws the real demuxer's RangeError, records no call and leaves the script's next answer", () => {

    const factory = new TestRtpDemuxerFactory([ASSIGNED_PORT]);

    // The real demuxer refuses such a port before it binds, so the double's factory refuses it before it reads its script.
    for(const inputPort of [ 65536, -1, 1.5, Number.NaN ]) {

      assert.throws(() => factory.create(initFor(inputPort)), { message: "RtpDemuxer: inputPort must be a whole number from 0 to 65535.", name: "RangeError" });
    }

    assert.equal(factory.createCalls.length, 0);

    factory.create(initFor(0));

    assert.deepEqual(factory.createCalls.map(({ demuxer }) => demuxer.inputPort), [ASSIGNED_PORT]);
  });
});
