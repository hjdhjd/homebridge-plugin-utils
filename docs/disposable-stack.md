[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / disposable-stack

# disposable-stack

A drop-in implementation of the TC39 Explicit Resource Management `DisposableStack`.

The platform ships `DisposableStack` as a runtime global starting in Node 24, but the package's `engines.node` floor is lower, so on that floor evaluating
`new DisposableStack()` against the global throws a `ReferenceError`. This module provides the identical contract as a normal import, so every call site reads
exactly as it would against the native class and the by-construction acquire-with-cleanup pairing is preserved. When the `engines.node` floor reaches Node 24 the
platform global takes over and this module and its imports are deleted... the runtime-floor conformance test in `runtime-floor.test.ts` enforces exactly that
deletion the moment the floor is bumped. The class is intentionally not re-exported from `src/index.ts`: the platform global is its eventual owner and no consumer
may couple to it.

## Utilities

### DisposableStack

A container that aggregates disposable resources and disposes them, in reverse (last-in-first-out) order, when the stack itself is disposed.

The class satisfies the platform `DisposableStack` interface by construction - the `implements` clause below binds it to `globalThis.DisposableStack`, so the
compiler enforces that the name's promise (the platform contract) is kept at the definition site.

#### Implements

- `InstanceType`\<*typeof* `globalThis.DisposableStack`\>

#### Constructors

##### Constructor

```ts
new DisposableStack(): DisposableStack;
```

###### Returns

[`DisposableStack`](#disposablestack)

#### Properties

| Property | Modifier | Type | Default value |
| ------ | ------ | ------ | ------ |
| <a id="tostringtag"></a> `[toStringTag]` | `readonly` | `"DisposableStack"` | `"DisposableStack"` |

#### Accessors

##### disposed

###### Get Signature

```ts
get disposed(): boolean;
```

Whether this stack has been disposed.

###### Returns

`boolean`

###### Implementation of

```ts
InstanceType.disposed
```

#### Methods

##### \[dispose\]()

```ts
dispose: void;
```

Dispose this stack. Enables `using` semantics by delegating to [dispose](#dispose-1).

###### Returns

`void`

###### Implementation of

```ts
InstanceType.[dispose]
```

##### adopt()

```ts
adopt<T>(value, onDispose): T;
```

Register a value together with an explicit disposal callback, returning the value unchanged. The callback is invoked with the value as its first argument when
this stack is disposed.

###### Type Parameters

| Type Parameter |
| ------ |
| `T` |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `T` | The value to associate with the callback. |
| `onDispose` | (`value`) => `void` | The disposal callback, invoked with `value`. |

###### Returns

`T`

The provided `value`.

###### Implementation of

```ts
InstanceType.adopt
```

##### defer()

```ts
defer(onDispose): void;
```

Register a callback to run when this stack is disposed.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `onDispose` | () => `void` | The callback to run on disposal. |

###### Returns

`void`

###### Implementation of

```ts
InstanceType.defer
```

##### dispose()

```ts
dispose(): void;
```

Dispose every registered resource in reverse (last-in-first-out) order. A second call is a no-op. Every disposer runs even when an earlier one throws: a single
failure is rethrown after the sweep completes, and multiple failures chain through `SuppressedError` (the newest failure wrapping the accumulated one).

###### Returns

`void`

###### Implementation of

```ts
InstanceType.dispose
```

##### move()

```ts
move(): DisposableStack;
```

Move every pending disposer out of this stack into a fresh [DisposableStack](#disposablestack), preserving registration order, and mark this stack disposed without running
anything. This is the "commit" primitive: after a successful acquire sequence, moving the disposers away disarms this stack's scope-bound cleanup while handing
responsibility for those resources to the returned stack.

###### Returns

[`DisposableStack`](#disposablestack)

A new stack owning the transferred disposers.

###### Implementation of

```ts
InstanceType.move
```

##### use()

```ts
use<T>(value): T;
```

Register a [Disposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose) whose `[Symbol.dispose]()` runs when this stack is disposed, returning the value unchanged.

`null` and `undefined` pass through without being registered. The dispose method is captured at registration time and invoked with the value as its receiver, so
a later mutation of `value[Symbol.dispose]` cannot change what runs.

###### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* \| [`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose) \| `null` \| `undefined` |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `T` | The resource to register, or `null`/`undefined` to skip registration. |

###### Returns

`T`

The provided `value`.

###### Implementation of

```ts
InstanceType.use
```
