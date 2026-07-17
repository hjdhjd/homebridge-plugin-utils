/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/connectionError.test.mjs: Unit tests for the connection-error view.
 */
"use strict";

import { createTestDom, waitFor } from "../../ui.helpers.mjs";
import { describe, test } from "node:test";
import { initialState, reducer } from "../state.mjs";
import { FeatureOptionsStore } from "../store.mjs";
import assert from "node:assert/strict";
import { mountConnectionErrorView } from "./connectionError.mjs";

const setup = ({ onRetry = () => {}, retryDelayMs = 50 } = {}) => {

  const store = new FeatureOptionsStore({ initialState: initialState(), reducer });
  const root = document.createElement("div");
  const controller = new AbortController();

  document.body.appendChild(root);

  mountConnectionErrorView({ onRetry, retryDelayMs, root, signal: controller.signal, store });

  return { abort: () => controller.abort(), root, store };
};

describe("mountConnectionErrorView - inactive state", () => {

  test("does not render anything before a connection:error dispatch", () => {

    using _dom = createTestDom();

    const { root } = setup();

    assert.equal(root.textContent, "");
  });
});

describe("mountConnectionErrorView - error rendering", () => {

  test("renders the error block with the message from state.status.message", () => {

    using _dom = createTestDom();

    const { root, store } = setup();

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.",
      message: "Controller unreachable.", type: "connection:error" });

    assert.match(root.textContent, /Unable to connect to the controller/);
    assert.match(root.textContent, /Controller unreachable\./);
    assert.ok(root.querySelector("button"), "retry button rendered");
    assert.equal(root.querySelector("button").disabled, true, "retry button starts disabled");
    assert.ok(root.querySelector(".progress-bar"), "progress bar rendered");
  });

  test("the retry button enables after the configured delay", async () => {

    using _dom = createTestDom();

    const { root, store } = setup({ retryDelayMs: 30 });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.", message: "down",
      type: "connection:error" });

    await waitFor(() => root.querySelector("button")?.disabled === false, { message: "retry button to enable", timeout: 500 });

    assert.equal(root.querySelector("button").disabled, false);
    assert.equal(root.querySelector(".progress"), null, "progress bar removed once retry is armed");
  });

  test("clicking the armed retry button invokes the onRetry callback", async () => {

    using _dom = createTestDom();

    let retryFired = false;
    const onRetry = async () => { retryFired = true; };
    const { root, store } = setup({ onRetry, retryDelayMs: 20 });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.", message: "down",
      type: "connection:error" });

    const retryBtn = await waitFor(() => {

      const btn = root.querySelector("button");

      return (btn && !btn.disabled) ? btn : null;
    }, { message: "armed retry button", timeout: 500 });

    retryBtn.click();

    assert.equal(retryFired, true);
    assert.match(retryBtn.textContent, /Retrying/);
  });
});

describe("mountConnectionErrorView - lifecycle", () => {

  test("aborting the page signal mid-arm cancels the retry window", async () => {

    using _dom = createTestDom();

    const { abort, root, store } = setup({ retryDelayMs: 500 });

    store.dispatch({ guidance: "Check the Settings tab to verify the controller details are correct.", headline: "Unable to connect to the controller.", message: "down",
      type: "connection:error" });

    abort();

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(root.querySelector("button")?.disabled, true, "retry button never armed because the parent signal aborted");
  });
});
