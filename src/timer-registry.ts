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
 * Every timer the registry arms goes through its {@link Clock}, so the whole surface is what the registry adds ON TOP of that one time source: keyed identity,
 * replace-on-register, anonymous tracking, and the lifetime drain. A consumer that injects a clock therefore drives these deadlines on the same timeline as its awaited
 * waits, rather than reaching for a second lever.
 *
 * @module
 */
import { NO_OP_DISPOSABLE, onAbort } from "./util.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

/**
 * Construction options for {@link TimerRegistry}.
 *
 * @category Utilities
 */
export interface TimerRegistryOptions {

  /**
   * The time source every timer this registry arms goes through. Defaults to {@link systemClock}, whose `schedule` IS the global `setTimeout` / `setInterval`, so the
   * default path is that same platform call with one indirection in front of it and no behavior change. A test injects a `TestClock` so the registry's deadlines share
   * the consumer's virtual timeline with its awaited delays, and one `advance` drives both.
   */
  clock?: Clock;

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
 *     coexist. It answers the same cancel-on-dispose handle {@link Clock.schedule} answers.
 *   - `clear(key)` cancels and removes a keyed timer; `has(key)` reports whether one is currently armed.
 *   - `clearAll()` drains every pending timer, keyed and anonymous alike, and leaves the registry armed: the shape for an owner whose pending work must all cancel on a
 *     state change while the re-arms that follow still need to take.
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

  // The time source every timer here is armed on, resolved once at construction. Every registration reads this one field, so the registry never touches a platform
  // timer directly and a consumer's injected clock reaches every deadline it owns.
  readonly #clock: Clock;

  // Keyed timers, one-shots and intervals alike: a key holds at most one live timer, so registering under a key replaces whatever it held.
  readonly #keyed = new Map<string, Disposable>();

  // Anonymous one-shots, tracked only so disposal can drain them: no key, no replacement, each self-removing when it fires.
  readonly #anonymous = new Set<Disposable>();

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

    this.#clock = options.clock ?? systemClock;
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

    // Arm through the registry's clock, as every registration here does, and hold the handle it answers with: that handle is the whole cancellation story, so the
    // containers below carry `Disposable`s rather than platform timer objects. Removing the entry before running the callback is what lets a fired one-shot read as
    // absent to the callback and to anything the callback triggers.
    const handle = this.#clock.schedule(() => {

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

    // The repeating arm of the same clock member. The entry is not removed on fire: an interval repeats until it is cleared or drained.
    const handle = this.#clock.schedule(callback, interval, { repeat: true });

    this.#keyed.set(key, handle);
  }

  /**
   * Arm an anonymous one-shot: tracked for disposal, self-removing on fire, and never replacing anything. Concurrent anonymous timers coexist; this is the shape for
   * fire-and-forget work that has no identity to replace. A no-op once the registry is disposed or its lifetime signal has aborted.
   *
   * The name, the shape, and the cancel-on-dispose meaning are deliberately {@link Clock.schedule}'s, because this IS that verb with lifetime tracking added: the
   * handle cancels the timer, and the registry additionally guarantees the timer cannot outlive the owner.
   *
   * @param callback - The function to run once, after `delay`.
   * @param delay    - The delay, in milliseconds.
   *
   * @returns A handle whose `[Symbol.dispose]` cancels the timer and stops tracking it. A registry that is disposed, or whose lifetime signal has aborted, arms nothing
   * and answers the shared {@link NO_OP_DISPOSABLE}, so a caller holds a handle either way and never branches on whether the registration took.
   */
  public schedule(callback: () => void, delay: number): Disposable {

    if(this.#disposed || (this.#signal?.aborted ?? false)) {

      return NO_OP_DISPOSABLE;
    }

    /* One object plays all three roles - the handle the caller holds, the membership the drain walks, and the entry the fire path removes - so those three can never
     * drift apart. Its disposer removes it from the tracking set AND cancels the underlying timer, which is why the caller's cancel and the registry's drain converge
     * on one code path.
     *
     * The timer's callback closes over `handle`, declared on the statement below it. That is safe by construction: the callback runs on a later turn of the event
     * loop, long after this method's statements have all run, so it can never observe the binding before it is initialized.
     */
    const timer = this.#clock.schedule(() => {

      this.#anonymous.delete(handle);
      callback();
    }, delay);

    const handle: Disposable = { [Symbol.dispose]: (): void => {

      this.#anonymous.delete(handle);
      timer[Symbol.dispose]();
    } };

    this.#anonymous.add(handle);

    return handle;
  }

  /**
   * Cancel and remove the keyed timer under `key`. Silently does nothing when no timer is armed under the key.
   *
   * @param key - The identity to clear.
   */
  public clear(key: string): void {

    const handle = this.#keyed.get(key);

    if(handle !== undefined) {

      handle[Symbol.dispose]();
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
   * Cancel and remove every pending timer, keyed and anonymous alike, while leaving the registry armed for later registrations. This is the drain without the
   * retirement: reach for it when an owner's pending work must all cancel on a state change but the owner itself lives on, so the re-arms that follow the change still
   * need to take. Safe to call in any state and a no-op on repeat - draining empty containers does nothing, and a call on an already-disposed registry neither throws
   * nor revives it.
   */
  public clearAll(): void {

    for(const handle of this.#keyed.values()) {

      handle[Symbol.dispose]();
    }

    this.#keyed.clear();

    // An anonymous handle's disposer removes itself from this set, so the walk empties the set as it goes - deleting the entry a Set iterator is standing on is
    // well-defined and skips nothing. The clear that follows states the drain's post-state rather than leaving it to be inferred from that self-removal.
    for(const handle of this.#anonymous) {

      handle[Symbol.dispose]();
    }

    this.#anonymous.clear();
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

    // The drain is the same act {@link clearAll} performs; retirement is the flag above, so the two lifetimes share one drain implementation.
    this.clearAll();

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
