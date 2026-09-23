/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-errors.test.mjs: Unit tests for the webUI's error reporting - reading a thrown value as text, and surfacing it as the host's error toast.
 */
"use strict";

import { createFakeHomebridge, installHomebridge } from "./ui.helpers.mjs";
import { describe, test } from "node:test";
import { errorMessage, toastError } from "./webUi-errors.mjs";
import assert from "node:assert/strict";

describe("errorMessage", () => {

  test("reads a value that carries a message as that message", () => {

    assert.equal(errorMessage(new Error("The controller refused the login.")), "The controller refused the login.", "an Error reads as its message");
    assert.equal(errorMessage({ message: "Timed out." }), "Timed out.", "and so does a plain object shaped like one");
  });

  test("reads any other thrown value as its string coercion rather than throwing on it", () => {

    // An extension point can reject with anything, so a value with no message - including the nullish ones, whose property read would otherwise throw - still
    // yields text a user can be shown.
    assert.equal(errorMessage("Bad credentials."), "Bad credentials.", "a thrown string reads as itself");
    assert.equal(errorMessage(42), "42", "a primitive reads as its coercion");
    assert.equal(errorMessage(null), "null", "a null rejection reads without throwing");
    assert.equal(errorMessage(undefined), "undefined", "and so does an undefined one");
  });
});

describe("toastError", () => {

  test("surfaces the thrown value's text through the host's error toast", () => {

    const fake = createFakeHomebridge();

    using homebridgeInstall = installHomebridge(fake);

    toastError(new Error("The plugin could not reach its controller."));
    toastError("A bare string rejection.");

    assert.deepEqual(fake.observed.toasts, [

      { message: "The plugin could not reach its controller.", title: "Error", variant: "error" },
      { message: "A bare string rejection.", title: "Error", variant: "error" }
    ], "each value is read through the shared rule and lands on the error channel with the error title");
  });
});
