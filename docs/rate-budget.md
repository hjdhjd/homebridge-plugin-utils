[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / rate-budget

# rate-budget

A sliding-window rate budget: at most `capacity` grants inside any trailing `window` milliseconds.

The ceilings a budget like this serves are stated as "at most N calls in any W milliseconds", so the enforcement here is exact rather than approximate. The budget
keeps a timestamp log of the grants it has issued and admits a caller only while fewer than `capacity` of those timestamps still fall inside the trailing window. A
token bucket that refills at N/W is the usual shortcut and is the wrong shape for a stated ceiling: a bucket that has sat idle refills to full and then admits a
burst of N grants on top of earlier ones that are still inside the window, so the ceiling is transiently exceeded even though the long-run average is honored. The
timestamp log cannot produce that transient... every grant stays accounted for until the full window has elapsed since it was issued.

The price of exactness is one number per in-window grant - bounded by `capacity`, never by the call rate - plus one prefix prune per admission decision, which is a
small, fixed cost for a mechanism whose whole purpose is to be correct at the boundary.

## Utilities

### RateBudget

A sliding-window rate budget: at most `capacity` grants inside any trailing `window` milliseconds, awaited by callers before they spend a rate-limited call.

Callers queue in first-in-first-out order. [RateBudget.acquire](#acquire) resolves as soon as the log has room and otherwise waits exactly until the oldest grant leaves
the window, so a saturated budget paces callers at the contract's own rate rather than sleeping a fixed interval and hoping.

Cancellation is per-waiter and needs no teardown. A lifetime signal is STORED and never listened to: each `acquire` composes the lifetime signal with its own
optional per-call signal and rejects directly off that composition, so an abandoned budget leaves nothing attached to a long-lived signal and there is nothing to
dispose. That is the deliberate contrast with `TimerRegistry`, which holds real platform timers and therefore must implement `Disposable` and drain them: this class
holds only bookkeeping - an array of numbers and a promise chain - which the garbage collector reclaims on its own.

#### Example

```ts
import { RateBudget } from "homebridge-plugin-utils";

// A published ceiling of at most 30 calls in any trailing five minutes, bounded by the plugin's lifetime.
const budget = new RateBudget({ capacity: 30, signal: this.signal, window: 300000 });

// Each caller waits its turn, then spends its grant. A caller that gives up passes its own signal and consumes no slot.
await budget.acquire({ signal: requestSignal });

const response = await fetch(endpoint, { signal: requestSignal });
```

#### Constructors

##### Constructor

```ts
new RateBudget(options): RateBudget;
```

Construct a budget. Construction schedules nothing and starts no work; the first [RateBudget.acquire](#acquire) does.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`RateBudgetOptions`](#ratebudgetoptions) | See [RateBudgetOptions](#ratebudgetoptions). |

###### Returns

[`RateBudget`](#ratebudget)

###### Throws

`TypeError` if `capacity` is not a positive integer, or if `window` is not a positive, finite number.

#### Accessors

##### available

###### Get Signature

```ts
get available(): number;
```

The number of grants that could be issued right now: `capacity` minus the grants still inside the trailing window, evaluated against the current time.

Reading this prunes the log of grants that have aged out, exactly as an admission decision does - both views run through the same helper, so what a caller can
observe here and what the next `acquire` will decide can never disagree.

###### Returns

`number`

The number of free slots, from `0` to `capacity`.

##### capacity

###### Get Signature

```ts
get capacity(): number;
```

The ceiling this budget was constructed with: the most grants permitted inside any trailing window.

###### Returns

`number`

The configured capacity.

#### Methods

##### acquire()

```ts
acquire(init?): Promise<void>;
```

Wait for a grant, then return. This is the budget's one operation: callers await it immediately before spending the rate-limited call it paces, and it resolves as
soon as the trailing window has room for them.

Callers are served first-in-first-out. A caller that is already queued behind others can still give up promptly - the returned promise races its turn against the
composed signal, so an abort rejects it at once rather than after its predecessors finish waiting. An aborted waiter consumes no slot and records nothing, whether
it aborted before its turn started, while it waited out the window, or before it ever joined the queue.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init?` | \{ `signal?`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Optional per-call options. |
| `init.signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | A per-call abort signal. Aborting it rejects THIS acquire with the signal's reason and leaves every other waiter untouched. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves when the grant has been recorded.

###### Throws

The lifetime signal's reason if the budget's lifetime signal aborts, or the per-call signal's reason if `init.signal` aborts. When both have aborted, the
        lifetime reason wins - it is the more fundamental of the two.

###### Example

```ts
// Pace a rate-limited call, giving up promptly if the caller's own request is cancelled.
await budget.acquire({ signal: requestSignal });

return fetch(endpoint, { signal: requestSignal });
```

***

### RateBudgetOptions

Construction options for [RateBudget](#ratebudget).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="capacity-1"></a> `capacity` | `number` | The maximum number of grants permitted inside any trailing `window`. Must be a positive integer. |
| <a id="clock"></a> `clock?` | [`Clock`](clock.md#clock) | The time source the budget reads and waits against. Defaults to [systemClock](clock.md#systemclock); a test injects a `TestClock` to drive the pacing path in virtual time. |
| <a id="signal"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | A lifetime signal. When it aborts, every pending and every subsequent [RateBudget.acquire](#acquire) rejects with its reason. Omit it for a budget with no lifetime bound. The signal is only ever read and composed into each caller's own wait - the budget attaches no listener to it (see the class documentation). |
| <a id="window"></a> `window` | `number` | The trailing window, in milliseconds, that a grant occupies a slot for. Must be a positive, finite number. |
