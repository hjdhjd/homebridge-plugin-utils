/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/persist.mjs: The persistence effect for the feature options webUI.
 */
"use strict";

import { delay } from "../utils.mjs";
import { effect } from "../store.mjs";

/**
 * Debounce window for coalescing rapid mutations before writing to disk. 300ms sits below the instant-feel ceiling - a single click feels immediate from the user's
 * perspective (a 300ms persist completes invisibly while the next click is being decided) - yet above the burst-coalescing floor, so a rapid sequence of mutations
 * (the user dragging a slider, batching reset/revert through multiple controllers) collapses into a single write rather than one write per mutation.
 */
const DEBOUNCE_MS = 300;

/**
 * Register the persistence effect on a store.
 *
 * Coalesces, serializes, and rolls back option persistence:
 *
 *   - **Coalescing**: every mutation that changes `configuredOptions` enters this effect through a single dirty flag (`pending`). The drain loop reads the flag at
 *     each iteration and re-enters when it is set, so rapid mutations collapse into one persist of the latest state. The debounce on top of the drain absorbs
 *     burst-mutation patterns (drag/keystroke) without queueing multiple writes.
 *   - **Serialization**: a single drain promise (`inFlight`) is held while a persist call is in flight. Concurrent mutations only set `pending = true`; the drain
 *     loop picks up the latest state at its next iteration. No two persist calls can be in flight against the host at the same time.
 *   - **Rollback**: a final-iteration failure (no superseding mutation) dispatches `persist:failed`, which the reducer translates into restoring
 *     `configuredOptions` to the last-known-good `persistedAnchor`. Intermediate-iteration failures (a mutation rescued the user's intent) are swallowed because
 *     the next iteration will retry with the newer state; the user's most recent action is what matters.
 *
 * The dispatch sequence per iteration:
 *
 *   1. `persist:started` with the snapshot being written. Status transitions to `persisting`; the status bar can show a "saving" affordance.
 *   2. `session.commit({ options })` is awaited - the session merges the options onto its primary entry, preserves siblings, writes to the host, and advances its
 *      held reference only on success.
 *   3. Success: `persist:succeeded` with the snapshot. Status returns to `ready`; the anchor advances to this snapshot.
 *   4. Failure with no superseding mutation: `persist:failed` with the error. Status transitions to `persist-error`; the reducer rolls `configuredOptions` back to
 *      the anchor.
 *   5. Failure with a superseding mutation: the error is swallowed; the loop continues with the newer state.
 *
 * The effect is registered with the page-level signal. Aborting the signal cleanly tears down the listener; an in-flight `updatePluginConfig` call cannot itself
 * be aborted (the Homebridge bridge does not accept an `AbortSignal`), but the drain checks `signal.aborted` after every await and bails before dispatching any
 * post-call action against a torn-down view.
 *
 * Returns a `{ flush }` handle. The page calls `flush()` at its navigate-away chokepoint (and best-effort on browser background/close) BEFORE aborting the signal,
 * so a debounced-but-unwritten edit reaches disk instead of being dropped when the signal aborts. `flush()` drives the same single-writer drain to completion - it
 * skips the debounce wait, never starts a parallel commit, and is a no-op when the store is already clean.
 *
 * @param {Object} args
 * @param {{toast?: {error?: (message: string, id: string) => void}}} args.host - The Homebridge bridge, used only for the failure toast channel.
 * @param {{commit: (patch: Object) => Promise<void>}} args.session - The config session; option saves persist through its single write seam.
 * @param {AbortSignal} args.signal - The lifecycle signal. Aborting tears down the effect.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store the effect subscribes against.
 * @returns {{flush: () => Promise<void>}} A handle whose `flush()` drains any pending edit to disk now; called at the page's navigate-away / browser-exit edges.
 */
