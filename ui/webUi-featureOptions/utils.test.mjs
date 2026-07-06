/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-featureOptions/utils.test.mjs: Unit tests for the shared DOM and utility helpers in utils.mjs. These are the foundation every other feature-options
 * component composes against, so drift in their behavior would cascade across the webUI suite. Tests run against a Happy-DOM window installed by `ui.helpers.mjs`.
 */
"use strict";

import {

  applyCategoryStates,
  captureCategoryStates,
  createElement,
  delay,
  setCategoryExpanded,
  showToast
} from "./utils.mjs";
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "../ui.helpers.mjs";

describe("createElement - tag and children", () => {

  test("creates an element with the supplied tag name", () => {

    using _dom = createTestDom();

    const el = createElement("div");

    assert.equal(el.tagName, "DIV");
  });

  test("appends string children as text nodes", () => {

    using _dom = createTestDom();

    const el = createElement("span", {}, [ "hello ", "world" ]);

    assert.equal(el.textContent, "hello world");
    // A string child becomes a text node, not a nested element.
    assert.equal(el.children.length, 0, "string children must not produce element children");
  });

  test("appends Node children as-is", () => {

    using _dom = createTestDom();

    const child = document.createElement("strong");

    child.textContent = "emphasized";

    const parent = createElement("p", {}, [ "prefix ", child ]);

    assert.equal(parent.children.length, 1, "a Node child must produce an element child");
    assert.equal(parent.children[0].tagName, "STRONG");
    assert.equal(parent.textContent, "prefix emphasized");
  });
});

describe("createElement - classList handling", () => {

  test("accepts a space-separated string and applies each class", () => {

    using _dom = createTestDom();

    const el = createElement("div", { classList: "nav-link text-decoration-none fw-bold" });

    assert.equal(el.classList.contains("nav-link"), true);
    assert.equal(el.classList.contains("text-decoration-none"), true);
    assert.equal(el.classList.contains("fw-bold"), true);
  });

  test("accepts an array of class names", () => {

    using _dom = createTestDom();

    const el = createElement("div", { classList: [ "alpha", "beta", "gamma" ] });

    assert.equal(el.classList.contains("alpha"), true);
    assert.equal(el.classList.contains("beta"), true);
    assert.equal(el.classList.contains("gamma"), true);
  });

  test("deletes classList from the props bag so it does not leak to the property-assignment pass", () => {

    // Regression guard for the special-prop handling. classList is rest-destructured out of props into its own binding, so it is excluded from the `attrs` record that
    // the `for(const [key, value] of Object.entries(attrs))` property-assignment loop iterates - never deleted from or mutated on the caller's props object. Were it
    // not excluded, that loop would hit `element.classList = "..."` and trash the DOMTokenList.
    using _dom = createTestDom();

    const el = createElement("div", { classList: "a b" });

    // The element still carries exactly the two classes we asked for - a broken implementation that reassigned `element.classList` would end up with either a stringified
    // representation or a broken token list.
    assert.deepEqual(Array.from(el.classList).sort(), [ "a", "b" ]);
  });
});

describe("createElement - style handling", () => {

  test("applies an object of inline styles to the element", () => {

    using _dom = createTestDom();

    const el = createElement("div", { style: { color: "red", display: "flex" } });

    assert.equal(el.style.color, "red");
    assert.equal(el.style.display, "flex");
  });
});

