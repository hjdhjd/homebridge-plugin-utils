/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-publish.test.ts: Unit tests for the MQTT publish-outcome vocabulary - the offline refusal, the pure guarded-publish failure router, the derivation that names
 * the reason a repeat is weighed by, and the per-topic memory a change-gated publish is weighed against - and for the end sequence that states a plugin's final
 * words, the admission a publish meets once the end has begun, and the check that tells a callback the end or the abort cut short apart from one that failed.
 *
 * The router's rows drive the pure function directly with a capturing log, so what they assert is the classification itself rather than any one caller's route to it;
 * the client's guarded publish over a real broker stays in the client's own suite. The reason derivation's rows do the same with synthetic rejections, which is what
 * lets every shape a publish can reject with be stated rather than only the shapes a broker can be talked into producing. The memory's rows drive the class directly
 * for the same reason: what they state is the comparison and the keeping rule themselves, while the client's and the double's suites state how each one reaches them.
 * The end sequence's rows drive the function on a TestClock, so the order, the window and the refusals are stated where they live, and the client's suite carries
 * the row that proves a stated word reaches a real broker ahead of the will. The admission's rows drive the pure function over end states built by hand, while the
 * client's and the double's suites state the quiet each one keeps through it. The check's row does the same, and those suites state the line each wrapped callback
 * reaches through it.
 */
import { HbpuAbortError, composeSignals, isTimeoutReason } from "./util.ts";
import { MqttLastPayloads, MqttOfflineError, assertAdmittedDuringMqttEnd, guardedPublishReason, isMqttCallbackCutShort, routeGuardedPublishFailure,
  stateMqttFinalWords } from "./mqtt-publish.ts";
import { capturingLog, errnoError, expectAt, settle } from "./testing/index.ts";
import { describe, test } from "node:test";
import type { CapturingLog } from "./testing/index.ts";
import type { MqttEndState } from "./mqtt-publish.ts";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";
import { firstRendered } from "./mqtt.helpers.ts";

