/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * no-numeric-separators.test.mjs: Unit tests for the no-numeric-separators rule covering a separator in every numeric grammar the language offers - each base, both
 * sides of a decimal point, the exponent, and a bigint - the multi-report and nested-position cases, and the negative passthrough cases that prove a string, an
 * identifier, and a property key carrying an underscore are none of them numeric literals.
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./no-numeric-separators.mjs";

const ruleTester = new RuleTester();

ruleTester.run("no-numeric-separators", rule, {

  invalid: [

    // A decimal integer - the case the house style meets most often.
    {

      code: "const x = 1_000;",
      errors: [{ message: /Write a numeric literal's digits plainly/ }],
      output: "const x = 1000;"
    },

    // Every other base reads the same way: the separator is legal between digits and the fix strips it wherever it sits.
    {

      code: "const x = 0xFF_FF;",
      errors: 1,
      output: "const x = 0xFFFF;"
    },
    {

      code: "const x = 0b1010_1010;",
      errors: 1,
      output: "const x = 0b10101010;"
    },
    {

      code: "const x = 0o7_7;",
      errors: 1,
      output: "const x = 0o77;"
    },

    // A fractional literal carrying a separator on both sides of the point, and an exponent carrying one of its own.
    {

      code: "const x = 1_000.000_1;",
      errors: 1,
      output: "const x = 1000.0001;"
    },
    {

      code: "const x = 1e1_0;",
      errors: 1,
      output: "const x = 1e10;"
    },

    // A bigint literal is a numeric literal, so the suffix survives the fix and the digits lose the separator.
    {

      code: "const x = 1_000n;",
      errors: 1,
      output: "const x = 1000n;"
    },

    // A negated literal - the unary minus wraps a plain literal, so the report lands on the literal and the sign is untouched.
    {

      code: "const x = -1_000;",
      errors: 1,
      output: "const x = -1000;"
    },

    // Two literals in one array report independently and are fixed in one pass.
    {

      code: "const x = [ 1_000, 2_000 ];",
      errors: 2,
      output: "const x = [ 1000, 2000 ];"
    },

    // A literal in a property-value position is reached exactly as a standalone one is.
    {

      code: "const x = { limit: 1_000 };",
      errors: 1,
      output: "const x = { limit: 1000 };"
    }
  ],

  valid: [

    // Plainly written literals in each grammar - nothing to strip.
    "const x = 1000;",
    "const x = 0xFFFF;",
    "const x = 1000.5;",
    "const x = 1e10;",
    "const x = 1000n;",

    // A string that merely spells a separated number is not a numeric literal, so its text is none of the rule's business.
    "const x = \"1_000\";",

    // Underscores in names are ordinary identifiers and property keys, which the rule never reads.
    "const my_value = 1000;",
    "const x = { my_key: 1000 };"
  ]
});
