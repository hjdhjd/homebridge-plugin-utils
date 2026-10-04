/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * no-boolean-error-predicate.test.mjs: Unit tests for the no-boolean-error-predicate rule. Covers every refused predicate shape on `assert.rejects`, on
 * `assert.throws` and through `assert.strict`, a predicate passed by name and resolved through scope in each direction a shadowing binding can turn the
 * verdict, and the accepted cases that prove node:assert's own forms, the validation form, an identity comparison of the parameter under any name or wrapper,
 * and every name the rule does not judge are left alone.
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./no-boolean-error-predicate.mjs";
import ts from "typescript-eslint";

// The rule's message, spelled out here so the suite holds its exact wording rather than a fragment of it.
const MESSAGE = "State the claim with node:assert's class form, its object form naming the class by constructor, or a validation function that asserts and " +
  "returns true; a predicate that returns a boolean hides which condition failed, and an identity comparison of its own parameter is the one result it may return.";

// The virtual filename for a case written in TypeScript syntax. The parser reads an angle-bracket cast as JSX in any file it does not know to be TypeScript.
const TS = "case.ts";

// RuleTester wired to the typescript-eslint parser, which is the parser the preset lints every consumer file with, and whose scope analysis carries the
// TypeScript overload and type-assertion shapes the rule reads.
const ruleTester = new RuleTester({

  languageOptions: {

    parser: ts.parser
  }
});

