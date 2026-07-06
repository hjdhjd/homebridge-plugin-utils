/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * comment-style.test.mjs: Unit tests for the comment-style rule covering its enforcement groups (Unicode-glyph substitution, em-dash substitution,
 * decorative-banner-line removal, and box-drawing-character stripping) along with the negative cases that prove comment scoping works (string literals
 * are never touched).
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./comment-style.mjs";

const ruleTester = new RuleTester();

ruleTester.run("comment-style", rule, {

  invalid: [

    // Group A: each Unicode glyph is independently replaced with its ASCII equivalent in a line comment.
    {

      code: "// 0 → 1 transition",
      errors: [{ message: /Replace Unicode glyph/ }],
      output: "// 0 -> 1 transition"
    },
    {

      code: "// arrow ← backwards",
      errors: 1,
      output: "// arrow <- backwards"
    },
    {

      code: "// bidirectional ↔ link",
      errors: 1,
      output: "// bidirectional <-> link"
    },
    {

      code: "// x ≤ 10",
      errors: 1,
      output: "// x <= 10"
    },
    {

      code: "// x ≥ 10",
      errors: 1,
      output: "// x >= 10"
    },
    {

      code: "// tolerance ± 5",
      errors: 1,
      output: "// tolerance +/- 5"
    },

    // Group B: em-dash replacement.
    {

      code: "// before — after",
      errors: [{ message: /U\+2014/ }],
      output: "// before - after"
    },

    // Group A inside block comments works the same way - the rule walks all comment types, not just line comments.
    {

      code: "/* foo → bar */",
      errors: 1,
      output: "/* foo -> bar */"
    },
    {

      code: "/* range ≤ to ≥ */",
      errors: 1,
      output: "/* range <= to >= */"
    },

    // Multiple violations in a single comment collapse into one report with one fix...autofix produces the fully cleaned text in a single pass.
    {

      code: "// arrow → and check ≤ ok",
      errors: 1,
      output: "// arrow -> and check <= ok"
    },

    // Group C: decorative banner separators (=, -, # runs of four or more) on a line by themselves are removed entirely along with their trailing newline.
    {

      code: "// Section\n// ==========\nconst x = 1;\n",
      errors: [{ message: /Decorative banner separator/ }],
      output: "// Section\nconst x = 1;\n"
    },
    {

      code: "// Section\n// ----------\nconst x = 1;\n",
      errors: 1,
      output: "// Section\nconst x = 1;\n"
    },
    {

      code: "// Section\n// ##########\nconst x = 1;\n",
      errors: 1,
      output: "// Section\nconst x = 1;\n"
    },

    // Banner with leading whitespace is also removed - the indentation is part of the line we strip.
    {

      code: "function foo() {\n  // ============\n  return 1;\n}\n",
      errors: 1,
      output: "function foo() {\n  return 1;\n}\n"
    },

    // Banner on the final line of source (no trailing newline) is removed cleanly through end-of-file.
    {

      code: "const x = 1;\n// ==========",
      errors: 1,
      output: "const x = 1;\n"
    },

    // Group D: characters in the Box Drawing block (U+2500..U+257F) are stripped from comments.
    {

      code: "// border ─── done",
      errors: [{ message: /box-drawing character/ }],
      output: "// border  done"
    },
    {

      code: "// pipe │ vertical",
      errors: 1,
      output: "// pipe  vertical"
    },
    {

      code: "// double ═║ corner ╔",
      errors: 1,
      output: "// double  corner "
    },

    // Mixed substitution and box-drawing in the same comment...one report, one fix that handles both transformations.
    {

      code: "// arrow → box ─ done",
      errors: 1,
      output: "// arrow -> box  done"
    },

    // String literal is unaffected by the autofix; only the comment is cleaned. This is the proof that the rule is comment-scoped.
    {

      code: "const s = \"→\"; // arrow → string",
      errors: 1,
      output: "const s = \"→\"; // arrow -> string"
    }
  ],

  valid: [

    // Plain ASCII comments are unaffected.
    "// This is a normal comment.",
    "/* Block comment */",
    "/* Multi\n * line\n * block */",

    // Comments containing only ASCII punctuation including the same characters used in banners (but not as a full-line banner) are valid.
    "// foo - bar",
    "// 0 -> 1 transition",
    "// x <= 10 and y >= 20",

    // The banner regex requires the whole comment body to be a contiguous run, so a body with mixed content does not match.
    "// === short label",

    // Comments with banner-shaped text are allowed when they share a line with code...full-line removal would also delete the code, so we leave them be.
    "const x = 1; // ====",

    // Banner inside a block comment is not subject to the line-comment banner check.
    "/* === */",

    // Block comment using the structured `/* * */` continuation marker convention is fine - the asterisks are inside the body but not banner-shaped runs.
    "/* Header.\n *\n * Body line.\n */",

    // Unicode in string literals is never touched. The following cases are the load-bearing proof of the comment-only scope.
    "const s = \"→\";",
    "const s = \"—\";",
    "const s = \"─\";",
    "const arr = [ \"→\", \"≤\", \"≥\" ];",

    // Em-dash inside a regular-expression literal is not a comment and is not flagged.
    "const re = /—/;"
  ]
});
