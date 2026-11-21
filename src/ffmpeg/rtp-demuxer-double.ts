/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-demuxer-double.ts: A socket-free RtpDemuxerHandle test double - a test scripts its bind and drives its first media packet and its socket failure, with
 * no socket behind them.
 */

/**
 * A socket-free {@link RtpDemuxerHandle} test double.
 *
 * A class that stands up a two-way audio path has its hard cases in the order a demuxer's events arrive: a session already torn down when it builds the demuxer, a
 * bind that fails, a session torn down while it waits for the first media packet. This module ships the double for those - a {@link TestRtpDemuxer} a test drives one
 * event at a time, with no socket anywhere in sight - and a {@link TestRtpDemuxerFactory} that builds one per `create` from the init the consumer passed and records
 * that init, so a suite reads the ports the consumer chose from the recorded init.
 *
 * The double binds and settles as the real demuxer does: its bind completes or fails inside its constructor, from the answer a suite scripts, `ready` and
 * `mediaReady` are marked handled and reject with the lifetime's reason when the lifetime ends while they are pending, inside the constructor when the bind fails or
 * the parent signal has already aborted, and a promise that has resolved stays resolved. The levers refuse an event no real demuxer produces rather than modeling it.
 *
 * Signatures come from the demuxer's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
 * compiler saying so, and loading the double loads none of the demuxer's socket machinery.
 *
 * @module
 */
import { HbpuAbortError, composeSignals, isTimeoutReason, markHandled, onAbort } from "../util.ts";
import type { RtpDemuxerFactory, RtpDemuxerHandle, RtpDemuxerInit } from "./rtp.ts";
import { bindAnswerError, refusedBindError } from "./rtp-probe-socket-double.ts";
import type { TestSocketBind } from "./rtp-probe-socket-double.ts";

/* How far the stood-in demuxer has come since its bind, which decides whether its first packet may still arrive: "bound" until mediaReady resolves, and "flowing"
 * from then on. Whether the lifetime has ended, inside the constructor by a refused bind or a parent already aborted or at any time after, is read from the signal
 * alone.
 */
type DemuxerState = "bound" | "flowing";

/**
 * A socket-free {@link RtpDemuxerHandle} double: its bind completes or fails inside its constructor as a suite scripts it, and its first RTP packet arrives and its
 * socket fails when a test says so.
 *
 * The lifetime is the parent signal the constructor receives composed with the double's own. The parent aborting ends it with the parent's reason, `abort()` ends it
 * with the reason it is handed or with `HbpuAbortError("shutdown")` when that reason is `undefined` or `null`, and a refused bind or a socket failure ends it as
 * `"failed"` with the socket's error as its cause; whichever comes first stands. `aborted` and `isTimedOut` are read from the lifetime as the real demuxer reads them.
 *
 * The bind happens inside the constructor, as the real demuxer's does, so when construction returns the double is in a state its subject can be in. Under a parent
 * signal already aborted nothing binds, as the real demuxer returns before its bind: the answer goes unread, `ready` and `mediaReady` have rejected with the
 * parent's reason and `inputPort` reads the requested port. Otherwise a scripted port completes the bind on it, so `ready` has resolved and `inputPort` reads that
 * port, kept after the lifetime ends. A scripted `"refused"` fails the bind, the lifetime ending as `"failed"` with the refused bind's error as its cause, and with
 * no answer a specific-port construction binds its own port.
 *
 * Where it differs from the real demuxer:
 *
 * - It has no socket, so nothing is forwarded and no heartbeat runs.
 * - It has no inactivity watchdog and reads no clock, so a suite stands in for the lapse with `abort(new HbpuAbortError("timeout"))`, which `isTimedOut` reads as
 *   the real demuxer's does.
 * - It logs nothing.
 * - Its disposal has no port to wait for, so it resolves once it has aborted.
 *
 * @example
 *
 * ```ts
 * import { TestRtpDemuxerFactory, expectAt } from "homebridge-plugin-utils/testing";
 *
 * // The session's ephemeral bind completes on the port the script names, inside the demuxer's construction, as the kernel's would.
 * const factory = new TestRtpDemuxerFactory([50000]);
 * const session = new TalkbackSession({ demuxerFactory: factory, signal: controller.signal });
 * const { demuxer, init } = expectAt(factory.createCalls, 0, "the demuxer the session built");
 *
 * // The port the session asked for and the port it was bound to, read without binding anything, then the session's wait for inbound media, exercised with no
 * // socket at all.
 * assert.equal(init.inputPort, 0);
 * assert.equal(demuxer.inputPort, 50000);
 * demuxer.resolveMediaReady();
 * ```
 *
 * @see TestRtpDemuxerFactory
 *
 * @category Testing
 */
export class TestRtpDemuxer implements RtpDemuxerHandle {

