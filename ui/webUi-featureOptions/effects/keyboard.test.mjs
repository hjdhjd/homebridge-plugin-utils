/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/effects/keyboard.test.mjs: Unit tests for the keyboard-shortcuts effect.
 */
"use strict";

import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { createTestDom } from "../../ui.helpers.mjs";
import { registerKeyboardEffect } from "./keyboard.mjs";

// Build the bare DOM the keyboard effect probes: a #search panel (with display state) and a #searchInput inside it.
const setupDom = ({ searchPanelVisible = true } = {}) => {

  const panel = document.createElement("div");

  panel.id = "search";

  if(!searchPanelVisible) {

    panel.style.display = "none";
  }

  const input = document.createElement("input");

  input.id = "searchInput";
  panel.appendChild(input);
  document.body.appendChild(panel);

  return { input, panel };
};

describe("registerKeyboardEffect - Cmd/Ctrl + F focuses the search input", () => {

  test("focuses and selects the search input when the panel is visible", () => {

    using _dom = createTestDom();

    const { input } = setupDom();
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    registerKeyboardEffect({ signal: controller.signal, store });

    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "f", metaKey: true });
    let defaultPrevented = false;

    Object.defineProperty(event, "preventDefault", { value: () => { defaultPrevented = true; } });
    document.dispatchEvent(event);

    assert.ok(document.activeElement === input, "the search input must receive focus after Cmd+F");
    assert.equal(defaultPrevented, true, "browser's native find is preempted");
  });

  test("does not act when the search panel is hidden", () => {

    using _dom = createTestDom();

    setupDom({ searchPanelVisible: false });
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    registerKeyboardEffect({ signal: controller.signal, store });

    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "f", metaKey: true });
    let defaultPrevented = false;

    Object.defineProperty(event, "preventDefault", { value: () => { defaultPrevented = true; } });
    document.dispatchEvent(event);

    assert.equal(defaultPrevented, false, "default not preempted - browser's native find handles it");
  });
});

describe("registerKeyboardEffect - Escape on the search input dispatches filter:changed", () => {

  test("clears the input value and dispatches filter:changed with an empty query", () => {

    using _dom = createTestDom();

    const { input } = setupDom();
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    input.value = "motion";

    let dispatched;

    store.addEventListener("filter:changed", (event) => { dispatched = event.detail; });

    registerKeyboardEffect({ signal: controller.signal, store });

    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });

    input.dispatchEvent(event);

    assert.equal(input.value, "");
    assert.deepEqual(dispatched, { query: "", type: "filter:changed" });
  });

  test("does not act when Escape is pressed outside the search input", () => {

    using _dom = createTestDom();

    setupDom();

    const otherInput = document.createElement("input");

    otherInput.id = "otherInput";
    document.body.appendChild(otherInput);

    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    let dispatched = false;

    store.addEventListener("filter:changed", () => { dispatched = true; });

    registerKeyboardEffect({ signal: controller.signal, store });

    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });

    otherInput.dispatchEvent(event);

    assert.equal(dispatched, false, "Escape on a non-search input is ignored");
  });
});

describe("registerKeyboardEffect - lifecycle", () => {

  test("aborting the signal removes the keyboard listener", () => {

    using _dom = createTestDom();

    const { input } = setupDom();
    const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
    const controller = new AbortController();

    registerKeyboardEffect({ signal: controller.signal, store });

    controller.abort();

    let dispatched = false;

    store.addEventListener("filter:changed", () => { dispatched = true; });

    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });

    input.value = "motion";
    input.dispatchEvent(event);

    assert.equal(dispatched, false, "post-abort, listener is gone");
  });
});
