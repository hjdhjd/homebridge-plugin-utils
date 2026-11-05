/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-secret.test.mjs: Unit tests for the secret reveal a plugin's own fields and the feature options rows share.
 */
"use strict";

import { applySecretMasking, createSecretToggle, maskSecrets, mountSecretReveals, toggleSecretReveal } from "./webUi-secret.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "./ui.helpers.mjs";

// A plugin's own markup: secret fields as a plugin writes them, the first holding a value, beside a plain field the reveal must leave alone.
const PLUGIN_FIELDS = "<div class=\"fo-secret-field\" data-secret-subject=\"API token\"><input class=\"form-control\" type=\"password\" value=\"s3cret\"></div>" +
  "<div class=\"fo-secret-field\" data-secret-subject=\"password\"><input class=\"form-control\" type=\"password\"></div>" +
  "<input class=\"form-control\" type=\"text\">";

// Seat markup in the document and hand back the element holding it.
const seatFields = (html = PLUGIN_FIELDS) => {

  const root = document.createElement("div");

  root.innerHTML = html;
  document.body.appendChild(root);

  return root;
};

describe("createSecretToggle", () => {

  test("builds a masked, bare button named for its subject, wearing a decorative eye", () => {

    using dom = createTestDom();

    const toggle = createSecretToggle({ subject: "API token" });

    assert.equal(toggle.tagName, "BUTTON");
    assert.equal(toggle.type, "button", "a bare button, so it can never submit the form it sits in");
    assert.ok(toggle.classList.contains("fo-secret-toggle"), "the class the page kit dresses and the view's handler matches");
    assert.equal(toggle.dataset.secretSubject, "API token", "the subject travels with the toggle");
    assert.equal(toggle.getAttribute("aria-label"), "Show the API token.", "the name says what the next click does");
    assert.equal(toggle.getAttribute("aria-pressed"), "false", "and the toggle starts masked");
    assert.equal(toggle.querySelector("svg")?.getAttribute("stroke"), "currentColor", "the glyph draws in whatever color surrounds it");
    assert.equal(toggle.querySelector("svg")?.getAttribute("aria-hidden"), "true", "and is hidden from assistive tech, which the name already serves");
  });
});

describe("applySecretMasking", () => {

  test("writes the field's type, the toggle's name, and its pressed state together, revealing and masking alike", () => {

    using dom = createTestDom();

    const input = document.createElement("input");
    const toggle = createSecretToggle({ subject: "password" });

    applySecretMasking({ input, revealed: true, toggle });

    assert.equal(input.type, "text", "revealed");
    assert.equal(toggle.getAttribute("aria-label"), "Hide the password.", "the name says the way back");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");

    applySecretMasking({ input, revealed: false, toggle });

    assert.equal(input.type, "password", "masked");
    assert.equal(toggle.getAttribute("aria-label"), "Show the password.");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
  });
});

