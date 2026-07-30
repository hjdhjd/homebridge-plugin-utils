/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rate-budget.ts: A sliding-window rate budget - at most N grants inside any trailing window - that callers await before spending a rate-limited call.
 */

/**
 * A sliding-window rate budget: at most `capacity` grants inside any trailing `window` milliseconds.
 *
 * The ceilings a budget like this serves are stated as "at most N calls in any W milliseconds", so the enforcement here is exact rather than approximate. The budget
 * keeps a timestamp log of the grants it has issued and admits a caller only while fewer than `capacity` of those timestamps still fall inside the trailing window. A
 * token bucket that refills at N/W is the usual shortcut and is the wrong shape for a stated ceiling: a bucket that has sat idle refills to full and then admits a
 * burst of N grants on top of earlier ones that are still inside the window, so the ceiling is transiently exceeded even though the long-run average is honored. The
 * timestamp log cannot produce that transient... every grant stays accounted for until the full window has elapsed since it was issued.
 *
 * The price of exactness is one number per in-window grant - bounded by `capacity`, never by the call rate - plus one prefix prune per admission decision, which is a
 * small, fixed cost for a mechanism whose whole purpose is to be correct at the boundary.
 *
 * @module
 */
import { composeSignals, waitWithSignal } from "./util.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

/**
 * Construction options for {@link RateBudget}.
 *
 * @category Utilities
 */
export interface RateBudgetOptions {

  /**
   * The maximum number of grants permitted inside any trailing `window`. Must be a positive integer.
   */
  capacity: number;

  /**
   * The time source the budget reads and waits against. Defaults to {@link systemClock}; a test injects a `TestClock` to drive the pacing path in virtual time.
   */
  clock?: Clock;

  /**
   * A lifetime signal. When it aborts, every pending and every subsequent {@link RateBudget.acquire} rejects with its reason. Omit it for a budget with no lifetime
   * bound. The signal is only ever read and composed into each caller's own wait - the budget attaches no listener to it (see the class documentation).
   */
  signal?: AbortSignal;

  /**
   * The trailing window, in milliseconds, that a grant occupies a slot for. Must be a positive, finite number.
   */
  window: number;
}

/**
 * A sliding-window rate budget: at most `capacity` grants inside any trailing `window` milliseconds, awaited by callers before they spend a rate-limited call.
 *
 * Callers queue in first-in-first-out order. {@link RateBudget.acquire} resolves as soon as the log has room and otherwise waits exactly until the oldest grant leaves
 * the window, so a saturated budget paces callers at the contract's own rate rather than sleeping a fixed interval and hoping.
 *
 * Cancellation is per-waiter and needs no teardown. A lifetime signal is STORED and never listened to: each `acquire` composes the lifetime signal with its own
 * optional per-call signal and rejects directly off that composition, so an abandoned budget leaves nothing attached to a long-lived signal and there is nothing to
 * dispose. That is the deliberate contrast with `TimerRegistry`, which holds real platform timers and therefore must implement `Disposable` and drain them: this class
 * holds only bookkeeping - an array of numbers and a promise chain - which the garbage collector reclaims on its own.
 *
 * @example
 *
 * ```ts
 * import { RateBudget } from "homebridge-plugin-utils";
 *
 * // A published ceiling of at most 30 calls in any trailing five minutes, bounded by the plugin's lifetime.
 * const budget = new RateBudget({ capacity: 30, signal: this.signal, window: 300000 });
 *
 * // Each caller waits its turn, then spends its grant. A caller that gives up passes its own signal and consumes no slot.
 * await budget.acquire({ signal: requestSignal });
 *
 * const response = await fetch(endpoint, { signal: requestSignal });
 * ```
 *
 * @category Utilities
 */
export class RateBudget {

  // The ceiling: the most grants that may sit inside the trailing window at once.
  readonly #capacity: number;

  // The injected time source. Every `now()` read and every wait in this class goes through it, so a test drives the whole pacing path in virtual time.
  readonly #clock: Clock;

  // The timestamp log: one entry per grant still inside the window, in nondecreasing time order because entries are appended at the moment they are issued. This is the
  // entire state the enforcement rests on - the admission decision and the `available` view both read it through `#liveGrants`.
  readonly #grants: number[] = [];

  // The lifetime signal, when one was supplied. It is read, never listened to.
  readonly #signal: AbortSignal | undefined;

