/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timer-registry.ts: A lifetime-bounded registry of callback timers - keyed one-shots and intervals plus anonymous one-shots - armed, fired, and drained as one.
 */

/**
 * A lifetime-bounded registry of callback timers.
 *
 * A long-lived owner - a HomeKit accessory, a controller subsystem - accumulates timers it must all cancel when it tears down: keyed one-shots that a later registration
 * under the same key should replace, keyed intervals that repeat until cleared, and anonymous fire-and-forget one-shots with no identity to replace. This registry holds
 * all three under one disposal story. Arming a keyed timer replaces any prior timer under that key; a keyed one-shot removes its own entry before firing, so the callback
 * reads the key as already gone; an anonymous one-shot self-removes on fire; and `dispose()`, or an aborted lifetime signal, drains every pending timer and makes every
 * later registration inert, so a timer can never outlive the owner it was armed against.
 *
 * This is the callback-timer half of the library's time mechanisms: `Clock` owns awaited, promise-shaped delays, and this registry owns callback timers - one mechanism
 * per shape, neither reaching into the other's territory.
 *
 * @module
 */
import { onAbort } from "./util.ts";

/**
 * Construction options for {@link TimerRegistry}.
 *
 * @category Utilities
 */
export interface TimerRegistryOptions {

  /**
   * A lifetime signal. When it aborts, the registry drains every pending timer and every later registration becomes inert; a signal already aborted at construction time
   * means the registry is born disposed. Omit it for a registry whose only lifetime bound is an explicit `dispose()`.
   */
  signal?: AbortSignal;
}

/**
 * A lifetime-bounded registry of callback timers: keyed one-shots and intervals, plus anonymous tracked one-shots.
 *
 * The surface is minimal on purpose:
 *
 *   - `setTimeout(key, callback, delay)` / `setInterval(key, callback, interval)` arm a keyed timer. Registering under a key that already holds a timer - of either
 *     kind - clears the prior timer first, so the newest intent for a key wins. A keyed one-shot removes its entry before firing; a keyed interval repeats until cleared.
 *   - `schedule(callback, delay)` arms an anonymous one-shot: tracked for disposal, self-removing on fire, never replacing anything, so concurrent anonymous timers
 *     coexist.
 *   - `clear(key)` cancels and removes a keyed timer; `has(key)` reports whether one is currently armed.
 *   - `dispose()` (and `[Symbol.dispose]`) drains every pending timer and retires the registry: subsequent registrations are no-ops. An `options.signal` binds the same
 *     drain to the owner's lifetime, so the owner never has to unwire the registry by hand at teardown.
 *
 * This is a `Disposable` (synchronous) rather than `AsyncDisposable` because cancelling a timer is synchronous; there is no background work to await.
 *
 * @example
 *
 * ```ts
 * using timers = new TimerRegistry({ signal: this.signal });
 *
 * timers.setTimeout("relock", () => this.relock(), 5000);
 * timers.setInterval("heartbeat", () => this.beat(), 1000);
 * timers.schedule(() => this.settle(), 50);
 * ```
 *
 * @category Utilities
 */
export class TimerRegistry implements Disposable {

  // Keyed timers, one-shots and intervals alike: a key holds at most one live timer, so registering under a key replaces whatever it held.
  readonly #keyed = new Map<string, NodeJS.Timeout>();

  // Anonymous one-shots, tracked only so disposal can drain them: no key, no replacement, each self-removing when it fires.
  readonly #anonymous = new Set<NodeJS.Timeout>();

  // Flipped once by `dispose()`. A disposed registry drains nothing further and arms nothing further.
  #disposed = false;

  // The lifetime signal, when one was supplied. Registration guards read its aborted state so a registration racing the abort cascade cannot arm a timer that would
  // outlive the drain.
  readonly #signal: AbortSignal | undefined;

  // The abort-listener handle. Disposing it inside `dispose()` detaches the listener from a long-lived composed signal, so a registry disposed directly does not leave a
  // handler attached to a signal that outlives it.
  readonly #abortRegistration: Disposable | undefined;

  /**
   * Construct a registry. Construction schedules no timers. When `options.signal` is supplied, the abort handler is wired through {@link onAbort} last, against the
   * already-initialized containers and flag; a signal already aborted at that point disposes the registry synchronously here, so it is born drained and inert.
   *
   * @param options - See {@link TimerRegistryOptions}.
   */
  public constructor(options: TimerRegistryOptions = {}) {

    this.#signal = options.signal;

    // Wire the abort handler last, against fully-initialized fields, because `onAbort` runs the handler inline for an already-aborted signal - that inline call disposes
    // the registry mid-construction, which is exactly the born-disposed outcome.
    if(this.#signal !== undefined) {

      this.#abortRegistration = onAbort(this.#signal, () => this.dispose());
    }
  }

