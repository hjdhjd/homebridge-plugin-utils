/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * coalesce.test.ts: Unit tests for CoalescingTask - one pass at a time and exactly one follow-up however many triggers arrive, the queue drained so a later trigger runs
 * fresh, a throwing pass absorbed and named once under the task's label, the follow-up a trigger bought during a failing pass run all the same, the lifetime signal
 * honored both before a pass starts and while one is in flight, and a request answered with the pass's verdict, joined onto the drain in flight, and rejected with the
 * drain's fault or the lifetime's reason.
 *
 * The count is the whole subject here, which is why every scenario drives SEVERAL triggers rather than one. A naive implementation that simply ran the callback on every
 * schedule passes a single-trigger test and fails every one of these; so does one that queued each trigger and drained them in turn.
 */
import { assertNoUnhandledRejections, capturingLog, expectAt, settle, silentLog } from "./testing/index.ts";
import { describe, test } from "node:test";
import { CoalescingTask } from "./coalesce.ts";
import assert from "node:assert/strict";

// A task whose pass parks until the scenario releases it, so triggers can be delivered while a pass is demonstrably still running rather than hopefully so. Each pass
// answers its own number as its verdict, so a row that joins a drain can read which pass produced the answer it was handed.
function gatedTask(): { held: () => number; passes: () => number; release: () => void; task: CoalescingTask<number> } {

  const counts = { passes: 0 };
  const pending: (() => void)[] = [];

  let open = false;

  const task = new CoalescingTask({

    label: "test pass",
    log: silentLog(),

    run: async (): Promise<number> => {

      counts.passes++;

      if(open) {

        return counts.passes;
      }

      await new Promise<void>((resolve) => {

        pending.push(resolve);
      });

      return counts.passes;
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

/* Compile-time shape exercises for the verdict a request answers. These never run - the function is never called, and its leading underscore marks it, with its
 * bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals; TypeScript still type-checks the body during
 * `npm run typecheck`, so a shape regression fails the build here rather than silently at a consuming plugin. The negative case uses `@ts-expect-error`, which fails
 * the build if the error it expects ever stops occurring.
 */
const _requestShapeExercises = (): void => {

  const counted = new CoalescingTask({ label: "counted", log: silentLog(), run: (): Promise<number> => Promise.resolve(1), signal: new AbortController().signal });
  const plain = new CoalescingTask({ label: "plain", log: silentLog(), run: (): Promise<void> => Promise.resolve(), signal: new AbortController().signal });

  // The verdict type reaches all the way to what a requester holds, and a task built without one is the void form every fire-and-forget consumer already has.
  const _verdict: Promise<number> = counted.request();
  const _nothing: Promise<void> = plain.request();

  // @ts-expect-error - the verdict is a number, so a requester cannot read it back as a string.
  const _wrong: Promise<string> = counted.request();
};

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

  test("runs the follow-up a trigger bought during a pass that then fails", async () => {

    await assertNoUnhandledRejections(async () => {

      const counts = { passes: 0 };

      let release: (() => void) | undefined;

      const task = new CoalescingTask({

        label: "test pass",
        log: silentLog(),

        run: async (): Promise<void> => {

          counts.passes++;

          // Only the first pass parks and fails; the follow-up runs straight through, because what this row reads is whether it ran at all.
          if(counts.passes > 1) {

            return;
          }

          await new Promise<void>((resolve) => {

            release = resolve;
          });

          throw new Error("The pass failed.");
        },

        signal: new AbortController().signal
      });

      task.schedule();

      await settle();

      /* The trigger lands while the first pass is parked, so the follow-up it buys is on the books before that pass fails rather than after. A fault that ends the
       * whole drain rather than the pass loses exactly this request - the one the class promises to honor, made while a pass was still reading its inputs.
       */
      task.schedule();
      release?.();

      await settle();

      assert.equal(counts.passes, 2, "the follow-up bought during a failing pass still runs");
    });
  });

  test("names each failing pass once", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const counts = { passes: 0 };

      let release: (() => void) | undefined;

      const task = new CoalescingTask({

        label: "device refresh",
        log,

        run: async (): Promise<void> => {

          counts.passes++;

          // Only the first pass parks, so the second trigger can land mid-pass; both passes fail, which is what gives the log two lines to account for.
          if(counts.passes === 1) {

            await new Promise<void>((resolve) => {

              release = resolve;
            });
          }

          throw new Error("The pass failed.");
        },

        signal: new AbortController().signal
      });

      task.schedule();

      await settle();

      task.schedule();
      release?.();

      await settle();

      // Two triggers and two failing passes: the count is what proves a fault reports and nothing more. A catch that re-armed the follow-up itself would run a
      // third pass and a fourth against a fault that never clears.
      assert.equal(counts.passes, 2, "two triggers buy two passes and no more, a fault re-arming nothing");

      const failures = log.entries.filter((entry) => entry.level === "error");

      assert.equal(failures.length, 2, "each failing pass is named on its own line");
      assert.deepEqual(expectAt(failures, 0, "the first failure line").params, [ "device refresh", "The pass failed" ], "the first line carries the task's label");
      assert.deepEqual(expectAt(failures, 1, "the second failure line").params, [ "device refresh", "The pass failed" ], "the second line carries the task's label");
    });
  });

  test("answers a request from idle with the pass's verdict", async () => {

    const gated = gatedTask();

    gated.release();

    // The whole of what the awaitable spelling buys: the caller reads back what the pass it asked for produced, rather than only that the asking happened.
    assert.equal(await gated.task.request(), 1, "a request from idle answers with the verdict of the pass it started");
  });

  test("joins a request arriving during a pass onto the drain in flight and answers it with the follow-up's verdict", async () => {

    const gated = gatedTask();

    const first = gated.task.request();

    // The pass is genuinely underway and parked, which is what makes the second request land mid-pass rather than merely soon after one.
    await settle();
    assert.equal(gated.held(), 1, "the first pass is running and held");

    const second = gated.task.request();

    /* Two askers of one drain hold one promise rather than two derived from it, and identity is what proves it: a per-caller copy would satisfy every value assertion
     * here and still be a second object to keep in step. The verdict they share is the follow-up's, because the request that arrived mid-pass bought that follow-up
     * precisely so the answer would reflect inputs the pass already running had read past.
     */
    assert.equal(second, first, "a request arriving mid-pass is handed the identical promise the drain in flight already answers");

    gated.release();

    assert.equal(await first, 2, "the drain answers with the follow-up's verdict rather than the verdict of the pass that was already running");
    assert.equal(gated.passes(), 2, "two askers of one drain buy one follow-up, not one pass apiece");
  });

  test("a schedule during a request's pass buys the follow-up the requester waits for", async () => {

    const gated = gatedTask();

    const first = gated.task.request();

    await settle();

    // A schedule and a request ask the same question of the same drain, so a fire-and-forget trigger extends the work a requester waits on rather than running beside it.
    gated.task.schedule();
    gated.release();

    assert.equal(await first, 2, "the requester's answer is the follow-up that the schedule bought");
  });

  test("a request after the drain has settled starts a fresh drain", async () => {

    const gated = gatedTask();

    gated.release();

    const first = gated.task.request();

    assert.equal(await first, 1, "the first request answers with its own pass");

    const fresh = gated.task.request();

    /* A settled drain is over, so the next ask is a drain of its own. A settlement kept past the drain behind it would answer this caller with the verdict of work
     * that had already finished before it asked - the awaitable spelling's version of the stale-queue bug the fire-and-forget rows read for.
     */
    assert.notEqual(fresh, first, "an ask after settlement is answered by a new drain rather than by the one that already finished");
    assert.equal(await fresh, 2, "and that drain runs a pass of its own");
  });

  test("a request whose last pass faults reads the fault after the log names the pass", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();

      const task = new CoalescingTask({

        label: "test pass",
        log,

        run: async (): Promise<number> => {

          await Promise.resolve();

          throw new Error("The pass failed.");
        },

        signal: new AbortController().signal
      });

      /* The one caller that asked to see the outcome is told what the outcome was, and a fault is one of the outcomes. Reporting does not depend on which spelling
       * asked: the log line is what every caller gets, and the rejection is what the caller who waited gets, both from the same pass.
       */
      await assert.rejects(task.request(), { message: "The pass failed." });

      const failures = log.entries.filter((entry) => entry.level === "error");

      assert.equal(failures.length, 1, "the failing pass is named exactly once");
      assert.deepEqual(expectAt(failures, 0, "the failure line").params, [ "test pass", "The pass failed" ], "the failure line carries the task's own label");
    });
  });

  test("a faulted pass followed by a bought follow-up answers the follow-up's verdict", async () => {

    await assertNoUnhandledRejections(async () => {

      const log = capturingLog();
      const counts = { passes: 0 };

      let release: (() => void) | undefined;

      const task = new CoalescingTask({

        label: "test pass",
        log,

        run: async (): Promise<number> => {

          counts.passes++;

          // Only the first pass parks and fails; the follow-up runs straight through and answers, because what this row reads is which pass the drain ends on.
          if(counts.passes > 1) {

            return counts.passes;
          }

          await new Promise<void>((resolve) => {

            release = resolve;
          });

          throw new Error("The pass failed.");
        },

        signal: new AbortController().signal
      });

      const first = task.request();

      await settle();

      /* The fault belongs to a pass that is not the drain's last one, so it is reported and goes no further. A drain that rejected at the first fault would lose the
       * follow-up somebody asked for, and would hand the requester a fault about work another pass had already superseded.
       */
      task.schedule();
      release?.();

      assert.equal(await first, 2, "the requester reads the follow-up's verdict rather than the fault of the pass before it");

      const failures = log.entries.filter((entry) => entry.level === "error");

      assert.equal(failures.length, 1, "the failing pass is still named on its own line");
    });
  });

  test("a request after the lifetime has ended rejects with the signal's reason and runs nothing", async () => {

    const controller = new AbortController();
    const counts = { passes: 0 };

    const task = new CoalescingTask({

      label: "test pass",
      log: silentLog(),

      run: async (): Promise<number> => {

        counts.passes++;

        await Promise.resolve();

        return counts.passes;
      },

      signal: controller.signal
    });

    controller.abort(new Error("Torn down."));

    /* A caller that asked to be told cannot be answered with silence, so the ask is refused in the library's standing vocabulary for a lifetime that has ended: the
     * signal's own reason. The count is what proves the refusal is a refusal rather than a rejection collected after the work ran anyway.
     */
    await assert.rejects(task.request(), { message: "Torn down." });

    assert.equal(counts.passes, 0, "a request made after teardown starts no pass at all");
  });

  test("a request made from inside the pass joins the drain that is running it", async () => {

    const counts = { passes: 0 };

    let inner: Promise<number> | undefined;

    const task = new CoalescingTask<number>({

      label: "test pass",
      log: silentLog(),

      run: async (): Promise<number> => {

        counts.passes++;

        // The re-entrant ask is made before this pass reaches its first await, which is the moment a drain that installed its settlement late would still read idle.
        if(counts.passes === 1) {

          inner = task.request();
        }

        await Promise.resolve();

        return counts.passes;
      },

      signal: new AbortController().signal
    });

    const outer = task.request();

    /* A drain installs its settlement into the state before it runs anything, so a pass that asks while it is running joins the drain running it. A second drain
     * would hand its own promise back to the pass and run a third pass against work that was already underway.
     */
    assert.equal(inner, outer, "the pass's own ask is answered by the drain that is running it");
    assert.equal(await outer, 2, "the re-entrant ask buys the one follow-up, and both askers read its verdict");
    assert.equal(counts.passes, 2, "one follow-up, rather than a second drain's pass on top of it");
  });
});
