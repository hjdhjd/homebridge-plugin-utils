/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * blank-line-after-open-brace.test.mjs: Unit tests for the blank-line-after-open-brace rule covering each visitor (BlockStatement, ClassBody,
 * ObjectExpression, TSInterfaceBody, TSTypeAliasDeclaration), the canonical single-line and already-padded forms that pass without flagging, and the
 * nested TS type-literal recursion that drives the rule into the deeper levels of an interface or type-alias body.
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./blank-line-after-open-brace.mjs";
import ts from "typescript-eslint";

// RuleTester wired to the typescript-eslint parser so the test suite can exercise TSInterfaceBody and TSTypeAliasDeclaration cases. The non-TS visitors
// (BlockStatement, ClassBody, ObjectExpression) parse identically under either parser, so a single tester covers every case.
const ruleTester = new RuleTester({

  languageOptions: {

    parser: ts.parser
  }
});

ruleTester.run("blank-line-after-open-brace", rule, {

  invalid: [

    // BlockStatement followed immediately by content on the next line - autofix inserts a single newline after the opening brace.
    {

      code: "function foo() {\n  return 1;\n}",
      errors: [{ message: /Expected blank line after left brace/ }],
      output: "function foo() {\n\n  return 1;\n}"
    },

    // ClassBody case - same pattern. The class body's opening brace gets a blank line after it.
    {

      code: "class Foo {\n  bar() { return 1; }\n}",
      errors: 1,
      output: "class Foo {\n\n  bar() { return 1; }\n}"
    },

    // ObjectExpression case. Multi-line object literal whose first property is on the very next line.
    {

      code: "const x = {\n  a: 1,\n  b: 2\n};",
      errors: 1,
      output: "const x = {\n\n  a: 1,\n  b: 2\n};"
    },

    // ObjectExpression nested as a class-property initializer. The rule's header calls this case out specifically as covered via the `ObjectExpression`
    // visitor's automatic AST walk. The outer class body is already padded so this test isolates the inner object's blank-line gap; only the inner brace
    // fires.
    {

      code: "class Foo {\n\n  config = {\n    a: 1\n  };\n}",
      errors: 1,
      output: "class Foo {\n\n  config = {\n\n    a: 1\n  };\n}"
    },

    // TSInterfaceBody case. The opening `{` of the interface body needs the blank line.
    {

      code: "interface Foo {\n  bar: number;\n}",
      errors: 1,
      output: "interface Foo {\n\n  bar: number;\n}"
    },

    // TSTypeAliasDeclaration with a type literal annotation - the literal's opening `{` gets the blank line.
    {

      code: "type Foo = {\n  bar: number;\n};",
      errors: 1,
      output: "type Foo = {\n\n  bar: number;\n};"
    },

    // Nested type literal inside an interface property. The rule manually descends from TSInterfaceBody into TSTypeLiteral members (which have no
    // dedicated visitor in this rule), so the inner brace is flagged independently of the outer interface brace.
    {

      code: "interface Foo {\n\n  bar: {\n    baz: number;\n  };\n}",
      errors: 1,
      output: "interface Foo {\n\n  bar: {\n\n    baz: number;\n  };\n}"
    }
  ],

  valid: [

    // Empty braces - canonical, no content to pad.
    "function foo() {}",
    "class Foo {}",
    "const x = {};",
    "interface Foo {}",
    "type Foo = {};",

    // Single-line braces with content - canonical, no newline after `{` so the rule doesn't engage.
    "function foo() { return 1; }",
    "const x = { a: 1 };",

    // Multi-line braces with the canonical blank line already in place.
    "function foo() {\n\n  return 1;\n}",
    "class Foo {\n\n  bar() { return 1; }\n}",
    "const x = {\n\n  a: 1\n};",
    "interface Foo {\n\n  bar: number;\n}",
    "type Foo = {\n\n  bar: number;\n};",

    // Nested type literal already padded.
    "interface Foo {\n\n  bar: {\n\n    baz: number;\n  };\n}",

    // Type alias whose annotation is not a type literal - the rule's TSTypeAliasDeclaration visitor returns early.
    "type Foo = number;",
    "type Bar = string | number;"
  ]
});
