/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * delivery-supervisor.ts: Windows of named slots that each settle exactly once, under one deadline armed on the injected clock.
 */

/**
 * Windows of named slots that each settle exactly once, under one deadline armed on the injected clock.
 *
 * A plugin that sends a command and then waits for the world to agree it happened carries the same lifecycle every time: open a window when the command goes out,
 * arm one deadline for it, answer each thing the window is waiting on as the evidence arrives, and make sure every waiting consumer is answered exactly once
 * however the window ends. Getting that bookkeeping wrong is silent in both directions - a slot answered twice corrupts whatever the consumer wrote back on the
 * first answer, and a slot never answered leaves a caller waiting for something that can no longer come.
 *
 * The supervisor owns that bookkeeping and deliberately nothing else. A consumer opens a window under a key of its own, names the slots it will be answering, and
 * hands over a deadline callback; from there it settles slots with its own outcome type as its own evidence arrives. Everything domain-shaped stays the consumer's:
 * what counts as evidence, what a deadline should do about it, how many rounds are worth spending, and which words a settled slot is answered with. The reasons the
 * supervisor closes a slot on its own initiative travel as a {@link DeliveryYield} it owns, so neither vocabulary ever has to be reconciled against the other.
 *
 * One answer per slot is structural rather than careful: a slot carries the flag that records it has been claimed, one chokepoint on its window is the only place
 * that flag flips, and every path into a settlement - a consumer's `settle`, a fault sweep, an invalidation, the abort sweep - goes through it.
 *
 * This is the run-once-per-window corner of the library's dispatch mechanisms, beside `CoalescingTask`'s run-on-demand shape and `superviseLoop`'s run-forever one.
 *
 * @module
 */
import type { Clock } from "./clock.ts";
import { TimerRegistry } from "./timer-registry.ts";
import { onAbort } from "./util.ts";

/**
 * Why the supervisor closed a slot itself, rather than the consumer settling it with an outcome of its own.
 *
 * These are the whole set of closures the supervisor initiates: `"aborted"` when the lifetime signal ends, `"faulted"` when a window's deadline callback threw,
 * `"invalidated"` when the consumer called {@link DeliverySupervisor.invalidate} or disposed the supervisor, and `"superseded"` when a newer window opened under the
 * same key. Every other way a slot can be answered is the consumer's own vocabulary, carried as the slot's `T`.
 *
 * @category Utilities
 */
export type DeliveryYield = "aborted" | "faulted" | "invalidated" | "superseded";

/**
 * What a slot's settlement callback receives, exactly once: either the consumer's own outcome or the reason the supervisor closed the slot.
 *
 * @typeParam T - The consumer's outcome type, whatever a settled slot means in its domain.
 *
 * @category Utilities
 */
export type DeliverySettlement<T> = { readonly kind: "settled"; readonly outcome: T } | { readonly kind: "yielded"; readonly reason: DeliveryYield };

/**
 * One thing a window is waiting to learn, and the handle a consumer answers it through.
 *
 * @typeParam T - The consumer's outcome type.
 *
 * @category Utilities
 */
export interface DeliverySlot<T> {

  /**
   * Whether this slot has been answered, by any path at all. A settled slot is finished for good: no later call changes what it was answered with.
   */
  readonly settled: boolean;

  /**
   * Answer this slot with the consumer's own outcome.
   *
   * The rest tuple is what lets a consumer with no outcome to give - a `T` of `void`, which is the supervisor's own default - write `slot.settle()`, while any other
   * `T` requires exactly its one argument. The emptiness test is spelled against `Exclude` and a one-element tuple rather than as a bare `T extends void`, so that it
   * answers on the whole of `T` instead of distributing across a union and handing a union-typed slot two different argument lists.
   *
   * @param outcome - The outcome this slot is settled with, for every `T` other than `void`.
   *
   * @returns `true` when this call settled the slot, `false` when it was already settled. A stale caller therefore learns that nothing happened rather than being
   * told a second answer landed.
   */
  settle(...outcome: [Exclude<T, void>] extends [never] ? [] : [outcome: T]): boolean;
}

/**
 * One open window: the slots it is waiting on, and the deadline it is waiting under.
 *
 * @typeParam T - The consumer's outcome type.
 *
 * @category Utilities
 */
export interface DeliveryWindow<T> {

