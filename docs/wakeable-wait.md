[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / wakeable-wait

# wakeable-wait

A wait a second party can end early under a stated reason, while the lifetime signal stays terminal.

A plugin's connect loop pauses a fixed interval between attempts: sixty seconds under the home's lifetime signal when no gateway answered as the primary, a
minute between looks at a device that has gone quiet. Something else in the plugin learns, mid-pause, that the answer has changed - a discovery browse announces
a gateway, an election picks a different one, an address moves - and the loop reads none of it until its pause runs out, so the change is consumed up to one full
interval late. Nothing in the time-source contract closes that gap: [Clock.delay](clock.md#delay) ends a wait on abort alone, by rejecting, and a rejection is how a
lifetime ends rather than how a loop is nudged.

The shape here is the auto-reset event every threading library ships, expressed in this library's own vocabulary. A consumer holds one object for the life of its
loop, awaits that object instead of the bare delay, and reads a tagged outcome saying which way the pause ended. A wake is remembered rather than dropped: one
that arrives while the loop is off probing rather than pausing is consumed by the next wait, which answers at once without ever registering a delay, so the
change that landed in the wrong window is not the one the design loses.

It is a class of its own rather than a member on [Clock](clock.md#clock), because a wake is not a matter of time and every double of the time source would owe an
implementation of it, and rather than a hook inside `retry`, because the loops that want it are hand-written loops over a bare delay rather than retry calls and
threading a wake through that contract would serve no caller. The lifetime signal is composed per wait and never listened to, so a loop pausing every minute for
weeks accumulates nothing and there is no teardown to own.

## Utilities

### WakeableWait

A wait a second party ends early under a stated reason, resuming the waiter rather than rejecting it.

[WakeableWait.wait](#wait) pauses for `ms` on the injected clock and answers `{ kind: "elapsed" }` when the clock crosses that window, or `{ kind: "woken", reason }`
as soon as [WakeableWait.wake](#wake) is called with that reason. Each is an ordinary return, because a loop that was nudged has work to do and unwinding it through
a rejection would leave every caller writing the same try/catch to get back where it already was. Rejection is reserved for the lifetime.

A wake is remembered until a wait consumes it. Waking while no wait is in progress is not a lost signal: the next wait answers `woken` with that reason at once and
registers no delay at all, which is the auto-reset contract and the whole reason this exists - what a consumer is racing lands as readily while its loop is working
as while its loop is paused. The first wake wins and later ones do nothing until a wait consumes it, exactly as a controller's first `abort()` wins, so waking twice,
or waking a wait that has already ended, is harmless without the consumer checking anything first.

The lifetime is terminal and always wins. Once the supplied signal aborts, a wait in flight rejects with that signal's own reason, a later wait rejects without
touching the clock, and a remembered wake changes neither.

One waiter at a time. A second concurrent [WakeableWait.wait](#wait) throws rather than silently orphaning the first wait's controller and delivering its wake to the
wrong waiter, stated at the boundary in the way [composeSignals](util.md#composesignals) states its own misuse.

There is nothing to dispose. Each wait composes the lifetime signal with a private controller of its own and hands the composite to the clock, so a wake IS an abort
of that private controller and the lifetime signal is read and composed, never listened to. The platform holds a composed signal only while it carries a listener,
and the clock detaches its listener the moment it settles the delay, so a loop pausing every minute for weeks leaves nothing attached to anything.

#### Example

```ts
import { WakeableWait } from "homebridge-plugin-utils";

// The pause a connect loop takes between attempts, bounded by the plugin's lifetime.
const pause = new WakeableWait({ signal: this.signal });

// Whatever learns the answer has changed ends that pause early, in its own vocabulary.
this.browser.on("changed", () => pause.wake("candidates changed"));

// The loop reads which way its pause ended and decides what that means.
const outcome = await pause.wait(60000);

if(outcome.kind === "woken") {

  this.log.debug("Retrying early.", { reason: outcome.reason });
}
```

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `R` | `string` | The consumer's vocabulary for why it woke a wait, delivered verbatim on the `woken` outcome. Defaults to `string`, which is what a consumer wanting a plain label builds without naming the parameter. |

#### Constructors

##### Constructor

```ts
new WakeableWait<R>(options?): WakeableWait<R>;
```

Build a wakeable wait. Construction registers nothing and starts nothing; the first [WakeableWait.wait](#wait) does.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`WakeableWaitOptions`](#wakeablewaitoptions) | See [WakeableWaitOptions](#wakeablewaitoptions). |

###### Returns

[`WakeableWait`](#wakeablewait)\<`R`\>

#### Methods

##### wait()

```ts
wait(ms): Promise<WakeableWaitOutcome<R>>;
```

Wait up to `ms` milliseconds, ending early when [WakeableWait.wake](#wake) is called.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ms` | `number` | How long to wait, in milliseconds, when nothing wakes it. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`WakeableWaitOutcome`](#wakeablewaitoutcome)\<`R`\>\>

`{ kind: "elapsed" }` when the clock crossed `ms`, or `{ kind: "woken", reason }` when a wake ended the wait or was already waiting to be consumed when
         the wait began.

###### Throws

The lifetime signal's own reason when that signal aborts before or during the wait, or an `Error` when a wait is already in progress.

##### wake()

```ts
wake(reason): void;
```

End the wait in progress, or arm the next one, under `reason`.

A wait in flight resolves `{ kind: "woken", reason }` without waiting out the rest of its window. With no wait in progress the reason is remembered and the next
wait consumes it immediately, registering no delay, so a consumer never has to know which side of the pause it caught the loop on. The first wake wins: a second
one arriving before a wait has consumed the first leaves that first reason standing, so a burst of wakes buys one early return rather than overwriting the reason
the consumer is about to read.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason` | `R` | Why the wait is being ended, in the consumer's own vocabulary. Delivered verbatim on the `woken` outcome. |

###### Returns

`void`

***

### WakeableWaitOptions

Construction options for [WakeableWait](#wakeablewait).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="clock"></a> `clock?` | [`Clock`](clock.md#clock) | The time source every wait runs on. Defaults to [systemClock](clock.md#systemclock); a harness injects a `TestClock` and proves the wake on virtual time rather than by sleeping. |
| <a id="signal"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The lifetime. While it is aborted no wait runs at all, and a wait in flight rejects with its reason. Omit it for a wait with no lifetime bound. The signal is only ever read and composed into each wait's own composite - the class attaches no listener to it (see the class documentation). |

***

### WakeableWaitOutcome

```ts
type WakeableWaitOutcome<R> = 
  | {
  kind: "elapsed";
}
  | {
  kind: "woken";
  reason: R;
};
```

How a [WakeableWait.wait](#wait) ended, tagged by `kind` so a consumer branches on the tag rather than on whether a reason happens to be present. The reason is
readable only on the arm that has one, which is what keeps a consumer from reading a reason off a wait that simply ran out.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `R` | The consumer's own vocabulary for why a wait was woken, carried through untouched. |
