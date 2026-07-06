/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * enforce-node-protocol.mjs: Require the `node:` protocol prefix on imports and re-exports of Node.js built-in modules.
 */

// The Node.js built-in modules that must be referenced via the `node:` protocol. Subpath imports (e.g., `timers/promises`) are matched by comparing the
// top-level segment before the first `/`, so adding a new builtin here covers both bare and subpath references in one shot. This list is hand-maintained
// rather than sourced from `node:module`'s `builtinModules` array so the rule's behavior stays fixed and version-independent across whatever Node runtime
// ESLint happens to execute under, instead of silently drifting as builtins are added or removed between Node releases.
const NODE_BUILTIN_MODULES = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"
]);

// Find the source literal that should be rewritten with a `node:` prefix, or null when the reference is not a built-in or already correctly prefixed. We
// look at the top-level module name (split on first `/`) so subpath references match too. For every supported visitor - Import / Export declarations
// and `ImportExpression` (dynamic `import("x")`) - the typescript-eslint AST places the source literal at `node.source`. A null result means either the
// value isn't a string (which also covers a declaration with no source clause at all, e.g. `export { foo };`, since `node.source` is then undefined) or
// the module isn't a builtin.
function findBuiltinSourceToPrefix(node, value) {

  if(typeof value !== "string") {

    return null;
  }

  const topLevel = value.split("/", 1)[0];

  if(!NODE_BUILTIN_MODULES.has(topLevel)) {

    return null;
  }

  return node.source ?? null;
}

// Require the `node:` protocol prefix on every reference to a Node.js built-in module.
//
// Cases covered:
//  * `import x from "child_process"`            is flagged; autofix rewrites to `import x from "node:child_process"`.
//  * `export { x } from "fs"`                   is flagged; autofix rewrites the source string.
//  * `export * from "stream"`                   is flagged; same shape, same autofix.
//  * `import("crypto")`                         dynamic-import call form, flagged when the argument is a string literal.
//  * `import x from "node:child_process"`       canonical; ignored.
//  * `import x from "lodash"`                   non-builtin; ignored.
//  * `import x from "timers/promises"`          subpath of a builtin; flagged via the top-level-segment match.
//
// The reported location is the source string literal itself, so editor markers pinpoint the offending text. The autofix replaces the literal with a
// double-quoted `node:`-prefixed form.
const ruleEnforceNodeProtocol = {

  create(context) {

    function reportIfViolation(node, value) {

      const source = findBuiltinSourceToPrefix(node, value);

      if(source === null) {

        return;
      }

      context.report({

        fix(fixer) {

          return fixer.replaceText(source, "\"node:" + value + "\"");
        },
        message: "Use the `node:` protocol prefix when importing Node.js built-in modules.",
        node: source
      });
    }

    return {

      ExportAllDeclaration(node) {

        reportIfViolation(node, node.source?.value);
      },

      ExportNamedDeclaration(node) {

        reportIfViolation(node, node.source?.value);
      },

      ImportDeclaration(node) {

        reportIfViolation(node, node.source.value);
      },

      ImportExpression(node) {

        if(node.source.type === "Literal") {

          reportIfViolation(node, node.source.value);
        }
      }
    };
  },
  meta: {

    docs: {

      description: "require the `node:` protocol prefix on imports and re-exports of Node.js built-in modules",
      recommended: false
    },
    fixable: "code",
    schema: [],
    type: "problem"
  }
};

export default ruleEnforceNodeProtocol;