  /**
   * The consumer's own key for this window - the one {@link DeliverySupervisor.open}, {@link DeliverySupervisor.has}, {@link DeliverySupervisor.get}, and
   * {@link DeliverySupervisor.invalidate} all speak. The key the deadline is armed under is the supervisor's own and is never shown here.
   */
  readonly key: string;

  /**
   * How many of this window's slots are still unsettled.
   */
  readonly pending: number;

  /**
   * Whether every slot has settled, which is `pending` reading zero.
   */
  readonly settled: boolean;

  /**
   * This window's slots, by the names the window was opened with.
   */
  readonly slots: ReadonlyMap<string, DeliverySlot<T>>;

  /**
   * Give a pending window one more round: re-arm its deadline for another `delay` milliseconds. The re-arm replaces the window's own standing deadline rather than
   * adding a second one, so a window is never waiting under two clocks at once. A no-op on a settled window, which has nothing left to decide.
   *
   * @param delay - The new window, in milliseconds.
   */
  rearm(delay: number): void;
}

/**
 * What opening a window takes.
 *
 * @typeParam T - The consumer's outcome type.
 *
 * @category Utilities
 */
export interface OpenDeliveryWindowOptions<T> {

  /**
   * How long the window runs before its deadline callback is called, in milliseconds on the supervisor's clock.
   */
  readonly deadline: number;

  /**
   * What to do when the deadline lapses with slots still pending. It runs inside the supervisor's own catch, so a throw from anywhere it reaches answers every
   * pending slot rather than orphaning them, and it receives the window so it can read what is still outstanding, settle slots itself, or buy another round with
   * {@link DeliveryWindow.rearm}.
   */
  readonly onDeadline: (window: DeliveryWindow<T>) => Promise<void> | void;

  /**
   * Called once per slot for every settlement, whether the consumer settled the slot or the supervisor closed it.
   */
  readonly onSettle?: (slot: string, settlement: DeliverySettlement<T>) => void;

  /**
   * The names of the slots this window is waiting on. Every name must be distinct and the list must not be empty.
   */
  readonly slots: readonly string[];
}

/**
 * Construction options for {@link DeliverySupervisor}.
 *
 * @category Utilities
 */
export interface DeliverySupervisorOptions {

  /**
   * The time source every deadline is armed on. It is handed through unresolved to the {@link TimerRegistry} that arms the timer, which is the one place the default
   * is applied, so a consumer that injects a clock drives its supervised deadlines on the same timeline as its awaited waits.
   */
  readonly clock?: Clock;

  /**
   * Where the error a deadline callback threw is reported, after every pending slot of that window has already been answered. It carries the consumer's entire fault
   * policy - the logging, the wording, the recovery - which is why the supervisor itself stays logging-free.
   */
  readonly onError: (error: unknown) => void;

  /**
   * The supervisor's lifetime. When it aborts, every pending slot of every standing window is yielded `"aborted"` before the deadlines are retired, and opening a
   * further window throws.
   */
  readonly signal: AbortSignal;
}

/* What a window needs from the supervisor that owns it, as the verbs and values it actually uses rather than as a reference to the supervisor itself.
 *
 * Handing the window closures instead of its owner is what keeps the supervisor's public surface free of the internals a window would otherwise have to reach
 * through: `arm` and `disarm` speak to the supervisor's registry under a key the consumer never sees, and `retire` drops the window from the standing map.
 */
interface SupervisedWindowOptions<T> {

  readonly arm: (delay: number) => void;
  readonly disarm: () => void;
  readonly key: string;
  readonly onSettle: ((slot: string, settlement: DeliverySettlement<T>) => void) | undefined;
  readonly retire: () => void;
  readonly slots: readonly string[];
}

/* One slot of one window, carrying the flag that records whether it has been answered.
 *
 * The flag lives here rather than on the window because the flag and the act of taking it belong together: `claim()` is the only place it flips and it answers
 * whether THIS call was the one that took the slot, so the window above reads that answer rather than testing a flag it does not own.
 */
class SupervisedSlot<T> implements DeliverySlot<T> {

  #settled = false;

  readonly #route: (settlement: DeliverySettlement<T>) => boolean;

  public constructor(route: (settlement: DeliverySettlement<T>) => boolean) {

    this.#route = route;
  }

  public get settled(): boolean {

    return this.#settled;
  }

  public settle(...outcome: [Exclude<T, void>] extends [never] ? [] : [outcome: T]): boolean {

    /* The rest tuple is a conditional type the compiler cannot resolve while `T` is still generic, so the single read of its element is asserted here rather than at
     * every call site. Both arms are answered correctly: a `void` slot is called with no argument at all and `undefined` is the only value `void` has, while any
     * other `T` is called with exactly the one argument the tuple names.
     */
    const [value] = outcome as unknown as [value: T];

    return this.#route({ kind: "settled", outcome: value });
  }

