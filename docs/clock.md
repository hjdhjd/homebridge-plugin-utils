[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / clock

# clock

An injectable wall-clock interface.

Time-dependent code reads the platform time primitives it needs: the current epoch time (`Date.now()`), a delay that can be cancelled (`node:timers/promises`
`setTimeout`), and a callback timer (the global `setTimeout` / `setInterval`). Calling those directly bakes real wall-clock time into the code, so a test cannot
exercise a pacing or timeout path without multi-second real waits, and `node:test`'s mock timers do not patch the `node:timers/promises` primitives. Holding a
[Clock](#clock) instead - the abstraction over those primitives - inverts the dependency: production wires [systemClock](#systemclock), whose `now()` IS `Date.now()`, whose
`delay()` IS `node:timers/promises` `setTimeout`, and whose `schedule()` IS the global callback timers, so routing through Clock is behavior-neutral; a test wires a
`TestClock` (see `clock-double.ts`) that advances virtual time explicitly, so the consumer's time-dependent path runs deterministically and instantly.

One contract covers both time shapes rather than one per shape, so a consumer that awaits a wait and a consumer that arms a callback deadline share a single lever:
a scenario spanning a backoff and a heartbeat is driven by one clock instead of two mechanisms stepped in concert.

This module imports `node:timers/promises` and is therefore Node-only (not browser-safe), like `util.ts`. A browser-targeted consumer cannot resolve that import.

## Utilities

### Clock

The injectable wall-clock contract: the platform time primitives time-dependent code reads. A consumer holds a `Clock` rather than calling `Date.now()` /
`node:timers/promises` `setTimeout` / the global callback timers directly, so a test can substitute a controllable double (`TestClock`) and drive time
deterministically while production behavior stays unchanged through [systemClock](#systemclock).

`delay` and `schedule` deliberately sit on different platform entry points: `delay` keeps the promise primitive from `node:timers/promises` and that primitive's
`AbortError` semantics, while `schedule` reaches the global callback timers. A consumer's choice of shape - an awaited wait or an armed deadline - is what decides
which primitive it lands on, and the double drives both from one virtual timeline.

#### See

systemClock

#### Methods

##### delay()

```ts
delay(ms, init?): Promise<void>;
```

Resolve after `ms` milliseconds, or reject if `init.signal` aborts first. The production [systemClock](#systemclock) implements this as `node:timers/promises` `setTimeout`,
so an abort rejects with that primitive's `AbortError` (`name` `"AbortError"`, `code` `"ABORT_ERR"`) rather than the signal's reason.

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
implements this as the global `setTimeout` / `setInterval` read at call time, so any harness that replaces those globals observes the timer.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `callback` | () => `void` | The function to run when the timer fires. |
| `ms` | `number` | The timer's window, in milliseconds. |
| `init?` | \{ `repeat?`: `boolean`; \} | Optional init options. `repeat` arms a repeating timer that fires every `ms` until it is disposed, rather than a one-shot. |
| `init.repeat?` | `boolean` | - |

###### Returns

[`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

A handle whose `[Symbol.dispose]` cancels the timer. Disposing after a one-shot has already fired, and disposing a second time, do nothing.

***

### systemClock

```ts
const systemClock: Clock;
```

The behavior-neutral production [Clock](#clock): `now()` IS `Date.now()`, `delay()` IS `node:timers/promises` `setTimeout`, and `schedule()` IS the global callback
timers. A consumer that routes its time reads through this clock instead of calling those primitives directly cannot observe any behavior change - it is the same
platform calls, one indirection removed at test time.

#### See

Clock
