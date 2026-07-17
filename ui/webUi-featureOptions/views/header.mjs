/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/header.mjs: The priority-chain informational header.
 */
"use strict";

import { createElement } from "../utils.mjs";
import { effect } from "../store.mjs";

/**
 * Mount the priority-chain header view.
 *
 * The header reads as the literal hierarchy users see in the UI: "Global options -> Controller options -> Device options," with the controller hop omitted in
 * device-only mode. Bold lead-in text frames it as a precedence statement; color-coded labels (warning / success / info) match the same scope-color convention the
 * row labels use, so users have one consistent visual lens for "where does a setting come from."
 *
 * Runs on `model:loaded`, `connection:error`, and `devices:loaded`; other dispatches never invoke it because they are not subscribed, and a subscribed dispatch
 * that leaves the status reference unchanged skips via the memo below. On `connection:error` (and the loading
 * status), `fn` yields inside its `status.kind` checks. In practice the header content is rendered once, at `model:loaded`. The connection-error and no-controllers
 * views render their own content into the same container, so this view yields when the status indicates either of those states.
 *
 * @param {Object} args
 * @param {HTMLElement} args.root - The `#headerInfo` container.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountHeaderView = ({ root, signal, store }) => {

  // The last status object this view acted on. The reducer mints a new status object only on a genuine transition, so a `devices:loaded` that did not move the status
  // (a successful fetch, or a dropped stale outcome that returns the identical state) leaves this reference unchanged and the effect below skips - the precedence
  // chain is never rebuilt for a device-list change it does not depend on.
  let lastStatus;

  effect({

    events: [ "connection:error", "devices:loaded", "model:loaded" ],
    fn: () => {

      const { mode, status } = store.state;

      // Skip when the status is reference-identical to the one already acted on: this view renders from `mode` and `status`, and `mode` is fixed after model:loaded,
      // so an unchanged status means nothing to redo. The subscription includes `devices:loaded` because the reducer folds its fetch-failure transition into that
      // action - without the subscription the header would never yield to the connection-error view on a failed fetch - and this guard keeps every successful or
      // dropped device outcome from needlessly rebuilding the chain.
      if(status === lastStatus) {

        return;
      }

      lastStatus = status;

      // Yield to the connection-error view when an error is active - that view owns the header content in error states.
      if(status.kind === "connection-error") {

        return;
      }

      // Yield on the "loading" status at mount time. The orchestrator mounts every view before model:loaded fires - so the connection-error view exists to render a
      // sync failure - which means this view's immediate-run pass sees the loading placeholder and must not render the precedence chain against an empty model. The
      // model:loaded dispatch fires this effect again with a ready status, which is when the chain actually renders.
      if(status.kind === "loading") {

        return;
      }

      // Style the header text. The view never reveals its own region: the orchestrator owns region visibility, revealing every populated region together via
      // revealRegions on the success path and the #headerInfo reveal on the no-controllers path. On the connection-error path the connection-error view owns the
      // #headerInfo reveal (it alone has the error content to show). Either way the populated UI appears in one coordinated reveal rather than region-by-region as
      // each view mounts.
      root.style.fontWeight = "bold";

      // Build the precedence chain via DOM nodes rather than innerHTML. The controller hop is conditional, so we assemble children imperatively before handing
      // them to replaceChildren in one mutation.
      const children = [

        "Feature options are applied in prioritized order, from global to device-specific options:",
        createElement("br"),
        createElement("i", { classList: ["text-warning"] }, ["Global options"]),
        " (lowest priority) -> "
      ];

      if(mode === "controller-based") {

        children.push(createElement("i", { classList: ["text-success"] }, ["Controller options"]), " -> ");
      }

      children.push(createElement("i", { classList: ["text-info"] }, ["Device options"]), " (highest priority)");

      root.replaceChildren(...children);
    },
    signal,
    store
  });
};
