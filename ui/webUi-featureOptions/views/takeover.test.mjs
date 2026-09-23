/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/takeover.test.mjs: Unit tests for the takeover view.
 */
"use strict";

import { TAKEOVER_REGION_IDS, mountTakeoverView, releasedTakeover } from "./takeover.mjs";
import { configIndex, projection } from "../selectors.mjs";
import { createSkeletonFeatureOptionsDom, createTestDom } from "../../ui.helpers.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "../../featureOptions.js";

// The catalog the seeding dispatch carries. This view renders from one boolean and reads nothing out of the catalog - an empty index is here only because
// model:loaded refuses a missing one, and because the selector rows below need a real one to derive from.
const CATALOG = () => buildCatalogIndex([], {});

// The regions that frame the content area rather than fill it. A takeover must leave both exactly as it found them, which is what keeps the user's navigation and
// the page's status in place while a card has the area.
const FRAMING_REGION_IDS = [ "headerInfo", "sidebar" ];

// Read every takeover region's inline display back in one shot, so a row asserts on the whole set rather than on whichever region it happened to name.
const regionDisplays = () => TAKEOVER_REGION_IDS.map((id) => document.getElementById(id).style.display);

/* Element presence is asserted as a count and element identity through `assert.ok(a === b, ...)`, never by handing an element to `assert.equal` as a value to be
 * compared. A failing comparison has to render the values it compared, and rendering a Happy-DOM element walks its way out through the document to the window and
 * never finishes...which turns a one-line regression into a suite that hangs instead of one that reports. The count and the boolean render instantly.
 */

// Assembles one test's fixture: the page skeleton, a fresh store carrying a loaded model, and an AbortController standing in for the page cycle's signal. Returns
// the begin function the page itself keeps, alongside the pieces a row needs to dispatch, abort, and read the DOM back. By default the store records the page's
// reveal, as the page does once its boot shows it, which is the page most rows exercise; `revealed: false` keeps the fixture inside the boot window instead.
const setup = ({ revealed = true } = {}) => {

  const skeleton = createSkeletonFeatureOptionsDom();
  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const controller = new AbortController();

  store.dispatch({ catalog: CATALOG(), configuredOptions: [], controllers: [], mode: "device-only", type: "model:loaded" });

  if(revealed) {

    store.dispatch({ type: "page:revealed" });
  }

  const begin = mountTakeoverView({ anchor: skeleton.deviceStatsContainer, signal: controller.signal, store });

  return { abort: () => controller.abort(), begin, skeleton, store };
};

// A plugin's own card: a node the framework never built, so every row that follows it across a takeover is watching the real contract rather than framework markup.
const pluginCard = () => {

  const card = document.createElement("section");

  card.id = "pluginCard";
  card.textContent = "Add a controller";

  return card;
};

describe("mountTakeoverView - beginning a takeover", () => {

  test("mounts the plugin's node in a framework container standing immediately before the first main-content region", () => {

    using dom = createTestDom();

    const { begin, skeleton } = setup();
    const card = pluginCard();
    const handle = begin(card);
    const container = document.querySelector("[data-fo-takeover]");

    assert.ok(container, "the framework builds its own element rather than expecting the plugin to supply one");
    assert.ok(container.firstChild === card, "and mounts the plugin's node inside it");
    assert.ok(skeleton.deviceStatsContainer.previousSibling === container, "the card stands where the main-content regions were, not after them");
    assert.equal(handle.signal.aborted, false, "a takeover that just began is live");
  });

  test("hides exactly the main-content regions and leaves the framing regions untouched", () => {

    using dom = createTestDom();

    const { begin, skeleton } = setup();

    begin(pluginCard());

    assert.deepEqual(regionDisplays(), [ "none", "none", "none" ], "every main-content region steps aside for the card");

    for(const id of FRAMING_REGION_IDS) {

      assert.equal(document.getElementById(id).style.display, "", id + " frames the content area, so a takeover leaves it exactly as it was");
    }

    assert.ok(skeleton.headerInfo, "precondition: the framing regions exist on the page at all");
  });

  test("writes no region display at mount, so a mount inside the page's hidden boot window reveals nothing early", () => {

    using dom = createTestDom();

    /* The page mounts its views while every region is still hidden, and a plugin can take the area over from `onLoaded` before the end-of-load reveal runs. The
     * effect's immediate registration call fires inside the mount, so a write there is only visible when the regions are hidden first - which is exactly what this
     * row arranges before the view is ever built.
     */
    const skeleton = createSkeletonFeatureOptionsDom();
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    for(const id of TAKEOVER_REGION_IDS) {

      document.getElementById(id).style.display = "none";
    }

    mountTakeoverView({ anchor: skeleton.deviceStatsContainer, signal: controller.signal, store });

    assert.deepEqual(regionDisplays(), [ "none", "none", "none" ], "the mount itself writes no display, so the hidden page stays hidden");

    store.dispatch({ origin: "user", scope: { kind: "global" }, type: "scope:changed" });

    assert.deepEqual(regionDisplays(), [ "none", "none", "none" ], "and neither does a selection change that finds no takeover standing");
  });

  test("answers with an already-released handle, and mounts nothing, once the page cycle has ended", () => {

    using dom = createTestDom();

    const { abort, begin } = setup();

    abort();

    const handle = begin(pluginCard());

    assert.equal(handle.signal.aborted, true, "a cycle that has ended has no area to give");
    assert.equal(document.querySelectorAll("[data-fo-takeover]").length, 0, "and nothing is mounted for a cycle that has ended");
    assert.deepEqual(regionDisplays(), [ "", "", "" ], "and no region display is written on that cycle's behalf");
  });
});