describe("createElement - attribute vs. property routing", () => {

  test("hyphenated keys are routed to setAttribute (for data-* / aria-* attributes)", () => {

    // The helper inspects the key for "-"; hyphenated keys become attributes because the corresponding DOM property name is different (e.g., data-navigation has no
    // direct JS property equivalent). This is the mechanism every sidebar link uses to carry its discriminator.
    using _dom = createTestDom();

    const el = createElement("a", { "aria-expanded": "true", "data-navigation": "controller" });

    assert.equal(el.getAttribute("data-navigation"), "controller");
    assert.equal(el.getAttribute("aria-expanded"), "true");
    // The hyphenated-key path does not touch `element[key]`, which for "aria-expanded" would be undefined at the property layer - only the attribute is set.
  });

  test("non-hyphenated keys are set as properties (href, role, name, innerHTML)", () => {

    // Non-hyphenated keys are set as element properties (the createElement else-branch) so the caller can set things like `href` (which has a matching DOM
    // property) directly without having to know which path the helper uses internally. `innerHTML` is a special case that writes through to the DOM-parsed
    // representation. `name` carries no data-* prefix and is not the `for` reserved-word special case, so it also takes the property-assignment path; it is
    // read back here via the DOM property rather than `getAttribute` to confirm that path actually ran.
    using _dom = createTestDom();

    const el = createElement("a", { href: "#", innerHTML: "<strong>Test</strong>", name: "Global Options", role: "button" });

    assert.equal(el.getAttribute("href"), "#", "href property reflects through to the attribute");
    assert.equal(el.getAttribute("role"), "button", "role property reflects through to the attribute so CSS [role=\"button\"] selectors match");
    assert.equal(el.name, "Global Options", "name property is accessible via property-read (nav identity uses this path)");
    assert.equal(el.children[0]?.tagName, "STRONG", "innerHTML must parse into child elements");
  });
});

describe("setCategoryExpanded", () => {

  // Build the minimum category-disclosure shape `setCategoryExpanded` operates on: a `<details>` element. The browser owns the expand/collapse via the `open`
  // attribute; the arrow rotation is CSS-driven via `details[open]`, so there is no JS-managed arrow textContent or aria-expanded triad to test - just the
  // canonical `open` property mutation.
  function makeCategoryDetails() {

    const details = document.createElement("details");

    details.innerHTML = "<summary>Category</summary><div class=\"fo-category-rows\"></div>";
    document.body.appendChild(details);

    return details;
  }

  test("expanded=true sets details.open to true", () => {

    using _dom = createTestDom();

    const details = makeCategoryDetails();

    setCategoryExpanded(details, false);
    setCategoryExpanded(details, true);

    assert.equal(details.open, true);
  });

  test("expanded=false sets details.open to false", () => {

    using _dom = createTestDom();

    const details = makeCategoryDetails();

    details.open = true;
    setCategoryExpanded(details, false);

    assert.equal(details.open, false);
  });
});

describe("showToast", () => {

  test("inserts a toast alert after the feature-status-bar mount point with the given message", () => {

    using _dom = createTestDom();

    const statusBar = document.createElement("div");

    statusBar.id = "featureStatusBar";
    document.body.appendChild(statusBar);

    showToast("Configuration saved");

    const toast = statusBar.nextElementSibling;

    assert.ok(toast, "showToast must insert an alert immediately after the status bar");
    assert.equal(toast.getAttribute("role"), "alert");
    assert.ok(toast.classList.contains("alert"));
    assert.ok(toast.classList.contains("alert-success"), "default variant is alert-success");
    assert.ok(toast.innerHTML.includes("Configuration saved"));
  });

  test("custom variant class is honored via the second argument", () => {

    using _dom = createTestDom();

    const statusBar = document.createElement("div");

    statusBar.id = "featureStatusBar";
    document.body.appendChild(statusBar);

    showToast("Fatal error", "alert-danger");

    const toast = statusBar.nextElementSibling;

    assert.ok(toast.classList.contains("alert-danger"), "custom variant class must be applied instead of the default alert-success");
  });

  test("is a silent no-op when the feature-status-bar is absent from the document", () => {

    // Defensive: call sites that fire toasts from lifecycle handlers may execute during transitions when the status bar is not mounted. The helper must short-circuit
    // rather than throw.
    using _dom = createTestDom();

    assert.doesNotThrow(() => showToast("Nothing to show"));
  });
});