describe("mountSecretReveals", () => {

  test("gives each secret field a toggle named by its own subject, and leaves a plain field alone", () => {

    using dom = createTestDom();

    const root = seatFields();

    mountSecretReveals({ root });

    const toggles = [...root.querySelectorAll(".fo-secret-toggle")];

    assert.equal(toggles.length, 2, "one toggle per secret field");
    assert.deepEqual(toggles.map((toggle) => toggle.getAttribute("aria-label")), [ "Show the API token.", "Show the password." ], "each named for what its field holds");
    assert.ok(toggles.every((toggle) => toggle.previousElementSibling?.matches("input")), "each seated after its field, inside the wrapper");
    assert.ok(root.querySelector("input[type=text]")?.nextElementSibling === null, "and the plain field gets nothing");
  });

  test("a field whose markup names no subject is named for its value", () => {

    using dom = createTestDom();

    const root = seatFields("<div class=\"fo-secret-field\"><input type=\"password\"></div>");

    mountSecretReveals({ root });

    assert.equal(root.querySelector(".fo-secret-toggle")?.getAttribute("aria-label"), "Show the value.");
  });

  test("masks a field the markup left in clear text, so the toggle's name describes what the field shows", () => {

    using dom = createTestDom();

    const root = seatFields("<div class=\"fo-secret-field\" data-secret-subject=\"key\"><input type=\"text\" value=\"abc\"></div>");

    mountSecretReveals({ root });

    assert.equal(root.querySelector("input")?.type, "password");
    assert.equal(root.querySelector("input")?.value, "abc", "masking hides the text and keeps it");
  });

  test("a click reveals the field and a second click masks it again, through each toggle's own listener", () => {

    using dom = createTestDom();

    const root = seatFields();

    mountSecretReveals({ root });

    const [ token, password ] = root.querySelectorAll(".fo-secret-field");
    const input = token.querySelector("input");
    const toggle = token.querySelector(".fo-secret-toggle");

    toggle.click();

    assert.equal(input.type, "text", "revealed");
    assert.equal(input.value, "s3cret", "showing the text the field already held");
    assert.equal(toggle.getAttribute("aria-label"), "Hide the API token.");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(password.querySelector("input").type, "password", "and the other field is untouched by this toggle's click");

    toggle.click();

    assert.equal(input.type, "password", "masked again");
    assert.equal(toggle.getAttribute("aria-label"), "Show the API token.");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
  });

  test("a click on the glyph inside the toggle is the toggle's click", () => {

    using dom = createTestDom();

    const root = seatFields();

    mountSecretReveals({ root });

    const field = root.querySelector(".fo-secret-field");

    field.querySelector(".fo-secret-toggle svg").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    assert.equal(field.querySelector("input").type, "text", "the pointer lands on the glyph, and the reveal still answers");
  });

  test("a second mount adds nothing, and a single click still flips once", () => {

    using dom = createTestDom();

    const root = seatFields();

    mountSecretReveals({ root });
    mountSecretReveals({ root });

    const field = root.querySelector(".fo-secret-field");

    assert.equal(root.querySelectorAll(".fo-secret-toggle").length, 2, "still one toggle per field");

    field.querySelector(".fo-secret-toggle").click();

    assert.equal(field.querySelector("input").type, "text", "one listener answered, so the click revealed rather than flipping twice");
  });

  test("a field that already holds a toggle - a feature option's own reveal - is left exactly as it was", () => {

    using dom = createTestDom();

    // A feature options row's secret field arrives with its toggle already built, and the view answers its clicks. A listener added here would answer the same
    // click a second time and undo the reveal the view just made.
    const root = seatFields("<div class=\"fo-option-row\"><div class=\"fo-secret-field\"><input class=\"fo-option-value\" type=\"password\"></div></div>");
    const field = root.querySelector(".fo-secret-field");

    field.appendChild(createSecretToggle({ subject: "value" }));

    const before = field.innerHTML;

    mountSecretReveals({ root });

    assert.equal(field.innerHTML, before, "nothing was added to the row");
    assert.equal(field.querySelectorAll(".fo-secret-toggle").length, 1);

    field.querySelector(".fo-secret-toggle").click();

    assert.equal(field.querySelector("input").type, "password", "and nothing here answers the row's click, which the view answers");
  });

  test("an aborted signal takes the mounted toggles back out and masks their fields, so a later mount starts clean", () => {

    using dom = createTestDom();

    const root = seatFields();
    const controller = new AbortController();

    mountSecretReveals({ root, signal: controller.signal });

    const field = root.querySelector(".fo-secret-field");

    field.querySelector(".fo-secret-toggle").click();

    assert.equal(field.querySelector("input").type, "text", "precondition: the field is revealed");

    controller.abort();

    assert.equal(root.querySelectorAll(".fo-secret-toggle").length, 0, "the mount's toggles are gone");
    assert.equal(field.querySelector("input").type, "password", "and no field is left showing its secret with no control beside it");

    mountSecretReveals({ root });

    field.querySelector(".fo-secret-toggle").click();

    assert.equal(field.querySelector("input").type, "text", "a later mount gives the bare field a live toggle again");
  });

  test("a signal already aborted mounts nothing", () => {

    using dom = createTestDom();

    const root = seatFields();

    mountSecretReveals({ root, signal: AbortSignal.abort() });

    assert.equal(root.querySelectorAll(".fo-secret-toggle").length, 0);
  });

  test("an abort reaches only the toggles its own mount added", () => {

    using dom = createTestDom();

    const root = seatFields();
    const other = seatFields("<div class=\"fo-secret-field\" data-secret-subject=\"passcode\"><input type=\"password\"></div>");
    const controller = new AbortController();

    mountSecretReveals({ root: other });
    mountSecretReveals({ root, signal: controller.signal });
    controller.abort();

    assert.equal(other.querySelectorAll(".fo-secret-toggle").length, 1, "a mount under no signal lasts for the page");
    assert.equal(root.querySelectorAll(".fo-secret-toggle").length, 0);
  });
});

describe("toggleSecretReveal", () => {

  test("a toggle outside any secret field does nothing at all", () => {

    using dom = createTestDom();

    const orphan = createSecretToggle({ subject: "value" });

    assert.doesNotThrow(() => toggleSecretReveal(orphan));
    assert.equal(orphan.getAttribute("aria-pressed"), "false", "with no field to reveal, the toggle's own state stays put too");
  });

  test("a toggle written by hand without a subject is named for its value", () => {

    using dom = createTestDom();

    // Markup a page wrote itself, toggle and all: the class the view's handler matches, and no subject on it to name.
    const root = seatFields("<div class=\"fo-secret-field\"><input type=\"password\"><button class=\"fo-secret-toggle\" type=\"button\"></button></div>");
    const toggle = root.querySelector(".fo-secret-toggle");

    toggleSecretReveal(toggle);

    assert.equal(root.querySelector("input")?.type, "text", "the field is revealed");
    assert.equal(toggle.getAttribute("aria-label"), "Hide the value.", "and the name reads the default subject rather than an empty one");
  });

  test("a wrapper holding no field does nothing at all", () => {

    using dom = createTestDom();

    const root = seatFields("<div class=\"fo-secret-field\" data-secret-subject=\"key\"></div>");

    mountSecretReveals({ root });

    const toggle = root.querySelector(".fo-secret-toggle");

    toggle.click();

    assert.equal(toggle.getAttribute("aria-pressed"), "false", "a toggle is seated, and its click finds nothing to reveal");
  });
});

describe("maskSecrets", () => {

  test("returns every revealed secret under the root to masked, and leaves masked ones masked", () => {

    using dom = createTestDom();

    const root = seatFields();

    mountSecretReveals({ root });

    const [ token, password ] = root.querySelectorAll(".fo-secret-field");

    token.querySelector(".fo-secret-toggle").click();
    maskSecrets(root);

    assert.equal(token.querySelector("input").type, "password", "the revealed field is masked");
    assert.equal(token.querySelector(".fo-secret-toggle").getAttribute("aria-label"), "Show the API token.", "and its toggle says so");
    assert.equal(token.querySelector(".fo-secret-toggle").getAttribute("aria-pressed"), "false");
    assert.equal(password.querySelector("input").type, "password", "the masked one stays masked");
  });

  test("a secret field with no toggle yet is not one the reveal operates, so it is left as written", () => {

    using dom = createTestDom();

    const root = seatFields("<div class=\"fo-secret-field\"><input type=\"text\"></div>");

    maskSecrets(root);

    assert.equal(root.querySelector("input")?.type, "text");
  });
});
