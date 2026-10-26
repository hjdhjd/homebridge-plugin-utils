/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homekit-name.test.ts: Unit tests for HomeKit's naming rule (validateName and sanitizeName), the custom-name rule (resolveNameOverride and displayedName) and the
 * rule for who owns a name (ownedName), and for the package root resolving each to this module's own function.
 */
import * as root from "./index.ts";
import { describe, test } from "node:test";
import { displayedName, ownedName, resolveNameOverride, sanitizeName, validateName } from "./homekit-name.ts";
import assert from "node:assert/strict";

describe("validateName", () => {

  test("accepts a plain alphanumeric name", () => {

    assert.equal(validateName("Living Room Lamp"), true);
  });

  test("accepts the allowed special characters inside the name", () => {

    // HomeKit allows -"',.#& as interior characters - the regex permits them in the body but still requires letter/number bookends.
    assert.equal(validateName("Kitchen-Lamp"), true);
    assert.equal(validateName("O'Brien 1"), true);
    assert.equal(validateName("Room 2.0"), true);
  });

  test("permits a trailing period", () => {

    // The regex explicitly lists `.` as an allowed end character alongside letters and numbers.
    assert.equal(validateName("Device."), true);
  });

  test("rejects names that start with a disallowed character", () => {

    assert.equal(validateName(" Leading Space"), false);
    assert.equal(validateName("-Dash"), false);
  });

  test("rejects names that end with a disallowed non-period character", () => {

    assert.equal(validateName("Trailing-"), false);
    assert.equal(validateName("Trailing "), false);
  });

  test("rejects double spaces", () => {

    assert.equal(validateName("Two  Spaces"), false);
  });

  test("rejects names containing emoji", () => {

    // An emoji falls outside every character class a name may hold, so one anywhere in the name fails the match.
    assert.equal(validateName("Rocket \u{1F680}"), false);
  });

  test("rejects a letter that is also pictographic", () => {

    // U+2139 is a letter Unicode also marks pictographic, so a name's classes refuse it only because they subtract every pictograph.
    assert.equal(validateName("Info \u{2139}"), false);
  });

  test("rejects names containing disallowed punctuation", () => {

    assert.equal(validateName("Test|Switch"), false);
    assert.equal(validateName("Test/Switch"), false);
  });

  test("accepts a single character that may both start and end a name", () => {

    // A one-character name is its own first and last character, so a lone letter or number satisfies both ends of the rule at once.
    assert.equal(validateName("A"), true, "a single letter is a name");
    assert.equal(validateName("7"), true, "and so is a single number");
  });

  test("rejects a single character a name may not start with", () => {

    assert.equal(validateName("|"), false, "a character no name may hold is no name on its own");
    assert.equal(validateName("-"), false, "nor is one a name may hold only inside");
    assert.equal(validateName("."), false, "nor a period, which may end a name but never start one");
  });
});