describe("mountTakeoverView - releasing a takeover", () => {

  test("release() takes the container out of the page, restores the regions, and aborts the handle's signal", () => {

    using dom = createTestDom();

    const { begin } = setup();
    const handle = begin(pluginCard());

    handle.release();

    assert.equal(document.querySelectorAll("[data-fo-takeover]").length, 0, "the framework element leaves with the takeover");
    assert.deepEqual(regionDisplays(), [ "", "", "" ], "and the page's own content comes back");
    assert.equal(handle.signal.aborted, true, "the handle's signal is how a card learns the area is no longer its own");
  });

  test("a second release() does nothing at all", () => {

    using dom = createTestDom();

    const { begin, store } = setup();
    const handle = begin(pluginCard());
    const dispatched = [];

    handle.release();
    store.addEventListener("takeover:released", () => dispatched.push("takeover:released"));
    handle.release();

    assert.deepEqual(dispatched, [], "a handle with nothing left to give dispatches nothing");
    assert.deepEqual(regionDisplays(), [ "", "", "" ], "and writes nothing over regions the page has already taken back");
  });

  test("the plugin's node survives release detached, so the same card can be mounted again", () => {

    using dom = createTestDom();

    const { begin } = setup();
    const card = pluginCard();

    begin(card).release();

    assert.equal(card.isConnected, false, "the node leaves the page with the container it was mounted in");
    assert.equal(card.textContent, "Add a controller", "with its content intact, because the framework only ever removed it");

    const second = begin(card);

    assert.ok(document.querySelector("[data-fo-takeover]").firstChild === card, "so the plugin can hand the same card back for a second takeover");
    assert.equal(second.signal.aborted, false, "which is a takeover in its own right");
  });

  test("a selection change gives the area back without the plugin writing that rule itself", () => {

    using dom = createTestDom();

    const { begin, store } = setup();
    const handle = begin(pluginCard());

    store.dispatch({ origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.equal(handle.signal.aborted, true, "the content area belongs to the selection, so moving the selection ends the takeover");
    assert.equal(document.querySelectorAll("[data-fo-takeover]").length, 0, "the card leaves the page with it");
    assert.deepEqual(regionDisplays(), [ "", "", "" ], "and the regions come back through the same restore a release runs");
  });
});

describe("mountTakeoverView - a takeover ending inside the boot window", () => {

  // Hide every takeover region the way the boot does for its whole window, so a row can tell a region the view left alone from one it showed.
  const hideRegions = () => {

    for(const id of TAKEOVER_REGION_IDS) {

      document.getElementById(id).style.display = "none";
    }
  };

  test("a release before the page's reveal retires the card and leaves the regions hidden for that reveal", () => {

    using dom = createTestDom();

    const { begin } = setup({ revealed: false });

    hideRegions();

    const handle = begin(pluginCard());

    handle.release();

    assert.equal(handle.signal.aborted, true, "the takeover ended");
    assert.equal(document.querySelectorAll("[data-fo-takeover]").length, 0, "and its card left the page");
    assert.deepEqual(regionDisplays(), [ "none", "none", "none" ], "while the regions wait for the boot's reveal rather than appearing ahead of the page");
  });

  test("a user's move before the page's reveal leaves the regions hidden too", () => {

    using dom = createTestDom();

    const { begin, store } = setup({ revealed: false });

    hideRegions();

    const handle = begin(pluginCard());

    store.dispatch({ origin: "user", scope: { controllerId: "ctrl-a", kind: "controller" }, type: "scope:changed" });

    assert.equal(handle.signal.aborted, true, "the move ended the takeover");
    assert.deepEqual(regionDisplays(), [ "none", "none", "none" ], "and the regions stay the reveal's to show");
  });

  test("once the page's reveal is recorded, a release restores the regions", () => {

    using dom = createTestDom();

    const { begin, store } = setup({ revealed: false });

    hideRegions();

    const handle = begin(pluginCard());

    store.dispatch({ type: "page:revealed" });
    handle.release();

    assert.deepEqual(regionDisplays(), [ "", "", "" ], "the page is up, so the release gives the regions back");
  });
});

describe("mountTakeoverView - one card superseding another", () => {

  test("a second begin ends the first without the regions ever coming back in between, and the store's fact never moves", () => {

    using dom = createTestDom();

    const { begin, store } = setup();
    const started = [];
    const first = begin(pluginCard());
    const firstContainer = document.querySelector("[data-fo-takeover]");

    store.addEventListener("takeover:started", () => started.push("takeover:started"));

    // The supersede runs to completion inside the second begin, so the one place the regions can be read mid-transition is the abort the first handle receives as
    // it is retired. Reading them there is what tells a handover that never uncovers the page from one that blinks it back into view.
    let displaysAtHandover = null;

    first.signal.addEventListener("abort", () => (displaysAtHandover = regionDisplays()), { once: true });

    const second = begin(pluginCard());

    assert.equal(first.signal.aborted, true, "the first card's handle is retired by the card that took its place");
    assert.equal(firstContainer.isConnected, false, "and its container leaves the page");
    assert.deepEqual(displaysAtHandover, [ "none", "none", "none" ], "the area stays taken across the handover - only the occupant changes");
    assert.equal(second.signal.aborted, false, "the second card holds the area");
    assert.equal(document.querySelectorAll("[data-fo-takeover]").length, 1, "with exactly one framework element standing at a time");
    assert.deepEqual(started, [], "and the store's fact never moved off held, so nothing downstream saw a second start");
  });

  test("the superseded handle's release() leaves the card that replaced it standing", () => {

    using dom = createTestDom();

    const { begin } = setup();
    const first = begin(pluginCard());
    const second = begin(pluginCard());

    first.release();

    assert.equal(second.signal.aborted, false, "a handle that no longer names the standing takeover cannot end one it never held");
    assert.ok(document.querySelector("[data-fo-takeover]"), "the second card is still mounted");
    assert.deepEqual(regionDisplays(), [ "none", "none", "none" ], "and the area is still taken");
  });
});

describe("mountTakeoverView - the page cycle ending", () => {

  test("an abort ends the takeover and removes the container, leaving the regions' display exactly as it was", () => {

    using dom = createTestDom();

    const { abort, begin } = setup();
    const handle = begin(pluginCard());

    abort();

    assert.equal(handle.signal.aborted, true, "the takeover ends with the page cycle that carried it");
    assert.equal(document.querySelectorAll("[data-fo-takeover]").length, 0, "and the framework element leaves the page with it");
    assert.deepEqual(regionDisplays(), [ "none", "none", "none" ],
      "the regions are left untouched: the teardown has already hidden them, and the next show() reveals them together");
  });
});

describe("releasedTakeover", () => {

  test("answers a handle that is already released", () => {

    using dom = createTestDom();

    const handle = releasedTakeover();

    assert.equal(handle.signal.aborted, true, "a card wiring its own cleanup to the signal tears itself down at once");
    assert.equal(handle.release(), undefined, "and release() has nothing to do");
  });
});

describe("mountTakeoverView - what a takeover is not", () => {

  test("a takeover cycle leaves every selector cache keyed on the configuration intact", () => {

    using dom = createTestDom();

    const { begin, store } = setup();
    const beforeProjection = projection(store.state);
    const beforeIndex = configIndex(store.state);
    const handle = begin(pluginCard());

    handle.release();

    assert.equal(projection(store.state), beforeProjection, "the page's option projection is derived from the configuration, which a takeover never touches");
    assert.equal(configIndex(store.state), beforeIndex, "and so is the configuration index");
  });
});
