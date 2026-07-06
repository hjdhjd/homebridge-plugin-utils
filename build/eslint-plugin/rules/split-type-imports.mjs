/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * split-type-imports.mjs: Require type imports and re-exports to live in declaration-level `import type` / `export type` statements rather than as
 * specifier-level qualifiers (`import { type Foo, bar } from "..."`).
 */

// Test whether a named specifier carries an inline `type` qualifier. ImportSpecifier exposes the qualifier on `importKind`; ExportSpecifier exposes it on
// `exportKind`. Either being `"type"` indicates the qualifier is present.
function isInlineTypeSpecifier(specifier) {

  return (specifier.importKind ?? specifier.exportKind) === "type";
}

// Slide an exclusive end offset forward past a trailing semicolon. The typescript-eslint parser's declaration range[1] usually stops at the source
// string's closing quote (or the import-attributes clause), leaving the terminating `;` as a separate punctuator token. Sliding forward when the
// character at the current end is `;` makes the replacement range cover the original semicolon so the rewritten text supplies its own without doubling.
function includeTrailingSemicolon(sourceCode, end) {

  return (sourceCode.text[end] === ";") ? (end + 1) : end;
}

// Slide an exclusive end offset back past a trailing semicolon. The mirror of `includeTrailingSemicolon` for the case where range[1] already covers the
// terminator: when the character just before `end` is `;`, return `end - 1` so the resulting offset stops at the last token of the declaration's body.
// The two helpers together let downstream code work uniformly against either parser configuration.
function excludeTrailingSemicolon(sourceCode, end) {

  return (sourceCode.text[end - 1] === ";") ? (end - 1) : end;
}

// Reconstruct a named specifier's source text without its leading `type` qualifier. For inline-marked specifiers, the first token is the keyword `type`,
// so we slice from immediately after that keyword's range through the specifier's end and trim. For unmarked specifiers, we take the specifier text
// verbatim. Range-based slicing carries alias clauses (`as Local`) and any intra-specifier comments along with the name without name-based reconstruction.
function specifierTextStripped(sourceCode, specifier) {

  if(isInlineTypeSpecifier(specifier)) {

    const firstToken = sourceCode.getFirstToken(specifier);

    return sourceCode.text.slice(firstToken.range[1], specifier.range[1]).trim();
  }

  return sourceCode.text.slice(specifier.range[0], specifier.range[1]).trim();
}

// Compute the [start, end] offsets of the declaration's post-source clause. The clause covers everything between the source string's closing quote and
// the terminating semicolon (or the declaration's end when the parser already excludes the semicolon). For most declarations the slice is empty; for
// declarations carrying `with { type: "json" }` import attributes (or the legacy `assert { ... }` form) it spans the attribute clause. This is the single
// source of truth for what counts as "the tail" - both the text-slicing path in `declarationTail` and the comment-membership check in
// `isCommentPreservable` derive their bounds from this helper so they cannot drift apart.
function declarationTailRange(sourceCode, node) {

  return [ node.source.range[1], excludeTrailingSemicolon(sourceCode, node.range[1]) ];
}

// Capture the trailing clause text of a declaration after the source string. Empty for most declarations; preserves `with { type: "json" }` import
// attributes (and the legacy `assert { ... }` form) when present.
function declarationTail(sourceCode, node) {

  const [ start, end ] = declarationTailRange(sourceCode, node);

  return sourceCode.text.slice(start, end).trim();
}

// Compute the leading whitespace of a declaration's line. Used to indent the second emitted declaration so it lines up under the first. We read the line
// directly rather than emitting a fixed number of spaces so the indent honors tabs or mixed whitespace if either is ever in use.
function declarationIndent(sourceCode, node) {

  const line = sourceCode.lines[node.loc.start.line - 1];

  return line.slice(0, node.loc.start.column);
}

// Derive the kind-discriminant strings for a declaration in one place. The rule branches on whether the node is an `ImportDeclaration` or an
// `ExportNamedDeclaration` to pick the message wording, the declaration head keyword, and the kind keyword used by the value-side renderer; centralizing
// the discriminant derivations keeps them from drifting and gives every downstream consumer one object to read from instead of separate ternaries to evaluate.
function declarationFlavor(node) {

  const isImport = node.type === "ImportDeclaration";

  return {

    head: isImport ? "import type" : "export type",
    kind: isImport ? "import" : "export",
    kindWord: isImport ? "Imports" : "Re-exports"
  };
}

