/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * no-boolean-error-predicate.mjs: Bar a boolean predicate from node:assert's rejection and throw assertions.
 */

// The node:assert methods whose second argument may be a validation function, which is the one argument this rule reads.
const ASSERTION_METHODS = new Set([ "rejects", "throws" ]);

// The node types a function is written as. A `return` inside any of them answers for that function alone, so the walk that gathers a validation function's own
// returns stops at each one.
const FUNCTION_TYPES = new Set([ "ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression" ]);

// The TypeScript wrappers that change what the compiler believes about a value and never which value it is, so an identity comparison reads the same through any
// of them.
const TYPE_ASSERTION_TYPES = new Set([ "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion" ]);

const MESSAGE = "State the claim with node:assert's class form, its object form naming the class by constructor, or a validation function that asserts and " +
  "returns true; a predicate that returns a boolean hides which condition failed, and an identity comparison of its own parameter is the one result it may return.";

// Whether a callee's receiver is node:assert itself, written as the plain `assert` binding or through its `assert.strict` alias. Each spelling is admitted
// because the rule ships to every sibling plugin through the shared preset, where any of them may be the local idiom.
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

// Whether a call is node:assert's `rejects` or `throws`. The receiver is part of the test rather than the method name alone, because an unrelated object's own
// `.throws()` has its own contract for its arguments and a report there would describe a platform rule that does not apply.
function isRejectionAssertion(node) {

  const callee = node.callee;

  return (callee.type === "MemberExpression") && !callee.computed && (callee.property.type === "Identifier") && ASSERTION_METHODS.has(callee.property.name) &&
    isAssertReceiver(callee.object);
}

// The variable an identifier refers to, as the linter's own scope analysis resolved it, so shadowing, hoisting and block scope all read exactly as they run. Null
// when the name resolves to nothing in the file.
function resolveVariable(sourceCode, identifier) {

  return sourceCode.getScope(identifier).references.find((reference) => reference.identifier === identifier)?.resolved ?? null;
}

// The function a name is bound to, when its one definition shows that function in the source: a `const` initialized with a function, or a function declaration
// with a body. A `let` or `var` can be reassigned, an import or a parameter is bound where this file cannot see, and a name with several definitions, a TypeScript
// overload set among them, has no single body to read, so each answers null.
function boundFunction(variable) {

  if(variable?.defs.length !== 1) {

    return null;
  }

  const [definition] = variable.defs;

  switch(definition.type) {

    case "FunctionName": {

      return (definition.node.type === "FunctionDeclaration") ? definition.node : null;
    }

    case "Variable": {

      const { id, init } = definition.node;

      return ((definition.parent.kind === "const") && (id.type === "Identifier") && FUNCTION_TYPES.has(init?.type)) ? init : null;
    }

    default: {

      return null;
    }
  }
}

// The validation function a call's second argument hands node:assert, when the source shows it: a function written inline, or a name bound to one. Every other
// argument, whether none, a class, an object, a regular expression, a string, or a name bound to anything else, is one of node:assert's own forms or a value this
// rule cannot see into, so it answers null and the call is left alone.
function validationFunction(sourceCode, argument) {

  switch(argument?.type) {

    case "ArrowFunctionExpression":
    case "FunctionExpression": {

      return argument;
    }

    case "Identifier": {

      return boundFunction(resolveVariable(sourceCode, argument));
    }

    default: {

      return null;
    }
  }
}

// Gather the `return` statements a function body runs as its own, leaving each nested function's returns to that function. A node type the parser declares no
// visitor keys for is not descended into rather than read by guesswork, since a rule that throws ends the lint run for every file of every consumer.
function collectReturns(node, visitorKeys, returns = []) {

  for(const key of visitorKeys[node.type] ?? []) {

    for(const child of [node[key]].flat()) {

      if(!child?.type || FUNCTION_TYPES.has(child.type)) {

        continue;
      }

      if(child.type === "ReturnStatement") {

        returns.push(child);

        continue;
      }

      collectReturns(child, visitorKeys, returns);
    }
  }

  return returns;
}

// The values a validation function answers with: an expression body's one expression, or the argument of each of its own `return` statements, where a bare
// `return;` answers null.
function returnedValues(validator, visitorKeys) {

  if(validator.body.type !== "BlockStatement") {

    return [validator.body];
  }

  return collectReturns(validator.body, visitorKeys).map((statement) => statement.argument);
}

// Whether a returned value is the literal `true`, the one answer node:assert accepts as a match.
function isLiteralTrue(value) {

  return (value?.type === "Literal") && (value.value === true);
}

// Strip the TypeScript wrappers from an operand, nested ones included.
function unwrapTypeAssertion(node) {

  let current = node;

  while(TYPE_ASSERTION_TYPES.has(current.type)) {

    current = current.expression;
  }

  return current;
}