describe("routeGuardedPublishFailure - pure function", () => {

  // The router is where the client and the shipped double meet, so these cases are the contract both of them inherit: which term answers first, and what each outcome
  // reads as on the line. Every case builds its own controllers so nothing carries between them, and the topic is fixed because the router only ever names it.
  const TOPIC = "test/device1/status";

  // Route one synthetic outcome and answer the log it wrote, so each case reads as the terms it sets and the single line they produce.
  function route(options: { clientSignal: AbortSignal; error: unknown; publishSignal?: AbortSignal }): CapturingLog {

    const log = capturingLog();

    routeGuardedPublishFailure({ clientSignal: options.clientSignal, error: options.error, log, publishSignal: options.publishSignal, topic: TOPIC });

    return log;
  }

  test("an aborted client signal routes a plain error to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();

    client.abort(new Error("going away"));

    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message."), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("an aborted per-publish signal routes a plain error to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();

    perPublish.abort(new Error("device disposed"));

    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message."), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("an HbpuAbortError with both signals live routes to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const log = route({ clientSignal: client.signal, error: new HbpuAbortError("shutdown"), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("a platform AbortError with both signals live routes to the aborted line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const rejection = new Error("The operation was aborted");

    rejection.name = "AbortError";

    const log = route({ clientSignal: client.signal, error: rejection, publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("an MqttOfflineError with both signals live routes to the dropped line at debug", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const log = route({ clientSignal: client.signal, error: new MqttOfflineError(), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish dropped while disconnected from the broker: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("a plain error with both signals live routes to the failure line at error", () => {

    const client = new AbortController();
    const perPublish = new AbortController();
    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message."), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "Unable to publish to the MQTT topic test/device1/status: broker refused the message.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["error"]);
  });

  test("an aborted client signal outranks an MqttOfflineError", () => {

    // The ordering the router exists to state: a publish the caller has already torn down is cancelled, whatever the rejection that surfaced on the way out says.
    const client = new AbortController();
    const perPublish = new AbortController();

    client.abort(new HbpuAbortError("shutdown"));

    const log = route({ clientSignal: client.signal, error: new MqttOfflineError(), publishSignal: perPublish.signal });

    assert.equal(firstRendered(log), "MQTT publish aborted: test/device1/status.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["debug"]);
  });

  test("a caller that supplies no per-publish signal still reaches the failure line", () => {

    const client = new AbortController();
    const log = route({ clientSignal: client.signal, error: new Error("broker refused the message.") });

    assert.equal(firstRendered(log), "Unable to publish to the MQTT topic test/device1/status: broker refused the message.");
    assert.deepEqual(log.entries.map((entry) => entry.level), ["error"]);
  });
});

describe("guardedPublishReason - pure function", () => {

  // The derivation sits beside the router because both callers of the router call it too, and it is asserted against synthetic rejections rather than driven through
  // a client: a publish can reject with anything at all, and only a direct read states every shape rather than the ones a broker can be provoked into producing.
  test("the transport's own code is the tag wherever the rejection carries one", () => {

    // A broker refusing for one reason refuses every topic for it, so the code and not the topic is what a repeat is weighed by.
    assert.equal(guardedPublishReason(errnoError("write EPIPE", "EPIPE")), "EPIPE");
  });

  test("a rejection carrying no code answers its rendered message", () => {

    assert.equal(guardedPublishReason(new Error("broker refused the message")), "broker refused the message");
  });

  test("a numeric code is not a tag of its own here, so the rendered message answers instead", () => {

    // The guarded path reads a string code alone: anything else is rendered, which keeps one expression answering for every rejection shape a publish can carry.
    assert.equal(guardedPublishReason(errnoError("refused with a numeric code", 135)), "refused with a numeric code");
  });

  test("a non-Error rejection is rendered rather than refused a tag", () => {

    // A publish can reject with any value at all, and every one of them has to answer something an adapter can compare.
    assert.equal(guardedPublishReason("string-shaped failure"), "string-shaped failure");
  });

  test("an unchanged reason answers an equal tag, and a changed one does not", () => {

    // This is the whole of what the demotion rests on: equality of the derived tag, not identity of the rejection.
    assert.equal(guardedPublishReason(new Error("broker refused the message")), guardedPublishReason(new Error("broker refused the message")));
    assert.notEqual(guardedPublishReason(new Error("broker refused the message")), guardedPublishReason(new Error("broker refused the credentials")));
  });
});

describe("MqttLastPayloads - the change-gated memory", () => {

  // The memory is the one rule the client and the double both apply, so these rows state it where it lives rather than through either holder. The topics are spelled
  // as a caller spells them, since the class keys on exactly what it is handed.
  const TOPIC = "device1/status";
  const OTHER = "device2/status";

  test("answers false for a topic nothing was remembered for, and remembers one topic without touching another", () => {

    const memory = new MqttLastPayloads();

    assert.equal(memory.sameAsLast(TOPIC, "on"), false, "the first change-gated publish on any topic must go out");

    memory.remember(TOPIC, "on");

    assert.equal(memory.sameAsLast(TOPIC, "on"), true);
    assert.equal(memory.sameAsLast(TOPIC, "off"), false);
    assert.equal(memory.sameAsLast(OTHER, "on"), false, "remembering one topic must leave every other topic unremembered");
  });

  test("compares two Buffers by their bytes", () => {

    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, Buffer.from("on"));

    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("on")), true);
    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("off")), false);
  });

  test("never treats a string and a Buffer as the same payload, in either order", () => {

    // A topic's payloads are one kind or the other, so the cross-kind answer is the one that costs nothing: a string is never encoded to be compared.
    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, "on");

    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("on")), false);

    memory.remember(OTHER, Buffer.from("on"));

    assert.equal(memory.sameAsLast(OTHER, "on"), false);
  });

  test("keeps a copy of a remembered Buffer, so a caller rewriting its own buffer is weighed against the bytes that went out", () => {

    const memory = new MqttLastPayloads();
    const scratch = Buffer.from("on");

    memory.remember(TOPIC, scratch);
    scratch.write("no");

    assert.equal(memory.sameAsLast(TOPIC, Buffer.from("on")), true, "a fresh buffer carrying the delivered bytes must still read as unchanged");
    assert.equal(memory.sameAsLast(TOPIC, scratch), false, "the rewritten buffer carries different bytes and must read as a change");
  });

  test("replaces what a topic held when it is remembered again", () => {

    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, "on");
    memory.remember(TOPIC, "off");

    assert.equal(memory.sameAsLast(TOPIC, "off"), true);
    assert.equal(memory.sameAsLast(TOPIC, "on"), false, "only the latest payload is remembered");
  });

  test("forgets every topic when it is cleared", () => {

    const memory = new MqttLastPayloads();

    memory.remember(TOPIC, "on");
    memory.remember(OTHER, Buffer.from("on"));
    memory.clear();

    assert.equal(memory.sameAsLast(TOPIC, "on"), false);
    assert.equal(memory.sameAsLast(OTHER, Buffer.from("on")), false);
  });

  test("answers a token for each write, and forgets a topic only while its entry still carries the token a failed publish was given", () => {

    // Each remember mints its own token, so a later write of the same string keeps an entry the earlier write's failure cannot reach, and a forget leaves every
    // other topic alone.
    const memory = new MqttLastPayloads();
    const earlier = memory.remember(TOPIC, "on");
    const later = memory.remember(TOPIC, "on");

    memory.remember(OTHER, "on");

    assert.notEqual(earlier, later, "each write is given a token of its own, even for the same payload");

    memory.forget(TOPIC, earlier);

    assert.equal(memory.sameAsLast(TOPIC, "on"), true, "the entry carries the later write's token, so it stays");

    memory.forget(TOPIC, later);

    assert.equal(memory.sameAsLast(TOPIC, "on"), false, "the entry still carried the token, so it is forgotten");
    assert.equal(memory.sameAsLast(OTHER, "on"), true, "forgetting one topic leaves every other topic remembered");
  });
});

