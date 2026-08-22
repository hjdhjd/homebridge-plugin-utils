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
 * This is the run-on-demand corner of the library's dispatch mechanisms, and it is deliberately the only thing it is. `guardedDispatch` owns the fire-and-forget failure
 * surface, and this class dispatches through it rather than restating it, so a failed pass lands in the log instead of escaping as an unhandled rejection.
 * `superviseLoop` owns the run-forever shape, where the work is a loop that should keep going for as long as its lifetime lasts. This owns the run-on-demand shape, where
 * the work has nothing to do until something asks, and asking twice must not mean running twice.
 *
 * @module
 */
import type { HomebridgePluginLogging } from "./util.ts";
import { guardedDispatch } from "./util.ts";

/**
 * Construction options for {@link CoalescingTask}.
 *
 * @category Utilities
 */
export interface CoalescingTaskOptions {

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
   */
  run: () => Promise<void>;

  /**
   * The task's lifetime. Once it is aborted no further pass is run, and a queued follow-up is abandoned.
   */
  signal: AbortSignal;
}

/**
 * A single-flight task: one pass runs at a time, and any number of triggers arriving during a pass buy exactly one more.
 *
 * Asking is the whole of the surface. {@link CoalescingTask.schedule} asks for a pass and returns immediately: an idle task starts one now, a task already running takes
 * note and runs once more when the pass in flight finishes. A burst of triggers arriving during a pass therefore buys exactly one follow-up rather than one pass apiece,
 * and a trigger arriving after everything has settled starts a fresh pass of its own.
 *
 * The lifetime signal is honored at both ends. Once it aborts, a trigger starts nothing at all, and a follow-up that was queued before the abort is abandoned rather than
 * run into a lifetime that is over.
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
 * ```
 *
 * @category Utilities
 */
export class CoalescingTask {

  readonly #label: string;
  readonly #log: HomebridgePluginLogging;
  readonly #run: () => Promise<void>;
  readonly #signal: AbortSignal;

  /* The whole of the single-flight state, as one value rather than as a running flag beside a queued flag.
   *
   * Two booleans can express "queued but not running", which is a state this discipline has no meaning for and every consumer would simply have to avoid producing. One
   * three-armed value cannot express it at all, so the combination is unrepresentable rather than merely avoided.
   */
  #state: "idle" | "running" | "running-queued";

  /**
   * Build a coalescing task. Construction starts nothing; the first {@link CoalescingTask.schedule} does.
   *
   * @param options - See {@link CoalescingTaskOptions}.
   */
  public constructor(options: CoalescingTaskOptions) {

    this.#label = options.label;
    this.#log = options.log;
    this.#run = options.run;
    this.#signal = options.signal;
    this.#state = "idle";
  }

  /**
   * Ask for a pass. A pass already running takes note and runs once more when it finishes; an idle task starts one now.
   *
   * The dispatch is guarded rather than awaited, because every caller is an event handler or a timer that has nothing to wait for and a fault has to land in the log
   * rather than escape as an unhandled rejection.
   */
  public schedule(): void {

    /* A task whose lifetime has ended runs nothing at all, however it is asked. The drain loop answers the same question between passes, and asking it here too is what
     * closes the one window that check cannot reach: the first pass of a task triggered after teardown, which would otherwise get all the way into its work before
     * anything thought to look.
     */
    if(this.#signal.aborted) {

      return;
    }

    if(this.#state !== "idle") {

      this.#state = "running-queued";

      return;
    }

    guardedDispatch({ handler: async (): Promise<void> => this.#drain(), label: this.#label, log: this.#log });
  }

  // Run passes until nothing further has been asked for. The state is reset to "running" before each pass rather than after it, so a trigger arriving mid-pass is
  // recorded against the pass that follows rather than against the one it interrupted.
  async #drain(): Promise<void> {

    try {

      for(;;) {

        this.#state = "running";

        // A sequence of passes is what this is, so awaiting inside the loop is the shape rather than an oversight.
        // eslint-disable-next-line no-await-in-loop
        await this.#run();

        if(!this.#queued() || this.#signal.aborted) {

          return;
        }
      }
    } finally {

      this.#state = "idle";
    }
  }

  /* Whether a trigger arrived while a pass was running.
   *
   * This reads the state through a call rather than touching the field directly, and the indirection is deliberate. The loop above assigns the field immediately before
   * each pass; read directly, the compiler carries that assignment's narrowing across the await and reports the test afterwards as dead code - and an await is precisely
   * when the answer changes.
   */
  #queued(): boolean {

    return this.#state === "running-queued";
  }
}