  // Take this slot's one settlement, answering whether this call was the one that took it. Every path that settles a slot reaches the flag through here, which is
  // what makes "exactly one answer" a property of the shape rather than a rule each path has to remember.
  public claim(): boolean {

    if(this.#settled) {

      return false;
    }

    this.#settled = true;

    return true;
  }
}

/* One open window: its slots, the count of what is still outstanding, and the one chokepoint every settlement of every one of those slots goes through.
 *
 * The count is what decides when the window is finished, and it only ever moves in one direction. Reaching zero is terminal for the window: the deadline is
 * disarmed and the window stops standing under its key, so nothing arriving afterwards can reopen it.
 */
class SupervisedWindow<T> implements DeliveryWindow<T> {

  readonly #arm: (delay: number) => void;
  readonly #disarm: () => void;
  readonly #onSettle: ((slot: string, settlement: DeliverySettlement<T>) => void) | undefined;
  readonly #retire: () => void;
  readonly #slots = new Map<string, SupervisedSlot<T>>();

  #pending: number;

  public readonly key: string;

  public constructor(options: SupervisedWindowOptions<T>) {

    this.#arm = options.arm;
    this.#disarm = options.disarm;
    this.#onSettle = options.onSettle;
    this.#retire = options.retire;
    this.#pending = options.slots.length;
    this.key = options.key;

    // Each slot is handed the one route back into this window's chokepoint, with its own name already closed over, so a slot holds no way to settle anything but
    // itself and a consumer's handle carries no name it could get wrong.
    for(const name of options.slots) {

      this.#slots.set(name, new SupervisedSlot<T>((settlement: DeliverySettlement<T>): boolean => this.#settle(name, settlement)));
    }
  }

  public get pending(): number {

    return this.#pending;
  }

  public get settled(): boolean {

    return this.#pending === 0;
  }

  public get slots(): ReadonlyMap<string, DeliverySlot<T>> {

    return this.#slots;
  }

  public rearm(delay: number): void {

    // A settled window has no round left to give: its deadline was disarmed when its last slot answered, and re-arming here would run a callback against a window
    // that is already finished.
    if(this.settled) {

      return;
    }

    this.#arm(delay);
  }

  // Answer every slot of this window that is still pending with the reason the supervisor closed it. Slots that already settled keep the answer they were given.
  public yieldPending(reason: DeliveryYield): void {

    for(const name of this.#slots.keys()) {

      this.#settle(name, { kind: "yielded", reason });
    }
  }

  /* The one place a slot of this window settles, whatever asked for it.
   *
   * The claim is what makes the single answer structural: a slot reached by more than one path at once - evidence landing while a deadline sequence is mid-await, an
   * invalidation sweeping through while a consumer is settling - answers the first and tells every later caller that nothing happened.
   */
  #settle(name: string, settlement: DeliverySettlement<T>): boolean {

    const slot = this.#slots.get(name);

    // A name this window never opened, and a slot whose one settlement some earlier path already took, are the same answer to the caller: nothing happened here.
    if(!slot?.claim()) {

      return false;
    }

    this.#pending--;

    this.#onSettle?.(name, settlement);

    /* The window is finished the moment its last slot answers, so its deadline is disarmed rather than left to fire against a window with nothing to decide, and it
     * stops standing under its key.
     *
     * Both acts run after the callback rather than before it, which is what lets a consumer open a fresh window for the same key from inside that callback: the
     * retirement below drops the map entry only while it still holds THIS window, so the newer one is never deleted out from under the consumer that just opened it.
     */
    if(this.#pending === 0) {

      this.#disarm();
      this.#retire();
    }

    return true;
  }
}