describe("stateMqttFinalWords - the end sequence the client and the double share", () => {

  // The sequence is driven directly on a TestClock with a grace of its own, so each row states the order, the window and the refusals themselves, while the client's
  // and the double's suites state how each one reaches the sequence.
  const GRACE_MS = 500;

  // A word that never settles, standing for a publish the broker never answers.
  const unanswered = (): Promise<void> => new Promise<void>(() => { /* Never settles. */ });

  // The window callback a row hands the sequence when the window is not what the row is about.
  const ignoreWindow = (): void => { /* The window is not this row's subject. */ };

  test("invokes every handler synchronously, in order, with one live window, and resolves no refusals when every word settles", async () => {

    const clock = new TestClock();
    const calls: string[] = [];
    const windows: AbortSignal[] = [];
    const stated = stateMqttFinalWords({ clock, grace: GRACE_MS, handlers: [

      (signal): void => {

        calls.push("first");
        windows.push(signal);
      },
      async (signal): Promise<void> => {

        calls.push("second");
        windows.push(signal);

        await Promise.resolve();
      }
    ], onWindow: ignoreWindow, signal: new AbortController().signal });

    // Every handler has run before the sequence's first await, which is what puts every word on the wire while the owner still holds its session.
    assert.deepEqual(calls, [ "first", "second" ], "every handler must be invoked synchronously, in registration order");
    assert.equal(expectAt(windows, 0), expectAt(windows, 1), "every handler must be handed the one window");
    assert.equal(expectAt(windows, 0).aborted, false, "and the window must be open while the words are issued");
    assert.deepEqual(await stated, [], "a word that settled leaves no refusal behind");
    assert.equal(clock.pending, 0, "the grace's deadline must be released once the words have settled");
  });

  test("answers a synchronous throw and a rejection as refusals in registration order, and leaves nothing for a word that settled", async () => {

    const thrown = new Error("the second handler threw.");
    const rejected = new Error("the third handler rejected.");
    const calls: string[] = [];
    const refusals = await stateMqttFinalWords({ clock: new TestClock(), grace: GRACE_MS, handlers: [

      (): void => {

        calls.push("first");
      },
      (): void => {

        throw thrown;
      },
      async (): Promise<void> => {

        throw rejected;
      },
      (): void => {

        calls.push("fourth");
      }
    ], onWindow: ignoreWindow, signal: new AbortController().signal });

    assert.deepEqual(refusals, [ thrown, rejected ], "each refusal must come back in the order its handler was registered");
    assert.deepEqual(calls, [ "first", "fourth" ], "a handler that throws must hold back none of the handlers after it");
  });

  test("refuses a word still unsettled when the grace runs out with the deadline's reason, and not a moment before", async () => {

    const clock = new TestClock();
    const windows: AbortSignal[] = [];
    let settled = false;

    const stated = stateMqttFinalWords({ clock, grace: GRACE_MS, handlers: [(signal): Promise<void> => {

      windows.push(signal);

      return unanswered();
    }], onWindow: ignoreWindow, signal: new AbortController().signal });

    void stated.then(() => {

      settled = true;
    });

    clock.advance(GRACE_MS - 1);
    await settle();

    assert.equal(settled, false, "the sequence must still be waiting a millisecond short of the grace");

    clock.advance(1);

    const [refusal] = await stated;

    assert.ok(isTimeoutReason(refusal), "a word unsettled at the grace must refuse with the deadline's TimeoutError");
    assert.equal(refusal, expectAt(windows, 0).reason, "which is the reason the handler's window aborted with");
  });

  test("refuses a word still unsettled when the owner's signal aborts with the owner's reason, ahead of the grace", async () => {

    const clock = new TestClock();
    const owner = new AbortController();
    const reason = new HbpuAbortError("shutdown");
    const stated = stateMqttFinalWords({ clock, grace: GRACE_MS, handlers: [unanswered], onWindow: ignoreWindow, signal: owner.signal });

    owner.abort(reason);

    assert.deepEqual(await stated, [reason], "the window closes on the owner's abort, so the word must refuse with the owner's own reason");
    assert.equal(clock.now(), 0, "and no virtual time passed to get there");
  });

  test("yields one turn of the event loop once the words settle, so a tick a handler queued has run by the time it resolves", async () => {

    /* The tick stands for the uncork mqtt.js queues as it writes a publish. The sequence starts inside a microtask continuation, the frame a shutdown handler runs
     * `end()` from after its first await, where every step up to the resolution is itself a microtask and would run ahead of the tick without the yield.
     */
    await Promise.resolve();

    let ticked = false;

    const refusals = await stateMqttFinalWords({ clock: new TestClock(), grace: GRACE_MS, handlers: [(): void => {

      process.nextTick(() => {

        ticked = true;
      });
    }], onWindow: ignoreWindow, signal: new AbortController().signal });

    assert.deepEqual(refusals, []);
    assert.equal(ticked, true, "the tick queued while the word was issued must have run before the sequence resolves");
  });

  test("hands onWindow the window once, before the first handler runs, and it is the signal every handler receives", async () => {

    // The callback is where an owner records the window its admission reads, so it has to run ahead of every handler: a word issued synchronously from the first
    // handler meets an owner that already knows its window. One shared log orders the callback against the handlers rather than counting each on its own.
    const calls: string[] = [];
    const recorded: AbortSignal[] = [];
    const windows: AbortSignal[] = [];
    const stated = stateMqttFinalWords({ clock: new TestClock(), grace: GRACE_MS, handlers: [

      (signal): void => {

        calls.push("first");
        windows.push(signal);
      },
      (signal): void => {

        calls.push("second");
        windows.push(signal);
      }
    ], onWindow: (window): void => {

      calls.push("window");
      recorded.push(window);
    }, signal: new AbortController().signal });

    assert.deepEqual(calls, [ "window", "first", "second" ], "onWindow must run once, ahead of the first handler");
    assert.equal(expectAt(recorded, 0), expectAt(windows, 0), "with the very signal the first handler is handed");
    assert.equal(expectAt(recorded, 0), expectAt(windows, 1), "and the second");
    assert.deepEqual(await stated, []);
    assert.deepEqual(calls, [ "window", "first", "second" ], "and it must not run again as the words settle");
  });
});