export const registerPersistEffect = ({ host, session, signal, store }) => {

  // The drain-state variables below encode the irreducible coordination this pattern requires:
  //
  //   - `inFlight`: the in-flight drain promise. When non-null, the drain loop is active; subsequent mutations only set `pending` and return.
  //   - `pending`: the dirty flag. Set by every subscribed mutation; cleared by the drain loop at the top of each iteration. Setting it during an in-flight persist
  //     is the signal "your current snapshot is already stale; iterate again with the newer state."
  //   - `debounceAbort`: the abort controller for the current debounce window. Every new mutation aborts the prior debounce so the timer always restarts from zero
  //     on the latest mutation - the burst-mutation case (drag/keystroke) collapses to one debounced fire after the burst ends.
  //   - `flushing`: set by flush() to drive the drain to completion NOW (skipping the debounce wait) when the page is navigating away. It keeps the loop running even
  //     once `pending` has been consumed, so an edit made within the debounce window is written before teardown rather than dropped. Reset in every drain's `finally`
  //     so it never outlives the drain it belongs to - the set-once-never-cleared leak this flag would otherwise introduce.
  let debounceAbort = null;
  let flushing = false;
  let inFlight = null;
  let pending = false;

  const drain = async () => {

    while((pending || flushing) && !signal.aborted) {

      pending = false;

      // The debounce is the burst-coalescing wait, but on the flush path (navigating away) we skip it: the edit must reach disk before teardown, so we go straight to
      // the snapshot. In the normal path we restart the debounce on the latest mutation as before.
      if(!flushing) {

        debounceAbort?.abort();
        debounceAbort = new AbortController();

        try {

          // The debounce itself is the loop's intentional serialization point - each iteration must wait the debounce window before sampling state again. Same
          // exception applies as the persist call below: this await is the point.
          // eslint-disable-next-line no-await-in-loop
          await delay(DEBOUNCE_MS, AbortSignal.any([ debounceAbort.signal, signal ]));
        } catch {

          // Debounce was aborted. If the page signal aborted, bail entirely. Otherwise the abort was a new mutation arriving during the debounce window - continue
          // the loop and the next iteration starts a fresh debounce.
          if(signal.aborted) {

            return;
          }

          continue;
        }
      }

      // In-loop dirty check. The effect-fn dirty check below does NOT gate the flush path (flush() bypasses the fn and starts the drain directly), so the drain must
      // re-test here: once a just-committed edit advances `persistedAnchor` to match `configuredOptions`, there is nothing left to write, and we break rather than
      // looping again on a now-clean store. This also skips a redundant write when an edit was reverted back to the anchor within the debounce window.
      if(store.state.configuredOptions === store.state.persistedAnchor) {

        break;
      }

      // Capture the configuredOptions reference (not a spread copy). Reference preservation matters: when the persist succeeds with no superseding mutation,
      // `persistedAnchor` becomes this same reference, so the next `pending` check at the effect's fn sees `configuredOptions === persistedAnchor` and skips.
      const snapshot = store.state.configuredOptions;

      store.dispatch({ snapshot, type: "persist:started" });

      try {

        // Sequential awaits are the point: the drain serializes persists so concurrent mutations cannot race on disk. The eslint rule's concern (parallelizing
        // independent work) does not apply - each iteration's persist is the only legitimate I/O the drain should be running at any moment. The session owns the
        // payload shape (primary entry + siblings) and the write; we hand it only the options delta.
        // eslint-disable-next-line no-await-in-loop
        await session.commit({ options: snapshot });

        if(signal.aborted) {

          return;
        }

        store.dispatch({ snapshot, type: "persist:succeeded" });
      } catch(error) {

        // A mutation arrived during the persist call - swallow the error and let the next iteration retry with the newer state. The user's most recent intent is
        // what matters; an intermediate failure that the next iteration rescues need not surface to the user.
        if(pending) {

          continue;
        }

        if(signal.aborted) {

          return;
        }

        store.dispatch({ error, type: "persist:failed" });

        // Surface the failure via the host's toast channel so the user sees an actionable indication that their last edit did not reach disk. The single
        // toast-emission seam keeps the user-facing notification policy in one place; effects elsewhere that dispatch persist:failed have the same path
        // available through this effect's subscription.
        host.toast?.error?.(error?.message ?? String(error), "config-persist");

        return;
      }
    }
  };

  effect({

    events: [ "option:set", "option:cleared", "options:reset", "model:reverted" ],
    fn: () => {

      // Reference-equality dirty check: when configuredOptions matches the anchor, there is nothing new to persist. Handles both the registration-time immediate
      // call (initial state shares one empty-array reference across the three options-array fields) and any genuine no-op mutation that produced the same reference
      // (e.g., an option:cleared against an option that did not exist - applyClearOption returns the input reference unchanged, so the reducer's spread preserves
      // configuredOptions).
      if(store.state.configuredOptions === store.state.persistedAnchor) {

        return;
      }

      pending = true;

      if(inFlight) {

        return;
      }

      // Single-writer drain start-site (mutation path). The macrotask-ordering invariant the serialization rests on: every subscribed store mutation
      // (option:set / option:cleared / options:reset / model:reverted) and every flush() caller (hide() / the visibilitychange handler) originates from a DOM-event
      // macrotask, so none can preempt the queued `inFlight.finally` microtask and strand a `pending` edit in the gap between the drain returning and its `finally`
      // clearing `inFlight`. (Forward-safety: if a future caller ever dispatches one of those subscribed actions from a microtask continuation, this invariant
      // must be re-checked.) Reset `flushing` here too so it never outlives the drain it belongs to.
      inFlight = drain().finally(() => {

        inFlight = null;
        flushing = false;
      });
    },
    signal,
    store
  });

  // Drain any pending-but-unwritten edit to disk NOW, used by the page's navigate-away chokepoint (hide()) and the best-effort browser-exit handler. flush() drives
  // the drain to completion by setting `flushing` (which keeps the loop running past the debounce wait) and aborting the in-flight debounce so the current iteration
  // proceeds straight to the write. It preserves single-writer serialization: it starts a NEW drain only when none is in flight; when a drain is already running it
  // merely nudges it (set `flushing`, abort the debounce) and awaits the same promise - never a parallel commit. When the store is already clean (nothing dirty), it
  // starts no drain and resets `flushing` immediately, so a flush() on a clean store cannot leak `flushing = true` into the next mutation's debounce decision.
  const flush = async () => {

    flushing = true;

    debounceAbort?.abort();

    if(!inFlight) {

      if(store.state.configuredOptions === store.state.persistedAnchor) {

        flushing = false;

        return;
      }

      inFlight = drain().finally(() => {

        inFlight = null;
        flushing = false;
      });
    }

    await inFlight;
  };

  return { flush };
};
