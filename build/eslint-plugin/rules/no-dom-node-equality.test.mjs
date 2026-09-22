/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * no-dom-node-equality.test.mjs: Unit tests for the no-dom-node-equality rule covering the shapes an operand reaches a comparison through - a bare accessor, a
 * binding assigned from one, a helper's return value, a navigation property, and an optional chain in a TypeScript file - alongside the per-argument report
 * count, both admitted receiver spellings, and the negative cases that prove a value read off a node, the bounded form, an ordinary comparison, a truthiness
 * check, and an unrelated receiver are none of this rule's business.
 *
 * Every snippet opens with the node:assert import. Without it the callee is an unresolved global typed `any`, TypeScript declines to check the arguments of a
 * call it cannot resolve, every operand comes back `any`, and the rule correctly stays silent - which would leave each invalid case passing while proving
 * nothing. The virtual filenames sit at the repository root because tsconfig's directory include resolves against files that exist on disk, so a synthetic file
 * nested under src/ or ui/ reaches no project at all.
 */
import { RuleTester } from "../test-setup.mjs";
import path from "node:path";
import rule from "./no-dom-node-equality.mjs";
import tseslint from "typescript-eslint";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IMPORT = "import assert from \"node:assert/strict\";\n";
const MJS = path.join(ROOT, "no-dom-node-equality-case.mjs");
const TS = path.join(ROOT, "no-dom-node-equality-case.ts");

const ruleTester = new RuleTester({

  languageOptions: {

    parser: tseslint.parser,
    parserOptions: {

      projectService: { allowDefaultProject: [ "*.ts", "*.mjs" ], defaultProject: "tsconfig.json" },
      tsconfigRootDir: ROOT
    }
  }
});

ruleTester.run("no-dom-node-equality", rule, {

  invalid: [

    // The bare-accessor shape: the accessor's own result is the operand, which is the form the convention meets most often.
    {

      code: IMPORT + "assert.equal(document.querySelector(\".x\"), null, \"r\");",
      errors: [{ message: /an equality assertion over two DOM nodes hangs the run/ }],
      filename: MJS
    },

    // The variable-assigned shape: the binding carries the accessor's type, so the comparison is reached through a name rather than a call.
    {

      code: IMPORT + "const el = document.querySelector(\".x\");\nassert.equal(el, null, \"r\");",
      errors: 1,
      filename: MJS
    },

    // A helper's return value, which is the shape a scope-tracking rule cannot follow and the reason this rule asks the checker instead.
    {

      code: IMPORT + "function h() { return document.querySelector(\".x\"); }\nassert.equal(h(), null, \"r\");",
      errors: 1,
      filename: MJS
    },

    // Both operands are nodes, which reports twice - the rule answers per argument rather than per call.
    {

      code: IMPORT + "assert.deepEqual(document.body, document.body, \"r\");",
      errors: 2,
      filename: MJS
    },

    // A negated member of the family reads exactly as its positive twin does, and two node operands still report twice.
    {

      code: IMPORT + "assert.notStrictEqual(document.getElementById(\"a\"), document.getElementById(\"b\"), \"r\");",
      errors: 2,
      filename: MJS
    },

    // An optional-chained accessor in a TypeScript file, whose operand type carries an `undefined` arm alongside the node one.
    {

      code: IMPORT + "const details = document.querySelector(\"details\");\nassert.equal(details?.querySelector(\"img\"), null, \"r\");",
      errors: 1,
      filename: TS
    },

    // A navigation property rather than a query, which proves nothing in the rule is keyed to one accessor's name.
    {

      code: IMPORT + "assert.equal(document.body.firstElementChild, null, \"r\");",
      errors: 1,
      filename: MJS
    },

    // node:assert's other spelling reaches the same failure-message builder, so the second admitted receiver is matched too.
    {

      code: IMPORT + "assert.strict.equal(document.querySelector(\".x\"), null, \"r\");",
      errors: 1,
      filename: MJS
    }
  ],

  valid: [

    // A value read off a node is a string, not a node - the control that proves the rule distinguishes the two rather than matching the receiver's shape.
    {

      code: IMPORT + "const el = document.querySelector(\".x\");\nassert.equal(el?.textContent, \"x\", \"r\");",
      filename: TS
    },

    // The bounded form this rule points authors toward, whose message is fixed by the author's own reason string.
    {

      code: IMPORT + "const el = document.querySelector(\".x\");\nassert.ok(el === null, \"r\");",
      filename: MJS
    },

    // An ordinary non-DOM comparison, which is the bulk of every suite the rule runs over.
    {

      code: IMPORT + "assert.equal(1 + 1, 2, \"r\");",
      filename: MJS
    },

    // Two strings read off two nodes - both operands touch the DOM and neither one is a node.
    {

      code: IMPORT + "const a = document.body.textContent;\nconst b = document.title;\nassert.equal(a, b, \"r\");",
      filename: TS
    },

    // A node handed to assert.ok as a truthiness check, which is outside the equality family entirely.
    {

      code: IMPORT + "assert.ok(document.querySelector(\".x\"), \"r\");",
      filename: MJS
    },

    // An unrelated receiver's own equality method, which has a different failure path and is none of this rule's business.
    {

      code: IMPORT + "const matcher = { equal(a, b, r) { return [ a, b, r ]; } };\nmatcher.equal(document.body, null, \"r\");",
      filename: MJS
    }
  ]
});