  // The tail of the first-in-first-out turn chain: a promise that ALWAYS fulfills, whatever its turn did. Each `acquire` chains its turn onto this promise and then
  // replaces it with a link that settles when its own turn settles, so waiters run one at a time in arrival order and a rejected turn advances the queue rather than
  // poisoning it.
  #turn: Promise<void> = Promise.resolve();

  // The trailing window, in milliseconds.
  readonly #window: number;

  /**
   * Construct a budget. Construction schedules nothing and starts no work; the first {@link RateBudget.acquire} does.
   *
   * @param options - See {@link RateBudgetOptions}.
   *
   * @throws `TypeError` if `capacity` is not a positive integer, or if `window` is not a positive, finite number.
   */
  public constructor(options: RateBudgetOptions) {

    const { capacity, clock = systemClock, signal, window } = options;

    // Reject nonsensical ceilings loudly at the boundary. A fractional or non-positive capacity, or a non-finite window, describes no enforceable contract at all, and
    // a budget that silently accepted one would pace callers by a rule nobody stated.
    if(!Number.isInteger(capacity) || (capacity < 1)) {

      throw new TypeError("RateBudget: `capacity` must be a positive integer.");
    }

    if(!Number.isFinite(window) || (window <= 0)) {

      throw new TypeError("RateBudget: `window` must be a positive, finite number of milliseconds.");
    }

    this.#capacity = capacity;
    this.#clock = clock;
    this.#signal = signal;
    this.#window = window;
  }

  /**
   * The number of grants that could be issued right now: `capacity` minus the grants still inside the trailing window, evaluated against the current time.
   *
   * Reading this prunes the log of grants that have aged out, exactly as an admission decision does - both views run through the same helper, so what a caller can
   * observe here and what the next `acquire` will decide can never disagree.
   *
   * @returns The number of free slots, from `0` to `capacity`.
   */
  public get available(): number {

    return this.#capacity - this.#liveGrants(this.#clock.now());
  }

  /**
   * The ceiling this budget was constructed with: the most grants permitted inside any trailing window.
   *
   * @returns The configured capacity.
   */
  public get capacity(): number {

    return this.#capacity;
  }

  /**
   * Wait for a grant, then return. This is the budget's one operation: callers await it immediately before spending the rate-limited call it paces, and it resolves as
   * soon as the trailing window has room for them.
   *
   * Callers are served first-in-first-out. A caller that is already queued behind others can still give up promptly - the returned promise races its turn against the
   * composed signal, so an abort rejects it at once rather than after its predecessors finish waiting. An aborted waiter consumes no slot and records nothing, whether
   * it aborted before its turn started, while it waited out the window, or before it ever joined the queue.
   *
   * @param init        - Optional per-call options.
   * @param init.signal - A per-call abort signal. Aborting it rejects THIS acquire with the signal's reason and leaves every other waiter untouched.
   *
   * @returns A promise that resolves when the grant has been recorded.
   *
   * @throws The lifetime signal's reason if the budget's lifetime signal aborts, or the per-call signal's reason if `init.signal` aborts. When both have aborted, the
   *         lifetime reason wins - it is the more fundamental of the two.
   *
   * @example
   *
   * ```ts
   * // Pace a rate-limited call, giving up promptly if the caller's own request is cancelled.
   * await budget.acquire({ signal: requestSignal });
   *
   * return fetch(endpoint, { signal: requestSignal });
   * ```
   */
  public async acquire(init?: { signal?: AbortSignal }): Promise<void> {

    const callSignal = init?.signal;

    // Check for an abort BEFORE this caller joins the queue, so a pre-aborted acquire rejects immediately and never takes a place in line - even against a busy queue
    // it would otherwise have to wait out. This mirrors `retry`, which honors a pre-aborted signal before spawning its first attempt.
    this.#throwIfAborted(callSignal);

    const composed = this.#compose(callSignal);

    // Join the queue by chaining onto the predecessor's SETTLEMENT rather than its success. `#turn` always fulfills, so a waiter that rejects hands the queue forward
    // intact: its rejection reaches its own caller alone and can neither stall nor poison the waiters behind it.
    const turn = this.#turn.then(() => this.#runTurn(callSignal, composed));

    this.#turn = turn.then(() => undefined, () => undefined);

    // With no signal anywhere there is nothing to race against, so the caller simply awaits its turn.
    if(composed === undefined) {

      return turn;
    }

    // Race the turn against the composed signal so a still-queued caller can give up without waiting out its predecessors. `waitWithSignal` attaches its abort listener
    // with `{ once: true }` and detaches it on settle, and it observes `turn` on both arms, so the race leaks neither a listener nor an unhandled rejection.
    return waitWithSignal(turn, composed);
  }

