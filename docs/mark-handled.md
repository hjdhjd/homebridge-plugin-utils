[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / mark-handled

# mark-handled

**Why this file exists.** The webUI ships into `dist/ui/` for the browser to load (via the browser-module copy step), and the promises it memoizes for the life of
a page - the theming registration, the catalog read - need the same handled mark the library's own promise handles use. Pulling that mark from `util.ts` would
drag in `util.ts`'s Node-only dependency graph, which the browser cannot resolve. This module is the SSOT for the mark. It has zero runtime imports of any kind,
so shipping it alongside the browser's other modules is safe in any runtime that can execute ES2024+ JavaScript.

**Consumers.** `util.ts` re-exports [markHandled](#markhandled) for the server-side surface, so a Node consumer reaches it through the same public API as the rest of the
utilities; the webUI imports directly from here to keep its browser-runnable dependency graph free of `util.ts`. Both consumers share one implementation - the
file is the join point.

## Utilities

### markHandled()

```ts
function markHandled<T>(promise): Promise<T>;
```

Attach a shared no-op rejection handler to `promise` so that if it rejects and no other observer is attached, Node does not emit an `UnhandledPromiseRejection`
warning. Returns the original promise so callers can mark-and-assign in one expression.

Use this on internal promise handles (`ready`, `exited`, init segments) that a class exposes for callers who may or may not choose to observe them. Callers who
`await` the promise or attach their own `.catch` still see the rejection through their own chain - this helper only marks the promise as observed for Node's
unhandled-rejection tracker.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The resolved value type. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `promise` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\> | The promise to mark handled. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

The same promise, for chained assignment.

#### Example

```ts
this.ready = markHandled(readyResolvers.promise);
```