/**
 * A supervisor of delivery windows: each window is a set of named slots that settle exactly once, under one deadline armed on the injected clock.
 *
 * A consumer opens a window under a key of its own choosing, names the slots the window is waiting on, and says how long to wait and what to do when that wait
 * lapses. From there it answers slots as its own evidence arrives, and the supervisor guarantees the rest: exactly one settlement per slot, one deadline per window
 * cleared the moment the last slot answers, a fresh window under a standing key yielding the old one, and every pending slot answered when the lifetime ends, when
 * the consumer invalidates, or when a deadline callback throws.
 *
 * What the supervisor does NOT own is as deliberate as what it does. It has no notion of evidence, no re-send policy, no opinion about how many rounds a delivery is
 * worth, and no vocabulary for a successful outcome - every one of those is the consumer's, reached through the deadline callback and the slot handles. That division
 * is what lets consumers with completely different domain logic share one piece of lifecycle bookkeeping.
 *
 * The supervisor owns its own {@link TimerRegistry} rather than taking one, and registers its terminal sweep before constructing it. That ordering is the guarantee
 * that an aborted lifetime answers every waiting consumer before the deadlines are drained, and owning the registry is what keeps that ordering from having to be
 * re-derived by every consumer.
 *
 * @typeParam T - The outcome a settled slot carries, in the consumer's own vocabulary. Defaults to `void` for a consumer that has no outcome to give, whose slots
 * are then settled with a bare `slot.settle()`.
 *
 * @example
 *
 * ```ts
 * import { DeliverySupervisor } from "homebridge-plugin-utils";
 *
 * // One window per command, one slot per thing the command asked for, and the plugin's own words on every settled slot.
 * const deliveries = new DeliverySupervisor<"confirmed" | "unconfirmed">({ onError: (error) => this.report(error), signal: this.signal });
 *
 * const window = deliveries.open("shade." + id.toString(), {
 *
 *   deadline: 4000,
 *   onDeadline: (open) => this.reissue(open),
 *   onSettle: (slot, settlement) => this.answer(id, slot, settlement),
 *   slots: [ "primary", "tilt" ]
 * });
 *
 * // Evidence from the wire answers the slot it speaks to, and the deadline never speaks for a slot that has already been answered.
 * window.slots.get("primary")?.settle("confirmed");
 * ```
 *
 * @category Utilities
 */
export class DeliverySupervisor<T = void> implements Disposable {

  readonly #abortRegistration: Disposable;
  readonly #onError: (error: unknown) => void;
  readonly #registry: TimerRegistry;
  readonly #signal: AbortSignal;
  readonly #windows = new Map<string, SupervisedWindow<T>>();

  // The counter behind every registry key this supervisor hands out. The key is opaque and deliberately unrelated to the consumer's key, because an older and a newer
  // window both stand under one consumer key across a supersession, and a shared registry key would let the older one's disarm cancel the newer one's deadline.
  #sequence = 0;

  /**
   * Construct a supervisor. Construction opens no windows and arms no timers.
   *
   * @param options - See {@link DeliverySupervisorOptions}.
   */
  public constructor(options: DeliverySupervisorOptions) {

    this.#onError = options.onError;
    this.#signal = options.signal;

    /* The terminal sweep is registered BEFORE the registry, so an aborted lifetime answers every waiting consumer first and retires the deadlines afterwards. Abort
     * listeners run in registration order and the registry wires its own inside its constructor, so this ordering is what that sequence rests on.
     */
    this.#abortRegistration = onAbort(this.#signal, () => this.#yieldAll("aborted"));

    this.#registry = new TimerRegistry({ clock: options.clock, signal: options.signal });
  }

