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
 * Runs on `model:loaded` and `connection:error`; all other dispatches never invoke it because they are not subscribed. On `connection:error` (and the loading
 * status), `fn` yields inside its `status.kind` checks. In practice the header content is rendered once, at `model:loaded`. The connection-error and no-controllers
 * views render their own content into the same container, so this view yields when the status indicates either of those states.
 *
 * @param {Object} args
 * @param {HTMLElement} args.root - The `#headerInfo` container.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountHeaderView = ({ root, signal, store }) => {

  effect({

    events: [ "model:loaded", "connection:error" ],
    fn: () => {

      const { mode, status } = store.state;

      // Yield to the connection-error view when an error is active - that view owns the header content in error states.
      if(status.kind === "connection-error") {

        return;
      }

      // Defensive guard against a "loading" status at mount time. In the current call order this branch is unreachable: the no-controllers path returns from
      // show() before any views mount, and the success path dispatches model:loaded - which sets status to ready - before mountHeaderView runs. The check stays
      // in place as a safeguard against a future reordering that mounts views before model:loaded fires.
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
