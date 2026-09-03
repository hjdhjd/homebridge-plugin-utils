/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-topics-declaration.test.ts: The declaration-emit contract for the catalog builder's column-bearing form.
 *
 * The contract lives apart because this module's imports are the whole of it. The builder is the only thing imported from the topic vocabulary here, so the
 * declaration emitter has to spell the column overload's return type by name from this file; a module that also imports the column's symbol key can always name
 * that key, and the contract would be silent there whatever the overload returns. The root typecheck is the gate that reads it, and the runtime row below keeps
 * the module a suite member in its own right rather than a file the runner counts without exercising anything.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mqttTopicCatalog } from "./mqtt-topics.ts";

// The documented column form as a plugin writes it: an exported constant. This module's own typecheck is the gate, so an overload whose return type a consumer's
// declaration emitter cannot name fails here exactly as it failed the first plugin that adopted the column.
export const declarationEmittedCatalog = mqttTopicCatalog({ lock: { devices: ["camera"], label: "lock", publish: "The lock state.", topic: "lock" } },
  { heading: "Device Type", vocabulary: { camera: "Camera" } });

describe("mqttTopicCatalog - the declaration-emit contract", () => {

  // The row reads the column through the property symbols rather than through the symbol itself, since importing that key here would let the emitter name it and
  // the compile-time half of this file would stop asserting anything.
  test("the exported catalog carries its entries by key and its column under a symbol", () => {

    assert.deepEqual(Object.keys(declarationEmittedCatalog), ["lock"]);
    assert.equal(declarationEmittedCatalog.lock.topic, "lock");
    assert.equal(Object.getOwnPropertySymbols(declarationEmittedCatalog).length, 1);
  });
});