  // Compose the signals that are actually defined into the one signal this call cancels against, or `undefined` when neither exists. Both signals are optional and
  // `composeSignals` throws when every input is undefined - a budget with no lifetime signal serving a caller with no per-call signal is a legitimate configuration
  // whose waits simply cannot be cancelled, so that case is answered here rather than by calling into a helper that would reject it. A single defined signal
  // short-circuits to that signal itself, preserving reference identity; two compose into a signal carrying the first aborting input's reason.
  #compose(callSignal: AbortSignal | undefined): AbortSignal | undefined {

    const signals = [ this.#signal, callSignal ].filter((signal) => signal !== undefined);

    return (signals.length > 0) ? composeSignals(...signals) : undefined;
  }

  // Prune every grant that has aged out of the trailing window and return how many remain. A grant recorded at T leaves the window when `now >= T + window`, which is
  // exactly the `timestamp <= now - window` test below. Because grants are appended in nondecreasing time order, the expired entries are always a prefix of the log, so
  // one `findIndex` locates the boundary and one `splice` drops them all. Both the admission decision and the `available` getter consult this single helper, so the two
  // views of the budget cannot drift apart.
  #liveGrants(now: number): number {

    const cutoff = now - this.#window;
    const firstLive = this.#grants.findIndex((timestamp) => timestamp > cutoff);

    // A `findIndex` of -1 means no grant survives the cutoff, so the whole log goes; otherwise the index IS the count of expired entries at the front. A boundary of 0
    // splices nothing.
    this.#grants.splice(0, (firstLive === -1) ? this.#grants.length : firstLive);

    return this.#grants.length;
  }

  // Run one waiter's turn: wait until the trailing window has room, then record the grant. Turns are serialized by the queue, so this is the only place a grant is ever
  // appended and the admission decision never races another waiter.
  async #runTurn(callSignal: AbortSignal | undefined, composed: AbortSignal | undefined): Promise<void> {

    for(;;) {

      // The abort check for both the entry into a turn and the wake from a wait, since a wake re-enters here. A waiter whose signal aborted while it sat in the queue
      // is skipped rather than granted: throwing here records nothing and consumes no slot, and the rejection settles this turn's link so the waiters behind it
      // advance immediately.
      this.#throwIfAborted(callSignal);

      const now = this.#clock.now();
      const live = this.#liveGrants(now);
      const oldest = this.#grants[0];

      // Admission compares the live count STRICTLY against capacity, so the capacity-th concurrent grant is admitted and the next one is not. The second arm is the
      // compiler's narrowing for the peek: `noUncheckedIndexedAccess` widens the indexed read above to `number | undefined`, and an empty log is a log with room, so
      // the two arms agree and the runtime semantics are the admission test alone. Same length-guarded peek shape as `backpressure.ts`.
      if((live < this.#capacity) || (oldest === undefined)) {

        this.#grants.push(now);

        return;
      }

      // How long the oldest grant still holds its slot. `#liveGrants` has just dropped every timestamp satisfying `timestamp <= now - window`, which leaves
      // `oldest > now - window` and therefore makes this difference strictly positive - a zero-delay spin is unrepresentable rather than merely unlikely.
      const wait = oldest + this.#window - now;

      try {

        // A budget with no signal anywhere has nothing to cancel against, so its wait runs bare.
        // eslint-disable-next-line no-await-in-loop
        await this.#clock.delay(wait, (composed === undefined) ? undefined : { signal: composed });
      } catch(error) {

        // `Clock.delay` rejects with the platform `AbortError` rather than the signal's reason, so this is where the responsible signal's reason is restored. When
        // neither signal is aborted the checks are no-ops and a genuine failure propagates unchanged - the same single-normalizer shape `retry` uses.
        this.#throwIfAborted(callSignal);

        throw error;
      }
    }
  }

  // The one place cancellation is decided, consulted at every point where an abort can be observed: the entry check before queueing, the wake at the top of a turn's
  // loop, and the catch around the wait. The two signals are consulted lifetime-first, so a caller whose budget was torn down while its own signal also aborted sees
  // the lifetime reason - the more fundamental of the two - rather than whichever happened to fire first.
  #throwIfAborted(callSignal: AbortSignal | undefined): void {

    this.#signal?.throwIfAborted();
    callSignal?.throwIfAborted();
  }
}