describe("sanitizeName", () => {

  test("returns a valid name unchanged", () => {

    // Fast path: when the input already satisfies validateName, the sanitizer returns early without invoking the replacement chain.
    const input = "Living Room Lamp";

    assert.equal(sanitizeName(input), input);
  });

  test("replaces disallowed characters with spaces", () => {

    // Pipe is the canonical JSDoc example - it becomes a space, which then survives the whitespace-squash pass since there are no adjacent spaces.
    assert.equal(sanitizeName("Test|Switch"), "Test Switch");
  });

  test("collapses multiple spaces introduced by replacement", () => {

    // Two disallowed characters in a row would produce two spaces; the `\s+` collapse reduces them to one.
    assert.equal(sanitizeName("A||B"), "A B");
  });

  test("trims leading and trailing whitespace", () => {

    assert.equal(sanitizeName("  Hello  "), "Hello");
  });

  test("strips leading non-letter / non-number characters", () => {

    // Leading hyphen is allowed in the body but forbidden as the first character. The sanitizer strips it so the result is well-formed.
    assert.equal(sanitizeName("-Switch"), "Switch");
  });

  test("collapses two or more trailing periods to a single period", () => {

    // A bare "Device..." already satisfies validateName (ends with `.`), so the fast path would return it unchanged. To exercise the ellipsis-collapse step we pair it
    // with a leading dash, which forces the slow replacement chain; the leading-non-letter strip + trailing-period collapse together produce "Device.".
    assert.equal(sanitizeName("-Device..."), "Device.");
  });

  test("strips a trailing non-letter / non-number / non-period character", () => {

    // After emoji replacement this name ends with a space. The sanitizer trims, then strips any remaining trailing non-letter/number/period character.
    assert.equal(sanitizeName("Device \u{1F680}"), "Device");
  });

  test("strips every trailing character a name may not end with, so the result satisfies validateName", () => {

    // A hyphen and an ampersand are both allowed inside a name and neither may end one, so both have to go. Stripping only the last would leave "Test-", which the
    // validator rejects.
    assert.equal(sanitizeName("Test-&"), "Test");
    assert.equal(validateName(sanitizeName("Test-&")), true);

    // A longer run mixing a space and several permitted-but-not-final punctuation marks is stripped whole.
    assert.equal(sanitizeName("Test -&,#"), "Test");
    assert.equal(validateName(sanitizeName("Test -&,#")), true);

    // The trailing-period collapse runs after the strip, so periods the strip uncovers are collapsed too.
    assert.equal(sanitizeName("Test..-&"), "Test.");
  });

  test("keeps a single-character name, which validateName accepts, while an input with nothing valid still sanitizes to no name", () => {

    assert.equal(sanitizeName("A"), "A");
    assert.equal(validateName(sanitizeName("A")), true, "the sanitizer's answer for a one-letter name is one the validator accepts");
    assert.equal(sanitizeName("|"), "", "an input holding no permitted character sanitizes to the empty string");
    assert.equal(validateName(""), false, "which is not a name");
  });

  test("removes emojis entirely", () => {

    // Pictographic code points fall through the character-class replacement to a space, which is then trimmed out from the ends.
    assert.equal(sanitizeName("Rocket \u{1F680} Lamp"), "Rocket Lamp");
  });

  test("strips a letter that is also pictographic, so the result satisfies validateName", () => {

    // U+2139 is a letter Unicode also marks pictographic. The disallowed pass negates the same classes the validator matches, and those classes subtract every
    // pictograph, so the letter is stripped wherever it sits, in the form an emoji keyboard types too, and the answer is a name the validator accepts or no name at all.
    const rows: readonly (readonly [ string, string ])[] = [

      [ "Front \u{2139} Door", "Front Door" ],
      [ "\u{2139} Test", "Test" ],
      [ "Test \u{2139}", "Test" ],
      [ "A\u{2139}", "A" ],
      [ "\u{2139}", "" ],
      [ "\u{2139}\u{FE0F} Info", "Info" ],
      [ "Info \u{2139}\u{FE0F}", "Info" ],
      [ "\u{1F600} Lamp", "Lamp" ],
      [ "Garage \u{A9} Door", "Garage Door" ],
      [ "Test|Switch", "Test Switch" ],
      [ "Front Door", "Front Door" ]
    ];

    for(const [ input, expected ] of rows) {

      const answer = sanitizeName(input);

      assert.equal(answer, expected, "sanitizing " + JSON.stringify(input));
      assert.ok((answer === "") || validateName(answer), "the answer for " + JSON.stringify(input) + " is a name the validator accepts or no name at all");
    }
  });

  test("produces a HomeKit-valid result from a messy input", () => {

    // Round-trip: the sanitizer's output should itself pass validateName for any non-empty input with at least one valid character. This guards against subtle regex
    // regressions that could leave invalid residue (double spaces, trailing junk, etc.).
    const messy = "  --Living | Room \u{1F680} Lamp...   ";
    const cleaned = sanitizeName(messy);

    assert.equal(validateName(cleaned), true);
    assert.equal(cleaned, "Living Room Lamp.");
  });
});

describe("resolveNameOverride", () => {

  test("answers the trimmed text of an override HomeKit can carry, never its sanitized form", () => {

    // Each caller sanitizes the name it settles on where it applies it, so the answer is the user's text trimmed and nothing more: a custom name holding an emoji
    // HomeKit drops is answered with the emoji still in place.
    const rows: readonly (readonly [ string, string ])[] = [

      [ "  Reading Nook  ", "Reading Nook" ],
      [ "\tReading Nook\n", "Reading Nook" ],
      [ "Bedtime \u{1F319}", "Bedtime \u{1F319}" ],
      [ "Kitchen", "Kitchen" ]
    ];

    for(const [ text, expected ] of rows) {

      assert.equal(resolveNameOverride(text), expected, "resolving " + JSON.stringify(text));
    }
  });

  test("answers null for an override HomeKit's naming rule leaves nothing of", () => {

    // An emoji alone and punctuation alone are names the rule empties, and HomeKit carries no such name: an accessory minted under one is refused, and a refresh
    // that applies one leaves the accessory's last name standing. Such an override counts as none, so the caller's fallback applies as if the user had named nothing.
    for(const text of [ "\u{1F3E0}", "---" ]) {

      assert.equal(resolveNameOverride(text), null, "resolving " + JSON.stringify(text));
    }
  });

  test("answers null for no value, whether the text trims to nothing or the option engine answers null or undefined", () => {

    for(const text of [ "", "   ", null, undefined ]) {

      assert.equal(resolveNameOverride(text), null, "resolving " + JSON.stringify(text));
    }
  });
});

