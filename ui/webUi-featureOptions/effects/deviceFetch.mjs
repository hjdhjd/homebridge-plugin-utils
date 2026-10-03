/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/deviceFetch.mjs: The shared controller device fetch for the feature options webUI.
 */
"use strict";

import { DeadlineExpiredError, withDeadline } from "../../webUi-liveness.mjs";
import { connectionFailureCopy } from "../state.mjs";
import { errorMessage } from "../../webUi-errors.mjs";
import { markHandled } from "../../mark-handled.js";
import { scopingControllerId } from "../selectors.mjs";

/**
 * The controller device fetch, and the selection that follows a clean one.
 *
 * Every caller that asks a controller for its devices, such as the boot or a sidebar click, shares one choreography, and it is not small: record the fetch at
 * the store's chokepoint, bound it, drop it when the page tore down, fold every failure into the outcome the reducer renders, and let the reducer's own verdict
 * decide whether the selection may continue. Written once per caller it would drift, and the copy that drifted would be a failure nobody sees until a controller
 * cannot be reached.
 *
 * It lives under `effects/` because it is side-effect code that drives the store around host I/O, which is neither a view nor a selector. Its shape differs from
 * its siblings here and the difference is worth naming rather than papering over: they register subscriptions against a lifecycle signal and run until it
 * aborts, while these functions are called on demand and hold no state of their own beyond the arguments each is handed.
 *
 * @module
 */

/**
 * Record a controller device fetch at the store and fire it, leaving its outcome for {@link settleControllerDevices} to land.
 *
 * The fetch is split into a request and a settle because the boot needs them apart. It fires the fetch of the controller it chose before the feature catalog
 * loads, so the two overlap, and lands the outcome only once the model has loaded, so a device failure meets a page whose controllers and failure surface are
 * already in place. A caller with nothing to overlap runs the request and the settle back to back through {@link fetchControllerDevices}.
 *
 * The sequence is minted before the hook is called, so any request made after this one supersedes it at the reducer, however long this one takes to settle. The
 * fetch is marked handled the moment it is fired: a caller that settles it later leaves a window in which a rejection would otherwise meet no handler, and the
 * settle still observes that rejection through its own branch of the same promise.
 *
 * @param {Object} args
 * @param {Object | null} args.controller - The controller entry the hook is called with, or null for the device-only page's single list.
 * @param {string | null} args.controllerId - The controller the fetch is recorded against, as the sidebar and the store name it.
 * @param {(controller: (Object | null)) => Promise<import("../../webUi-featureOptions.mjs").DeviceListResult>} args.getDevices - The device fetcher.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store the fetch records itself at.
 * @returns {{ controllerId: (string | null), fetch: Promise<import("../../webUi-featureOptions.mjs").DeviceListResult>, seq: number }} The recorded fetch: the
 *   controller it belongs to, the fired hook's promise, and the sequence the store minted for it.
 */
export const requestControllerDevices = ({ controller, controllerId, getDevices, store }) => {

  // Record this fetch at the store's chokepoint before firing it, then read back the minted sequence - the store's ticket for this fetch. The newest request owns
  // the pending slot, so a superseded fetch's outcome finds its sequence gone when it lands and drops at the reducer.
  store.dispatch({ controllerId, type: "devices:requested" });

  const seq = store.state.devicesRequest.seq;

  return { controllerId, fetch: markHandled(getDevices(controller)), seq };
};

/**
 * Settle a recorded device fetch and stamp its outcome onto the store.
 *
 * The result - a device list, a reported failure, or a rejection - travels back on one `devices:loaded` carrying the fetch's sequence. The sequence, not the
 * controller, is the fetch identity, so the newest request owns the pending slot and a superseded fetch's outcome drops at the reducer rather than overwriting
 * what replaced it.
 *
 * It never rejects. Every failure is an outcome the reducer already knows how to render: a rejected hook, a hook that answered in the wrong shape, and a deadline
 * that elapsed all arrive as an empty device list beside a message, which is the reducer's one fetch-failure transition. Every failure also carries its display
 * copy, read from the page's copy table for the devices site - the expiry row when the deadline elapsed, because the plugin that stopped answering is not the
 * controller the user would be sent to check, and the failure row otherwise. A result that reports its own failure and names its own headline or guidance wins
 * field by field, the precedence every failing await on the page follows, so a thrown failure and a reported one that names nothing read alike.
 *
 * @param {Object} args
 * @param {number} args.deadlineSeconds - The deadline, in seconds, on the fetch, armed when the settle begins.
 * @param {string} [args.failureGuidance] - The plugin's own guidance for a controller that cannot be reached, standing in for the copy table's controller
 *        guidance on a failure's outcome so every controller failure reads the same way. Absent leaves the table's own guidance.
 * @param {{ controllerId: (string | null), fetch: Promise<import("../../webUi-featureOptions.mjs").DeviceListResult>, seq: number }} args.request - The fetch
 *        {@link requestControllerDevices} recorded.
 * @param {AbortSignal} args.signal - The signal of the cycle this fetch belongs to. An abort drops the outcome rather than dispatching it into whatever replaced
 *        that cycle.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store the outcome is stamped onto.
 * @returns {Promise<boolean>} True only when this fetch's own outcome applied and carried no failure - the one verdict that lets a caller continue a selection
 *   into the list it brought. False in every other case: superseded, failed, or dropped on a torn-down page.
 */
