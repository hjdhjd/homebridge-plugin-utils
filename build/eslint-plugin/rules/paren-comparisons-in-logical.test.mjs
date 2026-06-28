/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * paren-comparisons-in-logical.test.mjs: Unit tests for the paren-comparisons-in-logical rule covering each comparison operator on either side of a
 * compound logical expression, the partial-wrap case where only one operand is a comparison, and the negative passthrough cases that prove already-
 * parenthesized comparisons and non-comparison operands are correctly ignored.
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./paren-comparisons-in-logical.mjs";

const ruleTester = new RuleTester();

ruleTester.run("paren-comparisons-in-logical", rule, {

  invalid: [

    // Equality comparisons on both operands of `&&` - both sides wrap.
    {

      code: "const r = a === b && c === d;",
      errors: [ { message: /Wrap comparison operands in parentheses/ }, { message: /Wrap comparison operands in parentheses/ } ],
      output: "const r = (a === b) && (c === d);"
    },

    // Inequality comparisons on both operands of `||`.
    {

      code: "const r = a !== b || c !== d;",
      errors: 2,
      output: "const r = (a !== b) || (c !== d);"
    },

    // Relational comparisons (`<`, `<=`, `>`, `>=`) and loose equality (`==`, `!=`) all wrap when used as direct operands of a logical expression.
    {

      code: "const r = x < 10 || y > 20;",
      errors: 2,
      output: "const r = (x < 10) || (y > 20);"
    },
    {

      code: "const r = x <= 10 && y >= 20;",
      errors: 2,
      output: "const r = (x <= 10) && (y >= 20);"
    },
    {

      code: "const r = x == null || y != 0;",
      errors: 2,
      output: "const r = (x == null) || (y != 0);"
    },

    // `in` and `instanceof` are recognized as comparison operators by the rule and wrap when used as logical operands.
    {

      code: "const r = key in obj && key !== \"reserved\";",
      errors: 2,
      output: "const r = (key in obj) && (key !== \"reserved\");"
    },
    {

      code: "const r = x instanceof Foo || y instanceof Bar;",
      errors: 2,
      output: "const r = (x instanceof Foo) || (y instanceof Bar);"
    },

    // Asymmetric case - only the left operand is a comparison. Only that side wraps; the non-comparison right operand stays as-is.
    {

      code: "const r = a === b && ready;",
      errors: 1,
      output: "const r = (a === b) && ready;"
    },

    // Asymmetric case - only the right operand is a comparison.
    {

      code: "const r = ready && a === b;",
      errors: 1,
      output: "const r = ready && (a === b);"
    }
  ],

  valid: [

    // Already-parenthesized comparisons - canonical, no rewrite.
    "const r = (a === b) && (c === d);",
    "const r = (x < 10) || (y > 20);",

    // Logical expressions whose operands are not comparisons - the rule has nothing to wrap.
    "const r = a && b;",
    "const r = a && b && c;",
    "const r = a || b;",
    "const r = ready && configured;",

    // Comparison without a surrounding logical - the rule only flags direct operands of `&&` / `||`, so a bare comparison is ignored.
    "const r = a === b;",
    "const r = x < 10;",

    // Comparison containing logicals (not a logical containing comparisons). The top-level binary expression is `===` - the rule only inspects operands
    // when the parent is `&&` / `||`, so this configuration is ignored at the top level.
    "const r = (a && b) === (c && d);",

    // Non-comparison binary expressions (arithmetic) as logical operands - not in the comparison-operator set, no wrap.
    "const r = (a + b) && (c - d);",
    "const r = a + b && c - d;"
  ]
});
