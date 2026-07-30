/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * suppressed-error.test.ts: Unit tests for the in-package SuppressedError constructor - the runtime duality proof that BOTH `new SuppressedError(...)` and a bare
 * `SuppressedError(...)` construct (the half of the contract the definition site's type assertion cannot check), field carriage, the Error prototype wiring, message
 * defaulting, and a differential oracle against the platform global.
 */
import { describe, test } from "node:test";
import { SuppressedError } from "./suppressed-error.ts";
import assert from "node:assert/strict";

// Render an instance's own properties as sorted "name: flags" strings, excluding `stack` (whose value records the construction site and differs by definition between
// two constructions). Comparing the ATTRIBUTE FLAGS, not merely the values, is what makes the oracle catch a payload attached by plain assignment: the spec's `error`
// and `suppressed` are non-enumerable data properties, and an enumerable stand-in carries the same value while behaving differently everywhere a structural walk runs.
function ownPropertyShape(instance: object): string[] {

  return Object.entries(Object.getOwnPropertyDescriptors(instance)).filter(([key]) => key !== "stack").map(([ key, descriptor ]) => key + ": configurable=" +
    String(descriptor.configurable) + " enumerable=" + String(descriptor.enumerable) + " writable=" + String(descriptor.writable)).sort();
}

// Extract the observable shape of a constructed instance so two call forms, or the in-package constructor and the platform global, can be compared on equal terms.
function shapeOf(thrown: unknown): { error: unknown; isError: boolean; message: string; name: string; ownProperties: string[]; suppressed: unknown } {

  const instance = thrown as Error & { error: unknown; suppressed: unknown };

  return {

    error: instance.error,
    isError: instance instanceof Error,
    message: instance.message,
    name: instance.name,
    ownProperties: ownPropertyShape(instance),
    suppressed: instance.suppressed
  };
}

describe("SuppressedError - construction duality", () => {

  test("`new` construction carries the failures, the name, and the Error prototype", () => {

    const newest = new Error("newest");
    const accumulated = new Error("accumulated");
    const chained = new SuppressedError(newest, accumulated);

    assert.ok(chained instanceof SuppressedError, "the instance is a SuppressedError");
    assert.ok(chained instanceof Error, "the instance is an Error through the wired prototype chain");
    assert.equal(chained.name, "SuppressedError");
    assert.equal(chained.error, newest, "the newest failure travels as `error`");
    assert.equal(chained.suppressed, accumulated, "the superseded failure travels as `suppressed`");
  });

  test("a bare call constructs exactly as `new` does", () => {

    const newest = new Error("newest");
    const accumulated = new Error("accumulated");

    // The bare call is the half of the platform contract an ES class cannot satisfy, and the half the definition site's type assertion cannot check. This is where it
    // is proven.
    const chained = SuppressedError(newest, accumulated);

    assert.ok(chained instanceof SuppressedError, "a bare call still produces a SuppressedError");
    assert.ok(chained instanceof Error, "a bare call still produces an Error");
    assert.equal(chained.error, newest);
    assert.equal(chained.suppressed, accumulated);
  });

  test("both call forms produce structurally identical instances", () => {

    const newest = new Error("newest");
    const accumulated = new Error("accumulated");

    assert.deepEqual(shapeOf(new SuppressedError(newest, accumulated, "both failed")), shapeOf(SuppressedError(newest, accumulated, "both failed")));
  });

  test("an omitted message leaves the inherited empty message rather than the string \"undefined\"", () => {

    const chained = new SuppressedError(new Error("a"), new Error("b"));

    assert.equal(chained.message, "", "the message defaults to empty");
    assert.equal(Object.getOwnPropertyDescriptor(chained, "message"), undefined, "an omitted message adds no own message property");
  });

  test("a supplied message is carried verbatim", () => {

    assert.equal(new SuppressedError(new Error("a"), new Error("b"), "Two resources failed to dispose.").message, "Two resources failed to dispose.");
  });

  test("non-Error failures are carried unchanged", () => {

    const chained = new SuppressedError("a string failure", 42);

    assert.equal(chained.error, "a string failure");
    assert.equal(chained.suppressed, 42);
  });

  test("the constructor and its prototype are linked in both directions", () => {

    const chained = new SuppressedError(new Error("a"), new Error("b"));

    assert.equal(Object.getPrototypeOf(chained), SuppressedError.prototype, "instances share the constructor's prototype, which is what `instanceof` consults");
    assert.equal(chained.constructor, SuppressedError, "an instance reports the constructor that built it, not the base Error");
    assert.equal(Object.getPrototypeOf(SuppressedError.prototype), Error.prototype, "the prototype chain reaches Error.prototype");
  });
});

describe("SuppressedError - differential oracle against the platform global", () => {

  const nativeSuppressedError = globalThis.SuppressedError;

  // Skip only when the platform global is absent, which is exactly the runtime floor this module exists to serve. On a runtime that ships the global, the oracle proves
  // the in-package constructor is observably the same thing.
  const skip = (typeof nativeSuppressedError === "function") ? false : "the platform SuppressedError global is absent";
  const scenarios: { name: string; run: (make: SuppressedErrorConstructor) => unknown }[] = [

    { name: "new construction", run: (make) => shapeOf(new make("e", "s")) },
    { name: "bare call construction", run: (make) => shapeOf(make("e", "s")) },
    { name: "construction with a message", run: (make) => shapeOf(make("e", "s", "both failed")) },
    { name: "construction from non-Error failures", run: (make) => shapeOf(new make(42, { reason: "s" })) }
  ];

  for(const scenario of scenarios) {

    test(scenario.name, { skip }, () => {

      const shimOutcome = scenario.run(SuppressedError);
      const nativeOutcome = scenario.run(nativeSuppressedError);

      assert.deepEqual(shimOutcome, nativeOutcome, "the in-package constructor matches the platform global for " + scenario.name);
    });
  }
});
