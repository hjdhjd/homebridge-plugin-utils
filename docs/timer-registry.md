[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / timer-registry

# timer-registry

A lifetime-bounded registry of callback timers.

A long-lived owner - a HomeKit accessory, a controller subsystem - accumulates timers it must all cancel when it tears down: keyed one-shots that a later registration
under the same key should replace, keyed intervals that repeat until cleared, and anonymous fire-and-forget one-shots with no identity to replace. This registry holds
all three under one disposal story. Arming a keyed timer replaces any prior timer under that key; a keyed one-shot removes its own entry before firing, so the callback
reads the key as already gone; an anonymous one-shot self-removes on fire; and `dispose()`, or an aborted lifetime signal, drains every pending timer and makes every
later registration inert, so a timer can never outlive the owner it was armed against.

This is the callback-timer half of the library's time mechanisms: `Clock` owns awaited, promise-shaped delays, and this registry owns callback timers - one mechanism
per shape, neither reaching into the other's territory.

## Utilities

### TimerRegistry

A lifetime-bounded registry of callback timers: keyed one-shots and intervals, plus anonymous tracked one-shots.

The surface is minimal on purpose:

  - `setTimeout(key, callback, delay)` / `setInterval(key, callback, interval)` arm a keyed timer. Registering under a key that already holds a timer - of either
    kind - clears the prior timer first, so the newest intent for a key wins. A keyed one-shot removes its entry before firing; a keyed interval repeats until cleared.
  - `schedule(callback, delay)` arms an anonymous one-shot: tracked for disposal, self-removing on fire, never replacing anything, so concurrent anonymous timers
    coexist.
  - `clear(key)` cancels and removes a keyed timer; `has(key)` reports whether one is currently armed.
  - `dispose()` (and `[Symbol.dispose]`) drains every pending timer and retires the registry: subsequent registrations are no-ops. An `options.signal` binds the same
    drain to the owner's lifetime, so the owner never has to unwire the registry by hand at teardown.

This is a `Disposable` (synchronous) rather than `AsyncDisposable` because cancelling a timer is synchronous; there is no background work to await.

#### Example

```ts
using timers = new TimerRegistry({ signal: this.signal });

timers.setTimeout("relock", () => this.relock(), 5000);
timers.setInterval("heartbeat", () => this.beat(), 1000);
timers.schedule(() => this.settle(), 50);
```

#### Implements

- [`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

#### Constructors

##### Constructor

```ts
new TimerRegistry(options?): TimerRegistry;
```

Construct a registry. Construction schedules no timers. When `options.signal` is supplied, the abort handler is wired through [onAbort](util.md#onabort) last, against the
already-initialized containers and flag; a signal already aborted at that point disposes the registry synchronously here, so it is born drained and inert.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`TimerRegistryOptions`](#timerregistryoptions) | See [TimerRegistryOptions](#timerregistryoptions). |

###### Returns

[`TimerRegistry`](#timerregistry)

#### Methods

##### \[dispose\]()

```ts
dispose: void;
```

`Disposable` implementation, delegating to [dispose](#dispose-1) so the registry composes with `using` declarations and disposer stacks.

###### Returns

`void`

###### Implementation of

```ts
Disposable.[dispose]
```

##### clear()

```ts
clear(key): void;
```

Cancel and remove the keyed timer under `key`. Silently does nothing when no timer is armed under the key.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The identity to clear. |

###### Returns

`void`

##### dispose()

```ts
dispose(): void;
```

Clear every pending timer, keyed and anonymous, and retire the registry: after disposal every registration method is a no-op, so a timer can never arm against a
torn-down owner. Disposal is a no-op on repeat.

###### Returns

`void`

##### has()

```ts
has(key): boolean;
```

Whether a keyed timer is currently armed under `key`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The identity to test. |

###### Returns

`boolean`

`true` when a keyed timer is armed under `key`, otherwise `false`.

##### schedule()

```ts
schedule(callback, delay): void;
```

Arm an anonymous one-shot: tracked for disposal, self-removing on fire, and never replacing anything. Concurrent anonymous timers coexist; this is the shape for
fire-and-forget work that has no identity to replace. A no-op once the registry is disposed or its lifetime signal has aborted.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `callback` | () => `void` | The function to run once, after `delay`. |
| `delay` | `number` | The delay, in milliseconds. |

###### Returns

`void`

##### setInterval()

```ts
setInterval(
   key, 
   callback, 
   interval): void;
```

Arm a keyed repeating timer. Any timer already armed under `key` - one-shot or interval - is cleared first, the same replace-on-register rule as [setTimeout](#settimeout).
The entry persists across fires until [clear](#clear) removes it or the registry is disposed. A no-op once the registry is disposed or its lifetime signal has aborted.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The identity under which the timer is tracked; a later registration under the same key replaces this one. |
| `callback` | () => `void` | The function to run on every interval. |
| `interval` | `number` | The interval, in milliseconds. |

###### Returns

`void`

##### setTimeout()

```ts
setTimeout(
   key, 
   callback, 
   delay): void;
```

Arm a keyed one-shot. Any timer already armed under `key` - one-shot or interval - is cleared first, so registering under a key declares the current intent for it
and the newest intent wins. The entry is removed BEFORE the callback runs, so the callback, and anything it triggers, reads `has(key)` as `false` for a fired timer.
A no-op once the registry is disposed or its lifetime signal has aborted.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The identity under which the timer is tracked; a later registration under the same key replaces this one. |
| `callback` | () => `void` | The function to run once, after `delay`. |
| `delay` | `number` | The delay, in milliseconds. |

###### Returns

`void`

***

### TimerRegistryOptions

Construction options for [TimerRegistry](#timerregistry).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="signal"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | A lifetime signal. When it aborts, the registry drains every pending timer and every later registration becomes inert; a signal already aborted at construction time means the registry is born disposed. Omit it for a registry whose only lifetime bound is an explicit `dispose()`. |
