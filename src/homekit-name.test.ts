/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homekit-name.test.ts: Unit tests for HomeKit's naming rule - validateName and sanitizeName - and for the package root resolving each to this module's own
 * function.
 */
import * as root from "./index.ts";
import { describe, test } from "node:test";
import { sanitizeName, validateName } from "./homekit-name.ts";
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

describe("homekit-name - the package root", () => {

  test("resolves sanitizeName and validateName from the package root to this module's own functions", () => {

    // The root reaches the rule only through util.ts's forwarding re-export, so this is the row a dropped re-export fails: a consumer importing sanitizeName or
    // validateName from the package root must get the one definition a settings page loads.
    assert.equal(root.sanitizeName, sanitizeName, "the package root's sanitizeName must be this module's own");
    assert.equal(root.validateName, validateName, "and so must its validateName");
  });
});
