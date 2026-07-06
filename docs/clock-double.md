[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / clock-double

# clock-double

A reusable, controllable [Clock](clock.md#clock) test double.

The [Clock](clock.md#clock) seam in `clock.ts` exists so a consuming plugin's time-dependent code can be driven without real wall-clock waits. This module ships the fake that
cashes that in: a [TestClock](#testclock) over a virtual timeline a test advances explicitly. `now()` returns the virtual time; `delay()` registers a pending wait that
resolves only when [TestClock.advance](#advance) crosses its deadline, or rejects when its signal aborts - matching `node:timers/promises` `setTimeout`'s `AbortError`
shape. No real timers and no wall-clock are used, so a consumer's pacing/timeout/duration path runs deterministically and instantly under test.

The double builds on the library's own primitives rather than hand-rolling them: [onAbort](util.md#onabort) wires the abort listener and yields the `Disposable` that detaches
it, and `Promise.withResolvers` captures each pending wait's deferred. The abort listener is detached on EITHER resolution path (deadline-crossed or aborted), so no
listener leaks onto a long-lived signal across many short waits.

## Testing

### TestClock

A controllable [Clock](clock.md#clock) double over virtual time. `now()` returns the current virtual time; `delay()` registers a pending wait that resolves only when
[TestClock.advance](#advance) crosses its deadline (in ascending-deadline order), or rejects with an `AbortError` (matching `node:timers/promises` `setTimeout` - `name`
`"AbortError"`, `code` `"ABORT_ERR"`, NOT the signal's reason) when its signal aborts. No real timers or wall-clock are used.

The virtual time is a RELATIVE timeline seeded at `start` (default `0`), NOT real epoch milliseconds. A consumer that compares `now()` against an absolute real-epoch
constant would diverge; consumers must only compare `now()` values to each other (deriving elapsed intervals from differences), which is the only use a
`Date.now()`-style read serves in the consuming pacing path - all its time reads come from the one injected clock.

#### Example

```ts
import { TestClock } from "homebridge-plugin-utils";

const clock = new TestClock();

const waited = clock.delay(100);

// Nothing resolves until virtual time crosses the deadline.
clock.advance(100);

await waited;
```

#### See

Clock

#### Implements

- [`Clock`](clock.md#clock)

#### Constructors

##### Constructor

```ts
new TestClock(start?): TestClock;
```

Construct a clock seeded at `start` (default `0`). The seed is the initial value `now()` returns; `advance` moves it forward (or back, for a negative delta).

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `start` | `number` | `0` | The initial virtual time, in the consumer's relative timeline. Defaults to `0`. |

###### Returns

[`TestClock`](#testclock)

#### Accessors

##### pending

###### Get Signature

```ts
get pending(): number;
```

The number of registered delays that have neither resolved nor rejected. A test reads this to assert a consumer registered its waits and later cleared them (no
leak).

###### Returns

`number`

The count of unsettled delays.

#### Methods

##### advance()

```ts
advance(ms): void;
```

Advance virtual time by `ms` and resolve every delay whose deadline the new time has reached. The delta is applied regardless of sign, so a negative `ms` moves time
backward; `advance(0)` moves time nowhere but STILL flushes any already-due entry (a `delay(0)` or a `delay` with a non-positive `ms`), so a zero or negative delay
is never a lost wakeup.

Due entries resolve in ASCENDING deadline order; entries that share a deadline keep their FIFO registration order, because the snapshot is taken before any removal
and the numeric sort is stable - matching how `setTimeout` fires equal-deadline timers in scheduling order. Each due entry is removed by identity and has its abort
listener detached before it resolves, so the resolve path leaks no listener and the iteration is immune to the index shifts a forward in-place splice would cause.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ms` | `number` | The amount of virtual time to advance, in milliseconds. May be zero or negative. |

###### Returns

`void`

##### delay()

```ts
delay(ms, init?): Promise<void>;
```

Register a delay that resolves when virtual time reaches `this.now() + ms`, or rejects with an `AbortError` (matching `node:timers/promises`) if `init.signal` aborts
first. A non-positive `ms` yields a deadline at or before the current time, which the very next [TestClock.advance](#advance) (including `advance(0)`) flushes.

A pre-aborted signal rejects on the executor's microtask exactly as `systemClock` does (NOT a synchronous throw): [onAbort](util.md#onabort) fires the handler inline, which
removes the just-registered entry and rejects, so the entry never lingers in `pending`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ms` | `number` | The delay, in milliseconds. May be zero or negative (flushed by the next `advance`). |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. A supplied `signal` rejects the wait with an `AbortError` when it aborts. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves when the deadline is crossed, or rejects with an `AbortError` if the signal aborts first.

###### Implementation of

[`Clock`](clock.md#clock).[`delay`](clock.md#delay)

##### now()

```ts
now(): number;
```

Return the current virtual time. Compare these values to each other to derive elapsed intervals - they are a relative timeline, not real epoch milliseconds.

###### Returns

`number`

The current virtual time.

###### Implementation of

[`Clock`](clock.md#clock).[`now`](clock.md#now)
