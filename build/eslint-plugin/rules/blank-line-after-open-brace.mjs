/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * blank-line-after-open-brace.mjs: Require a blank line after an opening brace if it is immediately followed by a newline.
 */

// Find the open-brace token that needs a blank line inserted after it, or return null when the brace is canonical. The "canonical" form is one of:
//  * the brace is closed on the same line (`{}` or `{ a }`), or
//  * the brace is followed immediately by a blank line.
// We do not flag braces that are followed by a blank line; we only flag braces followed by content on the very next line.
function findBlankLineAfterOpenBrace(sourceCode, node) {

  const openBrace = sourceCode.getFirstToken(node);
  const nextToken = sourceCode.getTokenAfter(openBrace);

  if(openBrace.loc.end.line >= nextToken.loc.start.line) {

    return null;
  }

  const nextLine = sourceCode.lines[openBrace.loc.end.line];

  if(nextLine.trim() === "") {

    return null;
  }

  return openBrace;
}

// Require a blank line after an opening brace whenever the brace is followed by a newline and the next line carries non-whitespace content.
//
// Cases covered:
//  * Block statements (`function`, `if`, `for`, etc.).
//  * Class bodies.
//  * Object expressions (including those nested as class-property initializers, which the `ObjectExpression` visitor reaches via ESLint's AST walk).
//  * TypeScript interface bodies and embedded nested type literals.
//  * TypeScript type alias declarations whose annotation is a type literal, and nested type literals therein.
//
// The autofix inserts a single `\n` immediately after the offending brace. Single-line braces (`{}` or `{ a }`) and braces already followed by a blank line
// are both canonical and ignored. The rule reports against the brace token itself so editor markers pinpoint the brace rather than the wider statement.
const ruleBlankAfterOpenBrace = {

  create(context) {

    const sourceCode = context.sourceCode;

    function reportIfViolation(node) {

      const openBrace = findBlankLineAfterOpenBrace(sourceCode, node);

      if(openBrace === null) {

        return;
      }

      context.report({

        fix(fixer) {

          return fixer.insertTextAfter(openBrace, "\n");
        },
        loc: openBrace.loc,
        message: "Expected blank line after left brace and newline.",
        node
      });
    }

    return {

      BlockStatement(node) {

        reportIfViolation(node);
      },

      ClassBody(node) {

        reportIfViolation(node);
      },

      // Nested object-expression property initializers inside class bodies are reached by the `ObjectExpression` visitor below, which ESLint dispatches
      // automatically as it walks the AST. No manual recursion is needed here. (Compare with `TSInterfaceBody` and `TSTypeAliasDeclaration` below, which
      // DO need manual recursion because `TSTypeLiteral` has no dedicated visitor in this rule.)
      ObjectExpression(node) {

        reportIfViolation(node);
      },

      TSInterfaceBody(node) {

        reportIfViolation(node);

        for(const property of node.body) {

          if(!property.typeAnnotation || (property.type !== "TSPropertySignature") || (property.typeAnnotation.typeAnnotation.type !== "TSTypeLiteral")) {

            continue;
          }

          reportIfViolation(property.typeAnnotation.typeAnnotation);
        }
      },

      TSTypeAliasDeclaration(node) {

        if(node.typeAnnotation.type !== "TSTypeLiteral") {

          return;
        }

        reportIfViolation(node.typeAnnotation);

        for(const member of node.typeAnnotation.members) {

          if(!member.typeAnnotation || (member.type !== "TSPropertySignature") || (member.typeAnnotation.typeAnnotation.type !== "TSTypeLiteral")) {

            continue;
          }

          reportIfViolation(member.typeAnnotation.typeAnnotation);
        }
      }
    };
  },
  meta: {

    docs: {

      description: "require a blank line after an opening brace if it is immediately followed by a newline",
      recommended: false
    },
    fixable: "whitespace",
    schema: [],
    type: "layout"
  }
};

export default ruleBlankAfterOpenBrace;