// Classify a declaration's specifiers into the buckets the rule cares about: inline-`type`-marked named specifiers, unmarked named (value) specifiers,
// and a single default specifier (imports only). Pure - takes the raw specifiers array and returns a structured object, with no dependency on `sourceCode`
// or `context`. Used by the rule's per-declaration check to drive the decision tree (skip vs split vs collapse) and by the render helpers downstream.
// Namespace specifiers (`* as ns`) fall through the switch unclassified: per the ECMAScript `ImportClause` grammar they never appear alongside named
// specifiers, so a declaration containing one yields empty `typeSpecs` and the rule's `typeSpecs.length === 0` short-circuit dismisses it.
function classifySpecifiers(specifiers) {

  const typeSpecs = [];
  const valueSpecs = [];
  let defaultSpec = null;

  for(const specifier of specifiers) {

    switch(specifier.type) {

      case "ImportSpecifier":
      case "ExportSpecifier": {

        if(isInlineTypeSpecifier(specifier)) {

          typeSpecs.push(specifier);
        } else {

          valueSpecs.push(specifier);
        }

        break;
      }

      case "ImportDefaultSpecifier": {

        defaultSpec = specifier;

        break;
      }
    }
  }

  return { defaultSpec, typeSpecs, valueSpecs };
}

// Test whether a comment that sits inside the declaration's range falls inside one of the regions the autofix preserves: any specifier's own range
// (carried along by range-based slicing) and the post-source tail range (carried verbatim into both emitted declarations).
function isCommentPreservable(sourceCode, comment, node) {

  for(const specifier of node.specifiers) {

    if((specifier.type !== "ImportSpecifier") && (specifier.type !== "ExportSpecifier")) {

      continue;
    }

    if((comment.range[0] >= specifier.range[0]) && (comment.range[1] <= specifier.range[1])) {

      return true;
    }
  }

  const [ tailStart, tailEnd ] = declarationTailRange(sourceCode, node);

  return (comment.range[0] >= tailStart) && (comment.range[1] <= tailEnd);
}

// Detect whether any comment in or visually adjacent to the declaration lives outside the regions the autofix actually preserves. Unpreservable comments
// include those between `import` and the brace, between commas in the brace list, between `}` and `from`, between `from` and the source string, and
// same-line leading or trailing comments that visually attach to the declaration's lines but fall outside the replacement range. The presence of any such
// comment disqualifies the declaration from autofix, and the rule falls back to report-only so the author can rewrite the declaration deliberately.
function hasUnpreservableCommentInDeclaration(sourceCode, node) {

  for(const comment of sourceCode.getCommentsInside(node)) {

    if(isCommentPreservable(sourceCode, comment, node)) {

      continue;
    }

    return true;
  }

  for(const comment of sourceCode.getCommentsBefore(node)) {

    if(comment.loc.end.line === node.loc.start.line) {

      return true;
    }
  }

  for(const comment of sourceCode.getCommentsAfter(node)) {

    if(comment.loc.start.line === node.loc.end.line) {

      return true;
    }
  }

  return false;
}

// Render the type-only declaration line. The flavor's `head` field selects between `import type` / `export type`; the rest is uniform.
function renderTypeDeclaration({ flavor, sourceText, tailSuffix, typeText }) {

  return flavor.head + " { " + typeText + " } from " + sourceText + tailSuffix + ";";
}

// Render the value-side declaration line. For re-exports the form is always `export { ... } from "x"` since re-exports cannot carry a default. For
// imports, the form depends on whether a default specifier survives the split and whether any named value specifiers remain: a default with no named
// values collapses the brace clause entirely (`import D from "x"`), a default with named values keeps both (`import D, { ... } from "x"`), and no
// default emits the bare brace form (`import { ... } from "x"`).
function renderValueDeclaration({ defaultSpec, flavor, sourceText, tailSuffix, valueText }) {

  if(flavor.kind === "export") {

    return "export { " + valueText + " } from " + sourceText + tailSuffix + ";";
  }

  if((defaultSpec !== null) && !valueText) {

    return "import " + defaultSpec.local.name + " from " + sourceText + tailSuffix + ";";
  }

  if(defaultSpec !== null) {

    return "import " + defaultSpec.local.name + ", { " + valueText + " } from " + sourceText + tailSuffix + ";";
  }

  return "import { " + valueText + " } from " + sourceText + tailSuffix + ";";
}

// Render the canonical replacement text for a declaration that contains inline `type` specifiers. When the declaration's remaining content (after lifting
// out the inline types) is empty - no value specifiers and no default - the result is a single top-level `import type` / `export type` declaration. When
// content remains, the result is two declarations: a type-only declaration first, then a regular declaration carrying the values and any default.
// Invariant at the call site: `typeSpecs.length > 0` (the `checkDeclaration` short-circuit). By the ECMAScript `ImportClause` grammar this implies no
// namespace specifier sits alongside the named specifiers; by the parser's specifier-kind contract it also implies the declaration is not itself top-level
// type-only (such a declaration parses with `importKind === "value"` on its specifiers, so `typeSpecs` would have stayed empty).
function renderSplit({ defaultSpec, flavor, node, sourceCode, typeSpecs, valueSpecs }) {

  const sourceText = sourceCode.getText(node.source);
  const tail = declarationTail(sourceCode, node);
  const tailSuffix = tail ? (" " + tail) : "";
  const typeText = typeSpecs.map((s) => specifierTextStripped(sourceCode, s)).join(", ");
  const typeDecl = renderTypeDeclaration({ flavor, sourceText, tailSuffix, typeText });

  if((valueSpecs.length === 0) && (defaultSpec === null)) {

    return typeDecl;
  }

  const indent = declarationIndent(sourceCode, node);
  const valueText = valueSpecs.map((s) => specifierTextStripped(sourceCode, s)).join(", ");
  const valueDecl = renderValueDeclaration({ defaultSpec, flavor, sourceText, tailSuffix, valueText });

  return typeDecl + "\n" + indent + valueDecl;
}

