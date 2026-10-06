[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / clock

# clock

An injectable wall-clock interface, and the cancellable deadline built on it.

Time-dependent code reads the platform time primitives it needs: the current epoch time (`Date.now()`), a delay that can be cancelled (`node:timers/promises`
`setTimeout`), and a callback timer (the global `setTimeout` / `setInterval`). Calling those directly bakes real wall-clock time into the code, so a test cannot
exercise a pacing or timeout path without multi-second real waits. Holding a [Clock](#clock) instead - the abstraction over those primitives - inverts the
dependency: production wires [systemClock](#systemclock), whose `now()` IS `Date.now()`, whose `delay()` IS `node:timers/promises` `setTimeout`, and whose `schedule()` IS
the global callback timers, so routing through Clock is behavior-neutral; a test wires a `TestClock` (see `clock-double.ts`) that advances virtual time
explicitly, so the consumer's time-dependent path runs deterministically and instantly.

A deadline handed to an abortable call is a function over the contract rather than a member of it: [armDeadline](#armdeadline) arms one of a clock's own callback timers
to abort a signal, and answers a [Deadline](#deadline) its holder disposes when the work it bounds settles. Every clock that implements `schedule` therefore answers a
deadline, on the same timeline as its waits and its timers, and one construction serves them all.

One contract covers every shape of time rather than one contract per shape, so a consumer that awaits a wait, a consumer that arms a callback deadline, and a
consumer that hands a deadline's signal to an abortable call all share a single lever: a scenario spanning a backoff, a heartbeat, and a bounded request is driven
by one clock instead of by separate mechanisms stepped in concert.

The one place the production clock is more than the primitive it wraps is the platform timer's ceiling. Node arms every timer on a 32-bit signed millisecond count.
Its callback and promise timers set a delay past 2147483647 ms (a little under 25 days) to one millisecond, with a warning, rather than refusing it - so a token
refresh or an expiry armed against a distant boundary would fire at once. The production clock carries such a delay itself, arming at most the ceiling and
re-arming for the remainder until the requested moment, and the contract states it, so a consumer states the delay it means and never clamps for the platform.

This module imports `node:timers/promises` and is therefore Node-only (not browser-safe), like `util.ts`. A browser-targeted consumer cannot resolve that import.

## Utilities

### Clock

The injectable wall-clock contract: the platform time primitives time-dependent code reads. A consumer holds a `Clock` rather than calling `Date.now()` /
`node:timers/promises` `setTimeout` / the global callback timers directly, so a test can substitute a controllable double (`TestClock`) and drive time
deterministically while production behavior stays unchanged through [systemClock](#systemclock).

`delay` and `schedule` deliberately sit on different platform entry points: `delay` keeps the promise primitive from `node:timers/promises` and that primitive's
`AbortError` semantics, while `schedule` reaches the global callback timers. A consumer's choice of shape - an awaited wait or an armed callback - is what decides
which primitive it lands on, and the double drives them all from one virtual timeline. A deadline handed to an abortable call needs no member of its own, because
[armDeadline](#armdeadline) arms it through `schedule`. Every member that arms time carries a delay past the platform timer's ceiling in full, as the module's opening note
states, so a consumer never clamps a delay for the platform.

#### See

systemClock

#### Methods

##### delay()

```ts
delay(ms, init?): Promise<void>;
```

Resolve after `ms` milliseconds, or reject if `init.signal` aborts first. The production [systemClock](#systemclock) implements this as `node:timers/promises` `setTimeout`,
so an abort rejects with that primitive's `AbortError` (`name` `"AbortError"`, `code` `"ABORT_ERR"`) rather than the signal's reason. A delay past the platform
timer's ceiling is carried in full: the production clock awaits the primitive once per hop of at most the ceiling, each hop under the caller's signal.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ms` | `number` | The delay, in milliseconds. |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional init options. `signal` cancels the delay - resolving the wait early with a rejection - when it aborts. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | - |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves after the delay, or rejects with an `AbortError` if the signal aborts first.

##### now()

```ts
now(): number;
```

Return the current time as epoch milliseconds. The production [systemClock](#systemclock) implements this as `Date.now()`.

###### Returns

`number`

The current time in epoch milliseconds.

##### schedule()

```ts
schedule(
   callback, 
   ms, 
   init?
): Disposable;
```

Arm a callback timer: run `callback` once after `ms` milliseconds, or every `ms` milliseconds when `init.repeat` is `true`. The production [systemClock](#systemclock)
implements this as the global `setTimeout` / `setInterval` read at call time, so any harness that replaces those globals observes the timer. A window past the
platform timer's ceiling is carried in full: the production clock arms at most the ceiling and re-arms for the remainder, for a one-shot and for each period of a
repeat alike, so the callback runs when asked.

With `init.unref` set the timer never holds the process open, so a process whose only pending work is timers armed this way exits without waiting for them...the
shape for a consumer living inside a process that must exit on its own. Omitted, the platform's default holds: a referenced timer keeps the process alive until
it fires or is disposed. Either way the timer is armed and comes due exactly the same, so the flag decides only whether the process waits for it.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `callback` | () => `void` | The function to run when the timer fires. |
| `ms` | `number` | The timer's window, in milliseconds. |
| `init?` | \{ `repeat?`: `boolean`; `unref?`: `boolean`; \} | Optional init options. `repeat` arms a repeating timer that fires every `ms` until it is disposed, rather than a one-shot; `unref` arms a timer that does not hold the process open. |
| `init.repeat?` | `boolean` | - |
| `init.unref?` | `boolean` | - |

###### Returns

[`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

A handle whose `[Symbol.dispose]` cancels the timer. Disposing after a one-shot has already fired, and disposing a second time, do nothing.

***

### Deadline

A deadline armed by [armDeadline](#armdeadline): the signal that aborts when the span elapses, and the disposer that releases the timer behind it. Its holder hands
`signal` to the work it bounds and disposes the deadline when that work settles, with `using` where the work is a scope.

#### Extends

- [`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Aborts with the platform's `TimeoutError` once the deadline elapses. A deadline disposed before then leaves its signal unaborted for good. |

***

### systemClock

```ts
const systemClock: Clock;
```

The behavior-neutral production [Clock](#clock): `now()` IS `Date.now()`, `delay()` IS `node:timers/promises` `setTimeout`, and `schedule()` IS the global callback
timers. A consumer that routes its time reads through this clock instead of calling those primitives directly cannot observe any behavior change - it is the same
platform calls, one indirection removed - except past the platform timer's ceiling, where the platform would fire at once and this clock fires when asked.

#### See

Clock

***

### TIMER\_DELAY\_MAX\_MS

```ts
const TIMER_DELAY_MAX_MS: 2147483647 = 2147483647;
```

The platform timer's ceiling in milliseconds. Node arms a callback timer and a promise delay alike on a 32-bit signed count, while the ceiling itself arms
silently. A callback timer or a promise delay past this value is set to one millisecond with a TimeoutOverflowWarning. The production clock carries a delay past
the ceiling as a chain of arms of at most this length, so the value is the hop size as well as the boundary.

A consumer reads it to state a delay relative to the ceiling rather than restating the platform's number - a test arming a window one past it, or advancing a
ceiling's worth of time and asserting nothing has fired yet. A consumer never clamps a delay to it, because a [Clock](#clock) carries a longer delay itself.

***

### armDeadline()

```ts
function armDeadline(ms, options?): Deadline;
```

Arm a deadline of `ms` milliseconds on a clock, answering a [Deadline](#deadline) whose signal aborts when the span elapses and whose disposal releases the timer.

The signal aborts with the platform's deadline reason: a `DOMException` whose `name` is `"TimeoutError"`, the reason `AbortSignal.timeout` aborts with and the
library's own `isTimeoutReason` predicate accepts. The abort is one of the clock's own callback timers, armed through `schedule` with `unref` set, so a pending
deadline never holds the process open. On [systemClock](#systemclock) that timer is the global `setTimeout` its `schedule` reads at call time, so a harness that replaces
the global, `node:test` mock timers among them, drives the deadline as it drives every other timer the clock arms; on a `TestClock` it is an ordinary one-shot that
`advance` crosses and `requested` records.

Because the deadline is `schedule`'s timer, the span's domain is `schedule`'s as well: a span past the platform timer's ceiling is carried in full, and a negative,
non-finite, or fractional span takes whatever handling the clock's `schedule` gives it, as every other span the clock is handed does.

Its holder releases the deadline when the work it bounds settles - with `using` where that work is a scope - so no timer outlives the work and a virtual timeline
holds no entry for work already done. Disposing after the deadline fired, and disposing a second time, do nothing. Composing the deadline's signal with a caller's
own stays the job of `composeSignals` rather than of the deadline, so a consumer assembles the lifetime it wants from the primitive it already reaches for
everywhere else.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ms` | `number` | The deadline, in milliseconds. |
| `options` | \{ `clock?`: [`Clock`](#clock); \} | Optional deadline options. |
| `options.clock?` | [`Clock`](#clock) | The time source the deadline is armed on. Defaults to [systemClock](#systemclock). |

#### Returns

[`Deadline`](#deadline)

A [Deadline](#deadline) carrying the signal, for its holder to dispose when the work it bounds settles.

#### Example

```ts
async function readStatus(url: string, clock: Clock, signal?: AbortSignal): Promise<unknown> {

  // The deadline bounds the request and the body read alike, and is released when the function finishes.
  using deadline = armDeadline(5000, { clock });

  const response = await fetch(url, { signal: composeSignals(signal, deadline.signal) });

  return await response.json();
}
```
