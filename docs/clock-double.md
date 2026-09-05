[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / clock-double

# clock-double

A reusable, controllable [Clock](clock.md#clock) test double.

The [Clock](clock.md#clock) contract in `clock.ts` exists so a consuming plugin's time-dependent code can be driven without real wall-clock waits. This module ships the fake
that cashes that in: a [TestClock](#testclock) over one virtual timeline a test advances explicitly. `now()` returns the virtual time; `delay()` registers a pending wait
that resolves only when [TestClock.advance](#advance) crosses its deadline, or rejects when its signal aborts - matching `node:timers/promises` `setTimeout`'s
`AbortError` shape; `schedule()` registers a callback timer that runs inside `advance` when its deadline is crossed, once or on repeat. No real timers and no
wall-clock are used, so a consumer's pacing, timeout, and heartbeat paths all run deterministically and instantly under test.

Both shapes share ONE timeline, which is the point: a scenario spanning a backoff wait and a liveness deadline is driven by a single `advance` rather than by a
clock for the waits and a mock-timer harness for the deadlines, and they interleave exactly as the platform would order them.

Beside the timeline the double keeps the ledger a pacing assertion reads: `requested` is every `ms` a consumer asked for, in call order, and `advanceToNext()`
steps straight to the earliest pending deadline - so a suite drives a consumer's schedule by the numbers the consumer chose rather than by numbers it restates.

The double builds on the library's own primitives rather than hand-rolling them: [onAbort](util.md#onabort) wires the abort listener and yields the `Disposable` that detaches
it, and `Promise.withResolvers` captures each pending wait's deferred. The abort listener is detached on EITHER resolution path (deadline-crossed or aborted), so no
listener leaks onto a long-lived signal across many short waits.

## Testing

### TestClock

A controllable [Clock](clock.md#clock) double over virtual time, carrying awaited delays and callback timers on one timeline. `now()` returns the current virtual time;
`delay()` registers a pending wait that resolves only when [TestClock.advance](#advance) crosses its deadline (in ascending-deadline order), or rejects with an
`AbortError` (matching `node:timers/promises` `setTimeout` - `name` `"AbortError"`, `code` `"ABORT_ERR"`, NOT the signal's reason) when its signal aborts;
`schedule()` registers a callback timer that `advance` runs when it crosses that deadline, once or on repeat. No real timers or wall-clock are used.

A callback and an awaited delay settle at different moments, which a test that observes both has to account for: a callback runs SYNCHRONOUSLY inside `advance`,
while an awaited delay's continuation runs on a later microtask, so a callback firing at the same deadline as a delay observes the state `advance` has reached
rather than the state the awaiting code will later see.

The virtual time is a RELATIVE timeline seeded at `start` (default `0`), NOT real epoch milliseconds. A consumer that compares `now()` against an absolute real-epoch
constant would diverge; consumers must only compare `now()` values to each other (deriving elapsed intervals from differences), which is the only use a
`Date.now()`-style read serves in the consuming pacing path - all its time reads come from the one injected clock.

#### Example

```ts
import { TestClock } from "homebridge-plugin-utils/testing";

const clock = new TestClock();

const waited = clock.delay(100);
using heartbeat = clock.schedule(() => beat(), 25, { repeat: true });

// Nothing resolves and nothing fires until virtual time crosses each deadline.
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
| <a id="requested"></a> `requested` | `readonly` | `number`[] | `[]` | Every `ms` a [TestClock.delay](#delay) or [TestClock.schedule](#schedule) call asked for, in call order. A request lands here before its entry is registered and whatever later becomes of that entry, so a delay the clock crossed, one whose signal aborted mid-wait, one whose signal was already aborted, and a cancelled callback timer all appear. That is the ledger a suite does its cadence arithmetic against - a history that dropped the entries which never came due would understate exactly the loops worth asserting on. Delays and callback timers share it, so a clock driving several timers at once is read BY VALUE (`requested.includes(...)`, a count of a given window) rather than at a fixed index, since the interleaving depends on what the consumer armed when. |

#### Accessors

##### nextDeadline

###### Get Signature

```ts
get nextDeadline(): Nullable<number>;
```

The earliest deadline among the registered entries that have not yet settled - delays and callback timers alike - and `null` when nothing is pending. A test reads
it to assert WHEN a consumer's next wait or next timer comes due, where [TestClock.pending](#pending) answers how many of them are outstanding.

###### Returns

[`Nullable`](util.md#nullable)\<`number`\>

The earliest pending deadline, in virtual time, or `null` when nothing is pending.

##### pending

###### Get Signature

```ts
get pending(): number;
```

The number of registered entries that have not yet settled, counting pending delays and armed callback timers together. A test reads this to assert a consumer
registered its waits and timers and later cleared them (no leak). A repeating timer counts once and keeps counting until its handle is disposed.

###### Returns

`number`

The count of outstanding entries.

#### Methods

##### advance()

```ts
advance(ms): void;
```

Advance virtual time by `ms`, resolving every delay and running every callback timer whose deadline the new time has reached. The delta is applied regardless of
sign, so a negative `ms` moves time backward; `advance(0)` moves time nowhere but STILL flushes any already-due entry (a `delay(0)`, a zero-delay callback timer, or
an entry with a non-positive `ms`), so a zero or negative window is never a lost wakeup.

Due entries settle in ASCENDING deadline order; entries that share a deadline keep their FIFO registration order, because each pass snapshots before any removal and
the numeric sort is stable - matching how the platform fires equal-deadline timers in scheduling order. A delay is removed by identity and has its abort listener
detached before it resolves, so the resolve path leaks no listener; a one-shot is removed before its callback runs; a repeat re-arms from its own deadline and stays.

A callback runs synchronously inside this call, so it observes the clock mid-pass and may register or cancel entries. Anything it arms that is ALREADY due fires
within this same `advance`, exactly as the platform processes it within one tick - which also means a callback that re-arms a zero-delay one-shot on every fire
spins here as it would spin on the platform.

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

Advance virtual time to the earliest pending deadline and settle everything due there - the step a consumer's next real timer firing would produce. Delays and
callback timers are equal candidates for that deadline. A clock with nothing pending answers `false` and moves no time.

The step is `Math.max(0, deadline - now())`, so an entry that is already due - a `delay(0)`, or an entry with a negative `ms` - is flushed through
[TestClock.advance](#advance)'s zero path rather than reached backward for. Entries sharing the earliest deadline settle together within the one step, in
[TestClock.advance](#advance)'s own order, since `advance` stays the single place an entry settles. A whole schedule drains with
`while(clock.advanceToNext()) { ... }`: each pass settles one deadline's worth of entries, and the loop ends when nothing is left - though a repeating timer never
empties the list, so a drain loop over one of those needs its own bound.

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

##### schedule()

```ts
schedule(
   callback, 
   ms, 
   init?): Disposable;
```

Register a callback timer that [TestClock.advance](#advance) runs when virtual time reaches its deadline: once at `this.now() + ms`, or every `ms` from that point when
`init.repeat` is set. The callback runs synchronously inside `advance`, not on a microtask, so a test reads its effects immediately after the advance returns.

A repeat floors BOTH its first deadline and its period at one millisecond, because the platform's `setInterval` floors a zero or negative period the same way - a
repeat seeded from a raw zero would otherwise fire once per pass rather than once per elapsed millisecond. A one-shot's deadline is uncoerced, matching `delay`, so
a non-positive `ms` comes due at or before the current time and the very next `advance` (including `advance(0)`) flushes it. The call's `ms` is recorded in
[TestClock.requested](#requested) as asked, before either coercion.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `callback` | () => `void` | The function to run when the timer fires. |
| `ms` | `number` | The timer's window, in milliseconds. |
| `init?` | \{ `repeat?`: `boolean`; \} | Optional init options. `repeat` arms a repeating timer rather than a one-shot. |
| `init.repeat?` | `boolean` | - |

###### Returns

[`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

A handle whose `[Symbol.dispose]` cancels the timer by removing its entry from the timeline. Disposing after a one-shot has fired, and disposing a second
time, find nothing to remove and do nothing.

###### Implementation of

[`Clock`](clock.md#clock).[`schedule`](clock.md#schedule)