// The words promise an end state built by hand carries: a stand-in, since neither the admission nor the check reads it.
const WORDS: Promise<unknown[]> = Promise.resolve([]);

describe("assertAdmittedDuringMqttEnd - the admission a publish meets once the end has begun", () => {

  // The admission is the one rule the client's publish and the double's each read, so these rows state it where it lives, over states built by hand.
  const SHUTDOWN = { constructor: HbpuAbortError, name: "shutdown" };

  test("admits every publish before the end begins, with a signal of its own or without one", () => {

    const end: MqttEndState = { kind: "open" };

    assert.doesNotThrow(() => assertAdmittedDuringMqttEnd({ end }));
    assert.doesNotThrow(() => assertAdmittedDuringMqttEnd({ end, signal: new AbortController().signal }));
  });

  test("admits a publish under the window while the end is stating, and one whose signal was composed from the window alone, which is the window itself", () => {

    const window = new AbortController().signal;
    const end: MqttEndState = { kind: "stating", window, words: WORDS };

    assert.doesNotThrow(() => assertAdmittedDuringMqttEnd({ end, signal: window }));
    assert.doesNotThrow(() => assertAdmittedDuringMqttEnd({ end, signal: composeSignals(window, undefined) }),
      "composing a single signal hands it back unchanged, so a word passed through that way is still the window");
  });

  test("refuses a publish carrying no signal while the end is stating, with the end's shutdown error", () => {

    const end: MqttEndState = { kind: "stating", window: new AbortController().signal, words: WORDS };

    assert.throws(() => assertAdmittedDuringMqttEnd({ end }), SHUTDOWN);
  });

  test("refuses a publish carrying any other signal while the end is stating, one composed from the window and a second signal among them", () => {

    const window = new AbortController().signal;
    const end: MqttEndState = { kind: "stating", window, words: WORDS };

    assert.throws(() => assertAdmittedDuringMqttEnd({ end, signal: new AbortController().signal }), SHUTDOWN, "an unrelated signal must be refused");
    assert.throws(() => assertAdmittedDuringMqttEnd({ end, signal: composeSignals(window, new AbortController().signal) }), SHUTDOWN,
      "and so must a signal composed from the window and another, which is a fresh signal rather than the window");
  });

  test("refuses every publish once the end is closing, with a signal or without one", () => {

    const end: MqttEndState = { kind: "closing", words: WORDS };

    assert.throws(() => assertAdmittedDuringMqttEnd({ end }), SHUTDOWN);
    assert.throws(() => assertAdmittedDuringMqttEnd({ end, signal: new AbortController().signal }), SHUTDOWN);
  });
});

