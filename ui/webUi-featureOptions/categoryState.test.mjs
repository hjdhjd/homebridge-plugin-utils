/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-featureOptions/categoryState.test.mjs: Unit tests for FeatureOptionsCategoryState - the per-context UI-state store the orchestrator delegates to. The
 * store is intentionally DOM-agnostic; tests exercise the get/set/load/persist lifecycle, the storage-key shape, and the silent-failure semantics on broken read
 * AND write paths. DOM walking (captureCategoryStates / applyCategoryStates) lives in utils and is tested separately there.
 */
"use strict";

import { describe, mock, test } from "node:test";
import { FeatureOptionsCategoryState } from "./categoryState.mjs";
import assert from "node:assert/strict";
import { createTestDom } from "../ui.helpers.mjs";

describe("FeatureOptionsCategoryState - get / set round-trip", () => {

  test("set persists the supplied state under the context key and get returns it back unchanged", () => {

    using _dom = createTestDom();
    window.localStorage.clear();

    const store = new FeatureOptionsCategoryState("TestPlugin");
    const states = { Audio: true, Motion: false };

    store.set("DEV-001", states);

    assert.deepEqual(store.get("DEV-001"), states);
  });

  test("set writes through to localStorage immediately under the canonical storage key", () => {

    using _dom = createTestDom();
    window.localStorage.clear();

    const store = new FeatureOptionsCategoryState("TestPlugin");

    store.set("DEV-001", { Audio: true });

    // We assert against the disk projection rather than the in-memory map - the projection is the SSOT for cross-session state and is what callers depend on.
    const persisted = JSON.parse(window.localStorage.getItem("homebridge-TestPlugin-category-states"));

    assert.deepEqual(persisted, { "DEV-001": { Audio: true } });
  });

  test("a set/get cycle through a fresh instance round-trips state across reconstruction", () => {

    // Verifies the localStorage projection is genuinely the cross-session SSOT: a new instance loads the same map the prior instance persisted, without sharing
    // any in-memory state.
    using _dom = createTestDom();
    window.localStorage.clear();

    const writer = new FeatureOptionsCategoryState("TestPlugin");

    writer.set("DEV-001", { Motion: true });

    const reader = new FeatureOptionsCategoryState("TestPlugin");

    assert.deepEqual(reader.get("DEV-001"), { Motion: true });
  });

  test("get returns undefined for an unknown context key", () => {

    using _dom = createTestDom();
    window.localStorage.clear();

    const store = new FeatureOptionsCategoryState("TestPlugin");

    assert.equal(store.get("NEVER-SEEN"), undefined);
  });
});

describe("FeatureOptionsCategoryState - delete", () => {

  test("delete removes the entry under the given context key from both memory and the disk projection", () => {

    using _dom = createTestDom();
    window.localStorage.clear();

    const store = new FeatureOptionsCategoryState("TestPlugin");

    store.set("DEV-001", { Motion: true });
    store.set("DEV-002", { Motion: false });
    store.delete("DEV-001");

    assert.equal(store.get("DEV-001"), undefined, "the removed key returns undefined from the in-memory map");

    const persisted = JSON.parse(window.localStorage.getItem("homebridge-TestPlugin-category-states"));

    assert.deepEqual(persisted, { "DEV-002": { Motion: false } }, "the disk projection drops the removed key but keeps others intact");
  });

  test("delete is a no-op for an absent key and does not touch the disk projection", () => {

    // Verifies the no-op path takes no persistence cost - we assert that setItem was never called for the absent-key removal. Otherwise a sweep over many absent
    // keys would write the same unchanged map to localStorage N times.
    using _dom = createTestDom();
    window.localStorage.clear();

    const store = new FeatureOptionsCategoryState("TestPlugin");

    store.set("DEV-001", { Motion: true });

    const setItemMock = mock.method(window.localStorage, "setItem", window.localStorage.setItem.bind(window.localStorage));

    try {

      store.delete("NEVER-SEEN");

      assert.equal(setItemMock.mock.callCount(), 0, "the absent-key removal must not trigger any persistence write");
      assert.deepEqual(store.get("DEV-001"), { Motion: true }, "unrelated entries remain intact");
    } finally {

      setItemMock.mock.restore();
    }
  });

  test("a delete after a set/get cycle survives reconstruction (the removal lands on disk)", () => {

    using _dom = createTestDom();
    window.localStorage.clear();

    const writer = new FeatureOptionsCategoryState("TestPlugin");

    writer.set("DEV-001", { Motion: true });
    writer.delete("DEV-001");

    const reader = new FeatureOptionsCategoryState("TestPlugin");

    assert.equal(reader.get("DEV-001"), undefined, "a fresh instance must reflect the removal - the deletion was persisted, not just held in memory");
  });
});

