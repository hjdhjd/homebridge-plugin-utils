/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * paren-comparisons-in-logical.mjs: Require parentheses around comparison operands when used inside compound logical expressions.
 */

// The set of comparison operators whose operands must be parenthesized when nested inside a compound logical expression.
const COMPARISON_OPERATORS = new Set([ "!=", "!==", "<", "<=", "==", "===", ">", ">=", "in", "instanceof" ]);

// The set of compound logical operators that trigger the parenthesization requirement on their direct comparison operands.
const LOGICAL_OPERATORS = new Set([ "&&", "||" ]);

// Test whether a node is a comparison binary expression with one of the recognized operators.
function isComparison(node) {

  return !!node && (node.type === "BinaryExpression") && COMPARISON_OPERATORS.has(node.operator);
}

// Test whether a node is already parenthesized in source. Prefers ESLint's helper when available; falls back to a token check for older ESLint shapes.
function isParenthesized(sourceCode, node) {

  if(typeof sourceCode.isParenthesized === "function") {

    return sourceCode.isParenthesized(node);
  }

  const before = sourceCode.getTokenBefore(node);
  const after = sourceCode.getTokenAfter(node);

  return !!before && !!after && (before.value === "(") && (after.value === ")");
}

// Require parentheses around any comparison operand that is a direct child of a compound logical expression.
//
// Cases covered:
//  * `a === b && c === d`               is flagged; autofix produces `(a === b) && (c === d)`.
//  * `(a === b) && (c === d)`           is canonical; ignored.
//  * `a && b && c`                       has no comparison operands and is ignored.
//  * `(a && b) === (c && d)`             is a comparison containing logicals (not a logical containing comparisons); ignored at this level.
//
// The rule only inspects direct operands of `&&` and `||`. Deeper nested comparisons are reached because ESLint dispatches the `LogicalExpression` visitor on each
// nested logical node as it traverses the already-built AST.
const ruleParenComparisonsInLogical = {

  create(context) {

    const sourceCode = context.sourceCode;

    function reportIfViolation(node) {

      if(!isComparison(node) || isParenthesized(sourceCode, node)) {

        return;
      }

      context.report({

        fix(fixer) {

          return fixer.replaceText(node, "(" + sourceCode.getText(node) + ")");
        },
        message: "Wrap comparison operands in parentheses inside compound logical expressions (&&, ||).",
        node
      });
    }

    return {

      LogicalExpression(node) {

        if(!LOGICAL_OPERATORS.has(node.operator)) {

          return;
        }

        reportIfViolation(node.left);
        reportIfViolation(node.right);
      }
    };
  },
  meta: {

    docs: {

      description: "require parentheses around comparison operands when used inside compound logical expressions (&&, ||)",
      recommended: false
    },
    fixable: "code",
    schema: [],
    type: "layout"
  }
};

export default ruleParenComparisonsInLogical;
