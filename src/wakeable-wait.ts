/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * wakeable-wait.ts: A wait a second party can end early under a stated reason, while the lifetime signal stays terminal.
 */

/**
 * A wait a second party can end early under a stated reason, while the lifetime signal stays terminal.
 *
 * A plugin's connect loop pauses a fixed interval between attempts: sixty seconds under the home's lifetime signal when no gateway answered as the primary, a
 * minute between looks at a device that has gone quiet. Something else in the plugin learns, mid-pause, that the answer has changed - a discovery browse announces
 * a gateway, an election picks a different one, an address moves - and the loop reads none of it until its pause runs out, so the change is consumed up to one full
 * interval late. Nothing in the time-source contract closes that gap: {@link Clock.delay} ends a wait on abort alone, by rejecting, and a rejection is how a
 * lifetime ends rather than how a loop is nudged.
 *
 * The shape here is the auto-reset event every threading library ships, expressed in this library's own vocabulary. A consumer holds one object for the life of its
 * loop, awaits that object instead of the bare delay, and reads a tagged outcome saying which way the pause ended. A wake is remembered rather than dropped: one
 * that arrives while the loop is off probing rather than pausing is consumed by the next wait, which answers at once without ever registering a delay, so the
 * change that landed in the wrong window is not the one the design loses.
 *
 * It is a class of its own rather than a member on {@link Clock}, because a wake is not a matter of time and every double of the time source would owe an
 * implementation of it, and rather than a hook inside `retry`, because the loops that want it are hand-written loops over a bare delay rather than retry calls and
 * threading a wake through that contract would serve no caller. The lifetime signal is composed per wait and never listened to, so a loop pausing every minute for
 * weeks accumulates nothing and there is no teardown to own.
 *
 * @module
 */
import type { Clock } from "./clock.ts";
import { composeSignals } from "./util.ts";
import { systemClock } from "./clock.ts";

/**
 * Construction options for {@link WakeableWait}.
 *
 * @category Utilities
 */
export interface WakeableWaitOptions {

  /**
   * The time source every wait runs on. Defaults to {@link systemClock}; a harness injects a `TestClock` and proves the wake on virtual time rather than by sleeping.
   */
  clock?: Clock;

  /**
   * The lifetime. While it is aborted no wait runs at all, and a wait in flight rejects with its reason. Omit it for a wait with no lifetime bound. The signal is only
   * ever read and composed into each wait's own composite - the class attaches no listener to it (see the class documentation).
   */
  signal?: AbortSignal;
}

/**
 * How a {@link WakeableWait.wait} ended, tagged by `kind` so a consumer branches on the tag rather than on whether a reason happens to be present. The reason is
 * readable only on the arm that has one, which is what keeps a consumer from reading a reason off a wait that simply ran out.
 *
 * @typeParam R - The consumer's own vocabulary for why a wait was woken, carried through untouched.
 *
 * @category Utilities
 */
export type WakeableWaitOutcome<R> = { readonly kind: "elapsed" } | { readonly kind: "woken"; readonly reason: R };

/**
 * A wait a second party ends early under a stated reason, resuming the waiter rather than rejecting it.
 *
 * {@link WakeableWait.wait} pauses for `ms` on the injected clock and answers `{ kind: "elapsed" }` when the clock crosses that window, or `{ kind: "woken", reason }`
 * as soon as {@link WakeableWait.wake} is called with that reason. Each is an ordinary return, because a loop that was nudged has work to do and unwinding it through
 * a rejection would leave every caller writing the same try/catch to get back where it already was. Rejection is reserved for the lifetime.
 *
 * A wake is remembered until a wait consumes it. Waking while no wait is in progress is not a lost signal: the next wait answers `woken` with that reason at once and
 * registers no delay at all, which is the auto-reset contract and the whole reason this exists - what a consumer is racing lands as readily while its loop is working
 * as while its loop is paused. The first wake wins and later ones do nothing until a wait consumes it, exactly as a controller's first `abort()` wins, so waking twice,
 * or waking a wait that has already ended, is harmless without the consumer checking anything first.
 *
 * The lifetime is terminal and always wins. Once the supplied signal aborts, a wait in flight rejects with that signal's own reason, a later wait rejects without
 * touching the clock, and a remembered wake changes neither.
 *
 * One waiter at a time. A second concurrent {@link WakeableWait.wait} throws rather than silently orphaning the first wait's controller and delivering its wake to the
 * wrong waiter, stated at the boundary in the way {@link composeSignals} states its own misuse.
 *
 * There is nothing to dispose. Each wait composes the lifetime signal with a private controller of its own and hands the composite to the clock, so a wake IS an abort
 * of that private controller and the lifetime signal is read and composed, never listened to. The platform holds a composed signal only while it carries a listener,
 * and the clock detaches its listener the moment it settles the delay, so a loop pausing every minute for weeks leaves nothing attached to anything.
 *
 * @typeParam R - The consumer's vocabulary for why it woke a wait, delivered verbatim on the `woken` outcome. Defaults to `string`, which is what a consumer wanting a
 * plain label builds without naming the parameter.
 *
 * @example
 *
 * ```ts
 * import { WakeableWait } from "homebridge-plugin-utils";
 *
 * // The pause a connect loop takes between attempts, bounded by the plugin's lifetime.
 * const pause = new WakeableWait({ signal: this.signal });
 *
 * // Whatever learns the answer has changed ends that pause early, in its own vocabulary.
 * this.browser.on("changed", () => pause.wake("candidates changed"));
 *
 * // The loop reads which way its pause ended and decides what that means.
 * const outcome = await pause.wait(60000);
 *
 * if(outcome.kind === "woken") {
 *
 *   this.log.debug("Retrying early.", { reason: outcome.reason });
 * }
 * ```
 *
 * @category Utilities
 */
