[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / delivery-supervisor

# delivery-supervisor

Windows of named slots that each settle exactly once, under one deadline armed on the injected clock.

A plugin that sends a command and then waits for the world to agree it happened carries the same lifecycle every time: open a window when the command goes out,
arm one deadline for it, answer each thing the window is waiting on as the evidence arrives, and make sure every waiting consumer is answered exactly once
however the window ends. Getting that bookkeeping wrong is silent in both directions - a slot answered twice corrupts whatever the consumer wrote back on the
first answer, and a slot never answered leaves a caller waiting for something that can no longer come.

The supervisor owns that bookkeeping and deliberately nothing else. A consumer opens a window under a key of its own, names the slots it will be answering, and
hands over a deadline callback; from there it settles slots with its own outcome type as its own evidence arrives. Everything domain-shaped stays the consumer's:
what counts as evidence, what a deadline should do about it, how many rounds are worth spending, and which words a settled slot is answered with. The reasons the
supervisor closes a slot on its own initiative travel as a [DeliveryYield](#deliveryyield) it owns, so neither vocabulary ever has to be reconciled against the other.

One answer per slot is structural rather than careful: a slot carries the flag that records it has been claimed, one chokepoint on its window is the only place
that flag flips, and every path into a settlement - a consumer's `settle`, a fault sweep, an invalidation, the abort sweep - goes through it.

This is the run-once-per-window corner of the library's dispatch mechanisms, beside `CoalescingTask`'s run-on-demand shape and `superviseLoop`'s run-forever one.

## Utilities

### DeliverySupervisor

A supervisor of delivery windows: each window is a set of named slots that settle exactly once, under one deadline armed on the injected clock.

A consumer opens a window under a key of its own choosing, names the slots the window is waiting on, and says how long to wait and what to do when that wait
lapses. From there it answers slots as its own evidence arrives, and the supervisor guarantees the rest: exactly one settlement per slot, one deadline per window
cleared the moment the last slot answers, a fresh window under a standing key yielding the old one, and every pending slot answered when the lifetime ends, when
the consumer invalidates, or when a deadline callback throws.

What the supervisor does NOT own is as deliberate as what it does. It has no notion of evidence, no re-send policy, no opinion about how many rounds a delivery is
worth, and no vocabulary for a successful outcome - every one of those is the consumer's, reached through the deadline callback and the slot handles. That division
is what lets consumers with completely different domain logic share one piece of lifecycle bookkeeping.

The supervisor owns its own [TimerRegistry](timer-registry.md#timerregistry) rather than taking one, and registers its terminal sweep before constructing it. That ordering is the guarantee
that an aborted lifetime answers every waiting consumer before the deadlines are drained, and owning the registry is what keeps that ordering from having to be
re-derived by every consumer.

#### Example

```ts
import { DeliverySupervisor } from "homebridge-plugin-utils";

// One window per command, one slot per thing the command asked for, and the plugin's own words on every settled slot.
const deliveries = new DeliverySupervisor<"confirmed" | "unconfirmed">({ onError: (error) => this.report(error), signal: this.signal });

const window = deliveries.open("shade." + id.toString(), {

  deadline: 4000,
  onDeadline: (open) => this.reissue(open),
  onSettle: (slot, settlement) => this.answer(id, slot, settlement),
  slots: [ "primary", "tilt" ]
});

// Evidence from the wire answers the slot it speaks to, and the deadline never speaks for a slot that has already been answered.
window.slots.get("primary")?.settle("confirmed");
```

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `T` | `void` | The outcome a settled slot carries, in the consumer's own vocabulary. Defaults to `void` for a consumer that has no outcome to give, whose slots are then settled with a bare `slot.settle()`. |

#### Implements

- [`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

#### Constructors

##### Constructor

```ts
new DeliverySupervisor<T>(options): DeliverySupervisor<T>;
```

Construct a supervisor. Construction opens no windows and arms no timers.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`DeliverySupervisorOptions`](#deliverysupervisoroptions)\<`T`\> | See [DeliverySupervisorOptions](#deliverysupervisoroptions). |

###### Returns

[`DeliverySupervisor`](#deliverysupervisor)\<`T`\>

#### Methods

##### \[dispose\]()

```ts
dispose: void;
```

End the supervisor without ending its lifetime signal: every pending slot of every standing window is yielded `"invalidated"`, the registry is retired so no
deadline can outlive this call, and the abort listener is detached from the lifetime signal. A second disposal has nothing left to answer, a registry already
retired, and a listener already detached, so it does nothing.

###### Returns

`void`

###### Implementation of

```ts
Disposable.[dispose]
```

##### get()

```ts
get(key): DeliveryWindow<T> | undefined;
```

The window currently standing under `key`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The consumer key to read. |

###### Returns

[`DeliveryWindow`](#deliverywindow)\<`T`\> \| `undefined`

The standing window, or `undefined` when none stands under `key`.

##### has()

```ts
has(key): boolean;
```

Whether a window is currently standing under `key`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The consumer key to test. |

###### Returns

`boolean`

`true` when a window stands under `key`, otherwise `false`.

##### invalidate()

```ts
invalidate(keys?): void;
```

Yield every pending slot of the named windows, or of every standing window when no keys are named, with the reason `"invalidated"`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `keys?` | readonly `string`[] | The consumer keys to invalidate. Omit to invalidate every standing window. |

###### Returns

`void`

##### open()

```ts
open(key, options): DeliveryWindow<T>;
```

Open a window under `key`, arming its deadline and answering the handle a consumer settles its slots through. A window already standing under `key` has every
pending slot of its own yielded `"superseded"`, and its handles stay valid and inert afterwards.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The consumer's key for this window. |
| `options` | [`OpenDeliveryWindowOptions`](#opendeliverywindowoptions)\<`T`\> | See [OpenDeliveryWindowOptions](#opendeliverywindowoptions). |

###### Returns

[`DeliveryWindow`](#deliverywindow)\<`T`\>

The window, whose slots are the ones `options.slots` named.

###### Throws

The lifetime signal's reason when the supervisor's lifetime has already ended - a verb on a dead resource, so a consumer that owes its own callers an
answer says so in its own vocabulary before calling.

###### Throws

`TypeError` when `options.slots` is empty or names the same slot twice.

##### windows()

```ts
windows(): IterableIterator<DeliveryWindow<T>>;
```

The windows currently standing, so a consumer can run the membership sweeps its own domain defines - closing every window that shares a member with a newer
one, or that a fresher command has overtaken. The supervisor owns same-key supersession and named-or-wholesale invalidation and nothing beyond them, because
anything further requires knowing what a window's slots mean.

###### Returns

`IterableIterator`\<[`DeliveryWindow`](#deliverywindow)\<`T`\>\>

An iterator over the standing windows.

***

### DeliverySlot

One thing a window is waiting to learn, and the handle a consumer answers it through.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's outcome type. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="settled"></a> `settled` | `readonly` | `boolean` | Whether this slot has been answered, by any path at all. A settled slot is finished for good: no later call changes what it was answered with. |

#### Methods

##### settle()

```ts
settle(...outcome): boolean;
```

Answer this slot with the consumer's own outcome.

The rest tuple is what lets a consumer with no outcome to give - a `T` of `void`, which is the supervisor's own default - write `slot.settle()`, while any other
`T` requires exactly its one argument. The emptiness test is spelled against `Exclude` and a one-element tuple rather than as a bare `T extends void`, so that it
answers on the whole of `T` instead of distributing across a union and handing a union-typed slot two different argument lists.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| ...`outcome` | \[`Exclude`\<`T`, `void`\>\] *extends* \[`never`\] ? \[\] : \[`T`\] | The outcome this slot is settled with, for every `T` other than `void`. |

###### Returns

`boolean`

`true` when this call settled the slot, `false` when it was already settled. A stale caller therefore learns that nothing happened rather than being
told a second answer landed.

***

### DeliverySupervisorOptions

Construction options for [DeliverySupervisor](#deliverysupervisor).

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `T` | `void` | The consumer's outcome type, the same one the supervisor these options build carries. Defaults to `void`, so a consumer whose slots have no outcome to give names the type without a parameter. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="clock"></a> `clock?` | `readonly` | [`Clock`](clock.md#clock) | The time source every deadline is armed on. It is handed through unresolved to the [TimerRegistry](timer-registry.md#timerregistry) that arms the timer, which is the one place the default is applied, so a consumer that injects a clock drives its supervised deadlines on the same timeline as its awaited waits. |
| <a id="onerror"></a> `onError` | `readonly` | (`error`, `window`) => `void` | Where the error a deadline callback threw is reported, together with the window whose callback threw it, after every pending slot of that window has already been answered. The window is what lets a consumer name the subject of the fault from the key and slot names it opened the window with, rather than keeping a catch of its own alongside this one. The callback carries the consumer's entire fault policy - the logging, the wording, the recovery - which is why the supervisor itself stays logging-free. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The supervisor's lifetime. When it aborts, every pending slot of every standing window is yielded `"aborted"` before the deadlines are retired, and opening a further window throws. |

***

### DeliveryWindow

One open window: the slots it is waiting on, and the deadline it is waiting under.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's outcome type. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="key"></a> `key` | `readonly` | `string` | The consumer's own key for this window - the one [DeliverySupervisor.open](#open), [DeliverySupervisor.has](#has), [DeliverySupervisor.get](#get), and [DeliverySupervisor.invalidate](#invalidate) all speak. The key the deadline is armed under is the supervisor's own and is never shown here. |
| <a id="pending"></a> `pending` | `readonly` | `number` | How many of this window's slots are still unsettled. |
| <a id="settled-1"></a> `settled` | `readonly` | `boolean` | Whether every slot has settled, which is `pending` reading zero. |
| <a id="slots"></a> `slots` | `readonly` | `ReadonlyMap`\<`string`, [`DeliverySlot`](#deliveryslot)\<`T`\>\> | This window's slots, by the names the window was opened with. |

#### Methods

##### rearm()

```ts
rearm(delay): void;
```

Give a pending window one more round: re-arm its deadline for another `delay` milliseconds. The re-arm replaces the window's own standing deadline rather than
adding a second one, so a window is never waiting under two clocks at once. A no-op on a settled window, which has nothing left to decide.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `delay` | `number` | The new window, in milliseconds. |

###### Returns

`void`

***

### OpenDeliveryWindowOptions

What opening a window takes.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's outcome type. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="deadline"></a> `deadline` | `readonly` | `number` | How long the window runs before its deadline callback is called, in milliseconds on the supervisor's clock. |
| <a id="ondeadline"></a> `onDeadline` | `readonly` | (`window`) => \| `void` \| [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | What to do when the deadline lapses with slots still pending. It runs inside the supervisor's own catch, so a throw from anywhere it reaches answers every pending slot rather than orphaning them, and it receives the window so it can read what is still outstanding, settle slots itself, or buy another round with [DeliveryWindow.rearm](#rearm). |
| <a id="onsettle"></a> `onSettle?` | `readonly` | (`slot`, `settlement`) => `void` | Called once per slot for every settlement, whether the consumer settled the slot or the supervisor closed it. |
| <a id="slots-1"></a> `slots` | `readonly` | readonly `string`[] | The names of the slots this window is waiting on. Every name must be distinct and the list must not be empty. |

***

### DeliverySettlement

```ts
type DeliverySettlement<T> = 
  | {
  kind: "settled";
  outcome: T;
}
  | {
  kind: "yielded";
  reason: DeliveryYield;
};
```

What a slot's settlement callback receives, exactly once: either the consumer's own outcome or the reason the supervisor closed the slot.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The consumer's outcome type, whatever a settled slot means in its domain. |

***

### DeliveryYield

```ts
type DeliveryYield = "aborted" | "faulted" | "invalidated" | "superseded";
```

Why the supervisor closed a slot itself, rather than the consumer settling it with an outcome of its own.

These are the whole set of closures the supervisor initiates: `"aborted"` when the lifetime signal ends, `"faulted"` when a window's deadline callback threw,
`"invalidated"` when the consumer called [DeliverySupervisor.invalidate](#invalidate) or disposed the supervisor, and `"superseded"` when a newer window opened under the
same key. Every other way a slot can be answered is the consumer's own vocabulary, carried as the slot's `T`.
