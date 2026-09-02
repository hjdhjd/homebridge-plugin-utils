/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * no-numeric-separators.mjs: Bar underscore separators from numeric literals.
 */

// The character the numeric grammar allows between digits and this rule bars.
const SEPARATOR = "_";

// Test whether a literal node is numeric. The parsed value's type is what tells a numeric literal apart from everything else that can legally carry an underscore -
// a string spelling digits, an identifier, a property key - so the check reads the value rather than the literal's text.
function isNumericLiteral(node) {

  return (typeof node.value === "number") || (typeof node.value === "bigint");
}

// Bar the underscore separator from numeric literals, rewriting the literal to its plain digits on fix.
//
// Cases covered:
//  * `const x = 1_000;`              is reported; autofix produces `const x = 1000;`.
//  * `const x = 0xFF_FF;`            covers every base the same way - hexadecimal, binary, and octal literals alongside decimal ones.
//  * `const x = 1_000.000_1;`        covers both sides of the decimal point, and `const x = 1e1_0;` covers the exponent.
//  * `const x = 1_000n;`             is a numeric literal too, so a bigint is covered.
//  * `const x = "1_000";`            is a string rather than a number and is left alone, as are identifiers and property keys carrying an underscore.
//
// The separator is legal anywhere between digits in every numeric grammar the language has, so the fix strips the character wherever it appears in the literal's raw
// text: what is left is the same value written plainly. A number long enough to want the visual grouping wants a named constant instead, which is what the message
// points the author toward.
const ruleNoNumericSeparators = {

  create(context) {

    return {

      Literal(node) {

        if(!isNumericLiteral(node) || !node.raw.includes(SEPARATOR)) {

          return;
        }

        context.report({

          fix(fixer) {

            return fixer.replaceText(node, node.raw.replaceAll(SEPARATOR, ""));
          },
          message: "Write a numeric literal's digits plainly, without underscore separators. Name a long magic number as a constant instead.",
          node
        });
      }
    };
  },
  meta: {

    docs: {

      description: "bar underscore separators from numeric literals",
      recommended: false
    },
    fixable: "code",
    schema: [],
    type: "layout"
  }
};

export default ruleNoNumericSeparators;