describe("isMqttCallbackCutShort - the check that tells a callback the end or the abort cut short apart from one that failed", () => {

  // The check is the one rule the client's wrapped callbacks and the double's connect pass each read, so this row states it where it lives, over every end state
  // built by hand beside a live lifetime and one aborted with an HbpuAbortError or with no reason at all.
  test("answers true for any error once the signal has aborted or for an abort error while stating or closing, and false for every other error while live", () => {

    const shutdown = new AbortController();
    const bare = new AbortController();

    shutdown.abort(new HbpuAbortError("shutdown"));
    bare.abort();

    const live = new AbortController().signal;
    const open: MqttEndState = { kind: "open" };
    const stating: MqttEndState = { kind: "stating", window: new AbortController().signal, words: WORDS };
    const closing: MqttEndState = { kind: "closing", words: WORDS };
    const timeout = new HbpuAbortError("timeout");
    const failure = new Error("device rejected update");
    const platform: unknown = bare.signal.reason;

    // Once the owner's signal has aborted the failure's shape says nothing, so every failure reads as cut short in every end state, whichever reason the signal
    // aborted with, the platform's AbortError a bare abort() hands a publish among them.
    for(const end of [ open, stating, closing ]) {

      for(const signal of [ shutdown.signal, bare.signal ]) {

        for(const error of [ failure, timeout, platform ]) {

          assert.equal(isMqttCallbackCutShort({ end, error, signal }), true, "any failure once the owner's signal has aborted was cut short, while " + end.kind);
        }
      }

      assert.equal(isMqttCallbackCutShort({ end, error: failure, signal: live }), false,
        "a failure that is no HbpuAbortError is the callback's own while " + end.kind + " and the owner lives");
    }

    assert.equal(isMqttCallbackCutShort({ end: open, error: timeout, signal: live }), false,
      "an HbpuAbortError before the end begins and while the owner lives is the callback's own, its own timeout among them");
    assert.equal(isMqttCallbackCutShort({ end: stating, error: timeout, signal: live }), true, "while the end states its words an HbpuAbortError was cut short");
    assert.equal(isMqttCallbackCutShort({ end: closing, error: timeout, signal: live }), true, "and so once the end is closing");
  });
});
