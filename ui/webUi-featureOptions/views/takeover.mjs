/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/takeover.mjs: The takeover state - a plugin's own node standing in the page's main-content area.
 */
"use strict";

import { createElement } from "../utils.mjs";
import { effect } from "../store.mjs";

// The main-content regions a takeover hides, in alphabetical id order. The header bar and the device sidebar are deliberately outside the set: they frame the content
// area rather than fill it, so a plugin's card occupies what the page's own content occupied while the user's navigation and the page's status stay exactly where
// they were. The page composes its full region list from this one, so the two can never come to name different regions.
export const TAKEOVER_REGION_IDS = [ "deviceStatsContainer", "optionsContainer", "search" ];

/**
 * Mount the takeover view.
 *
 * Subscribes to `scope:changed`, `takeover:released`, and `takeover:started`, and owns for the life of the mount both the framework element a plugin's node is
 * mounted inside and the main-content regions' `display` while a takeover stands. The page's own writers of those regions - the teardown hide and
 * the coordinated end-of-load reveal - stay out of a standing takeover's way, the reveal by reading the same store fact this view renders from.
 *
 * The fact of a takeover is store state while the node is DOM, and the two live apart deliberately. `state.takeover` is the one answer to "is the area held", so the
 * reducer can give the area back on a selection change while knowing nothing about any node, and the element, its container, and their removal stay here where DOM
 * belongs. The effect below is the only place the restore is written, so a plugin's own release, a selection change, and a card that supersedes another all hand the
 * regions back along one path rather than each along its own.
 *
 * Returns the one function the page keeps: call it with the plugin's element to take the area, and it answers with the handle. A call made while a takeover already
 * stands ends that one and takes its place without restoring the regions in between, so the area passes from one card to the next with no flash of the page
 * underneath.
 *
 * Teardown writes no region display, and the reason is the whole of why this view can be torn down by a bare signal. A page cycle ends either through `hide()`,
 * which has already hidden every region and whose next show() reveals them together, or as a page copy a successor superseded, where the window belongs to that
 * successor and a display write from the retired copy would blank or un-blank regions the successor has already rendered into. Removing this mount's own container
 * is safe for the same reason it is necessary: the successor never looks for it.
 *
 * @param {Object} args
 * @param {HTMLElement} args.anchor - The `#deviceStatsContainer` element, the first main-content region in the page's markup. The framework's takeover element is
 *                                    inserted immediately before it, so a card stands where the regions it hides would have been.
 * @param {AbortSignal} args.signal - Lifecycle signal. Its abort ends whatever takeover is standing.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 * @returns {(element: HTMLElement) => { release: () => void, signal: AbortSignal }} The function that begins a takeover, answering with the plugin's handle.
 */
export const mountTakeoverView = ({ anchor, signal, store }) => {

  // The standing takeover - its abort controller and the framework element holding the plugin's node - or null while the page holds its own content area. The whole
  // of this view's per-mount state: everything else about a takeover is either the store's fact or the DOM's own.
  let current = null;

  // The `state.takeover` value this view has already rendered, which starts at whatever the store holds because mounting arranges nothing. The effect's immediate
  // registration call therefore finds nothing changed and writes no display at all, which is what keeps a mount during the page's hidden boot window from revealing
  // the regions ahead of the end-of-load reveal. Every later run that does not move the value - a `scope:changed` with no takeover standing - is skipped the same way.
  let lastTakeover = store.state.takeover;

  /* End the standing takeover: abort its handle's signal, take the framework element out of the page, and forget it. The plugin's node leaves with the container and
   * remains the plugin's own, to mount again or discard.
   *
   * No region display is written here. Restoring the regions belongs to the effect below, which reaches this only when the store says the area came back...so a card
   * superseding another, and a page teardown, both end a takeover without writing regions that are not theirs to write.
   */
  const end = () => {

    if(!current) {

      return;
    }

    current.controller.abort();
    current.container.remove();
    current = null;
  };

  effect({

    events: [ "scope:changed", "takeover:released", "takeover:started" ],
    fn: () => {

      const { takeover } = store.state;

      // Who holds the area did not move, so there is no DOM work to do. This is what makes the registration call and every selection change that finds no takeover
      // standing cost nothing but the comparison.
      if(takeover === lastTakeover) {

        return;
      }

      lastTakeover = takeover;

      if(takeover) {

        setRegionDisplay("none");

        return;
      }

      // The area came back to the page: retire whatever was standing in it, then give the regions their display back. A `scope:changed` arrives here too, which is
      // how a plugin's card closes when the user moves the selection without any plugin writing that rule for itself.
      end();
      setRegionDisplay("");
    },
    signal,
    store
  });

  // The page cycle ending ends the takeover with it - see the teardown rule above for why the regions are left exactly as they are.
  signal.addEventListener("abort", end, { once: true });

  return (element) => {

    // A cycle that has already ended has no area to give, so answer with a handle that reads as released rather than mounting into a page this copy no longer owns.
    if(signal.aborted) {

      return releasedTakeover();
    }

    /* Latest call wins. Ending the standing takeover directly rather than through the store leaves the regions hidden and dispatches nothing, so the area passes
     * straight from one card to the next: the first card's signal aborts, its container leaves the page, and the store's fact never moves off "held".
     */
    end();

    const controller = new AbortController();
    const container = createElement("div", { "data-fo-takeover": "" }, [element]);

    anchor.parentNode.insertBefore(container, anchor);
    current = { container, controller };

    // A call that superseded a standing takeover found the regions already hidden and the store already saying so, which is exactly the case this guard answers: the
    // dispatch is what a fresh takeover needs and what a replacement does not.
    if(!store.state.takeover) {

      store.dispatch({ type: "takeover:started" });
    }

    return {

      // Give the area back. A handle whose signal has aborted has nothing left to give - a later card superseded it, it was released already, or it retired with the
      // page cycle - so it returns rather than releasing a takeover it no longer names. Otherwise the store's release drives the effect above, which ends this
      // takeover and restores the regions before the dispatch returns.
      release: () => {

        if(controller.signal.aborted) {

          return;
        }

        store.dispatch({ type: "takeover:released" });
      },

      signal: controller.signal
    };
  };
};

/**
 * Build the handle for a takeover that never began.
 *
 * `release()` does nothing and `signal` is already aborted, so a card that wires its own cleanup to the signal tears itself down at once, and a card that asks the
 * handle whether it still holds the area is told the truth. This is what the page answers with when there is no live cycle behind the call, which is what lets a
 * consumer call for the area without first asking whether the page is up.
 *
 * @returns {{ release: () => void, signal: AbortSignal }} A handle that is already released.
 */
export const releasedTakeover = () => {

  return { release: () => {}, signal: AbortSignal.abort() };
};

// Write one display value across every main-content region a takeover covers, skipping any the consumer's markup does not carry. The single writer of those regions
// for the whole of a takeover: the hide and the restore differ only in the value they pass, so neither can reach a region the other misses.
const setRegionDisplay = (display) => {

  for(const id of TAKEOVER_REGION_IDS) {

    const element = document.getElementById(id);

    if(element) {

      element.style.display = display;
    }
  }
};
