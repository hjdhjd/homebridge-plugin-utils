/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/type-assertions.test.ts: Unit tests for the type-level assertion helpers in type-assertions.ts - Assert, Equal, Extends, MutuallyAssignable.
 *
 * The subject has no runtime footprint, so the gate that reads this file is `npx tsc --noEmit` rather than the test runner. Every positive row below is an alias
 * that must compile; every negative row sits under `@ts-expect-error` and must produce the diagnostic its comment names, since a directive whose error stops
 * occurring reports TS2578 and fails the same gate. The runner still needs one executed assertion so the file is not an empty suite.
 */
import type { Assert, Equal, Extends, MutuallyAssignable } from "./index.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// An `any` that arrived the way a real one does - off a call whose return type is `any` - rather than spelled out, because a literal `any` reds `no-explicit-any`
// and this is the more faithful model of the drift the rows below exist to catch.
type DriftedToAny = ReturnType<typeof JSON.parse>;

const _typeAssertionExercises = (): void => {

  // Equal's positive rows: identical object types, identical unions, and identical function signatures each answer true.
  type _EqualMatchesObjects = Assert<Equal<{ a: 1 }, { a: 1 }>>;
  type _EqualMatchesUnions = Assert<Equal<"a" | "b", "a" | "b">>;
  type _EqualMatchesSignatures = Assert<Equal<(input: string) => number, (input: string) => number>>;

  // @ts-expect-error - a tuple's element POSITIONS are part of its identity, so a reordered tuple is a different type.
  type _EqualRejectsTupleOrder = Assert<Equal<[ 1, 2 ], [ 2, 1 ]>>;

  // @ts-expect-error - one property carries a different literal in each shape, so the two are not the same type.
  type _EqualRejectsDifferentLiteral = Assert<Equal<{ a: 1; b: 2 }, { a: 1; b: 3 }>>;

  // Extends answers true in the assignable direction and false in the other, which is the whole of what one-directional means.
  type _ExtendsLiteralToBase = Assert<Extends<"literal", string>>;
  type _ExtendsBaseToLiteral = Assert<Equal<Extends<string, "literal">, false>>;

  /* The never-widening rows, which are Extends's share of the same unsoundness class Equal's any-safety row covers. Both are POSITIVE, because what they document
   * is that the collapse HAPPENS: Extends reduces to never when its left operand does, so the claim it looks like it is making is vacuous. The doc paragraph on
   * Extends says to reach for Equal when that matters, and the row below it is the pair that shows MutuallyAssignable does not share the flaw.
   */
  type _ExtendsCollapsesOnNever = Assert<Equal<Extends<never, string>, never>>;
  type _ExtendsIsVacuousOnNever = Assert<Extends<never, string>>;

  // MutuallyAssignable's reason for existing: an intersection and the flattened shape it is equivalent to are interchangeable at every use site.
  type _InterchangeableSpellings = Assert<MutuallyAssignable<{ a: string } & { b: number }, { a: string; b: number }>>;

  // @ts-expect-error - Equal compares the two symbolically and answers false for the same pair, which is why the middle strictness exists.
  type _EqualRejectsTheSamePair = Assert<Equal<{ a: string } & { b: number }, { a: string; b: number }>>;

  // @ts-expect-error - "literal" is assignable to string, but string is not assignable back, so the two are not interchangeable.
  type _AsymmetricPair = Assert<MutuallyAssignable<"literal", string>>;

  /* The same pair mirrored, and the reason both orders are written down. An implementation that dropped the Extends<A, B> half and answered Extends<B, A>
   * unconditionally still answers false for the row above, and answers true here...so only the mirror tells the two apart.
   */
  // @ts-expect-error - string is not assignable to "literal", so the two are not interchangeable in this order either.
  type _AsymmetricPairMirrored = Assert<MutuallyAssignable<string, "literal">>;

  // @ts-expect-error - a side that silently became any is caught here, answering boolean rather than true. This is the one row whose diagnostic names boolean.
  type _MutuallyRejectsAnyOnTheRight = Assert<MutuallyAssignable<string, DriftedToAny>>;

  // @ts-expect-error - a side that collapsed to never is caught too, answering the literal false rather than collapsing the way Extends does two rows above.
  type _MutuallyRejectsNever = Assert<MutuallyAssignable<never, string>>;

  // @ts-expect-error - the bare false claim, which is Assert's own contract in one line.
  type _AssertRejectsFalse = Assert<false>;

  // @ts-expect-error - two unrelated primitives are not the same type.
  type _EqualRejectsUnrelated = Assert<Equal<string, number>>;

  /* The any-safety pair, which is the claim the textbook Equal gets wrong. The negative says a drifted any is NOT string; the positive says Equal answers exactly
   * false for that pair, where the textbook `[A] extends [B] ? ([B] extends [A] ? true : false) : false` answers true and waves the drift through.
   */
  // @ts-expect-error - a value that drifted to any is not string, and Equal must say so.
  type _EqualRejectsDriftedAny = Assert<Equal<DriftedToAny, string>>;

  type _EqualIsAnySafe = Assert<Equal<Equal<DriftedToAny, string>, false>>;
};

describe("type assertions", () => {

  test("states its claims to the compiler rather than to the runner", () => {

    // The subject is type-only, so there is nothing to execute. The rows that matter are the aliases above, and `npx tsc --noEmit` is what reads them; this
    // assertion exists so the runner sees a suite with a test in it rather than an empty file.
    assert.equal(typeof _typeAssertionExercises, "function", "the compile-time exercises must be present in the emitted module for the gate above to have read them");
  });
});