ruleTester.run("no-boolean-error-predicate", rule, {

  invalid: [

    // A compound condition, the shape the rule exists for: node:assert can only say the predicate answered false, never which part of it did.
    {

      code: "assert.throws(() => f(), (error) => (error instanceof TypeError) && error.message.includes(\"x\"));",
      errors: [{ message: MESSAGE }]
    },

    // The same compound written with `||`, on the rejection assertion.
    {

      code: "await assert.rejects(p, (error) => (error.name === \"AbortError\") || (error.name === \"TimeoutError\"));",
      errors: 1
    },

    // A lone `instanceof`, which the class form states with a report that names the class it received.
    {

      code: "await assert.rejects(p, (error) => error instanceof RangeError);",
      errors: 1
    },

    // A lone guard call, whose own conditions are as hidden as a compound's.
    {

      code: "await assert.rejects(p, (error) => isHbpuAbortReason(error, \"shutdown\"));",
      errors: 1
    },

    // A negation of a condition.
    {

      code: "assert.throws(() => f(), (error) => !(error instanceof TypeError));",
      errors: 1
    },

    // A double negation, which turns a value into a boolean answer.
    {

      code: "assert.throws(() => f(), (error) => !!error.code);",
      errors: 1
    },

    // A `Boolean()` call, the same conversion spelled as a call.
    {

      code: "assert.throws(() => f(), (error) => Boolean(error.code));",
      errors: 1
    },

    // A conditional expression is refused even when one branch is an identity comparison, because the function answers one value and that value is the ternary.
    {

      code: "await assert.rejects(p, (error) => (error instanceof TypeError) ? true : error === reason);",
      errors: 1
    },

    // A strict equality between values the test holds, which leaves the parameter out entirely.
    {

      code: "await assert.rejects(p, (error) => reason === expected);",
      errors: 1
    },

    // A comparison of the parameter's property rather than the parameter, which the object form states field by field.
    {

      code: "await assert.rejects(p, (error) => error.cause === boom);",
      errors: 1
    },

    // A property read through a cast is still a property, so the wrapper changes nothing about the verdict.
    {

      code: "await assert.rejects(p, (error: unknown) => (error as Error).name === \"AbortError\");",
      errors: 1,
      filename: TS
    },

    // Strict inequality is not an identity claim.
    {

      code: "await assert.rejects(p, (error) => error !== reason);",
      errors: 1
    },

    // A destructured first parameter has no single binding to be identical to, so a comparison of one of its fields is a property comparison.
    {

      code: "await assert.rejects(p, ({ code }) => code === \"ENOENT\");",
      errors: 1
    },

    // A block body whose one return is a compound.
    {

      code: "await assert.rejects(p, (error) => {\n  return isHbpuAbortReason(error, \"failed\") && (error.cause === boom);\n});",
      errors: 1
    },

    // A block body with one `return true` and one `return false`, whose false path is a boolean answer however many assertions sit beside it.
    {

      code: "assert.throws(() => f(), (error) => {\n  if(!(error instanceof TypeError)) {\n    return false;\n  }\n\n  return true;\n});",
      errors: 1
    },

    // A bare `return;` answers undefined, which is a value other than true, so it is read as the `false` path above is.
    {

      code: "assert.throws(() => f(), (error) => {\n  if(!(error instanceof TypeError)) {\n    return;\n  }\n\n  return true;\n});",
      errors: 1
    },

    // A `return true` beside a returned identity comparison gives the function more than one answer, and identity is accepted only as its one answer.
    {

      code: "await assert.rejects(p, (error) => {\n  if(ready) {\n    return true;\n  }\n\n  return error === reason;\n});",
      errors: 1
    },

    // Identity comparisons returned from separate paths are separate answers as well.
    {

      code: "await assert.rejects(p, (error) => {\n  if(ready) {\n    return error === first;\n  }\n\n  return error === second;\n});",
      errors: 1
    },

    // A function expression written inline reads exactly as an arrow does.
    {

      code: "assert.throws(() => f(), function(error) {\n  return error instanceof TypeError;\n});",
      errors: 1
    },

    // node:assert's other spelling, on each assertion.
    {

      code: "assert.strict.throws(() => f(), (error) => error instanceof TypeError);",
      errors: 1
    },
    {

      code: "await assert.strict.rejects(p, (error) => error instanceof TypeError);",
      errors: 1
    },

    // A `const` arrow passed by name is resolved and judged, and the report lands on the name at the call rather than on the declaration.
    {

      code: "const refusal = (error) => (error instanceof TypeError) && error.message.includes(\"x\");\nassert.throws(() => f(), refusal);",
      errors: [{ column: 26, line: 2, message: MESSAGE }]
    },

    // The same name passed to several calls is reported once per call, since each call is a site that needs its own native form.
    {

      code: "const refusal = (error) => error instanceof TypeError;\nassert.throws(() => f(), refusal);\nassert.throws(() => g(), refusal);\n" +
        "assert.throws(() => h(), refusal);",
      errors: 3
    },

    // A function declaration passed by name, used before the declaration it hoists from.
    {

      code: "assert.throws(() => f(), isTeardown);\nfunction isTeardown(error) {\n  return (error instanceof Error) && (error.name === \"teardown\");\n}",
      errors: 1
    },

    // A name bound in an outer scope and used inside nested callbacks, the shape a suite-level helper takes.
    {

      code: "const refusal = (error) => error instanceof TypeError;\ndescribe(\"x\", () => {\n  it(\"y\", () => {\n    assert.throws(() => f(), refusal);\n  });\n});",
      errors: 1
    },

    // An inner non-conforming `const` shadows an outer conforming one, and the call reads the binding in scope where it is written.
    {

      code: "const check = (error) => error === reason;\nfunction run() {\n  const check = (error) => error instanceof TypeError;\n\n" +
        "  assert.throws(() => f(), check);\n}",
      errors: 1
    }
  ],

  valid: [

    // node:assert's own forms, and no second argument at all, are none of this rule's business.
    "assert.throws(() => f());",
    "assert.throws(() => f(), TypeError);",
    "assert.throws(() => f(), { constructor: TypeError, message: \"m\" });",
    "assert.throws(() => f(), /refused/);",
    "assert.throws(() => f(), \"message\");",

    // The validation form, inline as an arrow and as a function expression, which asserts each claim and answers true.
    "assert.throws(() => f(), (error) => {\n  assert.ok(error instanceof TypeError, \"r\");\n\n  return true;\n});",
    "assert.throws(() => f(), function(error) {\n  assert.ok(error instanceof TypeError, \"r\");\n\n  return true;\n});",

    // A block that asserts and returns nothing answers nothing node:assert accepts as a match, so it throws from its assertions or fails the row loudly.
    "assert.throws(() => f(), (error) => {\n  assert.ok(error instanceof TypeError, \"r\");\n});",

    // A function that returns true on one path and falls off its end on another is accepted knowingly: node:assert fails that row loudly when the fall-through runs.
    "assert.throws(() => f(), (error) => {\n  if(error instanceof TypeError) {\n    return true;\n  }\n});",

    // Identity of the parameter on the left, on the right, and parenthesised.
    "await assert.rejects(p, (error) => error === reason);",
    "await assert.rejects(p, (error) => reason === error);",
    "await assert.rejects(p, (error) => (error === reason));",

    // Identity under a type assertion, an angle-bracket cast, a non-null assertion, and a `satisfies` nested inside an `as`, with the parameter on the left or right.
    {

      code: "await assert.rejects(p, (error: unknown) => (error as Error) === reason);",
      filename: TS
    },
    {

      code: "await assert.rejects(p, (error: unknown) => <Error>error === reason);",
      filename: TS
    },
    {

      code: "await assert.rejects(p, (error: Error | undefined) => error! === reason);",
      filename: TS
    },
    {

      code: "await assert.rejects(p, (error: unknown) => reason === (error satisfies unknown) as unknown);",
      filename: TS
    },

    // The parameter is matched by its binding, whatever its name, on the left and on the right - including a parameter named `thrown` compared with an outer `error`.
    "await assert.rejects(p, (thrown) => thrown === error);",
    "await assert.rejects(p, (reason) => expected === reason);",

    // A conforming `const` arrow, a conforming `const` function expression and a conforming function declaration, each passed by name.
    "const matches = (error) => error === reason;\nawait assert.rejects(p, matches);",
    "const check = function(error) {\n  assert.ok(error instanceof TypeError, \"r\");\n\n  return true;\n};\nassert.throws(() => f(), check);",
    "function check(error) {\n  assert.ok(error instanceof TypeError, \"r\");\n\n  return true;\n}\nassert.throws(() => f(), check);",

    // A name bound to a regular expression, an object and an error instance is node:assert's own form reached through a name.
    "const refusal = /refused/;\nassert.throws(() => f(), refusal);",
    "const expected = { message: \"m\", name: \"TypeError\" };\nassert.throws(() => f(), expected);",
    "const failure = new Error(\"m\");\nassert.throws(() => f(), failure);",

    // A class declared in the file is the class form reached through its own name.
    "class StatusError extends Error {}\nassert.throws(() => f(), StatusError);",

    // A name that resolves to nothing in the file has no source to read.
    "assert.throws(() => f(), undeclared);",

    // An import, a `let` and a parameter are each bound where the call cannot see the function, so none is judged.
    "import { isRefusal } from \"./refusal.mjs\";\nassert.throws(() => f(), isRefusal);",
    "let check = (error) => error instanceof TypeError;\nassert.throws(() => f(), check);",
    "const check = (error) => error instanceof TypeError;\nfunction run(check) {\n  assert.throws(() => f(), check);\n}",

    // An inner conforming `const` shadows an outer non-conforming one, and the call reads the binding in scope where it is written.
    "const check = (error) => error instanceof TypeError;\nfunction run() {\n  const check = (error) => error === reason;\n\n  assert.throws(() => f(), check);\n}",

    // A TypeScript overload set gives the name several definitions, so there is no single body to judge.
    {

      code: "function check(error: TypeError): boolean;\nfunction check(error: unknown): boolean;\nfunction check(error: unknown): boolean {\n" +
        "  return error instanceof TypeError;\n}\nassert.throws(() => f(), check);",
      filename: TS
    },

    // An ambient declaration has one definition and no body, so there is nothing to judge.
    {

      code: "declare function check(error: unknown): boolean;\nassert.throws(() => f(), check);",
      filename: TS
    },

    // A destructured `const` binds a field of its initializer rather than the initializer, so the arrow on the right is not the function the name holds.
    "const { name: check } = (error) => error instanceof TypeError;\nassert.throws(() => f(), check);",

    // A nested callback's boolean return belongs to that callback, so it never counts against the validation function around it.
    "assert.throws(() => f(), (error) => {\n  assert.ok(causes.some((cause) => {\n    return cause === error.cause;\n  }), \"r\");\n\n  return true;\n});",

    // An unrelated receiver's own `throws` has its own contract for its arguments.
    "matcher.throws(() => f(), (error) => error instanceof TypeError);"
  ]
});