export const settleControllerDevices = async ({ deadlineSeconds, failureGuidance = undefined, request, signal, store }) => {

  const { controllerId, fetch, seq } = request;

  try {

    // Bound the fetch. The plugin's hook goes through the same bridge every other host call does, so an unanswered request would otherwise leave the page
    // highlighted on a controller whose devices never arrive - the deadline turns that into the rejection the catch below already knows how to render.
    const { devices, emptyMessage, error, ...copy } = await withDeadline({ promise: fetch, seconds: deadlineSeconds, signal });

    // Bail if the page tore down; a torn-down store must not be dispatched against. Staleness itself is the reducer's job - it drops an outcome whose sequence no
    // longer answers the pending request.
    if(signal.aborted) {

      return false;
    }

    // A reported failure reads the copy table's devices row, and the result's own copy wins over it field by field: the result speaks for the failure that just
    // happened, while the table and the configured guidance speak for every failure this plugin can have. A clean outcome has no failure to describe, so it
    // resolves no table copy, and the reducer reads none on a success.
    const { guidance, headline } = error.length ? connectionFailureCopy({ controllerFailureGuidance: failureGuidance, expired: false, site: "devices" }) : {};

    store.dispatch({

      controllerId,
      devices,
      emptyMessage,
      error,
      guidance: copy.guidance ?? guidance,
      headline: copy.headline ?? headline,
      seq,
      type: "devices:loaded"
    });

    // The reducer's own verdict, read after the dispatch: my outcome applied only when the sequence I carried is the one it recorded, and a reported failure is
    // not a list to continue into however cleanly it arrived.
    return (store.state.devicesAppliedSeq === seq) && !error.length;
  } catch(err) {

    // The page-teardown bail guards the reject path too.
    if(signal.aborted) {

      return false;
    }

    /* A rejection has no result to name copy of its own, so it reads the copy table's devices row for its kind. A deadline expiry takes the expiry row: the bound
     * covers the plugin's own hook, so what elapsed says the plugin stopped answering, and sending the user to check controller details would send them after the
     * wrong thing. Every other rejection - an IPC failure, the contract-guard TypeError - is the controller's as far as anyone here can tell, so it takes the
     * failure row, with the caller's configured guidance standing in for the table's.
     */
    const { guidance, headline } = connectionFailureCopy({ controllerFailureGuidance: failureGuidance, expired: err instanceof DeadlineExpiredError, site: "devices" });

    store.dispatch({ controllerId, devices: [], error: errorMessage(err), guidance, headline, seq, type: "devices:loaded" });

    return false;
  }
};

/**
 * Fetch a controller's devices and stamp the outcome onto the store, as one operation.
 *
 * The request and the settle run back to back: {@link requestControllerDevices} records the fetch and calls the hook with the controller entry the store holds for
 * that id, and {@link settleControllerDevices} bounds it and lands its outcome, whose verdict this returns.
 *
 * @param {Object} args
 * @param {string | null} args.controllerId - The controller whose devices are wanted, as the sidebar and the store name it. Null fetches the device-only page's
 *        single list.
 * @param {number} args.deadlineSeconds - The deadline, in seconds, on the hook's call.
 * @param {string} [args.failureGuidance] - The plugin's own guidance for a controller that cannot be reached, standing in for the copy table's controller
 *        guidance on a failure's outcome so every controller failure reads the same way. Absent leaves the table's own guidance.
 * @param {(controller: (Object | null)) => Promise<import("../../webUi-featureOptions.mjs").DeviceListResult>} args.getDevices - The device fetcher.
 * @param {AbortSignal} args.signal - The signal of the cycle this fetch belongs to. An abort drops the outcome rather than dispatching it into whatever replaced
 *        that cycle.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store the fetch records itself and its outcome at.
 * @returns {Promise<boolean>} True only when this fetch's own outcome applied and carried no failure - the one verdict that lets a caller continue a selection
 *   into the list it brought. False in every other case: superseded, failed, or dropped on a torn-down page.
 */
export const fetchControllerDevices = async ({ controllerId, deadlineSeconds, failureGuidance = undefined, getDevices, signal, store }) => {

  const controller = store.state.controllers.find((entry) => entry.serialNumber === controllerId) ?? null;

  return settleControllerDevices({ deadlineSeconds, failureGuidance, request: requestControllerDevices({ controller, controllerId, getDevices, store }), signal, store });
};

/**
 * Continue a controller selection onto the controller-as-device row the list that just landed carries.
 *
 * The row is the controller's identity on the page - the projection keys controller scope by its serial - and the derivation reads the applied list, so this is
 * called after an outcome has landed rather than alongside it. A list carrying no such row leaves the selection where it rests, which is the controller's own
 * view, and that is exactly the resting place a nothing-to-list notice renders over.
 *
 * The move is dispatched as a continuation rather than a user move, whoever began the selection. It carries a selection that already stands onto the row that
 * represents it, so it never ends a plugin's takeover: a sidebar click already did that with its own move, and the boot never should.
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

  store.dispatch({ origin: "continuation", scope: { controllerId, deviceId, kind: "device" }, type: "scope:changed" });
};
