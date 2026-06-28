/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * comment-style.mjs: Enforce ASCII-first comment style and disallow decorative banner separators.
 */

// The substitution table mapping Unicode glyphs to their canonical ASCII equivalents inside comments. Extend by adding a new entry; the substitution pass
// reads this table once per character and emits the ASCII form in place.
const COMMENT_ASCII_SUBSTITUTIONS = {

  "±": "+/-",
  "—": "-",
  "←": "<-",
  "→": "->",
  "↔": "<->",
  "≤": "<=",
  "≥": ">="
};

// A line comment whose body is exclusively a four-or-more run of `=`, `-`, or `#` characters with optional surrounding whitespace. The leading `^\s*` and
// trailing `\s*$` allow space padding (e.g., `// ====  `); the `\1{3,}` backreference forces the run to be a single repeated character.
const COMMENT_DECORATIVE_BANNER_RE = /^\s*([=\-#])\1{3,}\s*$/;

// Test whether a code point falls in the Unicode Box Drawing block (U+2500..U+257F, covering single-line, heavy, doubled, and rounded-corner forms in one
// contiguous range so a single bounds check covers every variant).
function isBoxDrawing(codePoint) {

  return (codePoint >= 0x2500) && (codePoint <= 0x257F);
}

// Format a character's code point as a `U+XXXX` string for use in human-readable rule messages.
function formatCodePoint(ch) {

  return "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
}

// Find the source range to remove for a decorative-banner-line violation, or null when the comment is not a removable banner. A removable banner is a
// line comment (block comments use `=`/`-` runs as part of structured JSDoc syntax) whose body matches the banner regex and which is the only content on
// its source line - banners that share a line with code are left to the contents pass so removing the line does not also delete the code.
function findCommentBannerRange(sourceCode, comment) {

  if(comment.type !== "Line") {

    return null;
  }

  if(!COMMENT_DECORATIVE_BANNER_RE.test(comment.value)) {

    return null;
  }

  const line = sourceCode.lines[comment.loc.start.line - 1];
  const before = line.slice(0, comment.loc.start.column);

  if(before.trim() !== "") {

    return null;
  }

  const lineStart = sourceCode.getIndexFromLoc({ column: 0, line: comment.loc.start.line });
  const nextLine = comment.loc.start.line + 1;
  const lineEnd = (nextLine <= sourceCode.lines.length) ?
    sourceCode.getIndexFromLoc({ column: 0, line: nextLine }) :
    sourceCode.text.length;

  return [ lineStart, lineEnd ];
}

// Analyze a comment's contents for substitutable Unicode glyphs and box-drawing characters. Returns null when the comment is clean; otherwise returns the
// full replacement source text plus the rule message describing the first issue found. The pass walks by code point so any future supplementary-plane
// character (e.g., emoji) is processed atomically rather than as two surrogates.
function findCommentContentsViolation(comment) {

  let transformed = "";
  const issues = [];

  for(const ch of comment.value) {

    if(ch in COMMENT_ASCII_SUBSTITUTIONS) {

      transformed += COMMENT_ASCII_SUBSTITUTIONS[ch];
      issues.push({ char: ch, kind: "substitution" });

      continue;
    }

    if(isBoxDrawing(ch.codePointAt(0))) {

      issues.push({ char: ch, kind: "boxdrawing" });

      continue;
    }

    transformed += ch;
  }

  if(issues.length === 0) {

    return null;
  }

  const newSource = (comment.type === "Line") ? ("//" + transformed) : ("/*" + transformed + "*/");
  const first = issues[0];
  const message = (first.kind === "substitution") ?
    ("Replace Unicode glyph `" + first.char + "` (" + formatCodePoint(first.char) + ") with ASCII `" + COMMENT_ASCII_SUBSTITUTIONS[first.char] +
      "` in comments.") :
    ("Remove box-drawing character `" + first.char + "` (" + formatCodePoint(first.char) + ") from comments.");

  return { message, newSource };
}

// Enforce ASCII-first comment style. The rule visits every comment in a single `Program` walk and reports three classes of drift.
//
// Cases covered:
//  * Substitutable Unicode glyphs with direct ASCII equivalents - arrows (U+2192, U+2190, U+2194), comparison operators (U+2264, U+2265), plus-minus
//    (U+00B1), and the em-dash (U+2014). Each is replaced in place via the substitution table.
//  * Decorative banner separators - line comments whose body is exclusively a run of four or more `=`, `-`, or `#` characters. The entire offending
//    source line is removed (including the trailing newline) so the section header collapses to the line above it.
//  * Characters in the Unicode Box Drawing block (U+2500..U+257F, covering single-line, heavy, doubled, and rounded-corner forms). Stripped in place.
//
// Design decisions:
//  * The walk is comment-scoped by construction (via `getAllComments`), so Unicode in string literals - e.g., a webUI label that legitimately renders
//    an arrow - is never touched. The rule physically cannot reach a non-comment AST node.
//  * Banner removal short-circuits the contents pass: within a single walk each comment is tested for a banner first, and a match removes the line and
//    `continue`s, so banner-removal and substitution never both apply to the same comment in one pass. Across ESLint's multi-pass fixing an em-dash run can
//    substitute to a hyphen run that a later pass then treats as a banner and removes; that convergence to a clean section break is benign.
//  * Banners that share a line with code are left alone, since removing the line would delete the code too; such cases fall through to the contents pass,
//    which doesn't match because banner runs aren't substitutable.
const ruleCommentStyle = {

  create(context) {

    const sourceCode = context.sourceCode;

    return {

      Program() {

        for(const comment of sourceCode.getAllComments()) {

          const bannerRange = findCommentBannerRange(sourceCode, comment);

          if(bannerRange !== null) {

            context.report({

              fix(fixer) {

                return fixer.removeRange(bannerRange);
              },
              loc: comment.loc,
              message: "Decorative banner separators are not allowed in comments. Use a plain section comment such as `// Section name.` instead."
            });

            continue;
          }

          const violation = findCommentContentsViolation(comment);

          if(violation === null) {

            continue;
          }

          context.report({

            fix(fixer) {

              return fixer.replaceTextRange(comment.range, violation.newSource);
            },
            loc: comment.loc,
            message: violation.message
          });
        }
      }
    };
  },
  meta: {

    docs: {

      description: "enforce ASCII-first comment style and disallow decorative banner separators",
      recommended: false
    },
    fixable: "code",
    schema: [],
    type: "suggestion"
  }
};

export default ruleCommentStyle;
