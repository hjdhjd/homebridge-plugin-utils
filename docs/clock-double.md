[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / clock-double

# clock-double

A reusable, controllable [Clock](clock.md#clock) test double.

The [Clock](clock.md#clock) seam in `clock.ts` exists so a consuming plugin's time-dependent code can be driven without real wall-clock waits. This module ships the fake that
cashes that in: a [TestClock](#testclock) over a virtual timeline a test advances explicitly. `now()` returns the virtual time; `delay()` registers a pending wait that
resolves only when [TestClock.advance](#advance) crosses its deadline, or rejects when its signal aborts - matching `node:timers/promises` `setTimeout`'s `AbortError`
shape. No real timers and no wall-clock are used, so a consumer's pacing/timeout/duration path runs deterministically and instantly under test.

Beside the timeline the double keeps the ledger a pacing assertion reads: `requested` is every `ms` a consumer asked for, in call order, and `advanceToNext()`
steps straight to the earliest pending deadline - so a suite drives a consumer's schedule by the numbers the consumer chose rather than by numbers it restates.

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
import { TestClock } from "homebridge-plugin-utils/testing";

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

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="requested"></a> `requested` | `readonly` | `number`[] | `[]` | Every `ms` a [TestClock.delay](#delay) call asked for, in call order. A request lands here before its wait is registered and whatever later becomes of that wait, so a delay the clock crossed, one whose signal aborted mid-wait, and one whose signal was already aborted all appear. That is the ledger a suite does its cadence arithmetic against - a history that dropped the waits which never came due would understate exactly the loops worth asserting on. |

#### Accessors

##### nextDeadline

###### Get Signature

```ts
get nextDeadline(): Nullable<number>;
```

The earliest deadline among the registered delays that have neither resolved nor rejected, and `null` when nothing is pending. A test reads it to assert WHEN a
consumer's next wait comes due, where [TestClock.pending](#pending) answers how many of them are outstanding.

###### Returns

[`Nullable`](util.md#nullable)\<`number`\>

The earliest pending deadline, in virtual time, or `null` when no delay is pending.

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

##### advanceToNext()

```ts
advanceToNext(): boolean;
```

Advance virtual time to the earliest pending deadline and settle everything due there - the step a consumer's next real timer firing would produce. A clock
with nothing pending answers `false` and moves no time.

The step is `Math.max(0, deadline - now())`, so an entry that is already due - a `delay(0)`, or a `delay` with a negative `ms` - is flushed through
[TestClock.advance](#advance)'s zero path rather than reached backward for. Entries sharing the earliest deadline settle together within the one step, in
[TestClock.advance](#advance)'s own order, since `advance` stays the single place an entry settles. A whole schedule drains with
`while(clock.advanceToNext()) { ... }`: each pass settles one deadline's worth of waits, and the loop ends when nothing is left.

###### Returns

`boolean`

`true` when a deadline was stepped to, `false` when nothing was pending.

##### delay()

```ts
delay(ms, init?): Promise<void>;
```

Register a delay that resolves when virtual time reaches `this.now() + ms`, or rejects with an `AbortError` (matching `node:timers/promises`) if `init.signal` aborts
first. A non-positive `ms` yields a deadline at or before the current time, which the very next [TestClock.advance](#advance) (including `advance(0)`) flushes.

A pre-aborted signal rejects on the executor's microtask exactly as `systemClock` does (NOT a synchronous throw): [onAbort](util.md#onabort) fires the handler inline, which
removes the just-registered entry and rejects, so the entry never lingers in `pending`. Either way the call's `ms` is recorded in [TestClock.requested](#requested).

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