  /**
   * Arm a keyed one-shot. Any timer already armed under `key` - one-shot or interval - is cleared first, so registering under a key declares the current intent for it
   * and the newest intent wins. The entry is removed BEFORE the callback runs, so the callback, and anything it triggers, reads `has(key)` as `false` for a fired timer.
   * A no-op once the registry is disposed or its lifetime signal has aborted.
   *
   * @param key      - The identity under which the timer is tracked; a later registration under the same key replaces this one.
   * @param callback - The function to run once, after `delay`.
   * @param delay    - The delay, in milliseconds.
   */
  public setTimeout(key: string, callback: () => void, delay: number): void {

    if(this.#disposed || (this.#signal?.aborted ?? false)) {

      return;
    }

    this.clear(key);

    // Call the GLOBAL `setTimeout`, not the `node:timers` binding, so any harness that replaces the globals - including `node:test` `mock.timers` - observes every timer
    // this registry arms.
    const handle = setTimeout(() => {

      // Remove the entry before running the callback, so a fired one-shot reads as absent to the callback and to anything the callback triggers.
      this.#keyed.delete(key);
      callback();
    }, delay);

    this.#keyed.set(key, handle);
  }

  /**
   * Arm a keyed repeating timer. Any timer already armed under `key` - one-shot or interval - is cleared first, the same replace-on-register rule as {@link setTimeout}.
   * The entry persists across fires until {@link clear} removes it or the registry is disposed. A no-op once the registry is disposed or its lifetime signal has aborted.
   *
   * @param key      - The identity under which the timer is tracked; a later registration under the same key replaces this one.
   * @param callback - The function to run on every interval.
   * @param interval - The interval, in milliseconds.
   */
  public setInterval(key: string, callback: () => void, interval: number): void {

    if(this.#disposed || (this.#signal?.aborted ?? false)) {

      return;
    }

    this.clear(key);

    // The GLOBAL `setInterval`, for the same harness-visibility reason as the keyed one-shot. The entry is not removed on fire: an interval repeats until it is cleared
    // or drained.
    const handle = setInterval(callback, interval);

    this.#keyed.set(key, handle);
  }

  /**
   * Arm an anonymous one-shot: tracked for disposal, self-removing on fire, and never replacing anything. Concurrent anonymous timers coexist; this is the shape for
   * fire-and-forget work that has no identity to replace. A no-op once the registry is disposed or its lifetime signal has aborted.
   *
   * @param callback - The function to run once, after `delay`.
   * @param delay    - The delay, in milliseconds.
   */
  public schedule(callback: () => void, delay: number): void {

    if(this.#disposed || (this.#signal?.aborted ?? false)) {

      return;
    }

    // The GLOBAL `setTimeout`, for the same harness-visibility reason as the keyed timers. The handle self-removes before the callback runs, matching the keyed
    // one-shot's ordering; an anonymous timer has no key or handle to query, so that ordering carries no public observable and is stated here rather than pinned by test.
    const handle = setTimeout(() => {

      this.#anonymous.delete(handle);
      callback();
    }, delay);

    this.#anonymous.add(handle);
  }

  /**
   * Cancel and remove the keyed timer under `key`. Silently does nothing when no timer is armed under the key.
   *
   * @param key - The identity to clear.
   */
  public clear(key: string): void {

    const handle = this.#keyed.get(key);

    if(handle !== undefined) {

      // `clearTimeout` cancels both one-shots and intervals - Node holds them in a single pool - so one call clears whichever kind the key held.
      clearTimeout(handle);
      this.#keyed.delete(key);
    }
  }

  /**
   * Whether a keyed timer is currently armed under `key`.
   *
   * @param key - The identity to test.
   *
   * @returns `true` when a keyed timer is armed under `key`, otherwise `false`.
   */
  public has(key: string): boolean {

    return this.#keyed.has(key);
  }

  /**
   * Clear every pending timer, keyed and anonymous, and retire the registry: after disposal every registration method is a no-op, so a timer can never arm against a
   * torn-down owner. Disposal is a no-op on repeat.
   */
  public dispose(): void {

    if(this.#disposed) {

      return;
    }

    this.#disposed = true;

    for(const handle of this.#keyed.values()) {

      clearTimeout(handle);
    }

    this.#keyed.clear();

    for(const handle of this.#anonymous) {

      clearTimeout(handle);
    }

    this.#anonymous.clear();

    // Detach the abort listener so a long-lived composed signal retains no handler for a registry that has already been disposed.
    this.#abortRegistration?.[Symbol.dispose]();
  }

  /**
   * `Disposable` implementation, delegating to {@link dispose} so the registry composes with `using` declarations and disposer stacks.
   */
  public [Symbol.dispose](): void {

    this.dispose();
  }
}