describe("displayedName", () => {

  test("shows a custom name HomeKit can carry, sanitized as the runtime applies it", () => {

    assert.equal(displayedName({ fallback: "Kitchen Shade", override: "  Reading Nook  " }), "Reading Nook", "a custom name is shown trimmed");
    assert.equal(displayedName({ fallback: "Kitchen Shade", override: "Bedtime \u{1F319}" }), "Bedtime", "and sanitized, its emoji dropped");
  });

  test("shows the fallback where there is no custom name HomeKit can carry", () => {

    assert.equal(displayedName({ fallback: "Kitchen Shade", override: "\u{1F3E0}" }), "Kitchen Shade", "an override HomeKit's naming rule empties is no override");
    assert.equal(displayedName({ fallback: "Kitchen Shade", override: null }), "Kitchen Shade", "nor is a null one");
    assert.equal(displayedName({ fallback: "Kitchen Shade" }), "Kitchen Shade", "nor an absent one");
  });

  test("shows the fallback sanitized, or as it stands when HomeKit's naming rule leaves nothing of it", () => {

    // A blank row would name nothing at all, so a fallback the rule empties entirely is shown as it stands rather than sanitized away, its padding included. Each
    // fallback is read under every kind of override that is no custom name, since none of them may change what the row shows.
    const rows: readonly (readonly [ string, string ])[] = [

      [ "Kitchen \u{1F319}", "Kitchen" ],
      [ "\u{1F319}", "\u{1F319}" ],
      [ " \u{1F319} ", " \u{1F319} " ],
      [ "", "" ]
    ];
    const unusable: readonly (string | null | undefined)[] = [ undefined, null, "   ", "\u{1F3E0}", "---" ];

    for(const [ fallback, expected ] of rows) {

      for(const override of unusable) {

        assert.equal(displayedName({ fallback, override }), expected, "showing the fallback " + JSON.stringify(fallback) + " under the override " +
          JSON.stringify(override));
      }
    }
  });
});

describe("ownedName", () => {

  test("answers a custom name HomeKit can carry, trimmed, whatever Sync Name says", () => {

    assert.equal(ownedName({ fallback: "Zone 1", override: "  Patio  ", sync: false }), "Patio", "a custom name owns the HomeKit name with Sync Name off");
    assert.equal(ownedName({ fallback: "Zone 1", override: "Patio", sync: true }), "Patio", "and wins over the device's name with Sync Name on");
  });

  test("answers the device's name with Sync Name on where no custom name HomeKit can carry is set", () => {

    // An override HomeKit's naming rule leaves nothing of counts as none, so it falls through to Sync Name exactly as a null or an absent override does.
    assert.equal(ownedName({ fallback: "Zone 1", override: "\u{1F3E0}", sync: true }), "Zone 1", "an override the rule empties is no custom name");
    assert.equal(ownedName({ fallback: "Zone 1", override: null, sync: true }), "Zone 1", "and neither is a null one");
    assert.equal(ownedName({ fallback: "Zone 1", sync: true }), "Zone 1", "nor an absent one");
  });

  test("answers null, the user owning the name, with Sync Name off and no custom name HomeKit can carry", () => {

    assert.equal(ownedName({ fallback: "Zone 1", override: "\u{1F3E0}", sync: false }), null, "an override the rule empties leaves the name to the user");
    assert.equal(ownedName({ fallback: "Zone 1", override: null, sync: false }), null, "and so does a null one");
    assert.equal(ownedName({ fallback: "Zone 1", sync: false }), null, "and an absent one");
  });

  test("reads Sync Name as off where the caller omits it", () => {

    // A plugin that offers no Sync Name option calls the rule without one, and lands on the side that leaves a rename in the Home app standing.
    assert.equal(ownedName({ fallback: "Zone 1", override: "Patio" }), "Patio", "a custom name owns the HomeKit name with Sync Name omitted");
    assert.equal(ownedName({ fallback: "Zone 1" }), null, "and with no custom name the user owns it");
  });
});

describe("homekit-name - the package root", () => {

  test("resolves each of the module's functions from the package root to this module's own", () => {

    // The root reaches the module only through util.ts's forwarding re-export, so this is the row a dropped re-export fails: a consumer importing any of the
    // module's functions from the package root must get the one definition a settings page loads.
    assert.equal(root.sanitizeName, sanitizeName, "the package root's sanitizeName must be this module's own");
    assert.equal(root.validateName, validateName, "and so must its validateName");
    assert.equal(root.resolveNameOverride, resolveNameOverride, "and its resolveNameOverride");
    assert.equal(root.displayedName, displayedName, "and its displayedName");
    assert.equal(root.ownedName, ownedName, "and its ownedName");
  });
});
