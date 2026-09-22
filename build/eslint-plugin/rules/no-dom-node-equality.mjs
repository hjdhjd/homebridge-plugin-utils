/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * no-dom-node-equality.mjs: Bar node:assert's equality family from comparing DOM nodes.
 */
import ts from "typescript";

// The equality family node:assert exposes. Each of these builds its failure message by walking both operands, which is the behavior this rule bars from ever
// meeting a DOM node.
const EQUALITY_METHODS = new Set([ "deepEqual", "deepStrictEqual", "equal", "notDeepEqual", "notDeepStrictEqual", "notEqual", "notStrictEqual", "strictEqual" ]);

// The declaration file the DOM library defines its own Node interface in. The type is resolved from this file rather than by looking the name up, because a
// program frequently sees several unrelated interfaces named Node - the syntax-tree packages behind markdown tooling each declare one.
const DOM_LIB = "lib.dom.d.ts";

const MESSAGE = "Compare DOM nodes with assert.ok(a === b, \"<reason>\"); an equality assertion over two DOM nodes hangs the run instead of failing it.";

/* The type kinds a constituent is dropped for before the assignability question is asked.
 *
 * `any` and `never` are each assignable to every target, so a predicate that kept them would report on any operand the checker could not type and on any operand
 * it narrowed away entirely - ordinary value comparisons, by the thousand. `unknown` is dropped on the same reasoning, and `null` and `undefined` are dropped
 * because they are what the bounded form compares against: an operand typed `Element | null` must answer for its `Element` arm alone.
 */
const IGNORED_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Unknown;

// The resolved DOM Node type, keyed by the program it was resolved from. Resolution walks every source file the program holds, which is far too expensive to
// repeat for each node visited, and one lint run reuses a single program across every file it reads.
const nodeTypeByProgram = new WeakMap();

// Resolve the DOM Node interface's declared type from the program's own copy of the DOM library. Answers null when the program includes no DOM library at all,
// which is the honest answer for a consumer whose tsconfig omits it: there are no DOM nodes in such a program to find.
function resolveDomNodeType(program, checker) {

  if(nodeTypeByProgram.has(program)) {

    return nodeTypeByProgram.get(program);
  }

  let resolved = null;

  for(const sourceFile of program.getSourceFiles()) {

    if(!sourceFile.fileName.endsWith(DOM_LIB)) {

      continue;
    }

    for(const statement of sourceFile.statements) {

      if(!ts.isInterfaceDeclaration(statement) || (statement.name.text !== "Node")) {

        continue;
      }

      const symbol = checker.getSymbolAtLocation(statement.name);

      if(symbol) {

        resolved = checker.getDeclaredTypeOfSymbol(symbol);
      }
    }
  }

  nodeTypeByProgram.set(program, resolved);

  return resolved;
}

// Whether any constituent of an operand's type is a DOM node, which is what makes the operand unsafe to hand to an equality assertion. A union answers yes on a
// single arm, because one node reaching the failure-message builder is enough to hang the run.
function isDomNodeType(type, checker, domNodeType) {

  for(const constituent of (type.isUnion() ? type.types : [type])) {

    if(constituent.flags & IGNORED_FLAGS) {

      continue;
    }

    if(checker.isTypeAssignableTo(constituent, domNodeType)) {

      return true;
    }
  }

  return false;
}

// Whether a callee's receiver is node:assert itself, written either as the plain `assert` binding or through its `assert.strict` alias. Both spellings are
// admitted because the rule ships to every sibling plugin through the shared preset, where either may be the local idiom.
function isAssertReceiver(node) {

  if(node.type === "Identifier") {

    return node.name === "assert";
  }

  if(node.type === "MemberExpression") {

    return !node.computed && (node.object.type === "Identifier") && (node.object.name === "assert") && (node.property.type === "Identifier") &&
      (node.property.name === "strict");
  }

  return false;
}

// Whether a call is one of node:assert's equality assertions. The receiver is part of the test rather than the method name alone: the hazard belongs to
// node:assert's failure-message builder, so an unrelated object's own `.equal()` reaches a different code path and a report there would carry a message that
// does not describe it.
function isAssertEqualityCall(node) {

  const callee = node.callee;

  return (callee.type === "MemberExpression") && !callee.computed && (callee.property.type === "Identifier") && EQUALITY_METHODS.has(callee.property.name) &&
    isAssertReceiver(callee.object);
}

// Bar node:assert's equality family from any operand the type checker resolves to a DOM node.
//
// Cases covered:
//  * `assert.equal(document.querySelector(".x"), null, "r");`  is reported - the accessor's own result is a node.
//  * `const el = document.querySelector(".x");`                is reported at the comparison, because the binding carries the accessor's type.
//  * `assert.equal(helper(), null, "r");`                      is reported, since a helper's declared or inferred return type answers the same question.
//  * `assert.deepEqual(document.body, document.body, "r");`    reports twice, once per offending argument rather than once per call.
//  * `assert.strict.equal(document.body, null, "r");`          is reported - node:assert's other spelling reaches the same builder.
//  * `assert.equal(el?.textContent, "x", "r");`                is a value read off a node rather than a node, and is left alone.
//  * `assert.ok(el === null, "r");`                            is the bounded form this rule points authors toward, and is outside the equality family.
//  * `matcher.equal(document.body, null, "r");`                is an unrelated receiver and is left alone.
//
// A failing equality assertion over two DOM nodes does not fail the run, it hangs it: node:assert builds its failure message by walking both operands, and a
// node's getter-backed properties compute by walking the subtree beneath them. The bounded form compares first and hands the assertion a plain boolean plus the
// author's own reason string, so the message has a fixed size no matter how large the tree is. There is deliberately no autofix, because the bounded form needs
// that reason string and only the author can write it.
const ruleNoDomNodeEquality = {

  create(context) {

    const parserServices = context.sourceCode.parserServices;

    // A file linted without the project service carries no program, so there is no checker to ask and the rule has nothing it can say about that file.
    if(!parserServices?.program || !parserServices.esTreeNodeToTSNodeMap) {

      return {};
    }

    const checker = parserServices.program.getTypeChecker();
    const domNodeType = resolveDomNodeType(parserServices.program, checker);

    if(!domNodeType) {

      return {};
    }

    return {

      CallExpression(node) {

        if(!isAssertEqualityCall(node)) {

          return;
        }

        // Only the two compared operands are read. Every equality method in the family takes the message as its third parameter, which is a string the author
        // wrote and never a node under test.
        for(const argument of node.arguments.slice(0, 2)) {

          const tsNode = parserServices.esTreeNodeToTSNodeMap.get(argument);

          if(!tsNode || !isDomNodeType(checker.getTypeAtLocation(tsNode), checker, domNodeType)) {

            continue;
          }

          context.report({

            message: MESSAGE,
            node: argument
          });
        }
      }
    };
  },
  meta: {

    docs: {

      description: "bar node:assert's equality family from comparing DOM nodes",
      recommended: false
    },
    schema: [],
    type: "problem"
  }
};

export default ruleNoDomNodeEquality;