  /**
   * Open a window under `key`, arming its deadline and answering the handle a consumer settles its slots through. A window already standing under `key` has every
   * pending slot of its own yielded `"superseded"`, and its handles stay valid and inert afterwards.
   *
   * @param key     - The consumer's key for this window.
   * @param options - See {@link OpenDeliveryWindowOptions}.
   *
   * @returns The window, whose slots are the ones `options.slots` named.
   *
   * @throws The lifetime signal's reason when the supervisor's lifetime has already ended - a verb on a dead resource, so a consumer that owes its own callers an
   * answer says so in its own vocabulary before calling.
   * @throws `TypeError` when `options.slots` is empty or names the same slot twice.
   */
  public open(key: string, options: OpenDeliveryWindowOptions<T>): DeliveryWindow<T> {

    if(this.#signal.aborted) {

      throw this.#signal.reason;
    }

    // A window with nothing to settle, or one whose slots cannot be told apart by name, is a caller defect rather than a state to degrade into gracefully.
    if(!options.slots.length) {

      throw new TypeError("A delivery window must name at least one slot.");
    }

    if(new Set(options.slots).size !== options.slots.length) {

      throw new TypeError("A delivery window's slot names must each be unique.");
    }

    const registryKey = "deadline." + (++this.#sequence).toString();
    const arm = (delay: number): void => this.#registry.setTimeout(registryKey, () => void this.#runDeadline(options, window), delay);
    const superseded = this.#windows.get(key);
    const window: SupervisedWindow<T> = new SupervisedWindow<T>({

      arm,
      disarm: (): void => this.#registry.clear(registryKey),
      key,
      onSettle: options.onSettle,

      retire: (): void => {

        if(this.#windows.get(key) === window) {

          this.#windows.delete(key);
        }
      },

      slots: options.slots
    });

    /* The new window is filed and armed before the old one is yielded, and that order is what makes a reentrant `open` under the same key safe. A consumer whose
     * settlement callback opens a fresh window for this key runs inside the yield below, by which point this window is already standing...so the reentrant call
     * supersedes it in turn and nothing is ever filed and then silently overwritten.
     */
    this.#windows.set(key, window);
    arm(options.deadline);

    superseded?.yieldPending("superseded");

    return window;
  }

  /**
   * Yield every pending slot of the named windows, or of every standing window when no keys are named, with the reason `"invalidated"`.
   *
   * @param keys - The consumer keys to invalidate. Omit to invalidate every standing window.
   */
  public invalidate(keys?: readonly string[]): void {

    if(keys === undefined) {

      this.#yieldAll("invalidated");

      return;
    }

    for(const key of keys) {

      this.#windows.get(key)?.yieldPending("invalidated");
    }
  }

  /**
   * The windows currently standing, so a consumer can run the membership sweeps its own domain defines - closing every window that shares a member with a newer
   * one, or that a fresher command has overtaken. The supervisor owns same-key supersession and named-or-wholesale invalidation and nothing beyond them, because
   * anything further requires knowing what a window's slots mean.
   *
   * @returns An iterator over the standing windows.
   */
  public windows(): IterableIterator<DeliveryWindow<T>> {

    return this.#windows.values();
  }

  /**
   * Whether a window is currently standing under `key`.
   *
   * @param key - The consumer key to test.
   *
   * @returns `true` when a window stands under `key`, otherwise `false`.
   */
  public has(key: string): boolean {

    return this.#windows.has(key);
  }

  /**
   * The window currently standing under `key`.
   *
   * @param key - The consumer key to read.
   *
   * @returns The standing window, or `undefined` when none stands under `key`.
   */
  public get(key: string): DeliveryWindow<T> | undefined {

    return this.#windows.get(key);
  }

  /**
   * End the supervisor without ending its lifetime signal: every pending slot of every standing window is yielded `"invalidated"`, the registry is retired so no
   * deadline can outlive this call, and the abort listener is detached from the lifetime signal. A second disposal has nothing left to answer, a registry already
   * retired, and a listener already detached, so it does nothing.
   */
  public [Symbol.dispose](): void {

    this.#yieldAll("invalidated");
    this.#registry.dispose();

    // Detach the abort listener so a long-lived signal retains no handler for a supervisor that has already been disposed.
    this.#abortRegistration[Symbol.dispose]();
  }

  /* One window's deadline, run inside the catch that is the whole reason this sits here rather than in the consumer's own callback.
   *
   * A throw escaping a timer callback has nowhere to go and would leave every slot of the window waiting for an answer that can never come, so the last resort is to
   * answer them all. An aborted lifetime is the one exception: a throw that lands after the lifetime ended is the callback unwinding through a teardown this side
   * initiated, its slots were already yielded `"aborted"` by the sweep, and reporting it would name the consumer's own shutdown as a fault.
   *
   * There is no guard for an already-settled window at the top, and none is needed: every settlement disarms the deadline synchronously, and neither the platform
   * timers nor `TestClock` fire a cancelled one, so this runs only for a window that still had slots pending when its deadline came due.
   */
  async #runDeadline(options: OpenDeliveryWindowOptions<T>, window: SupervisedWindow<T>): Promise<void> {

    try {

      await options.onDeadline(window);
    } catch(error: unknown) {

      if(this.#signal.aborted) {

        return;
      }

      window.yieldPending("faulted");
      this.#onError(error);
    }
  }

  /* Yield every pending slot of every standing window.
   *
   * The walk reads a snapshot rather than the live map, because settling a window's last slot retires that window from the map and a consumer's settlement callback
   * can open a fresh one while the sweep is still running. The snapshot answers exactly the windows that were standing when the sweep began.
   */
  #yieldAll(reason: DeliveryYield): void {

    for(const window of [...this.#windows.values()]) {

      window.yieldPending(reason);
    }
  }
}