// Whether a returned value is a strict-equality comparison with the validation function's own first parameter as one operand. The parameter is matched by its
// binding rather than its name, so `(thrown) => thrown === error` is identity of `thrown`, and an inner binding that shadows the parameter is not the parameter.
// A destructured, defaulted or missing first parameter has no single binding to compare, so it never matches.
function isParameterIdentity(sourceCode, validator, value) {

  const [parameter] = validator.params;

  if((value?.type !== "BinaryExpression") || (value.operator !== "===") || (parameter?.type !== "Identifier")) {

    return false;
  }

  return [ value.left, value.right ].some((operand) => {

    const unwrapped = unwrapTypeAssertion(operand);

    return (unwrapped.type === "Identifier") && (resolveVariable(sourceCode, unwrapped)?.identifiers.includes(parameter) ?? false);
  });
}

// Whether a validation function answers only what the rule allows. Every returned value being the literal `true` is the validation form, and a block with no
// `return` at all qualifies too, since it asserts and answers nothing node:assert accepts as a match. Otherwise the function must answer exactly one value, and
// that value must be an identity comparison of its own parameter.
function isConforming(sourceCode, validator) {

  const values = returnedValues(validator, sourceCode.visitorKeys);

  if(values.every(isLiteralTrue)) {

    return true;
  }

  return (values.length === 1) && isParameterIdentity(sourceCode, validator, values[0]);
}

// Bar a boolean predicate from node:assert's `rejects` and `throws`, leaving the validation function that asserts and returns true, and one identity comparison
// of the function's own parameter.
//
// Cases covered:
//  * `assert.throws(f, (e) => (e instanceof TypeError) && e.message.includes("x"));`  is reported - a compound hides which of its conditions failed.
//  * `assert.throws(f, (e) => e instanceof RangeError);`                               is reported - the class form `RangeError` states the same claim.
//  * `assert.rejects(p, (e) => isAbortReason(e, "shutdown"));`                         is reported, as is a negation, a ternary or a `Boolean()` call.
//  * `assert.rejects(p, (e) => e.cause === boom);`                                     is reported - a property of the error is not the error itself.
//  * `assert.rejects(p, (e) => { if(!ok(e)) { return false; } return true; });`       is reported - one `false` path makes the function a boolean answer.
//  * `assert.throws(f, refusal);`                                                      is reported, once per call, when `refusal` is a `const` function or a
//                                                                                         function declaration that would be reported written inline.
//  * `assert.strict.throws(f, (e) => e instanceof RangeError);`                        is reported - node:assert's other spelling is the same assertion.
//  * `assert.rejects(p, (e) => e === reason);`                                         is left alone - identity of the parameter, on the left or right, by any name.
//  * `assert.rejects(p, (e) => (e as Error) === reason);`                              is identity too, since a type assertion changes no value.
//  * `assert.throws(f, (e) => { assert.ok(e instanceof TypeError); return true; });`  is left alone - the validation form, whose assertions name the failure.
//  * `assert.throws(f, TypeError);`                                                    is left alone, as are the object form, a regular expression and a string.
//  * `assert.throws(f, check);`                                                        is left alone when `check` is an import, a parameter, a `let` or an overload.
//
// node:assert reports a validation function that answers false with one fixed sentence, that the function was expected to return true, so a boolean predicate
// turns every failing condition into the same report. The class form, the object form, and a validation function whose own assertions carry the claims each
// report the condition that failed, so a claim one of them can state belongs there. Identity of the error with a value the test holds is the claim node:assert
// has no dedicated form for - the class and object forms compare kind and fields, never which value - so it stays the one comparison a predicate may answer.
//
// The rule reads syntax and scope only. A name is judged when the linter's scope analysis resolves it to one definition whose function the source shows, and a
// function that returns true on one path and falls off its end on another is accepted knowingly: node:assert fails that row loudly when the fall-through runs.
// There is deliberately no autofix, because each native form needs the author's own claim and label, and only the author can write them.
const ruleNoBooleanErrorPredicate = {

  create(context) {

    const sourceCode = context.sourceCode;

    return {

      CallExpression(node) {

        if(!isRejectionAssertion(node)) {

          return;
        }

        const argument = node.arguments[1];
        const validator = validationFunction(sourceCode, argument);

        if(!validator || isConforming(sourceCode, validator)) {

          return;
        }

        context.report({

          message: MESSAGE,
          node: argument
        });
      }
    };
  },
  meta: {

    docs: {

      description: "bar a boolean predicate from node:assert's rejects and throws, allowing an identity comparison of its own parameter",
      recommended: false
    },
    schema: [],
    type: "problem"
  }
};

export default ruleNoBooleanErrorPredicate;