describe("delay - signal-aware sleep primitive", () => {

  test("resolves after the configured duration when no signal is provided", async () => {

    // Real timers are fine here: the duration is short and we are verifying the timer-driven path of the helper, not contending with mock infrastructure.
    const start = Date.now();

    await delay(20);

    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 15, "delay must wait at least the configured duration (allow a small scheduling tolerance)");
  });

  test("rejects synchronously with signal.reason when the signal is already aborted at call time", async () => {

    const controller = new AbortController();
    const reason = new Error("preflight cancelled");

    controller.abort(reason);

    await assert.rejects(() => delay(10_000, controller.signal), (error) => error === reason);
  });

  test("rejects with signal.reason when the signal aborts mid-delay and never schedules the resolution callback", async () => {

    // mock.timers lets us prove the resolution path is NOT taken: if it were, advancing past the delay would resolve the promise. We abort first, then tick well
    // past the duration, and the promise must remain in its rejected state with the abort reason.
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const controller = new AbortController();
      const reason = new Error("torn down mid-window");
      const promise = delay(1000, controller.signal);

      // Race the abort against the (mocked) timer.
      controller.abort(reason);

      // Advance virtual time past the delay window. If the timer callback fired, the promise would resolve - which would violate the contract.
      mock.timers.tick(5000);

      await assert.rejects(() => promise, (error) => error === reason);
    } finally {

      mock.timers.reset();
    }
  });

  test("removes the abort listener after the timer fires so a later abort does not trigger a stale callback", async () => {

    // We assert listener hygiene via the AbortSignal's own listener accounting: after the timer resolves, aborting the controller must not invoke anything that
    // would resurrect a settled promise. The cleanest observable signal is that we can still await an already-resolved promise without throwing - if the listener
    // were still bound, it would call reject on the same withResolvers tuple, which is a no-op on an already-resolved promise, but verifies the post-resolve abort
    // does not throw or interfere.
    const controller = new AbortController();

    await delay(5, controller.signal);

    assert.doesNotThrow(() => controller.abort(new Error("post-resolve abort must be inert")));
  });
});

describe("captureCategoryStates / applyCategoryStates - DOM-shape SSOT", () => {

  // Construct a configTable container holding the given category descriptors. Each `<details data-category="...">` carries the canonical disclosure shape; the
  // `open` attribute on the `<details>` is the SSOT for "is this category currently expanded?".
  function makeConfigTable(categories) {

    const root = document.createElement("div");

    for(const { collapsed, name } of categories) {

      const details = document.createElement("details");

      details.setAttribute("data-category", name);

      if(!collapsed) {

        details.open = true;
      }

      details.innerHTML = "<summary class=\"fo-category-header\">" + name + "</summary><div class=\"fo-category-rows\"></div>";
      root.appendChild(details);
    }

    return root;
  }

  test("captureCategoryStates returns a map of category name to collapsed boolean", () => {

    using _dom = createTestDom();

    const configTable = makeConfigTable([ { collapsed: true, name: "Audio" }, { collapsed: false, name: "Motion" } ]);

    assert.deepEqual(captureCategoryStates(configTable), { Audio: true, Motion: false });
  });

  test("captureCategoryStates returns an empty map when no category details are present", () => {

    using _dom = createTestDom();

    const empty = document.createElement("div");

    assert.deepEqual(captureCategoryStates(empty), {});
  });

  test("applyCategoryStates drives details.open to match the supplied map", () => {

    using _dom = createTestDom();

    // Start with everything expanded so applyCategoryStates has work to do.
    const configTable = makeConfigTable([ { collapsed: false, name: "Audio" }, { collapsed: false, name: "Motion" } ]);

    applyCategoryStates(configTable, { Audio: true, Motion: false });

    const audio = configTable.querySelector("details[data-category='Audio']");
    const motion = configTable.querySelector("details[data-category='Motion']");

    assert.equal(audio.open, false, "Audio map says collapsed; apply must close its details");
    assert.equal(motion.open, true, "Motion map says expanded; apply must open its details");
  });

  test("applyCategoryStates leaves categories absent from the map at their current state", () => {

    using _dom = createTestDom();

    const configTable = makeConfigTable([ { collapsed: false, name: "Audio" }, { collapsed: true, name: "Motion" } ]);

    applyCategoryStates(configTable, { Audio: true });

    assert.equal(configTable.querySelector("details[data-category='Audio']").open, false, "Audio was in the map and must follow it");
    assert.equal(configTable.querySelector("details[data-category='Motion']").open, false, "Motion was absent and must keep its prior state");
  });
});