describe("FeatureOptionsCategoryState - resilience to broken storage", () => {

  test("constructor falls back to an empty map when localStorage contains malformed JSON", () => {

    // The cache is a UI ergonomic - corruption must not wedge the orchestrator. We seed the storage key with garbage and assert the instance is still usable for
    // subsequent set() calls.
    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem("homebridge-TestPlugin-category-states", "{ this is not json");

    const store = new FeatureOptionsCategoryState("TestPlugin");

    assert.equal(store.get("DEV-001"), undefined, "the recovered map is empty - the corrupt entry yielded no usable state");
    assert.doesNotThrow(() => store.set("DEV-001", { Motion: true }), "after recovering, set() must succeed against the freshly-emptied map");

    const persisted = JSON.parse(window.localStorage.getItem("homebridge-TestPlugin-category-states"));

    assert.deepEqual(persisted, { "DEV-001": { Motion: true } }, "the new set() must overwrite the corrupt entry with a valid one");
  });

  test("constructor falls back to an empty map when localStorage contains valid JSON of the wrong shape (null)", () => {

    // `JSON.parse("null")` succeeds and yields `null`, which would otherwise wedge the in-memory map on a non-indexable value - subsequent get/set against
    // `this.#map[contextKey]` would crash with "cannot read/set properties of null". The shape guard in #load resets to {} so the cache stays usable.
    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem("homebridge-TestPlugin-category-states", "null");

    const store = new FeatureOptionsCategoryState("TestPlugin");

    assert.equal(store.get("DEV-001"), undefined, "the null payload yielded an empty map - get() must return undefined for any key");
    assert.doesNotThrow(() => store.set("DEV-001", { Motion: true }), "set() must succeed against the recovered empty map");
    assert.deepEqual(store.get("DEV-001"), { Motion: true });
  });

  test("constructor falls back to an empty map when localStorage contains valid JSON of the wrong shape (array)", () => {

    // `JSON.parse("[]")` succeeds and yields an array. While arrays ARE indexable (so a crash is less obvious), they would round-trip incorrectly through
    // subsequent JSON.stringify and lose the array semantics on the next reconstruction. The shape guard rejects arrays so the cache stays a plain object.
    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem("homebridge-TestPlugin-category-states", "[\"unexpected\", \"array\"]");

    const store = new FeatureOptionsCategoryState("TestPlugin");

    assert.equal(store.get("DEV-001"), undefined, "the array payload yielded an empty map - get() must return undefined for any key");
    assert.doesNotThrow(() => store.set("DEV-001", { Motion: true }), "set() must succeed against the recovered empty map");

    const persisted = JSON.parse(window.localStorage.getItem("homebridge-TestPlugin-category-states"));

    assert.ok(persisted && (typeof persisted === "object") && !Array.isArray(persisted),
      "the persisted shape must be a plain object - the array payload was discarded, not augmented");
    assert.deepEqual(persisted, { "DEV-001": { Motion: true } });
  });

  test("constructor falls back to an empty map when localStorage contains a JSON primitive", () => {

    // The full primitive surface (`"42"`, `"\"string\""`, `"true"`) also passes JSON.parse but is not a plain object. The shape guard treats all primitives the
    // same: reset to {}, let the UI continue.
    using _dom = createTestDom();
    window.localStorage.clear();
    window.localStorage.setItem("homebridge-TestPlugin-category-states", "42");

    const store = new FeatureOptionsCategoryState("TestPlugin");

    assert.equal(store.get("DEV-001"), undefined, "the primitive payload yielded an empty map");
    assert.doesNotThrow(() => store.set("DEV-001", { Motion: true }), "set() must succeed against the recovered empty map");
  });

  test("set silently swallows localStorage.setItem failures (quota exceeded / storage unavailable)", () => {

    // Persistence is best-effort; the canonical config is unaffected. We stub setItem to throw a QuotaExceededError-shaped error and assert set() does not propagate
    // it. The in-memory map still updates so subsequent get() against the same instance returns the value - it's only the disk projection that lost the write.
    using _dom = createTestDom();
    window.localStorage.clear();

    const store = new FeatureOptionsCategoryState("TestPlugin");
    const setItemMock = mock.method(window.localStorage, "setItem", () => {

      throw new Error("QuotaExceededError: localStorage write capacity exhausted");
    });

    try {

      assert.doesNotThrow(() => store.set("DEV-001", { Motion: true }), "set() must not propagate the underlying storage failure");
      assert.deepEqual(store.get("DEV-001"), { Motion: true }, "the in-memory map still updates - only the disk projection is lost");
      assert.equal(setItemMock.mock.callCount(), 1, "exactly one persistence attempt was made");
    } finally {

      setItemMock.mock.restore();
    }
  });
});

describe("FeatureOptionsCategoryState - storage key shape", () => {

  test("namespaces by platform identifier so plugins in a multi-plugin install do not collide", () => {

    using _dom = createTestDom();
    window.localStorage.clear();

    const a = new FeatureOptionsCategoryState("PluginA");
    const b = new FeatureOptionsCategoryState("PluginB");

    a.set("DEV-001", { Motion: true });
    b.set("DEV-001", { Motion: false });

    assert.deepEqual(JSON.parse(window.localStorage.getItem("homebridge-PluginA-category-states")), { "DEV-001": { Motion: true } });
    assert.deepEqual(JSON.parse(window.localStorage.getItem("homebridge-PluginB-category-states")), { "DEV-001": { Motion: false } });
  });

  test("falls back to a generic suffix when no platform is supplied", () => {

    // Defensive fallback so plugin configs that pre-date platform-keyed storage still get a working (if non-isolated) cache.
    using _dom = createTestDom();
    window.localStorage.clear();

    const store = new FeatureOptionsCategoryState(undefined);

    store.set("DEV-001", { Motion: true });

    assert.ok(window.localStorage.getItem("homebridge-plugin-category-states"),
      "absence of a platform identifier must still produce a working storage key, namespaced under \"plugin\"");
  });
});
