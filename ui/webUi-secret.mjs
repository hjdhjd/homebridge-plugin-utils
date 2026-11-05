/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-secret.mjs: The secret reveal - the toggle that masks and shows a secret field, for a feature option's value and a plugin's own fields alike.
 */

/**
 * The secret reveal a settings page puts beside a field holding a secret: a toggle that shows or masks the field, named for what its next click does.
 *
 * One copy serves every place a secret is typed. The feature options rows build their reveal through {@link createSecretToggle} and lock it through
 * {@link applySecretMasking}, and the view answers a click on it through {@link toggleSecretReveal}. A plugin's own fields - an API token on a first-run page, a
 * password on a settings card - opt in through markup, and {@link mountSecretReveals} gives each one its toggle:
 *
 * ```html
 * <div class="fo-secret-field" data-secret-subject="API token">
 *   <input class="form-control" type="password">
 * </div>
 * ```
 *
 * The wrapper is what the page kit's `.fo-secret-field` rule seats the toggle beside, and `data-secret-subject` names what the field holds, so the toggle reads
 * "Show the API token." and then "Hide the API token." to assistive tech.
 *
 * Whether a secret is on screen is a property of how the page is being read at this moment rather than of the configuration, so nothing here reads a store,
 * dispatches, or touches the value a field holds: a reveal shows the text the field already carries, and masking it again hides that same text. The state is read
 * off the field's own type rather than a remembered flag, which is what keeps the toggle's name describing what the field is showing.
 *
 * The module holds no store and no plugin knowledge, and imports only the SVG builder, which is what lets the page primitives and the feature-options rows alike
 * build on it from below.
 *
 * @module
 */
"use strict";

import { createSvgElement } from "./webUi-svg.mjs";

// The eye outline the reveal toggle wears: symmetric upper and lower curves meeting at the corners, with the pupil drawn separately as a circle.
const EYE_OUTLINE_PATH = "M1 8c2-3.2 4.3-4.8 7-4.8s5 1.6 7 4.8c-2 3.2-4.3 4.8-7 4.8S3 11.2 1 8Z";

// The subject a toggle names when nothing names one - a field's markup carrying no subject, or a toggle written by hand without one - so the label still reads as a
// sentence about what the field holds.
const DEFAULT_SUBJECT = "value";

// Write the toggle's half of the masked presentation: its accessible name, which says what the next click does, and its pressed state, which says what the field is
// doing. The toggle carries the subject its name reads, so every writer of the label spells it through this one function, and a toggle carrying none reads the
// default rather than a name with nothing in it.
const labelToggle = ({ revealed, toggle }) => {

  toggle.setAttribute("aria-label", (revealed ? "Hide the " : "Show the ") + (toggle.dataset.secretSubject ?? DEFAULT_SUBJECT) + ".");
  toggle.setAttribute("aria-pressed", revealed ? "true" : "false");
};

// Build the toggle's eye glyph. Every mark draws in currentColor and the graphic is sized in em, so the glyph takes the color and the scale of the text around it.
// It is hidden from assistive tech because the button's own name already says what it does, and a decorative graphic announced beside that would only repeat it.
const createEyeGlyph = () => {

  const glyph = createSvgElement({

    attributes: {

      "aria-hidden": "true",
      "fill": "none",
      "height": "1em",
      "stroke": "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "1.25",
      "viewBox": "0 0 16 16",
      "width": "1em"
    },
    tag: "svg"
  });

  glyph.append(createSvgElement({ attributes: { "d": EYE_OUTLINE_PATH }, tag: "path" }),
    createSvgElement({ attributes: { "cx": "8", "cy": "8", "r": "2.1" }, tag: "circle" }));

  return glyph;
};

/**
 * Write a secret field's masked presentation: the field's type, the toggle's name, and its pressed state, together. This is the single writer of that state, used
 * by the reveal, the lock a feature options row applies, and the re-mask {@link maskSecrets} performs, so no path can move the field and leave the toggle describing
 * something else. A caller passes the state it wants rather than a direction, which keeps the writer a plain projection of whether the secret is on screen.
 *
 * @param {Object} args
 * @param {HTMLInputElement} args.input - The secret field.
 * @param {boolean} args.revealed - Whether the secret should be on screen.
 * @param {HTMLButtonElement} args.toggle - The field's reveal toggle, which carries the subject its name reads on `data-secret-subject`.
 */