export class WakeableWait<R = string> {

  // The injected time source. Every wait in this class goes through it, so a harness drives the whole pause on virtual time.
  readonly #clock: Clock;

  // A wake nobody has consumed yet, held until a wait takes it. Undefined means none is outstanding: the first wake to arrive fills this, and later ones find it
  // filled and leave it alone, which is what makes the reason a wait reads the first reason rather than the last.
  #pendingWake: { readonly reason: R } | undefined;

  // The lifetime signal, when one was supplied. It is read and composed, never listened to.
  readonly #signal: AbortSignal | undefined;

  // The controller of the wait in flight, which is also how this class knows one is. A wake aborts it to end that wait, and the wait clears it on the way out
  // whichever way it ended.
  #waiting: AbortController | undefined;

  /**
   * Build a wakeable wait. Construction registers nothing and starts nothing; the first {@link WakeableWait.wait} does.
   *
   * @param options - See {@link WakeableWaitOptions}.
   */
  public constructor({ clock = systemClock, signal }: WakeableWaitOptions = {}) {

    this.#clock = clock;
    this.#signal = signal;
  }

  /**
   * End the wait in progress, or arm the next one, under `reason`.
   *
   * A wait in flight resolves `{ kind: "woken", reason }` without waiting out the rest of its window. With no wait in progress the reason is remembered and the next
   * wait consumes it immediately, registering no delay, so a consumer never has to know which side of the pause it caught the loop on. The first wake wins: a second
   * one arriving before a wait has consumed the first leaves that first reason standing, so a burst of wakes buys one early return rather than overwriting the reason
   * the consumer is about to read.
   *
   * @param reason - Why the wait is being ended, in the consumer's own vocabulary. Delivered verbatim on the `woken` outcome.
   */
  public wake(reason: R): void {

    // A wake still waiting to be consumed stands as it is. Returning here is what makes the first reason the one a wait reads: a burst of wakes before any
    // wait consumes them buys one early return under the first reason rather than the last.
    if(this.#pendingWake !== undefined) {

      return;
    }

    this.#pendingWake = { reason };

    // The reason travels on `#pendingWake` alone, so the controller is aborted with no reason of its own: a woken outcome reads its typed reason from one place rather
    // than digging an untyped one back out of a signal.
    this.#waiting?.abort();
  }

  /**
   * Wait up to `ms` milliseconds, ending early when {@link WakeableWait.wake} is called.
   *
   * @param ms - How long to wait, in milliseconds, when nothing wakes it.
   *
   * @returns `{ kind: "elapsed" }` when the clock crossed `ms`, or `{ kind: "woken", reason }` when a wake ended the wait or was already waiting to be consumed when
   *          the wait began.
   *
   * @throws The lifetime signal's own reason when that signal aborts before or during the wait, or an `Error` when a wait is already in progress.
   */
  public async wait(ms: number): Promise<WakeableWaitOutcome<R>> {

    // The lifetime is terminal, so it is read before anything else: a remembered wake does not buy a wait against a lifetime that is over.
    this.#signal?.throwIfAborted();

    // One waiter at a time. Two waits sharing one object would strand the first one's controller and hand its wake to the wrong waiter, so the misuse is stated at the
    // boundary rather than absorbed into behavior nobody could reason about.
    if(this.#waiting !== undefined) {

      throw new Error("WakeableWait: a wait is already in progress.");
    }

    const latched = this.#consumeWake();

    // A wake that arrived before this wait did answers it here, and the clock is never asked for a delay that would only have to be torn down again.
    if(latched !== undefined) {

      return latched;
    }

    const controller = new AbortController();

    this.#waiting = controller;

    try {

      await this.#clock.delay(ms, { signal: composeSignals(this.#signal, controller.signal) });

      return { kind: "elapsed" };
    } catch(error: unknown) {

      // Both sides reject the delay with the same platform `AbortError`, so the signals tell them apart rather than the error, and the lifetime is read first because
      // it wins over a wake that landed in the same tick.
      this.#signal?.throwIfAborted();

      const woken = this.#consumeWake();

      /* A rejection with neither side aborted is the clock's own fault, rethrown as it came rather than dressed up as a wake. This is the boundary the read cannot
       * cross: a clock fault landing in the same window as a wake is answered as the wake, because no reading of state after the fact can tell the two apart. Only a
       * clock breaking the contract {@link Clock.delay} states - rejecting with its signal unaborted - can raise such a fault at all, so what is covered here is the
       * fault a conformant clock can raise, and the coincidence sits outside what this class can distinguish.
       */
      if(woken === undefined) {

        throw error;
      }

      return woken;
    } finally {

      // Whichever way the wait ended, the object is free for the next one. A wake landing between here and the caller's continuation therefore finds no wait in
      // progress and is remembered, which is what the auto-reset contract asks for.
      this.#waiting = undefined;
    }
  }

  // Take the outstanding wake, if there is one, and clear it. Every place a wake is consumed - a wait that found one already waiting and a wait the wake ended - goes
  // through this, so reading the reason and clearing the latch is written once and those paths cannot drift apart.
  #consumeWake(): WakeableWaitOutcome<R> | undefined {

    const pending = this.#pendingWake;

    if(pending === undefined) {

      return undefined;
    }

    this.#pendingWake = undefined;

    return { kind: "woken", reason: pending.reason };
  }
}