  /**
   * Resolves when {@link TestRtpDemuxer.resolveMediaReady} is pulled, and rejects with the lifetime's reason when the lifetime ends while it is pending. Marked
   * handled, as the real demuxer's is.
   */
  public readonly mediaReady: Promise<void>;

  /**
   * Carries the bind's outcome, settled inside the constructor: resolved when the bind completed, and rejected with the lifetime's reason when the bind was refused
   * or the parent signal had already aborted. Marked handled, as the real demuxer's is.
   */
  public readonly ready: Promise<void>;

  /**
   * The abort signal representing this double's lifetime, composed from the parent signal the constructor received and this double's own, as the real demuxer
   * composes its parent with its own.
   */
  public readonly signal: AbortSignal;

  #assignedPort: number | undefined;

  readonly #controller = new AbortController();

  readonly #mediaReadyResolvers: PromiseWithResolvers<void>;

  readonly #readyResolvers: PromiseWithResolvers<void>;

  readonly #requestedPort: number;

  #state: DemuxerState = "bound";

  /**
   * Construct a double and settle its bind, as the real demuxer's constructor does.
   *
   * @param init           - The members of a consumer's {@link RtpDemuxerInit} the double reads.
   * @param init.inputPort - The port the real demuxer would bind: `0` for a kernel-assigned ephemeral port, any other value for that specific port.
   * @param init.signal    - The parent signal the real demuxer would compose into its lifetime: the one a consumer passes in its {@link RtpDemuxerInit}. Aborting it
   *                         ends the double with that signal's reason.
   * @param bind           - Optional. What the bind answers: the port it completes on, from 1 to 65535 and a specific-port construction's own port, or `"refused"`
   *                         for a bind the kernel rejects. With no answer, a specific-port construction binds its own port. Unread under a parent signal already
   *                         aborted, since nothing binds then.
   *
   * @throws An `Error` when a construction that binds is handed a port that is not a whole number from 1 to 65535, when a specific-port construction is handed
   *         another port, and when an ephemeral construction is handed no answer, since only a suite can name the port a kernel would assign.
   */
  public constructor(init: Pick<RtpDemuxerInit, "inputPort" | "signal">, bind?: TestSocketBind) {

    this.#requestedPort = init.inputPort;
    this.signal = composeSignals(init.signal, this.#controller.signal);
    this.#readyResolvers = Promise.withResolvers();
    this.#mediaReadyResolvers = Promise.withResolvers();
    this.ready = markHandled(this.#readyResolvers.promise);
    this.mediaReady = markHandled(this.#mediaReadyResolvers.promise);

    // Registered before the bind, so a parent that had already aborted, or a refused bind, rejects ready and mediaReady inside this constructor, as the real
    // demuxer's teardown does. A promise that has resolved is left as it is, because a resolver settles once.
    onAbort(this.signal, () => {

      this.#readyResolvers.reject(this.signal.reason);
      this.#mediaReadyResolvers.reject(this.signal.reason);
    });

    // The real demuxer returns before its bind under a parent already aborted, so nothing binds here and the answer goes unread.
    if(this.signal.aborted) {

      return;
    }

    this.#bind(bind);
  }

  /**
   * `true` once the lifetime has ended. Derived from the signal, as the real demuxer's is.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * The port the bind completed on from the moment construction returns, kept after the lifetime ends, and the requested port when the bind was refused or the
   * parent signal had already aborted.
   */
  public get inputPort(): number {

    return this.#assignedPort ?? this.#requestedPort;
  }

  /**
   * `true` when the lifetime's reason is a timeout, read through the same rule the real demuxer reads it by.
   */
  public get isTimedOut(): boolean {

    return isTimeoutReason(this.signal.reason);
  }

  /**
   * End the lifetime, as the real demuxer's `abort()` does: with `reason`, or with `HbpuAbortError("shutdown")` when it is `undefined` or `null`. A call once the
   * lifetime has ended changes nothing.
   *
   * @param reason - Optional abort reason.
   */
  public abort(reason?: unknown): void {

    if(this.signal.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * Abort with `HbpuAbortError("shutdown")` unless the lifetime has already ended, and resolve. Safe to call more than once and after the lifetime's end.
   *
   * @returns A promise that resolves once the double has aborted.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();
  }

  /**
   * Resolve `mediaReady`, as the real demuxer's first forwarded RTP packet does.
   *
   * @throws The lifetime's reason once the lifetime has ended, a refused bind's among them, and an `Error` once `mediaReady` has resolved.
   */
  public resolveMediaReady(): void {

    this.#refuseWhenEnded();

    if(this.#state === "flowing") {

      throw new Error("TestRtpDemuxer: mediaReady has already resolved, so it cannot resolve again.");
    }

    this.#state = "flowing";
    this.#mediaReadyResolvers.resolve();
  }

  /**
   * Fail the socket after the bind, as a socket error does on the real demuxer: the lifetime ends with `HbpuAbortError("failed")` carrying `cause`, and a pending
   * `mediaReady` rejects with it. A bind that fails is scripted as `"refused"` at construction instead. Once the lifetime has ended the call changes nothing, as the
   * real demuxer passes over a socket error during its teardown.
   *
   * @param cause - The error the socket raised.
   */
  public failSocket(cause: Error): void {

    if(this.signal.aborted) {

      return;
    }

    this.#controller.abort(new HbpuAbortError("failed", { cause }));
  }

  // Settle the bind from its scripted answer, as the real demuxer's socket completes or fails its bind inside the constructor. A refused bind ends the lifetime as
  // failed with the refused bind's error as its cause, as the real socket's error does. An answer no kernel gives, a port out of range or another port than a
  // specific-port construction asked for, is refused with the Error from the check every socket double shares, as is an ephemeral bind with no answer, whose port
  // only the suite can name.
  #bind(answer: TestSocketBind | undefined): void {

    if(answer === "refused") {

      this.#controller.abort(new HbpuAbortError("failed", { cause: refusedBindError(this.#requestedPort) }));

      return;
    }

    if(answer === undefined) {

      if(this.#requestedPort === 0) {

        throw new Error("TestRtpDemuxer: an ephemeral bind completes on the port the kernel assigns, so an ephemeral construction is handed that port as its bind's " +
          "answer.");
      }

      this.#complete(this.#requestedPort);

      return;
    }

    const fault = bindAnswerError({ answer, double: "TestRtpDemuxer", requestedPort: this.#requestedPort });

    if(fault !== null) {

      throw fault;
    }

    this.#complete(answer);
  }

  // Complete the bind on a port, as the real demuxer's socket does when it starts listening: inputPort reads the port and ready resolves.
  #complete(port: number): void {

    this.#assignedPort = port;
    this.#readyResolvers.resolve();
  }

  // A lever for an event only a live demuxer can produce throws the lifetime's reason once the lifetime has ended, because no real demuxer produces one after its end.
  #refuseWhenEnded(): void {

    if(this.signal.aborted) {

      throw this.signal.reason;
    }
  }
}

/**
 * An {@link RtpDemuxerFactory} double that records every `create` call and answers a fresh {@link TestRtpDemuxer} over the init the consumer passed: the init's
 * `signal` is the double's parent signal, so the consumer's own signal ends the demuxer it gets back as it ends a real one, and the init's `inputPort` is the port the
 * double asks its bind for. A test reads the recorded init for the ports the consumer chose and the recorded demuxer to drive it.
 *
 * The factory holds a script of binds and hands each construction that binds its next answer, a specific-port construction's among them, so one script
 * interleaves every demuxer a consumer builds, in the order it builds them. An answer is spent when it is handed out, a construction under a signal already
 * aborted binds nothing and takes none, and once the script is spent each construction builds as an unscripted one does. A construction the double refuses, an
 * ephemeral one with no answer among them, throws from `create` and is not recorded. The throw reaches the consumer's own error handling around `create`, so a
 * suite that scripts too few binds reads it there as a failure the consumer handles, and its message names what the script lacked.
 *
 * @see RtpDemuxerFactory
 * @see TestRtpDemuxer
 *
 * @category Testing
 */
export class TestRtpDemuxerFactory implements RtpDemuxerFactory {

  /**
   * Every create call's init and the demuxer it answered, in order, so a test can assert the boundary was reached with what it expected and can drive the demuxer
   * that came back. A call whose construction threw is not recorded.
   */
  public readonly createCalls: { demuxer: TestRtpDemuxer; init: RtpDemuxerInit }[] = [];

  readonly #script: TestSocketBind[];

  /**
   * Construct a factory.
   *
   * @param script - Optional. What each construction that binds answers, in the order the constructions are made: the port its bind completes on, or `"refused"`.
   *                 Defaults to none, so each specific-port construction binds its own port.
   */
  public constructor(script: readonly TestSocketBind[] = []) {

    this.#script = [...script];
  }

  /**
   * Record the create call and answer a fresh double over the init's port and signal, its bind settled from the script's next answer.
   *
   * @param init - The init the consumer passed.
   *
   * @returns The demuxer double.
   *
   * @throws An `Error` when the double refuses the construction, as {@link TestRtpDemuxer} states, which reaches the consumer's own error handling.
   */
  public create(init: RtpDemuxerInit): RtpDemuxerHandle {

    // A construction under a signal already aborted binds nothing, so it leaves the script's next answer for the construction that does bind.
    const answer = (init.signal?.aborted === true) ? undefined : this.#script.shift();
    const demuxer = new TestRtpDemuxer(init, answer);

    this.createCalls.push({ demuxer, init });

    return demuxer;
  }
}
