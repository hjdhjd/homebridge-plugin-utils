/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * array-bracket-spacing.test.mjs: Unit tests for the array-bracket-spacing rule covering spaced arrays of more than one element and unspaced single-element ones,
 * a hole counting as an element, empty arrays left alone, nested arrays and objects taking no exception, destructuring patterns with and without a type
 * annotation, multi-line arrays checked only at a bracket whose neighbor shares its line, and the comment beside a bracket that every fix keeps, with negative
 * passthrough cases proving the canonical forms, tuple types and member access are left alone.
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./array-bracket-spacing.mjs";
import ts from "typescript-eslint";

// The rule's report sentences, one for each bracket and each direction.
const CLOSING_MISSING = "Add a space before the closing bracket of an array with more than one element.";
const CLOSING_UNEXPECTED = "Remove the space before the closing bracket of a single-element array.";
const OPENING_MISSING = "Add a space after the opening bracket of an array with more than one element.";
const OPENING_UNEXPECTED = "Remove the space after the opening bracket of a single-element array.";

// RuleTester wired to the typescript-eslint parser, the parser the preset lints every file with, so the type-annotated pattern rows parse.
const ruleTester = new RuleTester({

  languageOptions: {

    parser: ts.parser
  }
});

ruleTester.run("array-bracket-spacing", rule, {

  invalid: [

    // An array of more than one element is spaced inside each bracket, every missing space marked at its bracket.
    {

      code: "const a = [1, 2];",
      errors: [ { column: 11, endColumn: 12, line: 1, message: OPENING_MISSING }, { column: 16, endColumn: 17, line: 1, message: CLOSING_MISSING } ],
      output: "const a = [ 1, 2 ];"
    },

    // A single element sits against each bracket, every unwanted space marked across its gap.
    {

      code: "const a = [ 1 ];",
      errors: [ { column: 12, endColumn: 13, line: 1, message: OPENING_UNEXPECTED }, { column: 14, endColumn: 15, line: 1, message: CLOSING_UNEXPECTED } ],
      output: "const a = [1];"
    },

    // A hole is an element: a lone hole reads as a single element, and holes beside one another read as an array of more than one.
    {

      code: "const a = [ , ];",
      errors: [ { message: OPENING_UNEXPECTED }, { message: CLOSING_UNEXPECTED } ],
      output: "const a = [,];"
    },
    {

      code: "const a = [,,];",
      errors: [ { message: OPENING_MISSING }, { message: CLOSING_MISSING } ],
      output: "const a = [ ,, ];"
    },

    // A trailing comma adds no element, and a spread element is one element like any other.
    {

      code: "const a = [ 1, ];",
      errors: [ { message: OPENING_UNEXPECTED }, { message: CLOSING_UNEXPECTED } ],
      output: "const a = [1,];"
    },
    {

      code: "const a = [ ...b ];",
      errors: [ { message: OPENING_UNEXPECTED }, { message: CLOSING_UNEXPECTED } ],
      output: "const a = [...b];"
    },

    // Any whitespace counts as a space, so a tab is deleted the way a space is.
    {

      code: "const a = [\t1\t];",
      errors: [ { message: OPENING_UNEXPECTED }, { message: CLOSING_UNEXPECTED } ],
      output: "const a = [1];"
    },

    // Nested arrays take no exception: the outer array is spaced around its inner ones, and each inner array follows its own element count.
    {

      code: "const a = [[ 1 ], [2, 3]];",
      errors: [ { column: 11, message: OPENING_MISSING }, { column: 13, message: OPENING_UNEXPECTED }, { column: 15, message: CLOSING_UNEXPECTED },
        { column: 19, message: OPENING_MISSING }, { column: 24, message: CLOSING_MISSING }, { column: 25, message: CLOSING_MISSING } ],
      output: "const a = [ [1], [ 2, 3 ] ];"
    },

    // Objects in arrays take no exception of their own: an array of objects is spaced, and a single object sits against the brackets.
    {

      code: "const a = [{ b: 1 }, { c: 2 }];",
      errors: [ { message: OPENING_MISSING }, { message: CLOSING_MISSING } ],
      output: "const a = [ { b: 1 }, { c: 2 } ];"
    },
    {

      code: "const a = [ { b: 1 } ];",
      errors: [ { message: OPENING_UNEXPECTED }, { message: CLOSING_UNEXPECTED } ],
      output: "const a = [{ b: 1 }];"
    },

    // A destructuring pattern reads the way an array expression does.
    {

      code: "const [ a ] = b;",
      errors: [ { message: OPENING_UNEXPECTED }, { message: CLOSING_UNEXPECTED } ],
      output: "const [a] = b;"
    },
    {

      code: "const [a, b] = c;",
      errors: [ { message: OPENING_MISSING }, { message: CLOSING_MISSING } ],
      output: "const [ a, b ] = c;"
    },

    // A type-annotated pattern's closing bracket is the token before the annotation, and the annotation's own array type is no array to check.
    {

      code: "function f([ a ]: number[]): void {}",
      errors: [ { message: OPENING_UNEXPECTED }, { column: 15, endColumn: 16, message: CLOSING_UNEXPECTED } ],
      output: "function f([a]: number[]): void {}"
    },
    {

      code: "function f([a, b]: number[]): void {}",
      errors: [ { message: OPENING_MISSING }, { column: 17, endColumn: 18, message: CLOSING_MISSING } ],
      output: "function f([ a, b ]: number[]): void {}"
    },

    // An optional pattern in a declaration puts its question mark before the annotation, so that mark is the token the closing gap is read against.
    {

      code: "declare function f([a] ?: number[]): void;",
      errors: [{ column: 23, endColumn: 24, message: CLOSING_UNEXPECTED }],
      output: "declare function f([a]?: number[]): void;"
    },

    // A multi-line array is checked only at a bracket whose neighbor shares its line, wherever that bracket sits.
    {

      code: "const a = [1,\n  2];",
      errors: [ { line: 1, message: OPENING_MISSING }, { line: 2, message: CLOSING_MISSING } ],
      output: "const a = [ 1,\n  2 ];"
    },
    {

      code: "const a = [\n  1, 2];",
      errors: [{ line: 2, message: CLOSING_MISSING }],
      output: "const a = [\n  1, 2 ];"
    },
    {

      code: "const a = [1, 2\n];",
      errors: [{ line: 1, message: OPENING_MISSING }],
      output: "const a = [ 1, 2\n];"
    },

    // A comment beside a single element's opening bracket survives the fix, which deletes only the whitespace around it, the gap marked whole.
    {

      code: "const a = [ /* only */ 1];",
      errors: [{ column: 12, endColumn: 24, line: 1, message: OPENING_UNEXPECTED }],
      output: "const a = [/* only */1];"
    },

    // A comment beside a single element's closing bracket survives the same way.
    {

      code: "const a = [1 /* only */ ];",
      errors: [{ column: 13, endColumn: 25, line: 1, message: CLOSING_UNEXPECTED }],
      output: "const a = [1/* only */];"
    },

    // Every comment in a gap survives, in its order, and a gap at each bracket keeps its own comments.
    {

      code: "const a = [ /* one */ /* two */ 1 /* three */ ];",
      errors: [ { message: OPENING_UNEXPECTED }, { message: CLOSING_UNEXPECTED } ],
      output: "const a = [/* one *//* two */1/* three */];"
    },

    // A space added to a gap holding a comment goes against the bracket, so the comment stays beside its element.
    {

      code: "const a = [/* first */1, 2/* last */];",
      errors: [ { message: OPENING_MISSING }, { message: CLOSING_MISSING } ],
      output: "const a = [ /* first */1, 2/* last */ ];"
    }
  ],

  valid: [

    // The canonical forms: spaced for more than one element, unspaced for one, a hole counting as an element.
    "const a = [ 1, 2 ];",
    "const a = [1];",
    "const a = [,];",
    "const a = [ ,, ];",
    "const a = [1,];",

    // An empty array holds no element, so its spacing is none of the rule's business.
    "const a = [];",
    "const a = [ ];",

    // Nested arrays and objects in their canonical forms.
    "const a = [ [1], [ 2, 3 ] ];",
    "const a = [{ b: 1 }];",
    "const a = [ { b: 1 }, { c: 2 } ];",

    // Destructuring patterns, with and without a type annotation, in their canonical forms.
    "const [a] = b;",
    "const [ a, b ] = c;",
    "function f([a]: number[]): void {}",
    "function f([ a, b ]: number[]): void {}",

    // A bracket on a line apart from its neighbor is never checked, including one a line comment separates from the last element.
    "const a = [\n  1,\n  2\n];",
    "const a = [ 1, 2 // last\n];",

    // A gap holding a comment is spaced when whitespace sits anywhere in it, and unspaced when none does.
    "const a = [/* only */1];",
    "const a = [ /* first */ 1, 2 ];",

    // A tuple type and a member access use brackets without being arrays.
    "type T = [string, number];",
    "const a = b[ 0 ];"
  ]
});
