[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / async-disposable-stack

# async-disposable-stack

A drop-in implementation of the TC39 Explicit Resource Management `AsyncDisposableStack`.

The platform ships `AsyncDisposableStack` as a runtime global starting in Node 24, but the package's `engines.node` floor is lower, so on that floor evaluating
`new AsyncDisposableStack()` against the global throws a `ReferenceError`. This module provides the identical contract as a normal import, so every call site reads
exactly as it would against the native class and the by-construction acquire-with-cleanup pairing is preserved. When the `engines.node` floor reaches Node 24 the
platform global takes over and this module and its imports are deleted... the runtime-floor conformance test in `runtime-floor.test.ts` enforces exactly that
deletion the moment the floor is bumped. The class is intentionally not re-exported from `src/index.ts`: the platform global is its eventual owner and no consumer
may couple to it.

A consumer reaches this class through the `homebridge-plugin-utils/polyfills` subpath, which installs it as the global at the consumer's entry point so construction
sites read against the platform name. Library code inside this package does the opposite and imports this module directly: a library has no entry point of its own,
so it can never assume a consumer's polyfill import ran before its own code did.

There is deliberately no shared base class with the synchronous `disposable-stack.ts` shim. The two sunset independently as whole files, and a shared base would
couple those deletions to each other; the bounded duplication between them dies at the Node 24 floor along with both files.

## Utilities

### AsyncDisposableStack

A container that aggregates async and sync disposable resources and disposes them, in reverse (last-in-first-out) order, when the stack itself is disposed.

The class satisfies the platform `AsyncDisposableStack` interface by construction - the `implements` clause below binds it to `globalThis.AsyncDisposableStack`, so
the compiler enforces that the name's promise (the platform contract) is kept at the definition site.

#### Example

```ts
await using stack = new AsyncDisposableStack();

const client = stack.use(await connectClient());

stack.defer(async () => flushTelemetry());
```

#### Implements

- `InstanceType`\<*typeof* `globalThis.AsyncDisposableStack`\>

#### Constructors

##### Constructor

```ts
new AsyncDisposableStack(): AsyncDisposableStack;
```

###### Returns

[`AsyncDisposableStack`](#asyncdisposablestack)

#### Properties

| Property | Modifier | Type | Default value |
| ------ | ------ | ------ | ------ |
| <a id="tostringtag"></a> `[toStringTag]` | `readonly` | `"AsyncDisposableStack"` | `"AsyncDisposableStack"` |

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

##### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

Dispose this stack. Enables `await using` semantics by delegating to [disposeAsync](#disposeasync).

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

###### Implementation of

```ts
InstanceType.[asyncDispose]
```

##### adopt()

```ts
adopt<T>(value, onDisposeAsync): T;
```

Register a value together with an explicit disposal callback, returning the value unchanged. The callback is invoked with the value as its first argument when
this stack is disposed, and is awaited if it returns a promise.

###### Type Parameters

| Type Parameter |
| ------ |
| `T` |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `T` | The value to associate with the callback. |
| `onDisposeAsync` | (`value`) => `void` \| `PromiseLike`\<`void`\> | The disposal callback, invoked with `value`. |

###### Returns

`T`

The provided `value`.

###### Implementation of

```ts
InstanceType.adopt
```

##### defer()

```ts
defer(onDisposeAsync): void;
```

Register a callback to run when this stack is disposed. It is awaited if it returns a promise.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `onDisposeAsync` | () => `void` \| `PromiseLike`\<`void`\> | The callback to run on disposal. |

###### Returns

`void`

###### Implementation of

```ts
InstanceType.defer
```

##### disposeAsync()

```ts
disposeAsync(): Promise<void>;
```

Dispose every registered resource in reverse (last-in-first-out) order, awaiting each one before starting the next. A second call is a no-op. Every disposer runs
even when an earlier one rejects: a single failure is rethrown after the sweep completes, and multiple failures chain through `SuppressedError` (the newest failure
wrapping the accumulated one).

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

###### Implementation of

```ts
InstanceType.disposeAsync
```

##### move()

```ts
move(): AsyncDisposableStack;
```

Move every pending disposer out of this stack into a fresh [AsyncDisposableStack](#asyncdisposablestack), preserving registration order, and mark this stack disposed without
running anything. This is the "commit" primitive: after a successful acquire sequence, moving the disposers away disarms this stack's scope-bound cleanup while
handing responsibility for those resources to the returned stack.

###### Returns

[`AsyncDisposableStack`](#asyncdisposablestack)

A new stack owning the transferred disposers.

###### Implementation of

```ts
InstanceType.move
```

##### use()

```ts
use<T>(value): T;
```

Register an [AsyncDisposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose) or [Disposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose) whose disposal method runs when this stack is disposed, returning the value unchanged.

`null` and `undefined` pass through without being registered. `[Symbol.asyncDispose]` is preferred when the value has one and `[Symbol.dispose]` is the fallback,
matching the platform's own preference. The chosen method is captured at registration time and invoked with the value as its receiver, so a later mutation of
either member cannot change what runs.

###### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* \| [`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose) \| [`AsyncDisposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncDispose) \| `null` \| `undefined` |

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
