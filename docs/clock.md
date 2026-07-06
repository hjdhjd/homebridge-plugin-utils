[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / clock

# clock

An injectable wall-clock time seam.

Time-dependent code reads the platform time primitives it needs: the current epoch time (`Date.now()`) and a delay that can be cancelled (`node:timers/promises`
`setTimeout`). Calling those directly bakes real wall-clock time into the code, so a test cannot exercise a pacing or timeout path without multi-second real waits, and
`node:test`'s mock timers do not patch the `node:timers/promises` primitives. Holding a [Clock](#clock) instead - the abstraction over those primitives - inverts the
dependency: production wires [systemClock](#systemclock), whose `now()` IS `Date.now()` and whose `delay()` IS `node:timers/promises` `setTimeout`, so routing through the seam
is behavior-neutral; a test wires a `TestClock` (see `clock-double.ts`) that advances virtual time explicitly, so the consumer's time-dependent path runs
deterministically and instantly.

This module imports `node:timers/promises` and is therefore Node-only (not browser-safe), like `util.ts`. A browser-targeted consumer cannot resolve that import.

## Utilities

### Clock

The injectable wall-clock contract: the platform time primitives time-dependent code reads. A consumer holds a `Clock` rather than calling `Date.now()` /
`node:timers/promises` `setTimeout` directly, so a test can substitute a controllable double (`TestClock`) and drive time deterministically while production behavior
stays unchanged through [systemClock](#systemclock).

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

***

### systemClock

```ts
const systemClock: Clock;
```

The behavior-neutral production [Clock](#clock): `now()` IS `Date.now()` and `delay()` IS `node:timers/promises` `setTimeout`. A consumer that routes its time reads
through this clock instead of calling those primitives directly cannot observe any behavior change - it is the same two calls, one indirection removed at test time.

#### See

Clock
