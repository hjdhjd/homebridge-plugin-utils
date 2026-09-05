[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / testing

# testing

Every piece of shipped test-support surface the library offers, reachable at one entry point.

The package publishes one subpath per concern - the log client, the explicit-resource-management polyfills, the ESLint preset - and this is the concern named test
support. A consumer reaches all of it through `homebridge-plugin-utils/testing`: the cross-cutting helpers defined below - the capturing logger and its entry
finders, the unhandled-rejection assertion, the shared poll-with-deadline, and the macrotask yield with the two `TestClock` walks built on it - the runtime-floor
guard machinery in `runtime-floor.ts` beside this file, and the test doubles that stand in for the library's own dependency-inversion boundaries.

The doubles are aggregated here, not relocated. Each one still sits beside the production module it stands in for - `clock-double.ts` beside `clock.ts`,
`recording-process-double.ts` beside `record.ts`, `socket-double.ts` beside `socket.ts`, `mqtt-client-double.ts` beside `mqttClient.ts` - because a double and its
subject drift apart the moment they stop sharing a directory. Only their export path lives here. The helpers and the guard machinery are the other case: they have
no production subject to sit beside, so this directory is where they are defined rather than merely re-exported.

Nothing in production may import from this module, and that is what the dedicated subpath buys over a category tag on the main barrel. The production/test category
boundary becomes structural: a production module reaching for a double names a specifier that a reader and a grep can both see is wrong, rather than one everybody
has to remember not to write.

## Testing

### TestLogEntry

A single captured log emission from [capturingLog](#capturinglog-1). The tuple `(level, message, params)` mirrors what `HomebridgePluginLogging`'s methods receive; the shape is
narrow enough that tests can assert against it with `deepEqual` while carrying through the originating level so callers can filter by severity.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="level"></a> `level` | `"warn"` \| `"error"` \| `"debug"` \| `"info"` | The severity the log method was called at. |
| <a id="message"></a> `message` | `string` | The message passed to the log method. |
| <a id="params"></a> `params` | `unknown`[] | The remaining arguments passed to the log method alongside `message`. |

***

### CapturingLog

```ts
type CapturingLog = HomebridgePluginLogging & {
  entries: readonly TestLogEntry[];
};
```

[capturingLog](#capturinglog-1)'s return shape: a live [HomebridgePluginLogging](util.md#homebridgepluginlogging) plus a `readonly` view of the entries captured so far. The read-only typing lets tests
assert against `entries` without being able to mutate them - the only code that pushes into the array is the logger methods themselves, which the factory closes
over in the live mutable reference.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `entries` | readonly [`TestLogEntry`](#testlogentry)[] |

***

### advanceThroughSchedule()

```ts
function advanceThroughSchedule(clock, waits): Promise<void>;
```

Walk `clock` through a schedule of waits, letting the queue come to rest before each step and once more after the last.

A subject registers its next wait only after the one before it has settled, so a single advance across the whole schedule moves past deadlines that were never
registered and strands every wait after the first; stepping releases one wait at a time. The trailing yield lets whatever the last step released run to completion, so
the caller reads a finished body rather than one still mid-continuation.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `clock` | [`TestClock`](clock-double.md#testclock) | The clock whose virtual time the walk moves. |
| `waits` | readonly `number`[] | The waits to step through, in the order the subject registers them. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

#### Example

```ts
// An operation whose backoff schedule is 100 ms and then 200 ms, walked to completion.
await advanceThroughSchedule(clock, [ 100, 200 ]);

assert.equal(clock.now(), 300);
```

***

### assertNoUnhandledRejections()

```ts
function assertNoUnhandledRejections<T>(body): Promise<T>;
```

Run `body` while monitoring `process`'s `unhandledRejection` channel, and assert that no rejections surface during execution. Turns Node's default
warn-and-continue behavior into a hard test assertion, so tests that claim "this flow does not trigger an unhandled rejection" get deterministic coverage rather
than relying on log inspection.

Node emits `unhandledRejection` one turn of the event loop after a Promise rejects without a handler; the helper drains with a `setImmediate` before asserting so
any pending emissions surface before the check.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The resolved value type of `body`. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `body` | () => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\> | Async body to execute under monitoring. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

The body's resolved value.

#### Throws

`AssertionError` if `body` triggered one or more unhandled rejections.

#### Example

```ts
await assertNoUnhandledRejections(async () => {

  const resolvers = Promise.withResolvers<string>();
  await assert.rejects(waitWithSignal(resolvers.promise, abortedSignal));
  resolvers.reject(new Error("late"));
});
```

***

### capturingLog()

```ts
function capturingLog(): CapturingLog;
```

Return a capturing [HomebridgePluginLogging](util.md#homebridgepluginlogging) implementation. Every method pushes a [TestLogEntry](#testlogentry) into the logger's `entries` array; tests then assert
against that array to verify the class under test emitted the expected log lines at the expected severities.

Lives here for the same reason as [silentLog](#silentlog): the shape is identical across every test file that asserts on log output, and repeating the logger's
arrow-function bodies per test file is pure duplication. The `entries` view is `readonly` so tests cannot accidentally corrupt captured state mid-run; the factory
itself closes over the underlying mutable array so the logger methods can still push.

#### Returns

[`CapturingLog`](#capturinglog)

A logger that records every emission for later assertion.

#### Example

```ts
import { capturingLog } from "homebridge-plugin-utils/testing";

const log = capturingLog();

classUnderTest.doSomething(log);

assert.equal(log.entries.at(-1)?.level, "info");
```

***

### drainClock()

```ts
function drainClock(clock, limit?): Promise<number>;
```

Step `clock` to each pending deadline until nothing is pending, and answer how many steps that took.

The bound is what separates a finished drain from a spinning one: a repeating timer never empties the list, and a suite that hangs on one is a far worse failure than
a suite that throws naming the limit it was given. Every step is followed by a yield before the clock is asked for the next deadline, so the continuations a step
released have registered their own waits before the drain decides it is finished...which is also what lets the work after the last deadline run before the count comes
back.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `clock` | [`TestClock`](clock-double.md#testclock) | `undefined` | The clock to drain. |
| `limit` | `number` | `1000` | The maximum number of steps to take. Defaults to 1000. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`number`\>

The number of deadlines stepped to, which is zero for a clock that had nothing pending.

#### Throws

`Error` when the clock still has entries pending after `limit` steps.

#### Example

```ts
// A body awaiting two delays in sequence, drained to completion.
const steps = await drainClock(clock);

assert.equal(steps, 2);
```

***

### expectAt()

```ts
function expectAt<T>(
   items, 
   index, 
   description?
): T;
```

Return `items[index]`, asserting the element exists. Narrows the result to `T` so test bodies can use the value without non-null assertions and without a separate
`assert.ok`/use pair on every access.

Designed for `noUncheckedIndexedAccess`-strict codebases where `items[index]` is typed `T | undefined` even inside a `length`-checked block. Test helpers that walk
a collection and distinguish specific indices (e.g., "the first emitted record should be ..." / "the second should be ...") are the primary use case.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The element type of `items`. Assumes `T` does not include `undefined`; if it does, the assertion cannot distinguish a valid `undefined` element from an out-of-bounds index. |

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `items` | readonly `T`[] | `undefined` | The collection to index into. |
| `index` | `number` | `undefined` | The index to read. Negative indices are not supported (would always fail the assertion). |
| `description` | `string` | `"an item"` | Optional human-readable descriptor for the failure message. Defaults to `"an item"`. |

#### Returns

`T`

The element at `index`, narrowed to `T`.

#### Throws

`AssertionError` if `items[index]` is `undefined` (either because the index is out of bounds or because the element itself is `undefined`).

#### Example

```ts
const boxes = Array.from(parser.consume(chunk));

assert.deepEqual(expectAt(boxes, 0, "first box").bytes, expected);
```

***

### formatLogEntry()

```ts
function formatLogEntry(entry): string;
```

Render a captured [TestLogEntry](#testlogentry) the way a real logger prints it, interpolating `params` into `message`'s format tokens.

Plugin log calls carry their values printf-style - `log.info("Retrying in %d seconds.", 30)` - so the value a test cares about lives in `params` and never appears
in the captured `message` at all. Rendering is what puts it back into a single string that can be matched. This is the one rendering definition the finders below
compose, and it is exported on its own so a harness that wants the rendered line for an assertion shape of its own does not re-derive the render.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `entry` | [`TestLogEntry`](#testlogentry) | The captured entry to render. |

#### Returns

`string`

The entry's message with its params interpolated.

***

### logCount()

```ts
function logCount(
   entries, 
   level, 
   substring
): number;
```

Count the entries at `level` whose rendered line contains `substring`, matching by the same rules as [loggedAt](#loggedat).

Distinct from [loggedAt](#loggedat) because "emitted exactly once" is a stronger claim than "emitted at all", and it is the one worth pinning around retry loops and
reconnect handlers: a path that logs its warning on every attempt satisfies a presence check and fails a count of one.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `entries` | readonly [`TestLogEntry`](#testlogentry)[] | The captured entries to search. |
| `level` | `"warn"` \| `"error"` \| `"debug"` \| `"info"` | The severity to restrict the count to. |
| `substring` | `string` | The text to look for in the rendered line. |

#### Returns

`number`

The number of entries at `level` whose rendered line contains `substring`.

***

### loggedAt()

```ts
function loggedAt(
   entries, 
   level, 
   substring
): boolean;
```

Report whether any entry at `level`, once rendered through [formatLogEntry](#formatlogentry), contains `substring`.

The render is what makes the match meaningful - a search of the raw `message` field misses every value that arrived as a format parameter. The level restriction is
part of the assertion rather than a convenience: "this was reported as an error" and "this was mentioned at debug" are different claims about the same text.

Takes the entries array rather than the [CapturingLog](#capturinglog) itself, so a caller can search a slice. `loggedAt(log.entries.slice(before), "info", "Reconnected")`
answers "one more line after the reconnect" without standing up a second logger, and a harness holding a bare array needs no adapter.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `entries` | readonly [`TestLogEntry`](#testlogentry)[] | The captured entries to search. |
| `level` | `"warn"` \| `"error"` \| `"debug"` \| `"info"` | The severity to restrict the search to. |
| `substring` | `string` | The text to look for in the rendered line. |

#### Returns

`boolean`

`true` when at least one entry at `level` renders to a line containing `substring`.

#### Example

```ts
import { capturingLog, loggedAt } from "homebridge-plugin-utils/testing";

const log = capturingLog();

classUnderTest.retry(log);

// The emission was `log.warn("Retrying in %d seconds.", 30)`, so "30" is nowhere in the captured message...only the render finds it.
assert.ok(loggedAt(log.entries, "warn", "30"));
```

***

### settle()

```ts
function settle(turns?): Promise<void>;
```

Yield to the macrotask queue `turns` times, so the continuations a test has already released have run by the time it looks at what they did.

Each turn yields one macrotask, which drains the entire microtask cascade first: a chain of promise continuations - an attempt's rejection, the checks that follow it,
the clock registration those checks arm - comes to rest before the caller looks. One turn is the default, and it is enough for any cascade that stays in promise-land;
a caller names more turns only when its subject's cascade crosses more than one macrotask boundary of its own, a handshake whose steps each schedule the next being
the usual case. A `turns` of zero yields nothing at all.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `turns` | `number` | `1` | How many macrotask boundaries to cross. Defaults to 1. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

#### Example

```ts
clock.advance(100);
await settle();

assert.equal(attempts.length, 2);
```

***

### silentLog()

```ts
function silentLog(): HomebridgePluginLogging;
```

Return a no-op [HomebridgePluginLogging](util.md#homebridgepluginlogging) implementation. Every method is present and well-typed, but discards its input - the tests that consume this fixture
treat logging as implementation detail and assert against behavior rather than captured log output.

Derives from the production `noOpLog` SSOT in `util.ts` via spread, so the no-op method set has exactly one definition library-wide rather than re-declaring the
interface shape and per-method void-return annotations here. The spread yields a fresh object per call - the identity contract this helper's tests pin - while every
method is the shared, stateless no-op.

#### Returns

[`HomebridgePluginLogging`](util.md#homebridgepluginlogging)

A logger whose methods are all no-ops.

#### Example

```ts
import { silentLog } from "homebridge-plugin-utils/testing";

const client = new MqttClient({ brokerUrl: "mqtt://localhost", log: silentLog(), topicPrefix: "test" });
```

***

### waitUntil()

```ts
function waitUntil(predicate, options): Promise<void>;
```

Resolve as soon as `predicate()` reads `true`, polling every `pollMs` milliseconds until a deadline `timeoutMs` out, and throw when the deadline passes with the
predicate still false.

This is the one poll-with-deadline the test suites share, for the waits whose subject is a state that settles on a later tick rather than on an event a test can
await directly: a datagram the kernel delivers on the loopback interface, a log line a handler emits, a client's connection flag flipping once its CONNACK is
parsed. A deadline that fails loudly is what makes those waits honest...a fixed sleep passes on the absence of evidence, and it pays its full duration on every
run whether or not the state settled in the first millisecond.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `predicate` | () => `boolean` | The condition to poll. Called immediately and then once per interval, so a state that is already settled costs no wait at all. |
| `options` | \{ `description`: `string`; `pollMs?`: `number`; `timeoutMs?`: `number`; \} | Wait options. |
| `options.description` | `string` | What the wait is for, in the grammar of "waiting for _____". It is the whole of the failure message, so name the state rather than the assertion. |
| `options.pollMs?` | `number` | Milliseconds between polls. Defaults to 5. |
| `options.timeoutMs?` | `number` | Maximum total wait, in milliseconds. Defaults to 1000 - a comfortable margin for localhost timing on a slow CI runner. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

#### Throws

`Error` when `timeoutMs` elapses with the predicate still false.

#### Example

```ts
await waitUntil(() => receiver.received.length >= 1, { description: "the forwarded datagram to arrive" });
```

## Other

### assertRuntimeFloorCompat

Re-exports [assertRuntimeFloorCompat](testing/runtime-floor.md#assertruntimefloorcompat)

***

### composeSunsetCleanup

Re-exports [composeSunsetCleanup](testing/runtime-floor.md#composesunsetcleanup)

***

### HDLR\_TYPE\_VIDE

Re-exports [HDLR_TYPE_VIDE](ffmpeg/fmp4-builders.md#hdlr_type_vide)

***

### makeBox

Re-exports [makeBox](ffmpeg/fmp4-builders.md#makebox)

***

### makeContainer

Re-exports [makeContainer](ffmpeg/fmp4-builders.md#makecontainer)

***

### makeHdlrBox

Re-exports [makeHdlrBox](ffmpeg/fmp4-builders.md#makehdlrbox)

***

### makeTrunBox

Re-exports [makeTrunBox](ffmpeg/fmp4-builders.md#maketrunbox)

***

### parseRuntimeFloor

Re-exports [parseRuntimeFloor](testing/runtime-floor.md#parseruntimefloor)

***

### planRuntimeFloorCheck

Re-exports [planRuntimeFloorCheck](testing/runtime-floor.md#planruntimefloorcheck)

***

### readEnginesNode

Re-exports [readEnginesNode](testing/runtime-floor.md#readenginesnode)

***

### RuntimeFloor

Re-exports [RuntimeFloor](testing/runtime-floor.md#runtimefloor)

***

### RuntimeFloorPlan

Re-exports [RuntimeFloorPlan](testing/runtime-floor.md#runtimefloorplan)

***

### RuntimeFloorPlanQuery

Re-exports [RuntimeFloorPlanQuery](testing/runtime-floor.md#runtimefloorplanquery)

***

### RuntimeFloorQuery

Re-exports [RuntimeFloorQuery](testing/runtime-floor.md#runtimefloorquery)

***

### SourceSweep

Re-exports [SourceSweep](testing/runtime-floor.md#sourcesweep)

***

### SunsetCleanupFrame

Re-exports [SunsetCleanupFrame](testing/runtime-floor.md#sunsetcleanupframe)

***

### sweepSourceFiles

Re-exports [sweepSourceFiles](testing/runtime-floor.md#sweepsourcefiles)

***

### SweptFile

Re-exports [SweptFile](testing/runtime-floor.md#sweptfile)

***

### TestClock

Re-exports [TestClock](clock-double.md#testclock)

***

### TestLogSocket

Re-exports [TestLogSocket](logclient/socket-double.md#testlogsocket)

***

### TestLogSocketFactory

Re-exports [TestLogSocketFactory](logclient/socket-double.md#testlogsocketfactory)

***

### TestLogSocketInit

Re-exports [TestLogSocketInit](logclient/socket-double.md#testlogsocketinit)

***

### TestMqttClient

Re-exports [TestMqttClient](mqtt-client-double.md#testmqttclient)

***

### TestMqttPublish

Re-exports [TestMqttPublish](mqtt-client-double.md#testmqttpublish)

***

### TestMqttSubscription

Re-exports [TestMqttSubscription](mqtt-client-double.md#testmqttsubscription)

***

### TestRecordingProcess

Re-exports [TestRecordingProcess](ffmpeg/recording-process-double.md#testrecordingprocess)

***

### TestRecordingProcessFactory

Re-exports [TestRecordingProcessFactory](ffmpeg/recording-process-double.md#testrecordingprocessfactory)

***

### TestRecordingProcessInit

Re-exports [TestRecordingProcessInit](ffmpeg/recording-process-double.md#testrecordingprocessinit)

***

### TestWebSocket

Re-exports [TestWebSocket](logclient/socket-double.md#testwebsocket)

***

### TestWebSocketFactory

Re-exports [TestWebSocketFactory](logclient/socket-double.md#testwebsocketfactory)
