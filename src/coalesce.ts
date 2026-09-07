/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * coalesce.ts: One asynchronous pass at a time, with a burst of triggers collapsing into a single follow-up.
 */

/**
 * One asynchronous pass at a time, with a burst of triggers collapsing into a single follow-up.
 *
 * A recurring shape in plugin work is an event source that fires far more often than the work it triggers needs to run: a controller announcing a configuration change
 * several times in a second, a reconnect path asking for a fresh look at the network while a look is already underway, a subscription delivering a burst of updates that
 * all resolve to the same refresh. Running the work once per trigger is wasteful, and wrong outright when the work is not safe to run against itself; dropping the extra
 * triggers is wrong too, because whatever arrived after the pass had already read its inputs is simply lost. The answer in every case is the same: run one pass, and if
 * anything asked while that pass was running, run exactly one more - however many asked.
 *
 * This is the run-on-demand corner of the library's dispatch mechanisms, and it is deliberately the only thing it is. The drain owns each pass's fault and reports it on
 * the task's own line, rather than handing the whole dispatch to a guard: a guard wrapping the drain ends it at the first fault, and the follow-up a trigger bought while
 * that pass was running is work somebody asked for and a fault says nothing about. `superviseLoop` owns the run-forever shape, where the work is a loop that should keep
 * going for as long as its lifetime lasts. This owns the run-on-demand shape, where the work has nothing to do until something asks, and asking twice must not mean
 * running twice.
 *
 * @module
 */
import { formatErrorMessage, markHandled } from "./util.ts";
import type { HomebridgePluginLogging } from "./util.ts";

/**
 * Construction options for {@link CoalescingTask}.
 *
 * @typeParam T - The verdict a pass answers and a requester reads back. Defaults to `void` for the fire-and-forget form, whose passes have nothing to answer.
 *
 * @category Utilities
 */
export interface CoalescingTaskOptions<T = void> {

  /**
   * What to call this task in the line a failed pass writes.
   */
  label: string;

  /**
   * Where a failed pass is reported.
   */
  log: HomebridgePluginLogging;

  /**
   * The pass itself. It is never invoked concurrently with itself.
   *
   * Whatever the pass answers is the verdict a requester reads back, so a pass with nothing to answer is typed `void`, which is the fire-and-forget form.
   */
  run: () => Promise<T>;

  /**
   * The task's lifetime. Once it is aborted no further pass is run, and a queued follow-up is abandoned.
   */
  signal: AbortSignal;
}

/**
 * A single-flight task: one pass runs at a time, and any number of triggers arriving during a pass buy exactly one more.
 *
 * Asking is the whole of the surface, in a spelling that discards the answer and a spelling that hands it back. {@link CoalescingTask.schedule} asks for a pass and
 * returns nothing: an idle task starts one now, a task already running takes note and runs once more when the pass in flight finishes. A burst of triggers arriving
 * during a pass therefore buys exactly one follow-up rather than one pass apiece, and a trigger arriving after everything has settled starts a fresh pass of its own.
 * {@link CoalescingTask.request} asks in precisely that way and returns the promise of the drain that answers - a fresh drain's when the task is idle, the drain in
 * flight's when a pass is running, and the same promise object for every asker of that drain - settling with the verdict of the last pass the drain runs, because a
 * request made mid-pass bought the follow-up so that the answer reflects inputs the running pass had already read past.
 *
 * The lifetime signal is honored at both ends. Once it aborts, a trigger starts nothing at all, and a follow-up that was queued before the abort is abandoned rather than
 * run into a lifetime that is over.
 *
 * A failed pass is reported on the task's own line whichever spelling asked for it. What a requester reads back beyond that is the drain's own end: a drain that ends
 * on a fault rejects its requesters with it, the last pass's once every follow-up a trigger bought has run, or the logger's own if it threw while reporting a pass. A
 * consumer that wants a verdict in every case therefore converts the fault inside its own pass, where the wording and the fallback are its business rather than this
 * class's. A request made after the lifetime has ended rejects with the signal's reason and runs nothing.
 *
 * @typeParam T - The verdict each pass answers, in the consumer's own vocabulary, and what {@link CoalescingTask.request} settles with. Defaults to `void` for a task
 * whose passes have nothing to answer, which is what every fire-and-forget consumer builds without naming the parameter.
 *
 * @example
 *
 * ```ts
 * import { CoalescingTask } from "homebridge-plugin-utils";
 *
 * // A refresh several event sources can ask for, none of which should ever run it against itself.
 * const refresh = new CoalescingTask({ label: "device refresh", log: this.log, run: () => this.refreshDevices(), signal: this.signal });
 *
 * // Every trigger is a bare call - the task decides whether that means starting a pass or buying the one follow-up.
 * this.client.on("configuration-changed", () => refresh.schedule());
 * this.client.on("reconnected", () => refresh.schedule());
 *
 * // The one asker that needs the answer awaits the drain that serves it, rather than asking and hoping.
 * const found = await refresh.request();
 * ```
 *
 * @category Utilities
 */
export class CoalescingTask<T = void> {

  readonly #label: string;
  readonly #log: HomebridgePluginLogging;
  readonly #run: () => Promise<T>;
  readonly #signal: AbortSignal;

