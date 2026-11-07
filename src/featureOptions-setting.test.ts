/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions-setting.test.ts: Unit tests for readOptionsSetting - the identity a well-formed setting keeps, and how a setting an untyped configuration can hold
 * reads when it is not a list of option strings.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readOptionsSetting } from "./featureOptions-setting.ts";

describe("readOptionsSetting", () => {

  test("a list of strings is answered as the same array", () => {

    for(const setting of [ [], ["Disable.Widget.Alpha"], [ "Enable.Widget.Parts=Beta", "Disable.Gadget.Mode" ] ]) {

      assert.equal(readOptionsSetting(setting), setting, "a well-formed setting keeps its identity: " + JSON.stringify(setting));
    }
  });

  test("a setting that is not a list holds no entries", () => {

    for(const setting of [ undefined, null, "Disable.Widget.Alpha", 5, true, { options: ["Disable.Widget.Alpha"] } ]) {

      assert.deepEqual(readOptionsSetting(setting), [], "read as empty: " + JSON.stringify(setting));
    }
  });

  test("a list keeps its strings in order and drops everything else", () => {

    const setting = [ null, "Disable.Widget.Alpha", 5, {}, "Enable.Gadget.Mode", undefined, ["Disable.Widget.Beta"], false ];
    const entries = readOptionsSetting(setting);

    assert.deepEqual(entries, [ "Disable.Widget.Alpha", "Enable.Gadget.Mode" ]);
    assert.notEqual(entries, setting, "and the answer is a new array, so the caller's setting is never altered");
    assert.equal(setting.length, 8);
  });
});
