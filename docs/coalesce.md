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

This is the run-on-demand corner of the library's dispatch mechanisms, and it is deliberately the only thing it is. `guardedDispatch` owns the fire-and-forget failure
surface, and this class dispatches through it rather than restating it, so a failed pass lands in the log instead of escaping as an unhandled rejection.
`superviseLoop` owns the run-forever shape, where the work is a loop that should keep going for as long as its lifetime lasts. This owns the run-on-demand shape, where
the work has nothing to do until something asks, and asking twice must not mean running twice.

## Utilities

### CoalescingTask

A single-flight task: one pass runs at a time, and any number of triggers arriving during a pass buy exactly one more.

Asking is the whole of the surface. [CoalescingTask.schedule](#schedule) asks for a pass and returns immediately: an idle task starts one now, a task already running takes
note and runs once more when the pass in flight finishes. A burst of triggers arriving during a pass therefore buys exactly one follow-up rather than one pass apiece,
and a trigger arriving after everything has settled starts a fresh pass of its own.

The lifetime signal is honored at both ends. Once it aborts, a trigger starts nothing at all, and a follow-up that was queued before the abort is abandoned rather than
run into a lifetime that is over.

#### Example

```ts
import { CoalescingTask } from "homebridge-plugin-utils";

// A refresh several event sources can ask for, none of which should ever run it against itself.
const refresh = new CoalescingTask({ label: "device refresh", log: this.log, run: () => this.refreshDevices(), signal: this.signal });

// Every trigger is a bare call - the task decides whether that means starting a pass or buying the one follow-up.
this.client.on("configuration-changed", () => refresh.schedule());
this.client.on("reconnected", () => refresh.schedule());
```

#### Constructors

##### Constructor

```ts
new CoalescingTask(options): CoalescingTask;
```

Build a coalescing task. Construction starts nothing; the first [CoalescingTask.schedule](#schedule) does.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`CoalescingTaskOptions`](#coalescingtaskoptions) | See [CoalescingTaskOptions](#coalescingtaskoptions). |

###### Returns

[`CoalescingTask`](#coalescingtask)

#### Methods

##### schedule()

```ts
schedule(): void;
```

Ask for a pass. A pass already running takes note and runs once more when it finishes; an idle task starts one now.

The dispatch is guarded rather than awaited, because every caller is an event handler or a timer that has nothing to wait for and a fault has to land in the log
rather than escape as an unhandled rejection.

###### Returns

`void`

***

### CoalescingTaskOptions

Construction options for [CoalescingTask](#coalescingtask).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="label"></a> `label` | `string` | What to call this task in the line a failed pass writes. |
| <a id="log"></a> `log` | [`HomebridgePluginLogging`](util.md#homebridgepluginlogging) | Where a failed pass is reported. |
| <a id="run"></a> `run` | () => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | The pass itself. It is never invoked concurrently with itself. |
| <a id="signal"></a> `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The task's lifetime. Once it is aborted no further pass is run, and a queued follow-up is abandoned. |