  /* The whole of the single-flight state, as one value rather than as a running flag beside a queued flag.
   *
   * Two booleans can express "queued but not running", which is a state this discipline has no meaning for and every consumer would simply have to avoid producing. One
   * three-armed value cannot express it at all, so the combination is unrepresentable rather than merely avoided.
   *
   * The drain's settlement lives inside the running arms for that same reason: an idle task holding the settlement of a drain in flight is a combination with no
   * meaning, and carrying the promise on the arms that have a drain behind them makes it unrepresentable rather than something every path has to be careful not to
   * produce. Because the running kinds share one arm, the drain's own exit test reads `kind` directly after an await and stays well-typed, rather than reaching the
   * field through a call so that the compiler cannot carry the narrowing from the assignment before each pass across the await, which is precisely when the answer
   * changes.
   */
  #state: { kind: "idle" } | { kind: "running" | "running-queued"; settled: Promise<T> };

  /**
   * Build a coalescing task. Construction starts nothing; the first {@link CoalescingTask.schedule} does.
   *
   * @param options - See {@link CoalescingTaskOptions}.
   */
  public constructor(options: CoalescingTaskOptions<T>) {

    this.#label = options.label;
    this.#log = options.log;
    this.#run = options.run;
    this.#signal = options.signal;
    this.#state = { kind: "idle" };
  }

  /**
   * Ask for a pass. A pass already running takes note and runs once more when it finishes; an idle task starts one now.
   *
   * This is the fire-and-forget spelling: it discards the answer and marks the promise handled, because every caller here is an event handler or a timer with nothing
   * to wait for. A last pass that failed, a lifetime that has already ended, and a logger that throws while reporting a pass each reach that promise as a rejection,
   * and an unobserved rejection is the worst way for any of them to surface.
   */
  public schedule(): void {

    void markHandled(this.request());
  }

  /**
   * Ask for a pass and read back what it answers. A pass already running takes note and runs once more when it finishes; an idle task starts one now.
   *
   * The promise is the drain's settlement: a fresh drain's when the task is idle, and the drain in flight's when a pass is running, which is the identical promise
   * every other asker of that drain holds. It settles with the verdict of the last pass that drain runs, rejects with the fault the drain ends on, and rejects with the
   * signal's reason once the lifetime has ended, in which case no pass runs at all.
   *
   * @returns The verdict of the last pass run by the drain that serves this request.
   */
  public request(): Promise<T> {

    /* A task whose lifetime has ended runs nothing at all, however it is asked. The drain loop answers the same question between passes, and asking it here too is what
     * closes the one window that check cannot reach: the first pass of a task triggered after teardown, which would otherwise get all the way into its work before
     * anything thought to look.
     */
    if(this.#signal.aborted) {

      /* The refusal carries the lifetime's own reason, whatever value the consumer aborted with. It is assembled through resolvers so that reason crosses out exactly
       * as it was set, rather than through `Promise.reject`, which is held to an error-typed reason a lifetime's reason need not be.
       */
      const { promise, reject } = Promise.withResolvers<T>();

      reject(this.#signal.reason);

      return promise;
    }

    if(this.#state.kind !== "idle") {

      this.#state = { kind: "running-queued", settled: this.#state.settled };

      return this.#state.settled;
    }

    /* The settlement is built here and handed to the drain rather than read off the drain's own promise, because the drain installs it into the state as its first act,
     * synchronously, before the first pass runs: a pass that asks re-entrantly then joins the drain that is running it rather than starting a second one. Holding the
     * promise before the work it stands for has begun is exactly what `Promise.withResolvers` is for.
     */
    const { promise, reject, resolve } = Promise.withResolvers<T>();

    this.#drain(promise).then(resolve, reject);

    return promise;
  }

  // Run passes until nothing further has been asked for. The state is reset to "running" before each pass rather than after it, so a trigger arriving mid-pass is
  // recorded against the pass that follows rather than against the one it interrupted.
  async #drain(settled: Promise<T>): Promise<T> {

    try {

      for(;;) {

        this.#state = { kind: "running", settled };

        /* A fault is reported per pass and goes no further, because the follow-up a trigger bought while this pass was running was asked for on its own account and a
         * fault here says nothing about it. Reporting is the whole of what the catch does: it never re-arms a follow-up of its own, so a pass that fails every time
         * cannot turn the loop into a tight retry against a persistent fault - only a genuine trigger buys the next pass. What the drain settles on is the outcome of
         * its LAST pass, reached once every follow-up a trigger bought has run, so a requester never reads a verdict a later pass has already superseded.
         */
        let outcome: { fault: unknown; kind: "faulted" } | { kind: "answered"; verdict: T };

        try {

          // A sequence of passes is what this is, so awaiting inside the loop is the shape rather than an oversight.
          // eslint-disable-next-line no-await-in-loop
          outcome = { kind: "answered", verdict: await this.#run() };
        } catch(error) {

          this.#log.error("The %s pass failed: %s.", this.#label, formatErrorMessage(error));

          outcome = { fault: error, kind: "faulted" };
        }

        if((this.#state.kind !== "running-queued") || this.#signal.aborted) {

          if(outcome.kind === "faulted") {

            throw outcome.fault;
          }

          return outcome.verdict;
        }
      }
    } finally {

      this.#state = { kind: "idle" };
    }
  }
}
