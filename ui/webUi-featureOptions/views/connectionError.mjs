/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/connectionError.mjs: The connection-error state - error message + retry button + progress bar.
 */
"use strict";

import { createElement, delay } from "../utils.mjs";
import { effect } from "../store.mjs";

/**
 * Mount the connection-error view.
 *
 * Subscribes to `connection:error` and `model:loaded`. On `model:loaded` this view yields - it aborts its retry window and stops rendering - and the shared
 * `#headerInfo` container is reclaimed by the header view; it does not itself clear the error display.
 *
 * Renders into the same `#headerInfo` container the priority-chain header uses. The two views coordinate via the `state.status` discriminator: header yields when
 * status is connection-error; this view yields when status is anything else.
 *
 * Renders:
 *
 *   - An error message block with the user-facing message from `state.status.message`.
 *   - A retry button, initially disabled, that becomes enabled after `retryDelayMs` milliseconds. The delay is a brief throttle so the user does not retry-bash a
 *     recovering controller.
 *   - A progress bar that fills during the retry-delay window so the user has visual feedback that the retry button is coming alive.
 *
 * The retry button's click invokes the caller-supplied `onRetry` callback (typically the orchestrator's cleanup + show() sequence).
 *
 * @param {Object} args
 * @param {() => Promise<void>} args.onRetry - Callback invoked when the retry button is clicked. The orchestrator passes its restart routine.
 * @param {number} [args.retryDelayMs=5000] - Milliseconds before the retry button becomes enabled.
 * @param {HTMLElement} args.root - The `#headerInfo` container.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountConnectionErrorView = ({ onRetry, retryDelayMs = 5000, root, signal, store }) => {

  // One active retry-window controller at a time. Aborting the parent signal aborts it; transitioning out of the error state also aborts it so a partially-armed
  // retry button does not linger after the user navigates away.
  let retryAbort = null;

  effect({

    events: [ "connection:error", "model:loaded" ],
    fn: () => {

      const { status } = store.state;

      // Tear down any prior retry window before either rendering a new one or yielding back to the header view.
      retryAbort?.abort();
      retryAbort = null;

      if(status.kind !== "connection-error") {

        return;
      }

      retryAbort = new AbortController();
      renderError({ message: status.message, onRetry, retryDelayMs, retrySignal: retryAbort.signal, root });
    },
    signal,
    store
  });

  // Cleanup on parent abort. The effect's signal handles its own teardown; this ensures the inner retry-window controller is also aborted if it is still active.
  signal.addEventListener("abort", () => {

    retryAbort?.abort();
  }, { once: true });
};

// Render the error block into the root container. Builds the structural pieces (error text, retry button, progress bar) and arms the retry window via the
// supplied retry signal.
const renderError = ({ message, onRetry, retryDelayMs, retrySignal, root }) => {

  const errorBlock = createElement("div", {}, [

    "Unable to connect to the controller.",
    createElement("br"),
    "Check the Settings tab to verify the controller details are correct.",
    createElement("br"),
    createElement("code", { classList: ["text-danger"] }, [message]),
    createElement("br")
  ]);

  const retryButton = createElement("button", {

    classList: [ "btn", "btn-warning", "btn-sm", "mt-3" ],
    textContent: "↻ Retry",
    type: "button"
  });

  retryButton.disabled = true;

  const barWrap = createElement("div", {

    classList: [ "progress", "mt-1", "w-100" ],
    style: { height: "4px" }
  }, [

    createElement("div", {

      classList: ["progress-bar"],
      role: "progressbar",
      style: { transition: "width " + retryDelayMs + "ms linear", width: "0%" }
    })
  ]);

  const retryWrap = createElement("div", { classList: [ "d-inline-block", "w-auto" ] }, [ retryButton, barWrap ]);

  errorBlock.appendChild(retryWrap);
  root.replaceChildren(errorBlock);
  root.style.display = "";

  // Kick the progress bar animation on the next animation frame so the transition has a starting value to interpolate from.
  window.requestAnimationFrame(() => {

    const bar = barWrap.querySelector(".progress-bar");

    if(bar) {

      bar.style.width = "100%";
    }
  });

  // Arm the retry window. The retry button enables after the delay and removes the progress bar; an abort cancels both.
  void armRetry({ barWrap, onRetry, retryButton, retryDelayMs, retrySignal });
};

// Arm the retry button after the configured delay. The button enables, the progress bar removes itself, and a click handler is wired up that invokes the supplied
// onRetry callback. An abort mid-window cancels both the delay and any wired click handler.
const armRetry = async ({ barWrap, onRetry, retryButton, retryDelayMs, retrySignal }) => {

  try {

    await delay(retryDelayMs, retrySignal);
  } catch {

    // Retry window was aborted before completion - either by a state transition out of connection-error or by the parent lifecycle signal. Nothing to clean up;
    // the DOM detaches with the surrounding view.
    return;
  }

  retryButton.disabled = false;
  barWrap.remove();

  retryButton.addEventListener("click", () => {

    retryButton.disabled = true;
    retryButton.textContent = "Retrying...";
    void onRetry();
  }, { once: true, signal: retrySignal });
};