// Require type imports and re-exports to live at the declaration level (`import type` / `export type`) rather than as inline specifier qualifiers
// (`import { type Foo, bar } from "..."`).
//
// Policy rationale (single source of truth - if this comment moves, update the README and the plugin index too):
//
// The TypeScript grammar draws a real line between a declaration that exists only at compile time (`import type { ... }` is fully erased) and a
// declaration that produces a runtime import. The inline `type` qualifier is a per-specifier accommodation introduced in TS 4.5 so that non-tsc
// transpilers (Babel, esbuild, swc) could elide individual type-only specifiers without whole-program type analysis. It works, but it expresses type-ness
// at the specifier level - smuggling an erased token into a runtime declaration and asking the reader to classify each specifier in the brace list.
//
// Choosing to express type-ness at the declaration level wherever possible aligns the file's shape with the language's own categorization. A reader
// scanning the top of a file sees two flat tiers: lines that survive to runtime (`import { ... }`) and lines that do not (`import type { ... }`). Brace
// contents stay single-kind. Refactors that flip a name between type-only and runtime use move a specifier between two stable lines instead of reshaping
// a mixed declaration. And `^import type` becomes a complete grep for compile-time-only dependencies, which is invisible under the inline form.
//
// This rule pairs with `@typescript-eslint/consistent-type-imports` configured with `prefer: "type-imports"` and `fixStyle: "separate-type-imports"`.
// That upstream rule owns the question "is this type-only specifier marked at all?"; this rule owns "is the marking in the canonical declaration-level
// form?". The two concerns are crisp and non-overlapping; together they fully express the split-form policy.
//
// Cases covered:
//  * `import { type A, foo } from "x"`                  flagged; autofix splits into `import type { A } from "x";\nimport { foo } from "x";`.
//  * `import { type A, type B } from "x"`               flagged; autofix collapses to `import type { A, B } from "x";` (no value side).
//  * `import { type A as Aa, foo } from "x"`            flagged; autofix preserves aliases via range-based slicing.
//  * `import D, { type A, foo } from "x"`               flagged; autofix splits with the default riding the value declaration.
//  * `import D, { type A } from "x"`                    flagged; autofix splits and omits the empty value brace (`import D from "x";`).
//  * `export { type A, foo } from "x"`                  flagged; same split for re-exports.
//  * Import attributes (`with { type: "json" }`)        carried verbatim into both emitted declarations.
//  * `import type { A } from "x"`                       canonical; ignored.
//  * `import { foo } from "x"`                          no type specifier; ignored (upstream owns the unmarked-type case).
//
// Comment safety: the autofix is suppressed and the rule falls back to report-only when a comment in the declaration falls outside the two preservable
// regions (any specifier's own range, and the post-source tail slice). Comments between brace tokens, between `from` and the source string, or attached
// to the same line as the declaration are unpreservable and disqualify the autofix.
const ruleSplitTypeImports = {

  create(context) {

    const sourceCode = context.sourceCode;

    function checkDeclaration(node) {

      const { defaultSpec, typeSpecs, valueSpecs } = classifySpecifiers(node.specifiers);

      if(typeSpecs.length === 0) {

        return;
      }

      const flavor = declarationFlavor(node);
      const sourceText = sourceCode.getText(node.source);
      const baseMessage = flavor.kindWord + " from " + sourceText + ": type specifiers must live in a separate `" + flavor.head +
        "` declaration, not as inline `type` qualifiers.";
      const loc = { end: typeSpecs.at(-1).loc.end, start: typeSpecs[0].loc.start };

      if(hasUnpreservableCommentInDeclaration(sourceCode, node)) {

        context.report({

          loc,
          message: baseMessage +
            " Autofix suppressed because a comment in the declaration cannot be safely preserved by the rewrite; rewrite the declaration manually.",
          node
        });

        return;
      }

      const replacement = renderSplit({ defaultSpec, flavor, node, sourceCode, typeSpecs, valueSpecs });
      const range = [ node.range[0], includeTrailingSemicolon(sourceCode, node.range[1]) ];

      context.report({

        fix(fixer) {

          return fixer.replaceTextRange(range, replacement);
        },
        loc,
        message: baseMessage,
        node
      });
    }

    return {

      ExportNamedDeclaration(node) {

        if(node.source !== null) {

          checkDeclaration(node);
        }
      },

      ImportDeclaration(node) {

        checkDeclaration(node);
      }
    };
  },
  meta: {

    docs: {

      description: "require type imports and re-exports to live in declaration-level `import type` / `export type` statements rather than as inline " +
        "specifier-level `type` qualifiers",
      recommended: false
    },
    fixable: "code",
    schema: [],
    type: "suggestion"
  }
};

export default ruleSplitTypeImports;
