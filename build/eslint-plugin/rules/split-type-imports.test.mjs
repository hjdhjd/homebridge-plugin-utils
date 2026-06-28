/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * split-type-imports.test.mjs: Unit tests for the split-type-imports rule. Covers the single split and collapse cases, default-specifier handling,
 * re-exports, alias and import-attribute preservation, comment-safety suppression across every unpreservable region, and the negative passthrough cases
 * that prove canonical declarations and namespace / default-only / unmarked imports are correctly skipped.
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./split-type-imports.mjs";
import ts from "typescript-eslint";

// RuleTester wired to the typescript-eslint parser. The rule needs the typescript-eslint AST shape - inline `type` qualifiers on specifiers manifest as
// `importKind` / `exportKind` fields that espree (the default parser) does not produce.
const ruleTester = new RuleTester({

  languageOptions: {

    parser: ts.parser
  }
});

ruleTester.run("split-type-imports", rule, {

  invalid: [

    // Single inline type with a value specifier. Canonical form lifts the type to its own `import type` declaration and leaves the value declaration
    // behind. Specifier text round-trips exactly via range-based slicing.
    {

      code: "import { type A, foo } from \"x\";",
      errors: [{ message: /Imports from "x": type specifiers must live in a separate `import type` declaration/ }],
      output: "import type { A } from \"x\";\nimport { foo } from \"x\";"
    },

    // Multiple inline types with a value specifier. The type declaration carries every inline-marked specifier in source order; the value declaration
    // retains the remaining value specifier(s) in source order. Member sort is owned by `sort-imports` and is not this rule's concern.
    {

      code: "import { type A, type B, foo } from \"x\";",
      errors: 1,
      output: "import type { A, B } from \"x\";\nimport { foo } from \"x\";"
    },

    // Multiple types and multiple values. Splits cleanly.
    {

      code: "import { type A, type B, foo, bar } from \"x\";",
      errors: 1,
      output: "import type { A, B } from \"x\";\nimport { foo, bar } from \"x\";"
    },

    // Collapse case: every named specifier carries the inline qualifier, no values remain. Canonical form is the single top-level type-only declaration;
    // the rule emits no second declaration.
    {

      code: "import { type A } from \"x\";",
      errors: 1,
      output: "import type { A } from \"x\";"
    },

    // Collapse case with multiple inline types.
    {

      code: "import { type A, type B, type C } from \"x\";",
      errors: 1,
      output: "import type { A, B, C } from \"x\";"
    },

    // Default specifier riding alongside inline types and values. The default joins the value declaration (`import D, { ... } from "x"`) since its
    // runtime semantics are preserved by staying on the value side.
    {

      code: "import D, { type A, foo } from \"x\";",
      errors: 1,
      output: "import type { A } from \"x\";\nimport D, { foo } from \"x\";"
    },

    // Default specifier with only inline types and no value specifiers. The value declaration collapses its empty brace clause to the bare default form
    // `import D from "x"`, since an empty `{}` is a syntactic but visually ugly artifact.
    {

      code: "import D, { type A } from \"x\";",
      errors: 1,
      output: "import type { A } from \"x\";\nimport D from \"x\";"
    },

    // Default specifier with multiple inline types and no values - same collapse of the empty brace clause.
    {

      code: "import D, { type A, type B } from \"x\";",
      errors: 1,
      output: "import type { A, B } from \"x\";\nimport D from \"x\";"
    },

    // Alias preservation on inline type specifiers via range-based slicing. `type A as Aa` round-trips intact, including whitespace inside the alias.
    {

      code: "import { type A as Aa, foo } from \"x\";",
      errors: 1,
      output: "import type { A as Aa } from \"x\";\nimport { foo } from \"x\";"
    },

    // Alias preservation on value specifiers too. Range-based slicing carries `foo as bar` through verbatim.
    {

      code: "import { type A, foo as bar } from \"x\";",
      errors: 1,
      output: "import type { A } from \"x\";\nimport { foo as bar } from \"x\";"
    },

    // Import attributes (the `with { type: "json" }` clause) are carried verbatim into both emitted declarations so the runtime loader honors them on the
    // value side and the compiler honors them on the type side.
    {

      code: "import { type A, foo } from \"x\" with { type: \"json\" };",
      errors: 1,
      output: "import type { A } from \"x\" with { type: \"json\" };\nimport { foo } from \"x\" with { type: \"json\" };"
    },

    // Intra-specifier block comments are preserved by range-based slicing. The comment lives inside the specifier's range and rides along when its text
    // is sliced into the type-declaration output.
    {

      code: "import { type /* note */ A, foo } from \"x\";",
      errors: 1,
      output: "import type { /* note */ A } from \"x\";\nimport { foo } from \"x\";"
    },

    // Re-export form: inline type plus value specifier. Same split shape with `export type` / `export` heads.
    {

      code: "export { type A, foo } from \"x\";",
      errors: [{ message: /Re-exports from "x": type specifiers must live in a separate `export type` declaration/ }],
      output: "export type { A } from \"x\";\nexport { foo } from \"x\";"
    },

    // Re-export form: collapse case when every named specifier is type-only.
    {

      code: "export { type A, type B } from \"x\";",
      errors: 1,
      output: "export type { A, B } from \"x\";"
    },

    // Inline source order preserved: the rule does not sort. Z, Y, X stays Z, Y, X. `sort-imports` handles within-brace alphabetization on a subsequent
    // autofix pass.
    {

      code: "import { type Z, type Y, type X, foo } from \"x\";",
      errors: 1,
      output: "import type { Z, Y, X } from \"x\";\nimport { foo } from \"x\";"
    },

    // Inter-specifier block comment: unpreservable. The comment's destination after the split (which side of the split, between which two specifiers) is
    // genuinely ambiguous, and silently picking one is worse than leaving the rewrite to a human. Report the violation, suppress the autofix.
    {

      code: "import { type A, /* between */ foo } from \"x\";",
      errors: [{ message: /Autofix suppressed because a comment in the declaration cannot be safely preserved/ }],
      output: null
    },

    // Inter-specifier line comment: same suppression. The helper considers any comment kind, not just block comments.
    {

      code: "import { type A,\n  // pinned for now\n  foo } from \"x\";",
      errors: 1,
      output: null
    },

    // Comment between the `import` keyword and the default specifier. The autofix replaces the entire declaration and would otherwise drop this comment.
    {

      code: "import /* default-only */ D, { type A, foo } from \"x\";",
      errors: 1,
      output: null
    },

    // Trailing comment inside the brace list - after the last specifier, before the closing brace. Outside any specifier's range and outside the
    // post-source tail slice.
    {

      code: "import { type A, foo /* trailing */ } from \"x\";",
      errors: 1,
      output: null
    },

    // Comment between the closing brace and the `from` keyword - same unpreservable region.
    {

      code: "import { type A, foo } /* trailing */ from \"x\";",
      errors: 1,
      output: null
    },

    // Comment between `from` and the source string literal - again unpreservable, since `getText(node.source)` only captures the literal itself and the
    // tail slice starts at the end of that literal.
    {

      code: "import { type A, foo } from /* path */ \"x\";",
      errors: 1,
      output: null
    },

    // Comment inside the post-source tail slice (around an import-attributes clause) IS preserved by `declarationTail`, so the autofix runs normally
    // and the comment survives in both emitted declarations.
    {

      code: "import { type A, foo } from \"x\" /* odd */ with { type: \"json\" };",
      errors: 1,
      output: "import type { A } from \"x\" /* odd */ with { type: \"json\" };\nimport { foo } from \"x\" /* odd */ with { type: \"json\" };"
    },

    // Same-line trailing comment after the declaration's semicolon. The comment survives the rewrite but lands visually attached to the last emitted
    // declaration, even though the author wrote it for the whole import. Treated as unpreservable.
    {

      code: "import { type A, foo } from \"x\"; // legacy import",
      errors: 1,
      output: null
    },

    // Same-line leading block comment before the declaration. After a split the comment would label only the first emitted declaration.
    {

      code: "/* legacy */ import { type A, foo } from \"x\";",
      errors: 1,
      output: null
    },

    // Comments on adjacent lines (not the same line as the declaration) are not visually attached to the declaration's line and do not trigger
    // suppression - autofix runs as normal and the surrounding comments survive in place because they fall outside the replacement range.
    {

      code: "// previous-line comment\nimport { type A, foo } from \"x\";\n// following-line comment",
      errors: 1,
      output: "// previous-line comment\nimport type { A } from \"x\";\nimport { foo } from \"x\";\n// following-line comment"
    }
  ],

  valid: [

    // Already top-level type-only declarations - canonical form. The rule has nothing to do.
    "import type { A } from \"x\";",
    "import type { A, B, C } from \"x\";",
    "import type D from \"x\";",
    "import type { A, B } from \"x\";\nimport { foo } from \"x\";",

    // Plain value imports of every shape - no inline `type` qualifier means no policy violation. The upstream `consistent-type-imports` rule handles
    // unmarked types separately; this rule's domain is only the inline-marked case.
    "import { foo } from \"x\";",
    "import { foo, bar } from \"x\";",
    "import D from \"x\";",
    "import D, { foo } from \"x\";",
    "import * as ns from \"x\";",
    "import \"x\";",

    // Re-exports without inline `type` qualifiers.
    "export { foo } from \"x\";",
    "export { foo, bar } from \"x\";",
    "export type { A, B } from \"x\";",

    // Local re-export without a source clause - nothing for this rule to act on.
    "const foo = 1; export { foo };",

    // Namespace imports are never combined with named specifiers, so even an otherwise-mixed file leaves them untouched.
    "import * as ns from \"x\";\nimport { foo } from \"y\";"
  ]
});
