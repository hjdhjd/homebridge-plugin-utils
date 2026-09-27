[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / testing

# testing

Every piece of shipped test-support surface the library offers, reachable at one entry point.

The package publishes one subpath per concern - the log client, the explicit-resource-management polyfills, the ESLint preset - and this is the concern named test
support. A consumer reaches all of it through `homebridge-plugin-utils/testing`: the cross-cutting helpers defined below - the capturing logger and its entry
finders, the unhandled-rejection assertion, the shared poll-with-deadline and the turn-budgeted poll beside it, the macrotask yield with the two `TestClock` walks
built on it, and the real-socket family that reserves a port and binds and stops a loopback server - the runtime-floor guard machinery in `runtime-floor.ts` beside
this file, and the test doubles that stand in for the library's own dependency-inversion boundaries.

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
| <a id="level"></a> `level` | `"debug"` \| `"error"` \| `"warn"` \| `"info"` | The severity the log method was called at. |
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

### errnoError()

```ts
function errnoError<T>(
   message, 
   code, 
   cause?
): Error & {
  code: T;
};
```

Build the errno-shaped error the platform and undici raise when a connection fails: an `Error` carrying a `code` beside its message, optionally over a cause.

Every suite driving a transport or filesystem failure needs one of these, and hand-building it is an `Object.assign` and a conditional that say nothing about the
failure being modelled...through this factory a site says only which failure it means. The `code` is loosely typed on purpose: the platform's own `DOMException`
carries a numeric one, and a classifier with a branch that steps over a non-string code needs a fixture able to carry it. A cause is attached through `Error`'s
own options bag, so the whole chain stays walkable by the library's own cause descent - and when no cause is given none is installed at all, because an own
`cause` property valued `undefined` would send that descent one link further than the error actually goes.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` *extends* `string` \| `number` | The code's own type, carried through to the result so a caller reads back exactly what it named rather than a widened union. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `message` | `string` | The message the error carries. |
| `code` | `T` | The code to carry, either an errno string or the platform's legacy numeric form. |
| `cause?` | `unknown` | An optional cause, attached through `Error`'s options bag. Omitting it leaves the result with no `cause` property at all. |

#### Returns

`Error` & \{
  `code`: `T`;
\}

An `Error` carrying `code` as a `readonly` property typed `T`.

#### Example

```ts
proc.stdin.emit("error", errnoError("write EPIPE", "EPIPE"));
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

### freePort()

```ts
function freePort(): Promise<number>;
```

Answer a TCP port nothing on this machine is holding, asked of the kernel the way an ephemeral bind asks for one and released again before the caller sees it.

An arm needs this when its subject takes a port as configuration rather than choosing one: the port has to be named in a setting before the listener exists, and a
hard-coded number collides the moment two files run at once. The kernel's own choice is the answer that cannot, so a throwaway server binds at port 0, the helper
reads back what it was given, and the server closes. The close is awaited rather than fired and forgotten, which is what shuts the release-versus-rebind window a
naive implementation carries...by the time the number comes back, the handle behind it is already gone.

The bind takes the wildcard address rather than the loopback one, because the wildcard is what the caller's own listener will bind - `HttpListener` names no host
either - and a loopback-only reservation would answer a port that is free on one interface and held on the one the caller is about to take.

The port is free when it is answered rather than reserved for the caller: another process can take it in the gap before the caller's own bind. That is the price of
naming a port before binding it, and it is why a consuming arm keeps its own release in `t.after` rather than leaning on this helper for a lifetime. An arm that
needs a port HELD rather than named wants an occupy-and-hold helper instead, which is a different shape: that one keeps its socket.

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`number`\>

A port the kernel chose and has released.

#### Example

```ts
const port = await freePort();
const listener = new HttpListener({ label: "test listener", log, port });

t.after(async () => await listener[Symbol.asyncDispose]());

// Binding begins at construction, and `ready` resolves once the listener holds the port.
await listener.ready;

assert.equal(listener.boundPort, port, "the listener must take exactly the port the setting named");
```

***

### listenOnLoopback()

```ts
function listenOnLoopback(server, port?): Promise<number>;
```

Bind `server` to the loopback interface at `port` and answer the port the kernel assigned, resolving once the socket is listening.

This is the acquisition half of the loopback pair, and it is bind-only: it drains nothing and closes nothing, so the caller keeps the server's lifetime and hands
it to [stopListening](#stoplistening) when the arm is done. A bind that fails reaches the caller as this promise's rejection carrying the kernel's own error, because the
waiter settles on the emitter's `"error"` event as readily as on `"listening"` - which is what a hand-rolled bind with no error listener loses, since an
unhandled `"error"` on a server is thrown as an uncaught exception that ends the whole file rather than the one arm.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `server` | `Server` | `undefined` | The server to bind. Both a `node:http` server and a plain `net.Server` satisfy the type structurally. |
| `port` | `number` | `0` | The port to bind. Defaults to `0`, which asks the kernel for a free one - what an arm wants when it needs some port and no collision with a file running beside it. A caller names a port instead when the fixture has to come back on the address a client is already reconnecting to. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`number`\>

The port the kernel assigned, which is `port` itself whenever the caller named one.

#### Throws

The kernel's own error when the bind fails, `EADDRINUSE` above all.

#### Example

```ts
const server = createServer(handler);
const port = await listenOnLoopback(server);

t.after(async () => await stopListening(server));

const response = await request("http://127.0.0.1:" + port.toString());
```

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

Distinct from [loggedAt](#loggedat) because "emitted exactly once" is a stronger claim than "emitted at all", and it is the one worth asserting around retry loops and
reconnect handlers: a path that logs its warning on every attempt satisfies a presence check and fails a count of one.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `entries` | readonly [`TestLogEntry`](#testlogentry)[] | The captured entries to search. |
| `level` | `"debug"` \| `"error"` \| `"warn"` \| `"info"` | The severity to restrict the count to. |
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
| `level` | `"debug"` \| `"error"` \| `"warn"` \| `"info"` | The severity to restrict the search to. |
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

### present()

```ts
function present<T>(value, description): NonNullable<T>;
```

Return `value`, asserting it is neither `undefined` nor `null`. Narrows the result to `NonNullable<T>` so a test body uses the value without a cast and without a
non-null assertion.

The failure message is as much the point as the narrowing is. A lookup that found nothing otherwise surfaces as a bare `TypeError` on the next property read, or
as a `deepEqual` against `undefined` that names neither what was being looked for nor where...this names the lookup and renders what arrived instead. The
narrowing falls out of `assert.ok`'s `asserts` typing applied to the compound condition, the same mechanism [expectAt](#expectat) relies on, so the body needs no cast.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The value's type. Assumes a `T` that is meaningfully nullable; a `T` that already excludes `undefined` and `null` leaves the assertion unreachable and the call redundant. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `T` | The value to assert on. |
| `description` | `string` | What the caller was looking for, in the grammar of "expected _____". Required rather than defaulted, because a failing index has positional context a default descriptor can lean on and a bare nullable has none, so a default would produce a sentence that names nothing. |

#### Returns

`NonNullable`\<`T`\>

`value`, narrowed to `NonNullable<T>`.

#### Throws

`AssertionError` when `value` is `undefined` or `null`.

#### Example

```ts
const entry = present(log.entries.find((candidate) => candidate.level === "warn"), "a warning about the stale segment");

assert.match(entry.message, /segment/);
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

### settleUntil()

```ts
function settleUntil(predicate, options): Promise<void>;
```

Resolve as soon as `predicate()` reads `true`, yielding one macrotask turn between attempts, and throw when the turn budget is spent with the predicate still
false.

This sits between the two helpers it is built from. [waitUntil](#waituntil) budgets real time and sleeps between attempts, which is what a state the kernel settles asks
for - a datagram delivered, a connection established. [settle](#settle) crosses a fixed number of turns whether or not anything changed. This one budgets macrotask
TURNS and yields between attempts, for a state the process settles on its own queue: a handshake whose steps each schedule the next, a cascade whose depth the
caller would otherwise have to write down and keep right. The budget is a ceiling that fails loudly naming the state that never arrived rather than a measurement
of how long anything takes...stated in turns it costs nothing on a fast run, and it still ends a run that would otherwise spin.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `predicate` | () => `boolean` | The condition to read. Called before the first yield, so a state that already holds costs no turn at all. |
| `options` | \{ `description`: `string`; `turns?`: `number`; \} | Wait options. |
| `options.description` | `string` | What the wait is for, in the grammar of "waiting for _____". It is the whole of the failure message, so name the state rather than the assertion. |
| `options.turns?` | `number` | The most macrotask turns to cross. Defaults to 100. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

#### Throws

`Error` when the budget is spent with the predicate still false.

#### Example

```ts
await settleUntil(() => broker.sessions.length === 2, { description: "both clients to finish their CONNACK handshakes" });
```

***

### silentLog()

```ts
function silentLog(): HomebridgePluginLogging;
```

Return a no-op [HomebridgePluginLogging](util.md#homebridgepluginlogging) implementation. Every method is present and well-typed, but discards its input - the tests that consume this fixture
treat logging as implementation detail and assert against behavior rather than captured log output.

Derives from the production `noOpLog` SSOT in `util.ts` via spread, so the no-op method set has exactly one definition library-wide rather than re-declaring the
interface shape and per-method void-return annotations here. The spread yields a fresh object per call - the identity contract this helper's tests assert - while every
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

### stopListening()

```ts
function stopListening(server): Promise<void>;
```

Close `server` and resolve once its handle is released.

The release waits on every in-flight connection ending, so an arm still holding live sockets destroys them itself before calling this...otherwise the wait lasts
as long as the slowest peer. A server that is already closed, or that never listened at all, RESOLVES rather than failing: that is the postcondition this helper
exists to reach, reported back. It is what lets an arm release a server by hand mid-body and still let its `await using` scope dispose it, where the scope's
second call finds nothing left to do. Every other close failure REJECTS carrying the kernel's own error, so a dispose still reports a real one.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `server` | `Server` | The server to close. Both a `node:http` server and a plain `net.Server` satisfy the type structurally. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

#### Throws

The kernel's own error for any close failure other than a server that was not running.

#### Example

```ts
const server = createServer(handler);

await listenOnLoopback(server);
await stopListening(server);
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

### Assert

Re-exports [Assert](testing/type-assertions.md#assert)

***

### assertRuntimeFloorCompat

Re-exports [assertRuntimeFloorCompat](testing/runtime-floor.md#assertruntimefloorcompat)

***

### composeSunsetCleanup

Re-exports [composeSunsetCleanup](testing/runtime-floor.md#composesunsetcleanup)

***

### Equal

Re-exports [Equal](testing/type-assertions.md#equal)

***

### Extends

Re-exports [Extends](testing/type-assertions.md#extends)

***

### HDLR\_TYPE\_VIDE

Re-exports [HDLR_TYPE_VIDE](ffmpeg/fmp4-builders.md#hdlr_type_vide)

***

### makeAaaaRecord

Re-exports [makeAaaaRecord](mdns/message-builders.md#makeaaaarecord)

***

### makeARecord

Re-exports [makeARecord](mdns/message-builders.md#makearecord)

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

### makeOtherRecord

Re-exports [makeOtherRecord](mdns/message-builders.md#makeotherrecord)

***

### makePtrRecord

Re-exports [makePtrRecord](mdns/message-builders.md#makeptrrecord)

***

### makeResponse

Re-exports [makeResponse](mdns/message-builders.md#makeresponse)

***

### makeService

Re-exports [makeService](mdns/browser-double.md#makeservice)

***

### makeServiceRecords

Re-exports [makeServiceRecords](mdns/message-builders.md#makeservicerecords)

***

### makeSrvRecord

Re-exports [makeSrvRecord](mdns/message-builders.md#makesrvrecord)

***

### makeTrunBox

Re-exports [makeTrunBox](ffmpeg/fmp4-builders.md#maketrunbox)

***

### makeTxtRecord

Re-exports [makeTxtRecord](mdns/message-builders.md#maketxtrecord)

***

### makeTxtStrings

Re-exports [makeTxtStrings](mdns/message-builders.md#maketxtstrings)

***

### MdnsServiceFixture

Re-exports [MdnsServiceFixture](mdns/message-builders.md#mdnsservicefixture)

***

### MutuallyAssignable

Re-exports [MutuallyAssignable](testing/type-assertions.md#mutuallyassignable)

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

### TestHttpListener

Re-exports [TestHttpListener](http-listener-double.md#testhttplistener)

***

### TestHttpListenerRoute

Re-exports [TestHttpListenerRoute](http-listener-double.md#testhttplistenerroute-1)

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

### TestMdnsBrowser

Re-exports [TestMdnsBrowser](mdns/browser-double.md#testmdnsbrowser)

***

### TestMdnsBrowserFactory

Re-exports [TestMdnsBrowserFactory](mdns/browser-double.md#testmdnsbrowserfactory)

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
