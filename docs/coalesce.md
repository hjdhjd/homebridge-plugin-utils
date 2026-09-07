[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / coalesce

# coalesce

One asynchronous pass at a time, with a burst of triggers collapsing into a single follow-up.

A recurring shape in plugin work is an event source that fires far more often than the work it triggers needs to run: a controller announcing a configuration change
several times in a second, a reconnect path asking for a fresh look at the network while a look is already underway, a subscription delivering a burst of updates that
all resolve to the same refresh. Running the work once per trigger is wasteful, and wrong outright when the work is not safe to run against itself; dropping the extra
triggers is wrong too, because whatever arrived after the pass had already read its inputs is simply lost. The answer in every case is the same: run one pass, and if
anything asked while that pass was running, run exactly one more - however many asked.

This is the run-on-demand corner of the library's dispatch mechanisms, and it is deliberately the only thing it is. The drain owns each pass's fault and reports it on
the task's own line, rather than handing the whole dispatch to a guard: a guard wrapping the drain ends it at the first fault, and the follow-up a trigger bought while
that pass was running is work somebody asked for and a fault says nothing about. `superviseLoop` owns the run-forever shape, where the work is a loop that should keep
going for as long as its lifetime lasts. This owns the run-on-demand shape, where the work has nothing to do until something asks, and asking twice must not mean
running twice.

## Utilities

### CoalescingTask

A single-flight task: one pass runs at a time, and any number of triggers arriving during a pass buy exactly one more.

Asking is the whole of the surface, in a spelling that discards the answer and a spelling that hands it back. [CoalescingTask.schedule](#schedule) asks for a pass and
returns nothing: an idle task starts one now, a task already running takes note and runs once more when the pass in flight finishes. A burst of triggers arriving
during a pass therefore buys exactly one follow-up rather than one pass apiece, and a trigger arriving after everything has settled starts a fresh pass of its own.
[CoalescingTask.request](#request) asks in precisely that way and returns the promise of the drain that answers - a fresh drain's when the task is idle, the drain in
flight's when a pass is running, and the same promise object for every asker of that drain - settling with the verdict of the last pass the drain runs, because a
request made mid-pass bought the follow-up so that the answer reflects inputs the running pass had already read past.

The lifetime signal is honored at both ends. Once it aborts, a trigger starts nothing at all, and a follow-up that was queued before the abort is abandoned rather than
run into a lifetime that is over.

A failed pass is reported on the task's own line whichever spelling asked for it. What a requester reads back beyond that is the drain's own end: a drain that ends
on a fault rejects its requesters with it, the last pass's once every follow-up a trigger bought has run, or the logger's own if it threw while reporting a pass. A
consumer that wants a verdict in every case therefore converts the fault inside its own pass, where the wording and the fallback are its business rather than this
class's. A request made after the lifetime has ended rejects with the signal's reason and runs nothing.

#### Example

```ts
import { CoalescingTask } from "homebridge-plugin-utils";

// A refresh several event sources can ask for, none of which should ever run it against itself.
const refresh = new CoalescingTask({ label: "device refresh", log: this.log, run: () => this.refreshDevices(), signal: this.signal });

// Every trigger is a bare call - the task decides whether that means starting a pass or buying the one follow-up.
this.client.on("configuration-changed", () => refresh.schedule());
this.client.on("reconnected", () => refresh.schedule());

// The one asker that needs the answer awaits the drain that serves it, rather than asking and hoping.
const found = await refresh.request();
```

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `T` | `void` | The verdict each pass answers, in the consumer's own vocabulary, and what [CoalescingTask.request](#request) settles with. Defaults to `void` for a task whose passes have nothing to answer, which is what every fire-and-forget consumer builds without naming the parameter. |

#### Constructors

##### Constructor

```ts
new CoalescingTask<T>(options): CoalescingTask<T>;
```

Build a coalescing task. Construction starts nothing; the first [CoalescingTask.schedule](#schedule) does.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`CoalescingTaskOptions`](#coalescingtaskoptions)\<`T`\> | See [CoalescingTaskOptions](#coalescingtaskoptions). |

###### Returns

[`CoalescingTask`](#coalescingtask)\<`T`\>

#### Methods

##### request()

```ts
request(): Promise<T>;
```

Ask for a pass and read back what it answers. A pass already running takes note and runs once more when it finishes; an idle task starts one now.

The promise is the drain's settlement: a fresh drain's when the task is idle, and the drain in flight's when a pass is running, which is the identical promise
every other asker of that drain holds. It settles with the verdict of the last pass that drain runs, rejects with the fault the drain ends on, and rejects with the
signal's reason once the lifetime has ended, in which case no pass runs at all.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

The verdict of the last pass run by the drain that serves this request.

##### schedule()

```ts
schedule(): void;
```

Ask for a pass. A pass already running takes note and runs once more when it finishes; an idle task starts one now.

This is the fire-and-forget spelling: it discards the answer and marks the promise handled, because every caller here is an event handler or a timer with nothing
to wait for. A last pass that failed, a lifetime that has already ended, and a logger that throws while reporting a pass each reach that promise as a rejection,
and an unobserved rejection is the worst way for any of them to surface.

###### Returns

`void`

***

### CoalescingTaskOptions

Construction options for [CoalescingTask](#coalescingtask).

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `T` | `void` | The verdict a pass answers and a requester reads back. Defaults to `void` for the fire-and-forget form, whose passes have nothing to answer. |

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="label"></a> `label` | `string` | What to call this task in the line a failed pass writes. |
| <a id="log"></a> `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Where a failed pass is reported. |
| <a id="run"></a> `run` | () => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\> | The pass itself. It is never invoked concurrently with itself. Whatever the pass answers is the verdict a requester reads back, so a pass with nothing to answer is typed `void`, which is the fire-and-forget form. |
| <a id="signal"></a> `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The task's lifetime. Once it is aborted no further pass is run, and a queued follow-up is abandoned. |
