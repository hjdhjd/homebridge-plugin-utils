/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * coalesce.test.ts: Unit tests for CoalescingTask - one pass at a time and exactly one follow-up however many triggers arrive, the queue drained so a later trigger runs
 * fresh, a throwing pass absorbed and reported under the task's label, and the lifetime signal honored both before a pass starts and while one is in flight.
 *
 * The count is the whole subject here, which is why every scenario drives SEVERAL triggers rather than one. A naive implementation that simply ran the callback on every
 * schedule passes a single-trigger test and fails every one of these; so does one that queued each trigger and drained them in turn.
 */
import { assertNoUnhandledRejections, capturingLog, expectAt, silentLog } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { CoalescingTask } from "./coalesce.ts";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";

// Yield to the macrotask queue, which drains the entire microtask cascade first. A coalescing task arms no timers at all - a pass, the guarded dispatch around it, and
// the drain loop between passes are promise continuations and nothing else - so one macrotask boundary brings the whole cascade to rest however deep it ran, and no
// scenario here has to wait on real time.
async function settle(): Promise<void> {

  await tick();
}

// A task whose pass parks until the scenario releases it, so triggers can be delivered while a pass is demonstrably still running rather than hopefully so.
function gatedTask(): { held: () => number; passes: () => number; release: () => void; task: CoalescingTask } {

  const counts = { passes: 0 };
  const pending: (() => void)[] = [];

  let open = false;

  const task = new CoalescingTask({

    label: "test pass",
    log: silentLog(),

    run: async (): Promise<void> => {

      counts.passes++;

      if(open) {

        return;
      }

      await new Promise<void>((resolve) => {

        pending.push(resolve);
      });
    },

    signal: new AbortController().signal
  });

  return {

    held: (): number => pending.length,
    passes: (): number => counts.passes,

    release: (): void => {

      open = true;

      for(const resume of pending.splice(0)) {

        resume();
      }
    },

    task
  };
}

describe("a coalescing task", () => {

  test("runs the callback once for a schedule from idle", async () => {

    const gated = gatedTask();

    gated.release();
    gated.task.schedule();

    await settle();

    assert.equal(gated.passes(), 1, "one trigger buys one pass");
  });

  test("collapses a burst arriving during a pass into exactly one follow-up", async () => {

    const gated = gatedTask();

    gated.task.schedule();

    // The pass is genuinely underway and parked, which is what makes these triggers land mid-pass rather than merely soon after one.
    await settle();
    assert.equal(gated.held(), 1, "the first pass is running and held");

    for(const _trigger of [ 1, 2, 3, 4, 5 ]) {

      gated.task.schedule();
    }

    gated.release();

    await settle();

    assert.equal(gated.passes(), 2, "five triggers during one pass buy exactly one more pass, not five and not none");
  });

  test("drains the queued state, so a later trigger runs fresh", async () => {

    const gated = gatedTask();

    gated.task.schedule();

    await settle();

    gated.task.schedule();
    gated.release();

    await settle();

    assert.equal(gated.passes(), 2, "the follow-up ran");

    // A trigger arriving after everything has settled has to start a pass of its own. A queued flag left standing would swallow it, or spin a pass nobody asked for.
    gated.task.schedule();

    await settle();

    assert.equal(gated.passes(), 3, "and a later trigger is a fresh pass rather than something the last one already covered");
  });

  test("absorbs a throwing pass and keeps working", async () => {

    await assertNoUnhandledRejections(async () => {

      const counts = { passes: 0 };

      const task = new CoalescingTask({

        label: "test pass",
        log: silentLog(),

        run: async (): Promise<void> => {

          counts.passes++;

          await Promise.resolve();

          throw new Error("The pass failed.");
        },

        signal: new AbortController().signal
      });

      task.schedule();

      await settle();

      /* A pass that throws must not leave the task wedged as permanently running, and must not escape as an unhandled rejection either. The next schedule running at all
       * is what proves the state was released on the way out, and the monitor wrapped around this body is what proves the rejection was observed rather than left to
       * float past a passing assertion.
       */
      task.schedule();

      await settle();

      assert.equal(counts.passes, 2, "a failed pass is absorbed and the next trigger still runs");
    });
  });

  test("reports a failed pass through the log, under the task's own label", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();

      const task = new CoalescingTask({

        label: "device refresh",
        log,

        run: async (): Promise<void> => {

          await Promise.resolve();

          throw new Error("The pass failed.");
        },

        signal: new AbortController().signal
      });

      task.schedule();

      await settle();

      // The label and the logger have no behavioral consequence of their own, so what they are for is precisely this line: a failed pass is named in the log rather
      // than disappearing, and it is named once.
      const failures = log.entries.filter((entry) => entry.level === "error");

      assert.equal(failures.length, 1, "a failed pass is reported exactly once");
      assert.deepEqual(expectAt(failures, 0, "the failure line").params, [ "device refresh", "The pass failed" ], "the failure line carries the task's own label");
    });
  });

  test("starts no pass at all once its lifetime has ended", async () => {

    const controller = new AbortController();
    const counts = { passes: 0 };

    const task = new CoalescingTask({

      label: "test pass",
      log: silentLog(),

      run: async (): Promise<void> => {

        counts.passes++;

        await Promise.resolve();
      },

      signal: controller.signal
    });

    controller.abort();
    task.schedule();

    await settle();

    /* The drain loop's own check cannot reach this: it answers between passes, and there has been no pass. A trigger arriving after teardown - a timer that has not yet
     * been retired, a callback already in flight - must start nothing rather than get all the way into its work before anything looks.
     */
    assert.equal(counts.passes, 0, "a task asked to run after its lifetime ended does not run");
  });

  test("abandons a queued follow-up once its lifetime has ended", async () => {

    const controller = new AbortController();
    const counts = { passes: 0 };

    let release: (() => void) | undefined;

    const task = new CoalescingTask({

      label: "test pass",
      log: silentLog(),

      run: async (): Promise<void> => {

        counts.passes++;

        await new Promise<void>((resolve) => {

          release = resolve;
        });
      },

      signal: controller.signal
    });

    task.schedule();

    await settle();

    // A trigger lands mid-pass, and then the whole thing is torn down before that pass finishes. The follow-up it bought is work for a lifetime that has ended.
    task.schedule();
    controller.abort();
    release?.();

    await settle();

    assert.equal(counts.passes, 1, "a follow-up queued before a teardown is abandoned rather than run into a lifetime that is over");
  });
});
