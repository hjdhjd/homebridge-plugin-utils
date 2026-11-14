/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * array-bracket-spacing.mjs: Require a space inside array brackets, except around a single element.
 */

// The report sentences, by bracket and by whether the gap beside the bracket lacks the space the array asks for or carries one it should not.
const MESSAGES = {

  closing: {

    missing: "Add a space before the closing bracket of an array with more than one element.",
    unexpected: "Remove the space before the closing bracket of a single-element array."
  },
  opening: {

    missing: "Add a space after the opening bracket of an array with more than one element.",
    unexpected: "Remove the space after the opening bracket of a single-element array."
  }
};

// Find an array's bracket gaps, each as the tokens that bound it, the bracket it belongs to, the bracket's sentences and the fix that adds the missing
// space against the bracket. The closing bracket of a type-annotated pattern is the token before the annotation, because the pattern's node runs on to the
// annotation's end...for an optional pattern that token is its question mark, which the stylistic rule reads the same way.
function bracketGaps(sourceCode, node) {

  const opening = sourceCode.getFirstToken(node);
  const closing = ((node.type === "ArrayPattern") && node.typeAnnotation) ? sourceCode.getTokenBefore(node.typeAnnotation) : sourceCode.getLastToken(node);

  return [
    { addSpace: (fixer) => fixer.insertTextAfter(opening, " "), bracket: opening, left: opening, messages: MESSAGES.opening, right: sourceCode.getTokenAfter(opening) },
    { addSpace: (fixer) => fixer.insertTextBefore(closing, " "), bracket: closing, left: sourceCode.getTokenBefore(closing), messages: MESSAGES.closing, right: closing }
  ];
}

// The report for a gap that lacks its space, marking the bracket itself.
function missingSpace({ addSpace, bracket, messages }) {

  return { fix: addSpace, loc: bracket.loc, message: messages.missing };
}

// The report for a gap that carries a space it should not, marking the gap. The fix deletes the gap's whitespace and keeps every comment in it, joined to its
// neighbors. A line comment never sits in a gap the rule reads, because it runs to the end of its line and so puts the token beside the bracket on a later
// line, which leaves every comment kept a block comment, closed by its own delimiter.
function extraSpace(sourceCode, { left, messages, right }) {

  const keptText = sourceCode.getTokensBetween(left, right, { includeComments: true }).map((comment) => sourceCode.getText(comment)).join("");

  return {

    fix(fixer) {

      return fixer.replaceTextRange([ left.range[1], right.range[0] ], keptText);
    },
    loc: { end: right.loc.start, start: left.loc.end },
    message: messages.unexpected
  };
}

// Find the spacing violations in an array's bracket gaps, each as the descriptor its report takes. An array of one element, a hole counting as one, is unspaced
// and every other array is spaced, while an array with no elements is left alone. A gap is read only when the tokens that bound it share a line, and it
// is spaced when whitespace sits anywhere in it, before, between or after any comments it holds.
function findViolations(sourceCode, node) {

  if(node.elements.length === 0) {

    return [];
  }

  const spaced = node.elements.length !== 1;

  return bracketGaps(sourceCode, node).filter(({ left, right }) => (left.loc.end.line === right.loc.start.line) && (sourceCode.isSpaceBetween(left, right) !== spaced))
    .map((gap) => spaced ? missingSpace(gap) : extraSpace(sourceCode, gap));
}

// Require a space inside each bracket of an array, except an array of a single element, whose brackets sit against it: `[ a, b ]` but `[a]`.
//
// Cases covered:
//  * `[a, b]`                   reports each bracket; autofix produces `[ a, b ]`.
//  * `[ a ]`                    reports each bracket; autofix produces `[a]`. A hole is an element, so `[ , ]` fixes to `[,]` and `[,,]` to `[ ,, ]`.
//  * `[]`                       holds no element and is left alone however it is spaced.
//  * `const [ a ] = b;`         covers a destructuring pattern the same way, and `function f([ a ]: T[])` reads the bracket before the type annotation.
//  * `[\n  a,\n  b\n]`          checks a bracket only against a neighbor on its own line, so a line break inside a bracket is never a spacing violation.
//  * `[[a], { b: 1 }]`          gives nested arrays and objects no exception of their own; autofix produces `[ [a], { b: 1 } ]`.
//  * `[ /* only */ a ]`         keeps the comment, because the autofix deletes the whitespace alone, producing `[/* only */a]`.
//
// The findings are those of the stylistic plugin's array-bracket-spacing rule set to "always" with the single-value exception, and the fix differs from that
// rule's in one respect: where a comment sits in the gap, that rule deletes the gap whole, comment included, and this one deletes only the whitespace, because a
// spacing fix has no business deleting what the author wrote. A non-empty array always holds an element or a comma between its brackets, so the closing gap
// never reaches back to the opening bracket. The style is the house's one answer, so the rule takes no options.
const ruleArrayBracketSpacing = {

  create(context) {

    const sourceCode = context.sourceCode;

    function reportViolations(node) {

      for(const violation of findViolations(sourceCode, node)) {

        context.report({ ...violation, node });
      }
    }

    return {

      ArrayExpression: reportViolations,
      ArrayPattern: reportViolations
    };
  },
  meta: {

    docs: {

      description: "require a space inside array brackets, except around a single element",
      recommended: false
    },
    fixable: "whitespace",
    schema: [],
    type: "layout"
  }
};

export default ruleArrayBracketSpacing;