export const applySecretMasking = ({ input, revealed, toggle }) => {

  input.type = revealed ? "text" : "password";
  labelToggle({ revealed, toggle });
};

/**
 * Build a reveal toggle, masked to begin with. It is a bare button, so it can never submit a form it sits in, and it carries its state on `aria-pressed` so
 * assistive tech reads it as the two-state control it is. Its appearance - the surrendered button chrome and the inherited text color the glyph draws in - belongs
 * to the page kit's `.fo-secret-toggle` rule, so the builder declares only what the control is.
 *
 * @param {Object} args
 * @param {string} [args.subject="value"] - What the field holds, in the words its name reads: "value" names "Show the value.".
 * @returns {HTMLButtonElement} The toggle, carrying the subject on `data-secret-subject`.
 */
export const createSecretToggle = ({ subject = DEFAULT_SUBJECT }) => {

  const toggle = document.createElement("button");

  toggle.classList.add("fo-secret-toggle");
  toggle.dataset.secretSubject = subject;
  toggle.type = "button";
  toggle.appendChild(createEyeGlyph());
  labelToggle({ revealed: false, toggle });

  return toggle;
};

/**
 * Flip a secret field between masked and revealed, and rename its toggle to match.
 *
 * The toggle finds its field through the `.fo-secret-field` wrapper it sits in, and the state is read off the field's current type. A toggle with no field to reveal
 * is a quiet no-op: a delegated handler reaches this by matching a class on whatever was clicked, so the element it hands over comes from markup rather than from a
 * call site that can be checked, and the webUI's posture toward markup it did not build is to do nothing rather than to throw inside a handler.
 *
 * @param {HTMLButtonElement} toggle - The reveal toggle the user activated.
 */
export const toggleSecretReveal = (toggle) => {

  const input = toggle.closest(".fo-secret-field")?.querySelector("input");

  if(!input) {

    return;
  }

  applySecretMasking({ input, revealed: input.type === "password", toggle });
};

/**
 * Give every secret field under a root its reveal toggle: each `.fo-secret-field` that holds no `.fo-secret-toggle` yet gets one named by its own
 * `data-secret-subject`, masked, and answering its own clicks. A field that already holds a toggle is passed over, which is what makes a second mount add nothing and
 * leaves a feature options row - whose reveal the row builder made and whose clicks the view answers - exactly as it was. Each toggle listens on itself rather than
 * through one listener on the root, because a root holding option rows would otherwise answer the click the view already answers.
 *
 * The mount lasts as long as `signal` does, or for the life of the page when none is given. When it aborts, every toggle this mount added is taken back out and its
 * field masked, so a field is never left showing a secret with no control beside it, and a later mount over the same root finds the fields bare and gives each a
 * live toggle again. A signal already aborted mounts nothing.
 *
 * @param {Object} args
 * @param {ParentNode} args.root - The element whose secret fields receive toggles.
 * @param {AbortSignal} [args.signal] - Ends the mount.
 */
export const mountSecretReveals = ({ root, signal }) => {

  if(signal?.aborted) {

    return;
  }

  const mounted = [];

  for(const field of root.querySelectorAll(".fo-secret-field")) {

    if(field.querySelector(".fo-secret-toggle")) {

      continue;
    }

    const input = field.querySelector("input");
    const toggle = createSecretToggle({ subject: field.dataset.secretSubject });

    if(input) {

      applySecretMasking({ input, revealed: false, toggle });
    }

    toggle.addEventListener("click", () => toggleSecretReveal(toggle), { signal });
    field.appendChild(toggle);
    mounted.push({ input, toggle });
  }

  signal?.addEventListener("abort", () => {

    for(const { input, toggle } of mounted) {

      if(input) {

        applySecretMasking({ input, revealed: false, toggle });
      }

      toggle.remove();
    }
  }, { once: true });
};

/**
 * Return every secret under a root to masked: each `.fo-secret-field` holding its field and its toggle is masked through {@link applySecretMasking}, whatever
 * state the user left it in. A page calls this when the secrets it shows should go back behind the mask, as a card closes or the page changes views.
 *
 * @param {ParentNode} root - The element whose secrets are masked.
 */
export const maskSecrets = (root) => {

  for(const field of root.querySelectorAll(".fo-secret-field")) {

    const input = field.querySelector("input");
    const toggle = field.querySelector(".fo-secret-toggle");

    if(input && toggle) {

      applySecretMasking({ input, revealed: false, toggle });
    }
  }
};
