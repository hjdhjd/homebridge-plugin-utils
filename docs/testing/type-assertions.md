[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / testing/type-assertions

# testing/type-assertions

The type-level assertion helpers a suite states an exact-type claim with.

A test suite asserts runtime behavior with `assert`, and it asserts types with the compiler. These four aliases are how the second half is written down: each one
reduces a claim about types to the literal `true` or `false`, and [Assert](#assert) turns a `false` into a build failure. Nothing here has a runtime footprint at
all - the module exports only types, its consumers reach it through `import type`, and it is erased entirely before anything runs.

The house rule these exist to serve, stated once here and nowhere else: an exact-type claim uses `Assert<Equal<typeof value, Expected>>`; an acceptance or
rejection claim keeps its typed underscore assertion - the annotated `const` that has to compile - because what it tests IS assignability, and an exactness check
there would assert something the code never promised.

## Testing

### Assert

```ts
type Assert<X> = X;
```

Hold a type-level claim to the literal `true`, failing the build when it resolves to anything else.

This is the assertion itself, and every other alias here is something to put inside it. A claim written as `type _Something = Assert<...>` compiles when the
claim holds and fails with TS2344 when it does not, so a type-level expectation is checked by `tsc` on every run rather than living in a comment nobody reruns.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-x"></a> `X` *extends* `true` | The claim to hold. Constrained to `true`, which is what makes a `false` claim a compile error rather than a silently different type. |

***

### Equal

```ts
type Equal<A, B> = <_Probe>() => _Probe extends A ? 1 : 2 extends <_Probe>() => _Probe extends B ? 1 : 2 ? true : false;
```

Answer whether `A` and `B` are the same type, told apart symbolically rather than by assignability.

The property that earns this its construction is any-safety, and the textbook spelling does not have it. Written the obvious way - `[A] extends [B] ? ([B] extends
[A] ? true : false) : false` - the alias reports `Equal<any, number>` as `true`, because `any` is assignable in both directions. A value that has silently drifted
to `any` then passes every check built on it, which is the opposite of what a type assertion is for.

The form below avoids that by comparing two generic function signatures instead of the types themselves. A conditional over an unresolved type parameter is not
reduced by the compiler, so the two signatures are structurally assignable to one another only when `A` and `B` are literally the same type...`any` carries no
privilege in that comparison, because nothing is ever assigned. `_Probe` is named for what it does: it tells the two signatures apart in that comparison rather
than carrying a value. See https://github.com/microsoft/TypeScript/issues/27024 for the mechanism.

One consequence worth knowing before writing a row against it: the comparison is structural, so declaration order does not matter. `Equal<{ a: 1; b: 2 }, { b: 2;
a: 1 }>` and `Equal<"a" | "b", "b" | "a">` both answer `true`, and a claim built on reordering alone asserts the opposite of what it reads as.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-a"></a> `A` | The first type to compare. |
| <a id="type-parameter-b"></a> `B` | The second type to compare. |

***

### Extends

```ts
type Extends<A, B> = A extends B ? true : false;
```

Answer whether `A` is assignable to `B`, in that direction only.

This is the "shape A satisfies contract B" claim rather than the "A and B are identical" one: a literal against its base, a concrete options object against the
interface a function accepts. When both directions matter, reach for [Equal](#equal) instead.

It carries a caveat in the same class as `Equal`'s any-safety one, and for the same reason - a claim that reads as proven while its subject has quietly become
something else. A conditional over a naked type parameter distributes across `A`'s union members, and a union with no members is `never`, so whenever `A`
resolves to `never` the whole type collapses to `never` as well. `never` satisfies `X extends true`, which means `Assert<Extends<never, B>>` compiles for EVERY
`B`, with no compiler signal at all. A claim whose left side drifted to `never` - through an `Exclude` that excluded everything, a narrowing that eliminated
every arm - keeps passing while testing nothing. When that matters, state the claim through [Equal](#equal), which compares the two symbolically and answers
`false` rather than collapsing.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-a-1"></a> `A` | The type that must be assignable. |
| <a id="type-parameter-b-1"></a> `B` | The type it must be assignable to. |

***

### MutuallyAssignable

```ts
type MutuallyAssignable<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;
```

Answer whether `A` and `B` are assignable to one another, so either stands in for the other at a use site.

This is the middle strictness: stricter than [Extends](#extends), because it rejects a `B` looser than `A`, and more tolerant than [Equal](#equal), because
assignability reduces conditional types where `Equal` compares them symbolically. An intersection against the flattened shape it is equivalent to is the case it
exists for - the two are interchangeable everywhere, and `Equal` still answers `false`.

It is safer than its construction suggests, and the two drift cases land differently here than they do on `Extends`. A one-sided `any` is caught in both
spellings: with `any` on the right, `Extends<A, any>` is `true` and the answer is `Extends<any, A>`, which resolves to `boolean` and fails `Assert`'s `X extends
true` constraint; with `any` on the left, `Extends<any, B>` is `boolean`, `boolean extends true` is false, and the whole type resolves to `false`. Only the
degenerate `any`/`any` pair passes, and there is no real type to protect there. A one-sided `never` is caught the same way rather than collapsing:
`MutuallyAssignable<never, string>` and `MutuallyAssignable<string, never>` both resolve to the literal `false`, and only `never`/`never` collapses. So this type
does NOT inherit the vacuous pass `Extends` has on a `never` left side.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-a-2"></a> `A` | The first type. |
| <a id="type-parameter-b-2"></a> `B` | The second type. |
