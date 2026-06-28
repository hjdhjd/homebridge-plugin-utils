/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * enforce-node-protocol.test.mjs: Unit tests for the enforce-node-protocol rule covering each visitor (ImportDeclaration, ExportNamedDeclaration,
 * ExportAllDeclaration, ImportExpression), the subpath-import case where the rule matches by the top-level segment, and the negative cases that prove
 * already-prefixed and non-builtin references pass without flagging.
 */
import { RuleTester } from "../test-setup.mjs";
import rule from "./enforce-node-protocol.mjs";

const ruleTester = new RuleTester();

ruleTester.run("enforce-node-protocol", rule, {

  invalid: [

    // ImportDeclaration - bare builtin name, autofix prepends `node:`.
    {

      code: "import x from \"child_process\";",
      errors: [{ message: /Use the `node:` protocol prefix/ }],
      output: "import x from \"node:child_process\";"
    },

    // Named-import form of ImportDeclaration.
    {

      code: "import { spawn } from \"child_process\";",
      errors: 1,
      output: "import { spawn } from \"node:child_process\";"
    },

    // Namespace-import form of ImportDeclaration. The rule's `ImportDeclaration` visitor dispatches on `node.source.value` regardless of specifier
    // shape, so namespace imports flag the same way as default and named imports do.
    {

      code: "import * as cp from \"child_process\";",
      errors: 1,
      output: "import * as cp from \"node:child_process\";"
    },

    // ExportNamedDeclaration with a source clause - the source string gets prefixed.
    {

      code: "export { foo } from \"fs\";",
      errors: 1,
      output: "export { foo } from \"node:fs\";"
    },

    // ExportAllDeclaration - same shape, same autofix.
    {

      code: "export * from \"stream\";",
      errors: 1,
      output: "export * from \"node:stream\";"
    },

    // Re-export with an alias clause - the autofix targets only the source literal, not the named clause.
    {

      code: "export * as nodeStream from \"stream\";",
      errors: 1,
      output: "export * as nodeStream from \"node:stream\";"
    },

    // ImportExpression (dynamic import) with a string-literal argument. The rule's ImportExpression visitor guards on `node.source.type === "Literal"`
    // before reporting, so this case fires; the dynamic-with-variable case in the valid list does not.
    {

      code: "const m = import(\"crypto\");",
      errors: 1,
      output: "const m = import(\"node:crypto\");"
    },

    // Subpath import of a builtin (`timers/promises`). The top-level segment matches the `NODE_BUILTIN_MODULES` Set, so the rule fires and the autofix
    // prefixes the whole specifier including the subpath.
    {

      code: "import { setTimeout } from \"timers/promises\";",
      errors: 1,
      output: "import { setTimeout } from \"node:timers/promises\";"
    },

    // Subpath via a re-export.
    {

      code: "export { setImmediate } from \"timers/promises\";",
      errors: 1,
      output: "export { setImmediate } from \"node:timers/promises\";"
    }
  ],

  valid: [

    // Already-prefixed builtins - canonical, no rewrite.
    "import x from \"node:child_process\";",
    "import { spawn } from \"node:child_process\";",
    "export { foo } from \"node:fs\";",
    "export * from \"node:stream\";",
    "const m = import(\"node:crypto\");",
    "import { setTimeout } from \"node:timers/promises\";",

    // Non-builtin packages - the rule's `NODE_BUILTIN_MODULES` Set does not contain them, so they pass through.
    "import x from \"lodash\";",
    "import { foo } from \"./local-module.mjs\";",
    "import { bar } from \"@scope/package\";",
    "export { baz } from \"my-package\";",

    // Local re-export with no source clause - `ExportNamedDeclaration.source` is null, the rule's `findBuiltinSourceToPrefix` short-circuits via the
    // `typeof value !== \"string\"` guard.
    "const foo = 1; export { foo };",

    // Dynamic import with a non-literal argument - the ImportExpression visitor's `node.source.type === \"Literal\"` guard skips this case so the rule
    // does not fire on runtime-computed module specifiers.
    "const name = \"crypto\"; const m = import(name);"
  ]
});
