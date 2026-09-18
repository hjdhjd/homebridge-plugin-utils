/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/deviceFetch.mjs: The shared controller device fetch for the feature options webUI.
 */
"use strict";

import { DeadlineExpiredError, withDeadline } from "../../webUi-liveness.mjs";
import { connectionFailureCopy } from "../state.mjs";
import { errorMessage } from "../utils.mjs";
import { scopingControllerId } from "../selectors.mjs";

/**
 * The controller device fetch, and the selection that follows a clean one.
 *
 * Two callers ask the same thing of a controller - a sidebar click and a coordinated configuration write's reconciliation - and the choreography they share is
 * not small: record the fetch at the store's chokepoint, bound it, drop it when the page tore down, fold every failure into the outcome the reducer renders, and
 * let the reducer's own verdict decide whether the selection may continue. Written twice it would drift, and the half that drifted would be a failure nobody
 * sees until a controller cannot be reached.
 *
 * It lives under `effects/` because it is side-effect code that drives the store around host I/O, which is neither a view nor a selector. Its shape differs from
 * its siblings here and the difference is worth naming rather than papering over: they register subscriptions against a lifecycle signal and run until it
 * aborts, while these two functions are called on demand and hold no state of their own beyond the arguments each is handed.
 *
 * @module
 */

/**
 * Fetch a controller's devices and stamp the outcome onto the store.
 *
 * The sequence is one operation: a `devices:requested` mints this fetch's sequence at the store, the hook is called with the controller entry the store holds for
 * that id, and the result - a device list, a reported failure, or a rejection - travels back on one `devices:loaded` carrying that sequence. The sequence, not the
 * controller, is the fetch identity, so the newest request owns the pending slot and a superseded fetch's outcome drops at the reducer rather than overwriting
 * what replaced it.
 *
 * It never rejects. Every failure is an outcome the reducer already knows how to render: a rejected hook, a hook that answered in the wrong shape, and a deadline
 * that elapsed all arrive as an empty device list beside a message, which is the reducer's one fetch-failure transition. A deadline expiry is the one failure that
 * carries its own display copy, because the plugin that stopped answering is not the controller the user would be sent to check; every other rejection keeps the
 * caller's configured controller guidance and the framework's shared controller headline.
 *
 * @param {Object} args
 * @param {string | null} args.controllerId - The controller whose devices are wanted, as the sidebar and the store name it. Null fetches the device-only page's
 *        single list.
 * @param {number} args.deadlineSeconds - The deadline, in seconds, on the hook's call.
 * @param {string} [args.failureGuidance] - The plugin's own guidance for a controller that cannot be reached, carried on the outcome so every controller failure
 *        reads the same way. Absent leaves the reducer on the framework's shared wording.
 * @param {(controller: (Object | null)) => Promise<import("../../webUi-featureOptions.mjs").DeviceListResult>} args.getDevices - The device fetcher.
 * @param {AbortSignal} args.signal - The signal of the cycle this fetch belongs to. An abort drops the outcome rather than dispatching it into whatever replaced
 *        that cycle.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store the fetch records itself and its outcome at.
 * @returns {Promise<boolean>} True only when this fetch's own outcome applied and carried no failure - the one verdict that lets a caller continue a selection
 *   into the list it brought. False in every other case: superseded, failed, or dropped on a torn-down page.
 */
export const fetchControllerDevices = async ({ controllerId, deadlineSeconds, failureGuidance = undefined, getDevices, signal, store }) => {

  // Record this fetch at the store's chokepoint before awaiting, then read back the minted sequence - the store's ticket for this fetch. The newest request owns
  // the pending slot, so a superseded fetch's outcome finds its sequence gone when it lands and drops at the reducer.
  store.dispatch({ controllerId, type: "devices:requested" });

  const seq = store.state.devicesRequest.seq;

  try {

    const controller = store.state.controllers.find((entry) => entry.serialNumber === controllerId);

    // Bound the fetch. The plugin's hook goes through the same bridge every other host call does, so an unanswered request would otherwise leave the page
    // highlighted on a controller whose devices never arrive - the deadline turns that into the rejection the catch below already knows how to render.
    const { devices, emptyMessage, error, guidance, headline } = await withDeadline({ promise: getDevices(controller ?? null), seconds: deadlineSeconds, signal });

    // Bail if the page tore down; a torn-down store must not be dispatched against. Staleness itself is the reducer's job - it drops an outcome whose sequence no
    // longer answers the pending request.
    if(signal.aborted) {

      return false;
    }

    // The copy is included unconditionally: the reducer reads it only on the fold a non-empty error triggers and ignores it on a success, so one dispatch shape
    // serves both outcomes. What the result named wins over the configured guidance, which stands in for every failure this plugin can have rather than for the
    // one that just happened; a result naming neither leaves both fallbacks in place.
    store.dispatch({ controllerId, devices, emptyMessage, error, guidance: guidance ?? failureGuidance, headline, seq, type: "devices:loaded" });

    // The reducer's own verdict, read after the dispatch: my outcome applied only when the sequence I carried is the one it recorded, and a reported failure is
    // not a list to continue into however cleanly it arrived.
    return (store.state.devicesAppliedSeq === seq) && !error.length;
  } catch(err) {

    // The page-teardown bail guards the reject path too.
    if(signal.aborted) {

      return false;
    }

    /* A deadline expiry is the one rejection whose copy is not the controller's. The bound covers the plugin's own hook, so what elapsed says the plugin stopped
     * answering, and sending the user to check controller details would send them after the wrong thing; the copy table's devices-expiry row says the honest
     * thing instead. Every other rejection - an IPC failure, the contract-guard TypeError - is the controller's as far as anyone here can tell, so it carries
     * the caller's configured guidance and leaves the framework's shared controller headline standing.
     */
    const expiry = (err instanceof DeadlineExpiredError) ?
      connectionFailureCopy({ controllerFailureGuidance: failureGuidance, expired: true, site: "devices" }) : null;

    store.dispatch({

      controllerId,
      devices: [],
      error: errorMessage(err),
      guidance: expiry?.guidance ?? failureGuidance,
      headline: expiry?.headline,
      seq,
      type: "devices:loaded"
    });

    return false;
  }
};

/**
 * Continue a controller selection onto the controller-as-device row the list that just landed carries.
 *
 * The row is the controller's identity on the page - the projection keys controller scope by its serial - and the derivation reads the applied list, so this is
 * called after an outcome has landed rather than alongside it. A list carrying no such row leaves the selection where it rests, which is the controller's own
 * view, and that is exactly the resting place a nothing-to-list notice renders over.
 *
 * @param {Object} args
 * @param {string} args.controllerId - The controller the selection belongs to, as the sidebar names it.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store the selection is dispatched against.
 */
export const completeControllerSelection = ({ controllerId, store }) => {

  const deviceId = scopingControllerId(store.state);

  if(deviceId === null) {

    return;
  }

  store.dispatch({ scope: { controllerId, deviceId, kind: "device" }, type: "scope:changed" });
};
